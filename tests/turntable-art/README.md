# Turntable + high-res artwork tests

These run AMC in headless Chromium through Playwright's preinstalled
browser. Never run `playwright install`. They load a generated library
through the read-only `webkitdirectory` fallback and use an OPFS-backed
folder for the writable-sidecar path. `/api/itunes` and
`/api/itunes/art` are stubbed inside the browser, so the real proxy is
never called.

```bash
# 1. fixtures (needs ffmpeg with flac, mp3 and aac; FFMPEG=/path overrides)
node tests/turntable-art/make-fixtures.mjs /tmp/amc-fx

# 2. every suite against one fresh dev server
FIXTURES=/tmp/amc-fx/TTLib NODE_PATH=$(npm root -g) node tests/turntable-art/run.mjs
#    or only some: … run.mjs art catalog

# 3. the PR screenshots, written to docs/turntable/
FIXTURES=/tmp/amc-fx/TTLib NODE_PATH=$(npm root -g) node tests/turntable-art/screenshots.mjs
```

| Suite | Covers |
|---|---|
| `proxy` | `api/itunes-art.ts` body cap under Vercel's 4.5 MB; host pinning, path validation and rate limit unchanged |
| `art` | hero size per quality level, original bytes reused, display-sized thumbs, lazy migration of 300 px thumbs, hero sites, at most two heroes held |
| `catalog` | catalog size per level, Max step-down on a 502 or 413 "too large", sidecar `artwork/` write, IndexedDB fallback, paced re-download, lazy upgrade, Settings → Artwork |
| `turntable` | mode toggle and pref, fit at 1365×611 and 1920×1080, the adapter, 200°/s spin, tonearm at 0/50/100 %, cue-side mapping, mouse and touch drag-to-seek, keys and ARIA, record swap vs same album, five rapid skips, RPM and pitch, Media Session rate, reset on exit, the brake |
| `polish` | reduced motion, lyrics beside the deck, the frame budget |

Do not edit `src/` while a run is in progress. Vite reloads the page and the
run fails with "execution context was destroyed".
