/* Scanning: parse dispatch, the per-folder progressive scan loop (yields to
   the event loop every 8 files), duration backfill, and rescan. Folders scan
   one at a time through a queue; each scan replaces only that folder's
   tracks, then the whole library re-indexes and re-merges duplicates. */

import type { AnyTrack, ConnectedFolder, FileTrack, ParsedMeta, TrackRec } from '../types';
import { extOf } from '../parse/bytes';
import { parseFlac, flacPicture } from '../parse/flac';
import { parseMp4 } from '../parse/mp4';
import { parseId3 } from '../parse/id3';
import { S, albumKeyOf, editionOf, haveCover, refOf, releaseCovers, setCoverLocal, storeCover, rebuildIndex } from '../state';
import { ST_COVERS, ST_TRACKS, idbClear, idbGet, idbPut } from '../db/idb';
import { logErr } from '../ui/log';
import { $, tick, toast } from '../util';
import { render, scheduleRender } from '../ui/render';
import { restoreLastTrack } from '../ui/player';
import { adoptLegacyPlaylists, reflushFolderPlaylists } from '../ui/playlists';
import { applyDedupe } from './dedupe';
import { buildLibraryJson, queueSidecarWrite } from '../fs/amcdir';
import { connectedFolders, folderOrder } from '../fs/folders';
import { probe } from '../audio/engine';
import type { CoverRec } from '../types';

/* ---------- path fallback --------------------------------------------------
   Library paths are Root/Artist/Album/NN Title.ext.
   The library never shows "Unknown" — worst case it shows the folder names. */
export function fromPath(path: string, name: string): { title: string; album: string; artist: string; trackNo: number } {
  const parts = String(path || name).split('/');
  const fname = parts[parts.length - 1] || name;
  const dot = fname.lastIndexOf('.');
  let title = dot > 0 ? fname.slice(0, dot) : fname;
  let trackNo = 0;
  const m = title.match(/^\s*(\d{1,3})\s*(?:[-.)–]\s*|\s+)(.+)$/);
  if (m) {
    trackNo = parseInt(m[1], 10);
    title = m[2];
  }
  return {
    title: title.replace(/_/g, ' ').trim(),
    album: parts.length >= 2 ? parts[parts.length - 2] : '',
    artist: parts.length >= 3 ? parts[parts.length - 3] : '',
    trackNo: trackNo,
  };
}

function firstInt(s: string | undefined): number {
  if (!s) return 0;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}
function yearOf(s: string | undefined): string {
  if (!s) return '';
  const m = String(s).match(/\d{4}/);
  return m ? m[0] : '';
}

/** Bumped whenever a parser fix changes what lands in the cache. Rows
    stamped with an older (or missing) version re-parse once and heal.
    2 = mdhd-preferred MP4 durations + grown moov reads + codec/tagged. */
const PARSE_VERSION = 2;

/* ---------- one track ---------- */
export async function parseTrack(file: File, key: string, path: string): Promise<{ rec: TrackRec; meta: ParsedMeta }> {
  const ext = extOf(file.name);
  let p: Promise<ParsedMeta>;
  if (ext === 'flac') p = parseFlac(file);
  else if (ext === 'm4a' || ext === 'aac') p = parseMp4(file);
  else if (ext === 'mp3') p = parseId3(file);
  else p = Promise.resolve({ tags: {}, duration: 0, fmt: ext });

  const meta: ParsedMeta = (await p) || { tags: {}, duration: 0, fmt: ext };
  const t = meta.tags || {};
  const fb = fromPath(path, file.name);
  const artist = t['ARTIST'] || t['ALBUMARTIST'] || fb.artist || fb.album || 'Local Files';
  const albumArtist = t['ALBUMARTIST'] || t['ARTIST'] || fb.artist || artist;
  const album = t['ALBUM'] || fb.album || 'Singles';
  const title = t['TITLE'] || fb.title || file.name;
  const rec: TrackRec = {
    key: key,
    path: path,
    title: title,
    artist: artist,
    albumArtist: albumArtist,
    album: album,
    track: firstInt(t['TRACKNUMBER']) || fb.trackNo || 0,
    disc: firstInt(t['DISCNUMBER']) || 1,
    year: yearOf(t['DATE']),
    genre: t['GENRE'] || '',
    duration: meta.duration || 0,
    fmt: ext,
    size: file.size,
    added: file.lastModified || 0,
    hasArt: !!(meta.pic || (meta.pics && meta.pics.length)),
    coverKey: '',
    codec: meta.codec,
    tagged: !!(t['TITLE'] || t['ARTIST'] || t['ALBUMARTIST'] || t['ALBUM']),
    pv: PARSE_VERSION,
  };
  rec.coverKey = albumKeyOf(rec);
  return { rec: rec, meta: meta };
}

/* Pull artwork out of an already-parsed result, or re-parse just for art
   when a cached track's album cover is missing from the cover store. */
