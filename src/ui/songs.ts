/* The song table, sorting, and row selection. */

import type { AnyTrack, PlaylistEntry, RowTrack, SortCol } from '../types';
import { S, isMissingTrack } from '../state';
import { icon, artHTML } from './icons';
import { esc, fmtDur, norm, $$ } from '../util';

/* ---------- table ---------- */

function sortMark(col: SortCol): string {
  if (S.sort.col !== col) return '';
  return icon(S.sort.dir > 0 ? 'sortup' : 'sortdown', 'sortmark');
}

function tableHead(sortable: boolean): string {
  function cell(col: SortCol, label: string, cls?: string): string {
    if (!sortable) return '<div class="' + (cls || '') + '">' + label + '</div>';
    return '<div class="' + (cls || '') + '"><button type="button" data-sort="' + col + '">' + label + sortMark(col) + '</button></div>';
  }
  return (
    '<div class="tr thead">' +
    cell('title', 'Song') +
    cell('artist', 'Artist') +
    cell('album', 'Album') +
    cell('duration', 'Time', 'c-time') +
    '<div></div></div>'
  );
}

function rowHTML(t: RowTrack, i: number, opts: SongTableOpts): string {
  const missing = isMissingTrack(t);
  const isNow = !!(S.current && !missing && t.uid === S.current.uid);
  const selected = S.sel.indexOf(t.uid) >= 0;
  let lead: string;
  if (isNow) {
    lead = '<div class="eq' + (S.playing ? '' : ' paused') + '" aria-hidden="true"><i></i><i></i><i></i><i></i></div>';
  } else {
    lead = '<div class="thumb">' + artHTML(t.coverKey) + '</div>';
  }
  let note = '';
  if (missing) note = '<div class="t-note">' + esc(t.note || 'Not in this folder') + '</div>';
  else if (t.error) note = '<div class="t-note">' + esc(t.error) + '</div>';
  else if (opts.noteFor) {
    const extra = opts.noteFor(t, i);
    if (extra) note = '<div class="t-note">' + esc(extra) + '</div>';
  }

  const warn = !missing && t.error ? '<span class="warn" title="' + esc(t.error) + '">' + icon('warn') + '</span>' : '';
  /* The duplicate badge: this row stands for n copies; the row menu picks
     which one plays. */
  const dup = !missing && t.dupRefs && t.dupRefs.length
    ? '<span class="dup-badge" title="' + (t.dupRefs.length + 1) + ' copies across folders">' + (t.dupRefs.length + 1) + '×</span>'
    : '';

  return (
    '<div class="tr row' + (isNow ? ' playing' : '') + (selected ? ' sel' : '') + (missing ? ' dim' : '') + '"' +
    ' data-uid="' + esc(t.uid) + '" data-i="' + i + '" draggable="true" tabindex="0" role="button"' +
    ' aria-label="' + esc(t.title + ' by ' + t.artist) + '">' +
    '<div class="c-song">' + lead +
    '<div class="t-lines"><div class="t-title trunc">' + warn + esc(t.title) + dup + '</div>' + note + '</div>' +
    '</div>' +
    '<div class="c-dim trunc">' + esc(t.artist) + '</div>' +
    '<div class="c-dim trunc">' + esc(t.album) + '</div>' +
    '<div class="c-time">' + fmtDur(t.duration) + '</div>' +
    '<div class="c-more"><button class="kebab-btn" type="button" data-kebab="' + esc(t.uid) + '" aria-label="Open actions for ' + esc(t.title) + '">' + icon('more') + '</button></div>' +
    '</div>'
  );
}

export interface SongTableOpts {
  context?: string;
  playlistId?: string;
  reorder?: boolean;
  sortable?: boolean;
  /** Extra per-row note (e.g. "from 'Backup'") when the row has no error. */
  noteFor?: (t: RowTrack, i: number) => string;
}

