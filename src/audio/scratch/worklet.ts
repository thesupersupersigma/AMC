/* The scratch voice's AudioWorklet processor: a read head over decoded
   windows of the record that moves at whatever signed speed the hand
   gives it — forwards, backwards, stopped — with the pitch following, as
   a stylus in a groove does.

   Modes:
     hand   — the head chases the hand: rate = hand velocity + a pull
              toward the hand's position, so it stays locked to the record
              under the fingers without drifting
     motor  — let go on a running deck: the rate eases to the turntable's
              speed (the motor taking the record back)
     coast  — let go on a stopped deck: the rate decays to zero (mat drag)
     idle   — silent

   Level follows stylus speed (a magnetic cartridge's output is
   proportional to it), so a still record is silent and a slow drag is
   quiet and dark; a DC blocker keeps a held sample from thumping.

   Like the engine's worklet (see soft/worklet.ts), everything lives inside
   scratchMain(): it is serialised with Function.prototype.toString and
   loaded from a Blob URL, so it must not reference anything outside itself
   and declares no class fields. */

function scratchMain(): void {
  interface Seg {
    id: number;
    /** Source second of sample 0. */
    start: number;
    rate: number;
    l: Float32Array;
    r: Float32Array;
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
    handPos: number;
    handVel: number;
    handAt: number;
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
    vel?: number;
    at?: number;
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
  /** Pull toward the hand's position, per second of error. */
  const PULL = 24;

  /** Cubic (Catmull-Rom) read of the record at source second p into
      st.out[0..1]; false where no decoded window covers p. */
  function read(st: St, p: number): boolean {
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
    const x = (p - s.start) * s.rate;
    const i = Math.floor(x);
    const f = x - i;
    for (let c = 0; c < 2; c++) {
      const a = c === 0 ? s.l : s.r;
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

  function onMsg(st: St, m: Msg): void {
    if (m.t === 'seg' && m.l && m.r) {
      st.segs.push({ id: m.id || 0, start: m.start || 0, rate: m.rate || scope.sampleRate, l: m.l, r: m.r, len: m.l.length });
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
      st.handPos = st.pos;
      st.handVel = 0;
      st.handAt = scope.currentTime;
      st.gainTarget = 1;
      st.gainTau = 0.004;
      st.xLeft = 0;
    } else if (m.t === 'hand') {
      /* (also a hand catching the record again while it fades or coasts) */
      st.mode = 'hand';
      st.gainTarget = 1;
      st.gainTau = 0.004;
      st.handPos = m.pos || 0;
      st.handVel = m.vel || 0;
      st.handAt = m.at || scope.currentTime;
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
    let target: number;
    let tau: number;
    if (st.mode === 'hand') {
      const age = Math.max(0, Math.min(0.025, scope.currentTime - st.handAt));
      const handNow = st.handPos + st.handVel * age;
      target = st.handVel + (handNow - st.pos) * PULL;
      tau = 0.006;
    } else if (st.mode === 'motor') {
      target = st.motor;
      tau = 0.09;
    } else {
      target = 0;
      tau = 0.12;
    }
    target = Math.max(-MAX_VEL, Math.min(MAX_VEL, target));
    const a = 1 - Math.exp(-1 / (sr * tau));
    const ga = 1 - Math.exp(-1 / (sr * st.gainTau));
    const hp = 1 - (2 * Math.PI * 20) / sr;
    let have = false;
    for (let i = 0; i < n; i++) {
      st.vel += (target - st.vel) * a;
      st.pos += st.vel / sr;
      if (st.pos < 0 || (st.limit > 0 && st.pos > st.limit)) {
        st.pos = Math.max(0, st.limit > 0 ? Math.min(st.limit, st.pos) : st.pos);
        st.vel = 0;
      }
      if (read(st, st.pos)) have = true;
      let l = st.out[0];
      let r = st.out[1];
      if (st.xLeft > 0) {
        st.xPos += st.vel / sr;
        const g = st.xLeft / XFADE;
        read(st, st.xPos);
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
        handPos: 0,
        handVel: 0,
        handAt: 0,
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
