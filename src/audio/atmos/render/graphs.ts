/* Web Audio graphs for the three output modes. AMC-original; distributed
   under the Cavern licence as part of src/audio/atmos/ (see README.md
   there). Only called from createAtmosRenderer, never at import time.

   Every graph hangs off the renderer's ChannelSplitter (one mono output per
   bed/object channel) and ends in its own `fade` GainNode, so two graphs
   can crossfade when the mode changes. */

import type { SpatialOutputMode, SpatialPosition } from '../../spatial/contract';
import { bedPositions, multichannelLayout, type SpeakerLayout } from './layouts';
import { layeredGains, prepareVbap, stereoGains } from './panning';
import type { Track } from './timeline';

/** Per-mode make-up gain. Calibrated by the contract harness
    (test/atmos/harness.test.ts) on real Atmos music, so each mode sits
    about 2 dB under what the engine plays without Atmos (BS.1770 loudness):
    headphones/speakers vs the core's standard stereo downmix, multichannel
    vs the 5.1 core. That keeps switching Atmos on and off level-neutral
    within a couple of dB and leaves peak headroom:
      headphones   −3.0 dB  Chrome's HRTF filters add about +4 dB of
                            K-weighted loudness over plain panning
      speakers     +0.9 dB
      multichannel +1.0 dB  most of the processor's −3 dB object gain
                            (Cavern's .707) comes back */
export const makeupGain: Record<SpatialOutputMode, number> = {
  headphones: 0.71,
  speakers: 1.11,
  multichannel: 1.12,
};

/** LFE level when there is no LFE speaker (−6 dB). */
const lfeFoldGain = 0.5;

export interface Graph {
  mode: SpatialOutputMode;
  fade: GainNode;
  tracks: Track[];
  /** Output channels (2, or the multichannel layout's count). */
  channels: number;
  layout: SpeakerLayout | null;
  nodes: AudioNode[];
}

const front: SpatialPosition = { x: 0, y: 0, z: 1, gain: 1, size: 0 };

function track(params: AudioParam[], values: Track['values'], nonlinear: boolean): Track {
  return { params, values, nonlinear, initial: front };
}

/** AMC space (x right, y up, z front) → Web Audio (x right, y up, −z front).
    Positions very close to the listener are pushed out a little so the
    HRTF always has a direction. */
function toPanner(p: SpatialPosition, out: Float32Array, offset: number): void {
  let x = p.x;
  let y = p.y;
  let z = p.z;
  const r = Math.hypot(x, y, z);
  if (r < 0.05) {
    // Blend toward straight ahead as the object reaches the centre.
    const k = r / 0.05;
    x *= k;
    y *= k;
    z = z * k + (1 - k) * 0.05;
  }
  out[offset] = x;
  out[offset + 1] = y;
  out[offset + 2] = -z;
}

function hrtfPanner(ctx: BaseAudioContext): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'linear';
  p.refDistance = 1;
  p.maxDistance = 10000;
  p.rolloffFactor = 0; // direction only; no distance attenuation
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
  return p;
}

function setPannerPosition(p: PannerNode, x: number, y: number, z: number, time: number): void {
  p.positionX.setValueAtTime(x, time);
  p.positionY.setValueAtTime(y, time);
  p.positionZ.setValueAtTime(z, time);
}

/** Headphones: each channel through its own HRTF PannerNode (Chrome's
    built-in HRTF). Objects are automated; bed channels sit at their
    speaker positions; the LFE sits front centre at −6 dB. */
export function buildHeadphones(ctx: BaseAudioContext, splitter: ChannelSplitterNode, bed: string[], objects: number): Graph {
  const fade = ctx.createGain();
  const nodes: AudioNode[] = [fade];
  const makeup = makeupGain.headphones;
  const now = ctx.currentTime;
  bed.forEach((label, i) => {
    const g = ctx.createGain();
    g.gain.value = (label === 'LFE' ? lfeFoldGain : 1) * makeup;
    const p = hrtfPanner(ctx);
    const pos = label === 'LFE' ? [0, 0, 1] : bedPositions[label] ?? [0, 0, 1];
    setPannerPosition(p, pos[0], pos[1], -pos[2], now);
    splitter.connect(g, i);
    g.connect(p).connect(fade);
    nodes.push(g, p);
  });
  const tracks: Track[] = [];
  for (let o = 0; o < objects; o++) {
    const g = ctx.createGain();
    const p = hrtfPanner(ctx);
    splitter.connect(g, bed.length + o);
    g.connect(p).connect(fade);
    nodes.push(g, p);
    tracks.push(
      track(
        [g.gain, p.positionX, p.positionY, p.positionZ],
        (pos, out) => {
          out[0] = pos.gain * makeup;
          toPanner(pos, out, 1);
        },
        false
      )
    );
  }
  return { mode: 'headphones', fade, tracks, channels: 2, layout: null, nodes };
}

