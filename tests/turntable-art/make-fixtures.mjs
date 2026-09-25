/* Generates the turntable/artwork test library with ffmpeg (-f lavfi):
   four albums of sine tones, tagged, with covers that are 3000 px, 400 px,
   1200 px or absent, plus one side-length FLAC split by a .cue into three
   tracks. Output: <outDir>/TTLib/…  (never committed — binary fixtures).

   node tests/turntable-art/make-fixtures.mjs <outDir>
   FFMPEG=/path/to/ffmpeg overrides the binary. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const FF = process.env.FFMPEG || 'ffmpeg';
const out = process.argv[2] || 'fixtures';
const root = join(out, 'TTLib');
if (existsSync(root)) rmSync(root, { recursive: true });

function ff(args) {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/* A cover: diagonal gradient + a fine grid (so sharpness differences show
   in crops) + an off-centre block (so label rotation is visible). */
function cover(file, px, c0, c1) {
  const g = Math.max(4, Math.round(px / 60));
  const b = Math.round(px * 0.22);
  ff([
    '-f', 'lavfi', '-i', `gradients=s=${px}x${px}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${px}:y1=${px}:nb_colors=2:d=1`,
    '-vf', `drawgrid=w=${g}:h=${g}:t=1:c=white@0.35,drawbox=x=${Math.round(px * 0.14)}:y=${Math.round(px * 0.14)}:w=${b}:h=${b}:c=white@0.9:t=fill`,
    '-frames:v', '1', '-q:v', '2', file,
  ]);
}

function tags(o) {
  return Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
}

function track({ dir, name, ext, secs, freq, rate = 44100, art, meta }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + '.' + ext);
  const a = ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}:sample_rate=${rate}`];
  const codec = ext === 'flac' ? ['-c:a', 'flac'] : ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '96k', '-id3v2_version', '3'] : ['-c:a', 'aac', '-b:a', '96k'];
  if (art) {
    ff([...a, '-i', art, '-map', '0:a', '-map', '1:v', ...codec, '-c:v', 'copy', '-disposition:v', 'attached_pic',
      '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', ...tags(meta), file]);
  } else {
    ff([...a, ...codec, ...tags(meta), file]);
  }
  return file;
}

mkdirSync(out, { recursive: true });
const art3000 = join(out, 'cover-3000.jpg');
const art400 = join(out, 'cover-400.jpg');
const art1200 = join(out, 'cover-1200.jpg');
cover(art3000, 3000, '0x3a0ca3', '0xf72585');
cover(art400, 400, '0x0b6e4f', '0xf2c14e');
cover(art1200, 1200, '0x7b2d26', '0xf4a261');

const alpha = join(root, 'Aurora Band', 'Alpha (2001)');
for (let i = 1; i <= 3; i++) {
  track({ dir: alpha, name: `0${i} - Alpha Song ${i}`, ext: 'flac', secs: 40, freq: 180 + 60 * i, art: art3000,
    meta: { title: `Alpha Song ${i}`, artist: 'Aurora Band', album_artist: 'Aurora Band', album: 'Alpha', track: i, date: 2001 } });
}
const beta = join(root, 'Beta Boys', 'Beta (1999)');
for (let i = 1; i <= 3; i++) {
  track({ dir: beta, name: `0${i} - Beta Song ${i}`, ext: 'mp3', secs: 40, freq: 300 + 50 * i, art: art400,
    meta: { title: `Beta Song ${i}`, artist: 'Beta Boys', album_artist: 'Beta Boys', album: 'Beta', track: i, date: 1999 } });
}
const gamma = join(root, 'Gamma Group', 'Gamma (2010)');
for (let i = 1; i <= 2; i++) {
  track({ dir: gamma, name: `0${i} - Gamma Tune ${i}`, ext: 'm4a', secs: 40, freq: 500 + 40 * i,
    meta: { title: `Gamma Tune ${i}`, artist: 'Gamma Group', album_artist: 'Gamma Group', album: 'Gamma', track: i, date: 2010 } });
}
/* One LP side: 12 minutes, three cue tracks at 0:00, 4:00 and 8:00. */
const delta = join(root, 'Delta Duo', 'Delta Side A (1978)');
track({ dir: delta, name: 'Delta Side A', ext: 'flac', secs: 720, freq: 262, rate: 22050, art: art1200,
  meta: { title: 'Delta Side A', artist: 'Delta Duo', album_artist: 'Delta Duo', album: 'Delta Side A', date: 1978 } });
writeFileSync(join(delta, 'Delta Side A.cue'), [
  'PERFORMER "Delta Duo"',
  'TITLE "Delta Side A"',
  'FILE "Delta Side A.flac" WAVE',
  '  TRACK 01 AUDIO', '    TITLE "Delta One"', '    INDEX 01 00:00:00',
  '  TRACK 02 AUDIO', '    TITLE "Delta Two"', '    INDEX 01 04:00:00',
  '  TRACK 03 AUDIO', '    TITLE "Delta Three"', '    INDEX 01 08:00:00',
  '',
].join('\r\n'));
/* Stub catalog artwork, served by the tests in place of /api/itunes/art. */
const cat = join(out, 'catalog');
mkdirSync(cat, { recursive: true });
for (const px of [600, 1200, 2000, 2400, 3000]) cover(join(cat, `art-${px}.jpg`), px, '0x264653', '0xe9c46a');
console.log('fixtures in', root);
