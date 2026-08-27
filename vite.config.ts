import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

const API_ORIGIN = 'https://api.xbrowsersync.org';

/**
 * Content-Security-Policy, as one list used two ways (see `securityHeaders` below).
 *
 * The app renders bookmark text written by other clients and metadata scraped from pages
 * it does not control. `src/ui/app.ts` already builds every node with text nodes and
 * gates the one user-controlled attribute (`<a href>`) on `isSafeBookmarkUrl`, which is
 * what actually makes that safe — this is the second layer, so that a future `innerHTML`
 * is a console error instead of an exploit.
 */
const CSP_DIRECTIVES = [
  // Nothing loads unless something below allows it.
  "default-src 'self'",
  // The directive that stops script injection: no inline script, no eval, nothing from
  // another origin. It costs nothing here — the build emits every script as a file
  // (/assets/*.js plus registerSW.js) and the app has no inline script at all.
  "script-src 'self'",
  "style-src 'self'",
  // index.html paints the brand background on <body> before the stylesheet arrives.
  // This permits an inline style *attribute* and nothing else: no <style> block, no
  // sheet from another origin. A browser that does not implement the directive falls
  // back to style-src and drops the attribute, which costs a flash of unstyled
  // background and nothing more.
  "style-src-attr 'unsafe-inline'",
  "img-src 'self'",
  // The brand faces are declared with system fallbacks rather than fetched, so that the
  // shell renders offline; nothing should ever load a font.
  "font-src 'none'",
  // Deliberately broad, and worth being explicit about rather than looking strict: the
  // app connects to a sync service the *user* chooses (any https origin, or http on
  // loopback for a self-hosted one) and fetches arbitrary pages for the metadata
  // suggestion. No narrower list exists that does not break those two features. So the
  // policy here guards against script injection, not against exfiltration.
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "manifest-src 'self'",
  "worker-src 'self'",
  // No plugins, no framing, and no <base> that could silently re-point every relative
  // URL in the document.
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  // Every form is submitted through JS with preventDefault, so a submit that actually
  // navigates means something already went wrong; it must not be able to carry the
  // password field anywhere.
  "form-action 'none'",
];

/**
 * Injects the policy above into the built index.html as a `<meta http-equiv>`, prepended
 * to `<head>` so it governs the resources declared after it.
 *
 * Production is served the policy as a real response header instead, from
 * `public/_headers` — that form is authoritative and can carry `frame-ancestors`, which a
 * meta tag ignores. Keeping the two in step is the job of an e2e case that reads the
 * built `_headers` and asserts its policy matches this one directive-for-directive, since
 * generating the header file here would mean either a `node:fs` import this project has
 * no `@types/node` for, or moving the cache rules out of the file the deploy docs point
 * at. A test that fails on drift buys the same guarantee for neither cost.
 *
 * The meta form is not merely a fallback: it is what makes `vite preview`, and therefore
 * the e2e suite, actually run under the policy rather than production being the first
 * place it is ever exercised.
 *
 * Build only. `vite dev` injects styles as inline <style> elements and talks to its HMR
 * server over a websocket, neither of which a policy this strict allows. A developer's
 * own machine is not the threat model, and a policy relaxed enough for HMR would not be
 * worth shipping.
 */
function cspMetaTag(): Plugin {
  return {
    name: 'marksync-csp-meta-tag',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: CSP_DIRECTIVES.join('; '),
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

export default defineConfig({
  // Single source of truth for the versions shown in the header (see ui/app.ts) and
  // sent as SyncEngine's appVersion: package.json, inlined at build time so neither
  // ever drifts from a second hardcoded literal. The core version is read from the
  // pinned dependency entry rather than @marksyncorg/core's own package.json, since
  // that is what is actually installed and it needs no exact-version lookup logic.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __CORE_VERSION__: JSON.stringify(pkg.dependencies['@marksyncorg/core']),
  },
  plugins: [
    cspMetaTag(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icons/apple-touch-icon.png',
        'icons/favicon-32.png',
        'brand/marksync-mark.svg',
        // Light-theme mark: shown by styles.css whenever the light theme is active
        // (system preference or the header's toggle), so it needs the same offline
        // guarantee as the on-dark one above.
        'brand/marksync-mark-onlight.svg',
      ],
      manifest: {
        name: 'MarkSync',
        short_name: 'MarkSync',
        description: 'Standalone MarkSync bookmark manager.',
        // Matches the flat background of the brand icons, so the install splash
        // and the Android toolbar read as one surface with the app icon.
        theme_color: '#0e0e0b',
        background_color: '#0e0e0b',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        // Android: native web share target. Lands on the PWA with the shared URL as
        // a query param, which main.ts reads (same path as the iOS ?shareUrl hook).
        share_target: {
          action: '/',
          method: 'GET',
          params: { url: 'shareUrl', text: 'shareText', title: 'shareTitle' },
        },
      },
      workbox: {
        // Precache the app shell so reloads work fully offline.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // xBrowserSync API: network-first so we get fresh data online, but fall
            // back to the last cached response when offline.
            urlPattern: ({ url }) => url.origin === API_ORIGIN,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'marksync-api',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
});
