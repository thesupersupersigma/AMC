/* App-level browser checks for the playback facade and path selection, on a
   synthetic library loaded through the read-only webkitdirectory picker:

     npm run dev
     AMC_URL=http://localhost:5173 node --test test/browser/app.e2e.mjs

   Uses the dev-only window.__amcDebug handle (compiled out of builds).
   In the Chromium Playwright ships, ALAC / E-AC-3 / AAC have no native
   decoder, which is exactly the situation the engine exists for. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLibrary } from '../helpers/make-library.mjs';

const BASE = process.env.AMC_URL || 'http://localhost:5173';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

let browser;
let page;
let tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'amc-app-'));
  makeLibrary(join(tmp, 'Music'));
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage({ viewport: { width: 1365, height: 611 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__amcDebug);
  await page.setInputFiles('#picker', join(tmp, 'Music'));
  await page.waitForFunction(() => window.__amcDebug.S.tracks.length >= 7 && !window.__amcDebug.S.scanning, null, { timeout: 30000 });
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Plays the named track (from its album) the way a double-click does. */
async function playTitle(title, attempt = true) {
  await page.evaluate(
    ([t, a]) => {
      const D = window.__amcDebug;
      const tr = D.S.tracks.find((x) => x.title === t);
      const album = D.S.albums.find((al) => al.tracks.includes(tr));
      D.playList(album.tracks, album.tracks.indexOf(tr), a ? { attemptTarget: true } : undefined);
    },
    [title, attempt]
  );
}

const snap = () =>
  page.evaluate(() => {
    const D = window.__amcDebug;
    const c = D.S.current;
    return {
      title: c && c.title,
      error: c && c.error,
      playing: D.S.playing,
      path: D.media.path,
      ct: D.media.currentTime,
      paused: D.media.paused,
      queue: D.S.queue.map((t) => t.title),
      qi: D.S.qi,
    };
  });

async function activityLog() {
  await page.keyboard.press('Control+Shift+D');
  const text = await page.textContent('#errlist');
  await page.keyboard.press('Escape');
  return text || '';
}

test('native FLAC is untouched: element path, clock, seek, next, pause', async () => {
  await playTitle('First Light');
  await sleep(1500);
  let s = await snap();
  assert.equal(s.title, 'First Light');
  assert.equal(s.path, 'native');
  assert.equal(s.playing, true);
  assert.ok(s.ct > 0.8, 'native clock ' + s.ct);
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 6;
  });
  await sleep(400);
  s = await snap();
  assert.ok(s.ct >= 6 && s.ct < 7, 'native seek ' + s.ct);
  await page.evaluate(() => window.__amcDebug.next(true));
  await sleep(800);
  s = await snap();
  assert.equal(s.title, 'Second Wind');
  assert.equal(s.path, 'native');
  await page.keyboard.press('Space');
  await sleep(300);
  s = await snap();
  assert.equal(s.playing, false);
  assert.equal(s.paused, true);
  const el = await page.evaluate(() => {
    const a = document.getElementById('audio');
    return { src: a.src.slice(0, 5), loop: a.loop };
  });
  assert.equal(el.src, 'blob:');
  assert.equal(el.loop, false);
});

test('a failing native ALAC hands off to the engine mid-attempt — no skip, no error', async () => {
  await playTitle('Alpha');
  await page.waitForFunction(() => window.__amcDebug.media.path === 'engine', null, { timeout: 8000 });
  await sleep(1500);
  const s = await snap();
  assert.equal(s.title, 'Alpha', 'still on the same track');
  assert.ok(!s.error, 'no error on the row: ' + s.error);
  assert.equal(s.playing, true);
  assert.ok(s.ct > 0.5, 'engine clock ' + s.ct);
  const log = await activityLog();
  assert.ok(log.includes("alac isn't supported natively here — using software decoding"), log);
  assert.ok(!/Could not play Alpha/.test(log), 'no playback error logged');
  /* The element keeps the media session alive with silence meanwhile. */
  const el = await page.evaluate(() => {
    const a = document.getElementById('audio');
    return { paused: a.paused, loop: a.loop };
  });
  assert.equal(el.paused, false);
  assert.equal(el.loop, true);
});

test('the queue keeps engine-capable tracks and they start directly in the engine', async () => {
  await playTitle('Beta', false);
  await sleep(300);
  const s = await snap();
  assert.deepEqual(s.queue, ['Alpha', 'Beta', 'Gamma']);
  assert.equal(s.title, 'Beta');
  assert.equal(s.path, 'engine', 'no native attempt once the codec is known to fail');
  const row = await page.evaluate(() => {
    const D = window.__amcDebug;
    return D.S.tracks.filter((t) => t.codec === 'alac').map((t) => t.error || '');
  });
  assert.deepEqual(row, ['', '', '']);
});

test('E-AC-3 (Atmos edition) plays in the engine with the right label', async () => {
  await playTitle('Get Up');
  await page.waitForFunction(() => window.__amcDebug.media.path === 'engine' && window.__amcDebug.S.current.title === 'Get Up', null, { timeout: 8000 });
  await page.waitForFunction(() => window.__amcDebug.media.engineInfo() && window.__amcDebug.media.currentTime > 0.3, null, { timeout: 8000 });
  const chip = await page.getAttribute('#pbTitle .soft-chip', 'title');
  assert.ok(chip && chip.startsWith('Dolby Digital Plus (5.1 · Atmos objects not rendered)'), chip);
  const log = await activityLog();
  assert.ok(log.includes("ec-3 isn't supported natively here — using software decoding"), log);
});

test('a genuinely unsupported codec (AAC here) keeps today’s skip behaviour', async () => {
  await playTitle('Plain AAC');
  await sleep(2500);
  const s = await snap();
  const log = await activityLog();
  assert.ok(/Could not play Plain AAC/.test(log), log);
  assert.equal(s.path, 'native');
  assert.equal(s.playing, false, 'nothing else in that album: playback stops');
});

test('Settings: turning software decoding off restores today’s behaviour', async () => {
  await page.evaluate(() => window.__amcDebug.media.pause());
  await page.click('#settingsBtn');
  await page.waitForSelector('[data-set="softdecode"]');
  assert.equal(await page.isChecked('[data-set="softdecode"]'), true, 'on by default');
  await page.click('[data-set="softdecode"]');
  await sleep(200);
  assert.equal(await page.evaluate(() => window.__amcDebug.S.softDecode), false);
  /* Play/Shuffle on the ALAC album: every track is a known failure now. */
  await playTitle('Alpha', false);
  await sleep(300);
  let s = await snap();
  assert.notEqual(s.title === 'Alpha' && s.playing, true, 'no ALAC queue without the engine');
  /* A direct activation still tries natively, fails, and skips. */
  await playTitle('Gamma', true);
  await sleep(2000);
  s = await snap();
  assert.equal(s.path, 'native');
  const err = await page.evaluate(() => window.__amcDebug.S.tracks.find((t) => t.title === 'Gamma').error);
  assert.equal(err, 'Could not play this file');
  /* Back on for the rest of the suite. */
  await page.click('[data-set="softdecode"]');
  await sleep(200);
  assert.equal(await page.evaluate(() => window.__amcDebug.S.softDecode), true);
});

test('no page errors', () => {
  assert.deepEqual(pageErrors, []);
});
