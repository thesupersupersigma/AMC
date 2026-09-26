# vendor/decoder: AMC's software audio decoder

`decoder.wasm` decodes the formats Chrome often can't play natively:

| Codec | MP4 sample entry | Output |
|---|---|---|
| Apple Lossless | `alac` | planar float32, bit-exact |
| Dolby Digital | `ac-3` | planar float32, no dynamic range compression |
| Dolby Digital Plus (incl. Atmos editions: the 5.1 core; `src/audio/atmos/` decodes the objects from it) | `ec-3` | planar float32, no dynamic range compression |

It's FFmpeg's libavcodec with those three decoders and nothing else, plus `shim.c`, compiled to a
standalone WebAssembly module. There's no demuxer: AMC reads MP4 sample tables itself
(`src/audio/mp4samples.ts`) and feeds one MP4 sample per call.

## Status

The committed `decoder.wasm` is the real FFmpeg build from the **build-decoder** workflow;
`BUILDINFO.txt` records the toolchain, the FFmpeg commit, the size and the sha256. (`stub/` is a
silent placeholder with the same ABI, for building without Emscripten; AMC logs `software
decoder is a silent stub` in the activity panel whenever it runs.) After any change to
`shim.c` or `build.sh`, run the workflow again (Actions → build-decoder → Run workflow → the
branch): it builds with the pinned toolchain, runs the decoder tests against ffmpeg-made
reference PCM, and commits `decoder.wasm` + `BUILDINFO.txt` back to that branch.

**Dynamic range compression is off.** `shim.c` opens the AC-3 and E-AC-3 decoders with
`drc_scale = 0` (the same as `ffmpeg -drc_scale 0`): AMC plays music, and the Atmos objects are
derived from this core, which then matches Cavern's (it applies no DRC). `scripts/make-fixtures.sh`
makes the (E-)AC-3 reference PCM the same way.

## Files

| File | What |
|---|---|
| `build.sh` | Reproducible build: pinned emsdk **3.1.74**, FFmpeg tag **n7.1**, the configure line below, the link line. Writes `decoder.wasm` + `BUILDINFO.txt` (resolved commits, emcc version, size, sha256). |
| `shim.c` | The C ABI AMC calls: `dec_open`, `dec_send`, `dec_get_planar_f32`, `dec_channels`, `dec_sample_rate`, `dec_flush`, `dec_close`, `dec_is_stub`, `dec_version`. |
| `decoder.js` + `decoder.d.ts` | The JS glue: a hand-written loader that works in the decode Worker and in Node. It satisfies the module's few WASI imports generically and copies output planes out as transferable `Float32Array`s. |
| `decoder.wasm` | The built module (committed, so Vercel and CI never need Emscripten). |
| `stub/` | `stub.c` + `build-stub.sh`: the silent placeholder, built with plain clang + wasm-ld. |
| `LICENSE.LGPL-2.1` | FFmpeg's license text (`COPYING.LGPLv2.1` from the FFmpeg tree). |

## The configure line

```sh
emconfigure ./configure \
  --prefix="$PREFIX" --target-os=none --arch=x86_32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-everything --disable-programs --disable-doc \
  --disable-avdevice --disable-avformat --disable-swresample --disable-swscale \
  --disable-avfilter --disable-postproc --disable-network --disable-autodetect \
  --disable-asm --disable-inline-asm --disable-pthreads --disable-w32threads \
  --disable-os2threads --disable-runtime-cpudetect --disable-debug --disable-stripping \
  --enable-decoder=alac,ac3,eac3 \
  --extra-cflags=-O3
```

There's no `--enable-gpl`, `--enable-version3` or `--enable-nonfree`. `build.sh` also asserts
`CONFIG_GPL 0` and `CONFIG_NONFREE 0` in the generated `config.h`, so the binary is
**LGPL-2.1-or-later**. The decoders pull in only what they select themselves (the AC-3 parser,
ac3dsp, fmtconvert, the tx/MDCT code, alacdsp).

## Rebuilding

```sh
bash vendor/decoder/build.sh     # Linux or macOS with git, python3, make; ~10 min
node --test --experimental-strip-types test/*.test.mjs
```

To rebuild the stub instead (no Emscripten): `bash vendor/decoder/stub/build-stub.sh`.

## LGPL obligations

AMC's own code is MIT. FFmpeg is LGPL-2.1-or-later. AMC loads `decoder.wasm` as a separate
module at runtime, and anyone can replace it with their own build from the sources above (same
ABI). The FFmpeg source is the pinned public tag `n7.1`; `BUILDINFO.txt` records the exact commit.
The license text ships alongside as `LICENSE.LGPL-2.1`.
