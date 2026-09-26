#!/usr/bin/env node
/* Runs the Atmos add-on's tests: typechecks test/atmos (plus the sources it
   imports) with tsc, then bundles each test/atmos/*.test.ts with esbuild
   (already a Vite dependency) and runs it in Node.

   Usage: node scripts/atmos-test.mjs [name-filter...]
   Env:   AMC_ATMOS_FILE  real Atmos .m4a (default test/private/get-on-the-floor.m4a)
          AMC_CAVERN_REF  Cavern reference dump dir (default /tmp/cavref/out,
                          made by scripts/atmos-cavern-ref.sh)
          AMC_FFMPEG      ffmpeg binary for core reference decodes */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testDir = join(root, 'test/atmos');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const noTypecheck = process.argv.includes('--no-typecheck');

if (!noTypecheck) {
  const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', testDir], {
    cwd: root,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    console.error('typecheck of test/atmos failed');
    process.exit(1);
  }
}

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();
// Inside node_modules (git-ignored) so bundled tests can resolve packages.
const out = join(root, 'node_modules/.cache/atmos-tests');
mkdirSync(out, { recursive: true });
let failed = 0;
for (const f of files) {
  const outfile = join(out, f.replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [join(testDir, f)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    sourcemap: 'inline',
    packages: 'external',
    logLevel: 'error',
  });
  console.log(`\n${f}`);
  const r = spawnSync(process.execPath, ['--enable-source-maps', '--expose-gc', outfile], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : `\nall ${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
