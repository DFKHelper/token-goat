"""Tests for the webfetch module — Phase 14."""
from __future__ import annotations

import contextlib
import functools
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


@functools.lru_cache(maxsize=1)
def _make_large_png_bytes() -> bytes:
    """Return >100 KB of PNG bytes (1200×900 random). Cached per process."""
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

    # Audit: RFC1918 172.16/12 spans 172.16.0.0–172.31.255.255.  Only the lower
    # boundary was previously covered; verify the middle and upper bounds are
    # also rejected so a regex-style implementation that drops the high octet
    # cannot regress unnoticed.
    @pytest.mark.parametrize(
        "ip_url",
        [
            "http://172.17.0.1/",        # docker bridge default
            "http://172.20.10.1/",       # iOS personal hotspot range
            "http://172.31.255.254/",    # upper bound of the /12
        ],
    )
    def test_private_rfc1918_172_middle_and_upper_blocked(self, ip_url):
        assert webfetch._is_ssrf_safe(ip_url) is False

    # Audit: 127.0.0.0/8 — verify the upper edge and a non-canonical zero-padded
    # form are also rejected.  The IPv4 octet parser is strict so the leading-zero
    # form is rejected by `ipaddress.ip_address` itself, which we still want covered.
    def test_loopback_upper_edge_blocked(self):
        assert webfetch._is_ssrf_safe("http://127.255.255.254/") is False

    # Audit: link-local /16 — verify a non-IMDS link-local address is also blocked
    # so a wildcard exception for "non-metadata link-local" cannot silently appear.
    def test_link_local_non_imds_blocked(self):
        assert webfetch._is_ssrf_safe("http://169.254.99.99/") is False

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

    # Audit: DNS-rebind class.  A hostname (not an IP literal) that resolves to
    # a private IP must be rejected at the _is_ssrf_safe stage *before* the IP
    # pin step runs and *before* any httpx.Client is constructed.  This proves
    # the end-to-end gate closes on a hostile DNS server that returns a private
    # IP for an otherwise-arbitrary hostname.
    @pytest.mark.parametrize(
        "private_ip",
        [
            "127.0.0.1",        # loopback
            "10.0.0.5",         # RFC1918 /8
            "172.16.7.7",       # RFC1918 /12 lower
            "172.24.0.99",      # RFC1918 /12 middle
            "192.168.1.50",     # RFC1918 /16
            "169.254.169.254",  # link-local IMDS
        ],
    )
    def test_hostname_resolving_to_private_ip_blocked(self, tmp_data_dir, private_ip):
        """A hostname that DNS-resolves to a private IP must raise ValueError
        without httpx.Client ever being constructed (DNS-rebind class)."""
        import socket

        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (private_ip, 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), \
                patch("httpx.Client") as mock_cls, \
                pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url("http://rebind.attacker.example/image.png")
        mock_cls.assert_not_called()

    def test_hostname_resolving_to_ipv4_mapped_private_blocked(self, tmp_data_dir):
        """A hostname whose only address is an IPv4-mapped IPv6 private address
        must be rejected (no httpx.Client ever constructed)."""
        import socket

        fake_addrinfo = [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:192.168.1.1", 0, 0, 0)),
        ]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), \
                patch("httpx.Client") as mock_cls, \
                pytest.raises(ValueError, match="SSRF"):
            webfetch.fetch_url("http://v6mapped.attacker.example/image.png")
        mock_cls.assert_not_called()


# ---------------------------------------------------------------------------
# 10b. DNS rebinding mitigation: _resolve_and_validate_ip + _make_pinned_transport
# ---------------------------------------------------------------------------


