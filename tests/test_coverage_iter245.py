"""Tests for iter245: hooks_cli.safe_run / fail_soft, session._normalize_path,
compact.event_count, db._get_meta, paths.roll_log_if_oversized,
worker._parse_and_group_entries, and bash_parser.parse."""

from __future__ import annotations

import sqlite3
import sys
from unittest.mock import MagicMock, patch

import pytest

from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse
from token_goat.compact import event_count
from token_goat.db import _get_meta
from token_goat.hooks_cli import fail_soft, safe_run
from token_goat.paths import roll_log_if_oversized
from token_goat.session import _normalize_path
from token_goat.worker import _parse_and_group_entries

# ---------------------------------------------------------------------------
# hooks_cli.safe_run
# ---------------------------------------------------------------------------


def test_safe_run_emits_continue_on_dispatch_exception(tmp_path, capsys):
    """Dispatch failure must still produce {"continue": true} on stdout."""
    with (
        patch("token_goat.hooks_cli.read_payload", return_value={}),
        patch("token_goat.hooks_cli.normalize_payload", return_value={}),
        patch("token_goat.hooks_cli.dispatch", side_effect=RuntimeError("boom")),
        patch("token_goat.hooks_cli.emit") as mock_emit,
    ):
        safe_run("pre-read")
    mock_emit.assert_called_once()
    arg = mock_emit.call_args[0][0]
    assert arg.get("continue") is True


def test_safe_run_emits_continue_on_base_exception(capsys):
    """Non-control-signal BaseException in dispatch must still emit continue=true.

    ``safe_run`` deliberately re-raises ``KeyboardInterrupt`` and ``SystemExit``
    so process-control signals propagate; this test exercises the broad
    fail-soft path for every other BaseException subclass.
    """
    class _CustomBaseExc(BaseException):
        pass

    with (
        patch("token_goat.hooks_cli.read_payload", return_value={}),
        patch("token_goat.hooks_cli.normalize_payload", return_value={}),
        patch("token_goat.hooks_cli.dispatch", side_effect=_CustomBaseExc("boom")),
        patch("token_goat.hooks_cli.emit") as mock_emit,
    ):
        safe_run("session-start")
    mock_emit.assert_called_once()
    arg = mock_emit.call_args[0][0]
    assert arg.get("continue") is True


def test_safe_run_emits_even_when_read_payload_fails():
    """If read_payload itself raises, emit is still called."""
    with (
        patch("token_goat.hooks_cli.read_payload", side_effect=OSError("no stdin")),
        patch("token_goat.hooks_cli.emit") as mock_emit,
    ):
        safe_run("post-edit")
    mock_emit.assert_called_once()
    result = mock_emit.call_args[0][0]
    assert result.get("continue") is True


def test_safe_run_emits_even_when_normalize_raises():
    """normalize_payload failure must not prevent emit."""
    with (
        patch("token_goat.hooks_cli.read_payload", return_value={}),
        patch("token_goat.hooks_cli.normalize_payload", side_effect=ValueError("bad")),
        patch("token_goat.hooks_cli.emit") as mock_emit,
    ):
        safe_run("pre-compact")
    mock_emit.assert_called_once()
    assert mock_emit.call_args[0][0].get("continue") is True


def test_safe_run_normal_path_calls_emit_with_dispatched_result():
    """On success, emit receives the denormalized dispatch result."""
    with (
        patch("token_goat.hooks_cli.read_payload", return_value={}),
        patch("token_goat.hooks_cli.normalize_payload", return_value={}),
        patch("token_goat.hooks_cli.dispatch", return_value={"continue": True, "stopHook": False}),
        patch("token_goat.hooks_cli.denormalize_response", return_value={"continue": True}),
        patch("token_goat.hooks_cli.emit") as mock_emit,
    ):
        safe_run("pre-read", harness="claude")
    mock_emit.assert_called_once()
    assert mock_emit.call_args[0][0].get("continue") is True


# ---------------------------------------------------------------------------
# hooks_cli.fail_soft
# ---------------------------------------------------------------------------


def _crashing_handler(payload):  # noqa: ANN001, ANN202
    raise ValueError("handler exploded")


