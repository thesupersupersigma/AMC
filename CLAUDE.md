# AMC

Local-first music player. Apple Music–style UI over a folder of audio files on disk.
TypeScript + Vite, no framework. Deployed to Vercel at `music.thesupersupersigma.com`.

## Before doing anything

Read `ignored/V2-BUILD-PROMPT.md`. It is the build spec — six phases, each behind a
verification gate. **Work one phase at a time and stop at that phase's gate.** Do not
continue into the next phase without being asked.

Supporting docs, also in `ignored/`:
- `brainstorm.md` — every design decision and why, including rejected options
- `FEATURES.md` — all 136 features and whether each existed in v1
- `player.html` — the working v1 single-file player being ported

## Non-negotiable rules

**Never rewrite the metadata parsers.** `player.html` contains correct, hard-won
implementations of FLAC, MP4 and ID3 parsing. Port them to TypeScript by converting
syntax only. Do not touch the arithmetic or control flow. Specifically:
- Vorbis comment lengths are little-endian; every other FLAC field is big-endian
- `Bits.read()` uses `v * 2 + bit`, not bit shifts — the STREAMINFO sample count is
  36 bits and JS bitwise operators are 32-bit
- MP4 `meta` has 4 extra bytes before its children; `moov` may be at file end
- ID3v2 sizes are syncsafe

If a port changes a parser's output for any file, the port is wrong.

**Never read a whole audio file into memory.** Always `File.slice()`. FLAC tracks run
25–40 MB and vinyl sides are 42 minutes. For analysis, decode into an
`OfflineAudioContext(1, length, 8000)` — never a full-rate `AudioContext`.

**Track identity is `folderId + path`.** Never `path` alone, never the cache key
(`name|size|lastModified`), which changes whenever a file is re-tagged.

**No `alert()`, `confirm()` or `prompt()`.** Native dialogs look broken against this UI.

**No network at runtime** beyond `/api/itunes` and `/api/lrclib`. AMC must stay fully
usable offline.

**Every storage write is wrapped and degrades.** IndexedDB, `localStorage` and sidecar
writes all fail gracefully to in-memory with a line in the error panel.

## Environment facts — verified, do not re-derive

- `file://` has an opaque origin: no File System Access, no service worker, no ES module
  loading. It *is* a secure context, so Media Session works there.
- Safari implements no local-disk pickers at all — only OPFS. It always uses the
  read-only `webkitdirectory` fallback. That is expected, not a bug.
- Chrome 122+ offers "Allow on every visit", which is what makes folder access persist.
- Target Chromebook: 4 threads, 8 GB, 1365×611 viewport, **no DevTools**. Stack traces
  only ever surface in AMC's own error panel — keep builds unminified.

## Assets

`public/` already contains the full icon set and `site.webmanifest`. Use those exact
paths. Do not create `public/icons/` or a second manifest.
