/* Parser for the `dec3` box payload (EC3SpecificBox, ETSI TS 102 366
   Annex F.6). AMC-original; distributed under the Cavern licence as part
   of src/audio/atmos/ (see README.md there).

   The optional two trailing bytes (7 reserved bits,
   flag_ec3_extension_type_a, complexity_index_type_a) are how MP4 signals
   Joint Object Coding: the flag says the stream carries JOC objects, the
   index is the maximum number of objects the decoder must render. */

export interface Dec3Substream {
  fscod: number;
  bsid: number;
  asvc: boolean;
  bsmod: number;
  acmod: number;
  lfeon: boolean;
  numDepSub: number;
  chanLoc: number;
}

export interface Dec3Info {
  /** Data rate in kb/s. */
  dataRate: number;
  independentSubstreams: Dec3Substream[];
  /** flag_ec3_extension_type_a: the stream carries JOC objects. */
  jocExtension: boolean;
  /** complexity_index_type_a: maximum number of JOC objects (0 when absent). */
  complexityIndex: number;
}

/** Returns null when the payload is too short to be a dec3 box. */
export function parseDec3(payload: Uint8Array): Dec3Info | null {
  let pos = 0;
  const bits = payload.length * 8;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      v = v * 2 + ((payload[pos >> 3] >> (7 - (pos & 7))) & 1);
    }
    return v;
  };

  if (bits < 16) return null;
  const dataRate = read(13);
  const numIndSub = read(3) + 1;
  const independentSubstreams: Dec3Substream[] = [];
  for (let i = 0; i < numIndSub; i++) {
    if (pos + 24 > bits) return null;
    const fscod = read(2);
    const bsid = read(5);
    read(1); // reserved
    const asvc = read(1) === 1;
    const bsmod = read(3);
    const acmod = read(3);
    const lfeon = read(1) === 1;
    read(3); // reserved
    const numDepSub = read(4);
    let chanLoc = 0;
    if (numDepSub > 0) {
      if (pos + 9 > bits) return null;
      chanLoc = read(9);
    } else {
      read(1); // reserved
    }
    independentSubstreams.push({ fscod, bsid, asvc, bsmod, acmod, lfeon, numDepSub, chanLoc });
  }

  let jocExtension = false;
  let complexityIndex = 0;
  if (pos + 16 <= bits) {
    read(7); // reserved
    jocExtension = read(1) === 1;
    complexityIndex = read(8);
  }
  return { dataRate, independentSubstreams, jocExtension, complexityIndex };
}
