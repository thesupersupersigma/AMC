/* The scratch voice's AudioWorklet processor: a read head over decoded
   windows of the record that moves at whatever signed speed the hand
   gives it — forwards, backwards, stopped — with the pitch following, as
   a stylus in a groove does.

   Modes:
     hand   — the head follows the hand's path. The pointer arrives in
              uneven steps (coalesced events, ~1 px apart), and following
              each step would shake the pitch dozens of times a second — a
              buzz no real record makes. So the path is replayed a few ms
              late (interpolated between samples, never extrapolated), and
              the head is tied to it by a critically damped spring: the
              record's weight. Speed then glides the way a real platter's
              does, and the head always ends exactly where the hand is.
     motor  — let go on a running deck: the rate eases to the turntable's
              speed (the motor taking the record back)
     coast  — let go on a stopped deck: the rate decays to zero (mat drag)
     idle   — silent

   Level follows stylus speed (a magnetic cartridge's output is
   proportional to it), so a still record is silent and a slow drag is
   quiet and dark; a DC blocker keeps a held sample from thumping.

   Fast spins read from pre-filtered half / quarter / eighth-rate copies
   of each window (built by the voice, ./voice.ts), blended by speed, so
   the treble that would fold back as grit is already gone — the record
   just sounds higher, as a real one does.

   Like the engine's worklet (see soft/worklet.ts), everything lives inside
   scratchMain(): it is serialised with Function.prototype.toString and
   loaded from a Blob URL, so it must not reference anything outside itself
   and declares no class fields. */

