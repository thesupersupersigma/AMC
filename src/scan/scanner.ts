/* Scanning: parse dispatch, the progressive scan loop (yields to the event
   loop every 8 files), duration backfill, and rescan. */

import type { FileTrack, ParsedMeta, TrackRec } from '../types';
import { extOf, isAudioFile, AUDIO_EXT } from '../parse/bytes';
import { parseFlac, flacPicture } from '../parse/flac';
import { parseMp4 } from '../parse/mp4';
import { parseId3 } from '../parse/id3';
import { FOLDER_ID, S, albumKeyOf, editionOf, haveCover, releaseCovers, setCoverLocal, storeCover, rebuildIndex } from '../state';
import { ST_COVERS, ST_TRACKS, idbClear, idbGet, idbPut } from '../db/idb';
import { logErr } from '../ui/log';
import { $, tick, toast } from '../util';
import { render, scheduleRender } from '../ui/render';
import { restoreLastTrack } from '../ui/player';
import { pickFolder } from '../fs/webkitdir';
import { probe } from '../audio/engine';
import type { CoverRec } from '../types';

/* ---------- path fallback --------------------------------------------------
   webkitRelativePath is Root/Artist/Album/NN Title.ext.
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

export function recToTrack(rec: TrackRec, file?: File): FileTrack {
  return {
    kind: 'file',
    uid: 't' + ++uidSeq,
    folderId: FOLDER_ID,
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
    /* Recomputed on every load — the fixed key folds in the folder path, and
       rows cached by v1 carry the old tag-only key. */
    coverKey: albumKeyOf(rec),
    edition: editionOf(rec.path, rec.album),
    error: '',
  };
}

export function resetLibrary(): void {
  S.tracks = [];
  S.byUid = {};
  S.byPath = {};
  S.albums = [];
  S.albumMap = {};
  S.artists = [];
  S.artistMap = {};
  S.visible = [];
  S.sel = [];
  releaseCovers();
}

export function onFilesPicked(fileList: FileList): void {
  const files: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    /* Skip anything that is not audio, silently. Folders hold stems,
       artwork, .DS_Store and session files we must never touch. */
    if (isAudioFile(fileList[i])) files.push(fileList[i]);
  }
  /* Without persistence ChromeOS can evict the service worker cache and
     IndexedDB, and the app one day simply fails to load. */
  try {
    if (navigator.storage && navigator.storage.persist) {
      void navigator.storage.persist().then((granted) => {
        if (!granted) logErr('storage', 'Persistent storage was not granted', 'the browser may evict caches under pressure');
      });
    }
  } catch {
    /* nothing to do — the cache simply stays evictable */
  }
  if (!files.length) {
    S.hasFolder = true;
    $('#empty').hidden = true;
    $('#app').hidden = false;
    $('#playerbar').hidden = false;
    resetLibrary();
    rebuildIndex();
    render();
    toast('No playable audio in that folder. Try the folder that holds the album folders.');
    logErr('scan', 'The chosen folder had no files with a supported extension', 'looked for ' + AUDIO_EXT.join(', '));
    return;
  }
  files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  void scanFiles(files);
}

export async function scanFiles(files: File[]): Promise<void> {
  S.hasFolder = true;
  $('#empty').hidden = true;
  $('#app').hidden = false;
  $('#playerbar').hidden = false;
  resetLibrary();

  S.scanning = true;
  S.scanDone = 0;
  S.scanTotal = files.length;
  updateScanChip();
  render();

  const pendingCovers: Record<string, boolean> = {};

  try {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      const path = file.webkitRelativePath || file.name;
      const key = file.name + '|' + file.size + '|' + file.lastModified;

      /* Each file gets its own try/catch: one bad file must not stop the scan. */
      try {
        const cached = await idbGet<TrackRec>(ST_TRACKS, key);
        let r: { rec: TrackRec; meta: ParsedMeta | null };
        if (cached && cached.title) {
          cached.path = path; /* path can change between picks */
          r = { rec: cached, meta: null };
        } else {
          const parsed = await parseTrack(file, key, path);
          await idbPut(ST_TRACKS, parsed.rec);
          r = { rec: parsed.rec, meta: parsed.meta };
        }
        const t = recToTrack(r.rec, file);
        S.tracks.push(t);
        S.byPath[t.path] = t;
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
            file
          );
          t2.error = 'Tags could not be read';
          S.tracks.push(t2);
          S.byPath[t2.path] = t2;
          S.byUid[t2.uid] = t2;
        } catch (e2) {
          logErr('scan', 'Skipped ' + file.name, (e2 as Error) && (e2 as Error).message);
        }
      }

      S.scanDone++;
      updateScanChip();
      /* Yield to the event loop every 8 files so the UI never blocks. */
      if (S.scanDone % 8 === 0) {
        rebuildIndex();
        render();
        await tick();
      }
    }

    S.scanning = false;
    rebuildIndex();
    updateScanChip();
    restoreLastTrack();
    render();
    backfillDurations();
  } catch (e) {
    S.scanning = false;
    logErr('scan', 'The scan stopped early', (e as Error) && (e as Error).message);
    rebuildIndex();
    updateScanChip();
    render();
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

export function rescanLibrary(): void {
  toast('Clearing the cache and starting over');
  void Promise.all([idbClear(ST_TRACKS), idbClear(ST_COVERS)]).then(() => {
    releaseCovers();
    logErr('library', 'Cache cleared by Rescan library', 'playlists were kept');
    pickFolder();
  });
}
