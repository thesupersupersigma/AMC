/* Turntable mode: the mode toggle and its pref, the deck fitting both
   target viewports, the playback adapter, time-driven spin, the tonearm
   (including across a cue-split side), drag-to-seek, record swaps, rapid
   skips, RPM and pitch, reset-on-exit, the brake, reduced motion and the
   tonearm's keyboard/ARIA contract. */

import { startServer, launch, loadLibrary, albumKeys, makeChecker } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';

async function openTurntable(page, keys, album = 'Alpha', idx = 0) {
  await page.evaluate(async ({ k, album, idx }) => {
    const p = await window.__mod('/src/ui/player.ts');
    p.playList(window.__st.S.albumMap[k[album]].tracks, idx);
    const np = await window.__mod('/src/ui/nowplaying.ts');
    np.openNowPlaying();
  }, { k: keys, album, idx });
  await page.waitForFunction(() => window.__st.S.current && !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2, null, { timeout: 10000 });
  if (!(await page.evaluate(() => document.getElementById('npview').classList.contains('np-tt')))) await page.click('#npMode');
  await page.waitForSelector('#npview.np-tt');
}

export async function skeleton({ page, keys, check, width, height }) {
  const before = await page.evaluate(() => ({ mode: window.__st.S.npMode }));
  await page.evaluate(async (k) => {
    const p = await window.__mod('/src/ui/player.ts');
    p.playList(window.__st.S.albumMap[k.Alpha].tracks, 0);
    const np = await window.__mod('/src/ui/nowplaying.ts');
    np.openNowPlaying();
  }, keys);
  await page.waitForSelector('#npview:not([hidden])');
  const cover = await page.evaluate(() => ({ tt: document.getElementById('npview').classList.contains('np-tt'), art: getComputedStyle(document.querySelector('.np-art')).display, btn: !!document.getElementById('npMode') }));
  check(`[${width}] Now Playing opens in Cover mode by default, with a mode toggle`, before.mode === 'cover' && !cover.tt && cover.art !== 'none' && cover.btn, cover);
  await page.click('#npMode');
  await page.waitForTimeout(700);
  const tt = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const r = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) };
    };
    return {
      tt: document.getElementById('npview').classList.contains('np-tt'),
      scrub: getComputedStyle(document.querySelector('.np-scrub')).display,
      cover: getComputedStyle(document.querySelector('.np-art')).display,
      stage: r('.tt-stage'), plinth: r('.tt-plinth'), sleeve: r('.tt-sleeve'), side: r('.np-side'), controls: r('.np-controls'), speed: r('#ttSpeed'),
      vw, vh, scrollW: document.documentElement.scrollWidth,
      label: document.getElementById('ttLabel').getAttribute('src') || '',
      pref: window.__st.S.npMode,
    };
  });
  const inView = (b) => b.x >= -40 && b.y >= 0 && b.r <= tt.vw + 1 && b.b <= tt.vh + 1;
  check(`[${width}] toggle switches to Turntable mode and persists the pref`, tt.tt && tt.pref === 'turntable', tt.pref);
  check(`[${width}] no seek bar in turntable mode (the tonearm is the seek bar)`, tt.scrub === 'none' && tt.cover === 'none', { scrub: tt.scrub, cover: tt.cover });
  check(`[${width}] the deck, side panel and speed control fit the viewport`, inView(tt.plinth) && inView(tt.side) && inView(tt.speed) && tt.scrollW <= tt.vw, { plinth: tt.plinth, side: tt.side, speed: tt.speed, vw: tt.vw, vh: tt.vh });
  check(`[${width}] deck and side panel do not overlap`, tt.plinth.r <= tt.side.x, [tt.plinth.r, tt.side.x]);
  check(`[${width}] the album cover is on the label`, /^blob:/.test(tt.label), tt.label.slice(0, 40));
  await page.click('#npMode');
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({ tt: document.getElementById('npview').classList.contains('np-tt'), pref: window.__st.S.npMode }));
  check(`[${width}] toggling again returns to Cover mode`, !back.tt && back.pref === 'cover', back);
  await page.evaluate(async () => (await window.__mod('/src/ui/nowplaying.ts')).closeNowPlaying());
  await page.waitForTimeout(350);
}

export async function adapter({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 0);
  const r = await page.evaluate(async () => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    const api = ['getTime', 'getDuration', 'isPaused', 'seek', 'setRate', 'onTrackChange'].filter((n) => typeof pb[n] !== 'function');
    pb.seek(12);
    await new Promise((res) => setTimeout(res, 400));
    return { missing: api, t: pb.getTime(), d: pb.getDuration(), paused: pb.isPaused() };
  });
  check('adapter exposes getTime/getDuration/isPaused/seek/setRate/onTrackChange', r.missing.length === 0, r.missing);
  check('adapter: seek(12) lands at ~12 s of a 40 s track, playing', Math.abs(r.t - 12.4) < 0.6 && Math.abs(r.d - 40) < 0.2 && !r.paused, r);
}

export async function run({ server, check }) {
  for (const [width, height] of [[1365, 611], [1920, 1080]]) {
    const { browser, page, errors } = await launch({ width, height });
    try {
      await loadLibrary(page, server.url, FIX, 11);
      const keys = await albumKeys(page);
      await skeleton({ page, keys, check, width, height });
      if (width === 1365) {
        await adapter({ page, keys, check });
        for (const mod of extra) await mod({ page, keys, check, openTurntable });
      }
      check(`[${width}] no uncaught page errors`, errors.length === 0, errors.slice(0, 3));
    } finally {
      await browser.close();
    }
  }
}

/* Later gates register their sections here. */
const extra = [];
export function register(fn) {
  extra.push(fn);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  const { check, failed } = makeChecker();
  try {
    await run({ server, check });
  } finally {
    server.stop();
  }
  if (failed().length) process.exit(1);
}
