from __future__ import annotations

import os

from kitshn.runner import CommandRunner

NAME = "fedora"
DESCRIPTION = "Fedora dnf installer using Docker CE and Caddy COPR repositories"
PACKAGE_MANAGERS = ("dnf",)


def matches_os_release(os_release: dict[str, str]) -> bool:
    return os_release.get("ID") == "fedora"


def install(runner: CommandRunner) -> None:
    sudo = [] if os.geteuid() == 0 else ["sudo"]
    runner.run([*sudo, "dnf", "-y", "install", "dnf-plugins-core", "curl", "git"])
    runner.run(
        [
            *sudo,
            "dnf",
            "config-manager",
            "addrepo",
            "--from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo",
        ]
    )
    runner.run([*sudo, "dnf", "-y", "copr", "enable", "@caddy/caddy"])
    runner.run(
        [
            *sudo,
            "dnf",
            "config-manager",
            "addrepo",
            "--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo",
        ]
    )
    runner.run(
        [
            *sudo,
            "dnf",
            "-y",
            "install",
            "docker-ce",
            "docker-ce-cli",
            "containerd.io",
            "docker-buildx-plugin",
            "docker-compose-plugin",
            "gh",
            "caddy",
        ]
    )
    runner.run(["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