function artFromMeta(file: File, meta: ParsedMeta | null): Promise<Blob | null> {
  if (!meta) return Promise.resolve(null);
  if (meta.pic && meta.pic.blob) return Promise.resolve(meta.pic.blob);
  if (meta.pics && meta.pics.length) return flacPicture(file, meta.pics);
  return Promise.resolve(null);
}
export function extractArt(file: File): Promise<Blob | null> {
  const ext = extOf(file.name);
  let p: Promise<ParsedMeta>;
  if (ext === 'flac') p = parseFlac(file);
  else if (ext === 'm4a' || ext === 'aac') p = parseMp4(file);
  else if (ext === 'mp3') p = parseId3(file);
  else return Promise.resolve(null);
  return p.then((meta) => artFromMeta(file, meta));
}

/* ---------- scan ---------- */
let uidSeq = 0;

export function recToTrack(rec: TrackRec, folderId: string, file?: File): FileTrack {
  return {
    kind: 'file',
    uid: 't' + ++uidSeq,
    folderId: folderId,
    cacheKey: rec.key,
    path: rec.path,
    file: file,
    title: rec.title,
    artist: rec.artist,
    albumArtist: rec.albumArtist,
    album: rec.album,
    track: rec.track || 0,
    disc: rec.disc || 1,
    year: Number(rec.year) || 0,
    genre: rec.genre || '',
    duration: rec.duration || 0,
    fmt: rec.fmt || '',
    size: rec.size || 0,
    added: rec.added || 0,
    hasArt: !!rec.hasArt,
    /* Recomputed on every load — the key folds in the album folder, and
       rows cached by earlier versions carry older key shapes. */
    coverKey: albumKeyOf(rec),
    edition: editionOf(rec.path, rec.album),
    codec: rec.codec,
    tagged: rec.tagged,
    error: '',
  };
}

export function resetLibrary(): void {
  S.tracks = [];
  S.byUid = {};
  S.byRef = {};
  S.byPath = {};
  S.albums = [];
  S.albumMap = {};
  S.artists = [];
  S.artistMap = {};
  S.visible = [];
  S.sel = [];
  releaseCovers();
}

/** One finished index pass: merge duplicates across folders, rebuild. */
function reindexLibrary(): void {
  /* Keep S.tracks in folder order so first-wins lookups follow priority. */
  S.tracks.sort((a, b) => folderOrder(a.folderId) - folderOrder(b.folderId) || a.path.localeCompare(b.path));
  applyDedupe(S.tracks, folderOrder);
  rebuildIndex();
}

/* Folders scan strictly one at a time; the chain is the queue. */
let scanChain: Promise<void> = Promise.resolve();
let restoredOnce = false;

export function enqueueFolderScan(folder: ConnectedFolder): void {
  scanChain = scanChain
    .then(() => scanFolder(folder))
    .catch((e: Error) => {
      S.scanning = false;
      logErr('scan', "The scan of '" + folder.label + "' stopped early", e && e.message);
      reindexLibrary();
      updateScanChip();
      render();
    });
}

