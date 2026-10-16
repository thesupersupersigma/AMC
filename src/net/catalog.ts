/* Phase 4a — the iTunes Search API, always through /api/itunes so CORS
   never applies, batched by album (one search + one lookup per album, not
   one call per track — the API allows roughly 20 requests a minute).
   Results cache to .AMC/catalog/<collectionId>.json, so a review re-opens
   offline once an album has been matched. Artwork comes through
   /api/itunes/art on the same-origin proxy, never from the CDN directly. */

import type { Album, CatalogEntry, ConnectedFolder } from '../types';
import { SCHEMA_VERSION, albumDirOf } from '../state';
import { queueSidecarWrite } from '../fs/amcdir';
import { collectionIdFor } from '../fs/overrides';
import { apiUrl, norm } from '../util';
import { logErr } from '../ui/log';
import { markCatalogBlob } from '../art/marks'; // hires-art hook
import { currentQuality, levelOf } from '../art/quality'; // hires-art hook

export interface CatalogMatch {
  collection: CatalogEntry;
  songs: CatalogEntry[];
  fromCache: boolean;
}

interface SidecarCatalog {
  schemaVersion: number;
  collection: CatalogEntry;
  songs: CatalogEntry[];
  fetchedAt: number;
}

/* ---------- the rate limiter: ~18 calls a minute, spaced ---------- */

const MIN_GAP_MS = 3400;
let nextSlot = 0;

async function apiGet(pathAndQuery: string): Promise<unknown> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const resp = await fetch(apiUrl('/api/itunes/' + pathAndQuery), { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error('The catalog request failed (' + resp.status + ')');
  return (await resp.json()) as unknown;
}

interface ItunesResponse {
  resultCount?: number;
  results?: Array<Record<string, unknown>>;
}

function asEntry(r: Record<string, unknown>): CatalogEntry {
  return {
    collectionId: Number(r['collectionId']) || 0,
    trackId: Number(r['trackId']) || undefined,
    artistId: Number(r['artistId']) || undefined,
    artistName: String(r['artistName'] || ''),
    collectionName: String(r['collectionName'] || ''),
    trackName: r['trackName'] != null ? String(r['trackName']) : undefined,
    trackNumber: Number(r['trackNumber']) || undefined,
    trackCount: Number(r['trackCount']) || undefined,
    discNumber: Number(r['discNumber']) || undefined,
    releaseDate: r['releaseDate'] != null ? String(r['releaseDate']) : undefined,
    primaryGenreName: r['primaryGenreName'] != null ? String(r['primaryGenreName']) : undefined,
    artworkUrl100: r['artworkUrl100'] != null ? String(r['artworkUrl100']) : undefined,
  };
}

export function yearOfRelease(e: CatalogEntry): number {
  const m = e.releaseDate && e.releaseDate.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

/** The local album's year: tags first, then a year in the album folder's
    own name — "Michael Jackson - Bad (1987)" knows its edition even when
    the tags do not. */
export function albumYearOf(al: Album): number {
  if (al.year) return al.year;
  const t0 = al.tracks[0];
  if (!t0 || !t0.path) return 0;
  const leaf = albumDirOf(t0.path).split('/').pop() || '';
  const m = leaf.match(/\((19|20)\d{2}\)/) || leaf.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0].replace(/[()]/g, ''), 10) : 0;
}

/* ---------- version suffixes --------------------------------------------
   "(2012 Remaster)", "[Single Version]", "(Live)" — trailing parentheticals
   that name a mastering or variant, not the song. Credit parentheticals
   ("feat. …", "with …", "Duet …") are part of the title and are kept. */

const VERSION_WORDS = /\b(remaster(ed)?( version)?|(19|20)\d{2}|single version|album version|radio edit|extended( version| mix)?|deluxe( edition)?|anniversary( edition)?|expanded( edition)?|reissue|bonus track|mono|stereo|live|demo|instrumental|acoustic|version|mix|edit)\b/i;
const CREDIT_WORDS = /feat\.|featuring|\bwith\s|duet/i;

export function stripVersionSuffix(title: string): string {
  let t = String(title).trim();
  for (let guard = 0; guard < 4; guard++) {
    const m = t.match(/[([]([^()[\]]*)[)\]]\s*$/);
    if (!m || m.index === 0) break;
    const inner = m[1];
    if (CREDIT_WORDS.test(inner) || !VERSION_WORDS.test(inner)) break;
    t = t.slice(0, m.index).trim();
  }
  return t || String(title);
}

/* ---------- search + score ---------- */

/** "Jackson, Michael" and "Michael Jackson" are the same person. */
function flipComma(s: string): string {
  const m = String(s).match(/^([^,]+),\s*(.+)$/);
  return m ? m[2] + ' ' + m[1] : s;
}

/** The local album's artist names the catalog artist (either spelling). */
function sameArtist(al: Album, name: string): boolean {
  const ca = norm(name);
  return ca === norm(al.artist) || ca === norm(flipComma(al.artist));
}

