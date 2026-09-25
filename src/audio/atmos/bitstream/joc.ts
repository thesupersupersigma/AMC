/* Joint Object Coding payload parser.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3/JointObjectCoding.cs,
           JointObjectCodingCache.cs (the per-object parse caches)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Cavern's JointObjectCoding is one partial class: parsing (here), matrix
   dequantisation/interpolation (joc/matrix.ts) and caches. The parsed,
   still-quantised values live here; joc/matrix.ts reads them. */

import type { BitExtractor } from './bit-extractor';
import { HuffmanType, getHuffCodeTable, joc_num_bands } from './joc-tables';
import { UnsupportedFeatureError } from './eac3-body';

/** Maximum number of data points per frame (JointObjectCodingCache). */
export const maxDataPoints = 2;
/** Largest joc_num_bands value. */
export const maxBands = 23;
/** Maximum number of JOC objects (6-bit count + 1). */
export const maxJocObjects = 64;

export class JointObjectCoding {
  /** The object is active and will have rendered audio data (b_joc_obj_present). */
  objectActive: boolean[] = [];
  /** Number of full bandwidth input channels (5 or 7). */
  channelCount = 0;
  /** Number of rendered dynamic objects. */
  objectCount = 0;
  /** Multiplier for the output signal's amplitude. */
  gain = 1;
  /** joc_dmx_config_idx, kept for reporting. */
  downmixConfig = 0;
  /** Frames (since construction) that carried sparse-coded objects. */
  sparseFrames = 0;

  /* ---- JointObjectCodingCache.cs ---- */
  /** If true, the temporal extension transition is stepped, not interpolated (joc_slope_idx). */
  steepSlope: boolean[] = [];
  /** Index into joc_num_bands (joc_num_bands_idx). */
  bandsIndex: number[] = [];
  /** Number of processed bands of each object (joc_num_bands). */
  bands: number[] = [];
  /** Index of the used quantization table for each object. */
  quantizationTable: number[] = [];
  /** Number of data points for each object. */
  dataPoints: number[] = [];
  /** Sparse coding (jocChannel + jocVector) instead of a full matrix (b_joc_sparse). */
  sparseCoded: boolean[] = [];
  /** [obj][dp][band]: source channel indexes in sparse mode. */
  jocChannel: Int32Array[][] = [];
  /** [obj][dp][band]: quantized data for each sparse source. */
  jocVector: Int32Array[][] = [];
  /** [obj][dp][ch][band]: quantized and differentially coded mixing matrix. */
  jocMatrix: Int32Array[][][] = [];
  /** [obj][dp]: timeslot indexes where the source matrix changes (steep slopes). */
  timeslotOffsets: Int32Array[] = [];

  /** Decodes a JOC frame from an EMDF payload. */
  decode(extractor: BitExtractor): void {
    this.decodeHeader(extractor);
    this.decodeInfo(extractor);
    this.decodeData(extractor);
  }

  private decodeHeader(extractor: BitExtractor): void {
    const downmixConfig = extractor.read(3);
    if (downmixConfig > 4) {
      throw new UnsupportedFeatureError('joc_dmx_config_idx');
    }
    this.downmixConfig = downmixConfig;
    this.channelCount = downmixConfig === 0 || downmixConfig === 3 ? 5 : 7;
    this.objectCount = extractor.read(6) + 1;
    this.updateCache();
    if (extractor.read(3) !== 0) {
      throw new UnsupportedFeatureError('joc_ext_config_idx');
    }
  }

  /** Read JOC metadata. */
  private decodeInfo(extractor: BitExtractor): void {
    const gainPower = extractor.read(3);
    // C# float arithmetic: 1 + (x / 32f) * MathF.Pow(2, gainPower - 4)
    this.gain = Math.fround(1 + Math.fround(Math.fround(extractor.read(5) / 32) * Math.pow(2, gainPower - 4)));
    extractor.skip(10); // Sequence counter
    let sparse = false;
    for (let obj = 0; obj < this.objectCount; ++obj) {
      if ((this.objectActive[obj] = extractor.readBit())) {
        this.bandsIndex[obj] = extractor.read(3);
        this.bands[obj] = joc_num_bands[this.bandsIndex[obj]];
        this.sparseCoded[obj] = extractor.readBit();
        sparse ||= this.sparseCoded[obj];
        this.quantizationTable[obj] = extractor.readBitInt();

        // joc_data_point_info
        this.steepSlope[obj] = extractor.readBit();
        this.dataPoints[obj] = extractor.read(1) + 1;
        if (this.steepSlope[obj]) {
          const offsets = this.timeslotOffsets[obj];
          for (let dp = 0; dp < this.dataPoints[obj]; ++dp) {
            offsets[dp] = extractor.read(5) + 1;
          }
        }
      }
    }
    if (sparse) this.sparseFrames++;
  }

