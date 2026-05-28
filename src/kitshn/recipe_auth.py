from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import shlex

from .errors import KitshnError
from .models import Recipe
from .runner import CommandRunner


@dataclass(frozen=True, slots=True)
class RecipeAuthResult:
    recipe: Recipe
    private_key: Path
    public_key: Path
    vps_host: str
    authorized_via_ssh: bool


def authorize_recipe(
    *,
    recipe_dir: Path,
    runner: CommandRunner,
    vps_host: str | None = None,
    key_path: Path | None = None,
    force: bool = False,
    authorized_keys: Path | None = None,
) -> RecipeAuthResult:
    recipe = _github_recipe(recipe_dir, runner)
    private_key = (key_path or _default_key_path(recipe)).expanduser()
    public_key = Path(f"{private_key}.pub")
    _prepare_key_path(private_key, public_key, force=force)

    runner.run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-C",
            f"kitshn:{recipe.full_name}",
            "-f",
            str(private_key),
            "-N",
            "",
        ]
    )

    key = _read_public_key(public_key, runner)
    if vps_host is None:
        resolved_host = _local_vps_host(runner)
        _authorize_local_key(key, authorized_keys or Path.home() / ".ssh" / "authorized_keys")
        authorized_via_ssh = False
    else:
        resolved_host = vps_host
        _authorize_remote_key(resolved_host, key, runner)
        authorized_via_ssh = True

    runner.run(
        [
            "gh",
            "secret",
            "set",
            "KITSHN_SSH_KEY",
            "--repo",
            recipe.full_name,
            "--body-file",
            str(private_key),
        ]
    )
    runner.run(
        [
            "gh",
            "variable",
            "set",
            "KITSHN_VPS_HOST",
            "--repo",
            recipe.full_name,
            "--body",
            resolved_host,
        ]
    )

    return RecipeAuthResult(
        recipe=recipe,
        private_key=private_key,
        public_key=public_key,
        vps_host=resolved_host,
        authorized_via_ssh=authorized_via_ssh,
    )


def _github_recipe(recipe_dir: Path, runner: CommandRunner) -> Recipe:
    result = runner.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        cwd=recipe_dir,
        capture=True,
    )
    return Recipe.parse(result.stdout.strip())


def _default_key_path(recipe: Recipe) -> Path:
    slug = re.sub(r"[^a-z0-9_-]+", "-", recipe.full_name.lower()).strip("-")
    return Path.home() / ".ssh" / f"kitshn-{slug}-ed25519"


def _prepare_key_path(private_key: Path, public_key: Path, *, force: bool) -> None:
    if force:
        for path in (private_key, public_key):
            if path.exists():
                path.unlink()
    elif private_key.exists() or public_key.exists():
        msg = f"refusing to overwrite existing SSH key: {private_key}"
        raise KitshnError(msg)
    private_key.parent.mkdir(parents=True, exist_ok=True)


def _read_public_key(public_key: Path, runner: CommandRunner) -> str:
    if runner.dry_run:
        return "DRY-RUN-PUBLIC-KEY"
    if not public_key.exists():
        msg = f"generated public key does not exist: {public_key}"
        raise KitshnError(msg)
    key = public_key.read_text(encoding="utf-8").strip()
    if not key:
        msg = f"generated public key is empty: {public_key}"
        raise KitshnError(msg)
    return key


def _local_vps_host(runner: CommandRunner) -> str:
    if runner.dry_run:
        return "dry-run-vps-host"
    result = runner.run(["hostname", "-f"], capture=True, check=False)
    host = result.stdout.strip()
    if result.returncode == 0 and host:
        return host
    result = runner.run(["hostname"], capture=True)
    host = result.stdout.strip()
    if host:
        return host
    msg = "cannot determine local VPS host; pass --vps-host explicitly"
    raise KitshnError(msg)


def _authorize_local_key(key: str, authorized_keys: Path) -> None:
    authorized_keys.parent.mkdir(parents=True, exist_ok=True)
    existing = authorized_keys.read_text(encoding="utf-8") if authorized_keys.exists() else ""
    lines = existing.splitlines()
    if key not in lines:
        suffix = "" if existing == "" or existing.endswith("\n") else "\n"
        authorized_keys.write_text(existing + suffix + key + "\n", encoding="utf-8")
    authorized_keys.chmod(0o600)


def _authorize_remote_key(vps_host: str, key: str, runner: CommandRunner) -> None:
    quoted_key = shlex.quote(key)
    command = (
        "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; "
        f"grep -qxF {quoted_key} ~/.ssh/authorized_keys || "
        f"printf '%s\n' {quoted_key} >> ~/.ssh/authorized_keys"
    )
    runner.run(["ssh", vps_host, command])
