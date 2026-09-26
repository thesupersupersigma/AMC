/* Feature parity on software-decoded tracks, through the real app:

     npm run dev
     AMC_URL=http://localhost:5173 node --test test/browser/parity.e2e.mjs

   Every item of the brief's parity checklist that a browser can observe.
   The WASM decoder may be the silent stub: these checks are about
   behaviour, timing and wiring, not sample values (engine.e2e.mjs covers
   sample accuracy with real audio). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  tmp = mkdtempSync(join(tmpdir(), 'amc-parity-'));
  makeLibrary(join(tmp, 'Music'), { long: true });
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 611 }, acceptDownloads: true });
  /* Record what the app hands the Media Session. */
  await context.addInitScript(() => {
    const ms = navigator.mediaSession;
    const rec = { handlers: {}, positions: [] };
    window.__ms = rec;
    if (!ms) return;
    const setAction = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (a, fn) => {
      rec.handlers[a] = fn;
      return setAction(a, fn);
    };
    const setPos = ms.setPositionState.bind(ms);
    ms.setPositionState = (s) => {
      rec.positions.push(s ? { ...s } : null);
      return setPos(s);
    };
  });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__amcDebug);
  await page.setInputFiles('#picker', join(tmp, 'Music'));
  await page.waitForFunction(() => window.__amcDebug.S.tracks.length >= 10 && !window.__amcDebug.S.scanning, null, { timeout: 60000 });
  /* Teach the session that ALAC and E-AC-3 need the engine. */
  for (const t of ['Alpha', 'Get Up']) {
    await playTitle(t);
    await page.waitForFunction(() => window.__amcDebug.media.path === 'engine', null, { timeout: 8000 });
  }
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function playTitle(title, attempt = true, from) {
  await page.evaluate(
    ([t, a, f]) => {
      const D = window.__amcDebug;
      /* Album shuffle leaves shuffle mode on; queue order must be known. */
      D.S.shuffle = false;
      const tr = D.S.tracks.find((x) => x.title === t);
      const album = D.S.albums.find((al) => al.tracks.includes(tr));
      const list = f === 'all' ? D.S.tracks.filter((x) => !x.claimedByCue && !x.shadowed) : album.tracks;
      D.playList(list, list.indexOf(tr), a ? { attemptTarget: true } : undefined);
    },
    [title, attempt, from]
  );
}

const snap = () =>
  page.evaluate(() => {
    const D = window.__amcDebug;
    const c = D.S.current;
    const e = D.media.debugEngine();
    return {
      title: c && c.title,
      playing: D.S.playing,
      path: D.media.path,
      ct: D.media.currentTime,
      dur: D.media.duration,
      paused: D.media.paused,
      volume: D.S.volume,
      muted: D.S.muted,
      queue: D.S.queue.map((t) => t.title),
      qi: D.S.qi,
      shuffle: D.S.shuffle,
      repeat: D.S.repeat,
      eng: e ? e.debugState() : null,
    };
  });

async function playing(title) {
  await page.waitForFunction((t) => window.__amcDebug.S.current && window.__amcDebug.S.current.title === t && window.__amcDebug.media.path === 'engine' && !window.__amcDebug.media.paused && window.__amcDebug.media.currentTime > 0.2, title, { timeout: 10000 });
}

async function activityLog() {
  await page.keyboard.press('Control+Shift+D');
  const text = await page.textContent('#errlist');
  await page.keyboard.press('Escape');
  return text || '';
}

test('play / pause / seek / scrub from the player bar', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await page.click('#btnPlay');
  await sleep(300);
  let s = await snap();
  assert.equal(s.paused, true);
  assert.equal(s.playing, false);
  const held = s.ct;
  await sleep(500);
  assert.equal((await snap()).ct, held, 'paused clock holds');
  await page.click('#btnPlay');
  await sleep(500);
  s = await snap();
  assert.equal(s.playing, true);
  assert.ok(s.ct > held);
  /* Scrub to 75% through the range input, as a drag release does. */
  await page.$eval('#scrub', (el) => {
    el.value = '750';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  s = await snap();
  assert.ok(Math.abs(s.ct - 0.75 * s.dur) < 0.4, 'scrubbed to ' + s.ct + ' of ' + s.dur);
});

test('keyboard shortcuts: Space, ←/→ seek, ↑/↓ volume, Shift+→ next', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await page.keyboard.press('ArrowRight');
  await sleep(250);
  let s = await snap();
  assert.ok(s.ct > 4.5, '→ seeks +5 s: ' + s.ct);
  await page.keyboard.press('ArrowLeft');
  await sleep(250);
  s = await snap();
  assert.ok(s.ct < 2, '← seeks −5 s: ' + s.ct);
  const v0 = s.volume;
  await page.keyboard.press('ArrowDown');
  await sleep(100);
  s = await snap();
  assert.ok(Math.abs(s.volume - (v0 - 0.05)) < 1e-6, 'volume down');
  await sleep(200);
  assert.ok(Math.abs(s.eng.gain - s.volume) < 0.05 || (await snap()).eng.gain < v0, 'engine gain follows');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await sleep(250);
  assert.equal((await snap()).paused, true, 'Space pauses');
  await page.keyboard.press('Space');
  await sleep(250);
  assert.equal((await snap()).paused, false, 'Space resumes');
  await page.keyboard.press('Shift+ArrowRight');
  await playing('Beta');
});

