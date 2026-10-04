from datetime import UTC, datetime, timedelta
from pathlib import Path
import json

import pytest

from kitshn.deploy import deploy_recipe, destroy_deployment
from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots
from kitshn.runner import CommandRunner
from kitshn.status_export import read_status, status_file, write_status

from test_deploy import DeployRunner, _live_deployment


def _deployment(tmp_path: Path) -> Deployment:
    roots = Roots(deployments=tmp_path / "d", params=tmp_path / "p", persistent=tmp_path / "s", logs=tmp_path / "l")
    return Deployment.create(Recipe.parse("owner/site"), "pr-4", roots)


def test_status_file_lives_under_the_kitshn_logs_root(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    assert status_file(deployment) == tmp_path / "l" / ".kitshn" / "status" / "owner" / "site" / "pr-4.json"


def test_a_failed_deploy_keeps_the_last_live_ref_and_url(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    now = datetime(2026, 10, 1, 12, tzinfo=UTC)

    write_status(deployment, "deploying", now=now)
    write_status(deployment, "live", ref="abc", url="https://pr.4.example.com", now=now)
    write_status(deployment, "deploying", now=now + timedelta(hours=1))
    write_status(deployment, "failed", now=now + timedelta(hours=1))

    record = read_status(status_file(deployment))
    assert record is not None
    assert (record["state"], record["ref"], record["url"]) == ("failed", "abc", "https://pr.4.example.com")
    assert record["deployed_at"] == "2026-10-01T12:00:00+00:00"
    assert record["deploys"] == ["2026-10-01T12:00:00+00:00"]


def test_deploy_history_keeps_sixty_days(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    start = datetime(2026, 8, 1, tzinfo=UTC)
    write_status(deployment, "live", ref="a", now=start)
    write_status(deployment, "live", ref="b", now=start + timedelta(days=61))

    record = read_status(status_file(deployment))
    assert record is not None and record["deploys"] == ["2026-10-01T00:00:00+00:00"]


def test_deploy_records_live_with_the_public_url_and_failure_records_failed(tmp_path: Path) -> None:
    deployment, params = _live_deployment(tmp_path)
    (deployment.deployment_root / "Caddyfile.j2").write_text(
        "site.example.com {\n    reverse_proxy unix//{{ paths.default_socket }}\n}\n", encoding="utf-8"
    )

    deploy_recipe("owner/site", params_file=params, ref="main", environment="prod", roots=deployment.roots, runner=DeployRunner("never"))
    record = read_status(status_file(deployment))
    assert record is not None
    assert (record["state"], record["ref"], record["url"]) == ("live", "abc123", "https://site.example.com")

    with pytest.raises(KitshnError):
        deploy_recipe("owner/site", params_file=params, ref="main", environment="prod", roots=deployment.roots, runner=DeployRunner("build"))
    record = read_status(status_file(deployment))
    assert record is not None and (record["state"], record["ref"]) == ("failed", "abc123")


def test_destroy_removes_the_status_and_dry_runs_write_none(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    write_status(deployment, "live", ref="abc")

    destroy_deployment("owner/site", environment="pr-4", roots=deployment.roots, runner=DeployRunner("never"))
    assert not status_file(deployment).exists()

    other = Deployment.create(Recipe.parse("owner/site"), "prod", deployment.roots)
    destroy_deployment("owner/site", environment="prod", roots=deployment.roots, runner=CommandRunner(dry_run=True))
    assert not status_file(other).parent.exists() or not status_file(other).exists()


def test_status_files_are_plain_json_readable_by_others(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    write_status(deployment, "deploying")

    path = status_file(deployment)
    assert oct(path.stat().st_mode & 0o777) == "0o644"
    assert json.loads(path.read_text(encoding="utf-8"))["recipe"] == "owner/site"


def test_a_corrupt_history_never_fails_a_live_write(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    path = status_file(deployment)
    path.parent.mkdir(parents=True)
    path.write_text('{"deploys": 7}', encoding="utf-8")

    write_status(deployment, "live", ref="abc")

    record = read_status(path)
    assert record is not None and len(record["deploys"]) == 1
