# Deploying to Virtualmin (vv.picone.it)

`.github/workflows/deploy-virtualmin.yml` builds the PWA on GitHub Actions and
uploads the static `dist/` to the Virtualmin virtual host over **FTPS**. The
server runs no build step and needs no toolchain — it only receives files.

Flow on every push to `main` (and on manual dispatch):

1. `pnpm install && pnpm gen:icons && pnpm build` → `dist/`
2. sanity-check the remote target (see *The delete pass* below)
3. upload with `lftp` over FTPS, in three phases
4. `curl` smoke check against `https://vv.picone.it/`

## Why FTPS and not plain FTP

The workflow sets `ftp:ssl-force true` and `ftp:ssl-protect-data true`, so
`lftp` negotiates AUTH TLS and **refuses to continue** if the server will not
do TLS, rather than silently falling back. Over plain FTP the password and the
whole upload cross the network in the clear, and a deploy credential that can
overwrite the document root is worth protecting.

This requires TLS enabled in ProFTPD (Virtualmin: *Servers → ProFTPD → SSL/TLS*,
or *Features and Plugins → SSL website* for the domain's certificate). The
certificate must match the hostname in `VIRTUALMIN_FTP_HOST`, since the
workflow keeps `ssl:verify-certificate true`.

## Upload order

FTP cannot swap a directory into place, so unlike an SSH deploy there is no
atomic cutover: for the duration of the upload the document root is a mix of
the old and the new build. The phase order keeps that state loadable:

1. **Hashed assets** — Vite emits content-hashed filenames, so these are purely
   additive. The live build keeps serving its own files, untouched.
2. **Entry points** — `index.html`, `sw.js`, `registerSW.js`,
   `manifest.webmanifest`. This is the moment the site flips to the new build,
   by which point every asset it references is already there.
3. **Delete pass** — removes files from previous builds, no longer referenced.

A client loading the site mid-deploy therefore gets either the complete old
build or the complete new one, not a broken mix. The residual risk is a run
that dies between phases 1 and 2 (site stays on the old build — harmless) or
mid-phase 2 (`index.html` new, `sw.js` old, until the next run). If that
matters more than the convenience of FTP, an SSH deploy removes the window
entirely by swapping a staging directory in server-side.

## The delete pass

Phase 3 deletes remote files that are not in `dist/`, which makes a wrong
`VIRTUALMIN_FTP_DIR` destructive. Two safeguards:

- Paths owned by the server are excluded from deletion: `.well-known/` (its
  removal would break ACME certificate renewal), `cgi-bin/`, `stats/`,
  `awstats/`.
- Before uploading, the workflow lists the target and aborts if it contains
  names that only exist in a Virtualmin *home* directory (`public_html`,
  `mail`, `logs`, `homes`, `cgi-bin`, `fcgi-bin`, `.ssh`) — i.e. if the path
  points one level too high.

## Server setup (once)

1. **Virtual server.** Create `vv.picone.it` in Virtualmin (own domain or
   sub-server) with SSL enabled.

2. **FTP user.** Prefer a dedicated user over the domain owner: Virtualmin
   *Edit Users → Add a website FTP access user*, with its home set to
   `public_html`. Chrooted there, the credential cannot reach `mail/`, `logs/`
   or the rest of the account even if it leaks — and `VIRTUALMIN_FTP_DIR`
   becomes `.`. Using the domain owner instead works too; then the directory is
   `public_html`.

3. **Apache.** Nothing to configure by hand: `public/.htaccess` is copied into
   the build and deployed with it (SPA fallback, cache headers). It requires
   `AllowOverride All` on the document root — Virtualmin's default for a
   virtual server. `mod_rewrite` and `mod_headers` must be enabled.

## GitHub configuration (once)

Repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Example | Notes |
| --- | --- | --- |
| `VIRTUALMIN_FTP_HOST` | `vv.picone.it` | must match the FTPS certificate |
| `VIRTUALMIN_FTP_DIR` | `public_html` | document root as the FTP user sees it; `.` for a user chrooted to it. Optional, defaults to `public_html` |

Repository **secrets**:

| Secret | Notes |
| --- | --- |
| `VIRTUALMIN_FTP_USER` | the FTP user from step 2 |
| `VIRTUALMIN_FTP_PASSWORD` | its password |

Credentials are written to a `chmod 600` `~/.netrc` on the runner rather than
passed on the `lftp` command line, where they would show up in the process
list, and the file is removed even if the upload fails.

### Access to `@marksyncorg/core`

No PAT is needed: the private `@marksyncorg/core` package now lives in the same
org as this repo, so the workflow's built-in `GITHUB_TOKEN` can read it. The
one prerequisite is on the package side — in its *Package settings → Manage
Actions access*, `MarkSyncOrg/pwa` must be listed with at least **Read**. If it
is not, `pnpm install` fails with a 401/403 from `npm.pkg.github.com`.

The committed `pnpm-lock.yaml` resolves `@marksyncorg/core` from GitHub
Packages; workflows still install with `--no-frozen-lockfile` so a lockfile
drift cannot break the deploy. Regenerating it locally needs a token that can
read packages:

```sh
NODE_AUTH_TOKEN=<pat> pnpm install --lockfile-only
```

Commit the result and the flag can be dropped in favour of a frozen install.

## Deploy environment

The job runs in the `virtualmin` GitHub environment, so deploys show up in the
repo's Deployments view. Add required reviewers there (Settings →
Environments → virtualmin) if pushes to `main` should not publish unattended.

## Troubleshooting

- **`Fatal error: SSL not available`** / connection closed at login — TLS is not
  enabled in ProFTPD. The workflow will not fall back to plaintext by design.
- **`Certificate verification: ... certificate common name doesn't match`** —
  `VIRTUALMIN_FTP_HOST` is not a name on the server's certificate. Use the
  hostname the certificate was issued for.
- **`530 Login incorrect`** — wrong credentials, or the FTP user is disabled in
  Virtualmin.
- **Deploy aborts with "looks like the FTP home"** — `VIRTUALMIN_FTP_DIR` points
  at the account home. Set it to `public_html`, or to `.` for a chrooted user.
- **Hangs during transfer** — the runner needs passive mode (already set) and
  the server's passive port range must be open in the firewall.
- **Deep links 404** — `AllowOverride` is not `All` for the vhost, or
  `mod_rewrite` is off, so `.htaccess` is ignored.
- **Clients stuck on an old build** — check `Cache-Control` on `/sw.js` and
  `/index.html`; both must be `no-cache`, which requires `mod_headers`.
