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

import type { AnyTrack } from '../../types';
import { S } from '../../state';
import { esc, fmtTime } from '../../util';
import * as pb from './playback';
import {
  ARM_L, DEG_PER_SEC, INNER_DEG, OUTER_DEG, PIVOT, R_RECORD, REST_DEG, STAGE_W, armAngleFor, fracForArmAngle, pctX, pctY, radiusForAngle,
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

/** The record turns with the platter (plus a fixed offset) while seated;
    lifted off for a swap it keeps the angle it had. */
let recordOffset = 0;
let recordFree: number | null = null;

/** Per-frame callbacks (the record swap); return false when finished. */
const frameHooks: Array<(now: number) => boolean> = [];
export function addFrameHook(fn: (now: number) => boolean): void {
  frameHooks.push(fn);
  if (running && !raf) raf = requestAnimationFrame(frame);
}
export function frameHookCount(): number {
  return frameHooks.length;
}

export function unseatRecord(): void {
  if (recordFree === null) recordFree = platterAngle + recordOffset;
}
export function seatRecord(): void {
  if (recordFree !== null) recordOffset = recordFree - platterAngle;
  recordFree = null;
}

let armAngle = REST_DEG;
let armOverride: ((now: number) => number) | null = null;
let dragging = false;
/** The record swap owns the arm while it runs. */
let armLocked = false;
export function lockArm(on: boolean): void {
  armLocked = on;
}
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
  if (reducedMotion()) {
    /* no swing: the arm is simply where it belongs */
    overrideArm(null);
    setLifted(false);
    if (done) done();
    return;
  }
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

  for (let i = 0; i < frameHooks.length; i++) {
    if (!frameHooks[i](now)) frameHooks.splice(i--, 1);
  }

  const recAngle = recordFree !== null ? recordFree : platterAngle + recordOffset;
  if (elPlatter) elPlatter.style.transform = 'rotate(' + (platterAngle % 360).toFixed(2) + 'deg)';
  if (elSpin) elSpin.style.transform = 'rotate(' + (recAngle % 360).toFixed(2) + 'deg)';
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
  if (spinOverride) overrideSpin(null);
  armOverride = null;
  frameHooks.length = 0;
  armLocked = false;
  seatRecord();
  setLifted(false);
}

/** The platter's current angular velocity, in degrees per second. */
export function platterVelocity(): number {
  if (spinOverride || reducedMotion() || pb.isPaused()) return 0;
  return DEG_PER_SEC * pb.getRate();
}

