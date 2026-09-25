#!/usr/bin/env bash
# Builds vendor/decoder/decoder.wasm: FFmpeg's libavcodec with ONLY the ALAC,
# AC-3 and E-AC-3 decoders, plus shim.c, as a standalone WebAssembly module.
#
# Fully pinned and reproducible:
#   emsdk   3.1.74                 (github.com/emscripten-core/emsdk, tag)
#   FFmpeg  n7.1                   (github.com/FFmpeg/FFmpeg, tag)
# The resolved commits land in BUILDINFO.txt next to the output.
#
# License: the configure line enables no GPL or nonfree component, so the
# result is LGPL-2.1-or-later (see LICENSE.LGPL-2.1 and README.md).
#
# Usage:  bash vendor/decoder/build.sh          (needs git, python3, make)
# CI:     .github/workflows/build-decoder.yml runs exactly this.
set -euo pipefail

EMSDK_VERSION="3.1.74"
FFMPEG_TAG="n7.1"

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${AMC_DECODER_WORK:-$HERE/.build}"
PREFIX="$WORK/prefix"
JOBS="$(nproc 2>/dev/null || echo 2)"

mkdir -p "$WORK"

# ---------- emsdk ----------
if [ ! -d "$WORK/emsdk" ]; then
  git clone --depth 1 --branch "$EMSDK_VERSION" https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
fi
( cd "$WORK/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" )
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"
emcc --version | head -1

# ---------- FFmpeg ----------
if [ ! -d "$WORK/ffmpeg" ]; then
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$WORK/ffmpeg"
fi

# The configure line (also quoted in README.md — keep them identical).
CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --target-os=none
  --arch=x86_32
  --enable-cross-compile
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm
  --disable-everything
  --disable-programs
  --disable-doc
  --disable-avdevice
  --disable-avformat
  --disable-swresample
  --disable-swscale
  --disable-avfilter
  --disable-postproc
  --disable-network
  --disable-autodetect
  --disable-asm
  --disable-inline-asm
  --disable-pthreads
  --disable-w32threads
  --disable-os2threads
  --disable-runtime-cpudetect
  --disable-debug
  --disable-stripping
  --enable-decoder=alac,ac3,eac3
  --extra-cflags=-O3
)

(
  cd "$WORK/ffmpeg"
  emconfigure ./configure "${CONFIGURE_FLAGS[@]}"
  # Belt and braces: the license gate must hold whatever configure decided.
  grep -q '^#define CONFIG_GPL 0' config.h
  grep -q '^#define CONFIG_NONFREE 0' config.h
  emmake make -j"$JOBS"
  emmake make install
)

# ---------- link ----------
EXPORTS="_malloc,_free,_dec_open,_dec_send,_dec_get_planar_f32,_dec_channels,_dec_sample_rate,_dec_flush,_dec_close,_dec_is_stub,_dec_version"
emcc -O3 \
  -DAMC_FFMPEG_TAG="\"$FFMPEG_TAG\"" \
  -I"$PREFIX/include" \
  "$HERE/shim.c" \
  "$PREFIX/lib/libavcodec.a" \
  "$PREFIX/lib/libavutil.a" \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 \
  -sMAXIMUM_MEMORY=536870912 \
  -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=0 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -o "$HERE/decoder.wasm"

# FFmpeg's own license text travels with the binary.
cp "$WORK/ffmpeg/COPYING.LGPLv2.1" "$HERE/LICENSE.LGPL-2.1"

FFMPEG_COMMIT="$(git -C "$WORK/ffmpeg" rev-parse HEAD)"
EMSDK_COMMIT="$(git -C "$WORK/emsdk" rev-parse HEAD)"
{
  echo "decoder.wasm built by vendor/decoder/build.sh"
  echo "date:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "emsdk:          $EMSDK_VERSION ($EMSDK_COMMIT)"
  echo "emcc:           $(emcc --version | head -1)"
  echo "FFmpeg:         $FFMPEG_TAG ($FFMPEG_COMMIT)"
  echo "decoders:       alac ac3 eac3"
  echo "license:        LGPL-2.1-or-later (no --enable-gpl, no --enable-nonfree)"
  echo "size (bytes):   $(wc -c < "$HERE/decoder.wasm")"
  echo "sha256:         $(sha256sum "$HERE/decoder.wasm" | cut -d' ' -f1)"
} > "$HERE/BUILDINFO.txt"
cat "$HERE/BUILDINFO.txt"
