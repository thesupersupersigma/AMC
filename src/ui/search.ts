/* The search view and the search box wiring. */

import { S, libraryTracks } from '../state';
import { norm, plural, $ } from '../util';
import { emptyNote, render, viewBase } from './render';
import { grid, albumTile, artistTile } from './albums';
import { songTable, matches, clearSelection } from './songs';

/* ---------- search operators (Phase 6) ----------
   `artist:jackson year:1982 album:thriller fmt:flac` alongside free text.
   One regex pulls the key:value pairs (quotes allowed around values); the
   rest stays free text against the usual title/artist/album match. Every
   predicate ANDs over the in-memory index. */

const OP_RE = /\b(artist|album|title|genre|fmt|year):("[^"]*"|\S+)/gi;

type Pred = (t: ReturnType<typeof libraryTracks>[number]) => boolean;

function parseQuery(raw: string): { free: string; preds: Pred[]; opCount: number } {
  const preds: Pred[] = [];
  let opCount = 0;
  const free = raw
    .replace(OP_RE, (_m, key: string, rawVal: string) => {
      const val = norm(rawVal.replace(/^"|"$/g, ''));
      if (!val) return '';
      opCount++;
      const k = key.toLowerCase();
      if (k === 'artist') preds.push((t) => norm(t.artist).indexOf(val) >= 0 || norm(t.albumArtist).indexOf(val) >= 0);
      else if (k === 'album') preds.push((t) => norm(t.album).indexOf(val) >= 0);
      else if (k === 'title') preds.push((t) => norm(t.title).indexOf(val) >= 0);
      else if (k === 'genre') preds.push((t) => norm(t.genre).indexOf(val) >= 0);
      else if (k === 'fmt') preds.push((t) => norm(t.fmt) === val);
      else if (k === 'year') {
        const range = val.match(/^(\d{4})-(\d{4})$/);
        if (range) {
          const lo = parseInt(range[1], 10);
          const hi = parseInt(range[2], 10);
          preds.push((t) => t.year >= lo && t.year <= hi);
        } else {
          const y = parseInt(val, 10);
          preds.push((t) => t.year === y);
        }
      }
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { free: free, preds: preds, opCount: opCount };
}

export function viewSearch(): string {
  const rawQ = S.q.trim();
  if (!rawQ)
    return emptyNote(
      'Search your library',
      'Start typing to filter by song, artist or album. Operators narrow it down: artist:jackson year:1982 album:thriller fmt:flac — free text mixes in.'
    );
  const { free, preds, opCount } = parseQuery(rawQ);
  const q = norm(free);
  const songs = libraryTracks().filter((t) => preds.every((p) => p(t)) && (!q || matches(t, q)));
  let albums;
  let artists;
  if (opCount) {
    /* With operators, the album and artist sections derive from the songs
       that matched — the predicates are per-track facts. */
    const keys = new Set(songs.map((t) => t.coverKey));
    albums = S.albums.filter((a) => keys.has(a.key));
    const names = new Set(songs.map((t) => norm(t.albumArtist || t.artist)));
    artists = S.artists.filter((a) => names.has(norm(a.name)));
  } else {
    albums = S.albums.filter((a) => norm(a.album).indexOf(q) >= 0 || norm(a.artist).indexOf(q) >= 0);
    artists = S.artists.filter((a) => norm(a.name).indexOf(q) >= 0);
  }
  if (!songs.length && !albums.length && !artists.length) {
    return emptyNote('Nothing matched "' + S.q + '"', 'Try part of a song, artist or album name, or clear the box to see everything again.');
  }
  let h = '';
  if (albums.length) {
    h += '<div class="section-head"><h2>Albums</h2></div>' + grid(albums, albumTile);
  }
  if (artists.length) {
    h += '<div class="section-head" style="margin-top:22px"><h2>Artists</h2></div>' + grid(artists, artistTile);
  }
  if (songs.length) {
    h += '<div class="section-head" style="margin-top:22px"><h2>Songs</h2><span class="sub">' + plural(songs.length, 'match', 'matches') + '</span></div>';
    h += songTable(songs, { context: 'search' });
  }
  return h;
}

export function wireSearch(): void {
  const q = $<HTMLInputElement>('#q');
  q.addEventListener('input', () => {
    S.q = q.value;
    if (S.q && viewBase() !== 'search') {
      S.prevView = S.view;
      S.view = 'search';
    } else if (!S.q && viewBase() === 'search') {
      S.view = S.prevView || 'albums';
    }
    clearSelection();
    render();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      q.value = '';
      S.q = '';
      S.view = S.prevView || 'albums';
      q.blur();
      render();
    }
  });
}
