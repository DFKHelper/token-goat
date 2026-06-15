"""Regression tests for iteration 215.

Coverage targets:
- db.py: record_stat() truncation verified via real in-memory SQLite
- session.py: _normalize_path with platform-patched Windows branch
- hooks_cli.py: dispatch timing key, unknown/crashing handlers
- hooks_cli.py: read_payload stdin paths (oversized, empty, non-dict, malformed)
- hooks_cli.py: emit non-ASCII and buffer write path
- compact.py: build_manifest with edited_files, max_tokens ceiling
- paths.py: _safe_env_dir additional edge cases
- worker.py: _parse_and_group_entries — multi-project, root/marker carried, dup rels
"""
from __future__ import annotations

import io
import json
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

# ===========================================================================
# 1. db.py — record_stat() truncation verified against real in-memory SQLite
# ===========================================================================

_STATS_DDL = """
CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    last_access_epoch REAL
);
"""


def _make_in_memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute(_STATS_DDL)
    conn.commit()
    return conn


@contextmanager
def _yield_conn(conn):
    yield conn


class TestRecordStatInMemoryDb:
    """record_stat truncation verified by reading back rows from a real in-memory DB."""

    def _call_record_stat(self, kind: str, detail: str | None, conn: sqlite3.Connection) -> dict:
        """Patch open_global so record_stat writes into *conn*, then fetch the row."""
        from token_goat import db

        with patch.object(db, "open_global", return_value=_yield_conn(conn)):
            db.record_stat(None, kind, tokens_saved=7, bytes_saved=42, detail=detail)

        row = conn.execute("SELECT kind, detail FROM stats ORDER BY id DESC LIMIT 1").fetchone()
        return {"kind": row[0], "detail": row[1]}

    def test_kind_over_64_stored_truncated(self):
        conn = _make_in_memory_conn()
        long_kind = "k" * 100
        row = self._call_record_stat(long_kind, None, conn)
        assert row["kind"] == "k" * 64

    def test_kind_exactly_64_stored_intact(self):
        conn = _make_in_memory_conn()
        exact_kind = "x" * 64
        row = self._call_record_stat(exact_kind, None, conn)
        assert row["kind"] == exact_kind

    def test_kind_under_64_stored_intact(self):
        conn = _make_in_memory_conn()
        short_kind = "hit"
        row = self._call_record_stat(short_kind, None, conn)
        assert row["kind"] == short_kind

    def test_detail_over_512_stored_truncated(self):
        conn = _make_in_memory_conn()
        long_detail = "d" * 600
        row = self._call_record_stat("hit", long_detail, conn)
        assert row["detail"] == "d" * 512

    def test_detail_exactly_512_stored_intact(self):
        conn = _make_in_memory_conn()
        exact_detail = "e" * 512
        row = self._call_record_stat("hit", exact_detail, conn)
        assert row["detail"] == exact_detail

    def test_detail_none_stored_as_null(self):
        conn = _make_in_memory_conn()
        row = self._call_record_stat("hit", None, conn)
        assert row["detail"] is None

    def test_tokens_saved_stored_correctly(self):
        from token_goat import db

        conn = _make_in_memory_conn()
        with patch.object(db, "open_global", return_value=_yield_conn(conn)):
            db.record_stat(None, "sym", tokens_saved=99, bytes_saved=200)

        row = conn.execute("SELECT tokens_saved, bytes_saved FROM stats ORDER BY id DESC LIMIT 1").fetchone()
        assert row[0] == 99
        assert row[1] == 200

    def test_multiple_rows_each_truncated_independently(self):
        """Verify truncation on two successive record_stat calls using separate conn patches."""
        row1 = self._call_record_stat("a" * 80, "b" * 600, _make_in_memory_conn())
        row2 = self._call_record_stat("short", "also_short", _make_in_memory_conn())

        assert row1["kind"] == "a" * 64
        assert row1["detail"] == "b" * 512
        assert row2["kind"] == "short"
        assert row2["detail"] == "also_short"


# ===========================================================================
# 2. session.py — _normalize_path with patched sys.platform
# ===========================================================================


