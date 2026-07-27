# Deploying to Virtualmin (vv.picone.it)

`.github/workflows/deploy-virtualmin.yml` builds the PWA on GitHub Actions and
ships the static `dist/` to the Virtualmin virtual host over SSH. The server
runs no build step and needs no toolchain — it only receives files.

Flow on every push to `main` (and on manual dispatch):

1. `pnpm install && pnpm gen:icons && pnpm build` → `dist/`
2. `rsync` `dist/` → `~/deploy-staging/pwa/` on the server (incremental, over SSH)
3. server-side `rsync` staging → document root (local disk-to-disk, near-atomic)
4. `curl` smoke check against `https://vv.picone.it/`

Step 3 exists so the document root is never left half-updated for the duration
of an upload: the only inconsistent window is a local copy of a few hundred KB.

## Server setup (once)

1. **Virtual server.** Create `vv.picone.it` in Virtualmin (own domain or
   sub-server) with SSL enabled. Note the document root — usually
   `/home/<user>/public_html`, or
   `/home/<parent>/domains/vv.picone.it/public_html` for a sub-server.

2. **Shell access.** The domain's Unix user needs a real shell: in Virtualmin,
   *Edit Users → the domain owner → Shell = `/bin/bash`* (not `/bin/false`). If
   the account is jailed (Jailkit), make sure `rsync` is available inside the
   jail — Virtualmin's *System Settings → Jailkit* command list.

3. **Deploy key.** Generate a dedicated keypair (locally, not on the server):

   ```sh
   ssh-keygen -t ed25519 -f pwa-deploy -C 'github-actions pwa deploy' -N ''
   ```

   Append the public key to the domain user's `~/.ssh/authorized_keys`, with
   the capabilities the deploy does not need switched off:

   ```
   no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions pwa deploy
   ```

   ```sh
   chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
   ```

4. **Apache.** Nothing to configure by hand: `public/.htaccess` is copied into
   the build and deployed with it (SPA fallback, cache headers). It requires
   `AllowOverride All` on the document root — Virtualmin's default for a
   virtual server. `mod_rewrite` and `mod_headers` must be enabled.

## GitHub configuration (once)

Repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Example | Notes |
| --- | --- | --- |
| `VIRTUALMIN_HOST` | `vv.picone.it` | SSH host |
| `VIRTUALMIN_USER` | `vv` | the domain's Unix user |
| `VIRTUALMIN_DOC_ROOT` | `/home/vv/public_html` | absolute path |
| `VIRTUALMIN_PORT` | `22` | optional, defaults to `22` |
| `VIRTUALMIN_STAGING_DIR` | `deploy-staging/pwa` | optional, relative to `$HOME` |

Repository **secrets**:

| Secret | How to get it |
| --- | --- |
| `VIRTUALMIN_SSH_KEY` | contents of the private `pwa-deploy` file |
| `VIRTUALMIN_KNOWN_HOSTS` | `ssh-keyscan -p 22 vv.picone.it` |
| `PACKAGES_READ_TOKEN` | PAT with `read:packages`, see below |

`VIRTUALMIN_KNOWN_HOSTS` pins the server's host key; the workflow deliberately
does not use `StrictHostKeyChecking=no`. Re-run `ssh-keyscan` and update the
secret if the server is ever rebuilt.

### Why `PACKAGES_READ_TOKEN`

`@xbrowsersync/core` is a private package published under the **xbrowsersync**
org, while this repo now lives under **MarkSyncOrg**. A workflow's built-in
`GITHUB_TOKEN` is scoped to its own repository, so it can no longer read that
package across orgs — `pnpm install` fails with 401/403 without a PAT.

Two ways out:

- **PAT (what the workflow assumes):** a classic PAT with `read:packages` from
  an account that can read the package, stored as `PACKAGES_READ_TOKEN`. The
  workflow falls back to `GITHUB_TOKEN` when the secret is absent, so it keeps
  working if the package is ever moved or made public.
- **Move the package to MarkSyncOrg** (publish `@marksync/core`, or transfer
  the `core` repo) and grant this repo read access under the package's
  *Manage Actions access*. Then `GITHUB_TOKEN` is enough and the PAT — which
  needs manual rotation — can be dropped.

## Deploy environment

The job runs in the `virtualmin` GitHub environment, so deploys show up in the
repo's Deployments view. Add required reviewers there (Settings →
Environments → virtualmin) if pushes to `main` should not publish unattended.

## Troubleshooting

- **`Permission denied (publickey)`** — the key is not in `authorized_keys`, or
  `~/.ssh` permissions are wrong (`700` / `600`), or the user's shell is
  `/bin/false`.
- **`Host key verification failed`** — `VIRTUALMIN_KNOWN_HOSTS` is stale; re-run
  `ssh-keyscan`.
- **`rsync: command not found`** — install `rsync` on the server, or add it to
  the Jailkit command list if the account is jailed.
- **Deep links 404** — `AllowOverride` is not `All` for the vhost, or
  `mod_rewrite` is off, so `.htaccess` is ignored.
- **Clients stuck on an old build** — check `Cache-Control` on `/sw.js` and
  `/index.html`; both must be `no-cache`, which requires `mod_headers`.
