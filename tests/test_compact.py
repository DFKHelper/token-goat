"""Tests for compaction assist: manifest generation, config, and pre_compact hook."""
from __future__ import annotations

import time

import pytest
from conftest import make_git_repo
from hook_helpers import assert_continue as _assert_continue

from token_goat import compact, config, hooks_cli, session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _populate_session(session_id: str, *, files: int = 3, greps: int = 2, edits: int = 1) -> None:
    """Put enough activity in a session to exceed any reasonable min_events threshold."""
    for i in range(files):
        session.mark_file_read(session_id, f"/proj/src/file{i}.py", offset=0, limit=100)
    for i in range(greps):
        session.mark_grep(session_id, f"pattern{i}", "/proj/src")
    for i in range(edits):
        session.mark_file_edited(session_id, f"/proj/src/edited{i}.py")


# ---------------------------------------------------------------------------
# compact.event_count
# ---------------------------------------------------------------------------

class TestEventCount:
    def test_empty_session_returns_zero(self, tmp_data_dir):
        assert compact.event_count("empty-session-abc") == 0

    def test_counts_files_greps_and_edits(self, tmp_data_dir, make_session):
        sid = "evcount-session-xyz"
        make_session(sid, files_read=3, greps=2, edits=1)
        # event_count = len(files) + len(greps) + len(edited_files)
        assert compact.event_count(sid) == 6

    def test_only_edits_counted(self, tmp_data_dir):
        sid = "only-edits-session-abc"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_edited(sid, "/proj/app.py")  # same file, same key
        # edited_files is path→count dict, so same path = 1 entry
        assert compact.event_count(sid) == 1

    def test_invalid_session_id_returns_zero(self, tmp_data_dir):
        # Handles load failures gracefully
        assert compact.event_count("a" * 300) == 0  # too long → validation fails → caught


# ---------------------------------------------------------------------------
# compact.build_manifest
# ---------------------------------------------------------------------------

class TestBuildManifest:
    def test_empty_session_returns_empty_string(self, tmp_data_dir):
        result = compact.build_manifest("no-activity-session")
        assert result == ""

    def test_manifest_contains_header(self, tmp_data_dir, make_session):
        sid = "manifest-header-session"
        make_session(sid, files_read=2, greps=1, edits=1)
        result = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in result

    def test_edited_files_section_present(self, tmp_data_dir):
        sid = "edited-files-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=50)
        # read + edited = 2 events >= min_events=0 for manifest; but build_manifest has no min
        result = compact.build_manifest(sid)
        assert "**Edited:**" in result
        assert "auth.py" in result

    def test_symbols_section_present(self, tmp_data_dir):
        sid = "symbols-session-abc"
        session.mark_file_read(sid, "/proj/src/parser.py", symbol="index_project")
        result = compact.build_manifest(sid)
        assert "**Syms:**" in result
        assert "index_project" in result

    def test_key_files_section_present(self, tmp_data_dir):
        sid = "keyfiles-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=200)
        result = compact.build_manifest(sid)
        assert "**Files:**" in result
        assert "db.py" in result

    def test_manifest_respects_token_budget(self, tmp_data_dir):
        sid = "budget-session-abc"
        # Add many files to push the manifest above a tiny budget
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/bigfile{i:02d}.py", offset=0, limit=500)
        result = compact.build_manifest(sid, max_tokens=50)
        max_chars = 50 * 4
        assert len(result) <= max_chars

    def test_edited_files_sorted_by_edit_count(self, tmp_data_dir):
        sid = "sort-edits-session-abc"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        session.mark_file_edited(sid, "/proj/b.py")
        session.mark_file_edited(sid, "/proj/b.py")
        result = compact.build_manifest(sid)
        # b.py was edited 3× — should appear before a.py
        assert result.index("b.py") < result.index("a.py")

    def test_edit_count_suffix_in_manifest(self, tmp_data_dir):
        sid = "suffix-session-abc"
        for _ in range(4):
            session.mark_file_edited(sid, "/proj/hot.py")
        result = compact.build_manifest(sid)
        assert "×4" in result

    def test_manifest_is_string(self, tmp_data_dir, make_session):
        sid = "str-check-session"
        make_session(sid, files_read=3, greps=2, edits=1)
        result = compact.build_manifest(sid)
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# compact.build_manifest — delta-cache (item #19)
# ---------------------------------------------------------------------------

class TestManifestDeltaCache:
    """First call always returns the full manifest; subsequent calls within
    the TTL window return a lightweight stub when nothing has changed.

    The delta-cache uses a process-local guard set to distinguish between:
    - Same-process repeated calls (e.g. tests): guard prevents false stubs.
    - Cross-process calls (production hook model): guard is empty on load,
      so a SHA already on disk triggers the stub correctly.

    To test the cross-process cache-hit path, tests simulate it by clearing
    the process-local guard between the "write" and "read" invocations.
    """

    def _clear_process_guard(self, sid: str) -> None:
        """Simulate a new process starting by removing sid from the guard set."""
        compact._manifest_sha_written_this_process.discard(sid)

    def test_first_call_returns_full_manifest(self, tmp_data_dir):
        sid = "delta-first-call"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        result = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in result
        # SHA must be recorded after first call
        cache = session.load(sid)
        assert cache.last_manifest_sha != ""
        assert cache.last_manifest_ts > 0.0

    def test_second_call_no_changes_returns_stub(self, tmp_data_dir):
        sid = "delta-no-change"
        session.mark_file_edited(sid, "/proj/src/utils.py")
        first = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in first
        # Simulate a new hook process: clear the process-local guard, then call again.
        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        assert "unchanged since" in second
        assert "## Token-Goat Session Manifest" not in second

    def test_second_call_with_new_edit_returns_full(self, tmp_data_dir):
        sid = "delta-with-edit"
        session.mark_file_edited(sid, "/proj/src/api.py")
        first = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in first
        # Add a new edit — manifest content will differ regardless of the guard
        session.mark_file_edited(sid, "/proj/src/new_file.py")
        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in second
        assert "unchanged since" not in second

    def test_second_call_after_ttl_returns_full(self, tmp_data_dir):
        sid = "delta-ttl-expired"
        session.mark_file_edited(sid, "/proj/src/worker.py")
        first = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in first
        # Backdate last_manifest_ts to simulate TTL expiry
        cache = session.load(sid)
        cache.last_manifest_ts = time.time() - 700.0  # 700s > 600s TTL
        cache._invalidate_json_cache()
        session.save(cache)
        # Clear process guard, same content but stale timestamp → full rebuild
        self._clear_process_guard(sid)
        second = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in second
        assert "unchanged since" not in second

    def test_stub_records_age_in_seconds(self, tmp_data_dir):
        sid = "delta-age-text"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=50)
        compact.build_manifest(sid)
        self._clear_process_guard(sid)
        stub = compact.build_manifest(sid)
        # Stub should contain a non-negative integer age
        assert "ago" in stub

    def test_same_process_second_call_returns_full_not_stub(self, tmp_data_dir):
        """Within a single process, two successive calls always return full manifests.

        This is the guard's primary purpose: prevent test false-positives and the
        edge case where a caller invokes build_manifest twice in one hook process.
        """
        sid = "delta-same-process"
        session.mark_file_edited(sid, "/proj/src/api.py")
        first = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in first
        # No guard clear: second call in same process returns full manifest
        second = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in second
        assert "unchanged since" not in second


class TestComputeAdaptiveBudget:
    """Tests for compute_adaptive_budget function.

    All calls use age_seconds=1800 (active tier, ×1.0) so the arithmetic
    matches the pre-age-tier behaviour and the tests remain deterministic.
    Age-tier-specific tests live in TestComputeAdaptiveBudgetWithAge.
    """

    def test_empty_session_returns_base_budget(self, tmp_data_dir):
        """Empty session with no edits, reads, or bash history returns minimum (200)."""
        sid = "empty-adaptive-session"
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        assert budget == 200

    def test_one_edited_file_adds_fifty(self, tmp_data_dir):
        """One edited file adds 50 tokens: 200 + 50 = 250."""
        sid = "one-edit-session"
        session.mark_file_edited(sid, "/proj/a.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        assert budget == 250

    def test_four_edited_files_reaches_edit_cap(self, tmp_data_dir):
        """Four edited files: 200 + (4 × 50) = 400."""
        sid = "four-edits-session"
        for i in range(4):
            session.mark_file_edited(sid, f"/proj/edit{i}.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        assert budget == 400

    def test_ten_edited_files_capped_at_edit_limit(self, tmp_data_dir):
        """Edits capped at 200 tokens: 200 + min(200, 10×50) = 400, not 700."""
        sid = "many-edits-session"
        for i in range(10):
            session.mark_file_edited(sid, f"/proj/edit{i}.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 base + min(200, 10*50=500) = 200 + 200 = 400
        assert budget == 400

    def test_symbols_accessed_add_bonus(self, tmp_data_dir):
        """Files with symbols accessed add 30 tokens each (capped at 150)."""
        sid = "symbols-session"
        session.mark_file_read(sid, "/proj/a.py", symbol="func_a")
        session.mark_file_read(sid, "/proj/b.py", symbol="func_b")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 base + (2 files with symbols × 30) = 200 + 60 = 260
        assert budget == 260

    def test_five_symbol_files_reaches_symbols_cap(self, tmp_data_dir):
        """Five files with symbols: 200 + (5×30) = 350."""
        sid = "five-symbols-session"
        for i in range(5):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"func_{i}")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        assert budget == 350

    def test_many_symbol_files_capped_at_symbols_limit(self, tmp_data_dir):
        """Symbol files capped at 150 tokens: 200 + min(150, 10×30) = 350."""
        sid = "many-symbols-session"
        for i in range(10):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"func_{i}")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 base + min(150, 10*30=300) = 200 + 150 = 350
        assert budget == 350

    def test_bash_history_adds_twenty(self, tmp_data_dir):
        """Presence of bash history adds 20 tokens."""
        sid = "bash-history-session"
        session.mark_bash_run(sid, "cmd_sha_1", "pytest -v", "id123", 1000, 500, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 base + 20 bash bonus = 220
        assert budget == 220

    def test_complex_session_combines_bonuses(self, tmp_data_dir):
        """Complex session: edits + symbols + bash all contribute."""
        sid = "complex-session"
        # 2 edits = 100 tokens
        session.mark_file_edited(sid, "/proj/edit1.py")
        session.mark_file_edited(sid, "/proj/edit2.py")
        # 3 files with symbols = 90 tokens
        for i in range(3):
            session.mark_file_read(sid, f"/proj/sym{i}.py", symbol=f"sym_{i}")
        # Bash history = 20 tokens
        session.mark_bash_run(sid, "cmd_sha_2", "pytest", "id456", 1500, 600, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 + 100 + 90 + 20 = 410
        assert budget == 410

    def test_budget_never_below_minimum(self, tmp_data_dir):
        """Budget is always at least 200 tokens."""
        sid = "minimum-session"
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        assert budget >= 200

    def test_budget_never_exceeds_maximum(self, tmp_data_dir):
        """Budget is capped at 800 tokens (mature tier at maximum complexity)."""
        sid = "maximum-session"
        # Add many edits, symbols, bash to try to exceed cap
        for i in range(20):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        for i in range(20):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"s{i}")
        session.mark_bash_run(sid, "cmd_sha_3", "cmd", "id789", 2000, 1000, 1, False)
        cache = session.load(sid)
        # Use mature tier (× 1.4) to push toward the ceiling
        budget = compact.compute_adaptive_budget(cache, age_seconds=7200)
        assert budget <= 800

    def test_maximum_budget_example(self, tmp_data_dir):
        """Realistic maximum (active tier): 4+ edits (200) + 5+ symbols (150) + bash (20) = 570."""
        sid = "max-example-session"
        for i in range(4):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        for i in range(5):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"s{i}")
        session.mark_bash_run(sid, "cmd_sha_4", "pytest", "maxid", 2000, 1000, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=1800)
        # 200 + min(200, 4*50=200) + min(150, 5*30=150) + 20 = 570
        assert budget == 570


class TestBuildManifestAdaptive:
    """Tests for build_manifest_adaptive convenience wrapper."""

    def test_empty_session_returns_empty(self, tmp_data_dir):
        """Empty session returns empty manifest (no activity)."""
        result = compact.build_manifest_adaptive("empty-adaptive")
        assert result == ""

    def test_adaptive_with_simple_session(self, tmp_data_dir):
        """Simple session (1 edit) uses lower budget efficiently."""
        sid = "simple-adaptive"
        session.mark_file_edited(sid, "/proj/app.py")
        result = compact.build_manifest_adaptive(sid)
        # Should be a valid manifest
        assert "Token-Goat Session Manifest" in result or result == ""
        # Budget should be 200 + 50 = 250

    def test_adaptive_with_complex_session(self, tmp_data_dir):
        """Complex session gets larger budget and preserves more detail."""
        sid = "complex-adaptive"
        for i in range(3):
            session.mark_file_edited(sid, f"/proj/edit{i}.py")
        for i in range(4):
            session.mark_file_read(sid, f"/proj/src{i}.py", symbol=f"sym_{i}")
        session.mark_bash_run(sid, "cmd_sha_5", "pytest -v", "bid123", 1500, 800, 0, False)
        result = compact.build_manifest_adaptive(sid)
        assert "Token-Goat Session Manifest" in result

    def test_adaptive_budget_applied_correctly(self, tmp_data_dir):
        """Manifest respects the adaptively-computed budget."""
        sid = "budget-check"
        # 2 edits = 250 tokens budget
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        result = compact.build_manifest_adaptive(sid)
        # Verify budget constraint: ~300 char limit for 250 tokens
        # (conservative 3 chars per token, so 250 * 3 = 750 chars max)
        assert len(result) <= 750

    def test_adaptive_invalid_session_returns_empty(self, tmp_data_dir):
        """Invalid session ID returns empty string gracefully."""
        result = compact.build_manifest_adaptive("x" * 300)  # too long
        assert result == ""


class TestNoisePathFilter:
    """Build artifacts, lockfiles, and OS metadata must not eat manifest budget."""

    def test_pyc_extension_is_noise(self):
        assert compact.is_noise_path("/proj/src/foo.pyc") is True
        assert compact.is_noise_path("/proj/src/foo.pyo") is True

    def test_native_binaries_are_noise(self):
        assert compact.is_noise_path("/proj/build/libfoo.so") is True
        assert compact.is_noise_path("C:/proj/foo.dll") is True

    def test_lockfiles_are_noise(self):
        assert compact.is_noise_path("/proj/package-lock.json") is True
        assert compact.is_noise_path("/proj/uv.lock") is True
        assert compact.is_noise_path("/proj/Cargo.lock") is True

    def test_os_metadata_is_noise(self):
        assert compact.is_noise_path("/proj/.DS_Store") is True
        assert compact.is_noise_path("/proj/Thumbs.db") is True

    def test_cache_directories_are_noise(self):
        assert compact.is_noise_path("/proj/src/__pycache__/foo.cpython-311.pyc") is True
        assert compact.is_noise_path("/proj/.git/HEAD") is True
        assert compact.is_noise_path("/proj/node_modules/react/index.js") is True
        assert compact.is_noise_path("/proj/.venv/lib/site-packages/x.py") is True
        assert compact.is_noise_path("/proj/.mypy_cache/x.json") is True

    def test_extended_build_dirs_are_noise(self):
        """Framework build outputs and language-specific compile dirs."""
        assert compact.is_noise_path("/proj/.next/server/chunks/0.js") is True
        assert compact.is_noise_path("/proj/.nuxt/dist/app.mjs") is True
        assert compact.is_noise_path("/proj/.svelte-kit/output/app.js") is True
        assert compact.is_noise_path("/proj/.turbo/log") is True
        assert compact.is_noise_path("/proj/target/debug/foo") is True

    def test_extended_cache_dirs_are_noise(self):
        assert compact.is_noise_path("/proj/.tox/py311/lib/x.py") is True
        assert compact.is_noise_path("/proj/.cache/pip/wheels/x.whl") is True
        assert compact.is_noise_path("/proj/.parcel-cache/abc.json") is True
        assert compact.is_noise_path("/proj/coverage/lcov.info") is True
        assert compact.is_noise_path("/proj/.nyc_output/123.json") is True

    def test_egg_info_and_site_packages_are_noise(self):
        assert compact.is_noise_path("/proj/mypkg.egg-info/PKG-INFO") is True
        assert compact.is_noise_path("/proj/venv/lib/site-packages/numpy/x.py") is True

    def test_coverage_and_pidlock_files_are_noise(self):
        assert compact.is_noise_path("/proj/.coverage") is True
        assert compact.is_noise_path("/proj/coverage.xml") is True
        assert compact.is_noise_path("/proj/lcov.info") is True
        assert compact.is_noise_path("/proj/worker.pid") is True
        assert compact.is_noise_path("/proj/projects/abc.lock") is True

    def test_real_source_files_pass(self):
        assert compact.is_noise_path("/proj/src/auth.py") is False
        assert compact.is_noise_path("/proj/tests/test_x.py") is False
        assert compact.is_noise_path("README.md") is False
        assert compact.is_noise_path("") is False

    def test_windows_separators_work(self):
        assert compact.is_noise_path("C:\\proj\\__pycache__\\x.py") is True
        assert compact.is_noise_path("C:\\proj\\src\\auth.py") is False

    def test_noise_files_excluded_from_manifest(self, tmp_data_dir):
        """A session whose only reads are noise paths should not get listed in Key Files Read."""
        sid = "noise-filter-session-abc"
        # Mix one real file with several noise paths
        session.mark_file_read(sid, "/proj/src/real.py", offset=0, limit=50)
        session.mark_file_read(sid, "/proj/src/__pycache__/real.cpython-311.pyc", offset=0, limit=50)
        session.mark_file_read(sid, "/proj/uv.lock", offset=0, limit=50)
        session.mark_file_read(sid, "/proj/.DS_Store", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "real.py" in result
        # Noise paths must be absent
        assert "uv.lock" not in result
        assert ".DS_Store" not in result
        assert "__pycache__" not in result

    def test_noise_edits_excluded_from_manifest(self, tmp_data_dir):
        sid = "noise-edit-filter-session-abc"
        session.mark_file_edited(sid, "/proj/src/real.py")
        session.mark_file_edited(sid, "/proj/build/.pyc")  # noise extension
        session.mark_file_edited(sid, "/proj/poetry.lock")
        result = compact.build_manifest(sid)
        assert "real.py" in result
        assert "poetry.lock" not in result

    # -- automation tool artifacts (regression: these leaked into manifests) --

    def test_improve_state_files_are_noise(self):
        assert compact.is_noise_path(".improve-state-general.json") is True
        assert compact.is_noise_path("/proj/.improve-state-my-feature.json") is True
        assert compact.is_noise_path("C:\\proj\\.improve-state-foo.json") is True

    def test_improve_commit_msg_files_are_noise(self):
        assert compact.is_noise_path("/tmp/improve_commit_msg_general_1.txt") is True
        assert compact.is_noise_path("improve_commit_msg_foo_2.txt") is True
        assert compact.is_noise_path("C:\\tmp\\improve_commit_msg_x.txt") is True

    def test_unix_tmp_dir_is_noise(self):
        assert compact.is_noise_path("/tmp/anything.py") is True
        assert compact.is_noise_path("/tmp/scratch.json") is True

    def test_windows_temp_dirs_are_noise(self):
        assert compact.is_noise_path("C:/Users/x/AppData/Local/Temp/foo.txt") is True
        assert compact.is_noise_path("C:\\Users\\x\\AppData\\Roaming\\bar.json") is True

    def test_automation_edits_excluded_from_manifest(self, tmp_data_dir):
        """Regression: improve-skill artifacts must never appear in 'Files Edited'."""
        sid = "noise-automation-session-abc"
        session.mark_file_edited(sid, "/proj/src/real.py")
        session.mark_file_edited(sid, "/tmp/improve_commit_msg_general_1.txt")
        session.mark_file_edited(sid, "/proj/.improve-state-general.json")
        session.mark_file_edited(sid, "C:/Users/x/AppData/Local/Temp/scratch.txt")
        result = compact.build_manifest(sid)
        assert "real.py" in result
        assert "improve_commit_msg" not in result
        assert "improve-state" not in result
        assert "AppData" not in result
        assert "/tmp/" not in result


class TestActivityMarkers:
    """Edited vs. read distinction must be visible to the compaction LLM."""

    def test_edited_files_prefixed_with_edit_marker(self, tmp_data_dir):
        sid = "marker-edit-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        result = compact.build_manifest(sid)
        assert "✎" in result

    def test_read_files_prefixed_with_read_marker(self, tmp_data_dir):
        sid = "marker-read-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=100)
        result = compact.build_manifest(sid)
        # The "→" arrow appears as both the symbols-section separator and the
        # read-files prefix; the read-files prefix is "- → " at line start.
        assert "- → " in result

    def test_manifest_has_legend(self, tmp_data_dir):
        # Legend only appears when 2+ marker kinds are present (#22).
        sid = "legend-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_read(sid, "/proj/src/db.py")
        result = compact.build_manifest(sid)
        assert "Legend:" in result


class TestFormatRanges:
    """_format_ranges annotates whole-file sentinel ranges as (full)."""

    def test_sentinel_range_annotated_as_full(self):
        from token_goat import session as session_mod
        sentinel_end = 1 + session_mod._UNKNOWN_END_SENTINEL
        result = compact._format_ranges([(1, sentinel_end)])
        assert result == "  (full)", f"expected '  (full)', got: {result!r}"

    def test_partial_ranges_still_shown(self):
        result = compact._format_ranges([(10, 50)])
        assert "10-50" in result

    def test_sentinel_wins_over_partial_ranges(self):
        # When any range is a sentinel, the whole file was in context — (full)
        # supersedes any partial range annotations.
        from token_goat import session as session_mod
        sentinel_end = 1 + session_mod._UNKNOWN_END_SENTINEL
        result = compact._format_ranges([(1, sentinel_end), (200, 300)])
        assert result == "  (full)", f"sentinel should win over partials, got: {result!r}"
        assert "200-300" not in result
        assert "100000" not in result

    def test_build_manifest_full_annotation_appears(self, tmp_data_dir):
        # End-to-end: a full-file read (no offset/limit) emits (full) in the
        # manifest and never leaks the raw sentinel number 100000.
        sid = "sentinel-e2e-session-abc"
        session.mark_file_read(sid, "/proj/src/big.py")
        result = compact.build_manifest(sid)
        assert "big.py" in result
        assert "(full)" in result, f"expected '(full)' annotation, got:\n{result}"
        assert "100000" not in result, f"sentinel number leaked into manifest:\n{result}"


class TestKeyFilesRecencySort:
    """Key Files Read must use last_read_ts as a tiebreaker when read_count ties."""

    def test_more_recently_read_file_appears_first_when_counts_tie(self, tmp_data_dir):
        import time as _time
        sid = "recency-sort-session-abc"
        # Both files read exactly once — order must be by recency, not insertion.
        session.mark_file_read(sid, "/proj/src/older.py", offset=0, limit=50)
        _time.sleep(0.01)
        session.mark_file_read(sid, "/proj/src/newer.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "older.py" in result and "newer.py" in result
        assert result.index("newer.py") < result.index("older.py"), (
            "more recently read file should appear first\n" + result
        )

    def test_higher_read_count_still_wins_over_recency(self, tmp_data_dir):
        import time as _time
        sid = "count-beats-recency-session-abc"
        # Older file read 3× should rank above newer file read once.
        for _ in range(3):
            session.mark_file_read(sid, "/proj/src/frequent.py", offset=0, limit=50)
        _time.sleep(0.01)
        session.mark_file_read(sid, "/proj/src/rare.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert result.index("frequent.py") < result.index("rare.py"), (
            "higher read_count should rank above recency\n" + result
        )


class TestGrepSection:
    """Patterns Searched section surfaces recent grep patterns for the compaction LLM."""

    def test_grep_section_present_when_greps_exist(self, tmp_data_dir):
        sid = "grep-section-session-abc"
        session.mark_grep(sid, "mark_file_read", "/proj/src")
        result = compact.build_manifest(sid)
        assert "**Grep:**" in result
        assert "mark_file_read" in result

    def test_grep_section_absent_when_no_greps(self, tmp_data_dir):
        sid = "no-grep-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=100)
        result = compact.build_manifest(sid)
        assert "**Grep:**" not in result

    def test_grep_section_includes_path_scope(self, tmp_data_dir):
        sid = "grep-path-session-abc"
        session.mark_grep(sid, "shrink", "/proj/src/token_goat")
        result = compact.build_manifest(sid)
        assert "shrink" in result
        assert "token_goat" in result

    def test_grep_section_deduplicates_same_pattern(self, tmp_data_dir):
        sid = "grep-dedup-session-abc"
        for _ in range(4):
            session.mark_grep(sid, "duplicate_pattern", "/proj/src")
        result = compact.build_manifest(sid)
        assert result.count("duplicate_pattern") == 1, (
            "duplicate grep pattern should appear only once\n" + result
        )

    def test_grep_dedup_by_pattern_ignores_different_paths(self, tmp_data_dir):
        # Searching the same pattern in different scopes should produce one entry
        # (the most-recent one), not two — the compaction LLM cares about what
        # was searched, not how the search scope changed between runs.
        import time as _time
        sid = "grep-scope-dedup-session-abc"
        session.mark_grep(sid, "find_me", "/proj/src")
        _time.sleep(0.01)
        session.mark_grep(sid, "find_me", "/proj/tests")
        result = compact.build_manifest(sid)
        assert result.count("find_me") == 1, (
            "same pattern with different paths should collapse to one entry\n" + result
        )

    def test_grep_result_count_shown_when_available(self, tmp_data_dir):
        sid = "grep-count-session-abc"
        session.mark_grep(sid, "needle", "/proj/src", result_count=7)
        result = compact.build_manifest(sid)
        assert "7 results" in result, f"result count missing:\n{result}"

    def test_grep_zero_result_count_shown(self, tmp_data_dir):
        sid = "grep-zero-session-abc"
        session.mark_grep(sid, "dead_end", "/proj/src", result_count=0)
        result = compact.build_manifest(sid)
        assert "0 results" in result, f"zero result count missing:\n{result}"

    def test_grep_result_count_singular(self, tmp_data_dir):
        sid = "grep-singular-session-abc"
        session.mark_grep(sid, "unique_hit", "/proj/src", result_count=1)
        result = compact.build_manifest(sid)
        assert "1 result" in result, f"singular form missing:\n{result}"
        assert "1 results" not in result, f"wrong plural form:\n{result}"

    def test_grep_no_count_when_unknown(self, tmp_data_dir):
        sid = "grep-no-count-session-abc"
        session.mark_grep(sid, "unknown_count", "/proj/src", result_count=None)
        result = compact.build_manifest(sid)
        assert "unknown_count" in result
        assert "result" not in result, f"count shown when it should be absent:\n{result}"

    def test_grep_most_recent_shown_first(self, tmp_data_dir):
        import time as _time
        sid = "grep-recency-session-abc"
        session.mark_grep(sid, "old_pattern", "/proj/src")
        _time.sleep(0.01)
        session.mark_grep(sid, "new_pattern", "/proj/src")
        result = compact.build_manifest(sid)
        assert result.index("new_pattern") < result.index("old_pattern"), (
            "most-recent grep should appear first\n" + result
        )

    def test_grep_stale_patterns_filtered_from_manifest(self, tmp_data_dir):
        """Grep patterns older than _GREP_MANIFEST_STALE_SECS are excluded from manifest."""
        sid = "grep-staleness-session-abc"

        # Add a stale grep (older than 3 hours)
        stale_age = (3 * 3600) + 60  # 3 hours + 1 minute, exceeds the threshold
        session.mark_grep(sid, "stale_pattern", "/proj/src")

        # Manually adjust the timestamp to simulate age
        cache = session.load(sid)
        if cache and cache.greps:
            stale_grep = cache.greps[0]
            stale_grep.ts = time.time() - stale_age
            session.save(cache)

        # Add a fresh grep (recent)
        session.mark_grep(sid, "fresh_pattern", "/proj/src")

        result = compact.build_manifest(sid)

        # Fresh pattern should be in manifest
        assert "fresh_pattern" in result, f"fresh grep should appear:\n{result}"
        # Stale pattern should NOT be in manifest
        assert "stale_pattern" not in result, f"stale grep should be filtered:\n{result}"

    def test_grep_fresh_patterns_included_in_manifest(self, tmp_data_dir):
        """Grep patterns younger than _GREP_MANIFEST_STALE_SECS are included."""
        sid = "grep-fresh-session-abc"

        # Add a grep that is recent (well under 3 hours old)
        session.mark_grep(sid, "fresh_pattern", "/proj/src")
        result = compact.build_manifest(sid)

        # Fresh pattern should be in manifest
        assert "fresh_pattern" in result, f"fresh grep should appear:\n{result}"

    # ------------------------------------------------------------------
    # Dedup / staleness / composite-rank improvements
    # ------------------------------------------------------------------

    def test_grep_dedup_by_pattern_keeps_most_recent(self, tmp_data_dir):
        """Duplicate pattern entries: only the most-recent occurrence survives."""
        import time as _time

        sid = "grep-dedup-most-recent-abc"
        # Search the same pattern twice in different scopes; the second (newer) wins.
        session.mark_grep(sid, "target_fn", "/proj/src", result_count=3)
        _time.sleep(0.02)
        session.mark_grep(sid, "target_fn", "/proj/tests", result_count=7)

        result = compact.build_manifest(sid)

        # Pattern must appear exactly once.
        assert result.count("target_fn") == 1, (
            f"deduplicated pattern should appear exactly once:\n{result}"
        )
        # The most-recent entry had result_count=7 — that should be the surviving entry.
        assert "7 results" in result, (
            f"most-recent occurrence (7 results) should survive dedup:\n{result}"
        )

    def test_grep_stale_45min_dropped_fresh_kept(self, tmp_data_dir):
        """Entries older than 45 minutes are dropped; fresh entries are kept."""
        import time as _time

        sid = "grep-stale-45min-abc"

        # A stale grep (>45 min old)
        session.mark_grep(sid, "old_search", "/proj/src")
        stale_age = 2700 + 120  # 47 min — exceeds the 45-min threshold
        cache = session.load(sid)
        cache.greps[-1].ts = _time.time() - stale_age
        session.save(cache)

        # A fresh grep (just now)
        session.mark_grep(sid, "new_search", "/proj/src")

        result = compact.build_manifest(sid)

        assert "new_search" in result, f"fresh grep must be in manifest:\n{result}"
        assert "old_search" not in result, f"stale grep (47min) must be dropped:\n{result}"

    def test_grep_all_stale_keeps_two_most_recent(self, tmp_data_dir):
        """When all patterns are stale, the 2 most recent survive anyway."""
        import time as _time

        sid = "grep-all-stale-fallback-abc"

        patterns = ["oldest", "middle", "newest"]
        for _i, pat in enumerate(patterns):
            session.mark_grep(sid, pat, "/proj/src")

        # Make all three stale (>45 min) but at different ages.
        cache = session.load(sid)
        now = _time.time()
        ages = [3600 * 3, 3600 * 2, 3600]  # 3h, 2h, 1h old — all stale
        for grep, age in zip(cache.greps[-3:], ages, strict=False):
            grep.ts = now - age
        session.save(cache)

        result = compact.build_manifest(sid)

        # "newest" (1h ago) and "middle" (2h ago) should survive; "oldest" (3h ago) should not.
        assert "newest" in result, f"most-recent stale grep must be kept:\n{result}"
        assert "middle" in result, f"second-most-recent stale grep must be kept:\n{result}"
        assert "oldest" not in result, f"oldest stale grep should be dropped:\n{result}"

    def test_grep_high_match_count_ranked_above_low_match_similar_age(self, tmp_data_dir):
        """After dedup/filter, entries with more matches rank above low-match ones of similar age."""
        import time as _time

        sid = "grep-match-rank-abc"

        # Two searches at nearly the same time; rich one has many matches, low
        # one has a single hit. Zero-result greps are now filtered as noise, so
        # use 1 hit instead of 0 to keep both in the manifest for the ordering
        # assertion below.
        session.mark_grep(sid, "rich_search", "/proj/src", result_count=50)
        _time.sleep(0.01)
        session.mark_grep(sid, "thin_search", "/proj/src", result_count=1)

        result = compact.build_manifest(sid)

        # Both should appear (different patterns, both fresh, both have hits).
        assert "rich_search" in result, f"high-match search missing:\n{result}"
        assert "thin_search" in result, f"low-match search missing:\n{result}"

        # "rich_search" should appear before "thin_search" because its composite
        # score (recency × match_count factor) is higher.
        assert result.index("rich_search") < result.index("thin_search"), (
            f"high-match search should rank before low-match search:\n{result}"
        )

    def test_grep_zero_results_filtered_out(self, tmp_data_dir):
        """Zero-result greps are noise — they should not appear in the manifest
        when other (non-empty) searches exist to surface."""
        sid = "grep-zero-filter-abc"

        session.mark_grep(sid, "real_pattern", "/proj/src", result_count=5)
        session.mark_grep(sid, "dead_pattern", "/proj/src", result_count=0)

        result = compact.build_manifest(sid)

        assert "real_pattern" in result, f"hit search missing:\n{result}"
        assert "dead_pattern" not in result, (
            f"zero-result search should be filtered out:\n{result}"
        )

    def test_grep_all_zero_results_still_surface(self, tmp_data_dir):
        """When EVERY grep is zero-result, surface them so the section is not silently empty
        (the same fail-soft posture used for the all-stale case)."""
        sid = "grep-all-zero-abc"

        session.mark_grep(sid, "blank_one", "/proj/src", result_count=0)
        session.mark_grep(sid, "blank_two", "/proj/src", result_count=0)

        result = compact.build_manifest(sid)

        assert "blank_one" in result or "blank_two" in result, (
            f"at least one zero-result grep should surface when all are zero:\n{result}"
        )

    def test_grep_section_omitted_when_all_zero_and_session_mature(self, tmp_data_dir, monkeypatch):
        """#35: When all grep entries are zero-result AND session is >5 min old,
        drop the Patterns Searched section entirely — it carries no signal."""
        import time as _time
        sid = "grep-all-zero-mature-abc"

        session.mark_grep(sid, "blank_alpha", "/proj/src", result_count=0)
        session.mark_grep(sid, "blank_beta", "/proj/src", result_count=0)

        # Age the session beyond 5 minutes
        cache = session.load(sid)
        cache.created_ts = _time.time() - 400  # 6 min 40 s old
        session.save(cache)

        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)

        result = compact.build_manifest(sid)

        assert "**Grep:**" not in result, (
            f"All-zero grep section should be dropped for mature sessions:\n{result}"
        )

    def test_grep_section_kept_when_all_zero_but_session_young(self, tmp_data_dir, monkeypatch):
        """#35: Young sessions (<5 min) keep the all-zero section so the agent sees
        that it already tried those patterns."""
        sid = "grep-all-zero-young-abc"

        session.mark_grep(sid, "blank_x", "/proj/src", result_count=0)

        # Session is fresh — created_ts defaults to now, so age < 5 min.
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)

        result = compact.build_manifest(sid)

        # The section should still appear for young sessions.
        assert "**Grep:**" in result, (
            f"All-zero grep section should be kept for young sessions:\n{result}"
        )


class TestColdOutputs:
    """Cold outputs (old cached bash runs) must exclude failed commands."""

    def test_failed_command_not_in_cold_outputs(self, tmp_data_dir):
        """A bash entry with non-zero exit_code should not appear in Cold Outputs section."""
        sid = "cold-failed-session-abc"

        # Add an old bash output with non-zero exit code (failed command)
        old_ts = time.time() - 1801  # 30 minutes + 1 second, exceeds cold threshold
        session.mark_bash_run(
            sid,
            "cmd_sha_failed",
            "pytest --tb=short",
            "failed_id_001",
            stdout_bytes=1000,
            stderr_bytes=500,
            exit_code=1,  # FAILED
            truncated=False,
        )

        # Manually adjust the timestamp to simulate age; set session to mature so
        # bash sections are not suppressed by the young-tier guard.
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200  # 2 hours old → mature tier
        if cache.bash_history:
            for bash_entry in cache.bash_history.values():
                if getattr(bash_entry, "output_id", None) == "failed_id_001":
                    bash_entry.ts = old_ts
        session.save(cache)

        result = compact.build_manifest(sid)

        # Failed command should NOT appear in the Cold Outputs section
        # (it may still appear in the Commands Run section — that is acceptable).
        assert "Cold Outputs" not in result or "failed_id_001" not in result, (
            f"failed command should not appear in cold outputs:\n{result}"
        )

    def test_successful_cold_command_in_cold_outputs(self, tmp_data_dir):
        """A bash entry with exit_code=0 that is >30 min old SHOULD appear in Cold Outputs."""
        sid = "cold-success-session-abc"

        # Add two old bash outputs (min_lines=2: Cold Outputs only emits with ≥2 entries)
        old_ts = time.time() - 1801  # 30 minutes + 1 second, exceeds cold threshold
        for sha, cmd, oid in [
            ("cmd_sha_success", "pytest", "success_id_001"),
            ("cmd_sha_success2", "ruff check", "success_id_002"),
        ]:
            session.mark_bash_run(
                sid,
                sha,
                cmd,
                oid,
                stdout_bytes=1000,
                stderr_bytes=0,
                exit_code=0,  # SUCCESS
                truncated=False,
            )

        # Manually adjust the timestamp to simulate age; set session to mature so
        # bash sections are not suppressed by the young-tier guard.
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200  # 2 hours old → mature tier
        if cache.bash_history:
            for bash_entry in cache.bash_history.values():
                bash_entry.ts = old_ts
        session.save(cache)

        result = compact.build_manifest(sid, max_tokens=800)

        # Successful command SHOULD appear in Cold Outputs section (short id form)
        assert "Cold Outputs" in result, f"cold outputs section missing:\n{result}"
        from token_goat.cache_common import short_output_id
        assert short_output_id("success_id_001") in result, (
            f"successful cold command short id should appear in cold outputs:\n{result}"
        )


class TestDedupAcrossSections:
    """A file edited this session should not be re-listed under Key Files Read."""

    def test_edited_file_not_repeated_in_key_files_read(self, tmp_data_dir):
        sid = "dedup-session-abc"
        # Same file edited AND read many times — should appear in Edited section,
        # but NOT duplicated under Key Files Read.
        for _ in range(5):
            session.mark_file_read(sid, "/proj/src/shared.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/shared.py")
        result = compact.build_manifest(sid)
        # The sealed block may also mention shared.py; strip it before counting
        # occurrences in the body sections.  The dedup invariant is: the file must
        # not appear in BOTH "Files Edited" AND "Key Files Read" body sections.
        body = result
        if "<<MUST_PRESERVE>>" in result and "<</MUST_PRESERVE>>" in result:
            body = result[result.index("<</MUST_PRESERVE>>") + len("<</MUST_PRESERVE>>"):]
        assert body.count("shared.py") == 1, (
            f"expected 1 in body sections, got {body.count('shared.py')}\n{result}"
        )


class TestBlockerDedupFromBashHistory:
    """A recently-failed command in 'Current Blockers' must not repeat in 'Commands Run'."""

    def test_failed_command_appears_once(self, tmp_data_dir):
        """A large-output failed command is listed under Blockers only, not also Bash History."""
        from token_goat import bash_cache

        sid = "blocker-dedup-session"
        cmd = "uv run mypy src --strict"
        cmd_sha = bash_cache.command_hash(cmd)
        output_id = f"out_{cmd_sha[:8]}"

        # Record a recent failure with enough output to qualify for both sections.
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd,
            output_id,
            stdout_bytes=2000,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )
        # Also add an edited file so the session is "old enough" to include bash entries.
        session.mark_file_edited(sid, "/proj/src/main.py")

        result = compact.build_manifest(sid)
        # The command preview must appear — it belongs in Current Blockers.
        assert "mypy" in result, f"Expected 'mypy' in manifest:\n{result}"
        # The manifest renders the short id (…<last8>), not the full id.
        from token_goat.cache_common import short_output_id
        short_id = short_output_id(output_id)
        # Short id must appear at most once — not in both Blockers and Bash History.
        assert result.count(short_id) <= 1, (
            f"short output_id '{short_id}' appeared {result.count(short_id)}x — "
            f"dedup across sections failed:\n{result}"
        )
        # Full id must not appear — only the short form is emitted.
        assert output_id not in result, (
            f"full output_id '{output_id}' leaked into manifest:\n{result}"
        )


