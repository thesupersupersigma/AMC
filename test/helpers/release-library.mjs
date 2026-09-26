/* The small library the v2.3.0 release checks play (test/browser/
   release*.e2e.mjs), built with ffmpeg:

     Native Artist / Sine Album      FLAC, 40 s 440 Hz and 660 Hz tones, a
                                     3000 px embedded cover (native path)
     Engine Artist / ALAC Album      ALAC: Tone A + Tone B, one continuous
                                     440 Hz sine cut at sample 441000
                                     (gapless), and Sweep with clicks at 5,
                                     10 and 15 s (seek markers, as in
                                     scripts/make-fixtures.sh); 1200 px cover
     Engine Artist / Surround        plain E-AC-3 5.1(side), a tone per
                                     channel (FL 300, FR 500, FC 700, LFE 60,
                                     SL 900, SR 1100 Hz)
     Michael Jackson / Off the Wall  the owner's Atmos track, copied in when
                                     given (test/private/, never committed) */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** AMC_FFMPEG, else `ffmpeg` on PATH; null when neither runs. */
export function findFfmpeg() {
  return [process.env.AMC_FFMPEG, 'ffmpeg'].filter(Boolean).find((f) => spawnSync(f, ['-hide_banner', '-version']).status === 0) || null;
}

export function makeReleaseLibrary(dir, { ffmpeg, atmos = null }) {
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  const cover = (file, px, c0, c1) => {
    const g = Math.max(4, Math.round(px / 60));
    ff([
      '-f', 'lavfi', '-i', `gradients=s=${px}x${px}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${px}:y1=${px}:nb_colors=2:d=1`,
      '-vf', `drawgrid=w=${g}:h=${g}:t=1:c=white@0.35`,
      '-frames:v', '1', '-q:v', '2', file,
    ]);
  };
  const tags = (title, artist, album, track) => [
    '-metadata', 'title=' + title, '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
    '-metadata', 'album=' + album, '-metadata', 'track=' + track,
  ];

  const art = join(dir, '.art');
  mkdirSync(art, { recursive: true });
  cover(join(art, 'c3000.jpg'), 3000, '0x2d5c8a', '0xd8a431');
  cover(join(art, 'c1200.jpg'), 1200, '0x8a2d5c', '0x31d8a4');

  /* Native: FLAC, 40 s tones, a 3000 px embedded cover. */
  const nat = join(dir, 'Native Artist', 'Sine Album');
  mkdirSync(nat, { recursive: true });
  for (const [hz, n] of [[440, 1], [660, 2]]) {
    ff([
      '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=40`, '-i', join(art, 'c3000.jpg'),
      '-map', '0:a', '-map', '1:v', '-ac', '2', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic',
      ...tags('Sine ' + hz, 'Native Artist', 'Sine Album', n), join(nat, `0${n} - Sine ${hz}.flac`),
    ]);
  }

  /* Engine: ALAC. */
  const eng = join(dir, 'Engine Artist', 'ALAC Album');
  mkdirSync(eng, { recursive: true });
  const alac = (expr, title, n, extra = []) => [
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}|${expr}':s=44100:d=20:c=stereo`, '-i', join(art, 'c1200.jpg'),
    '-map', '0:a', '-map', '1:v', ...extra, '-c:a', 'alac', '-sample_fmt', 's16p', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
    ...tags(title, 'Engine Artist', 'ALAC Album', n), '-f', 'mp4', '-movflags', '+faststart',
  ];
  const TONE = '0.5*sin(2*PI*440*t)';
  ff([...alac(TONE, 'Tone A', 1, ['-af', 'atrim=end_sample=441000']), join(eng, '01 - Tone A.m4a')]);
  ff([...alac(TONE, 'Tone B', 2, ['-af', 'atrim=start_sample=441000,asetpts=PTS-STARTPTS']), join(eng, '02 - Tone B.m4a')]);
  const SWEEP = '0.4*sin(2*PI*(100*t+97.5*t*t))+0.9*(lt(abs(t-5),0.0005)+lt(abs(t-10),0.0005)+lt(abs(t-15),0.0005))';
  ff([...alac(SWEEP, 'Sweep', 3), join(eng, '03 - Sweep.m4a')]);

  /* Engine: plain E-AC-3 5.1(side), a tone per channel. */
  const sur = join(dir, 'Engine Artist', 'Surround');
  mkdirSync(sur, { recursive: true });
  const EX = [300, 500, 700, 60, 900, 1100].map((f) => `0.3*sin(2*PI*${f}*t)`).join('|');
  ff([
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${EX}':s=48000:d=12:c=5.1(side)`,
    '-c:a', 'eac3', '-b:a', '384k', ...tags('Six Tones', 'Engine Artist', 'Surround', 1), '-f', 'mp4', '-movflags', '+faststart',
    join(sur, '01 - Six Tones.m4a'),
  ]);

  if (atmos) {
    const at = join(dir, 'Michael Jackson', 'Off the Wall');
    mkdirSync(at, { recursive: true });
    copyFileSync(atmos, join(at, '04 - Get On the Floor.m4a'));
  }
  rmSync(art, { recursive: true, force: true });
}
