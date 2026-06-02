"""Persistent store for cached WebFetch responses.

Every PostToolUse(WebFetch) hook invocation persists the response body to a
short text file under ``data_dir() / "web_outputs"`` keyed by a content-derived
ID built from the URL.  Subsequent invocations of the same URL in the same
session can detect the duplicate via :func:`session.lookup_web_entry`, and
agents can retrieve sliced views of any cached response via the
``token-goat web-output`` CLI.

The disk-store, eviction, and sidecar machinery deliberately mirrors
:mod:`bash_cache` so the two surfaces share an operational model.  Each cache
entry is a pair of files: ``<id>.txt`` for the body and ``<id>.json`` for
metadata; orphan ``.json`` files left by a partial deletion are swept the next
time eviction runs.

Why a separate store from images
--------------------------------
``webfetch.fetch_url`` already maintains an image-shaped on-disk cache for
binary downloads (PNG/JPEG/WebP).  That cache is keyed on URL with extras for
content-type sniffing and lives at ``data_dir() / "web_cache"``.  This module
serves the *text* response path — HTML, JSON, plain text — that the existing
image cache deliberately does not handle.  Mixing the two would conflate
"shrink this PNG before the model sees it" (image cache) with "the agent just
asked for this page; cache the body so a repeat ask in the same session is
free" (this cache), and each one wants different keying, eviction caps, and
retrieval shapes.

Fail-soft contract
------------------
Every public function on this module returns sensibly on I/O error and logs
to the standard token-goat logger.  A failed store yields ``None``; a failed
load yields ``None``.  The hook layer must never propagate a cache failure
into the agent's tool path — the worst case is "cache miss, body fetched
again", which is the pre-cache baseline.
"""
from __future__ import annotations

__all__ = [
    "DEFAULT_MAX_TOTAL_BYTES",
    "OUTPUT_FILENAME_RE",
    "WebOutputMeta",
    "evict_old_entries",
    "find_cached_for_url",
    "get_output_size",
    "list_outputs",
    "load_output",
    "load_output_meta",
    "output_id_for",
    "read_sidecar",
    "sidecar_meta_path",
    "store_output",
    "url_hash",
    "write_sidecar",
]

import contextlib
import gzip
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from .cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    build_output_id,
    evict_cache_dir,
    get_cache_dir,
    list_cache_outputs,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    path_mtime_key,
    safe_cache_op,
    safe_join_output_id,
    short_content_hash,
    sidecar_path_for,
    store_blob,
    truncate_tail_preserve,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str
from .util import get_logger, strip_ansi

_LOG = get_logger("web_cache")

# Total byte budget for the on-disk web-output store.  Web pages tend to be
# larger than Bash logs (HTML + assets list, JSON dumps with embedded data)
# but the count of distinct URLs per session is typically smaller, so 32 MB
# is enough headroom while still being invisible on any modern disk.
DEFAULT_MAX_TOTAL_BYTES: int = 32 * 1024 * 1024

# OUTPUT_FILENAME_RE is imported from cache_common — shared with bash_cache.

# Sentinel placed at the head of every truncated body, mirroring bash_cache.
_TRUNC_MARKER = "[token-goat: web output truncated; stored {n} of {total} bytes]\n"

# Maximum bytes stored per response body.  HTML pages can easily exceed this
# (a single Reddit thread is often 3-5 MB of HTML); the truncation keeps any
# one entry bounded while the eviction loop bounds the whole directory.  We
# keep the *tail* of the body because most useful web content (article text,
# JSON response payloads, error bodies) sits at the bottom while the head is
# typically navigation chrome that the agent rarely needs.
_MAX_STORED_BYTES: int = 2 * 1024 * 1024

# File extension appended to gzip-compressed web output files.  The cache
# reader checks for the ``.gz`` variant first so decompression is transparent.
_GZ_SUFFIX: str = ".gz"

# gzip compression level (1-9).  Level 6 balances speed and ratio well for
# HTML/JSON text (typical 70-85% reduction on large doc pages).
_GZ_LEVEL: int = 6


@dataclass
class WebOutputMeta:
    """Metadata associated with a cached WebFetch response entry.

    Mirrors :class:`bash_cache.BashOutputMeta` so the operational surface of
    the two caches stays uniform.  ``url_preview`` carries the first 200
    characters of the URL (sanitised) — long enough to be human-readable in
    ``token-goat web-history`` output but capped to keep the manifest budget
    predictable.  ``status_code`` is optional because not every harness
    surfaces it; absence means "unknown" rather than "succeeded" or "failed".
    ``content_type`` is the MIME type from the response (e.g. "text/html" or
    "application/json"), or None if not captured.
    """

    output_id: str
    url_sha: str
    url_preview: str
    body_bytes: int
    status_code: int | None
    ts: float
    truncated: bool
    content_type: str | None = None


