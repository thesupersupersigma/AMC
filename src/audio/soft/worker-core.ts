/* The decode Worker: owns the demux tables and the decoder, reads packets
   in batches with File.slice (a few hundred KB at a time — never the whole
   file), decodes, trims to the audible window, and posts planar float32
   chunks (transferred, not copied) straight to the AudioWorklet over a
   MessagePort. It keeps ~2 s buffered and refills below ~1 s, driven by
   the worklet's read-head reports. Those are seconds of LISTENING: at a
   playback rate above 1 the worklet drains the buffer that many times
   faster, so both marks scale with the rate it reports.

   Gapless: a queued next segment is demuxed ahead of time and spliced in
   the moment the current one's last packet is decoded — the worklet sees
   one continuous stream with a segment tag, so the next track's first
   chunk is decoded long before the current one ends.

   Spatial hook: for E-AC-3 with a registered SpatialProcessor, every
   decoded packet + its core PCM go through process(); the worklet is sized
   to maxChannels and plays the returned block; keyframes are relayed to
   the main thread stamped with the block's absolute stream frame. */

import { demuxMp4, fileReader, sampleAtFrame, type Mp4Audio } from '../mp4samples';
import { loadDecoderModule, type DecoderModule } from '../../../vendor/decoder/decoder.js';
import { WasmBackend, WebCodecsBackend, probeWebCodecs, type Backend } from './backends';
import { getSpatialProcessorFactory, type SpatialProcessor } from '../spatial/contract';
import type { EngineAnalysis, EngineSource, FromWorker, ToWorker, ToWorklet, TrackInfo, WorkletToWorker } from './protocol';
import { MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED } from './protocol';

const TARGET_SEC = 2.0;
const LOW_SEC = 1.0;
const CHUNK_SEC = 0.1;
const READ_WINDOW = 384 * 1024;
const MAX_BATCH = 192;
/* A batch also stops at this much audio, so the buffer overshoots its
   target by at most this (E-AC-3 at 768 kb/s packs 4 s into one window). */
const BATCH_SEC = 1.0;
const MEDIA_ERR_NETWORK = 2;

interface WorkerScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

interface Segment {
  seg: number;
  src: EngineSource;
  demux: Mp4Audio;
  backend: Backend;
  info: TrackInfo;
  spatial: SpatialProcessor | null;
  /** Last object count relayed to the main thread. */
  objects: number;
  outChannels: number;
  /** Next packet to submit. */
  next: number;
  /** Pre-edit frame of the next decoded output sample. */
  cursor: number;
  /** Media frame before which output is discarded (seek target). */
  keepFrom: number;
  submittedAll: boolean;
  eosSent: boolean;
  decodeErrors: number;
}

interface Pending {
  seg: number;
  media: number;
  planes: Float32Array[][];
  frames: number;
  channels: number;
}

class NotSupported extends Error {}

