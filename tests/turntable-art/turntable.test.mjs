/* Turntable mode: the mode toggle and its pref, the deck fitting both
   target viewports, the playback adapter, time-driven spin, the tonearm
   (including across a cue-split side), drag-to-seek, record swaps, rapid
   skips, RPM and pitch, reset-on-exit, the brake, reduced motion and the
   tonearm's keyboard/ARIA contract. */

import { startServer, launch, loadLibrary, albumKeys, makeChecker } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';

async function openTurntable(page, keys, album = 'Alpha', idx = 0) {
  await page.evaluate(async ({ k, album, idx }) => {
    window.__swap = await window.__mod('/src/ui/turntable/swap.ts');
    const p = await window.__mod('/src/ui/player.ts');
    p.playList(window.__st.S.albumMap[k[album]].tracks, idx);
    const np = await window.__mod('/src/ui/nowplaying.ts');
    np.openNowPlaying();
  }, { k: keys, album, idx });
  await page.waitForFunction(() => window.__st.S.current && !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2, null, { timeout: 10000 });
  if (!(await page.evaluate(() => document.getElementById('npview').classList.contains('np-tt')))) await page.click('#npMode');
  await page.waitForSelector('#npview.np-tt');
  /* a change of album runs the record swap; let it land */
  await page.waitForFunction(() => window.__swap && !window.__swap.swapRunning(), null, { timeout: 6000 }).catch(() => null);
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
        await swaps({ page, keys, check });
        await speedAndBrake({ page, keys, check });
        await playerBar({ page, keys, check });
        await deckControls({ page, keys, check });
        await shiftSnap({ page, keys, check });
      }
      check(`[${width}] no uncaught page errors`, errors.length === 0, errors.slice(0, 3));
    } finally {
      await browser.close();
    }
  }
}

/* ---------- gate 5: record swaps, speed, the brake ---------- */

async function deckState(page) {
  return page.evaluate(async () => {
    const sw = await window.__mod('/src/ui/turntable/swap.ts');
    const m = await window.__mod('/src/ui/turntable/motion.ts');
    const hero = await window.__mod('/src/art/hero.ts');
    const st = window.__st;
    const key = st.S.current ? st.S.current.coverKey : '';
    const want = hero.heroURLNow(key) || st.coverURL(key);
    const label = document.getElementById('ttLabel');
    return {
      running: sw.swapRunning(), hooks: m.frameHookCount(), key, album: st.S.current && st.S.current.album,
      labelSrc: label.dataset.heroPending || label.getAttribute('src') || '', want,
      rec: document.getElementById('ttRec').style.transform, sleeve: document.getElementById('ttSleeve').style.transform,
      lifted: document.getElementById('ttWorld').classList.contains('tt-lifted'), arm: m.currentArmAngle(), live: m.liveArmAngle(),
      t: document.getElementById('audio').currentTime, paused: document.getElementById('audio').paused,
    };
  });
}

