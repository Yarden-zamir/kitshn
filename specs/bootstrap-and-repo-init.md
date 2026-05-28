# Bootstrap And Repo Init
Bootstrap prepares the VPS and is idempotent.

Bootstrap verifies:

- Docker
- Docker Compose plugin
- Git
- uv
- Caddy

Bootstrap creates or verifies:

- deployment user
- `/deployments`
- `/params`
- `/persistent`
- `/logs`
- `/logs/.kitshn`
- shared Docker networks such as `kitshn-edge`
- GitHub CLI (`gh`) availability
- GitHub CLI private repo auth status as a warning when unauthenticated

Running `kitshn bootstrap` repeatedly is safe. It creates missing resources, verifies existing resources, and only changes existing configuration when it does not match KitSHn's expected state. At the end, it runs the same checks as `kitshn doctor`.

Dependency installation is explicit and opt-in. `kitshn doctor` reports missing dependencies and suggests matching installer modules. `kitshn bootstrap --install-missing --installer <installer>` runs the selected installer before creating/verifying KitSHn resources.

Installer modules are standalone Python files under `kitshn.installers`. KitSHn discovers them dynamically and exposes their names through `kitshn installers` and the `--installer` choice list. Each installer declares metadata, supported package managers, OS detection, and its install routine.

Initial installers:

- `ubuntu` — apt, official Docker and Caddy package repositories, Git via apt, uv via official standalone installer.
- `debian` — apt, official Docker and Caddy package repositories, Git via apt, uv via official standalone installer.
- `fedora` — dnf, Docker CE repository, Caddy COPR, Git via dnf, uv via official standalone installer.
- `arch` — pacman packages for Docker, Compose, Git, Caddy, uv via official standalone installer.
- `alpine` — apk packages for Docker, Compose, Git, Caddy, uv via official standalone installer.

Commands:

```bash
kitshn bootstrap
kitshn bootstrap --install-missing --installer ubuntu
kitshn installers
kitshn bootstrap-remote <ssh-target>
kitshn doctor
```

`kitshn doctor` performs the verification checks without making changes.

Recipes are not registered separately. `kitshn deploy` creates the deployment, params, persistent, and logs roots on first run and clones the recipe into the deployment root. `kitshn status` walks `/deployments/*/*/*`.

`kitshn init` writes the required recipe contract files:

- `.kitshn.yaml` with at least one entry, defaulting to `main` → `prod` and a `pr-{pr}` ephemeral entry.
- `.github/workflows/kitshn.yml` calling the kitshn-hosted reusable workflow with `secrets: inherit` and the required `contents: read` plus `deployments: write` permissions.
- `kitshn.md` explaining the recipe contract and recording the KitSHn source commit that generated it.

Optional init flags add optional contract examples:

- `--docker` writes a commented `compose.yml` with KitSHn runtime env and label examples.
- `--routing` writes a commented `Caddyfile.j2` and `.gitignore` for the generated `Caddyfile` artifact.

Commands:

```bash
kitshn init
kitshn init --docker
kitshn init --routing
kitshn init --docker --routing
```

Recipe auth is separate from init:

```bash
kitshn recipe auth
kitshn recipe auth --vps-host <ssh-target>
```

It assumes the repo already exists, has a GitHub remote, and the local `gh` CLI is authenticated. It derives the GitHub repo name with `gh repo view`, generates a per-recipe SSH key, authorizes that public key locally when `--vps-host` is omitted or over SSH when supplied, and sets the GitHub Actions secret/variable needed by the reusable workflow. When `--vps-host` is an SSH alias, KitSHn uses the alias for SSH and stores the resolved `user@hostname` from `ssh -G` in `KITSHN_VPS_HOST`.
