from __future__ import annotations

from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
import json
import os
from typing import Literal

from .errors import KitshnError
from .runner import CommandRunner

KITSHN_REPO_URL = "https://github.com/Yarden-zamir/kitshn"
KITSHN_SOURCE_FILE = "src/kitshn/repo_init.py"
PLACEHOLDER_HOSTNAME = "example.com"
DEFAULT_SITE_DIR = "site"

Template = Literal["static"]

# Order matters: a push before `recipe auth` starts a workflow that fails on missing secrets.
CHECKLIST = (
    "create the GitHub repo if it does not exist: gh repo create <owner/repo> --private --source . --remote origin",
    "kitshn recipe auth --vps-host <ssh-target>   # before the first push; reads the git remote",
    "kitshn try   # optional: build and run the recipe locally, or --vps-host <ssh-target> to run it on the VPS",
    "git add -A && git commit && git push",
    "kitshn track   # follows the Actions run and verifies the deployment",
)


@dataclass(frozen=True, slots=True)
class InitResult:
    created_files: list[Path]
    source_commit: str
    checklist: list[str] = field(default_factory=lambda: list(CHECKLIST))


def init_recipe_repo(
    *,
    target_dir: Path,
    runner: CommandRunner,
    docker: bool = False,
    routing: bool = False,
    template: Template | None = None,
    hostname: str | None = None,
    site_dir: str | None = None,
    force: bool = False,
) -> InitResult:
    if template is not None and (docker or routing):
        msg = f"--template {template} already writes compose.yml and Caddyfile.j2; drop --docker and --routing"
        raise KitshnError(msg)
    if template is None and (hostname is not None or site_dir is not None):
        msg = "--hostname and --site-dir only apply with --template static"
        raise KitshnError(msg)

    source_commit = _kitshn_source_commit(runner)
    files = _required_files(source_commit)
    checklist = list(CHECKLIST)
    if docker:
        files[Path("compose.yml")] = _compose_yml()
    if routing:
        files[Path("Caddyfile.j2")] = _caddyfile_j2()
        files[Path(".gitignore")] = "Caddyfile\n"
    if template == "static":
        resolved_hostname = hostname or PLACEHOLDER_HOSTNAME
        resolved_site_dir = (site_dir or DEFAULT_SITE_DIR).strip("/")
        files.update(static_site_files(resolved_hostname, resolved_site_dir))
        checklist.insert(0, f"put the files to serve under {resolved_site_dir}/")
        if hostname is None:
            checklist.insert(1, f"replace {PLACEHOLDER_HOSTNAME} in Caddyfile.j2 with the public hostname")

    created: list[Path] = []
    for relative, content in files.items():
        target = target_dir / relative
        if target.exists() and not force:
            msg = f"refusing to overwrite existing file: {target}"
            raise KitshnError(msg)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        created.append(target)
    return InitResult(created_files=created, source_commit=source_commit, checklist=checklist)


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

This repository is a KitSHn recipe repo. KitSHn deploys recipe repos from GitHub Actions onto a VPS by resolving GitHub events to deployment environments, copying deployment params, and running the hosted KitSHn CLI through `uvx` on the VPS.

## Contract

- `.kitshn.yaml` maps GitHub events to deployment environments.
- `.github/workflows/kitshn.yml` calls the KitSHn reusable deploy workflow and grants it required GitHub token permissions.
- `kitshn.md` documents the recipe contract and the KitSHn source commit that generated it. Rewrite the prose freely, but keep the Origin section at the end so `kitshn` can tell which template version produced this recipe.
- Optional `compose.yml` defines container services for Docker Compose deployments.
- Optional `Caddyfile.j2` defines public routing and is rendered on the VPS into a generated `Caddyfile`.
- Socket ingress is the default routing pattern. Compose services can bind `${{KITSHN_DEFAULT_SOCKET}}` and Caddy can route to `{{{{ paths.default_socket }}}}`.
- GitHub vars and secrets starting with `KITSHN_` become deployment params with the prefix stripped, except reserved infrastructure keys.
- `KITSHN_SSH_KEY` and `KITSHN_VPS_HOST` are required for GitHub Actions to deploy to the VPS.
- Run `kitshn recipe auth --vps-host <ssh-target>` before the first deploy-triggering push so those infrastructure keys exist.
- Local users may run KitSHn from Homebrew or `uvx`; CI and VPS commands use hosted `uvx` and do not require a persistent VPS `kitshn` install.

## Operating This Deployment

Run these on the VPS. They take `--environment <env>` and default to `prod`. Pass `--help` to any
of them for flags. Prefer them over raw `docker` and `docker compose`, which do not know this
deployment's Compose project name or params file.

- `kitshn diagnose <owner/repo>` — start here; checks Compose, sockets, Caddy routing and config.
- `kitshn status <owner/repo>` — ref, services, health, route, socket, and last deploy, as JSON.
- `kitshn logs <owner/repo> [service]` — Docker logs for this deployment.
- `kitshn compose <owner/repo> -- <args>` — Docker Compose with this deployment's exact context.
- `kitshn params list <owner/repo>` — param names without values.
- `kitshn params get <owner/repo> <KEY> --show` — one param value, correctly decoded. Do not
  hand-parse `params.env`; its values are quoted and escaped for Compose.

