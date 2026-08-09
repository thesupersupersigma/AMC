/* Playlists.
   Membership keys on folderId + path, never on the metadata cache key:
   re-tagging a file changes lastModified and would empty every playlist.

   A playlist is owned by one folder and lives in that folder's
   .AMC/playlists/ as a real .m3u8 (IndexedDB is the cache and the write
   journal). Entries pointing at another folder are stored folder-qualified
   and render as "from <folder>"; when that folder isn't loaded they dim as
   unavailable. Legacy rows (v1/Phase 1 bare paths) are adopted by a real
   folder as soon as their tracks resolve. */

import type { AnyTrack, MissingTrack, Playlist, PlaylistEntry, PlaylistRec, RowTrack, ConnectedFolder } from '../types';
import { S, refOf, isMissingTrack } from '../state';
import { ST_PLAYLISTS, idbAll, idbDel, idbPut } from '../db/idb';
import { logErr } from './log';
import { icon, solid, artHTML } from './icons';
import { esc, fmtTotal, plural, toast, uuid, clamp } from '../util';
import { emptyNote, render } from './render';
import { songTable } from './songs';
import {
  buildPlaylistM3U,
  deleteSidecarFile,
  parsePlaylistM3U,
  playlistFileName,
  queueSidecarWrite,
} from '../fs/amcdir';
import { connectedFolders, firstWritableFolder, folderById, folderLabel } from '../fs/folders';
import { canUseFsa } from '../fs/adapter';

/* Sidebar editing state: the new-playlist input, an in-place rename, and the
   inline delete confirmation. Owned here, rendered by sidebar.ts. */
export const plEdit = { newOpen: false, renamingId: '', confirmDeleteId: '' };

/* ---------- load / normalize ---------- */

function normalizeRec(rec: PlaylistRec): Playlist {
  const entries: PlaylistEntry[] = rec.entries
    ? rec.entries.map((e) => ({ folderId: e.folderId || '', path: e.path }))
    : (rec.paths || []).map((p) => ({ folderId: '', path: p }));
  return {
    id: rec.id,
    name: rec.name,
    ownerFolderId: rec.ownerFolderId || '',
    entries: entries,
    created: rec.created,
    updated: rec.updated,
    dirty: !!rec.dirty,
    fileName: rec.fileName,
  };
}

function recOf(pl: Playlist): PlaylistRec {
  return {
    id: pl.id,
    name: pl.name,
    ownerFolderId: pl.ownerFolderId,
    entries: pl.entries.map((e) => ({ folderId: e.folderId, path: e.path })),
    created: pl.created,
    updated: pl.updated,
    dirty: pl.dirty ? 1 : 0,
    fileName: pl.fileName,
  };
}

export function loadPlaylists(): Promise<void> {
  return idbAll<PlaylistRec>(ST_PLAYLISTS).then((rows) => {
    S.playlists = (rows || []).filter((p) => p && p.id && p.name).map(normalizeRec);
    S.playlists.sort((a, b) => (a.created || 0) - (b.created || 0));
  });
}

export function playlistById(id: string): Playlist | null {
  for (let i = 0; i < S.playlists.length; i++) {
    if (S.playlists[i].id === id) return S.playlists[i];
  }
  return null;
}

/* ---------- resolution ---------- */

export function resolveEntry(e: PlaylistEntry): AnyTrack | undefined {
  /* Qualified lookup first. The bare-path fallback covers a folder whose id
     changed shape — e.g. a read-only session folder later re-added with
     write access mints a real id; its old wd-… entries must keep resolving. */
  if (e.folderId) return S.byRef[refOf(e.folderId, e.path)] || S.byPath[e.path];
  return S.byPath[e.path]; /* legacy bare path — first folder by order wins */
}

/** Owner for a new playlist: the folder of its first resolvable entry, else
    the first writable folder, else the first folder at all. */
function pickOwnerFolder(entries: PlaylistEntry[]): string {
  for (const e of entries) {
    const t = resolveEntry(e);
    if (t) return t.folderId;
    if (e.folderId) return e.folderId;
  }
  const w = firstWritableFolder();
  if (w) return w.folderId;
  const all = connectedFolders();
  return all.length ? all[0].folderId : '';
}

/* ---------- persistence: IndexedDB first, then the sidecar ---------- */

