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
   the moment they are played: memory is flat for any file length. */

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
  }
  type Msg = { t: string; [k: string]: unknown };

  const scope = globalThis as unknown as WorkletScope;

  function post(st: State, msg: object, transfer?: Transferable[]): void {
    try {
      st.port.postMessage(msg, transfer || []);
    } catch {
      /* main side gone */
    }
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
    } else if (m.t === 'play') {
      if (!st.playing) st.fadeIn = true;
      st.playing = true;
      st.pausing = false;
      st.forceReport = true;
    } else if (m.t === 'pause') {
      if (st.playing) st.pausing = true;
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
    });
    if (st.worker) {
      try {
        st.worker.postMessage({ t: 'level', gen: st.headGen, seg: st.headSeg, head: st.headStream });
      } catch {
        /* worker gone */
      }
    }
  }

  function render(st: State, out: Float32Array[]): boolean {
    const n = out.length ? out[0].length : 128;
    for (let c = 0; c < out.length; c++) out[c].fill(0);
    if (!st.alive) return false;
    if (!st.playing) {
      report(st, 0);
      return true;
    }
    let written = 0;
    while (written < n && st.q.length) {
      const c = st.q[0];
      if (c.gen !== st.gen) {
        st.q.shift();
        continue;
      }
      if (c.seg !== st.headSeg || c.gen !== st.headGen) {
        /* A new segment inside the SAME generation is a gapless splice. */
        if (st.headSeg >= 0 && c.gen === st.headGen && st.started === st.gen) {
          post(st, { t: 'segment', gen: c.gen, seg: c.seg, stream: c.stream + c.off });
        }
        st.headSeg = c.seg;
      }
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
      const planes = out.map((p) => p.slice(0, written));
      post(st, { t: 'tap', stream: st.headStream - written, media: st.headMedia - written, planes }, planes.map((p) => p.buffer));
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
