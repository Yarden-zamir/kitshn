import json
import stat
import subprocess

import pytest

from kitshn.ci import deploy_over_ssh, destroy_over_ssh, resolve_github_action, write_params_from_github
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


def test_deploy_over_ssh_uses_hosted_cli_on_remote(tmp_path, monkeypatch) -> None:
    params_file = tmp_path / "params.env"
    params_file.write_text("TOKEN=secret\n", encoding="utf-8")
    commands: list[list[str]] = []

    def fake_run(args, check):
        commands.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("GITHUB_REPOSITORY", "Owner/my-app")
    monkeypatch.setenv("KITSHN_VPS_HOST", "deploy@example.com")
    monkeypatch.setenv("KITSHN_SSH_KEY", "private-key")
    monkeypatch.setenv("KITSHN_ENVIRONMENT", "prod")
    monkeypatch.setenv("KITSHN_REF", "abcdef123456")
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")

    deploy_over_ssh(params_file)

    assert commands[0][0] == "scp"
    assert commands[1][0] == "ssh"
    remote_command = commands[1][-1]
    assert "export PATH=$HOME/.local/bin:$PATH" in remote_command
    assert "uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn deploy" in remote_command
    assert "status=$?" in remote_command
    assert "rm -f /tmp/kitshn-123-2.env" in remote_command
    assert "exit $status" in remote_command


def test_destroy_over_ssh_uses_hosted_cli_on_remote(monkeypatch) -> None:
    commands: list[list[str]] = []

    def fake_run(args, check):
        commands.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("GITHUB_REPOSITORY", "Owner/my-app")
    monkeypatch.setenv("KITSHN_VPS_HOST", "deploy@example.com")
    monkeypatch.setenv("KITSHN_SSH_KEY", "private-key")
    monkeypatch.setenv("KITSHN_ENVIRONMENT", "prod")

    destroy_over_ssh()

    assert commands[0][0] == "ssh"
    remote_command = commands[0][-1]
    assert "export PATH=$HOME/.local/bin:$PATH" in remote_command
    assert "uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn destroy" in remote_command
