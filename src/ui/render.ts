/* The render coordinator: which view is on screen, the #view event
   delegation, and the drag state shared with the sidebar drop targets. */

import { S, libraryTracks, savePrefs } from '../state';
import { esc, plural, toast, $, $$ } from '../util';
import { icon } from './icons';
import { renderNav, renderPlaylistNav } from './sidebar';
import { viewHome, grid, albumTile, artistTile } from './albums';
import { viewAlbum, viewArtist } from './album';
import { viewSearch } from './search';
import { viewPlaylist, movePlaylistRow, playlistById, playlistTracks, exportM3U, exportPlaylistFiles, savePlaylist } from './playlists';
import { songTable, sortTracks, clearSelection, setSelectionUI, handleRowSelect, actionEntries, setLastSelIndex } from './songs';
import type { PlaylistEntry } from '../types';
import { playList, toggleShuffle, syncPlayerUI } from './player';
import { openCatalogReview } from './repair';
import { fillStorageInfo, viewSettings } from './settings';
import { closeMenu, openRowMenu } from './menu';
import { isMissingTrack } from '../state';
import type { SortCol } from '../types';

let renderQueued = false;
export function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

export function viewBase(): string {
  return String(S.view).split(':')[0];
}
export function viewArg(): string {
  const i = String(S.view).indexOf(':');
  return i < 0 ? '' : String(S.view).slice(i + 1);
}

export function navTo(v: string): void {
  S.view = v;
  clearSelection();
  clearAlbumSelection();
  closeMenu();
  savePrefs();
  render();
}

/* ---------- album multi-select (Phase 6 album shuffle) ----------
   Ctrl/Cmd-click gathers albums; the floating bar pools EVERY track from
   the selection and shuffles across the whole pool — album boundaries
   disappear entirely, never album-at-a-time. */

const selAlbums = new Set<string>();

function syncAlbumSelBar(): void {
  const bar = $('#albumselbar');
  if (!bar) return;
  if (!selAlbums.size) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = $('#albumselText');
  if (label) label.textContent = plural(selAlbums.size, 'album selected', 'albums selected');
}

export function clearAlbumSelection(): void {
  if (!selAlbums.size) return;
  selAlbums.clear();
  $$('.tile.selected').forEach((t) => t.classList.remove('selected'));
  syncAlbumSelBar();
}

function shufflePool(pool: ReturnType<typeof libraryTracks>): void {
  const playable = pool.filter((t) => !!t.file);
  if (!playable.length) {
    toast('Nothing playable in that selection');
    return;
  }
  if (!S.shuffle) toggleShuffle();
  playList(playable, Math.floor(Math.random() * playable.length));
}

export function render(): void {
  if (!S.hasFolder) return;
  renderNav();
  renderPlaylistNav();
  renderMain();
  syncPlayerUI();
}

/** The sidebar playlist rail alone — used by rename/delete flows that must
    not repaint the main view mid-interaction. */
export function renderPlaylistNavOnly(): void {
  renderPlaylistNav();
}

export function emptyNote(title: string, body: string): string {
  return '<div class="empty-note"><b>' + esc(title) + '</b>' + esc(body) + '</div>';
}

let lastRenderedView = '';

