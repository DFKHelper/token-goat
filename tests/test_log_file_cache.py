"""Tests for log-file content cache (Iter 11).

Covers:
  - SessionCache.record_log_read / get_log_cache_hit round-trip
  - Cache miss: first read stores hash, output passes through
  - Cache hit same content: output suppressed with advisory
  - Cache hit changed mtime: treated as miss, output passes through
  - Non-log file: not cached
  - FIFO eviction at cap (LOG_FILE_CACHE_MAX)
  - to_dict / from_dict serialization round-trip
  - _is_log_file_path recognises expected patterns
"""
from __future__ import annotations

import hashlib
import time

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.hooks_read import _is_log_file_path
from token_goat.session import (
    _LOG_FILE_CACHE_EVICT,
    LOG_FILE_CACHE_MAX,
    SessionCache,
    _fresh_cache,
    _merge_session_caches,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post_bash_payload(sid: str, cmd: str, stdout: str, cwd: str, *, exit_code: int = 0) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _sha16(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# _is_log_file_path unit tests
# ---------------------------------------------------------------------------

class TestIsLogFilePath:
    def test_dot_log_extension(self):
        assert _is_log_file_path("/var/log/app.log")

    def test_dot_txt_not_log(self):
        assert not _is_log_file_path("/tmp/output.txt")

    def test_dot_out_extension(self):
        assert _is_log_file_path("/home/user/build.out")

    def test_log_directory_segment(self):
        assert _is_log_file_path("/var/log/syslog")

    def test_logs_directory_segment(self):
        assert _is_log_file_path("/srv/app/logs/access")

    def test_non_log_file(self):
        assert not _is_log_file_path("/src/main.py")

    def test_non_log_no_extension(self):
        assert not _is_log_file_path("/usr/bin/python")

    def test_case_insensitive_extension(self):
        assert _is_log_file_path("/var/LOG/app.LOG")

    def test_windows_style_path_normalized(self):
        # Paths arriving here are already forward-slash normalized
        assert _is_log_file_path("c:/app/logs/error.log")

    def test_path_containing_logword_not_as_segment(self):
        # "catalog" contains "log" but not as a /log/ segment
        assert not _is_log_file_path("/home/user/catalog/items.py")


# ---------------------------------------------------------------------------
# SessionCache unit tests
# ---------------------------------------------------------------------------

class TestLogFileCacheUnit:
    def test_record_and_retrieve(self):
        cache = _fresh_cache("test-lfc")
        cache.record_log_read("/var/log/app.log", 1024, 1700000000.0, "abc123def456abcd")
        result = cache.get_log_cache_hit("/var/log/app.log", 1024, 1700000000.0)
        assert result == "abc123def456abcd"

    def test_miss_on_wrong_size(self):
        cache = _fresh_cache("test-lfc-size")
        cache.record_log_read("/var/log/app.log", 1024, 1700000000.0, "abc123")
        assert cache.get_log_cache_hit("/var/log/app.log", 2048, 1700000000.0) is None

    def test_miss_on_wrong_mtime(self):
        cache = _fresh_cache("test-lfc-mtime")
        cache.record_log_read("/var/log/app.log", 1024, 1700000000.0, "abc123")
        assert cache.get_log_cache_hit("/var/log/app.log", 1024, 1700000001.0) is None

    def test_miss_on_wrong_path(self):
        cache = _fresh_cache("test-lfc-path")
        cache.record_log_read("/var/log/app.log", 1024, 1700000000.0, "abc123")
        assert cache.get_log_cache_hit("/var/log/other.log", 1024, 1700000000.0) is None

    def test_missing_key_returns_none(self):
        cache = _fresh_cache("test-lfc-empty")
        assert cache.get_log_cache_hit("/var/log/missing.log", 0, 0.0) is None

    def test_overwrite_updates_value(self):
        cache = _fresh_cache("test-lfc-overwrite")
        cache.record_log_read("/var/log/app.log", 512, 1700000000.0, "hash1")
        cache.record_log_read("/var/log/app.log", 512, 1700000000.0, "hash2")
        assert cache.get_log_cache_hit("/var/log/app.log", 512, 1700000000.0) == "hash2"

    def test_fifo_eviction_on_cap_exceeded(self):
        cache = _fresh_cache("test-lfc-evict")
        for i in range(LOG_FILE_CACHE_MAX):
            cache.record_log_read(f"/var/log/{i}.log", i, float(i), f"hash{i:016x}")
        assert len(cache.log_file_cache) == LOG_FILE_CACHE_MAX
        # One more entry triggers eviction
        cache.record_log_read("/var/log/overflow.log", 99999, 99999.0, "overflow" + "0" * 8)
        expected = LOG_FILE_CACHE_MAX - _LOG_FILE_CACHE_EVICT
        assert len(cache.log_file_cache) == expected
        # Newest entry survives
        assert cache.get_log_cache_hit("/var/log/overflow.log", 99999, 99999.0) == "overflow" + "0" * 8

    def test_to_dict_round_trip(self):
        cache = _fresh_cache("test-lfc-serial")
        cache.record_log_read("/var/log/app.log", 1024, 1700000000.123456789, "deadbeefdeadbeef")
        d = cache.to_dict()
        assert "log_file_cache" in d
        restored = SessionCache.from_dict(d)
        assert restored.get_log_cache_hit("/var/log/app.log", 1024, 1700000000.123456789) == "deadbeefdeadbeef"

    def test_from_dict_missing_field_defaults_empty(self):
        cache = _fresh_cache("test-lfc-compat")
        d = cache.to_dict()
        d.pop("log_file_cache", None)
        restored = SessionCache.from_dict(d)
        assert restored.log_file_cache == {}

    def test_merge_local_wins(self):
        local = _fresh_cache("local")
        remote = _fresh_cache("remote")
        local.session_id = remote.session_id = "shared"
        remote.record_log_read("/var/log/app.log", 100, 1.0, "remote_hash")
        local.record_log_read("/var/log/app.log", 100, 1.0, "local_hash")
        merged = _merge_session_caches(local, remote)
        assert merged.get_log_cache_hit("/var/log/app.log", 100, 1.0) == "local_hash"


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------

def _bootstrap_session(sid: str) -> None:
    """Persist a fresh (non-unavailable) session to disk so subsequent saves work.

    In production a session file is created by earlier hook invocations before
    post_bash runs. Integration tests must replicate this, otherwise load()
    returns an unavailable cache and save() is a no-op.
    """
    _session_mod.save(_fresh_cache(sid))


class TestLogFileCacheIntegration:
    """Test post_bash log-file cache logic using a real temp file.

    Every test uses ``tmp_data_dir`` so session saves go to an isolated
    temp directory and don't bleed across tests or touch production data.
    """

    def test_cache_miss_first_read_passes_through(self, tmp_path, tmp_data_dir):
        """First read of a log file: output passes through, cache populated."""
        sid = "sess-lfc-1"
        _bootstrap_session(sid)
        log = tmp_path / "app.log"
        log.write_text("line1\nline2\n")
        content = log.read_text()
        payload = _make_post_bash_payload(sid, f"cat {log}", content, str(tmp_path))
        result = hooks_read.post_bash(payload)
        # Should not suppress on first read
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_cache_hit_same_content_suppressed(self, tmp_path, tmp_data_dir):
        """Second read of unchanged log file: output suppressed."""
        sid = "sess-lfc-2"
        _bootstrap_session(sid)
        log = tmp_path / "app.log"
        log.write_text("line1\nline2\n")
        content = log.read_text()
        payload = _make_post_bash_payload(sid, f"cat {log}", content, str(tmp_path))

        # First call: populates cache
        hooks_read.post_bash(payload)

        # Second call: should suppress
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" in msg.lower() or "suppressed" in msg.lower()

    def test_cache_miss_changed_mtime_passes_through(self, tmp_path, tmp_data_dir):
        """After the file is modified, the cache misses and output passes through."""
        sid = "sess-lfc-3"
        _bootstrap_session(sid)
        log = tmp_path / "app.log"
        log.write_text("original content\n")
        content1 = log.read_text()

        # First read: populate cache
        payload1 = _make_post_bash_payload(sid, f"cat {log}", content1, str(tmp_path))
        hooks_read.post_bash(payload1)

        # Modify the file (guarantees mtime change)
        time.sleep(0.05)
        log.write_text("new content after modification\n")
        content2 = log.read_text()

        # Second read: new mtime → cache miss → passes through
        payload2 = _make_post_bash_payload(sid, f"cat {log}", content2, str(tmp_path))
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_non_log_file_not_cached(self, tmp_path, tmp_data_dir):
        """Reading a .py file never populates log_file_cache."""
        sid = "sess-lfc-4"
        _bootstrap_session(sid)
        src = tmp_path / "main.py"
        src.write_text("print('hello')\n")
        content = src.read_text()

        # Two reads of a non-log file — second should NOT suppress
        hooks_read.post_bash(_make_post_bash_payload(sid, f"cat {src}", content, str(tmp_path)))
        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"cat {src}", content, str(tmp_path))
        )
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_failed_exit_code_not_cached(self, tmp_path, tmp_data_dir):
        """Commands with non-zero exit code are not recorded in log cache."""
        sid = "sess-lfc-5"
        _bootstrap_session(sid)
        log = tmp_path / "app.log"
        log.write_text("content\n")
        content = "cat: app.log: No such file or directory"

        payload = _make_post_bash_payload(
            sid, f"cat {log}", content, str(tmp_path), exit_code=1
        )
        # Two calls with exit_code=1 — should never suppress
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" not in msg
