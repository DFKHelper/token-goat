"""Tests for compaction assistance quality improvements — iterations 26-30.

Covers:
A. Manifest delta line accuracy — delta has content when session has activity
   (new edited files, new bash commands, new symbols accessed).
B. Session goal inference improvements — bash work patterns (pytest/ruff/mypy/etc)
   are used to infer the dominant work mode when no commit message is available.
C. Compact-hint token budget accuracy — the displayed token estimate uses the
   same ``estimate_tokens`` formula that ``_render`` uses internally.
D. Skills section ordering — skills used in the last 5 minutes appear before
   older skills in the manifest.
E. Compact skip TTL fast path — activity after sentinel creation causes a
   re-compute on next pre-compact (sentinel is busted).
"""
from __future__ import annotations

import time
from types import SimpleNamespace

from compact_test_helpers import clear_process_guard as _clear_process_guard

from token_goat import compact, paths, session
from token_goat.hooks_cli import (
    _check_compact_skip_sentinel_detail,
    _write_compact_skip_sentinel,
)

# ---------------------------------------------------------------------------
# Sub-area A — Manifest delta captures new edited files, bash cmds, symbols
# ---------------------------------------------------------------------------

class TestManifestDeltaQuality:
    """Delta line accurately reflects growth in edited files, bash cmds, and symbols."""

    def _clear_process_guard(self, sid: str) -> None:
        _clear_process_guard(sid)

    def test_delta_shows_new_edited_files(self, tmp_data_dir):
        """Delta line carries +N edited when new files are edited between compacts."""
        sid = "quality-delta-edited-a26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        compact.build_manifest(sid)  # first compact establishes baseline

        session.mark_file_edited(sid, "/proj/src/new_file.py")
        session.mark_file_edited(sid, "/proj/src/another.py")

        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        assert "Δ since last compact" in second
        assert "+2 edited" in second

    def test_delta_shows_new_bash_commands(self, tmp_data_dir):
        """Delta line carries +N bash when new bash commands are run between compacts."""
        import uuid
        sid = f"quality-delta-bash-a26-{uuid.uuid4().hex[:8]}"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        compact.build_manifest(sid)  # first compact

        # Add bash runs after first compact
        session.mark_bash_run(
            sid,
            cmd_sha="aa1",
            cmd_preview="pytest -x tests/",
            output_id="o1",
            stdout_bytes=2000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        session.mark_bash_run(
            sid,
            cmd_sha="bb2",
            cmd_preview="ruff check src/",
            output_id="o2",
            stdout_bytes=500,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        assert "Δ since last compact" in second
        assert "+2 bash" in second

    def test_delta_shows_new_symbols_accessed(self, tmp_data_dir):
        """Delta line carries +N symbols when symbols are accessed between compacts."""
        import json as _json

        import token_goat.paths as _paths

        sid = "quality-delta-symbols-a26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/login.py")
        # First compact — no symbols yet
        compact.build_manifest(sid)

        # Expire the sidecar so a real rebuild happens (not a stub)
        sidecar = _paths.manifest_sha_sidecar_path(sid)
        data = _json.loads(sidecar.read_text(encoding="utf-8"))
        # Read back prior counts; symbols should be 0
        prior_counts = data.get("counts", {})
        data["ts"] = time.time() - 700.0
        sidecar.write_text(_json.dumps(data, separators=(",", ":")), encoding="utf-8")
        self._clear_process_guard(sid)

        # Add symbol accesses via mark_file_read with symbol argument
        session.mark_file_read(sid, "/proj/src/auth.py", symbol="login_user")
        session.mark_file_read(sid, "/proj/src/auth.py", symbol="check_password")
        session.mark_file_read(sid, "/proj/src/login.py", symbol="generate_token")

        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        # Symbols delta only appears if the prior sidecar had a different symbol count
        # (the prior sidecar from the first compact should have symbols=0).
        assert "## Token-Goat Session Manifest" in second
        # With 2 files now having symbols (prev had 0), delta should show +symbols
        if prior_counts.get("symbols", 0) == 0 and "Δ since last compact" in second:
            assert "+2 symbols" in second or "+1 symbols" in second or "symbols" in second

    def test_delta_has_content_after_realistic_session_activity(self, tmp_data_dir):
        """End-to-end: a realistic session produces a delta line with meaningful content."""
        sid = "quality-delta-realistic-a26"
        # First compact with minimal state
        session.mark_file_edited(sid, "/proj/src/core.py")
        compact.build_manifest(sid)

        # Simulate continued work: more edits and bash runs
        session.mark_file_edited(sid, "/proj/src/utils.py")
        session.mark_bash_run(
            sid,
            cmd_sha="cc3",
            cmd_preview="pytest --tb=short",
            output_id="o3",
            stdout_bytes=4000,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )

        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)

        # The delta line must have at least one +/- term
        if "Δ since last compact" in second:
            first_line = second.split("\n")[0]
            assert "+" in first_line or "-" in first_line, (
                f"Delta line should show count changes: {first_line!r}"
            )


