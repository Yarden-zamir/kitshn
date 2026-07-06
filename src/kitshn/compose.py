from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Iterable

from .errors import KitshnError
from .filesystem import roll_service_logs, walk_deployments
from .models import Deployment, Recipe, Roots
from .runner import CommandRunner


@dataclass(frozen=True, slots=True)
class ComposeService:
    name: str
    labels: dict[str, str]
    has_build: bool
    image: str | None
    pull_policy: str | None
    has_healthcheck: bool


def has_compose_file(deployment: Deployment) -> bool:
    return (deployment.deployment_root / "compose.yml").exists() or (
        deployment.deployment_root / "compose.yaml"
    ).exists()


def render_compose_config(deployment: Deployment, runner: CommandRunner) -> dict[str, Any]:
    if not has_compose_file(deployment):
        return {"services": {}}
    result = runner.run(
        compose_command(deployment, "config", "--format", "json"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        capture=True,
    )
    try:
        config = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        msg = "docker compose config did not return valid JSON"
        raise KitshnError(msg) from error
    if not isinstance(config, dict):
        msg = "docker compose config JSON must be an object"
        raise KitshnError(msg)
    return config


def compose_services(config: dict[str, Any]) -> list[ComposeService]:
    raw_services = config.get("services", {})
    if not isinstance(raw_services, dict):
        msg = "compose config services must be an object"
        raise KitshnError(msg)

    services: list[ComposeService] = []
    for name, raw_service in raw_services.items():
        if not isinstance(name, str) or not isinstance(raw_service, dict):
            msg = "compose service entries must be named objects"
            raise KitshnError(msg)
        services.append(
            ComposeService(
                name=name,
                labels=_labels_as_dict(raw_service.get("labels", {})),
                has_build="build" in raw_service,
                image=raw_service.get("image") if isinstance(raw_service.get("image"), str) else None,
                pull_policy=(
                    raw_service.get("pull_policy")
                    if isinstance(raw_service.get("pull_policy"), str)
                    else None
                ),
                has_healthcheck="healthcheck" in raw_service,
            )
        )
    return services


def apply_compose(deployment: Deployment, runner: CommandRunner) -> list[str]:
    config = render_compose_config(deployment, runner)
    services = compose_services(config)
    if not services:
        return []

    service_names = [service.name for service in services]
    external_services = [service for service in services if service.image and not service.has_build]
    build_services = [service for service in services if service.has_build]

    if external_services:
        runner.run(
            compose_command(deployment, "pull", "--ignore-buildable", *[s.name for s in external_services]),
            cwd=deployment.deployment_root,
            env=deployment.runtime_env,
        )
    if build_services:
        runner.run(
            compose_command(deployment, "build", *[s.name for s in build_services]),
            cwd=deployment.deployment_root,
            env=deployment.runtime_env,
        )

    roll_service_logs(deployment.logs_root, service_names)
    runner.run(
        compose_command(deployment, "up", "-d", "--remove-orphans", "--force-recreate"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
    )
    wait_for_healthchecks(deployment, services, runner)
    return service_names


def recreate_dependent_services(
    changed_recipe: Recipe, current: Deployment, roots: Roots, runner: CommandRunner
) -> list[str]:
    changed: list[str] = []
    for deployment in walk_deployments(roots):
        if deployment.identity == current.identity or not has_compose_file(deployment):
            continue
        if not deployment.params_file.exists():
            continue
        config = render_compose_config(deployment, runner)
        services = compose_services(config)
        dependent = [
            service for service in services if _depends_on_recipe(service, changed_recipe.full_name)
        ]
        if not dependent:
            continue
        names = [service.name for service in dependent]
        roll_service_logs(deployment.logs_root, names)
        runner.run(
            compose_command(deployment, "up", "-d", "--no-deps", "--force-recreate", *names),
            cwd=deployment.deployment_root,
            env=deployment.runtime_env,
        )
        wait_for_healthchecks(deployment, dependent, runner)
        changed.extend(f"{deployment.identity}:{name}" for name in names)
    return changed


def compose_down(deployment: Deployment, runner: CommandRunner) -> None:
    if not has_compose_file(deployment):
        return
    runner.run(
        compose_command(deployment, "down", "--remove-orphans"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
    )


def compose_service_status(deployment: Deployment, runner: CommandRunner) -> list[dict[str, Any]]:
    if not has_compose_file(deployment):
        return []
    result = runner.run(
        compose_command(deployment, "ps", "--format", "json"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        capture=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return []
    return _parse_compose_ps_json(result.stdout)


def wait_for_healthchecks(
    deployment: Deployment,
    services: Iterable[ComposeService],
    runner: CommandRunner,
    *,
    timeout_seconds: int = 120,
) -> None:
    healthchecked = [service for service in services if service.has_healthcheck]
    if not healthchecked:
        return

    deadline = time.monotonic() + timeout_seconds
    pending = {service.name for service in healthchecked}
    while pending and time.monotonic() < deadline:
        for service_name in list(pending):
            status = _service_health(deployment, service_name, runner)
            if status == "healthy":
                pending.remove(service_name)
            elif status == "unhealthy":
                msg = f"service became unhealthy: {deployment.identity}:{service_name}"
                raise KitshnError(msg)
        if pending:
            time.sleep(2)

    if pending:
        msg = "timed out waiting for healthy services: " + ", ".join(sorted(pending))
        raise KitshnError(msg)


def _service_health(deployment: Deployment, service_name: str, runner: CommandRunner) -> str | None:
    ps = runner.run(
        compose_command(deployment, "ps", "-q", service_name),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        capture=True,
    )
    container_ids = [line.strip() for line in ps.stdout.splitlines() if line.strip()]
    if not container_ids:
        msg = f"no container found for healthchecked service: {deployment.identity}:{service_name}"
        raise KitshnError(msg)
    inspect = runner.run(
        ["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", container_ids[0]],
        capture=True,
    )
    return inspect.stdout.strip() or None


def compose_command(deployment: Deployment, *args: str) -> list[str]:
    return [
        "docker",
        "compose",
        "--project-name",
        deployment.compose_project,
        "--env-file",
        str(deployment.params_file),
        *args,
    ]


def _labels_as_dict(raw_labels: Any) -> dict[str, str]:
    if isinstance(raw_labels, dict):
        return {str(key): str(value) for key, value in raw_labels.items()}
    if isinstance(raw_labels, list):
        labels: dict[str, str] = {}
        for raw_label in raw_labels:
            if not isinstance(raw_label, str) or "=" not in raw_label:
                continue
            key, value = raw_label.split("=", 1)
            labels[key] = value
        return labels
    if raw_labels in (None, []):
        return {}
    msg = "compose labels must be a mapping or list"
    raise KitshnError(msg)


def _depends_on_recipe(service: ComposeService, recipe_name: str) -> bool:
    raw = service.labels.get("kitshn.depends_on")
    if raw is None:
        return False
    normalized_recipe_name = recipe_name.lower()
    return normalized_recipe_name in [part.strip().lower() for part in raw.split(",") if part.strip()]


def _parse_compose_ps_json(output: str) -> list[dict[str, Any]]:
    stripped = output.strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = [json.loads(line) for line in stripped.splitlines() if line.strip()]
    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list) and all(isinstance(item, dict) for item in parsed):
        return parsed
    msg = "docker compose ps JSON had an unexpected shape"
    raise KitshnError(msg)
