/* The waveform scrubber in the player pill, cue markers, and the
   auto-split editor. Peaks come from the sidecar cache or one lazy decode;
   the split editor shares that decode's silence analysis (one pass, two
   outputs) and writes cues/<path>.cue back into the sidecar. */

import type { AnyTrack, ConnectedFolder, FileTrack, PeakData, VirtualTrack } from '../types';
import { S, refOf } from '../state';
import { audio } from '../audio/engine';
import { analyzeForSplit } from '../audio/analysis';
import { bucketPeaks, loadPeaks, savePeaks } from '../audio/peaks';
import { buildCueText } from '../parse/cue';
import { stripRoot } from '../fs/amcdir';
import { folderById } from '../fs/folders';
import { enqueueFolderScan } from '../scan/scanner';
import { logErr } from './log';
import { esc, fmtTime, toast, $ } from '../util';
import { icon } from './icons';

/* ---------- state ---------- */

let canvas: HTMLCanvasElement | null = null;
let curKey = ''; /* refOf(folderId, sourcePath) of what the canvas shows */
let curPeaks: PeakData | null = null;
let curDuration = 0;
let markers: Array<{ sec: number; label: string }> = [];
let lastProgressPx = -1;
const generating = new Set<string>();
const MAX_DECODE_BYTES = 600 * 1048576;

function sourceOf(t: AnyTrack): { path: string; file?: File } {
  return t.kind === 'virtual' ? { path: t.sourcePath, file: t.file } : { path: t.path, file: t.file };
}

/* ---------- rendering ---------- */

function clearCanvas(): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.classList.remove('has-wave');
}

function draw(): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const havePeaks = !!(curPeaks && curPeaks.pairs.length);
  if (!curDuration || (!havePeaks && !markers.length)) {
    canvas.classList.remove('has-wave');
    return;
  }
  canvas.classList.add('has-wave');
  const mid = h / 2;
  const playedX = progressX();

  if (havePeaks) {
    const pairs = (curPeaks as PeakData).pairs;
    const buckets = pairs.length / 2;
    for (let b = 0; b < buckets; b++) {
      const x = (b / buckets) * w;
      const mn = pairs[b * 2];
      const mx = pairs[b * 2 + 1];
      let y0 = mid - mx * mid * 0.92;
      let y1 = mid - mn * mid * 0.92;
      if (y1 - y0 < 1) {
        y0 = mid - 0.5;
        y1 = mid + 0.5;
      }
      ctx.fillStyle = x <= playedX ? 'rgba(250,36,60,.85)' : 'rgba(255,255,255,.28)';
      ctx.fillRect(x, y0, Math.max(1, w / buckets - 0.4), y1 - y0);
    }
  } else {
    /* A file too large to decode for peaks (multi-GB hi-res rip) still gets
       its cue geography: a baseline with the played span tinted. */
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.fillRect(0, mid - 1, w, 2);
    if (playedX > 0) {
      ctx.fillStyle = 'rgba(250,36,60,.85)';
      ctx.fillRect(0, mid - 1, playedX, 2);
    }
  }
  /* Cue markers: one tick per virtual track's startSec across the file. */
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  for (const m of markers) {
    const x = Math.round((m.sec / curDuration) * w);
    ctx.fillRect(x, 0, 1, h);
  }
  /* The current cue track's window sits brighter than the rest. */
  const c = S.current;
  if (c && c.kind === 'virtual' && refOf(c.folderId, c.sourcePath) === curKey) {
    const x0 = (c.startSec / curDuration) * w;
    const x1 = ((c.endSec || curDuration) / curDuration) * w;
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
}

function progressX(): number {
  if (!canvas || !curDuration) return -1;
  const c = S.current;
  if (!c) return -1;
  const key = refOf(c.folderId, c.kind === 'virtual' ? c.sourcePath : c.path);
  if (key !== curKey) return -1;
  return (Math.max(0, audio.currentTime || 0) / curDuration) * canvas.width;
}

/** Cheap per-frame update: repaints only when the playhead moved a pixel. */
export function drawWaveformProgress(): void {
  if (!canvas || !curPeaks) return;
  const x = Math.round(progressX());
  if (x === lastProgressPx) return;
  lastProgressPx = x;
  draw();
}

/* ---------- track change ---------- */

