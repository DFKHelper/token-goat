"""Tests for compaction assist: manifest generation, config, and pre_compact hook."""
from __future__ import annotations

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