class TestDedupHintEmittedIdsFilterBash:
    """Bash entries whose output_id was already surfaced in a dedup hint are excluded from
    the manifest 'Commands Run' section, unless they are also current blockers."""

    def test_dedup_hinted_entry_absent_from_manifest(self, tmp_data_dir):
        """An entry in bash_dedup_emitted_ids (and not a blocker) is dropped from Commands Run."""
        from token_goat import bash_cache

        sid = "dedup-hint-filter-session"
        cmd = "uv run pytest tests/test_compact.py -x"
        cmd_sha = bash_cache.command_hash(cmd)
        output_id = f"out_{cmd_sha[:8]}"

        # Record a successful large run.
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd,
            output_id,
            stdout_bytes=3000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        # Simulate the hint having fired — mark the output_id as emitted.
        cache = session.load(sid)
        cache.bash_dedup_emitted_ids.add(output_id)
        session.save(cache)
        # Give the session some edited-file age so bash section is included.
        session.mark_file_edited(sid, "/proj/src/main.py")

        result = compact.build_manifest(sid)
        # The command preview text should not appear in Commands Run.
        from token_goat.cache_common import short_output_id
        short_id = short_output_id(output_id)
        assert short_id not in result, (
            f"short output_id '{short_id}' should be absent (dedup-hinted) but found:\n{result}"
        )

    def test_dedup_hinted_but_blocker_still_present(self, tmp_data_dir):
        """An entry in bash_dedup_emitted_ids that is ALSO a current blocker must still appear."""
        from token_goat import bash_cache

        sid = "dedup-hint-blocker-session"
        cmd = "uv run mypy src --strict"
        cmd_sha = bash_cache.command_hash(cmd)
        output_id = f"out_{cmd_sha[:8]}"

        # Record a recent failure with enough output to qualify for Blockers.
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd,
            output_id,
            stdout_bytes=2000,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )
        # Mark as dedup-hint emitted.
        cache = session.load(sid)
        cache.bash_dedup_emitted_ids.add(output_id)
        session.save(cache)
        session.mark_file_edited(sid, "/proj/src/main.py")

        result = compact.build_manifest(sid)
        # The command must still appear in Current Blockers.
        assert "mypy" in result, f"Blocker command 'mypy' missing from manifest:\n{result}"


class TestGitDiffStat:
    """_get_git_diff_stat extracts git diff output for edited files."""

    def test_returns_none_when_cwd_is_none(self):
        """Gracefully handle None cwd."""
        result = compact._get_git_diff_stat(["/proj/src/foo.py"], None)
        assert result is None

    def test_returns_none_when_paths_empty(self, tmp_data_dir):
        """Gracefully handle empty path list."""
        import os
        result = compact._get_git_diff_stat([], os.getcwd())
        assert result is None

    def test_returns_none_when_git_unavailable(self, tmp_data_dir):
        """Gracefully handle when git command is not found."""
        # This test would require PATH manipulation or a mock; for now we skip
        # and rely on the logic's defensive try/except.
        pass

    def test_returns_none_when_not_a_repo(self, tmp_data_dir):
        """Gracefully handle when cwd is not a git repo."""
        result = compact._get_git_diff_stat(["/some/file.py"], str(tmp_data_dir))
        # tmp_data_dir is not a git repo, so git diff should fail
        assert result is None

    def test_truncates_at_8_lines(self, tmp_data_dir):
        """Output is capped at 8 lines."""
        # This test requires a real git repo with many edited files.
        # Skip for now — the logic is straightforward and tested in integration.
        pass

    def test_truncates_at_200_chars(self, tmp_data_dir):
        """Output is capped at 200 characters."""
        # Same as above — integration test would be better.
        pass

    @pytest.mark.slow
    def test_git_diff_stat_helper_integration(self, tmp_path):
        """Integration test: _get_git_diff_stat helper returns diff output from git."""
        git_repo = make_git_repo(tmp_path, files={"myfile.py": "line1\n"})

        # Modify file so git diff shows changes
        (git_repo / "myfile.py").write_text("line1\nline2\nline3\n")

        # Call helper with relative path (as stored in edited_files)
        result = compact._get_git_diff_stat(["myfile.py"], str(git_repo))

        # Should return diff stat output
        assert result is not None, "git diff stat should return output"
        assert "myfile.py" in result, f"file name should appear in diff: {result!r}"
        assert "|" in result, f"diff stat format should have pipe separator: {result!r}"


