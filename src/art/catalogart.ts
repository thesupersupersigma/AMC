/* Catalog covers at the hero tier: where they are kept, how they are
   upgraded when the quality level asks for more, and the bulk
   "Re-download artwork at this quality" queue.

   Storage, best first:
     1. the sidecar's artwork/<album>.jpg — survives across origins
        (localhost / preview / production) and reinstalls;
     2. IndexedDB (a 'hero||<album>' row in the covers store) when the
        sidecar cannot be written — the read-only webkitdirectory fallback,
        Safari, or a failed write;
     3. memory, for this session, when IndexedDB fails too.
   Every write degrades to the next with a line in the activity log.

   Network: every artwork request is paced to ≤ 20 a minute (the proxy
   allows 30 per IP). Changing the level never mass-downloads; covers are
   upgraded lazily as their albums are opened or played, one at a time,
   and the Settings button does the bulk job. */

import type { Album } from '../types';
import { S, storeCover } from '../state';
import { ST_COVERS, ST_META, idbDel, idbGet, idbPut } from '../db/idb';
import { folderById } from '../fs/folders';
import { artFileOf, collectionIdFor } from '../fs/overrides';
import { artworkUrlFor, fetchArtworkSized, type SizedArtwork } from '../net/catalog';
import { logErr } from '../ui/log';
import { toast } from '../util';
import { catalogRequestedPx } from './marks';
import { catalogCoverBlob, invalidateHero, onCoverStored, setHeroIdbSource, setHeroMintedHook } from './hero';
import { scheduleHeroUpgrade } from './dom';
import { imageSize } from './imgsize';
import { catalogPxFor, currentQuality, levelOf } from './quality';

const IDB_PREFIX = 'hero||';
const REQ_PREFIX = 'artreq:';

interface HeroRec {
  key: string;
  /** Named like CoverRec's field so the row fits the covers store's shape. */
  thumb: Blob;
  hero: 1;
  px: number;
  at: number;
}
interface ReqRec {
  key: string;
  /** The largest size the catalog was asked for — a cover that came back
      smaller than this is the biggest the catalog has. */
  px: number;
  got: number;
  at: number;
}

/* ---------- pacing: at most 20 artwork requests a minute ---------- */

export const ART_GAP_MS = 3000;
let nextArtSlot = 0;

export async function paceArtRequest(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextArtSlot - now);
  nextArtSlot = Math.max(now, nextArtSlot) + ART_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

/* ---------- the browser-side copies ---------- */

const memHero = new Map<string, Blob>();

async function browserHero(key: string): Promise<Blob | null> {
  const m = memHero.get(key);
  if (m) return m;
  const row = await idbGet<HeroRec>(ST_COVERS, IDB_PREFIX + key);
  return row && row.thumb && row.thumb.size ? row.thumb : null;
}

async function keepInBrowser(key: string, blob: Blob, px: number): Promise<void> {
  memHero.set(key, blob);
  try {
    await idbPut(ST_COVERS, { key: IDB_PREFIX + key, thumb: blob, hero: 1, px: px, at: Date.now() } as HeroRec);
    /* idbPut logs its own failure; the memory copy carries the session. */
    const back = await idbGet<HeroRec>(ST_COVERS, IDB_PREFIX + key);
    if (back && back.thumb) memHero.delete(key);
  } catch (e) {
    logErr('artwork', 'Could not cache a cover in the browser — keeping it in memory for this session', (e as Error).message);
  }
}

async function noteRequested(key: string, px: number, blob: Blob): Promise<void> {
  const s = await imageSize(blob);
  await idbPut(ST_META, { key: REQ_PREFIX + key, px: px, got: s ? Math.max(s.w, s.h) : 0, at: Date.now() } as ReqRec);
}

async function lastRequestedPx(key: string): Promise<number> {
  const r = await idbGet<ReqRec>(ST_META, REQ_PREFIX + key);
  return r && r.px ? r.px : 0;
}

function primaryFolderOf(key: string) {
  const al = S.albumMap[key];
  return al && al.tracks.length ? folderById(al.tracks[0].folderId) : null;
}

