from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import json
from pathlib import Path
from typing import Any

from .models import Deployment, Roots


@dataclass(slots=True)
class InvocationLog:
    command: str
    status: str
    deployment: Deployment | None = None
    ref: str | None = None
    changed_services: list[str] = field(default_factory=list)
    triggered_by: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "command": self.command,
            "deployment": self.deployment.identity if self.deployment else None,
            "ref": self.ref,
            "compose_project": self.deployment.compose_project if self.deployment else None,
            "changed_services": self.changed_services,
            "triggered_by": self.triggered_by,
            "status": self.status,
        }
        payload.update(self.extra)
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def append_invocation_log(entry: InvocationLog, roots: Roots = Roots()) -> Path:
    roots.kitshn_logs.mkdir(parents=True, exist_ok=True)
    log_file = roots.kitshn_logs / "kitshn.log"
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(entry.as_json() + "\n")
    return log_file


def last_deploy_entry(deployment: Deployment) -> dict[str, Any] | None:
    log_file = deployment.roots.kitshn_logs / "kitshn.log"
    if not log_file.exists():
        return None

    latest: dict[str, Any] | None = None
    with log_file.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("command") == "deploy" and entry.get("deployment") == deployment.identity:
                latest = entry
    return latest