test('volume slider and mute reach the engine gain', async () => {
  await playing('Beta');
  await page.$eval('#vol', (el) => {
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  let s = await snap();
  assert.ok(Math.abs(s.volume - 0.4) < 1e-6);
  assert.ok(Math.abs(s.eng.gain - 0.4) < 0.02, 'engine gain ' + s.eng.gain);
  await page.click('#btnMute');
  await sleep(300);
  s = await snap();
  assert.equal(s.muted, true);
  assert.ok(s.eng.gain < 0.01, 'muted gain ' + s.eng.gain);
  await page.click('#btnMute');
  await page.$eval('#vol', (el) => {
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  assert.ok((await snap()).eng.gain > 0.98);
});

test('next / prev between engine tracks; prev restarts after 3 s', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await page.click('#btnNext');
  await playing('Beta');
  await sleep(3300);
  await page.click('#btnPrev');
  await sleep(300);
  let s = await snap();
  assert.equal(s.title, 'Beta', 'first prev restarts');
  assert.ok(s.ct < 1, 'restarted at ' + s.ct);
  await page.click('#btnPrev');
  await playing('Alpha');
});

test('shuffle and repeat: queue order changes, current track keeps playing', async () => {
  await playTitle('Alpha', false, 'all');
  await playing('Alpha');
  const before = (await snap()).queue;
  await page.click('#btnShuffle');
  await sleep(200);
  let s = await snap();
  assert.equal(s.shuffle, true);
  assert.equal(s.queue[s.qi], 'Alpha', 'current track preserved');
  assert.equal(s.queue.length, before.length);
  assert.equal(s.path, 'engine');
  assert.equal(s.paused, false, 'still playing');
  await page.click('#btnShuffle');
  await page.click('#btnRepeat');
  await page.click('#btnRepeat');
  s = await snap();
  assert.equal(s.repeat, 'one');
  /* Repeat-one on a 5-second engine track: it comes round again. */
  await playTitle('Gamma');
  await playing('Gamma');
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 4.2;
  });
  await sleep(2000);
  s = await snap();
  await page.click('#btnRepeat'); /* off, before asserting, so later tests start clean */
  assert.equal((await snap()).repeat, 'off');
  assert.equal(s.title, 'Gamma');
  assert.ok(s.ct > 0.3 && s.ct < 2 && !s.paused, 'looped and playing: ' + s.ct + (s.paused ? ' (paused)' : ''));
});

test('album shuffle across a selection of engine albums', async () => {
  await page.click('text=Albums');
  await page.waitForSelector('.tile[data-nav^="album:"]');
  const tiles = await page.$$('.tile[data-nav^="album:"]');
  let clicked = 0;
  for (const t of tiles) {
    const txt = await t.textContent();
    if (/ALAC Album|Atmos Album/.test(txt)) {
      await t.click({ modifiers: ['Control'] });
      clicked++;
    }
  }
  assert.equal(clicked, 2, 'two album tiles selected');
  await page.click('#albumselShuffle');
  await sleep(600);
  const s = await snap();
  assert.deepEqual([...s.queue].sort(), ['Alpha', 'Beta', 'Gamma', 'Get Up']);
  assert.equal(s.path, 'engine');
  await page.waitForFunction(() => !window.__amcDebug.media.paused && window.__amcDebug.media.currentTime > 0.2, null, { timeout: 8000 });
});

test('queue: play next / add to queue keep engine tracks', async () => {
  const r = await page.evaluate(async () => {
    const D = window.__amcDebug;
    const { queueNext, queueAppend } = await import('/src/ui/player.ts');
    const get = (t) => D.S.tracks.find((x) => x.title === t);
    D.playList([get('First Light')], 0, { attemptTarget: true });
    queueNext([get('Gamma')]);
    queueAppend([get('Get Up')]);
    return D.S.queue.map((t) => t.title);
  });
  assert.deepEqual(r, ['First Light', 'Gamma', 'Get Up']);
  await page.evaluate(() => window.__amcDebug.next(true));
  await playing('Gamma');
  await page.evaluate(() => window.__amcDebug.next(true));
  await playing('Get Up');
});

test('gapless between engine files of one album: no reload, no ended', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  const gen0 = (await snap()).eng.gen;
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 4.0;
  });
  await page.waitForFunction(() => window.__amcDebug.S.current.title === 'Beta', null, { timeout: 8000 });
  const s = await snap();
  assert.equal(s.path, 'engine');
  assert.equal(s.eng.gen, gen0 + 1, 'same stream: only the seek bumped the generation');
  assert.ok(s.ct < 2.5, 'Beta clock from its own start: ' + s.ct);
  assert.equal(s.qi, 1);
  assert.equal(s.paused, false);
  assert.equal(s.dur, 6);
});

