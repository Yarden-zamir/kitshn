# Deploy Flow
One deploy operation. The whole operation runs under the host deploy lock, see below.

1. Ensure deployment root, params root, persistent root, logs root, and log symlink exist.
2. Fetch from the GitHub remote and check out the requested branch, tag, or SHA in `/deployments/<owner>/<repo>/<environment>`. When `gh` is installed, the fetch passes `gh auth git-credential` as the credential helper for `github.com` with `git -c`, as `gh` does for its own git commands. KitSHn does not write `~/.gitconfig`.
3. Use git in the checkout to determine current and target refs.
4. Copy `--params-file` atomically into `/params/<owner>/<repo>/<environment>/params.env` with mode `600`.
5. Clear and recreate `/deployments/<owner>/<repo>/<environment>/.kitshn/sockets` for runtime Unix socket leftovers. This runs after step 6 succeeds and just before step 7, so a failed pull or build keeps the running containers and their socket serving.
6. Pull external images and build local images with Compose using `--env-file`.
7. Run Compose with `--env-file` when the recipe has Compose. Recipe services are applied with `docker compose up -d --remove-orphans --force-recreate` so services that bind Unix sockets are recreated after socket cleanup.
8. Roll logs under `KITSHN_LOG_DIR` for each service that will be recreated: rename existing log files in the service's log subdirectory to `<name>.<timestamp>` before the service restarts.
9. Recreate all services in this recipe.
10. Recreate services in other deployments whose `kitshn.depends_on` label includes this recipe, rolling their logs first.
11. Wait for health checks when they exist.
12. Regenerate deployment `Caddyfile` from recipe `Caddyfile.j2`.
13. Validate and reload Caddy once if generated Caddyfiles changed. Validation runs as the Caddy service user; see [Caddy Ingress](caddy.md).

Compose is fail-forward. Caddy keeps the previous generated Caddyfile when validation fails.

The previous generated `Caddyfile` stays in place until step 12 replaces it. A deploy that fails at any earlier step keeps its route. This matters because every Caddy reload, by any recipe, rebuilds `/deployments/Caddyfile` from the generated Caddyfiles that exist.

After step 2, `deploy` prints a GitHub `::warning` line when the checkout has a `.env` file, which Compose does not read, or when the default socket path is longer than the Unix socket limit of 107 bytes.

Host deploy lock:

- `deploy` and `destroy` hold an exclusive `flock` on `/deployments/.kitshn-deploy.lock` for their whole run.
- Deploys of different recipes share the Caddy manifest and the Caddy reload. A first deploy or a destroy changes the list of routes; a concurrent deploy that writes the manifest last would drop that route. A deploy also recreates dependent services in other deployments, which can be deploying at the same moment. The lock prevents these races.
- A deploy that waits prints the holder on stderr every 20 seconds. When the GitHub job is cancelled, that print fails on the closed SSH pipe, so the abandoned waiter exits before it takes the lock. It fails after 30 minutes with the holder in the message.
- The lock file holds the current holder's deployment identity and process ID. It is normally empty when free; a killed holder leaves stale text, which the next holder overwrites.
- A lock file that the deploy user cannot open, for example one created by `sudo`, fails the deploy with the file owner in the message.
- `--dry-run` does not take the lock.

After `deploy` returns, the reusable workflow verifies the result from the GitHub runner: it requests the public URL inferred from `Caddyfile.j2` until it answers 2xx, writes the URL, status, and content type to the job summary, and attaches them to the GitHub deployment. A recipe without one concrete hostname skips the check. From the laptop, `kitshn track` performs the same verification plus a `kitshn status` check on the VPS; see [CLI](cli.md).

`deploy` reads params from `--params-file`. CI builds this file from `KITSHN_*` vars/secrets and pushes it over SSH. The VPS does not call the GitHub API.

`destroy` of an ephemeral env deletes the GitHub Environment after teardown (handled by the CI workflow, not the CLI).

CI uses GitHub Actions concurrency groups per `<owner>/<repo>/<environment>` on the `deploy` and `teardown` jobs, with `cancel-in-progress: false`. GitHub keeps only the newest pending job per group, so pushes to one deployment apply in order. The host deploy lock serializes deploys across recipes on one VPS; it does not order them.
