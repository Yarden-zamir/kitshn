import json
import stat

import pytest

from kitshn.ci import resolve_github_action, write_params_from_github
from kitshn.errors import KitshnError


def test_write_params_from_github_filters_and_strips_prefix(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv(
        "KITSHN_VARS_JSON",
        json.dumps(
            {
                "KITSHN_PUBLIC_URL": "https://example.com",
                "UNRELATED": "ignored",
                "KITSHN_VPS_HOST": "server",
            }
        ),
    )
    monkeypatch.setenv(
        "KITSHN_SECRETS_JSON",
        json.dumps({"KITSHN_TOKEN": "secret", "KITSHN_SSH_KEY": "private-key"}),
    )
    output = tmp_path / "params.env"

    write_params_from_github(output)

    assert output.read_text(encoding="utf-8") == 'PUBLIC_URL="https://example.com"\nTOKEN="secret"\n'
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def test_write_params_from_github_rejects_invalid_stripped_names(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("KITSHN_VARS_JSON", json.dumps({"KITSHN_BAD-NAME": "value"}))
    monkeypatch.delenv("KITSHN_SECRETS_JSON", raising=False)

    with pytest.raises(KitshnError):
        write_params_from_github(tmp_path / "params.env")


def test_resolve_github_action_uses_config_without_topic_check(tmp_path, monkeypatch) -> None:
    config = tmp_path / ".kitshn.yaml"
    config.write_text(
        """
deploy:
  - on: push
    branch: main
    name: prod
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("GITHUB_SHA", "abcdef123456")
    monkeypatch.setenv("GITHUB_REF_NAME", "main")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    result = resolve_github_action(config)

    assert result.output_lines() == [
        "matched=true",
        "env=prod",
        "action=deploy",
        "ephemeral=false",
        "ref=abcdef123456",
    ]
