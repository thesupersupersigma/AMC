# Decode engine — recon (gate 1)

Baseline: `master` @ `0d44978` (v2.2.3). This is a survey of the code as it stands, before any
changes. Line numbers refer to that commit.

## 1. Every touch point on the playback element

`src/audio/engine.ts:5` exports `audio = document.getElementById('audio')` (declared in
`index.html` as `<audio id="audio" preload="metadata">`). The same module also exports `probe`
(`#probe`, muted). That is a separate element, used only to backfill durations after a scan, and
never for playback.

### `src/ui/player.ts` (56 uses)

| Line | Use | Kind |
|---|---|---|
| 113 | `audio.src` (truthiness: is anything loaded) | get |
| 120 | `audio.paused`, `audio.currentTime` (crossfade precondition) | get |
| 121 | `audio.currentTime`, `audio.muted`, `audio.volume` (tail start point + level) | get |
| 132 | `audio.src = url` | set |
| 133 | `audio.load()` | method |
| 143 | `audio.currentTime = startAt` (same-file cue reuse) | set |
| 151 | `audio.play()` → Promise; rejection `NotAllowedError` handled | method |
| 192 | `audio.paused` (rAF boundary loop stops when paused) | get |
| 220 | `audio.paused` (resume save) | get |
| 225 | `audio.currentTime` (resume save) | get |
| 257 | `audio.currentTime = row.sec` (resume chip) | set |
| 275 | `audio.paused` (crossfade window) | get |
| 277 | `audio.duration` (fallback track end) | get |
| 279 | `audio.currentTime` (remaining in crossfade window) | get |
| 300 | `audio.currentTime` (cue boundary check) | get |
| 303 | `audio.currentTime = c.startSec` (repeat-one within cue) | set |
| 323 | `audio.currentTime` → `S.lastPos` (gapless cue advance) | get |
| 333 | `audio.pause()` (non-contiguous cue end) | method |
| 374 | `audio.currentTime = base` (repeat-one) | set |
| 375 | `audio.play()` | method |
| 386 | `audio.pause()` (end of queue) | method |
| 397–398 | `audio.currentTime` get + set (prev: restart if > 3 s) | get/set |
| 403 | `audio.currentTime = base` | set |
| 414–418 | `audio.paused`, `audio.play()`, `audio.pause()` (togglePlay) | get/method |
| 451–452 | `audio.volume = S.volume`, `audio.muted = S.muted` (setVolume) | set |
| 459 | `audio.muted` (toggleMute) | set |
| 513 | `audio.play()` (Media Session `play`) | method |
| 518 | `audio.pause()` (Media Session `pause`) | method |
| 521–522 | `audio.pause()`, `audio.currentTime = 0` (Media Session `stop`) | method/set |
| 531 | `audio.duration`, `audio.currentTime =` (Media Session `seekto`) | get/set |
| 534 | `audio.currentTime` get/set (Media Session `seekbackward`) | get/set |
| 537 | `audio.duration`, `audio.currentTime` get/set (Media Session `seekforward`) | get/set |
| 593, 596 | `audio.duration` (scrub window) | get |
| 602 | `audio.currentTime` (time UI) | get |
| 644 | `audio.currentTime =` (scrubber commit) | set |
| 663 | `audio.muted = false` (volume slider) | set |
| 673 | `addEventListener('play')` | event |
| 680 | `addEventListener('pause')` | event |
| 686 | `addEventListener('ended')` | event |
| 701 | `audio.duration` (instant-finish detector) | get |
| 713 | `addEventListener('timeupdate')` | event |
| 718–719 | `audio.paused` | get |
| 728 | `webkitAudioDecodedByteCount` (proof that bytes decoded) | get (Chrome-only) |
| 735–736 | `audio.currentTime` → `S.lastPos` | get |
| 739 | `addEventListener('durationchange')` | event |
| 740–745 | `audio.duration` | get |
| 753 | `addEventListener('loadedmetadata')` | event |
| 754–756 | `audio.duration`, `audio.currentTime =` (pending seek) | get/set |
| 764 | `addEventListener('error')` | event |
| 766 | `audio.error.code` (3 = DECODE, 4 = SRC_NOT_SUPPORTED) | get |
| 804–805 | `audio.src =`, `audio.load()` (restore last track, paused) | set/method |

