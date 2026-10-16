/* The scratch voice: what you hear while your hand is on the record.

   Its own small AudioContext and worklet (./worklet.ts), fed with decoded
   windows of the current file (./window.ts) in BLOCK-second pieces around
   wherever the hand is. The main playback (the `media` facade) is left
   alone here — ui/turntable/scratch.ts quietens it while the voice plays
   and hands back to it on release.

   The context is created on the first hover or grab and suspended after a
   while unused, so an idle deck costs no audio thread time. */

import { logErr } from '../../ui/log';
import { openWindowSource, type WindowSource } from './window';
import { SCRATCH_PROCESSOR, scratchWorkletSource } from './worklet';

const BLOCK = 6;
/** Blocks kept loaded on each side of the hand. */
const AHEAD = 1;
const KEEP_SEC = 24;
const IDLE_SUSPEND_MS = 15000;

interface Block {
  id: number;
  k: number;
  /** Covered span once decoded (null while loading or failed). */
  from: number;
  to: number;
  ready: boolean;
  failed: boolean;
}

let workletUrl = '';
async function addModule(ctx: AudioContext): Promise<void> {
  if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([scratchWorkletSource()], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (first) {
    /* file:// single-file build: Blob-URL worklets are refused there */
    try {
      await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(scratchWorkletSource()));
    } catch {
      throw first;
    }
  }
}

