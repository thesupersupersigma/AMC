/* Entry point of the decode Worker. The spatial registration import comes
   first: the registry is per realm, and the Atmos add-on registers its
   SpatialProcessor from that module. */

import '../spatial/register';
import { startDecodeWorker } from './worker-core';

startDecodeWorker(self as unknown as Parameters<typeof startDecodeWorker>[0]);
