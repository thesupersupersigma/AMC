/* AMC decoder loader: the JS glue for decoder.wasm.

   Hand-written rather than Emscripten-generated so ONE loader serves every
   place the module runs: the decode Worker (Vite-bundled, or inlined into
   the single-file build), and Node for the tests. The WASM is a standalone
   reactor module (build.sh links with -sSTANDALONE_WASM --no-entry); its
   few WASI/env imports are satisfied generically below. The silent stub
   (stub/stub.c) has the same exports and no imports.

   Nothing here touches the network: the caller hands in the bytes, a
   compiled WebAssembly.Module, or a URL it already resolved (the app passes
   a same-origin asset URL, or a data: URL in the single-file build). */

/** @typedef {{ frames: number, planes: Float32Array[] }} DecodedPacket */

export const CODEC_IDS = Object.freeze({ alac: 1, 'ac-3': 2, 'ec-3': 3 });

const PADDING = 64; /* AV_INPUT_BUFFER_PADDING_SIZE */

function readCString(memory, ptr) {
  if (!ptr) return '';
  const b = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < b.length && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(ptr, end));
}

/* WASI and Emscripten-env imports, satisfied just enough for a reactor that
   never touches files: stderr text is forwarded to onLog, everything else is
   a harmless success or "bad descriptor". */
function buildImports(module, getMemory, onLog) {
  const imports = {};
  let pendingText = '';
  const flushText = () => {
    const lines = pendingText.split('\n');
    pendingText = lines.pop() || '';
    for (const line of lines) if (line.trim()) onLog(line.trim());
  };
  const known = {
    wasi_snapshot_preview1: {
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const mem = getMemory();
        if (!mem) return 8;
        const dv = new DataView(mem.buffer);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          total += len;
          if (fd === 1 || fd === 2) pendingText += new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));
        }
        dv.setUint32(nwrittenPtr, total, true);
        flushText();
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70 /* ESPIPE */,
      fd_read: () => 8 /* EBADF */,
      fd_fdstat_get: () => 8,
      fd_prestat_get: () => 8,
      fd_prestat_dir_name: () => 8,
      proc_exit(code) {
        throw new Error('decoder exited with code ' + code);
      },
      environ_sizes_get(countPtr, sizePtr) {
        const dv = new DataView(getMemory().buffer);
        dv.setUint32(countPtr, 0, true);
        dv.setUint32(sizePtr, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get(countPtr, sizePtr) {
        const dv = new DataView(getMemory().buffer);
        dv.setUint32(countPtr, 0, true);
        dv.setUint32(sizePtr, 0, true);
        return 0;
      },
      args_get: () => 0,
      clock_time_get(_id, _precision, outPtr) {
        const ns = BigInt(Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6));
        new DataView(getMemory().buffer).setBigUint64(outPtr, ns, true);
        return 0;
      },
      random_get(ptr, len) {
        crypto.getRandomValues(new Uint8Array(getMemory().buffer, ptr, len));
        return 0;
      },
    },
    env: {
      emscripten_notify_memory_growth: () => {},
      abort() {
        throw new Error('decoder aborted');
      },
    },
  };
  const warned = new Set();
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] = imports[imp.module] || {});
    if (imp.kind === 'function') {
      const fn = known[imp.module] && known[imp.module][imp.name];
      ns[imp.name] =
        fn ||
        (() => {
          if (!warned.has(imp.name)) {
            warned.add(imp.name);
            onLog('decoder called an unprovided import ' + imp.module + '.' + imp.name);
          }
          return 0;
        });
    } else if (imp.kind === 'memory') {
      ns[imp.name] = new WebAssembly.Memory({ initial: 256, maximum: 32768 });
    } else if (imp.kind === 'table') {
      ns[imp.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    } else if (imp.kind === 'global') {
      ns[imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
    }
  }
  return imports;
}

