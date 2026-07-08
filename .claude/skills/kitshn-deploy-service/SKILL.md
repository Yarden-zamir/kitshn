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
- Verify local tools: `kitshn --help` or `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --help`, plus `gh auth status` and `ssh <vps> true`.
- Initialize from the service repo: `kitshn init --docker` plus `--routing` only for public HTTP.
- For public HTTP, use Unix socket ingress: app listens on `${KITSHN_DEFAULT_SOCKET}`, or a `socat` sidecar forwards from `${KITSHN_DEFAULT_SOCKET}` to the app TCP port; Caddy uses `reverse_proxy unix//{{ paths.default_socket }}`.
- Authorize deploys: `kitshn recipe auth --vps-host <vps>`.
- Set params as GitHub `KITSHN_<NAME>` vars/secrets; runtime receives `<NAME>`.
- Commit only generated/edited deployment files, push, watch Actions, then run hosted `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn diagnose <owner/repo> --environment <env>` on the VPS.

## Caveats
- Do not print or transfer secret values unless explicitly approved.
- Local users may install `kitshn` or use `uvx`; remote CI/VPS commands always use hosted `uvx`, not a persistent VPS install.
- `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are infrastructure keys and are not forwarded to apps.
- Private repos require `gh auth login` on the VPS deployment user.
- Host Caddy cannot resolve Compose service DNS; use Unix sockets or a socket-proxy sidecar, not host ports.
- Singleton stateful services should usually keep only `main -> prod`; PR previews require safe isolated state and DNS.
