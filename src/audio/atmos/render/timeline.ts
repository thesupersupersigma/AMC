/* Keyframe timeline and AudioParam scheduling for the renderer.
   AMC-original; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there). No Web Audio at import time.

   Keyframes arrive in absolute played frames (blockStartFrame + frame).
   Positions are piecewise linear between keyframes and hold after the last
   one. A later keyframe replaces every stored keyframe at or after its
   frame, so a new update can cut short a ramp that was sent earlier.

   Scheduling. The renderer keeps an anchor, "played frame F was at context
   time T", refreshed from setPlayedFrame whenever the prediction drifts by
   more than a tolerance (pause without suspend, seek, underrun, clock
   skew). Automation is scheduled up to a short horizon ahead: from "now",
   with the current value, then a linearRampToValueAtTime per keyframe. That
   is extended incrementally as time passes, and rescheduled from now only
   when the anchor moves or a push rewrites frames that were already
   scheduled. cancelAndHoldAtTime is not needed (Firefox lacks it); the
   current value is computed from the same timeline the automation follows. */

import type { SpatialKeyframe, SpatialPosition } from '../../spatial/contract';

export interface AbsoluteKeyframe {
  frame: number;
  positions: SpatialPosition[];
}

const EPS = 1e-6;

function samePosition(a: SpatialPosition, b: SpatialPosition): boolean {
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.z - b.z) < EPS &&
    Math.abs(a.gain - b.gain) < EPS &&
    Math.abs(a.size - b.size) < EPS
  );
}

export class KeyframeTimeline {
  readonly keyframes: AbsoluteKeyframe[] = [];

  constructor(readonly objects: number) {}

  /** Store keyframes of a block starting at `blockStartFrame`. Returns the
      first frame at which the stored path changed (Infinity if the push
      only extended it, or repeated what was there). */
  push(blockStartFrame: number, keyframes: SpatialKeyframe[]): number {
    let changedFrom = Infinity;
    const kfs = this.keyframes;
    for (const kf of keyframes) {
      const frame = blockStartFrame + kf.frame;
      // Keyframes at or after this frame are superseded.
      let i = kfs.length;
      while (i > 0 && kfs[i - 1].frame >= frame) i--;
      if (i < kfs.length) {
        const replaced = kfs[i];
        const identical =
          kfs.length - i === 1 &&
          replaced.frame === frame &&
          replaced.positions.length === kf.positions.length &&
          replaced.positions.every((p, o) => samePosition(p, kf.positions[o]));
        if (!identical) changedFrom = Math.min(changedFrom, frame);
        kfs.length = i;
      }
      kfs.push({ frame, positions: kf.positions });
    }
    return changedFrom;
  }

  /** Drop keyframes that can no longer matter before `frame` (keeps the
      last one at or before it). */
  prune(frame: number): void {
    const kfs = this.keyframes;
    let keepFrom = 0;
    while (keepFrom + 1 < kfs.length && kfs[keepFrom + 1].frame <= frame) keepFrom++;
    if (keepFrom > 0) kfs.splice(0, keepFrom);
  }

  clear(): void {
    this.keyframes.length = 0;
  }

  /** Position of object `obj` at `frame`, or null when there are no keyframes. */
  valueAt(obj: number, frame: number, out: SpatialPosition): SpatialPosition | null {
    const kfs = this.keyframes;
    if (kfs.length === 0) return null;
    let hi = 0;
    while (hi < kfs.length && kfs[hi].frame <= frame) hi++;
    if (hi === 0) return copy(kfs[0].positions[obj], out);
    if (hi === kfs.length) return copy(kfs[kfs.length - 1].positions[obj], out);
    const a = kfs[hi - 1];
    const b = kfs[hi];
    const pa = a.positions[obj];
    const pb = b.positions[obj];
    if (!pa || !pb) return copy(pa || pb, out);
    const t = (frame - a.frame) / (b.frame - a.frame);
    out.x = pa.x + (pb.x - pa.x) * t;
    out.y = pa.y + (pb.y - pa.y) * t;
    out.z = pa.z + (pb.z - pa.z) * t;
    out.gain = pa.gain + (pb.gain - pa.gain) * t;
    out.size = pa.size + (pb.size - pa.size) * t;
    return out;
  }
}

function copy(p: SpatialPosition | undefined, out: SpatialPosition): SpatialPosition | null {
  if (!p) return null;
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  out.gain = p.gain;
  out.size = p.size;
  return out;
}

