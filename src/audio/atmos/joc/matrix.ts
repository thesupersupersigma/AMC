/* JOC matrix dequantisation and per-timeslot interpolation.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3/JointObjectCodingDecoder.cs,
           JointObjectCodingCache.cs (prevMatrix, mixMatrix, interpolatedMatrix)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Layout: Cavern's float[obj][dp][ch][sb] and float[obj][ts][ch][sb] jagged
   arrays become one Float32Array per object, indexed (dp*C + ch)*64 + sb
   and (ts*C + ch)*64 + sb, where C is the JOC channel count.

   Dequantisation reproduces C#'s float32 arithmetic exactly (Math.fround on
   every operation). A modulo is involved, so a one-ulp difference could
   land a coefficient on the other side of the wrap. Interpolation stores
   into Float32Array without per-operation rounding: at most a one-ulp
   difference, with no discontinuity. */

import { getParameterBandMapping, subbands } from '../bitstream/joc-tables';
import type { JointObjectCoding } from '../bitstream/joc';
import { maxDataPoints, maxJocObjects } from '../bitstream/joc';

const f = Math.fround;

/** Largest JOC input channel count (JointObjectCodingTables.inputMatrix). */
export const maxJocChannels = 7;

export class JocMatrixDecoder {
  /** [obj]: previous matrix per channel and subband, (ch*64 + sb). */
  private readonly prevMatrix: Float32Array[] = [];
  /** [obj]: decoded matrix per data point, channel and band. */
  private readonly mixMatrix: Float32Array[] = [];
  /** [obj]: interpolated matrix per timeslot, channel and subband. */
  readonly interpolatedMatrix: Float32Array[] = [];
  /** [obj]: every value of the last computed matrices is zero. */
  readonly silent: boolean[] = [];
  /** [obj]: the frame is a plain linear ramp from lerpFrom to lerpTo
      (one data point, no steep slope), evaluated by the applier per
      timeslot instead of being tabulated in interpolatedMatrix. AMC
      optimisation, same values; never used with cavernCompat. */
  readonly lerpMode: boolean[] = [];
  /** [obj]: (ch*64 + sb) start and end of the ramp. */
  readonly lerpFrom: Float32Array[] = [];
  readonly lerpTo: Float32Array[] = [];

  constructor(private readonly maxTimeslots: number, private readonly cavernCompat: boolean) {
    for (let obj = 0; obj < maxJocObjects; ++obj) {
      this.prevMatrix[obj] = new Float32Array(maxJocChannels * subbands);
      this.silent[obj] = true;
      this.lerpMode[obj] = false;
    }
  }

  /** Allocates an object's decoded/interpolated caches on first use. Only
      done when a stream's object count grows, never per frame. */
  private ensure(obj: number): void {
    if (!this.mixMatrix[obj]) {
      this.mixMatrix[obj] = new Float32Array(maxDataPoints * maxJocChannels * subbands);
      this.interpolatedMatrix[obj] = new Float32Array(this.maxTimeslots * maxJocChannels * subbands);
      this.lerpFrom[obj] = new Float32Array(maxJocChannels * subbands);
      this.lerpTo[obj] = new Float32Array(maxJocChannels * subbands);
    }
  }

  /** Get the object mixing matrices for a frame of `timeslots` QMF timeslots
      (JointObjectCoding.GetMixingMatrices). */
  compute(joc: JointObjectCoding, timeslots: number): void {
    for (let obj = 0; obj < joc.objectCount; obj++) {
      this.ensure(obj);
      this.getMixingMatrices(joc, obj, timeslots);
    }
  }

