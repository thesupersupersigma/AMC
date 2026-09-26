/* Amplitude panning for the speaker modes. AMC-original; distributed under
   the Cavern licence as part of src/audio/atmos/ (see README.md there).
   Pure functions, no Web Audio.

   Positions are AMC listener space (x right, y up, z front, −1..1). */

import type { SpatialPosition } from '../../spatial/contract';
import type { Speaker } from './layouts';

const DEG = 57.29577951308232; // 180 / π

/** Mild attenuation (dB) for height and for rear, when a layout cannot
    reproduce them ("folded in"). */
const heightFoldDb = -1.5;
const rearFoldDb = -1.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Azimuth (degrees, 0 = front, + = right) and elevation (degrees). */
export function direction(x: number, y: number, z: number): { azimuth: number; elevation: number } {
  const horizontal = Math.hypot(x, z);
  return {
    azimuth: horizontal < 1e-9 ? 0 : Math.atan2(x, z) * DEG,
    elevation: horizontal < 1e-9 && Math.abs(y) < 1e-9 ? 0 : Math.atan2(y, horizontal) * DEG,
  };
}

/** Stereo speakers: constant-power pan from x across the front pair,
    widened by size, with height and rear folded in at a mild gain.
    Writes [L, R], each including the object's gain. */
export function stereoGains(p: SpatialPosition, out: Float32Array | number[]): void {
  const x = clamp(p.x, -1, 1);
  const theta = ((x + 1) * Math.PI) / 4;
  let l = Math.cos(theta);
  let r = Math.sin(theta);
  const s = clamp(p.size, 0, 1);
  if (s > 0) {
    l = (1 - s) * l + s * Math.SQRT1_2;
    r = (1 - s) * r + s * Math.SQRT1_2;
    const n = Math.hypot(l, r);
    l /= n;
    r /= n;
  }
  const fold = Math.pow(10, (heightFoldDb * clamp(p.y, 0, 1) + rearFoldDb * clamp(-p.z, 0, 1)) / 20);
  const g = p.gain * fold;
  out[0] = l * g;
  out[1] = r * g;
}

/** Pairwise 2D VBAP over a ring of speakers at the given azimuths.
    `ring` lists speaker indices into `gains`, sorted by azimuth. */
function vbapRing(azimuth: number, azimuths: number[], ring: number[], gains: Float64Array, weight: number): void {
  const n = ring.length;
  if (n === 0 || weight === 0) return;
  if (n === 1) {
    gains[ring[0]] += weight;
    return;
  }
  const a = ((azimuth % 360) + 360) % 360;
  for (let i = 0; i < n; i++) {
    const i1 = ring[i];
    const i2 = ring[(i + 1) % n];
    let a1 = ((azimuths[i1] % 360) + 360) % 360;
    let a2 = ((azimuths[i2] % 360) + 360) % 360;
    if (a2 <= a1) a2 += 360;
    let t = a;
    if (t < a1) t += 360;
    if (t < a1 || t > a2) continue;
    // Solve p = g1·l1 + g2·l2 for unit vectors (x = sin, z = cos).
    a1 /= DEG;
    a2 /= DEG;
    const tr = t / DEG;
    const px = Math.sin(tr), pz = Math.cos(tr);
    const x1 = Math.sin(a1), z1 = Math.cos(a1);
    const x2 = Math.sin(a2), z2 = Math.cos(a2);
    const det = x1 * z2 - x2 * z1;
    let g1: number;
    let g2: number;
    if (Math.abs(det) < 1e-9) {
      // Speakers 180° apart: fall back to a constant-power crossfade.
      const u = (t - a1 * DEG) / (a2 * DEG - a1 * DEG);
      g1 = Math.cos((u * Math.PI) / 2);
      g2 = Math.sin((u * Math.PI) / 2);
    } else {
      g1 = (px * z2 - pz * x2) / det;
      g2 = (pz * x1 - px * z1) / det;
      g1 = Math.max(0, g1);
      g2 = Math.max(0, g2);
      const norm = Math.hypot(g1, g2) || 1;
      g1 /= norm;
      g2 /= norm;
    }
    gains[i1] += g1 * weight;
    gains[i2] += g2 * weight;
    return;
  }
}

/** Precomputed ear-level and height rings of a multichannel layout. */
export interface VbapLayout {
  speakers: Speaker[];
  azimuths: number[];
  ear: number[];
  top: number[];
  audible: number[];
  scratch: Float64Array;
}

export function prepareVbap(speakers: Speaker[]): VbapLayout {
  const idx = speakers.map((_, i) => i).filter((i) => !speakers[i].lfe);
  const byAz = (a: number, b: number) =>
    (((speakers[a].azimuth % 360) + 360) % 360) - (((speakers[b].azimuth % 360) + 360) % 360);
  return {
    speakers,
    azimuths: speakers.map((s) => s.azimuth),
    ear: idx.filter((i) => speakers[i].elevation < 20).sort(byAz),
    top: idx.filter((i) => speakers[i].elevation >= 20).sort(byAz),
    audible: idx,
    scratch: new Float64Array(speakers.length),
  };
}

/** Layered VBAP: pairwise VBAP on the ear-level ring and on the height ring,
    crossfaded (constant power) by elevation. Straight overhead spreads over
    the whole height ring. Without a height ring, height is folded in at a
    mild gain. Size blends toward equal gains on every speaker. Writes one
    gain per speaker (LFE speakers get 0), each including the object's gain. */
export function layeredGains(p: SpatialPosition, v: VbapLayout, out: Float32Array | number[]): void {
  const g = v.scratch;
  g.fill(0);
  const { azimuth, elevation } = direction(p.x, p.y, p.z);
  let fold = 1;
  if (v.top.length > 0) {
    const w = clamp(elevation / 45, 0, 1);
    const ear = Math.cos((w * Math.PI) / 2);
    const top = Math.sin((w * Math.PI) / 2);
    vbapRing(azimuth, v.azimuths, v.ear, g, ear);
    // Near the zenith the azimuth means little: spread across the ring.
    const spread = clamp((elevation - 60) / 30, 0, 1);
    vbapRing(azimuth, v.azimuths, v.top, g, top * Math.sqrt(1 - spread * spread));
    if (spread > 0) {
      const each = (top * spread) / Math.sqrt(v.top.length);
      for (const i of v.top) g[i] += each;
    }
  } else {
    vbapRing(azimuth, v.azimuths, v.ear, g, 1);
    fold = Math.pow(10, (heightFoldDb * clamp(p.y, 0, 1)) / 20);
  }
  const s = clamp(p.size, 0, 1);
  if (s > 0) {
    const each = 1 / Math.sqrt(v.audible.length);
    for (const i of v.audible) g[i] = (1 - s) * g[i] + s * each;
  }
  // Constant power.
  let power = 0;
  for (const i of v.audible) power += g[i] * g[i];
  const norm = power > 0 ? 1 / Math.sqrt(power) : 0;
  const gain = p.gain * fold * norm;
  for (let i = 0; i < g.length; i++) out[i] = v.speakers[i].lfe ? 0 : g[i] * gain;
}