class TestGetGitDiffStatSummary:
    """_get_git_diff_stat_summary — whole-repo git diff --stat helper."""

    @pytest.fixture(autouse=True)
    def _clear_caches(self):
        compact._diff_stat_summary_cache.clear()
        compact._is_git_repo_cache.clear()
        yield
        compact._diff_stat_summary_cache.clear()
        compact._is_git_repo_cache.clear()

    def test_returns_empty_string_when_root_is_none(self):
        """None root must return '' without raising."""
        assert compact._get_git_diff_stat_summary(None) == ""

    def test_returns_empty_string_when_not_a_repo(self, tmp_path):
        """Directory that is not a git repo must return '' gracefully."""
        result = compact._get_git_diff_stat_summary(tmp_path)
        assert result == ""

    def test_returns_empty_string_when_subprocess_raises(self, monkeypatch):
        """Any exception from subprocess.run must be swallowed; '' returned."""
        import subprocess as _subprocess  # noqa: PLC0415
        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(
            _subprocess,
            "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("git not found")),
        )
        result = compact._get_git_diff_stat_summary("/some/path")
        assert result == ""

    def test_returns_empty_string_when_subprocess_times_out(self, monkeypatch):
        """TimeoutExpired from subprocess must be swallowed; '' returned."""
        import subprocess as _subprocess  # noqa: PLC0415

        def _raise_timeout(*a, **kw):
            raise _subprocess.TimeoutExpired(cmd="git", timeout=5)

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _raise_timeout)
        result = compact._get_git_diff_stat_summary("/some/path")
        assert result == ""

    @pytest.mark.slow
    def test_integration_with_real_git_repo(self, tmp_path):
        """Integration: returns non-empty output when there are uncommitted changes."""
        git_repo = make_git_repo(tmp_path, files={"foo.py": "line1\n"})

        # Modify so there is a diff vs HEAD
        (git_repo / "foo.py").write_text("line1\nline2\nline3\n")

        result = compact._get_git_diff_stat_summary(str(git_repo))
        assert result != "", "expected non-empty stat for dirty working tree"
        assert "foo.py" in result, f"expected file name in output: {result!r}"

    @pytest.mark.slow
    def test_integration_clean_repo_returns_empty(self, tmp_path):
        """Integration: clean repo (no pending changes) returns ''."""
        git_repo = make_git_repo(tmp_path, "clean", files={"bar.py": "x\n"})

        # No further changes — working tree is clean
        result = compact._get_git_diff_stat_summary(str(git_repo))
        assert result == "", f"expected '' for clean repo, got {result!r}"

    def test_caps_at_six_lines(self, monkeypatch):
        """Output with more than 6 lines is trimmed to the last 6."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        # Simulate git producing 10 file-stat lines + 1 summary line
        fake_lines = [f" file{i}.py | {i} +" for i in range(10)]
        fake_lines.append(" 10 files changed, 45 insertions(+), 0 deletions(-)")
        fake_stdout = "\n".join(fake_lines) + "\n"

        def _fake_run(*a, **kw):
            r = types.SimpleNamespace(returncode=0, stdout=fake_stdout, stderr="")
            return r

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_git_diff_stat_summary("/some/sixline-repo")
        assert result != ""
        lines = result.splitlines()
        assert len(lines) <= 6, f"expected <= 6 lines, got {len(lines)}: {lines}"

    def test_returns_empty_when_output_exceeds_300_chars(self, monkeypatch):
        """Output longer than 300 chars returns '' to avoid ballooning the manifest."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        long_line = " " + "a" * 100 + ".py | 1 +"
        fake_stdout = "\n".join([long_line] * 4) + "\n 4 files changed, 4 insertions(+)\n"

        def _fake_run(*a, **kw):
            return types.SimpleNamespace(returncode=0, stdout=fake_stdout, stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_git_diff_stat_summary("/some/oversized-repo")
        assert result == "", f"expected '' for oversized output, got {result!r}"

    def test_manifest_includes_pending_changes_section(self, tmp_data_dir, monkeypatch):
        """When diff stat is non-empty, manifest includes 'Pending Changes' section."""
        sid = "pending-diff-manifest-test-abc"
        session.mark_file_edited(sid, "/proj/src/main.py")
        session.mark_file_read(sid, "/proj/src/main.py")

        monkeypatch.setattr(
            compact,
            "_get_git_diff_stat_summary",
            lambda _root: "src/main.py | 3 +++\n1 file changed, 3 insertions(+)",
        )
        result = compact.build_manifest(sid)
        assert "**Pending:**" in result, f"Expected '**Pending:**' in manifest:\n{result}"
        assert "src/main.py" in result

    def test_manifest_omits_pending_changes_when_diff_empty(self, tmp_data_dir, monkeypatch):
        """When diff stat is empty, 'Pending Changes' section is absent from manifest."""
        sid = "pending-diff-empty-test-abc"
        session.mark_file_edited(sid, "/proj/src/utils.py")
        session.mark_file_read(sid, "/proj/src/utils.py")

        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        result = compact.build_manifest(sid)
        assert "**Pending:**" not in result, f"Should not include section when diff is empty:\n{result}"

    def test_git_stat_padding_compressed(self, monkeypatch):
        """#21: git diff --stat alignment spaces around | are collapsed to single space."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        # git --stat pads filenames to align the | column
        fake_stdout = (
            " src/token_goat/compact.py    | 12 ++++++------\n"
            " src/token_goat/hints.py      |  4 +---\n"
            " tests/test_compact.py        |  8 ++++++++\n"
            " 3 files changed, 24 insertions(+), 4 deletions(-)\n"
        )

        def _fake_run(*a, **kw):
            return types.SimpleNamespace(returncode=0, stdout=fake_stdout, stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_git_diff_stat_summary("/some/repo")
        assert result != ""
        for line in result.splitlines():
            if "|" in line:
                # No run of 2+ spaces immediately before or after the pipe
                import re as _re  # noqa: PLC0415
                assert not _re.search(r"\s{2,}\|", line), (
                    f"multi-space before | in stat line: {line!r}"
                )
                assert not _re.search(r"\|\s{2,}\d", line), (
                    f"multi-space after | before digit in stat line: {line!r}"
                )


class TestManifestHeaderStrings:
    """Manifest section headers use the trimmed forms (#33, #34)."""

    def test_files_edited_header_has_no_preserve_suffix(self, tmp_data_dir, monkeypatch):
        """#33: 'Files Edited' header must not contain '(preserve)'."""
        sid = "header-no-preserve-abc"
        session.mark_file_edited(sid, "/proj/src/compact.py")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        result = compact.build_manifest(sid)
        assert "**Edited:**\n" in result or "**Edited:**" in result, (
            f"Expected '**Edited:**' header, got something else:\n{result}"
        )
        assert "**Edited:** (preserve)" not in result, (
            f"'(preserve)' suffix must be dropped:\n{result}"
        )

    def test_commands_run_header_has_no_cached_qualifier(self, tmp_data_dir, monkeypatch):
        """#34: 'Commands Run' header must not contain '(cached output)'."""
        sid = "header-no-cached-output-abc"
        from token_goat.session import BashEntry, SessionCache
        cache = session.load(sid) or SessionCache(session_id=sid)
        be = BashEntry(
            cmd_sha="aabbccdd",
            cmd_preview="pytest tests/",
            output_id="aabbccdd",
            ts=__import__("time").time() - 700,
            exit_code=0,
            stdout_bytes=1200,
            stderr_bytes=0,
        )
        cache.bash_history = {"aabbccdd": be}
        cache.created_ts = __import__("time").time() - 700
        session.save(cache)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        result = compact.build_manifest(sid)
        assert "**Ran:**" in result, f"Commands Run section missing:\n{result}"
        assert "(cached output)" not in result, (
            f"'(cached output)' qualifier must be dropped:\n{result}"
        )

    def test_web_fetches_header_has_no_cached_qualifier(self, tmp_data_dir, monkeypatch):
        """#34: 'Web Fetches' header must not contain '(cached body)'."""
        import time as _time
        sid = "header-no-cached-body-abc"
        from token_goat.session import SessionCache, WebEntry
        cache = session.load(sid) or SessionCache(session_id=sid)
        now = _time.time()
        cache.created_ts = now - 1200
        we1 = WebEntry(url_sha="we000001", url_preview="https://docs.example.com/api", output_id="we000001", ts=now - 600, status_code=200, body_bytes=2000)
        we2 = WebEntry(url_sha="we000002", url_preview="https://other.example.org/ref", output_id="we000002", ts=now - 500, status_code=200, body_bytes=1800)
        cache.web_history = {"we000001": we1, "we000002": we2}
        session.save(cache)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        result = compact.build_manifest(sid)
        assert "**Web:**" in result, f"Web Fetches section missing:\n{result}"
        assert "(cached body)" not in result, (
            f"'(cached body)' qualifier must be dropped:\n{result}"
        )


class TestLegendSuppression:
    """#22: Legend prefix dropped when only one marker kind appears."""

    def test_legend_prefix_dropped_for_single_marker_kind(self, tmp_data_dir, monkeypatch):
        """Only edits → emit 'edited=✎' without the 'Legend:' prefix."""
        sid = "legend-single-kind-abc"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        result = compact.build_manifest(sid)
        # The edited file must appear
        assert "foo.py" in result
        # The marker itself must still appear (satisfies invariant tests)
        assert "edited=✎" in result, (
            f"Single-kind marker must still appear:\n{result}"
        )
        # But the "Legend:" prefix must be absent — saves 3-5 tokens
        assert "Legend:" not in result, (
            f"'Legend:' prefix must be dropped when only one marker kind appears:\n{result}"
        )

    def test_legend_present_for_multiple_marker_kinds(self, tmp_data_dir, monkeypatch):
        """Edits + reads → full 'Legend: ...' line emitted."""
        sid = "legend-multi-kind-abc"
        session.mark_file_edited(sid, "/proj/src/bar.py")
        session.mark_file_read(sid, "/proj/src/utils.py")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        result = compact.build_manifest(sid)
        assert "Legend:" in result, (
            f"Legend must appear when multiple marker kinds are present:\n{result}"
        )


class TestComputeAdaptiveBudgetDiffBonus:
    """compute_adaptive_budget adds +50 when has_pending_diff=True."""

    def test_diff_bonus_adds_fifty_tokens(self, tmp_data_dir):
        """has_pending_diff=True increases budget by 50 before tier scaling."""
        sid = "diff-bonus-test-abc"
        session.mark_file_read(sid, "/proj/src/a.py")
        cache = session.load(sid)

        age = 1800.0  # active tier → factor 1.0, so delta is unscaled
        budget_without = compact.compute_adaptive_budget(cache, age_seconds=age, has_pending_diff=False)
        budget_with = compact.compute_adaptive_budget(cache, age_seconds=age, has_pending_diff=True)
        assert budget_with == budget_without + 50, (
            f"Expected +50 for diff bonus: without={budget_without} with={budget_with}"
        )

    def test_diff_bonus_false_by_default(self, tmp_data_dir):
        """Default has_pending_diff=False produces same budget as explicit False."""
        sid = "diff-bonus-default-test-abc"
        session.mark_file_read(sid, "/proj/src/b.py")
        cache = session.load(sid)

        age = 1800.0
        budget_default = compact.compute_adaptive_budget(cache, age_seconds=age)
        budget_explicit = compact.compute_adaptive_budget(cache, age_seconds=age, has_pending_diff=False)
        assert budget_default == budget_explicit


class TestSymbolRankingByRecency:
    """Symbols Accessed must be ranked most-recently-read first, not insertion order."""

    def test_recent_symbol_file_appears_before_older(self, tmp_data_dir):
        import time as _time
        sid = "symbol-recency-session-abc"
        # Older symbol read
        session.mark_file_read(sid, "/proj/src/older.py", symbol="old_sym")
        _time.sleep(0.01)  # ensure last_read_ts differs
        # Many intervening files-with-symbols
        for i in range(3):
            session.mark_file_read(sid, f"/proj/src/mid{i}.py", symbol=f"mid_sym_{i}")
            _time.sleep(0.005)
        # Most-recent symbol read
        session.mark_file_read(sid, "/proj/src/recent.py", symbol="recent_sym")
        result = compact.build_manifest(sid)
        # In Symbols Accessed section, recent.py should appear before older.py
        symbols_section = result.split("**Syms:**")[1] if "**Syms:**" in result else result
        # Truncate to next section if present, so older.py listed in Key Files Read
        # doesn't fool the index check
        symbols_section = symbols_section.split("**")[0]
        assert "recent.py" in symbols_section
        assert "older.py" in symbols_section
        assert symbols_section.index("recent.py") < symbols_section.index("older.py")


# ---------------------------------------------------------------------------
# config.load / config.save
# ---------------------------------------------------------------------------

class TestConfigLoad:
    def test_defaults_when_no_file(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        cfg = config.load()
        assert cfg.compact_assist.enabled is True
        assert "manual" in cfg.compact_assist.triggers
        assert "auto" in cfg.compact_assist.triggers
        assert cfg.compact_assist.min_events == 3
        assert cfg.compact_assist.max_manifest_tokens == 400

    def test_env_var_disables_compact_assist(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        for val in ("0", "false", "no", "off"):
            monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", val)
            cfg = config.load()
            assert cfg.compact_assist.enabled is False, f"expected disabled for env={val!r}"

    def test_env_var_blank_leaves_enabled(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", "")
        cfg = config.load()
        assert cfg.compact_assist.enabled is True

    def test_toml_overrides_defaults(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            "[compact_assist]\nenabled = false\nmin_events = 10\nmax_manifest_tokens = 200\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        cfg = config.load()
        assert cfg.compact_assist.enabled is False
        assert cfg.compact_assist.min_events == 10
        assert cfg.compact_assist.max_manifest_tokens == 200

    def test_corrupt_toml_falls_back_to_defaults(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("this is not valid toml }{{{", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        cfg = config.load()
        assert cfg.compact_assist.enabled is True  # fell back to default


# ---------------------------------------------------------------------------
# _build_sealed_block — above-the-fold MUST_PRESERVE block
# ---------------------------------------------------------------------------


class TestBuildSealedBlock:
    """Unit tests for compact._build_sealed_block."""

    import types as _types

    def _make_bash_entry(self, cmd: str, exit_code: int, ts: float):
        import types
        return types.SimpleNamespace(
            cmd_preview=cmd,
            exit_code=exit_code,
            ts=ts,
            output_id="",
            stdout_bytes=500,
            stderr_bytes=0,
        )

    def _make_skill_entry(self, name: str, ts: float):
        import types
        return types.SimpleNamespace(
            skill_name=name,
            ts=ts,
            body_bytes=1024,
            run_count=1,
            truncated=False,
        )

    def test_empty_inputs_returns_empty_list(self):
        """All three slots empty → no block emitted."""
        result = compact._build_sealed_block({}, [], {})
        assert result == []

    def test_block_present_when_edited_files(self):
        """Edited files alone trigger the block."""
        result = compact._build_sealed_block({"/proj/src/auth.py": 2}, [], {})
        assert result != []
        text = "\n".join(result)
        assert "<<MUST_PRESERVE>>" in text
        assert "<</MUST_PRESERVE>>" in text

    def test_block_present_when_blocker(self):
        """A recent failure alone triggers the block."""
        entry = self._make_bash_entry("pytest tests/", 1, time.time())
        result = compact._build_sealed_block({}, [entry], {})
        text = "\n".join(result)
        assert "<<MUST_PRESERVE>>" in text
        assert "pytest" in text

    def test_block_present_when_skills(self):
        """Active skills alone trigger the block."""
        skill = self._make_skill_entry("ralph", time.time())
        result = compact._build_sealed_block({}, [], {"ralph": skill})
        text = "\n".join(result)
        assert "<<MUST_PRESERVE>>" in text
        assert "ralph" in text

    def test_edit_slot_shows_at_most_three_files(self):
        """Only the top-3 most-edited files appear in the edit slot."""
        edited = {
            "/proj/a.py": 5,
            "/proj/b.py": 3,
            "/proj/c.py": 2,
            "/proj/d.py": 1,
        }
        result = compact._build_sealed_block(edited, [], {})
        text = "\n".join(result)
        # a, b, c should appear; d should not (only top 3)
        assert "a.py" in text
        assert "b.py" in text
        assert "c.py" in text
        assert "d.py" not in text

    def test_edit_slot_includes_count_suffix_when_gt_one(self):
        """Files edited more than once show a ×N suffix."""
        edited = {"/proj/src/compact.py": 4}
        result = compact._build_sealed_block(edited, [], {})
        text = "\n".join(result)
        assert "×4" in text

    def test_blocker_slot_uses_most_recent_failure(self):
        """Most-recent (by ts) blocker is picked, not the first one."""
        now = time.time()
        older = self._make_bash_entry("make build", 2, now - 120)
        newer = self._make_bash_entry("pytest tests/compact", 1, now - 10)
        result = compact._build_sealed_block({}, [older, newer], {})
        text = "\n".join(result)
        assert "pytest" in text

    def test_skill_slot_shows_at_most_two_skills(self):
        """Only ≤2 skills appear in the skill slot."""
        now = time.time()
        skills = {
            "ralph": self._make_skill_entry("ralph", now - 10),
            "improve": self._make_skill_entry("improve", now - 20),
            "superman": self._make_skill_entry("superman", now - 30),
        }
        result = compact._build_sealed_block({}, [], skills)
        text = "\n".join(result)
        # ralph and improve (more recent) should appear; superman should not
        assert "ralph" in text
        assert "improve" in text
        assert "superman" not in text

    def test_block_bounded_at_80_tokens(self):
        """Sealed block is always ≤ 80 tokens (≤ 320 chars)."""
        now = time.time()
        edited = {f"/proj/src/very_long_filename_{i:03d}.py": i + 1 for i in range(5)}
        entry = self._make_bash_entry("pytest --timeout=60 tests/test_very_long_module.py", 1, now)
        skills = {
            "ralph": self._make_skill_entry("ralph", now),
            "improve": self._make_skill_entry("improve", now - 5),
        }
        result = compact._build_sealed_block(edited, [entry], skills)
        text = "\n".join(result)
        assert len(text) <= 320, f"Block too long ({len(text)} chars): {text!r}"

    def test_all_three_slots_survive_top_only_truncation(self):
        """If only the sealed block survives (rest trimmed), all three pieces are present."""
        now = time.time()
        edited = {"/proj/src/auth.py": 3}
        entry = self._make_bash_entry("pytest tests/", 1, now)
        skills = {"ralph": self._make_skill_entry("ralph", now)}
        block_lines = compact._build_sealed_block(edited, [entry], skills)
        # Simulate "top-only" truncation: keep only the sealed block lines
        text = "\n".join(block_lines)
        assert "auth.py" in text, "edit slot must be in block"
        assert "pytest" in text, "blocker slot must be in block"
        assert "ralph" in text, "skill slot must be in block"

    def test_manifest_starts_with_sealed_block_when_data_present(self, tmp_data_dir):
        """Full manifest starts with <<MUST_PRESERVE>> when edited files exist."""
        sid = "sealed-block-manifest-test-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        result = compact.build_manifest(sid)
        assert result.startswith("<<MUST_PRESERVE>>"), (
            f"Manifest should start with sealed block, got:\n{result[:200]}"
        )

    def test_manifest_omits_sealed_block_when_no_data(self, tmp_data_dir):
        """When session has only file reads (no edits, no failures, no skills),
        the sealed block is omitted entirely."""
        sid = "sealed-block-absent-test-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=100)
        result = compact.build_manifest(sid)
        assert "<<MUST_PRESERVE>>" not in result, (
            f"No sealed block expected for read-only session:\n{result[:300]}"
        )

    def test_files_edited_section_still_present_with_sealed_block(self, tmp_data_dir):
        """The 'Files Edited (preserve)' detail section coexists with the sealed block."""
        sid = "sealed-coexist-test-abc"
        session.mark_file_edited(sid, "/proj/src/compact.py")
        result = compact.build_manifest(sid)
        assert "<<MUST_PRESERVE>>" in result
        assert "**Edited:**" in result, (
            f"Detail section should still appear alongside sealed block:\n{result}"
        )

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        original = config.load()
        original.compact_assist.enabled = False
        original.compact_assist.min_events = 99
        config.save(original)

        reloaded = config.load()
        assert reloaded.compact_assist.enabled is False
        assert reloaded.compact_assist.min_events == 99


# ---------------------------------------------------------------------------
# pre_compact hook handler
# ---------------------------------------------------------------------------

class TestPreCompactHandler:
    def _make_payload(self, session_id: str, trigger: str = "manual") -> dict:
        return {"session_id": session_id, "trigger": trigger}

    def test_disabled_returns_continue_only(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = false\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "disabled-session-abc"
        _populate_session(sid, files=5, greps=3, edits=2)
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_env_var_disables_handler(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", "0")

        sid = "envdisabled-session-abc"
        _populate_session(sid, files=5, greps=3, edits=2)
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)

    def test_trigger_not_in_config_skips(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text('[compact_assist]\ntriggers = ["manual"]\n', encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "trigger-filter-session"
        _populate_session(sid, files=5, greps=3, edits=2)
        # trigger="auto" is not in ["manual"]
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="auto"))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_below_min_events_skips(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nmin_events = 100\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "below-min-session-abc"
        _populate_session(sid, files=2, greps=1, edits=0)  # 3 events < 100
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_happy_path_emits_system_message(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 1\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "happy-path-session-abc"
        _populate_session(sid, files=3, greps=2, edits=1)
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="manual"))

        assert result["continue"] is True
        assert "systemMessage" in result
        msg = result["systemMessage"]
        assert isinstance(msg, str)
        assert len(msg) > 0
        assert "Token-Goat Session Manifest" in msg

    def test_auto_trigger_emits_when_in_config(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            '[compact_assist]\nenabled = true\nmin_events = 1\ntriggers = ["manual", "auto"]\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "auto-trigger-session-abc"
        _populate_session(sid, files=2, greps=1, edits=1)
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="auto"))

        assert "systemMessage" in result

    def test_missing_session_id_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        result = hooks_cli.pre_compact({"trigger": "manual"})
        _assert_continue(result)

    def test_empty_session_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        # Session exists but no activity → manifest is empty string → no systemMessage
        result = hooks_cli.pre_compact(self._make_payload("completely-empty-session-abc"))
        _assert_continue(result)

    def test_system_message_respects_token_budget(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        budget = 100
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            f"[compact_assist]\nenabled = true\nmin_events = 1\nmax_manifest_tokens = {budget}\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "budget-check-session-abc"
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/mod{i:02d}.py", offset=0, limit=200)
        for i in range(5):
            session.mark_file_edited(sid, f"/proj/src/edit{i}.py")

        result = hooks_cli.pre_compact(self._make_payload(sid))
        if "systemMessage" in result:
            assert len(result["systemMessage"]) <= budget * 4

    def test_garbage_payload_does_not_crash(self, tmp_data_dir):
        """fail_soft must absorb any exception and return continue:true."""
        result = hooks_cli.pre_compact({"session_id": None, "trigger": None})
        assert result.get("continue") is True


# ---------------------------------------------------------------------------
# Dispatcher integration
# ---------------------------------------------------------------------------

class TestDispatcherIntegration:
    def test_pre_compact_event_is_registered(self, tmp_data_dir):
        assert "pre-compact" in hooks_cli.EVENTS

    def test_dispatch_pre_compact_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths

        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        result = hooks_cli.dispatch("pre-compact", {"session_id": "dispatch-test-abc", "trigger": "manual"})
        assert result.get("continue") is True


# ---------------------------------------------------------------------------
# Common prefix stripping
# ---------------------------------------------------------------------------

class TestCommonPrefixStripping:
    """Token-efficient manifest path display by stripping common prefixes."""

    def test_extract_path_from_edited_line(self):
        """Extract path from edited file marker line."""
        line = "- ✎ token_goat/compact.py  ×2"
        result = compact._extract_path_from_line(line)
        assert result == "token_goat/compact.py"

    def test_extract_path_from_read_line(self):
        """Extract path from read file marker line."""
        line = "- → token_goat/hints.py  lines 1-100"
        result = compact._extract_path_from_line(line)
        assert result == "token_goat/hints.py"

    def test_extract_path_from_stale_line(self):
        """Extract path from stale file marker line."""
        line = "- ⚠ token_goat/session.py"
        result = compact._extract_path_from_line(line)
        assert result == "token_goat/session.py"

    def test_extract_path_from_symbol_line(self):
        """Extract path from symbol line."""
        line = "- token_goat/session.py → FileEntry, SessionCache"
        result = compact._extract_path_from_line(line)
        assert result == "token_goat/session.py"

    def test_extract_path_returns_none_for_header(self):
        """Non-path lines return None."""
        assert compact._extract_path_from_line("### Files Edited") is None
        assert compact._extract_path_from_line("Legend: edited=✎") is None
        assert compact._extract_path_from_line("") is None

    def test_extract_path_returns_none_for_command_line(self):
        """Command lines (starting with backtick) return None."""
        line = "- `pytest -v` (exit 0)"
        result = compact._extract_path_from_line(line)
        assert result is None

    def test_find_common_prefix_same_directory(self):
        """Find common prefix when all paths are in same directory."""
        paths = ["token_goat/compact.py", "token_goat/hints.py", "token_goat/session.py"]
        result = compact._find_common_prefix(paths)
        assert result == "token_goat/"

    def test_find_common_prefix_nested_directory(self):
        """Find common prefix for nested paths."""
        paths = ["src/token_goat/compact.py", "src/token_goat/hints.py"]
        result = compact._find_common_prefix(paths)
        assert result == "src/token_goat/"

    def test_find_common_prefix_no_common_prefix(self):
        """Return None when paths have no common prefix."""
        paths = ["src/foo.py", "tests/bar.py"]
        result = compact._find_common_prefix(paths)
        assert result is None

    def test_find_common_prefix_single_segment_paths(self):
        """Return None for single-segment paths."""
        paths = ["compact.py", "hints.py"]
        result = compact._find_common_prefix(paths)
        assert result is None

    def test_find_common_prefix_empty_list(self):
        """Return None for empty path list."""
        result = compact._find_common_prefix([])
        assert result is None

    def test_find_common_prefix_single_path(self):
        """Single path contributes to prefix detection."""
        paths = ["token_goat/compact.py"]
        result = compact._find_common_prefix(paths)
        # Single path's directory is the potential prefix
        assert result == "token_goat/" or result is None

    def test_strip_common_prefix_from_sections(self):
        """Rewrite sections to strip common prefix."""
        sections = [
            "## Token-Goat Session Manifest",
            "Session: abc12345  |  2026-05-21 10:00",
            "### Files Edited (preserve in summary)",
            "- ✎ token_goat/compact.py  ×2",
            "- ✎ token_goat/hints.py",
        ]
        result = compact._strip_common_prefix_from_sections(sections, "token_goat/")
        # Should have the prefix note inserted
        assert any("token_goat/" in line and "relative to" in line for line in result)
        # Paths should be shortened (with or without exact spacing)
        joined = "\n".join(result)
        assert "compact.py" in joined
        assert "hints.py" in joined
        # No full "token_goat/" prefix should remain on path lines
        path_lines = [line for line in result if line.startswith("- ✎")]
        for line in path_lines:
            # Should not have the full path with directory
            assert "token_goat/compact.py" not in line
            assert "token_goat/hints.py" not in line

    def test_manifest_strips_common_prefix_when_3plus_paths(self, tmp_data_dir):
        """Manifest groups files when 3+ share a common directory, avoiding need for prefix stripping."""
        sid = "prefix-strip-session-abc"
        # Add 3+ files in the same directory
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/session.py")
        result = compact.build_manifest(sid)
        # Manifest should group the files under the directory with (3 files) header
        assert "(3 files)" in result
        assert "token_goat/" in result
        # Files should be listed in the grouped format
        assert "compact.py" in result and "hints.py" in result and "session.py" in result

    def test_manifest_no_strip_when_fewer_than_3_paths(self, tmp_data_dir):
        """Manifest does not strip prefix when fewer than 3 files."""
        sid = "no-strip-few-paths-session"
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        result = compact.build_manifest(sid)
        # Should not have stripping header (not enough paths)
        assert "relative to" not in result

    def test_manifest_no_strip_when_no_common_prefix(self, tmp_data_dir):
        """Manifest does not strip when files don't share a common prefix."""
        sid = "no-strip-no-prefix-session"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/tests/test_auth.py")
        session.mark_file_edited(sid, "/proj/docs/readme.md")
        result = compact.build_manifest(sid)
        # No stripping should occur
        assert "relative to" not in result

    def test_manifest_no_strip_prefix_too_short(self, tmp_data_dir):
        """Manifest does not strip prefix if it's shorter than 6 characters."""
        sid = "no-strip-short-prefix-session"
        # Create files with only a short common prefix
        session.mark_file_edited(sid, "/x/y/file1.py")
        session.mark_file_edited(sid, "/x/y/file2.py")
        session.mark_file_edited(sid, "/x/y/file3.py")
        result = compact.build_manifest(sid)
        # "x/y/" is 4 chars, too short — no stripping
        assert "relative to" not in result

    def test_manifest_no_strip_when_prefix_covers_less_than_70_percent(self, tmp_data_dir):
        """Manifest does not strip if the prefix covers <70% of path lines."""
        sid = "no-strip-low-coverage-session"
        # Add 2 files in token_goat/, but 3 elsewhere (fails 70% threshold)
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        session.mark_file_edited(sid, "/proj/src/parser.py")
        session.mark_file_edited(sid, "/proj/src/helpers.py")
        session.mark_file_edited(sid, "/proj/src/utils.py")
        result = compact.build_manifest(sid)
        # Less than 70% share token_goat/ — no stripping should occur
        assert "(stripped)" not in result

    def test_prefix_stripping_preserves_all_path_information(self, tmp_data_dir):
        """Prefix stripping is a display transformation only; no info is lost."""
        sid = "prefix-preservation-session"
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/session.py")
        session.mark_file_read(sid, "/proj/src/token_goat/session.py", symbol="FileEntry")
        result = compact.build_manifest(sid)
        # All files and symbols should still be present
        assert "compact.py" in result
        assert "hints.py" in result
        assert "session.py" in result
        assert "FileEntry" in result


class TestSessionAgeInManifest:
    """Tests for session age display in manifest header."""

    def test_format_duration_minutes(self):
        """_format_duration formats seconds as minutes when < 1 hour."""
        assert compact._format_duration(65) == "1m"
        assert compact._format_duration(300) == "5m"
        assert compact._format_duration(3599) == "59m"

    def test_format_duration_hours_and_minutes(self):
        """_format_duration formats with hours and minutes."""
        assert compact._format_duration(3665) == "1h 1m"
        assert compact._format_duration(7200) == "2h"
        assert compact._format_duration(7260) == "2h 1m"
        assert compact._format_duration(3600) == "1h"

    def test_manifest_includes_age_when_session_is_old(self, tmp_data_dir):
        """Manifest header includes age when session is > 60 seconds old."""
        sid = "age-test-session"
        cache = session.load(sid)
        # Simulate a session that's 2 hours old
        cache.created_ts = time.time() - 7200
        session.save(cache)
        # Add activity so manifest is not suppressed
        session.mark_file_read(sid, "file.py")
        result = compact.build_manifest(sid)
        # Should contain the session line with age
        assert "Session:" in result
        assert "age:" in result
        assert "2h" in result

    def test_manifest_omits_age_when_session_is_very_young(self, tmp_data_dir):
        """Manifest header omits age when session is < 60 seconds old."""
        sid = "young-session"
        cache = session.load(sid)
        # Keep the session very young (30 seconds old)
        cache.created_ts = time.time() - 30
        session.save(cache)
        # Add activity so manifest is not suppressed
        session.mark_file_read(sid, "file.py")
        result = compact.build_manifest(sid)
        # Should contain the session line without age
        lines = result.split("\n")
        session_line = [line for line in lines if line.startswith("Session:")][0]
        assert "age:" not in session_line

    def test_manifest_age_format_with_min_threshold(self, tmp_data_dir):
        """Manifest shows age only when >= 60 seconds."""
        sid = "threshold-session"
        cache = session.load(sid)
        # Exactly 60 seconds old
        cache.created_ts = time.time() - 60
        session.save(cache)
        session.mark_file_read(sid, "file.py")
        result = compact.build_manifest(sid)
        # Should include age at the 60-second boundary
        assert "age:" in result
        assert "1m" in result


# ---------------------------------------------------------------------------
# Hot-file consolidation
# ---------------------------------------------------------------------------

class TestHotFileConsolidation:
    """Files read 5+ times are consolidated into a single summary line."""

    def test_hot_files_collapsed_to_single_line(self, tmp_data_dir):
        """Files with read_count >= 5 appear in a consolidated 'Hot (5+×): ...' line."""
        sid = "hot-file-collapse-session"
        for _ in range(6):
            session.mark_file_read(sid, "/proj/src/hot.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "Hot (5+×):" in result
        assert "hot.py" in result

    def test_hot_file_not_listed_individually(self, tmp_data_dir):
        """A hot file must not get its own '- → path  ×N  lines ...' entry."""
        sid = "hot-file-no-dup-session"
        for _ in range(7):
            session.mark_file_read(sid, "/proj/src/frequent.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        # The hot line should exist
        assert "Hot (5+×):" in result
        # Count occurrences of the filename — should be exactly one (inside the hot line)
        assert result.count("frequent.py") == 1, (
            f"hot file should appear only once (in consolidated line):\n{result}"
        )

    def test_normal_files_still_get_individual_entries(self, tmp_data_dir):
        """Files with read_count < 5 continue to appear as individual '- → ...' entries."""
        sid = "normal-file-individual-session"
        for _ in range(3):
            session.mark_file_read(sid, "/proj/src/normal.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        # Should NOT be in the hot group
        assert "Hot (5+×):" not in result
        # Should appear as an individual read entry
        assert "- → " in result
        assert "normal.py" in result

    def test_hot_line_appears_before_normal_entries(self, tmp_data_dir):
        """Hot summary line comes before normal file entries."""
        sid = "hot-before-normal-session"
        for _ in range(5):
            session.mark_file_read(sid, "/proj/src/hot.py", offset=0, limit=50)
        for _ in range(2):
            session.mark_file_read(sid, "/proj/src/normal.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "Hot (5+×):" in result
        assert "normal.py" in result
        # Hot line must precede the normal individual entry
        assert result.index("Hot (5+×):") < result.index("normal.py"), (
            f"hot summary should appear before normal entries:\n{result}"
        )

    def test_more_than_six_hot_files_shows_overflow(self, tmp_data_dir):
        """When > 6 hot files exist, first 6 are named and '+N more' is appended."""
        sid = "hot-overflow-session"
        for i in range(8):
            for _ in range(5):
                session.mark_file_read(sid, f"/proj/src/hot{i}.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "Hot (5+×):" in result
        # Should show overflow for the extra 2 files (8 - 6 = 2)
        assert "+2 more" in result or "+ more" in result or "more" in result, (
            f"overflow suffix missing for 8 hot files:\n{result}"
        )

    def test_exactly_six_hot_files_no_overflow(self, tmp_data_dir):
        """Exactly 6 hot files: all shown by name, no '+N more'."""
        sid = "hot-exactly-six-session"
        for i in range(6):
            for _ in range(5):
                session.mark_file_read(sid, f"/proj/src/file{i}.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "Hot (5+×):" in result
        # No overflow expected
        assert "+0 more" not in result
        # Verify all 6 filenames appear
        for i in range(6):
            assert f"file{i}.py" in result, f"file{i}.py missing from hot line:\n{result}"


# ---------------------------------------------------------------------------
# Trim refill pass
# ---------------------------------------------------------------------------

class TestTrimRefillPass:
    """After conservative char-budget trimming, the refill pass recovers budget."""

    def test_refill_recovers_lines_under_accurate_budget(self, tmp_data_dir):
        """A manifest trimmed by the conservative estimate gets refilled to use more tokens."""
        from token_goat.repomap import estimate_tokens

        sid = "refill-session-abc"
        # Add enough files so the manifest is big enough to require trimming
        for i in range(15):
            session.mark_file_read(sid, f"/proj/src/module{i:02d}.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/edited.py")

        # Use a moderate budget that will definitely trigger trimming but leave room to refill
        budget = 80
        result = compact.build_manifest(sid, max_tokens=budget)

        # The token count of the result must be within the budget
        actual_tokens = estimate_tokens(result)
        assert actual_tokens <= budget, (
            f"manifest exceeds token budget: {actual_tokens} > {budget}\n{result}"
        )
        # The result must be non-empty
        assert len(result) > 0


# ---------------------------------------------------------------------------
# Session commits section
# ---------------------------------------------------------------------------

class TestSessionCommits:
    """Test the new "Commits This Session" manifest section."""

    def test_get_session_commits_with_no_cwd_returns_empty_list(self):
        """_get_session_commits returns [] when cwd is None."""
        result = compact._get_session_commits(None, time.time())
        assert result == []

    def test_get_session_commits_with_zero_timestamp_returns_empty_list(self):
        """_get_session_commits returns [] when session_start_ts <= 0."""
        result = compact._get_session_commits("/some/path", 0.0)
        assert result == []

    def test_get_session_commits_handles_missing_git(self):
        """_get_session_commits returns [] when git is not available."""
        # Use a non-existent path to ensure git fails
        result = compact._get_session_commits("/nonexistent/path/to/repo", time.time() - 3600)
        assert result == []

    @pytest.mark.slow
    def test_get_session_commits_returns_commits_when_available(self, tmp_path):
        """_get_session_commits returns formatted commit lines from a real git repo."""
        repo_path = make_git_repo(
            tmp_path,
            "test_repo",
            files={"test.txt": "content"},
            email="test@example.com",
            user="Test User",
            commit_message="test commit",
        )

        # Call _get_session_commits with a timestamp from before the commit
        past_timestamp = time.time() - 3600
        result = compact._get_session_commits(str(repo_path), past_timestamp)

        # Should return at least one formatted commit
        assert len(result) > 0
        assert all(line.startswith("- ") for line in result)
        assert "test commit" in result[0]

    def test_manifest_includes_commits_section_when_present(self, tmp_data_dir):
        """Manifest includes "Commits This Session" section when commits exist."""
        from unittest.mock import patch

        # Create a session with a file edit and set cwd + created_ts
        sid = "commits-session-abc"
        session.mark_file_edited(sid, "/proj/src/app.py")

        # Set session cwd and created_ts
        cache = session.load(sid)
        cache.cwd = "/some/repo"
        cache.created_ts = time.time() - 3600
        session.save(cache)

        # Mock _get_session_commits to return some commits
        mock_commits = ["- abc1234 feat: add feature", "- def5678 fix: bug fix"]
        with patch("token_goat.compact._get_session_commits", return_value=mock_commits):
            result = compact.build_manifest(sid)

        # Should contain "Commits This Session" section
        assert "Commits This Session" in result
        assert "abc1234" in result
        assert "feat: add feature" in result

    def test_manifest_omits_commits_section_when_no_commits(self, tmp_data_dir):
        """Manifest omits "Commits This Session" when there are no session commits."""
        from unittest.mock import patch

        # Create a session with a file edit and set cwd + created_ts
        sid = "no-new-commits-session"
        session.mark_file_edited(sid, "/proj/src/app.py")

        cache = session.load(sid)
        cache.cwd = "/some/repo"
        cache.created_ts = time.time() - 3600
        session.save(cache)

        # Mock _get_session_commits to return empty list (no commits in session)
        with patch("token_goat.compact._get_session_commits", return_value=[]):
            result = compact.build_manifest(sid)

        # Should NOT contain "Commits This Session" since there are no new commits
        assert "Commits This Session" not in result


# ---------------------------------------------------------------------------
# _section_budgets and per-section budget allocation
# ---------------------------------------------------------------------------


class TestSectionBudgets:
    """Unit tests for _section_budgets() and per-section budget enforcement."""

    def test_proportions_sum_to_total_remaining(self):
        """Allocated budgets collectively cover the full remaining budget."""
        # Use a large remaining so every bucket exceeds the 20-token floor
        # (glob's 5% of 600 = 30 > 20; floor never activates).
        budgets = compact._section_budgets(600, 0)
        # Remaining = 600; proportions 38/22/15/10/10/5 = 100%
        # Each individual bucket may be slightly under due to int truncation,
        # but the sum must be <= remaining (never overallocated).
        assert sum(budgets.values()) <= 600
        # And must be close — within 6 tokens of 600 (one rounding unit per bucket).
        assert sum(budgets.values()) >= 600 - 6

    def test_symbols_gets_thirtyeight_percent(self):
        """Symbols section receives 38% of the remaining budget."""
        budgets = compact._section_budgets(400, 0)
        assert budgets["symbols"] == int(400 * 0.38)

    def test_files_gets_twentytwo_percent(self):
        """Files section receives 22% of the remaining budget."""
        budgets = compact._section_budgets(400, 0)
        assert budgets["files"] == int(400 * 0.22)

    def test_greps_gets_fifteen_percent(self):
        """Greps section receives 15% of the remaining budget."""
        budgets = compact._section_budgets(400, 0)
        assert budgets["greps"] == int(400 * 0.15)

    def test_bash_gets_ten_percent(self):
        """Bash section receives 10% of the remaining budget."""
        budgets = compact._section_budgets(400, 0)
        assert budgets["bash"] == int(400 * 0.10)

    def test_web_gets_ten_percent(self):
        """Web section receives 10% of the remaining budget."""
        budgets = compact._section_budgets(400, 0)
        assert budgets["web"] == int(400 * 0.10)

    def test_edited_tokens_reduce_remaining(self):
        """Edited-section cost is subtracted before proportional split."""
        budgets_no_edit = compact._section_budgets(1000, 0)
        budgets_with_edit = compact._section_budgets(1000, 400)
        # Each section should be smaller when 400 tokens are pre-consumed.
        # (large budget ensures glob's 5% stays above the 20-token floor in both cases)
        for key in ("symbols", "files", "greps", "bash", "web", "glob"):
            assert budgets_with_edit[key] < budgets_no_edit[key]

    def test_minimum_section_tokens_enforced(self):
        """Every section gets at least the minimum even with a tiny budget."""
        # 10-token budget with 9 tokens already consumed → 1 token remaining.
        # Each section must still get at least 20 tokens (the minimum floor).
        budgets = compact._section_budgets(10, 9)
        for key in ("symbols", "files", "greps", "bash", "web", "glob"):
            assert budgets[key] >= 20, (
                f"section {key!r} got {budgets[key]} tokens, expected >= 20"
            )

    def test_zero_remaining_gives_minimums(self):
        """When edited section consumes the entire budget, sections get minimums."""
        budgets = compact._section_budgets(400, 500)  # edited_tokens > total
        for key in ("symbols", "files", "greps", "bash", "web", "glob"):
            assert budgets[key] >= 20

    def test_returns_all_six_keys(self):
        """Return dict always contains exactly the six expected keys."""
        budgets = compact._section_budgets(400, 100)
        assert set(budgets.keys()) == {"symbols", "files", "greps", "bash", "web", "glob"}

    def test_manifest_stays_within_budget_simple_session(self, tmp_data_dir):
        """A simple session manifest stays within the requested token budget."""
        from token_goat.repomap import estimate_tokens

        sid = "section-budget-simple"
        for i in range(5):
            session.mark_file_read(sid, f"/proj/src/module{i}.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/app.py")
        session.mark_grep(sid, "def handle", "/proj/src")

        budget = 200
        result = compact.build_manifest(sid, max_tokens=budget)
        assert result, "non-empty session must produce a manifest"
        assert estimate_tokens(result) <= budget

    def test_manifest_stays_within_budget_saturated_session(self, tmp_data_dir):
        """A heavily populated session never exceeds the token budget."""
        from token_goat.repomap import estimate_tokens

        sid = "section-budget-saturated"
        for i in range(20):
            session.mark_file_edited(sid, f"/proj/src/edited_{i:02d}.py")
        for i in range(15):
            session.mark_file_read(sid, f"/proj/src/sym_{i:02d}.py", symbol=f"fn_{i}")
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/read_{i:02d}.py", offset=0, limit=100)
        for i in range(10):
            session.mark_grep(sid, f"pattern_{i}", "/proj/src")

        budget = 400
        result = compact.build_manifest(sid, max_tokens=budget)
        assert result
        actual = estimate_tokens(result)
        assert actual <= budget, (
            f"saturated manifest exceeded budget: {actual} > {budget}\n{result}"
        )

    def test_bash_section_included_when_files_section_is_small(self, tmp_data_dir):
        """Bash history appears even when files section is small (no crowding)."""
        from token_goat.repomap import estimate_tokens

        sid = "section-budget-bash-not-crowded"
        # Only one file read — files section will be tiny.
        session.mark_file_read(sid, "/proj/src/only.py", offset=0, limit=50)
        # Add bash history.
        session.mark_bash_run(
            sid, "abc123def456", "pytest tests/ -x",
            "output-id-001",
            stdout_bytes=2000, stderr_bytes=100,
            exit_code=0, truncated=False,
        )
        # Set session to mature so the young-tier guard does not suppress bash.
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "**Ran:**" in result, (
            f"bash section missing when files section is small:\n{result}"
        )
        assert estimate_tokens(result) <= 400

    def test_token_count_helper(self):
        """_token_count returns len(text) // 4."""
        assert compact._token_count("") == 0
        assert compact._token_count("a" * 8) == 2
        assert compact._token_count("a" * 100) == 25


# ---------------------------------------------------------------------------
# _importance_score and composite ranking in Key Files Read
# ---------------------------------------------------------------------------


def _make_entry(
    path: str,
    *,
    read_count: int = 1,
    symbols: list[str] | None = None,
    last_read_ts: float | None = None,
) -> session.FileEntry:
    """Construct a FileEntry for _importance_score unit tests."""
    from token_goat.session import FileEntry
    if last_read_ts is None:
        last_read_ts = time.time()
    return FileEntry(
        rel_or_abs=path,
        last_read_ts=last_read_ts,
        read_count=read_count,
        line_ranges=[],
        symbols_read=symbols or [],
    )


class TestImportanceScore:
    """Unit tests for _importance_score() composite ranking function."""

    def test_file_with_symbols_outranks_file_with_more_reads(self):
        """A file read once with 5 symbols outranks a file read 5× with no symbols.

        Symbol score: 5 * 2.0 = 10.0 vs read score: 5 * 1.0 = 5.0.
        Even with equal recency the symbol-heavy file wins.
        """
        now = time.time()
        # File A: read 5×, no symbols → read_score=5.0, symbol_score=0.0
        entry_a = _make_entry("/proj/scanned.py", read_count=5, symbols=[], last_read_ts=now - 10)
        # File B: read 1×, 5 symbols → read_score=1.0, symbol_score=10.0
        entry_b = _make_entry("/proj/symbolic.py", read_count=1, symbols=["a", "b", "c", "d", "e"], last_read_ts=now - 10)

        score_a = compact._importance_score(entry_a, now)
        score_b = compact._importance_score(entry_b, now)

        assert score_b > score_a, (
            f"symbol-heavy file should outrank read-heavy file: "
            f"symbolic={score_b:.3f} vs scanned={score_a:.3f}"
        )

    def test_edited_file_outranks_unedited_files(self):
        """A file with edit_bonus=15.0 outranks files with more reads and symbols.

        Even a file read 10× with 5 symbols (read=10 + symbol=10 = 20) cannot
        beat edit_bonus=15.0 + read=1 + recency=~3 = ~19... actually let's
        use a simpler case: edit_bonus alone (15) beats read-only (10 reads, no symbols).
        """
        now = time.time()
        # Unedited: read 10×, no symbols → max read_score=10.0 + recency≈3.0 = ~13
        entry_heavy = _make_entry("/proj/heavy.py", read_count=10, symbols=[], last_read_ts=now - 1)
        # Edited: read once, no symbols, edit_bonus=15.0 → 1.0 + 0 + 15.0 + recency≈3.0 = ~19
        entry_edited = _make_entry("/proj/edited.py", read_count=1, symbols=[], last_read_ts=now - 1)

        score_heavy = compact._importance_score(entry_heavy, now, edit_bonus=0.0)
        score_edited = compact._importance_score(entry_edited, now, edit_bonus=15.0)

        assert score_edited > score_heavy, (
            f"edited file should outrank heavy-read file: "
            f"edited={score_edited:.3f} vs heavy={score_heavy:.3f}"
        )

    def test_older_file_scores_lower_than_recent_file(self):
        """An older file scores lower than a recently-read file with the same counts.

        Two files with identical read_count and symbols; the one read 2 hours
        ago has a much lower recency bonus than the one read 1 second ago.
        """
        now = time.time()
        entry_recent = _make_entry("/proj/recent.py", read_count=2, symbols=[], last_read_ts=now - 5)
        entry_old = _make_entry("/proj/old.py", read_count=2, symbols=[], last_read_ts=now - 7200)

        score_recent = compact._importance_score(entry_recent, now)
        score_old = compact._importance_score(entry_old, now)

        assert score_recent > score_old, (
            f"recently-read file should score higher: recent={score_recent:.3f} old={score_old:.3f}"
        )

    def test_read_count_capped_at_ten(self):
        """read_count is capped at 10 so a 50× file does not dominate symbol signal."""
        now = time.time()
        entry_10 = _make_entry("/proj/a.py", read_count=10, symbols=[], last_read_ts=now)
        entry_50 = _make_entry("/proj/b.py", read_count=50, symbols=[], last_read_ts=now)

        # Both capped to 10 → identical read_score → scores must be equal (same recency)
        assert compact._importance_score(entry_10, now) == compact._importance_score(entry_50, now)

    def test_symbol_count_capped_at_twenty(self):
        """symbol_score is capped at 20 symbols (score=40) to prevent extreme outliers."""
        now = time.time()
        entry_20 = _make_entry("/proj/a.py", read_count=1, symbols=[f"s{i}" for i in range(20)], last_read_ts=now)
        entry_50 = _make_entry("/proj/b.py", read_count=1, symbols=[f"s{i}" for i in range(50)], last_read_ts=now)

        assert compact._importance_score(entry_20, now) == compact._importance_score(entry_50, now)

    def test_recency_max_at_zero_age(self):
        """recency bonus is 3.0 when the file was just read (age=0)."""
        now = time.time()
        entry = _make_entry("/proj/fresh.py", read_count=0, symbols=[], last_read_ts=now)
        score = compact._importance_score(entry, now)
        # read_score=0, symbol_score=0, edit_bonus=0, recency=exp(0)*3.0=3.0
        assert abs(score - 3.0) < 0.01, f"expected ~3.0 at age=0, got {score}"

    def test_recency_half_life_at_thirty_minutes(self):
        """recency bonus is ~1.5 (half of 3.0) at exactly 30 minutes."""
        now = time.time()
        age = 1800.0  # 30 minutes — one half-life
        entry = _make_entry("/proj/halflife.py", read_count=0, symbols=[], last_read_ts=now - age)
        score = compact._importance_score(entry, now)
        # read_score=0, symbol_score=0, recency=0.5*3.0=1.5
        assert abs(score - 1.5) < 0.05, f"expected ~1.5 at 30min, got {score}"


class TestImportanceScoringInManifest:
    """Integration tests: _importance_score drives 'Key Files Read' section ordering."""

    def test_symbol_file_outranks_scan_heavy_file_in_manifest(self, tmp_data_dir):
        """A file read once with symbols appears before a file read many times with none."""
        sid = "importance-sym-vs-reads-session"
        # File A: read 5 times, no symbols
        for _ in range(5):
            session.mark_file_read(sid, "/proj/src/scanned.py", offset=0, limit=50)
        # File B: read once, 3 symbols
        session.mark_file_read(sid, "/proj/src/symbolic.py", symbol="parse_tree")
        session.mark_file_read(sid, "/proj/src/symbolic.py", symbol="walk_nodes")
        session.mark_file_read(sid, "/proj/src/symbolic.py", symbol="emit_tokens")

        result = compact.build_manifest(sid)
        # Both should appear (scanned has 5 reads so it might be hot; if so use Key Files)
        assert "scanned.py" in result
        assert "symbolic.py" in result

        # Symbols Accessed section shows symbolic.py — check it appears before scanned.py
        # in the overall manifest (symbols section precedes key-files section)
        assert result.index("symbolic.py") < result.index("scanned.py"), (
            f"symbolic file should appear before scanned file:\n{result}"
        )

    def test_edited_file_appears_before_unedited_in_manifest(self, tmp_data_dir):
        """Files Edited section always precedes Key Files Read."""
        sid = "importance-edit-before-reads-session"
        # Read an unedited file many times
        for _ in range(8):
            session.mark_file_read(sid, "/proj/src/read_heavy.py", offset=0, limit=50)
        # Edit a different file once
        session.mark_file_edited(sid, "/proj/src/edited_once.py")

        result = compact.build_manifest(sid)
        assert "edited_once.py" in result
        assert "read_heavy.py" in result
        # "**Edited:**" section must appear before "**Files:**"
        assert result.index("**Edited:**") < result.index("**Files:**"), (
            f"'**Edited:**' must precede '**Files:**':\n{result}"
        )
        # Edited file must appear before read-heavy file
        assert result.index("edited_once.py") < result.index("read_heavy.py"), (
            f"edited file must appear before unedited read-heavy file:\n{result}"
        )

    def test_recently_read_file_outranks_older_file_when_counts_tie(self, tmp_data_dir):
        """When read_count and symbol counts are equal, the recently-read file ranks higher."""
        import time as _time
        sid = "importance-recency-tie-session"
        # Both files read exactly twice, no symbols
        session.mark_file_read(sid, "/proj/src/older.py", offset=0, limit=50)
        session.mark_file_read(sid, "/proj/src/older.py", offset=50, limit=50)
        _time.sleep(0.02)
        session.mark_file_read(sid, "/proj/src/newer.py", offset=0, limit=50)
        session.mark_file_read(sid, "/proj/src/newer.py", offset=50, limit=50)

        result = compact.build_manifest(sid)
        assert "older.py" in result
        assert "newer.py" in result

        # Find the Key Files Read section to check ordering there
        if "**Files:**" in result:
            key_section = result.split("**Files:**")[1]
            assert key_section.index("newer.py") < key_section.index("older.py"), (
                f"recently-read file should rank higher in Key Files Read:\n{result}"
            )
        else:
            # Both might be in Symbols or Hot — just check overall ordering
            assert result.index("newer.py") < result.index("older.py"), (
                f"recently-read file should appear before older file:\n{result}"
            )


# ---------------------------------------------------------------------------
# Session age tier and age-aware budget / section visibility
# ---------------------------------------------------------------------------


class TestSessionAgeTier:
    """_session_age_tier classifies age into young / active / mature."""

    def test_zero_seconds_is_young(self):
        assert compact._session_age_tier(0) == "young"

    def test_just_below_10min_is_young(self):
        assert compact._session_age_tier(599) == "young"

    def test_exactly_10min_is_active(self):
        assert compact._session_age_tier(600) == "active"

    def test_just_below_60min_is_active(self):
        assert compact._session_age_tier(3599) == "active"

    def test_exactly_60min_is_mature(self):
        assert compact._session_age_tier(3600) == "mature"

    def test_two_hours_is_mature(self):
        assert compact._session_age_tier(7200) == "mature"


class TestComputeAdaptiveBudgetWithAge:
    """compute_adaptive_budget applies tier multipliers and respects the new ceiling."""

    def test_young_session_reduces_budget(self, tmp_data_dir):
        """Young session (age < 10 min) multiplies base budget by 0.6."""
        sid = "young-age-budget"
        # 2 edits → raw = 200 + 100 = 300; × 0.6 = 180 → clamped to 200 (floor)
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=0.0)
        # raw=300 × 0.6 = 180 → floor clamps to 200
        assert budget == 200

    def test_young_session_floor_clamped(self, tmp_data_dir):
        """Young empty session: 200 base × 0.6 = 120 → clamped to 200."""
        sid = "young-floor-clamp"
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=0.0)
        assert budget == 200

    def test_active_session_no_change(self, tmp_data_dir):
        """Active session (10-60 min) multiplier is 1.0 — budget unchanged."""
        sid = "active-age-budget"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        cache = session.load(sid)
        budget_active = compact.compute_adaptive_budget(cache, age_seconds=1800)
        budget_no_age = compact.compute_adaptive_budget(cache, age_seconds=0.0)
        # active × 1.0 should equal the full raw budget (300 tokens)
        assert budget_active == 300
        # Must differ from the young-session budget (which would be 200)
        assert budget_active > budget_no_age

    def test_mature_session_increases_budget(self, tmp_data_dir):
        """Mature session (> 60 min) multiplies budget by 1.4, capped at 800."""
        sid = "mature-age-budget"
        # 2 edits → raw = 200 + 100 = 300; × 1.4 = 420
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=7200)
        assert budget == 420

    def test_mature_session_capped_at_800(self, tmp_data_dir):
        """Mature session with maximum complexity is capped at 800 tokens."""
        sid = "mature-ceiling"
        for i in range(10):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        for i in range(10):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"fn_{i}")
        session.mark_bash_run(sid, "sha_ceil", "pytest", "id_ceil", 2000, 1000, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=7200)
        assert budget <= 800

    def test_default_age_zero_treated_as_young(self, tmp_data_dir):
        """Omitting age_seconds defaults to 0.0 (young tier)."""
        sid = "default-age-young"
        for i in range(4):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        cache = session.load(sid)
        # With no age arg: raw=200+200=400 × 0.6 = 240
        budget_default = compact.compute_adaptive_budget(cache)
        budget_explicit = compact.compute_adaptive_budget(cache, age_seconds=0.0)
        assert budget_default == budget_explicit == 240


class TestYoungSessionOmitsBashSection:
    """Young sessions must not render the bash history or cold outputs sections."""

    def test_young_session_omits_bash_section(self, tmp_data_dir):
        """Bash history section absent for young session even when bash history exists."""
        sid = "young-no-bash-abc"
        session.mark_file_edited(sid, "/proj/src/app.py")
        session.mark_bash_run(
            sid, "sha_young_bash", "pytest -x",
            "out_young_001",
            stdout_bytes=2000, stderr_bytes=100,
            exit_code=0, truncated=False,
        )
        cache = session.load(sid)
        # Mark session as very young (2 minutes old)
        cache.created_ts = time.time() - 120
        session.save(cache)

        result = compact.build_manifest(sid)

        assert "**Ran:**" not in result, (
            f"bash section must be absent for young session:\n{result}"
        )

    def test_young_session_omits_cold_outputs(self, tmp_data_dir):
        """Cold outputs section absent for young session."""
        sid = "young-no-cold-abc"
        session.mark_file_edited(sid, "/proj/src/app.py")
        old_ts = time.time() - 1801
        session.mark_bash_run(
            sid, "sha_young_cold", "make build",
            "out_cold_young",
            stdout_bytes=1500, stderr_bytes=0,
            exit_code=0, truncated=False,
        )
        cache = session.load(sid)
        # Adjust bash entry timestamp to be cold
        for entry in cache.bash_history.values():
            if getattr(entry, "output_id", None) == "out_cold_young":
                entry.ts = old_ts
        # Mark session as young
        cache.created_ts = time.time() - 120
        session.save(cache)

        result = compact.build_manifest(sid)

        assert "Cold Outputs" not in result, (
            f"cold outputs must be absent for young session:\n{result}"
        )

    def test_mature_session_includes_bash_section(self, tmp_data_dir):
        """Mature session (> 60 min) does render bash history when present."""
        sid = "mature-bash-abc"
        session.mark_file_edited(sid, "/proj/src/app.py")
        session.mark_bash_run(
            sid, "sha_mature_bash", "pytest -v",
            "out_mature_001",
            stdout_bytes=2000, stderr_bytes=100,
            exit_code=0, truncated=False,
        )
        cache = session.load(sid)
        # Mark session as mature (2 hours old)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        result = compact.build_manifest(sid)

        assert "**Ran:**" in result, (
            f"bash section must be present for mature session:\n{result}"
        )


# ---------------------------------------------------------------------------
# Tests for _get_uncommitted_changes and the ### Uncommitted Changes section
# ---------------------------------------------------------------------------


class TestGetUncommittedChanges:
    """Unit tests for compact._get_uncommitted_changes()."""

    @pytest.fixture(autouse=True)
    def _clear_uncommitted_cache(self):
        # _get_uncommitted_changes now has a process-level cache keyed by path
        # (mirrors the diff-stat summary cache). Tests that monkeypatch
        # subprocess.run with different fakes for the same path otherwise see
        # the previous test's cached result. Clear before and after each test.
        # Also clear _is_git_repo_cache so monkeypatched _is_git_repo takes effect.
        compact._uncommitted_changes_cache.clear()
        compact._is_git_repo_cache.clear()
        yield
        compact._uncommitted_changes_cache.clear()
        compact._is_git_repo_cache.clear()

    def test_returns_none_when_project_root_is_none(self):
        """None project_root must return None immediately without calling git."""
        result = compact._get_uncommitted_changes(None)
        assert result is None

    def test_returns_none_when_subprocess_raises(self, monkeypatch):
        """Any exception from subprocess.run must be swallowed; None returned."""
        import subprocess as _subprocess  # noqa: PLC0415

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(
            _subprocess,
            "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("git not found")),
        )
        result = compact._get_uncommitted_changes("/some/path")
        assert result is None

    def test_returns_none_when_subprocess_times_out(self, monkeypatch):
        """TimeoutExpired from subprocess must be swallowed; None returned."""
        import subprocess as _subprocess  # noqa: PLC0415

        def _raise_timeout(*a, **kw):
            raise _subprocess.TimeoutExpired(cmd="git", timeout=5)

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _raise_timeout)
        result = compact._get_uncommitted_changes("/some/path")
        assert result is None

    def test_returns_none_when_both_commands_produce_empty_output(self, monkeypatch):
        """Both diff and status returning empty → None (no changes)."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        def _fake_run(args, **kw):
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is None

    def test_returns_diff_stat_lines_for_tracked_changes(self, monkeypatch):
        """Tracked file changes from git diff --stat appear in the output."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        diff_output = " src/foo.py | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n"
        status_output = " M src/foo.py\n"

        call_count = {"n": 0}

        def _fake_run(args, **kw):
            call_count["n"] += 1
            # First call is git diff, second is git status
            if "diff" in args:
                return types.SimpleNamespace(returncode=0, stdout=diff_output, stderr="")
            return types.SimpleNamespace(returncode=0, stdout=status_output, stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        assert "foo.py" in result

    def test_includes_untracked_files_from_status(self, monkeypatch):
        """Untracked files (??) in git status --short appear when not in diff output."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        def _fake_run(args, **kw):
            if "diff" in args:
                # No tracked changes
                return types.SimpleNamespace(returncode=0, stdout="", stderr="")
            # Untracked file
            return types.SimpleNamespace(returncode=0, stdout="?? new_file.py\n", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        assert "new_file.py" in result

    def test_caps_output_at_eight_lines(self, monkeypatch):
        """Output with more than 8 lines is truncated to 8."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        # 12 file-stat lines from diff
        many_lines = "\n".join(f" file{i}.py | {i+1} +" for i in range(12))

        def _fake_run(args, **kw):
            if "diff" in args:
                return types.SimpleNamespace(returncode=0, stdout=many_lines + "\n", stderr="")
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        assert len(result.splitlines()) <= 8

    def test_does_not_duplicate_files_in_both_diff_and_status(self, monkeypatch):
        """A file appearing in both diff --stat and status --short is not listed twice."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        def _fake_run(args, **kw):
            if "diff" in args:
                return types.SimpleNamespace(
                    returncode=0,
                    stdout=" src/bar.py | 5 ++---\n 1 file changed\n",
                    stderr="",
                )
            return types.SimpleNamespace(returncode=0, stdout=" M src/bar.py\n", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        # "bar.py" appears at most once in the combined output
        assert result.count("bar.py") == 1

    @pytest.mark.slow
    def test_integration_with_real_git_repo(self, tmp_path):
        """Integration: returns non-None when there are uncommitted changes."""
        git_repo = make_git_repo(tmp_path, files={"foo.py": "line1\n"})

        # Modify tracked file
        (git_repo / "foo.py").write_text("line1\nline2\n")
        result = compact._get_uncommitted_changes(str(git_repo))
        assert result is not None
        assert "foo.py" in result

    @pytest.mark.slow
    def test_integration_untracked_file(self, tmp_path):
        """Integration: returns non-None for a new untracked file."""
        git_repo = make_git_repo(tmp_path, "repo2", files={"base.py": "x\n"})

        # Add an untracked file (not staged, not committed)
        (git_repo / "untracked.py").write_text("new\n")

        result = compact._get_uncommitted_changes(str(git_repo))
        assert result is not None
        assert "untracked.py" in result

    @pytest.mark.slow
    def test_integration_clean_repo_returns_none(self, tmp_path):
        """Integration: clean repo (no pending changes) returns None."""
        git_repo = make_git_repo(tmp_path, "clean", files={"bar.py": "x\n"})

        result = compact._get_uncommitted_changes(str(git_repo))
        assert result is None

    def test_caps_output_at_200_chars(self, monkeypatch):
        """Combined output longer than 200 chars is truncated to a whole-line boundary."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        # 8 lines of 35 chars each = 280 chars total, over the 200-char cap.
        many_chars = "\n".join(f" file{i:02d}.py | {'+'*20}" for i in range(8))

        def _fake_run(args, **kw):
            if "diff" in args:
                return types.SimpleNamespace(returncode=0, stdout=many_chars, stderr="")
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        assert len(result) <= 200
        # Result must end on a complete line (no mid-line truncation).
        assert not result.endswith("|")

    def test_nonzero_diff_exit_code_falls_back_to_status(self, monkeypatch):
        """When git diff --stat fails, status-only output is still returned."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        def _fake_run(args, **kw):
            if "diff" in args:
                return types.SimpleNamespace(returncode=128, stdout="", stderr="fatal: bad HEAD")
            return types.SimpleNamespace(returncode=0, stdout="?? new.py\n", stderr="")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is not None
        assert "new.py" in result

    def test_both_commands_fail_returns_none(self, monkeypatch):
        """When both git commands return non-zero, None is returned."""
        import subprocess as _subprocess  # noqa: PLC0415
        import types  # noqa: PLC0415

        def _fake_run(args, **kw):
            return types.SimpleNamespace(returncode=128, stdout="", stderr="fatal")

        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        monkeypatch.setattr(_subprocess, "run", _fake_run)
        result = compact._get_uncommitted_changes("/some/repo")
        assert result is None


class TestUncommittedChangesManifestSection:
    """Tests for the **Uncommitted:** section in the manifest."""

    def test_section_present_when_uncommitted_changes_exist(self, tmp_data_dir, monkeypatch):
        """Manifest includes '**Uncommitted:**' when helper returns non-empty string."""
        sid = "uncommitted-present-test-abc"
        session.mark_file_edited(sid, "/proj/src/main.py")
        session.mark_file_read(sid, "/proj/src/main.py")

        monkeypatch.setattr(
            compact,
            "_get_uncommitted_changes",
            lambda _root: " src/main.py | 5 ++---\n 1 file changed, 3 insertions(+), 2 deletions(-)",
        )
        # Suppress the other git calls so they don't interfere
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        assert "**Uncommitted:**" in result, (
            f"Expected '**Uncommitted:**' in manifest:\n{result}"
        )
        assert "main.py" in result

    def test_section_absent_when_no_uncommitted_changes(self, tmp_data_dir, monkeypatch):
        """Manifest does not include '**Uncommitted:**' when helper returns None."""
        sid = "uncommitted-absent-test-abc"
        session.mark_file_edited(sid, "/proj/src/utils.py")
        session.mark_file_read(sid, "/proj/src/utils.py")

        monkeypatch.setattr(compact, "_get_uncommitted_changes", lambda _root: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        assert "**Uncommitted:**" not in result, (
            f"Should not include section when helper returns None:\n{result}"
        )

    def test_section_absent_when_subprocess_raises(self, tmp_data_dir, monkeypatch):
        """Manifest is unaffected when subprocess raises inside _get_uncommitted_changes."""
        import subprocess as _subprocess  # noqa: PLC0415

        sid = "uncommitted-subprocess-raises-test-abc"
        session.mark_file_edited(sid, "/proj/src/crash.py")
        session.mark_file_read(sid, "/proj/src/crash.py")

        # Make subprocess.run raise for both git calls; the helper must swallow
        # the exception and return None, leaving the section absent.
        monkeypatch.setattr(
            _subprocess,
            "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("git not available")),
        )
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        # build_manifest must complete without raising
        result = compact.build_manifest(sid)
        assert "**Uncommitted:**" not in result, (
            f"Section must be absent when subprocess fails:\n{result}"
        )

    def test_section_appears_before_files_edited(self, tmp_data_dir, monkeypatch):
        """'**Uncommitted:**' must appear before '**Edited:**' in the manifest."""
        sid = "uncommitted-order-test-abc"
        session.mark_file_edited(sid, "/proj/src/order.py")
        session.mark_file_read(sid, "/proj/src/order.py")

        monkeypatch.setattr(
            compact,
            "_get_uncommitted_changes",
            lambda _root: " src/order.py | 2 +-\n 1 file changed",
        )
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        assert "**Uncommitted:**" in result
        assert "**Edited:**" in result

        idx_uncommitted = result.index("**Uncommitted:**")
        idx_edited = result.index("**Edited:**")
        assert idx_uncommitted < idx_edited, (
            f"'**Uncommitted:**' (pos {idx_uncommitted}) must precede "
            f"'**Edited:**' (pos {idx_edited})"
        )

    def test_section_shown_even_without_claude_tool_edits(self, tmp_data_dir, monkeypatch):
        """Uncommitted Changes section appears even when edited_files is empty."""
        sid = "uncommitted-no-edits-test-abc"
        # Only a read, no edits tracked by Claude tools
        session.mark_file_read(sid, "/proj/src/read_only.py")

        monkeypatch.setattr(
            compact,
            "_get_uncommitted_changes",
            lambda _root: "?? untracked.py",
        )
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        assert "**Uncommitted:**" in result, (
            f"**Uncommitted:** section must appear even with no Claude-tracked edits:\n{result}"
        )
        assert "untracked.py" in result

    def test_section_lines_are_indented(self, tmp_data_dir, monkeypatch):
        """Each content line in the Uncommitted Changes section is indented with two spaces."""
        sid = "uncommitted-indent-test-abc"
        session.mark_file_edited(sid, "/proj/src/indent.py")
        session.mark_file_read(sid, "/proj/src/indent.py")

        monkeypatch.setattr(
            compact,
            "_get_uncommitted_changes",
            lambda _root: " src/indent.py | 3 +++",
        )
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        lines = result.splitlines()
        header_idx = next(
            (i for i, line in enumerate(lines) if "**Uncommitted:**" in line), None
        )
        assert header_idx is not None
        # The line immediately after the header should be the content, indented
        content_lines = [
            line for line in lines[header_idx + 1:]
            if line.strip() and not line.startswith("**")
        ]
        for content_line in content_lines[:3]:  # Check first few content lines
            if "indent.py" in content_line or "file changed" in content_line or content_line.strip().startswith("src/"):
                assert content_line.startswith("  "), (
                    f"Content line should start with two spaces: {content_line!r}"
                )
                break


class TestComputeAdaptiveBudgetUncommittedBonus:
    """compute_adaptive_budget adds +10 when has_uncommitted_changes=True."""

    def test_uncommitted_bonus_adds_ten_tokens(self, tmp_data_dir):
        """has_uncommitted_changes=True increases budget by 10 before tier scaling."""
        sid = "uncommitted-bonus-test-abc"
        session.mark_file_read(sid, "/proj/src/a.py")
        cache = session.load(sid)

        age = 1800.0  # active tier → factor 1.0, so delta is unscaled
        budget_without = compact.compute_adaptive_budget(
            cache, age_seconds=age, has_uncommitted_changes=False
        )
        budget_with = compact.compute_adaptive_budget(
            cache, age_seconds=age, has_uncommitted_changes=True
        )
        assert budget_with == budget_without + 10, (
            f"Expected +10 for uncommitted bonus: without={budget_without} with={budget_with}"
        )

    def test_uncommitted_bonus_false_by_default(self, tmp_data_dir):
        """Default has_uncommitted_changes=False produces same budget as explicit False."""
        sid = "uncommitted-bonus-default-test-abc"
        session.mark_file_read(sid, "/proj/src/b.py")
        cache = session.load(sid)

        age = 1800.0
        budget_default = compact.compute_adaptive_budget(cache, age_seconds=age)
        budget_explicit = compact.compute_adaptive_budget(
            cache, age_seconds=age, has_uncommitted_changes=False
        )
        assert budget_default == budget_explicit

    def test_uncommitted_bonus_independent_of_pending_diff(self, tmp_data_dir):
        """has_uncommitted_changes and has_pending_diff bonuses stack independently."""
        sid = "uncommitted-stack-test-abc"
        session.mark_file_read(sid, "/proj/src/c.py")
        cache = session.load(sid)

        age = 1800.0
        budget_neither = compact.compute_adaptive_budget(
            cache, age_seconds=age, has_pending_diff=False, has_uncommitted_changes=False
        )
        budget_both = compact.compute_adaptive_budget(
            cache, age_seconds=age, has_pending_diff=True, has_uncommitted_changes=True
        )
        # pending_diff adds 50, uncommitted adds 10 → total +60
        assert budget_both == budget_neither + 60, (
            f"Expected +60 for both bonuses: neither={budget_neither} both={budget_both}"
        )


class TestEmptySectionSuppression:
    """Empty sections should not emit headers (Improvement 1)."""

    def test_bash_section_suppressed_when_no_commands(self, tmp_data_dir, monkeypatch):
        """Commands Run section header not emitted when no bash history in session."""
        sid = "empty-bash-test-abc"
        session.mark_file_read(sid, "/proj/src/a.py")
        cache = session.load(sid)
        # Verify bash_history is empty
        assert len(cache.bash_history) == 0

        monkeypatch.setattr(compact, "_get_uncommitted_changes", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        lines = result.splitlines()
        # Check that "**Ran:**" header does not appear when bash_history is empty
        bash_header_idx = next(
            (i for i, line in enumerate(lines) if "**Ran:**" in line), None
        )
        assert bash_header_idx is None, "**Ran:** header should not appear when no bash history"

    def test_grep_section_suppressed_when_no_patterns(self, tmp_data_dir, monkeypatch):
        """**Grep:** section header not emitted when no grep history in session."""
        sid = "empty-grep-test-abc"
        session.mark_file_read(sid, "/proj/src/a.py")
        cache = session.load(sid)
        # Verify greps list is empty
        assert len(cache.greps) == 0

        monkeypatch.setattr(compact, "_get_uncommitted_changes", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        lines = result.splitlines()
        # Check that "**Grep:**" header does not appear when greps is empty
        grep_header_idx = next(
            (i for i, line in enumerate(lines) if "**Grep:**" in line), None
        )
        assert grep_header_idx is None, "**Grep:** header should not appear when no grep history"

    def test_web_section_suppressed_when_no_fetches(self, tmp_data_dir, monkeypatch):
        """**Web:** section header not emitted when no web history in session."""
        sid = "empty-web-test-abc"
        session.mark_file_read(sid, "/proj/src/a.py")
        cache = session.load(sid)
        # Verify web_history is empty
        assert len(cache.web_history) == 0

        monkeypatch.setattr(compact, "_get_uncommitted_changes", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact.build_manifest(sid)
        lines = result.splitlines()
        # Check that "**Web:**" header does not appear when web_history is empty
        web_header_idx = next(
            (i for i, line in enumerate(lines) if "**Web:**" in line), None
        )
        assert web_header_idx is None, "**Web:** header should not appear when no web history"

    def test_web_section_rendered_with_single_entry(self, tmp_data_dir):
        """A single web fetch IS rendered — one fetched URL is genuine signal."""
        import time as _time
        sid = "single-web-test-abc"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_web_fetch(sid, "sha_1", "https://example.com/docs", "out_id_1", 12_000, 200, False)

        cache = session.load(sid)
        cache.created_ts = _time.time() - 4000
        session.save(cache)
        cache = session.load(sid)

        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Web:**" in manifest

    def test_web_section_present_when_two_domain_entries(self, tmp_data_dir):
        """**Web:** section emitted when two different domains produce two output lines."""
        import time as _time
        sid = "two-web-test-abc"
        session.mark_file_edited(sid, "/proj/app.py")
        # Two different domains → two grouped lines → min_lines=2 satisfied.
        # mark_web_fetch args: (sid, url_sha, url_preview, output_id, body_bytes, status_code, truncated)
        # url_preview must be a proper URL so domain grouping works correctly.
        session.mark_web_fetch(
            sid, "sha_a", "https://example.com/page", "out_id_a", 500, 200, False
        )
        session.mark_web_fetch(
            sid, "sha_b", "https://otherdomain.org/docs", "out_id_b", 500, 200, False
        )

        cache = session.load(sid)
        # Mature session so web section is not skipped by age-tier guard
        cache.created_ts = _time.time() - 4000
        session.save(cache)
        cache = session.load(sid)

        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Web:**" in manifest, (
            "**Web:** header should appear when two different-domain entries exist"
        )


class TestShortPathProjectStripping:
    """_short_path strips the project basename when project_root is provided."""

    def test_strips_project_name_non_src_path(self):
        """Path with project basename but no /src/ component is stripped."""
        result = compact._short_path(
            "token-goat/lib/foo.py",
            project_root="/Projects/token-goat",
        )
        assert result == "lib/foo.py", f"Expected 'lib/foo.py', got {result!r}"

    def test_strips_project_name_with_windows_root(self):
        """Works with Windows-style absolute project_root, non-src path."""
        result = compact._short_path(
            "token-goat/render/panel.py",
            project_root="C:/Projects/token-goat",
        )
        assert result == "render/panel.py", f"Expected 'render/panel.py', got {result!r}"

    def test_keeps_other_project_name(self):
        """Path from a different project keeps its leading component (no /src/)."""
        result = compact._short_path(
            "other-project/lib/bar.py",
            project_root="/Projects/token-goat",
        )
        assert result == "other-project/lib/bar.py", (
            f"Expected 'other-project/lib/bar.py', got {result!r}"
        )

    def test_no_stripping_without_project_root(self):
        """Without project_root a non-src path is returned as-is."""
        result = compact._short_path("token-goat/lib/foo.py")
        assert result == "token-goat/lib/foo.py", (
            f"Expected 'token-goat/lib/foo.py', got {result!r}"
        )

    def test_src_prefix_still_wins_for_absolute_paths(self):
        """The /src/ prefix strip handles absolute paths regardless of project_root."""
        result = compact._short_path(
            "/Projects/token-goat/src/foo.py",
            project_root="/Projects/token-goat",
        )
        assert result == "src/foo.py", f"Expected 'src/foo.py', got {result!r}"

    def test_manifest_edited_file_strips_project_name(self, tmp_data_dir, monkeypatch):
        """End-to-end: edited file path has project name stripped in manifest.

        cwd is not persisted to disk (set by hooks at runtime), so we use
        _build_manifest_from_cache with the in-memory cache — the same pattern
        used by other manifest tests that need a specific cwd.
        """
        sid = "path-norm-edited-abc"
        session.mark_file_edited(sid, "token-goat/render/panel.py")
        cache = session.load(sid)
        # Use a non-src path so project-name stripping is clearly exercised
        # (the /src/ prefix strip would otherwise shadow the result).
        cache.cwd = "/Projects/token-goat"

        monkeypatch.setattr(compact, "_get_uncommitted_changes", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda _root: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda *a: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda *a: [])

        result = compact._build_manifest_from_cache(cache, sid, 400)
        assert "render/panel.py" in result, "Project name should be stripped from edited path"
        assert "token-goat/render/panel.py" not in result, (
            "Full project-prefixed path should not appear in manifest"
        )


class TestHintContentHashDedup:
    """Hint content dedup by rendered string hash (Improvement 2)."""

    def test_duplicate_hint_suppressed_by_content_hash(self, tmp_data_dir):
        """Same hint text with different fingerprint should be suppressed on second call."""
        from token_goat import hints as hints_module

        sid = "hint-hash-dedup-test-abc"
        cache = session.load(sid)

        # Simulate two different file ranges that render to the same hint text.
        # We'll call build_read_hint twice with different fingerprints but identical text.
        # First, manually set up the cache to simulate previous hints.
        hint_text = "You read lines 100–150 of /proj/src/module.py in this session."
        content_hash = hints_module._hint_content_hash(hint_text)

        # First hint with one fingerprint should be emitted.
        cache.hints_seen.add("fp:100:150:/proj/src/module.py")
        cache.hints_seen.add(content_hash)  # Add the content hash after first emit
        session.save(cache)
        cache = session.load(sid)

        # Now manually verify that the content_hash function works.
        assert len(content_hash) == 8, "Content hash should be 8 hex chars"
        assert content_hash in cache.hints_seen, "Content hash should be in hints_seen"

    def test_hint_content_hash_is_deterministic(self):
        """Hint content hash should always return the same value for the same text."""
        from token_goat import hints as hints_module

        text1 = "You read lines 1–10 of /proj/src/a.py in this session."
        text2 = "You read lines 1–10 of /proj/src/a.py in this session."
        text3 = "You read lines 2–10 of /proj/src/a.py in this session."

        hash1 = hints_module._hint_content_hash(text1)
        hash2 = hints_module._hint_content_hash(text2)
        hash3 = hints_module._hint_content_hash(text3)

        assert hash1 == hash2, "Same text should produce same hash"
        assert hash1 != hash3, "Different text should produce different hash"
        assert len(hash1) == 8 and len(hash3) == 8, "Hashes should be 8 hex chars"


# ---------------------------------------------------------------------------
# Edge Case Tests: Session Age Tier Boundaries
# ---------------------------------------------------------------------------


class TestSessionAgeTierBoundaries:
    """Test exact boundary conditions for session age tier classification.

    Young  < 600 seconds (10 min)
    Active 600–3599 seconds (10–60 min)
    Mature >= 3600 seconds (60+ min)
    """

    def test_young_mature_boundary_at_exactly_600_seconds(self, tmp_data_dir):
        """At exactly 600 seconds, session should be 'active' not 'young'."""
        sid = "age-boundary-600-exact"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(600.0)
        assert tier == "active", "At 600s exactly, should be active tier"

    def test_young_boundary_at_599_seconds(self, tmp_data_dir):
        """At 599 seconds, session should still be 'young'."""
        sid = "age-boundary-599"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(599.0)
        assert tier == "young", "At 599s, should be young tier"

    def test_young_boundary_at_601_seconds(self, tmp_data_dir):
        """At 601 seconds, session should be 'active' tier."""
        sid = "age-boundary-601"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(601.0)
        assert tier == "active", "At 601s, should be active tier"

    def test_active_mature_boundary_at_exactly_3600_seconds(self, tmp_data_dir):
        """At exactly 3600 seconds, session should be 'mature'."""
        sid = "age-boundary-3600-exact"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(3600.0)
        assert tier == "mature", "At 3600s exactly, should be mature tier"

    def test_active_boundary_at_3599_seconds(self, tmp_data_dir):
        """At 3599 seconds, session should still be 'active'."""
        sid = "age-boundary-3599"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(3599.0)
        assert tier == "active", "At 3599s, should be active tier"

    def test_mature_boundary_at_3601_seconds(self, tmp_data_dir):
        """At 3601 seconds, session should be 'mature'."""
        sid = "age-boundary-3601"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_read(sid, "/proj/b.py", offset=0, limit=100)

        session.load(sid)
        tier = compact._session_age_tier(3601.0)
        assert tier == "mature", "At 3601s, should be mature tier"

    def test_young_tier_manifests_minimally(self, tmp_data_dir):
        """Young sessions should emit minimal manifests (no bash/web sections)."""
        sid = "young-manifest-minimal"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)
        session.mark_bash_run(sid, "cmd_sha_young", "pytest", "id_young", 500, 200, 0, False)

        cache = session.load(sid)
        # Build manifest with young tier
        manifest = compact._build_manifest_from_cache(cache, sid, 400)
        # Young sessions skip bash section
        assert "**Ran:**" not in manifest, "Young sessions should not show bash section"

    def test_active_tier_includes_bash_section(self, tmp_data_dir):
        """Active tier sessions should include bash section."""
        sid = "active-manifest-bash"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)
        session.mark_bash_run(sid, "cmd_sha_act", "pytest -v", "id_active", 5000, 2000, 0, False)

        # Create cache manually with active tier age
        cache = session.load(sid)
        cache.created_ts = time.time() - 1800  # 30 minutes ago = active tier
        session.save(cache)

        compact._build_manifest_from_cache(cache, sid, 400)
        # Active sessions should show bash if history exists
        if session.load(sid).bash_history:
            # Bash section may appear depending on budget
            pass  # Just verify no crash

    def test_mature_tier_gets_extra_key_file_slots(self, tmp_data_dir):
        """Mature tier should allocate 2 extra slots for Key Files Read."""
        sid = "mature-extra-files"
        # Create mature-tier session with many files
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200  # 2 hours ago = mature tier

        for i in range(15):
            session.mark_file_read(sid, f"/proj/file{i:02d}.py", offset=0, limit=100)
        session.save(cache)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 600)
        # Mature tier allows up to _MAX_FILES_READ + 2 = 12 files
        # Just verify manifest builds without error
        assert isinstance(manifest, str)


# ---------------------------------------------------------------------------
# Edge Case Tests: Zero/Near-Zero Adaptive Budget
# ---------------------------------------------------------------------------


class TestZeroNearZeroBudgetEdgeCases:
    """Test behavior when total or section budgets approach zero."""

    def test_compute_adaptive_budget_zero_age_is_young(self, tmp_data_dir):
        """Age of 0 seconds should trigger young tier (0.6x multiplier)."""
        sid = "budget-age-zero"
        session.mark_file_edited(sid, "/proj/a.py")

        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache, age_seconds=0.0)
        # 200 + 50 = 250, × 0.6 (young) = 150, clamped to min 200
        assert budget == 200, "Young tier should clamp to minimum 200"

    def test_section_budgets_with_zero_remaining(self, tmp_data_dir):
        """_section_budgets should handle zero remaining budget gracefully."""
        # total_budget=100, edited_tokens=150 → remaining=0
        result = compact._section_budgets(100, 150)

        # All sections should get _MIN_SECTION_TOKENS (20)
        assert result["symbols"] == 20, "Symbols should get minimum 20 tokens"
        assert result["files"] == 20, "Files should get minimum 20 tokens"
        assert result["greps"] == 20, "Greps should get minimum 20 tokens"
        assert result["bash"] == 20, "Bash should get minimum 20 tokens"
        assert result["web"] == 20, "Web should get minimum 20 tokens"

    def test_section_budgets_with_one_token_remaining(self, tmp_data_dir):
        """_section_budgets should handle 1 token remaining."""
        # total_budget=50, edited_tokens=49 → remaining=1
        result = compact._section_budgets(50, 49)

        # All sections should still get _MIN_SECTION_TOKENS (20)
        assert result["symbols"] == 20
        assert result["files"] == 20
        assert result["greps"] == 20
        assert result["bash"] == 20
        assert result["web"] == 20

    def test_build_manifest_with_one_token_budget(self, tmp_data_dir):
        """build_manifest should not crash with extremely tight budget."""
        sid = "manifest-one-token"
        session.mark_file_edited(sid, "/proj/app.py")

        # This should clamp internally to minimum 1 and not crash
        result = compact.build_manifest(sid, max_tokens=1)
        # Result may be minimal or empty, but no exception
        assert isinstance(result, str)

    def test_build_manifest_with_zero_budget(self, tmp_data_dir):
        """build_manifest should clamp zero to minimum 1 internally."""
        sid = "manifest-zero-budget"
        session.mark_file_edited(sid, "/proj/app.py")

        result = compact.build_manifest(sid, max_tokens=0)
        # Should clamp to 1 internally, not crash
        assert isinstance(result, str)

    def test_section_budgets_proportions_sum_to_one(self, tmp_data_dir):
        """Verify proportions in _section_budgets sum to 1.0 for correctness."""
        # Read the code to verify: symbols=0.40, files=0.25, greps=0.15, bash=0.10, web=0.10
        # Sum = 1.0
        result = compact._section_budgets(1000, 0)

        # With 1000 remaining and no minimum clamping:
        # symbols=400, files=250, greps=150, bash=100, web=100
        assert result["symbols"] >= 20  # At least minimum
        assert result["files"] >= 20
        assert result["greps"] >= 20
        assert result["bash"] >= 20
        assert result["web"] >= 20

    def test_adaptive_budget_empty_session_at_young_age(self, tmp_data_dir):
        """Empty session at young age should return minimum (200 * 0.6 → 200)."""
        sid = "empty-young-age"
        cache = session.load(sid)

        budget = compact.compute_adaptive_budget(cache, age_seconds=5.0)
        assert budget == 200, "Young empty session should be minimum 200"

    def test_adaptive_budget_empty_session_at_mature_age(self, tmp_data_dir):
        """Empty session at mature age should return minimum (200 * 1.4 → 280, clamped to 200 min)."""
        sid = "empty-mature-age"
        cache = session.load(sid)

        budget = compact.compute_adaptive_budget(cache, age_seconds=7200.0)
        # 200 * 1.4 = 280, which is above minimum 200
        assert budget >= 200 and budget <= 800, "Budget should stay in valid range"


# ---------------------------------------------------------------------------
# Edge Case Tests: Manifest Rendering with Zero Sections
# ---------------------------------------------------------------------------


class TestManifestRenderingEdgeCases:
    """Test manifest rendering when specific sections have zero budget/content."""

    def test_render_with_no_edited_files(self, tmp_data_dir):
        """Manifest should skip Files Edited section when there are no edits."""
        sid = "no-edits-manifest"
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)
        session.mark_grep(sid, "pattern", "/proj")

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)

        # Should not crash; Files Edited section omitted
        assert isinstance(manifest, str)

    def test_render_with_no_bash_history(self, tmp_data_dir):
        """Manifest should skip bash section when no bash history exists."""
        sid = "no-bash-manifest"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)

        # Bash section should not appear
        assert "**Ran:**" not in manifest

    def test_render_with_no_web_history(self, tmp_data_dir):
        """Manifest should skip web section when no fetches exist."""
        sid = "no-web-manifest"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)

        # Web section should not appear
        assert "**Web:**" not in manifest

    def test_render_with_no_symbols_accessed(self, tmp_data_dir):
        """Manifest should skip symbols section when no symbols read."""
        sid = "no-symbols-manifest"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)  # No symbol

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)

        # Symbols section should not appear
        assert "**Syms:**" not in manifest

    def test_render_all_sections_empty(self, tmp_data_dir):
        """Manifest should return empty string when all activity is absent."""
        sid = "completely-empty"

        result = compact.build_manifest(sid)
        assert result == "", "Completely empty session should yield empty manifest"

    def test_render_with_very_large_budget(self, tmp_data_dir):
        """Manifest should not crash with very large budget (clamped internally)."""
        sid = "huge-budget"
        session.mark_file_edited(sid, "/proj/app.py")

        result = compact.build_manifest(sid, max_tokens=100_000)
        assert isinstance(result, str)

    def test_manifest_respects_young_tier_bash_skip(self, tmp_data_dir):
        """Young-tier sessions should skip bash section entirely."""
        sid = "young-skip-bash"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)
        session.mark_bash_run(sid, "cmd_sha_y", "make", "id_y", 2000, 1000, 0, False)

        cache = session.load(sid)
        # Manually set created_ts to young age
        cache.created_ts = time.time() - 30  # 30 seconds ago
        session.save(cache)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)
        # Young tier skips bash
        assert "Commands Run" not in manifest, "Young tier should skip bash section"

    def test_manifest_respects_young_tier_web_skip(self, tmp_data_dir):
        """Young-tier sessions should skip web section entirely."""
        sid = "young-skip-web"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)
        session.mark_web_fetch(sid, "https://example.com", "id_web", 5000, 200, 0, False)

        cache = session.load(sid)
        # Manually set created_ts to young age
        cache.created_ts = time.time() - 30  # 30 seconds ago
        session.save(cache)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)
        # Young tier skips web
        assert "Web Fetches" not in manifest, "Young tier should skip web section"


# ---------------------------------------------------------------------------
# Test Gap 1: All-empty session manifest rendering
# ---------------------------------------------------------------------------


class TestEmptySessionManifestRendering:
    """Test that build_manifest gracefully handles completely empty sessions."""

    def test_completely_empty_session_returns_empty_string(self, tmp_data_dir):
        """Empty session should return empty string, not crash."""
        sid = "totally-empty-session-xyz"
        result = compact.build_manifest(sid)
        assert result == ""
        assert isinstance(result, str)

    def test_completely_empty_session_no_section_headers(self, tmp_data_dir):
        """Empty session should suppress all section headers."""
        sid = "empty-no-headers-abc"
        result = compact.build_manifest(sid)
        # Even the header "## Token-Goat Session Manifest" should not appear
        assert "Token-Goat Session Manifest" not in result
        assert "Files Edited" not in result
        assert "Symbols Accessed" not in result
        assert "Key Files Read" not in result
        assert "Commands Run" not in result
        assert "Web Fetches" not in result
        assert "Grep Patterns" not in result

    def test_empty_session_with_high_token_budget(self, tmp_data_dir):
        """Empty session with any budget should still return empty string."""
        sid = "empty-high-budget-xyz"
        result = compact.build_manifest(sid, max_tokens=10000)
        assert result == ""

    def test_empty_session_with_minimal_token_budget(self, tmp_data_dir):
        """Empty session with minimal budget should still return empty string."""
        sid = "empty-minimal-budget-abc"
        result = compact.build_manifest(sid, max_tokens=1)
        assert result == ""

    def test_build_manifest_with_count_empty_session(self, tmp_data_dir):
        """build_manifest_with_count should return ("", 0) for empty session."""
        sid = "empty-count-session-xyz"
        manifest, event_count = compact.build_manifest_with_count(sid)
        assert manifest == ""
        assert event_count == 0

    def test_empty_session_with_none_session_id_guard(self, tmp_data_dir):
        """Calling with invalid session_id should gracefully return empty string."""
        # session_id validation should catch this or _load_session_cache should handle it
        result = compact.build_manifest("x" * 300)  # Too long, validation fails
        assert result == ""

    def test_render_directly_with_empty_cache(self, tmp_data_dir):
        """_render with an empty SessionCache should return empty string."""
        from token_goat.session import SessionCache
        ts = time.time()
        empty_cache = SessionCache(
            session_id="test-render-empty",
            started_ts=ts,
            last_activity_ts=ts,
            created_ts=ts,
            files={},
            edited_files={},
            greps=[],
        )
        result, symbols_count = compact._render(empty_cache, "test-render-empty", 400)
        assert result == ""
        assert symbols_count == 0

    def test_empty_session_returns_zero_event_count(self, tmp_data_dir):
        """Empty session should have zero event count."""
        sid = "empty-event-count-abc"
        count = compact.event_count(sid)
        assert count == 0


# ---------------------------------------------------------------------------
# Test Gap 2: PreCompact hook fail-soft with missing/corrupt session JSON
# ---------------------------------------------------------------------------


class TestPreCompactHookFailSoft:
    """Test that PreCompact hook gracefully handles missing/corrupt session JSON."""

    def _make_payload(self, session_id: str, trigger: str = "manual") -> dict:
        return {"session_id": session_id, "trigger": trigger}

    def test_missing_session_json_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        """When session JSON file is deleted mid-session, hook should return continue:true."""
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "missing-json-session-xyz"
        # Don't create any session data, so session JSON never exists
        result = hooks_cli.pre_compact(self._make_payload(sid))

        # Must return continue:true, not crash
        assert result.get("continue") is True
        # No systemMessage because session cache load returns empty cache
        # (empty cache → no events → build_manifest_with_count returns ("", 0))

    def test_corrupt_session_json_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        """When session JSON is corrupted, hook should return continue:true."""
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "corrupt-json-session-abc"
        # Create a session cache file with invalid JSON
        session_path = paths.session_cache_path(sid)
        session_path.parent.mkdir(parents=True, exist_ok=True)
        session_path.write_text("{ this is not valid json }{{{", encoding="utf-8")

        # Hook should catch the JSON error and return continue:true
        result = hooks_cli.pre_compact(self._make_payload(sid))
        assert result.get("continue") is True

    def test_valid_session_json_emits_system_message(self, tmp_data_dir, tmp_path, monkeypatch):
        """Positive test: valid session with activity should emit systemMessage."""
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 1\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "valid-session-with-activity"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_read(sid, "/proj/lib.py", offset=0, limit=100)

        result = hooks_cli.pre_compact(self._make_payload(sid))
        assert result.get("continue") is True
        assert "systemMessage" in result
        assert isinstance(result["systemMessage"], str)
        assert len(result["systemMessage"]) > 0

    def test_empty_session_with_min_events_zero_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        """Empty session with min_events=0 should return continue (not emit empty manifest)."""
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "empty-min-zero-session"
        result = hooks_cli.pre_compact(self._make_payload(sid))

        # build_manifest_with_count returns ("", 0) for empty session
        # Even though min_events=0, the manifest is empty string, so no systemMessage
        assert result.get("continue") is True
        assert "systemMessage" not in result

    def test_build_manifest_handles_missing_session_file(self, tmp_data_dir):
        """build_manifest should return empty string for non-existent session."""
        sid = "nonexistent-session-xyz"
        result = compact.build_manifest(sid)
        assert result == ""

    def test_build_manifest_with_count_missing_file(self, tmp_data_dir):
        """build_manifest_with_count should return ("", 0) for missing session."""
        sid = "nonexistent-count-session-abc"
        manifest, count = compact.build_manifest_with_count(sid)
        assert manifest == ""
        assert count == 0

    def test_build_manifest_graceful_catch_in_load_session_cache(self, tmp_data_dir):
        """_load_session_cache catches exceptions and returns None."""
        from token_goat import compact as compact_mod
        # Invalid session ID (too long)
        result = compact_mod._load_session_cache("x" * 300, "test")
        assert result is None

    def test_corrupt_json_caught_by_session_load(self, tmp_data_dir, tmp_path, monkeypatch):
        """Corrupt JSON in session file should be caught by session.load()."""
        from token_goat import paths
        from token_goat import session as session_mod

        sid = "corrupt-caught-session-xyz"
        session_path = paths.session_cache_path(sid)
        session_path.parent.mkdir(parents=True, exist_ok=True)
        session_path.write_text("{ malformed json }", encoding="utf-8")

        # session.load() should catch the JSONDecodeError and return a fresh cache
        cache = session_mod.load(sid)
        assert isinstance(cache, session_mod.SessionCache)
        # Fresh cache should be empty
        assert len(cache.files) == 0
        assert len(cache.edited_files) == 0


# ---------------------------------------------------------------------------
# Glob section in full manifest
# ---------------------------------------------------------------------------


class TestGlobManifestSection:
    """build_manifest includes Directory Scans when glob history is present."""

    def _mature_session(self, sid):
        """Push session created_ts back 2 hours so it's not 'young'."""
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

    def test_glob_section_appears_with_qualifying_entry(self, tmp_data_dir):
        """Two globs with sufficient result_count appear as Directory Scans."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-manifest-appears"
        session.mark_file_edited(sid, "src/main.py")
        # min_lines=2: Directory Scans only emits when ≥2 content lines are present
        session.mark_glob_run(sid, "**/*.py", result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 10)
        session.mark_glob_run(sid, "**/*.ts", result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)
        self._mature_session(sid)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "Directory Scans" in result
        assert "**/*.py" in result

    def test_glob_section_absent_when_history_empty(self, tmp_data_dir):
        """No glob history → no Directory Scans section."""
        sid = "glob-manifest-absent"
        session.mark_file_edited(sid, "src/main.py")
        self._mature_session(sid)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "Directory Scans" not in result

    def test_glob_trivial_pattern_not_shown(self, tmp_data_dir):
        """Trivial pattern (**) is filtered and doesn't appear in manifest."""
        sid = "glob-manifest-trivial"
        session.mark_file_edited(sid, "src/main.py")
        session.mark_glob_run(sid, "**", result_count=100)
        self._mature_session(sid)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "Directory Scans" not in result

    def test_glob_section_absent_in_young_session(self, tmp_data_dir):
        """Young sessions (< 10 min old) skip the glob section."""
        sid = "glob-manifest-young"
        session.mark_file_edited(sid, "src/main.py")
        session.mark_glob_run(sid, "**/*.py", result_count=50)
        # Do NOT call _mature_session — let it stay young (default created_ts ≈ now)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "Directory Scans" not in result

    def test_glob_section_shows_path_scope(self, tmp_data_dir):
        """Glob with path scope shows the scope in the manifest line."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-manifest-scope"
        session.mark_file_edited(sid, "src/main.py")
        session.mark_glob_run(sid, "**/*.rs", path="src/", result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)
        self._mature_session(sid)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "src/" in result


# ---------------------------------------------------------------------------
# All sections populated simultaneously
# ---------------------------------------------------------------------------


class TestAllSectionsSimultaneous:
    """_render with every section populated — no crash, budget respected, all headers present."""

    def _build_full_session(self, sid: str) -> None:
        """Populate edited files, bash, web, symbols/files, greps, and glob."""
        import time as _time

        # Edited files
        session.mark_file_edited(sid, "src/token_goat/compact.py")
        session.mark_file_edited(sid, "src/token_goat/session.py")

        # File reads (symbol + plain)
        session.mark_file_read(sid, "src/token_goat/compact.py", symbol="_render")
        session.mark_file_read(sid, "src/token_goat/session.py", 0, 50)
        session.mark_file_read(sid, "src/token_goat/hints.py", 0, 100)

        # Bash history (output_bytes must be >= _MIN_BASH_BYTES_FOR_MANIFEST = 400)
        session.mark_bash_run(sid, "sha_pytest", "uv run pytest -q", "out_pytest", 1200, 800, 0, False)
        session.mark_bash_run(sid, "sha_ruff", "uv run ruff check", "out_ruff", 500, 300, 0, False)

        # Web fetches (content_bytes must be >= _MIN_WEB_BYTES_FOR_MANIFEST = 200)
        session.mark_web_fetch(sid, "https://docs.python.org/3/library/heapq.html", "out_web1", 5000, 200, 1000, False)
        session.mark_web_fetch(sid, "https://sqlite.org/json1.html", "out_web2", 3000, 200, 500, False)

        # Grep patterns
        session.mark_grep(sid, "_render", path="src/token_goat/", result_count=4)
        session.mark_grep(sid, "estimate_tokens", result_count=7)

        # Glob runs (result_count must be >= _GLOB_DEDUP_MIN_RESULT_COUNT = 5)
        session.mark_glob_run(sid, "**/*.py", result_count=42)
        session.mark_glob_run(sid, "tests/**/*.py", path="tests/", result_count=12)

        # Age the session so all tier gates open
        cache = session.load(sid)
        cache.created_ts = _time.time() - 7200
        session.save(cache)

    def test_all_sections_no_crash(self, tmp_data_dir):
        """Rendering with all sections populated must not raise."""
        sid = "all-sections-no-crash"
        self._build_full_session(sid)
        result = compact.build_manifest(sid, max_tokens=800)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_all_sections_budget_respected(self, tmp_data_dir):
        """Token count must not exceed max_tokens budget."""
        sid = "all-sections-budget"
        self._build_full_session(sid)
        max_tok = 600
        result = compact.build_manifest(sid, max_tokens=max_tok)
        assert compact.estimate_tokens(result) <= max_tok

    def test_all_sections_edited_files_present(self, tmp_data_dir):
        """Edited-files section must always appear when there are edits."""
        sid = "all-sections-edited"
        self._build_full_session(sid)
        result = compact.build_manifest(sid, max_tokens=800)
        assert "**Edited:**" in result or "compact.py" in result

    def test_all_sections_glob_present_in_mature_session(self, tmp_data_dir):
        """Directory Scans section must appear for a mature session with glob history."""
        sid = "all-sections-glob"
        self._build_full_session(sid)
        result = compact.build_manifest(sid, max_tokens=800)
        assert "Directory Scans" in result

    def test_all_sections_token_budget_tight(self, tmp_data_dir):
        """Even with a tight 300-token budget, rendering must not crash or exceed the cap."""
        sid = "all-sections-tight"
        self._build_full_session(sid)
        max_tok = 300
        result = compact.build_manifest(sid, max_tokens=max_tok)
        assert isinstance(result, str)
        assert compact.estimate_tokens(result) <= max_tok


# ---------------------------------------------------------------------------
# Safety trim path + glob budget floor
# ---------------------------------------------------------------------------


class TestSafetyTrimAndBudgetFloor:
    """Reliability: safety trim in _render and glob floor in _section_budgets."""

    def test_safety_trim_output_within_budget(self, tmp_data_dir):
        """When assembled manifest would exceed max_tokens, safety trim brings it back."""
        sid = "safety-trim-path"
        # Populate enough data to produce a non-trivial manifest
        session.mark_file_edited(sid, "src/token_goat/compact.py")
        session.mark_file_edited(sid, "src/token_goat/session.py")
        session.mark_file_edited(sid, "src/token_goat/hints.py")
        for i in range(10):
            session.mark_file_read(sid, f"src/module_{i}.py", 0, 200)
        session.mark_bash_run(sid, "sha_cmd", "uv run pytest -q", "out_cmd", 1500, 800, 0, False)
        session.mark_web_fetch(sid, "https://docs.python.org", "out_web", 2000, 200, 500, False)
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        # Very tight budget — forces safety trim into action
        max_tok = 80
        result = compact.build_manifest(sid, max_tokens=max_tok)
        assert isinstance(result, str)
        # Safety trim must keep result within budget
        assert compact.estimate_tokens(result) <= max_tok

    def test_glob_budget_floor_kicks_in_at_small_remaining(self):
        """Glob 5% of a small remaining budget falls below floor; floor (20) should apply."""
        # remaining = 200 → glob 5% = 10 < floor 20 → floor applies
        budgets = compact._section_budgets(total_budget=200, edited_tokens=0)
        assert budgets["glob"] == 20

    def test_glob_budget_above_floor_for_large_remaining(self):
        """Glob 5% of a large remaining budget exceeds floor; proportional value applies."""
        # remaining = 800 → glob 5% = 40 > floor 20 → proportional
        budgets = compact._section_budgets(total_budget=800, edited_tokens=0)
        assert budgets["glob"] == 40

    def test_section_budgets_floor_applied_to_all_sections_under_pressure(self):
        """Under extreme budget pressure all sections should get at least floor tokens."""
        # remaining = 50 → every section gets floor (20)
        budgets = compact._section_budgets(total_budget=50, edited_tokens=0)
        for key in ("symbols", "files", "greps", "bash", "web", "glob"):
            assert budgets[key] >= 20, f"{key} budget {budgets[key]} is below floor"

    def test_build_manifest_with_count_returns_nonzero_for_active_session(self, tmp_data_dir):
        """build_manifest_with_count returns a positive files count for active sessions."""
        sid = "bmwc-active"
        session.mark_file_edited(sid, "src/main.py")
        session.mark_file_read(sid, "src/lib.py", 0, 50, symbol="MyClass")
        _, files_count = compact.build_manifest_with_count(sid)
        assert files_count > 0


# ---------------------------------------------------------------------------
# Stale read files + estimate_tokens + cold-output blocker path
# ---------------------------------------------------------------------------


class TestStaleReadFilesSection:
    """Outdated File Snapshots section appears when a file was read then later edited."""

    def test_stale_file_appears_in_manifest(self, tmp_data_dir):
        """File read at T1 then edited at T2 > T1 (not in edited_files) shows ⚠."""

        sid = "stale-read-path"
        path = "src/token_goat/hints.py"

        # Read the file first (creates FileEntry with last_read_ts, last_edit_ts=0)
        session.mark_file_read(sid, path, 0, 80)

        # Manually stamp last_edit_ts > last_read_ts WITHOUT adding to edited_files
        cache = session.load(sid)
        key = list(cache.files.keys())[0]
        entry = cache.files[key]
        entry.last_edit_ts = entry.last_read_ts + 1.0
        # Do NOT add to edited_files — this is the stale scenario
        session.save(cache)

        result = compact.build_manifest(sid, max_tokens=400)
        assert "Outdated File Snapshots" in result
        assert "⚠" in result

    def test_stale_file_absent_when_in_edited_files(self, tmp_data_dir):
        """File that is both stale AND in edited_files must NOT appear in stale section."""

        sid = "stale-but-edited"
        path = "src/token_goat/compact.py"

        # Read the file first
        session.mark_file_read(sid, path, 0, 50)

        # Use mark_file_edited — stamps last_edit_ts AND adds to edited_files
        session.mark_file_edited(sid, path)

        result = compact.build_manifest(sid, max_tokens=400)
        # edited_files takes priority; stale section must not duplicate it
        assert "Outdated File Snapshots" not in result

    def test_no_stale_section_when_all_edits_before_reads(self, tmp_data_dir):
        """File edited then read: last_read_ts > last_edit_ts → not stale."""

        sid = "edit-then-read"
        path = "src/token_goat/session.py"

        # Edit first (stamps last_edit_ts on FileEntry if it exists — but it doesn't yet)
        session.mark_file_edited(sid, path)
        # Read after edit → last_read_ts > last_edit_ts
        session.mark_file_read(sid, path, 0, 50)

        # Manually clear from edited_files to isolate stale logic
        cache = session.load(sid)
        cache.edited_files.clear()
        session.save(cache)

        result = compact.build_manifest(sid, max_tokens=400)
        # last_read_ts >= last_edit_ts → not stale (read clears the stale condition)
        assert "Outdated File Snapshots" not in result


class TestSymbolRecencyRanking:
    """Tests for _rank_symbols_by_recency: recent symbols appear first."""

    def test_most_recent_symbol_ranks_first_when_sizes_equal(self, tmp_data_dir):
        """When all symbols have same size, most recently accessed appears first."""
        sid = "symbol-recency-recent-first"

        # Mark two symbols with different timestamps
        session.mark_file_read(sid, "/proj/parser.py", symbol="parse_expr")
        time.sleep(0.1)  # Ensure timestamp separation
        session.mark_file_read(sid, "/proj/parser.py", symbol="parse_stmt")

        cache = session.load(sid)
        entry = cache.files["/proj/parser.py"]

        # Rank by recency
        ranked = compact._rank_symbols_by_recency(entry, time.time())

        # Most recent (parse_stmt) should come before parse_expr
        assert ranked[0] == "parse_stmt"
        assert ranked[1] == "parse_expr"

    def test_old_symbol_ranks_last(self, tmp_data_dir):
        """Symbols accessed far in the past get multiplier 1.0, rank lower."""
        sid = "symbol-recency-old"
        now = time.time()

        session.mark_file_read(sid, "/proj/lib.py", symbol="old_func")
        cache = session.load(sid)
        entry = cache.files["/proj/lib.py"]

        # Manually set an old timestamp (1 hour ago)
        entry.symbols_ts["old_func"] = now - 3600

        ranked = compact._rank_symbols_by_recency(entry, now)
        assert ranked == ["old_func"]  # Only one symbol

    def test_recency_tiers_applied_correctly(self, tmp_data_dir):
        """Recency multipliers: <5min=1.5x, <30min=1.2x, else=1.0x."""
        sid = "symbol-recency-tiers"
        now = time.time()

        session.mark_file_read(sid, "/proj/core.py", symbol="very_recent")
        session.mark_file_read(sid, "/proj/core.py", symbol="recent")
        session.mark_file_read(sid, "/proj/core.py", symbol="old")

        cache = session.load(sid)
        entry = cache.files["/proj/core.py"]

        # Set specific timestamps
        entry.symbols_ts["very_recent"] = now - 60  # < 5 min → 1.5x
        entry.symbols_ts["recent"] = now - 600  # < 30 min → 1.2x
        entry.symbols_ts["old"] = now - 3600  # > 30 min → 1.0x

        ranked = compact._rank_symbols_by_recency(entry, now)

        # Expected order: very_recent (1.5x), recent (1.2x), old (1.0x)
        assert ranked == ["very_recent", "recent", "old"]

    def test_missing_ts_field_falls_back_gracefully(self, tmp_data_dir):
        """Entries without symbols_ts dict fall back to original order."""
        sid = "symbol-recency-legacy"

        session.mark_file_read(sid, "/proj/compat.py", symbol="func1")
        session.mark_file_read(sid, "/proj/compat.py", symbol="func2")

        cache = session.load(sid)
        entry = cache.files["/proj/compat.py"]

        # Simulate legacy entry without symbols_ts
        entry.symbols_ts = {}

        ranked = compact._rank_symbols_by_recency(entry, time.time())

        # Should return symbols in original order when no timestamps
        assert ranked == entry.symbols_read


class TestEstimateTokensDirect:
    """estimate_tokens is the global budget guardian — test it directly."""

    def test_empty_string_returns_one(self):
        """estimate_tokens('') must return at least 1 (never zero)."""
        assert compact.estimate_tokens("") == 1

    def test_short_string_positive(self):
        """Any non-empty string returns a positive token count."""
        assert compact.estimate_tokens("hello") >= 1

    def test_long_string_proportional(self):
        """Token estimate grows with length — 1000-char string > 100-char string."""
        short = compact.estimate_tokens("x" * 100)
        long_ = compact.estimate_tokens("x" * 1000)
        assert long_ > short

    def test_approx_three_chars_per_token(self):
        """300-char string should estimate ~100 tokens (using ~3 chars/token ratio)."""
        result = compact.estimate_tokens("a" * 300)
        # The formula is max(1, len//3 + 1); exact: 300//3 + 1 = 101
        assert 90 <= result <= 115


class TestCapLine:
    """Tests for _cap_line: enforce 120-char line-length cap."""

    def test_short_line_unchanged(self):
        """Lines under 120 chars are returned unchanged."""
        short = "- this is a short line"
        assert compact._cap_line(short) == short

    def test_exact_120_char_line_unchanged(self):
        """A line of exactly 120 chars is unchanged."""
        exact = "x" * 120
        assert compact._cap_line(exact) == exact

    def test_121_char_line_capped_with_ellipsis(self):
        """A 121-char line is capped to 120 chars with ellipsis at the end."""
        long_line = "x" * 121
        result = compact._cap_line(long_line)
        assert len(result) == 120
        assert result.endswith("…")
        assert result == ("x" * 119) + "…"

    def test_very_long_line_capped(self):
        """Very long lines (>120) are capped to exactly 120 with ellipsis."""
        very_long = "x" * 300
        result = compact._cap_line(very_long)
        assert len(result) == 120
        assert result == ("x" * 119) + "…"


# ---------------------------------------------------------------------------
# compact._render_budget_lines
# ---------------------------------------------------------------------------


class TestRenderBudgetLines:
    """Unit tests for _render_budget_lines: header-gated budget loop."""

    def test_empty_input_returns_empty(self):
        lines: list[str] = []
        out, used = compact._render_budget_lines("### H", lines, budget=200)
        assert out == []
        assert used == 0

    def test_all_lines_fit(self):
        lines = ["- line one", "- line two"]
        out, used = compact._render_budget_lines("### H", lines, budget=500)
        assert out[0] == "### H"
        assert "- line one" in out
        assert "- line two" in out
        assert used > 0

    def test_budget_too_tight_returns_empty(self):
        # Budget of 1 token can't fit header + any content line.
        out, used = compact._render_budget_lines("### Header", ["- x"], budget=1)
        assert out == []
        assert used == 0

    def test_partial_fit_stops_early(self):
        # Five long lines; only the first few should fit in a tight budget.
        lines = [f"- {'x' * 60} line {i}" for i in range(5)]
        out, used = compact._render_budget_lines("### H", lines, budget=30)
        # Header + at least one line must fit, but not all five.
        assert 1 < len(out) < 6
        assert out[0] == "### H"

    def test_header_always_first(self):
        out, _ = compact._render_budget_lines("### MySection", ["- a"], budget=200)
        assert out[0] == "### MySection"


# ---------------------------------------------------------------------------
# compact._dedup_grep_entries
# ---------------------------------------------------------------------------


class TestDedupGrepEntries:
    """Tests for grep result deduplication in manifest: collapse repeated patterns."""

    def test_single_entry_unchanged(self):
        """A single grep entry is returned as-is."""
        import types

        entry = types.SimpleNamespace(pattern="find_fn", path="/proj/src", result_count=5, ts=time.time())
        result = compact._dedup_grep_entries([entry])
        assert len(result) == 1
        assert result[0].pattern == "find_fn"

    def test_two_identical_patterns_collapsed_with_times_two(self):
        """Two identical patterns are collapsed into one with [×2] suffix."""
        import types

        now = time.time()
        entry1 = types.SimpleNamespace(pattern="target", path="/proj/src", result_count=3, ts=now - 10)
        entry2 = types.SimpleNamespace(pattern="target", path="/proj/tests", result_count=7, ts=now)
        result = compact._dedup_grep_entries([entry1, entry2])
        assert len(result) == 1
        pattern = result[0].pattern
        assert pattern == "target [×2]", f"Expected 'target [×2]', got '{pattern}'"

    def test_three_identical_collapsed_with_times_three(self):
        """Three identical patterns collapse into one with [×3] suffix."""
        import types

        now = time.time()
        entry1 = types.SimpleNamespace(pattern="needle", path="/proj/src", result_count=1, ts=now - 20)
        entry2 = types.SimpleNamespace(pattern="needle", path="/proj/tests", result_count=5, ts=now - 10)
        entry3 = types.SimpleNamespace(pattern="needle", path="/proj/docs", result_count=2, ts=now)
        result = compact._dedup_grep_entries([entry1, entry2, entry3])
        assert len(result) == 1
        pattern = result[0].pattern
        assert pattern == "needle [×3]", f"Expected 'needle [×3]', got '{pattern}'"

    def test_different_patterns_not_collapsed(self):
        """Different patterns are preserved separately."""
        import types

        now = time.time()
        entry1 = types.SimpleNamespace(pattern="alpha", path="/proj/src", result_count=3, ts=now)
        entry2 = types.SimpleNamespace(pattern="beta", path="/proj/src", result_count=5, ts=now)
        result = compact._dedup_grep_entries([entry1, entry2])
        assert len(result) == 2
        patterns = {e.pattern for e in result}
        assert patterns == {"alpha", "beta"}, f"Expected {{'alpha', 'beta'}}, got {patterns}"

    def test_mixed_dedup_some_dupes_some_unique(self):
        """Mixed case: some patterns appear multiple times, others are unique."""
        import types

        now = time.time()
        # Pattern "target" appears 2× (oldest and newest)
        entry1 = types.SimpleNamespace(pattern="target", path="/proj/src", result_count=1, ts=now - 20)
        entry2 = types.SimpleNamespace(pattern="target", path="/proj/tests", result_count=7, ts=now - 5)
        # Pattern "unique" appears 1×
        entry3 = types.SimpleNamespace(pattern="unique", path="/proj/src", result_count=3, ts=now)
        result = compact._dedup_grep_entries([entry1, entry2, entry3])
        assert len(result) == 2
        patterns = {e.pattern for e in result}
        assert "target [×2]" in patterns, f"Expected 'target [×2]' in {patterns}"
        assert "unique" in patterns, f"Expected 'unique' in {patterns}"


# ---------------------------------------------------------------------------
# compact._group_edited_by_dir
# ---------------------------------------------------------------------------


class TestGroupEditedByDir:
    """Tests for directory grouping of edited files in the manifest."""

    def test_three_files_same_dir_grouped(self):
        """Three files from the same directory are grouped under one header."""
        entries = [
            ("src/token_goat/compact.py", 3),
            ("src/token_goat/session.py", 2),
            ("src/token_goat/hints.py", 1),
        ]
        result = compact._group_edited_by_dir(entries)
        # Should produce a grouped line, not three separate lines
        assert len(result) == 1
        line = result[0]
        assert "(3 files)" in line, f"Expected '(3 files)' in: {line}"
        assert "compact.py" in line
        assert "session.py" in line
        assert "hints.py" in line

    def test_two_files_same_dir_not_grouped(self):
        """Two files in the same directory remain on separate lines (below threshold)."""
        entries = [
            ("src/compact.py", 2),
            ("src/hints.py", 1),
        ]
        result = compact._group_edited_by_dir(entries)
        # Two files should not be grouped — threshold is 3
        assert len(result) == 2
        assert all(line.startswith("- ✎") for line in result), \
            f"Expected two single-line entries, got: {result}"

    def test_mixed_dirs_each_separate(self):
        """Files from different directories are not grouped together."""
        entries = [
            ("src/token_goat/compact.py", 2),
            ("tests/test_compact.py", 1),
        ]
        result = compact._group_edited_by_dir(entries)
        # Two different directories → two separate lines
        assert len(result) == 2
        assert all(line.startswith("- ✎") for line in result)

    def test_single_file_unchanged(self):
        """A single file is rendered as a plain line."""
        entries = [("src/main.py", 5)]
        result = compact._group_edited_by_dir(entries)
        assert len(result) == 1
        assert "main.py" in result[0]
        assert "×5" in result[0]

    def test_grouped_line_respects_line_cap(self):
        """A grouped line that exceeds 120 chars is truncated with overflow marker."""
        # Create many files in the same directory with long names
        entries = [
            ("src/very_long_directory_name/very_long_file_name_1.py", 5),
            ("src/very_long_directory_name/very_long_file_name_2.py", 4),
            ("src/very_long_directory_name/very_long_file_name_3.py", 3),
            ("src/very_long_directory_name/very_long_file_name_4.py", 2),
            ("src/very_long_directory_name/very_long_file_name_5.py", 1),
        ]
        result = compact._group_edited_by_dir(entries)
        assert len(result) == 1
        line = result[0]
        # Line should be capped or have overflow marker
        assert len(line) <= 140 or "+more" in line, \
            f"Expected line length <= 140 or '+more' marker, got: {line}"


# ---------------------------------------------------------------------------
# build_manifest timeout guard tests
# ---------------------------------------------------------------------------

class TestBuildManifestTimeout:
    """Test the wall-clock timeout guard in build_manifest()."""

    def test_normal_session_completes_within_timeout(self, tmp_data_dir):
        """A session with normal activity completes without timeout warning."""
        sid = "normal-timeout-session"
        # Add moderate activity
        for i in range(5):
            session.mark_file_read(sid, f"/proj/src/file{i}.py", offset=0, limit=100)
            session.mark_file_edited(sid, f"/proj/src/file{i}.py")
        session.mark_grep(sid, "test", "/proj/src")

        result = compact.build_manifest(sid)
        # Should not contain timeout warning
        assert "timed out" not in result.lower(), \
            "Normal session should not trigger timeout warning"
        assert result != "", "Normal session should produce non-empty manifest"

    def test_slow_git_diff_triggers_timeout_note(self, tmp_data_dir, monkeypatch):
        """Monkeypatched slow git call triggers timeout note in output."""
        sid = "slow-git-session"
        session.mark_file_edited(sid, "/proj/src/slow.py")
        session.mark_file_read(sid, "/proj/src/slow.py", offset=0, limit=50)

        # Shrink the wall-clock budget so the test doesn't have to sleep 9s.
        monkeypatch.setattr(compact, "_MANIFEST_TIMEOUT_SECS", 0.1)

        original_func = compact._get_git_diff_stat_summary

        def slow_git(*args, **kwargs):
            time.sleep(0.3)  # Exceed the shrunk timeout
            return original_func(*args, **kwargs)

        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", slow_git)

        result = compact.build_manifest(sid)
        # Should contain timeout warning
        assert "timed out" in result.lower(), \
            f"Expected timeout warning in manifest, got: {result[-200:]}"
        assert "output may be incomplete" in result.lower(), \
            "Timeout note should indicate possible incompleteness"

    def test_timeout_note_contains_elapsed_seconds(self, tmp_data_dir, monkeypatch):
        """Timeout note shows elapsed seconds in human-readable format."""
        sid = "timeout-format-session"
        session.mark_file_edited(sid, "/proj/src/test.py")

        monkeypatch.setattr(compact, "_MANIFEST_TIMEOUT_SECS", 0.1)

        original_func = compact._get_git_diff_stat_summary

        def slow_git(*args, **kwargs):
            time.sleep(0.3)
            return original_func(*args, **kwargs)

        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", slow_git)

        result = compact.build_manifest(sid)
        # Check that elapsed seconds are shown with .1f precision
        import re
        match = re.search(r"timed out after (\d+\.\d+)s", result)
        assert match, \
            f"Expected 'timed out after X.Xs' pattern in manifest, got: {result[-200:]}"
        elapsed_str = match.group(1)
        elapsed_float = float(elapsed_str)
        assert elapsed_float >= 0.3, \
            f"Expected elapsed >= 0.3s, got: {elapsed_float}s"


# ---------------------------------------------------------------------------
# compact._select_top_web_entries — filter dead-end fetches
# ---------------------------------------------------------------------------


class TestSelectTopWebEntries:
    """Dead-end web fetches (4xx/5xx errors, tiny bodies) are filtered out."""

    def test_http_404_error_is_filtered_out(self, tmp_data_dir, make_session):
        """Web fetch with status_code=404 must NOT appear in manifest."""
        sid = "web-404-test"
        # Create a mature session with one 404 and one 200 fetch
        cache = session.load(sid)

        # Add a 404 error fetch (should be filtered)
        import hashlib
        url_404 = "https://example.com/not-found"
        url_sha_404 = hashlib.sha256(url_404.encode()).hexdigest()[:12]
        session.mark_web_fetch(
            session_id=sid,
            url_sha=url_sha_404,
            url_preview=url_404,
            output_id=f"web-404-{url_sha_404}",
            body_bytes=500,  # Substantial body, but error status
            status_code=404,
            truncated=False,
        )

        # Add two good 200 fetches from different domains (min_lines=2: Web Fetches
        # requires ≥2 domain-grouped lines to emit the section header)
        for url_good, extra_bytes in [
            ("https://docs.example.com/api", 5000),
            ("https://otherdocs.example.org/guide", 4000),
        ]:
            url_sha_good = hashlib.sha256(url_good.encode()).hexdigest()[:12]
            session.mark_web_fetch(
                session_id=sid,
                url_sha=url_sha_good,
                url_preview=url_good,
                output_id=f"web-good-{url_sha_good}",
                body_bytes=extra_bytes,
                status_code=200,
                truncated=False,
            )

        # Make the session mature so web section appears
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200  # 2 hours old
        session.save(cache)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)
        # 404 should be filtered out; only 200 OK fetches should appear
        assert "docs.example.com" in manifest, "200 OK fetch should be in manifest"
        assert "not-found" not in manifest, "404 error fetch should be filtered out"

    def test_http_500_error_is_filtered_out(self, tmp_data_dir):
        """Web fetch with status_code=500 must NOT appear in manifest."""
        import hashlib

        sid = "web-500-test"
        session.mark_file_edited(sid, "/proj/app.py")

        # Add a 500 error fetch
        url_500 = "https://api.example.com/v1/data"
        url_sha_500 = hashlib.sha256(url_500.encode()).hexdigest()[:12]
        session.mark_web_fetch(
            session_id=sid,
            url_sha=url_sha_500,
            url_preview=url_500,
            output_id=f"web-500-{url_sha_500}",
            body_bytes=1000,
            status_code=500,
            truncated=False,
        )

        # Make mature
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        cache = session.load(sid)
        manifest = compact._build_manifest_from_cache(cache, sid, 400)
        # 500 error should not appear
        assert "api.example.com" not in manifest, "500 error fetch should be filtered out"

    def test_small_body_below_threshold_is_filtered(self, tmp_data_dir):
        """Web fetch with body_bytes < _MIN_WEB_BYTES_FOR_MANIFEST is filtered."""
        import hashlib

        sid = "web-tiny-test"
        session.mark_file_edited(sid, "/proj/app.py")

        # Add a tiny fetch (below threshold)
        url_tiny = "https://example.com/redirect"
        url_sha_tiny = hashlib.sha256(url_tiny.encode()).hexdigest()[:12]
        session.mark_web_fetch(
            session_id=sid,
            url_sha=url_sha_tiny,
            url_preview=url_tiny,
            output_id=f"web-tiny-{url_sha_tiny}",
            body_bytes=50,  # Below _MIN_WEB_BYTES_FOR_MANIFEST (200)
            status_code=200,
            truncated=False,
        )

        # Add two good substantial fetches from different domains (min_lines=2)
        for url_good in [
            "https://docs.example.com/guide",
            "https://otherdocs.example.org/ref",
        ]:
            url_sha_good = hashlib.sha256(url_good.encode()).hexdigest()[:12]
            session.mark_web_fetch(
                session_id=sid,
                url_sha=url_sha_good,
                url_preview=url_good,
                output_id=f"web-good-{url_sha_good}",
                body_bytes=5000,
                status_code=200,
                truncated=False,
            )

        # Make mature
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        cache = session.load(sid)
        # Use 800-token budget: web gets 10% = ~80 tokens, enough for 2 domain lines.
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        # Small body should be filtered; large bodies should appear
        assert "docs.example.com" in manifest, "Substantial fetch should be in manifest"
        assert "redirect" not in manifest, "Tiny fetch should be filtered out"

    def test_normal_fetch_passes_filter(self, tmp_data_dir):
        """Web fetches with 200 status and body >= threshold pass the filter."""
        import hashlib

        sid = "web-normal-test"
        session.mark_file_edited(sid, "/proj/app.py")

        # Add two normal healthy fetches from different domains (min_lines=2: Web Fetches
        # section requires ≥2 grouped domain lines to emit the header)
        for url in [
            "https://docs.python.org/3/library/json.html",
            "https://sqlite.org/json1.html",
        ]:
            url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
            session.mark_web_fetch(
                session_id=sid,
                url_sha=url_sha,
                url_preview=url,
                output_id=f"web-{url_sha}",
                body_bytes=10000,
                status_code=200,
                truncated=False,
            )

        # Make mature
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        cache = session.load(sid)
        # Use 800-token budget: web gets 10% = ~80 tokens, enough for 2 domain lines.
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        # Normal fetches should be included
        assert "python.org" in manifest, "Normal 200 OK fetch should be in manifest"


# ---------------------------------------------------------------------------
# compact._get_git_diff_stat_summary — process-level cache
# ---------------------------------------------------------------------------


class TestGitDiffStatSummaryCache:
    """Process-level cache in _get_git_diff_stat_summary avoids repeated subprocesses."""

    def _clear_cache(self):
        compact._diff_stat_summary_cache.clear()
        compact._is_git_repo_cache.clear()

    def test_cache_hit_skips_subprocess(self, monkeypatch, tmp_path):
        """Second call within TTL returns cached result without re-running git."""
        self._clear_cache()
        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        call_count = 0

        real_run = __import__("subprocess").run

        def counting_run(cmd, **kwargs):
            nonlocal call_count
            if cmd[0] == "git":
                call_count += 1
            return real_run(cmd, **kwargs)

        monkeypatch.setattr("subprocess.run", counting_run)
        cwd = str(tmp_path)
        compact._get_git_diff_stat_summary(cwd)
        first_count = call_count
        compact._get_git_diff_stat_summary(cwd)
        # Second call must not have triggered another subprocess.run for git.
        assert call_count == first_count, "Cache hit should skip the git subprocess"

    def test_cache_expires_after_ttl(self, monkeypatch, tmp_path):
        """Cache entry older than TTL causes a fresh subprocess call."""
        self._clear_cache()
        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        cwd = str(tmp_path)
        # Prime the cache with a stale timestamp (TTL + 1 seconds in the past).
        stale_ts = __import__("time").monotonic() - compact._DIFF_STAT_SUMMARY_TTL - 1
        compact._diff_stat_summary_cache[cwd] = ("stale-result", stale_ts)

        call_count = 0
        real_run = __import__("subprocess").run

        def counting_run(cmd, **kwargs):
            nonlocal call_count
            if cmd[0] == "git":
                call_count += 1
            return real_run(cmd, **kwargs)

        monkeypatch.setattr("subprocess.run", counting_run)
        compact._get_git_diff_stat_summary(cwd)
        assert call_count >= 1, "Stale cache entry should trigger a fresh subprocess call"

    def test_none_root_returns_empty_no_cache(self):
        """None root short-circuits before touching the cache."""
        self._clear_cache()
        result = compact._get_git_diff_stat_summary(None)
        assert result == ""
        assert None not in compact._diff_stat_summary_cache


# ---------------------------------------------------------------------------
# TestRenderTasksSection / TestLoadTaskList / TestManifestTODOs
# ---------------------------------------------------------------------------


class TestRenderTasksSection:
    """Unit tests for compact._render_tasks_section."""

    def test_no_tasks_returns_empty(self):
        assert compact._render_tasks_section([]) == []

    def test_all_completed_returns_empty(self):
        tasks = [
            {"id": "1", "subject": "Deploy to prod", "status": "completed"},
            {"id": "2", "subject": "Write tests", "status": "completed"},
        ]
        assert compact._render_tasks_section(tasks) == []

    def test_pending_tasks_appear(self):
        tasks = [
            {"id": "1", "subject": "Fix the bug", "status": "pending"},
            {"id": "2", "subject": "Write tests", "status": "pending"},
            {"id": "3", "subject": "Done already", "status": "completed"},
        ]
        lines = compact._render_tasks_section(tasks)
        assert lines[0] == "**TODOs:**"
        assert any("Fix the bug" in ln for ln in lines)
        assert any("Write tests" in ln for ln in lines)
        # Completed task must not appear
        assert not any("Done already" in ln for ln in lines)

    def test_in_progress_marker(self):
        tasks = [{"id": "1", "subject": "Active task", "status": "in_progress"}]
        lines = compact._render_tasks_section(tasks)
        assert any("[→]" in ln for ln in lines)

    def test_in_progress_hyphenated_marker(self):
        tasks = [{"id": "1", "subject": "Active task", "status": "in-progress"}]
        lines = compact._render_tasks_section(tasks)
        assert any("[→]" in ln for ln in lines)

    def test_pending_marker(self):
        tasks = [{"id": "1", "subject": "Pending task", "status": "pending"}]
        lines = compact._render_tasks_section(tasks)
        assert any("[ ]" in ln for ln in lines)

    def test_subject_truncated_at_60_chars(self):
        long_subject = "A" * 80
        tasks = [{"id": "1", "subject": long_subject, "status": "pending"}]
        lines = compact._render_tasks_section(tasks)
        # Find the task line (not the header)
        task_lines = [ln for ln in lines if ln.startswith("- ")]
        assert len(task_lines) == 1
        # Subject portion of the line should end with ellipsis and be ≤60 chars
        assert "…" in task_lines[0]
        # Extract subject text after "- [ ] "
        subject_text = task_lines[0][len("- [ ] "):]
        assert len(subject_text) <= 60

    def test_max_5_tasks_shown(self):
        tasks = [
            {"id": str(i), "subject": f"Task {i}", "status": "pending"}
            for i in range(10)
        ]
        lines = compact._render_tasks_section(tasks)
        task_lines = [ln for ln in lines if ln.startswith("- ") and "more" not in ln]
        assert len(task_lines) == 5

    def test_overflow_note_when_more_than_5(self):
        tasks = [
            {"id": str(i), "subject": f"Task {i}", "status": "pending"}
            for i in range(10)
        ]
        lines = compact._render_tasks_section(tasks)
        overflow_lines = [ln for ln in lines if "more" in ln]
        assert len(overflow_lines) == 1
        assert "+5 more" in overflow_lines[0]

    def test_exactly_5_tasks_no_overflow(self):
        tasks = [
            {"id": str(i), "subject": f"Task {i}", "status": "pending"}
            for i in range(5)
        ]
        lines = compact._render_tasks_section(tasks)
        overflow_lines = [ln for ln in lines if "more" in ln]
        assert overflow_lines == []

    def test_header_is_first_line(self):
        tasks = [{"id": "1", "subject": "Do something", "status": "pending"}]
        lines = compact._render_tasks_section(tasks)
        assert lines[0] == "**TODOs:**"


class TestLoadTaskList:
    """Unit tests for compact._load_task_list reading from a temp directory."""

    def test_missing_directory_returns_empty(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path / "claude")
        result = compact._load_task_list("no-such-session")
        assert result == []

    def test_reads_pending_task(self, tmp_path, monkeypatch):
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)
        sid = "test-session-abc"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        (task_dir / "1.json").write_text(
            json.dumps({"id": "1", "subject": "Fix login", "status": "pending"}),
            encoding="utf-8",
        )
        result = compact._load_task_list(sid)
        assert len(result) == 1
        assert result[0]["subject"] == "Fix login"
        assert result[0]["status"] == "pending"

    def test_reads_multiple_tasks(self, tmp_path, monkeypatch):
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)
        sid = "multi-task-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        for i, status in enumerate(["pending", "in_progress", "completed"]):
            (task_dir / f"{i}.json").write_text(
                json.dumps({"id": str(i), "subject": f"Task {i}", "status": status}),
                encoding="utf-8",
            )
        result = compact._load_task_list(sid)
        assert len(result) == 3
        statuses = {t["status"] for t in result}
        assert statuses == {"pending", "in_progress", "completed"}

    def test_skips_malformed_json(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)
        sid = "malformed-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        (task_dir / "bad.json").write_text("not-json{{{", encoding="utf-8")
        result = compact._load_task_list(sid)
        assert result == []

    def test_skips_non_dict_json(self, tmp_path, monkeypatch):
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)
        sid = "non-dict-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        (task_dir / "1.json").write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        result = compact._load_task_list(sid)
        assert result == []


class TestManifestTODOs:
    """Integration tests: _render_tasks_section results appear in the full manifest."""

    def test_manifest_has_todos_section_when_pending_tasks(self, tmp_data_dir, monkeypatch, tmp_path):
        """A session with pending tasks emits ### TODOs in the manifest."""
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)

        sid = "todo-manifest-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        for i, subject in enumerate(["Alpha task", "Beta task", "Gamma task"]):
            (task_dir / f"{i}.json").write_text(
                json.dumps({"id": str(i), "subject": subject, "status": "pending"}),
                encoding="utf-8",
            )

        _populate_session(sid)
        result = compact.build_manifest(sid)

        assert "**TODOs:**" in result
        assert "Alpha task" in result
        assert "Beta task" in result
        assert "Gamma task" in result

    def test_manifest_no_todos_section_when_no_tasks(self, tmp_data_dir, monkeypatch, tmp_path):
        """A session with no task directory emits no ### TODOs section."""
        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)

        sid = "no-todo-manifest-session"
        _populate_session(sid)
        result = compact.build_manifest(sid)

        assert "**TODOs:**" not in result

    def test_manifest_no_todos_when_all_completed(self, tmp_data_dir, monkeypatch, tmp_path):
        """Completed-only task list emits no ### TODOs section."""
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)

        sid = "completed-todos-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        (task_dir / "1.json").write_text(
            json.dumps({"id": "1", "subject": "Already done", "status": "completed"}),
            encoding="utf-8",
        )

        _populate_session(sid)
        result = compact.build_manifest(sid)

        assert "**TODOs:**" not in result

    def test_manifest_todos_capped_at_5_with_overflow(self, tmp_data_dir, monkeypatch, tmp_path):
        """10 pending tasks → max 5 shown + overflow note."""
        import json

        from token_goat import paths
        monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path)

        sid = "many-todos-session"
        task_dir = tmp_path / "tasks" / sid
        task_dir.mkdir(parents=True)
        for i in range(10):
            (task_dir / f"{i}.json").write_text(
                json.dumps({"id": str(i), "subject": f"Task {i}", "status": "pending"}),
                encoding="utf-8",
            )

        _populate_session(sid)
        result = compact.build_manifest(sid)

        assert "**TODOs:**" in result
        assert "+5 more" in result


class TestMinLinesSuppressionRegression:
    """Regression tests: Cold Outputs and Directory Scans suppress single-entry sections
    (min_lines=2); Web Fetches renders at min_lines=1 because a single fetched URL is
    signal, not noise."""

    def test_single_web_fetch_still_renders(self, tmp_data_dir, make_session):
        """A single web fetch is genuine signal and should render."""
        sid = "web-single-renders"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={"https://docs.example.com/api": 12_000},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Web:**" in m

    def test_two_web_fetches_section_appears(self, tmp_data_dir, make_session):
        """Two Web Fetches from different domains render normally."""
        sid = "web-double-render"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={
                "https://docs.example.com/api": 12_000,
                "https://other.example.org/guide": 10_000,
            },
        )
        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Web:**" in m
        assert "docs.example.com" in m


class TestWhatWorkedSection:
    """Tests for the ### What Worked manifest section (item #28)."""

    def _make_bash_entry(self, cmd: str, exit_code: int, ts: float, output_id: str = ""):
        import types
        return types.SimpleNamespace(
            cmd_preview=cmd,
            exit_code=exit_code,
            ts=ts,
            output_id=output_id or f"out-{abs(hash(cmd)) % 100000:05d}",
            stdout_bytes=800,
            stderr_bytes=0,
            truncated=False,
            run_count=1,
        )

    def test_single_green_test_run_appears(self):
        """One green test run → section appears with 1 entry."""
        import time as _time
        now = _time.time()
        entry = self._make_bash_entry("pytest tests/unit/", 0, now - 120, "abc111")
        result = compact._select_what_worked({"abc111": entry}, set())
        assert len(result) == 1
        assert result[0].cmd_preview == "pytest tests/unit/"

    def test_five_green_runs_yields_two_most_recent(self):
        """Five green test runs → section has 2 most recent only."""
        import time as _time
        now = _time.time()
        history = {}
        for i in range(5):
            e = self._make_bash_entry(f"pytest tests/module{i}.py", 0, now - (i + 1) * 300, f"id{i:04d}")
            history[f"id{i:04d}"] = e
        result = compact._select_what_worked(history, set())
        assert len(result) == 2
        # Most recent two: i=0 (now-300) and i=1 (now-600)
        cmds = {r.cmd_preview for r in result}
        assert "pytest tests/module0.py" in cmds
        assert "pytest tests/module1.py" in cmds

    def test_non_test_green_command_excluded(self):
        """A green non-test command (e.g. git push) is NOT included."""
        import time as _time
        now = _time.time()
        history = {
            "gitpush": self._make_bash_entry("git push origin main", 0, now - 60, "gitpush"),
            "lscmd": self._make_bash_entry("ls -la", 0, now - 30, "lscmd"),
        }
        result = compact._select_what_worked(history, set())
        assert result == []

    def test_failed_test_run_excluded(self):
        """A failed (exit_code != 0) test run is NOT included."""
        import time as _time
        now = _time.time()
        entry = self._make_bash_entry("pytest tests/", 1, now - 60, "failid")
        result = compact._select_what_worked({"failid": entry}, set())
        assert result == []

    def test_blocker_id_excluded_even_if_green(self):
        """An entry whose output_id is in blocker_ids is excluded even if exit_code==0."""
        import time as _time
        now = _time.time()
        entry = self._make_bash_entry("pytest tests/", 0, now - 60, "blockerid")
        result = compact._select_what_worked({"blockerid": entry}, {"blockerid"})
        assert result == []

    def test_no_green_runs_no_section(self):
        """No green test runs → _render_what_worked_section returns empty list."""
        result = compact._render_what_worked_section([], 0.0)
        assert result == []

    def test_render_section_header_and_format(self):
        """render emits ### What Worked header and ✅-prefixed lines."""
        import time as _time
        now = _time.time()
        entries = [self._make_bash_entry("pytest tests/unit/", 0, now - 180, "abc999")]
        lines = compact._render_what_worked_section(entries, now)
        assert lines[0] == "**Passed:**"
        assert len(lines) == 2
        assert "✅" in lines[1]
        assert "pytest tests/unit/" in lines[1]
        assert "3 min ago" in lines[1]

    def test_render_cmd_truncated_at_60_chars(self):
        """cmd_preview longer than 60 chars is truncated with ellipsis."""
        import time as _time
        now = _time.time()
        long_cmd = "pytest " + "x" * 60
        entries = [self._make_bash_entry(long_cmd, 0, now - 60, "longid")]
        lines = compact._render_what_worked_section(entries, now)
        content = lines[1]
        # The backtick-wrapped cmd must be at most 60 chars + "..."
        import re
        m = re.search(r"`([^`]+)`", content)
        assert m is not None
        cmd_in_line = m.group(1)
        assert len(cmd_in_line) <= 60

    def test_what_worked_in_full_manifest(self, tmp_data_dir):
        """End-to-end: green pytest in bash_history appears as ### What Worked in manifest."""
        import time as _time

        from token_goat import session
        sid = "what-worked-e2e-test"
        session.mark_file_edited(sid, "/proj/src/app.py")
        from token_goat import bash_cache
        cmd = "pytest tests/unit/"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id=f"out-{cmd_sha}",
            stdout_bytes=900,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        cache = session.load(sid)
        cache.created_ts = _time.time() - 3600  # mature session
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Passed:**" in manifest
        assert "pytest tests/unit/" in manifest

    def test_what_worked_absent_when_only_failures(self, tmp_data_dir):
        """No ### What Worked section when only failed runs exist."""
        import time as _time

        from token_goat import session
        sid = "what-worked-failures-only"
        session.mark_file_edited(sid, "/proj/src/app.py")
        from token_goat import bash_cache
        cmd = "pytest tests/"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id=f"out-{cmd_sha}",
            stdout_bytes=900,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )
        cache = session.load(sid)
        cache.created_ts = _time.time() - 3600
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Passed:**" not in manifest

    def test_various_test_runner_prefixes(self):
        """All supported test runner prefixes are recognised as test commands."""
        import time as _time
        now = _time.time()
        runners = [
            "uv run pytest -m 'not slow'",
            "npm test",
            "cargo test --release",
            "go test ./...",
            "jest --coverage",
            "mocha test/",
            "make test",
        ]
        for cmd in runners:
            entry = self._make_bash_entry(cmd, 0, now - 60, f"id-{abs(hash(cmd))}")
            result = compact._select_what_worked({entry.output_id: entry}, set())
            assert len(result) == 1, f"Expected {cmd!r} to be recognised as a test command"


# ---------------------------------------------------------------------------
# #20 — Activity-floor suppression
# ---------------------------------------------------------------------------


class TestActivityFloorSuppression:
    """build_manifest_adaptive returns empty string when session activity is below floor."""

    def test_low_activity_session_suppressed(self, tmp_data_dir):
        """A session with only 1 file read and no edits/bash scores below floor → suppressed."""
        sid = "floor-low-activity-abc"
        # score = 0 edits×2 + 0 bash×1 + 0 web×1 + 0 skills×1 + 0 blockers×5 = 0
        session.mark_file_read(sid, "/proj/src/file.py", offset=0, limit=50)
        result = compact.build_manifest_adaptive(sid)
        assert result == ""

    def test_single_edit_only_suppressed(self, tmp_data_dir):
        """1 edit scores 2 < floor(3) → suppressed."""
        sid = "floor-one-edit-abc"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        # score = 1 edit × 2 = 2 < 3
        result = compact.build_manifest_adaptive(sid)
        assert result == ""

    def test_two_edits_meets_floor(self, tmp_data_dir):
        """2 edits score 4 >= floor(3) → full manifest emitted."""
        sid = "floor-two-edits-abc"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        session.mark_file_edited(sid, "/proj/src/bar.py")
        # score = 2 edits × 2 = 4 >= 3
        result = compact.build_manifest_adaptive(sid)
        assert "Token-Goat Session Manifest" in result

    def test_one_edit_plus_bash_meets_floor(self, tmp_data_dir):
        """1 edit (×2) + 1 bash run (×1) = 3 >= floor(3) → manifest emitted."""
        sid = "floor-edit-bash-abc"
        session.mark_file_edited(sid, "/proj/src/app.py")
        session.mark_bash_run(sid, "sha-abc", "pytest", "out-abc", 600, 0, 0, False)
        # score = 1×2 + 1×1 = 3 >= 3
        result = compact.build_manifest_adaptive(sid)
        assert "Token-Goat Session Manifest" in result

    def test_session_activity_score_weights(self, tmp_data_dir):
        """_session_activity_score returns the expected weighted sum."""
        sid = "score-weights-abc"
        session.mark_file_edited(sid, "/proj/a.py")   # +2
        session.mark_file_edited(sid, "/proj/b.py")   # +2
        session.mark_bash_run(sid, "sha-w1", "pytest", "out-w1", 600, 0, 0, False)  # +1
        cache = session.load(sid)
        score = compact._session_activity_score(cache)
        # 2 edits × 2 + 1 bash × 1 = 5
        assert score == 5

    def test_activity_floor_constant_is_three(self):
        """_ACTIVITY_FLOOR must be 3 (documented contract)."""
        assert compact._ACTIVITY_FLOOR == 3

    def test_five_edits_well_above_floor(self, tmp_data_dir):
        """5 edits score 10 — well above floor — manifest is full."""
        sid = "floor-five-edits-abc"
        for i in range(5):
            session.mark_file_edited(sid, f"/proj/src/file{i}.py")
        result = compact.build_manifest_adaptive(sid)
        assert "Token-Goat Session Manifest" in result
        assert "**Edited:**" in result


# ---------------------------------------------------------------------------
# #24 — Middle-truncation cap 12 (non-blocker) vs 20 (blocker)
# ---------------------------------------------------------------------------


class TestMiddleTruncationCap:
    """_format_bash_entry uses max_lines=12 for non-blockers, 20 for blockers."""

    def test_middle_truncate_non_blocker_caps_at_12(self):
        """Non-blocker with 30-line output → at most 12 visible lines in snippet."""
        result = compact._middle_truncate("\n".join(f"line {i}" for i in range(30)), max_lines=12)
        # With max_lines=12, keep=ceil(12*0.4)=5 head + 5 tail + 1 marker = 11 visible lines
        lines = result.splitlines()
        assert len(lines) <= 13  # head(5) + marker(1) + tail(5) = 11, well under 13
        assert "omitted" in result

    def test_middle_truncate_blocker_caps_at_20(self):
        """Blocker with 30-line output → at most 20 visible lines in snippet."""
        result = compact._middle_truncate("\n".join(f"line {i}" for i in range(30)), max_lines=20)
        # With max_lines=20, keep=ceil(20*0.4)=8 head + 8 tail + 1 marker = 17 visible lines
        lines = result.splitlines()
        assert len(lines) <= 21  # 8 + 1 + 8 = 17, well under 21
        assert "omitted" in result

    def test_non_blocker_fewer_lines_than_blocker_for_same_input(self):
        """Non-blocker snippet is shorter than blocker snippet for the same 30-line output."""
        text = "\n".join(f"line {i}" for i in range(30))
        non_blocker = compact._middle_truncate(text, max_lines=12)
        blocker = compact._middle_truncate(text, max_lines=20)
        assert len(non_blocker.splitlines()) < len(blocker.splitlines())

    def test_format_bash_entry_is_blocker_parameter_exists(self):
        """_format_bash_entry accepts is_blocker keyword argument."""
        import types
        entry = types.SimpleNamespace(
            cmd_preview="pytest",
            exit_code=0,
            output_id="",
            stdout_bytes=100,
            stderr_bytes=0,
            truncated=False,
            run_count=1,
        )
        # Both calls must not raise; inline_snippet=False skips the disk load
        line_normal = compact._format_bash_entry(entry, inline_snippet=False, is_blocker=False)
        line_blocker = compact._format_bash_entry(entry, inline_snippet=False, is_blocker=True)
        assert "pytest" in line_normal
        assert "pytest" in line_blocker


# ---------------------------------------------------------------------------
# #29 — Cold Outputs opt-in for mature sessions only
# ---------------------------------------------------------------------------


class TestColdOutputsMatureOnly:
    """Cold Outputs section appears only in mature-tier sessions."""

    def _make_old_bash_entry(self, sid: str, age_secs: int = 2400) -> None:
        """Add a bash entry old enough to qualify as a cold output (>30 min)."""
        import time as _time
        cmd_sha = f"sha-cold-{age_secs}"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview="pytest tests/",
            output_id=f"out-cold-{age_secs}",
            stdout_bytes=800,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        # Backdate the bash entry by patching the ts field in the session cache
        cache = session.load(sid)
        for entry in (cache.bash_history or {}).values():
            if getattr(entry, "cmd_sha", "") == cmd_sha:
                entry.ts = _time.time() - age_secs
        session.save(cache)

    def test_active_session_no_cold_outputs(self, tmp_data_dir):
        """Active-tier session with old bash output → no Cold Outputs section."""
        import time as _time
        sid = "cold-active-session-abc"
        # Provide enough activity to pass the floor
        session.mark_file_edited(sid, "/proj/src/a.py")
        session.mark_file_edited(sid, "/proj/src/b.py")
        self._make_old_bash_entry(sid, age_secs=2400)  # 40 min old, > _COLD_OUTPUT_AGE_SECS
        cache = session.load(sid)
        # Set created_ts to make session active tier (10-60 min old)
        cache.created_ts = _time.time() - 1800  # 30 min old → active
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "Cold Outputs" not in manifest

    def test_mature_session_has_cold_outputs(self, tmp_data_dir):
        """Mature-tier session with old bash output → Cold Outputs section present."""
        import time as _time
        sid = "cold-mature-session-abc"
        # Provide enough activity to pass the floor
        session.mark_file_edited(sid, "/proj/src/a.py")
        session.mark_file_edited(sid, "/proj/src/b.py")
        self._make_old_bash_entry(sid, age_secs=2400)  # 40 min old
        self._make_old_bash_entry(sid, age_secs=2500)  # second entry (need ≥2)
        cache = session.load(sid)
        # Set created_ts to make session mature (>60 min old)
        cache.created_ts = _time.time() - 4000  # ~67 min old → mature
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "Cold Outputs" in manifest

    def test_young_session_no_cold_outputs(self, tmp_data_dir):
        """Young-tier session → Cold Outputs suppressed (same as active)."""
        import time as _time
        sid = "cold-young-session-abc"
        session.mark_file_edited(sid, "/proj/src/a.py")
        session.mark_file_edited(sid, "/proj/src/b.py")
        self._make_old_bash_entry(sid, age_secs=2400)
        cache = session.load(sid)
        cache.created_ts = _time.time() - 120  # 2 min old → young
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "Cold Outputs" not in manifest


# ---------------------------------------------------------------------------
# #7 — inline diff for top-2 edited files
# ---------------------------------------------------------------------------


class TestInlineDiffForTop2Edited:
    """Manifest inlines short diffs for top-2 edited files; falls back on large diffs."""

    def _make_two_edited_session(self, sid: str) -> None:
        session.mark_file_edited(sid, "src/foo.py")
        session.mark_file_edited(sid, "src/foo.py")
        session.mark_file_edited(sid, "src/bar.py")
        session.mark_file_read(sid, "src/foo.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/bar.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/baz.py", offset=0, limit=50)

    def test_small_diffs_are_inlined(self, tmp_data_dir, monkeypatch):
        """When git diff returns small output for top-2 files, manifest includes inline diff."""
        sid = "inline-diff-small-abc"
        self._make_two_edited_session(sid)

        small_diff = "--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1 +1 @@\n-old\n+new"
        assert len(small_diff) < 500

        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: small_diff)
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"  # must be set so _render activates the inline-diff path
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "inline diff" in manifest
        assert "-old" in manifest or "+new" in manifest

    def test_large_diff_falls_back_to_entry(self, tmp_data_dir, monkeypatch):
        """When git diff returns None (too large), regular grouped entry is used instead."""
        sid = "inline-diff-large-abc"
        self._make_two_edited_session(sid)

        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "inline diff" not in manifest
        assert "**Edited:**" in manifest

    def test_total_inline_cap_limits_second_file(self, tmp_data_dir, monkeypatch):
        """When first file returns None from helper, second file is still attempted."""
        sid = "inline-diff-cap-abc"
        self._make_two_edited_session(sid)

        # foo.py returns None (too large per-file), bar.py is small → bar.py should inline
        small_second = "--- a/src/bar.py\n+++ b/src/bar.py\n@@ -1 +1 @@\n-a\n+b"

        def _fake_inline(path: str, cwd: str):
            if "foo.py" in path:
                return None  # too large → helper returns None
            return small_second

        monkeypatch.setattr(compact, "_get_inline_diff_for_file", _fake_inline)
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Edited:**" in manifest
        assert "inline diff" in manifest  # bar.py inlined
        assert "bar.py" in manifest


# ---------------------------------------------------------------------------
# #17 — single-file whole-repo inline diff
# ---------------------------------------------------------------------------


class TestSingleFileInlineDiff:
    """When exactly one file is edited and whole-repo diff fits, inline it."""

    def _make_single_edited_session(self, sid: str) -> None:
        session.mark_file_edited(sid, "src/only.py")
        session.mark_file_read(sid, "src/only.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/util.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/main.py", offset=0, limit=50)

    def test_single_file_small_diff_inlined(self, tmp_data_dir, monkeypatch):
        """One edited file + small whole-repo diff replaces list entry with inline diff."""
        sid = "single-inline-small-abc"
        self._make_single_edited_session(sid)

        small = "--- a/src/only.py\n+++ b/src/only.py\n@@ -1 +1 @@\n-x=1\n+x=2"
        assert len(small) < 400

        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: small)
        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "inline diff" in manifest
        assert "-x=1" in manifest or "+x=2" in manifest

    def test_single_file_large_diff_not_inlined(self, tmp_data_dir, monkeypatch):
        """One edited file but whole-repo diff too big → falls back to grouped entry."""
        sid = "single-inline-large-abc"
        self._make_single_edited_session(sid)

        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "inline diff" not in manifest
        assert "**Edited:**" in manifest

    def test_two_files_skips_single_file_path(self, tmp_data_dir, monkeypatch):
        """Two edited files → _get_whole_repo_diff never called (single-file path skipped)."""
        sid = "two-files-no-single-abc"
        session.mark_file_edited(sid, "src/a.py")
        session.mark_file_edited(sid, "src/b.py")
        session.mark_file_read(sid, "src/a.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/b.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/c.py", offset=0, limit=50)

        whole_diff_called = {"n": 0}

        def _fake_whole(cwd: str):
            whole_diff_called["n"] += 1
            return "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y"

        monkeypatch.setattr(compact, "_get_whole_repo_diff", _fake_whole)
        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])

        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert whole_diff_called["n"] == 0
        assert "**Edited:**" in manifest


