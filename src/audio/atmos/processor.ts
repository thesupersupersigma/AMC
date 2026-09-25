/* SpatialProcessor for E-AC-3 JOC streams: runs in the decode Worker.
   AMC-original glue over the Cavern-derived parsers and upmixer in
   bitstream/ and joc/; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there).
   Gate 2: the dec3 gate is in place (non-JOC streams get null); the upmix
   itself lands in gate 3, until then JOC streams also get null. */

import type { SpatialProcessor, SpatialProcessorFactory, SpatialStreamInfo } from '../spatial/contract';
import { parseDec3 } from './bitstream/dec3';

export interface JocProcessorOptions {
  /** Reproduce Cavern's exact behaviour, including the bugs listed in
      docs/atmos/PLAN.md §6. Only the reference comparison sets this. */
  cavernCompat?: boolean;
}

/** True when the stream's dec3 box signals JOC objects
    (flag_ec3_extension_type_a). */
export function streamCarriesObjects(info: SpatialStreamInfo): boolean {
  if (info.codec !== 'ec-3') return false;
  const dec3 = parseDec3(info.dec3);
  return dec3 !== null && dec3.jocExtension && dec3.complexityIndex > 0;
}

export function createJocProcessorWith(info: SpatialStreamInfo, options: JocProcessorOptions = {}): SpatialProcessor | null {
  void options;
  if (!streamCarriesObjects(info)) return null;
  return null;
}

export const createJocProcessor: SpatialProcessorFactory = (info) => createJocProcessorWith(info);
