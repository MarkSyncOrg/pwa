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

Pushes to `main` publish the build to the Virtualmin virtual host at
<https://vv.picone.it> via `.github/workflows/deploy-virtualmin.yml` (build on
Actions, upload the static `dist/` over FTPS with `lftp`). Server and GitHub
setup: [`docs/deploy-virtualmin.md`](docs/deploy-virtualmin.md).

`public/.htaccess` ships with the build and carries the vhost's SPA fallback and
cache headers, so the server holds no hand-maintained config.

## Backend

Defaults to `https://api.xbrowsersync.org`. Login uses an existing Sync ID +
password (creating a new sync is out of scope for this prototype).
