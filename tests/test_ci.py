import json
import stat
import subprocess

import pytest

from kitshn.ci import (
    deploy_over_ssh,
    destroy_over_ssh,
    preflight_auth,
    resolve_github_action,
    verify_public_route,
    write_params_from_github,
)
from kitshn.httpcheck import HttpResponse
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
        "url=",
    ]


def test_resolve_github_action_uses_pull_request_head_sha(tmp_path, monkeypatch) -> None:
    config = tmp_path / ".kitshn.yaml"
    config.write_text(
        """
deploy:
  - on: pull_request
    name: pr-{pr}
    ephemeral: true
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_SHA", "merge-sha")
    monkeypatch.setenv("GITHUB_REF_NAME", "1/merge")
    monkeypatch.setenv("PR_NUMBER", "1")
    monkeypatch.setenv("PR_ACTION", "opened")
    monkeypatch.setenv("PR_HEAD_REF", "example")
    monkeypatch.setenv("PR_HEAD_SHA", "head-sha")

    result = resolve_github_action(config)

    assert result.output_lines() == [
        "matched=true",
        "env=pr-1",
        "action=deploy",
        "ephemeral=true",
        "ref=head-sha",
        "url=",
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


def test_preflight_auth_names_missing_keys_and_the_fix(monkeypatch, capsys) -> None:
    monkeypatch.delenv("KITSHN_VPS_HOST", raising=False)
    monkeypatch.setenv("KITSHN_SSH_KEY", "key")

    with pytest.raises(KitshnError, match="missing KITSHN_VPS_HOST: run `kitshn recipe auth"):
        preflight_auth()
    assert capsys.readouterr().out.startswith("::error::missing KITSHN_VPS_HOST")

    monkeypatch.setenv("KITSHN_VPS_HOST", "deploy@vps")
    preflight_auth()


def test_resolve_github_action_emits_the_inferred_public_url(tmp_path, monkeypatch) -> None:
    (tmp_path / ".kitshn.yaml").write_text("deploy:\n  - on: push\n    branch: main\n    name: prod\n", encoding="utf-8")
    (tmp_path / "Caddyfile.j2").write_text("site.example.com {\n    reverse_proxy unix//{{ paths.default_socket }}\n}\n", encoding="utf-8")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("GITHUB_SHA", "abcdef123456")
    monkeypatch.setenv("GITHUB_REF_NAME", "main")
    monkeypatch.setenv("GITHUB_REPOSITORY", "Owner/site")

    result = resolve_github_action(tmp_path / ".kitshn.yaml")

    assert result.url == "https://site.example.com"
    assert "url=https://site.example.com" in result.output_lines()


def test_verify_public_route_writes_summary_and_fails_on_bad_status(tmp_path, monkeypatch, capsys) -> None:
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setenv("KITSHN_URL", "https://site.example.com")
    monkeypatch.setenv("KITSHN_VERIFY_TIMEOUT", "0")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    verify_public_route(fetch=lambda _url: HttpResponse(200, "text/html", ""), sleep=lambda _s: None)

    assert "| https://site.example.com | 200 | text/html |" in summary.read_text(encoding="utf-8")
    assert "status=200" in capsys.readouterr().out

    with pytest.raises(KitshnError, match="public route returned 502"):
        verify_public_route(fetch=lambda _url: HttpResponse(502, "text/plain", "bad"), sleep=lambda _s: None)


def test_verify_public_route_skips_without_url(tmp_path, monkeypatch) -> None:
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setenv("KITSHN_URL", "")

    verify_public_route(fetch=lambda _url: (_ for _ in ()).throw(AssertionError("must not fetch")))

    assert "No public URL inferred" in summary.read_text(encoding="utf-8")
