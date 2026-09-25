/* Object Audio Metadata parser.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3/ObjectAudioMetadata.cs,
           ObjectAudioElementMetadata.cs, ObjectInfoBlock.cs,
           ObjectAudioMetadataEnums.cs;
           Cavern/Channels/ChannelPrototype.Consts.cs (AlternativePositions)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Parsing is ported statement for statement. Cavern's UpdateSources methods
   (which move Cavern Source objects once per 64-sample timeslot) become
   data: every info block exposes its start sample, ramp length and each
   object's resolved target. joc/upmix.ts turns those into keyframes.
   Arithmetic that is float (System.Numerics.Vector3, float fields) in C#
   goes through Math.fround, so resolved positions match Cavern bit for bit. */

import type { BitExtractor } from './bit-extractor';
import { UnsupportedFeatureError } from './eac3-body';

/** C# float arithmetic: round to float32. */
function f(x: number): number {
  return Math.fround(x);
}

/** NonStandardBedChannel */
export const NonStandardBedChannel = {
  FrontLeft: 0,
  FrontRight: 1,
  Center: 2,
  LowFrequencyEffects: 3,
  SurroundLeft: 4,
  SurroundRight: 5,
  RearLeft: 6,
  RearRight: 7,
  TopFrontLeft: 8,
  TopFrontRight: 9,
  TopSurroundLeft: 10,
  TopSurroundRight: 11,
  TopRearLeft: 12,
  TopRearRight: 13,
  WideLeft: 14,
  WideRight: 15,
  LowFrequencyEffects2: 16,
  Max: 17,
} as const;

/** ObjectAnchor */
export const ObjectAnchor = { Room: 0, Screen: 1, Speaker: 2 } as const;

/** What each bit of a bed assignment means (ObjectAudioMetadata.bedChannels). */
export const bedChannels: number[] = [
  0 /* FrontLeft */, 1 /* FrontRight */, 2 /* FrontCenter */, 3 /* ScreenLFE */, 6 /* SideLeft */, 7 /* SideRight */, 4 /* RearLeft */, 5 /* RearRight */,
  15 /* TopFrontLeft */, 16 /* TopFrontRight */, 17 /* TopSideLeft */, 18 /* TopSideRight */, 26 /* TopRearLeft */, 27 /* TopRearRight */,
  24 /* WideLeft */, 25 /* WideRight */, 3 /* ScreenLFE */,
];

/** Which bedChannels are set with each bit of a standard layout. */
const standardBedChannels: number[][] = [[0, 1], [2], [3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15], [16]];

const isfObjectCount = [4, 8, 10, 14, 15, 30];

/** ChannelPrototype.AlternativePositions: speaker positions on the unit
    cube, x right, y up, z front, indexed by ReferenceChannel. */
export const alternativePositions: [number, number, number][] = [
  [-1, 0, 1], // FrontLeft
  [1, 0, 1], // FrontRight
  [0, 0, 1], // FrontCenter
  [-1, -1, 1], // ScreenLFE
  [-1, 0, -1], // RearLeft
  [1, 0, -1], // RearRight
  [-1, 0, 0], // SideLeft
  [1, 0, 0], // SideRight
  [-0.5, 0, 1], // FrontLeftCenter
  [0.5, 0, 1], // FrontRightCenter
  [0, 0, 1], // HearingImpaired
  [0, 0, 1], // VisuallyImpaired
  [0, 0, 1], // Unknown
  [0, 0, 1], // MotionData
  [0, 0, 1], // ExternalData
  [-1, 1, 1], // TopFrontLeft
  [1, 1, 1], // TopFrontRight
  [-1, 1, 0], // TopSideLeft
  [1, 1, 0], // TopSideRight
  [0, 0, 1], // SignLanguage
  [0, -1, 0], // BottomSurround
  [0, 1, 1], // TopFrontCenter
  [0, 1, 0], // GodsVoice
  [0, 0, -1], // RearCenter
  [-1, 0, 0.6774190068244934], // WideLeft (0.677419f)
  [1, 0, 0.6774190068244934], // WideRight (0.677419f)
  [-1, 1, -1], // TopRearLeft
  [1, 1, -1], // TopRearRight
  [0, 1, -1], // TopRearCenter
];

