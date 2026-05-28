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

## Connect A Repo

Before running KitSHn commands, the service repo should already exist, have a GitHub remote, and be accessible through an authenticated local `gh` CLI.

### 1. Init

CLI path:

```bash
kitshn init
```

Add optional deployment contract files only when you need them:

```bash
kitshn init --docker
kitshn init --routing
kitshn init --docker --routing
```

<details>
<summary>Manual init details</summary>

Create the required files yourself:

```text
.kitshn.yaml
.github/workflows/kitshn.yml
kitshn.md
```

Add optional files only when your recipe needs them:

```text
compose.yml
Caddyfile.j2
.gitignore
```

</details>

### 2. Auth

CLI path when running on the VPS:

```bash
kitshn recipe auth
```

CLI path when authorizing a remote VPS from your local machine:

```bash
kitshn recipe auth --vps-host deploy@example.com
```

`recipe auth` derives the GitHub repo from the current repo with `gh`, generates a per-recipe SSH key, authorizes the public key on the VPS user, and configures the GitHub repo with `KITSHN_SSH_KEY` and `KITSHN_VPS_HOST`.

<details>
<summary>Manual auth details</summary>

Find the GitHub repo name:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
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

### File Contract

| File | Required | Purpose |
| --- | --- | --- |
| `.kitshn.yaml` | Yes | Maps GitHub events to deployment environments. |
| `.github/workflows/kitshn.yml` | Yes | Calls the KitSHn reusable deployment workflow. |
| `kitshn.md` | Yes | Documents the recipe contract and records the KitSHn source commit that generated it. |
| `compose.yml` | No | Defines Docker Compose services when the recipe has containers. |
| `Caddyfile.j2` | No | Defines public Caddy routing when the recipe needs HTTP ingress. |
| `.gitignore` | No | Ignores generated deployment artifacts such as `Caddyfile` when routing is enabled. |

GitHub vars and secrets starting with `KITSHN_` are forwarded into `params.env` with the prefix stripped. Reserved infrastructure keys `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are not forwarded to app params.

### 3. Deploy

Commit and push the KitSHn files:

```bash
git add .kitshn.yaml .github/workflows/kitshn.yml kitshn.md
git commit -m "chore: add KitSHn deployment config"
git push
```

Also add `compose.yml`, `Caddyfile.j2`, and `.gitignore` if `kitshn init --docker` or `kitshn init --routing` generated them.

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
- [Bootstrap And Repo Init](specs/bootstrap-and-repo-init.md)
- [CLI](specs/cli.md)
