/* Gate 6: reduced motion (no spin, crossfade swaps, audio features
   intact), the lyrics panel beside the deck, and the frame budget. */

import { launch, loadLibrary, albumKeys, makeChecker, startServer } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';

async function openTT(page, keys, album, idx = 0) {
  await page.evaluate(async ({ k, album, idx }) => {
    window.__swap = await window.__mod('/src/ui/turntable/swap.ts');
    window.__motion = await window.__mod('/src/ui/turntable/motion.ts');
    const p = await window.__mod('/src/ui/player.ts');
    p.playList(window.__st.S.albumMap[k[album]].tracks, idx);
    const np = await window.__mod('/src/ui/nowplaying.ts');
    np.openNowPlaying();
  }, { k: keys, album, idx });
  await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2, null, { timeout: 10000 });
  if (!(await page.evaluate(() => document.getElementById('npview').classList.contains('np-tt')))) await page.click('#npMode');
  await page.waitForFunction(() => !window.__swap.swapRunning(), null, { timeout: 6000 }).catch(() => null);
}

async function reduced({ server, check }) {
  const { browser, page, errors } = await launch({ width: 1365, height: 611, reducedMotion: 'reduce' });
  try {
    await loadLibrary(page, server.url, FIX, 11);
    const keys = await albumKeys(page);
    await openTT(page, keys, 'Alpha', 0);
    const spin = await page.evaluate(async () => {
      const m = window.__motion;
      const a0 = m.currentPlatterAngle();
      const c0 = document.getElementById('audio').currentTime;
      await new Promise((r) => setTimeout(r, 1200));
      return { moved: m.currentPlatterAngle() - a0, played: document.getElementById('audio').currentTime - c0 };
    });
    check('reduced motion: the record does not spin while playing', Math.abs(spin.moved) < 0.01 && spin.played > 1, spin);
    const jump = await page.evaluate(async () => {
      const pb = await window.__mod('/src/ui/turntable/playback.ts');
      const g = await window.__mod('/src/ui/turntable/geometry.ts');
      const a0 = window.__motion.currentPlatterAngle();
      pb.seek(20);
      await new Promise((r) => setTimeout(r, 300));
      const a1 = window.__motion.currentPlatterAngle();
      return { a0, a1, expect: pb.getTime() * g.DEG_PER_SEC };
    });
    check('reduced motion: the static record turns only on a seek', jump.a1 !== jump.a0 && Math.abs(jump.a1 - jump.expect) < 70, jump);
    const sw = page.evaluate(async () => {
      const seen = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 900) {
        seen.push({ t: Math.round(performance.now() - t0), rec: document.getElementById('ttRec').style.transform, op: getComputedStyle(document.getElementById('ttRec')).opacity, running: window.__swap.swapRunning() });
        await new Promise((r) => setTimeout(r, 40));
      }
      return seen;
    });
    await page.evaluate(async (k) => (await window.__mod('/src/ui/player.ts')).playList(window.__st.S.albumMap[k.Beta].tracks, 0), keys);
    const seen = await sw;
    const faded = seen.some((x) => Number(x.op) < 0.6);
    check('reduced motion: an album change is a crossfade (no sliding record)', seen.every((x) => x.rec === '') && faded && !seen[seen.length - 1].running, { faded, last: seen[seen.length - 1] });
    await page.click('[data-rpm="45"]');
    const rate = await page.evaluate(() => [document.getElementById('audio').playbackRate, document.getElementById('audio').preservesPitch]);
    check('reduced motion: RPM still changes the speed and pitch', Math.abs(rate[0] - 1.35) < 0.001 && rate[1] === false, rate);
    await page.click('#ttRpmReset');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const trace = page.evaluate(async () => {
      const a = document.getElementById('audio');
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) {
        out.push([Math.round(performance.now() - t0), +a.playbackRate.toFixed(2), a.paused]);
        await new Promise((r) => setTimeout(r, 60));
      }
      return out;
    });
    await page.keyboard.press('Space');
    const tr = await trace;
    const p = tr.find((x) => x[2]);
    check('reduced motion: the brake is still heard (ramp, then pause)', tr.some((x) => !x[2] && x[1] < 0.8) && p && p[0] > 600, { p, min: Math.min(...tr.map((x) => x[1])) });
    check('reduced motion: no uncaught page errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
}

async function lyricsAndBudget({ server, check, shotDir }) {
  const { browser, page, errors } = await launch({ width: 1365, height: 611 });
  try {
    await loadLibrary(page, server.url, FIX, 11);
    const keys = await albumKeys(page);
    await openTT(page, keys, 'Alpha', 0);
    await page.evaluate(async () => (await window.__mod('/src/ui/lyrics.ts')).toggleLyrics());
    await page.waitForTimeout(500);
    const lay = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { plinth: r('.tt-plinth').left, sleeve: r('.tt-sleeve').left, side: r('.np-side').right, controls: r('.np-controls').right, lyrics: r('#lyricspanel').left };
    });
    check('lyrics open in turntable mode: deck stays on screen, controls stay clear of the panel', lay.sleeve >= -30 && lay.plinth > 0 && lay.side <= lay.lyrics + 1, lay);
    if (shotDir) await page.screenshot({ path: shotDir + '/turntable-1365-lyrics.png' });
    await page.evaluate(async () => (await window.__mod('/src/ui/lyrics.ts')).toggleLyrics());
    await page.waitForTimeout(400);

    /* Frame budget: script time inside the rAF callback. */
    const play = await page.evaluate(async () => {
      const m = window.__motion;
      m.resetFrameStats();
      const vals = [];
      let last = -1;
      let frames = 0;
      await new Promise((res) => {
        const t0 = performance.now();
        const f = () => {
          frames++;
          const c = document.getElementById('audio').currentTime;
          if (c !== last) vals.push(c);
          last = c;
          if (performance.now() - t0 < 5000) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      return { stats: m.frameStats(), distinctTimes: vals.length, frames };
    });
    const swap = await page.evaluate(async (k) => {
      const m = window.__motion;
      m.resetFrameStats();
      (await window.__mod('/src/ui/player.ts')).playList(window.__st.S.albumMap[k.Beta].tracks, 0);
      await new Promise((r) => setTimeout(r, 2700));
      return m.frameStats();
    }, keys);
    console.log('FRAME BUDGET playing: ' + play.stats.avgMs.toFixed(3) + ' ms avg, ' + play.stats.worstMs.toFixed(2) + ' ms worst over ' + play.stats.frames + ' frames; swap: ' + swap.avgMs.toFixed(3) + ' ms avg, ' + swap.worstMs.toFixed(2) + ' ms worst over ' + swap.frames + ' frames; currentTime changed on ' + play.distinctTimes + ' of ' + play.frames + ' frames');
    check('frame budget: < 4 ms of script per frame while playing', play.stats.avgMs < 4 && play.stats.frames > 100, play.stats);
    check('frame budget: < 4 ms of script per frame during a swap', swap.avgMs < 4 && swap.frames > 50, swap);
    check('currentTime advances smoothly enough to drive the spin (changes on most frames)', play.distinctTimes > play.frames * 0.5, play);
    check('lyrics/budget: no uncaught page errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
}

export async function run({ server, check }) {
  await reduced({ server, check });
  await lyricsAndBudget({ server, check, shotDir: process.env.SHOT_DIR });
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
