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

import hashlib
import json
import logging
import os
import re
import stat as _stat_module
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TypedDict

from . import paths
from .hooks_common import sanitize_log_str

_LOG = logging.getLogger("token_goat.web_cache")

# Total byte budget for the on-disk web-output store.  Web pages tend to be
# larger than Bash logs (HTML + assets list, JSON dumps with embedded data)
# but the count of distinct URLs per session is typically smaller, so 32 MB
# is enough headroom while still being invisible on any modern disk.
DEFAULT_MAX_TOTAL_BYTES: int = 32 * 1024 * 1024

# Same filename pattern as bash_cache so a future shared eviction helper can
# operate on either directory.
OUTPUT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$")

# Sentinel placed at the head of every truncated body, mirroring bash_cache.
_TRUNC_MARKER = "[token-goat: web output truncated to {n} bytes; full size was {total} bytes]\n"

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


class _OutputStatDict(TypedDict, total=False):
    """Stat-derived metadata returned by :func:`load_output_meta`.

    Keys match the return shape: output_id (always present), size_bytes, mtime.
    """

    output_id: str
    size_bytes: int
    mtime: float


def _web_outputs_dir() -> Path:
    """Return ``data_dir() / "web_outputs"`` and create it on first use."""
    d = paths.data_dir() / "web_outputs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def url_hash(url: str) -> str:
    """Return a short content hash for *url* (first 16 hex chars of SHA-256).

    SHA-256 here is overkill for collision resistance (we only need to
    distinguish at most a few hundred URLs per session) but it is stdlib,
    fast, and matches the bash_cache convention.  We hash the raw URL
    bytes rather than a normalised form because two URLs that differ only
    in trailing-slash or query-parameter order legitimately return
    different content and should not collide in the cache.
    """
    return hashlib.sha256(url.encode("utf-8", errors="replace")).hexdigest()[:16]


def output_id_for(session_id: str, url: str, ts: float | None = None) -> str:
    """Build a filesystem-safe ID for the ``(session, url, time)`` tuple.

    The ID embeds a short session prefix and a millisecond timestamp so two
    fetches of the same URL in the same session do not collide; both are kept
    and the most recent wins on dedup lookups, but each cached response
    remains addressable for forensic retrieval (e.g. when an agent wants to
    compare an earlier response to a later one).
    """
    safe_session = re.sub(r"[^a-zA-Z0-9_\-]", "_", session_id)[:16] or "anon"
    ms = int((ts if ts is not None else time.time()) * 1000)
    return f"{safe_session}-{ms:013d}-{url_hash(url)}"


def _safe_join(output_id: str) -> Path | None:
    """Validate *output_id* and return the corresponding cache file path.

    Returns ``None`` (with a warning log) when the ID is malformed.  The
    on-disk store sits next to other token-goat data; an attacker-influenced
    ID must not be able to walk out of it even if the surrounding hook
    machinery somehow forwards a crafted value.
    """
    if not output_id:
        return None
    name = f"{output_id}.txt"
    if not OUTPUT_FILENAME_RE.match(name):
        _LOG.warning("web_cache: rejected output_id with invalid chars: %r", sanitize_log_str(output_id))
        return None
    base = _web_outputs_dir().resolve()
    candidate = (base / name).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        _LOG.warning("web_cache: rejected output_id escaping base dir: %r", sanitize_log_str(output_id))
        return None
    return candidate


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
        path = _safe_join(out_id)
        if path is None:
            return None

        body_bytes = len(body.encode("utf-8", errors="replace"))
        truncated = False
        if body_bytes > _MAX_STORED_BYTES:
            keep = body[-_MAX_STORED_BYTES:]
            stored = _TRUNC_MARKER.format(n=_MAX_STORED_BYTES, total=body_bytes) + keep
            truncated = True
        else:
            stored = body

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
    path = _safe_join(output_id)
    if path is None or not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _LOG.warning("web_cache: load failed for %s: %s", sanitize_log_str(output_id), exc)
        return None


