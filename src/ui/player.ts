/* Playback: the queue, transport, Media Session, player bar UI, and
   restore-last-track. */

import type { AnyTrack, RowTrack, TrackRec, VirtualTrack } from '../types';
import { S, PREFS, canSoftDecode, codecLabel, engineCodecLabel, coverURL, isCodecFailed, isPlayableTrack, libraryTracks, markCodecFailed, markCodecWorking, refOf, savePrefs } from '../state'; // hires-art hook: FULL / releaseFullArt folded into art/hero
import { cancelMainRamp, createTrackURL, getLoadedSrcKey, rampMainVolume, revokeCurrentURL, setLoadedSrcKey, startCrossfadeTail } from '../audio/engine';
import { media } from '../audio/media';
import type { EngineSource } from '../audio/soft/protocol';
import type { SpatialOutputMode } from '../audio/spatial/contract';
import { atmosActivityLine, atmosCodecLabel } from '../audio/atmos/labels';
import { ST_META, ST_TRACKS, idbDel, idbGet, idbPut } from '../db/idb';
import { drawWaveformProgress, waveformTrackChanged } from './waveform';
import { lyricsTrackChanged } from './lyrics';
import { nowPlayingTrackChanged } from './nowplaying';
import { logErr } from './log';
import { icon, solid, artHTML } from './icons';
import { clamp, fmtTime, plural, toast, $ } from '../util';
import { scheduleRender, render } from './render';
import { renderQueuePanel, queuePanelOpen, toggleQueuePanel } from './queue';
import { updatePlayingRows } from './songs';
import { heroArt, heroCoverURL, trimHeroes } from '../art/hero'; // hires-art hook

let seeking = false;
let failStreak = 0;
let trackLoadedAt = 0;
let playbackArmed = false; /* true only once playback was actually requested */
let pendingSeek = 0;

function fisherYates<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function buildOrder(startIndex: number): void {
  if (!S.shuffle) {
    S.queue = S.baseQueue.slice();
    S.qi = clamp(startIndex, 0, Math.max(0, S.queue.length - 1));
    return;
  }
  const first = S.baseQueue[startIndex];
  const rest = S.baseQueue.filter((t) => t !== first);
  fisherYates(rest);
  S.queue = first ? [first].concat(rest) : rest;
  S.qi = 0;
}

export function playList(tracks: RowTrack[], index: number, opts?: { attemptTarget?: boolean }): void {
  const target = tracks[index];
  /* Tracks whose codec already failed to decode this session stay out of
     the queue so playback never stalls on them — unless the software
     engine decodes that codec, in which case they play there. A track the
     user activated directly (double-click, Enter, "Play from…") is still
     attempted — the result is logged, and success withdraws the codec
     verdict. Play and Shuffle buttons pass no flag: their target is just
     "start here". */
  const attempt = !!(opts && opts.attemptTarget);
  const playable = (tracks || []).filter(isPlayableTrack).filter((t) => (attempt && t === target) || !isCodecFailed(t.codec) || canSoftDecode(t.codec));
  if (!playable.length) {
    toast('Nothing here can be played from this folder');
    return;
  }
  let start = playable.indexOf(target as AnyTrack & { file: File });
  if (start < 0) start = 0;
  S.baseQueue = playable;
  buildOrder(start);
  failStreak = 0;
  playAt(S.qi, true);
}

export function queueAppend(tracks: RowTrack[]): void {
  const add = tracks.filter(isPlayableTrack);
  if (!add.length) return;
  add.forEach((t) => {
    if (S.baseQueue.indexOf(t) < 0) S.baseQueue.push(t);
    S.queue.push(t);
  });
  toast('Added ' + plural(add.length, 'song', 'songs') + ' to the queue');
  renderQueuePanel();
}

export function queueNext(tracks: RowTrack[]): void {
  const add = tracks.filter(isPlayableTrack);
  if (!add.length) return;
  const at = S.qi + 1;
  add.forEach((t, i) => {
    if (S.baseQueue.indexOf(t) < 0) S.baseQueue.push(t);
    S.queue.splice(at + i, 0, t);
  });
  toast(plural(add.length, 'song', 'songs') + ' will play next');
  renderQueuePanel();
}

export function playAt(index: number, autoplay?: boolean): void {
  if (!S.queue.length) return;
  S.qi = clamp(index, 0, S.queue.length - 1);
  loadTrack(S.queue[S.qi], autoplay !== false);
}

/** The file behind a track: a virtual track plays a window of its source. */
export function sourcePathOf(t: AnyTrack): string {
  return t.kind === 'virtual' ? t.sourcePath : t.path;
}

/* ---------- path selection ----------------------------------------------
   Native first: everything Chrome plays stays on the <audio> element. A
   fourcc that genuinely failed to decode this session — and that the
   software engine handles (alac, ec-3, ac-3) — starts directly in the
   engine; the first failure hands off mid-attempt (see the error
   listener). Genuinely unsupported codecs keep today's skip behaviour. */

