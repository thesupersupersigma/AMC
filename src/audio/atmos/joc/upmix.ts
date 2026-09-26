/* Bed/object split, LFE routing and OAMD timing for one decoded frame.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Renderers/EnhancedAC3Renderer.cs (RenderNextTimeslot,
           Update: JOC input mapping, LFE handling, OAMD object ↔ JOC object
           mapping), ObjectAudioMetadata.UpdateSources and
           OAElementMD.UpdateSources (info block timing and ramps)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   What Cavern does per 64-sample timeslot with Source objects, this does
   per frame with data:
   - JOC inputs are the core's FL FR FC SL SR (and RL RR for 7-channel JOC),
     looked up by channel, not position (Cavern's inputMatrix mapping).
   - The LFE is not a JOC input. Cavern plays the core LFE as the OAMD
     object at GetLFEPosition(); here it becomes the bed. It is delayed by
     the QMF round trip so it stays aligned with the objects (DEVIATION:
     Cavern leaves it early), and it carries its OAMD gain.
   - OAMD objects map to JOC objects in order, skipping the LFE.
   - Speaker-anchored (bed) OAMD objects are JOC objects pinned to their bed
     channel position (ChannelPrototype.AlternativePositions).
   - Each info block starts at (EMDF sample offset + block offset) and ramps
     to its targets over its ramp duration. Cavern moves Sources a timeslot
     at a time (Vector3.Lerp by 64/remaining). Here the same piecewise-linear
     path becomes keyframes on the output timeline, QMF delay included
     (DEVIATION: Cavern applies each frame's update one timeslot early and
     ignores the QMF delay; see docs/atmos/PLAN.md §6.9). */

import type { SpatialKeyframe, SpatialPosition } from '../../spatial/contract';
import type { ExtensibleMetadataDecoder } from '../bitstream/emdf';
import { subbands } from '../bitstream/joc-tables';
import { alternativePositions, defaultObjectGain, type ObjectTarget } from '../bitstream/oamd';
import { JointObjectCodingApplier } from './applier';
import { maxJocChannels } from './matrix';

/** Delay of QMF analysis + synthesis, in samples (measured by test/atmos/qmf.test.ts). */
export const qmfDelay = 577; // analysisHistory + 1

/** FFmpeg channel order of the decoded core, by channel count. */
const coreLayouts: Record<number, string[]> = {
  6: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  8: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};
/** JOC input channel order (JointObjectCodingTables.inputMatrix) as core labels. */
const jocInputLabels = ['FL', 'FR', 'FC', 'SL', 'SR', 'BL', 'BR'];
/** ChannelPrototype.AlternativePositions of those channels (BL/BR = RearLeft/RearRight). */
const fallbackPositions: Record<string, [number, number, number]> = {
  FL: [-1, 0, 1],
  FR: [1, 0, 1],
  FC: [0, 0, 1],
  SL: [-1, 0, 0],
  SR: [1, 0, 0],
  BL: [-1, 0, -1],
  BR: [1, 0, -1],
};

/** A fixed delay of `delay` samples across frames. */
class DelayLine {
  private readonly hist: Float32Array;
  constructor(private readonly delay: number) {
    this.hist = new Float32Array(delay);
  }
  /** out[n] = input[n − delay] (history first), times a gain ramped g0 → g1. */
  process(input: Float32Array | null, length: number, out: Float32Array, g0: number, g1: number): void {
    const hist = this.hist;
    const d = this.delay;
    const step = (g1 - g0) / length;
    for (let n = 0; n < length; n++) {
      const src = n < d ? hist[n] : input ? input[n - d] : 0;
      out[n] = src * (g0 + step * n);
    }
    if (length >= d) {
      if (input) hist.set(input.subarray(length - d, length));
      else hist.fill(0);
    } else {
      hist.copyWithin(0, length);
      if (input) hist.set(input.subarray(0, length), d - length);
      else hist.fill(0, d - length);
    }
  }
  reset(): void {
    this.hist.fill(0);
  }
}

