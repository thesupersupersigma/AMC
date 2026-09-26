import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { VitePWA } from 'vite-plugin-pwa';

/* The app shows its own version (Settings footer) so a downloaded
   single-file build is identifiable from inside. package.json is the
   source; a release build overrides it from the pushed tag via
   AMC_VERSION so the artifact and the label can never drift apart. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const APP_VERSION = process.env.AMC_VERSION || pkg.version;

/* Application code only ever calls /api/… — in dev and preview these proxies
   serve it, in production the serverless functions in api/ do. */
const proxy: Record<string, ProxyOptions> = {
  /* Declared before /api/itunes — the dev proxy matches in insertion order,
     and artwork lives on the mzstatic CDN, not the Search API host. */
  '/api/itunes/art': {
    target: 'https://is1-ssl.mzstatic.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/itunes\/art/, ''),
  },
  '/api/itunes': {
    target: 'https://itunes.apple.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/itunes/, ''),
  },
  '/api/lrclib': {
    target: 'https://lrclib.net',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/lrclib/, ''),
  },
};

/* build:file must leave no external references at all: no icons, no manifest,
   no registerSW script. The links live on their own lines in index.html. */
function stripExternalLinks(): Plugin {
  return {
    name: 'amc-strip-external-links',
    transformIndexHtml(html) {
      return html.replace(
        /^[ \t]*<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\r?\n/gm,
        ''
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const singlefile = mode === 'singlefile';
  return {
    /* Unminified on purpose: the Chromebook has no DevTools, so stack traces
       only surface in AMC's own error panel, and minified traces are useless. */
    define: { __AMC_VERSION__: JSON.stringify(APP_VERSION) },
    build: {
      minify: false,
      target: 'es2020',
      sourcemap: false,
      outDir: singlefile ? 'dist-file' : 'dist',
    },
    publicDir: singlefile ? false : 'public',
    server: { proxy },
    preview: { proxy },
    plugins: singlefile
      ? [viteSingleFile({ removeViteModuleLoader: true }), stripExternalLinks()]
      : [
          VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            /* public/site.webmanifest is the one manifest; do not generate another. */
            manifest: false,
            workbox: {
              /* wasm: the software decoder (vendor/decoder) must work offline. */
              globPatterns: ['**/*.{js,css,html,ico,png,webmanifest,wasm}'],
              navigateFallback: 'index.html',
              navigateFallbackDenylist: [/^\/api\//],
            },
          }),
        ],
  };
});
