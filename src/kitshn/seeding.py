from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import shlex

from .errors import KitshnError
from .models import Recipe
from .runner import CommandRunner
from .templates import init_recipe


@dataclass(frozen=True, slots=True)
class SeedResult:
    created_files: list[Path]
    private_key: Path
    public_key: Path
    authorized_key: bool


def seed_recipe(
    recipe_name: str,
    *,
    template: str,
    target_dir: Path,
    vps_host: str,
    runner: CommandRunner,
    key_path: Path | None = None,
    force: bool = False,
    authorize_key: bool = True,
) -> SeedResult:
    recipe = Recipe.parse(recipe_name)
    private_key = (key_path or _default_key_path(recipe)).expanduser()
    public_key = Path(f"{private_key}.pub")
    _prepare_key_path(private_key, public_key, force=force)

    created_files = init_recipe(recipe.full_name, template=template, target_dir=target_dir, force=force)
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

    if authorize_key:
        _authorize_public_key(vps_host, public_key, runner)

    runner.run(
        ["gh", "secret", "set", "KITSHN_SSH_KEY", "--repo", recipe.full_name, "--body-file", str(private_key)]
    )
    runner.run(
        ["gh", "variable", "set", "KITSHN_VPS_HOST", "--repo", recipe.full_name, "--body", vps_host]
    )

    return SeedResult(
        created_files=created_files,
        private_key=private_key,
        public_key=public_key,
        authorized_key=authorize_key,
    )


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


def _authorize_public_key(vps_host: str, public_key: Path, runner: CommandRunner) -> None:
    if runner.dry_run:
        key = "DRY-RUN-PUBLIC-KEY"
    elif public_key.exists():
        key = public_key.read_text(encoding="utf-8").strip()
    else:
        msg = f"generated public key does not exist: {public_key}"
        raise KitshnError(msg)
    if not key:
        msg = f"generated public key is empty: {public_key}"
        raise KitshnError(msg)

    quoted_key = shlex.quote(key)
    command = (
        "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; "
        f"grep -qxF {quoted_key} ~/.ssh/authorized_keys || "
        f"printf '%s\n' {quoted_key} >> ~/.ssh/authorized_keys"
    )
    runner.run(["ssh", vps_host, command])
