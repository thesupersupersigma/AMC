/* Phase 4 review UI: the catalog match (4a) and the AI metadata repair
   round-trip (4b) share one diff table — current value, proposed value,
   per-row accept/reject, one Apply. Nothing is ever applied blind, and a
   rejected row changes nothing anywhere. Accepted rows become overrides
   (sidecar overrides.json + journal); audio files are never modified. */

import type { AnyTrack, Album, CatalogEntry, ConnectedFolder, Override } from '../types';
import { S, coverURL, haveCover, libraryTracks, rebuildIndex, storeCover, setCoverLocal } from '../state';
import { albumYearOf, fetchCatalogFor, fetchArtwork, stripVersionSuffix, yearOfRelease } from '../net/catalog';
import { artFileOf, recordOverrides, rememberAlbumCollection } from '../fs/overrides';
import { folderById } from '../fs/folders';
import { queueSidecarWrite } from '../fs/amcdir';
import { render } from './render';
import { logErr } from './log';
import { esc, norm, toast, $ } from '../util';

/* ---------- panel state ---------- */

type FieldKey = keyof Override['fields'];

interface DiffRow {
  /** Track uid, or '' for an album-scope row applied to every track. */
  uid: string;
  field: FieldKey | 'artwork';
  label: string;
  from: string;
  to: string;
  value?: string | number;
  accept: boolean;
  /** Title rows: the catalog's verbatim proposal, kept while the
      strip-suffixes toggle rewrites to/value. */
  rawTo?: string;
  /** Title rows: the proposed change is only a version suffix. */
  suffixOnly?: boolean;
}

let mode: 'catalog' | 'ai' | null = null;
let diffRows: DiffRow[] = [];
let diffGroups: Array<{ label: string; from: number; to: number }> = [];
let diffAlbum: Album | null = null;
let diffSource: Override['source'] = 'catalog';
let editionNote = '';
let stripSuffixesOn = false;
let artBlob: Blob | null = null;
let artObjUrl = '';

const ALLOWED_FIELDS: FieldKey[] = ['title', 'artist', 'albumArtist', 'album', 'track', 'disc', 'year', 'genre', 'edition'];

function showPanel(title: string, body: string, applyLabel: string | null, hint: string): void {
  $('#repairTitle').textContent = title;
  $('#repairbody').innerHTML = body;
  $('#repairHint').textContent = hint;
  const apply = $('#repairApply');
  apply.hidden = applyLabel === null;
  if (applyLabel !== null) apply.textContent = applyLabel;
  $('#repairpanel').hidden = false;
  $('#repairscrim').hidden = false;
}

export function closeRepair(): void {
  $('#repairpanel').hidden = true;
  $('#repairscrim').hidden = true;
  mode = null;
  diffRows = [];
  diffGroups = [];
  diffAlbum = null;
  editionNote = '';
  stripSuffixesOn = false;
  artBlob = null;
  if (artObjUrl) {
    try {
      URL.revokeObjectURL(artObjUrl);
    } catch {
      /* already gone */
    }
    artObjUrl = '';
  }
}

/* ---------- the shared diff table ---------- */

function fmtVal(v: string | number | undefined): string {
  if (v === undefined || v === '' || v === 0) return '—';
  return String(v);
}

