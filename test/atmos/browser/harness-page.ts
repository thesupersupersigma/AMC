/* The main-thread side of the contract harness, in Chromium. Plays what the
   Worker produced the way the engine will:
   - the Worklet's output (every block's channels, unchanged, back to back)
     is an AudioBufferSourceNode here;
   - the renderer comes from the registry, sits between it and the output,
     gets each block's keyframes stamped with the played frame the block
     starts at (relayed ahead of playback), and gets setPlayedFrame every
     ~107 ms of rendering;
   - a seek resets the renderer at the seek's played frame, before the new
     blocks' keyframes arrive.
   Rendering is an OfflineAudioContext; results and WAVs go back to Node.
   AMC-original test code. */

import '../../../src/audio/spatial/register';
import { getSpatialRendererFactory, type SpatialKeyframe, type SpatialOutputMode, type SpatialStreamInfo } from '../../../src/audio/spatial/contract';

const SR = 48000;
const FRAMES = 1536;
const QUANTUM = 128;

interface HarnessOptions {
  modes: { mode: SpatialOutputMode; outChannels: number; wav?: string }[];
  plan: number[];
  seconds: number;
}

interface Block {
  k: number;
  pcm: Float32Array[];
  keyframes: SpatialKeyframe[];
  bedChannels: number;
  bedLayout: string[];
  epoch: number;
  startFrame: number; // played frame at which this block starts
}

async function fetchBuf(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

/** Run the Worker over the plan and collect its blocks in played order. */
async function runWorker(plan: number[]) {
  const index = await (await fetch('/data/index.json')).json();
  const packets = await fetchBuf('/data/packets.bin');
  const core = new Float32Array(await fetchBuf('/data/core.f32'));
  const dec3 = Uint8Array.from(atob(index.dec3), (c) => c.charCodeAt(0));
  const info: SpatialStreamInfo = { codec: 'ec-3', sampleRate: SR, coreChannels: 6, dec3 };
  const worker = new Worker('/worker.js');
  const blocks: Block[] = [];
  const seeks: number[] = [];
  let maxChannels = 0;
  let realm: unknown = null;
  let done: { processMs: number; wallMs: number; stats: unknown } | null = null;
  let epoch = 0;
  let played = 0;
  await new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error('worker: ' + e.message));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'ready') {
        maxChannels = m.maxChannels;
        realm = m.realm;
      } else if (m.type === 'seek') {
        epoch++;
        seeks.push(played);
      } else if (m.type === 'block') {
        if (!m.block) return reject(new Error(`process() returned null for packet ${m.k}`));
        const b = m.block;
        blocks.push({ k: m.k, pcm: b.pcm, keyframes: b.keyframes, bedChannels: b.bedChannels, bedLayout: b.bedLayout, epoch, startFrame: played });
        played += b.pcm[0].length;
      } else if (m.type === 'done') {
        done = m;
        resolve();
      }
    };
    worker.postMessage({ type: 'start', info, packets, offsets: index.offsets, core, plan }, [packets, core.buffer]);
  });
  worker.terminate();
  return { blocks, seeks, maxChannels, realm, done: done!, totalFrames: played };
}

/** ITU-R BS.1770 K-weighting at 48 kHz, then mean-square loudness (LKFS, ungated). */
function loudness(channels: Float32Array[], weights: number[]): number {
  const coeffs = [
    { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
    { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] },
  ];
  let sum = 0;
  let n = 0;
  channels.forEach((x, c) => {
    let y = x;
    for (const { b, a } of coeffs) {
      const out = new Float32Array(y.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = b[0] * y[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
        x2 = x1; x1 = y[i]; y2 = y1; y1 = v;
        out[i] = v;
      }
      y = out;
    }
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    sum += weights[c] * (s / y.length);
    n = y.length;
  });
  void n;
  return -0.691 + 10 * Math.log10(sum + 1e-20);
}

function wav24(channels: Float32Array[]): { bytes: ArrayBuffer; clipped: number } {
  const n = channels[0].length;
  const ch = channels.length;
  const dataBytes = n * ch * 3;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = channels[c][i];
      if (s > 1 || s < -1) clipped++;
      s = Math.max(-1, Math.min(1, s));
      const q = Math.round(s * 8388607);
      v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff);
      o += 3;
    }
  }
  return { bytes: buf, clipped };
}

