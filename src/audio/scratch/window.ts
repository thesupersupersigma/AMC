/* Window decoders for the scratch voice: decode a few seconds from the
   middle of a file, and say exactly (or, for VBR MP3, closely) which source
   second the decoded audio starts at.

   Never the whole file: every read is a File.slice window of a few hundred
   KB. Each window is made into a small self-contained stream the browser
   decodes on its own — FLAC frames behind a STREAMINFO header, MP3 frames
   as they are, PCM behind a fresh WAV header, MP4 AAC access units as ADTS
   — or, for other MP4 codecs, fed to a WebCodecs AudioDecoder when the
   browser has one. Formats with none of these (Ogg, ALAC where WebCodecs
   lacks it) get no window source; the turntable then scratches by playback
   rate instead.

   decodeAudioData runs on the scratch voice's own AudioContext, so its
   output is already at the output rate. This is playback, not analysis —
   the 8 kHz OfflineAudioContext rule is for the analysis decodes. */

import { readFlacLayout, scanFrames } from '../peaks';
import { readBytes } from '../../parse/bytes';
import { demuxMp4, fileReader, sampleAtFrame, type Mp4Audio } from '../mp4samples';
import { probeWebCodecs } from '../soft/backends';
import {
  Mp3Map, adtsFrame, adtsFromAsc, adtsGuess, ascFromMoov, buildWav, findMp3Sync, id3v2Size, lastMp3FrameEnd, mp3FrameAt, readWavLayout, readXing,
  type AdtsConfig,
} from './formats';

export interface DecodedWindow {
  /** Source second of planes[*][0]. */
  start: number;
  /** Sample rate of the planes. */
  rate: number;
  /** Two planes (stereo; mono doubled, surround folded down). */
  planes: Float32Array[];
}