export function songTable(tracks: RowTrack[], opts?: SongTableOpts): string {
  opts = opts || {};
  S.visible = tracks.map((t) => t.uid);
  let h =
    '<div class="tbl" data-table="' + esc(opts.context || 'songs') + '"' +
    (opts.playlistId ? ' data-playlist="' + esc(opts.playlistId) + '"' : '') +
    (opts.reorder ? ' data-reorder="1"' : '') + '>';
  h += tableHead(!!opts.sortable);
  for (let i = 0; i < tracks.length; i++) h += rowHTML(tracks[i], i, opts);
  h += '</div>';
  return h;
}

export function sortTracks(list: AnyTrack[], col: SortCol, dir: number): AnyTrack[] {
  const out = list.slice();
  out.sort((a, b) => {
    let v: number;
    if (col === 'duration') v = (a.duration || 0) - (b.duration || 0);
    else v = String(a[col] || '').localeCompare(String(b[col] || ''));
    if (v === 0 && col !== 'title') v = String(a.title).localeCompare(String(b.title));
    return v * dir;
  });
  return out;
}

export function matches(t: AnyTrack, q: string): boolean {
  return norm(t.title).indexOf(q) >= 0 || norm(t.artist).indexOf(q) >= 0 || norm(t.album).indexOf(q) >= 0;
}

/* Swap the playing-row highlight without rebuilding the whole table. */
export function updatePlayingRows(): void {
  $$('#view .row').forEach((r) => {
    const isNow = S.current && r.getAttribute('data-uid') === S.current.uid;
    r.classList.toggle('playing', !!isNow);
    const eq = r.querySelector('.eq');
    if (eq) eq.classList.toggle('paused', !S.playing);
  });
}

/* ---------- selection ---------- */

export let lastSelIndex = -1;
export function setLastSelIndex(i: number): void {
  lastSelIndex = i;
}
export function clearSelection(): void {
  S.sel = [];
}
export function setSelectionUI(): void {
  $$('#view .row').forEach((r) => {
    r.classList.toggle('sel', S.sel.indexOf(r.getAttribute('data-uid') || '') >= 0);
  });
}
export function handleRowSelect(uid: string, index: number, ev: MouseEvent): void {
  if (ev.shiftKey && lastSelIndex >= 0) {
    const a = Math.min(lastSelIndex, index),
      b = Math.max(lastSelIndex, index);
    const range = S.visible.slice(a, b + 1);
    if (!(ev.ctrlKey || ev.metaKey)) S.sel = [];
    range.forEach((u) => {
      if (S.sel.indexOf(u) < 0) S.sel.push(u);
    });
  } else if (ev.ctrlKey || ev.metaKey) {
    const i = S.sel.indexOf(uid);
    if (i >= 0) S.sel.splice(i, 1);
    else S.sel.push(uid);
    lastSelIndex = index;
  } else {
    S.sel = [uid];
    lastSelIndex = index;
  }
  setSelectionUI();
}

/* Entries for whatever the user is acting on: the selection if the clicked
   row is part of it, otherwise just that row. Ghost rows keep an empty
   folderId — they resolve again when their folder loads. */
export function actionEntries(uid: string): PlaylistEntry[] {
  const uids = S.sel.length > 1 && S.sel.indexOf(uid) >= 0 ? S.sel.slice() : [uid];
  const out: PlaylistEntry[] = [];
  uids.forEach((u) => {
    const t = S.byUid[u];
    if (t) out.push({ folderId: isMissingTrack(t) ? '' : t.folderId, path: t.path });
  });
  return out;
}
export function actionTracks(uid: string): RowTrack[] {
  const uids = S.sel.length > 1 && S.sel.indexOf(uid) >= 0 ? S.sel.slice() : [uid];
  const out: RowTrack[] = [];
  uids.forEach((u) => {
    if (S.byUid[u]) out.push(S.byUid[u]);
  });
  return out;
}
