/* Browser verification of the software decode engine through the dev-only
   harness (test/harness/engine.html). Needs a running dev server and
   Playwright with a Chromium:

     npm run dev                                   # serves the harness
     AMC_URL=http://localhost:5173 node --test test/browser/engine.e2e.mjs

   Playwright is not a project dependency: the import below resolves a
   local or global install, or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs.

   Audio checks use two sources:
   - ALAC / E-AC-3 through the WASM decoder (silent while the stub is in
     place: timing, clock, events, channel sizing, memory);
   - FLAC-in-MP4 through WebCodecs (dev-only codec): REAL samples, compared
     sample-for-sample against the known sine for seek accuracy and the
     gapless splice. The worklet's tap sees exactly what it outputs. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alacAtom, buildMp4 } from '../helpers/mp4build.mjs';
import { alacVerbatimPacket, testPcm } from '../helpers/alac.mjs';

const BASE = process.env.AMC_URL || 'http://localhost:5173';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

let browser;
let page;
let tmp;
const pageErrors = [];

before(async () => {
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/test/harness/engine.html');
  await page.waitForFunction(() => window.H);
  tmp = mkdtempSync(join(tmpdir(), 'amc-e2e-'));
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A CDP sender for the (first) dedicated worker of the page. */
async function attachWorker(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const w = targetInfos.filter((t) => t.type === 'worker').pop();
  if (!w) throw new Error('no worker target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: w.targetId, flatten: false });
  let id = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: i, method, params }) });
    });
}

async function loadAndPlay(kind, startSec = 0) {
  return page.evaluate(
    async ([k, s]) => {
      H.newEngine();
      H.events.length = 0;
      const [f, c] = H.makers[k]();
      H.load(f, c, s);
      await H.engine.play();
      return H.engine.debugState();
    },
    [kind, startSec]
  );
}

const ct = () => page.evaluate(() => H.engine.currentTime);
const state = () => page.evaluate(() => H.engine.debugState());
const events = () => page.evaluate(() => H.events.map((e) => e.type));

test('ALAC: opens through the WASM decoder and the clock follows played frames', async () => {
  const s = await loadAndPlay('alac');
  assert.equal(s.info.codec, 'alac');
  assert.equal(s.info.backend, 'wasm');
  await sleep(600);
  const t0 = await ct();
  const w0 = Date.now();
  await sleep(2000);
  const t1 = await ct();
  const rate = (t1 - t0) / ((Date.now() - w0) / 1000);
  assert.ok(rate > 0.9 && rate < 1.1, 'clock rate ' + rate.toFixed(3) + 'x');
  const ev = await events();
  for (const e of ['loadstart', 'play', 'durationchange', 'loadedmetadata', 'canplay', 'playing']) assert.ok(ev.includes(e), 'event ' + e + ' in ' + ev);
  assert.ok(ev.indexOf('play') < ev.indexOf('playing'));
  const st = await state();
  assert.equal(st.nodeChannels, 2);
  assert.ok(st.queuedFrames > 0.5 * 44100 && st.queuedFrames < 4 * 44100, 'buffered ' + (st.queuedFrames / 44100).toFixed(2) + ' s');
});

test('pause holds the position, resume continues from it', async () => {
  await page.evaluate(() => H.engine.pause());
  const p0 = await ct();
  await sleep(1000);
  const p1 = await ct();
  assert.ok(Math.abs(p1 - p0) < 0.001, 'moved while paused: ' + p0 + ' → ' + p1);
  assert.equal(await page.evaluate(() => H.engine.paused), true);
  await page.evaluate(() => H.engine.play());
  await sleep(700);
  const p2 = await ct();
  assert.ok(p2 > p0 && p2 < p0 + 1.0, 'resumed at ' + p2 + ' after pausing at ' + p0);
});

test('seek lands on the target and keeps playing', async () => {
  await page.evaluate(() => {
    H.events.length = 0;
    H.engine.currentTime = 12.5;
  });
  const during = await ct();
  assert.equal(during, 12.5);
  await sleep(800);
  const t = await ct();
  assert.ok(t >= 12.5 && t < 13.5, 'after seek ' + t);
  const ev = await events();
  assert.ok(ev.indexOf('seeking') >= 0 && ev.indexOf('seeked') > ev.indexOf('seeking'), ev.join(','));
});

