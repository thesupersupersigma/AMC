/* Album and artist detail views. */

import { S, albumDuration } from '../state';
import { icon, solid, artHTML } from './icons';
import { esc, fmtTotal, norm, plural } from '../util';
import { emptyNote } from './render';
import { grid, albumTile } from './albums';
import { songTable, sortTracks } from './songs';

export function viewAlbum(key: string): string {
  const al = S.albumMap[key];
  if (!al) return emptyNote('That album is no longer here', 'Pick Albums in the sidebar to see what is loaded.');
  const dur = albumDuration(al);
  const meta = [plural(al.tracks.length, 'song', 'songs'), fmtTotal(dur), al.year].filter(Boolean).join(' · ');
  const ed = al.edition ? ' <span class="ed">' + esc(al.edition) + '</span>' : '';
  let h =
    '<div class="detail">' +
    '<div class="art">' + artHTML(al.key, 'note') + '</div>' +
    '<div class="meta">' +
    '<h1>' + esc(al.album) + ed + '</h1>' +
    '<button class="by" type="button" data-nav="artist:' + esc(norm(al.artist)) + '">' + esc(al.artist) + '</button>' +
    '<div class="dim">' + esc(meta) + '</div>' +
    '<div class="actions">' +
    '<button class="pill-play" type="button" data-playalbum="' + esc(al.key) + '">' + solid('play') + 'Play</button>' +
    '<button class="pill-ghost" type="button" data-shufflealbum="' + esc(al.key) + '">' + icon('shuffle') + 'Shuffle</button>' +
    '<button class="pill-ghost" type="button" data-catalog="' + esc(al.key) + '" title="Match this album against the iTunes catalog and review corrections">' + icon('search') + 'Match catalog</button>' +
    '</div>' +
    '</div>' +
    '</div>';
  h += songTable(al.tracks, { context: 'album' });
  return h;
}

export function viewArtist(key: string): string {
  const ar = S.artistMap[key];
  if (!ar) return emptyNote('That artist is no longer here', 'Pick Artists in the sidebar to see what is loaded.');
  let h =
    '<div class="section-head"><h2>' + esc(ar.name) + '</h2><span class="sub">' +
    plural(ar.albums.length, 'album', 'albums') + ' · ' + plural(ar.tracks.length, 'song', 'songs') +
    '</span></div>';
  h += grid(ar.albums, albumTile);
  h += '<div class="section-head" style="margin-top:26px"><h2>Songs</h2></div>';
  h += songTable(sortTracks(ar.tracks, 'album', 1), { context: 'artist' });
  return h;
}