def _ok_handler(payload):  # noqa: ANN001, ANN202
    return {"continue": True, "data": "ok"}


def test_fail_soft_returns_continue_on_crash():
    """A crashing handler wrapped in fail_soft returns {"continue": True}."""
    wrapped = fail_soft(_crashing_handler)
    result = wrapped({})
    assert result["continue"] is True


def test_fail_soft_sets_tg_error_key():
    """The error response must include _tg_error with the exception info."""
    wrapped = fail_soft(_crashing_handler)
    result = wrapped({})
    assert "_tg_error" in result
    assert "ValueError" in result["_tg_error"]
    assert "handler exploded" in result["_tg_error"]


def test_fail_soft_sets_tg_handler_key():
    """The error response must include _tg_handler with the handler name."""
    wrapped = fail_soft(_crashing_handler)
    result = wrapped({})
    assert "_tg_handler" in result
    assert result["_tg_handler"] == "_crashing_handler"


def test_fail_soft_passes_through_normal_result():
    """A handler that does not raise must have its result returned unchanged."""
    wrapped = fail_soft(_ok_handler)
    result = wrapped({"session_id": "abc"})
    assert result["continue"] is True
    assert result.get("data") == "ok"


def test_fail_soft_handler_name_in_error_for_lambda():
    """Lambdas expose their repr in _tg_handler when they crash."""

    def boom(p):  # noqa: ANN001, ANN202
        raise RuntimeError("explode")

    wrapped = fail_soft(boom)
    result = wrapped({})
    assert "_tg_handler" in result
    assert "boom" in result["_tg_handler"]


def test_fail_soft_error_contains_exception_type():
    """_tg_error must name the exception class."""

    def raises_type_error(p):  # noqa: ANN001, ANN202
        raise TypeError("bad type")

    wrapped = fail_soft(raises_type_error)
    result = wrapped({})
    assert "TypeError" in result["_tg_error"]


# ---------------------------------------------------------------------------
# session._normalize_path
# ---------------------------------------------------------------------------


def test_normalize_path_lowercases_windows_drive_letter():
    result = _normalize_path("C:\\Users\\zelys\\project\\file.py")
    assert result.startswith("c:/")


def test_normalize_path_already_lowercase_drive_unchanged():
    result = _normalize_path("c:\\Users\\zelys\\file.py")
    assert result == "c:/Users/zelys/file.py"


def test_normalize_path_backslashes_converted():
    result = _normalize_path("D:\\foo\\bar\\baz.txt")
    assert "\\" not in result
    assert result == "d:/foo/bar/baz.txt"


def test_normalize_path_posix_path_unchanged():
    result = _normalize_path("/home/user/project/file.py")
    assert result == "/home/user/project/file.py"


def test_normalize_path_relative_posix_unchanged():
    result = _normalize_path("src/token_goat/cli.py")
    assert result == "src/token_goat/cli.py"


@pytest.mark.skipif(sys.platform == "win32", reason="UNC handling differs on Windows")
def test_normalize_path_unc_not_mangled_on_linux():
    p = "//server/share/file.txt"
    result = _normalize_path(p)
    assert result == p


def test_normalize_path_empty_string():
    result = _normalize_path("")
    assert result == ""


def test_normalize_path_no_backslash_fast_path():
    p = "/usr/local/bin/python"
    result = _normalize_path(p)
    assert result == p


# ---------------------------------------------------------------------------
# compact.event_count
# ---------------------------------------------------------------------------


def test_event_count_returns_zero_for_nonexistent_session():
    result = event_count("nonexistent-session-id-xyz-999")
    assert result == 0


def test_event_count_returns_zero_for_invalid_session_id():
    # Session IDs with path separators are invalid and should return 0.
    result = event_count("../../etc/passwd")
    assert result == 0


def test_event_count_returns_correct_count(tmp_path):
    """event_count reflects files + greps + edited_files from the cache."""
    cache = MagicMock()
    cache.files = {"a.py": object(), "b.py": object()}
    cache.greps = ["grep1"]
    cache.edited_files = {"c.py"}

    with (
        patch("token_goat.compact.session_mod.validate_session_id"),
        patch("token_goat.compact.session_mod.load", return_value=cache),
    ):
        result = event_count("valid-session-id")

    assert result == 4  # 2 files + 1 grep + 1 edited


