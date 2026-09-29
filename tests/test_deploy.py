from pathlib import Path
from collections.abc import Mapping, Sequence
import json
import threading

import pytest

from kitshn.compose import ignored_dotenv_warning
from kitshn.deploy import deploy_recipe, deploy_warnings
from kitshn.errors import KitshnError
from kitshn.filesystem import host_deploy_lock
import kitshn.filesystem
from kitshn.models import Deployment, Recipe, Roots
from kitshn.runner import CommandResult, CommandRunner


class DeployRunner(CommandRunner):
    """Fails the first command whose arguments contain `fail_on`."""

    def __init__(self, fail_on: str, *, tracked: frozenset[str] = frozenset(), socket: Path | None = None) -> None:
        super().__init__()
        self.fail_on = fail_on
        self.tracked = tracked
        self.socket = socket
        self.socket_at: dict[str, bool] = {}
        self.commands: list[tuple[str, ...]] = []

    def exists(self, executable: str) -> bool:
        return False

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
        if self.socket is not None:
            for step in ("build", "up"):
                if step in command:
                    self.socket_at[step] = self.socket.exists()
        if command[:3] == ("git", "ls-files", "--error-unmatch"):
            code = 0 if command[3] in self.tracked else 1
            return CommandResult(args=args, returncode=code, stdout="", stderr="")
        if self.fail_on in command:
            raise KitshnError(f"command failed (1): {' '.join(command)}")
        if command[:2] == ("git", "rev-parse"):
            return CommandResult(args=args, returncode=0, stdout="abc123\n", stderr="")
        if command[-3:] == ("config", "--format", "json"):
            config = {"services": {"site": {"build": {"context": "."}}}}
            return CommandResult(args=args, returncode=0, stdout=json.dumps(config), stderr="")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def _live_deployment(tmp_path: Path) -> tuple[Deployment, Path]:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    deployment = Deployment.create(Recipe.parse("owner/site"), "prod", roots)
    deployment.socket_root.mkdir(parents=True)
    deployment.default_socket.write_bytes(b"")
    (deployment.deployment_root / ".git").mkdir()
    (deployment.deployment_root / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    deployment.generated_caddyfile.write_text("site.example.com {\n}\n", encoding="utf-8")
    params = tmp_path / "params.env"
    params.write_text("", encoding="utf-8")
    return deployment, params


@pytest.mark.parametrize("fail_on", ["fetch", "build"])
def test_a_deploy_that_fails_before_compose_up_keeps_the_live_route_and_socket(
    tmp_path: Path, fail_on: str
) -> None:
    deployment, params = _live_deployment(tmp_path)

    with pytest.raises(KitshnError):
        deploy_recipe(
            "owner/site",
            params_file=params,
            ref="main",
            environment="prod",
            roots=deployment.roots,
            runner=DeployRunner(fail_on),
        )

    # Another recipe's Caddy reload rebuilds the manifest from generated Caddyfiles, so the
    # route survives only while this file exists.
    assert deployment.generated_caddyfile.read_text(encoding="utf-8") == "site.example.com {\n}\n"
    assert deployment.default_socket.exists()


def test_host_deploy_lock_serializes_and_names_the_holder(tmp_path: Path, capsys) -> None:
    roots = Roots(deployments=tmp_path / "deployments")
    acquired = threading.Event()
    release = threading.Event()

    def hold() -> None:
        with host_deploy_lock(roots, "owner/first/prod"):
            acquired.set()
            release.wait(5)

    holder = threading.Thread(target=hold)
    holder.start()
    acquired.wait(5)
    try:
        with pytest.raises(KitshnError, match="held by owner/first/prod"):
            with host_deploy_lock(roots, "owner/second/prod", timeout_seconds=0):
                pass
    finally:
        release.set()
        holder.join(5)

    with host_deploy_lock(roots, "owner/second/prod", timeout_seconds=0):
        pass
    assert (roots.deployments / ".kitshn-deploy.lock").read_text(encoding="utf-8") == ""


def test_ignored_dotenv_warning_names_the_keys(tmp_path: Path) -> None:
    assert ignored_dotenv_warning(tmp_path) is None
    (tmp_path / ".env").write_text("# comment\nCOMPOSE_PROFILES=auth\nexport LOG_TZ=UTC\n\n", encoding="utf-8")

    warning = ignored_dotenv_warning(tmp_path)

    assert warning is not None
    assert "(COMPOSE_PROFILES, LOG_TZ)" in warning
    assert "kitshn params set" in warning


def test_deploy_warnings_cover_dotenv_and_long_socket_paths(tmp_path: Path) -> None:
    roots = Roots(deployments=tmp_path / ("d" * 60))
    deployment = Deployment.create(Recipe.parse("owner/" + "r" * 40), "prod", roots)
    deployment.deployment_root.mkdir(parents=True)
    (deployment.deployment_root / ".env").write_text("TOKEN=x\n", encoding="utf-8")

    warnings = deploy_warnings(deployment)

    assert deployment.default_socket_too_long is True
    assert len(warnings) == 2
    assert any("TOKEN" in warning for warning in warnings)
    assert any("Unix socket limit" in warning for warning in warnings)


def _deploy(deployment: Deployment, params: Path, runner: DeployRunner) -> None:
    deploy_recipe(
        "owner/site", params_file=params, ref="main", environment="prod", roots=deployment.roots, runner=runner
    )


def test_sockets_are_cleared_after_build_and_before_up(tmp_path: Path) -> None:
    deployment, params = _live_deployment(tmp_path)
    runner = DeployRunner("never", socket=deployment.default_socket)

    _deploy(deployment, params, runner)

    assert runner.socket_at == {"build": True, "up": False}


def test_a_render_failure_keeps_the_live_route(tmp_path: Path) -> None:
    deployment, params = _live_deployment(tmp_path)
    (deployment.deployment_root / "Caddyfile.j2").write_text("{{ undefined_name }}\n", encoding="utf-8")

    with pytest.raises(Exception, match="undefined_name"):
        _deploy(deployment, params, DeployRunner("never"))

    assert deployment.generated_caddyfile.read_text(encoding="utf-8") == "site.example.com {\n}\n"


def test_a_tracked_root_caddyfile_is_refused_and_the_live_route_restored(tmp_path: Path) -> None:
    deployment, params = _live_deployment(tmp_path)

    class CheckoutOverwrites(DeployRunner):
        def run(self, args, **kwargs):
            if tuple(args[:2]) == ("git", "checkout"):
                deployment.generated_caddyfile.write_text("committed {\n}\n", encoding="utf-8")
            return super().run(args, **kwargs)

    with pytest.raises(KitshnError, match="commits a root Caddyfile"):
        _deploy(deployment, params, CheckoutOverwrites("never", tracked=frozenset({"Caddyfile"})))

    assert deployment.generated_caddyfile.read_text(encoding="utf-8") == "site.example.com {\n}\n"


def test_deploy_waits_for_the_host_lock(tmp_path: Path, monkeypatch) -> None:
    deployment, params = _live_deployment(tmp_path)
    monkeypatch.setattr(kitshn.filesystem, "DEPLOY_LOCK_TIMEOUT_SECONDS", 0)

    with host_deploy_lock(deployment.roots, "owner/other/prod"):
        with pytest.raises(KitshnError, match="held by owner/other/prod"):
            _deploy(deployment, params, DeployRunner("never"))


def test_deploy_prints_the_dotenv_warning_before_a_later_failure(tmp_path: Path, capsys) -> None:
    deployment, params = _live_deployment(tmp_path)
    (deployment.deployment_root / ".env").write_text("COMPOSE_PROFILES=auth\n", encoding="utf-8")

    with pytest.raises(KitshnError):
        _deploy(deployment, params, DeployRunner("build"))

    assert "::warning title=KitSHn::.env in the recipe" in capsys.readouterr().out
