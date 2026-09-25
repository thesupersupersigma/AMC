# `src/audio/atmos/`: Dolby Atmos (E-AC-3 JOC) decoding and rendering

**This folder is a TypeScript port of parts of
[Cavern](https://github.com/VoidXH/Cavern) by VoidX (Bence Sgánetz,
<http://en.sbence.hu>). Copyright © Bence Sgánetz 2016-2026.**

**Licence: everything in this folder is under Cavern's licence (see
[`LICENSE`](./LICENSE), copied verbatim from Cavern), not AMC's MIT licence.**
In short, from that licence: it is free and comes without warranty, modified
versions must be released free and must link the Cavern repository as their
source, no part of it may be sold, the software may not show advertisements,
the creator must be named with a link (http://en.sbence.hu) when it is used in
public or commercially, and the creator's permission is required for public use
such as screenings. These terms still apply wherever this code is included.
The `LICENSE` file is the binding text; this summary is not.

Source repository: <https://github.com/VoidXH/Cavern>, ported from commit
`1e34c81180df91d186c2d09304dfb4157a4cb9ce`.

## What derives from what

| Module | Derived from (Cavern) |
|---|---|
| `bitstream/bit-extractor.ts` | `Cavern.Format/Utilities/BitExtractor.cs`, `Cavern.Format/Decoders/EnhancedAC3/ExtensibleMetadataExtensions.cs` |
| `bitstream/eac3-consts.ts` | `Cavern.Format/Transcoders/EnhancedAC3Consts.cs`, `EnhancedAC3Enums.cs`, `EnhancedAC3Body/Consts.cs`, `EnhancedAC3Body/AllocationConstants.cs` |
| `bitstream/eac3-header.ts` | `Cavern.Format/Transcoders/EnhancedAC3Header.cs`, `EnhancedAC3Header/EAC3/*.cs`, `EnhancedAC3Header/AC3/BitStreamInformation.cs` |
| `bitstream/eac3-body.ts`, `bitstream/eac3-allocation.ts` | `Cavern.Format/Transcoders/EnhancedAC3Body.cs`, `EnhancedAC3Body/*.cs` (the parsing half: exponents, bit allocation, coupling, SPX, skip fields, mantissa walking) |
| `bitstream/access-unit.ts` | `Cavern.Format/Decoders/EnhancedAC3Decoder.cs` |
| `bitstream/emdf.ts` | `Cavern.Format/Decoders/EnhancedAC3/ExtensibleMetadataDecoder.cs` |
| `bitstream/joc.ts`, `bitstream/joc-tables.ts` | `Cavern.Format/Decoders/EnhancedAC3/JointObjectCoding.cs`, `JointObjectCodingTables.cs` |
| `bitstream/oamd.ts` | `Cavern.Format/Decoders/EnhancedAC3/ObjectAudioMetadata.cs`, `ObjectAudioElementMetadata.cs`, `ObjectInfoBlock.cs`, `ObjectAudioMetadataEnums.cs` |
| `joc/qmf.ts` | `Cavern.Format/Decoders/EnhancedAC3/QuadratureMirrorFilterBank.cs`, `QuadratureMirrorFilterBank.Process.cs` |
| `joc/matrix.ts` | `Cavern.Format/Decoders/EnhancedAC3/JointObjectCodingDecoder.cs`, `JointObjectCodingCache.cs` |
| `joc/applier.ts` | `Cavern.Format/Decoders/EnhancedAC3/JointObjectCodingApplier.cs` |
| `joc/upmix.ts` | `Cavern.Format/Renderers/EnhancedAC3Renderer.cs` |
| `render/layouts.ts` | bed speaker positions from `Cavern/Channels/ChannelPrototype.Consts.cs` (`AlternativePositions`) |

AMC-original code in this folder, still distributed under Cavern's licence as
part of it: `bitstream/dec3.ts` (the `dec3` box, ETSI TS 102 366 Annex F),
`processor.ts` (the `SpatialProcessor` glue), `render/` (`index.ts`,
`graphs.ts`, `panning.ts`, `timeline.ts`, and `layouts.ts` apart from the
bed positions), and `labels.ts`. Cavern's own rendering (its HRTF, IRs and
speaker renderer) is not used: headphones go through Chrome's built-in
HRTF `PannerNode`, and the speaker modes use AMC's own amplitude panning.

Where this port deliberately differs from Cavern, the code says
`DEVIATION` and explains why. Passing `cavernCompat: true` to the processor
restores Cavern's exact behaviour; the reference comparison uses it. See
`docs/atmos/PLAN.md` §6.

"Dolby", "Dolby Atmos" and "Dolby Digital Plus" are trademarks of Dolby
Laboratories. AMC and Cavern are not affiliated with Dolby.
