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

Remote machines are different: GitHub Actions and VPS deploy/destroy commands always run the hosted CLI through `uvx`. Do not install or pin a persistent `kitshn` binary on the VPS for CI deploys. Bootstrap only needs to make `uv`, Docker, Caddy, Git, and `gh` available.

## Bootstrap A VPS
Run once per VPS:

```bash
kitshn installers
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

Use the same commands through `uvx ... kitshn` if you have not installed the local Homebrew formula.

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

Commit and push the generated files. The default `.kitshn.yaml` deploys `main` to `prod` and pull requests to `pr-<number>`.

## Verify
Watch the GitHub Actions run, then diagnose on the VPS:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn diagnose <owner/repo> --environment prod
```

For PR previews, diagnose `pr-<number>`. Public PR routes still require DNS, usually wildcard DNS pointing at the VPS.

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
