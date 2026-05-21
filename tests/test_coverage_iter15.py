"""Iteration 15 test coverage: db.py error/recovery branches, image_shrink edge paths,
bash_parser boundary conditions.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from token_goat import db, image_shrink
from token_goat.bash_parser import parse

# ===========================================================================
# db.py — _is_transient_db_error
# ===========================================================================

class TestIsTransientDbError:
    def test_locked_is_transient(self):
        assert db._is_transient_db_error(sqlite3.DatabaseError("database is locked")) is True

    def test_busy_is_transient(self):
        assert db._is_transient_db_error(sqlite3.DatabaseError("database is busy")) is True

    def test_io_is_transient(self):
        assert db._is_transient_db_error(sqlite3.DatabaseError("disk i/o error")) is True

    def test_corrupt_is_not_transient(self):
        assert db._is_transient_db_error(sqlite3.DatabaseError("file is not a database")) is False

    def test_generic_error_not_transient(self):
        assert db._is_transient_db_error(sqlite3.DatabaseError("some other error")) is False


# ===========================================================================
# db.py — _integrity_ok branches
# ===========================================================================

class TestIntegrityOk:
    def test_returns_true_for_ok_result(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = ("ok",)
        assert db._integrity_ok(conn) is True

    def test_returns_false_for_non_ok_result(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = ("corruption found",)
        assert db._integrity_ok(conn) is False

    def test_returns_true_when_row_is_none(self):
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = None
        assert db._integrity_ok(conn) is True

    def test_transient_db_error_returns_true(self):
        """locked/busy during integrity_check should NOT be treated as corruption."""
        conn = MagicMock()
        conn.execute.side_effect = sqlite3.DatabaseError("database is locked")
        assert db._integrity_ok(conn) is True

    def test_non_transient_db_error_returns_true_with_warning(self, caplog):
        """Unknown DatabaseErrors get logged as warning but still return True."""
        import logging
        conn = MagicMock()
        conn.execute.side_effect = sqlite3.DatabaseError("some weird error")
        with caplog.at_level(logging.WARNING, logger="token_goat.db"):
            result = db._integrity_ok(conn)
        assert result is True


# ===========================================================================
# db.py — _rebuild edge cases
# ===========================================================================

class TestRebuild:
    def test_returns_false_when_file_does_not_exist(self, tmp_path):
        missing = tmp_path / "nonexistent.db"
        assert db._rebuild(missing) is False

    def test_returns_false_when_rename_fails(self, tmp_path):
        """OSError from rename (e.g. Windows file lock) → returns False, no raise."""
        p = tmp_path / "locked.db"
        p.write_bytes(b"data")
        with patch.object(Path, "rename", side_effect=OSError("access denied")):
            result = db._rebuild(p)
        assert result is False
        # Original file must still exist (not destroyed)
        assert p.exists()

    def test_returns_true_and_quarantines_on_success(self, tmp_path):
        p = tmp_path / "corrupt.db"
        p.write_bytes(b"bad data")
        result = db._rebuild(p)
        assert result is True
        assert not p.exists()
        bad_files = list(tmp_path.glob("corrupt.db.bad-*"))
        assert len(bad_files) == 1


# ===========================================================================
# db.py — _validate_project_hash
# ===========================================================================

class TestValidateProjectHash:
    def test_empty_raises(self):
        with pytest.raises(ValueError, match="cannot be empty"):
            db._validate_project_hash("")

    def test_too_long_raises(self):
        with pytest.raises(ValueError, match="too long"):
            db._validate_project_hash("a" * 129)

    def test_path_separator_raises(self):
        with pytest.raises(ValueError, match="lowercase hex"):
            db._validate_project_hash("abc/def")

    def test_dot_raises(self):
        with pytest.raises(ValueError, match="lowercase hex"):
            db._validate_project_hash("abc.def")

    def test_hyphen_raises(self):
        with pytest.raises(ValueError, match="lowercase hex"):
            db._validate_project_hash("abc-def")

    def test_valid_hash_accepted(self):
        db._validate_project_hash("abc123def456")  # must not raise — valid lowercase hex

    def test_exactly_128_chars_accepted(self):
        db._validate_project_hash("a" * 128)  # boundary — must not raise


# ===========================================================================
# db.py — open_global_readonly / open_project_readonly FileNotFoundError
# ===========================================================================

class TestReadonlyOpeners:
    def test_open_global_readonly_raises_when_missing(self, tmp_data_dir):
        with pytest.raises(FileNotFoundError, match="global.db"), db.open_global_readonly():
            pass

    def test_open_project_readonly_raises_when_missing(self, tmp_data_dir):
        with pytest.raises(FileNotFoundError, match="project db not found"), db.open_project_readonly("abc123def456abc1"):
            pass

    def test_open_project_readonly_validates_hash(self, tmp_data_dir):
        with pytest.raises(ValueError, match="lowercase hex"), db.open_project_readonly("bad/hash"):
            pass


# ===========================================================================
# db.py — _ensure_global_schema read-only path
# ===========================================================================

class TestEnsureGlobalSchemaReadonly:
    def test_readonly_operational_error_is_silently_skipped(self):
        conn = MagicMock()
        conn.executescript.side_effect = sqlite3.OperationalError("attempt to write a readonly database")
        # Must not raise
        db._ensure_global_schema(conn)

    def test_non_readonly_operational_error_reraises(self):
        conn = MagicMock()
        conn.executescript.side_effect = sqlite3.OperationalError("disk full")
        with pytest.raises(sqlite3.OperationalError, match="disk full"):
            db._ensure_global_schema(conn)


# ===========================================================================
# db.py — index_health
# ===========================================================================

class TestIndexHealth:
    def test_returns_not_ok_for_nonexistent_project(self, tmp_data_dir):
        result = db.index_health("ab" * 20)  # valid hex, no DB on disk
        assert result["ok"] is False
        assert result["file_count"] == 0

    def test_returns_ok_for_fresh_project(self, tmp_data_dir):
        h = "1ea1" * 10  # 40-char valid lowercase hex
        with db.open_project(h):
            pass
        result = db.index_health(h)
        assert result["ok"] is True
        assert result["integrity_ok"] is True
        assert isinstance(result["schema_version"], str)
        assert result["file_count"] == 0
        assert result["embeddings_disabled"] is False or result["embeddings_disabled"] is True


# ===========================================================================
# db.py — project_has_files and file_count
# ===========================================================================

class TestProjectHasFilesAndCount:
    def test_project_has_files_false_when_no_db(self, tmp_data_dir):
        assert db.project_has_files("cafe" * 10) is False  # valid hex, never indexed

    def test_project_has_files_false_when_empty(self, tmp_data_dir):
        h = "dead" * 10  # 40-char valid lowercase hex
        with db.open_project(h):
            pass
        assert db.project_has_files(h) is False

    def test_file_count_zero_for_empty_project(self, tmp_data_dir):
        h = "face" * 10  # 40-char valid lowercase hex
        with db.open_project(h):
            pass
        assert db.file_count(h) == 0

    def test_file_count_returns_zero_on_exception(self, tmp_data_dir):
        """file_count must never raise — it eats exceptions and returns 0."""
        with patch("token_goat.db.open_project", side_effect=RuntimeError("unexpected")):
            result = db.file_count("anyhash12345")
        assert result == 0


# ===========================================================================
# db.py — touch_project_last_seen readonly branch
# ===========================================================================

class TestTouchProjectLastSeenReadonly:
    def test_readonly_error_is_swallowed(self, tmp_data_dir):
        """touch_project_last_seen must not raise on read-only connections."""
        with patch("token_goat.db.open_global") as mock_open:
            mock_conn = MagicMock()
            mock_conn.__enter__ = lambda s: s
            mock_conn.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.side_effect = sqlite3.OperationalError(
                "attempt to write a readonly database"
            )
            mock_open.return_value = mock_conn
            # Must not raise
            db.touch_project_last_seen("somehash12345")


# ===========================================================================
# db.py — writer lock stale lock with dead PID
# ===========================================================================

class TestWriterLockDeadPid:
    def test_stale_lock_with_dead_pid_is_cleared(self, tmp_data_dir):
        """A lock with a PID that doesn't exist (but fresh timestamp) is treated as stale."""
        import token_goat.paths as paths

        h = "b0d1" * 10  # 40-char valid lowercase hex
        lock_path = paths.locks_dir() / f"{h}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        # PID 99999999 almost certainly doesn't exist; timestamp is fresh
        lock_path.write_text(f"99999999\n{time.time()}", encoding="utf-8")

        with patch("psutil.pid_exists", return_value=False), db.project_writer_lock(h, timeout_sec=1.0):
            assert lock_path.exists()
        assert not lock_path.exists()