function flushToSidecar(pl: Playlist): void {
  const owner = folderById(pl.ownerFolderId);
  if (!owner) return; /* stays dirty in the journal until the owner loads */
  const newName = playlistFileName(pl);
  const oldName = pl.fileName;
  if (oldName && oldName !== newName) void deleteSidecarFile(owner, 'playlists/' + oldName);
  pl.fileName = newName;
  const id = pl.id;
  queueSidecarWrite(
    owner,
    'playlists/' + newName,
    () => {
      const cur = playlistById(id);
      if (!cur) return null; /* deleted between queue and flush */
      return buildPlaylistM3U(cur, folderLabel, resolveEntry);
    },
    () => {
      const cur = playlistById(id);
      if (!cur) return;
      cur.dirty = false;
      void idbPut(ST_PLAYLISTS, recOf(cur));
    }
  );
}

export function savePlaylist(pl: Playlist): Promise<unknown> {
  pl.updated = Date.now();
  pl.dirty = true;
  if (!pl.ownerFolderId) pl.ownerFolderId = pickOwnerFolder(pl.entries);
  if (!pl.fileName) pl.fileName = playlistFileName(pl);
  const put = idbPut(ST_PLAYLISTS, recOf(pl));
  flushToSidecar(pl);
  return put;
}

export function createPlaylist(name: string, entries: PlaylistEntry[]): Promise<Playlist> {
  const pl: Playlist = {
    id: uuid(),
    name: String(name || 'New Playlist').slice(0, 120),
    ownerFolderId: pickOwnerFolder(entries),
    entries: (entries || []).slice(),
    created: Date.now(),
    updated: Date.now(),
    dirty: true,
  };
  S.playlists.push(pl);
  return savePlaylist(pl).then(() => pl);
}

export function deletePlaylist(id: string): Promise<void> {
  const i = S.playlists.findIndex((p) => p.id === id);
  if (i < 0) return Promise.resolve();
  const pl = S.playlists[i];
  const name = pl.name;
  S.playlists.splice(i, 1);
  if (S.view === 'playlist:' + id) S.view = 'albums';
  const owner = folderById(pl.ownerFolderId);
  if (owner && pl.fileName) void deleteSidecarFile(owner, 'playlists/' + pl.fileName);
  return idbDel(ST_PLAYLISTS, id).then(() => {
    toast('Deleted the playlist ' + name);
  });
}

export function addEntriesToPlaylist(id: string, entries: PlaylistEntry[]): Promise<void> {
  const pl = playlistById(id);
  if (!pl || !entries.length) return Promise.resolve();
  let dupes = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (pl.entries.some((x) => x.folderId === e.folderId && x.path === e.path)) dupes++;
    pl.entries.push({ folderId: e.folderId, path: e.path }); /* duplicates are allowed */
  }
  return savePlaylist(pl).then(() => {
    let msg = 'Added ' + plural(entries.length, 'song', 'songs') + ' to ' + pl.name;
    if (dupes) msg += ' · ' + plural(dupes, 'was already there', 'were already there');
    toast(msg);
    render();
  });
}

export function removeAtFromPlaylist(id: string, index: number): Promise<void> {
  const pl = playlistById(id);
  if (!pl || index < 0 || index >= pl.entries.length) return Promise.resolve();
  pl.entries.splice(index, 1);
  return savePlaylist(pl).then(() => {
    render();
  });
}

export function movePlaylistRow(id: string, from: number, to: number): Promise<void> {
  const pl = playlistById(id);
  if (!pl) return Promise.resolve();
  if (from === to || from < 0 || from >= pl.entries.length) return Promise.resolve();
  const item = pl.entries.splice(from, 1)[0];
  if (to > from) to--;
  pl.entries.splice(clamp(to, 0, pl.entries.length), 0, item);
  return savePlaylist(pl).then(() => {
    render();
  });
}

/* ---------- rows ---------- */

/** Entries resolve to tracks; anything unresolved becomes a dimmed ghost —
    never removed on its own. Cross-folder ghosts say which folder they need. */
