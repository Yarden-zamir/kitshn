from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
import pkgutil
from types import ModuleType

from .errors import KitshnError
from .runner import CommandRunner

INSTALLER_PACKAGE = "kitshn.installers"


@dataclass(frozen=True, slots=True)
class Installer:
    name: str
    description: str
    package_managers: tuple[str, ...]
    module: ModuleType

    def matches_os_release(self, os_release: dict[str, str]) -> bool:
        matcher = getattr(self.module, "matches_os_release", None)
        return bool(callable(matcher) and matcher(os_release))

    def install(self, runner: CommandRunner) -> None:
        installer = getattr(self.module, "install", None)
        if not callable(installer):
            msg = f"installer {self.name!r} does not expose install(runner)"
            raise KitshnError(msg)
        installer(runner)


def load_installers() -> list[Installer]:
    package = import_module(INSTALLER_PACKAGE)
    installers: list[Installer] = []
    for module_info in pkgutil.iter_modules(package.__path__):
        if module_info.name.startswith("_"):
            continue
        module = import_module(f"{INSTALLER_PACKAGE}.{module_info.name}")
        name = _required_string(module, "NAME")
        description = _required_string(module, "DESCRIPTION")
        package_managers = tuple(getattr(module, "PACKAGE_MANAGERS", ()))
        if not package_managers or not all(isinstance(item, str) for item in package_managers):
            msg = f"installer {name!r} must define PACKAGE_MANAGERS as strings"
            raise KitshnError(msg)
        installers.append(
            Installer(
                name=name,
                description=description,
                package_managers=package_managers,
                module=module,
            )
        )
    return sorted(installers, key=lambda installer: installer.name)


def installer_choices() -> list[str]:
    return [installer.name for installer in load_installers()]


def get_installer(name: str) -> Installer:
    for installer in load_installers():
        if installer.name == name:
            return installer
    choices = ", ".join(installer_choices())
    msg = f"unknown installer {name!r}; available installers: {choices}"
    raise KitshnError(msg)


def suggested_installers(runner: CommandRunner) -> list[Installer]:
    os_release = read_os_release()
    installers = load_installers()
    matched = [installer for installer in installers if installer.matches_os_release(os_release)]
    if matched:
        return matched
    return [
        installer
        for installer in installers
        if any(runner.exists(package_manager) for package_manager in installer.package_managers)
    ]


def read_os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"')
    return values


def _required_string(module: ModuleType, name: str) -> str:
    value = getattr(module, name, None)
    if not isinstance(value, str) or not value:
        msg = f"installer module {module.__name__} must define non-empty {name}"
        raise KitshnError(msg)
    return value