test('contiguous cue tracks on an engine source cross without a reload', async () => {
  await playTitle('Groove One');
  await playing('Groove One');
  const s0 = await snap();
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 5.0;
  });
  await page.waitForFunction(() => window.__amcDebug.S.current.title === 'Groove Two', null, { timeout: 6000 });
  const s = await snap();
  assert.equal(s.eng.seg, s0.eng.seg, 'same segment: the source never reloaded');
  assert.equal(s.eng.gen, s0.eng.gen + 1, 'only the seek');
  assert.ok(s.ct > 5.9 && s.ct < 7.5, 'source clock ' + s.ct);
});

test('crossfade: the engine stream fades out as a tail while the next starts', async () => {
  await page.evaluate(() => {
    window.__amcDebug.S.crossfadeSec = 3;
  });
  await playTitle('Alpha');
  await playing('Alpha');
  const first = await page.evaluate(() => window.__amcDebug.media.debugEngine());
  void first;
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 2.5;
  });
  await page.waitForFunction(() => window.__amcDebug.S.current.title === 'Beta', null, { timeout: 6000 });
  const s = await snap();
  assert.equal(s.path, 'engine');
  await playing('Beta');
  const workers = page.workers().length;
  assert.ok(workers >= 2, 'tail and main engines alive together (' + workers + ' workers)');
  await sleep(3800);
  assert.ok(page.workers().length < workers, 'tail disposed after the fade');
  await page.evaluate(() => {
    window.__amcDebug.S.crossfadeSec = 0;
  });
});

test('per-track resume on a long engine track', async () => {
  await playTitle('Long Side');
  await playing('Long Side');
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 90;
  });
  await sleep(6500);
  await playTitle('Alpha');
  await playing('Alpha');
  await playTitle('Long Side');
  await page.waitForSelector('#resumechip:not([hidden])', { timeout: 6000 });
  const label = await page.textContent('#resumechip');
  assert.ok(/Resume from 1:3\d/.test(label), label);
  await page.click('#resumechip');
  await sleep(500);
  const s = await snap();
  assert.ok(s.ct >= 90 && s.ct < 99, 'resumed at ' + s.ct);
});

test('Media Session: metadata, artwork, handlers, position state from the engine clock', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await sleep(600);
  const r = await page.evaluate(async () => {
    const ms = navigator.mediaSession;
    const md = ms.metadata;
    const h = window.__ms.handlers;
    const out = { title: md && md.title, artist: md && md.artist, art: md && md.artwork.length, state: ms.playbackState, handlers: Object.keys(h).sort() };
    const posBefore = window.__ms.positions.length;
    h.pause();
    await new Promise((r) => setTimeout(r, 200));
    out.pausedByHandler = window.__amcDebug.media.paused;
    out.stateAfterPause = ms.playbackState;
    h.play();
    await new Promise((r) => setTimeout(r, 300));
    out.playingAgain = !window.__amcDebug.media.paused;
    h.seekto({ seekTime: 3 });
    await new Promise((r) => setTimeout(r, 300));
    out.afterSeek = window.__amcDebug.media.currentTime;
    const pos = window.__ms.positions.slice(posBefore).filter(Boolean);
    out.lastPos = pos[pos.length - 1];
    h.nexttrack();
    await new Promise((r) => setTimeout(r, 600));
    out.afterNext = window.__amcDebug.S.current.title;
    const el = document.getElementById('audio');
    out.keepalive = { paused: el.paused, loop: el.loop };
    return out;
  });
  assert.equal(r.title, 'Alpha');
  assert.equal(r.artist, 'Lossless Artist');
  assert.ok(r.art >= 1, 'artwork published');
  assert.equal(r.state, 'playing');
  for (const a of ['play', 'pause', 'seekto', 'nexttrack', 'previoustrack', 'seekbackward', 'seekforward']) assert.ok(r.handlers.includes(a), a);
  assert.equal(r.pausedByHandler, true);
  assert.equal(r.stateAfterPause, 'paused');
  assert.equal(r.playingAgain, true);
  assert.ok(r.afterSeek >= 3 && r.afterSeek < 3.6, 'seekto ' + r.afterSeek);
  assert.ok(r.lastPos && r.lastPos.duration === 6 && r.lastPos.position >= 2.9 && r.lastPos.position < 3.6, JSON.stringify(r.lastPos));
  assert.equal(r.afterNext, 'Beta');
  assert.deepEqual(r.keepalive, { paused: false, loop: true });
});

