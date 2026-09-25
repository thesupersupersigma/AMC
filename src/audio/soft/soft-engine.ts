/* Main-thread side of the software decode engine. One instance plays one
   stream: the app keeps a long-lived instance for playback and spins up
   short-lived ones for crossfade tails and waveform peaks.

   It owns the decode Worker, an AudioContext (created lazily on the first
   play — a user gesture — at the file's sample rate), the AudioWorklet
   node, and a GainNode for volume/mute. It exposes an HTMLMediaElement-like
   surface (currentTime, duration, paused, ended, volume, muted, error,
   play(), pause()) and dispatches the element's events in the element's
   order, so the playback facade can swap it in for <audio> without the
   player noticing.

   currentTime comes from frames the worklet actually played (its read-head
   reports), interpolated on the audio clock between reports and corrected
   for output latency — never from the wall clock. */

import '../spatial/register';
import { getSpatialRendererFactory, type SpatialOutputMode, type SpatialRenderer } from '../spatial/contract';
import { createDecodeWorker, decoderWasmUrl } from './assets';
import { WORKLET_PROCESSOR, workletSource } from './worklet';
import type { EngineSource, FromWorker, FromWorklet, MainToWorklet, ToWorker, TrackInfo } from './protocol';

export interface EngineError {
  code: number;
  message: string;
}

export interface SoftEngineOptions {
  role: 'main' | 'tail' | 'peaks';
  onLog?: (message: string, detail?: string) => void;
  /** The spatial output mode to apply when a renderer is active. */
  spatialMode?: () => SpatialOutputMode;
  /** Prefer WebCodecs when it supports the codec (default true). */
  allowWebCodecs?: boolean;
  /** Dev/test only: accept FLAC-in-MP4 (WebCodecs) as an engine codec. */
  devCodecs?: boolean;
}

export { engineSupported } from './support';

let workletUrl = '';
function workletModuleUrl(): string {
  if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
  return workletUrl;
}

const TIMEUPDATE_MS = 250;

export class SoftEngine extends EventTarget {
  readonly role: SoftEngineOptions['role'];
  private opts: SoftEngineOptions;
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private modules = new WeakSet<AudioContext>();
  private node: AudioWorkletNode | null = null;
  private nodeChannels = 0;
  private gain: GainNode | null = null;
  private renderer: SpatialRenderer | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  private gen = 0;
  private segCounter = 0;
  private seg = -1;
  private src: EngineSource | null = null;
  private info: TrackInfo | null = null;
  private infoBySeg = new Map<number, TrackInfo>();
  private srcBySeg = new Map<number, EngineSource>();
  private opened = false;
  private startSec = 0;
  private startSent = -1;

  private _paused = true;
  private _ended = false;
  private _volume = 1;
  private _muted = false;
  private _error: EngineError | null = null;
  private seekingTo: number | null = null;
  private pos = { gen: -1, media: 0, time: 0, playing: false, stream: 0 };
  private queued = 0;
  private floor = 0;
  private lastReturned = 0;
  private starving = false;
  private lastTimeupdate = 0;
  private startedGen = -1;

  private nextSeg = -1;
  private nextReady = false;

  private tapFn: ((stream: number, planes: Float32Array[], media: number) => void) | null = null;
  private playWaiters: Array<{ res: () => void; rej: (e: Error) => void }> = [];

  constructor(opts: SoftEngineOptions) {
    super();
    this.opts = opts;
    this.role = opts.role;
  }

  /* ---------- element-like surface ---------- */

