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

## Step 0: Check The Installed CLI
Run `kitshn self-check` before anything else. It compares `kitshn --version` with the latest
GitHub release and exits non-zero with the upgrade command when the CLI is old. Docs and this
skill describe the latest release; an old CLI silently lacks commands such as `try` and `track`.
Upgrade with `brew upgrade kitshn`, `uv tool upgrade kitshn`, or
`uvx --refresh --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --version`.

## Invoking The CLI
- Type `kitshn` only on the laptop. VPS-only commands (`diagnose`, `status`, `logs`, `compose`,
  `params`) take `--vps-host <ssh-target>` and run there through a login shell.
- Do not hand-roll `ssh host 'uvx ...'`: `uvx` lives in `~/.local/bin`, which a non-login SSH
  shell does not have on PATH. `--vps-host` handles that.
- On CI and the VPS the hosted `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn`
  form runs; never install a persistent VPS binary. Never bare `uvx kitshn`: it resolves an
  unrelated old PyPI package.

## Before You Start
Establish: the GitHub repo, the VPS SSH target, whether the service is public HTTP or a
worker, its runtime params and which are secret, its public hostname and whether preview DNS
exists, persistence needs, and dependencies on other recipes.

## Set Up A Recipe, In This Order
1. Fresh VPS only: `kitshn bootstrap-remote <vps> --install-missing --installer <name>`.
2. In the service repo: `kitshn init --template static --hostname <host>` for a static site
   (complete recipe: Caddy container on the socket, `compose.yml`, `Caddyfile.j2`,
   `Dockerfile`, `.dockerignore`). Anything else: `kitshn init --docker`, plus `--routing`
   only for public HTTP. `init` prints this checklist.
3. Create the GitHub repo **without pushing**: `gh repo create <owner/repo> --private --source . --remote origin`.
   `--push` starts a workflow that fails in "Check deploy credentials".
4. `kitshn recipe auth --vps-host <vps>`. It reads the repo from the git remote through `gh`,
   so worktree layouts are fine. It must precede the first push.
5. Optional but cheap: `kitshn try`, or `kitshn try --vps-host <vps>` when Docker is not
   running locally or is Docker Desktop (its bind mounts cannot carry Unix sockets; `try`
   says so and refuses). It builds and runs `compose.yml` in a throwaway directory with the socket
   in a temp dir, curls the socket, prints the last logs on failure, and cleans up. It never
   touches routing or deployments. On the VPS it uses the production host's Docker and disk.
6. Commit the deployment files, push, then `kitshn track`. See "After Every Push".

## After Every Push
- Run `kitshn track --expect <text>` from the recipe repo. It follows the Actions run for
  HEAD, checks `kitshn status` on the VPS for the new ref and healthy services, then requests
  the public URL from `Caddyfile.j2`. Every step has a `--*-timeout` flag.
- Do not poll the public URL for a string. The old page can contain it too, and `track`
  already checks the deployed ref.
- Pushing several recipes at once is safe. Deploys on one VPS wait for a host-wide lock.
- The workflow summary of each run prints the `kitshn track` command for that run.

## README Badge
- `kitshn.md` has the badge lines. The static badge needs nothing. The live badge is the shields
  GitHub Deployments badge with the KitSHn pot. It works for public repos only.

## Public HTTP Ingress
Host Caddy cannot resolve Compose service DNS, so routing goes through a Unix socket, never a
host port. Caddy on the host: `reverse_proxy unix//{{ paths.default_socket }}`.

- App can bind a socket: listen on `${KITSHN_DEFAULT_SOCKET}`. No sidecar. The socket must be
  mode `0666`: the host Caddy runs as `caddy`, and the container's socket is owned by root.
  uvicorn `--uds`, socat `mode=666`, and Caddy `bind ...|0666` do this. `diagnose` checks it.
- A `log { output file ... }` block in `Caddyfile.j2` works: KitSHn validates as the `caddy`
  user, so the log file gets the right owner. The log directory must be writable by `caddy`.
- Static files: Caddy in the container binds the socket itself with
  `bind unix/{$KITSHN_DEFAULT_SOCKET}|0666` and removes a stale socket file left by the
  previous container on start. This is tested; do not research it or add socat.
