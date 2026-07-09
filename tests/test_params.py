import json

import pytest

from kitshn.ci import write_params_from_github
from kitshn.errors import KitshnError
from kitshn.models import Deployment, Recipe, Roots
from kitshn.params import param_summaries, param_value


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
