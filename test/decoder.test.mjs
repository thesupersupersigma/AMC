/* Decoder tests: load vendor/decoder/decoder.wasm through its JS loader and
   decode real ALAC bitstreams (verbatim frames built by test/helpers) plus,
   when scripts/make-fixtures.sh has been run, every fixture — compared
   against ffmpeg's own `-f f32le` reference: bit-exact for ALAC, within
   1e-4 for AC-3/E-AC-3.

   Against the silent STUB decoder the value comparisons cannot hold; the
   suite then checks frame counts and channel shapes only and says so. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDecoderModule } from '../vendor/decoder/decoder.js';
import { alacAtom, eac3Frame, ac3Frame } from './helpers/mp4build.mjs';
import { alacPackets, testPcm } from './helpers/alac.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = join(ROOT, 'vendor/decoder/decoder.wasm');
const FIXTURES = join(ROOT, 'test/fixtures');

const logs = [];
const mod = await loadDecoderModule(readFileSync(WASM), (l) => logs.push(l));
if (mod.isStub) {
  console.log('\n*** decoder.wasm is the SILENT STUB (' + mod.version + ').');
  console.log('*** Sample-value checks are skipped; frame counts and shapes are still verified.');
  console.log('*** Run the build-decoder workflow (or vendor/decoder/build.sh) for the real FFmpeg decoder.\n');
} else {
  console.log('decoder:', mod.version);
}

function checkAlac(bitDepth, channels, frames, frameLength) {
  const pcm = testPcm(frames, channels, bitDepth, 7 + bitDepth + channels);
  const { packets, durations } = alacPackets(pcm, bitDepth, frameLength);
  const rate = bitDepth === 24 ? 96000 : 44100;
  const dec = mod.open('alac', alacAtom({ frameLength, bitDepth, channels, sampleRate: rate }), rate, channels);
  assert.ok(dec, 'decoder opened');
  const scale = 2 ** (bitDepth - 1);
  let at = 0;
  packets.forEach((p, i) => {
    const out = dec.decode(p);
    assert.ok(out, 'packet ' + i + ' decoded');
    assert.equal(out.frames, durations[i], 'frames in packet ' + i);
    assert.equal(out.planes.length, channels, 'channels in packet ' + i);
    if (!mod.isStub) {
      for (let c = 0; c < channels; c++) {
        for (let s = 0; s < out.frames; s++) {
          const want = Math.fround(pcm[c][at + s] / scale);
          if (out.planes[c][s] !== want) assert.fail('ch' + c + ' frame ' + (at + s) + ': got ' + out.planes[c][s] + ', want ' + want);
        }
      }
    }
    at += out.frames;
  });
  assert.equal(at, frames, 'total frames');
  dec.close();
}

test('ALAC 16-bit stereo, verbatim frames, partial last frame', () => {
  checkAlac(16, 2, 4096 * 5 + 1234, 4096);
});

test('ALAC 24-bit mono at 96 kHz, verbatim frames', () => {
  checkAlac(24, 1, 4096 * 3 + 17, 4096);
});

test('ALAC 16-bit stereo with a 352-frame frameLength', () => {
  checkAlac(16, 2, 352 * 9, 352);
});

test('flush and reuse after a seek', () => {
  const pcm = testPcm(4096 * 3, 2, 16, 3);
  const { packets } = alacPackets(pcm, 16, 4096);
  const dec = mod.open('alac', alacAtom({}), 44100, 2);
  dec.decode(packets[0]);
  dec.flush();
  const out = dec.decode(packets[2]);
  assert.equal(out.frames, 4096);
  if (!mod.isStub) assert.equal(out.planes[1][100], Math.fround(pcm[1][8192 + 100] / 32768));
  dec.close();
});

test('unknown codec is refused', () => {
  assert.equal(mod.open('ac-4', null, 48000, 2), null);
});

test('stub-only: E-AC-3 / AC-3 frame counts from syncframe headers', { skip: !mod.isStub && 'real decoder: synthetic payloads are not decodable audio' }, () => {
  const e = mod.open('ec-3', null, 48000, 6);
  const out = e.decode(eac3Frame());
  assert.equal(out.frames, 1536);
  assert.equal(out.planes.length, 6);
  e.close();
  const a = mod.open('ac-3', null, 48000, 2);
  assert.equal(a.decode(ac3Frame()).frames, 1536);
  a.close();
});

/* ---------- fixtures from scripts/make-fixtures.sh ---------- */

const fixtureFiles = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith('.m4a') && existsSync(join(FIXTURES, f.replace(/\.m4a$/, '.f32')))) : [];

test('fixtures against ffmpeg reference PCM', { skip: !fixtureFiles.length && 'no fixtures — run scripts/make-fixtures.sh (needs ffmpeg)' }, async (t) => {
  const { demuxMp4, fileReader } = await import('../src/audio/mp4samples.ts');
  for (const name of fixtureFiles) {
    await t.test(name, async () => {
      const bytes = readFileSync(join(FIXTURES, name));
      const demux = await demuxMp4(fileReader(bytes), bytes.length);
      const ref = new Float32Array(readFileSync(join(FIXTURES, name.replace(/\.m4a$/, '.f32'))).buffer.slice(0));
      const dec = mod.open(demux.codec, demux.extradata, demux.sampleRate, demux.channels);
      assert.ok(dec, 'opened ' + demux.codec);
      const tol = demux.codec === 'alac' ? 0 : 1e-4;
      const planes = [];
      let frames = 0;
      for (let i = 0; i < demux.count; i++) {
        const off = demux.offsets[i];
        const out = dec.decode(bytes.subarray(off, off + demux.sizes[i]));
        assert.ok(out, 'packet ' + i);
        out.planes.forEach((p, c) => {
          (planes[c] = planes[c] || []).push(p);
        });
        frames += out.frames;
      }
      const channels = planes.length;
      const flat = planes.map((list) => {
        const all = new Float32Array(frames);
        let at = 0;
        for (const p of list) {
          all.set(p, at);
          at += p.length;
        }
        return all;
      });
      /* ffmpeg applies the edit list (encoder priming), so the reference is
         the trimmed stream — exactly what the engine plays. */
      const playable = Math.min(demux.playFrames, frames - demux.startSkip);
      const refFrames = ref.length / channels;
      /* ALAC must match exactly. For (E-)AC-3, ffmpeg's decoder ignores the
         edit list's END trim (it plays the encoder padding) while AMC honours
         it, and the edit list is only millisecond-precise — so allow up to
         one codec frame of difference and compare the overlap. */
      if (demux.codec === 'alac') assert.equal(playable, refFrames, 'frame count vs reference');
      else assert.ok(Math.abs(playable - refFrames) <= 1536, 'frame count ' + playable + ' vs reference ' + refFrames);
      const compare = Math.min(playable, refFrames);
      if (!mod.isStub) {
        let worst = 0;
        for (let s = 0; s < compare; s++) {
          for (let c = 0; c < channels; c++) {
            const d = Math.abs(flat[c][demux.startSkip + s] - ref[s * channels + c]);
            if (d > worst) worst = d;
          }
        }
        assert.ok(worst <= tol, 'max abs error ' + worst + ' > ' + tol);
      }
      dec.close();
    });
  }
});

test('decoder logged nothing unexpected', () => {
  assert.deepEqual(
    logs.filter((l) => /unprovided import/.test(l)),
    []
  );
});