export async function waveformTrackChanged(): Promise<void> {
  if (!canvas) return;
  const c = S.current;
  if (!c || !c.duration) {
    curKey = '';
    curPeaks = null;
    markers = [];
    clearCanvas();
    return;
  }
  const src = sourceOf(c);
  const key = refOf(c.folderId, src.path);

  /* Markers and file duration come from the cue layout, whether or not
     peaks exist yet. */
  const virtuals = S.tracks.filter((t): t is VirtualTrack => t.kind === 'virtual' && t.folderId === c.folderId && t.sourcePath === src.path);
  markers = virtuals.map((v) => ({ sec: v.startSec, label: v.title }));
  const srcTrack = S.byRef[key];
  curDuration =
    (srcTrack && srcTrack.duration) ||
    (virtuals.length ? Math.max(...virtuals.map((v) => v.endSec || 0)) : 0) ||
    c.duration;

  if (key === curKey && curPeaks) {
    draw();
    return;
  }
  curKey = key;
  curPeaks = null;
  lastProgressPx = -1;
  /* Markers and the baseline render immediately; peaks fill in when the
     cache read or the lazy decode lands. */
  draw();

  const folder = folderById(c.folderId);
  if (!folder) return;
  const cached = await loadPeaks(folder, src.path);
  if (cached) {
    if (curKey !== key) return; /* moved on while reading */
    curPeaks = cached;
    if (!curDuration) curDuration = cached.duration;
    draw();
    return;
  }
  void generatePeaks(folder, key, src.path, src.file, curDuration);
}

/** Lazy one-time decode for the waveform. Codec the browser can't decode →
    no waveform, plain slider; nothing else changes. */
async function generatePeaks(folder: ConnectedFolder, key: string, path: string, file: File | undefined, durationHint: number): Promise<void> {
  if (!file || generating.has(key) || file.size > MAX_DECODE_BYTES) return;
  generating.add(key);
  try {
    const rate = 8000;
    const raw = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, Math.max(rate, Math.ceil(Math.max(1, durationHint || 60) * rate)), rate);
    const decoded = await ctx.decodeAudioData(raw);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) channels.push(decoded.getChannelData(ch));
    const data: PeakData = { version: 1, duration: decoded.duration, pairs: bucketPeaks(channels, 1500) };
    savePeaks(folder, path, data);
    if (curKey === key) {
      curPeaks = data;
      if (!curDuration) curDuration = data.duration;
      draw();
    }
  } catch {
    /* undecodable here (ec-3 and friends) — the plain slider carries on */
  } finally {
    generating.delete(key);
  }
}

/* ---------- wiring ---------- */

