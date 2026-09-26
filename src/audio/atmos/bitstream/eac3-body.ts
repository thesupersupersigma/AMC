/* E-AC-3 audio frame/block parser: walks exponents, bit allocation and
   mantissas to collect the skip fields and aux data that carry EMDF.
   Derived from Cavern (https://github.com/VoidXH/Cavern) by VoidX,
   http://en.sbence.hu. Copyright © Bence Sgánetz 2016-2026.
   Source: Cavern.Format/Transcoders/EnhancedAC3Body.cs,
           EnhancedAC3Body/DecodeAudioFrame.cs, DecodeAudioBlock.cs,
           Coupling.cs, SPX.cs, Parsers.cs, BitAllocation.cs, Memory.cs
   Under the Cavern licence (see LICENSE in src/audio/atmos/), not AMC's MIT.

   This is the parsing half of Cavern's decoder, statement for statement,
   with the audio reconstruction removed: no dequantisation, coupling
   application or IMDCT, because FFmpeg decodes the core. What remains is
   everything needed to know how many bits each block's mantissas take,
   because an audio block's skip field (where JOC streams carry EMDF) comes
   before its mantissas and after the previous block's. Unsupported coding
   tools throw like Cavern's (AHT, enhanced coupling, stereo rematrixing);
   the caller falls back to a bit-level EMDF scan in that case. */

import { BitExtractor, ByteSink } from './bit-extractor';
import { Allocation, DeltaBitAllocation, type MantissaHistory } from './eac3-allocation';
import {
  Decoders,
  DeltaBitAllocationMode,
  ExpStrat,
  StreamTypes,
  bndtab,
  dbpbtab,
  defaultCplbndstrc,
  defaultEcplbndstrc,
  ecplsubbndtab,
  fastdec,
  fastgain,
  floortab,
  frmcplexpstr_tbl,
  groupAdd,
  groupDiv,
  hth,
  lfeendmant,
  lfestrtmant,
  masktab,
  maxAllocationSize,
  nlfegrps,
  slowdec,
  slowgain,
  baptab,
} from './eac3-consts';
import type { EnhancedAC3Header } from './eac3-header';
import { Eac3FormatError } from './eac3-header';

export class UnsupportedFeatureError extends Error {
  constructor(feature: string) {
    super('Unsupported E-AC-3 feature: ' + feature);
  }
}

/** Parsing statistics, for tests and the harness report. */
export interface BodyStats {
  couplingBlocks: number;
  spxBlocks: number;
  skipFieldBytes: number;
  auxBytes: number;
}

export class EnhancedAC3Body implements MantissaHistory {
  /** Full-bandwidth channels of this substream (ReferenceChannel values). */
  channels: number[] = [];

  // AllocationHistory
  bap1Pos = 0;
  bap2Pos = 0;
  bap4Pos = 0;

  readonly stats: BodyStats = { couplingBlocks: 0, spxBlocks: 0, skipFieldBytes: 0, auxBytes: 0 };

  private extractor!: BitExtractor;
  private readonly aux = new ByteSink();
  private readonly auxExtractor = new BitExtractor(new Uint8Array(0));
  private cachesFor = -1;

  // ---- Memory.cs ----
  private allocation: Allocation[] = [];
  private couplingAllocation!: Allocation;
  private lfeAllocation!: Allocation;

  private skipFieldSyntaxEnabled = false;
  private skipLengthEnabled = false;
  private skipLength = 0;

  private ahte = false;
  private baie = false;
  private bamode = false;
  private blkstrtinfoe = false;
  private blkswe = false;
  private convexpstre = false;
  private convsnroffste = false;
  private cplbndstrce = false;
  private cplleake = false;
  private dbaflde = false;
  private deltbaie = false;
  private dithflage = false;
  private ecplbndstrce = false;
  private ecplinu = false;
  private expstre = false;
  private fgaincode = false;
  private firstcplleak = false;
  private frmfgaincode = false;
  private phsflginu = false;
  private snroffste = false;
  private spxattene = false;
  private spxbndstrce = false;
  private spxinu = false;
  private spxstre = false;
  private transproce = false;
  private blksw: boolean[] = [];
  private chincpl: boolean[] = [];
  private chinspx: boolean[] = [];
  private chinspxatten: boolean[] = [];
  private chintransproc: boolean[] = [];
  private cplcoe: boolean[] = [];
  private cplinu: boolean[] = [];
  private cplstre: boolean[] = [];
  private dithflag: boolean[] = [];
  private firstcplcos: boolean[] = [];
  private firstspxcos: boolean[] = [];
  private lfeexpstr: boolean[] = [];
  private spxbndstrc: boolean[] = [];
  private spxcoe: boolean[] = [];
  private cpldeltba = new DeltaBitAllocation();
  private lfedeltba = new DeltaBitAllocation();
  private deltba: DeltaBitAllocation[] = [];
  private cplexpstr: number[] = [];
  private chexpstr: number[][] = [];
  private blkfsnroffst = 0;
  private blkstrtinfo = 0;
  private convsnroffst = 0;
  private cplbegf = 0;
  private cplendf = 0;
  private cplendmant = 0;
  private cplfgaincod = 0;
  private cplfleak = 0;
  private cplfsnroffst = 0;
  private cplsleak = 0;
  private cplstrtmant = 0;
  private csnroffst = 0;
  private dbpbcod = 0;
  private ecpl_begin_subbnd = 0;
  private ecpl_end_subbnd = 0;
  private ecplbegf = 0;
  private ecplendf = 0;
  private ecplendmant = 0;
  private ecplstartmant = 0;
  private fdcycod = 0;
  private floorcod = 0;
  private frmcplexpstr = 0;
  private frmcsnroffst = 0;
  private frmfsnroffst = 0;
  private lfefgaincod = 0;
  private lfefsnroffst = 0;
  private ncplbnd = 0;
  private ncplgrps = 0;
  private ncplsubnd = 0;
  private nspxbnds = 0;
  private sdcycod = 0;
  private sgaincod = 0;
  private snroffststr = 0;
  private spx_begin_subbnd = 0;
  private spx_end_subbnd = 0;
  private spxbegf = 0;
  private spxendf = 0;
  private spxstrtf = 0;
  private dynrng: number | null = null;
  private dynrng2: number | null = null;
  private chbwcod: number[] = [];
  private convexpstr: number[] = [];
  private endmant: number[] = [];
  private fgaincod: number[] = [];
  private frmchexpstr: number[] = [];
  private fsnroffst: number[] = [];
  private mstrcplco: number[] = [];
  private mstrspxco: number[] = [];
  private nchgrps: number[] = [];
  private spxattencod: number[] = [];
  private spxblnd: number[] = [];
  private spxbndsztab: number[] = [];
  private transproclen: number[] = [];
  private transprocloc: number[] = [];
  private cplco: number[][] = [];
  private cplcoexp: number[][] = [];
  private cplcomant: number[][] = [];
  private spxcoexp: number[][] = [];
  private spxcomant: number[][] = [];