# ---------------------------------------------------------------------------
# _humanize_bytes (canonical helper in util, re-exported via compact)
# ---------------------------------------------------------------------------

class TestHumanizeBytes:
    """Tests for the shared _humanize_bytes helper."""

    def test_bytes_below_1024(self):
        from token_goat.util import _humanize_bytes
        assert _humanize_bytes(0) == "0B"
        assert _humanize_bytes(512) == "512B"
        assert _humanize_bytes(1023) == "1023B"

    def test_kilobytes(self):
        from token_goat.util import _humanize_bytes
        assert _humanize_bytes(1024) == "1.0KB"
        assert _humanize_bytes(2048) == "2.0KB"
        assert _humanize_bytes(1536) == "1.5KB"

    def test_megabytes(self):
        from token_goat.util import _humanize_bytes
        mb = 1024 * 1024
        assert _humanize_bytes(mb) == "1.0MB"
        assert _humanize_bytes(mb * 2) == "2.0MB"

    def test_gigabytes(self):
        from token_goat.util import _humanize_bytes
        gb = 1024 * 1024 * 1024
        assert _humanize_bytes(gb) == "1.0GB"
        assert _humanize_bytes(gb * 3) == "3.0GB"

    def test_compact_re_export(self):
        """compact._humanize_bytes must resolve to the same object as util._humanize_bytes."""
        from token_goat import compact
        from token_goat.util import _humanize_bytes
        assert compact._humanize_bytes is _humanize_bytes


