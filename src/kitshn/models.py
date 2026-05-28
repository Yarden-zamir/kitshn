from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from .errors import KitshnError

_ENV_INVALID_RE = re.compile(r"[^a-z0-9-]+")
_ENV_REPEAT_RE = re.compile(r"-+")


def sanitize_environment_name(value: str) -> str:
    """Apply the environment-name sanitization rules from the specs."""

    normalized = _ENV_INVALID_RE.sub("-", value.lower())
    normalized = _ENV_REPEAT_RE.sub("-", normalized).strip("-")
    normalized = normalized[:63].strip("-")
    if not normalized:
        msg = f"environment name {value!r} is empty after sanitization"
        raise KitshnError(msg)
    return normalized


@dataclass(frozen=True, slots=True)
class Recipe:
    owner: str
    repo: str

    @classmethod
    def parse(cls, value: str) -> Recipe:
        parts = value.split("/")
        if len(parts) != 2 or not all(parts):
            msg = f"recipe must be a fully qualified owner/repo name: {value!r}"
            raise KitshnError(msg)
        if any(part in {".", ".."} for part in parts):
            msg = f"recipe path segments cannot be . or ..: {value!r}"
            raise KitshnError(msg)
        return cls(owner=parts[0], repo=parts[1])

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def normalized_full_name(self) -> str:
        return self.full_name.lower()

    @property
    def remote_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}.git"


@dataclass(frozen=True, slots=True)
class Roots:
    deployments: Path = Path("/deployments")
    params: Path = Path("/params")
    persistent: Path = Path("/persistent")
    logs: Path = Path("/logs")

    @property
    def kitshn_logs(self) -> Path:
        return self.logs / ".kitshn"


@dataclass(frozen=True, slots=True)
class Deployment:
    recipe: Recipe
    environment: str
    roots: Roots = Roots()

    @classmethod
    def create(cls, recipe: Recipe, environment: str, roots: Roots = Roots()) -> Deployment:
        return cls(recipe=recipe, environment=sanitize_environment_name(environment), roots=roots)

    @property
    def identity(self) -> str:
        return f"{self.recipe.owner}/{self.recipe.repo}/{self.environment}"

    @property
    def deployment_root(self) -> Path:
        return self.roots.deployments / self.recipe.owner / self.recipe.repo / self.environment

    @property
    def params_root(self) -> Path:
        return self.roots.params / self.recipe.owner / self.recipe.repo / self.environment

    @property
    def params_file(self) -> Path:
        return self.params_root / "params.env"

    @property
    def persistent_root(self) -> Path:
        return self.roots.persistent / self.recipe.owner / self.recipe.repo / self.environment

    @property
    def logs_root(self) -> Path:
        return self.roots.logs / self.recipe.owner / self.recipe.repo / self.environment

    @property
    def generated_caddyfile(self) -> Path:
        return self.deployment_root / "Caddyfile"

    @property
    def compose_project(self) -> str:
        identity = f"{self.recipe.owner}-{self.recipe.repo}-{self.environment}"
        return sanitize_environment_name(identity)

    @property
    def runtime_env(self) -> dict[str, str]:
        return {
            "KITSHN_RECIPE": self.recipe.full_name,
            "KITSHN_ENVIRONMENT": self.environment,
            "KITSHN_DEPLOYMENT": self.identity,
            "KITSHN_PARAMS_FILE": str(self.params_file),
            "KITSHN_DATA_DIR": str(self.persistent_root),
            "KITSHN_LOG_DIR": str(self.logs_root),
        }
