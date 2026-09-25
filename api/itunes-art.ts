import type { VercelRequest, VercelResponse } from '@vercel/node';
import { passRateLimit, readLimited, sendProxied } from './_shared.js';

/* Proxy for iTunes artwork. The hostname allowlist is enforced by
   construction: the client sends only a PATH, and the upstream URL is
   always built against the single mzstatic host below — no caller-supplied
   URL or hostname is ever consulted. The path itself must look like an
   Apple image asset (image/… ending in an image extension); anything else
   is a 400, so the endpoint cannot fetch arbitrary content even from the
   allowed host. */

const UPSTREAM = 'https://is1-ssl.mzstatic.com';
/* Vercel caps a function's response body at 4.5 MB (anything larger is a
   413 FUNCTION_PAYLOAD_TOO_LARGE), so the cap sits just under it with room
   for headers. The client steps down to a smaller size when this trips. */
const MAX_BODY_BYTES = 4400000; // hires-art hook
const CACHE_SECONDS = 604800; /* covers art is immutable per URL */

const ART_PATH = /^image\/[\w\-./%]{1,400}\.(jpe?g|png|webp)$/i;

/* No input may crash the function outright. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    await run(req, res);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'Internal proxy error' });
  }
}

async function run(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('access-control-allow-origin', '*');
  if (!passRateLimit(req, res)) return;

  const raw = req.query['upstreamPath'];
  const path = (Array.isArray(raw) ? raw.join('/') : raw || '').replace(/^\/+/, '');
  if (!ART_PATH.test(path) || path.indexOf('..') >= 0) {
    res.status(400).json({ error: 'Not an artwork path' });
    return;
  }
  try {
    const upstream = await fetch(UPSTREAM + '/' + path);
    const type = upstream.headers.get('content-type') || '';
    if (upstream.ok && type.indexOf('image/') !== 0) {
      res.status(502).json({ error: 'The upstream did not return an image' });
      return;
    }
    const body = await readLimited(upstream, MAX_BODY_BYTES);
    if (body === null) {
      res.status(502).json({ error: 'The upstream response was too large' });
      return;
    }
    sendProxied(res, upstream.status, type || 'image/jpeg', CACHE_SECONDS, body, upstream.ok);
  } catch {
    res.status(502).json({ error: 'The artwork CDN could not be reached' });
  }
}
