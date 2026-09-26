# The software decode engine

Plays what the browser can't: **ALAC** (`alac`), **AC-3** (`ac-3`) and **E-AC-3** (`ec-3`,
including Dolby Atmos editions, whose objects the Atmos add-on in `src/audio/atmos/` decodes and
renders) in MP4/M4A. Everything the browser can decode still plays on the `<audio>` element,
exactly as before. (E-)AC-3 is decoded with dynamic range compression off (`drc_scale 0`).

## How a track reaches it

1. **Native first.** `ui/player.ts` loads every track on the element through the playback facade
   (`src/audio/media.ts`).
2. **Handoff.** On a genuine native decode failure (`MEDIA_ERR_DECODE` /
   `MEDIA_ERR_SRC_NOT_SUPPORTED`, or an instant silent "end") for an engine codec, the fourcc is
   marked failed (`markCodecFailed`) and the same track goes to the engine at the same position.
   There's no skip, no error row, and one activity line per codec per session: `ec-3 isn't
   supported natively here — using software decoding`.
3. **Remembered.** For the rest of the session, tracks with that fourcc start directly in the
   engine, and Play/Shuffle queues keep them.
4. **Unsupported stays unsupported.** `ac-4`, `drms`, and AAC in a browser without an AAC decoder
   keep today's behaviour: they're logged, badged and skipped.
5. **Setting.** Settings → *Software decoding for unsupported formats* (on by default). Off means
   today's behaviour everywhere.

## Pieces

```
src/audio/media.ts            the one MediaLike facade every module uses (element | engine)
src/audio/mp4samples.ts       MP4 sample tables: offsets, sizes, PTS, edit lists (File.slice only)
src/audio/soft/soft-engine.ts main thread: Worker, AudioContext (lazy, file rate), Worklet node,
                              GainNode, spatial renderer slot, element-like events + clock
src/audio/soft/worker-core.ts the decode Worker: batched reads, WebCodecs-or-WASM decode,
                              trimming, ~2 s buffer, gapless splices, peaks, track-break analysis
src/audio/soft/worklet.ts     AudioWorklet processor: PCM chunk queue → native channel count,
                              played-frame reports (the clock), underrun/ended signals
src/audio/soft/backends.ts    WasmBackend (vendor/decoder) and WebCodecsBackend, one interface
src/audio/spatial/            contract.ts (shared with feat/atmos, verbatim) + register.ts
vendor/decoder/               FFmpeg libavcodec (alac, ac3, eac3) → decoder.wasm, LGPL-2.1
```

PCM flows Worker → Worklet directly over a `MessagePort`, so audio never waits on a busy main
thread. `currentTime` comes from frames the Worklet actually played, interpolated on the audio
clock and corrected for output latency. Memory is flat: chunks are dropped as soon as they're
played. A full play of an 8-minute file keeps the main heap and the worker heap each under 2 MB.

While the engine plays, the `<audio>` element loops generated silence, so Chrome keeps its media
session (ChromeOS media controls, keyboard media keys). Position state is published from the
engine clock.

## Parity

Gapless within an album of engine files: the next track is spliced in the Worker before the
current one ends, with the same sample rate and channel count. Contiguous cue tracks on an engine
source are gapless. Crossfade works too: the playing engine stream becomes the fading tail. The
engine also covers per-track resume, Media Session, Now Playing, ambient theming, synced lyrics,
Document PiP, waveform peaks (sparse Worker decode, cached where FLAC peaks are), and *Find track
breaks* (a streaming full decode in the Worker). The browser tests below walk the whole list.

## Single-file build and `file://`

Chromium refuses Blob-URL worklet modules and module workers on an opaque `file://` origin.
Classic Blob-URL workers and `data:` URL worklet modules both load. So the engine uses the Worker
inlined by Vite (`?worker&inline`: classic, Blob URL, `data:` fallback), the worklet from a Blob
URL with a `data:` URL fallback, and `decoder.wasm` as an inlined `data:` URL. Verified with the
real `npm run build:file` opened from `file://` in Chromium (v2.3.0,
`test/browser/release-file.e2e.mjs`): native FLAC, ALAC through the engine, Atmos objects, and
the turntable speed on both paths.

## Spatial hook (Atmos)

For `ec-3` streams, a `SpatialProcessor` registered in the Worker realm gets every decoded packet
plus its core PCM. The Worklet is sized to `maxChannels`, the returned block is played, keyframes
are relayed stamped with the block's absolute stream frame, and `reset()` runs on seek and track
change. The processor declares its `bedLayout` up front (Atmos: `['LFE']`, everything else an
object), and the renderer factory is handed it; its `stats.objects` is relayed for the
"Dolby Atmos · n objects" label. On the main thread a registered `SpatialRenderer` sits between
the Worklet node and the gain node, fed `setPlayedFrame`, `pushKeyframes` and `setRate`.
Settings → *Spatial audio output* (Auto / Headphones / Speakers / Multichannel) appears once a
renderer is registered, which since 2.3.0 is always: `src/audio/spatial/register.ts` registers the
Atmos add-on. `test/spatial/test-processor.ts` (test-only, never in the app build) still proves
the hook on its own.

## Playback rate (the turntable speed)

`media.playbackRate` works on both paths, varispeed like vinyl: the pitch follows the speed. On
the engine path the AudioWorklet resamples: its read head advances `rate` source frames per output
frame, the output is a 4-point Catmull-Rom cubic across chunk boundaries, and a rate change ramps
linearly over one render quantum (the brake's 16 ms steps never click). At exactly 1× samples
are copied untouched, as before; coming back to 1× it crossfades onto the exact samples within
one quantum. Everything reported stays in source frames: `currentTime` is source time (it runs
`rate` times faster than the clock), the Worker's buffer marks scale with the rate, and spatial
keyframes keep their source-frame stamps while the renderer maps them through `setRate`. Like an
element's `load()`, opening a track starts it at `defaultPlaybackRate`; a crossfade tail keeps
the rate.

## Tests

```sh
npm run test:engine        # node --test: decoder (stub or real), MP4 demux (no ffmpeg needed)
bash scripts/make-fixtures.sh && npm run test:engine   # + ffmpeg fixtures and reference PCM

npm run dev                # then, with Playwright + Chromium available:
AMC_URL=http://localhost:5173 npm run test:browser
#   test/browser/engine.e2e.mjs  engine alone via test/harness/engine.html (dev-only page)
#   test/browser/app.e2e.mjs     facade, handoff, queue, settings (synthetic library)
#   test/browser/parity.e2e.mjs  the parity checklist on engine tracks
#   test/browser/release.e2e.mjs       v2.3.0 release checks: native, ALAC, E-AC-3, Atmos modes,
#                                      turntable rate/pitch on both paths, covers, memory over a
#                                      full play (needs ffmpeg; Atmos needs test/private/;
#                                      AMC_FULL_PLAY=0 skips the ~5 min full play)
#   test/browser/release-file.e2e.mjs the single-file build from file:// (npm run build:file first)
```

Browser tests push real audio through the whole engine with FLAC-in-MP4, which WebCodecs
decodes. That's a dev-only codec that is never enabled in the app. It lets seek accuracy and the
gapless splice be checked sample for sample even while `decoder.wasm` is the silent stub.
