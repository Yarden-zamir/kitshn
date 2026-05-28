from __future__ import annotations

from pathlib import Path
import sys
from enum import StrEnum
from typing import Annotated, Literal

from cyclopts import App, Parameter

from . import __version__
from .bootstrap import DoctorReport
from .bootstrap import bootstrap as run_bootstrap
from .bootstrap import bootstrap_remote as run_bootstrap_remote
from .bootstrap import doctor as run_doctor
from .ci import (
    delete_github_environment,
    deploy_over_ssh,
    destroy_over_ssh,
    resolve_github_action,
    write_github_output,
    write_params_from_github,
)
from .deploy import (
    affected_deployments,
    deploy_recipe,
    destroy_deployment,
    set_deployment_state,
    status_entries,
    status_json,
)
from .errors import KitshnError, NoMatchingDeployment
from .filesystem import roots_from_env
from .installer_registry import installer_choices, load_installers
from .logs import show_logs
from .models import Deployment, Recipe
from .resolve import ResolveInput, resolve_deployment
from .runner import CommandRunner
from .seeding import seed_recipe
from .structured_log import InvocationLog, append_invocation_log
from .templates import available_templates, init_recipe

app = App(
    name="kitshn",
    help="Small VPS deployment system for GitHub repos.",
    version=__version__,
)

OK = "✅"
FAIL = "❌"
INFO = "ℹ️"
PACKAGE = "📦"
FILES = "📄"
ROCKET = "🚀"
TRASH = "🗑️"
PLAY = "▶️"
STOP = "⏹️"
RESTART = "🔄"
REMOTE = "🖥️"
KEY = "🔑"

InstallerChoice = StrEnum(
    "InstallerChoice",
    {choice.upper().replace("-", "_"): choice for choice in installer_choices()},
)


@app.command
def bootstrap(
    *,
    user: Annotated[str | None, Parameter("--user", help="Deployment user to verify.")] = None,
    install_missing: Annotated[
        bool,
        Parameter("--install-missing", help="Install missing system dependencies before setup."),
    ] = False,
    installer: Annotated[
        InstallerChoice | None,
        Parameter("--installer", help="Installer module to use with --install-missing."),
    ] = None,
    dry_run: Annotated[bool, Parameter("--dry-run", help="Print commands without running them.")] = False,
) -> int:
    """Prepare the VPS and run readiness checks."""

    roots = roots_from_env()
    report = run_bootstrap(
        roots=roots,
        user=user,
        runner=CommandRunner(dry_run=dry_run),
        install_missing=install_missing,
        installer_name=str(installer) if installer else None,
    )
    _print_doctor_report(report)
    _safe_log(InvocationLog(command="bootstrap", status="ok" if report.ok else "failed"), roots)
    return 0 if report.ok else 1


@app.command(name="bootstrap-remote")
def bootstrap_remote(ssh_target: str) -> None:
    """Run kitshn bootstrap on a remote SSH target."""

    run_bootstrap_remote(ssh_target, CommandRunner())
    print(f"{REMOTE} bootstrapped remote host")
    print("status=bootstrapped-remote")
    print(f"target={ssh_target}")
    _safe_log(InvocationLog(command="bootstrap-remote", status="ok"), roots_from_env())


@app.command
def doctor() -> int:
    """Verify server readiness without changing state."""

    roots = roots_from_env()
    report = run_doctor(roots=roots, runner=CommandRunner())
    _print_doctor_report(report)
    _safe_log(InvocationLog(command="doctor", status="ok" if report.ok else "failed"), roots)
    return 0 if report.ok else 1


@app.command(name="installers")
def installers() -> None:
    """List dynamically loaded bootstrap installers."""

    print(f"{PACKAGE} available installers")
    _print_table(
        ("name", "package managers", "description"),
        [
            (installer.name, ", ".join(installer.package_managers), installer.description)
            for installer in load_installers()
        ],
    )


