/* The single playback facade. Every module plays, seeks, reads the clock and
   listens for playback events through `media`, never through the <audio>
   element directly. It delegates to one of two paths:

     native — the <audio id="audio"> element (everything Chrome decodes)
     engine — the software decode engine (src/audio/soft/)

   and re-dispatches the active path's events from ONE long-lived
   EventTarget, so listeners bound once at boot keep working across path
   switches. The engine dispatches the element's events in the element's
   order, so ui/player.ts behaves the same on either path.

   While the engine plays, the element loops generated silence so Chrome
   keeps the media session (media keys, ChromeOS media controls); its own
   events are swallowed then, and the Media Session position state is
   published from the engine clock instead.

   Playback rate (the turntable speed) works on both paths, in SOURCE time:
   currentTime advances `playbackRate` seconds per second either way. The
   element plays it with pitch preservation off (varispeed); the engine
   always resamples, so its pitch always follows the speed. Like an
   element's load(), loading a track on either path starts it at
   defaultPlaybackRate. */

import { SoftEngine, engineSupported } from './soft/soft-engine';
import type { EngineSource, TrackInfo } from './soft/protocol';
import { keepaliveUrl } from './soft/keepalive';
import type { SpatialOutputMode } from './spatial/contract';
import { logErr } from '../ui/log';

export type MediaPath = 'native' | 'engine';

/** What AMC uses of HTMLMediaElement — the whole surface, nothing more. */
export interface MediaLike extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch: boolean;
  readonly error: { code: number; message?: string } | null;
  play(): Promise<void>;
  pause(): void;
}

type PitchEl = HTMLMediaElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };

/* The range AMC uses (the turntable clamps to it; the engine's resampler
   is sized for it). */
function clampRate(v: number): number {
  const r = Number(v);
  if (!(r > 0) || !isFinite(r)) return 1;
  return Math.max(0.0625, Math.min(4, r));
}

const FORWARDED = [
  'loadstart',
  'emptied',
  'durationchange',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'play',
  'playing',
  'pause',
  'waiting',
  'seeking',
  'seeked',
  'timeupdate',
  'ended',
  'error',
  'volumechange',
  'ratechange',
];

const el = document.getElementById('audio') as HTMLAudioElement;

class MediaFacade extends EventTarget implements MediaLike {
  private eng: SoftEngine | null = null;
  private _path: MediaPath = 'native';
  private _volume = 1;
  private _muted = false;
  private _defaultRate = 1;
  private _preservesPitch = true;
  /** Element play/pause events this facade caused itself. Media element
      events arrive asynchronously, so a flag set around the call would be
      long cleared by the time they land. */
  private kaExpect = { play: 0, pause: 0 };
  private kaStopTimer: ReturnType<typeof setTimeout> | null = null;
  private spatialModeFn: () => SpatialOutputMode | 'auto' = () => 'auto';

  constructor() {
    super();
    for (const type of FORWARDED) {
      el.addEventListener(type, () => {
        if (this._path === 'native') this.dispatchEvent(new Event(type));
      });
    }
    /* The keep-alive element paused or resumed by the browser itself (audio
       focus taken by another tab, ChromeOS media controls without a
       handler): follow it with the engine. */
    el.addEventListener('pause', () => {
      if (this.kaExpect.pause > 0) {
        this.kaExpect.pause--;
        return;
      }
      if (this._path === 'engine' && this.eng && !this.eng.paused) this.eng.pause();
    });
    el.addEventListener('play', () => {
      if (this.kaExpect.play > 0) {
        this.kaExpect.play--;
        return;
      }
      if (this._path === 'engine' && this.eng && this.eng.paused && !this.eng.ended) void this.eng.play().catch(() => {});
    });
  }

  /* ---------- path management ---------- */

  get path(): MediaPath {
    return this._path;
  }

  /** The live engine instance (created on first use). */
  private engine(): SoftEngine {
    if (this.eng) return this.eng;
    const e = new SoftEngine({
      role: 'main',
      onLog: (message, detail) => logErr('engine', message, detail),
      spatialMode: () => this.resolvedSpatialMode(),
      devCodecs: import.meta.env.DEV,
    });
    e.defaultPlaybackRate = this._defaultRate;
    e.playbackRate = this._defaultRate;
    for (const type of FORWARDED) {
      e.addEventListener(type, () => {
        if (this._path === 'engine' && this.eng === e) {
          this.dispatchEvent(new Event(type));
          if (type === 'play' || type === 'pause' || type === 'seeked' || type === 'durationchange' || type === 'playing' || type === 'ratechange') this.publishPosition();
        }
      });
    }
    e.addEventListener('spatialchange', () => {
      if (this._path === 'engine' && this.eng === e) this.dispatchEvent(new Event('spatialchange'));
    });
    e.addEventListener('segment', (ev) => {
      if (this._path !== 'engine' || this.eng !== e) return;
      this.dispatchEvent(new CustomEvent('gaplessadvance', { detail: (ev as CustomEvent).detail }));
      this.publishPosition();
    });
    /* At a natural end the player usually starts the next track at once:
       keep the session alive across that, and let it go only if nothing
       follows. */
    e.addEventListener('ended', () => {
      if (this.eng !== e) return;
      if (this.kaStopTimer) clearTimeout(this.kaStopTimer);
      this.kaStopTimer = setTimeout(() => {
        this.kaStopTimer = null;
        if (this._path === 'engine' && this.eng && this.eng.paused) this.stopKeepalive();
      }, 1500);
    });
    e.addEventListener('error', () => {
      if (this.eng === e) this.stopKeepalive();
    });
    this.eng = e;
    return e;
  }

