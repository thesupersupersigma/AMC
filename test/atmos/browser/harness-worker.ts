/* The decode Worker side of the contract harness. Runs in a real Web
   Worker inside Chromium, the way the engine's Worker will:
   register.ts is imported (in a Worker realm, with no DOM), the processor
   comes from the registry, process() runs once per packet with that
   packet's core PCM, and each block's buffers are *transferred* back.
   AMC-original test code. */

import '../../../src/audio/spatial/register';
import { getSpatialProcessorFactory, type SpatialProcessor, type SpatialStreamInfo } from '../../../src/audio/spatial/contract';

interface StartMessage {
  type: 'start';
  info: SpatialStreamInfo;
  packets: ArrayBuffer;
  offsets: number[]; // packets[i] = bytes offsets[i]..offsets[i+1]
  core: Float32Array; // interleaved, coreChannels per frame, FFmpeg order
  /** Packet indices to process, in order; -1 marks a seek (reset). */
  plan: number[];
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<StartMessage>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const msg = e.data;
  const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
  const hasDocument = typeof (globalThis as { document?: unknown }).document !== 'undefined';
  const factory = getSpatialProcessorFactory();
  if (!factory) {
    scope.postMessage({ type: 'error', message: 'no processor factory registered' });
    return;
  }
  const processor: SpatialProcessor | null = factory(msg.info);
  if (!processor) {
    scope.postMessage({ type: 'error', message: 'factory returned null for a JOC stream' });
    return;
  }
  scope.postMessage({ type: 'ready', maxChannels: processor.maxChannels, realm: { hasWindow, hasDocument } });

  const frames = 1536;
  const channels = msg.info.coreChannels;
  const bytes = new Uint8Array(msg.packets);
  let t0 = performance.now();
  let processMs = 0;
  for (const k of msg.plan) {
    if (k < 0) {
      processor.reset();
      scope.postMessage({ type: 'seek' });
      continue;
    }
    const packet = bytes.subarray(msg.offsets[k], msg.offsets[k + 1]);
    // The engine hands over planar f32 per packet.
    const core: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const a = new Float32Array(frames);
      for (let n = 0; n < frames; n++) a[n] = msg.core[(k * frames + n) * channels + c];
      core.push(a);
    }
    const t = performance.now();
    const block = processor.process(packet, core);
    processMs += performance.now() - t;
    if (!block) {
      scope.postMessage({ type: 'block', k, block: null });
      continue;
    }
    // Transfer, as an engine would, which detaches the processor's buffers.
    scope.postMessage({ type: 'block', k, block }, block.pcm.map((a) => a.buffer));
  }
  const stats = (processor as unknown as { stats?: unknown }).stats;
  processor.dispose();
  scope.postMessage({ type: 'done', processMs, wallMs: performance.now() - t0, stats });
  t0 = 0;
};
