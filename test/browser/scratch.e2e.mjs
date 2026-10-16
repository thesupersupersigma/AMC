/* The turntable's hand-on-the-record scratching, in the real app (dev
   server, headless Chromium):

     • window decoders: a few seconds cut from the middle of FLAC, WAV,
       CBR and VBR MP3 (and AAC where this Chromium decodes it) land at the
       right source time — measured on a repeating chirp whose frequency
       says where in the file it is
     • a paused deck: turning the record forward one full circle cues the
       playback 1.8 s later (33⅓ RPM = 200°/s), backward half a circle
       0.9 s earlier; the voice is heard at the hand's speed and goes
       backwards with it
     • a running deck: the playback is held quiet while the hand is down,
       and comes back at speed and volume on release
     • Ogg, and ALAC on the software engine (no window decoder here): the
       playback-rate fallback

     npm run dev
     AMC_URL=http://localhost:5173 node --test test/browser/scratch.e2e.mjs

   Needs ffmpeg (AMC_FFMPEG or on PATH). Uses the dev-only window.__amcDebug
   handle. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../helpers/release-library.mjs';

const BASE = process.env.AMC_URL || 'http://localhost:5173';
const FFMPEG = findFfmpeg();
const skip = !FFMPEG && 'needs ffmpeg';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

let browser;
let page;
let tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (label, v) => console.log('# ' + label + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
const D = (fn, arg) => page.evaluate(fn, arg);

/* The chirp: frequency 200 + 50·τ Hz with τ = t mod 20, so a measured
   frequency says the time to within a few ms (inside a known 20 s span). */
const CHIRP = 'sin(2*PI*(200*mod(t\\,20)+25*mod(t\\,20)*mod(t\\,20)))';

