/* Unsplit-rip detection. Runs after every index pass and badges file tracks
   that look like whole vinyl sides: longer than 12 minutes with no cue from
   any source, a long file sitting alone in its album folder, or a cue that
   exists but is broken (failed to parse / points at a missing file — the
   attach pass records those on cueError). */

import { S } from '../state';

export const LONG_TRACK_SEC = 12 * 60;

export function detectSplitFlags(): void {
  const countByDir = new Map<string, number>();
  for (const t of S.tracks) {
    if (t.kind !== 'file' || t.shadowed) continue;
    const dir = t.path.slice(0, t.path.lastIndexOf('/'));
    countByDir.set(dir, (countByDir.get(dir) || 0) + 1);
  }
  for (const t of S.tracks) {
    if (t.kind !== 'file') continue;
    t.splitFlag = undefined;
    if (t.claimedByCue || t.shadowed) continue;
    if (t.cueError) {
      t.splitFlag = 'cue-broken';
    } else if (t.duration > LONG_TRACK_SEC) {
      const dir = t.path.slice(0, t.path.lastIndexOf('/'));
      t.splitFlag = (countByDir.get(dir) || 0) === 1 ? 'lonely-long' : 'long-no-cue';
    }
  }
}
