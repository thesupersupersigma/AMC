/* MP4 sample tables for the software decode engine.

   parse/mp4.ts reads tags and durations for the library and is never
   touched; this module is the engine's own demuxer. It finds `moov` with
   small File.slice reads (moov may sit after a multi-GB mdat, and may be
   large because of embedded cover art), reads ONLY the trak boxes — never
   udta, where the art lives — and turns the audio trak's stts / stsc /
   stsz|stz2 / stco|co64 into compact typed arrays: per-sample file offset,
   size and start PTS in sample frames. The cover-art video trak and any
   chapter/text traks are ignored.

   Every size and field is BIG-endian. Offsets are kept in Float64Array:
   co64 values exceed 2^32 in >4 GB files, and doubles are exact to 2^53.

   Self-contained on purpose (no imports), so Node's test runner can load it
   directly. */

export type EngineCodec = 'alac' | 'ac-3' | 'ec-3';

/** Codecs the engine can decode (WASM or WebCodecs). */
export const ENGINE_CODECS: readonly string[] = ['alac', 'ac-3', 'ec-3'];

export function isEngineCodec(codec: string | undefined | null): codec is EngineCodec {
  return !!codec && ENGINE_CODECS.indexOf(codec) >= 0;
}

/** Reads bytes [start, end) of the source. */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

/** A ByteReader over a Blob/File (File.slice windows) or an in-memory buffer. */
export function fileReader(src: Blob | Uint8Array): ByteReader {
  if (src instanceof Uint8Array) {
    return (start, end) => Promise.resolve(src.subarray(Math.max(0, start), Math.min(src.length, end)));
  }
  return async (start, end) => {
    const to = Math.min(end, src.size);
    if (start >= to) return new Uint8Array(0);
    return new Uint8Array(await src.slice(start, to).arrayBuffer());
  };
}

/** Parsed `dec3` (E-AC-3 specific box), first independent substream. */
export interface Ec3Config {
  dataRate: number;
  fscod: number;
  bsid: number;
  acmod: number;
  lfeon: number;
  numDepSub: number;
  chanLoc: number;
  /** Dolby Atmos: flag_ec3_extension_type_a — JOC object data present. */
  joc: boolean;
  complexityIndex: number;
  channels: number;
}

/** Parsed `dac3` (AC-3 specific box). */
export interface Ac3Config {
  fscod: number;
  bsid: number;
  acmod: number;
  lfeon: number;
  channels: number;
}

export interface Mp4Audio {
  /** stsd sample-entry fourcc: alac, ec-3, ac-3, mp4a, fLaC… */
  codec: string;
  /** mdhd timescale of the audio trak. */
  timescale: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** ALAC: the full 36-byte 'alac' atom (FFmpeg's extradata). FLAC: the
      WebCodecs description ('fLaC' + metadata blocks). Otherwise null. */
  extradata: Uint8Array | null;
  /** Raw payloads (no box header) of the codec boxes, when present. */
  dec3: Uint8Array | null;
  dac3: Uint8Array | null;
  ec3: Ec3Config | null;
  ac3: Ac3Config | null;
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Start of each sample, in sample frames at sampleRate (pre-edit). */
  pts: Float64Array;
  /** Frames in each sample (from stts, converted to sampleRate). */
  durations: Float64Array;
  totalFrames: number;
  /** Edit list: frames to discard before the first audible frame
      (encoder priming), and how many frames play after that. */
  startSkip: number;
  playFrames: number;
  /** playFrames / sampleRate. */
  duration: number;
  maxSampleSize: number;
  /** Byte range of the moov box (diagnostics). */
  moovStart: number;
  moovSize: number;
}

/* ---------- byte helpers ---------- */

function u16(b: Uint8Array, o: number): number {
  return b[o] * 256 + b[o + 1];
}
function u32(b: Uint8Array, o: number): number {
  return b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];
}
function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 4294967296 + u32(b, o + 4);
}
function i32(b: Uint8Array, o: number): number {
  const v = u32(b, o);
  return v >= 2147483648 ? v - 4294967296 : v;
}
function i64(b: Uint8Array, o: number): number {
  const hi = u32(b, o);
  const lo = u32(b, o + 4);
  return hi >= 2147483648 ? (hi - 4294967296) * 4294967296 + lo : hi * 4294967296 + lo;
}
function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

