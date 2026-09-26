/* Gate 2: E-AC-3 / EMDF / JOC / OAMD parsing.
   - Unit checks of the bit reader, EMDF variable-length fields and dec3.
   - On the real file: dec3 JOC flag, every access unit parsed by walking
     the audio blocks (no fallback scan), stable object counts, in-range
     fields, smooth positions.
   - Against Cavern's own decode (scripts/atmos-cavern-ref.sh), when present:
     every JOC field and quantised matrix value equal, and every OAMD
     info-block target position/gain/size equal bit for bit (float32).
   AMC-original test code. */

import { BitExtractor } from '../../src/audio/atmos/bitstream/bit-extractor';
import { AccessUnitParser } from '../../src/audio/atmos/bitstream/access-unit';
import { parseDec3 } from '../../src/audio/atmos/bitstream/dec3';
import { defaultObjectGain, type ObjectTarget } from '../../src/audio/atmos/bitstream/oamd';
import { Mp4File } from './mp4';
import { assert, cavernRef, haveCavernRef, haveRealFile, log, realFile, run, skip, test } from './util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('BitExtractor reads MSB-first across byte boundaries', () => {
  const b = new BitExtractor(new Uint8Array([0b10110011, 0b01011100, 0xff]));
  assert(b.read(3) === 0b101, 'first 3 bits');
  assert(b.read(7) === 0b1001101, 'next 7 across the boundary');
  assert(b.readBit() === false, 'single bit');
  assert(b.read(13) === 0b1110011111111, '13 bits to the end');
  let threw = false;
  try {
    b.read(1);
  } catch {
    threw = true;
  }
  assert(threw, 'reading past the end throws');
});

test('ReadSigned: Cavern literal vs two\'s complement', () => {
  for (let v = 0; v < 8; v++) {
    const a = new BitExtractor(new Uint8Array([v << 5]));
    assert(a.readSignedCavern(3) === 0, `Cavern's ReadSigned always yields 0 (v=${v})`);
    const b = new BitExtractor(new Uint8Array([v << 5]));
    assert(b.readSignedTwos(3) === (v >= 4 ? v - 8 : v), `two's complement of ${v}`);
  }
});

test('EMDF variable_bits', () => {
  // variable_bits(2): 10 1 01 0 -> ((2 + 1) << 2) + 1 = 13
  const b = new BitExtractor(new Uint8Array([0b10101000]));
  assert(b.variableBits(2) === 13, 'two-group value');
  assert(b.position === 6, 'consumed 6 bits');
});

test('dec3: plain E-AC-3 has no JOC flag; extension bytes set it', () => {
  // data_rate 768, 1 independent substream: fscod 0, bsid 16, acmod 7, lfe 1, no deps
  const base = [0x18, 0x00, 0x20, 0x0f, 0x00];
  const plain = parseDec3(new Uint8Array(base));
  assert(plain !== null && !plain.jocExtension && plain.complexityIndex === 0, 'no extension');
  assert(plain!.dataRate === 768, 'data rate');
  assert(plain!.independentSubstreams[0].acmod === 7 && plain!.independentSubstreams[0].lfeon, 'acmod/lfe');
  const joc = parseDec3(new Uint8Array([...base, 0x01, 0x10]));
  assert(joc !== null && joc.jocExtension && joc.complexityIndex === 16, 'JOC flag and complexity 16');
  assert(parseDec3(new Uint8Array([0x30])) === null, 'too short');
});

interface RefObject { a: number; bi?: number; sp?: number; q?: number; st?: number; dp?: number; off?: number[]; m?: number[][][] }
interface RefBlock { v: number; bed: number; x: number; y: number; z: number; g: number; s: number }
interface RefFrame {
  k: number;
  hasObjects: boolean;
  joc?: { ch: number; obj: number; gain: number; objects: RefObject[] };
  oamd?: { n: number; beds: number; lfe: number; offset: number; static: number[]; el: { min: number; bof: number[]; ramp?: number[]; blk?: RefBlock[][] }[] };
}

