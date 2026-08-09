#!/usr/bin/env node
/* Deployment smoke test for the API proxies. Hits a REAL deployment over
   HTTP — the only kind of test that catches module-resolution failures in
   the packaged functions (a bundler-based harness resolves imports its own
   way and can pass while the deployment 500s).

     node scripts/smoke-api.mjs https://<deployment-url>

   Asserts: a valid search returns 200 with results; a bare /api/itunes is
   rejected with 400 (closed proxy, not a crash); an artwork path returns
   an actual image; a lyrics search returns a JSON array. */

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke-api.mjs https://<deployment-url> [--share <token>]');
  console.error('  --share: a _vercel_share token for previews behind Vercel Authentication');
  process.exit(2);
}
const shareIdx = process.argv.indexOf('--share');
const shareToken = shareIdx > 0 ? process.argv[shareIdx + 1] || '' : '';

/* Previews behind Vercel Authentication accept a share token once, then
   authenticate by cookie — exchange it up front so the actual smoke
   requests run exactly like a normal client's. */
let cookie = '';
if (shareToken) {
  const resp = await fetch(base + '/?_vercel_share=' + encodeURIComponent(shareToken), { redirect: 'manual' });
  const setCookie = resp.headers.get('set-cookie') || '';
  const m = setCookie.match(/_vercel_jwt=[^;]+/);
  if (m) cookie = m[0];
  else console.error('warning: share token did not yield an auth cookie');
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

async function hit(path) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  const resp = await fetch(base + path, { headers });
  const buf = new Uint8Array(await resp.arrayBuffer());
  return { status: resp.status, type: resp.headers.get('content-type') || '', buf };
}

try {
  const search = await hit('/api/itunes/search?media=music&entity=album&limit=3&term=' + encodeURIComponent('michael jackson bad'));
  let count = -1;
  try {
    count = JSON.parse(new TextDecoder().decode(search.buf)).resultCount;
  } catch {
    /* non-JSON counts as failure below */
  }
  check('search returns 200 with results', search.status === 200 && count > 0, 'status=' + search.status + ' resultCount=' + count);

  const bare = await hit('/api/itunes');
  check('bare /api/itunes returns 400 (not 500)', bare.status === 400, 'status=' + bare.status);

  const art = await hit('/api/itunes/art/image/thumb/Music211/v4/d5/5f/28/d55f28f4-610c-ee81-dc16-a01cda46bbc4/886443546264.jpg/600x600bb.jpg');
  check('artwork returns an image', art.status === 200 && art.type.startsWith('image/') && art.buf.length > 10000, 'status=' + art.status + ' type=' + art.type + ' bytes=' + art.buf.length);

  const lrc = await hit('/api/lrclib/api/search?artist_name=' + encodeURIComponent('Michael Jackson') + '&track_name=Bad');
  let isArray = false;
  try {
    isArray = Array.isArray(JSON.parse(new TextDecoder().decode(lrc.buf)));
  } catch {
    /* non-JSON counts as failure below */
  }
  check('lyrics search returns a JSON array', lrc.status === 200 && isArray, 'status=' + lrc.status);
} catch (e) {
  check('deployment reachable', false, String(e));
}

for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? 'SMOKE: ' + failed + ' FAILURE(S) against ' + base : 'SMOKE: ALL PASS against ' + base);
process.exit(failed ? 1 : 0);
