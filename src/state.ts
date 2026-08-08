/* App state, the library index, artwork caches, and preferences. */

import type { Album, AnyTrack, Artist, MetaRec, MissingTrack, Playlist, Prefs, RepeatMode, RowTrack, SortCol, Track } from './types';
import { $$, clamp, norm } from './util';
import { ST_COVERS, ST_META, idbGet, idbPut } from './db/idb';
import { logErr } from './ui/log';

/** Stored-data schema. 2 = real folderIds everywhere (the Phase 1 'local'
    placeholder is never persisted). Written to IDB meta and every sidecar
    settings.json; Phase 5's migration machinery keys off it. */
export const SCHEMA_VERSION = 2;

/* Track identity is folderId + path, never path alone. The separator is a
   control character no filesystem allows in names. */
const SEP = String.fromCharCode(1);
export function refOf(folderId: string, path: string): string {
  return folderId + SEP + path;
}

export interface AppState {
  tracks: AnyTrack[];
  byUid: Record<string, RowTrack>;
  /** refOf(folderId, path) → track. The canonical lookup. */
  byRef: Record<string, AnyTrack>;
  /** Bare path → track, first folder (by order) wins. Kept for legacy
      playlists, M3U matching and the Phase 1 lastPath pref. */
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
  tracks: [], byUid: {}, byRef: {}, byPath: {},
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

/** The album folder with the library-root segment stripped: the same album
    living in two differently-named roots ("Music/…" and "Backup/…") must
    group as one album, not two. Root-level files return ''. */
function albumKeyDirOf(path: string): string {
  const dir = albumDirOf(path);
  const i = dir.indexOf('/');
  return i < 0 ? '' : dir.slice(i + 1);
}

/** The directory path dominates album grouping: files in the same folder
    are the same album, whatever their ARTIST tags say — mixed or missing
    tags in one folder must not split it (2 tagged mp3s plus 11 untagged
    m4as in "Bad (1987) [Dolby Atmos] {Epic}/" are ONE album). Tags stay in
    the key only for root-level files, which have no folder of their own.
    Editions still separate because they live in different folders —
    Thriller and Thriller 25 keep distinct keys. */
export function albumKeyOf(rec: Pick<Track, 'albumArtist' | 'artist' | 'album'> & { path?: string }): string {
  const dir = rec.path ? albumKeyDirOf(rec.path) : '';
  if (dir) return 'dir||' + norm(dir);
  return 'tag||' + norm(rec.albumArtist || rec.artist) + '||' + norm(rec.album);
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

/* ---------- library index ---------- */

export function trackSort(a: AnyTrack, b: AnyTrack): number {
  if (a.disc !== b.disc) return a.disc - b.disc;
  if (a.track !== b.track) return a.track - b.track;
  return a.title.localeCompare(b.title);
}

/** The most common non-empty value, compared case-insensitively; ties go to
    the first seen. Returns '' when every value is empty. */
function majorityOf(values: string[]): string {
  const counts = new Map<string, { n: number; display: string }>();
  let best = '';
  let bestN = 0;
  for (const v of values) {
    if (!v) continue;
    const k = norm(v);
    const row = counts.get(k) || { n: 0, display: v };
    row.n++;
    counts.set(k, row);
    if (row.n > bestN) {
      bestN = row.n;
      best = row.display;
    }
  }
  return best;
}

export function rebuildIndex(): void {
  S.albumMap = {};
  S.albums = [];
  S.artistMap = {};
  S.artists = [];
  S.byRef = {};
  S.byPath = {};
  S.byUid = {};
  for (let i = 0; i < S.tracks.length; i++) {
    const t = S.tracks[i];
    S.byRef[refOf(t.folderId, t.path)] = t;
    /* First folder by order wins the bare-path lookup; S.tracks is kept in
       folder order by the scanner, and a shadowed copy never displaces its
       primary. */
    if (!S.byPath[t.path] || (S.byPath[t.path].shadowed && !t.shadowed)) S.byPath[t.path] = t;
    S.byUid[t.uid] = t;
    /* Shadowed duplicate copies stay reachable through byRef/byUid but are
       not library rows of their own. */
    if (t.shadowed) continue;
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
    if (t.added > al.added) al.added = t.added;
  }

  /* Display fields are derived per album, tag-derived values first: the
     album is keyed on its folder, so a folder holding 2 tagged mp3s and 11
     untagged m4as must show the tagged artist, not the fabricated
     path-fallback one. Rows cached before the `tagged` flag existed count
     as untagged and win only when nothing tagged exists. */
  for (const al of S.albums) {
    const tagged = al.tracks.filter((t) => t.tagged === true);
    const pool = tagged.length ? tagged : al.tracks;
    al.artist = majorityOf(pool.map((t) => t.albumArtist || t.artist)) || al.artist;
    al.album = majorityOf(pool.map((t) => t.album)) || al.album;
    const y = pool.find((t) => t.year > 0);
    if (y) al.year = y.year;
    al.edition = editionOf(al.tracks[0].path, al.album);
  }

  /* Artists group the derived album artists — a fabricated path-fallback
     artist on individual tracks never becomes an artist row of its own. */
  for (const al of S.albums) {
    const rk = norm(al.artist);
    let ar = S.artistMap[rk];
    if (!ar) {
      ar = S.artistMap[rk] = { key: rk, name: al.artist, albums: [], tracks: [] };
      S.artists.push(ar);
    }
    ar.albums.push(al);
    for (const t of al.tracks) ar.tracks.push(t);
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

/** The library rows: every track except shadowed duplicate copies. The
    copies stay reachable via byRef and the "Play from" menu — merged, not
    hidden — but they are never rows of their own. */
export function libraryTracks(): AnyTrack[] {
  return S.tracks.filter((t) => !t.shadowed);
}

/* ---------- codec support, learned by attempt --------------------------
   canPlayType answers from the codec string, not from whether this build
   has a decoder (the same ec-3 file reports "probably" in a chromium build
   that cannot play it), so nothing is ever gated on it. A fourcc becomes
   known-failing only after a genuine decode failure, for this session
   only; a later successful attempt clears it. ---------- */

const CODEC_LABELS: Record<string, string> = {
  mp4a: 'AAC',
  alac: 'Apple Lossless',
  'ec-3': 'Dolby Digital Plus (Atmos)',
  'ac-3': 'Dolby Digital',
  'ac-4': 'Dolby AC-4',
  drms: 'protected AAC (DRM)',
};

export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] || codec.toUpperCase();
}

const failedCodecs = new Set<string>();
const workingCodecs = new Set<string>();

export function isCodecFailed(codec?: string): boolean {
  return !!codec && failedCodecs.has(codec);
}

/** A decode succeeded: the fourcc is proven for this browser, and any
    earlier failure verdict is withdrawn. Returns true if one was. */
export function markCodecWorking(codec?: string): boolean {
  if (!codec) return false;
  workingCodecs.add(codec);
  return failedCodecs.delete(codec);
}

/** A genuine decode failure. The fourcc is marked unsupported for this
    session — unless another file with the same fourcc already played, in
    which case this is one broken file, not a missing decoder. Returns true
    when the fourcc is newly marked. */
export function markCodecFailed(codec?: string): boolean {
  if (!codec || workingCodecs.has(codec) || failedCodecs.has(codec)) return false;
  failedCodecs.add(codec);
  return true;
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

/* ---------- preferences ------------------------------------------------
   Global app preferences live in IndexedDB (canonical), with localStorage
   as a same-tick fallback for environments where the database is broken.
   folders.ts registers a mirror hook that copies them into the first
   folder's sidecar as a convenience copy. Every path is guarded. ---------- */

const PREF_KEY = 'tsss_player_prefs';

export const PREFS: Prefs = {};

function loadLocalPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch (e) {
    logErr('settings', 'Could not read saved settings', (e as Error).message);
    return {};
  }
}

let prefsMirror: ((prefs: Prefs) => void) | null = null;
export function setPrefsMirror(fn: (prefs: Prefs) => void): void {
  prefsMirror = fn;
}

export function currentPrefs(): Prefs {
  const cur = S.current;
  return {
    volume: S.volume,
    muted: S.muted,
    shuffle: S.shuffle,
    repeat: S.repeat,
    view: S.view,
    lastPath: cur ? cur.path : '',
    lastRef: cur ? { folderId: cur.folderId, path: cur.path } : undefined,
    lastPos: S.lastPos || 0,
    sort: S.sort,
  };
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;
export function savePrefs(): void {
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const prefs = currentPrefs();
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch (e) {
      logErr('settings', 'Could not save settings', (e as Error).message);
    }
    void idbPut(ST_META, { key: 'app', schemaVersion: SCHEMA_VERSION, prefs: prefs } as MetaRec);
    if (prefsMirror) {
      try {
        prefsMirror(prefs);
      } catch (e) {
        logErr('settings', 'Could not mirror settings to the sidecar', (e as Error).message);
      }
    }
  }, 300);
}

/** Reads prefs — IndexedDB meta first, localStorage fallback — and seeds S.
    Call after idbOpen. Also stamps the meta schemaVersion on first run. */
export async function seedStateFromPrefs(): Promise<void> {
  const meta = await idbGet<MetaRec>(ST_META, 'app');
  const stored = meta && meta.prefs ? meta.prefs : loadLocalPrefs();
  if (!meta) {
    /* First run on the v2 schema: adopt whatever localStorage had and stamp
       the schema version so Phase 5 has a baseline to migrate from. */
    void idbPut(ST_META, { key: 'app', schemaVersion: SCHEMA_VERSION, prefs: stored } as MetaRec);
  }
  Object.assign(PREFS, stored);
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
