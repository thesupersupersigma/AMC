/* File System Access backend — Chrome/Edge only, and only when served.
   showDirectoryPicker({ mode: 'readwrite' }) from a user gesture; handles
   persist in IndexedDB; on launch queryPermission decides between a silent
   reconnect and a one-click permission prompt. Chrome 122+ offers "Allow on
   every visit", which is what makes folders stick across restarts. */

import type { Capability, FsBackend } from '../types';
import { AUDIO_EXT, extOf, isJunkFile } from '../parse/bytes';
import { SIDECAR_DIRS } from './amcdir';
import { logErr } from '../ui/log';

/* The sidecar directory is named identically on every platform. A dot
   prefix buys nothing on Windows — the File System Access API cannot set
   the hidden attribute, and Windows does not hide dot-names — so the name
   itself carries the warning. Folders that already have a ".AMC" from an
   earlier version are adopted in place, never orphaned. */
export const AMC_DIR = 'AMC DO NOT DELETE';
export const AMC_DIR_LEGACY = '.AMC';

const README_NAME = 'README.txt';
const README_TEXT = [
  'This folder belongs to AMC, the local music player. It is the sidecar',
  'for the music folder it sits in: playlists, lyrics, cue sheets and',
  'settings live here, next to the music, so the folder stays portable.',
  '',
  'If you delete this folder, AMC recreates it on the next scan — but',
  'only some of what was inside can be rebuilt:',
  '',
  'Safe to delete (regenerable caches):',
  '  artwork/   catalog/   peaks/',
  '',
  'User data — CANNOT be recovered if deleted:',
  '  playlists/   cues/   lyrics/   notes/   overrides.json',
  '',
  'settings.json and library.json are rebuilt by AMC as needed.',
  '',
].join('\n');

/** Opens the OS directory picker. Must be called from a user gesture.
    Returns null when the user cancels. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ mode: 'readwrite', id: 'amc-music' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    logErr('folders', 'The folder picker failed', (e as Error).message);
    return null;
  }
}

/* Permission calls are guarded: OPFS-style handles may not implement them,
   and a missing method means access is simply not permission-gated. */
export async function queryFolderPermission(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  if (typeof h.queryPermission !== 'function') return 'granted';
  try {
    return await h.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'granted';
  }
}
export async function requestFolderPermission(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  if (typeof h.requestPermission !== 'function') return 'granted';
  try {
    return await h.requestPermission({ mode: 'readwrite' });
  } catch (e) {
    logErr('folders', 'The permission request failed', (e as Error).message);
    return 'denied';
  }
}

