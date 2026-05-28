from __future__ import annotations

import os

from kitshn.runner import CommandRunner

NAME = "arch"
DESCRIPTION = "Arch Linux pacman installer using distribution packages"
PACKAGE_MANAGERS = ("pacman",)


def matches_os_release(os_release: dict[str, str]) -> bool:
    return os_release.get("ID") == "arch"


def install(runner: CommandRunner) -> None:
    sudo = [] if os.geteuid() == 0 else ["sudo"]
    runner.run([*sudo, "pacman", "-Sy", "--needed", "--noconfirm", "docker", "docker-compose", "git", "curl", "caddy"])
    runner.run(["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
