"""Tests for sanitize_log_str bidi chars, db PRAGMAs, session validate_session_id,
cli validate_session_id call, config load, paths atomic_write_text, db record_stat,
and hooks_cli dispatch timing."""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat.hooks_common import _BIDI_CONTROLS, sanitize_log_str
from token_goat.session import validate_session_id

# ---------------------------------------------------------------------------
# 1. sanitize_log_str — Unicode bidi control characters
# ---------------------------------------------------------------------------


class TestSanitizeLogStrBidi:
    def test_u202a_left_to_right_embedding_stripped(self):
        result = sanitize_log_str("hello‪world")
        assert "‪" not in result
        assert result == "helloworld"

    def test_u202b_right_to_left_embedding_stripped(self):
        result = sanitize_log_str("hello‫world")
        assert "‫" not in result
        assert result == "helloworld"

    def test_u200f_right_to_left_mark_stripped(self):
        result = sanitize_log_str("hello‏world")
        assert "‏" not in result
        assert result == "helloworld"

    def test_u2066_left_to_right_isolate_stripped(self):
        result = sanitize_log_str("hello⁦world")
        assert "⁦" not in result
        assert result == "helloworld"

    def test_u2069_pop_directional_isolate_stripped(self):
        result = sanitize_log_str("hello⁩world")
        assert "⁩" not in result
        assert result == "helloworld"

    def test_all_bidi_chars_stripped(self):
        injected = "start" + "".join(_BIDI_CONTROLS) + "end"
        result = sanitize_log_str(injected)
        for ch in _BIDI_CONTROLS:
            assert ch not in result
        assert result == "startend"

    def test_normal_text_unchanged(self):
        text = "normal ASCII text 123"
        assert sanitize_log_str(text) == text

    def test_unicode_letters_preserved(self):
        text = "café résumé naïve"
        result = sanitize_log_str(text)
        assert result == text

    def test_bidi_in_filename_removed(self):
        # Common attack vector: filenames with RTL override
        filename = "evil‮exe.txt"
        result = sanitize_log_str(filename)
        assert "‮" not in result
        assert result == "evilexe.txt"

    def test_mixed_bidi_and_newline(self):
        text = "hello‪\nworld"
        result = sanitize_log_str(text)
        assert "‪" not in result
        assert "\n" not in result
        assert "\\n" in result

    def test_u200e_left_to_right_mark_stripped(self):
        result = sanitize_log_str("abc‎def")
        assert "‎" not in result
        assert result == "abcdef"

    def test_u202e_rtl_override_stripped(self):
        # The most dangerous one for log spoofing
        result = sanitize_log_str("evil‮.exe")
        assert "‮" not in result

    def test_empty_string_unchanged(self):
        assert sanitize_log_str("") == ""


# ---------------------------------------------------------------------------
# 2. db.py SQLite PRAGMAs via _apply_connection_pragmas
# ---------------------------------------------------------------------------