  private readonly cplbndstrc = defaultCplbndstrc.slice();
  private readonly ecplbndstrc = defaultEcplbndstrc.slice();

  /** `cavernCompat`: read aux data exactly as Cavern does (see readAux). */
  constructor(private readonly header: EnhancedAC3Header, private readonly cavernCompat = false) {}

  /* ---- EnhancedAC3Body.cs ---- */

  /** Do the mandatory steps before reading the audio blocks. */
  prepareUpdate(extractor: BitExtractor): void {
    this.extractor = extractor;
    this.channels = this.header.getChannelArrangement();
    if (this.cachesFor !== this.channels.length) {
      // If caches don't exist, create them
      this.createCacheTables(this.header.blocks, this.channels.length);
    }
    if (this.header.decoder === Decoders.EAC3) {
      this.decodeAudioFrame();
    } else {
      this.blkswe = true;
      this.dithflage = true;
      this.bamode = true;
      this.snroffststr = -1;
      this.frmfgaincode = false;
      this.firstcplleak = false;
      this.dbaflde = true;
      this.skipFieldSyntaxEnabled = true;
    }
  }

  /** Skip fields + aux data found in the last parsed frame (GetAuxData). */
  getAuxData(): BitExtractor {
    this.auxExtractor.reset(this.aux.data, this.aux.length);
    return this.auxExtractor;
  }

  /** Walk every audio block, collecting skip fields and aux data (Update). */
  update(): void {
    this.aux.clear();
    for (let block = 0; block < this.header.blocks; block++) {
      this.decodeAudioBlock(block);
    }
    this.readAux();
  }

  /** Read the auxiliary data field and add it to the aux buffer (ReadAux). */
  private readAux(): void {
    const extractor = this.extractor;
    extractor.position = extractor.backPosition - 32;
    const auxLength = extractor.read(14);
    if (extractor.readBit()) {
      // Auxiliary data present
      extractor.position = extractor.backPosition - 32 - auxLength;
      // auxdatal is a length in bits. Cavern passes it straight to
      // ReadBytesInto, which reads that many *bytes*, running past the frame.
      // DEVIATION: read the whole bytes the field actually holds, unless
      // cavernCompat asks for Cavern's reading.
      const bytes = this.cavernCompat ? auxLength : auxLength >> 3;
      this.aux.readBytesFrom(extractor, bytes);
      this.stats.auxBytes += bytes;
    }
  }

  /* ---- Memory.cs: CreateCacheTables ---- */

