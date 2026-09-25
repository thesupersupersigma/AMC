/* Speaker layouts for the renderer, and bed channel positions.
   Bed positions derive from Cavern (https://github.com/VoidXH/Cavern) by
   VoidX, http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern/Channels/ChannelPrototype.Consts.cs (AlternativePositions)
   The speaker layouts are AMC-original. Everything here is under the Cavern
   licence as part of src/audio/atmos/ (see LICENSE there), not AMC's MIT.

   Positions use AMC's listener space: x right, y up, z front, on the unit
   cube. Nothing here touches Web Audio. */

/** Bed channel label → position (ChannelPrototype.AlternativePositions). */
export const bedPositions: Record<string, [number, number, number]> = {
  FL: [-1, 0, 1],
  FR: [1, 0, 1],
  FC: [0, 0, 1],
  LFE: [-1, -1, 1],
  BL: [-1, 0, -1],
  BR: [1, 0, -1],
  SL: [-1, 0, 0],
  SR: [1, 0, 0],
  TFL: [-1, 1, 1],
  TFR: [1, 1, 1],
  TSL: [-1, 1, 0],
  TSR: [1, 1, 0],
  TBL: [-1, 1, -1],
  TBR: [1, 1, -1],
  WL: [-1, 0, 0.6774190068244934],
  WR: [1, 0, 0.6774190068244934],
};

/** Bed layouts the renderer can infer from a channel count alone (the
    factory is not told `bedLayout`; docs/atmos/PLAN.md §7). */
export function bedLayoutFor(bedChannels: number): string[] {
  switch (bedChannels) {
    case 0:
      return [];
    case 1:
      return ['LFE'];
    case 2:
      return ['FL', 'FR'];
    case 6:
      return ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'];
    case 8:
      return ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'];
    default: {
      // Unknown: treat the first as LFE, the rest as front-centre channels.
      const l = ['LFE'];
      for (let i = 1; i < bedChannels; i++) l.push('FC');
      return l;
    }
  }
}

export interface Speaker {
  label: string;
  /** Degrees, 0 = front, positive = right. */
  azimuth: number;
  /** Degrees above the ear plane. */
  elevation: number;
  lfe: boolean;
}

export interface SpeakerLayout {
  name: string;
  /** In output channel order. */
  speakers: Speaker[];
}

const sp = (label: string, azimuth: number, elevation = 0, lfe = false): Speaker => ({ label, azimuth, elevation, lfe });

/** Multichannel layouts in WAVE / Chromium channel order:
    5.1   = L R C LFE SL SR (Chromium CHANNEL_LAYOUT_5_1, side surrounds)
    7.1   = L R C LFE BL BR SL SR (CHANNEL_LAYOUT_7_1)
    7.1.4 = 7.1 + TFL TFR TBL TBR (WAVEFORMATEXTENSIBLE mask order) */
export function multichannelLayout(maxChannelCount: number): SpeakerLayout | null {
  if (maxChannelCount >= 12) {
    return {
      name: '7.1.4',
      speakers: [
        sp('FL', -30), sp('FR', 30), sp('FC', 0), sp('LFE', 0, 0, true),
        sp('BL', -150), sp('BR', 150), sp('SL', -90), sp('SR', 90),
        sp('TFL', -45, 45), sp('TFR', 45, 45), sp('TBL', -135, 45), sp('TBR', 135, 45),
      ],
    };
  }
  if (maxChannelCount >= 8) {
    return {
      name: '7.1',
      speakers: [
        sp('FL', -30), sp('FR', 30), sp('FC', 0), sp('LFE', 0, 0, true),
        sp('BL', -150), sp('BR', 150), sp('SL', -90), sp('SR', 90),
      ],
    };
  }
  if (maxChannelCount >= 6) {
    return {
      name: '5.1',
      speakers: [sp('FL', -30), sp('FR', 30), sp('FC', 0), sp('LFE', 0, 0, true), sp('SL', -110), sp('SR', 110)],
    };
  }
  return null;
}
