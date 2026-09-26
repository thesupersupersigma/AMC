# Merge notes: `feat/turntable-art` with `feat/decode-engine` / `feat/atmos`

> **Done in v2.3.0 (`release/2.3.0`).** `playback.ts` wraps the `media` facade (§1); the
> engine resamples in its AudioWorklet with a cubic, currentTime in source time, the refill marks
> scaled by the rate and Atmos keyframes kept in sync through the renderer's `setRate` (§2); the
> `player.ts` edits landed as §4 describes; the crossfade tail keeps the rate (§5). The stop/start
> effect now shadows the facade's `pause()` / `play()`, which is also what the Media Session
> handlers call. The rest of this file is the brief as written before the merge.

This branch adds high-res artwork (`src/art/**`) and the turntable Now
Playing mode (`src/ui/turntable/**`, `src/css/turntable.css`). It never
touches `src/audio/**`. This file covers what the merge step has to do.
None of it is implemented here.

## 1. Rewire `src/ui/turntable/playback.ts` to the `media` facade

`src/ui/turntable/playback.ts` is the only turntable file that touches
playback. On this branch it wraps the `<audio id="audio">` element. After
the merge it should wrap the engine branch's `media` facade instead, and no
other turntable file needs to change.

| Adapter export | Today (`<audio>`) | After the merge (`media`) |
|---|---|---|
| `getTime()` | `audio.currentTime` | the facade's current time, in **source-file seconds** |
| `getDuration()` | `audio.duration` (falls back to track data) | the facade's duration of the loaded **source file** |
| `isPaused()` / `isEnded()` | `audio.paused` / `audio.ended` | facade state |
| `seek(sec)` | sets `audio.currentTime`; on a cue side, first moves playback to the song holding `sec` via `playAt` / `playList` | same logic, seeking through the facade |
| `setRate(r)` | `playbackRate` + `defaultPlaybackRate`, `preservesPitch = r === 1`; applied at boot from the saved speed and kept across views | facade rate, **without pitch preservation** (see §2) |
| `setInstantRate(r)` | `playbackRate` only (brake / spin-up ramps) | facade rate, a transient value that must not become the default |
| `getRate()` / `getDefaultRate()` / `pitchPreserved()` | element properties | facade equivalents |
| `interceptTransport(hooks)` | shadows the element's own `pause()` / `play()` so every pause path (player bar, Space, PiP, Media Session) gets the stop/start effect | wrap the facade's `pause()` / `play()` the same way, or add a pre-pause hook to the facade |
| `playTrack(t)` | another song of the album or side, keeping playing / paused (via `playAt` / `playList`); used by the Shift-snap drop | unchanged (player-level) |
| `togglePlayback()` | the player's `togglePlay()`, used by the deck's START·STOP | unchanged |
| `realPause()` / `realPlay()` | `HTMLMediaElement.prototype.pause/play.call(audio)` | the facade's unwrapped methods |
| `syncPositionState()` | `navigator.mediaSession.setPositionState({duration, position, playbackRate})` from the element | the same, from facade state; `playbackRate` must be the **real** current rate |
| `onSeeked` / `onDurationKnown` / `onEnded` | element events `seeked` / `durationchange`+`loadedmetadata` / `ended` | facade events |
| `onTrackChange(cb)` / `notifyTrackChange()` | fired from the player's track-change hook (nowplaying.ts) | unchanged, or driven by a facade track event |

Everything is expressed in **source-file time**. The tonearm on a cue-split
vinyl side walks the whole side, so a virtual track's window
(`startSec` … `endSec`) must still map to the facade's timeline one to one.

## 2. The software engine (ALAC / E-AC-3 / Atmos path) needs rate without pitch preservation

The speed control (16–78 RPM, rate = rpm / 33⅓, about 0.48× to 2.34×) and
the stop/start effect (ramps down to about 0.1× over 0.8 s, then up over
0.4 s) behave like vinyl: **the pitch moves with the speed.** The speed is
a **global playback setting**. It persists as a pref and applies from boot
in every view, not only in turntable mode: the player bar has its own speed
slider next to the volume, and Cover mode has a speed row. Only the
stop/start effect is limited to turntable mode. For
files the engine decodes in software, this means:

- **Variable-rate resampling in the AudioWorklet**, reading from the ring
  buffer. It needs at least cubic (Catmull-Rom / 4-point Hermite)
  interpolation. Linear interpolation audibly aliases at 2.34× and dulls
  the brake sweep. Keep a fractional read position `pos += rate` per output
  sample, and let the rate change every render quantum (the brake ramp
  updates about every 16 ms) without clicks: interpolate the rate across
  the quantum.
- **`currentTime` advances in SOURCE time.** It is the frames the Worklet
  consumed from the ring buffer divided by the source sample rate, not the
  output frames rendered. The platter angle is `currentTime × 200°/s`, so
  at 45 RPM the deck must see time move 1.35× faster.
- **The ring buffer drains `rate` times faster.** The decoder's refill
  watermark has to scale with the current rate. At 2.34× the decoder must
  stay ahead by 2.34× as much.
- **Atmos keyframes stay in sync** as long as the Worklet reports source
  frames consumed. Keyframes are stamped in source frames, so object
  positions follow the same clock the resampler reads with. Do not re-stamp
  them in output frames.
- `setPositionState({ playbackRate })` must report the real rate here as well.