async function renderMode(run: Awaited<ReturnType<typeof runWorker>>, mode: SpatialOutputMode, outChannels: number, wav?: string) {
  const { blocks, seeks, maxChannels, totalFrames } = run;
  const ctx = new OfflineAudioContext(outChannels, totalFrames, SR);
  const factory = getSpatialRendererFactory();
  if (!factory) throw new Error('no renderer factory registered');
  const bedLayout = blocks[0].bedLayout;
  const renderer = factory(ctx as unknown as AudioContext, bedLayout, maxChannels - bedLayout.length);
  renderer.setMode(mode);

  // The Worklet: every block's channels, unchanged, back to back.
  const buf = ctx.createBuffer(maxChannels, totalFrames, SR);
  for (let c = 0; c < maxChannels; c++) {
    const dst = buf.getChannelData(c);
    for (const b of blocks) dst.set(b.pcm[c], b.startFrame);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(renderer.input);
  renderer.output.connect(ctx.destination);

  // Keyframes are relayed ahead of playback, like blocks queued in the Worklet.
  const lookahead = 0.5 * SR;
  let next = 0;
  let epoch = 0;
  const relay = (upTo: number) => {
    while (next < blocks.length && blocks[next].epoch === epoch && blocks[next].startFrame <= upTo + lookahead) {
      renderer.pushKeyframes(blocks[next].startFrame, blocks[next].keyframes);
      next++;
    }
  };
  relay(0);
  renderer.setPlayedFrame(0);

  const checkpoints = new Set<number>();
  for (let f = 40 * QUANTUM; f < totalFrames; f += 40 * QUANTUM) checkpoints.add(f);
  for (const s of seeks) checkpoints.add(s); // seek frames are block-aligned, hence quantum-aligned
  for (const f of [...checkpoints].sort((a, b) => a - b)) {
    ctx.suspend(f / SR).then(() => {
      if (seeks.includes(f)) {
        // The engine flushes, resets processor and renderer, then relays the new blocks.
        renderer.reset();
        epoch++;
        while (next < blocks.length && blocks[next].epoch < epoch) next++;
      }
      relay(f);
      renderer.setPlayedFrame(f);
      ctx.resume();
    });
  }
  src.start(0);
  const t0 = performance.now();
  const out = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  renderer.dispose();

  const channels: Float32Array[] = [];
  for (let c = 0; c < out.numberOfChannels; c++) channels.push(out.getChannelData(c));
  let nan = 0;
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) {
    const v = c[i];
    if (!Number.isFinite(v)) nan++;
    else if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // Level in 1 s windows, to find dropouts.
  const secondRms: number[] = [];
  for (let s = 0; s + SR <= totalFrames; s += SR) {
    let sum = 0;
    for (const c of channels) for (let i = s; i < s + SR; i++) sum += c[i] * c[i];
    secondRms.push(Math.sqrt(sum / (SR * channels.length)));
  }
  let clipped = 0;
  if (wav) {
    const w = wav24(channels);
    clipped = w.clipped;
    const r = await fetch('/upload?name=' + encodeURIComponent(wav), { method: 'POST', body: w.bytes });
    if (!r.ok) throw new Error('upload failed');
  }
  const weights = weightsFor(outChannels);
  return {
    mode,
    outChannels,
    renderMs,
    loudness: loudness(channels, weights),
    peak,
    nan,
    clipped,
    minSecondRms: Math.min(...secondRms),
    secondRms,
  };
}

/** The core the engine would otherwise play: its standard stereo downmix
    (ITU: L = FL + 0.707·FC + 0.707·SL, LFE omitted) and its 5.1 loudness
    (BS.1770 weights: surrounds 1.41, LFE ignored), for level reference. */
async function coreReference(plan: number[]): Promise<{ stereo: number; surround: number; peak: number }> {
  const core = new Float32Array(await fetchBuf('/data/core.f32'));
  const idx = plan.filter((k) => k >= 0);
  const n = idx.length * FRAMES;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const ch = [0, 1, 2, 4, 5].map(() => new Float32Array(n));
  let peak = 0;
  idx.forEach((k, j) => {
    for (let i = 0; i < FRAMES; i++) {
      const b = (k * FRAMES + i) * 6;
      const o = j * FRAMES + i;
      L[o] = core[b] + 0.707 * core[b + 2] + 0.707 * core[b + 4];
      R[o] = core[b + 1] + 0.707 * core[b + 2] + 0.707 * core[b + 5];
      peak = Math.max(peak, Math.abs(L[o]), Math.abs(R[o]));
      [0, 1, 2, 4, 5].forEach((c, m) => (ch[m][o] = core[b + c]));
    }
  });
  return { stereo: loudness([L, R], [1, 1]), surround: loudness(ch, [1, 1, 1, 1.41, 1.41]), peak };
}

/** BS.1770 channel weights for a multichannel render: 1.41 for speakers
    between 60° and 120° off-axis at ear level, 0 for the LFE, else 1. */
function weightsFor(outChannels: number): number[] {
  if (outChannels === 12) return [1, 1, 1, 0, 1, 1, 1.41, 1.41, 1, 1, 1, 1];
  if (outChannels === 8) return [1, 1, 1, 0, 1, 1, 1.41, 1.41];
  if (outChannels === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return new Array(outChannels).fill(1);
}

export async function atmosHarness(opts: HarnessOptions) {
  const results = [];
  let worker: Awaited<ReturnType<typeof runWorker>> | null = null;
  for (const m of opts.modes) {
    // A fresh Worker run per mode (the transferred blocks are consumed by rendering).
    worker = await runWorker(opts.plan);
    results.push(await renderMode(worker, m.mode, m.outChannels, m.wav));
  }
  const w = worker!;
  return {
    maxChannels: w.maxChannels,
    realm: w.realm,
    worker: w.done,
    blocks: w.blocks.length,
    keyframes: w.blocks.reduce((a, b) => a + b.keyframes.length, 0),
    seeks: w.seeks,
    totalFrames: w.totalFrames,
    bedLayout: w.blocks[0].bedLayout,
    ...(await coreReference(opts.plan).then((c) => ({ coreLoudness: c.stereo, core51Loudness: c.surround, corePeak: c.peak }))),
    results,
  };
}

(globalThis as unknown as { atmosHarness: typeof atmosHarness }).atmosHarness = atmosHarness;
