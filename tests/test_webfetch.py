"""Tests for the webfetch module — Phase 14."""
from __future__ import annotations

import io
from unittest.mock import MagicMock, patch

import pytest

from token_goat import webfetch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_png_bytes(width: int = 64, height: int = 64) -> bytes:
    """Return raw bytes of a synthetic PNG using Pillow."""
    import random

    from PIL import Image

    img = Image.new("RGB", (width, height))
    pixels = [
        (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        for _ in range(width * height)
    ]
    img.putdata(pixels)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _make_large_png_bytes() -> bytes:
    """Return >100 KB of PNG bytes (1200×900 random)."""
    import random

    from PIL import Image

    img = Image.new("RGB", (1200, 900))
    pixels = [
        (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        for _ in range(1200 * 900)
    ]
    img.putdata(pixels)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    data = buf.getvalue()
    # Pad if still under threshold
    from token_goat import image_shrink
    while len(data) <= image_shrink.SIZE_THRESHOLD_BYTES:
        data += b"\x00" * 10240
    return data


def _mock_http_response(body: bytes, content_type: str = "image/png", status: int = 200):
    """Build a mock httpx streaming response."""
    mock_resp = MagicMock()
    mock_resp.status_code = status
    mock_resp.url = "https://example.com/final.png"
    mock_resp.headers = {
        "content-type": content_type,
        "content-length": str(len(body)),
    }
    # raise_for_status does nothing for 200
    mock_resp.raise_for_status = MagicMock()
    # iter_bytes yields the body in one chunk
    mock_resp.iter_bytes = MagicMock(return_value=iter([body]))
    mock_resp.__enter__ = MagicMock(return_value=mock_resp)
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


def _mock_client(response):
    """Return a context-manager mock wrapping the given response."""
    mock_client = MagicMock()
    mock_client.stream = MagicMock(return_value=response)
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    return mock_client


# ---------------------------------------------------------------------------
# 1. is_image_url
# ---------------------------------------------------------------------------

class TestIsImageUrl:
    def test_jpg_url(self):
        assert webfetch.is_image_url("https://example.com/photo.jpg") is True

    def test_png_url(self):
        assert webfetch.is_image_url("https://example.com/banner.png") is True

    def test_webp_url(self):
        assert webfetch.is_image_url("https://example.com/img.webp") is True

    def test_avif_url(self):
        assert webfetch.is_image_url("https://example.com/img.avif") is True

    def test_uppercase_extension(self):
        assert webfetch.is_image_url("https://example.com/PHOTO.JPG") is True

    def test_non_image_url(self):
        assert webfetch.is_image_url("https://example.com/page.html") is False

    def test_json_url(self):
        assert webfetch.is_image_url("https://example.com/data.json") is False

    def test_non_http_scheme(self):
        assert webfetch.is_image_url("ftp://example.com/photo.jpg") is False

    def test_file_scheme(self):
        assert webfetch.is_image_url("file:///home/user/photo.jpg") is False

    def test_url_with_query_string(self):
        # Query string does not affect path matching
        assert webfetch.is_image_url("https://cdn.example.com/img.png?v=2") is True

    def test_empty_string(self):
        assert webfetch.is_image_url("") is False

    def test_plain_text_url(self):
        assert webfetch.is_image_url("https://example.com/readme.txt") is False


# ---------------------------------------------------------------------------
# 2. is_image_content_type
# ---------------------------------------------------------------------------

class TestIsImageContentType:
    def test_image_jpeg(self):
        assert webfetch.is_image_content_type("image/jpeg") is True

    def test_image_png(self):
        assert webfetch.is_image_content_type("image/png") is True

    def test_image_webp(self):
        assert webfetch.is_image_content_type("image/webp") is True

    def test_application_json(self):
        assert webfetch.is_image_content_type("application/json") is False

    def test_text_html(self):
        assert webfetch.is_image_content_type("text/html") is False

    def test_with_charset(self):
        assert webfetch.is_image_content_type("image/png; charset=utf-8") is True


# ---------------------------------------------------------------------------
# 3. _suffix_for: derives from URL extension
# ---------------------------------------------------------------------------

class TestSuffixForUrl:
    def test_jpg(self):
        assert webfetch._suffix_for("https://example.com/photo.jpg") == ".jpg"

    def test_jpeg(self):
        assert webfetch._suffix_for("https://example.com/photo.jpeg") == ".jpeg"

    def test_png(self):
        assert webfetch._suffix_for("https://example.com/banner.png") == ".png"

    def test_webp(self):
        assert webfetch._suffix_for("https://example.com/img.webp") == ".webp"

    def test_avif(self):
        assert webfetch._suffix_for("https://example.com/img.avif") == ".avif"


# ---------------------------------------------------------------------------
# 4. _suffix_for: content-type fallback when URL has no extension
# ---------------------------------------------------------------------------

class TestSuffixForContentType:
    def test_jpeg_content_type(self):
        assert webfetch._suffix_for("https://example.com/image", "image/jpeg") == ".jpg"

    def test_png_content_type(self):
        assert webfetch._suffix_for("https://example.com/image", "image/png") == ".png"

    def test_webp_content_type(self):
        assert webfetch._suffix_for("https://example.com/image", "image/webp") == ".webp"

    def test_unknown_content_type(self):
        assert webfetch._suffix_for("https://example.com/image", "application/octet-stream") == ".bin"

    def test_no_extension_no_content_type(self):
        assert webfetch._suffix_for("https://example.com/image") == ".bin"


# ---------------------------------------------------------------------------
# 5. fetch_url: downloads and caches
# ---------------------------------------------------------------------------

class TestFetchUrl:
    def test_download_and_cache(self, tmp_data_dir):
        body = _make_png_bytes(64, 64)
        url = "https://example.com/test.png"

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        assert result.exists()
        assert result.read_bytes() == body

    def test_cached_path_uses_sha256_of_url(self, tmp_data_dir):
        import hashlib

        body = _make_png_bytes()
        url = "https://example.com/specific.png"
        expected_stem = hashlib.sha256(url.encode()).hexdigest()

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        assert result.stem == expected_stem

    def test_redirect_to_private_target_is_blocked(self, tmp_data_dir):
        url = "https://example.com/redirect.png"
        resp = _mock_http_response(b"body", "image/png")
        resp.url = "http://127.0.0.1/private.png"
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client), pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url(url, shrink_if_image=False)

        resp.iter_bytes.assert_not_called()


# ---------------------------------------------------------------------------
# 6. fetch_url: cache reuse — mock not called twice for body
# ---------------------------------------------------------------------------

class TestFetchUrlCacheReuse:
    def test_second_call_returns_cached_path(self, tmp_data_dir):
        body = _make_png_bytes()
        url = "https://example.com/cached.png"

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client) as mock_cls:
            result1 = webfetch.fetch_url(url, shrink_if_image=False)
            result2 = webfetch.fetch_url(url, shrink_if_image=False)

        assert result1 == result2
        # Client was only constructed once (second call is a cache hit)
        assert mock_cls.call_count == 1


