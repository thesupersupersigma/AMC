/* Release verification for v2.3.0: the SINGLE-FILE build opened from disk
   (file://, an opaque origin: no File System Access, no service worker, no
   module loading) plays a FLAC natively, and what the software engine, the
   Atmos add-on and the turntable do there.

     npm run build:file
     node --test test/browser/release-file.e2e.mjs

   AMC_BUILD_URL runs the same UI checks against a SERVED build instead
   (e.g. `npm run build && npx vite preview` → http://localhost:4173/).

   Production code has no debug handle, so this drives the UI and reads the
   DOM. Audio output is measured by an init script that records every
   AudioContext node connected to a destination, and by captureStream() on
   the <audio> element. Needs ffmpeg for the library (see
   test/helpers/release-library.mjs); the Atmos checks need
   test/private/get-on-the-floor.m4a. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findFfmpeg, makeReleaseLibrary } from '../helpers/release-library.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = join(ROOT, 'dist-file/index.html');
const SERVED = process.env.AMC_BUILD_URL || '';
const ATMOS = process.env.AMC_ATMOS_FILE || join(ROOT, 'test/private/get-on-the-floor.m4a');
const HAVE_ATMOS = existsSync(ATMOS);
const FFMPEG = findFfmpeg();
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

let browser;
let page;
let tmp;
const pageErrors = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (label, v) => console.log('# ' + label + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
const skip = (!SERVED && !existsSync(BUILD) && 'no dist-file/index.html — run npm run build:file') || (!FFMPEG && 'no ffmpeg (set AMC_FFMPEG)');

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'amc-release-file-'));
  makeReleaseLibrary(join(tmp, 'Music'), { ffmpeg: FFMPEG, atmos: HAVE_ATMOS ? ATMOS : null });
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 611 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    /* Every node the page connects to an AudioDestinationNode. */
    window.__toDest = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode) window.__toDest.push(this);
      return connect.call(this, dest, ...rest);
    };
  });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(SERVED || pathToFileURL(BUILD).href);
  await page.waitForSelector('#picker', { state: 'attached' });
  await page.setInputFiles('#picker', join(tmp, 'Music'));
  await page.click('text=Songs');
  await page.waitForFunction((n) => document.querySelectorAll('#view .row[data-uid]').length >= n, HAVE_ATMOS ? 7 : 6, { timeout: 60000 });
  await page.evaluate(() => {
    const H = (window.__rel = {});
    H.freq = (x, rate) => {
      /* A pure tone's frequency: the median period between rising zero
         crossings, so a dropout in a capture is one outlier interval,
         not a lost stretch of the count. */
      const at = [];
      for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) at.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
      if (at.length < 3) return 0;
      const d = [];
      for (let i = 1; i < at.length; i++) d.push(at[i] - at[i - 1]);
      d.sort((a, b) => a - b);
      return rate / d[d.length >> 1];
    };
    H.rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    /** One analyser on `node`; resolves with 0.74 s of its first channel. */
    H.grab = async (ctx, node, ms = 900) => {
      const a = ctx.createAnalyser();
      a.fftSize = 32768;
      node.connect(a);
      await new Promise((r) => setTimeout(r, ms));
      const b = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(b);
      node.disconnect(a);
      return { x: b, rate: ctx.sampleRate };
    };
    /** The software engine's output: the last node it connected to a
        running context's destination. */
    H.engine = async () => {
      const live = window.__toDest.filter((n) => n.context.state === 'running');
      const n = live[live.length - 1];
      if (!n) return { hz: 0, rms: 0 };
      const g = await H.grab(n.context, n);
      return { hz: Math.round(H.freq(g.x, g.rate)), rms: +H.rms(g.x).toFixed(4), contexts: live.length };
    };
    H.element = async () => {
      const a = document.getElementById('audio');
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(a.captureStream());
      /* a fresh capture takes a moment to start flowing: read the last
         0.74 s of 1.6 s */
      const g = await H.grab(ctx, src, 1600);
      void ctx.close();
      return { hz: Math.round(H.freq(g.x, g.rate)), rms: +H.rms(g.x).toFixed(4) };
    };
  });
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function playRow(title) {
  if (!(await page.$('#view .row[data-uid]'))) await page.click('text=Songs');
  const row = page.locator('#view .row[data-uid]', { hasText: title }).first();
  await row.dblclick();
  await page.waitForFunction((t) => (document.getElementById('pbTitle').textContent || '').startsWith(t), title, { timeout: 15000 });
}

async function elapsedAdvances() {
  const a = await page.textContent('#pbElapsed');
  await sleep(2100);
  const b = await page.textContent('#pbElapsed');
  const sec = (s) => s.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
  return sec(b) - sec(a);
}

async function activityLog() {
  await page.keyboard.press('Control+Shift+D');
  const text = await page.textContent('#errlist');
  await page.keyboard.press('Escape');
  return text || '';
}