  /** Loads a natively decodable source into the element. */
  loadNative(url: string): void {
    if (this._path === 'engine') {
      if (this.eng) this.eng.unload();
      this.stopKeepalive();
      this.clearPosition();
    }
    this._path = 'native';
    this.kaExpect = { play: 0, pause: 0 };
    el.loop = false;
    el.volume = this._volume;
    el.muted = this._muted;
    /* load() resets playbackRate to this; preservesPitch survives loads. */
    this.applyElementRate();
    el.src = url;
    el.load();
  }

  /** Loads a track into the software engine, starting at startSec. */
  loadEngine(src: EngineSource, startSec = 0): void {
    const wasNative = this._path === 'native';
    this._path = 'engine';
    if (wasNative) {
      try {
        if (!el.paused) {
          this.kaExpect.pause++;
          el.pause();
        }
        el.removeAttribute('src');
        el.load();
      } catch {
        /* nothing loaded */
      }
    }
    const e = this.engine();
    e.volume = this._volume;
    e.muted = this._muted;
    e.defaultPlaybackRate = this._defaultRate;
    e.open(src, startSec); /* starts at the default rate, as load() would */
  }

  /** Stop and drop whatever is loaded (the playing folder was removed). */
  stop(): void {
    if (this._path === 'engine') {
      if (this.eng) this.eng.unload();
      this.stopKeepalive();
    } else {
      el.pause();
    }
  }

  /** Something is loaded on the active path. */
  hasSource(): boolean {
    return this._path === 'engine' ? !!(this.eng && this.eng.source) : !!el.src;
  }

