/* Phase 4c — the lyrics panel.

   The animation is the Apple treatment: lines stack vertically, the active
   line sits centred at full opacity and scale 1.0, inactive lines dim to
   ~0.92 scale, and the whole block eases into place through ONE transform
   transition — a transition, not a scroll. With Enhanced LRC, each word
   fills left-to-right through a background-clip:text gradient. Everything
   is driven from requestAnimationFrame reading audio.currentTime —
   timeupdate fires ~4×/sec and visibly stutters against word timing.
   prefers-reduced-motion collapses it all to a plain highlight. */

import type { AnyTrack, LrcLine } from '../types';
import { S, refOf } from '../state';
import { audio } from '../audio/engine';
import { resolveLyrics, saveLyrics, sidecarLyricsRel, type ResolvedLyrics } from '../net/lyrics';
import { parseLrc, buildLrcText } from '../parse/lrc';
import { folderById } from '../fs/folders';
import { icon } from './icons';
import { esc, toast, $ } from '../util';

let open = false;
let editing = false;
let cur: ResolvedLyrics | null = null;
let curKey = '';
let activeIdx = -1;
let curWordEl: HTMLElement | null = null;
let curWordIdx = -1;
let rafId = 0;
let lineEls: HTMLElement[] = [];

const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function reducedMotion(): boolean {
  return !!(reduced && reduced.matches);
}

function baseOf(t: AnyTrack): number {
  return t.kind === 'virtual' ? t.startSec : 0;
}
function relTime(): number {
  const c = S.current;
  return c ? Math.max(0, (audio.currentTime || 0) - baseOf(c)) : 0;
}

const SOURCE_LABELS: Record<ResolvedLyrics['source'], string> = {
  sidecar: 'from the sidecar',
  sibling: 'from a file beside the music',
  tag: 'from the file’s tags',
  lrclib: 'from LRCLIB — saved for offline',
};

/* ---------- open/close ---------- */

export function lyricsPanelOpen(): boolean {
  return open;
}

export function toggleLyrics(): void {
  open = !open;
  const panel = $('#lyricspanel');
  panel.classList.toggle('open', open);
  $('#btnLyrics').classList.toggle('on', open);
  if (open) {
    void refresh();
  } else {
    stopLoop();
    editing = false;
  }
}

/** Called on every track change and gapless swap. Lyrics are lazy: nothing
    resolves — and nothing fetches — until the panel is actually open. */
export function lyricsTrackChanged(): void {
  if (!open) return;
  if (editing) return; /* an edit in progress survives the queue advancing */
  void refresh();
}

/* ---------- resolve + render ---------- */

async function refresh(): Promise<void> {
  const c = S.current;
  const body = $('#lyrbody');
  stopLoop();
  if (!c) {
    curKey = '';
    cur = null;
    $('#lyrSource').textContent = '';
    body.className = 'static';
    body.innerHTML = '<div class="lyr-empty">Nothing playing.</div>';
    return;
  }
  const key = refOf(c.folderId, c.path);
  curKey = key;
  $('#lyrTitle').textContent = c.title;
  $('#lyrSource').textContent = '';
  body.className = 'static';
  body.innerHTML = '<div class="lyr-empty"><span class="spinner"></span>Looking for lyrics…</div>';
  const res = await resolveLyrics(c);
  if (curKey !== key || editing) return; /* moved on meanwhile */
  cur = res;
  renderView();
}

function renderView(): void {
  const body = $('#lyrbody');
  const c = S.current;
  if (!c || !cur || !cur.lines.length) {
    body.className = 'static';
    body.innerHTML =
      '<div class="lyr-empty">No lyrics found for this track.' +
      (c ? '<br><span class="dim2">LRCLIB rarely has vinyl rips — Edit lets you paste and time them.</span>' : '') +
      '</div>';
    $('#lyrSource').textContent = '';
    return;
  }
  $('#lyrSource').textContent = SOURCE_LABELS[cur.source] + (cur.synced ? '' : ' · not time-synced');
  let h = '<div id="lyrscroll">';
  for (let i = 0; i < cur.lines.length; i++) {
    const l = cur.lines[i];
    let inner: string;
    if (l.words && l.words.length) {
      inner = l.words.map((w) => '<span class="lyr-word">' + esc(w.text) + '</span>').join(' ');
    } else {
      inner = esc(l.text || '…');
    }
    h += '<div class="lyr-line" data-li="' + i + '">' + (inner || '…') + '</div>';
  }
  h += '</div>';
  body.className = cur.synced ? '' : 'static';
  body.innerHTML = h;
  lineEls = Array.from(body.querySelectorAll<HTMLElement>('.lyr-line'));
  activeIdx = -1;
  curWordEl = null;
  curWordIdx = -1;
  if (cur.synced) {
    setActiveLine(-1);
    startLoop();
  }
}

