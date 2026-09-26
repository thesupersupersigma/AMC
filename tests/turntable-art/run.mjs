/* Runs every turntable/artwork test against one fresh dev server.
     node tests/turntable-art/make-fixtures.mjs /tmp/amc-fx      (once)
     FIXTURES=/tmp/amc-fx/TTLib NODE_PATH=$(npm root -g) node tests/turntable-art/run.mjs [name…] */

import { startServer, makeChecker } from './harness.mjs';

const ALL = ['proxy', 'art', 'catalog', 'turntable', 'polish'];
const pick = process.argv.slice(2);
const names = pick.length ? pick : ALL;
const { check, results, failed } = makeChecker();
const server = await startServer();
try {
  for (const n of names) {
    let mod;
    try {
      mod = await import(`./${n}.test.mjs`);
    } catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND') continue;
      throw e;
    }
    console.log(`\n=== ${n} ===`);
    try {
      await mod.run({ server, check });
    } catch (e) {
      check(`${n}: ran to completion`, false, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
    }
  }
} finally {
  server.stop();
}
console.log(`\n${results.length - failed().length}/${results.length} passed`);
if (failed().length) {
  for (const f of failed()) console.log('FAILED: ' + f.name);
  process.exit(1);
}
