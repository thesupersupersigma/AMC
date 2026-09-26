/* Release verification for v2.3.0: the three merged features working
   together in the real app (dev server, headless Chromium). One scenario
   per test, numbered like the release checklist:

     8.1  a FLAC plays natively, unchanged
     8.2  ALAC plays through the engine; seek and gapless
     8.3  non-JOC E-AC-3 plays as a 5.1 core with no renderer
     8.4  the real Atmos file: objects in all three output modes; seek
     8.5  turntable on a native and an engine track (spin, tonearm, swap,
          RPM 16–78 moves the pitch on both paths), Atmos keyframes in sync
          at 45 RPM, covers sharp at High and the quality level applies
     8.6  memory stays flat over a full play of the Atmos track

     npm run dev
     AMC_URL=http://localhost:5173 node --test test/browser/release.e2e.mjs

   Needs ffmpeg (AMC_FFMPEG or on PATH) to build its small library, and the
   owner's Atmos track at test/private/get-on-the-floor.m4a (AMC_ATMOS_FILE)
   for 8.4, the Atmos part of 8.5 and 8.6; those skip without it. Uses the
   dev-only window.__amcDebug handle. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, makeReleaseLibrary } from '../helpers/release-library.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.AMC_URL || 'http://localhost:5173';
const ATMOS = process.env.AMC_ATMOS_FILE || join(ROOT, 'test/private/get-on-the-floor.m4a');
const HAVE_ATMOS = existsSync(ATMOS);
const FFMPEG = findFfmpeg();
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));
const FULL_PLAY = process.env.AMC_FULL_PLAY !== '0';

let browser;
let page;
let tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (label, v) => console.log('# ' + label + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));

before(async () => {
  if (!FFMPEG) return;
  tmp = mkdtempSync(join(tmpdir(), 'amc-release-'));
  makeReleaseLibrary(join(tmp, 'Music'), { ffmpeg: FFMPEG, atmos: HAVE_ATMOS ? ATMOS : null });
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 611 }, deviceScaleFactor: 1 });
  /* __mod(path): the module instance the app itself loaded (a dev server
     that saw edits serves HMR-stamped URLs). __msHandlers: the app's Media
     Session handlers. */
  await context.addInitScript(() => {
    try {
      performance.setResourceTimingBufferSize(10000);
    } catch {
      /* older engines */
    }
    window.__mod = (p) => {
      const hit = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === p;
          } catch {
            return false;
          }
        });
      return import(hit.length ? hit[hit.length - 1] : p);
    };
  });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__amcDebug);
  await page.setInputFiles('#picker', join(tmp, 'Music'));
  const want = HAVE_ATMOS ? 7 : 6;
  await page.waitForFunction((n) => window.__amcDebug.S.tracks.length >= n && !window.__amcDebug.S.scanning, want, { timeout: 60000 });
  /* Measurement helpers, in the page. */
  await page.evaluate(() => {
    const H = (window.__rel = {});
    /** Rising zero crossings per second of `x` (a pure tone: its frequency). */
    H.freq = (x, rate) => {
      let n = 0;
      let first = -1;
      let last = -1;
      for (let i = 1; i < x.length; i++) {
        if (x[i - 1] < 0 && x[i] >= 0) {
          const at = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
          if (first < 0) first = at;
          last = at;
          n++;
        }
      }
      return n > 1 ? ((n - 1) * rate) / (last - first) : 0;
    };
    /** Analysers on a node's output, one per channel. */
    H.tapNode = (ctx, node, channels) => {
      const sp = ctx.createChannelSplitter(channels);
      node.connect(sp);
      const an = [];
      for (let c = 0; c < channels; c++) {
        const a = ctx.createAnalyser();
        a.fftSize = 32768;
        sp.connect(a, c);
        an.push(a);
      }
      return {
        read() {
          return an.map((a) => {
            const b = new Float32Array(a.fftSize);
            a.getFloatTimeDomainData(b);
            return b;
          });
        },
        rate: ctx.sampleRate,
        close() {
          try {
            node.disconnect(sp);
          } catch {
            /* gone */
          }
        },
      };
    };
    /** Output of the engine's gain node (what reaches the speakers). */
    H.engineOut = (channels) => {
      const o = window.__amcDebug.media.debugEngine().debugOutput();
      return H.tapNode(o.ctx, o.node, channels || o.node.channelCount || 2);
    };
    /** The <audio> element's own output, via captureStream (a fresh
        capture each time: a new src ends the previous stream's track). */
    H.elementOut = () => {
      const a = document.getElementById('audio');
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(a.captureStream());
      const t = H.tapNode(ctx, src, 1);
      const close = t.close;
      t.close = () => {
        close();
        void ctx.close();
      };
      return t;
    };
    H.rms = (x) => {
      let s = 0;
      for (const v of x) s += v * v;
      return Math.sqrt(s / x.length);
    };
    H.peak = (x) => {
      let m = 0;
      for (const v of x) {
        if (!Number.isFinite(v)) return NaN;
        m = Math.max(m, Math.abs(v));
      }
      return m;
    };
    H.play = (title) => {
      const D = window.__amcDebug;
      const tr = D.S.tracks.find((x) => x.title === title);
      const album = D.S.albums.find((al) => al.tracks.includes(tr));
      D.playList(album.tracks, album.tracks.indexOf(tr), { attemptTarget: true });
    };
  });
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const D = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });

