/* The scratch voice's byte helpers (src/audio/scratch/formats.ts), checked
   against ffmpeg: an AAC window cut from an .m4a and wrapped as ADTS must
   decode, and start at the time the sample table says; a WAV window must
   come back whole; LAME's tags must be read. The browser half (decoding
   FLAC / MP3 / WAV windows in Chromium) is test/browser/scratch.e2e.mjs.

     npm run test:engine

   Skips the ffmpeg checks when ffmpeg is not installed. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demuxMp4, fileReader, sampleAtFrame } from '../src/audio/mp4samples.ts';
import { adtsFrame, adtsFromAsc, ascFromMoov, buildWav, findMp3Sync, id3v2Size, mp3FrameAt, readWavLayout, readXing } from '../src/audio/scratch/formats.ts';

const FFMPEG = [process.env.AMC_FFMPEG, 'ffmpeg'].filter(Boolean).find((f) => spawnSync(f, ['-hide_banner', '-version']).status === 0) || null;
const skip = !FFMPEG && 'needs ffmpeg';
const CHIRP = 'sin(2*PI*(200*mod(t\\,20)+25*mod(t\\,20)*mod(t\\,20)))';

function ff(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** Decodes any file ffmpeg reads to mono float32 at 44.1 kHz. */
function decode(path) {
  const out = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-']);
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

function freq(x, rate) {
  const at = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) at.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  const d = [];
  for (let i = 1; i < at.length; i++) d.push(at[i] - at[i - 1]);
  d.sort((a, b) => a - b);
  return rate / d[d.length >> 1];
}

test('HE-AAC configs map to their core for ADTS', () => {
  /* aot 5 (SBR), core rate index 7 (22050), stereo, ext rate 44100, core aot 2 */
  assert.deepEqual(adtsFromAsc(Uint8Array.of(0x2b, 0x92, 0x08)), { profile: 1, rateIndex: 7, channelConfig: 2 });
  /* plain LC 44.1 kHz stereo */
  assert.deepEqual(adtsFromAsc(Uint8Array.of(0x12, 0x10)), { profile: 1, rateIndex: 4, channelConfig: 2 });
});

test('an AAC window wrapped as ADTS decodes, starting where the sample table says', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amc-scratch-fmt-'));
  try {
    const m4a = join(dir, 'chirp.m4a');
    ff(['-f', 'lavfi', '-i', `aevalsrc=${CHIRP}:s=44100:d=30`, '-ac', '2', '-c:a', 'aac', '-b:a', '160k', m4a]);
    const buf = new Uint8Array(readFileSync(m4a));
    const d = await demuxMp4(fileReader(buf), buf.length);
    {
      assert.equal(d.codec, 'mp4a');
      const asc = ascFromMoov(buf.subarray(d.moovStart, d.moovStart + d.moovSize));
      assert.ok(asc, 'esds found');
      const cfg = adtsFromAsc(asc);
      assert.deepEqual(cfg, { profile: 1, rateIndex: 4, channelConfig: 2 });
      const k0 = sampleAtFrame(d, 12 * d.sampleRate + d.startSkip) - 2;
      const k1 = sampleAtFrame(d, 16 * d.sampleRate + d.startSkip);
      const parts = [];
      let total = 0;
      for (let k = k0; k <= k1; k++) {
        const raw = buf.subarray(d.offsets[k], d.offsets[k] + d.sizes[k]);
        parts.push(raw);
        total += raw.length + 7;
      }
      const adts = new Uint8Array(total);
      let p = 0;
      for (const raw of parts) p = adtsFrame(cfg, raw, adts, p);
      const aac = join(dir, 'win.aac');
      writeFileSync(aac, adts);
      const pcm = decode(aac);
      const start = (d.pts[k0] - d.startSkip) / d.sampleRate;
      assert.ok(pcm.length / 44100 > 3.5, 'the window decodes (' + (pcm.length / 44100).toFixed(2) + ' s)');
      const at = Math.round(1 * 44100);
      const f = freq(pcm.subarray(at, at + 2048), 44100);
      const truth = (f - 200) / 50;
      const claimed = start + (at + 1024) / 44100;
      /* ffmpeg's own AAC decoder delay, as Chrome's: within a frame */
      assert.ok(Math.abs(claimed - truth) < 0.03, `off by ${(claimed - truth).toFixed(4)} s`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a WAV window comes back whole behind a rebuilt header', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amc-scratch-fmt-'));
  try {
    const wav = join(dir, 'tone.wav');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-ac', '2', '-c:a', 'pcm_s24le', '-metadata', 'title=x', wav]);
    const buf = new Uint8Array(readFileSync(wav));
    const w = await readWavLayout((a, b) => Promise.resolve(buf.subarray(a, b)), buf.length);
    assert.ok(w);
    assert.equal(w.rate, 48000);
    assert.equal(w.blockAlign, 6);
    assert.equal(w.frames, 480000);
    const data = buf.subarray(w.dataStart + 96000 * 6, w.dataStart + 144000 * 6);
    const out = join(dir, 'win.wav');
    writeFileSync(out, buildWav(w.fmt, data));
    const pcm = decode(out);
    assert.equal(Math.round((pcm.length / 44100) * 1000), 1000);
    assert.ok(Math.abs(freq(pcm, 44100) - 440) < 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAME's Info tag: constant bitrate and the encoder delay", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'amc-scratch-fmt-'));
  try {
    const mp3 = join(dir, 'cbr.mp3');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=tagged', mp3]);
    const buf = new Uint8Array(readFileSync(mp3));
    const skipId3 = id3v2Size(buf);
    assert.ok(skipId3 > 10, 'ffmpeg writes an ID3v2 tag');
    const at = findMp3Sync(buf, skipId3);
    assert.equal(at, skipId3);
    const f = mp3FrameAt(buf, at);
    assert.equal(f.rate, 44100);
    assert.equal(f.spf, 1152);
    const x = readXing(buf, at, f);
    assert.ok(x, 'Info tag');
    assert.equal(x.cbr, true);
    assert.equal(x.encDelay, 576);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
