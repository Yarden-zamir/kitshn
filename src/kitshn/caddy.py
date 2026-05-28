from __future__ import annotations

from pathlib import Path
import os

from jinja2 import Environment, StrictUndefined

from .filesystem import read_env_file
from .models import Deployment
from .runner import CommandRunner

CADDY_BASE_CONFIG = Path("/etc/caddy/Caddyfile")


def render_caddyfile(deployment: Deployment) -> str | None:
    template_path = _template_path(deployment)
    if template_path is None:
        return None

    env = Environment(autoescape=False, undefined=StrictUndefined)
    template = env.from_string(template_path.read_text(encoding="utf-8"))
    rendered = template.render(
        recipe=deployment.recipe.full_name,
        environment=deployment.environment,
        deployment=deployment.identity,
        paths={
            "deployment": str(deployment.deployment_root),
            "params": str(deployment.params_root),
            "params_file": str(deployment.params_file),
            "persistent": str(deployment.persistent_root),
            "logs": str(deployment.logs_root),
        },
        params=read_env_file(deployment.params_file),
    )
    return rendered.rstrip() + "\n"


def read_active_caddyfile(deployment: Deployment) -> str | None:
    target = deployment.generated_caddyfile
    return target.read_text(encoding="utf-8") if target.exists() else None


def apply_caddyfile(
    deployment: Deployment,
    rendered: str | None,
    runner: CommandRunner,
    *,
    previous_active: str | None = None,
) -> bool:
    target = deployment.generated_caddyfile
    existing = read_active_caddyfile(deployment) if previous_active is None else previous_active
    if rendered == existing or (rendered is None and existing is None):
        return False

    try:
        if rendered is None:
            if target.exists():
                target.unlink()
        else:
            temp_path = target.with_name(f".Caddyfile.{os.getpid()}.tmp")
            temp_path.write_text(rendered, encoding="utf-8")
            os.replace(temp_path, target)

        validate_and_reload_caddy(runner)
    except Exception:
        if target.exists():
            target.unlink()
        if existing is not None:
            target.write_text(existing, encoding="utf-8")
        raise

    return True


def validate_and_reload_caddy(runner: CommandRunner) -> None:
    runner.run(["caddy", "validate", "--config", str(CADDY_BASE_CONFIG)])
    runner.run(["caddy", "reload", "--config", str(CADDY_BASE_CONFIG)])


def _template_path(deployment: Deployment) -> Path | None:
    caddyfile_j2 = deployment.deployment_root / "Caddyfile.j2"
    if caddyfile_j2.exists():
        return caddyfile_j2
    return None
