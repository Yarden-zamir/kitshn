from pathlib import Path

import pytest

from kitshn.caddy import apply_caddyfile, render_caddyfile
from kitshn.models import Deployment, Recipe, Roots
from kitshn.runner import CommandRunner


def test_caddy_render_receives_full_params_file(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    deployment.deployment_root.mkdir(parents=True)
    deployment.params_root.mkdir(parents=True)
    deployment.params_file.write_text('DOMAIN="example.com"\nTOKEN="secret"\n', encoding="utf-8")
    (deployment.deployment_root / "Caddyfile.j2").write_text(
        "{{ params.DOMAIN }} {\n    header X-Token {{ params.TOKEN }}\n}\n",
        encoding="utf-8",
    )

    assert render_caddyfile(deployment) == "example.com {\n    header X-Token secret\n}\n"


def test_caddy_render_ignores_generated_caddyfile_artifact(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    deployment.deployment_root.mkdir(parents=True)
    deployment.params_root.mkdir(parents=True)
    deployment.params_file.write_text("", encoding="utf-8")
    (deployment.deployment_root / "Caddyfile").write_text("example.com\n", encoding="utf-8")

    assert render_caddyfile(deployment) is None


def test_apply_caddyfile_mirrors_to_single_level_import_file(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)

    changed = apply_caddyfile(deployment, "example.com {\n}\n", CommandRunner(dry_run=True))

    assert changed is True
    assert deployment.generated_caddyfile.read_text(encoding="utf-8") == "example.com {\n}\n"
    assert deployment.caddy_import_file.read_text(encoding="utf-8") == "example.com {\n}\n"
    assert deployment.caddy_import_file == tmp_path / "deployments" / "_caddy" / "owner-repo-prod.Caddyfile"


def test_apply_caddyfile_restores_import_file_when_validation_fails(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    deployment.generated_caddyfile.parent.mkdir(parents=True)
    deployment.caddy_import_file.parent.mkdir(parents=True)
    deployment.generated_caddyfile.write_text("old\n", encoding="utf-8")
    deployment.caddy_import_file.write_text("old\n", encoding="utf-8")

    with pytest.raises(RuntimeError):
        apply_caddyfile(deployment, "new\n", FailingRunner(), previous_active="old\n")

    assert deployment.generated_caddyfile.read_text(encoding="utf-8") == "old\n"
    assert deployment.caddy_import_file.read_text(encoding="utf-8") == "old\n"


class FailingRunner(CommandRunner):
    def run(self, *args, **kwargs):
        raise RuntimeError("caddy validation failed")


def _deployment(tmp_path: Path) -> Deployment:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    return Deployment.create(Recipe.parse("owner/repo"), "prod", roots)
