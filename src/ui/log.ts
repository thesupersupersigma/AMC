/* Activity log — imported first, so everything after it is captured.
   The Chromebook has no DevTools; this panel is the only diagnostics. */

import { $, esc, pad2, toast } from '../util';
import { icon } from './icons';

interface LogEntry {
  when: string;
  who: string;
  what: string;
  detail: string;
}

let LOG: LogEntry[] = [];

function stamp(): string {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

export function logErr(scope: string, msg: unknown, detail?: unknown): void {
  try {
    LOG.push({
      when: stamp(),
      who: String(scope),
      what: String(msg == null ? 'Unknown problem' : msg),
      detail: detail == null ? '' : String(detail),
    });
    if (LOG.length > 600) LOG.shift();
    refreshLogUI();
  } catch {
    /* the logger itself must never throw */
  }
}

window.onerror = function (message, source, line, col, err) {
  logErr('script', message, err && err.stack ? err.stack : (source || '') + ':' + line + ':' + col);
  return false;
};
window.onunhandledrejection = function (ev) {
  const r = ev && (ev.reason as { message?: string; stack?: string } | undefined);
  logErr('promise', r && r.message ? r.message : String(r), r && r.stack ? r.stack : '');
};

export function refreshLogUI(): void {
  const dot = $('#logDot');
  if (dot) dot.hidden = LOG.length === 0;
  const panel = $('#errpanel');
  if (panel && !panel.hidden) renderLog();
}

export function renderLog(): void {
  const box = $('#errlist');
  if (!box) return;
  if (!LOG.length) {
    box.innerHTML =
      '<div class="empty-note"><b>Nothing has gone wrong yet</b>Files that fail to parse or decode, and any script error, will be listed here with the reason.</div>';
    return;
  }
  let h = '';
  for (let i = LOG.length - 1; i >= 0; i--) {
    const e = LOG[i];
    h +=
      '<div class="e"><span class="who">' + esc(e.who) + '</span><span class="when">' + esc(e.when) + '</span>' +
      '<div class="what">' + esc(e.what) + '</div>' +
      (e.detail ? '<div class="detail">' + esc(e.detail) + '</div>' : '') + '</div>';
  }
  box.innerHTML = h;
}

function logAsText(): string {
  return LOG.map((e) => '[' + e.when + '] ' + e.who + ': ' + e.what + (e.detail ? '\n    ' + e.detail : '')).join('\n');
}

export function toggleErrPanel(force?: boolean): void {
  const p = $('#errpanel'),
    sc = $('#scrim');
  const open = force === undefined ? p.hidden : force;
  p.hidden = !open;
  sc.hidden = !open;
  if (open) {
    renderLog();
    $('#errCopy').focus();
  }
}

export function wireErrPanel(): void {
  $('#logBtn').addEventListener('click', () => {
    toggleErrPanel(true);
  });
  $('#errClose').addEventListener('click', () => {
    toggleErrPanel(false);
  });
  $('#errClose').innerHTML = icon('close');
  $('#scrim').addEventListener('click', () => {
    toggleErrPanel(false);
  });
  $('#errClear').addEventListener('click', () => {
    LOG = [];
    renderLog();
    refreshLogUI();
  });
  $('#errCopy').addEventListener('click', () => {
    const text = logAsText() || 'No entries.';
    const done = (): void => {
      toast('Copied the log to the clipboard');
    };
    const fallback = (): void => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch {
        toast('Select the text in the panel and press Ctrl + C to copy it');
      }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch {
      fallback();
    }
  });
}
