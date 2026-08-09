/* The ordered music-folder registry: adding folders, restoring them on
   launch, permission flow, and the shell state that goes with it.

   FSA folders persist their directory handle in IndexedDB. On launch,
   queryPermission decides: 'granted' reconnects silently (Chrome 122+
   "Allow on every visit"), 'prompt' renders a one-click Reconnect control —
   requestPermission is only ever called from that user gesture. webkitdir
   folders are session-scoped by design and ask to be re-picked. */

import type { ConnectedFolder, FolderRec, Prefs } from '../types';
import { S, setPrefsMirror } from '../state';
import { ST_FOLDERS, idbAll, idbDel, idbPut } from '../db/idb';
import { migrateFolderSidecar } from '../db/migrate';
import { buildSettings, flushPendingWrites, queueSidecarWrite, readSettings } from './amcdir';
import { FsaBackend, pickDirectory, queryFolderPermission, requestFolderPermission } from './fsa';
import { WebkitDirBackend, pickFolder as pickWebkitFolder } from './webkitdir';
import { canUseFsa } from './adapter';
import { logErr } from '../ui/log';
import { esc, toast, uuid, $ } from '../util';
import { render } from '../ui/render';
import { enqueueFolderScan, reindexLibrary } from '../scan/scanner';
import { reconcileFolderPlaylists } from '../ui/playlists';
import { icon } from '../ui/icons';

export interface PendingFolder {
  rec: FolderRec;
  state: 'needs-permission' | 'needs-repick';
}

const connected: ConnectedFolder[] = [];
const pending: PendingFolder[] = [];
/** folderId → the createdAt its settings.json was born with, so the prefs
    mirror never clobbers it. */
const createdAtOf = new Map<string, number>();

export function connectedFolders(): ConnectedFolder[] {
  return connected.slice().sort((a, b) => a.order - b.order);
}
export function pendingFolders(): PendingFolder[] {
  return pending.slice();
}
export function folderById(folderId: string): ConnectedFolder | null {
  for (const f of connected) if (f.folderId === folderId) return f;
  return null;
}
export function folderOrder(folderId: string): number {
  const f = folderById(folderId);
  if (f) return f.order;
  for (const p of pending) if (p.rec.folderId === folderId) return p.rec.order;
  return 9999;
}
export function folderLabel(folderId: string): string {
  const f = folderById(folderId);
  if (f) return f.label;
  for (const p of pending) if (p.rec.folderId === folderId) return p.rec.label;
  return '';
}
export function firstWritableFolder(): ConnectedFolder | null {
  const list = connectedFolders();
  for (const f of list) if (f.capability === 'readwrite') return f;
  return null;
}

/* ---------- shell state ---------- */

/** Shows the app once any folder is connected; otherwise the empty state,
    which also lists saved folders waiting for permission or a re-pick. */
export function syncShell(): void {
  const has = connected.length > 0;
  S.hasFolder = has;
  $('#empty').hidden = has;
  $('#app').hidden = !has;
  $('#playerbar').hidden = !has;
  renderPendingUI();
  if (has) render();
}

function renderPendingUI(): void {
  const box = $('#savedFolders');
  if (box) {
    if (!pending.length) {
      box.innerHTML = '';
      box.hidden = true;
    } else {
      box.hidden = false;
      let h = '<div class="sf-head">Saved folders</div>';
      for (const p of pending) {
        h +=
          '<div class="sf-row">' +
          icon('folder') +
          '<span class="trunc">' + esc(p.rec.label) + '</span>' +
          (p.state === 'needs-permission'
            ? '<button type="button" class="sf-btn" data-reconnect="' + esc(p.rec.folderId) + '">Connect</button>'
            : '<span class="sf-hint">pick it again to reload</span>') +
          '</div>';
      }
      box.innerHTML = h;
    }
  }
  const chip = $('#reconnectChip');
  if (chip) {
    const p = pending.find((x) => x.state === 'needs-permission');
    if (!p || !connected.length) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      chip.innerHTML = icon('folder') + '<span>Reconnect ' + esc(p.rec.label) + '</span>';
      chip.setAttribute('data-reconnect', p.rec.folderId);
    }
  }
}

/* ---------- identity ---------- */

function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Reads the folder's identity from .AMC/settings.json, or mints it. A
    writable folder gets a generated id written back immediately — picking a
    folder is what creates .AMC/. A read-only folder that hides its sidecar
    falls back to a stable hash of its name. */
