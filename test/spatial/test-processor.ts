/* TEST-ONLY spatial add-on. Never imported by src/ — the app build cannot
   contain it. It proves the spatial hook of the decode engine end to end:
   channel sizing (the worklet grows to maxChannels), per-packet process(),
   reset() on seek and track change, and keyframe relay to the main-thread
   renderer in the played-frame timeline.

   Processor: passes the decoded core through as a 6-channel bed plus ONE
   object channel of constant 0.25, and emits one keyframe per block whose
   x position carries how many times reset() has been called. Non-JOC
   streams get no processor (null), so the engine plays the core. */

import type { SpatialBlock, SpatialKeyframe, SpatialOutputMode, SpatialProcessor, SpatialProcessorFactory, SpatialRenderer, SpatialRendererFactory, SpatialStreamInfo } from '../../src/audio/spatial/contract';
import { parseDec3 } from '../../src/audio/mp4samples';

export const OBJECT_LEVEL = 0.25;
const LAYOUT = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'];

export const testProcessorFactory: SpatialProcessorFactory = (info: SpatialStreamInfo): SpatialProcessor | null => {
  const cfg = parseDec3(info.dec3);
  if (!cfg || !cfg.joc) return null;
  let resets = 0;
  let blocks = 0;
  return {
    maxChannels: 7,
    bedLayout: LAYOUT,
    stats: { objects: 1 },
    process(packet: Uint8Array, core: Float32Array[]): SpatialBlock | null {
      if (!packet.length || !core.length) return null;
      const n = core[0].length;
      const bed: Float32Array[] = [];
      for (let c = 0; c < 6; c++) bed.push(core[c] || new Float32Array(n));
      const obj = new Float32Array(n).fill(OBJECT_LEVEL);
      blocks++;
      const keyframes: SpatialKeyframe[] = [{ frame: 0, positions: [{ x: resets, y: blocks, z: 1, size: 0, gain: 1 }] }];
      return { pcm: [...bed, obj], bedChannels: 6, bedLayout: LAYOUT, keyframes };
    },
    reset(): void {
      resets++;
    },
    dispose(): void {
      resets = -1;
    },
  };
};

export interface RendererLog {
  created: Array<{ bed: number; bedLayout: string[]; objects: number }>;
  modes: SpatialOutputMode[];
  rates: number[];
  keyframes: Array<{ blockStartFrame: number; x: number; y: number }>;
  played: number[];
  resets: number;
  disposed: number;
}

export function makeTestRenderer(log: RendererLog): SpatialRendererFactory {
  return (ctx: AudioContext, bedLayout: readonly string[], objectChannels: number): SpatialRenderer => {
    log.created.push({ bed: bedLayout.length, bedLayout: bedLayout.slice(), objects: objectChannels });
    const node = ctx.createGain();
    node.channelCountMode = 'max';
    return {
      input: node,
      output: node,
      setMode(mode: SpatialOutputMode): void {
        log.modes.push(mode);
      },
      pushKeyframes(blockStartFrame: number, keyframes: SpatialKeyframe[]): void {
        for (const k of keyframes) for (const p of k.positions) log.keyframes.push({ blockStartFrame, x: p.x, y: p.y });
      },
      setPlayedFrame(frame: number): void {
        log.played.push(frame);
      },
      setRate(rate: number): void {
        if (log.rates) log.rates.push(rate);
      },
      reset(): void {
        log.resets++;
      },
      dispose(): void {
        log.disposed++;
      },
    };
  };
}