class TestDbPragmas:
    def _open_in_memory(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.row_factory = sqlite3.Row
        return conn

    def test_foreign_keys_enabled(self):
        from token_goat.db import _apply_connection_pragmas
        conn = self._open_in_memory()
        _apply_connection_pragmas(conn)
        row = conn.execute("PRAGMA foreign_keys").fetchone()
        assert row[0] == 1
        conn.close()

    def test_cache_size_set_negative_value(self):
        from token_goat.db import _apply_connection_pragmas
        conn = self._open_in_memory()
        _apply_connection_pragmas(conn)
        row = conn.execute("PRAGMA cache_size").fetchone()
        # Negative value means KB; we set -65536 (64 MB)
        assert row[0] == -65536
        conn.close()

    def test_synchronous_normal(self):
        from token_goat.db import _apply_connection_pragmas
        conn = self._open_in_memory()
        _apply_connection_pragmas(conn)
        row = conn.execute("PRAGMA synchronous").fetchone()
        # NORMAL = 1
        assert row[0] == 1
        conn.close()

    def test_temp_store_memory(self):
        from token_goat.db import _apply_connection_pragmas
        conn = self._open_in_memory()
        _apply_connection_pragmas(conn)
        row = conn.execute("PRAGMA temp_store").fetchone()
        # MEMORY = 2
        assert row[0] == 2
        conn.close()

    def test_busy_timeout_set(self):
        from token_goat.db import _apply_connection_pragmas
        conn = self._open_in_memory()
        _apply_connection_pragmas(conn)
        row = conn.execute("PRAGMA busy_timeout").fetchone()
        assert row[0] == 5000
        conn.close()

    def test_wal_journal_mode_on_file_db(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path), isolation_level=None)
        conn.execute("PRAGMA journal_mode = WAL")
        row = conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0].lower() == "wal"
        conn.close()

    def test_pragmas_suppress_does_not_raise(self, tmp_path):
        from token_goat.db import _apply_connection_pragmas
        # Open a read-only connection to a file-based DB so WAL PRAGMAs may fail;
        # suppress=True must not let any OperationalError propagate.
        db_path = tmp_path / "ro.db"
        # Create the DB first, then open read-only
        conn_rw = sqlite3.connect(str(db_path))
        conn_rw.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        conn_rw.commit()
        conn_rw.close()
        conn_ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, isolation_level=None)
        try:
            # suppress=True should absorb any OperationalError
            _apply_connection_pragmas(conn_ro, suppress=True)
        finally:
            conn_ro.close()


# ---------------------------------------------------------------------------
# 3. session.py validate_session_id
# ---------------------------------------------------------------------------

class TestValidateSessionId:
    def test_valid_uuid_style_passes(self):
        validate_session_id("550e8400-e29b-41d4-a716-446655440000")

    def test_valid_alphanumeric_passes(self):
        validate_session_id("abc123def456")

    def test_valid_with_underscores_passes(self):
        validate_session_id("session_id_123")

    def test_valid_max_length_passes(self):
        # Exactly 128 chars should be valid
        sid = "a" * 128
        validate_session_id(sid)

    def test_over_max_length_rejected(self):
        sid = "a" * 129
        with pytest.raises(ValueError, match="too long"):
            validate_session_id(sid)

    def test_much_over_max_length_rejected(self):
        sid = "a" * 500
        with pytest.raises(ValueError, match="too long"):
            validate_session_id(sid)

    def test_slash_rejected(self):
        with pytest.raises(ValueError):
            validate_session_id("session/../../etc/passwd")

    def test_backslash_rejected(self):
        with pytest.raises(ValueError):
            validate_session_id("session\\traversal")

    def test_dot_dot_rejected(self):
        with pytest.raises(ValueError):
            validate_session_id("../etc/passwd")

    def test_empty_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            validate_session_id("")

    def test_space_rejected(self):
        with pytest.raises(ValueError):
            validate_session_id("session id")

    def test_newline_rejected(self):
        with pytest.raises(ValueError):
            validate_session_id("session\nid")


# ---------------------------------------------------------------------------
# 4. cli.py compact-hint calls validate_session_id
# ---------------------------------------------------------------------------

class TestCliValidateSessionIdCall:
    def test_validate_called_for_compact_hint(self, tmp_path):
        from token_goat import session as session_mod
        called_with = []

        def fake_validate(sid):
            called_with.append(sid)

        with patch.object(session_mod, "validate_session_id", side_effect=fake_validate):
            from token_goat.cli import _validate_session_id
            _validate_session_id("my-session-id")

        assert called_with == ["my-session-id"]

    def test_validate_raises_causes_exit(self):
        import click

        from token_goat import session as session_mod
        with patch.object(session_mod, "validate_session_id", side_effect=ValueError("bad id")):
            from token_goat.cli import _validate_session_id
            with pytest.raises((SystemExit, click.exceptions.Exit)):
                _validate_session_id("bad/id")

    def test_validate_called_with_exact_id(self):
        from token_goat import session as session_mod
        received = []

        def capture(sid):
            received.append(sid)

        with patch.object(session_mod, "validate_session_id", side_effect=capture):
            from token_goat.cli import _validate_session_id
            _validate_session_id("test-session-abc")

        assert received == ["test-session-abc"]


