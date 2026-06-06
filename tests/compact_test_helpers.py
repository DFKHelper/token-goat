"""Shared test helpers for compact-related test modules.

Consolidates ``_make_bash_entry``, ``_make_bash_history``, ``_make_file_entry``
and ``_make_cache`` that were previously copy-pasted across
``test_compact_manifest.py``, ``test_compact_advanced.py``,
``test_recovery_hint.py``, and ``test_recovery_hint_headings.py``.

Import them as::

    from compact_test_helpers import make_bash_entry, make_bash_history
    from compact_test_helpers import make_file_entry, make_cache

The underscored aliases exist for callers that kept the old names::

    from compact_test_helpers import make_bash_entry as _make_bash_entry
    from compact_test_helpers import make_bash_history as _make_bash_history
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock

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


# Underscored aliases for callers that kept the old private-style names.
_make_bash_entry = make_bash_entry
_make_bash_history = make_bash_history
_make_file_entry = make_file_entry
_make_cache = make_cache
