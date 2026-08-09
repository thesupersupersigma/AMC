/* Metadata overrides (Phase 4): accepted catalog and AI corrections, merged
   over parsed tags at display time. Audio files are never modified; the
   parse cache keeps the file's real tags; overrides.json in the sidecar is
   the durable copy, with an IndexedDB journal row per folder so a
   read-only or disconnected folder loses nothing.

   Keys are folder-relative paths — no folderId, no absolute path — so an
   overrides.json written on one machine applies on any other. */

import type { AnyTrack, ConnectedFolder, Override, OverrideAlbums, OverrideRows, OverridesRec, SidecarOverrides } from '../types';
import { SCHEMA_VERSION, S, haveCover, refOf, setCoverLocal, storeCover } from '../state';
import { ST_OVERRIDES, idbGet, idbPut } from '../db/idb';
import { legacyCueKey, queueSidecarWrite, stableTrackKey, stripRoot } from './amcdir';
import { logErr } from '../ui/log';

interface FolderOverrides {
  rows: OverrideRows;
  albums: OverrideAlbums;
}

const byFolder = new Map<string, FolderOverrides>();

function emptyFor(folderId: string): FolderOverrides {
  let f = byFolder.get(folderId);
  if (!f) {
    f = { rows: {}, albums: {} };
    byFolder.set(folderId, f);
  }
  return f;
}

function parseSidecarOverrides(text: string, label: string): FolderOverrides | null {
  try {
    const raw = JSON.parse(text) as SidecarOverrides;
    if (!raw || typeof raw !== 'object' || !raw.rows || typeof raw.rows !== 'object') return null;
    return { rows: raw.rows, albums: raw.albums && typeof raw.albums === 'object' ? raw.albums : {} };
  } catch (e) {
    logErr('overrides', 'overrides.json in ' + label + ' is malformed and was ignored', (e as Error).message);
    return null;
  }
}

/** Loads a folder's overrides before its scan applies them. The sidecar is
    the source of truth; the journal row wins only while it is dirty (a
    write that never reached the sidecar), and re-flushes then. */
export async function loadFolderOverrides(folder: ConnectedFolder): Promise<void> {
  let journal: OverridesRec | undefined | null = null;
  try {
    journal = await idbGet<OverridesRec>(ST_OVERRIDES, folder.folderId);
  } catch {
    journal = null;
  }
  let chosen: FolderOverrides | null = null;
  let reflush = false;
  if (journal && journal.dirty) {
    chosen = { rows: journal.rows || {}, albums: journal.albums || {} };
    reflush = true;
  } else {
    const text = await folder.backend.readSidecarText('overrides.json');
    if (text != null) chosen = parseSidecarOverrides(text, folder.label);
    if (!chosen && journal) chosen = { rows: journal.rows || {}, albums: journal.albums || {} };
  }
  byFolder.set(folder.folderId, chosen || { rows: {}, albums: {} });
  if (reflush) persist(folder);
}

function buildSidecarJson(folderId: string): string {
  const f = emptyFor(folderId);
  const out: SidecarOverrides = { schemaVersion: SCHEMA_VERSION, rows: f.rows, albums: f.albums };
  return JSON.stringify(out, null, 1) + '\n';
}

function persist(folder: ConnectedFolder): void {
  const f = emptyFor(folder.folderId);
  const rec: OverridesRec = { folderId: folder.folderId, rows: f.rows, albums: f.albums, dirty: 1 };
  void idbPut(ST_OVERRIDES, rec);
  queueSidecarWrite(
    folder,
    'overrides.json',
    () => buildSidecarJson(folder.folderId),
    () => {
      void idbPut(ST_OVERRIDES, { folderId: folder.folderId, rows: f.rows, albums: f.albums } as OverridesRec);
    }
  );
}

/** Merges a track's override (if any) over its parsed tags, in place. The
    track object is display state — the parse cache underneath keeps the
    file's real tags, so an override is always reversible. */
