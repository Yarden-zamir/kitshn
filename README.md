# KitSHn

KitSHn deploys GitHub repos onto a VPS you own. Push to `main`, and GitHub Actions SSHes into
your server and brings the new version up. Open a pull request, and you get a preview
deployment at its own URL. Close it, and the preview disappears.

```text
git push -> GitHub Actions -> ssh vps -> kitshn deploy owner/repo
```

It is built for small, self-hosted services: a website, a bot, an API, an internal tool. One
VPS, several services, no Kubernetes, no container registry, no control plane.

## What You Get

- **Deploys driven by git.** Branches and pull requests map to environments in one config file.
- **PR preview deployments.** Every pull request gets an isolated environment and hostname.
- **HTTPS with no port juggling.** Caddy terminates TLS and reaches each service over a Unix
  socket, so services never publish host ports and never collide.
- **Secrets from GitHub.** Repository secrets become environment variables in your containers.
- **Deployments as plain files.** Everything lives under predictable paths on the VPS, and
  Docker Compose remains the runtime source of truth.

## What It Is Not

Not a PaaS. There is no web dashboard, no multi-tenancy, and no autoscaling. It assumes you
have SSH access to one Linux box and that Docker Compose is a reasonable way to run your
service.

## Install

On your own machine, install the CLI:

```bash
brew install yarden-zamir/tap/kitshn
```

Or run it without installing:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --help
```

Always use the full `uvx --from git+...` form. Bare `uvx kitshn` resolves an unrelated, old
PyPI package.

Check that the installed CLI is current before you rely on this README:

```bash
kitshn self-check
```

It compares the installed version with the latest GitHub release and prints the upgrade
command (`brew upgrade kitshn` or `uv tool upgrade kitshn`). Every merge to `main` that bumps
the version in `pyproject.toml` publishes a release and updates the Homebrew tap; see
[Release](specs/release.md).

Your VPS is different: GitHub Actions runs KitSHn there through `uvx` on every deploy. Do not
install a persistent `kitshn` binary on the server. Bootstrap only needs to make `uv`, Docker,
Caddy, Git, and `gh` available. You never type `kitshn` on the VPS either: the commands that
read VPS state take `--vps-host <ssh-target>` and run there for you.

## Set Up A VPS

Once per server. From your machine, against a fresh host:

```bash
kitshn bootstrap-remote deploy@example.com --install-missing --installer ubuntu
```

That installs `uv` on the remote host, then runs the hosted KitSHn bootstrap through it. Run
`kitshn installers` to see the available installer modules.

If you are already on the VPS, the local equivalent is:

```bash
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

Bootstrap creates the deployment roots, installs and configures Caddy, creates the shared
`kitshn-edge` Docker network, and wires up Caddy imports. `kitshn doctor` re-checks all of it
without changing anything.

Private repos also need `gh auth login` as the VPS deployment user, so the server can clone
them.

## Deploy A Service

From inside the service repo, in this order:

```bash
kitshn init --docker --routing
gh repo create owner/repo --private --source . --remote origin   # if the repo is new; no --push
kitshn recipe auth --vps-host deploy@example.com
kitshn try                                                       # optional, see below
git add -A && git commit -m "feat: deploy with kitshn" && git push
kitshn track
```

`init` prints this checklist. It writes `.kitshn.yaml`, a GitHub Actions workflow,
`kitshn.md`, and commented `compose.yml` and `Caddyfile.j2` examples. Use `--routing` only if
the service serves public HTTP. `kitshn.md` ends with an Origin section naming the KitSHn
commit that generated it; rewrite the prose, keep that section.

For a static site, `kitshn init --template static --hostname example.com` writes a complete
recipe instead: a `caddy:2-alpine` container that serves `site/` and binds the KitSHn socket
directly, plus `compose.yml`, `Caddyfile.j2`, `Dockerfile`, and `.dockerignore`.

`recipe auth` generates an SSH key for this repo, authorizes it on the VPS, and stores it as
the `KITSHN_SSH_KEY` secret with `KITSHN_VPS_HOST` as a variable. It reads the repo name from
the git remote through `gh`. **Run it before the first push that should deploy.** A push
before it starts a workflow that fails in its first step, naming the command to run; rerun the
workflow after auth is configured. Creating the repo with `gh repo create --push` is the usual
way to hit that.

Then fill in `compose.yml`, commit, and push. The default `.kitshn.yaml` deploys `main` to
`prod` and each pull request to `pr-<number>`.

### Try Before Pushing

