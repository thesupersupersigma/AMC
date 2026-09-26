/* Synthetic MP4 builder for the engine tests. Writes real ISO-BMFF: ftyp,
   moov (mvhd, trak… with edts/elst, mdhd, hdlr, stsd, stts, stsc,
   stsz|stz2, stco|co64, optional udta/meta/ilst/covr) and mdat, with moov
   before or after mdat. Everything big-endian. No dependencies. */

export function u8(v) {
  return Uint8Array.of(v & 255);
}
export function u16(v) {
  return Uint8Array.of((v >>> 8) & 255, v & 255);
}
export function u32(v) {
  return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}
export function u64(v) {
  const hi = Math.floor(v / 4294967296);
  const lo = v - hi * 4294967296;
  return concat([u32(hi), u32(lo)]);
}
export function ascii(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(8 + body.length), ascii(type), body]);
}
export function fullbox(type, version, flags, ...payload) {
  return box(type, u8(version), u8(flags >>> 16), u16(flags & 0xffff), ...payload);
}

/* ---------- codec configuration boxes ---------- */

/** The full 36-byte 'alac' atom (what FFmpeg wants as extradata). */
export function alacAtom({ frameLength = 4096, bitDepth = 16, channels = 2, sampleRate = 44100, maxFrameBytes = 0, avgBitRate = 0 } = {}) {
  return fullbox(
    'alac',
    0,
    0,
    u32(frameLength),
    u8(0),
    u8(bitDepth),
    u8(40),
    u8(10),
    u8(14),
    u8(channels),
    u16(255),
    u32(maxFrameBytes),
    u32(avgBitRate),
    u32(sampleRate)
  );
}

/** dec3 for one independent substream. joc adds the Atmos (JOC) extension. */
export function dec3Box({ dataRate = 768, fscod = 0, bsid = 16, bsmod = 0, acmod = 7, lfeon = 1, joc = false } = {}) {
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(dataRate, 13);
  put(0, 3); /* num_ind_sub - 1 */
  put(fscod, 2);
  put(bsid, 5);
  put(0, 1); /* reserved */
  put(0, 1); /* asvc */
  put(bsmod, 3);
  put(acmod, 3);
  put(lfeon, 1);
  put(0, 3); /* reserved */
  put(0, 4); /* num_dep_sub */
  put(0, 1); /* reserved */
  if (joc) {
    put(0, 7);
    put(1, 1); /* flag_ec3_extension_type_a */
    put(16, 8); /* complexity_index_type_a */
  }
  while (bits.length % 8) bits.push(0);
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
  return box('dec3', bytes);
}

export function dac3Box({ fscod = 0, bsid = 8, bsmod = 0, acmod = 2, lfeon = 0, bitRateCode = 10 } = {}) {
  const v = (fscod << 22) | (bsid << 17) | (bsmod << 14) | (acmod << 11) | (lfeon << 10) | (bitRateCode << 5);
  return box('dac3', Uint8Array.of((v >>> 16) & 255, (v >>> 8) & 255, v & 255));
}

/* ---------- sample entries ---------- */

function audioEntry(fourcc, { channels, sampleSize = 16, sampleRate, version = 0, children = [] }) {
  const rateField = sampleRate <= 65535 ? sampleRate * 65536 : 0;
  const parts = [
    new Uint8Array(6), /* reserved */
    u16(1), /* data_reference_index */
    u16(version),
    u16(0), /* revision */
    u32(0), /* vendor */
    u16(channels),
    u16(sampleSize),
    u16(0), /* compression id */
    u16(0), /* packet size */
    u32(rateField),
  ];
  if (version === 1) parts.push(u32(4096), u32(0), u32(0), u32(2));
  if (version === 2) parts.push(new Uint8Array(36));
  return box(fourcc, ...parts, ...children);
}

