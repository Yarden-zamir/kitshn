from collections.abc import Mapping, Sequence
import json
from pathlib import Path

import pytest

from kitshn.ci import write_params_from_github
from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots
from kitshn.params import ParamWrite, param_summaries, param_value, set_github_param
from kitshn.runner import CommandResult, CommandRunner


def _deployment(tmp_path) -> Deployment:
    roots = Roots(
        deployments=tmp_path / "deployments",
        params=tmp_path / "params",
        persistent=tmp_path / "persistent",
        logs=tmp_path / "logs",
    )
    return Deployment.create(Recipe("owner", "repo"), "prod", roots)


def _write_params(deployment: Deployment, values: dict[str, str], monkeypatch) -> None:
    """Write params.env through the real CI writer, so tests cover the true on-disk format."""

    monkeypatch.setenv("KITSHN_VARS_JSON", "{}")
    monkeypatch.setenv(
        "KITSHN_SECRETS_JSON",
        json.dumps({f"KITSHN_{key}": value for key, value in values.items()}),
    )
    deployment.params_file.parent.mkdir(parents=True, exist_ok=True)
    write_params_from_github(deployment.params_file)


@pytest.mark.parametrize(
    "value",
    ["abc123", 'a"b', "c:\\path", "sk-$pecial", "multi word", ""],
)
def test_param_value_round_trips_what_ci_wrote(tmp_path, monkeypatch, value) -> None:
    deployment = _deployment(tmp_path)
    _write_params(deployment, {"TOKEN": value}, monkeypatch)

    assert param_value(deployment, "TOKEN") == value


def test_param_summaries_report_presence_without_values(tmp_path, monkeypatch) -> None:
    deployment = _deployment(tmp_path)
    _write_params(deployment, {"TOKEN": "secret", "EMPTY": ""}, monkeypatch)

    summaries = param_summaries(deployment)

    assert [(item.key, item.empty) for item in summaries] == [("EMPTY", True), ("TOKEN", False)]


def test_param_value_rejects_unknown_key(tmp_path, monkeypatch) -> None:
    deployment = _deployment(tmp_path)
    _write_params(deployment, {"TOKEN": "secret"}, monkeypatch)

    with pytest.raises(KitshnError, match="not found"):
        param_value(deployment, "MISSING")


def test_read_params_rejects_missing_params_file(tmp_path) -> None:
    deployment = _deployment(tmp_path)

    with pytest.raises(KitshnError, match="no params file"):
        param_summaries(deployment)


class GhRunner(CommandRunner):
    def __init__(self, *, environment_exists: bool = True) -> None:
        super().__init__()
        self.environment_exists = environment_exists
        self.calls: list[tuple[tuple[str, ...], str | None]] = []

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
        input_text: str | None = None,
    ) -> CommandResult:
        command = tuple(args)
        self.calls.append((command, input_text))
        if command[:2] == ("gh", "api") and "--method" not in command and not self.environment_exists:
            return CommandResult(args=args, returncode=1, stdout="", stderr="gh: Not Found (HTTP 404)")
        return CommandResult(args=args, returncode=0, stdout="", stderr="")


def _set(
    runner: GhRunner,
    name: str = "TOKEN",
    value: str = "s3cret",
    *,
    environment: str | None = "prod",
    secret: bool = True,
    create_environment: bool = False,
) -> ParamWrite:
    return set_github_param(
        Recipe("Owner", "site"),
        name,
        value,
        environment=environment,
        secret=secret,
        create_environment=create_environment,
        runner=runner,
    )


def test_params_set_writes_an_environment_secret_through_stdin() -> None:
    runner = GhRunner()

    result = _set(runner)

    assert (result.github_name, result.kind, result.scope) == ("KITSHN_TOKEN", "secret", "environment:prod")
    command, stdin = runner.calls[-1]
    assert command == ("gh", "secret", "set", "KITSHN_TOKEN", "--repo", "Owner/site", "--env", "prod")
    # The value travels on stdin, never in the argument list.
    assert stdin == "s3cret" and "s3cret" not in command


def test_params_set_repo_wide_variable_skips_the_environment_check() -> None:
    runner = GhRunner()

    result = _set(runner, name="LOG_TZ", value="UTC", environment=None, secret=False)

    assert result.scope == "repository"
    assert [call[0][:3] for call in runner.calls] == [("gh", "variable", "set")]
    assert runner.calls[0][0][-2:] == ("--body", "UTC")


def test_params_set_refuses_a_missing_environment_unless_asked_to_create_it() -> None:
    with pytest.raises(KitshnError, match="does not exist.*--create-environment"):
        _set(GhRunner(environment_exists=False))

    runner = GhRunner(environment_exists=False)
    result = _set(runner, create_environment=True)
    assert result.created_environment is True
    assert ("gh", "api", "--method", "PUT", "repos/Owner/site/environments/prod") in [call[0] for call in runner.calls]


@pytest.mark.parametrize(
    ("name", "value", "match"),
    [
        ("KITSHN_TOKEN", "x", "without the KITSHN_ prefix"),
        ("BAD-NAME", "x", "letters, digits, and underscores"),
        ("SSH_KEY", "x", "reserved"),
        ("TOKEN", "", "empty value"),
    ],
)
def test_params_set_rejects_names_and_values_that_would_fail_silently(name, value, match) -> None:
    runner = GhRunner()
    with pytest.raises(KitshnError, match=match):
        _set(runner, name=name, value=value)
    assert runner.calls == []