function useEngineFor(t: AnyTrack): boolean {
  return isCodecFailed(t.codec) && canSoftDecode(t.codec);
}

function engineSourceOf(t: AnyTrack): EngineSource {
  return { file: t.file as File, codec: t.codec as string, name: t.title || t.path };
}

/** The track handed from a failing native attempt to the engine — its
    rejected play() promise is expected, not an error. */
let handedOff: AnyTrack | null = null;
const engineAnnounced = new Set<string>();

function announceEngine(codec: string): void {
  if (engineAnnounced.has(codec)) return;
  engineAnnounced.add(codec);
  logErr('playback', codec + " isn't supported natively here — using software decoding", engineCodecLabel(codec));
}

/* Dolby Atmos: the engine's spatial processor decodes the objects. Once per
   session when objects first play, and again whenever the output mode they
   are rendered for changes (Settings → Spatial audio output). */
let atmosAnnounced: SpatialOutputMode | '' = '';

function announceAtmos(): void {
  const n = media.spatialObjects();
  const mode = media.spatialOutputMode();
  if (!(n > 0) || !mode || mode === atmosAnnounced) return;
  atmosAnnounced = mode;
  const t = S.current;
  logErr('playback', atmosActivityLine(mode), atmosCodecLabel(n) + (t ? ' — ' + t.title : ''));
}

function onSpatialChange(): void {
  syncFormatChip();
  announceAtmos();
}

function loadTrack(t: AnyTrack, autoplay: boolean): void {
  if (!t) return;
  xfFiredFor = '';
  gaplessArmed = '';
  handedOff = null;
  if (!t.file) {
    logErr('playback', 'No file behind ' + t.title, t.path);
    return skipAfterFailure();
  }
  const srcKey = refOf(t.folderId, sourcePathOf(t));
  /* Another window of the file already loaded (a cue track of the same
     rip): keep the decoded stream, just move the playhead. */
  const reuse = srcKey === getLoadedSrcKey() && media.hasSource();
  const startAt = t.kind === 'virtual' ? t.startSec : 0;
  if (!reuse) {
    /* Crossfade: hand the outgoing tail to a side element (or the detached
       engine stream) before this one switches files, then ramp the
       incoming track up under it. Same-file cue advances never reach here
       — that path stays gapless. */
    const prev = S.current;
    const xf = S.crossfadeSec;
    if (xf > 0 && autoplay && prev && prev.file && !media.paused && media.currentTime > 0) {
      startCrossfadeTail(prev.file, media.currentTime, media.muted ? 0 : media.volume, xf);
      rampMainVolume(S.muted ? 0 : S.volume, xf);
    }
    revokeCurrentURL();
    if (useEngineFor(t)) {
      announceEngine(t.codec as string);
      media.loadEngine(engineSourceOf(t), startAt);
    } else {
      let url: string;
      try {
        url = createTrackURL(t.file);
      } catch (e) {
        logErr('playback', 'Could not open ' + t.title, (e as Error) && (e as Error).message);
        return skipAfterFailure();
      }
      media.loadNative(url);
      if (startAt > 0) pendingSeek = startAt; /* applied on loadedmetadata */
    }
    setLoadedSrcKey(srcKey);
  }
  S.current = t;
  S.lastPos = 0;
  trackLoadedAt = performance.now();
  if (autoplay) playbackArmed = true;
  if (reuse) {
    try {
      media.currentTime = startAt;
    } catch {
      pendingSeek = startAt;
    }
  }
  if (autoplay) {
    const p = media.play();
    if (p && p.catch)
      p.catch((err: Error & { name?: string }) => {
        /* An autoplay rejection is not a decode failure — leave it paused. */
        if (err && err.name === 'NotAllowedError') {
          S.playing = false;
          syncPlayerUI();
        } else if (handedOff === t || (media.path === 'engine' && S.current === t && !media.error)) {
          /* the native attempt failed and the engine took over */
        } else {
          logErr('playback', 'Could not start ' + t.title, err && err.message);
        }
      });
  }
  updateMediaSession(t);
  void ensureFullArt(t).then(() => {
    updateMediaSession(t);
  });
  savePrefs();
  render();
  void waveformTrackChanged();
  lyricsTrackChanged();
  nowPlayingTrackChanged();
  offerResume(t);
  startBoundaryLoop();
}

/* ---------- cue boundaries ------------------------------------------------
   Driven from requestAnimationFrame — timeupdate fires ~4×/sec, far too
   coarse for a clean edge. timeupdate still runs the same check as a net
   for hidden tabs, where rAF is suspended. */

let boundaryRaf = 0;

function startBoundaryLoop(): void {
  if (boundaryRaf) return;
  boundaryRaf = requestAnimationFrame(boundaryTick);
}

