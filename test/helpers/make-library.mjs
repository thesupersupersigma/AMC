/* Writes a small synthetic music library to disk for the app-level browser
   tests: native FLAC (plays in the element), ALAC and E-AC-3 in .m4a (need
   the software engine), a fake AAC (unsupported here, not an engine codec:
   must keep today's skip behaviour). Tagged through MP4 ilst / Vorbis
   comments so the library shows real names.

     node test/helpers/make-library.mjs <outDir> */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ascii, alacAtom, box, buildMp4, concat, dec3Box, eac3Frame, u32 } from './mp4build.mjs';
import { alacPackets } from './alac.mjs';
import { flacFrame, sinePcm } from './flac.mjs';

function ilstTags({ title, artist, album, track }) {
  const text = (type, v) => box(type, box('data', u32(1), u32(0), new TextEncoder().encode(v)));
  const items = [text('©nam', title), text('©ART', artist), text('©alb', album), text('aART', artist)];
  if (track) items.push(box('trkn', box('data', u32(0), u32(0), Uint8Array.of(0, 0, 0, track, 0, 0, 0, 0))));
  return items;
}

/** buildMp4 + an ilst with tags (udta/meta/ilst). */
function taggedMp4(track, tags, opts = {}) {
  const { bytes } = buildMp4([track], opts);
  /* Re-open moov and append a udta carrying the tags: simplest is to build
     the udta and splice it in as the last child of moov. */
  const udta = box(
    'udta',
    box('meta', new Uint8Array(4), box('hdlr', new Uint8Array(8), ascii('mdir'), ascii('appl'), new Uint8Array(9)), box('ilst', ...ilstTags(tags)))
  );
  /* find moov */
  let p = 0;
  while (p + 8 <= bytes.length) {
    const size = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === 'moov') {
      const moov = bytes.subarray(p, p + size);
      const grown = concat([u32(size + udta.length), moov.subarray(4), udta]);
      if (p + size === bytes.length) return concat([bytes.subarray(0, p), grown]);
      /* moov before mdat: chunk offsets would shift — rebuild with moov at the end instead */
      return taggedMp4(track, tags, { ...opts, moovAtEnd: true });
    }
    p += size;
  }
  return bytes;
}

function alacTrackFrom(pcm, rate = 44100) {
  const { packets, durations } = alacPackets(pcm, 16, 4096);
  return { handler: 'soun', codec: 'alac', timescale: rate, sampleRate: rate, channels: pcm.length, sampleSize: 16, config: alacAtom({ sampleRate: rate, channels: pcm.length }), samples: packets, durations };
}

function vorbisComment(tags) {
  const enc = new TextEncoder();
  const vendor = enc.encode('amc-test');
  const entries = Object.entries(tags).map(([k, v]) => enc.encode(k + '=' + v));
  const le = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  return concat([le(vendor.length), vendor, le(entries.length), ...entries.flatMap((e) => [le(e.length), e])]);
}

function nativeFlac(seconds, tags, freq = 330) {
  const rate = 44100;
  const pcm = sinePcm(Math.round(seconds * rate), 2, { rate, freq, amp: 0.3 });
  const frames = [];
  let n = 0;
  for (let at = 0; at < pcm[0].length; at += 4096) {
    frames.push(flacFrame(pcm.map((c) => c.subarray(at, Math.min(at + 4096, c.length))), n++, rate, 16));
  }
  const total = pcm[0].length;
  /* STREAMINFO (not last) + VORBIS_COMMENT (last) */
  const si = new Uint8Array(34);
  const w = [];
  const bits = (v, k) => {
    for (let i = k - 1; i >= 0; i--) w.push(Math.floor(v / 2 ** i) % 2);
  };
  bits(4096, 16);
  bits(4096, 16);
  bits(0, 24);
  bits(0, 24);
  bits(rate, 20);
  bits(1, 3);
  bits(15, 5);
  bits(total, 36);
  for (let i = 0; i < 128; i++) w.push(0);
  for (let i = 0; i < 34; i++) for (let b = 0; b < 8; b++) si[i] |= w[i * 8 + b] << (7 - b);
  const vc = vorbisComment(tags);
  const hdr = (last, type, len) => Uint8Array.of((last ? 0x80 : 0) | type, (len >> 16) & 255, (len >> 8) & 255, len & 255);
  return concat([ascii('fLaC'), hdr(false, 0, 34), si, hdr(true, 4, vc.length), vc, ...frames]);
}

export function makeLibrary(out) {
  const write = (rel, bytes) => {
    const full = join(out, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  };
  /* Native FLAC album */
  write('Native Artist/Flac Album/01 First Light.flac', nativeFlac(8, { TITLE: 'First Light', ARTIST: 'Native Artist', ALBUM: 'Flac Album', TRACKNUMBER: '1' }, 330));
  write('Native Artist/Flac Album/02 Second Wind.flac', nativeFlac(8, { TITLE: 'Second Wind', ARTIST: 'Native Artist', ALBUM: 'Flac Album', TRACKNUMBER: '2' }, 440));
  /* ALAC album: tracks 1+2 are cut from one continuous tone (gapless pair) */
  const rate = 44100;
  const tone = (secs, offset) => sinePcm(Math.round(secs * rate), 2, { rate, freq: 441, amp: 0.4, offset });
  write('Lossless Artist/ALAC Album/01 Alpha.m4a', taggedMp4(alacTrackFrom(tone(6, 0)), { title: 'Alpha', artist: 'Lossless Artist', album: 'ALAC Album', track: 1 }));
  write('Lossless Artist/ALAC Album/02 Beta.m4a', taggedMp4(alacTrackFrom(tone(6, 6 * rate)), { title: 'Beta', artist: 'Lossless Artist', album: 'ALAC Album', track: 2 }));
  write('Lossless Artist/ALAC Album/03 Gamma.m4a', taggedMp4(alacTrackFrom(tone(5, 0)), { title: 'Gamma', artist: 'Lossless Artist', album: 'ALAC Album', track: 3 }));
  /* E-AC-3 JOC (Atmos edition) */
  const n = Math.ceil((10 * 48000) / 1536);
  const frames = Array.from({ length: n }, () => eac3Frame());
  write(
    'Dolby Artist/Atmos Album/01 Get Up.m4a',
    taggedMp4(
      { handler: 'soun', codec: 'ec-3', timescale: 48000, sampleRate: 48000, channels: 2, config: dec3Box({ joc: true }), samples: frames, durations: frames.map(() => 1536), samplesPerChunk: 20 },
      { title: 'Get Up', artist: 'Dolby Artist', album: 'Atmos Album', track: 1 }
    )
  );
  /* Fake AAC: an mp4a entry this Chromium has no decoder for, and the
     engine does not handle — today's skip behaviour must hold. */
  const junk = Array.from({ length: 40 }, () => new Uint8Array(300).fill(0x21));
  write(
    'Other Artist/AAC Album/01 Plain AAC.m4a',
    taggedMp4(
      { handler: 'soun', codec: 'mp4a', timescale: 44100, sampleRate: 44100, channels: 2, samples: junk, durations: junk.map(() => 1024) },
      { title: 'Plain AAC', artist: 'Other Artist', album: 'AAC Album', track: 1 }
    )
  );
}

if (process.argv[1] && process.argv[1].endsWith('make-library.mjs')) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node test/helpers/make-library.mjs <outDir>');
    process.exit(2);
  }
  makeLibrary(out);
  console.log('wrote a synthetic library to', out);
}
