/* Runs inside headless Chromium (bundled by test/atmos/render.test.ts).
   Renders a synthetic object through the Atmos renderer in an
   OfflineAudioContext and returns measurements for Node to assert on.
   AMC-original test code. */

import { createAtmosRenderer } from '../../../src/audio/atmos/render';
import { bedLayoutFor } from '../../../src/audio/atmos/render/layouts';
import type { SpatialKeyframe, SpatialOutputMode, SpatialPosition, SpatialRenderer } from '../../../src/audio/spatial/contract';

const SR = 48000;
const OBJECTS = 16;
const BED = 1;
const QUANTUM = 128;

type Vec = [number, number, number];

interface Waypoint {
  t: number; // content seconds
  pos: Vec;
}

/** Content timeline of the moving object: left → right → overhead. */
const path: Waypoint[] = [
  { t: 0.0, pos: [-1, 0, 0.2] },
  { t: 0.5, pos: [-1, 0, 0.2] },
  { t: 1.5, pos: [1, 0, 0.2] },
  { t: 2.0, pos: [1, 0, 0.2] },
  { t: 3.0, pos: [0, 1, 0] },
  { t: 3.6, pos: [0, 1, 0] },
];

function positions(pos: Vec, gain = 0.8): SpatialPosition[] {
  const out: SpatialPosition[] = [];
  for (let o = 0; o < OBJECTS; o++) {
    out.push(o === 0 ? { x: pos[0], y: pos[1], z: pos[2], size: 0, gain } : { x: 0, y: 0, z: 1, size: 0, gain: 0 });
  }
  return out;
}

function noise(n: number, seed: number): Float32Array {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s / 4294967296 - 0.5) * 0.5;
  }
  return a;
}

interface RunOptions {
  mode: SpatialOutputMode;
  outChannels: number;
  seconds: number;
  /** Content seconds at which a Worklet underrun of `stall` seconds happens. */
  underrunAt?: number;
  stall?: number;
  /** [renderSeconds, mode] switches. */
  switches?: [number, SpatialOutputMode][];
  signal?: 'noise' | 'sine';
  staticPos?: Vec;
}

async function render(opt: RunOptions): Promise<{ channels: Float32Array[]; mode: string | null }> {
  const length = Math.round(opt.seconds * SR);
  const ctx = new OfflineAudioContext(opt.outChannels, length, SR);
  const renderer: SpatialRenderer = createAtmosRenderer(ctx as unknown as AudioContext, bedLayoutFor(BED), OBJECTS);
  renderer.setMode(opt.mode);

  // Source: the object signal on channel 1; the played-frame counter
  // (content frames) stops during the simulated underrun.
  const buf = ctx.createBuffer(BED + OBJECTS, length, SR);
  const stallStart = opt.underrunAt !== undefined ? Math.round(opt.underrunAt * SR) : Infinity;
  const stallLen = opt.stall ? Math.round(opt.stall * SR) : 0;
  const content = opt.signal === 'sine'
    ? Float32Array.from({ length }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR))
    : noise(length, 99);
  const ch = buf.getChannelData(1);
  for (let i = 0; i < length; i++) {
    if (i < stallStart) ch[i] = content[i];
    else if (i < stallStart + stallLen) ch[i] = 0;
    else ch[i] = content[i - stallLen];
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(renderer.input);
  renderer.output.connect(ctx.destination);

  // Keyframes arrive per 1536-frame block, 0.4 s ahead of playback, the way
  // the engine relays them from the Worker.
  const block = 1536;
  const blocks = Math.ceil(length / block);
  // Like the processor: the block where a ramp starts carries both its start
  // and its end keyframe (the end may lie in a later block).
  const kfFor = (b: number): SpatialKeyframe[] => {
    const out: SpatialKeyframe[] = [];
    path.forEach((w, i) => {
      const f = Math.round(w.t * SR);
      if (f < b * block || f >= (b + 1) * block) return;
      out.push({ frame: f - b * block, positions: positions(opt.staticPos ?? w.pos) });
      const next = path[i + 1];
      if (next) out.push({ frame: Math.round(next.t * SR) - b * block, positions: positions(opt.staticPos ?? next.pos) });
    });
    return out;
  };
  let pushed = 0;
  const pushUpTo = (contentFrame: number) => {
    while (pushed < blocks && pushed * block <= contentFrame + 0.4 * SR) {
      renderer.pushKeyframes(pushed * block, kfFor(pushed));
      pushed++;
    }
  };
  pushUpTo(0);
  renderer.setPlayedFrame(0);

  // Report the played frame every 40 quanta (~107 ms), like a Worklet
  // posting its position; handle mode switches at their times.
  const step = 40 * QUANTUM;
  for (let f = step; f < length; f += step) {
    const renderFrame = f;
    ctx.suspend(renderFrame / SR).then(() => {
      const played = renderFrame < stallStart ? renderFrame : Math.max(stallStart, renderFrame - stallLen);
      renderer.setPlayedFrame(played);
      pushUpTo(played);
      for (const [t, mode] of opt.switches ?? []) {
        if (Math.abs(t * SR - renderFrame) < step / 2) renderer.setMode(mode);
      }
      ctx.resume();
    });
  }
  src.start(0);
  const out = await ctx.startRendering();
  const mode = (renderer as unknown as { mode: string | null }).mode;
  renderer.dispose();
  const channels: Float32Array[] = [];
  for (let c = 0; c < out.numberOfChannels; c++) channels.push(out.getChannelData(c).slice());
  return { channels, mode };
}

