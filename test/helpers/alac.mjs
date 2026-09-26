/* A verbatim ("escape") ALAC encoder for tests. Escape frames store PCM
   uncompressed, but they are ordinary, valid ALAC — every decoder must
   reproduce them exactly — so the engine can be tested without an
   encoder binary. Mono (SCE) and stereo (CPE) only. */

class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.n = 0;
  }
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      const bit = Math.floor(value / 2 ** i) % 2;
      this.cur = (this.cur << 1) | bit;
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  finish() {
    if (this.n) this.bytes.push(this.cur << (8 - this.n));
    this.cur = 0;
    this.n = 0;
    return Uint8Array.from(this.bytes);
  }
}

/** channels: Int32Array per channel (same length). */
export function alacVerbatimPacket(channels, bitDepth, frameLength) {
  const n = channels[0].length;
  const w = new BitWriter();
  w.put(channels.length === 2 ? 1 : 0, 3); /* ID_CPE / ID_SCE */
  w.put(0, 4); /* element instance tag */
  w.put(0, 12); /* unused */
  const partial = n !== frameLength;
  w.put(partial ? 1 : 0, 1);
  w.put(0, 2); /* bytes shifted */
  w.put(1, 1); /* escape: uncompressed */
  if (partial) w.put(n, 32);
  const mod = 2 ** bitDepth;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels.length; c++) {
      const v = channels[c][i];
      w.put(v < 0 ? v + mod : v, bitDepth);
    }
  }
  w.put(7, 3); /* ID_END */
  return w.finish();
}

/** Deterministic test PCM: a sine plus a little LCG noise, per channel. */
export function testPcm(frames, channelCount, bitDepth, seed = 1) {
  const full = 2 ** (bitDepth - 1) - 1;
  const out = [];
  let s = seed >>> 0;
  for (let c = 0; c < channelCount; c++) {
    const ch = new Int32Array(frames);
    for (let i = 0; i < frames; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const noise = (s / 4294967296 - 0.5) * 0.02;
      const v = 0.45 * Math.sin((2 * Math.PI * (440 + 110 * c) * i) / 44100) + noise;
      ch[i] = Math.max(-full - 1, Math.min(full, Math.round(v * full)));
    }
    out.push(ch);
  }
  return out;
}

/** Splits PCM into ALAC packets of frameLength (last one partial). */
export function alacPackets(pcm, bitDepth, frameLength) {
  const total = pcm[0].length;
  const packets = [];
  const durations = [];
  for (let at = 0; at < total; at += frameLength) {
    const n = Math.min(frameLength, total - at);
    packets.push(
      alacVerbatimPacket(
        pcm.map((ch) => ch.subarray(at, at + n)),
        bitDepth,
        frameLength
      )
    );
    durations.push(n);
  }
  return { packets, durations };
}
