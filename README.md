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
`src/adapters/page-metadata.ts` reads what a page says about itself, which is what
the add form suggests as a description and tags.

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
  Filtering is not deletion: since core 0.3.0 an entry already in the store is
  put back before the destructive write that applies a pulled tree, so it stays
  on this device indefinitely without ever being uploaded. That is why the row
  says so rather than just looking broken.
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
its folder path, since a filtered tree hides more than it explains. It matches
titles, URLs, descriptions and tags. Titles and URLs are truncated to one line
(full value in the `title` attribute) and URLs drop their scheme, which keeps a
long tracking URL from taking three lines.

### Descriptions and tags

Both are part of the xBrowserSync bookmark model and neither is browser bookmark
data: no bookmarks API has anywhere to keep them, so they exist only inside the
synced payload. The extension has to hold them in a sidecar beside the browser's
own bookmarks to stop a native round trip from erasing them; the PWA needs no such
thing, because its store *is* the xBrowserSync tree — `LocalBookmarksProvider`
reads and writes whole `Bookmark` nodes, so the metadata is carried by
construction.

A description renders under the URL, clamped to two lines so one verbose entry cannot
push the list off the screen, and tags render below it; both feed the search box.

Both are also **editable when a bookmark is created**, and pre-filled the way the
extension pre-fills them, because the moment a bookmark is added is the only moment at
which the page can still be asked what it would suggest:

- **The add form** has a description field (bounded to the model's 300 characters, with
  a live count) and a comma-separated tags field. Entering a URL asks the page for its
  own `<meta>`, with the extension's precedence — `og:description`, then
  `twitter:description`, then `description`; `og:video:tag` plus `keywords` for tags — so
  both clients suggest the same thing for the same page. Two rules come from the
  extension too: a suggestion only ever fills a field that is **empty**, so nothing the
  user typed is overwritten, and nothing is stored until Add is pressed, which is what
  the hint under the form says.
- **The share hooks** have no review step to offer, so they take the one piece of
  metadata a share sheet can actually carry — its `text`, the page's excerpt or the
  user's selection — and store it as the description. (It used to be used as a fallback
  *title*, which is where a whole paragraph occasionally ended up.) A share whose text is
  just the link again contributes nothing.

Where the two clients genuinely differ is how they see the page, and it is worth being
blunt about it. The extension is *on* the page: it injects a collector into the active
tab under `activeTab` and always has the markup. A PWA never is, so the only way to see a
page's `<meta>` is to fetch it — which CORS usually forbids, since most sites send no
`Access-Control-Allow-Origin` (`no-cors` would not help: the response body would be
opaque). So a miss is the common case here, not the exception, and it is treated as an
ordinary outcome: the fields stay empty and nothing claims otherwise. The fetch is
`credentials: 'omit'` with a 4s timeout, stops reading at `</head>`, and parses into an
inert `DOMParser` document, so a third party's HTML is only ever data. The tags the user
does end up with are normalised by core (`parseTags`), which de-duplicates, sorts and
bounds them — the canonical order both dirty detection and the merge compare by value.

## Develop

```sh
pnpm install        # needs a read:packages token (see below)
pnpm dev            # vite dev server (SW enabled; no CSP — see above)
pnpm build          # typecheck + production build to dist/
pnpm preview        # serve the built dist
pnpm test:e2e       # Playwright: login -> render -> add -> pull -> offline
```

`@marksyncorg/core` comes from GitHub Packages, whose npm registry requires
authentication even though the repo is public — unlike `ghcr.io`, it has no
anonymous read. This is not something the workflow can opt out of: an
unauthenticated `GET https://npm.pkg.github.com/@marksyncorg%2Fcore` returns 401
regardless of visibility. CI already uses the cheapest thing that satisfies it —
the built-in `secrets.GITHUB_TOKEN` with `permissions: packages: read`, not a PAT —
so there is nothing to remove there. The token has to live somewhere pnpm will expand, which is not
this repo's `.npmrc` (see the note in that file):

```sh
pnpm config set '//npm.pkg.github.com/:_authToken' <token with read:packages>
```

Without it `pnpm install` fails with `ERR_PNPM_FETCH_401`. You need it to bump the
dependency too: CI installs with `--frozen-lockfile`, so a version change that did
not regenerate `pnpm-lock.yaml` fails the build rather than being quietly
re-resolved.

### Injection

Titles, descriptions and tags are free text, and core deliberately does not strip markup
from them: a bookmark whose title really is `<b>x</b>` has to keep it, and a client that
rewrote the text would corrupt the sync for every other device. Core bounds and
normalises them — 300 characters for a description, 100 tags of 50 characters — but the
values themselves arrive verbatim, including from another client or a scraped page.

So the guarantee is made where they are rendered, not where they enter. `src/ui/app.ts`
builds every node with `createElement` + `createTextNode`; the repo contains no
`innerHTML`, `insertAdjacentHTML` or `document.write`, so a value is never parsed as
markup. The only attribute that takes a user-controlled value is an `<a href>`, and it is
gated on `isSafeBookmarkUrl` (see the list above). Suggested metadata is parsed out of a
third party's HTML in an inert `DOMParser` document that is never adopted into the page,
so nothing in it runs, requests a subresource or navigates. Two e2e cases pin all of
this with real payloads.

