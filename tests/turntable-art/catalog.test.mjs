/* Catalog artwork: size per level, the Max step-down on an oversized proxy
   response, sidecar artwork/ storage on a writable (OPFS-backed FSA)
   folder, the IndexedDB fallback on the read-only webkitdirectory folder,
   the paced re-download queue, the lazy upgrade, and Settings › Artwork.
   /api/itunes and /api/itunes/art are stubbed locally — the real proxy is
   never called. */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launch, loadLibrary, albumKeys, makeChecker } from './harness.mjs';

const FIX = process.env.FIXTURES || '/tmp/claude-0/fx/TTLib';
const CAT = join(FIX, '..', 'catalog');

export async function run({ server, check }) {
  const { browser, page, errors } = await launch({ width: 1365, height: 611 });
  const artHits = [];
  const stub = { tooLarge: 'none' };
  await page.route('**/api/itunes/art/**', async (route) => {
    const u = route.request().url();
    const m = u.match(/\/(\d+)x\1bb\.jpg$/);
    const px = m ? Number(m[1]) : 0;
    artHits.push({ px, t: Date.now(), u });
    if (px === 3000 && stub.tooLarge === '502') return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'The upstream response was too large' }) });
    if (px === 3000 && stub.tooLarge === '413') return route.fulfill({ status: 413, contentType: 'text/plain', body: 'FUNCTION_PAYLOAD_TOO_LARGE' });
    const f = join(CAT, `art-${px}.jpg`);
    if (!existsSync(f)) return route.fulfill({ status: 404, body: 'no' });
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(f) });
  });
  await page.route('**/api/itunes/lookup**', (route) => {
    const id = Number(new URL(route.request().url()).searchParams.get('id'));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ resultCount: 1, results: [{ wrapperType: 'collection', collectionId: id, collectionName: 'Stub', artistName: 'Stub', artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/v4/00/11/${id}/stub.jpg/100x100bb.jpg` }] }),
    });
  });
  await page.route('**/api/itunes/search**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"resultCount":0,"results":[]}' }));
  await page.route('**/__fx/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__fx\//, ''));
    return route.fulfill({ status: 200, body: readFileSync(join(FIX, '..', rel)) });
  });

  try {
    await loadLibrary(page, server.url, FIX, 11);

    /* A writable folder: OPFS behind the real FSA backend. */
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle('OpfsLib', { create: true });
      const g = await (await lib.getDirectoryHandle('Gamma Group', { create: true })).getDirectoryHandle('Gamma OPFS (2010)', { create: true });
      /* Renamed: an identical name + size + duration would dedupe into
         the read-only library's copy. */
      for (const n of ['01 - Gamma Tune 1.m4a', '02 - Gamma Tune 2.m4a']) {
        const buf = await (await fetch('/__fx/TTLib/Gamma Group/Gamma (2010)/' + encodeURIComponent(n))).arrayBuffer();
        const fh = await g.getFileHandle(n.replace('Tune', 'OPFS Tune'), { create: true });
        const w = await fh.createWritable();
        await w.write(buf);
        await w.close();
      }
      const folders = await window.__mod('/src/fs/folders.ts');
      await folders.addFsaFolder(lib);
    });
    await page.waitForFunction(() => window.__st.S.albums.length >= 5 && !window.__st.S.scanning, null, { timeout: 30000 });
    const keys = await page.evaluate(() => {
      const out = {};
      for (const al of window.__st.S.albums) out[al.key.indexOf('gamma opfs') >= 0 ? 'GammaOPFS' : al.album] = al.key;
      return out;
    });
    check('OPFS-backed writable folder connected', !!keys.GammaOPFS, keys);

    const URL100 = 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/00/11/111/gamma.jpg/100x100bb.jpg';
    const urls = await page.evaluate(async (u) => {
      const c = await window.__mod('/src/net/catalog.ts');
      return [600, 1200, 2000, 3000].map((px) => c.artworkProxyUrl(u, px));
    }, URL100);
    check('artworkProxyUrl requests the level’s size', urls[0].endsWith('/600x600bb.jpg') && urls[1].endsWith('/1200x1200bb.jpg') && urls[2].endsWith('/2000x2000bb.jpg') && urls[3].endsWith('/3000x3000bb.jpg'), urls);

    /* Catalog matches, as a review would leave them. */
    await page.evaluate(async ({ k, u }) => {
      const st = window.__st;
      const ov = await window.__mod('/src/fs/overrides.ts');
      const folders = await window.__mod('/src/fs/folders.ts');
      const gf = folders.folderById(st.S.albumMap[k.GammaOPFS].tracks[0].folderId);
      const bf = folders.folderById(st.S.albumMap[k.Beta].tracks[0].folderId);
      ov.rememberAlbumCollection(gf, k.GammaOPFS, 111);
      ov.rememberAlbumCollection(bf, k.Beta, 222);
      await gf.backend.writeSidecarText('catalog/111.json', JSON.stringify({ schemaVersion: 3, collection: { collectionId: 111, artistName: 'Gamma Group', collectionName: 'Gamma', artworkUrl100: u }, songs: [], fetchedAt: Date.now() }));
    }, { k: keys, u: URL100 });

    /* "Accept" the catalog cover at High, exactly as repair.ts applies it. */
    artHits.length = 0;
    const accepted = await page.evaluate(async ({ k, u }) => {
      const st = window.__st;
      const c = await window.__mod('/src/net/catalog.ts');
      const ov = await window.__mod('/src/fs/overrides.ts');
      const folders = await window.__mod('/src/fs/folders.ts');
      const out = {};
      for (const [key, url] of [[k.GammaOPFS, u], [k.Beta, u.replace('/111/', '/222/')]]) {
        const blob = await c.fetchArtwork(url);
        st.setCoverLocal(key, blob);
        await st.storeCover(key, blob);
        const folder = folders.folderById(st.S.albumMap[key].tracks[0].folderId);
        if (folder.capability === 'readwrite') await folder.backend.writeSidecarBlob('artwork/' + ov.artFileOf(key), blob);
        out[key] = blob.size;
      }
      return out;
    }, { k: keys, u: URL100 });
    check('High fetches 2000 px from the (stubbed) proxy', artHits.length === 2 && artHits.every((h) => h.px === 2000), artHits.map((h) => h.px));
    await page.waitForTimeout(3600); /* the accepted-cover listener checks the sidecar after 3 s */

    const stored = await page.evaluate(async (k) => {
      const hero = await window.__mod('/src/art/hero.ts');
      const is = await window.__mod('/src/art/imgsize.ts');
      const ov = await window.__mod('/src/fs/overrides.ts');
      const idb = await window.__mod('/src/db/idb.ts');
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle('OpfsLib');
      let onDisk = null;
      try {
        const f = await (await (await (await lib.getDirectoryHandle('AMC DO NOT DELETE')).getDirectoryHandle('artwork')).getFileHandle(ov.artFileOf(k.GammaOPFS))).getFile();
        onDisk = { name: f.name, size: f.size, dims: await is.imageSize(f) };
      } catch (e) {
        onDisk = String(e);
      }
      const row = await idb.idbGet(idb.ST_COVERS, 'hero||' + k.Beta);
      const g = await hero.heroFor(k.GammaOPFS);
      const b = await hero.heroFor(k.Beta);
      return { onDisk, idbRow: row ? { px: row.px, dims: await is.imageSize(row.thumb) } : null, g: [g.source, g.w], b: [b.source, b.w] };
    }, keys);
    check('writable folder: catalog hero written to the sidecar artwork/ folder', stored.onDisk && stored.onDisk.dims && stored.onDisk.dims.w === 2000, stored.onDisk);
    check('read-only folder: catalog hero kept in IndexedDB', stored.idbRow && stored.idbRow.dims.w === 2000, stored.idbRow);
    check('hero sources: sidecar and IndexedDB', stored.g[0] === 'sidecar' && stored.b[0] === 'idb' && stored.g[1] === 2000, [stored.g, stored.b]);

    /* ---- Max: 3000 px too large for the proxy → steps down ---- */
    for (const mode of ['502', '413']) {
      stub.tooLarge = mode;
      artHits.length = 0;
      const got = await page.evaluate(async (u) => {
        const st = window.__st;
        const c = await window.__mod('/src/net/catalog.ts');
        const is = await window.__mod('/src/art/imgsize.ts');
        st.S.artQuality = 'max';
        const b = await c.fetchArtwork(u);
        st.S.artQuality = 'high';
        return b ? await is.imageSize(b) : null;
      }, URL100);
      check('Max steps down 3000 → 2400 on a ' + mode + ' “too large” response', got && got.w === 2400 && artHits.map((h) => h.px).join(',') === '3000,2400', { got, hits: artHits.map((h) => h.px) });
    }
    stub.tooLarge = 'none';

    /* ---- bulk re-download at Low, paced ---- */
    artHits.length = 0;
    const t0 = Date.now();
    await page.evaluate(async () => {
      window.__st.S.artQuality = 'low';
      const ca = await window.__mod('/src/art/catalogart.ts');
      await ca.redownloadCatalogArtwork();
    });
    const gaps = artHits.slice(1).map((h, i) => h.t - artHits[i].t);
    check('re-download refetched both catalog covers at 600 px', artHits.length === 2 && artHits.every((h) => h.px === 600), artHits.map((h) => h.px));
    check('re-download is paced (≥ 3 s between requests = ≤ 20/min)', gaps.every((g) => g >= 2900), { gaps, total: Date.now() - t0 });
    const after = await page.evaluate(async (k) => {
      const hero = await window.__mod('/src/art/hero.ts');
      const is = await window.__mod('/src/art/imgsize.ts');
      const g = await hero.catalogCoverBlob(k.GammaOPFS);
      const b = await hero.catalogCoverBlob(k.Beta);
      const log = await window.__mod('/src/ui/log.ts');
      log.toggleErrPanel(true);
      const text = document.getElementById('errlist').textContent;
      log.toggleErrPanel(false);
      return { g: await is.imageSize(g.blob), b: await is.imageSize(b.blob), log: text };
    }, keys);
    check('sidecar and browser copies replaced at the new size', after.g.w === 600 && after.b.w === 600, [after.g, after.b]);
    check('progress reported in the activity log', /Re-downloading 2 catalog covers/.test(after.log) && /re-download finished/i.test(after.log), after.log.slice(-300));

    /* ---- lazy upgrade when a level above the stored size is used ---- */
    artHits.length = 0;
    const lazy = await page.evaluate(async (k) => {
      const st = window.__st;
      const hero = await window.__mod('/src/art/hero.ts');
      st.S.artQuality = 'standard';
      const first = await hero.heroFor(k.GammaOPFS);
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const h = await hero.heroFor(k.GammaOPFS);
        if (h && h.nativeW === 1200) return { first: first.nativeW, then: h.nativeW, source: h.source };
      }
      return { first: first.nativeW, then: null };
    }, keys);
    check('opening an album at a higher level upgrades its catalog cover lazily', lazy.first === 600 && lazy.then === 1200, { lazy, hits: artHits.map((h) => h.px) });
    const extra = artHits.length;
    await page.evaluate(async (k) => {
      const hero = await window.__mod('/src/art/hero.ts');
      hero.invalidateHero(k.GammaOPFS);
      await hero.heroFor(k.GammaOPFS);
    }, keys);
    await page.waitForTimeout(500);
    check('…once (no repeat request for the same level)', artHits.length === extra && extra === 1, artHits.map((h) => h.px));

    /* ---- Media Session sizes follow the playing album's hero ---- */
    await page.evaluate(async (k) => {
      const p = await window.__mod('/src/ui/player.ts');
      p.playList(window.__st.S.albumMap[k.GammaOPFS].tracks, 0);
    }, keys);
    await page.waitForFunction(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork[0] && navigator.mediaSession.metadata.artwork[0].sizes === '1200x1200', null, { timeout: 10000 }).catch(() => null);
    const ms = await page.evaluate(() => navigator.mediaSession.metadata.artwork.map((a) => a.sizes));
    check('Media Session sizes are the hero’s real size', ms[0] === '1200x1200', ms);

    /* ---- Settings › Artwork ---- */
    await page.evaluate(async () => {
      const r = await window.__mod('/src/ui/render.ts');
      r.navTo('settings');
    });
    await page.waitForFunction(() => /Covers use about/.test((document.getElementById('setArtSpace') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
    if (process.env.DEBUG_SETTINGS) {
      const renders = await page.evaluate(async () => {
        let n = 0;
        const mo = new MutationObserver(() => n++);
        mo.observe(document.getElementById('view'), { childList: true });
        await new Promise((r) => setTimeout(r, 3000));
        mo.disconnect();
        return n;
      });
      console.log('DEBUG renders in 3 s:', renders);
      const dbg = await page.evaluate(async () => {
        const ui = await window.__mod('/src/art/settings-ui.ts');
        const hero = await window.__mod('/src/art/hero.ts');
        const steps = [];
        for (const al of window.__st.S.albums) {
          const t0 = performance.now();
          const r = await Promise.race([hero.catalogCoverBlob(al.key).then((c) => (c ? c.source : 'none')), new Promise((res) => setTimeout(() => res('TIMEOUT'), 3000))]);
          steps.push([al.key, r, Math.round(performance.now() - t0)]);
        }
        const m = await Promise.race([ui.measureArtworkSpace().then(() => 'ok'), new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000))]);
        return { steps, m, box: !!document.getElementById('setArtSpace'), view: window.__st.S.view };
      });
      console.log('DEBUG', JSON.stringify(dbg));
    }
    const sect = await page.evaluate(() => ({
      space: document.getElementById('setArtSpace').textContent,
      est: Array.from(document.querySelectorAll('[data-artest]')).map((e) => e.getAttribute('data-artest') + ' ' + e.textContent),
      on: document.querySelector('[data-artq].on') && document.querySelector('[data-artq].on').getAttribute('data-artq'),
      btn: !!document.querySelector('[data-art-redownload]'),
    }));
    check('Settings shows current usage', /Covers use about .* MB now/.test(sect.space), sect.space);
    check('Settings shows an estimate for every level', sect.est.length === 4 && sect.est.every((e) => /≈ [\d.]+ MB/.test(e)), sect.est);
    check('Settings has the re-download button and the current level selected', sect.btn && sect.on === 'standard', sect.on);
    await page.click('[data-artq="max"]');
    await page.waitForTimeout(600);
    const pref = await page.evaluate(() => ({ s: window.__st.S.artQuality, ls: JSON.parse(localStorage.getItem('tsss_player_prefs') || '{}').artQuality }));
    check('choosing a level persists as a pref', pref.s === 'max' && pref.ls === 'max', pref);

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('OpfsLib', { recursive: true }).catch(() => undefined);
    }).catch(() => undefined);
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
