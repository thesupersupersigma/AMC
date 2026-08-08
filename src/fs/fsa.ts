/* File System Access backend — Chrome/Edge only, and only when served.
   showDirectoryPicker({ mode: 'readwrite' }) from a user gesture; handles
   persist in IndexedDB; on launch queryPermission decides between a silent
   reconnect and a one-click permission prompt. Chrome 122+ offers "Allow on
   every visit", which is what makes folders stick across restarts. */

import type { Capability, FsBackend } from '../types';
import { AUDIO_EXT, extOf } from '../parse/bytes';
import { SIDECAR_DIRS } from './amcdir';
import { logErr } from '../ui/log';

const AMC_DIR = '.AMC';

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

  async listAudioFiles(): Promise<{ path: string; file: File }[]> {
    const out: { path: string; file: File }[] = [];
    await this.walk(this.root, this.label, out, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private async walk(dir: FileSystemDirectoryHandle, prefix: string, out: { path: string; file: File }[], depth: number): Promise<void> {
    if (depth > 12) return;
    for await (const [name, handle] of dir.entries()) {
      /* Dot entries hold the sidecar and editor droppings, never audio. */
      if (name.charAt(0) === '.') continue;
      if (handle.kind === 'directory') {
        await this.walk(handle as FileSystemDirectoryHandle, prefix + '/' + name, out, depth + 1);
      } else if (AUDIO_EXT.indexOf(extOf(name)) >= 0) {
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

  private async sidecarDir(create: boolean, sub: string[]): Promise<FileSystemDirectoryHandle | null> {
    try {
      let dir = await this.root.getDirectoryHandle(AMC_DIR, { create: create });
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
    const amc = await this.root.getDirectoryHandle(AMC_DIR, { create: true });
    for (const sub of SIDECAR_DIRS) await amc.getDirectoryHandle(sub, { create: true });
  }
}
