/* Phase 4c — lyrics sources, in priority order:
   .AMC/lyrics/<path>.lrc → a sibling .lrc → the LYRICS/UNSYNCEDLYRICS tag
   → LRCLIB through /api/lrclib (never the upstream directly). A network
   hit is written to the sidecar immediately, so every later open works
   offline. Nothing here runs during a scan — lyrics resolve only for the
   track being looked at. */

import type { AnyTrack, LrcLine } from '../types';
import { parseLrc, isSynced } from '../parse/lrc';
import { legacyCueKey, queueSidecarWrite, stableTrackKey } from '../fs/amcdir';
import { folderById } from '../fs/folders';
import { S, refOf } from '../state';
import { norm } from '../util';
import { logErr } from '../ui/log';

export interface ResolvedLyrics {
  lines: LrcLine[];
  synced: boolean;
  /** Where they came from — shown in the panel header. */
  source: 'sidecar' | 'sibling' | 'tag' | 'lrclib';
  raw: string;
}

/* Sibling .lrc files ride along in the scan listing; the scanner registers
   them here, replacing a folder's set on every scan. */
const siblingLrc = new Map<string, File>();

export function registerSiblingLrcs(folderId: string, files: Array<{ path: string; file: File }>): void {
  for (const key of Array.from(siblingLrc.keys())) {
    if (key.indexOf(refOf(folderId, '')) === 0) siblingLrc.delete(key);
  }
  for (const f of files) siblingLrc.set(refOf(folderId, norm(f.path)), f.file);
}

function siblingFor(t: AnyTrack): File | null {
  if (t.kind === 'virtual') return null; /* one .lrc beside a vinyl side is not per-track */
  const base = t.path.replace(/\.[^./]+$/, '');
  return siblingLrc.get(refOf(t.folderId, norm(base + '.lrc'))) || null;
}

export function sidecarLyricsRel(t: AnyTrack): string {
  return 'lyrics/' + stableTrackKey(t) + '.lrc';
}

/** Read fallback for folders still on v2 keys (read-only, unmigratable). */
function legacyLyricsRel(t: AnyTrack): string | null {
  const k = legacyCueKey(t);
  return k ? 'lyrics/' + k + '.lrc' : null;
}

/* One verdict per track per session — a 404 must not refetch on every
   track change. The editor invalidates after a save. */
const cache = new Map<string, ResolvedLyrics | null>();

export function invalidateLyrics(t: AnyTrack): void {
  cache.delete(refOf(t.folderId, t.path));
}

/** Stores editor output: sidecar write-through plus cache refresh. */
export function saveLyrics(t: AnyTrack, raw: string): boolean {
  const folder = folderById(t.folderId);
  if (!folder) return false;
  queueSidecarWrite(folder, sidecarLyricsRel(t), () => raw);
  const lines = parseLrc(raw);
  cache.set(refOf(t.folderId, t.path), lines.length ? { lines: lines, synced: isSynced(lines), source: 'sidecar', raw: raw } : null);
  return true;
}

interface LrclibRow {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  trackName?: string;
  artistName?: string;
  duration?: number;
}

async function fetchLrclib(t: AnyTrack): Promise<string | null> {
  const dur = Math.round(t.duration || 0);
  const qs = (extra: string): string =>
    extra + 'artist_name=' + encodeURIComponent(t.artist) + '&track_name=' + encodeURIComponent(t.title);
  try {
    const get = await fetch('/api/lrclib/api/get?' + qs('') + '&album_name=' + encodeURIComponent(t.album) + '&duration=' + dur, {
      headers: { accept: 'application/json' },
    });
    if (get.ok) {
      const row = (await get.json()) as LrclibRow;
      const text = row.syncedLyrics || row.plainLyrics;
      if (text) return text;
    }
    /* No exact match — search, then take the closest duration that has
       synced lyrics (vinyl timings drift a few seconds from the CD). */
    const sr = await fetch('/api/lrclib/api/search?' + qs(''), { headers: { accept: 'application/json' } });
    if (!sr.ok) return null;
    const rows = (await sr.json()) as LrclibRow[];
    const usable = rows.filter(
      (r) =>
        (r.syncedLyrics || r.plainLyrics) &&
        norm(r.trackName || '') === norm(t.title) &&
        norm(r.artistName || '') === norm(t.artist) &&
        (!dur || !r.duration || Math.abs(r.duration - dur) <= 15)
    );
    usable.sort((a, b) => {
      const syncDelta = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
      if (syncDelta) return syncDelta;
      return Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur);
    });
    const best = usable[0];
    return best ? best.syncedLyrics || best.plainLyrics || null : null;
  } catch (e) {
    logErr('lyrics', 'LRCLIB could not be reached for ' + t.title, (e as Error).message);
    return null;
  }
}

/** The source chain. Returns null when every source came up empty. */
export async function resolveLyrics(t: AnyTrack): Promise<ResolvedLyrics | null> {
  if (S.lyricsSource === 'off') return null;
  const key = refOf(t.folderId, t.path);
  if (cache.has(key)) return cache.get(key) || null;

  let result: ResolvedLyrics | null = null;
  const folder = folderById(t.folderId);

  /* 1 — the sidecar copy: offline forever once anything else has hit. */
  if (folder) {
    let text = await folder.backend.readSidecarText(sidecarLyricsRel(t));
    if (!text) {
      const legacy = legacyLyricsRel(t);
      if (legacy) text = await folder.backend.readSidecarText(legacy);
    }
    if (text) {
      const lines = parseLrc(text);
      if (lines.length) result = { lines: lines, synced: isSynced(lines), source: 'sidecar', raw: text };
    }
  }

  /* 2 — a sibling .lrc next to the audio file. */
  if (!result) {
    const f = siblingFor(t);
    if (f) {
      try {
        const text = await f.text();
        const lines = parseLrc(text);
        if (lines.length) result = { lines: lines, synced: isSynced(lines), source: 'sibling', raw: text };
      } catch (e) {
        logErr('lyrics', 'Could not read the .lrc beside ' + t.title, (e as Error).message);
      }
    }
  }

  /* 3 — the LYRICS / UNSYNCEDLYRICS tag, captured at scan time. */
  if (!result && t.lyricsTag) {
    const lines = parseLrc(t.lyricsTag);
    if (lines.length) result = { lines: lines, synced: isSynced(lines), source: 'tag', raw: t.lyricsTag };
  }

  /* 4 — LRCLIB, once; the catch is inside fetchLrclib so offline is a
     quiet miss, not an error. What arrives is written to the sidecar.
     'Local sources only' stops the chain here. */
  if (!result && t.title && t.artist && S.lyricsSource === 'auto') {
    const text = await fetchLrclib(t);
    if (text) {
      const lines = parseLrc(text);
      if (lines.length) {
        result = { lines: lines, synced: isSynced(lines), source: 'lrclib', raw: text };
        if (folder) queueSidecarWrite(folder, sidecarLyricsRel(t), () => text);
      }
    }
  }

  cache.set(key, result);
  return result;
}
