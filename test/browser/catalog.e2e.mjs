/* Catalog matching against the live iTunes Search API (through the dev
   server's /api/itunes proxy), for albums the plain search ranks out of
   sight: "Michael Jackson Dangerous" returns 25 compilations, singles and
   remixes and not Dangerous, so the match falls back to the artist's own
   album list. Bad is the control the plain search always found.

     npm run dev
     AMC_URL=http://localhost:5173 node --test test/browser/catalog.e2e.mjs

   Needs ffmpeg and the network; AMC_NO_NET=1 skips it. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from '../helpers/release-library.mjs';

const BASE = process.env.AMC_URL || 'http://localhost:5173';
const FFMPEG = findFfmpeg();
const skip = (!FFMPEG && 'needs ffmpeg') || (process.env.AMC_NO_NET && 'AMC_NO_NET');
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

let browser;
let page;
let tmp;

function album(dir, artist, name, year, titles) {
  const d = join(dir, artist, name);
  mkdirSync(d, { recursive: true });
  titles.forEach((title, i) => {
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'flac',
      '-metadata', 'title=' + title, '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist, '-metadata', 'album=' + name,
      '-metadata', 'date=' + year, '-metadata', 'track=' + (i + 1), join(d, String(i + 1).padStart(2, '0') + '.flac'),
    ]);
  });
}

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'amc-catalog-'));
  const music = join(tmp, 'Music');
  album(music, 'Michael Jackson', 'Dangerous', 1991, ['Jam', 'Why You Wanna Trip on Me', 'In the Closet', 'She Drives Me Wild', 'Remember the Time', "Can't Let Her Get Away", 'Heal the World', 'Black or White', 'Who Is It', 'Give In to Me', 'Will You Be There', 'Keep the Faith', 'Gone Too Soon', 'Dangerous']);
  album(music, 'Michael Jackson', 'Bad', 1987, ['Bad', 'The Way You Make Me Feel', 'Speed Demon', 'Liberian Girl', 'Just Good Friends', 'Another Part of Me', 'Man in the Mirror', 'I Just Can’t Stop Loving You', 'Dirty Diana', 'Smooth Criminal', 'Leave Me Alone']);
  browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 611 } });
  /* __mod(path): the module instance the app itself loaded (a dev server
     that saw edits serves HMR-stamped URLs) */
  await context.addInitScript(() => {
    window.__mod = (p) => {
      const hit = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === p;
          } catch {
            return false;
          }
        });
      return import(hit.length ? hit[hit.length - 1] : p);
    };
  });
  page = await context.newPage();
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__amcDebug);
  await page.setInputFiles('#picker', music);
  await page.waitForFunction(() => window.__amcDebug.S.tracks.length >= 25 && !window.__amcDebug.S.scanning, null, { timeout: 60000 });
});

after(async () => {
  if (browser) await browser.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function match(albumName) {
  return page.evaluate(async (name) => {
    const { fetchCatalogFor } = await window.__mod('/src/net/catalog.ts');
    const { folderById } = await window.__mod('/src/fs/folders.ts');
    const S = window.__amcDebug.S;

    const al = S.albums.find((a) => a.album === name);
    const m = await fetchCatalogFor(folderById(al.tracks[0].folderId), al);
    return m && { name: m.collection.collectionName, artist: m.collection.artistName, year: (m.collection.releaseDate || '').slice(0, 4), songs: m.songs.length, art: !!m.collection.artworkUrl100 };
  }, albumName);
}

test('Dangerous: the plain search misses it, the artist’s album list has it', { skip, timeout: 90000 }, async () => {
  const m = await match('Dangerous');
  console.log('# Dangerous: ' + JSON.stringify(m));
  assert.ok(m, 'a match');
  assert.equal(m.name, 'Dangerous');
  assert.equal(m.artist, 'Michael Jackson');
  assert.equal(m.year, '1991');
  assert.ok(m.art, 'with artwork');
});

test('Bad: still matched by the plain search', { skip, timeout: 90000 }, async () => {
  const m = await match('Bad');
  console.log('# Bad: ' + JSON.stringify(m));
  assert.ok(m, 'a match');
  assert.equal(m.artist, 'Michael Jackson');
  assert.equal(m.year, '1987');
  assert.match(m.name, /^Bad\b/);
});
