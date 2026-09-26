import { registerSpatial } from './contract';
import { createJocProcessor } from '../atmos/processor';
import { createAtmosRenderer } from '../atmos/render';
registerSpatial(createJocProcessor, createAtmosRenderer);
