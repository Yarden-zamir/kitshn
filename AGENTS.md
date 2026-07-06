# AGENTS.md

## Project Shape
- Python 3.14 `uv` project; use `uv run ...` for project commands and do not use raw `python`/`pip`.
- CLI entrypoint is `kitshn = kitshn.cli:main`; command definitions live in `src/kitshn/cli.py`.
- There is no Makefile, pre-commit config, or test/lint GitHub workflow. `.github/workflows/deploy.yml` is the reusable deploy workflow that recipe repos call.

## Commands
- Install/sync deps: `uv sync`.
- Lint: `uv run ruff check .`.
- Type-check: `uv run ty check`.
- Test all: `uv run pytest`.
- Focus one test file or case: `uv run pytest tests/test_resolve.py -k workflow_dispatch`.
- Build package artifacts: `uv build`; `dist/` is generated.
- Local CLI smokes that might touch deployment state should set `KITSHN_ROOT` to a temp directory; otherwise roots default to `/deployments`, `/params`, `/persistent`, and `/logs`.
- Local users install the CLI with Homebrew from `Yarden-zamir/homebrew-tap`; formula behavior belongs in `.homebrew/kitshn.rb`, then the tap sync renders `Formula/kitshn.rb`.

## Implementation Contracts
- `src/kitshn/models.py` owns recipe/deployment identity and path rules: recipes must be `owner/repo`; environments are sanitized to lowercase dash names and truncated to 63 chars.
- `src/kitshn/resolve.py` resolves `.kitshn.yaml`; first matching entry wins, `workflow_dispatch` uses the requested environment directly, and the unquoted YAML key `on` is intentionally normalized from PyYAML's boolean parse.
- `src/kitshn/repo_init.py` owns generated recipe files (`.kitshn.yaml`, `.github/workflows/kitshn.yml`, `kitshn.md`, optional `compose.yml`, `Caddyfile.j2`, `.gitignore`). Tests assert exact generated snippets.
- `src/kitshn/ci.py` forwards only GitHub vars/secrets named `KITSHN_*` into `params.env` with the prefix stripped; `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` are reserved infrastructure keys and are not forwarded.
- `src/kitshn/compose.py` runs Docker Compose as `docker compose --project-name <deployment> --env-file <params.env> ...`; only `compose.yml` and `compose.yaml` are deployment compose files.
- Deploy clears `<deployment>/.kitshn/sockets` and then runs Compose `up -d --remove-orphans --force-recreate`; do not remove force-recreate unless socket lifecycle is redesigned.
- `kitshn.depends_on` Compose labels trigger dependent service recreation after a recipe deploy; matching is case-insensitive `owner/repo`.
- `src/kitshn/caddy.py` renders only `Caddyfile.j2`; generated `Caddyfile` files are deployment artifacts and feed the generated manifest at `<deployments>/Caddyfile`.

## Testing Notes
- Unit tests use fake `CommandRunner` implementations and temp `Roots`; do not add tests that require real Docker, Caddy, SSH, or GitHub auth unless explicitly making an integration suite.
- When changing subprocess behavior, update tests around `CommandRunner` call order and exact arguments instead of shelling out in tests.
- When changing generated contract files, update `tests/test_repo_init.py` alongside the templates.

## Related Guidance
- `.claude/skills/kitshn-deploy-service/SKILL.md` is for downstream service repos deployed with KitSHn, not for this CLI implementation itself.
