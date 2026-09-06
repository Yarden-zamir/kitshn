from pathlib import Path
from collections.abc import Mapping, Sequence

import pytest

from kitshn.errors import KitshnError
from kitshn.remote import check_vps_reachable, remote_ssh_args, strip_vps_host
from kitshn.runner import CommandResult, CommandRunner


def test_strip_vps_host_removes_both_flag_forms_only() -> None:
    args = ["diagnose", "owner/repo", "--vps-host", "deploy@vps", "--environment", "prod"]
    assert strip_vps_host(args) == ["diagnose", "owner/repo", "--environment", "prod"]
    assert strip_vps_host(["status", "--vps-host=deploy@vps"]) == ["status"]
    assert strip_vps_host(["logs", "owner/repo", "--follow"]) == ["logs", "owner/repo", "--follow"]


def test_remote_ssh_args_use_a_login_shell_and_the_hosted_cli() -> None:
    args = remote_ssh_args("deploy@vps", ["status", "owner/repo", "--environment", "pr-1"], tty=True)

    assert args[:3] == ["ssh", "-t", "deploy@vps"]
    remote = args[-1]
    # A login shell plus an explicit PATH prefix so uvx under ~/.local/bin resolves.
    assert remote.startswith("bash -lc ")
    assert "export PATH=$HOME/.local/bin:$PATH" in remote
    assert "uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn status owner/repo" in remote
    assert "--environment pr-1" in remote


def test_check_vps_reachable_reports_ssh_failure() -> None:
    class UnreachableRunner(CommandRunner):
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
            assert args[0] == "ssh" and "BatchMode=yes" in args and args[-1] == "true"
            return CommandResult(args=args, returncode=255, stdout="", stderr="Connection timed out")

    with pytest.raises(KitshnError, match="cannot reach VPS over SSH: deploy@vps: Connection timed out"):
        check_vps_reachable("deploy@vps", UnreachableRunner())