interface BoxRef {
  type: string;
  start: number; /* box start (header) */
  body: number; /* payload start */
  end: number; /* box end */
}

/** Child boxes of b[start, end). Stops quietly at a malformed size. */
function children(b: Uint8Array, start: number, end: number): BoxRef[] {
  const out: BoxRef[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(b, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

function child(b: Uint8Array, parent: BoxRef, type: string): BoxRef | null {
  for (const c of children(b, parent.body, parent.end)) if (c.type === type) return c;
  return null;
}

/* ---------- codec configuration ---------- */

const AC3_SAMPLE_RATES = [48000, 44100, 32000];
/* Full-bandwidth channels per acmod (0 = 1+1 dual mono counts as 2). */
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

class BitReader {
  private pos = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3] || 0;
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  left(): number {
    return this.b.length * 8 - this.pos;
  }
}

/** Channel count added by a dependent substream's chan_loc bit field. */
function chanLocChannels(chanLoc: number): number {
  /* bit 8..0: Lc/Rc, Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Lvh/Rvh, Cvh, LFE2 */
  const pairs = [8, 7, 4, 3, 2];
  let n = 0;
  for (let bit = 0; bit < 9; bit++) {
    if (chanLoc & (1 << bit)) n += pairs.indexOf(bit) >= 0 ? 2 : 1;
  }
  return n;
}

/** Parses a dec3 payload (no box header). */
export function parseDec3(p: Uint8Array): Ec3Config | null {
  if (p.length < 5) return null;
  const r = new BitReader(p);
  const dataRate = r.read(13);
  const numInd = r.read(3) + 1;
  let first: Ec3Config | null = null;
  for (let i = 0; i < numInd; i++) {
    const fscod = r.read(2);
    const bsid = r.read(5);
    r.read(1); /* reserved */
    r.read(1); /* asvc */
    r.read(3); /* bsmod */
    const acmod = r.read(3);
    const lfeon = r.read(1);
    r.read(3); /* reserved */
    const numDepSub = r.read(4);
    let chanLoc = 0;
    if (numDepSub > 0) chanLoc = r.read(9);
    else r.read(1);
    if (!first) {
      first = {
        dataRate,
        fscod,
        bsid,
        acmod,
        lfeon,
        numDepSub,
        chanLoc,
        joc: false,
        complexityIndex: 0,
        channels: ACMOD_CHANNELS[acmod] + lfeon + chanLocChannels(chanLoc),
      };
    }
  }
  if (first && r.left() >= 16) {
    r.read(7);
    const ext = r.read(1);
    const complexity = r.read(8);
    if (ext) {
      first.joc = true;
      first.complexityIndex = complexity;
    }
  }
  return first;
}

/** Parses a dac3 payload (no box header). */
export function parseDac3(p: Uint8Array): Ac3Config | null {
  if (p.length < 3) return null;
  const r = new BitReader(p);
  const fscod = r.read(2);
  const bsid = r.read(5);
  r.read(3); /* bsmod */
  const acmod = r.read(3);
  const lfeon = r.read(1);
  return { fscod, bsid, acmod, lfeon, channels: ACMOD_CHANNELS[acmod] + lfeon };
}

interface SampleEntry {
  codec: string;
  channels: number;
  sampleSize: number;
  rate: number;
  alac: Uint8Array | null;
  dec3: Uint8Array | null;
  dac3: Uint8Array | null;
  dfla: Uint8Array | null;
}

/** Codec boxes inside an audio sample entry, including a QuickTime `wave`. */
function scanCodecBoxes(b: Uint8Array, start: number, end: number, e: SampleEntry, depth: number): void {
  for (const c of children(b, start, end)) {
    if (c.type === 'alac' && !e.alac) {
      const payload = c.end - c.body;
      if (payload === 24) {
        /* Legacy cookie without version/flags: normalise to the 36-byte atom. */
        const atom = new Uint8Array(36);
        atom.set([0, 0, 0, 36, 0x61, 0x6c, 0x61, 0x63], 0);
        atom.set(b.subarray(c.body, c.end), 12);
        e.alac = atom;
      } else if (payload >= 28) {
        const atom = b.slice(c.start, c.start + 36);
        atom.set([0, 0, 0, 36], 0);
        e.alac = atom;
      }
    } else if (c.type === 'dec3') e.dec3 = b.slice(c.body, c.end);
    else if (c.type === 'dac3') e.dac3 = b.slice(c.body, c.end);
    else if (c.type === 'dfLa') e.dfla = b.slice(c.body + 4, c.end);
    else if (c.type === 'wave' && depth < 2) scanCodecBoxes(b, c.body, c.end, e, depth + 1);
  }
}

function parseStsd(b: Uint8Array, box: BoxRef): SampleEntry | null {
  if (box.body + 8 + 8 > box.end) return null;
  const count = u32(b, box.body + 4);
  if (count < 1) return null;
  const entries = children(b, box.body + 8, box.end);
  const ent = entries[0];
  if (!ent) return null;
  const s = ent.body; /* after size + fourcc */
  if (s + 28 > ent.end) return null;
  const version = u16(b, s + 8);
  const e: SampleEntry = {
    codec: ent.type,
    channels: u16(b, s + 16),
    sampleSize: u16(b, s + 18),
    rate: u32(b, s + 24) / 65536,
    alac: null,
    dec3: null,
    dac3: null,
    dfla: null,
  };
  const kids = s + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  if (kids < ent.end) scanCodecBoxes(b, kids, ent.end, e, 0);
  return e;
}

/* ---------- sample tables ---------- */

/** stco / co64 → chunk offsets. Exported for the co64 unit test. */
export function parseChunkOffsets(b: Uint8Array, box: BoxRef, is64: boolean): Float64Array {
  const n = u32(b, box.body + 4);
  const width = is64 ? 8 : 4;
  const avail = Math.floor((box.end - box.body - 8) / width);
  const count = Math.min(n, avail);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const o = box.body + 8 + i * width;
    out[i] = is64 ? u64(b, o) : u32(b, o);
  }
  return out;
}

/** stsz / stz2 → per-sample sizes. Exported for the stz2 unit test. */
export function parseSampleSizes(b: Uint8Array, box: BoxRef, compact: boolean): Uint32Array {
  if (!compact) {
    const fixed = u32(b, box.body + 4);
    const n = u32(b, box.body + 8);
    const out = new Uint32Array(n);
    if (fixed) {
      out.fill(fixed);
      return out;
    }
    const avail = Math.min(n, Math.floor((box.end - box.body - 12) / 4));
    for (let i = 0; i < avail; i++) out[i] = u32(b, box.body + 12 + i * 4);
    return avail === n ? out : out.subarray(0, avail);
  }
  const field = b[box.body + 7];
  const n = u32(b, box.body + 8);
  const out = new Uint32Array(n);
  const at = box.body + 12;
  for (let i = 0; i < n; i++) {
    if (field === 4) {
      const byte = b[at + (i >> 1)];
      out[i] = i & 1 ? byte & 15 : byte >> 4;
    } else if (field === 8) out[i] = b[at + i];
    else if (field === 16) out[i] = u16(b, at + i * 2);
    else throw new Error('stz2 field size ' + field + ' is invalid');
  }
  return out;
}

interface Edit {
  segmentDuration: number; /* movie timescale */
  mediaTime: number; /* media timescale, -1 = empty edit */
}

function parseElst(b: Uint8Array, box: BoxRef): Edit[] {
  const version = b[box.body];
  const n = u32(b, box.body + 4);
  const out: Edit[] = [];
  let p = box.body + 8;
  for (let i = 0; i < n; i++) {
    if (version === 1) {
      if (p + 20 > box.end) break;
      out.push({ segmentDuration: u64(b, p), mediaTime: i64(b, p + 8) });
      p += 20;
    } else {
      if (p + 12 > box.end) break;
      out.push({ segmentDuration: u32(b, p), mediaTime: i32(b, p + 4) });
      p += 12;
    }
  }
  return out;
}

function parseMdhd(b: Uint8Array, box: BoxRef): { timescale: number; duration: number } {
  const s = box.body;
  if (b[s] === 1) return { timescale: u32(b, s + 20), duration: u64(b, s + 24) };
  return { timescale: u32(b, s + 12), duration: u32(b, s + 16) };
}

interface TrakInfo {
  handler: string;
  timescale: number;
  entry: SampleEntry | null;
  edits: Edit[];
  stbl: BoxRef | null;
  bytes: Uint8Array;
}

function readTrak(b: Uint8Array, hdr: number): TrakInfo {
  const root: BoxRef = { type: 'trak', start: 0, body: hdr, end: b.length };
  const info: TrakInfo = { handler: '', timescale: 0, entry: null, edits: [], stbl: null, bytes: b };
  const edts = child(b, root, 'edts');
  const elst = edts ? child(b, edts, 'elst') : null;
  if (elst) info.edits = parseElst(b, elst);
  const mdia = child(b, root, 'mdia');
  if (!mdia) return info;
  const hdlr = child(b, mdia, 'hdlr');
  if (hdlr && hdlr.body + 12 <= hdlr.end) info.handler = fourcc(b, hdlr.body + 8);
  const mdhd = child(b, mdia, 'mdhd');
  if (mdhd) info.timescale = parseMdhd(b, mdhd).timescale;
  const minf = child(b, mdia, 'minf');
  const stbl = minf ? child(b, minf, 'stbl') : null;
  info.stbl = stbl;
  const stsd = stbl ? child(b, stbl, 'stsd') : null;
  if (stsd) info.entry = parseStsd(b, stsd);
  return info;
}

const AUDIO_ENTRIES = ['alac', 'ec-3', 'ac-3', 'mp4a', 'fLaC', 'Opus', 'ac-4', 'drms', 'samr', 'lpcm', 'sowt', 'twos'];

function pickAudioTrak(traks: TrakInfo[]): TrakInfo | null {
  const audio = traks.filter((t) => t.entry && (t.handler === 'soun' || AUDIO_ENTRIES.indexOf(t.entry.codec) >= 0) && t.handler !== 'vide');
  return audio.find((t) => isEngineCodec(t.entry && t.entry.codec)) || audio[0] || null;
}

function buildTables(t: TrakInfo, movieTimescale: number, moovStart: number, moovSize: number): Mp4Audio {
  const b = t.bytes;
  const stbl = t.stbl as BoxRef;
  const entry = t.entry as SampleEntry;
  const kids = children(b, stbl.body, stbl.end);
  const find = (type: string): BoxRef | null => kids.find((k) => k.type === type) || null;

  const stszBox = find('stsz');
  const stz2Box = find('stz2');
  if (!stszBox && !stz2Box) throw new Error('No sample size table (stsz/stz2)');
  const sizes = stszBox ? parseSampleSizes(b, stszBox, false) : parseSampleSizes(b, stz2Box as BoxRef, true);
  const count = sizes.length;

  const stcoBox = find('stco');
  const co64Box = find('co64');
  if (!stcoBox && !co64Box) throw new Error('No chunk offset table (stco/co64)');
  const chunkOffsets = co64Box ? parseChunkOffsets(b, co64Box, true) : parseChunkOffsets(b, stcoBox as BoxRef, false);

  const stscBox = find('stsc');
  if (!stscBox) throw new Error('No sample-to-chunk table (stsc)');
  const stscN = u32(b, stscBox.body + 4);

  /* Offsets: walk chunks, spreading each chunk's samples by size. */
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let r = 0; r < stscN && sample < count; r++) {
    const e = stscBox.body + 8 + r * 12;
    if (e + 12 > stscBox.end) break;
    const firstChunk = u32(b, e) - 1;
    const perChunk = u32(b, e + 4);
    const nextFirst = r + 1 < stscN && e + 24 <= stscBox.end ? u32(b, e + 12) - 1 : chunkOffsets.length;
    for (let c = firstChunk; c < nextFirst && c < chunkOffsets.length && sample < count; c++) {
      let off = chunkOffsets[c];
      for (let k = 0; k < perChunk && sample < count; k++) {
        offsets[sample] = off;
        off += sizes[sample];
        sample++;
      }
    }
  }
  if (sample < count) throw new Error('Sample tables disagree: ' + sample + ' of ' + count + ' samples placed');

  /* Sample rate: the codec config is authoritative (a 96 kHz ALAC stores 0
     in the 16.16 entry field); mdhd's timescale is the fallback. */
  let sampleRate = 0;
  let channels = entry.channels;
  let bitDepth = entry.sampleSize;
  let extradata: Uint8Array | null = null;
  let ec3: Ec3Config | null = null;
  let ac3: Ac3Config | null = null;
  if (entry.alac) {
    extradata = entry.alac;
    const cookie = entry.alac.subarray(12);
    bitDepth = cookie[5];
    if (cookie[9]) channels = cookie[9];
    sampleRate = u32(cookie, 20);
  }
  if (entry.dec3) {
    ec3 = parseDec3(entry.dec3);
    if (ec3) {
      if (ec3.fscod < 3) sampleRate = AC3_SAMPLE_RATES[ec3.fscod];
      channels = ec3.channels;
    }
  }
  if (entry.dac3) {
    ac3 = parseDac3(entry.dac3);
    if (ac3) {
      if (ac3.fscod < 3) sampleRate = AC3_SAMPLE_RATES[ac3.fscod];
      channels = ac3.channels;
    }
  }
  if (entry.dfla) {
    /* WebCodecs FLAC description: 'fLaC' + the metadata blocks. */
    extradata = new Uint8Array(4 + entry.dfla.length);
    extradata.set([0x66, 0x4c, 0x61, 0x43], 0);
    extradata.set(entry.dfla, 4);
    if (entry.dfla.length >= 4 + 18) {
      const si = entry.dfla.subarray(4);
      sampleRate = si[10] * 4096 + si[11] * 16 + (si[12] >> 4);
      channels = ((si[12] >> 1) & 7) + 1;
      bitDepth = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
    }
  }
  if (!sampleRate) sampleRate = entry.rate || t.timescale;
  const timescale = t.timescale || sampleRate;
  const scale = sampleRate / timescale;

  /* stts → per-sample start PTS and duration, in frames at sampleRate. */
  const pts = new Float64Array(count);
  const durations = new Float64Array(count);
  const sttsBox = find('stts');
  if (!sttsBox) throw new Error('No time-to-sample table (stts)');
  const runs = u32(b, sttsBox.body + 4);
  let s = 0;
  let clock = 0;
  for (let r = 0; r < runs && s < count; r++) {
    const e = sttsBox.body + 8 + r * 8;
    if (e + 8 > sttsBox.end) break;
    const n = u32(b, e);
    const delta = u32(b, e + 4);
    for (let k = 0; k < n && s < count; k++) {
      pts[s] = Math.round(clock * scale);
      clock += delta;
      durations[s] = Math.round(clock * scale) - pts[s];
      s++;
    }
  }
  /* A short stts: extrapolate with the last delta rather than fail. */
  for (; s < count; s++) {
    const last = s > 0 ? durations[s - 1] : 1024;
    pts[s] = s > 0 ? pts[s - 1] + durations[s - 1] : 0;
    durations[s] = last;
  }
  const totalFrames = count ? pts[count - 1] + durations[count - 1] : 0;

  /* Edit list: skip leading empty edits; the first real edit gives the
     priming to discard and the audible length. */
  let startSkip = 0;
  let playFrames = totalFrames;
  const real = t.edits.filter((e) => e.mediaTime >= 0);
  if (real.length) {
    startSkip = Math.max(0, Math.round(real[0].mediaTime * scale));
    let segment = 0;
    for (const e of real) segment += e.segmentDuration;
    if (segment > 0 && movieTimescale > 0) playFrames = Math.round((segment / movieTimescale) * sampleRate);
  }
  startSkip = Math.min(startSkip, totalFrames);
  playFrames = Math.max(0, Math.min(playFrames, totalFrames - startSkip));

  let maxSampleSize = 0;
  for (let i = 0; i < count; i++) if (sizes[i] > maxSampleSize) maxSampleSize = sizes[i];

  return {
    codec: entry.codec,
    timescale,
    sampleRate,
    channels,
    bitDepth,
    extradata,
    dec3: entry.dec3,
    dac3: entry.dac3,
    ec3,
    ac3,
    count,
    offsets,
    sizes,
    pts,
    durations,
    totalFrames,
    startSkip,
    playFrames,
    duration: sampleRate ? playFrames / sampleRate : 0,
    maxSampleSize,
    moovStart,
    moovSize,
  };
}

