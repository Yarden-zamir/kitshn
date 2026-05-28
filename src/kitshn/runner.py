from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
from typing import Mapping, Sequence

from .errors import KitshnError


@dataclass(slots=True)
class CommandResult:
    args: Sequence[str]
    returncode: int
    stdout: str
    stderr: str


@dataclass(slots=True)
class CommandRunner:
    dry_run: bool = False

    def exists(self, executable: str) -> bool:
        return shutil.which(executable) is not None

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
    ) -> CommandResult:
        if not args:
            msg = "cannot run an empty command"
            raise KitshnError(msg)

        merged_env = os.environ.copy()
        if env:
            merged_env.update(env)

        if self.dry_run:
            print("+ " + " ".join(args))
            return CommandResult(args=args, returncode=0, stdout="", stderr="")

        try:
            completed = subprocess.run(
                list(args),
                cwd=cwd,
                env=merged_env,
                check=False,
                text=True,
                stdout=subprocess.PIPE if capture else None,
                stderr=subprocess.PIPE if capture else None,
            )
        except FileNotFoundError as error:
            if check:
                msg = f"command not found: {args[0]}"
                raise KitshnError(msg) from error
            return CommandResult(args=args, returncode=127, stdout="", stderr=str(error))
        result = CommandResult(
            args=args,
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            suffix = f": {detail}" if detail else ""
            msg = f"command failed ({result.returncode}): {' '.join(args)}{suffix}"
            raise KitshnError(msg)
        return result
