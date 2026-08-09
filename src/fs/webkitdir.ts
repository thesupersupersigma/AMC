/* The `<input webkitdirectory>` backend — read-only, session-scoped. This is
   the Safari and file:// path, and it is expected, not an error: Safari
   implements no local-disk pickers at all. Some browsers exclude dot-entries
   from directory picks, so the sidecar may be invisible here; when it is,
   the folder still works and every write stays in the IndexedDB journal. */

import type { Capability, FsBackend } from '../types';
import { extOf, isAudioFile, isJunkFile } from '../parse/bytes';
import { $ } from '../util';

/** Opens the directory input. Must be called from a user gesture. */
export function pickFolder(): void {
  const input = $<HTMLInputElement>('#picker');
  input.value = '';
  input.click();
}

export class WebkitDirBackend implements FsBackend {
  readonly kind = 'webkitdir' as const;
  readonly capability: Capability = 'read';
  readonly label: string;
  private files: { path: string; file: File }[] = [];
  /** Path under .AMC/ → File, when the browser included dot-entries. */
  private sidecar = new Map<string, File>();
  private amcName: string | null = null;

  constructor(fileList: FileList | File[]) {
    const all: File[] = Array.prototype.slice.call(fileList);
    let root = '';
    for (const f of all) {
      const path = f.webkitRelativePath || f.name;
      if (!root && path.indexOf('/') > 0) root = path.slice(0, path.indexOf('/'));
      /* Either sidecar name: the current one, or a legacy ".AMC" (some
         browsers exclude dot-entries from directory picks — when they do,
         the folder still works and writes stay in the journal). */
      const amc = path.match(/\/(AMC DO NOT DELETE|\.AMC)\//);
      if (amc && amc.index !== undefined) {
        this.amcName = amc[1];
        this.sidecar.set(path.slice(amc.index + amc[0].length), f);
        continue;
      }
      if (isAudioFile(f) || (!isJunkFile(f.name) && (extOf(f.name) === 'cue' || extOf(f.name) === 'lrc'))) this.files.push({ path: path, file: f });
    }
    this.label = root || 'Music';
    this.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  listScanFiles(): Promise<{ path: string; file: File }[]> {
    return Promise.resolve(this.files.slice());
  }

  async readSidecarText(relPath: string): Promise<string | null> {
    const f = this.sidecar.get(relPath);
    if (!f) return null;
    try {
      return await f.text();
    } catch {
      return null;
    }
  }

  readSidecarBlob(relPath: string): Promise<Blob | null> {
    return Promise.resolve(this.sidecar.get(relPath) || null);
  }

  listSidecarDir(relPath: string): Promise<string[]> {
    const prefix = relPath ? relPath.replace(/\/+$/, '') + '/' : '';
    const names: string[] = [];
    this.sidecar.forEach((_f, rel) => {
      if (rel.indexOf(prefix) === 0) {
        const rest = rel.slice(prefix.length);
        if (rest && rest.indexOf('/') < 0) names.push(rest);
      }
    });
    names.sort();
    return Promise.resolve(names);
  }

  writeSidecarText(relPath: string): Promise<void> {
    return Promise.reject(new Error('This folder is read-only in this browser (' + relPath + ' not written)'));
  }

  listSidecarTree(relPath: string): Promise<string[]> {
    const prefix = relPath ? relPath.replace(/\/+$/, '') + '/' : '';
    const out: string[] = [];
    this.sidecar.forEach((_f, rel) => {
      if (rel.indexOf(prefix) === 0 && rel.length > prefix.length) out.push(rel.slice(prefix.length));
    });
    out.sort();
    return Promise.resolve(out);
  }

  writeSidecarBlob(relPath: string): Promise<void> {
    return Promise.reject(new Error('This folder is read-only in this browser (' + relPath + ' not written)'));
  }

  removeSidecarDir(relPath: string): Promise<void> {
    return Promise.reject(new Error('This folder is read-only in this browser (' + relPath + ' not removed)'));
  }

  removeSidecarFile(relPath: string): Promise<void> {
    return Promise.reject(new Error('This folder is read-only in this browser (' + relPath + ' not removed)'));
  }

  sidecarName(): string | null {
    return this.amcName;
  }

  ensureSidecarLayout(): Promise<void> {
    return Promise.resolve();
  }
}