function boundaryTick(): void {
  boundaryRaf = 0;
  drawWaveformProgress();
  const c = S.current;
  if (!c || media.paused) return; /* the 'play' listener restarts the loop */
  checkCrossfadeAdvance(c);
  maybeArmGapless(c);
  if (c.kind === 'virtual') checkCueBoundary(c);
  boundaryRaf = requestAnimationFrame(boundaryTick);
}

/* ---------- per-track resume (Phase 6) --------------------------------
   Long files — unsplit vinyl sides above ~10 minutes — remember where they
   stopped. The position rides in small IDB meta rows keyed by track ref;
   reopening such a track offers "Resume from 31:08" on a transient chip,
   never a blocking dialog. Finishing a track clears its row. ---------- */

const RESUME_MIN_DURATION = 600;
const RESUME_MIN_SEC = 30;

interface ResumeRec {
  key: string;
  sec: number;
  at: number;
}

function resumeKeyOf(t: AnyTrack): string {
  return 'resume:' + refOf(t.folderId, t.path);
}

let lastResumeSave = 0;
function maybeSaveResume(): void {
  const c = S.current;
  if (!c || c.kind !== 'file' || media.paused) return;
  if (!((c.duration || 0) > RESUME_MIN_DURATION)) return;
  const now = performance.now();
  if (now - lastResumeSave < 5000) return;
  lastResumeSave = now;
  const sec = Math.floor(media.currentTime || 0);
  if (sec > (c.duration || 0) - 20) {
    c.resumeSec = 0;
    void idbDel(ST_META, resumeKeyOf(c));
    return;
  }
  if (sec < RESUME_MIN_SEC) return;
  c.resumeSec = sec;
  void idbPut(ST_META, { key: resumeKeyOf(c), sec: sec, at: Date.now() } as ResumeRec);
}

let resumeChipTimer: ReturnType<typeof setTimeout> | null = null;
function hideResumeChip(): void {
  const chip = $('#resumechip');
  if (chip) chip.hidden = true;
  if (resumeChipTimer) clearTimeout(resumeChipTimer);
  resumeChipTimer = null;
}

function offerResume(t: AnyTrack): void {
  hideResumeChip();
  if (t.kind !== 'file' || !((t.duration || 0) > RESUME_MIN_DURATION)) return;
  void idbGet<ResumeRec>(ST_META, resumeKeyOf(t)).then((row) => {
    if (!row || !(row.sec >= RESUME_MIN_SEC)) return;
    if (S.current !== t) return; /* moved on while reading */
    if (row.sec > (t.duration || 0) - 30) return;
    const chip = $('#resumechip');
    if (!chip) return;
    chip.textContent = 'Resume from ' + fmtTime(row.sec);
    chip.hidden = false;
    chip.onclick = (): void => {
      try {
        media.currentTime = row.sec;
      } catch {
        pendingSeek = row.sec;
      }
      hideResumeChip();
    };
    resumeChipTimer = setTimeout(hideResumeChip, 12000);
  });
}

/* A crossfade must START before the track ends — once 'ended' fires there
   is no tail left to overlap. Inside the closing window the queue advances
   through the SAME next() path a manual skip uses, so loadTrack runs the
   same fade. Never for the repeat-one loop, never for a contiguous cue
   neighbour (that stays gapless), and never within one source file — a
   single element cannot overlap itself. */
let xfFiredFor = '';
function checkCrossfadeAdvance(c: AnyTrack): void {
  if (!(S.crossfadeSec > 0) || media.paused || S.repeat === 'one') return;
  if (xfFiredFor === c.uid) return;
  const end = c.kind === 'virtual' ? c.endSec : c.duration || media.duration || 0;
  if (!(end > 0)) return;
  /* In source seconds: at a playback rate r the fade's wall-clock seconds
     cover r times as much of the track. */
  const rate = media.playbackRate || 1;
  const remain = end - media.currentTime;
  if (remain > S.crossfadeSec * rate || remain <= 0.08 * rate) return;
  const ni = S.qi + 1;
  const nxt = ni < S.queue.length ? S.queue[ni] : null;
  if (!nxt) return; /* end of queue: the normal ended/repeat path decides */
  if (
    S.gapless &&
    c.kind === 'virtual' &&
    nxt.kind === 'virtual' &&
    nxt.folderId === c.folderId &&
    nxt.sourcePath === c.sourcePath &&
    Math.abs(nxt.startSec - c.endSec) < 0.1
  )
    return;
  if (refOf(nxt.folderId, sourcePathOf(nxt)) === refOf(c.folderId, sourcePathOf(c))) return;
  xfFiredFor = c.uid;
  next(false);
}

