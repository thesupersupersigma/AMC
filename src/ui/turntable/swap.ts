/* The record swap, when the next track belongs to a DIFFERENT album (AMC's
   album key includes the folder, so two editions are two albums):

     0.00–0.42 s  the tonearm lifts and swings back to its rest post
     0.15–0.75 s  the platter spins down
     0.65–1.10 s  the old record slides off into its sleeve
     1.05–1.40 s  the sleeve slides out of frame
     1.40–1.75 s  the new album's sleeve slides in
     1.70–2.10 s  its record slides out onto the platter
     2.10–2.40 s  the platter spins up
     2.15–2.55 s  the tonearm swings over and drops into the groove

   Audio for the new track has already started — nothing here touches
   playback. A skip during a swap never queues another one: the incoming
   record is always the LATEST album, and if it is already on its way in,
   its sleeve and label simply switch to the latest.

   Reduced motion: a short crossfade instead. */

import * as pb from './playback';
import { C, DEG_PER_SEC, REST_DEG, R_RECORD, SLEEVE } from './geometry';
import {
  addFrameHook, armMoveTo, currentArmAngle, currentPlatterAngle, liveArmAngle, lockArm, overrideArm, overrideSpin, platterVelocity, reducedMotion,
  seatRecord, setLifted, unseatRecord,
} from './motion';

const T = {
  armBack: [0, 420],
  spinDown: [150, 750],
  recOff: [650, 1100],
  sleeveOut: [1050, 1400],
  sleeveIn: [1400, 1750],
  recOn: [1700, 2100],
  spinUp: [2100, 2400],
  armOver: [2150, 2550],
} as const;
export const SWAP_MS = 2550;

/* Offsets as percentages of each element's own size (transform % units),
   so no layout is ever read during the animation. */
const REC_TO_SLEEVE = ((SLEEVE.x - C.x) / (2 * R_RECORD)) * 100;
const SLEEVE_AWAY_U = -980;
const SLEEVE_AWAY = (SLEEVE_AWAY_U / SLEEVE.side) * 100;
const REC_AWAY = (SLEEVE_AWAY_U / (2 * R_RECORD)) * 100;

type Paint = (key: string) => void;

let running = false;
let targetKey = '';
let painted = false;
let paint: Paint = () => undefined;
let lastDone = 0;

export function swapRunning(): boolean {
  return running;
}
export function swapTarget(): string {
  return targetKey;
}
/** Diagnostics for tests: when the last swap finished (performance.now). */
export function lastSwapDone(): number {
  return lastDone;
}

function prog(now: number, t0: number, span: readonly [number, number]): number {
  return Math.max(0, Math.min(1, (now - t0 - span[0]) / (span[1] - span[0])));
}
function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function els(): { rec: HTMLElement | null; sleeve: HTMLElement | null; world: HTMLElement | null } {
  return { rec: document.getElementById('ttRec'), sleeve: document.getElementById('ttSleeve'), world: document.getElementById('ttWorld') };
}

function place(recX: number, sleeveX: number, sleeveTilt: number, fade = 1): void {
  const { rec, sleeve } = els();
  if (rec) rec.style.transform = recX ? 'translateX(' + recX.toFixed(3) + '%)' : '';
  if (sleeve) {
    sleeve.style.transform = sleeveX || sleeveTilt !== SLEEVE.tilt ? 'translateX(' + sleeveX.toFixed(3) + '%) rotate(' + sleeveTilt.toFixed(2) + 'deg)' : '';
    sleeve.style.opacity = fade < 1 ? fade.toFixed(3) : '';
  }
}

