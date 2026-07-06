# Deploy Flow
One deploy operation:

1. Ensure deployment root, params root, persistent root, logs root, and log symlink exist.
2. Fetch from the GitHub remote and check out the requested branch, tag, or SHA in `/deployments/<owner>/<repo>/<environment>`.
3. Use git in the checkout to determine current and target refs.
4. Copy `--params-file` atomically into `/params/<owner>/<repo>/<environment>/params.env` with mode `600`.
5. Clear and recreate `/deployments/<owner>/<repo>/<environment>/.kitshn/sockets` for runtime Unix socket leftovers.
6. Pull external images and build local images with Compose using `--env-file`.
7. Run Compose with `--env-file` when the recipe has Compose. Recipe services are applied with `docker compose up -d --remove-orphans --force-recreate` so services that bind Unix sockets are recreated after socket cleanup.
8. Roll logs under `KITSHN_LOG_DIR` for each service that will be recreated: rename existing log files in the service's log subdirectory to `<name>.<timestamp>` before the service restarts.
9. Recreate all services in this recipe.
10. Recreate services in other deployments whose `kitshn.depends_on` label includes this recipe, rolling their logs first.
11. Wait for health checks when they exist.
12. Regenerate deployment `Caddyfile` from recipe `Caddyfile.j2`.
13. Validate and reload Caddy once if generated Caddyfiles changed.

Compose is fail-forward. Caddy keeps the previous generated Caddyfile when validation fails.

`deploy` reads params from `--params-file`. CI builds this file from `KITSHN_*` vars/secrets and pushes it over SSH. The VPS does not call the GitHub API.

`destroy` of an ephemeral env deletes the GitHub Environment after teardown (handled by the CI workflow, not the CLI).

CI uses GitHub Actions concurrency groups per `<owner>/<repo>/<environment>`.
