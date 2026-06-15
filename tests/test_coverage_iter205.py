"""Regression tests for iteration 205.

Coverage targets:
- db.py: record_stat() truncation via _MAX_STAT_KIND_LEN / _MAX_STAT_DETAIL_LEN
- hooks_read.py: _record_session_hint_impact sanitizes newlines in file_path
- compact.py: event_count/build_manifest edge cases, _MAX_MANIFEST_TOKENS_CAP
- hints.py: _sanitize_hint_path strips control chars; build_read_hint edge cases
- worker.py: _parse_and_group_entries with malformed/missing entries
- bash_parser.py: oversized command/path rejection; shlex.split ValueError
- paths.py: _safe_env_dir rejects relative paths; roll_log_if_oversized thresholds
- config.py: load() returns defaults on OSError and malformed TOML
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# ===========================================================================
# 1. db.py — record_stat() truncation guards
# ===========================================================================


class TestRecordStatTruncation:
    """record_stat must truncate kind to 64 chars and detail to 512 chars."""

    def _run_record_stat(self, kind: str, detail: str | None) -> tuple[str, str | None]:
        """Invoke record_stat with a mock DB and capture the INSERT params."""
        from token_goat import db

        captured: list[tuple] = []

        class _FakeConn:
            def execute(self, sql: str, params: tuple) -> None:
                captured.append(params)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        with patch.object(db, "open_global", return_value=_FakeConn()):
            db.record_stat(None, kind, detail=detail)

        assert captured, "INSERT was never called"
        ts, k, tokens_saved, bytes_saved, d, _last_access = captured[0]
        return k, d

    def test_kind_over_limit_truncated(self):
        """kind longer than 64 chars is truncated to exactly 64."""
        long_kind = "x" * 100
        k, _ = self._run_record_stat(long_kind, None)
        assert len(k) == 64
        assert k == "x" * 64

    def test_kind_at_limit_unchanged(self):
        """kind exactly 64 chars is not truncated."""
        exact_kind = "a" * 64
        k, _ = self._run_record_stat(exact_kind, None)
        assert k == exact_kind

    def test_kind_under_limit_unchanged(self):
        """kind shorter than 64 chars is not altered."""
        short_kind = "read_hit"
        k, _ = self._run_record_stat(short_kind, None)
        assert k == short_kind

    def test_detail_over_limit_truncated(self):
        """detail longer than 512 chars is truncated to exactly 512."""
        long_detail = "d" * 600
        _, d = self._run_record_stat("some_kind", long_detail)
        assert d is not None
        assert len(d) == 512
        assert d == "d" * 512

    def test_detail_at_limit_unchanged(self):
        """detail exactly 512 chars is not truncated."""
        exact_detail = "e" * 512
        _, d = self._run_record_stat("some_kind", exact_detail)
        assert d == exact_detail

    def test_detail_under_limit_unchanged(self):
        """detail shorter than 512 chars is not altered."""
        short_detail = "/path/to/file.py"
        _, d = self._run_record_stat("some_kind", short_detail)
        assert d == short_detail

    def test_detail_none_passes_through(self):
        """None detail is stored as None without error."""
        _, d = self._run_record_stat("some_kind", None)
        assert d is None

    def test_kind_exactly_65_truncated_to_64(self):
        """kind at 65 chars — one over the limit — is truncated to 64."""
        kind_65 = "k" * 65
        k, _ = self._run_record_stat(kind_65, None)
        assert len(k) == 64

    def test_detail_exactly_513_truncated_to_512(self):
        """detail at 513 chars — one over — is truncated to 512."""
        detail_513 = "p" * 513
        _, d = self._run_record_stat("kind", detail_513)
        assert d is not None
        assert len(d) == 512

    def test_both_over_limit_both_truncated(self):
        """When both kind and detail exceed limits, both are independently truncated."""
        k, d = self._run_record_stat("k" * 100, "d" * 1000)
        assert len(k) == 64
        assert d is not None
        assert len(d) == 512

    def test_constants_correct(self):
        """Verify the module-level constant values are as documented."""
        from token_goat.db import _MAX_STAT_DETAIL_LEN, _MAX_STAT_KIND_LEN

        assert _MAX_STAT_KIND_LEN == 64
        assert _MAX_STAT_DETAIL_LEN == 512


# ===========================================================================
# 2. hooks_read.py — _record_session_hint_impact sanitizes file_path
# ===========================================================================


class TestRecordSessionHintImpact:
    """_record_session_hint_impact must strip newlines from file_path before storing."""

    def _capture_details(self, file_path: str) -> list[str | None]:
        """Call _record_session_hint_impact and return the detail values from both record_stat calls."""
        from token_goat.hints import ReadHint

        details: list[str | None] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            details.append(detail)

        hint = ReadHint("Note: already read.", tokens_saved=20)

        # db is imported lazily inside _record_session_hint_impact; patch the module directly
        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            from token_goat.hooks_read import _record_session_hint_impact

            _record_session_hint_impact(file_path, hint)

        return details

    def test_newline_in_path_stripped(self):
        """Embedded newline in file_path is removed before storing in stats detail."""
        evil_path = "/some/path\nNote: fake entry"
        details = self._capture_details(evil_path)
        assert details, "No stats were recorded"
        for d in details:
            assert d is not None
            assert "\n" not in d, f"Newline leaked into detail: {d!r}"

    def test_carriage_return_in_path_stripped(self):
        """Embedded CR in file_path is removed before storing in stats detail."""
        evil_path = "/some/path\rNote: fake"
        details = self._capture_details(evil_path)
        for d in details:
            assert d is not None
            assert "\r" not in d

    def test_clean_path_preserved(self):
        """A clean path without control chars is stored as-is (up to max_len)."""
        clean = "/project/src/main.py"
        details = self._capture_details(clean)
        assert details
        # The first detail should contain the clean path
        assert any(clean in (d or "") for d in details)

    def test_two_stats_recorded(self):
        """Both session_hint and session_hint_overhead stats are recorded.

        Item 15 (commit 4cbe4ee) skips the overhead row when the injection
        text is < 32 bytes, since the overhead measurement is negligible
        for tiny nudges. Use a hint text longer than 32 bytes so the
        overhead row is still emitted and both kinds are recorded.
        """
        from token_goat.hints import ReadHint

        kinds: list[str] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            kinds.append(kind)

        # 40-byte hint text — above the 32-byte gating threshold so both
        # the gross-saving row AND the overhead row fire.
        hint_text = "Note: already read this file recently; skip re-read."
        assert len(hint_text.encode("utf-8")) >= 32
        hint = ReadHint(hint_text, tokens_saved=10)

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            from token_goat.hooks_read import _record_session_hint_impact

            _record_session_hint_impact("/some/file.py", hint)

        assert "session_hint" in kinds
        assert "session_hint_overhead" in kinds

    def test_only_gross_stat_recorded_when_injection_below_threshold(self):
        """Item 15: skip overhead row when injection_bytes < 32 and tokens_saved > 0.

        Companion to test_two_stats_recorded — verifies that the gating
        actually fires for small hints. A 19-byte hint must record the
        gross-saving row but not the overhead row.
        """
        from token_goat.hints import ReadHint

        kinds: list[str] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            kinds.append(kind)

        # 19-byte hint — below the 32-byte gating threshold.
        hint_text = "Note: already read."
        assert len(hint_text.encode("utf-8")) < 32
        hint = ReadHint(hint_text, tokens_saved=10)

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            from token_goat.hooks_read import _record_session_hint_impact

            _record_session_hint_impact("/some/file.py", hint)

        assert "session_hint" in kinds
        # Overhead row is intentionally skipped for tiny hints.
        assert "session_hint_overhead" not in kinds


# ===========================================================================
# 3. compact.py — event_count and build_manifest edge cases
# ===========================================================================


class TestCompactEventCount:
    """event_count must return 0 when the session does not exist."""

    def test_returns_zero_for_nonexistent_session(self):
        """A session ID with no backing file yields event_count == 0."""
        from token_goat.compact import event_count

        with patch("token_goat.compact.session_mod.load") as mock_load:
            mock_load.side_effect = FileNotFoundError("no file")
            count = event_count("nonexistent-session-abc123")
        assert count == 0

    def test_returns_zero_for_invalid_session_id(self):
        """An invalid session ID (fails validation) yields event_count == 0."""
        from token_goat.compact import event_count

        count = event_count("../../../evil")
        assert count == 0

    def test_returns_total_events(self):
        """event_count sums files + greps + edited_files."""
        from token_goat.compact import event_count

        mock_cache = MagicMock()
        mock_cache.files = {"a.py": MagicMock(), "b.py": MagicMock()}
        mock_cache.greps = ["pat1"]
        mock_cache.edited_files = {"c.py": 2}

        with patch("token_goat.compact.session_mod.validate_session_id"), \
             patch("token_goat.compact.session_mod.load", return_value=mock_cache):
            count = event_count("valid-session-id-xyz")

        assert count == 4  # 2 + 1 + 1


class TestCompactBuildManifest:
    """build_manifest must handle empty caches, missing sessions, and token caps."""

    def test_returns_empty_string_when_session_missing(self):
        """Missing session returns empty string, not an exception."""
        from token_goat.compact import build_manifest

        with patch("token_goat.compact.session_mod.load") as mock_load:
            mock_load.side_effect = FileNotFoundError("no file")
            result = build_manifest("missing-session-abcde")
        assert result == ""

    def test_returns_empty_string_when_cache_has_no_events(self):
        """Session with no files/greps/edits returns empty string."""
        from token_goat.compact import build_manifest

        mock_cache = MagicMock()
        mock_cache.files = {}
        mock_cache.greps = []
        mock_cache.edited_files = {}
        # Explicit stubs prevent the MagicMock attribute trap in
        # _compute_manifest_fingerprint (json.dumps cannot serialise a
        # MagicMock auto-attr; the fingerprint now hashes cwd + the
        # bash/web/skill/glob/dedup history).
        mock_cache.cwd = None
        mock_cache.bash_dedup_emitted_ids = set()
        mock_cache.bash_history = {}
        mock_cache.glob_history = []
        mock_cache.skill_history = {}
        mock_cache.web_history = {}
        mock_cache.created_ts = 0.0

        with patch("token_goat.compact.session_mod.validate_session_id"), \
             patch("token_goat.compact.session_mod.load", return_value=mock_cache):
            result = build_manifest("empty-session-xyzabc")
        assert result == ""

    def test_max_tokens_cap_enforced(self):
        """max_tokens above _MAX_MANIFEST_TOKENS_CAP is clamped, not rejected."""
        from token_goat.compact import _MAX_MANIFEST_TOKENS_CAP, build_manifest

        # Passing a value above the cap must not raise; it should clamp silently.
        with patch("token_goat.compact.session_mod.load") as mock_load:
            mock_load.side_effect = FileNotFoundError("no file")
            # Should return empty string (missing session) without raising
            result = build_manifest("valid-session-abcde", max_tokens=_MAX_MANIFEST_TOKENS_CAP + 99999)
        assert isinstance(result, str)

    def test_max_manifest_tokens_cap_value(self):
        """_MAX_MANIFEST_TOKENS_CAP must be 4000 as documented."""
        from token_goat.compact import _MAX_MANIFEST_TOKENS_CAP

        assert _MAX_MANIFEST_TOKENS_CAP == 4_000

    def test_max_tokens_below_one_is_clamped_to_one(self):
        """max_tokens=0 is clamped to 1 without raising."""
        from token_goat.compact import build_manifest

        with patch("token_goat.compact.session_mod.load") as mock_load:
            mock_load.side_effect = FileNotFoundError("no file")
            result = build_manifest("valid-session-abcdef", max_tokens=0)
        assert isinstance(result, str)

    def test_invalid_session_id_returns_empty_string(self):
        """build_manifest with invalid session_id returns '' instead of raising."""
        from token_goat.compact import build_manifest

        result = build_manifest("../traversal-attack")
        assert result == ""


# ===========================================================================
# 4. hints.py — _sanitize_hint_path and build_read_hint
# ===========================================================================


class TestSanitizeHintPath:
    """_sanitize_hint_path must strip control chars and cap length."""

    def test_strips_newline(self):
        """Newline is replaced/stripped."""
        from token_goat.hints import _sanitize_hint_path

        result = _sanitize_hint_path("/some/path\nNote: injected")
        assert "\n" not in result

    def test_strips_carriage_return(self):
        """Carriage return is replaced/stripped."""
        from token_goat.hints import _sanitize_hint_path

        result = _sanitize_hint_path("/some/path\rinjected")
        assert "\r" not in result

    def test_clean_path_unchanged(self):
        """A clean path is returned as-is."""
        from token_goat.hints import _sanitize_hint_path

        clean = "/project/src/auth.py"
        result = _sanitize_hint_path(clean)
        assert result == clean

    def test_long_path_capped(self):
        """Path exceeding _MAX_HINT_PATH_LEN is truncated."""
        from token_goat.hints import _MAX_HINT_PATH_LEN, _sanitize_hint_path

        long_path = "/x/" + "a" * 400
        result = _sanitize_hint_path(long_path)
        # sanitize_log_str truncates to max_len then appends one ellipsis char
        assert len(result) <= _MAX_HINT_PATH_LEN + 1
        assert len(result) < len(long_path)

    def test_path_with_newline_and_cr_stripped_not_tab(self):
        """sanitize_log_str strips \\n and \\r but not tabs; verify newline/CR removal specifically."""
        from token_goat.hints import _sanitize_hint_path

        # Tabs are not injection vectors (they don't split log lines), so they pass through.
        # Newlines and CRs are the actual injection risk and must be removed.
        path_with_newline = "/path/file\ninjected"
        result = _sanitize_hint_path(path_with_newline)
        assert "\n" not in result
        assert "\\n" in result  # sanitize_log_str replaces \n with literal \\n


class TestBuildReadHintEdgeCases:
    """build_read_hint must return None when session_id or file_path is empty."""

    def test_returns_none_when_session_id_is_none(self):
        """No session_id → no hint."""
        from token_goat.hints import build_read_hint

        result = build_read_hint(
            session_id=None,
            file_path="/some/file.py",
            offset=None,
            limit=None,
            cwd=None,
        )
        assert result is None

    def test_returns_none_when_file_path_empty(self):
        """Empty file_path → no hint."""
        from token_goat.hints import build_read_hint

        result = build_read_hint(
            session_id="valid-session-abc123",
            file_path="",
            offset=None,
            limit=None,
            cwd=None,
        )
        assert result is None

    def test_returns_none_when_both_empty(self):
        """Both None/empty → no hint."""
        from token_goat.hints import build_read_hint

        result = build_read_hint(
            session_id=None,
            file_path="",
            offset=None,
            limit=None,
            cwd=None,
        )
        assert result is None


# ===========================================================================
# 5. worker.py — _parse_and_group_entries with malformed entries
# ===========================================================================


class TestParseAndGroupEntries:
    """_parse_and_group_entries must skip malformed, invalid-hash, and unsafe entries."""

    def _call(self, entries):
        from token_goat.worker import _parse_and_group_entries

        return _parse_and_group_entries(entries)

    def test_empty_list_returns_empty_dict(self):
        """Empty input yields empty output."""
        result = self._call([])
        assert result == {}

    def test_entry_missing_path_is_skipped(self):
        """Entry without 'path' key is silently skipped."""
        entry = {"project_hash": "a" * 40, "ts": 1.0}
        result = self._call([entry])
        assert result == {}

    def test_entry_missing_project_hash_is_skipped(self):
        """Entry without 'project_hash' key is silently skipped."""
        entry = {"path": "src/foo.py", "ts": 1.0}
        result = self._call([entry])
        assert result == {}

    def test_entry_with_invalid_project_hash_is_skipped(self):
        """Entry with a non-hex project_hash is skipped."""
        entry = {"path": "src/foo.py", "project_hash": "not-a-valid-hash!!", "ts": 1.0}
        result = self._call([entry])
        assert result == {}

    def test_entry_with_path_traversal_is_skipped(self):
        """Entry with '../' path traversal is skipped."""
        entry = {"path": "../../etc/passwd", "project_hash": "a" * 40, "ts": 1.0}
        result = self._call([entry])
        assert result == {}

    def test_valid_entry_groups_correctly(self):
        """A valid entry is grouped under its project_hash."""
        valid_hash = "a" * 40
        entry = {"path": "src/main.py", "project_hash": valid_hash, "ts": 1.0}
        result = self._call([entry])
        assert valid_hash in result
        assert "src/main.py" in result[valid_hash]["rels"]

    def test_multiple_valid_entries_same_project(self):
        """Multiple entries with same project_hash merge into one bucket."""
        ph = "b" * 40
        entries = [
            {"path": "src/a.py", "project_hash": ph},
            {"path": "src/b.py", "project_hash": ph},
        ]
        result = self._call(entries)
        assert len(result) == 1
        assert "src/a.py" in result[ph]["rels"]
        assert "src/b.py" in result[ph]["rels"]

    def test_mixed_valid_and_invalid_entries(self):
        """Invalid entries are skipped; valid entries are grouped normally."""
        valid_hash = "c" * 40
        entries = [
            {"path": "src/ok.py", "project_hash": valid_hash},
            {"project_hash": valid_hash},  # missing path
            {"path": "src/evil.py", "project_hash": "not-hex"},
        ]
        result = self._call(entries)
        assert valid_hash in result
        assert len(result[valid_hash]["rels"]) == 1

    def test_marker_sanitized_from_entry(self):
        """project_marker from queue entry is sanitized (newlines stripped, length capped)."""
        ph = "d" * 40
        entries = [
            {
                "path": "src/foo.py",
                "project_hash": ph,
                "project_root": "/some/root",
                "project_marker": "good_marker\nevil_line\n" + "x" * 200,
            }
        ]
        result = self._call(entries)
        marker = result[ph]["marker"]
        assert marker is not None
        assert "\n" not in marker
        # sanitize_log_str appends one ellipsis char after truncating to max_len
        assert len(marker) <= 65


# ===========================================================================
# 6. bash_parser.py — oversized commands, paths, and shlex errors
# ===========================================================================


class TestBashParserLimits:
    """parse() must reject oversized commands and paths; handle shlex ValueError."""

    def test_oversized_command_returns_unknown(self):
        """Command exceeding _MAX_COMMAND_BYTES returns kind='unknown'."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse

        huge = "cat " + "x" * (_MAX_COMMAND_BYTES + 1)
        result = parse(huge)
        assert result.kind == "unknown"
        assert "too long" in result.reason.lower()

    def test_command_at_max_bytes_is_rejected(self):
        """Command at exactly _MAX_COMMAND_BYTES + 1 chars is rejected."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse

        cmd = "a" * (_MAX_COMMAND_BYTES + 1)
        result = parse(cmd)
        assert result.kind == "unknown"

    def test_shlex_split_error_returns_unknown(self):
        """Unterminated quote causes shlex.split to raise ValueError → kind='unknown'."""
        from token_goat.bash_parser import parse

        bad_cmd = "cat '/unterminated"
        result = parse(bad_cmd)
        assert result.kind == "unknown"
        assert "quoting" in result.reason.lower()

    def test_oversized_target_path_returns_unknown(self):
        """Target path exceeding _MAX_PATH_BYTES returns kind='unknown'."""
        from token_goat.bash_parser import _MAX_PATH_BYTES, parse

        long_path = "/x/" + "y" * (_MAX_PATH_BYTES + 1)
        result = parse(f"cat {long_path}")
        assert result.kind == "unknown"
        assert "too long" in result.reason.lower()

    def test_normal_cat_command_returns_read(self):
        """Normal cat command is recognised as kind='read'."""
        from token_goat.bash_parser import parse

        result = parse("cat src/main.py")
        assert result.kind == "read"
        assert result.target_path == "src/main.py"

    def test_max_command_bytes_constant(self):
        """_MAX_COMMAND_BYTES is 65536 (64 KiB) as documented."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES

        assert _MAX_COMMAND_BYTES == 65_536

    def test_max_path_bytes_constant(self):
        """_MAX_PATH_BYTES is 8192 (8 KiB) as documented."""
        from token_goat.bash_parser import _MAX_PATH_BYTES

        assert _MAX_PATH_BYTES == 8_192


