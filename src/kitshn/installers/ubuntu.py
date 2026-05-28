from __future__ import annotations

from pathlib import Path

from kitshn.runner import CommandRunner

NAME = "ubuntu"
DESCRIPTION = "Ubuntu apt installer using official Docker and Caddy repositories"
PACKAGE_MANAGERS = ("apt-get",)


def matches_os_release(os_release: dict[str, str]) -> bool:
    return os_release.get("ID") == "ubuntu"


def install(runner: CommandRunner) -> None:
    sudo = _sudo()
    runner.run([*sudo, "apt-get", "update"])
    runner.run([*sudo, "apt-get", "install", "-y", "ca-certificates", "curl", "gnupg", "git"])
    runner.run([*sudo, "install", "-m", "0755", "-d", "/etc/apt/keyrings"])
    _install_github_cli_apt_repo(runner, sudo)
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
        ]
    )
    runner.run([*sudo, "chmod", "a+r", "/etc/apt/keyrings/docker.asc"])
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            """
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
""".strip(),
        ]
    )
    _install_caddy_apt_repo(runner, sudo)
    runner.run([*sudo, "apt-get", "update"])
    runner.run(
        [
            *sudo,
            "apt-get",
            "install",
            "-y",
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


def _install_caddy_apt_repo(runner: CommandRunner, sudo: list[str]) -> None:
    runner.run(
        [
            *sudo,
            "apt-get",
            "install",
            "-y",
            "debian-keyring",
            "debian-archive-keyring",
            "apt-transport-https",
            "curl",
        ]
    )
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
        ]
    )
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list",
        ]
    )
    runner.run([*sudo, "chmod", "o+r", "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"])
    runner.run([*sudo, "chmod", "o+r", "/etc/apt/sources.list.d/caddy-stable.list"])


def _install_github_cli_apt_repo(runner: CommandRunner, sudo: list[str]) -> None:
    runner.run([*sudo, "mkdir", "-p", "-m", "755", "/etc/apt/keyrings"])
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
        ]
    )
    runner.run([*sudo, "chmod", "go+r", "/etc/apt/keyrings/githubcli-archive-keyring.gpg"])
    runner.run([*sudo, "mkdir", "-p", "-m", "755", "/etc/apt/sources.list.d"])
    runner.run(
        [
            *sudo,
            "sh",
            "-c",
            'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
        ]
    )


def _sudo() -> list[str]:
    return [] if Path("/proc/self").exists() and _is_root() else ["sudo"]


def _is_root() -> bool:
    import os

    return os.geteuid() == 0
