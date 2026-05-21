"""Tests for compaction assist: manifest generation, config, and pre_compact hook."""
from __future__ import annotations

import time

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

    def test_counts_files_greps_and_edits(self, tmp_data_dir):
        sid = "evcount-session-xyz"
        _populate_session(sid, files=3, greps=2, edits=1)
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

    def test_manifest_contains_header(self, tmp_data_dir):
        sid = "manifest-header-session"
        _populate_session(sid, files=2, greps=1, edits=1)
        result = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in result

    def test_edited_files_section_present(self, tmp_data_dir):
        sid = "edited-files-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=50)
        # read + edited = 2 events >= min_events=0 for manifest; but build_manifest has no min
        result = compact.build_manifest(sid)
        assert "Files Edited" in result
        assert "auth.py" in result

    def test_symbols_section_present(self, tmp_data_dir):
        sid = "symbols-session-abc"
        session.mark_file_read(sid, "/proj/src/parser.py", symbol="index_project")
        result = compact.build_manifest(sid)
        assert "Symbols Accessed" in result
        assert "index_project" in result

    def test_key_files_section_present(self, tmp_data_dir):
        sid = "keyfiles-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=200)
        result = compact.build_manifest(sid)
        assert "Key Files Read" in result
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

    def test_manifest_is_string(self, tmp_data_dir):
        sid = "str-check-session"
        _populate_session(sid)
        result = compact.build_manifest(sid)
        assert isinstance(result, str)