export function playlistTracks(pl: Playlist): RowTrack[] {
  const out: RowTrack[] = [];
  for (let i = 0; i < pl.entries.length; i++) {
    const e = pl.entries[i];
    const t = resolveEntry(e);
    if (t) {
      out.push(t);
    } else {
      const p = e.path;
      const name = p.split('/').pop() || p;
      const dot = name.lastIndexOf('.');
      const foreign = e.folderId && e.folderId !== pl.ownerFolderId;
      const label = e.folderId ? folderLabel(e.folderId) : '';
      const ghost: MissingTrack = {
        kind: 'missing',
        missing: true,
        uid: 'missing:' + i,
        path: p,
        title: dot > 0 ? name.slice(0, dot) : name,
        artist: '',
        album: p.split('/').slice(-2, -1)[0] || '',
        duration: 0,
        coverKey: '',
        error: '',
        note: foreign ? "from '" + (label || 'another folder') + "' — not loaded" : undefined,
      };
      /* Resolvable by uid so selection and drag carry the entry, but with no
         file behind it, so playback skips it. */
      S.byUid[ghost.uid] = ghost;
      out.push(ghost);
    }
  }
  return out;
}

export function playlistMosaicHTML(pl: Playlist): string {
  const keys: string[] = [];
  for (let i = 0; i < pl.entries.length && keys.length < 4; i++) {
    const t = resolveEntry(pl.entries[i]);
    if (t && t.coverKey && keys.indexOf(t.coverKey) < 0 && artHTML(t.coverKey).indexOf('<img') === 0) keys.push(t.coverKey);
  }
  if (keys.length >= 4) {
    return '<div class="mosaic">' + keys.slice(0, 4).map((k) => artHTML(k)).join('') + '</div>';
  }
  if (keys.length >= 1) {
    return artHTML(keys[0]).replace('<img ', '<img style="width:100%;height:100%;object-fit:cover;display:block" ');
  }
  return '<div class="ph">' + icon('note') + '</div>';
}

export function viewPlaylist(id: string): string {
  const pl = playlistById(id);
  if (!pl) return emptyNote('That playlist is gone', 'Pick another playlist in the sidebar, or make a new one.');
  const rows = playlistTracks(pl);
  const live = rows.filter((r) => !isMissingTrack(r));
  const missing = rows.length - live.length;
  const dur = live.reduce((s, t) => s + (t.duration || 0), 0);
  const ownerName = folderLabel(pl.ownerFolderId);
  const meta = [
    plural(rows.length, 'song', 'songs'),
    fmtTotal(dur),
    ownerName ? 'in ' + ownerName : '',
    missing ? plural(missing, 'unavailable', 'unavailable') : '',
  ]
    .filter(Boolean)
    .join(' · ');

  let h =
    '<div class="detail">' +
    '<div class="art">' + playlistMosaicHTML(pl) + '</div>' +
    '<div class="meta">' +
    '<h1 class="editable" data-edit-title="' + esc(pl.id) + '" tabindex="0" role="button" title="Rename this playlist">' + esc(pl.name) + '</h1>' +
    '<div class="by">Playlist</div>' +
    '<div class="dim">' + esc(meta) + '</div>' +
    '<div class="actions">' +
    '<button class="pill-play" type="button" data-playplaylist="' + esc(pl.id) + '">' + solid('play') + 'Play</button>' +
    '<button class="pill-ghost" type="button" data-shuffleplaylist="' + esc(pl.id) + '">' + icon('shuffle') + 'Shuffle</button>' +
    '<button class="pill-ghost" type="button" data-export="' + esc(pl.id) + '">' + icon('download') + 'Export M3U</button>' +
    (canUseFsa() ? '<button class="pill-ghost" type="button" data-exportfiles="' + esc(pl.id) + '" title="Copy the audio files themselves into a folder, numbered in playlist order">' + icon('folder') + 'Export files…</button>' : '') +
    '</div>' +
    '</div>' +
    '</div>';
  if (!rows.length) {
    h += emptyNote('This playlist is empty', 'Drag songs onto it in the sidebar, or use the actions menu on any row to add them.');
  } else {
    h += songTable(rows, {
      context: 'playlist',
      playlistId: pl.id,
      reorder: true,
      noteFor: (t) => {
        if (isMissingTrack(t)) return '';
        return t.folderId !== pl.ownerFolderId ? "from '" + (folderLabel(t.folderId) || 'another folder') + "'" : '';
      },
    });
  }
  return h;
}

/* ---------- M3U download / import ---------- */

function relPath(p: string): string {
  const i = String(p).indexOf('/');
  return i >= 0 ? String(p).slice(i + 1) : String(p); /* relative to the library root */
}