/** Every object's volume before OAMD sets one: EnhancedAC3Renderer's
    ".707f // E-AC-3 + JOC has a general -3 dB gain to prevent clipping". */
export const defaultObjectGain = 0.7070000171661377; // .707f

/** Per-object rendering state that info blocks update: Cavern's Source
    Volume/Size plus the resolved target position. Positions are Cavern's
    before its multiplication by Listener.EnvironmentSize, i.e. AMC's
    normalised listener space (x right, y up, z front). */
export interface ObjectTarget {
  x: number;
  y: number;
  z: number;
  gain: number;
  size: number;
}

/* ---- ObjectInfoBlock.cs ---- */

const xyScale = 0.016129031777381897; // 1/62f
const zScale = 0.06666667014360428; // 1/15f
const sizeScale = 0.032258063554763794; // 1/31f
const roomCenter = [0.5, 0.5, 0];
/** Float32 values of { 1.1f, 1.3f, 1.6f, 2.0f, 2.5f, 3.2f, 4.0f, 5.0f, 6.3f, 7.9f, 10.0f, 12.6f, 15.8f, 20.0f, 25.1f, 50.1f }. */
const distanceFactors = [
  1.100000023841858, 1.2999999523162842, 1.600000023841858, 2.0, 2.5, 3.200000047683716, 4.0, 5.0, 6.300000190734863, 7.900000095367432, 10.0, 12.600000381469727, 15.800000190734863, 20.0, 25.100000381469727, 50.099998474121094
];
const depthFactors = [0.25, 0.5, 1, 2];
/** Listener.ScreenSize default (.9f, .486f), as float32. */
const screenSize = [0.8999999761581421, 0.4860000014305115];

export class ObjectInfoBlock {
  /** This block contained a position information update. */
  validPosition = false;
  private differentialPosition = false;
  /** Object volume multiplier. Any negative value means reusing the last gain. */
  private gain = -1;
  /** Object distance from the center of the room. NaN when not given. */
  private distance = 0;
  /** Object size. Any negative value means reusing the last size. */
  private size = -1;
  private depthFactor = 0;
  private screenFactor = 0;
  private anchor: number = ObjectAnchor.Room;
  /** The coded position information, either exact or differential. */
  private px = 0;
  private py = 0;
  private pz = 0;
  /** Last fully transmitted position to add delta positions to. */
  private lx = 0;
  private ly = 0;
  private lz = 0;

  /** This object is not dynamic, but used as a bed channel. */
  get isBed(): boolean {
    return this.anchor === ObjectAnchor.Speaker;
  }

  /** Read new information for this block (Update). */
  update(extractor: BitExtractor, blk: number, bedOrISFObject: boolean, cavernCompat: boolean): void {
    const inactive = extractor.readBit();
    const basicInfoStatus = inactive ? 0 : blk === 0 ? 1 : extractor.read(2);
    if ((basicInfoStatus & 1) === 1) {
      this.objectBasicInfo(extractor, basicInfoStatus === 1);
    }

    let renderInfoStatus = 0;
    if (!inactive && !bedOrISFObject) {
      renderInfoStatus = blk === 0 ? 1 : extractor.read(2);
    }
    if ((renderInfoStatus & 1) === 1) {
      this.objectRenderInfo(extractor, blk, renderInfoStatus === 1, cavernCompat);
    }

    if (extractor.readBit()) {
      // Additional table data
      extractor.skip((extractor.read(4) + 1) * 8);
    }

    if (bedOrISFObject) {
      this.anchor = ObjectAnchor.Speaker;
    }
  }

