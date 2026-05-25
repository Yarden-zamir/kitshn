# Deploy Flow
One deploy operation:

1. Acquire exclusive `flock` on `/deployments/<owner>/<repo>/<environment>/.lock`.
2. Ensure deployment root, params root, persistent root, logs root, and log symlink exist.
3. Fetch from the GitHub remote and check out the requested branch, tag, or SHA in `/deployments/<owner>/<repo>/<environment>`.
4. Use git in the checkout to determine current and target refs.
5. Clear and rewrite `/params/<owner>/<repo>/<environment>/params.env` from GitHub Environment params.
6. Pull external images and build local images with Compose using `--env-file`.
7. Run Compose with `--env-file` when the recipe has Compose.
8. Roll logs under `KITSHN_LOG_DIR` for each service that will be recreated: rename existing log files in the service's log subdirectory to `<name>.<timestamp>` before the service restarts.
9. Recreate changed services in this recipe.
10. Recreate services in other deployments whose `kitshn.depends_on` label includes this recipe, rolling their logs first.
11. Wait for health checks when they exist.
12. Regenerate deployment Caddyfile from recipe `Caddyfile`.
13. Validate and reload Caddy once if generated Caddyfiles changed.

Compose is fail-forward. Caddy keeps the previous generated Caddyfile when validation fails.

`deploy` requires a GitHub token in the environment to read Environment params.

CI uses GitHub Actions concurrency groups per `<owner>/<repo>/<environment>`.