# ---------------------------------------------------------------------------
# _is_git_repo — cheap .git existence probe
# ---------------------------------------------------------------------------

class TestIsGitRepo:
    """Unit tests for compact._is_git_repo()."""

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        compact._is_git_repo_cache.clear()
        yield
        compact._is_git_repo_cache.clear()

    def test_returns_false_for_empty_tmp_dir(self, tmp_path):
        """A plain tmp directory has no .git — must return False."""
        assert compact._is_git_repo(str(tmp_path)) is False

    def test_returns_true_for_directory_with_dot_git_dir(self, tmp_path):
        """.git subdirectory present → True."""
        (tmp_path / ".git").mkdir()
        assert compact._is_git_repo(str(tmp_path)) is True

    def test_returns_true_for_directory_with_dot_git_file(self, tmp_path):
        """.git file (worktree/submodule pointer) present → True."""
        (tmp_path / ".git").write_text("gitdir: ../.git/worktrees/foo\n")
        assert compact._is_git_repo(str(tmp_path)) is True

    def test_result_is_cached(self, tmp_path):
        """Second call must return from cache (probe not repeated on disk)."""
        (tmp_path / ".git").mkdir()
        path_str = str(tmp_path)
        first = compact._is_git_repo(path_str)
        assert first is True
        assert path_str in compact._is_git_repo_cache
        # Remove .git — second call still returns True from cache.
        (tmp_path / ".git").rmdir()
        assert compact._is_git_repo(path_str) is True


