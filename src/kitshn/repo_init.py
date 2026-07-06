from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
import json
import os

from .errors import KitshnError
from .runner import CommandRunner

KITSHN_REPO_URL = "https://github.com/Yarden-zamir/kitshn"
KITSHN_SOURCE_FILE = "src/kitshn/repo_init.py"


@dataclass(frozen=True, slots=True)
class InitResult:
    created_files: list[Path]
    source_commit: str


def init_recipe_repo(
    *,
    target_dir: Path,
    runner: CommandRunner,
    docker: bool = False,
    routing: bool = False,
    force: bool = False,
) -> InitResult:
    source_commit = _kitshn_source_commit(runner)
    files = _required_files(source_commit)
    if docker:
        files[Path("compose.yml")] = _compose_yml()
    if routing:
        files[Path("Caddyfile.j2")] = _caddyfile_j2()
        files[Path(".gitignore")] = "Caddyfile\n"

    created: list[Path] = []
    for relative, content in files.items():
        target = target_dir / relative
        if target.exists() and not force:
            msg = f"refusing to overwrite existing file: {target}"
            raise KitshnError(msg)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        created.append(target)
    return InitResult(created_files=created, source_commit=source_commit)


def _required_files(source_commit: str) -> dict[Path, str]:
    return {
        Path(".kitshn.yaml"): _kitshn_yaml(),
        Path(".github/workflows/kitshn.yml"): _workflow_yml(),
        Path("kitshn.md"): _kitshn_md(source_commit),
    }


def _kitshn_yaml() -> str:
    return """deploy:
  - on: push
    branch: main
    name: prod

  - on: pull_request
    name: pr-{pr}
    ephemeral: true
"""


def _workflow_yml() -> str:
    return """on:
  push:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:
    inputs:
      environment: { required: true, type: string }
      ref: { required: false, type: string }

permissions:
  contents: read
  deployments: write

jobs:
  call:
    uses: Yarden-zamir/kitshn/.github/workflows/deploy.yml@main
    secrets: inherit
"""


def _kitshn_md(source_commit: str) -> str:
    origin = f"{KITSHN_REPO_URL}/blob/{source_commit}/{KITSHN_SOURCE_FILE}"
    return f"""# KitSHn Recipe

This repository is a KitSHn recipe repo. KitSHn deploys recipe repos from GitHub Actions onto a VPS by resolving GitHub events to deployment environments, copying deployment params, and running `kitshn deploy` on the VPS.

## Contract

- `.kitshn.yaml` maps GitHub events to deployment environments.
- `.github/workflows/kitshn.yml` calls the KitSHn reusable deploy workflow and grants it required GitHub token permissions.
- `kitshn.md` documents the recipe contract and the KitSHn source commit that generated it.
- Optional `compose.yml` defines container services for Docker Compose deployments.
- Optional `Caddyfile.j2` defines public routing and is rendered on the VPS into a generated `Caddyfile`.
- Socket ingress is the default routing pattern. Compose services can bind `${{KITSHN_DEFAULT_SOCKET}}` and Caddy can route to `{{{{ paths.default_socket }}}}`.
- GitHub vars and secrets starting with `KITSHN_` become deployment params with the prefix stripped, except reserved infrastructure keys.
- `KITSHN_SSH_KEY` and `KITSHN_VPS_HOST` are required for GitHub Actions to deploy to the VPS.

## Origin

- Generated from: {origin}
- KitSHn commit: `{source_commit}`
"""


def _compose_yml() -> str:
    return """# Define this recipe's Docker Compose services here.
# KitSHn runs docker compose with this file during deployment.
#
# Example:
# services:
#   app:
#     image: nginx:alpine
#     environment:
#       KITSHN_RECIPE: ${KITSHN_RECIPE} # Runtime owner/repo recipe name.
#       KITSHN_ENVIRONMENT: ${KITSHN_ENVIRONMENT} # Resolved deployment environment.
#       KITSHN_DEPLOYMENT: ${KITSHN_DEPLOYMENT} # Full owner/repo/environment identity.
#       KITSHN_PARAMS_FILE: ${KITSHN_PARAMS_FILE} # Path to copied params.env on the VPS.
#       KITSHN_DATA_DIR: ${KITSHN_DATA_DIR} # Persistent data directory for this deployment.
#       KITSHN_LOG_DIR: ${KITSHN_LOG_DIR} # File log directory for this deployment.
#       KITSHN_SOCKET_DIR: ${KITSHN_SOCKET_DIR} # Runtime Unix socket directory cleaned before each deploy.
#       KITSHN_DEFAULT_SOCKET: ${KITSHN_DEFAULT_SOCKET} # Default public ingress socket path.
#       APP_PUBLIC_URL: ${PUBLIC_URL:?PUBLIC_URL is required} # From GitHub var KITSHN_PUBLIC_URL.
#       APP_TOKEN: ${TOKEN:?TOKEN is required} # From GitHub secret KITSHN_TOKEN.
#     volumes:
#       - ${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}
#     command: ["serve", "--unix-socket", "${KITSHN_DEFAULT_SOCKET}"]
#     healthcheck:
#       test: ["CMD", "test", "-S", "${KITSHN_DEFAULT_SOCKET}"]
#     labels:
#       kitshn.depends_on: "owner/another-recipe"
#     networks:
#       - kitshn-edge
#
# networks:
#   kitshn-edge:
#     external: true
services: {}
"""


def _caddyfile_j2() -> str:
    return """# Define this recipe's public Caddy route here.
# Caddyfiles support comments with #.
#
# Example:
# example.com {
#     reverse_proxy unix//{{ paths.default_socket }}
# }
"""


def _kitshn_source_commit(runner: CommandRunner) -> str:
    if source_ref := os.environ.get("KITSHN_SOURCE_REF"):
        return source_ref

    if commit := _direct_url_commit():
        return commit

    source_root = Path(__file__).resolve().parents[2]
    result = runner.run(["git", "rev-parse", "HEAD"], cwd=source_root, capture=True, check=False)
    commit = result.stdout.strip()
    if result.returncode == 0 and commit:
        return commit

    msg = "cannot determine KitSHn source commit for kitshn.md"
    raise KitshnError(msg)


def _direct_url_commit() -> str | None:
    try:
        direct_url = metadata.distribution("kitshn").read_text("direct_url.json")
    except metadata.PackageNotFoundError:
        return None
    if not direct_url:
        return None
    try:
        payload = json.loads(direct_url)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    vcs_info = payload.get("vcs_info")
    if not isinstance(vcs_info, dict):
        return None
    commit = vcs_info.get("commit_id")
    return commit if isinstance(commit, str) and commit else None