function renderMain(): void {
  const box = $('#view');
  const base = viewBase(),
    arg = viewArg();
  let crumb = 'Albums';
  let h = '';

  if (base === 'home') {
    crumb = 'Home';
    h = viewHome();
  } else if (base === 'albums') {
    crumb = 'Albums';
    h = S.albums.length
      ? '<div class="section-head"><h2>Albums</h2><span class="sub">' +
        plural(S.albums.length, 'album', 'albums') +
        ' · Ctrl-click to select several</span><button type="button" class="pill-ghost set-small" data-shuffleall>' + icon('shuffle') + 'Shuffle all</button></div>' +
        grid(S.albums, albumTile)
      : emptyNote('No albums yet', 'Songs appear here as soon as the scan reaches them.');
  } else if (base === 'artists') {
    crumb = 'Artists';
    h = S.artists.length ? grid(S.artists, artistTile) : emptyNote('No artists yet', 'Songs appear here as soon as the scan reaches them.');
  } else if (base === 'songs') {
    crumb = 'Songs';
    h = S.tracks.length
      ? songTable(sortTracks(libraryTracks(), S.sort.col, S.sort.dir), { context: 'songs', sortable: true })
      : emptyNote('No songs yet', 'Pick a folder that contains your album folders.');
  } else if (base === 'album') {
    crumb = 'Albums';
    h = viewAlbum(arg);
  } else if (base === 'artist') {
    crumb = 'Artists';
    h = viewArtist(arg);
  } else if (base === 'search') {
    crumb = 'Search';
    h = viewSearch();
  } else if (base === 'playlist') {
    crumb = 'Playlists';
    h = viewPlaylist(arg);
  } else if (base === 'recent') {
    crumb = 'Recently added';
    const rows = libraryTracks()
      .slice()
      .sort((a, b) => b.added - a.added);
    h = rows.length
      ? '<div class="section-head"><h2>Recently added</h2><span class="sub">newest file first</span></div>' + songTable(rows, { context: 'recent' })
      : emptyNote('Nothing here yet', 'Songs appear as soon as a folder is scanned.');
  } else if (base === 'settings') {
    crumb = 'Settings';
    h = viewSettings();
  }
  $('#crumb').textContent = crumb;
  /* Keep the reading position across re-renders (a track change repaints the
     whole table), but start at the top whenever the view itself changes. */
  const keep = S.view === lastRenderedView ? box.scrollTop : 0;
  box.innerHTML = h;
  box.scrollTop = keep;
  lastRenderedView = S.view;
  if (base === 'settings') fillStorageInfo();
}

/* ---------- drag state shared between the view and the sidebar ---------- */

export interface DragState {
  kind: 'tracks';
  entries: PlaylistEntry[];
  uids: string[];
  fromPlaylist: string;
  fromIndex: number;
}

let DRAG: DragState | null = null;
export function getDrag(): DragState | null {
  return DRAG;
}
export function clearDrag(): void {
  DRAG = null;
}

export function clearDropMarks(): void {
  $$('.dragover-top,.dragover-bot').forEach((e) => {
    e.classList.remove('dragover-top', 'dragover-bot');
  });
  $$('.pl-item.dropping').forEach((e) => {
    e.classList.remove('dropping');
  });
  const sb = $('#sidebar');
  if (sb) sb.classList.remove('dropping');
}

/* ---------- #view event wiring ---------- */

