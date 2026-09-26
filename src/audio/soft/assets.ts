/* Where the engine's code and decoder come from at runtime.

   The Worker is inlined (?worker&inline): Vite bundles it and embeds it,
   and it is started from a Blob URL. That is identical in the served build
   and the single-file build, where a separate worker file could not load.
   decoder.wasm is an asset URL: a hashed file in the served build (cached
   by the service worker), and a data: URL in the single-file build, which
   inlines every asset. The worklet needs neither: see worklet.ts. */

import DecodeWorker from './worker?worker&inline';
import wasmUrl from '../../../vendor/decoder/decoder.wasm?url';

export function createDecodeWorker(): Worker {
  return new DecodeWorker({ name: 'amc-decode' });
}

/** Absolute, so it resolves the same from inside a Blob-URL worker. */
export function decoderWasmUrl(): string {
  try {
    return new URL(wasmUrl, document.baseURI).href;
  } catch {
    return wasmUrl;
  }
}