  /** UpdateSource: applies gain and size to `target` and writes the final
      target position into it. The position is not applied immediately: it
      may have a ramp. */
  resolve(target: ObjectTarget): void {
    if (this.gain >= 0) {
      target.gain = this.gain;
    }
    if (this.size >= 0) {
      target.size = this.size;
    }

    if (this.validPosition && this.anchor !== ObjectAnchor.Speaker) {
      if (this.differentialPosition) {
        this.px = clamp01(f(this.lx + this.px));
        this.py = clamp01(f(this.ly + this.py));
        this.pz = clamp01(f(this.lz + this.pz));
      } else {
        this.lx = this.px;
        this.ly = this.py;
        this.lz = this.pz;
      }

      switch (this.anchor) {
        case ObjectAnchor.Room:
          if (!Number.isNaN(this.distance)) {
            // position.MapToCube()
            const max = Math.max(Math.abs(this.px), Math.max(Math.abs(this.py), Math.abs(this.pz)));
            const ix = f(this.px / max);
            const iy = f(this.py / max);
            const iz = f(this.pz / max);
            const length = f(Math.sqrt(f(f(f(ix * ix) + f(iy * iy)) + f(iz * iz))));
            const distanceFactor = f(length / this.distance);
            const rest = f(1 - distanceFactor);
            this.px = f(f(distanceFactor * ix) + f(rest * roomCenter[0]));
            this.py = f(f(distanceFactor * iy) + f(rest * roomCenter[1]));
            this.pz = f(f(distanceFactor * iz) + f(rest * roomCenter[2]));
          }
          break;
        case ObjectAnchor.Screen: {
          // DO NOT set Cavern's screen locking, it's a different algorithm
          const rx = f(f(f(this.px - 0.5) * screenSize[0]) + 0.5);
          const ry = this.py;
          const rz = f(f(this.pz + 1) * screenSize[1]);
          const sf = this.screenFactor;
          const depth = f(Math.pow(this.py, this.depthFactor));
          // depth * (sf * p + r - sf * r) + r - depth * r, per axis with y factors 1
          const ax = (p: number, r: number, s: number, d: number) =>
            f(f(f(d * f(f(f(s * p) + r) - f(s * r))) + r) - f(d * r));
          const nx = ax(this.px, rx, sf, depth);
          const ny = ax(this.py, ry, 1, 1);
          const nz = ax(this.pz, rz, sf, depth);
          this.px = nx;
          this.py = ny;
          this.pz = nz;
          break;
        }
      }
    }

    // Convert to Cavern coordinate space (without Listener.EnvironmentSize)
    target.x = f(f(this.px * 2) - 1);
    target.y = this.pz;
    target.z = f(f(this.py * -2) + 1);
  }

  private objectBasicInfo(extractor: BitExtractor, readAllBlocks: boolean): void {
    const blocks = readAllBlocks ? 3 : extractor.read(2);

    // Gain
    if ((blocks & 2) !== 0) {
      let gainHelper = extractor.read(2);
      let g: number;
      switch (gainHelper) {
        case 0:
          g = 1;
          break;
        case 1:
          g = 0;
          break;
        case 2:
          gainHelper = extractor.read(6);
          g = dbToGain(gainHelper < 15 ? 15 - gainHelper : 14 - gainHelper);
          break;
        default:
          g = -1;
      }
      this.gain = f(g * f(0.707)); // 3 dB attenuation as some content clip without this
    }

    // Priority - unnecessary, everything's rendered
    if ((blocks & 1) !== 0 && !extractor.readBit()) {
      extractor.skip(5);
    }
  }