/* ---------- the animation loop ---------- */

function startLoop(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(tick);
}
function stopLoop(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function tick(): void {
  rafId = 0;
  if (!open || editing || !cur || !cur.synced) return;
  const t = relTime();
  const lines = cur.lines;

  /* Active line: the last one at or before t. */
  let idx = activeIdx;
  if (idx < 0 || idx >= lines.length || lines[idx].timeSec > t) idx = -1;
  while (idx + 1 < lines.length && lines[idx + 1].timeSec <= t) idx++;
  if (idx !== activeIdx) setActiveLine(idx);

  /* Word fill within the active line. */
  const line = idx >= 0 ? lines[idx] : null;
  if (line && line.words && line.words.length && lineEls[idx]) {
    const words = line.words;
    let wi = -1;
    while (wi + 1 < words.length && words[wi + 1].timeSec <= t) wi++;
    const spans = lineEls[idx].querySelectorAll<HTMLElement>('.lyr-word');
    if (wi !== curWordIdx) {
      for (let k = 0; k < spans.length; k++) spans[k].style.setProperty('--fill', k < wi ? '1' : '0');
      curWordIdx = wi;
      curWordEl = wi >= 0 ? spans[wi] || null : null;
    }
    if (curWordEl && wi >= 0) {
      if (reducedMotion()) {
        curWordEl.style.setProperty('--fill', '1');
      } else {
        const start = words[wi].timeSec;
        const nextLine = idx + 1 < lines.length ? lines[idx + 1].timeSec : start + 1.5;
        const end = wi + 1 < words.length ? words[wi + 1].timeSec : Math.max(start + 0.3, Math.min(nextLine, start + 2.5));
        const p = end > start ? Math.max(0, Math.min(1, (t - start) / (end - start))) : 1;
        curWordEl.style.setProperty('--fill', p.toFixed(3));
      }
    }
  }
  if (!audio.paused) rafId = requestAnimationFrame(tick);
}

function setActiveLine(idx: number): void {
  for (let i = 0; i < lineEls.length; i++) {
    lineEls[i].classList.toggle('active', i === idx);
    lineEls[i].classList.toggle('past', idx >= 0 && i < idx);
  }
  activeIdx = idx;
  curWordIdx = -1;
  curWordEl = null;
  const body = $('#lyrbody');
  const scroll = body.querySelector<HTMLElement>('#lyrscroll');
  if (!scroll) return;
  const el = idx >= 0 ? lineEls[idx] : lineEls[0];
  if (!el) return;
  /* One transform on the block — the CSS transition does the easing. */
  const target = body.clientHeight / 2 - el.offsetTop - el.offsetHeight / 2;
  scroll.style.transform = 'translateY(' + target.toFixed(1) + 'px)';
}

/* ---------- editor ------------------------------------------------------
   Paste (or start from what is showing), press Enter to stamp the selected
   line at the playhead, arrows to move and nudge, Save writes the sidecar.
   LRCLIB will not have vinyl rips or 2008 remasters — this is how those
   get lyrics at all. ---------- */

let editLines: LrcLine[] = [];
let editSel = 0;

function enterEditor(): void {
  const c = S.current;
  if (!c) {
    toast('Play the track you want to time lyrics against');
    return;
  }
  editing = true;
  stopLoop();
  editLines = cur ? cur.lines.map((l) => ({ timeSec: l.timeSec, text: l.text, words: l.words })) : [];
  editSel = 0;
  renderEditor();
}

function renderEditor(): void {
  const body = $('#lyrbody');
  body.className = 'static';
  const raw = cur ? cur.raw : '';
  body.innerHTML =
    '<div class="lyr-editor">' +
    '<textarea id="lyrEdText" spellcheck="false" placeholder="Paste lyrics here — plain lines or [mm:ss.xx] LRC">' + esc(raw) + '</textarea>' +
    '<div class="lyr-ed-actions"><button type="button" class="pill-ghost" id="lyrEdParse">Use this text</button>' +
    '<span class="dim2">then stamp each line while it plays</span></div>' +
    '<div class="lyr-ed-rows" id="lyrEdRows" tabindex="0" aria-label="Lyric lines to stamp"></div>' +
    '<div class="lyr-ed-actions">' +
    '<span class="dim2">Enter stamps at the playhead · ↑↓ select · ←→ nudge ±0.2s</span>' +
    '<button type="button" class="pill-ghost" id="lyrEdCancel">Cancel</button>' +
    '<button type="button" class="pill-play" id="lyrEdSave">Save</button>' +
    '</div></div>';
  renderEditorRows();
}

function fmtStamp(sec: number): string {
  if (sec < 0) return '--:--';
  const mm = Math.floor(sec / 60);
  const ss = sec - mm * 60;
  return mm + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2);
}

