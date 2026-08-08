/* Sidebar: nav items, the playlist rail with inline new/rename/delete, and
   the drop targets (songs onto playlists, .m3u files onto the sidebar). */

import { S } from '../state';
import { icon } from './icons';
import { esc, toast, $ } from '../util';
import { logErr } from './log';
import { navTo, render, viewArg, viewBase, getDrag, clearDrag, clearDropMarks } from './render';
import { plEdit, createPlaylist, deletePlaylist, playlistById, playlistMosaicHTML, savePlaylist, addEntriesToPlaylist, importM3U } from './playlists';
import { openPlaylistMenu } from './menu';

const NAV = [
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'albums', label: 'Albums', icon: 'albums' },
  { id: 'artists', label: 'Artists', icon: 'artists' },
  { id: 'songs', label: 'Songs', icon: 'songs' },
];

export function renderNav(): void {
  const base = viewBase();
  let active = base;
  if (base === 'album') active = 'albums';
  if (base === 'artist') active = 'artists';
  let h = '';
  for (let i = 0; i < NAV.length; i++) {
    const n = NAV[i];
    h +=
      '<button class="navitem' + (active === n.id ? ' active' : '') + '" type="button" data-nav="' + n.id + '">' +
      icon(n.icon) + '<span>' + n.label + '</span></button>';
  }
  $('#nav').innerHTML = h;
}

export function renderPlaylistNav(): void {
  const box = $('#plList');
  const cur = viewBase() === 'playlist' ? viewArg() : '';
  let h = '<button class="pl-new" type="button" id="plNew">' + icon('plus') + '<span>New Playlist</span></button>';
  if (plEdit.newOpen) {
    h += '<div style="padding:4px 6px 6px"><input class="inline-input" id="plNewInput" type="text" placeholder="Playlist name" aria-label="Name the new playlist" maxlength="120"></div>';
  }
  for (let i = 0; i < S.playlists.length; i++) {
    const pl = S.playlists[i];
    if (plEdit.renamingId === pl.id) {
      h += '<div style="padding:4px 6px 6px"><input class="inline-input" data-rename="' + esc(pl.id) + '" type="text" value="' + esc(pl.name) + '" aria-label="Rename this playlist" maxlength="120"></div>';
      continue;
    }
    if (plEdit.confirmDeleteId === pl.id) {
      h +=
        '<div class="pl-item" style="gap:6px">' +
        '<span class="nm" style="color:var(--text-dim)">Delete this playlist?</span>' +
        '<button class="link" type="button" data-del-yes="' + esc(pl.id) + '" style="color:#ff6b6b;font-size:11.5px">Delete</button>' +
        '<button class="link" type="button" data-del-no="1" style="color:var(--text-dim);font-size:11.5px">Keep</button>' +
        '</div>';
      continue;
    }
    h +=
      '<div class="pl-item' + (cur === pl.id ? ' active' : '') + '" data-plrow="' + esc(pl.id) + '">' +
      '<button type="button" class="thumb22" data-nav="playlist:' + esc(pl.id) + '" aria-label="Open the playlist ' + esc(pl.name) + '" style="padding:0">' + playlistMosaicHTML(pl) + '</button>' +
      '<button type="button" class="nm trunc" data-nav="playlist:' + esc(pl.id) + '">' + esc(pl.name) + '</button>' +
      '<button type="button" class="kebab" data-plmenu="' + esc(pl.id) + '" aria-label="Open actions for ' + esc(pl.name) + '">' + icon('more') + '</button>' +
      '</div>';
  }
  if (!S.playlists.length && !plEdit.newOpen) {
    h += '<div style="padding:6px 10px;color:#6d6d72;font-size:11.5px;line-height:1.45">Make a playlist, then drag songs onto it.</div>';
  }
  box.innerHTML = h;
  const inp = document.getElementById('plNewInput') as HTMLInputElement | null;
  if (inp) inp.focus();
  const ren = box.querySelector<HTMLInputElement>('[data-rename]');
  if (ren) {
    ren.focus();
    ren.select();
  }
}