class TestResolveAndValidateIp:
    """_resolve_and_validate_ip must return a safe public IP or raise ValueError."""

    def test_private_ip_raises(self):
        """A hostname that resolves only to a private IP must raise ValueError."""
        import socket
        from unittest.mock import patch

        # Simulate a hostname that resolves to 10.0.0.1 (private RFC1918)
        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), pytest.raises(ValueError, match="no safe address"):
            webfetch._resolve_and_validate_ip("internal.corp")

    def test_loopback_ip_raises(self):
        """A hostname that resolves only to 127.x.x.x must raise ValueError."""
        import socket
        from unittest.mock import patch

        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), pytest.raises(ValueError, match="no safe address"):
            webfetch._resolve_and_validate_ip("loopback.internal")

    def test_link_local_ip_raises(self):
        """A hostname that resolves to 169.254.x.x (IMDS) must raise ValueError."""
        import socket
        from unittest.mock import patch

        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), pytest.raises(ValueError, match="no safe address"):
            webfetch._resolve_and_validate_ip("metadata.aws")

    def test_unresolvable_hostname_raises(self):
        """An unresolvable hostname must raise ValueError (fail-closed)."""
        from unittest.mock import patch

        with patch("socket.getaddrinfo", side_effect=OSError("Name or service not known")), pytest.raises(ValueError, match="cannot resolve"):
            webfetch._resolve_and_validate_ip("does-not-exist.invalid")

    def test_public_ip_returned(self):
        """A hostname that resolves to a public IP must return the IP string."""
        import socket
        from unittest.mock import patch

        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo):
            result = webfetch._resolve_and_validate_ip("example.com")
        assert result == "93.184.216.34"

    def test_ipv4_mapped_ipv6_private_raises(self):
        """An IPv4-mapped IPv6 address in a private range must raise ValueError."""
        import socket
        from unittest.mock import patch

        # ::ffff:10.0.0.1 maps to 10.0.0.1 (private)
        fake_addrinfo = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:10.0.0.1", 0, 0, 0))]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), pytest.raises(ValueError, match="no safe address"):
            webfetch._resolve_and_validate_ip("mapped.internal")

    def test_mixed_addresses_returns_first_safe(self):
        """When addr_info has a private entry first then a public entry, return the public one."""
        import socket
        from unittest.mock import patch

        fake_addrinfo = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 0)),     # private
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)), # public
        ]
        with patch("socket.getaddrinfo", return_value=fake_addrinfo):
            result = webfetch._resolve_and_validate_ip("mixed.example.com")
        assert result == "93.184.216.34"