export class ScratchVoice {
  readonly ctx: AudioContext;
  private node: AudioWorkletNode;
  private fileKey = '';
  private file: File | null = null;
  private source: Promise<WindowSource | null> | null = null;
  private sourceKind: WindowSource['kind'] | 'none' | '' = '';
  private blocks = new Map<number, Block>();
  private nextId = 1;
  private loading = false;
  private wanted: number[] = [];
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private loggedFor = '';
  /** Latest head report from the worklet. */
  private rep = { pos: 0, vel: 0, have: false, mode: 'idle', t: 0 };

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { t: string; pos: number; vel: number; have: boolean; mode: string };
      if (m.t === 'pos') this.rep = { pos: m.pos, vel: m.vel, have: m.have, mode: m.mode, t: performance.now() };
    };
  }

  static async create(): Promise<ScratchVoice> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await addModule(ctx);
    const node = new AudioWorkletNode(ctx, SCRATCH_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    return new ScratchVoice(ctx, node);
  }

  private post(m: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.node.port.postMessage(m, transfer);
  }

  /** Points the voice at a file (identity: folderId + path). A different
      file drops every decoded window. */
  prepare(key: string, file: File, duration: number): void {
    this.post({ t: 'limit', v: duration > 0 ? duration - 0.02 : 0 });
    if (key === this.fileKey && this.file === file) return;
    this.fileKey = key;
    this.file = file;
    this.blocks.clear();
    this.wanted = [];
    this.post({ t: 'clear' });
    this.sourceKind = '';
    const ctx = this.ctx;
    this.source = openWindowSource(file, duration, ctx)
      .catch((e: unknown) => {
        this.logOnce('Cannot read ' + file.name + ' for scratching', (e as Error).message || String(e));
        return null;
      })
      .then((s) => {
        if (this.file === file) this.sourceKind = s ? s.kind : 'none';
        return s;
      });
  }

  /** '' while the file is still being looked at; 'none' when its middle
      cannot be decoded here. */
  kind(): WindowSource['kind'] | 'none' | '' {
    return this.sourceKind;
  }

  /** Decoded audio covers source second `sec`. */
  covers(sec: number): boolean {
    for (const b of this.blocks.values()) if (b.ready && sec >= b.from + 0.05 && sec <= b.to - 0.05) return true;
    return false;
  }

  /** Makes sure the blocks around `sec` are loaded or loading, nearest
      first; drops the far ones. */
  ensure(sec: number): void {
    if (!this.file || this.sourceKind === 'none') return;
    const k = Math.floor(sec / BLOCK);
    const want: number[] = [k];
    const frac = sec / BLOCK - k;
    /* the side the hand is nearer to first */
    for (let d = 1; d <= AHEAD; d++) {
      if (frac < 0.5) want.push(k - d, k + d);
      else want.push(k + d, k - d);
    }
    this.wanted = want.filter((x) => x >= 0 && !this.blocks.has(x));
    for (const [bk, b] of this.blocks) {
      if (Math.abs((bk + 0.5) * BLOCK - sec) > KEEP_SEC && !this.loadingBlock(b)) {
        this.blocks.delete(bk);
        this.post({ t: 'drop', id: b.id });
      }
    }
    void this.pump();
  }

  private loadingBlock(b: Block): boolean {
    return !b.ready && !b.failed;
  }

  private async pump(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      while (this.wanted.length) {
        const k = this.wanted.shift() as number;
        if (this.blocks.has(k)) continue;
        const file = this.file;
        const src = await this.source;
        if (!src || file !== this.file) break;
        const b: Block = { id: this.nextId++, k, from: 0, to: 0, ready: false, failed: false };
        this.blocks.set(k, b);
        try {
          /* overlap the neighbours a little, so the seam is always covered */
          const w = await src.decode(Math.max(0, k * BLOCK - 0.4), (k + 1) * BLOCK + 0.4);
          if (file !== this.file || this.blocks.get(k) !== b) continue;
          if (!w || !w.planes.length || !w.planes[0].length) {
            b.failed = true;
            continue;
          }
          const l = new Float32Array(w.planes[0]);
          const r = new Float32Array(w.planes[1] || w.planes[0]);
          const frames = l.length;
          const levels = await buildLevels(l, r);
          if (file !== this.file || this.blocks.get(k) !== b) continue;
          if (!levels.length) {
            this.blocks.delete(k);
            continue;
          }
          b.from = w.start;
          b.to = w.start + frames / w.rate;
          b.ready = true;
          this.post(
            { t: 'seg', id: b.id, start: w.start, rate: w.rate, levels },
            levels.flatMap((pl) => [pl[0].buffer, pl[1].buffer])
          );
        } catch (e) {
          b.failed = true;
          this.logOnce('Scratch decode failed in ' + (file ? file.name : '?'), (e as Error).message || String(e));
        }
      }
    } finally {
      this.loading = false;
    }
  }

  private logOnce(msg: string, detail: string): void {
    if (this.loggedFor === this.fileKey) return;
    this.loggedFor = this.fileKey;
    logErr('turntable', msg, detail);
  }

  /* ---------- the head ---------- */

  async wake(): Promise<void> {
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* no gesture yet: the grab resumes it */
      }
    }
  }

  /** Lets the context sleep once nothing has played for a while. */
  idleSoon(): void {
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (this.rep.mode !== 'idle') return;
      void this.ctx.suspend().catch(() => {});
      /* and let the decoded windows go; a hover decodes them again */
      this.blocks.clear();
      this.wanted = [];
      this.post({ t: 'clear' });
    }, IDLE_SUSPEND_MS);
  }

  setVolume(v: number): void {
    this.post({ t: 'vol', v });
  }
  grab(pos: number): void {
    this.rep = { pos, vel: 0, have: this.covers(pos), mode: 'hand', t: performance.now() };
    this.post({ t: 'grab', pos });
  }
  /** The hand's path since the last call: [performance.now() ms,
      position] pairs, stamped onto the audio clock. */
  hand(pts: number[]): void {
    if (!pts.length) return;
    const off = this.clockOffset();
    const out = new Array<number>(pts.length);
    for (let k = 0; k + 1 < pts.length; k += 2) {
      out[k] = pts[k] / 1000 + off;
      out[k + 1] = pts[k + 1];
    }
    this.post({ t: 'hand', pts: out });
  }

  /** Context time minus performance time (seconds). currentTime moves in
      render-quantum steps, which would jitter the hand's path, so the
      offset only eases (and snaps after a suspend, when the audio clock
      stood still). The worklet measures how late the points arrive on its
      own clock and replays the path that much later. */
  private offset = NaN;
  private clockOffset(): number {
    const o = this.ctx.currentTime - performance.now() / 1000;
    if (!isFinite(this.offset) || Math.abs(o - this.offset) > 0.05) this.offset = o;
    else this.offset += (o - this.offset) * 0.05;
    return this.offset;
  }
  motor(rate: number): void {
    this.post({ t: 'motor', rate });
  }
  coast(): void {
    this.post({ t: 'coast' });
  }
  jump(pos: number): void {
    this.rep.pos = pos;
    this.rep.t = performance.now();
    this.post({ t: 'jump', pos });
  }
  fade(ms: number): void {
    this.post({ t: 'fade', ms });
  }

  /** Where the head is now (the last report, carried forward). */
  posNow(): number {
    const r = this.rep;
    return r.pos + (r.vel * Math.min(100, performance.now() - r.t)) / 1000;
  }
  velNow(): number {
    return this.rep.vel;
  }
  /** Test / diagnostics: the head's last report, and the output node. */
  debug(): { pos: number; vel: number; have: boolean; mode: string; kind: string; node: AudioWorkletNode } {
    return { pos: this.rep.pos, vel: this.rep.vel, have: this.rep.have, mode: this.rep.mode, kind: this.sourceKind, node: this.node };
  }
}

