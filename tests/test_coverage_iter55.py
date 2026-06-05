"""Tests for code added/changed in iterations 50-55.

Covers:
- gdrive._try_stored_oauth: permanent OAuth error (invalid_grant) deletes creds file and returns None
- gdrive._try_stored_oauth: transient error keeps creds file and returns None
- repomap.compute_ranks: ImportError on _pagerank_python falls back to nx.pagerank
- repomap.compute_ranks: both pagerank implementations fail → uniform rank fallback
- embeddings.embed_texts: dimension mismatch raises EmbeddingsUnavailable
- webfetch._stream_to_file: non-integer Content-Length header skips pre-check and downloads normally
- session._normalize_path: POSIX no-backslash fast path returns unchanged
- session._normalize_path: uppercase drive letter lowercased in fast path (Windows only)
- hints: single-pass loop over multiple non-contiguous cached ranges picks max last_cached_end
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# 1. gdrive._try_stored_oauth — permanent error deletes creds file
# ---------------------------------------------------------------------------

class TestTryStoredOauthPermanentError:
    """Permanent OAuth errors (invalid_grant etc.) must delete the stale creds file."""

    def _write_fake_creds(self, tmp_data_dir) -> Path:
        from token_goat import paths
        creds_path = paths.gdrive_creds_path()
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text('{"token": "t", "refresh_token": "r", "token_uri": "u", "client_id": "c", "client_secret": "s"}')
        return creds_path

    def test_invalid_grant_deletes_creds_and_returns_none(self, tmp_data_dir):
        """A permanent 'invalid_grant' error must delete the creds file and return None."""
        from token_goat import gdrive

        creds_path = self._write_fake_creds(tmp_data_dir)
        assert creds_path.exists()

        fake_creds = MagicMock()
        fake_creds.expired = True
        fake_creds.refresh_token = "some-refresh-token"
        fake_creds.refresh.side_effect = Exception("invalid_grant: Token has been expired or revoked")

        with patch("google.oauth2.credentials.Credentials.from_authorized_user_file", return_value=fake_creds), \
             patch("google.auth.transport.requests.Request"):
            result = gdrive._try_stored_oauth()

        assert result is None
        assert not creds_path.exists(), "Creds file must be deleted on permanent OAuth failure"

    def test_transient_error_keeps_creds_and_returns_none(self, tmp_data_dir):
        """A transient network error must NOT delete the creds file."""
        from token_goat import gdrive

        creds_path = self._write_fake_creds(tmp_data_dir)
        assert creds_path.exists()

        fake_creds = MagicMock()
        fake_creds.expired = True
        fake_creds.refresh_token = "some-refresh-token"
        fake_creds.refresh.side_effect = Exception("Connection timed out")

        with patch("google.oauth2.credentials.Credentials.from_authorized_user_file", return_value=fake_creds), \
             patch("google.auth.transport.requests.Request"):
            result = gdrive._try_stored_oauth()

        assert result is None
        assert creds_path.exists(), "Creds file must NOT be deleted on transient failure"


# ---------------------------------------------------------------------------
# 2. repomap.compute_ranks — ImportError + total failure fallback
# ---------------------------------------------------------------------------

class TestComputeRanksFallbacks:
    """compute_ranks must degrade gracefully when networkx internals change."""

    def _make_graph(self):
        import networkx as nx
        g = nx.MultiDiGraph()
        g.add_edge("a", "b")
        g.add_edge("b", "c")
        g.add_edge("a", "c")
        return g

    def test_import_error_falls_back_to_nx_pagerank(self):
        """When _pagerank_python is absent, falls back to nx.pagerank."""
        from token_goat import repomap

        g = self._make_graph()

        with patch.dict("sys.modules", {"networkx.algorithms.link_analysis.pagerank_alg": None}):
            # Simulate ImportError for the private symbol by patching the import
            import builtins
            real_import = builtins.__import__

            def fake_import(name, *args, **kwargs):
                if name == "networkx.algorithms.link_analysis.pagerank_alg":
                    raise ImportError("simulated missing private symbol")
                return real_import(name, *args, **kwargs)

            with patch("builtins.__import__", side_effect=fake_import):
                ranks = repomap.compute_ranks(g)

        assert isinstance(ranks, dict)
        assert set(ranks.keys()) == {"a", "b", "c"}
        # All ranks positive
        assert all(v > 0 for v in ranks.values())

    def test_all_pagerank_fail_returns_uniform(self):
        """When both _pagerank_python and nx.pagerank fail, returns uniform ranks."""
        import networkx as nx

        from token_goat import repomap

        g = self._make_graph()

        # Patch _pagerank_python to raise ConvergenceError, and nx.pagerank to also fail
        conv_err = nx.PowerIterationFailedConvergence(100)

        def fake_pagerank_python(graph, **kwargs):
            raise conv_err

        with patch("networkx.algorithms.link_analysis.pagerank_alg._pagerank_python",
                   side_effect=fake_pagerank_python, create=True), \
             patch("networkx.pagerank", side_effect=Exception("scipy failure")):
            ranks = repomap.compute_ranks(g)

        # All nodes should have equal uniform rank
        assert isinstance(ranks, dict)
        values = list(ranks.values())
        assert len(values) == 3
        assert all(abs(v - values[0]) < 1e-9 for v in values), "Expected uniform ranks"


# ---------------------------------------------------------------------------
# 3. embeddings.embed_texts — dimension mismatch raises EmbeddingsUnavailable
# ---------------------------------------------------------------------------

class TestEmbedTextsDimensionMismatch:
    """embed_texts must raise EmbeddingsUnavailable when the model returns wrong dimensions."""

    def test_dimension_mismatch_raises(self):
        """A model returning wrong-dimension vectors triggers EmbeddingsUnavailable."""
        from token_goat.embeddings import (
            DEFAULT_DIM,
            DEFAULT_MODEL,
            EmbeddingsUnavailable,
            embed_texts,
        )

        wrong_dim = DEFAULT_DIM + 1  # e.g. 385 instead of 384
        fake_arr = MagicMock()
        fake_arr.tolist.return_value = [0.1] * wrong_dim

        fake_model = MagicMock()
        fake_model.embed.return_value = iter([fake_arr])

        with patch("token_goat.embeddings._get_model", return_value=fake_model), pytest.raises(EmbeddingsUnavailable, match="Dimension mismatch"):
            embed_texts(["hello world"], model_name=DEFAULT_MODEL)

    def test_correct_dimension_returns_vectors(self):
        """A model returning the correct dimension must succeed."""
        from token_goat.embeddings import DEFAULT_DIM, DEFAULT_MODEL, embed_texts

        fake_arr = MagicMock()
        fake_arr.tolist.return_value = [0.1] * DEFAULT_DIM

        fake_model = MagicMock()
        fake_model.embed.return_value = iter([fake_arr])

        with patch("token_goat.embeddings._get_model", return_value=fake_model):
            result = embed_texts(["hello world"], model_name=DEFAULT_MODEL)

        assert len(result) == 1
        assert len(result[0]) == DEFAULT_DIM


# ---------------------------------------------------------------------------
# 4. webfetch._stream_to_file — non-integer Content-Length skips pre-check
# ---------------------------------------------------------------------------

class TestStreamToFileNonIntegerContentLength:
    """Non-integer Content-Length must be ignored (pre-check skipped) and download proceeds."""

    def test_non_integer_content_length_falls_back_to_zero(self, tmp_path):
        """'chunked' or garbage Content-Length must not crash — download proceeds."""
        from token_goat.webfetch import _stream_to_file

        body = b"hello world"
        dest = tmp_path / "out.bin"

        resp = MagicMock()
        resp.headers = {"content-length": "chunked"}  # non-integer
        resp.iter_bytes.return_value = iter([body])

        _stream_to_file(resp, dest, max_size_bytes=1024)

        assert dest.exists()
        assert dest.read_bytes() == body

    def test_missing_content_length_also_succeeds(self, tmp_path):
        """Missing Content-Length header defaults to 0 and download proceeds."""
        from token_goat.webfetch import _stream_to_file

        body = b"data"
        dest = tmp_path / "out2.bin"

        resp = MagicMock()
        # MagicMock().headers.get("content-length", "0") returns "0" by default
        # since get() on a MagicMock returns a new MagicMock — not what we want.
        # Provide a real dict-like headers object that returns "0" for missing key.
        resp.headers = {"content-type": "application/octet-stream"}
        resp.iter_bytes.return_value = iter([body])

        _stream_to_file(resp, dest, max_size_bytes=1024)

        assert dest.exists()
        assert dest.read_bytes() == body


# ---------------------------------------------------------------------------
# 5. session._normalize_path — fast path and drive-letter lowercasing
# ---------------------------------------------------------------------------

class TestNormalizePathFastPath:
    """_normalize_path fast path: no backslash → no Path allocation."""

    def test_posix_path_unchanged(self):
        """A POSIX path with no backslashes is returned as-is."""
        from token_goat.session import _normalize_path
        p = "/home/user/project/file.py"
        assert _normalize_path(p) == p

    def test_already_normalized_windows_path_unchanged(self):
        """A forward-slash Windows path with lowercase drive is returned as-is."""
        from token_goat.session import _normalize_path
        p = "c:/projects/token-goat/src/main.py"
        assert _normalize_path(p) == p

    def test_uppercase_drive_letter_lowercased_fast_path(self):
        """Uppercase drive letter is lowercased even in the fast path (no backslashes)."""
        from token_goat.session import _normalize_path
        # No backslashes — hits the fast path branch
        result = _normalize_path("C:/projects/file.py")
        assert result == "c:/projects/file.py"

    def test_backslash_path_normalized(self):
        """Backslash-containing path is normalized to forward slashes."""
        from token_goat.session import _normalize_path
        result = _normalize_path("C:\\projects\\token-goat\\file.py")
        assert "\\" not in result
        assert result.startswith("c:/") or result.startswith("C:/")


# ---------------------------------------------------------------------------
# 6. hints — single-pass loop: last_cached_end picks max of multiple ranges
# ---------------------------------------------------------------------------

class TestHintsSinglePassMultipleRanges:
    """The single-pass overlap loop must use last_cached_end = max of all cached ends."""

    def test_resume_offset_uses_highest_cached_end(self, tmp_data_dir):
        """With two non-contiguous cached ranges, resume offset = max(cached_end)."""
        import token_goat.session as sess
        from token_goat.hints import build_read_hint

        sid = "s_multirange_55"
        path = "/proj/multi.py"

        # Record two non-contiguous read ranges.
        # offset=0,limit=100 → stored as (1,100); offset=200,limit=100 → stored as (201,300).
        sess.mark_file_read(sid, path, offset=0, limit=100)
        sess.mark_file_read(sid, path, offset=200, limit=100)

        # Request offset=249,limit=200 → req_start=250, req_end=449.
        # Overlaps with cached (201,300): overlap = 250..300 = 51 lines (> MIN_OVERLAP_TO_WARN=50).
        # last_cached_end = max(100, 300) = 300 → resume offset in hint should be 300.
        hint = build_read_hint(session_id=sid, file_path=path, offset=249, limit=200, cwd=None)

        # Should produce an overlap hint (> MIN_OVERLAP_TO_WARN=50 lines overlap).
        assert hint is not None, "Expected overlap hint for 51-line overlap across two cached ranges"
        # The resume offset in the hint text should reference 300 (last_cached_end = max of range ends).
        assert "300" in hint, f"Expected resume offset 300 in hint: {hint!r}"

    def test_multi_range_exact_match_detected(self, tmp_data_dir):
        """An exact re-read of any cached range is detected even with multiple ranges."""
        import token_goat.session as sess
        from token_goat.hints import build_read_hint

        sid = "s_multirange_exact_55"
        path = "/proj/exact.py"

        # Record range 50-200 then an unrelated range 300-400
        sess.mark_file_read(sid, path, offset=50, limit=151)
        sess.mark_file_read(sid, path, offset=300, limit=101)

        # Request exactly 50-200 again — should trigger exact match hint.
        hint = build_read_hint(session_id=sid, file_path=path, offset=50, limit=151, cwd=None)

        assert hint is not None
        assert "⌘" in hint or "already read" in hint.lower() or "re-reading" in hint.lower()  # terse "cached"
