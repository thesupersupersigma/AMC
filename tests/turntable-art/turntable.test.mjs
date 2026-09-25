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
        await spinAndArm({ page, keys, check });
        await dragToSeek({ page, keys, check });
      }
      check(`[${width}] no uncaught page errors`, errors.length === 0, errors.slice(0, 3));
    } finally {
      await browser.close();
    }
  }
}

/* ---------- gate 4: spin and tonearm ---------- */

async function sample(page, ms) {
  return page.evaluate(async (ms) => {
    const m = await window.__mod('/src/ui/turntable/motion.ts');
    const a0 = m.currentPlatterAngle();
    const t0 = performance.now();
    const c0 = document.getElementById('audio').currentTime;
    await new Promise((r) => setTimeout(r, ms));
    const a1 = m.currentPlatterAngle();
    const t1 = performance.now();
    const c1 = document.getElementById('audio').currentTime;
    return { degPerSec: ((a1 - a0) / (t1 - t0)) * 1000, mediaPerSec: ((c1 - c0) / (t1 - t0)) * 1000, style: document.getElementById('ttPlatter').style.transform };
  }, ms);
}

async function armAt(page, sec) {
  return page.evaluate(async (sec) => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    const m = await window.__mod('/src/ui/turntable/motion.ts');
    const g = await window.__mod('/src/ui/turntable/geometry.ts');
    pb.seek(sec);
    await new Promise((r) => setTimeout(r, 900)); /* past any lift/move/drop */
    const d = pb.getDuration();
    const frac = pb.getTime() / d;
    const arm = m.currentArmAngle();
    const styleDeg = parseFloat((document.getElementById('ttArm').style.transform.match(/rotate\(([-\d.]+)deg\)/) || [])[1]);
    return { t: pb.getTime(), d, frac, arm, styleDeg, expect: g.armAngleFor(frac), outer: g.OUTER_DEG, inner: g.INNER_DEG, r: g.radiusForAngle(arm) };
  }, sec);
}

async function spinAndArm({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 0);
  const s1 = await sample(page, 1500);
  check('platter advances ≈ 200°/s at 33⅓ while playing', Math.abs(s1.degPerSec - 200) < 12, s1);
  await page.evaluate(async () => {
    window.__st.S.ttBrake = false; /* the plain pause here; the brake has its own test */
    document.getElementById('audio').pause();
  });
  await page.waitForTimeout(300);
  const s2 = await sample(page, 1000);
  check('platter frozen while paused', Math.abs(s2.degPerSec) < 0.5, s2);

  const a0 = await armAt(page, 0);
  const a5 = await armAt(page, 20);
  const a1 = await armAt(page, 39.95);
  check('tonearm at 0 % sits on the outer groove', Math.abs(a0.arm - a0.outer) < 0.05 && Math.abs(a0.r - 282) < 1, a0);
  check('tonearm at 50 % is midway through the groove sweep', Math.abs(a5.arm - (a5.outer + a5.inner) / 2) < 0.15 && Math.abs(a5.arm - a5.expect) < 0.01, a5);
  check('tonearm at 100 % sits on the inner groove', Math.abs(a1.arm - a1.inner) < 0.1 && Math.abs(a1.r - 122) < 2, a1);
  check('the drawn arm follows the angle (style transform)', Math.abs(a5.styleDeg - a5.arm) < 0.01, [a5.styleDeg, a5.arm]);

  /* A cue-split side: the arm walks the whole 12-minute side. */
  await openTurntable(page, keys, 'Delta Side A', 1);
  const cue = await page.evaluate(async () => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    const m = await window.__mod('/src/ui/turntable/motion.ts');
    const g = await window.__mod('/src/ui/turntable/geometry.ts');
    await new Promise((r) => setTimeout(r, 900));
    const t = window.__st.S.current;
    return { title: t.title, kind: t.kind, start: t.startSec, end: t.endSec, time: pb.getTime(), d: pb.getDuration(), arm: m.currentArmAngle(), expectSide: g.armAngleFor(pb.getTime() / pb.getDuration()), trackOnly: g.armAngleFor((pb.getTime() - t.startSec) / (t.endSec - t.startSec)), bands: document.querySelectorAll('#ttBands i').length };
  });
  check('cue track: the tonearm maps across the whole side, not the track', cue.kind === 'virtual' && Math.abs(cue.d - 720) < 1 && Math.abs(cue.arm - cue.expectSide) < 0.05 && Math.abs(cue.arm - cue.trackOnly) > 5, cue);
  check('cue side: gaps between its songs are drawn as bands in the vinyl', cue.bands === 2, cue.bands);
}

