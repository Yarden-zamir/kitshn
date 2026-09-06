"""Compare the installed CLI with the latest published KitSHn version."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json
import os
from typing import Any, Literal
import urllib.error
import urllib.request

from . import __version__
from .errors import KitshnError

GITHUB_API = "https://api.github.com/repos/Yarden-zamir/kitshn"
HOMEBREW_UPGRADE = "brew upgrade kitshn"
UV_TOOL_UPGRADE = "uv tool upgrade kitshn"
UVX_REFRESH = "uvx --refresh --from git+https://github.com/Yarden-zamir/kitshn.git kitshn --version"

InstallSource = Literal["homebrew", "uv"]
FetchJson = Callable[[str], Any]


@dataclass(frozen=True, slots=True)
class VersionReport:
    installed: str
    latest: str
    latest_source: Literal["release", "tag"]
    install_source: InstallSource

    @property
    def current(self) -> bool:
        return parse_version(self.installed) >= parse_version(self.latest)

    @property
    def upgrade_commands(self) -> list[str]:
        if self.install_source == "homebrew":
            return [HOMEBREW_UPGRADE]
        return [UV_TOOL_UPGRADE, UVX_REFRESH]


def parse_version(value: str) -> tuple[int, ...]:
    stripped = value.strip().removeprefix("v")
    try:
        return tuple(int(part) for part in stripped.split("."))
    except ValueError as error:
        msg = f"cannot parse version {value!r}; expected X.Y.Z"
        raise KitshnError(msg) from error


def detect_install_source(environ: dict[str, str] | None = None) -> InstallSource:
    # The Homebrew wrapper script exports KITSHN_SOURCE_REF; uv and uvx installs do not.
    env = os.environ if environ is None else environ
    return "homebrew" if env.get("KITSHN_SOURCE_REF") else "uv"


def latest_published_version(fetch_json: FetchJson | None = None) -> tuple[str, Literal["release", "tag"]]:
    fetch = fetch_json or _fetch_github_json
    release = fetch(f"{GITHUB_API}/releases/latest")
    if isinstance(release, dict) and isinstance(release.get("tag_name"), str):
        return release["tag_name"].removeprefix("v"), "release"

    tags = fetch(f"{GITHUB_API}/tags")
    names = [tag["name"] for tag in tags if isinstance(tag, dict) and isinstance(tag.get("name"), str)] if isinstance(tags, list) else []
    versions = [name for name in names if name.startswith("v")]
    if not versions:
        msg = "no KitSHn release or version tag found on GitHub"
        raise KitshnError(msg)
    return max(versions, key=parse_version).removeprefix("v"), "tag"


def self_check(
    *,
    installed: str = __version__,
    fetch_json: FetchJson | None = None,
    environ: dict[str, str] | None = None,
) -> VersionReport:
    latest, source = latest_published_version(fetch_json)
    return VersionReport(
        installed=installed,
        latest=latest,
        latest_source=source,
        install_source=detect_install_source(environ),
    )


def _fetch_github_json(url: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        msg = f"GitHub API request failed ({error.code}): {url}"
        raise KitshnError(msg) from error
    except urllib.error.URLError as error:
        msg = f"cannot reach GitHub to check the latest KitSHn version: {error.reason}"
        raise KitshnError(msg) from error
