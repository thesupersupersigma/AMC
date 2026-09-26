/* The turntable's ONLY way to touch playback. It wraps the `media` facade
   (src/audio/media.ts), so the deck works the same whether a track plays
   on the <audio> element or in the software decode engine (ALAC, E-AC-3,
   Atmos) — see docs/turntable/MERGE-NOTES.md.

   Time is SOURCE-FILE time: a cue-carved track plays a window of its
   source file, and getTime()/getDuration() report the whole file, which
   is exactly what the tonearm walks across on a vinyl side. At a rate
   other than 1 the facade's clock still runs in source time on both
   paths, so the platter angle stays currentTime × 200°/s. */

import type { AnyTrack } from '../../types';
import { S, refOf } from '../../state';
import { media } from '../../audio/media';
import { playAt, playList, togglePlay } from '../player';

/* ---------- time ---------- */

export function getTime(): number {
  return media.currentTime || 0;
}

/** Duration of the loaded source file; falls back to track data while the
    element has not reported one yet. */
export function getDuration(): number {
  const d = media.duration;
  if (isFinite(d) && d > 0) return d;
  const t = S.current;
  if (!t) return 0;
  if (t.kind === 'virtual') {
    const src = sourceTrackOf(t);
    if (src && src.duration) return src.duration;
    return t.endSec || t.startSec + (t.duration || 0);
  }
  return t.duration || 0;
}

export function isPaused(): boolean {
  return media.paused;
}

export function currentTrack(): AnyTrack | null {
  return S.current;
}

function sourceTrackOf(t: AnyTrack): AnyTrack | null {
  if (t.kind !== 'virtual') return t;
  return S.byRef[refOf(t.folderId, t.sourcePath)] || null;
}

/** The span of the source file the current track occupies (a whole file
    for a normal track). */
export function trackWindow(t: AnyTrack | null = S.current): { start: number; end: number } {
  if (!t) return { start: 0, end: 0 };
  if (t.kind === 'virtual') return { start: t.startSec, end: t.endSec > 0 ? t.endSec : getDuration() };
  return { start: 0, end: getDuration() };
}

/** The cue tracks carved from the same source file, in order — the bands
    of one vinyl side. Empty for a normal track. */
export function sideTracks(t: AnyTrack | null = S.current): AnyTrack[] {
  if (!t || t.kind !== 'virtual') return [];
  return S.tracks
    .filter((x) => x.kind === 'virtual' && x.folderId === t.folderId && x.sourcePath === t.sourcePath && !x.shadowed)
    .sort((a, b) => (a as typeof t).startSec - (b as typeof t).startSec);
}

/* ---------- seeking ---------- */

/** Moves playback to another song of the current album (or cue side),
    keeping playing / paused as it was: from the queue when it is queued,
    else the album is queued from that song. */
export function playTrack(t: AnyTrack): void {
  const wasPaused = media.paused;
  const qi = S.queue.indexOf(t);
  if (qi >= 0) {
    playAt(qi, !wasPaused);
    return;
  }
  const al = S.albumMap[t.coverKey];
  const list = al ? al.tracks : sideTracks(t).length ? sideTracks(t) : [t];
  playList(list, Math.max(0, list.indexOf(t)));
  /* stay paused — without a brake: nothing was playing */
  if (wasPaused) realPause();
}

/** Seeks to `sec` of the SOURCE file. On a cue side a target outside the
    current track moves playback to the track that holds it (queue first,
    else its album), so the tonearm can be dropped anywhere on the side. */
export function seek(sec: number): void {
  const t = S.current;
  const dur = getDuration();
  const target = Math.max(0, dur > 0 ? Math.min(sec, dur - 0.05) : sec);
  if (t && t.kind === 'virtual') {
    const w = trackWindow(t);
    if (target < w.start - 0.01 || target >= w.end - 0.01) {
      const holder = sideTracks(t).find((x) => x.kind === 'virtual' && target >= x.startSec - 0.01 && (x.endSec <= 0 || target < x.endSec - 0.01));
      if (holder && holder !== t) playTrack(holder);
    }
  }
  try {
    media.currentTime = target;
  } catch {
    /* not seekable yet — the next seek will land */
  }
}

/** Start / stop, exactly as the transport button does it (so the
    stop/start effect applies). */
export function togglePlayback(): void {
  togglePlay();
}

/* ---------- rate (pitch follows speed, like a real record) ----------
   The element gets preservesPitch = false for any rate but 1; the engine
   resamples, so there the pitch always follows (the Worklet interpolates
   the rate across each render quantum, so the brake ramp never clicks). */

