/* Turntable mode controller: entering and leaving the mode, the record on
   the platter, and routing the view's clicks. Called from four hooks in
   nowplaying.ts (open, close, track change, click). */

import type { AnyTrack } from '../../types';
import { S, coverURL } from '../../state';
import { heroFor, heroURLNow, setImgDecoded } from '../../art/hero';
import * as pb from './playback';
import { armMoveTo, frameStats, noteJump, paintBands, resetFrameStats, seekedByHand, startMotion, stopMotion, wireArmInput } from './motion';
import { cancelSwap, swapRunning, swapTo } from './swap';
import { speedClick, speedEnter, speedLeave, wireSpeedInput } from './speed';
import { modeButtonMarkup, npMode, setNpMode, speedMarkup, syncModeButton, turntableMarkup } from './view';

let npOpen = false;
let active = false;

/** What the deck currently shows: the album on the platter and in the
    sleeve (its key), which can lag S.current during a record swap. */
let shownKey = '';

export function turntableActive(): boolean {
  return active;
}

/* ---------- markup for nowplaying.ts ---------- */

export function ttDeckMarkup(): string {
  return turntableMarkup();
}
export function ttSpeedMarkup(): string {
  return speedMarkup();
}
export function ttModeButton(): string {
  return modeButtonMarkup();
}

/* ---------- artwork on the label and the sleeve ---------- */

function artFor(key: string): string {
  return heroURLNow(key) || coverURL(key);
}

function paintAlbum(key: string): void {
  shownKey = key;
  const label = document.getElementById('ttLabel') as HTMLImageElement | null;
  const sleeve = document.getElementById('ttSleeveImg') as HTMLImageElement | null;
  const url = artFor(key);
  for (const img of [label, sleeve]) {
    if (!img) continue;
    setImgDecoded(img, url);
    img.parentElement && img.parentElement.classList.toggle('tt-noart', !url);
  }
  if (key) {
    void heroFor(key).then((h) => {
      if (!h || shownKey !== key || !active) return;
      for (const img of [label, sleeve]) if (img && img.isConnected) setImgDecoded(img, h.url);
      for (const img of [label, sleeve]) img && img.parentElement && img.parentElement.classList.remove('tt-noart');
    });
  }
}

/* ---------- entering / leaving the mode ---------- */

function enter(): void {
  active = true;
  pb.primeTrack();
  paintAlbum(S.current ? S.current.coverKey : '');
  paintBands();
  speedEnter();
  resetFrameStats();
  startMotion();
}

function leave(): void {
  active = false;
  cancelSwap();
  stopMotion();
  speedLeave();
}

/** Average script time per frame while the deck is open (frame budget). */
export function turntableFrameStats(): { frames: number; avgMs: number; worstMs: number } {
  return frameStats();
}

function applyMode(): void {
  const view = document.getElementById('npview');
  const want = npOpen && npMode() === 'turntable';
  /* On close the class stays for the fade-out; the next open resets it. */
  if (view && npOpen) view.classList.toggle('np-tt', want);
  if (want && !active) enter();
  else if (!want && active) leave();
}

/* ---------- hooks from nowplaying.ts ---------- */

export function turntableOpened(): void {
  npOpen = true;
  applyMode();
}

export function turntableClosed(): void {
  npOpen = false;
  applyMode();
}

export function turntableTrackChanged(): void {
  pb.notifyTrackChange();
}

pb.onTrackChange((t: AnyTrack | null) => {
  if (!active) return;
  noteJump();
  paintBands();
  const key = t ? t.coverKey : '';
  /* A different album (the key includes the folder, so editions differ):
     the record swap. Rapid skips retarget the running swap. */
  if (swapRunning() || key !== shownKey) {
    swapTo(key, paintAlbum);
    return;
  }
  /* Same album: the arm follows the new position with a quick lift → move
     → drop — unless the listener just put it there by hand. */
  if (!seekedByHand()) armMoveTo(null, 600);
});

pb.onSeeked(() => {
  if (active) noteJump();
});
pb.onDurationKnown(() => {
  if (active) paintBands();
});

/** Routes clicks inside the Now Playing view; true when handled. */
export function turntableClick(target: Element): boolean {
  if (target.closest('#npMode')) {
    setNpMode(npMode() === 'turntable' ? 'cover' : 'turntable');
    syncModeButton();
    applyMode();
    return true;
  }
  if (active && speedClick(target)) return true;
  return false;
}

export function wireTurntable(): void {
  pb.wirePlayback();
  wireArmInput();
  wireSpeedInput();
}
