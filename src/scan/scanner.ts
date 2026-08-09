/* Scanning: parse dispatch, the per-folder progressive scan loop (yields to
   the event loop every 8 files), duration backfill, and rescan. Folders scan
   one at a time through a queue; each scan replaces only that folder's
   tracks, then the whole library re-indexes and re-merges duplicates. */

import type { AnyTrack, ConnectedFolder, CueSheet, CueTrack, FileTrack, ParsedMeta, TrackRec, VirtualTrack } from '../types';
import { extOf } from '../parse/bytes';
import { parseFlac, flacPicture } from '../parse/flac';
import { parseMp4 } from '../parse/mp4';
import { parseId3 } from '../parse/id3';
import { parseCueText, sheetFromFlacCue } from '../parse/cue';
import { S, albumKeyOf, editionOf, haveCover, refOf, releaseCovers, setCoverLocal, storeCover, rebuildIndex } from '../state';
import { ST_COVERS, ST_TRACKS, idbClear, idbGet, idbPut } from '../db/idb';
import { logErr } from '../ui/log';
import { $, norm, tick, toast } from '../util';
import { render, scheduleRender } from '../ui/render';
import { restoreLastTrack } from '../ui/player';
import { adoptLegacyPlaylists, reflushFolderPlaylists } from '../ui/playlists';
import { applyDedupe } from './dedupe';
import { detectSplitFlags } from './detect';
import { buildLibraryJson, queueSidecarWrite, stripRoot } from '../fs/amcdir';
import { applyOverrideToTrack, loadFolderOverrides, restoreSidecarArtwork } from '../fs/overrides';
import { registerSiblingLrcs } from '../net/lyrics';
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
    2 = mdhd-preferred MP4 durations + grown moov reads + codec/tagged.
    3 = FLAC CUESHEET block boundaries + embedded CUESHEET tag captured.
    4 = LYRICS/UNSYNCEDLYRICS tag captured for the lyrics pane. */
const PARSE_VERSION = 4;

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
    /* Lyrics ride in a tag on some rips; capped — a runaway tag must not
       bloat the cache row. */
    lyricsTag: (t['LYRICS'] || t['UNSYNCEDLYRICS'] || '').slice(0, 60000) || undefined,
    flacCue: meta.flacCue,
    cueText: t['CUESHEET'],
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
    lyricsTag: rec.lyricsTag,
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

/** One finished index pass: merge duplicates across folders, rebuild,
    re-flag unsplit-rip candidates. */
function reindexLibrary(): void {
  /* Keep S.tracks in folder order so first-wins lookups follow priority. */
  S.tracks.sort((a, b) => folderOrder(a.folderId) - folderOrder(b.folderId) || a.path.localeCompare(b.path));
  applyDedupe(S.tracks, folderOrder);
  rebuildIndex();
  detectSplitFlags();
}

/* ---------- cue attachment -------------------------------------------
   Sources, in priority order: the FLAC CUESHEET metadata block; a sibling
   .cue whose FILE line names the audio file; a sidecar cues/<path>.cue;
   the CUESHEET Vorbis comment. A cue produces VirtualTracks that appear as
   ordinary tracks, and the source file is hidden once a cue claims it — or
   the 42-minute blob shows up alongside its own contents. ---------- */

function baseNameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}
function dirNameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
/** A cue FILE reference, normalised for matching: case-insensitive, both
    path separators tolerated, any directory component ignored. */
function cueFileKey(name: string): string {
  const s = String(name).replace(/\\/g, '/');
  return norm(s.slice(s.lastIndexOf('/') + 1));
}