def test_event_count_returns_zero_for_empty_session():
    cache = MagicMock()
    cache.files = {}
    cache.greps = []
    cache.edited_files = set()

    with (
        patch("token_goat.compact.session_mod.validate_session_id"),
        patch("token_goat.compact.session_mod.load", return_value=cache),
    ):
        result = event_count("valid-session-id")

    assert result == 0


def test_event_count_returns_zero_when_load_raises():
    with (
        patch("token_goat.compact.session_mod.validate_session_id"),
        patch("token_goat.compact.session_mod.load", side_effect=FileNotFoundError("no file")),
    ):
        result = event_count("valid-session-id")
    assert result == 0


# ---------------------------------------------------------------------------
# db._get_meta
# ---------------------------------------------------------------------------


def _make_meta_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.commit()
    return conn


def test_get_meta_returns_none_for_missing_key():
    conn = _make_meta_conn()
    assert _get_meta(conn, "nonexistent") is None


def test_get_meta_returns_stored_value():
    conn = _make_meta_conn()
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("schema_version", "3"))
    conn.commit()
    assert _get_meta(conn, "schema_version") == "3"


def test_get_meta_returns_none_value_for_null_stored():
    conn = _make_meta_conn()
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("nullkey", None))
    conn.commit()
    result = _get_meta(conn, "nullkey")
    assert result is None


def test_get_meta_handles_multiple_keys():
    conn = _make_meta_conn()
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("k1", "v1"))
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("k2", "v2"))
    conn.commit()
    assert _get_meta(conn, "k1") == "v1"
    assert _get_meta(conn, "k2") == "v2"
    assert _get_meta(conn, "k3") is None


def test_get_meta_returns_empty_string_value():
    conn = _make_meta_conn()
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("empty", ""))
    conn.commit()
    assert _get_meta(conn, "empty") == ""


# ---------------------------------------------------------------------------
# paths.roll_log_if_oversized
# ---------------------------------------------------------------------------


def test_roll_log_file_under_limit_not_rolled(tmp_path):
    log = tmp_path / "test.log"
    log.write_text("small content")
    roll_log_if_oversized(log, max_bytes=10_000)
    assert log.exists()
    assert not (tmp_path / "test.prev.log").exists()


def test_roll_log_file_over_limit_is_renamed(tmp_path):
    log = tmp_path / "test.log"
    log.write_bytes(b"x" * 200)
    roll_log_if_oversized(log, max_bytes=100)
    # Original path gone, .prev.log exists
    assert not log.exists()
    assert (tmp_path / "test.prev.log").exists()


def test_roll_log_nonexistent_file_no_crash(tmp_path):
    missing = tmp_path / "does_not_exist.log"
    roll_log_if_oversized(missing, max_bytes=1000)  # must not raise


def test_roll_log_exact_limit_not_rolled(tmp_path):
    log = tmp_path / "test.log"
    log.write_bytes(b"x" * 100)
    roll_log_if_oversized(log, max_bytes=100)
    assert log.exists()
    assert not (tmp_path / "test.prev.log").exists()


def test_roll_log_one_byte_over_rolls(tmp_path):
    log = tmp_path / "test.log"
    log.write_bytes(b"x" * 101)
    roll_log_if_oversized(log, max_bytes=100)
    assert not log.exists()
    assert (tmp_path / "test.prev.log").exists()


# ---------------------------------------------------------------------------
# worker._parse_and_group_entries
# ---------------------------------------------------------------------------

# Valid SHA-1 hex hash used across worker tests.
_VALID_HASH = "a" * 40


def test_parse_and_group_empty_input_returns_empty_dict():
    result = _parse_and_group_entries([])
    assert result == {}


