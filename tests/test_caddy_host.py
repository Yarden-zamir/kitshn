from collections.abc import Mapping, Sequence
from pathlib import Path
import os
import shutil

import pytest

import kitshn.caddy
import kitshn.caddy_host
from kitshn.caddy_host import (
    CaddyHostSettings,
    CaddyModule,
    caddy_host_checks,
    configure_caddy_host,
    with_options_import,
)
from kitshn.errors import KitshnError
from kitshn.runner import CommandResult, CommandRunner

CLOUDFLARE = CaddyModule("github.com/caddy-dns/cloudflare", "v0.2.4")


def _binary(version: str, *modules: CaddyModule) -> str:
    """A fake Caddy binary: its file holds the version and the module deps it reports."""

    return "\n".join([version, *(f"{module.path}\t{module.version}" for module in modules)])


class HostRunner(CommandRunner):
    """A Debian host: real files under tmp paths, fake Caddy, dpkg-divert, docker and systemd."""

    def __init__(self, *, validate_ok: bool = True, restart_fails: bool = False) -> None:
        super().__init__()
        self.validate_ok = validate_ok
        self.restart_fails = restart_fails
        self.commands: list[tuple[str, ...]] = []

    def exists(self, executable: str) -> bool:
        return executable == "dpkg-divert"

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
        stdout, returncode = self._answer(command)
        if check and returncode != 0:
            raise KitshnError(f"command failed: {command}")
        return CommandResult(args=args, returncode=returncode, stdout=stdout, stderr="failed" if returncode else "")

    def _answer(self, command: tuple[str, ...]) -> tuple[str, int]:
        caddy = kitshn.caddy_host.CADDY_BINARY
        packaged = kitshn.caddy_host.PACKAGED_BINARY
        match command:
            case (binary, "version"):
                return Path(binary).read_text().splitlines()[0] + " h1:x\n", 0
            case (binary, "build-info"):
                deps = Path(binary).read_text().splitlines()[1:]
                return "".join(f"dep\t{dep}\th1:x\n" for dep in deps), 0
            case ("docker", "run", *rest):
                out = Path(rest[rest.index("--volume") + 1].removesuffix(":/out"))
                version = rest[rest.index("build") + 1]
                modules = [CaddyModule.parse(rest[i + 1]) for i, arg in enumerate(rest) if arg == "--with"]
                (out / "caddy").write_text(_binary(version, *modules))
                return "", 0
            case ("cp", "--preserve=mode", source, target) | ("install", "-m", "0755", source, target):
                shutil.copy(source, target)
                return "", 0
            case ("rm", "-f", target):
                Path(target).unlink(missing_ok=True)
                return "", 0
            case ("dpkg-divert", "--list", _):
                return (f"local diversion of {caddy} to {packaged}\n" if packaged.exists() else ""), 0
            case ("dpkg-divert", "--local", "--rename", "--divert", _, "--add", _):
                caddy.rename(packaged)
                return "", 0
            case ("dpkg-divert", "--local", "--rename", "--remove", _):
                packaged.rename(caddy)
                return "", 0
            case ("caddy", "validate", *_):
                return "", 0 if self.validate_ok else 1
            case ("systemctl", "restart", "caddy") if self.restart_fails:
                self.restart_fails = False
                return "", 1
            case _:
                return "", 0


@pytest.fixture
def host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    etc = tmp_path / "etc"
    paths = {
        "CADDY_ENV_FILE": etc / "caddy" / "kitshn.env",
        "CADDY_OPTIONS_FILE": etc / "caddy" / "kitshn-options.caddy",
        "CADDY_BASE_CONFIG": etc / "caddy" / "Caddyfile",
        "SYSTEMD_DROP_IN": etc / "systemd" / "kitshn.conf",
        "CADDY_BINARY": tmp_path / "bin" / "caddy",
        "PACKAGED_BINARY": tmp_path / "bin" / "caddy.default",
        "PREVIOUS_BINARY": tmp_path / "bin" / "caddy.kitshn-previous",
    }
    for name, path in paths.items():
        monkeypatch.setattr(kitshn.caddy_host, name, path)
        if hasattr(kitshn.caddy, name):
            monkeypatch.setattr(kitshn.caddy, name, path)
    monkeypatch.setattr(kitshn.caddy_host, "caddy_group", lambda _runner: None)
    paths["CADDY_BASE_CONFIG"].parent.mkdir(parents=True)
    paths["CADDY_BASE_CONFIG"].write_text(":80 {\n}\nimport /deployments/Caddyfile\n", encoding="utf-8")
    paths["CADDY_BINARY"].parent.mkdir(parents=True)
    paths["CADDY_BINARY"].write_text(_binary("v2.11.3"), encoding="utf-8")
    return tmp_path


