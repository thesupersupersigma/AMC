/* Playback: the queue, transport, Media Session, player bar UI, and
   restore-last-track. */

import type { AnyTrack, RowTrack, TrackRec, VirtualTrack } from '../types';
import { S, PREFS, FULL, codecLabel, coverURL, isCodecFailed, isPlayableTrack, libraryTracks, markCodecFailed, markCodecWorking, refOf, releaseFullArt, savePrefs } from '../state';
import { audio, createTrackURL, getLoadedSrcKey, revokeCurrentURL, setLoadedSrcKey } from '../audio/engine';
import { drawWaveformProgress, waveformTrackChanged } from './waveform';
import { lyricsTrackChanged } from './lyrics';
import { ST_TRACKS, idbGet, idbPut } from '../db/idb';
import { logErr } from './log';
import { icon, solid, artHTML } from './icons';
import { clamp, fmtTime, plural, toast, $ } from '../util';
import { scheduleRender, render } from './render';
import { renderQueuePanel, queuePanelOpen, toggleQueuePanel } from './queue';
import { updatePlayingRows } from './songs';
import { extractArt } from '../scan/scanner';

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
     the queue so playback never stalls on them. A track the user activated
     directly (double-click, Enter, "Play from…") is still attempted — the
     result is logged, and success withdraws the codec verdict. Play and
     Shuffle buttons pass no flag: their target is just "start here". */
  const attempt = !!(opts && opts.attemptTarget);
  const playable = (tracks || []).filter(isPlayableTrack).filter((t) => (attempt && t === target) || !isCodecFailed(t.codec));
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

