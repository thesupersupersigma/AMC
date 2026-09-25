/* SpatialProcessor for E-AC-3 JOC streams: runs in the decode Worker.
   AMC-original glue over the Cavern-derived parsers and upmixer in
   bitstream/ and joc/; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there).
   Gate 1 stub: returns null (no objects) until gates 2-3 land. */

import type { SpatialProcessor, SpatialProcessorFactory, SpatialStreamInfo } from '../spatial/contract';

export interface JocProcessorOptions {
  /** Reproduce Cavern's exact behaviour, including the bugs listed in
      docs/atmos/PLAN.md §6. Only the reference comparison sets this. */
  cavernCompat?: boolean;
}

export function createJocProcessorWith(info: SpatialStreamInfo, options: JocProcessorOptions = {}): SpatialProcessor | null {
  void info;
  void options;
  return null;
}

export const createJocProcessor: SpatialProcessorFactory = (info) => createJocProcessorWith(info);
