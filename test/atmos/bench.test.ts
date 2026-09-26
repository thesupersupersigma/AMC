/* Benchmark of the default-mode processor on the real file (Worker-side cost
   per frame), separate from the correctness tests so a CPU profile of it is
   clean: node --cpu-prof on the bundled file. The core is FFmpeg's decode
   when available, else noise (the cost does not depend on the content).
   AMC-original test code. */

import { createJocProcessorWith } from '../../src/audio/atmos/processor';
import { Mp4File } from './mp4';
import { ffmpegDecode, findFfmpeg, haveRealFile, log, realFile, run, skip, test, assert } from './util';

const FRAME = 1536;

test('processor throughput (one thread)', () => {
  if (!haveRealFile) skip('no real file');
  const seconds = Number(process.env.AMC_BENCH_SECONDS || 120);
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const frames = Math.min(track.sizes.length, Math.floor((seconds * 48000) / FRAME));
  const packets: Uint8Array[] = [];
  for (let k = 0; k < frames; k++) packets.push(mp4.sample(track, k));
  mp4.close();
  let coreIl: Float32Array;
  if (findFfmpeg()) coreIl = ffmpegDecode(realFile, seconds).pcm;
  else {
    coreIl = new Float32Array(frames * FRAME * 6);
    for (let i = 0; i < coreIl.length; i++) coreIl[i] = Math.random() - 0.5;
  }
  const cores: Float32Array[][] = [];
  for (let k = 0; k < frames; k++) {
    const planes: Float32Array[] = [];
    for (let c = 0; c < 6; c++) {
      const a = new Float32Array(FRAME);
      for (let n = 0; n < FRAME; n++) a[n] = coreIl[(k * FRAME + n) * 6 + c] ?? 0;
      planes.push(a);
    }
    cores.push(planes);
  }
  const gcFn = (globalThis as { gc?: () => void }).gc;
  gcFn?.();
  const mem = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const heapBefore = mem();
  const proc = createJocProcessorWith({ codec: 'ec-3', sampleRate: 48000, coreChannels: 6, dec3: track.dec3 })!;
  for (let k = 0; k < 10; k++) proc.process(packets[k], cores[k]);
  gcFn?.();
  const stateBytes = mem() - heapBefore;
  for (let k = 0; k < Math.min(frames, 100); k++) proc.process(packets[k], cores[k]);
  proc.reset();
  const t0 = performance.now();
  const perFrame: number[] = [];
  for (let k = 0; k < frames; k++) {
    const t = performance.now();
    proc.process(packets[k], cores[k]);
    perFrame.push(performance.now() - t);
  }
  const ms = performance.now() - t0;

  // Allocation per frame: heap growth over a short run with GC settled first
  // (100 frames allocate far less than a young-generation cycle).
  const gc = (globalThis as { gc?: () => void }).gc;
  let perFrameBytes = NaN;
  if (gc) {
    proc.reset();
    for (let k = 0; k < 50; k++) proc.process(packets[k], cores[k]);
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let k = 50; k < 150 && k < frames; k++) proc.process(packets[k], cores[k]);
    perFrameBytes = (process.memoryUsage().heapUsed - h0) / 100;
  }
  const audioMs = (frames * FRAME * 1000) / 48000;
  perFrame.sort((a, b) => a - b);
  log(`${frames} frames: ${(audioMs / ms).toFixed(1)}× realtime; per frame (32 ms of audio) p50 ${perFrame[frames >> 1].toFixed(2)} ms, p99 ${perFrame[Math.floor(frames * 0.99)].toFixed(2)} ms, max ${perFrame[frames - 1].toFixed(2)} ms`);
  log(`processor state after warm-up: ${(stateBytes / 1048576).toFixed(2)} MB of JS heap + typed-array storage`);
  log(`JS heap allocated per frame: ~${perFrameBytes.toFixed(0)} bytes (the returned keyframe objects; audio buffers are reused)`);
  assert(audioMs / ms > 3, '> 3× realtime');
});

run();
