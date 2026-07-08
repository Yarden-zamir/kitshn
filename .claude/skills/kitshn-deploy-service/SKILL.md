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
- For manual Compose debugging on the VPS, use `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn compose <owner/repo> --environment <env> -- ...`, not raw `docker compose`.

## Caveats
- Do not print or transfer secret values unless explicitly approved.
- Local users may install `kitshn` or use `uvx`; remote CI/VPS commands always use hosted `uvx`, not a persistent VPS install.
- `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are infrastructure keys and are not forwarded to apps.
- Private repos require `gh auth login` on the VPS deployment user.
- Host Caddy cannot resolve Compose service DNS; use Unix sockets or a socket-proxy sidecar, not host ports.
- Socket proxies should normally use only the project-local default Compose network. Put app services on shared networks only for intentional cross-recipe traffic.
- PR preview Caddy templates must use unique hostnames per environment; ambiguous site errors usually mean prod and PR rendered the same hostname.
- Singleton stateful services should usually keep only `main -> prod`; PR previews require safe isolated state and DNS.
