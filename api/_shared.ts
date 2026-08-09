import type { VercelRequest, VercelResponse } from '@vercel/node';

/* Shared guards for the API proxies. The underscore prefix keeps Vercel
   from exposing this module as an endpoint. */

/* ---------- per-IP token bucket -----------------------------------------
   A cost guard, NOT a security boundary: serverless instances each hold
   their own map, so the real ceiling is (instances × RATE) and a
   determined abuser can exceed it. The edge cache in front (s-maxage on
   every successful response) is the main protection; this bucket only
   keeps one chatty client from invoking the function in a tight loop. */

const RATE_PER_MINUTE = 30;
const BUCKET_CAP = 30;
const MAX_TRACKED_IPS = 5000;

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd || '';
  const ip = first.split(',')[0].trim();
  return ip || req.socket.remoteAddress || 'unknown';
}

/** Returns true when the request may proceed; otherwise sends the 429
    (with Retry-After) itself and returns false. */
export function passRateLimit(req: VercelRequest, res: VercelResponse): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      /* Drop the stalest entries rather than growing without bound. */
      const cutoff = now - 120000;
      for (const [k, v] of buckets) {
        if (v.last < cutoff) buckets.delete(k);
        if (buckets.size < MAX_TRACKED_IPS) break;
      }
      if (buckets.size >= MAX_TRACKED_IPS) buckets.clear();
    }
    b = { tokens: BUCKET_CAP, last: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(BUCKET_CAP, b.tokens + ((now - b.last) / 60000) * RATE_PER_MINUTE);
  b.last = now;
  if (b.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil(((1 - b.tokens) * 60000) / RATE_PER_MINUTE / 1000));
    res.setHeader('retry-after', String(retryAfter));
    res.status(429).json({ error: 'Too many requests — slow down and retry' });
    return false;
  }
  b.tokens -= 1;
  return true;
}

/* ---------- bounded upstream reads --------------------------------------
   An oversized upstream body is rejected, never streamed through: the
   declared length is checked first, and the actual read aborts the moment
   the cap is crossed. */

export async function readLimited(upstream: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > maxBytes) return null;
  const body = upstream.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* the connection is torn down either way */
        }
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks, total);
}

/** Successful responses are edge-cacheable — Vercel serves repeats without
    invoking the function at all, which is the main abuse protection. */
export function sendProxied(res: VercelResponse, status: number, contentType: string, cacheSeconds: number, body: Buffer, ok: boolean): void {
  res.status(status);
  res.setHeader('content-type', contentType);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', ok ? 'public, s-maxage=' + cacheSeconds + ', stale-while-revalidate=604800' : 'no-store');
  res.send(body);
}