def _env_source(tmp_path: Path, content: str = "CLOUDFLARE_API_TOKEN=abc123\n") -> Path:
    source = tmp_path / "caddy.env"
    source.write_text(content, encoding="utf-8")
    return source


def _full_settings(tmp_path: Path) -> CaddyHostSettings:
    return CaddyHostSettings(
        modules=[CLOUDFLARE],
        acme_email="dev@example.com",
        dns_provider="cloudflare {env.CLOUDFLARE_API_TOKEN}",
        dns_zones=["example.com"],
        env_file=_env_source(tmp_path),
    )


def test_module_specs_must_pin_a_version() -> None:
    assert CaddyModule.parse("github.com/caddy-dns/cloudflare@v0.2.4") == CLOUDFLARE
    for spec in ("github.com/caddy-dns/cloudflare", "github.com/caddy-dns/cloudflare@latest", "@v1"):
        with pytest.raises(KitshnError, match="pin a version"):
            CaddyModule.parse(spec)


@pytest.mark.parametrize(
    ("settings", "match"),
    [
        ({"acme_email": "a@example.com\ndns evil"}, "acme-email"),
        ({"acme_email": "not-an-email"}, "acme-email"),
        ({"dns_provider": "cloudflare x\n}"}, "dns-provider"),
        ({"dns_provider": "cloudflare x", "dns_zones": ["Example.com"]}, "dns-zone"),
        ({"dns_provider": "cloudflare x", "dns_zones": ["example.com."]}, "dns-zone"),
        ({"dns_provider": "cloudflare x", "dns_zones": ["localhost"]}, "dns-zone"),
        ({"dns_zones": ["example.com"]}, "needs --dns-provider"),
    ],
)
def test_settings_reject_values_that_would_break_the_caddy_config(settings: dict, match: str) -> None:
    with pytest.raises(KitshnError, match=match):
        CaddyHostSettings(**settings)


def test_options_import_goes_into_the_global_block_once() -> None:
    import_line = f"\timport {kitshn.caddy_host.CADDY_OPTIONS_FILE}"
    added = with_options_import("# comment\n:80 {\n}\n")
    assert added.splitlines()[:3] == ["{", import_line, "}"]
    assert with_options_import(added) == added

    existing = with_options_import("{\n\tadmin localhost:2019\n}\n:80 {\n}\n")
    assert existing.splitlines()[:3] == ["{", import_line, "\tadmin localhost:2019"]


def test_empty_settings_change_nothing(host: Path) -> None:
    runner = HostRunner()
    assert configure_caddy_host(CaddyHostSettings(), runner) is False
    assert runner.commands == []


def test_first_run_builds_the_packaged_version_diverts_and_restarts(host: Path) -> None:
    runner = HostRunner()

    assert configure_caddy_host(_full_settings(host), runner) is True

    caddy = kitshn.caddy_host.CADDY_BINARY
    assert caddy.read_text() == _binary("v2.11.3", CLOUDFLARE)
    assert kitshn.caddy_host.PACKAGED_BINARY.read_text() == _binary("v2.11.3")
    assert not kitshn.caddy_host.PREVIOUS_BINARY.exists()
    docker = next(command for command in runner.commands if command[0] == "docker")
    assert "caddy:2.11.3-builder" in docker
    options = kitshn.caddy_host.CADDY_OPTIONS_FILE.read_text(encoding="utf-8")
    assert "dir https://acme.zerossl.com/v2/DV90" in options
    assert kitshn.caddy.caddy_dns_zones(kitshn.caddy_host.CADDY_OPTIONS_FILE) == frozenset({"example.com"})
    env_file = kitshn.caddy_host.CADDY_ENV_FILE
    assert env_file.read_text(encoding="utf-8").endswith("CLOUDFLARE_API_TOKEN=abc123\n")
    assert env_file.stat().st_mode & 0o077 == 0
    drop_in = kitshn.caddy_host.SYSTEMD_DROP_IN.read_text(encoding="utf-8")
    assert f"EnvironmentFile={env_file}" in drop_in
    assert "--environ" not in drop_in
    validate = next(i for i, c in enumerate(runner.commands) if c[:2] == ("caddy", "validate"))
    assert runner.commands[validate + 1 :] == [("systemctl", "daemon-reload"), ("systemctl", "restart", "caddy")]

    again = HostRunner()
    assert configure_caddy_host(_full_settings(host), again) is False
    assert not any(command[0] in {"docker", "systemctl"} for command in again.commands)