function checkCueBoundary(c: VirtualTrack): void {
  if (!(c.endSec > 0)) return; /* open-ended: the file's own 'ended' rules */
  if (media.currentTime < c.endSec - 0.02) return;
  if (S.repeat === 'one') {
    try {
      media.currentTime = c.startSec;
    } catch {
      /* not seekable right now; the next tick retries */
    }
    return;
  }
  const ni = S.qi + 1;
  const nxt = ni < S.queue.length ? S.queue[ni] : null;
  if (
    S.gapless &&
    nxt &&
    nxt.kind === 'virtual' &&
    nxt.folderId === c.folderId &&
    nxt.sourcePath === c.sourcePath &&
    Math.abs(nxt.startSec - c.endSec) < 0.1
  ) {
    /* Contiguous within one already-decoded stream: no seek, no reload —
       just update current-track state. True gapless playback. */
    S.qi = ni;
    S.current = nxt;
    S.lastPos = media.currentTime;
    syncPlayerUI();
    updatePlayingRows();
    updateMediaSession(nxt);
    void ensureFullArt(nxt).then(() => {
      updateMediaSession(nxt);
    });
    savePrefs();
    void waveformTrackChanged();
    lyricsTrackChanged();
    nowPlayingTrackChanged();
    return;
  }
  media.pause();
  next(false);
}

/** A genuine decode failure for this track's fourcc: mark the codec for the
    session (unless a sibling with the same fourcc already played — then it
    is one broken file, not a missing decoder) and badge every track sharing
    it. MEDIA_ERR_SRC_NOT_SUPPORTED forces the mark: it is a codec-level
    verdict that outranks a "working" mark a silent broken stream may have
    earned. Never pre-emptive — only an actual attempt lands here. */
function noteCodecFailure(t: AnyTrack, force?: boolean): void {
  if (!markCodecFailed(t.codec, force)) return;
  logErr(
    'playback',
    'This browser could not decode ' + codecLabel(t.codec as string) + ' (' + t.codec + ')',
    'tracks with this codec are left out of Play and Shuffle queues — click one to try it anyway; the same file may play in another browser'
  );
  scheduleRender();
}

function skipAfterFailure(): void {
  /* If playback was never asked for — a track restored from the last session
     sits loaded but paused — a load failure must not start the next track. */
  if (!playbackArmed) {
    S.playing = false;
    syncPlayerUI();
    return;
  }
  failStreak++;
  if (failStreak > Math.max(3, S.queue.length)) {
    S.playing = false;
    toast('Nothing in the queue could be played');
    syncPlayerUI();
    return;
  }
  next(false, true);
}

export function next(manual: boolean, afterFailure?: boolean): void {
  if (!S.queue.length) return;
  if (!manual && !afterFailure && S.repeat === 'one') {
    media.currentTime = scrubWindow().base;
    media.play().catch(() => {
      /* stay paused */
    });
    return;
  }
  let ni = S.qi + 1;
  if (ni >= S.queue.length) {
    if (S.repeat === 'all') {
      ni = 0;
    } else {
      S.playing = false;
      media.pause();
      syncPlayerUI();
      return;
    }
  }
  playAt(ni, true);
}

export function prev(): void {
  if (!S.queue.length) return;
  const base = scrubWindow().base;
  if (media.currentTime - base > 3) {
    media.currentTime = base;
    return;
  }
  if (S.qi <= 0) {
    if (S.repeat === 'all') return playAt(S.queue.length - 1, true);
    media.currentTime = base;
    return;
  }
  playAt(S.qi - 1, true);
}

export function togglePlay(): void {
  if (!S.current) {
    if (S.tracks.length) playList(libraryTracks(), 0);
    return;
  }
  if (media.paused)
    media.play().catch((e: Error) => {
      logErr('playback', 'Could not resume', e && e.message);
    });
  else media.pause();
}

export function toggleShuffle(): void {
  S.shuffle = !S.shuffle;
  const cur = S.queue[S.qi] as AnyTrack | undefined;
  if (S.baseQueue.length) {
    if (S.shuffle) {
      const rest = S.baseQueue.filter((t) => t !== cur);
      fisherYates(rest);
      S.queue = cur ? [cur].concat(rest) : rest; /* the current track is preserved */
      S.qi = 0;
    } else {
      S.queue = S.baseQueue.slice();
      S.qi = cur ? Math.max(0, S.queue.indexOf(cur)) : 0;
    }
  }
  savePrefs();
  syncPlayerUI();
  renderQueuePanel();
  toast(S.shuffle ? 'Shuffle is on' : 'Shuffle is off');
}

export function cycleRepeat(): void {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  savePrefs();
  syncPlayerUI();
  toast(S.repeat === 'off' ? 'Repeat is off' : S.repeat === 'all' ? 'Repeating the queue' : 'Repeating this song');
}

export function setVolume(v: number): void {
  S.volume = clamp(v, 0, 1);
  S.muted = S.volume === 0 ? S.muted : false;
  media.volume = S.volume;
  media.muted = S.muted;
  savePrefs();
  syncVolumeUI();
}