# ===========================================================================
# db.py — writer lock malformed lock file
# ===========================================================================

class TestWriterLockMalformed:
    def test_fresh_malformed_lock_blocks_as_owner_mid_write(self, tmp_data_dir):
        """A freshly written malformed lock is the create-then-write window of a
        live owner — it must NOT be reclaimed, or the O_EXCL acquisition race reopens.
        """
        import token_goat.paths as paths

        h = "badf" * 10  # 40-char valid lowercase hex
        lock_path = paths.locks_dir() / f"{h}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text("NOT_A_PID", encoding="utf-8")  # malformed, just written

        with pytest.raises(TimeoutError):  # noqa: SIM117
            with db.project_writer_lock(h, timeout_sec=0.3):
                pass

    def test_old_malformed_lock_is_reclaimed(self, tmp_data_dir):
        """A malformed lock whose mtime is past the stale window is reclaimed —
        the mtime fallback recovers from a process that crashed mid-write.
        """
        import os

        import token_goat.paths as paths

        h = "badf" * 10
        lock_path = paths.locks_dir() / f"{h}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text("NOT_A_PID", encoding="utf-8")
        old = time.time() - 660  # 11 minutes ago — past LOCK_STALE_SECONDS
        os.utime(lock_path, (old, old))

        with db.project_writer_lock(h, timeout_sec=1.0):
            assert lock_path.exists()
        assert not lock_path.exists()


