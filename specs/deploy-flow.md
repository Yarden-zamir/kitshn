# Deploy Flow
One deploy operation:

1. Ensure deployment root, params root, persistent root, logs root, and log symlink exist.
2. Fetch from the GitHub remote and check out the requested branch, tag, or SHA in `/deployments/<owner>/<repo>/<environment>`.
3. Use git in the checkout to determine current and target refs.
4. Clear and rewrite `/params/<owner>/<repo>/<environment>/params.env` from GitHub Environment params.
5. Pull external images and build local images with Compose using `KITSHN_PARAMS_FILE`.
6. Run Compose with `KITSHN_PARAMS_FILE` when the recipe has Compose.
7. Recreate changed services and services affected by `kitshn.depends_on`.
8. Wait for health checks when they exist.
9. Regenerate deployment Caddyfile from recipe `Caddyfile` or `Caddyfile.j2`.
10. Validate and reload Caddy once if generated Caddyfiles changed.

CI uses GitHub Actions concurrency groups per `<owner>/<repo>/<environment>` so two deploys for the same deployment do not run at the same time.