export function toggleMute(): void {
  S.muted = !S.muted;
  media.muted = S.muted;
  savePrefs();
  syncVolumeUI();
}

/* Hero art (art/hero.ts, at the Artwork quality level) is minted for the
   playing track's album; the previous album's hero is released on change.
   Never awaited by playback. */ // hires-art hook
function ensureFullArt(track: AnyTrack | null): Promise<string> {
  trimHeroes(); // hires-art hook
  if (!track) return Promise.resolve(''); // hires-art hook
  return heroCoverURL(track).then((url) => (S.current === track ? url : '')); // hires-art hook
}

/* ---------- Media Session: this is what drives the Chromebook media keys --- */
function updateMediaSession(t: AnyTrack | null): void {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    const art: MediaImage[] = [];
    /* hires-art hook: the hero with its REAL size; the thumb until then. */
    const hero = heroArt(t);
    const u = hero ? hero.url : coverURL(t.coverKey);
    if (hero) art.push({ src: hero.url, sizes: hero.w + 'x' + hero.h, type: hero.blob.type || 'image/jpeg' });
    else if (u) art.push({ src: u });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: art,
    });
    navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
  } catch (e) {
    logErr('media keys', 'Could not publish the track details', (e as Error) && (e as Error).message);
  }
}

export function wireMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler): void => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* this browser does not know the action */
    }
  };
  set('play', () => {
    media.play().catch(() => {
      /* stay paused */
    });
  });
  set('pause', () => {
    media.pause();
  });
  set('stop', () => {
    media.pause();
    media.currentTime = 0;
  });
  set('previoustrack', () => {
    prev();
  });
  set('nexttrack', () => {
    next(true);
  });
  set('seekto', (d) => {
    if (d && typeof d.seekTime === 'number' && isFinite(media.duration)) media.currentTime = clamp(d.seekTime, 0, media.duration);
  });
  set('seekbackward', (d) => {
    media.currentTime = Math.max(0, media.currentTime - ((d && d.seekOffset) || 10));
  });
  set('seekforward', (d) => {
    if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, media.currentTime + ((d && d.seekOffset) || 10));
  });
}

/* ---------- player bar UI ---------- */
function setRangeFill(el: HTMLElement, ratio: number): void {
  el.style.setProperty('--p', (clamp(ratio, 0, 1) * 100).toFixed(2) + '%');
}

export function syncVolumeUI(): void {
  const v = S.muted ? 0 : S.volume;
  const el = $<HTMLInputElement>('#vol');
  el.value = String(Math.round(v * 100));
  setRangeFill(el, v);
  const b = $('#btnMute');
  b.innerHTML = icon(S.muted || S.volume === 0 ? 'volmute' : 'vol');
  b.setAttribute('aria-label', S.muted ? 'Unmute the audio' : 'Mute the audio');
  b.title = S.muted ? 'Unmute the audio' : 'Mute the audio';
}