function scoreCandidate(al: Album, c: CatalogEntry): number {
  let s = 0;
  const cn = norm(stripVersionSuffix(c.collectionName));
  const an = norm(stripVersionSuffix(al.album));
  if (cn === an) s += 3;
  else if (cn.indexOf(an) === 0 || an.indexOf(cn) === 0) s += 1.5;
  const ca = norm(c.artistName);
  const aa = norm(al.artist);
  const aaFlip = norm(flipComma(al.artist));
  if (ca === aa || ca === aaFlip) s += 2;
  else if (ca.indexOf(aa) >= 0 || aa.indexOf(ca) >= 0) s += 1;
  if (c.trackCount) s += Math.max(0, 1.5 - Math.abs(c.trackCount - al.tracks.length) * 0.3);
  /* Year agreement outweighs everything except the name itself: iTunes
     carries several releases of one album, and the right one is the one
     dated like the local rip. (Reissues often keep the ORIGINAL release
     date, so agreement cannot prove the same mastering — the diff layer
     checks titles for that.) */
  const ly = albumYearOf(al);
  const cy = yearOfRelease(c);
  if (ly && cy) {
    const d = Math.abs(ly - cy);
    if (d === 0) s += 4;
    else if (d === 1) s += 2;
    else s -= Math.min(3, (d - 1) * 0.75);
  }
  return s;
}

async function searchCollections(al: Album): Promise<CatalogEntry[]> {
  const term = (al.artist + ' ' + al.album).trim();
  const data = (await apiGet('search?media=music&entity=album&limit=25&term=' + encodeURIComponent(term))) as ItunesResponse;
  return (data.results || []).map(asEntry).filter((e) => e.collectionId > 0);
}

/* The search ranks by popularity across the whole term, so a famous
   artist's name drowns the album's: "Michael Jackson Dangerous" returns 25
   compilations, singles and remixes, and not Dangerous. The artist's own
   album list always has it. */

/** The catalog id of the local album's artist: from the search results
    when one of them is by that artist, else one artist search. */
async function artistIdFor(al: Album, seen: CatalogEntry[]): Promise<number> {
  const hit = seen.find((e) => e.artistId && sameArtist(al, e.artistName));
  if (hit && hit.artistId) return hit.artistId;
  const name = flipComma(al.artist).trim();
  if (!name) return 0;
  const data = (await apiGet('search?media=music&entity=musicArtist&limit=10&term=' + encodeURIComponent(name))) as ItunesResponse;
  const rows = data.results || [];
  const exact = rows.find((r) => sameArtist(al, String(r['artistName'] || '')));
  return exact ? Number(exact['artistId']) || 0 : 0;
}

/** Every album the catalog lists for an artist. */
async function artistAlbums(artistId: number): Promise<CatalogEntry[]> {
  const data = (await apiGet('lookup?id=' + artistId + '&entity=album&limit=200')) as ItunesResponse;
  return (data.results || [])
    .filter((r) => r['wrapperType'] === 'collection')
    .map(asEntry)
    .filter((e) => e.collectionId > 0);
}

/** Name and artist both agree: a match the search itself can be trusted
    with (3 for the name, 2 for the artist). */
const STRONG = 5;

/** The best catalog album for a local one, or null below a plausible
    score: the plain search first, the artist's album list when that finds
    nothing named like the album. */
async function bestCollection(al: Album): Promise<CatalogEntry | null> {
  const byScore = (list: CatalogEntry[]): CatalogEntry[] => list.slice().sort((a, b) => scoreCandidate(al, b) - scoreCandidate(al, a));
  let candidates = byScore(await searchCollections(al));
  if (!candidates.length || scoreCandidate(al, candidates[0]) < STRONG) {
    try {
      const artistId = await artistIdFor(al, candidates);
      if (artistId) {
        const known = new Set(candidates.map((c) => c.collectionId));
        candidates = byScore(candidates.concat((await artistAlbums(artistId)).filter((c) => !known.has(c.collectionId))));
      }
    } catch (e) {
      /* the search's own candidates still stand */
      logErr('catalog', 'The artist lookup failed for ' + al.artist, (e as Error).message);
    }
  }
  return candidates.length && scoreCandidate(al, candidates[0]) >= 2 ? candidates[0] : null;
}

async function lookupCollection(id: number): Promise<{ collection: CatalogEntry; songs: CatalogEntry[] } | null> {
  const data = (await apiGet('lookup?id=' + id + '&entity=song&limit=200')) as ItunesResponse;
  const rows = data.results || [];
  let collection: CatalogEntry | null = null;
  const songs: CatalogEntry[] = [];
  for (const r of rows) {
    if (r['wrapperType'] === 'collection') collection = asEntry(r);
    else if (r['wrapperType'] === 'track' && r['kind'] === 'song') songs.push(asEntry(r));
  }
  if (!collection) return null;
  songs.sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
  return { collection: collection, songs: songs };
}

/* ---------- sidecar cache ---------- */

