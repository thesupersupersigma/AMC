/* The search view and the search box wiring. */

import { S, libraryTracks } from '../state';
import { norm, plural, $ } from '../util';
import { emptyNote, render, viewBase } from './render';
import { grid, albumTile, artistTile } from './albums';
import { songTable, matches, clearSelection } from './songs';

export function viewSearch(): string {
  const q = norm(S.q);
  if (!q) return emptyNote('Search your library', 'Start typing to filter by song, artist or album. Results update as you type.');
  const songs = libraryTracks().filter((t) => matches(t, q));
  const albums = S.albums.filter((a) => norm(a.album).indexOf(q) >= 0 || norm(a.artist).indexOf(q) >= 0);
  const artists = S.artists.filter((a) => norm(a.name).indexOf(q) >= 0);
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
