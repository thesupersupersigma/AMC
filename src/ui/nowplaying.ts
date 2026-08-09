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

function rgb(r: number, g: number, b: number, scale: number): string {
  return 'rgb(' + Math.round(r * scale) + ',' + Math.round(g * scale) + ',' + Math.round(b * scale) + ')';
}

/** Two colours out of the cover: the mean of its brighter half and the
    mean of its darker half — cheap, stable, and always album-ish. */
function extractPalette(url: string): Promise<[string, string]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 24;
        cv.height = 24;
        const ctx = cv.getContext('2d');
        if (!ctx) return resolve(['#1c1c1e', '#101012']);
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        const px: Array<[number, number, number, number]> = [];
        for (let i = 0; i < d.length; i += 4) {
          const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          px.push([d[i], d[i + 1], d[i + 2], lum]);
        }
        px.sort((a, b) => b[3] - a[3]);
        const mean = (list: Array<[number, number, number, number]>): [number, number, number] => {
          let r = 0,
            g = 0,
            b = 0;
          for (const p of list) {
            r += p[0];
            g += p[1];
            b += p[2];
          }
          const n = Math.max(1, list.length);
          return [r / n, g / n, b / n];
        };
        const hi = mean(px.slice(0, Math.floor(px.length / 3)));
        const lo = mean(px.slice(-Math.floor(px.length / 3)));
        /* Darkened for use as a backdrop — text must stay readable. */
        resolve([rgb(hi[0], hi[1], hi[2], 0.42), rgb(lo[0], lo[1], lo[2], 0.28)]);
      } catch {
        resolve(['#1c1c1e', '#101012']);
      }
    };
    img.onerror = () => resolve(['#1c1c1e', '#101012']);
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

export function openNowPlaying(): void {
  if (open || !S.current) return;
  open = true;
  const view = $('#npview');
  view.innerHTML = markup();
  view.hidden = false;
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
  $('#npview').hidden = true;
  document.body.classList.remove('np-open');
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
  view.addEventListener('input', (e) => {
    const bar = (e.target as Element).closest('#npScrubBar') as HTMLInputElement | null;
    if (!bar || !S.current) return;
    scrubbing = true;
    const w = trackWindow(S.current);
    const frac = Number(bar.value) / 1000;
    try {
      audio.currentTime = w.start + frac * Math.max(0, w.end - w.start);
    } catch {
      /* not seekable right now */
    }
  });
  view.addEventListener('change', (e) => {
    if ((e.target as Element).closest('#npScrubBar')) scrubbing = false;
  });
}
