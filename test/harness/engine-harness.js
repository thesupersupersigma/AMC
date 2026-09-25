/* Dev-only harness for the software decode engine. Also the driver surface
   for test/browser/engine.e2e.mjs (window.H). */
import { SoftEngine } from '../../src/audio/soft/soft-engine.ts';
import { buildMp4, alacAtom, dec3Box, eac3Frame } from '../helpers/mp4build.mjs';
import { alacPackets, testPcm } from '../helpers/alac.mjs';
import { flacTrack, sinePcm } from '../helpers/flac.mjs';

const $ = (s) => document.querySelector(s);
const logBox = $('#log');
function log(msg, detail) {
  logBox.textContent = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg + (detail ? ' — ' + detail : '') + '\n' + logBox.textContent;
}

const events = [];
function makeEngine(opts) {
  const e = new SoftEngine({ role: 'main', devCodecs: true, onLog: log, ...opts });
  for (const type of ['loadstart', 'durationchange', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error', 'volumechange', 'segment', 'nextrejected']) {
    e.addEventListener(type, () => events.push({ type, t: performance.now(), ct: e.currentTime }));
  }
  return e;
}
let engine = makeEngine();

function alacFile(name, { rate = 44100, bits = 16, channels = 2, seconds = 20 } = {}) {
  const pcm = testPcm(Math.round(rate * seconds), channels, bits, 9);
  const { packets, durations } = alacPackets(pcm, bits, 4096);
  const { bytes } = buildMp4([
    { handler: 'soun', codec: 'alac', timescale: rate, sampleRate: rate, channels, sampleSize: bits, config: alacAtom({ bitDepth: bits, channels, sampleRate: rate }), samples: packets, durations },
  ]);
  return new File([bytes], name, { type: 'audio/mp4' });
}
function eac3File(name, seconds = 20) {
  const n = Math.ceil((seconds * 48000) / 1536);
  const frames = Array.from({ length: n }, () => eac3Frame());
  const { bytes } = buildMp4([
    { handler: 'soun', codec: 'ec-3', timescale: 48000, sampleRate: 48000, channels: 2, config: dec3Box({ joc: true }), samples: frames, durations: frames.map(() => 1536), samplesPerChunk: 20 },
  ]);
  return new File([bytes], name, { type: 'audio/mp4' });
}
function flacFile(name, { seconds = 10, offset = 0, freq = 441, rate = 44100 } = {}) {
  const pcm = sinePcm(Math.round(seconds * rate), 2, { rate, freq, offset });
  const { bytes } = buildMp4([flacTrack(pcm, { sampleRate: rate })]);
  return new File([bytes], name, { type: 'audio/mp4' });
}

const makers = {
  alac: () => [alacFile('synthetic-alac.m4a'), 'alac'],
  alac96: () => [alacFile('synthetic-alac-96k.m4a', { rate: 96000, bits: 24, seconds: 8 }), 'alac'],
  eac3: () => [eac3File('synthetic-eac3.m4a'), 'ec-3'],
  flac: () => [flacFile('synthetic-flac.m4a'), 'fLaC'],
};

function load(file, codec, startSec) {
  engine.open({ file, codec, name: file.name }, startSec || 0);
}

document.body.addEventListener('click', (e) => {
  const k = e.target.getAttribute && e.target.getAttribute('data-load');
  if (k) {
    const [f, c] = makers[k]();
    load(f, c);
  }
});
$('#pick').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const { demuxMp4, fileReader } = await import('../../src/audio/mp4samples.ts');
  try {
    const d = await demuxMp4(fileReader(f), f.size);
    load(f, d.codec);
  } catch (err) {
    log('not an MP4 the engine reads', err.message);
  }
});
$('#play').onclick = () => engine.play().catch((err) => log('play failed', err.name + ': ' + err.message));
$('#pause').onclick = () => engine.pause();
$('#seek').onchange = (e) => {
  if (engine.duration > 0) engine.currentTime = (Number(e.target.value) / 1000) * engine.duration;
};
$('#vol').oninput = (e) => (engine.volume = Number(e.target.value) / 100);
$('#mute').onchange = (e) => (engine.muted = e.target.checked);

function tick() {
  const s = engine.debugState();
  $('#status').textContent =
    'currentTime ' + engine.currentTime.toFixed(3) + ' / ' + (engine.duration || 0).toFixed(3) + '   paused ' + engine.paused + '   ended ' + engine.ended + '\n' +
    'ctx ' + s.ctxState + ' @ ' + s.ctxRate + ' Hz   node ' + s.nodeChannels + ' ch → destination ' + s.destinationChannels + ' ch\n' +
    'backend ' + (s.info ? s.info.backend + (s.info.isStub ? ' (STUB — silence)' : '') + ' · ' + s.info.codec + ' · ' + s.info.channels + ' ch' : '-') + '   head media ' + s.pos.media + ' stream ' + s.pos.stream;
  requestAnimationFrame(tick);
}
tick();

/* ---------- the e2e driver surface ---------- */
window.H = {
  get engine() {
    return engine;
  },
  events,
  newEngine(opts) {
    engine.dispose();
    engine = makeEngine(opts);
    return engine;
  },
  makers,
  alacFile,
  eac3File,
  flacFile,
  load,
  captured: [],
  startTap() {
    this.captured = [];
    engine.setTap((stream, planes, media) => this.captured.push({ stream, media, planes }));
  },
  stopTap() {
    engine.setTap(null);
  },
  log,
};
log('harness ready');
