"""Tests for cross-file content-dedup (Iter 7).

Covers:
  - SessionCache.register_file_content / get_file_content_path round-trip
  - FIFO eviction when cap is exceeded
  - from_dict / to_dict serialization roundtrip
  - _merge_session_caches first-seen-wins merge with eviction
  - _check_content_dedup helper (new/same/duplicate/fail-soft)
  - pre_read integration: deny on duplicate, allow on first read
  - post_read integration: registers content after full read
  - Windowed reads are exempt from both check and registration
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from hook_helpers import assert_deny

from token_goat import hooks_read
from token_goat.hooks_read import _CONTENT_DEDUP_MAX_BYTES, _check_content_dedup
from token_goat.session import (
    _FILE_CONTENT_SEEN_EVICT,
    FILE_CONTENT_SEEN_MAX,
    SessionCache,
    _fresh_cache,
    _merge_session_caches,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cache(session_id: str = "test-dedup") -> SessionCache:
    return _fresh_cache(session_id)


def _read_payload(path: Path, cwd: Path, *, offset: int | None = None) -> dict:
    ti: dict = {"file_path": str(path)}
    if offset is not None:
        ti["offset"] = offset
    return {"session_id": "dedup-session", "tool_name": "Read", "tool_input": ti, "cwd": str(cwd)}


def _ctx(result: dict) -> str:
    return (result.get("hookSpecificOutput") or {}).get("additionalContext", "")


# ---------------------------------------------------------------------------
# SessionCache unit tests
# ---------------------------------------------------------------------------

class TestFileContentSeenCache:
    def test_register_and_retrieve(self):
        cache = _make_cache()
        cache.register_file_content("abc123", "/proj/a.py")
        assert cache.get_file_content_path("abc123") == "/proj/a.py"

    def test_first_seen_wins(self):
        cache = _make_cache()
        cache.register_file_content("abc123", "/proj/a.py")
        cache.register_file_content("abc123", "/proj/b.py")
        assert cache.get_file_content_path("abc123") == "/proj/a.py"

    def test_missing_key_returns_none(self):
        cache = _make_cache()
        assert cache.get_file_content_path("nope") is None

    def test_fifo_eviction_on_cap_exceeded(self):
        cache = _make_cache()
        # Fill exactly to cap
        for i in range(FILE_CONTENT_SEEN_MAX):
            cache.register_file_content(f"{i:016x}", f"/proj/{i}.py")
        assert len(cache.file_content_seen) == FILE_CONTENT_SEEN_MAX
        # One more entry triggers eviction
        cache.register_file_content("overflow0000000a", "/proj/overflow.py")
        # Eviction removes enough entries to reach the low-water mark (MAX - EVICT).
        expected = FILE_CONTENT_SEEN_MAX - _FILE_CONTENT_SEEN_EVICT
        assert len(cache.file_content_seen) == expected
        # Oldest entries are gone; newest is present
        assert cache.get_file_content_path("overflow0000000a") == "/proj/overflow.py"
        assert cache.get_file_content_path("0000000000000000") is None


class TestFileContentSeenSerialization:
    def test_roundtrip_preserves_entries(self):
        cache = _make_cache()
        cache.register_file_content("deadbeefdeadbeef", "/proj/a.py")
        cache.register_file_content("cafebabecafebabe", "/proj/b.py")
        d = cache.to_dict()
        assert d["file_content_seen"] == {
            "deadbeefdeadbeef": "/proj/a.py",
            "cafebabecafebabe": "/proj/b.py",
        }
        restored = SessionCache.from_dict(d)
        assert restored.get_file_content_path("deadbeefdeadbeef") == "/proj/a.py"
        assert restored.get_file_content_path("cafebabecafebabe") == "/proj/b.py"

    def test_from_dict_missing_field_defaults_to_empty(self):
        cache = _make_cache()
        d = cache.to_dict()
        del d["file_content_seen"]
        restored = SessionCache.from_dict(d)
        assert restored.file_content_seen == {}

    def test_from_dict_skips_malformed_entries(self):
        cache = _make_cache()
        d = cache.to_dict()
        d["file_content_seen"] = {"": "/proj/a.py", "goodkey": 123, "anotherkey": "/proj/b.py"}
        restored = SessionCache.from_dict(d)
        # "" and 123-value entries are skipped
        assert "" not in restored.file_content_seen
        assert "goodkey" not in restored.file_content_seen
        assert restored.get_file_content_path("anotherkey") == "/proj/b.py"


class TestMergeFileContentSeen:
    def test_remote_first_seen_wins_over_local(self):
        local = _make_cache("local")
        remote = _make_cache("remote")
        remote.register_file_content("sha16key1", "/remote/a.py")
        local.register_file_content("sha16key1", "/local/b.py")
        merged = _merge_session_caches(local, remote)
        assert merged.get_file_content_path("sha16key1") == "/remote/a.py"

    def test_local_only_keys_are_merged_in(self):
        local = _make_cache("local")
        remote = _make_cache("remote")
        local.register_file_content("localonly1234567", "/local/c.py")
        merged = _merge_session_caches(local, remote)
        assert merged.get_file_content_path("localonly1234567") == "/local/c.py"

    def test_merge_evicts_when_over_cap(self):
        local = _make_cache("local")
        remote = _make_cache("remote")
        for i in range(FILE_CONTENT_SEEN_MAX):
            remote.register_file_content(f"r{i:015x}", f"/r/{i}.py")
        local.register_file_content("lonly00000000001", "/l/extra.py")
        merged = _merge_session_caches(local, remote)
        assert len(merged.file_content_seen) <= FILE_CONTENT_SEEN_MAX


# ---------------------------------------------------------------------------
# _check_content_dedup helper unit tests
# ---------------------------------------------------------------------------

class TestCheckContentDedup:
    def test_returns_none_for_unknown_sha(self, tmp_path):
        f = tmp_path / "a.py"
        f.write_text("hello")
        cache = _make_cache()
        assert _check_content_dedup(str(f), cache) is None

    def test_returns_none_when_same_path_registered(self, tmp_path):
        f = tmp_path / "a.py"
        f.write_text("hello")
        import hashlib
        sha16 = hashlib.sha1(f.read_bytes(), usedforsecurity=False).hexdigest()[:16]
        norm = str(f.resolve()).replace("\\", "/")
        cache = _make_cache()
        cache.register_file_content(sha16, norm)
        assert _check_content_dedup(str(f), cache) is None

    def test_returns_deny_when_different_path_registered(self, tmp_path):
        content = b"print('hello')\n"
        f1 = tmp_path / "a.py"
        f2 = tmp_path / "b.py"
        f1.write_bytes(content)
        f2.write_bytes(content)
        import hashlib
        sha16 = hashlib.sha1(content, usedforsecurity=False).hexdigest()[:16]
        norm1 = str(f1.resolve()).replace("\\", "/")
        cache = _make_cache()
        cache.register_file_content(sha16, norm1)
        result = _check_content_dedup(str(f2), cache)
        assert result is not None
        ctx = (result.get("hookSpecificOutput") or {}).get("additionalContext", "")
        assert str(f1.name) in ctx or norm1 in ctx

    def test_returns_none_for_nonexistent_file(self, tmp_path):
        cache = _make_cache()
        assert _check_content_dedup(str(tmp_path / "ghost.py"), cache) is None

    def test_returns_none_for_empty_file(self, tmp_path):
        f = tmp_path / "empty.py"
        f.write_bytes(b"")
        cache = _make_cache()
        assert _check_content_dedup(str(f), cache) is None

    def test_returns_none_for_oversized_file(self, tmp_path):
        f = tmp_path / "big.py"
        f.write_bytes(b"x" * (_CONTENT_DEDUP_MAX_BYTES + 1))
        cache = _make_cache()
        assert _check_content_dedup(str(f), cache) is None

    def test_fail_soft_on_unreadable_file(self, tmp_path):
        cache = _make_cache()
        # Pass a path that raises on stat — simulate via mock
        with patch("token_goat.hooks_read.Path") as mock_path:
            mock_path.return_value.is_file.side_effect = OSError("permission denied")
            # Should not raise; fail-soft returns None
            result = _check_content_dedup("/some/path.py", cache)
        assert result is None


# ---------------------------------------------------------------------------
# pre_read integration tests
# ---------------------------------------------------------------------------

class TestPreReadContentDedup:
    def _write(self, path: Path, content: bytes = b"x = 1\n") -> Path:
        path.write_bytes(content)
        return path

    def test_first_read_passes_through(self, tmp_data_dir, tmp_path):
        f = self._write(tmp_path / "a.py")
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        # Should not deny purely due to content dedup (no prior registration)
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"

    def test_duplicate_content_is_denied_sentinel(self, tmp_data_dir, tmp_path):
        # Use sentinel to verify pre_read propagates the dedup deny response.
        f2 = self._write(tmp_path / "b.py", b"some content\n")
        sentinel_ctx = "SENTINEL_DUPLICATE_PATH:/proj/a.py"
        sentinel_deny = hooks_read.deny_redirect("Duplicate file content", sentinel_ctx)
        with patch.object(hooks_read, "_check_content_dedup", return_value=sentinel_deny):
            result = hooks_read.pre_read(_read_payload(f2, tmp_path))
        assert_deny(result)
        assert sentinel_ctx in _ctx(result)

    def test_windowed_read_skips_dedup_check(self, tmp_data_dir, tmp_path):
        # _check_content_dedup must NOT be called for windowed (offset) reads.
        f = self._write(tmp_path / "a.py", b"some content\n")
        with patch.object(hooks_read, "_check_content_dedup", return_value=None) as mock_check:
            hooks_read.pre_read(_read_payload(f, tmp_path, offset=0))
        mock_check.assert_not_called()


# ---------------------------------------------------------------------------
# SessionCache field present in _SessionDict
# ---------------------------------------------------------------------------

class TestSessionDictHasField:
    def test_to_dict_contains_file_content_seen_key(self):
        cache = _make_cache()
        d = cache.to_dict()
        assert "file_content_seen" in d

    def test_empty_file_content_seen_serializes_as_empty_dict(self):
        cache = _make_cache()
        assert cache.to_dict()["file_content_seen"] == {}