async function ensureFolderIdentity(backend: ConnectedFolder['backend']): Promise<string> {
  const existing = await readSettings(backend);
  if (existing) {
    createdAtOf.set(existing.folderId, existing.createdAt || Date.now());
    return existing.folderId;
  }
  if (backend.capability === 'readwrite') {
    const folderId = uuid();
    const createdAt = Date.now();
    await backend.ensureSidecarLayout();
    await backend.writeSidecarText('settings.json', buildSettings(folderId, backend.label, createdAt));
    createdAtOf.set(folderId, createdAt);
    return folderId;
  }
  const folderId = 'wd-' + hashId(backend.label);
  createdAtOf.set(folderId, Date.now());
  return folderId;
}

/* ---------- persistence ---------- */

async function persistFolderRec(rec: FolderRec): Promise<void> {
  await idbPut(ST_FOLDERS, rec);
}

function nextOrder(): number {
  let max = -1;
  for (const f of connected) if (f.order > max) max = f.order;
  for (const p of pending) if (p.rec.order > max) max = p.rec.order;
  return max + 1;
}

let persistAsked = false;
function askStoragePersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  /* Without this ChromeOS can evict the service worker cache and IndexedDB,
     and the app one day simply fails to load. */
  try {
    if (navigator.storage && navigator.storage.persist) {
      void navigator.storage.persist().then((granted) => {
        if (!granted) logErr('storage', 'Persistent storage was not granted', 'the browser may evict caches under pressure');
      });
    }
  } catch {
    /* nothing to do — the cache simply stays evictable */
  }
}

/* ---------- connect ---------- */

async function connectFolder(rec: FolderRec, backend: ConnectedFolder['backend']): Promise<ConnectedFolder> {
  const folder: ConnectedFolder = {
    folderId: rec.folderId,
    label: rec.label,
    order: rec.order,
    capability: backend.capability,
    backend: backend,
  };
  if (!createdAtOf.has(folder.folderId)) {
    const s = await readSettings(backend);
    createdAtOf.set(folder.folderId, (s && s.createdAt) || rec.addedAt || Date.now());
  }
  const already = connected.findIndex((f) => f.folderId === folder.folderId);
  if (already >= 0) connected.splice(already, 1);
  connected.push(folder);
  const pi = pending.findIndex((p) => p.rec.folderId === folder.folderId);
  if (pi >= 0) pending.splice(pi, 1);

  recOf.set(rec.folderId, rec);
  syncShell();
  /* Schema check first: an older sidecar is backed up here and re-keyed
     during the scan (the rename needs the parsed cue layout). */
  await migrateFolderSidecar(folder);
  /* The sidecar is the source of truth: read its playlists and reconcile
     IndexedDB to them (the journal replays dirty rows the other way). */
  await reconcileFolderPlaylists(folder);
  await flushPendingWrites(folder.folderId);
  enqueueFolderScan(folder);
  return folder;
}

const recOf = new Map<string, FolderRec>();

/* ---------- manage (Phase 5 settings) ---------- */

/** Disconnects and forgets a folder. Its files and sidecar are untouched —
    only AMC's registration goes. The library updates live. */
export async function removeFolder(folderId: string): Promise<void> {
  const i = connected.findIndex((f) => f.folderId === folderId);
  const label = i >= 0 ? connected[i].label : folderLabel(folderId);
  if (i >= 0) connected.splice(i, 1);
  const pi = pending.findIndex((p) => p.rec.folderId === folderId);
  if (pi >= 0) pending.splice(pi, 1);
  recOf.delete(folderId);
  try {
    await idbDel(ST_FOLDERS, folderId);
  } catch (e) {
    logErr('folders', "Could not forget '" + label + "' from the registry", (e as Error).message);
  }
  if (S.current && S.current.folderId === folderId) {
    /* The playing file belongs to the removed folder — stop cleanly. */
    const audio = document.getElementById('audio') as HTMLAudioElement | null;
    if (audio) audio.pause();
    S.current = null;
    S.playing = false;
  }
  S.tracks = S.tracks.filter((t) => t.folderId !== folderId);
  S.queue = S.queue.filter((t) => t.folderId !== folderId);
  S.baseQueue = S.baseQueue.filter((t) => t.folderId !== folderId);
  if (S.qi >= S.queue.length) S.qi = S.queue.length - 1;
  reindexLibrary();
  syncShell();
  render();
  toast("Removed '" + label + "' — its files and sidecar were not touched");
}

/** Moves a folder up or down the priority order (duplicate resolution). */
export async function reorderFolder(folderId: string, delta: -1 | 1): Promise<void> {
  const list = connectedFolders();
  const i = list.findIndex((f) => f.folderId === folderId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i];
  const b = list[j];
  const tmp = a.order;
  a.order = b.order;
  b.order = tmp;
  for (const f of [a, b]) {
    const rec = recOf.get(f.folderId);
    if (rec) {
      rec.order = f.order;
      await persistFolderRec(rec);
    }
  }
  /* Priority changed: duplicates may resolve to a different primary. */
  reindexLibrary();
  render();
}

/* ---------- add flows (user gesture) ---------- */