Services publish no host ports. Reach them through the public Caddy route, through
`kitshn compose ... -- exec`, or from the shared `kitshn-edge` Docker network. `127.0.0.1:<port>`
does not reach them.

This recipe can deploy any environment name on demand through the workflow's `workflow_dispatch`
input, even if it only maps `main -> prod`. Make `Caddyfile.j2` hostnames environment-aware
before doing so, or Caddy will reject the duplicate site definition.

## Origin

- Generated from: {origin}
- KitSHn commit: `{source_commit}`
"""


def static_site_files(hostname: str, site_dir: str) -> dict[Path, str]:
    """Files for a static site served by Caddy inside the container, bound to the KitSHn socket."""

    return {
        Path("Dockerfile"): f"""FROM caddy:2-alpine

COPY container/Caddyfile /etc/caddy/Caddyfile
COPY {site_dir} /srv
""",
        Path("container/Caddyfile"): _static_container_caddyfile(),
        Path("compose.yml"): _static_compose_yml(),
        Path("Caddyfile.j2"): _static_caddyfile_j2(hostname),
        Path(".dockerignore"): """.git
.github
Caddyfile
Caddyfile.j2
*.md
.DS_Store
""",
        Path(".gitignore"): "Caddyfile\n",
    }


def _static_container_caddyfile() -> str:
    return """# Caddy inside the container. The host Caddy (Caddyfile.j2) terminates TLS and proxies
# the public hostname to this Unix socket, so this file serves plain HTTP on the socket.
{
	auto_https off
	admin off
}

http:// {
	# Caddy binds the KitSHn socket directly and removes a stale socket file left by a
	# previous container, so no socat sidecar is needed. 0666 lets the host Caddy connect.
	bind unix/{$KITSHN_DEFAULT_SOCKET}|0666
	root * /srv

	# encode only compresses its default MIME types. A custom Content-Type set with `header`
	# is not in that list, and `header` runs before encode sees the type, so list every type
	# to compress here explicitly.
	encode zstd gzip {
		match {
			header Content-Type text/*
			header Content-Type application/json*
			header Content-Type application/javascript*
			header Content-Type application/xml*
			header Content-Type application/manifest+json*
			header Content-Type image/svg+xml*
		}
	}

	# Examples. Uncomment and adapt.
	# @sw path /sw.js
	# header @sw Cache-Control "no-cache"
	# header /assets/* Cache-Control "public, max-age=604800"
	# @gpx path *.gpx
	# header @gpx Content-Type application/gpx+xml
	# header @gpx Content-Disposition attachment

	file_server
}
"""


def _static_compose_yml() -> str:
    return """services:
  site:
    build: .
    pull_policy: build
    environment:
      KITSHN_RECIPE: ${KITSHN_RECIPE}
      KITSHN_ENVIRONMENT: ${KITSHN_ENVIRONMENT}
      KITSHN_DEPLOYMENT: ${KITSHN_DEPLOYMENT}
      KITSHN_SOCKET_DIR: ${KITSHN_SOCKET_DIR}
      KITSHN_DEFAULT_SOCKET: ${KITSHN_DEFAULT_SOCKET}
    volumes:
      - ${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}
    healthcheck:
      test: ["CMD", "test", "-S", "${KITSHN_DEFAULT_SOCKET}"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 10s
    restart: unless-stopped
"""


def _static_caddyfile_j2(hostname: str) -> str:
    return f"""{{% if environment == "prod" -%}}
{hostname}
{{%- else -%}}
pr.{{{{ environment.removeprefix("pr-") }}}}.{hostname}
{{%- endif %}} {{
    reverse_proxy unix//{{{{ paths.default_socket }}}}
}}
"""


def _compose_yml() -> str:
    return """# Define this recipe's Docker Compose services here.
# KitSHn runs docker compose with this file during deployment.
#
# Direct Unix socket example for apps that can listen on a socket (preferred; no sidecar):
# services:
#   app:
#     build: .
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
#
# Socket proxy sidecar, only for images that cannot bind a Unix socket themselves:
# services:
#   app:
#     image: nginx:alpine
#     expose:
#       - "80"
#
#   socket-proxy:
#     image: alpine/socat:latest
#     pull_policy: always
#     command: ["UNIX-LISTEN:${KITSHN_DEFAULT_SOCKET},fork,unlink-early,mode=666", "TCP:app:80"]
#     volumes:
#       - ${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}
#     depends_on:
#       - app
#     healthcheck:
#       test: ["CMD", "test", "-S", "${KITSHN_DEFAULT_SOCKET}"]
#
# Keep proxy-to-app traffic on the project-local default network. Attach services
# to an external network such as kitshn-edge only when other recipes must call them.
services: {}
"""


def _caddyfile_j2() -> str:
    return """# Define this recipe's public Caddy route here.
# Caddyfiles support comments with #.
#
# Preview-safe hostname example:
# {% if environment == "prod" -%}
# example.com
# {%- else -%}
# pr.{{ environment.removeprefix("pr-") }}.example.com
# {%- endif %} {
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