async function playTitle(title, path) {
  await D((t) => window.__rel.play(t), title);
  await waitFor(([t, p]) => {
    const A = window.__amcDebug;
    return A.S.current && A.S.current.title === t && A.media.path === p && !A.media.paused && A.media.currentTime > 0.3;
  }, [title, path]);
}

async function activityLog() {
  await page.keyboard.press('Control+Shift+D');
  const text = await page.textContent('#errlist');
  await page.keyboard.press('Escape');
  return text || '';
}

async function setRpm(rpm) {
  await D(async (r) => {
    const m = await window.__mod('/src/ui/turntable/speed.ts');
    m.setRpm(r);
  }, rpm);
  await sleep(250);
}

async function engineFreq() {
  return D(async () => {
    const H = window.__rel;
    const t = H.engineOut(2);
    await new Promise((r) => setTimeout(r, 900));
    const [l] = t.read();
    t.close();
    return Math.round(H.freq(l, t.rate));
  });
}

async function elementFreq() {
  return D(async () => {
    const H = window.__rel;
    const t = H.elementOut();
    await new Promise((r) => setTimeout(r, 900));
    const [l] = t.read();
    t.close();
    return Math.round(H.freq(l, t.rate));
  });
}

const skipNoFf = !FFMPEG && 'no ffmpeg (set AMC_FFMPEG) to build the library';
const skipNoAtmos = skipNoFf || (!HAVE_ATMOS && 'no Atmos file in test/private/ (AMC_ATMOS_FILE)');

/* ---------- 8.1 ---------- */

test('8.1 a FLAC plays natively, unchanged', { skip: skipNoFf }, async () => {
  await playTitle('Sine 440', 'native');
  const t0 = await D(() => window.__amcDebug.media.currentTime);
  await sleep(2000);
  const s = await D(() => {
    const A = window.__amcDebug;
    const a = document.getElementById('audio');
    return {
      path: A.media.path,
      engine: !!A.media.debugEngine(),
      ct: A.media.currentTime,
      rate: A.media.playbackRate,
      pitch: A.media.preservesPitch,
      elRate: a.playbackRate,
      src: a.src.slice(0, 5),
      chip: !!document.querySelector('#pbTitle .soft-chip'),
      aac: a.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    };
  });
  const hz = await elementFreq();
  report('8.1 native FLAC', { ...s, advanced: +(s.ct - t0).toFixed(2), hz });
  assert.equal(s.path, 'native');
  assert.equal(s.engine, false, 'no software engine was even created');
  assert.equal(s.src, 'blob:');
  assert.equal(s.chip, false, 'no "Software decode" chip');
  assert.ok(s.ct - t0 > 1.7 && s.ct - t0 < 2.4, 'clock advanced ' + (s.ct - t0));
  assert.equal(s.rate, 1);
  assert.equal(s.pitch, true);
  assert.ok(Math.abs(hz - 440) <= 3, 'element output ' + hz + ' Hz');
  /* This Chromium is built without proprietary codecs: AAC is not
     natively playable here, so the native AAC path cannot be exercised. */
  report('8.1 AAC canPlayType in this Chromium', JSON.stringify(s.aac));
});

/* ---------- 8.2 ---------- */

