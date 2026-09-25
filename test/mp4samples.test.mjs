/* Unit tests for src/audio/mp4samples.ts: sample counts, offsets, PTS, seek
   lookup, co64, stz2, moov-at-end, multi-trak with a cover-art trak, edit
   lists, codec configs. MP4s are built in memory (test/helpers/mp4build);
   ffmpeg fixtures are demuxed too when scripts/make-fixtures.sh has run. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { demuxMp4, fileReader, parseChunkOffsets, parseDec3, parseDac3, parseSampleSizes, sampleAtFrame, isEngineCodec } from '../src/audio/mp4samples.ts';
import { ac3Frame, alacAtom, buildMp4, dac3Box, dec3Box, eac3Frame, fullbox, u32, u64 } from './helpers/mp4build.mjs';
import { alacPackets, testPcm } from './helpers/alac.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function alacTrack(opts = {}) {
  const frameLength = opts.frameLength || 4096;
  const bitDepth = opts.bitDepth || 16;
  const channels = opts.channels || 2;
  const sampleRate = opts.sampleRate || 44100;
  const pcm = testPcm(opts.frames || frameLength * 20 + 1000, channels, bitDepth, 11);
  const { packets, durations } = alacPackets(pcm, bitDepth, frameLength);
  return {
    handler: 'soun',
    codec: 'alac',
    timescale: opts.timescale || sampleRate,
    sampleRate,
    channels,
    sampleSize: bitDepth,
    config: alacAtom({ frameLength, bitDepth, channels, sampleRate }),
    samples: packets,
    durations: opts.timescale ? durations.map((d) => Math.round((d * opts.timescale) / sampleRate)) : durations,
    samplesPerChunk: opts.samplesPerChunk || 5,
    ...opts.track,
  };
}

/** A reader that records every byte range it serves. */
function countingReader(bytes) {
  const log = { bytes: 0, reads: 0, maxRead: 0 };
  const inner = fileReader(bytes);
  const read = async (s, e) => {
    const out = await inner(s, e);
    log.bytes += out.length;
    log.reads++;
    log.maxRead = Math.max(log.maxRead, out.length);
    return out;
  };
  return { read, log };
}

function assertTablesMatch(d, track, sampleOffsets) {
  assert.equal(d.count, track.samples.length, 'sample count');
  let pts = 0;
  for (let i = 0; i < d.count; i++) {
    assert.equal(d.offsets[i], sampleOffsets[i], 'offset of sample ' + i);
    assert.equal(d.sizes[i], track.samples[i].length, 'size of sample ' + i);
    assert.equal(d.pts[i], pts, 'pts of sample ' + i);
    pts += d.durations[i];
  }
  assert.equal(d.totalFrames, pts);
}

test('ALAC, moov first: counts, offsets, PTS, config', async () => {
  const track = alacTrack();
  const { bytes, sampleOffsets } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.codec, 'alac');
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.channels, 2);
  assert.equal(d.bitDepth, 16);
  assert.deepEqual(Array.from(d.extradata), Array.from(track.config));
  assertTablesMatch(d, track, sampleOffsets[0]);
  assert.equal(d.durations[d.count - 1], 1000, 'partial last packet');
  assert.equal(d.totalFrames, 4096 * 20 + 1000);
  assert.equal(d.startSkip, 0);
  assert.equal(d.playFrames, d.totalFrames);
  assert.ok(Math.abs(d.duration - d.totalFrames / 44100) < 1e-9);
  /* Every packet really is where the table says. */
  for (let i = 0; i < d.count; i++) assert.deepEqual(bytes.subarray(d.offsets[i], d.offsets[i] + d.sizes[i]), track.samples[i]);
});

