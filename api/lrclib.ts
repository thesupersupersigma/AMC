import type { VercelRequest, VercelResponse } from '@vercel/node';

/* Serverless proxy for LRCLIB. The client calls /api/lrclib/api/get?… etc.;
   vercel.json rewrites the sub-path into ?upstreamPath=… . */

const UPSTREAM = 'https://lrclib.net';

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
  /* The single-file build runs from file:// with no /api of its own and
     calls this deployment cross-origin. Lyrics lookups are public data. */
  res.setHeader('access-control-allow-origin', '*');
  try {
    const upstream = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'AMC/2.0 (music.thesupersupersigma.com)' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.send(body);
  } catch {
    res.status(502).json({ error: 'LRCLIB could not be reached' });
  }
}
