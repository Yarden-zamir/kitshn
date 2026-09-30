from __future__ import annotations

from dataclasses import dataclass

from .errors import KitshnError
from .filesystem import read_env_file
from .models import Deployment


@dataclass(frozen=True, slots=True)
class ParamSummary:
    key: str
    empty: bool


def read_params(deployment: Deployment) -> dict[str, str]:
    if not deployment.params_file.exists():
        msg = f"deployment has no params file: {deployment.params_file}"
        raise KitshnError(msg)
    return read_env_file(deployment.params_file)


def param_summaries(deployment: Deployment) -> list[ParamSummary]:
    params = read_params(deployment)
    return [ParamSummary(key=key, empty=not params[key]) for key in sorted(params)]


def param_value(deployment: Deployment, key: str) -> str:
    params = read_params(deployment)
    if key not in params:
        known = ", ".join(sorted(params)) or "none"
        msg = f"param {key!r} not found in {deployment.params_file}; known params: {known}"
        raise KitshnError(msg)
    return params[key]
