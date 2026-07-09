# KitSHn
KitSHn is a small VPS deployment system for GitHub repos.

```text
repo changed -> GitHub Actions SSHes to VPS -> kitshn deploy <owner/repo>
```

## Run The CLI
On your computer, either install the CLI:

```bash
brew install yarden-zamir/tap/kitshn
```

or run the hosted CLI directly:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --help
```

Use the full `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...` form. Do not use bare `uvx kitshn`; that may resolve an old PyPI package.

Remote machines are different: GitHub Actions and VPS deploy/destroy commands always run the hosted CLI through `uvx`. Do not install or pin a persistent `kitshn` binary on the VPS for CI deploys. Bootstrap only needs to make `uv`, Docker, Caddy, Git, and `gh` available.

## Bootstrap A VPS
Run once per VPS:

```bash
kitshn installers
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

Use the same commands through `uvx ... kitshn` if you have not installed the local Homebrew formula.
For a fresh remote VPS, use `kitshn bootstrap-remote <ssh-target> --install-missing --installer <installer>`; it installs/verifies remote `uv` and then runs hosted KitSHn through `uvx`.

Bootstrap verifies Docker, Caddy, deployment roots, the shared Docker network, and Caddy imports. See [Filesystem](specs/filesystem.md), [Caddy Ingress](specs/caddy.md), and [CLI](specs/cli.md).

## Deploy A Repo
From the service repo:

```bash
kitshn init --docker --routing
kitshn recipe auth --vps-host deploy@example.com
```

The examples use `kitshn` for readability; `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...` is equivalent for local one-off use.

Use `--routing` only for public HTTP services. KitSHn defaults public HTTP to Unix socket ingress:

```caddyfile
example.com {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

Apps can listen on `${KITSHN_DEFAULT_SOCKET}` directly. TCP-only images can use a sidecar such as `alpine/socat` to forward from the socket to the app's internal Compose port. See [Compose And Dependencies](specs/compose-and-dependencies.md) and [Caddy Ingress](specs/caddy.md).

Set runtime params as GitHub vars/secrets named `KITSHN_<NAME>`; the app receives `<NAME>`. `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved infrastructure keys and are not forwarded. See [CI Rules](specs/ci.md).

Run `kitshn recipe auth` before the first push that should deploy. If Actions runs before `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` exist, rerun the workflow after auth is configured.

Commit and push the generated files. The default `.kitshn.yaml` deploys `main` to `prod` and pull requests to `pr-<number>`.

## Verify
Watch the GitHub Actions run, then diagnose on the VPS:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn diagnose <owner/repo> --environment prod
```

For PR previews, diagnose `pr-<number>`. Public PR routes still require DNS, usually wildcard DNS pointing at the VPS.

## Operate
Run these on the VPS instead of raw `docker` or `docker compose`, which miss KitSHn's project name and params file. Each takes `--environment` and defaults to `prod`. See [CLI](specs/cli.md).

```bash
kitshn status <owner/repo>                 # ref, services, health, route, socket, last deploy
kitshn logs <owner/repo> [service]         # docker logs; --follow to tail, --files for file logs
kitshn compose <owner/repo> -- ps          # docker compose with the deployment's exact context
kitshn params list <owner/repo>            # param names, no values
kitshn params get <owner/repo> TOKEN --show  # one value, correctly unquoted
```

Deployed services publish no host ports, so `127.0.0.1:<port>` does not reach them. Use the public Caddy route, `kitshn compose ... -- exec`, or the shared `kitshn-edge` network.

Recipes that only deploy `main -> prod` can still deploy any environment name on demand with the workflow's `workflow_dispatch` input. Make `Caddyfile.j2` hostnames environment-aware first, or Caddy rejects the duplicate site definition.

## Agent Skill
Show or install the minimal deployment skill for future agent sessions:

```bash
kitshn skill show
kitshn skill link-claude
kitshn skill link-opencode
```

## References
- [Scope](specs/scope.md)
- [Primitives](specs/primitives.md)
- [Filesystem](specs/filesystem.md)
- [Compose And Dependencies](specs/compose-and-dependencies.md)
- [Caddy Ingress](specs/caddy.md)
- [Deploy Flow](specs/deploy-flow.md)
- [CI Rules](specs/ci.md)
- [Bootstrap And Repo Init](specs/bootstrap-and-repo-init.md)
- [CLI](specs/cli.md)
- [Release](specs/release.md)
- [Lessons And Architecture Follow-ups](specs/lessons-and-architecture-followups.md)
