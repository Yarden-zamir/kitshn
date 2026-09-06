"""Follow one commit from GitHub Actions run to a verified deployment, from the laptop.

Steps, each with its own timeout: find the Actions run for the commit, wait for it to finish
while printing job transitions, read `kitshn status` on the VPS over SSH, then request the
public route inferred from `Caddyfile.j2`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import json
from pathlib import Path
import time
from typing import Any, Literal

from .caddy import infer_public_url
from .errors import KitshnError, NoMatchingDeployment
from .httpcheck import Fetch, fetch_url
from .models import Deployment, Recipe
from .remote import check_vps_reachable, run_on_vps
from .resolve import ResolveInput, resolve_deployment
from .runner import CommandRunner

POLL_SECONDS = 5


@dataclass(frozen=True, slots=True)
class TrackTimeouts:
    run_start: int = 120
    run: int = 1200
    vps: int = 120
    route: int = 180


DEFAULT_TIMEOUTS = TrackTimeouts()


@dataclass(frozen=True, slots=True)
class TrackStep:
    name: str
    state: Literal["ok", "warn", "fail"]
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.state in {"ok", "warn"}


@dataclass(slots=True)
class TrackReport:
    recipe: Recipe
    sha: str
    environment: str | None = None
    run_url: str | None = None
    url: str | None = None
    steps: list[TrackStep] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(step.ok for step in self.steps)


Sleep = Callable[[float], None]


def track_deploy(
    *,
    directory: Path,
    runner: CommandRunner,
    sha: str | None = None,
    environment: str | None = None,
    vps_host: str | None = None,
    url: str | None = None,
    expect: str | None = None,
    timeouts: TrackTimeouts = DEFAULT_TIMEOUTS,
    fetch: Fetch | None = None,
    sleep: Sleep = time.sleep,
) -> TrackReport:
    fetch = fetch or fetch_url
    recipe = _github_recipe(directory, runner)
    commit = sha or _git_output(directory, runner, "rev-parse", "HEAD")
    branch = _git_output(directory, runner, "rev-parse", "--abbrev-ref", "HEAD")
    report = TrackReport(recipe=recipe, sha=commit)
    print(f"recipe={recipe.full_name}")
    print(f"sha={commit}")

    run = _wait_for_run(recipe, commit, runner, timeouts.run_start, sleep)
    if run is None:
        report.steps.append(
            TrackStep(
                "actions run",
                "fail",
                f"no GitHub Actions run for {commit[:12]} after {timeouts.run_start}s; push the commit first",
            )
        )
        return report
    report.run_url = run["url"]
    print(f"run={run['url']}")
    finished = _wait_for_run_completion(recipe, run["databaseId"], runner, timeouts.run, sleep)
    report.steps.append(finished)
    if not finished.ok:
        runner.run(
            ["gh", "run", "view", str(run["databaseId"]), "--repo", recipe.full_name, "--log-failed"],
            check=False,
        )
        return report

    try:
        report.environment = environment or _resolve_environment(directory, runner, branch, commit)
    except KitshnError as error:
        report.steps.append(TrackStep("environment", "fail", str(error)))
        return report
    print(f"environment={report.environment}")
    deployment = Deployment.create(recipe, report.environment)

    host = vps_host or _github_variable(recipe, "KITSHN_VPS_HOST", runner)
    report.steps.append(_wait_for_vps_status(deployment, commit, host, runner, timeouts.vps, sleep))

    report.url = url or infer_public_url(directory / "Caddyfile.j2", deployment)
    if report.url is None:
        report.steps.append(
            TrackStep("public route", "warn", "no single public hostname in Caddyfile.j2; pass --url to check one")
        )
        return report
    print(f"url={report.url}")
    report.steps.append(_wait_for_route(report.url, expect, fetch, timeouts.route, sleep))
    return report


def status_problems(entry: dict[str, Any], sha: str) -> list[str]:
    """Return why one `kitshn status` entry does not describe a healthy deploy of `sha`."""

    problems: list[str] = []
    ref = entry.get("ref")
    if ref != sha:
        problems.append(f"ref is {ref or 'unknown'}, expected {sha}")
    services = entry.get("services")
    if not isinstance(services, list) or not services:
        problems.append("no running services")
    else:
        for service in services:
            name = service.get("Service") or service.get("Name") or "?"
            state = service.get("State") or "unknown"
            health = service.get("Health") or ""
            if state != "running":
                problems.append(f"{name} is {state}")
            elif health and health != "healthy":
                problems.append(f"{name} is {health}")
    if entry.get("caddy_route") and not entry.get("default_socket_exists"):
        problems.append("default socket is missing")
    return problems


def _wait_for_run(
    recipe: Recipe, sha: str, runner: CommandRunner, timeout: int, sleep: Sleep
) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout
    while True:
        result = runner.run(
            [
                "gh",
                "run",
                "list",
                "--repo",
                recipe.full_name,
                "--commit",
                sha,
                "--json",
                "databaseId,status,conclusion,url,workflowName",
                "--limit",
                "10",
            ],
            capture=True,
        )
        runs = json.loads(result.stdout or "[]")
        if runs:
            kitshn_runs = [run for run in runs if str(run.get("workflowName", "")).endswith("kitshn.yml")]
            return (kitshn_runs or runs)[0]
        if time.monotonic() >= deadline:
            return None
        sleep(POLL_SECONDS)


def _wait_for_run_completion(
    recipe: Recipe, run_id: int, runner: CommandRunner, timeout: int, sleep: Sleep
) -> TrackStep:
    deadline = time.monotonic() + timeout
    seen: dict[str, tuple[str, str]] = {}
    while True:
        result = runner.run(
            [
                "gh",
                "run",
                "view",
                str(run_id),
                "--repo",
                recipe.full_name,
                "--json",
                "status,conclusion,jobs,url",
            ],
            capture=True,
        )
        run = json.loads(result.stdout)
        for job in run.get("jobs", []):
            key = (str(job.get("status")), str(job.get("conclusion") or ""))
            if seen.get(job["name"]) != key:
                seen[job["name"]] = key
                print(f"job={job['name']} status={key[0]}" + (f" conclusion={key[1]}" if key[1] else ""))
        if run.get("status") == "completed":
            conclusion = run.get("conclusion")
            if conclusion == "success":
                return TrackStep("actions run", "ok", run["url"])
            return TrackStep("actions run", "fail", f"conclusion={conclusion} {run['url']}")
        if time.monotonic() >= deadline:
            return TrackStep("actions run", "fail", f"still {run.get('status')} after {timeout}s: {run['url']}")
        sleep(POLL_SECONDS)


def _wait_for_vps_status(
    deployment: Deployment,
    sha: str,
    vps_host: str,
    runner: CommandRunner,
    timeout: int,
    sleep: Sleep,
) -> TrackStep:
    check_vps_reachable(vps_host, runner)
    deadline = time.monotonic() + timeout
    problems = ["no status yet"]
    while True:
        result = run_on_vps(
            vps_host,
            ["status", deployment.recipe.full_name, "--environment", deployment.environment],
            runner,
            capture=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            entries = json.loads(result.stdout)
            problems = status_problems(entries[0], sha) if entries else ["deployment not found on VPS"]
            if not problems:
                return TrackStep("vps status", "ok", f"{deployment.identity} at {sha[:12]}, services healthy")
        else:
            problems = [result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "kitshn status failed"]
        if time.monotonic() >= deadline:
            return TrackStep("vps status", "fail", "; ".join(problems))
        sleep(POLL_SECONDS)


def _wait_for_route(url: str, expect: str | None, fetch: Fetch, timeout: int, sleep: Sleep) -> TrackStep:
    deadline = time.monotonic() + timeout
    while True:
        try:
            response = fetch(url)
            detail = f"{response.status} {response.content_type} {url}"
            if response.ok:
                if expect is None or expect in response.body:
                    return TrackStep("public route", "ok", detail)
                detail = f"{detail}; body does not contain {expect!r}"
        except KitshnError as error:
            detail = f"{error} {url}"
        if time.monotonic() >= deadline:
            return TrackStep("public route", "fail", detail)
        sleep(POLL_SECONDS)


def _resolve_environment(directory: Path, runner: CommandRunner, branch: str, sha: str) -> str:
    config = directory / ".kitshn.yaml"
    if not config.exists():
        msg = f"no .kitshn.yaml in {directory}; pass --environment"
        raise KitshnError(msg)
    try:
        return resolve_deployment(config, ResolveInput(event="push", branch=branch, sha=sha)).env
    except NoMatchingDeployment:
        pass
    pr = runner.run(
        ["gh", "pr", "view", "--json", "number", "--jq", ".number"],
        cwd=directory,
        capture=True,
        check=False,
    )
    if pr.returncode == 0 and pr.stdout.strip().isdigit():
        try:
            return resolve_deployment(
                config, ResolveInput(event="pull_request", branch=branch, pr=int(pr.stdout.strip()), sha=sha)
            ).env
        except NoMatchingDeployment:
            pass
    msg = f"no .kitshn.yaml entry matches branch {branch!r}; pass --environment"
    raise KitshnError(msg)


def _github_recipe(directory: Path, runner: CommandRunner) -> Recipe:
    result = runner.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        cwd=directory,
        capture=True,
    )
    return Recipe.parse(result.stdout.strip())


def _github_variable(recipe: Recipe, name: str, runner: CommandRunner) -> str:
    result = runner.run(
        ["gh", "variable", "get", name, "--repo", recipe.full_name], capture=True, check=False
    )
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        msg = f"GitHub variable {name} is not set for {recipe.full_name}; run kitshn recipe auth or pass --vps-host"
        raise KitshnError(msg)
    return value


def _git_output(directory: Path, runner: CommandRunner, *args: str) -> str:
    result = runner.run(["git", *args], cwd=directory, capture=True)
    return result.stdout.strip()