/** Stores a downloaded catalog cover as the album's hero source: sidecar
    first, browser fallback. Also rebuilds the thumb from it. */
export async function storeCatalogHero(key: string, blob: Blob, px: number): Promise<'sidecar' | 'browser'> {
  const folder = primaryFolderOf(key);
  let where: 'sidecar' | 'browser' = 'browser';
  if (folder && folder.capability === 'readwrite') {
    try {
      await folder.backend.writeSidecarBlob('artwork/' + artFileOf(key), blob);
      where = 'sidecar';
      memHero.delete(key);
      void idbDel(ST_COVERS, IDB_PREFIX + key);
    } catch (e) {
      logErr('artwork', 'Could not write artwork/' + artFileOf(key) + ' in ' + folder.label + ' — keeping the cover in the browser cache', (e as Error).message);
    }
  }
  if (where === 'browser') await keepInBrowser(key, blob, px);
  void noteRequested(key, px, blob);
  invalidateHero(key);
  await storeCover(key, blob, true);
  return where;
}

/* ---------- covers accepted in a catalog review ----------
   repair.ts puts the accepted blob in the thumb cache and, on a writable
   folder, writes artwork/ itself. Read-only folders get the browser copy
   here; a writable folder whose write failed is caught a moment later. */
onCoverStored((key, blob) => {
  const px = catalogRequestedPx(blob);
  if (!px) return;
  const folder = primaryFolderOf(key);
  if (!folder || folder.capability !== 'readwrite') {
    void keepInBrowser(key, blob, px).then(() => {
      invalidateHero(key);
      void noteRequested(key, px, blob);
    });
    return;
  }
  setTimeout(() => {
    void folder.backend
      .readSidecarBlob('artwork/' + artFileOf(key))
      .catch(() => null)
      .then(async (onDisk) => {
        if (!onDisk || !onDisk.size) {
          logErr('artwork', 'The accepted cover did not reach the sidecar — keeping it in the browser cache', artFileOf(key));
          await keepInBrowser(key, blob, px);
        }
        void noteRequested(key, px, blob);
        invalidateHero(key); /* forget the "no sidecar file" answer from before the write */
        scheduleHeroUpgrade();
      });
  }, 3000);
});

setHeroIdbSource(async (key) => {
  const b = await browserHero(key);
  return b ? { blob: b, source: 'idb' } : null;
});

/* ---------- fetching one album's cover ---------- */

function collectionOf(al: Album): { folderId: string; id: number } | null {
  const seen: string[] = [];
  for (const t of al.tracks) {
    if (seen.indexOf(t.folderId) >= 0) continue;
    seen.push(t.folderId);
    const id = collectionIdFor(t.folderId, al.key);
    if (id) return { folderId: t.folderId, id: id };
  }
  return null;
}

type FetchResult = SizedArtwork | 'no-collection' | 'no-url' | null;

async function fetchCatalogCover(al: Album, sizes: number[]): Promise<FetchResult> {
  const c = collectionOf(al);
  if (!c) return 'no-collection';
  const folder = folderById(c.folderId);
  if (!folder) return 'no-collection';
  const url100 = await artworkUrlFor(folder, c.id);
  if (!url100) return 'no-url';
  return fetchArtworkSized(url100, sizes, paceArtRequest);
}

/* ---------- lazy upgrade: an album opened or played at a level its
   stored catalog cover is too small for ---------- */

const upgradeTried = new Map<string, number>();
let lazyChain: Promise<void> = Promise.resolve();

