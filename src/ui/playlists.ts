/* Playlists.
   Membership is keyed on webkitRelativePath, never on the metadata cache
   key: re-tagging a file changes lastModified and would empty playlists. */

import type { MissingTrack, Playlist, PlaylistRec, RowTrack } from '../types';
import { S, haveCover, coverURL, isMissingTrack } from '../state';
import { ST_PLAYLISTS, idbAll, idbDel, idbPut } from '../db/idb';
import { logErr } from './log';
import { icon, solid, artHTML } from './icons';
import { esc, fmtTotal, plural, toast, uuid, clamp } from '../util';
import { emptyNote, render } from './render';
import { songTable } from './songs';

/* Sidebar editing state: the new-playlist input, an in-place rename, and the
   inline delete confirmation. Owned here, rendered by sidebar.ts. */
export const plEdit = { newOpen: false, renamingId: '', confirmDeleteId: '' };

export function loadPlaylists(): Promise<void> {
  return idbAll<PlaylistRec>(ST_PLAYLISTS).then((rows) => {
    S.playlists = (rows || []).filter((p) => p && p.id && p.name);
    S.playlists.forEach((p) => {
      if (!Array.isArray(p.paths)) p.paths = [];
    });
    S.playlists.sort((a, b) => (a.created || 0) - (b.created || 0));
  });
}

export function playlistById(id: string): Playlist | null {
  for (let i = 0; i < S.playlists.length; i++) {
    if (S.playlists[i].id === id) return S.playlists[i];
  }
  return null;
}

export function savePlaylist(pl: Playlist): Promise<unknown> {
  pl.updated = Date.now();
  return idbPut(ST_PLAYLISTS, { id: pl.id, name: pl.name, paths: pl.paths.slice(), created: pl.created, updated: pl.updated });
}

export function createPlaylist(name: string, paths: string[]): Promise<Playlist> {
  const pl: Playlist = {
    id: uuid(),
    name: String(name || 'New Playlist').slice(0, 120),
    paths: (paths || []).slice(),
    created: Date.now(),
    updated: Date.now(),
  };
  S.playlists.push(pl);
  return savePlaylist(pl).then(() => pl);
}

export function deletePlaylist(id: string): Promise<void> {
  const i = S.playlists.findIndex((p) => p.id === id);
  if (i < 0) return Promise.resolve();
  const name = S.playlists[i].name;
  S.playlists.splice(i, 1);
  if (S.view === 'playlist:' + id) S.view = 'albums';
  return idbDel(ST_PLAYLISTS, id).then(() => {
    toast('Deleted the playlist ' + name);
  });
}

export function addPathsToPlaylist(id: string, paths: string[]): Promise<void> {
  const pl = playlistById(id);
  if (!pl || !paths.length) return Promise.resolve();
  let dupes = 0;
  for (let i = 0; i < paths.length; i++) {
    if (pl.paths.indexOf(paths[i]) >= 0) dupes++;
    pl.paths.push(paths[i]); /* duplicates are allowed */
  }
  return savePlaylist(pl).then(() => {
    let msg = 'Added ' + plural(paths.length, 'song', 'songs') + ' to ' + pl.name;
    if (dupes) msg += ' · ' + plural(dupes, 'was already there', 'were already there');
    toast(msg);
    render();
  });
}

export function removeAtFromPlaylist(id: string, index: number): Promise<void> {
  const pl = playlistById(id);
  if (!pl || index < 0 || index >= pl.paths.length) return Promise.resolve();
  pl.paths.splice(index, 1);
  return savePlaylist(pl).then(() => {
    render();
  });
}

export function movePlaylistRow(id: string, from: number, to: number): Promise<void> {
  const pl = playlistById(id);
  if (!pl) return Promise.resolve();
  if (from === to || from < 0 || from >= pl.paths.length) return Promise.resolve();
  const item = pl.paths.splice(from, 1)[0];
  if (to > from) to--;
  pl.paths.splice(clamp(to, 0, pl.paths.length), 0, item);
  return savePlaylist(pl).then(() => {
    render();
  });
}

/* Playlist rows resolve by path. A path that is not in the picked folder
   becomes a dimmed placeholder — never removed on its own. */
export function playlistTracks(pl: Playlist): RowTrack[] {
  const out: RowTrack[] = [];
  for (let i = 0; i < pl.paths.length; i++) {
    const p = pl.paths[i];
    const t = S.byPath[p];
    if (t) {
      out.push(t);
    } else {
      const name = p.split('/').pop() || p;
      const dot = name.lastIndexOf('.');
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
      };
      /* Resolvable by uid so selection and drag carry the path, but with no
         file behind it, so playback skips it. */
      S.byUid[ghost.uid] = ghost;
      out.push(ghost);
    }
  }
  return out;
}

export function playlistMosaicHTML(pl: Playlist): string {
  const keys: string[] = [];
  for (let i = 0; i < pl.paths.length && keys.length < 4; i++) {
    const t = S.byPath[pl.paths[i]];
    if (t && haveCover(t.coverKey) && keys.indexOf(t.coverKey) < 0) keys.push(t.coverKey);
  }
  if (keys.length >= 4) {
    return '<div class="mosaic">' + keys.slice(0, 4).map((k) => '<img src="' + esc(coverURL(k)) + '" alt="">').join('') + '</div>';
  }
  if (keys.length >= 1)
    return '<img src="' + esc(coverURL(keys[0])) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block">';
  return '<div class="ph">' + icon('note') + '</div>';
}

export function viewPlaylist(id: string): string {
  const pl = playlistById(id);
  if (!pl) return emptyNote('That playlist is gone', 'Pick another playlist in the sidebar, or make a new one.');
  const rows = playlistTracks(pl);
  const live = rows.filter((r) => !isMissingTrack(r));
  const missing = rows.length - live.length;
  const dur = live.reduce((s, t) => s + (t.duration || 0), 0);
  const meta = [
    plural(rows.length, 'song', 'songs'),
    fmtTotal(dur),
    missing ? plural(missing, 'not in this folder', 'not in this folder') : '',
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
    '</div>' +
    '</div>' +
    '</div>';
  if (!rows.length) {
    h += emptyNote('This playlist is empty', 'Drag songs onto it in the sidebar, or use the actions menu on any row to add them.');
  } else {
    h += songTable(rows, { context: 'playlist', playlistId: pl.id, reorder: true });
  }
  return h;
}

/* ---------- M3U ---------- */

function relPath(p: string): string {
  const i = String(p).indexOf('/');
  return i >= 0 ? String(p).slice(i + 1) : String(p); /* relative to the library root */
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
  toast('Exported ' + pl.name + ' as M3U');
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
  const paths: string[] = [];
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    if (/^[a-z]+:\/\//i.test(line)) continue; /* remote streams are not local files */
    const p = matchM3ULine(line);
    if (S.byPath[p]) matched++;
    paths.push(p);
  }
  if (!paths.length) {
    toast('That file listed no tracks');
    logErr('playlists', 'Imported M3U had no usable entries', filename);
    return;
  }
  const name = String(filename || 'Imported playlist').replace(/\.m3u8?$/i, '');
  void createPlaylist(name, paths).then((pl) => {
    S.view = 'playlist:' + pl.id;
    render();
    toast('Imported ' + pl.name + ' · ' + matched + ' of ' + paths.length + ' found in this folder');
  });
}
