/* Per-channel exponent and bit allocation state for the E-AC-3 parser.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Transcoders/EnhancedAC3Body/Allocation.cs,
           AllocationParsing.cs, AllocationConstants.cs, AllocationHistory.cs,
           DeltaBitAllocation.cs, BitAllocation.cs (LogAdd)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Parse-only: AMC's engine decodes the core with FFmpeg, so this never
   dequantises mantissas or runs the IMDCT. ReadTransformCoeffs becomes
   skipTransformCoeffs. It counts mantissa bits exactly as Cavern does
   before its own read, skips them, and advances the shared grouped-mantissa
   positions the same way DecodeTransformCoeffs would. */

import type { BitExtractor } from './bit-extractor';
import { DeltaBitAllocationMode, ExpStrat, bitsToRead, bndtab, latab, masktab } from './eac3-consts';

/** EnhancedAC3Body's AllocationHistory: grouped-mantissa positions shared by
    every allocation of one block. */
export interface MantissaHistory {
  bap1Pos: number;
  bap2Pos: number;
  bap4Pos: number;
}

export class DeltaBitAllocation {
  enabled: number = DeltaBitAllocationMode.NoAllocation;
  offset: number[] = [];
  length: number[] = [];
  bitAllocation: number[] = [];

  reset(): void {
    this.enabled = DeltaBitAllocationMode.NoAllocation;
    this.offset = [];
    this.length = [];
    this.bitAllocation = [];
  }

  read(extractor: BitExtractor): void {
    const segments = extractor.read(3) + 1;
    if (this.offset.length !== segments) {
      this.offset = new Array<number>(segments).fill(0);
      this.length = new Array<number>(segments).fill(0);
      this.bitAllocation = new Array<number>(segments).fill(0);
    }
    for (let segment = 0; segment < segments; segment++) {
      this.offset[segment] = extractor.read(5);
      this.length[segment] = extractor.read(4);
      this.bitAllocation[segment] = extractor.read(3);
    }
  }
}

export class Allocation {
  absoluteExponent = 0;
  readonly groupedExponents: Int32Array;
  readonly exponents: Int32Array;
  readonly psd: Int32Array;
  readonly integratedPSD: Int32Array;
  readonly excite: Int32Array;
  readonly mask: Int32Array;
  readonly bap: Uint8Array;

  constructor(private readonly host: MantissaHistory, maxLength: number) {
    this.groupedExponents = new Int32Array(maxLength);
    this.exponents = new Int32Array(maxLength);
    this.psd = new Int32Array(maxLength);
    this.integratedPSD = new Int32Array(maxLength);
    this.excite = new Int32Array(maxLength);
    this.mask = new Int32Array(maxLength);
    this.bap = new Uint8Array(maxLength);
  }

  /* ---- AllocationParsing.cs ---- */

  readChannelExponents(extractor: BitExtractor, expstr: number, nchgrps: number): void {
    this.readExponents(extractor, nchgrps);
    extractor.skip(2); // This is gainrng, telling the max gain as 1/(2^gainrng). It's useless.
    this.ungroupExponents(nchgrps, expstr, 0, 1);
  }

  readCouplingExponents(extractor: BitExtractor, expstr: number, startMantissa: number, ncplgrps: number): void {
    this.readExponents(extractor, ncplgrps);
    this.absoluteExponent <<= 1;
    this.ungroupExponents(ncplgrps, expstr, startMantissa, startMantissa);
  }

  readLFEExponents(extractor: BitExtractor, nlfegrps: number, lfestrtmant: number): void {
    this.absoluteExponent = extractor.read(4);
    this.groupedExponents[0] = extractor.read(7);
    this.groupedExponents[1] = extractor.read(7);
    this.ungroupExponents(nlfegrps, ExpStrat.D15, lfestrtmant, lfestrtmant + 1);
  }

  private readExponents(extractor: BitExtractor, ngrps: number): void {
    this.absoluteExponent = extractor.read(4);
    for (let group = 0; group < ngrps; group++) {
      this.groupedExponents[group] = extractor.read(7);
    }
  }

  private ungroupExponents(ngrps: number, expstr: number, startMantissa: number, exponentOffset: number): void {
    const exponents = this.exponents;
    const psd = this.psd;
    const integratedPSD = this.integratedPSD;
    // Ungrouping and decoding exponents
    const grpsize = expstr !== ExpStrat.D45 ? expstr : 4;
    let absexp = this.absoluteExponent; // Rolling differential decoding value (dexp in the reference code)
    let endMantissa = exponentOffset;
    exponents[0] = absexp;
    for (let grp = 0; grp < ngrps; grp++) {
      const expacc = this.groupedExponents[grp];
      absexp += Math.trunc(expacc / 25) - 2; // Ungroup and unbias mapped values in the same step
      for (let j = 0; j < grpsize; j++) {
        exponents[endMantissa++] = absexp;
      }

      absexp += Math.trunc((expacc % 25) / 5) - 2;
      for (let j = 0; j < grpsize; j++) {
        exponents[endMantissa++] = absexp;
      }

      absexp += (expacc % 5) - 2;
      for (let j = 0; j < grpsize; j++) {
        exponents[endMantissa++] = absexp;
      }
    }

    // Exponent mapping into PSD
    for (let bin = startMantissa; bin < endMantissa; bin++) {
      psd[bin] = 3072 - (exponents[bin] << 7);
    }

    // PSD integration
    let i = startMantissa;
    let k = masktab[startMantissa];
    let lastbin: number;
    do {
      lastbin = Math.min(bndtab[k], endMantissa);
      integratedPSD[k] = psd[i++];
      while (i < lastbin) {
        integratedPSD[k] = logAdd(integratedPSD[k], psd[i++]);
      }
      k++;
    } while (endMantissa > lastbin);
  }

  /* ---- Allocation.cs, ReadTransformCoeffs + DecodeTransformCoeffs ---- */

  /** Skip this allocation's mantissas for bins [start, end). */
  skipTransformCoeffs(extractor: BitExtractor, start: number, end: number): void {
    const bap = this.bap;
    const host = this.host;
    let mantissaBits = 0;
    let n1 = 0;
    let n2 = 0;
    let n3 = 0;
    let n4 = 0;
    for (let bin = start; bin < end; ++bin) {
      const b = bap[bin];
      if (b === 1) ++n1;
      else if (b === 2) ++n2;
      else if (b === 3) ++n3;
      else if (b === 4) ++n4;
      else mantissaBits += bitsToRead[b];
    }
    mantissaBits +=
      Math.trunc((host.bap1Pos + n1) / 3) * bitsToRead[1] +
      Math.trunc((host.bap2Pos + n2) / 3) * bitsToRead[2] +
      n3 * bitsToRead[3] +
      Math.trunc((host.bap4Pos + n4) / 2) * bitsToRead[4];
    if (extractor.position + mantissaBits > extractor.backPosition) {
      throw new RangeError('E-AC-3 mantissas run past the end of the frame');
    }
    extractor.skip(mantissaBits);
    // DecodeTransformCoeffs: `if (++bapNPos == N) { read group; bapNPos = 0; }` per bin.
    host.bap1Pos = (host.bap1Pos + n1) % 3;
    host.bap2Pos = (host.bap2Pos + n2) % 3;
    host.bap4Pos = (host.bap4Pos + n4) % 2;
  }
}

/** EnhancedAC3Body.LogAdd */
export function logAdd(a: number, b: number): number {
  const c = a - b;
  const address = Math.min(Math.abs(c) >> 1, 255);
  if (c >= 0) {
    return a + latab[address];
  }
  return b + latab[address];
}