function renderEditorRows(): void {
  const box = document.getElementById('lyrEdRows');
  if (!box) return;
  let h = '';
  editLines.forEach((l, i) => {
    h +=
      '<div class="lyr-ed-row' + (i === editSel ? ' sel' : '') + '" data-ei="' + i + '">' +
      '<span class="lyr-ed-time">' + fmtStamp(l.timeSec) + '</span>' +
      '<span class="lyr-ed-text">' + esc(l.text) + '</span>' +
      '</div>';
  });
  box.innerHTML = h || '<div class="lyr-empty">Paste text above, then “Use this text”.</div>';
  const sel = box.querySelector<HTMLElement>('.lyr-ed-row.sel');
  if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'nearest' });
}

function exitEditor(refreshAfter: boolean): void {
  editing = false;
  editLines = [];
  if (refreshAfter) void refresh();
  else renderView();
}

/* ---------- wiring ---------- */

export function wireLyrics(): void {
  $('#btnLyrics').innerHTML = icon('lyrics');
  $('#btnLyrics').addEventListener('click', toggleLyrics);
  $('#lyrClose').innerHTML = icon('close');
  $('#lyrClose').addEventListener('click', toggleLyrics);
  $('#lyrEdit').addEventListener('click', () => {
    if (!editing) enterEditor();
  });

  audio.addEventListener('play', () => {
    if (open && cur && cur.synced && !editing) startLoop();
  });
  /* A paused track needs no loop; hidden tabs suspend rAF anyway. */
  audio.addEventListener('pause', stopLoop);
  if (reduced && typeof reduced.addEventListener === 'function') {
    reduced.addEventListener('change', () => {
      if (open && !editing) renderView();
    });
  }

  const body = $('#lyrbody');
  body.addEventListener('click', (e) => {
    const target = e.target as Element;

    if (target.closest('#lyrEdParse')) {
      const ta = document.getElementById('lyrEdText') as HTMLTextAreaElement | null;
      editLines = parseLrc(ta ? ta.value : '').map((l) => ({ timeSec: l.timeSec, text: l.text, words: l.words }));
      editSel = 0;
      renderEditorRows();
      const rows = document.getElementById('lyrEdRows');
      if (rows) rows.focus();
      return;
    }
    if (target.closest('#lyrEdCancel')) {
      exitEditor(false);
      return;
    }
    if (target.closest('#lyrEdSave')) {
      const c = S.current;
      if (!c) return;
      if (!editLines.length) {
        toast('Nothing to save');
        return;
      }
      const folder = folderById(c.folderId);
      if (folder && folder.capability !== 'readwrite') {
        toast("'" + folder.label + "' is read-only here — lyrics kept for this session only");
      }
      saveLyrics(c, buildLrcText(editLines));
      toast('Lyrics saved — ' + sidecarLyricsRel(c));
      exitEditor(true);
      return;
    }
    const edRow = target.closest('.lyr-ed-row');
    if (edRow) {
      editSel = parseInt(edRow.getAttribute('data-ei') || '0', 10);
      renderEditorRows();
      const rows = document.getElementById('lyrEdRows');
      if (rows) rows.focus();
      return;
    }
    const lineEl = target.closest('.lyr-line');
    if (lineEl && cur && cur.synced && S.current) {
      const i = parseInt(lineEl.getAttribute('data-li') || '', 10);
      const l = cur.lines[i];
      if (l && l.timeSec >= 0) {
        try {
          audio.currentTime = baseOf(S.current) + l.timeSec + 0.01;
        } catch {
          /* not seekable right now */
        }
      }
    }
  });

  body.addEventListener('keydown', (e) => {
    if (!editing) return;
    const rows = document.getElementById('lyrEdRows');
    if (!rows || document.activeElement !== rows) return;
    if (e.key === 'Enter') {
      if (editLines[editSel]) {
        editLines[editSel].timeSec = Math.round(relTime() * 100) / 100;
        editLines[editSel].words = undefined; /* a line-level restamp supersedes word times */
        if (editSel < editLines.length - 1) editSel++;
        renderEditorRows();
      }
    } else if (e.key === 'ArrowDown') {
      editSel = Math.min(editLines.length - 1, editSel + 1);
      renderEditorRows();
    } else if (e.key === 'ArrowUp') {
      editSel = Math.max(0, editSel - 1);
      renderEditorRows();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const l = editLines[editSel];
      if (l && l.timeSec >= 0) {
        l.timeSec = Math.max(0, l.timeSec + (e.key === 'ArrowLeft' ? -0.2 : 0.2));
        renderEditorRows();
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
}