function makeLibrary(dir) {
  const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  const tags = (title, album, n) => ['-metadata', 'title=' + title, '-metadata', 'artist=Scratch', '-metadata', 'album_artist=Scratch', '-metadata', 'album=' + album, '-metadata', 'track=' + n];
  const chirp = join(dir, 'Scratch', 'Chirps');
  mkdirSync(chirp, { recursive: true });
  const src = ['-f', 'lavfi', '-i', `aevalsrc=${CHIRP}:s=44100:d=60`, '-ac', '2'];
  ff([...src, '-c:a', 'flac', '-sample_fmt', 's32', ...tags('Chirp FLAC', 'Chirps', 1), join(chirp, '01 flac.flac')]);
  ff([...src, '-c:a', 'pcm_s16le', ...tags('Chirp WAV', 'Chirps', 2), join(chirp, '02 wav.wav')]);
  ff([...src, '-c:a', 'libmp3lame', '-b:a', '192k', ...tags('Chirp MP3 CBR', 'Chirps', 3), join(chirp, '03 cbr.mp3')]);
  ff([...src, '-c:a', 'libmp3lame', '-q:a', '2', ...tags('Chirp MP3 VBR', 'Chirps', 4), join(chirp, '04 vbr.mp3')]);
  ff([...src, '-c:a', 'aac', '-b:a', '160k', ...tags('Chirp AAC', 'Chirps', 5), join(chirp, '05 aac.m4a')]);
  const tone = join(dir, 'Scratch', 'Tone');
  mkdirSync(tone, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=60', '-ac', '2', '-c:a', 'flac', ...tags('Tone', 'Tone', 1), join(tone, '01 tone.flac')]);
  const ogg = join(dir, 'Scratch', 'Ogg');
  mkdirSync(ogg, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=60', '-ac', '2', '-c:a', 'libvorbis', ...tags('Ogg Tone', 'Ogg', 1), join(ogg, '01 tone.ogg')]);
  const alac = join(dir, 'Scratch', 'ALAC');
  mkdirSync(alac, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=60', '-ac', '2', '-c:a', 'alac', ...tags('ALAC Tone', 'ALAC', 1), join(alac, '01 tone.m4a')]);
}

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'amc-scratch-'));
  makeLibrary(join(tmp, 'Music'));
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 611 }, deviceScaleFactor: 1 });
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
    /** A pure tone's frequency: the median period between rising zero
        crossings. */
    window.__freq = (x, rate) => {
      const at = [];
      for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) at.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
      if (at.length < 3) return 0;
      const d = [];
      for (let i = 1; i < at.length; i++) d.push(at[i] - at[i - 1]);
      d.sort((a, b) => a - b);
      return rate / d[d.length >> 1];
    };
  });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__amcDebug);
  await page.setInputFiles('#picker', join(tmp, 'Music'));
  await page.waitForFunction(() => window.__amcDebug.S.tracks.length >= 8 && !window.__amcDebug.S.scanning, null, { timeout: 60000 });
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('window decoders land at the right source time', { skip }, async () => {
  const out = await D(async () => {
    const { openWindowSource } = await window.__mod('/src/audio/scratch/window.ts');
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const res = {};
    const names = { 'Chirp FLAC': '01 flac.flac', 'Chirp WAV': '02 wav.wav', 'Chirp MP3 CBR': '03 cbr.mp3', 'Chirp MP3 VBR': '04 vbr.mp3', 'Chirp AAC': '05 aac.m4a' };
    for (const [title, name] of Object.entries(names)) {
      const t = window.__amcDebug.S.tracks.find((x) => x.path.endsWith('/' + name));
      const src = await openWindowSource(t.file, 60, ctx).catch((e) => String(e));
      if (!src || typeof src === 'string') {
        res[title] = { kind: null, err: src };
        continue;
      }
      const errs = [];
      for (const from of [7, 33, 51.5]) {
        const w = await src.decode(from, from + 6);
        if (!w) {
          errs.push(null);
          continue;
        }
        /* measure 0.5 s in, where the chirp is clean */
        const at = Math.round(0.5 * w.rate);
        const f = window.__freq(w.planes[0].subarray(at, at + 2048), w.rate);
        const tau = (f - 200) / 50;
        const truth = Math.floor((w.start + 0.5) / 20) * 20 + tau;
        /* the frequency is the one at the middle of the measured block */
        const claimed = w.start + (at + 1024) / w.rate;
        errs.push({ start: +w.start.toFixed(3), err: +(claimed - truth).toFixed(4), secs: +(w.planes[0].length / w.rate).toFixed(2) });
      }
      res[title] = { kind: src.kind, errs };
    }
    return res;
  });
  report('windows', out);
  for (const [title, tol] of [['Chirp FLAC', 0.01], ['Chirp WAV', 0.01], ['Chirp MP3 CBR', 0.01], ['Chirp MP3 VBR', 0.01]]) {
    const r = out[title];
    assert.ok(r.kind, title + ' has a window source');
    for (const e of r.errs) {
      assert.ok(e, title + ' decoded every window');
      assert.ok(Math.abs(e.err) < tol, `${title} window at ${e.start}: off by ${e.err} s`);
      assert.ok(e.secs >= 5.5, `${title} window covers the asked span (${e.secs} s)`);
    }
  }
  /* AAC: only where this Chromium has an AAC decoder; if it decodes, it
     must be in the right place. */
  const aac = out['Chirp AAC'];
  if (aac.kind && aac.errs.every(Boolean)) for (const e of aac.errs) assert.ok(Math.abs(e.err) < 0.06, 'AAC window off by ' + e.err);
});

/* ---------- the deck ---------- */

async function openDeck(path) {
  await D((p) => {
    const A = window.__amcDebug;
    const tr = A.S.tracks.find((x) => x.path.endsWith(p));
    const album = A.S.albums.find((al) => al.tracks.includes(tr));
    A.playList(album.tracks, album.tracks.indexOf(tr));
  }, path);
  await page.waitForFunction(() => !window.__amcDebug.media.paused && window.__amcDebug.media.currentTime > 0.2);
  if (await page.isHidden('#npview')) {
    await page.click('#pbArt');
    await page.waitForSelector('#npview:not([hidden])');
  }
  await D(() => {
    if (window.__amcDebug.S.npMode !== 'turntable') document.getElementById('npMode').click();
  });
  await page.waitForSelector('#tt', { state: 'visible' });
  /* let a record swap finish */
  await D(async () => {
    window.__swap = await window.__mod('/src/ui/turntable/swap.ts');
  });
  await page.waitForFunction(() => !window.__swap.swapRunning());
  await sleep(300);
}

