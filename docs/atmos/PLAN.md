# Dolby Atmos (E-AC-3 JOC) add-on — plan

Branch `feat/atmos`, from `0d44978`. This add-on supplies the `SpatialProcessor`
(Worker side) and `SpatialRenderer` (main thread) that the decode engine on
`feat/decode-engine` calls through `src/audio/spatial/contract.ts`. It touches
nothing the engine owns.

Reference implementation: [Cavern](https://github.com/VoidXH/Cavern) by VoidX
(Bence Sgánetz, <http://en.sbence.hu>), read at commit
`1e34c81180df91d186c2d09304dfb4157a4cb9ce` (2026-09-22).

## 1. What was found in the real file

`Get On the Floor` (Off the Wall, Atmos): `ec-3`, 48 kHz, 5.1(side), 768 kb/s.

- Every MP4 sample is one 3072-byte E-AC-3 syncframe: independent substream 0,
  `acmod` 7 + LFE, 6 blocks (1536 samples). No dependent substream.
- `dec3` = `18 00 20 0f 00 01 10`: 768 kb/s, one independent substream,
  `flag_ec3_extension_type_a` = 1, `complexity_index_type_a` = 16.
- JOC: 15 objects over a 5-channel core (`joc_dmx_config_idx` 0), 12 parameter
  bands, fine or coarse quantisation, 1 data point, no sparse coding, no steep
  slopes. So Cavern's unusual code paths (§6.4, §6.5) never run on this track.
- OAMD: 16 objects = an LFE-only bed + 15 dynamic objects (one per JOC
  object). One object element per frame, with one info block at offset 0 and
  a 1536-sample ramp.
- `auxdatae` is 0 in every frame checked. The EMDF container (sync `0x5838`)
  sits at a single, non-byte-aligned bit position inside an audio block's
  **skip field** (`skipfld`). Reaching the skip field of block *n* means
  walking every mantissa of blocks 0..*n*−1, and mantissa lengths come from the
  AC-3 bit allocation. So the Worker has to *parse* the whole E-AC-3 frame the
  way Cavern's decoder does. It never dequantises or runs an IMDCT, because
  FFmpeg already decoded the core.

## 2. Cavern → AMC module map

Every file under `src/audio/atmos/` that ports Cavern code names its source file
in its header comment. Structure and naming follow Cavern closely so the two can
be diffed side by side.

| AMC module | Cavern source |
|---|---|
| `bitstream/bit-extractor.ts` | `Cavern.Format/Utilities/BitExtractor.cs`, `Decoders/EnhancedAC3/ExtensibleMetadataExtensions.cs` |
| `bitstream/eac3-consts.ts` | `Transcoders/EnhancedAC3Consts.cs`, `EnhancedAC3Enums.cs`, `EnhancedAC3Body/Consts.cs`, `AllocationConstants.cs` |
| `bitstream/eac3-header.ts` | `Transcoders/EnhancedAC3Header.cs`, `EnhancedAC3Header/EAC3/*.cs`, `EnhancedAC3Header/AC3/BitStreamInformation.cs` |
| `bitstream/eac3-body.ts` + `eac3-allocation.ts` | `Transcoders/EnhancedAC3Body.cs`, `EnhancedAC3Body/{DecodeAudioFrame,DecodeAudioBlock,Allocation,AllocationParsing,BitAllocation,Coupling,SPX,DeltaBitAllocation,Parsers,Memory}.cs`: parse only, with no dequantisation or IMDCT |
| `bitstream/access-unit.ts` | `Decoders/EnhancedAC3Decoder.cs` (`DecodeFrame`/`ReadHeader` loop over syncframes) |
| `bitstream/emdf.ts` | `Decoders/EnhancedAC3/ExtensibleMetadataDecoder.cs` |
| `bitstream/joc.ts`, `joc-tables.ts` | `Decoders/EnhancedAC3/JointObjectCoding.cs`, `JointObjectCodingTables.cs` |
| `bitstream/oamd.ts` | `Decoders/EnhancedAC3/ObjectAudioMetadata.cs`, `ObjectAudioElementMetadata.cs`, `ObjectInfoBlock.cs`, `ObjectAudioMetadataEnums.cs` |
| `bitstream/dec3.ts` | none; this is AMC-original, following ETSI TS 102 366 Annex F (`dec3` box) |
| `joc/qmf.ts` | `Decoders/EnhancedAC3/QuadratureMirrorFilterBank*.cs` |
| `joc/matrix.ts` | `Decoders/EnhancedAC3/JointObjectCodingDecoder.cs`, `JointObjectCodingCache.cs` |
| `joc/applier.ts` | `Decoders/EnhancedAC3/JointObjectCodingApplier.cs` |
| `joc/upmix.ts` | `Renderers/EnhancedAC3Renderer.cs` (bed/object split, LFE handling, OAMD→source timing) |
| `processor.ts` | glue: `SpatialProcessor` over the above |
| `render/*` | none; AMC-original Web Audio renderer. Bed speaker positions come from `Cavern/Channels/ChannelPrototype.Consts.cs` (`AlternativePositions`) |
| `labels.ts` | none; AMC-original UI copy |

`src/audio/spatial/contract.ts` is the shared contract, copied verbatim, and is
never edited. `src/audio/spatial/register.ts` is the one line of registration.
Both are AMC code, not Cavern-derived.

## 3. Cavern's licence, and how this complies

The full text is copied verbatim into `src/audio/atmos/LICENSE` (from Cavern's
`LICENSE.md`). Clause by clause:

| Licence condition | How AMC complies |
|---|---|
| Given without warranty; developer not liable | The verbatim `LICENSE` in the folder carries it. |
| "You are allowed to make any modifications, and release them for free under this licence." | The TypeScript port is a modification. It is released free, and everything in `src/audio/atmos/` is under Cavern's licence (its own `LICENSE` + `README.md`), **not** AMC's MIT. |
| "If you release a modified version, you have to link this repository as its source." | `src/audio/atmos/README.md`, every Cavern-derived file header, and AMC's `README.md` "Third-party" section link <https://github.com/VoidXH/Cavern>. |
| "You are not allowed to sell any part of the original or the modified version." | AMC is free. **The owner must never sell AMC, or any build containing this folder.** AMC's MIT licence cannot grant anyone else that right for this folder either; the README says so. |
| "You are also not allowed to show advertisements in the modified software." | AMC shows no ads. **This is now a permanent constraint on AMC builds that include this folder.** |
| "The software must be named with a link to the creator (http://en.sbence.hu) when used in public … or commercially …" | The folder README, the file headers and AMC's README name Cavern and link <http://en.sbence.hu>. `labels.ts` exports `ATMOS_CREDIT` (text + link) so the merge step can show the credit in the app itself (Settings/About). Recommended, since the app is publicly hosted. |
| "the original creator's permission is required for public use (e.g. screening)" | Distributing the software free is explicitly allowed by the "release them for free" clause, and a listener using AMC at home is private use. **Using AMC's Atmos rendering for a public playback event (a screening, a listening party, a venue) needs VoidX's permission first.** Whether a public web deployment counts as "public use" is not defined. The example given is a screening, which reads as public *performance*. Asking VoidX is cheap if the owner wants certainty. |
| "If you include these code or any part of the original version in any other project, these terms still apply." | The terms travel with the folder. AMC as a whole is free, ad-free and links the source, so it complies even under the broadest reading, where the terms would cover the combined app. |

Per-file headers: Cavern's `.cs` files carry no per-file copyright headers.
The project copyright is `Copyright © Bence Sgánetz 2016-2026` (from its
`.csproj`). Each derived AMC file carries that line, the repository link, the
creator link, the source file(s) and a pointer to `LICENSE`.

Nothing the owner asked for is forbidden by the licence: publishing a free,
attributed port with source link, in its own folder under Cavern's terms, is
exactly what it permits.

Not a licence matter, but noted: "Dolby" and "Dolby Atmos" are Dolby
Laboratories trademarks. The owner chose the UI string; the Third-party note
says AMC is not affiliated with Dolby.

## 4. Toolchain on this machine

| Tool | Status |
|---|---|
| .NET SDK | **Installed** via `dotnet-install.sh` (8.0.425) in `/tmp/dotnet`. Cavern.Format builds (`dotnet build -c Release`), so a bit-exact reference comparison is possible. |
| Emscripten | Not installed. The emsdk repo clones, but it isn't needed: **clang 18 + `wasm-ld` are preinstalled** and compile freestanding C to `wasm32` directly. If the JS hot loop misses the budget, that's the WASM path (`scripts/atmos-wasm.*`). `wabt`/`binaryen` are also reachable on npm. |
| ffmpeg | No system ffmpeg. A 2018 static build from npm (`@ffmpeg-installer/linux-x64`) is installed in `/tmp/tools` (outside the repo). It has the `eac3` decoder, and tests use it for `-f f32le` core reference output. Tests find it via `AMC_FFMPEG`. |
| Chromium / Playwright | Preinstalled (`/opt/pw-browsers`, global `playwright@1.56.1`), used for gate 4. |
| Test runner | Node 22 + esbuild (already a Vite dependency) bundles `test/atmos/*.ts` on the fly (`scripts/atmos-test.mjs`). No new `package.json` dependencies. |

## 5. Design

### Worker side (`processor.ts`)
1. **Factory**: parse `dec3`. No `flag_ec3_extension_type_a` means return `null`,
   and the engine plays the core untouched. Otherwise
   `maxChannels = min(32, 1 + complexity_index_type_a)` (LFE bed + objects).
2. **`process(packet, corePcm)`**: split the access unit into syncframes, parse
   each one (header → audio frame → blocks → skip fields/aux), and decode EMDF
   → JOC + OAMD exactly as Cavern does. Returns `null` for a frame with no JOC
   payload.
3. **JOC upmix**: analysis QMF (64 bands) on the 5 full-band core channels (FL
   FR FC SL SR; LFE is not JOC input), per-object mixing matrices interpolated
   per QMF timeslot, then synthesis QMF per object. Output = **bed: LFE only**
   (delayed to match the QMF latency) + **one channel per JOC object**. OAMD
   bed objects (speaker-anchored) are JOC objects too. They go out as object
   channels whose keyframes pin them to their bed speaker position, which is
   Cavern's own treatment (`OAMD.UpdateSources`). The renderer factory only
   learns channel *counts*, not labels, so a fixed `['LFE']` bed is the only
   layout it can infer reliably (see §7).
4. **Keyframes**: OAMD info blocks (offset + ramp) become breakpoints of a
   per-object piecewise-linear path in the output timeline (QMF latency added).
   The processor samples all objects at the union of breakpoints, so linear
   ramps between keyframes reproduce the path exactly.
5. **No per-frame allocation**: all buffers are preallocated on the first frame
   and reused. If the engine *transfers* the returned buffers to the Worklet
   (which detaches them), the processor notices the detached buffer and
   reallocates, so either engine behaviour works.

### Performance (measured at gate 3)
Cavern evaluates the QMF as direct 64×128 complex products. The port keeps
the same sums but folds them onto a 64-point DCT-IV/DST-IV pair, each one a
32-point complex FFT (verified against a direct transcription of Cavern's
code to 1e-13). Within a frame, the 1-data-point linear matrix ramp is
evaluated inside the mixing loop instead of being tabulated.

On this machine (Xeon @ 2.1 GHz, one thread, Node 22 / V8), with the real
file's 15 objects:

- **16× realtime**: about 1.8 ms per 32 ms frame at p50, 3.7 ms at p99.
- Processor state: about 1.9 MB.
- Per-frame JS allocation: about 7 KB, all of it the returned keyframe
  objects and OAMD bookkeeping. Audio buffers are reused.

A Chromebook-class core that is 2–3× slower still gives 5–8× realtime,
above the 3× budget, so the WASM path wasn't needed. Remaining time splits
evenly across mixing, the synthesis window and the DCTs, which is
irreducible filterbank work. `test/atmos/bench.test.ts` re-measures it.

### Main thread (`render/`)
- `input`: a discrete-interpretation `GainNode` → `ChannelSplitterNode`.
- **headphones**: each object → gain → `PannerNode` (`HRTF`, no distance
  rolloff), positioned by automation. LFE goes to a centre HRTF panner at
  −6 dB. Web Audio space is x right, y up, −z front, so z is negated.
- **speakers**: equal-power stereo panning from x, with a mild gain for height
  and rear folded into the front pair. LFE is sent to both channels at −6 dB.
- **multichannel**: VBAP over 5.1 / 7.1 / 7.1.4 (7.1.4 when
  `maxChannelCount >= 12`) in WAVE channel order, with LFE to the LFE channel.
  Sets `destination.channelCount`/`channelInterpretation = 'discrete'` and
  restores both on mode change and dispose.
- **Sync**: keyframes are stored in absolute played frames. Each
  `setPlayedFrame` re-anchors frame→`currentTime`. When drift exceeds a
  tolerance, or new keyframes arrived, automation is rescheduled with
  `cancelAndHoldAtTime` + `linearRampToValueAtTime` over a short look-ahead.
  Pause, seek (`reset`) and underruns therefore re-sync on the next frame
  report.
- **Mode switch**: two graphs (old and new) crossfade over 30 ms, then the old
  one is disconnected.

Verified at gate 4 in headless Chromium 141 (`test/atmos/render.test.ts`):
a synthetic object moves left → right → overhead through an
`OfflineAudioContext`, with keyframes relayed per 1536-frame block and the
played frame reported every ~107 ms.

- **Headphones**: at the left, ILD +13.6 dB and ITD +0.69 ms; mirrored at the
  right; overhead 0 dB / 0 ms. During a 180°/s sweep, Chrome's HRTF
  `PannerNode` trails the object by about 38 ms. That is its own
  azimuth-change smoothing; the automation itself is on time.
- **Speakers**: hard L → hard R, crossing the centre within 2 ms of the
  keyframes. Overhead is centred and 1.3 dB quieter (height folded in).
- **Multichannel 7.1.4**: the sides land 94% on SL/SR, overhead 25% on each
  top speaker, and nothing goes to the LFE. In 7.1, overhead folds to FC.
- **Sync**: a simulated 200 ms Worklet underrun shifts the automation by
  exactly 200 ms, because the renderer re-anchors on the next
  `setPlayedFrame`.
- **Mode switch**: headphones → speakers → headphones with a steady sine
  gives no roughness spike at either switch (0.7× the median).
- Nothing touches `AudioContext`, `window` or `document` at import time: the
  module is safe to import in the Worker.

## 6. Cavern behaviours that look like bugs

Found while porting. Each one is ported faithfully behind `cavernCompat: true`,
which only the reference comparison uses. The default (`cavernCompat: false`)
fixes it, and each fix is marked `DEVIATION` in the code.

1. **Timeslot wrap** (`JointObjectCodingApplier.Apply`):
   `if (++timeslot == input.Length)` wraps after 7 timeslots (`input` is the
   7-entry JOC input channel array), not after the frame's 24. Matrices are
   recomputed every 448 samples, out of phase with frames, and each
   interpolation only covers 7/24 of its ramp before jumping. It has been
   `== channels` since Cavern's first JOC commit (`3f7353a`). The default wraps
   at `frameSize / 64`.
2. **`BitExtractor.ReadSigned`**: `sign << (31 - bits) + value - sign` parses as
   `sign << ((31 - bits) + value - sign)`, and `sign = value & (1 << bits)`
   is always 0. So every OAMD differential position delta reads as 0 and
   differential updates repeat the last precise position. The default reads
   two's-complement `bits`-wide values.
3. **Zero-length ramps** (`OAElementMD.UpdateSources`): with `rampDuration` 0,
   `futureDistance` is ≤ 0 and the position never moves. The default applies
   the target immediately.
4. **Band mapping** (`GetMixingMatrices`): in two cases a band-indexed
   matrix is read by QMF *subband* index instead of through the
   parameter-band mapping. One is two data points with a steep slope; the
   other is the first half of two-data-point interpolation. And with one
   data point and a steep slope, a stale second data point can be used.
   The default indexes through the mapping and uses data point 0. The test
   file never takes these paths.
5. Sparse-coded JOC objects are decoded as silence, on purpose (Cavern:
   "documentation is incorrect"). Both modes keep this, and `process` counts
   such frames so the harness can report them.
6. `EnhancedAC3Body.ReadAux` passes `auxdatal` (a length in *bits*) to
   `ReadBytesInto`, which reads that many *bytes*. The default reads
   `auxdatal >> 3` bytes. The test file has no aux data.
7. `ParseSPX` re-creates `spxbndstrc` right after `ReadSPX` filled it, so the
   transmitted spectral-extension band structure is discarded. That would
   desync the walk on SPX streams with a non-trivial band structure. It is
   mirrored in both modes, because a wrong fix is worse than a known quirk.
   `access-unit.ts` falls back to a bit-level EMDF scan whenever a walk
   fails (see below). The test file uses no SPX.
8. `EnhancedAC3Decoder.DecodeFrame` resets "has objects" for every
   substream, so a dependent substream without EMDF would hide JOC in the
   independent one. By default, a JOC payload in any substream of the access
   unit counts.
9. Timing: Cavern's `BlockBuffer` fetches frame *k+1* while serving frame
   *k*'s last 64 samples, so each frame's OAMD update is applied one
   timeslot (64 samples) early, and object positions ignore the QMF delay.
   AMC schedules OAMD at its own sample offsets on the output timeline, QMF
   delay included.

**Fallback (AMC-original).** If a syncframe's audio blocks can't be walked
(AHT, enhanced coupling or stereo rematrixing, which Cavern also rejects, or
corruption), `ExtensibleMetadataDecoder.scanFrame` looks for an EMDF
container at every bit position and accepts one only if the EMDF and JOC
parse succeeds. That covers the common layout where the container sits in a
single skip field. On the test file it is never needed: all 8,689 syncframes
are walked.

## 7. Contract notes for the merge step (contract not edited)

> **Reconciled in v2.3.0.** The merge changed the contract on both sides: `SpatialProcessor`
> declares `bedLayout` (here `['LFE']`) and the renderer factory receives it as
> `(ctx, bedLayout, objectChannels)`; the `keyframes` comment now describes time-ordered
> keyframes with `positions[i]` for object channel *i*; `stats.objects` is part of the contract and
> feeds the "Dolby Atmos · n objects" label; `SpatialRenderer.setRate()` keeps automation on the
> audio at playback rates other than 1. The engine decodes the core with `drc_scale 0`. The notes
> below are as written before the merge.

- `SpatialRendererFactory` gets channel counts but not `bedLayout`. This
  add-on therefore always emits a bed of `['LFE']` (1 channel) or nothing, and
  the renderer assumes `bedChannels === 1` means LFE (and 6 = 5.1(side), 8 =
  7.1, if ever used).
- `SpatialBlock.keyframes` says "one entry per object channel". Read literally,
  that conflicts with `SpatialKeyframe` (a time + `positions[]`). This add-on
  emits time-ordered keyframes, each with `positions[i]` for object channel *i*
  (not bed channels).
- `process` assumes `corePcm` is the decode of *this* packet (same length,
  FFmpeg 5.1(side) order), with no decoder priming offset.
- The processor always returns exactly `maxChannels` channels (inactive
  objects are silent), so the Worklet channel count never changes mid-stream.
- The output is delayed by the QMF round trip, **577 samples** (12 ms at
  48 kHz), bed included, relative to the core (`jocLatency`). Keyframes
  already include that delay. If the engine shows a playhead from played
  frames, Atmos output lags it by 12 ms, which is inaudible for sync.
- Once dec3 flags JOC, `process` never returns `null`. Frames before the first
  JOC payload play Cavern's channel-based fallback, in the same channel
  layout, and frames that lose their JOC payload hold the last matrices. The
  Worklet channel count therefore never changes mid-track.
- FFmpeg applies E-AC-3 dynamic range compression by default. Its core
  differs from Cavern's (no DRC) by 2.3% RMS relative, or 0.6% with
  `-drc_scale 0`. The objects follow whatever core they are given, so this is
  the engine's call.

## 8. Contract harness (gate 5)

`test/atmos/harness.ts` plays the real file the way the engine will:

- Node slices each access unit from the MP4 and decodes the core with the
  system ffmpeg.
- A real Web Worker in headless Chromium imports `register.ts` and takes the
  processor from the registry. It reads `maxChannels`, calls `process()` per
  packet and transfers each block back, which detaches the processor's
  buffers.
- The main thread takes the renderer from the registry and plays the blocks
  back to back as the Worklet would. It relays keyframes stamped with each
  block's start frame 0.5 s ahead, calls `setPlayedFrame` every ~107 ms,
  resets both sides on a seek, and renders offline.

First 60 s, with a seek at 30 s:

| | |
|---|---|
| Worker realm | no `window`, no `document`; 1875 blocks, 3750 keyframes; 15.9× realtime inside Chromium's Worker; 0 fallback scans, 0 held frames |
| headphones | −18.8 LKFS, peak 0.925, no clipping; correlates 0.71 with the core at 577 + 295 samples (the QMF delay plus Chrome's HRTF latency) |
| speakers | −18.8 LKFS, peak 0.847; correlates **0.98–0.99** with the core's stereo downmix (577-sample delay) |
| multichannel 7.1.4 | −20.8 LKFS against the 5.1 core's −18.7, peak 0.537 |
| reference | core stereo downmix −16.9 LKFS, which itself peaks at 1.10 |

Make-up gains (`render/graphs.ts`) put every mode 2 dB under what the
engine plays without Atmos. A cross-track seek (10 s → 40 s) plays on with
no dropouts. The WAVs (`test/private/atmos-{headphones,speakers}.wav`) are
never committed.

## 9. Wiring it in (for the merge step)

Worker:
```ts
import './spatial/register';                       // registers both factories
const factory = getSpatialProcessorFactory();
const proc = factory?.({ codec: 'ec-3', sampleRate, coreChannels: 6, dec3 }); // null → plain 5.1
// Size the Worklet for proc.maxChannels (17 for this track: LFE + 16 object slots).
const block = proc.process(packetBytes, planarCorePcm);   // per access unit
// post block.pcm (transferable), block.keyframes, block.bedChannels to main
proc.reset();   // on seek / flush, before the next process()
proc.dispose(); // on track change
```
Main thread:
```ts
const renderer = getSpatialRendererFactory()!(ctx, 1, proc.maxChannels - 1);
workletNode.connect(renderer.input); renderer.output.connect(engineGain);
renderer.setMode(ctx.destination.maxChannelCount >= 6 ? 'multichannel' : userPrefersHeadphones ? 'headphones' : 'speakers');
renderer.pushKeyframes(blockStartPlayedFrame, block.keyframes); // as each block is queued
renderer.setPlayedFrame(workletPlayedFrames);                  // from Worklet position messages, ≥ 10 Hz
renderer.reset();                                              // on seek
```
- Labels: `atmosCodecLabel(n)`, where `n` is the object count. That count is
  not in the contract. The processor exposes it as `stats.objects` (15 here);
  `maxChannels − 1` is the upper bound. `atmosActivityLine(mode)` is the log
  line. `ATMOS_CREDIT` holds the licence credit (text + link) for Settings or
  About.
- Headphones vs speakers can't be detected by a browser. It has to be a
  setting, with 'speakers' as the renderer's default.
- After a seek, object output restarts 12 ms late (the QMF warm-up), and
  Chrome's HRTF adds ~6 ms of its own latency in headphones mode. A short
  fade-in on seek would hide the first; the second doesn't matter for sync.
- No limiter is included. On this loud master, headphones peak at −0.7 dBFS.
  If the engine has a master limiter, put it after `renderer.output`.
