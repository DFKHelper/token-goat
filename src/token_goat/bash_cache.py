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
    "load_output",
    "load_output_meta",
    "output_id_for",
    "store_output",
]

import hashlib
import json
import logging
import os
import stat as _stat_module
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TypedDict

from . import paths
from .cache_common import OUTPUT_FILENAME_RE, load_sidecar_json, safe_session_fragment
from .hooks_common import sanitize_log_str

_LOG = logging.getLogger("token_goat.bash_cache")

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


class _OutputStatDict(TypedDict, total=False):
    """Stat-derived metadata returned by :func:`load_output_meta`.

    Keys match the return shape: output_id (always present), size_bytes, mtime.
    """

    output_id: str
    size_bytes: int
    mtime: float


def _bash_outputs_dir() -> Path:
    """Return ``data_dir() / "bash_outputs"`` and create it on first use."""
    d = paths.data_dir() / "bash_outputs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def command_hash(command: str) -> str:
    """Return a short content hash for *command* (first 16 hex chars of SHA-256).

    Commands are compared for dedup purposes only — not authenticated — so a
    cryptographic hash is overkill, but SHA-256 is stdlib, fast, and gives a
    very low collision rate for the small number of commands ever stored per
    session (a few hundred at most).  Truncated to 16 chars to keep filenames
    short while leaving ~64 bits of collision resistance.
    """
    return hashlib.sha256(command.encode("utf-8", errors="replace")).hexdigest()[:16]


def output_id_for(session_id: str, command: str, ts: float | None = None) -> str:
    """Build a filesystem-safe ID for the (session, command, time) tuple.

    The ID embeds a short session prefix and a millisecond timestamp so two
    invocations of the same command in the same session do not collide; both
    are kept and the latest wins on dedup lookups, but each cached output
    remains addressable for forensic retrieval.

    Session ID is short-prefixed (16 chars) because :func:`session.validate_session_id`
    already caps it at 128 chars and stripping to 16 keeps total filename length
    under 50 chars.  Non-alphanumeric characters are replaced with ``_``.
    """
    safe_session = safe_session_fragment(session_id)
    ms = int((ts if ts is not None else time.time()) * 1000)
    return f"{safe_session}-{ms:013d}-{command_hash(command)}"


def _safe_join(output_id: str) -> Path | None:
    """Validate *output_id* and return the corresponding cache file path.

    Returns ``None`` (with a warning log) when the ID is malformed — for example
    a traversal attempt like ``../etc/passwd`` or an embedded null byte.  The
    on-disk store is a sibling of other token-goat data; an attacker-influenced
    ID must not be able to walk out of it.
    """
    if not output_id:
        return None
    name = f"{output_id}.txt"
    if not OUTPUT_FILENAME_RE.match(name):
        _LOG.warning("bash_cache: rejected output_id with invalid chars: %r", sanitize_log_str(output_id))
        return None
    base = _bash_outputs_dir().resolve()
    candidate = (base / name).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        _LOG.warning("bash_cache: rejected output_id escaping base dir: %r", sanitize_log_str(output_id))
        return None
    return candidate


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
        path = _safe_join(out_id)
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
    path = _safe_join(output_id)
    if path is None or not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _LOG.warning("bash_cache: load failed for %s: %s", sanitize_log_str(output_id), exc)
        return None


def load_output_meta(output_id: str) -> _OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None.

    Used by ``token-goat bash-history`` to render a listing without reading
    every body.
    """
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
    """
    try:
        d = _bash_outputs_dir()
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
                _LOG.warning("bash_cache: skipping symlink in cache dir: %s", fp.name)
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
        # Best-effort sidecar removal — if the body deletion succeeded the
        # sidecar should follow.  A failure here is logged at debug only:
        # leaving a single sidecar around is harmless (read_sidecar tolerates
        # missing bodies), and the next eviction pass will retry.
        sidecar = fp.with_suffix(".json")
        try:
            sidecar.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            _LOG.debug("bash_cache: sidecar cleanup failed for %s: %s", sidecar.name, exc)
    if removed:
        _LOG.info(
            "bash_cache: evicted %d entries to fit cap=%d bytes",
            removed, max_total_bytes,
        )

    # Orphan-sidecar sweep.  A sidecar whose body was deleted out-of-band
    # (e.g. a previous eviction whose body unlink succeeded before the
    # sidecar unlink could run, or a manual ``rm cache/*.txt``) would
    # otherwise live forever.  We list ``.json`` files in the cache dir and
    # drop any without a matching ``.txt``.  Cheap because the directory
    # typically has only a handful of entries at any time.
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
                _LOG.debug("bash_cache: orphan sidecar removal failed: %s: %s", sp.name, exc)
    except OSError:
        pass

    return removed


def list_outputs() -> list[_OutputStatDict]:
    """Return metadata for every cached output, newest first.

    Used by ``token-goat bash-history`` for human inspection.  Returns an
    empty list when the directory is missing or unreadable; never raises.
    """
    try:
        d = _bash_outputs_dir()
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
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID.

    The sidecar stores the structured :class:`BashOutputMeta` so that callers
    (CLI, hints) can answer questions like "what was the exit code?" without
    re-parsing the body.  Sidecar absence is non-fatal: the cache body is
    always the source of truth for output text.
    """
    base = _safe_join(output_id)
    if base is None:
        return None
    return base.with_suffix(".json")


def write_sidecar(meta: BashOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    p = sidecar_meta_path(meta.output_id)
    if p is None:
        return
    try:
        paths.atomic_write_text(p, json.dumps(asdict(meta), ensure_ascii=False))
    except OSError as exc:
        _LOG.debug("bash_cache: sidecar write failed for %s: %s", meta.output_id, exc)


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