  /** Read JOC channels/vectors/matrices. */
  private decodeData(extractor: BitExtractor): void {
    for (let obj = 0; obj < this.objectCount; ++obj) {
      if (this.objectActive[obj]) {
        if (this.sparseCoded[obj]) {
          const channelTable = getHuffCodeTable(this.channelCount, HuffmanType.IDX);
          const vecTable = getHuffCodeTable(this.quantizationTable[obj], HuffmanType.VEC);
          const objChannel = this.jocChannel[obj];
          const objVector = this.jocVector[obj];
          for (let dp = 0; dp < this.dataPoints[obj]; ++dp) {
            const dpChannel = objChannel[dp];
            dpChannel[0] = extractor.read(3);
            for (let pb = 1; pb < this.bands[obj]; ++pb) {
              dpChannel[pb] = huffmanDecode(channelTable, extractor);
            }

            const dpVector = objVector[dp];
            for (let pb = 0; pb < this.bands[obj]; ++pb) {
              dpVector[pb] = huffmanDecode(vecTable, extractor);
            }
          }
        } else {
          const codeTable = getHuffCodeTable(this.quantizationTable[obj], HuffmanType.MTX);
          const objMatrix = this.jocMatrix[obj];
          for (let dp = 0; dp < this.dataPoints[obj]; ++dp) {
            const dpMatrix = objMatrix[dp];
            for (let ch = 0; ch < this.channelCount; ++ch) {
              const chMatrix = dpMatrix[ch];
              for (let pb = 0; pb < this.bands[obj]; ++pb) {
                chMatrix[pb] = huffmanDecode(codeTable, extractor);
              }
            }
          }
        }
      }
    }
  }

  /** Checks if the cache is ready for the given number of objects and
      channels, and fixes it if not (UpdateCache; the matrix caches are in
      joc/matrix.ts). */
  private updateCache(): void {
    if (this.objectActive.length === this.objectCount && this.jocMatrix[0]?.[0]?.length === this.channelCount) {
      return;
    }
    const n = this.objectCount;
    this.objectActive = new Array<boolean>(n).fill(false);
    this.bandsIndex = new Array<number>(n).fill(0);
    this.bands = new Array<number>(n).fill(0);
    this.sparseCoded = new Array<boolean>(n).fill(false);
    this.quantizationTable = new Array<number>(n).fill(0);
    this.steepSlope = new Array<boolean>(n).fill(false);
    this.dataPoints = new Array<number>(n).fill(0);
    this.timeslotOffsets = [];
    this.jocChannel = [];
    this.jocVector = [];
    this.jocMatrix = [];
    for (let obj = 0; obj < n; ++obj) {
      this.timeslotOffsets[obj] = new Int32Array(maxDataPoints);
      this.jocChannel[obj] = [];
      this.jocVector[obj] = [];
      this.jocMatrix[obj] = [];
      for (let dp = 0; dp < maxDataPoints; ++dp) {
        this.jocChannel[obj][dp] = new Int32Array(maxBands);
        this.jocVector[obj][dp] = new Int32Array(maxBands);
        this.jocMatrix[obj][dp] = [];
        for (let ch = 0; ch < this.channelCount; ++ch) {
          this.jocMatrix[obj][dp][ch] = new Int32Array(maxBands);
        }
      }
    }
  }
}

/** Read a Huffman-coded value from the bitstream. */
function huffmanDecode(codeTable: number[][], extractor: BitExtractor): number {
  let node = 0;
  do {
    node = codeTable[node][extractor.readBitInt()];
  } while (node > 0);
  return ~node;
}
