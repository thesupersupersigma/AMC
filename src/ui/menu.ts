/* Context menus — styled inline. No alert / confirm / prompt anywhere. */

import { S } from '../state';
import { icon } from './icons';
import { esc, plural, toast, $$ } from '../util';
import { logErr } from './log';
import { plEdit, addPathsToPlaylist, createPlaylist, exportM3U, playlistById, removeAtFromPlaylist } from './playlists';
import { actionPaths, actionTracks } from './songs';
import { queueAppend, queueNext } from './player';
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

export function menuOpen(): boolean {
  return !!menuEl;
}

export function closeMenu(): void {
  if (subEl) {
    subEl.remove();
    subEl = null;
  }
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  $$('.kebab-btn.open').forEach((b) => {
    b.classList.remove('open');
  });
}

function buildMenu(items: MenuItem[]): HTMLElement {
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
        openSub(b, sub());
      };
      b.addEventListener('mouseenter', open);
      b.addEventListener('focus', open);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        open();
      });
    } else {
      /* moving onto a plain item dismisses any open flyout */
      const shut = (): void => {
        if (subEl) {
          subEl.remove();
          subEl = null;
        }
      };
      b.addEventListener('mouseenter', shut);
      b.addEventListener('focus', shut);
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
  if (subEl) {
    subEl.remove();
    subEl = null;
  }
  subEl = buildMenu(items);
  const r = anchor.getBoundingClientRect();
  document.body.appendChild(subEl);
  const sr = subEl.getBoundingClientRect();
  let left = r.right + 4;
  if (left + sr.width > window.innerWidth - 8) left = r.left - sr.width - 4;
  const top = Math.min(r.top - 4, window.innerHeight - sr.height - 10);
  subEl.style.left = Math.max(8, left) + 'px';
  subEl.style.top = Math.max(8, top) + 'px';
}

function addToPlaylistSub(paths: string[]): MenuItem[] {
  const items: MenuItem[] = [];
  S.playlists.forEach((pl) => {
    items.push({
      label: pl.name,
      icon: 'note',
      onClick: () => {
        void addPathsToPlaylist(pl.id, paths);
      },
    });
  });
  if (S.playlists.length) items.push({ sep: true });
  items.push({
    label: 'New Playlist…',
    icon: 'plus',
    onClick: () => {
      void createPlaylist('Playlist ' + (S.playlists.length + 1), paths).then((pl) => {
        S.view = 'playlist:' + pl.id;
        plEdit.renamingId = pl.id;
        render();
        toast('Created ' + pl.name + ' with ' + plural(paths.length, 'song', 'songs'));
      });
    },
  });
  return items;
}

export function openRowMenu(x: number, y: number, uid: string, ctx: { playlistId?: string; index?: number }): void {
  const tracks = actionTracks(uid);
  const paths = actionPaths(uid);
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
  items.push({ sep: true });
  items.push({ label: 'Add to Playlist', icon: 'plus', sub: () => addToPlaylistSub(paths) });
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
