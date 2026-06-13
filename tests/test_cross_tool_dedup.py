"""Tests for cross-tool content dedup (Iter 8).

Covers:
  - SessionCache.record_read_hash / get_read_hash round-trip
  - FIFO eviction when cap is exceeded
  - from_dict / to_dict serialization roundtrip
  - _merge_session_caches local-wins merge with eviction
  - post_read records SHA256 hash after whole-file Read
  - post_bash suppresses cat FILE when hash matches prior Read
  - post_bash does NOT suppress cat when path differs from Read
  - post_bash does NOT suppress cat when content differs from Read (file changed)
  - post_bash does NOT suppress head/tail (offset/limit set, not whole-file)
  - post_bash does NOT suppress when no prior Read exists this session
"""
from __future__ import annotations

from token_goat import hooks_read, session
from token_goat.session import (
    _READ_CONTENT_HASHES_EVICT,
    READ_CONTENT_HASHES_MAX,
    SessionCache,
    _fresh_cache,
    _merge_session_caches,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_read_payload(sid: str, file_path: str, cwd: str) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Read",
        "tool_input": {"file_path": file_path},
        "cwd": cwd,
    }


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


# ---------------------------------------------------------------------------
# SessionCache unit tests
# ---------------------------------------------------------------------------

class TestReadContentHashesCache:
    def test_record_and_retrieve(self):
        cache = _fresh_cache("test-rch")
        cache.record_read_hash("/proj/a.py", "abc123")
        assert cache.get_read_hash("/proj/a.py") == "abc123"

    def test_overwrite_updates_value(self):
        cache = _fresh_cache("test-rch-overwrite")
        cache.record_read_hash("/proj/a.py", "hash1")
        cache.record_read_hash("/proj/a.py", "hash2")
        assert cache.get_read_hash("/proj/a.py") == "hash2"

    def test_missing_key_returns_none(self):
        cache = _fresh_cache("test-rch-miss")
        assert cache.get_read_hash("/proj/missing.py") is None

    def test_fifo_eviction_on_cap_exceeded(self):
        cache = _fresh_cache("test-rch-evict")
        for i in range(READ_CONTENT_HASHES_MAX):
            cache.record_read_hash(f"/proj/{i}.py", f"hash{i:064x}")
        assert len(cache.read_content_hashes) == READ_CONTENT_HASHES_MAX
        # One more triggers eviction
        cache.record_read_hash("/proj/overflow.py", "overflow_hash" + "0" * 50)
        expected = READ_CONTENT_HASHES_MAX - _READ_CONTENT_HASHES_EVICT
        assert len(cache.read_content_hashes) == expected
        # Newest entry survives
        assert cache.get_read_hash("/proj/overflow.py") == "overflow_hash" + "0" * 50

    def test_to_dict_round_trip(self):
        cache = _fresh_cache("test-rch-serial")
        cache.record_read_hash("/proj/a.py", "deadbeef" * 8)
        d = cache.to_dict()
        assert "read_content_hashes" in d
        assert d["read_content_hashes"]["/proj/a.py"] == "deadbeef" * 8
        restored = SessionCache.from_dict(d)
        assert restored.get_read_hash("/proj/a.py") == "deadbeef" * 8

    def test_from_dict_missing_field_defaults_empty(self):
        cache = _fresh_cache("test-rch-compat")
        d = cache.to_dict()
        # Simulate older session JSON that lacks this field
        d.pop("read_content_hashes", None)
        restored = SessionCache.from_dict(d)
        assert restored.read_content_hashes == {}


class TestMergeReadContentHashes:
    def test_local_wins_on_same_path(self):
        local = _fresh_cache("merge-local")
        local.record_read_hash("/proj/a.py", "local_hash" + "0" * 54)
        remote = _fresh_cache("merge-remote")
        remote.record_read_hash("/proj/a.py", "remote_hash" + "0" * 53)
        merged = _merge_session_caches(local, remote)
        assert merged.get_read_hash("/proj/a.py") == "local_hash" + "0" * 54

    def test_union_of_different_paths(self):
        local = _fresh_cache("merge-union-local")
        local.record_read_hash("/proj/a.py", "hash_a" + "0" * 58)
        remote = _fresh_cache("merge-union-remote")
        remote.record_read_hash("/proj/b.py", "hash_b" + "0" * 58)
        merged = _merge_session_caches(local, remote)
        assert merged.get_read_hash("/proj/a.py") == "hash_a" + "0" * 58
        assert merged.get_read_hash("/proj/b.py") == "hash_b" + "0" * 58

    def test_merge_evicts_when_over_cap(self):
        local = _fresh_cache("merge-cap-local")
        remote = _fresh_cache("merge-cap-remote")
        half = READ_CONTENT_HASHES_MAX // 2
        for i in range(half):
            local.record_read_hash(f"/proj/local/{i}.py", f"l{i:063x}")
        for i in range(half + 5):
            remote.record_read_hash(f"/proj/remote/{i}.py", f"r{i:063x}")
        merged = _merge_session_caches(local, remote)
        assert len(merged.read_content_hashes) <= READ_CONTENT_HASHES_MAX


