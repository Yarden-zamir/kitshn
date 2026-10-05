"""Find and remove what removed environments of a recipe left on the host.

A teardown keeps data folders by default (see `keep` in specs/ci.md), and older teardowns left
volumes and images too. An environment counts as removed when its deployment folder is gone.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .filesystem import host_deploy_lock, remove_tree
from .models import Deployment, Recipe, Roots
from .runner import CommandRunner

PROJECT_LABEL = "com.docker.compose.project"


@dataclass(frozen=True, slots=True)
class Leftover:
    deployment: Deployment
    folders: tuple[Path, ...]
    volumes: tuple[str, ...]
    images: tuple[str, ...]

    @property
    def folder_bytes(self) -> int:
        return sum(_size(path) for path in self.folders)


def find_leftovers(recipe: Recipe, roots: Roots, runner: CommandRunner, environment: str | None = None) -> list[Leftover]:
    """Removed environments of `recipe` that still have folders, and their volumes and images.

    Docker leftovers are matched by the exact Compose project name of an environment found
    through its folders. A project name prefix would also match another recipe whose name
    starts the same way. So a removed environment with no folder left is not found; revisit if
    such leftovers show up.
    """

    names: set[str] = set()
    for root in (roots.persistent, roots.logs, roots.params):
        folder = root / recipe.owner / recipe.repo
        if folder.is_dir():
            names.update(child.name for child in folder.iterdir() if child.is_dir())
    if environment is not None:
        names &= {environment}
    volumes = _labelled(runner, ["docker", "volume", "ls", "--filter", f"label={PROJECT_LABEL}", "--format", f'{{{{.Name}}}}\t{{{{.Label "{PROJECT_LABEL}"}}}}'])
    leftovers: list[Leftover] = []
    for name in sorted(names):
        deployment = Deployment.create(recipe, name, roots)
        if deployment.deployment_root.exists():
            continue
        folders = tuple(path for path in (deployment.persistent_root, deployment.logs_root, deployment.params_root) if path.exists())
        project = deployment.compose_project
        leftovers.append(
            Leftover(
                deployment=deployment,
                folders=folders,
                volumes=tuple(item for item, owner in volumes if owner == project),
                images=_project_images(runner, project),
            )
        )
    return leftovers


def remove_leftovers(leftovers: list[Leftover], roots: Roots, runner: CommandRunner) -> None:
    """Delete the leftovers. Holds the host deploy lock, so a deploy cannot recreate one midway."""

    with host_deploy_lock(roots, "kitshn prune"):
        for leftover in leftovers:
            # Re-check under the lock: a deploy that finished meanwhile made it live again.
            if leftover.deployment.deployment_root.exists():
                continue
            if leftover.volumes:
                runner.run(["docker", "volume", "rm", *leftover.volumes])
            if leftover.images:
                runner.run(["docker", "image", "rm", *leftover.images])
            for path in leftover.folders:
                remove_tree(path)


def _project_images(runner: CommandRunner, project: str) -> tuple[str, ...]:
    """Image IDs of one Compose project, once each: a rebuilt preview also leaves untagged ones.

    `docker image ls --format` has no label field, so this filters on the exact label instead.
    """

    result = runner.run(["docker", "image", "ls", "-q", "--filter", f"label={PROJECT_LABEL}={project}"], capture=True)
    return tuple(dict.fromkeys(line.strip() for line in result.stdout.splitlines() if line.strip()))


def _labelled(runner: CommandRunner, args: list[str]) -> list[tuple[str, str]]:
    # A failed Docker call must stop prune, not look like "no leftovers".
    result = runner.run(args, capture=True)
    rows: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        item, _, owner = line.partition("\t")
        if item and owner:
            rows.append((item, owner))
    return rows


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(child.stat().st_size for child in path.rglob("*") if child.is_file() and not child.is_symlink())