/** One object's piecewise-linear path: from (t0, p0) to (t1, p1), then held. */
interface Path {
  t0: number;
  x0: number;
  y0: number;
  z0: number;
  t1: number;
  x1: number;
  y1: number;
  z1: number;
  /** Gain/size in effect before t0 and from t1 on (ramped in between). */
  g0: number;
  s0: number;
  g1: number;
  s1: number;
  placed: boolean;
}

export interface UpmixOptions {
  sampleRate: number;
  coreChannels: number;
  /** Object channels the output carries (maxChannels − 1 bed channel). */
  objectChannels: number;
  frameSize: number;
  cavernCompat: boolean;
}

export class JocUpmix {
  readonly applier: JointObjectCodingApplier;
  private readonly inputIndex: number[];
  private readonly lfeIndex: number;
  private readonly inputs: (Float32Array | null)[] = [];
  private readonly objOut: Float32Array[] = [];
  /** The core LFE, delayed by the QMF round trip. */
  private readonly lfeDelay = new DelayLine(qmfDelay);
  /** Core channels for the channel-based fallback, same delay. */
  private readonly fallbackDelays: DelayLine[] = [];
  private lfeGain: number = defaultObjectGain;
  private lfeGainApplied: number = defaultObjectGain;
  /** The current frame came from the channel-based fallback. */
  private inFallback = false;
  /** Absolute output sample index of the next frame's first sample. */
  private outFrame = 0;
  private readonly targets: ObjectTarget[] = [];
  private readonly paths: Path[] = [];
  private readonly breakpoints: number[] = [];
  /** Frames where the stream had more JOC objects than output channels. */
  droppedObjectFrames = 0;

  constructor(private readonly opts: UpmixOptions) {
    this.applier = new JointObjectCodingApplier(opts.frameSize, opts.cavernCompat, opts.objectChannels);
    const layout = coreLayouts[opts.coreChannels] ?? coreLayouts[6];
    this.inputIndex = jocInputLabels.map((l) => layout.indexOf(l));
    this.lfeIndex = layout.indexOf('LFE');
    for (let ch = 0; ch < maxJocChannels; ch++) this.fallbackDelays.push(new DelayLine(qmfDelay));
    for (let i = 0; i < 64 + 1; i++) {
      this.targets.push({ x: 0, y: 0, z: 1, gain: defaultObjectGain, size: 0 });
      this.paths.push({ t0: 0, x0: 0, y0: 0, z0: 1, t1: 0, x1: 0, y1: 0, z1: 1, g0: 0, s0: 0, g1: 0, s1: 0, placed: false });
    }
  }

  /** Upmix one frame. `out[0]` receives the LFE bed, `out[1 + i]` JOC object
      i. Returns this frame's keyframes (frame offsets relative to its start). */
  processFrame(core: Float32Array[], length: number, ext: ExtensibleMetadataDecoder, out: Float32Array[]): SpatialKeyframe[] {
    const joc = ext.joc;
    const objectChannels = this.opts.objectChannels;
    const objects = Math.min(joc.objectCount, objectChannels);
    if (joc.objectCount > objectChannels) this.droppedObjectFrames++;

    // JOC inputs by channel.
    for (let ch = 0; ch < maxJocChannels; ch++) {
      const idx = this.inputIndex[ch];
      this.inputs[ch] = idx >= 0 && idx < core.length ? core[idx] : null;
    }
    this.applier.loadFrame(this.inputs, length);
    const objOut = this.objOut;
    for (let i = 0; i < objectChannels; i++) objOut[i] = out[1 + i];
    for (let ts = 0, timeslots = length / subbands; ts < timeslots; ts++) {
      this.applier.apply(ts, joc, objOut, ts * subbands, objectChannels);
    }
    // Keep the fallback delay lines current so a later switch is seamless.
    for (let ch = 0; ch < maxJocChannels; ch++) this.fallbackDelays[ch].process(this.inputs[ch], length, this.scratchOut(length), 0, 0);
    this.inFallback = false;

    const keyframes = this.updateObjects(ext, objects);
    this.writeBed(core, length, out[0]);
    this.outFrame += length;
    return keyframes;
  }

