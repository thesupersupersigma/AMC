import type { VercelRequest, VercelResponse } from '@vercel/node';
import { passRateLimit, readLimited, sendProxied } from './_shared.js';

/* Proxy for LRCLIB — closed like the iTunes one: only the two fixed
   endpoints, only whitelisted parameters, and a lookup must actually name
   a track (no parameterless pass-through). */

const UPSTREAM = 'https://lrclib.net';
const MAX_BODY_BYTES = 2 * 1048576;
const CACHE_SECONDS = 86400;

const PARAM_RULES: Record<string, RegExp> = {
  artist_name: /^[\s\S]{1,300}$/,
  track_name: /^[\s\S]{1,300}$/,
  album_name: /^[\s\S]{1,300}$/,
  duration: /^\d{1,5}$/,
  q: /^[\s\S]{1,300}$/,
};
const ENDPOINT_PARAMS: Record<string, string[]> = {
  'api/get': ['artist_name', 'track_name', 'album_name', 'duration'],
  'api/search': ['artist_name', 'track_name', 'album_name', 'q'],
};

function firstOf(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] || '' : v || '';
}

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
  const endpoint = (Array.isArray(raw) ? raw.join('/') : raw || '').replace(/^\/+|\/+$/g, '');
  const allowed = ENDPOINT_PARAMS[endpoint];
  if (!allowed) {
    res.status(400).json({ error: 'Unknown endpoint — this proxy serves /api/get and /api/search only' });
    return;
  }
  const params = new URLSearchParams();
  for (const key of allowed) {
    const val = firstOf(req.query[key]);
    if (!val) continue;
    if (!PARAM_RULES[key].test(val)) {
      res.status(400).json({ error: 'Bad ' + key + ' parameter' });
      return;
    }
    params.append(key, val);
  }
  if (endpoint === 'api/get' && (!params.get('artist_name') || !params.get('track_name'))) {
    res.status(400).json({ error: 'get needs artist_name and track_name' });
    return;
  }
  if (endpoint === 'api/search' && !params.get('artist_name') && !params.get('track_name') && !params.get('q')) {
    res.status(400).json({ error: 'search needs artist_name, track_name or q' });
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM + '/' + endpoint + '?' + params.toString(), {
      headers: { accept: 'application/json', 'user-agent': 'AMC/2.0 (music.thesupersupersigma.com)' },
    });
    const body = await readLimited(upstream, MAX_BODY_BYTES);
    if (body === null) {
      res.status(502).json({ error: 'The upstream response was too large' });
      return;
    }
    sendProxied(res, upstream.status, upstream.headers.get('content-type') || 'application/json; charset=utf-8', CACHE_SECONDS, body, upstream.ok);
  } catch {
    res.status(502).json({ error: 'LRCLIB could not be reached' });
  }
}
