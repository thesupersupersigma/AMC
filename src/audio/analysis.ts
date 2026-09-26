/* Silence analysis for auto-split, sharing its decode with the waveform:
   one pass, two outputs. The decode goes into an OfflineAudioContext at
   8 kHz — never a full-rate AudioContext, which would hold ~890 MB of PCM
   for a 42-minute side; resampling during decode lands near 80 MB. */

import { bucketPeaks } from './peaks';
import { analyzeWithEngine } from './soft/soft-engine';

const ANALYSIS_RATE = 8000;
const WINDOW_SEC = 0.05; /* 50 ms RMS windows */
const MIN_SILENCE_SEC = 1.5;

export interface SilenceRun {
  start: number;
  end: number;
}

export interface SplitAnalysis {
  duration: number;
  /** Interleaved [min, max, …] pairs for the waveform, ~1500 buckets. */
  peaks: number[];
  silences: SilenceRun[];
  /** Proposed boundary times — just before each silence ends, where the
      next track is about to begin. */
  proposals: number[];
}

export async function analyzeForSplit(file: File, durationHint: number): Promise<SplitAnalysis> {
  const raw = await file.arrayBuffer();
  const length = Math.max(ANALYSIS_RATE, Math.ceil(Math.max(1, durationHint || 60) * ANALYSIS_RATE));
  const ctx = new OfflineAudioContext(1, length, ANALYSIS_RATE);
  const decoded = await ctx.decodeAudioData(raw);
  const duration = decoded.duration;
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));

  /* Windowed RMS over the channel mix. */
  const win = Math.round(WINDOW_SEC * decoded.sampleRate);
  const n = channels[0].length;
  const windows = Math.floor(n / win);
  const rms = new Float32Array(windows);
  let peakRms = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const off = w * win;
    for (let i = 0; i < win; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][off + i];
      s /= channels.length;
      sum += s * s;
    }
    const v = Math.sqrt(sum / win);
    rms[w] = v;
    if (v > peakRms) peakRms = v;
  }

  const { silences, proposals } = silencesFromRms(rms, peakRms, win, decoded.sampleRate, duration);

  return {
    duration: duration,
    peaks: bucketPeaks(channels, 1500),
    silences: silences,
    proposals: proposals,
  };
}

/** Silence runs and proposed boundaries from windowed RMS values. Shared by
    the OfflineAudioContext path above and the software engine's streaming
    analysis (engine formats the browser cannot decode). */
export function silencesFromRms(rms: Float32Array, peakRms: number, win: number, sampleRate: number, duration: number): { silences: SilenceRun[]; proposals: number[] } {
  const windows = rms.length;
  /* A window is silent when it sits far below the loudest material; runs
     longer than 1.5 s are track gaps. */
  const threshold = Math.max(1e-4, peakRms * 0.02);
  const minRun = Math.ceil(MIN_SILENCE_SEC / WINDOW_SEC);
  const silences: SilenceRun[] = [];
  let runStart = -1;
  for (let w = 0; w <= windows; w++) {
    const silent = w < windows && rms[w] < threshold;
    if (silent && runStart < 0) runStart = w;
    else if (!silent && runStart >= 0) {
      if (w - runStart >= minRun) silences.push({ start: (runStart * win) / sampleRate, end: (w * win) / sampleRate });
      runStart = -1;
    }
  }

  /* Boundaries land just before the music resumes. Lead-in and fade-out
     silences are not track breaks. */
  const proposals = silences
    .filter((s) => s.start > 2 && s.end < duration - 2)
    .map((s) => Math.max(0, s.end - 0.15));
  return { silences, proposals };
}

/** "Find track breaks" for formats only the software engine decodes (ALAC,
    AC-3, E-AC-3 here): a streaming decode in the engine's Worker, reduced
    on the fly — the file is never held in memory, whatever its length. */
export async function analyzeEngineForSplit(file: File, codec: string, onProgress?: (fraction: number) => void): Promise<SplitAnalysis> {
  const a = await analyzeWithEngine({ file, codec, name: file.name }, WINDOW_SEC, onProgress);
  if (!a) throw new Error('the software decoder is the silent placeholder — nothing to analyse yet');
  const { silences, proposals } = silencesFromRms(a.rms, a.peakRms, a.win, a.sampleRate, a.duration);
  return { duration: a.duration, peaks: a.pairs, silences, proposals };
}
