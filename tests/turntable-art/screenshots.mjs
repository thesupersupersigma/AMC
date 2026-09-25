/* Writes the PR screenshots into docs/turntable/:
     turntable-<w>x<h>-playing.png, turntable-<w>x<h>-swap.png  (1365×611, 1920×1080)
     artwork-before-after-1365x611.png — the album header at 1365×611 with
       the v2.2.3 thumb (300 px WebP q0.82, plain canvas downscale) vs the
       new hero, cropped and magnified 3× (nearest neighbour).
   FIXTURES=… NODE_PATH=$(npm root -g) node tests/turntable-art/screenshots.mjs */

import { mkdirSync } from 'node:fs';
import { startServer, launch, loadLibrary, albumKeys } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';
const OUT = new URL('../../docs/turntable/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

async function playIn(page, keys, album, idx, seek) {
  await page.evaluate(async ({ k, album, idx, seek }) => {
    window.__swap = await window.__mod('/src/ui/turntable/swap.ts');
    const p = await window.__mod('/src/ui/player.ts');
    p.playList(window.__st.S.albumMap[k[album]].tracks, idx);
    const np = await window.__mod('/src/ui/nowplaying.ts');
    if (!np.nowPlayingOpen()) np.openNowPlaying();
    if (seek) setTimeout(async () => (await window.__mod('/src/ui/turntable/playback.ts')).seek(seek), 600);
  }, { k: keys, album, idx, seek });
  await page.waitForFunction(() => !document.getElementById('audio').paused, null, { timeout: 10000 });
}

const server = await startServer();
try {
  for (const [w, h] of [[1365, 611], [1920, 1080]]) {
    const { browser, page } = await launch({ width: w, height: h });
    try {
      await loadLibrary(page, server.url, FIX, 11);
      const keys = await albumKeys(page);
      await playIn(page, keys, 'Delta Side A', 1, 312);
      if (!(await page.evaluate(() => document.getElementById('npview').classList.contains('np-tt')))) await page.click('#npMode');
      await page.waitForTimeout(3200);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.screenshot({ path: `${OUT}turntable-${w}x${h}-playing.png` });
      await playIn(page, keys, 'Alpha', 0, 0);
      await page.waitForTimeout(880);
      await page.screenshot({ path: `${OUT}turntable-${w}x${h}-swap.png` });
      await page.waitForTimeout(2500);
    } finally {
      await browser.close();
    }
  }

  /* before / after: the album header at the Chromebook size */
  const { browser, page } = await launch({ width: 1365, height: 611 });
  try {
    await loadLibrary(page, server.url, FIX, 11);
    const keys = await albumKeys(page);
    await page.evaluate(async (k) => (await window.__mod('/src/ui/render.ts')).navTo('album:' + k.Alpha), keys);
    await page.waitForFunction(() => {
      const im = document.querySelector('.detail .art img');
      return im && im.naturalWidth >= 2000;
    }, null, { timeout: 15000 });
    const box = await page.evaluate(() => {
      const r = document.querySelector('.detail .art').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const clip = { x: box.x, y: box.y, width: Math.round(box.width / 2), height: Math.round(box.height / 2) };
    const after = await page.screenshot({ clip });
    /* the v2.2.3 thumb, made exactly as makeThumb used to */
    await page.evaluate(async (k) => {
      const st = window.__st;
      const sc = await window.__mod('/src/scan/scanner.ts');
      const t = st.S.albumMap[k.Alpha].tracks[0];
      const src = await sc.extractArt(t.file);
      const bmp = await createImageBitmap(src);
      const scale = Math.min(1, 300 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
      const im = document.querySelector('.detail .art img');
      im.removeAttribute('data-hero');
      im.parentElement.removeAttribute('data-hero');
      im.src = URL.createObjectURL(blob);
      await im.decode();
    }, keys);
    await page.waitForTimeout(200);
    const before = await page.screenshot({ clip });
    const cmp = await browser.newPage({ viewport: { width: 320, height: 200 } });
    const b64 = (b) => 'data:image/png;base64,' + b.toString('base64');
    await cmp.setContent(`<html><body style="margin:0;background:#101010;font:600 15px -apple-system,Segoe UI,Roboto,sans-serif;color:#eee">
      <div style="display:flex;gap:24px;padding:20px">
        <figure style="margin:0"><img src="${b64(before)}" style="width:${clip.width * 3}px;image-rendering:pixelated;display:block">
          <figcaption style="margin-top:10px">Before — 300 px thumb (v2.2.3)</figcaption></figure>
        <figure style="margin:0"><img src="${b64(after)}" style="width:${clip.width * 3}px;image-rendering:pixelated;display:block">
          <figcaption style="margin-top:10px">After — 2000 px hero (Artwork quality: High)</figcaption></figure>
      </div>
      <div style="padding:0 20px;color:#8e8e93;font-weight:400;font-size:12.5px">Album page header at 1365×611 (DPR 1), top-left quarter of the 270 px cover, magnified 3× with no smoothing.</div>
      </body></html>`);
    const size = await cmp.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await cmp.setViewportSize({ width: size.w, height: size.h + 16 });
    await cmp.screenshot({ path: `${OUT}artwork-before-after-1365x611.png` });
  } finally {
    await browser.close();
  }
} finally {
  server.stop();
}
console.log('screenshots in', OUT);
