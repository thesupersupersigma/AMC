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
import { norm } from '../util';
import { logErr } from '../ui/log';

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
  const resp = await fetch('/api/itunes/' + pathAndQuery, { headers: { accept: 'application/json' } });
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
  const data = (await apiGet('search?media=music&entity=album&limit=10&term=' + encodeURIComponent(term))) as ItunesResponse;
  return (data.results || []).map(asEntry).filter((e) => e.collectionId > 0);
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
    search + score + lookup (two requests). Returns null when nothing in
    the catalog plausibly matches. */
export async function fetchCatalogFor(folder: ConnectedFolder, al: Album): Promise<CatalogMatch | null> {
  const remembered = collectionIdFor(folder.folderId, al.key);
  if (remembered) {
    const cached = await readCachedCatalog(folder, remembered);
    if (cached) return cached;
  }
  let id = remembered;
  if (!id) {
    const candidates = await searchCollections(al);
    candidates.sort((a, b) => scoreCandidate(al, b) - scoreCandidate(al, a));
    if (!candidates.length || scoreCandidate(al, candidates[0]) < 2) return null;
    id = candidates[0].collectionId;
  }
  const got = await lookupCollection(id);
  if (!got) return null;
  cacheCatalog(folder, got.collection.collectionId, got);
  return { collection: got.collection, songs: got.songs, fromCache: false };
}

/* ---------- artwork ---------- */

/** artworkUrl100 → the same image at 600 px, served through the proxy. */
export function artworkProxyUrl(artworkUrl100: string): string {
  try {
    const u = new URL(artworkUrl100);
    return '/api/itunes/art' + u.pathname.replace(/100x100(bb)?(\.[a-z]+)$/i, '600x600bb$2');
  } catch {
    return '';
  }
}

export async function fetchArtwork(artworkUrl100: string): Promise<Blob | null> {
  const url = artworkProxyUrl(artworkUrl100);
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return blob.size && blob.type.indexOf('image/') === 0 ? blob : null;
  } catch (e) {
    logErr('catalog', 'The artwork download failed', (e as Error).message);
    return null;
  }
}
