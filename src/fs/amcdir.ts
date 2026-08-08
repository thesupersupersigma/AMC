/* The .AMC sidecar: file layout, settings.json / library.json builders, the
   playlist .m3u8 format, and the write-through autosave queue.

   The sidecar is the source of truth; IndexedDB is the cache and the write
   journal. Data is written to IndexedDB first (callers do that), then
   flushed here — debounced per file, ~500 ms of quiet — so a lapsed
   permission or a failed write loses nothing: the dirty row simply flushes
   when access returns. Audio files are never written to. Only the sidecar. */

import type { AnyTrack, ConnectedFolder, Playlist, PlaylistEntry, Prefs, SidecarLibrary, SidecarSettings } from '../types';
import { SCHEMA_VERSION } from '../state';
import { logErr } from '../ui/log';

export const SIDECAR_DIRS = ['playlists', 'cues', 'lyrics', 'artwork', 'catalog', 'peaks', 'notes', 'backups'];

/** Library paths are `<root>/<relative>`; sidecar files store the relative
    part so a folder stays self-contained and portable. */
export function stripRoot(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/* ---------- settings.json ---------- */

export async function readSettings(backend: ConnectedFolder['backend']): Promise<SidecarSettings | null> {
  const txt = await backend.readSidecarText('settings.json');
  if (!txt) return null;
  try {
    const s = JSON.parse(txt) as SidecarSettings;
    if (!s || typeof s.folderId !== 'string' || !s.folderId) return null;
    return s;
  } catch (e) {
    logErr('sidecar', 'settings.json in ' + backend.label + ' is malformed', (e as Error).message);
    return null;
  }
}

export function buildSettings(folderId: string, label: string, createdAt: number, appPrefs?: Prefs): string {
  const s: SidecarSettings = { schemaVersion: SCHEMA_VERSION, folderId: folderId, label: label, createdAt: createdAt };
  if (appPrefs) s.appPrefs = appPrefs;
  return JSON.stringify(s, null, 2) + '\n';
}

/* ---------- library.json — regenerable, written on scan-complete only ---------- */

export function buildLibraryJson(folderId: string, tracks: AnyTrack[]): string {
  const lib: SidecarLibrary = {
    schemaVersion: SCHEMA_VERSION,
    folderId: folderId,
    generatedAt: Date.now(),
    tracks: tracks.map((t) => ({
      path: stripRoot(t.path),
      title: t.title,
      artist: t.artist,
      albumArtist: t.albumArtist,
      album: t.album,
      track: t.track,
      disc: t.disc,
      year: t.year,
      genre: t.genre,
      duration: t.duration,
      fmt: t.fmt,
      size: t.size,
      added: t.added,
      hasArt: t.hasArt,
    })),
  };
  return JSON.stringify(lib, null, 1) + '\n';
}

/* ---------- playlist .m3u8 files ---------------------------------------
   Real M3U that VLC opens: own-folder entries are written relative to the
   file's location (../../ climbs out of .AMC/playlists/). AMC's own state
   rides in #AMC: comment lines, which every other player ignores. A
   cross-folder entry is preceded by #AMC:FOLDER and written as its full
   library path — it cannot resolve outside AMC, which is exactly the
   portability warning the export path surfaces. ---------- */

export function playlistFileName(pl: Playlist): string {
  const safe = pl.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'playlist';
  return safe + '.' + pl.id.slice(0, 8) + '.m3u8';
}

export function buildPlaylistM3U(pl: Playlist, labelOf: (folderId: string) => string, resolve: (e: PlaylistEntry) => AnyTrack | undefined): string {
  const lines = ['#EXTM3U'];
  lines.push('#AMC:SCHEMA:' + SCHEMA_VERSION);
  lines.push('#AMC:ID:' + pl.id);
  lines.push('#AMC:NAME:' + pl.name);
  lines.push('#AMC:OWNER:' + pl.ownerFolderId);
  lines.push('#AMC:UPDATED:' + pl.updated);
  lines.push('#AMC:CREATED:' + pl.created);
  for (let i = 0; i < pl.entries.length; i++) {
    const e = pl.entries[i];
    const t = resolve(e);
    const secs = t ? Math.round(t.duration || 0) || -1 : -1;
    const who = t ? (t.artist || 'Unknown') + ' - ' + (t.title || '') : stripRoot(e.path);
    lines.push('#EXTINF:' + secs + ',' + who);
    const foreign = e.folderId !== pl.ownerFolderId;
    if (foreign) {
      lines.push('#AMC:FOLDER:' + e.folderId + ':' + (labelOf(e.folderId) || ''));
      lines.push(e.path);
    } else {
      lines.push('../../' + stripRoot(e.path));
    }
  }
  return lines.join('\n') + '\n';
}

export interface ParsedSidecarPlaylist {
  id: string;
  name: string;
  ownerFolderId: string;
  created: number;
  updated: number;
  entries: PlaylistEntry[];
  fileName: string;
  /** False for a hand-made m3u8 with no #AMC:ID — imported as new. */
  hadId: boolean;
}

export function parsePlaylistM3U(text: string, fileName: string, folder: ConnectedFolder): ParsedSidecarPlaylist {
  const lines = String(text).split(/\r?\n/);
  const out: ParsedSidecarPlaylist = {
    id: '',
    name: fileName.replace(/\.[0-9a-f]{8}\.m3u8$/i, '').replace(/\.m3u8?$/i, ''),
    ownerFolderId: folder.folderId,
    created: 0,
    updated: 0,
    entries: [],
    fileName: fileName,
    hadId: false,
  };
  /* null = no directive; '' = an explicit FOLDER directive with an unknown
     folder (a legacy entry that never resolved) — its path must round-trip
     verbatim, not gain this folder's root. */
  let nextFolderId: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '#') {
      if (line.indexOf('#AMC:') === 0) {
        const body = line.slice(5);
        const c = body.indexOf(':');
        const key = c < 0 ? body : body.slice(0, c);
        const val = c < 0 ? '' : body.slice(c + 1);
        if (key === 'ID' && val) {
          out.id = val;
          out.hadId = true;
        } else if (key === 'NAME' && val) out.name = val;
        else if (key === 'UPDATED') out.updated = parseInt(val, 10) || 0;
        else if (key === 'CREATED') out.created = parseInt(val, 10) || 0;
        else if (key === 'FOLDER') {
          const c2 = val.indexOf(':');
          nextFolderId = c2 < 0 ? val : val.slice(0, c2);
        }
        /* OWNER is informational — the folder the file sits in owns it. */
      }
      continue;
    }
    if (/^[a-z]+:\/\//i.test(line)) continue; /* remote streams are not local files */
    if (nextFolderId !== null) {
      out.entries.push({ folderId: nextFolderId, path: line.replace(/\\/g, '/') });
      nextFolderId = null;
    } else {
      const rel = line.replace(/\\/g, '/').replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
      out.entries.push({ folderId: folder.folderId, path: folder.label + '/' + rel });
    }
  }
  return out;
}

