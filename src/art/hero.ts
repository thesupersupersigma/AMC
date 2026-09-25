/* The HERO artwork tier — album page header, Now Playing (cover and
   turntable label + sleeve), PiP, Media Session. Minted lazily at the
   size the Artwork quality setting allows; only the playing track's album
   and the open album page are held, everything else is revoked. This is
   where the old state.FULL slot went.

   Sources, in order:
     1. an accepted catalog cover — the sidecar's artwork/<album>.jpg, or
        (gate 2) its IndexedDB copy when the folder is read-only. It only
        exists when a catalog review accepted it, i.e. someone chose it
        over whatever the file carries.
     2. the art embedded in the file, read on demand (never stored twice).
   A source no larger than the level's size is used as its ORIGINAL bytes,
   never re-encoded; a larger one is resampled (createImageBitmap,
   resizeQuality 'high') to JPEG q0.92.

   Memory: at most the two pinned heroes plus the one being minted; decoded
   off the main thread where the browser can (img.decode()); nothing here
   is ever awaited by playback. */

import type { AnyTrack } from '../types';
import { S, coverBlob, setCoverHooks, storeCover } from '../state';
import { extractArt } from '../scan/scanner';
import { folderById } from '../fs/folders';
import { artFileOf } from '../fs/overrides';
import { logErr } from '../ui/log';
import { imageSize } from './imgsize';
import { decodedSize, downscaleBlob } from './resize';
import { thumbIsStale } from './thumbsize';
import { currentQuality, heroPxFor } from './quality';
import type { ArtQuality } from '../types';

export type HeroSource = 'embedded' | 'sidecar' | 'idb';

export interface HeroArt {
  key: string;
  url: string;
  blob: Blob;
  /** Real pixel size of `blob` — what Media Session declares. */
  w: number;
  h: number;
  quality: ArtQuality;
  source: HeroSource;
  /** True when `blob` is the source's own bytes, untouched. */
  original: boolean;
  /** The source's native size, before any downscale. */
  nativeW: number;
  nativeH: number;
}

const held = new Map<string, HeroArt>();
const inflight = new Map<string, Promise<HeroArt | null>>();
/** key → quality for which the album was found to have no art at all, so
    a 300 ms refresh loop never re-reads a file that has none. */
const noArt = new Map<string, ArtQuality>();
/** Albums whose sidecar has no artwork/ file — one failed lookup per session. */
const noSidecar = new Set<string>();

/* Heroes can still be on screen (a record sliding out, an album header
   mid-transition) and the Media Session keeps the URL it was handed: drop
   the reference now, revoke a few seconds later. */
const REVOKE_DELAY_MS = 4000;
function revokeLater(url: string): void {
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already gone */
    }
  }, REVOKE_DELAY_MS);
}

function keyOf(ref: string | AnyTrack | null | undefined): string {
  if (!ref) return '';
  return typeof ref === 'string' ? ref : ref.coverKey || '';
}

/** The album page currently open, if any. */
function pageKey(): string {
  const v = String(S.view || '');
  return v.indexOf('album:') === 0 ? v.slice(6) : '';
}

function pinned(key: string): boolean {
  return !!key && ((!!S.current && S.current.coverKey === key) || pageKey() === key);
}

/** Drops every held hero that is neither the playing album nor the open
    album page (the one just minted survives until the next trim). */
export function trimHeroes(keep?: string): void {
  for (const [k, e] of Array.from(held.entries())) {
    if (k === keep || pinned(k)) continue;
    held.delete(k);
    revokeLater(e.url);
  }
}

/** Diagnostics and tests: which albums' heroes are held right now. */
export function heldHeroKeys(): string[] {
  return Array.from(held.keys());
}

export function releaseAllHeroes(): void {
  for (const e of held.values()) revokeLater(e.url);
  held.clear();
  noArt.clear();
  noSidecar.clear();
}

/** Forget what we know about one album (its cover just changed). */
export function invalidateHero(key: string): void {
  noArt.delete(key);
  noSidecar.delete(key);
  const e = held.get(key);
  if (e) {
    held.delete(key);
    revokeLater(e.url);
  }
}

/** The held hero at the CURRENT quality level, or null. */
export function heroArt(ref: string | AnyTrack | null | undefined): HeroArt | null {
  const e = held.get(keyOf(ref));
  return e && e.quality === currentQuality() ? e : null;
}

