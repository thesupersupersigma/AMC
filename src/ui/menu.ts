/* Context menus — styled inline. No alert / confirm / prompt anywhere. */

import type { AnyTrack, PlaylistEntry } from '../types';
import { S, isMissingTrack } from '../state';
import { folderLabel } from '../fs/folders';
import { icon } from './icons';
import { esc, plural, toast, $$ } from '../util';
import { logErr } from './log';
import { plEdit, addEntriesToPlaylist, createPlaylist, exportM3U, playlistById, removeAtFromPlaylist } from './playlists';
import { actionEntries, actionTracks } from './songs';
import { playList, queueAppend, queueNext } from './player';
import { render, renderPlaylistNavOnly } from './render';

export interface MenuItem {
  label?: string;
  icon?: string;
  sep?: boolean;
  static?: boolean;
  danger?: boolean;
  sub?: () => MenuItem[];
  onClick?: () => void;
}

let menuEl: HTMLElement | null = null,
  subEl: HTMLElement | null = null;

/* Hover intent for the flyout. Closing is never immediate on pointer
   movement: it is scheduled ~200ms out and cancelled by entering either the
   parent item or the submenu itself, so the diagonal move toward the flyout
   survives clipping a sibling item on the way. (Immediate close on sibling
   hover is also what made entering the flyout's own items dismiss it in v1 —
   submenu items get no dismiss handler at all now.) */
const SUB_CLOSE_MS = 200;
let subAnchor: HTMLElement | null = null;
let subCloseTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSubClose(): void {
  if (subCloseTimer) {
    clearTimeout(subCloseTimer);
    subCloseTimer = null;
  }
}
function closeSubNow(): void {
  cancelSubClose();
  if (subEl) {
    subEl.remove();
    subEl = null;
  }
  if (subAnchor) {
    subAnchor.classList.remove('sub-open');
    subAnchor = null;
  }
}
function scheduleSubClose(): void {
  cancelSubClose();
  if (!subEl) return;
  subCloseTimer = setTimeout(closeSubNow, SUB_CLOSE_MS);
}

export function menuOpen(): boolean {
  return !!menuEl;
}

export function closeMenu(): void {
  closeSubNow();
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  $$('.kebab-btn.open').forEach((b) => {
    b.classList.remove('open');
  });
}

function buildMenu(items: MenuItem[], isSub?: boolean): HTMLElement {
  const m = document.createElement('div');
  m.className = 'menu';
  items.forEach((it) => {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'sep';
      m.appendChild(s);
      return;
    }
    if (it.label && it.static) {
      const l = document.createElement('div');
      l.className = 'mlabel';
      l.textContent = it.label;
      m.appendChild(l);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    if (it.danger) b.className = 'danger';
    b.innerHTML =
      (it.icon ? icon(it.icon) : '<span style="width:14px"></span>') +
      '<span class="trunc">' + esc(it.label) + '</span>' +
      (it.sub ? icon('chev', 'chev') : '');
    if (it.sub) {
      const sub = it.sub;
      const open = (): void => {
        cancelSubClose();
        if (subEl && subAnchor === b) return; /* already open for this item */
        openSub(b, sub());
      };
      b.addEventListener('mouseenter', open);
      b.addEventListener('focus', open);
      b.addEventListener('mouseleave', scheduleSubClose);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        open();
      });
    } else {
      if (!isSub) {
        /* A plain sibling in the root menu closes the flyout — after the
           hover-intent delay for the pointer, immediately for keyboard
           focus, which has no diagonal to protect. */
        b.addEventListener('mouseenter', scheduleSubClose);
        b.addEventListener('focus', closeSubNow);
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        try {
          if (it.onClick) it.onClick();
        } catch (err) {
          logErr('menu', 'That action failed', (err as Error) && (err as Error).message);
        }
      });
    }
    m.appendChild(b);
  });
  return m;
}

function placeMenu(m: HTMLElement, x: number, y: number): void {
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 10);
  const top = Math.min(y, window.innerHeight - r.height - 10);
  m.style.left = Math.max(8, left) + 'px';
  m.style.top = Math.max(8, top) + 'px';
}

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  menuEl = buildMenu(items);
  placeMenu(menuEl, x, y);
}

function openSub(anchor: HTMLElement, items: MenuItem[]): void {
  closeSubNow();
  subEl = buildMenu(items, true);
  subAnchor = anchor;
  anchor.classList.add('sub-open');
  const r = anchor.getBoundingClientRect();
  document.body.appendChild(subEl);
  /* The flyout itself keeps the close at bay while the pointer is inside. */
  subEl.addEventListener('mouseenter', cancelSubClose);
  subEl.addEventListener('mouseleave', scheduleSubClose);
  const sr = subEl.getBoundingClientRect();
  /* Overlap the parent item's edge — a gap here is a dead zone that would
     start the close timer mid-crossing. */
  let left = r.right - 6;
  if (left + sr.width > window.innerWidth - 8) left = r.left - sr.width + 6;
  const top = Math.min(r.top - 4, window.innerHeight - sr.height - 10);
  subEl.style.left = Math.max(8, left) + 'px';
  subEl.style.top = Math.max(8, top) + 'px';
}

