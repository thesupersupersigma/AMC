/* Shared test harness: starts the Vite dev server, launches the
   preinstalled headless Chromium (never `playwright install`), loads the
   fixture library through the read-only webkitdirectory fallback, and
   exposes the app's own modules to page.evaluate via dynamic import —
   Vite serves them at their source URLs, so the test sees the same
   module instances the app runs.

   Needs NODE_PATH to reach the global playwright package, e.g.
   NODE_PATH=/opt/node22/lib/node_modules node tests/turntable-art/run.mjs */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export async function startServer(port = 5199) {
  /* AMC_URL points the tests at a dev server that is already running. */
  if (process.env.AMC_URL) return { url: process.env.AMC_URL, stop: () => undefined, log: () => '' };
  const proc = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    /* its own process group, so stop() takes vite down with npx */
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    proc.stdout.destroy();
    proc.stderr.destroy();
    proc.unref();
  };
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { url, stop, log: () => log };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  stop();
  throw new Error('vite did not start:\n' + log);
}

export async function launch({ width = 1365, height = 611, reducedMotion = 'no-preference' } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion });
  /* __mod(path) imports the exact module URL the app itself loaded (a dev
     server that saw edits serves HMR-stamped URLs, and a bare path would
     then be a second, disconnected module instance). */
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
  const page = await context.newPage();
  const errors = [];
  if (process.env.DEBUG_CONSOLE) page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));
  page.on('console', (m) => {
    /* A deliberately stubbed 4xx/5xx shows up as a resource-load console
       line; that is the test working, not the app failing. */
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
  return { browser, context, page, errors };
}

/** Opens AMC and loads a folder through the webkitdirectory input.
    waitForFunction predicates must be synchronous, so the state module is
    parked on window.__st first. */
export async function loadLibrary(page, url, dir, expectTracks, expectAlbums = 4) {
  await page.goto(url);
  await page.waitForSelector('#picker', { state: 'attached' });
  await page.evaluate(async () => {
    window.__st = await window.__mod('/src/state.ts');
  });
  await page.setInputFiles('#picker', dir);
  await page.waitForFunction(
    (n) => {
      const m = window.__st;
      return m.S.tracks.length >= n[0] && m.S.albums.length >= n[1] && !m.S.scanning;
    },
    [expectTracks, expectAlbums],
    { timeout: 60000 }
  );
  /* covers are decoded in the background after the scan */
  await page.waitForFunction(() => {
    const m = window.__st;
    return m.S.albums.filter((a) => m.haveCover(a.key)).length >= 3;
  }, null, { timeout: 30000 });
}

/** Albums by display name → key. */
export async function albumKeys(page) {
  return page.evaluate(async () => {
    const m = await window.__mod('/src/state.ts');
    const out = {};
    for (const al of m.S.albums) out[al.album] = al.key;
    return out;
  });
}

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  };
  return { check, results, failed: () => results.filter((r) => !r.ok) };
}
