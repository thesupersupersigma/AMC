/* Phase 5b — full-screen Now Playing and ambient theming.

   Large artwork, title, artist, the same waveform scrubber state the pill
   uses, and the lyrics panel a tap away. The cover's dominant colours
   become the backdrop — and the same palette, far more dilute, tints the
   sidebar and player pill so the whole shell leans toward the current
   album. Contrast beats drama: colours are darkened and used at low
   opacity; prefers-reduced-motion disables the transitions in CSS. */

import type { AnyTrack } from '../types';
import { FULL, S, coverURL, haveCover } from '../state';
import { audio } from '../audio/engine';
import { next, prev, togglePlay } from './player';
import { paintWaveInto } from './waveform';
import { toggleLyrics } from './lyrics';
import { icon, solid } from './icons';
import { fmtTime, $ } from '../util';

let open = false;
let timer: ReturnType<typeof setInterval> | null = null;
let scrubbing = false;

/* ---------- ambient palette ---------- */

const paletteCache = new Map<string, [string, string]>();
let ambientKey = '';

/** RGB → HSL and back, for taming extracted colours into backdrop range. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslCss(h: number, s: number, l: number): string {
  return 'hsl(' + Math.round(h * 360) + ',' + Math.round(s * 100) + '%,' + Math.round(l * 100) + '%)';
}

/** Dominant plus secondary colour via coarse RGB quantisation (512-bucket
    histogram, weighted toward saturated buckets so a colourful sleeve wins
    over its grey border). Both are clamped into backdrop range — dark
    enough that white text always reads. */
function extractPalette(url: string): Promise<[string, string]> {
  const FALLBACK: [string, string] = ['#1c1c1e', '#101012'];
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const N = 32;
        const cv = document.createElement('canvas');
        cv.width = N;
        cv.height = N;
        const ctx = cv.getContext('2d');
        if (!ctx) return resolve(FALLBACK);
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        interface Bucket {
          n: number;
          r: number;
          g: number;
          b: number;
        }
        const buckets = new Map<number, Bucket>();
        for (let i = 0; i < d.length; i += 4) {
          const key = ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5);
          const bk = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          bk.n++;
          bk.r += d[i];
          bk.g += d[i + 1];
          bk.b += d[i + 2];
          buckets.set(key, bk);
        }
        const rows = Array.from(buckets.values()).map((bk) => {
          const r = bk.r / bk.n;
          const g = bk.g / bk.n;
          const b = bk.b / bk.n;
          const [h, s, l] = rgbToHsl(r, g, b);
          /* Saturated mid-lightness colour outweighs greys and borders. */
          const score = bk.n * (0.2 + s) * (l > 0.06 && l < 0.94 ? 1 : 0.25);
          return { r: r, g: g, b: b, h: h, s: s, l: l, score: score };
        });
        rows.sort((a, b) => b.score - a.score);
        const dom = rows[0];
        if (!dom) return resolve(FALLBACK);
        const dist = (a: typeof dom, b: typeof dom): number => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        const sec = rows.find((x) => dist(x, dom) > 120) || rows[1] || dom;
        /* Into backdrop range: keep the hue, ensure some saturation, pull
           lightness down where white text lives on top of it. */
        const c1 = hslCss(dom.h, Math.min(0.75, Math.max(dom.s, 0.28)), Math.min(0.34, Math.max(0.2, dom.l * 0.6)));
        const c2 = hslCss(sec.h, Math.min(0.7, Math.max(sec.s, 0.22)), Math.min(0.22, Math.max(0.1, sec.l * 0.45)));
        resolve([c1, c2]);
      } catch {
        resolve(FALLBACK);
      }
    };
    img.onerror = () => resolve(FALLBACK);
    img.src = url;
  });
}

function applyAmbient(c1: string, c2: string): void {
  const root = document.documentElement;
  root.style.setProperty('--amb1', c1);
  root.style.setProperty('--amb2', c2);
  document.body.classList.add('ambient');
}