# ---------------------------------------------------------------------------
# 7. fetch_url: oversized file raises RuntimeError, no cache file left
# ---------------------------------------------------------------------------

class TestFetchUrlOversized:
    def test_content_length_header_too_large(self, tmp_data_dir):
        url = "https://example.com/huge.png"
        max_bytes = 1024

        resp = _mock_http_response(b"x" * 512, "image/png")
        resp.headers = {
            "content-type": "image/png",
            "content-length": str(max_bytes + 1),
        }
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client), \
                pytest.raises(RuntimeError, match="file too large"):
            webfetch.fetch_url(url, max_size_bytes=max_bytes)

    def test_streaming_exceeds_limit_cleans_up(self, tmp_data_dir):
        url = "https://example.com/sneaky.png"
        max_bytes = 100
        # content-length is 0 so header check passes; body exceeds limit
        body = b"x" * (max_bytes + 50)

        resp = MagicMock()
        resp.status_code = 200
        resp.url = "https://example.com/sneaky.png"
        resp.headers = {"content-type": "image/png", "content-length": "0"}
        resp.raise_for_status = MagicMock()
        # Yield body in one big chunk to trigger the streaming guard
        resp.iter_bytes = MagicMock(return_value=iter([body]))
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        client = _mock_client(resp)

        cache_dir = webfetch.paths.web_cache_dir()

        with patch("httpx.Client", return_value=client), \
                pytest.raises(RuntimeError, match="file too large"):
            webfetch.fetch_url(url, max_size_bytes=max_bytes)

        # No .tmp or cached file should survive
        leftover = list(cache_dir.glob("*.tmp"))
        assert leftover == [], f"Temp files not cleaned up: {leftover}"


