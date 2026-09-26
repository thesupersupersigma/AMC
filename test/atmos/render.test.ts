/* Gate 4: the renderer in headless Chromium (preinstalled Playwright
   browsers; nothing is downloaded). A synthetic object moves
   left → right → overhead; the checks run in an OfflineAudioContext
   (test/atmos/browser/render-checks.ts) and are asserted here.
   AMC-original test code. */

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assert, log, run, skip, test } from './util';

interface Point { t: number; levels: number[]; ildDb: number; itdMs: number }
interface Results {
  headphonesCrossing: number;
  speakersCrossing: number;
  headphones: Point[];
  speakers: Point[];
  multichannel: { mode: string; points: Point[] };
  multichannel8: { mode: string; points: Point[] };
  underrun: Point[];
  switching: { mode: string; clickAt1: number; clickAt2: number; clickBaseline: number; levels: number[][] };
}

/** The slice of Playwright this test uses (its types are not a project dependency). */
interface Page {
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  setContent(html: string): Promise<void>;
  addScriptTag(o: { content: string }): Promise<unknown>;
  evaluate(expr: string): Promise<unknown>;
}
interface Browser {
  newPage(): Promise<Page>;
  version(): string;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o: { headless: boolean; args?: string[] }): Promise<Browser> };
}

async function loadPlaywright(): Promise<Playwright | null> {
  const candidates = [process.env.AMC_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean) as string[];
  const req = createRequire(import.meta.url);
  for (const c of candidates) {
    try {
      return req(c);
    } catch {
      /* next */
    }
  }
  return null;
}

let results: Results | null = null;