/** Stereo speakers (laptop / Mac built-ins): constant-power amplitude
    panning across the front pair, height and rear folded in mildly. */
export function buildSpeakers(ctx: BaseAudioContext, splitter: ChannelSplitterNode, bed: string[], objects: number): Graph {
  const fade = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  merger.connect(fade);
  const nodes: AudioNode[] = [fade, merger];
  const makeup = makeupGain.speakers;
  const lr = new Float32Array(2);
  bed.forEach((label, i) => {
    const pos = bedPositions[label] ?? [0, 0, 1];
    if (label === 'LFE') {
      lr[0] = lr[1] = lfeFoldGain;
    } else {
      stereoGains({ x: pos[0], y: pos[1], z: pos[2], gain: 1, size: 0 }, lr);
    }
    for (let side = 0; side < 2; side++) {
      const g = ctx.createGain();
      g.gain.value = lr[side] * makeup;
      splitter.connect(g, i);
      g.connect(merger, 0, side);
      nodes.push(g);
    }
  });
  const tracks: Track[] = [];
  for (let o = 0; o < objects; o++) {
    const gl = ctx.createGain();
    const gr = ctx.createGain();
    splitter.connect(gl, bed.length + o);
    splitter.connect(gr, bed.length + o);
    gl.connect(merger, 0, 0);
    gr.connect(merger, 0, 1);
    nodes.push(gl, gr);
    tracks.push(
      track(
        [gl.gain, gr.gain],
        (pos, out) => {
          stereoGains(pos, out);
          out[0] *= makeup;
          out[1] *= makeup;
        },
        true
      )
    );
  }
  return { mode: 'speakers', fade, tracks, channels: 2, layout: null, nodes };
}

/** Multichannel: layered VBAP over 5.1 / 7.1 / 7.1.4 speaker positions;
    the LFE goes to the LFE channel. */
export function buildMultichannel(ctx: BaseAudioContext, splitter: ChannelSplitterNode, bed: string[], objects: number,
  layout: SpeakerLayout): Graph {
  const n = layout.speakers.length;
  const fade = ctx.createGain();
  fade.channelCountMode = 'explicit';
  fade.channelCount = n;
  fade.channelInterpretation = 'discrete';
  const merger = ctx.createChannelMerger(n);
  merger.connect(fade);
  const nodes: AudioNode[] = [fade, merger];
  const makeup = makeupGain.multichannel;
  const vbap = prepareVbap(layout.speakers);
  const lfeIndex = layout.speakers.findIndex((s) => s.lfe);
  const gains = new Float32Array(n);
  bed.forEach((label, i) => {
    if (label === 'LFE' && lfeIndex >= 0) {
      gains.fill(0);
      gains[lfeIndex] = 1;
    } else {
      const pos = bedPositions[label] ?? [0, 0, 1];
      layeredGains({ x: pos[0], y: pos[1], z: pos[2], gain: 1, size: 0 }, vbap, gains);
    }
    for (let s = 0; s < n; s++) {
      if (gains[s] === 0) continue;
      const g = ctx.createGain();
      g.gain.value = gains[s] * makeup;
      splitter.connect(g, i);
      g.connect(merger, 0, s);
      nodes.push(g);
    }
  });
  const tracks: Track[] = [];
  const audible = vbap.audible;
  for (let o = 0; o < objects; o++) {
    const params: AudioParam[] = [];
    for (const s of audible) {
      const g = ctx.createGain();
      splitter.connect(g, bed.length + o);
      g.connect(merger, 0, s);
      nodes.push(g);
      params.push(g.gain);
    }
    tracks.push(
      track(
        params,
        (pos, out) => {
          layeredGains(pos, vbap, gains);
          for (let k = 0; k < audible.length; k++) out[k] = gains[audible[k]] * makeup;
        },
        true
      )
    );
  }
  return { mode: 'multichannel', fade, tracks, channels: n, layout, nodes };
}

export function buildGraph(mode: SpatialOutputMode, ctx: BaseAudioContext, splitter: ChannelSplitterNode, bed: string[],
  objects: number): Graph {
  if (mode === 'multichannel') {
    const layout = multichannelLayout(ctx.destination.maxChannelCount);
    if (layout) return buildMultichannel(ctx, splitter, bed, objects, layout);
    // Fewer than 6 destination channels: speakers is the honest fallback.
    return buildSpeakers(ctx, splitter, bed, objects);
  }
  if (mode === 'speakers') return buildSpeakers(ctx, splitter, bed, objects);
  return buildHeadphones(ctx, splitter, bed, objects);
}
