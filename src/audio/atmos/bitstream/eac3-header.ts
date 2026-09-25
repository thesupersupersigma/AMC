/* E-AC-3 / AC-3 syncinfo + bit stream information parser.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Transcoders/EnhancedAC3Header.cs,
           EnhancedAC3Header/EAC3/BitStreamInformation.cs, EAC3/Mixing.cs,
           EAC3/Informational.cs, EnhancedAC3Header/AC3/BitStreamInformation.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   Only the decoding half is ported (no Encode/Write*). Cavern reads the
   frame through a BlockBuffer; here the whole access unit is in memory, so
   decode() takes the byte array plus the frame's offset. The field names
   follow Cavern's, which follow the ETSI TS 102 366 syntax. */

import { BitExtractor, ByteSink } from './bit-extractor';
import {
  Decoders,
  StreamTypes,
  channelArrangements,
  channelMappingTargets,
  frameSizes,
  mustDecode,
  numberOfBlocks,
  sampleRates,
  syncWord,
} from './eac3-consts';

const channelMappingBits = 16;

export class Eac3FormatError extends Error {}

/** Everything in one syncframe header that the body parser and the rest of
    the add-on need. */
export class EnhancedAC3Header {
  channelMode = 0;
  blocks = 0;
  lfe = false;
  sampleRate = 0;
  sampleRateCode = 0;
  substreamID = 0;
  wordsPerSyncframe = 0;
  decoder = 0;
  streamType = 0;

  // Private BSI state, kept with Cavern's names.
  private bsmod = 0;
  private channelMapping: number | null = null;
  private frmsizecod = 0;
  dialnorm = 0;
  compr: number | null = null;
  dialnorm2 = 0;
  compr2: number | null = null;
  private blkid = false;
  private convsync = false;
  private addbsie = false;
  private readonly addbsi = new ByteSink();
  // Mixing metadata
  mixingEnabled = false;
  centerDownmix = 0;
  surroundDownmix = 0;
  dmixmod = 0;
  lfemixlevcod: number | null = null;
  private pgmscl: number | null = null;
  private pgmscl2: number | null = null;
  private extpgmscl: number | null = null;
  private mixdef = 0;
  private mixdata = 0;
  private readonly mixdataLarge = new ByteSink();
  private paninfoe = false;
  private panmean = 0;
  private paninfo = 0;
  private paninfo2e = false;
  private panmean2 = 0;
  private paninfo2 = 0;
  private frmmixcfginfoe = false;
  private blkmixcfginfo: (number | null)[] = [];
  // Informational metadata
  private informationalMetadataEnabled = false;
  private copyrightBit = false;
  private originalBitstream = false;
  private dsurmod = 0;
  private dheadphonmod = 0;
  private dsurexmod = 0;
  private audprodie = false;
  private mixlevel = 0;
  private roomtyp = 0;
  private adconvtyp = false;
  private audprodi2e = false;
  private mixlevel2 = 0;
  private roomtyp2 = 0;
  private adconvtyp2 = false;
  private sourcefscod = false;
  // AC-3 only
  private langcod: number | null = null;
  private langcod2: number | null = null;
  private additionalDownmixInfo: number | null = null;
  private additionalMixInfo: number | null = null;

  private readonly extractor = new BitExtractor(new Uint8Array(0));

  /** Size in bytes of the syncframe starting at `offset`, from its first
      `mustDecode` bytes, or 0 if there is no syncframe there. */
  static frameBytes(data: Uint8Array, offset: number): number {
    if (offset + mustDecode > data.length) return 0;
    if (((data[offset] << 8) | data[offset + 1]) !== syncWord) return 0;
    const bsid = data[offset + 5] >> 3;
    if (bsid === Decoders.EAC3) {
      const frmsiz = ((data[offset + 2] & 7) << 8) | data[offset + 3];
      return (frmsiz + 1) * 2;
    }
    if (bsid <= Decoders.AC3) {
      const fscod = data[offset + 4] >> 6;
      const frmsizecod = data[offset + 4] & 63;
      if (frmsizecod >> 1 >= frameSizes.length) return 0;
      let words = frameSizes[frmsizecod >> 1];
      if (fscod === 1) {
        words = Math.trunc((words * 1393) / 1280);
        if ((frmsizecod & 1) === 1) ++words;
      } else if (fscod === 2) {
        words += words >> 1;
      }
      return words * 2;
    }
    return 0;
  }