function rms(a: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Lag (ms) maximising the cross-correlation of R against L; > 0 means R lags (source on the left). */
function itd(l: Float32Array, r: Float32Array, from: number, to: number): number {
  let best = 0;
  let bestLag = 0;
  for (let lag = -48; lag <= 48; lag++) {
    let s = 0;
    for (let i = from; i < to; i++) s += l[i] * (r[i + lag] ?? 0);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return (bestLag / SR) * 1000;
}

/** Measurements at render time t (seconds), over a 60 ms window. */
function measure(channels: Float32Array[], t: number) {
  const from = Math.round((t - 0.03) * SR);
  const to = Math.round((t + 0.03) * SR);
  const levels = channels.map((c) => rms(c, from, to));
  return {
    t,
    levels,
    ildDb: 20 * Math.log10((levels[0] + 1e-12) / (levels[1] + 1e-12)),
    itdMs: channels.length >= 2 ? itd(channels[0], channels[1], from, to) : 0,
  };
}

/** Largest short-window roughness jump (second difference energy relative to the median). */
function clickScore(a: Float32Array, around: number): number {
  const win = 240;
  const e: number[] = [];
  for (let i = 2; i + win < a.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) {
      const d = a[j] - 2 * a[j - 1] + a[j - 2];
      s += d * d;
    }
    e.push(s);
  }
  const sorted = e.slice().sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1] || 1e-12;
  const k = Math.floor((around * SR) / win);
  let worst = 0;
  for (let i = Math.max(0, k - 4); i < Math.min(e.length, k + 4); i++) worst = Math.max(worst, e[i] / median);
  return worst;
}

export async function runChecks() {
  const times = [0.3, 1.0, 1.8, 3.3];
  const headphones = await render({ mode: 'headphones', outChannels: 2, seconds: 3.6 });
  const speakers = await render({ mode: 'speakers', outChannels: 2, seconds: 3.6 });
  const multi = await render({ mode: 'multichannel', outChannels: 12, seconds: 3.6 });
  const multi8 = await render({ mode: 'multichannel', outChannels: 8, seconds: 3.6 });
  // Underrun: the Worklet stalls 0.2 s at content time 0.3 s, so the
  // left→right sweep (content 0.5–1.5 s) must play at render 0.7–1.7 s,
  // crossing the centre at render 1.2 s, not 1.0 s.
  const underrun = await render({ mode: 'speakers', outChannels: 2, seconds: 2.2, underrunAt: 0.3, stall: 0.2 });
  // Mode switches with a steady sine at a fixed spot.
  const switching = await render({
    mode: 'headphones',
    outChannels: 2,
    seconds: 3.0,
    signal: 'sine',
    staticPos: [-0.5, 0, 1],
    switches: [
      [1.0, 'speakers'],
      [2.0, 'headphones'],
    ],
  });
  /** Time (s) at which the L/R balance crosses 0 dB during the sweep
      (content 0.5–1.5 s, centre at 1.0 s), measured in 10 ms windows. */
  const crossing = (channels: Float32Array[]): number => {
    let prev = Infinity;
    for (let t = 0.6; t < 1.5; t += 0.002) {
      const from = Math.round((t - 0.005) * SR);
      const to = Math.round((t + 0.005) * SR);
      const ild = 20 * Math.log10((rms(channels[0], from, to) + 1e-12) / (rms(channels[1], from, to) + 1e-12));
      if (prev > 0 && ild <= 0) return t;
      prev = ild;
    }
    return NaN;
  };
  return {
    headphonesCrossing: crossing(headphones.channels),
    speakersCrossing: crossing(speakers.channels),
    headphones: times.map((t) => measure(headphones.channels, t)),
    speakers: times.map((t) => measure(speakers.channels, t)),
    multichannel: { mode: multi.mode, points: times.map((t) => measure(multi.channels, t)) },
    multichannel8: { mode: multi8.mode, points: times.map((t) => measure(multi8.channels, t)) },
    underrun: [0.6, 1.0, 1.2, 1.4].map((t) => measure(underrun.channels, t)),
    switching: {
      mode: switching.mode,
      clickAt1: clickScore(switching.channels[0], 1.0),
      clickAt2: clickScore(switching.channels[0], 2.0),
      clickBaseline: clickScore(switching.channels[0], 0.5),
      levels: [0.5, 1.5, 2.5].map((t) => measure(switching.channels, t).levels),
    },
  };
}

(globalThis as unknown as { atmosRunChecks: typeof runChecks }).atmosRunChecks = runChecks;
