from pathlib import Path

import pytest

from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots, sanitize_environment_name


def test_sanitize_environment_name_matches_spec() -> None:
    assert sanitize_environment_name("PR_42!!Feature") == "pr-42-feature"
    assert sanitize_environment_name("---A---B---") == "a-b"
    assert len(sanitize_environment_name("a" * 80)) == 63


def test_sanitize_environment_name_rejects_empty_result() -> None:
    with pytest.raises(KitshnError):
        sanitize_environment_name("!!!")


def test_recipe_parse_requires_fully_qualified_name() -> None:
    assert Recipe.parse("Owner/repo").remote_url == "https://github.com/Owner/repo.git"
    with pytest.raises(KitshnError):
        Recipe.parse("repo")


def test_deployment_paths_use_owner_repo_environment_order(tmp_path: Path) -> None:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    deployment = Deployment.create(Recipe.parse("owner/repo"), "Prod", roots)

    assert deployment.identity == "owner/repo/prod"
    assert deployment.deployment_root == tmp_path / "deployments" / "owner" / "repo" / "prod"
    assert deployment.params_file == tmp_path / "params" / "owner" / "repo" / "prod" / "params.env"
    assert deployment.runtime_env["KITSHN_DATA_DIR"] == str(
        tmp_path / "persistent" / "owner" / "repo" / "prod"
    )


def test_compose_project_is_deployment_scoped() -> None:
    left = Deployment.create(Recipe.parse("owner-a/app"), "prod").compose_project
    right = Deployment.create(Recipe.parse("owner-b/app"), "prod").compose_project

    assert left != right
    assert left == "owner-a-app-prod"
    assert len(left) <= 63


def test_recipe_normalized_name_is_case_insensitive() -> None:
    assert Recipe.parse("Owner/Repo").normalized_full_name == "owner/repo"
