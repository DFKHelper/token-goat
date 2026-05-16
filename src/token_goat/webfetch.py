"""WebFetch image downloader: HTTP fetch + shrink + cache."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import socket
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import image_shrink, paths

_LOG = logging.getLogger("token_goat.webfetch")

# Common image extensions to detect from URL
IMAGE_URL_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif")

# Hostnames that must never be fetched (SSRF protection)
_BLOCKED_HOSTNAMES = frozenset(
    [
        "localhost",
        "metadata.google.internal",  # GCP metadata endpoint
    ]
)

# Set TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1 to allow unresolvable hostnames.
# Default is fail-closed: an unresolvable hostname is treated as blocked.
_ALLOW_UNRESOLVED = os.environ.get("TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED", "").strip() in (
    "1", "true", "yes", "on"
)


def _is_ssrf_safe(url: str) -> bool:
    """Return True only if the URL is safe to fetch (not an SSRF risk).

    Blocks:
    - Non-http/https schemes (file://, ftp://, etc.)
    - Known metadata hostnames (localhost, metadata.google.internal)
    - Private / loopback / link-local IP addresses:
        127.x.x.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x (AWS/GCP/Azure metadata),
        ::1, fc00::/7, fe80::/10
    - Bare IP literals for the above ranges
    - Unresolvable hostnames (fail-closed by default; opt out with
      TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1)
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    hostname = parsed.hostname
    if not hostname:
        return False

    hostname_lower = hostname.lower().rstrip(".")
    if hostname_lower in _BLOCKED_HOSTNAMES:
        _LOG.warning("SSRF guard: blocked hostname %r in URL", hostname)
        return False

    # Try resolving the hostname to an IP and checking if it is private/loopback/link-local.
    try:
        addr_info = socket.getaddrinfo(hostname_lower, None, proto=socket.IPPROTO_TCP)
    except OSError:
        if _ALLOW_UNRESOLVED:
            _LOG.debug("SSRF guard: unresolvable hostname %r allowed (opt-out active)", hostname)
            return True
        _LOG.warning("SSRF guard: blocked unresolvable hostname %r", hostname)
        return False

    for _family, _type, _proto, _canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
            _LOG.warning(
                "SSRF guard: blocked %r (resolves to %s which is private/loopback/link-local)",
                hostname,
                ip_str,
            )
            return False

    return True


def is_image_url(url: str) -> bool:
    """Quick heuristic: URL ends with an image extension (case-insensitive, ignoring query)."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    path = (parsed.path or "").lower()
    return path.endswith(IMAGE_URL_EXTS)


def is_image_content_type(content_type: str) -> bool:
    """Return True if the Content-Type header indicates an image."""
    return content_type.lower().startswith("image/")


def _cache_path_for(url: str, suffix: str) -> Path:
    """Cache filename: <sha256-of-url>.<suffix>"""
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return paths.web_cache_dir() / f"{h}{suffix}"


def _suffix_for(url: str, content_type: str = "") -> str:
    """Derive a sensible file suffix from URL extension or content-type."""
    parsed = urlparse(url)
    path = (parsed.path or "").lower()
    for ext in IMAGE_URL_EXTS:
        if path.endswith(ext):
            return ext
    # Map content-type
    ct = content_type.lower().split(";")[0].strip()
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/avif": ".avif",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
    }
    return mapping.get(ct, ".bin")


def _sidecar_path(cache_path: Path) -> Path:
    """Path to the JSON metadata sidecar for a cached file."""
    return cache_path.with_suffix(cache_path.suffix + ".meta")


_MAX_SIDECAR_BYTES = 4096  # ETag + Last-Modified headers never need more than a few hundred bytes

_ALLOWED_META_KEYS = frozenset(["etag", "last_modified"])
_MAX_META_VALUE_LEN = 512  # per-value cap; ETags are typically <128 chars


def _read_cache_meta(cache_path: Path) -> dict[str, str]:
    """Read ETag/Last-Modified metadata for a cached file, or return {}.

    Guards against oversized or structurally invalid sidecar files that could
    arise from a tampered cache directory:
    - Rejects files larger than 4 KB (no legitimate sidecar needs more).
    - Validates that the parsed result is a flat dict[str, str].
    - Only returns keys from the known allowlist (etag, last_modified).
    - Truncates values that exceed 512 characters.
    """
    sidecar = _sidecar_path(cache_path)
    if not sidecar.exists():
        return {}
    try:
        size = sidecar.stat().st_size
        if size > _MAX_SIDECAR_BYTES:
            _LOG.warning(
                "cache metadata file too large (%d bytes); discarding: %s",
                size,
                sidecar.name,
            )
            return {}
        raw = sidecar.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            _LOG.debug("cache metadata is not a dict; discarding: %s", sidecar.name)
            return {}
        result: dict[str, str] = {}
        for k, v in parsed.items():
            if k not in _ALLOWED_META_KEYS:
                continue
            if not isinstance(v, str):
                _LOG.debug("cache metadata key %r has non-string value; skipping", k)
                continue
            result[k] = v[:_MAX_META_VALUE_LEN]
        return result
    except Exception as e:  # noqa: BLE001
        _LOG.debug("corrupt cache metadata at %s; discarding: %s", sidecar.name, e)
        return {}


def _write_cache_meta(cache_path: Path, response_headers: httpx.Headers) -> None:
    """Persist ETag and/or Last-Modified from response headers alongside the cache file.

    Header values from untrusted servers are truncated to ``_MAX_META_VALUE_LEN``
    (512 chars) before being written.  Without this cap a server could send an
    arbitrarily large ETag value that escapes the 4 KB read-time guard — since the
    read guard only applies when loading cached metadata, not when persisting it.
    """
    meta: dict[str, str] = {}
    if etag := response_headers.get("etag"):
        meta["etag"] = etag[:_MAX_META_VALUE_LEN]
    if lm := response_headers.get("last-modified"):
        meta["last_modified"] = lm[:_MAX_META_VALUE_LEN]
    if not meta:
        return
    try:
        _sidecar_path(cache_path).write_text(json.dumps(meta), encoding="utf-8")
    except OSError as exc:
        _LOG.debug("could not write cache metadata for %s: %s", cache_path.name, exc)


def _stream_to_file(response: httpx.Response, dest: Path, max_size_bytes: int) -> None:
    """Write a streaming HTTP response to *dest* atomically, enforcing a size cap.

    Downloads into a ``.tmp`` sibling first, then renames to *dest* on success.
    The two-phase write avoids leaving a partial file behind on failure, and the
    deferred unlink-on-error pattern is required on Windows where an open file
    cannot be deleted until all handles are closed.

    Raises ``RuntimeError`` if the ``Content-Length`` header or accumulated byte
    count exceeds *max_size_bytes*.
    """
    content_length = int(response.headers.get("content-length", "0"))
    if content_length > max_size_bytes:
        raise RuntimeError(f"file too large: {content_length} bytes > {max_size_bytes}")

    tmp = dest.with_suffix(dest.suffix + ".tmp")
    written = 0
    _oversize_error: RuntimeError | None = None
    try:
        with tmp.open("wb") as f:
            for chunk in response.iter_bytes():
                written += len(chunk)
                if written > max_size_bytes:
                    # Don't unlink here — file is still open (Windows locks it).
                    # Record the error; the outer except will clean up after close.
                    _oversize_error = RuntimeError(
                        f"file too large during stream: {written} > {max_size_bytes}"
                    )
                    break
                f.write(chunk)
        # File is now closed; safe to clean up on Windows.
        if _oversize_error is not None:
            tmp.unlink(missing_ok=True)
            raise _oversize_error
        tmp.replace(dest)
        _LOG.debug("webfetch: streamed %d bytes to %s", written, dest.name)
    except Exception as e:
        _LOG.warning("webfetch: stream write failed after %d bytes: %s", written, e)
        tmp.unlink(missing_ok=True)
        raise


def _validate_response_url(url: str) -> None:
    """Reject a fetched response URL if it resolves to an SSRF target."""
    if not _is_ssrf_safe(url):
        raise ValueError(f"URL blocked by SSRF safety check after redirect: {url!r}")


def cleanup_stale_downloads() -> int:
    """Remove any leftover ``.tmp`` partial download files. Returns count removed."""
    cache_dir = paths.web_cache_dir()
    if not cache_dir.exists():
        return 0
    removed = 0
    for f in cache_dir.glob("*.tmp"):
        try:
            f.unlink(missing_ok=True)
            removed += 1
            _LOG.debug("cleaned up partial download: %s", f.name)
        except OSError as exc:
            _LOG.debug("could not remove partial download %s: %s", f.name, exc)
    return removed


def fetch_url(
    url: str,
    *,
    shrink_if_image: bool = True,
    timeout_sec: float = 30.0,
    max_size_bytes: int = 50 * 1024 * 1024,
) -> Path:
    """Download a URL. Return the local cached path. Shrink if image and big enough.

    Raises ValueError if the URL fails SSRF safety checks (private/loopback IPs,
    metadata endpoints, non-http/https schemes, unresolvable hostnames).

    Sends ETag / If-Modified-Since conditional requests when cache metadata is
    available; returns the cached file unchanged on HTTP 304 Not Modified.
    """
    if not _is_ssrf_safe(url):
        raise ValueError(f"URL blocked by SSRF safety check: {url!r}")

    image_shrink.ensure_cache_dir(paths.web_cache_dir())

    # Pre-check: do we already have it cached?
    pre_suffix = _suffix_for(url)
    candidate = _cache_path_for(url, pre_suffix)
    if candidate.exists():
        meta = _read_cache_meta(candidate)
        if meta:
            # Attempt revalidation with conditional request
            headers: dict[str, str] = {}
            if "etag" in meta:
                headers["If-None-Match"] = meta["etag"]
            if "last_modified" in meta:
                headers["If-Modified-Since"] = meta["last_modified"]
            try:
                with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
                    r = client.get(url, headers=headers)
                if r.status_code == 304:
                    _LOG.info("web cache revalidated (304): %s", candidate.name)
                    if shrink_if_image:
                        return image_shrink.shrink_if_image(candidate)
                    return candidate
                if r.status_code == 200:
                    # Fresh content — fall through to re-download path below
                    _LOG.info("web cache stale (200 on revalidation): %s", candidate.name)
                else:
                    # Unexpected status — return cached file
                    _LOG.debug("revalidation returned %s; using cached %s", r.status_code, candidate.name)
                    return candidate
            except httpx.RequestError as exc:
                _LOG.debug("revalidation request failed (%s); using cached %s", exc, candidate.name)
                return candidate
        else:
            _LOG.info("web cache hit (URL-derived): %s", candidate.name)
            if shrink_if_image:
                return image_shrink.shrink_if_image(candidate)
            return candidate

    # Download
    with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client, \
            client.stream("GET", url) as r:
        r.raise_for_status()
        final_url = str(r.url)
        if final_url != url:
            _LOG.info("web fetch redirected: %s -> %s", url, final_url)
        _validate_response_url(final_url)
        content_type = r.headers.get("content-type", "")
        suffix = _suffix_for(url, content_type)
        cache_path = _cache_path_for(url, suffix)
        _stream_to_file(r, cache_path, max_size_bytes)
        _write_cache_meta(cache_path, r.headers)

    # Shrink if image
    if shrink_if_image:
        return image_shrink.shrink_if_image(cache_path)

    return cache_path