@app.command
def seed(
    recipe: str,
    *,
    vps_host: Annotated[str, Parameter("--vps-host", help="SSH target used by GitHub Actions.")],
    template: Annotated[str, Parameter("--template", help="Template name to copy.")] = "bare",
    directory: Annotated[Path, Parameter("--directory", help="Target repository directory.")] = Path("."),
    key_path: Annotated[
        Path | None,
        Parameter("--key-path", help="Private key path to generate. Defaults to ~/.ssh/kitshn-<owner>-<repo>-ed25519."),
    ] = None,
    force: Annotated[bool, Parameter("--force", help="Overwrite generated files and SSH key.")] = False,
    authorize_key: Annotated[
        bool,
        Parameter("--authorize-key", help="Append the generated public key to the VPS user's authorized_keys."),
    ] = True,
    dry_run: Annotated[bool, Parameter("--dry-run", help="Print commands without running them.")] = False,
) -> None:
    """Seed an existing repository with KitSHn files and GitHub Actions SSH access."""

    result = seed_recipe(
        recipe,
        template=template,
        target_dir=directory,
        vps_host=vps_host,
        runner=CommandRunner(dry_run=dry_run),
        key_path=key_path,
        force=force,
        authorize_key=authorize_key,
    )
    print(f"{OK} recipe seeded")
    print("status=seeded")
    print(f"recipe={recipe}")
    print(f"template={template}")
    print(f"directory={directory}")
    print(f"files={len(result.created_files)}")
    print(f"{KEY} ssh_key={result.private_key}")
    print(f"public_key={result.public_key}")
    print(f"vps_host={vps_host}")
    print(f"authorized_key={str(result.authorized_key).lower()}")
    for path in result.created_files:
        print(f"file={path}")
    _safe_log(InvocationLog(command="seed", status="ok", extra={"template": template}), roots_from_env())


@app.command
def init(
    recipe: str,
    *,
    template: Annotated[str, Parameter("--template", help="Template name to copy.")],
    directory: Annotated[Path, Parameter("--directory", help="Target directory.")] = Path("."),
    force: Annotated[bool, Parameter("--force", help="Overwrite existing files.")] = False,
) -> None:
    """Create KitSHn recipe files from a template."""

    created = init_recipe(recipe, template=template, target_dir=directory, force=force)
    print(f"{OK} recipe initialized")
    print("status=initialized")
    print(f"recipe={recipe}")
    print(f"template={template}")
    print(f"directory={directory}")
    print(f"files={len(created)}")
    for path in created:
        print(f"file={path}")
    _safe_log(InvocationLog(command="init", status="ok", extra={"template": template}), roots_from_env())


@app.command
def templates() -> None:
    """List available recipe templates."""

    print(f"{FILES} available templates")
    _print_table(("template",), [(template,) for template in available_templates()])


@app.command
def deploy(
    recipe: str,
    *,
    params_file: Annotated[Path, Parameter("--params-file", help="Opaque params.env file.")],
    ref: Annotated[str | None, Parameter("--ref", help="Branch, tag, or SHA to deploy.")] = None,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")] = "prod",
    dry_run: Annotated[bool, Parameter("--dry-run", help="Print commands without running them.")] = False,
) -> None:
    """Deploy a recipe to an environment."""

    result = deploy_recipe(
        recipe,
        params_file=params_file,
        ref=ref,
        environment=environment,
        runner=CommandRunner(dry_run=dry_run),
    )
    print(f"{ROCKET} deployed")
    print("status=deployed")
    print(f"deployment={result.deployment.identity}")
    print(f"environment={result.deployment.environment}")
    print(f"ref={result.ref}")
    print(f"compose_project={result.deployment.compose_project}")
    print("changed_services=" + (",".join(result.changed_services) or "none"))
    print(f"caddy_reloaded={str(result.caddy_reloaded).lower()}")
    _safe_log(
        InvocationLog(
            command="deploy",
            status="ok",
            deployment=result.deployment,
            ref=result.ref,
            changed_services=result.changed_services,
        ),
        result.deployment.roots,
    )