export function wireWaveform(): void {
  canvas = $('#waveCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * scale) || 480;
  canvas.height = Math.round(canvas.clientHeight * scale) || 26;
  /* Marker names on hover; the range input above stays the drag surface. */
  canvas.addEventListener('mousemove', (e) => {
    if (!markers.length || !curDuration || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const sec = ((e.clientX - r.left) / r.width) * curDuration;
    let best: { sec: number; label: string } | null = null;
    for (const m of markers) {
      if (!best || Math.abs(m.sec - sec) < Math.abs(best.sec - sec)) best = m;
    }
    canvas.title = best && Math.abs(best.sec - sec) < curDuration * 0.05 ? best.label + ' · ' + fmtTime(best.sec) : '';
  });
}

/* =========================================================================
   Auto-split: "Find track breaks"
   ========================================================================= */

interface EditorRow {
  startSec: number;
  title: string;
}

let editorTrack: FileTrack | null = null;
let editorRows: EditorRow[] = [];

export async function runAutoSplit(uid: string): Promise<void> {
  const t = S.byUid[uid];
  if (!t || t.kind !== 'file' || !t.file) return;
  const folder = folderById(t.folderId);
  if (!folder) return;
  toast('Listening for track breaks in ' + t.title + '…');
  try {
    const result = await analyzeForSplit(t.file, t.duration);
    /* The decode is in hand — keep the waveform output too. */
    savePeaks(folder, t.path, { version: 1, duration: result.duration, pairs: result.peaks });
    const starts = [0, ...result.proposals];
    if (starts.length < 2) toast('No clear silences found — add boundaries by hand');
    openSplitEditor(
      t,
      starts.map((s, i) => ({ startSec: s, title: 'Track ' + String(i + 1).padStart(2, '0') }))
    );
  } catch (e) {
    logErr('auto-split', 'Could not analyse ' + t.title, (e as Error) && (e as Error).message);
    toast('That file could not be decoded for analysis');
  }
}

export function openSplitEditor(t: FileTrack, rows: EditorRow[]): void {
  editorTrack = t;
  editorRows = rows.slice().sort((a, b) => a.startSec - b.startSec);
  renderSplitEditor();
  $('#splitpanel').hidden = false;
  $('#splitscrim').hidden = false;
}

function closeSplitEditor(): void {
  $('#splitpanel').hidden = true;
  $('#splitscrim').hidden = true;
  editorTrack = null;
  editorRows = [];
}

/** mm:ss.d with FLOORED seconds — fmtTime rounds, and a boundary label that
    rounds 239.85 up to "4:00.8" reads as 240.8 and invites wrong nudges. */
function fmtBoundary(sec: number): string {
  const v = Math.round(sec * 10) / 10;
  const mm = Math.floor(v / 60);
  const rest = v - mm * 60;
  return mm + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
}

function renderSplitEditor(): void {
  const box = $('#splitrows');
  if (!editorTrack) return;
  let h = '';
  editorRows.forEach((r, i) => {
    h +=
      '<div class="split-row" data-i="' + i + '">' +
      '<button type="button" class="pb-btn" data-splitplay="' + i + '" title="Play from this boundary">' + icon('play') + '</button>' +
      '<span class="split-time">' + esc(fmtBoundary(r.startSec)) + '</span>' +
      '<button type="button" class="pill-ghost split-nudge" data-nudge="-0.5" ' + (i === 0 ? 'disabled' : '') + '>−0.5s</button>' +
      '<button type="button" class="pill-ghost split-nudge" data-nudge="0.5" ' + (i === 0 ? 'disabled' : '') + '>+0.5s</button>' +
      '<input class="inline-input split-name" type="text" value="' + esc(r.title) + '" maxlength="200" aria-label="Track name">' +
      (i === 0 ? '<span class="split-del"></span>' : '<button type="button" class="kebab-btn split-del" data-del="' + i + '" title="Remove this boundary" style="opacity:1">' + icon('close') + '</button>') +
      '</div>';
  });
  box.innerHTML = h;
  $('#splitTitle').textContent = 'Track breaks — ' + editorTrack.title;
  $('#splitHint').textContent =
    editorRows.length + ' tracks over ' + fmtTime(editorTrack.duration) + ' · boundaries write to the sidecar, the audio file is never touched';
}

export function wireSplitEditor(): void {
  $('#splitrows').addEventListener('click', (e) => {
    const target = e.target as Element;
    const row = target.closest('.split-row');
    if (!row) return;
    const i = parseInt(row.getAttribute('data-i') || '', 10);
    const nudge = target.closest('[data-nudge]');
    if (nudge && editorRows[i]) {
      syncNames();
      const d = parseFloat(nudge.getAttribute('data-nudge') || '0');
      editorRows[i].startSec = Math.max(0, Math.min((editorTrack ? editorTrack.duration : Infinity) - 1, editorRows[i].startSec + d));
      editorRows.sort((a, b) => a.startSec - b.startSec);
      renderSplitEditor();
      return;
    }
    const del = target.closest('[data-del]');
    if (del && editorRows[i]) {
      syncNames();
      editorRows.splice(i, 1);
      renderSplitEditor();
      return;
    }
    const play = target.closest('[data-splitplay]');
    if (play && editorRows[i] && editorTrack && S.current && S.current.file === editorTrack.file) {
      try {
        audio.currentTime = editorRows[i].startSec;
      } catch {
        /* not seekable */
      }
    }
  });
  $('#splitAdd').addEventListener('click', () => {
    syncNames();
    const at = S.current && S.current.file === (editorTrack && editorTrack.file) ? audio.currentTime : 0;
    editorRows.push({ startSec: Math.max(0, at), title: 'Track ' + String(editorRows.length + 1).padStart(2, '0') });
    editorRows.sort((a, b) => a.startSec - b.startSec);
    renderSplitEditor();
  });
  $('#splitCancel').addEventListener('click', closeSplitEditor);
  $('#splitscrim').addEventListener('click', closeSplitEditor);
  $('#splitSave').addEventListener('click', () => {
    void saveSplit();
  });
}

function syncNames(): void {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('#splitrows .split-name'));
  inputs.forEach((inp, i) => {
    if (editorRows[i]) editorRows[i].title = inp.value.trim() || editorRows[i].title;
  });
}

async function saveSplit(): Promise<void> {
  if (!editorTrack) return;
  syncNames();
  const t = editorTrack;
  const folder = folderById(t.folderId);
  if (!folder) return;
  if (folder.capability !== 'readwrite') {
    toast("'" + folder.label + "' is read-only in this browser — the cue cannot be saved");
    return;
  }
  const rel = 'cues/' + stripRoot(t.path) + '.cue';
  const text = buildCueText(t.path.slice(t.path.lastIndexOf('/') + 1), editorRows);
  try {
    await folder.backend.writeSidecarText(rel, text);
  } catch (e) {
    logErr('auto-split', 'Could not write ' + rel, (e as Error) && (e as Error).message);
    toast('The cue could not be saved — see the activity log');
    return;
  }
  toast('Saved ' + editorRows.length + ' track breaks — rescanning');
  closeSplitEditor();
  enqueueFolderScan(folder);
}
