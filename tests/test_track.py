from pathlib import Path
from collections.abc import Mapping, Sequence
import json

from kitshn.httpcheck import HttpResponse
from kitshn.runner import CommandResult, CommandRunner
from kitshn.track import DEFAULT_TIMEOUTS, TrackTimeouts, status_problems, track_deploy

SHA = "7b783cd8be3a2059ee07377b65c52f88c4a1c4a3"


class TrackRunner(CommandRunner):
    def __init__(self, *, conclusion: str = "success", status_ref: str = SHA) -> None:
        super().__init__()
        self.conclusion = conclusion
        self.status_ref = status_ref
        self.commands: list[tuple[str, ...]] = []

    def run(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
        capture: bool = False,
        input_text: str | None = None,
    ) -> CommandResult:
        command = tuple(args)
        self.commands.append(command)

        def out(text: str) -> CommandResult:
            return CommandResult(args=args, returncode=0, stdout=text, stderr="")

        if command[:3] == ("gh", "repo", "view"):
            return out("Owner/site\n")
        if command[:3] == ("git", "rev-parse", "HEAD"):
            return out(SHA + "\n")
        if command[:3] == ("git", "rev-parse", "--abbrev-ref"):
            return out("main\n")
        if command[:3] == ("gh", "run", "list"):
            return out(json.dumps([{"databaseId": 42, "status": "completed", "conclusion": self.conclusion, "url": "https://github.com/Owner/site/actions/runs/42", "workflowName": ".github/workflows/kitshn.yml"}]))
        if command[:3] == ("gh", "run", "view") and "--json" in command:
            return out(json.dumps({"status": "completed", "conclusion": self.conclusion, "url": "https://github.com/Owner/site/actions/runs/42", "jobs": [{"name": "call / deploy", "status": "completed", "conclusion": self.conclusion}]}))
        if command[:3] == ("gh", "variable", "get"):
            return out("deploy@vps\n")
        if command[0] == "ssh" and command[-1] == "true":
            return out("")
        if command[0] == "ssh":
            assert "bash -lc" in command[-1] and "kitshn status Owner/site --environment prod" in command[-1]
            return out(json.dumps([{"ref": self.status_ref, "services": [{"Service": "site", "State": "running", "Health": "healthy"}], "caddy_route": True, "default_socket_exists": True}]))
        return out("")


def _recipe_dir(tmp_path: Path) -> Path:
    (tmp_path / ".kitshn.yaml").write_text("deploy:\n  - on: push\n    branch: main\n    name: prod\n", encoding="utf-8")
    (tmp_path / "Caddyfile.j2").write_text(
        '{% if environment == "prod" -%}\nsite.example.com\n{%- else -%}\npr.{{ environment.removeprefix("pr-") }}.site.example.com\n{%- endif %} {\n    reverse_proxy unix//{{ paths.default_socket }}\n}\n',
        encoding="utf-8",
    )
    return tmp_path


def test_track_verifies_run_vps_and_public_route(tmp_path: Path) -> None:
    fetched: list[str] = []

    def fetch(url: str) -> HttpResponse:
        fetched.append(url)
        return HttpResponse(status=200, content_type="text/html; charset=utf-8", body="<h1>build 42</h1>")

    report = track_deploy(
        directory=_recipe_dir(tmp_path),
        runner=TrackRunner(),
        expect="build 42",
        fetch=fetch,
        sleep=lambda _seconds: None,
    )

    assert report.ok is True
    assert report.environment == "prod"
    assert report.url == "https://site.example.com"
    assert fetched == ["https://site.example.com"]
    assert [step.name for step in report.steps] == ["actions run", "vps status", "public route"]


def test_track_stops_at_a_failed_actions_run(tmp_path: Path) -> None:
    runner = TrackRunner(conclusion="failure")

    report = track_deploy(
        directory=_recipe_dir(tmp_path),
        runner=runner,
        fetch=lambda _url: HttpResponse(200, "", ""),
        sleep=lambda _seconds: None,
    )

    assert report.ok is False
    assert [step.name for step in report.steps] == ["actions run"]
    assert any("--log-failed" in command for command in runner.commands)
    assert not any(command[0] == "ssh" for command in runner.commands)


def test_track_reports_stale_ref_after_vps_timeout(tmp_path: Path) -> None:
    report = track_deploy(
        directory=_recipe_dir(tmp_path),
        runner=TrackRunner(status_ref="old"),
        timeouts=TrackTimeouts(vps=0),
        fetch=lambda _url: HttpResponse(200, "", ""),
        sleep=lambda _seconds: None,
    )

    vps = next(step for step in report.steps if step.name == "vps status")
    assert vps.state == "fail"
    assert "ref is old" in vps.detail


def test_status_problems_names_each_failure() -> None:
    entry = {
        "ref": SHA,
        "services": [
            {"Service": "app", "State": "exited", "Health": ""},
            {"Service": "socket-proxy", "State": "running", "Health": "starting"},
        ],
        "caddy_route": True,
        "default_socket_exists": False,
    }

    assert status_problems(entry, SHA) == ["app is exited", "socket-proxy is starting", "default socket is missing"]
    assert status_problems({"ref": SHA, "services": [{"Service": "app", "State": "running"}]}, SHA) == []


def test_cli_track_timeout_defaults_are_the_documented_values() -> None:
    import inspect

    from kitshn.cli import track

    defaults = {name: parameter.default for name, parameter in inspect.signature(track).parameters.items()}
    assert defaults["run_start_timeout"] == DEFAULT_TIMEOUTS.run_start == 120
    assert defaults["run_timeout"] == DEFAULT_TIMEOUTS.run == 1200
    assert defaults["vps_timeout"] == DEFAULT_TIMEOUTS.vps == 120
    assert defaults["route_timeout"] == DEFAULT_TIMEOUTS.route == 180