  /** Native only: proof that bytes were decoded (Chrome's counter). */
  decodedBytes(): number | undefined {
    return (el as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
  }

  /** The engine's view of the current track, when the engine plays it. */
  engineInfo(): TrackInfo | null {
    return this._path === 'engine' && this.eng ? this.eng.trackInfo : null;
  }

  /** Gapless (engine path): the next track to splice in, or null. */
  setNext(src: EngineSource | null): void {
    if (this._path === 'engine' && this.eng) this.eng.setNext(src);
  }

  /** Crossfade: the current engine stream keeps playing as a tail that
      fades out over `seconds`, while a fresh instance takes the next track.
      Returns false on the native path (the element tail handles that). */
  detachEngineTail(seconds: number): boolean {
    if (this._path !== 'engine' || !this.eng || this.eng.paused) return false;
    const tail = this.eng;
    this.eng = null;
    tail.fadeOutAndDispose(seconds);
    return true;
  }

  /* ---------- the MediaLike surface ---------- */

  get currentTime(): number {
    if (this._path === 'engine') return this.eng ? this.eng.currentTime : 0;
    return el.currentTime;
  }
  set currentTime(v: number) {
    if (this._path === 'engine') {
      if (this.eng) this.eng.currentTime = v;
      return;
    }
    el.currentTime = v;
  }
  get duration(): number {
    if (this._path === 'engine') return this.eng ? this.eng.duration : NaN;
    return el.duration;
  }
  get paused(): boolean {
    if (this._path === 'engine') return this.eng ? this.eng.paused : true;
    return el.paused;
  }
  get ended(): boolean {
    if (this._path === 'engine') return this.eng ? this.eng.ended : false;
    return el.ended;
  }
  get error(): { code: number; message?: string } | null {
    if (this._path === 'engine') return this.eng ? this.eng.error : null;
    return el.error;
  }
  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._path === 'native') el.volume = this._volume;
    else if (this.eng) this.eng.volume = this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = !!m;
    if (this._path === 'native') el.muted = this._muted;
    else if (this.eng) this.eng.muted = this._muted;
  }

  /** Source seconds per second on the active path. */
  get playbackRate(): number {
    if (this._path === 'engine') return this.eng ? this.eng.playbackRate : this._defaultRate;
    return el.playbackRate;
  }
  set playbackRate(v: number) {
    const r = clampRate(v);
    if (this._path === 'engine') {
      if (this.eng) this.eng.playbackRate = r;
      return;
    }
    try {
      el.playbackRate = r;
    } catch {
      /* out of this browser's range */
    }
  }
  /** The rate every newly loaded track starts at, on either path. */
  get defaultPlaybackRate(): number {
    return this._defaultRate;
  }
  set defaultPlaybackRate(v: number) {
    this._defaultRate = clampRate(v);
    if (this.eng) this.eng.defaultPlaybackRate = this._defaultRate;
    try {
      el.defaultPlaybackRate = this._defaultRate;
    } catch {
      /* out of range */
    }
  }
  /** Pitch correction at rates other than 1. The engine resamples, so on
      that path the pitch always follows the speed (false). */
  get preservesPitch(): boolean {
    if (this._path === 'engine') return false;
    return (el as PitchEl).preservesPitch !== false;
  }
  set preservesPitch(on: boolean) {
    this._preservesPitch = !!on;
    this.applyElementPitch();
  }

  private applyElementPitch(): void {
    const p = el as PitchEl;
    try {
      p.preservesPitch = this._preservesPitch;
      p.mozPreservesPitch = this._preservesPitch;
      p.webkitPreservesPitch = this._preservesPitch;
    } catch {
      /* read-only in some engines */
    }
  }

  private applyElementRate(): void {
    try {
      el.defaultPlaybackRate = this._defaultRate;
      el.playbackRate = this._defaultRate;
    } catch {
      /* out of range */
    }
    this.applyElementPitch();
  }

  play(): Promise<void> {
    if (this._path === 'native') return el.play();
    const e = this.engine();
    this.startKeepalive();
    return e.play();
  }

  pause(): void {
    if (this._path === 'native') {
      el.pause();
      return;
    }
    if (this.eng) this.eng.pause();
    this.stopKeepalive();
  }

  load(): void {
    if (this._path === 'native') el.load();
  }

  /* ---------- media session plumbing for the engine path ---------- */

  private startKeepalive(): void {
    if (this.kaStopTimer) clearTimeout(this.kaStopTimer);
    this.kaStopTimer = null;
    try {
      const url = keepaliveUrl();
      if (el.getAttribute('src') !== url) {
        el.src = url;
        el.loop = true;
      }
      el.volume = 1;
      el.muted = false;
      if (!el.paused) return;
      this.kaExpect.play++;
      const p = el.play();
      if (p && p.catch)
        p.catch(() => {
          /* refused before any 'play' event: no media session this time —
             playback itself is unaffected */
          if (el.paused && this.kaExpect.play > 0) this.kaExpect.play--;
        });
    } catch {
      /* ditto */
    }
  }

  private stopKeepalive(): void {
    if (this.kaStopTimer) clearTimeout(this.kaStopTimer);
    this.kaStopTimer = null;
    try {
      if (el.getAttribute('src') === keepaliveUrl() && !el.paused) {
        this.kaExpect.pause++;
        el.pause();
      }
    } catch {
      /* not playing */
    }
  }

  private publishPosition(): void {
    if (!('mediaSession' in navigator) || this._path !== 'engine' || !this.eng) return;
    const d = this.eng.duration;
    if (!(d > 0) || !isFinite(d)) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, playbackRate: this.eng.playbackRate || 1, position: Math.max(0, Math.min(d, this.eng.currentTime)) });
    } catch {
      /* older API shape */
    }
  }

  private clearPosition(): void {
    if (!('mediaSession' in navigator)) return;
    try {
      (navigator.mediaSession as MediaSession & { setPositionState(s?: MediaPositionState): void }).setPositionState();
    } catch {
      /* nothing to clear */
    }
  }

  /** Settings → spatial output. 'auto' resolves against the device. */
  setSpatialModeProvider(fn: () => SpatialOutputMode | 'auto'): void {
    this.spatialModeFn = fn;
  }
  refreshSpatialMode(): void {
    if (this.eng) this.eng.refreshSpatialMode();
    if (this._path === 'engine') this.dispatchEvent(new Event('spatialchange'));
  }
  /** Objects the Atmos processor decodes for the playing track (0 when
      none run, or before the first object frame). */
  spatialObjects(): number {
    return this._path === 'engine' && this.eng ? this.eng.spatialObjects : 0;
  }
  /** The mode the spatial renderer renders for right now, or null. */
  spatialOutputMode(): SpatialOutputMode | null {
    return this._path === 'engine' && this.eng ? this.eng.spatialMode : null;
  }
  private resolvedSpatialMode(): SpatialOutputMode {
    const m = this.spatialModeFn();
    if (m !== 'auto') return m;
    const ctx = this.eng ? this.eng.debugOutput() : null;
    const max = ctx ? ctx.ctx.destination.maxChannelCount : 2;
    return max >= 6 ? 'multichannel' : 'speakers';
  }

  /** Dev/test only. */
  debugEngine(): SoftEngine | null {
    return this.eng;
  }
}

export const media = new MediaFacade();

/** The engine can run in this browser (Worker, WebAssembly, AudioWorklet). */
export function engineAvailable(): boolean {
  return engineSupported();
}

if (import.meta.env.DEV) {
  (window as unknown as { __amcMedia?: MediaFacade }).__amcMedia = media;
}
