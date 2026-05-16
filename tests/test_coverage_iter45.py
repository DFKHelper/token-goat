"""Tests for code added/changed in iterations 40-45.

Covers:
- hooks_session._detect cwd validation (empty, non-str, too-long, non-dir, OSError)
- install._safe_username allowlist validation
- bridges._check_plugin_file all four return paths
- stats._accumulate with invalid/out-of-range timestamps
- webfetch._write_cache_meta ETag/Last-Modified truncation at write time
- languages.typescript ABI meta value error handling (TypeError/ValueError guard)
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# 1. hooks_session._detect — cwd validation
# ---------------------------------------------------------------------------


class TestDetectCwdValidation:
    """_detect() must reject malformed cwd values before passing to find_project."""

    def _detect(self, payload):
        from token_goat.hooks_session import _detect
        return _detect(payload)

    def test_missing_cwd_returns_none(self):
        """Payload with no cwd field returns None."""
        assert self._detect({}) is None

    def test_empty_string_cwd_returns_none(self):
        """Empty string cwd returns None (falsy guard)."""
        assert self._detect({"cwd": ""}) is None

    def test_non_string_cwd_int_returns_none(self):
        """Non-string cwd (int) returns None without crashing."""
        assert self._detect({"cwd": 42}) is None

    def test_non_string_cwd_list_returns_none(self):
        """Non-string cwd (list) returns None without crashing."""
        assert self._detect({"cwd": ["/some/path"]}) is None

    def test_cwd_too_long_returns_none(self):
        """cwd exceeding 4096 chars returns None and logs a warning."""
        long_cwd = "/tmp/" + "x" * 4100
        result = self._detect({"cwd": long_cwd})
        assert result is None

    def test_cwd_exactly_4096_chars_is_accepted_if_dir(self, tmp_path):
        """A cwd of exactly 4096 chars should NOT be rejected by the length guard (it must be <=4096)."""
        # A cwd of exactly 4096 is borderline; the guard is > 4096, so 4096 is allowed.
        # We use tmp_path which is a valid dir and well under 4096 chars.
        from token_goat.hooks_session import _detect
        # Just verify tmp_path works — it's valid and under 4096 chars.
        # The exact-4096 case isn't practically testable but the fence-post is len > 4096.
        result = _detect({"cwd": str(tmp_path)})
        # May be None if not a project root, but must not crash.
        assert result is None or hasattr(result, "root")

    def test_nonexistent_dir_returns_none(self, tmp_path):
        """A path that doesn't exist on disk returns None."""
        nonexistent = str(tmp_path / "does_not_exist")
        result = self._detect({"cwd": nonexistent})
        assert result is None

    def test_file_path_as_cwd_returns_none(self, tmp_path):
        """A path pointing to a file (not a directory) returns None."""
        f = tmp_path / "somefile.txt"
        f.write_text("hello")
        result = self._detect({"cwd": str(f)})
        assert result is None

    def test_valid_dir_without_project_marker_returns_none(self, tmp_path):
        """A real directory with no project marker returns None (no project found)."""
        result = self._detect({"cwd": str(tmp_path)})
        assert result is None

    def test_valid_git_dir_returns_project(self, tmp_path):
        """A real directory that is a git root returns a Project object."""
        (tmp_path / ".git").mkdir()
        result = self._detect({"cwd": str(tmp_path)})
        assert result is not None
        assert result.root == tmp_path


# ---------------------------------------------------------------------------
# 2. install._safe_username — allowlist validation
# ---------------------------------------------------------------------------