  get paused(): boolean {
    return this._paused;
  }
  get ended(): boolean {
    return this._ended;
  }
  get error(): EngineError | null {
    return this._error;
  }
  get duration(): number {
    return this.info ? this.info.duration : NaN;
  }
  get trackInfo(): TrackInfo | null {
    return this.info;
  }
  get source(): EngineSource | null {
    return this.src;
  }
  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    const nv = Math.max(0, Math.min(1, Number(v) || 0));
    if (nv === this._volume) return;
    this._volume = nv;
    this.applyGain();
    this.emit('volumechange');
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    if (!!m === this._muted) return;
    this._muted = !!m;
    this.applyGain();
    this.emit('volumechange');
  }

  get currentTime(): number {
    if (this.seekingTo !== null) return this.seekingTo;
    const info = this.info;
    if (!info || !this.opened) return this.startSec;
    if (this._ended) return info.duration;
    /* Paused: the position decided at pause time (the worklet's one-quantum
       fade-out still nudges its head). Starving: hold what was last shown. */
    if (this._paused) return this.floor;
    if (this.starving || this.pos.gen !== this.gen) return Math.max(this.floor, this.lastReturned);
    let t = this.pos.media / info.sampleRate;
    const ctx = this.ctx;
    if (this.pos.playing && ctx && ctx.state === 'running') {
      t += Math.min(0.25, Math.max(0, ctx.currentTime - this.pos.time)) - this.latency();
    }
    t = Math.max(t, this.floor, this.lastReturned);
    t = Math.max(0, Math.min(t, info.duration || t));
    this.lastReturned = t;
    return t;
  }
  set currentTime(sec: number) {
    this.seek(sec);
  }

  private latency(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number };
    const l = (ctx && (ctx.outputLatency || ctx.baseLatency)) || 0;
    return Math.max(0, Math.min(0.5, l));
  }

  private emit(type: string, detail?: unknown): void {
    this.dispatchEvent(detail === undefined ? new Event(type) : new CustomEvent(type, { detail }));
  }

  private log(message: string, detail?: string): void {
    if (this.opts.onLog) this.opts.onLog(message, detail);
  }

  /* ---------- worker ---------- */

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = createDecodeWorker();
    w.onmessage = (e: MessageEvent) => this.onWorker(e.data as FromWorker);
    w.onerror = (e: ErrorEvent) => {
      this.log('The decode worker failed', e.message || 'unknown error');
      this.fail(3, 'decode worker failed: ' + (e.message || 'unknown error'));
    };
    this.worker = w;
    this.toWorker({
      t: 'init',
      wasm: decoderWasmUrl(),
      port: null,
      allowWebCodecs: this.opts.allowWebCodecs !== false,
      devCodecs: !!this.opts.devCodecs,
    });
    return w;
  }

  private toWorker(m: ToWorker, transfer?: Transferable[]): void {
    if (this.worker) this.worker.postMessage(m, transfer || []);
  }

  private toWorklet(m: MainToWorklet, transfer?: Transferable[]): void {
    if (this.node) this.node.port.postMessage(m, transfer || []);
  }

  /** Opens a track. startSec is where playback will begin. */
  open(src: EngineSource, startSec = 0): void {
    this.gen++;
    this.seg = ++this.segCounter;
    this.src = src;
    this.srcBySeg.clear();
    this.infoBySeg.clear();
    this.srcBySeg.set(this.seg, src);
    this.info = null;
    this.opened = false;
    this._ended = false;
    this._error = null;
    this.seekingTo = null;
    this.startSec = Math.max(0, startSec || 0);
    this.floor = this.startSec;
    this.lastReturned = this.startSec;
    this.pos = { gen: -1, media: 0, time: 0, playing: false, stream: 0 };
    this.starving = false;
    this.startedGen = -1;
    this.nextSeg = -1;
    this.nextReady = false;
    this.startSent = -1;
    if (this.renderer) this.renderer.reset();
    this.toWorklet({ t: 'flush', gen: this.gen });
    this.ensureWorker();
    this.toWorker({ t: 'open', gen: this.gen, seg: this.seg, src, startSec: this.startSec, spatial: !!getSpatialRendererFactory() });
    this.emit('emptied');
    this.emit('loadstart');
  }

  /** Stops and forgets the current track (the element's removeAttribute('src')). */
  unload(): void {
    this.gen++;
    this.toWorklet({ t: 'flush', gen: this.gen });
    this.toWorklet({ t: 'pause' });
    this.toWorker({ t: 'close' });
    this.src = null;
    this.info = null;
    this.opened = false;
    const wasPlaying = !this._paused;
    this._paused = true;
    if (wasPlaying) this.emit('pause');
  }

  play(): Promise<void> {
    if (this._error) return Promise.reject(Object.assign(new Error(this._error.message), { name: 'NotSupportedError' }));
    if (!this.src) return Promise.reject(Object.assign(new Error('nothing loaded'), { name: 'NotSupportedError' }));
    if (this._ended) this.seek(0);
    const wasPaused = this._paused;
    this._paused = false;
    if (wasPaused) this.emit('play');
    /* Created synchronously, inside the user gesture that called play(). */
    this.ensureContext(this.info ? this.info.sampleRate : 0);
    const p = new Promise<void>((res, rej) => this.playWaiters.push({ res, rej }));
    void this.startAudio();
    return p;
  }

  pause(): void {
    if (this._paused) return;
    const t = this.currentTime;
    this._paused = true;
    this.floor = t;
    this.lastReturned = t;
    this.toWorklet({ t: 'pause' });
    this.settlePlay(null);
    this.emit('timeupdate');
    this.emit('pause');
    this.scheduleSuspend();
  }

  seek(sec: number): void {
    const target = Math.max(0, Number(sec) || 0);
    if (!this.src) return;
    if (!this.opened || !this.info) {
      /* Before the tables are read: this becomes the start position. */
      this.startSec = target;
      this.floor = target;
      this.lastReturned = target;
      if (this.opened === false && this.worker) {
        this.gen++;
        this.toWorklet({ t: 'flush', gen: this.gen });
        this.toWorker({ t: 'open', gen: this.gen, seg: this.seg, src: this.src, startSec: target, spatial: !!getSpatialRendererFactory() });
      }
      return;
    }
    const clamped = Math.min(target, Math.max(0, this.info.duration - 0.001));
    this.gen++;
    this._ended = false;
    this.seekingTo = clamped;
    this.floor = clamped;
    this.lastReturned = clamped;
    this.starving = false;
    this.startedGen = -1;
    if (this.renderer) this.renderer.reset();
    this.emit('seeking');
    this.toWorklet({ t: 'flush', gen: this.gen });
    this.toWorker({ t: 'seek', gen: this.gen, seg: this.seg, sec: clamped });
    if (this.startSent >= 0) this.startSent = this.gen;
  }

  /** Gapless: the track that follows this one without a gap (same sample
      rate and channel count), or null to cancel. */
  setNext(src: EngineSource | null): void {
    const cur = this.nextSeg >= 0 ? this.srcBySeg.get(this.nextSeg) : null;
    if (src && cur && cur.file === src.file) return;
    if (this.nextSeg >= 0) this.toWorker({ t: 'cancelNext', seg: this.nextSeg });
    this.nextSeg = -1;
    this.nextReady = false;
    if (!src || !this.src) return;
    this.nextSeg = ++this.segCounter;
    this.srcBySeg.set(this.nextSeg, src);
    this.toWorker({ t: 'next', seg: this.nextSeg, src });
  }

  get hasNext(): boolean {
    return this.nextSeg >= 0 && this.nextReady;
  }

  /* ---------- audio graph ---------- */

  private ensureContext(rate: number): AudioContext | null {
    if (this.ctx && this.ctx.state !== 'closed' && (!rate || this.ctx.sampleRate === rate)) return this.ctx;
    this.teardownGraph();
    try {
      const opts: AudioContextOptions = { latencyHint: 'playback' };
      if (rate >= 3000 && rate <= 768000) opts.sampleRate = rate;
      try {
        this.ctx = new AudioContext(opts);
      } catch {
        /* this rate is refused here: let Web Audio resample */
        this.ctx = new AudioContext({ latencyHint: 'playback' });
      }
    } catch (e) {
      this.log('Could not start Web Audio', (e as Error).message);
      this.ctx = null;
    }
    return this.ctx;
  }

  private teardownGraph(): void {
    if (this.node) {
      try {
        this.node.port.postMessage({ t: 'dispose' });
        this.node.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.node = null;
    this.nodeChannels = 0;
    this.disposeRenderer();
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.gain = null;
    if (this.ctx) {
      const old = this.ctx;
      void old.close().catch(() => {});
    }
    this.ctx = null;
  }

  private disposeRenderer(): void {
    if (!this.renderer) return;
    try {
      this.renderer.dispose();
    } catch {
      /* the add-on's problem */
    }
    this.renderer = null;
  }

  private applyGain(): void {
    if (!this.gain || !this.ctx) return;
    const v = this._muted ? 0 : this._volume;
    try {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.012);
    } catch {
      this.gain.gain.value = v;
    }
  }

  /** Builds (or reuses) context → node → [spatial renderer] → gain → out
      for the current track's rate and channel count, then lets the worker
      start and the worklet play. */
  private async startAudio(): Promise<void> {
    const gen = this.gen;
    const info = this.info;
    if (!info || !this.opened) return; /* 'opened' will call back here */
    const ctx = this.ensureContext(info.sampleRate);
    if (!ctx) {
      this.settlePlay(Object.assign(new Error('Web Audio is unavailable'), { name: 'NotSupportedError' }));
      return;
    }
    try {
      if (!this.modules.has(ctx)) {
        await ctx.audioWorklet.addModule(workletModuleUrl());
        this.modules.add(ctx);
      }
    } catch (e) {
      this.fail(4, 'the audio worklet could not load: ' + (e as Error).message);
      return;
    }
    if (gen !== this.gen && this.info !== info) return;
    if (ctx !== this.ctx) return;
    this.ensureNode(ctx, info);
    if (this.startSent !== this.gen) {
      this.startSent = this.gen;
      this.toWorker({ t: 'start', gen: this.gen });
    }
    if (this._paused) return;
    this.toWorklet({ t: 'play' });
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (ctx.state !== 'running') {
      const resumed = ctx.resume();
      const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 3000));
      const r = await Promise.race([resumed.then(() => 'ok' as const), timeout]).catch(() => 'timeout' as const);
      if (r === 'timeout' && (ctx.state as string) !== 'running') {
        this._paused = true;
        this.toWorklet({ t: 'pause' });
        this.settlePlay(Object.assign(new Error('The browser did not allow audio to start'), { name: 'NotAllowedError' }));
        this.emit('pause');
        return;
      }
    }
    this.settlePlay(null);
  }

  private ensureNode(ctx: AudioContext, info: TrackInfo): void {
    if (this.node && this.nodeChannels === info.channels) {
      this.setupRenderer(ctx, info);
      return;
    }
    if (this.node) {
      try {
        this.node.port.postMessage({ t: 'dispose' });
        this.node.disconnect();
      } catch {
        /* already gone */
      }
      this.node = null;
    }
    const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [info.channels],
    });
    node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data as FromWorklet);
    this.node = node;
    this.nodeChannels = info.channels;
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.connect(ctx.destination);
      this.gain.gain.value = this._muted ? 0 : this._volume;
    }
    /* True multichannel out when the device has it; otherwise the
       destination's 'speakers' interpretation downmixes. */
    try {
      const want = info.coreChannels >= 6 && ctx.destination.maxChannelCount >= 6 ? 6 : Math.min(2, ctx.destination.maxChannelCount || 2);
      if (ctx.destination.channelCount !== want) ctx.destination.channelCount = want;
    } catch {
      /* fixed-channel destination */
    }
    const ch = new MessageChannel();
    node.port.postMessage({ t: 'port', port: ch.port1 }, [ch.port1]);
    this.toWorker({ t: 'port', port: ch.port2 }, [ch.port2]);
    node.port.postMessage({ t: 'flush', gen: this.gen });
    if (this.tapFn) node.port.postMessage({ t: 'tap', on: true });
    this.setupRenderer(ctx, info);
  }

  private setupRenderer(ctx: AudioContext, info: TrackInfo): void {
    const node = this.node as AudioWorkletNode;
    const gain = this.gain as GainNode;
    const factory = getSpatialRendererFactory();
    const want = !!(info.spatial && factory);
    if (!want) {
      if (this.renderer) {
        this.disposeRenderer();
        try {
          node.disconnect();
        } catch {
          /* not connected */
        }
      }
      try {
        node.disconnect();
      } catch {
        /* not connected */
      }
      node.connect(gain);
      return;
    }
    if (this.renderer) return;
    try {
      const sp = info.spatial as NonNullable<TrackInfo['spatial']>;
      const r = (factory as NonNullable<typeof factory>)(ctx, sp.bedChannels, sp.objectChannels);
      try {
        node.disconnect();
      } catch {
        /* not connected */
      }
      node.connect(r.input);
      r.output.connect(gain);
      r.setMode(this.spatialMode(ctx));
      this.renderer = r;
    } catch (e) {
      this.log('The spatial renderer failed — playing the bed only', (e as Error).message);
      this.renderer = null;
      node.connect(gain);
    }
  }

  private spatialMode(ctx: AudioContext): SpatialOutputMode {
    const m = this.opts.spatialMode ? this.opts.spatialMode() : 'speakers';
    return m || (ctx.destination.maxChannelCount >= 6 ? 'multichannel' : 'speakers');
  }

  /** Re-applies the spatial output mode (Settings changed). */
  refreshSpatialMode(): void {
    if (this.renderer && this.ctx) this.renderer.setMode(this.spatialMode(this.ctx));
  }

  get spatialActive(): boolean {
    return !!this.renderer;
  }

  private scheduleSuspend(): void {
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (this._paused && this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
    }, 400);
  }

  private settlePlay(err: Error | null): void {
    const w = this.playWaiters;
    this.playWaiters = [];
    for (const p of w) {
      if (err) p.rej(err);
      else p.res();
    }
  }

  private fail(code: number, message: string): void {
    this._error = { code, message };
    const wasPlaying = !this._paused;
    this._paused = true;
    this.toWorklet({ t: 'pause' });
    this.settlePlay(Object.assign(new Error(message), { name: code === 4 ? 'NotSupportedError' : 'AbortError' }));
    if (wasPlaying) this.emit('pause');
    this.emit('error');
  }

  /* ---------- messages ---------- */

  private onWorker(m: FromWorker): void {
    switch (m.t) {
      case 'opened':
        if (m.gen !== this.gen || m.seg !== this.seg) return;
        this.info = m.info;
        this.infoBySeg.set(m.seg, m.info);
        this.opened = true;
        this.pos = { gen: this.gen, media: Math.round(this.startSec * m.info.sampleRate), time: 0, playing: false, stream: 0 };
        this.emit('durationchange');
        this.emit('loadedmetadata');
        this.emit('loadeddata');
        this.emit('canplay');
        if (this.ctx && this.ctx.sampleRate !== m.info.sampleRate) this.ensureContext(m.info.sampleRate);
        if (this.ctx || !this._paused) void this.startAudio();
        return;
      case 'seeked':
        if (m.gen !== this.gen || this.seekingTo === null || !this.info) return;
        this.pos = { gen: this.gen, media: Math.round(this.seekingTo * this.info.sampleRate), time: this.ctx ? this.ctx.currentTime : 0, playing: false, stream: this.pos.stream };
        this.seekingTo = null;
        this.emit('timeupdate');
        this.emit('seeked');
        return;
      case 'error':
        if (m.gen !== this.gen) return;
        this.log('Software decoding failed for ' + (this.src ? this.src.name : 'a track'), m.message);
        this.fail(m.code, m.message);
        return;
      case 'log':
        this.log(m.message, m.detail);
        return;
      case 'nextReady':
        if (m.seg !== this.nextSeg) return;
        this.nextReady = true;
        this.infoBySeg.set(m.seg, m.info);
        return;
      case 'nextRejected':
        if (m.seg !== this.nextSeg) return;
        this.nextSeg = -1;
        this.nextReady = false;
        this.emit('nextrejected', { reason: m.reason });
        return;
      case 'keyframes':
        if (m.gen !== this.gen || !this.renderer) return;
        try {
          this.renderer.pushKeyframes(m.blockStartFrame, m.keyframes);
        } catch (e) {
          this.log('The spatial renderer rejected keyframes', (e as Error).message);
        }
        this.emit('keyframes', { blockStartFrame: m.blockStartFrame, count: m.keyframes.length });
        return;
      default:
        return;
    }
  }

  private onWorklet(m: FromWorklet): void {
    switch (m.t) {
      case 'pos': {
        if (m.gen !== this.gen) return;
        if (m.seg !== this.seg) return; /* the 'segment' message switches first */
        this.pos = { gen: m.gen, media: m.media, time: m.time, playing: m.playing, stream: m.stream };
        this.queued = m.queued;
        if (this.renderer) {
          try {
            this.renderer.setPlayedFrame(m.stream);
          } catch {
            /* the add-on's problem */
          }
        }
        const now = performance.now();
        if (!this._paused && now - this.lastTimeupdate >= TIMEUPDATE_MS) {
          this.lastTimeupdate = now;
          this.emit('timeupdate');
        }
        return;
      }
      case 'started':
        if (m.gen !== this.gen) return;
        this.startedGen = m.gen;
        this.starving = false;
        if (!this._paused) this.emit('playing');
        return;
      case 'underrun':
        if (m.gen !== this.gen || this._paused) return;
        this.floor = Math.max(this.floor, this.lastReturned);
        this.starving = true;
        this.emit('waiting');
        return;
      case 'resumed':
        if (m.gen !== this.gen) return;
        this.starving = false;
        if (!this._paused) this.emit('playing');
        return;
      case 'segment': {
        if (m.gen !== this.gen) return;
        if (m.seg !== this.nextSeg) {
          /* A splice we cancelled raced the boundary: stop here, as an end. */
          this.onEnded();
          return;
        }
        const info = this.infoBySeg.get(m.seg) || this.info;
        this.seg = m.seg;
        this.src = this.srcBySeg.get(m.seg) || this.src;
        this.info = info;
        this.nextSeg = -1;
        this.nextReady = false;
        this.floor = 0;
        this.lastReturned = 0;
        this.pos = { gen: this.gen, media: 0, time: this.ctx ? this.ctx.currentTime : 0, playing: true, stream: m.stream };
        this.emit('segment', { seg: m.seg, source: this.src });
        this.emit('durationchange');
        this.emit('timeupdate');
        return;
      }
      case 'ended':
        if (m.gen !== this.gen || m.seg !== this.seg) return;
        this.onEnded();
        return;
      case 'tap':
        if (this.tapFn) this.tapFn(m.stream, m.planes, m.media);
        return;
    }
  }

  private onEnded(): void {
    if (this._ended) return;
    this._ended = true;
    const wasPlaying = !this._paused;
    this._paused = true;
    if (this.info) {
      this.floor = this.info.duration;
      this.lastReturned = this.info.duration;
      this.pos = { gen: this.gen, media: this.info.frames, time: 0, playing: false, stream: this.pos.stream };
    }
    this.toWorklet({ t: 'pause' });
    this.emit('timeupdate');
    if (wasPlaying) this.emit('pause');
    this.emit('ended');
    this.scheduleSuspend();
  }

  /* ---------- tails, taps, teardown ---------- */

  /** Linear fade of this instance's output to silence over `seconds`,
      then disposal. Used by crossfade tails. */
  fadeOutAndDispose(seconds: number): void {
    const ctx = this.ctx;
    if (this.gain && ctx) {
      const g = this.gain.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(this._muted ? 0 : this._volume, now);
      g.linearRampToValueAtTime(0, now + Math.max(0.05, seconds));
    }
    setTimeout(() => this.dispose(), Math.max(50, seconds * 1000) + 150);
  }

  /** Dev/test: receive every rendered block (planar copies). */
  setTap(fn: ((stream: number, planes: Float32Array[], media: number) => void) | null): void {
    this.tapFn = fn;
    this.toWorklet({ t: 'tap', on: !!fn });
  }

  /** Dev/test: the output node (after volume) and its context, for level
      measurement. */
  debugOutput(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx && this.gain ? { ctx: this.ctx, node: this.gain } : null;
  }

  /** Dev/test: internal state snapshot. */
  debugState(): Record<string, unknown> {
    return {
      role: this.role,
      gen: this.gen,
      seg: this.seg,
      nextSeg: this.nextSeg,
      nextReady: this.nextReady,
      opened: this.opened,
      paused: this._paused,
      ended: this._ended,
      starving: this.starving,
      pos: { ...this.pos },
      ctxState: this.ctx ? this.ctx.state : 'none',
      ctxRate: this.ctx ? this.ctx.sampleRate : 0,
      nodeChannels: this.nodeChannels,
      destinationChannels: this.ctx ? this.ctx.destination.channelCount : 0,
      info: this.info,
      spatial: !!this.renderer,
      gain: this.gain ? this.gain.gain.value : null,
      queuedFrames: this.queued,
      latency: this.latency(),
    };
  }

  dispose(): void {
    this.settlePlay(Object.assign(new Error('disposed'), { name: 'AbortError' }));
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.teardownGraph();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* already gone */
      }
    }
    this.worker = null;
    this.src = null;
    this.info = null;
  }
}