function scratchMain(): void {
  interface Level {
    rate: number;
    l: Float32Array;
    r: Float32Array;
    len: number;
  }
  interface Seg {
    id: number;
    /** Source second of sample 0. */
    start: number;
    /** levels[k]: the window at rate / 2^k, low-passed for it. */
    levels: Level[];
    rate: number;
    len: number;
  }
  interface St {
    port: MessagePort;
    segs: Seg[];
    last: Seg | null;
    mode: string;
    /** Head position, source seconds; velocity, source seconds per second. */
    pos: number;
    vel: number;
    /** The hand's path: [context time, position] pairs, oldest first. */
    path: number[];
    /** How late the path is replayed (seconds). */
    lag: number;
    motor: number;
    limit: number;
    gain: number;
    gainTarget: number;
    gainTau: number;
    volume: number;
    /** A jump's crossfade: the old head keeps playing out under the new. */
    xPos: number;
    xLeft: number;
    hpL: number;
    hpR: number;
    hpXL: number;
    hpXR: number;
    quanta: number;
    have: boolean;
    out: Float32Array;
  }
  interface Msg {
    t: string;
    id?: number;
    start?: number;
    rate?: number;
    l?: Float32Array;
    r?: Float32Array;
    pos?: number;
    pts?: number[];
    levels?: Float32Array[][];
    ms?: number;
    v?: number;
  }
  const scope = globalThis as unknown as {
    AudioWorkletProcessor: { new (): { port: MessagePort } };
    registerProcessor: (name: string, ctor: unknown) => void;
    sampleRate: number;
    currentTime: number;
  };

  const XFADE = 256;
  const MAX_VEL = 12;
  /** How late the hand's path is replayed, at least: longer than the gap
      between pointer events, so the head never runs past the last known
      point. Grows to how late the points actually arrive (st.lag). */
  const LAG = 0.025;
  /** The record's weight: spring stiffness (rad/s) of the head's tie to
      the hand. ~10 Hz: follows any real hand movement, irons out the
      pointer's steps (stiffer lets the buzz back in on a slow drag). */
  const W = 60;
  const PATH_MAX = 512;
  /** The path is averaged over this span before the spring follows it:
      each pointer step is a whole pixel, which at a slow drag is a large
      fraction of the movement. */
  const SMOOTH = 0.02;

  /** Cubic (Catmull-Rom) read of the record at source second p into
      st.out[0..1]; false where no decoded window covers p. */
  function read(st: St, p: number, lev: number): boolean {
    let s = st.last;
    if (!s || p < s.start || p >= s.start + (s.len - 3) / s.rate) {
      s = null;
      for (let k = 0; k < st.segs.length; k++) {
        const g = st.segs[k];
        if (p >= g.start + 1 / g.rate && p < g.start + (g.len - 3) / g.rate) {
          s = g;
          break;
        }
      }
      st.last = s;
    }
    if (!s) {
      st.out[0] = 0;
      st.out[1] = 0;
      return false;
    }
    const L = s.levels[Math.min(lev, s.levels.length - 1)];
    const x = (p - s.start) * L.rate;
    const i = Math.max(1, Math.min(L.len - 3, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - i));
    for (let c = 0; c < 2; c++) {
      const a = c === 0 ? L.l : L.r;
      const y0 = a[i - 1];
      const y1 = a[i];
      const y2 = a[i + 1];
      const y3 = a[i + 2];
      const c1 = 0.5 * (y2 - y0);
      const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
      const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      st.out[c] = ((c3 * f + c2) * f + c1) * f + y1;
    }
    return true;
  }

  /** Where the hand was at context time t (held at either end). */
  function handAt(st: St, t: number): number {
    const p = st.path;
    const n = p.length;
    if (!n) return st.pos;
    if (t <= p[0]) return p[1];
    if (t >= p[n - 2]) return p[n - 1];
    let k = n - 4;
    while (k > 0 && p[k] > t) k -= 2;
    const t0 = p[k];
    const t1 = p[k + 2];
    return t1 > t0 ? p[k + 1] + ((p[k + 3] - p[k + 1]) * (t - t0)) / (t1 - t0) : p[k + 3];
  }

  /** The hand's position at t, averaged over the SMOOTH span ending
      there. */
  function handSmooth(st: St, t: number): number {
    let acc = 0;
    for (let k = 0; k < 8; k++) acc += handAt(st, t - (SMOOTH * (k + 0.5)) / 8);
    return acc / 8;
  }

  /** Starts a new path at the head's own position. */
  function seedPath(st: St): void {
    st.path = [scope.currentTime - st.lag, st.pos];
  }

  function onMsg(st: St, m: Msg): void {
    if (m.t === 'seg' && m.levels && m.levels.length) {
      const base = m.rate || scope.sampleRate;
      const levels = m.levels.map((pl, k) => ({ rate: base / Math.pow(2, k), l: pl[0], r: pl[1], len: pl[0].length }));
      st.segs.push({ id: m.id || 0, start: m.start || 0, levels, rate: base, len: levels[0].len });
    } else if (m.t === 'drop') {
      st.segs = st.segs.filter((s) => s.id !== m.id);
      st.last = null;
    } else if (m.t === 'clear') {
      st.segs = [];
      st.last = null;
    } else if (m.t === 'grab') {
      st.mode = 'hand';
      st.pos = m.pos || 0;
      st.vel = 0;
      seedPath(st);
      st.gainTarget = 1;
      st.gainTau = 0.004;
      st.xLeft = 0;
    } else if (m.t === 'hand' && m.pts) {
      /* (also a hand catching the record again while it fades or coasts:
         the path starts afresh from where the record is) */
      if (st.mode !== 'hand') seedPath(st);
      st.mode = 'hand';
      st.gainTarget = 1;
      st.gainTau = 0.004;
      const p = st.path;
      for (let k = 0; k + 1 < m.pts.length; k += 2) {
        /* time only moves forward */
        if (p.length && m.pts[k] <= p[p.length - 2]) continue;
        p.push(m.pts[k], m.pts[k + 1]);
      }
      if (p.length > PATH_MAX) p.splice(0, p.length - PATH_MAX);
      /* the newest point should still be ahead of the replay when the
         next batch lands (~one frame later): ease the lag toward that */
      const want = Math.max(LAG, Math.min(0.12, scope.currentTime - p[p.length - 2] + 0.02));
      st.lag += (want - st.lag) * (want > st.lag ? 0.3 : 0.03);
    } else if (m.t === 'motor') {
      st.mode = 'motor';
      st.motor = m.rate || 1;
    } else if (m.t === 'coast') {
      st.mode = 'coast';
    } else if (m.t === 'fade') {
      st.gainTarget = 0;
      st.gainTau = Math.max(0.001, (m.ms || 20) / 3000);
    } else if (m.t === 'jump') {
      st.xPos = st.pos;
      st.xLeft = XFADE;
      st.pos = m.pos || 0;
    } else if (m.t === 'vol') {
      st.volume = m.v || 0;
    } else if (m.t === 'limit') {
      st.limit = m.v || 0;
    }
  }

  function render(st: St, out: Float32Array[]): boolean {
    const L = out[0];
    if (!L) return true;
    const R = out[1] || L;
    const n = L.length;
    const sr = scope.sampleRate;
    if (st.mode === 'idle') {
      L.fill(0);
      if (R !== L) R.fill(0);
      return true;
    }
    const hand = st.mode === 'hand';
    /* the hand's (late) position at the start and end of this quantum */
    const h0 = hand ? handSmooth(st, scope.currentTime - st.lag) : 0;
    const h1 = hand ? handSmooth(st, scope.currentTime - st.lag + n / sr) : 0;
    /* off the hand: the motor eases it to speed, or the mat drags it to
       a stop */
    const motor = st.mode === 'motor';
    const target = motor ? Math.max(-MAX_VEL, Math.min(MAX_VEL, st.motor)) : 0;
    const tau = motor ? 0.09 : 0.12;
    const a = 1 - Math.exp(-1 / (sr * tau));
    const ga = 1 - Math.exp(-1 / (sr * st.gainTau));
    const hp = 1 - (2 * Math.PI * 20) / sr;
    let have = false;
    for (let i = 0; i < n; i++) {
      if (hand) {
        /* the spring: critically damped, so no overshoot or wobble */
        const h = h0 + ((h1 - h0) * i) / n;
        st.vel += (W * W * (h - st.pos) - 2 * W * st.vel) / sr;
        st.vel = Math.max(-MAX_VEL, Math.min(MAX_VEL, st.vel));
      } else {
        st.vel += (target - st.vel) * a;
      }
      st.pos += st.vel / sr;
      if (st.pos < 0 || (st.limit > 0 && st.pos > st.limit)) {
        st.pos = Math.max(0, st.limit > 0 ? Math.min(st.limit, st.pos) : st.pos);
        st.vel = 0;
      }
      /* fast: blend the two pre-filtered copies around this speed */
      const lv = Math.log2(Math.max(1, Math.abs(st.vel)));
      const k0 = Math.floor(lv);
      const kf = lv - k0;
      if (read(st, st.pos, k0)) have = true;
      let l = st.out[0];
      let r = st.out[1];
      if (kf > 0.001) {
        read(st, st.pos, k0 + 1);
        l += (st.out[0] - l) * kf;
        r += (st.out[1] - r) * kf;
      }
      if (st.xLeft > 0) {
        st.xPos += st.vel / sr;
        const g = st.xLeft / XFADE;
        read(st, st.xPos, k0);
        l = l * (1 - g) + st.out[0] * g;
        r = r * (1 - g) + st.out[1] * g;
        st.xLeft--;
      }
      /* DC blocker */
      const yl = l - st.hpXL + hp * st.hpL;
      const yr = r - st.hpXR + hp * st.hpR;
      st.hpXL = l;
      st.hpXR = r;
      st.hpL = yl;
      st.hpR = yr;
      st.gain += (st.gainTarget - st.gain) * ga;
      const speed = Math.min(1, Math.abs(st.vel) * 4);
      const g = st.gain * st.volume * speed;
      L[i] = yl * g;
      if (R !== L) R[i] = yr * g;
    }
    st.have = have;
    let report = ++st.quanta % 3 === 0;
    if (st.gainTarget === 0 && st.gain < 1e-4) {
      st.mode = 'idle';
      st.gain = 0;
      report = true;
    }
    if (report) st.port.postMessage({ t: 'pos', pos: st.pos, vel: st.vel, have: st.have, mode: st.mode, at: scope.currentTime });
    return true;
  }

  class AmcScratchProcessor extends scope.AudioWorkletProcessor {
    constructor() {
      super();
      const st: St = {
        port: this.port,
        segs: [],
        last: null,
        mode: 'idle',
        pos: 0,
        vel: 0,
        path: [],
        lag: LAG,
        motor: 1,
        limit: 0,
        gain: 0,
        gainTarget: 0,
        gainTau: 0.004,
        volume: 1,
        xPos: 0,
        xLeft: 0,
        hpL: 0,
        hpR: 0,
        hpXL: 0,
        hpXR: 0,
        quanta: 0,
        have: false,
        out: new Float32Array(2),
      };
      (this as unknown as { st: St }).st = st;
      this.port.onmessage = (e: MessageEvent) => onMsg(st, e.data as Msg);
    }
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return render((this as unknown as { st: St }).st, outputs[0] || []);
    }
  }

  scope.registerProcessor('amc-scratch', AmcScratchProcessor);
}

export const SCRATCH_PROCESSOR = 'amc-scratch';

/** Source text of the worklet module. */
export function scratchWorkletSource(): string {
  return '(' + scratchMain.toString() + ')();\n';
}