/** Whatever hero is held for the album right now — possibly minted at a
    previous quality level. Display code shows this while a re-mint runs,
    so a level change never flashes back to the thumb. */
export function heroURLNow(ref: string | AnyTrack | null | undefined): string {
  const e = held.get(keyOf(ref));
  return e ? e.url : '';
}

/** A track of the album that can supply art: the given one if it carries
    a picture, else the first album track that does, else any with a file. */
function artTrackFor(key: string, prefer: AnyTrack | null): AnyTrack | null {
  if (prefer && prefer.file && prefer.hasArt) return prefer;
  const al = S.albumMap[key];
  if (al) {
    for (const t of al.tracks) if (t.file && t.hasArt) return t;
    for (const t of al.tracks) if (t.file) return t;
  }
  return prefer || null;
}

function albumFolderIds(key: string, t: AnyTrack | null): string[] {
  const ids: string[] = [];
  if (t) ids.push(t.folderId);
  const al = S.albumMap[key];
  if (al) for (const x of al.tracks) if (ids.indexOf(x.folderId) < 0) ids.push(x.folderId);
  return ids;
}

/* The catalog path (catalogart.ts) plugs in here: the IndexedDB fallback
   for folders whose sidecar is read-only, a listener for covers stored by
   a catalog review, and a hook that lazily upgrades a catalog cover stored
   below the current level. Registration, not imports, keeps the module
   graph acyclic. */
type StoredFn = (key: string, source: Blob) => void;
const storedFns: StoredFn[] = [];
export function onCoverStored(fn: StoredFn): void {
  storedFns.push(fn);
}
let mintedHook: ((e: HeroArt) => void) | null = null;
export function setHeroMintedHook(fn: (e: HeroArt) => void): void {
  mintedHook = fn;
}

type ExtraSource = (key: string) => Promise<{ blob: Blob; source: HeroSource } | null>;
let idbSource: ExtraSource | null = null;
export function setHeroIdbSource(fn: ExtraSource): void {
  idbSource = fn;
}

/** An accepted catalog cover for the album: sidecar first, then IDB. */
export async function catalogCoverBlob(key: string, t?: AnyTrack | null): Promise<{ blob: Blob; source: HeroSource } | null> {
  if (!noSidecar.has(key)) {
    for (const fid of albumFolderIds(key, t || null)) {
      const folder = folderById(fid);
      if (!folder) continue;
      try {
        const b = await folder.backend.readSidecarBlob('artwork/' + artFileOf(key));
        if (b && b.size) return { blob: b, source: 'sidecar' };
      } catch {
        /* unreadable — treated as absent */
      }
    }
    noSidecar.add(key);
  }
  if (idbSource) return idbSource(key);
  return null;
}

async function resolveSource(key: string, track: AnyTrack | null): Promise<{ blob: Blob; source: HeroSource } | null> {
  const t = artTrackFor(key, track);
  const cat = await catalogCoverBlob(key, t);
  if (cat) return cat;
  if (t && t.file && t.hasArt) {
    try {
      const b = await extractArt(t.file);
      if (b && b.size) return { blob: b, source: 'embedded' };
    } catch (e) {
      logErr('artwork', 'Could not read the cover in ' + (t.file ? t.file.name : t.path), (e as Error) && (e as Error).message);
    }
  }
  return null;
}

/* Migration, lazily: a thumb stored at an older display size (the fixed
   300 px of earlier versions) is rebuilt from the source we just read. */
async function maybeRefreshThumb(key: string, src: Blob, srcSize: { w: number; h: number } | null): Promise<void> {
  const cur = coverBlob(key);
  if (cur) {
    const cs = await imageSize(cur);
    if (!cs || !thumbIsStale(Math.max(cs.w, cs.h))) return;
    /* A source no bigger than the thumb cannot improve it. */
    if (srcSize && Math.max(srcSize.w, srcSize.h) <= Math.max(cs.w, cs.h)) return;
  }
  await storeCover(key, src, true);
}

