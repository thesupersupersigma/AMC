/* The object URL behind the current track, and the crossfade tail. Playback
   logic lives in ui/player.ts and goes through the facade in ./media — the
   <audio id="audio"> element itself is only ever touched there. `probe` is
   the separate, muted duration-probing element the scanner uses. */

import { media } from './media';

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

/* ---------- crossfade (Phase 5) --------------------------------------
   The outgoing tail plays on a throwaway element while the MAIN element
   (which everything else binds to — scrubber, lyrics, Media Session)
   switches to the next track and ramps up. Real overlap, no rebinding.
   Contiguous cue advances never come here — that path is gapless.
   A software-decoded track's tail is its own engine stream: the facade
   detaches the playing engine instance to fade out, and a fresh one takes
   the next track. ---------- */

let tailEl: HTMLAudioElement | null = null;
let tailUrl = '';
let tailTimer: ReturnType<typeof setInterval> | null = null;
let rampTimer: ReturnType<typeof setInterval> | null = null;

function disposeTail(): void {
  if (tailTimer) clearInterval(tailTimer);
  tailTimer = null;
  if (tailEl) {
    try {
      tailEl.pause();
      tailEl.src = '';
    } catch {
      /* already dead */
    }
    tailEl = null;
  }
  if (tailUrl) {
    try {
      URL.revokeObjectURL(tailUrl);
    } catch {
      /* already gone */
    }
    tailUrl = '';
  }
}

/** Plays the closing seconds of the outgoing track on a side element (or,
    for an engine track, on the detached engine stream), fading it to
    silence. Fire-and-forget; a new call kills the old element tail. */
export function startCrossfadeTail(file: File, atSec: number, fromVolume: number, seconds: number): void {
  disposeTail();
  if (media.detachEngineTail(seconds)) return;
  try {
    tailUrl = URL.createObjectURL(file);
    const el = new Audio();
    tailEl = el;
    el.preload = 'auto';
    el.src = tailUrl;
    el.volume = Math.max(0, Math.min(1, fromVolume));
    el.currentTime = atSec;
    void el.play().catch(() => {
      disposeTail();
    });
    const t0 = Date.now();
    tailTimer = setInterval(() => {
      const f = 1 - (Date.now() - t0) / (seconds * 1000);
      if (f <= 0 || !tailEl) {
        disposeTail();
        return;
      }
      try {
        tailEl.volume = Math.max(0, fromVolume * f);
      } catch {
        disposeTail();
      }
    }, 50);
  } catch {
    disposeTail();
  }
}

/** Ramps the main playback from silence up to `toVolume`. A user volume
    change (or another ramp) cancels it. */
export function rampMainVolume(toVolume: number, seconds: number): void {
  cancelMainRamp();
  const t0 = Date.now();
  try {
    media.volume = 0;
  } catch {
    return;
  }
  rampTimer = setInterval(() => {
    const f = (Date.now() - t0) / (seconds * 1000);
    try {
      if (f >= 1) {
        media.volume = toVolume;
        cancelMainRamp();
      } else {
        media.volume = toVolume * f;
      }
    } catch {
      cancelMainRamp();
    }
  }, 50);
}

export function cancelMainRamp(): void {
  if (rampTimer) clearInterval(rampTimer);
  rampTimer = null;
}
