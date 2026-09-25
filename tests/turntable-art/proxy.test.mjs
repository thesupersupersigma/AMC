/* api/itunes-art.ts in isolation: the body cap sits under Vercel's 4.5 MB
   function response limit, while host pinning, path validation and the
   per-IP rate limit behave exactly as before. Upstream fetch is mocked. */

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChecker } from './harness.mjs';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'amc-proxy-'));
  const out = join(dir, 'itunes-art.mjs');
  await build({ entryPoints: [new URL('../../api/itunes-art.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  const { default: handler } = await import(out);

  const realFetch = globalThis.fetch;
  try {
    await cases(handler, check);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function cases(handler, check) {
  const seen = [];
  let bodyBytes = 0;
  let declare = true;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = new Uint8Array(bodyBytes);
    const headers = { 'content-type': 'image/jpeg' };
    if (declare) headers['content-length'] = String(bodyBytes);
    return new Response(body, { status: 200, headers });
  };
  let ipSeq = 0;
  async function call(path, ip) {
    const res = { code: 0, headers: {}, body: null, headersSent: false };
    res.status = (c) => ((res.code = c), res);
    res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
    res.json = (o) => ((res.body = o), (res.headersSent = true), res);
    res.send = (b) => ((res.body = b), (res.headersSent = true), res);
    const req = { query: { upstreamPath: path }, headers: { 'x-forwarded-for': ip || '10.0.0.' + ++ipSeq }, socket: {} };
    await handler(req, res);
    return res;
  }
  const P = 'image/thumb/Music/v4/aa/bb/cc/x.jpg/3000x3000bb.jpg';

  bodyBytes = 4300000;
  let r = await call(P);
  check('proxy: a 4.3 MB image passes', r.code === 200 && r.body && r.body.length === 4300000, r.code);
  check('proxy: upstream host stays pinned to is1-ssl.mzstatic.com', seen.every((u) => u.indexOf('https://is1-ssl.mzstatic.com/') === 0), seen[0]);

  bodyBytes = 4450000; /* under Vercel's 4.5 MB but too close with headers */
  r = await call(P);
  check('proxy: 4.45 MB declared → 502 "too large" (never a Vercel 413 mid-flight)', r.code === 502 && /too large/i.test(r.body && r.body.error), r.body);
  declare = false;
  r = await call(P);
  check('proxy: 4.45 MB streamed without a length → 502 "too large"', r.code === 502 && /too large/i.test(r.body && r.body.error), r.body);
  declare = true;

  bodyBytes = 100;
  r = await call('etc/passwd');
  check('proxy: path validation unchanged (non-image path → 400)', r.code === 400, r.body);
  r = await call('image/thumb/../../x.jpg');
  check('proxy: path validation unchanged (“..” → 400)', r.code === 400, r.body);

  let last = null;
  for (let i = 0; i < 31; i++) last = await call(P, '10.9.9.9');
  check('proxy: rate limit unchanged (31st request in a burst → 429)', last.code === 429 && last.headers['retry-after'], last.code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { check, failed } = makeChecker();
  await run({ check });
  if (failed().length) process.exit(1);
}
