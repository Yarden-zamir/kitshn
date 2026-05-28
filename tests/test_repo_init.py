from pathlib import Path
from collections.abc import Mapping, Sequence

import pytest

from kitshn.errors import KitshnError
from kitshn.recipe_auth import authorize_recipe
from kitshn.repo_init import init_recipe_repo
from kitshn.runner import CommandResult, CommandRunner


class RecordingRunner(CommandRunner):
    def __init__(self) -> None:
        super().__init__()
        self.commands: list[tuple[str, ...]] = []

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
        input_text: str | None = None,
    ) -> CommandResult:
        command = tuple(args)
        self.commands.append(command)
        if command == ("git", "rev-parse", "HEAD"):
            return CommandResult(args=args, returncode=0, stdout="abc123\n", stderr="")
        if command[:4] == ("gh", "repo", "view", "--json"):
            return CommandResult(args=args, returncode=0, stdout="Owner/my-app\n", stderr="")
        if command[0] == "ssh-keygen":
            private_key = Path(command[command.index("-f") + 1])
            private_key.write_text("private-key\n", encoding="utf-8")
            Path(f"{private_key}.pub").write_text("public-key\n", encoding="utf-8")
        if command == ("hostname", "-f"):
            return CommandResult(args=args, returncode=0, stdout="vps.example.com\n", stderr="")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def test_init_recipe_repo_writes_required_contract_files(tmp_path: Path) -> None:
    result = init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner())

    assert result.source_commit == "abc123"
    assert result.created_files == [
        tmp_path / ".kitshn.yaml",
        tmp_path / ".github" / "workflows" / "kitshn.yml",
        tmp_path / "kitshn.md",
    ]
    assert (tmp_path / ".kitshn.yaml").read_text(encoding="utf-8") == (
        "deploy:\n"
        "  - on: push\n"
        "    branch: main\n"
        "    name: prod\n"
        "\n"
        "  - on: pull_request\n"
        "    name: pr-{pr}\n"
        "    ephemeral: true\n"
    )
    workflow = (tmp_path / ".github" / "workflows" / "kitshn.yml").read_text(encoding="utf-8")
    assert "permissions:\n  contents: read\n  deployments: write\n" in workflow
    kitshn_md = (tmp_path / "kitshn.md").read_text(encoding="utf-8")
    assert "This repository is a KitSHn recipe repo." in kitshn_md
    assert "Generated from: https://github.com/Yarden-zamir/kitshn/blob/abc123/src/kitshn/repo_init.py" in kitshn_md
    assert "KitSHn commit: `abc123`" in kitshn_md


def test_init_recipe_repo_adds_optional_docker_and_routing_files(tmp_path: Path) -> None:
    init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner(), docker=True, routing=True)

    compose = (tmp_path / "compose.yml").read_text(encoding="utf-8")
    caddyfile = (tmp_path / "Caddyfile.j2").read_text(encoding="utf-8")
    assert "# Example:" in compose
    assert "#   app:" in compose
    assert "services: {}" in compose
    assert "# Caddyfiles support comments with #." in caddyfile
    assert "# example.com {" in caddyfile
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == "Caddyfile\n"


def test_init_recipe_repo_refuses_to_overwrite_without_force(tmp_path: Path) -> None:
    (tmp_path / ".kitshn.yaml").write_text("existing\n", encoding="utf-8")

    with pytest.raises(KitshnError):
        init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner())


def test_recipe_auth_configures_local_authorized_key_and_github(tmp_path: Path) -> None:
    runner = RecordingRunner()
    authorized_keys = tmp_path / "authorized_keys"
    key_path = tmp_path / "kitshn-key"

    result = authorize_recipe(
        recipe_dir=tmp_path,
        runner=runner,
        key_path=key_path,
        authorized_keys=authorized_keys,
    )

    assert result.recipe.full_name == "Owner/my-app"
    assert result.private_key == key_path
    assert result.public_key == Path(f"{key_path}.pub")
    assert result.vps_host == "vps.example.com"
    assert result.authorized_via_ssh is False
    assert authorized_keys.read_text(encoding="utf-8") == "public-key\n"
    assert [command[0] for command in runner.commands] == ["gh", "ssh-keygen", "hostname", "gh", "gh"]
    assert runner.commands[-2] == (
        "gh",
        "secret",
        "set",
        "KITSHN_SSH_KEY",
        "--repo",
        "Owner/my-app",
    )
    assert runner.commands[-1] == (
        "gh",
        "variable",
        "set",
        "KITSHN_VPS_HOST",
        "--repo",
        "Owner/my-app",
        "--body",
        "vps.example.com",
    )


def test_recipe_auth_can_authorize_remote_vps_host(tmp_path: Path) -> None:
    runner = RecordingRunner()
    key_path = tmp_path / "kitshn-key"

    result = authorize_recipe(
        recipe_dir=tmp_path,
        runner=runner,
        vps_host="deploy@example.com",
        key_path=key_path,
    )

    assert result.vps_host == "deploy@example.com"
    assert result.authorized_via_ssh is True
    assert any(command[:2] == ("ssh", "deploy@example.com") for command in runner.commands)
    assert runner.commands[-1] == (
        "gh",
        "variable",
        "set",
        "KITSHN_VPS_HOST",
        "--repo",
        "Owner/my-app",
        "--body",
        "deploy@example.com",
    )
