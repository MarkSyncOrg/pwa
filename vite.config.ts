import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_ORIGIN = 'https://api.xbrowsersync.org';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'MarkSync',
        short_name: 'MarkSync',
        description: 'Standalone MarkSync bookmark manager.',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
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