### Other modules

| File:line | Use |
|---|---|
| `main.ts:94` | `audio.currentTime` get/set (←, −5 s) |
| `main.ts:100` | `audio.duration`, `audio.currentTime` get/set (→, +5 s) |
| `main.ts:172–173` | `audio.volume`, `audio.muted` set at boot |
| `ui/lyrics.ts:41` | `audio.currentTime` (rAF lyric clock) |
| `ui/lyrics.ts:190` | `audio.paused` (continue the rAF loop) |
| `ui/lyrics.ts:292` | `addEventListener('play')` |
| `ui/lyrics.ts:296` | `addEventListener('pause')` |
| `ui/lyrics.ts:350` | `audio.currentTime =` (tap a line to seek) |
| `ui/nowplaying.ts:169` | `audio.duration` (track window fallback) |
| `ui/nowplaying.ts:190` | `audio.currentTime` |
| `ui/nowplaying.ts:198` | `audio.paused` |
| `ui/nowplaying.ts:318` | `audio.currentTime =` (fullscreen scrub commit) |
| `ui/pip.ts:80` | `audio.duration` |
| `ui/pip.ts:108` | `audio.currentTime` |
| `ui/pip.ts:113` | `audio.paused` |
| `ui/pip.ts:141` | `audio.currentTime =` (PiP scrub) |
| `ui/waveform.ts:142` | `audio.currentTime` (played-portion paint) |
| `ui/waveform.ts:382` | `audio.currentTime =` (split editor "play from boundary") |
| `ui/waveform.ts:390` | `audio.currentTime` (split editor "add at playhead") |
| `fs/folders.ts:227–228` | looks `#audio` up by id itself and calls `pause()` when the playing folder is removed |
| `audio/engine.ts:111–122` | `audio.volume` set by the crossfade ramp (`rampMainVolume`) |
| `audio/engine.ts:78–95` | `new Audio()` crossfade tail: `preload`, `src`, `volume`, `currentTime`, `play()`, `pause()` |
| `scan/scanner.ts:734–759` | `probe` only: `onloadedmetadata`, `onerror`, `duration`, `src`, `load()` |

### The `MediaLike` surface this implies

Properties: `currentTime` (get/set), `duration`, `paused`, `volume` (get/set), `muted`
(get/set), `error` (`{ code }`), `src` (get: "is anything loaded"), and the Chrome-only
`webkitAudioDecodedByteCount`. `ended` is never read directly; the `ended` event is used instead.
It's part of the facade anyway, for completeness.

Methods: `play(): Promise<void>`, `pause()`, `load()`, `addEventListener` /
`removeEventListener`.

Events that are listened to: `play`, `pause`, `ended`, `timeupdate`, `durationchange`,
`loadedmetadata`, `error`. Nobody listens to `seeking`, `seeked`, `waiting`, `playing`,
`canplay` or `volumechange` today. The facade still dispatches them, as the spec asks.

Element-level ordering that `ui/player.ts` relies on:

- `play()` fires `play` synchronously-ish (before the promise settles) and `S.playing` follows
  it. `pause()` fires `pause`.
- A `currentTime` set before `loadedmetadata` throws or is ignored. `player.ts` keeps its own
  `pendingSeek` and applies it in the `loadedmetadata` listener.
- `durationchange` fires on load. The listener backfills `track.duration` only when the scan
  found none.
- `timeupdate` fires about 4 times a second while playing, and once after every seek. It's the
  sole driver of `S.lastPos`, prefs saves, resume saves and the codec "works after all" proof.
  That proof counts only after 1.2 s since load, and only when `webkitAudioDecodedByteCount > 0`.
- `ended` fires once at natural end. The listener refuses to advance when `playbackArmed` is
  false (a restored track), and treats `< 400 ms` wall-clock plays of a `> 2 s` track as
  "no audio".
