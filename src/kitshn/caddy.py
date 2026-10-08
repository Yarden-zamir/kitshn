from __future__ import annotations

from pathlib import Path
import os
import pwd

from jinja2 import Environment, StrictUndefined, Undefined, UndefinedError

from .errors import KitshnError
from .filesystem import read_env_file, walk_deployments
from .models import Deployment, Roots
from .runner import CommandRunner

CADDY_BASE_CONFIG = Path("/etc/caddy/Caddyfile")
# Global options that bootstrap writes; the base Caddyfile imports it in its global block.
CADDY_OPTIONS_FILE = Path("/etc/caddy/kitshn-options.caddy")
# Environment for the Caddy service, such as a DNS API token; see specs/caddy.md.
CADDY_ENV_FILE = Path("/etc/caddy/kitshn.env")


PREVIEW_WILDCARD_MARKER = "# kitshn preview wildcard: "
DNS_ZONE_MARKER = "# kitshn dns zone: "
PRODUCTION_ENVIRONMENT = "prod"


def render_caddyfile(deployment: Deployment) -> str | None:
    template_path = _template_path(deployment)
    if template_path is None:
        return None

    wildcards: set[str] = set()
    env = Environment(autoescape=False, undefined=StrictUndefined)
    template = env.from_string(template_path.read_text(encoding="utf-8"))
    rendered = template.render(
        _template_context(deployment, read_env_file(deployment.params_file), wildcards)
    )
    markers = [f"{PREVIEW_WILDCARD_MARKER}{wildcard}\n" for wildcard in sorted(wildcards)]
    return "".join(markers) + rendered.rstrip() + "\n"


def _template_context(
    deployment: Deployment, params: dict[str, str], wildcards: set[str]
) -> dict[str, object]:
    def host(base: str) -> str:
        """`base` for prod, `<environment>.<base>` for every other environment.

        One label per environment keeps every preview under one wildcard, `*.<base>`, so all
        previews of a recipe share one certificate.
        """

        base = base.strip().strip(".")
        if not base or "*" in base or "." not in base:
            msg = f"host() needs a domain name such as app.example.com, got {base!r}"
            raise KitshnError(msg)
        if deployment.environment == PRODUCTION_ENVIRONMENT:
            return base
        wildcards.add(f"*.{base}")
        return f"{deployment.environment}.{base}"

    return {
        "recipe": deployment.recipe.full_name,
        "environment": deployment.environment,
        "deployment": deployment.identity,
        "host": host,
        "paths": {
            "deployment": str(deployment.deployment_root),
            "params": str(deployment.params_root),
            "params_file": str(deployment.params_file),
            "persistent": str(deployment.persistent_root),
            "logs": str(deployment.logs_root),
            "socket": str(deployment.socket_root),
            "default_socket": str(deployment.default_socket),
        },
        "params": params,
    }


def read_active_caddyfile(deployment: Deployment) -> str | None:
    target = deployment.generated_caddyfile
    return target.read_text(encoding="utf-8") if target.exists() else None


def apply_caddyfile(
    deployment: Deployment,
    rendered: str | None,
    runner: CommandRunner,
    *,
    previous_active: str | None = None,
) -> bool:
    target = deployment.generated_caddyfile
    manifest = deployment.caddy_manifest_file
    existing = read_active_caddyfile(deployment) if previous_active is None else previous_active
    existing_manifest = manifest.read_text(encoding="utf-8") if manifest.exists() else None
    route_group = caddy_group(runner)

    try:
        if rendered is None:
            if target.exists():
                target.unlink()
        else:
            _atomic_write(target, rendered, group=route_group)

        updated_manifest = render_caddy_manifest(deployment.roots)
        changed = rendered != existing or updated_manifest != existing_manifest
        if not changed:
            return False

        _atomic_write(manifest, updated_manifest)

        validate_and_reload_caddy(runner)
    except Exception:
        if target.exists():
            target.unlink()
        if manifest.exists():
            manifest.unlink()
        if existing is not None:
            _atomic_write(target, existing, group=route_group)
        if existing_manifest is not None:
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(existing_manifest, encoding="utf-8")
        raise

    return True