test('moov at the end, behind a large cover atom — cover bytes are never read', async () => {
  const track = alacTrack();
  const cover = new Uint8Array(3 * 1048576).fill(0x5a);
  const { bytes, sampleOffsets } = buildMp4([track], { moovAtEnd: true, cover });
  const { read, log } = countingReader(bytes);
  const d = await demuxMp4(read, bytes.length);
  assertTablesMatch(d, track, sampleOffsets[0]);
  assert.ok(d.moovStart > sampleOffsets[0][d.count - 1], 'moov found after mdat');
  assert.ok(log.bytes < 64 * 1024, 'read ' + log.bytes + ' bytes; the 3 MB cover must not be read');
});

test('co64 chunk offsets (end to end)', async () => {
  const track = alacTrack({ track: { co64: true } });
  const { bytes, sampleOffsets } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assertTablesMatch(d, track, sampleOffsets[0]);
});

test('co64 with offsets past 4 GB (synthetic box)', () => {
  const values = [0, 4294967295, 4294967296, 5000000000, 2 ** 40 + 12345, 2 ** 52 + 1];
  const box = fullbox('co64', 0, 0, u32(values.length), ...values.map(u64));
  const out = parseChunkOffsets(box, { type: 'co64', start: 0, body: 8, end: box.length }, true);
  assert.deepEqual(Array.from(out), values);
  /* and the 32-bit path tops out at 2^32 - 1 */
  const stco = fullbox('stco', 0, 0, u32(2), u32(4294967295), u32(7));
  assert.deepEqual(Array.from(parseChunkOffsets(stco, { type: 'stco', start: 0, body: 8, end: stco.length }, false)), [4294967295, 7]);
});

for (const bits of [16, 8]) {
  test('stz2 compact sizes, ' + bits + '-bit fields (end to end)', async () => {
    /* Small packets so they fit the field width. */
    const pcm = testPcm(bits === 8 ? 8 * 20 : 64 * 30, 1, 16, 5);
    const frameLength = bits === 8 ? 8 : 64;
    const { packets, durations } = alacPackets(pcm, 16, frameLength);
    const track = {
      handler: 'soun', codec: 'alac', timescale: 44100, sampleRate: 44100, channels: 1, sampleSize: 16,
      config: alacAtom({ frameLength, channels: 1 }), samples: packets, durations, samplesPerChunk: 7, stz2Bits: bits,
    };
    const { bytes, sampleOffsets } = buildMp4([track]);
    const d = await demuxMp4(fileReader(bytes), bytes.length);
    assertTablesMatch(d, track, sampleOffsets[0]);
  });
}

test('stz2 4-bit fields (synthetic box)', () => {
  const sizes = [1, 15, 0, 7, 9, 3, 12];
  const packed = new Uint8Array(Math.ceil(sizes.length / 2));
  sizes.forEach((s, i) => {
    packed[i >> 1] |= s << (i & 1 ? 0 : 4);
  });
  const box = fullbox('stz2', 0, 0, new Uint8Array([0, 0, 0, 4]), u32(sizes.length), packed);
  assert.deepEqual(Array.from(parseSampleSizes(box, { type: 'stz2', start: 0, body: 8, end: box.length }, true)), sizes);
});

test('multi-trak: a cover-art video trak before the audio is ignored', async () => {
  const video = { handler: 'vide', codec: 'jpeg', timescale: 1000, samples: [new Uint8Array(200000).fill(0xff)], durations: [5000], samplesPerChunk: 1 };
  const audio = alacTrack({ track: { samplesPerChunk: 3 } });
  const { bytes, sampleOffsets } = buildMp4([video, audio]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.codec, 'alac');
  assertTablesMatch(d, audio, sampleOffsets[1]);
});

test('multi-trak with moov at the end, cover trak AND covr atom', async () => {
  const video = { handler: 'vide', codec: 'jpeg', timescale: 1000, samples: [new Uint8Array(1048576).fill(1)], durations: [5000], samplesPerChunk: 1 };
  const audio = alacTrack();
  const { bytes, sampleOffsets } = buildMp4([audio, video], { moovAtEnd: true, cover: new Uint8Array(1500000) });
  const { read, log } = countingReader(bytes);
  const d = await demuxMp4(read, bytes.length);
  assertTablesMatch(d, audio, sampleOffsets[0]);
  assert.ok(log.maxRead < 16 * 1024, 'largest single read ' + log.maxRead);
});

