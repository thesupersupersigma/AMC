/* E-AC-3 tables and enums.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Transcoders/EnhancedAC3Consts.cs, EnhancedAC3Enums.cs,
           EnhancedAC3Body/Consts.cs, EnhancedAC3Body/AllocationConstants.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Numeric tables were converted from the C# sources mechanically (hex to
   decimal, nothing else). Plain arrays keep this module free of top-level
   side effects. */

/** Cavern.Channels.ReferenceChannel, same numeric values. */
export const ReferenceChannel = {
  FrontLeft: 0,
  FrontRight: 1,
  FrontCenter: 2,
  ScreenLFE: 3,
  RearLeft: 4,
  RearRight: 5,
  SideLeft: 6,
  SideRight: 7,
  FrontLeftCenter: 8,
  FrontRightCenter: 9,
  HearingImpaired: 10,
  VisuallyImpaired: 11,
  Unknown: 12,
  MotionData: 13,
  ExternalData: 14,
  TopFrontLeft: 15,
  TopFrontRight: 16,
  TopSideLeft: 17,
  TopSideRight: 18,
  SignLanguage: 19,
  BottomSurround: 20,
  TopFrontCenter: 21,
  GodsVoice: 22,
  RearCenter: 23,
  WideLeft: 24,
  WideRight: 25,
  TopRearLeft: 26,
  TopRearRight: 27,
  TopRearCenter: 28,
} as const;

/** EnhancedAC3.Decoders (the bsid values that select a syntax). */
export const Decoders = { AlternateAC3: 6, AC3: 8, EAC3: 16 } as const;

/** EnhancedAC3.StreamTypes (strmtyp). */
export const StreamTypes = { Independent: 0, Dependent: 1, Repackaged: 2, Reserved: 3 } as const;

/** EnhancedAC3Body.ExpStrat. */
export const ExpStrat = { Reuse: 0, D15: 1, D25: 2, D45: 3 } as const;

/** EnhancedAC3Body.DeltaBitAllocationMode. */
export const DeltaBitAllocationMode = { Reuse: 0, NewInfoFollows: 1, NoAllocation: 2, MuteOutput: 3 } as const;

export const syncWord = 0x0b77;

/** Bytes that must be read to know the frame size (EnhancedAC3.mustDecode). */
export const mustDecode = 7;

export const frameSizes: number[] = [
  64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640, 768, 896,
  1024, 1152, 1280,
];

export const numberOfBlocks: number[] = [1, 2, 3, 6];

export const sampleRates: number[] = [48000, 44100, 32000];

/* Tables below use ReferenceChannel values as literals (with the name in a
   comment) so bundlers see them as side-effect free. */

/** Channel order of each acmod (EnhancedAC3.channelArrangements). */
export const channelArrangements: number[][] = [
  [2 /* FrontCenter */, 2 /* FrontCenter */], // 0: dual mono
  [2 /* FrontCenter */], // 1: mono
  [0 /* FrontLeft */, 1 /* FrontRight */], // 2: stereo
  [0 /* FrontLeft */, 2 /* FrontCenter */, 1 /* FrontRight */], // 3: 3.x (L, C, R)
  [0 /* FrontLeft */, 1 /* FrontRight */, 23 /* RearCenter */], // 4: 3.x (L, R, S)
  [0 /* FrontLeft */, 2 /* FrontCenter */, 1 /* FrontRight */, 23 /* RearCenter */], // 5: 4.x (L, C, R, S)
  [0 /* FrontLeft */, 1 /* FrontRight */, 6 /* SideLeft */, 7 /* SideRight */], // 6: 4.x (L, R, SL, SR)
  [0 /* FrontLeft */, 2 /* FrontCenter */, 1 /* FrontRight */, 6 /* SideLeft */, 7 /* SideRight */], // 7: 5.x (L, C, R, SL, SR)
];

