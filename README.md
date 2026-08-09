<div align="center">

<img src="public/android-chrome-512x512.png" width="128" alt="AMC">

# AMC

**A local-first music player for your own files.**

Point it at a folder. It reads your tags, cover art, cue sheets and lyrics
straight off disk — and nothing ever leaves your machine.

[Live app](https://music.thesupersupersigma.com) · [Releases](https://github.com/thesupersupersigma/AMC/releases)

</div>

---

## What it is

AMC plays the music you already own. It scans a folder in place, reads metadata
directly from the files, and stores everything it learns in a sidecar folder
next to your music — so your playlists, lyrics and corrections travel with the
library instead of living in a browser profile.

No account, no upload, no telemetry. The only network calls it ever makes are
optional metadata and lyrics lookups, and it works completely offline without
them.

## Features

**Formats** — FLAC, M4A/AAC, MP3, WAV, Opus. Tags, embedded artwork and
durations parsed from scratch: FLAC Vorbis comments and PICTURE blocks, MP4
`ilst` atoms, ID3v2.

**Cue sheets** — vinyl rips work properly. One long FLAC plus a `.cue` becomes
real tracks with real names, and playback crosses boundaries **gaplessly**
because it never re-seeks within a rip. Embedded FLAC CUESHEET blocks, sibling
`.cue` files and multi-FILE sheets are all handled.

**Unsplit rips** — a long file with no cue gets flagged, and *Find track breaks*
detects silence, proposes split points and lets you name and nudge them before
writing a cue.

**Waveform scrubber** — real peaks, even on multi-gigabyte 24/192 rips, via
streaming WebCodecs decode. Cue boundaries show as markers on the scrubber.

**Synced lyrics** — Apple-style line scrolling with word-by-word fill for
Enhanced LRC. Reads `.lrc` files, embedded tags, or LRCLIB, and caches to the
sidecar so it works offline afterwards. Includes a built-in LRC editor.

**Metadata repair** — match an album against the iTunes catalog and review every
proposed change in a diff table before anything is applied. Edition-aware: a
1987 pressing won't silently become a 2012 remaster. There's also an AI repair
path that exports a schema-locked prompt for anything the catalog can't know.
**Audio files are never modified** — corrections live in an overrides layer.

**Library** — Albums, Artists, Songs, Recently added, playlists with drag
reorder, M3U import and export, export-a-playlist-as-real-files, album shuffle
across a selection, search operators (`artist:jackson year:1987`), per-track
resume, and a Document Picture-in-Picture mini player.

## Builds

Each release ships two artifacts.

**`amc-dist-v<version>.zip`** — the full PWA build. **Must be served, not
double-clicked.** Unzip it behind any static server (`npx serve dist`, nginx,
Vercel). Served, it installs as an offline app and — on Vercel — carries the
`/api` proxies for catalog and lyrics.

**`AMC-v<version>.html`** — the single-file build. **Opens directly from disk**,
no server, no install. Folder access is read-only (browsers offer no writable
picker on `file://`), and catalog/lyrics reach the deployed proxy while online,
degrading to the sidecar when offline.

| | Served | Single file |
|---|---|---|
| Read your folder | yes | yes |
| Write the sidecar | yes | no, read-only |
| Remember the folder | yes | re-pick each launch |
| Catalog and lyrics | yes | via the hosted API when online |
| Install as an app, offline | yes | n/a |

Or just open [music.thesupersupersigma.com](https://music.thesupersupersigma.com),
install it from the address bar, and it runs offline from then on.

## Development

```bash
npm ci
npm run dev        # vite on http://localhost:5173 with /api proxies
npm run build      # dist/ — the served PWA build
npm run build:file # dist-file/index.html — the single-file build
npx tsc --noEmit   # strict typecheck
```

Releases are built by `.github/workflows/release.yml` on any `v*` tag push. The
workflow verifies that the tag matches `package.json` before building.

## The sidecar

AMC creates a folder called `AMC DO NOT DELETE` inside your music folder:

```
AMC DO NOT DELETE/
  playlists/*.m3u8    standard M3U — opens in VLC
  cues/*.cue          generated and edited cue sheets
  lyrics/*.lrc        synced lyrics
  overrides.json      metadata corrections
  notes/  settings.json
  artwork/  catalog/  peaks/   ← regenerable caches, safe to delete
```

Everything except the caches is yours and can't be regenerated — that's why the
folder is named the way it is. Move the music folder to another machine and the
whole library goes with it.

## Browser support

Full support needs the File System Access API: **Chrome and Edge 122+**, where
choosing *Allow on every visit* means the folder is remembered permanently.

Safari and Firefox implement no directory picker, so AMC falls back to a
read-only mode — it plays fine, but the folder is re-picked each session and the
sidecar can't be written.

## Built with

TypeScript and Vite. No framework, no UI library, no runtime dependencies. Every
parser — FLAC, MP4, ID3, CUE, LRC — is hand-written and reads only file headers,
never whole files.

---

AMC is not affiliated with, endorsed by, or connected to Apple Inc.
Apple Music is a trademark of Apple Inc.


<div align="center">

Made by [thesupersupersigma](https://github.com/thesupersupersigma) and Claude Fable 5

</div>