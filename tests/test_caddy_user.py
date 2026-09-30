from pathlib import Path
from collections.abc import Mapping, Sequence
import os
import shutil
import tempfile

import pytest

import kitshn.caddy
from kitshn.caddy import caddy_validate_command, validate_and_reload_caddy
from kitshn.diagnose import unix_access_problem
from kitshn.runner import CommandResult, CommandRunner


class SystemdRunner(CommandRunner):
    def __init__(self, *, unit_user: str = "caddy", tools: frozenset[str] = frozenset({"systemctl", "runuser"})) -> None:
        super().__init__()
        self.unit_user = unit_user
        self.tools = tools
        self.commands: list[tuple[str, ...]] = []

    def exists(self, executable: str) -> bool:
        return executable in self.tools

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
        if command[:2] == ("systemctl", "show"):
            return CommandResult(args=args, returncode=0, stdout=self.unit_user + "\n", stderr="")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


VALIDATE = ["caddy", "validate", "--config", "/etc/caddy/Caddyfile"]


def test_root_validates_as_the_caddy_service_user(monkeypatch) -> None:
    monkeypatch.setattr(kitshn.caddy.os, "geteuid", lambda: 0)
    runner = SystemdRunner()

    validate_and_reload_caddy(runner)

    # A log file that validation creates is then owned by the service, not by root.
    assert list(runner.commands[1]) == ["runuser", "-u", "caddy", "--", *VALIDATE]
    assert runner.commands[2] == ("caddy", "reload", "--config", "/etc/caddy/Caddyfile")


@pytest.mark.parametrize(
    ("euid", "runner"),
    [
        (1000, SystemdRunner()),
        (0, SystemdRunner(unit_user="root")),
        (0, SystemdRunner(unit_user="")),
        (0, SystemdRunner(tools=frozenset({"runuser"}))),
        (0, SystemdRunner(tools=frozenset({"systemctl"}))),
    ],
    ids=["not-root", "unit-runs-as-root", "no-unit-user", "no-systemd", "no-runuser"],
)
def test_validate_runs_directly_when_switching_user_is_not_possible_or_needed(monkeypatch, euid, runner) -> None:
    monkeypatch.setattr(kitshn.caddy.os, "geteuid", lambda: euid)

    assert caddy_validate_command(runner) == VALIDATE


def test_unix_access_problem_checks_parent_search_and_socket_write() -> None:
    other_uid = os.getuid() + 4242
    # pytest's tmp_path sits under a 0700 directory on macOS, which other users cannot search.
    base = Path(tempfile.mkdtemp(dir="/tmp")).resolve()
    base.chmod(0o755)
    socket_dir = base / "sockets"
    socket_dir.mkdir()
    socket = socket_dir / "app.sock"
    socket.write_bytes(b"")
    try:
        socket.chmod(0o644)
        assert "cannot write" in (unix_access_problem(socket, other_uid, set()) or "")
        socket.chmod(0o666)
        assert unix_access_problem(socket, other_uid, set()) is None
        socket_dir.chmod(0o700)
        assert "cannot search" in (unix_access_problem(socket, other_uid, set()) or "")
        # The owner and root keep access either way.
        assert unix_access_problem(socket, os.getuid(), set()) is None
        assert unix_access_problem(socket, 0, set()) is None
    finally:
        socket_dir.chmod(0o755)
        shutil.rmtree(base)