  /** EnhancedAC3Header.Decode: parse syncinfo + BSI of the frame at
      `offset`. Returns the extractor positioned after the BSI, or null
      when there is no complete frame there. */
  decode(data: Uint8Array, offset: number): BitExtractor | null {
    const size = EnhancedAC3Header.frameBytes(data, offset);
    if (size === 0 || offset + size > data.length) {
      return null;
    }
    const extractor = this.extractor;
    extractor.reset(data.subarray(offset, offset + size));

    const readSyncWord = extractor.read(16);
    if (readSyncWord !== syncWord) {
      return null;
    }

    this.streamType = extractor.read(2);
    this.substreamID = extractor.read(3);
    this.wordsPerSyncframe = extractor.read(11) + 1;
    this.sampleRateCode = extractor.read(2);
    this.blocks = numberOfBlocks[extractor.read(2)];
    this.channelMode = extractor.read(3);
    this.lfe = extractor.readBit();
    this.decoder = parseDecoder(extractor.read(5));

    if (this.decoder !== Decoders.EAC3) {
      this.streamType = StreamTypes.Repackaged;
      this.substreamID = 0;
      this.blocks = 6;
      this.sampleRateCode = extractor.byteAt(4) >> 6;
      this.frmsizecod = extractor.byteAt(4) & 63;
      this.wordsPerSyncframe = size >> 1;
      this.bsmod = extractor.read(3);
      this.channelMode = extractor.read(3);
    }

    if (this.streamType === StreamTypes.Dependent) {
      this.substreamID += 8; // There can be 8 dependent and independent substreams, both start at 0
    }
    if (this.streamType === StreamTypes.Reserved) {
      throw new Eac3FormatError('reserved strmtyp');
    }
    if (this.sampleRateCode === 3) {
      throw new Eac3FormatError('reserved fscod');
    }
    this.sampleRate = sampleRates[this.sampleRateCode];

    this.channelMapping = null;
    switch (this.decoder) {
      case Decoders.AlternateAC3:
      case Decoders.AC3:
        this.readBitStreamInformation(extractor);
        break;
      case Decoders.EAC3:
        this.readBitStreamInformationEAC3(extractor);
        break;
    }
    return extractor;
  }

  /** Channel order of the full-bandwidth channels in this substream. */
  getChannelArrangement(): number[] {
    const channels = channelArrangements[this.channelMode].slice();
    if (this.channelMapping !== null) {
      let channel = 0;
      for (let i = channelMappingBits - 1; i > 0; --i) {
        if (((this.channelMapping >> i) & 1) === 1) {
          for (let j = 0; j < channelMappingTargets[i].length; ++j) {
            if (channel === channels.length) {
              throw new Eac3FormatError('chanmap');
            }
            channels[channel++] = channelMappingTargets[i][j];
          }
        }
      }
    }
    return channels;
  }

  /* ---- EAC3/BitStreamInformation.cs ---- */

  private readBitStreamInformationEAC3(extractor: BitExtractor): void {
    this.dialnorm = extractor.read(5);
    this.compr = extractor.readConditional(8);

    if (this.channelMode === 0) {
      this.dialnorm2 = extractor.read(5);
      this.compr2 = extractor.readConditional(8);
    }

    if (this.streamType === StreamTypes.Dependent) {
      this.channelMapping = extractor.readConditional(channelMappingBits);
    }
    this.readMixingMetadata(extractor);
    this.readInfoMetadata(extractor);
    if (this.streamType === StreamTypes.Independent && this.blocks !== 6) {
      this.convsync = extractor.readBit();
    }
    if (this.streamType === StreamTypes.Repackaged && (this.blkid = this.blocks === 6 || extractor.readBit())) {
      this.frmsizecod = extractor.read(6);
    }

    if ((this.addbsie = extractor.readBit())) {
      this.addbsi.clear();
      this.addbsi.readBytesFrom(extractor, extractor.read(6) + 1);
    }
  }

  /* ---- EAC3/Mixing.cs ---- */

