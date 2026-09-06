from pathlib import Path
from collections.abc import Mapping, Sequence
import json

import pytest

from kitshn.errors import KitshnError
from kitshn.runner import CommandResult, CommandRunner
from kitshn.try_recipe import ensure_docker_running, find_compose_file, try_on_vps, try_recipe


class TryRunner(CommandRunner):
    def __init__(self, *, docker_up: bool = True, http: str = "200 text/html") -> None:
        super().__init__()
        self.docker_up = docker_up
        self.http = http
        self.commands: list[tuple[str, ...]] = []
        self.envs: list[Mapping[str, str] | None] = []

    def exists(self, executable: str) -> bool:
        return executable in {"curl", "rsync"}

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
        self.envs.append(env)
        ok = CommandResult(args=args, returncode=0, stdout="", stderr="")
        if command == ("docker", "info"):
            if self.docker_up:
                return ok
            return CommandResult(args=args, returncode=1, stdout="", stderr="Cannot connect to the Docker daemon")
        if command[:3] == ("gh", "repo", "view"):
            return CommandResult(args=args, returncode=0, stdout="Owner/site\n", stderr="")
        if command[-3:] == ("config", "--format", "json"):
            config = {"services": {"site": {"build": {"context": "."}, "healthcheck": {"test": ["CMD", "true"]}}}}
            return CommandResult(args=args, returncode=0, stdout=json.dumps(config), stderr="")
        if "up" in command and env is not None:
            Path(env["KITSHN_DEFAULT_SOCKET"]).write_bytes(b"")
            return ok
        if command[-3:-1] == ("ps", "-q"):
            return CommandResult(args=args, returncode=0, stdout="cid\n", stderr="")
        if command[:2] == ("docker", "inspect"):
            return CommandResult(args=args, returncode=0, stdout="healthy\n", stderr="")
        if command[0] == "curl":
            return CommandResult(args=args, returncode=0, stdout=self.http, stderr="")
        return ok


def test_find_compose_file_explains_what_try_needs(tmp_path: Path) -> None:
    with pytest.raises(KitshnError, match="no compose.yml or compose.yaml"):
        find_compose_file(tmp_path)
    (tmp_path / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    assert find_compose_file(tmp_path) == (tmp_path / "compose.yaml").resolve()


def test_ensure_docker_running_points_at_vps_fallback() -> None:
    with pytest.raises(KitshnError, match="Docker is not running.*--vps-host"):
        ensure_docker_running(TryRunner(docker_up=False))


def test_try_recipe_runs_compose_in_a_temp_root_and_cleans_up(tmp_path: Path, monkeypatch) -> None:
    recipe_dir = tmp_path / "recipe"
    recipe_dir.mkdir()
    (recipe_dir / "compose.yml").write_text("services:\n  site:\n    build: .\n", encoding="utf-8")
    temp_root = tmp_path / "try-root"
    runner = TryRunner()
    monkeypatch.delenv("COMPOSE_FILE", raising=False)

    result = try_recipe(directory=recipe_dir, runner=runner, temp_root=temp_root)

    assert result.http_check == "200 text/html"
    assert result.deployment.recipe.full_name == "Owner/site"
    assert result.deployment.roots.deployments == temp_root / "deployments"
    assert str(result.deployment.default_socket).startswith(str(temp_root))
    # Compose resolves the recipe file through COMPOSE_FILE while running in the temp root.
    assert Path(__import__("os").environ["COMPOSE_FILE"]) == (recipe_dir / "compose.yml").resolve()
    subcommands = [next(arg for arg in command[6:] if not arg.startswith("-")) for command in runner.commands if command[:2] == ("docker", "compose")]
    assert subcommands[:2] == ["config", "up"]
    assert subcommands[-1] == "down"
    down = next(command for command in runner.commands if "down" in command)
    assert ("--volumes", "--rmi", "local") == down[-3:]
    curl = next(command for command in runner.commands if command[0] == "curl")
    assert "--unix-socket" in curl and curl[-1] == "http://localhost/"
    assert not temp_root.exists()


def test_try_recipe_keep_skips_cleanup(tmp_path: Path, monkeypatch) -> None:
    recipe_dir = tmp_path / "recipe"
    recipe_dir.mkdir()
    (recipe_dir / "compose.yml").write_text("services:\n  site:\n    build: .\n", encoding="utf-8")
    temp_root = tmp_path / "try-root"
    runner = TryRunner()
    monkeypatch.delenv("COMPOSE_FILE", raising=False)

    result = try_recipe(directory=recipe_dir, runner=runner, temp_root=temp_root, keep=True)

    assert result.kept is True
    assert temp_root.exists()
    assert not any("down" in command for command in runner.commands)
    assert result.curl_command.startswith("curl --unix-socket ")
    assert result.cleanup_commands[0].startswith("COMPOSE_FILE=")


def test_try_on_vps_copies_then_runs_hosted_try_then_removes(tmp_path: Path) -> None:
    (tmp_path / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    runner = TryRunner()

    code = try_on_vps(directory=tmp_path, vps_host="deploy@vps", runner=runner, path="/health")

    assert code == 0
    kinds = [command[0] for command in runner.commands]
    assert kinds == ["ssh", "ssh", "rsync", "ssh", "ssh"]
    rsync = runner.commands[2]
    assert "--filter=:- .gitignore" in rsync and (".git" in rsync)
    assert rsync[-1].startswith("deploy@vps:/tmp/kitshn-try-")
    remote_try = runner.commands[3][-1]
    assert "kitshn try --directory /tmp/kitshn-try-" in remote_try
    assert "--path /health" in remote_try
    assert runner.commands[4][-1].startswith("rm -rf /tmp/kitshn-try-")