function clearAmbient(): void {
  document.body.classList.remove('ambient');
  ambientKey = '';
}

/** Recomputed on track change: the shell tint follows the current album
    whether or not the full-screen view is open. */
function updateAmbient(t: AnyTrack | null): void {
  if (!t || !haveCover(t.coverKey)) {
    clearAmbient();
    return;
  }
  if (t.coverKey === ambientKey) return;
  ambientKey = t.coverKey;
  const cached = paletteCache.get(t.coverKey);
  if (cached) {
    applyAmbient(cached[0], cached[1]);
    return;
  }
  const key = t.coverKey;
  void extractPalette(coverURL(t.coverKey)).then((pal) => {
    paletteCache.set(key, pal);
    if (ambientKey === key) applyAmbient(pal[0], pal[1]);
  });
}

/* ---------- the view ---------- */

function markup(): string {
  return (
    '<button type="button" class="np-close pb-btn" id="npClose" title="Close" aria-label="Close Now Playing">' + icon('chev') + '</button>' +
    '<div class="np-inner">' +
    '<div class="np-art"><img id="npArt" alt=""></div>' +
    '<div class="np-side">' +
    '<div class="np-title" id="npTitle"></div>' +
    '<div class="np-artist" id="npArtist"></div>' +
    '<div class="np-scrub"><canvas id="npWave"></canvas>' +
    '<input id="npScrubBar" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek within the track"></div>' +
    '<div class="np-times"><span id="npElapsed">0:00</span><span id="npRemain">-0:00</span></div>' +
    '<div class="np-controls">' +
    '<button type="button" class="pb-btn" id="npPrev" aria-label="Previous">' + icon('prev') + '</button>' +
    '<button type="button" class="pb-btn np-play" id="npPlay" aria-label="Play or pause"></button>' +
    '<button type="button" class="pb-btn" id="npNext" aria-label="Next">' + icon('next') + '</button>' +
    '<button type="button" class="pb-btn" id="npLyrics" title="Lyrics" aria-label="Lyrics">' + icon('lyrics') + '</button>' +
    '</div>' +
    '</div></div>'
  );
}

function trackWindow(t: AnyTrack): { start: number; end: number } {
  if (t.kind === 'virtual') return { start: t.startSec, end: t.endSec || t.startSec + (t.duration || 0) };
  return { start: 0, end: t.duration || audio.duration || 0 };
}

function refreshNow(): void {
  const t = S.current;
  const art = document.getElementById('npArt') as HTMLImageElement | null;
  if (!t) {
    if (art) art.removeAttribute('src');
    return;
  }
  const url = FULL.key === t.coverKey && FULL.url ? FULL.url : coverURL(t.coverKey);
  if (art) {
    if (url) art.src = url;
    else art.removeAttribute('src');
  }
  const title = document.getElementById('npTitle');
  const artist = document.getElementById('npArtist');
  if (title) title.textContent = t.title;
  if (artist) artist.textContent = t.artist + (t.album ? ' — ' + t.album : '');
  const w = trackWindow(t);
  const dur = Math.max(0.001, w.end - w.start);
  const pos = Math.max(0, (audio.currentTime || 0) - w.start);
  const el = document.getElementById('npElapsed');
  const rm = document.getElementById('npRemain');
  if (el) el.textContent = fmtTime(pos);
  if (rm) rm.textContent = '-' + fmtTime(Math.max(0, dur - pos));
  const bar = document.getElementById('npScrubBar') as HTMLInputElement | null;
  if (bar && !scrubbing) bar.value = String(Math.round((pos / dur) * 1000));
  const play = document.getElementById('npPlay');
  if (play) play.innerHTML = audio.paused ? solid('play') : solid('pause');
  const cv = document.getElementById('npWave') as HTMLCanvasElement | null;
  if (cv) {
    if (!cv.width || cv.width !== Math.round(cv.clientWidth * (window.devicePixelRatio || 1))) {
      cv.width = Math.round(cv.clientWidth * (window.devicePixelRatio || 1)) || 640;
      cv.height = Math.round(cv.clientHeight * (window.devicePixelRatio || 1)) || 54;
    }
    paintWaveInto(cv);
  }
}