def _web_outputs_dir() -> Path:
    """Return ``data_dir() / "web_outputs"`` and create it on first use."""
    return get_cache_dir("web_outputs")


def _store_blob_gz(output_id: str, text: str) -> Path | None:
    """Write *text* gzip-compressed to the web_outputs cache directory.

    Writes the compressed body as ``output_id.gz`` AND an empty ``output_id.txt``
    stub file.  The stub ensures the entry is discoverable by :func:`list_outputs`
    and subject to the normal LRU eviction machinery (which scans for ``.txt``
    files).  :func:`load_output` checks for the ``.gz`` sibling first so callers
    transparently receive the decompressed text.

    Returns the ``.gz`` path on success, or ``None`` on I/O error.
    """
    from . import paths as _paths  # noqa: PLC0415

    with safe_cache_op("_store_blob_gz", log=_LOG):
        out_dir = _web_outputs_dir()
        gz_path = out_dir / (output_id + _GZ_SUFFIX)
        try:
            raw_bytes = text.encode("utf-8", errors="replace")
            compressed = gzip.compress(raw_bytes, compresslevel=_GZ_LEVEL)
            _paths.atomic_write_bytes(gz_path, compressed)
            _LOG.debug(
                "_store_blob_gz: wrote %s (%d bytes raw -> %d compressed)",
                gz_path.name, len(raw_bytes), len(compressed),
            )
        except OSError as exc:
            _LOG.debug("_store_blob_gz: failed to write %s: %s", output_id, exc)
            return None

        # Write an empty .txt stub so list_outputs() / evict_old_entries() can
        # discover and manage this entry through the standard cache machinery.
        stub_result = store_blob(output_id, "", _web_outputs_dir, "web_cache")
        if stub_result is None:
            _LOG.debug("_store_blob_gz: stub write failed for %s", output_id)
            # Clean up the gz file so we don't leave an orphaned compressed file.
            with contextlib.suppress(OSError):
                gz_path.unlink()
            return None

        return gz_path
    return None  # safe_cache_op suppressed an exception


def _load_blob_gz(output_id: str) -> str | None:
    """Return the decompressed text for a gzip-compressed web output, or ``None``.

    Checks for ``output_id.gz`` in the web_outputs directory.  Returns ``None``
    when no ``.gz`` file exists so :func:`load_output` can fall back to plain text.
    """
    out_dir = _web_outputs_dir()
    gz_path = out_dir / (output_id + _GZ_SUFFIX)
    if not gz_path.is_file():
        return None
    try:
        with gzip.open(gz_path, "rb") as fh:
            return fh.read().decode("utf-8", errors="replace")
    except (OSError, gzip.BadGzipFile) as exc:
        _LOG.debug("_load_blob_gz: failed to decompress %s: %s", gz_path.name, exc)
        return None


_DEFAULT_PORTS: dict[str, int] = {"http": 80, "https": 443}


def _normalize_url(url: str) -> str:
    """Return a canonical form of *url* for use as a cache key.

    Three normalizations are applied:

    1. **Scheme lowercased** — ``HTTP://`` and ``http://`` are the same; the
       scheme component is case-insensitive per RFC 3986 §3.1.
    2. **Fragment stripped** — the fragment identifier (``#section``) is
       evaluated entirely by the browser and is never sent to the server.
       Two URLs differing only in fragment fetch identical bytes and must
       share a cache entry.
    3. **Default port removed** — ``https://example.com:443/`` is
       indistinguishable from ``https://example.com/`` at the wire level.
       Keeping the redundant port would create separate cache keys for the
       same resource.

    Query strings, paths, and trailing slashes are left unchanged because
    they legitimately affect which resource the server returns.

    Returns *url* unchanged if ``urlparse`` raises (malformed URL).
    """
    try:
        p = urlparse(url)
    except ValueError:
        return url

    scheme = p.scheme.lower()
    netloc = p.netloc

    # Strip default port from netloc.  netloc is "host" or "host:port" or
    # "[ipv6]:port".  We only strip when the port matches the scheme default.
    if ":" in netloc.lstrip("["):
        # Extract host and port components safely via parsed attributes.
        host = p.hostname or ""
        port = p.port
        if port is not None and _DEFAULT_PORTS.get(scheme) == port:
            # Reassemble without the port.  For IPv6 the hostname includes the
            # brackets (e.g. "[::1]"); we need to preserve them.
            netloc = f"[{host}]" if ":" in host else host
            if p.username:
                userinfo = p.username + (f":{p.password}" if p.password else "")
                netloc = f"{userinfo}@{netloc}"

    normalized = urlunparse((scheme, netloc, p.path, p.params, p.query, ""))
    return normalized