test('E-AC-3 with dec3 (Atmos JOC): codec, rate, channels, payload', async () => {
  const frames = Array.from({ length: 40 }, () => eac3Frame());
  const dec3 = dec3Box({ joc: true });
  const track = { handler: 'soun', codec: 'ec-3', timescale: 48000, sampleRate: 48000, channels: 2, config: dec3, samples: frames, durations: frames.map(() => 1536), samplesPerChunk: 10 };
  const { bytes, sampleOffsets } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.codec, 'ec-3');
  assert.ok(isEngineCodec(d.codec));
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.channels, 6, '5.1 from acmod 7 + LFE, not the entry’s 2');
  assert.equal(d.ec3.joc, true);
  assert.equal(d.ec3.complexityIndex, 16);
  assert.deepEqual(Array.from(d.dec3), Array.from(dec3.subarray(8)));
  assert.equal(d.extradata, null);
  assertTablesMatch(d, track, sampleOffsets[0]);
});

test('dec3 without JOC, and dac3 stereo', () => {
  const plain = parseDec3(dec3Box({ acmod: 2, lfeon: 0 }).subarray(8));
  assert.equal(plain.joc, false);
  assert.equal(plain.channels, 2);
  const ac3 = parseDac3(dac3Box({ acmod: 2, lfeon: 0 }).subarray(8));
  assert.equal(ac3.channels, 2);
  assert.equal(ac3.bsid, 8);
  const ac351 = parseDac3(dac3Box({ acmod: 7, lfeon: 1, fscod: 1 }).subarray(8));
  assert.equal(ac351.channels, 6);
  assert.equal(ac351.fscod, 1);
});

test('AC-3 in MP4 with dac3', async () => {
  const frames = Array.from({ length: 12 }, () => ac3Frame());
  const track = { handler: 'soun', codec: 'ac-3', timescale: 48000, sampleRate: 48000, channels: 2, config: dac3Box(), samples: frames, durations: frames.map(() => 1536) };
  const { bytes } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.codec, 'ac-3');
  assert.equal(d.channels, 2);
  assert.equal(d.totalFrames, 12 * 1536);
});

test('edit list: priming skip and audible length', async () => {
  const frames = Array.from({ length: 30 }, () => ac3Frame());
  const total = 30 * 1536;
  const play = total - 256 - 700;
  const track = {
    handler: 'soun', codec: 'ac-3', timescale: 48000, sampleRate: 48000, channels: 2, config: dac3Box(), samples: frames, durations: frames.map(() => 1536),
    elst: [{ segmentDuration: Math.round((play / 48000) * 90000), mediaTime: 256 }],
  };
  const { bytes } = buildMp4([track], { movieTimescale: 90000 });
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.startSkip, 256);
  assert.equal(d.playFrames, play);
  assert.ok(Math.abs(d.duration - play / 48000) < 1e-9);
});

test('edit list: a leading empty edit is skipped', async () => {
  const track = alacTrack({ track: { elst: [{ segmentDuration: 100, mediaTime: -1 }, { segmentDuration: 0, mediaTime: 0 }] } });
  const { bytes } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.startSkip, 0);
  assert.equal(d.playFrames, d.totalFrames);
});

test('seek lookup: binary search over PTS', async () => {
  const track = alacTrack({ frames: 4096 * 10 + 5 });
  const { bytes } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(sampleAtFrame(d, 0), 0);
  assert.equal(sampleAtFrame(d, -50), 0);
  assert.equal(sampleAtFrame(d, 4095), 0);
  assert.equal(sampleAtFrame(d, 4096), 1);
  assert.equal(sampleAtFrame(d, 4097), 1);
  assert.equal(sampleAtFrame(d, 4096 * 7 + 3000), 7);
  assert.equal(sampleAtFrame(d, 4096 * 10), 10);
  assert.equal(sampleAtFrame(d, 4096 * 10 + 4), 10);
  assert.equal(sampleAtFrame(d, 1e12), 10);
  /* every sample start maps to itself */
  for (let i = 0; i < d.count; i++) assert.equal(sampleAtFrame(d, d.pts[i]), i);
});