  /** Cavern's channel-based fallback (EnhancedAC3Renderer.RenderNextTimeslot,
      "fallback to it when OAMD or JOC can't be decoded"): before the first
      JOC payload, the core's JOC input channels play as objects pinned to
      their speaker positions. Same delay as the object path, same channel
      count as a JOC frame. */
  processFallbackFrame(core: Float32Array[], length: number, out: Float32Array[]): SpatialKeyframe[] {
    const objectChannels = this.opts.objectChannels;
    for (let ch = 0; ch < maxJocChannels; ch++) {
      const idx = this.inputIndex[ch];
      this.inputs[ch] = idx >= 0 && idx < core.length ? core[idx] : null;
    }
    this.applier.loadFrame(this.inputs, length); // keeps the analysis history current
    for (let i = 0; i < objectChannels; i++) {
      if (i < maxJocChannels) this.fallbackDelays[i].process(this.inputs[i], length, out[1 + i], 1, 1);
      else out[1 + i].fill(0, 0, length);
    }
    this.writeBed(core, length, out[0]);
    const keyframes: SpatialKeyframe[] = [];
    if (!this.inFallback) {
      const positions: SpatialPosition[] = [];
      for (let i = 0; i < objectChannels; i++) {
        const label = jocInputLabels[i];
        const pos = label ? fallbackPositions[label] : null;
        positions.push(pos && this.inputs[i]
          ? { x: pos[0], y: pos[1], z: pos[2], size: 0, gain: defaultObjectGain }
          : { x: 0, y: 0, z: 1, size: 0, gain: 0 });
      }
      keyframes.push({ frame: 0, positions });
      for (const p of this.paths) p.placed = false;
    }
    this.inFallback = true;
    this.outFrame += length;
    return keyframes;
  }

  private scratch = new Float32Array(0);
  private scratchOut(length: number): Float32Array {
    if (this.scratch.length < length) this.scratch = new Float32Array(length);
    return this.scratch;
  }

  /** LFE bed: the core LFE, delayed by the QMF round trip, times its OAMD
      gain (ramped across the frame when it changes). */
  private writeBed(core: Float32Array[], length: number, bed: Float32Array): void {
    const lfe = this.lfeIndex >= 0 && this.lfeIndex < core.length ? core[this.lfeIndex] : null;
    this.lfeDelay.process(lfe, length, bed, this.lfeGainApplied, this.lfeGain);
    this.lfeGainApplied = this.lfeGain;
  }

  private evalPath(p: Path, t: number, out: SpatialPosition): void {
    if (!p.placed) {
      out.x = 0;
      out.y = 0;
      out.z = 1;
      out.gain = 0;
      out.size = 0;
      return;
    }
    if (t >= p.t1) {
      out.x = p.x1;
      out.y = p.y1;
      out.z = p.z1;
      out.gain = p.g1;
      out.size = p.s1;
    } else if (t <= p.t0) {
      out.x = p.x0;
      out.y = p.y0;
      out.z = p.z0;
      out.gain = p.g0;
      out.size = p.s0;
    } else {
      const a = (t - p.t0) / (p.t1 - p.t0);
      out.x = p.x0 + (p.x1 - p.x0) * a;
      out.y = p.y0 + (p.y1 - p.y0) * a;
      out.z = p.z0 + (p.z1 - p.z0) * a;
      out.gain = p.g0 + (p.g1 - p.g0) * a;
      out.size = p.s0 + (p.s1 - p.s0) * a;
    }
  }

