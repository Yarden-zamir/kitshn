# Release

Releases are automatic. `.github/workflows/release.yml` runs on every push to `main`:

1. `tests/test_version.py` checks that `pyproject.toml`, `src/kitshn/__init__.py`, and
   `uv.lock` carry the same version. A mismatch fails the workflow before anything is tagged.
2. The workflow reads the version with `uv version --short`. When tag `vX.Y.Z` already exists,
   the workflow stops; nothing is released. Merges that do not bump the version release nothing.
3. Otherwise it creates tag `vX.Y.Z`, pushes it, and creates a GitHub release with generated
   notes.
4. It then calls `Yarden-zamir/homebrew-tap/.github/workflows/sync-formula.yml` with the tag
   and the `TOKEN` secret. `TOKEN` must exist on the KitSHn repo as a personal access token
   with write access to `Yarden-zamir/homebrew-tap`, the same one the other publisher repos
   use; without it the sync falls back to `github.token`, which cannot push to the tap. The sync renders `.homebrew/kitshn.rb` into the tap, updates the
   tap README, validates style and drift, and opens an automerge pull request.

The release is created with `GITHUB_TOKEN`, and events created by that token do not start
other workflows, so `release.yml` calls the tap sync directly instead of relying on the
`release: published` trigger in `homebrew.yml`. `homebrew.yml` remains for manual recovery:
dispatch it with a tag to re-sync the tap, or publish a release by hand.

## To Release

Bump the version in `pyproject.toml` and `src/kitshn/__init__.py`, run `uv lock`, run
`uv run ruff check .`, `uv run ty check`, and `uv run pytest`, then merge to `main`. Use a
minor bump for new commands or changed generated files and a patch bump for fixes.

## Version Check In The CLI

`kitshn self-check` compares `__version__` with the latest GitHub release, falling back to
the highest `v*` tag when no release exists, and prints the upgrade command for the detected
install: `brew upgrade kitshn` when the Homebrew wrapper's `KITSHN_SOURCE_REF` is set, else
`uv tool upgrade kitshn` and the `uvx --refresh` form. It exits non-zero when outdated.

## Formula

KitSHn's Homebrew formula behavior lives in `.homebrew/kitshn.rb`. Do not hand-edit
`Yarden-zamir/homebrew-tap/Formula/kitshn.rb` except for emergency recovery; move formula
behavior changes back to `.homebrew/kitshn.rb`.
