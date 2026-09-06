"""Build and run a recipe's Compose file in a throwaway directory, locally or on the VPS.

Nothing here touches routing or real deployments: the socket, params, data, and log roots all
live under one temporary directory, and the Compose project name is unique per run.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any

from .compose import compose_command, compose_services, wait_for_healthchecks
from .errors import KitshnError
from .models import Deployment, Recipe, Roots
from .recipe_auth import github_recipe_or_none
from .remote import check_vps_reachable, run_on_vps
from .runner import CommandRunner

DEFAULT_HEALTH_TIMEOUT = 120
COMPOSE_FILE_NAMES = ("compose.yml", "compose.yaml")


@dataclass(frozen=True, slots=True)
class TryResult:
    deployment: Deployment
    compose_file: Path
    http_check: str | None
    kept: bool

    @property
    def curl_command(self) -> str:
        return f"curl --unix-socket {self.deployment.default_socket} http://localhost/"

    @property
    def cleanup_commands(self) -> list[str]:
        return [
            f"COMPOSE_FILE={self.compose_file} docker compose --project-name {self.deployment.compose_project} "
            f"--env-file {self.deployment.params_file} down --remove-orphans --volumes --rmi local",
            f"rm -rf {self.deployment.roots.deployments.parent}",
        ]


def find_compose_file(directory: Path) -> Path:
    for name in COMPOSE_FILE_NAMES:
        candidate = directory / name
        if candidate.is_file():
            return candidate.resolve()
    msg = (
        f"no compose.yml or compose.yaml in {directory}; kitshn try needs a Compose recipe "
        "(see kitshn init --docker or kitshn init --template static)"
    )
    raise KitshnError(msg)


def ensure_docker_running(runner: CommandRunner) -> None:
    result = runner.run(
        ["docker", "info", "--format", "{{.OperatingSystem}}"], capture=True, check=False
    )
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1:] or [f"exit {result.returncode}"]
        msg = (
            f"Docker is not running or not reachable: {detail[0]}. Start Docker, "
            "or pass --vps-host to try the recipe on the VPS instead"
        )
        raise KitshnError(msg)
    # Docker Desktop shares host directories through a file server that cannot carry Unix
    # sockets, so a container binding ${KITSHN_DEFAULT_SOCKET} under the temp root fails with
    # "operation not supported". Every routed recipe binds that socket. Revisit if Docker
    # Desktop gains socket support on bind mounts or if try gains a TCP-only mode.
    if "docker desktop" in result.stdout.lower():
        msg = (
            "Docker Desktop cannot bind Unix sockets on host bind mounts, which every routed "
            "recipe needs; use kitshn try --vps-host <ssh-target> instead"
        )
        raise KitshnError(msg)


def try_recipe(
    *,
    directory: Path,
    runner: CommandRunner,
    recipe_name: str | None = None,
    params_file: Path | None = None,
    path: str = "/",
    keep: bool = False,
    health_timeout: int = DEFAULT_HEALTH_TIMEOUT,
    temp_root: Path | None = None,
) -> TryResult:
    compose_file = find_compose_file(directory)
    if params_file is not None and not params_file.is_file():
        msg = f"params file does not exist: {params_file}"
        raise KitshnError(msg)
    ensure_docker_running(runner)
    recipe = Recipe.parse(recipe_name) if recipe_name else _local_recipe(directory, runner)

    root = temp_root or Path(tempfile.mkdtemp(prefix="kitshn-try-"))
    roots = Roots(
        deployments=root / "deployments",
        params=root / "params",
        persistent=root / "persistent",
        logs=root / "logs",
    )
    deployment = Deployment.create(recipe, f"try-{os.getpid()}", roots)
    for directory_path in (
        deployment.deployment_root,
        deployment.params_root,
        deployment.persistent_root,
        deployment.logs_root,
        deployment.socket_root,
    ):
        directory_path.mkdir(parents=True, exist_ok=True)
    if params_file is not None:
        shutil.copyfile(params_file, deployment.params_file)
    else:
        deployment.params_file.write_text("", encoding="utf-8")
    deployment.params_file.chmod(0o600)

    # Compose helpers run in the deployment root, which has no compose file. COMPOSE_FILE makes
    # Compose load the recipe's file from there and resolve build contexts against its directory.
    os.environ["COMPOSE_FILE"] = str(compose_file)

    print(f"compose_project={deployment.compose_project}")
    print(f"socket={deployment.default_socket}")
    try:
        services = compose_services(_render_config(deployment, runner))
        if not services:
            msg = f"{compose_file} defines no services"
            raise KitshnError(msg)
        runner.run(
            compose_command(deployment, "up", "-d", "--build", "--force-recreate"),
            cwd=deployment.deployment_root,
            env=deployment.runtime_env,
        )
        wait_for_healthchecks(deployment, services, runner, timeout_seconds=health_timeout)
        _wait_for_socket(deployment.default_socket, health_timeout)
        http_check = _http_check(deployment.default_socket, path, runner)
        result = TryResult(deployment=deployment, compose_file=compose_file, http_check=http_check, kept=keep)
        if http_check is None or not http_check.startswith("2"):
            _print_recent_logs(deployment, runner)
        return result
    except Exception:
        _print_recent_logs(deployment, runner)
        raise
    finally:
        if keep:
            print("kept=true")
        else:
            _cleanup(deployment, root, runner)


def try_on_vps(
    *,
    directory: Path,
    vps_host: str,
    runner: CommandRunner,
    recipe_name: str | None = None,
    params_file: Path | None = None,
    path: str = "/",
    keep: bool = False,
    health_timeout: int = DEFAULT_HEALTH_TIMEOUT,
) -> int:
    """Copy the recipe to a throwaway directory on the VPS and run `kitshn try` there."""

    find_compose_file(directory)
    if params_file is not None and not params_file.is_file():
        msg = f"params file does not exist: {params_file}"
        raise KitshnError(msg)
    if not runner.exists("rsync"):
        msg = "rsync is required to try a recipe on the VPS; install rsync locally"
        raise KitshnError(msg)
    check_vps_reachable(vps_host, runner)
    # The copy on the VPS has no .git, so resolve the recipe name here and pass it along.
    recipe = Recipe.parse(recipe_name) if recipe_name else _local_recipe(directory, runner)

    remote_root = f"/tmp/kitshn-try-{_slug(directory.resolve().name)}-{os.getpid()}"
    remote_src = f"{remote_root}/src"
    print("⚠️  this builds and runs the recipe on the production host " + vps_host)
    print("⚠️  Docker images, containers, networks, and volumes are created there")
    print(f"⚠️  cleanup removes the containers, anonymous volumes, locally built images, and {remote_root}")
    print("⚠️  pulled base images stay in the VPS image cache")
    print(f"remote_dir={remote_root}")

    runner.run(["ssh", vps_host, f"umask 077 && mkdir -p {remote_src}"])
    try:
        runner.run(
            [
                "rsync",
                "--archive",
                "--delete",
                "--exclude",
                ".git",
                "--filter=:- .gitignore",
                f"{directory.resolve()}/",
                f"{vps_host}:{remote_src}/",
            ]
        )
        remote_args = [
            "try",
            "--directory",
            remote_src,
            "--recipe",
            recipe.full_name,
            "--path",
            path,
            "--health-timeout",
            str(health_timeout),
        ]
        if params_file is not None:
            remote_params = f"{remote_root}/params.env"
            runner.run(["scp", str(params_file), f"{vps_host}:{remote_params}"])
            runner.run(["ssh", vps_host, f"chmod 600 {remote_params}"])
            remote_args.extend(["--params-file", remote_params])
        if keep:
            remote_args.append("--keep")
        return run_on_vps(vps_host, remote_args, runner).returncode
    finally:
        if keep:
            print(f"kept={remote_root} (remove it with: ssh {vps_host} rm -rf {remote_root})")
        else:
            runner.run(["ssh", vps_host, f"rm -rf {remote_root}"], check=False)


def _local_recipe(directory: Path, runner: CommandRunner) -> Recipe:
    return github_recipe_or_none(directory, runner) or Recipe("local", _slug(directory.resolve().name))


def _slug(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char == "-" else "-" for char in value.lower())
    return cleaned.strip("-") or "recipe"


def _render_config(deployment: Deployment, runner: CommandRunner) -> dict[str, Any]:
    result = runner.run(
        compose_command(deployment, "config", "--format", "json"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        capture=True,
    )
    try:
        config = json.loads(result.stdout) if result.stdout.strip() else {}
    except json.JSONDecodeError as error:
        msg = "docker compose config did not return valid JSON"
        raise KitshnError(msg) from error
    if not isinstance(config, dict):
        msg = "docker compose config JSON must be an object"
        raise KitshnError(msg)
    return config


def _wait_for_socket(socket_path: Path, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if socket_path.exists():
            return
        time.sleep(1)
    msg = f"timed out after {timeout_seconds}s waiting for the app to create {socket_path}"
    raise KitshnError(msg)


def _http_check(socket_path: Path, path: str, runner: CommandRunner) -> str | None:
    if not runner.exists("curl"):
        print("ℹ️  curl not found; skipping HTTP check")
        return None
    url = "http://localhost" + (path if path.startswith("/") else f"/{path}")
    result = runner.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "--unix-socket",
            str(socket_path),
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code} %{content_type}",
            url,
        ],
        capture=True,
        check=False,
    )
    if result.returncode != 0:
        return f"curl failed: {result.stderr.strip() or result.returncode}"
    return result.stdout.strip()


def _print_recent_logs(deployment: Deployment, runner: CommandRunner) -> None:
    runner.run(
        compose_command(deployment, "logs", "--no-color", "--tail", "50"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        check=False,
    )


def _cleanup(deployment: Deployment, root: Path, runner: CommandRunner) -> None:
    runner.run(
        compose_command(deployment, "down", "--remove-orphans", "--volumes", "--rmi", "local"),
        cwd=deployment.deployment_root,
        env=deployment.runtime_env,
        check=False,
    )
    shutil.rmtree(root, ignore_errors=True)
    print(f"cleaned={root}")
