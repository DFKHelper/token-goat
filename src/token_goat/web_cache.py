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

import logging
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    build_output_id,
    evict_cache_dir,
    list_cache_outputs,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    safe_join_output_id,
    short_content_hash,
    truncate_tail_preserve,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str

_LOG = logging.getLogger("token_goat.web_cache")

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


@dataclass
class WebOutputMeta:
    """Metadata associated with a cached WebFetch response entry.

    Mirrors :class:`bash_cache.BashOutputMeta` so the operational surface of
    the two caches stays uniform.  ``url_preview`` carries the first 200
    characters of the URL (sanitised) — long enough to be human-readable in
    ``token-goat web-history`` output but capped to keep the manifest budget
    predictable.  ``status_code`` is optional because not every harness
    surfaces it; absence means "unknown" rather than "succeeded" or "failed".
    """

    output_id: str
    url_sha: str
    url_preview: str
    body_bytes: int
    status_code: int | None
    ts: float
    truncated: bool


def _web_outputs_dir() -> Path:
    """Return ``data_dir() / "web_outputs"`` and create it on first use."""
    d = paths.data_dir() / "web_outputs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def url_hash(url: str) -> str:
    """Return a short content hash for *url* (first 16 hex chars of SHA-256).

    Thin wrapper around :func:`cache_common.short_content_hash`.  We hash the
    raw URL bytes rather than a normalised form because two URLs that differ
    only in trailing-slash or query-parameter order legitimately return
    different content and should not collide in the cache.
    """
    return short_content_hash(url)


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
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> WebOutputMeta | None:
    """Write *body* to the cache and return descriptive metadata.

    Returns ``None`` on any I/O error so the calling hook can degrade
    silently.  Bodies larger than :data:`_MAX_STORED_BYTES` are
    tail-preserved (head truncated) because page footers, JSON response
    bodies, and error stack traces all tend to sit at the bottom of the
    fetched content.  After the write the function opportunistically evicts
    the oldest files until the total store size is back under
    ``max_total_bytes``; the eviction is best-effort and a failed pass simply
    leaves the directory slightly over budget — the next call will try
    again.
    """
    try:
        out_id = output_id_for(session_id, url)
        path = safe_join_output_id(out_id, _web_outputs_dir, "web_cache")
        if path is None:
            return None

        body_bytes = len(body.encode("utf-8", errors="replace"))
        stored, truncated = truncate_tail_preserve(
            body, _MAX_STORED_BYTES, marker_template=_TRUNC_MARKER,
        )

        paths.atomic_write_text(path, stored)

        meta = WebOutputMeta(
            output_id=out_id,
            url_sha=url_hash(url),
            url_preview=sanitize_log_str(url, max_len=200),
            body_bytes=body_bytes,
            status_code=status_code,
            ts=time.time(),
            truncated=truncated,
        )

        evict_old_entries(max_total_bytes=max_total_bytes)

        _LOG.debug(
            "web_cache: stored id=%s bytes=%d truncated=%s",
            out_id, body_bytes, truncated,
        )
        return meta
    except OSError as exc:
        _LOG.warning("web_cache: store failed: %s", exc)
        return None


def load_output(output_id: str) -> str | None:
    """Return the cached response body for *output_id*, or ``None`` if absent."""
    return load_output_text(output_id, _web_outputs_dir, "web_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None."""
    return load_output_meta_stat(output_id, _web_outputs_dir, "web_cache")


def evict_old_entries(*, max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*.

    Removes body + sidecar pairs together, then runs an orphan-sidecar sweep
    at the end.  Same shape as :func:`bash_cache.evict_old_entries`.

    The shared algorithm lives in :func:`cache_common.evict_cache_dir`; this
    wrapper supplies the web-specific directory, log name, and default cap.
    """
    return evict_cache_dir(
        cache_dir_fn=_web_outputs_dir,
        log_name="web_cache",
        max_total_bytes=max_total_bytes,
    )


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for every cached output, newest first."""
    return list_cache_outputs(_web_outputs_dir)


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID."""
    base = safe_join_output_id(output_id, _web_outputs_dir, "web_cache")
    if base is None:
        return None
    return base.with_suffix(".json")


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