export function wireLibrary(): void {
  const view = $('#view');

  view.addEventListener('click', (e) => {
    let el: Element | null;
    const target = e.target as Element;
    /* Ctrl/Cmd-click on an album tile toggles selection instead of opening. */
    const tile = target.closest('.tile[data-nav]');
    if (tile && (e.ctrlKey || e.metaKey) && (tile.getAttribute('data-nav') || '').indexOf('album:') === 0) {
      e.preventDefault();
      e.stopPropagation();
      const key = (tile.getAttribute('data-nav') || '').slice(6);
      if (selAlbums.has(key)) selAlbums.delete(key);
      else selAlbums.add(key);
      tile.classList.toggle('selected', selAlbums.has(key));
      syncAlbumSelBar();
      return;
    }
    if ((el = target.closest('[data-shuffleall]'))) {
      shufflePool(libraryTracks());
      return;
    }
    if ((el = target.closest('[data-playalbum]'))) {
      e.stopPropagation();
      const al = S.albumMap[el.getAttribute('data-playalbum') || ''];
      if (al) playList(al.tracks, 0);
      return;
    }
    if ((el = target.closest('[data-shufflealbum]'))) {
      const al2 = S.albumMap[el.getAttribute('data-shufflealbum') || ''];
      if (al2) {
        if (!S.shuffle) toggleShuffle();
        playList(al2.tracks, Math.floor(Math.random() * al2.tracks.length));
      }
      return;
    }
    if ((el = target.closest('[data-playartist]'))) {
      e.stopPropagation();
      const ar = S.artistMap[el.getAttribute('data-playartist') || ''];
      if (ar) playList(sortTracks(ar.tracks, 'album', 1), 0);
      return;
    }
    if ((el = target.closest('[data-playplaylist]'))) {
      const pl = playlistById(el.getAttribute('data-playplaylist') || '');
      if (pl) playList(playlistTracks(pl).filter((t) => !isMissingTrack(t)), 0);
      return;
    }
    if ((el = target.closest('[data-shuffleplaylist]'))) {
      const pl2 = playlistById(el.getAttribute('data-shuffleplaylist') || '');
      if (pl2) {
        const live = playlistTracks(pl2).filter((t) => !isMissingTrack(t));
        if (live.length) {
          if (!S.shuffle) toggleShuffle();
          playList(live, Math.floor(Math.random() * live.length));
        }
      }
      return;
    }
    if ((el = target.closest('[data-catalog]'))) {
      void openCatalogReview(el.getAttribute('data-catalog') || '');
      return;
    }
    if ((el = target.closest('[data-export]'))) {
      exportM3U(el.getAttribute('data-export') || '');
      return;
    }
    if ((el = target.closest('[data-exportfiles]'))) {
      void exportPlaylistFiles(el.getAttribute('data-exportfiles') || '');
      return;
    }
    if ((el = target.closest('[data-edit-title]'))) {
      startTitleEdit(el as HTMLElement, el.getAttribute('data-edit-title') || '');
      return;
    }
    if ((el = target.closest('[data-sort]'))) {
      const col = (el.getAttribute('data-sort') || 'title') as SortCol;
      if (S.sort.col === col) S.sort.dir = S.sort.dir === 1 ? -1 : 1;
      else S.sort = { col: col, dir: 1 };
      savePrefs();
      render();
      return;
    }
    if ((el = target.closest('[data-kebab]'))) {
      e.stopPropagation();
      const uid = el.getAttribute('data-kebab') || '';
      const row = el.closest('.row');
      const tbl = el.closest('.tbl');
      el.classList.add('open');
      const r = el.getBoundingClientRect();
      openRowMenu(r.left - 170, r.bottom + 4, uid, {
        playlistId: (tbl && tbl.getAttribute('data-playlist')) || '',
        index: row ? parseInt(row.getAttribute('data-i') || '', 10) : -1,
      });
      return;
    }
    if ((el = target.closest('[data-nav]'))) {
      navTo(el.getAttribute('data-nav') || 'albums');
      return;
    }
    if ((el = target.closest('.row'))) {
      handleRowSelect(el.getAttribute('data-uid') || '', parseInt(el.getAttribute('data-i') || '', 10), e);
      return;
    }
    clearSelection();
    setSelectionUI();
  });

  view.addEventListener('dblclick', (e) => {
    const row = (e.target as Element).closest('.row');
    if (!row) return;
    const uid = row.getAttribute('data-uid') || '';
    if (uid.indexOf('missing:') === 0) {
      toast('That file is not in the folder you picked');
      return;
    }
    const list = S.visible.map((u) => S.byUid[u]).filter(Boolean);
    const idx = list.findIndex((t) => t.uid === uid);
    if (idx >= 0) playList(list, idx, { attemptTarget: true });
  });

  const selbar = $('#albumselbar');
  if (selbar) {
    selbar.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (target.closest('#albumselShuffle')) {
        const pool: ReturnType<typeof libraryTracks> = [];
        selAlbums.forEach((key) => {
          const al = S.albumMap[key];
          if (al) for (const t of al.tracks) pool.push(t);
        });
        clearAlbumSelection();
        shufflePool(pool);
        return;
      }
      if (target.closest('#albumselClear')) clearAlbumSelection();
    });
  }

  view.addEventListener('keydown', (e) => {
    const row = (e.target as Element).closest('.row');
    if (!row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const uid = row.getAttribute('data-uid') || '';
      const list = S.visible.map((u) => S.byUid[u]).filter(Boolean);
      const idx = list.findIndex((t) => t.uid === uid);
      if (idx >= 0) playList(list, idx, { attemptTarget: true });
    }
    if (e.key === 'ContextMenu') {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      openRowMenu(r.left + 40, r.bottom, row.getAttribute('data-uid') || '', {});
    }
  });

  view.addEventListener('contextmenu', (e) => {
    const row = (e.target as Element).closest('.row');
    if (!row) return;
    e.preventDefault();
    const uid = row.getAttribute('data-uid') || '';
    if (S.sel.indexOf(uid) < 0) {
      S.sel = [uid];
      setSelectionUI();
    }
    const tbl = row.closest('.tbl');
    openRowMenu(e.clientX, e.clientY, uid, {
      playlistId: (tbl && tbl.getAttribute('data-playlist')) || '',
      index: parseInt(row.getAttribute('data-i') || '', 10),
    });
  });

  /* ---------- drag out of the table, reorder inside a playlist ---------- */

  view.addEventListener('dragstart', (e) => {
    const row = (e.target as Element).closest ? (e.target as Element).closest('.row') : null;
    if (!row) return;
    const uid = row.getAttribute('data-uid') || '';
    const idx = parseInt(row.getAttribute('data-i') || '', 10);
    if (S.sel.indexOf(uid) < 0) {
      S.sel = [uid];
      setLastSelIndex(idx);
      setSelectionUI();
    }
    const tbl = row.closest('.tbl');
    DRAG = {
      kind: 'tracks',
      entries: actionEntries(uid),
      uids: S.sel.slice(),
      fromPlaylist: (tbl && tbl.getAttribute('data-playlist')) || '',
      fromIndex: idx,
    };
    try {
      e.dataTransfer!.effectAllowed = 'copyMove';
      e.dataTransfer!.setData('text/plain', DRAG.entries.map((en) => en.path).join('\n'));
    } catch {
      /* some engines refuse dataTransfer here; the drag still works */
    }
  });
  view.addEventListener('dragend', () => {
    DRAG = null;
    clearDropMarks();
  });

  view.addEventListener('dragover', (e) => {
    if (!DRAG || DRAG.kind !== 'tracks') return;
    const tbl = (e.target as Element).closest('.tbl[data-reorder]');
    if (!tbl || tbl.getAttribute('data-playlist') !== DRAG.fromPlaylist) return;
    const row = (e.target as Element).closest('.row');
    if (!row) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const r = row.getBoundingClientRect();
    const after = e.clientY - r.top > r.height / 2;
    clearDropMarks();
    row.classList.add(after ? 'dragover-bot' : 'dragover-top');
  });
  view.addEventListener('drop', (e) => {
    if (!DRAG || DRAG.kind !== 'tracks') return;
    const tbl = (e.target as Element).closest('.tbl[data-reorder]');
    if (!tbl) return;
    const pid = tbl.getAttribute('data-playlist') || '';
    if (pid !== DRAG.fromPlaylist) return;
    const row = (e.target as Element).closest('.row');
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const to = parseInt(row.getAttribute('data-i') || '', 10) + (e.clientY - r.top > r.height / 2 ? 1 : 0);
    clearDropMarks();
    void movePlaylistRow(pid, DRAG.fromIndex, to);
    DRAG = null;
  });

  /* inline rename from the playlist header */
  function startTitleEdit(h1: HTMLElement, id: string): void {
    const pl = playlistById(id);
    if (!pl) return;
    const inp = document.createElement('input');
    inp.className = 'inline-input';
    inp.style.fontSize = '24px';
    inp.style.fontWeight = '600';
    inp.value = pl.name;
    inp.setAttribute('aria-label', 'Rename this playlist');
    h1.replaceWith(inp);
    inp.focus();
    inp.select();
    const commit = (save: boolean): void => {
      const v = inp.value.trim();
      if (save && v && v !== pl.name) {
        pl.name = v.slice(0, 120);
        void savePlaylist(pl).then(render);
      } else render();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(false);
      }
    });
    inp.addEventListener('blur', () => {
      commit(true);
    });
  }
}
