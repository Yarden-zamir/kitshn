from __future__ import annotations

import os

from kitshn.runner import CommandRunner

NAME = "alpine"
DESCRIPTION = "Alpine apk installer using distribution packages"
PACKAGE_MANAGERS = ("apk",)


def matches_os_release(os_release: dict[str, str]) -> bool:
    return os_release.get("ID") == "alpine"


def install(runner: CommandRunner) -> None:
    sudo = [] if os.geteuid() == 0 else ["sudo"]
    runner.run([*sudo, "apk", "add", "--no-cache", "docker", "docker-cli-compose", "git", "github-cli", "curl", "caddy"])
    runner.run(["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
