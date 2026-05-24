"""Persistent store for cached Bash tool output.

Every PostToolUse(Bash) hook invocation records the command's stdout/stderr to a
short text file under ``data_dir() / "bash_outputs"`` keyed by a content-derived
ID.  Subsequent invocations of the same command in the same session can detect
the duplicate via :func:`session.lookup_bash_entry`, and agents can retrieve
sliced views of any cached output via the ``token-goat bash-output`` CLI.

Why a separate disk store (vs. session JSON):

* Bash output can be megabytes (build logs, test runs).  Inlining that into the
  session JSON would bloat every subsequent load/save round trip on the hot
  pre-read path.  Storing the bytes once on disk and only a short ID in the
  session keeps the session JSON cheap.

* The CLI retrieval path (``token-goat bash-output``) can stream the file
  directly without re-parsing JSON.

* Retention is simple to bound by total bytes: scan the directory, evict the
  oldest files until the cap is met.  No cross-session coordination is needed.

The store is intentionally fail-soft: any I/O error on write is logged and
swallowed so a hook never aborts because the cache is full or read-only.
"""
from __future__ import annotations

__all__ = [
    "DEFAULT_MAX_TOTAL_BYTES",
    "OUTPUT_FILENAME_RE",
    "BashOutputMeta",
    "command_hash",
    "evict_old_entries",
    "glob_hash",
    "load_output",
    "load_output_meta",
    "output_id_for",
    "read_sidecar",
    "sidecar_meta_path",
    "store_glob_result",
    "load_glob_result",
    "store_output",
    "write_sidecar",
]

import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
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
    safe_join_output_id,
    short_content_hash,
    sidecar_path_for,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str
from .util import get_logger

_LOG = get_logger("bash_cache")

# Total byte budget for the on-disk bash output store.  When exceeded, the
# oldest entries (by mtime) are evicted until the cap is met.  16 MB is small
# enough to be invisible on any modern disk while big enough to hold several
# full build/test logs (~1-3 MB each is typical).
DEFAULT_MAX_TOTAL_BYTES: int = 16 * 1024 * 1024

# OUTPUT_FILENAME_RE is imported from cache_common — shared with web_cache.

# Sentinel placed at the head of every output file marking the truncation
# boundary, so a reader can immediately see when the stored bytes are partial.
_TRUNC_MARKER = "[token-goat: bash output truncated; stored {n} of {total} bytes]\n"

# Maximum bytes stored per output file.  Larger captures are truncated head-only
# (tail is preserved because the failing portion of a test log is usually at the
# end).  2 MB matches read_replacement._MAX_READ_BYTES so the surgical retrieval
# commands can return the entire stored file when asked.
_MAX_STORED_BYTES: int = 2 * 1024 * 1024


@dataclass
class BashOutputMeta:
    """Metadata associated with a cached Bash output entry.

    Persisted in the session cache (small) alongside an ID that points at the
    on-disk file (potentially large).  Carries everything a future pre-bash
    dedup check needs without re-reading the body from disk.
    """

    output_id: str
    cmd_sha: str
    cmd_preview: str
    stdout_bytes: int
    stderr_bytes: int
    exit_code: int | None
    ts: float
    truncated: bool


def _bash_outputs_dir() -> Path:
    """Return ``data_dir() / "bash_outputs"`` and create it on first use."""
    return get_cache_dir("bash_outputs")


def command_hash(command: str) -> str:
    """Return a short content hash for *command* (first 16 hex chars of SHA-256).

    Thin wrapper around :func:`cache_common.short_content_hash` kept for
    backwards compatibility and for use in :func:`session.mark_bash_run` which
    passes the hash independently of the output ID.
    """
    return short_content_hash(command)


def glob_hash(pattern: str, path: str | None) -> str:
    """Return a content hash for a (pattern, path) Glob call key.

    Used by :func:`store_glob_result` and :func:`load_glob_result` to derive
    a stable, filesystem-safe cache key for a specific Glob invocation.
    The ``path`` component is normalised to the empty string when ``None`` so
    ``glob_hash("**/*.py", None)`` and ``glob_hash("**/*.py", "")`` collide
    intentionally — they represent the same unbounded pattern.
    """
    canonical = f"{pattern}\x00{path or ''}"
    return short_content_hash(canonical)


