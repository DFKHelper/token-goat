"""Shared test fixtures."""
import logging
from pathlib import Path
from unittest.mock import patch

import pytest

import token_goat.paths as paths
from token_goat.project import Project, canonicalize, project_hash


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch token_goat.paths.data_dir to a temporary directory."""
    with patch.object(paths, 'data_dir', return_value=tmp_path):
        yield tmp_path


def make_project_from_root(root: Path) -> Project:
    """Construct a Project from a root directory.

    Helper function for test fixtures. Use in project fixtures like:
        proj_root = tmp_path / "sample"
        shutil.copytree(SOURCE, proj_root)
        return make_project_from_root(proj_root)
    """
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


# Expose as fixture for use in test files
@pytest.fixture
def make_project(tmp_data_dir):
    """Fixture that provides make_project_from_root function.

    Use in test functions like:
        def test_something(make_project):
            proj_root = tmp_path / "sample"
            shutil.copytree(SOURCE, proj_root)
            proj = make_project(proj_root)
    """
    return make_project_from_root


class _FakeRegistryKey:
    """In-memory stand-in for an open registry key handle."""

    def __init__(self, values: dict):
        self.values = values

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeWinreg:
    """In-memory fake of the stdlib ``winreg`` module.

    Covers exactly the surface token-goat's install/uninstall/doctor code uses.
    Backed by one dict so a write through one handle is visible to a read
    through another within the same test. Used by the ``isolate_registry``
    autouse fixture so no test can ever touch the real Windows registry.
    """

    HKEY_CURRENT_USER = "HKCU"
    HKEY_LOCAL_MACHINE = "HKLM"
    REG_SZ = 1
    KEY_SET_VALUE = 0x0002
    KEY_READ = 0x20019

    def __init__(self) -> None:
        self._values: dict[str, object] = {}

    def OpenKey(self, hive, path, reserved, access):  # noqa: N802
        return _FakeRegistryKey(self._values)

    def OpenKeyEx(self, hive, path, reserved=0, access=0):  # noqa: N802
        return self.OpenKey(hive, path, reserved, access)

    def SetValueEx(self, key, name, reserved, reg_type, value):  # noqa: N802
        key.values[name] = value

    def QueryValueEx(self, key, name):  # noqa: N802
        if name not in key.values:
            raise FileNotFoundError(name)
        return key.values[name], self.REG_SZ

    def DeleteValue(self, key, name):  # noqa: N802
        if name not in key.values:
            raise FileNotFoundError(name)
        del key.values[name]

    def CloseKey(self, key):  # noqa: N802
        pass


@pytest.fixture(autouse=True)
def isolate_registry(monkeypatch):
    r"""Stop any test from reading or writing the real Windows registry.

    install_all()/uninstall_all() — and install_worker_task()/uninstall_tasks()
    — call ``winreg`` directly. A test exercising them unmocked writes, then
    DELETES, the user's real ``token-goat-worker`` HKCU Run key (the worker's
    autostart entry) on every ``pytest`` run — which is exactly what
    test_install_uninstall_round_trip did. Replace ``winreg`` in sys.modules
    with an in-memory fake for every test. A test that needs to assert on
    specific registry writes installs its own fake on top — it wins, being set
    up after this fixture.
    """
    import sys

    monkeypatch.setitem(sys.modules, "winreg", _FakeWinreg())
    yield


@pytest.fixture(autouse=True)
def isolate_worker_autostart(monkeypatch):
    """Stop the worker from touching the real HKCU Run key during tests.

    run_daemon() self-registers autostart via worker._register_autostart(),
    which writes to the user's actual Windows registry. Every run_daemon test
    would otherwise mutate the real machine. Stub the worker's registration
    seam to a no-op; tests that exercise the registration itself capture the
    real callable at import time and invoke it directly.
    """
    import token_goat.worker as worker
    monkeypatch.setattr(worker, "_register_autostart", lambda: None)
    yield


@pytest.fixture(autouse=True)
def isolate_hook_logging(monkeypatch):
    """Stop hook handlers from writing to the production log file during tests.

    The hook dispatcher attaches a FileHandler at paths.logs_dir() / YYYY-MM-DD.log
    — the user's real daily log. Without this fixture, every test that dispatches
    a hook (including fail-soft tests that intentionally throw) pollutes it.
    We disable _setup_logging() for the test and clear any handlers that were
    already attached to the hooks logger before/after.
    """
    import token_goat.hooks_cli as hooks_cli
    monkeypatch.setattr(hooks_cli, "_setup_logging", lambda: None)

    log = logging.getLogger("token_goat.hooks")
    saved = list(log.handlers)
    for h in saved:
        log.removeHandler(h)
    try:
        yield
    finally:
        for h in list(log.handlers):
            log.removeHandler(h)
        for h in saved:
            log.addHandler(h)