/** Phase 6: copy the playlist's actual audio into a chosen folder,
    numbered in playlist order — a real portable copy, unlike the M3U,
    which only writes a list of paths. Cue-carved tracks are skipped with a
    note: their audio lives inside a shared rip and copying it once per
    track would duplicate the whole side. */
export async function exportPlaylistFiles(id: string): Promise<void> {
  const pl = playlistById(id);
  if (!pl) return;
  if (!canUseFsa()) {
    toast('Copying files needs Chrome with folder access');
    return;
  }
  let dest: FileSystemDirectoryHandle;
  try {
    dest = await window.showDirectoryPicker!({ mode: 'readwrite', id: 'amc-export' });
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') logErr('playlists', 'The destination picker failed', (e as Error).message);
    return;
  }
  const rows = playlistTracks(pl);
  let pos = 0;
  let copied = 0;
  let skippedVirtual = 0;
  let failed = 0;
  for (const t of rows) {
    pos++;
    if (isMissingTrack(t) || !t.file) {
      failed++;
      continue;
    }
    if (t.kind === 'virtual') {
      skippedVirtual++;
      continue;
    }
    const name =
      (String(pos).padStart(2, '0') + ' - ' + (t.artist || 'Unknown') + ' - ' + (t.title || 'Track')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) +
      '.' + (t.fmt || 'bin');
    try {
      const fh = await dest.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(t.file);
      await w.close();
      copied++;
      if (copied % 3 === 0) toast('Copying… ' + copied + ' of ' + rows.length);
    } catch (e) {
      failed++;
      logErr('playlists', 'Could not copy ' + name, (e as Error).message);
    }
  }
  const bits = [plural(copied, 'file copied', 'files copied')];
  if (skippedVirtual) bits.push(skippedVirtual + ' cue track' + (skippedVirtual === 1 ? '' : 's') + ' skipped (they live inside a shared rip)');
  if (failed) bits.push(failed + ' failed — see the activity log');
  toast(bits.join(' · '));
}

export function exportM3U(id: string): void {
  const pl = playlistById(id);
  if (!pl) return;
  const rows = playlistTracks(pl);
  const lines = ['#EXTM3U'];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const secs = Math.round(t.duration || 0) || -1;
    lines.push('#EXTINF:' + secs + ',' + (t.artist || 'Unknown') + ' - ' + (t.title || ''));
    lines.push(relPath(t.path));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'audio/x-mpegurl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pl.name.replace(/[\\/:*?"<>|]/g, '_') + '.m3u8';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already gone */
    }
  }, 4000);
  const crossFolder = pl.entries.some((e) => e.folderId && e.folderId !== pl.ownerFolderId);
  if (crossFolder) {
    /* Relative paths cannot span two roots, so a cross-folder list is not
       portable outside AMC. Say so instead of exporting silently. */
    toast('Exported ' + pl.name + ' as M3U — songs from other folders will not resolve outside AMC');
  } else {
    toast('Exported ' + pl.name + ' as M3U');
  }
}