- `error` with code 3 or 4 marks the fourcc failed (`markCodecFailed`) and skips
  (`skipAfterFailure`).

## 2. How the element-bound features work today

**Crossfade** (`audio/engine.ts:40–133`, `ui/player.ts:115–123, 267–296`). `checkCrossfadeAdvance`
runs from the rAF boundary loop and from `timeupdate`. Once `remain <= crossfadeSec` it calls
`next(false)`. `loadTrack` then, *before* swapping `src`, calls
`startCrossfadeTail(prevFile, audio.currentTime, level, xf)`. That creates a throwaway
`new Audio()` over a second object URL of the outgoing file, seeks it to the same position and
fades its `volume` to 0 over `xf` seconds on a 50 ms `setInterval`. `rampMainVolume` sets
`audio.volume = 0` and ramps the main element back up to `S.volume` the same way. A volume-slider
input cancels the ramp (`cancelMainRamp`). It never fires for repeat-one, for a contiguous cue
neighbour, or within one source file.

**Media Session** (`ui/player.ts:484–539`). `updateMediaSession` publishes `MediaMetadata` (title,
artist, album, and artwork from `FULL.url` or the 300 px thumb) plus `playbackState` on every
track change and after the full-size art resolves. `wireMediaSession` binds
`play`/`pause`/`stop`/`previoustrack`/`nexttrack`/`seekto`/`seekbackward`/`seekforward` straight
to the element. There is **no `setPositionState` call** today: Chrome derives position from the
playing element. Chrome shows the media controls because an `HTMLMediaElement` is audibly
playing. Web Audio output alone does not create a controllable media session in Chrome, which is
why the engine keeps the real `<audio>` element busy with an inaudible keep-alive stream (see
§4).

**Document PiP** (`ui/pip.ts`). It holds controls only. Audio keeps playing in the main window. A
300 ms `setInterval` reads `audio.currentTime/duration/paused`. Buttons call
`prev()`/`togglePlay()`/`next(true)`, and the scrubber writes `audio.currentTime`. It's entirely
element-agnostic apart from those reads and writes, so it moves to the facade with no behaviour
change.

**Cue advance** (`ui/player.ts:103–174, 181–196, 298–335`). Tracks carved from one file share a
`srcKey = refOf(folderId, sourcePath)`. `loadTrack` reuses the loaded element when the key
matches (`getLoadedSrcKey()`), and only moves `currentTime`. A rAF loop (and `timeupdate` in
hidden tabs) checks `audio.currentTime >= endSec - 0.02`. For a contiguous next virtual track in
the same source it swaps `S.current` without touching the element, which is true gapless.
Otherwise it calls `pause()` + `next()`.

**Per-track resume** (`ui/player.ts:198–265`). Only for `kind === 'file'` tracks over 600 s.
`maybeSaveResume` (from `timeupdate`) writes `{ key: 'resume:'+ref, sec }` to IDB meta at most
every 5 s while playing. `offerResume` shows a chip that sets `audio.currentTime` (or
`pendingSeek`). `ended` clears the row.

**Restore last track** (`ui/player.ts:785–814`). It loads `src` and sets `pendingSeek =
PREFS.lastPos`, deliberately paused, with `playbackArmed = false`. `loadedmetadata` applies the
seek.

**Native codec failure today** (`ui/player.ts:48–67, 337–351, 764–778`; `state.ts:318–371`). An
`error` event with code 3 or 4 calls `markCodecFailed(codec, code === 4)` and logs "This browser
could not decode …". `playList` then filters `isCodecFailed` tracks out of queues (except the
directly activated target), and `songs.ts:40–60` renders a codec badge on those rows.

**Waveform** (`ui/waveform.ts:213–255`). Peaks come from the sidecar cache (`peaks/<path>.json`
via `audio/peaks.ts` `loadPeaks`/`savePeaks`). Files up to 600 MB are decoded with
`OfflineAudioContext(1, n, 8000).decodeAudioData` (whole `arrayBuffer`). FLAC over 600 MB goes
through the sparse WebCodecs sampler. Any throw lands in the `.catch` at line 219–221,
"undecodable here (ec-3 and friends)", and no peaks are drawn. That's what engine-capable
codecs hit today.

