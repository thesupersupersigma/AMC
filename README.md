# AMC

A local-first music player: an Apple Music–style UI over a folder of audio
files on your own disk. Nothing is uploaded anywhere — scanning, tags, cue
sheets, waveforms and playlists all happen in the browser, and everything
the app learns lives beside the music in a sidecar folder.

Deployed at [music.thesupersupersigma.com](https://music.thesupersupersigma.com).

## Builds

Each release ships two artifacts:

- **`amc-dist.zip`** — the full PWA build. **This one must be served, not
  double-clicked**: unzip it and put it behind any static server
  (`npx serve dist`, nginx, Vercel…). Served, it installs as an offline app
  and (on Vercel) carries the `/api` proxies for catalog and lyrics lookups.
  Opened straight from disk it runs in a degraded `file://` mode with no
  service worker and read-only folder access.

- **`AMC.html`** — the single-file build. **Opens directly from disk** —
  one double-clickable HTML file, no server, no install. Folder access is
  read-only in this mode (the browser offers no writable pickers on
  `file://`), and catalog/lyrics lookups reach the deployed proxy while
  online, degrading to the sidecar when offline.

## Development

```bash
npm ci
npm run dev        # vite on http://localhost:5173 with /api proxies
npm run build      # dist/ — the served PWA build
npm run build:file # dist-file/index.html — the single-file build
npx tsc --noEmit   # strict typecheck
```

Releases are built by `.github/workflows/release.yml` on any `v*` tag push.

---

AMC is not affiliated with, endorsed by, or connected to Apple Inc.
Apple Music is a trademark of Apple Inc.

Made by [thesupersupersigma](https://github.com/thesupersupersigma) and Claude Fable 5.