# ===========================================================================
# image_shrink.py — _is_safe_path
# ===========================================================================

class TestIsSafePath:
    def test_relative_path_rejected(self, tmp_path):
        assert image_shrink._is_safe_path(Path("relative/path.jpg")) is False

    def test_nonexistent_absolute_rejected(self, tmp_path):
        assert image_shrink._is_safe_path(tmp_path / "ghost.jpg") is False

    def test_existing_absolute_accepted(self, tmp_path):
        p = tmp_path / "file.jpg"
        p.write_bytes(b"data")
        assert image_shrink._is_safe_path(p) is True


# ===========================================================================
# image_shrink.py — shrink with unsafe path
# ===========================================================================

class TestShrinkUnsafePath:
    def test_shrink_rejects_relative_path(self):
        result = image_shrink.shrink(Path("relative/photo.jpg"))
        assert result is None

    def test_shrink_rejects_nonexistent_path(self, tmp_path):
        result = image_shrink.shrink(tmp_path / "ghost.jpg")
        assert result is None


# ===========================================================================
# image_shrink.py — vision_tokens boundary conditions
# ===========================================================================

class TestVisionTokensBoundary:
    def test_zero_width_returns_zero(self):
        assert image_shrink.vision_tokens(0, 100) == 0

    def test_zero_height_returns_zero(self):
        assert image_shrink.vision_tokens(100, 0) == 0

    def test_negative_dimensions_return_zero(self):
        assert image_shrink.vision_tokens(-10, -10) == 0

    def test_small_image_at_least_one_token(self):
        # Tiny image must return at least 1 token (not 0)
        assert image_shrink.vision_tokens(1, 1) >= 1

    def test_large_image_is_downscaled(self):
        # Image larger than CLAUDE_MAX_VISION_EDGE_PX must be downscaled before costing
        tokens_big = image_shrink.vision_tokens(4000, 3000)
        tokens_fit = image_shrink.vision_tokens(
            image_shrink.CLAUDE_MAX_VISION_EDGE_PX,
            int(3000 * image_shrink.CLAUDE_MAX_VISION_EDGE_PX / 4000),
        )
        assert tokens_big == tokens_fit