def render_caddy_manifest(roots: Roots, *, dns_zones: frozenset[str] | None = None) -> str:
    """Import every generated Caddyfile, plus one wildcard site per preview base domain.

    A wildcard site needs the DNS challenge, so the manifest adds one only for a base inside a
    zone that the host's DNS provider serves (`dns_zones`, by default from the Caddy options
    file). Outside those zones, each preview gets its own certificate.
    """

    deployments = [
        deployment
        for deployment in walk_deployments(roots)
        if deployment.generated_caddyfile.exists()
    ]
    zones = caddy_dns_zones() if dns_zones is None else dns_zones
    wildcards = sorted(
        {
            wildcard
            for deployment in deployments
            for line in deployment.generated_caddyfile.read_text(encoding="utf-8").splitlines()
            if line.startswith(PREVIEW_WILDCARD_MARKER)
            and _in_zones(wildcard := line.removeprefix(PREVIEW_WILDCARD_MARKER).strip(), zones)
        }
    )
    lines = ["# Generated by KitSHn. Do not edit."]
    for wildcard in wildcards:
        # One certificate for every preview; hosts with no running preview get no answer.
        lines.extend([f"{wildcard} {{", "\ttls {", "\t\tdns", "\t}", "\tabort", "}"])
    lines.extend(f"import {entry}" for entry in sorted(d.caddy_manifest_entry for d in deployments))
    return "\n".join(lines) + "\n"


def caddy_dns_zones(options_file: Path | None = None) -> frozenset[str]:
    """Zones that the global `dns` provider serves, from `# kitshn dns zone: <zone>` lines."""

    options_file = options_file or CADDY_OPTIONS_FILE
    if not options_file.exists():
        return frozenset()
    lines = options_file.read_text(encoding="utf-8").splitlines()
    if not any(line.strip().startswith("dns ") for line in lines):
        return frozenset()
    return frozenset(
        line.removeprefix(DNS_ZONE_MARKER).strip() for line in lines if line.startswith(DNS_ZONE_MARKER)
    )


def _in_zones(wildcard: str, zones: frozenset[str]) -> bool:
    # Strictly below a zone: a base at the zone apex would put every site of the zone under
    # one wildcard and close the connection for every unknown name in it.
    base = wildcard.removeprefix("*.")
    return any(base.endswith(f".{zone}") for zone in zones)


def redact_caddy_env(text: str) -> str:
    """`text` with every value of the Caddy environment file replaced, for logs and errors.

    A DNS module can print its token in a provisioning error, and deploy output can be public.
    """

    try:
        values = read_env_file(CADDY_ENV_FILE)
    except (KitshnError, OSError):
        return text
    redacted: str = text
    secrets: list[str] = sorted(values.values(), key=lambda value: len(value), reverse=True)
    for value in secrets:
        if len(value) >= 4:
            redacted = redacted.replace(value, "<redacted>")
    return redacted


def caddy_service_user(runner: CommandRunner) -> str | None:
    """The user that the `caddy` systemd unit runs as, or None when it is unknown or root."""

    if not runner.exists("systemctl"):
        return None
    result = runner.run(["systemctl", "show", "-p", "User", "--value", "caddy"], capture=True, check=False)
    user = result.stdout.strip()
    return user if result.returncode == 0 and user and user != "root" else None


def caddy_validate_command(runner: CommandRunner, config: Path = CADDY_BASE_CONFIG) -> list[str]:
    """`caddy validate` as the Caddy service user when KitSHn runs as root.

    Validation opens every `log { output file ... }` target and creates a missing one. Run as
    root, that file is root-owned, and the service cannot open it on reload. As the service
    user, validation also fails for the same permission reasons that the reload would.
    A deploy user that is neither root nor the service user cannot switch users, so it
    validates as itself. Revisit if KitSHn supports such deploy users with file logs.
    """

    command = ["caddy", "validate", "--config", str(config)]
    if CADDY_ENV_FILE.exists():
        # The service reads this file at start; validation provisions modules that need it.
        command.extend(["--envfile", str(CADDY_ENV_FILE)])
    user = caddy_service_user(runner)
    if user is not None and os.geteuid() == 0 and runner.exists("runuser"):
        return ["runuser", "-u", user, "--", *command]
    return command


