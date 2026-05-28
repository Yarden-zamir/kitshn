# KitSHn
KitSHn is a small VPS deployment system for GitHub repos.

Core flow:

```text
repo changed -> CI SSHes to VPS -> kitshn deploy <owner/repo> -> affected deployments update
```

Core primitives:

- **Recipe**: a fully qualified GitHub repo name, `owner/repo`, plus its deployment contract.
- **Environment**: a GitHub Environment name, such as `prod`, `stage`, or `test`.
- **Deployment**: one recipe deployed to one environment.
- **Service**: a Docker Compose service inside a recipe.

## Setup

Install `uv` on the VPS first, because KitSHn is distributed and run with `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Install the KitSHn CLI on the VPS:

```bash
uv tool install git+https://github.com/Yarden-zamir/kitshn.git --force
```

Make sure the `uv` tool bin directory is available to non-interactive SSH sessions. For the default uv install this is usually `~/.local/bin`.

Bootstrap the VPS. Pick the installer matching your distro:

```bash
kitshn installers
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

Bootstrap verifies or creates the deployment roots, shared Docker network, and Caddy import. Dependency installers are opt-in; `doctor` reports missing dependencies and matching installers.

Configure SSH access:

- Add a GitHub Actions secret named `KITSHN_SSH_KEY` containing a private key that can SSH into the VPS deployment user.
- Add a GitHub Actions variable named `KITSHN_VPS_HOST`, for example `deploy@example.com`.
- Add a deploy key on each recipe repo so the VPS can clone `git@github.com:<owner>/<repo>.git`.

## Create And Deploy A Service

In the service repository, generate KitSHn files from a template:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn init <owner/repo> --template node-service
```

This creates:

- `.kitshn.yaml` with `main -> prod` and ephemeral PR deployments.
- `.github/workflows/kitshn.yml` that calls the KitSHn reusable workflow.
- A starter `compose.yml`, `Dockerfile`, app file, and `Caddyfile.j2`.

For public HTTP routing, set a GitHub Environment variable or secret with the `KITSHN_` prefix. The starter `node-service` template expects:

```text
KITSHN_DOMAIN=example.com
```

CI strips the `KITSHN_` prefix before writing `params.env`, so the recipe sees `DOMAIN`. `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved infrastructure keys and are not forwarded to app params.

Commit and push the generated files:

```bash
git add .kitshn.yaml .github/workflows/kitshn.yml compose.yml Dockerfile Caddyfile.j2 .gitignore
git commit -m "chore: add KitSHn deployment config"
git push
```

Deployments then happen through GitHub Actions:

- Push to `main` deploys `prod`.
- Opening or updating a pull request deploys `pr-<number>`.
- Closing a pull request destroys the PR deployment while preserving `/persistent` and `/logs` by default.
- Manual `workflow_dispatch` can deploy any ref to an explicit environment.

To deploy manually from the VPS, provide a params file and run:

```bash
kitshn deploy <owner/repo> --environment prod --ref main --params-file ./params.env
```

Docs:

- [Scope](specs/scope.md)
- [Primitives](specs/primitives.md)
- [Filesystem](specs/filesystem.md)
- [Compose And Dependencies](specs/compose-and-dependencies.md)
- [Caddy Ingress](specs/caddy.md)
- [Deploy Flow](specs/deploy-flow.md)
- [CI Rules](specs/ci.md)
- [Bootstrap And Templates](specs/bootstrap-and-templates.md)
- [CLI](specs/cli.md)
