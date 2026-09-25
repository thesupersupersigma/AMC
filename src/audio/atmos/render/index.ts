/* SpatialRenderer for decoded Atmos objects: runs on the main thread.
   AMC-original; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there). Must not touch AudioContext,
   window or document at import time: the engine imports register.ts in the
   Worker too.
   Gate 1 stub: implemented in gate 4. */

import type { SpatialRenderer, SpatialRendererFactory } from '../../spatial/contract';

export const createAtmosRenderer: SpatialRendererFactory = (ctx, bedChannels, objectChannels): SpatialRenderer => {
  void ctx;
  void bedChannels;
  void objectChannels;
  throw new Error('Atmos renderer not implemented yet');
};