/* ---------- locating moov ---------- */

const TAIL_SCAN = 4 * 1048576;

interface Header {
  type: string;
  size: number;
  hdr: number;
}

async function readHeader(read: ByteReader, at: number, fileSize: number): Promise<Header | null> {
  if (at + 8 > fileSize) return null;
  const h = await read(at, Math.min(fileSize, at + 16));
  if (h.length < 8) return null;
  let size = u32(h, 0);
  const type = fourcc(h, 4);
  let hdr = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u64(h, 8);
    hdr = 16;
  } else if (size === 0) {
    size = fileSize - at;
  }
  if (size < hdr) return null;
  return { type, size, hdr };
}

async function locateMoov(read: ByteReader, fileSize: number): Promise<{ start: number; size: number; hdr: number } | null> {
  let p = 0;
  for (let guard = 0; guard < 4096 && p < fileSize; guard++) {
    const h = await readHeader(read, p, fileSize);
    if (!h || !/^[\x20-\x7e]{4}$/.test(h.type)) break;
    if (h.type === 'moov') return { start: p, size: Math.min(h.size, fileSize - p), hdr: h.hdr };
    p += h.size;
  }
  /* Top-level walk broke (a bad mdat size): look for moov in the tail. */
  const from = Math.max(0, fileSize - TAIL_SCAN);
  const tail = await read(from, fileSize);
  for (let i = tail.length - 8; i >= 4; i--) {
    if (tail[i] === 0x6d && tail[i + 1] === 0x6f && tail[i + 2] === 0x6f && tail[i + 3] === 0x76) {
      const size = u32(tail, i - 4);
      if (size >= 8 && from + i - 4 + size <= fileSize) return { start: from + i - 4, size, hdr: 8 };
    }
  }
  return null;
}

