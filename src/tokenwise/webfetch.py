"""WebFetch image downloader: HTTP fetch + shrink + cache."""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import image_shrink, paths

_LOG = logging.getLogger("tokenwise.webfetch")

# Common image extensions to detect from URL
IMAGE_URL_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif")


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


def fetch_url(
    url: str,
    *,
    shrink_if_image: bool = True,
    timeout_sec: float = 30.0,
    max_size_bytes: int = 50 * 1024 * 1024,
) -> Path:
    """Download a URL. Return the local cached path. Shrink if image and big enough."""
    cache_dir = paths.web_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    # Pre-check: do we already have it cached?
    # Need to know suffix first — peek using URL
    pre_suffix = _suffix_for(url)
    candidate = _cache_path_for(url, pre_suffix)
    if candidate.exists():
        _LOG.info("web cache hit (URL-derived): %s", candidate.name)
        # If image, ensure shrunken version
        if shrink_if_image and image_shrink.is_image_path(str(candidate)):
            shrunken = image_shrink.shrink(candidate)
            if shrunken is not None:
                return shrunken
        return candidate

    # Download
    with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client, \
            client.stream("GET", url) as r:
        r.raise_for_status()
        content_type = r.headers.get("content-type", "")
        content_length = int(r.headers.get("content-length", "0"))
        if content_length > max_size_bytes:
            raise RuntimeError(f"file too large: {content_length} bytes > {max_size_bytes}")
        # Final suffix (may differ from pre_suffix when URL has no extension)
        suffix = _suffix_for(url, content_type)
        cache_path = _cache_path_for(url, suffix)
        # Download to a tmp file then atomically rename
        tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
        written = 0
        _oversize_error: RuntimeError | None = None
        try:
            with tmp.open("wb") as f:
                for chunk in r.iter_bytes():
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
            tmp.replace(cache_path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    # Shrink if image
    if shrink_if_image and image_shrink.is_image_path(str(cache_path)):
        shrunken = image_shrink.shrink(cache_path)
        if shrunken is not None:
            return shrunken

    return cache_path
