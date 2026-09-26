/* The engine's AudioWorklet processor: a queue of planar PCM chunks from
   the decode Worker, played out at the file's native channel count (6 for
   5.1 — Web Audio's 'speakers' interpretation downmixes to the device).

   Everything the processor needs lives inside workletMain(): the function
   is serialised with Function.prototype.toString and loaded from a Blob
   URL, so it works the same under Vite dev, the bundled build and the
   single-file build, with no bundler support for worklets. It must not
   reference anything outside itself, and it declares no class fields (a
   bundler lowering them would inject module-level helpers).

   It reports its read head ("played frames" — frames actually handed to
   the output) to the main thread, which derives currentTime from it, and
   to the Worker, which refills to keep ~2 s buffered. Chunks are dropped
   the moment they are played: memory is flat for any file length.

   Playback rate (the turntable speed, 16–78 RPM = 0.48×–2.34×, and its
   brake / spin-up ramps): varispeed, like vinyl — the pitch moves with the
   speed. The read head advances `rate` source frames per output frame and
   the output is interpolated with a 4-point cubic (Catmull-Rom) across
   chunk boundaries. A rate change ramps linearly across one render
   quantum, so the brake's ~16 ms steps never click. At exactly 1× the
   samples are copied untouched (bit-exact, as before). Every position the
   worklet reports stays in SOURCE frames, so currentTime is source time and
   spatial keyframes (stamped in source frames) stay in sync at any rate. */