function loadTrack(t: AnyTrack, autoplay: boolean): void {
  if (!t) return;
  if (!t.file) {
    logErr('playback', 'No file behind ' + t.title, t.path);
    return skipAfterFailure();
  }
  const srcKey = refOf(t.folderId, sourcePathOf(t));
  /* Another window of the file already in the element (a cue track of the
     same rip): keep the decoded stream, just move the playhead. */
  const reuse = srcKey === getLoadedSrcKey() && !!audio.src;
  if (!reuse) {
    revokeCurrentURL();
    let url: string;
    try {
      url = createTrackURL(t.file);
    } catch (e) {
      logErr('playback', 'Could not open ' + t.title, (e as Error) && (e as Error).message);
      return skipAfterFailure();
    }
    audio.src = url;
    audio.load();
    setLoadedSrcKey(srcKey);
  }
  S.current = t;
  S.lastPos = 0;
  trackLoadedAt = performance.now();
  if (autoplay) playbackArmed = true;
  const startAt = t.kind === 'virtual' ? t.startSec : 0;
  if (reuse) {
    try {
      audio.currentTime = startAt;
    } catch {
      pendingSeek = startAt;
    }
  } else if (startAt > 0) {
    pendingSeek = startAt; /* applied on loadedmetadata */
  }
  if (autoplay) {
    const p = audio.play();
    if (p && p.catch)
      p.catch((err: Error & { name?: string }) => {
        /* An autoplay rejection is not a decode failure — leave it paused. */
        if (err && err.name === 'NotAllowedError') {
          S.playing = false;
          syncPlayerUI();
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
  if (!c || audio.paused) return; /* the 'play' listener restarts the loop */
  if (c.kind === 'virtual') checkCueBoundary(c);
  boundaryRaf = requestAnimationFrame(boundaryTick);
}

function checkCueBoundary(c: VirtualTrack): void {
  if (!(c.endSec > 0)) return; /* open-ended: the file's own 'ended' rules */
  if (audio.currentTime < c.endSec - 0.02) return;
  if (S.repeat === 'one') {
    try {
      audio.currentTime = c.startSec;
    } catch {
      /* not seekable right now; the next tick retries */
    }
    return;
  }
  const ni = S.qi + 1;
  const nxt = ni < S.queue.length ? S.queue[ni] : null;
  if (
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
    S.lastPos = audio.currentTime;
    syncPlayerUI();
    updatePlayingRows();
    updateMediaSession(nxt);
    savePrefs();
    void waveformTrackChanged();
    lyricsTrackChanged();
    return;
  }
  audio.pause();
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
    audio.currentTime = scrubWindow().base;
    audio.play().catch(() => {
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
      audio.pause();
      syncPlayerUI();
      return;
    }
  }
  playAt(ni, true);
}

export function prev(): void {
  if (!S.queue.length) return;
  const base = scrubWindow().base;
  if (audio.currentTime - base > 3) {
    audio.currentTime = base;
    return;
  }
  if (S.qi <= 0) {
    if (S.repeat === 'all') return playAt(S.queue.length - 1, true);
    audio.currentTime = base;
    return;
  }
  playAt(S.qi - 1, true);
}

export function togglePlay(): void {
  if (!S.current) {
    if (S.tracks.length) playList(libraryTracks(), 0);
    return;
  }
  if (audio.paused)
    audio.play().catch((e: Error) => {
      logErr('playback', 'Could not resume', e && e.message);
    });
  else audio.pause();
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
  audio.volume = S.volume;
  audio.muted = S.muted;
  savePrefs();
  syncVolumeUI();
}

export function toggleMute(): void {
  S.muted = !S.muted;
  audio.muted = S.muted;
  savePrefs();
  syncVolumeUI();
}

/* Full-size art is fetched for the playing track only, then revoked on change. */
function ensureFullArt(track: AnyTrack | null): Promise<string> {
  if (!track || !track.file || !track.hasArt) {
    releaseFullArt();
    return Promise.resolve('');
  }
  if (FULL.key === track.coverKey && FULL.url) return Promise.resolve(FULL.url);
  releaseFullArt();
  const wanted = track.coverKey;
  return extractArt(track.file)
    .then((blob) => {
      if (!blob) return '';
      if (S.current && S.current.coverKey !== wanted) return ''; /* moved on already */
      FULL.key = wanted;
      FULL.url = URL.createObjectURL(blob);
      return FULL.url;
    })
    .catch(() => '');
}

/* ---------- Media Session: this is what drives the Chromebook media keys --- */
function updateMediaSession(t: AnyTrack | null): void {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    const art: MediaImage[] = [];
    const u = FULL.url || coverURL(t.coverKey);
    if (u) art.push({ src: u, sizes: '300x300' });
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
    audio.play().catch(() => {
      /* stay paused */
    });
  });
  set('pause', () => {
    audio.pause();
  });
  set('stop', () => {
    audio.pause();
    audio.currentTime = 0;
  });
  set('previoustrack', () => {
    prev();
  });
  set('nexttrack', () => {
    next(true);
  });
  set('seekto', (d) => {
    if (d && typeof d.seekTime === 'number' && isFinite(audio.duration)) audio.currentTime = clamp(d.seekTime, 0, audio.duration);
  });
  set('seekbackward', (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10));
  });
  set('seekforward', (d) => {
    if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + ((d && d.seekOffset) || 10));
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
  syncVolumeUI();
  syncTimeUI();
  if (queuePanelOpen()) renderQueuePanel();
}

/** The scrub window: a virtual track scrubs within [startSec, endSec] of
    its source file; everything else scrubs the whole file. */
function scrubWindow(): { base: number; span: number } {
  const c = S.current;
  if (c && c.kind === 'virtual') {
    const end = c.endSec > 0 ? c.endSec : isFinite(audio.duration) && audio.duration > 0 ? audio.duration : c.startSec + (c.duration || 0);
    return { base: c.startSec, span: Math.max(0, end - c.startSec) };
  }
  return { base: 0, span: isFinite(audio.duration) && audio.duration > 0 ? audio.duration : c ? c.duration : 0 };
}

function syncTimeUI(): void {
  const w = scrubWindow();
  const d = w.span;
  const c = clamp((audio.currentTime || 0) - w.base, 0, d > 0 ? d : Infinity);
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
        audio.currentTime = w.base + clamp((Number(scrub.value) / 1000) * w.span, 0, w.span);
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
    audio.muted = false;
    setVolume(Number(vol.value) / 100);
  });
}