function makeVirtual(src: FileTrack, ct: CueTrack, sheet: CueSheet): VirtualTrack {
  const end = ct.endSec > 0 ? Math.min(ct.endSec, src.duration || ct.endSec) : src.duration || 0;
  const nn = String(ct.index).padStart(2, '0');
  return {
    kind: 'virtual',
    uid: 't' + ++uidSeq,
    folderId: src.folderId,
    path: src.path + '#cue' + nn,
    cacheKey: src.cacheKey + '#' + ct.index,
    sourcePath: src.path,
    startSec: ct.startSec,
    endSec: end,
    cueIndex: ct.index,
    file: src.file,
    title: ct.title || 'Track ' + nn,
    artist: ct.performer || sheet.performer || src.artist,
    /* An untagged source's album/artist are path fabrications; the cue's
       sheet-level TITLE and PERFORMER are the better fallback there. */
    albumArtist: src.tagged ? src.albumArtist : sheet.performer || ct.performer || src.albumArtist,
    album: src.tagged ? src.album : sheet.title || src.album,
    track: ct.index,
    disc: src.disc,
    year: src.year,
    genre: src.genre,
    duration: end > ct.startSec ? end - ct.startSec : 0,
    fmt: src.fmt,
    size: src.size,
    added: src.added,
    coverKey: src.coverKey,
    hasArt: src.hasArt,
    codec: src.codec,
    tagged: src.tagged || !!ct.title,
    edition: src.edition,
    error: '',
  };
}

/** Resolves each file track's cue (per the source priority), carves
    VirtualTracks, hides claimed sources, and records broken-cue reasons.
    Returns the virtuals to append to the library. */
