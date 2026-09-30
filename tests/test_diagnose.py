from pathlib import Path
from collections.abc import Mapping, Sequence
import json

from kitshn.diagnose import diagnose_deployment
from kitshn.models import Deployment, Recipe, Roots
from kitshn.runner import CommandResult, CommandRunner


class DiagnoseRunner(CommandRunner):
    def exists(self, executable: str) -> bool:
        return executable in {"curl"}

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
        if list(args[-3:]) == ["config", "--format", "json"]:
            return CommandResult(
                args=args,
                returncode=0,
                stdout=json.dumps(
                    {
                        "services": {
                            "app": {},
                            "socket-proxy": {"networks": {"default": None, "kitshn-edge": None}},
                        }
                    }
                ),
                stderr="",
            )
        if list(args[-3:]) == ["ps", "--format", "json"]:
            return CommandResult(args=args, returncode=0, stdout="[]", stderr="")
        if args and args[0] == "curl":
            return CommandResult(args=args, returncode=7, stdout="", stderr="Connection refused")
        if list(args[:2]) == ["caddy", "validate"]:
            return CommandResult(args=args, returncode=0, stdout="", stderr="")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def test_diagnose_warns_about_socket_proxy_extra_networks(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    _write_deployment_files(deployment)
    deployment.default_socket.parent.mkdir(parents=True)
    deployment.default_socket.write_bytes(b"")

    checks = diagnose_deployment(
        "owner/repo", environment="prod", roots=deployment.roots, runner=DiagnoseRunner()
    )

    network_check = next(check for check in checks if check.name == "socket-proxy networks")
    curl_check = next(check for check in checks if check.name == "curl app.sock")
    assert network_check.state == "warn"
    assert "project-local default network" in network_check.detail
    assert curl_check.state == "fail"
    assert "proxy networks" in curl_check.detail


def _deployment(tmp_path: Path) -> Deployment:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    return Deployment.create(Recipe.parse("owner/repo"), "prod", roots)


def _write_deployment_files(deployment: Deployment) -> None:
    deployment.deployment_root.mkdir(parents=True)
    deployment.params_root.mkdir(parents=True)
    deployment.params_file.write_text("", encoding="utf-8")
    (deployment.deployment_root / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    deployment.generated_caddyfile.write_text(
        f"example.com {{\n    reverse_proxy unix//{deployment.default_socket}\n}}\n",
        encoding="utf-8",
    )


def test_diagnose_warns_when_the_default_socket_path_is_too_long(tmp_path: Path) -> None:
    roots = Roots(
        deployments=tmp_path / ("d" * 60),
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    recipe = "owner/" + "r" * 40

    checks = diagnose_deployment(recipe, environment="prod", roots=roots, runner=DiagnoseRunner())

    check = next(check for check in checks if check.name == "default socket path")
    assert check.state == "warn"
    assert "over the Unix socket limit" in check.detail


def test_diagnose_checks_a_socket_shared_by_several_routes_once(tmp_path: Path) -> None:
    deployment = _deployment(tmp_path)
    _write_deployment_files(deployment)
    deployment.generated_caddyfile.write_text(
        f"a.example.com {{\n    reverse_proxy unix//{deployment.default_socket}\n}}\n"
        f"b.example.com {{\n    reverse_proxy unix//{deployment.default_socket}\n}}\n",
        encoding="utf-8",
    )

    checks = diagnose_deployment("owner/repo", environment="prod", roots=deployment.roots, runner=DiagnoseRunner())

    assert [check.name for check in checks].count("socket app.sock") == 1