class TestNormalizePathPlatformPatched:
    """``paths.normalize_key`` Windows-branch behaviour verified by patching sys.platform.

    Commit e21ae12 promoted ``session._normalize_path`` to public
    ``paths.normalize_key`` and dropped the ``import sys`` from
    ``session.py`` — ``session._normalize_path`` is now a thin alias.
    The platform-dependent logic lives in ``paths`` so we patch
    ``paths.sys.platform`` to exercise both branches.
    """

    def test_uppercase_drive_no_backslash_lowercased_on_win32(self):
        """Fast path: no backslash + uppercase drive → lowercase drive on win32."""
        import token_goat.paths as tg_paths
        import token_goat.session as sess

        with patch.object(tg_paths.sys, "platform", "win32"):
            result = sess._normalize_path("C:/foo/bar.py")
        assert result == "c:/foo/bar.py"

    def test_uppercase_drive_lowercased_on_all_platforms(self):
        """Drive letter is lowercased on all platforms (WSL fix: normalize_path is platform-agnostic)."""
        import token_goat.session as sess

        # normalize_path no longer gates drive-letter lowercasing on sys.platform.
        # Under WSL (Linux), a Windows-format path like C:/foo/bar.py must also
        # be lowercased so it matches a /mnt/c/foo/bar.py key after WSL conversion.
        result = sess._normalize_path("C:/foo/bar.py")
        assert result == "c:/foo/bar.py"

    def test_backslash_path_uppercase_drive_lowercased_on_win32(self):
        """Backslash path: separators converted AND drive lowercased on win32."""
        import token_goat.paths as tg_paths
        import token_goat.session as sess

        with patch.object(tg_paths.sys, "platform", "win32"):
            result = sess._normalize_path("D:\\projects\\file.py")
        assert result == "d:/projects/file.py"

    def test_backslash_path_separators_and_drive_converted_on_linux(self):
        """Backslash path: separators converted AND drive lowercased on all platforms."""
        import token_goat.session as sess

        # normalize_path is platform-agnostic: backslashes and drive letters
        # are always normalized, enabling WSL /mnt/c/... ↔ C:\... equivalence.
        result = sess._normalize_path(r"C:\projects\file.py")
        assert "\\" not in result
        assert result == "c:/projects/file.py"

    def test_already_lowercase_drive_unchanged_on_win32(self):
        """Lowercase drive letter is not double-lowercased."""
        import token_goat.paths as tg_paths
        import token_goat.session as sess

        with patch.object(tg_paths.sys, "platform", "win32"):
            result = sess._normalize_path("c:/already/lower.py")
        assert result == "c:/already/lower.py"

    def test_non_drive_letter_prefix_unchanged_on_win32(self):
        """A path whose second char is not ':' is not altered on win32."""
        import token_goat.paths as tg_paths
        import token_goat.session as sess

        with patch.object(tg_paths.sys, "platform", "win32"):
            result = sess._normalize_path("/home/user/file.py")
        assert result == "/home/user/file.py"

    def test_empty_string_returns_empty(self):
        import token_goat.session as sess

        result = sess._normalize_path("")
        assert result == ""

    def test_single_char_no_crash(self):
        import token_goat.session as sess

        result = sess._normalize_path("x")
        assert result == "x"

    def test_mixed_separators_on_win32_all_become_forward_slash(self):
        """Mixed backslash+forward-slash path is fully normalised."""
        import token_goat.paths as tg_paths
        import token_goat.session as sess

        with patch.object(tg_paths.sys, "platform", "win32"):
            result = sess._normalize_path("E:\\foo/bar\\baz.py")
        assert result == "e:/foo/bar/baz.py"


# ===========================================================================
# 3. hooks_cli.py — dispatch timing, unknown event, crashing handler
# ===========================================================================