  private createCacheTables(blocks: number, channels: number): void {
    const bools = (n: number) => new Array<boolean>(n).fill(false);
    const ints = (n: number) => new Array<number>(n).fill(0);
    this.cachesFor = channels;
    this.blksw = bools(channels);
    this.chbwcod = ints(channels);
    this.chexpstr = [];
    this.chincpl = bools(channels);
    this.chinspx = bools(channels);
    this.chinspxatten = bools(channels);
    this.chintransproc = bools(channels);
    this.convexpstr = ints(channels);
    this.cplcoe = bools(channels);
    this.cplco = [];
    this.cplcoexp = [];
    this.cplcomant = [];
    this.cplexpstr = ints(blocks);
    this.cplinu = bools(blocks);
    this.cplstre = bools(blocks);
    this.deltba = [];
    this.dithflag = bools(channels);
    this.endmant = ints(channels);
    this.fgaincod = ints(channels);
    this.firstcplcos = bools(channels);
    this.firstspxcos = bools(channels);
    this.frmchexpstr = ints(channels);
    this.fsnroffst = ints(channels);
    this.lfeexpstr = bools(blocks);
    this.mstrcplco = ints(channels);
    this.mstrspxco = ints(channels);
    this.nchgrps = ints(channels);
    this.spxattencod = ints(channels);
    this.spxblnd = ints(channels);
    this.spxcoe = bools(channels);
    this.spxcoexp = new Array<number[]>(channels).fill([]);
    this.spxcomant = new Array<number[]>(channels).fill([]);
    this.transproclen = ints(channels);
    this.transprocloc = ints(channels);

    for (let block = 0; block < blocks; ++block) {
      this.chexpstr[block] = ints(channels);
    }

    this.allocation = [];
    this.couplingAllocation = new Allocation(this, maxAllocationSize);
    this.lfeAllocation = new Allocation(this, maxAllocationSize);
    this.cpldeltba.reset();
    this.lfedeltba.reset();
    for (let channel = 0; channel < channels; ++channel) {
      this.allocation[channel] = new Allocation(this, maxAllocationSize);
      this.cplco[channel] = ints(this.cplbndstrc.length);
      this.cplcoexp[channel] = ints(this.cplbndstrc.length);
      this.cplcomant[channel] = ints(this.cplbndstrc.length);
      this.deltba[channel] = new DeltaBitAllocation();
      this.deltba[channel].reset();
    }
  }

  /* ---- DecodeAudioFrame.cs ---- */

  /** For E-AC-3, data for multiple blocks is included in an audio frame header. */
  private decodeAudioFrame(): void {
    const extractor = this.extractor;
    const header = this.header;
    const channels = this.channels;
    this.expstre = header.blocks !== 6 || extractor.readBit();
    this.ahte = header.blocks === 6 && extractor.readBit();
    this.snroffststr = extractor.read(2);
    this.transproce = extractor.readBit();
    this.blkswe = extractor.readBit();
    this.dithflage = extractor.readBit();
    this.bamode = extractor.readBit();
    this.frmfgaincode = extractor.readBit();
    this.dbaflde = extractor.readBit();
    this.skipFieldSyntaxEnabled = extractor.readBit();
    this.spxattene = extractor.readBit();

    if (header.channelMode > 1) {
      // Not mono
      this.cplstre[0] = true;
      this.cplinu[0] = extractor.readBit();
      for (let block = 1; block < this.cplstre.length; block++) {
        if ((this.cplstre[block] = extractor.readBit())) {
          this.cplinu[block] = extractor.readBit();
        } else {
          this.cplinu[block] = this.cplinu[block - 1];
        }
      }
    } else {
      for (let block = 1; block < this.cplstre.length; block++) {
        this.cplinu[block] = false;
      }
    }

    // Exponent strategy data init
    if (this.expstre) {
      for (let block = 0; block < this.cplexpstr.length; block++) {
        if (this.cplinu[block]) {
          this.cplexpstr[block] = extractor.read(2);
        }
        for (let channel = 0; channel < channels.length; channel++) {
          this.chexpstr[block][channel] = extractor.read(2);
        }
      }
    } else {
      let ncplblks = 0;
      for (let block = 0; block < this.cplinu.length; block++) {
        if (this.cplinu[block]) {
          ++ncplblks;
        }
      }
      if (header.channelMode > 1 && ncplblks > 0) {
        this.frmcplexpstr = extractor.read(5);
      }
      for (let channel = 0; channel < channels.length; channel++) {
        this.frmchexpstr[channel] = extractor.read(5);
      }

      for (let block = 0; block < this.cplexpstr.length; block++) {
        this.cplexpstr[block] = frmcplexpstr_tbl[this.frmcplexpstr][block];
        for (let channel = 0; channel < channels.length; channel++) {
          // Cavern indexes frmcplexpstr_tbl with frmchexpstr here too; the
          // table is the same one (frmchexpstr_tbl) in the spec.
          this.chexpstr[block][channel] = frmcplexpstr_tbl[this.frmchexpstr[channel]][block];
        }
      }
    }

    if (header.lfe) {
      for (let block = 0; block < this.lfeexpstr.length; block++) {
        this.lfeexpstr[block] = extractor.readBit();
      }
    }

    // Converter exponent strategy data
    if (header.streamType === StreamTypes.Independent && (this.convexpstre = header.blocks === 6 || extractor.readBit())) {
      for (let channel = 0; channel < channels.length; channel++) {
        this.convexpstr[channel] = extractor.read(5);
      }
    }

    // AHT data
    if (this.ahte) {
      throw new UnsupportedFeatureError('AHT');
    }

    // Audio frame SNR offset data
    if (this.snroffststr === 0) {
      this.frmcsnroffst = extractor.read(6);
      this.frmfsnroffst = extractor.read(4);
    }

    // Transient pre-noise processing data
    if (this.transproce) {
      for (let channel = 0; channel < channels.length; channel++) {
        if ((this.chintransproc[channel] = extractor.readBit())) {
          this.transprocloc[channel] = extractor.read(10);
          this.transproclen[channel] = extractor.read(8);
        }
      }
    }

    // Spectral extension attenuation data
    if (this.spxattene) {
      for (let ch = 0; ch < channels.length; ch++) {
        if ((this.chinspxatten[ch] = extractor.readBit())) {
          this.spxattencod[ch] = extractor.read(5);
        }
      }
    }

    if ((this.blkstrtinfoe = header.blocks !== 1 && extractor.readBit())) {
      const nblkstrtbits = (header.blocks - 1) * (4 + log2Ceil(header.wordsPerSyncframe));
      this.blkstrtinfo = extractor.read(nblkstrtbits);
    }

    // Syntax state init
    for (let channel = 0; channel < channels.length; channel++) {
      this.firstspxcos[channel] = true;
      this.firstcplcos[channel] = true;
    }
    this.firstcplleak = true;
  }