```bash
kitshn try
kitshn try --vps-host deploy@example.com
```

`try` builds and runs the recipe's `compose.yml` in a throwaway directory with the socket in
a temp dir, waits for healthchecks, curls the socket, prints the last logs on failure, and
cleans up. It never touches routing or deployments. With `--vps-host` it copies the recipe to
`/tmp` on the VPS and runs the same flow there, which is the answer when Docker is not running
locally or is Docker Desktop, whose bind mounts cannot carry Unix sockets. That uses the production host's Docker, disk, and image cache; the command says what
it removes afterwards. Pass `--keep` to leave the containers running and get the curl and
cleanup commands.

### Follow A Deploy

```bash
kitshn track
```

`track` waits for the GitHub Actions run for `HEAD`, prints job transitions, checks
`kitshn status` on the VPS for the new ref and healthy services, then requests the public URL
inferred from `Caddyfile.j2` and reports status and content type. `--expect <text>` also
checks the body. Every step has a `--*-timeout` flag. The workflow performs the same public
route check after each deploy and writes status, content type, and URL into the job summary
and the GitHub deployment.

### Public HTTP Services

Caddy runs on the host and cannot resolve Docker service names, so KitSHn routes to a Unix
socket instead of a host port. In `Caddyfile.j2`:

```caddyfile
example.com {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

If your app can listen on a Unix socket, point it at `${KITSHN_DEFAULT_SOCKET}`; no sidecar is
needed. Caddy inside a container binds the socket with `bind unix/{$KITSHN_DEFAULT_SOCKET}|0666`
and removes a stale socket file from a previous container on start, which is what
`--template static` uses. Only if the image cannot bind a Unix socket at all, add an
`alpine/socat` sidecar that forwards the socket to the app's internal port.
`kitshn init --docker` includes a worked example of both.

For PR previews, make the hostname environment-aware, or Caddy will reject two site blocks
claiming the same domain:

```caddyfile
{% if environment == "prod" -%}
example.com
{%- else -%}
pr.{{ environment.removeprefix("pr-") }}.example.com
{%- endif %} {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

Preview hostnames need DNS, usually a wildcard `*.example.com` record pointing at the VPS.

### Secrets And Config

Create GitHub variables and secrets named `KITSHN_<NAME>`. The container receives `<NAME>`,
without the prefix. `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved for KitSHn itself and
are never passed to your app.

## Operate

Run these from your machine with `--vps-host`; they run on the VPS through a login shell.
Each takes `--environment`, defaulting to `prod`. Pass `--help` to any of them for flags.

```bash
kitshn diagnose owner/repo --vps-host deploy@example.com   # is it healthy, and if not, why
kitshn status owner/repo --vps-host deploy@example.com     # ref, services, health, route, socket, last deploy
kitshn logs owner/repo [service] --vps-host deploy@example.com
kitshn compose owner/repo --vps-host deploy@example.com -- ps
kitshn params list owner/repo --vps-host deploy@example.com
```

Prefer these over raw `docker` and `docker compose`, which do not know the deployment's
project name or params file and will mislead you. Start with `diagnose`.

To read a secret's real value, use `kitshn params get owner/repo TOKEN --show`. Values are
stored quoted and escaped for Compose, so `grep` and `cut` return the quote characters too.

Deployed services publish no host ports. `127.0.0.1:<port>` will not reach them. Go through the
public route, `kitshn compose ... -- exec`, or the shared `kitshn-edge` network.

## Test Without Deploying Prod

`kitshn try` covers build and serve problems without a push. A recipe that only maps
`main -> prod` can also deploy any environment name on demand, using the workflow's
`workflow_dispatch` input. Make `Caddyfile.j2` hostnames environment-aware first, as above,
or the deploy fails Caddy validation.

## For Agents

KitSHn ships a skill describing this workflow for coding agents:

```bash
kitshn skill show
kitshn skill link-claude
kitshn skill link-opencode
```

## Specs

Behavior contracts for the system itself, written for people changing KitSHn:

[Scope](specs/scope.md) ·
[Primitives](specs/primitives.md) ·
[Filesystem](specs/filesystem.md) ·
[Compose And Dependencies](specs/compose-and-dependencies.md) ·
[Caddy Ingress](specs/caddy.md) ·
[Deploy Flow](specs/deploy-flow.md) ·
[CI Rules](specs/ci.md) ·
[Bootstrap And Repo Init](specs/bootstrap-and-repo-init.md) ·
[CLI](specs/cli.md) ·
[Release](specs/release.md)
