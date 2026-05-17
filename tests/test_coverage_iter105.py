"""Regression tests for code paths added/hardened in recent iterations.

Coverage targets:
- webfetch.py: post-redirect SSRF check on the 304 conditional-revalidation path
- session.py: cleanup_stale symlink skip, session-ID regex validation
- install.py: _patch_md_block / _unpatch_md_block atomic writes (idempotency,
  create-when-missing, replace-existing-block, not-found path)
- read_replacement.py: sqlite3.OperationalError / sqlite3.DatabaseError in
  read_symbol and read_section return None gracefully
- compact.py: _format_ranges handles malformed entries (non-sequence, wrong length,
  non-numeric values, mixed valid/invalid)
- parser.py: get_extractor returns None on ImportError, caches on success,
  None for unknown language
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from token_goat import webfetch
from token_goat.compact import _format_ranges
from token_goat.install import (
    CLAUDE_MD_BEGIN,
    CLAUDE_MD_END,
    CODEX_AGENTS_BEGIN,
    CODEX_AGENTS_END,
    _patch_md_block,
    _unpatch_md_block,
)
from token_goat.parser import _EXTRACTOR_CACHE, get_extractor
from token_goat.session import cleanup_stale, validate_session_id

# ---------------------------------------------------------------------------
# Helpers (shared with other webfetch tests)
# ---------------------------------------------------------------------------


def _make_non_streaming_response(status: int = 304, url: str = "https://example.com/img.png"):
    """Build a non-streaming mock httpx response for revalidation calls."""
    resp = MagicMock()
    resp.status_code = status
    resp.url = url
    resp.headers = MagicMock()
    resp.headers.get = MagicMock(return_value=None)
    return resp


def _make_client_with_get(response):
    """Return a context-manager Client mock whose .get() returns *response*."""
    client = MagicMock()
    client.get = MagicMock(return_value=response)
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    return client


def _prime_cache_with_meta(url: str, tmp_data_dir, etag: str = '"abc123"') -> Path:
    """Write a cache file + ETag sidecar so fetch_url enters the revalidation branch."""
    from token_goat import image_shrink, paths

    image_shrink.ensure_cache_dir(paths.web_cache_dir())
    import hashlib

    h = hashlib.sha256(url.encode()).hexdigest()
    cache_path = paths.web_cache_dir() / f"{h}.png"
    cache_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    sidecar = cache_path.with_suffix(".png.meta")
    sidecar.write_text(json.dumps({"etag": etag}), encoding="utf-8")
    return cache_path


# ===========================================================================
# 1. webfetch — post-redirect SSRF check on the 304 branch
# ===========================================================================


class TestWebfetchRevalidationSSRF:
    """The 304 (Not Modified) revalidation path must also check the final URL after redirects."""

    def test_304_with_safe_final_url_returns_cached(self, tmp_data_dir):
        """A 304 from the correct origin returns the cached file."""
        url = "https://example.com/image.png"
        _prime_cache_with_meta(url, tmp_data_dir)

        revalidation_resp = _make_non_streaming_response(304, url=url)
        client = _make_client_with_get(revalidation_resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        assert result.exists()

    def test_304_after_redirect_to_private_ip_serves_cached(self, tmp_data_dir):
        """If revalidation redirects to a private IP, the SSRF guard fires but
        the cached file is still served (not a crash, not an SSRF fetch)."""
        url = "https://example.com/image.png"
        _prime_cache_with_meta(url, tmp_data_dir)

        # Simulate an open-redirect: the server redirected us to 127.0.0.1
        revalidation_resp = _make_non_streaming_response(304, url="http://127.0.0.1/secret.png")
        client = _make_client_with_get(revalidation_resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        # Must return the cached file — not raise, not fetch from 127.0.0.1
        assert result.exists()
        # The mock's get() was called once (revalidation attempt), never a streaming fetch
        client.get.assert_called_once()

    def test_304_after_redirect_to_metadata_endpoint_serves_cached(self, tmp_data_dir):
        """Open redirect to the GCP metadata endpoint on the 304 path must be blocked."""
        url = "https://example.com/banner.png"
        _prime_cache_with_meta(url, tmp_data_dir)

        revalidation_resp = _make_non_streaming_response(
            304, url="http://169.254.169.254/latest/meta-data/"
        )
        client = _make_client_with_get(revalidation_resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        assert result.exists()
        client.get.assert_called_once()

    def test_200_on_revalidation_with_private_redirect_serves_cached(self, tmp_data_dir):
        """200 response on revalidation (stale) that redirected to private IP should
        use cached file, not attempt to re-download from the private endpoint."""
        url = "https://example.com/photo.png"
        _prime_cache_with_meta(url, tmp_data_dir)

        revalidation_resp = _make_non_streaming_response(200, url="http://10.0.0.1/bad.png")
        client = _make_client_with_get(revalidation_resp)

        with patch("httpx.Client", return_value=client):
            # The revalidation redirect is blocked; cached file is served
            result = webfetch.fetch_url(url, shrink_if_image=False)

        assert result.exists()


# ===========================================================================
# 2. session — cleanup_stale: symlink skip
# ===========================================================================


class TestCleanupStaleSymlinkSkip:
    """cleanup_stale must skip symlinks in the sessions directory."""

    def test_symlink_is_not_deleted(self, tmp_data_dir, monkeypatch, tmp_path):
        """A symlink whose stem matches the session-ID pattern must not be unlinked."""
        from token_goat import paths

        sessions_dir = paths.session_cache_path("dummy_x").parent
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a real file to point at
        target = tmp_path / "real_target.json"
        target.write_text("{}", encoding="utf-8")

        link = sessions_dir / "valid-session-id-link.json"
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not supported on this platform")

        # Make it look old enough to be pruned by mtime (set mtime far in the past)
        old_time = time.time() - 48 * 3600
        os.utime(target, (old_time, old_time))

        removed = cleanup_stale(max_age_hours=24.0)

        assert removed == 0  # symlink must be skipped, not counted as removed
        assert link.exists() or link.is_symlink()  # still present

    def test_non_session_id_filename_is_skipped(self, tmp_data_dir):
        """Files whose stem contains characters outside [a-zA-Z0-9_-] must be skipped."""
        from token_goat import paths

        sessions_dir = paths.session_cache_path("dummy_x").parent
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # A file with dots or spaces in the stem — must be skipped, not deleted.
        # (The traversal path is shown only as a comment; we write to a safe location.)
        safe_suspicious = sessions_dir / "suspicious.name.with.dots.json"
        safe_suspicious.write_text("{}", encoding="utf-8")
        old_time = time.time() - 48 * 3600
        os.utime(safe_suspicious, (old_time, old_time))

        removed = cleanup_stale(max_age_hours=24.0)

        assert removed == 0
        assert safe_suspicious.exists()


# ===========================================================================
# 3. session — validate_session_id
# ===========================================================================


class TestValidateSessionId:
    """validate_session_id must reject anything outside [a-zA-Z0-9_-]."""

    def test_valid_alphanumeric(self):
        validate_session_id("abc123")  # must not raise

    def test_valid_with_hyphens_and_underscores(self):
        validate_session_id("session-id_v2-42XYZ")

    def test_empty_raises(self):
        with pytest.raises(ValueError, match="empty"):
            validate_session_id("")

    def test_too_long_raises(self):
        with pytest.raises(ValueError, match="too long"):
            validate_session_id("a" * 257)

    def test_slash_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("../../etc/passwd")

    def test_dot_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("session.id")

    def test_newline_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("session\ninjection")

    def test_null_byte_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("session\x00id")


# ===========================================================================
# 4. install — _patch_md_block / _unpatch_md_block atomic idempotency
# ===========================================================================


class TestPatchMdBlockAtomic:
    """_patch_md_block and _unpatch_md_block write atomically and behave correctly."""

    def test_patch_creates_file_when_absent(self, tmp_path):
        md = tmp_path / "TEST.md"
        result = _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "hello world")

        assert result == str(md)
        content = md.read_text(encoding="utf-8")
        assert CLAUDE_MD_BEGIN in content
        assert "hello world" in content
        assert CLAUDE_MD_END in content

    def test_patch_is_idempotent(self, tmp_path):
        md = tmp_path / "TEST.md"
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "first write")
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "second write")

        content = md.read_text(encoding="utf-8")
        # Should contain exactly one begin marker
        assert content.count(CLAUDE_MD_BEGIN) == 1
        assert "second write" in content
        assert "first write" not in content

    def test_patch_appends_to_existing_content(self, tmp_path):
        md = tmp_path / "TEST.md"
        md.write_text("# My File\n\nSome existing content.\n", encoding="utf-8")
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "token-goat content")

        content = md.read_text(encoding="utf-8")
        assert "Some existing content." in content
        assert "token-goat content" in content

    def test_patch_replaces_existing_block(self, tmp_path):
        md = tmp_path / "TEST.md"
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "OLD CONTENT")
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "NEW CONTENT")

        content = md.read_text(encoding="utf-8")
        assert "NEW CONTENT" in content
        assert "OLD CONTENT" not in content

    def test_unpatch_removes_block(self, tmp_path):
        md = tmp_path / "TEST.md"
        md.write_text("# Header\n\nBefore block.\n", encoding="utf-8")
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "block content")
        _unpatch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "not found")

        content = md.read_text(encoding="utf-8")
        assert CLAUDE_MD_BEGIN not in content
        assert "block content" not in content
        # Pre-existing content preserved
        assert "Before block" in content

    def test_unpatch_returns_not_found_when_file_absent(self, tmp_path):
        md = tmp_path / "nonexistent.md"
        result = _unpatch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "FILE NOT FOUND")
        assert result == "FILE NOT FOUND"

    def test_unpatch_codex_markers(self, tmp_path):
        """_patch_md_block / _unpatch_md_block work with Codex markers too."""
        md = tmp_path / "AGENTS.md"
        _patch_md_block(md, CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, "codex block")
        assert CODEX_AGENTS_BEGIN in md.read_text(encoding="utf-8")

        _unpatch_md_block(md, CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, "not found")
        assert CODEX_AGENTS_BEGIN not in md.read_text(encoding="utf-8")

    def test_patch_no_tmp_file_left_behind(self, tmp_path):
        """After _patch_md_block, no .tmp file should remain in the directory."""
        md = tmp_path / "TEST.md"
        _patch_md_block(md, CLAUDE_MD_BEGIN, CLAUDE_MD_END, "content")

        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == [], f"Stale .tmp files found: {tmp_files}"


# ===========================================================================
# 5. read_replacement — sqlite3 errors handled gracefully
# ===========================================================================


class TestReadReplacementSQLiteErrors:
    """read_symbol and read_section must return None on sqlite3 errors, never raise."""

    def _make_project(self, tmp_data_dir, tmp_path):
        from token_goat.project import Project, canonicalize, project_hash

        root = tmp_path / "proj"
        root.mkdir()
        canon = canonicalize(root)
        return Project(root=canon, hash=project_hash(canon), marker=".git")

    def test_read_symbol_returns_none_on_operational_error(self, tmp_data_dir, tmp_path):
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)

        with patch("token_goat.read_replacement.db.open_project") as mock_open:
            mock_conn = MagicMock()
            mock_open.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.side_effect = sqlite3.OperationalError("no such table: symbols")

            result = read_replacement.read_symbol(proj, "foo.py", "my_func")

        assert result is None

    def test_read_symbol_returns_none_on_database_error(self, tmp_data_dir, tmp_path):
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)

        with patch("token_goat.read_replacement.db.open_project") as mock_open:
            mock_conn = MagicMock()
            mock_open.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.side_effect = sqlite3.DatabaseError("database disk image is malformed")

            result = read_replacement.read_symbol(proj, "src/auth.py", "login")

        assert result is None

    def test_read_section_returns_none_on_operational_error(self, tmp_data_dir, tmp_path):
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)

        with patch("token_goat.read_replacement.db.open_project") as mock_open:
            mock_conn = MagicMock()
            mock_open.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.side_effect = sqlite3.OperationalError("database is locked")

            result = read_replacement.read_section(proj, "README.md", "Install")

        assert result is None

    def test_read_section_returns_none_on_database_error(self, tmp_data_dir, tmp_path):
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)

        with patch("token_goat.read_replacement.db.open_project") as mock_open:
            mock_conn = MagicMock()
            mock_open.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.side_effect = sqlite3.DatabaseError("file is not a database")

            result = read_replacement.read_section(proj, "docs/guide.md", "Quick Start")

        assert result is None

    def test_read_symbol_unsafe_rel_path_returns_none(self, tmp_data_dir, tmp_path):
        """Paths with .. traversal are rejected before any DB query."""
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)
        result = read_replacement.read_symbol(proj, "../../etc/passwd", "root")
        assert result is None

    def test_read_section_unsafe_rel_path_returns_none(self, tmp_data_dir, tmp_path):
        from token_goat import read_replacement

        proj = self._make_project(tmp_data_dir, tmp_path)
        result = read_replacement.read_section(proj, "../secrets.md", "API Keys")
        assert result is None


# ===========================================================================
# 6. compact — _format_ranges handles malformed entries
# ===========================================================================


class TestFormatRangesMalformed:
    """_format_ranges must silently skip entries that can't be unpacked as (int, int)."""

    def test_empty_list_returns_empty(self):
        assert _format_ranges([]) == ""

    def test_normal_single_range(self):
        result = _format_ranges([(1, 50)])
        assert "1-50" in result

    def test_single_line_range_no_dash(self):
        result = _format_ranges([(42, 42)])
        assert "42" in result
        assert "42-42" not in result

    def test_malformed_string_entry_is_skipped(self):
        """A string where a tuple is expected must be silently dropped."""
        result = _format_ranges(["not_a_tuple", (1, 10)])  # type: ignore[list-item]
        # The valid entry (1, 10) should be included; the string dropped
        assert "1-10" in result

    def test_malformed_single_element_tuple_is_skipped(self):
        """A tuple with only one element can't be unpacked as (start, end)."""
        result = _format_ranges([(5,), (10, 20)])  # type: ignore[list-item]
        assert "10-20" in result

    def test_malformed_three_element_tuple_is_skipped(self):
        """A tuple with three elements can't be unpacked as (start, end)."""
        result = _format_ranges([(1, 2, 3), (5, 15)])  # type: ignore[list-item]
        assert "5-15" in result

    def test_none_entry_is_skipped(self):
        result = _format_ranges([None, (1, 5)])  # type: ignore[list-item]
        assert "1-5" in result

    def test_all_malformed_returns_empty(self):
        result = _format_ranges(["bad", None, (1,)])  # type: ignore[list-item]
        assert result == ""

    def test_overflow_suffix_for_many_ranges(self):
        """Ranges beyond _MAX_RANGES_PER_FILE get a '+N more' suffix."""
        ranges = [(i * 10, i * 10 + 5) for i in range(10)]
        result = _format_ranges(ranges)
        assert "more" in result

    def test_non_numeric_values_in_tuple_are_skipped(self):
        """A (str, str) tuple can't be coerced to int — must be dropped."""
        result = _format_ranges([("start", "end"), (1, 100)])  # type: ignore[list-item]
        assert "1-100" in result