test('real file: dec3, full-frame walk, fields in range, Cavern equality', () => {
  if (!haveRealFile) skip(`no real file at ${realFile}`);
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const dec3 = parseDec3(track.dec3);
  assert(dec3, 'dec3 parses');
  log(`dec3: ${Array.from(track.dec3, (b) => b.toString(16).padStart(2, '0')).join(' ')} -> JOC ${dec3.jocExtension}, complexity ${dec3.complexityIndex}, ${dec3.dataRate} kb/s`);
  assert(dec3.jocExtension, 'flag_ec3_extension_type_a set on a JOC stream');
  assert(dec3.complexityIndex >= 1, 'complexity index present');

  const refFrames: RefFrame[] = haveCavernRef
    ? readFileSync(resolve(cavernRef, 'frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

  const parser = new AccessUnitParser(true);
  const targets: ObjectTarget[] = [];
  let jocCompared = 0;
  let matrixValues = 0;
  let blocksCompared = 0;
  let prev: ObjectTarget[] | null = null;
  let maxStep = 0;
  const steps: number[] = [];
  const objectCounts = new Set<number>();
  const oamdCounts = new Set<number>();
  const t0 = performance.now();

  for (let k = 0; k < track.sizes.length; k++) {
    const au = mp4.sample(track, k);
    const r = parser.parse(au);
    assert(r.hasObjects, `AU ${k}: JOC payload found`);
    assert(r.hasOAMD, `AU ${k}: OAMD payload found`);
    assert(r.samples === 1536 && r.sampleRate === 48000, `AU ${k}: 1536 samples at 48 kHz`);
    const joc = parser.extensions.joc;
    const oamd = parser.extensions.oamd;
    objectCounts.add(joc.objectCount);
    oamdCounts.add(oamd.objectCount);

    // Range checks on every frame.
    assert(joc.channelCount === 5 || joc.channelCount === 7, 'JOC channel count');
    assert(joc.gain >= 1 && joc.gain < 2, 'JOC gain range');
    for (let o = 0; o < joc.objectCount; o++) {
      if (!joc.objectActive[o]) continue;
      assert(joc.bandsIndex[o] >= 0 && joc.bandsIndex[o] <= 7, 'bands index');
      assert(joc.dataPoints[o] === 1 || joc.dataPoints[o] === 2, 'data points');
      if (!joc.sparseCoded[o]) {
        const max = joc.quantizationTable[o] === 1 ? 192 : 96;
        for (let dp = 0; dp < joc.dataPoints[o]; dp++)
          for (let ch = 0; ch < joc.channelCount; ch++)
            for (let b = 0; b < joc.bands[o]; b++) {
              const v = joc.jocMatrix[o][dp][ch][b];
              assert(v >= 0 && v < max, `matrix value ${v} in [0, ${max})`);
            }
      }
    }

    // Resolve OAMD info blocks in Cavern's order (element, block, object).
    while (targets.length < oamd.objectCount) targets.push({ x: 0, y: 0, z: 0, gain: defaultObjectGain, size: 0 });
    const resolvedBlocks: ObjectTarget[][][] = [];
    for (const el of oamd.elements) {
      const perBlock: ObjectTarget[][] = [];
      if (el.minOffset >= 0) {
        for (let b = 0; b < el.rampDuration.length; b++) {
          const row: ObjectTarget[] = [];
          for (let o = 0; o < el.infoBlocks.length; o++) {
            el.infoBlocks[o][b].resolve(targets[o]);
            row.push({ ...targets[o] });
            const t = targets[o];
            assert(t.x >= -1 && t.x <= 1 && t.y >= -1 && t.y <= 1 && t.z >= -1 && t.z <= 1, 'position in [-1, 1]');
            assert(t.gain >= 0 && t.gain <= 1, 'gain in [0, 1]');
            assert(t.size >= 0 && t.size <= 1.8, 'size in range');
          }
          perBlock.push(row);
        }
      }
      resolvedBlocks.push(perBlock);
    }

    // Smoothness: dynamic objects' per-frame target step.
    const lastRow = resolvedBlocks.find((p) => p.length)?.slice(-1)[0];
    if (lastRow && prev) {
      for (let o = oamd.beds; o < lastRow.length; o++) {
        const step = Math.hypot(lastRow[o].x - prev[o].x, lastRow[o].y - prev[o].y, lastRow[o].z - prev[o].z);
        maxStep = Math.max(maxStep, step);
        steps.push(step);
      }
    }
    if (lastRow) prev = lastRow;

    // Cavern equality.
    const ref = refFrames[k];
    if (ref) {
      assert(ref.k === k, 'reference frame index');
      assert(ref.hasObjects === r.hasObjects, `AU ${k}: hasObjects`);
      const rj = ref.joc!;
      assert(rj.ch === joc.channelCount && rj.obj === joc.objectCount, `AU ${k}: JOC channel/object count`);
      assert(Math.fround(rj.gain) === joc.gain, `AU ${k}: JOC gain`);
      for (let o = 0; o < rj.obj; o++) {
        const ro = rj.objects[o];
        assert(ro.a === (joc.objectActive[o] ? 1 : 0), `AU ${k} obj ${o}: active`);
        if (!ro.a) continue;
        assert(ro.bi === joc.bandsIndex[o] && ro.sp === (joc.sparseCoded[o] ? 1 : 0) && ro.q === joc.quantizationTable[o] &&
          ro.st === (joc.steepSlope[o] ? 1 : 0) && ro.dp === joc.dataPoints[o], `AU ${k} obj ${o}: info fields`);
        if (ro.off) for (let d = 0; d < ro.off.length; d++) assert(ro.off[d] === joc.timeslotOffsets[o][d], 'timeslot offsets');
        if (ro.m) {
          for (let dp = 0; dp < ro.m.length; dp++)
            for (let ch = 0; ch < ro.m[dp].length; ch++)
              for (let b = 0; b < ro.m[dp][ch].length; b++) {
                assert(ro.m[dp][ch][b] === joc.jocMatrix[o][dp][ch][b], `AU ${k} obj ${o} dp ${dp} ch ${ch} band ${b}: matrix`);
                matrixValues++;
              }
        }
      }
      jocCompared++;

      const ro = ref.oamd!;
      assert(ro.n === oamd.objectCount && ro.beds === oamd.beds && ro.lfe === oamd.getLFEPosition() && ro.offset === oamd.offset,
        `AU ${k}: OAMD header`);
      assert(JSON.stringify(ro.static) === JSON.stringify(oamd.getStaticChannels()), `AU ${k}: static channels`);
      assert(ro.el.length === oamd.elements.length, `AU ${k}: element count`);
      for (let e = 0; e < ro.el.length; e++) {
        const re = ro.el[e];
        const me = oamd.elements[e];
        assert(re.min === me.minOffset && JSON.stringify(re.bof) === JSON.stringify(me.blockOffsetFactor), `AU ${k} el ${e}: offsets`);
        if (!re.blk) continue;
        assert(JSON.stringify(re.ramp) === JSON.stringify(me.rampDuration), `AU ${k} el ${e}: ramps`);
        for (let b = 0; b < re.blk.length; b++)
          for (let o = 0; o < re.blk[b].length; o++) {
            const want = re.blk[b][o];
            const got = resolvedBlocks[e][b][o];
            const f = Math.fround;
            assert(want.v === (me.infoBlocks[o][b].validPosition ? 1 : 0) && want.bed === (me.infoBlocks[o][b].isBed ? 1 : 0),
              `AU ${k} el ${e} blk ${b} obj ${o}: flags`);
            assert(f(want.x) === got.x && f(want.y) === got.y && f(want.z) === got.z,
              `AU ${k} el ${e} blk ${b} obj ${o}: position ${[want.x, want.y, want.z]} vs ${[got.x, got.y, got.z]}`);
            assert(f(want.g) === got.gain && f(want.s) === got.size, `AU ${k} el ${e} blk ${b} obj ${o}: gain/size ${[want.g, want.s]} vs ${[got.gain, got.size]}`);
            blocksCompared++;
          }
      }
    }
  }
  const ms = performance.now() - t0;
  mp4.close();

  const s = parser.stats;
  log(`${track.sizes.length} access units (${(track.sizes.length * 1536 / 48000).toFixed(1)} s) parsed in ${ms.toFixed(0)} ms`);
  log(`syncframes ${s.syncframes}, walked ${s.parsed}, bit-scan fallbacks ${s.scanned}, without objects ${s.withoutObjects}${s.firstError ? ', first error: ' + s.firstError : ''}`);
  steps.sort((a, b) => a - b);
  const pct = (p: number) => steps[Math.min(steps.length - 1, Math.floor(steps.length * p))];
  log(`JOC objects per frame: ${[...objectCounts].join(',')}; OAMD objects: ${[...oamdCounts].join(',')}`);
  log(`per-frame target step of dynamic objects: p50 ${pct(0.5).toFixed(3)}, p99 ${pct(0.99).toFixed(3)}, max ${maxStep.toFixed(3)} ` +
    '(JOC objects are encoder clusters; occasional reassignments jump, each spread over its OAMD ramp)');
  assert(pct(0.5) < 0.02 && pct(0.99) < 0.5, 'positions move smoothly apart from rare cluster reassignments');
  assert(s.parsed === s.syncframes && s.scanned === 0, 'every syncframe walked without the fallback scan');
  assert(objectCounts.size === 1 && oamdCounts.size === 1, 'object counts stable');
  if (haveCavernRef) {
    log(`Cavern equality: ${jocCompared} frames, ${matrixValues} JOC matrix values, ${blocksCompared} OAMD object targets, all identical`);
    assert(jocCompared > 0, 'compared some frames');
  } else {
    log('Cavern reference not present: bit-exact comparison skipped (run scripts/atmos-cavern-ref.sh)');
  }
});

test('corrupt frames never throw out of parse()', () => {
  if (!haveRealFile) skip('no real file');
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const parser = new AccessUnitParser();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 200; k++) {
    const au = mp4.sample(track, k).slice();
    for (let i = 0; i < 8; i++) au[Math.floor(rnd() * au.length)] ^= 1 << Math.floor(rnd() * 8);
    parser.parse(au); // must not throw
    parser.parse(au.subarray(0, Math.floor(rnd() * au.length))); // truncated
  }
  mp4.close();
});

run();
