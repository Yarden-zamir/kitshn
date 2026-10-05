from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from kitshn import cli
from kitshn.errors import KitshnError

# main() reads sys.argv like the installed entry point does.
pytestmark = pytest.mark.filterwarnings("ignore:Cyclopts application invoked without tokens")


def _fail(*_args: object, **_kwargs: object) -> None:
    raise KitshnError("boom")


def _run_failed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, argv: list[str]) -> list[dict]:
    monkeypatch.setenv("KITSHN_ROOT", str(tmp_path))
    monkeypatch.setattr(cli, "deploy_recipe", _fail)
    monkeypatch.setattr(cli, "destroy_deployment", _fail)
    monkeypatch.setattr(sys, "argv", ["kitshn", *argv])

    assert cli.main() == 1

    log_file = tmp_path / "logs" / ".kitshn" / "kitshn.log"
    return [json.loads(line) for line in log_file.read_text().splitlines()]


def test_failed_deploy_logs_default_environment_deployment(monkeypatch, tmp_path) -> None:
    entries = _run_failed(
        monkeypatch, tmp_path, ["deploy", "Owner/repo", "--params-file", "secret.env"]
    )

    assert len(entries) == 1
    entry = entries[0]
    assert entry["command"] == "deploy"
    assert entry["status"] == "failed"
    assert entry["error"] == "boom"
    assert entry["deployment"] == "Owner/repo/prod"
    assert entry["compose_project"] is not None
    assert "secret.env" not in json.dumps(entry)


def test_failed_destroy_logs_named_environment_deployment(monkeypatch, tmp_path) -> None:
    entries = _run_failed(monkeypatch, tmp_path, ["destroy", "owner/repo", "--environment", "PR-7"])

    assert len(entries) == 1
    assert entries[0]["command"] == "destroy"
    assert entries[0]["deployment"] == "owner/repo/pr-7"


def test_failed_invocation_with_invalid_recipe_logs_no_deployment(monkeypatch, tmp_path) -> None:
    entries = _run_failed(monkeypatch, tmp_path, ["deploy", "not-a-recipe", "--params-file", "p.env"])

    assert len(entries) == 1
    assert entries[0]["status"] == "failed"
    assert entries[0]["deployment"] is None
