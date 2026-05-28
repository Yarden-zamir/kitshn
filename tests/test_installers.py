from kitshn.installer_registry import read_os_release, suggested_installers
from kitshn.runner import CommandRunner


class FakeRunner(CommandRunner):
    def __init__(self, executables: set[str]) -> None:
        super().__init__()
        self.executables = executables

    def exists(self, executable: str) -> bool:
        return executable in self.executables


def test_suggested_installers_fall_back_to_package_manager(monkeypatch) -> None:
    monkeypatch.setattr("kitshn.installer_registry.read_os_release", lambda: {})

    installers = suggested_installers(FakeRunner({"apt-get"}))

    assert [installer.name for installer in installers] == ["debian", "ubuntu"]


def test_read_os_release_parses_quoted_values(tmp_path) -> None:
    os_release = tmp_path / "os-release"
    os_release.write_text('ID="ubuntu"\nVERSION_CODENAME=noble\n', encoding="utf-8")

    assert read_os_release(os_release) == {"ID": "ubuntu", "VERSION_CODENAME": "noble"}
