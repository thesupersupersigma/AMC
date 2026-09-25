/* Turntable motion: one requestAnimationFrame loop while the mode is open.

   Spin is driven by playback TIME, never a timer:
     platter angle = getTime() × (33⅓ / 60) × 360° (+ a constant offset)
   so it stops when paused, jumps on seek, and follows the playback rate
   (45 / 78 RPM, the brake ramp) on its own.

   The tonearm is the seek bar: its angle is linear in getTime() /
   getDuration() from the outer groove to the inner one. getTime() is
   source-file time, so on a cue-split vinyl side the arm walks inward
   across the WHOLE side. Drag the headshell (mouse or touch) to lift,
   move and drop the needle; arrow keys move it ±5 s.

   Only transforms are written per frame (GPU-composited rotate()); no
   layout reads except during a drag. */

import { fmtTime } from '../../util';
import * as pb from './playback';
import {
  DEG_PER_SEC, INNER_DEG, OUTER_DEG, PIVOT, R_RECORD, REST_DEG, STAGE_W, armAngleFor, fracForArmAngle, radiusForAngle,
} from './geometry';

const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export function reducedMotion(): boolean {
  return !!(REDUCED && REDUCED.matches);
}

/* ---------- state ---------- */

let running = false;
let raf = 0;

/** Visual platter angle = spinSource() + offset, where spinSource is
    playback-time based. `spinOverride` hands the platter to the record
    swap (spin-down / spin-up) and back. */
let angleOffset = 0;
let platterAngle = 0;
let spinOverride: ((now: number) => number) | null = null;
/** Reduced motion: the record only turns when playback jumps. */
let staticAngle = 0;

let armAngle = REST_DEG;
let armOverride: ((now: number) => number) | null = null;
let dragging = false;
let dragAngle = 0;
let recentSeekAt = 0;

/* frame budget */
let frames = 0;
let scriptMs = 0;
let worstMs = 0;

/* cached nodes */
let elPlatter: HTMLElement | null = null;
let elSpin: HTMLElement | null = null;
let elArm: HTMLElement | null = null;
let elHead: HTMLElement | null = null;
let elWorld: HTMLElement | null = null;
let elView: HTMLElement | null = null;

function grab(): void {
  elPlatter = document.getElementById('ttPlatter');
  elSpin = document.getElementById('ttRecSpin');
  elArm = document.getElementById('ttArm');
  elHead = document.getElementById('ttHead');
  elWorld = document.getElementById('ttWorld');
  elView = document.getElementById('npview');
}

/* ---------- time → angles ---------- */

export function timeAngle(): number {
  return pb.getTime() * DEG_PER_SEC;
}

export function sideFraction(): number {
  const d = pb.getDuration();
  return d > 0 ? Math.max(0, Math.min(1, pb.getTime() / d)) : 0;
}

/** Where the arm belongs right now if nothing is animating it. */
export function liveArmAngle(): number {
  return pb.currentTrack() ? armAngleFor(sideFraction()) : REST_DEG;
}

export function currentPlatterAngle(): number {
  return platterAngle;
}
export function currentArmAngle(): number {
  return armAngle;
}

/** Hands the platter to an animation (the record swap); passing null
    hands it back to playback time without a visible jump. */
export function overrideSpin(fn: ((now: number) => number) | null): void {
  if (!fn && spinOverride) {
    angleOffset = platterAngle - timeAngle();
    staticAngle = platterAngle;
  }
  spinOverride = fn;
}

export function overrideArm(fn: ((now: number) => number) | null): void {
  armOverride = fn;
}

export function setLifted(on: boolean): void {
  if (elWorld) elWorld.classList.toggle('tt-lifted', on);
}

/** Lift → move → drop, tracking the LIVE target so the hand-off back to
    time-driven motion is seamless. `to` defaults to the live angle. */