function workletMain(): void {
  interface WorkletScope {
    AudioWorkletProcessor: { new (): { readonly port: MessagePort } };
    registerProcessor(name: string, ctor: unknown): void;
    currentTime: number;
    sampleRate: number;
  }
  interface Chunk {
    gen: number;
    seg: number;
    media: number;
    stream: number;
    frames: number;
    planes: Float32Array[];
    off: number;
  }
  interface State {
    port: MessagePort;
    worker: MessagePort | null;
    q: Chunk[];
    gen: number;
    playing: boolean;
    pausing: boolean;
    fadeIn: boolean;
    alive: boolean;
    headGen: number;
    headSeg: number;
    headMedia: number;
    headStream: number;
    started: number;
    starving: boolean;
    finalEos: Record<string, boolean>;
    endedFor: string;
    quanta: number;
    forceReport: boolean;
    tap: boolean;
    /** Rate at the start of the next quantum, and the rate it ramps to
        across that quantum. */
    rate: number;
    rateTarget: number;
    /** Read position past the head sample, in source frames (0 <= frac,
        normally < 1). */
    frac: number;
    /** Per channel: the sample just before the head (the cubic's x[-1]). */
    prev: Float32Array;
    /** `prev` holds real stream samples (false right after a flush). */
    prevValid: boolean;
    /** Resampler scratch: gathered source samples per channel, and each
        output sample's integer / fractional read position. */
    gather: Float32Array[];
    ipos: Int32Array;
    fpos: Float32Array;
    /** Source frames the last quantum consumed (for the dev tap). */
    consumed: number;
  }
  type Msg = { t: string; [k: string]: unknown };

  const scope = globalThis as unknown as WorkletScope;
  const MIN_RATE = 0.0625;
  const MAX_RATE = 4;

  function clampRate(v: unknown): number {
    const r = Number(v);
    if (!(r > 0) || !isFinite(r)) return 1;
    return Math.max(MIN_RATE, Math.min(MAX_RATE, r));
  }

  function post(st: State, msg: object, transfer?: Transferable[]): void {
    try {
      st.port.postMessage(msg, transfer || []);
    } catch {
      /* main side gone */
    }
  }

  /** A new stream position: the next sample read is exactly the head. */
  function restartRead(st: State): void {
    st.frac = 0;
    st.prevValid = false;
  }

  function onWorker(st: State, m: Msg): void {
    const gen = m.gen as number;
    if (gen < st.gen) return;
    if (gen > st.gen) {
      /* The worker answered a seek before the main thread's flush arrived. */
      st.gen = gen;
      st.q = st.q.filter((c) => c.gen >= gen);
      st.started = -1;
      st.starving = false;
      restartRead(st);
    }
    if (m.t === 'pcm') {
      st.q.push({
        gen,
        seg: m.seg as number,
        media: m.media as number,
        stream: m.stream as number,
        frames: m.frames as number,
        planes: m.planes as Float32Array[],
        off: 0,
      });
    } else if (m.t === 'eos') {
      st.finalEos[gen + ':' + (m.seg as number)] = !!m.final;
    } else if (m.t === 'drop') {
      st.q = st.q.filter((c) => !(c.gen === gen && c.seg === (m.seg as number)));
    }
  }

  function onMain(st: State, m: Msg): void {
    if (m.t === 'port') {
      if (st.worker) st.worker.close();
      st.worker = m.port as MessagePort;
      st.worker.onmessage = (e: MessageEvent) => onWorker(st, e.data as Msg);
    } else if (m.t === 'flush') {
      const gen = m.gen as number;
      if (gen > st.gen) st.gen = gen;
      st.q = st.q.filter((c) => c.gen >= st.gen);
      st.started = -1;
      st.starving = false;
      st.forceReport = true;
      restartRead(st);
    } else if (m.t === 'play') {
      if (!st.playing) st.fadeIn = true;
      st.playing = true;
      st.pausing = false;
      st.forceReport = true;
    } else if (m.t === 'pause') {
      if (st.playing) st.pausing = true;
    } else if (m.t === 'rate') {
      st.rateTarget = clampRate(m.rate);
      /* Nothing sounding: no ramp needed. */
      if (!st.playing) st.rate = st.rateTarget;
      st.forceReport = true;
    } else if (m.t === 'tap') {
      st.tap = !!m.on;
    } else if (m.t === 'dispose') {
      st.alive = false;
      st.q = [];
      if (st.worker) st.worker.close();
      st.worker = null;
    }
  }

  function report(st: State, written: number): void {
    st.quanta++;
    if (!st.forceReport && st.quanta % 8 !== 0) return;
    st.forceReport = false;
    let queued = 0;
    for (const c of st.q) if (c.gen === st.gen) queued += c.frames - c.off;
    post(st, {
      t: 'pos',
      queued,
      gen: st.headGen,
      seg: st.headSeg,
      media: st.headMedia,
      stream: st.headStream,
      time: scope.currentTime + written / scope.sampleRate,
      playing: st.playing && written > 0,
      rate: st.rate,
    });
    if (st.worker) {
      try {
        st.worker.postMessage({ t: 'level', gen: st.headGen, seg: st.headSeg, head: st.headStream, rate: st.rate });
      } catch {
        /* worker gone */
      }
    }
  }

  /** The head moves onto chunk c: a new segment inside the SAME generation
      is a gapless splice, which the main thread hears about. */
  function enterChunk(st: State, c: Chunk): void {
    if (c.seg !== st.headSeg || c.gen !== st.headGen) {
      if (st.headSeg >= 0 && c.gen === st.headGen && st.started === st.gen) {
        post(st, { t: 'segment', gen: c.gen, seg: c.seg, stream: c.stream + c.off });
      }
      st.headSeg = c.seg;
    }
  }

  /** 1×: copies the queue straight to the output. */
  function copyOut(st: State, out: Float32Array[], n: number): number {
    let written = 0;
    while (written < n && st.q.length) {
      const c = st.q[0];
      if (c.gen !== st.gen) {
        st.q.shift();
        continue;
      }
      enterChunk(st, c);
      const take = Math.min(n - written, c.frames - c.off);
      for (let ch = 0; ch < out.length; ch++) {
        const src = c.planes[ch];
        if (src) out[ch].set(src.subarray(c.off, c.off + take), written);
      }
      c.off += take;
      written += take;
      st.headGen = c.gen;
      st.headMedia = c.media + c.off;
      st.headStream = c.stream + c.off;
      if (c.off >= c.frames) st.q.shift();
    }
    if (written > 0) {
      for (let ch = 0; ch < out.length; ch++) st.prev[ch] = out[ch][written - 1];
      st.prevValid = true;
    }
    st.consumed = written;
    return written;
  }

  /** Copies up to `need` source frames from the head on into gather[ch][1…]
      without consuming them. Returns how many were there. */
  function gatherAhead(st: State, nch: number, need: number): number {
    while (st.q.length && st.q[0].gen !== st.gen) st.q.shift();
    let have = 0;
    for (let k = 0; k < st.q.length && have < need; k++) {
      const c = st.q[k];
      if (c.gen !== st.gen) break;
      const take = Math.min(need - have, c.frames - c.off);
      for (let ch = 0; ch < nch; ch++) {
        const src = c.planes[ch];
        const g = st.gather[ch];
        if (src) g.set(src.subarray(c.off, c.off + take), 1 + have);
        else g.fill(0, 1 + have, 1 + have + take);
      }
      have += take;
    }
    return have;
  }

  /** Advances the head by k source frames. */
  function consume(st: State, k: number): void {
    while (k > 0 && st.q.length) {
      const c = st.q[0];
      if (c.gen !== st.gen) {
        st.q.shift();
        continue;
      }
      enterChunk(st, c);
      const take = Math.min(k, c.frames - c.off);
      c.off += take;
      k -= take;
      st.headGen = c.gen;
      st.headMedia = c.media + c.off;
      st.headStream = c.stream + c.off;
      if (c.off >= c.frames) st.q.shift();
    }
  }

  /** Nothing more will arrive for what is queued (the track's last chunk). */
  function streamFinal(st: State): boolean {
    const last = st.q.length ? st.q[st.q.length - 1] : null;
    const seg = last && last.gen === st.gen ? last.seg : st.headSeg;
    return !!st.finalEos[st.gen + ':' + seg];
  }

  /** Any other rate: the read position advances r0 → r1 per output frame
      across the quantum; each output sample is the Catmull-Rom cubic
      through the four source samples around its position. */
  function resampleOut(st: State, out: Float32Array[], n: number, r0: number, r1: number): number {
    const nch = out.length;
    const dr = (r1 - r0) / n;
    /* Positions p_0 = frac, p_{i+1} = p_i + r0 + dr·(i+1); after n outputs
       the head has moved frac + n·r0 + dr·n(n+1)/2. The cubic at p needs
       x[⌊p⌋-1 … ⌊p⌋+2]. */
    const advance = n * r0 + (dr * n * (n + 1)) / 2;
    const need = Math.floor(st.frac + advance) + 3;
    if (!st.gather.length || st.gather[0].length < need + 1 || st.gather.length !== nch) {
      const size = Math.max(need + 1, 128 * 4 + 8);
      st.gather = [];
      for (let ch = 0; ch < nch; ch++) st.gather.push(new Float32Array(size));
    }
    if (st.ipos.length < n) {
      st.ipos = new Int32Array(n);
      st.fpos = new Float32Array(n);
    }
    const have = gatherAhead(st, nch, need);
    const final = have < need && streamFinal(st);
    for (let ch = 0; ch < nch; ch++) {
      const g = st.gather[ch];
      /* x[-1]: the sample before the head; after a flush, hold x[0]. */
      g[0] = st.prevValid ? st.prev[ch] : have > 0 ? g[1] : 0;
      /* At the very end of the stream the lookahead is silence. */
      if (final) g.fill(0, 1 + have, 1 + need);
    }
    /* Starving: stop where the cubic would run past the data; at the end
       of the stream, where the position leaves the data. */
    const limit = final ? have - 1 : have - 3;
    let p = st.frac;
    let written = 0;
    for (let i = 0; i < n; i++) {
      const ip = Math.floor(p);
      if (ip > limit) break;
      st.ipos[i] = ip;
      st.fpos[i] = p - ip;
      written++;
      p += r0 + dr * (i + 1);
    }
    const ipos = st.ipos;
    const fpos = st.fpos;
    for (let ch = 0; ch < nch; ch++) {
      const g = st.gather[ch];
      const o = out[ch];
      for (let i = 0; i < written; i++) {
        const k = ipos[i];
        const f = fpos[i];
        const xm1 = g[k];
        const x0 = g[k + 1];
        const x1 = g[k + 2];
        const x2 = g[k + 3];
        o[i] = x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
      }
    }
    let used = Math.floor(p);
    if (used > have) used = have;
    if (used > 0) {
      for (let ch = 0; ch < nch; ch++) st.prev[ch] = st.gather[ch][used];
      st.prevValid = true;
    }
    st.frac = p - used;
    consume(st, used);
    st.consumed = used;
    return written;
  }

  function render(st: State, out: Float32Array[]): boolean {
    const n = out.length ? out[0].length : 128;
    for (let c = 0; c < out.length; c++) out[c].fill(0);
    if (!st.alive) return false;
    if (!st.playing) {
      report(st, 0);
      return true;
    }
    if (st.prev.length !== out.length) {
      st.prev = new Float32Array(out.length);
      st.prevValid = false;
    }
    const r0 = st.rate;
    const r1 = st.rateTarget;
    const written = r0 === 1 && r1 === 1 && st.frac === 0 ? copyOut(st, out, n) : resampleOut(st, out, n, r0, r1);
    /* Back at 1× with the read position between samples: crossfade over
       this quantum from the interpolated signal to the source samples
       themselves (a sub-sample shift, so no click), then copy untouched
       from the next quantum on. */
    if (r0 === 1 && r1 === 1 && st.frac > 0 && st.frac < 1 && written === n && st.consumed === n) {
      for (let ch = 0; ch < out.length; ch++) {
        const g = st.gather[ch];
        const o = out[ch];
        for (let i = 0; i < n; i++) o[i] += ((i + 1) / n) * (g[1 + i] - o[i]);
      }
      st.frac = 0;
    }
    st.rate = r1;
    /* Click-free edges: a one-quantum ramp in after play, out on pause. */
    if (st.fadeIn || st.pausing) {
      for (let i = 0; i < written; i++) {
        const g = st.pausing ? 1 - (i + 1) / written : (i + 1) / written;
        for (let ch = 0; ch < out.length; ch++) out[ch][i] *= g;
      }
      if (written > 0) st.fadeIn = false;
      if (st.pausing) {
        st.pausing = false;
        st.playing = false;
        st.forceReport = true;
      }
    }
    if (written > 0 && st.started !== st.gen) {
      st.started = st.gen;
      st.starving = false;
      st.forceReport = true;
      post(st, { t: 'started', gen: st.gen, seg: st.headSeg });
    }
    if (written < n && st.started === st.gen && st.playing) {
      const key = st.gen + ':' + st.headSeg;
      if (st.finalEos[key] && !st.q.length) {
        if (st.endedFor !== key) {
          st.endedFor = key;
          st.playing = false;
          st.forceReport = true;
          post(st, { t: 'ended', gen: st.gen, seg: st.headSeg });
        }
      } else if (!st.starving) {
        st.starving = true;
        st.forceReport = true;
        post(st, { t: 'underrun', gen: st.gen });
      }
    } else if (written === n && st.starving) {
      st.starving = false;
      post(st, { t: 'resumed', gen: st.gen });
    }
    if (st.tap && written > 0) {
      /* Where this quantum's first output was read (exact at 1×). */
      const planes = out.map((p) => p.slice(0, written));
      post(st, { t: 'tap', stream: st.headStream - st.consumed, media: st.headMedia - st.consumed, planes }, planes.map((p) => p.buffer));
    }
    report(st, written);
    return true;
  }

  class AmcEngineProcessor extends scope.AudioWorkletProcessor {
    constructor() {
      super();
      const st: State = {
        port: this.port,
        worker: null,
        q: [],
        gen: 0,
        playing: false,
        pausing: false,
        fadeIn: false,
        alive: true,
        headGen: 0,
        headSeg: -1,
        headMedia: 0,
        headStream: 0,
        started: -1,
        starving: false,
        finalEos: {},
        endedFor: '',
        quanta: 0,
        forceReport: false,
        tap: false,
        rate: 1,
        rateTarget: 1,
        frac: 0,
        prev: new Float32Array(0),
        prevValid: false,
        gather: [],
        ipos: new Int32Array(0),
        fpos: new Float32Array(0),
        consumed: 0,
      };
      (this as unknown as { st: State }).st = st;
      this.port.onmessage = (e: MessageEvent) => onMain(st, e.data as Msg);
    }
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return render((this as unknown as { st: State }).st, outputs[0] || []);
    }
  }

  scope.registerProcessor('amc-engine', AmcEngineProcessor);
}

export const WORKLET_PROCESSOR = 'amc-engine';

/** Source text of the worklet module. */
export function workletSource(): string {
  return '(' + workletMain.toString() + ')();\n';
}