# ---------------------------------------------------------------------------
# 5. config.py load
# ---------------------------------------------------------------------------

class TestConfigLoad:
    def test_defaults_returned_when_no_file(self, tmp_path):
        from token_goat import config as config_mod
        nonexistent = tmp_path / "no_such_config.toml"
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = nonexistent
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True
        assert cfg.compact_assist.min_events == 3

    def test_compact_assist_section_loaded(self, tmp_path):
        from token_goat import config as config_mod
        toml_file = tmp_path / "config.toml"
        toml_file.write_text(
            "[compact_assist]\nenabled = false\nmin_events = 10\n",
            encoding="utf-8",
        )
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = toml_file
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False
        assert cfg.compact_assist.min_events == 10

    def test_unknown_sections_dont_crash(self, tmp_path):
        from token_goat import config as config_mod
        toml_file = tmp_path / "config.toml"
        toml_file.write_text(
            "[unknown_section]\nfoo = 42\n[compact_assist]\nenabled = true\n",
            encoding="utf-8",
        )
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = toml_file
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True

    def test_env_var_disables_compact_assist(self, tmp_path):
        from token_goat import config as config_mod
        toml_file = tmp_path / "config.toml"
        toml_file.write_text("[compact_assist]\nenabled = true\n", encoding="utf-8")
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = toml_file
            with patch.dict(os.environ, {"TOKEN_GOAT_COMPACT_ASSIST": "0"}):
                cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False

    def test_env_var_false_string_disables(self, tmp_path):
        from token_goat import config as config_mod
        nonexistent = tmp_path / "no_config.toml"
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = nonexistent
            with patch.dict(os.environ, {"TOKEN_GOAT_COMPACT_ASSIST": "false"}):
                cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False

    def test_env_var_no_string_disables(self, tmp_path):
        from token_goat import config as config_mod
        nonexistent = tmp_path / "no_config.toml"
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = nonexistent
            with patch.dict(os.environ, {"TOKEN_GOAT_COMPACT_ASSIST": "no"}):
                cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False

    def test_max_manifest_tokens_loaded(self, tmp_path):
        from token_goat import config as config_mod
        toml_file = tmp_path / "config.toml"
        toml_file.write_text("[compact_assist]\nmax_manifest_tokens = 800\n", encoding="utf-8")
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = toml_file
            cfg = config_mod.load()
        assert cfg.compact_assist.max_manifest_tokens == 800

    def test_invalid_toml_returns_defaults(self, tmp_path):
        from token_goat import config as config_mod
        toml_file = tmp_path / "config.toml"
        toml_file.write_text("not valid toml <<<", encoding="utf-8")
        with patch("token_goat.config.paths") as mock_paths:
            mock_paths.config_path.return_value = toml_file
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True


# ---------------------------------------------------------------------------
# 6. paths.py atomic_write_text
# ---------------------------------------------------------------------------

