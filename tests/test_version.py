from pathlib import Path
import tomllib

import pytest

import kitshn
from kitshn.errors import KitshnError
from kitshn.version_check import (
    HOMEBREW_UPGRADE,
    UV_TOOL_UPGRADE,
    latest_published_version,
    parse_version,
    self_check,
)

ROOT = Path(__file__).resolve().parents[1]


def _pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def _lock_version() -> str:
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    return next(package["version"] for package in lock["package"] if package["name"] == "kitshn")


def test_release_sources_agree_on_the_version() -> None:
    # The release workflow tags v<pyproject version>; the CLI reports __version__; uv.lock
    # records the packaged version. All three must match or users see version drift.
    assert kitshn.__version__ == _pyproject_version() == _lock_version()
    parse_version(kitshn.__version__)


def test_parse_version_strips_tag_prefix_and_rejects_garbage() -> None:
    assert parse_version("v0.10.2") == (0, 10, 2)
    assert parse_version("0.9.0") < parse_version("0.10.0")
    with pytest.raises(KitshnError):
        parse_version("main")


def test_latest_version_prefers_release_and_falls_back_to_tags() -> None:
    def with_release(url: str):
        return {"tag_name": "v1.2.3"} if url.endswith("/releases/latest") else []

    def tags_only(url: str):
        return None if url.endswith("/releases/latest") else [{"name": "v0.9.0"}, {"name": "v0.10.0"}]

    assert latest_published_version(with_release) == ("1.2.3", "release")
    assert latest_published_version(tags_only) == ("0.10.0", "tag")
    with pytest.raises(KitshnError, match="no KitSHn release"):
        latest_published_version(lambda _url: None)


def test_self_check_reports_outdated_and_matching_upgrade_commands() -> None:
    def fetch(_url: str):
        return {"tag_name": "v0.3.0"}

    outdated = self_check(installed="0.2.0", fetch_json=fetch, environ={"KITSHN_SOURCE_REF": "v0.2.0"})
    assert outdated.current is False
    assert outdated.install_source == "homebrew"
    assert outdated.upgrade_commands == [HOMEBREW_UPGRADE]

    current = self_check(installed="0.3.0", fetch_json=fetch, environ={})
    assert current.current is True
    assert current.install_source == "uv"
    assert current.upgrade_commands[0] == UV_TOOL_UPGRADE