def test_a_package_upgrade_rebuilds_for_the_new_version(host: Path) -> None:
    configure_caddy_host(_full_settings(host), HostRunner())
    kitshn.caddy_host.PACKAGED_BINARY.write_text(_binary("v2.11.7"))
    runner = HostRunner()

    assert configure_caddy_host(_full_settings(host), runner) is True

    assert kitshn.caddy_host.CADDY_BINARY.read_text() == _binary("v2.11.7", CLOUDFLARE)
    assert not any(command[:2] == ("dpkg-divert", "--local") for command in runner.commands)
    assert caddy_host_checks(HostRunner())[0].state == "ok"


def test_a_failed_restart_restores_the_binary_files_and_diversion(host: Path) -> None:
    caddy = kitshn.caddy_host.CADDY_BINARY
    base = kitshn.caddy_host.CADDY_BASE_CONFIG
    before = base.read_text(encoding="utf-8")
    runner = HostRunner(restart_fails=True)

    with pytest.raises(KitshnError):
        configure_caddy_host(_full_settings(host), runner)

    assert caddy.read_text() == _binary("v2.11.3")
    assert not kitshn.caddy_host.PACKAGED_BINARY.exists()
    assert not kitshn.caddy_host.PREVIOUS_BINARY.exists()
    assert base.read_text(encoding="utf-8") == before
    for path in (
        kitshn.caddy_host.CADDY_OPTIONS_FILE,
        kitshn.caddy_host.CADDY_ENV_FILE,
        kitshn.caddy_host.SYSTEMD_DROP_IN,
    ):
        assert not path.exists()
    assert runner.commands[-2:] == [("systemctl", "daemon-reload"), ("systemctl", "restart", "caddy")]


def test_a_failed_rebuild_keeps_the_diversion_and_the_previous_build(host: Path) -> None:
    configure_caddy_host(_full_settings(host), HostRunner())
    kitshn.caddy_host.PACKAGED_BINARY.write_text(_binary("v2.11.7"))

    with pytest.raises(KitshnError, match="restored"):
        configure_caddy_host(_full_settings(host), HostRunner(validate_ok=False))

    assert kitshn.caddy_host.CADDY_BINARY.read_text() == _binary("v2.11.3", CLOUDFLARE)
    assert kitshn.caddy_host.PACKAGED_BINARY.read_text() == _binary("v2.11.7")
    assert not kitshn.caddy_host.PREVIOUS_BINARY.exists()
    assert caddy_host_checks(HostRunner())[0].state == "warn"


def test_failed_validation_of_options_restores_files_without_a_restart(host: Path, tmp_path: Path) -> None:
    kitshn.caddy_host.CADDY_ENV_FILE.write_text("T=abcdef\n", encoding="utf-8")
    base = kitshn.caddy_host.CADDY_BASE_CONFIG
    before = base.read_text(encoding="utf-8")
    runner = HostRunner(validate_ok=False)

    with pytest.raises(KitshnError, match="restored"):
        configure_caddy_host(CaddyHostSettings(dns_provider="cloudflare {env.T}"), runner)

    assert base.read_text(encoding="utf-8") == before
    assert not kitshn.caddy_host.CADDY_OPTIONS_FILE.exists()
    assert ("systemctl", "restart", "caddy") not in runner.commands


def test_a_dns_provider_without_a_token_is_refused(host: Path) -> None:
    with pytest.raises(KitshnError, match="caddy-env-file"):
        configure_caddy_host(CaddyHostSettings(dns_provider="cloudflare {env.T}"), HostRunner())

    assert not kitshn.caddy_host.CADDY_OPTIONS_FILE.exists()


@pytest.mark.parametrize("content", ["TOKEN=a b\n", "TOKEN=a\\b\n", "# nothing\n"])
def test_env_values_that_systemd_or_caddy_would_misread_are_rejected(host: Path, tmp_path: Path, content: str) -> None:
    with pytest.raises(KitshnError, match="environment"):
        configure_caddy_host(CaddyHostSettings(env_file=_env_source(tmp_path, content)), HostRunner())


@pytest.mark.skipif(os.geteuid() != 0, reason="the check wants a root-owned token file")
def test_doctor_fails_a_dns_option_without_a_usable_token(host: Path) -> None:
    configure_caddy_host(_full_settings(host), HostRunner())
    assert {check.name: check.state for check in caddy_host_checks(HostRunner())}["caddy dns token"] == "ok"

    kitshn.caddy_host.CADDY_ENV_FILE.chmod(0o644)
    assert "mode" in next(c.detail for c in caddy_host_checks(HostRunner()) if c.name == "caddy dns token")

    kitshn.caddy_host.CADDY_ENV_FILE.unlink()
    check = next(c for c in caddy_host_checks(HostRunner()) if c.name == "caddy dns token")
    assert check.state == "fail"
    assert "missing" in check.detail
