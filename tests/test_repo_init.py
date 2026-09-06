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
        if command == ("ssh", "-G", "prod-vps"):
            return CommandResult(
                args=args,
                returncode=0,
                stdout="user deploy\nhostname vps.example.com\n",
                stderr="",
            )
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
    assert "# Direct Unix socket example" in compose
    assert "# Socket proxy sidecar, only for images that cannot bind a Unix socket" in compose
    assert "#   app:" in compose
    assert "alpine/socat" in compose
    assert "#       - kitshn-edge" not in compose
    assert "services: {}" in compose
    assert "# Caddyfiles support comments with #." in caddyfile
    assert "# Preview-safe hostname example:" in caddyfile
    assert 'environment == "prod"' in caddyfile
    assert 'pr.{{ environment.removeprefix("pr-") }}.example.com' in caddyfile
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
        vps_host="prod-vps",
        key_path=key_path,
    )

    assert result.vps_host == "deploy@vps.example.com"
    assert result.authorized_via_ssh is True
    assert ("ssh", "-G", "prod-vps") in runner.commands
    assert any(command[:2] == ("ssh", "prod-vps") for command in runner.commands)
    assert runner.commands[-1] == (
        "gh",
        "variable",
        "set",
        "KITSHN_VPS_HOST",
        "--repo",
        "Owner/my-app",
        "--body",
        "deploy@vps.example.com",
    )


def test_init_static_template_writes_a_complete_caddy_socket_recipe(tmp_path: Path) -> None:
    result = init_recipe_repo(
        target_dir=tmp_path, runner=RecordingRunner(), template="static", hostname="site.example.com"
    )

    names = [path.relative_to(tmp_path).as_posix() for path in result.created_files]
    assert names == [
        ".kitshn.yaml",
        ".github/workflows/kitshn.yml",
        "kitshn.md",
        "Dockerfile",
        "container/Caddyfile",
        "compose.yml",
        "Caddyfile.j2",
        ".dockerignore",
        ".gitignore",
    ]
    container_caddyfile = (tmp_path / "container" / "Caddyfile").read_text(encoding="utf-8")
    assert "bind unix/{$KITSHN_DEFAULT_SOCKET}|0666" in container_caddyfile
    assert "encode zstd gzip {\n\t\tmatch {\n\t\t\theader Content-Type text/*" in container_caddyfile
    assert "stale socket" in container_caddyfile
    assert "socat" not in (tmp_path / "compose.yml").read_text(encoding="utf-8")
    compose = (tmp_path / "compose.yml").read_text(encoding="utf-8")
    assert "${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}" in compose
    assert 'test: ["CMD", "test", "-S", "${KITSHN_DEFAULT_SOCKET}"]' in compose
    caddyfile = (tmp_path / "Caddyfile.j2").read_text(encoding="utf-8")
    assert "site.example.com" in caddyfile and 'pr.{{ environment.removeprefix("pr-") }}.site.example.com' in caddyfile
    assert (tmp_path / "Dockerfile").read_text(encoding="utf-8") == "FROM caddy:2-alpine\n\nCOPY container/Caddyfile /etc/caddy/Caddyfile\nCOPY site /srv\n"
    assert result.checklist[0] == "put the files to serve under site/"
    assert not any("example.com in Caddyfile.j2" in step for step in result.checklist)


def test_init_static_template_defaults_flag_the_placeholder_hostname(tmp_path: Path) -> None:
    result = init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner(), template="static")

    assert "example.com" in (tmp_path / "Caddyfile.j2").read_text(encoding="utf-8")
    assert result.checklist[1] == "replace example.com in Caddyfile.j2 with the public hostname"


def test_init_template_rejects_conflicting_flags(tmp_path: Path) -> None:
    with pytest.raises(KitshnError, match="drop --docker and --routing"):
        init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner(), template="static", docker=True)
    with pytest.raises(KitshnError, match="only apply with --template static"):
        init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner(), hostname="x.example.com")


def test_init_checklist_orders_recipe_auth_before_push_and_footer_is_documented(tmp_path: Path) -> None:
    result = init_recipe_repo(target_dir=tmp_path, runner=RecordingRunner())

    steps = " | ".join(result.checklist)
    assert steps.index("gh repo create") < steps.index("kitshn recipe auth") < steps.index("git push") < steps.index("kitshn track")
    kitshn_md = (tmp_path / "kitshn.md").read_text(encoding="utf-8")
    assert "keep the Origin section" in kitshn_md
    assert kitshn_md.rstrip().endswith("KitSHn commit: `abc123`")
