"""WebFetch image downloader: HTTP fetch + shrink + cache.

Provides ``fetch_url()``, which downloads a URL to the local web cache
directory and returns the local path.  Images are automatically passed through
``image_shrink.shrink_if_image()`` to reduce token cost before they reach the
model.

Security hardening
------------------
* SSRF guard (``_is_ssrf_safe``): rejects private/loopback/link-local IPs,
  metadata endpoints (GCP/AWS), non-http/https schemes, and unresolvable
  hostnames (fail-closed by default; opt out with
  ``TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1``).
* Post-redirect SSRF check: validates the *final* URL after ``httpx`` follows
  redirects, closing the open-redirect bypass vector.
* Streaming with size cap: ``_stream_to_file`` enforces ``max_size_bytes``
  during download so a large response cannot exhaust disk space.
* Sidecar metadata validation: ETag/Last-Modified sidecars are size-capped,
  key-allowlisted, and value-truncated before use.
"""
from __future__ import annotations

import contextlib
import hashlib
import html as _html_mod
import ipaddress
import json
import os
import re as _re
import socket
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlparse

if TYPE_CHECKING:
    import httpx

from . import image_shrink, paths
from .hooks_common import sanitize_log_str
from .util import get_logger

__all__ = ["cleanup_stale_downloads", "fetch_url", "is_image_content_type", "is_image_url"]

_LOG = get_logger("webfetch")


def _sanitize_header_value(value: str, max_len: int = 512) -> str:
    """Strip CRLF from an HTTP header value and truncate to *max_len*.

    Stored ETag / Last-Modified values come from untrusted server responses.
    Without stripping ``\\r`` / ``\\n`` a malicious server can inject arbitrary
    headers into the next conditional request by returning a crafted ETag such
    as ``abc\\r\\nX-Injected: evil``.
    """
    sanitized = value.replace("\r", "").replace("\n", "")
    return sanitized[:max_len]


_MAX_URL_IN_ERROR = 200  # chars kept in RuntimeError messages; prevents unbounded error strings
_MAX_URL_LEN = 8192  # hard cap on URL length; urlparse + string ops on a 100 MB URL burn CPU/RAM


def _truncate_url(url: str, max_len: int = _MAX_URL_IN_ERROR) -> str:
    """Truncate *url* for safe inclusion in error/log messages.

    URLs come from harness payloads and can be arbitrarily long.  Without a
    cap, a harness that supplies a megabyte-sized URL would produce an equally
    large RuntimeError string that could flood structured logs, exhaust string
    formatters, or carry attacker-controlled text deep into error-handling code.
    Truncation also strips any embedded newlines that could inject fake log
    lines when the error is eventually logged.
    """
    sanitized = url.replace("\r", "").replace("\n", "")
    if len(sanitized) > max_len:
        return sanitized[:max_len] + "…"
    return sanitized


# Common image extensions to detect from URL
IMAGE_URL_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif")

# MIME type → file extension mapping used by _suffix_for(); built once at module load.
# Only raster formats that Pillow can decompress and recompress are listed.  SVG is
# deliberately absent (it's XML, not a raster bitmap) and PDF is absent (document, not
# an image the model views inline).  Falls back to ".bin" for anything not listed here.
_CONTENT_TYPE_EXT: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
}

# Hostnames that must never be fetched (SSRF protection)
_BLOCKED_HOSTNAMES = frozenset(
    [
        "localhost",
        "ip6-localhost",    # common /etc/hosts alias for ::1
        "ip6-loopback",     # common /etc/hosts alias for ::1
        "metadata.google.internal",  # GCP metadata endpoint
        "169.254.169.254",  # AWS/Azure/GCP instance metadata (bare IP literal)
    ]
)

# Set TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1 to allow unresolvable hostnames.
# Default is fail-closed: an unresolvable hostname is treated as blocked.
_ALLOW_UNRESOLVED = os.environ.get("TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED", "").strip() in (
    "1", "true", "yes", "on"
)

