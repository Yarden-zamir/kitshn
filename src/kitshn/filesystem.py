from __future__ import annotations

from datetime import UTC, datetime
import os
from pathlib import Path
import shutil
from typing import Iterable, Iterator

from .errors import KitshnError
from .models import Deployment, Roots


def roots_from_env() -> Roots:
    if base := os.environ.get("KITSHN_ROOT"):
        root = Path(base)
        return Roots(
            deployments=root / "deployments",
            params=root / "params",
            persistent=root / "persistent",
            logs=root / "logs",
        )
    return Roots()


def ensure_deployment_paths(deployment: Deployment) -> None:
    for path in (
        deployment.deployment_root,
        deployment.params_root,
        deployment.persistent_root,
        deployment.logs_root,
    ):
        path.mkdir(parents=True, exist_ok=True)

    logs_link = deployment.deployment_root / "logs"
    if logs_link.exists() or logs_link.is_symlink():
        if not logs_link.is_symlink() or logs_link.resolve() != deployment.logs_root:
            msg = f"{logs_link} exists and is not the KitSHn logs symlink"
            raise KitshnError(msg)
    else:
        logs_link.symlink_to(deployment.logs_root)


def reset_socket_paths(deployment: Deployment) -> None:
    remove_tree(deployment.socket_root)
    deployment.socket_root.mkdir(parents=True, exist_ok=True)


def atomic_copy_params(source: Path, deployment: Deployment) -> None:
    if not source.exists() or not source.is_file():
        msg = f"params file does not exist: {source}"
        raise KitshnError(msg)
    deployment.params_root.mkdir(parents=True, exist_ok=True)
    temp_path = deployment.params_root / f".params.env.{os.getpid()}.tmp"
    with source.open("rb") as src, temp_path.open("wb") as dst:
        shutil.copyfileobj(src, dst)
    temp_path.chmod(0o600)
    os.replace(temp_path, deployment.params_file)


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                msg = f"invalid env line in {path}:{line_number}: missing '='"
                raise KitshnError(msg)
            key, value = line.split("=", 1)
            key = key.strip()
            if not key:
                msg = f"invalid env line in {path}:{line_number}: empty key"
                raise KitshnError(msg)
            values[key] = _unquote_env_value(value.strip())
    return values


def remove_tree(path: Path) -> None:
    if path.exists() or path.is_symlink():
        if path.is_symlink() or path.is_file():
            path.unlink()
        else:
            shutil.rmtree(path)


def roll_service_logs(log_root: Path, service_names: Iterable[str]) -> list[Path]:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    rolled: list[Path] = []
    for service_name in service_names:
        service_dir = log_root / service_name
        if not service_dir.exists():
            continue
        if not service_dir.is_dir():
            msg = f"service log path is not a directory: {service_dir}"
            raise KitshnError(msg)
        for child in service_dir.iterdir():
            if child.is_file():
                target = child.with_name(f"{child.name}.{timestamp}")
                child.rename(target)
                rolled.append(target)
    return rolled


def walk_deployments(roots: Roots) -> Iterator[Deployment]:
    if not roots.deployments.exists():
        return
    for owner_dir in roots.deployments.iterdir():
        if not owner_dir.is_dir():
            continue
        for repo_dir in owner_dir.iterdir():
            if not repo_dir.is_dir():
                continue
            for env_dir in repo_dir.iterdir():
                if not env_dir.is_dir():
                    continue
                from .models import Recipe

                yield Deployment.create(Recipe(owner_dir.name, repo_dir.name), env_dir.name, roots)


def _unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value
