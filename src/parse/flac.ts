/* FLAC.
   Block header : byte 0 = last-flag | type, bytes 1-3 = BIG-endian length.
   STREAMINFO   : bit fields, read with an explicit bit reader.
   VORBIS_COMMENT: every length inside is LITTLE-endian. This is the one that
                   bites people — u32le is used here and nowhere else in FLAC.
   PICTURE      : back to BIG-endian for every field. */

import type { FlacPicRef, ParsedMeta, ParsedTags } from '../types';
import { HEAD, decLatin, decUtf8, readBytes, u24be, u32be, u32le, cleanStr } from './bytes';
import { Bits } from './bits';
import { logErr } from '../ui/log';

export function isFlac(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43;
}

export function parseVorbisComment(b: Uint8Array, start: number, len: number, tags: ParsedTags): void {
  let p = start;
  const end = start + len;
  if (p + 4 > end) return;
  const vendorLen = u32le(b, p); /* LITTLE-endian */
  p += 4 + vendorLen;
  if (p + 4 > end) return;
  const count = u32le(b, p); /* LITTLE-endian */
  p += 4;
  if (count < 0 || count > 10000) return;
  for (let i = 0; i < count; i++) {
    if (p + 4 > end) break;
    const clen = u32le(b, p); /* LITTLE-endian */
    p += 4;
    if (clen < 0 || p + clen > end) break;
    const s = decUtf8(b, p, clen);
    p += clen;
    const eq = s.indexOf('=');
    if (eq > 0) {
      const k = s.slice(0, eq).toUpperCase(); /* keys are case-insensitive */
      const v = cleanStr(s.slice(eq + 1));
      if (v && !tags[k]) tags[k] = v;
    }
  }
}

export async function parseFlac(file: File): Promise<ParsedMeta> {
  const out: ParsedMeta = { tags: {}, duration: 0, pics: [], fmt: 'flac' };
  let buf = await readBytes(file, 0, Math.min(file.size, HEAD));
  if (!isFlac(buf)) return out;

  let off = 4,
    guard = 0;
  /* The metadata chain ran past what we read. Grow the head read once. */
  const grow = async (needEnd: number): Promise<void> => {
    buf = await readBytes(file, 0, Math.min(file.size, needEnd + 65536));
  };

  for (;;) {
    if (guard++ > 512) break;
    if (off + 4 > file.size) break;
    if (off + 4 > buf.length) {
      if (off + 4 > file.size) break;
      await grow(off + HEAD);
      if (off + 4 <= buf.length) continue;
      break;
    }
    const h = buf[off];
    const last = (h & 0x80) !== 0;
    const type = h & 0x7f;
    const len = u24be(buf, off + 1); /* BIG-endian */
    const body = off + 4;

    if (type === 0 && len >= 34) {
      if (body + 34 > buf.length) {
        await grow(body + 34);
        if (body + 34 <= buf.length) readStreamInfo(buf, body, out);
      } else {
        readStreamInfo(buf, body, out);
      }
    } else if (type === 4) {
      if (body + len > buf.length) {
        const vb = await readBytes(file, body, body + len);
        try {
          parseVorbisComment(vb, 0, Math.min(len, vb.length), out.tags);
        } catch (e) {
          logErr('flac', 'Tag block in ' + file.name + ' is malformed', (e as Error).message);
        }
      } else {
        try {
          parseVorbisComment(buf, body, len, out.tags);
        } catch (e) {
          logErr('flac', 'Tag block in ' + file.name + ' is malformed', (e as Error).message);
        }
      }
    } else if (type === 6) {
      /* Record where it is; read the bytes only if this album still needs art.
         Peek the picture type (BIG-endian) so type 3 (front cover) can win. */
      const ptype = body + 4 <= buf.length ? u32be(buf, body) : 3;
      (out.pics as FlacPicRef[]).push({ off: body, len: len, type: ptype });
    }

    off = body + len;
    if (last) break;
  }
  return out;
}

export function readStreamInfo(b: Uint8Array, body: number, out: ParsedMeta): void {
  const br = new Bits(b, body);
  br.read(16); /* min block size            */
  br.read(16); /* max block size            */
  br.read(24); /* min frame size            */
  br.read(24); /* max frame size            */
  const rate = br.read(20); /* bit offset 80, 20 bits    */
  const ch = br.read(3) + 1; /* next 3 bits               */
  const bps = br.read(5) + 1; /* next 5 bits               */
  const total = br.read(36); /* next 36 bits              */
  out.sampleRate = rate;
  out.channels = ch;
  out.bits = bps;
  if (rate > 0 && total > 0) out.duration = total / rate;
}

/* Pull the actual image bytes for one PICTURE block. Every field BIG-endian. */
export async function flacPicture(file: File, pics: FlacPicRef[] | undefined): Promise<Blob | null> {
  if (!pics || !pics.length) return null;
  let pick: FlacPicRef | null = null;
  for (let i = 0; i < pics.length; i++) {
    if (pics[i].type === 3) {
      pick = pics[i];
      break;
    }
  }
  if (!pick) pick = pics[0];
  if (pick.len > 24 * 1048576) return null;
  const b = await readBytes(file, pick.off, pick.off + pick.len);
  let p = 0;
  if (b.length < 32) return null;
  p += 4; /* picture type   (BE) */
  const mimeLen = u32be(b, p);
  p += 4; /* MIME length    (BE) */
  if (mimeLen < 0 || p + mimeLen > b.length) return null;
  const mime = decLatin(b, p, mimeLen);
  p += mimeLen;
  const descLen = u32be(b, p);
  p += 4; /* description    (BE) */
  if (descLen < 0 || p + descLen > b.length) return null;
  p += descLen;
  p += 16; /* width/height/depth/colors */
  if (p + 4 > b.length) return null;
  const dataLen = u32be(b, p);
  p += 4; /* image length   (BE) */
  if (dataLen <= 0 || p + dataLen > b.length) return null;
  return new Blob([b.slice(p, p + dataLen)], { type: mime || 'image/jpeg' });
}
