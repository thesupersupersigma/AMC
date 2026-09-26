#!/usr/bin/env bash
# Builds Cavern (pinned commit) and dumps its own decode of the first N
# seconds of an Atmos .m4a, so test/atmos can compare the TypeScript port
# against it bit for bit. Everything lands in /tmp; nothing enters the repo.
#
# Usage: scripts/atmos-cavern-ref.sh [file.m4a] [seconds]
# Env:   CAVERN_DIR (default /tmp/Cavern), AMC_CAVERN_REF (default /tmp/cavref/out),
#        DOTNET, AMC_FFMPEG
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=${1:-test/private/get-on-the-floor.m4a}
SECS=${2:-30}
CAVERN_DIR=${CAVERN_DIR:-/tmp/Cavern}
CAVERN_COMMIT=1e34c81180df91d186c2d09304dfb4157a4cb9ce
OUT=${AMC_CAVERN_REF:-/tmp/cavref/out}
WORK=$(dirname "$OUT")
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

DOTNET=${DOTNET:-}
if [ -z "$DOTNET" ]; then
  if command -v dotnet >/dev/null; then DOTNET=dotnet
  elif [ -x /tmp/dotnet/dotnet ]; then DOTNET=/tmp/dotnet/dotnet
  else
    curl -sSL -o /tmp/dotnet-install.sh https://dot.net/v1/dotnet-install.sh
    bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /tmp/dotnet >/dev/null
    DOTNET=/tmp/dotnet/dotnet
  fi
fi
FFMPEG=${AMC_FFMPEG:-$(command -v ffmpeg || echo /tmp/tools/node_modules/@ffmpeg-installer/linux-x64/ffmpeg)}

if [ ! -d "$CAVERN_DIR/.git" ]; then
  git clone --filter=blob:none https://github.com/VoidXH/Cavern.git "$CAVERN_DIR"
fi
git -C "$CAVERN_DIR" checkout -q "$CAVERN_COMMIT"

mkdir -p "$WORK" "$OUT"
# The raw E-AC-3 stream is the MP4's samples back to back, unchanged.
"$FFMPEG" -hide_banner -loglevel error -y -i "$FILE" -map 0:a:0 -c copy -t "$SECS" -f eac3 "$WORK/input.ec3"
FRAMES=$(( SECS * 48000 / 1536 ))

# Build from a copy so no obj/ or bin/ ever appears inside the repo.
mkdir -p "$WORK/src"
cp test/atmos/cavern-ref/Program.cs test/atmos/cavern-ref/cavref.csproj "$WORK/src/"
"$DOTNET" build "$WORK/src/cavref.csproj" -c Release -o "$WORK/bin" -p:CavernDir="$CAVERN_DIR" 2>&1 | grep -E " error |Build succeeded"
"$DOTNET" "$WORK/bin/cavref.dll" frames "$WORK/input.ec3" "$OUT" "$FRAMES"
"$DOTNET" "$WORK/bin/cavref.dll" render "$WORK/input.ec3" "$OUT" "$FRAMES"
echo "Cavern reference for ${SECS}s ($FRAMES frames) in $OUT"