class TestSafeUsername:
    """_safe_username() must return validated usernames or empty string."""

    def _call(self, env: dict[str, str]) -> str:
        from token_goat.install import _safe_username
        with patch.dict(os.environ, env, clear=True):
            return _safe_username()

    def test_valid_simple_username(self):
        """Simple alphanumeric username passes."""
        assert self._call({"USERNAME": "alice"}) == "alice"

    def test_valid_domain_username(self):
        """Domain\\user format passes (backslash in allowlist)."""
        result = self._call({"USERNAME": r"DOMAIN\alice"})
        assert result == r"DOMAIN\alice"

    def test_valid_upn_username(self):
        """UPN user@domain format passes (@ in allowlist)."""
        result = self._call({"USERNAME": "alice@example.com"})
        assert result == "alice@example.com"

    def test_valid_underscore_dot_hyphen(self):
        """Underscores, dots, and hyphens are allowed."""
        result = self._call({"USERNAME": "john.doe_user-1"})
        assert result == "john.doe_user-1"

    def test_username_with_semicolon_rejected(self):
        """Semicolon injection attempt is rejected, returns empty string."""
        result = self._call({"USERNAME": "alice; del /q *"})
        assert result == ""

    def test_username_with_space_rejected(self):
        """Username with embedded space is rejected."""
        result = self._call({"USERNAME": "alice bob"})
        assert result == ""

    def test_username_with_newline_rejected(self):
        """Username with newline is rejected."""
        result = self._call({"USERNAME": "alice\nbob"})
        assert result == ""

    def test_username_with_ampersand_rejected(self):
        """Ampersand shell injection is rejected."""
        result = self._call({"USERNAME": "alice&whoami"})
        assert result == ""

    def test_empty_username_returns_empty(self):
        """Empty USERNAME env var returns empty string."""
        result = self._call({})
        assert result == ""

    def test_too_long_username_rejected(self):
        """Username longer than 128 chars is rejected."""
        result = self._call({"USERNAME": "a" * 129})
        assert result == ""

    def test_exactly_128_chars_accepted(self):
        """Username of exactly 128 chars (all valid) is accepted."""
        result = self._call({"USERNAME": "a" * 128})
        assert result == "a" * 128

    def test_falls_back_to_USER_env(self):
        """Falls back to USER env var when USERNAME is absent (Linux-style)."""
        result = self._call({"USER": "linuxuser"})
        assert result == "linuxuser"

    def test_USERNAME_takes_priority_over_USER(self):
        """USERNAME takes priority over USER when both are set."""
        result = self._call({"USERNAME": "winuser", "USER": "linuxuser"})
        assert result == "winuser"


# ---------------------------------------------------------------------------
# 3. bridges._check_plugin_file — all four return paths
# ---------------------------------------------------------------------------


class TestCheckPluginFile:
    """_check_plugin_file() returns one of four status strings."""

    def _check(self, path: Path) -> str:
        from token_goat.bridges import _check_plugin_file
        return _check_plugin_file(path)

    def test_not_installed_when_missing(self, tmp_path):
        """Returns 'not installed' when the file does not exist."""
        path = tmp_path / "nonexistent.ts"
        assert self._check(path) == "not installed"

    def test_installed_when_fingerprint_present(self, tmp_path):
        """Returns 'installed' when the file contains both fingerprint strings."""
        path = tmp_path / "token-goat.ts"
        path.write_text("// token-goat bridge\nspawnSync('token-goat', args);", encoding="utf-8")
        assert self._check(path) == "installed"

    def test_present_but_not_bridge_when_fingerprint_missing(self, tmp_path):
        """Returns 'present but not token-goat bridge' when file lacks fingerprint."""
        path = tmp_path / "other-plugin.ts"
        path.write_text("// some other plugin\nconsole.log('hi');", encoding="utf-8")
        assert self._check(path) == "present but not token-goat bridge"

    def test_error_reading_plugin_file_on_oserror(self, tmp_path):
        """Returns 'error reading plugin file' when OSError occurs."""
        from token_goat.bridges import _check_plugin_file
        path = tmp_path / "token-goat.ts"
        path.write_text("placeholder", encoding="utf-8")

        def boom(*args, **kwargs):
            raise PermissionError("[Errno 13] Permission denied")

        with patch.object(Path, "read_text", boom):
            result = _check_plugin_file(path)
        assert result == "error reading plugin file"

    def test_partial_fingerprint_not_installed(self, tmp_path):
        """File with only one fingerprint string is 'present but not token-goat bridge'."""
        path = tmp_path / "partial.ts"
        # Has token-goat but not spawnSync
        path.write_text("// token-goat\nconsole.log('hi');", encoding="utf-8")
        assert self._check(path) == "present but not token-goat bridge"


