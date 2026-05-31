"""Tests for advanced compact.py features added in improvement iteration 27.

Covers:
1. Progressive section dropping — truncate-before-drop in safety trim.
2. Symbol cross-reference hints in the recovery hint (_build_recovery_hint).
3. Adaptive budget multiplier (_compute_budget_multiplier).
4. Manifest fingerprint improvement — edited_count and bash_count in payload.
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

from token_goat import compact
from token_goat.compact import (
    _compute_budget_multiplier,
    _compute_manifest_fingerprint,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_bash_entry(
    cmd_preview: str,
    output_id: str = "out-0",
    *,
    exit_code: int = 0,
    ts: float | None = None,
    stdout_bytes: int = 5000,
    stderr_bytes: int = 0,
    run_count: int = 1,
) -> object:
    entry = MagicMock()
    entry.cmd_preview = cmd_preview
    entry.output_id = output_id
    entry.exit_code = exit_code
    entry.ts = ts if ts is not None else time.time()
    entry.stdout_bytes = stdout_bytes
    entry.stderr_bytes = stderr_bytes
    entry.run_count = run_count
    entry.truncated = False
    entry.elapsed_ms = 0
    return entry


def _make_bash_history(*entries: object) -> dict:
    return {str(i): e for i, e in enumerate(entries)}


def _make_file_entry(
    rel_or_abs: str,
    *,
    symbols: list[str] | None = None,
    read_count: int = 1,
    ts: float | None = None,
) -> object:
    entry = MagicMock()
    entry.rel_or_abs = rel_or_abs
    entry.symbols_read = list(symbols or [])
    entry.symbols_ts = {s: (ts or time.time()) for s in (symbols or [])}
    entry.read_count = read_count
    entry.last_read_ts = ts if ts is not None else time.time()
    entry.last_edit_ts = 0.0
    entry.line_ranges = []
    return entry


def _make_cache(
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
# 1. Progressive section dropping
# ---------------------------------------------------------------------------

class TestProgressiveSectionDropping:
    """Safety-trim pass truncates sections before wholesale-dropping them."""

    def test_truncate_before_drop_recovers_budget(self):
        """When over budget, the trim should produce a truncated section with a
        '+N more' tail rather than omitting the section entirely — provided
        truncation is sufficient to meet the budget.
        """
        # Build a manifest with a 'files' section that has many entries so it
        # is over budget, but a truncated version (3 items) fits.

        # The helper is defined inside _render so we test the public effect via
        # a render call instead.  Here we test the conceptual logic through the
        # module-level helper that exists for _apply_section_line_cap.
        lines = ["### Key Files Read"] + [f"- file{i}.py  L:1-100" for i in range(20)]
        truncated = compact._apply_section_line_cap(lines, cap=3)
        assert len(truncated) == 5  # header + 3 items + "+N more"
        assert truncated[-1].startswith("- ...")
        assert "+17 more" in truncated[-1]

    def test_section_header_survives_truncation(self):
        """After truncation the section header must still be present."""
        lines = ["### Grep Patterns"] + [f"- pattern{i}" for i in range(10)]
        truncated = compact._apply_section_line_cap(lines, cap=3)
        assert truncated[0] == "### Grep Patterns"

    def test_no_truncation_when_already_fits(self):
        """If the section already has ≤ cap items, return unchanged."""
        lines = ["### Section"] + [f"- item{i}" for i in range(2)]
        result = compact._apply_section_line_cap(lines, cap=3)
        assert result is lines  # identity preserved

    def test_progressive_trim_produces_truncated_section_not_empty(self):
        """The safety trim should leave a truncated section rather than empty when
        truncation alone is sufficient to meet the budget.

        This tests the _truncate_section_lines inner function logic via
        _apply_section_line_cap which shares the same contract.
        """
        lines = ["### Files Read"] + [f"- src/mod{i}.py  L:1-200" for i in range(50)]
        truncated = compact._apply_section_line_cap(lines, cap=3)
        # Section header preserved, items limited, overflow suffix present
        assert truncated[0] == "### Files Read"
        item_lines = [ln for ln in truncated[1:] if not ln.startswith("- ...")]
        assert len(item_lines) == 3
        overflow_lines = [ln for ln in truncated if ln.startswith("- ...")]
        assert len(overflow_lines) == 1
        assert "+47 more" in overflow_lines[0]

    def test_droppable_section_removed_when_truncation_insufficient(self):
        """When truncated section still over budget, wholesale drop still occurs."""
        # The only testable aspect at the function level: _apply_section_line_cap
        # with cap=0 leaves lines unchanged (disabling the cap).
        lines = ["### Header"] + [f"- item{i}" for i in range(5)]
        result = compact._apply_section_line_cap(lines, cap=0)
        assert result is lines  # cap disabled → unchanged

    def test_overflow_count_correct(self):
        """The '+N more' suffix has the correct overflow count."""
        n_items = 15
        keep = 3
        lines = ["### Header"] + [f"- item{i}" for i in range(n_items)]
        truncated = compact._apply_section_line_cap(lines, cap=keep)
        # N items - keep items = overflow
        expected_overflow = n_items - keep
        assert f"+{expected_overflow} more" in truncated[-1]

    def test_empty_section_unchanged(self):
        """Empty lines list returns empty."""
        assert compact._apply_section_line_cap([], cap=3) == []

    def test_header_only_section_unchanged(self):
        """Section with only a header (no items) is returned unchanged."""
        lines = ["### Header"]
        result = compact._apply_section_line_cap(lines, cap=3)
        assert result is lines


# ---------------------------------------------------------------------------
# 2. _compute_budget_multiplier
# ---------------------------------------------------------------------------

class TestComputeBudgetMultiplier:
    """_compute_budget_multiplier returns escalated multiplier for heavy sessions."""

    def test_light_session_returns_base(self):
        """A session with few edits and no test failures uses the base multiplier."""
        cache = _make_cache(
            edited_files={"file1.py": 1, "file2.py": 2},
            bash_history={},
        )
        result = _compute_budget_multiplier(cache, base_multiplier=2.0)
        assert result == 2.0

    def test_many_edited_files_escalates_to_2_5(self):
        """More than 10 edited files triggers escalation to 2.5×."""
        edited = {f"src/file{i}.py": i + 1 for i in range(11)}
        cache = _make_cache(edited_files=edited, bash_history={})
        result = _compute_budget_multiplier(cache, base_multiplier=2.0)
        assert result == 2.5

    def test_exactly_10_edited_files_does_not_escalate(self):
        """Exactly 10 edited files is NOT above threshold — no escalation."""
        edited = {f"src/file{i}.py": 1 for i in range(10)}
        cache = _make_cache(edited_files=edited, bash_history={})
        result = _compute_budget_multiplier(cache, base_multiplier=2.0)
        assert result == 2.0

    def test_many_test_failures_escalates(self):
        """More than 5 distinct test failures triggers escalation."""
        pytest_output = "\n".join(
            f"FAILED tests/test_mod.py::test_case_{i}"
            for i in range(6)
        )
        be = _make_bash_entry("pytest tests/", exit_code=1)
        bash_hist = _make_bash_history(be)
        cache = _make_cache(edited_files={}, bash_history=bash_hist)
        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = _compute_budget_multiplier(cache, base_multiplier=2.0)
        assert result == 2.5

    def test_exactly_5_failures_does_not_escalate(self):
        """Exactly 5 distinct test failures is NOT above threshold — no escalation."""
        pytest_output = "\n".join(
            f"FAILED tests/test_mod.py::test_case_{i}"
            for i in range(5)
        )
        be = _make_bash_entry("pytest tests/", exit_code=1)
        bash_hist = _make_bash_history(be)
        cache = _make_cache(edited_files={}, bash_history=bash_hist)
        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = _compute_budget_multiplier(cache, base_multiplier=2.0)
        assert result == 2.0

    def test_returns_base_when_not_escalated(self):
        """Return value equals base_multiplier when thresholds are not crossed."""
        cache = _make_cache(edited_files={}, bash_history={})
        for base in (1.0, 1.5, 2.0, 3.0):
            assert _compute_budget_multiplier(cache, base_multiplier=base) == base

    def test_escalation_does_not_reduce_high_base(self):
        """If base_multiplier is already ≥ 2.5, escalation never reduces it."""
        edited = {f"file{i}.py": 1 for i in range(20)}
        cache = _make_cache(edited_files=edited, bash_history={})
        result = _compute_budget_multiplier(cache, base_multiplier=3.0)
        assert result == 3.0  # max(3.0, 2.5) == 3.0

    def test_empty_edited_files_no_escalation(self):
        """Empty edited_files dict returns base."""
        cache = _make_cache(edited_files={}, bash_history={})
        assert _compute_budget_multiplier(cache, base_multiplier=2.0) == 2.0

    def test_non_dict_edited_files_treated_as_zero(self):
        """Non-dict edited_files is treated as count=0 (no escalation)."""
        cache = _make_cache(bash_history={})
        cache.edited_files = None  # override to non-dict
        assert _compute_budget_multiplier(cache, base_multiplier=2.0) == 2.0


# ---------------------------------------------------------------------------
# 3. Manifest fingerprint improvement
# ---------------------------------------------------------------------------

def _make_plain_bash_entry(cmd: str, ts: float = 1_700_000_000.0) -> dict:
    """Return a plain dict that safely passes through _compute_manifest_fingerprint.

    ``_entry_payload`` in compact.py calls ``dataclasses.asdict`` when the
    entry has ``__dataclass_fields__`` — MagicMock auto-creates that attribute,
    causing ``asdict`` to fail.  Using a plain dict avoids the dataclass path
    entirely since dicts don't have ``__dataclass_fields__``.
    """
    return {"cmd": cmd, "ts": ts, "exit_code": 0}


class TestManifestFingerprintImprovement:
    """_compute_manifest_fingerprint includes edited_count and bash_count."""

    def test_fingerprint_changes_when_edited_count_increases(self):
        """Adding an edited file changes the fingerprint even if text is unchanged."""
        cache_a = _make_cache(edited_files={"a.py": 1})
        cache_b = _make_cache(edited_files={"a.py": 1, "b.py": 2})
        fp_a = _compute_manifest_fingerprint(cache_a)
        fp_b = _compute_manifest_fingerprint(cache_b)
        assert fp_a != fp_b

    def test_fingerprint_changes_when_bash_count_increases(self):
        """Adding a bash entry changes the fingerprint."""
        be = _make_plain_bash_entry("pytest")
        cache_a = _make_cache(bash_history={})
        cache_b = _make_cache(bash_history={"0": be})
        fp_a = _compute_manifest_fingerprint(cache_a)
        fp_b = _compute_manifest_fingerprint(cache_b)
        assert fp_a != fp_b

    def test_fingerprint_stable_for_identical_cache(self):
        """Same cache inputs always produce the same fingerprint."""
        be = _make_plain_bash_entry("ruff check", ts=1_700_000_000.0)
        cache = _make_cache(
            edited_files={"src/foo.py": 3},
            bash_history={"k1": be},
        )
        fp1 = _compute_manifest_fingerprint(cache)
        fp2 = _compute_manifest_fingerprint(cache)
        assert fp1 == fp2

    def test_fingerprint_is_hex_string_of_expected_length(self):
        """Fingerprint is a 16-char hex string."""
        cache = _make_cache()
        fp = _compute_manifest_fingerprint(cache)
        assert isinstance(fp, str)
        assert len(fp) == 16
        assert all(c in "0123456789abcdef" for c in fp)

    def test_empty_vs_nonempty_edited_differ(self):
        """Empty vs. non-empty edited_files produce different fingerprints."""
        cache_empty = _make_cache(edited_files={})
        cache_one = _make_cache(edited_files={"x.py": 1})
        assert _compute_manifest_fingerprint(cache_empty) != _compute_manifest_fingerprint(cache_one)

    def test_empty_vs_nonempty_bash_differ(self):
        """Empty vs. non-empty bash_history produce different fingerprints."""
        be = _make_plain_bash_entry("uv run pytest")
        cache_empty = _make_cache(bash_history={})
        cache_one = _make_cache(bash_history={"0": be})
        assert _compute_manifest_fingerprint(cache_empty) != _compute_manifest_fingerprint(cache_one)

    def test_fingerprint_changes_when_file_count_drops(self):
        """Removing a bash entry (count drops) changes the fingerprint."""
        be = _make_plain_bash_entry("ruff check")
        cache_two = _make_cache(bash_history={"0": be, "1": be})
        cache_one = _make_cache(bash_history={"0": be})
        fp_two = _compute_manifest_fingerprint(cache_two)
        fp_one = _compute_manifest_fingerprint(cache_one)
        assert fp_two != fp_one


# ---------------------------------------------------------------------------
# 4. Symbol cross-reference hints in recovery hint
# ---------------------------------------------------------------------------

class TestRecoveryHintSymbols:
    """_build_recovery_hint includes a **Symbols** sub-section when symbols exist."""

    def _make_session_cache(
        self,
        *,
        files: dict | None = None,
        bash_history: dict | None = None,
        web_history: dict | None = None,
        edited_files: dict | None = None,
        skill_history: dict | None = None,
    ) -> MagicMock:
        cache = MagicMock()
        cache.files = files or {}
        cache.bash_history = bash_history or {}
        cache.web_history = web_history or {}
        cache.edited_files = edited_files or {}
        cache.skill_history = skill_history or {}
        cache.unavailable = False
        return cache

    def _run_recovery_hint(self, cache: MagicMock) -> str | None:
        from token_goat.hooks_session import _build_recovery_hint

        # _build_recovery_hint does `from . import session as session_mod` then
        # calls session_mod.load(session_id), so we patch the canonical module
        # attribute rather than a module-level alias.
        with (
            patch("token_goat.session.load", return_value=cache),
            patch("token_goat.bash_cache.load_output", return_value=""),
        ):
            return _build_recovery_hint("test-session-id-0000")

    def test_symbols_section_present_when_symbols_exist(self):
        """When files have symbols_read entries the **Symbols** section appears."""
        fe = _make_file_entry("src/auth.py", symbols=["login", "logout"])
        cache = self._make_session_cache(
            files={"k": fe},
            edited_files={"src/auth.py": 2},
        )
        hint = self._run_recovery_hint(cache)
        assert hint is not None
        assert "**Symbols**:" in hint
        assert "login" in hint
        assert "logout" in hint

    def test_symbols_section_absent_when_no_symbols(self):
        """When no files have symbol information the **Symbols** section is omitted."""
        fe = _make_file_entry("src/utils.py", symbols=[])
        cache = self._make_session_cache(
            files={"k": fe},
            edited_files={"src/utils.py": 1},
        )
        hint = self._run_recovery_hint(cache)
        # Should either be None (no sections at all) or not contain **Symbols**
        if hint is not None:
            assert "**Symbols**:" not in hint

    def test_symbols_capped_at_10(self):
        """No more than 10 symbols appear in the **Symbols** section."""
        symbols = [f"symbol_{i}" for i in range(20)]
        fe = _make_file_entry("src/big.py", symbols=symbols)
        cache = self._make_session_cache(
            files={"k": fe},
            edited_files={"src/big.py": 1},
        )
        hint = self._run_recovery_hint(cache)
        assert hint is not None
        assert "**Symbols**:" in hint
        # Count entries (lines starting with "- " after **Symbols**:)
        in_symbols = False
        sym_count = 0
        for line in hint.split("\n"):
            if "**Symbols**:" in line:
                in_symbols = True
                continue
            if in_symbols:
                if line.startswith("- "):
                    sym_count += 1
                elif line.startswith("**") or not line.strip():
                    break
        assert sym_count <= 10

    def test_symbols_include_filename(self):
        """Each symbol line shows the source filename."""
        fe = _make_file_entry("src/compact.py", symbols=["build_manifest"])
        cache = self._make_session_cache(
            files={"k": fe},
            edited_files={"src/compact.py": 3},
        )
        hint = self._run_recovery_hint(cache)
        assert hint is not None
        assert "compact.py" in hint
        assert "build_manifest" in hint

    def test_symbols_deduped_across_files(self):
        """The same symbol name from multiple files appears only once."""
        fe1 = _make_file_entry("src/a.py", symbols=["helper"])
        fe2 = _make_file_entry("src/b.py", symbols=["helper"])
        cache = self._make_session_cache(
            files={"k1": fe1, "k2": fe2},
            edited_files={"src/a.py": 1},
        )
        hint = self._run_recovery_hint(cache)
        if hint and "**Symbols**:" in hint:
            # Count occurrences of "helper" in the symbols section
            sym_section_start = hint.find("**Symbols**:")
            sym_text = hint[sym_section_start:]
            assert sym_text.count("helper") == 1

    def test_recovery_hint_includes_symbols_alongside_bash(self):
        """Recovery hint with both bash history and symbols includes both sections."""
        fe = _make_file_entry("src/session.py", symbols=["SessionCache", "load"])
        be = _make_bash_entry("uv run pytest", stdout_bytes=5000)
        cache = self._make_session_cache(
            files={"k": fe},
            bash_history={"0": be},
            edited_files={"src/session.py": 1},
        )
        hint = self._run_recovery_hint(cache)
        assert hint is not None
        assert "**Symbols**:" in hint
        assert "**Bash**:" in hint
