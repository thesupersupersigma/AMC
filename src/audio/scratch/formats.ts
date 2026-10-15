/* Byte-level helpers for the scratch voice's window decoders: just enough
   of MP3, WAV and MP4 AAC to cut a few seconds out of the middle of a file
   (File.slice) into something decodeAudioData accepts, and to know what
   source time the cut starts at.

   These are NOT the library's tag parsers (src/parse/*) and never replace
   them; they only find frame boundaries and stream parameters.

   Self-contained on purpose (no imports), so Node's test runner can load
   it directly. */

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
}
function u32be(b: Uint8Array, o: number): number {
  return b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];
}
function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/* ---------- MP3 ---------- */

export interface Mp3Frame {
  /** Frame length in bytes (header included). */
  len: number;
  /** PCM frames per MP3 frame. */
  spf: number;
  rate: number;
  mono: boolean;
  /** MPEG-1 (else 2 / 2.5). */
  mpeg1: boolean;
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_RATES = [44100, 48000, 32000, 0];

/** A Layer III frame header at b[i], or null. */
export function mp3FrameAt(b: Uint8Array, i: number): Mp3Frame | null {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3; /* 0 = 2.5, 2 = 2, 3 = 1 */
  const layer = (b[i + 1] >> 1) & 3; /* 1 = Layer III */
  if (ver === 1 || layer !== 1) return null;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const mpeg1 = ver === 3;
  const kbps = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[brIdx];
  const rate = MP3_RATES[srIdx] / (mpeg1 ? 1 : ver === 2 ? 2 : 4);
  const pad = (b[i + 2] >> 1) & 1;
  const spf = mpeg1 ? 1152 : 576;
  const len = Math.floor(((spf / 8) * kbps * 1000) / rate) + pad;
  if (len < 24) return null;
  return { len, spf, rate, mono: b[i + 3] >> 6 === 3, mpeg1 };
}

/** The first offset in b where `chain` consecutive frames parse with the
    same sample rate (a lone 0xFFE pattern inside audio data is common). */
export function findMp3Sync(b: Uint8Array, from = 0, chain = 3): number {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff) continue;
    const f = mp3FrameAt(b, i);
    if (!f) continue;
    let ok = true;
    let j = i + f.len;
    for (let k = 1; k < chain; k++) {
      if (j + 4 > b.length) break; /* ran out of window: accept what we have */
      const g = mp3FrameAt(b, j);
      if (!g || g.rate !== f.rate) {
        ok = false;
        break;
      }
      j += g.len;
    }
    if (ok) return i;
  }
  return -1;
}

/** Walks frames from a sync point; returns the end of the last frame that
    fits completely in the window. */
export function lastMp3FrameEnd(b: Uint8Array, start: number): number {
  let j = start;
  for (;;) {
    const f = mp3FrameAt(b, j);
    if (!f || j + f.len > b.length) return j;
    j += f.len;
  }
}

