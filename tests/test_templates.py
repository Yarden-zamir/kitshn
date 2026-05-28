from kitshn.templates import available_templates, init_recipe


def test_available_templates_include_initial_set() -> None:
    assert set(available_templates()) == {"node-service", "settings-repo", "static-site", "worker"}


def test_init_recipe_renders_placeholders(tmp_path) -> None:
    created = init_recipe("Owner/my-app", template="settings-repo", target_dir=tmp_path)

    assert tmp_path / ".kitshn.yaml" in created
    assert (tmp_path / ".github" / "workflows" / "kitshn.yml").exists()
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "my-app Settings" in readme


def test_public_route_templates_gitignore_generated_caddyfile(tmp_path) -> None:
    init_recipe("Owner/my-app", template="node-service", target_dir=tmp_path)

    assert (tmp_path / "Caddyfile.j2").exists()
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == "Caddyfile\n"
