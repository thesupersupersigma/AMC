/* A verbatim-subframe FLAC encoder, for tests only. FLAC-in-MP4 is decoded
   by WebCodecs in Chromium, so the browser tests can push REAL audio
   through the whole engine (Worker → Worklet → output) even while the WASM
   decoder is the silent stub. Fixed block size, independent channels. */

import { fullbox } from './mp4build.mjs';

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

class Bits {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.n = 0;
  }
  put(v, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) % 2);
      if (++this.n === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  align() {
    if (this.n) this.put(0, 8 - this.n);
  }
}

const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
const BPS_CODES = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

function utf8Number(n) {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 63)];
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63)];
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 63), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63)];
}

/** One FLAC frame from Int32Array channels (same length). */
export function flacFrame(channels, frameNumber, sampleRate, bps) {
  const n = channels[0].length;
  const w = new Bits();
  w.put(0xfff8, 16);
  w.put(7, 4); /* block size: 16-bit (n-1) at end of header */
  w.put(RATE_CODES[sampleRate], 4);
  w.put(channels.length - 1, 4);
  w.put(BPS_CODES[bps], 3);
  w.put(0, 1);
  for (const b of utf8Number(frameNumber)) w.put(b, 8);
  w.put(n - 1, 16);
  let crc = 0;
  for (const b of w.bytes) crc = CRC8[crc ^ b];
  w.put(crc, 8);
  const mod = 2 ** bps;
  for (const ch of channels) {
    w.put(0x02, 8); /* pad 0, type VERBATIM (000001), no wasted bits */
    for (let i = 0; i < n; i++) w.put(ch[i] < 0 ? ch[i] + mod : ch[i], bps);
  }
  w.align();
  let c16 = 0;
  for (const b of w.bytes) c16 = ((c16 << 8) & 0xffff) ^ CRC16[(c16 >> 8) ^ b];
  w.put(c16, 16);
  return Uint8Array.from(w.bytes);
}

/** The 'dfLa' box: FullBox + a last-block STREAMINFO. */
export function dflaBox({ sampleRate, channels, bps, blockSize, totalSamples }) {
  const si = new Bits();
  si.put(blockSize, 16);
  si.put(blockSize, 16);
  si.put(0, 24);
  si.put(0, 24);
  si.put(sampleRate, 20);
  si.put(channels - 1, 3);
  si.put(bps - 1, 5);
  si.put(totalSamples, 36);
  for (let i = 0; i < 16; i++) si.put(0, 8);
  const body = Uint8Array.from(si.bytes);
  const header = Uint8Array.of(0x80, 0, 0, 34);
  return fullbox('dfLa', 0, 0, header, body);
}

/** FLAC-in-MP4 track spec for buildMp4 from Int32Array PCM channels. */
export function flacTrack(pcm, { sampleRate = 44100, bps = 16, blockSize = 4096, samplesPerChunk = 8 } = {}) {
  const total = pcm[0].length;
  const samples = [];
  const durations = [];
  let frame = 0;
  for (let at = 0; at < total; at += blockSize) {
    const n = Math.min(blockSize, total - at);
    samples.push(
      flacFrame(
        pcm.map((c) => c.subarray(at, at + n)),
        frame++,
        sampleRate,
        bps
      )
    );
    durations.push(n);
  }
  return {
    handler: 'soun',
    codec: 'fLaC',
    timescale: sampleRate,
    sampleRate,
    channels: pcm.length,
    sampleSize: bps,
    config: dflaBox({ sampleRate, channels: pcm.length, bps, blockSize, totalSamples: total }),
    samples,
    durations,
    samplesPerChunk,
  };
}

/** Continuous sine PCM (Int32) — `offset` continues a previous run. */
export function sinePcm(frames, channels, { rate = 44100, freq = 441, amp = 0.5, bps = 16, offset = 0 } = {}) {
  const full = 2 ** (bps - 1) - 1;
  const out = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Int32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = Math.round(amp * full * Math.sin((2 * Math.PI * freq * (offset + i)) / rate + c * 0.5));
    out.push(ch);
  }
  return out;
}

