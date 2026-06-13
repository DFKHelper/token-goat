"""Tests for recursive dir-listing fingerprint cache (Iter 13).

Covers:
  - _dir_listing_cmd_type detection for find, fd, ls-R, eza-tree, non-listing
  - SessionCache.get_dir_listing_hit / record_dir_listing round-trip
  - FIFO eviction at DIR_LISTING_CACHE_MAX
  - to_dict / from_dict serialization round-trip
  - from_dict backward-compat when field is missing
  - _merge_session_caches: local wins
  - post_bash integration: first listing passes through
  - post_bash integration: second listing same output suppressed
  - post_bash integration: same dir different flags → different key, not suppressed
  - post_bash integration: changed output → not suppressed
  - post_bash integration: non-listing command → not cached
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _dir_listing_cmd_type
from token_goat.session import (
    _DIR_LISTING_CACHE_EVICT,
    DIR_LISTING_CACHE_MAX,
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


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


# ---------------------------------------------------------------------------
# _dir_listing_cmd_type unit tests
# ---------------------------------------------------------------------------

class TestDirListingCmdType:
    def test_find_detected(self):
        assert _dir_listing_cmd_type(["find", ".", "-name", "*.py"]) == "find"

    def test_fd_detected(self):
        assert _dir_listing_cmd_type(["fd", "--type", "f", "."]) == "fd"

    def test_fdfind_detected(self):
        assert _dir_listing_cmd_type(["fdfind", "."]) == "fd"

    def test_ls_recursive_upper_R(self):
        assert _dir_listing_cmd_type(["ls", "-R", "/tmp"]) == "ls-r"

    def test_ls_recursive_long_flag(self):
        assert _dir_listing_cmd_type(["ls", "--recursive", "/tmp"]) == "ls-r"

    def test_ls_combined_flags_with_R(self):
        assert _dir_listing_cmd_type(["ls", "-lR", "/tmp"]) == "ls-r"

    def test_ls_without_recursive_returns_none(self):
        assert _dir_listing_cmd_type(["ls", "-la", "/tmp"]) is None

    def test_eza_tree_flag(self):
        assert _dir_listing_cmd_type(["eza", "--tree", "/src"]) == "eza-tree"

    def test_eza_T_flag(self):
        assert _dir_listing_cmd_type(["eza", "-T", "/src"]) == "eza-tree"

    def test_exa_tree_flag(self):
        assert _dir_listing_cmd_type(["exa", "--tree", "."]) == "eza-tree"

    def test_eza_without_tree_returns_none(self):
        assert _dir_listing_cmd_type(["eza", "--long", "."]) is None

    def test_cat_returns_none(self):
        assert _dir_listing_cmd_type(["cat", "file.txt"]) is None

    def test_empty_argv_returns_none(self):
        assert _dir_listing_cmd_type([]) is None

    def test_pytest_returns_none(self):
        assert _dir_listing_cmd_type(["pytest", "-v"]) is None

    def test_windows_exe_suffix_stripped(self):
        assert _dir_listing_cmd_type(["find.exe", "."]) == "find"

    def test_full_path_fd(self):
        assert _dir_listing_cmd_type(["/usr/bin/fd", "."]) == "fd"


# ---------------------------------------------------------------------------
# SessionCache unit tests
# ---------------------------------------------------------------------------

class TestDirListingCacheUnit:
    def test_record_and_retrieve(self):
        cache = _fresh_cache("test-dlc")
        cache.record_dir_listing("/tmp/src:abc123def456abc1", "deadbeefdeadbeef")
        result = cache.get_dir_listing_hit("/tmp/src:abc123def456abc1")
        assert result == "deadbeefdeadbeef"

    def test_miss_on_wrong_key(self):
        cache = _fresh_cache("test-dlc-miss")
        cache.record_dir_listing("/tmp/src:abc123def456abc1", "hash1")
        assert cache.get_dir_listing_hit("/tmp/other:abc123def456abc1") is None

    def test_miss_on_wrong_fingerprint(self):
        cache = _fresh_cache("test-dlc-fp")
        cache.record_dir_listing("/tmp/src:aaaa", "hash1")
        assert cache.get_dir_listing_hit("/tmp/src:bbbb") is None

    def test_empty_cache_returns_none(self):
        cache = _fresh_cache("test-dlc-empty")
        assert cache.get_dir_listing_hit("/tmp/src:abc") is None

    def test_overwrite_updates_value(self):
        cache = _fresh_cache("test-dlc-overwrite")
        cache.record_dir_listing("/tmp/src:key1", "hash1")
        cache.record_dir_listing("/tmp/src:key1", "hash2")
        assert cache.get_dir_listing_hit("/tmp/src:key1") == "hash2"

    def test_fifo_eviction_on_cap_exceeded(self):
        cache = _fresh_cache("test-dlc-evict")
        for i in range(DIR_LISTING_CACHE_MAX):
            cache.record_dir_listing(f"/tmp/dir{i}:fp{i:016x}", f"hash{i:016x}")
        assert len(cache.dir_listing_cache) == DIR_LISTING_CACHE_MAX
        # One more entry triggers eviction
        cache.record_dir_listing("/tmp/overflow:fpoverflow0000", "overflow" + "0" * 8)
        expected = DIR_LISTING_CACHE_MAX - _DIR_LISTING_CACHE_EVICT
        assert len(cache.dir_listing_cache) == expected
        # Newest entry survives
        assert cache.get_dir_listing_hit("/tmp/overflow:fpoverflow0000") == "overflow" + "0" * 8

    def test_to_dict_round_trip(self):
        cache = _fresh_cache("test-dlc-serial")
        cache.record_dir_listing("/tmp/src:deadbeef12345678", "cafebabecafebabe")
        d = cache.to_dict()
        assert "dir_listing_cache" in d
        restored = SessionCache.from_dict(d)
        assert restored.get_dir_listing_hit("/tmp/src:deadbeef12345678") == "cafebabecafebabe"

    def test_from_dict_missing_field_defaults_empty(self):
        cache = _fresh_cache("test-dlc-compat")
        d = cache.to_dict()
        d.pop("dir_listing_cache", None)
        restored = SessionCache.from_dict(d)
        assert restored.dir_listing_cache == {}

    def test_merge_local_wins(self):
        local = _fresh_cache("local")
        remote = _fresh_cache("remote")
        local.session_id = remote.session_id = "shared"
        remote.record_dir_listing("/tmp/src:fp1", "remote_hash")
        local.record_dir_listing("/tmp/src:fp1", "local_hash")
        merged = _merge_session_caches(local, remote)
        assert merged.get_dir_listing_hit("/tmp/src:fp1") == "local_hash"


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------

class TestDirListingCacheIntegration:
    """Test post_bash dir-listing cache logic.

    Every test uses ``tmp_data_dir`` so session saves go to an isolated
    temp directory and don't bleed across tests or touch production data.
    """

    def test_first_listing_passes_through(self, tmp_path, tmp_data_dir):
        """First run of find: output passes through, cache populated."""
        sid = "sess-dlc-1"
        _bootstrap_session(sid)
        stdout = "src/foo.py\nsrc/bar.py\n"
        payload = _make_post_bash_payload(sid, f"find {tmp_path} -name '*.py'", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_second_listing_same_output_suppressed(self, tmp_path, tmp_data_dir):
        """Second run of find with identical output: suppressed."""
        sid = "sess-dlc-2"
        _bootstrap_session(sid)
        stdout = "src/foo.py\nsrc/bar.py\n"
        payload = _make_post_bash_payload(sid, f"find {tmp_path} -name '*.py'", stdout, str(tmp_path))
        # First call: populates cache
        hooks_read.post_bash(payload)
        # Second call: should suppress
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" in msg.lower() or "suppressed" in msg.lower()

    def test_same_dir_different_flags_not_suppressed(self, tmp_path, tmp_data_dir):
        """Same dir, different flags → different cache key → not suppressed."""
        sid = "sess-dlc-3"
        _bootstrap_session(sid)
        stdout = "src/foo.py\n"
        # First call with --max-depth 1
        payload1 = _make_post_bash_payload(
            sid, f"find {tmp_path} --max-depth 1", stdout, str(tmp_path)
        )
        hooks_read.post_bash(payload1)
        # Second call with --max-depth 2 (different command → different fingerprint)
        payload2 = _make_post_bash_payload(
            sid, f"find {tmp_path} --max-depth 2", stdout, str(tmp_path)
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_changed_output_not_suppressed(self, tmp_path, tmp_data_dir):
        """Same command but different output (content changed): not suppressed."""
        sid = "sess-dlc-4"
        _bootstrap_session(sid)
        cmd = f"find {tmp_path} -name '*.py'"
        payload1 = _make_post_bash_payload(sid, cmd, "src/foo.py\n", str(tmp_path))
        hooks_read.post_bash(payload1)
        # Different output (new file appeared)
        payload2 = _make_post_bash_payload(sid, cmd, "src/foo.py\nsrc/baz.py\n", str(tmp_path))
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_non_listing_command_not_cached(self, tmp_path, tmp_data_dir):
        """A non-listing command (pytest) is never cached by the dir-listing block."""
        sid = "sess-dlc-5"
        _bootstrap_session(sid)
        stdout = "test output\n"
        payload = _make_post_bash_payload(sid, "pytest -v tests/", stdout, str(tmp_path))
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_failed_exit_code_not_cached(self, tmp_path, tmp_data_dir):
        """Commands with non-zero exit code are not recorded in dir_listing_cache."""
        sid = "sess-dlc-6"
        _bootstrap_session(sid)
        stdout = "find: '/nonexistent': No such file or directory"
        payload = _make_post_bash_payload(
            sid, "find /nonexistent -name '*.py'", stdout, str(tmp_path), exit_code=1
        )
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" not in msg

    def test_fd_listing_suppressed(self, tmp_path, tmp_data_dir):
        """fd command: second identical listing suppressed."""
        sid = "sess-dlc-7"
        _bootstrap_session(sid)
        stdout = "foo.py\nbar.py\n"
        payload = _make_post_bash_payload(sid, f"fd --type f . {tmp_path}", stdout, str(tmp_path))
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "unchanged" in msg.lower() or "suppressed" in msg.lower()

    def test_fd_pattern_not_mistaken_for_directory(self, tmp_path, tmp_data_dir):
        """fd PATTERN DIR: the regex pattern must not appear in the suppression message.

        fd's positional signature is fd [FLAGS] [PATTERN] [PATH].
        The first non-flag arg is the search pattern; the second is the directory.
        A prior bug caused the pattern to be captured as _dl_dir_raw.
        """
        sid = "sess-dlc-8"
        _bootstrap_session(sid)
        stdout = "src/foo.py\n"
        cmd = f"fd '\\.py$' {tmp_path}"
        payload = _make_post_bash_payload(sid, cmd, stdout, str(tmp_path))
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Suppression must still fire
        assert "unchanged" in msg.lower() or "suppressed" in msg.lower()
        # The regex pattern must NOT appear as the "directory" in the message
        assert ".py$" not in msg
