from pathlib import Path

import pytest

from kitshn.errors import NoMatchingDeployment
from kitshn.resolve import ResolveInput, resolve_deployment


def write_config(tmp_path: Path, content: str) -> Path:
    path = tmp_path / ".kitshn.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_resolve_push_handles_unquoted_yaml_on_key(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
deploy:
  - on: push
    branch: main
    name: Prod
""",
    )

    result = resolve_deployment(config, ResolveInput(event="push", branch="main", sha="abcdef123"))

    assert result.github_output_lines() == ["env=prod", "action=deploy", "ephemeral=false"]


def test_resolve_first_match_wins(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
deploy:
  - on: push
    branch: "dev*"
    name: "feature-{branch}"
  - on: push
    branch: "dev-branch"
    name: ignored
""",
    )

    result = resolve_deployment(config, ResolveInput(event="push", branch="dev-branch"))

    assert result.env == "feature-dev-branch"


def test_resolve_pull_request_closed_destroys_ephemeral_env(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
deploy:
  - on: pull_request
    name: pr-{pr}
    ephemeral: true
""",
    )

    result = resolve_deployment(
        config, ResolveInput(event="pull_request", branch="feature", pr=42, pr_action="closed")
    )

    assert result.env == "pr-42"
    assert result.action == "destroy"
    assert result.ephemeral is True


def test_resolve_workflow_dispatch_uses_manual_environment(tmp_path: Path) -> None:
    config = write_config(tmp_path, "deploy: []\n")

    result = resolve_deployment(
        config, ResolveInput(event="workflow_dispatch", environment="Manual_ENV")
    )

    assert result.env == "manual-env"


def test_resolve_no_match_raises_without_output(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
deploy:
  - on: push
    branch: main
    name: prod
""",
    )

    with pytest.raises(NoMatchingDeployment):
        resolve_deployment(config, ResolveInput(event="push", branch="dev"))
