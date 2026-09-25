/* Phase 5a — the settings view: the ordered folder list with live
   add/remove/reorder, sidecar status, cache controls, playback options,
   accent colour, lyrics source, storage usage, and sidecar export/import
   as a zip (store-only writer, store+deflate reader — no libraries).

   Capability is surfaced honestly: on file:// each absent feature gets one
   plain sentence saying what needs a served build and why. */

import type { ConnectedFolder } from '../types';
import { S, SCHEMA_VERSION, applyAccent, libraryTracks, savePrefs } from '../state';
import { addFolderViaPicker, connectedFolders, folderById, pendingFolders, removeFolder, reorderFolder } from '../fs/folders';
import { enqueueFolderScan, rescanLibrary } from '../scan/scanner';
import { ST_COVERS, ST_TRACKS, idbClear } from '../db/idb';
import { logErr } from './log';
import { icon } from './icons';
import { esc, plural, toast, $ } from '../util';
import { artworkSectionHTML, wireArtworkSettings } from '../art/settings-ui'; // hires-art hook

const ACCENTS = ['', '#fa243c', '#ff9f0a', '#30d158', '#0a84ff', '#bf5af2', '#ff375f'];
const XFADES = [0, 3, 6, 9];

/* ---------- the view ---------- */

export function viewSettings(): string {
  let h = '<div class="settings">';

  /* Folders */
  h += '<div class="set-sect"><h2>Music folders</h2><p class="set-hint">Ordered — the first folder wins when the same file exists in two places.</p>';
  const list = connectedFolders();
  list.forEach((f, i) => {
    const sidecar = f.backend.sidecarName();
    h +=
      '<div class="set-folder">' +
      icon('folder') +
      '<div class="set-fmeta"><b>' + esc(f.label) + '</b>' +
      '<span>' +
      (f.capability === 'readwrite'
        ? 'read &amp; write · sidecar ' + (sidecar ? '“' + esc(sidecar) + '”' : 'not created yet') + ' inside the folder'
        : 'read-only in this browser · changes stay in the browser cache' + (sidecar ? ' · reads sidecar “' + esc(sidecar) + '”' : '')) +
      '</span></div>' +
      '<button type="button" class="kebab-btn" data-fol-up="' + esc(f.folderId) + '" title="Move up" ' + (i === 0 ? 'disabled' : '') + '>' + icon('sortup') + '</button>' +
      '<button type="button" class="kebab-btn" data-fol-down="' + esc(f.folderId) + '" title="Move down" ' + (i === list.length - 1 ? 'disabled' : '') + '>' + icon('chev') + '</button>' +
      '<button type="button" class="pill-ghost set-small" data-fol-rescan="' + esc(f.folderId) + '">Rescan</button>' +
      '<button type="button" class="pill-ghost set-small" data-fol-remove="' + esc(f.folderId) + '">Remove</button>' +
      '</div>';
  });
  for (const p of pendingFolders()) {
    h +=
      '<div class="set-folder pending">' + icon('folder') +
      '<div class="set-fmeta"><b>' + esc(p.rec.label) + '</b><span>' +
      (p.state === 'needs-permission' ? 'saved — needs one click to reconnect' : 'saved — pick it again to reload (this browser cannot keep the handle)') +
      '</span></div>' +
      (p.state === 'needs-permission' ? '<button type="button" class="pill-ghost set-small" data-reconnect="' + esc(p.rec.folderId) + '">Connect</button>' : '') +
      '</div>';
  }
  h += '<div class="set-row"><button type="button" class="pill-ghost" data-set="addfolder">' + icon('plus') + 'Add music folder</button>' +
    '<button type="button" class="pill-ghost" data-set="rescanall">Rescan everything</button>' +
    '<button type="button" class="pill-ghost" data-set="clearcache">Clear caches &amp; rescan</button></div></div>';

  /* Playback */
  h += '<div class="set-sect"><h2>Playback</h2>';
  h += '<label class="set-row set-check"><input type="checkbox" data-set="gapless"' + (S.gapless ? ' checked' : '') + '> Gapless cue playback <span class="set-hint">— advance between tracks of one rip without a seek or reload</span></label>';
  h += '<div class="set-row">Crossfade <div class="set-seg">';
  for (const x of XFADES) {
    h += '<button type="button" class="seg-btn' + (S.crossfadeSec === x ? ' on' : '') + '" data-xfade="' + x + '">' + (x === 0 ? 'Off' : x + 's') + '</button>';
  }
  h += '</div><span class="set-hint">between different files; cue tracks of one rip stay gapless</span></div></div>';

  /* Appearance */
  h += '<div class="set-sect"><h2>Accent colour</h2><div class="set-row">';
  for (const a of ACCENTS) {
    h += '<button type="button" class="set-swatch' + ((S.accent || '') === a ? ' on' : '') + '" data-accent="' + a + '" style="background:' + (a || '#fa243c') + '" title="' + (a || 'Default') + '"></button>';
  }
  h += '</div></div>';

  /* Lyrics */
  h += '<div class="set-sect"><h2>Lyrics</h2><div class="set-row"><div class="set-seg">';
  const LS: Array<[string, string]> = [['auto', 'All sources'], ['local', 'Local only'], ['off', 'Off']];
  for (const [v, label] of LS) {
    h += '<button type="button" class="seg-btn' + (S.lyricsSource === v ? ' on' : '') + '" data-lyrsrc="' + v + '">' + label + '</button>';
  }
  h += '</div><span class="set-hint">“Local only” never calls LRCLIB — sidecar, sibling .lrc and tags still work</span></div></div>';

  h += artworkSectionHTML(); // hires-art hook

  /* Storage */
  h += '<div class="set-sect"><h2>Storage</h2><div id="setStorage" class="set-hint">Measuring…</div><div class="set-row" id="setPersistRow" hidden><button type="button" class="pill-ghost set-small" data-set="persist">Request persistent storage</button><span class="set-hint">without it the browser may silently evict the saved folders and caches</span></div></div>';

  /* Sidecar export/import */
  h += '<div class="set-sect"><h2>Sidecar</h2><p class="set-hint">The zip carries playlists, cues, lyrics, notes, overrides and settings — the regenerable caches (artwork, catalog, peaks) stay out. Importing writes into the folder’s sidecar and rescans.</p>';
  for (const f of list) {
    if (f.capability !== 'readwrite') continue;
    h += '<div class="set-row"><b class="set-flabel">' + esc(f.label) + '</b>' +
      '<button type="button" class="pill-ghost set-small" data-set-export="' + esc(f.folderId) + '">Export zip</button>' +
      '<button type="button" class="pill-ghost set-small" data-set-import="' + esc(f.folderId) + '">Import zip…</button></div>';
  }
  h += '</div>';

  /* file:// honesty */
  if (location.protocol === 'file:') {
    h +=
      '<div class="set-sect"><h2>Running from a file</h2>' +
      '<p class="set-hint">Folder picking with write access needs a served build — file:// pages get no File System Access, so folders are read-only and forgotten when the tab closes.</p>' +
      '<p class="set-hint">Offline installation needs a served build — service workers do not register from file:// pages.</p>' +
      '<p class="set-hint">Catalog and lyrics lookups go through music.thesupersupersigma.com while online — this file has no /api of its own. Offline, they fall back to whatever the sidecar already holds.</p>' +
      '</div>';
  }

  h += '<div class="set-sect"><p class="set-hint">AMC v' + esc(__AMC_VERSION__) + ' · Schema v' + SCHEMA_VERSION + '</p>' +
    '<p class="set-hint">AMC is not affiliated with, endorsed by, or connected to Apple Inc. Apple Music is a trademark of Apple Inc.</p>' +
    '<p class="set-hint">Made by <a href="https://github.com/thesupersupersigma" target="_blank" rel="noopener">thesupersupersigma</a> and Claude Fable 5</p>' +
    '</div>';
  h += '</div>';
  return h;
}

