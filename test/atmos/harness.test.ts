/* Gate 5: runs the contract harness (test/atmos/harness.ts) over the real
   file's first 60 s, with a simulated seek, into an OfflineAudioContext in
   headless Chromium, and writes test/private/atmos-headphones.wav (plus
   atmos-speakers.wav) for the owner to listen to. A second, shorter run
   seeks across the track to check reset() mid-playback.
   AMC-original test code. */

import { loadPlaywright, planFor, runHarness } from './harness';
import { assert, findFfmpeg, haveRealFile, log, run, skip, test } from './util';

function report(r: Awaited<ReturnType<typeof runHarness>>): void {
  log(`Chromium ${r.chromium}; Worker realm: window ${r.realm.hasWindow}, document ${r.realm.hasDocument}`);
  log(`maxChannels ${r.maxChannels}, bed ${JSON.stringify(r.bedLayout)}, ${r.blocks} blocks, ${r.keyframes} keyframes, seeks at played frames ${JSON.stringify(r.seeks)}`);
  log(`Worker process(): ${r.worker.processMs.toFixed(0)} ms for ${((r.totalFrames / 48000) * 1000).toFixed(0)} ms of audio ` +
    `(${((r.totalFrames / 48) / r.worker.processMs).toFixed(1)}× realtime in the browser Worker); stats ${JSON.stringify(r.worker.stats)}`);
  log(`reference: core stereo downmix ${r.coreLoudness.toFixed(1)} LKFS (peak ${r.corePeak.toFixed(3)}), core 5.1 ${r.core51Loudness.toFixed(1)} LKFS`);
  for (const m of r.results) {
    const ref = m.outChannels > 2 ? r.core51Loudness : r.coreLoudness;
    log(`${m.mode} (${m.outChannels} ch): ${m.loudness.toFixed(1)} LKFS (${(m.loudness - ref).toFixed(1)} dB vs core ${m.outChannels > 2 ? '5.1' : 'downmix'}), ` +
      `peak ${m.peak.toFixed(3)}, clipped samples ${m.clipped}, NaN ${m.nan}, quietest second RMS ${m.minSecondRms.toFixed(4)}, ` +
      `offline render ${(m.renderMs / 1000).toFixed(1)} s`);
  }
}

test('contract harness: first 60 s, seek at 30 s, headphones + speakers WAVs', async () => {
  if (!haveRealFile) skip('no real file');
  if (!findFfmpeg()) skip('no ffmpeg');
  if (!loadPlaywright()) skip('no playwright');
  // Play 0–30 s, seek (to the same point, so the listen is continuous), play 30–60 s.
  const plan = planFor([[0, 30], [30, 60]]);
  const r = await runHarness(plan, [
    { mode: 'headphones', outChannels: 2, wav: 'atmos-headphones.wav' },
    { mode: 'speakers', outChannels: 2, wav: 'atmos-speakers.wav' },
    { mode: 'multichannel', outChannels: 12 },
  ], log);
  report(r);
  assert(!r.realm.hasWindow && !r.realm.hasDocument, 'the processor ran in a DOM-less Worker realm');
  assert(r.maxChannels === 17 && r.bedLayout.length === 1 && r.bedLayout[0] === 'LFE', 'maxChannels 1 + complexity 16, LFE bed');
  assert(r.seeks.length === 1, 'one seek');
  for (const m of r.results) {
    assert(m.nan === 0, `${m.mode}: no NaN/Infinity`);
    assert(m.minSecondRms > 1e-4, `${m.mode}: no silent second (no dropouts after the seek)`);
    const ref = m.outChannels > 2 ? r.core51Loudness : r.coreLoudness;
    assert(Math.abs(m.loudness - ref + 2) < 1, `${m.mode}: loudness 2 ± 1 dB under the core reference`);
    assert(m.clipped === 0 && m.peak < 1, `${m.mode}: no clipping`);
  }
});

test('contract harness: seek across the track (10 s → 40 s)', async () => {
  if (!haveRealFile || !findFfmpeg() || !loadPlaywright()) skip('needs the real file, ffmpeg and playwright');
  const plan = planFor([[0, 10], [40, 50]]);
  const r = await runHarness(plan, [{ mode: 'speakers', outChannels: 2 }]);
  report(r);
  const m = r.results[0];
  assert(m.nan === 0 && m.minSecondRms > 1e-4, 'plays on after the jump');
});

run();
