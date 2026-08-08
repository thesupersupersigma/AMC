/* Waveform peaks: ~1500 min/max pairs per file, a few KB, cached in the
   sidecar's peaks/ directory so the decode happens once. */

import type { ConnectedFolder, PeakData } from '../types';
import { queueSidecarWrite, stripRoot } from '../fs/amcdir';
import { logErr } from '../ui/log';

export function bucketPeaks(channels: Float32Array[], buckets: number): number[] {
  const n = channels[0] ? channels[0].length : 0;
  if (!n) return [];
  const out = new Array<number>(buckets * 2);
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(n, Math.max(from + 1, Math.floor((b + 1) * per)));
    let mn = 1,
      mx = -1;
    for (let i = from; i < to; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      s /= channels.length;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

function peaksRel(path: string): string {
  return 'peaks/' + stripRoot(path) + '.json';
}

export async function loadPeaks(folder: ConnectedFolder, path: string): Promise<PeakData | null> {
  const text = await folder.backend.readSidecarText(peaksRel(path));
  if (!text) return null;
  try {
    const data = JSON.parse(text) as PeakData;
    if (data && data.version === 1 && Array.isArray(data.pairs) && data.pairs.length) return data;
  } catch (e) {
    logErr('waveform', 'Saved peaks for ' + path + ' are malformed', (e as Error).message);
  }
  return null;
}

export function savePeaks(folder: ConnectedFolder, path: string, data: PeakData): void {
  queueSidecarWrite(folder, peaksRel(path), () => JSON.stringify(data));
}
