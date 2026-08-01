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

## Security responsibilities of this repo

Core sanitises every bookmark tree that crosses a trust boundary — a decrypted
sync payload, a backup file, the tree it is about to upload. Its `SECURITY.md`
names three things a consuming app has to handle itself; here is where each one
lands:

- **Check URLs before rendering.** The list renders from the local IndexedDB
  store, which core never sees, so `bookmarkItem` in `src/ui/app.ts` runs
  `isSafeBookmarkUrl` and shows an unsafe entry as inert struck-through text
  instead of an `<a href>`. The add form and the share hooks reject the same
  schemes up front — core would silently drop them from the uploaded tree, so a
  bookmark accepted here would look saved and never reach another device.
- **The storage area holds the decryption key.** `SyncInfo.passwordHash` is the
  AES key, and `IndexedDbStorageArea` is plain IndexedDB — anything with script
  access to this origin can decrypt the whole sync. That is inherited
  xBrowserSync behaviour and cannot change without breaking compatibility, so
  treat "device or origin compromised" as "sync compromised".
- **The service is trusted for freshness, not for history.** A compromised
  service can replay an older, genuinely valid payload and the client will
  accept it. Core requires `https` (plain `http` only for loopback), which the
  login form's service URL now goes through.

Two login-time behaviours come from core and surface as ordinary form errors:
the service URL must be `https` with no query, fragment or embedded credentials,
and the sync ID must be 32 lowercase hex characters (checked before the
250k-iteration key derivation, so a typo fails immediately).

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
decrypt/encrypt path without a live backend. Three of its cases pin the URL-scheme
policy: dropped on the way in from the service, rejected by the add form and the
share hook, and rendered inert if it is already sitting in the local store.

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
