from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatchcase
import json
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import yaml

from .errors import KitshnError, NoMatchingDeployment
from .models import KEEP_ROOTS, sanitize_environment_name

DeployEvent = Literal["push", "pull_request", "workflow_dispatch"]


@dataclass(frozen=True, slots=True)
class ResolveInput:
    event: DeployEvent
    branch: str | None = None
    pr: int | None = None
    sha: str | None = None
    environment: str | None = None
    pr_action: str | None = None


@dataclass(frozen=True, slots=True)
class ResolveResult:
    env: str
    action: Literal["deploy", "destroy"]
    ephemeral: bool
    # Paths a teardown keeps, relative to the environment's data folders. None keeps all.
    keep: tuple[str, ...] | None = None

    def github_output_lines(self) -> list[str]:
        return [
            f"env={self.env}",
            f"action={self.action}",
            f"ephemeral={str(self.ephemeral).lower()}",
            f"keep={keep_output(self.keep)}",
        ]


def keep_output(keep: tuple[str, ...] | None) -> str:
    """`keep` as one output line: empty when unset, else a JSON list."""

    return "" if keep is None else json.dumps(list(keep))


def parse_keep(value: object) -> tuple[str, ...] | None:
    """Validate a `keep` list: paths such as `logs` or `persistent/uploads`.

    Each path starts with a data folder that KitSHn keeps per environment, has no `..`, and is
    not absolute. Anything else fails, so a typo does not delete data the author meant to keep.
    """

    if value is None:
        return None
    shape = "keep must be a list of paths, such as [logs, persistent/uploads]"
    if not isinstance(value, list):
        raise KitshnError(shape)
    paths: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise KitshnError(shape)
        parts = PurePosixPath(item).parts
        if not parts or item.startswith("/") or ".." in parts or parts[0] not in KEEP_ROOTS:
            roots = ", ".join(KEEP_ROOTS)
            msg = f"keep path {item!r} must start with one of {roots} and stay inside it"
            raise KitshnError(msg)
        paths.append(PurePosixPath(*parts).as_posix())
    return tuple(paths)


def load_deploy_entries(config_path: Path) -> list[dict[str, Any]]:
    if not config_path.exists():
        msg = f"missing KitSHn config: {config_path}"
        raise KitshnError(msg)

    with config_path.open(encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle) or {}

    if not isinstance(loaded, dict):
        msg = f"{config_path} must contain a mapping"
        raise KitshnError(msg)
    entries = loaded.get("deploy")
    if not isinstance(entries, list):
        msg = f"{config_path} must contain deploy: [...]"
        raise KitshnError(msg)
    normalized_entries: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            msg = f"deploy entry {index} must be a mapping"
            raise KitshnError(msg)
        normalized_entries.append(_normalize_yaml_mapping(entry))
    return normalized_entries


def resolve_deployment(config_path: Path, event: ResolveInput) -> ResolveResult:
    if event.event == "workflow_dispatch":
        if not event.environment:
            raise NoMatchingDeployment
        return ResolveResult(
            env=sanitize_environment_name(event.environment), action="deploy", ephemeral=False
        )

    entries = load_deploy_entries(config_path)
    for entry in entries:
        if entry.get("on") != event.event:
            continue
        if event.event == "push" and not _push_entry_matches(entry, event):
            continue
        if event.event == "pull_request" and not _pull_request_entry_matches(entry, event):
            continue

        raw_name = entry.get("name")
        if not isinstance(raw_name, str) or not raw_name:
            msg = "matching deploy entry must include a non-empty name"
            raise KitshnError(msg)
        action = "destroy" if event.event == "pull_request" and event.pr_action == "closed" else "deploy"
        return ResolveResult(
            env=sanitize_environment_name(_format_environment(raw_name, event)),
            action=action,
            ephemeral=bool(entry.get("ephemeral", False)),
            keep=parse_keep(entry.get("keep")),
        )

    raise NoMatchingDeployment


def _push_entry_matches(entry: dict[str, Any], event: ResolveInput) -> bool:
    branch_glob = entry.get("branch")
    if not isinstance(branch_glob, str) or not branch_glob:
        msg = "push deploy entries require a non-empty branch glob"
        raise KitshnError(msg)
    return event.branch is not None and fnmatchcase(event.branch, branch_glob)


def _pull_request_entry_matches(entry: dict[str, Any], event: ResolveInput) -> bool:
    branch_glob = entry.get("branch")
    if branch_glob is None:
        return event.pr is not None
    if not isinstance(branch_glob, str) or not branch_glob:
        msg = "pull_request branch must be a non-empty glob when provided"
        raise KitshnError(msg)
    return event.branch is not None and fnmatchcase(event.branch, branch_glob)


def _format_environment(template: str, event: ResolveInput) -> str:
    values = {
        "branch": event.branch or "",
        "pr": "" if event.pr is None else str(event.pr),
        "sha7": (event.sha or "")[:7],
    }
    try:
        return template.format(**values)
    except KeyError as error:
        msg = f"unsupported environment template field: {error.args[0]}"
        raise KitshnError(msg) from error


def _normalize_yaml_mapping(entry: dict[Any, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in entry.items():
        # PyYAML still follows YAML 1.1 booleans, where an unquoted `on` key
        # parses as True. KitSHn config intentionally uses GitHub-style `on`.
        normalized_key = "on" if key is True else str(key)
        normalized[normalized_key] = value
    return normalized
