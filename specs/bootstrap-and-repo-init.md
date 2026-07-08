# Bootstrap And Repo Init
Bootstrap prepares the VPS and is idempotent.

Local users can install the CLI before using it:

```bash
brew install yarden-zamir/tap/kitshn
```

or run the hosted CLI directly for one-off use:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn <command>
```

Remote machines always use the hosted CLI through `uvx`. GitHub Actions runs `ci-*` commands with `uvx`, and the VPS deploy/destroy commands executed over SSH also use `uvx`. The VPS should have `uv` available, but does not need a persistent `kitshn` install.

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

Run the same commands as `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...` when the local CLI is not installed.
Do not use bare `uvx kitshn`; use the full GitHub `--from` source so you do not accidentally run an old PyPI package.

`bootstrap-remote` SSHes to the target, installs `uv` with Astral's installer when `uvx` is missing, prepends `$HOME/.local/bin`, then runs hosted `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn bootstrap ...`. It does not require or install a persistent `kitshn` binary on the remote host.

`kitshn doctor` performs the verification checks without making changes.

Recipes are not registered separately. `kitshn deploy` creates the deployment, params, persistent, and logs roots on first run and clones the recipe into the deployment root. `kitshn status` walks `/deployments/*/*/*`.

`kitshn init` writes the required recipe contract files:

- `.kitshn.yaml` with at least one entry, defaulting to `main` → `prod` and a `pr-{pr}` ephemeral entry.
- `.github/workflows/kitshn.yml` calling the kitshn-hosted reusable workflow with `secrets: inherit` and the required `contents: read` plus `deployments: write` permissions.
- `kitshn.md` explaining the recipe contract and recording the KitSHn source commit that generated it.

Optional init flags add optional contract examples:

- `--docker` writes a commented `compose.yml` with KitSHn runtime env, Unix socket ingress, and label examples.
- `--routing` writes a commented preview-safe `Caddyfile.j2` hostname example that routes to `unix//{{ paths.default_socket }}` and `.gitignore` for the generated `Caddyfile` artifact.

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

Run recipe auth before the first deploy-triggering push. A workflow that starts before `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` exist will fail and must be rerun after auth is configured.
