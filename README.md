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

## Develop

```sh
pnpm install        # needs a read:packages token for @marksyncorg/core
pnpm gen:icons      # generate PWA icons into public/icons (gitignored)
pnpm dev            # vite dev server (SW enabled)
pnpm build          # typecheck + production build to dist/
pnpm preview        # serve the built dist
pnpm test:e2e       # Playwright: login -> render -> add -> pull -> offline
```

The e2e suite mocks the xBrowserSync API at the network layer and seeds a sync
blob encrypted with the real core crypto, so it exercises the genuine
decrypt/encrypt path without a live backend.

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