test('file:// single-file build: the page is really on file://', { skip: skip || (SERVED ? 'served build' : false) }, async () => {
  const r = await page.evaluate(() => ({ protocol: location.protocol, origin: String(self.origin), sw: 'serviceWorker' in navigator && !!navigator.serviceWorker.controller, fsa: 'showDirectoryPicker' in window }));
  report('page', r);
  assert.equal(r.protocol, 'file:');
  assert.equal(r.origin, 'null', 'opaque origin');
});

test('file:// a FLAC plays natively', { skip }, async () => {
  await playRow('Sine 440');
  const adv = await elapsedAdvances();
  const out = await page.evaluate(() => window.__rel.element());
  const chip = await page.$('#pbTitle .soft-chip');
  report('FLAC', { elapsedAdvancedSec: adv, ...out, softChip: !!chip });
  assert.ok(adv >= 1 && adv <= 3, 'elapsed time advanced ' + adv + ' s');
  assert.ok(Math.abs(out.hz - 440) <= 3, out.hz + ' Hz');
  assert.equal(chip, null, 'native, not the engine');
});

test('file:// the software engine plays ALAC (Blob-URL worker, data: worklet and wasm)', { skip }, async () => {
  await playRow('Tone A');
  await page.waitForSelector('#pbTitle .soft-chip', { timeout: 15000 });
  const adv = await elapsedAdvances();
  const out = await page.evaluate(() => window.__rel.engine());
  report('ALAC (engine)', { elapsedAdvancedSec: adv, ...out });
  assert.ok(adv >= 1 && adv <= 3, 'elapsed time advanced ' + adv + ' s');
  assert.ok(Math.abs(out.hz - 440) <= 3, out.hz + ' Hz');
});

test('file:// turntable: 45 RPM moves the pitch on the engine and on the element', { skip }, async () => {
  await page.click('#pbArt');
  await page.waitForSelector('#npview:not([hidden])');
  if (!(await page.$('#tt:not([hidden])')) || !(await page.isVisible('#tt'))) await page.click('#npMode');
  await page.waitForSelector('#tt', { state: 'visible' });
  await page.click('[data-rpm="45"]');
  await sleep(500);
  const read = await page.textContent('#ttRpmRead');
  const eng = await page.evaluate(() => window.__rel.engine());
  await page.click('#npClose');
  await playRow('Sine 440');
  await sleep(800);
  const el = await page.evaluate(() => window.__rel.element());
  await page.click('#pbArt');
  await page.waitForSelector('#tt', { state: 'visible' });
  await page.click('#ttRpmReset');
  await sleep(300);
  const back = await page.textContent('#ttRpmRead');
  await page.click('#npClose');
  report('turntable', { read, engineHz: eng.hz, elementHz: el.hz, back });
  assert.match(read, /^45 RPM · 1\.35×/);
  assert.ok(Math.abs(eng.hz - 594) <= 5, 'engine at 45 RPM: ' + eng.hz + ' Hz');
  assert.ok(Math.abs(el.hz - 594) <= 5, 'element at 45 RPM: ' + el.hz + ' Hz');
  assert.match(back, /^33⅓ RPM/);
});

test('file:// Atmos: objects decode and render', { skip: skip || (!HAVE_ATMOS && 'no Atmos file') }, async () => {
  await playRow('Get On the Floor');
  await page.waitForSelector('#pbTitle .soft-chip', { timeout: 15000 });
  await sleep(2500);
  await page.click('#pbArt');
  await page.waitForSelector('#npview:not([hidden])');
  await page.waitForFunction(() => /Dolby Atmos · \d+ objects/.test(document.getElementById('npFormat').textContent || ''), null, { timeout: 15000 });
  const label = await page.textContent('#npFormat');
  const out = await page.evaluate(() => window.__rel.engine());
  await page.click('#npClose');
  const log = await activityLog();
  report('Atmos', { label, rms: out.rms });
  assert.equal(label, 'Dolby Atmos · 15 objects · Software decode');
  assert.ok(out.rms > 0.01, 'audible');
  assert.ok(log.includes('Dolby Atmos objects decoded — rendering for'), 'Atmos activity line');
  assert.ok(!/worklet could not load|decode worker failed|Could not start Web Audio/.test(log), 'no engine failures in the log');
});

test('file:// Settings shows the Cavern credit', { skip }, async () => {
  await page.click('#settingsBtn');
  await page.waitForSelector('#setAtmosCredit');
  const t = await page.textContent('#setAtmosCredit');
  assert.match(t, /Cavern by VoidX/);
  const running = await page.textContent('.settings');
  if (!SERVED) assert.match(running, /Running from a file/);
});

test('file:// no page errors', { skip }, () => {
  report('console errors', consoleErrors);
  assert.deepEqual(pageErrors, []);
});
