# Bootstrap And Repo Init

## Bootstrap

Bootstrap prepares the VPS and is idempotent. Running it repeatedly is safe: it creates
missing resources, verifies existing ones, and only changes existing configuration when it
does not match KitSHn's expected state. It ends by running the same checks as `doctor`.

Verifies: Docker, the Docker Compose plugin, Git, uv, Caddy.

Creates or verifies: the deployment user; `/deployments`, `/params`, `/persistent`, `/logs`,
and `/logs/.kitshn`; shared Docker networks such as `kitshn-edge`; `gh` availability, warning
when unauthenticated because private repos need it.

Dependency installation is explicit and opt-in. `doctor` reports missing dependencies and
suggests matching installer modules. `bootstrap --install-missing --installer <name>` runs the
selected installer before creating or verifying KitSHn resources.

`bootstrap-remote` SSHes to the target, installs `uv` with Astral's installer when `uvx` is
missing, prepends `$HOME/.local/bin`, then runs hosted KitSHn through `uvx`. It never requires
or installs a persistent `kitshn` binary on the remote host.

## CLI Distribution

Local machines may use an installed CLI or the hosted `uvx --from git+...` form. Remote
machines always use the hosted form: GitHub Actions runs `ci-*` commands through `uvx`, and
the VPS deploy/destroy commands executed over SSH do too. The VPS needs `uv` available, not a
persistent `kitshn` install.

Bare `uvx kitshn` is wrong everywhere; it resolves an unrelated old PyPI package.

## Installers

Installer modules are standalone Python files under `kitshn.installers`, discovered
dynamically and exposed through `kitshn installers` and the `--installer` choice list. Each
declares metadata, supported package managers, OS detection, and its install routine.

- `ubuntu`, `debian` — apt, official Docker and Caddy package repositories, Git via apt, uv via Astral's standalone installer.
- `fedora` — dnf, Docker CE repository, Caddy COPR, Git via dnf, uv via Astral's standalone installer.
- `arch` — pacman packages for Docker, Compose, Git, Caddy; uv via Astral's standalone installer.
- `alpine` — apk packages for Docker, Compose, Git, Caddy; uv via Astral's standalone installer.

## Recipe Registration

Recipes are not registered separately. `deploy` creates the deployment, params, persistent,
and logs roots on first run and clones the recipe into the deployment root. `status` walks
`/deployments/*/*/*`.

## Init

`init` writes the required recipe contract files:

- `.kitshn.yaml` with at least one entry, defaulting to `main` → `prod` plus a `pr-{pr}` ephemeral entry.
- `.github/workflows/kitshn.yml` calling the hosted reusable workflow with `secrets: inherit`
  and the required `contents: read` plus `deployments: write` permissions.
- `kitshn.md` explaining the recipe contract and recording the KitSHn source commit that generated it.

Optional flags add optional contract examples:

- `--docker` writes a commented `compose.yml` with KitSHn runtime env, Unix socket ingress, and label examples.
- `--routing` writes a commented preview-safe `Caddyfile.j2` routing to `unix//{{ paths.default_socket }}`,
  and a `.gitignore` for the generated `Caddyfile` artifact.

## Recipe Auth

Separate from init. Assumes the repo exists, has a GitHub remote, and the local `gh` CLI is
authenticated.

Derives the repo name with `gh repo view`, generates a per-recipe SSH key, authorizes the
public key locally when `--vps-host` is omitted or over SSH when supplied, and sets the GitHub
Actions secret and variable the reusable workflow needs. When `--vps-host` is an SSH alias,
KitSHn uses the alias for SSH but stores the resolved `user@hostname` from `ssh -G` in
`KITSHN_VPS_HOST`.

Recipe auth must run before the first deploy-triggering push. A workflow that starts before
`KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` exist fails and must be rerun after auth is configured.
