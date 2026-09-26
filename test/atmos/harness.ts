/* Gate 5 contract harness: simulates exactly what the engine will do with an
   E-AC-3 JOC track, per src/audio/spatial/contract.ts.

     Node (this file)   reads the MP4 sample table (never the whole file),
                        slices each access unit, and decodes the 5.1 core
                        with the system ffmpeg (as the engine's FFmpeg would).
     Worker (Chromium)  imports register.ts, gets the processor factory from
                        the registry → maxChannels → process() per packet,
                        transfers each block back; reset() on a seek.
                        (test/atmos/browser/harness-worker.ts)
     Main (Chromium)    gets the renderer factory from the registry, plays
                        the blocks back to back as the Worklet would,
                        relays keyframes stamped with each block's start
                        frame, calls setPlayedFrame as playback advances,
                        reset() on the seek; renders offline and posts the
                        result back as WAV. (test/atmos/browser/harness-page.ts)

   Usage: node scripts/atmos-test.mjs harness
   Writes test/private/atmos-headphones.wav (and atmos-speakers.wav).
   AMC-original test code. */

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpatialOutputMode } from '../../src/audio/spatial/contract';
import { Mp4File } from './mp4';
import { ffmpegDecode, realFile } from './util';

const FRAMES = 1536;
const SR = 48000;

export interface HarnessMode {
  mode: SpatialOutputMode;
  outChannels: number;
  /** File name under test/private/ to write the render to. */
  wav?: string;
}

export interface HarnessRun {
  maxChannels: number;
  realm: { hasWindow: boolean; hasDocument: boolean };
  worker: { processMs: number; wallMs: number; stats: Record<string, unknown> };
  blocks: number;
  keyframes: number;
  seeks: number[];
  totalFrames: number;
  bedLayout: string[];
  coreLoudness: number;
  core51Loudness: number;
  corePeak: number;
  results: {
    mode: string;
    outChannels: number;
    renderMs: number;
    loudness: number;
    peak: number;
    nan: number;
    clipped: number;
    minSecondRms: number;
    secondRms: number[];
  }[];
}

/** Packet indices to play: [from, to) seconds, a seek (-1), then more. */
export function planFor(segments: [number, number][]): number[] {
  const plan: number[] = [];
  segments.forEach(([from, to], i) => {
    if (i > 0) plan.push(-1);
    for (let k = Math.floor((from * SR) / FRAMES); k < Math.floor((to * SR) / FRAMES); k++) plan.push(k);
  });
  return plan;
}

interface Route {
  request(): { url(): string; postDataBuffer(): Buffer | null };
  fulfill(o: { status?: number; contentType?: string; body?: string | Buffer }): Promise<void>;
}
interface Page {
  route(url: string, handler: (route: Route) => void | Promise<void>): Promise<void>;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  goto(url: string): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
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

export function loadPlaywright(): Playwright | null {
  const req = createRequire(import.meta.url);
  for (const c of [process.env.AMC_PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean) as string[]) {
    try {
      return req(c);
    } catch {
      /* next */
    }
  }
  return null;
}

async function bundle(entry: string): Promise<string> {
  const r = await build({
    entryPoints: [resolve(process.cwd(), entry)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });
  return r.outputFiles[0].text;
}

export async function runHarness(plan: number[], modes: HarnessMode[], log: (s: string) => void = () => {}): Promise<HarnessRun & { chromium: string }> {
  const pw = loadPlaywright();
  if (!pw) throw new Error('playwright not found (set AMC_PLAYWRIGHT)');

  // Access units, sliced one by one from the MP4 (File.slice in the app).
  const mp4 = new Mp4File(realFile);
  const track = mp4.ec3Track();
  const last = Math.max(...plan);
  const chunks: Buffer[] = [];
  const offsets = [0];
  for (let k = 0; k <= last; k++) {
    const s = mp4.sample(track, k);
    chunks.push(Buffer.from(s.buffer, s.byteOffset, s.byteLength));
    offsets.push(offsets[k] + s.byteLength);
  }
  mp4.close();
  const packets = Buffer.concat(chunks as unknown as Uint8Array[]);

  // The 5.1 core, decoded by the system ffmpeg (FFmpeg order FL FR FC LFE SL SR).
  const seconds = Math.ceil(((last + 1) * FRAMES) / SR) + 1;
  const { pcm } = ffmpegDecode(realFile, seconds);
  const needed = (last + 1) * FRAMES * 6;
  const core = new Float32Array(needed);
  core.set(pcm.subarray(0, Math.min(needed, pcm.length)));
  log(`${last + 1} access units (${(((last + 1) * FRAMES) / SR).toFixed(1)} s) sliced from the MP4; core decoded by ffmpeg`);

  const [pageJs, workerJs] = await Promise.all([bundle('test/atmos/browser/harness-page.ts'), bundle('test/atmos/browser/harness-worker.ts')]);
  const index = JSON.stringify({ offsets, dec3: Buffer.from(track.dec3).toString('base64') });

  const browser = await pw.chromium.launch({ headless: true, args: ['--js-flags=--max-old-space-size=4096'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(String(e)));
    page.on('console', (m: { type(): string; text(): string }) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.route('http://atmos.test/**', async (route: Route) => {
      const url = new URL(route.request().url());
      const js = 'application/javascript';
      switch (url.pathname) {
        case '/index.html':
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/page.js"></script>' });
        case '/page.js':
          return route.fulfill({ contentType: js, body: pageJs });
        case '/worker.js':
          return route.fulfill({ contentType: js, body: workerJs });
        case '/data/index.json':
          return route.fulfill({ contentType: 'application/json', body: index });
        case '/data/packets.bin':
          return route.fulfill({ contentType: 'application/octet-stream', body: packets });
        case '/data/core.f32':
          return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(core.buffer, core.byteOffset, core.byteLength) });
        case '/upload': {
          const name = url.searchParams.get('name') || 'out.wav';
          const body = route.request().postDataBuffer();
          if (!body || /[/\\]/.test(name)) return route.fulfill({ status: 400 });
          const path = resolve(process.cwd(), 'test/private', name);
          writeFileSync(path, body as unknown as Uint8Array);
          log(`wrote ${path} (${(body.byteLength / 1048576).toFixed(1)} MB)`);
          return route.fulfill({ status: 200, body: 'ok' });
        }
        default:
          return route.fulfill({ status: 404 });
      }
    });
    await page.goto('http://atmos.test/index.html');
    const result = (await page.evaluate(`atmosHarness(${JSON.stringify({ plan, modes })})`)) as HarnessRun;
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    return { ...result, chromium: browser.version() };
  } finally {
    await browser.close();
  }
}