  /* ---- DecodeAudioBlock.cs ---- */

  private decodeAudioBlock(block: number): void {
    const extractor = this.extractor;
    const header = this.header;
    const channels = this.channels;
    const eac3 = header.decoder === Decoders.EAC3;

    if (this.blkswe) {
      for (let channel = 0; channel < channels.length; channel++) {
        this.blksw[channel] = extractor.readBit();
      }
    } else {
      for (let channel = 0; channel < channels.length; channel++) {
        this.blksw[channel] = false;
      }
    }
    if (this.dithflage) {
      for (let channel = 0; channel < channels.length; channel++) {
        this.dithflag[channel] = extractor.readBit();
      }
    } else {
      for (let channel = 0; channel < channels.length; channel++) {
        this.dithflag[channel] = true;
      }
    }

    this.dynrng = extractor.readConditional(8);
    if (header.channelMode === 0) {
      this.dynrng2 = extractor.readConditional(8);
    }

    if (eac3) {
      this.readSPX(block);
    } else {
      this.spxinu = false;
      this.clearSPX();
    }
    if (this.spxinu) this.stats.spxBlocks++;

    this.decodeCouplingStrategy(eac3, block);
    if (this.cplinu[block]) {
      this.stats.couplingBlocks++;
      this.decodeCouplingCoordinates(eac3);
    }

    if (header.channelMode === 2) {
      throw new UnsupportedFeatureError('stereo');
    }

    // Exponent strategy
    if (!eac3) {
      if (this.cplinu[block]) {
        this.cplexpstr[block] = extractor.read(2);
      }
      for (let channel = 0; channel < channels.length; channel++) {
        this.chexpstr[block][channel] = extractor.read(2);
      }
      if (header.lfe) {
        this.lfeexpstr[block] = extractor.readBit();
      }
    }

    // Channel bandwidth code
    for (let channel = 0; channel < channels.length; channel++) {
      if (this.chexpstr[block][channel] !== ExpStrat.Reuse && !this.chincpl[channel] && !this.chinspx[channel]) {
        this.chbwcod[channel] = extractor.read(6);
      }
    }

    // Exponents
    this.parseParametricBitAllocation(block);
    if (this.cplinu[block] && this.cplexpstr[block] !== ExpStrat.Reuse) {
      this.couplingAllocation.readCouplingExponents(extractor, this.cplexpstr[block], this.cplstrtmant, this.ncplgrps);
    }

    // Exponents for full bandwidth channels
    for (let channel = 0; channel < channels.length; channel++) {
      if (this.chexpstr[block][channel] !== ExpStrat.Reuse) {
        this.allocation[channel].readChannelExponents(extractor, this.chexpstr[block][channel], this.nchgrps[channel]);
      }
    }

    // Exponents for LFE channel
    if (header.lfe && this.lfeexpstr[block]) {
      this.lfeAllocation.readLFEExponents(extractor, nlfegrps, lfestrtmant);
    }

    // Bit allocation parametric information
    if (this.bamode) {
      if ((this.baie = extractor.readBit())) {
        this.sdcycod = extractor.read(2);
        this.fdcycod = extractor.read(2);
        this.sgaincod = extractor.read(2);
        this.dbpbcod = extractor.read(2);
        this.floorcod = extractor.read(3);
      }
    } else {
      this.sdcycod = 2;
      this.fdcycod = 1;
      this.sgaincod = 1;
      this.dbpbcod = 2;
      this.floorcod = 7;
    }

    if (this.snroffststr === 0) {
      this.csnroffst = this.frmcsnroffst;
      if (this.cplinu[block]) {
        this.cplfsnroffst = this.frmfsnroffst;
      }
      for (let channel = 0; channel < channels.length; channel++) {
        this.fsnroffst[channel] = this.frmfsnroffst;
      }
      if (header.lfe) {
        this.lfefsnroffst = this.frmfsnroffst;
      }
    } else {
      if ((this.snroffste = (eac3 && block === 0) || extractor.readBit())) {
        this.csnroffst = extractor.read(6);
        if (!eac3) {
          if (this.cplinu[block]) {
            this.cplfsnroffst = extractor.read(4);
            this.cplfgaincod = extractor.read(3);
          }
          for (let channel = 0; channel < channels.length; channel++) {
            this.fsnroffst[channel] = extractor.read(4);
            this.fgaincod[channel] = extractor.read(3);
          }
          if (header.lfe) {
            this.lfefsnroffst = extractor.read(4);
            this.lfefgaincod = extractor.read(3);
          }
        } else if (this.snroffststr === 1) {
          this.blkfsnroffst = extractor.read(4);
          this.cplfsnroffst = this.blkfsnroffst;
          for (let channel = 0; channel < channels.length; channel++) {
            this.fsnroffst[channel] = this.blkfsnroffst;
          }
          this.lfefsnroffst = this.blkfsnroffst;
        } else if (this.snroffststr === 2) {
          if (this.cplinu[block]) {
            this.cplfsnroffst = extractor.read(4);
          }
          for (let channel = 0; channel < channels.length; channel++) {
            this.fsnroffst[channel] = extractor.read(4);
          }
          if (header.lfe) {
            this.lfefsnroffst = extractor.read(4);
          }
        }
      }
    }

    if (eac3) {
      if ((this.fgaincode = this.frmfgaincode && extractor.readBit())) {
        if (this.cplinu[block]) {
          this.cplfgaincod = extractor.read(3);
        }
        for (let channel = 0; channel < channels.length; channel++) {
          this.fgaincod[channel] = extractor.read(3);
        }
        if (header.lfe) {
          this.lfefgaincod = extractor.read(3);
        }
      } else {
        if (this.cplinu[block]) {
          this.cplfgaincod = 4;
        }
        for (let channel = 0; channel < channels.length; channel++) {
          this.fgaincod[channel] = 4;
        }
        if (header.lfe) {
          this.lfefgaincod = 4;
        }
      }

      if (header.streamType === StreamTypes.Independent && (this.convsnroffste = extractor.readBit())) {
        this.convsnroffst = extractor.read(10);
      }
    }

    if (this.cplinu[block]) {
      if (this.firstcplleak) {
        this.cplleake = true;
        this.firstcplleak = false;
      } else {
        this.cplleake = extractor.readBit();
      }
      if (this.cplleake) {
        this.cplfleak = extractor.read(3);
        this.cplsleak = extractor.read(3);
      }
    }

    // Delta bit allocation
    if ((this.dbaflde || !eac3) && (this.deltbaie = extractor.readBit())) {
      if (this.cplinu[block]) {
        this.cpldeltba.enabled = extractor.read(2);
      }
      for (let channel = 0; channel < channels.length; channel++) {
        this.deltba[channel].enabled = extractor.read(2);
      }
      if (this.cplinu[block] && this.cpldeltba.enabled === DeltaBitAllocationMode.NewInfoFollows) {
        this.cpldeltba.read(extractor);
      }
      for (let channel = 0; channel < channels.length; channel++) {
        if (this.deltba[channel].enabled === DeltaBitAllocationMode.NewInfoFollows) {
          this.deltba[channel].read(extractor);
        }
      }
    }

    // Error checks (Cavern's DecoderException 1, 10, 8, 11; not in "unsafe" mode)
    if (block === 0) {
      if (!this.cplstre[block]) {
        throw new Eac3FormatError('decoder error 1');
      }
      if (header.lfe && !this.lfeexpstr[block]) {
        throw new Eac3FormatError('decoder error 10');
      }
    }
    for (let channel = 0; channel < channels.length; channel++) {
      if (block === 0 && this.chexpstr[0][channel] === ExpStrat.Reuse) {
        throw new Eac3FormatError('decoder error 8');
      }
      if (!this.chincpl[channel] && this.chbwcod[channel] > 60) {
        throw new Eac3FormatError('decoder error 11');
      }
    }

    // "Unused dummy data" that might just be used to transport objects
    if (this.skipFieldSyntaxEnabled && (this.skipLengthEnabled = extractor.readBit())) {
      this.skipLength = extractor.read(9);
      this.aux.readBytesFrom(extractor, this.skipLength);
      this.stats.skipFieldBytes += this.skipLength;
    }

    // Quantized mantissa values - prepare for the next allocation frame
    this.bap1Pos = 2;
    this.bap2Pos = 2;
    this.bap4Pos = 1;

    if (this.cplinu[block]) {
      this.allocateCoupling();
    }

    let gotCplchan = false;
    for (let channel = 0; channel < channels.length; channel++) {
      this.allocate(channel);
      this.allocation[channel].skipTransformCoeffs(extractor, 0, this.endmant[channel]);

      if (this.cplinu[block] && this.chincpl[channel] && !gotCplchan) {
        this.couplingAllocation.skipTransformCoeffs(extractor, this.cplstrtmant, this.cplendmant);
        gotCplchan = true;
      }
    }

    // Combined mantissa and output handling for LFE
    if (header.lfe) {
      this.allocateLFE();
      this.lfeAllocation.skipTransformCoeffs(extractor, lfestrtmant, lfeendmant);
    }
  }

