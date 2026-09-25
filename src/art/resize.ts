/* High-quality downscaling for both artwork tiers. createImageBitmap with
   resizeQuality 'high' decodes and resamples in one step, off the main
   thread in Chromium; the canvas only encodes. Where the resize options
   are unsupported, a plain decode + a high-smoothing drawImage does the
   same job on the main thread. */

import { imageSize, type ImgSize } from './imgsize';

export interface Scaled {
  blob: Blob;
  w: number;
  h: number;
}

function fitWithin(w: number, h: number, maxPx: number): { w: number; h: number } {
  const s = Math.min(1, maxPx / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function encode(bmp: ImageBitmap, w: number, h: number, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h);
      const octx = oc.getContext('2d');
      if (octx) {
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(bmp, 0, 0, w, h);
        return oc.convertToBlob({ type: type, quality: quality }).catch(() => null);
      }
    } catch {
      /* fall through to a DOM canvas */
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise((res) => {
    try {
      c.toBlob((out) => res(out), type, quality);
    } catch {
      res(null);
    }
  });
}

/** Scales an image so its longest side is at most maxPx and encodes it.
    Never upscales. Resolves null when the browser cannot decode it. */
export async function downscaleBlob(blob: Blob, maxPx: number, type: string, quality: number, known?: ImgSize | null): Promise<Scaled | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const size = known || (await imageSize(blob));
  let bmp: ImageBitmap | null = null;
  let w = 0;
  let h = 0;
  try {
    if (size && size.w > 0 && size.h > 0) {
      ({ w, h } = fitWithin(size.w, size.h, maxPx));
      try {
        bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      } catch {
        bmp = await createImageBitmap(blob);
      }
    } else {
      bmp = await createImageBitmap(blob);
      ({ w, h } = fitWithin(bmp.width, bmp.height, maxPx));
    }
    const out = await encode(bmp, w, h, type, quality);
    return out ? { blob: out, w: w, h: h } : null;
  } finally {
    if (bmp && bmp.close) bmp.close();
  }
}

/** Natural size by decoding — only for the rare header the sniffer cannot
    read. The bitmap is closed immediately. */
export async function decodedSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(blob);
    const out = { w: bmp.width, h: bmp.height };
    if (bmp.close) bmp.close();
    return out;
  } catch {
    return null;
  }
}
