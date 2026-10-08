from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

import kitshn.caddy
import kitshn.caddy_host
from kitshn.caddy_host import CaddyHostSettings, CaddyModule, configure_caddy_host, with_options_import
from kitshn.errors import KitshnError
from kitshn.runner import CommandResult, CommandRunner

CLOUDFLARE = CaddyModule("github.com/caddy-dns/cloudflare", "v0.2.4")


class HostRunner(CommandRunner):
    """Answers like a host whose Caddy is `version` with the `deps` modules."""

    def __init__(self, *, version: str = "v2.11.3", deps: str = "", validate_ok: bool = True) -> None:
        super().__init__()
        self.version = version
        self.deps = deps
        self.validate_ok = validate_ok
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
        stdout = ""
        returncode = 0
        if command[1:] == ("version",):
            stdout = f"{self.version} h1:abc\n"
        elif command[1:] == ("build-info",):
            stdout = self.deps
        elif command[:2] == ("caddy", "validate") and not self.validate_ok:
            returncode = 1
        return CommandResult(args=args, returncode=returncode, stdout=stdout, stderr="")


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
    paths["CADDY_BINARY"].write_text("binary", encoding="utf-8")
    return etc


def test_module_specs_must_pin_a_version() -> None:
    assert CaddyModule.parse("github.com/caddy-dns/cloudflare@v0.2.4") == CLOUDFLARE
    for spec in ("github.com/caddy-dns/cloudflare", "github.com/caddy-dns/cloudflare@latest", "@v1"):
        with pytest.raises(KitshnError, match="pin a version"):
            CaddyModule.parse(spec)


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


def test_present_modules_skip_the_build(host: Path) -> None:
    runner = HostRunner(deps="dep\tgithub.com/caddy-dns/cloudflare\tv0.2.4\th1:x\n")

    assert configure_caddy_host(CaddyHostSettings(modules=[CLOUDFLARE]), runner) is False
    assert not any(command[0] == "docker" for command in runner.commands)


def test_options_reload_and_env_restarts(host: Path, tmp_path: Path) -> None:
    source = tmp_path / "caddy.env"
    source.write_text("CLOUDFLARE_API_TOKEN=abc123\n", encoding="utf-8")
    settings = CaddyHostSettings(
        acme_email="dev@example.com",
        dns_provider="cloudflare {env.CLOUDFLARE_API_TOKEN}",
        env_file=source,
    )
    runner = HostRunner()

    assert configure_caddy_host(settings, runner) is True

    options = kitshn.caddy_host.CADDY_OPTIONS_FILE.read_text(encoding="utf-8")
    assert "email dev@example.com" in options
    assert "dir https://acme.zerossl.com/v2/DV90" in options
    assert "dns cloudflare {env.CLOUDFLARE_API_TOKEN}" in options
    assert "import" in kitshn.caddy_host.CADDY_BASE_CONFIG.read_text(encoding="utf-8").splitlines()[1]
    env_file = kitshn.caddy_host.CADDY_ENV_FILE
    assert "CLOUDFLARE_API_TOKEN=abc123" in env_file.read_text(encoding="utf-8")
    assert env_file.stat().st_mode & 0o077 == 0
    assert "--environ" not in kitshn.caddy_host.SYSTEMD_DROP_IN.read_text(encoding="utf-8")
    validate = next(i for i, c in enumerate(runner.commands) if c[:2] == ("caddy", "validate"))
    assert runner.commands[validate + 1 :] == [("systemctl", "daemon-reload"), ("systemctl", "restart", "caddy")]

    again = HostRunner()
    assert configure_caddy_host(settings, again) is False
    assert again.commands == []


def test_failed_validation_restores_every_file(host: Path) -> None:
    base = kitshn.caddy_host.CADDY_BASE_CONFIG
    before = base.read_text(encoding="utf-8")
    runner = HostRunner(validate_ok=False)

    with pytest.raises(KitshnError, match="restored"):
        configure_caddy_host(CaddyHostSettings(dns_provider="cloudflare {env.T}"), runner)

    assert base.read_text(encoding="utf-8") == before
    assert not kitshn.caddy_host.CADDY_OPTIONS_FILE.exists()
    assert ("systemctl", "restart", "caddy") not in runner.commands


def test_env_values_with_spaces_or_quotes_are_rejected(host: Path, tmp_path: Path) -> None:
    source = tmp_path / "caddy.env"
    source.write_text("TOKEN=a b\n", encoding="utf-8")

    with pytest.raises(KitshnError, match="TOKEN"):
        configure_caddy_host(CaddyHostSettings(env_file=source), HostRunner())
