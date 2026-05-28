from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any, Literal

from .caddy import apply_caddyfile, read_active_caddyfile, render_caddyfile
from .compose import (
    apply_compose,
    compose_down,
    compose_service_status,
    has_compose_file,
    recreate_dependent_services,
)
from .filesystem import (
    atomic_copy_params,
    ensure_deployment_paths,
    remove_tree,
    roots_from_env,
    walk_deployments,
)
from .git_ops import checkout_recipe
from .models import Deployment, Recipe, Roots
from .runner import CommandRunner
from .structured_log import last_deploy_entry


@dataclass(frozen=True, slots=True)
class DeployResult:
    deployment: Deployment
    previous_ref: str | None
    ref: str
    changed_services: list[str] = field(default_factory=list)
    caddy_reloaded: bool = False


def deploy_recipe(
    recipe_name: str,
    *,
    params_file: Path,
    ref: str | None,
    environment: str,
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> DeployResult:
    runner = runner or CommandRunner()
    roots = roots or roots_from_env()
    deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)

    ensure_deployment_paths(deployment)
    previous_caddy = read_active_caddyfile(deployment)
    if deployment.generated_caddyfile.exists():
        deployment.generated_caddyfile.unlink()
    previous_ref, checked_out_ref = checkout_recipe(deployment, ref, runner)
    atomic_copy_params(params_file, deployment)
    changed_services = apply_compose(deployment, runner)
    changed_services.extend(
        recreate_dependent_services(deployment.recipe, deployment, deployment.roots, runner)
    )
    rendered_caddy = render_caddyfile(deployment)
    caddy_reloaded = apply_caddyfile(deployment, rendered_caddy, runner, previous_active=previous_caddy)

    return DeployResult(
        deployment=deployment,
        previous_ref=previous_ref,
        ref=checked_out_ref,
        changed_services=changed_services,
        caddy_reloaded=caddy_reloaded,
    )


def destroy_deployment(
    recipe_name: str,
    *,
    environment: str,
    purge: bool = False,
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> Deployment:
    runner = runner or CommandRunner()
    roots = roots or roots_from_env()
    deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)

    compose_down(deployment, runner)
    previous_caddy = read_active_caddyfile(deployment)
    apply_caddyfile(deployment, None, runner, previous_active=previous_caddy)
    remove_tree(deployment.deployment_root)
    remove_tree(deployment.params_root)
    if purge:
        remove_tree(deployment.persistent_root)
        remove_tree(deployment.logs_root)
    return deployment


def set_deployment_state(
    recipe_name: str,
    *,
    environment: str,
    action: Literal["start", "stop", "restart"],
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> Deployment:
    runner = runner or CommandRunner()
    roots = roots or roots_from_env()
    deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)
    if not has_compose_file(deployment):
        return deployment

    from .compose import compose_command

    runner.run(
        compose_command(deployment, action),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
    )
    return deployment


def deployment_status(
    deployment: Deployment, runner: CommandRunner | None = None
) -> dict[str, Any]:
    runner = runner or CommandRunner()
    ref = None
    if (deployment.deployment_root / ".git").exists():
        result = runner.run(
            ["git", "rev-parse", "HEAD"],
            cwd=deployment.deployment_root,
            capture=True,
            check=False,
        )
        if result.returncode == 0:
            ref = result.stdout.strip() or None

    return {
        "deployment": deployment.identity,
        "recipe": deployment.recipe.full_name,
        "environment": deployment.environment,
        "path": str(deployment.deployment_root),
        "ref": ref,
        "compose_project": deployment.compose_project,
        "services": compose_service_status(deployment, runner),
        "caddy_route": deployment.generated_caddyfile.exists(),
        "last_deploy": last_deploy_entry(deployment),
    }


def status_entries(
    recipe_name: str | None,
    *,
    environment: str | None,
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> list[dict[str, Any]]:
    roots = roots or roots_from_env()
    runner = runner or CommandRunner()
    if recipe_name and environment:
        deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)
        return [deployment_status(deployment, runner)]

    recipe = Recipe.parse(recipe_name) if recipe_name else None
    entries = []
    for deployment in walk_deployments(roots):
        if recipe and deployment.recipe != recipe:
            continue
        if environment and deployment.environment != environment:
            continue
        entries.append(deployment_status(deployment, runner))
    return entries


def affected_deployments(
    recipe_name: str,
    *,
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> list[str]:
    roots = roots or roots_from_env()
    runner = runner or CommandRunner()
    recipe = Recipe.parse(recipe_name)
    affected: list[str] = []
    from .compose import compose_services, render_compose_config

    for deployment in walk_deployments(roots):
        if not has_compose_file(deployment) or not deployment.params_file.exists():
            continue
        services = compose_services(render_compose_config(deployment, runner))
        for service in services:
            depends_on = service.labels.get("kitshn.depends_on", "")
            if recipe.normalized_full_name in [
                part.strip().lower() for part in depends_on.split(",") if part.strip()
            ]:
                affected.append(f"{deployment.identity}:{service.name}")
    return affected


def status_json(entries: list[dict[str, Any]]) -> str:
    return json.dumps(entries, indent=2, sort_keys=True)
