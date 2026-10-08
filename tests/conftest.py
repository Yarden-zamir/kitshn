from pathlib import Path

import pytest

import kitshn.caddy
import kitshn.caddy_host


@pytest.fixture(autouse=True)
def isolated_caddy_host_files(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the real /etc/caddy files of a test host out of every test."""

    root: Path = tmp_path_factory.mktemp("etc-caddy")
    for module in (kitshn.caddy, kitshn.caddy_host):
        monkeypatch.setattr(module, "CADDY_OPTIONS_FILE", root / "kitshn-options.caddy")
        monkeypatch.setattr(module, "CADDY_ENV_FILE", root / "kitshn.env")