async function recordGeom() {
  return D(() => {
    const b = document.getElementById('ttRec').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, rad: b.width * 0.36 };
  });
}

/* waitForFunction needs a synchronous predicate (a Promise is truthy) */
async function settled() {
  await D(async () => {
    window.__scratch = await window.__mod('/src/ui/turntable/scratch.ts');
  });
  await page.waitForFunction(() => window.__scratch.scratchDebug().phase === 'none', null, { timeout: 3000 });
}

const scratchState = () =>
  D(async () => {
    const m = await window.__mod('/src/ui/turntable/scratch.ts');
    const s = m.scratchDebug();
    const v = s.voice ? s.voice.debug() : null;
    return { phase: s.phase, mode: s.mode, shown: s.shown, voice: v && { pos: v.pos, vel: v.vel, have: v.have, mode: v.mode, kind: v.kind } };
  });

/** Taps the voice output: returns a reader of its current frequency. */
async function tapVoice() {
  await D(async () => {
    const m = await window.__mod('/src/ui/turntable/scratch.ts');
    const v = m.scratchDebug().voice;
    if (!v || window.__voiceTap) return;
    const node = v.debug().node;
    const an = v.ctx.createAnalyser();
    an.fftSize = 4096;
    node.connect(an);
    window.__voiceTap = { an, rate: v.ctx.sampleRate };
  });
}
const voiceFreq = () =>
  D(() => {
    const T = window.__voiceTap;
    if (!T) return null;
    const x = new Float32Array(T.an.fftSize);
    T.an.getFloatTimeDomainData(x);
    let peak = 0;
    for (const s of x) peak = Math.max(peak, Math.abs(s));
    return { hz: +window.__freq(x, T.rate).toFixed(1), peak: +peak.toFixed(3) };
  });

/** Turns the record by `deg` degrees (clockwise = forward) over `ms`,
    starting from 9 o'clock; holds still `holdMs` before letting go.
    `during` runs at the midpoint. */
async function turn(deg, ms, { holdMs = 200, during = null } = {}) {
  const g = await recordGeom();
  const a0 = Math.PI;
  const at = (a) => [g.x + g.rad * Math.cos(a), g.y + g.rad * Math.sin(a)];
  await page.mouse.move(...at(a0));
  await page.mouse.down();
  const steps = Math.max(2, Math.round(ms / 16));
  let mid = null;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(...at(a0 + ((deg * Math.PI) / 180) * (i / steps)));
    await sleep(ms / steps);
    if (during && i === Math.round(steps / 2)) mid = await during();
  }
  await sleep(holdMs);
  const still = holdMs ? await during?.() : null;
  await page.mouse.up();
  return { mid, still };
}

/** A steady hand, driven from inside the page (Playwright's mouse arrives
    unevenly): turns the record at exactly `degPerSec` for `ms`, then
    measures the voice's pitch and speed while still turning. */
