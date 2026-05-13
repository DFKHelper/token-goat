"""Shared test fixtures."""
import logging
from unittest.mock import patch

import pytest

import tokenwise.paths as paths


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch tokenwise.paths.data_dir to a temporary directory."""
    with patch.object(paths, 'data_dir', return_value=tmp_path):
        yield tmp_path


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