# Configurable request timeout for fetch_url().  Defaults to 30 s; overridable
# via TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS (float seconds) for slow networks or
# strict CI environments that need a tighter budget.
def _webfetch_timeout() -> float:
    """Return the configured HTTP request timeout in seconds.

    Reads ``TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS`` at call time so that tests can
    set the env var after import without a module reload.  Invalid values fall
    back to the 30 s default with a debug log rather than crashing the hook.
    """
    raw = os.environ.get("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "").strip()
    if not raw:
        return 30.0
    try:
        val = float(raw)
        if val <= 0:
            _LOG.debug(
                "TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS=%r is not positive; using 30s default", raw
            )
            return 30.0
        return val
    except ValueError:
        _LOG.debug(
            "TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS=%r is not a valid float; using 30s default", raw
        )
        return 30.0


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

    # rstrip(".") strips the trailing DNS root dot (e.g. "example.com." is valid
    # but would miss a blocklist lookup on "example.com" without the strip).
    hostname_lower = hostname.lower().rstrip(".")
    if hostname_lower in _BLOCKED_HOSTNAMES:
        _LOG.warning("SSRF guard: blocked hostname %r in URL", hostname)
        return False

    # Resolve the hostname to IP(s) and check every returned address.  We must
    # check *all* addresses, not just the first: a dual-stack host can return a
    # safe public IPv4 and a private IPv6 in the same getaddrinfo response, and
    # the OS or httpx can pick either one at connect time.
    try:
        addr_info = socket.getaddrinfo(hostname_lower, None, proto=socket.IPPROTO_TCP)
    except OSError:
        if _ALLOW_UNRESOLVED:
            _LOG.debug("SSRF guard: unresolvable hostname %r allowed (opt-out active)", hostname)
            return True
        # Fail-closed: an unresolvable hostname is treated as blocked so that
        # internal hostnames invisible from outside a VPC cannot be probed.
        _LOG.warning("SSRF guard: blocked unresolvable hostname %r", hostname)
        return False

    for _family, _type, _proto, _canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue

        # Unwrap IPv4-mapped IPv6 addresses (::ffff:192.168.x.x, ::ffff:10.x.x.x, etc.)
        # so the private/loopback checks below apply to the embedded IPv4 address.
        # Without this an attacker can bypass SSRF guards by sending an IPv6 literal
        # that maps to a private IPv4 range.
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped

        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
            _LOG.warning(
                "SSRF guard: blocked %r (resolves to %s which is private/loopback/link-local)",
                hostname,
                ip_str,
            )
            return False

    return True


def is_image_url(url: str) -> bool:
    """Quick heuristic: URL ends with an image extension (case-insensitive, ignoring query).

    Rejects URLs longer than ``_MAX_URL_LEN`` before calling ``urlparse``.  A
    crafted megabyte-scale URL would otherwise cause ``urlparse`` and the
    subsequent ``.lower()`` / ``.endswith()`` calls to burn CPU and memory
    before any downstream size check fires.
    """
    if len(url) > _MAX_URL_LEN:
        return False
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
    """Derive a sensible file suffix from the URL path extension or Content-Type header.

    Checks the URL path first (e.g. ``.../photo.webp`` → ``".webp"``) so that
    the URL's extension takes precedence over a possibly generic Content-Type.
    Falls back to a MIME-type mapping when the URL has no recognizable extension.
    Returns ``".bin"`` when neither source yields a known image type.
    """
    parsed = urlparse(url)
    path = (parsed.path or "").lower()
    for ext in IMAGE_URL_EXTS:
        if path.endswith(ext):
            return ext
    # Map content-type
    ct = content_type.lower().split(";")[0].strip()
    return _CONTENT_TYPE_EXT.get(ct, ".bin")


def _sidecar_path(cache_path: Path) -> Path:
    """Path to the JSON metadata sidecar for a cached file."""
    return cache_path.with_suffix(cache_path.suffix + ".meta")


_MAX_SIDECAR_BYTES = 4096  # ETag + Last-Modified headers never need more than a few hundred bytes

_ALLOWED_META_KEYS = frozenset(["etag", "last_modified", "content_sha256", "shrunk_path"])
_MAX_META_VALUE_LEN = 512  # per-value cap; ETags are typically <128 chars
_MAX_SHRUNK_PATH_LEN = 4096  # absolute path to the shrunk artifact; allows long Windows paths


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
            # Defense-in-depth: strip CRLF even if the write path already did so.
            # These values flow directly into HTTP request headers; any embedded
            # \r\n would allow header injection on the next conditional GET.
            # Path-typed keys use a larger cap (Windows long-path support) but
            # still strip CRLF to keep the JSON safe to round-trip.
            cap = _MAX_SHRUNK_PATH_LEN if k == "shrunk_path" else _MAX_META_VALUE_LEN
            result[k] = _sanitize_header_value(v, cap)
        return result
    except Exception as e:
        _LOG.debug("corrupt cache metadata at %s; discarding: %s", sidecar.name, e)
        return {}


def _write_cache_meta(
    cache_path: Path,
    response_headers: httpx.Headers,
    *,
    extra: dict[str, str] | None = None,
) -> None:
    """Persist ETag and/or Last-Modified from response headers alongside the cache file.

    Header values from untrusted servers are truncated to ``_MAX_META_VALUE_LEN``
    (512 chars) before being written.  Without this cap a server could send an
    arbitrarily large ETag value that escapes the 4 KB read-time guard — since the
    read guard only applies when loading cached metadata, not when persisting it.

    *extra* may carry additional allow-listed keys produced locally (not from the
    server), e.g. ``content_sha256`` and ``shrunk_path`` for dedup bookkeeping.
    These are merged in *after* the header-derived values so the local view wins
    a clash.  Unknown keys are ignored.
    """
    meta: dict[str, str] = {}
    if etag := response_headers.get("etag"):
        meta["etag"] = _sanitize_header_value(etag, _MAX_META_VALUE_LEN)
    if lm := response_headers.get("last-modified"):
        meta["last_modified"] = _sanitize_header_value(lm, _MAX_META_VALUE_LEN)
    if extra:
        for k, v in extra.items():
            if k not in _ALLOWED_META_KEYS or not isinstance(v, str):
                continue
            cap = _MAX_SHRUNK_PATH_LEN if k == "shrunk_path" else _MAX_META_VALUE_LEN
            meta[k] = _sanitize_header_value(v, cap)
    if not meta:
        return
    try:
        _sidecar_path(cache_path).write_text(json.dumps(meta), encoding="utf-8")
    except OSError as exc:
        _LOG.debug("could not write cache metadata for %s: %s", cache_path.name, exc)


def _hash_file_sha256(path: Path) -> str | None:
    """Streaming SHA256 of *path* contents.  Returns ``None`` if the file is unreadable.

    Used for content-hash dedup: two different URLs that serve identical bytes
    (e.g. the same screenshot pasted into a Slack thread *and* a GitHub PR
    comment) end up with the same hash and can share the shrunk artifact.
    Streams in 1 MB chunks so a 50 MB image doesn't materialize in memory.
    """
    try:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError as exc:
        _LOG.debug("could not hash %s for content dedup: %s", path.name, exc)
        return None


def _resolve_shrunk_path(shrunk_pointer: str) -> Path | None:
    """Return Path(shrunk_pointer) if it lives under a known cache root, else None.

    Sidecar files are on disk and could be tampered with; an attacker-controlled
    path like ``../../.ssh/id_rsa`` would cause token-goat to serve an arbitrary
    file. Resolve symlinks and confirm containment before trusting the value.
    """
    candidate = Path(shrunk_pointer)
    allowed_roots = (paths.image_cache_dir().resolve(), paths.web_cache_dir().resolve())
    try:
        resolved = candidate.resolve()
        contained = any(
            resolved == root or str(resolved).startswith(str(root) + ("/" if str(root)[-1] != "/" else ""))
            for root in allowed_roots
        )
        with contextlib.suppress(AttributeError):
            contained = any(resolved.is_relative_to(root) for root in allowed_roots)
    except (OSError, ValueError):
        contained = False
    if not contained:
        _LOG.warning(
            "web cache: shrunk_path sidecar points outside allowed cache roots "
            "(possible tampered sidecar); ignoring pointer: %s",
            candidate,
        )
        return None
    return candidate


def _content_index_path(content_sha256: str) -> Path:
    """Return the path to the content-hash index pointer for *content_sha256*.

    The index lives under ``web_cache_dir() / "by_content" / <sha>.idx`` and
    contains a JSON pointer to the canonical URL-keyed cache file.  It enables
    cross-URL dedup: any future fetch whose downloaded bytes hash to the same
    value can look up the existing canonical entry without re-running the shrink.
    """
    return paths.web_cache_dir() / "by_content" / f"{content_sha256}.idx"


def _read_content_index(content_sha256: str) -> Path | None:
    """Look up the canonical cache file for *content_sha256*, or return None.

    Returns None when the index entry is missing, malformed, or points at a
    file that has since been evicted from the cache.  Stale entries are
    proactively cleaned up so the index doesn't accumulate dead pointers.
    """
    idx = _content_index_path(content_sha256)
    if not idx.exists():
        return None
    try:
        size = idx.stat().st_size
        if size > _MAX_SIDECAR_BYTES:
            _LOG.debug("content index too large (%d bytes); discarding: %s", size, idx.name)
            return None
        raw = idx.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return None
        target = parsed.get("cache_path")
        if not isinstance(target, str) or not target:
            return None
        target_path = Path(target)
        if not target_path.exists():
            # Pointer is stale — eviction or manual cleanup deleted the target.
            # Best-effort cleanup so the next fetch with this hash takes the
            # fresh-download path instead of a second stale-pointer round trip.
            with contextlib.suppress(OSError):
                idx.unlink()
            return None
        return target_path
    except (OSError, ValueError) as exc:
        _LOG.debug("corrupt content index at %s; discarding: %s", idx.name, exc)
        return None


def _write_content_index(content_sha256: str, cache_path: Path) -> None:
    """Record that *content_sha256* maps to *cache_path* (the canonical URL-keyed file).

    Failures are logged at DEBUG and swallowed.  The index is an optimization;
    losing one entry just means the next fetch with the same hash re-runs the
    shrink path instead of short-circuiting.  No correctness impact.
    """
    idx = _content_index_path(content_sha256)
    try:
        paths.ensure_dir(idx.parent)
        # Store the path as a POSIX-style absolute string so the file is portable
        # across platforms (matters on WSL where the same cache dir might be
        # opened from both Linux and Windows code paths).
        payload = json.dumps({"cache_path": str(cache_path)})
        idx.write_text(payload, encoding="utf-8")
    except OSError as exc:
        _LOG.debug("could not write content index for %s: %s", cache_path.name, exc)


def _stream_to_file(response: httpx.Response, dest: Path, max_size_bytes: int) -> None:
    """Write a streaming HTTP response to *dest* atomically, enforcing a size cap.

    Downloads into a ``.tmp`` sibling first, then renames to *dest* on success.
    The two-phase write avoids leaving a partial file behind on failure, and the
    deferred unlink-on-error pattern is required on Windows where an open file
    cannot be deleted until all handles are closed.

    Raises ``RuntimeError`` if the ``Content-Length`` header or accumulated byte
    count exceeds *max_size_bytes*.
    """
    raw_cl = response.headers.get("content-length", "0")
    try:
        content_length = int(raw_cl)
    except (ValueError, TypeError):
        _LOG.debug("webfetch: non-integer Content-Length %r; skipping pre-check", raw_cl)
        content_length = 0
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
    except RuntimeError:
        # RuntimeError is either _oversize_error (already handled above) or
        # raised by the caller — don't double-log it, just clean up and re-raise.
        tmp.unlink(missing_ok=True)
        raise
    except Exception as e:
        _LOG.warning("webfetch: stream write failed after %d bytes: %s", written, e)
        tmp.unlink(missing_ok=True)
        raise


def _validate_response_url(url: str) -> None:
    """Raise ValueError if *url* is an SSRF target after following redirects.

    Called with the *final* URL after ``httpx`` has resolved any redirects.
    An open redirect on a trusted host could otherwise forward the request to
    a private IP or metadata endpoint that passed the pre-fetch SSRF check.
    """
    if not _is_ssrf_safe(url):
        raise ValueError(f"URL blocked by SSRF safety check after redirect: {_truncate_url(url)!r}")


def cleanup_stale_downloads() -> int:
    """Remove leftover ``.tmp`` partial-download files from the web cache directory.

    ``_stream_to_file`` writes to a ``<hash>.<ext>.tmp`` sibling before
    atomically renaming to the final path.  If the process is killed mid-stream
    the ``.tmp`` file is orphaned.  This function sweeps those files out so
    stale partials don't accumulate across restarts.  Returns the number of
    files removed.
    """
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


def _strip_html_to_text(body: bytes) -> bytes:
    """Strip HTML boilerplate to readable text for token-efficient storage.

    Returns the stripped text as UTF-8 bytes, or the original bytes if:
    - Content is not HTML (no ``<html`` or ``<!doctype`` near the top)
    - Stripping produces less than 20% size reduction
    - Any decoding/processing error occurs

    The function is intentionally fail-soft: any unhandled exception returns
    the original *body* unchanged so a malformed page never breaks caching.
    """
    try:
        try:
            text = body.decode("utf-8", errors="replace")
        except Exception:
            return body

        lower = text[:2000].lower()  # check only the preamble for speed
        if "<html" not in lower and "<!doctype" not in lower:
            return body  # not HTML — JSON, plain text, Markdown pass through unchanged

        original_len = len(body)

        # Remove script/style/nav/header/footer/aside/noscript blocks entirely
        for tag in ("script", "style", "nav", "header", "footer", "aside", "noscript"):
            text = _re.sub(
                rf"<{tag}[\s>].*?</{tag}>",
                " ",
                text,
                flags=_re.IGNORECASE | _re.DOTALL,
            )

        # Convert block-level elements to newlines
        text = _re.sub(
            r"<(?:p|div|br|li|tr|h[1-6])[^>]*>",
            "\n",
            text,
            flags=_re.IGNORECASE,
        )

        # Strip remaining HTML tags
        text = _re.sub(r"<[^>]+>", "", text)

        # Decode HTML entities
        text = _html_mod.unescape(text)

        # Normalize whitespace: strip each line, then collapse blank-line runs
        lines = [line.strip() for line in text.splitlines()]
        result_lines: list[str] = []
        empty_run = 0
        for line in lines:
            if not line:
                empty_run += 1
                if empty_run <= 2:
                    result_lines.append("")
            else:
                empty_run = 0
                result_lines.append(line)

        stripped = "\n".join(result_lines).strip()
        stripped_bytes = stripped.encode("utf-8")
        stripped_len = len(stripped_bytes)

        # Only use stripped version when it's meaningfully smaller (≥20% reduction)
        if stripped_len >= original_len * 0.80:
            return body

        marker = f"[token-goat: HTML→text, {original_len}B→{stripped_len}B]\n"
        return (marker + stripped).encode("utf-8")

    except Exception:
        return body


def _apply_html_strip(cache_path: Path) -> None:
    """Read *cache_path*, strip HTML if applicable, and write the result back.

    No-op when the file does not exist, is unreadable, or ``_strip_html_to_text``
    determines the content is not HTML or the reduction is below the 20% threshold.
    Failures are logged at DEBUG and swallowed so a broken strip never blocks caching.
    """
    try:
        raw = cache_path.read_bytes()
        stripped = _strip_html_to_text(raw)
        if stripped is not raw and stripped != raw:
            cache_path.write_bytes(stripped)
            _LOG.debug(
                "webfetch: HTML stripped %d→%d bytes for %s",
                len(raw),
                len(stripped),
                cache_path.name,
            )
    except Exception as exc:
        _LOG.debug("webfetch: HTML strip failed for %s: %s", cache_path.name, exc)


def _resolve_and_validate_ip(hostname: str) -> str:
    """Resolve *hostname* to a single IP string, validated as non-private.

    Used by ``_make_pinned_transport`` to obtain the IP that will be used for
    the actual TCP connection, so DNS is only consulted once.  Returns the
    first address returned by ``getaddrinfo`` that passed SSRF validation.

    Raises ``ValueError`` if no safe address is found (all resolved to private
    ranges) or if the hostname is unresolvable (fail-closed).
    """
    try:
        addr_info = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise ValueError(f"SSRF IP-pin: cannot resolve {hostname!r}: {exc}") from exc

    for _family, _type, _proto, _canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
            continue
        return str(ip_str)  # first safe address wins

    raise ValueError(
        f"SSRF IP-pin: no safe address for {hostname!r} "
        "(all resolved addresses are private/loopback/link-local)"
    )


def _make_pinned_transport(pinned_ip: str) -> httpx.HTTPTransport:
    """Return an ``httpx.HTTPTransport`` that connects to *pinned_ip* directly.

    DNS rebinding attack: ``_is_ssrf_safe()`` calls ``getaddrinfo`` to validate
    the resolved IP.  When ``httpx`` later opens the TCP connection it calls
    ``getaddrinfo`` *again*.  A hostile DNS server can return a public IP on the
    first query and a private IP (e.g. 169.254.169.254 AWS IMDS) on the second.

    Fix: resolve once in ``_is_ssrf_safe`` (already done), then resolve again
    here and pin the result so ``httpx`` connects to a literal IP.  The
    ``Host:`` header retains the original hostname so TLS SNI and virtual
    hosting work correctly.  Because the IP was already validated by
    ``_is_ssrf_safe`` before this function is called, a second DNS query would
    be a TOCTOU window — we skip it and connect directly to the IP that already
    passed validation.

    Implementation: monkey-patch ``socket.getaddrinfo`` for the transport's
    resolver so any lookup for the target hostname returns the pre-validated IP.
    httpx's ``HTTPTransport`` uses ``httpcore`` which calls ``socket.getaddrinfo``
    internally; redirecting that call to our stub closes the rebinding window
    without requiring httpx internals knowledge.
    """
    import httpx

    original_getaddrinfo = socket.getaddrinfo

    def _pinned_getaddrinfo(
        host: str | bytes | None,
        port: str | int | None,
        family: int = 0,
        type: int = 0,
        proto: int = 0,
        flags: int = 0,
    ) -> list[tuple]:
        """Return the pre-validated IP for the pinned host; delegate all others."""
        host_str = host.decode() if isinstance(host, bytes) else (host or "")
        if host_str.lower().rstrip(".") == pinned_ip:
            # Already an IP literal — pass through unchanged.
            return original_getaddrinfo(host, port, family, type, proto, flags)
        # For any host lookup, substitute our pre-validated IP so DNS is not
        # consulted again.  This closes the TOCTOU window between _is_ssrf_safe
        # and the actual TCP connect.
        return original_getaddrinfo(pinned_ip, port, family, type, proto, flags)

    class _PinnedTransport(httpx.HTTPTransport):
        """HTTPTransport subclass that uses the pre-validated IP for DNS resolution."""

        def handle_request(self, request: httpx.Request) -> httpx.Response:
            """Send *request* with DNS resolution pinned to the pre-validated IP.

            Temporarily monkey-patches :func:`socket.getaddrinfo` to return
            the IP that was already verified by ``_is_ssrf_safe`` so a hostile
            DNS server cannot return a different address at TCP connect time
            (DNS rebinding protection).  The original ``getaddrinfo`` is
            always restored in the ``finally`` block — including on exceptions
            — so the monkey-patch is never leaked to other threads.
            """
            _prev = socket.getaddrinfo
            socket.getaddrinfo = _pinned_getaddrinfo  # type: ignore[assignment]  # monkey-patching socket.getaddrinfo to pin DNS resolution; typeshed expects exact overloaded signature
            try:
                return super().handle_request(request)
            finally:
                socket.getaddrinfo = _prev  # type: ignore[assignment]  # restoring original; same monkey-patch constraint

    return _PinnedTransport()


def fetch_url(
    url: str,
    *,
    shrink_if_image: bool = True,
    timeout_sec: float | None = None,
    max_size_bytes: int = 50 * 1024 * 1024,
) -> Path:
    """Download a URL. Return the local cached path. Shrink if image and big enough.

    Raises ValueError if the URL fails SSRF safety checks (private/loopback IPs,
    metadata endpoints, non-http/https schemes, unresolvable hostnames).

    Sends ETag / If-Modified-Since conditional requests when cache metadata is
    available; returns the cached file unchanged on HTTP 304 Not Modified.

    DNS rebinding protection: the hostname is resolved once (in ``_is_ssrf_safe``
    above) and the validated IP is pinned for the actual TCP connection so a
    hostile DNS server cannot return a different address at connect time.

    Args:
        timeout_sec: Request timeout in seconds.  Defaults to the value of
            ``TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS`` (float) or 30 s when the env var
            is absent.  Pass an explicit value to override the env var for a
            single call (useful in tests).
    """
    import httpx

    # Resolve effective timeout: explicit argument wins over env var.
    _timeout = timeout_sec if timeout_sec is not None else _webfetch_timeout()

    if len(url) > _MAX_URL_LEN:
        raise ValueError(f"URL too long ({len(url)} chars, max {_MAX_URL_LEN})")
    if not _is_ssrf_safe(url):
        raise ValueError(f"URL blocked by SSRF safety check: {_truncate_url(url)!r}")

    # DNS rebinding mitigation: resolve the hostname once here (already done by
    # _is_ssrf_safe above) and pin the validated IP for the actual TCP connect.
    # Without pinning, httpx calls getaddrinfo again at connect time, giving a
    # hostile DNS server a window to return a private IP on the second query.
    _hostname = urlparse(url).hostname or ""
    try:
        _pinned_ip = _resolve_and_validate_ip(_hostname)
        _transport = _make_pinned_transport(_pinned_ip)
        _LOG.debug("webfetch: pinned %r → %s", _hostname, _pinned_ip)
    except (ValueError, OSError) as _pin_exc:
        # Fail-closed: if we cannot pin the IP treat it as an SSRF risk.
        raise ValueError(
            f"URL blocked: could not pin IP for {_hostname!r}: {_pin_exc}"
        ) from _pin_exc

    image_shrink.ensure_cache_dir(paths.web_cache_dir())

    # Check if the file is already cached (using the URL-derived suffix as a best-effort guess).
    url_suffix = _suffix_for(url)
    cached_path = _cache_path_for(url, url_suffix)
    if cached_path.exists():
        meta = _read_cache_meta(cached_path)
        # Fast-path: a previously recorded shrunk artifact pointer lets us
        # skip both the conditional revalidation (no network) and the
        # shrink re-hash (no Pillow open) on every repeat hit of this URL.
        # The pointer is content-keyed by SHA256, so it stays valid only
        # while the shrunk file exists on disk; a vanished file falls
        # through to the slow path which re-hashes and re-shrinks.
        if shrink_if_image and (shrunk_pointer := meta.get("shrunk_path")):
            shrunk_path = _resolve_shrunk_path(shrunk_pointer)
            if shrunk_path is not None and shrunk_path.exists():
                _LOG.info("web cache hit (shrunk pointer): %s", shrunk_path.name)
                return shrunk_path
        # Only revalidate when we actually have HTTP cache validators to send;
        # ``shrunk_path``-only metadata isn't useful for an If-None-Match GET.
        has_validators = "etag" in meta or "last_modified" in meta
        if has_validators:
            # Attempt conditional revalidation to confirm the cached copy is still fresh.
            headers: dict[str, str] = {}
            if "etag" in meta:
                headers["If-None-Match"] = meta["etag"]
            if "last_modified" in meta:
                headers["If-Modified-Since"] = meta["last_modified"]
            try:
                with httpx.Client(
                    timeout=_timeout, follow_redirects=True, transport=_transport
                ) as client:
                    r = client.get(url, headers=headers)
                # Post-redirect SSRF check: the revalidation response may have
                # followed redirects to a private/metadata endpoint.  An open
                # redirect on a trusted origin could point back to 169.254.x or
                # ::1 on a conditional GET just as easily as on a fresh fetch.
                final_url = str(r.url)
                if final_url != url:
                    _LOG.info("web revalidation redirected: %s -> %s",
                              sanitize_log_str(url), sanitize_log_str(final_url))
                try:
                    _validate_response_url(final_url)
                except ValueError:
                    _LOG.warning(
                        "revalidation redirect blocked by SSRF guard (%s -> %s); "
                        "using cached file",
                        sanitize_log_str(url),
                        sanitize_log_str(final_url),
                    )
                    return cached_path
                if r.status_code == 304:
                    _LOG.info("web cache revalidated (304): %s", cached_path.name)
                    if shrink_if_image:
                        return image_shrink.shrink_if_image(cached_path)
                    return cached_path
                if r.status_code == 200:
                    # Server returned fresh content — fall through to the download path below.
                    _LOG.info("web cache stale (200 on revalidation): %s", cached_path.name)
                else:
                    # Unexpected status — serve the cached file to avoid breaking the caller.
                    _LOG.debug("revalidation returned %s; using cached %s", r.status_code, cached_path.name)
                    return cached_path
            except httpx.RequestError as exc:
                _LOG.debug("revalidation request failed (%s); using cached %s", exc, cached_path.name)
                return cached_path
        else:
            _LOG.info("web cache hit (URL-derived): %s", cached_path.name)
            if shrink_if_image:
                return image_shrink.shrink_if_image(cached_path)
            return cached_path

    # Download
    response_headers: httpx.Headers | None = None
    try:
        with httpx.Client(
            timeout=_timeout, follow_redirects=True, transport=_transport
        ) as client, \
                client.stream("GET", url) as r:
            r.raise_for_status()
            final_url = str(r.url)
            if final_url != url:
                _LOG.info("web fetch redirected: %s -> %s",
                          sanitize_log_str(url), sanitize_log_str(final_url))
            _validate_response_url(final_url)
            content_type = r.headers.get("content-type", "")
            suffix = _suffix_for(url, content_type)
            cache_path = _cache_path_for(url, suffix)
            _stream_to_file(r, cache_path, max_size_bytes)
            response_headers = r.headers
            # Strip HTML boilerplate in-place before any caching or dedup logic
            # so everything downstream (content hash, stored bytes, recalled output)
            # operates on the compact text form, not the raw markup.
            _apply_html_strip(cache_path)
    except (ValueError, RuntimeError):
        # ValueError: SSRF check failed after redirect (_validate_response_url)
        # RuntimeError: size cap exceeded (_stream_to_file)
        raise
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"HTTP {exc.response.status_code} fetching {_truncate_url(url)!r}: {exc.response.reason_phrase}"
        ) from exc
    except httpx.TimeoutException as exc:
        raise RuntimeError(
            f"Request timed out after {_timeout}s fetching {_truncate_url(url)!r}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Network error fetching {_truncate_url(url)!r}: {type(exc).__name__}: {exc}"
        ) from exc

    # Content-hash dedup: bytes are now on disk.  Hash them and consult the
    # cross-URL index.  Two different URLs serving the same image (e.g. the
    # same screenshot in a Slack thread *and* a GitHub PR comment) hash to
    # the same digest; if a previous fetch already produced a shrunk artifact
    # for these bytes, we can skip the shrink step entirely on this fetch and
    # return the cached shrunk path directly.
    content_sha = _hash_file_sha256(cache_path)
    extra_meta: dict[str, str] = {}
    if content_sha is not None:
        extra_meta["content_sha256"] = content_sha
        canonical = _read_content_index(content_sha)
        if canonical is not None and canonical != cache_path:
            # Consult the canonical URL's sidecar for a cached shrink pointer.
            # Most cache hits will have this from a previous shrink, avoiding
            # both the shrink overhead and a redundant sidecar read on *this*
            # URL's entry later when we try to write it.
            canonical_meta = _read_cache_meta(canonical)
            shrunk_pointer = canonical_meta.get("shrunk_path")
            if shrunk_pointer:
                shrunk_path = _resolve_shrunk_path(shrunk_pointer)
                if shrunk_path is not None and shrunk_path.exists() and shrink_if_image:
                    _LOG.info(
                        "web content dedup hit: %s shares bytes with %s (shrunk: %s)",
                        cache_path.name, canonical.name, shrunk_path.name,
                    )
                    # Mirror the dedup pointer onto the new URL's sidecar so a
                    # second hit on *this* URL also short-circuits without
                    # re-reading the canonical sidecar.
                    extra_meta["shrunk_path"] = str(shrunk_path)
                    if response_headers is not None:
                        _write_cache_meta(cache_path, response_headers, extra=extra_meta)
                    return shrunk_path
                # Shrunk path missing but canonical exists; will re-shrink below.

    # Shrink if image
    if shrink_if_image:
        shrunk = image_shrink.shrink_if_image(cache_path)
        # Record the dedup pointers so subsequent fetches of any URL serving
        # these bytes can return ``shrunk`` directly without re-hashing the
        # cached file or re-invoking the shrink pipeline.  Only record when
        # the shrink produced a different path (i.e. the image was actually
        # large enough to shrink) — for small images the original path is
        # already optimal and writing a self-pointer is wasted I/O.
        if content_sha is not None and shrunk != cache_path:
            extra_meta["shrunk_path"] = str(shrunk)
        # Write all metadata (headers + dedup pointers) in one operation,
        # reducing I/O overhead. If shrink didn't produce a different path,
        # this still records the content_sha and http headers for revalidation.
        if response_headers is not None or extra_meta:
            _write_cache_meta(cache_path, response_headers if response_headers is not None else httpx.Headers(), extra=extra_meta)
        if content_sha is not None:
            _write_content_index(content_sha, cache_path)
        return shrunk

    # No shrink requested; still record metadata for cache revalidation.
    if response_headers is not None or extra_meta:
        _write_cache_meta(cache_path, response_headers if response_headers is not None else httpx.Headers(), extra=extra_meta)
    if content_sha is not None:
        _write_content_index(content_sha, cache_path)
    return cache_path