# ---------------------------------------------------------------------------
# 8. fetch_url: shrinking applied when image > 100 KB
# ---------------------------------------------------------------------------

class TestFetchUrlShrink:
    def test_large_image_gets_shrunk(self, tmp_data_dir):
        """A >100 KB PNG download should be passed through image_shrink.shrink."""
        url = "https://example.com/large.png"
        body = _make_large_png_bytes()

        # Only run if we actually made a large enough body
        from token_goat import image_shrink as _is
        if len(body) <= _is.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough PNG body")

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=True)

        # The returned path should exist
        assert result.exists()
        from token_goat import paths as _paths
        # Shrunken files land in image_cache_dir, not web_cache_dir
        assert result.parent in (_paths.image_cache_dir(), _paths.web_cache_dir())


# ---------------------------------------------------------------------------
# 9. SSRF protection: _is_ssrf_safe and fetch_url refuse private/loopback URLs
# ---------------------------------------------------------------------------

class TestIsSsrfSafe:
    def test_public_https_allowed(self):
        assert webfetch._is_ssrf_safe("https://example.com/image.png") is True

    def test_public_http_allowed(self):
        assert webfetch._is_ssrf_safe("http://example.com/image.png") is True

    def test_non_http_scheme_blocked(self):
        assert webfetch._is_ssrf_safe("file:///etc/passwd") is False

    def test_ftp_scheme_blocked(self):
        assert webfetch._is_ssrf_safe("ftp://example.com/file.jpg") is False

    def test_localhost_blocked(self):
        assert webfetch._is_ssrf_safe("http://localhost/admin") is False

    def test_localhost_uppercase_blocked(self):
        assert webfetch._is_ssrf_safe("http://LOCALHOST/admin") is False

    def test_gcp_metadata_hostname_blocked(self):
        assert webfetch._is_ssrf_safe("http://metadata.google.internal/computeMetadata/v1/") is False

    def test_loopback_ipv4_blocked(self):
        assert webfetch._is_ssrf_safe("http://127.0.0.1/") is False

    def test_loopback_ipv4_variant_blocked(self):
        assert webfetch._is_ssrf_safe("http://127.1.2.3/") is False

    def test_aws_metadata_ip_blocked(self):
        # 169.254.169.254 is the link-local AWS/Azure/GCP IMDS endpoint
        assert webfetch._is_ssrf_safe("http://169.254.169.254/latest/meta-data/") is False

    def test_link_local_range_blocked(self):
        assert webfetch._is_ssrf_safe("http://169.254.0.1/anything") is False

    def test_private_rfc1918_10_blocked(self):
        assert webfetch._is_ssrf_safe("http://10.0.0.1/") is False

    def test_private_rfc1918_192_168_blocked(self):
        assert webfetch._is_ssrf_safe("http://192.168.1.1/router") is False

    def test_private_rfc1918_172_blocked(self):
        assert webfetch._is_ssrf_safe("http://172.16.0.1/internal") is False

    def test_empty_url_blocked(self):
        assert webfetch._is_ssrf_safe("") is False

    def test_no_hostname_blocked(self):
        assert webfetch._is_ssrf_safe("https:///image.png") is False


