/* Gate 3: JOC upmix.
   1. Reference: with cavernCompat, driven exactly the way Cavern's
      EnhancedAC3Renderer drives its applier (Cavern's own core PCM as input;
      the next frame's JOC takes over on the last timeslot, when Cavern's
      BlockBuffer fetches it), object PCM must match Cavern's within 1e-3 RMS.
   2. The FFmpeg core the engine will use vs Cavern's core decode.
   3. Default mode on FFmpeg's core: energy sanity and an OAMD-panned
      re-downmix to 5.0 against the core.
   4. Performance: ×realtime on one thread, allocation per frame, memory.
   AMC-original test code. */

import { AccessUnitParser } from '../../src/audio/atmos/bitstream/access-unit';
import { JointObjectCodingApplier } from '../../src/audio/atmos/joc/applier';
import { createJocProcessorWith } from '../../src/audio/atmos/processor';
import type { SpatialKeyframe } from '../../src/audio/spatial/contract';
import { Mp4File } from './mp4';
import { assert, cavernRef, ffmpegDecode, findFfmpeg, haveCavernRef, haveRealFile, log, readF32, realFile, run, skip, test } from './util';
import { resolve } from 'node:path';

const FRAME = 1536;

function planar(interleaved: Float32Array, channels: number, frame: number, length: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const a = new Float32Array(length);
    const base = frame * length * channels;
    for (let n = 0; n < length; n++) a[n] = interleaved[base + n * channels + c];
    out.push(a);
  }
  return out;
}

test('object PCM equals Cavern\'s (cavernCompat, Cavern core input)', () => {
  if (!haveRealFile) skip('no real file');
  if (!haveCavernRef) skip('no Cavern reference (run scripts/atmos-cavern-ref.sh)');
  const core = readF32(resolve(cavernRef, 'core.f32'));
  const ref = readF32(resolve(cavernRef, 'objects.f32'));
  const refObjects = 16; // LFE + 15 JOC objects, OAMD order
  const frames = Math.min(core.length / (6 * FRAME), ref.length / (refObjects * FRAME));
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const parser = new AccessUnitParser(true);
  const applier = new JointObjectCodingApplier(FRAME, true);
  const objects = 15;
  const outs = Array.from({ length: objects }, () => new Float32Array(FRAME));
  parser.parse(mp4.sample(track, 0)); // Cavern decodes frame 0 when the decoder is built
  const err = new Float64Array(objects);
  const sig = new Float64Array(objects);
  let maxAbs = 0;
  for (let k = 0; k < frames; k++) {
    const [fl, fr, fc, , sl, sr] = planar(core, 6, k, FRAME);
    applier.loadFrame([fl, fr, fc, sl, sr, null, null], FRAME);
    for (let ts = 0; ts < FRAME / 64; ts++) {
      if (ts === FRAME / 64 - 1 && k + 1 < track.sizes.length) parser.parse(mp4.sample(track, k + 1));
      applier.apply(ts, parser.extensions.joc, outs, ts * 64, objects);
    }
    for (let o = 0; o < objects; o++) {
      for (let n = 0; n < FRAME; n++) {
        const want = ref[(k * FRAME + n) * refObjects + 1 + o];
        const d = outs[o][n] - want;
        err[o] += d * d;
        sig[o] += want * want;
        maxAbs = Math.max(maxAbs, Math.abs(d));
      }
    }
  }
  mp4.close();
  const n = frames * FRAME;
  let worst = 0;
  let worstRel = 0;
  const parts: string[] = [];
  for (let o = 0; o < objects; o++) {
    const rms = Math.sqrt(err[o] / n);
    const rel = Math.sqrt(err[o] / Math.max(sig[o], 1e-30));
    worst = Math.max(worst, rms);
    worstRel = Math.max(worstRel, rel);
    parts.push(rms.toExponential(1));
  }
  log(`${frames} frames (${(n / 48000).toFixed(1)} s), per-object RMS error: ${parts.join(' ')}`);
  log(`worst RMS error ${worst.toExponential(2)} (relative ${worstRel.toExponential(2)}), max abs ${maxAbs.toExponential(2)}`);
  assert(worst < 1e-3, 'object PCM within 1e-3 RMS of Cavern');
});

