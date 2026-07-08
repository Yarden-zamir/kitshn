from pathlib import Path
from collections.abc import Mapping, Sequence

from kitshn.bootstrap import bootstrap, bootstrap_remote, doctor, expected_caddy_import
from kitshn.models import Roots
from kitshn.runner import CommandResult, CommandRunner


class FakeRunner(CommandRunner):
    def __init__(
        self,
        executables: set[str],
        failures: set[tuple[str, ...]] | None = None,
        results: dict[tuple[str, ...], CommandResult] | None = None,
    ) -> None:
        super().__init__()
        self.executables = executables
        self.failures = failures or set()
        self.results = results or {}
        self.commands: list[tuple[str, ...]] = []

    def exists(self, executable: str) -> bool:
        return executable in self.executables

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
        if command in self.results:
            return self.results[command]
        if command in self.failures:
            return CommandResult(args=args, returncode=1, stdout="", stderr="not authenticated")
        return CommandResult(args=args, returncode=0, stdout="ok", stderr="")


def test_doctor_warns_when_gh_is_installed_but_not_authenticated(tmp_path: Path) -> None:
    roots = _roots(tmp_path)
    for path in (roots.deployments, roots.params, roots.persistent, roots.logs, roots.kitshn_logs):
        path.mkdir(parents=True)
    runner = FakeRunner(
        {"docker", "git", "gh", "uv", "caddy"},
        failures={("gh", "auth", "status", "--hostname", "github.com")},
    )

    report = doctor(roots=roots, runner=runner, caddyfile=tmp_path / "Caddyfile")

    auth_check = next(check for check in report.checks if check.name == "github private repo auth")
    assert report.ok is True
    assert auth_check.state == "warn"
    assert "gh auth login" in auth_check.detail


def test_doctor_requires_gh_cli_dependency(tmp_path: Path) -> None:
    roots = _roots(tmp_path)
    runner = FakeRunner({"docker", "git", "uv", "caddy"})

    report = doctor(roots=roots, runner=runner, caddyfile=tmp_path / "Caddyfile")

    gh_check = next(check for check in report.checks if check.name == "gh")
    assert report.ok is False
    assert gh_check.state == "fail"


def test_doctor_reports_caddy_validation_error_instead_of_info_log(tmp_path: Path) -> None:
    roots = _roots(tmp_path)
    caddy_command = ("caddy", "validate", "--config", str(tmp_path / "Caddyfile"))
    runner = FakeRunner(
        {"docker", "git", "gh", "uv", "caddy"},
        results={
            caddy_command: CommandResult(
                args=caddy_command,
                returncode=1,
                stdout="",
                stderr='{"level":"info","msg":"using config from file"}\n{"level":"error","msg":"unrecognized directive: bad"}\n',
            )
        },
    )

    report = doctor(roots=roots, runner=runner, caddyfile=tmp_path / "Caddyfile")

    caddy_check = next(check for check in report.checks if check.name == "caddy config")
    assert caddy_check.state == "fail"
    assert caddy_check.detail == "unrecognized directive: bad"


def test_expected_caddy_import_uses_generated_manifest(tmp_path: Path) -> None:
    assert expected_caddy_import(_roots(tmp_path)) == f"import {tmp_path}/deployments/Caddyfile"


def test_bootstrap_replaces_stale_caddy_imports(tmp_path: Path) -> None:
    roots = _roots(tmp_path)
    caddyfile = tmp_path / "Caddyfile"
    caddyfile.write_text(
        ":80 {\n"
        "    respond ok\n"
        "}\n"
        f"import {roots.deployments}/*/*/*/Caddyfile\n"
        f"import {roots.deployments}/Caddyfile\n"
        f"import {roots.deployments}/_caddy/*.Caddyfile\n",
        encoding="utf-8",
    )
    runner = FakeRunner({"docker", "git", "gh", "uv", "caddy"})

    bootstrap(roots=roots, user=None, runner=runner, caddyfile=caddyfile)

    assert caddyfile.read_text(encoding="utf-8") == (
        ":80 {\n"
        "    respond ok\n"
        "}\n"
        f"import {roots.deployments}/Caddyfile\n"
    )


def test_bootstrap_remote_uses_hosted_uvx() -> None:
    runner = FakeRunner({"ssh"})

    bootstrap_remote("prod-vps", runner, install_missing=True, installer_name="ubuntu")

    command = runner.commands[0]
    assert command[0:2] == ("ssh", "prod-vps")
    assert "curl -LsSf https://astral.sh/uv/install.sh | sh" in command[2]
    assert "uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn bootstrap" in command[2]
    assert "--install-missing --installer ubuntu" in command[2]


def _roots(tmp_path: Path) -> Roots:
    return Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