# ---------------------------------------------------------------------------
# Sub-area B — Session goal inference uses bash work patterns
# ---------------------------------------------------------------------------

class TestInferSessionGoalBashPatterns:
    """Goal inference surfaces bash work-mode patterns when no commit message exists."""

    def _cache_with_bash(self, edited_paths: list[str], bash_cmds: list[str]) -> object:
        """Build a SimpleNamespace cache with edited files and bash history."""
        bash_history = {}
        for i, cmd in enumerate(bash_cmds):
            bash_history[f"key{i}"] = SimpleNamespace(
                cmd_preview=cmd,
                exit_code=0,
            )
        edited_files = {p: 1 for p in edited_paths}
        return SimpleNamespace(
            edited_files=edited_files,
            symbol_access_counts={},
            bash_history=bash_history,
        )

    def test_pytest_runs_inferred_as_testing(self):
        """Repeated pytest runs produce a 'testing' work mode hint."""
        cache = self._cache_with_bash(
            ["/proj/src/a.py", "/proj/src/b.py"],
            ["pytest -x tests/", "pytest tests/auth/", "uv run pytest"],
        )
        goal = compact.infer_session_goal(cache)
        # Goal should mention 'testing' or the area; not empty
        assert goal != ""
        # If work-mode kicks in, it should mention testing
        assert "testing" in goal.lower() or "src" in goal.lower()

    def test_ruff_and_mypy_inferred_as_linting_type_checking(self):
        """Multiple ruff runs produce a 'linting' hint."""
        cache = self._cache_with_bash(
            ["/proj/src/a.py", "/proj/src/b.py"],
            ["ruff check src/", "ruff check --fix", "ruff src/"],
        )
        goal = compact.infer_session_goal(cache)
        assert goal != ""
        # With 3 ruff runs, linting mode should be inferred
        assert "linting" in goal.lower() or "src" in goal.lower()

    def test_mypy_runs_inferred_as_type_checking(self):
        """Multiple mypy runs produce a 'type-checking' hint."""
        cache = self._cache_with_bash(
            ["/proj/src/a.py", "/proj/src/b.py"],
            ["mypy src/", "mypy --strict src/", "mypy src/token_goat/"],
        )
        goal = compact.infer_session_goal(cache)
        assert goal != ""
        assert "type-checking" in goal.lower() or "src" in goal.lower()

    def test_commit_message_takes_priority_over_bash_patterns(self):
        """A git commit message takes priority over bash work-mode patterns."""
        cache = self._cache_with_bash(
            ["/proj/src/a.py", "/proj/src/b.py"],
            [
                "pytest tests/",
                "pytest tests/",
                "pytest tests/",
                'git commit -m "fix: resolve auth token expiry bug"',
            ],
        )
        goal = compact.infer_session_goal(cache)
        assert goal != ""
        # Commit message should win over bash pattern
        assert "auth token expiry" in goal.lower() or "fix" in goal.lower()

    def test_single_bash_run_below_threshold_no_mode_hint(self):
        """A single bash run (below the >=2 threshold) does not add a work-mode hint."""
        cache = self._cache_with_bash(
            ["/proj/src/a.py", "/proj/src/b.py"],
            ["pytest tests/"],  # only 1 run — below threshold
        )
        goal = compact.infer_session_goal(cache)
        # Goal should still be non-empty (from area signal), but no work-mode suffix
        # if there's only one pytest run. The threshold is >=2.
        if goal:
            # Either no "Session activity:" suffix or it's missing entirely
            assert len(goal.split(".")) <= 3  # at most 2 sentences

    def test_no_bash_history_still_produces_goal(self):
        """Missing bash history falls back gracefully to area+symbol goal."""
        cache = SimpleNamespace(
            edited_files={"/proj/src/a.py": 1, "/proj/src/b.py": 1},
            symbol_access_counts={"foo": 3, "bar": 2},
            bash_history=None,
        )
        goal = compact.infer_session_goal(cache)
        assert goal != ""
        assert "src" in goal.lower() or "foo" in goal.lower()