  /* ---- Coupling.cs ---- */

  private decodeCouplingStrategy(eac3: boolean, block: number): void {
    const extractor = this.extractor;
    const channels = this.channels;
    if (!eac3 && (this.cplstre[block] = extractor.readBit())) {
      this.cplinu[block] = extractor.readBit();
    }

    if (this.cplstre[block] || !eac3) {
      if (this.cplinu[block]) {
        this.ecplinu = eac3 && extractor.readBit();
        if (eac3 && this.header.channelMode === 2) {
          this.chincpl[0] = this.chincpl[1] = true;
        } else {
          for (let channel = 0; channel < channels.length; channel++) {
            this.chincpl[channel] = extractor.readBit();
          }
        }
        if (!this.ecplinu) {
          // Standard coupling
          if (this.header.channelMode === 0x2) {
            this.phsflginu = extractor.readBit();
          }
          this.cplbegf = extractor.read(4);
          if (!this.spxinu) {
            this.cplendf = extractor.read(4);
          } else {
            this.cplendf = this.spxbegf < 6 ? this.spxbegf - 2 : this.spxbegf * 2 - 7;
          }
          this.ncplsubnd = 3 + this.cplendf - this.cplbegf;
          this.ncplbnd = this.ncplsubnd;
          if ((this.cplbndstrce = !eac3 || extractor.readBit())) {
            for (let band = 1; band < this.ncplsubnd; band++) {
              if ((this.cplbndstrc[this.cplbegf + band] = extractor.readBit())) {
                --this.ncplbnd;
              }
            }
          } else {
            for (let band = 1; band < this.ncplsubnd; band++) {
              if (this.cplbndstrc[this.cplbegf + band]) {
                --this.ncplbnd;
              }
            }
          }
        } else {
          // Enhanced coupling
          this.ecplbegf = extractor.read(4);
          if (this.ecplbegf < 3) {
            this.ecpl_begin_subbnd = this.ecplbegf * 2;
          } else if (this.ecplbegf < 13) {
            this.ecpl_begin_subbnd = this.ecplbegf + 2;
          } else {
            this.ecpl_begin_subbnd = this.ecplbegf * 2 - 10;
          }
          if (!this.spxinu) {
            this.ecplendf = extractor.read(4);
            this.ecpl_end_subbnd = this.ecplendf + 7;
          } else {
            this.ecpl_end_subbnd = this.spxbegf < 6 ? this.spxbegf + 5 : this.spxbegf * 2;
          }
          if ((this.ecplbndstrce = extractor.readBit())) {
            this.ecplbndstrc.fill(false);
            for (let sbnd = Math.max(9, this.ecpl_begin_subbnd + 1); sbnd < this.ecpl_end_subbnd; sbnd++) {
              this.ecplbndstrc[sbnd] = extractor.readBit();
            }
          }
        }
      } else if (eac3) {
        for (let channel = 0; channel < channels.length; channel++) {
          this.chincpl[channel] = false;
          this.firstcplcos[channel] = true;
        }
        this.firstcplleak = true;
        this.phsflginu = false;
        this.ecplinu = false;
      }
    }
  }