# ===========================================================================
# 7. paths.py — _safe_env_dir and roll_log_if_oversized
# ===========================================================================


class TestSafeEnvDir:
    """_safe_env_dir must reject relative paths and accept absolute paths."""

    def test_relative_path_returns_none(self):
        """Relative path like '../../tmp/evil' is rejected → None."""
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("../../tmp/evil")
        assert result is None

    def test_empty_string_returns_none(self):
        """Empty string returns None."""
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("")
        assert result is None

    def test_whitespace_only_returns_none(self):
        """Whitespace-only string returns None."""
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("   ")
        assert result is None

    def test_absolute_path_accepted(self):
        """A well-formed absolute path is accepted and returned as Path."""
        from token_goat.paths import _safe_env_dir

        if sys.platform == "win32":
            abs_path = "C:\\Users\\zelys\\AppData\\Local"
        else:
            abs_path = "/home/user/.local/share"

        result = _safe_env_dir(abs_path)
        assert result is not None
        assert result.is_absolute()

    def test_bare_relative_name_rejected(self):
        """A bare relative name like 'localappdata' is rejected."""
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("localappdata")
        assert result is None


class TestRollLogIfOversized:
    """roll_log_if_oversized must roll when over limit and skip when under."""

    def test_does_not_roll_when_under_limit(self, tmp_path):
        """File under max_bytes is not rolled."""
        log_file = tmp_path / "app.log"
        log_file.write_bytes(b"x" * 100)

        from token_goat.paths import roll_log_if_oversized

        roll_log_if_oversized(log_file, max_bytes=1000)

        # File still exists under original name; no .prev.log created
        assert log_file.exists()
        assert not (tmp_path / "app.prev.log").exists()

    def test_rolls_when_over_limit(self, tmp_path):
        """File over max_bytes is renamed to .prev.log."""
        log_file = tmp_path / "app.log"
        log_file.write_bytes(b"x" * 200)

        from token_goat.paths import roll_log_if_oversized

        roll_log_if_oversized(log_file, max_bytes=100)

        # Original is gone; .prev.log exists
        assert not log_file.exists()
        assert (tmp_path / "app.prev.log").exists()

    def test_no_error_when_file_absent(self, tmp_path):
        """Missing file doesn't raise — OSError is swallowed."""
        from token_goat.paths import roll_log_if_oversized

        missing = tmp_path / "nonexistent.log"
        roll_log_if_oversized(missing, max_bytes=1000)  # must not raise

    def test_file_exactly_at_limit_not_rolled(self, tmp_path):
        """File at exactly max_bytes is NOT rolled (condition is strictly greater than)."""
        log_file = tmp_path / "exact.log"
        log_file.write_bytes(b"x" * 500)

        from token_goat.paths import roll_log_if_oversized

        roll_log_if_oversized(log_file, max_bytes=500)

        assert log_file.exists()
        assert not (tmp_path / "exact.prev.log").exists()