async function readCachedCatalog(folder: ConnectedFolder, id: number): Promise<CatalogMatch | null> {
  const text = await folder.backend.readSidecarText('catalog/' + id + '.json');
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as SidecarCatalog;
    if (raw && raw.collection && Array.isArray(raw.songs)) return { collection: raw.collection, songs: raw.songs, fromCache: true };
  } catch (e) {
    logErr('catalog', 'catalog/' + id + '.json is malformed and was ignored', (e as Error).message);
  }
  return null;
}

function cacheCatalog(folder: ConnectedFolder, id: number, m: { collection: CatalogEntry; songs: CatalogEntry[] }): void {
  const out: SidecarCatalog = { schemaVersion: SCHEMA_VERSION, collection: m.collection, songs: m.songs, fetchedAt: Date.now() };
  queueSidecarWrite(folder, 'catalog/' + id + '.json', () => JSON.stringify(out, null, 1) + '\n');
}

/** The whole per-album flow: remembered collection → sidecar cache →
    search + score + lookup (two requests; up to two more when the search
    misses and the artist's album list is consulted). Returns null when
    nothing in the catalog plausibly matches. */
export async function fetchCatalogFor(folder: ConnectedFolder, al: Album): Promise<CatalogMatch | null> {
  const remembered = collectionIdFor(folder.folderId, al.key);
  if (remembered) {
    const cached = await readCachedCatalog(folder, remembered);
    if (cached) return cached;
  }
  let id = remembered;
  if (!id) {
    const best = await bestCollection(al);
    if (!best) return null;
    id = best.collectionId;
  }
  const got = await lookupCollection(id);
  if (!got) return null;
  cacheCatalog(folder, got.collection.collectionId, got);
  return { collection: got.collection, songs: got.songs, fromCache: false };
}

/* ---------- artwork ----------
   hires-art hook: sized per Settings › Artwork quality, with a step-down
   for when the proxy cannot carry the requested size. ---------- */

/** artworkUrl100 → the same image at `px` (600 by default), served through
    the proxy. */
export function artworkProxyUrl(artworkUrl100: string, px?: number): string {
  const size = px && px > 0 ? Math.round(px) : 600; // hires-art hook
  try {
    const u = new URL(artworkUrl100);
    return apiUrl('/api/itunes/art' + u.pathname.replace(/100x100(bb)?(\.[a-z]+)$/i, size + 'x' + size + 'bb$2'));
  } catch {
    return '';
  }
}

/* The proxy caps what one serverless response can carry (Vercel: 4.5 MB,
   413 FUNCTION_PAYLOAD_TOO_LARGE) and answers 502 "too large" itself just
   below that. Either means "ask for a smaller size", not "fail". */
async function tooLarge(resp: Response): Promise<boolean> {
  if (resp.status === 413) return true;
  if (resp.status !== 502) return false;
  try {
    const j = (await resp.clone().json()) as { error?: string };
    return /too large/i.test(String(j && j.error));
  } catch {
    return false;
  }
}

export interface SizedArtwork {
  blob: Blob;
  /** The size that was requested (the image may be smaller if that is all
      the catalog has). */
  px: number;
}

/** Tries each size in turn (largest first), stepping down only when the
    image is too large for the proxy. `beforeRequest` paces bulk callers. */
export async function fetchArtworkSized(artworkUrl100: string, sizes: number[], beforeRequest?: () => Promise<void>): Promise<SizedArtwork | null> {
  for (let i = 0; i < sizes.length; i++) {
    const url = artworkProxyUrl(artworkUrl100, sizes[i]);
    if (!url) return null;
    try {
      if (beforeRequest) await beforeRequest();
      const resp = await fetch(url);
      if (resp.ok) {
        const blob = await resp.blob();
        if (!blob.size || blob.type.indexOf('image/') !== 0) return null;
        markCatalogBlob(blob, sizes[i]);
        return { blob: blob, px: sizes[i] };
      }
      if (i < sizes.length - 1 && (await tooLarge(resp))) {
        logErr('catalog', 'The ' + sizes[i] + ' px cover is too large for the proxy — trying ' + sizes[i + 1] + ' px', '');
        continue;
      }
      if (resp.status === 429) throw new Error('The artwork proxy is rate limiting (429) — try again in a minute');
      return null;
    } catch (e) {
      logErr('catalog', 'The artwork download failed', (e as Error).message);
      return null;
    }
  }
  return null;
}

export async function fetchArtwork(artworkUrl100: string): Promise<Blob | null> {
  const got = await fetchArtworkSized(artworkUrl100, levelOf(currentQuality()).catalogPx); // hires-art hook
  return got ? got.blob : null;
}

/** The catalog artworkUrl100 for a remembered collection: the sidecar
    cache first (offline), else one rate-limited lookup. '' when unknown. */ // hires-art hook
export async function artworkUrlFor(folder: ConnectedFolder, collectionId: number): Promise<string> {
  if (!collectionId) return '';
  const cached = await readCachedCatalog(folder, collectionId);
  if (cached && cached.collection.artworkUrl100) return cached.collection.artworkUrl100;
  const got = await lookupCollection(collectionId);
  if (!got) return '';
  cacheCatalog(folder, got.collection.collectionId, got);
  return got.collection.artworkUrl100 || '';
}