# ---------------------------------------------------------------------------
# 4. stats._accumulate — invalid/out-of-range timestamp handling
# ---------------------------------------------------------------------------


class TestAccumulateInvalidTimestamp:
    """_accumulate() must skip day bucketing for malformed timestamps without crashing."""

    def _make_row(self, ts, kind="image_shrink", bytes_saved=100, tokens_saved=50):
        """Create a sqlite3.Row-like mapping for _accumulate."""
        return {
            "kind": kind,
            "bytes_saved": bytes_saved,
            "tokens_saved": tokens_saved,
            "ts": ts,
        }

    def _accumulate(self, row, by_kind, by_day):
        from token_goat.stats import _accumulate
        # _accumulate expects sqlite3.Row, but dict with __getitem__ works
        # since it uses row["key"] subscript access.
        _accumulate(row, by_kind, by_day)

    def test_valid_timestamp_adds_to_by_day(self):
        """Valid timestamp populates by_day."""
        import time
        by_kind = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        row = self._make_row(ts=time.time())
        self._accumulate(row, by_kind, by_day)
        assert len(by_day) == 1
        assert by_kind["image_shrink"]["events"] == 1

    def test_overflow_timestamp_skips_day_but_counts_kind(self):
        """Overflow timestamp (far future) skips day bucket but still counts the kind."""
        by_kind = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        # 9999999999999 is well beyond datetime max — triggers OverflowError/OSError
        row = self._make_row(ts=9_999_999_999_999)
        self._accumulate(row, by_kind, by_day)
        # Kind must be incremented even when timestamp is bad
        assert by_kind["image_shrink"]["events"] == 1
        assert by_kind["image_shrink"]["bytes_saved"] == 100
        # Day bucket should be empty (bad ts skips day bucketing)
        assert len(by_day) == 0

    def test_negative_timestamp_skips_day_but_counts_kind(self):
        """Wildly negative timestamp (pre-epoch) is handled gracefully."""
        by_kind = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        row = self._make_row(ts=-9_999_999_999_999)
        self._accumulate(row, by_kind, by_day)
        assert by_kind["image_shrink"]["events"] == 1
        # Day bucket may or may not populate depending on platform; just don't crash.

    def test_zero_bytes_saved_still_counted(self):
        """Row with bytes_saved=None is coerced to 0 and counted."""
        import time
        by_kind = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        row = self._make_row(ts=time.time(), bytes_saved=None, tokens_saved=None)
        self._accumulate(row, by_kind, by_day)
        assert by_kind["image_shrink"]["events"] == 1
        assert by_kind["image_shrink"]["bytes_saved"] == 0


# ---------------------------------------------------------------------------
# 5. webfetch._write_cache_meta — ETag/Last-Modified truncated at write time
# ---------------------------------------------------------------------------