/* ---------- waveform peaks, on a short-lived worker ---------- */

let peaksSeq = 0;

/** Sparse-decodes packets across the file in a Worker and returns the
    existing peaks format's pairs, or null when this file can't be measured
    (the silent stub, an unsupported codec). */
export function generateEnginePeaks(
  src: EngineSource,
  buckets: number,
  onProgress?: (fraction: number) => void,
  opts?: { allowWebCodecs?: boolean; devCodecs?: boolean }
): Promise<{ duration: number; pairs: number[] } | null> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = createDecodeWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++peaksSeq;
    const done = (fn: () => void): void => {
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
      fn();
    };
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as FromWorker;
      if (m.t === 'peaksProgress' && m.id === id) {
        if (onProgress) onProgress(m.fraction);
      } else if (m.t === 'peaks' && m.id === id) {
        done(() => resolve(m.data));
      }
    };
    w.onerror = (e: ErrorEvent) => done(() => reject(new Error(e.message || 'peaks worker failed')));
    const init: ToWorker = {
      t: 'init',
      wasm: decoderWasmUrl(),
      port: null,
      allowWebCodecs: !opts || opts.allowWebCodecs !== false,
      devCodecs: !!(opts && opts.devCodecs),
    };
    w.postMessage(init);
    const job: ToWorker = { t: 'peaks', id, src, buckets };
    w.postMessage(job);
  });
}