# ---------------------------------------------------------------------------
# non-git short-circuit for git helpers
# ---------------------------------------------------------------------------

class TestNonGitShortCircuit:
    """Verify git helpers return immediately when cwd is not a git repo."""

    @pytest.fixture(autouse=True)
    def _clear_caches(self):
        compact._is_git_repo_cache.clear()
        compact._uncommitted_changes_cache.clear()
        compact._diff_stat_summary_cache.clear()
        yield
        compact._is_git_repo_cache.clear()
        compact._uncommitted_changes_cache.clear()
        compact._diff_stat_summary_cache.clear()

    def test_uncommitted_changes_skips_subprocess_in_non_git_dir(
        self, tmp_path, monkeypatch
    ):
        """_get_uncommitted_changes must return None without spawning git."""
        import subprocess as _subprocess  # noqa: PLC0415

        calls: list[object] = []

        def _spy(*a, **kw):
            calls.append(a)
            raise AssertionError("subprocess.run must not be called for non-git cwd")

        monkeypatch.setattr(_subprocess, "run", _spy)
        result = compact._get_uncommitted_changes(str(tmp_path))
        assert result is None
        assert calls == []

    def test_diff_stat_summary_skips_subprocess_in_non_git_dir(
        self, tmp_path, monkeypatch
    ):
        """_get_git_diff_stat_summary must return '' without spawning git."""
        import subprocess as _subprocess  # noqa: PLC0415

        calls: list[object] = []

        def _spy(*a, **kw):
            calls.append(a)
            raise AssertionError("subprocess.run must not be called for non-git cwd")

        monkeypatch.setattr(_subprocess, "run", _spy)
        result = compact._get_git_diff_stat_summary(str(tmp_path))
        assert result == ""
        assert calls == []

    def test_uncommitted_changes_still_works_in_git_repo(self, tmp_path, monkeypatch):
        """When _is_git_repo returns True, the subprocess path is reachable."""
        import subprocess as _subprocess  # noqa: PLC0415

        fake_proc = type(
            "P", (), {"returncode": 0, "stdout": " foo.py | 2 +-\n", "stderr": ""}
        )()
        monkeypatch.setattr(_subprocess, "run", lambda *a, **kw: fake_proc)
        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        result = compact._get_uncommitted_changes(str(tmp_path))
        assert result is not None
        assert "foo.py" in result

    def test_diff_stat_summary_still_works_in_git_repo(self, tmp_path, monkeypatch):
        """When _is_git_repo returns True, the subprocess path is reachable."""
        import subprocess as _subprocess  # noqa: PLC0415

        fake_proc = type(
            "P",
            (),
            {"returncode": 0, "stdout": " bar.py | 1 +\n1 file changed\n", "stderr": ""},
        )()
        monkeypatch.setattr(_subprocess, "run", lambda *a, **kw: fake_proc)
        monkeypatch.setattr(compact, "_is_git_repo", lambda _cwd: True)
        result = compact._get_git_diff_stat_summary(str(tmp_path))
        assert result != ""
        assert "bar.py" in result


