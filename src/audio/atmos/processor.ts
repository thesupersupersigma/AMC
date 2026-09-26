/* SpatialProcessor for E-AC-3 JOC streams: runs in the decode Worker.
   AMC-original glue over the Cavern-derived parsers and upmixer in
   bitstream/ and joc/; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there).

   Output layout, fixed for the whole stream so the Worklet never resizes:
     pcm[0]      bed: the core LFE ('LFE'), delayed with the objects
     pcm[1..]    one channel per JOC object, up to maxChannels − 1; channels
                 beyond the stream's object count stay silent (gain 0).
   maxChannels = 1 + complexity_index_type_a from dec3 (the most objects the
   stream may carry), capped at 32.

   Once dec3 has flagged the stream as JOC, process() never returns null, so
   the Worklet's channel count never flips mid-track:
   - frames before the first JOC payload use Cavern's channel-based fallback
     (the core channels as objects at their speaker positions);
   - a frame whose JOC payload is missing or broken holds the previous
     frame's matrices (the parsed JOC state is simply reused) and moves no
     object.
   Buffers are allocated once and reused. If the engine transfers them to
   the Worklet (which detaches them), they are reallocated on the next call. */

import type { SpatialBlock, SpatialKeyframe, SpatialProcessor, SpatialProcessorFactory, SpatialStreamInfo } from '../spatial/contract';
import { AccessUnitParser, type AccessUnitStats } from './bitstream/access-unit';
import { parseDec3 } from './bitstream/dec3';
import { JocUpmix, qmfDelay } from './joc/upmix';

export interface JocProcessorOptions {
  /** Reproduce Cavern's exact behaviour, including the bugs listed in
      docs/atmos/PLAN.md §6. Only the reference comparison sets this. */
  cavernCompat?: boolean;
}

/** Counters for the harness and the activity log. */
export interface JocProcessorStats extends AccessUnitStats {
  /** Frames rendered from JOC. */
  jocFrames: number;
  /** Frames that played the channel-based fallback (no JOC seen yet). */
  fallbackFrames: number;
  /** Frames that reused the previous frame's matrices (JOC payload missing). */
  heldFrames: number;
  /** JOC object count of the last JOC frame. */
  objects: number;
  /** Frames with more JOC objects than output channels (extras dropped). */
  droppedObjectFrames: number;
  /** Frames with sparse-coded objects (decoded as silence, as in Cavern). */
  sparseFrames: number;
}

const maxContractChannels = 32;

/** How far the processor's output lags the core it is given, in samples
    (the QMF round trip). Keyframes already account for it. */
export const jocLatency = qmfDelay;
/** The bed of every block: the core LFE. Everything else is an object. */
const lfeBed = ['LFE'];

/** True when the stream's dec3 box signals JOC objects
    (flag_ec3_extension_type_a). */
export function streamCarriesObjects(info: SpatialStreamInfo): boolean {
  if (info.codec !== 'ec-3') return false;
  const dec3 = parseDec3(info.dec3);
  return dec3 !== null && dec3.jocExtension && dec3.complexityIndex > 0;
}

class JocProcessor implements SpatialProcessor {
  readonly maxChannels: number;
  readonly bedLayout: readonly string[] = lfeBed;
  readonly stats: JocProcessorStats;
  private readonly parser: AccessUnitParser;
  private upmix: JocUpmix | null = null;
  private upmixFrameSize = 0;
  private pcm: Float32Array[] = [];
  private seenJoc = false;
  private disposed = false;

  constructor(private readonly info: SpatialStreamInfo, complexityIndex: number, private readonly cavernCompat: boolean) {
    this.maxChannels = Math.min(maxContractChannels, 1 + complexityIndex);
    this.parser = new AccessUnitParser(cavernCompat);
    this.stats = Object.assign(this.parser.stats, {
      jocFrames: 0,
      fallbackFrames: 0,
      heldFrames: 0,
      objects: 0,
      droppedObjectFrames: 0,
      sparseFrames: 0,
    });
  }

  process(packet: Uint8Array, corePcm: Float32Array[]): SpatialBlock | null {
    if (this.disposed || corePcm.length === 0) return null;
    const length = corePcm[0].length;
    if (length === 0 || length % 64 !== 0) return null;

    const result = this.parser.parse(packet);
    const upmix = this.getUpmix(length);
    const pcm = this.getBuffers(length);
    let keyframes: SpatialKeyframe[];

    if (result.hasObjects) {
      this.seenJoc = true;
      this.stats.jocFrames++;
    }
    if (this.seenJoc) {
      if (!result.hasObjects) this.stats.heldFrames++;
      keyframes = upmix.processFrame(corePcm, length, this.parser.extensions, pcm);
      this.stats.objects = this.parser.extensions.joc.objectCount;
    } else {
      this.stats.fallbackFrames++;
      keyframes = upmix.processFallbackFrame(corePcm, length, pcm);
    }
    this.stats.droppedObjectFrames = upmix.droppedObjectFrames;
    this.stats.sparseFrames = this.parser.extensions.joc.sparseFrames;
    return { pcm, bedChannels: 1, bedLayout: lfeBed, keyframes };
  }

  reset(): void {
    this.parser.reset();
    this.upmix?.reset();
    this.seenJoc = false;
  }

  dispose(): void {
    this.disposed = true;
    this.upmix = null;
    this.pcm = [];
  }

  private getUpmix(length: number): JocUpmix {
    if (!this.upmix || this.upmixFrameSize !== length) {
      this.upmix = new JocUpmix({
        sampleRate: this.info.sampleRate,
        coreChannels: this.info.coreChannels,
        objectChannels: this.maxChannels - 1,
        frameSize: length,
        cavernCompat: this.cavernCompat,
      });
      this.upmixFrameSize = length;
    }
    return this.upmix;
  }

  private getBuffers(length: number): Float32Array[] {
    const pcm = this.pcm;
    for (let ch = 0; ch < this.maxChannels; ch++) {
      const b = pcm[ch];
      // A transferred buffer is detached (length 0): reallocate it.
      if (!b || b.length !== length) pcm[ch] = new Float32Array(length);
    }
    pcm.length = this.maxChannels;
    return pcm;
  }
}

export type { JocProcessor };

/** Factory with options (the contract's factory takes none). Returns null
    for streams whose dec3 carries no JOC flag. */
export function createJocProcessorWith(info: SpatialStreamInfo, options: JocProcessorOptions = {}): (SpatialProcessor & { readonly stats: JocProcessorStats }) | null {
  if (!streamCarriesObjects(info)) return null;
  const dec3 = parseDec3(info.dec3)!;
  return new JocProcessor(info, dec3.complexityIndex, options.cavernCompat === true);
}

export const createJocProcessor: SpatialProcessorFactory = (info) => createJocProcessorWith(info);
