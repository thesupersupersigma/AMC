#!/usr/bin/env bash
# Generates the engine's test fixtures in test/fixtures/ with ffmpeg, plus an
# ffmpeg-decoded reference (<name>.f32: interleaved float32 little-endian,
# edit list applied) for each, which test/decoder.test.mjs compares against.
#
#   bash scripts/make-fixtures.sh            (needs ffmpeg with alac, ac3, eac3 encoders)
#
# The fixtures total well over 5 MB, so they are git-ignored; this script is
# the source of truth. Every source is synthetic (-f lavfi): no downloads.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=test/fixtures
mkdir -p "$OUT"
FF=(ffmpeg -hide_banner -loglevel error -y)

# A 100 Hz -> 4 kHz sweep with 0.5 ms clicks at 5, 10 and 15 seconds. The
# clicks are seek markers: a seek to 10.000 s must land on one.
SWEEP='0.4*sin(2*PI*(100*t+97.5*t*t))+0.9*(lt(abs(t-5),0.0005)+lt(abs(t-10),0.0005)+lt(abs(t-15),0.0005))'

# 1. ALAC stereo 44.1 kHz 16-bit, ~20 s, moov at the front.
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${SWEEP}|${SWEEP}':s=44100:d=20:c=stereo" \
  -c:a alac -sample_fmt s16p -f mp4 -movflags +faststart "$OUT/alac-16-44k-sweep.m4a"

# 2. ALAC stereo 96 kHz 24-bit.
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${SWEEP}|${SWEEP}':s=96000:d=8:c=stereo" \
  -c:a alac -sample_fmt s32p -f mp4 -movflags +faststart "$OUT/alac-24-96k.m4a"

# 3. Two ALAC tracks cut from ONE continuous 440 Hz tone at sample 441000:
#    played back to back they must splice with no discontinuity.
TONE='0.5*sin(2*PI*440*t)'
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${TONE}|${TONE}':s=44100:d=20:c=stereo" \
  -af "atrim=end_sample=441000" -c:a alac -sample_fmt s16p -f mp4 -movflags +faststart "$OUT/gapless-1.m4a"
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${TONE}|${TONE}':s=44100:d=20:c=stereo" \
  -af "atrim=start_sample=441000,asetpts=PTS-STARTPTS" -c:a alac -sample_fmt s16p -f mp4 -movflags +faststart "$OUT/gapless-2.m4a"

# 4. E-AC-3 5.1(side) 48 kHz, a distinct tone per channel
#    (FL 300, FR 500, FC 700, LFE 60, SL 900, SR 1100 Hz).
EXPRS='0.3*sin(2*PI*300*t)|0.3*sin(2*PI*500*t)|0.3*sin(2*PI*700*t)|0.3*sin(2*PI*60*t)|0.3*sin(2*PI*900*t)|0.3*sin(2*PI*1100*t)'
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${EXPRS}':s=48000:d=10:c=5.1(side)" \
  -c:a eac3 -b:a 384k -f mp4 -movflags +faststart "$OUT/eac3-51-48k.m4a"

# 5. AC-3 stereo 48 kHz.
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${SWEEP}|${SWEEP}':s=48000:d=10:c=stereo" \
  -c:a ac3 -b:a 192k -f mp4 -movflags +faststart "$OUT/ac3-20-48k.m4a"

# 6. ALAC with moov at the END (ffmpeg's default without +faststart) and a
#    large (multi-MB) cover-art atom from a 1500x1500 noise JPEG. The
#    expression is quoted inside the filtergraph so its commas survive.
"${FF[@]}" -f lavfi -i "color=c=gray:s=1500x1500,noise=alls=100:allf=t" -frames:v 1 -q:v 1 "$OUT/cover-noise.jpg"
"${FF[@]}" -f lavfi -i "aevalsrc=exprs='${SWEEP}|${SWEEP}':s=44100:d=6:c=stereo" -i "$OUT/cover-noise.jpg" \
  -map 0:a -map 1:v -c:a alac -sample_fmt s16p -c:v copy -disposition:v:0 attached_pic \
  -f mp4 "$OUT/alac-moov-end-cover.m4a"
rm -f "$OUT/cover-noise.jpg"

# References: ffmpeg's own decode, edit lists applied, interleaved f32le.
for f in "$OUT"/*.m4a; do
  "${FF[@]}" -i "$f" -map 0:a:0 -f f32le -acodec pcm_f32le "${f%.m4a}.f32"
done

ls -la "$OUT"
du -sh "$OUT"
