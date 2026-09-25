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

### Performance plan
The QMF is the cost: Cavern evaluates it as a direct 64×128 complex matrix.
The port keeps Cavern's exact maths but factors the modulation into a 128-point
FFT (pre/post twiddles). Numerically this is the same transform to float
rounding, at a fraction of the work. Budget: >3× realtime on one thread.
Measured and reported at gate 3. If JS misses it, the QMF + matrix loop moves
to a C→WASM module built with clang.

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
4. Two-data-point steep-slope interpolation indexes the parameter-band matrix
   by QMF subband without the band mapping. That code path is mirrored in both
   modes and only flagged here, because the spec's intent is unclear and
   Cavern is the reference.
5. Sparse-coded JOC objects are decoded as silence, on purpose (Cavern:
   "documentation is incorrect"). Both modes keep this, and `process` counts
   such frames so the harness can report them.

## 7. Contract notes for the merge step (contract not edited)

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
- The output is delayed by the QMF round trip (measured at gate 3), bed
  included, relative to the core. Keyframes already include that delay.