export function nowPlayingOpen(): boolean {
  return open;
}

const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export function openNowPlaying(): void {
  if (open || !S.current) return;
  open = true;
  const view = $('#npview');
  view.innerHTML = markup();
  view.hidden = false;
  view.classList.remove('np-out');
  view.classList.add('np-in');
  setTimeout(() => view.classList.remove('np-in'), 400);
  document.body.classList.add('np-open');
  updateAmbient(S.current);
  refreshNow();
  timer = setInterval(refreshNow, 300);
}

export function closeNowPlaying(): void {
  if (!open) return;
  open = false;
  if (timer) clearInterval(timer);
  timer = null;
  const view = $('#npview');
  const finish = (): void => {
    view.hidden = true;
    view.classList.remove('np-out');
    document.body.classList.remove('np-open');
  };
  if (REDUCED && REDUCED.matches) {
    finish();
    return;
  }
  view.classList.add('np-out');
  setTimeout(finish, 250);
}

/** Track-change hook from the player: retint always, refresh if open. */
export function nowPlayingTrackChanged(): void {
  updateAmbient(S.current);
  if (open) {
    if (!S.current) closeNowPlaying();
    else refreshNow();
  }
}

/* ---------- wiring ---------- */

export function wireNowPlaying(): void {
  $('#pbArt').addEventListener('click', () => {
    if (S.current) openNowPlaying();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeNowPlaying();
  });
  const view = $('#npview');
  view.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('#npClose')) {
      closeNowPlaying();
      return;
    }
    if (target.closest('#npPrev')) {
      prev();
      return;
    }
    if (target.closest('#npNext')) {
      next(true);
      return;
    }
    if (target.closest('#npPlay')) {
      togglePlay();
      refreshNow();
      return;
    }
    if (target.closest('#npLyrics')) {
      toggleLyrics();
      return;
    }
  });
  /* The pill scrubber's proven pattern: preview while dragging, seek once
     on release. Seeking on every input event fights the 300ms refresh and
     stutters the decoder; scrubbing arms on pointerdown so the refresh
     never snaps the thumb back mid-grab. */
  view.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('#npScrubBar')) scrubbing = true;
  });
  view.addEventListener('input', (e) => {
    const bar = (e.target as Element).closest('#npScrubBar') as HTMLInputElement | null;
    if (!bar || !S.current) return;
    scrubbing = true;
    const w = trackWindow(S.current);
    const dur = Math.max(0.001, w.end - w.start);
    const pos = (Number(bar.value) / 1000) * dur;
    const el = document.getElementById('npElapsed');
    const rm = document.getElementById('npRemain');
    if (el) el.textContent = fmtTime(pos);
    if (rm) rm.textContent = '-' + fmtTime(Math.max(0, dur - pos));
  });
  const commitSeek = (e: Event): void => {
    const bar = (e.target as Element).closest('#npScrubBar') as HTMLInputElement | null;
    if (!bar) return;
    if (S.current && scrubbing) {
      const w = trackWindow(S.current);
      const frac = Number(bar.value) / 1000;
      try {
        audio.currentTime = w.start + frac * Math.max(0, w.end - w.start);
      } catch {
        /* not seekable right now */
      }
    }
    scrubbing = false;
    refreshNow();
  };
  view.addEventListener('change', commitSeek);
  view.addEventListener('pointerup', commitSeek);
  view.addEventListener('pointercancel', (e) => {
    if ((e.target as Element).closest('#npScrubBar')) scrubbing = false;
  });
}
