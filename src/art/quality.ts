/* Artwork quality levels — how large the hero tier (album header, Now
   Playing, turntable label and sleeve, PiP, Media Session) is allowed to
   be, and what size the catalog is asked for. The thumb tier (lists, grid,
   queue, sidebar) is sized separately, from the display (thumbsize.ts). */

import type { ArtQuality } from '../types';
import { S } from '../state';

export interface QualityLevel {
  id: ArtQuality;
  label: string;
  /** Longest side of the hero image. Infinity = the original, untouched. */
  heroPx: number;
  /** Catalog sizes to request, largest first. Anything after the first is
      a step-down for when the proxy reports the image as too large. */
  catalogPx: number[];
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { id: 'low', label: 'Low', heroPx: 600, catalogPx: [600] },
  { id: 'standard', label: 'Standard', heroPx: 1200, catalogPx: [1200] },
  { id: 'high', label: 'High', heroPx: 2000, catalogPx: [2000] },
  { id: 'max', label: 'Max', heroPx: Infinity, catalogPx: [3000, 2400, 2000] },
];

export const DEFAULT_QUALITY: ArtQuality = 'high';

export function isArtQuality(v: unknown): v is ArtQuality {
  return v === 'low' || v === 'standard' || v === 'high' || v === 'max';
}

export function levelOf(q: ArtQuality): QualityLevel {
  for (const l of QUALITY_LEVELS) if (l.id === q) return l;
  return QUALITY_LEVELS[2];
}

export function currentQuality(): ArtQuality {
  return isArtQuality(S.artQuality) ? S.artQuality : DEFAULT_QUALITY;
}

export function heroPxFor(q: ArtQuality): number {
  return levelOf(q).heroPx;
}

/** The size a catalog cover is stored at for a level — what "big enough"
    means when deciding whether a stored catalog cover needs upgrading. */
export function catalogPxFor(q: ArtQuality): number {
  return levelOf(q).catalogPx[0];
}
