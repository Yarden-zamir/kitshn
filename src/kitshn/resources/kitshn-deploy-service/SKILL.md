---
name: kitshn-deploy-service
description: Prepare or debug a service repo deployed with KitSHn.
license: MIT
---

# kitshn-deploy-service

KitSHn is a VPS deployment system, not an application. It deploys *other* repos ("recipes")
onto a VPS: GitHub Actions SSHes in and runs `kitshn deploy owner/repo`. Use when adding
KitSHn files to a service repo or debugging a KitSHn deployment.

Run `kitshn <command> --help` for flags and arguments. This file covers only what `--help`
does not say.

## Invoking The CLI
- Locally: an installed `kitshn`, or `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...`.
- On CI and the VPS: always the hosted `uvx --from git+...` form. Never install a persistent VPS binary.
- Never bare `uvx kitshn`. It resolves an unrelated old PyPI package.

## Before You Start
Establish: the GitHub repo, the VPS SSH target, whether the service is public HTTP or a
worker, its runtime params and which are secret, its public hostname and whether preview DNS
exists, persistence needs, and dependencies on other recipes.

## Set Up A Recipe
1. Fresh VPS only: `kitshn bootstrap-remote <vps> --install-missing --installer <name>`.
2. In the service repo: `kitshn init --docker`, adding `--routing` only for public HTTP.
3. `kitshn recipe auth --vps-host <vps>` — **before** the first deploy-triggering push, or
   Actions fails until `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` exist.
4. Fill in `compose.yml`. Set params as GitHub `KITSHN_<NAME>` vars/secrets; the container
   receives `<NAME>`.
5. Commit only the deployment files, push, watch Actions, then `kitshn diagnose` on the VPS.

## Public HTTP Ingress
Host Caddy cannot resolve Compose service DNS, so routing goes through a Unix socket, never a
host port.

- App can bind a socket: listen on `${KITSHN_DEFAULT_SOCKET}`.
- App is TCP-only: add an `alpine/socat` sidecar forwarding `${KITSHN_DEFAULT_SOCKET}` to the app port.
- Caddy: `reverse_proxy unix//{{ paths.default_socket }}`.
- Keep the socket proxy on the project-local default network. Extra networks make Docker DNS
  resolve `app` to another deployment's container, producing 502s with everything "healthy".
- PR previews need per-environment hostnames. `ambiguous site definition` means prod and the
  preview rendered the same hostname; fix the template, do not disable previews.

## Debug On The VPS
Prefer these over raw `docker` and `docker compose`, which miss the project name and params
file. All take `--environment`, defaulting to `prod`.

- `kitshn diagnose <owner/repo>` — start here; checks Compose, sockets, Caddy routing and config.
- `kitshn status <owner/repo>` — ref, services, health, route, socket, last deploy, as JSON.
- `kitshn logs <owner/repo> [service]` — Docker logs. Bare `kitshn logs` shows KitSHn's own log.
- `kitshn compose <owner/repo> -- <args>` — Compose with the deployment's exact context.
- `kitshn params list <owner/repo>` — param names, no values.
- `kitshn params get <owner/repo> <KEY> --show` — one value, correctly decoded.

## Iterate Without Deploying Prod
- Any recipe accepts a manual deploy to any environment name via the workflow's
  `workflow_dispatch` input, even one that only maps `main -> prod`. Use it instead of testing on prod.
- That reuses `Caddyfile.j2`. Make hostnames environment-aware first, or Caddy rejects the deploy.
- To exercise code against shared services without deploying, run a throwaway container on the
  shared network: `docker run --rm --network kitshn-edge <image>`.

## Caveats
- Do not print or transfer secret values unless explicitly approved.
- `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are infrastructure keys, never forwarded to apps.
- Deployed services publish no host ports; `127.0.0.1:<port>` will not reach them. Use the
  public route, `kitshn compose ... -- exec`, or `kitshn-edge`.
- Never hand-parse `params.env`. Values are quoted and escaped for Compose, so `grep`/`cut`
  returns the quote characters and causes confusing auth failures. Use `kitshn params get`.
- Private repos require `gh auth login` as the VPS deployment user.
- Singleton stateful services should usually keep only `main -> prod`; previews need isolated
  state and DNS.