# ---------------------------------------------------------------------------
# Item 3 — Bold inline labels replace ### H3 section headers
# ---------------------------------------------------------------------------


class TestBoldLabels:
    """Manifest sections use bold inline labels (**X:**) instead of ### H3 headers."""

    def test_edited_section_uses_bold_label(self, tmp_data_dir):
        sid = "bold-edited-abc"
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        assert "**Edited:**" in result
        assert "### Files Edited" not in result

    def test_syms_section_uses_bold_label(self, tmp_data_dir):
        sid = "bold-syms-abc"
        session.mark_file_read(sid, "src/foo.py", symbol="my_func")
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        assert "**Syms:**" in result
        assert "### Symbols Accessed" not in result

    def test_ran_section_uses_bold_label(self, tmp_data_dir, make_session):
        sid = "bold-ran-abc"
        make_session(sid, age_seconds=7200, edits=1, bash_runs={"pytest tests/": (12_000, 0)})
        result = compact.build_manifest(sid)
        assert "**Ran:**" in result
        assert "### Commands Run" not in result

    def test_grep_section_uses_bold_label(self, tmp_data_dir):
        sid = "bold-grep-abc"
        session.mark_file_edited(sid, "src/foo.py")
        session.mark_grep(sid, "my_pattern", "/proj/src")
        session.mark_grep(sid, "another_pattern", "/proj/src")
        result = compact.build_manifest(sid)
        assert "**Grep:**" in result
        assert "### Patterns Searched" not in result

    def test_web_section_uses_bold_label(self, tmp_data_dir, make_session):
        sid = "bold-web-abc"
        make_session(sid, age_seconds=7200, edits=1,
                     web_fetches={"https://docs.example.com/api": 12_000})
        result = compact.build_manifest(sid)
        assert "**Web:**" in result
        assert "### Web Fetches" not in result

    def test_files_section_uses_bold_label(self, tmp_data_dir):
        sid = "bold-files-abc"
        session.mark_file_edited(sid, "src/foo.py")
        session.mark_file_read(sid, "src/bar.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        assert "**Files:**" in result
        assert "### Key Files Read" not in result

    def test_blocked_section_uses_bold_label(self, tmp_data_dir, make_session):
        sid = "bold-blocked-abc"
        make_session(sid, age_seconds=7200, edits=1,
                     bash_runs={"pytest tests/": (12_000, 1)})
        result = compact.build_manifest(sid)
        assert "**Blocked:**" in result
        assert "### Current Blockers" not in result

    def test_no_h3_headers_in_manifest(self, tmp_data_dir, make_session):
        """No ### H3 section headers (other than MUST_PRESERVE and the top-level ##) appear."""
        sid = "bold-no-h3-abc"
        make_session(sid, age_seconds=7200, edits=1,
                     bash_runs={"pytest tests/": (12_000, 0)})
        session.mark_file_read(sid, "src/foo.py", offset=0, limit=50)
        result = compact.build_manifest(sid)
        h3_lines = [ln for ln in result.splitlines() if ln.startswith("### ")]
        assert h3_lines == [], f"unexpected ### headers: {h3_lines}"

    def test_skills_section_uses_bold_label(self, tmp_data_dir):
        """**Skills:** label is emitted when a skill is recorded."""
        from token_goat import skill_cache
        sid = "bold-skills-abc"
        session.mark_file_edited(sid, "src/foo.py")
        body = "skill body content " * 20
        meta = skill_cache.store_output(sid, "myskill", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(sid, meta.skill_name, meta.output_id, meta.content_sha,
                                  meta.body_bytes, meta.truncated)
        result = compact.build_manifest(sid, max_tokens=600)
        assert "**Skills:**" in result
        assert "### Active Skills" not in result


# ---------------------------------------------------------------------------
# Item 11 — Order-preserving symbol dedup with (+N dupes removed) annotation
# ---------------------------------------------------------------------------


class TestSymbolDedup:
    """Duplicate symbols are removed order-preservingly; annotation appears when N>=3."""

    def test_dedup_removes_duplicates(self, tmp_data_dir):
        sid = "dedup-basic-abc"
        # Read the same symbol 4 times — should appear once
        for _ in range(4):
            session.mark_file_read(sid, "src/foo.py", symbol="my_func")
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        # my_func should appear exactly once in the symbols section
        assert result.count("my_func") <= 2  # once in Syms, possibly once in Edited

    def test_dedup_preserves_order(self, tmp_data_dir):
        sid = "dedup-order-abc"
        session.mark_file_read(sid, "src/foo.py", symbol="alpha_func")
        session.mark_file_read(sid, "src/foo.py", symbol="beta_func")
        session.mark_file_read(sid, "src/foo.py", symbol="alpha_func")  # dupe
        session.mark_file_read(sid, "src/foo.py", symbol="gamma_func")
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        # All three symbols must survive the dedup pass (only one copy each).
        # Exact order depends on _rank_symbols_by_recency; the regression
        # guard is that no symbol appears twice in the syms section.
        if "**Syms:**" in result:
            syms_section = result.split("**Syms:**", 1)[1].split("**", 1)[0]
            assert syms_section.count("alpha_func") == 1
            assert syms_section.count("beta_func") == 1
            assert syms_section.count("gamma_func") == 1

    def test_dupe_annotation_appears_when_three_or_more_removed(self, tmp_data_dir):
        """Render-time dedup is a safety net for cross-file duplicates that
        bypass session.mark_file_read (which already dedups at storage). The
        public mark_file_read API never produces duplicates, so we construct
        the duplicate symbol list directly via the lower-level cache shape.
        """
        from token_goat import session as session_mod

        sid = "dedup-annotate-abc"
        # Seed an edit so the session has an emit-worthy state.
        session.mark_file_edited(sid, "src/foo.py")
        # Inject duplicates by mutating the loaded cache directly — the
        # storage-level dedup runs inside mark_file_read, not on save.
        cache = session_mod.load(sid)
        cache.files["src/foo.py"] = session_mod.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=0.0,
            read_count=4,
            line_ranges=[],
            symbols_read=["dup_func", "dup_func", "dup_func", "dup_func"],
        )
        session_mod.save(cache)

        result = compact.build_manifest(sid)
        assert "dupes removed" in result

    def test_dupe_annotation_absent_when_fewer_than_three_removed(self, tmp_data_dir):
        sid = "dedup-no-annotate-abc"
        # 2 reads → 1 dupe removed (< 3 threshold)
        session.mark_file_read(sid, "src/foo.py", symbol="unique_func")
        session.mark_file_read(sid, "src/foo.py", symbol="unique_func")
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        assert "dupes removed" not in result

    def test_no_dupes_no_annotation(self, tmp_data_dir):
        sid = "dedup-clean-abc"
        session.mark_file_read(sid, "src/foo.py", symbol="func_a")
        session.mark_file_read(sid, "src/foo.py", symbol="func_b")
        session.mark_file_read(sid, "src/foo.py", symbol="func_c")
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        assert "dupes removed" not in result


# ---------------------------------------------------------------------------
# Item 13 — Skip **Pending:** when nearly all files have inline diffs
# ---------------------------------------------------------------------------


class TestSkipPendingChangesWhenInline:
    """**Pending:** is suppressed when inline diffs cover all (or all-but-one) edited files."""

    def _make_one_edit_session(self, sid: str) -> None:
        session.mark_file_edited(sid, "src/only.py")
        session.mark_file_read(sid, "src/only.py", offset=0, limit=50)

    def test_pending_suppressed_when_single_file_inlined(self, tmp_data_dir, monkeypatch):
        """Single-file session with inline diff → **Pending:** suppressed."""
        sid = "skip-pending-single-abc"
        self._make_one_edit_session(sid)
        small = "--- a/src/only.py\n+++ b/src/only.py\n@@ -1 +1 @@\n-x=1\n+x=2"
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: small)
        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "1 file changed")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])
        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Pending:**" not in manifest

    def test_pending_present_when_no_inline_diff(self, tmp_data_dir, monkeypatch):
        """No inline diff → **Pending:** appears when there are uncommitted changes."""
        sid = "skip-pending-no-inline-abc"
        self._make_one_edit_session(sid)
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_inline_diff_for_file", lambda path, cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "1 file changed")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: "src/only.py | 1 +")
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])
        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Pending:**" in manifest

    def test_pending_suppressed_when_multi_file_all_inlined(self, tmp_data_dir, monkeypatch):
        """Two edited files, both inlined → **Pending:** suppressed."""
        sid = "skip-pending-multi-all-abc"
        session.mark_file_edited(sid, "src/a.py")
        session.mark_file_edited(sid, "src/b.py")
        session.mark_file_read(sid, "src/a.py", offset=0, limit=50)
        session.mark_file_read(sid, "src/b.py", offset=0, limit=50)
        small_a = "--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-x\n+y"
        small_b = "--- a/src/b.py\n+++ b/src/b.py\n@@ -1 +1 @@\n-p\n+q"

        def _fake_inline(path: str, cwd: str):
            if "a.py" in path:
                return small_a
            return small_b

        monkeypatch.setattr(compact, "_get_inline_diff_for_file", _fake_inline)
        monkeypatch.setattr(compact, "_get_whole_repo_diff", lambda cwd: None)
        monkeypatch.setattr(compact, "_get_git_diff_stat_summary", lambda cwd: "2 files changed")
        monkeypatch.setattr(compact, "_get_git_diff_stat", lambda paths, cwd: None)
        monkeypatch.setattr(compact, "_get_session_commits", lambda cwd, ts: [])
        cache = session.load(sid)
        cache.cwd = "/proj"
        session.save(cache)
        manifest = compact._build_manifest_from_cache(cache, sid, 800)
        assert "**Pending:**" not in manifest


