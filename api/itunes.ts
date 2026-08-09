import type { VercelRequest, VercelResponse } from '@vercel/node';
import { passRateLimit, readLimited, sendProxied } from './_shared';

/* Proxy for the iTunes Search API — a CLOSED proxy, not a forwarder.
   Upstream URLs are built only against the two fixed endpoints below;
   the caller-supplied path chooses between them and nothing else, and
   only whitelisted, validated parameters are forwarded. Apple's own CORS
   headers are CDN-cached against other origins and fail unpredictably
   when called directly — this proxy is why that never matters. */

const UPSTREAM = 'https://itunes.apple.com';
const MAX_BODY_BYTES = 2 * 1048576;
const CACHE_SECONDS = 86400;

/* The forwardable parameters per endpoint, with shape checks. */
const PARAM_RULES: Record<string, RegExp> = {
  term: /^[\s\S]{1,200}$/,
  entity: /^[a-zA-Z]{1,30}$/,
  media: /^[a-zA-Z]{1,20}$/,
  attribute: /^[a-zA-Z]{1,40}$/,
  country: /^[a-zA-Z]{2}$/,
  limit: /^\d{1,3}$/,
  id: /^\d{1,12}$/,
};
const ENDPOINT_PARAMS: Record<string, string[]> = {
  search: ['term', 'entity', 'media', 'attribute', 'country', 'limit'],
  lookup: ['id', 'entity', 'country', 'limit'],
};

function firstOf(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] || '' : v || '';
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('access-control-allow-origin', '*');
  if (!passRateLimit(req, res)) return;

  const endpoint = firstOf(req.query['upstreamPath']).replace(/^\/+|\/+$/g, '');
  const allowed = ENDPOINT_PARAMS[endpoint];
  if (!allowed) {
    res.status(400).json({ error: 'Unknown endpoint — this proxy serves /search and /lookup only' });
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
  /* The parameter that makes each endpoint meaningful is required — a bare
     request must never fall through to Apple's homepage. */
  if (endpoint === 'search' && !params.get('term')) {
    res.status(400).json({ error: 'search needs a term parameter' });
    return;
  }
  if (endpoint === 'lookup' && !params.get('id')) {
    res.status(400).json({ error: 'lookup needs a numeric id parameter' });
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM + '/' + endpoint + '?' + params.toString(), { headers: { accept: 'application/json' } });
    const body = await readLimited(upstream, MAX_BODY_BYTES);
    if (body === null) {
      res.status(502).json({ error: 'The upstream response was too large' });
      return;
    }
    sendProxied(res, upstream.status, upstream.headers.get('content-type') || 'application/json; charset=utf-8', CACHE_SECONDS, body, upstream.ok);
  } catch {
    res.status(502).json({ error: 'The iTunes Search API could not be reached' });
  }
}
