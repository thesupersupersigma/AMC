#!/usr/bin/env bash
# Builds the SILENT STUB decoder.wasm from stub.c with plain clang + wasm-ld
# (no Emscripten, no libc). Only for sessions that cannot run build.sh:
# the real decoder comes from ../build.sh and overwrites ../decoder.wasm.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../decoder.wasm}"
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin \
  -Wall -Wextra -Wno-unused-parameter \
  -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=1048576 \
  -o "$OUT" "$HERE/stub.c"
echo "stub decoder written to $OUT ($(wc -c < "$OUT") bytes)"
