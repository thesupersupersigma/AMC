/* Message protocol of the software decode engine.

   Three parties:
     main    — soft-engine.ts (owns the AudioContext, Worklet node, gain)
     worker  — worker-core.ts (demux tables + decoder; File.slice reads)
     worklet — worklet.ts (ring of PCM chunks → the output)
   PCM flows worker → worklet directly over a MessagePort the main thread
   hands to both, so audio never waits on a busy main thread. The worklet
   reports its read head to both sides.

   Frame vocabulary:
     media frame  — position within the track's audible timeline (0 = first
                    frame after encoder priming); media / sampleRate = seconds
     stream frame — a monotonic counter over everything the worker ever sent
                    this engine instance, across seeks and tracks. Spatial
                    keyframes and the renderer's played frame use it. */

import type { SpatialKeyframe } from '../spatial/contract';

export interface EngineSource {
  file: File;
  codec: string;
  /** For log lines only. */
  name: string;
}

export interface TrackInfo {
  codec: string;
  sampleRate: number;
  /** Channels the worklet outputs for this track (core, or bed + objects). */
  channels: number;
  /** Channels of the decoded core. */
  coreChannels: number;
  bitDepth: number;
  duration: number;
  frames: number;
  backend: 'wasm' | 'webcodecs';
  /** The WASM decoder is the silent placeholder. */
  isStub: boolean;
  decoderVersion: string;
  /** E-AC-3 carries Atmos (JOC) object data. */
  joc: boolean;
  spatial: { maxChannels: number; bedChannels: number; objectChannels: number } | null;
}

/* ---------- main → worker ---------- */

export type ToWorker =
  | { t: 'init'; wasm: string; port: MessagePort | null; allowWebCodecs: boolean; devCodecs: boolean }
  | { t: 'port'; port: MessagePort }
  | { t: 'open'; gen: number; seg: number; src: EngineSource; startSec: number; spatial: boolean }
  | { t: 'start'; gen: number }
  | { t: 'seek'; gen: number; seg: number; sec: number }
  | { t: 'next'; seg: number; src: EngineSource }
  | { t: 'cancelNext'; seg: number }
  | { t: 'close' }
  | { t: 'peaks'; id: number; src: EngineSource; buckets: number }
  | { t: 'analyze'; id: number; src: EngineSource; buckets: number; windowSec: number };

/* ---------- worker → main ---------- */

export type FromWorker =
  | { t: 'opened'; gen: number; seg: number; info: TrackInfo }
  | { t: 'nextReady'; seg: number; info: TrackInfo }
  | { t: 'nextRejected'; seg: number; reason: string }
  | { t: 'seeked'; gen: number }
  | { t: 'error'; gen: number; seg: number; message: string; code: number }
  | { t: 'log'; message: string; detail?: string }
  | { t: 'keyframes'; gen: number; blockStartFrame: number; keyframes: SpatialKeyframe[] }
  | { t: 'peaks'; id: number; data: { duration: number; pairs: number[] } | null; error?: string }
  | { t: 'peaksProgress'; id: number; fraction: number }
  | { t: 'analysis'; id: number; data: EngineAnalysis | null; error?: string };

/** A full streaming decode of one file, reduced on the fly: windowed RMS of
    the channel mix (for silence detection) and min/max peaks. */
export interface EngineAnalysis {
  duration: number;
  sampleRate: number;
  /** Frames per RMS window. */
  win: number;
  rms: Float32Array;
  peakRms: number;
  pairs: number[];
}

/* ---------- worker → worklet (MessagePort) ---------- */

export type ToWorklet =
  | { t: 'pcm'; gen: number; seg: number; media: number; stream: number; frames: number; planes: Float32Array[] }
  | { t: 'eos'; gen: number; seg: number; final: boolean }
  | { t: 'drop'; gen: number; seg: number };

/* ---------- main → worklet (node.port) ---------- */

export type MainToWorklet =
  | { t: 'port'; port: MessagePort }
  | { t: 'flush'; gen: number }
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'tap'; on: boolean }
  | { t: 'dispose' };

/* ---------- worklet → main (node.port) ---------- */

export type FromWorklet =
  | { t: 'pos'; gen: number; seg: number; media: number; stream: number; time: number; playing: boolean; queued: number }
  | { t: 'started'; gen: number; seg: number }
  | { t: 'underrun'; gen: number }
  | { t: 'resumed'; gen: number }
  | { t: 'segment'; gen: number; seg: number; stream: number }
  | { t: 'ended'; gen: number; seg: number }
  | { t: 'tap'; stream: number; media: number; planes: Float32Array[] };

/* ---------- worklet → worker (MessagePort) ---------- */

export type WorkletToWorker = { t: 'level'; gen: number; seg: number; head: number };

/** MediaError-compatible codes. */
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