test('8.2 ALAC plays through the engine; seek lands on the sample; gapless splice', { skip: skipNoFf }, async () => {
  await playTitle('Sweep', 'engine');
  const info = await D(() => {
    const i = window.__amcDebug.media.engineInfo();
    return { codec: i.codec, backend: i.backend, isStub: i.isStub, rate: i.sampleRate, ch: i.channels, version: i.decoderVersion };
  });
  report('8.2 engine', info);
  assert.equal(info.codec, 'alac');
  assert.equal(info.backend, 'wasm');
  assert.equal(info.isStub, false);
  /* Seek to 10.000 s: the output must start exactly at the click there. */
  const seek = await D(async () => {
    const A = window.__amcDebug;
    const e = A.media.debugEngine();
    const blocks = [];
    e.setTap((stream, planes, media) => blocks.push({ media, x: planes[0] }));
    await new Promise((res) => {
      A.media.addEventListener('seeked', res, { once: true });
      A.media.currentTime = 10;
    });
    const ctAfter = A.media.currentTime;
    await new Promise((r) => setTimeout(r, 600));
    e.setTap(null);
    /* media frame → sample, over what was tapped after the seek */
    const target = 10 * 44100;
    let firstMedia = Infinity;
    let clickAt = -1;
    for (const b of blocks) {
      if (b.media < target - 4410 || b.media > target + 44100) continue;
      firstMedia = Math.min(firstMedia, b.media);
      for (let i = 0; i < b.x.length; i++) if (clickAt < 0 && Math.abs(b.x[i]) > 0.6) clickAt = b.media + i;
    }
    return { ctAfter, firstMedia, clickAt, target };
  });
  report('8.2 seek', seek);
  assert.ok(Math.abs(seek.ctAfter - 10) < 0.05, 'currentTime after seek ' + seek.ctAfter);
  assert.equal(seek.firstMedia, seek.target, 'the first sample played after the seek is the target frame');
  assert.ok(Math.abs(seek.clickAt - seek.target) <= 22, 'the 10 s click is where it belongs: ' + seek.clickAt);
  /* Gapless: Tone A → Tone B, one continuous sine cut in two. */
  await playTitle('Tone A', 'engine');
  const g = await D(async () => {
    const A = window.__amcDebug;
    const e = A.media.debugEngine();
    let ended = 0;
    const onEnded = () => ended++;
    A.media.addEventListener('ended', onEnded);
    const blocks = [];
    A.media.currentTime = 7.5;
    await new Promise((r) => setTimeout(r, 300));
    e.setTap((stream, planes) => blocks.push({ stream, x: planes[0] }));
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && A.S.current.title !== 'Tone B') await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 800));
    e.setTap(null);
    A.media.removeEventListener('ended', onEnded);
    blocks.sort((a, b) => a.stream - b.stream);
    let gaps = 0;
    let maxJump = 0;
    let prev = null;
    let prevEnd = -1;
    for (const b of blocks) {
      if (prevEnd >= 0 && b.stream !== prevEnd) gaps++;
      for (const v of b.x) {
        if (prev !== null) maxJump = Math.max(maxJump, Math.abs(v - prev));
        prev = v;
      }
      prevEnd = b.stream + b.x.length;
    }
    return { now: A.S.current.title, ended, gaps, maxJump, samples: blocks.reduce((n, b) => n + b.x.length, 0) };
  });
  report('8.2 gapless', g);
  assert.equal(g.now, 'Tone B', 'advanced to the next track');
  assert.equal(g.ended, 0, 'no ended event: spliced, not reloaded');
  assert.equal(g.gaps, 0, 'the tapped stream is contiguous');
  /* a 440 Hz sine at 0.5 moves at most 0.0313 per sample at 44.1 kHz */
  assert.ok(g.maxJump < 0.035, 'no discontinuity across the splice: max step ' + g.maxJump);
});

/* ---------- 8.3 ---------- */

test('8.3 a non-JOC E-AC-3 plays as a 5.1 core with no renderer', { skip: skipNoFf }, async () => {
  await playTitle('Six Tones', 'engine');
  await sleep(600);
  const r = await D(async () => {
    const A = window.__amcDebug;
    const e = A.media.debugEngine();
    const st = e.debugState();
    const caps = [];
    e.setTap((stream, planes) => caps.push(planes));
    await new Promise((res) => setTimeout(res, 700));
    e.setTap(null);
    const H = window.__rel;
    const hz = [];
    for (let c = 0; c < 6; c++) {
      const all = new Float32Array(caps.reduce((n, p) => n + p[c].length, 0));
      let at = 0;
      for (const p of caps) {
        all.set(p[c], at);
        at += p[c].length;
      }
      hz.push(Math.round(H.freq(all, 48000)));
    }
    const { currentFormatLabel } = await window.__mod('/src/ui/player.ts');
    return { info: st.info, nodeChannels: st.nodeChannels, spatial: st.spatial, hz, label: currentFormatLabel() };
  });
  report('8.3 E-AC-3 core', { joc: r.info.joc, spatial: r.info.spatial, channels: r.info.channels, nodeChannels: r.nodeChannels, renderer: r.spatial, hz: r.hz, label: r.label });
  assert.equal(r.info.codec, 'ec-3');
  assert.equal(r.info.joc, false);
  assert.equal(r.info.spatial, null, 'no spatial processor');
  assert.equal(r.spatial, false, 'no renderer');
  assert.equal(r.info.coreChannels, 6);
  assert.equal(r.nodeChannels, 6);
  assert.equal(r.label, 'Dolby Digital Plus (5.1) · Software decode');
  /* FL FR FC LFE SL SR = 300 500 700 60 900 1100 Hz: the channel order is right */
  [300, 500, 700, 60, 900, 1100].forEach((f, c) => assert.ok(Math.abs(r.hz[c] - f) <= 3, 'channel ' + c + ': ' + r.hz[c] + ' Hz, want ' + f));
});

