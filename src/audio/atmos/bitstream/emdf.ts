/* EMDF container decoder: finds the JOC and OAMD payloads.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3/ExtensibleMetadataDecoder.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Decodes Extensible Metadata Delivery Format from the reserved fields
   (skip fields + aux data) of an E-AC-3 frame. scanFrame() is AMC-original:
   a fallback for frames whose audio blocks can't be walked (see
   access-unit.ts). */

import { BitExtractor } from './bit-extractor';
import { JointObjectCoding } from './joc';
import { ObjectAudioMetadata } from './oamd';

/** EMDF marker. */
const syncWord = 0x5838;
/** Payload ID for Object Audio Metadata. */
const oamdPayloadID = 11;
/** Payload ID for Joint Object Coding. */
const jocPayloadID = 14;

export class ExtensibleMetadataDecoder {
  /** The last decoded frame contained object data (a JOC payload). */
  hasObjects = false;
  /** The last decoded frame contained an OAMD payload. */
  hasOAMD = false;
  /** There can be only one JOC payload in every E-AC-3 frame. */
  readonly joc = new JointObjectCoding();
  /** There can be only one OAMD payload in every E-AC-3 frame. */
  readonly oamd: ObjectAudioMetadata;

  constructor(cavernCompat = false) {
    this.oamd = new ObjectAudioMetadata(cavernCompat);
  }

  /** Decode the next EMDF frame from a bitstream. */
  decode(extractor: BitExtractor): void {
    this.hasObjects = false;
    this.hasOAMD = false;
    let syncword = 0;
    while (extractor.position < extractor.backPosition - 32) {
      syncword = ((syncword << 8) & 0xffff) + extractor.read(8); // Syncwords are byte-padded
      if (syncword === syncWord && this.decodeBlock(extractor)) {
        break;
      }
    }
  }

  /** AMC fallback: look for an EMDF container at every *bit* position of a
      raw syncframe. Used only when the frame's audio blocks can't be
      parsed, so the skip fields are unknown. Works when the container sits
      in a single skip field, as it does in the streams we have seen. A
      candidate is accepted only if decodeBlock parses it, including the
      JOC payload, without error. Returns true if objects were found. */
  scanFrame(frame: Uint8Array, scratch: BitExtractor): boolean {
    this.hasObjects = false;
    this.hasOAMD = false;
    const bits = frame.length * 8;
    for (let p = 0; p + 64 < bits; p++) {
      // Cheap pre-check of the 16-bit sync at bit p.
      const byte = p >> 3;
      const shift = p & 7;
      const w = ((frame[byte] << 16) | (frame[byte + 1] << 8) | (frame[byte + 2] ?? 0)) >>> (8 - shift);
      if ((w & 0xffff) !== syncWord) continue;
      scratch.reset(frame, frame.length, p + 16);
      try {
        if (this.decodeBlock(scratch) && this.hasObjects) {
          return true;
        }
      } catch {
        /* not a real container; keep scanning */
      }
      this.hasObjects = false;
      this.hasOAMD = false;
    }
    return false;
  }

  /** Tries to decode an EMDF block, returns if succeeded. Assumes the sync
      word was already read. */
  private decodeBlock(extractor: BitExtractor): boolean {
    const length = extractor.read(16);
    const frameEndPos = extractor.position + length * 8;
    if (frameEndPos > extractor.backPosition) {
      return false;
    }

    let version = extractor.read(2);
    if (version === 3) {
      version += extractor.variableBits(2);
    }
    let key = extractor.read(3);
    if (key === 7) {
      key += extractor.variableBits(3);
    }
    if (version !== 0 || key !== 0) {
      return false;
    }

    let payloadID: number;
    while (extractor.position < frameEndPos && (payloadID = extractor.read(5)) !== 0) {
      if (payloadID === 0x1f) {
        payloadID += extractor.variableBits(5);
      }
      if (payloadID > jocPayloadID) {
        return false;
      }

      let hasSampleOffset: boolean;
      let sampleOffset = 0;
      if ((hasSampleOffset = extractor.readBit())) {
        sampleOffset = extractor.read(12) >> 1; // Skip 1 bit
      }

      if (extractor.readBit()) {
        extractor.variableBits(11);
      }
      if (extractor.readBit()) {
        extractor.variableBits(2);
      }
      if (extractor.readBit()) {
        extractor.skip(8);
      }

      if (!extractor.readBit()) {
        let frameAligned = false;
        if (!hasSampleOffset) {
          frameAligned = extractor.readBit();
          if (frameAligned) {
            extractor.skip(2);
          }
        }
        if (hasSampleOffset || frameAligned) {
          extractor.skip(7);
        }
      }

      const payloadEnd = extractor.variableBits(8) * 8 + extractor.position;
      if (payloadEnd > extractor.backPosition) {
        return false;
      }
      if (payloadID === jocPayloadID) {
        this.joc.decode(extractor);
        this.hasObjects = true;
      } else if (payloadID === oamdPayloadID) {
        this.oamd.decode(extractor, sampleOffset);
        this.hasOAMD = true;
      }
      extractor.position = payloadEnd;
    }
    return true;
  }
}
