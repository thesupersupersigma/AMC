/* Cross-folder duplicate merge. Two tracks match when name, size and
   duration all agree. Merge by default, keep both reachable: the primary
   copy (lowest folder order) is the one library row and carries the refs of
   its shadowed copies for the badge and the "Play from…" menu. Never hide
   or delete a copy — shadowed tracks stay in byRef/byUid and play fine when
   addressed directly. */

import type { AnyTrack } from '../types';
import { refOf } from '../state';

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function dupKey(t: AnyTrack): string {
  /* Identical files parse to identical durations (same bytes, same cached
     rec); rounding only guards float noise in the serialized cache. */
  return baseName(t.path) + '|' + t.size + '|' + Math.round((t.duration || 0) * 10);
}

export function applyDedupe(tracks: AnyTrack[], orderOf: (folderId: string) => number): void {
  for (const t of tracks) {
    t.shadowed = false;
    t.dupRefs = undefined;
  }
  const groups = new Map<string, AnyTrack[]>();
  for (const t of tracks) {
    /* A cue-claimed source is already hidden; its virtual tracks join the
       pool instead and merge across folders like any other row. */
    if (t.claimedByCue) continue;
    const k = dupKey(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  groups.forEach((g) => {
    if (g.length < 2) return;
    /* Folder order sets the default copy; path breaks ties deterministically. */
    g.sort((a, b) => orderOf(a.folderId) - orderOf(b.folderId) || a.path.localeCompare(b.path));
    const primary = g[0];
    primary.dupRefs = [];
    for (let i = 1; i < g.length; i++) {
      g[i].shadowed = true;
      primary.dupRefs.push(refOf(g[i].folderId, g[i].path));
    }
  });
}
