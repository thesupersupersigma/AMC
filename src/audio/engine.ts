/* The audio elements and the object URL behind the current track. Playback
   logic lives in ui/player.ts; Phase 3 grows this module (gapless cue
   advancing needs the element to not reload between contiguous tracks). */

export const audio = document.getElementById('audio') as HTMLAudioElement;
export const probe = document.getElementById('probe') as HTMLAudioElement;

let currentURL = '';
/** refOf(folderId, sourcePath) of the file the element currently holds —
    what lets contiguous cue tracks advance without a reload. */
let loadedSrcKey = '';

export function getLoadedSrcKey(): string {
  return loadedSrcKey;
}
export function setLoadedSrcKey(key: string): void {
  loadedSrcKey = key;
}

export function revokeCurrentURL(): void {
  if (currentURL) {
    try {
      URL.revokeObjectURL(currentURL);
    } catch {
      /* already gone */
    }
    currentURL = '';
  }
  loadedSrcKey = '';
}

/** Mints the object URL for a track's file and remembers it for revocation.
    Throws if the file handle is dead — the caller treats that as a failure. */
export function createTrackURL(file: File): string {
  currentURL = URL.createObjectURL(file);
  return currentURL;
}
