"""Shared test helpers for compact-related test modules.

Consolidates ``_make_bash_entry``, ``_make_bash_history``, ``_make_file_entry``,
``_make_cache``, ``make_fake_session_cache``, and ``DataDirMixin`` that were
previously copy-pasted across ``test_compact_manifest.py``,
``test_compact_advanced.py``, ``test_recovery_hint.py``,
``test_recovery_hint_headings.py``, ``test_compact.py``,
``test_hooks_session.py``, and a further 8 compact/skill test modules.

Import them as::

    from compact_test_helpers import make_bash_entry, make_bash_history
    from compact_test_helpers import make_file_entry, make_cache
    from compact_test_helpers import make_fake_session_cache
    from compact_test_helpers import DataDirMixin

The underscored aliases exist for callers that kept the old names::

    from compact_test_helpers import make_bash_entry as _make_bash_entry
    from compact_test_helpers import make_bash_history as _make_bash_history
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# BashEntry-like mock
# ---------------------------------------------------------------------------


def make_bash_entry(
    cmd_preview: str,
    output_id: str = "out-0",
    *,
    exit_code: int = 0,
    ts: float | None = None,
    stdout_bytes: int = 5000,
    stderr_bytes: int = 0,
    run_count: int = 1,
    elapsed_ms: int = 0,
) -> object:
    """Build a minimal BashEntry-like MagicMock for testing.

    The superset of all previously duplicated ``_make_bash_entry`` helpers:
    - ``test_compact_manifest``: no ``stderr_bytes``, ``run_count``, ``elapsed_ms`` params
    - ``test_compact_advanced``: has all params; ``output_id`` defaults to ``"out-0"``
    - ``test_recovery_hint_headings``: fixed ``ts=1200.0``, ``run_count=1``

    All callers are compatible with this signature — the extras are keyword-only.
    """
    entry = MagicMock()
    entry.cmd_preview = cmd_preview
    entry.output_id = output_id
    entry.exit_code = exit_code
    entry.ts = ts if ts is not None else time.time()
    entry.stdout_bytes = stdout_bytes
    entry.stderr_bytes = stderr_bytes
    entry.run_count = run_count
    entry.truncated = False
    entry.elapsed_ms = elapsed_ms
    return entry


def make_bash_history(*entries: object) -> dict:
    """Wrap entries into a ``cmd_sha → BashEntry`` dict (keyed by index)."""
    return {str(i): e for i, e in enumerate(entries)}


# ---------------------------------------------------------------------------
# FileEntry-like mock
# ---------------------------------------------------------------------------


def make_file_entry(
    rel_or_abs: str,
    *,
    symbols: list[str] | None = None,
    read_count: int = 1,
    ts: float | None = None,
    edited: bool = False,
) -> MagicMock:
    """Build a minimal FileEntry-like MagicMock for testing.

    Covers the union of signatures from:
    - ``test_compact_advanced`` (``symbols``, ``read_count``, ``ts``)
    - ``test_recovery_hint_headings`` (``path``, ``read_count``, ``edited``)
    """
    _ts = ts if ts is not None else time.time()
    entry = MagicMock()
    entry.rel_or_abs = rel_or_abs
    entry.symbols_read = list(symbols or [])
    entry.symbols_ts = {s: _ts for s in (symbols or [])}
    entry.read_count = read_count
    entry.last_read_ts = _ts
    entry.last_edit_ts = _ts + 100.0 if edited else 0.0
    entry.line_ranges = []
    return entry


# ---------------------------------------------------------------------------
# SessionCache-like mock
# ---------------------------------------------------------------------------


def make_cache(
    *,
    edited_files: dict | None = None,
    bash_history: dict | None = None,
    files: dict | None = None,
    web_history: dict | None = None,
    greps: list | None = None,
    glob_history: list | None = None,
    skill_history: dict | None = None,
    decisions: list | None = None,
    cwd: str | None = None,
    created_ts: float | None = None,
    hints_emitted: int = 0,
    hints_suppressed_by_type: dict | None = None,
    bash_dedup_emitted_ids: set | None = None,
) -> MagicMock:
    """Build a minimal SessionCache-like MagicMock for testing."""
    cache = MagicMock()
    cache.edited_files = edited_files if edited_files is not None else {}
    cache.bash_history = bash_history if bash_history is not None else {}
    cache.files = files if files is not None else {}
    cache.web_history = web_history if web_history is not None else {}
    cache.greps = greps if greps is not None else []
    cache.glob_history = glob_history if glob_history is not None else []
    cache.skill_history = skill_history if skill_history is not None else {}
    cache.decisions = decisions if decisions is not None else []
    cache.cwd = cwd
    cache.created_ts = created_ts if created_ts is not None else time.time()
    cache.hints_emitted = hints_emitted
    cache.hints_suppressed_by_type = hints_suppressed_by_type or {}
    cache.bash_dedup_emitted_ids = bash_dedup_emitted_ids or set()
    return cache


# ---------------------------------------------------------------------------
# Fake SessionCache for adaptive-budget / sentinel tests
# ---------------------------------------------------------------------------


def make_fake_session_cache() -> MagicMock:
    """Create a mock SessionCache with minimal required attributes.

    The adaptive budget computation needs created_ts and various history
    attributes. This helper ensures the mock has all required fields set
    to non-MagicMock values so comparisons work correctly.
    """
    cache = MagicMock()
    # Use current time, so age_seconds will be near 0 (young session)
    cache.created_ts = time.time()
    # Stub attributes that compute_adaptive_budget checks with isinstance/getattr
    cache.edited_files = {}  # Not a dict → 0 bonus
    cache.files = {}  # Empty → 0 symbols accessed
    cache.bash_history = None  # No bash history
    cache.web_history = None  # No web history
    return cache


def clear_process_guard(sid: str) -> None:
    """Remove *sid* from the process-local manifest-SHA guard set.

    Used by test classes to simulate a new hook process starting (the guard
    set is module-level in ``token_goat.compact``, so each test class that
    tests deduplication across "processes" needs to evict the session ID
    before each sub-scenario).
    """
    from token_goat import compact

    compact._manifest_sha_written_this_process.discard(sid)


# Underscored aliases for callers that kept the old private-style names.
_make_bash_entry = make_bash_entry
_make_bash_history = make_bash_history
_make_file_entry = make_file_entry
_make_cache = make_cache


# ---------------------------------------------------------------------------
# DataDirMixin — single autouse _isolate fixture for classes that only need
# tmp_data_dir bound to self.tmp_data_dir.  Replaces 35 identical per-class
# copies across the compact / skill test modules.
#
# Usage::
#
#     from compact_test_helpers import DataDirMixin
#
#     class TestFoo(DataDirMixin):
#         def test_it(self):
#             path = self.tmp_data_dir / "something"
# ---------------------------------------------------------------------------


class DataDirMixin:
    """Mixin that binds the ``tmp_data_dir`` fixture to ``self.tmp_data_dir``.

    Every test class that only needs data-dir isolation (no monkeypatching of
    skills or plugins paths) should inherit from this instead of repeating the
    two-line ``_isolate`` fixture.
    """

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):  # noqa: PT004
        self.tmp_data_dir = tmp_data_dir
