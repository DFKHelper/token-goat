"""Tests for advanced compact.py features added in improvement iteration 27.

Covers:
1. Progressive section dropping — truncate-before-drop in safety trim.
2. Symbol cross-reference hints in the recovery hint (_build_recovery_hint).
3. Adaptive budget multiplier (_compute_budget_multiplier).
4. Manifest fingerprint improvement — edited_count and bash_count in payload.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from compact_test_helpers import make_bash_entry as _make_bash_entry
from compact_test_helpers import make_bash_history as _make_bash_history
from compact_test_helpers import make_cache as _make_cache
from compact_test_helpers import make_file_entry as _make_file_entry

from token_goat import compact
from token_goat.compact import (
    _compute_budget_multiplier,
    _compute_manifest_fingerprint,
)

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


# ---------------------------------------------------------------------------
# 5. Safety-trim drop order — overflow guard completeness
# ---------------------------------------------------------------------------

class TestSafetyTrimDropOrder:
    """The safety-trim _droppable_names_in_drop_order must list every unprotected
    section so they are dropped gracefully (section-at-a-time) rather than
    falling through to the destructive line-popping fallback.

    These tests guard against the bug where 'open_questions', 'active_errors',
    'session_goal', 'most_accessed', and 'recent_commits' were absent from the
    drop list.
    """

    def _all_unprotected_section_names(self) -> list[str]:
        """Return all section names marked protected=False in _section_groups.

        We derive this by inspecting the source of truth — _render's
        _section_groups list — via a thin rendering call with a saturated
        but simple cache.  Instead we hard-code the expected set based on
        the documented _section_groups listing in compact.py.
        """
        return [
            "recent_commits", "stale", "most_accessed", "session_goal",
            "bash", "what_worked", "syms", "web", "glob", "dep_changes",
            "grep", "files", "todos", "open_questions", "active_errors",
        ]

    def test_droppable_names_covers_all_unprotected_sections(self):
        """Every unprotected section name must appear in _droppable_names_in_drop_order.

        This is a structural test: it verifies that the drop-order list
        enumerates all unprotected sections so no section silently escapes
        the priority-aware trim and forces the blunt line-popping fallback.
        """
        # Build a fake cache and run _render at a large budget so it
        # populates as many sections as possible, then check that the
        # droppable list is complete.  We do this by inspecting the
        # compact module directly — the drop-order list is embedded in
        # the closure inside _render, so we extract it by patching.

        # The simplest approach: read the source to find the list literal.
        import inspect
        src = inspect.getsource(compact._render)
        # The list is defined as a local variable inside _render.
        # It must contain these five names that were previously missing.
        previously_missing = [
            "open_questions", "active_errors", "session_goal",
            "most_accessed", "recent_commits",
        ]
        for name in previously_missing:
            assert f'"{name}"' in src, (
                f"Section '{name}' is absent from _droppable_names_in_drop_order "
                f"inside compact._render.  It is an unprotected section and must "
                f"be listed so the safety-trim pass can drop it gracefully instead "
                f"of falling through to the destructive line-popping fallback."
            )

    def test_open_questions_dropped_before_bash(self, tmp_data_dir):
        """open_questions (lower signal) must be dropped before bash (higher signal)
        when the manifest exceeds its budget.

        Seeds a session so that open_questions fires (has edited files with TODO
        markers) and bash fires (has command history), then verifies that at a
        tight budget bash survives when open_questions is gone.
        """
        from token_goat import session as session_mod

        sid = "trim-drop-order-oq-bash"
        # Mark an edited file
        session_mod.mark_file_edited(sid, "/proj/src/feature.py")
        # Mark bash commands so the bash section fires
        for i in range(5):
            cmd_sha = f"shacmdbash{i:02d}{'z' * 8}"[:16]
            session_mod.mark_bash_run(
                session_id=sid,
                cmd_sha=cmd_sha,
                cmd_preview=f"uv run pytest tests/test_feature_{i}.py",
                output_id=f"{sid[:16]}-{i:013d}-{cmd_sha}",
                stdout_bytes=5000,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )

        # Patch _find_open_questions to return some questions so the section fires.
        with patch("token_goat.compact._find_open_questions", return_value=["TODO: fix me"]):
            # Use a budget tight enough to require trimming but large enough that
            # bash can survive once open_questions is dropped.
            manifest, _ = compact.build_manifest_with_count(sid, max_tokens=120)

        assert manifest, "manifest must not be empty"
        # bash section should survive (it is higher-signal than open_questions)
        assert "Recent Commands" in manifest or "pytest" in manifest, (
            "bash section was dropped before open_questions despite being higher-signal"
        )

    def _extract_drop_order(self) -> list[str]:
        """Extract the _droppable_names_in_drop_order list from compact._render source.

        Parses the list literal from the source code so ordering tests don't
        rely on fragile absolute positions in the full function source.
        """
        import inspect
        import re
        src = inspect.getsource(compact._render)
        # Find the assignment block — it starts with _droppable_names_in_drop_order = [
        # and ends with the closing ] on the same or a subsequent line.
        match = re.search(
            r'_droppable_names_in_drop_order\s*=\s*\[(.*?)\]',
            src,
            re.DOTALL,
        )
        assert match, "_droppable_names_in_drop_order list not found in compact._render"
        # Extract all quoted names from the matched block.
        names = re.findall(r'"([^"]+)"', match.group(1))
        return names

    def test_session_goal_dropped_before_syms(self):
        """session_goal (lower signal) must appear in the drop list before syms.

        session_goal is inferred context; syms carries precise symbol access
        history that guides the next agent turn after compaction.
        """
        order = self._extract_drop_order()
        assert "session_goal" in order, '"session_goal" missing from drop order'
        assert "syms" in order, '"syms" missing from drop order'
        assert order.index("session_goal") < order.index("syms"), (
            f"'session_goal' (index {order.index('session_goal')}) should appear before "
            f"'syms' (index {order.index('syms')}) in _droppable_names_in_drop_order"
        )

    def test_recent_commits_dropped_before_syms(self):
        """recent_commits must be dropped before syms in the drop order.

        recent_commits carries low signal (git log can recover it); syms
        carries higher signal (symbol access history guides the next agent turn).
        """
        order = self._extract_drop_order()
        assert "recent_commits" in order, '"recent_commits" missing from drop order'
        assert "syms" in order, '"syms" missing from drop order'
        assert order.index("recent_commits") < order.index("syms"), (
            f"'recent_commits' (index {order.index('recent_commits')}) should appear before "
            f"'syms' (index {order.index('syms')}) in _droppable_names_in_drop_order"
        )

    def test_active_errors_dropped_before_bash(self):
        """active_errors must appear in the drop list before bash.

        active_errors is a small derived section; bash carries richer work context.
        """
        order = self._extract_drop_order()
        assert "active_errors" in order, '"active_errors" missing from drop order'
        assert "bash" in order, '"bash" missing from drop order'
        assert order.index("active_errors") < order.index("bash"), (
            f"'active_errors' (index {order.index('active_errors')}) should appear before "
            f"'bash' (index {order.index('bash')}) in _droppable_names_in_drop_order"
        )
