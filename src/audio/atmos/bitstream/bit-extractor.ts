/* MSB-first bit reader over a byte array.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Utilities/BitExtractor.cs,
           Cavern.Format/Decoders/EnhancedAC3/ExtensibleMetadataExtensions.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Reads are at most 24 bits wide everywhere in this add-on, so 32-bit JS
   integer arithmetic matches C#'s `int` exactly. Reading past the end of the
   array throws, like C#'s IndexOutOfRangeException, so a corrupt or
   unsupported frame fails loudly instead of decoding garbage. */

export class BitExtractor {
  /** Next bit to read. */
  position = 0;
  /** Bit position of the end of valid data. */
  backPosition: number;
  private source: Uint8Array;

  /** `lastByte`: number of valid bytes (Cavern's BitExtractor(source, lastByte)).
      Defaults to the whole array. */
  constructor(source: Uint8Array, lastByte?: number) {
    this.source = source;
    this.backPosition = (lastByte === undefined ? source.length : lastByte) * 8;
  }

  /** Re-point this extractor at new data without allocating. */
  reset(source: Uint8Array, lastByte?: number, position = 0): void {
    this.source = source;
    this.backPosition = (lastByte === undefined ? source.length : lastByte) * 8;
    this.position = position;
  }

  read(bits: number): number {
    const src = this.source;
    if (this.position + bits > src.length * 8) throw new RangeError('BitExtractor: read past end');
    let result = 0;
    while (bits > 0) {
      const removedLeft = this.position & 7;
      let removedRight = 0;
      if (removedLeft + bits < 8) {
        removedRight = 8 - removedLeft - bits;
      }
      const shiftBack = removedLeft + removedRight;
      const readBits = 8 - shiftBack;
      result = (result << readBits) + (((src[this.position >> 3] << removedLeft) & 0xff) >> shiftBack);
      bits -= readBits;
      this.position += readBits;
    }
    return result;
  }

  /** Cavern's ReadConditional: one flag bit, then `bits` if it was set. */
  readConditional(bits: number): number | null {
    if (this.readBitInt() !== 0) {
      return this.read(bits);
    }
    return null;
  }

  /** Cavern's ReadSigned, ported literally. In C#,
      `sign << (31 - bits) + value - sign` parses as
      `sign << ((31 - bits) + value - sign)`, and `sign` is always 0 because
      `value` never has bit `bits` set, so this always returns 0. Kept for
      cavernCompat; see readSignedTwos. */
  readSignedCavern(bits: number): number {
    const value = this.read(bits);
    const sign = value & (1 << bits);
    return sign << ((31 - bits) + value - sign);
  }

  /** DEVIATION from Cavern: a real two's-complement read of `bits` bits,
      which is what ReadSigned is meant to be (docs/atmos/PLAN.md §6.2). */
  readSignedTwos(bits: number): number {
    const value = this.read(bits);
    return value >= 1 << (bits - 1) ? value - (1 << bits) : value;
  }

  readBit(): boolean {
    return this.readBitInt() === 1;
  }

  readBitInt(): number {
    const p = this.position;
    if (p >= this.source.length * 8) throw new RangeError('BitExtractor: read past end');
    this.position = p + 1;
    return (this.source[p >> 3] >> (7 - (p & 7))) & 1;
  }

  /** Cavern's ReadBits: fills the array from the back. */
  readBits(bits: number): boolean[] {
    const result = new Array<boolean>(bits);
    while (bits-- > 0) {
      result[bits] = this.readBit();
    }
    return result;
  }

  skip(count: number): void {
    this.position += count;
  }

  byteAt(index: number): number {
    return this.source[index];
  }

  /** Read variable-length values from an EMDF stream
      (ExtensibleMetadataExtensions.VariableBits). */
  variableBits(bits: number, limit = -1): number {
    let value = 0;
    let readMore: boolean;
    do {
      value += this.read(bits);
      readMore = this.readBit();
      if (readMore) {
        value = (value + 1) << bits;
      }
    } while (readMore && limit-- !== 0);
    return value;
  }
}

/** Growable byte buffer standing in for Cavern's `ReadBytesInto(ref byte[], ref int, count)`. */
export class ByteSink {
  data = new Uint8Array(1024);
  length = 0;

  clear(): void {
    this.length = 0;
  }

  /** Append `count` whole bytes read from `extractor` (8 bits each, unaligned). */
  readBytesFrom(extractor: BitExtractor, count: number): void {
    if (this.length + count > this.data.length) {
      const grown = new Uint8Array(Math.max(this.data.length * 2, this.length + count));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    while (count-- > 0) {
      this.data[this.length++] = extractor.read(8);
    }
  }
}
