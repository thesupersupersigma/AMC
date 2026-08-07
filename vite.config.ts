import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { VitePWA } from 'vite-plugin-pwa';

/* Application code only ever calls /api/… — in dev and preview these proxies
   serve it, in production the serverless functions in api/ do. */
const proxy: Record<string, ProxyOptions> = {
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
              globPatterns: ['**/*.{js,css,html,ico,png,webmanifest}'],
              navigateFallback: 'index.html',
              navigateFallbackDenylist: [/^\/api\//],
            },
          }),
        ],
  };
});