# ===========================================================================
# 7. parser — get_extractor ImportError handling and caching
# ===========================================================================


class TestGetExtractor:
    """get_extractor must return None on ImportError and cache successful results."""

    def teardown_method(self, method):
        """Clear the extractor cache between tests to avoid cross-test interference."""
        _EXTRACTOR_CACHE.clear()

    def test_unknown_language_returns_none(self):
        result = get_extractor("brainfuck")
        assert result is None

    def test_import_error_returns_none(self):
        """When the language module's factory raises ImportError, get_extractor returns None."""
        from token_goat.parser import _EXTRACTOR_REGISTRY

        def bad_factory():
            raise ImportError("No module named 'tree_sitter_brainfuck'")

        with patch.dict(_EXTRACTOR_REGISTRY, {"fake_lang": bad_factory}):
            result = get_extractor("fake_lang")

        assert result is None

    def test_import_error_not_cached(self):
        """A failed import must not cache None so retries can succeed after install."""
        from token_goat.parser import _EXTRACTOR_REGISTRY

        call_count = 0

        def sometimes_bad_factory():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise ImportError("missing grammar binary")
            # Second call succeeds
            extractor = MagicMock()
            return extractor

        with patch.dict(_EXTRACTOR_REGISTRY, {"retry_lang": sometimes_bad_factory}):
            result1 = get_extractor("retry_lang")
            assert result1 is None
            # Cache should not contain "retry_lang" after failure
            assert "retry_lang" not in _EXTRACTOR_CACHE

    def test_successful_extractor_is_cached(self):
        """A successful factory call is cached so the module is only imported once."""
        from token_goat.parser import _EXTRACTOR_REGISTRY

        factory_calls = []
        fake_extractor = MagicMock()

        def counting_factory():
            factory_calls.append(1)
            return fake_extractor

        with patch.dict(_EXTRACTOR_REGISTRY, {"cached_lang": counting_factory}):
            r1 = get_extractor("cached_lang")
            r2 = get_extractor("cached_lang")

        assert r1 is fake_extractor
        assert r2 is fake_extractor
        assert len(factory_calls) == 1  # factory called only once

    def test_known_language_python_returns_extractor(self):
        """Python is a built-in language — get_extractor must not return None."""
        result = get_extractor("python")
        assert result is not None
