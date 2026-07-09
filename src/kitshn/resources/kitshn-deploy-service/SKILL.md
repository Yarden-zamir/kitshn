---
name: kitshn-deploy-service
description: Prepare or debug a service repo deployed with KitSHn.
license: MIT
---

# kitshn-deploy-service

Use when adding KitSHn deployment files to a service repo or fixing a KitSHn deployment.

## Required Inputs
- GitHub repo name or local repo with an `origin` remote.
- VPS SSH target, for example `deploy@example.com`.
- Whether the service is public HTTP, worker/bot, or internal-only.
- Required runtime params and which are secrets.
- Public hostnames and whether PR preview DNS exists.
- Persistence needs and any upstream/downstream recipe dependencies.

## Steps
- Verify local tools: `kitshn --help` or `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --help`, plus `gh auth status` and `ssh <vps> true`. Do not use bare `uvx kitshn`.
- For a fresh VPS, run `kitshn bootstrap-remote <vps> --install-missing --installer <installer>`; it installs/verifies remote `uv` and runs hosted KitSHn through `uvx`.
- Initialize from the service repo: `kitshn init --docker` plus `--routing` only for public HTTP.
- For public HTTP, use Unix socket ingress: app listens on `${KITSHN_DEFAULT_SOCKET}`, or a `socat` sidecar forwards from `${KITSHN_DEFAULT_SOCKET}` to the app TCP port; Caddy uses `reverse_proxy unix//{{ paths.default_socket }}`.
- Authorize deploys: `kitshn recipe auth --vps-host <vps>`.
- Do recipe auth before the first deploy-triggering push, otherwise Actions will fail until `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` exist.
- Set params as GitHub `KITSHN_<NAME>` vars/secrets; runtime receives `<NAME>`.
- Commit only generated/edited deployment files, push, watch Actions, then run hosted `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn diagnose <owner/repo> --environment <env>` on the VPS.

## Verify And Debug On The VPS
Prefer these over raw `docker` and `docker compose`. All take `--environment <env>`, defaulting to `prod`.

- `kitshn diagnose <owner/repo>` — health of Compose, sockets, generated Caddyfile, and Caddy config. Start here.
- `kitshn status [owner/repo]` — JSON: checkout ref, services, health, Caddy route, socket path, last deploy.
- `kitshn logs <owner/repo> [service]` — Docker logs for the deployment. `--follow` to tail, `--files` for file logs. Bare `kitshn logs` shows KitSHn's own log.
- `kitshn compose <owner/repo> -- <args>` — Docker Compose with KitSHn's exact project name, env file, and cwd.
- `kitshn params list <owner/repo>` — param names and whether each is set, without printing values.
- `kitshn params get <owner/repo> <KEY> --show` — one param value, correctly unquoted.

## Iterate Without Deploying Prod
- Recipes whose only entry is `main -> prod` still accept a manual deploy to any environment name via the `workflow_dispatch` input. Use it for a staging environment instead of testing on prod.
- A dispatched non-prod environment reuses the recipe's `Caddyfile.j2`. If that template hardcodes the prod hostname, Caddy fails with `ambiguous site definition`. Make the hostname environment-aware first.
- To exercise code against shared services without any deploy, run a throwaway container on the shared network: `docker run --rm --network kitshn-edge <image>`.

## Caveats
- Do not print or transfer secret values unless explicitly approved.
- Local users may install `kitshn` or use `uvx`; remote CI/VPS commands always use hosted `uvx`, not a persistent VPS install.
- `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are infrastructure keys and are not forwarded to apps.
- Deployed services publish no host ports. `127.0.0.1:<port>` will not reach them. Go through the public Caddy route, `kitshn compose ... -- exec`, or the shared `kitshn-edge` network.
- Read params with `kitshn params get`, not by hand. Values in `params.env` are quoted and escaped for Compose; a naive `cut`/`grep` yields the surrounding quotes and produces confusing auth failures.
- Private repos require `gh auth login` on the VPS deployment user.
- Host Caddy cannot resolve Compose service DNS; use Unix sockets or a socket-proxy sidecar, not host ports.
- Socket proxies should normally use only the project-local default Compose network. Put app services on shared networks only for intentional cross-recipe traffic.
- PR preview Caddy templates must use unique hostnames per environment; ambiguous site errors usually mean prod and PR rendered the same hostname.
- Singleton stateful services should usually keep only `main -> prod`; PR previews require safe isolated state and DNS.
