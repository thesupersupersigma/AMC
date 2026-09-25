/* src/audio/spatial/contract.ts
   SHARED CONTRACT between the decode engine (feat/decode-engine) and the
   Atmos add-on (feat/atmos). Both branches create this file with EXACTLY
   this content. Neither branch may change it. If a change is needed, say
   so in the PR description and let the merge step reconcile it.

   Data flow for an E-AC-3 track:
     Worker: File.slice -> packet (one E-AC-3 access unit, raw bytes)
             -> core decoder (FFmpeg/WebCodecs) -> planar f32 5.1 PCM
             -> SpatialProcessor.process(packet, corePcm)   [if registered]
             -> object PCM + object positions
     Worklet: plays `channelCount` channels (bed + objects), unchanged
     Main:    SpatialRenderer builds the Web Audio graph after the Worklet
              and applies positions in sync with played frames.
   With no processor registered (or a non-JOC stream), the engine plays
   the 5.1 core exactly as before. */

/** Info from the MP4 sample entry and the first frames. */
export interface SpatialStreamInfo {
  codec: 'ec-3';
  sampleRate: number;
  /** Channels of the decoded core, in FFmpeg order (5.1(side): FL FR FC LFE SL SR). */
  coreChannels: number;
  /** Raw payload of the `dec3` box (no box header). */
  dec3: Uint8Array;
}

/** A position in AMC's listener space: x right, y up, z front, each -1..1.
    (0,0,1) = straight ahead, (0,1,0) = overhead. */
export interface SpatialPosition {
  x: number;
  y: number;
  z: number;
  /** Object size/spread 0..1 (0 = point source). */
  size: number;
  /** Linear gain for this object at this point. */
  gain: number;
}

/** Position keyframes for one processed block. `frame` is the sample offset
    from the start of this block's output at which `positions` take
    effect; the renderer ramps linearly from the previous keyframe. */
export interface SpatialKeyframe {
  frame: number;
  positions: SpatialPosition[];
}

export interface SpatialBlock {
  /** Planar f32 channels to play: first `bedChannels` are the bed (speaker
      layout given by `bedLayout`), followed by one channel per object.
      All channels have the same length. */
  pcm: Float32Array[];
  bedChannels: number;
  /** Bed layout labels, e.g. ['FL','FR','FC','LFE','SL','SR']. */
  bedLayout: string[];
  /** One entry per object channel, in order; empty when no objects. */
  keyframes: SpatialKeyframe[];
}

/** Runs INSIDE the decode Worker. Must be synchronous and allocation-light:
    it's called once per decoded packet on a 4-thread Chromebook. */
export interface SpatialProcessor {
  /** Max channels `process` will ever return (bed + objects), so the
      engine can size the Worklet up front. Must be <= 32. */
  readonly maxChannels: number;
  /** Returns null when this stream carries no JOC/objects: the engine then
      plays the core untouched. */
  process(packet: Uint8Array, corePcm: Float32Array[]): SpatialBlock | null;
  /** Called on seek and on track change, before the next `process`. */
  reset(): void;
  dispose(): void;
}

export type SpatialProcessorFactory = (info: SpatialStreamInfo) => SpatialProcessor | null;

/** 'headphones' = binaural; 'speakers' = stereo speakers (incl. Mac
    built-ins); 'multichannel' = destination has >= 6 channels. */
export type SpatialOutputMode = 'headphones' | 'speakers' | 'multichannel';

/** Runs on the MAIN thread. Sits between the engine's Worklet node and
    the engine's gain node. */
export interface SpatialRenderer {
  readonly input: AudioNode;
  readonly output: AudioNode;
  setMode(mode: SpatialOutputMode): void;
  /** Keyframes relayed from the Worker, stamped with the absolute played
      frame at which each block starts. */
  pushKeyframes(blockStartFrame: number, keyframes: SpatialKeyframe[]): void;
  /** Absolute frame the Worklet has actually played; drive automation from this. */
  setPlayedFrame(frame: number): void;
  reset(): void;
  dispose(): void;
}

export type SpatialRendererFactory = (ctx: AudioContext, bedChannels: number, objectChannels: number) => SpatialRenderer;

/* ---------- registry: the only coupling point ---------- */

let processorFactory: SpatialProcessorFactory | null = null;
let rendererFactory: SpatialRendererFactory | null = null;

export function registerSpatial(p: SpatialProcessorFactory, r: SpatialRendererFactory): void {
  processorFactory = p;
  rendererFactory = r;
}
export function getSpatialProcessorFactory(): SpatialProcessorFactory | null {
  return processorFactory;
}
export function getSpatialRendererFactory(): SpatialRendererFactory | null {
  return rendererFactory;
}