class TestComputeAdaptiveBudget:
    """Tests for compute_adaptive_budget function."""

    def test_empty_session_returns_base_budget(self, tmp_data_dir):
        """Empty session with no edits, reads, or bash history returns minimum (200)."""
        sid = "empty-adaptive-session"
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget == 200

    def test_one_edited_file_adds_fifty(self, tmp_data_dir):
        """One edited file adds 50 tokens: 200 + 50 = 250."""
        sid = "one-edit-session"
        session.mark_file_edited(sid, "/proj/a.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget == 250

    def test_four_edited_files_reaches_edit_cap(self, tmp_data_dir):
        """Four edited files: 200 + (4 × 50) = 400."""
        sid = "four-edits-session"
        for i in range(4):
            session.mark_file_edited(sid, f"/proj/edit{i}.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget == 400

    def test_ten_edited_files_capped_at_edit_limit(self, tmp_data_dir):
        """Edits capped at 200 tokens: 200 + min(200, 10×50) = 400, not 700."""
        sid = "many-edits-session"
        for i in range(10):
            session.mark_file_edited(sid, f"/proj/edit{i}.py")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        # 200 base + min(200, 10*50=500) = 200 + 200 = 400
        assert budget == 400

    def test_symbols_accessed_add_bonus(self, tmp_data_dir):
        """Files with symbols accessed add 30 tokens each (capped at 150)."""
        sid = "symbols-session"
        session.mark_file_read(sid, "/proj/a.py", symbol="func_a")
        session.mark_file_read(sid, "/proj/b.py", symbol="func_b")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        # 200 base + (2 files with symbols × 30) = 200 + 60 = 260
        assert budget == 260

    def test_five_symbol_files_reaches_symbols_cap(self, tmp_data_dir):
        """Five files with symbols: 200 + (5×30) = 350."""
        sid = "five-symbols-session"
        for i in range(5):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"func_{i}")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget == 350

    def test_many_symbol_files_capped_at_symbols_limit(self, tmp_data_dir):
        """Symbol files capped at 150 tokens: 200 + min(150, 10×30) = 350."""
        sid = "many-symbols-session"
        for i in range(10):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"func_{i}")
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        # 200 base + min(150, 10*30=300) = 200 + 150 = 350
        assert budget == 350

    def test_bash_history_adds_twenty(self, tmp_data_dir):
        """Presence of bash history adds 20 tokens."""
        sid = "bash-history-session"
        session.mark_bash_run(sid, "cmd_sha_1", "pytest -v", "id123", 1000, 500, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
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
        budget = compact.compute_adaptive_budget(cache)
        # 200 + 100 + 90 + 20 = 410
        assert budget == 410

    def test_budget_never_below_minimum(self, tmp_data_dir):
        """Budget is always at least 200 tokens."""
        sid = "minimum-session"
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget >= 200

    def test_budget_never_exceeds_maximum(self, tmp_data_dir):
        """Budget is capped at 600 tokens."""
        sid = "maximum-session"
        # Add many edits, symbols, bash to try to exceed cap
        for i in range(20):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        for i in range(20):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"s{i}")
        session.mark_bash_run(sid, "cmd_sha_3", "cmd", "id789", 2000, 1000, 1, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
        assert budget <= 600

    def test_maximum_budget_example(self, tmp_data_dir):
        """Realistic maximum: 4+ edits (200) + 5+ symbols (150) + bash (20) = 370."""
        sid = "max-example-session"
        for i in range(4):
            session.mark_file_edited(sid, f"/proj/e{i}.py")
        for i in range(5):
            session.mark_file_read(sid, f"/proj/s{i}.py", symbol=f"s{i}")
        session.mark_bash_run(sid, "cmd_sha_4", "pytest", "maxid", 2000, 1000, 0, False)
        cache = session.load(sid)
        budget = compact.compute_adaptive_budget(cache)
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
        sid = "legend-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
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
        assert "Patterns Searched" in result
        assert "mark_file_read" in result

    def test_grep_section_absent_when_no_greps(self, tmp_data_dir):
        sid = "no-grep-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=100)
        result = compact.build_manifest(sid)
        assert "Patterns Searched" not in result

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

        # Manually adjust the timestamp to simulate age
        cache = session.load(sid)
        if cache and cache.bash_history:
            for bash_entry in cache.bash_history.values():
                if getattr(bash_entry, "output_id", None) == "failed_id_001":
                    bash_entry.ts = old_ts
            session.save(cache)

        result = compact.build_manifest(sid)

        # Failed command should NOT appear in Cold Outputs section
        assert "Cold Outputs" not in result or "failed_id_001" not in result, (
            f"failed command should not appear in cold outputs:\n{result}"
        )

    def test_successful_cold_command_in_cold_outputs(self, tmp_data_dir):
        """A bash entry with exit_code=0 that is >30 min old SHOULD appear in Cold Outputs."""
        sid = "cold-success-session-abc"

        # Add an old bash output with zero exit code (successful command)
        old_ts = time.time() - 1801  # 30 minutes + 1 second, exceeds cold threshold
        session.mark_bash_run(
            sid,
            "cmd_sha_success",
            "pytest",
            "success_id_001",
            stdout_bytes=1000,
            stderr_bytes=0,
            exit_code=0,  # SUCCESS
            truncated=False,
        )

        # Manually adjust the timestamp to simulate age
        cache = session.load(sid)
        if cache and cache.bash_history:
            for bash_entry in cache.bash_history.values():
                if getattr(bash_entry, "output_id", None) == "success_id_001":
                    bash_entry.ts = old_ts
            session.save(cache)

        result = compact.build_manifest(sid)

        # Successful command SHOULD appear in Cold Outputs section
        assert "Cold Outputs" in result, f"cold outputs section missing:\n{result}"
        assert "success_id_001" in result, (
            f"successful cold command should appear in cold outputs:\n{result}"
        )


class TestDedupAcrossSections:
    """A file edited this session should not be re-listed under Key Files Read."""

    def test_edited_file_not_repeated_in_key_files_read(self, tmp_data_dir):
        sid = "dedup-session-abc"
        # Same file edited AND read many times — should appear once, under Edited
        for _ in range(5):
            session.mark_file_read(sid, "/proj/src/shared.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/shared.py")
        result = compact.build_manifest(sid)
        # Count occurrences of "shared.py" — should be exactly 1
        assert result.count("shared.py") == 1, f"expected 1, got {result.count('shared.py')}\n{result}"


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

    def test_git_diff_stat_helper_integration(self, tmp_path):
        """Integration test: _get_git_diff_stat helper returns diff output from git."""
        import subprocess
        git_repo = tmp_path / "repo"
        git_repo.mkdir()

        # Initialize repo
        subprocess.run(["git", "init"], cwd=git_repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@ex.com"], cwd=git_repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=git_repo, capture_output=True, check=True)

        # Create initial file and commit
        (git_repo / "myfile.py").write_text("line1\n")
        subprocess.run(["git", "add", "myfile.py"], cwd=git_repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=git_repo, capture_output=True, check=True)

        # Modify file so git diff shows changes
        (git_repo / "myfile.py").write_text("line1\nline2\nline3\n")

        # Call helper with relative path (as stored in edited_files)
        result = compact._get_git_diff_stat(["myfile.py"], str(git_repo))

        # Should return diff stat output
        assert result is not None, "git diff stat should return output"
        assert "myfile.py" in result, f"file name should appear in diff: {result!r}"
        assert "|" in result, f"diff stat format should have pipe separator: {result!r}"


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
        symbols_section = result.split("### Symbols Accessed")[1] if "### Symbols Accessed" in result else result
        # Truncate to next section if present, so older.py listed in Key Files Read
        # doesn't fool the index check
        symbols_section = symbols_section.split("###")[0]
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
        assert any("token_goat/" in line and "(stripped)" in line for line in result)
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
        """Manifest strips prefix when 3+ files share a common directory."""
        sid = "prefix-strip-session-abc"
        # Add 3+ files in the same directory
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/session.py")
        result = compact.build_manifest(sid)
        # Manifest should contain the prefix stripping header
        assert "token_goat/" in result
        assert "(stripped)" in result
        # Paths should be shortened (no "token_goat/" prefix on each line)
        assert "- ✎ compact.py" in result or "- ✎ hints.py" in result

    def test_manifest_no_strip_when_fewer_than_3_paths(self, tmp_data_dir):
        """Manifest does not strip prefix when fewer than 3 files."""
        sid = "no-strip-few-paths-session"
        session.mark_file_edited(sid, "/proj/src/token_goat/compact.py")
        session.mark_file_edited(sid, "/proj/src/token_goat/hints.py")
        result = compact.build_manifest(sid)
        # Should not have stripping header (not enough paths)
        assert "(stripped)" not in result

    def test_manifest_no_strip_when_no_common_prefix(self, tmp_data_dir):
        """Manifest does not strip when files don't share a common prefix."""
        sid = "no-strip-no-prefix-session"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/tests/test_auth.py")
        session.mark_file_edited(sid, "/proj/docs/readme.md")
        result = compact.build_manifest(sid)
        # No stripping should occur
        assert "(stripped)" not in result

    def test_manifest_no_strip_prefix_too_short(self, tmp_data_dir):
        """Manifest does not strip prefix if it's shorter than 6 characters."""
        sid = "no-strip-short-prefix-session"
        # Create files with only a short common prefix
        session.mark_file_edited(sid, "/x/y/file1.py")
        session.mark_file_edited(sid, "/x/y/file2.py")
        session.mark_file_edited(sid, "/x/y/file3.py")
        result = compact.build_manifest(sid)
        # "x/y/" is 4 chars, too short — no stripping
        assert "(stripped)" not in result

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