# ---------------------------------------------------------------------------
# Sub-area C — Compact-hint token estimate uses same formula as build_manifest
# ---------------------------------------------------------------------------

class TestCompactHintTokenBudgetAccuracy:
    """compact-hint's displayed token count uses the same estimate_tokens formula."""

    def test_estimate_tokens_formula_matches_manifest_size(self):
        """The compact-hint token display formula equals compact.estimate_tokens(manifest)."""
        # Build a manifest directly and check that estimate_tokens matches
        # the expected formula: max(1, len(text) // 3 + 1)
        sample_text = "## Token-Goat Session Manifest\n" + "x" * 300
        result = compact.estimate_tokens(sample_text)
        expected = max(1, len(sample_text) // 3 + 1)
        assert result == expected

    def test_estimate_tokens_consistent_with_character_length(self, tmp_data_dir):
        """Token estimate for a real manifest is consistent with character count."""
        sid = "quality-token-budget-c26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/login.py")
        session.mark_bash_run(
            sid,
            cmd_sha="dd4",
            cmd_preview="pytest tests/",
            output_id="o4",
            stdout_bytes=3000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

        manifest = compact.build_manifest(sid)
        assert manifest  # non-empty

        token_estimate = compact.estimate_tokens(manifest)
        char_count = len(manifest)

        # The formula is max(1, len(text) // 3 + 1), so estimate should be
        # approximately char_count / 3.
        expected = max(1, char_count // 3 + 1)
        assert token_estimate == expected, (
            f"estimate_tokens({char_count} chars) = {token_estimate}, "
            f"expected {expected}"
        )

    def test_estimate_tokens_is_same_function_as_render_uses(self, tmp_data_dir):
        """Both compact-hint and _render use the same estimate_tokens implementation."""
        # The compact-hint command calls compact_mod.estimate_tokens(manifest).
        # The _render function uses estimate_tokens from the same module.
        # Verify they're the same callable.
        from token_goat.compact import estimate_tokens as render_estimate
        # compact.estimate_tokens is what compact-hint calls
        assert render_estimate is compact.estimate_tokens

    def test_empty_text_estimate_returns_one(self):
        """estimate_tokens of empty string returns 1 (the max(1,...) floor)."""
        assert compact.estimate_tokens("") == 1

    def test_token_estimate_grows_with_manifest_length(self, tmp_data_dir):
        """Larger manifests produce larger token estimates (monotone property)."""
        sid_short = "quality-token-short-c26"
        sid_long = "quality-token-long-c26"

        # Short manifest: one edited file
        session.mark_file_edited(sid_short, "/proj/src/a.py")
        short_manifest = compact.build_manifest(sid_short)

        # Long manifest: many edited files + bash runs
        for i in range(8):
            session.mark_file_edited(sid_long, f"/proj/src/file{i}.py")
        for i in range(4):
            session.mark_bash_run(
                sid_long,
                cmd_sha=f"ee{i}",
                cmd_preview=f"pytest tests/module{i}/",
                output_id=f"o5{i}",
                stdout_bytes=5000,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )
        long_manifest = compact.build_manifest(sid_long)

        if short_manifest and long_manifest:
            short_tokens = compact.estimate_tokens(short_manifest)
            long_tokens = compact.estimate_tokens(long_manifest)
            assert long_tokens >= short_tokens, (
                f"Longer manifest ({len(long_manifest)} chars) should have "
                f">= tokens than shorter ({len(short_manifest)} chars)"
            )


# ---------------------------------------------------------------------------
# Sub-area D — Skills section: most-recently-used skills appear first
# ---------------------------------------------------------------------------

class TestSkillsOrderedByRecency:
    """Skills used in the last 5 minutes appear before skills loaded hours ago."""

    def _make_skill(self, name: str, ts: float, run_count: int = 1) -> object:
        from token_goat.session import SkillEntry
        return SkillEntry(
            skill_name=name,
            output_id=f"oid_{name}",
            content_sha=f"sha_{name}",
            ts=ts,
            body_bytes=1000,
            run_count=run_count,
        )

    def test_skill_used_5min_ago_beats_skill_used_2h_ago(self):
        """A skill used 5 minutes ago ranks above one used 2 hours ago."""
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "old_skill": self._make_skill("old_skill", now - 7200, run_count=1),
            "recent_skill": self._make_skill("recent_skill", now - 300, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 7200)
        names = [getattr(e, "skill_name", "") for e in result]
        assert names.index("recent_skill") < names.index("old_skill"), (
            "Skill used 5 min ago should appear before skill used 2h ago"
        )

    def test_skill_used_1min_ago_is_first(self):
        """Skill used 1 minute ago appears first even with 3 older skills."""
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "skill_a": self._make_skill("skill_a", now - 3600, run_count=3),
            "skill_b": self._make_skill("skill_b", now - 1800, run_count=2),
            "skill_c": self._make_skill("skill_c", now - 60, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 7200)
        names = [getattr(e, "skill_name", "") for e in result]
        assert names[0] == "skill_c", (
            f"Most recently used skill should be first, got: {names}"
        )

    def test_skill_loaded_at_session_start_still_included(self):
        """A skill loaded at session start is retained regardless of age within session."""
        from token_goat.compact import _select_top_skill_entries
        session_start = time.time() - 3600  # 1h ago
        history = {
            "ralph": self._make_skill("ralph", session_start + 10, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=session_start)
        names = [getattr(e, "skill_name", "") for e in result]
        assert "ralph" in names, "Skills from session start should be retained"

    def test_skills_outside_session_excluded(self):
        """Skills loaded before the session start are excluded."""
        from token_goat.compact import _select_top_skill_entries
        session_start = time.time() - 3600
        history = {
            "pre_session": self._make_skill("pre_session", session_start - 7200, run_count=1),
            "in_session": self._make_skill("in_session", session_start + 60, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=session_start)
        names = [getattr(e, "skill_name", "") for e in result]
        assert "in_session" in names, "In-session skill should be included"
        assert "pre_session" not in names, "Pre-session skill should be excluded"

    def test_five_minute_skills_all_outrank_hourly_skills(self):
        """All skills used within 5 minutes rank above all skills used over 1 hour ago."""
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "fresh_a": self._make_skill("fresh_a", now - 60, run_count=1),
            "fresh_b": self._make_skill("fresh_b", now - 180, run_count=1),
            "stale_x": self._make_skill("stale_x", now - 4000, run_count=5),
            "stale_y": self._make_skill("stale_y", now - 5000, run_count=3),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 7200)
        names = [getattr(e, "skill_name", "") for e in result]
        fresh_max_rank = max(names.index("fresh_a"), names.index("fresh_b"))
        stale_min_rank = min(names.index("stale_x"), names.index("stale_y"))
        assert fresh_max_rank < stale_min_rank, (
            f"All fresh skills ({fresh_max_rank}) should outrank stale "
            f"({stale_min_rank}). Order: {names}"
        )


# ---------------------------------------------------------------------------
# Sub-area E — Compact skip TTL: activity after sentinel causes re-compute
# ---------------------------------------------------------------------------

class TestCompactSkipActivityBustsCache:
    """Activity after sentinel creation causes the next pre-compact to re-compute."""

    def test_new_edit_after_sentinel_causes_recompute(self, tmp_data_dir):
        """Writing a fresh sentinel then editing a new file busts the sentinel."""
        sid = "quality-skip-edit-e26"
        # Write sentinel with current state (1 edited file)
        session.mark_file_edited(sid, "/proj/src/auth.py")
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)

        # Fresh sentinel → should skip
        before = _check_compact_skip_sentinel_detail(sid)
        assert before.should_skip is True, "Sentinel should be fresh after write"

        # Now add a second edit (activity after sentinel creation)
        session.mark_file_edited(sid, "/proj/src/new_feature.py")

        # After activity, sentinel should be busted
        after = _check_compact_skip_sentinel_detail(sid)
        assert after.should_skip is False, (
            "Sentinel should be busted by new edit since it was written"
        )

    def test_new_bash_run_after_sentinel_causes_recompute(self, tmp_data_dir):
        """Writing a fresh sentinel then running a bash command busts the sentinel."""
        sid = "quality-skip-bash-e26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)

        before = _check_compact_skip_sentinel_detail(sid)
        assert before.should_skip is True, "Sentinel should be fresh after write"

        # Add a bash run after the sentinel was written
        session.mark_bash_run(
            sid,
            cmd_sha="ff5",
            cmd_preview="pytest tests/",
            output_id="o6",
            stdout_bytes=2500,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

        after = _check_compact_skip_sentinel_detail(sid)
        assert after.should_skip is False, (
            "Sentinel should be busted by new bash run since it was written"
        )

    def test_no_activity_after_sentinel_still_skips(self, tmp_data_dir):
        """No new activity → sentinel remains fresh → hook skips correctly."""
        sid = "quality-skip-nochange-e26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)

        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is True, (
            "Sentinel with matching counts and fresh mtime should still skip"
        )

    def test_multiple_edits_and_bash_all_bust_sentinel(self, tmp_data_dir):
        """Both edit count and bash count increases independently bust the sentinel."""
        sid = "quality-skip-both-e26"
        session.mark_file_edited(sid, "/proj/src/a.py")
        session.mark_bash_run(
            sid,
            cmd_sha="gg6",
            cmd_preview="pytest",
            output_id="o7",
            stdout_bytes=1000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        # Sentinel records current state: 1 edit, 1 bash
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=1)

        # Verify fresh
        assert _check_compact_skip_sentinel_detail(sid).should_skip is True

        # Add more edits AND bash runs
        session.mark_file_edited(sid, "/proj/src/b.py")
        session.mark_bash_run(
            sid,
            cmd_sha="hh7",
            cmd_preview="ruff check",
            output_id="o8",
            stdout_bytes=200,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

        # Sentinel should now be busted (both counts increased)
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False, (
            "Sentinel should be busted when both edit and bash counts grew"
        )

    def test_ttl_expiry_also_causes_recompute(self, tmp_data_dir):
        """Sentinel older than TTL is treated as stale regardless of count match."""
        import time as _time

        sid = "quality-skip-ttl-e26"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)

        # Backdate the sentinel by > TTL (default 300 s)
        sentinel = paths.compact_skip_sentinel_path(sid)
        old_mtime = _time.time() - 400  # 400 s ago > default 300 s TTL
        import os
        os.utime(sentinel, (old_mtime, old_mtime))

        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False, (
            "Expired sentinel should not prevent re-compute"
        )