  /** Apply this frame's OAMD info blocks to the object paths and emit
      keyframes at every path breakpoint they create. */
  private updateObjects(ext: ExtensibleMetadataDecoder, objects: number): SpatialKeyframe[] {
    const oamd = ext.oamd;
    const objectChannels = this.opts.objectChannels;
    const bps = this.breakpoints;
    bps.length = 0;
    const scratch: SpatialPosition = { x: 0, y: 0, z: 1, size: 0, gain: 0 };

    if (ext.hasOAMD && oamd.objectCount > 0) {
      const lfePos = oamd.getLFEPosition();
      const statics = oamd.getStaticChannels();
      // UpdateSources applies one element: the last object element whose
      // first update is due (Cavern re-picks per timeslot; one frame's
      // worth of timeslots ends on the last one).
      let element = -1;
      for (let i = oamd.elements.length - 1; i >= 0; --i) {
        if (oamd.elements[i].minOffset >= 0) {
          element = i;
          break;
        }
      }
      if (element >= 0) {
        const el = oamd.elements[element];
        const delay = qmfDelay;
        for (let blk = 0; blk < el.rampDuration.length; blk++) {
          const start = this.outFrame + oamd.offset + el.blockOffsetFactor[blk] + delay;
          const ramp = el.rampDuration[blk];
          let any = false;
          for (let o = 0; o < el.infoBlocks.length && o < this.targets.length; o++) {
            const block = el.infoBlocks[o][blk];
            const target = this.targets[o];
            block.resolve(target);
            if (o === lfePos) {
              this.lfeGain = target.gain;
              continue;
            }
            const channel = lfePos >= 0 && o > lfePos ? o - 1 : o; // JOC object index
            if (channel >= objects) continue;
            const path = this.paths[channel];
            let x = target.x;
            let y = target.y;
            let z = target.z;
            const isBed = o < oamd.beds;
            if (isBed) {
              const pos = alternativePositions[statics[o]] ?? alternativePositions[2];
              x = pos[0];
              y = pos[1];
              z = pos[2];
            } else if (!block.validPosition) {
              // Position unchanged: only gain/size may move.
              this.evalPath(path, start, scratch);
              x = scratch.x;
              y = scratch.y;
              z = scratch.z;
            }
            this.evalPath(path, start, scratch);
            if (!path.placed) {
              path.placed = true;
              path.t0 = start;
              path.t1 = start;
              path.x0 = path.x1 = x;
              path.y0 = path.y1 = y;
              path.z0 = path.z1 = z;
              path.g0 = path.g1 = target.gain;
              path.s0 = path.s1 = target.size;
            } else if (ramp <= 0 && this.opts.cavernCompat) {
              // Cavern: a zero-length ramp never moves the Source
              // (futureDistance <= 0). DEVIATION otherwise: jump.
              continue;
            } else {
              path.t0 = start;
              path.x0 = scratch.x;
              path.y0 = scratch.y;
              path.z0 = scratch.z;
              path.g0 = scratch.gain;
              path.s0 = scratch.size;
              path.t1 = start + Math.max(ramp, 0);
              path.x1 = x;
              path.y1 = y;
              path.z1 = z;
              path.g1 = target.gain;
              path.s1 = Math.min(1, target.size);
            }
            any = true;
          }
          if (any) {
            bps.push(start);
            if (ramp > 0) bps.push(start + ramp);
          }
        }
      }
    }

    // A keyframe at every breakpoint, with every object sampled there.
    bps.sort((a, b) => a - b);
    const keyframes: SpatialKeyframe[] = [];
    let last = -Infinity;
    for (const t of bps) {
      if (t === last) continue;
      last = t;
      const positions: SpatialPosition[] = [];
      for (let ch = 0; ch < objectChannels; ch++) {
        const p: SpatialPosition = { x: 0, y: 0, z: 1, size: 0, gain: 0 };
        if (ch < objects) this.evalPath(this.paths[ch], t, p);
        positions.push(p);
      }
      keyframes.push({ frame: t - this.outFrame, positions });
    }
    return keyframes;
  }

  /** Seek / track change: filters, matrices, paths and timeline restart. */
  reset(): void {
    this.applier.reset();
    this.lfeDelay.reset();
    for (const d of this.fallbackDelays) d.reset();
    this.inFallback = false;
    this.outFrame = 0;
    for (const p of this.paths) p.placed = false;
    for (const t of this.targets) {
      t.x = 0;
      t.y = 0;
      t.z = 1;
      t.gain = defaultObjectGain;
      t.size = 0;
    }
    this.lfeGain = defaultObjectGain;
    this.lfeGainApplied = defaultObjectGain;
  }
}
