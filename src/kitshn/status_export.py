"""Per-deployment status files for read-only consumers, such as the KitSHn badge server.

`deploy` and `destroy` keep one JSON file per deployment under
`<logs root>/.kitshn/status/<owner>/<repo>/<environment>.json`. A consumer mounts only that
folder, so it never sees recipe checkouts or params.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import sys
from typing import Any, Literal

from .models import Deployment

State = Literal["deploying", "live", "failed"]
HISTORY_DAYS = 60


def status_file(deployment: Deployment) -> Path:
    recipe = deployment.recipe
    return deployment.roots.kitshn_logs / "status" / recipe.owner / recipe.repo / f"{deployment.environment}.json"


def read_status(path: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def write_status(
    deployment: Deployment,
    state: State,
    *,
    ref: str | None = None,
    url: str | None = None,
    now: datetime | None = None,
) -> None:
    """Record a state change. A live deploy also records its ref, URL, and time.

    A failure to write only prints a warning: the status file must never fail a deploy.
    """

    moment = now or datetime.now(UTC)
    stamp = moment.isoformat(timespec="seconds")
    path = status_file(deployment)
    record = read_status(path) or {}
    record.update(
        deployment=deployment.identity,
        recipe=deployment.recipe.full_name,
        environment=deployment.environment,
        state=state,
        updated_at=stamp,
    )
    if state == "live":
        cutoff = moment - timedelta(days=HISTORY_DAYS)
        previous = record.get("deploys")
        items = previous if isinstance(previous, list) else []
        history = [item for item in items if (when := _parse(item)) is not None and when >= cutoff]
        record.update(ref=ref, url=url, deployed_at=stamp, deploys=[*history, stamp])
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temp.chmod(0o644)
        os.replace(temp, path)
    except OSError as error:
        print(f"warning: cannot write deployment status {path}: {error}", file=sys.stderr)


def remove_status(deployment: Deployment) -> None:
    try:
        status_file(deployment).unlink(missing_ok=True)
    except OSError as error:
        print(f"warning: cannot remove deployment status: {error}", file=sys.stderr)


def _parse(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