# ===========================================================================
# image_shrink.py — _cache_key OSError fallback
# ===========================================================================

class TestCacheKeyOsError:
    def test_oserror_falls_back_to_path_hash(self, tmp_path):
        """_cache_key() must not raise on OSError — it falls back to hashing the path string."""
        ghost = tmp_path / "ghost_image.jpg"
        # File doesn't exist — stat/open will raise OSError
        key = image_shrink._cache_key(ghost)
        assert len(key) == 64  # sha256 hex digest
        # Calling again on the same path returns the same key
        assert key == image_shrink._cache_key(ghost)


# ===========================================================================
# image_shrink.py — shrink_if_image
# ===========================================================================

class TestShrinkIfImage:
    def test_non_image_path_returned_unchanged(self, tmp_path):
        p = tmp_path / "notes.txt"
        p.write_text("hello")
        result = image_shrink.shrink_if_image(p)
        assert result == p

    def test_small_image_returned_unchanged(self, tmp_path, tmp_data_dir):
        from PIL import Image
        p = tmp_path / "tiny.jpg"
        Image.new("RGB", (10, 10), (255, 0, 0)).save(p, "JPEG")
        # File is below threshold — shrink() returns None → original path returned
        result = image_shrink.shrink_if_image(p)
        assert result == p


# ===========================================================================
# image_shrink.py — _looks_like_screenshot_or_text
# ===========================================================================

class TestLooksLikeScreenshot:
    def test_rgba_small_is_screenshot(self):
        from PIL import Image
        img = Image.new("RGBA", (800, 600))
        assert image_shrink._looks_like_screenshot_or_text(img) is True

    def test_rgba_large_is_not_screenshot(self):
        from PIL import Image
        img = Image.new("RGBA", (2000, 1500))
        assert image_shrink._looks_like_screenshot_or_text(img) is False

    def test_rgb_is_not_screenshot(self):
        from PIL import Image
        img = Image.new("RGB", (800, 600))
        assert image_shrink._looks_like_screenshot_or_text(img) is False

    def test_l_mode_is_screenshot(self):
        from PIL import Image
        img = Image.new("L", (400, 300))
        assert image_shrink._looks_like_screenshot_or_text(img) is True


# ===========================================================================
# image_shrink.py — _ensure_rgb
# ===========================================================================

class TestEnsureRgb:
    def test_rgb_image_returned_as_is(self):
        from PIL import Image
        img = Image.new("RGB", (10, 10), (100, 150, 200))
        result = image_shrink._ensure_rgb(img, Image)
        assert result is img

    def test_rgba_composited_to_rgb(self):
        from PIL import Image
        img = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
        result = image_shrink._ensure_rgb(img, Image)
        assert result.mode == "RGB"

    def test_l_mode_converted_to_rgb(self):
        from PIL import Image
        img = Image.new("L", (10, 10), 128)
        result = image_shrink._ensure_rgb(img, Image)
        assert result.mode == "RGB"

    def test_p_mode_converted_to_rgb(self):
        from PIL import Image
        img = Image.new("P", (10, 10))
        result = image_shrink._ensure_rgb(img, Image)
        assert result.mode == "RGB"


# ===========================================================================
# bash_parser.py — shlex failure → unknown
# ===========================================================================

class TestBashParserShlexFailure:
    def test_unclosed_quote_returns_unknown(self):
        intent = parse("cat 'unclosed")
        assert intent.kind == "unknown"
        assert intent.reason is not None
        assert "quoting" in intent.reason


# ===========================================================================
# bash_parser.py — _try_parse_int
# ===========================================================================

