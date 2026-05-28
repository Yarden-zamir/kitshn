from __future__ import annotations

from pathlib import Path
import sys

from .compose import compose_command, has_compose_file
from .errors import KitshnError
from .filesystem import roots_from_env
from .models import Deployment, Recipe, Roots
from .runner import CommandRunner


def show_logs(
    recipe_name: str | None,
    service: str | None,
    *,
    environment: str,
    files: bool,
    follow: bool,
    roots: Roots | None = None,
    runner: CommandRunner | None = None,
) -> None:
    roots = roots or roots_from_env()
    runner = runner or CommandRunner()
    if recipe_name is None:
        log_file = roots.kitshn_logs / "kitshn.log"
        _show_file(log_file, follow=follow, runner=runner)
        return

    deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)
    if files:
        _show_file_logs(deployment.logs_root, service, follow=follow, runner=runner)
        return

    if not has_compose_file(deployment):
        msg = f"deployment has no compose file: {deployment.identity}"
        raise KitshnError(msg)
    args = ["logs"]
    if follow:
        args.append("--follow")
    if service:
        args.append(service)
    runner.run(compose_command(deployment, *args), cwd=deployment.deployment_root, env=deployment.runtime_env)


def _show_file_logs(root: Path, service: str | None, *, follow: bool, runner: CommandRunner) -> None:
    selected_root = root / service if service else root
    if selected_root.is_file():
        _show_file(selected_root, follow=follow, runner=runner)
        return
    if not selected_root.exists():
        msg = f"log path does not exist: {selected_root}"
        raise KitshnError(msg)
    files = sorted(path for path in selected_root.rglob("*") if path.is_file())
    if follow:
        if not files:
            msg = f"no log files to follow under {selected_root}"
            raise KitshnError(msg)
        runner.run(["tail", "-F", *[str(path) for path in files]])
        return

    for path in files:
        if len(files) > 1:
            print(f"==> {path} <==")
        sys.stdout.write(path.read_text(encoding="utf-8", errors="replace"))


def _show_file(path: Path, *, follow: bool, runner: CommandRunner) -> None:
    if follow:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        runner.run(["tail", "-F", str(path)])
        return
    if not path.exists():
        return
    sys.stdout.write(path.read_text(encoding="utf-8", errors="replace"))
