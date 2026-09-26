/* Decoder backends, used inside the decode Worker. Two implementations
   behind one shape so the Worker's decode loop never cares which runs:

     WasmBackend       — vendor/decoder (FFmpeg, or the silent stub):
                         synchronous, one output per packet.
     WebCodecsBackend  — AudioDecoder, when isConfigSupported says yes for
                         the codec + description. Asynchronous: outputs
                         arrive in submission order via a callback.

   Both deliver planar float32 through onOutput(packet, planes, frames),
   where `packet` is the input it came from (the spatial processor needs
   the raw access unit alongside its PCM). */

import type { DecoderModule, WasmDecoder } from '../../../vendor/decoder/decoder.js';
import type { Mp4Audio } from '../mp4samples';

export type OutputFn = (packet: Uint8Array, planes: Float32Array[], frames: number) => void;

export interface Backend {
  readonly kind: 'wasm' | 'webcodecs';
  readonly isStub: boolean;
  readonly version: string;
  /** Submit one packet. False when it was rejected outright (the caller
      substitutes silence to hold the timeline). */
  decode(packet: Uint8Array): boolean;
  /** Packets submitted whose output has not arrived yet. */
  pending(): number;
  /** Resolves once every submitted packet has produced its output. */
  drain(): Promise<void>;
  /** Drop decoder state (seek / new segment start). */
  reset(): void;
  close(): void;
  onOutput: OutputFn;
}

export class WasmBackend implements Backend {
  readonly kind = 'wasm' as const;
  readonly isStub: boolean;
  readonly version: string;
  onOutput: OutputFn = () => {};
  private dec: WasmDecoder;

  constructor(mod: DecoderModule, dec: WasmDecoder) {
    this.dec = dec;
    this.isStub = mod.isStub;
    this.version = mod.version;
  }

  static open(mod: DecoderModule, d: Mp4Audio): WasmBackend | null {
    const codec = d.codec;
    const dec = mod.open(codec, codec === 'alac' ? d.extradata : null, d.sampleRate, d.channels);
    return dec ? new WasmBackend(mod, dec) : null;
  }

  decode(packet: Uint8Array): boolean {
    const out = this.dec.decode(packet);
    if (!out || !out.frames) return false;
    this.onOutput(packet, out.planes, out.frames);
    return true;
  }
  pending(): number {
    return 0;
  }
  drain(): Promise<void> {
    return Promise.resolve();
  }
  reset(): void {
    this.dec.flush();
  }
  close(): void {
    this.dec.close();
  }
}

/* ---------- WebCodecs ---------- */

function webCodecsConfig(d: Mp4Audio): AudioDecoderConfig | null {
  const base = { sampleRate: d.sampleRate, numberOfChannels: d.channels };
  if (d.codec === 'ec-3') return { codec: 'ec-3', ...base };
  if (d.codec === 'ac-3') return { codec: 'ac-3', ...base };
  /* ALAC has no WebCodecs registration today; the probe asks anyway (with
     the magic cookie as description) so a browser that adds it wins. */
  if (d.codec === 'alac' && d.extradata) return { codec: 'alac', description: d.extradata.slice(12), ...base };
  /* Dev/test only (never an engine codec in the app): FLAC-in-MP4 gives the
     browser tests real audio through the whole engine. */
  if (d.codec === 'fLaC' && d.extradata) return { codec: 'flac', description: d.extradata, ...base };
  return null;
}

export async function probeWebCodecs(d: Mp4Audio): Promise<AudioDecoderConfig | null> {
  if (typeof AudioDecoder === 'undefined') return null;
  const cfg = webCodecsConfig(d);
  if (!cfg) return null;
  try {
    const res = await AudioDecoder.isConfigSupported(cfg);
    return res && res.supported ? cfg : null;
  } catch {
    return null;
  }
}

export class WebCodecsBackend implements Backend {
  readonly kind = 'webcodecs' as const;
  readonly isStub = false;
  readonly version = 'WebCodecs AudioDecoder';
  onOutput: OutputFn = () => {};
  private cfg: AudioDecoderConfig;
  private dec: AudioDecoder;
  private inflight: Uint8Array[] = [];
  private epoch = 0;
  private ts = 0;
  private failed = false;
  private waiters: Array<() => void> = [];

  constructor(cfg: AudioDecoderConfig) {
    this.cfg = cfg;
    this.dec = this.make();
  }

  private make(): AudioDecoder {
    const epoch = this.epoch;
    const dec = new AudioDecoder({
      output: (data: AudioData) => {
        try {
          if (epoch !== this.epoch) return;
          const packet = this.inflight.shift() || new Uint8Array(0);
          const frames = data.numberOfFrames;
          const planes: Float32Array[] = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const p = new Float32Array(frames);
            data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
            planes.push(p);
          }
          this.onOutput(packet, planes, frames);
        } finally {
          data.close();
          this.wake();
        }
      },
      error: () => {
        this.failed = true;
        this.inflight = [];
        this.wake();
      },
    });
    dec.configure(this.cfg);
    return dec;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  decode(packet: Uint8Array): boolean {
    if (this.failed) {
      /* An error closes the decoder: start a fresh one and carry on. */
      this.failed = false;
      this.epoch++;
      this.dec = this.make();
    }
    try {
      this.inflight.push(packet);
      this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: packet }));
      this.ts += 1000;
      return true;
    } catch {
      this.inflight.pop();
      return false;
    }
  }

  pending(): number {
    return this.inflight.length;
  }

  async drain(): Promise<void> {
    if (this.failed || !this.inflight.length) return;
    try {
      await this.dec.flush();
    } catch {
      this.inflight = [];
    }
  }

  reset(): void {
    this.epoch++;
    this.inflight = [];
    try {
      this.dec.close();
    } catch {
      /* already closed */
    }
    this.failed = false;
    this.dec = this.make();
    this.wake();
  }

  close(): void {
    this.epoch++;
    this.inflight = [];
    try {
      this.dec.close();
    } catch {
      /* already closed */
    }
    this.wake();
  }

  /** Resolves when fewer than `max` packets are in flight. */
  waitBelow(max: number): Promise<void> {
    if (this.inflight.length < max || this.failed) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }
}
