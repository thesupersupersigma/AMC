import type { VercelRequest, VercelResponse } from '@vercel/node';

/* Serverless proxy for iTunes artwork. Search results carry artworkUrl100
   on Apple's mzstatic CDN — a different host from the Search API, so the
   /api/itunes function cannot serve it. The isN-ssl shards are
   interchangeable, so every artwork path is fetched through is1-ssl. The
   client only ever calls /api/itunes/art/…; vercel.json rewrites the
   sub-path here. */

const UPSTREAM = 'https://is1-ssl.mzstatic.com';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const raw = req.query['upstreamPath'];
  const path = Array.isArray(raw) ? raw.join('/') : raw || '';
  if (!/^[\w\-./%]*$/.test(path) || path.indexOf('..') >= 0) {
    res.status(400).json({ error: 'Bad path' });
    return;
  }
  /* The single-file build runs from file:// with no /api of its own and
     calls this deployment cross-origin. Artwork carries nothing private. */
  res.setHeader('access-control-allow-origin', '*');
  try {
    const upstream = await fetch(UPSTREAM + '/' + path);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('cache-control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    res.send(body);
  } catch {
    res.status(502).json({ error: 'The artwork CDN could not be reached' });
  }
}