export function wireSidebar(): void {
  $('#nav').addEventListener('click', (e) => {
    const el = (e.target as Element).closest('[data-nav]');
    if (!el) return;
    const v = el.getAttribute('data-nav') || 'albums';
    if (v === 'search') {
      navTo('search');
      $('#q').focus();
      return;
    }
    navTo(v);
  });

  $('#plList').addEventListener('click', (e) => {
    let el: Element | null;
    if ((e.target as Element).closest('#plNew')) {
      plEdit.newOpen = true;
      plEdit.renamingId = '';
      plEdit.confirmDeleteId = '';
      renderPlaylistNav();
      return;
    }
    if ((el = (e.target as Element).closest('[data-plmenu]'))) {
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      openPlaylistMenu(r.left - 150, r.bottom + 4, el.getAttribute('data-plmenu') || '');
      return;
    }
    if ((el = (e.target as Element).closest('[data-del-yes]'))) {
      const id = el.getAttribute('data-del-yes') || '';
      plEdit.confirmDeleteId = '';
      void deletePlaylist(id).then(render);
      return;
    }
    if ((e.target as Element).closest('[data-del-no]')) {
      plEdit.confirmDeleteId = '';
      renderPlaylistNav();
      return;
    }
    if ((el = (e.target as Element).closest('[data-nav]'))) {
      navTo(el.getAttribute('data-nav') || 'albums');
      return;
    }
  });

  $('#plList').addEventListener('keydown', (e) => {
    const inp = e.target as HTMLInputElement;
    if (inp.id === 'plNewInput') {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = inp.value.trim();
        plEdit.newOpen = false;
        if (!name) {
          renderPlaylistNav();
          return;
        }
        void createPlaylist(name, []).then((pl) => {
          navTo('playlist:' + pl.id);
          toast('Created ' + pl.name);
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        plEdit.newOpen = false;
        renderPlaylistNav();
      }
      return;
    }
    const rid = inp.getAttribute && inp.getAttribute('data-rename');
    if (rid) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const pl = playlistById(rid);
        const v = inp.value.trim();
        plEdit.renamingId = '';
        if (pl && v) {
          pl.name = v.slice(0, 120);
          void savePlaylist(pl).then(render);
        } else render();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        plEdit.renamingId = '';
        renderPlaylistNav();
      }
    }
  });

  $('#plList').addEventListener('focusout', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'plNewInput') {
      plEdit.newOpen = false;
      setTimeout(renderPlaylistNav, 120);
    } else if (t.getAttribute && t.getAttribute('data-rename')) {
      plEdit.renamingId = '';
      setTimeout(renderPlaylistNav, 120);
    }
  });

  /* drop songs onto a playlist in the sidebar, and .m3u8 files onto the sidebar */
  const sb = $('#sidebar');
  sb.addEventListener('dragover', (e) => {
    const isFile = !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    if (!getDrag() && !isFile) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    const item = (e.target as Element).closest('.pl-item');
    clearDropMarks();
    if (item && getDrag()) item.classList.add('dropping');
    else if (isFile) sb.classList.add('dropping');
  });
  sb.addEventListener('dragleave', (e) => {
    if (e.target === sb) clearDropMarks();
  });
  sb.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    const item = (e.target as Element).closest('.pl-item');
    const drag = getDrag();
    if (drag && item) {
      e.preventDefault();
      clearDropMarks();
      void addEntriesToPlaylist(item.getAttribute('data-plrow') || '', drag.entries);
      clearDrag();
      return;
    }
    if (files && files.length) {
      e.preventDefault();
      clearDropMarks();
      const f = files[0];
      if (!/\.m3u8?$/i.test(f.name)) {
        toast('Drop an .m3u or .m3u8 file to import a playlist');
        return;
      }
      f.text()
        .then((txt) => {
          importM3U(txt, f.name);
        })
        .catch((err: Error) => {
          logErr('playlists', 'Could not read ' + f.name, err && err.message);
        });
    }
  });

  document.addEventListener('dragend', () => {
    clearDrag();
    clearDropMarks();
  });
}