  private decodeCouplingCoordinates(eac3: boolean): void {
    const extractor = this.extractor;
    const channels = this.channels;
    if (!this.ecplinu) {
      // Standard coupling
      for (let channel = 0; channel < channels.length; channel++) {
        if (this.chincpl[channel]) {
          if (eac3 && this.firstcplcos[channel]) {
            this.cplcoe[channel] = true;
            this.firstcplcos[channel] = false;
          } else {
            this.cplcoe[channel] = extractor.readBit();
          }
          if (this.cplcoe[channel]) {
            this.mstrcplco[channel] = extractor.read(2) * 3;
            const tcplco = this.cplco[channel];
            const cplchexp = this.cplcoexp[channel];
            const cplchmant = this.cplcomant[channel];
            for (let band = 0; band < this.ncplbnd; band++) {
              cplchexp[band] = extractor.read(4);
              cplchmant[band] = extractor.read(4);
              if (cplchexp[band] !== 15) {
                tcplco[band] = (cplchmant[band] + 16) << (15 - cplchexp[band] - this.mstrcplco[channel]);
              } else {
                tcplco[band] = cplchmant[band] << (15 - this.mstrcplco[channel]);
              }
            }
          }
          if (this.header.channelMode === 0x2 && this.phsflginu && (this.cplcoe[0] || this.cplcoe[1])) {
            throw new UnsupportedFeatureError('stereo');
          }
        } else {
          this.firstcplcos[channel] = true;
        }
      }
    } else {
      // Enhanced coupling
      throw new UnsupportedFeatureError('ecplinu');
    }
  }

  /* ---- SPX.cs ---- */

  private readSPX(block: number): void {
    const extractor = this.extractor;
    const channels = this.channels;
    if ((this.spxstre = block === 0 || extractor.readBit())) {
      if ((this.spxinu = extractor.readBit())) {
        if (this.header.channelMode === 1) {
          this.chinspx[0] = true;
        } else {
          for (let channel = 0; channel < channels.length; channel++) {
            this.chinspx[channel] = extractor.readBit();
          }
        }
        this.spxstrtf = extractor.read(2);
        this.spxbegf = extractor.read(3);
        this.spxendf = extractor.read(3);
        this.spx_begin_subbnd = this.spxbegf < 6 ? this.spxbegf + 2 : this.spxbegf * 2 - 3;
        this.spx_end_subbnd = this.spxendf < 3 ? this.spxendf + 5 : this.spxendf * 2 + 3;
        if ((this.spxbndstrce = extractor.readBit())) {
          this.spxbndstrc = new Array<boolean>(this.spx_end_subbnd).fill(false);
          for (let band = this.spx_begin_subbnd + 1; band < this.spx_end_subbnd; band++) {
            this.spxbndstrc[band] = extractor.readBit();
          }
        }

        this.parseSPX();
      } else {
        this.clearSPX();
      }
    }

    // Coordinates
    if (this.spxinu) {
      for (let channel = 0; channel < channels.length; channel++) {
        if (this.chinspx[channel]) {
          if (this.firstspxcos[channel]) {
            this.spxcoe[channel] = true;
            this.firstspxcos[channel] = false;
          } else {
            this.spxcoe[channel] = extractor.readBit();
          }

          if (this.spxcoe[channel]) {
            this.spxblnd[channel] = extractor.read(5);
            this.mstrspxco[channel] = extractor.read(2);
            for (let band = 0; band < this.nspxbnds; band++) {
              this.spxcoexp[channel][band] = extractor.read(4);
              this.spxcomant[channel][band] = extractor.read(2);
            }
          }
        } else {
          this.firstspxcos[channel] = true;
        }
      }
    }
  }