  /** Decode and dequantize a complete JOC matrix around a quantized center value. */
  private decodeCoarse(joc: JointObjectCoding, obj: number, quantizedCenter: number, gainStep: number): void {
    const center = f(quantizedCenter * gainStep);
    const max = f(center * 2);
    const bands = joc.bands[obj];
    const C = joc.channelCount;
    const mix = this.mixMatrix[obj];
    for (let dp = 0; dp < joc.dataPoints[obj]; dp++) {
      const dpSource = joc.jocMatrix[obj][dp];
      for (let ch = 0; ch < C; ch++) {
        const source = dpSource[ch];
        const base = (dp * C + ch) * subbands;
        // DecodeCoarseChannel: frequency-differential, wrapped into [0, max)
        let value = f(f(center + f(source[0] * gainStep)) % max);
        for (let b = 1; b < bands; b++) {
          const next = f(f(value + f(source[b] * gainStep)) % max);
          mix[base + b - 1] = f(value - center);
          value = next;
        }
        mix[base + bands - 1] = f(value - center);
      }
    }
  }

  /** Convert the values of the decoded JOC matrix to the mixing range
      (Dequantize). Cavern only ever calls it with gainStep 0, for sparse
      objects, which zeroes them. */
  private dequantize(joc: JointObjectCoding, obj: number, center: number, gainStep: number): void {
    const C = joc.channelCount;
    const mix = this.mixMatrix[obj];
    for (let dp = 0; dp < joc.dataPoints[obj]; dp++) {
      for (let ch = 0; ch < C; ch++) {
        const base = (dp * C + ch) * subbands;
        for (let b = 0; b < joc.bands[obj]; b++) {
          mix[base + b] = f(f(mix[base + b] - center) * gainStep);
        }
      }
    }
  }