class TestFetchUrlSsrfGuard:
    """fetch_url must raise ValueError for SSRF-blocked URLs (never make the request)."""

    def test_localhost_raises_value_error(self, tmp_data_dir):
        with pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url("http://localhost/image.png")

    def test_aws_metadata_raises_value_error(self, tmp_data_dir):
        with pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url("http://169.254.169.254/latest/meta-data/iam/security-credentials/")

    def test_private_ip_raises_value_error(self, tmp_data_dir):
        with pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url("http://10.0.0.1/image.png")

    def test_loopback_raises_no_http_request(self, tmp_data_dir):
        """Verify httpx.Client is never constructed for a blocked URL."""
        with patch("httpx.Client") as mock_cls, \
                pytest.raises(ValueError):
            webfetch.fetch_url("http://127.0.0.1/image.png")
        mock_cls.assert_not_called()


# ---------------------------------------------------------------------------
# 11. CLI: token-goat fetch-image <bad-url> exits 0 with stderr message
# ---------------------------------------------------------------------------

class TestFetchImageCli:
    def test_bad_url_exits_zero_with_stderr(self, tmp_data_dir):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["fetch-image", "https://this-host-definitely-does-not-exist-token-goat.invalid/photo.jpg"])

        assert result.exit_code == 0, f"Expected exit 0, got {result.exit_code}"
        # output contains the error message (typer CliRunner merges stderr into output by default)
        assert "WebFetch failed" in (result.output or "")


# ---------------------------------------------------------------------------
# 12. fetch_url: content-hash dedup across URLs
# ---------------------------------------------------------------------------

