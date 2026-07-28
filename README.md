# MarkSync PWA

Standalone bookmark manager (xBrowserSync-compatible) as an installable,
offline-capable PWA.
No `browser.bookmarks` — the bookmarks live in the PWA's own IndexedDB store, so it
works on iOS/Safari where no host bookmark API exists.

All crypto, API and sync logic comes from
[`@marksyncorg/core`](https://github.com/MarkSyncOrg/core), installed from
GitHub Packages. This repo is the consumer: IndexedDB/local-store adapters, a
plain TS + DOM UI, the service worker and the manifest.

## Architecture

```
@marksyncorg/core         this repo (adapters)
  StorageArea       <--   IndexedDbStorageArea   (src/adapters/indexeddb-storage.ts)
  BookmarkProvider  <--   LocalBookmarksProvider (src/adapters/local-bookmarks.ts)
  SyncEngine / crypto / api client / bookmark model
```

`src/main.ts` wires the adapters into the `SyncEngine`; `src/ui/app.ts` is the
framework-free view (login, list + search, add form).

## List view

Browsing shows the container tree as expandable folders (native `<details>`,
so keyboard and screen readers get the disclosure semantics for free), each
labelled with the number of bookmarks below it. Top-level containers start
open, deeper folders closed; toggles are remembered per folder id — a title
path, not an index — so an add or a sync does not reshuffle what is expanded.

Searching switches the same element to a flat list of matches, each tagged with
its folder path, since a filtered tree hides more than it explains. Titles and
URLs are truncated to one line (full value in the `title` attribute) and URLs
drop their scheme, which keeps a long tracking URL from taking three lines.

## Develop

```sh
pnpm install        # needs a read:packages token for @marksyncorg/core
pnpm dev            # vite dev server (SW enabled)
pnpm build          # typecheck + production build to dist/
pnpm preview        # serve the built dist
pnpm test:e2e       # Playwright: login -> render -> add -> pull -> offline
```

The e2e suite mocks the xBrowserSync API at the network layer and seeds a sync
blob encrypted with the real core crypto, so it exercises the genuine
decrypt/encrypt path without a live backend.

## Brand assets

`public/brand/` holds the MarkSync SVG marks and lockups (on-light and on-dark
variants); `public/icons/` holds the rasterized PWA/favicon set exported from
them. Both are committed — nothing generates them at build time. When the brand
assets change upstream, re-export and replace these files; `icon-maskable-512.png`
is `icon-512.png` scaled to 80% on the same `#0e0e0b` field, which is the safe
zone Android's circular mask needs.

The UI follows [marksync.org](https://marksync.org): near-black `#0e0e0b` field,
`#14140f` panels on `#2a2a22` hairlines, cream `#f5f4ec` text, lime `#c8f542`
accent, and square corners throughout (the site uses no `border-radius`
anywhere). Archivo carries UI text, IBM Plex Mono the labels and metadata — both
declared with system fallbacks rather than fetched from a font CDN, since the
shell must render offline. All of it lives in the custom properties at the top
of `src/ui/styles.css`.

## Share hooks

- **Android:** `share_target` in the manifest (works for installed PWAs).
- **iOS / Shortcuts / Plan B native:** `window.marksyncReceiveSharedUrl(url, title?)`
  and the `?shareUrl=…&shareTitle=…` query param, both handled in `src/main.ts`.

## Deploy

Pushes to `main` publish to Cloudflare Pages via
`.github/workflows/deploy-cloudflare.yml`: the build runs on Actions and
`wrangler` uploads `dist/`. Setup:
[`docs/deploy-cloudflare-pages.md`](docs/deploy-cloudflare-pages.md).

`public/_redirects` (SPA fallback) and `public/_headers` (cache control, chiefly
`no-cache` on the service worker) ship with the build, so the routing and
caching rules live with the code rather than in the Cloudflare dashboard.

## Backend

Defaults to `https://api.xbrowsersync.org`. Login uses an existing Sync ID +
password (creating a new sync is out of scope for this prototype).
