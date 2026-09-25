/* Artwork tiers: hero natural size per quality level, original bytes
   reused when no downscale is needed, display-sized thumbs, lazy thumb
   migration, hero sites (album header, Now Playing, Media Session). */

import { startServer, launch, loadLibrary, albumKeys, makeChecker } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';

export async function run({ server, check }) {
  const { browser, page, errors } = await launch({ width: 1365, height: 611 });
  try {
    await loadLibrary(page, server.url, FIX, 11);
    const keys = await albumKeys(page);
    check('four albums scanned (cue side carved into 3)', Object.keys(keys).length === 4, Object.keys(keys));

    /* ---- hero size per level ---- */
    const sizes = await page.evaluate(async (k) => {
      const st = await import('/src/state.ts');
      const hero = await import('/src/art/hero.ts');
      const out = {};
      for (const q of ['low', 'standard', 'high', 'max']) {
        st.S.artQuality = q;
        const a = await hero.heroFor(k.Alpha);
        const b = await hero.heroFor(k.Beta);
        const g = await hero.heroFor(k.Gamma);
        const nat = await new Promise((res) => {
          const im = new Image();
          im.onload = () => res([im.naturalWidth, im.naturalHeight]);
          im.onerror = () => res(null);
          im.src = a.url;
        });
        out[q] = { alpha: [a.w, a.h, a.original, a.source], alphaNatural: nat, beta: [b.w, b.h, b.original], gamma: g };
      }
      st.S.artQuality = 'high';
      return out;
    }, keys);
    check('Low: 3000 px embedded → 600 px hero', sizes.low.alphaNatural[0] === 600 && !sizes.low.alpha[2], sizes.low);
    check('Standard: → 1200 px hero', sizes.standard.alphaNatural[0] === 1200, sizes.standard.alphaNatural);
    check('High (default): → 2000 px hero', sizes.high.alphaNatural[0] === 2000, sizes.high.alphaNatural);
    check('Max: original 3000 px, bytes untouched', sizes.max.alphaNatural[0] === 3000 && sizes.max.alpha[2] === true, sizes.max.alpha);
    check('400 px embedded art is used as-is at every level', ['low', 'standard', 'high', 'max'].every((q) => sizes[q].beta[0] === 400 && sizes[q].beta[2] === true), sizes.high.beta);
    check('album without art has no hero', sizes.high.gamma === null);

    /* ---- original bytes reused (byte-identical to the embedded picture) ---- */
    const same = await page.evaluate(async (k) => {
      const st = await import('/src/state.ts');
      const hero = await import('/src/art/hero.ts');
      const sc = await import('/src/scan/scanner.ts');
      const b = await hero.heroFor(k.Beta);
      const t = st.S.albumMap[k.Beta].tracks[0];
      const emb = await sc.extractArt(t.file);
      const x = new Uint8Array(await b.blob.arrayBuffer());
      const y = new Uint8Array(await emb.arrayBuffer());
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return x.length;
    }, keys);
    check('hero bytes === embedded picture bytes when no downscale is needed', !!same, same);

    /* ---- thumb sized to the display ---- */
    const thumbs = await page.evaluate(async (k) => {
      const st = await import('/src/state.ts');
      const ts = await import('/src/art/thumbsize.ts');
      const is = await import('/src/art/imgsize.ts');
      const a = await is.imageSize(st.coverBlob(k.Alpha));
      const d = await is.imageSize(st.coverBlob(k['Delta Side A']));
      const tiles = Array.from(document.querySelectorAll('.tile .cover')).map((e) => e.clientWidth);
      return { target: ts.thumbTargetPx(), alpha: a, delta: d, tile: Math.max(0, ...tiles), dpr: devicePixelRatio, type: st.coverBlob(k.Alpha).type };
    }, keys);
    check('thumb target measured from the grid tile × DPR, clamped to 320–400', thumbs.target >= 320 && thumbs.target <= 400, thumbs);
    check('stored thumb is display-sized WebP', thumbs.alpha && thumbs.alpha.w === thumbs.target && thumbs.type === 'image/webp', thumbs.alpha);

    /* ---- migration: a legacy 300 px thumb is rebuilt when its source is read ---- */
    const mig = await page.evaluate(async (k) => {
      const st = await import('/src/state.ts');
      const hero = await import('/src/art/hero.ts');
      const is = await import('/src/art/imgsize.ts');
      const rs = await import('/src/art/resize.ts');
      const legacy = await rs.downscaleBlob(st.coverBlob(k['Delta Side A']), 300, 'image/webp', 0.82);
      st.setCoverLocal(k['Delta Side A'], legacy.blob);
      hero.invalidateHero(k['Delta Side A']);
      const before = await is.imageSize(st.coverBlob(k['Delta Side A']));
      await hero.heroFor(k['Delta Side A']);
      for (let i = 0; i < 50; i++) {
        const s = await is.imageSize(st.coverBlob(k['Delta Side A']));
        if (s && s.w > 300) return { before, after: s };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { before, after: await is.imageSize(st.coverBlob(k['Delta Side A'])) };
    }, keys);
    check('legacy 300 px thumb regenerated at display size on next source read', mig.before.w === 300 && mig.after.w === thumbs.target, mig);

    /* ---- hero sites ---- */
    await page.evaluate(async (k) => {
      const r = await import('/src/ui/render.ts');
      r.navTo('album:' + k.Alpha);
    }, keys);
    await page.waitForFunction(() => {
      const im = document.querySelector('.detail .art img');
      return im && im.complete && im.naturalWidth >= 2000;
    }, null, { timeout: 15000 }).catch(() => null);
    const header = await page.evaluate(() => {
      const im = document.querySelector('.detail .art img');
      return im ? [im.naturalWidth, im.clientWidth] : null;
    });
    check('album page header shows the hero (2000 px at High)', header && header[0] === 2000, header);

    await page.evaluate(async (k) => {
      const st = await import('/src/state.ts');
      const p = await import('/src/ui/player.ts');
      p.playList(st.S.albumMap[k.Alpha].tracks, 0);
    }, keys);
    await page.waitForFunction(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork.length && navigator.mediaSession.metadata.artwork[0].sizes === '2000x2000', null, { timeout: 15000 }).catch(() => null);
    const ms = await page.evaluate(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork.map((a) => ({ sizes: a.sizes, type: a.type })));
    check('Media Session declares the hero’s real size', ms && ms[0] && ms[0].sizes === '2000x2000', ms);

    await page.evaluate(async () => {
      const np = await import('/src/ui/nowplaying.ts');
      np.openNowPlaying();
    });
    await page.waitForFunction(() => {
      const im = document.getElementById('npArt');
      return im && im.complete && im.naturalWidth >= 2000;
    }, null, { timeout: 15000 }).catch(() => null);
    const npw = await page.evaluate(() => document.getElementById('npArt') && document.getElementById('npArt').naturalWidth);
    check('Now Playing shows the hero', npw === 2000, npw);

    const held = await page.evaluate(async () => {
      const hero = await import('/src/art/hero.ts');
      return hero.heldHeroKeys();
    });
    check('at most two heroes held (playing + open page)', held.length <= 2, held);

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  const { check, failed } = makeChecker();
  try {
    await run({ server, check });
  } finally {
    server.stop();
  }
  if (failed().length) process.exit(1);
}
