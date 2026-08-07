/* App state, the library index, artwork caches, and preferences. */

import type { Album, AnyTrack, Artist, MissingTrack, Playlist, Prefs, RepeatMode, RowTrack, SortCol, Track } from './types';
import { $$, clamp, norm } from './util';
import { ST_COVERS, idbPut } from './db/idb';
import { logErr } from './ui/log';

/* Phase 1 is single-folder; every track carries this id so multi-folder
   support (Phase 2) lands without touching identity everywhere. */
export const FOLDER_ID = 'local';

export interface AppState {
  tracks: AnyTrack[];
  byUid: Record<string, RowTrack>;
  byPath: Record<string, AnyTrack>;
  albums: Album[];
  albumMap: Record<string, Album>;
  artists: Artist[];
  artistMap: Record<string, Artist>;
  playlists: Playlist[];
  view: string;
  prevView: string;
  q: string;
  sel: string[];
  visible: string[];
  baseQueue: AnyTrack[];
  queue: AnyTrack[];
  qi: number;
  current: AnyTrack | null;
  playing: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
  sort: { col: SortCol; dir: 1 | -1 };
  lastPos: number;
  scanning: boolean;
  scanDone: number;
  scanTotal: number;
  hasFolder: boolean;
}

export const S: AppState = {
  tracks: [], byUid: {}, byPath: {},
  albums: [], albumMap: {},
  artists: [], artistMap: {},
  playlists: [],
  view: 'albums',
  prevView: 'albums',
  q: '',
  sel: [],
  visible: [],
  baseQueue: [], queue: [], qi: -1,
  current: null, playing: false,
  shuffle: false, repeat: 'off',
  volume: 1, muted: false,
  sort: { col: 'title', dir: 1 },
  lastPos: 0,
  scanning: false, scanDone: 0, scanTotal: 0,
  hasFolder: false,
};

/* ---------- album / artist keys ---------- */

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** The folder that holds an album's files. Disc subfolders ("Disc 1", "CD2",
    "Side A"…) collapse into their parent so a multi-disc album stays one
    album rather than splitting per disc. */
export function albumDirOf(path: string): string {
  let dir = dirnameOf(path);
  const leaf = dir.slice(dir.lastIndexOf('/') + 1);
  if (/^(cd|disc|disk|side)[\s\-_.]*\w{0,3}$/i.test(leaf)) dir = dirnameOf(dir);
  return dir;
}

/** v1 keyed albums on tags alone, which collapsed two editions of the same
    album — Thriller and Thriller 25 both tag as "Michael Jackson||thriller"
    and became one 17-track album. Folding the album's own folder path into
    the key keeps editions apart; tracks with no path keep the old key. */
export function albumKeyOf(rec: Pick<Track, 'albumArtist' | 'artist' | 'album'> & { path?: string }): string {
  const base = norm(rec.albumArtist || rec.artist) + '||' + norm(rec.album);
  const dir = rec.path ? albumDirOf(rec.path) : '';
  return dir ? base + '||' + norm(dir) : base;
}

/** The folder name, when it differs from the album tag — "Thriller 25" on an
    album tagged "Thriller". Files sitting directly in the picked root have no
    album folder of their own, so they never get an edition. */
export function editionOf(path: string, album: string): string | undefined {
  const dir = albumDirOf(path);
  if (dir.indexOf('/') < 0) return undefined;
  const leaf = dir.slice(dir.lastIndexOf('/') + 1);
  return leaf && norm(leaf) !== norm(album) ? leaf : undefined;
}

export function artistKeyOf(rec: Pick<Track, 'albumArtist' | 'artist'>): string {
  return norm(rec.albumArtist || rec.artist);
}

/* ---------- library index ---------- */

export function trackSort(a: AnyTrack, b: AnyTrack): number {
  if (a.disc !== b.disc) return a.disc - b.disc;
  if (a.track !== b.track) return a.track - b.track;
  return a.title.localeCompare(b.title);
}

export function rebuildIndex(): void {
  S.albumMap = {};
  S.albums = [];
  S.artistMap = {};
  S.artists = [];
  S.byPath = {};
  S.byUid = {};
  for (let i = 0; i < S.tracks.length; i++) {
    const t = S.tracks[i];
    S.byPath[t.path] = t;
    S.byUid[t.uid] = t;
    const ak = t.coverKey;
    let al = S.albumMap[ak];
    if (!al) {
      al = S.albumMap[ak] = {
        key: ak,
        album: t.album,
        artist: t.albumArtist || t.artist,
        year: t.year,
        edition: t.edition,
        tracks: [],
        added: t.added,
      };
      S.albums.push(al);
    }
    al.tracks.push(t);
    if (!al.year && t.year) al.year = t.year;
    if (!al.edition && t.edition) al.edition = t.edition;
    if (t.added > al.added) al.added = t.added;

    const rk = artistKeyOf(t);
    let ar = S.artistMap[rk];
    if (!ar) {
      ar = S.artistMap[rk] = { key: rk, name: t.albumArtist || t.artist, albums: [], tracks: [] };
      S.artists.push(ar);
    }
    ar.tracks.push(t);
    if (ar.albums.indexOf(al) < 0) ar.albums.push(al);
  }
  for (let i = 0; i < S.albums.length; i++) S.albums[i].tracks.sort(trackSort);
  S.albums.sort((a, b) => {
    const c = a.artist.localeCompare(b.artist);
    return c !== 0 ? c : String(a.year || '').localeCompare(String(b.year || '')) || a.album.localeCompare(b.album);
  });
  S.artists.sort((a, b) => a.name.localeCompare(b.name));
}

