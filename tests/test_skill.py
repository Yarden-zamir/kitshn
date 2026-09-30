from pathlib import Path

import pytest

from kitshn.cli import _link_skill, _skill_dir
from kitshn.errors import KitshnError


def _skill(root: Path) -> Path:
    skill = root / "kitshn-deploy-service"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: kitshn-deploy-service\n---\n", encoding="utf-8")
    return skill


def test_skill_dir_prefers_the_stable_path_from_the_environment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KITSHN_SKILL_DIR", str(tmp_path / "stable"))
    assert _skill_dir() == tmp_path / "stable"
    monkeypatch.delenv("KITSHN_SKILL_DIR")
    assert (_skill_dir() / "SKILL.md").is_file()


def test_link_skill_replaces_a_link_to_another_copy_of_the_skill(tmp_path: Path, monkeypatch) -> None:
    current = _skill(tmp_path / "current")
    monkeypatch.setenv("KITSHN_SKILL_DIR", str(current))
    skills_root = tmp_path / "skills"
    skills_root.mkdir()
    # An older version's path, since pruned from uv's cache.
    (skills_root / "kitshn-deploy-service").symlink_to(tmp_path / "gone" / "kitshn-deploy-service")

    target = _link_skill(skills_root)

    assert target.resolve() == current.resolve()


def test_link_skill_never_replaces_a_directory_or_a_foreign_link(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KITSHN_SKILL_DIR", str(_skill(tmp_path / "current")))
    skills_root = tmp_path / "skills"
    _skill(skills_root)
    with pytest.raises(KitshnError, match="refusing to replace"):
        _link_skill(skills_root)

    other_root = tmp_path / "other-skills"
    other_root.mkdir()
    (other_root / "kitshn-deploy-service").symlink_to(tmp_path / "my-own-notes")
    with pytest.raises(KitshnError, match="refusing to replace"):
        _link_skill(other_root)