test('volume and mute change the real output level', async () => {
  await loadAndPlay('flac');
  const r = await page.evaluate(async () => {
    const out = H.engine.debugOutput();
    const an = out.ctx.createAnalyser();
    an.fftSize = 4096;
    out.node.connect(an);
    const buf = new Float32Array(an.fftSize);
    const rms = async () => {
      await new Promise((res) => setTimeout(res, 250));
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    };
    const full = await rms();
    H.engine.volume = 0.25;
    const quarter = await rms();
    H.engine.muted = true;
    const muted = await rms();
    H.engine.muted = false;
    H.engine.volume = 1;
    const back = await rms();
    out.node.disconnect(an);
    return { full, quarter, muted, back };
  });
  assert.ok(r.full > 0.2, 'full-volume RMS ' + r.full);
  assert.ok(Math.abs(r.quarter / r.full - 0.25) < 0.03, 'quarter ratio ' + r.quarter / r.full);
  assert.ok(r.muted < 1e-4, 'muted RMS ' + r.muted);
  assert.ok(Math.abs(r.back / r.full - 1) < 0.03, 'restored ratio ' + r.back / r.full);
});

test('E-AC-3 5.1: a six-channel worklet, downmixed by the destination', async () => {
  const s = await loadAndPlay('eac3');
  assert.equal(s.info.codec, 'ec-3');
  assert.equal(s.info.channels, 6);
  assert.equal(s.info.joc, true);
  assert.equal(s.ctxRate, 48000);
  await sleep(1200);
  const st = await state();
  assert.equal(st.nodeChannels, 6);
  assert.ok(st.destinationChannels === 2 || st.destinationChannels === 6);
  assert.ok((await ct()) > 0.5);
});

test('ALAC 24-bit 96 kHz: the context runs at the file rate', async () => {
  const s = await loadAndPlay('alac96');
  assert.equal(s.info.sampleRate, 96000);
  await sleep(800);
  assert.equal((await state()).ctxRate, 96000);
  assert.ok((await ct()) > 0.3);
});

test('FLAC via WebCodecs: real samples, and seeks land sample-accurately', async () => {
  const s = await loadAndPlay('flac');
  assert.equal(s.info.backend, 'webcodecs');
  const result = await page.evaluate(async () => {
    const amp = 0.5 * 32767;
    const expect = (media, c) => {
      /* Chromium converts int16 asymmetrically: x/32768 below zero, x/32767 above. */
      const v = Math.round(amp * Math.sin((2 * Math.PI * 441 * media) / 44100 + c * 0.5));
      return v < 0 ? v / 32768 : v / 32767;
    };
    H.startTap();
    await new Promise((r) => setTimeout(r, 600));
    H.engine.currentTime = 5.0;
    await new Promise((r) => setTimeout(r, 900));
    H.stopTap();
    let worst = 0;
    let checked = 0;
    let firstAfterSeek = null;
    for (const blk of H.captured) {
      if (blk.media < 5 * 44100) continue;
      if (firstAfterSeek === null) firstAfterSeek = blk.media;
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < blk.planes[c].length; i++) {
          const d = Math.abs(blk.planes[c][i] - expect(blk.media + i, c));
          if (d > worst) worst = d;
          checked++;
        }
      }
    }
    return { worst, checked, firstAfterSeek, blocks: H.captured.length };
  });
  assert.ok(result.checked > 44100, 'checked ' + result.checked + ' samples');
  assert.ok(result.worst < 1e-6, 'worst deviation after the seek ' + result.worst);
  assert.equal(result.firstAfterSeek, 5 * 44100, 'first frame after the seek');
});

test('FLAC: no deviation at all away from the fade-in quantum', async () => {
  const r = await page.evaluate(async () => {
    const amp = 0.5 * 32767;
    const expect = (media, c) => {
      /* Chromium converts int16 asymmetrically: x/32768 below zero, x/32767 above. */
      const v = Math.round(amp * Math.sin((2 * Math.PI * 441 * media) / 44100 + c * 0.5));
      return v < 0 ? v / 32768 : v / 32767;
    };
    H.startTap();
    await new Promise((res) => setTimeout(res, 1000));
    H.stopTap();
    let worst = 0;
    for (const blk of H.captured) for (let c = 0; c < 2; c++) for (let i = 0; i < blk.planes[c].length; i++) worst = Math.max(worst, Math.abs(blk.planes[c][i] - expect(blk.media + i, c)));
    return worst;
  });
  assert.ok(r < 1e-6, 'worst deviation ' + r);
});

