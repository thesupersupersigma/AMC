/* Splits one MP4 access unit into syncframes and runs header + body
   parsing, then EMDF decoding.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Decoders/EnhancedAC3Decoder.cs (DecodeFrame, ReadHeader)
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Cavern streams syncframes from a file and loops until the next
   independent substream 0. An MP4 access unit already holds exactly one
   such group (independent substream + any dependent substreams), so the
   loop runs over the syncframes in the packet instead.

   AMC additions:
   - If a syncframe's audio blocks can't be walked (a coding tool Cavern
     doesn't parse, or corruption), the EMDF container is looked for with a
     bit-level scan instead (ExtensibleMetadataDecoder.scanFrame).
   - DEVIATION (unless cavernCompat): Cavern resets "has objects" for every
     substream, so a dependent substream without EMDF would hide the
     independent one's JOC. Here any substream's JOC payload counts. */

import { BitExtractor } from './bit-extractor';
import { EnhancedAC3Body } from './eac3-body';
import { EnhancedAC3Header } from './eac3-header';
import { ExtensibleMetadataDecoder } from './emdf';

export interface AccessUnitStats {
  /** Syncframes seen. */
  syncframes: number;
  /** Syncframes whose audio blocks were fully walked. */
  parsed: number;
  /** Syncframes where the bit-level EMDF scan was used instead. */
  scanned: number;
  /** Syncframes where neither found a JOC payload. */
  withoutObjects: number;
  /** First parse error message, for the harness report. */
  firstError: string;
}

export interface AccessUnitResult {
  /** A JOC payload was decoded from this access unit. */
  hasObjects: boolean;
  /** An OAMD payload was decoded from this access unit. */
  hasOAMD: boolean;
  /** Samples per channel in this access unit (blocks * 256). */
  samples: number;
  /** Sample rate from the first syncframe header. */
  sampleRate: number;
}

export class AccessUnitParser {
  readonly header = new EnhancedAC3Header();
  readonly extensions: ExtensibleMetadataDecoder;
  readonly stats: AccessUnitStats = { syncframes: 0, parsed: 0, scanned: 0, withoutObjects: 0, firstError: '' };
  private readonly bodies = new Map<number, EnhancedAC3Body>();
  private readonly scratch = new BitExtractor(new Uint8Array(0));
  private readonly result: AccessUnitResult = { hasObjects: false, hasOAMD: false, samples: 0, sampleRate: 0 };

  constructor(private readonly cavernCompat = false) {
    this.extensions = new ExtensibleMetadataDecoder(cavernCompat);
  }

  /** Parse every syncframe of one access unit. The result object is reused. */
  parse(packet: Uint8Array): AccessUnitResult {
    const result = this.result;
    result.hasObjects = false;
    result.hasOAMD = false;
    result.samples = 0;
    result.sampleRate = 0;

    let offset = 0;
    while (offset < packet.length) {
      const size = EnhancedAC3Header.frameBytes(packet, offset);
      if (size === 0 || offset + size > packet.length) {
        break; // Trailing garbage or a truncated frame: nothing more to parse.
      }
      this.stats.syncframes++;
      this.parseSyncframe(packet, offset, size);
      const ext = this.extensions;
      if (this.cavernCompat) {
        result.hasObjects = ext.hasObjects;
        result.hasOAMD = ext.hasOAMD;
      } else {
        result.hasObjects ||= ext.hasObjects;
        result.hasOAMD ||= ext.hasOAMD;
      }
      if (!ext.hasObjects) this.stats.withoutObjects++;
      offset += size;
    }
    return result;
  }

  private parseSyncframe(packet: Uint8Array, offset: number, size: number): void {
    const header = this.header;
    const ext = this.extensions;
    let extractor: BitExtractor | null = null;
    try {
      extractor = header.decode(packet, offset);
    } catch (e) {
      this.noteError(e);
    }
    if (extractor === null) {
      this.scan(packet, offset, size);
      return;
    }
    if (header.substreamID === 0 && this.result.samples === 0) {
      this.result.samples = header.blocks * 256;
      this.result.sampleRate = header.sampleRate;
    }

    let body = this.bodies.get(header.substreamID);
    if (!body) {
      body = new EnhancedAC3Body(header, this.cavernCompat);
      this.bodies.set(header.substreamID, body);
    }
    try {
      body.prepareUpdate(extractor);
      body.update();
      this.stats.parsed++;
    } catch (e) {
      this.noteError(e);
      this.scan(packet, offset, size);
      return;
    }
    try {
      ext.decode(body.getAuxData());
    } catch (e) {
      // A payload that fails to decode: treat the frame as object-less.
      this.noteError(e);
      ext.hasObjects = false;
      ext.hasOAMD = false;
    }
    if (!ext.hasObjects && !this.cavernCompat) {
      // The walk succeeded but found no JOC: the container may sit where
      // the walk can't see it. Cheap enough to double-check.
      this.scan(packet, offset, size);
    }
  }

  private scan(packet: Uint8Array, offset: number, size: number): void {
    this.stats.scanned++;
    this.extensions.scanFrame(packet.subarray(offset, offset + size), this.scratch);
  }

  private noteError(e: unknown): void {
    if (!this.stats.firstError) {
      this.stats.firstError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Forget inter-frame parse state (seek / track change). */
  reset(): void {
    this.bodies.clear();
  }
}
