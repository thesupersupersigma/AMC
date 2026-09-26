/* Types for decoder.js (the hand-written loader for decoder.wasm). */

export type EngineCodec = 'alac' | 'ac-3' | 'ec-3';

export declare const CODEC_IDS: Readonly<Record<EngineCodec, number>>;

export interface DecodedPacket {
  frames: number;
  planes: Float32Array[];
}

export declare class WasmDecoder {
  decode(bytes: Uint8Array): DecodedPacket | null;
  readonly sampleRate: number;
  flush(): void;
  close(): void;
}

export declare class DecoderModule {
  readonly isStub: boolean;
  readonly version: string;
  open(codec: string, extradata: Uint8Array | null, sampleRate: number, channels: number): WasmDecoder | null;
}

export declare function loadDecoderModule(
  source: ArrayBuffer | ArrayBufferView | WebAssembly.Module | string,
  onLog?: (line: string) => void
): Promise<DecoderModule>;
