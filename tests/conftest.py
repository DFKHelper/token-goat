"""Shared test fixtures."""
import logging
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Shared hook-response assertions — see tests/hook_helpers.py
# ---------------------------------------------------------------------------
# assert_continue and assert_deny live in hook_helpers.py (importable module).
# Test files import them directly: from hook_helpers import assert_continue
import token_goat.paths as paths
from token_goat.parser import index_project
from token_goat.project import Project, canonicalize, project_hash

# Sample fixture directories - centralized to avoid duplication across test files
FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"
PY_SAMPLE = FIXTURE_DIR / "py_sample"
MD_SAMPLE = FIXTURE_DIR / "md_sample"
GO_SAMPLE = FIXTURE_DIR / "go_sample"
RUST_SAMPLE = FIXTURE_DIR / "rust_sample"
JS_SAMPLE = FIXTURE_DIR / "js_sample"


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


# ============================================================================
# Project Fixture Factories
# ============================================================================
# Consolidated project-creation fixtures to eliminate duplication across
# test_read_replacement.py, test_embeddings.py, test_index_pipeline.py, test_repomap.py


def _make_sample_project(tmp_path: Path, tmp_data_dir, make_project, sample_path: Path, indexed: bool = False):
    """Internal helper: copy sample fixture to tmp dir, optionally index, return (proj_root, project).

    Args:
        tmp_path: pytest tmp_path fixture
        tmp_data_dir: monkeypatched data_dir fixture
        make_project: project-builder fixture
        sample_path: source fixture directory (e.g., TS_SAMPLE)
        indexed: if True, call index_project(proj, full=True) before returning

    Returns:
        (proj_root, project) tuple, or just project if indexed (for repomap fixture pattern)
    """
    sample_name = sample_path.name
    proj_root = tmp_path / sample_name
    shutil.copytree(sample_path, proj_root)
    # Create a minimal .git dir so find_project() detects this as a project
    # when the CLI runs internal find_project(Path.cwd()) after monkeypatch.chdir.
    (proj_root / ".git").mkdir(exist_ok=True)
    proj = make_project(proj_root)
    if indexed:
        index_project(proj, full=True)
    return (proj_root, proj) if indexed else proj


# Unindexed project fixtures (for tests that do their own indexing)
@pytest.fixture
def ts_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=False)


@pytest.fixture
def py_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=False)


@pytest.fixture
def md_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=False)


# Indexed project fixtures - tuple variants (for read_replacement tests)
@pytest.fixture
def ts_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, index it, return (proj_root, project).

    Used by test_read_replacement.py. Returns a tuple for unpacking:
        proj_root, proj = ts_project_tuple
    """
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=True)
    return proj_root, proj


@pytest.fixture
def py_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=True)
    return proj_root, proj


@pytest.fixture
def md_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=True)
    return proj_root, proj


# Indexed project fixtures - project-only (for embeddings, repomap, index_pipeline tests)
@pytest.fixture
def ts_project(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, index it, return just the Project.

    Used by test_embeddings.py, test_repomap.py, test_index_pipeline.py.
    """
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=True)
    return proj


@pytest.fixture
def py_project(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, index it, return just the Project.

    Used by test_index_pipeline.py.
    """
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=True)
    return proj


@pytest.fixture
def md_project(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, index it, return just the Project."""
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=True)
    return proj


# CLI fixtures (sets cwd to project root for CLI tests)
@pytest.fixture
def indexed_ts_cli(ts_project, monkeypatch):
    """Return (proj_root, proj) with cwd set to proj_root (for CLI tests)."""
    proj_root, proj = ts_project
    monkeypatch.chdir(proj_root)
    return proj_root, proj


@pytest.fixture
def indexed_md_cli(md_project, monkeypatch):
    """Return (proj_root, proj) with cwd set to proj_root (for CLI tests)."""
    proj_root, proj = md_project
    monkeypatch.chdir(proj_root)
    return proj_root, proj


@pytest.fixture
def indexed_py_cli(py_project, monkeypatch):
    """Return (proj_root, proj) with cwd set to proj_root (for CLI tests)."""
    proj_root, proj = py_project
    monkeypatch.chdir(proj_root)
    return proj_root, proj