test('gapless: two files cut from one continuous sine splice with zero discontinuity', async () => {
  const r = await page.evaluate(async () => {
    const e = H.newEngine();
    H.events.length = 0;
    const rate = 44100;
    const a = H.flacFile('part1.m4a', { seconds: 3, offset: 0 });
    const b = H.flacFile('part2.m4a', { seconds: 3, offset: 3 * rate });
    H.load(a, 'fLaC', 1.5);
    e.setNext({ file: b, codec: 'fLaC', name: 'part2.m4a' });
    H.startTap();
    await e.play();
    await new Promise((res) => setTimeout(res, 2600));
    H.stopTap();
    const amp = 0.5 * 32767;
    /* Stream frames are continuous across the splice; map them to the
       continuous sine through the first block's media position. */
    const first = H.captured.find((x) => x.planes[0].length);
    const base = first.media - first.stream;
    let worst = 0;
    let crossed = false;
    let prevStream = -1;
    /* The first rendered quantum carries the play() fade-in: skip it. */
    for (const blk of H.captured.slice(1)) {
      if (prevStream >= 0 && blk.stream !== prevStream) return { error: 'stream gap at ' + blk.stream + ' vs ' + prevStream };
      prevStream = blk.stream + blk.planes[0].length;
      for (let i = 0; i < blk.planes[0].length; i++) {
        const g = blk.stream + base + i;
        if (g >= 3 * rate) crossed = true;
        for (let c = 0; c < 2; c++) {
          const v = Math.round(amp * Math.sin((2 * Math.PI * 441 * g) / rate + c * 0.5));
          const want = v < 0 ? v / 32768 : v / 32767;
          worst = Math.max(worst, Math.abs(blk.planes[c][i] - want));
        }
      }
    }
    return { worst, crossed, events: H.events.map((x) => x.type), ct: e.currentTime, name: e.source && e.source.name };
  });
  assert.ok(!r.error, r.error);
  assert.ok(r.crossed, 'playback crossed the boundary');
  assert.ok(r.events.includes('segment'), 'segment event: ' + r.events);
  assert.ok(!r.events.includes('waiting'), 'no underrun at the splice: ' + r.events);
  assert.ok(!r.events.includes('ended'), 'no ended between the parts');
  assert.equal(r.name, 'part2.m4a');
  assert.ok(r.worst < 1e-6, 'worst deviation across the splice ' + r.worst);
});

test('gapless ALAC through the WASM path: the segment switch is on time', async () => {
  const r = await page.evaluate(async () => {
    const e = H.newEngine();
    H.events.length = 0;
    const a = H.alacFile('a.m4a', { seconds: 2.5 });
    const b = H.alacFile('b.m4a', { seconds: 4 });
    H.load(a, 'alac', 1.0);
    e.setNext({ file: b, codec: 'alac', name: 'b.m4a' });
    await e.play();
    const t0 = performance.now();
    await new Promise((res) => {
      e.addEventListener('segment', res, { once: true });
      setTimeout(res, 5000);
    });
    const at = (performance.now() - t0) / 1000;
    await new Promise((res) => setTimeout(res, 500));
    return { at, ct: e.currentTime, dur: e.duration, events: H.events.map((x) => x.type) };
  });
  assert.ok(r.events.includes('segment'), r.events.join(','));
  assert.ok(!r.events.includes('waiting'), 'no underrun: ' + r.events);
  assert.ok(r.at > 1.2 && r.at < 1.9, 'switched after ' + r.at.toFixed(2) + ' s (1.5 s of part one left)');
  assert.equal(r.dur, 4);
  assert.ok(r.ct > 0.2 && r.ct < 1.2, 'clock restarted in part two: ' + r.ct);
});

