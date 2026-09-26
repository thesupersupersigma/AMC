#!/usr/bin/env node
/* Checks that the Atmos add-on has no top-level side effects apart from the
   registration in src/audio/spatial/register.ts, and that register.ts can be
   imported where there is no DOM or AudioContext (the engine imports it in
   its Worker as well as on the main thread).

   1. esbuild and Rollup (Vite's bundler) each bundle a side-effect-only
      import of every atmos module. With tree shaking that must come out empty.
   2. register.ts is bundled and imported in plain Node (no window, document,
      AudioContext); afterwards both factories must be registered.

   Usage: node scripts/atmos-treeshake.mjs */

import { build } from 'esbuild';
import { rollup } from 'rollup';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const atmosDir = join(root, 'src/audio/atmos');
const out = mkdtempSync(join(tmpdir(), 'atmos-treeshake-'));

function listTs(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...listTs(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(p);
  }
  return files;
}

const modules = listTs(atmosDir);
const entry = join(out, 'side-effects-entry.ts');
writeFileSync(entry, modules.map((m) => `import ${JSON.stringify(m)};`).join('\n') + '\n');

let failed = false;

/* 1a. esbuild */
{
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    treeShaking: true,
    platform: 'neutral',
    logLevel: 'silent',
  });
  const code = r.outputFiles[0].text.replace(/\/\/.*$/gm, '').trim();
  if (code) {
    failed = true;
    console.error('FAIL esbuild: side-effect-only import of atmos modules left code behind:\n' + code.slice(0, 2000));
  } else {
    console.log(`ok   esbuild: ${modules.length} atmos modules tree-shake to nothing`);
  }
}

/* 1b. Rollup, via esbuild for the TypeScript transform only. */
{
  const tsPlugin = {
    name: 'ts',
    async resolveId(source, importer) {
      if (!importer) return source;
      if (source.startsWith('.')) {
        const base = resolve(importer, '..', source);
        for (const cand of [base, base + '.ts', join(base, 'index.ts')]) {
          try {
            if (statSync(cand).isFile()) return cand;
          } catch {
            /* next */
          }
        }
      }
      return null;
    },
    async transform(code, id) {
      if (!id.endsWith('.ts')) return null;
      const { transform } = await import('esbuild');
      const r = await transform(code, { loader: 'ts', format: 'esm', target: 'es2020' });
      return { code: r.code, map: null };
    },
  };
  const bundle = await rollup({ input: entry, plugins: [tsPlugin], treeshake: true, onwarn() {} });
  const { output } = await bundle.generate({ format: 'es' });
  const code = output[0].code.trim();
  if (code) {
    failed = true;
    console.error('FAIL rollup: side-effect-only import of atmos modules left code behind:\n' + code.slice(0, 2000));
  } else {
    console.log('ok   rollup: atmos modules tree-shake to nothing');
  }
}

/* 2. register.ts in a realm without DOM / Web Audio. */
{
  const regEntry = join(out, 'register-entry.ts');
  writeFileSync(
    regEntry,
    `import ${JSON.stringify(join(root, 'src/audio/spatial/register.ts'))};\n` +
      `export { getSpatialProcessorFactory, getSpatialRendererFactory } from ${JSON.stringify(join(root, 'src/audio/spatial/contract.ts'))};\n`
  );
  const outFile = join(out, 'register.mjs');
  await build({ entryPoints: [regEntry], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
  for (const g of ['window', 'document', 'AudioContext', 'OfflineAudioContext', 'AudioNode']) {
    if (g in globalThis) {
      failed = true;
      console.error(`FAIL precondition: ${g} unexpectedly exists in this Node realm`);
    }
  }
  try {
    const mod = await import(pathToFileURL(outFile).href);
    const p = mod.getSpatialProcessorFactory();
    const r = mod.getSpatialRendererFactory();
    if (typeof p !== 'function' || typeof r !== 'function') throw new Error('factories not registered');
    console.log('ok   register.ts imports without DOM/AudioContext and registers both factories');
  } catch (e) {
    failed = true;
    console.error('FAIL register.ts import in a DOM-less realm: ' + (e && e.stack ? e.stack : e));
  }
}

console.log(`(scratch output in ${out})`);
process.exit(failed ? 1 : 0);
