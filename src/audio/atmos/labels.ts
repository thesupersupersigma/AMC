/* UI copy for the Atmos add-on. AMC-original (distributed under Cavern's
   licence as part of this folder, see ./README.md). The merge step wires
   these into the engine's codec label and activity log; nothing here touches
   the DOM. */

import type { SpatialOutputMode } from '../spatial/contract';

/** Codec label while a JOC stream is actively decoded. */
export function atmosCodecLabel(objects: number): string {
  return `Dolby Atmos · ${objects} objects`;
}

const MODE_WORDS: Record<SpatialOutputMode, string> = {
  headphones: 'headphones',
  speakers: 'speakers',
  multichannel: 'multichannel speakers',
};

/** Activity-log line when object decoding starts or the output mode changes. */
export function atmosActivityLine(mode: SpatialOutputMode): string {
  return `Dolby Atmos objects decoded — rendering for ${MODE_WORDS[mode]}`;
}

/** Attribution Cavern's licence asks for when the software is used in public:
    the creator named with a link. Intended for Settings/About. */
export const ATMOS_CREDIT = {
  text: 'Dolby Atmos decoding uses a port of Cavern by VoidX',
  creatorUrl: 'http://en.sbence.hu',
  sourceUrl: 'https://github.com/VoidXH/Cavern',
} as const;