test('gapless ALAC fixture pair: sample-exact splice (real decoder only)', async () => {
  const r = await page.evaluate(async () => {
    const e = H.newEngine({ allowWebCodecs: false });
    H.events.length = 0;
    const rate = 44100;
    const a = H.alacSineFile('gapless-1.m4a', { seconds: 3, offset: 0 });
    const b = H.alacSineFile('gapless-2.m4a', { seconds: 3, offset: 3 * rate });
    H.load(a, 'alac', 1.5);
    e.setNext({ file: b, codec: 'alac', name: 'gapless-2.m4a' });
    H.startTap();
    await e.play();
    await new Promise((res) => setTimeout(res, 2600));
    H.stopTap();
    const stub = e.trackInfo.isStub;
    const amp = 0.5 * 32767;
    const first = H.captured.find((x) => x.planes[0].length);
    const base = first.media - first.stream;
    let worst = 0;
    let crossed = false;
    for (const blk of H.captured.slice(1)) {
      for (let i = 0; i < blk.planes[0].length; i++) {
        const g = blk.stream + base + i;
        if (g >= 3 * rate) crossed = true;
        for (let c = 0; c < 2; c++) {
          const want = Math.round(amp * Math.sin((2 * Math.PI * 441 * g) / rate + c * 0.5)) / 32768;
          worst = Math.max(worst, Math.abs(blk.planes[c][i] - want));
        }
      }
    }
    return { stub, worst, crossed, events: H.events.map((x) => x.type) };
  });
  assert.ok(r.crossed, 'crossed the boundary');
  assert.ok(r.events.includes('segment') && !r.events.includes('waiting') && !r.events.includes('ended'), r.events.join(','));
  if (r.stub) {
    console.log('# ALAC decoder is the silent stub: splice timing verified, sample values not checked');
    return;
  }
  assert.ok(r.worst < 1e-6, 'worst deviation across the ALAC splice ' + r.worst);
});

test('ALAC waveform peaks through the WASM decoder (real decoder only)', async () => {
  const r = await page.evaluate(async () => {
    const f = H.alacSineFile('peaks-alac.m4a', { seconds: 8 });
    const data = await H.generateEnginePeaks({ file: f, codec: 'alac', name: f.name }, 1500, undefined, { allowWebCodecs: false });
    if (!data) return null;
    let mn = 1;
    let mx = -1;
    for (let i = 0; i < data.pairs.length; i += 2) {
      mn = Math.min(mn, data.pairs[i]);
      mx = Math.max(mx, data.pairs[i + 1]);
    }
    return { mn, mx, len: data.pairs.length };
  });
  if (r === null) {
    console.log('# ALAC decoder is the silent stub: no peaks to measure (and none cached)');
    return;
  }
  assert.equal(r.len, 3000);
  assert.ok(r.mx > 0.45 && r.mn < -0.45, r.mn + ' .. ' + r.mx);
});