setHeroMintedHook((e) => {
  if (e.source === 'embedded') return;
  const want = catalogPxFor(e.quality);
  if (Math.max(e.nativeW, e.nativeH) >= want * 0.98) return;
  if ((upgradeTried.get(e.key) || 0) >= want) return;
  upgradeTried.set(e.key, want);
  const q = e.quality;
  lazyChain = lazyChain.then(async () => {
    if (redownloading || currentQuality() !== q) return;
    if ((await lastRequestedPx(e.key)) >= want) return; /* the catalog has nothing bigger */
    const al = S.albumMap[e.key];
    if (!al) return;
    const got = await fetchCatalogCover(al, levelOf(q).catalogPx);
    if (!got || typeof got === 'string') return;
    const where = await storeCatalogHero(al.key, got.blob, got.px);
    logErr('artwork', 'Upgraded the cover of ' + al.album + ' to ' + got.px + ' px', 'stored in the ' + (where === 'sidecar' ? 'sidecar artwork/ folder' : 'browser cache'));
    scheduleHeroUpgrade();
  }).catch((err: Error) => {
    logErr('artwork', 'A cover upgrade failed', err && err.message);
  });
});

/* ---------- the bulk re-download ---------- */

let redownloading = false;
let progressText = '';
let progressFn: ((text: string) => void) | null = null;

export function redownloadProgress(): string {
  return progressText;
}
export function onRedownloadProgress(fn: ((text: string) => void) | null): void {
  progressFn = fn;
}
function progress(text: string): void {
  progressText = text;
  if (progressFn) {
    try {
      progressFn(text);
    } catch {
      /* the settings view may be gone */
    }
  }
}

/** Albums whose cover came from the catalog (stored in the sidecar or the
    browser) — the covers the re-download refreshes. */
export async function catalogCoverAlbums(): Promise<Album[]> {
  const out: Album[] = [];
  for (const al of S.albums) {
    if (await catalogCoverBlob(al.key)) out.push(al);
  }
  return out;
}

export function redownloadRunning(): boolean {
  return redownloading;
}

/** Re-fetches every catalog cover at the current level through the paced
    queue, with progress in the activity log. */
export async function redownloadCatalogArtwork(): Promise<void> {
  if (redownloading) {
    toast('Artwork is already re-downloading — see the activity log');
    return;
  }
  redownloading = true;
  try {
    const q = currentQuality();
    const lvl = levelOf(q);
    const albums = await catalogCoverAlbums();
    if (!albums.length) {
      progress('No catalog covers in this library yet — covers come from “Match catalog” on an album page.');
      logErr('artwork', 'Re-download: no catalog-matched covers in this library', '');
      return;
    }
    const mins = Math.max(1, Math.ceil((albums.length * ART_GAP_MS) / 60000));
    logErr('artwork', 'Re-downloading ' + albums.length + ' catalog cover' + (albums.length === 1 ? '' : 's') + ' at ' + lvl.label + ' (' + lvl.catalogPx[0] + ' px)', 'paced to 20 a minute — about ' + mins + ' min');
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < albums.length; i++) {
      const al = albums[i];
      progress('Re-downloading ' + (i + 1) + ' / ' + albums.length + ' — ' + al.album);
      let got: FetchResult = null;
      try {
        got = await fetchCatalogCover(al, lvl.catalogPx);
      } catch (e) {
        logErr('artwork', 'Re-download failed for ' + al.album, (e as Error).message);
      }
      if (got === 'no-collection' || got === 'no-url') {
        skipped++;
        logErr('artwork', 'Re-download skipped ' + al.album, got === 'no-collection' ? 'no remembered catalog match — run Match catalog on it again' : 'the catalog entry has no artwork');
      } else if (!got) {
        failed++;
      } else {
        const where = await storeCatalogHero(al.key, got.blob, got.px);
        ok++;
        if ((i + 1) % 10 === 0 || i === albums.length - 1) {
          logErr('artwork', 'Re-download ' + (i + 1) + ' / ' + albums.length, 'latest: ' + al.album + ' at ' + got.px + ' px → ' + (where === 'sidecar' ? 'sidecar' : 'browser cache'));
        }
      }
    }
    const summary = ok + ' updated' + (failed ? ', ' + failed + ' failed' : '') + (skipped ? ', ' + skipped + ' skipped' : '');
    logErr('artwork', 'Artwork re-download finished: ' + summary, lvl.label + ' (' + lvl.catalogPx[0] + ' px)');
    progress('Done — ' + summary + '.');
    toast('Artwork re-download finished — ' + summary);
    scheduleHeroUpgrade();
  } finally {
    redownloading = false;
  }
}