def load_output_meta(output_id: str) -> _OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None."""
    path = _safe_join(output_id)
    if path is None or not path.exists():
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return _OutputStatDict(
        output_id=output_id,
        size_bytes=int(st.st_size),
        mtime=float(st.st_mtime),
    )


def evict_old_entries(*, max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*.

    Removes body + sidecar pairs together, then runs an orphan-sidecar sweep
    at the end.  Same shape as :func:`bash_cache.evict_old_entries`.
    """
    try:
        d = _web_outputs_dir()
    except OSError:
        return 0

    entries: list[tuple[Path, float, int]] = []
    total = 0
    try:
        for fp in d.iterdir():
            if not fp.name.endswith(".txt"):
                continue
            if not OUTPUT_FILENAME_RE.match(fp.name):
                continue
            try:
                st = os.lstat(fp)
            except OSError:
                continue
            if _stat_module.S_ISLNK(st.st_mode):
                _LOG.warning("web_cache: skipping symlink in cache dir: %s", fp.name)
                continue
            entries.append((fp, float(st.st_mtime), int(st.st_size)))
            total += int(st.st_size)
    except OSError:
        return 0

    if total <= max_total_bytes:
        return 0

    entries.sort(key=lambda t: t[1])  # oldest first
    removed = 0
    for fp, _mtime, size in entries:
        if total <= max_total_bytes:
            break
        try:
            fp.unlink()
            total -= size
            removed += 1
        except OSError:
            continue
        sidecar = fp.with_suffix(".json")
        try:
            sidecar.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            _LOG.debug("web_cache: sidecar cleanup failed for %s: %s", sidecar.name, exc)
    if removed:
        _LOG.info(
            "web_cache: evicted %d entries to fit cap=%d bytes",
            removed, max_total_bytes,
        )

    # Orphan-sidecar sweep — same rationale as bash_cache: a sidecar whose
    # body was deleted out-of-band must not linger forever.
    try:
        for sp in d.iterdir():
            if not sp.name.endswith(".json"):
                continue
            body = sp.with_suffix(".txt")
            if body.exists():
                continue
            try:
                sp.unlink()
            except OSError as exc:
                _LOG.debug("web_cache: orphan sidecar removal failed: %s: %s", sp.name, exc)
    except OSError:
        pass

    return removed


def list_outputs() -> list[_OutputStatDict]:
    """Return metadata for every cached output, newest first."""
    try:
        d = _web_outputs_dir()
    except OSError:
        return []

    results: list[_OutputStatDict] = []
    try:
        for fp in d.iterdir():
            if not fp.name.endswith(".txt"):
                continue
            if not OUTPUT_FILENAME_RE.match(fp.name):
                continue
            try:
                st = fp.stat()
            except OSError:
                continue
            results.append(_OutputStatDict(
                output_id=fp.stem,
                size_bytes=int(st.st_size),
                mtime=float(st.st_mtime),
            ))
    except OSError:
        return results

    def _mtime_key(r: _OutputStatDict) -> float:
        return r["mtime"]

    results.sort(key=_mtime_key, reverse=True)
    return results


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID."""
    base = _safe_join(output_id)
    if base is None:
        return None
    return base.with_suffix(".json")


def write_sidecar(meta: WebOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    p = sidecar_meta_path(meta.output_id)
    if p is None:
        return
    try:
        paths.atomic_write_text(p, json.dumps(asdict(meta), ensure_ascii=False))
    except OSError as exc:
        _LOG.debug("web_cache: sidecar write failed for %s: %s", meta.output_id, exc)


def read_sidecar(output_id: str) -> WebOutputMeta | None:
    """Return parsed :class:`WebOutputMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added later.
    """
    p = sidecar_meta_path(output_id)
    if p is None or not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
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