/** The one entry point behind every "add folder" button. FSA where viable;
    the webkitdirectory input otherwise (Safari, file://) — expected there,
    not an error. */
export function addFolderViaPicker(): void {
  /* persist() must ride the click itself — after the picker's awaits the
     gesture is spent and Chrome quietly declines. The result is surfaced
     in Settings › Storage, which also offers a re-request button. */
  askStoragePersist();
  if (canUseFsa()) {
    void (async () => {
      const handle = await pickDirectory();
      if (!handle) return;
      await addFsaFolder(handle);
    })();
  } else {
    pickWebkitFolder();
  }
}

export async function addFsaFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const backend = new FsaBackend(handle);
    const folderId = await ensureFolderIdentity(backend);
    if (folderById(folderId)) {
      toast("'" + backend.label + "' is already in the library");
      return;
    }
    const rec: FolderRec = {
      folderId: folderId,
      label: backend.label,
      order: folderOrder(folderId) === 9999 ? nextOrder() : folderOrder(folderId),
      kind: 'fsa',
      handle: handle,
      addedAt: Date.now(),
    };
    await persistFolderRec(rec);
    askStoragePersist();
    await connectFolder(rec, backend);
  } catch (e) {
    logErr('folders', 'Could not add that folder', (e as Error).message);
    toast('That folder could not be added — see the activity log');
  }
}

export async function addWebkitFolder(fileList: FileList): Promise<void> {
  const backend = new WebkitDirBackend(fileList);
  const files = await backend.listScanFiles();
  if (!files.length) {
    /* Keep the v1 behaviour: show the shell and say what happened. */
    toast('No playable audio in that folder. Try the folder that holds the album folders.');
    logErr('scan', 'The chosen folder had no files with a supported extension', backend.label);
    return;
  }
  const folderId = await ensureFolderIdentity(backend);
  if (folderById(folderId)) {
    toast("'" + backend.label + "' is already loaded — rescanning it");
  }
  const rec: FolderRec = {
    folderId: folderId,
    label: backend.label,
    order: folderOrder(folderId) === 9999 ? nextOrder() : folderOrder(folderId),
    kind: 'webkitdir',
    addedAt: Date.now(),
  };
  /* Metadata only — the handle cannot persist, so next launch shows a
     "pick it again" row instead of silently forgetting the folder. */
  await persistFolderRec(rec);
  askStoragePersist();
  await connectFolder(rec, backend);
}

/* ---------- launch restore ---------- */

export async function restoreFoldersOnBoot(): Promise<void> {
  const rows = (await idbAll<FolderRec>(ST_FOLDERS)).sort((a, b) => a.order - b.order);
  for (const rec of rows) {
    if (rec.kind === 'fsa' && rec.handle) {
      const perm = await queryFolderPermission(rec.handle);
      if (perm === 'granted') {
        try {
          await connectFolder(rec, new FsaBackend(rec.handle));
          continue;
        } catch (e) {
          logErr('folders', "Could not reopen '" + rec.label + "'", (e as Error).message);
        }
      }
      pending.push({ rec: rec, state: 'needs-permission' });
    } else {
      pending.push({ rec: rec, state: 'needs-repick' });
    }
  }
  syncShell();
}

/** One-click reconnect for a saved FSA folder. Runs from a user gesture —
    the only place requestPermission is allowed. */
export async function reconnectFolder(folderId: string): Promise<void> {
  const p = pending.find((x) => x.rec.folderId === folderId);
  if (!p || !p.rec.handle) return;
  const perm = await requestFolderPermission(p.rec.handle);
  if (perm !== 'granted') {
    toast("Chrome did not grant access to '" + p.rec.label + "'");
    return;
  }
  try {
    await connectFolder(p.rec, new FsaBackend(p.rec.handle));
  } catch (e) {
    logErr('folders', "Could not reopen '" + p.rec.label + "'", (e as Error).message);
    toast("'" + p.rec.label + "' could not be opened — see the activity log");
  }
}

export function wireFolderUI(): void {
  const onClick = (e: Event): void => {
    const el = (e.target as Element).closest('[data-reconnect]');
    if (!el) return;
    void reconnectFolder(el.getAttribute('data-reconnect') || '');
  };
  $('#empty').addEventListener('click', onClick);
  $('#topbar').addEventListener('click', onClick);

  /* Global prefs live in IndexedDB; mirror a convenience copy into the
     first folder's settings.json whenever they change. */
  setPrefsMirror((prefs: Prefs) => {
    const first = connectedFolders().filter((f) => f.capability === 'readwrite')[0];
    if (!first) return;
    queueSidecarWrite(first, 'settings.json', () =>
      buildSettings(first.folderId, first.label, createdAtOf.get(first.folderId) || Date.now(), prefs)
    );
  });
}
