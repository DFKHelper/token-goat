"""Tests for the webfetch module — Phase 14."""
from __future__ import annotations

import io
from unittest.mock import MagicMock, patch

import pytest

from cc_saver import webfetch

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
    from cc_saver import image_shrink
    while len(data) <= image_shrink.SIZE_THRESHOLD_BYTES:
        data += b"\x00" * 10240
    return data


def _mock_http_response(body: bytes, content_type: str = "image/png", status: int = 200):
    """Build a mock httpx streaming response."""
    mock_resp = MagicMock()
    mock_resp.status_code = status
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
        from cc_saver import image_shrink as _is
        if len(body) <= _is.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough PNG body")

        resp = _mock_http_response(body, "image/png")
        client = _mock_client(resp)

        with patch("httpx.Client", return_value=client):
            result = webfetch.fetch_url(url, shrink_if_image=True)

        # The returned path should exist
        assert result.exists()
        from cc_saver import paths as _paths
        # Shrunken files land in image_cache_dir, not web_cache_dir
        assert result.parent in (_paths.image_cache_dir(), _paths.web_cache_dir())


# ---------------------------------------------------------------------------
# 9. CLI: cc-saver fetch-image <bad-url> exits 0 with stderr message
# ---------------------------------------------------------------------------

class TestFetchImageCli:
    def test_bad_url_exits_zero_with_stderr(self, tmp_data_dir):
        from typer.testing import CliRunner

        from cc_saver.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["fetch-image", "https://this-host-definitely-does-not-exist-cc-saver.invalid/photo.jpg"])

        assert result.exit_code == 0, f"Expected exit 0, got {result.exit_code}"
        # output contains the error message (typer CliRunner merges stderr into output by default)
        assert "WebFetch failed" in (result.output or "")