test('memory stays flat across a long file (disk-backed, with seeks)', async () => {
  /* 8 minutes of 16-bit stereo ALAC (~85 MB) written to disk, picked
     through the file input, so the File is disk-backed like a real one. */
  const frameLength = 4096;
  const pcm = testPcm(frameLength, 2, 16, 3);
  const packet = alacVerbatimPacket(pcm, 16, frameLength);
  const count = Math.ceil((8 * 60 * 44100) / frameLength);
  const { bytes } = buildMp4(
    [{ handler: 'soun', codec: 'alac', timescale: 44100, sampleRate: 44100, channels: 2, sampleSize: 16, config: alacAtom({}), samples: new Array(count).fill(packet), durations: new Array(count).fill(frameLength), samplesPerChunk: 20 }],
    { moovAtEnd: true }
  );
  const path = join(tmp, 'long-alac.m4a');
  writeFileSync(path, bytes);
  await page.evaluate(() => H.newEngine());
  await page.setInputFiles('#pick', path);
  await page.waitForFunction(() => H.engine.duration > 400, null, { timeout: 15000 });
  await page.evaluate(() => H.engine.play());
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize;
  /* The decode Worker's heap too — JS objects plus ArrayBuffer backing
     store, where decoded PCM would pile up if chunks leaked. */
  const workerSend = await attachWorker(cdp);
  const workerHeap = async () => {
    await workerSend('HeapProfiler.collectGarbage');
    const r = (await workerSend('Runtime.getHeapUsage')).result;
    return r.usedSize + (r.backingStorageSize || 0);
  };
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.evaluate((k) => {
      H.engine.currentTime = (k * 47) % 470;
    }, i);
    await sleep(1500);
    await cdp.send('HeapProfiler.collectGarbage');
    const st = await state();
    samples.push({ heap: await heap(), worker: await workerHeap(), queued: st.queuedFrames });
  }
  const first = samples[1].heap;
  const last = samples[samples.length - 1].heap;
  const wFirst = samples[1].worker;
  const wMax = Math.max(...samples.slice(1).map((s) => s.worker));
  const maxQueued = Math.max(...samples.map((s) => s.queued));
  console.log('main heap MB:', samples.map((s) => (s.heap / 1048576).toFixed(1)).join(' '));
  console.log('worker heap+buffers MB:', samples.map((s) => (s.worker / 1048576).toFixed(1)).join(' '), '· max buffered', (maxQueued / 44100).toFixed(2), 's');
  assert.ok(last - first < 8 * 1048576, 'main heap grew ' + ((last - first) / 1048576).toFixed(1) + ' MB');
  assert.ok(wMax - wFirst < 8 * 1048576, 'worker memory grew ' + ((wMax - wFirst) / 1048576).toFixed(1) + ' MB');
  assert.ok(maxQueued < 4.5 * 44100, 'worklet held ' + (maxQueued / 44100).toFixed(2) + ' s');
});

test('waveform peaks: sparse decode in a worker, existing pairs format (real audio via WebCodecs)', async () => {
  const r = await page.evaluate(async () => {
    const f = H.flacFile('peaks.m4a', { seconds: 10 });
    const progress = [];
    const data = await H.generateEnginePeaks({ file: f, codec: 'fLaC', name: f.name }, 1500, (x) => progress.push(x), { devCodecs: true });
    const stub = await H.generateEnginePeaks({ file: H.alacFile('stub.m4a', { seconds: 3 }), codec: 'alac', name: 'stub' }, 1500);
    let mn = 1;
    let mx = -1;
    for (let i = 0; i < data.pairs.length; i += 2) {
      mn = Math.min(mn, data.pairs[i]);
      mx = Math.max(mx, data.pairs[i + 1]);
    }
    return { len: data.pairs.length, duration: data.duration, mn, mx, progress: progress.length, stub };
  });
  assert.equal(r.len, 3000);
  assert.ok(Math.abs(r.duration - 10) < 1e-6);
  assert.ok(r.mx > 0.45 && r.mx < 0.51 && r.mn < -0.45 && r.mn > -0.51, 'envelope ' + r.mn + ' .. ' + r.mx);
  assert.ok(r.progress > 5, 'progress reports');
  assert.equal(r.stub, null, 'the silent stub yields no peaks (nothing cached)');
});

test('track-break analysis streams the whole file and finds the gap', async () => {
  const r = await page.evaluate(async () => {
    const f = H.breakFile();
    const a = await H.analyzeWithEngine({ file: f, codec: 'fLaC', name: f.name }, 0.05, undefined, { devCodecs: true });
    const { silences, proposals } = H.silencesFromRms(a.rms, a.peakRms, a.win, a.sampleRate, a.duration);
    return { duration: a.duration, windows: a.rms.length, silences, proposals, pairs: a.pairs.length };
  });
  assert.equal(r.pairs, 3000);
  assert.ok(Math.abs(r.duration - 10) < 1e-6);
  assert.equal(r.silences.length, 1, JSON.stringify(r.silences));
  assert.ok(Math.abs(r.silences[0].start - 4) < 0.06 && Math.abs(r.silences[0].end - 6) < 0.06, JSON.stringify(r.silences));
  assert.equal(r.proposals.length, 1);
  assert.ok(Math.abs(r.proposals[0] - 5.85) < 0.06, 'proposal ' + r.proposals[0]);
});

