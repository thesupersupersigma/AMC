/* The turntable's drawing, in stage units. The stage is 1500 × 760 units
   and scales as a whole (CSS container units), so every position and
   angle below holds at any size — 1365 × 611 on the Chromebook or a
   desktop monitor.

   Proportions follow a real direct-drive deck: a 12" record (302 mm) on a
   332 mm platter, a 230 mm tonearm whose pivot sits 215 mm from the
   spindle. The stylus sweeps ~22° from the lead-in groove to the run-out,
   as a real arm does. */

export const STAGE_W = 1500;
export const STAGE_H = 760;

/** Plinth rectangle. */
export const DECK = { x: 520, y: 20, w: 960, h: 720, r: 30 };

/** Platter centre and radii. */
export const C = { x: 900, y: 380 };
export const R_PLATTER = 318;
export const R_RECORD = 292;
export const R_LABEL = 98;
export const R_SPINDLE = 7;
/** Where the stylus sits at 0:00 (just inside the lead-in) and at the end
    (the run-out groove). */
export const R_OUTER_GROOVE = 282;
export const R_INNER_GROOVE = 122;

/** Tonearm pivot and effective length (pivot → stylus). */
export const PIVOT = { x: 1260, y: 184 };
export const ARM_L = 440;
/** Parked on the rest post, clear of the platter. */
export const REST_DEG = 88;

/** The leaning sleeve: centre, side, tilt. */
export const SLEEVE = { x: 300, y: 380, side: 600, tilt: -3 };

const D_X = PIVOT.x - C.x;
const D_Y = PIVOT.y - C.y;
const D = Math.hypot(D_X, D_Y);
const PHI = Math.atan2(D_Y, D_X);

/** Arm angle (degrees, screen space: 0 = pointing right, clockwise
    positive) that puts the stylus on radius `r` of the record. The branch
    is the one that swings the arm in from its rest post. */
export function angleForRadius(r: number): number {
  const c = (r * r - D * D - ARM_L * ARM_L) / (2 * ARM_L * D);
  const a = Math.acos(Math.max(-1, Math.min(1, c)));
  return ((PHI + a) * 180) / Math.PI;
}

/** Radius the stylus is at for an arm angle. */
export function radiusForAngle(deg: number): number {
  const t = (deg * Math.PI) / 180;
  return Math.hypot(D_X + ARM_L * Math.cos(t), D_Y + ARM_L * Math.sin(t));
}

export const OUTER_DEG = angleForRadius(R_OUTER_GROOVE);
export const INNER_DEG = angleForRadius(R_INNER_GROOVE);

/** Tonearm angle for a fraction of the side played: linear in angle from
    the outer groove (0) to the inner groove (1). */
export function armAngleFor(frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return OUTER_DEG + (INNER_DEG - OUTER_DEG) * f;
}

/** Inverse of armAngleFor, clamped to the groove range. */
export function fracForArmAngle(deg: number): number {
  const f = (deg - OUTER_DEG) / (INNER_DEG - OUTER_DEG);
  return Math.max(0, Math.min(1, f));
}

/** 33⅓ RPM, the nominal speed of a 12" LP: 200° of platter per second of
    playback at 1×. */
export const NOMINAL_RPM = 100 / 3;
export const DEG_PER_SEC = (NOMINAL_RPM / 60) * 360;

/** Stage-unit percentages for inline styles. */
export function pctX(u: number): string {
  return ((u / STAGE_W) * 100).toFixed(4) + '%';
}
export function pctY(u: number): string {
  return ((u / STAGE_H) * 100).toFixed(4) + '%';
}
