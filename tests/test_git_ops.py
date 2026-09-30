from pathlib import Path
from collections.abc import Mapping, Sequence

from kitshn.git_ops import checkout_recipe
from kitshn.models import Deployment, Recipe, Roots
from kitshn.runner import CommandResult, CommandRunner

HELPER_KEY = "credential.https://github.com.helper"


class GitRunner(CommandRunner):
    def __init__(self, *, has_gh: bool) -> None:
        super().__init__()
        self.has_gh = has_gh
        self.commands: list[tuple[str, ...]] = []

    def exists(self, executable: str) -> bool:
        return self.has_gh and executable == "gh"

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
        if command[:2] == ("git", "rev-parse"):
            return CommandResult(args=args, returncode=0, stdout="abc123\n", stderr="")
        if "symbolic-ref" in command:
            return CommandResult(args=args, returncode=1, stdout="", stderr="")
        if "ls-remote" in command:
            return CommandResult(args=args, returncode=0, stdout="ref: refs/heads/main\tHEAD\n", stderr="")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def _deployment(tmp_path: Path) -> Deployment:
    deployment = Deployment.create(Recipe.parse("owner/site"), "prod", Roots(deployments=tmp_path))
    deployment.deployment_root.mkdir(parents=True)
    return deployment


def test_checkout_passes_gh_as_credential_helper_per_command_and_writes_no_config(tmp_path: Path) -> None:
    runner = GitRunner(has_gh=True)

    checkout_recipe(_deployment(tmp_path), None, runner)

    # gh auth setup-git rewrote ~/.gitconfig on every deploy; concurrent deploys raced on it.
    assert not any(command[:2] == ("gh", "auth") for command in runner.commands)
    remote_commands = [command for command in runner.commands if "fetch" in command or "ls-remote" in command]
    assert len(remote_commands) == 2
    for command in remote_commands:
        assert command[1:4] == ("-c", f"{HELPER_KEY}=", "-c")
        assert command[4].startswith(f"{HELPER_KEY}=!") and command[4].endswith(" auth git-credential")
    # Local-only git commands need no credentials.
    assert all("-c" not in command for command in runner.commands if "checkout" in command)


def test_checkout_without_gh_passes_no_helper(tmp_path: Path) -> None:
    runner = GitRunner(has_gh=False)

    checkout_recipe(_deployment(tmp_path), "main", runner)

    fetch = next(command for command in runner.commands if "fetch" in command)
    assert fetch[1] == "fetch"