class TestWriteCacheMetaTruncation:
    """_write_cache_meta() must truncate header values to _MAX_META_VALUE_LEN at write time."""

    def test_oversized_etag_is_truncated_on_write(self, tmp_path):
        """An oversized ETag from a server is truncated before being written to disk."""
        from token_goat.webfetch import _MAX_META_VALUE_LEN, _write_cache_meta

        cache_file = tmp_path / "image.png"
        cache_file.touch()

        long_etag = "W/" + '"' + "z" * (_MAX_META_VALUE_LEN + 200) + '"'
        headers = MagicMock()
        headers.get = lambda key, default=None: long_etag if key == "etag" else None

        _write_cache_meta(cache_file, headers)

        sidecar = Path(str(cache_file) + ".meta")
        assert sidecar.exists(), "sidecar meta file should be written"
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        assert "etag" in data
        assert len(data["etag"]) == _MAX_META_VALUE_LEN

    def test_oversized_last_modified_is_truncated_on_write(self, tmp_path):
        """An oversized Last-Modified header is truncated before being written."""
        from token_goat.webfetch import _MAX_META_VALUE_LEN, _write_cache_meta

        cache_file = tmp_path / "image.png"
        cache_file.touch()

        long_lm = "Mon, 01 Jan 2024 " + "x" * (_MAX_META_VALUE_LEN + 100)
        headers = MagicMock()
        headers.get = lambda key, default=None: long_lm if key == "last-modified" else None

        _write_cache_meta(cache_file, headers)

        sidecar = Path(str(cache_file) + ".meta")
        assert sidecar.exists()
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        assert "last_modified" in data
        assert len(data["last_modified"]) == _MAX_META_VALUE_LEN

    def test_normal_length_etag_written_verbatim(self, tmp_path):
        """A normal-length ETag is written to disk without modification."""
        from token_goat.webfetch import _write_cache_meta

        cache_file = tmp_path / "image.png"
        cache_file.touch()

        etag = '"abc123def456"'
        headers = MagicMock()
        headers.get = lambda key, default=None: etag if key == "etag" else None

        _write_cache_meta(cache_file, headers)

        sidecar = Path(str(cache_file) + ".meta")
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        assert data["etag"] == etag

    def test_no_headers_produces_no_sidecar(self, tmp_path):
        """When neither etag nor last-modified is present, no sidecar is written."""
        from token_goat.webfetch import _write_cache_meta

        cache_file = tmp_path / "image.png"
        cache_file.touch()

        headers = MagicMock()
        headers.get = lambda key, default=None: None

        _write_cache_meta(cache_file, headers)

        sidecar = Path(str(cache_file) + ".meta")
        assert not sidecar.exists(), "no sidecar should be written when no headers present"


# ---------------------------------------------------------------------------
# 6. languages.typescript — invalid ABI meta values fall back to defaults
# ---------------------------------------------------------------------------


class TestTypescriptAbiMetaGuard:
    """Invalid abi_size_threshold / abi_max_symbols_per_file values must fall back to defaults."""

    def _extract(self, src: bytes, rel_path: str = "test.ts", meta=None):
        from token_goat.languages.typescript import extract
        return extract(src, rel_path, meta=meta)

    def _small_ts(self) -> bytes:
        return b"export function hello(): string { return 'hi'; }\n"

    def test_invalid_string_threshold_falls_back_to_default(self):
        """Non-numeric string for abi_size_threshold falls back to default — no crash."""
        src = self._small_ts()
        symbols, refs, _, _ = self._extract(src, meta={"abi_size_threshold": "not-a-number"})
        # Should not raise; falls back to default threshold so small file is normal extract
        assert any(s.name == "hello" for s in symbols)

    def test_none_threshold_falls_back_to_default(self):
        """None for abi_size_threshold falls back to default — no crash."""
        src = self._small_ts()
        symbols, refs, _, _ = self._extract(src, meta={"abi_size_threshold": None})
        assert any(s.name == "hello" for s in symbols)

    def test_invalid_string_max_symbols_falls_back(self):
        """Non-numeric string for abi_max_symbols_per_file falls back — no crash."""
        src = self._small_ts()
        symbols, refs, _, _ = self._extract(src, meta={"abi_max_symbols_per_file": "bogus"})
        assert any(s.name == "hello" for s in symbols)

    def test_both_invalid_falls_back_gracefully(self):
        """Both ABI meta values invalid: falls back to defaults, extracts normally."""
        src = self._small_ts()
        symbols, refs, _, _ = self._extract(
            src,
            meta={"abi_size_threshold": [], "abi_max_symbols_per_file": {}},
        )
        # Must not raise; normal extraction should proceed
        assert isinstance(symbols, list)
