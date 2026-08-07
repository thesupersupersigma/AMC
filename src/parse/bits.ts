/* Bit reader used for STREAMINFO, whose fields are not byte aligned.
   v*2+bit rather than shifts so the 36-bit sample count stays exact —
   JavaScript bitwise operators are 32-bit and would silently corrupt it. */

export class Bits {
  b: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, byteStart?: number) {
    this.b = bytes;
    this.pos = (byteStart || 0) * 8;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3] || 0;
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}