/** Dependent substream chanmap bits, MSB first (EnhancedAC3.channelMappingTargets). */
export const channelMappingTargets: number[][] = [
  [3 /* ScreenLFE */],
  [3 /* ScreenLFE */],
  [17 /* TopSideLeft */, 18 /* TopSideRight */],
  [21 /* TopFrontCenter */],
  [15 /* TopFrontLeft */, 16 /* TopFrontRight */],
  [24 /* WideLeft */, 25 /* WideRight */],
  [3 /* ScreenLFE */, 3 /* ScreenLFE */], // Side surround, but not used
  [22 /* GodsVoice */],
  [23 /* RearCenter */],
  [4 /* RearLeft */, 5 /* RearRight */],
  [8 /* FrontLeftCenter */, 9 /* FrontRightCenter */],
  [7 /* SideRight */],
  [6 /* SideLeft */],
  [1 /* FrontRight */],
  [2 /* FrontCenter */],
  [0 /* FrontLeft */],
];

/* ---- EnhancedAC3Body/Consts.cs ---- */

export const nlfegrps = 2;
export const nlfemant = 7;
export const lfestrtmant = 0;
export const lfeendmant = 7;
export const maxAllocationSize = 256;

export const ecplsubbndtab: number[] = [
  13, 19, 25, 31, 37, 49, 61, 73, 85, 97, 109, 121, 133, 145, 157, 169,
  181, 193, 205, 217, 229, 241, 253,
];

export const frmcplexpstr_tbl: number[][] = [
  [1, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 0, 3],
  [1, 0, 0, 0, 2, 0],
  [1, 0, 0, 0, 3, 3],
  [2, 0, 0, 2, 0, 0],
  [2, 0, 0, 2, 0, 3],
  [2, 0, 0, 3, 2, 0],
  [2, 0, 0, 3, 3, 3],
  [2, 0, 1, 0, 0, 0],
  [2, 0, 2, 0, 0, 3],
  [2, 0, 2, 0, 2, 0],
  [2, 0, 2, 0, 3, 3],
  [2, 0, 3, 2, 0, 0],
  [2, 0, 3, 2, 0, 3],
  [2, 0, 3, 3, 2, 0],
  [2, 0, 3, 3, 3, 3],
  [3, 1, 0, 0, 0, 0],
  [3, 1, 0, 0, 0, 3],
  [3, 2, 0, 0, 2, 0],
  [3, 2, 0, 0, 3, 3],
  [3, 2, 0, 2, 0, 0],
  [3, 2, 0, 2, 0, 3],
  [3, 2, 0, 3, 2, 0],
  [3, 2, 0, 3, 3, 3],
  [3, 3, 1, 0, 0, 0],
  [3, 3, 2, 0, 0, 3],
  [3, 3, 2, 0, 2, 0],
  [3, 3, 2, 0, 3, 3],
  [3, 3, 3, 2, 0, 0],
  [3, 3, 3, 2, 0, 3],
  [3, 3, 3, 3, 2, 0],
  [3, 3, 3, 3, 3, 3],
];

export const slowdec: number[] = [15, 17, 19, 21];

export const fastdec: number[] = [63, 83, 103, 123];

export const slowgain: number[] = [1344, 1240, 1144, 1040];

export const dbpbtab: number[] = [0, 1792, 2304, 2816];

export const floortab: number[] = [752, 688, 624, 560, 496, 368, 240, -2048];

export const fastgain: number[] = [128, 256, 384, 512, 640, 768, 896, 1024];

export const bndtab: number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 31, 34, 37, 40,
  43, 46, 49, 55, 61, 67, 73, 79, 85, 97, 109, 121, 133, 157, 181, 205,
  229, 253,
];