function diffTableHTML(rows: DiffRow[], groups: Array<{ label: string; from: number; to: number }>): string {
  let h = '<table class="diff-tbl"><thead><tr><th></th><th>Field</th><th>Now</th><th>Proposed</th></tr></thead><tbody>';
  let gi = 0;
  for (let i = 0; i < rows.length; i++) {
    while (gi < groups.length && groups[gi].from === i) {
      h += '<tr class="diff-group"><td colspan="4">' + esc(groups[gi].label) + '</td></tr>';
      gi++;
    }
    const r = rows[i];
    h +=
      '<tr class="diff-row' + (r.accept ? '' : ' rejected') + '">' +
      '<td><input type="checkbox" data-di="' + i + '"' + (r.accept ? ' checked' : '') + ' aria-label="Accept this change"></td>' +
      '<td class="diff-field">' + esc(r.label) + '</td>';
    if (r.field === 'artwork') {
      h += '<td>' + (r.from ? '<img class="diff-art" src="' + esc(r.from) + '" alt="Current artwork">' : '<span class="dim">none</span>') + '</td>';
      h += '<td>' + (r.to ? '<img class="diff-art" src="' + esc(r.to) + '" alt="Proposed artwork">' : '<span class="dim">none</span>') + '</td>';
    } else {
      h += '<td class="diff-from">' + esc(fmtVal(r.from)) + '</td><td class="diff-to">' + esc(fmtVal(r.to)) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}

/* ---------- apply (shared) ---------- */

function applyAccepted(): void {
  const accepted = diffRows.filter((r) => r.accept);
  if (!accepted.length) {
    toast('Nothing accepted — nothing changed');
    closeRepair();
    return;
  }

  /* Expand album-scope rows onto every album track, then group per track. */
  const perTrack = new Map<string, Partial<Record<FieldKey, string | number>>>();
  const targets: AnyTrack[] = diffAlbum ? diffAlbum.tracks : [];
  let artAccepted = false;
  for (const r of accepted) {
    if (r.field === 'artwork') {
      artAccepted = true;
      continue;
    }
    const list: AnyTrack[] = r.uid ? ([S.byUid[r.uid]].filter(Boolean) as AnyTrack[]) : targets;
    for (const t of list) {
      /* A change that no longer changes anything (a stripped suffix landing
         back on the original title) writes no override at all. */
      const cur = (t as unknown as Record<string, string | number | undefined>)[r.field];
      if (norm(String(cur ?? '')) === norm(String(r.value))) continue;
      const patch = perTrack.get(t.uid) || {};
      patch[r.field as FieldKey] = r.value as string | number;
      perTrack.set(t.uid, patch);
    }
  }

  /* Group patches by folder — an album merged across two roots writes to
     each folder's own overrides.json. */
  const byFolderId = new Map<string, Array<{ path: string; fields: Override['fields']; source: Override['source'] }>>();
  perTrack.forEach((fields, uid) => {
    const row = S.byUid[uid];
    if (!row || row.kind === 'missing') return;
    const t = row;
    const list = byFolderId.get(t.folderId) || [];
    list.push({ path: t.path, fields: fields as Override['fields'], source: diffSource });
    byFolderId.set(t.folderId, list);
  });
  let applied = 0;
  byFolderId.forEach((patches, folderId) => {
    const folder = folderById(folderId);
    if (!folder) {
      logErr('overrides', 'A folder for accepted changes is not connected', folderId);
      return;
    }
    recordOverrides(folder, patches);
    applied += patches.length;
  });

  /* Accepted artwork: into the cover caches now, into the sidecar forever. */
  if (artAccepted && artBlob && diffAlbum) {
    const al = diffAlbum;
    const blob = artBlob;
    setCoverLocal(al.key, blob);
    void storeCover(al.key, blob);
    const folder = folderById(al.tracks[0].folderId);
    if (folder && folder.capability === 'readwrite') {
      folder.backend.writeSidecarBlob('artwork/' + artFileOf(al.key), blob).catch((e: Error) => {
        logErr('catalog', 'The cover could not be written to the sidecar', e && e.message);
      });
    }
  }

  rebuildIndex();
  render();
  const artNote = artAccepted ? (applied ? ' and the album cover' : 'the album cover') : '';
  toast('Applied ' + (applied ? applied + ' correction' + (applied === 1 ? '' : 's') : '') + artNote + ' — files untouched');
  closeRepair();
}

/* =========================================================================
   4a — catalog review
   ========================================================================= */

function matchSongs(al: Album, songs: CatalogEntry[]): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  const used = new Set<CatalogEntry>();
  const strip = (s: string): string => norm(s.replace(/\s*[([].*?[)\]]/g, ''));

  /* Titles first — real names beat numbers (a vinyl cut list and the CD
     edition disagree about numbering the moment a bonus track appears). */
  for (const t of al.tracks) {
    const k = norm(t.title);
    const hit = songs.find((s) => !used.has(s) && norm(s.trackName || '') === k);
    if (hit) {
      out.set(t.uid, hit);
      used.add(hit);
    }
  }
  for (const t of al.tracks) {
    if (out.has(t.uid)) continue;
    const k = strip(t.title);
    if (!k) continue;
    const hit = songs.find((s) => !used.has(s) && strip(s.trackName || '') === k);
    if (hit) {
      out.set(t.uid, hit);
      used.add(hit);
    }
  }
  /* Then disc+number for what titles could not place. */
  for (const t of al.tracks) {
    if (out.has(t.uid) || !t.track) continue;
    const hit = songs.find((s) => !used.has(s) && (s.discNumber || 1) === (t.disc || 1) && s.trackNumber === t.track);
    if (hit) {
      out.set(t.uid, hit);
      used.add(hit);
    }
  }
  /* Positional only when what remains lines up one-to-one. */
  const restT = al.tracks.filter((t) => !out.has(t.uid));
  const restS = songs.filter((s) => !used.has(s));
  if (restT.length && restT.length === restS.length) {
    for (let i = 0; i < restT.length; i++) out.set(restT[i].uid, restS[i]);
  }
  return out;
}

function buildCatalogDiff(al: Album, collection: CatalogEntry, songs: CatalogEntry[]): void {
  const rows: DiffRow[] = [];
  const groups: Array<{ label: string; from: number; to: number }> = [];
  const push = (uid: string, field: FieldKey, label: string, from: string | number, toVal: string | number, accept: boolean): DiffRow | null => {
    if (norm(String(from)) === norm(String(toVal)) || toVal === '' || toVal === 0) return null;
    const row: DiffRow = { uid: uid, field: field, label: label, from: String(from || ''), to: String(toVal), value: toVal, accept: accept };
    rows.push(row);
    return row;
  };

  const gStart = rows.length;
  const albumRow = push('', 'album', 'Album', al.album, collection.collectionName, true);
  push('', 'albumArtist', 'Album artist', al.artist, collection.artistName, true);
  push('', 'year', 'Year', al.year || '', yearOfRelease(collection), true);
  const genres = al.tracks.map((t) => t.genre).filter(Boolean);
  push('', 'genre', 'Genre', genres[0] || '', collection.primaryGenreName || '', true);
  if (collection.artworkUrl100) {
    rows.push({
      uid: '',
      field: 'artwork',
      label: 'Artwork',
      from: haveCover(al.key) ? coverURL(al.key) : '',
      to: '' /* filled in when the preview arrives */,
      accept: !haveCover(al.key),
    });
  }
  if (rows.length > gStart) groups.push({ label: 'Album — ' + al.album, from: gStart, to: rows.length });

  const matched = matchSongs(al, songs);
  const titleRows: DiffRow[] = [];
  for (const t of al.tracks) {
    const song = matched.get(t.uid);
    if (!song) continue;
    const tStart = rows.length;
    const titleRow = push(t.uid, 'title', 'Title', t.title, song.trackName || '', true);
    if (titleRow) {
      titleRow.rawTo = titleRow.to;
      titleRow.suffixOnly = norm(stripVersionSuffix(titleRow.to)) === norm(stripVersionSuffix(t.title));
      titleRows.push(titleRow);
    }
    push(t.uid, 'track', 'Track №', t.track || '', song.trackNumber || 0, true);
    push(t.uid, 'artist', 'Artist', t.artist, song.artistName, false);
    if (rows.length > tStart) groups.push({ label: (t.track ? t.track + '. ' : '') + t.title, from: tStart, to: rows.length });
  }

  /* Edition check. Two signals, because iTunes stamps reissues with the
     ORIGINAL release date (the 2012 Bad remaster says 1987): a year
     disagreement, or proposed titles that differ from the local ones only
     by a version suffix. Either way the titles describe a different
     edition of the same songs — they start unchecked, and the header says
     why. The per-row accept mechanism is unchanged. */
  const localYear = albumYearOf(al);
  const catYear = yearOfRelease(collection);
  const yearsDisagree = localYear > 0 && catYear > 0 && localYear !== catYear;
  const suffixCount = titleRows.filter((r) => r.suffixOnly).length;
  editionNote = '';
  if (yearsDisagree) {
    for (const r of titleRows) r.accept = false;
    editionNote = 'This looks like a different edition: the local album says ' + localYear + ', the catalog match is dated ' + catYear + '. Title changes start unchecked.';
  } else if (suffixCount >= 2) {
    for (const r of titleRows) {
      if (r.suffixOnly) r.accept = false;
    }
    editionNote = 'The catalog match looks like a different mastering — its titles carry version suffixes ("' + esc(String(titleRows.find((r) => r.suffixOnly)!.rawTo)) + '"). Suffix-only title changes start unchecked.';
  }
  if (editionNote && albumRow && norm(stripVersionSuffix(String(albumRow.value))) === norm(stripVersionSuffix(al.album))) albumRow.accept = false;

  diffRows = rows;
  diffGroups = groups;
}

/** The catalog body: edition banner, the strip-suffixes toggle, the table.
    One renderer so the artwork-preview and toggle re-renders keep all
    three in place (accept states live on the rows and survive). */
function catalogBodyHTML(): string {
  let h = '';
  if (editionNote) h += '<div class="diff-note">' + editionNote + '</div>';
  if (diffRows.some((r) => r.field === 'title' && r.rawTo && stripVersionSuffix(r.rawTo) !== r.rawTo)) {
    h +=
      '<label class="diff-toggle"><input type="checkbox" id="stripSuffixes"' +
      (stripSuffixesOn ? ' checked' : '') +
      '> Strip version suffixes from titles on apply — “Bad (2012 Remaster)” applies as “Bad”</label>';
  }
  h += diffTableHTML(diffRows, diffGroups);
  return h;
}

function applyStripToggle(on: boolean): void {
  stripSuffixesOn = on;
  for (const r of diffRows) {
    if (r.field !== 'title' || !r.rawTo) continue;
    const shown = on ? stripVersionSuffix(r.rawTo) : r.rawTo;
    r.to = shown;
    r.value = shown;
  }
  $('#repairbody').innerHTML = catalogBodyHTML();
}

export async function openCatalogReview(albumKey: string): Promise<void> {
  const al = S.albumMap[albumKey];
  if (!al || !al.tracks.length) return;
  const folder = folderById(al.tracks[0].folderId);
  if (!folder) return;
  mode = 'catalog';
  diffSource = 'catalog';
  diffAlbum = al;
  diffRows = [];
  showPanel('Catalog match — ' + al.album, '<div class="repair-wait"><span class="spinner"></span>Searching the iTunes catalog…</div>', null, 'Batched by album — two requests, cached to the sidecar.');

  let match;
  try {
    match = await fetchCatalogFor(folder, al);
  } catch (e) {
    if (mode !== 'catalog' || diffAlbum !== al) return;
    logErr('catalog', 'The catalog lookup failed for ' + al.album, (e as Error).message);
    $('#repairbody').innerHTML = '<div class="repair-wait">The catalog could not be reached. The lookup needs the network once; everything accepted before stays.</div>';
    return;
  }
  if (mode !== 'catalog' || diffAlbum !== al) return; /* closed meanwhile */
  if (!match) {
    $('#repairbody').innerHTML = '<div class="repair-wait">No plausible match in the catalog for “' + esc(al.artist) + ' — ' + esc(al.album) + '”. Vinyl-only editions and bootlegs will not be there; the AI repair path handles those.</div>';
    return;
  }

  buildCatalogDiff(al, match.collection, match.songs);
  const note = match.fromCache ? 'From the sidecar cache (offline). ' : '';
  showPanel(
    'Catalog match — ' + (match.collection.collectionName || al.album),
    catalogBodyHTML(),
    'Apply accepted changes',
    note + 'Accepted rows go to overrides.json — audio files are never modified.'
  );
  /* Remember the accepted collection only on apply; but the preview loads
     now, while the table is on screen. */
  const artRow = diffRows.find((r) => r.field === 'artwork');
  if (artRow && match.collection.artworkUrl100) {
    const blob = await fetchArtwork(match.collection.artworkUrl100);
    if (mode !== 'catalog' || diffAlbum !== al) return;
    if (blob) {
      artBlob = blob;
      artObjUrl = URL.createObjectURL(blob);
      artRow.to = artObjUrl;
    } else {
      /* Download failed — the row stays visible but proposes nothing and
         cannot be accepted into anything (apply guards on the blob). */
      artRow.accept = false;
    }
    /* Same rows, same groups — re-render with the preview in place. */
    $('#repairbody').innerHTML = catalogBodyHTML();
  }
  /* Keep the collection id with the album on apply. */
  pendingCollection = { folder: folder, albumKey: al.key, collectionId: match.collection.collectionId };
}

let pendingCollection: { folder: ConnectedFolder; albumKey: string; collectionId: number } | null = null;

/* =========================================================================
   4b — AI metadata repair
   ========================================================================= */

interface RepairReqRow {
  path: string;
  size: number;
  duration: number;
  tags: { title: string; artist: string; albumArtist: string; album: string; track: number; disc: number; year: number; genre: string };
  issues: string[];
}

const SUFFIX_RE = /remaster|deluxe|anniversary|expanded|reissue|\blive\b|\bdemo\b|alternate|single version|radio edit|\bmono\b|\bstereo\b/i;

/** The detected-issues list is what makes this better than pasting a file
    listing: the AI sees exactly what AMC already knows is wrong. */
function buildRepairRows(): RepairReqRow[] {
  const rows: RepairReqRow[] = [];
  const tracks = libraryTracks();
  /* Album context first: collisions, gaps, duplicate titles. */
  const byAlbum = new Map<string, AnyTrack[]>();
  for (const t of tracks) {
    const g = byAlbum.get(t.coverKey) || [];
    g.push(t);
    byAlbum.set(t.coverKey, g);
  }
  const issuesByUid = new Map<string, string[]>();
  const add = (t: AnyTrack, msg: string): void => {
    const list = issuesByUid.get(t.uid) || [];
    list.push(msg);
    issuesByUid.set(t.uid, list);
  };
  byAlbum.forEach((group) => {
    const byNum = new Map<string, AnyTrack[]>();
    const byTitle = new Map<string, AnyTrack[]>();
    let maxNum = 0;
    for (const t of group) {
      if (t.track > 0) {
        const k = (t.disc || 1) + ':' + t.track;
        const g = byNum.get(k) || [];
        g.push(t);
        byNum.set(k, g);
        if (t.track > maxNum) maxNum = t.track;
      }
      const tk = norm(t.title);
      if (tk) {
        const g2 = byTitle.get(tk) || [];
        g2.push(t);
        byTitle.set(tk, g2);
      }
    }
    byNum.forEach((g) => {
      if (g.length > 1) for (const t of g) add(t, 'track number ' + t.track + ' collides with ' + (g.length - 1) + ' other track' + (g.length > 2 ? 's' : '') + ' in this album');
    });
    if (maxNum > 0 && maxNum > group.length) {
      const have = new Set(group.map((t) => t.track));
      const missing: number[] = [];
      for (let n = 1; n <= maxNum; n++) if (!have.has(n)) missing.push(n);
      if (missing.length && missing.length <= 20) for (const t of group) add(t, 'album skips track number' + (missing.length > 1 ? 's' : '') + ' ' + missing.join(', '));
    }
    byTitle.forEach((g) => {
      if (g.length > 1) for (const t of g) add(t, 'title duplicates ' + (g.length - 1) + ' other track' + (g.length > 2 ? 's' : '') + ' in this album');
    });
  });

  for (const t of tracks) {
    const issues = issuesByUid.get(t.uid) || [];
    if (t.tagged === false) issues.unshift('every tag was derived from the file path, not read from the file');
    if (!t.title) issues.push('title is empty');
    if (!t.artist) issues.push('artist is empty');
    if (!t.album || /^(singles|unknown album)$/i.test(t.album)) issues.push('album is missing or a placeholder');
    if (!t.track) issues.push('no track number');
    if (!t.year) issues.push('no year');
    if (!t.duration) issues.push('duration unknown (could not be read)');
    else if (t.duration < 15) issues.push('suspiciously short (' + Math.round(t.duration) + 's)');
    else if (t.duration > 1200 && t.kind === 'file') issues.push('suspiciously long (' + Math.round(t.duration / 60) + 'min) — possibly an unsplit rip');
    if (SUFFIX_RE.test(t.title)) issues.push('title carries a version/remaster suffix');
    if (t.album && SUFFIX_RE.test(t.album)) issues.push('album name carries an edition suffix');
    rows.push({
      path: t.path,
      size: t.size,
      duration: Math.round(t.duration * 10) / 10,
      tags: { title: t.title, artist: t.artist, albumArtist: t.albumArtist, album: t.album, track: t.track, disc: t.disc, year: t.year, genre: t.genre },
      issues: issues,
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

function buildPrompt(rows: RepairReqRow[]): string {
  return [
    'You are repairing the metadata of a local music library. The JSON array',
    'below ("request") lists every track: its path, file size, duration in',
    'seconds, current tags, and the issues the player itself detected.',
    '',
    'Reply with ONLY a JSON array — no prose, no explanations, no markdown',
    'fences. Each element has exactly two keys:',
    '  {"path": "<a path copied verbatim from the request>",',
    '   "fields": {<only the fields you are correcting>}}',
    'Allowed keys inside "fields": title, artist, albumArtist, album, track,',
    'disc, year, genre, edition. title/artist/albumArtist/album/genre/edition',
    'are strings; track, disc and year are plain numbers.',
    '',
    'Rules:',
    '- Correct only what is wrong or missing; omit fields you are not changing.',
    '- Omit tracks that need no changes. Never invent tracks not in the request.',
    '- Judge the actual release from the paths, durations and tags — editions,',
    '  vinyl side splits and non-catalog material included.',
    '- If you are not confident about a field, leave it out.',
    '',
    'Request:',
    JSON.stringify(rows, null, 1),
  ].join('\n');
}

export function openAiRepair(): void {
  mode = 'ai';
  diffSource = 'ai';
  diffAlbum = null;
  diffRows = [];
  const rows = buildRepairRows();
  const withIssues = rows.filter((r) => r.issues.length).length;
  aiRows = rows;

  const body =
    '<div class="ai-repair">' +
    '<p class="dim">' + rows.length + ' tracks in the request, ' + withIssues + ' with detected issues. The request also writes to each folder’s <b>.AMC/metadata-request.json</b>.</p>' +
    '<div class="ai-actions">' +
    '<button type="button" class="pill-ghost" id="aiCopy">Copy prompt for any AI chat</button>' +
    '<span class="dim" id="aiCopyNote"></span>' +
    '</div>' +
    '<p class="dim">Paste the AI’s JSON answer here, then validate:</p>' +
    '<textarea id="aiAnswer" spellcheck="false" placeholder=\'[{"path": "…", "fields": {"title": "…"}}]\'></textarea>' +
    '<div class="ai-actions"><button type="button" class="pill-ghost" id="aiValidate">Validate answer</button><span class="dim" id="aiErrors"></span></div>' +
    '</div>';
  showPanel('AI metadata repair', body, null, 'The answer is schema-checked; nothing applies without review.');

  /* The export is user data in flight — write it now, per writable folder. */
  const byFolderId = new Map<string, RepairReqRow[]>();
  for (const r of rows) {
    const t = S.byPath[r.path];
    if (!t) continue;
    const g = byFolderId.get(t.folderId) || [];
    g.push(r);
    byFolderId.set(t.folderId, g);
  }
  byFolderId.forEach((list, folderId) => {
    const folder = folderById(folderId);
    if (folder && folder.capability === 'readwrite') {
      queueSidecarWrite(folder, 'metadata-request.json', () => JSON.stringify({ schemaVersion: 2, generatedAt: Date.now(), tracks: list }, null, 1) + '\n');
    }
  });
}

let aiRows: RepairReqRow[] = [];

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function validateAiAnswer(text: string): { patches: Array<{ t: AnyTrack; fields: Partial<Record<FieldKey, string | number>> }>; errors: string[] } {
  const errors: string[] = [];
  const patches: Array<{ t: AnyTrack; fields: Partial<Record<FieldKey, string | number>> }> = [];
  const known = new Set(aiRows.map((r) => r.path));
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return { patches: [], errors: ['Not valid JSON: ' + (e as Error).message] };
  }
  if (!Array.isArray(parsed)) return { patches: [], errors: ['The answer must be a JSON array'] };
  const seen = new Set<string>();
  parsed.forEach((item, i) => {
    const at = 'Item ' + (i + 1);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(at + ': not an object');
      return;
    }
    const o = item as Record<string, unknown>;
    const extraTop = Object.keys(o).filter((k) => k !== 'path' && k !== 'fields');
    if (extraTop.length) {
      errors.push(at + ': unexpected keys ' + extraTop.join(', '));
      return;
    }
    const path = o['path'];
    if (typeof path !== 'string' || !path) {
      errors.push(at + ': missing path');
      return;
    }
    if (!known.has(path)) {
      errors.push(at + ': path is not in the request (invented track rejected): ' + path);
      return;
    }
    if (seen.has(path)) {
      errors.push(at + ': duplicate path, first answer kept: ' + path);
      return;
    }
    const t = S.byPath[path];
    if (!t) {
      errors.push(at + ': track no longer in the library: ' + path);
      return;
    }
    const rawFields = o['fields'];
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
      errors.push(at + ': missing fields object');
      return;
    }
    const fields: Partial<Record<FieldKey, string | number>> = {};
    for (const [k, v] of Object.entries(rawFields as Record<string, unknown>)) {
      if ((ALLOWED_FIELDS as string[]).indexOf(k) < 0) {
        errors.push(at + ': field "' + k + '" is not allowed and was dropped');
        continue;
      }
      if (k === 'track' || k === 'disc' || k === 'year') {
        const n = typeof v === 'number' ? v : NaN;
        const ok = Number.isInteger(n) && (k === 'track' ? n >= 0 && n <= 999 : k === 'disc' ? n >= 1 && n <= 99 : n === 0 || (n >= 1000 && n <= 3000));
        if (!ok) {
          errors.push(at + ': ' + k + ' must be a sane number, got ' + JSON.stringify(v));
          continue;
        }
        fields[k as FieldKey] = n;
      } else {
        if (typeof v !== 'string' || !v.trim() || v.length > 300) {
          errors.push(at + ': ' + k + ' must be a short string, got ' + JSON.stringify(v).slice(0, 60));
          continue;
        }
        fields[k as FieldKey] = v.trim();
      }
    }
    if (!Object.keys(fields).length) return; /* nothing usable — not an error by itself */
    seen.add(path);
    patches.push({ t: t as AnyTrack, fields: fields });
  });
  return { patches: patches, errors: errors };
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', artist: 'Artist', albumArtist: 'Album artist', album: 'Album',
  track: 'Track №', disc: 'Disc', year: 'Year', genre: 'Genre', edition: 'Edition',
};

function aiDiffFromPatches(patches: Array<{ t: AnyTrack; fields: Partial<Record<FieldKey, string | number>> }>, rejectedNote: string): void {
  diffRows = [];
  const groups: Array<{ label: string; from: number; to: number }> = [];
  for (const p of patches) {
    const start = diffRows.length;
    for (const [k, v] of Object.entries(p.fields)) {
      const cur = (p.t as unknown as Record<string, string | number>)[k];
      if (norm(String(cur ?? '')) === norm(String(v))) continue;
      diffRows.push({ uid: p.t.uid, field: k as FieldKey, label: FIELD_LABELS[k] || k, from: String(cur ?? ''), to: String(v), value: v, accept: true });
    }
    if (diffRows.length > start) groups.push({ label: p.t.title + '  ·  ' + p.t.path, from: start, to: diffRows.length });
  }
  if (!diffRows.length) {
    $('#aiErrors').textContent = 'Valid, but every proposed value matches what is already shown — nothing to apply.';
    return;
  }
  showPanel(
    'AI repair — review ' + diffRows.length + ' change' + (diffRows.length === 1 ? '' : 's'),
    diffTableHTML(diffRows, groups),
    'Apply accepted changes',
    (rejectedNote ? rejectedNote + ' · ' : '') + 'Accepted rows go to overrides.json — audio files are never modified.'
  );
}

/* ---------- wiring ---------- */

export function wireRepair(): void {
  $('#repairCancel').addEventListener('click', closeRepair);
  $('#repairscrim').addEventListener('click', closeRepair);
  $('#repairApply').addEventListener('click', () => {
    if (pendingCollection && mode === 'catalog') {
      rememberAlbumCollection(pendingCollection.folder, pendingCollection.albumKey, pendingCollection.collectionId);
      pendingCollection = null;
    }
    applyAccepted();
  });
  $('#repairbody').addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'stripSuffixes') {
      applyStripToggle((target as HTMLInputElement).checked);
      return;
    }
    const cb = target.closest('input[data-di]') as HTMLInputElement | null;
    if (!cb) return;
    const i = parseInt(cb.getAttribute('data-di') || '', 10);
    if (diffRows[i]) {
      diffRows[i].accept = cb.checked;
      const tr = cb.closest('tr');
      if (tr) tr.classList.toggle('rejected', !cb.checked);
    }
  });
  $('#repairbody').addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('#aiCopy')) {
      const prompt = buildPrompt(aiRows);
      navigator.clipboard
        .writeText(prompt)
        .then(() => {
          $('#aiCopyNote').textContent = 'Copied — paste it into any AI chat.';
        })
        .catch(() => {
          /* clipboard blocked — fall back to showing it for manual copy */
          const ta = $('#aiAnswer') as HTMLTextAreaElement;
          ta.value = prompt;
          ta.select();
          $('#aiCopyNote').textContent = 'Clipboard blocked — the prompt is in the box below, copy it from there, then clear the box for the answer.';
        });
      return;
    }
    if (target.closest('#aiValidate')) {
      const ta = $('#aiAnswer') as HTMLTextAreaElement;
      const res = validateAiAnswer(ta.value || '');
      const errBox = $('#aiErrors');
      if (res.errors.length) {
        errBox.textContent = res.errors.slice(0, 6).join(' · ') + (res.errors.length > 6 ? ' · +' + (res.errors.length - 6) + ' more' : '');
        logErr('overrides', 'AI answer validation: ' + res.errors.length + ' problem' + (res.errors.length === 1 ? '' : 's'), res.errors.join('\n'));
      } else {
        errBox.textContent = '';
      }
      /* The rejection count must survive the switch to the diff table — the
         full list is in the activity log. */
      if (res.patches.length) aiDiffFromPatches(res.patches, res.errors.length ? res.errors.length + ' answer item' + (res.errors.length === 1 ? '' : 's') + ' rejected by the schema check (details in the activity log)' : '');
      else if (!res.errors.length) errBox.textContent = 'Valid JSON, but no usable corrections in it.';
      return;
    }
  });
}