# Glob result cache: entries stored under bash_outputs dir with a "glob_" prefix
# in the output_id so they can be distinguished from real bash outputs.
# The stored body is the newline-separated list of matching paths (tool_response
# text), exactly as the Glob tool would have returned it.  The staleness check
# is enforced by the caller (pre_read) via STALE_READ_AGE_SECONDS.

_GLOB_RESULT_PREFIX = "glob_"


def store_glob_result(
    session_id: str,
    pattern: str,
    path: str | None,
    result_text: str,
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> str | None:
    """Cache the text result of a Glob call and return the output_id, or None on error.

    *result_text* is the raw text response from the Glob tool (newline-separated
    file paths).  The cached entry lives in the bash_outputs directory under an
    ID prefixed with ``glob_`` so it is distinguishable from bash outputs and
    not surfaced by ``token-goat bash-history``.

    Eviction is shared with bash outputs: the oldest entries are removed first
    regardless of whether they are bash or glob entries.
    """
    try:
        g_hash = glob_hash(pattern, path)
        # Build a stable output_id: glob_ prefix + session fragment + hash.
        from .cache_common import safe_session_fragment  # noqa: PLC0415
        out_id = f"{_GLOB_RESULT_PREFIX}{safe_session_fragment(session_id)}-{g_hash}"
        cache_path = safe_join_output_id(out_id, _bash_outputs_dir, "bash_cache")
        if cache_path is None:
            return None
        paths.atomic_write_text(cache_path, result_text)
        evict_old_entries(max_total_bytes=max_total_bytes)
        _LOG.debug("bash_cache: stored glob result id=%s pattern=%s", out_id, sanitize_log_str(pattern))
        return out_id
    except OSError as exc:
        _LOG.debug("bash_cache: glob store failed: %s", exc)
        return None


def load_glob_result(
    session_id: str,
    pattern: str,
    path: str | None,
) -> str | None:
    """Return the cached Glob result text for *(session_id, pattern, path)*, or None.

    Returns None when no cached entry exists (first call, or evicted).  The
    staleness / age check is the caller's responsibility.
    """
    try:
        g_hash = glob_hash(pattern, path)
        from .cache_common import safe_session_fragment  # noqa: PLC0415
        out_id = f"{_GLOB_RESULT_PREFIX}{safe_session_fragment(session_id)}-{g_hash}"
        return load_output_text(out_id, _bash_outputs_dir, "bash_cache")
    except Exception:  # noqa: BLE001
        return None


def output_id_for(session_id: str, command: str, ts: float | None = None) -> str:
    """Build a filesystem-safe ID for the (session, command, time) tuple.

    Delegates to :func:`cache_common.build_output_id` with the command hash as
    the content token.  The millisecond timestamp ensures two invocations of
    the same command in the same session do not collide.
    """
    return build_output_id(session_id, command_hash(command), ts)


def store_output(
    session_id: str,
    command: str,
    stdout: str,
    stderr: str,
    exit_code: int | None,
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> BashOutputMeta | None:
    """Write *stdout* + *stderr* to the cache and return descriptive metadata.

    Returns ``None`` on any I/O error so the calling hook can degrade silently.
    Output larger than ``_MAX_STORED_BYTES`` is tail-preserved (head truncated)
    because failing test output is typically at the bottom.  After the write the
    function opportunistically evicts the oldest files until the total store size
    is back under ``max_total_bytes``; the eviction is best-effort and a failed
    pass simply leaves the directory slightly over budget — the next call will
    try again.
    """
    try:
        out_id = output_id_for(session_id, command)
        path = safe_join_output_id(out_id, _bash_outputs_dir, "bash_cache")
        if path is None:
            return None

        stdout_bytes = len(stdout.encode("utf-8", errors="replace"))
        stderr_bytes = len(stderr.encode("utf-8", errors="replace"))
        total = stdout_bytes + stderr_bytes
        truncated = False
        body_parts: list[str] = []

        if total > _MAX_STORED_BYTES:
            # Preserve the tail: take the last _MAX_STORED_BYTES of the
            # combined stream, prefixing a truncation marker so any consumer
            # immediately knows what they are looking at.  We compose the
            # combined stream as stdout then a blank line then stderr; this
            # matches what the agent would have seen had it copied the tool
            # result directly.
            combined = stdout
            if stderr:
                combined = f"{stdout}\n--- stderr ---\n{stderr}" if stdout else stderr
            keep = combined[-_MAX_STORED_BYTES:]
            body_parts.append(_TRUNC_MARKER.format(n=_MAX_STORED_BYTES, total=total))
            body_parts.append(keep)
            truncated = True
        else:
            if stdout:
                body_parts.append(stdout)
            if stderr:
                if stdout:
                    body_parts.append("\n--- stderr ---\n")
                body_parts.append(stderr)

        body = "".join(body_parts)
        paths.atomic_write_text(path, body)

        meta = BashOutputMeta(
            output_id=out_id,
            cmd_sha=command_hash(command),
            cmd_preview=sanitize_log_str(command, max_len=120),
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            exit_code=exit_code,
            ts=time.time(),
            truncated=truncated,
        )

        # Best-effort eviction.  We do not wait or retry: if the directory
        # walk fails (e.g. concurrent worker activity, antivirus lock) the
        # cap is enforced on the next call.
        evict_old_entries(max_total_bytes=max_total_bytes)

        _LOG.debug(
            "bash_cache: stored id=%s bytes=%d truncated=%s",
            out_id, total, truncated,
        )
        return meta
    except OSError as exc:
        _LOG.warning("bash_cache: store failed: %s", exc)
        return None


def load_output(output_id: str) -> str | None:
    """Return the cached output body for *output_id*, or ``None`` if absent."""
    return load_output_text(output_id, _bash_outputs_dir, "bash_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None.

    Used by ``token-goat bash-history`` to render a listing without reading
    every body.
    """
    return load_output_meta_stat(output_id, _bash_outputs_dir, "bash_cache")


def evict_old_entries(*, max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*.

    Each cached output is a pair of files: the body (``<id>.txt``) and the
    JSON sidecar (``<id>.json``).  Eviction removes both atomically — leaving
    an orphan sidecar after deleting its body would let stale metadata
    accumulate over time and would also confuse ``token-goat bash-history``
    on subsequent calls.

    Returns the number of body files removed; orphan sidecar pairs count as
    one removal each, matching the per-entry abstraction callers expect.
    Skips symlinks (defensive: an attacker who can plant a symlink into the
    cache directory should not be able to direct deletes elsewhere by name).
    All errors are swallowed — eviction is opportunistic, not authoritative.

    The shared algorithm lives in :func:`cache_common.evict_cache_dir`; this
    wrapper supplies the bash-specific directory, log name, and default cap.
    """
    return evict_cache_dir(
        cache_dir_fn=_bash_outputs_dir,
        log_name="bash_cache",
        max_total_bytes=max_total_bytes,
    )


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for every cached output, newest first.

    Used by ``token-goat bash-history`` for human inspection.  Returns an
    empty list when the directory is missing or unreadable; never raises.
    """
    return list_cache_outputs(_bash_outputs_dir)


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID.

    The sidecar stores the structured :class:`BashOutputMeta` so that callers
    (CLI, hints) can answer questions like "what was the exit code?" without
    re-parsing the body.  Sidecar absence is non-fatal: the cache body is
    always the source of truth for output text.
    """
    base = safe_join_output_id(output_id, _bash_outputs_dir, "bash_cache")
    if base is None:
        return None
    return sidecar_path_for(base)


def write_sidecar(meta: BashOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    write_sidecar_metadata(
        sidecar_meta_path(meta.output_id),
        meta,
        log=_LOG,
        log_prefix="bash_cache",
    )


def read_sidecar(output_id: str) -> BashOutputMeta | None:
    """Return parsed :class:`BashOutputMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added later — missing fields
    fall back to safe defaults so an old cache survives a token-goat upgrade.
    """
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        return BashOutputMeta(
            output_id=str(data.get("output_id", output_id)),
            cmd_sha=str(data.get("cmd_sha", "")),
            cmd_preview=str(data.get("cmd_preview", "")),
            stdout_bytes=int(data.get("stdout_bytes", 0)),
            stderr_bytes=int(data.get("stderr_bytes", 0)),
            exit_code=(
                int(data["exit_code"])
                if isinstance(data.get("exit_code"), (int, float))
                else None
            ),
            ts=float(data.get("ts", 0.0)),
            truncated=bool(data.get("truncated", False)),
        )
    except (TypeError, ValueError):
        return None
