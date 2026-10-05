from pathlib import Path
from collections.abc import Mapping, Sequence

import pytest

from kitshn.ci import teardown_flags
from kitshn.deploy import destroy_deployment
from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots
from kitshn.prune import find_leftovers, remove_leftovers
from kitshn.resolve import parse_keep
from kitshn.runner import CommandResult, CommandRunner


class Recorder(CommandRunner):
    def __init__(self, *, volumes: str = "", images: str = "", dry_run: bool = False) -> None:
        super().__init__(dry_run=dry_run)
        self.volumes = volumes
        self.images = images
        self.commands: list[tuple[str, ...]] = []
        self.cwds: list[Path | None] = []

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
        self.cwds.append(cwd)
        out = ""
        if command[:3] == ("docker", "volume", "ls"):
            out = self.volumes
        elif command[:3] == ("docker", "image", "ls"):
            # The fake keeps "id<TAB>project" rows and answers a per-project label filter.
            wanted = command[-1].removeprefix("label=com.docker.compose.project=")
            out = "".join(f"{image}\n" for image, _, project in (row.partition("\t") for row in self.images.splitlines()) if project == wanted)
        return CommandResult(args=args, returncode=0, stdout=out, stderr="")


def _roots(tmp_path: Path) -> Roots:
    return Roots(deployments=tmp_path / "d", params=tmp_path / "p", persistent=tmp_path / "s", logs=tmp_path / "l")


def _preview(tmp_path: Path, environment: str = "pr-7") -> Deployment:
    deployment = Deployment.create(Recipe.parse("owner/site"), environment, _roots(tmp_path))
    for path in (
        deployment.deployment_root / "compose.yml",
        deployment.params_file,
        deployment.persistent_root / "uploads" / "a.jpg",
        deployment.persistent_root / "cache" / "b.bin",
        deployment.logs_root / "app" / "app.log",
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x", encoding="utf-8")
    return deployment


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ([], ()), (["logs", "persistent/uploads/"], ("logs", "persistent/uploads"))],
)
def test_parse_keep_accepts_paths_inside_the_data_folders(value, expected) -> None:
    assert parse_keep(value) == expected


@pytest.mark.parametrize("value", ["logs", ["params"], ["/persistent"], ["persistent/../params"], [3], [""]])
def test_parse_keep_rejects_anything_outside_them(value) -> None:
    with pytest.raises(KitshnError, match="keep"):
        parse_keep(value)


@pytest.mark.parametrize(
    ("keep", "flags"),
    [
        (None, ["--volumes"]),
        ("[]", ["--volumes", "--purge"]),
        ('["logs", "persistent/uploads"]', ["--volumes", "--keep", "logs", "--keep", "persistent/uploads"]),
    ],
)
def test_teardown_flags_follow_the_entry_keep_list(monkeypatch, keep, flags) -> None:
    if keep is None:
        monkeypatch.delenv("KITSHN_KEEP", raising=False)
    else:
        monkeypatch.setenv("KITSHN_KEEP", keep)
    assert teardown_flags() == flags


def test_destroy_keeps_only_the_listed_paths_and_removes_volumes_without_a_compose_file(tmp_path: Path) -> None:
    deployment = _preview(tmp_path)
    (deployment.deployment_root / "compose.yml").unlink()
    runner = Recorder()

    destroy_deployment("owner/site", environment="pr-7", keep=("persistent/uploads",), volumes=True, roots=deployment.roots, runner=runner)

    down = next(command for command in runner.commands if "down" in command)
    assert down == ("docker", "compose", "--project-name", "owner-site-pr-7", "down", "--remove-orphans", "--rmi", "local", "--volumes")
    # Compose runs where no compose file is, and finds the project by its label.
    assert runner.cwds[runner.commands.index(down)] == deployment.roots.deployments
    assert (deployment.persistent_root / "uploads" / "a.jpg").exists()
    assert not (deployment.persistent_root / "cache").exists()
    assert not deployment.logs_root.joinpath("app").exists()
    assert not deployment.deployment_root.exists() and not deployment.params_root.exists()


def test_destroy_without_keep_keeps_both_data_folders_and_volumes(tmp_path: Path) -> None:
    deployment = _preview(tmp_path)
    runner = Recorder()

    destroy_deployment("owner/site", environment="pr-7", roots=deployment.roots, runner=runner)

    assert "--volumes" not in next(command for command in runner.commands if "down" in command)
    assert (deployment.persistent_root / "cache" / "b.bin").exists()
    assert (deployment.logs_root / "app" / "app.log").exists()


def test_destroy_dry_run_removes_nothing(tmp_path: Path, capsys) -> None:
    deployment = _preview(tmp_path)

    destroy_deployment("owner/site", environment="pr-7", purge=True, roots=deployment.roots, runner=Recorder(dry_run=True))

    assert deployment.deployment_root.exists() and deployment.persistent_root.exists()
    assert f"+ rm -rf {deployment.persistent_root}" in capsys.readouterr().out


def test_destroy_rejects_purge_with_keep(tmp_path: Path) -> None:
    with pytest.raises(KitshnError, match="either --purge or --keep"):
        destroy_deployment("owner/site", environment="pr-7", purge=True, keep=("logs",), roots=_roots(tmp_path), runner=Recorder())


def test_prune_finds_removed_environments_and_matches_docker_by_exact_project(tmp_path: Path) -> None:
    live = _preview(tmp_path, "prod")
    gone = _preview(tmp_path, "pr-7")
    for path in (gone.deployment_root, gone.params_root):
        __import__("shutil").rmtree(path)
    runner = Recorder(
        volumes="owner-site-pr-7_sessions\towner-site-pr-7\nowner-site-prod_data\towner-site-prod\n",
        # The second image belongs to another recipe whose name starts the same way.
        images="sha1\towner-site-pr-7\nsha2\towner-site-api-pr-7\nsha1\towner-site-pr-7\n",
    )

    leftovers = find_leftovers(Recipe.parse("owner/site"), live.roots, runner)

    assert [item.deployment.environment for item in leftovers] == ["pr-7"]
    item = leftovers[0]
    assert item.volumes == ("owner-site-pr-7_sessions",) and item.images == ("sha1",)
    assert set(item.folders) == {gone.persistent_root, gone.logs_root}

    remove_leftovers(leftovers, live.roots, runner)

    assert ("docker", "volume", "rm", "owner-site-pr-7_sessions") in runner.commands
    assert ("docker", "image", "rm", "sha1") in runner.commands
    assert not gone.persistent_root.exists() and live.persistent_root.exists()