async function compileFrom(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (typeof source === 'string') {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error('decoder.wasm could not be loaded (HTTP ' + resp.status + ')');
    return WebAssembly.compile(await resp.arrayBuffer());
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.compile(source);
  throw new Error('decoder.wasm: unsupported source');
}

/** One decoder instance (an FFmpeg AVCodecContext) inside a module. */
export class WasmDecoder {
  constructor(mod, handle) {
    this.mod = mod;
    this.handle = handle;
  }

  /** Decodes one packet. Returns copies of the planar f32 output (safe to
      transfer), or null when the decoder rejected the packet. */
  decode(bytes) {
    const m = this.mod;
    if (!this.handle) return null;
    const ptr = m.ensureInput(bytes.length);
    new Uint8Array(m.memory.buffer, ptr, bytes.length + PADDING).fill(0, bytes.length);
    new Uint8Array(m.memory.buffer, ptr, bytes.length).set(bytes);
    const n = m.exports.dec_send(this.handle, ptr, bytes.length);
    if (n < 0) return null;
    const ch = m.exports.dec_channels(this.handle);
    const planes = [];
    for (let c = 0; c < ch; c++) {
      const out = new Float32Array(n);
      const p = m.exports.dec_get_planar_f32(this.handle, c);
      /* A fresh view every time: memory.grow detaches old buffers. */
      if (p && n) out.set(new Float32Array(m.memory.buffer, p, n));
      planes.push(out);
    }
    return { frames: n, planes };
  }

  get sampleRate() {
    return this.handle ? this.mod.exports.dec_sample_rate(this.handle) : 0;
  }

  flush() {
    if (this.handle) this.mod.exports.dec_flush(this.handle);
  }

  close() {
    if (this.handle) this.mod.exports.dec_close(this.handle);
    this.handle = 0;
  }
}

/** A loaded decoder.wasm. Create decoders with open(). */
export class DecoderModule {
  constructor(instance, onLog) {
    this.exports = instance.exports;
    this.memory = instance.exports.memory;
    this.onLog = onLog;
    this.inputPtr = 0;
    this.inputCap = 0;
    this.isStub = !!this.exports.dec_is_stub();
    this.version = readCString(this.memory, this.exports.dec_version());
  }

  ensureInput(len) {
    const need = len + PADDING;
    if (need > this.inputCap) {
      if (this.inputPtr) this.exports.free(this.inputPtr);
      this.inputCap = Math.max(need, this.inputCap * 2, 65536);
      this.inputPtr = this.exports.malloc(this.inputCap);
      if (!this.inputPtr) throw new Error('decoder out of memory');
    }
    return this.inputPtr;
  }

  /** codec: 'alac' | 'ac-3' | 'ec-3'. extradata: the full 'alac' atom for
      ALAC, nothing for (E-)AC-3. Returns null when the codec is refused. */
  open(codec, extradata, sampleRate, channels) {
    const id = CODEC_IDS[codec];
    if (!id) return null;
    let ptr = 0;
    const len = extradata ? extradata.length : 0;
    if (len) {
      ptr = this.exports.malloc(len + PADDING);
      new Uint8Array(this.memory.buffer, ptr, len + PADDING).fill(0);
      new Uint8Array(this.memory.buffer, ptr, len).set(extradata);
    }
    const handle = this.exports.dec_open(id, ptr, len, sampleRate | 0, channels | 0);
    if (ptr) this.exports.free(ptr);
    return handle ? new WasmDecoder(this, handle) : null;
  }
}

/** Compiles and instantiates decoder.wasm. `source` is bytes, a compiled
    WebAssembly.Module, or a URL (same-origin asset or data: URL). */
export async function loadDecoderModule(source, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const module = await compileFrom(source);
  let memory = null;
  const imports = buildImports(module, () => memory, log);
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  if (typeof instance.exports._initialize === 'function') instance.exports._initialize();
  return new DecoderModule(instance, log);
}