async function mint(key: string, track: AnyTrack | null, q: ArtQuality): Promise<HeroArt | null> {
  const src = await resolveSource(key, track);
  if (!src) {
    noArt.set(key, q);
    return null;
  }
  let native: { w: number; h: number } | null = await imageSize(src.blob);
  void maybeRefreshThumb(key, src.blob, native).catch(() => undefined);
  if (!native) native = await decodedSize(src.blob);
  if (!native) {
    logErr('artwork', 'A cover could not be decoded', key);
    noArt.set(key, q);
    return null;
  }
  const target = heroPxFor(q);
  let blob = src.blob;
  let w = native.w;
  let h = native.h;
  let original = true;
  if (Math.max(native.w, native.h) > target) {
    try {
      const scaled = await downscaleBlob(src.blob, target, 'image/jpeg', 0.92, { w: native.w, h: native.h, type: src.blob.type });
      if (scaled) {
        blob = scaled.blob;
        w = scaled.w;
        h = scaled.h;
        original = false;
      }
    } catch (e) {
      logErr('artwork', 'Could not downscale a cover, showing the original', (e as Error) && (e as Error).message);
    }
  }
  const entry: HeroArt = {
    key: key,
    url: URL.createObjectURL(blob),
    blob: blob,
    w: w,
    h: h,
    quality: q,
    source: src.source,
    original: original,
    nativeW: native.w,
    nativeH: native.h,
  };
  const old = held.get(key);
  if (old) revokeLater(old.url);
  held.set(key, entry);
  trimHeroes(key);
  syncMediaSessionArt(entry);
  if (mintedHook) {
    try {
      mintedHook(entry);
    } catch {
      /* an upgrade check must never break the hero */
    }
  }
  return entry;
}

/* A hero minted (or re-minted after an upgrade or a level change) for the
   playing album replaces the Media Session artwork in place, with its real
   size — the OS controls never keep a stale or revoked image. */
function syncMediaSessionArt(e: HeroArt): void {
  if (!S.current || S.current.coverKey !== e.key || !('mediaSession' in navigator)) return;
  try {
    const md = navigator.mediaSession.metadata;
    if (!md || (md.artwork[0] && md.artwork[0].src === e.url)) return;
    md.artwork = [{ src: e.url, sizes: e.w + 'x' + e.h, type: e.blob.type || 'image/jpeg' }];
  } catch {
    /* metadata not settable here — player.ts publishes on the next track */
  }
}

/** The album's hero at the current quality — minted on first request,
    shared by every caller while it is in flight. Null when the album has
    no art anywhere. Never rejects. */
export function heroFor(ref: string | AnyTrack | null | undefined): Promise<HeroArt | null> {
  const key = keyOf(ref);
  if (!key) return Promise.resolve(null);
  const q = currentQuality();
  const have = held.get(key);
  if (have && have.quality === q) return Promise.resolve(have);
  if (noArt.get(key) === q) return Promise.resolve(null);
  const fk = key + '|' + q;
  let p = inflight.get(fk);
  if (!p) {
    const track = typeof ref === 'string' ? null : (ref as AnyTrack);
    p = mint(key, track, q)
      .catch((e: Error) => {
        logErr('artwork', 'Could not prepare the large cover', e && e.message);
        return null;
      })
      .finally(() => {
        inflight.delete(fk);
      });
    inflight.set(fk, p);
  }
  return p;
}

/** heroCoverURL(coverKey | track) → object URL of the hero image, '' when
    the album has no art. */
export function heroCoverURL(ref: string | AnyTrack | null | undefined): Promise<string> {
  return heroFor(ref).then((h) => (h ? h.url : ''));
}

/* ---------- DOM helpers ---------- */

/** Swaps an <img> to `url` only once the image is decoded, so a large
    hero never paints half-loaded or stalls a frame. */
export function setImgDecoded(img: HTMLImageElement, url: string): void {
  if (!url) {
    img.removeAttribute('src');
    delete img.dataset.heroPending;
    return;
  }
  if (img.getAttribute('src') === url || img.dataset.heroPending === url) return;
  img.dataset.heroPending = url;
  const pre = new Image();
  pre.decoding = 'async';
  pre.src = url;
  const apply = (): void => {
    if (img.dataset.heroPending !== url) return;
    delete img.dataset.heroPending;
    img.src = url;
  };
  if (typeof pre.decode === 'function') pre.decode().then(apply, apply);
  else apply();
}

setCoverHooks({
  stored: (key, source) => {
    invalidateHero(key);
    for (const fn of storedFns) {
      try {
        fn(key, source);
      } catch {
        /* listeners degrade on their own */
      }
    }
  },
  release: () => releaseAllHeroes(),
});
