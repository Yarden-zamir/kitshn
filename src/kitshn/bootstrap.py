from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import getpass
import os
import pwd
import shutil
import stat
from typing import Literal

from .errors import KitshnError
from .installer_registry import Installer, get_installer, suggested_installers
from .models import Roots
from .runner import CommandRunner

EXPECTED_CADDY_IMPORT = "import /deployments/*/*/*/Caddyfile"


@dataclass(frozen=True, slots=True)
class Check:
    name: str
    state: Literal["ok", "warn", "fail"]
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.state in {"ok", "warn"}


@dataclass(slots=True)
class DoctorReport:
    checks: list[Check] = field(default_factory=list)
    installers: list[Installer] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(Check(name, "ok" if ok else "fail", detail))

    def warn(self, name: str, detail: str) -> None:
        self.checks.append(Check(name, "warn", detail))


def bootstrap(
    *,
    roots: Roots,
    user: str | None,
    runner: CommandRunner,
    install_missing: bool = False,
    installer_name: str | None = None,
    network: str = "kitshn-edge",
    caddyfile: Path = Path("/etc/caddy/Caddyfile"),
) -> DoctorReport:
    initial_report = doctor(roots=roots, runner=runner, network=network, caddyfile=caddyfile)
    if install_missing and _has_missing_dependencies(initial_report):
        installer = get_installer(installer_name) if installer_name else _single_suggested_installer(initial_report)
        installer.install(runner)

    deployment_user = user or getpass.getuser()
    _ensure_user_exists(deployment_user)
    for path in (roots.deployments, roots.params, roots.persistent, roots.logs, roots.kitshn_logs):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o755)
    _ensure_docker_network(network, runner)
    _ensure_caddy_import(caddyfile)
    return doctor(roots=roots, runner=runner, network=network, caddyfile=caddyfile)


def doctor(
    *,
    roots: Roots,
    runner: CommandRunner,
    network: str = "kitshn-edge",
    caddyfile: Path = Path("/etc/caddy/Caddyfile"),
) -> DoctorReport:
    report = DoctorReport()
    for executable in ("docker", "git", "gh", "uv", "caddy"):
        report.add(executable, runner.exists(executable), _which_detail(executable))

    compose = runner.run(["docker", "compose", "version"], capture=True, check=False)
    report.add("docker compose", compose.returncode == 0, _result_detail(compose.stdout, compose.stderr))

    for name, path in (
        ("deployments root", roots.deployments),
        ("params root", roots.params),
        ("persistent root", roots.persistent),
        ("logs root", roots.logs),
        ("kitshn logs root", roots.kitshn_logs),
    ):
        report.add(name, path.is_dir(), str(path))

    network_check = runner.run(["docker", "network", "inspect", network], capture=True, check=False)
    report.add("edge network", network_check.returncode == 0, network)

    if runner.exists("gh"):
        github_check = runner.run(
            ["gh", "auth", "status", "--hostname", "github.com"], capture=True, check=False
        )
        if github_check.returncode == 0:
            report.add("github private repo auth", True, "authenticated with gh")
        else:
            report.warn(
                "github private repo auth",
                "public repos work without auth; private repos need: gh auth login",
            )

    caddy_check = runner.run(
        ["caddy", "validate", "--config", str(caddyfile)], capture=True, check=False
    )
    report.add("caddy config", caddy_check.returncode == 0, _result_detail(caddy_check.stdout, caddy_check.stderr))
    report.installers = suggested_installers(runner) if _has_missing_dependencies(report) else []
    return report


def bootstrap_remote(target: str, runner: CommandRunner) -> None:
    runner.run(["ssh", target, "kitshn", "bootstrap"])


def _ensure_user_exists(user: str) -> None:
    try:
        pwd.getpwnam(user)
    except KeyError as error:
        msg = f"deployment user does not exist: {user}"
        raise KitshnError(msg) from error


def _ensure_docker_network(network: str, runner: CommandRunner) -> None:
    inspected = runner.run(["docker", "network", "inspect", network], capture=True, check=False)
    if inspected.returncode != 0:
        runner.run(["docker", "network", "create", network])


def _ensure_caddy_import(caddyfile: Path) -> None:
    if not caddyfile.exists():
        caddyfile.parent.mkdir(parents=True, exist_ok=True)
        caddyfile.write_text(EXPECTED_CADDY_IMPORT + "\n", encoding="utf-8")
        return

    content = caddyfile.read_text(encoding="utf-8")
    if EXPECTED_CADDY_IMPORT in content:
        return
    if not os.access(caddyfile, os.W_OK):
        msg = f"cannot update Caddyfile import without write access: {caddyfile}"
        raise KitshnError(msg)
    separator = "" if content.endswith("\n") else "\n"
    caddyfile.write_text(content + separator + EXPECTED_CADDY_IMPORT + "\n", encoding="utf-8")


def _which_detail(executable: str) -> str:
    return shutil.which(executable) or "not found"


def _result_detail(stdout: str, stderr: str) -> str:
    return (stdout.strip() or stderr.strip()).splitlines()[0] if stdout.strip() or stderr.strip() else ""


def describe_mode(path: Path) -> str:
    return stat.filemode(path.stat().st_mode) if path.exists() else "missing"


def _has_missing_dependencies(report: DoctorReport) -> bool:
    dependency_checks = {"docker", "docker compose", "git", "gh", "uv", "caddy"}
    return any(check.name in dependency_checks and check.state == "fail" for check in report.checks)


def _single_suggested_installer(report: DoctorReport) -> Installer:
    if len(report.installers) == 1:
        return report.installers[0]
    if not report.installers:
        msg = "missing dependencies, but no installer matches this host; pass --installer explicitly"
        raise KitshnError(msg)
    choices = ", ".join(installer.name for installer in report.installers)
    msg = f"multiple installers match this host ({choices}); pass --installer"
    raise KitshnError(msg)