export const masktab: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 28, 28, 29,
  29, 29, 30, 30, 30, 31, 31, 31, 32, 32, 32, 33, 33, 33, 34, 34,
  34, 35, 35, 35, 35, 35, 35, 36, 36, 36, 36, 36, 36, 37, 37, 37,
  37, 37, 37, 38, 38, 38, 38, 38, 38, 39, 39, 39, 39, 39, 39, 40,
  40, 40, 40, 40, 40, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
  41, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 44, 44, 44, 44, 44, 44, 44,
  44, 44, 44, 44, 44, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
  45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 46, 46, 46,
  46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46, 46,
  46, 46, 46, 46, 46, 47, 47, 47, 47, 47, 47, 47, 47, 47, 47, 47,
  47, 47, 47, 47, 47, 47, 47, 47, 47, 47, 47, 47, 47, 48, 48, 48,
  48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
  48, 48, 48, 48, 48, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49,
  49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 0, 0, 0,
];

export const latab: number[] = [
  64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 52, 51, 50,
  49, 48, 47, 47, 46, 45, 44, 44, 43, 42, 41, 41, 40, 39, 38, 38,
  37, 36, 36, 35, 35, 34, 33, 33, 32, 32, 31, 30, 30, 29, 29, 28,
  28, 27, 27, 26, 26, 25, 25, 24, 24, 23, 23, 22, 22, 21, 21, 21,
  20, 20, 19, 19, 19, 18, 18, 18, 17, 17, 17, 16, 16, 16, 15, 15,
  15, 14, 14, 14, 13, 13, 13, 13, 12, 12, 12, 12, 11, 11, 11, 11,
  10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8,
  7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5,
  5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

export const hth: number[][] = [
  [
    1232, 1232, 1088, 1024, 992, 960, 944, 944, 928, 928, 928, 928, 928, 912, 912, 912,
    896, 896, 880, 880, 864, 864, 848, 848, 832, 832, 816, 800, 784, 768, 752, 752,
    752, 752, 768, 784, 832, 912, 992, 1056, 1120, 1168, 1184, 1120, 1088, 1088, 1312, 2048,
    2112, 2112,
  ],
  [
    1264, 1264, 1120, 1040, 992, 976, 960, 944, 944, 928, 928, 928, 928, 928, 912, 912,
    912, 896, 896, 896, 880, 880, 864, 864, 848, 848, 832, 832, 800, 784, 768, 752,
    752, 752, 752, 768, 800, 848, 912, 992, 1056, 1104, 1184, 1168, 1120, 1088, 1152, 1584,
    2112, 2112,
  ],
  [
    1408, 1408, 1200, 1104, 1056, 1008, 992, 976, 960, 944, 944, 944, 928, 928, 928, 928,
    928, 928, 928, 928, 912, 912, 912, 912, 896, 896, 896, 880, 864, 848, 832, 816,
    800, 784, 768, 752, 752, 752, 768, 784, 816, 848, 960, 1040, 1136, 1184, 1120, 1088,
    1104, 1248,
  ],
];

export const baptab: number[] = [
  0, 1, 1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6,
  6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10,
  10, 10, 10, 11, 11, 11, 11, 12, 12, 12, 12, 13, 13, 13, 13, 14,
  14, 14, 14, 14, 14, 14, 14, 15, 15, 15, 15, 15, 15, 15, 15, 15,
];

export const bap1Bits = 5;
export const bap2Bits = 7;
export const bap3Bits = 3;
export const bap4Bits = 7;
export const bap5Bits = 4;

/** Number of bits to read for each value of a BAP table. */
export const bitsToRead: number[] = [0, bap1Bits, bap2Bits, bap3Bits, bap4Bits, bap5Bits, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16];

/* ---- EnhancedAC3Body/Parsers.cs ---- */

export const groupAdd: number[] = [-1, 2, 8];
export const groupDiv: number[] = [3, 6, 12];

/* ---- EnhancedAC3Body/Memory.cs (defaults, copied per body) ---- */

/** defcplbndstrc */
export const defaultCplbndstrc: boolean[] = [false, false, false, false, false, false, false, false, true, false,
  true, true, false, true, true, true, true, true];
/** defecplbndstrc */
export const defaultEcplbndstrc: boolean[] = [false, false, false, false, false, false, false, false, true, false,
  true, false, true, false, true, true, true, false, true, true, true];