  private clearSPX(): void {
    for (let channel = 0; channel < this.channels.length; channel++) {
      this.chinspx[channel] = false;
      this.firstspxcos[channel] = true;
    }
  }

  /* ---- Parsers.cs ---- */

  private parseSPX(): void {
    this.nspxbnds = 1;
    this.spxbndsztab = new Array<number>(this.spx_end_subbnd).fill(0);
    this.spxbndsztab[0] = 12;
    // Cavern re-creates spxbndstrc here, discarding what ReadSPX just read,
    // so every band counts as its own. Ported as is (docs/atmos/PLAN.md §6).
    this.spxbndstrc = new Array<boolean>(this.spx_end_subbnd).fill(false);
    for (let bnd = this.spx_begin_subbnd + 1; bnd < this.spx_end_subbnd; ++bnd) {
      if (!this.spxbndstrc[bnd]) {
        this.spxbndsztab[this.nspxbnds] = 12;
        ++this.nspxbnds;
      } else {
        this.spxbndsztab[this.nspxbnds - 1] += 12;
      }
    }
    for (let channel = 0; channel < this.channels.length; ++channel) {
      this.spxcoexp[channel] = new Array<number>(this.nspxbnds).fill(0);
      this.spxcomant[channel] = new Array<number>(this.nspxbnds).fill(0);
    }
  }

  private parseParametricBitAllocation(block: number): void {
    if (this.cplinu[block]) {
      this.cplstrtmant = 37 + 12 * this.cplbegf;
      this.cplendmant = 37 + 12 * (this.cplendf + 3);
      if (this.cplexpstr[block] !== ExpStrat.Reuse) {
        if (this.ecplinu) {
          this.ecplstartmant = ecplsubbndtab[this.ecpl_begin_subbnd];
          this.ecplendmant = ecplsubbndtab[this.ecpl_end_subbnd];
          this.ncplgrps = Math.trunc((this.ecplendmant - this.ecplstartmant) / groupDiv[this.cplexpstr[block] - 1]);
        } else {
          this.ncplgrps = Math.trunc((this.cplendmant - this.cplstrtmant) / groupDiv[this.cplexpstr[block] - 1]);
        }
      }
    }

    for (let channel = 0; channel < this.channels.length; ++channel) {
      if (this.ecplinu) {
        this.endmant[channel] = ecplsubbndtab[this.ecpl_begin_subbnd];
      } else {
        if (this.spxinu && !this.cplinu[block]) {
          this.endmant[channel] = this.spx_begin_subbnd * 12 + 25;
        } else if (this.chincpl[channel]) {
          this.endmant[channel] = this.cplstrtmant;
        } else {
          this.endmant[channel] = (this.chbwcod[channel] + 12) * 3 + 37;
        }
      }

      const strat = this.chexpstr[block][channel];
      if (strat !== 0) {
        this.nchgrps[channel] = Math.trunc((this.endmant[channel] + groupAdd[strat - 1]) / groupDiv[strat - 1]);
      }
    }
  }

  /* ---- BitAllocation.cs ---- */

  private allocate(channel: number): void {
    if (this.csnroffst === 0 && this.fsnroffst[channel] === 0) {
      this.allocation[channel].bap.fill(0);
      return;
    }
    const snroffset = (((this.csnroffst - 15) << 4) + this.fsnroffst[channel]) << 2;
    this.allocateRange(0, this.endmant[channel], fastgain[this.fgaincod[channel]], snroffset,
      this.allocation[channel], this.deltba[channel], 0, 0);
  }

  private allocateCoupling(): void {
    if (this.csnroffst === 0 && this.cplfsnroffst === 0) {
      this.couplingAllocation.bap.fill(0);
      return;
    }
    const snroffset = (((this.csnroffst - 15) << 4) + this.cplfsnroffst) << 2;
    this.allocateRange(this.cplstrtmant, this.cplendmant, fastgain[this.cplfgaincod], snroffset, this.couplingAllocation,
      this.cpldeltba, (this.cplfleak << 8) + 768, (this.cplsleak << 8) + 768);
  }

  private allocateLFE(): void {
    if (this.csnroffst === 0 && this.lfefsnroffst === 0) {
      this.lfeAllocation.bap.fill(0);
      return;
    }
    const snroffset = (((this.csnroffst - 15) << 4) + this.lfefsnroffst) << 2;
    this.allocateRange(lfestrtmant, lfeendmant, fastgain[this.lfefgaincod], snroffset, this.lfeAllocation,
      this.lfedeltba, 0, 0);
  }