/** Demuxes the audio trak's sample tables. Throws on files it cannot use. */
export async function demuxMp4(read: ByteReader, fileSize: number): Promise<Mp4Audio> {
  const moov = await locateMoov(read, fileSize);
  if (!moov) throw new Error('No moov box found');
  let movieTimescale = 0;
  const traks: TrakInfo[] = [];
  /* Walk moov's children by header; read mvhd and trak bodies only — udta
     (cover art, often megabytes) is never read. */
  let p = moov.start + moov.hdr;
  const end = moov.start + moov.size;
  for (let guard = 0; guard < 256 && p + 8 <= end; guard++) {
    const h = await readHeader(read, p, end);
    if (!h) break;
    if (h.type === 'mvhd') {
      const b = await read(p, p + Math.min(h.size, 64));
      const s = h.hdr;
      movieTimescale = b[s] === 1 ? u32(b, s + 20) : u32(b, s + 12);
    } else if (h.type === 'trak') {
      if (h.size > 64 * 1048576) throw new Error('trak box too large (' + h.size + ' bytes)');
      const b = await read(p, p + h.size);
      if (b.length === h.size) traks.push(readTrak(b, h.hdr));
    }
    p += h.size;
  }
  const t = pickAudioTrak(traks);
  if (!t || !t.stbl || !t.entry) throw new Error('No audio track found');
  return buildTables(t, movieTimescale, moov.start, moov.size);
}

/** Index of the sample holding stream frame `frame` (pre-edit timeline):
    the last sample whose PTS is <= frame. Clamped to [0, count-1]. */
export function sampleAtFrame(d: Pick<Mp4Audio, 'pts' | 'count'>, frame: number): number {
  let lo = 0;
  let hi = d.count - 1;
  if (hi < 0) return 0;
  if (frame <= d.pts[0]) return 0;
  if (frame >= d.pts[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.pts[mid] <= frame) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