/** Bytes to skip for an ID3v2 tag at the start of the file (0 if none). */
export function id3v2Size(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

export interface XingInfo {
  frames: number;
  bytes: number;
  /** 100-entry seek table (0–255), when present. */
  toc: Uint8Array | null;
  /** 'Info' — LAME's tag for a constant-bitrate file. */
  cbr: boolean;
  /** Encoder delay from the LAME extension (samples), or -1. A player
      that reads it (Chrome does) trims it plus the decoder's 529 from the
      start, so source time 0 is that far into the decoded stream. */
  encDelay: number;
}

/** The Xing / Info header inside the first frame, if any. */
export function readXing(b: Uint8Array, i: number, f: Mp3Frame): XingInfo | null {
  const off = i + 4 + (f.mpeg1 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17);
  if (off + 8 > b.length) return null;
  const id = tag(b, off);
  if (id !== 'Xing' && id !== 'Info') return null;
  const flags = u32be(b, off + 4);
  let p = off + 8;
  let frames = 0;
  let bytes = 0;
  let toc: Uint8Array | null = null;
  if (flags & 1) {
    frames = u32be(b, p);
    p += 4;
  }
  if (flags & 2) {
    bytes = u32be(b, p);
    p += 4;
  }
  if (flags & 4 && p + 100 <= b.length) toc = b.slice(p, p + 100);
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  let encDelay = -1;
  /* LAME extension: a 9-byte encoder string ('LAME3.100', 'Lavc…'), then
     the 12-bit delay at byte 21 */
  if (p + 24 <= b.length && /^[A-Za-z]{4}$/.test(tag(b, p))) encDelay = (b[p + 21] << 4) | (b[p + 22] >> 4);
  return { frames, bytes, toc, cbr: id === 'Info', encDelay };
}

/** Source time ↔ byte offset for an MP3: through the Xing seek table when
    there is one, else proportional (exact for CBR, close for VBR). */
export class Mp3Map {
  readonly audioStart: number;
  readonly audioBytes: number;
  readonly duration: number;
  private toc: Uint8Array | null;

  constructor(audioStart: number, fileSize: number, duration: number, xing: XingInfo | null, first: Mp3Frame) {
    this.audioStart = audioStart;
    this.audioBytes = xing && xing.bytes > 0 ? xing.bytes : fileSize - audioStart;
    this.duration = xing && xing.frames > 0 ? (xing.frames * first.spf) / first.rate : duration;
    /* The table is quantised to 1/256 of the file (±0.1 s a minute): a
       constant-bitrate file is better served by plain proportion. */
    this.toc = xing && !xing.cbr && xing.toc && xing.bytes > 0 && xing.frames > 0 ? xing.toc : null;
  }

  byteAt(sec: number): number {
    const d = this.duration;
    if (!(d > 0)) return this.audioStart;
    const t = Math.max(0, Math.min(d, sec));
    if (!this.toc) return this.audioStart + (t / d) * this.audioBytes;
    const pct = (t / d) * 100;
    const a = Math.min(99, Math.floor(pct));
    const fa = this.toc[a];
    const fb = a < 99 ? this.toc[a + 1] : 256;
    return this.audioStart + ((fa + (fb - fa) * (pct - a)) / 256) * this.audioBytes;
  }

  timeAt(byte: number): number {
    let lo = 0;
    let hi = this.duration;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (this.byteAt(mid) < byte) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
}

/* ---------- WAV ---------- */

export interface WavLayout {
  /** The whole fmt chunk payload, copied into each window's header. */
  fmt: Uint8Array;
  rate: number;
  blockAlign: number;
  dataStart: number;
  frames: number;
}

/** Parses the chunk list from successive small reads. */
export async function readWavLayout(read: (a: number, b: number) => Promise<Uint8Array>, fileSize: number): Promise<WavLayout | null> {
  const h = await read(0, 12);
  if (h.length < 12 || tag(h, 0) !== 'RIFF' || tag(h, 8) !== 'WAVE') return null;
  let off = 12;
  let fmt: Uint8Array | null = null;
  for (let guard = 0; guard < 64 && off + 8 <= fileSize; guard++) {
    const c = await read(off, off + 8);
    if (c.length < 8) return null;
    const id = tag(c, 0);
    const size = u32le(c, 4);
    if (id === 'fmt ') {
      fmt = await read(off + 8, off + 8 + size);
    } else if (id === 'data') {
      if (!fmt || fmt.length < 16) return null;
      const blockAlign = u16le(fmt, 12);
      const rate = u32le(fmt, 4);
      if (!blockAlign || !rate) return null;
      const dataStart = off + 8;
      const bytes = size === 0 || size === 0xffffffff || dataStart + size > fileSize ? fileSize - dataStart : size;
      return { fmt, rate, blockAlign, dataStart, frames: Math.floor(bytes / blockAlign) };
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

/** A complete little WAV file: the original fmt chunk + `data`. */
export function buildWav(fmt: Uint8Array, data: Uint8Array): Uint8Array {
  const fmtPad = fmt.length & 1;
  const total = 12 + 8 + fmt.length + fmtPad + 8 + data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string): void => {
    for (let k = 0; k < 4; k++) out[o + k] = s.charCodeAt(k);
  };
  put(0, 'RIFF');
  dv.setUint32(4, total - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  let p = 20 + fmt.length + fmtPad;
  put(p, 'data');
  dv.setUint32(p + 4, data.length, true);
  out.set(data, p + 8);
  return out;
}

/* ---------- MP4 AAC → ADTS ---------- */

export const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface AdtsConfig {
  /** ADTS profile = core audio object type − 1 (LC = 1). */
  profile: number;
  rateIndex: number;
  channelConfig: number;
}

/** The AudioSpecificConfig, reduced to what an ADTS header carries: the
    CORE object type and rate (HE-AAC's SBR / PS is detected implicitly by
    the decoder). Null for configs ADTS cannot express. */
export function adtsFromAsc(asc: Uint8Array): AdtsConfig | null {
  if (asc.length < 2) return null;
  let bit = 0;
  const read = (n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++, bit++) {
      const byte = asc[bit >> 3];
      if (byte === undefined) return -1;
      v = v * 2 + ((byte >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  let rateIndex = read(4);
  if (rateIndex === 15) return null;
  const channelConfig = read(4);
  if (aot === 5 || aot === 29) {
    const ext = read(4);
    if (ext === 15) read(24);
    aot = read(5);
    /* the core rate is the one ADTS needs */
  }
  if (aot < 1 || aot > 4 || rateIndex < 0 || rateIndex > 12 || channelConfig < 1 || channelConfig > 7) return null;
  return { profile: aot - 1, rateIndex, channelConfig };
}

/** Fallback when no esds was found: plain LC at the track's rate. */
export function adtsGuess(sampleRate: number, channels: number): AdtsConfig | null {
  const rateIndex = AAC_RATES.indexOf(sampleRate);
  if (rateIndex < 0 || channels < 1 || channels > 8) return null;
  return { profile: 1, rateIndex, channelConfig: channels === 8 ? 7 : channels };
}

/** One raw AAC access unit wrapped in a 7-byte ADTS header. */
export function adtsFrame(cfg: AdtsConfig, raw: Uint8Array, out: Uint8Array, at: number): number {
  const len = raw.length + 7;
  out[at] = 0xff;
  out[at + 1] = 0xf1; /* MPEG-4, layer 0, no CRC */
  out[at + 2] = (cfg.profile << 6) | (cfg.rateIndex << 2) | (cfg.channelConfig >> 2);
  out[at + 3] = ((cfg.channelConfig & 3) << 6) | (len >> 11);
  out[at + 4] = (len >> 3) & 0xff;
  out[at + 5] = ((len & 7) << 5) | 0x1f;
  out[at + 6] = 0xfc;
  out.set(raw, at + 7);
  return at + len;
}

/** The DecoderSpecificInfo (AudioSpecificConfig) from inside an `esds`
    box found anywhere in `moov` bytes. */
export function ascFromMoov(moov: Uint8Array): Uint8Array | null {
  for (let i = 4; i + 8 < moov.length; i++) {
    if (moov[i] !== 0x65 || moov[i + 1] !== 0x73 || moov[i + 2] !== 0x64 || moov[i + 3] !== 0x73) continue; /* 'esds' */
    const boxStart = i - 4;
    const boxEnd = Math.min(moov.length, boxStart + u32be(moov, boxStart));
    const asc = walkEsDescriptors(moov, i + 8, boxEnd);
    if (asc) return asc;
  }
  return null;
}

function walkEsDescriptors(b: Uint8Array, p: number, end: number): Uint8Array | null {
  const descriptor = (at: number): { tag: number; body: number; end: number } | null => {
    if (at >= end) return null;
    const t = b[at];
    let len = 0;
    let q = at + 1;
    for (let k = 0; k < 4 && q < end; k++) {
      const c = b[q++];
      len = len * 128 + (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag: t, body: q, end: Math.min(end, q + len) };
  };
  const es = descriptor(p);
  if (!es || es.tag !== 3) return null;
  let q = es.body + 2;
  const flags = b[q++];
  if (flags & 0x80) q += 2;
  if (flags & 0x40) q += 1 + b[q];
  if (flags & 0x20) q += 2;
  const dc = descriptor(q);
  if (!dc || dc.tag !== 4) return null;
  const dsi = descriptor(dc.body + 13);
  if (!dsi || dsi.tag !== 5 || dsi.end <= dsi.body) return null;
  return b.slice(dsi.body, dsi.end);
}