/** The storage figures arrive after the view renders. */
export function fillStorageInfo(): void {
  const box = document.getElementById('setStorage');
  if (!box) return;
  void (async () => {
    let est = '';
    try {
      const e = await navigator.storage.estimate();
      if (e && e.usage != null && e.quota != null) {
        est = (e.usage / 1048576).toFixed(1) + ' MB used of ~' + Math.round((e.quota || 0) / 1048576) + ' MB browser storage';
      }
    } catch {
      est = '';
    }
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const el = document.getElementById('setStorage');
    if (!el) return;
    el.textContent =
      (est ? est + ' · ' : '') +
      plural(libraryTracks().length, 'song', 'songs') + ' · ' +
      plural(S.albums.length, 'album', 'albums') +
      ' · persistent storage ' +
      (persisted
        ? 'granted — the saved folders and caches survive storage cleanup'
        : 'NOT granted — the browser may silently evict the saved folder handles');
    const row = document.getElementById('setPersistRow');
    if (row) row.hidden = persisted;
  })();
}

/* ---------- zip: store-only writer, store+deflate reader ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
  const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x800 /* utf-8 names */), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, e.data);
    central.push(
      new Uint8Array([
        0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]),
      name
    );
    offset += local.length + name.length + e.data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...chunks, ...central, eocd] as BlobPart[], { type: 'application/zip' });
}

