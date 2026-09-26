/* Test-only MP4 sample-table reader: finds the first `ec-3` track, its
   `dec3` payload, and the byte range of every sample (access unit). Reads
   the file in small positioned chunks through fs.readSync, never whole.
   AMC-original test code. */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface Ec3Track {
  timescale: number;
  sampleRate: number;
  channelCount: number;
  dec3: Uint8Array;
  offsets: number[];
  sizes: number[];
}

interface Box {
  type: string;
  start: number; // offset of the box header
  body: number; // offset of the payload
  end: number;
}

export class Mp4File {
  private fd: number;
  readonly size: number;

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }

  close(): void {
    closeSync(this.fd);
  }

  read(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n <= 0) throw new Error(`short read at ${offset + done}`);
      done += n;
    }
    return buf;
  }

  private children(start: number, end: number): Box[] {
    const boxes: Box[] = [];
    let pos = start;
    while (pos + 8 <= end) {
      const h = this.read(pos, 16 <= end - pos ? 16 : 8);
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
      let body = pos + 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(8));
        body = pos + 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < 8 || pos + size > end) break;
      boxes.push({ type, start: pos, body, end: pos + size });
      pos += size;
    }
    return boxes;
  }

  private child(parent: Box, type: string): Box | undefined {
    return this.children(parent.body, parent.end).find((b) => b.type === type);
  }

  /** The first track whose sample description is `ec-3`. */
  ec3Track(): Ec3Track {
    const moov = this.children(0, this.size).find((b) => b.type === 'moov');
    if (!moov) throw new Error('no moov');
    for (const trak of this.children(moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const mdia = this.child(trak, 'mdia');
      const minf = mdia && this.child(mdia, 'minf');
      const stbl = minf && this.child(minf, 'stbl');
      const stsd = stbl && this.child(stbl, 'stsd');
      if (!mdia || !stbl || !stsd) continue;
      // stsd: version/flags (4) + entry count (4), then sample entries.
      const entry = this.children(stsd.body + 8, stsd.end)[0];
      if (!entry || entry.type !== 'ec-3') continue;

      // AudioSampleEntry: 6 reserved + 2 dref index + 2 version + 6 reserved
      // + 2 channels + 2 sample size + 4 reserved + 4 rate (16.16) = 28.
      const head = this.read(entry.body, 28);
      const hv = new DataView(head.buffer);
      const version = hv.getUint16(8);
      const channelCount = hv.getUint16(16);
      const sampleRate = hv.getUint32(24) >>> 16;
      const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
      const dec3Box = this.children(entry.body + 28 + extra, entry.end).find((b) => b.type === 'dec3');
      if (!dec3Box) throw new Error('ec-3 entry without dec3');
      const dec3 = this.read(dec3Box.body, dec3Box.end - dec3Box.body);

      const mdhd = this.child(mdia, 'mdhd')!;
      const mh = this.read(mdhd.body, 32);
      const mv = new DataView(mh.buffer);
      const timescale = mh[0] === 1 ? mv.getUint32(20) : mv.getUint32(12);

      const sizes = this.readStsz(this.child(stbl, 'stsz')!);
      const chunkOffsets = this.readChunkOffsets(stbl);
      const stsc = this.readStsc(this.child(stbl, 'stsc')!);
      const offsets: number[] = [];
      let sample = 0;
      for (let i = 0; i < stsc.length; i++) {
        const firstChunk = stsc[i].firstChunk;
        const lastChunk = i + 1 < stsc.length ? stsc[i + 1].firstChunk - 1 : chunkOffsets.length;
        for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
          let off = chunkOffsets[chunk - 1];
          for (let s = 0; s < stsc[i].samplesPerChunk && sample < sizes.length; s++) {
            offsets.push(off);
            off += sizes[sample++];
          }
        }
      }
      return { timescale, sampleRate, channelCount, dec3, offsets, sizes };
    }
    throw new Error('no ec-3 track');
  }

  sample(track: Ec3Track, index: number): Uint8Array {
    return this.read(track.offsets[index], track.sizes[index]);
  }

  private readStsz(box: Box): number[] {
    const h = new DataView(this.read(box.body, 12).buffer);
    const uniform = h.getUint32(4);
    const count = h.getUint32(8);
    if (uniform !== 0) return new Array<number>(count).fill(uniform);
    const t = new DataView(this.read(box.body + 12, count * 4).buffer);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) sizes.push(t.getUint32(i * 4));
    return sizes;
  }

  private readChunkOffsets(stbl: Box): number[] {
    const stco = this.child(stbl, 'stco');
    const co64 = this.child(stbl, 'co64');
    const box = stco || co64;
    if (!box) throw new Error('no stco/co64');
    const count = new DataView(this.read(box.body + 4, 4).buffer).getUint32(0);
    const width = stco ? 4 : 8;
    const t = new DataView(this.read(box.body + 8, count * width).buffer);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(stco ? t.getUint32(i * 4) : Number(t.getBigUint64(i * 8)));
    return out;
  }

  private readStsc(box: Box): { firstChunk: number; samplesPerChunk: number }[] {
    const count = new DataView(this.read(box.body + 4, 4).buffer).getUint32(0);
    const t = new DataView(this.read(box.body + 8, count * 12).buffer);
    const out: { firstChunk: number; samplesPerChunk: number }[] = [];
    for (let i = 0; i < count; i++) out.push({ firstChunk: t.getUint32(i * 12), samplesPerChunk: t.getUint32(i * 12 + 4) });
    return out;
  }
}
