/* QMF filterbank: the FFT factorisation equals Cavern's direct evaluation,
   and analysis → synthesis reconstructs the input after a fixed delay.
   AMC-original test code. */

import { QmfAnalysis, QmfSynthesis, qmfCoefficients, subbands } from '../../src/audio/atmos/joc/qmf';
import { assert, log, run, test } from './util';

/** Cavern's ProcessForward / ProcessInverse, transcribed directly (float64). */
class DirectQmf {
  private streamF = new Float64Array(640);
  private streamI = new Float64Array(1280);
  private c = qmfCoefficients();

  forward(input: Float32Array, off: number, re: Float64Array, im: Float64Array): void {
    const s = this.streamF;
    s.copyWithin(64, 0, 576);
    for (let i = 0; i < 64; i++) s[i] = input[off + 63 - i];
    const g = new Float64Array(128);
    for (let j = 0; j < 128; j++) for (let k = 0; k < 640; k += 128) g[j] += s[j + k] * this.c[j + k];
    for (let sb = 0; sb < 64; sb++) {
      let r = 0;
      let m = 0;
      for (let j = 0; j < 128; j++) {
        const e = (Math.PI * (sb + 0.5) * (j - 0.5)) / 64;
        r += Math.cos(e) * g[j];
        m += Math.sin(e) * g[j];
      }
      re[sb] = r;
      im[sb] = m;
    }
  }

  inverse(re: Float64Array, im: Float64Array, out: Float32Array, off: number): void {
    const s = this.streamI;
    s.copyWithin(128, 0, 1152);
    for (let j = 0; j < 128; j++) {
      let v = 0;
      for (let sb = 0; sb < 64; sb++) {
        const e = (Math.PI * (sb + 0.5) * (j - 128 + 0.5)) / 64;
        v += (Math.cos(e) / 64) * re[sb] + (Math.sin(e) / 64) * -im[sb];
      }
      s[j] = v;
    }
    for (let i = 0; i < 64; i++) {
      let o = 0;
      for (let j = 0; j < 5; j++) o += s[256 * j + i] * this.c[128 * j + i] + s[256 * j + 192 + i] * this.c[128 * j + 64 + i];
      out[off + i] = o;
    }
  }
}

function noise(n: number, seed = 1): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    x[i] = seed / 4294967296 - 0.5;
  }
  return x;
}

test('FFT analysis/synthesis equal Cavern\'s direct sums', () => {
  const frame = 1536;
  const frames = 4;
  const x = noise(frame * frames);
  const fast = new QmfAnalysis(frame);
  const direct = new DirectQmf();
  const fs = new QmfSynthesis();
  const reF = new Float64Array(64), imF = new Float64Array(64), reD = new Float64Array(64), imD = new Float64Array(64);
  const outF = new Float32Array(64), outD = new Float32Array(64);
  let maxA = 0;
  let maxS = 0;
  for (let f = 0; f < frames; f++) {
    fast.loadFrame(x.subarray(f * frame), frame);
    for (let ts = 0; ts < frame / 64; ts++) {
      fast.forward(ts, reF, imF);
      direct.forward(x, f * frame + ts * 64, reD, imD);
      for (let sb = 0; sb < 64; sb++) maxA = Math.max(maxA, Math.abs(reF[sb] - reD[sb]), Math.abs(imF[sb] - imD[sb]));
      fs.inverse(reD, imD, outF, 0, 1);
      direct.inverse(reD, imD, outD, 0);
      for (let i = 0; i < 64; i++) maxS = Math.max(maxS, Math.abs(outF[i] - outD[i]));
    }
  }
  log(`max |fast − direct|: analysis ${maxA.toExponential(2)}, synthesis ${maxS.toExponential(2)}`);
  assert(maxA < 1e-6 && maxS < 1e-6, 'factorised transform matches the direct one');
});

test('analysis → synthesis is a pure delay (measured)', () => {
  const frame = 1536;
  const frames = 6;
  const x = noise(frame * frames, 7);
  const a = new QmfAnalysis(frame);
  const s = new QmfSynthesis();
  const re = new Float64Array(subbands), im = new Float64Array(subbands);
  const y = new Float32Array(x.length);
  for (let f = 0; f < frames; f++) {
    a.loadFrame(x.subarray(f * frame), frame);
    for (let ts = 0; ts < frame / 64; ts++) {
      a.forward(ts, re, im);
      s.inverse(re, im, y, f * frame + ts * 64, 1);
    }
  }
  // Find the delay with the best fit, then the reconstruction error there.
  let best = 0;
  let bestErr = Infinity;
  let bestGain = 0;
  for (let d = 0; d < 1200; d++) {
    let xy = 0, xx = 0;
    for (let n = 2000; n < x.length - 1300; n++) { xy += x[n] * y[n + d]; xx += x[n] * x[n]; }
    const g = xy / xx;
    let err = 0;
    for (let n = 2000; n < x.length - 1300; n++) err += (y[n + d] - g * x[n]) ** 2;
    if (err < bestErr) { bestErr = err; best = d; bestGain = g; }
  }
  let sig = 0;
  for (let n = 2000; n < x.length - 1300; n++) sig += (bestGain * x[n]) ** 2;
  const snr = 10 * Math.log10(sig / bestErr);
  log(`round-trip delay ${best} samples, gain ${bestGain.toFixed(5)}, reconstruction SNR ${snr.toFixed(1)} dB`);
  assert(best === 577, 'QMF round trip delay is 577 samples');
  assert(Math.abs(bestGain - 1) < 0.01 && snr > 60, 'near-perfect reconstruction');
});

test('inverseSilent drains the filter memory, then outputs exact zeros', () => {
  const s = new QmfSynthesis();
  const re = new Float64Array(64).fill(0.5), im = new Float64Array(64);
  const out = new Float32Array(64);
  s.inverse(re, im, out, 0, 1);
  let tail = 0;
  for (let t = 0; t < 12; t++) {
    s.inverseSilent(out, 0);
    const e = out.reduce((a, v) => a + Math.abs(v), 0);
    if (t < 9) tail += e;
    if (t >= 10) assert(e === 0, `silent after drain (t=${t})`);
  }
  assert(tail > 0, 'memory drains over the following timeslots');
});

run();