class TestDispatchTiming:
    """dispatch() adds _tg_elapsed_ms only for known (handled) events."""

    def test_elapsed_ms_key_present_for_known_event(self):
        from token_goat.hooks_cli import dispatch

        result = dispatch("session-start", {"session_id": "timing_test_215", "cwd": "/tmp"})
        assert "_tg_elapsed_ms" in result

    def test_elapsed_ms_is_non_negative_for_known_event(self):
        from token_goat.hooks_cli import dispatch

        result = dispatch("session-start", {"session_id": "timing_nonneg_215", "cwd": "/tmp"})
        assert result["_tg_elapsed_ms"] >= 0.0

    def test_elapsed_ms_is_numeric_type(self):
        from token_goat.hooks_cli import dispatch

        result = dispatch("session-start", {"session_id": "timing_type_215", "cwd": "/tmp"})
        assert isinstance(result["_tg_elapsed_ms"], (int, float))

    def test_unknown_event_returns_continue_true_no_elapsed_key(self):
        """Unknown events early-return CONTINUE without the timing key."""
        from token_goat.hooks_cli import dispatch

        result = dispatch("totally-unknown-event-215", {})
        assert result.get("continue") is True
        # The timing key is not added for unknown events (early return path)
        assert "_tg_elapsed_ms" not in result

    def test_unknown_event_returns_only_continue(self):
        from token_goat.hooks_cli import dispatch

        result = dispatch("no-such-handler-215", {})
        assert set(result.keys()) == {"continue"}

    def test_crashing_handler_returns_continue_via_fail_soft(self):
        """A fail_soft-wrapped handler that raises returns CONTINUE instead of propagating."""
        from token_goat import hooks_cli

        def _boom(_payload):
            raise RuntimeError("boom")

        wrapped = hooks_cli.fail_soft(_boom)
        with patch.dict(hooks_cli.EVENTS, {"test-boom-215": wrapped}):
            result = hooks_cli.dispatch("test-boom-215", {})
        assert result.get("continue") is True

    def test_elapsed_ms_present_for_post_read_event(self):
        from token_goat.hooks_cli import dispatch

        # post-read is a lightweight known event
        result = dispatch("post-read", {"session_id": "elapsed_postread_215", "file_path": "/x.py"})
        assert "_tg_elapsed_ms" in result
        assert result["_tg_elapsed_ms"] >= 0.0


# ===========================================================================
# 4. hooks_cli.py — read_payload (file-based and stdin-based)
# ===========================================================================


