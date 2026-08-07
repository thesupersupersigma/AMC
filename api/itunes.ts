import type { VercelRequest, VercelResponse } from '@vercel/node';

/* Serverless proxy for the iTunes Search API. The client calls
   /api/itunes/search?term=… or /api/itunes/lookup?id=…; vercel.json rewrites
   the sub-path into ?upstreamPath=… so this single function serves it all.
   Apple's own CORS headers are CDN-cached against other origins and fail
   unpredictably when called directly — this proxy is why that never matters. */

const UPSTREAM = 'https://itunes.apple.com';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const raw = req.query['upstreamPath'];
  const path = Array.isArray(raw) ? raw.join('/') : raw || '';
  if (!/^[\w\-./]*$/.test(path)) {
    res.status(400).json({ error: 'Bad path' });
    return;
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'upstreamPath' || v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.append(k, v);
  }
  const qs = params.toString();
  const url = `${UPSTREAM}/${path}${qs ? `?${qs}` : ''}`;
  try {
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.send(body);
  } catch {
    res.status(502).json({ error: 'The iTunes Search API could not be reached' });
  }
}
