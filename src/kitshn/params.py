from __future__ import annotations

from dataclasses import dataclass
import urllib.parse

from .ci import ENV_KEY_RE, RESERVED_PARAM_NAMES
from .errors import KitshnError
from .filesystem import read_env_file
from .models import Deployment, Recipe
from .runner import CommandRunner

PARAM_PREFIX = "KITSHN_"


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


@dataclass(frozen=True, slots=True)
class ParamWrite:
    github_name: str
    scope: str
    kind: str
    created_environment: bool


def set_github_param(
    recipe: Recipe,
    name: str,
    value: str,
    *,
    environment: str | None,
    secret: bool,
    create_environment: bool,
    runner: CommandRunner,
) -> ParamWrite:
    """Write one KitSHn param as a GitHub secret or variable, in an environment or repo-wide.

    `environment` None means repo-wide, which every environment sees, pull request previews
    included.
    """

    if name.startswith(PARAM_PREFIX):
        msg = f"pass the param name without the {PARAM_PREFIX} prefix: {name.removeprefix(PARAM_PREFIX)}"
        raise KitshnError(msg)
    if not ENV_KEY_RE.fullmatch(name):
        msg = f"param name must be letters, digits, and underscores, not starting with a digit: {name!r}"
        raise KitshnError(msg)
    github_name = f"{PARAM_PREFIX}{name}"
    if github_name in RESERVED_PARAM_NAMES:
        msg = f"{github_name} is reserved for deploy access; set it with kitshn recipe auth"
        raise KitshnError(msg)
    # gh trims trailing CR and LF from stdin, so a value of only newlines would arrive empty.
    if not value.rstrip("\r\n"):
        msg = f"refusing to set {github_name} to an empty value"
        raise KitshnError(msg)

    created = False
    env_args: list[str] = []
    if environment is not None:
        created = _ensure_environment(recipe, environment, create=create_environment, runner=runner)
        env_args = ["--env", environment]

    kind = "secret" if secret else "variable"
    # Both go on stdin: the value stays out of the process list, and gh trims them the same way.
    runner.run(["gh", kind, "set", github_name, "--repo", recipe.full_name, *env_args], input_text=value)
    scope = f"environment:{environment}" if environment is not None else "repository"
    return ParamWrite(github_name=github_name, scope=scope, kind=kind, created_environment=created)


def _ensure_environment(recipe: Recipe, environment: str, *, create: bool, runner: CommandRunner) -> bool:
    path = f"repos/{recipe.full_name}/environments/{urllib.parse.quote(environment, safe='')}"
    result = runner.run(["gh", "api", path], capture=True, check=False)
    if result.returncode == 0:
        return False
    if "(HTTP 404)" not in result.stderr + result.stdout:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        msg = f"cannot check GitHub Environment {environment!r} in {recipe.full_name}: {detail}"
        raise KitshnError(msg)
    if not create:
        msg = (
            f"GitHub Environment {environment!r} not found in {recipe.full_name}, or the repo is not "
            "visible to your gh login. The first deploy creates the Environment; pass "
            "--create-environment to create it now, or check the name for a typo"
        )
        raise KitshnError(msg)
    runner.run(["gh", "api", "--method", "PUT", path], capture=True)
    return True