/** Sets the playback rate. Anything but 1 plays like vinyl: the pitch
    moves with the speed. The default rate is set too — a load() on either
    path resets playbackRate to defaultPlaybackRate, and a track change
    must not snap a 45 RPM record back to 33⅓. */
export function setRate(ratio: number): void {
  const r = Math.max(0.0625, Math.min(4, ratio || 1));
  media.preservesPitch = Math.abs(r - 1) < 1e-6;
  media.defaultPlaybackRate = r;
  media.playbackRate = r;
  syncPositionState();
}

/** A momentary rate for the brake / spin-up ramps: playbackRate only, so a
    track change mid-ramp lands on the real default rate. */
export function setInstantRate(ratio: number): void {
  const r = Math.max(0.0625, Math.min(4, ratio || 1));
  media.preservesPitch = false;
  media.playbackRate = r;
}

export function getRate(): number {
  return media.playbackRate || 1;
}

export function getDefaultRate(): number {
  return media.defaultPlaybackRate || 1;
}

export function pitchPreserved(): boolean {
  return media.preservesPitch;
}

/* ---------- Media Session position state, with the REAL rate ---------- */

export function syncPositionState(): void {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  const d = media.duration;
  if (!(isFinite(d) && d > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: media.playbackRate > 0 ? media.playbackRate : 1,
      position: Math.max(0, Math.min(d, media.currentTime || 0)),
    });
  } catch {
    /* an out-of-range moment during a load — the next event corrects it */
  }
}

let positionWired = false;
function wirePositionState(): void {
  if (positionWired) return;
  positionWired = true;
  for (const ev of ['ratechange', 'seeked', 'play', 'pause', 'loadedmetadata', 'durationchange']) {
    media.addEventListener(ev, syncPositionState);
  }
}

/* ---------- transport interception (the stop/start effect) ----------
   While turntable mode is open, EVERY pause and play — the view's button,
   the player bar, Space, PiP, Media Session / media keys — reaches
   playback through the facade's pause() / play(), so the brake and the
   spin-up wrap them in one place: own properties on the facade instance
   shadow its prototype methods. Removed the moment the mode closes. */

export interface TransportHooks {
  pause: (realPause: () => void) => void;
  play: (realPlay: () => Promise<void>) => Promise<void>;
}

const Facade = Object.getPrototypeOf(media) as { pause: () => void; play: () => Promise<void> };
const protoPause = Facade.pause;
const protoPlay = Facade.play;

export function realPause(): void {
  protoPause.call(media);
}
export function realPlay(): Promise<void> {
  return protoPlay.call(media);
}

export function interceptTransport(h: TransportHooks | null): void {
  const m = media as unknown as Record<string, unknown>;
  if (!h) {
    delete m.pause;
    delete m.play;
    return;
  }
  m.pause = () => h.pause(realPause);
  m.play = () => h.play(realPlay);
}

/* ---------- media events the deck follows ---------- */

/** Playback jumped (a seek landed). */
export function onSeeked(cb: () => void): void {
  media.addEventListener('seeked', cb);
}

/** The file played to its end. */
export function onEnded(cb: () => void): void {
  media.addEventListener('ended', cb);
}

export function isEnded(): boolean {
  return media.ended;
}

/** The loaded file's duration became known or changed. */
export function onDurationKnown(cb: () => void): void {
  media.addEventListener('durationchange', cb);
  media.addEventListener('loadedmetadata', cb);
}

/* ---------- track changes ---------- */

type TrackCb = (t: AnyTrack | null, prev: AnyTrack | null) => void;
const trackCbs: TrackCb[] = [];
let lastTrack: AnyTrack | null = null;

export function onTrackChange(cb: TrackCb): () => void {
  trackCbs.push(cb);
  return () => {
    const i = trackCbs.indexOf(cb);
    if (i >= 0) trackCbs.splice(i, 1);
  };
}

/** Called from the player's track-change hook (nowplaying.ts). Repeats for
    the same track are ignored. */
export function notifyTrackChange(): void {
  const t = S.current;
  if (t === lastTrack) return;
  const prev = lastTrack;
  lastTrack = t;
  for (const cb of trackCbs.slice()) {
    try {
      cb(t, prev);
    } catch {
      /* one listener must not break the others */
    }
  }
}

/** Starts tracking from the current state without firing a change. */
export function primeTrack(): void {
  lastTrack = S.current;
}

export function wirePlayback(): void {
  wirePositionState();
  lastTrack = S.current;
}