export function syncPlayerUI(): void {
  const t = S.current;
  $('#btnPlay').innerHTML = solid(S.playing ? 'pause' : 'play');
  $('#btnPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  $('#btnPlay').title = S.playing ? 'Pause' : 'Play';
  $('#btnPrev').innerHTML = solid('prev');
  $('#btnNext').innerHTML = solid('next');
  $('#btnShuffle').innerHTML = icon('shuffle');
  $('#btnShuffle').classList.toggle('on', S.shuffle);
  $('#btnShuffle').setAttribute('aria-pressed', S.shuffle ? 'true' : 'false');
  $('#btnRepeat').innerHTML = icon('repeat') + (S.repeat === 'one' ? '<b>1</b>' : '');
  $('#btnRepeat').classList.toggle('on', S.repeat !== 'off');
  $('#btnQueue').innerHTML = icon('queue');
  $('#btnQueue').classList.toggle('on', queuePanelOpen());
  ($('#btnPrev') as HTMLButtonElement).disabled = !S.queue.length;
  ($('#btnNext') as HTMLButtonElement).disabled = !S.queue.length;

  if (t) {
    $('#pbTitle').textContent = t.title;
    $('#pbArtist').textContent = t.artist + (t.album ? ' — ' + t.album : '');
    $('#pbArt').innerHTML = artHTML(t.coverKey);
  } else {
    $('#pbTitle').textContent = 'Nothing playing';
    $('#pbArtist').textContent = 'Pick a song to start';
    $('#pbArt').innerHTML = '<div class="ph">' + icon('note') + '</div>';
  }
  syncFormatChip();
  syncVolumeUI();
  syncTimeUI();
  if (queuePanelOpen()) renderQueuePanel();
}

/** "Dolby Atmos · 15 objects · Software decode", "Dolby Digital Plus
    (5.1) · Software decode", … while the engine plays the current track;
    '' on the native path. */
export function currentFormatLabel(): string {
  const t = S.current;
  if (!t || media.path !== 'engine') return '';
  return engineCodecLabel(t.codec || '', media.engineInfo(), media.spatialObjects()) + ' · Software decode';
}

/** The small "Software decode" chip after the title in the player pill. */
function syncFormatChip(): void {
  const el = $('#pbTitle');
  if (!el) return;
  let chip = el.querySelector('.soft-chip') as HTMLElement | null;
  const t = S.current;
  if (!t || media.path !== 'engine') {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'soft-chip';
    chip.textContent = 'Software decode';
    el.appendChild(chip);
  }
  chip.title = engineCodecLabel(t.codec || '', media.engineInfo(), media.spatialObjects()) + ' — decoded in software because this browser has no decoder for it';
}

/** The scrub window: a virtual track scrubs within [startSec, endSec] of
    its source file; everything else scrubs the whole file. */
function scrubWindow(): { base: number; span: number } {
  const c = S.current;
  if (c && c.kind === 'virtual') {
    const end = c.endSec > 0 ? c.endSec : isFinite(media.duration) && media.duration > 0 ? media.duration : c.startSec + (c.duration || 0);
    return { base: c.startSec, span: Math.max(0, end - c.startSec) };
  }
  return { base: 0, span: isFinite(media.duration) && media.duration > 0 ? media.duration : c ? c.duration : 0 };
}

function syncTimeUI(): void {
  const w = scrubWindow();
  const d = w.span;
  const c = clamp((media.currentTime || 0) - w.base, 0, d > 0 ? d : Infinity);
  if (!seeking) {
    const el = $<HTMLInputElement>('#scrub');
    const ratio = d > 0 ? c / d : 0;
    el.value = String(Math.round(ratio * 1000));
    setRangeFill(el, ratio);
  }
  $('#pbElapsed').textContent = fmtTime(c);
  $('#pbRemain').textContent = d > 0 ? '-' + fmtTime(Math.max(0, d - c)) : '--:--';
}

export function wirePlayerBar(): void {
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnPrev').addEventListener('click', prev);
  $('#btnNext').addEventListener('click', () => {
    next(true);
  });
  $('#btnShuffle').addEventListener('click', toggleShuffle);
  $('#btnRepeat').addEventListener('click', cycleRepeat);
  $('#btnMute').addEventListener('click', toggleMute);
  $('#btnQueue').addEventListener('click', () => {
    toggleQueuePanel();
  });
  $('#qClose').innerHTML = icon('close');

  const scrub = $<HTMLInputElement>('#scrub');
  scrub.addEventListener('pointerdown', () => {
    seeking = true;
    scrub.classList.add('dragging');
  });
  scrub.addEventListener('input', () => {
    seeking = true;
    const d = scrubWindow().span;
    const ratio = Number(scrub.value) / 1000;
    setRangeFill(scrub, ratio);
    $('#pbElapsed').textContent = fmtTime(ratio * d);
    $('#pbRemain').textContent = d > 0 ? '-' + fmtTime(Math.max(0, d - ratio * d)) : '--:--';
  });
  const commit = (): void => {
    const w = scrubWindow();
    if (w.span > 0) {
      try {
        media.currentTime = w.base + clamp((Number(scrub.value) / 1000) * w.span, 0, w.span);
      } catch {
        /* not seekable yet */
      }
    }
    seeking = false;
    scrub.classList.remove('dragging');
    syncTimeUI();
  };
  scrub.addEventListener('change', commit);
  scrub.addEventListener('pointerup', commit);
  scrub.addEventListener('pointercancel', () => {
    seeking = false;
    scrub.classList.remove('dragging');
  });

  const vol = $<HTMLInputElement>('#vol');
  vol.addEventListener('input', () => {
    S.muted = false;
    media.muted = false;
    cancelMainRamp(); /* the user's hand beats a crossfade ramp */
    setVolume(Number(vol.value) / 100);
  });
}

/* ---------- audio element events ---------- */
export function wireAudio(): void {
  /* 'play' only means the request was accepted, not that anything decoded, so
     it must NOT clear failStreak — otherwise the skip guard never trips. */
  media.addEventListener('play', () => {
    S.playing = true;
    syncPlayerUI();
    updatePlayingRows();
    startBoundaryLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  media.addEventListener('pause', () => {
    S.playing = false;
    syncPlayerUI();
    updatePlayingRows();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  media.addEventListener('ended', () => {
    /* A finished long file starts from the top next time. */
    const fin = S.current;
    if (fin && fin.kind === 'file' && (fin.duration || 0) > RESUME_MIN_DURATION) {
      fin.resumeSec = 0;
      void idbDel(ST_META, resumeKeyOf(fin));
    }
    /* A track restored from the last session is loaded but deliberately
       paused. If it is a broken file it can fire 'ended' on load, and
       advancing there would start playing something nobody asked for. */
    if (!playbackArmed) return;
    /* A corrupt file can report a full duration and still finish instantly,
       which would let repeat-all spin through a dead queue forever. Wall-clock
       time is the only signal that survives that, so judge on elapsed time. */
    const elapsed = performance.now() - trackLoadedAt;
    const claimed = (S.current && S.current.duration) || media.duration || 0;
    if (elapsed < 400 && claimed > 2) {
      const cur = S.current;
      if (cur && media.path === 'native' && canSoftDecode(cur.codec)) {
        /* "Played" instantly with nothing decoded: a missing decoder the
           element did not report as an error. The engine takes it. */
        markCodecFailed(cur.codec);
        handToEngine(cur);
        return;
      }
      if (S.current) {
        S.current.error = 'No audio in this file';
        logErr('playback', 'No audio in ' + S.current.title, S.current.path + ' — finished instantly but claims ' + Math.round(claimed) + 's');
        noteCodecFailure(S.current);
        scheduleRender();
      }
      return skipAfterFailure();
    }
    next(false);
  });
  media.addEventListener('timeupdate', () => {
    syncTimeUI();
    /* Hidden tabs suspend requestAnimationFrame; this ~4 Hz check is the
       coarse safety net that keeps cue boundaries — and the natural-end
       crossfade window — working there. */
    if (S.current && !media.paused) checkCrossfadeAdvance(S.current);
    if (S.current && !media.paused) maybeArmGapless(S.current);
    if (S.current && S.current.kind === 'virtual' && !media.paused) checkCueBoundary(S.current);
    maybeSaveResume();
    /* Only real elapsed playback clears the failure streak — and proves the
       codec, withdrawing any earlier session verdict against its fourcc.
       "Real" requires decoded bytes where the browser exposes the counter:
       a missing decoder can advance the clock over silence, and that false
       proof would veto the codec mark for the whole session. */
    if (performance.now() - trackLoadedAt > 1200) {
      failStreak = 0;
      /* Engine playback proves nothing about the browser's own decoder —
         and must not withdraw the verdict that sent the codec there. */
      const decodedBytes = media.decodedBytes();
      if (media.path === 'native' && (decodedBytes === undefined || decodedBytes > 0) && S.current && markCodecWorking(S.current.codec)) {
        logErr('playback', codecLabel(S.current.codec as string) + ' plays after all — removing the codec badge', S.current.path);
        scheduleRender();
      }
    }
    if (S.current && !seeking) {
      S.lastPos = media.currentTime;
      if (Math.floor(media.currentTime) % 5 === 0) savePrefs();
    }
  });
  media.addEventListener('durationchange', () => {
    if (S.current && isFinite(media.duration) && media.duration > 0 && !S.current.duration) {
      S.current.duration = media.duration;
      const cur = S.current;
      void idbGet<TrackRec>(ST_TRACKS, cur.cacheKey).then((rec) => {
        if (rec) {
          rec.duration = media.duration;
          void idbPut(ST_TRACKS, rec);
        }
      });
      scheduleRender();
    }
    syncTimeUI();
  });
  media.addEventListener('loadedmetadata', () => {
    syncFormatChip();
    if (pendingSeek > 0 && isFinite(media.duration)) {
      try {
        media.currentTime = clamp(pendingSeek, 0, media.duration - 0.5);
      } catch {
        /* not seekable yet */
      }
      pendingSeek = 0;
    }
    syncTimeUI();
  });
  media.addEventListener('error', () => {
    const t = S.current;
    const code = media.error ? media.error.code : 0;
    /* A genuine native decode failure on a codec the engine handles: mark
       the fourcc (as before) and hand the same track to the engine at the
       same position — no skip, no error row. */
    if (t && media.path === 'native' && (code === 3 || code === 4) && canSoftDecode(t.codec)) {
      markCodecFailed(t.codec, code === 4);
      handToEngine(t);
      return;
    }
    const why = code === 4 ? 'the browser cannot decode this format' : 'the file could not be read';
    if (t) {
      t.error = 'Could not play this file';
      logErr('playback', 'Could not play ' + t.title, t.path + ' — ' + why);
      /* MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4) are the
         genuine decode failures; network/abort errors say nothing about
         the codec. Code 4 is codec-level and forces the mark. */
      if (code === 3 || code === 4) noteCodecFailure(t, code === 4);
      scheduleRender();
    }
    skipAfterFailure();
  });
  media.addEventListener('gaplessadvance', onGaplessAdvance);
  media.addEventListener('spatialchange', onSpatialChange);
}

/* ---------- native → engine handoff ---------- */

function handToEngine(t: AnyTrack): void {
  const base = t.kind === 'virtual' ? t.startSec : 0;
  let at = pendingSeek > 0 ? pendingSeek : media.currentTime > 0 ? media.currentTime : base;
  if (!(at >= 0) || !isFinite(at)) at = base;
  pendingSeek = 0;
  handedOff = t;
  announceEngine(t.codec as string);
  scheduleRender();
  revokeCurrentURL();
  media.loadEngine(engineSourceOf(t), at);
  setLoadedSrcKey(refOf(t.folderId, sourcePathOf(t)));
  trackLoadedAt = performance.now();
  if (playbackArmed) {
    void media.play().catch((err: Error & { name?: string }) => {
      if (err && err.name === 'NotAllowedError') {
        S.playing = false;
        syncPlayerUI();
      }
      /* engine failures surface through its own 'error' event */
    });
  }
}

/* ---------- gapless between software-decoded files ------------------------
   Within the last stretch of an engine track, the next queue entry — if it
   also plays in the engine — is handed over for splicing: its first chunk
   decodes before this one ends, and the worklet plays straight through.
   Crossfade, repeat-one and the gapless setting keep precedence exactly as
   for cue tracks. Mixed native/engine neighbours take a normal change. */

const GAPLESS_ARM_SEC = 15;
let gaplessArmed = '';

function nextQueueTrack(): AnyTrack | null {
  const ni = S.qi + 1;
  if (ni < S.queue.length) return S.queue[ni];
  return S.repeat === 'all' && S.queue.length ? S.queue[0] : null;
}

function maybeArmGapless(c: AnyTrack): void {
  if (media.path !== 'engine') return;
  const nxt = nextQueueTrack();
  const want =
    S.gapless &&
    !(S.crossfadeSec > 0) &&
    S.repeat !== 'one' &&
    c.kind === 'file' &&
    !!nxt &&
    nxt.kind === 'file' &&
    !!nxt.file &&
    useEngineFor(nxt);
  const key = want && nxt ? nxt.uid : '';
  if (key === gaplessArmed) return;
  if (key) {
    const end = c.duration || media.duration || 0;
    if (!(end > 0) || end - media.currentTime > GAPLESS_ARM_SEC) return;
  }
  gaplessArmed = key;
  media.setNext(key && nxt ? engineSourceOf(nxt) : null);
}

function onGaplessAdvance(): void {
  const fin = S.current;
  const nxt = gaplessArmed ? S.queue.find((x) => x.uid === gaplessArmed) || null : null;
  gaplessArmed = '';
  if (!nxt) return;
  if (fin && fin.kind === 'file' && (fin.duration || 0) > RESUME_MIN_DURATION) {
    fin.resumeSec = 0;
    void idbDel(ST_META, resumeKeyOf(fin));
  }
  const idx = S.queue.indexOf(nxt);
  if (idx >= 0) S.qi = idx;
  S.current = nxt;
  S.lastPos = 0;
  trackLoadedAt = performance.now();
  setLoadedSrcKey(refOf(nxt.folderId, sourcePathOf(nxt)));
  syncPlayerUI();
  updatePlayingRows();
  updateMediaSession(nxt);
  void ensureFullArt(nxt).then(() => {
    updateMediaSession(nxt);
  });
  savePrefs();
  render();
  void waveformTrackChanged();
  lyricsTrackChanged();
  nowPlayingTrackChanged();
  offerResume(nxt);
}

/* ---------- restore the last session ---------- */
/** True once the remembered track was found and loaded; the scanner keeps
    trying after each folder finishes until then — the track may live in a
    folder that connects later in the boot sequence. */
export function restoreLastTrack(): boolean {
  if (!PREFS.lastRef && !PREFS.lastPath) return true; /* nothing to restore */
  /* Folder-qualified ref first; the Phase 1 bare path still restores. */
  const t = PREFS.lastRef
    ? S.byRef[refOf(PREFS.lastRef.folderId, PREFS.lastRef.path)]
    : PREFS.lastPath
      ? S.byPath[PREFS.lastPath]
      : undefined;
  if (!t || !t.file) return false;
  const al = S.albumMap[t.coverKey];
  const list = al ? al.tracks : S.tracks;
  S.baseQueue = list.filter((x) => x.file);
  const idx = S.baseQueue.indexOf(t);
  buildOrder(idx < 0 ? 0 : idx);
  S.current = t;
  playbackArmed = false;
  pendingSeek = PREFS.lastPos || 0;
  revokeCurrentURL();
  try {
    /* loaded but deliberately paused */
    if (useEngineFor(t)) media.loadEngine(engineSourceOf(t), 0);
    else media.loadNative(createTrackURL(t.file));
    setLoadedSrcKey(refOf(t.folderId, sourcePathOf(t)));
  } catch (e) {
    logErr('playback', 'Could not reopen the last track', (e as Error) && (e as Error).message);
  }
  updateMediaSession(t);
  void ensureFullArt(t).then(() => {
    updateMediaSession(t);
  });
  void waveformTrackChanged();
  lyricsTrackChanged();
  return true;
}
