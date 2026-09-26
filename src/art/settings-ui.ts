/* Settings › Artwork: the quality level, what covers cost in space at
   each level (measured from this library), and the bulk re-download. */

import { S, coverBlob, savePrefs } from '../state';
import { toast, esc, plural } from '../util';
import { imageSize } from './imgsize';
import { catalogCoverBlob } from './hero';
import { scheduleHeroUpgrade } from './dom';
import { QUALITY_LEVELS, currentQuality, isArtQuality, levelOf } from './quality';
import { onRedownloadProgress, redownloadCatalogArtwork, redownloadProgress, redownloadRunning } from './catalogart';

/* Apple's catalog JPEGs run about a quarter of a byte per pixel; used
   until this library has stored catalog covers of its own to measure. */
const DEFAULT_BYTES_PER_PX = 0.25;
/* "Max" asks the catalog for 3000 px. */
const MAX_CATALOG_PX = 3000;

export interface ArtworkSpace {
  thumbs: number;
  thumbBytes: number;
  catalog: number;
  catalogBytes: number;
  inSidecar: number;
  inBrowser: number;
  embedded: number;
  bytesPerPx: number;
  /** level id → estimated bytes for all covers at that level. */
  estimate: Record<string, number>;
}

function mb(bytes: number): string {
  if (bytes < 1048576) return Math.max(0.1, bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0) + ' MB';
}

/** Measures what covers use now and estimates each level. Catalog covers
    are the only part that changes with the level: thumbs are display-sized
    and embedded art is read from the audio files, never stored again. */
export async function measureArtworkSpace(): Promise<ArtworkSpace> {
  const out: ArtworkSpace = {
    thumbs: 0, thumbBytes: 0, catalog: 0, catalogBytes: 0, inSidecar: 0, inBrowser: 0, embedded: 0,
    bytesPerPx: DEFAULT_BYTES_PER_PX, estimate: {},
  };
  let pixels = 0;
  let measuredBytes = 0;
  for (const al of S.albums) {
    const t = coverBlob(al.key);
    if (t) {
      out.thumbs++;
      out.thumbBytes += t.size;
    }
    const c = await catalogCoverBlob(al.key);
    if (c) {
      out.catalog++;
      out.catalogBytes += c.blob.size;
      if (c.source === 'sidecar') out.inSidecar++;
      else out.inBrowser++;
      const s = await imageSize(c.blob);
      if (s && s.w > 0 && s.h > 0) {
        pixels += s.w * s.h;
        measuredBytes += c.blob.size;
      }
    } else if (al.tracks.some((x) => x.hasArt)) {
      out.embedded++;
    }
  }
  if (pixels > 0) out.bytesPerPx = measuredBytes / pixels;
  for (const l of QUALITY_LEVELS) {
    const px = isFinite(l.heroPx) ? l.catalogPx[0] : MAX_CATALOG_PX;
    out.estimate[l.id] = out.thumbBytes + out.catalog * out.bytesPerPx * px * px;
  }
  return out;
}

export function artworkSectionHTML(): string {
  const q = currentQuality();
  let h = '<div class="set-sect" id="setArtwork"><h2>Artwork</h2>';
  h += '<div class="set-row">Artwork quality <div class="set-seg" role="group" aria-label="Artwork quality">';
  for (const l of QUALITY_LEVELS) {
    const size = isFinite(l.heroPx) ? l.heroPx + ' px' : 'original';
    h += '<button type="button" class="seg-btn' + (l.id === q ? ' on' : '') + '" data-artq="' + l.id + '" aria-pressed="' + (l.id === q) + '" title="' + esc(l.label + ' — ' + size) + '">' +
      esc(l.label) + ' <span class="set-artsz">' + size + '</span> <span class="set-artest" data-artest="' + l.id + '"></span></button>';
  }
  h += '</div></div>';
  h += '<p class="set-hint" id="setArtSpace">' + (lastSpace ? esc(spaceText(lastSpace)) : 'Measuring what covers use…') + '</p>';
  h += '<p class="set-hint">The large covers on album pages, Now Playing, the mini player and the system media controls use this size. Lists and the album grid keep small thumbnails sized to this screen. A new level applies as albums are opened or played — nothing is downloaded in bulk unless you ask:</p>';
  h += '<div class="set-row"><button type="button" class="pill-ghost set-small" data-art-redownload' + (redownloadRunning() ? ' disabled' : '') + '>Re-download artwork at this quality</button>' +
    '<span class="set-hint" id="setArtProgress">' + esc(redownloadProgress()) + '</span></div>';
  h += '</div>';
  /* After the render has reached the DOM (a macrotask, not rAF — rAF
     does not run in a hidden tab). */
  setTimeout(() => {
    void fillArtworkSpace();
  }, 0);
  return h;
}