export function albumDuration(al: Album): number {
  let s = 0;
  for (let i = 0; i < al.tracks.length; i++) s += al.tracks[i].duration || 0;
  return s;
}

export function isPlayableTrack(t: RowTrack | null | undefined): t is AnyTrack & { file: File } {
  return !!t && t.kind !== 'missing' && !!(t as AnyTrack).file;
}
export function isMissingTrack(t: RowTrack): t is MissingTrack {
  return t.kind === 'missing';
}

/* ---------- artwork — deduplicated per album, downscaled to ~300px WebP.
   Object URLs are minted lazily and always revoked. ---------- */

let COVERS: Record<string, { blob: Blob; url: string | null } | undefined> = {};
export const FULL: { key: string; url: string } = { key: '', url: '' };

export function haveCover(key: string): boolean {
  return !!(key && COVERS[key]);
}

export function coverURL(key: string): string {
  const c = COVERS[key];
  if (!c) return '';
  if (!c.url) c.url = URL.createObjectURL(c.blob);
  return c.url;
}

/** Used when a cover was found in the IndexedDB cover store. */
export function setCoverLocal(key: string, blob: Blob): void {
  COVERS[key] = { blob: blob, url: null };
}

export function releaseCovers(): void {
  const live: string[] = [];
  for (const k in COVERS) {
    const c = COVERS[k];
    if (c && c.url) live.push(c.url);
  }
  if (live.length) {
    /* Drop every reference before revoking, otherwise images still on screen
       try to reload a dead URL and the load fails noisily. */
    $$('img').forEach((im) => {
      if (live.indexOf(im.getAttribute('src') || '') >= 0) im.removeAttribute('src');
    });
  }
  for (let j = 0; j < live.length; j++) {
    try {
      URL.revokeObjectURL(live[j]);
    } catch {
      /* already gone */
    }
  }
  COVERS = {};
  releaseFullArt();
}

/* The Media Session holds the artwork URL after we hand it over, so revoking
   the previous one immediately makes the tray controls fetch a dead URL.
   Drop the reference now, reclaim the memory a moment later. */
export function releaseFullArt(): void {
  const old = FULL.url;
  FULL.key = '';
  FULL.url = '';
  if (!old) return;
  setTimeout(() => {
    try {
      URL.revokeObjectURL(old);
    } catch {
      /* already gone */
    }
  }, 1500);
}

function makeThumb(blob: Blob): Promise<Blob | null> {
  if (!blob) return Promise.resolve(null);
  if (typeof createImageBitmap !== 'function') return Promise.resolve(blob);
  return createImageBitmap(blob)
    .then((bmp) => {
      const max = 300;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (ctx) ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return new Promise<Blob>((res) => {
        try {
          c.toBlob(
            (out) => {
              res(out || blob);
            },
            'image/webp',
            0.82
          );
        } catch {
          res(blob);
        }
      });
    })
    .catch((e: Error) => {
      logErr('artwork', 'Could not resize a cover, keeping the original', e && e.message);
      return blob;
    });
}

export function storeCover(key: string, blob: Blob | null): Promise<void> {
  if (!key || !blob) return Promise.resolve();
  return makeThumb(blob)
    .then((thumb) => {
      if (!thumb) return;
      COVERS[key] = { blob: thumb, url: null };
      return idbPut(ST_COVERS, { key: key, thumb: thumb }).then(() => undefined);
    })
    .catch((e: Error) => {
      logErr('artwork', 'Could not save a cover', e && e.message);
    });
}

/* ---------- localStorage preferences — also fully guarded ---------- */

const PREF_KEY = 'tsss_player_prefs';

export const PREFS: Prefs = {};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch (e) {
    logErr('settings', 'Could not read saved settings', (e as Error).message);
    return {};
  }
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;
export function savePrefs(): void {
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        PREF_KEY,
        JSON.stringify({
          volume: S.volume,
          muted: S.muted,
          shuffle: S.shuffle,
          repeat: S.repeat,
          view: S.view,
          lastPath: S.current ? S.current.path : '',
          lastPos: S.lastPos || 0,
          sort: S.sort,
        })
      );
    } catch (e) {
      logErr('settings', 'Could not save settings', (e as Error).message);
    }
  }, 300);
}

export function seedStateFromPrefs(): void {
  Object.assign(PREFS, loadPrefs());
  S.volume = typeof PREFS.volume === 'number' ? clamp(PREFS.volume, 0, 1) : 1;
  S.muted = !!PREFS.muted;
  S.shuffle = !!PREFS.shuffle;
  S.repeat = PREFS.repeat === 'all' || PREFS.repeat === 'one' ? PREFS.repeat : 'off';
  S.view = PREFS.view || 'albums';
  if (S.view.split(':')[0] === 'search') S.view = 'albums';
  if (PREFS.sort && PREFS.sort.col) {
    const col = PREFS.sort.col;
    if (col === 'title' || col === 'artist' || col === 'album' || col === 'duration') {
      S.sort = { col: col, dir: PREFS.sort.dir === -1 ? -1 : 1 };
    }
  }
}