export class FsaBackend implements FsBackend {
  readonly kind = 'fsa' as const;
  readonly capability: Capability = 'readwrite';
  readonly label: string;
  private root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.label = root.name;
  }

  async listScanFiles(): Promise<{ path: string; file: File }[]> {
    const out: { path: string; file: File }[] = [];
    await this.walk(this.root, this.label, out, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private async walk(dir: FileSystemDirectoryHandle, prefix: string, out: { path: string; file: File }[], depth: number): Promise<void> {
    if (depth > 12) return;
    for await (const [name, handle] of dir.entries()) {
      /* The sidecar, dot entries and OS droppings never hold library audio. */
      if (name.charAt(0) === '.' || name === AMC_DIR) continue;
      if (handle.kind === 'directory') {
        await this.walk(handle as FileSystemDirectoryHandle, prefix + '/' + name, out, depth + 1);
      } else if (!isJunkFile(name) && (AUDIO_EXT.indexOf(extOf(name)) >= 0 || extOf(name) === 'cue')) {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          out.push({ path: prefix + '/' + name, file: file });
        } catch (e) {
          logErr('scan', 'Could not open ' + prefix + '/' + name, (e as Error).message);
        }
      }
    }
  }

  /* ---------- sidecar io — every path stays inside .AMC/ ---------- */

  private static splitRel(relPath: string): string[] {
    const parts = String(relPath).split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.')) {
      throw new Error('Bad sidecar path: ' + relPath);
    }
    return parts;
  }

  /** The sidecar directory name for THIS folder: the current name when
      present, an adopted legacy ".AMC" otherwise, minted fresh only when
      creation is requested. Cached once resolved. */
  private amcName: string | null = null;
  private async resolveAmcName(create: boolean): Promise<string | null> {
    if (this.amcName) return this.amcName;
    try {
      await this.root.getDirectoryHandle(AMC_DIR);
      this.amcName = AMC_DIR;
      return this.amcName;
    } catch {
      /* not present under the current name */
    }
    try {
      await this.root.getDirectoryHandle(AMC_DIR_LEGACY);
      this.amcName = AMC_DIR_LEGACY;
      return this.amcName;
    } catch {
      /* no legacy sidecar either */
    }
    if (!create) return null;
    await this.root.getDirectoryHandle(AMC_DIR, { create: true });
    this.amcName = AMC_DIR;
    return this.amcName;
  }

  private async sidecarDir(create: boolean, sub: string[]): Promise<FileSystemDirectoryHandle | null> {
    try {
      const name = await this.resolveAmcName(create);
      if (!name) return null;
      let dir = await this.root.getDirectoryHandle(name, { create: create });
      for (const part of sub) dir = await dir.getDirectoryHandle(part, { create: create });
      return dir;
    } catch {
      return null;
    }
  }

  async readSidecarText(relPath: string): Promise<string | null> {
    try {
      const parts = FsaBackend.splitRel(relPath);
      const dir = await this.sidecarDir(false, parts.slice(0, -1));
      if (!dir) return null;
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      const f = await fh.getFile();
      return await f.text();
    } catch {
      return null;
    }
  }

  async readSidecarBlob(relPath: string): Promise<Blob | null> {
    try {
      const parts = FsaBackend.splitRel(relPath);
      const dir = await this.sidecarDir(false, parts.slice(0, -1));
      if (!dir) return null;
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return await fh.getFile();
    } catch {
      return null;
    }
  }

  /** A missing .AMC (or subdirectory) is a genuinely empty listing; a
      directory that exists but cannot be read must THROW — the reconcile
      sweep treats an empty listing as "deleted outside AMC", and a transient
      read failure must never look like that. */
  async listSidecarDir(relPath: string): Promise<string[]> {
    const parts = relPath ? FsaBackend.splitRel(relPath) : [];
    const dir = await this.sidecarDir(false, parts);
    if (!dir) return [];
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') names.push(name);
    }
    names.sort();
    return names;
  }

  /** createWritable() writes to a swap file and commits on close(), so a tab
      that dies mid-write leaves the previous file intact. The write is only
      a success if close() succeeds. */
  async writeSidecarText(relPath: string, text: string): Promise<void> {
    const parts = FsaBackend.splitRel(relPath);
    const dir = await this.sidecarDir(true, parts.slice(0, -1));
    if (!dir) throw new Error('Could not open .AMC in ' + this.label);
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(text);
    } catch (e) {
      try {
        await w.abort();
      } catch {
        /* the swap file is discarded either way */
      }
      throw e;
    }
    await w.close();
  }

  async writeSidecarBlob(relPath: string, blob: Blob): Promise<void> {
    const parts = FsaBackend.splitRel(relPath);
    const dir = await this.sidecarDir(true, parts.slice(0, -1));
    if (!dir) throw new Error('Could not open .AMC in ' + this.label);
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(blob);
    } catch (e) {
      try {
        await w.abort();
      } catch {
        /* the swap file is discarded either way */
      }
      throw e;
    }
    await w.close();
  }

  async removeSidecarFile(relPath: string): Promise<void> {
    const parts = FsaBackend.splitRel(relPath);
    const dir = await this.sidecarDir(false, parts.slice(0, -1));
    if (!dir) return;
    try {
      await dir.removeEntry(parts[parts.length - 1]);
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  }

  async ensureSidecarLayout(): Promise<void> {
    const name = await this.resolveAmcName(true);
    const amc = await this.root.getDirectoryHandle(name as string, { create: true });
    for (const sub of SIDECAR_DIRS) await amc.getDirectoryHandle(sub, { create: true });
    /* The README says what this folder is, that AMC recreates it, and which
       parts are user data. Written once; an existing copy is left alone. */
    let hasReadme = true;
    try {
      await amc.getFileHandle(README_NAME);
    } catch {
      hasReadme = false;
    }
    if (!hasReadme) {
      const fh = await amc.getFileHandle(README_NAME, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(README_TEXT);
      } catch (e) {
        try {
          await w.abort();
        } catch {
          /* the swap file is discarded either way */
        }
        throw e;
      }
      await w.close();
    }
  }
}
