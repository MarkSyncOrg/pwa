# Deploying to Cloudflare Pages

`.github/workflows/deploy-cloudflare.yml` builds the PWA on GitHub Actions and
uploads `dist/` to Cloudflare Pages with `wrangler` (Direct Upload).

Flow on every push to `main` (and on manual dispatch):

1. `pnpm install && pnpm gen:icons && pnpm build` → `dist/`
2. check that `index.html`, `_redirects` and `_headers` are in the output
3. `wrangler pages deploy dist`
4. `curl` smoke check against the URL that deployment returned

## Why not Cloudflare's Git integration

Cloudflare Pages can watch the repo and run the build itself, which would need
no workflow at all. It is the wrong fit here for one reason: `@marksyncorg/core`
is a **private** GitHub Packages dependency. A Cloudflare-side build would need
a GitHub PAT with `read:packages` stored in the Pages project — a long-lived
cross-provider credential that has to be rotated by hand.

Building in Actions avoids it entirely: the workflow's built-in `GITHUB_TOKEN`
already reads the package, and Cloudflare only ever receives static files.

**Do not connect the Git integration as well.** A project configured for both
builds every push twice, and the two deployments race for the production alias.
Create the project as *Direct Upload*.

## Cloudflare setup (once)

1. **Create the project.** Either from the dashboard (Workers & Pages → Create →
   Pages → **Direct Upload**), or:

   ```sh
   npx wrangler pages project create marksync-pwa --production-branch=main
   ```

   The name must match `CLOUDFLARE_PROJECT_NAME` below, and the production
   branch must be `main` — `wrangler` passes `--branch`, and Cloudflare treats a
   deploy as production only when that branch matches the project setting.
   Anything else lands as a preview on its own URL.

2. **API token.** My Profile → API Tokens → Create Token → Custom token, with
   permission **Account → Cloudflare Pages → Edit**. Scope it to the one
   account. Nothing else is needed — the workflow only uploads.

3. **Account ID.** Workers & Pages → Overview, right-hand sidebar (also the
   hex string in the dashboard URL).

4. **Custom domain**, if you want one: project → Custom domains → Set up a
   domain. Cloudflare issues and renews the certificate; nothing in this repo
   references a hostname.

## GitHub configuration (once)

Repository **secrets** (Settings → Secrets and variables → Actions):

| Secret | Notes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 3 |

Repository **variables**:

| Variable | Example | Notes |
| --- | --- | --- |
| `CLOUDFLARE_PROJECT_NAME` | `marksync-pwa` | optional, defaults to `marksync-pwa` |

## Static config shipped with the build

Both files live in `public/`, so Vite copies them to the root of `dist/`, and
Cloudflare consumes them as edge config rather than serving them as files.

- **`_redirects`** — `/* /index.html 200`, the SPA fallback. Static assets are
  matched first, so it only catches client-side routes.
- **`_headers`** — `immutable` caching for the content-hashed files under
  `assets/`, and `no-cache` for the entry points. `sw.js` matters most: a cached
  service worker keeps clients on an old build indefinitely.

## Deployments and rollback

Every upload is a new immutable deployment with its own permanent URL, and the
production alias is switched at the end. That makes rollback a dashboard
action — project → Deployments → *Rollback* on an earlier one — rather than a
rebuild, so nothing in this repo has to handle it.

The job runs in the `cloudflare-pages` GitHub environment, so deploys also show
up in the repo's Deployments view. Add required reviewers there (Settings →
Environments → cloudflare-pages) if pushes to `main` should not publish
unattended.

## Access to `@marksyncorg/core`

The private `@marksyncorg/core` package lives in the same org as this repo, so
the workflow's built-in `GITHUB_TOKEN` can read it. The one prerequisite is on
the package side — in its *Package settings → Manage Actions access*,
`MarkSyncOrg/pwa` must be listed with at least **Read**. If it is not,
`pnpm install` fails with a 401/403 from `npm.pkg.github.com`.

The committed `pnpm-lock.yaml` still pins the pre-migration
`@xbrowsersync/core` git dependency, which is why the workflow installs with
`--no-frozen-lockfile`. Regenerating it requires a local `read:packages` token:

```sh
NODE_AUTH_TOKEN=<pat> pnpm install --lockfile-only
```

Commit the result and the flag can be dropped in favour of a frozen install.

## Troubleshooting

- **`Project not found`** — the project does not exist, or
  `CLOUDFLARE_PROJECT_NAME` does not match its name.
- **`Authentication error [code: 10000]`** — the API token lacks
  *Cloudflare Pages: Edit*, or `CLOUDFLARE_ACCOUNT_ID` belongs to a different
  account than the token.
- **Deploy succeeds but the site is not updated** — it landed as a preview:
  the project's production branch is not `main`.
- **Deep links 404** — `_redirects` did not reach the root of `dist/`; the
  workflow's build check catches this before deploying.
- **Clients stuck on an old build** — check `Cache-Control` on `/sw.js`; it must
  be `no-cache`.