def validate_and_reload_caddy(runner: CommandRunner) -> None:
    validate = runner.run(
        caddy_validate_command(runner),
        capture=True,
        check=False,
    )
    if validate.returncode != 0:
        detail = redact_caddy_env(validate.stderr.strip() or validate.stdout.strip())
        hint = _caddy_failure_hint(detail)
        suffix = f" | hint: {hint}" if hint else ""
        msg = f"caddy validation failed: {detail}{suffix}"
        raise KitshnError(msg)
    runner.run(["caddy", "reload", "--config", str(CADDY_BASE_CONFIG)])


def _caddy_failure_hint(output: str) -> str:
    lowered = output.lower()
    if "ambiguous site definition" in lowered:
        return "make Caddyfile.j2 hostnames environment-aware so prod and pr-* do not render the same site"
    if "module not registered: dns.providers." in lowered:
        return "build the host Caddy with the DNS module: kitshn bootstrap --caddy-module <path>@<version>"
    return ""


def caddy_group(runner: CommandRunner) -> int | None:
    """The primary group of the Caddy service user, when KitSHn runs as root and can chown."""

    user = caddy_service_user(runner)
    if user is None or os.geteuid() != 0:
        return None
    try:
        return pwd.getpwnam(user).pw_gid
    except KeyError:
        return None


def _atomic_write(path: Path, content: str, *, group: int | None = None) -> None:
    """Write via rename. With `group`, the file is root:group 0640.

    A generated route can hold a params secret, such as a DNS API token. With `group`, only root
    and the Caddy user can read it. Without it (no root, or no known Caddy user), the file keeps
    the default umask. Revisit if a non-root deploy user renders secrets into routes.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp_path.write_text(content, encoding="utf-8")
    if group is not None:
        os.chown(temp_path, 0, group)
        temp_path.chmod(0o640)
    os.replace(temp_path, path)


def _template_path(deployment: Deployment) -> Path | None:
    caddyfile_j2 = deployment.deployment_root / "Caddyfile.j2"
    if caddyfile_j2.exists():
        return caddyfile_j2
    return None


def infer_public_url(template_path: Path, deployment: Deployment) -> str | None:
    """Infer the single public URL a recipe's `Caddyfile.j2` serves for one environment.

    Renders the template with the deployment context but without params, so it works on the
    laptop and in CI where `params.env` does not exist. Returns None when the rendered site
    addresses contain zero, several, or wildcard hosts: KitSHn never guesses a URL.
    """

    if not template_path.exists():
        return None
    env = Environment(autoescape=False, undefined=Undefined)
    template = env.from_string(template_path.read_text(encoding="utf-8"))
    try:
        rendered = template.render(_template_context(deployment, {}, set()))
    except (UndefinedError, KitshnError):
        # The render has no params; a host() call on a params value cannot resolve here.
        return None
    urls = {url for address in site_addresses(rendered) if (url := _concrete_url(address))}
    if len(urls) != 1:
        return None
    return urls.pop()


def site_addresses(caddyfile: str) -> list[str]:
    """Return the site addresses of every top-level site block in a rendered Caddyfile."""

    addresses: list[str] = []
    depth = 0
    for raw_line in caddyfile.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if depth == 0 and line not in {"{", "}"} and not line.startswith("("):
            head = line.removesuffix("{").strip()
            addresses.extend(part.strip() for part in head.split(",") if part.strip())
        depth += line.count("{") - line.count("}")
    return addresses


def _concrete_url(address: str) -> str | None:
    scheme = "http" if address.startswith("http://") else "https"
    host_port = address.removeprefix("https://").removeprefix("http://").split("/", 1)[0]
    host = host_port.split(":", 1)[0]
    if not host or "*" in host or "." not in host or host == "localhost":
        return None
    return f"{scheme}://{host_port}"
