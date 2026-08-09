/* Album and artist tiles, the grid, and the Home view. */

import type { Album, Artist } from '../types';
import { S, haveCover, libraryTracks } from '../state';
import { solid, artHTML } from './icons';
import { esc, plural } from '../util';
import { emptyNote } from './render';

export function albumTile(al: Album): string {
  const ed = al.edition ? ' <span class="ed">' + esc(al.edition) + '</span>' : '';
  return (
    '<div class="tile" data-nav="album:' + esc(al.key) + '" tabindex="0" role="button" aria-label="Open the album ' + esc(al.album) + '">' +
    '<div class="cover">' + artHTML(al.key, 'note') +
    '<button class="playbtn" type="button" data-playalbum="' + esc(al.key) + '" aria-label="Play the album ' + esc(al.album) + '">' + solid('play') + '</button>' +
    '</div>' +
    '<div class="t1 trunc">' + esc(al.album) + ed + '</div>' +
    '<div class="t2 trunc">' + esc(al.artist) + '</div>' +
    '</div>'
  );
}

export function artistTile(ar: Artist): string {
  let cover = ar.albums.length ? ar.albums[0].key : '';
  for (let i = 0; i < ar.albums.length; i++) {
    if (haveCover(ar.albums[i].key)) {
      cover = ar.albums[i].key;
      break;
    }
  }
  return (
    '<div class="tile round" data-nav="artist:' + esc(ar.key) + '" tabindex="0" role="button" aria-label="Open the artist ' + esc(ar.name) + '">' +
    '<div class="cover">' + artHTML(cover, 'artists') +
    '<button class="playbtn" type="button" data-playartist="' + esc(ar.key) + '" aria-label="Play everything by ' + esc(ar.name) + '">' + solid('play') + '</button>' +
    '</div>' +
    '<div class="t1 trunc">' + esc(ar.name) + '</div>' +
    '<div class="t2 trunc">' + plural(ar.tracks.length, 'song', 'songs') + '</div>' +
    '</div>'
  );
}

export function grid<T>(items: T[], fn: (item: T) => string): string {
  return '<div class="grid">' + items.map(fn).join('') + '</div>';
}

export function viewHome(): string {
  if (!S.tracks.length) return emptyNote('Your library is empty', 'Pick a folder that contains your album folders to fill it.');
  const recent = S.albums
    .slice()
    .sort((a, b) => b.added - a.added)
    .slice(0, 12);
  let h =
    '<div class="section-head"><h2>Recently added</h2><span class="sub">' +
    plural(libraryTracks().length, 'song', 'songs') + ' in ' + plural(S.albums.length, 'album', 'albums') +
    '</span></div>';
  h += grid(recent, albumTile);
  if (S.artists.length) {
    h += '<div class="section-head" style="margin-top:26px"><h2>Artists</h2></div>';
    h += grid(S.artists, artistTile);
  }
  return h;
}