  private getMixingMatrices(joc: JointObjectCoding, obj: number, timeslots: number): void {
    const C = joc.channelCount;
    const interp = this.interpolatedMatrix[obj];
    const prev = this.prevMatrix[obj];
    const mix = this.mixMatrix[obj];
    const centerValue = joc.quantizationTable[obj] * 48 + 48;
    if (joc.objectActive[obj]) {
      const gainStep = f(f(0.2) - f(joc.quantizationTable[obj] * f(0.1)));
      if (joc.sparseCoded[obj]) {
        // Call DecodeSparse and revert 0 to gainStep when the standard documentation is fixed
        this.dequantize(joc, obj, centerValue, 0);
      } else {
        this.decodeCoarse(joc, obj, centerValue, gainStep);
      }
    } else {
      // The final result is in the interpolation matrix. The previous
      // matrix is left as it was (Cavern returns before updating it).
      interp.fill(0, 0, timeslots * C * subbands);
      this.silent[obj] = true;
      this.lerpMode[obj] = false;
      return;
    }
    this.lerpMode[obj] = false;

    const pbMapping = getParameterBandMapping()[joc.bandsIndex[obj]];
    const offsets = joc.timeslotOffsets[obj];
    const compat = this.cavernCompat;
    if (joc.dataPoints[obj] === 1) {
      if (joc.steepSlope[obj]) {
        const splitPoint = offsets[0];
        for (let ts = 0; ts < splitPoint && ts < timeslots; ts++) {
          for (let ch = 0; ch < C; ch++) {
            interp.set(prev.subarray(ch * subbands, ch * subbands + subbands), (ts * C + ch) * subbands);
          }
        }
        for (let ts = splitPoint; ts < timeslots; ts++) {
          // Cavern: mixMatrix[ts < timeslotOffsets[obj][1] ? 1 : 0], where the
          // second offset and data point are stale leftovers of an earlier
          // two-point frame. DEVIATION: one data point means data point 0.
          const dp = compat && ts < offsets[1] ? 1 : 0;
          for (let ch = 0; ch < C; ch++) {
            const src = (dp * C + ch) * subbands;
            const dst = (ts * C + ch) * subbands;
            for (let sb = 0; sb < subbands; sb++) interp[dst + sb] = mix[src + pbMapping[sb]];
          }
        }
      } else if (!compat) {
        // Linear ramp from the previous matrix to this one across the frame:
        // hand the endpoints to the applier (see lerpMode).
        const from = this.lerpFrom[obj];
        const to = this.lerpTo[obj];
        let nonzero = false;
        for (let ch = 0; ch < C; ch++) {
          const p = ch * subbands;
          for (let sb = 0; sb < subbands; sb++) {
            const a = prev[p + sb];
            const b = mix[p + pbMapping[sb]];
            from[p + sb] = a;
            to[p + sb] = b;
            prev[p + sb] = b;
            if (a !== 0 || b !== 0) nonzero = true;
          }
        }
        this.lerpMode[obj] = true;
        this.silent[obj] = !nonzero;
        return;
      } else {
        for (let ch = 0; ch < C; ch++) {
          const p = ch * subbands;
          const m = ch * subbands; // data point 0
          for (let ts = 0; ts < timeslots; ) {
            const dst = (ts * C + ch) * subbands;
            const lerp = f(++ts / timeslots);
            for (let sb = 0; sb < subbands; sb++) {
              const from = prev[p + sb];
              interp[dst + sb] = from + (mix[m + pbMapping[sb]] - from) * lerp;
            }
          }
        }
      }
    } else {
      if (joc.steepSlope[obj]) {
        for (let ts = 0; ts < timeslots; ) {
          const dst0 = ts * C * subbands;
          ts++;
          const fromPrev = ts < offsets[0];
          for (let ch = 0; ch < C; ch++) {
            const dst = dst0 + ch * subbands;
            if (fromPrev) {
              interp.set(prev.subarray(ch * subbands, ch * subbands + subbands), dst);
            } else {
              // Cavern copies data point 0 by subband index, not through the
              // band mapping. DEVIATION unless cavernCompat.
              const src = ch * subbands;
              for (let sb = 0; sb < subbands; sb++) interp[dst + sb] = mix[src + (compat ? sb : pbMapping[sb])];
            }
          }
        }
      } else {
        const ts2 = timeslots >> 1;
        for (let ts = 0; ts < timeslots; ) {
          const dst0 = ts * C * subbands;
          ts++;
          if (ts <= ts2) {
            const lerp = f(ts / ts2);
            for (let ch = 0; ch < C; ch++) {
              const dst = dst0 + ch * subbands;
              const p = ch * subbands;
              const m = ch * subbands; // data point 0
              for (let sb = 0; sb < subbands; sb++) {
                const from = prev[p + sb];
                // Cavern reads data point 0 by subband index here, not
                // through the band mapping. DEVIATION unless cavernCompat.
                const to = mix[m + (compat ? sb : pbMapping[sb])];
                interp[dst + sb] = from + (to - from) * lerp;
              }
            }
          } else {
            const lerp = f((ts - ts2) / (timeslots - ts2));
            for (let ch = 0; ch < C; ch++) {
              const dst = dst0 + ch * subbands;
              const m0 = ch * subbands;
              const m1 = (C + ch) * subbands;
              for (let sb = 0; sb < subbands; sb++) {
                const pb = pbMapping[sb];
                const from = mix[m0 + pb];
                interp[dst + sb] = from + (mix[m1 + pb] - from) * lerp;
              }
            }
          }
        }
      }
    }

    const last = (joc.dataPoints[obj] - 1) * C;
    let nonzero = false;
    for (let ch = 0; ch < C; ch++) {
      const src = (last + ch) * subbands;
      for (let sb = 0; sb < subbands; sb++) {
        const v = mix[src + pbMapping[sb]];
        prev[ch * subbands + sb] = v;
      }
    }
    const n = timeslots * C * subbands;
    for (let i = 0; i < n; i++) {
      if (interp[i] !== 0) {
        nonzero = true;
        break;
      }
    }
    this.silent[obj] = !nonzero;
  }

  /** Forget the previous matrices (seek / track change). */
  reset(): void {
    for (const p of this.prevMatrix) p.fill(0);
    for (let obj = 0; obj < this.silent.length; obj++) {
      this.silent[obj] = true;
      this.lerpMode[obj] = false;
    }
  }
}