  private objectRenderInfo(extractor: BitExtractor, blk: number, readAllBlocks: boolean, cavernCompat: boolean): void {
    const blocks = readAllBlocks ? 15 : extractor.read(4);

    // Spatial position
    if ((this.validPosition = (blocks & 1) !== 0)) {
      this.differentialPosition = blk !== 0 && extractor.readBit();
      if (this.differentialPosition) {
        // DEVIATION (unless cavernCompat): Cavern's ReadSigned always
        // returns 0, see BitExtractor.readSignedCavern.
        const x = cavernCompat ? extractor.readSignedCavern(3) : extractor.readSignedTwos(3);
        const y = cavernCompat ? extractor.readSignedCavern(3) : extractor.readSignedTwos(3);
        const z = cavernCompat ? extractor.readSignedCavern(3) : extractor.readSignedTwos(3);
        this.px = f(x * xyScale);
        this.py = f(y * xyScale);
        this.pz = f(z * zScale);
      } else {
        const posX = extractor.read(6);
        const posY = extractor.read(6);
        const posZ = ((extractor.readBitInt() << 1) - 1) * extractor.read(4);
        this.px = Math.min(1, f(posX * xyScale));
        this.py = Math.min(1, f(posY * xyScale));
        this.pz = Math.min(1, f(posZ * zScale));
      }
      if (extractor.readBit()) {
        // Distance specified
        if (extractor.readBit()) {
          // Infinite distance
          this.distance = 100; // Close enough
        } else {
          this.distance = distanceFactors[extractor.read(4)];
        }
      } else {
        this.distance = NaN;
      }
    }

    // Zone constraints - the renderer is not prepared for zoning
    if ((blocks & 2) !== 0) {
      extractor.skip(4);
    }

    // Scaling
    if ((blocks & 4) !== 0) {
      switch (extractor.read(2)) {
        case 0:
          this.size = 0;
          break;
        case 1:
          this.size = f(extractor.read(5) * sizeScale);
          break;
        case 2: {
          const sx = f(extractor.read(5) * sizeScale);
          const sy = f(extractor.read(5) * sizeScale);
          const sz = f(extractor.read(5) * sizeScale);
          this.size = f(Math.sqrt(f(f(f(sx * sx) + f(sy * sy)) + f(sz * sz))));
          break;
        }
        default:
          this.size = -1;
      }
    }

    // Screen anchoring
    if ((blocks & 8) !== 0 && extractor.readBit()) {
      this.anchor = ObjectAnchor.Screen;
      this.screenFactor = f((extractor.read(3) + 1) * 0.125);
      this.depthFactor = depthFactors[extractor.read(2)];
    }

    extractor.skip(1); // Snap to the nearest channel - unused
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** QMath.DbToGain: MathF.Pow(10, gain * .05f). */
function dbToGain(gain: number): number {
  return f(Math.pow(10, f(gain * f(0.05))));
}

/* ---- ObjectAudioElementMetadata.cs ---- */

const objectElementIndex = 1;
const sampleOffsetIndex = [8, 16, 18, 24];
const rampDurations = [0, 512, 1536];
const rampDurationIndex = [32, 64, 128, 256, 320, 480, 1000, 1001, 1024, 1600, 1601, 1602, 1920, 2000, 2002, 2048];

export class OAElementMD {
  /** Global sample offset, applied to all info blocks. */
  private sampleOffset = 0;
  /** The beginning of each info block in samples. Negative means this
      element carries no object location data. */
  blockOffsetFactor: number[] = [-1];
  /** Time to fade to a new position, in samples, for each info block. */
  rampDuration: number[] = [];
  /** [object][info block]; empty if the element is not an object element. */
  infoBlocks: ObjectInfoBlock[][] = [];

  /** Timecode of the first update in this block. */
  get minOffset(): number {
    return this.blockOffsetFactor[0];
  }

  read(extractor: BitExtractor, alternateObjectPresent: boolean, objectCount: number, bedOrISFObjects: number,
    cavernCompat: boolean): void {
    const elementIndex = extractor.read(4);
    const endPos = extractor.position + extractor.variableBits(4, 4) + 1;
    extractor.skip(alternateObjectPresent ? 5 : 1);
    if (elementIndex === objectElementIndex) {
      this.objectElement(extractor, objectCount, bedOrISFObjects, cavernCompat);
    } else {
      // Other elements are unused by encoders
      this.blockOffsetFactor = [-1 - elementIndex];
    }
    extractor.position = endPos; // Padding
  }

  private objectElement(extractor: BitExtractor, objectCount: number, bedOrISFObjects: number, cavernCompat: boolean): void {
    this.mdUpdateInfo(extractor);
    if (!extractor.readBit()) {
      // Reserved
      extractor.skip(5);
    }

    const blocks = this.rampDuration.length;
    if (this.infoBlocks.length !== objectCount || (objectCount > 0 && this.infoBlocks[0].length !== blocks)) {
      this.infoBlocks = [];
      for (let obj = 0; obj < objectCount; ++obj) {
        this.infoBlocks[obj] = [];
        for (let blk = 0; blk < blocks; ++blk) {
          this.infoBlocks[obj][blk] = new ObjectInfoBlock();
        }
      }
    }

    for (let obj = 0; obj < objectCount; ++obj) {
      for (let blk = 0; blk < blocks; ++blk) {
        this.infoBlocks[obj][blk].update(extractor, blk, obj < bedOrISFObjects, cavernCompat);
      }
    }
  }

  private mdUpdateInfo(extractor: BitExtractor): void {
    switch (extractor.read(2)) {
      case 0:
        this.sampleOffset = 0;
        break;
      case 1:
        this.sampleOffset = sampleOffsetIndex[extractor.read(2)];
        break;
      case 2:
        this.sampleOffset = extractor.read(5);
        break;
      default:
        throw new UnsupportedFeatureError('mdOffset');
    }
    const count = extractor.read(3) + 1;
    this.blockOffsetFactor = new Array<number>(count).fill(0);
    this.rampDuration = new Array<number>(count).fill(0);
    for (let blk = 0; blk < count; ++blk) {
      this.blockUpdateInfo(extractor, blk);
    }
  }

  private blockUpdateInfo(extractor: BitExtractor, blk: number): void {
    this.blockOffsetFactor[blk] = extractor.read(6) + this.sampleOffset;
    const rampDurationCode = extractor.read(2);
    if (rampDurationCode === 3) {
      if (extractor.readBit()) {
        this.rampDuration[blk] = rampDurationIndex[extractor.read(4)];
      } else {
        this.rampDuration[blk] = extractor.read(11);
      }
    } else {
      this.rampDuration[blk] = rampDurations[rampDurationCode];
    }
  }
}

/* ---- ObjectAudioMetadata.cs ---- */

export class ObjectAudioMetadata {
  /** Count of bed channels. */
  beds = 0;
  /** Number of audio objects in the stream, including beds. */
  objectCount = 0;
  /** Decoded object audio element metadata. */
  elements: OAElementMD[] = [];
  /** [bed instance][NonStandardBedChannel] */
  bedAssignment: boolean[][] = [];
  isfInUse = false;
  isfIndex = 0;
  /** This payload applies this many samples later (EMDF sample offset). */
  offset = 0;
  /** Frames decoded since construction, for reporting. */
  frames = 0;

  constructor(private readonly cavernCompat = false) {}

  decode(extractor: BitExtractor, offset: number): void {
    this.offset = offset;
    let versionNumber = extractor.read(2);
    if (versionNumber === 3) {
      versionNumber += extractor.read(3);
    }
    if (versionNumber !== 0) {
      throw new UnsupportedFeatureError('OAver');
    }
    this.objectCount = extractor.read(5) + 1;
    if (this.objectCount === 32) {
      this.objectCount += extractor.read(7);
    }
    this.programAssignment(extractor);
    const alternateObjectPresent = extractor.readBit();
    let elementCount = extractor.read(4);
    if (elementCount === 15) {
      elementCount += extractor.read(5);
    }

    let bedOrISFObjects = this.beds;
    if (this.isfInUse) {
      bedOrISFObjects += isfObjectCount[this.isfIndex];
    }

    if (this.elements.length !== elementCount) {
      this.elements = [];
      for (let i = 0; i < elementCount; ++i) {
        this.elements[i] = new OAElementMD();
      }
    }
    for (let i = 0; i < elementCount; ++i) {
      this.elements[i].read(extractor, alternateObjectPresent, this.objectCount, bedOrISFObjects, this.cavernCompat);
    }
    this.frames++;
  }

  /** The "objects" that are just static channels (ReferenceChannel values). */
  getStaticChannels(): number[] {
    const result = new Array<number>(this.beds).fill(0);
    let lastChannel = 0;
    for (let i = 0; i < this.bedAssignment.length; i++) {
      const assignment = this.bedAssignment[i];
      for (let j = 0; j < assignment.length; j++) {
        if (assignment[j]) {
          result[lastChannel] = bedChannels[j];
          if (++lastChannel === this.beds) {
            return result;
          }
        }
      }
    }
    return result;
  }

  /** Which object is the LFE channel, or -1 if it's not present. */
  getLFEPosition(): number {
    let beds = 0;
    for (let bed = 0; bed < this.bedAssignment.length; bed++) {
      for (let i = 0; i < NonStandardBedChannel.Max; i++) {
        if (this.bedAssignment[bed][i]) {
          if (i === NonStandardBedChannel.LowFrequencyEffects) {
            return beds;
          }
          ++beds;
        }
      }
    }
    return -1;
  }

  /** UpdateSources' element choice: the last object element whose first
      update is not after `timecode` (samples since the frame start, minus
      nothing: the EMDF offset is subtracted here like Cavern does). */
  selectElement(timecode: number): number {
    timecode -= this.offset;
    let element = 0;
    for (let i = this.elements.length - 1; i >= 0; --i) {
      if (this.elements[i].minOffset < 0) {
        continue;
      }
      if (this.elements[i].minOffset <= timecode) {
        element = i;
        break;
      }
    }
    return element;
  }

  private programAssignment(extractor: BitExtractor): void {
    const max = NonStandardBedChannel.Max;
    if (extractor.readBit()) {
      // Dynamic object-only program
      if (extractor.readBit()) {
        // LFE present
        this.bedAssignment = [new Array<boolean>(max).fill(false)];
        this.bedAssignment[0][NonStandardBedChannel.LowFrequencyEffects] = true;
      } else {
        this.bedAssignment = [];
      }
    } else {
      const contentDescription = extractor.read(4);

      // Object(s) with speaker-anchored coordinate(s) (bed objects)
      if ((contentDescription & 1) !== 0) {
        extractor.skip(1); // The object is distributable - Cavern will do it anyway
        const instances = extractor.readBit() ? extractor.read(3) + 2 : 1;
        this.bedAssignment = [];
        for (let bed = 0; bed < instances; ++bed) {
          this.bedAssignment[bed] = new Array<boolean>(max).fill(false);
          if (extractor.readBit()) {
            // LFE only
            this.bedAssignment[bed][NonStandardBedChannel.LowFrequencyEffects] = true;
          } else {
            if (extractor.readBit()) {
              // Standard bed assignment
              const standardAssignment = extractor.readBits(10);
              for (let i = 0; i < standardAssignment.length; ++i) {
                for (let j = 0; j < standardBedChannels[i].length; ++j) {
                  this.bedAssignment[bed][standardBedChannels[i][j]] = standardAssignment[i];
                }
              }
            } else {
              this.bedAssignment[bed] = extractor.readBits(max);
            }
          }
        }
      }

      // Intermediate spatial format (ISF)
      if ((this.isfInUse = (contentDescription & 2) !== 0)) {
        this.isfIndex = extractor.read(3);
        if (this.isfIndex >= isfObjectCount.length) {
          throw new UnsupportedFeatureError('ISF');
        }
      }

      // Object(s) with room-anchored or screen-anchored coordinates
      if ((contentDescription & 4) !== 0) {
        // This is useless, same as ObjectCount - bedOrISFObjects, also found in JOC
        if (extractor.read(5) === 31) {
          extractor.skip(7);
        }
      }

      // Reserved
      if ((contentDescription & 8) !== 0) {
        extractor.skip((extractor.read(4) + 1) * 8);
      }
    }

    this.beds = 0;
    for (let bed = 0; bed < this.bedAssignment.length; ++bed) {
      for (let i = 0; i < max; ++i) {
        if (this.bedAssignment[bed][i]) {
          ++this.beds;
        }
      }
    }
  }
}
