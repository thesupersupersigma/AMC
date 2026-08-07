/* MP3 / ID3v2.
   The tag size and (in v2.4) frame sizes are syncsafe: 7 bits per byte.
   Duration is left to the audio element and cached on first play. */

import type { ParsedMeta } from '../types';
import { DEC_LATIN, DEC_UTF8, HEAD, decLatin, extOf, readBytes, syncsafe, u24be, u32be, cleanStr } from './bytes';
import { logErr } from '../ui/log';

const ID3_MAP: Record<string, string> = {
  TIT2: 'TITLE', TPE1: 'ARTIST', TPE2: 'ALBUMARTIST', TALB: 'ALBUM', TRCK: 'TRACKNUMBER',
  TPOS: 'DISCNUMBER', TDRC: 'DATE', TYER: 'DATE', TCON: 'GENRE',
  TT2: 'TITLE', TP1: 'ARTIST', TP2: 'ALBUMARTIST', TAL: 'ALBUM', TRK: 'TRACKNUMBER',
  TPA: 'DISCNUMBER', TYE: 'DATE', TCO: 'GENRE',
};

function id3Text(b: Uint8Array, off: number, len: number): string {
  if (len <= 1) return '';
  const enc = b[off];
  let s: string;
  const body = b.subarray(off + 1, off + len);
  try {
    if (enc === 0) s = DEC_LATIN.decode(body);
    else if (enc === 1) {
      if (body[0] === 0xff && body[1] === 0xfe) s = new TextDecoder('utf-16le').decode(body.subarray(2));
      else if (body[0] === 0xfe && body[1] === 0xff) s = new TextDecoder('utf-16be').decode(body.subarray(2));
      else s = new TextDecoder('utf-16le').decode(body);
    } else if (enc === 2) s = new TextDecoder('utf-16be').decode(body);
    else s = DEC_UTF8.decode(body);
  } catch {
    s = DEC_LATIN.decode(body);
  }
  return cleanStr(s);
}

function id3Apic(b: Uint8Array, off: number, len: number, short: boolean): Blob | null {
  const end = off + len;
  let p = off;
  const enc = b[p];
  p++;
  let mime: string;
  if (short) {
    /* v2.2 PIC: 3-char format code */
    mime = decLatin(b, p, 3).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    p += 3;
  } else {
    const m0 = p;
    while (p < end && b[p] !== 0) p++;
    mime = decLatin(b, m0, p - m0) || 'image/jpeg';
    p++;
    if (mime.indexOf('/') < 0) mime = 'image/' + mime.toLowerCase();
  }
  p++; /* picture type byte */
  if (enc === 1 || enc === 2) {
    /* UTF-16 description: 2-byte terminator */
    while (p + 1 < end && !(b[p] === 0 && b[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < end && b[p] !== 0) p++;
    p++;
  }
  if (p >= end) return null;
  return new Blob([b.slice(p, end)], { type: mime });
}

function looksLikeFrameId(b: Uint8Array, p: number): boolean {
  if (p + 4 > b.length) return false;
  if (b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 0 && b[p + 3] === 0) return true; /* padding */
  for (let i = 0; i < 4; i++) {
    const c = b[p + i];
    const ok = (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
    if (!ok) return false;
  }
  return true;
}

export async function parseId3(file: File): Promise<ParsedMeta> {
  const out: ParsedMeta = { tags: {}, duration: 0, pic: null, fmt: extOf(file.name) };
  let b = await readBytes(file, 0, Math.min(file.size, HEAD));
  if (b.length < 10 || !(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return out;
  const major = b[3];
  const flags = b[5];
  const tagSize = syncsafe(b, 6); /* SYNCSAFE, not u32be */
  const needed = 10 + tagSize;
  if (needed > b.length && needed <= file.size) {
    b = await readBytes(file, 0, Math.min(file.size, needed));
  }

  const end = Math.min(needed, b.length);
  let p = 10;
  if (flags & 0x40) {
    /* extended header */
    if (major >= 4) p += syncsafe(b, p);
    else p += 4 + u32be(b, p);
  }
  const short = major === 2;
  const idLen = short ? 3 : 4;
  const hdrLen = short ? 6 : 10;
  let guard = 0;
  while (p + hdrLen <= end && guard++ < 400) {
    let id = '';
    for (let i = 0; i < idLen; i++) id += String.fromCharCode(b[p + i]);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; /* hit padding or junk */
    let fsize: number;
    if (short) {
      fsize = u24be(b, p + 3);
    } else if (major >= 4) {
      fsize = syncsafe(b, p + 4); /* SYNCSAFE in v2.4 */
      const plain = u32be(b, p + 4);
      /* Some v2.4 taggers write plain sizes. Trust whichever lands on a
         valid next frame header. */
      if (plain !== fsize && !looksLikeFrameId(b, p + 10 + fsize) && looksLikeFrameId(b, p + 10 + plain)) fsize = plain;
    } else {
      fsize = u32be(b, p + 4); /* plain u32 in v2.3 */
    }
    if (fsize < 0 || p + hdrLen + fsize > end) break;
    const fo = p + hdrLen;
    const key = ID3_MAP[id];
    try {
      if (key) {
        const v = id3Text(b, fo, fsize);
        if (v && !out.tags[key]) out.tags[key] = v;
      } else if ((id === 'APIC' || id === 'PIC') && !out.pic) {
        const blob = id3Apic(b, fo, fsize, short);
        if (blob) out.pic = { blob: blob };
      }
    } catch (e) {
      logErr('mp3', 'Frame ' + id + ' in ' + file.name + ' is malformed', (e as Error).message);
    }
    p += hdrLen + fsize;
  }
  return out;
}
