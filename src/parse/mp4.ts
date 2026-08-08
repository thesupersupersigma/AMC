/* MP4 / M4A.
   Every size and field here is BIG-endian. `meta` carries 4 extra bytes
   before its children. `moov` is not always at the front. */

import type { ParsedMeta } from '../types';
import { HEAD, decUtf8, extOf, fourcc, readBytes, u16be, u32be, u64be, cleanStr } from './bytes';
import { logErr } from '../ui/log';

const MP4_CONTAINERS: Record<string, number> = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, udta: 1, ilst: 1, meta: 1 };

export function mp4Walk(b: Uint8Array, start: number, end: number, absBase: number, out: ParsedMeta, depth: number): void {
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p); /* BIG-endian */
    const type = fourcc(b, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64be(b, p + 8); /* 64-bit size follows the type */
      hdr = 16;
    } else if (size === 0) {
      size = end - p; /* runs to end of file */
    }
    if (size < hdr) return;
    const bodyStart = p + hdr;
    const bodyEnd = p + size;
    if (bodyEnd > end) {
      /* Truncated in this buffer — usually a huge mdat. Stop; the caller
         falls back to a tail read when moov was never found. A truncated
         top-level moov is different: it means the metadata itself did not
         fit the head read (multi-MB embedded artwork), so tell the caller
         how far to grow. */
      if (type === 'moov' && depth === 0) out.needBytes = bodyEnd;
      return;
    }
    if (type === 'moov') out.foundMoov = true;

    if (type === 'meta') {
      /* container WITH 4 extra bytes (version + flags) before its children */
      if (bodyStart + 4 <= bodyEnd) mp4Walk(b, bodyStart + 4, bodyEnd, absBase, out, depth + 1);
    } else if (type === 'ilst') {
      mp4Ilst(b, bodyStart, bodyEnd, absBase, out);
    } else if (MP4_CONTAINERS[type] === 1) {
      if (depth < 8) mp4Walk(b, bodyStart, bodyEnd, absBase, out, depth + 1);
    } else if (type === 'mvhd') {
      mp4Mvhd(b, bodyStart, bodyEnd, out);
    } else if (type === 'mdhd') {
      mp4Mdhd(b, bodyStart, bodyEnd, out);
    } else if (type === 'stsd') {
      mp4Stsd(b, bodyStart, bodyEnd, out);
    }
    p += size;
  }
}

/* Codec identity lives in the stsd sample entry (trak > mdia > minf > stbl >
   stsd), all of whose ancestors are already in the container walk. The
   fourcc is what a decode failure actually failed on — canPlayType answers
   from the codec STRING, not from whether this build has a decoder, so it
   is never consulted for anything. */
const AUDIO_SAMPLE_ENTRIES: Record<string, number> = {
  mp4a: 1, alac: 1, 'ec-3': 1, 'ac-3': 1, 'ac-4': 1, drms: 1, fLaC: 1, Opus: 1, samr: 1,
};

function mp4Stsd(b: Uint8Array, s: number, e: number, out: ParsedMeta): void {
  if (s + 16 > e) return;
  const count = u32be(b, s + 4); /* after 4 bytes of version + flags */
  if (count < 1) return;
  /* First sample entry: size(4) then format fourcc(4). A file can carry
     several traks (chapter text, cover video); a known audio entry wins
     over anything recorded from an earlier non-audio trak. */
  const fmt = fourcc(b, s + 12);
  if (!out.codec || (AUDIO_SAMPLE_ENTRIES[fmt] === 1 && AUDIO_SAMPLE_ENTRIES[out.codec] !== 1)) {
    out.codec = fmt;
  }
}

function mp4Mvhd(b: Uint8Array, s: number, e: number, out: ParsedMeta): void {
  if (s + 4 > e) return;
  const version = b[s];
  let ts: number, dur: number;
  if (version === 1) {
    if (s + 32 > e) return;
    ts = u32be(b, s + 20);
    dur = u64be(b, s + 24);
  } else {
    if (s + 20 > e) return;
    ts = u32be(b, s + 12);
    dur = u32be(b, s + 16);
  }
  if (ts > 0 && dur > 0) out.duration = dur / ts;
}

/* mdhd shares mvhd's field layout exactly — version 0 stores times and
   duration as 32-bit, version 1 as 64-bit with the timescale after the two
   8-byte times. The longest trak's media duration wins (auxiliary chapter
   traks are never longer than the audio). */
function mp4Mdhd(b: Uint8Array, s: number, e: number, out: ParsedMeta): void {
  if (s + 4 > e) return;
  const version = b[s];
  let ts: number, dur: number;
  if (version === 1) {
    if (s + 32 > e) return;
    ts = u32be(b, s + 20);
    dur = u64be(b, s + 24);
  } else {
    if (s + 20 > e) return;
    ts = u32be(b, s + 12);
    dur = u32be(b, s + 16);
  }
  if (ts > 0 && dur > 0) {
    const sec = dur / ts;
    if (!out.durationMdhd || sec > out.durationMdhd) out.durationMdhd = sec;
  }
}