test('mdhd v1, QuickTime v1 sample entry, 96 kHz rate field of 0', async () => {
  const track = alacTrack({ bitDepth: 24, sampleRate: 96000, frames: 4096 * 4, track: { entryVersion: 1, mdhdVersion: 1 } });
  const { bytes, sampleOffsets } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.sampleRate, 96000, 'rate from the ALAC cookie');
  assert.equal(d.bitDepth, 24);
  assertTablesMatch(d, track, sampleOffsets[0]);
});

test('timescale differs from the sample rate', async () => {
  const track = alacTrack({ frames: 4096 * 6, timescale: 22050 });
  const { bytes } = buildMp4([track]);
  const d = await demuxMp4(fileReader(bytes), bytes.length);
  assert.equal(d.timescale, 22050);
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.pts[1], 4096);
  assert.equal(d.totalFrames, 4096 * 6);
});

test('stsc with one sample per chunk and with mixed runs', async () => {
  for (const per of [1, 3, 64]) {
    const track = alacTrack({ frames: 4096 * 9 + 10, samplesPerChunk: per });
    const { bytes, sampleOffsets } = buildMp4([track]);
    const d = await demuxMp4(fileReader(bytes), bytes.length);
    assertTablesMatch(d, track, sampleOffsets[0]);
  }
});

test('a File/Blob source reads through slice windows', async () => {
  const track = alacTrack();
  const { bytes, sampleOffsets } = buildMp4([track], { moovAtEnd: true });
  const blob = new Blob([bytes]);
  const d = await demuxMp4(fileReader(blob), blob.size);
  assertTablesMatch(d, track, sampleOffsets[0]);
});

test('garbage is rejected with an error, not a hang', async () => {
  const junk = new Uint8Array(100000).map((_, i) => (i * 7919) & 255);
  await assert.rejects(demuxMp4(fileReader(junk), junk.length));
  const noAudio = buildMp4([{ handler: 'vide', codec: 'jpeg', timescale: 1000, samples: [new Uint8Array(10)], durations: [10] }]).bytes;
  await assert.rejects(demuxMp4(fileReader(noAudio), noAudio.length), /No audio track/);
});

/* ---------- ffmpeg fixtures ---------- */

const fixtures = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith('.m4a')) : [];
test('ffmpeg fixtures demux', { skip: !fixtures.length && 'no fixtures — run scripts/make-fixtures.sh (needs ffmpeg)' }, async (t) => {
  for (const name of fixtures) {
    await t.test(name, async () => {
      const bytes = readFileSync(join(FIXTURES, name));
      const { read, log } = countingReader(bytes);
      const d = await demuxMp4(read, bytes.length);
      assert.ok(isEngineCodec(d.codec), name + ' codec ' + d.codec);
      assert.ok(d.count > 10);
      for (let i = 1; i < d.count; i++) assert.ok(d.offsets[i] > 0 && d.pts[i] > d.pts[i - 1]);
      assert.ok(d.offsets[d.count - 1] + d.sizes[d.count - 1] <= bytes.length);
      assert.ok(log.maxRead < 1048576, 'no read over 1 MB (' + log.maxRead + ')');
      if (d.codec === 'ec-3') assert.equal(d.channels, 6);
      if (/moov-end/.test(name)) assert.ok(d.moovStart > bytes.length / 2);
      const ref = join(FIXTURES, name.replace(/\.m4a$/, '.f32'));
      if (existsSync(ref)) {
        const frames = readFileSync(ref).length / 4 / d.channels;
        assert.ok(Math.abs(frames - d.playFrames) <= 1536, 'playFrames ' + d.playFrames + ' vs reference ' + frames);
      }
    });
  }
});

