from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import time

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


DEPLOY_LOCK_NAME = ".kitshn-deploy.lock"
# A deploy that hangs past this holds up every other recipe on the host. Raise it if a
# recipe's image build legitimately takes longer.
DEPLOY_LOCK_TIMEOUT_SECONDS = 1800


@contextmanager
def host_deploy_lock(roots: Roots, holder: str, *, timeout_seconds: float | None = None) -> Iterator[None]:
    """Serialize deploys and destroys of all recipes on one host.

    Deploys of different recipes share the Caddy manifest and the Caddy reload, and a deploy
    recreates dependent services in other deployments. CI concurrency groups are per
    deployment, so only a host-wide lock keeps two recipes from racing on those.
    """

    timeout = DEPLOY_LOCK_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    lock_path = roots.deployments / DEPLOY_LOCK_NAME
    roots.deployments.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    except PermissionError as error:
        owner = lock_path.owner() if lock_path.exists() else "unknown"
        msg = f"cannot open the host deploy lock {lock_path} (owner {owner}); run every deploy as the same user"
        raise KitshnError(msg) from error
    with os.fdopen(fd, "r+", encoding="utf-8") as handle:
        deadline = time.monotonic() + timeout
        next_notice = 0.0
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                handle.seek(0)
                current = handle.read().strip() or "another deploy"
                if time.monotonic() >= deadline:
                    msg = f"timed out after {timeout:g}s waiting for the host deploy lock held by {current}"
                    raise KitshnError(msg) from None
                # A regular notice doubles as a liveness probe: when the GitHub job is cancelled,
                # the SSH pipe closes and this print raises BrokenPipeError before the lock is
                # taken, so an abandoned waiter never deploys later.
                if time.monotonic() >= next_notice:
                    print(f"waiting for the host deploy lock held by {current}", file=sys.stderr, flush=True)
                    next_notice = time.monotonic() + 20
                time.sleep(1)
        handle.seek(0)
        handle.truncate()
        handle.write(f"{holder} (pid {os.getpid()})\n")
        handle.flush()
        try:
            yield
        finally:
            handle.seek(0)
            handle.truncate()
            fcntl.flock(handle, fcntl.LOCK_UN)


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


def remove_except(root: Path, keep: Iterable[PurePosixPath], remove: Callable[[Path], None]) -> None:
    """Remove everything under `root` except the `keep` paths, which are relative to `root`.

    An empty relative path keeps `root` whole. `remove` deletes one path, so a dry run can print
    instead of deleting.
    """

    kept = [path.parts for path in keep]
    if not root.exists() or () in kept:
        return
    for child in sorted(root.iterdir()):
        below = [parts[1:] for parts in kept if parts and parts[0] == child.name]
        if () in below:
            continue
        if below and child.is_dir() and not child.is_symlink():
            remove_except(child, [PurePosixPath(*parts) for parts in below], remove)
        else:
            remove(child)


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
    # ci.write_params_from_github writes values with json.dumps, so double-quoted
    # values must be JSON-decoded to recover embedded quotes and backslashes.
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
        return decoded if isinstance(decoded, str) else value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    return value