const MP4_TAGMAP: Record<string, string> = {};
MP4_TAGMAP[String.fromCharCode(0xa9) + 'nam'] = 'TITLE';
MP4_TAGMAP[String.fromCharCode(0xa9) + 'ART'] = 'ARTIST';
MP4_TAGMAP[String.fromCharCode(0xa9) + 'alb'] = 'ALBUM';
MP4_TAGMAP[String.fromCharCode(0xa9) + 'day'] = 'DATE';
MP4_TAGMAP[String.fromCharCode(0xa9) + 'gen'] = 'GENRE';
MP4_TAGMAP[String.fromCharCode(0xa9) + 'wrt'] = 'COMPOSER';
MP4_TAGMAP['aART'] = 'ALBUMARTIST';

export function mp4Ilst(b: Uint8Array, start: number, end: number, absBase: number, out: ParsedMeta): void {
  let p = start;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    const type = fourcc(b, p + 4);
    if (size < 8 || p + size > end) return;
    const itemEnd = p + size;
    /* find the `data` sub-atom inside this tag atom */
    let q = p + 8;
    while (q + 8 <= itemEnd) {
      const dsize = u32be(b, q);
      const dtype = fourcc(b, q + 4);
      if (dsize < 8 || q + dsize > itemEnd) break;
      if (dtype === 'data') {
        const ind = u32be(b, q + 8); /* type indicator */
        const payload = q + 16; /* skip indicator + locale */
        const plen = q + dsize - payload;
        if (plen > 0) mp4Data(type, ind, b, payload, plen, absBase, out);
        break;
      }
      q += dsize;
    }
    p += size;
  }
}

function mp4Data(type: string, ind: number, b: Uint8Array, off: number, len: number, _absBase: number, out: ParsedMeta): void {
  const key = MP4_TAGMAP[type];
  if (key) {
    const v = cleanStr(decUtf8(b, off, len));
    if (v && !out.tags[key]) out.tags[key] = v;
    return;
  }
  if (type === 'trkn' && len >= 4) {
    const n = u16be(b, off + 2);
    if (n > 0 && !out.tags['TRACKNUMBER']) out.tags['TRACKNUMBER'] = String(n);
    return;
  }
  if (type === 'disk' && len >= 4) {
    const d = u16be(b, off + 2);
    if (d > 0 && !out.tags['DISCNUMBER']) out.tags['DISCNUMBER'] = String(d);
    return;
  }
  if (type === 'covr' && len > 0) {
    const mime = ind === 14 ? 'image/png' : 'image/jpeg'; /* 13 = JPEG, 14 = PNG */
    if (!out.pic) out.pic = { blob: new Blob([b.slice(off, off + len)], { type: mime }) };
  }
}

/* The tail buffer starts mid-atom, so walking from index 0 is garbage.
   Find the `moov` fourcc with a plausible size in front of it instead. */
export function findMoov(b: Uint8Array): number {
  for (let i = 4; i + 4 <= b.length; i++) {
    if (b[i] === 0x6d && b[i + 1] === 0x6f && b[i + 2] === 0x6f && b[i + 3] === 0x76) {
      const size = u32be(b, i - 4);
      if (size >= 8 && i - 4 + size <= b.length + 8) return i - 4;
    }
  }
  return -1;
}

/* The mvhd movie duration is only a fallback: real muxers write garbage
   there (one Atmos rip carries mvhd ≈ real² × 0.036 × timescale) while the
   trak-level mdhd stays correct. */
function finishDuration(out: ParsedMeta): ParsedMeta {
  if (out.durationMdhd) out.duration = out.durationMdhd;
  return out;
}

export async function parseMp4(file: File): Promise<ParsedMeta> {
  const out: ParsedMeta = { tags: {}, duration: 0, pic: null, fmt: extOf(file.name), foundMoov: false };
  let b = await readBytes(file, 0, Math.min(file.size, HEAD));
  try {
    mp4Walk(b, 0, b.length, 0, out, 0);
  } catch (e) {
    logErr('mp4', 'Atom walk failed for ' + file.name, (e as Error).message);
  }
  if (!out.foundMoov && out.needBytes && out.needBytes > b.length && out.needBytes <= file.size) {
    /* The moov starts in the head but did not fit (multi-MB embedded
       artwork). Grow the read to cover it and walk again. */
    b = await readBytes(file, 0, out.needBytes);
    try {
      mp4Walk(b, 0, b.length, 0, out, 0);
    } catch (e) {
      logErr('mp4', 'Atom walk failed for ' + file.name, (e as Error).message);
    }
  }
  if (out.foundMoov || file.size <= HEAD) return finishDuration(out);
  /* moov lives at the end of the file — read the last 1 MB and retry. */
  const startAt = Math.max(0, file.size - HEAD);
  const tb = await readBytes(file, startAt, file.size);
  const at = findMoov(tb);
  if (at < 0) {
    logErr('mp4', 'No moov atom found in ' + file.name, 'checked head and tail');
    return finishDuration(out);
  }
  try {
    mp4Walk(tb, at, tb.length, startAt, out, 0);
  } catch (e) {
    logErr('mp4', 'Tail atom walk failed for ' + file.name, (e as Error).message);
  }
  return finishDuration(out);
}