/* ---------- autosave queue: write-through, not save-on-exit ---------- */

interface PendingWrite {
  folder: ConnectedFolder;
  relPath: string;
  provide: () => string | null;
  onFlushed?: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingWrites = new Map<string, PendingWrite>();
const warnedReadOnly = new Set<string>();
const FLUSH_QUIET_MS = 500;

function writeKey(folderId: string, relPath: string): string {
  return folderId + String.fromCharCode(1) + relPath;
}

/** Schedules a sidecar write. The data is already durable in IndexedDB —
    this only flushes the text file, after ~500 ms of quiet per file, so a
    playlist drag never becomes a write storm. Read-only folders keep the
    data in the journal and say so once, instead of failing silently. */
export function queueSidecarWrite(
  folder: ConnectedFolder,
  relPath: string,
  provide: () => string | null,
  onFlushed?: () => void
): void {
  if (folder.capability !== 'readwrite') {
    if (!warnedReadOnly.has(folder.folderId)) {
      warnedReadOnly.add(folder.folderId);
      logErr('sidecar', "'" + folder.label + "' is read-only in this browser", 'changes are kept in the browser cache and will write to .AMC when the folder is added with write access');
    }
    return;
  }
  const key = writeKey(folder.folderId, relPath);
  const prior = pendingWrites.get(key);
  if (prior && prior.timer) clearTimeout(prior.timer);
  const entry: PendingWrite = { folder: folder, relPath: relPath, provide: provide, onFlushed: onFlushed, timer: null };
  entry.timer = setTimeout(() => {
    void flushOne(key);
  }, FLUSH_QUIET_MS);
  pendingWrites.set(key, entry);
}

async function flushOne(key: string): Promise<void> {
  const entry = pendingWrites.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  let text: string | null;
  try {
    text = entry.provide();
  } catch (e) {
    pendingWrites.delete(key);
    logErr('sidecar', 'Could not build ' + entry.relPath, (e as Error).message);
    return;
  }
  if (text == null) {
    /* The source row vanished between queue and flush (e.g. the playlist
       was deleted); nothing to write. */
    pendingWrites.delete(key);
    return;
  }
  try {
    await entry.folder.backend.writeSidecarText(entry.relPath, text);
    pendingWrites.delete(key);
    if (entry.onFlushed) entry.onFlushed();
  } catch (e) {
    /* Never treated as success: the entry stays pending and the row stays
       dirty in IndexedDB; the next save or reconnect retries. */
    logErr('sidecar', 'Could not write ' + entry.relPath + ' in ' + entry.folder.label, (e as Error).message);
  }
}

/** Flushes everything pending now — used when a folder reconnects. */
export async function flushPendingWrites(folderId?: string): Promise<void> {
  const keys = Array.from(pendingWrites.keys()).filter((k) => !folderId || k.indexOf(folderId + String.fromCharCode(1)) === 0);
  for (const k of keys) await flushOne(k);
}

/** Immediate sidecar file removal (playlist delete, rename cleanup). */
export async function deleteSidecarFile(folder: ConnectedFolder, relPath: string): Promise<void> {
  if (folder.capability !== 'readwrite') return;
  pendingWrites.delete(writeKey(folder.folderId, relPath));
  try {
    await folder.backend.removeSidecarFile(relPath);
  } catch (e) {
    logErr('sidecar', 'Could not remove ' + relPath + ' in ' + folder.label, (e as Error).message);
  }
}