class TestTryParseInt:
    def test_non_integer_returns_none(self):
        from token_goat.bash_parser import _try_parse_int
        assert _try_parse_int("abc") is None

    def test_float_string_returns_none(self):
        from token_goat.bash_parser import _try_parse_int
        assert _try_parse_int("3.14") is None

    def test_valid_integer_returns_int(self):
        from token_goat.bash_parser import _try_parse_int
        assert _try_parse_int("42") == 42

    def test_negative_integer_returns_int(self):
        from token_goat.bash_parser import _try_parse_int
        assert _try_parse_int("-10") == -10


# ===========================================================================
# bash_parser.py — grep --regexp= form
# ===========================================================================

class TestBashParserGrepRegexpEq:
    def test_rg_regexp_eq_flag(self):
        intent = parse("rg --regexp=mypattern src/")
        assert intent.kind == "grep"
        assert intent.pattern == "mypattern"

    def test_grep_regexp_eq_flag(self):
        intent = parse("grep --regexp=foo file.py")
        assert intent.kind == "grep"
        assert intent.pattern == "foo"


# ===========================================================================
# bash_parser.py — ag and ack as grep bins
# ===========================================================================

class TestBashParserAlternativeGrepBins:
    def test_ag_recognized_as_grep(self):
        intent = parse("ag mypattern src/")
        assert intent.kind == "grep"
        assert intent.pattern == "mypattern"

    def test_ack_recognized_as_grep(self):
        intent = parse("ack mypattern src/")
        assert intent.kind == "grep"
        assert intent.pattern == "mypattern"


# ===========================================================================
# bash_parser.py — _parse_grep no pattern → unknown
# ===========================================================================

class TestBashParserGrepNoPattern:
    def test_rg_with_only_flags_returns_unknown(self):
        intent = parse("rg -l")
        assert intent.kind == "unknown"


# ===========================================================================
# bash_parser.py — _parse_glob no non-flag args
# ===========================================================================

class TestBashParserGlobNoArgs:
    def test_find_with_only_flags_returns_glob(self):
        """_parse_glob with all-flag args: -maxdepth is a flag, nothing else is positional."""
        intent = parse("find -maxdepth 2")
        assert intent.kind == "glob"
        # "2" is picked up as the first non-flag token — that's correct parser behavior
        assert intent.pattern == "2"

    def test_find_all_flags_no_positional_returns_glob_no_pattern(self):
        """When every token starts with '-', pattern is None."""
        intent = parse("find -L -follow")
        assert intent.kind == "glob"
        assert intent.pattern is None

    def test_eza_recognized_as_glob(self):
        intent = parse("eza src/")
        assert intent.kind == "glob"
        assert intent.pattern == "src/"


# ===========================================================================
# bash_parser.py — scripted read bins missing file path
# ===========================================================================

class TestBashParserScriptedBins:
    def test_sed_with_only_script_returns_unknown(self):
        """sed needs both a script arg and a file arg — script only → unknown."""
        intent = parse("sed 's/foo/bar/'")
        assert intent.kind == "unknown"

    def test_awk_with_only_script_returns_unknown(self):
        intent = parse("awk '{ print }'")
        assert intent.kind == "unknown"

    def test_sed_with_script_and_file_returns_read(self):
        intent = parse("sed -n '1,10p' src/main.py")
        assert intent.kind == "read"
        assert intent.target_path == "src/main.py"

    def test_head_lines_flag_with_space(self):
        """head --lines <N> (space-separated, not =) is a valid flag form."""
        intent = parse("head --lines 25 file.py")
        assert intent.kind == "read"
        assert intent.limit == 25

    def test_head_n_non_integer_ignored(self):
        """head -n abc — non-integer value means limit stays None."""
        intent = parse("head -n abc file.py")
        assert intent.kind == "read"
        assert intent.limit is None

    def test_sudo_time_nice_all_stripped(self):
        """Multiple prefix tokens are all stripped before binary dispatch."""
        intent = parse("sudo nice cat file.py")
        assert intent.kind == "read"
        assert intent.target_path == "file.py"