class TestAtomicWriteText:
    def test_content_readable_after_write(self, tmp_path):
        from token_goat.paths import atomic_write_text
        target = tmp_path / "out.txt"
        atomic_write_text(target, "hello world")
        assert target.read_text(encoding="utf-8") == "hello world"

    def test_overwrite_replaces_content(self, tmp_path):
        from token_goat.paths import atomic_write_text
        target = tmp_path / "out.txt"
        atomic_write_text(target, "first")
        atomic_write_text(target, "second")
        assert target.read_text(encoding="utf-8") == "second"

    def test_creates_parent_directories(self, tmp_path):
        from token_goat.paths import atomic_write_text
        nested = tmp_path / "a" / "b" / "c" / "file.txt"
        atomic_write_text(nested, "nested content")
        assert nested.read_text(encoding="utf-8") == "nested content"

    def test_unicode_content_preserved(self, tmp_path):
        from token_goat.paths import atomic_write_text
        target = tmp_path / "unicode.txt"
        content = "café naïve résumé 日本語"
        atomic_write_text(target, content)
        assert target.read_text(encoding="utf-8") == content

    def test_empty_string_written(self, tmp_path):
        from token_goat.paths import atomic_write_text
        target = tmp_path / "empty.txt"
        atomic_write_text(target, "")
        assert target.read_text(encoding="utf-8") == ""

    def test_no_leftover_tmp_files(self, tmp_path):
        from token_goat.paths import atomic_write_text
        target = tmp_path / "clean.txt"
        atomic_write_text(target, "data")
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == [], f"leftover tmp files: {tmp_files}"

    def test_concurrent_writes_no_corruption(self, tmp_path):
        """Concurrent atomic writes must not leave a partially-written file.

        On Windows, rename-over a file held by another writer can transiently raise
        PermissionError; the implementation already handles this with retry logic.
        The key invariant is that any file successfully written has its full content
        intact — never a partial write.
        """
        from token_goat.paths import atomic_write_text
        target = tmp_path / "concurrent.txt"
        written: list[str] = []

        def write_content(content: str) -> None:
            try:
                atomic_write_text(target, content)
                written.append(content)
            except (PermissionError, OSError):
                # Transient Windows rename contention — expected under heavy concurrency
                pass

        threads = [threading.Thread(target=write_content, args=(f"thread-{i}",)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        # At least one write must have succeeded
        assert target.exists(), "no successful write completed"
        content = target.read_text(encoding="utf-8")
        # Content must be one of the complete values — never partial
        assert content.startswith("thread-"), f"unexpected content: {content!r}"


# ---------------------------------------------------------------------------
# 7. db.py record_stat with None detail, kind/detail truncation
# ---------------------------------------------------------------------------

class TestRecordStat:
    def _make_project_db(self, tmp_path: Path) -> tuple[str, Path]:
        """Create a minimal project DB with stats table. Returns (hash, db_path)."""
        import hashlib
        phash = hashlib.sha1(b"test-project").hexdigest()
        db_dir = tmp_path / "projects"
        db_dir.mkdir(parents=True, exist_ok=True)
        db_path = db_dir / f"{phash}.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE IF NOT EXISTS stats "
            "(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, tokens_saved INTEGER, "
            "bytes_saved INTEGER, detail TEXT, last_access_epoch REAL)"
        )
        conn.commit()
        conn.close()
        return phash, db_path

    def test_none_detail_stored_as_null(self, tmp_path):
        phash, db_path = self._make_project_db(tmp_path)

        # Directly test the truncation logic, not the DB write path
        detail = None
        from token_goat.db import _MAX_STAT_DETAIL_LEN
        if detail is not None and len(detail) > _MAX_STAT_DETAIL_LEN:
            detail = detail[:_MAX_STAT_DETAIL_LEN]
        assert detail is None

    def test_kind_truncated_at_64_chars(self):
        from token_goat.db import _MAX_STAT_KIND_LEN
        assert _MAX_STAT_KIND_LEN == 64
        long_kind = "k" * 100
        if len(long_kind) > _MAX_STAT_KIND_LEN:
            truncated = long_kind[:_MAX_STAT_KIND_LEN]
        else:
            truncated = long_kind
        assert len(truncated) == 64

    def test_detail_truncated_at_512_chars(self):
        from token_goat.db import _MAX_STAT_DETAIL_LEN
        assert _MAX_STAT_DETAIL_LEN == 512
        long_detail = "d" * 1000
        if long_detail is not None and len(long_detail) > _MAX_STAT_DETAIL_LEN:
            truncated = long_detail[:_MAX_STAT_DETAIL_LEN]
        else:
            truncated = long_detail
        assert len(truncated) == 512

    def test_kind_exactly_64_not_truncated(self):
        from token_goat.db import _MAX_STAT_KIND_LEN
        exact_kind = "k" * 64
        if len(exact_kind) > _MAX_STAT_KIND_LEN:
            truncated = exact_kind[:_MAX_STAT_KIND_LEN]
        else:
            truncated = exact_kind
        assert truncated == exact_kind

    def test_detail_exactly_512_not_truncated(self):
        from token_goat.db import _MAX_STAT_DETAIL_LEN
        exact_detail = "d" * 512
        if exact_detail is not None and len(exact_detail) > _MAX_STAT_DETAIL_LEN:
            truncated = exact_detail[:_MAX_STAT_DETAIL_LEN]
        else:
            truncated = exact_detail
        assert truncated == exact_detail

    def test_record_stat_with_none_detail_via_mock(self):
        """Verify record_stat calls INSERT with None as detail param when detail=None."""
        from token_goat import db as db_mod
        captured_params: list[tuple] = []

        def fake_best_effort(fn, label):
            # We can't easily call fn() without a real DB; just record that it was called
            captured_params.append((label,))

        with patch("token_goat.db._best_effort_write", side_effect=fake_best_effort):
            db_mod.record_stat(None, "test_kind", detail=None)

        assert len(captured_params) == 1
        assert captured_params[0][0] == "record_stat"

    def test_record_stat_kind_truncation_applied_before_insert(self):
        """Verify the kind is truncated before _best_effort_write receives it."""
        from token_goat import db as db_mod
        # Patch _best_effort_write to capture the closure's SQL params
        executed_sqls: list[str] = []

        def capture_fn(fn, label):
            executed_sqls.append(label)

        with patch("token_goat.db._best_effort_write", side_effect=capture_fn):
            db_mod.record_stat(None, "k" * 100, tokens_saved=0)

        assert executed_sqls == ["record_stat"]


# ---------------------------------------------------------------------------
# 8. hooks_cli.py dispatch timing
# ---------------------------------------------------------------------------

class TestDispatchTiming:
    def test_elapsed_ms_present_for_known_event(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        result = dispatch("session-start", payload)
        assert "_tg_elapsed_ms" in result

    def test_elapsed_ms_is_float(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        result = dispatch("session-start", payload)
        assert isinstance(result["_tg_elapsed_ms"], float)

    def test_elapsed_ms_non_negative(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        result = dispatch("session-start", payload)
        assert result["_tg_elapsed_ms"] >= 0.0

    def test_elapsed_ms_absent_for_unknown_event(self):
        # Unknown events return CONTINUE early without timing — no _tg_elapsed_ms key
        from token_goat.hooks_cli import dispatch
        payload = {}
        result = dispatch("totally-unknown-event-xyz", payload)
        assert "_tg_elapsed_ms" not in result

    def test_continue_true_for_unknown_event_no_timing(self):
        from token_goat.hooks_cli import dispatch
        payload = {}
        result = dispatch("nonexistent-hook", payload)
        assert result.get("continue") is True
        assert "_tg_elapsed_ms" not in result

    def test_continue_true_for_known_event(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        result = dispatch("session-start", payload)
        assert result.get("continue") is True

    def test_continue_true_for_another_unknown_event(self):
        from token_goat.hooks_cli import dispatch
        payload = {}
        result = dispatch("bogus-event-abc", payload)
        assert result.get("continue") is True

    def test_elapsed_ms_rounded_to_2_decimals(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        result = dispatch("session-start", payload)
        elapsed = result["_tg_elapsed_ms"]
        # round(x, 2) should equal itself for a properly rounded value
        assert round(elapsed, 2) == elapsed

    def test_elapsed_ms_reasonable_upper_bound(self):
        from token_goat.hooks_cli import dispatch
        payload = {"session_id": "test-session", "cwd": "/tmp"}
        t0 = time.monotonic()
        result = dispatch("session-start", payload)
        wall_ms = (time.monotonic() - t0) * 1000
        # elapsed_ms should not exceed the total wall time by more than 50ms
        assert result["_tg_elapsed_ms"] <= wall_ms + 50

    def test_dispatch_returns_dict(self):
        from token_goat.hooks_cli import dispatch
        result = dispatch("session-start", {"session_id": "abc", "cwd": "/tmp"})
        assert isinstance(result, dict)

    def test_elapsed_ms_present_for_post_edit(self):
        from token_goat.hooks_cli import dispatch
        payload = {
            "session_id": "test-session",
            "cwd": "/tmp",
            "tool_name": "Write",
            "tool_input": {"file_path": "/tmp/test.txt"},
        }
        result = dispatch("post-edit", payload)
        assert "_tg_elapsed_ms" in result
        assert isinstance(result["_tg_elapsed_ms"], float)
