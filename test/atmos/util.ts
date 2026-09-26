/* Shared test helpers: a tiny test registry, file locations, and the system
   ffmpeg for core-decode reference output. AMC-original test code. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

/** The owner's real Atmos track. Never committed (test/private/ is ignored). */
export const realFile = process.env.AMC_ATMOS_FILE || resolve(root, 'test/private/get-on-the-floor.m4a');
export const haveRealFile = existsSync(realFile);

/** Output of scripts/atmos-cavern-ref.sh (Cavern's own decode, for comparison). */
export const cavernRef = process.env.AMC_CAVERN_REF || '/tmp/cavref/out';
export const haveCavernRef = existsSync(resolve(cavernRef, 'frames.jsonl'));

export function findFfmpeg(): string | null {
  const candidates = [
    process.env.AMC_FFMPEG,
    'ffmpeg',
    '/tmp/tools/node_modules/@ffmpeg-installer/linux-x64/ffmpeg',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/** Decode the first `seconds` of `file` to interleaved f32 with ffmpeg. */
export function ffmpegDecode(file: string, seconds: number, extraArgs: string[] = []): { pcm: Float32Array; channels: number } {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found (set AMC_FFMPEG)');
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', ...extraArgs, '-i', file, '-t', String(seconds), '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
    { maxBuffer: 1 << 30 }
  );
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr.toString());
  const buf = r.stdout as Buffer;
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2).slice();
  return { pcm, channels: 6 };
}

export function readF32(path: string): Float32Array {
  const b = readFileSync(path);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2).slice();
}

/* ---- minimal test registry ---- */

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
let failures = 0;

export function test(name: string, fn: Fn): void {
  tests.push({ name, fn });
}

export class AssertionError extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function assertClose(a: number, b: number, tol: number, msg: string): void {
  if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg}: ${a} vs ${b} (tol ${tol})`);
}

export function skip(reason: string): void {
  throw new SkipError(reason);
}
class SkipError extends Error {}

export function log(...args: unknown[]): void {
  console.log('      ', ...args);
}

export async function run(): Promise<void> {
  for (const t of tests) {
    const t0 = performance.now();
    try {
      await t.fn();
      console.log(`  ok   ${t.name} (${(performance.now() - t0).toFixed(0)} ms)`);
    } catch (e) {
      if (e instanceof SkipError) {
        console.log(`  skip ${t.name}: ${e.message}`);
      } else {
        failures++;
        console.log(`  FAIL ${t.name}\n       ${e instanceof Error ? e.stack || e.message : String(e)}`);
      }
    }
  }
  process.exitCode = failures ? 1 : 0;
}
