/* Image dimensions from the file header — no decode. Deciding whether a
   cover needs downscaling (or can be used as its original bytes) must not
   cost a full decode of a 3000 px image on the Chromebook. JPEG, PNG,
   WebP (lossy, lossless, extended) and GIF. Reads only small slices. */

export interface ImgSize {
  w: number;
  h: number;
  type: string;
}

function be16(b: Uint8Array, p: number): number {
  return (b[p] << 8) | b[p + 1];
}
function be32(b: Uint8Array, p: number): number {
  return b[p] * 16777216 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
}
function le16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}
function le24(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
}
function tag(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

async function readAt(blob: Blob, off: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer());
}

/** Walks JPEG marker segments to the first SOFn. EXIF blocks (with their
    own embedded thumbnails) can push SOF well past the first read, so
    later segments are fetched on demand. */
async function jpegSize(blob: Blob, head: Uint8Array): Promise<ImgSize | null> {
  let buf = head;
  let bufOff = 0;
  let p = 2;
  for (let guard = 0; guard < 400; guard++) {
    if (p + 9 > bufOff + buf.length) {
      if (p + 4 > blob.size) return null;
      buf = await readAt(blob, p, 65536);
      bufOff = p;
      if (buf.length < 4) return null;
    }
    const q = p - bufOff;
    if (buf[q] !== 0xff) return null;
    const m = buf[q + 1];
    if (m === 0xff) {
      p += 1; /* fill byte */
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2; /* standalone marker */
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; /* EOI / SOS before any SOF */
    const len = be16(buf, q + 2);
    if (len < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (q + 9 > buf.length) {
        buf = await readAt(blob, p, 16);
        bufOff = p;
        if (buf.length < 9) return null;
        return { h: be16(buf, 5), w: be16(buf, 7), type: 'image/jpeg' };
      }
      return { h: be16(buf, q + 5), w: be16(buf, q + 7), type: 'image/jpeg' };
    }
    p += 2 + len;
  }
  return null;
}

export async function imageSize(blob: Blob | null | undefined): Promise<ImgSize | null> {
  if (!blob || !blob.size) return null;
  try {
    const b = await readAt(blob, 0, 65536);
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { w: be32(b, 16), h: be32(b, 20), type: 'image/png' };
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { w: le16(b, 6), h: le16(b, 8), type: 'image/gif' };
    }
    if (b.length >= 30 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP') {
      const chunk = tag(b, 12);
      if (chunk === 'VP8 ') return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff, type: 'image/webp' };
      if (chunk === 'VP8L') {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: 'image/webp' };
      }
      if (chunk === 'VP8X') return { w: le24(b, 24) + 1, h: le24(b, 27) + 1, type: 'image/webp' };
      return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return await jpegSize(blob, b);
  } catch {
    /* unreadable blob — callers fall back to decoding */
  }
  return null;
}