async function swaps({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 0);
  await page.waitForTimeout(1200);
  /* different album → the swap */
  const t0 = Date.now();
  await page.evaluate(async (k) => (await window.__mod('/src/ui/player.ts')).playList(window.__st.S.albumMap[k.Beta].tracks, 0), keys);
  await page.waitForTimeout(150);
  const s0 = await deckState(page);
  await page.waitForTimeout(800);
  const mid = await deckState(page);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/turntable-1365-midswap.png' : '/tmp/claude-0/shots/midswap.png' });
  await page.waitForTimeout(Math.max(0, 2900 - (Date.now() - t0)));
  const end = await deckState(page);
  check('different album: the swap runs (arm off, record slides to the sleeve)', s0.running && mid.running && /translateX\(-/.test(mid.rec), { s0: s0.running, mid: mid.rec });
  check('…while the new track already plays (audio never waits for the animation)', mid.album === 'Beta' && !mid.paused && mid.t > 0.5, { album: mid.album, t: mid.t });
  check('…and ends with the new album on the platter, arm in the groove, nothing left running', !end.running && end.hooks === 0 && end.labelSrc === end.want && end.rec === '' && !end.lifted && Math.abs(end.arm - end.live) < 0.2, end);

  /* same album → no swap, just lift → move → drop */
  await page.evaluate(async () => (await window.__mod('/src/ui/player.ts')).next(true));
  await page.waitForTimeout(150);
  const same = await deckState(page);
  await page.waitForTimeout(900);
  const same2 = await deckState(page);
  check('same album: no swap — the arm lifts, moves and drops', !same.running && same.lifted && !same2.lifted && Math.abs(same2.arm - same2.live) < 0.2, { same, same2 });

  /* five rapid skips across albums during a swap */
  const order = ['Alpha', 'Gamma', 'Beta', 'Alpha', 'Delta Side A'];
  for (const a of order) {
    await page.evaluate(async ({ k, a }) => (await window.__mod('/src/ui/player.ts')).playList(window.__st.S.albumMap[k[a]].tracks, 0), { k: keys, a });
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(3000);
  const rapid = await deckState(page);
  check('five rapid skips: the last album ends on the platter, no leftover animation', rapid.album === 'Delta Side A' && !rapid.running && rapid.hooks === 0 && rapid.labelSrc === rapid.want && rapid.rec === '' && rapid.sleeve === '' && !rapid.lifted, rapid);
}

async function rateState(page) {
  return page.evaluate(() => {
    const a = document.getElementById('audio');
    return { rate: a.playbackRate, def: a.defaultPlaybackRate, pitch: a.preservesPitch, pref: window.__st.S.ttRpm, ms: window.__msRates ? window.__msRates.slice(-1)[0] : null };
  });
}

async function speedAndBrake({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 0);
  await page.evaluate(() => {
    window.__msRates = [];
    const orig = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
    navigator.mediaSession.setPositionState = (s) => {
      window.__msRates.push(s && s.playbackRate);
      return orig(s);
    };
  });
  await page.click('.tt-presets [data-rpm="45"]');
  await page.waitForTimeout(200);
  const r45 = await rateState(page);
  check('45 RPM → rate 45/33⅓ = 1.35, pitch not preserved', Math.abs(r45.rate - 1.35) < 0.001 && Math.abs(r45.def - 1.35) < 0.001 && r45.pitch === false, r45);
  check('Media Session position state reports the real playback rate', Math.abs(r45.ms - 1.35) < 0.001, r45.ms);
  const s45 = await sample(page, 1000);
  check('platter at 45 RPM turns ≈ 270°/s (still time-driven)', Math.abs(s45.degPerSec - 270) < 15, s45.degPerSec);
  await page.click('.tt-presets [data-rpm="78"]');
  const r78 = await rateState(page);
  await page.$eval('#ttRpm', (el) => {
    el.value = '16';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const r16 = await rateState(page);
  check('78 RPM → 2.34×, slider at 16 RPM → 0.48×', Math.abs(r78.rate - 78 / (100 / 3)) < 0.001 && Math.abs(r16.rate - 16 / (100 / 3)) < 0.001, [r78.rate, r16.rate]);
  await page.click('#ttRpmReset');
  const rr = await rateState(page);
  check('“↺ 33⅓” resets to 1×', Math.abs(rr.rate - 1) < 1e-6 && Math.abs(rr.pref - 100 / 3) < 0.01, rr);

  await page.click('.tt-presets [data-rpm="32"]');
  const r32 = await rateState(page);
  check('32 RPM preset → 32/33⅓ = 0.96×', Math.abs(r32.rate - 0.96) < 0.001 && r32.pitch === false, r32.rate);
  await page.click('.tt-presets [data-rpm="45"]');
  await page.click('#npMode'); /* leave turntable mode → Cover */
  await page.waitForTimeout(150);
  const cov = await rateState(page);
  const covRow = await page.evaluate(() => ({ speed: getComputedStyle(document.getElementById('ttSpeed')).display, brake: getComputedStyle(document.querySelector('.tt-brake')).display, read: document.getElementById('ttRpmRead').textContent }));
  check('leaving turntable mode keeps the chosen speed (45 RPM stays 1.35×)', Math.abs(cov.rate - 1.35) < 0.001 && cov.pitch === false && Math.abs(cov.pref - 45) < 0.01, cov);
  check('Cover mode shows the speed row too (without the deck-only stop/start switch)', covRow.speed === 'flex' && covRow.brake === 'none' && /^45 RPM/.test(covRow.read), covRow);
  await page.click('#npMode');
  await page.waitForTimeout(150);
  const back = await rateState(page);
  check('back in turntable mode: still 45', Math.abs(back.rate - 1.35) < 0.001, back.rate);
  await page.evaluate(async () => (await window.__mod('/src/ui/nowplaying.ts')).closeNowPlaying());
  await page.waitForTimeout(350);
  const closed = await rateState(page);
  const bar = await page.evaluate(() => ({ badge: document.querySelector('#btnSpeed b').textContent, on: document.getElementById('btnSpeed').classList.contains('on'), range: document.getElementById('spdRange').value }));
  check('minimising Now Playing keeps the speed too; the player bar shows it', Math.abs(closed.rate - 1.35) < 0.001 && bar.badge === '45' && bar.on && Number(bar.range) === 45, { closed, bar });

  /* The brake: Space (the app's keyboard shortcut) in turntable mode. */
  await openTurntable(page, keys, 'Alpha', 0);
  await page.click('#ttRpmReset');
  await page.click('#ttBrake'); /* the checkbox: stop/start effect back on */
  const brakeOn = await page.evaluate(() => ({ box: document.getElementById('ttBrake').checked, pref: window.__st.S.ttBrake }));
  check('the stop/start checkbox toggles the effect and saves it', brakeOn.box && brakeOn.pref === true, brakeOn);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const trace = page.evaluate(async () => {
    const a = document.getElementById('audio');
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 1300) {
      out.push([Math.round(performance.now() - t0), +a.playbackRate.toFixed(3), a.paused]);
      await new Promise((r) => setTimeout(r, 50));
    }
    return out;
  });
  await page.keyboard.press('Space');
  const tr = await trace;
  const mid = tr.filter((x) => x[0] > 150 && x[0] < 650);
  const firstPaused = tr.find((x) => x[2]);
  check('brake (Space): the rate ramps down while still playing…', mid.length > 3 && mid.every((x) => !x[2]) && mid[mid.length - 1][1] < mid[0][1] && mid[mid.length - 1][1] < 0.8, mid.map((x) => x[1]));
  check('…then it actually pauses (~0.8 s) and the rate is restored', firstPaused && firstPaused[0] >= 700 && firstPaused[0] <= 1100 && tr[tr.length - 1][1] === 1, { firstPaused, last: tr[tr.length - 1] });
  /* spin-up on play */
  const up = page.evaluate(async () => {
    const a = document.getElementById('audio');
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      out.push([Math.round(performance.now() - t0), +a.playbackRate.toFixed(3)]);
      await new Promise((r) => setTimeout(r, 40));
    }
    return out;
  });
  await page.keyboard.press('Space');
  const u = await up;
  check('play spins up from ~0.1× to full speed over ~0.4 s', u.some((x) => x[1] < 0.5) && u[u.length - 1][1] === 1, u.map((x) => x[1]));
  /* the Media Session / media-key path calls the element's pause() */
  await page.waitForTimeout(300);
  const ms = await page.evaluate(async () => {
    const a = document.getElementById('audio');
    a.pause(); /* exactly what the Media Session 'pause' handler does */
    await new Promise((r) => setTimeout(r, 300));
    const during = { paused: a.paused, rate: a.playbackRate };
    await new Promise((r) => setTimeout(r, 800));
    return { during, after: { paused: a.paused, rate: a.playbackRate } };
  });
  check('Media Session pause brakes too', !ms.during.paused && ms.during.rate < 1 && ms.after.paused && ms.after.rate === 1, ms);
  /* cover mode: pause is instant */
  await page.evaluate(async () => {
    await document.getElementById('audio').play();
  });
  await page.waitForTimeout(700);
  await page.click('#npMode');
  const inst = await page.evaluate(async () => {
    const a = document.getElementById('audio');
    a.pause();
    return a.paused;
  });
  check('outside turntable mode pause is instant (no brake)', inst === true, inst);
  await page.evaluate(async () => (await window.__mod('/src/ui/nowplaying.ts')).closeNowPlaying());
  await page.waitForTimeout(350);
}

/* ---------- follow-up: player bar, deck controls, Shift snapping ---------- */

async function playerBar({ page, keys, check }) {
  await page.evaluate(async (k) => {
    const np = await window.__mod('/src/ui/nowplaying.ts');
    if (np.nowPlayingOpen()) np.closeNowPlaying();
    (await window.__mod('/src/ui/player.ts')).playList(window.__st.S.albumMap[k.Alpha].tracks, 0);
  }, keys);
  await page.waitForTimeout(700);
  const lay = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const times = [...document.querySelectorAll('.pb-scrub .tt')];
    return { times: times.map((e) => [getComputedStyle(e).display, e.textContent]), wrap: Math.round(r(document.querySelector('.scrubwrap')).width), grid: Math.round(r(document.querySelector('.pb-scrub')).width) };
  });
  check('player bar: elapsed/remaining times show and the waveform spans the middle column', lay.times.every((t) => t[0] !== 'none' && /\d:\d\d/.test(t[1])) && lay.wrap > lay.grid - 90, lay);
  await page.$eval('#spdRange', (el) => {
    el.value = '44.7';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const a = await rateState(page);
  const badge = await page.$eval('#btnSpeed b', (b) => b.textContent);
  check('player-bar speed slider sets the speed (snapping onto 45)', Math.abs(a.rate - 1.35) < 0.001 && badge === '45', { rate: a.rate, badge });
  await page.click('#btnSpeed');
  const b = await rateState(page);
  await page.click('#btnSpeed');
  const c = await rateState(page);
  check('player-bar speed button: normal speed, then back to the chosen one', b.rate === 1 && Math.abs(c.rate - 1.35) < 0.001, [b.rate, c.rate]);
  await page.click('#btnSpeed'); /* leave it at 33⅓ */
}

async function deckControls({ page, keys, check }) {
  await openTurntable(page, keys, 'Alpha', 0);
  const marks = await page.evaluate(() => ({ labels: [...document.querySelectorAll('.tt-mark')].map((e) => e.textContent), led: document.getElementById('ttLed').textContent, ticks: document.querySelectorAll('.tt-tick').length }));
  check('pitch fader has a numbered RPM scale and a readout', ['78', '60', '45', '33⅓', '32', '16'].every((l) => marks.labels.includes(l)) && marks.led === '33⅓' && marks.ticks > 30, marks);
  await page.click('.tt-rpm45');
  const r45 = await rateState(page);
  const led45 = await page.$eval('#ttLed', (e) => e.textContent);
  await page.click('.tt-rpm33');
  const r33 = await rateState(page);
  check('the deck’s 33 / 45 buttons set the speed (readout follows)', Math.abs(r45.rate - 1.35) < 0.001 && led45 === '45' && r33.rate === 1, [r45.rate, led45, r33.rate]);
  /* drag the fader knob to the top: 78 */
  const geo = await page.evaluate(() => {
    const k = document.getElementById('ttFaderKnob').getBoundingClientRect();
    const t = document.getElementById('ttFader').getBoundingClientRect();
    return { kx: k.left + k.width / 2, ky: k.top + k.height / 2, top: t.top, bottom: t.bottom };
  });
  await page.mouse.move(geo.kx, geo.ky);
  await page.mouse.down();
  await page.mouse.move(geo.kx, geo.top - 20, { steps: 6 });
  await page.mouse.up();
  const top = await rateState(page);
  /* and down to where 45 sits — it snaps */
  const y45 = geo.bottom - ((45 - 16) / 62) * (geo.bottom - geo.top) + 2;
  await page.mouse.move(geo.kx, geo.top + 4);
  await page.mouse.down();
  await page.mouse.move(geo.kx, y45, { steps: 6 });
  await page.mouse.up();
  const mid = await rateState(page);
  check('dragging the pitch fader changes the speed (top = 78, snaps onto 45)', Math.abs(top.pref - 78) < 0.01 && Math.abs(mid.pref - 45) < 0.01 && Math.abs(mid.rate - 1.35) < 0.001, [top.pref, mid.pref]);
  const vol0 = await page.evaluate(() => window.__st.S.volume);
  await page.focus('#ttFaderKnob');
  await page.keyboard.press('ArrowUp');
  const kb = await rateState(page);
  const vol1 = await page.evaluate(() => window.__st.S.volume);
  check('fader knob keys: ↑ is +½ RPM (and does not touch the volume)', Math.abs(kb.pref - 45.5) < 0.01 && vol0 === vol1, [kb.pref, vol0, vol1]);
  await page.click('#ttRpmReset');
  /* START·STOP: brakes to a stop, then starts again */
  await page.evaluate(async () => (await window.__mod('/src/ui/turntable/speed.ts')).setBrake(true));
  await page.click('#ttStart');
  await page.waitForTimeout(300);
  const braking = await page.evaluate(() => ({ paused: document.getElementById('audio').paused, rate: document.getElementById('audio').playbackRate }));
  await page.waitForTimeout(800);
  const stopped = await page.evaluate(() => document.getElementById('audio').paused);
  await page.click('#ttStart');
  await page.waitForTimeout(600);
  const going = await page.evaluate(() => ({ paused: document.getElementById('audio').paused, rate: document.getElementById('audio').playbackRate }));
  check('START·STOP stops the record (with the brake) and starts it again', !braking.paused && braking.rate < 1 && stopped && !going.paused && going.rate === 1, { braking, stopped, going });
}

async function shiftDrag(page, targetFrac, shift) {
  const geo = await headGeometry(page);
  const armNow = await page.evaluate(async () => (await window.__mod('/src/ui/turntable/motion.ts')).currentArmAngle());
  const [x, y] = pointFor(geo, armNow, geo.outer + (geo.inner - geo.outer) * targetFrac);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(geo.head[0], geo.head[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(geo.head[0] + ((x - geo.head[0]) * i) / 8, geo.head[1] + ((y - geo.head[1]) * i) / 8);
  const label = await page.evaluate(() => ({ text: document.getElementById('ttSnap').textContent, shown: !document.getElementById('ttSnap').hidden, albumBands: document.querySelectorAll('#ttBands.tt-bands-album i').length }));
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(700);
  const after = await page.evaluate(async () => {
    const pb = await window.__mod('/src/ui/turntable/playback.ts');
    return { t: pb.getTime(), title: window.__st.S.current.title, label: !document.getElementById('ttSnap').hidden };
  });
  return { label, after };
}

async function shiftSnap({ page, keys, check }) {
  /* a cue side: Shift snaps the needle to where each song starts */
  await openTurntable(page, keys, 'Delta Side A', 0);
  await page.waitForTimeout(900);
  const cue = await shiftDrag(page, 468 / 720, true);
  check('cue side: Shift-drag snaps to the start of the nearest song (Delta Three at 8:00)', Math.abs(cue.after.t - 480) < 1 && cue.after.title === 'Delta Three' && /^3 · Delta Three/.test(cue.label.text), cue);
  const free = await shiftDrag(page, 300 / 720, false);
  check('cue side without Shift: free seek across the side (lands mid-song, label shows the song and time)', Math.abs(free.after.t - 300) < 8 && free.after.title === 'Delta Two' && /^Delta Two · \d:\d\d/.test(free.label.text), free);
  /* a normal album: Shift turns the record into the whole album */
  await openTurntable(page, keys, 'Alpha', 0);
  await page.waitForTimeout(900);
  const alb = await shiftDrag(page, 0.7, true);
  check('album: Shift-drag snaps across the album’s songs and plays the chosen one from its start', alb.after.title === 'Alpha Song 3' && alb.after.t < 2 && alb.label.albumBands === 2 && /^3 · Alpha Song 3/.test(alb.label.text) && !alb.after.label, alb);
  const plain = await shiftDrag(page, 0.5, false);
  check('album without Shift: the arm seeks within the song', plain.after.title === 'Alpha Song 3' && Math.abs(plain.after.t - 20) < 2 && /^0:\d\d \/ 0:40/.test(plain.label.text), plain);
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
    (await window.__mod('/src/ui/turntable/speed.ts')).setBrake(false); /* a plain pause; the brake has its own test */
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