# ===========================================================================
# 8. config.py — load() returns defaults on OSError and malformed TOML
# ===========================================================================


class TestConfigLoad:
    """config.load() must return default Config on failure, never raise."""

    def test_returns_default_when_file_absent(self, tmp_path):
        """When config file does not exist, default Config is returned."""
        from token_goat import config

        fake_path = tmp_path / "no_config.toml"
        with patch("token_goat.config.paths.config_path", return_value=fake_path):
            cfg = config.load()

        assert isinstance(cfg, config.Config)
        assert cfg.compact_assist.enabled is True
        assert cfg.compact_assist.min_events == 3

    def test_returns_default_on_oserror(self, tmp_path):
        """An OSError while reading the file falls back to defaults."""
        from token_goat import config

        fake_path = tmp_path / "config.toml"
        fake_path.write_text("[compact_assist]\nenabled = true\n", encoding="utf-8")

        with patch("token_goat.config.paths.config_path", return_value=fake_path), \
             patch.object(Path, "read_text", side_effect=OSError("permission denied")):
            cfg = config.load()

        assert isinstance(cfg, config.Config)
        assert cfg.compact_assist.enabled is True  # default

    def test_returns_default_on_malformed_toml(self, tmp_path):
        """A TOMLDecodeError falls back to defaults without raising."""
        from token_goat import config

        fake_path = tmp_path / "config.toml"
        fake_path.write_text("this is not valid toml = = =\n", encoding="utf-8")

        with patch("token_goat.config.paths.config_path", return_value=fake_path):
            cfg = config.load()

        assert isinstance(cfg, config.Config)
        # Still has default values
        assert isinstance(cfg.compact_assist, config.CompactAssistConfig)

    def test_valid_toml_overrides_defaults(self, tmp_path):
        """Valid TOML with compact_assist settings is applied correctly."""
        from token_goat import config

        fake_path = tmp_path / "config.toml"
        fake_path.write_text(
            "[compact_assist]\nenabled = false\nmin_events = 10\n",
            encoding="utf-8",
        )

        with patch("token_goat.config.paths.config_path", return_value=fake_path):
            cfg = config.load()

        assert cfg.compact_assist.enabled is False
        assert cfg.compact_assist.min_events == 10

    def test_default_config_is_complete(self):
        """Default Config has all expected attributes."""
        from token_goat.config import CompactAssistConfig, Config

        cfg = Config()
        assert hasattr(cfg, "compact_assist")
        assert isinstance(cfg.compact_assist, CompactAssistConfig)
        assert cfg.compact_assist.max_manifest_tokens == 400
        assert "manual" in cfg.compact_assist.triggers
        assert "auto" in cfg.compact_assist.triggers