def test_parse_and_group_valid_entries_grouped_by_hash():
    entries = [
        {"project_hash": _VALID_HASH, "path": "src/foo.py"},
        {"project_hash": _VALID_HASH, "path": "src/bar.py"},
    ]
    result = _parse_and_group_entries(entries)
    assert _VALID_HASH in result
    assert result[_VALID_HASH]["rels"] == {"src/foo.py", "src/bar.py"}


def test_parse_and_group_entries_missing_path_are_skipped():
    entries = [
        {"project_hash": _VALID_HASH},  # no path
    ]
    result = _parse_and_group_entries(entries)
    assert result == {}


def test_parse_and_group_entries_missing_hash_are_skipped():
    entries = [
        {"path": "src/foo.py"},  # no project_hash
    ]
    result = _parse_and_group_entries(entries)
    assert result == {}


def test_parse_and_group_invalid_project_hash_skipped():
    entries = [
        {"project_hash": "INVALID-HASH!", "path": "src/foo.py"},
    ]
    result = _parse_and_group_entries(entries)
    assert result == {}


def test_parse_and_group_multiple_projects():
    hash2 = "b" * 40
    entries = [
        {"project_hash": _VALID_HASH, "path": "a.py"},
        {"project_hash": hash2, "path": "b.py"},
    ]
    result = _parse_and_group_entries(entries)
    assert _VALID_HASH in result
    assert hash2 in result
    assert "a.py" in result[_VALID_HASH]["rels"]
    assert "b.py" in result[hash2]["rels"]


def test_parse_and_group_carries_project_root_from_first_entry():
    entries = [
        {"project_hash": _VALID_HASH, "path": "a.py", "project_root": "/myproject", "project_marker": "git"},
        {"project_hash": _VALID_HASH, "path": "b.py", "project_root": "/other", "project_marker": "manual"},
    ]
    result = _parse_and_group_entries(entries)
    bucket = result[_VALID_HASH]
    assert bucket["root"] == "/myproject"
    assert bucket["marker"] == "git"


def test_parse_and_group_unsafe_rel_path_skipped():
    entries = [
        {"project_hash": _VALID_HASH, "path": "../../../etc/passwd"},
    ]
    result = _parse_and_group_entries(entries)
    assert result == {}


# ---------------------------------------------------------------------------
# bash_parser.parse
# ---------------------------------------------------------------------------


def test_parse_oversized_command_returns_unknown():
    big = "cat " + ("x" * (_MAX_COMMAND_BYTES + 1))
    result = parse(big)
    assert result.kind == "unknown"
    assert result.reason is not None
    assert "too long" in result.reason


def test_parse_cat_file_returns_read():
    result = parse("cat /path/to/file.py")
    assert result.kind == "read"
    assert result.target_path == "/path/to/file.py"


def test_parse_head_n_10_returns_read_with_limit():
    result = parse("head -n 10 /some/file.txt")
    assert result.kind == "read"
    assert result.limit == 10
    assert result.target_path == "/some/file.txt"


def test_parse_unknown_command_returns_unknown():
    result = parse("python script.py")
    assert result.kind == "unknown"


def test_parse_empty_command_returns_unknown():
    result = parse("")
    assert result.kind == "unknown"


def test_parse_at_exact_limit_does_not_reject():
    # A command exactly at the limit must not be rejected for length.
    cmd = "cat " + ("x" * (_MAX_COMMAND_BYTES - 4))
    assert len(cmd) == _MAX_COMMAND_BYTES
    result = parse(cmd)
    # Should not return "command too long" — it may be unknown for other reasons
    assert result.reason != "command too long"


def test_parse_grep_command_returns_grep():
    result = parse("grep -r 'pattern' /some/dir")
    assert result.kind == "grep"


def test_parse_rg_command_returns_grep():
    result = parse("rg 'mypattern' src/")
    assert result.kind == "grep"


def test_parse_find_command_returns_glob():
    result = parse("find . -name '*.py'")
    assert result.kind == "glob"


def test_parse_bat_file_returns_read():
    result = parse("bat /path/to/file.rs")
    assert result.kind == "read"
    assert result.target_path == "/path/to/file.rs"


def test_parse_tail_command_returns_read():
    result = parse("tail /path/to/file.log")
    assert result.kind == "read"