def url_hash(url: str) -> str:
    """Return a short content hash for *url* (first 16 hex chars of SHA-256).

    Hashes the *normalized* URL so that variations that fetch identical
    content — differing only in fragment, scheme case, or redundant default
    port — map to the same cache entry.  Trailing-slash and query-parameter
    differences are preserved because those can legitimately affect what the
    server returns.
    """
    return short_content_hash(_normalize_url(url))


def output_id_for(session_id: str, url: str, ts: float | None = None) -> str:
    """Build a filesystem-safe ID for the ``(session, url, time)`` tuple.

    Delegates to :func:`cache_common.build_output_id` with the URL hash as the
    content token.  The millisecond timestamp ensures two fetches of the same
    URL in the same session do not collide.
    """
    return build_output_id(session_id, url_hash(url), ts)


def store_output(
    session_id: str,
    url: str,
    body: str,
    status_code: int | None,
    *,
    content_type: str | None = None,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = 4096,
    compress_bodies: bool = True,
    compress_min_bytes: int = 16 * 1024,
) -> WebOutputMeta | None:
    """Write *body* to the cache and return descriptive metadata.

    Returns ``None`` on any I/O error so the calling hook can degrade
    silently.  Bodies larger than :data:`_MAX_STORED_BYTES` are
    tail-preserved (head truncated) because page footers, JSON response
    bodies, and error stack traces all tend to sit at the bottom of the
    fetched content.  ANSI escape sequences are stripped before storage
    to save space and improve readability.  After the write the function
    opportunistically evicts the oldest files until the total store size
    is back under ``max_total_bytes`` AND the file count is at or under
    ``max_file_count``; the eviction is best-effort and a failed pass simply
    leaves the directory slightly over budget — the next call will try again.

    When ``compress_bodies`` is ``True`` (the default) and the stored body
    exceeds ``compress_min_bytes``, the body is written gzip-compressed as
    ``output_id.gz`` alongside an empty ``output_id.txt`` stub (so the
    eviction machinery can still discover the entry by scanning ``.txt``
    files).  :func:`load_output` transparently decompresses ``.gz`` bodies.
    """
    meta: WebOutputMeta | None = None
    with safe_cache_op("store_output", log=_LOG):
        out_id = output_id_for(session_id, url)

        # Strip ANSI sequences before storing to save space and improve readability.
        cleaned_body = strip_ansi(body)
        body_bytes = len(body.encode("utf-8", errors="replace"))
        stored, truncated = truncate_tail_preserve(
            cleaned_body, _MAX_STORED_BYTES, marker_template=_TRUNC_MARKER,
        )

        # Determine whether to compress this body.
        stored_bytes_len = len(stored.encode("utf-8", errors="replace"))
        compress = compress_bodies and stored_bytes_len >= compress_min_bytes

        if compress:
            write_ok = _store_blob_gz(out_id, stored) is not None
        else:
            write_ok = store_blob(out_id, stored, _web_outputs_dir, "web_cache") is not None

        if not write_ok:
            return None

        meta = WebOutputMeta(
            output_id=out_id,
            url_sha=url_hash(url),
            url_preview=sanitize_log_str(url, max_len=200),
            body_bytes=body_bytes,
            status_code=status_code,
            ts=time.time(),
            truncated=truncated,
            content_type=content_type,
        )

        _LOG.debug(
            "web_cache: stored id=%s bytes=%d truncated=%s compressed=%s",
            out_id, body_bytes, truncated, compress,
        )
    # Best-effort eviction runs outside safe_cache_op so an OSError during the
    # directory walk never discards a confirmed write (the file is already on disk).
    if meta is not None:
        try:
            evict_old_entries(max_total_bytes=max_total_bytes, max_file_count=max_file_count)
        except OSError as _exc:
            _LOG.warning("web_cache: eviction failed (best-effort): %s", _exc)
    return meta