async function steadyTurn(degPerSec, ms, jitter = false) {
  return D(
    ([dps, dur, jit]) =>
      new Promise((resolve) => {
        const rec = document.getElementById('ttRec');
        const b = rec.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const rad = b.width * 0.36;
        /* jitter: whole-pixel positions at uneven 4–24 ms gaps, as a real
           mouse delivers them */
        const px = (v) => (jit ? Math.round(v) : v);
        const ev = (type, a) =>
          rec.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: px(cx + rad * Math.cos(a)), clientY: px(cy + rad * Math.sin(a)) }));
        const a0 = Math.PI;
        ev('pointerdown', a0);
        const t0 = performance.now();
        let out = null;
        /* pitch snapshots from 40% of the way on, ~60 ms apart */
        const hz = [];
        let nextSnap = dur * 0.4;
        /* (a fixed pseudo-random sequence, so every run is the same) */
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const gap = () => (jit ? 4 + rnd() * 20 : 8);
        const step = async () => {
          const t = performance.now() - t0;
          ev('pointermove', a0 + ((dps * Math.PI) / 180) * (t / 1000));
          if (t > nextSnap && t < dur - 40) {
            nextSnap = t + 60;
            const T = window.__voiceTap;
            const x = new Float32Array(2048);
            T.an.getFloatTimeDomainData(x);
            hz.push(window.__freq(x, T.rate));
          }
          if (!out && t > dur * 0.7) {
            const m = await window.__mod('/src/ui/turntable/scratch.ts');
            const v = m.scratchDebug().voice.debug();
            const T = window.__voiceTap;
            const x = new Float32Array(T.an.fftSize);
            T.an.getFloatTimeDomainData(x);
            let peak = 0;
            for (const s of x) peak = Math.max(peak, Math.abs(s));
            out = { vel: v.vel, hz: window.__freq(x, T.rate), peak };
          }
          if (t < dur) setTimeout(step, gap());
          else {
            ev('pointerup', a0 + ((dps * Math.PI) / 180) * (t / 1000));
            out.wobble = hz.length ? Math.max(...hz) / Math.min(...hz) - 1 : null;
            out.snaps = hz.length;
            resolve(out);
          }
        };
        setTimeout(step, gap());
      }),
    [degPerSec, ms, jitter]
  );
}

async function pauseDeck() {
  await D(() => {
    window.__amcDebug.S.ttBrake = false;
  });
  await D(async () => {
    const sp = await window.__mod('/src/ui/turntable/speed.ts');
    sp.setBrake(false);
    window.__amcDebug.media.pause();
  });
  await page.waitForFunction(() => window.__amcDebug.media.paused);
}