test('FFmpeg core decode vs Cavern core decode', () => {
  if (!haveRealFile || !haveCavernRef) skip('needs the real file and the Cavern reference');
  if (!findFfmpeg()) skip('no ffmpeg');
  const cav = readF32(resolve(cavernRef, 'core.f32'));
  for (const [label, args] of [['default (DRC on)', []], ['-drc_scale 0', ['-drc_scale', '0']]] as [string, string[]][]) {
    const ff = ffmpegDecode(realFile, 30, args).pcm;
    const len = Math.min(ff.length, cav.length);
    let e = 0, s = 0;
    for (let i = 0; i < len; i++) { const d = ff[i] - cav[i]; e += d * d; s += cav[i] * cav[i]; }
    log(`FFmpeg ${label} vs Cavern core: RMS diff ${Math.sqrt(e / len).toExponential(2)}, relative ${Math.sqrt(e / s).toExponential(2)}`);
  }
});

test('default mode on FFmpeg core: energy and re-downmix sanity; performance', () => {
  if (!haveRealFile) skip('no real file');
  if (!findFfmpeg()) skip('no ffmpeg');
  const seconds = 60;
  const { pcm: coreIl } = ffmpegDecode(realFile, seconds);
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const proc = createJocProcessorWith({ codec: 'ec-3', sampleRate: 48000, coreChannels: 6, dec3: track.dec3 });
  assert(proc, 'factory returns a processor for a JOC stream');
  log(`maxChannels ${proc.maxChannels}`);
  const frames = Math.floor(coreIl.length / (6 * FRAME));
  const packets: Uint8Array[] = [];
  const cores: Float32Array[][] = [];
  for (let k = 0; k < frames; k++) {
    packets.push(mp4.sample(track, k));
    cores.push(planar(coreIl, 6, k, FRAME));
  }
  mp4.close();

  // Timed pass (warm-up of 2 s first so the JIT settles).
  for (let k = 0; k < 62; k++) proc.process(packets[k], cores[k]);
  proc.reset();
  (globalThis as { gc?: () => void }).gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  let rssPeak = process.memoryUsage().rss;
  const t0 = performance.now();
  const blocks: { pcm: Float32Array[]; keyframes: SpatialKeyframe[] }[] = [];
  let energyCore = 0, energyObj = 0;
  const ratios: number[] = [];
  let kfCount = 0;
  const e5: Float64Array = new Float64Array(5);
  const d5: Float64Array = new Float64Array(5);
  let procMs = 0;
  // Positions currently in force (linear between keyframes, sampled per frame).
  let lastKf: SpatialKeyframe | null = null;
  for (let k = 0; k < frames; k++) {
    const t = performance.now();
    const block = proc.process(packets[k], cores[k]);
    procMs += performance.now() - t;
    assert(block && block.pcm.length === proc.maxChannels && block.bedChannels === 1, 'fixed channel layout');
    kfCount += block.keyframes.length;
    if (block.keyframes.length) lastKf = block.keyframes[block.keyframes.length - 1];
    if (k % 60 === 0) rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

    // Energy of this frame vs the core frame 577 samples earlier (the delay):
    // compare whole frames once the pipeline is full.
    if (k > 0) {
      let ec = 0, eo = 0;
      const prevCore = cores[k - 1];
      for (const ch of [0, 1, 2, 4, 5]) for (let n = 0; n < FRAME; n++) ec += prevCore[ch][n] ** 2 + cores[k][ch][n] ** 2;
      for (let o = 1; o < block.pcm.length; o++) for (let n = 0; n < FRAME; n++) eo += block.pcm[o][n] ** 2;
      energyCore += ec / 2;
      energyObj += eo;
      if (ec > 1e-6) ratios.push(eo / (ec / 2));
    }

    // Re-downmix to 5.0 by the objects' current positions, delay-compensated.
    if (lastKf && k > 1) {
      const pos = lastKf.positions;
      const mix = [new Float32Array(FRAME), new Float32Array(FRAME), new Float32Array(FRAME), new Float32Array(FRAME), new Float32Array(FRAME)];
      for (let o = 0; o < pos.length; o++) {
        const g = panTo50(pos[o].x, pos[o].z);
        const src = block.pcm[1 + o];
        for (let c = 0; c < 5; c++) if (g[c]) for (let n = 0; n < FRAME; n++) mix[c][n] += g[c] * src[n];
      }
      for (let c = 0; c < 5; c++) {
        const coreCh = [0, 1, 2, 4, 5][c];
        for (let n = 0; n < FRAME; n++) {
          // Core sample aligned with output sample n is 577 samples earlier.
          const m = n - 577;
          const want = m >= 0 ? cores[k][coreCh][m] : cores[k - 1][coreCh][FRAME + m];
          e5[c] += want * want;
          d5[c] += (mix[c][n] - want) ** 2;
        }
      }
    }
    if (k < 3) blocks.push({ pcm: block.pcm.map((a) => a.slice()), keyframes: block.keyframes });
  }
  const wall = performance.now() - t0;
  const heapGrowth = process.memoryUsage().heapUsed - heap0;
  const audioMs = (frames * FRAME * 1000) / 48000;

  ratios.sort((a, b) => a - b);
  const q = (p: number) => ratios[Math.floor(ratios.length * p)];
  log(`${frames} frames (${(audioMs / 1000).toFixed(1)} s): ${kfCount} keyframes; stats ${JSON.stringify(proc.stats)}`);
  log(`energy objects/core: overall ${(energyObj / energyCore).toFixed(3)}, per-frame p10 ${q(0.1).toFixed(3)} p50 ${q(0.5).toFixed(3)} p90 ${q(0.9).toFixed(3)}`);
  const snr = Array.from(e5, (e, c) => (10 * Math.log10(e / d5[c])).toFixed(1));
  log(`objects re-downmixed to 5.0 by OAMD position (dual-balance panning) vs the core, SNR per channel L R C Ls Rs (dB): ${snr.join(' ')}`);
  log(`process(): ${procMs.toFixed(0)} ms for ${audioMs.toFixed(0)} ms of audio = ${(audioMs / procMs).toFixed(1)}× realtime on one thread (wall ${wall.toFixed(0)} ms)`);
  log(`memory: rss peak ${(rssPeak / 1048576).toFixed(0)} MB (includes ${((coreIl.byteLength * 2) / 1048576).toFixed(0)} MB of test PCM), heap growth over the run ${(heapGrowth / 1048576).toFixed(1)} MB`);

  assert(q(0.5) > 0.5 && q(0.5) < 2, 'median object energy is within a factor of 2 of the core');
  assert(Array.from(e5, (e, c) => 10 * Math.log10(e / d5[c])).every((v) => v > 3), 'objects re-downmix to the core (> 3 dB SNR per channel)');
  assert(audioMs / procMs > 3, 'faster than 3× realtime on one thread');
  // First block: a keyframe at the QMF delay and one at the end of the 1536-sample ramp.
  assert(blocks[0].keyframes.length === 2 && blocks[0].keyframes[0].frame === 577 && blocks[0].keyframes[1].frame === 577 + 1536,
    'keyframes at the ramp start/end on the output timeline');
});

/** Dual-balance panning onto L R C Ls Rs, the way Atmos renders a room
    position to 5.1: front/back balance from z, then left/centre/right (front)
    or left/right (surround) from x. Height is folded in. */
function panTo50(x: number, z: number): number[] {
  const back = Math.min(1, Math.max(0, (1 - z) / 2)); // 0 = front wall, 1 = back wall
  const gf = Math.cos((back * Math.PI) / 2);
  const gb = Math.sin((back * Math.PI) / 2);
  const g = [0, 0, 0, 0, 0]; // L R C Ls Rs
  const xc = Math.min(1, Math.max(-1, x));
  if (xc <= 0) {
    const t = xc + 1; // 0 = L, 1 = C
    g[0] = gf * Math.cos((t * Math.PI) / 2);
    g[2] = gf * Math.sin((t * Math.PI) / 2);
  } else {
    g[2] = gf * Math.cos((xc * Math.PI) / 2);
    g[1] = gf * Math.sin((xc * Math.PI) / 2);
  }
  const u = (xc + 1) / 2; // 0 = Ls, 1 = Rs
  g[3] = gb * Math.cos((u * Math.PI) / 2);
  g[4] = gb * Math.sin((u * Math.PI) / 2);
  return g;
}

run();