class TestReadPayloadFileBased:
    """read_payload with input_file= path."""

    def test_valid_dict_json_file_returns_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "payload.json"
        f.write_text(json.dumps({"tool": "Read", "path": "/foo.py"}), encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {"tool": "Read", "path": "/foo.py"}

    def test_json_list_file_returns_empty_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "payload.json"
        f.write_text("[1, 2, 3]", encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {}

    def test_json_null_file_returns_empty_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "payload.json"
        f.write_text("null", encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {}

    def test_malformed_json_file_returns_empty_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "payload.json"
        f.write_text("{not valid json", encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {}

    def test_oversized_file_returns_empty_dict(self, tmp_path):
        from token_goat import hooks_cli
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "big.json"
        # Write a file larger than _MAX_PAYLOAD_BYTES
        big_content = "{" + '"k": "' + "v" * (hooks_cli._MAX_PAYLOAD_BYTES + 100) + '"}'
        f.write_bytes(big_content.encode("utf-8"))
        result = read_payload(input_file=f)
        assert result == {}

    def test_empty_file_returns_empty_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "empty.json"
        f.write_text("", encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {}

    def test_whitespace_only_file_returns_empty_dict(self, tmp_path):
        from token_goat.hooks_cli import read_payload

        f = tmp_path / "ws.json"
        f.write_text("   \n  \t  ", encoding="utf-8")
        result = read_payload(input_file=f)
        assert result == {}


class TestReadPayloadStdinBased:
    """read_payload reading from sys.stdin (no input_file)."""

    def test_empty_stdin_returns_empty_dict(self):
        from token_goat.hooks_cli import read_payload

        with patch("token_goat.hooks_cli.sys") as mock_sys:
            mock_sys.stdin.read.return_value = ""
            result = read_payload(input_file=None)
        assert result == {}

    def test_whitespace_stdin_returns_empty_dict(self):
        from token_goat.hooks_cli import read_payload

        with patch("token_goat.hooks_cli.sys") as mock_sys:
            mock_sys.stdin.read.return_value = "   \n"
            result = read_payload(input_file=None)
        assert result == {}

    def test_valid_dict_stdin_returns_dict(self):
        from token_goat.hooks_cli import read_payload

        payload = {"event": "pre-read", "path": "/src/foo.py"}
        with patch("token_goat.hooks_cli.sys") as mock_sys:
            mock_sys.stdin.read.return_value = json.dumps(payload)
            result = read_payload(input_file=None)
        assert result == payload

    def test_non_dict_list_stdin_returns_empty_dict(self):
        from token_goat.hooks_cli import read_payload

        with patch("token_goat.hooks_cli.sys") as mock_sys:
            mock_sys.stdin.read.return_value = "[1, 2, 3]"
            result = read_payload(input_file=None)
        assert result == {}

    def test_malformed_json_stdin_returns_empty_dict(self):
        from token_goat.hooks_cli import read_payload

        with patch("token_goat.hooks_cli.sys") as mock_sys:
            mock_sys.stdin.read.return_value = "{broken json"
            result = read_payload(input_file=None)
        assert result == {}


# ===========================================================================
# 5. hooks_cli.py — emit: non-ASCII, buffer path
# ===========================================================================


class TestEmit:
    """emit() writes JSON to stdout; non-ASCII chars emitted without escaping."""

    def test_emit_basic_dict_written_to_stdout_buffer(self, capsys):
        from token_goat.hooks_cli import emit

        emit({"continue": True})
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["continue"] is True

    def test_emit_non_ascii_not_escaped(self):
        """→ and ← must be emitted as raw UTF-8 bytes, not as \\uXXXX escape sequences."""
        from token_goat import hooks_cli

        buf = io.BytesIO()

        class _FakeStdout:
            buffer = buf

            def write(self, _s):
                pass

            def flush(self):
                pass

        with patch.object(hooks_cli.sys, "stdout", _FakeStdout()):
            hooks_cli.emit({"hint": "already read → skip ←"})

        raw = buf.getvalue()
        # UTF-8 encoding of → is 0xe2 0x86 0x92; must be present as raw bytes
        assert b"\xe2\x86\x92" in raw, "→ should appear as UTF-8 bytes, not escaped"
        assert b"\xe2\x86\x90" in raw, "← should appear as UTF-8 bytes, not escaped"
        # The ASCII escape form \\u2192 must NOT be present
        assert b"\\u2192" not in raw

    def test_emit_elapsed_key_round_trips(self, capsys):
        from token_goat.hooks_cli import emit

        emit({"continue": True, "_tg_elapsed_ms": 12.34})
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["_tg_elapsed_ms"] == pytest.approx(12.34)

    def test_emit_empty_dict_writes_valid_json(self, capsys):
        from token_goat.hooks_cli import emit

        emit({})
        captured = capsys.readouterr()
        assert json.loads(captured.out) == {}

    def test_emit_swallows_broken_buffer(self):
        """emit() must not raise even if stdout.buffer raises on write."""
        from token_goat import hooks_cli

        class _BrokenBuf:
            def write(self, _):
                raise OSError("pipe broken")

            def flush(self):
                pass

        class _FakeStdout:
            buffer = _BrokenBuf()

            def write(self, _s):
                pass

            def flush(self):
                pass

        with patch.object(hooks_cli.sys, "stdout", _FakeStdout()):
            hooks_cli.emit({"continue": True})  # must not raise


# ===========================================================================
# 6. compact.py — build_manifest with edited_files and max_tokens ceiling
# ===========================================================================


def _make_session_cache(files=None, edited_files=None):
    """Build a minimal SessionCache for testing."""
    from token_goat.session import SessionCache

    return SessionCache(
        session_id="test_session_215",
        started_ts=1000.0,
        last_activity_ts=1001.0,
        files=files or {},
        greps=[],
        edited_files=edited_files or {},
    )


def _make_file_entry(path: str, read_count: int = 1):
    from token_goat.session import FileEntry

    return FileEntry(
        rel_or_abs=path,
        last_read_ts=1000.0,
        read_count=read_count,
        line_ranges=[],
        symbols_read=[],
    )


class TestBuildManifestEdited:
    """build_manifest produces an 'Edited files' section when edited_files is set."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Point data_dir at a fresh temp dir so bash_outputs/ is empty.

        Without this, build_manifest → _render_active_errors_section globs the
        real bash_outputs/ dir (thousands of .json files) on every test.
        """

    def test_edited_files_section_present(self, tmp_data_dir):
        from token_goat.compact import build_manifest

        session_id = "manifest_edit_test_215"
        cache = _make_session_cache(edited_files={"src/main.py": 1})

        with patch("token_goat.compact._load_session_cache", return_value=cache):
            result = build_manifest(session_id)

        assert "Edited" in result or "edited" in result.lower() or "main.py" in result

    def test_manifest_respects_max_tokens_ceiling(self):
        """A very small max_tokens budget must produce a shorter manifest."""
        from token_goat.compact import build_manifest

        files = {f"src/module_{i:03d}.py": _make_file_entry(f"src/module_{i:03d}.py", i + 1)
                 for i in range(50)}
        edited = {f"src/edited_{i}.py": i + 1 for i in range(10)}
        cache = _make_session_cache(files=files, edited_files=edited)

        session_id = "manifest_ceiling_test_215"
        with patch("token_goat.compact._load_session_cache", return_value=cache):
            big = build_manifest(session_id, max_tokens=400)
            small = build_manifest(session_id, max_tokens=50)

        assert len(small) <= len(big)

    def test_manifest_empty_when_no_activity(self):
        from token_goat.compact import build_manifest

        cache = _make_session_cache()
        session_id = "manifest_empty_215"
        with patch("token_goat.compact._load_session_cache", return_value=cache):
            result = build_manifest(session_id)
        assert result == ""

    def test_manifest_max_tokens_above_cap_not_raises(self):
        """max_tokens above _MAX_MANIFEST_TOKENS_CAP is silently clamped."""
        from token_goat.compact import _MAX_MANIFEST_TOKENS_CAP, build_manifest

        cache = _make_session_cache(edited_files={"a.py": 1})
        session_id = "manifest_cap_test_215"
        with patch("token_goat.compact._load_session_cache", return_value=cache):
            result = build_manifest(session_id, max_tokens=_MAX_MANIFEST_TOKENS_CAP * 10)
        assert isinstance(result, str)

    def test_manifest_contains_edited_filename(self, tmp_data_dir):
        from token_goat.compact import build_manifest

        cache = _make_session_cache(edited_files={"src/worker.py": 3})
        with patch("token_goat.compact._load_session_cache", return_value=cache):
            result = build_manifest("manifest_filename_215")
        assert "worker.py" in result


# ===========================================================================
# 7. paths.py — _safe_env_dir additional edge cases
# ===========================================================================


class TestSafeEnvDirEdgeCases:
    """_safe_env_dir edge cases not covered by iter205."""

    def test_path_with_spaces_absolute_accepted(self):
        from token_goat.paths import _safe_env_dir

        # Use a platform-appropriate absolute path
        if sys.platform == "win32":
            p = "C:\\Program Files\\MyApp"
        else:
            p = "/home/user/my dir"
        result = _safe_env_dir(p)
        assert result is not None
        assert isinstance(result, Path)

    def test_dot_dot_relative_returns_none(self):
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("../../etc/passwd")
        assert result is None

    def test_leading_whitespace_stripped_absolute_accepted(self):
        from token_goat.paths import _safe_env_dir

        if sys.platform == "win32":
            p = "  C:\\Users\\test  "
        else:
            p = "  /tmp/mydir  "
        result = _safe_env_dir(p)
        # After stripping, it's still absolute → accepted
        assert result is not None

    def test_just_slash_absolute_accepted(self):
        from token_goat.paths import _safe_env_dir

        if sys.platform != "win32":
            result = _safe_env_dir("/")
            assert result is not None
        else:
            result = _safe_env_dir("C:\\")
            assert result is not None

    def test_returned_path_is_path_object(self):
        from token_goat.paths import _safe_env_dir

        if sys.platform == "win32":
            p = "C:\\Users\\test"
        else:
            p = "/tmp/token-goat-test"
        result = _safe_env_dir(p)
        assert isinstance(result, Path)

    def test_single_dot_returns_none(self):
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir(".")
        assert result is None

    def test_bare_filename_returns_none(self):
        from token_goat.paths import _safe_env_dir

        result = _safe_env_dir("mydir")
        assert result is None


# ===========================================================================
# 8. worker.py — _parse_and_group_entries additional angles
# ===========================================================================

_VALID_HASH = "a" * 40  # valid SHA-1 hex, 40 chars
_VALID_HASH2 = "b" * 40


class TestParseAndGroupEntriesAdditional:
    """Additional angles for _parse_and_group_entries not covered by iter205."""

    def test_two_entries_different_projects_both_grouped(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "src/a.py"},
            {"project_hash": _VALID_HASH2, "path": "src/b.py"},
        ]
        result = _parse_and_group_entries(entries)
        assert _VALID_HASH in result
        assert _VALID_HASH2 in result
        assert "src/a.py" in result[_VALID_HASH]["rels"]
        assert "src/b.py" in result[_VALID_HASH2]["rels"]

    def test_duplicate_paths_deduplicated_in_rels(self):
        """Multiple entries with same hash+path → only one entry in rels (set)."""
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "src/dup.py"},
            {"project_hash": _VALID_HASH, "path": "src/dup.py"},
            {"project_hash": _VALID_HASH, "path": "src/dup.py"},
        ]
        result = _parse_and_group_entries(entries)
        assert result[_VALID_HASH]["rels"] == {"src/dup.py"}

    def test_project_root_carried_from_first_entry(self):
        """The root field is populated from the first entry that has project_root."""
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "x.py", "project_root": "/my/project"},
            {"project_hash": _VALID_HASH, "path": "y.py", "project_root": "/other/project"},
        ]
        result = _parse_and_group_entries(entries)
        # Root should come from the *first* entry that recorded it
        assert result[_VALID_HASH]["root"] == "/my/project"

    def test_marker_carried_from_first_entry(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {
                "project_hash": _VALID_HASH,
                "path": "x.py",
                "project_root": "/proj",
                "project_marker": "pyproject.toml",
            },
        ]
        result = _parse_and_group_entries(entries)
        assert result[_VALID_HASH]["marker"] == "pyproject.toml"

    def test_missing_marker_defaults_to_manual(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "x.py", "project_root": "/proj"},
        ]
        result = _parse_and_group_entries(entries)
        assert result[_VALID_HASH]["marker"] == "manual"

    def test_entry_with_path_traversal_skipped(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "../../../etc/passwd"},
        ]
        result = _parse_and_group_entries(entries)
        assert _VALID_HASH not in result

    def test_all_invalid_entries_returns_empty_dict(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH},  # missing path
            {"path": "src/x.py"},  # missing hash
            {"project_hash": "INVALID!!", "path": "src/x.py"},  # bad hash
        ]
        result = _parse_and_group_entries(entries)
        assert result == {}

    def test_mixed_valid_invalid_only_valid_grouped(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [
            {"project_hash": _VALID_HASH, "path": "good.py"},
            {"project_hash": "BAD", "path": "nope.py"},
            {"project_hash": _VALID_HASH2, "path": "also_good.py"},
        ]
        result = _parse_and_group_entries(entries)
        assert _VALID_HASH in result
        assert _VALID_HASH2 in result
        assert "BAD" not in result

    def test_rels_is_a_set(self):
        from token_goat.worker import _parse_and_group_entries

        entries = [{"project_hash": _VALID_HASH, "path": "src/mod.py"}]
        result = _parse_and_group_entries(entries)
        assert isinstance(result[_VALID_HASH]["rels"], set)
