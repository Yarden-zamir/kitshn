from pathlib import Path
from collections.abc import Mapping, Sequence

from kitshn.runner import CommandResult, CommandRunner
from kitshn.seeding import seed_recipe
from kitshn.templates import available_templates, init_recipe


class RecordingRunner(CommandRunner):
    def __init__(self) -> None:
        super().__init__()
        self.commands: list[Sequence[str]] = []

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
    ) -> CommandResult:
        self.commands.append(args)
        if args[0] == "ssh-keygen":
            private_key = Path(args[args.index("-f") + 1])
            private_key.write_text("private-key\n", encoding="utf-8")
            Path(f"{private_key}.pub").write_text("public-key\n", encoding="utf-8")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def test_init_recipe_renders_placeholders(tmp_path) -> None:
    created = init_recipe("Owner/my-app", template="settings-repo", target_dir=tmp_path)

    assert tmp_path / ".kitshn.yaml" in created
    assert (tmp_path / ".github" / "workflows" / "kitshn.yml").exists()
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "my-app Settings" in readme


def test_available_templates_includes_bare() -> None:
    assert "bare" in available_templates()


def test_bare_template_contains_only_connection_essentials(tmp_path) -> None:
    created = init_recipe("Owner/my-app", template="bare", target_dir=tmp_path)

    assert created == [
        tmp_path / ".github" / "workflows" / "kitshn.yml",
        tmp_path / ".kitshn.yaml",
    ]


def test_public_route_templates_gitignore_generated_caddyfile(tmp_path) -> None:
    init_recipe("Owner/my-app", template="node-service", target_dir=tmp_path)

    assert (tmp_path / "Caddyfile.j2").exists()
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == "Caddyfile\n"


def test_seed_recipe_generates_key_and_sets_github_configuration(tmp_path) -> None:
    runner = RecordingRunner()
    key_path = tmp_path / "kitshn-key"

    result = seed_recipe(
        "Owner/my-app",
        template="bare",
        target_dir=tmp_path / "repo",
        vps_host="deploy@example.com",
        runner=runner,
        key_path=key_path,
        authorize_key=False,
    )

    assert result.private_key == key_path
    assert result.public_key == Path(f"{key_path}.pub")
    assert (tmp_path / "repo" / ".kitshn.yaml").exists()
    assert [command[0] for command in runner.commands] == ["ssh-keygen", "gh", "gh"]
    assert runner.commands[1] == [
        "gh",
        "secret",
        "set",
        "KITSHN_SSH_KEY",
        "--repo",
        "Owner/my-app",
        "--body-file",
        str(key_path),
    ]
    assert runner.commands[2] == [
        "gh",
        "variable",
        "set",
        "KITSHN_VPS_HOST",
        "--repo",
        "Owner/my-app",
        "--body",
        "deploy@example.com",
    ]