  private readMixingMetadata(extractor: BitExtractor): void {
    if (!(this.mixingEnabled = extractor.readBit())) {
      return;
    }

    if (this.channelMode > 2) {
      this.dmixmod = extractor.read(2);
    }
    if ((this.channelMode & 1) !== 0 && this.channelMode > 2) {
      // 3 front channels present
      this.centerDownmix = extractor.read(6);
    }
    if ((this.channelMode & 0x4) !== 0) {
      // Surround present
      this.surroundDownmix = extractor.read(6);
    }
    if (this.lfe) {
      this.lfemixlevcod = extractor.readConditional(5);
    }

    if (this.streamType === StreamTypes.Independent) {
      this.pgmscl = extractor.readConditional(6);
      if (this.channelMode === 0) {
        this.pgmscl2 = extractor.readConditional(6);
      }
      this.extpgmscl = extractor.readConditional(6);

      this.mixdef = extractor.read(2);
      if (this.mixdef === 1) {
        this.mixdata = extractor.read(5);
      } else if (this.mixdef === 2) {
        this.mixdata = extractor.read(12);
      } else if (this.mixdef === 3) {
        this.mixdataLarge.clear();
        this.mixdataLarge.readBytesFrom(extractor, extractor.read(5) + 2);
      }

      if (this.channelMode < 2) {
        if ((this.paninfoe = extractor.readBit())) {
          this.panmean = extractor.read(8);
          this.paninfo = extractor.read(6);
        }
        if (this.channelMode === 0 && (this.paninfo2e = extractor.readBit())) {
          this.panmean2 = extractor.read(8);
          this.paninfo2 = extractor.read(6);
        }
      }

      // Mixing configuration information
      if ((this.frmmixcfginfoe = extractor.readBit())) {
        if (this.blkmixcfginfo.length !== this.blocks) {
          this.blkmixcfginfo = new Array<number | null>(this.blocks).fill(null);
        }
        if (this.blocks === 1) {
          this.blkmixcfginfo[0] = extractor.read(5);
        } else {
          for (let block = 0; block < this.blocks; block++) {
            this.blkmixcfginfo[block] = extractor.readConditional(5);
          }
        }
      }
    }
  }

  /* ---- EAC3/Informational.cs ---- */

  private readInfoMetadata(extractor: BitExtractor): void {
    if (!(this.informationalMetadataEnabled = extractor.readBit())) {
      return;
    }

    this.bsmod = extractor.read(3);
    this.copyrightBit = extractor.readBit();
    this.originalBitstream = extractor.readBit();
    if (this.channelMode === 2) {
      this.dsurmod = extractor.read(2);
      this.dheadphonmod = extractor.read(2);
    } else if (this.channelMode >= 6) {
      this.dsurexmod = extractor.read(2);
    }
    if ((this.audprodie = extractor.readBit())) {
      this.mixlevel = extractor.read(5);
      this.roomtyp = extractor.read(2);
      this.adconvtyp = extractor.readBit();
    }
    if (this.channelMode === 0) {
      if ((this.audprodi2e = extractor.readBit())) {
        this.mixlevel2 = extractor.read(5);
        this.roomtyp2 = extractor.read(2);
        this.adconvtyp2 = extractor.readBit();
      }
    }
    if (this.sampleRateCode < 3) {
      this.sourcefscod = extractor.readBit();
    }
  }

  /* ---- AC3/BitStreamInformation.cs ---- */

  private readBitStreamInformation(extractor: BitExtractor): void {
    if ((this.channelMode & 0x1) !== 0 && this.channelMode !== 0x1) {
      // 3 fronts exist
      this.centerDownmix = extractor.read(2);
    }
    if ((this.channelMode & 0x4) !== 0) {
      // Surrounds exist
      this.surroundDownmix = extractor.read(2);
    }
    if (this.channelMode === 0x2) {
      // Stereo
      this.dsurmod = extractor.read(2);
    }

    this.lfe = extractor.readBit();
    this.dialnorm = extractor.read(5);
    this.compr = extractor.readConditional(8);
    this.langcod = extractor.readConditional(8);
    if ((this.audprodie = extractor.readBit())) {
      this.mixlevel = extractor.read(5);
      this.roomtyp = extractor.read(2);
    }

    if (this.channelMode === 0) {
      this.dialnorm2 = extractor.read(5);
      this.compr2 = extractor.readConditional(8);
      this.langcod2 = extractor.readConditional(8);
      if ((this.audprodi2e = extractor.readBit())) {
        this.mixlevel2 = extractor.read(5);
        this.roomtyp2 = extractor.read(2);
      }
    }

    this.copyrightBit = extractor.readBit();
    this.originalBitstream = extractor.readBit();
    this.additionalDownmixInfo = extractor.readConditional(14);
    this.additionalMixInfo = extractor.readConditional(14);
    if ((this.addbsie = extractor.readBit())) {
      this.addbsi.clear();
      this.addbsi.readBytesFrom(extractor, extractor.read(6) + 1);
    }
  }
}

function parseDecoder(bsid: number): number {
  if (bsid === Decoders.AlternateAC3) {
    return Decoders.AlternateAC3;
  }
  if (bsid <= Decoders.AC3) {
    return Decoders.AC3;
  }
  if (bsid === Decoders.EAC3) {
    return Decoders.EAC3;
  }
  throw new Eac3FormatError('decoder ' + bsid);
}