@app.command
def destroy(
    recipe: str,
    *,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")],
    purge: Annotated[bool, Parameter("--purge", help="Delete persistent data and file logs.")] = False,
    dry_run: Annotated[bool, Parameter("--dry-run", help="Print commands without running them.")] = False,
) -> None:
    """Destroy one deployment."""

    deployment = destroy_deployment(
        recipe, environment=environment, purge=purge, runner=CommandRunner(dry_run=dry_run)
    )
    print(f"{TRASH} destroyed")
    print("status=destroyed")
    print(f"deployment={deployment.identity}")
    print(f"environment={deployment.environment}")
    print(f"purge={str(purge).lower()}")
    _safe_log(InvocationLog(command="destroy", status="ok", deployment=deployment), deployment.roots)


@app.command
def resolve(
    *,
    recipe: Annotated[str, Parameter("--recipe", help="Fully qualified owner/repo name.")],
    event: Annotated[
        Literal["push", "pull_request", "workflow_dispatch"],
        Parameter("--event", help="Triggering GitHub event."),
    ],
    config: Annotated[Path, Parameter("--config", help="Path to .kitshn.yaml.")] = Path(
        ".kitshn.yaml"
    ),
    branch: Annotated[str | None, Parameter("--branch", help="Branch name.")] = None,
    pr: Annotated[int | None, Parameter("--pr", help="Pull request number.")] = None,
    sha: Annotated[str | None, Parameter("--sha", help="Commit SHA.")] = None,
    environment: Annotated[
        str | None, Parameter("--environment", help="Manual workflow environment.")
    ] = None,
    pr_action: Annotated[
        str | None, Parameter("--pr-action", help="Pull request action, such as closed.")
    ] = None,
) -> int:
    """Resolve a GitHub event to env/action output lines."""

    Recipe.parse(recipe)
    try:
        result = resolve_deployment(
            config,
            ResolveInput(
                event=event,
                branch=branch,
                pr=pr,
                sha=sha,
                environment=environment,
                pr_action=pr_action,
            ),
        )
    except NoMatchingDeployment:
        return 1
    for line in result.github_output_lines():
        print(line)
    _safe_log(
        InvocationLog(
            command="resolve",
            status="ok",
            extra={"recipe": recipe, "resolved_environment": result.env, "action": result.action},
        ),
        roots_from_env(),
    )
    return 0


@app.command
def logs(
    recipe: str | None = None,
    service: str | None = None,
    *,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")] = "prod",
    follow: Annotated[bool, Parameter("--follow", help="Follow selected logs.")] = False,
    files: Annotated[bool, Parameter("--files", help="Read file logs instead of Docker logs.")] = False,
) -> None:
    """Show KitSHn, Docker, or file logs."""

    show_logs(recipe, service, environment=environment, files=files, follow=follow)
    deployment = _deployment_or_none(recipe, environment)
    _safe_log(InvocationLog(command="logs", status="ok", deployment=deployment), roots_from_env())


@app.command
def status(
    recipe: str | None = None,
    *,
    environment: Annotated[str | None, Parameter("--environment", help="GitHub Environment name.")] = None,
) -> None:
    """Show deployment status as JSON."""

    entries = status_entries(recipe, environment=environment)
    print(status_json(entries))
    _safe_log(InvocationLog(command="status", status="ok"), roots_from_env())


@app.command
def start(
    recipe: str,
    *,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")] = "prod",
) -> None:
    """Start Compose services for one deployment."""

    deployment = set_deployment_state(recipe, environment=environment, action="start")
    print(f"{PLAY} started")
    print("status=started")
    print(f"deployment={deployment.identity}")
    print(f"environment={deployment.environment}")
    _safe_log(InvocationLog(command="start", status="ok", deployment=deployment), deployment.roots)


