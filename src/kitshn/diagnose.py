from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import stat
from typing import Literal

from .caddy import CADDY_BASE_CONFIG
from .compose import compose_command, compose_services, has_compose_file, render_compose_config
from .models import Deployment, Recipe, Roots
from .runner import CommandRunner


@dataclass(frozen=True, slots=True)
class DiagnoseCheck:
    name: str
    state: Literal["ok", "warn", "fail"]
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.state in {"ok", "warn"}


def diagnose_deployment(
    recipe_name: str,
    *,
    environment: str,
    roots: Roots,
    runner: CommandRunner,
) -> list[DiagnoseCheck]:
    deployment = Deployment.create(Recipe.parse(recipe_name), environment, roots)
    checks: list[DiagnoseCheck] = []

    checks.append(_path_check("deployment root", deployment.deployment_root, want_dir=True))
    checks.append(_path_check("params file", deployment.params_file, want_file=True))
    checks.append(_path_check("socket dir", deployment.socket_root, want_dir=True))

    compose_exists = has_compose_file(deployment)
    checks.append(
        DiagnoseCheck(
            "compose file",
            "ok" if compose_exists else "warn",
            "compose.yml or compose.yaml" if compose_exists else "no deployment compose file",
        )
    )
    if compose_exists:
        checks.append(_command_check("compose ps", compose_command(deployment, "ps", "--format", "json"), runner, cwd=deployment.deployment_root, env=deployment.runtime_env))
        checks.extend(_socket_proxy_network_checks(deployment, runner))

    caddyfile = deployment.generated_caddyfile
    checks.append(_path_check("generated Caddyfile", caddyfile, want_file=True, warn_when_missing=True))
    socket_targets = _unix_socket_targets(caddyfile)
    if caddyfile.exists():
        checks.append(
            DiagnoseCheck(
                "unix socket targets",
                "ok" if socket_targets else "warn",
                ", ".join(str(path) for path in socket_targets) or "no unix// targets in generated Caddyfile",
            )
        )

    for socket_path in socket_targets:
        checks.append(_socket_check(socket_path))
        if runner.exists("curl"):
            checks.append(
                _command_check(
                    f"curl {socket_path.name}",
                    ["curl", "--silent", "--show-error", "--max-time", "5", "--unix-socket", str(socket_path), "http://localhost/"],
                    runner,
                )
            )
        else:
            checks.append(DiagnoseCheck(f"curl {socket_path.name}", "warn", "curl not found"))

    checks.append(_command_check("caddy validate", ["caddy", "validate", "--config", str(CADDY_BASE_CONFIG)], runner))
    return checks


def _path_check(
    name: str,
    path: Path,
    *,
    want_dir: bool = False,
    want_file: bool = False,
    warn_when_missing: bool = False,
) -> DiagnoseCheck:
    if want_dir and path.is_dir():
        return DiagnoseCheck(name, "ok", str(path))
    if want_file and path.is_file():
        return DiagnoseCheck(name, "ok", str(path))
    state: Literal["warn", "fail"] = "warn" if warn_when_missing else "fail"
    return DiagnoseCheck(name, state, f"missing: {path}")


def _socket_check(path: Path) -> DiagnoseCheck:
    if not path.exists():
        return DiagnoseCheck(f"socket {path.name}", "fail", f"missing: {path}")
    if stat.S_ISSOCK(path.stat().st_mode):
        return DiagnoseCheck(f"socket {path.name}", "ok", str(path))
    return DiagnoseCheck(f"socket {path.name}", "fail", f"not a socket: {path}")


def _command_check(
    name: str,
    args: list[str],
    runner: CommandRunner,
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> DiagnoseCheck:
    result = runner.run(args, cwd=cwd, env=env, capture=True, check=False)
    output = result.stderr.strip() or result.stdout.strip()
    detail = output.splitlines()
    state: Literal["ok", "fail"] = "ok" if result.returncode == 0 else "fail"
    message = detail[-1] if detail else ""
    if state == "fail":
        hint = _failure_hint(name, output)
        if hint:
            message = f"{message} | hint: {hint}" if message else f"hint: {hint}"
    return DiagnoseCheck(name, state, message)


def _socket_proxy_network_checks(
    deployment: Deployment,
    runner: CommandRunner,
) -> list[DiagnoseCheck]:
    config = render_compose_config(deployment, runner)
    checks: list[DiagnoseCheck] = []
    for service in compose_services(config):
        normalized_name = service.name.replace("_", "-").lower()
        if "socket" not in normalized_name or "proxy" not in normalized_name:
            continue
        extra_networks = [network for network in service.networks if network != "default"]
        if extra_networks:
            checks.append(
                DiagnoseCheck(
                    f"{service.name} networks",
                    "warn",
                    "socket proxies should usually use only the project-local default network; extra networks: "
                    + ", ".join(extra_networks),
                )
            )
    return checks


def _failure_hint(name: str, output: str) -> str:
    lowered = output.lower()
    if "ambiguous site definition" in lowered:
        return "check that Caddyfile.j2 uses a unique hostname per environment, especially pr-* previews"
    if name.startswith("curl "):
        if "connection refused" in lowered:
            return "socket proxy reached the socket but could not reach the app; check TCP target, health, and proxy networks"
        if "empty reply" in lowered or "connection reset" in lowered:
            return "socket target accepted the connection but did not return HTTP; check app/proxy logs and target protocol"
        return "check socket-proxy logs, app health, and whether proxy-to-app traffic stays on the project-local network"
    return ""


def _unix_socket_targets(caddyfile: Path) -> list[Path]:
    if not caddyfile.exists():
        return []

    targets: list[Path] = []
    for token in caddyfile.read_text(encoding="utf-8").split():
        cleaned = token.strip('"\'')
        if cleaned.startswith("unix//"):
            targets.append(Path(cleaned.removeprefix("unix//")))
    return targets
