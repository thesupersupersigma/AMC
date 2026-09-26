/* TEST-ONLY decode Worker entry: the real worker core, with the test
   spatial processor registered in THIS realm first. */
import { registerSpatial } from '../../src/audio/spatial/contract';
import { startDecodeWorker } from '../../src/audio/soft/worker-core';
import { makeTestRenderer, testProcessorFactory } from './test-processor';

registerSpatial(testProcessorFactory, makeTestRenderer({ created: [], modes: [], rates: [], keyframes: [], played: [], resets: 0, disposed: 0 }));
startDecodeWorker(self as unknown as Parameters<typeof startDecodeWorker>[0]);
