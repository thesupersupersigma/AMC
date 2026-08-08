/* Waveform peaks: ~1500 min/max pairs per file, a few KB, cached in the
   sidecar's peaks/ directory so the decode happens once.

   Two generators feed the same PeakData shape: small files decode fully
   through decodeAudioData (waveform.ts), and multi-GB files — the vinyl
   rips this feature exists for — go through the sparse WebCodecs sampler
   below, which never holds the file in memory. */

import type { ConnectedFolder, PeakData } from '../types';
import { queueSidecarWrite, stripRoot } from '../fs/amcdir';
import { readBytes, u16be, u24be } from '../parse/bytes';
import { Bits } from '../parse/bits';
import { logErr } from '../ui/log';

export function bucketPeaks(channels: Float32Array[], buckets: number): number[] {
  const n = channels[0] ? channels[0].length : 0;
  if (!n) return [];
  const out = new Array<number>(buckets * 2);
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(n, Math.max(from + 1, Math.floor((b + 1) * per)));
    let mn = 1,
      mx = -1;
    for (let i = from; i < to; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      s /= channels.length;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

function peaksRel(path: string): string {
  return 'peaks/' + stripRoot(path) + '.json';
}

export async function loadPeaks(folder: ConnectedFolder, path: string): Promise<PeakData | null> {
  const text = await folder.backend.readSidecarText(peaksRel(path));
  if (!text) return null;
  try {
    const data = JSON.parse(text) as PeakData;
    if (data && data.version === 1 && Array.isArray(data.pairs) && data.pairs.length) return data;
  } catch (e) {
    logErr('waveform', 'Saved peaks for ' + path + ' are malformed', (e as Error).message);
  }
  return null;
}

export function savePeaks(folder: ConnectedFolder, path: string, data: PeakData): void {
  queueSidecarWrite(folder, peaksRel(path), () => JSON.stringify(data));
}

/* =========================================================================
   Sparse peaks for multi-GB FLACs via WebCodecs AudioDecoder.

   decodeAudioData needs the whole file as one ArrayBuffer and decodes to
   native-rate PCM (a 42-minute 24/192 rip would need ~4 GB) — impossible.
   AudioDecoder streams: FLAC frames are independently decodable, so ~1500
   positions spread across the file each contribute a few frames to one
   min/max bucket. An envelope sketch, not an exact waveform — right for a
   scrubber, and orders of magnitude cheaper. Frames are found by sync-code
   scan and accepted only when the header parses AND its CRC-8 matches —
   raw sync matching alone false-positives inside 24-bit audio. Windows
   come from File.slice; AudioData is closed the moment its min/max is
   taken, so peak memory stays flat regardless of file size.
   ========================================================================= */

interface FlacLayout {
  rate: number;
  channels: number;
  totalSamples: number;
  minBlock: number;
  maxBlock: number;
  /** 'fLaC' + STREAMINFO block with header — the WebCodecs description. */
  description: Uint8Array;
  audioStart: number;
}

/** Walks the metadata block chain with small reads: STREAMINFO fields, the
    decoder description, and where the audio frames begin. Exported for the
    parser harness. */
export async function readFlacLayout(file: File): Promise<FlacLayout | null> {
  const head = await readBytes(file, 0, 42);
  if (head.length < 42 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) return null;
  if ((head[4] & 0x7f) !== 0) return null; /* first block must be STREAMINFO */
  const siLen = u24be(head, 5);
  if (siLen < 34) return null;
  const si = head.subarray(8, 42);
  const br = new Bits(si, 0);
  const minBlock = br.read(16);
  const maxBlock = br.read(16);
  br.read(24);
  br.read(24);
  const rate = br.read(20);
  const channels = br.read(3) + 1;
  br.read(5);
  const totalSamples = br.read(36);
  if (rate <= 0 || channels < 1) return null;

  /* Description: marker + STREAMINFO with a last-block header. */
  const description = new Uint8Array(42);
  description.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  description.set(si, 8);

  /* Skip the remaining metadata blocks to the first audio frame. */
  let off = 4;
  for (let guard = 0; guard < 512; guard++) {
    const hdr = await readBytes(file, off, off + 4);
    if (hdr.length < 4) return null;
    const last = (hdr[0] & 0x80) !== 0;
    const len = u24be(hdr, 1);
    off += 4 + len;
    if (last) break;
  }
  return { rate, channels, totalSamples, minBlock, maxBlock, description, audioStart: off };
}

/* CRC-8, polynomial 0x07, init 0 — the FLAC frame-header checksum. */
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();
function crc8(b: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8_TABLE[c ^ b[i]];
  return c;
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -1, -2, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, -1, -2, -3, 0];

interface FrameStart {
  at: number; /* offset within the scanned window */
  sampleNumber: number;
}

/** Validates a candidate frame header at b[i]: structure, agreement with
    STREAMINFO, and the CRC-8. Returns the frame's absolute sample number. */
function validateFrame(b: Uint8Array, i: number, layout: FlacLayout): FrameStart | null {
  if (i + 16 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return null;
  const variableBlocks = (b[i + 1] & 1) === 1;
  const bsCode = b[i + 2] >> 4;
  const srCode = b[i + 2] & 15;
  if (bsCode === 0 || srCode === 15) return null;
  const chanCode = b[i + 3] >> 4;
  const sizeCode = (b[i + 3] >> 1) & 7;
  if (chanCode > 10 || sizeCode === 3 || (b[i + 3] & 1) !== 0) return null;
  const frameChannels = chanCode < 8 ? chanCode + 1 : 2;
  if (frameChannels !== layout.channels) return null;

  /* UTF-8-coded frame/sample number, up to 7 bytes / 36 bits. */
  let p = i + 4;
  const first = b[p];
  let extra: number;
  if (first < 0x80) extra = 0;
  else if ((first & 0xe0) === 0xc0) extra = 1;
  else if ((first & 0xf0) === 0xe0) extra = 2;
  else if ((first & 0xf8) === 0xf0) extra = 3;
  else if ((first & 0xfc) === 0xf8) extra = 4;
  else if ((first & 0xfe) === 0xfc) extra = 5;
  else if (first === 0xfe) extra = 6;
  else return null;
  if (p + 1 + extra + 4 > b.length) return null;
  let num = extra === 0 ? first : first & (0x7f >> (extra + 1));
  for (let k = 1; k <= extra; k++) {
    const c = b[p + k];
    if ((c & 0xc0) !== 0x80) return null;
    num = num * 64 + (c & 63);
  }
  p += 1 + extra;

  let blockSize = BLOCK_SIZES[bsCode];
  if (blockSize === -1) {
    blockSize = b[p] + 1;
    p += 1;
  } else if (blockSize === -2) {
    blockSize = u16be(b, p) + 1;
    p += 2;
  }
  const sr = SAMPLE_RATES[srCode];
  if (sr === -1) {
    if (b[p] * 1000 !== layout.rate) return null;
    p += 1;
  } else if (sr === -2) {
    if (u16be(b, p) !== layout.rate) return null;
    p += 2;
  } else if (sr === -3) {
    if (u16be(b, p) * 10 !== layout.rate) return null;
    p += 2;
  } else if (sr !== 0 && sr !== layout.rate) {
    return null;
  }
  if (p >= b.length) return null;
  if (crc8(b, i, p) !== b[p]) return null;

  const fixedBlock = layout.minBlock === layout.maxBlock ? layout.minBlock : blockSize;
  return { at: i, sampleNumber: variableBlocks ? num : num * fixedBlock };
}

/** Scans a window for up to `need` CRC-validated frame starts. Exported for
    the parser harness. */
export function scanFrames(win: Uint8Array, layout: FlacLayout, need: number): FrameStart[] {
  const out: FrameStart[] = [];
  for (let i = 0; i + 16 < win.length && out.length < need; i++) {
    if (win[i] !== 0xff) continue;
    const f = validateFrame(win, i, layout);
    if (f) {
      out.push(f);
      i = f.at + 15; /* jump past the header; the next sync is frames away */
    }
  }
  return out;
}

let flacCodecSupport: boolean | null = null;
async function supportsFlacDecoder(layout: FlacLayout): Promise<boolean> {
  if (flacCodecSupport !== null) return flacCodecSupport;
  if (typeof AudioDecoder === 'undefined') {
    flacCodecSupport = false;
    return false;
  }
  try {
    const s = await AudioDecoder.isConfigSupported({
      codec: 'flac',
      sampleRate: layout.rate,
      numberOfChannels: layout.channels,
      description: layout.description,
    });
    flacCodecSupport = !!s.supported;
  } catch {
    flacCodecSupport = false;
  }
  return flacCodecSupport;
}

const SPARSE_WINDOW = 256 * 1024;
/* Frames are sampled per bucket by TIME, not by count: a frame is 1152
   samples in some rips and 4096 in others, and a fixed count would read
   only ~18 ms of a 1.7 s bucket at 192 kHz — too thin a slice, the sketch
   under-reads and noise wins. ~80 ms per bucket tracks the envelope. */
const SPARSE_SLICE_SEC = 0.08;

/** The sparse sampler. Returns null when WebCodecs FLAC is unavailable or
    the file's shape defeats it — callers keep today's skip behaviour then. */
export async function generateSparseFlacPeaks(
  file: File,
  buckets = 1500,
  onProgress?: (bucket: number) => void
): Promise<PeakData | null> {
  const layout = await readFlacLayout(file);
  if (!layout || !layout.totalSamples) return null;
  if (!(await supportsFlacDecoder(layout))) return null;

  const duration = layout.totalSamples / layout.rate;
  const mins = new Float32Array(buckets).fill(0);
  const maxs = new Float32Array(buckets).fill(0);
  const filled = new Uint8Array(buckets);
  const planes: Float32Array[] = [];
  let decodeFailed = false;

  /* Outputs pair with inputs by SUBMISSION ORDER, one bucket index pushed
     per decoded chunk. Chunk timestamps cannot carry the bucket: Chrome's
     FLAC decoder rewrites output timestamps as continuous time from the
     first chunk, which would collapse whole flush groups into one bucket. */
  const pendingBuckets: number[] = [];

  const onOutput = (data: AudioData): void => {
    const tb = pendingBuckets.shift();
    try {
      if (tb === undefined) return; /* unexpected extra output — drop it */
      const n = data.numberOfFrames;
      const ch = Math.min(2, data.numberOfChannels);
      for (let c = 0; c < ch; c++) {
        if (!planes[c] || planes[c].length < n) planes[c] = new Float32Array(Math.max(n, layout.maxBlock || 4096));
        data.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' });
      }
      let mn = filled[tb] ? mins[tb] : 1;
      let mx = filled[tb] ? maxs[tb] : -1;
      for (let s = 0; s < n; s++) {
        let v = planes[0][s];
        if (ch > 1) v = (v + planes[1][s]) / 2;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[tb] = mn;
      maxs[tb] = mx;
      filled[tb] = 1;
    } finally {
      data.close(); /* discard immediately — flat memory is the contract */
    }
  };

  const makeDecoder = (): AudioDecoder => {
    const d = new AudioDecoder({
      output: onOutput,
      error: () => {
        decodeFailed = true;
      },
    });
    d.configure({ codec: 'flac', sampleRate: layout.rate, numberOfChannels: layout.channels, description: layout.description });
    return d;
  };
  let decoder = makeDecoder();

  const span = file.size - layout.audioStart;
  if (span <= 0) {
    decoder.close();
    return null;
  }
  const blockGuess = layout.maxBlock || 4096;
  const framesPerBucket = Math.max(3, Math.ceil((SPARSE_SLICE_SEC * layout.rate) / blockGuess));
  /* Positions are picked in TIME, not in bytes: VBR makes byte-uniform
     positions collide into the same time bucket and leave neighbours
     empty. A running byte-per-sample calibration, corrected by every found
     frame's actual sample number, lands each read near its target time. */
  let calibOff = layout.audioStart;
  let calibSample = 0;
  let bytesPerSample = span / layout.totalSamples;
  const bpsAvg = bytesPerSample;
  let contributed = 0;
  for (let bi = 0; bi < buckets; bi++) {
    const targetSample = ((bi + 0.5) / buckets) * layout.totalSamples;
    const predicted = calibOff + (targetSample - calibSample) * bytesPerSample;
    const target = Math.max(layout.audioStart, Math.min(file.size - 64, Math.floor(predicted)));
    const win = await readBytes(file, target, Math.min(file.size, target + SPARSE_WINDOW));
    const starts = scanFrames(win, layout, framesPerBucket + 1);
    if (starts.length < 2) continue;
    /* Recalibrate from what was actually found there. */
    const foundOff = target + starts[0].at;
    const foundSample = starts[0].sampleNumber;
    if (foundSample > calibSample + layout.rate && foundOff > calibOff) {
      const local = (foundOff - calibOff) / (foundSample - calibSample);
      if (local > bpsAvg * 0.2 && local < bpsAvg * 5) bytesPerSample = (bytesPerSample + local) / 2;
    }
    calibOff = foundOff;
    calibSample = foundSample;
    if (decodeFailed) {
      try {
        decoder.close();
      } catch {
        /* already closed by the error */
      }
      decoder = makeDecoder();
      decodeFailed = false;
    }
    const usable = Math.min(framesPerBucket, starts.length - 1);
    for (let k = 0; k < usable; k++) {
      /* The frame's own sample number places it in the time-correct bucket —
         VBR compression skews byte positions, sample positions never lie. */
      const tb = Math.max(0, Math.min(buckets - 1, Math.floor((starts[k].sampleNumber / layout.totalSamples) * buckets)));
      const bytes = win.slice(starts[k].at, starts[k + 1].at);
      try {
        pendingBuckets.push(tb);
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: contributed * 1000, data: bytes }));
        contributed++;
      } catch {
        pendingBuckets.pop();
        decodeFailed = true;
        break;
      }
    }
    /* Periodic flush bounds the decode queue; association is by submission
       order, so batching does not blur buckets. */
    if (bi % 32 === 31 || bi === buckets - 1) {
      try {
        await decoder.flush();
      } catch {
        decodeFailed = true;
      }
      pendingBuckets.length = 0; /* a failed flush drops its outputs */
    }
    if (onProgress && bi % 100 === 0) onProgress(bi);
  }
  try {
    await decoder.flush();
  } catch {
    /* whatever was decoded still counts */
  }
  try {
    decoder.close();
  } catch {
    /* already closed */
  }
  if (!contributed) return null;

  /* Sparse gaps (skipped windows, collided buckets) carry the previous
     envelope forward so the sketch stays continuous. */
  let lastMin = 0;
  let lastMax = 0;
  let seeded = false;
  for (let b = 0; b < buckets; b++) {
    if (filled[b]) {
      lastMin = mins[b];
      lastMax = maxs[b];
      if (!seeded) {
        for (let z = 0; z < b; z++) {
          mins[z] = lastMin;
          maxs[z] = lastMax;
        }
        seeded = true;
      }
    } else if (seeded) {
      mins[b] = lastMin;
      maxs[b] = lastMax;
    }
  }

  const pairs = new Array<number>(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    pairs[b * 2] = mins[b];
    pairs[b * 2 + 1] = maxs[b];
  }
  return { version: 1, duration, pairs };
}