export function applyOverrideToTrack(t: AnyTrack): void {
  const f = byFolder.get(t.folderId);
  if (!f) return;
  /* Stable key first; the v2 ordinal key answers only for folders that
     could not be migrated (read-only), never for new writes. */
  const legacy = legacyCueKey(t);
  const row = f.rows[stableTrackKey(t)] || (legacy ? f.rows[legacy] : undefined);
  if (!row || !row.fields) return;
  const fields = row.fields;
  if (fields.title != null) t.title = fields.title;
  if (fields.artist != null) t.artist = fields.artist;
  if (fields.albumArtist != null) t.albumArtist = fields.albumArtist;
  if (fields.album != null) t.album = fields.album;
  if (fields.track != null) t.track = fields.track;
  if (fields.disc != null) t.disc = fields.disc;
  if (fields.year != null) t.year = fields.year;
  if (fields.genre != null) t.genre = fields.genre;
  if (fields.edition != null) t.edition = fields.edition;
  /* Corrected values are authoritative — they must outvote path-fallback
     fabrications when the album derives its display artist and name. */
  if (fields.title != null || fields.artist != null || fields.albumArtist != null || fields.album != null) t.tagged = true;
}

/** Records accepted corrections: merges them into the folder's overrides,
    persists (journal + sidecar), and applies them to the live tracks. The
    caller reindexes and re-renders once, after all folders involved. */
export function recordOverrides(folder: ConnectedFolder, patches: Array<{ path: string; fields: Override['fields']; source: Override['source'] }>): void {
  if (!patches.length) return;
  const f = emptyFor(folder.folderId);
  const now = Date.now();
  for (const p of patches) {
    const live0 = S.byRef[refOf(folder.folderId, p.path)];
    const rel = live0 ? stableTrackKey(live0) : stripRoot(p.path);
    const prior = f.rows[rel];
    f.rows[rel] = {
      fields: prior ? { ...prior.fields, ...p.fields } : { ...p.fields },
      source: p.source,
      appliedAt: now,
    };
    const live = S.byRef[refOf(folder.folderId, p.path)];
    if (live) applyOverrideToTrack(live);
  }
  persist(folder);
}

/** v2→v3 migration: renames ordinal `#cueNN` rows to their stable keys.
    Returns how many rows moved; persists (journal + sidecar) when any did. */
export function rekeyOverrideRows(folder: ConnectedFolder, map: Map<string, string>): number {
  const f = byFolder.get(folder.folderId);
  if (!f) return 0;
  let moved = 0;
  for (const [oldKey, newKey] of map) {
    const row = f.rows[oldKey];
    if (!row) continue;
    if (!f.rows[newKey]) f.rows[newKey] = row;
    delete f.rows[oldKey];
    moved++;
  }
  if (moved) persist(folder);
  return moved;
}

export function overrideRowCount(folderId: string): number {
  const f = byFolder.get(folderId);
  return f ? Object.keys(f.rows).length : 0;
}

export function rememberAlbumCollection(folder: ConnectedFolder, albumKey: string, collectionId: number): void {
  const f = emptyFor(folder.folderId);
  f.albums[albumKey] = { collectionId: collectionId };
  persist(folder);
}

export function collectionIdFor(folderId: string, albumKey: string): number {
  const f = byFolder.get(folderId);
  const a = f && f.albums[albumKey];
  return a ? a.collectionId : 0;
}

/* ---------- sidecar artwork ------------------------------------------
   Accepted covers are written to .AMC/artwork/ under a name derived only
   from the album key (which is root-stripped and machine-neutral), so the
   file restores on any machine. ---------- */

export function artFileOf(albumKey: string): string {
  return albumKey.replace(/[^\w\-. ()&]/g, '_').slice(0, 140) + '.jpg';
}

/** After a scan: albums that still have no cover pick one up from the
    sidecar — this is what makes accepted artwork offline-forever. */
export async function restoreSidecarArtwork(folder: ConnectedFolder): Promise<void> {
  for (const al of S.albums) {
    if (haveCover(al.key)) continue;
    if (!al.tracks.length || al.tracks[0].folderId !== folder.folderId) continue;
    const blob = await folder.backend.readSidecarBlob('artwork/' + artFileOf(al.key));
    if (blob && blob.size) {
      setCoverLocal(al.key, blob);
      void storeCover(al.key, blob);
    }
  }
}