/* ---------- pre-filtered copies for fast spins ----------
   Read at 2× and above, a window's treble would fold back down as grit.
   Each window also travels as half, quarter and eighth-rate copies,
   low-passed for their rate (windowed sinc, 31 taps), and the worklet
   reads the copy that suits the speed.

   Building them is ~20 M multiply-adds a window: on the main thread that
   froze the page for a few hundred ms on a fast spin (the record jumped
   under the hand), so it runs in a small Worker. mipLevels() is
   self-contained — it is serialised into the Worker's source — and is
   also the fallback where no Worker can start. */

function mipLevels(l: Float32Array, r: Float32Array): Float32Array[][] {
  const n = 31;
  const m = (n - 1) / 2;
  const fc = 0.22; /* of the input rate: just under the new Nyquist */
  const taps = new Float32Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const x = k - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const win = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
    taps[k] = sinc * win;
    sum += taps[k];
  }
  for (let k = 0; k < n; k++) taps[k] /= sum;
  const halve = (x: Float32Array): Float32Array => {
    const len = x.length;
    const out = new Float32Array(Math.ceil(len / 2));
    for (let j = 0; j < out.length; j++) {
      const c = 2 * j - m;
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const i = c + k;
        acc += taps[k] * x[i < 0 ? 0 : i >= len ? len - 1 : i];
      }
      out[j] = acc;
    }
    return out;
  };
  const levels: Float32Array[][] = [[l, r]];
  for (let k = 1; k <= 3; k++) {
    const [pl, pr] = levels[k - 1];
    if (pl.length < 64) break;
    levels.push([halve(pl), halve(pr)]);
  }
  return levels;
}

let mipWorker: Worker | null | undefined;
let mipSeq = 0;
const mipWaiting = new Map<number, (levels: Float32Array[][]) => void>();

function startMipWorker(): Worker | null {
  try {
    const src =
      'const mipLevels = (' + mipLevels.toString() + ');\n' +
      'onmessage = (e) => { const { id, l, r } = e.data; const levels = mipLevels(l, r);' +
      ' postMessage({ id, levels }, levels.flatMap((pl) => [pl[0].buffer, pl[1].buffer])); };\n';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { name: 'amc-scratch-mips' });
    w.onmessage = (e: MessageEvent) => {
      const { id, levels } = e.data as { id: number; levels: Float32Array[][] };
      const done = mipWaiting.get(id);
      mipWaiting.delete(id);
      if (done) done(levels);
    };
    w.onerror = () => {
      /* the windows in flight are lost (they were transferred): those
         blocks fail and are decoded again on the next approach */
      for (const done of mipWaiting.values()) done([]);
      mipWaiting.clear();
      mipWorker = null;
    };
    return w;
  } catch {
    return null;
  }
}

/** The window and its pre-filtered copies, built off the main thread. */
function buildLevels(l: Float32Array, r: Float32Array): Promise<Float32Array[][]> {
  if (mipWorker === undefined) mipWorker = startMipWorker();
  const w = mipWorker;
  if (!w) return Promise.resolve(mipLevels(l, r));
  return new Promise((resolve) => {
    const id = ++mipSeq;
    mipWaiting.set(id, resolve);
    w.postMessage({ id, l, r }, [l.buffer, r.buffer]);
  });
}

let voice: ScratchVoice | null = null;
let creating: Promise<ScratchVoice | null> | null = null;

/** The one scratch voice, created on first use; null where Web Audio
    worklets are unavailable. */
export function getVoice(): Promise<ScratchVoice | null> {
  if (voice) return Promise.resolve(voice);
  if (!creating) {
    creating = (typeof AudioWorkletNode === 'undefined' ? Promise.resolve(null) : ScratchVoice.create())
      .then((v) => {
        voice = v;
        return v;
      })
      .catch((e: unknown) => {
        logErr('turntable', 'The scratch voice could not start', (e as Error).message || String(e));
        return null;
      });
  }
  return creating;
}

export function voiceNow(): ScratchVoice | null {
  return voice;
}