async function getResults(): Promise<Results> {
  if (results) return results;
  const pw = await loadPlaywright();
  if (!pw) skip('playwright not found (set AMC_PLAYWRIGHT)');
  const bundle = await build({
    entryPoints: [resolve(process.cwd(), 'test/atmos/browser/render-checks.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });
  const browser = await pw!.chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(String(e)));
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    results = (await page.evaluate('atmosRunChecks()')) as Results;
    log(`Chromium ${browser.version()}${errors.length ? '; page errors: ' + errors.join(' | ') : ''}`);
    assert(errors.length === 0, 'no page errors');
  } finally {
    await browser.close();
  }
  return results!;
}

const fmt = (p: Point) => `t=${p.t}s ILD ${p.ildDb.toFixed(1)} dB ITD ${p.itdMs.toFixed(2)} ms`;
const db = (x: number) => 20 * Math.log10(x + 1e-12);

test('headphones: HRTF ITD/ILD follow the object left → right → overhead', async () => {
  const r = await getResults();
  const [left, mid, right, top] = r.headphones;
  log(r.headphones.map(fmt).join('; '));
  assert(left.ildDb > 6 && left.itdMs > 0.3, 'left: louder and earlier in the left ear');
  assert(right.ildDb < -6 && right.itdMs < -0.3, 'right: louder and earlier in the right ear');
  const lagMs = (r.headphonesCrossing - 1.0) * 1000;
  log(`sweep crosses the centre at ${r.headphonesCrossing.toFixed(3)} s (object at centre at 1.000 s): ` +
    `Chrome's HRTF panner trails a 180°/s sweep by ${lagMs.toFixed(0)} ms (its own azimuth smoothing)`);
  assert(lagMs > -10 && lagMs < 100, 'the binaural image tracks the moving object');
  assert(Math.abs(mid.ildDb) < 10, 'mid-sweep: between the ears');
  assert(Math.abs(top.ildDb) < 2 && Math.abs(top.itdMs) < 0.1, 'overhead: balanced ears, no ITD');
});

test('speakers: L→R amplitude pan, overhead centred with mild fold', async () => {
  const r = await getResults();
  log(r.speakers.map(fmt).join('; '));
  const [left, mid, right, top] = r.speakers;
  assert(left.levels[1] < left.levels[0] * 0.01, 'left: right channel silent');
  assert(right.levels[0] < right.levels[1] * 0.01, 'right: left channel silent');
  log(`sweep crosses the centre at ${r.speakersCrossing.toFixed(3)} s (object at centre at 1.000 s)`);
  assert(Math.abs(r.speakersCrossing - 1.0) < 0.006, 'amplitude pan is sample-synced with the keyframes');
  assert(Math.abs(mid.ildDb) < 1, 'mid-sweep: centred');
  assert(Math.abs(top.ildDb) < 0.5, 'overhead: centred');
  const leftPower = Math.hypot(...left.levels);
  const topPower = Math.hypot(...top.levels);
  const fold = db(topPower / leftPower);
  log(`overhead vs side level: ${fold.toFixed(2)} dB (height folded in at a mild gain)`);
  assert(fold < -0.5 && fold > -3, 'height folded in with a mild attenuation');
});

const names714 = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'];
const names71 = names714.slice(0, 8);

function dominant(levels: number[], names: string[]): string {
  const total = levels.reduce((a, v) => a + v * v, 0);
  return levels
    .map((v, i) => [names[i], (v * v) / total] as [string, number])
    .filter(([, share]) => share > 0.1)
    .map(([n, share]) => `${n} ${(share * 100).toFixed(0)}%`)
    .join(' ');
}

test('multichannel 7.1.4: energy lands in the right speakers', async () => {
  const r = await getResults();
  assert(r.multichannel.mode === 'multichannel', 'multichannel mode engaged with 12 output channels');
  const [left, , right, top] = r.multichannel.points;
  log(`left: ${dominant(left.levels, names714)} | right: ${dominant(right.levels, names714)} | overhead: ${dominant(top.levels, names714)}`);
  const share = (p: Point, idx: number[]) => idx.reduce((a, i) => a + p.levels[i] ** 2, 0) / p.levels.reduce((a, v) => a + v * v, 0);
  assert(share(left, [0, 6]) > 0.95 && left.levels[6] > left.levels[0], 'left: FL/SL, mostly SL');
  assert(share(right, [1, 7]) > 0.95 && right.levels[7] > right.levels[1], 'right: FR/SR, mostly SR');
  assert(share(top, [8, 9, 10, 11]) > 0.95, 'overhead: the four height speakers');
  assert(top.levels[3] === 0, 'objects never feed the LFE channel');
});

test('multichannel 7.1: no height layer, overhead folded to the ear ring', async () => {
  const r = await getResults();
  const [left, , right, top] = r.multichannel8.points;
  log(`left: ${dominant(left.levels, names71)} | right: ${dominant(right.levels, names71)} | overhead: ${dominant(top.levels, names71)}`);
  assert(left.levels[6] > 0.5 * Math.hypot(...left.levels) && right.levels[7] > 0.5 * Math.hypot(...right.levels), 'sides on SL/SR');
  assert(Math.hypot(...top.levels) > 0, 'overhead still audible');
});

test('sync: a 200 ms Worklet underrun shifts the automation with it', async () => {
  const r = await getResults();
  log(r.underrun.map(fmt).join('; '));
  const [hold, early, centre, late] = r.underrun;
  assert(hold.ildDb > 30, 'content 0.4 s: still hard left');
  assert(early.ildDb > 4, 'render 1.0 s = content 0.8 s: x = −0.4, ILD 5.9 dB expected (unsynced would be 0 dB)');
  assert(Math.abs(centre.ildDb) < 1.5, 'render 1.2 s = content 1.0 s: centred');
  assert(late.ildDb < -4, 'render 1.4 s = content 1.2 s: x = +0.4, ILD −5.9 dB expected');
});

test('setMode crossfades without a click', async () => {
  const r = await getResults();
  const s = r.switching;
  log(`roughness at switch 1: ${s.clickAt1.toFixed(2)}×, switch 2: ${s.clickAt2.toFixed(2)}×, elsewhere: ${s.clickBaseline.toFixed(2)}× the median; final mode ${s.mode}`);
  assert(s.clickAt1 < 2 && s.clickAt2 < 2, 'no discontinuity at either switch');
  assert(s.mode === 'headphones', 'mode ends as last set');
});

run();