export function armMoveTo(to: (() => number) | null, ms = 650, done?: () => void): void {
  const from = armAngle;
  const t0 = performance.now();
  const target = to || liveArmAngle;
  if (reducedMotion()) ms = Math.min(ms, 200);
  setLifted(true);
  overrideArm((now) => {
    const p = Math.min(1, (now - t0) / ms);
    /* 0–20% lifting, 20–80% swinging, 80–100% lowering */
    const m = p < 0.2 ? 0 : p > 0.8 ? 1 : (p - 0.2) / 0.6;
    const e = m < 0.5 ? 2 * m * m : 1 - Math.pow(-2 * m + 2, 2) / 2;
    if (p >= 0.85) setLifted(false);
    if (p >= 1) {
      overrideArm(null);
      if (done) done();
      return target();
    }
    return from + (target() - from) * e;
  });
}

/* ---------- the frame ---------- */

let lastAria = 0;

function frame(now: number): void {
  raf = 0;
  if (!running) return;
  const s0 = performance.now();

  if (spinOverride) platterAngle = spinOverride(now);
  else if (reducedMotion()) platterAngle = staticAngle;
  else platterAngle = timeAngle() + angleOffset;

  if (dragging) armAngle = dragAngle;
  else if (armOverride) armAngle = armOverride(now);
  else armAngle = liveArmAngle();

  const pt = 'rotate(' + (platterAngle % 360).toFixed(2) + 'deg)';
  if (elPlatter) elPlatter.style.transform = pt;
  if (elSpin) elSpin.style.transform = pt;
  if (elArm) elArm.style.transform = 'rotate(' + armAngle.toFixed(3) + 'deg)';
  if (elView) elView.classList.toggle('tt-playing', !pb.isPaused());

  if (now - lastAria > 500) {
    lastAria = now;
    updateAria();
  }

  const ms = performance.now() - s0;
  frames++;
  scriptMs += ms;
  if (ms > worstMs) worstMs = ms;
  raf = requestAnimationFrame(frame);
}

export function startMotion(): void {
  grab();
  staticAngle = timeAngle();
  platterAngle = timeAngle() + angleOffset;
  armAngle = liveArmAngle();
  if (running) return;
  running = true;
  raf = requestAnimationFrame(frame);
}

export function stopMotion(): void {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  dragging = false;
  spinOverride = null;
  armOverride = null;
  setLifted(false);
}

/** Playback jumped (seek, a new track): the reduced-motion record takes
    its new angle. */
export function noteJump(): void {
  staticAngle = timeAngle();
  if (reducedMotion()) platterAngle = staticAngle;
}

export function frameStats(): { frames: number; avgMs: number; worstMs: number } {
  return { frames: frames, avgMs: frames ? scriptMs / frames : 0, worstMs: worstMs };
}
export function resetFrameStats(): void {
  frames = 0;
  scriptMs = 0;
  worstMs = 0;
}

/** True for a moment after the listener dropped the needle, so the
    track-change that seek may cause does not re-animate the arm. */
export function seekedByHand(): boolean {
  return performance.now() - recentSeekAt < 800;
}

/* ---------- cue sides: gaps between songs as rings in the vinyl ---------- */

export function paintBands(): void {
  const box = document.getElementById('ttBands');
  if (!box) return;
  const side = pb.sideTracks();
  const d = pb.getDuration();
  if (side.length < 2 || !(d > 0)) {
    box.innerHTML = '';
    return;
  }
  let h = '';
  for (let i = 1; i < side.length; i++) {
    const t = side[i];
    if (t.kind !== 'virtual') continue;
    const r = radiusForAngle(armAngleFor(t.startSec / d));
    const p = (r / R_RECORD) * 50;
    h += '<i style="left:' + (50 - p).toFixed(3) + '%;top:' + (50 - p).toFixed(3) + '%;width:' + (2 * p).toFixed(3) + '%;height:' + (2 * p).toFixed(3) + '%"></i>';
  }
  box.innerHTML = h;
}

/* ---------- the tonearm as a slider ---------- */