test('a stopped deck: turning the record cues it, the voice follows the hand both ways', { skip }, async () => {
  await openDeck('Tone/01 tone.flac');
  await pauseDeck();
  await D(() => (window.__amcDebug.media.currentTime = 20));
  await sleep(300);
  /* hover first, as a mouse does: the voice warms up */
  const g = await recordGeom();
  await page.mouse.move(g.x - g.rad, g.y);
  await sleep(400);
  await tapVoice();

  const t0 = await D(() => window.__amcDebug.media.currentTime);
  /* forward one full turn in 1 s = 1.8 s of record per second */
  const fwd = await turn(360, 1000, { holdMs: 300, during: async () => ({ ...(await scratchState()), f: await voiceFreq() }) });
  await settled();
  await sleep(200);
  const t1 = await D(() => ({ ct: window.__amcDebug.media.currentTime, paused: window.__amcDebug.media.paused, vol: window.__amcDebug.media.volume }));
  report('forward', { t0, fwd, t1 });
  await tapVoice();
  assert.ok(Math.abs(t1.ct - (t0 + 1.8)) < 0.12, `a full turn forward cues +1.8 s (got ${(t1.ct - t0).toFixed(3)})`);
  assert.equal(t1.paused, true, 'a stopped deck stays stopped');
  assert.equal(fwd.mid.mode, 'voice', 'the scratch voice plays');
  assert.ok(fwd.mid.voice.have, 'decoded audio under the needle');
  assert.ok(fwd.mid.voice.vel > 0.4, 'the voice moves forward with the hand (' + fwd.mid.voice.vel + ')');
  assert.ok(fwd.still.f.peak < 0.03, 'a held record is silent (' + fwd.still.f.peak + ')');

  /* backward half a turn in 0.5 s */
  const back = await turn(-180, 500, { holdMs: 300, during: async () => ({ ...(await scratchState()), f: await voiceFreq() }) });
  await settled();
  await sleep(200);
  const t2 = await D(() => window.__amcDebug.media.currentTime);
  report('backward', { back, t2 });
  assert.ok(Math.abs(t2 - (t1.ct - 0.9)) < 0.12, `half a turn back cues −0.9 s (got ${(t2 - t1.ct).toFixed(3)})`);
  assert.ok(back.mid.voice.vel < -0.4, 'the voice runs backwards (' + back.mid.voice.vel + ')');

  /* Pitch follows speed, both ways, with a steady hand: 440 Hz × speed. */
  await settled();
  const pitch = {};
  /* (1200°/s = 6×: read from the pre-filtered copies) */
  for (const dps of [360, -360, 144, 1200]) {
    pitch[dps] = await steadyTurn(dps, 900);
    await settled();
  }
  report('pitch', pitch);
  for (const [dps, r] of Object.entries(pitch)) {
    const speed = Number(dps) / 200;
    assert.ok(Math.abs(r.vel - speed) < 0.1 * Math.abs(speed), `${dps}°/s: the voice runs at ${speed}× (got ${r.vel.toFixed(3)})`);
    assert.ok(Math.abs(r.hz - 440 * Math.abs(speed)) < 0.05 * 440 * Math.abs(speed), `${dps}°/s: ${(440 * Math.abs(speed)).toFixed(0)} Hz (got ${r.hz.toFixed(1)})`);
    /* (the test tone peaks at 0.125) */
    assert.ok(r.peak > 0.05, `${dps}°/s: heard (${r.peak.toFixed(3)})`);
  }

  /* No buzz: a steady turn with a real mouse's uneven, whole-pixel events
     holds a steady pitch (the record's weight irons out the steps). */
  const rough = {};
  for (const dps of [360, -270, 120]) {
    rough[dps] = await steadyTurn(dps, 1400, true);
    await settled();
  }
  report('uneven hand', rough);
  for (const [dps, r] of Object.entries(rough)) {
    assert.ok(r.snaps >= 8, 'enough snapshots');
    /* (the previous, buzzing version measured 18–34% here; a slow drag
       moves only a pixel or two per event, so it keeps a little more) */
    const tol = Math.abs(Number(dps)) < 200 ? 0.1 : 0.04;
    assert.ok(r.wobble < tol, `${dps}°/s with an uneven hand: pitch steady to ${(r.wobble * 100).toFixed(1)}%`);
  }
});

test('a running deck: quiet under the hand, back at speed and volume on release', { skip }, async () => {
  await D(() => window.__amcDebug.media.play());
  await page.waitForFunction(() => !window.__amcDebug.media.paused);
  await sleep(500);
  const before = await D(() => ({ ct: window.__amcDebug.media.currentTime, vol: window.__amcDebug.media.volume, rate: window.__amcDebug.media.playbackRate }));
  const held = await turn(90, 300, { holdMs: 600, during: async () => ({ ...(await scratchState()), vol: await D(() => window.__amcDebug.media.volume) }) });
  await settled();
  await sleep(400);
  const after = await D(() => ({ ct: window.__amcDebug.media.currentTime, vol: window.__amcDebug.media.volume, rate: window.__amcDebug.media.playbackRate, paused: window.__amcDebug.media.paused }));
  report('running', { before, held, after });
  assert.equal(held.still.mode, 'voice');
  assert.ok(Math.abs(held.still.voice.vel) < 0.02, 'a held record stands still');
  assert.equal(held.still.vol, 0, 'the playback is quiet while held');
  assert.equal(after.paused, false, 'still playing after release');
  assert.ok(Math.abs(after.vol - before.vol) < 1e-6, 'volume restored');
  assert.ok(Math.abs(after.rate - before.rate) < 1e-6, 'rate restored');
  /* +0.45 s from the turn, the time held (~0.9 s) adds almost nothing, then ~0.75 s of playing */
  const moved = after.ct - before.ct;
  assert.ok(moved > 0.8 && moved < 2.4, 'the playback picked up where the record was (' + moved.toFixed(3) + ')');
});