async function headGeometry(page) {
  return page.evaluate(async () => {
    const g = await window.__mod('/src/ui/turntable/geometry.ts');
    const st = document.querySelector('.tt-stage').getBoundingClientRect();
    const u = st.width / g.STAGE_W;
    const hb = document.getElementById('ttHead').getBoundingClientRect();
    return { pivot: [st.left + g.PIVOT.x * u, st.top + g.PIVOT.y * u], head: [hb.left + hb.width / 2, hb.top + hb.height / 2], outer: g.OUTER_DEG, inner: g.INNER_DEG };
  });
}

function pointFor(geo, armNow, armTarget) {
  const dx = geo.head[0] - geo.pivot[0];
  const dy = geo.head[1] - geo.pivot[1];
  const r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx) + ((armTarget - armNow) * Math.PI) / 180;
  return [geo.pivot[0] + r * Math.cos(a), geo.pivot[1] + r * Math.sin(a)];
}

async function dragToSeek({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 1);
  await page.waitForTimeout(900);
  let geo = await headGeometry(page);
  let armNow = await page.evaluate(async () => (await window.__mod('/src/ui/turntable/motion.ts')).currentArmAngle());
  const mid = (geo.outer + geo.inner) / 2;
  const [x1, y1] = pointFor(geo, armNow, mid);
  await page.mouse.move(geo.head[0], geo.head[1]);
  await page.mouse.down();
  const lifted = await page.evaluate(() => document.getElementById('ttWorld').classList.contains('tt-lifted'));
  for (let i = 1; i <= 8; i++) await page.mouse.move(geo.head[0] + ((x1 - geo.head[0]) * i) / 8, geo.head[1] + ((y1 - geo.head[1]) * i) / 8);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const r1 = await page.evaluate(async () => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    return { t: pb.getTime(), d: pb.getDuration(), lifted: document.getElementById('ttWorld').classList.contains('tt-lifted') };
  });
  check('pressing the headshell lifts the arm', lifted, lifted);
  check('dragging the tonearm to mid-record seeks to ~50 %', Math.abs(r1.t / r1.d - 0.5) < 0.03 && !r1.lifted, r1);

  /* Touch: the same drag with touch pointers, on the cue side, across a
     track boundary — playback moves to the song that holds the drop. */
  await openTurntable(page, keys, 'Delta Side A', 0);
  await page.waitForTimeout(900);
  geo = await headGeometry(page);
  armNow = await page.evaluate(async () => (await window.__mod('/src/ui/turntable/motion.ts')).currentArmAngle());
  const target = geo.outer + (geo.inner - geo.outer) * (600 / 720);
  const [x2, y2] = pointFor(geo, armNow, target);
  const touch = await page.evaluate(async ({ from, to }) => {
    const head = document.getElementById('ttHead');
    const fire = (type, x, y) => head.dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire('pointerdown', from[0], from[1]);
    for (let i = 1; i <= 10; i++) fire('pointermove', from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
    fire('pointerup', to[0], to[1]);
    await new Promise((r) => setTimeout(r, 700));
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    return { t: pb.getTime(), title: window.__st.S.current.title };
  }, { from: geo.head, to: [x2, y2] });
  check('touch-dragging on a cue side seeks across the side and switches to the song there', Math.abs(touch.t - 600) < 12 && touch.title === 'Delta Three', touch);

  /* Keyboard: the arm is a slider — arrows move ±5 s, once. */
  const kb = await page.evaluate(async () => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    document.getElementById('audio').pause();
    pb.seek(500);
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('ttHead').focus();
    return pb.getTime();
  });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const kb2 = await page.evaluate(async () => (await window.__mod('/src/ui/turntable/playback.ts')).getTime());
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  const kb3 = await page.evaluate(async () => (await window.__mod('/src/ui/turntable/playback.ts')).getTime());
  check('arrow keys on the tonearm move exactly ±5 s', Math.abs(kb2 - kb - 5) < 0.3 && Math.abs(kb3 - kb2 + 10) < 0.3, [kb, kb2, kb3]);
  const aria = await page.evaluate(() => {
    const h = document.getElementById('ttHead');
    return { role: h.getAttribute('role'), now: h.getAttribute('aria-valuenow'), max: h.getAttribute('aria-valuemax'), text: h.getAttribute('aria-valuetext') };
  });
  check('tonearm is an ARIA slider with a time value text', aria.role === 'slider' && Number(aria.max) === 720 && /^\d+:\d\d of 12:00 on this side$/.test(aria.text), aria);
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