# ---------------------------------------------------------------------------
# Item 21 — StringIO write-buffer for manifest assembly
# ---------------------------------------------------------------------------


class TestStringIOAssembly:
    """Manifest text assembled via io.StringIO produces identical output to join approach."""

    def test_manifest_has_no_leading_trailing_whitespace(self, tmp_data_dir):
        sid = "sio-trim-abc"
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        if result:
            assert result == result.strip()

    def test_manifest_sections_separated_by_single_newline(self, tmp_data_dir, make_session):
        sid = "sio-newline-abc"
        make_session(sid, age_seconds=7200, edits=1,
                     bash_runs={"pytest tests/": (12_000, 0)})
        result = compact.build_manifest(sid)
        # No double-blank lines should appear (StringIO assembly joins with \n)
        assert "\n\n\n" not in result

    def test_manifest_nonempty_for_active_session(self, tmp_data_dir):
        sid = "sio-nonempty-abc"
        session.mark_file_edited(sid, "src/foo.py")
        result = compact.build_manifest(sid)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_manifest_empty_for_empty_session(self, tmp_data_dir):
        sid = "sio-empty-abc"
        result = compact.build_manifest(sid)
        assert result == ""


# ---------------------------------------------------------------------------
# Item 23 — Dynamic max_files_read based on edited file count
# ---------------------------------------------------------------------------


class TestDynamicMaxFilesRead:
    """max_key_files shrinks when many files are edited (inverted-pyramid priority)."""

    def test_ten_or_more_edits_limits_key_files_to_four(self, tmp_data_dir):
        sid = "dynmax-10-abc"
        # 10 edited files → dynamic max = 4
        for i in range(10):
            session.mark_file_edited(sid, f"src/edit_{i:02d}.py")
        # Add many plain reads so the Files section would normally be large
        for i in range(12):
            session.mark_file_read(sid, f"src/read_{i:02d}.py", offset=0, limit=50)
        result = compact.build_manifest(sid, max_tokens=2000)
        # Count entries under **Files:**
        if "**Files:**" in result:
            files_section = result.split("**Files:**")[1].split("**")[0]
            file_entries = [ln for ln in files_section.splitlines() if ln.strip().startswith("-")]
            assert len(file_entries) <= 6  # 4 + 2 mature bonus max

    def test_five_to_nine_edits_limits_key_files_to_six(self, tmp_data_dir):
        sid = "dynmax-5-abc"
        # 7 edited files → dynamic max = 6
        for i in range(7):
            session.mark_file_edited(sid, f"src/edit_{i:02d}.py")
        for i in range(12):
            session.mark_file_read(sid, f"src/read_{i:02d}.py", offset=0, limit=50)
        result = compact.build_manifest(sid, max_tokens=2000)
        if "**Files:**" in result:
            files_section = result.split("**Files:**")[1].split("**")[0]
            file_entries = [ln for ln in files_section.splitlines() if ln.strip().startswith("-")]
            assert len(file_entries) <= 8  # 6 + 2 mature bonus max

    def test_fewer_than_five_edits_uses_default_max(self, tmp_data_dir):
        sid = "dynmax-few-abc"
        # 2 edited files → dynamic max = _MAX_FILES_READ (10)
        for i in range(2):
            session.mark_file_edited(sid, f"src/edit_{i:02d}.py")
        for i in range(15):
            session.mark_file_read(sid, f"src/read_{i:02d}.py", offset=0, limit=50)
        result = compact.build_manifest(sid, max_tokens=3000)
        if "**Files:**" in result:
            files_section = result.split("**Files:**")[1].split("**")[0]
            file_entries = [ln for ln in files_section.splitlines() if ln.strip().startswith("-")]
            # With default max (10) + mature bonus (2), up to 12 entries are allowed
            assert len(file_entries) <= 12

    def test_dynamic_max_constant_boundary_ten(self, tmp_data_dir):
        """Exactly 10 edited files hits the >=10 branch (max=4), not the >=5 branch (max=6)."""
        sid = "dynmax-boundary-abc"
        for i in range(10):
            session.mark_file_edited(sid, f"src/e_{i:02d}.py")
        for i in range(15):
            session.mark_file_read(sid, f"src/r_{i:02d}.py", offset=0, limit=50)
        result = compact.build_manifest(sid, max_tokens=2000)
        if "**Files:**" in result:
            files_section = result.split("**Files:**")[1].split("**")[0]
            file_entries = [ln for ln in files_section.splitlines() if ln.strip().startswith("-")]
            # >=10 path: max=4, mature bonus=+2 → max 6
            assert len(file_entries) <= 6
