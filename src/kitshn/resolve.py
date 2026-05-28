from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Literal

import yaml

from .errors import KitshnError, NoMatchingDeployment
from .models import sanitize_environment_name

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

    def github_output_lines(self) -> list[str]:
        return [
            f"env={self.env}",
            f"action={self.action}",
            f"ephemeral={str(self.ephemeral).lower()}",
        ]


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
