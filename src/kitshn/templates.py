from __future__ import annotations

from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path

from .errors import KitshnError
from .models import Recipe


def available_templates() -> list[str]:
    root = resources.files("kitshn") / "recipe_templates"
    return sorted(item.name for item in root.iterdir() if item.is_dir())


def init_recipe(
    recipe_name: str,
    *,
    template: str,
    target_dir: Path,
    force: bool = False,
) -> list[Path]:
    recipe = Recipe.parse(recipe_name)
    template_root = resources.files("kitshn") / "recipe_templates" / template
    if not template_root.is_dir():
        msg = f"unknown template {template!r}; available: {', '.join(available_templates())}"
        raise KitshnError(msg)

    created: list[Path] = []
    replacements = {
        "__OWNER__": recipe.owner,
        "__REPO__": recipe.repo,
        "__RECIPE__": recipe.full_name,
    }
    for resource, relative in _walk_template_files(template_root):
        target = target_dir / relative
        if target.exists() and not force:
            msg = f"refusing to overwrite existing file: {target}"
            raise KitshnError(msg)
        target.parent.mkdir(parents=True, exist_ok=True)
        content = resource.read_text(encoding="utf-8")
        for needle, replacement in replacements.items():
            content = content.replace(needle, replacement)
        target.write_text(content, encoding="utf-8")
        created.append(target)
    return created


def _walk_template_files(root: Traversable, prefix: Path = Path()) -> list[tuple[Traversable, Path]]:
    files: list[tuple[Traversable, Path]] = []
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        relative = prefix / child.name
        if child.is_dir():
            files.extend(_walk_template_files(child, relative))
        else:
            files.append((child, relative))
    return files