function matchM3ULine(line: string): string {
  const p = line.replace(/\\/g, '/').replace(/^\.\//, '');
  if (S.byPath[p]) return p;
  const suffix = '/' + p;
  const base = p.split('/').pop();
  let byBase = '';
  for (const k in S.byPath) {
    if (k === p || k.slice(-suffix.length) === suffix) return k;
    if (!byBase && k.split('/').pop() === base) byBase = k;
  }
  return byBase || p; /* unmatched paths are kept, shown dimmed */
}

export function importM3U(text: string, filename: string): void {
  const lines = String(text).split(/\r?\n/);
  const entries: PlaylistEntry[] = [];
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    if (/^[a-z]+:\/\//i.test(line)) continue; /* remote streams are not local files */
    const p = matchM3ULine(line);
    const t = S.byPath[p];
    if (t) matched++;
    entries.push({ folderId: t ? t.folderId : '', path: p });
  }
  if (!entries.length) {
    toast('That file listed no tracks');
    logErr('playlists', 'Imported M3U had no usable entries', filename);
    return;
  }
  const name = String(filename || 'Imported playlist').replace(/\.m3u8?$/i, '');
  void createPlaylist(name, entries).then((pl) => {
    S.view = 'playlist:' + pl.id;
    render();
    toast('Imported ' + pl.name + ' · ' + matched + ' of ' + entries.length + ' found in the library');
  });
}

/* ---------- sidecar reconcile + legacy adoption ---------- */

/** The sidecar is the source of truth; IndexedDB is the cache and the write
    journal. Dirty local rows replay onto disk; otherwise the newer side
    wins; sidecar files unknown locally are imported; local rows the sidecar
    no longer has (and that are clean) were deleted elsewhere and drop. */
export async function reconcileFolderPlaylists(folder: ConnectedFolder): Promise<void> {
  let names: string[] = [];
  try {
    names = (await folder.backend.listSidecarDir('playlists')).filter((n) => /\.m3u8?$/i.test(n));
  } catch (e) {
    logErr('sidecar', "Could not list playlists in '" + folder.label + "'", (e as Error).message);
    return;
  }
  const seenIds = new Set<string>();
  for (const fileName of names) {
    const text = await folder.backend.readSidecarText('playlists/' + fileName);
    if (text == null) continue;
    const parsed = parsePlaylistM3U(text, fileName, folder);
    const id = parsed.hadId ? parsed.id : uuid();
    seenIds.add(id);
    const local = playlistById(id);
    if (!local) {
      const pl: Playlist = {
        id: id,
        name: parsed.name,
        ownerFolderId: folder.folderId,
        entries: parsed.entries,
        created: parsed.created || Date.now(),
        updated: parsed.updated || Date.now(),
        dirty: false,
        fileName: fileName,
      };
      S.playlists.push(pl);
      void idbPut(ST_PLAYLISTS, recOf(pl));
      continue;
    }
    local.fileName = fileName;
    local.ownerFolderId = folder.folderId;
    if (local.dirty) {
      /* Journal replay: the browser copy has changes the disk never saw. */
      flushToSidecar(local);
    } else if (parsed.updated > local.updated) {
      local.name = parsed.name;
      local.entries = parsed.entries;
      local.updated = parsed.updated;
      void idbPut(ST_PLAYLISTS, recOf(local));
    } else if (local.updated > parsed.updated) {
      flushToSidecar(local);
    }
  }
  /* Local rows this folder owns that its sidecar no longer contains: if the
     row is clean and had been written before, it was deleted outside AMC. */
  const gone = S.playlists.filter(
    (p) => p.ownerFolderId === folder.folderId && !p.dirty && p.fileName && !seenIds.has(p.id) && names.indexOf(p.fileName) < 0
  );
  for (const p of gone) {
    const i = S.playlists.indexOf(p);
    if (i >= 0) S.playlists.splice(i, 1);
    void idbDel(ST_PLAYLISTS, p.id);
    logErr('playlists', "'" + p.name + "' was removed outside AMC and is gone from the library", p.fileName || '');
  }
  /* Journal replay: every dirty row this folder owns flushes now — including
     rows whose file was never written at all (created while the folder was
     away, or adopted from legacy data). This is the "nothing is lost to a
     permission prompt" half of write-through. */
  for (const p of S.playlists) {
    if (p.ownerFolderId === folder.folderId && p.dirty) flushToSidecar(p);
  }
  S.playlists.sort((a, b) => (a.created || 0) - (b.created || 0));
}

/** Rewrites a connected folder's playlist files once its tracks are indexed:
    a journal replay that ran before the scan wrote correct paths but bare
    #EXTINF lines (nothing was resolvable yet). Content-only; timestamps and
    dirty state are untouched. */
export function reflushFolderPlaylists(folderId: string): void {
  for (const pl of S.playlists) {
    if (pl.ownerFolderId === folderId && !pl.dirty && pl.fileName) flushToSidecar(pl);
  }
}

/** Legacy playlists (v1/Phase 1) have bare paths and no owner. The moment
    their tracks resolve against a real folder, entries become qualified,
    the playlist adopts that folder, and the qualified form is persisted —
    nothing keeps the Phase 1 'local' placeholder alive. */
export function adoptLegacyPlaylists(): void {
  for (const pl of S.playlists) {
    let changed = false;
    for (const e of pl.entries) {
      if (e.folderId) continue;
      const t = S.byPath[e.path];
      if (t) {
        e.folderId = t.folderId;
        changed = true;
      }
    }
    if (!pl.ownerFolderId) {
      const owner = pickOwnerFolder(pl.entries);
      if (owner) {
        pl.ownerFolderId = owner;
        changed = true;
      }
    }
    if (changed) void savePlaylist(pl);
  }
}