let lastSpace: ArtworkSpace | null = null;
let measuring: Promise<ArtworkSpace> | null = null;

function spaceText(sp: ArtworkSpace): string {
  const now = sp.thumbBytes + sp.catalogBytes;
  const parts: string[] = [];
  parts.push(plural(sp.thumbs, 'thumbnail', 'thumbnails') + ' (' + mb(sp.thumbBytes) + ', browser cache)');
  if (sp.catalog) {
    const where: string[] = [];
    if (sp.inSidecar) where.push(sp.inSidecar + ' in the sidecar');
    if (sp.inBrowser) where.push(sp.inBrowser + ' in the browser');
    parts.push(plural(sp.catalog, 'catalog cover', 'catalog covers') + ' (' + mb(sp.catalogBytes) + '; ' + where.join(', ') + ')');
  }
  return (
    'Covers use about ' + mb(now) + ' now: ' + parts.join(' and ') + '. ' +
    (sp.embedded ? (sp.embedded === 1 ? '1 album uses the art inside its files and costs' : sp.embedded + ' albums use the art inside their files and cost') + ' nothing extra at any level. ' : '') +
    (sp.catalog ? 'Catalog covers are what grows with the level' + (sp.bytesPerPx !== DEFAULT_BYTES_PER_PX ? ' (measured ' + sp.bytesPerPx.toFixed(2) + ' bytes per pixel)' : '') + '.' : 'With no catalog covers yet, every level costs the same.')
  );
}

function paintSpace(sp: ArtworkSpace): void {
  const el = document.getElementById('setArtSpace');
  if (el) el.textContent = spaceText(sp);
  for (const l of QUALITY_LEVELS) {
    const e = document.querySelector('[data-artest="' + l.id + '"]');
    if (e) e.textContent = '≈ ' + mb(sp.estimate[l.id]);
  }
}

async function fillArtworkSpace(): Promise<void> {
  if (!document.getElementById('setArtSpace')) return;
  if (lastSpace) paintSpace(lastSpace);
  if (!measuring) {
    measuring = measureArtworkSpace().finally(() => {
      measuring = null;
    });
  }
  try {
    lastSpace = await measuring;
  } catch (e) {
    const box = document.getElementById('setArtSpace');
    if (box) box.textContent = 'Could not measure the cover storage: ' + ((e as Error) && (e as Error).message);
    return;
  }
  paintSpace(lastSpace);
}

function syncButtons(): void {
  const q = currentQuality();
  document.querySelectorAll<HTMLElement>('[data-artq]').forEach((b) => {
    const on = b.getAttribute('data-artq') === q;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function wireArtworkSettings(): void {
  onRedownloadProgress((text) => {
    const el = document.getElementById('setArtProgress');
    if (el) el.textContent = text;
    const btn = document.querySelector<HTMLButtonElement>('[data-art-redownload]');
    if (btn) btn.disabled = redownloadRunning();
    if (!redownloadRunning()) void fillArtworkSpace();
  });
  const view = document.getElementById('view');
  if (!view) return;
  view.addEventListener('click', (e) => {
    const target = e.target as Element;
    const lv = target.closest('[data-artq]');
    if (lv) {
      const v = lv.getAttribute('data-artq');
      if (!isArtQuality(v) || v === S.artQuality) return;
      S.artQuality = v;
      savePrefs();
      syncButtons();
      scheduleHeroUpgrade();
      const l = levelOf(v);
      toast('Artwork quality: ' + l.label + ' — applies as albums are opened or played');
      return;
    }
    if (target.closest('[data-art-redownload]')) {
      const btn = target.closest('[data-art-redownload]') as HTMLButtonElement;
      btn.disabled = true;
      void redownloadCatalogArtwork().finally(() => {
        const b = document.querySelector<HTMLButtonElement>('[data-art-redownload]');
        if (b) b.disabled = false;
        void fillArtworkSpace();
      });
    }
  });
}
