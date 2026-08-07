/* Small shared helpers: DOM shorthand, formatting, the toast. */

export function $<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T {
  return (root || document).querySelector(sel) as T;
}
export function $$<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T[] {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel)) as T[];
}
export function tick(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
}
export function fmtDur(sec: number): string {
  return !isFinite(sec) || sec <= 0 ? '--:--' : fmtTime(sec);
}
export function fmtTotal(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  const mins = Math.round(sec / 60);
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60),
    m = mins % 60;
  return m ? h + ' hr ' + m + ' min' : h + ' hr';
}
export function plural(n: number, one: string, many: string): string {
  return n + ' ' + (n === 1 ? one : many);
}
export function norm(s: unknown): string {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase();
}
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function uuid(): string {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through to the manual path */
  }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20, 32);
}

export function isTyping(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string): void {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2400);
}