export function startDecodeWorker(scope: WorkerScope): void {
  const post = (m: FromWorker, transfer?: Transferable[]): void => scope.postMessage(m, transfer || []);
  const log = (message: string, detail?: string): void => post({ t: 'log', message, detail });

  let port: MessagePort | null = null;
  let wasmSource: string | null = null;
  let wasmModule: Promise<DecoderModule> | null = null;
  let allowWebCodecs = true;
  let devCodecs = false;
  let stubAnnounced = false;

  let gen = 0;
  let started = false;
  let cur: Segment | null = null;
  let prev: Segment | null = null; /* spliced-out segment still audible */
  let nextSeg: Segment | null = null;
  let nextWanted = -1;
  let pending: Pending | null = null;
  let stream = 0; /* next stream frame to assign */
  let genStart = 0;
  let head = 0;
  let headGen = -1;
  /** The worklet's playback rate (source frames per output frame). */
  let rate = 1;
  let pumping = false;

  const toWorklet = (m: ToWorklet, transfer?: Transferable[]): void => {
    if (!port) return;
    try {
      port.postMessage(m, transfer || []);
    } catch (e) {
      log('Could not hand audio to the player', (e as Error).message);
    }
  };

  function getModule(): Promise<DecoderModule> {
    if (!wasmModule) {
      if (!wasmSource) return Promise.reject(new Error('decoder not initialised'));
      wasmModule = loadDecoderModule(wasmSource, (line) => log('decoder: ' + line));
      wasmModule.then(
        (m) => {
          if (m.isStub && !stubAnnounced) {
            stubAnnounced = true;
            log('Software decoder is a silent stub — engine tracks play silence', m.version);
          }
        },
        () => {
          wasmModule = null;
        }
      );
    }
    return wasmModule;
  }

  async function openBackend(d: Mp4Audio): Promise<Backend> {
    if (allowWebCodecs || d.codec === 'fLaC') {
      const cfg = await probeWebCodecs(d);
      if (cfg) return new WebCodecsBackend(cfg);
    }
    if (d.codec === 'fLaC') throw new NotSupported('flac: no WebCodecs decoder here');
    const mod = await getModule();
    const b = WasmBackend.open(mod, d);
    if (!b) throw new NotSupported('the decoder refused ' + d.codec);
    return b;
  }

  function engineCodecOk(codec: string): boolean {
    return codec === 'alac' || codec === 'ac-3' || codec === 'ec-3' || (devCodecs && codec === 'fLaC');
  }

  async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  /** Channels of the decoded core, learned from the first packet. */
  async function probeCoreChannels(d: Mp4Audio, b: Backend, file: File): Promise<number> {
    if (b.kind !== 'wasm' || !d.count) return d.channels;
    let ch = d.channels;
    const pkt = await readBytes(file, d.offsets[0], d.offsets[0] + d.sizes[0]);
    const prevOut = b.onOutput;
    b.onOutput = (_p, planes) => {
      ch = planes.length || ch;
    };
    b.decode(pkt);
    b.onOutput = prevOut;
    b.reset();
    return ch;
  }

  async function makeSegment(seg: number, src: EngineSource, wantSpatial: boolean): Promise<Segment> {
    if (!engineCodecOk(src.codec)) throw new NotSupported(src.codec + ' is not an engine codec');
    let d: Mp4Audio;
    try {
      d = await demuxMp4(fileReader(src.file), src.file.size);
    } catch (e) {
      throw new NotSupported('could not read the MP4 sample tables: ' + (e as Error).message);
    }
    if (!engineCodecOk(d.codec)) throw new NotSupported('the audio track is ' + d.codec);
    if (!d.count || !d.sampleRate) throw new NotSupported('no audio samples');
    const backend = await openBackend(d);
    const coreChannels = await probeCoreChannels(d, backend, src.file);
    let spatial: SpatialProcessor | null = null;
    let outChannels = coreChannels;
    let spatialInfo: TrackInfo['spatial'] = null;
    const factory = getSpatialProcessorFactory();
    if (wantSpatial && factory && d.codec === 'ec-3' && d.dec3) {
      try {
        spatial = factory({ codec: 'ec-3', sampleRate: d.sampleRate, coreChannels, dec3: d.dec3 });
      } catch (e) {
        log('The spatial processor failed to start — playing the 5.1 core', (e as Error).message);
        spatial = null;
      }
      if (spatial) {
        /* The processor's own bed (Atmos: ['LFE']); every other channel up
           to maxChannels is an object. */
        const bedLayout = Array.from(spatial.bedLayout || []);
        const max = Math.max(1, bedLayout.length, Math.min(32, spatial.maxChannels | 0));
        outChannels = max;
        spatialInfo = { maxChannels: max, bedLayout, bedChannels: bedLayout.length, objectChannels: max - bedLayout.length };
      }
    }
    const info: TrackInfo = {
      codec: d.codec,
      sampleRate: d.sampleRate,
      channels: outChannels,
      coreChannels,
      bitDepth: d.bitDepth,
      duration: d.duration,
      frames: d.playFrames,
      backend: backend.kind,
      isStub: backend.isStub,
      decoderVersion: backend.version,
      joc: !!(d.ec3 && d.ec3.joc),
      spatial: spatialInfo,
    };
    const s: Segment = {
      seg,
      src,
      demux: d,
      backend,
      info,
      spatial,
      objects: 0,
      outChannels,
      next: 0,
      cursor: 0,
      keepFrom: 0,
      submittedAll: false,
      eosSent: false,
      decodeErrors: 0,
    };
    backend.onOutput = (packet, planes, frames) => onOutput(s, packet, planes, frames);
    return s;
  }

  function closeSegment(s: Segment | null): void {
    if (!s) return;
    try {
      s.backend.close();
    } catch {
      /* already closed */
    }
    if (s.spatial) {
      try {
        s.spatial.dispose();
      } catch {
        /* the add-on's problem */
      }
    }
  }

  /** Positions a segment so its next output starts at media frame `frame`. */
  function positionAt(s: Segment, frame: number): void {
    const d = s.demux;
    const target = Math.max(0, Math.min(frame, d.playFrames));
    let k = sampleAtFrame(d, target + d.startSkip);
    /* (E-)AC-3 blocks overlap-add with the previous frame: decode one
       packet of pre-roll so the first kept samples are exact. ALAC packets
       stand alone. */
    if (d.codec !== 'alac' && k > 0) k--;
    s.backend.reset();
    if (s.spatial) s.spatial.reset();
    s.next = k;
    s.cursor = d.pts[k];
    s.keepFrom = target;
    s.submittedAll = k >= d.count;
    s.eosSent = false;
  }

  /* ---------- output path ---------- */

  function buffered(): number {
    const h = headGen === gen ? Math.max(head, genStart) : genStart;
    return stream + (pending ? pending.frames : 0) - h;
  }

  /** `sec` seconds of listening at the current rate, in source frames. */
  function aheadFrames(s: Segment, sec: number): number {
    return sec * s.info.sampleRate * Math.max(1, rate);
  }

  function flushPending(): void {
    const p = pending;
    pending = null;
    if (!p || !p.frames) return;
    const planes: Float32Array[] = [];
    for (let c = 0; c < p.channels; c++) {
      const out = new Float32Array(p.frames);
      let at = 0;
      for (const part of p.planes[c]) {
        out.set(part, at);
        at += part.length;
      }
      planes.push(out);
    }
    toWorklet({ t: 'pcm', gen, seg: p.seg, media: p.media, stream, frames: p.frames, planes }, planes.map((x) => x.buffer));
    stream += p.frames;
  }

  function append(s: Segment, planes: Float32Array[], from: number, to: number, media: number): void {
    const n = to - from;
    if (pending && (pending.seg !== s.seg || pending.media + pending.frames !== media || pending.channels !== s.outChannels)) flushPending();
    if (!pending) {
      const lists: Float32Array[][] = [];
      for (let c = 0; c < s.outChannels; c++) lists.push([]);
      pending = { seg: s.seg, media, planes: lists, frames: 0, channels: s.outChannels };
    }
    for (let c = 0; c < s.outChannels; c++) {
      const src = planes[c];
      pending.planes[c].push(src ? src.subarray(from, to) : new Float32Array(n));
    }
    pending.frames += n;
    if (pending.frames >= CHUNK_SEC * s.info.sampleRate) flushPending();
  }

  function onOutput(s: Segment, packet: Uint8Array, core: Float32Array[], frames: number): void {
    if (s !== cur) return; /* a late output from a replaced segment */
    const d = s.demux;
    let planes = core;
    let keyframes = null;
    if (s.spatial && packet.length) {
      try {
        const block = s.spatial.process(packet, core);
        if (block && block.pcm.length) {
          planes = block.pcm;
          keyframes = block.keyframes;
        }
        const n = s.spatial.stats ? s.spatial.stats.objects | 0 : 0;
        if (n !== s.objects) {
          s.objects = n;
          post({ t: 'objects', gen, seg: s.seg, objects: n });
        }
      } catch (e) {
        log('The spatial processor threw — playing the 5.1 core from here', (e as Error).message);
        try {
          s.spatial.dispose();
        } catch {
          /* ignore */
        }
        s.spatial = null;
      }
    }
    const mediaStart = s.cursor - d.startSkip;
    s.cursor += frames;
    const from = Math.max(0, s.keepFrom - mediaStart);
    const to = Math.min(frames, d.playFrames - mediaStart);
    if (keyframes && keyframes.length) {
      const blockStart = stream + (pending ? pending.frames : 0) - from;
      post({ t: 'keyframes', gen, blockStartFrame: blockStart, keyframes });
    }
    if (to <= from) return;
    append(s, planes, from, to, mediaStart + from);
  }

  function silence(s: Segment, frames: number): void {
    const planes: Float32Array[] = [];
    for (let c = 0; c < s.info.coreChannels; c++) planes.push(new Float32Array(frames));
    onOutput(s, new Uint8Array(0), planes, frames);
  }

  /* ---------- the pump ---------- */

  async function decodeBatch(s: Segment, g: number): Promise<void> {
    const d = s.demux;
    const first = s.next;
    if (first >= d.count) {
      s.submittedAll = true;
      return;
    }
    const start = d.offsets[first];
    let last = first;
    let end = start + d.sizes[first];
    let span = d.durations[first];
    const maxSpan = BATCH_SEC * s.info.sampleRate;
    while (last + 1 < d.count && last + 1 - first < MAX_BATCH && span < maxSpan) {
      const o = d.offsets[last + 1];
      const z = d.sizes[last + 1];
      if (o < start || o + z - start > READ_WINDOW) break;
      last++;
      span += d.durations[last];
      if (o + z > end) end = o + z;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(s.src.file, start, end);
    } catch (e) {
      if (g !== gen) return;
      throw Object.assign(new Error('could not read ' + s.src.name + ': ' + (e as Error).message), { code: MEDIA_ERR_NETWORK });
    }
    if (g !== gen || s !== cur) return;
    for (let i = first; i <= last; i++) {
      const rel = d.offsets[i] - start;
      const pkt = bytes.subarray(rel, rel + d.sizes[i]);
      if (!s.backend.decode(pkt)) {
        s.decodeErrors++;
        if (s.decodeErrors <= 3) log('A packet of ' + s.src.name + ' could not be decoded — substituting silence', 'packet ' + i + ' of ' + d.count);
        silence(s, d.durations[i]);
      }
      s.next = i + 1;
      if (s.backend instanceof WebCodecsBackend && s.backend.pending() >= 32) {
        await s.backend.waitBelow(16);
        if (g !== gen || s !== cur) return;
      }
    }
    if (s.next >= d.count) s.submittedAll = true;
  }

  async function finishSegment(s: Segment, g: number): Promise<void> {
    await s.backend.drain();
    if (g !== gen || s !== cur || s.eosSent) return;
    flushPending();
    const n = nextSeg;
    if (n && n.info.sampleRate === s.info.sampleRate && n.outChannels === s.outChannels) {
      toWorklet({ t: 'eos', gen, seg: s.seg, final: false });
      s.eosSent = true;
      closeSegment(prev);
      prev = s;
      nextSeg = null;
      nextWanted = -1;
      positionAt(n, 0);
      cur = n;
    } else {
      toWorklet({ t: 'eos', gen, seg: s.seg, final: true });
      s.eosSent = true;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (let guard = 0; guard < 100000; guard++) {
        const g = gen;
        const s = cur;
        if (!s || !started || !port) break;
        if (s.eosSent) break;
        if (buffered() >= aheadFrames(s, TARGET_SEC)) break;
        try {
          if (s.submittedAll) await finishSegment(s, g);
          else await decodeBatch(s, g);
        } catch (e) {
          if (g !== gen) continue;
          const code = (e as { code?: number }).code || MEDIA_ERR_DECODE;
          post({ t: 'error', gen, seg: s.seg, message: (e as Error).message, code });
          started = false;
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  /* ---------- peaks (a separate, short-lived worker runs these) ---------- */

  async function runPeaks(id: number, src: EngineSource, buckets: number): Promise<void> {
    const d = await demuxMp4(fileReader(src.file), src.file.size);
    if (!engineCodecOk(d.codec) || !d.count) throw new Error(d.codec + ' is not an engine codec');
    let backend: Backend | null = null;
    const cfg = allowWebCodecs || d.codec === 'fLaC' ? await probeWebCodecs(d) : null;
    if (cfg) backend = new WebCodecsBackend(cfg);
    else {
      const mod = await getModule();
      if (mod.isStub) {
        post({ t: 'peaks', id, data: null, error: 'stub decoder: no real audio to measure' });
        return;
      }
      backend = WasmBackend.open(mod, d);
    }
    if (!backend) throw new Error('no decoder for ' + d.codec);
    const b = backend;
    const mins = new Float32Array(buckets);
    const maxs = new Float32Array(buckets);
    const filled = new Uint8Array(buckets);
    const avgDur = d.totalFrames / d.count;
    const take = Math.max(1, Math.ceil((0.08 * d.sampleRate) / avgDur));
    const pre = d.codec === 'alac' || d.codec === 'fLaC' ? 0 : 1;
    let bucket = 0;
    let skip = 0;
    b.onOutput = (_p, planes, frames) => {
      if (skip > 0) {
        skip--;
        return;
      }
      const ch = Math.min(2, planes.length);
      let mn = filled[bucket] ? mins[bucket] : 1;
      let mx = filled[bucket] ? maxs[bucket] : -1;
      for (let i = 0; i < frames; i++) {
        let v = planes[0][i];
        if (ch > 1) v = (v + planes[1][i]) / 2;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[bucket] = mn;
      maxs[bucket] = mx;
      filled[bucket] = 1;
    };
    for (let bi = 0; bi < buckets; bi++) {
      const target = ((bi + 0.5) / buckets) * d.playFrames + d.startSkip;
      const k = sampleAtFrame(d, target);
      const first = Math.max(0, k - pre);
      const last = Math.min(d.count - 1, k + take - 1);
      const start = d.offsets[first];
      let end = start;
      for (let i = first; i <= last; i++) end = Math.max(end, d.offsets[i] + d.sizes[i]);
      if (end - start > 4 * 1048576) continue;
      const bytes = await readBytes(src.file, start, end);
      b.reset();
      bucket = bi;
      skip = k - first;
      for (let i = first; i <= last; i++) {
        const rel = d.offsets[i] - start;
        if (rel < 0) continue;
        b.decode(bytes.subarray(rel, rel + d.sizes[i]));
      }
      await b.drain();
      if (bi % 50 === 49) post({ t: 'peaksProgress', id, fraction: (bi + 1) / buckets });
    }
    b.close();
    /* Carry the envelope across any bucket that got nothing. */
    let seeded = false;
    let lastMin = 0;
    let lastMax = 0;
    for (let i = 0; i < buckets; i++) {
      if (filled[i]) {
        lastMin = mins[i];
        lastMax = maxs[i];
        if (!seeded) {
          for (let z = 0; z < i; z++) {
            mins[z] = lastMin;
            maxs[z] = lastMax;
          }
          seeded = true;
        }
      } else if (seeded) {
        mins[i] = lastMin;
        maxs[i] = lastMax;
      }
    }
    if (!seeded) {
      post({ t: 'peaks', id, data: null, error: 'nothing decoded' });
      return;
    }
    const pairs: number[] = new Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      pairs[i * 2] = mins[i];
      pairs[i * 2 + 1] = maxs[i];
    }
    post({ t: 'peaks', id, data: { duration: d.duration, pairs } });
  }

  /* ---------- full analysis ("Find track breaks") ---------- */

  async function runAnalysis(id: number, src: EngineSource, buckets: number, windowSec: number): Promise<EngineAnalysis | null> {
    const d = await demuxMp4(fileReader(src.file), src.file.size);
    if (!engineCodecOk(d.codec) || !d.count) throw new Error(d.codec + ' is not an engine codec');
    let b: Backend | null = null;
    const cfg = allowWebCodecs || d.codec === 'fLaC' ? await probeWebCodecs(d) : null;
    if (cfg) b = new WebCodecsBackend(cfg);
    else {
      const mod = await getModule();
      if (mod.isStub) return null; /* silence would "find" breaks everywhere */
      b = WasmBackend.open(mod, d);
    }
    if (!b) throw new Error('no decoder for ' + d.codec);
    const backend = b;
    const total = d.playFrames;
    const win = Math.max(1, Math.round(windowSec * d.sampleRate));
    const rms = new Float32Array(Math.floor(total / win));
    const mins = new Float32Array(buckets).fill(1);
    const maxs = new Float32Array(buckets).fill(-1);
    let cursor = 0; /* pre-edit frame of the next output sample */
    let sum = 0;
    let inWin = 0;
    let w = 0;
    let peakRms = 0;
    backend.onOutput = (_p, planes, frames) => {
      const ch = planes.length;
      for (let i = 0; i < frames; i++) {
        const m = cursor + i - d.startSkip;
        if (m < 0 || m >= total) continue;
        let s = 0;
        for (let c = 0; c < ch; c++) s += planes[c][i];
        s /= ch;
        const bk = Math.min(buckets - 1, Math.floor((m * buckets) / total));
        if (s < mins[bk]) mins[bk] = s;
        if (s > maxs[bk]) maxs[bk] = s;
        if (w < rms.length) {
          sum += s * s;
          if (++inWin === win) {
            const v = Math.sqrt(sum / win);
            rms[w++] = v;
            if (v > peakRms) peakRms = v;
            sum = 0;
            inWin = 0;
          }
        }
      }
      cursor += frames;
    };
    let i = 0;
    let lastPost = 0;
    while (i < d.count) {
      const start = d.offsets[i];
      let last = i;
      let end = start + d.sizes[i];
      while (last + 1 < d.count && last + 1 - i < MAX_BATCH) {
        const o = d.offsets[last + 1];
        const z = d.sizes[last + 1];
        if (o < start || o + z - start > READ_WINDOW) break;
        last++;
        if (o + z > end) end = o + z;
      }
      const bytes = await readBytes(src.file, start, end);
      for (let k = i; k <= last; k++) {
        const rel = d.offsets[k] - start;
        if (!backend.decode(bytes.subarray(rel, rel + d.sizes[k]))) cursor += d.durations[k];
        if (backend instanceof WebCodecsBackend && backend.pending() >= 32) await backend.waitBelow(16);
      }
      i = last + 1;
      if (i - lastPost > d.count / 50) {
        lastPost = i;
        post({ t: 'peaksProgress', id, fraction: i / d.count });
      }
    }
    await backend.drain();
    backend.close();
    const pairs: number[] = new Array(buckets * 2);
    for (let k = 0; k < buckets; k++) {
      const filled = maxs[k] >= mins[k];
      pairs[k * 2] = filled ? mins[k] : 0;
      pairs[k * 2 + 1] = filled ? maxs[k] : 0;
    }
    return { duration: d.duration, sampleRate: d.sampleRate, win, rms: rms.subarray(0, w), peakRms, pairs };
  }

  /* ---------- messages ---------- */

  function onLevel(m: WorkletToWorker): void {
    if (m.gen !== gen) return;
    head = m.head;
    headGen = m.gen;
    rate = m.rate > 0 ? m.rate : 1;
    /* The worklet has crossed into the current segment: the spliced-out one
       can go. */
    if (prev && cur && m.seg === cur.seg) {
      closeSegment(prev);
      prev = null;
    }
    if (cur && started && !cur.eosSent && buffered() < aheadFrames(cur, LOW_SEC)) void pump();
  }

  function attachPort(p: MessagePort): void {
    if (port) port.close();
    port = p;
    port.onmessage = (e: MessageEvent) => onLevel(e.data as WorkletToWorker);
  }

  async function onMessage(m: ToWorker): Promise<void> {
    switch (m.t) {
      case 'init':
        wasmSource = m.wasm;
        allowWebCodecs = m.allowWebCodecs;
        devCodecs = m.devCodecs;
        if (m.port) attachPort(m.port);
        return;
      case 'port':
        attachPort(m.port);
        return;
      case 'open': {
        gen = m.gen;
        started = false;
        pending = null;
        closeSegment(cur);
        closeSegment(prev);
        closeSegment(nextSeg);
        cur = prev = nextSeg = null;
        nextWanted = -1;
        const g = m.gen;
        try {
          const s = await makeSegment(m.seg, m.src, m.spatial);
          if (g !== gen) {
            closeSegment(s);
            return;
          }
          positionAt(s, Math.round(m.startSec * s.info.sampleRate));
          cur = s;
          genStart = stream;
          post({ t: 'opened', gen: g, seg: m.seg, info: s.info });
          if (s.info.backend === 'wasm' && !s.info.isStub) log('Decoding ' + s.src.name + ' in software (' + s.info.decoderVersion + ')');
          if (started) void pump();
        } catch (e) {
          if (g !== gen) return;
          const code = e instanceof NotSupported ? MEDIA_ERR_SRC_NOT_SUPPORTED : (e as { code?: number }).code || MEDIA_ERR_DECODE;
          post({ t: 'error', gen: g, seg: m.seg, message: (e as Error).message, code });
        }
        return;
      }
      case 'start':
        if (m.gen === gen) {
          started = true;
          void pump();
        }
        return;
      case 'seek': {
        gen = m.gen;
        pending = null;
        genStart = stream;
        /* A seek targets the segment the listener hears. If the worker has
           already spliced ahead of it, step back and re-queue the next. */
        if (prev && prev.seg === m.seg) {
          if (cur) {
            positionAt(cur, 0);
            closeSegment(nextSeg);
            nextSeg = cur;
            nextWanted = cur.seg;
          }
          cur = prev;
          prev = null;
        } else if (prev) {
          closeSegment(prev);
          prev = null;
        }
        if (cur) {
          positionAt(cur, Math.round(m.sec * cur.info.sampleRate));
          post({ t: 'seeked', gen });
          if (started) void pump();
        }
        return;
      }
      case 'next': {
        nextWanted = m.seg;
        closeSegment(nextSeg);
        nextSeg = null;
        try {
          const s = await makeSegment(m.seg, m.src, !!(cur && cur.spatial));
          if (nextWanted !== m.seg) {
            closeSegment(s);
            return;
          }
          const c = cur;
          if (c && (s.info.sampleRate !== c.info.sampleRate || s.outChannels !== c.outChannels)) {
            closeSegment(s);
            post({ t: 'nextRejected', seg: m.seg, reason: 'different sample rate or channel count' });
            return;
          }
          nextSeg = s;
          post({ t: 'nextReady', seg: m.seg, info: s.info });
          /* The current segment already ended as "final": reopen the splice. */
          if (c && c.eosSent && !prev) {
            c.eosSent = false;
            c.submittedAll = true;
            void pump();
          }
        } catch (e) {
          if (nextWanted === m.seg) post({ t: 'nextRejected', seg: m.seg, reason: (e as Error).message });
        }
        return;
      }
      case 'cancelNext': {
        if (nextWanted === m.seg) nextWanted = -1;
        if (nextSeg && nextSeg.seg === m.seg) {
          closeSegment(nextSeg);
          nextSeg = null;
        }
        /* Already spliced but not yet audible: take it back out. */
        if (prev && cur && cur.seg === m.seg) {
          toWorklet({ t: 'drop', gen, seg: cur.seg });
          closeSegment(cur);
          cur = prev;
          prev = null;
          pending = null;
          toWorklet({ t: 'eos', gen, seg: cur.seg, final: true });
          cur.eosSent = true;
        }
        return;
      }
      case 'close':
        gen++;
        started = false;
        closeSegment(cur);
        closeSegment(prev);
        closeSegment(nextSeg);
        cur = prev = nextSeg = null;
        pending = null;
        return;
      case 'analyze':
        try {
          const data = await runAnalysis(m.id, m.src, m.buckets, m.windowSec);
          post({ t: 'analysis', id: m.id, data, error: data ? undefined : 'stub decoder: no real audio to analyse' }, data ? [data.rms.buffer] : []);
        } catch (e) {
          post({ t: 'analysis', id: m.id, data: null, error: (e as Error).message });
        }
        return;
      case 'peaks':
        try {
          await runPeaks(m.id, m.src, m.buckets);
        } catch (e) {
          post({ t: 'peaks', id: m.id, data: null, error: (e as Error).message });
        }
        return;
    }
  }

  scope.onmessage = (e: MessageEvent) => {
    void onMessage(e.data as ToWorker).catch((err: Error) => log('Decode worker error', err && (err.stack || err.message)));
  };
}