test('spatial hook: a test processor sizes the worklet, feeds the renderer, resets on seek and track change', async () => {
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const e = H.newSpatialEngine();
    const log = H.spatialLog;
    H.load(H.eac3File('atmos.m4a', 20), 'ec-3');
    H.startTap();
    await e.play();
    await sleep(1500);
    H.stopTap();
    const st1 = e.debugState();
    let objMin = 1;
    let objMax = -1;
    for (const blk of H.captured.slice(2)) {
      const o = blk.planes[6];
      if (!o) continue;
      for (const v of o) {
        objMin = Math.min(objMin, v);
        objMax = Math.max(objMax, v);
      }
    }
    const tapChannels = H.captured.length ? H.captured[H.captured.length - 1].planes.length : 0;
    const kf1 = log.keyframes.slice();
    const played1 = log.played.slice();
    const rendererResets1 = log.resets;
    e.currentTime = 10;
    await sleep(1200);
    const kfSeek = log.keyframes.slice(kf1.length);
    const rendererResets2 = log.resets;
    H.load(H.eac3File('atmos-2.m4a', 10), 'ec-3');
    await e.play();
    await sleep(1200);
    const kfTrack = log.keyframes.slice(kf1.length + kfSeek.length);
    const rendererResets3 = log.resets;
    H.load(H.eac3File('plain.m4a', 10, false), 'ec-3');
    await e.play();
    await sleep(1000);
    const plain = e.debugState();
    const out = {
      st1: { spatial: st1.spatial, nodeChannels: st1.nodeChannels, info: st1.info.spatial, channels: st1.info.channels },
      created: log.created,
      modes: log.modes,
      objMin,
      objMax,
      tapChannels,
      kf1: kf1.slice(0, 40),
      played1: [played1[0], played1[played1.length - 1]],
      kfSeekX: kfSeek.map((k) => k.x),
      kfTrackX: kfTrack.map((k) => k.x),
      resets: [rendererResets1, rendererResets2, rendererResets3],
      plain: { spatial: plain.spatial, nodeChannels: plain.nodeChannels, info: plain.info.spatial },
      disposed: log.disposed,
    };
    H.clearSpatial();
    H.newEngine();
    return out;
  });
  assert.deepEqual(r.st1.info, { maxChannels: 7, bedChannels: 6, objectChannels: 1 });
  assert.equal(r.st1.channels, 7);
  assert.equal(r.st1.nodeChannels, 7, 'worklet sized to maxChannels');
  assert.equal(r.st1.spatial, true, 'renderer inserted');
  assert.deepEqual(r.created[0], { bed: 6, objects: 1 });
  assert.ok(r.modes.includes('headphones'), 'setMode applied: ' + r.modes);
  assert.equal(r.tapChannels, 7);
  assert.ok(Math.abs(r.objMin - 0.25) < 1e-6 && Math.abs(r.objMax - 0.25) < 1e-6, 'object channel played from SpatialBlock.pcm: ' + r.objMin + '..' + r.objMax);
  /* Keyframes arrive one per packet, stamped on the stream timeline the
     renderer's played frames use. */
  for (let i = 1; i < r.kf1.length; i++) assert.equal(r.kf1[i].blockStartFrame - r.kf1[i - 1].blockStartFrame, 1536, 'consecutive blocks');
  assert.ok(r.kf1[0].blockStartFrame <= r.played1[1] && r.kf1[0].blockStartFrame >= r.played1[0] - 1536, 'same timeline: ' + r.kf1[0].blockStartFrame + ' vs played ' + r.played1);
  const x1 = Math.max(...r.kf1.map((k) => k.x));
  assert.ok(Math.min(...r.kfSeekX) > x1, 'processor.reset() on seek: ' + x1 + ' → ' + r.kfSeekX.slice(0, 3));
  assert.ok(r.resets[1] > r.resets[0], 'renderer.reset() on seek');
  assert.ok(r.kfTrackX.length > 0 && Math.max(...r.kfTrackX) <= 2, 'a fresh processor for the next track: ' + r.kfTrackX.slice(0, 3));
  assert.ok(r.resets[2] > r.resets[1], 'renderer.reset() on track change');
  assert.equal(r.plain.info, null, 'non-JOC stream: no processor');
  assert.equal(r.plain.spatial, false, 'renderer removed');
  assert.equal(r.plain.nodeChannels, 6, 'plain 5.1 core');
  assert.ok(r.disposed >= 1);
});

test('no page errors', () => {
  assert.deepEqual(pageErrors, []);
});
