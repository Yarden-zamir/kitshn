# AGENTS.md

## Project Shape
- Python 3.14 `uv` project; use `uv run ...` for project commands and do not use raw `python`/`pip`.
- CLI entrypoint is `kitshn = kitshn.cli:main`; command definitions live in `src/kitshn/cli.py`.
- There is no Makefile, pre-commit config, or test/lint GitHub workflow. `.github/workflows/deploy.yml` is the reusable deploy workflow that recipe repos call. `.github/workflows/release.yml` tags, releases, and syncs the Homebrew tap on every push to `main` with a new `pyproject.toml` version; see `specs/release.md`.

## Commands
- Install/sync deps: `uv sync`.
- Lint: `uv run ruff check .`.
- Type-check: `uv run ty check`.
- Test all: `uv run pytest`.
- Focus one test file or case: `uv run pytest tests/test_resolve.py -k workflow_dispatch`.
- Build package artifacts: `uv build`; `dist/` is generated.
- Local CLI smokes that might touch deployment state should set `KITSHN_ROOT` to a temp directory; otherwise roots default to `/deployments`, `/params`, `/persistent`, and `/logs`.
- Local users may install the CLI with Homebrew from `Yarden-zamir/homebrew-tap` or run `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...`; remote CI/VPS commands always use hosted `uvx`, not a persistent VPS `kitshn` install.
- Formula behavior belongs in `.homebrew/kitshn.rb`, then the tap sync renders `Formula/kitshn.rb`.

## Implementation Contracts
- `src/kitshn/models.py` owns recipe/deployment identity and path rules: recipes must be `owner/repo`; environments are sanitized to lowercase dash names and truncated to 63 chars.
- `src/kitshn/resolve.py` resolves `.kitshn.yaml`; first matching entry wins, `workflow_dispatch` uses the requested environment directly, and the unquoted YAML key `on` is intentionally normalized from PyYAML's boolean parse.
- `src/kitshn/repo_init.py` owns generated recipe files (`.kitshn.yaml`, `.github/workflows/kitshn.yml`, `kitshn.md`, optional `compose.yml`, `Caddyfile.j2`, `.gitignore`). Tests assert exact generated snippets.
- `src/kitshn/ci.py` forwards only GitHub vars/secrets named `KITSHN_*` into `params.env` with the prefix stripped; `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved infrastructure keys and are not forwarded.
- `src/kitshn/compose.py` runs Docker Compose as `docker compose --project-name <deployment> --env-file <params.env> ...`; only `compose.yml` and `compose.yaml` are deployment compose files. The exception is `compose_down`, which removes by project name alone, from the deployments root, so a teardown never depends on the checkout's compose file.
- Deploy clears `<deployment>/.kitshn/sockets` after pull and build succeed and then runs Compose `up -d --remove-orphans --force-recreate`; do not remove force-recreate unless socket lifecycle is redesigned.
- Deploy never deletes the live generated `Caddyfile` before `apply_caddyfile`; every Caddy reload rebuilds the manifest from the Caddyfiles that exist, so a missing one drops that route for all recipes' reloads.
- `git_ops` passes `gh auth git-credential` with `git -c` on fetch and `ls-remote`; never run `gh auth setup-git`, which rewrites the shared `~/.gitconfig`.
- `deploy` and `destroy` run under `filesystem.host_deploy_lock`, a `flock` on `<deployments>/.kitshn-deploy.lock`, except with `--dry-run`. The reusable workflow's per-deployment `concurrency` groups order pushes; the lock only serializes recipes.
- Socket proxy examples must keep proxy-to-app traffic on the project-local default network; do not attach socket proxies to shared `kitshn-edge` unless the socket proxy itself intentionally serves cross-recipe traffic.
- `kitshn.depends_on` Compose labels trigger dependent service recreation after a recipe deploy; matching is case-insensitive `owner/repo`.
- `src/kitshn/caddy.py` renders only `Caddyfile.j2`; generated `Caddyfile` files are deployment artifacts and feed the generated manifest at `<deployments>/Caddyfile`. `infer_public_url` renders the template without params and returns a URL only for exactly one concrete host.
- `Caddyfile.j2` gets `host(base)`: `base` for `prod`, `<environment>.<base>` otherwise. A non-prod `host()` records `# kitshn preview wildcard: *.<base>` in the generated `Caddyfile`; the manifest adds one `*.<base> { tls { dns } abort }` site per base only when `/etc/caddy/kitshn-options.caddy` sets a `dns` provider.
- `src/kitshn/caddy_host.py` owns the opt-in host Caddy setup of `bootstrap`: module build (xcaddy in `caddy:<version>-builder`, `dpkg-divert`), global options file, `/etc/caddy/kitshn.env` and its systemd drop-in. Tests isolate the `/etc/caddy` paths in `tests/conftest.py`.
- `src/kitshn/remote.py` forwards a CLI invocation to the VPS (`--vps-host`) as `bash -lc` plus the hosted `uvx` CLI; `src/kitshn/try_recipe.py` and `src/kitshn/track.py` own `kitshn try` and `kitshn track`; `src/kitshn/version_check.py` owns `kitshn self-check`.
- `tests/test_version.py` asserts that `pyproject.toml`, `src/kitshn/__init__.py`, and `uv.lock` agree; bump all three (run `uv lock`) together.

## Testing Notes
- Unit tests use fake `CommandRunner` implementations and temp `Roots`; do not add tests that require real Docker, Caddy, SSH, or GitHub auth unless explicitly making an integration suite.
- When changing subprocess behavior, update tests around `CommandRunner` call order and exact arguments instead of shelling out in tests.
- When changing generated contract files, update `tests/test_repo_init.py` alongside the templates.

## Related Guidance
- `.claude/skills/kitshn-deploy-service` is a symlink to `src/kitshn/resources/kitshn-deploy-service`, the skill for downstream service repos deployed with KitSHn, not for this CLI implementation itself. Edit the bundled copy.