/** One object's automation: the params it drives and how a position maps
    onto their values. */
export interface Track {
  params: AudioParam[];
  values(p: SpatialPosition, out: Float32Array): void;
  /** The mapping is nonlinear in position (panning gains): long moves are
      split into shorter ramps so the gain path follows the pan law. */
  nonlinear: boolean;
  /** Value of every param before any keyframe arrives. */
  initial: SpatialPosition;
}

/** Longest single ramp for nonlinear tracks, in seconds. */
const maxNonlinearRamp = 0.01;

export class TrackScheduler {
  private readonly scratch: Float32Array;
  private readonly pos: SpatialPosition = { x: 0, y: 0, z: 1, gain: 1, size: 0 };
  private readonly pos2: SpatialPosition = { x: 0, y: 0, z: 1, gain: 1, size: 0 };
  /** Last frame scheduled per track (Infinity = nothing scheduled yet). */
  private scheduledUntil = -Infinity;

  constructor(
    private readonly tracks: Track[],
    private readonly timeline: KeyframeTimeline,
    private readonly sampleRate: number
  ) {
    let max = 1;
    for (const t of tracks) max = Math.max(max, t.params.length);
    this.scratch = new Float32Array(max);
  }

  /** Set every param to its initial value at `time` (before any keyframes). */
  setInitial(time: number): void {
    for (const t of this.tracks) {
      t.values(t.initial, this.scratch);
      for (let i = 0; i < t.params.length; i++) {
        t.params[i].cancelScheduledValues(time);
        t.params[i].setValueAtTime(this.scratch[i], time);
      }
    }
  }

  /** Cancel what was scheduled and restart from `frame` at `time`. */
  rescheduleFrom(frame: number, time: number): void {
    for (let obj = 0; obj < this.tracks.length; obj++) {
      const t = this.tracks[obj];
      const p = this.timeline.valueAt(obj, frame, this.pos) ?? t.initial;
      t.values(p, this.scratch);
      for (let i = 0; i < t.params.length; i++) {
        const param = t.params[i];
        param.cancelScheduledValues(time);
        param.setValueAtTime(this.scratch[i], time);
      }
    }
    this.scheduledUntil = frame;
  }

  /** Schedule keyframes after what is already scheduled, up to `untilFrame`
      plus the first keyframe beyond it: a linear ramp is only defined once
      its end point is scheduled, so the ramp in progress at the horizon
      must be too. `frameToTime` maps played frames to context time. */
  extend(untilFrame: number, frameToTime: (frame: number) => number): void {
    const kfs = this.timeline.keyframes;
    let from = this.scheduledUntil;
    if (from === -Infinity) return;
    for (const kf of kfs) {
      if (kf.frame <= from) continue;
      this.rampSegment(from, kf.frame, frameToTime);
      from = kf.frame;
      if (kf.frame > untilFrame) break;
    }
    this.scheduledUntil = from;
  }

  get lastScheduledFrame(): number {
    return this.scheduledUntil;
  }

  private rampSegment(fromFrame: number, toFrame: number, frameToTime: (frame: number) => number): void {
    const maxSteps = Math.max(1, Math.ceil((toFrame - fromFrame) / (maxNonlinearRamp * this.sampleRate)));
    for (let obj = 0; obj < this.tracks.length; obj++) {
      const t = this.tracks[obj];
      const steps = t.nonlinear ? Math.min(maxSteps, this.stepsFor(obj, fromFrame, toFrame, maxSteps)) : 1;
      for (let s = 1; s <= steps; s++) {
        const frame = s === steps ? toFrame : fromFrame + ((toFrame - fromFrame) * s) / steps;
        const p = this.timeline.valueAt(obj, frame, this.pos) ?? t.initial;
        t.values(p, this.scratch);
        const time = frameToTime(frame);
        for (let i = 0; i < t.params.length; i++) t.params[i].linearRampToValueAtTime(this.scratch[i], time);
      }
    }
  }

  /** Steps needed so each covers at most ~15° of movement (or a gain/size
      change), capped at `max`. Small moves stay a single ramp. */
  private stepsFor(obj: number, fromFrame: number, toFrame: number, max: number): number {
    const a = this.timeline.valueAt(obj, fromFrame, this.pos);
    const b = this.timeline.valueAt(obj, toFrame, this.pos2);
    if (!a || !b) return 1;
    const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return Math.max(1, Math.min(max, Math.ceil(dist / 0.25)));
  }
}