class TestFetchUrlContentDedup:
    """Two different URLs serving identical bytes should share the shrunk artifact.

    Real-world driver: an agent in a long session fetches the same screenshot
    pasted into a Slack thread *and* attached to a GitHub PR comment.  The URLs
    differ; the bytes are byte-identical.  Without content-hash dedup we run the
    full image-shrink pipeline on the second URL even though the same SHA was
    just shrunk seconds ago.
    """

    def test_index_records_content_sha_after_download(self, tmp_data_dir):
        """A successful fetch writes a by_content/<sha>.idx pointer to the cache file."""
        import hashlib

        body = _make_png_bytes()
        url = "https://example.com/a.png"

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            webfetch.fetch_url(url, shrink_if_image=False)

        content_sha = hashlib.sha256(body).hexdigest()
        idx = webfetch._content_index_path(content_sha)
        assert idx.exists(), "content index pointer was not written"

    def test_meta_records_content_sha256(self, tmp_data_dir):
        """The URL-keyed sidecar carries the content_sha256 for later dedup."""
        import hashlib

        body = _make_png_bytes()
        url = "https://example.com/meta-sha.png"

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=False)

        meta = webfetch._read_cache_meta(result)
        assert meta.get("content_sha256") == hashlib.sha256(body).hexdigest()

    def test_second_url_same_bytes_skips_shrink_pipeline(self, tmp_data_dir):
        """A second URL serving identical bytes returns the prior shrunk artifact directly.

        The dedup short-circuit must fire *after* the second download (we still
        have to receive the bytes to know they match), but *before* the second
        image_shrink invocation.  We verify by asserting that the second call
        returns the same Path the first call produced AND that shrink runs at
        most once.
        """
        body = _make_large_png_bytes()

        from token_goat import image_shrink as _is
        if len(body) <= _is.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough PNG body")

        url_a = "https://example.com/slack-screenshot.png"
        url_b = "https://example.com/github-pr-comment.png"

        # Each fetch returns its own response; both have identical bodies.
        resp_a = _mock_http_response(body, "image/png")
        resp_b = _mock_http_response(body, "image/png")

        call_count = {"shrink": 0}
        real_shrink = _is.shrink_if_image

        def counting_shrink(path):
            call_count["shrink"] += 1
            return real_shrink(path)

        with patch("httpx.Client", side_effect=[_mock_client(resp_a), _mock_client(resp_b)]), \
                patch.object(_is, "shrink_if_image", side_effect=counting_shrink):
            result_a = webfetch.fetch_url(url_a, shrink_if_image=True)
            result_b = webfetch.fetch_url(url_b, shrink_if_image=True)

        # Dedup hit means the second URL returns the same shrunk artifact path.
        assert result_a == result_b
        # First call shrinks; second call short-circuits via the content index.
        assert call_count["shrink"] == 1, (
            f"shrink_if_image should run exactly once across two URLs with identical bytes; "
            f"ran {call_count['shrink']} times"
        )

    def test_shrunk_pointer_skips_image_shrink_on_url_cache_hit(self, tmp_data_dir):
        """A repeat fetch of the *same* URL with a recorded shrunk_path skips shrink."""
        body = _make_large_png_bytes()

        from token_goat import image_shrink as _is
        if len(body) <= _is.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough PNG body")

        url = "https://example.com/repeat.png"
        resp = _mock_http_response(body, "image/png")

        # First fetch performs the actual download + shrink.
        with patch("httpx.Client", return_value=_mock_client(resp)):
            first = webfetch.fetch_url(url, shrink_if_image=True)

        # Second fetch should hit the URL cache; with the shrunk_path pointer
        # set, it must not invoke image_shrink at all.
        with patch.object(_is, "shrink_if_image") as mock_shrink, \
                patch("httpx.Client") as mock_cls:
            second = webfetch.fetch_url(url, shrink_if_image=True)

        assert first == second
        mock_shrink.assert_not_called()
        # No HTTP request was made either — pointer hit beats revalidation.
        mock_cls.assert_not_called()

    def test_stale_pointer_falls_back_gracefully(self, tmp_data_dir):
        """A vanished shrunk artifact must not break the cache; we re-shrink."""
        body = _make_large_png_bytes()

        from token_goat import image_shrink as _is
        if len(body) <= _is.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough PNG body")

        url = "https://example.com/stale.png"
        resp_a = _mock_http_response(body, "image/png")

        with patch("httpx.Client", return_value=_mock_client(resp_a)):
            first = webfetch.fetch_url(url, shrink_if_image=True)

        # Simulate the shrunk artifact being evicted by the LRU sweeper.
        if first.exists():
            first.unlink()

        # The next fetch should detect the missing pointer target and re-shrink
        # rather than returning a path-to-nothing.
        resp_b = _mock_http_response(body, "image/png")
        with patch("httpx.Client", return_value=_mock_client(resp_b)):
            second = webfetch.fetch_url(url, shrink_if_image=True)

        assert second.exists(), "stale-pointer fallback returned a non-existent path"

    def test_corrupt_content_index_is_discarded(self, tmp_data_dir):
        """A malformed index file is treated as a miss, not an exception."""
        sha = "0" * 64
        idx = webfetch._content_index_path(sha)
        idx.parent.mkdir(parents=True, exist_ok=True)
        idx.write_text("{not valid json", encoding="utf-8")

        assert webfetch._read_content_index(sha) is None

    def test_content_index_pointer_to_missing_file_cleaned_up(self, tmp_data_dir):
        """A pointer whose target was deleted is removed on lookup."""
        sha = "1" * 64
        idx = webfetch._content_index_path(sha)
        idx.parent.mkdir(parents=True, exist_ok=True)
        idx.write_text('{"cache_path": "C:/does/not/exist.png"}', encoding="utf-8")

        assert webfetch._read_content_index(sha) is None
        assert not idx.exists(), "stale pointer should be deleted on lookup"

    def test_hash_file_sha256_unreadable_returns_none(self, tmp_data_dir, tmp_path):
        """An unreadable file yields None (caller treats as 'no dedup possible')."""
        nonexistent = tmp_path / "ghost.png"
        assert webfetch._hash_file_sha256(nonexistent) is None


# ---------------------------------------------------------------------------
# 13. _strip_html_to_text: HTML-to-text compression
# ---------------------------------------------------------------------------