/* ---------- audio element events ---------- */
export function wireAudio(): void {
  /* 'play' only means the request was accepted, not that anything decoded, so
     it must NOT clear failStreak — otherwise the skip guard never trips. */
  audio.addEventListener('play', () => {
    S.playing = true;
    syncPlayerUI();
    updatePlayingRows();
    startBoundaryLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audio.addEventListener('pause', () => {
    S.playing = false;
    syncPlayerUI();
    updatePlayingRows();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  audio.addEventListener('ended', () => {
    /* A track restored from the last session is loaded but deliberately
       paused. If it is a broken file it can fire 'ended' on load, and
       advancing there would start playing something nobody asked for. */
    if (!playbackArmed) return;
    /* A corrupt file can report a full duration and still finish instantly,
       which would let repeat-all spin through a dead queue forever. Wall-clock
       time is the only signal that survives that, so judge on elapsed time. */
    const elapsed = performance.now() - trackLoadedAt;
    const claimed = (S.current && S.current.duration) || audio.duration || 0;
    if (elapsed < 400 && claimed > 2) {
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
  audio.addEventListener('timeupdate', () => {
    syncTimeUI();
    /* Hidden tabs suspend requestAnimationFrame; this ~4 Hz check is the
       coarse safety net that keeps cue boundaries working there. */
    if (S.current && S.current.kind === 'virtual' && !audio.paused) checkCueBoundary(S.current);
    /* Only real elapsed playback clears the failure streak — and proves the
       codec, withdrawing any earlier session verdict against its fourcc.
       "Real" requires decoded bytes where the browser exposes the counter:
       a missing decoder can advance the clock over silence, and that false
       proof would veto the codec mark for the whole session. */
    if (performance.now() - trackLoadedAt > 1200) {
      failStreak = 0;
      const decodedBytes = (audio as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
      if ((decodedBytes === undefined || decodedBytes > 0) && S.current && markCodecWorking(S.current.codec)) {
        logErr('playback', codecLabel(S.current.codec as string) + ' plays after all — removing the codec badge', S.current.path);
        scheduleRender();
      }
    }
    if (S.current && !seeking) {
      S.lastPos = audio.currentTime;
      if (Math.floor(audio.currentTime) % 5 === 0) savePrefs();
    }
  });
  audio.addEventListener('durationchange', () => {
    if (S.current && isFinite(audio.duration) && audio.duration > 0 && !S.current.duration) {
      S.current.duration = audio.duration;
      const cur = S.current;
      void idbGet<TrackRec>(ST_TRACKS, cur.cacheKey).then((rec) => {
        if (rec) {
          rec.duration = audio.duration;
          void idbPut(ST_TRACKS, rec);
        }
      });
      scheduleRender();
    }
    syncTimeUI();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek > 0 && isFinite(audio.duration)) {
      try {
        audio.currentTime = clamp(pendingSeek, 0, audio.duration - 0.5);
      } catch {
        /* not seekable yet */
      }
      pendingSeek = 0;
    }
    syncTimeUI();
  });
  audio.addEventListener('error', () => {
    const t = S.current;
    const code = audio.error ? audio.error.code : 0;
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
    audio.src = createTrackURL(t.file); /* loaded but deliberately paused */
    audio.load();
    setLoadedSrcKey(refOf(t.folderId, sourcePathOf(t)));
  } catch (e) {
    logErr('playback', 'Could not reopen the last track', (e as Error) && (e as Error).message);
  }
  updateMediaSession(t);
  void waveformTrackChanged();
  lyricsTrackChanged();
  return true;
}
