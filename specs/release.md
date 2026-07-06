# Release
KitSHn's Homebrew formula behavior lives in `.homebrew/kitshn.rb`.

Release steps:

1. Update `pyproject.toml`, `src/kitshn/__init__.py`, and `uv.lock` to the same version.
2. Run `uv run ruff check .`, `uv run ty check`, and `uv run pytest`.
3. Commit, tag `vX.Y.Z`, and push `main` plus the tag.
4. Publish a GitHub release or dispatch `.github/workflows/homebrew.yml` with the tag.

The workflow calls `Yarden-zamir/homebrew-tap/.github/workflows/sync-formula.yml`, which renders the formula into the tap from `.homebrew/kitshn.rb`, updates the tap README, validates style/drift, and opens an automerge PR.

Do not hand-edit `Yarden-zamir/homebrew-tap/Formula/kitshn.rb` except for emergency recovery; move formula behavior changes back to `.homebrew/kitshn.rb`.