class TestStripHtmlToText:
    """Unit tests for the _strip_html_to_text helper."""

    # Minimal HTML page padded to guarantee >20% reduction
    _HTML_TEMPLATE = (
        "<!DOCTYPE html>\n<html><head><title>Test</title>"
        "<style>body {{ color: red; }}</style>"
        "<script>alert('x');</script>"
        "</head><body>"
        "<nav><a href='/'>Home</a></nav>"
        "<header><h1>Header</h1></header>"
        "<main><p>Hello world</p><p>Second paragraph</p></main>"
        "<footer>Footer content here</footer>"
        "</body></html>"
    )

    def _html_body(self, extra_padding: int = 0) -> bytes:
        """Return HTML bytes, optionally padded so the stripping ratio is clear."""
        # Build a page with enough boilerplate that stripping yields >20% reduction.
        nav_bloat = "<nav>" + ("<a href='#'>link</a>" * 20) + "</nav>"
        script_bloat = "<script>" + ("var x = 1;\n" * 30) + "</script>"
        style_bloat = "<style>" + ("body { margin: 0; }\n" * 30) + "</style>"
        content = "<p>Readable content here.</p>" * 5
        html = (
            "<!DOCTYPE html>\n<html><head>"
            + style_bloat
            + script_bloat
            + "</head><body>"
            + nav_bloat
            + content
            + "</body></html>"
        )
        return (html + " " * extra_padding).encode("utf-8")

    def test_html_is_stripped_to_text(self):
        """HTML with substantial boilerplate is stripped and returns fewer bytes."""
        body = self._html_body()
        result = webfetch._strip_html_to_text(body)
        assert result is not body
        assert len(result) < len(body)

    def test_result_contains_marker(self):
        """Stripped output starts with the token-goat marker line."""
        body = self._html_body()
        result = webfetch._strip_html_to_text(body)
        # Only check marker if stripping fired (i.e. result differs from input)
        if result is not body and result != body:
            first_line = result.decode("utf-8", errors="replace").splitlines()[0]
            assert first_line.startswith("[token-goat: HTML→text,"), (
                f"Marker missing or wrong; first line was: {first_line!r}"
            )

    def test_json_content_passes_through_unchanged(self):
        """Non-HTML content (JSON) is returned as-is."""
        body = b'{"key": "value", "items": [1, 2, 3]}'
        assert webfetch._strip_html_to_text(body) is body

    def test_plain_text_passes_through_unchanged(self):
        """Plain text without HTML markers is returned as-is."""
        body = b"Just some plain text content without any markup.\n" * 10
        assert webfetch._strip_html_to_text(body) is body

    def test_minimal_html_no_reduction_passes_through(self):
        """When stripping yields <20% reduction the original bytes are returned."""
        # A page that is almost entirely text inside a thin HTML shell —
        # after stripping the HTML shell the byte count drops by much less than 20%.
        content = "word " * 500  # ~2500 bytes of text
        thin_html = f"<html><body>{content}</body></html>"
        body = thin_html.encode("utf-8")
        result = webfetch._strip_html_to_text(body)
        # Should be unchanged because reduction < 20%
        assert result is body

    def test_script_and_style_blocks_removed(self):
        """<script> and <style> block content does not appear in stripped output."""
        body = self._html_body()
        result = webfetch._strip_html_to_text(body)
        if result is body:
            pytest.skip("stripping threshold not met for this input size")
        decoded = result.decode("utf-8", errors="replace")
        assert "var x = 1" not in decoded, "script content should be removed"
        assert "margin: 0" not in decoded, "style content should be removed"

    def test_nav_block_removed(self):
        """<nav> block content does not appear in stripped output."""
        body = self._html_body()
        result = webfetch._strip_html_to_text(body)
        if result is body:
            pytest.skip("stripping threshold not met for this input size")
        # The nav contains many repetitions of the link anchor text
        decoded = result.decode("utf-8", errors="replace")
        # nav block had 20 repetitions of 'link'; at most a stray one might
        # survive as link text, but the bulk should be gone
        link_count = decoded.count("link")
        assert link_count < 5, f"nav <a> text leaked into stripped output ({link_count} occurrences)"

    def test_readable_content_preserved(self):
        """Paragraph text survives the stripping pass."""
        body = self._html_body()
        result = webfetch._strip_html_to_text(body)
        if result is body:
            pytest.skip("stripping threshold not met for this input size")
        decoded = result.decode("utf-8", errors="replace")
        assert "Readable content here" in decoded

    def test_never_raises_on_garbage_input(self):
        """_strip_html_to_text must not raise for any byte sequence."""
        for bad in (b"", b"\xff\xfe\x00", b"<html>" + bytes(range(256)), b"\x00" * 1000):
            result = webfetch._strip_html_to_text(bad)
            assert isinstance(result, bytes)