# ---------------------------------------------------------------------------
# Integration: post_read records hash
# ---------------------------------------------------------------------------

class TestPostReadRecordsHash:
    def test_whole_file_read_records_hash(self, tmp_path, tmp_data_dir):
        """post_read stores SHA256 in session after a whole-file Read."""
        sid = "pr-hash-record"
        content = b"def bar():\n    pass\n" * 30
        file_ = tmp_path / "bar.py"
        file_.write_bytes(content)

        hooks_read.post_read(_make_read_payload(sid, str(file_), str(tmp_path)))

        cache = session.load(sid)
        norm = str(file_.resolve()).replace("\\", "/")
        stored = cache.get_read_hash(norm)
        assert stored is not None, "Hash not recorded after post_read"

        import hashlib
        expected = hashlib.sha256(content).hexdigest()
        assert stored == expected

    def test_windowed_read_does_not_record_hash(self, tmp_path, tmp_data_dir):
        """A windowed Read (offset or limit set) should NOT record a hash."""
        sid = "pr-windowed"
        content = b"line\n" * 50
        file_ = tmp_path / "windowed.py"
        file_.write_bytes(content)

        payload = _make_read_payload(sid, str(file_), str(tmp_path))
        payload["tool_input"]["offset"] = 5  # windowed
        hooks_read.post_read(payload)

        cache = session.load(sid)
        norm = str(file_.resolve()).replace("\\", "/")
        assert cache.get_read_hash(norm) is None


# ---------------------------------------------------------------------------
# Integration: post_bash cross-tool dedup
# ---------------------------------------------------------------------------

class TestPostBashCrossToolDedup:
    def test_cat_after_read_same_file_suppressed(self, tmp_path, tmp_data_dir):
        """cat FILE after Read FILE with identical content → suppressed."""
        sid = "ctd-suppress"
        content = "def foo():\n    return 42\n" * 25  # >400 bytes for caching
        file_ = tmp_path / "target.py"
        file_.write_text(content, encoding="utf-8")

        hooks_read.post_read(_make_read_payload(sid, str(file_), str(tmp_path)))

        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"cat {file_}", content, str(tmp_path))
        )

        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert "[token-goat]" in msg
        assert "suppressed duplicate" in msg
        assert "target.py" in msg

    def test_cat_after_read_different_file_not_suppressed(self, tmp_path, tmp_data_dir):
        """cat b.py after Read a.py → NOT suppressed even if content is identical."""
        sid = "ctd-different-path"
        content = "x = 1\n" * 100

        file_a = tmp_path / "a.py"
        file_a.write_text(content, encoding="utf-8")
        file_b = tmp_path / "b.py"
        file_b.write_text(content, encoding="utf-8")

        # Read a.py — records hash for a.py's canonical path
        hooks_read.post_read(_make_read_payload(sid, str(file_a), str(tmp_path)))

        # cat b.py — same bytes but different canonical path
        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"cat {file_b}", content, str(tmp_path))
        )

        msg = _sys_msg(result)
        assert "suppressed duplicate" not in msg

    def test_cat_after_read_content_changed_not_suppressed(self, tmp_path, tmp_data_dir):
        """cat FILE returning different bytes than the recorded Read → NOT suppressed."""
        sid = "ctd-changed"
        original = "version = 1\n" * 40
        modified = "version = 2\n" * 40

        file_ = tmp_path / "config.py"
        file_.write_text(original, encoding="utf-8")

        hooks_read.post_read(_make_read_payload(sid, str(file_), str(tmp_path)))

        # stdout reflects the modified content — hash won't match
        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"cat {file_}", modified, str(tmp_path))
        )

        msg = _sys_msg(result)
        assert "suppressed duplicate" not in msg

    def test_head_not_suppressed(self, tmp_path, tmp_data_dir):
        """head -n N sets a line limit → not a whole-file read → NOT suppressed."""
        sid = "ctd-head"
        content = "line\n" * 100
        file_ = tmp_path / "many.py"
        file_.write_text(content, encoding="utf-8")

        hooks_read.post_read(_make_read_payload(sid, str(file_), str(tmp_path)))

        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"head -n 10 {file_}", "line\n" * 10, str(tmp_path))
        )

        msg = _sys_msg(result)
        assert "suppressed duplicate" not in msg

    def test_no_prior_read_no_suppression(self, tmp_path, tmp_data_dir):
        """cat FILE with no prior Read this session → NOT suppressed."""
        sid = "ctd-no-prior"
        content = "fresh content\n" * 30
        file_ = tmp_path / "fresh.py"
        file_.write_text(content, encoding="utf-8")

        # Deliberately skip post_read — nothing recorded
        result = hooks_read.post_bash(
            _make_post_bash_payload(sid, f"cat {file_}", content, str(tmp_path))
        )

        msg = _sys_msg(result)
        assert "suppressed duplicate" not in msg