## 3. Codec facts already in the code

- `parse/mp4.ts:63–78` records the first `stsd` sample-entry fourcc of the audio trak as
  `ParsedMeta.codec`, and it's carried to `Track.codec` (`scan/scanner.ts:102, 161, 244`).
- `state.ts` `CODEC_LABELS` maps `alac → Apple Lossless`, `ec-3 → Dolby Digital Plus (Atmos)`,
  `ac-3 → Dolby Digital`.
- `parse/mp4.ts` must not change. The engine gets its own demuxer (`src/audio/mp4samples.ts`)
  that re-walks `moov` for sample tables.

## 4. Plan consequences

- **One facade** (`src/audio/media.ts`, a long-lived `EventTarget`) replaces every `audio` import
  above. `folders.ts:227` stops looking the element up by id. The crossfade ramp in `engine.ts`
  goes through the facade's `volume`. It delegates to the element (native path) or to the engine
  (software path) and re-dispatches events from whichever is active, so listeners bound once at
  boot keep working across a path switch.
- **Media Session with the engine.** While the engine plays, the `<audio>` element plays a tiny
  generated silent WAV on loop. That keeps Chrome's media session, media keys and tab audio
  indicator alive. The facade swallows the element's own events while it's in keep-alive mode,
  and `setPositionState` is published from the engine clock, since the element's position is
  meaningless then.
- **Crossfade tail for engine tracks**: a second, short-lived engine instance plays the tail
  (same `startCrossfadeTail` signature, chosen per codec).
- **Probe element**: stays as-is. Engine-capable MP4s always have an `mdhd` duration, so they
  never reach the probe backfill.

## 5. Toolchain available in this session

| Tool | Status |
|---|---|
| Emscripten (`emcc` / emsdk) | **Not installed.** Installing it needs network access, and the session's permission classifier denied network-scouting and package-install commands (`npm ci` was refused). |
| FFmpeg source | Not present locally. |
| `ffmpeg` binary | Not installed. The only ffmpeg on disk is Playwright's video-recording build (`/opt/pw-browsers/ffmpeg-1011`), which has no audio encoders (`libvpx` + `png` only). |
| clang 18 | Present, **with the `wasm32` target and `wasm-ld`**. No wasi-libc sysroot, so only freestanding C compiles. |
| Node 22.22 | Present. It strips TypeScript types natively, so `node --test` can run `.ts` tests. |
| Global `typescript` 6.0.2, `playwright`, `http-server` | Present in `/opt/node22/lib/node_modules`. Chromium at `/opt/pw-browsers/chromium`. |
| Project `node_modules` | **Absent.** `npm ci` was denied, and `npm ci --offline` fails (`ENOTCACHED`: the local npm cache lacks the packages). So `npm run build` / `build:file` (Vite) can't run here, and `npm run typecheck` needs `vite/client` types. |

Consequence, per the fallback rule in the brief:

- `vendor/decoder/build.sh` + `.github/workflows/build-decoder.yml` produce the real FFmpeg
  decoder on `ubuntu-latest`. The owner runs the workflow once and commits its output.
- Until then the repo carries a **clearly marked stub** `decoder.wasm`, compiled here from the
  same `shim.c` with local clang. It has the same exports and a silent core that emits the
  correct number of frames per packet, so every layer (WASM loading, Worker, Worklet, facade) is
  exercised for real.
- ALAC/E-AC-3/AC-3 fixtures and FFmpeg reference PCM need an `ffmpeg` binary.
  `scripts/make-fixtures.sh` is written for the owner or CI. Tests that need those fixtures skip
  with a message when they're absent. The container and demux tests use synthetic MP4s built in
  the test itself (including a verbatim-frame ALAC stream, which is valid ALAC and needs no
  encoder).