test('caught again on its way back to speed: still heard, and it all comes back', { skip }, async () => {
  const g = await recordGeom();
  const at = (a) => [g.x + g.rad * Math.cos(a), g.y + g.rad * Math.sin(a)];
  const back = async (from, to) => {
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(...at(from + ((to - from) * i) / 12));
      await sleep(16);
    }
  };
  await page.mouse.move(...at(Math.PI));
  await page.mouse.down();
  await back(Math.PI, Math.PI + 1);
  await page.mouse.up();
  /* the motor is taking it back up: grab it again and push it back */
  await sleep(120);
  await page.mouse.down();
  await back(Math.PI + 1, Math.PI);
  const mid = await scratchState();
  await page.mouse.up();
  await settled();
  await sleep(300);
  const after = await D(() => ({ vol: window.__amcDebug.media.volume, rate: window.__amcDebug.media.playbackRate, paused: window.__amcDebug.media.paused }));
  report('regrab', { mid, after });
  assert.equal(mid.phase, 'hold');
  assert.equal(mid.mode, 'voice');
  assert.equal(after.paused, false);
  assert.ok(Math.abs(after.vol - 1) < 1e-6 && Math.abs(after.rate - 1) < 1e-6);
});

test('Ogg has no window decoder: the playback-rate fallback', { skip }, async () => {
  await openDeck('Ogg/01 tone.ogg');
  await sleep(300);
  const before = await D(() => window.__amcDebug.media.currentTime);
  const r = await turn(360, 1000, { during: scratchState });
  await settled();
  await sleep(300);
  const after = await D(() => ({ ct: window.__amcDebug.media.currentTime, rate: window.__amcDebug.media.playbackRate, vol: window.__amcDebug.media.volume, paused: window.__amcDebug.media.paused }));
  report('ogg', { before, r, after });
  assert.equal(r.mid.mode, 'rate');
  assert.equal(r.mid.voice.kind, 'none');
  assert.equal(after.paused, false);
  assert.ok(Math.abs(after.rate - 1) < 1e-6);
  assert.ok(after.vol > 0.5);
  assert.deepEqual(pageErrors, []);
});

test('ALAC on the software engine: scratches by rate when WebCodecs has no ALAC', { skip }, async () => {
  await openDeck('ALAC/01 tone.m4a');
  const path = await D(() => window.__amcDebug.media.path);
  await sleep(300);
  const before = await D(() => window.__amcDebug.media.currentTime);
  const r = await turn(-360, 800, { during: scratchState });
  await settled();
  await sleep(300);
  const after = await D(() => ({ ct: window.__amcDebug.media.currentTime, rate: window.__amcDebug.media.playbackRate, vol: window.__amcDebug.media.volume, paused: window.__amcDebug.media.paused }));
  report('alac', { path, before, r, after });
  assert.ok(['rate', 'voice'].includes(r.mid.mode));
  assert.equal(after.paused, false);
  assert.ok(Math.abs(after.rate - 1) < 1e-6);
  assert.ok(after.vol > 0.5);
  /* a full turn back: ~1.8 s earlier, plus what played since */
  assert.ok(after.ct < before + 0.2, 'wound back (' + before.toFixed(2) + ' → ' + after.ct.toFixed(2) + ')');
  assert.deepEqual(pageErrors, []);
});

test('the version tag: tiny, bottom-right, the inverse of what is behind it', { skip }, async () => {
  const tag = await D(() => {
    const el = document.getElementById('amcVersion');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return { text: el.textContent, blend: cs.mixBlendMode, color: cs.color, size: cs.fontSize, right: innerWidth - b.right, bottom: innerHeight - b.bottom, events: cs.pointerEvents };
  });
  report('version tag', tag);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(tag.text, 'v' + pkg.version);
  assert.equal(tag.blend, 'difference');
  assert.equal(tag.color, 'rgb(255, 255, 255)');
  assert.equal(tag.events, 'none');
  assert.ok(tag.right < 8 && tag.bottom < 8, 'in the corner');
  await page.screenshot({ path: process.env.AMC_SHOT || join(tmpdir(), 'amc-version-tag.png'), clip: { x: 1265, y: 571, width: 100, height: 40 } });
});