async function scanFolder(folder: ConnectedFolder): Promise<void> {
  const files = await folder.backend.listAudioFiles();
  /* Replace only this folder's rows; other folders keep playing. */
  S.tracks = S.tracks.filter((t) => t.folderId !== folder.folderId);

  if (!files.length) {
    toast("No playable audio in '" + folder.label + "'. Try the folder that holds the album folders.");
    logErr('scan', "'" + folder.label + "' had no files with a supported extension", '');
    reindexLibrary();
    render();
    return;
  }

  S.scanning = true;
  S.scanDone = 0;
  S.scanTotal = files.length;
  updateScanChip();
  render();

  const pendingCovers: Record<string, boolean> = {};

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx].file;
    const path = files[idx].path;
    const key = file.name + '|' + file.size + '|' + file.lastModified;

    /* Each file gets its own try/catch: one bad file must not stop the scan. */
    try {
      const cached = await idbGet<TrackRec>(ST_TRACKS, key);
      let r: { rec: TrackRec; meta: ParsedMeta | null };
      if (cached && cached.title && cached.pv === PARSE_VERSION) {
        cached.path = path; /* path can change between picks */
        r = { rec: cached, meta: null };
      } else {
        const parsed = await parseTrack(file, key, path);
        await idbPut(ST_TRACKS, parsed.rec);
        r = { rec: parsed.rec, meta: parsed.meta };
      }
      const t = recToTrack(r.rec, folder.folderId, file);
      S.tracks.push(t);
      S.byRef[refOf(t.folderId, t.path)] = t;
      if (!S.byPath[t.path]) S.byPath[t.path] = t;
      S.byUid[t.uid] = t;

      /* Cover art, deduplicated per album: only the first track of an album
         that actually carries a picture ever gets decoded. */
      if (t.hasArt && !haveCover(t.coverKey) && !pendingCovers[t.coverKey]) {
        pendingCovers[t.coverKey] = true;
        const got = idbGet<CoverRec>(ST_COVERS, t.coverKey).then((row) => {
          if (row && row.thumb) {
            setCoverLocal(t.coverKey, row.thumb);
            return null;
          }
          return r.meta ? artFromMeta(file, r.meta) : extractArt(file);
        });
        got
          .then((blob) => {
            if (!blob) return;
            return storeCover(t.coverKey, blob);
          })
          .then(() => {
            pendingCovers[t.coverKey] = false;
            scheduleRender();
          })
          .catch((e: Error) => {
            pendingCovers[t.coverKey] = false;
            logErr('artwork', 'Could not read the cover in ' + file.name, e && e.message);
          });
      } else if (t.hasArt && !haveCover(t.coverKey)) {
        void idbGet<CoverRec>(ST_COVERS, t.coverKey).then((row) => {
          if (row && row.thumb && !haveCover(t.coverKey)) {
            setCoverLocal(t.coverKey, row.thumb);
            scheduleRender();
          }
        });
      }
    } catch (e) {
      logErr('scan', 'Could not read ' + file.name, (e as Error) && (e as Error).message);
      /* Still show the file, using whatever the path tells us. */
      try {
        const fb = fromPath(path, file.name);
        const t2 = recToTrack(
          {
            key: key,
            path: path,
            title: fb.title || file.name,
            artist: fb.artist || fb.album || 'Local Files',
            albumArtist: fb.artist || 'Local Files',
            album: fb.album || 'Singles',
            track: fb.trackNo,
            disc: 1,
            year: '',
            genre: '',
            duration: 0,
            fmt: extOf(file.name),
            size: file.size,
            added: file.lastModified,
            hasArt: false,
            coverKey: '',
          },
          folder.folderId,
          file
        );
        t2.error = 'Tags could not be read';
        S.tracks.push(t2);
        S.byUid[t2.uid] = t2;
      } catch (e2) {
        logErr('scan', 'Skipped ' + file.name, (e2 as Error) && (e2 as Error).message);
      }
    }

    S.scanDone++;
    updateScanChip();
    /* Yield to the event loop every 8 files so the UI never blocks. */
    if (S.scanDone % 8 === 0) {
      reindexLibrary();
      render();
      await tick();
    }
  }

  S.scanning = false;
  reindexLibrary();
  updateScanChip();
  /* Legacy playlists (bare paths, no owner) adopt a real folder as soon as
     their tracks resolve — the Phase 1 'local' data becomes folder-qualified
     here and is persisted qualified. */
  adoptLegacyPlaylists();
  if (!restoredOnce) restoredOnce = restoreLastTrack();
  render();
  backfillDurations();

  /* library.json is large and regenerable: written on scan-complete only. */
  if (folder.capability === 'readwrite') {
    const rows = S.tracks.filter((t) => t.folderId === folder.folderId);
    queueSidecarWrite(folder, 'library.json', () => buildLibraryJson(folder.folderId, rows));
    /* Playlist files replayed before this scan carried bare #EXTINF lines;
       rewrite them now that their tracks resolve. */
    reflushFolderPlaylists(folder.folderId);
  }
}

export function updateScanChip(): void {
  const chip = $('#scanchip');
  if (!chip) return;
  if (S.scanning) {
    chip.hidden = false;
    $('#scanText').textContent = 'Scanning ' + S.scanDone + ' / ' + S.scanTotal;
  } else {
    chip.hidden = true;
  }
}

/* Durations we could not get from headers (MP3, and anything odd) are read
   from a hidden audio element after the scan, one at a time, then cached. */
let probing = false;
export function backfillDurations(): void {
  if (probing) return;
  const pending = S.tracks.filter((t) => !t.duration && t.file);
  if (!pending.length) return;
  probing = true;
  let i = 0;
  let url = '';

  function done(): void {
    probing = false;
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
      url = '';
    }
    scheduleRender();
  }
  function step(): void {
    if (i >= pending.length) return done();
    const t = pending[i++];
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        step();
      }
    }, 4000);
    probe.onloadedmetadata = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (isFinite(probe.duration) && probe.duration > 0) {
        t.duration = probe.duration;
        void idbGet<TrackRec>(ST_TRACKS, t.cacheKey).then((rec) => {
          if (rec) {
            rec.duration = t.duration;
            void idbPut(ST_TRACKS, rec);
          }
        });
      }
      if (i % 6 === 0) scheduleRender();
      setTimeout(step, 0);
    };
    probe.onerror = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      setTimeout(step, 0);
    };
    try {
      url = URL.createObjectURL(t.file as File);
      probe.src = url;
      probe.load();
    } catch {
      finished = true;
      clearTimeout(timer);
      setTimeout(step, 0);
    }
  }
  step();
}

/** Clears the parse and cover caches, then re-scans every connected folder
    in place. FSA folders re-enumerate from their handle; webkitdir folders
    re-parse the files they still hold — no re-pick needed within a session. */
export function rescanLibrary(): void {
  const folders = connectedFolders();
  if (!folders.length) {
    toast('Add a music folder first');
    return;
  }
  toast('Clearing the cache and starting over');
  void Promise.all([idbClear(ST_TRACKS), idbClear(ST_COVERS)]).then(() => {
    releaseCovers();
    logErr('library', 'Cache cleared by Rescan library', 'playlists were kept');
    for (const f of folders) enqueueFolderScan(f);
  });
}
