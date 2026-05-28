from pathlib import Path

from kitshn.caddy import render_caddyfile
from kitshn.models import Deployment, Recipe, Roots


def test_caddy_render_receives_full_params_file(tmp_path: Path) -> None:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    deployment = Deployment.create(Recipe.parse("owner/repo"), "prod", roots)
    deployment.deployment_root.mkdir(parents=True)
    deployment.params_root.mkdir(parents=True)
    deployment.params_file.write_text('DOMAIN="example.com"\nTOKEN="secret"\n', encoding="utf-8")
    (deployment.deployment_root / "Caddyfile.j2").write_text(
        "{{ params.DOMAIN }} {\n    header X-Token {{ params.TOKEN }}\n}\n",
        encoding="utf-8",
    )

    assert render_caddyfile(deployment) == "example.com {\n    header X-Token secret\n}\n"


def test_caddy_render_ignores_generated_caddyfile_artifact(tmp_path: Path) -> None:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    deployment = Deployment.create(Recipe.parse("owner/repo"), "prod", roots)
    deployment.deployment_root.mkdir(parents=True)
    deployment.params_root.mkdir(parents=True)
    deployment.params_file.write_text("", encoding="utf-8")
    (deployment.deployment_root / "Caddyfile").write_text("example.com\n", encoding="utf-8")

    assert render_caddyfile(deployment) is None