test('Now Playing and ambient theming on an engine track', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await page.click('#pbArt');
  await page.waitForSelector('#npview:not([hidden])');
  await sleep(700);
  const r = await page.evaluate(() => ({
    title: document.getElementById('npTitle').textContent,
    format: document.getElementById('npFormat').textContent,
    ambient: document.body.classList.contains('ambient'),
  }));
  assert.equal(r.title, 'Alpha');
  assert.equal(r.format, 'Apple Lossless · Software decode');
  assert.equal(r.ambient, true, 'cover colours tint the shell');
  await page.keyboard.press('Escape');
});

test('synced lyrics follow the engine clock', async () => {
  await playTitle('Beta');
  await playing('Beta');
  await page.click('#btnLyrics');
  await page.waitForSelector('#lyrbody .active, #lyrbody [class*="line"]', { timeout: 6000 });
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 2.3;
  });
  await sleep(700);
  let active = await page.textContent('#lyrbody .active');
  assert.equal((active || '').trim(), 'Second line');
  await page.evaluate(() => {
    window.__amcDebug.media.currentTime = 4.2;
  });
  await sleep(700);
  active = await page.textContent('#lyrbody .active');
  assert.equal((active || '').trim(), 'Third line');
  await page.click('#btnLyrics');
});

test('Document PiP mirrors and drives the engine', async () => {
  const supported = await page.evaluate(() => 'documentPictureInPicture' in window);
  if (!supported) return;
  await playTitle('Alpha');
  await playing('Alpha');
  const [pip] = await Promise.all([page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null), page.click('#btnPip')]);
  if (!pip) return; /* headless shells without PiP windows */
  await sleep(700);
  const times = await pip.textContent('#times');
  assert.ok(/0:0\d \/ 0:06/.test(times), times);
  await pip.click('#play');
  await sleep(300);
  assert.equal((await snap()).paused, true);
  await pip.click('#play');
  await sleep(300);
  assert.equal((await snap()).paused, false);
  await page.click('#btnPip');
});

test('rescan while an engine track plays: playback carries on', async () => {
  await playTitle('Alpha');
  await playing('Alpha');
  await page.click('#rescanBtn');
  await page.waitForFunction(() => !window.__amcDebug.S.scanning && window.__amcDebug.S.tracks.length >= 10, null, { timeout: 60000 });
  await sleep(500);
  const s = await snap();
  assert.equal(s.path, 'engine');
  assert.equal(s.paused, false);
});

test('playlist M3U export includes engine tracks', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.evaluate(async () => {
      const D = window.__amcDebug;
      const pl = await import('/src/ui/playlists.ts');
      const t = D.S.tracks.find((x) => x.title === 'Get Up');
      const a = D.S.tracks.find((x) => x.title === 'Alpha');
      const p = await pl.createPlaylist('Engine mix', [
        { folderId: t.folderId, path: t.path },
        { folderId: a.folderId, path: a.path },
      ]);
      pl.exportM3U(p.id);
    }),
  ]);
  const text = readFileSync(await dl.path(), 'utf8');
  assert.ok(text.includes('01 Get Up.m4a') && text.includes('01 Alpha.m4a'), text);
});

test('error panel: a broken engine file is logged and skipped, never a hang', async () => {
  await playTitle('Broken');
  await sleep(2500);
  const log = await activityLog();
  assert.ok(/Software decoding failed for Broken/.test(log), log.slice(0, 600));
  assert.ok(/Could not play Broken/.test(log));
  const err = await page.evaluate(() => window.__amcDebug.S.tracks.find((t) => t.title === 'Broken').error);
  assert.equal(err, 'Could not play this file');
});

test('no page errors', () => {
  assert.deepEqual(pageErrors, []);
});