def load_output(output_id: str) -> str | None:
    """Return the cached response body for *output_id*, or ``None`` if absent.

    Transparently decompresses gzip-stored bodies: checks for ``output_id.gz``
    first and falls back to plain-text ``output_id.txt`` for entries written
    before compression was introduced (or when compression was disabled).
    """
    # Check for compressed variant first.
    gz_result = _load_blob_gz(output_id)
    if gz_result is not None:
        return gz_result
    return load_output_text(output_id, _web_outputs_dir, "web_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None."""
    return load_output_meta_stat(output_id, _web_outputs_dir, "web_cache")


def get_output_size(output_id: str) -> int | None:
    """Return the byte size of the cached output, or None if not found.

    Reads the size from the sidecar metadata when available, falling back
    to the on-disk file size as a last resort.  Returns None on any I/O error.
    """
    with safe_cache_op("get_output_size", log=_LOG):
        # Try sidecar first — it has the original body_bytes before truncation.
        meta = read_sidecar(output_id)
        if meta is not None:
            return meta.body_bytes
        # Fallback to stat-derived metadata (file size on disk).
        stat_meta = load_output_meta_stat(output_id, _web_outputs_dir, "web_cache")
        if stat_meta is not None:
            return stat_meta.get("size_bytes")
    return None


def evict_old_entries(
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = 4096,
) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*.

    Removes body + sidecar pairs together, then runs an orphan-sidecar sweep
    at the end.  Same shape as :func:`bash_cache.evict_old_entries`.

    The shared algorithm lives in :func:`cache_common.evict_cache_dir`; this
    wrapper supplies the web-specific directory, log name, and default caps.

    Parameters
    ----------
    max_total_bytes:
        Byte budget for the cache directory (default 32 MB).
    max_file_count:
        Maximum number of cached response body files (default 4096).
    """
    return evict_cache_dir(
        cache_dir_fn=_web_outputs_dir,
        log_name="web_cache",
        max_total_bytes=max_total_bytes,
        max_file_count=max_file_count,
    )


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for every cached output, newest first."""
    return list_cache_outputs(_web_outputs_dir)


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID."""
    base = safe_join_output_id(output_id, _web_outputs_dir, "web_cache")
    if base is None:
        return None
    return sidecar_path_for(base)


def write_sidecar(meta: WebOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    write_sidecar_metadata(
        sidecar_meta_path(meta.output_id),
        meta,
        log=_LOG,
        log_prefix="web_cache",
    )


def read_sidecar(output_id: str) -> WebOutputMeta | None:
    """Return parsed :class:`WebOutputMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added later.
    """
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        return WebOutputMeta(
            output_id=str(data.get("output_id", output_id)),
            url_sha=str(data.get("url_sha", "")),
            url_preview=str(data.get("url_preview", "")),
            body_bytes=int(data.get("body_bytes", 0)),
            status_code=(
                int(data["status_code"])
                if isinstance(data.get("status_code"), (int, float))
                else None
            ),
            ts=float(data.get("ts", 0.0)),
            truncated=bool(data.get("truncated", False)),
        )
    except (TypeError, ValueError):
        return None


def find_cached_for_url(url: str) -> WebOutputMeta | None:
    """Return the most recent on-disk cached entry for *url*, or None.

    Scans all sidecar files in the web_outputs store and returns the entry
    whose ``url_sha`` matches the hash of *url*, favouring the most recently
    written file.  Used by the pre-WebFetch hook to emit a cross-session
    cache-hit hint when the same URL was fetched in a prior session and the
    body is still on disk but has not been recorded in the current session.

    This is intentionally a linear scan over sidecar metadata — not body text
    — so the I/O cost is proportional to the number of cached entries (not
    their sizes).  In the typical usage pattern (≤ a few hundred cached URLs)
    the scan completes in milliseconds.

    Returns ``None`` on any I/O error (fail-soft contract).
    """
    target_sha = url_hash(url)
    best: WebOutputMeta | None = None
    with safe_cache_op("find_cached_for_url", log=_LOG):
        cache_dir = _web_outputs_dir()
        if not cache_dir.is_dir():
            return None
        for sidecar_path in sorted(
            cache_dir.glob("*.json"), key=path_mtime_key, reverse=True
        ):
            # Extract output_id from sidecar filename (strip .json)
            candidate_id = sidecar_path.stem
            meta = read_sidecar(candidate_id)
            if meta is None:
                continue
            if meta.url_sha == target_sha and meta.body_bytes > 0:
                # Guard: verify the body file actually exists.  A sidecar without
                # its body is an orphan left by a partial write or an interrupted
                # eviction.  Treat it as a cache miss and clean up the sidecar so
                # it doesn't accumulate indefinitely.
                body_path = sidecar_path.with_suffix(".txt")
                if not body_path.exists():
                    _LOG.debug(
                        "web_cache: orphan sidecar (no body) for id=%s; removing",
                        candidate_id,
                    )
                    try:
                        sidecar_path.unlink()
                    except OSError as _exc:
                        _LOG.debug(
                            "web_cache: failed to remove orphan sidecar %s: %s",
                            sidecar_path.name, _exc,
                        )
                    continue
                best = meta
                break  # sorted newest-first; first match is the freshest
    return best
