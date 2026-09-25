/* Turntable mode controller: entering and leaving the mode, the record on
   the platter, and routing the view's clicks. Called from four hooks in
   nowplaying.ts (open, close, track change, click). */

import type { AnyTrack } from '../../types';
import { S, coverURL } from '../../state';
import { heroFor, heroURLNow, setImgDecoded } from '../../art/hero';
import * as pb from './playback';
import { armAngleFor, DEG_PER_SEC, REST_DEG } from './geometry';
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

/* ---------- static placement (the frame loop drives these in motion) ---------- */

export function setPlatterAngle(deg: number): void {
  const platter = document.getElementById('ttPlatter');
  const spin = document.getElementById('ttRecSpin');
  const t = 'rotate(' + (deg % 360).toFixed(2) + 'deg)';
  if (platter) platter.style.transform = t;
  if (spin) spin.style.transform = t;
}

export function setArmAngle(deg: number): void {
  const arm = document.getElementById('ttArm');
  if (arm) arm.style.transform = 'rotate(' + deg.toFixed(3) + 'deg)';
}

function sideFraction(): number {
  const d = pb.getDuration();
  return d > 0 ? pb.getTime() / d : 0;
}

function placeStatic(): void {
  setPlatterAngle(pb.getTime() * DEG_PER_SEC);
  setArmAngle(S.current ? armAngleFor(sideFraction()) : REST_DEG);
}

/* ---------- entering / leaving the mode ---------- */

function enter(): void {
  active = true;
  pb.primeTrack();
  paintAlbum(S.current ? S.current.coverKey : '');
  placeStatic();
}

function leave(): void {
  active = false;
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
  paintAlbum(t ? t.coverKey : '');
  placeStatic();
});

/** Routes clicks inside the Now Playing view; true when handled. */
export function turntableClick(target: Element): boolean {
  if (target.closest('#npMode')) {
    setNpMode(npMode() === 'turntable' ? 'cover' : 'turntable');
    syncModeButton();
    applyMode();
    return true;
  }
  return false;
}

export function wireTurntable(): void {
  pb.wirePlayback();
}