  /** Cavern's Allocate(start, end, fgain, snroffset, allocation, dba, fastleak, slowleak). */
  private allocateRange(start: number, end: number, fgain: number, snroffset: number,
    allocation: Allocation, dba: DeltaBitAllocation, fastleak: number, slowleak: number): void {
    // Initialization
    const sdecay = slowdec[this.sdcycod];
    const fdecay = fastdec[this.fdcycod];
    const sgain = slowgain[this.sgaincod];
    const dbknee = dbpbtab[this.dbpbcod];
    const floor = floortab[this.floorcod];

    // Compute excitation function
    const psd = allocation.psd;
    const bndpsd = allocation.integratedPSD;
    const excite = allocation.excite;
    const bndstrt = masktab[start];
    const bndend = masktab[end - 1] + 1;
    let begin: number;
    if (bndstrt === 0) {
      // Full bandwidth and LFE channels
      let lowcomp = calcLowcomp(0, bndpsd[0], bndpsd[1], 0);
      excite[0] = bndpsd[0] - fgain - lowcomp;
      lowcomp = calcLowcomp(lowcomp, bndpsd[1], bndpsd[2], 1);
      excite[1] = bndpsd[1] - fgain - lowcomp;
      begin = 7;
      for (let bin = 2; bin < 7; bin++) {
        if (bndend !== 7 || bin !== 6) {
          lowcomp = calcLowcomp(lowcomp, bndpsd[bin], bndpsd[bin + 1], bin);
        }
        fastleak = bndpsd[bin] - fgain;
        slowleak = bndpsd[bin] - sgain;
        excite[bin] = fastleak - lowcomp;
        if ((bndend !== 7 || bin !== 6) && bndpsd[bin] <= bndpsd[bin + 1]) {
          begin = bin + 1;
          break;
        }
      }
      for (let bin = begin, bins = Math.min(bndend, 22); bin < bins; bin++) {
        if (bndend !== 7 || bin !== 6) {
          lowcomp = calcLowcomp(lowcomp, bndpsd[bin], bndpsd[bin + 1], bin);
        }
        fastleak = Math.max(fastleak - fdecay, bndpsd[bin] - fgain);
        slowleak = Math.max(slowleak - sdecay, bndpsd[bin] - sgain);
        excite[bin] = Math.max(fastleak - lowcomp, slowleak);
      }
      begin = 22;
    } else {
      // Coupling channel
      begin = bndstrt;
    }
    for (let bin = begin; bin < bndend; bin++) {
      fastleak = Math.max(fastleak - fdecay, bndpsd[bin] - fgain);
      slowleak = Math.max(slowleak - sdecay, bndpsd[bin] - sgain);
      excite[bin] = Math.max(fastleak, slowleak);
    }

    // Compute masking curve
    const mask = allocation.mask;
    const hthRow = hth[this.header.sampleRateCode];
    for (let bin = bndstrt; bin < bndend; bin++) {
      if (bndpsd[bin] < dbknee) {
        excite[bin] += (dbknee - bndpsd[bin]) >> 2;
      }
      mask[bin] = Math.max(excite[bin], hthRow[bin]);
    }

    // Apply delta bit allocation
    if (dba.enabled === DeltaBitAllocationMode.Reuse || dba.enabled === DeltaBitAllocationMode.NewInfoFollows) {
      const offset = dba.offset;
      const length = dba.length;
      const bitAllocation = dba.bitAllocation;
      for (let band = bndstrt, seg = 0; seg < offset.length; seg++) {
        band += offset[seg];
        const delta = bitAllocation[seg] >= 4 ? (bitAllocation[seg] - 3) << 7 : (bitAllocation[seg] - 4) << 7;
        for (let k = 0; k < length[seg]; k++) {
          mask[band++] += delta;
        }
      }
    }

    // Compute bit allocation
    const bap = allocation.bap;
    let i = start;
    let j = masktab[start];
    let lastbin: number;
    do {
      lastbin = Math.min(bndtab[j], end);
      let masked = mask[j] - snroffset - floor;
      if (masked < 0) {
        masked = 0;
      }
      masked = (masked & 0x1fe0) + floor;
      while (i < lastbin) {
        let address = (psd[i] - masked) >> 5;
        address = Math.min(63, Math.max(0, address));
        bap[i++] = baptab[address];
      }
      j++;
    } while (end > lastbin);
    bap.fill(0, i);
  }
}

function calcLowcomp(a: number, b0: number, b1: number, bin: number): number {
  if (bin < 7) {
    if (b0 + 256 === b1) {
      return 384;
    } else if (b0 > b1) {
      return Math.max(0, a - 64);
    }
  } else if (bin < 20) {
    if (b0 + 256 === b1) {
      return 320;
    } else if (b0 > b1) {
      return Math.max(0, a - 64);
    }
  } else {
    return Math.max(0, a - 128);
  }
  return a;
}

/** QMath.Log2Ceil */
function log2Ceil(val: number): number {
  const log = 31 - Math.clz32(val);
  return 1 << log !== val ? log + 1 : log;
}