Login inputs go to core: the service URL must be `https` with no query, fragment or
embedded credentials, and the sync ID must be 32 lowercase hex characters — checked
before it is ever interpolated into a request path.

### Content-Security-Policy

The second layer, so that a future `innerHTML` is a console error rather than an exploit.
The policy is served in two forms:

- **A real response header** in `public/_headers`, which is the authoritative one — it can
  carry `frame-ancestors`, which a meta tag silently ignores.
- **A `<meta http-equiv>`** prepended to the built `index.html` by `cspMetaTag()` in
  `vite.config.ts`. Not a fallback: this is what makes `vite preview`, and therefore the
  e2e suite, actually run under the policy instead of production being the first place it
  is ever exercised.

Two copies would normally invite drift, so an e2e case reads the built `_headers` and
asserts its policy equals the meta tag's directive-for-directive, `frame-ancestors` aside
— a change to one and not the other fails CI. Generating the header file from
`vite.config.ts` would have removed the second copy, but only by importing `node:fs`
(this project has no `@types/node`, and adding one for two calls means a lockfile churn)
or by moving the cache rules out of the file the deploy docs point at. The same case also
asserts that inline and cross-origin `<script>` are both refused, which is the property
the policy exists for.

`script-src 'self'` is the directive that does the work: the build emits every script as
a file, so no inline script, no `eval` and no third-party origin is needed. Two directives
are deliberately looser than they look, and it is better to say so than to imply a
strictness that is not there:

- `style-src-attr 'unsafe-inline'` — `index.html` paints the brand background on `<body>`
  before the stylesheet arrives. Attributes only; no `<style>` block and no sheet from
  elsewhere. A browser that does not implement the directive falls back to `style-src` and
  drops the attribute, costing a flash of unstyled background and nothing else.
- `connect-src` admits any `https:` origin plus loopback. It has to: the sync service is
  whatever the **user** enters, and the metadata suggestion fetches arbitrary pages. So
  the policy guards against script injection, not against exfiltration.

The meta tag is injected on build only. `vite dev` injects styles as inline `<style>` and
talks to HMR over a websocket, neither of which this policy allows; a policy relaxed
enough for HMR would not be worth shipping, and a developer's own machine is not the
threat model. (Production is unaffected — it is served the header.)

Alongside the policy, `_headers` sets `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` — the last so that
opening a bookmark never leaks this app's URL to the site being visited.

The e2e suite mocks the xBrowserSync API at the network layer and seeds a sync
blob encrypted with the real core crypto, so it exercises the genuine
decrypt/encrypt path without a live backend. Two cases cover the metadata added when a
bookmark is created: one serves a page whose `<meta>` tags *are* readable (the mock
supplies the `Access-Control-Allow-Origin` a real site would have to) to pin the
precedence, the normalisation and the fill-only-what-is-empty rule; the other pins what
the share hooks do with a shared `text`. Two more pin the injection boundary: markup in a
title, description and tag rendering as text, and a hostile page failing to inject
through the metadata it suggests. Four further cases pin the URL-scheme
policy: dropped on the way in from the service, rejected by the add form and the
share hook, rendered inert if it is already sitting in the local store, and kept
across a pull that rewrites the whole tree while still being left out of the push
(the consumer-side regression test for
[core#3](https://github.com/MarkSyncOrg/core/issues/3)).

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
of `src/ui/styles.css`, dark first with a light palette (cream `#f6f5ee` field,
white panels, near-black `#17170f` text) layered on top for `prefers-color-scheme:
light` and for the header's Auto/Light/Dark toggle, which persists its choice in
`localStorage` and is the only piece of theme state that isn't plain CSS — see
`src/ui/theme.ts`. The brand mark swaps its on-dark/on-light variant on the same
selectors, purely in CSS.

## Share hooks

- **Android:** `share_target` in the manifest (works for installed PWAs).
- **iOS / Shortcuts / Plan B native:** `window.marksyncReceiveSharedUrl(url, title?, text?)`
  and the `?shareUrl=…&shareTitle=…&shareText=…` query params, both handled in
  `src/main.ts`. `text` becomes the bookmark's description; with no title at all it still
  names the bookmark, as it did before there was a description to put it in.

## Deploy

Pushes to `main` publish to Cloudflare Pages via
`.github/workflows/deploy-cloudflare.yml`. The workflow runs the Playwright suite
first and the deploy job `needs:` it, so a red run stops the deploy rather than
shipping past it — that suite is the only automated check this repo has, and it
covers the production bundle, the service worker and the CSP. The build then runs on
Actions and `wrangler` uploads `dist/`. Setup:
[`docs/deploy-cloudflare-pages.md`](docs/deploy-cloudflare-pages.md).

`public/_redirects` (SPA fallback) and `public/_headers` (security headers plus cache control, chiefly
`no-cache` on the service worker) ship with the build, so the routing and
caching rules live with the code rather than in the Cloudflare dashboard.

## Backend

Defaults to `https://api.xbrowsersync.org`. Login uses an existing Sync ID +
password (creating a new sync is out of scope for this prototype).