/** Starts a swap to `key`, or retargets the one already running. */
export function swapTo(key: string, painter: Paint): void {
  paint = painter;
  targetKey = key;
  if (running) {
    /* Rapid skips: the incoming record is always the latest album. Once it
       is already on screen, its sleeve and label switch in place. */
    if (painted) paint(targetKey);
    return;
  }
  if (reducedMotion()) {
    crossfade();
    return;
  }
  running = true;
  painted = false;
  lockArm(true);
  const t0 = performance.now();
  const { world } = els();

  /* 1. the arm lifts and swings back to its post */
  const armFrom = currentArmAngle();
  setLifted(true);
  overrideArm((now) => {
    const p = easeInOut(prog(now, t0, T.armBack));
    if (p >= 1) setLifted(false);
    return armFrom + (REST_DEG - armFrom) * p;
  });

  /* 2 + 7. the platter spins down, stands, spins back up — integrated from
     a velocity profile so it never jumps */
  const v0 = platterVelocity();
  let ang = currentPlatterAngle();
  let last = t0;
  overrideSpin((now) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    const e = now - t0;
    let v: number;
    if (e < T.spinDown[0]) v = v0;
    else if (e < T.spinDown[1]) v = v0 * (1 - prog(now, t0, T.spinDown));
    else if (e < T.spinUp[0]) v = 0;
    else v = liveVelocity() * easeOut(prog(now, t0, T.spinUp));
    ang += v * dt;
    return ang;
  });

  if (world) world.classList.add('tt-offcentre');
  armWaiting = true;
  let seated = false;
  addFrameHook((now) => {
    if (!running) return false;
    const e = now - t0;
    /* 3. record into its sleeve */
    if (e >= T.recOff[0] && e < T.sleeveOut[0]) {
      unseatRecord();
      place(REC_TO_SLEEVE * easeInOut(prog(now, t0, T.recOff)), 0, SLEEVE.tilt);
    }
    /* 4. sleeve (record inside) out of frame */
    if (e >= T.sleeveOut[0] && e < T.sleeveIn[0]) {
      const p = easeInOut(prog(now, t0, T.sleeveOut));
      place(REC_TO_SLEEVE + REC_AWAY * p, SLEEVE_AWAY * p, SLEEVE.tilt - 8 * p, 1 - 0.6 * p);
    }
    /* the new album goes into the sleeve while it is off stage */
    if (e >= T.sleeveIn[0] && !painted) {
      painted = true;
      paint(targetKey);
    }
    /* 5. the new sleeve slides in */
    if (e >= T.sleeveIn[0] && e < T.recOn[0]) {
      const p = 1 - easeOut(prog(now, t0, T.sleeveIn));
      place(REC_TO_SLEEVE + REC_AWAY * p, SLEEVE_AWAY * p, SLEEVE.tilt - 8 * p, 1 - 0.6 * p);
    }
    /* 6. its record slides out onto the platter */
    if (e >= T.recOn[0] && e < T.recOn[1]) {
      place(REC_TO_SLEEVE * (1 - easeInOut(prog(now, t0, T.recOn))), 0, SLEEVE.tilt);
    }
    if (e >= T.recOn[1] && !seated) {
      seated = true;
      place(0, 0, SLEEVE.tilt);
      seatRecord();
      if (world) world.classList.remove('tt-offcentre');
    }
    /* 8. the arm swings over and drops into the groove */
    if (e >= T.armOver[0] && armWaiting) {
      armWaiting = false;
      armMoveTo(liveArmAngle, T.armOver[1] - T.armOver[0], () => lockArm(false));
    }
    if (e >= SWAP_MS) {
      finish();
      return false;
    }
    return true;
  });
}

let armWaiting = false;

/* The speed the platter spins back up to: the playback rate's (the RPM
   control's), exactly what time-driven motion continues with. */
function liveVelocity(): number {
  if (pb.isPaused() || reducedMotion()) return 0;
  return DEG_PER_SEC * pb.getRate();
}

function finish(): void {
  const { world } = els();
  running = false;
  lockArm(false);
  painted = false;
  armWaiting = false;
  overrideSpin(null);
  seatRecord();
  place(0, 0, SLEEVE.tilt);
  if (world) world.classList.remove('tt-offcentre');
  lastDone = performance.now();
}

/** Reduced motion: fade the record and sleeve out, change album, fade in. */
function crossfade(): void {
  running = true;
  painted = false;
  const { rec, sleeve } = els();
  for (const el of [rec, sleeve]) if (el) el.style.transition = 'opacity .18s ease';
  for (const el of [rec, sleeve]) if (el) el.style.opacity = '0';
  setTimeout(() => {
    painted = true;
    paint(targetKey);
    for (const el of [rec, sleeve]) if (el) el.style.opacity = '';
    setTimeout(() => {
      for (const el of [rec, sleeve]) if (el) el.style.transition = '';
      running = false;
      painted = false;
      lastDone = performance.now();
    }, 200);
  }, 200);
}

/** Leaving the mode mid-swap: put everything back where it rests. */
export function cancelSwap(): void {
  if (!running) return;
  running = false;
  lockArm(false);
  painted = false;
  armWaiting = false;
  place(0, 0, SLEEVE.tilt);
  const { world, rec, sleeve } = els();
  if (world) world.classList.remove('tt-offcentre');
  for (const el of [rec, sleeve]) if (el) {
    el.style.opacity = '';
    el.style.transition = '';
  }
}