@app.command
def stop(
    recipe: str,
    *,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")] = "prod",
) -> None:
    """Stop Compose services for one deployment."""

    deployment = set_deployment_state(recipe, environment=environment, action="stop")
    print(f"{STOP} stopped")
    print("status=stopped")
    print(f"deployment={deployment.identity}")
    print(f"environment={deployment.environment}")
    _safe_log(InvocationLog(command="stop", status="ok", deployment=deployment), deployment.roots)


@app.command
def restart(
    recipe: str,
    *,
    environment: Annotated[str, Parameter("--environment", help="GitHub Environment name.")] = "prod",
) -> None:
    """Restart Compose services for one deployment."""

    deployment = set_deployment_state(recipe, environment=environment, action="restart")
    print(f"{RESTART} restarted")
    print("status=restarted")
    print(f"deployment={deployment.identity}")
    print(f"environment={deployment.environment}")
    _safe_log(InvocationLog(command="restart", status="ok", deployment=deployment), deployment.roots)


@app.command
def affected(recipe: str) -> None:
    """List deployments/services depending on a recipe."""

    print(f"{INFO} affected services")
    for item in affected_deployments(recipe):
        print(item)
    _safe_log(InvocationLog(command="affected", status="ok", extra={"recipe": recipe}), roots_from_env())


@app.command(name="ci-resolve", show=False)
def ci_resolve() -> None:
    """Resolve GitHub Actions context and write step outputs."""

    result = resolve_github_action()
    write_github_output(result.output_lines())


@app.command(name="ci-write-params", show=False)
def ci_write_params(
    output: Annotated[Path, Parameter("--output", help="params.env output path.")] = Path(
        "params.env"
    ),
) -> None:
    """Write params.env from GitHub vars/secrets JSON."""

    write_params_from_github(output)


@app.command(name="ci-deploy", show=False)
def ci_deploy(
    params_file: Annotated[Path, Parameter("--params-file", help="params.env file to copy.")] = Path(
        "params.env"
    ),
) -> None:
    """Deploy from GitHub Actions over SSH."""

    deploy_over_ssh(params_file)


@app.command(name="ci-destroy", show=False)
def ci_destroy() -> None:
    """Destroy from GitHub Actions over SSH."""

    destroy_over_ssh()


@app.command(name="ci-delete-environment", show=False)
def ci_delete_environment() -> None:
    """Delete the resolved ephemeral GitHub Environment."""

    delete_github_environment()


def main() -> int:
    try:
        result = app(result_action="return_int_as_exit_code_else_zero")
    except KitshnError as error:
        print(f"kitshn: {error}", file=sys.stderr)
        _safe_log(InvocationLog(command=_command_name(), status="failed", extra={"error": str(error)}), roots_from_env())
        return 1
    return int(result or 0)


def _print_doctor_report(report: DoctorReport) -> None:
    print(f"{OK if report.ok else FAIL} server readiness")
    _print_table(
        ("status", "check", "detail"),
        [(_check_icon(check.state), check.name, check.detail) for check in report.checks],
    )
    if report.installers:
        print("")
        print(f"{PACKAGE} suggested installers")
        _print_table(
            ("name", "package managers", "description"),
            [
                (installer.name, ", ".join(installer.package_managers), installer.description)
                for installer in report.installers
            ],
        )
        print("")
        print(f"{INFO} install with: kitshn bootstrap --install-missing --installer <name>")


def _print_table(headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> None:
    if not rows:
        return
    widths = [len(header) for header in headers]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))

    print("  ".join(header.upper().ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))


def _check_icon(state: str) -> str:
    if state == "ok":
        return OK
    if state == "warn":
        return "⚠️"
    return FAIL


def _safe_log(entry: InvocationLog, roots) -> None:
    try:
        append_invocation_log(entry, roots)
    except OSError:
        pass


def _deployment_or_none(recipe: str | None, environment: str) -> Deployment | None:
    if recipe is None:
        return None
    return Deployment.create(Recipe.parse(recipe), environment, roots_from_env())


def _command_name() -> str:
    return sys.argv[1] if len(sys.argv) > 1 else "kitshn"