## 3. Hooks added to existing files

Every edit to a pre-existing file is marked `// turntable hook` or
`// hires-art hook`. Line numbers are at this branch's head:

| File | Lines | Hook | What |
|---|---|---|---|
| `api/itunes-art.ts` | 16 | hires-art | body cap 5 MiB → 4.4 MB (under Vercel’s 4.5 MB); host pinning, path check and rate limit untouched |
| `src/main.ts` | 6 | turntable | imports `css/turntable.css` (CSS entry) |
| `src/net/catalog.ts` | 14–15, 201, 207, 267, 272 | hires-art | artwork URL per level, `fetchArtworkSized` step-down, `fetchArtwork` at the current level, `artworkUrlFor` |
| `src/state.ts` | 3, 7–8, 61–64, 86–87, 316, 322, 327–328, 344, 376, 380, 394, 409, 413–414, 474–477, 519–523 | hires-art + turntable | prefs in `AppState` / defaults / `currentPrefs()` / `seedStateFromPrefs()`; cover section: `setCoverHooks`, `coverBlob`, display-sized `makeThumb`, `storeCover(…, fromHero?)`, `FULL` folded into art/hero |
| `src/types.ts` | 397–398, 411–414 | hires-art + turntable | `ArtQuality`; prefs `artQuality`, `npMode`, `ttRpm`, `ttBrake` |
| `src/ui/album.ts` | 4, 9, 19 | hires-art | album header art → `heroArtBox` (hero tier) |
| `src/ui/nowplaying.ts` | 11–13, 153, 165, 167, 184, 237, 243, 262, 273, 283 | hires-art + turntable | hero art for the big cover; turntable markup, mode button, speed panel; open/close/track-change/click/wire hooks |
| `src/ui/pip.ts` | 13, 102 | hires-art | mini player artwork → hero when held |
| `src/ui/player.ts` | 5, 17, 466, 468–470, 478 | hires-art | `ensureFullArt` → hero tier; Media Session artwork with real `sizes` |
| `src/ui/settings.ts` | 17, 84, 312 | hires-art | the one new “Artwork” section + its wiring |

Multi-line blocks (the rewritten cover section of `state.ts`, the artwork
section of `net/catalog.ts`, `ensureFullArt` in `player.ts`) carry the
marker on their opening comment; the listed line is where each block begins.
`git diff 0d44978 -- <file>` shows each one in full.

## 4. `player.ts`: re-apply onto the engine branch's version

Only two things changed in `src/ui/player.ts`, and both will conflict with
the engine branch's rewrite. The intended end state is:

1. **`ensureFullArt(track)`** delegates to the hero tier and holds no art of
   its own:
   ```ts
   import { heroArt, heroCoverURL, trimHeroes } from '../art/hero';
   function ensureFullArt(track: AnyTrack | null): Promise<string> {
     trimHeroes();                      // release heroes that are neither playing nor on the open album page
     if (!track) return Promise.resolve('');
     return heroCoverURL(track).then((url) => (S.current === track ? url : ''));
   }
   ```
   `state.FULL`, `releaseFullArt()` and the `extractArt` import are gone.
   `src/art/hero.ts` owns the playing album's large cover now. Keep the
   existing call pattern in `loadTrack`: publish the Media Session once with
   the thumb, then again when `ensureFullArt` resolves. Never await it
   before playback.
2. **Media Session artwork** in `updateMediaSession(t)`:
   ```ts
   const hero = heroArt(t);
   if (hero) art.push({ src: hero.url, sizes: hero.w + 'x' + hero.h, type: hero.blob.type || 'image/jpeg' });
   else { const u = coverURL(t.coverKey); if (u) art.push({ src: u }); }
   ```
   The hardcoded `sizes: '300x300'` is gone. `hero.ts` also replaces the
   session artwork in place when a hero is re-minted, for example after a
   quality change or a lazy catalog upgrade.

Nothing else in `player.ts` changed. The stop/start effect does **not**
live in `togglePlay()`. It wraps the transport inside the adapter, so the
engine branch's transport code does not have to carry it.

## 5. Other merge-time notes

- The player bar's speed control (`#spdWrap`: button + slider) is mounted
  at boot by `src/ui/turntable/speed.ts` into `#playerbar .pb-right`,
  before `.volwrap`, with no `index.html` edit. If the engine branch
  rebuilds the player bar, keep that container, or move the mount.
- The deck's root class is `.tt-deck`, never `.tt`. The player bar's time
  labels are `.pb-scrub .tt`, and hiding `.tt` collapses the waveform grid.
- `src/audio/engine.ts`'s crossfade tail element (`startCrossfadeTail`)
  plays at 1× even when the speed is 45 RPM. If the engine keeps a
  tail, give it the same rate, or skip the crossfade when the rate is not 1.
- `state.ts`: the prefs `artQuality`, `npMode`, `ttRpm`, `ttBrake` are
  added to `AppState`, `currentPrefs()` and `seedStateFromPrefs()`. If the
  engine or Atmos branches add prefs, both sets should stay.
- The cover section of `state.ts` exposes `setCoverHooks()` and
  `coverBlob()`, and `storeCover(key, blob, fromHero?)` gained its third
  argument.
- `api/itunes-art.ts` only changed its body cap, from 5 MiB to 4.4 MB,
  under Vercel's 4.5 MB function response limit.