async function attachCues(
  folder: ConnectedFolder,
  fileTracks: FileTrack[],
  cueFiles: Array<{ path: string; file: File }>,
  recByPath: Map<string, TrackRec>
): Promise<VirtualTrack[]> {
  /* Sidecar cue existence, one directory listing per album folder instead
     of one failed read per track. */
  const sidecarCues = new Set<string>();
  const dirs = new Set<string>();
  for (const t of fileTracks) dirs.add(dirNameOf(stripRoot(t.path)));
  for (const d of dirs) {
    try {
      const names = await folder.backend.listSidecarDir(d ? 'cues/' + d : 'cues');
      for (const n of names) if (/\.cue$/i.test(n)) sidecarCues.add((d ? d + '/' : '') + n);
    } catch {
      /* unreadable listing — sidecar cues in this dir just don't resolve */
    }
  }

  /* Sibling cues, parsed once each and grouped by directory. */
  const cuesByDir = new Map<string, Array<{ path: string; sheet: CueSheet | null; text: string }>>();
  for (const cf of cueFiles) {
    let text = '';
    try {
      text = await cf.file.text();
    } catch (e) {
      logErr('cue', 'Could not read ' + cf.path, (e as Error).message);
    }
    const sheet = text ? parseCueText(text, 'sibling') : null;
    const dir = dirNameOf(cf.path);
    const g = cuesByDir.get(dir) || [];
    g.push({ path: cf.path, sheet: sheet, text: text });
    cuesByDir.set(dir, g);
  }

  const virtuals: VirtualTrack[] = [];
  const claimedCues = new Set<string>();

  for (const t of fileTracks) {
    t.claimedByCue = false;
    t.cueError = undefined;
    const rec = recByPath.get(t.path);

    /* Gather EVERY available source, in priority order. Sources merge
       rather than rank: the FLAC block carries boundaries but never
       titles, and it must not shadow a sibling cue that has both. */
    const candidates: Array<{ sheet: CueSheet; source: CueSheet['source'] }> = [];
    let parseFailNote = '';

    if (rec && rec.flacCue) {
      const s = sheetFromFlacCue(rec.flacCue.starts, rec.flacCue.leadout, 'flac-block');
      if (s) candidates.push({ sheet: s, source: 'flac-block' });
    }
    /* A TRACK belongs to the FILE line preceding it: this file's candidate
       is the GROUP naming it, not the whole sheet — a per-track-file cue
       must never hand one file another file's track list. */
    const siblings = cuesByDir.get(dirNameOf(t.path)) || [];
    for (const c of siblings) {
      if (!c.sheet) continue;
      const g = c.sheet.files.find((x) => cueFileKey(x.file) === cueFileKey(baseNameOf(t.path)));
      if (g && g.tracks.length) {
        candidates.push({
          sheet: { file: g.file, title: c.sheet.title, performer: c.sheet.performer, tracks: g.tracks, files: [g], source: 'sibling' },
          source: 'sibling',
        });
        claimedCues.add(c.path);
        break;
      }
    }
    const rel = stripRoot(t.path) + '.cue';
    if (sidecarCues.has(rel)) {
      const text = await folder.backend.readSidecarText('cues/' + rel);
      if (text != null) {
        const s = parseCueText(text, 'sidecar');
        if (s) candidates.push({ sheet: s, source: 'sidecar' });
        else parseFailNote = 'The saved cue sheet failed to parse';
      }
    }
    if (rec && rec.cueText) {
      const s = parseCueText(rec.cueText, 'vorbis-tag');
      if (s) candidates.push({ sheet: s, source: 'vorbis-tag' });
      else if (!parseFailNote) parseFailNote = 'The embedded CUESHEET tag failed to parse';
    }

    if (!candidates.length) {
      if (parseFailNote) t.cueError = parseFailNote;
      continue;
    }

    /* Boundaries from the highest-priority source that has them (the first
       candidate — every parsed sheet has boundaries by construction);
       titles and performers from the highest-priority source that has
       THOSE, matched by position. */
    const boundaries = candidates[0];
    const titles = candidates.find((c) => c.sheet.tracks.some((x) => !!x.title)) || null;
    const performers = candidates.find((c) => !!c.sheet.performer || c.sheet.tracks.some((x) => !!x.performer)) || null;
    const merged: CueSheet = {
      file: boundaries.sheet.file,
      title: (titles && titles.sheet.title) || boundaries.sheet.title,
      performer: (performers && performers.sheet.performer) || boundaries.sheet.performer,
      source: boundaries.source,
      files: boundaries.sheet.files,
      tracks: boundaries.sheet.tracks.map((bt, i) => ({
        index: bt.index,
        startSec: bt.startSec,
        endSec: bt.endSec,
        pregapSec: bt.pregapSec,
        title: bt.title || (titles && titles.sheet.tracks[i] ? titles.sheet.tracks[i].title : ''),
        performer: bt.performer || (performers && performers.sheet.tracks[i] ? performers.sheet.tracks[i].performer : ''),
      })),
    };

    /* Ends resolve against the file duration; nonsense boundaries drop. */
    const dur = t.duration || 0;
    const usable = merged.tracks.filter((c) => c.startSec >= 0 && (dur === 0 || c.startSec < dur));
    if (usable.length === 1) {
      /* One TRACK for this FILE: the file already is the track. The cue
         entry is metadata — no virtual is carved and the file stays a
         library row of its own. */
      const ct = usable[0];
      if (ct.title) t.title = ct.title;
      const perf = ct.performer || merged.performer || '';
      if (perf) t.artist = perf;
      if (!t.tagged) {
        if (merged.performer) t.albumArtist = merged.performer;
        if (merged.title) t.album = merged.title;
      }
      if (!t.track && ct.index) t.track = ct.index;
      t.tagged = t.tagged || !!ct.title;
      logErr('cue', "Cue metadata applied to '" + baseNameOf(t.path) + "'", 'single-track FILE from ' + boundaries.source + ' — no split needed');
    } else if (usable.length) {
      const last = usable[usable.length - 1];
      if (!last.endSec || (dur > 0 && last.endSec > dur)) last.endSec = dur;
      for (const c of usable) virtuals.push(makeVirtual(t, c, merged));
      t.claimedByCue = true;
      logErr(
        'cue',
        "Cue attached to '" + baseNameOf(t.path) + "' — " + usable.length + ' tracks',
        'boundaries from ' + boundaries.source + ' · titles from ' + (titles ? titles.source : 'none (numbered tracks)') + ' · performers from ' + (performers ? performers.source : 'none')
      );
    } else {
      t.cueError = 'The cue sheet has no usable tracks';
    }
  }

  /* FILE lines naming files that are not present: skipped with a log
     line, never an error — half of a per-track cue can still be right. */
  cuesByDir.forEach((group, dir) => {
    const present = new Set(fileTracks.filter((t) => dirNameOf(t.path) === dir).map((t) => cueFileKey(baseNameOf(t.path))));
    for (const c of group) {
      if (!c.sheet) continue;
      for (const g of c.sheet.files) {
        if (g.file && !present.has(cueFileKey(g.file))) {
          logErr('cue', "FILE '" + g.file + "' in '" + baseNameOf(c.path) + "' is not in this folder — skipped", '');
        }
      }
    }
  });

  /* Cues that parsed but claimed nothing, or failed to parse: badge the
     audio file they most plausibly belong to. */
  cuesByDir.forEach((group, dir) => {
    for (const c of group) {
      if (claimedCues.has(c.path)) continue;
      const inDir = fileTracks.filter((t) => dirNameOf(t.path) === dir && !t.claimedByCue);
      if (!inDir.length) continue;
      const sameBase = inDir.find((t) => norm(baseNameOf(t.path).replace(/\.[^.]+$/, '')) === norm(baseNameOf(c.path).replace(/\.cue$/i, '')));
      const target = sameBase || (inDir.length === 1 ? inDir[0] : null);
      if (target && !target.cueError) {
        target.cueError = c.sheet ? "The cue sheet '" + baseNameOf(c.path) + "' points at a missing file" : "The cue sheet '" + baseNameOf(c.path) + "' failed to parse";
      }
    }
  });

  return virtuals;
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
  /* Overrides load before any track is built, so accepted corrections are
     already merged when rows first appear. */
  await loadFolderOverrides(folder);
  const listed = await folder.backend.listScanFiles();
  const files = listed.filter((f) => extOf(f.path) !== 'cue' && extOf(f.path) !== 'lrc');
  const cueFiles = listed.filter((f) => extOf(f.path) === 'cue');
  /* Sibling .lrc files are a lyrics source, never library rows. */
  registerSiblingLrcs(folder.folderId, listed.filter((f) => extOf(f.path) === 'lrc'));
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
  const scanned: FileTrack[] = [];
  const recByPath = new Map<string, TrackRec>();

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
      applyOverrideToTrack(t);
      S.tracks.push(t);
      scanned.push(t);
      recByPath.set(t.path, r.rec);
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
        applyOverrideToTrack(t2);
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

  /* Cue sheets carve their virtual tracks now that every file's duration
     and tags are in hand; claimed sources hide from the library views. */
  try {
    const virtuals = await attachCues(folder, scanned, cueFiles, recByPath);
    for (const v of virtuals) {
      /* Overrides address virtual tracks by their own #cueNN path — that is
         how an AI answer names the tracks of a vinyl side. */
      applyOverrideToTrack(v);
      S.tracks.push(v);
      S.byRef[refOf(v.folderId, v.path)] = v;
      S.byUid[v.uid] = v;
    }
    /* Single-track cue entries retitle file rows during attachment; an
       accepted override must still win over what the cue says. */
    for (const t of scanned) applyOverrideToTrack(t);
  } catch (e) {
    logErr('cue', "Cue attachment failed for '" + folder.label + "'", (e as Error) && (e as Error).message);
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

  /* Albums still without a cover pick one up from the sidecar's artwork/
     directory — accepted catalog covers survive offline and per machine. */
  void restoreSidecarArtwork(folder).then(() => scheduleRender());

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

/* Durations we could not get from headers (MP3, WAV, and anything odd) are
   read from a hidden audio element after the scan, one at a time, then
   cached. Virtual tracks are never probed — the element would report the
   whole source file's length, not the cue window. */
let probing = false;
export function backfillDurations(): void {
  if (probing) return;
  const pending = S.tracks.filter((t) => t.kind === 'file' && !t.duration && t.file);
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
    /* Freshly-probed source durations resolve what depended on them: the
       open end of a cue's last virtual track, and the long-file flags. */
    for (const t of S.tracks) {
      if (t.kind !== 'virtual' || t.endSec > 0) continue;
      const src = S.byRef[refOf(t.folderId, t.sourcePath)];
      if (src && src.duration > 0) {
        t.endSec = src.duration;
        t.duration = Math.max(0, t.endSec - t.startSec);
      }
    }
    detectSplitFlags();
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