/* ---------- 8.4 ---------- */

async function atmosLevels(channels, ms = 1500) {
  return D(
    async ([n, wait]) => {
      const H = window.__rel;
      const t = H.engineOut(n);
      await new Promise((r) => setTimeout(r, wait));
      const x = t.read();
      t.close();
      return x.map((c) => ({ rms: +H.rms(c).toFixed(4), peak: +H.peak(c).toFixed(3) }));
    },
    [channels, ms]
  );
}

async function setSpatial(mode) {
  await D((m) => {
    const A = window.__amcDebug;
    A.S.spatialMode = m;
    A.media.refreshSpatialMode();
  }, mode);
  await sleep(300);
}

test('8.4 the real Atmos file plays with objects in all three output modes; seek resets cleanly', { skip: skipNoAtmos }, async () => {
  await setSpatial('headphones');
  await playTitle('Get On the Floor', 'engine');
  await waitFor(() => window.__amcDebug.media.spatialObjects() > 0);
  await sleep(1500);
  const base = await D(async () => {
    const A = window.__amcDebug;
    const e = A.media.debugEngine();
    const st = e.debugState();
    const { currentFormatLabel } = await window.__mod('/src/ui/player.ts');
    return { spatial: st.info.spatial, joc: st.info.joc, nodeChannels: st.nodeChannels, renderer: st.spatial, objects: A.media.spatialObjects(), mode: A.media.spatialOutputMode(), label: currentFormatLabel(), chip: document.querySelector('#pbTitle .soft-chip').title };
  });
  report('8.4 Atmos', base);
  assert.equal(base.joc, true);
  assert.deepEqual(base.spatial, { maxChannels: 17, bedLayout: ['LFE'], bedChannels: 1, objectChannels: 16 });
  assert.equal(base.nodeChannels, 17);
  assert.equal(base.renderer, true);
  assert.equal(base.objects, 15);
  assert.equal(base.label, 'Dolby Atmos · 15 objects · Software decode');
  assert.ok(base.chip.startsWith('Dolby Atmos · 15 objects'), base.chip);
  const log = await activityLog();
  assert.ok(log.includes("ec-3 isn't supported natively here — using software decoding"), 'takeover line');
  assert.ok(log.includes('Dolby Atmos objects decoded — rendering for headphones'), 'Atmos line');

  const modes = {};
  for (const mode of ['headphones', 'speakers']) {
    await setSpatial(mode);
    await sleep(400);
    const lv = await atmosLevels(2);
    const graph = await D(() => window.__amcDebug.media.debugEngine().renderer.active.graph.mode);
    modes[mode] = { graph, levels: lv };
    assert.equal(graph, mode);
    for (const c of lv) {
      assert.ok(c.rms > 0.01, mode + ': audible ' + JSON.stringify(lv));
      assert.ok(c.peak <= 1, mode + ': no clipping ' + JSON.stringify(lv));
    }
  }
  /* Multichannel: this headless Chromium has a 2-channel output. On it the
     renderer falls back to speakers, by design… */
  await setSpatial('multichannel');
  const fallback = await D(() => window.__amcDebug.media.debugEngine().renderer.active.graph.mode);
  assert.equal(fallback, 'speakers', '2-channel device: multichannel falls back to speakers');
  /* …so a 7.1.4 device is simulated (maxChannelCount 12) and the renderer's
     12-channel output measured before the destination. */
  await D(() => {
    const d = Object.getOwnPropertyDescriptor(AudioDestinationNode.prototype, 'maxChannelCount');
    window.__rel.maxDesc = d;
    Object.defineProperty(AudioDestinationNode.prototype, 'maxChannelCount', { configurable: true, get: () => 12 });
  });
  await D(() => {
    window.__amcDebug.S.spatialMode = 'speakers';
    window.__amcDebug.media.refreshSpatialMode();
  });
  await sleep(200);
  await setSpatial('multichannel');
  await sleep(400);
  const mc = await D(() => {
    const r = window.__amcDebug.media.debugEngine().renderer.active.graph;
    return { graph: r.mode, layout: r.layout && r.layout.name, labels: r.layout && r.layout.speakers.map((s) => s.label) };
  });
  const mcLevels = await atmosLevels(12);
  modes.multichannel = { ...mc, levels: Object.fromEntries(mc.labels.map((l, i) => [l, mcLevels[i].rms])) };
  report('8.4 modes', modes);
  assert.equal(mc.graph, 'multichannel');
  assert.equal(mc.layout, '7.1.4');
  const lvl = modes.multichannel.levels;
  for (const sp of ['FL', 'FR', 'FC', 'LFE']) assert.ok(lvl[sp] > 0.005, 'multichannel ' + sp + ' audible: ' + JSON.stringify(lvl));
  assert.ok(['SL', 'SR', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'].some((sp) => lvl[sp] > 0.002), 'surround/height carry objects: ' + JSON.stringify(lvl));
  for (const c of mcLevels) assert.ok(c.peak <= 1, 'no clipping');
  await D(() => {
    Object.defineProperty(AudioDestinationNode.prototype, 'maxChannelCount', window.__rel.maxDesc);
  });
  await setSpatial('headphones');

  /* Seek: both sides reset, playback resumes at the target with objects. */
  const sk = await D(async () => {
    const A = window.__amcDebug;
    const e = A.media.debugEngine();
    const r = e.renderer;
    let resets = 0;
    const origReset = r.reset.bind(r);
    r.reset = () => {
      resets++;
      origReset();
    };
    const before = { stream: e.debugState().pos.stream, anchor: r.anchor && r.anchor.frame };
    await new Promise((res) => {
      A.media.addEventListener('seeked', res, { once: true });
      A.media.currentTime = 150;
    });
    const afterSeek = { ct: A.media.currentTime, anchor: r.anchor, keyframes: r.timeline.keyframes.length };
    await new Promise((res) => setTimeout(res, 800));
    const H = window.__rel;
    const t = H.engineOut(2);
    await new Promise((res) => setTimeout(res, 800));
    const x = t.read();
    t.close();
    const st = e.debugState();
    const kf = r.timeline.keyframes;
    return {
      resets,
      before,
      afterSeek,
      ct: A.media.currentTime,
      playing: !A.media.paused,
      stream: st.pos.stream,
      anchorFrame: r.anchor && r.anchor.frame,
      firstKeyframe: kf.length ? kf[0].frame : null,
      objects: A.media.spatialObjects(),
      rms: x.map((c) => +H.rms(c).toFixed(4)),
      peak: x.map((c) => +H.peak(c).toFixed(3)),
    };
  });
  report('8.4 seek', sk);
  assert.ok(sk.resets >= 1, 'renderer.reset() on seek');
  assert.equal(sk.afterSeek.anchor, null, 'the renderer dropped its anchor at the seek');
  assert.equal(sk.afterSeek.keyframes, 0, 'and its old keyframes');
  assert.ok(sk.ct > 150 && sk.ct < 153, 'resumed from the target: ' + sk.ct);
  assert.ok(sk.playing);
  assert.ok(sk.anchorFrame > sk.before.stream, 're-anchored on the new stream position');
  assert.ok(sk.firstKeyframe !== null && sk.firstKeyframe >= sk.anchorFrame - 48000, 'fresh keyframes after the seek');
  assert.equal(sk.objects, 15);
  for (let c = 0; c < 2; c++) {
    assert.ok(sk.rms[c] > 0.01, 'audible after the seek');
    assert.ok(sk.peak[c] <= 1, 'no clipping after the seek');
  }
});

/* ---------- 8.5 ---------- */

async function deck() {
  return D(async () => {
    const m = await window.__mod('/src/ui/turntable/motion.ts');
    const sw = await window.__mod('/src/ui/turntable/swap.ts');
    return { platter: m.currentPlatterAngle(), arm: m.currentArmAngle(), live: m.liveArmAngle(), swap: sw.swapRunning(), t: window.__amcDebug.media.currentTime };
  });
}

async function spinRate() {
  const a = await deck();
  await sleep(1000);
  const b = await deck();
  return { degPerSec: +(b.platter - a.platter).toFixed(1), timePerSec: +(b.t - a.t).toFixed(3), armOk: Math.abs(b.arm - b.live) < 0.5, arm: +b.arm.toFixed(2) };
}

test('8.5 turntable on a native and an engine track; RPM moves the pitch on both paths; Atmos in sync at 45; covers', { skip: skipNoFf }, async () => {
  await setRpm(100 / 3);
  /* Native track, turntable mode. */
  await playTitle('Sine 440', 'native');
  await page.click('#pbArt');
  await page.waitForSelector('#npview:not([hidden])');
  await D(() => {
    if (window.__amcDebug.S.npMode !== 'turntable') document.getElementById('npMode').click();
  });
  await page.waitForSelector('#tt', { state: 'visible' });
  await sleep(600);
  const out = { native: {}, engine: {} };
  out.native['33⅓'] = { ...(await spinRate()), hz: await elementFreq() };
  for (const rpm of [16, 45, 78]) {
    await setRpm(rpm);
    const st = await D(() => ({ rate: window.__amcDebug.media.playbackRate, pitch: window.__amcDebug.media.preservesPitch }));
    out.native[rpm] = { ...st, ...(await spinRate()), hz: await elementFreq() };
  }
  /* Covers: High → 2000 px from the 3000 px embedded art, on the deck's
     label, the Now Playing art and the Media Session. */
  const coverAt = () =>
    D(() => {
      const md = navigator.mediaSession.metadata;
      return { label: document.getElementById('ttLabel').naturalWidth, np: document.getElementById('npArt').naturalWidth, session: md && md.artwork[0] && md.artwork[0].sizes, quality: window.__amcDebug.S.artQuality };
    });
  await waitFor(() => document.getElementById('ttLabel').naturalWidth >= 2000);
  const covers = { high: await coverAt() };
  /* Engine track (another album): the record swaps, then the same checks. */
  await setRpm(100 / 3);
  await D((t) => window.__rel.play(t), 'Tone A');
  await sleep(300);
  const swap = await deck();
  await waitFor(() => window.__amcDebug.media.path === 'engine' && !window.__amcDebug.media.paused && window.__amcDebug.media.currentTime > 0.3);
  await sleep(3000);
  const swapDone = await deck();
  out.swap = { runningAfter300ms: swap.swap, runningAfter3s: swapDone.swap };
  await D(() => (window.__amcDebug.media.currentTime = 1));
  await sleep(400);
  out.engine['33⅓'] = { ...(await spinRate()), hz: await engineFreq() };
  for (const rpm of [16, 45, 78]) {
    await setRpm(rpm);
    await D(() => (window.__amcDebug.media.currentTime = 2));
    await sleep(300);
    const st = await D(() => ({ rate: window.__amcDebug.media.playbackRate, pitch: window.__amcDebug.media.preservesPitch }));
    out.engine[rpm] = { ...st, ...(await spinRate()), hz: await engineFreq() };
  }
  /* The stop/start effect on the engine path, through the real Media
     Session handler path (media.pause). */
  await setRpm(100 / 3);
  const brake = await D(async () => {
    const A = window.__amcDebug;
    A.media.pause();
    await new Promise((r) => setTimeout(r, 350));
    const during = { paused: A.media.paused, rate: +A.media.playbackRate.toFixed(3) };
    await new Promise((r) => setTimeout(r, 900));
    const afterBrake = { paused: A.media.paused, rate: A.media.playbackRate };
    await A.media.play();
    await new Promise((r) => setTimeout(r, 150));
    const spin = +A.media.playbackRate.toFixed(3);
    await new Promise((r) => setTimeout(r, 600));
    return { during, afterBrake, spinUp: spin, final: A.media.playbackRate, paused: A.media.paused };
  });
  out.brake = brake;
  report('8.5 turntable', out);
  const approx = (a, b, tol) => Math.abs(a - b) <= tol;
  for (const [path, rows] of Object.entries({ native: out.native, engine: out.engine })) {
    for (const [rpm, want] of [['33⅓', 1], [16, 16 / (100 / 3)], [45, 45 / (100 / 3)], [78, 78 / (100 / 3)]]) {
      const r = rows[rpm];
      assert.ok(approx(r.hz, 440 * want, 440 * want * 0.012 + 2), `${path} ${rpm} RPM: ${r.hz} Hz, want ${(440 * want).toFixed(0)}`);
      assert.ok(approx(r.timePerSec, want, 0.08 * want + 0.03), `${path} ${rpm} RPM: clock ${r.timePerSec} s/s`);
      assert.ok(approx(r.degPerSec, 200 * want, 20 * want + 8), `${path} ${rpm} RPM: platter ${r.degPerSec}°/s`);
      assert.ok(r.armOk, `${path} ${rpm} RPM: tonearm follows the playback position`);
      if (rpm !== '33⅓') {
        assert.ok(approx(r.rate, want, 1e-9), `${path} ${rpm}: rate ${r.rate}`);
        assert.equal(r.pitch, false, `${path} ${rpm}: the pitch follows the speed`);
      }
    }
  }
  assert.equal(out.swap.runningAfter300ms, true, 'changing album swaps the record');
  assert.equal(out.swap.runningAfter3s, false, 'and the swap finishes');
  assert.ok(!brake.during.paused && brake.during.rate < 1, 'engine: pause brakes first: ' + JSON.stringify(brake.during));
  assert.ok(brake.afterBrake.paused && brake.afterBrake.rate === 1, 'then pauses, rate restored');
  assert.ok(brake.spinUp < 1 && brake.final === 1 && !brake.paused, 'play spins back up');

  /* Covers at other levels: the level applies (re-minted), both ways. */
  await D((t) => window.__rel.play(t), 'Sine 440');
  await waitFor(() => window.__amcDebug.media.path === 'native' && !window.__amcDebug.media.paused);
  await sleep(3000);
  covers.highAgain = await coverAt();
  for (const q of ['standard', 'max', 'high']) {
    await page.click('#npClose');
    await page.click('#settingsBtn');
    await page.waitForSelector(`[data-artq="${q}"]`);
    await page.click(`[data-artq="${q}"]`);
    await page.click('text=Albums');
    await page.click('#pbArt');
    await page.waitForSelector('#tt', { state: 'visible' });
    const want = q === 'standard' ? 1200 : q === 'max' ? 3000 : 2000;
    await waitFor((w) => document.getElementById('npArt').naturalWidth === w || document.getElementById('ttLabel').naturalWidth === w, want, 20000);
    await sleep(500);
    covers[q] = await coverAt();
  }
  report('8.5 covers', covers);
  assert.deepEqual(covers.high, { label: 2000, np: 2000, session: '2000x2000', quality: 'high' });
  assert.equal(covers.standard.label, 1200);
  assert.equal(covers.standard.session, '1200x1200');
  assert.equal(covers.max.label, 3000);
  assert.equal(covers.max.session, '3000x3000');
  assert.equal(covers.high.label, 2000);
  await page.click('#npClose');
});

test('8.5 Atmos keyframes stay in sync at 45 RPM', { skip: skipNoAtmos }, async () => {
  await setSpatial('headphones');
  /* Samples, every 40 ms for 6 s: the renderer's frame-for-this-instant
     (the clock its automation is scheduled on) against the worklet's
     (last reported source frame, extrapolated at the reported rate), in ms
     of audio; and how often the renderer had to re-anchor. `control`
     repeats the run with the renderer's setRate() disabled — the
     behaviour before this release. */
  const measure = (label, disableRate) =>
    D(
      async ([lab, off]) => {
        const A = window.__amcDebug;
        const e = A.media.debugEngine();
        const r = e.renderer;
        const origSetRate = r.setRate.bind(r);
        if (off) {
          r.setRate(1);
          r.setRate = () => {};
        }
        const origPlayed = r.setPlayedFrame.bind(r);
        let reanchors = 0;
        r.setPlayedFrame = (f) => {
          const a = r.anchor;
          origPlayed(f);
          if (r.anchor !== a) reanchors++;
        };
        await new Promise((res) => setTimeout(res, 600));
        reanchors = 0;
        const errs = [];
        const ctx = e.ctx;
        const sr = ctx.sampleRate;
        const t0 = performance.now();
        while (performance.now() - t0 < 6000) {
          await new Promise((res) => setTimeout(res, 40));
          const p = e.pos;
          if (!r.anchor || !p.playing) continue;
          const now = ctx.currentTime;
          const worklet = p.stream + (now - p.time) * sr * p.rate;
          const renderer = r.anchor.frame + (now - r.anchor.time) * sr * r.rate;
          errs.push(((renderer - worklet) / sr) * 1000);
        }
        r.setPlayedFrame = origPlayed;
        r.setRate = origSetRate;
        r.setRate(e.pos.rate);
        errs.sort((a, b) => Math.abs(a) - Math.abs(b));
        const abs = errs.map(Math.abs);
        const q = (k) => +abs[Math.min(abs.length - 1, Math.floor(k * abs.length))].toFixed(1);
        return { label: lab, rate: +e.pos.rate.toFixed(3), rendererRate: r.rate, samples: errs.length, p50ms: q(0.5), p95ms: q(0.95), maxMs: q(1), reanchorsPer6s: reanchors, objects: A.media.spatialObjects() };
      },
      [label, disableRate]
    );
  await playTitle('Get On the Floor', 'engine');
  await setRpm(100 / 3);
  await sleep(800);
  const at33 = await measure('33⅓ RPM', false);
  await setRpm(45);
  await sleep(800);
  const at45 = await measure('45 RPM', false);
  const control = await measure('45 RPM, renderer rate-unaware (before)', true);
  await setRpm(100 / 3);
  report('8.5 Atmos sync', [at33, at45, control]);
  assert.ok(Math.abs(at45.rate - 1.35) < 1e-9, 'rate ' + at45.rate);
  assert.ok(Math.abs(at45.rendererRate - 1.35) < 1e-9, 'the renderer follows the playback rate: ' + at45.rendererRate);
  assert.equal(at45.objects, 15);
  assert.ok(at45.p95ms < 12, 'object automation tracks the audio at 45 RPM: p95 ' + at45.p95ms + ' ms');
  assert.ok(at45.reanchorsPer6s <= at33.reanchorsPer6s + 3, 're-anchoring as rare as at 33⅓: ' + at45.reanchorsPer6s + ' vs ' + at33.reanchorsPer6s);
  assert.ok(control.p95ms > at45.p95ms, 'the fix matters: without setRate p95 ' + control.p95ms + ' ms');
});

/* ---------- 8.6 ---------- */

/** A CDP sender for the page's decode Worker. Short-lived job workers
    (waveform peaks) come and go, so it waits until only one is left. */
async function attachWorker(cdp) {
  let workers = [];
  for (let i = 0; i < 120; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    workers = targetInfos.filter((t) => t.type === 'worker');
    if (workers.length === 1) break;
    await sleep(500);
  }
  const w = workers.pop();
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

test('8.6 memory stays flat over a full play (the Atmos track, headphones, 1×)', { skip: skipNoAtmos || (!FULL_PLAY && 'AMC_FULL_PLAY=0') }, async () => {
  await setSpatial('headphones');
  await setRpm(100 / 3);
  await playTitle('Get On the Floor', 'engine');
  await D(() => (window.__amcDebug.media.currentTime = 0));
  const duration = await D(() => window.__amcDebug.media.duration);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  const workerSend = await attachWorker(cdp);
  const workerHeap = async () => {
    await workerSend('HeapProfiler.collectGarbage');
    const r = (await workerSend('Runtime.getHeapUsage')).result;
    return r.usedSize + (r.backingStorageSize || 0);
  };
  const samples = [];
  const t0 = Date.now();
  let ended = false;
  while (!ended && Date.now() - t0 < (duration + 30) * 1000) {
    await sleep(15000);
    const st = await D(() => {
      const A = window.__amcDebug;
      const s = A.media.debugEngine().debugState();
      return { ct: A.media.currentTime, queued: s.queuedFrames, title: A.S.current && A.S.current.title, paused: A.media.paused, ended: A.media.ended };
    });
    samples.push({ at: Math.round((Date.now() - t0) / 1000), ct: Math.round(st.ct), heap: await heap(), worker: await workerHeap(), queued: st.queued });
    ended = st.ended || st.title !== 'Get On the Floor' || st.ct >= duration - 1;
  }
  const mb = (b) => +(b / 1048576).toFixed(1);
  report('8.6 main heap MB', samples.map((s) => mb(s.heap)).join(' '));
  report('8.6 worker heap+buffers MB', samples.map((s) => mb(s.worker)).join(' '));
  report('8.6 position s', samples.map((s) => s.ct).join(' '));
  report('8.6 max buffered s', (Math.max(...samples.map((s) => s.queued)) / 48000).toFixed(2));
  assert.ok(ended, 'played to the end');
  const steady = samples.slice(1);
  const hs = steady.map((s) => s.heap);
  const ws = steady.map((s) => s.worker);
  assert.ok(Math.max(...hs) - Math.min(...hs) < 8 * 1048576, 'main heap spread ' + mb(Math.max(...hs) - Math.min(...hs)) + ' MB');
  assert.ok(Math.max(...ws) - Math.min(...ws) < 8 * 1048576, 'worker spread ' + mb(Math.max(...ws) - Math.min(...ws)) + ' MB');
  assert.ok(Math.max(...samples.map((s) => s.queued)) < 4.5 * 48000, 'the worklet queue stays bounded');
});

test('no page errors', { skip: skipNoFf }, () => {
  assert.deepEqual(pageErrors, []);
});