function visualEntry(fourcc, width, height) {
  return box(
    fourcc,
    new Uint8Array(6),
    u16(1),
    new Uint8Array(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Uint8Array(32),
    u16(0x18),
    u16(0xffff)
  );
}

/* ---------- sample tables ---------- */

function sttsBox(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return fullbox('stts', 0, 0, u32(runs.length), ...runs.map(([n, d]) => concat([u32(n), u32(d)])));
}

function stscBox(chunkSizes) {
  const runs = [];
  chunkSizes.forEach((n, i) => {
    const last = runs[runs.length - 1];
    if (!last || last[1] !== n) runs.push([i + 1, n]);
  });
  return fullbox('stsc', 0, 0, u32(runs.length), ...runs.map(([first, n]) => concat([u32(first), u32(n), u32(1)])));
}

function stszBox(sizes, stz2Bits) {
  if (stz2Bits) {
    const parts = [new Uint8Array(3), u8(stz2Bits), u32(sizes.length)];
    if (stz2Bits === 4) {
      const packed = new Uint8Array(Math.ceil(sizes.length / 2));
      sizes.forEach((s, i) => {
        packed[i >> 1] |= (s & 15) << (i & 1 ? 0 : 4);
      });
      parts.push(packed);
    } else {
      for (const s of sizes) parts.push(stz2Bits === 8 ? u8(s) : u16(s));
    }
    return fullbox('stz2', 0, 0, ...parts);
  }
  const allSame = sizes.length > 0 && sizes.every((s) => s === sizes[0]);
  if (allSame) return fullbox('stsz', 0, 0, u32(sizes[0]), u32(sizes.length));
  return fullbox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
}

function chunkOffsetBox(offsets, co64) {
  return co64 ? fullbox('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)) : fullbox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32));
}

/* ---------- movie ---------- */

function trakBox(t, id, chunkOffsets, movieTimescale) {
  const mediaDuration = t.durations.reduce((a, b) => a + b, 0);
  const handlerType = t.handler || 'soun';
  let entry;
  if (handlerType === 'soun') {
    entry = audioEntry(t.codec, { channels: t.channels, sampleSize: t.sampleSize || 16, sampleRate: t.sampleRate, version: t.entryVersion || 0, children: t.config ? [t.config] : [] });
  } else {
    entry = visualEntry(t.codec || 'jpeg', t.width || 1500, t.height || 1500);
  }
  const stbl = box(
    'stbl',
    fullbox('stsd', 0, 0, u32(1), entry),
    sttsBox(t.durations),
    stscBox(t.chunkSizes),
    stszBox(
      t.samples.map((s) => s.length),
      t.stz2Bits
    ),
    chunkOffsetBox(chunkOffsets, t.co64)
  );
  const minfHeader = handlerType === 'soun' ? fullbox('smhd', 0, 0, u32(0)) : fullbox('vmhd', 0, 1, new Uint8Array(8));
  const minf = box('minf', minfHeader, box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1))), stbl);
  const mdhd =
    t.mdhdVersion === 1
      ? fullbox('mdhd', 1, 0, u64(0), u64(0), u32(t.timescale), u64(mediaDuration), u16(0x55c4), u16(0))
      : fullbox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), ascii(handlerType), new Uint8Array(12), ascii('AMC test\0'));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const movieDur = Math.round((mediaDuration / t.timescale) * movieTimescale);
  const tkhd = fullbox('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(movieDur), new Uint8Array(52), u32(0), u32(0));
  const parts = [tkhd];
  if (t.elst) {
    const entries = t.elst.map((e) => concat([u32(e.segmentDuration), u32(e.mediaTime < 0 ? 0xffffffff : e.mediaTime), u16(1), u16(0)]));
    parts.push(box('edts', fullbox('elst', 0, 0, u32(t.elst.length), ...entries)));
  }
  parts.push(mdia);
  return box('trak', ...parts);
}

function udtaCover(cover) {
  const covr = box('covr', box('data', u32(13), u32(0), cover));
  const ilst = box('ilst', covr, box('©nam', box('data', u32(1), u32(0), ascii('Synthetic'))));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), ascii('mdir'), ascii('appl'), new Uint8Array(9));
  return box('udta', fullbox('meta', 0, 0, hdlr, ilst));
}

