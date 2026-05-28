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

CLI path:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install git+https://github.com/Yarden-zamir/kitshn.git --force
kitshn installers
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

Make sure the `uv` tool bin directory is available to non-interactive SSH sessions. For the default uv install this is usually `~/.local/bin`.

Bootstrap verifies or creates the deployment roots, shared Docker network, and Caddy import. Dependency installers are opt-in; `doctor` reports missing dependencies and matching installers.

<details>
<summary>Manual setup details</summary>

Install `uv` on the VPS first, because KitSHn is distributed and run with `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Install the KitSHn CLI on the VPS:

```bash
uv tool install git+https://github.com/Yarden-zamir/kitshn.git --force
```

List installers and pick the one matching your distro:

```bash
kitshn installers
kitshn bootstrap --install-missing --installer ubuntu
kitshn doctor
```

</details>

## Seed And Deploy A Service

Seeding means connecting an existing service repository to KitSHn by adding the required KitSHn files and GitHub Actions SSH configuration.

List available templates:

```bash
kitshn templates
```

Choose one:

- `bare` adds only `.kitshn.yaml` and `.github/workflows/kitshn.yml`.
- `node-service` adds a starter Node app, Compose file, Dockerfile, Caddy route, and workflow.
- `static-site` adds a starter static site and Caddy route.
- `worker` adds a starter background worker.
- `settings-repo` adds only deployment settings scaffolding.

CLI path for seeding an existing repo:

```bash
kitshn seed <owner/repo> --template bare --vps-host deploy@example.com
```

This one command copies the template, generates a per-recipe SSH key, authorizes the public key on the VPS user, and configures the service repo with `KITSHN_SSH_KEY` plus `KITSHN_VPS_HOST` through `gh`.

For public HTTP routing, set a GitHub Environment variable or secret with the `KITSHN_` prefix. The starter `node-service` and `static-site` templates expect:

```text
KITSHN_DOMAIN=example.com
```

CI strips the `KITSHN_` prefix before writing `params.env`, so the recipe sees `DOMAIN`. `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved infrastructure keys and are not forwarded to app params.

Commit and push the seeded files:

```bash
git add .kitshn.yaml .github/workflows/kitshn.yml
git commit -m "chore: seed KitSHn deployment config"
git push
```

<details>
<summary>Manual seeding details</summary>

Copy template files into the service repo:

```bash
kitshn init <owner/repo> --template bare
```

Generate a per-recipe SSH key:

```bash
ssh-keygen -t ed25519 -C "kitshn:<owner/repo>" -f ~/.ssh/kitshn-<owner>-<repo>-ed25519 -N ""
```

Authorize the public key on the VPS deployment user:

```bash
ssh deploy@example.com 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < ~/.ssh/kitshn-<owner>-<repo>-ed25519.pub
```

Configure the service repository through GitHub CLI:

```bash
gh secret set KITSHN_SSH_KEY --repo <owner/repo> --body-file ~/.ssh/kitshn-<owner>-<repo>-ed25519
gh variable set KITSHN_VPS_HOST --repo <owner/repo> --body deploy@example.com
```

If the recipe repo is private, authenticate GitHub CLI on the VPS deployment user so the VPS can clone it:

```bash
gh auth login
kitshn doctor
```

</details>

The seeded files include:

- `.kitshn.yaml` with `main -> prod` and ephemeral PR deployments.
- `.github/workflows/kitshn.yml` that calls the KitSHn reusable workflow.
- Template-specific files such as `compose.yml`, `Dockerfile`, app files, and `Caddyfile.j2` when the chosen template includes them.

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
