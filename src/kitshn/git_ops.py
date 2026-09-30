from __future__ import annotations

import json
from pathlib import Path
import shutil

from .errors import KitshnError
from .models import Deployment
from .runner import CommandRunner


def checkout_recipe(deployment: Deployment, ref: str | None, runner: CommandRunner) -> tuple[str | None, str]:
    root = deployment.deployment_root
    auth = _github_auth_args(runner)
    if not (root / ".git").exists():
        runner.run(["git", "init"], cwd=root)
        runner.run(["git", "remote", "add", "origin", deployment.recipe.remote_url], cwd=root)
    else:
        runner.run(["git", "remote", "set-url", "origin", deployment.recipe.remote_url], cwd=root)

    current = _current_ref(root, runner)
    runner.run(
        [
            "git",
            *auth,
            "fetch",
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
            "+refs/tags/*:refs/tags/*",
        ],
        cwd=root,
    )

    target = ref or _remote_default_branch(root, runner, auth)
    checkout_target = _checkout_target(root, target, runner)
    runner.run(["git", "checkout", "--force", "--detach", checkout_target], cwd=root)
    checked_out = _current_ref(root, runner)
    if checked_out is None:
        msg = f"failed to resolve checked out ref in {root}"
        raise KitshnError(msg)
    return current, checked_out


def _current_ref(root: Path, runner: CommandRunner) -> str | None:
    result = runner.run(["git", "rev-parse", "HEAD"], cwd=root, capture=True, check=False)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _remote_default_branch(root: Path, runner: CommandRunner, auth: list[str]) -> str:
    result = runner.run(
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd=root,
        capture=True,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip().startswith("refs/remotes/origin/"):
        return result.stdout.strip().removeprefix("refs/remotes/origin/")

    result = runner.run(
        ["git", *auth, "ls-remote", "--symref", "origin", "HEAD"], cwd=root, capture=True
    )
    for line in result.stdout.splitlines():
        if line.startswith("ref:\trefs/heads/") and line.endswith("\tHEAD"):
            return line.split("\t", 2)[1].removeprefix("refs/heads/")
    return "main"


def _checkout_target(root: Path, ref: str, runner: CommandRunner) -> str:
    remote_branch = f"refs/remotes/origin/{ref}"
    result = runner.run(
        ["git", "rev-parse", "--verify", "--quiet", remote_branch],
        cwd=root,
        capture=True,
        check=False,
    )
    if result.returncode == 0:
        return f"origin/{ref}"
    return ref


def _github_auth_args(runner: CommandRunner) -> list[str]:
    """Git options that use gh as the credential helper for github.com, for one command only.

    This is how gh runs its own git commands. `gh auth setup-git` writes the same setting into
    the deploy user's ~/.gitconfig instead, and concurrent deploys raced on that file's lock.
    Git asks the helper only when the remote requires auth, so public repos never call it, and
    a private repo without `gh auth login` fails the fetch as before.
    """

    if not runner.exists("gh"):
        return []
    gh_path = shutil.which("gh") or "gh"
    key = "credential.https://github.com.helper"
    # The empty value first drops helpers from global config, as gh does.
    return ["-c", f"{key}=", "-c", f"{key}=!{json.dumps(gh_path)} auth git-credential"]