export function isDragging(): boolean {
  return dragging;
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

/* ---------- songs on the record ----------
   A cue-split vinyl side: its songs sit where they really are in the
   file. A normal album (one file per song): holding Shift while dragging
   treats the record as the whole album, songs laid out by length, so the
   needle can be dropped onto any of them — like picking a track on an LP. */

export interface SongMark {
  /** Where the song starts, as a fraction of the record. */
  frac: number;
  track: AnyTrack;
  /** 1-based position on the record. */
  n: number;
}

export function songMarks(): { kind: 'side' | 'album'; marks: SongMark[] } | null {
  const cur = pb.currentTrack();
  if (!cur) return null;
  const side = pb.sideTracks(cur);
  const d = pb.getDuration();
  if (cur.kind === 'virtual' && side.length >= 2 && d > 0) {
    return { kind: 'side', marks: side.map((t, i) => ({ frac: t.kind === 'virtual' ? t.startSec / d : 0, track: t, n: i + 1 })) };
  }
  const al = S.albumMap[cur.coverKey];
  const list = al ? al.tracks.filter((t) => !!t.file) : [];
  if (list.length < 2) return null;
  const lens = list.map((t) => (t.duration > 0 ? t.duration : 0));
  const known = lens.every((x) => x > 0);
  const total = known ? lens.reduce((a, b) => a + b, 0) : list.length;
  let acc = 0;
  return {
    kind: 'album',
    marks: list.map((t, i) => {
      const m = { frac: acc / total, track: t, n: i + 1 };
      acc += known ? lens[i] : 1;
      return m;
    }),
  };
}

function ringsHTML(fracs: number[]): string {
  let h = '';
  for (const f of fracs) {
    const r = radiusForAngle(armAngleFor(f));
    const p = (r / R_RECORD) * 50;
    h += '<i style="left:' + (50 - p).toFixed(3) + '%;top:' + (50 - p).toFixed(3) + '%;width:' + (2 * p).toFixed(3) + '%;height:' + (2 * p).toFixed(3) + '%"></i>';
  }
  return h;
}

/** Cue sides: the gaps between songs as smooth rings in the vinyl. */
export function paintBands(): void {
  const box = document.getElementById('ttBands');
  if (!box) return;
  box.classList.remove('tt-bands-album');
  const m = songMarks();
  box.innerHTML = m && m.kind === 'side' ? ringsHTML(m.marks.slice(1).map((x) => x.frac)) : '';
}

/** While Shift-dragging on a normal album, the album's songs show as
    bands too; they go away with the Shift key. */
function paintAlbumBands(marks: SongMark[] | null): void {
  const box = document.getElementById('ttBands');
  if (!box) return;
  if (!marks) {
    paintBands();
    return;
  }
  box.classList.add('tt-bands-album');
  box.innerHTML = ringsHTML(marks.slice(1).map((x) => x.frac));
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
let rawDragAngle = 0;
let shiftHeld = false;
let snapTarget: SongMark | null = null;
let dragMarks: { kind: 'side' | 'album'; marks: SongMark[] } | null = null;

/* The label that rides beside the stylus while the arm is held: where the
   needle will land (time, or the song it snaps to). */
function showDragLabel(): void {
  const el = document.getElementById('ttSnap');
  if (!el) return;
  const t = (dragAngle * Math.PI) / 180;
  el.style.left = pctX(PIVOT.x + ARM_L * Math.cos(t));
  el.style.top = pctY(PIVOT.y + ARM_L * Math.sin(t));
  let main = '';
  let hint = '';
  if (snapTarget) {
    main = snapTarget.n + ' · ' + esc(snapTarget.track.title);
    hint = dragMarks && dragMarks.kind === 'album' ? 'drop to play this song' : 'drop at the start of this song';
  } else {
    const d = pb.getDuration();
    const at = fracForArmAngle(dragAngle) * d;
    const cur = pb.currentTrack();
    if (cur && cur.kind === 'virtual' && dragMarks && dragMarks.kind === 'side') {
      let holder = dragMarks.marks[0];
      for (const m of dragMarks.marks) if (m.frac * d <= at + 0.01) holder = m;
      const start = holder.track.kind === 'virtual' ? holder.track.startSec : 0;
      main = esc(holder.track.title) + ' · ' + fmtTime(at - start);
    } else {
      main = fmtTime(at) + ' / ' + fmtTime(d);
    }
    if (dragMarks) hint = 'hold ⇧ Shift to snap to songs';
  }
  el.innerHTML = main + (hint ? '<small>' + hint + '</small>' : '');
  el.hidden = false;
}

function hideDragLabel(): void {
  const el = document.getElementById('ttSnap');
  if (el) el.hidden = true;
}

/** Applies Shift snapping to the raw drag angle. */
function resolveDrag(): void {
  const snapping = shiftHeld && !!dragMarks;
  if (snapping && dragMarks) {
    const f = fracForArmAngle(rawDragAngle);
    let best = dragMarks.marks[0];
    for (const m of dragMarks.marks) if (Math.abs(m.frac - f) < Math.abs(best.frac - f)) best = m;
    snapTarget = best;
    dragAngle = armAngleFor(best.frac);
  } else {
    snapTarget = null;
    dragAngle = rawDragAngle;
  }
  if (dragMarks && dragMarks.kind === 'album') paintAlbumBands(snapping ? dragMarks.marks : null);
  if (snapping) dragMoved = true;
  showDragLabel();
}

export function wireArmInput(): void {
  const view = document.getElementById('npview');
  if (!view) return;
  view.addEventListener('pointerdown', (e) => {
    const head = (e.target as Element).closest('#ttHead') as HTMLElement | null;
    if (!head || !running || armLocked || !pb.currentTrack()) return;
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
    rawDragAngle = clampGroove(armAngle);
    dragAngle = rawDragAngle;
    shiftHeld = e.shiftKey;
    dragMarks = songMarks();
    setLifted(true);
    head.focus({ preventScroll: true });
    resolveDrag();
  });
  view.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const a = clampGroove(stageAngleAt(e.clientX, e.clientY) - grabOffset);
    if (Math.abs(a - rawDragAngle) > 0.02) dragMoved = true;
    rawDragAngle = a;
    shiftHeld = e.shiftKey;
    resolveDrag();
  });
  const drop = (e: PointerEvent, commit: boolean): void => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    const at = dragAngle;
    const target = snapTarget;
    const marks = dragMarks;
    snapTarget = null;
    dragMarks = null;
    hideDragLabel();
    if (marks && marks.kind === 'album') paintBands();
    /* The needle comes down where it was let go: hold the arm there while
       the seek lands, then time takes over again. */
    if (commit && target && marks) {
      armAngle = at;
      if (marks.kind === 'side') {
        recentSeekAt = performance.now();
        pb.seek(target.track.kind === 'virtual' ? target.track.startSec : 0);
        noteJump();
      } else if (target.track === pb.currentTrack()) {
        seekFraction(0);
      } else {
        /* another song of the album: it starts, and the arm lifts from
           where it was dropped to that song's first groove */
        pb.playTrack(target.track);
      }
    } else if (commit && dragMoved) {
      armAngle = at;
      seekFraction(fracForArmAngle(at));
    }
    setTimeout(() => setLifted(false), 90);
    updateAria();
  };
  view.addEventListener('pointerup', (e) => drop(e, true));
  view.addEventListener('pointercancel', (e) => drop(e, false));

  /* Shift pressed or released mid-drag, without moving: snap now. */
  const shiftKey = (e: KeyboardEvent): void => {
    if (!dragging || e.key !== 'Shift') return;
    shiftHeld = e.type === 'keydown';
    resolveDrag();
  };
  window.addEventListener('keydown', shiftKey, true);
  window.addEventListener('keyup', shiftKey, true);

  /* Arrow keys on the focused tonearm: ±5 s (PageUp/PageDown ±30 s,
     Home/End the start and end; Shift+←/→ the previous/next song). Registered on window in the capture
     phase so it runs before the app-wide shortcut handler, which would
     otherwise seek the same keys a second time. */
  window.addEventListener(
    'keydown',
    (e) => {
      if (!running || armLocked || !(e.target instanceof Element) || !e.target.closest('#ttHead')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      /* Shift+←/→ is the app's previous/next song — on a cue side that is
         the next band on the record — so it passes through. */
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
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