async function parseZip(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  /* Find EOCD from the tail. */
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end record)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Bad central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    /* Local header: its own name/extra lengths position the data. */
    const lnl = dv.getUint16(lho + 26, true);
    const lel = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnl + lel;
    const raw = b.slice(dataStart, dataStart + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      data = new Uint8Array(await ds.arrayBuffer());
    } else {
      throw new Error('Unsupported compression (method ' + method + ') in ' + name);
    }
    if (!name.endsWith('/')) out.push({ name: name, data: data });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* Only paths a sidecar legitimately holds get written on import. */
const IMPORT_FILES = new Set(['settings.json', 'library.json', 'overrides.json']);
const IMPORT_DIRS = ['playlists/', 'cues/', 'lyrics/', 'notes/'];
function importablePath(name: string): boolean {
  if (name.indexOf('..') >= 0 || name.indexOf('\\') >= 0 || name.charAt(0) === '/') return false;
  if (IMPORT_FILES.has(name)) return true;
  return IMPORT_DIRS.some((d) => name.indexOf(d) === 0 && name.length > d.length);
}

const EXPORT_FILES = ['settings.json', 'library.json', 'overrides.json'];
const EXPORT_DIRS = ['playlists', 'cues', 'lyrics', 'notes'];

async function exportSidecarZip(folder: ConnectedFolder): Promise<void> {
  toast('Collecting the sidecar…');
  const entries: ZipEntry[] = [];
  for (const name of EXPORT_FILES) {
    const blob = await folder.backend.readSidecarBlob(name);
    if (blob) entries.push({ name: name, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  for (const dir of EXPORT_DIRS) {
    const files = await folder.backend.listSidecarTree(dir);
    for (const rel of files) {
      const blob = await folder.backend.readSidecarBlob(dir + '/' + rel);
      if (blob) entries.push({ name: dir + '/' + rel, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  }
  if (!entries.length) {
    toast('Nothing to export yet — the sidecar is empty');
    return;
  }
  const zip = buildZip(entries);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = folder.label.replace(/[\\/:*?"<>|]/g, '_') + '-AMC-sidecar.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Exported ' + plural(entries.length, 'file', 'files'));
}

async function importSidecarZip(folder: ConnectedFolder, file: File): Promise<void> {
  try {
    const entries = await parseZip(await file.arrayBuffer());
    let written = 0;
    let skipped = 0;
    for (const e of entries) {
      if (!importablePath(e.name)) {
        skipped++;
        continue;
      }
      await folder.backend.writeSidecarBlob(e.name, new Blob([e.data as BlobPart]));
      written++;
    }
    toast('Imported ' + written + ' file' + (written === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' skipped)' : '') + ' — rescanning');
    logErr('sidecar', "Imported a sidecar zip into '" + folder.label + "'", written + ' written, ' + skipped + ' skipped');
    enqueueFolderScan(folder);
  } catch (e) {
    logErr('sidecar', 'The zip could not be imported', (e as Error).message);
    toast('That zip could not be read — see the activity log');
  }
}

/* ---------- wiring ---------- */

let importTarget = '';

export function wireSettings(): void {
  wireArtworkSettings(); // hires-art hook
  const zipInput = $('#zippicker') as HTMLInputElement;
  zipInput.addEventListener('change', () => {
    const f = zipInput.files && zipInput.files[0];
    zipInput.value = '';
    const folder = folderById(importTarget);
    if (f && folder) void importSidecarZip(folder, f);
  });

  $('#view').addEventListener('click', (e) => {
    const target = e.target as Element;
    let el: Element | null;

    if ((el = target.closest('[data-set]'))) {
      const what = el.getAttribute('data-set');
      if (what === 'addfolder') addFolderViaPicker();
      else if (what === 'rescanall') rescanLibrary();
      else if (what === 'clearcache') {
        void Promise.all([idbClear(ST_TRACKS), idbClear(ST_COVERS)]).then(() => {
          toast('Caches cleared — re-reading every file');
          rescanLibrary();
        });
      } else if (what === 'gapless') {
        S.gapless = (el as HTMLInputElement).checked;
        savePrefs();
      } else if (what === 'persist') {
        /* A real user gesture — the one place a re-request can succeed. */
        void navigator.storage.persist().then((granted) => {
          toast(granted ? 'Persistent storage granted' : 'The browser declined — it decides by site engagement');
          fillStorageInfo();
        });
      }
      return;
    }
    if ((el = target.closest('[data-fol-up]'))) {
      void reorderFolder(el.getAttribute('data-fol-up') || '', -1);
      return;
    }
    if ((el = target.closest('[data-fol-down]'))) {
      void reorderFolder(el.getAttribute('data-fol-down') || '', 1);
      return;
    }
    if ((el = target.closest('[data-fol-rescan]'))) {
      const f = folderById(el.getAttribute('data-fol-rescan') || '');
      if (f) enqueueFolderScan(f);
      return;
    }
    if ((el = target.closest('[data-fol-remove]'))) {
      void removeFolder(el.getAttribute('data-fol-remove') || '');
      return;
    }
    if ((el = target.closest('[data-xfade]'))) {
      S.crossfadeSec = parseInt(el.getAttribute('data-xfade') || '0', 10) || 0;
      savePrefs();
      rerenderIfSettings();
      return;
    }
    if ((el = target.closest('[data-accent]'))) {
      S.accent = el.getAttribute('data-accent') || '';
      applyAccent(S.accent);
      savePrefs();
      rerenderIfSettings();
      return;
    }
    if ((el = target.closest('[data-lyrsrc]'))) {
      const v = el.getAttribute('data-lyrsrc');
      S.lyricsSource = v === 'local' || v === 'off' ? v : 'auto';
      savePrefs();
      rerenderIfSettings();
      return;
    }
    if ((el = target.closest('[data-set-export]'))) {
      const f = folderById(el.getAttribute('data-set-export') || '');
      if (f) void exportSidecarZip(f);
      return;
    }
    if ((el = target.closest('[data-set-import]'))) {
      importTarget = el.getAttribute('data-set-import') || '';
      zipInput.click();
      return;
    }
  });
}

function rerenderIfSettings(): void {
  if (String(S.view).split(':')[0] === 'settings') {
    /* Local import avoids a render-module cycle at load time. */
    void import('./render').then((m) => m.render());
  }
}