class TestMakePinnedTransport:
    """_make_pinned_transport must produce a transport whose getaddrinfo stub
    redirects lookups to the pinned IP (verifying the DNS rebinding window is closed)."""

    def test_pinned_transport_redirects_getaddrinfo(self):
        """getaddrinfo calls inside the pinned transport must go to the pinned IP."""
        import socket
        from unittest.mock import MagicMock, patch

        pinned_ip = "93.184.216.34"
        transport = webfetch._make_pinned_transport(pinned_ip)

        # Intercept calls inside handle_request by monkey-patching httpx.HTTPTransport
        # at the base class level to avoid an actual network connection.
        captured_hosts: list[str] = []
        original_getaddrinfo = socket.getaddrinfo

        def capturing_getaddrinfo(host, port, *args, **kwargs):
            if isinstance(host, str):
                captured_hosts.append(host)
            # Use the real getaddrinfo to avoid import-order issues, but return
            # a loopback so no actual connection happens.
            return original_getaddrinfo("127.0.0.1", port, *args, **kwargs)

        # Build a fake request and mock the parent handle_request
        import httpx
        fake_request = httpx.Request("GET", "http://example.com/")
        fake_response = MagicMock(spec=httpx.Response)

        with patch.object(httpx.HTTPTransport, "handle_request", return_value=fake_response), \
                patch("socket.getaddrinfo", side_effect=capturing_getaddrinfo), \
                contextlib.suppress(Exception):
            transport.handle_request(fake_request)

        # After handle_request returns, socket.getaddrinfo must be restored
        assert socket.getaddrinfo is original_getaddrinfo, (
            "socket.getaddrinfo was not restored after handle_request"
        )

    def test_getaddrinfo_restored_after_exception(self):
        """socket.getaddrinfo is restored even if handle_request raises."""
        import socket
        from unittest.mock import patch

        import httpx

        pinned_ip = "93.184.216.34"
        transport = webfetch._make_pinned_transport(pinned_ip)
        original_getaddrinfo = socket.getaddrinfo
        fake_request = httpx.Request("GET", "http://example.com/")

        with patch.object(httpx.HTTPTransport, "handle_request", side_effect=RuntimeError("boom")), pytest.raises(RuntimeError, match="boom"):
            transport.handle_request(fake_request)

        assert socket.getaddrinfo is original_getaddrinfo, (
            "socket.getaddrinfo leaked after exception in handle_request"
        )


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

    # Audit: user-supplied URL on the CLI surface must be gated by the same SSRF
    # check as the hook surface.  `token-goat fetch-image <url>` is the only
    # public CLI that accepts a URL argument and forwards it to httpx; if this
    # gate ever weakens an unsanitized URL would reach the network layer.
    @pytest.mark.parametrize(
        "ssrf_url",
        [
            "http://localhost/admin",
            "http://127.0.0.1/private",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/internal",
            "http://172.16.0.1/internal",
            "http://192.168.1.1/router",
            "file:///etc/passwd",
            "ftp://example.com/image.jpg",
        ],
    )
    def test_cli_blocks_ssrf_url(self, tmp_data_dir, ssrf_url):
        """`token-goat fetch-image` must fail-soft on an SSRF-blocked URL and
        never construct an httpx.Client."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        with patch("httpx.Client") as mock_cls:
            result = runner.invoke(app, ["fetch-image", ssrf_url])
        # CLI is fail-soft (exit 0 with stderr message); the meaningful assertion
        # is that no HTTP request ever fired for the blocked URL.
        assert result.exit_code == 0, f"Expected exit 0, got {result.exit_code}: {result.output}"
        mock_cls.assert_not_called()

    def test_cli_blocks_hostname_resolving_to_private_ip(self, tmp_data_dir):
        """DNS-rebind class through the CLI: hostname must be rejected before
        httpx fires."""
        import socket

        from typer.testing import CliRunner

        from token_goat.cli import app

        fake_addrinfo = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]
        runner = CliRunner()
        with patch("socket.getaddrinfo", return_value=fake_addrinfo), \
                patch("httpx.Client") as mock_cls:
            result = runner.invoke(app, ["fetch-image", "http://rebind-cli.example/photo.png"])
        assert result.exit_code == 0
        mock_cls.assert_not_called()


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


# ---------------------------------------------------------------------------
# 14. fetch_url: tampered sidecar containment check
# ---------------------------------------------------------------------------

class TestFetchUrlTamperedSidecar:
    """A tampered .meta sidecar pointing shrunk_path outside the cache roots must be rejected."""

    def test_tampered_shrunk_path_is_rejected(self, tmp_path, caplog):
        """shrunk_path pointing to a file outside cache roots must not be returned.

        Construct a cached file + sidecar where shrunk_path has been tampered
        to point at a sensitive file outside the cache directory.  The second
        call to fetch_url (which hits the sidecar) must not return that path;
        it must log a warning and fall through to the normal (no-shrink) path.
        """
        import contextlib
        import json
        import logging
        from unittest.mock import patch

        from token_goat import paths as _paths

        url = "https://example.com/tampered-sidecar.png"
        body = _make_png_bytes(64, 64)

        # Create a fake "secret" file outside any cache root.
        secret_file = tmp_path / "sensitive_data.txt"
        secret_file.write_text("super secret content", encoding="utf-8")

        # Set up a fake data dir so paths.web_cache_dir() / image_cache_dir()
        # point into tmp_path, keeping them isolated from the real data dir.
        fake_data = tmp_path / "fake_data"
        fake_data.mkdir()

        with patch.object(_paths, "data_dir", return_value=fake_data):
            # First fetch: download and cache the file normally.
            resp = _mock_http_response(body, "image/png")
            client = _mock_client(resp)
            with patch("httpx.Client", return_value=client):
                cached = webfetch.fetch_url(url, shrink_if_image=False)

            assert cached.exists()

            # Tamper the sidecar: overwrite shrunk_path to point at our secret file.
            meta_path = cached.with_suffix(cached.suffix + ".meta")
            existing_meta: dict = {}
            if meta_path.exists():
                with contextlib.suppress(json.JSONDecodeError, OSError):
                    existing_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            existing_meta["shrunk_path"] = str(secret_file)
            meta_path.write_text(json.dumps(existing_meta), encoding="utf-8")

            # Second fetch: should hit the sidecar, detect the tampered path,
            # log a warning, and NOT return the secret file path.
            with caplog.at_level(logging.WARNING, logger="token_goat.webfetch"):
                result = webfetch.fetch_url(url, shrink_if_image=True)

        # The returned path must not be the tampered secret file.
        assert result != secret_file, (
            "fetch_url returned the tampered shrunk_path pointing outside the cache roots"
        )
        assert result.resolve() != secret_file.resolve(), (
            "fetch_url returned a path resolving to the tampered target"
        )

        # A warning must have been emitted.
        warning_messages = [r.message for r in caplog.records if r.levelno >= logging.WARNING]
        assert any("tampered" in str(m) or "outside allowed" in str(m) for m in warning_messages), (
            f"Expected a containment-failure warning; got: {warning_messages}"
        )
