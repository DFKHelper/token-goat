"""Shared test fixtures."""
import logging
from pathlib import Path
from unittest.mock import patch

import pytest

import tokenwise.paths as paths
from tokenwise.project import Project, canonicalize, project_hash


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch tokenwise.paths.data_dir to a temporary directory."""
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


@pytest.fixture(autouse=True)
def isolate_worker_autostart(monkeypatch):
    """Stop the worker from touching the real HKCU Run key during tests.

    run_daemon() self-registers autostart via worker._register_autostart(),
    which writes to the user's actual Windows registry. Every run_daemon test
    would otherwise mutate the real machine. Stub the worker's registration
    seam to a no-op; tests that exercise the registration itself capture the
    real callable at import time and invoke it directly.
    """
    import tokenwise.worker as worker
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
    import tokenwise.hooks_cli as hooks_cli
    monkeypatch.setattr(hooks_cli, "_setup_logging", lambda: None)

    log = logging.getLogger("tokenwise.hooks")
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