- Caddy `encode` compresses only its default MIME types, and `header` runs before `encode`
  sees the type. A custom `Content-Type` set with `header` needs an explicit `encode ... {
  match { header Content-Type ... } }` block. The static template ships one.
- TCP-only image: add an `alpine/socat` sidecar forwarding `${KITSHN_DEFAULT_SOCKET}` to the
  app port. Keep it on the project-local default network; extra networks make Docker DNS
  resolve `app` to another deployment's container, producing 502s with everything "healthy".
- PR previews need per-environment hostnames. `ambiguous site definition` means prod and the
  preview rendered the same hostname; fix the template, do not disable previews.
- `track` and the workflow infer the public URL from `Caddyfile.j2` only when it renders one
  concrete hostname for the environment. Wildcards or several hosts mean no URL check.

## Params And Config
- Put each runtime value in a GitHub variable or secret named `KITSHN_<NAME>`, in the GitHub
  Environment of the deployment. `ci-write-params` writes it to `params.env` as `<NAME>`.
- KitSHn runs every Compose command with `--env-file <params.env>`. Compose then does not read
  a `.env` file in the repo. Do not put values or `COMPOSE_PROFILES` in a repo `.env`.
- A container gets a param only when `compose.yml` maps it: `TOKEN: ${TOKEN:?TOKEN is required}`.
- A value that is not secret and belongs to the repo can go in `compose.yml`, or in
  `compose.override.yml`, which Compose loads beside `compose.yml`. A build step can write it.
- Set a secret with `gh secret set KITSHN_<NAME> --env prod --repo <owner/repo> < file`, a
  variable with `gh variable set ... --body <value>`. Always pipe secrets from a file: the
  prompt reads one line, and the shell runs the other lines of a pasted key.
- Check the prefix twice. `gh` accepts any name, and KitSHn forwards only `KITSHN_*`.
- Without `--env`, the value is repo-wide and pull request previews see it.
- `--env prod` fails until the first deploy creates the Environment. To set params before
  that, run `gh api --method PUT repos/<owner/repo>/environments/prod` first.
- A new value applies on the next deploy. Then check the names with
  `kitshn params list <owner/repo> --vps-host <vps>`.
- A deploy warns when the repo has a `.env`. Treat that warning as a bug.

## Debug From The Laptop
Prefer these over raw `docker` and `docker compose`, which miss the project name and params
file. All take `--environment` (default `prod`) and `--vps-host <vps>`.

- `kitshn diagnose <owner/repo>`: start here; checks Compose, sockets, Caddy routing and config.
- `kitshn status <owner/repo>`: ref, services, health, route, socket, last deploy, as JSON.
- `kitshn logs <owner/repo> [service]`: Docker logs. Bare `kitshn logs` shows KitSHn's own log.
- `kitshn compose <owner/repo> -- <args>`: Compose with the deployment's exact context. To send
  input to a service from inside the network, use `-- exec -T <service> <command>` with stdin
  piped, not `docker exec`.
- `kitshn params list <owner/repo>`, `kitshn params get <owner/repo> <KEY> --show`.
- A failed workflow run: `gh run view <id> --log-failed`; `track` prints it for you.

## Iterate Without Deploying Prod
- `kitshn try` for build and serve problems; it needs no push and no VPS state.
- Any recipe accepts a manual deploy to any environment name via the workflow's
  `workflow_dispatch` input, even one that only maps `main -> prod`. That reuses
  `Caddyfile.j2`, so make hostnames environment-aware first.
- To exercise code against shared services without deploying, run a throwaway container on the
  shared network: `docker run --rm --network kitshn-edge <image>`.

## Caveats
- Do not print or transfer secret values unless explicitly approved.
- `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are infrastructure keys, never forwarded to apps.
  The workflow fails early with the `recipe auth` command when they are missing.
- Deployed services publish no host ports; `127.0.0.1:<port>` will not reach them. Use the
  public route, `kitshn compose ... -- exec`, or `kitshn-edge`.
- Never hand-parse `params.env`. Values are quoted and escaped for Compose. Use `kitshn params get`.
- `kitshn.md` ends with an Origin section naming the KitSHn commit that generated it. Rewrite
  the prose, keep that section.
- Private repos require `gh auth login` as the VPS deployment user.
- Singleton stateful services should usually keep only `main -> prod`; previews need isolated
  state and DNS.
