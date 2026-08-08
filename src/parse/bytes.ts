/* Byte readers. Endianness is explicit at every call site on purpose:
   FLAC mixes big-endian block headers with little-endian Vorbis lengths. */

export const HEAD = 1048576; /* 1 MB first read */
export const AUDIO_EXT = ['flac', 'm4a', 'mp3', 'wav', 'ogg', 'opus', 'aac'];

export function extOf(name: string): string {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

/** OS droppings that must never reach a parser: every dot-prefixed name —
    which covers macOS AppleDouble forks ("._01 Bad.m4a", 4 KB of resource
    data wearing an audio extension) and .DS_Store — plus the Windows pair. */
export function isJunkFile(name: string): boolean {
  const base = String(name).slice(String(name).lastIndexOf('/') + 1);
  if (base.charAt(0) === '.') return true;
  const lower = base.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini';
}

export function isAudioFile(file: File): boolean {
  if (isJunkFile(file.name)) return false;
  return AUDIO_EXT.indexOf(extOf(file.name)) >= 0;
}

export function u16be(b: Uint8Array, o: number): number {
  return b[o] * 256 + b[o + 1];
}
export function u24be(b: Uint8Array, o: number): number {
  return b[o] * 65536 + b[o + 1] * 256 + b[o + 2];
}
export function u32be(b: Uint8Array, o: number): number {
  return b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];
}
export function u64be(b: Uint8Array, o: number): number {
  return u32be(b, o) * 4294967296 + u32be(b, o + 4);
}
export function u32le(b: Uint8Array, o: number): number {
  return b[o] + b[o + 1] * 256 + b[o + 2] * 65536 + b[o + 3] * 16777216;
}
export function syncsafe(b: Uint8Array, o: number): number {
  return (b[o] & 0x7f) * 2097152 + (b[o + 1] & 0x7f) * 16384 + (b[o + 2] & 0x7f) * 128 + (b[o + 3] & 0x7f);
}

export const DEC_UTF8 = new TextDecoder('utf-8');
export const DEC_LATIN = (() => {
  try {
    return new TextDecoder('windows-1252');
  } catch {
    return DEC_UTF8;
  }
})();
export function decUtf8(b: Uint8Array, o: number, len: number): string {
  return DEC_UTF8.decode(b.subarray(o, o + len));
}
export function decLatin(b: Uint8Array, o: number, len: number): string {
  return DEC_LATIN.decode(b.subarray(o, o + len));
}
export function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
export function cleanStr(s: unknown): string {
  return String(s == null ? '' : s).replace(/\u0000+/g, '').trim();
}

/* Read a slice of a file. Never the whole file: FLAC tracks run 25-40 MB. */
export async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  const to = Math.min(end, file.size);
  if (start >= to) return new Uint8Array(0);
  const buf = await file.slice(start, to).arrayBuffer();
  return new Uint8Array(buf);
}