function addToPlaylistSub(entries: PlaylistEntry[]): MenuItem[] {
  const items: MenuItem[] = [];
  S.playlists.forEach((pl) => {
    items.push({
      label: pl.name,
      icon: 'note',
      onClick: () => {
        void addEntriesToPlaylist(pl.id, entries);
      },
    });
  });
  if (S.playlists.length) items.push({ sep: true });
  items.push({
    label: 'New Playlist…',
    icon: 'plus',
    onClick: () => {
      void createPlaylist('Playlist ' + (S.playlists.length + 1), entries).then((pl) => {
        S.view = 'playlist:' + pl.id;
        plEdit.renamingId = pl.id;
        render();
        toast('Created ' + pl.name + ' with ' + plural(entries.length, 'song', 'songs'));
      });
    },
  });
  return items;
}

/** The duplicate-copy chooser: each copy plays in place of the primary row,
    keeping the rest of the visible list as the queue. Folder order set the
    default; this menu overrides it for right now. */
function playFromSub(primary: AnyTrack): MenuItem[] {
  const copies: { label: string; track: AnyTrack }[] = [
    { label: folderLabel(primary.folderId) || 'this folder', track: primary },
  ];
  for (const ref of primary.dupRefs || []) {
    const t = S.byRef[ref];
    if (t) copies.push({ label: folderLabel(t.folderId) || t.folderId, track: t });
  }
  return copies.map((c, ci) => ({
    label: ci === 0 ? c.label + ' (default)' : c.label,
    icon: 'folder',
    onClick: () => {
      const list = S.visible.map((u) => S.byUid[u]).filter(Boolean);
      const at = list.findIndex((t) => t.uid === primary.uid);
      if (at >= 0) list[at] = c.track;
      playList(list, at >= 0 ? at : 0);
    },
  }));
}

export function openRowMenu(x: number, y: number, uid: string, ctx: { playlistId?: string; index?: number }): void {
  const tracks = actionTracks(uid);
  const entries = actionEntries(uid);
  const n = tracks.length;
  const label = n > 1 ? plural(n, 'song', 'songs') : '';
  const items: MenuItem[] = [];
  if (label) items.push({ label: label + ' selected', static: true });
  items.push({
    label: 'Play next',
    icon: 'playnext',
    onClick: () => {
      queueNext(tracks);
    },
  });
  items.push({
    label: 'Add to queue',
    icon: 'queue',
    onClick: () => {
      queueAppend(tracks);
    },
  });
  if (n === 1 && !isMissingTrack(tracks[0]) && tracks[0].dupRefs && tracks[0].dupRefs.length) {
    const single = tracks[0];
    items.push({ label: 'Play from', icon: 'folder', sub: () => playFromSub(single) });
  }
  items.push({ sep: true });
  items.push({ label: 'Add to Playlist', icon: 'plus', sub: () => addToPlaylistSub(entries) });
  if (ctx && ctx.playlistId) {
    const pid = ctx.playlistId;
    const index = ctx.index == null ? -1 : ctx.index;
    items.push({ sep: true });
    items.push({
      label: 'Remove from this playlist',
      icon: 'minus',
      danger: true,
      onClick: () => {
        void removeAtFromPlaylist(pid, index);
      },
    });
  }
  openMenu(x, y, items);
}

export function openPlaylistMenu(x: number, y: number, id: string): void {
  const pl = playlistById(id);
  if (!pl) return;
  openMenu(x, y, [
    {
      label: 'Rename',
      icon: 'pencil',
      onClick: () => {
        plEdit.renamingId = id;
        plEdit.confirmDeleteId = '';
        renderPlaylistNavOnly();
      },
    },
    {
      label: 'Export as M3U',
      icon: 'download',
      onClick: () => {
        exportM3U(id);
      },
    },
    { sep: true },
    {
      label: 'Delete',
      icon: 'trash',
      danger: true,
      onClick: () => {
        plEdit.confirmDeleteId = id;
        plEdit.renamingId = '';
        renderPlaylistNavOnly();
      },
    },
  ]);
}

/* global menu dismissal */
export function wireMenus(): void {
  document.addEventListener('click', () => {
    closeMenu();
  });
  document.addEventListener(
    'scroll',
    () => {
      closeMenu();
    },
    true
  );
  window.addEventListener('resize', () => {
    closeMenu();
  });
}
