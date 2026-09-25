/* Phase 6 — Document Picture-in-Picture mini player: a real always-on-top
   floating window with live DOM — artwork, title, transport, scrubber.
   Feature-detected; the button never renders where the API is missing.
   Audio keeps playing in the main window; the PiP document only holds
   controls, so closing it changes nothing about playback. */

import type { AnyTrack } from '../types';
import { S, coverURL } from '../state';
import { audio } from '../audio/engine';
import { next, prev, togglePlay } from './player';
import { icon, solid } from './icons';
import { fmtTime, $ } from '../util';
import { heroURLNow } from '../art/hero'; // hires-art hook

interface DocPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
}

function docPiP(): DocPiP | null {
  const w = window as unknown as { documentPictureInPicture?: DocPiP };
  return w.documentPictureInPicture || null;
}

export function pipSupported(): boolean {
  return !!docPiP();
}

let pipWin: Window | null = null;
let pipTimer: ReturnType<typeof setInterval> | null = null;

/** Test hook and state probe — null when no mini player is open. */
export function getPipWindow(): Window | null {
  return pipWin;
}

const PIP_CSS = [
  '*{margin:0;padding:0;box-sizing:border-box}',
  'body{font:12px -apple-system,system-ui,sans-serif;background:#161618;color:#f2f2f4;height:100vh;display:flex;align-items:center;gap:12px;padding:10px 14px;overflow:hidden;user-select:none}',
  '#art{width:72px;height:72px;border-radius:8px;object-fit:cover;background:#2c2c2e;flex:0 0 72px}',
  '#meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
  '#title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '#artist{font-size:11px;color:#9a9aa0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '#scrub{width:100%;accent-color:#fa243c;height:14px}',
  '#row{display:flex;align-items:center;gap:8px}',
  '#times{font-size:10px;color:#9a9aa0;font-variant-numeric:tabular-nums;margin-left:auto}',
  'button{background:none;border:0;color:#f2f2f4;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:6px}',
  'button:hover{background:rgba(255,255,255,.09)}',
  'svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
  '#play svg{fill:currentColor;stroke:none}',
].join('\n');

function pipMarkup(): string {
  return (
    '<img id="art" alt="">' +
    '<div id="meta">' +
    '<div id="title"></div><div id="artist"></div>' +
    '<div id="row">' +
    '<button id="prev" title="Previous"><svg viewBox="0 0 24 24">' + iconBody('prev') + '</svg></button>' +
    '<button id="play" title="Play or pause"></button>' +
    '<button id="next" title="Next"><svg viewBox="0 0 24 24">' + iconBody('next') + '</svg></button>' +
    '<span id="times"></span>' +
    '</div>' +
    '<input id="scrub" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">' +
    '</div>'
  );
}

/* icons.ts renders full <svg> wrappers sized for the app shell; the PiP
   document styles its own, so it takes just the path body. */
function iconBody(name: string): string {
  const m = icon(name).match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return m ? m[1] : '';
}
function solidBody(name: string): string {
  const m = solid(name).match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return m ? m[1] : '';
}

function trackWindowOf(t: AnyTrack): { start: number; end: number } {
  if (t.kind === 'virtual') return { start: t.startSec, end: t.endSec || t.startSec + (t.duration || 0) };
  return { start: 0, end: t.duration || audio.duration || 0 };
}

let pipScrubbing = false;

function pipUpdate(): void {
  if (!pipWin || pipWin.closed) return;
  const d = pipWin.document;
  const t = S.current;
  const set = (id: string, text: string): void => {
    const el = d.getElementById(id);
    if (el) el.textContent = text;
  };
  if (!t) {
    set('title', 'Nothing playing');
    set('artist', '');
    return;
  }
  set('title', t.title);
  set('artist', t.artist);
  const art = d.getElementById('art') as HTMLImageElement | null;
  const url = heroURLNow(t) || coverURL(t.coverKey); // hires-art hook
  if (art && art.getAttribute('src') !== url) {
    if (url) art.src = url;
    else art.removeAttribute('src');
  }
  const w = trackWindowOf(t);
  const dur = Math.max(0.001, w.end - w.start);
  const pos = Math.max(0, (audio.currentTime || 0) - w.start);
  set('times', fmtTime(pos) + ' / ' + fmtTime(dur));
  const scrub = d.getElementById('scrub') as HTMLInputElement | null;
  if (scrub && !pipScrubbing) scrub.value = String(Math.round((pos / dur) * 1000));
  const play = d.getElementById('play');
  if (play) play.innerHTML = '<svg viewBox="0 0 24 24">' + solidBody(audio.paused ? 'play' : 'pause') + '</svg>';
}

async function openPip(): Promise<void> {
  const api = docPiP();
  if (!api) return;
  const win = await api.requestWindow({ width: 380, height: 96 });
  pipWin = win;
  win.document.title = 'AMC';
  const style = win.document.createElement('style');
  style.textContent = PIP_CSS;
  win.document.head.appendChild(style);
  win.document.body.innerHTML = pipMarkup();

  win.document.body.addEventListener('click', (e) => {
    const el = e.target as Element;
    if (el.closest('#prev')) prev();
    else if (el.closest('#next')) next(true);
    else if (el.closest('#play')) togglePlay();
    pipUpdate();
  });
  const scrub = win.document.getElementById('scrub') as HTMLInputElement;
  scrub.addEventListener('input', () => {
    pipScrubbing = true;
    const t = S.current;
    if (!t) return;
    const w = trackWindowOf(t);
    try {
      audio.currentTime = w.start + (Number(scrub.value) / 1000) * Math.max(0, w.end - w.start);
    } catch {
      /* not seekable right now */
    }
  });
  scrub.addEventListener('change', () => {
    pipScrubbing = false;
  });
  win.addEventListener('pagehide', closePip);

  pipTimer = setInterval(pipUpdate, 300);
  pipUpdate();
  const btn = $('#btnPip');
  if (btn) btn.classList.add('on');
}

function closePip(): void {
  if (pipTimer) clearInterval(pipTimer);
  pipTimer = null;
  if (pipWin && !pipWin.closed) {
    try {
      pipWin.close();
    } catch {
      /* already closing */
    }
  }
  pipWin = null;
  pipScrubbing = false;
  const btn = $('#btnPip');
  if (btn) btn.classList.remove('on');
}

export function wirePip(): void {
  const btn = $('#btnPip');
  if (!btn) return;
  if (!pipSupported()) {
    /* Feature-detect and hide — no dead control where the API is absent. */
    btn.hidden = true;
    return;
  }
  btn.innerHTML = icon('pip');
  btn.addEventListener('click', () => {
    if (pipWin) closePip();
    else
      void openPip().catch((e: Error) => {
        /* Chrome refuses outside a user gesture or in kiosk contexts —
           playback is untouched either way. */
        closePip();
        import('./log').then((m) => m.logErr('pip', 'The mini player could not open', e && e.message));
      });
  });
}