/**
 * tracks: [{ handler: 'soun'|'vide', codec, timescale, sampleRate, channels,
 *   sampleSize, config (child box), samples: Uint8Array[], durations: number[],
 *   samplesPerChunk = 8, stz2Bits, co64, elst: [{segmentDuration, mediaTime}],
 *   entryVersion, mdhdVersion }]
 * opts: { moovAtEnd, cover (Uint8Array), movieTimescale = 1000, mdatPadding }
 * Returns { bytes, sampleOffsets: number[][] }.
 */
export function buildMp4(tracks, opts = {}) {
  const movieTimescale = opts.movieTimescale || 1000;
  for (const t of tracks) {
    const per = t.samplesPerChunk || 8;
    t.chunkSizes = [];
    for (let i = 0; i < t.samples.length; i += per) t.chunkSizes.push(Math.min(per, t.samples.length - i));
  }
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));

  /* mdat layout: chunks interleaved track by track, in chunk order. */
  const layout = [];
  const maxChunks = Math.max(...tracks.map((t) => t.chunkSizes.length));
  for (let c = 0; c < maxChunks; c++) {
    tracks.forEach((t, ti) => {
      if (c < t.chunkSizes.length) layout.push([ti, c]);
    });
  }
  const pad = opts.mdatPadding || new Uint8Array(0);
  const mdatParts = [pad];
  const rel = tracks.map(() => []);
  const sampleRel = tracks.map(() => []);
  let at = pad.length;
  for (const [ti, c] of layout) {
    const t = tracks[ti];
    const first = t.chunkSizes.slice(0, c).reduce((a, b) => a + b, 0);
    rel[ti][c] = at;
    for (let s = first; s < first + t.chunkSizes[c]; s++) {
      sampleRel[ti][s] = at;
      mdatParts.push(t.samples[s]);
      at += t.samples[s].length;
    }
  }
  const mdatBody = concat(mdatParts);
  const mdat = concat([u32(8 + mdatBody.length), ascii('mdat'), mdatBody]);

  const buildMoov = (mdatBodyStart) => {
    const mvhdDur = Math.max(...tracks.map((t) => Math.round((t.durations.reduce((a, b) => a + b, 0) / t.timescale) * movieTimescale)));
    const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(mvhdDur), u32(0x00010000), u16(0x0100), new Uint8Array(10), new Uint8Array(36), new Uint8Array(24), u32(tracks.length + 1));
    const traks = tracks.map((t, ti) => trakBox(t, ti + 1, rel[ti].map((r) => r + mdatBodyStart), movieTimescale));
    const parts = [mvhd, ...traks];
    if (opts.cover) parts.push(udtaCover(opts.cover));
    return box('moov', ...parts);
  };

  let bytes;
  let mdatBodyStart;
  if (opts.moovAtEnd) {
    mdatBodyStart = ftyp.length + 8;
    bytes = concat([ftyp, mdat, buildMoov(mdatBodyStart)]);
  } else {
    const probe = buildMoov(0);
    mdatBodyStart = ftyp.length + probe.length + 8;
    bytes = concat([ftyp, buildMoov(mdatBodyStart), mdat]);
  }
  return { bytes, sampleOffsets: sampleRel.map((list) => list.map((r) => r + mdatBodyStart)) };
}

/** A fake but header-correct E-AC-3 syncframe: 6 blocks, independent. */
export function eac3Frame({ bytes = 1536, fscod = 0, acmod = 7, lfeon = 1, bsid = 16 } = {}) {
  const f = new Uint8Array(bytes);
  const frmsiz = bytes / 2 - 1;
  f[0] = 0x0b;
  f[1] = 0x77;
  f[2] = (0 << 6) | (0 << 3) | ((frmsiz >> 8) & 7);
  f[3] = frmsiz & 255;
  f[4] = (fscod << 6) | (3 << 4) | (acmod << 1) | lfeon;
  f[5] = bsid << 3;
  return f;
}

/** A fake AC-3 syncframe header (bsid 8). */
export function ac3Frame(bytes = 768) {
  const f = new Uint8Array(bytes);
  f[0] = 0x0b;
  f[1] = 0x77;
  f[4] = 0x0e;
  f[5] = 8 << 3;
  return f;
}