function updateAria(): void {
  if (!elHead) return;
  const d = Math.max(0, Math.round(pb.getDuration()));
  const t = Math.max(0, Math.min(d, Math.round(dragging ? fracForArmAngle(dragAngle) * pb.getDuration() : pb.getTime())));
  elHead.setAttribute('aria-valuemax', String(d));
  elHead.setAttribute('aria-valuenow', String(t));
  const tr = pb.currentTrack();
  const side = tr && tr.kind === 'virtual' ? ' on this side' : '';
  elHead.setAttribute('aria-valuetext', fmtTime(t) + ' of ' + fmtTime(d) + side);
}

function stageAngleAt(clientX: number, clientY: number): number {
  const stage = document.querySelector('.tt-stage') as HTMLElement | null;
  if (!stage) return armAngle;
  const r = stage.getBoundingClientRect();
  const u = r.width / STAGE_W;
  const x = (clientX - r.left) / u;
  const y = (clientY - r.top) / u;
  return (Math.atan2(y - PIVOT.y, x - PIVOT.x) * 180) / Math.PI;
}

function clampGroove(deg: number): number {
  const lo = Math.min(OUTER_DEG, INNER_DEG);
  const hi = Math.max(OUTER_DEG, INNER_DEG);
  return Math.max(lo, Math.min(hi, deg));
}

export function seekFraction(frac: number): void {
  const d = pb.getDuration();
  if (!(d > 0)) return;
  recentSeekAt = performance.now();
  pb.seek(Math.max(0, Math.min(1, frac)) * d);
  noteJump();
}

export function seekBy(sec: number): void {
  const d = pb.getDuration();
  if (!(d > 0)) return;
  recentSeekAt = performance.now();
  pb.seek(Math.max(0, Math.min(d - 0.25, pb.getTime() + sec)));
  noteJump();
  updateAria();
}

let grabOffset = 0;
let pointerId = -1;
let dragMoved = false;

export function wireArmInput(): void {
  const view = document.getElementById('npview');
  if (!view) return;
  view.addEventListener('pointerdown', (e) => {
    const head = (e.target as Element).closest('#ttHead') as HTMLElement | null;
    if (!head || !running || !pb.currentTrack()) return;
    e.preventDefault();
    pointerId = e.pointerId;
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    grab();
    dragging = true;
    dragMoved = false;
    armOverride = null;
    grabOffset = stageAngleAt(e.clientX, e.clientY) - armAngle;
    dragAngle = clampGroove(armAngle);
    setLifted(true);
    head.focus({ preventScroll: true });
  });
  view.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const a = clampGroove(stageAngleAt(e.clientX, e.clientY) - grabOffset);
    if (Math.abs(a - dragAngle) > 0.02) dragMoved = true;
    dragAngle = a;
  });
  const drop = (e: PointerEvent, commit: boolean): void => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    const at = dragAngle;
    /* The needle comes down where it was let go: hold the arm there while
       the seek lands, then time takes over again. */
    if (commit && dragMoved) {
      armAngle = at;
      seekFraction(fracForArmAngle(at));
    }
    setTimeout(() => setLifted(false), 90);
    updateAria();
  };
  view.addEventListener('pointerup', (e) => drop(e, true));
  view.addEventListener('pointercancel', (e) => drop(e, false));

  /* Arrow keys on the focused tonearm: ±5 s (PageUp/PageDown ±30 s,
     Home/End the start and end). Registered on window in the capture
     phase so it runs before the app-wide shortcut handler, which would
     otherwise seek the same keys a second time. */
  window.addEventListener(
    'keydown',
    (e) => {
      if (!running || !(e.target instanceof Element) || !e.target.closest('#ttHead')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seekBy(-5);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seekBy(5);
      else if (e.key === 'PageDown') seekBy(-30);
      else if (e.key === 'PageUp') seekBy(30);
      else if (e.key === 'Home') seekFraction(0);
      else if (e.key === 'End') seekFraction(0.995);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
}
