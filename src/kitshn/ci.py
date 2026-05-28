from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
from typing import cast
import urllib.error
import urllib.request

from .errors import KitshnError, NoMatchingDeployment
from .resolve import DeployEvent, ResolveInput, resolve_deployment

RESERVED_PARAM_NAMES = {"KITSHN_VPS_HOST", "KITSHN_SSH_KEY"}
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
HOSTED_CLI = ["uvx", "--from", "git+https://github.com/Yarden-zamir/kitshn.git", "kitshn"]
REMOTE_PATH_PREFIX = "export PATH=$HOME/.local/bin:$PATH"


@dataclass(frozen=True, slots=True)
class ActionResolveResult:
    matched: bool
    env: str | None = None
    action: str | None = None
    ephemeral: bool | None = None
    ref: str | None = None

    def output_lines(self) -> list[str]:
        lines = [f"matched={str(self.matched).lower()}"]
        if self.env is not None:
            lines.append(f"env={self.env}")
        if self.action is not None:
            lines.append(f"action={self.action}")
        if self.ephemeral is not None:
            lines.append(f"ephemeral={str(self.ephemeral).lower()}")
        if self.ref is not None:
            lines.append(f"ref={self.ref}")
        return lines


def resolve_github_action(config: Path = Path(".kitshn.yaml")) -> ActionResolveResult:
    event_name = _required_env("GITHUB_EVENT_NAME")
    if event_name not in {"push", "pull_request", "workflow_dispatch"}:
        msg = f"unsupported GitHub event: {event_name}"
        raise KitshnError(msg)
    event = cast(DeployEvent, event_name)
    sha = _required_env("GITHUB_SHA")

    ref_name = os.environ.get("GITHUB_REF_NAME")
    input_environment = os.environ.get("INPUT_ENVIRONMENT") or None
    input_ref = os.environ.get("INPUT_REF") or None
    pr_number = _optional_int(os.environ.get("PR_NUMBER"))
    pr_action = os.environ.get("PR_ACTION") or None
    pr_head_ref = os.environ.get("PR_HEAD_REF") or None

    branch = ref_name
    ref = input_ref or sha
    if event == "pull_request":
        branch = pr_head_ref
        ref = sha

    try:
        result = resolve_deployment(
            config,
            ResolveInput(
                event=event,
                branch=branch,
                pr=pr_number,
                sha=sha,
                environment=input_environment,
                pr_action=pr_action,
            ),
        )
    except NoMatchingDeployment:
        return ActionResolveResult(matched=False)

    return ActionResolveResult(
        matched=True,
        env=result.env,
        action=result.action,
        ephemeral=result.ephemeral,
        ref=ref,
    )


def write_github_output(lines: list[str], output_path: Path | None = None) -> None:
    target = output_path or _optional_path(os.environ.get("GITHUB_OUTPUT"))
    if target is None:
        for line in lines:
            print(line)
        return
    with target.open("a", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")


def write_params_from_github(output: Path) -> None:
    values: dict[str, str] = {}
    for payload in (_json_env("KITSHN_VARS_JSON"), _json_env("KITSHN_SECRETS_JSON")):
        for name, value in payload.items():
            if not name.startswith("KITSHN_") or name in RESERVED_PARAM_NAMES or value is None:
                continue
            key = name.removeprefix("KITSHN_")
            if not ENV_KEY_RE.fullmatch(key):
                msg = f"invalid KITSHN param name after prefix stripping: {name}"
                raise KitshnError(msg)
            values[key] = str(value)

    output.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={json.dumps(values[key])}" for key in sorted(values)]
    output.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    output.chmod(0o600)


def deploy_over_ssh(params_file: Path) -> None:
    repository = _required_env("GITHUB_REPOSITORY")
    vps_host = _required_env("KITSHN_VPS_HOST")
    ssh_key = _required_env("KITSHN_SSH_KEY")
    environment = _required_env("KITSHN_ENVIRONMENT")
    ref = _required_env("KITSHN_REF")
    run_id = _required_env("GITHUB_RUN_ID")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    remote_params = f"/tmp/kitshn-{run_id}-{run_attempt}.env"

    with _ssh_key_file(ssh_key) as key_file:
        ssh_args = ["-i", str(key_file), "-o", "StrictHostKeyChecking=accept-new"]
        _run(["scp", *ssh_args, str(params_file), f"{vps_host}:{remote_params}"])
        remote_command = "; ".join(
            [
                REMOTE_PATH_PREFIX,
                shlex.join(
                    [
                        *HOSTED_CLI,
                        "deploy",
                        repository,
                        "--params-file",
                        remote_params,
                        "--ref",
                        ref,
                        "--environment",
                        environment,
                    ]
                ),
                shlex.join(["rm", "-f", remote_params]),
            ]
        )
        _run(["ssh", *ssh_args, vps_host, remote_command])


def destroy_over_ssh() -> None:
    repository = _required_env("GITHUB_REPOSITORY")
    vps_host = _required_env("KITSHN_VPS_HOST")
    ssh_key = _required_env("KITSHN_SSH_KEY")
    environment = _required_env("KITSHN_ENVIRONMENT")

    with _ssh_key_file(ssh_key) as key_file:
        ssh_args = ["-i", str(key_file), "-o", "StrictHostKeyChecking=accept-new"]
        remote_command = shlex.join(
            [*HOSTED_CLI, "destroy", repository, "--environment", environment]
        )
        remote_command = "; ".join([REMOTE_PATH_PREFIX, remote_command])
        _run(["ssh", *ssh_args, vps_host, remote_command])


def delete_github_environment() -> None:
    repository = _required_env("GITHUB_REPOSITORY")
    environment = _required_env("KITSHN_ENVIRONMENT")
    token = _required_env("GITHUB_TOKEN")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/environments/{environment}",
        method="DELETE",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30):
            return
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        raise


class _ssh_key_file:
    def __init__(self, content: str) -> None:
        self.content = content
        self.path: Path | None = None

    def __enter__(self) -> Path:
        handle = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8")
        with handle:
            handle.write(self.content)
            if not self.content.endswith("\n"):
                handle.write("\n")
        self.path = Path(handle.name)
        self.path.chmod(0o600)
        return self.path

    def __exit__(self, *_exc: object) -> None:
        if self.path is not None:
            self.path.unlink(missing_ok=True)


def _run(args: list[str]) -> None:
    try:
        subprocess.run(args, check=True)
    except FileNotFoundError as error:
        msg = f"command not found: {args[0]}"
        raise KitshnError(msg) from error
    except subprocess.CalledProcessError as error:
        msg = f"command failed ({error.returncode}): {shlex.join(args)}"
        raise KitshnError(msg) from error


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        msg = f"missing required environment variable: {name}"
        raise KitshnError(msg)
    return value


def _json_env(name: str) -> dict[str, object]:
    raw_value = os.environ.get(name) or "{}"
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError as error:
        msg = f"{name} must contain a JSON object"
        raise KitshnError(msg) from error
    if not isinstance(value, dict):
        msg = f"{name} must contain a JSON object"
        raise KitshnError(msg)
    return value


def _optional_int(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_path(value: str | None) -> Path | None:
    if value is None or value == "":
        return None
    return Path(value)