export interface WindowSource {
  readonly kind: 'flac' | 'mp3' | 'wav' | 'aac' | 'webcodecs';
  /** Decodes about [from, to] of the source. Null when that part cannot be
      decoded (the voice then stays silent there). */
  decode(from: number, to: number): Promise<DecodedWindow | null>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Folds any channel count to stereo. */
function toStereo(ch: Float32Array[]): Float32Array[] {
  if (ch.length === 0) return [];
  if (ch.length === 1) return [ch[0], ch[0]];
  if (ch.length === 2) return ch;
  const n = ch[0].length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  /* L R C LFE Ls Rs (…) — the order both decoders hand out for 5.1 */
  const c = ch[2];
  const ls = ch.length >= 6 ? ch[4] : null;
  const rs = ch.length >= 6 ? ch[5] : null;
  for (let i = 0; i < n; i++) {
    const cc = c[i] * 0.707;
    l[i] = 0.5 * (ch[0][i] + cc + (ls ? ls[i] * 0.707 : 0));
    r[i] = 0.5 * (ch[1][i] + cc + (rs ? rs[i] * 0.707 : 0));
  }
  return [l, r];
}

async function decodeBytes(ctx: BaseAudioContext, bytes: Uint8Array): Promise<Float32Array[] | null> {
  try {
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ch: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    return toStereo(ch);
  } catch {
    return null;
  }
}

/* ---------- FLAC ---------- */

async function flacSource(file: File, ctx: BaseAudioContext): Promise<WindowSource | null> {
  const layout = await readFlacLayout(file);
  if (!layout) return null;
  /* The header each window is decoded behind: STREAMINFO with the total
     sample count and MD5 zeroed ("unknown"), since a window is not the
     whole stream. */
  const head = layout.description.slice();
  head[8 + 13] &= 0xf0;
  head.fill(0, 8 + 14, 8 + 34);
  const seconds = layout.totalSamples > 0 ? layout.totalSamples / layout.rate : 0;
  const audioBytes = file.size - layout.audioStart;
  const bps = seconds > 0 ? audioBytes / seconds : layout.rate * layout.channels * 2;
  return {
    kind: 'flac',
    async decode(from, to) {
      let est = layout.audioStart + Math.max(0, from) * bps;
      for (let tries = 0; tries < 4; tries++) {
        const a = Math.max(layout.audioStart, Math.floor(est) - 16384);
        const b = Math.min(file.size, Math.ceil(a + (to - from) * bps * 1.25) + 131072);
        const win = await readBytes(file, a, b);
        const first = scanFrames(win, layout, 1)[0];
        if (!first) return null;
        const startSec = first.sampleNumber / layout.rate;
        /* The estimate landed after `from` (a dense passage before it):
           step back by what was missed, and look again. */
        if (startSec > from + 0.05 && a > layout.audioStart && tries < 3) {
          est = a - (startSec - from) * bps * 1.2 - 32768;
          continue;
        }
        /* End the stream on a frame boundary, so the decoder never meets
           a truncated frame. */
        let end = win.length;
        if (b < file.size) {
          const tailFrom = Math.max(first.at + 1, win.length - 65536);
          const tail = scanFrames(win.subarray(tailFrom), layout, 1 << 20);
          if (!tail.length) return null;
          end = tailFrom + tail[tail.length - 1].at;
        }
        const planes = await decodeBytes(ctx, concat(head, win.subarray(first.at, end)));
        return planes ? { start: startSec, rate: ctx.sampleRate, planes } : null;
      }
      return null;
    },
  };
}

/* ---------- MP3 ---------- */

/** Every INDEX_EVERY-th frame's byte offset, found by walking the frame
    headers once in 1 MB File.slice chunks. Frame n starts at n × spf
    samples, so a window cut at an indexed frame starts at an exact time —
    the Xing table alone is only good to ~0.1 s. */
const INDEX_EVERY = 32;

async function indexMp3(file: File, audioStart: number): Promise<{ offs: Float64Array; count: number } | null> {
  const offs: number[] = [];
  let off = audioStart;
  let frame = 0;
  const CHUNK = 1 << 20;
  while (off + 4 < file.size) {
    const buf = await readBytes(file, off, Math.min(file.size, off + CHUNK));
    let j = 0;
    let lost = false;
    while (j + 4 <= buf.length) {
      const f = mp3FrameAt(buf, j);
      if (!f) {
        lost = true;
        break;
      }
      if (j + f.len > buf.length) break;
      if (frame % INDEX_EVERY === 0) offs.push(off + j);
      frame++;
      j += f.len;
    }
    /* junk between frames (or the ID3v1 tag at the end): the frame count
       is no longer exact past it, so the index ends here */
    if (lost || j === 0) break;
    off += j;
  }
  return offs.length ? { offs: Float64Array.from(offs), count: frame } : null;
}

async function mp3Source(file: File, ctx: BaseAudioContext, duration: number): Promise<WindowSource | null> {
  const skip = id3v2Size(await readBytes(file, 0, 10));
  const head = await readBytes(file, skip, skip + 65536);
  const at = findMp3Sync(head);
  if (at < 0) return null;
  const first = mp3FrameAt(head, at);
  if (!first) return null;
  const xing = readXing(head, at, first);
  /* A Xing/Info frame carries no audio: the audio starts after it. */
  const audioStart = skip + at + (xing ? first.len : 0);
  const map = new Mp3Map(audioStart, file.size, duration, xing, first);
  const bps = map.duration > 0 ? map.audioBytes / map.duration : 24000;
  const frameSec = first.spf / first.rate;
  /* where source time 0 sits in the decoded stream (see XingInfo) */
  const trim = xing && xing.encDelay >= 0 ? (xing.encDelay + 529) / first.rate : 0;
  let index: { offs: Float64Array; count: number } | null = null;
  const indexing = indexMp3(file, audioStart)
    .then((x) => {
      index = x;
    })
    .catch(() => {});

  const decodeFrom = async (a: number, startSec: number | null, to: number): Promise<DecodedWindow | null> => {
    const from = startSec === null ? map.timeAt(a) : startSec;
    const b = Math.min(file.size, Math.ceil(a + Math.max(1, to - from) * bps * 1.3) + 16384);
    const win = await readBytes(file, a, b);
    const i = findMp3Sync(win);
    if (i < 0 || (startSec !== null && i !== 0)) return null;
    const end = lastMp3FrameEnd(win, i);
    if (end <= i) return null;
    const planes = await decodeBytes(ctx, win.slice(i, end));
    return planes ? { start: (startSec !== null ? startSec : map.timeAt(a + i)) - trim, rate: ctx.sampleRate, planes } : null;
  };

  return {
    kind: 'mp3',
    async decode(from, to) {
      /* a little before `from`: the bit reservoir makes the first frames
         of a cut decode as silence */
      const lead = Math.max(0, from - 0.15);
      /* the index is a fraction of a second away on a first grab: worth
         waiting a moment for an exact start */
      if (!index) await Promise.race([indexing, new Promise((r) => setTimeout(r, 400))]);
      const x = index as { offs: Float64Array; count: number } | null;
      if (x) {
        const e = Math.min(x.offs.length - 1, Math.floor(lead / frameSec / INDEX_EVERY));
        const w = await decodeFrom(x.offs[e], e * INDEX_EVERY * frameSec, to);
        if (w) return w;
      }
      return decodeFrom(Math.max(audioStart, Math.floor(map.byteAt(lead))), null, to);
    },
  };
}

/* ---------- WAV ---------- */

async function wavSource(file: File, ctx: BaseAudioContext): Promise<WindowSource | null> {
  const w = await readWavLayout((a, b) => readBytes(file, a, b), file.size);
  if (!w) return null;
  return {
    kind: 'wav',
    async decode(from, to) {
      const f0 = Math.max(0, Math.floor(from * w.rate));
      const f1 = Math.min(w.frames, Math.ceil(to * w.rate));
      if (f1 <= f0) return null;
      const data = await readBytes(file, w.dataStart + f0 * w.blockAlign, w.dataStart + f1 * w.blockAlign);
      const planes = await decodeBytes(ctx, buildWav(w.fmt, data));
      return planes ? { start: f0 / w.rate, rate: ctx.sampleRate, planes } : null;
    },
  };
}

/* ---------- MP4 ---------- */

/** Reads samples [k0, k1] as one array per sample, grouping neighbours
    that sit next to each other in the file into one read. */
async function readSamples(file: File, d: Mp4Audio, k0: number, k1: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  let k = k0;
  while (k <= k1) {
    let j = k;
    while (j < k1 && d.offsets[j + 1] === d.offsets[j] + d.sizes[j] && d.offsets[j + 1] + d.sizes[j + 1] - d.offsets[k] < 4194304) j++;
    const base = d.offsets[k];
    const run = await readBytes(file, base, d.offsets[j] + d.sizes[j]);
    for (let s = k; s <= j; s++) out.push(run.subarray(d.offsets[s] - base, d.offsets[s] - base + d.sizes[s]));
    k = j + 1;
  }
  return out;
}

function sampleRange(d: Mp4Audio, from: number, to: number, preroll: number): [number, number] {
  const k0 = Math.max(0, sampleAtFrame(d, Math.max(0, from) * d.sampleRate + d.startSkip) - preroll);
  const k1 = Math.min(d.count - 1, sampleAtFrame(d, to * d.sampleRate + d.startSkip) + 1);
  return [k0, k1];
}

async function aacSource(file: File, ctx: BaseAudioContext, d: Mp4Audio): Promise<WindowSource | null> {
  let cfg: AdtsConfig | null = null;
  if (d.moovSize > 0 && d.moovSize < 16777216) {
    const asc = ascFromMoov(await readBytes(file, d.moovStart, d.moovStart + d.moovSize));
    if (asc) cfg = adtsFromAsc(asc);
  }
  if (!cfg) cfg = adtsGuess(d.sampleRate, d.channels);
  if (!cfg) return null;
  const c = cfg;
  return {
    kind: 'aac',
    async decode(from, to) {
      const [k0, k1] = sampleRange(d, from, to, 2);
      if (k1 < k0) return null;
      const raw = await readSamples(file, d, k0, k1);
      let total = 0;
      for (const r of raw) total += r.length + 7;
      const adts = new Uint8Array(total);
      let p = 0;
      for (const r of raw) p = adtsFrame(c, r, adts, p);
      const planes = await decodeBytes(ctx, adts);
      return planes ? { start: (d.pts[k0] - d.startSkip) / d.sampleRate, rate: ctx.sampleRate, planes } : null;
    },
  };
}

async function webCodecsSource(file: File, d: Mp4Audio): Promise<WindowSource | null> {
  const config = await probeWebCodecs(d);
  if (!config) return null;
  return {
    kind: 'webcodecs',
    async decode(from, to) {
      const [k0, k1] = sampleRange(d, from, to, 1);
      if (k1 < k0) return null;
      const raw = await readSamples(file, d, k0, k1);
      const parts: Float32Array[][] = [];
      let frames = 0;
      let failed = false;
      const dec = new AudioDecoder({
        output: (data: AudioData) => {
          try {
            const ch: Float32Array[] = [];
            for (let c = 0; c < data.numberOfChannels; c++) {
              const p = new Float32Array(data.numberOfFrames);
              data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
              ch.push(p);
            }
            parts.push(ch);
            frames += data.numberOfFrames;
          } finally {
            data.close();
          }
        },
        error: () => {
          failed = true;
        },
      });
      try {
        dec.configure(config);
        for (let s = 0; s < raw.length; s++) {
          dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(((d.pts[k0 + s] - d.startSkip) / d.sampleRate) * 1e6), data: raw[s] }));
        }
        await dec.flush();
      } catch {
        failed = true;
      } finally {
        try {
          dec.close();
        } catch {
          /* already closed by an error */
        }
      }
      if (failed || !frames || !parts.length) return null;
      const nch = parts[0].length;
      const joined: Float32Array[] = [];
      for (let c = 0; c < nch; c++) {
        const plane = new Float32Array(frames);
        let at = 0;
        for (const part of parts) {
          plane.set(part[c] || part[0], at);
          at += part[0].length;
        }
        joined.push(plane);
      }
      return { start: (d.pts[k0] - d.startSkip) / d.sampleRate, rate: d.sampleRate, planes: toStereo(joined) };
    },
  };
}

/* ---------- picking one ---------- */

/** A window source for the file, or null when there is no way to decode
    its middle here. `duration` is the source file's length in seconds
    (used where the file itself does not say, as in a CBR MP3). */
export async function openWindowSource(file: File, duration: number, ctx: BaseAudioContext): Promise<WindowSource | null> {
  const magic = await readBytes(file, 0, 12);
  if (magic.length < 12) return null;
  const tag = (o: number): string => String.fromCharCode(magic[o], magic[o + 1], magic[o + 2], magic[o + 3]);
  if (tag(0) === 'fLaC') return flacSource(file, ctx);
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') return wavSource(file, ctx);
  if (tag(4) === 'ftyp') {
    const d = await demuxMp4(fileReader(file), file.size);
    if (!d.count) return null;
    if (d.codec === 'mp4a') return aacSource(file, ctx, d);
    return webCodecsSource(file, d);
  }
  if (tag(0).slice(0, 3) === 'ID3' || (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0)) return mp3Source(file, ctx, duration);
  return null;
}
