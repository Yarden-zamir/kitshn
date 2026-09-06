"""Run KitSHn commands on the VPS from the laptop.

`--vps-host` on VPS-only commands forwards the invocation over SSH. The remote side runs the
hosted CLI through `uvx` inside a login shell, so `uvx` installed under `~/.local/bin` is on
PATH even though non-interactive SSH sessions do not read profile files.
"""

from __future__ import annotations

import shlex
import sys
from collections.abc import Sequence

from .ci import HOSTED_CLI, REMOTE_PATH_PREFIX
from .errors import KitshnError
from .runner import CommandResult, CommandRunner

VPS_HOST_FLAG = "--vps-host"
SSH_PROBE_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]


def strip_vps_host(args: Sequence[str]) -> list[str]:
    """Return `args` without the `--vps-host <host>` or `--vps-host=<host>` option."""

    remaining: list[str] = []
    skip_next = False
    for arg in args:
        if skip_next:
            skip_next = False
            continue
        if arg == VPS_HOST_FLAG:
            skip_next = True
            continue
        if arg.startswith(f"{VPS_HOST_FLAG}="):
            continue
        remaining.append(arg)
    return remaining


def remote_shell_command(kitshn_args: Sequence[str]) -> str:
    """Build the remote shell string that runs hosted KitSHn inside a login shell."""

    inner = "; ".join([REMOTE_PATH_PREFIX, shlex.join([*HOSTED_CLI, *kitshn_args])])
    return f"bash -lc {shlex.quote(inner)}"


def remote_ssh_args(vps_host: str, kitshn_args: Sequence[str], *, tty: bool = False) -> list[str]:
    return ["ssh", *(["-t"] if tty else []), vps_host, remote_shell_command(kitshn_args)]


def check_vps_reachable(vps_host: str, runner: CommandRunner) -> None:
    result = runner.run(["ssh", *SSH_PROBE_ARGS, vps_host, "true"], capture=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        msg = f"cannot reach VPS over SSH: {vps_host}: {detail}"
        raise KitshnError(msg)


def run_on_vps(
    vps_host: str,
    kitshn_args: Sequence[str],
    runner: CommandRunner,
    *,
    capture: bool = False,
    tty: bool | None = None,
) -> CommandResult:
    """Run one hosted KitSHn command on the VPS and return its result without raising on failure."""

    use_tty = sys.stdin.isatty() and not capture if tty is None else tty
    return runner.run(
        remote_ssh_args(vps_host, kitshn_args, tty=use_tty),
        capture=capture,
        check=False,
    )


def forward_invocation_to_vps(vps_host: str, runner: CommandRunner | None = None) -> int:
    """Re-run the current CLI invocation on the VPS, minus `--vps-host`, and return its exit code."""

    runner = runner or CommandRunner()
    check_vps_reachable(vps_host, runner)
    return run_on_vps(vps_host, strip_vps_host(sys.argv[1:]), runner).returncode
