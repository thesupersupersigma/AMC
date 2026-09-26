/* Applies JOC matrices in the QMF domain to rebuild object signals.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3/JointObjectCodingApplier.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Cavern runs the transforms on the .NET thread pool; the Worker has one
   thread, so this runs them in sequence. Everything is preallocated in the
   constructor, and applyTimeslot allocates nothing.

   AMC additions: an object whose matrices are all zero for the frame skips
   the mixing and FFT (QmfSynthesis.inverseSilent). The result is
   identical, because Cavern would feed zeros through the same filter. */

import type { JointObjectCoding } from '../bitstream/joc';
import { maxJocObjects } from '../bitstream/joc';
import { subbands } from '../bitstream/joc-tables';
import { JocMatrixDecoder, maxJocChannels } from './matrix';
import { QmfAnalysis, QmfSynthesis } from './qmf';

export class JointObjectCodingApplier {
  readonly matrices: JocMatrixDecoder;
  /** Next timeslot to read in the current JOC. */
  private timeslot = 0;
  /** Timeslots per frame (Cavern: frameSize / subbands). */
  private readonly frameTimeslots: number;
  /** Where the timeslot counter wraps: frameTimeslots, or 7 with cavernCompat (see apply). */
  private readonly wrapAt: number;
  private readonly analysis: QmfAnalysis[] = [];
  private readonly synthesis: QmfSynthesis[] = [];
  private readonly resultsRe: Float64Array[] = [];
  private readonly resultsIm: Float64Array[] = [];
  private readonly mixRe = new Float64Array(subbands);
  private readonly mixIm = new Float64Array(subbands);

  /** `maxObjects`: object outputs to keep synthesis filters for. */
  constructor(frameSize: number, cavernCompat = false, maxObjects = maxJocObjects) {
    this.frameTimeslots = frameSize / subbands;
    // Cavern: `if (++timeslot == input.Length)`, where input is the 7-entry
    // JOC input channel array, so the matrices are recomputed every 7
    // timeslots. DEVIATION unless cavernCompat: once per frame.
    this.wrapAt = cavernCompat ? maxJocChannels : this.frameTimeslots;
    this.matrices = new JocMatrixDecoder(this.frameTimeslots, cavernCompat);
    for (let ch = 0; ch < maxJocChannels; ++ch) {
      this.analysis[ch] = new QmfAnalysis(frameSize);
      this.resultsRe[ch] = new Float64Array(subbands);
      this.resultsIm[ch] = new Float64Array(subbands);
    }
    for (let obj = 0; obj < Math.min(maxObjects, maxJocObjects); ++obj) {
      this.synthesis[obj] = new QmfSynthesis();
    }
  }

  /** Hand the analysis filters the next frame of each JOC input channel
      (FL FR FC SL SR [RL RR]); a null channel is silence. */
  loadFrame(inputs: (Float32Array | null)[], length: number): void {
    for (let ch = 0; ch < maxJocChannels; ++ch) {
      this.analysis[ch].loadFrame(inputs[ch] ?? null, length);
    }
  }

  /** Gets the audio samples of each object for the next timeslot (Apply).
      `ts` is the timeslot's index within the loaded frame. The first
      `objects` outputs receive 64 samples each at `offset`. */
  apply(ts: number, joc: JointObjectCoding, outputs: Float32Array[], offset: number, objects: number): void {
    if (this.timeslot === 0) {
      this.matrices.compute(joc, this.frameTimeslots);
    }

    // Forward transformations
    const channels = joc.channelCount;
    for (let ch = 0; ch < channels; ++ch) {
      this.analysis[ch].forward(ts, this.resultsRe[ch], this.resultsIm[ch]);
    }

    // Inverse transformations
    const gain = joc.gain;
    const rowStride = channels * subbands;
    const slot = this.timeslot;
    for (let obj = 0; obj < objects; ++obj) {
      if (obj >= joc.objectCount || this.matrices.silent[obj]) {
        this.synthesis[obj].inverseSilent(outputs[obj], offset);
        continue;
      }
      const re = this.mixRe;
      const im = this.mixIm;
      if (this.matrices.lerpMode[obj]) {
        // w = from + (to − from)·(ts+1)/timeslots, as GetMixingMatrices tabulates it.
        const from = this.matrices.lerpFrom[obj];
        const to = this.matrices.lerpTo[obj];
        const l = (slot + 1) / this.frameTimeslots;
        for (let sb = 0; sb < subbands; sb++) {
          re[sb] = 0;
          im[sb] = 0;
        }
        for (let ch = 0; ch < channels; ch++) {
          const xr = this.resultsRe[ch];
          const xi = this.resultsIm[ch];
          const row = ch * subbands;
          for (let sb = 0; sb < subbands; sb++) {
            const a = from[row + sb];
            const w = a + (to[row + sb] - a) * l;
            re[sb] += xr[sb] * w;
            im[sb] += xi[sb] * w;
          }
        }
        this.synthesis[obj].inverse(re, im, outputs[obj], offset, gain);
        continue;
      }
      const m = this.matrices.interpolatedMatrix[obj];
      const base = slot * rowStride;
      {
        const xr = this.resultsRe[0];
        const xi = this.resultsIm[0];
        for (let sb = 0; sb < subbands; sb++) {
          const w = m[base + sb];
          re[sb] = xr[sb] * w;
          im[sb] = xi[sb] * w;
        }
      }
      for (let ch = 1; ch < channels; ch++) {
        const xr = this.resultsRe[ch];
        const xi = this.resultsIm[ch];
        const row = base + ch * subbands;
        for (let sb = 0; sb < subbands; sb++) {
          const w = m[row + sb];
          re[sb] += xr[sb] * w;
          im[sb] += xi[sb] * w;
        }
      }
      this.synthesis[obj].inverse(re, im, outputs[obj], offset, gain);
    }

    if (++this.timeslot === this.wrapAt) {
      this.timeslot = 0;
    }
  }

  reset(): void {
    this.timeslot = 0;
    this.matrices.reset();
    for (const a of this.analysis) a.reset();
    for (const s of this.synthesis) s.reset();
  }
}
