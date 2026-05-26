"""Shared constants and helpers used by both :mod:`bash_cache` and :mod:`web_cache`.

This module exists solely to remove genuine duplication between the two
output-cache modules.  It must not grow into a generic cache base-class —
each cache retains its own directory helper, log module, and metadata shape.
"""
from __future__ import annotations

__all__ = [
    "OUTPUT_FILENAME_RE",
    "OutputStatDict",
    "build_keyed_output_id",
    "build_output_id",
    "evict_cache_dir",
    "get_cache_dir",
    "list_cache_outputs",
    "load_output_meta_stat",
    "load_output_text",
    "load_sidecar_json",
    "safe_cache_op",
    "safe_join_output_id",
    "safe_session_fragment",
    "short_content_hash",
    "short_output_id",
    "sidecar_path_for",
    "store_blob",
    "truncate_tail_preserve",
    "write_sidecar_metadata",
]

import hashlib
import json
import logging
import os
import re
import stat as _stat_module
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypedDict

from .util import get_logger

# Filename pattern shared by both the bash-output and web-output caches.
# Components are intentionally kept short so the full path stays well within
# PATH_MAX even when the data directory lives several levels deep (e.g. roaming
# AppData on Windows).
# Format: <session_short>-<timestamp_ms>-<contenthash>.txt
OUTPUT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$")

# Pre-compiled pattern used by safe_session_fragment — module-level so it is
# only compiled once across both callers.
_SESSION_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def get_cache_dir(name: str) -> Path:
    """Return ``data_dir() / name`` and create it on first use.

    Shared implementation of the ``_bash_outputs_dir`` / ``_web_outputs_dir`` /
    ``_skill_outputs_dir`` pattern used in every cache module.  All three called
    either ``paths.ensure_dir(paths.data_dir() / name)`` or inlined the
    equivalent ``mkdir`` — this centralises the one-liner so a future storage
    layout change lands here once.
    """
    from . import paths as _paths  # noqa: PLC0415
    return _paths.ensure_dir(_paths.data_dir() / name)


@contextmanager
def safe_cache_op(op_name: str, *, log: logging.Logger) -> Generator[None, None, None]:
    """Context manager that catches and logs ``OSError`` from a cache write operation.

    Use inside ``store_output`` and similar functions to replace the boilerplate::

        try:
            # ... write logic ...
            return result
        except OSError as exc:
            _LOG.warning("%s: store failed: %s", log_prefix, exc)
            return None

    with::

        with safe_cache_op("store_output", log=_LOG):
            # ... write logic ...
            return result
        return None  # reached only when the context manager suppresses an OSError

    Parameters
    ----------
    op_name:
        Short descriptive name for the operation (e.g. ``"store_output"``, ``"store"``).
        Included in the warning message so log readers know which step failed.
    log:
        The module-level logger to emit the warning on.

    Notes
    -----
    Only ``OSError`` (and its subclasses) are caught; all other exceptions
    propagate normally.  This matches the contract of the cache modules, where
    I/O failures are expected (full disk, antivirus lock, read-only filesystem)
    but programming errors should still surface.
    """
    try:
        yield
    except OSError as exc:
        log.warning("cache: %s failed: %s", op_name, exc)


def sidecar_path_for(output_path: Path) -> Path:
    """Return the ``.json`` sidecar path for *output_path* (``.txt`` body file).

    Each cache module's ``sidecar_meta_path`` previously duplicated
    ``base.with_suffix(".json")``.  Centralising the one-liner means any future
    change to the sidecar extension or naming convention lands in one place.
    """
    return output_path.with_suffix(".json")


class OutputStatDict(TypedDict, total=False):
    """Stat-derived metadata shape shared by all three output-cache modules.

    Every module previously declared its own ``_OutputStatDict`` with identical
    fields; they are consolidated here.  The fields are the same regardless of
    cache (bash, web, or skill): ``output_id`` is always present; ``size_bytes``
    and ``mtime`` come from :func:`os.stat`.
    """

    output_id: str
    size_bytes: int
    mtime: float


def short_content_hash(text: str) -> str:
    """Return the first 16 hex characters of the SHA-256 of *text*.

    Used by all three cache modules to fingerprint a command, URL, or skill
    body for dedup/id purposes.  SHA-256 is overkill for collision resistance
    at this scale (~hundreds of entries per session) but is stdlib, fast, and
    consistent.  16 hex chars give ~64 bits of collision resistance — more than
    enough.

    Encoding errors are replaced rather than raised so the function is safe for
    any string input including binary-tainted command output.
    """
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def build_output_id(session_id: str, content_token: str, ts: float | None = None) -> str:
    """Build the canonical ``{session_short}-{ms:013d}-{content_token}`` output ID.

    Used by :mod:`bash_cache` and :mod:`web_cache` where the content token is
    the hash of the command or URL (via :func:`short_content_hash`).  The
    millisecond timestamp ensures two invocations of the same command/URL in
    the same session do not collide while both remain addressable.

    *skill_cache* uses a different ID shape (``{session_short}-{safe_name}-{sha}``)
    and therefore does not use this helper; it calls :func:`short_content_hash`
    directly.
    """
    safe_session = safe_session_fragment(session_id)
    ms = int((ts if ts is not None else time.time()) * 1000)
    return f"{safe_session}-{ms:013d}-{content_token}"


def build_keyed_output_id(prefix: str, session_id: str, content_token: str) -> str:
    """Build a timestamp-less ``{prefix}{session_short}-{content_token}`` output ID.

    Used by deduplicating caches where two invocations with the same content
    should collide (i.e. overwrite each other) rather than create a new entry.
    The bash glob-result cache uses this with ``prefix="glob_"`` so re-running
    the same ``Glob`` call in a session refreshes the cached result without
    accumulating one entry per call.

    The result is structurally compatible with :data:`OUTPUT_FILENAME_RE` as
    long as the *prefix* and *content_token* contain only ``[A-Za-z0-9_-]``
    characters.  Callers are responsible for ensuring this; the
    :func:`safe_join_output_id` validator on the write path will reject any
    malformed ID.
    """
    safe_session = safe_session_fragment(session_id)
    return f"{prefix}{safe_session}-{content_token}"


def evict_cache_dir(
    *,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
    max_total_bytes: int,
    max_file_count: int = 4096,
) -> int:
    """Evict the oldest ``.txt`` entries from a cache directory until the total
    on-disk size is at or under *max_total_bytes* AND the file count is at or
    under *max_file_count*.

    This is the shared implementation of the LRU-eviction algorithm used by
    both :func:`bash_cache.evict_old_entries` and
    :func:`web_cache.evict_old_entries`.  Callers supply the values that
    differ between the two modules; everything else — the scan loop, symlink
    guard, oldest-first sort, body+sidecar pair deletion, and orphan-sidecar
    sweep — is identical and lives here once.

    Parameters
    ----------
    cache_dir_fn:
        Zero-argument callable that returns (and creates if absent) the cache
        directory.  Matches the ``_bash_outputs_dir`` / ``_web_outputs_dir``
        pattern used inside each module.
    log_name:
        Module-qualified prefix for all log messages emitted by this function
        (e.g. ``"bash_cache"`` or ``"web_cache"``).  Each log record looks like
        ``"<log_name>: <message>"``, preserving the per-module context that
        existing log consumers expect.
    max_total_bytes:
        Byte budget for the directory.  Entries are deleted oldest-first until
        the summed size of remaining ``.txt`` files is at or below this value.
    max_file_count:
        File count cap for the directory expressed as the maximum number of
        ``.txt`` body files.  Each body file may have a matching ``.json``
        sidecar, so the physical directory-entry count may be up to
        ``2 * max_file_count``.  Entries are deleted oldest-first until the
        number of ``.txt`` files is at or below this value.  The default of
        4096 prevents unbounded growth when many sub-1 KB entries accumulate —
        Windows NTFS ``iterdir`` on tens of thousands of files adds measurable
        hook cold-start latency (~200–500 ms).

    Returns
    -------
    int
        Number of body (``.txt``) files removed.  Orphaned sidecar-only
        entries swept at the end do not count toward this total — the sweep is
        purely defensive cleanup with no body to remove.

    Safety
    ------
    * Symlinks in the cache directory are skipped (logged at WARNING level) so a
      crafted symlink cannot direct deletes to arbitrary filesystem paths.
    * All I/O errors are swallowed; eviction is opportunistic.  A failure in the
      scan phase returns 0; a failure to delete an individual entry is skipped
      with ``continue`` so the loop keeps trying the next candidate.
    * Sidecar (``.json``) deletion after each body removal is best-effort: a
      failed sidecar unlink is logged at DEBUG and will be cleaned up by the
      next orphan sweep.
    """
    _log = get_logger(log_name)

    try:
        d = cache_dir_fn()
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
                _log.warning("%s: skipping symlink in cache dir: %s", log_name, fp.name)
                continue
            entries.append((fp, float(st.st_mtime), int(st.st_size)))
            total += int(st.st_size)
    except OSError:
        return 0

    # Orphan-sidecar sweep — a sidecar whose body was deleted out-of-band
    # (e.g. a previous eviction whose body unlink succeeded before the sidecar
    # unlink could run, or a manual ``rm cache/*.txt``) would otherwise live
    # forever.  We sweep BEFORE the early-return so orphans are cleaned even
    # when both caps are already satisfied.  Cost: one additional iterdir pass,
    # which is the same order as the scan pass we already paid above.
    #
    # Defensive: only consider .json files whose stem would form a valid cache
    # filename (the .txt sibling that would have to exist).  Without this guard,
    # an unrelated .json file dropped into the cache dir — e.g. a user-managed
    # ``config.json`` or a debugger artifact — would be silently deleted on the
    # next eviction pass.  The cache directory belongs to token-goat but the
    # token-goat philosophy is "fail-soft, never own more than you wrote": we
    # touch only files whose names we would have generated.
    try:
        for sp in d.iterdir():
            if not sp.name.endswith(".json"):
                continue
            # Validate that the corresponding .txt name would be a cache file
            # we own.  This prevents the sweep from deleting unrelated .json
            # files that happen to live in the cache dir.
            body_name = sp.stem + ".txt"
            if not OUTPUT_FILENAME_RE.match(body_name):
                continue
            body = sp.with_suffix(".txt")
            if body.exists():
                continue
            try:
                sp.unlink()
            except OSError as exc:
                _log.debug("%s: orphan sidecar removal failed: %s: %s", log_name, sp.name, exc)
    except OSError:
        pass

    if total <= max_total_bytes and len(entries) <= max_file_count:
        return 0

    entries.sort(key=lambda t: t[1])  # oldest first
    remaining = len(entries)
    removed = 0
    for fp, _mtime, size in entries:
        if total <= max_total_bytes and remaining <= max_file_count:
            break
        try:
            fp.unlink()
            total -= size
            remaining -= 1
            removed += 1
        except OSError:
            continue
        sidecar = fp.with_suffix(".json")
        try:
            sidecar.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            _log.debug("%s: sidecar cleanup failed for %s: %s", log_name, sidecar.name, exc)
    if removed:
        _log.info(
            "%s: evicted %d entries (bytes cap=%d, count cap=%d)",
            log_name, removed, max_total_bytes, max_file_count,
        )

    return removed


def load_sidecar_json(path: Path) -> dict[str, Any] | None:
    """Load and validate a JSON sidecar file, returning a ``dict`` or ``None``.

    Returns ``None`` when the file is absent, unreadable, contains malformed
    JSON, or has a top-level type other than ``dict``.  This covers every
    failure mode that :func:`bash_cache.read_sidecar` and
    :func:`web_cache.read_sidecar` must tolerate; callers keep the
    dataclass-construction step so the two metadata shapes stay independent.
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def write_sidecar_metadata(
    sidecar_path: Path | None,
    meta: Any,
    *,
    log: logging.Logger,
    log_prefix: str,
) -> None:
    """Persist ``meta`` (a dataclass instance) as a JSON sidecar at *sidecar_path*.

    Both bash_cache.write_sidecar and web_cache.write_sidecar previously
    duplicated this exact wrapping: build the path, json-encode the asdict
    payload via the atomic-write helper, and log on OSError. Centralising the
    body keeps the call sites to one line each and ensures any future hardening
    (compression, schema-version stamp, etc.) lands in one place.

    ``log_prefix`` is the human-readable cache name surfaced in the debug log
    (``"bash_cache"`` or ``"web_cache"``) so the merged log stream still tells
    you which cache failed.
    """
    from dataclasses import asdict  # noqa: PLC0415

    if sidecar_path is None:
        return
    try:
        from . import paths as _paths  # noqa: PLC0415
        _paths.atomic_write_text(
            sidecar_path,
            json.dumps(asdict(meta), ensure_ascii=False),
        )
    except OSError as exc:
        log.debug(
            "%s: sidecar write failed for %s: %s",
            log_prefix,
            getattr(meta, "output_id", "?"),
            exc,
        )


def truncate_tail_preserve(
    content: str,
    max_bytes: int,
    *,
    marker_template: str,
) -> tuple[str, bool]:
    """Tail-preserve *content* if its utf-8 byte length exceeds ``max_bytes``.

    Returns ``(stored, was_truncated)``. When the content fits, returns the
    content unchanged and ``False``. When it doesn't, returns the trailing
    portion whose utf-8 byte length is at or under ``max_bytes`` with
    ``marker_template`` (a format string accepting ``{n}`` for the kept byte
    count and ``{total}`` for the original byte count) prepended, and ``True``.

    Both bash_cache and web_cache pages favour the tail because page footers,
    JSON response bodies, error stack traces, and the latest portion of test
    output all tend to live there.

    Implementation note: the slice is computed in bytes, not codepoints, so
    the stored body's byte length is guaranteed to be at or under
    ``max_bytes``.  For ASCII-only content the two are equivalent; for
    multi-byte UTF-8 (CJK, emoji) codepoint slicing would store up to 4×
    ``max_bytes`` on disk, which would silently break the directory byte
    cap.  Slicing on raw bytes then decoding with ``errors="replace"``
    handles split-codepoint boundaries safely — at most one trailing
    replacement character (``\\ufffd``) may appear at the head of the kept
    region.
    """
    encoded = content.encode("utf-8", errors="replace")
    body_bytes = len(encoded)
    if body_bytes <= max_bytes:
        return content, False
    keep_bytes = encoded[-max_bytes:]
    # Advance the slice start to the next valid utf-8 codepoint boundary so a
    # cut mid-codepoint does not produce a leading U+FFFD that re-encodes to 3
    # bytes (which would push us over the cap).  Continuation bytes have the
    # high bits 10xxxxxx (i.e. 0x80..0xBF).  Walking forward at most 3 bytes
    # finds a leading byte or exhausts the slice (worst case empty slice if
    # the entire window is continuations, which cannot happen in valid utf-8
    # of non-trivial length but the guard is cheap).
    skip = 0
    while skip < len(keep_bytes) and (keep_bytes[skip] & 0xC0) == 0x80:
        skip += 1
    if skip:
        keep_bytes = keep_bytes[skip:]
    # Decode the tail.  errors="replace" is retained as a final safety net —
    # the boundary advance above already eliminates the common mid-codepoint
    # case, but malformed input (e.g. lone surrogates from errors="replace"
    # in the encode step) can still trigger replacement during decode.
    keep = keep_bytes.decode("utf-8", errors="replace")
    return marker_template.format(n=max_bytes, total=body_bytes) + keep, True


def safe_session_fragment(session_id: str) -> str:
    """Return a filesystem-safe 16-character prefix of *session_id*.

    Replaces every character that is not alphanumeric, underscore, or hyphen
    with an underscore, then truncates to 16 characters.  Falls back to the
    literal string ``"anon"`` when the result would otherwise be empty (i.e.
    *session_id* is empty or contains only characters that map to underscores
    at the very start before any alphanumeric content appears, then are fully
    stripped by the truncation).

    This fragment is used as the leading component of output-cache filenames
    so that entries can be associated with a session at a glance without
    re-parsing the JSON sidecar.

    Examples::

        safe_session_fragment("abc-123_xyz")   # "abc-123_xyz"
        safe_session_fragment("a" * 64)        # "aaaaaaaaaaaaaaaa"
        safe_session_fragment("!@#$")          # "____"  (or "anon" if truncated to empty)
        safe_session_fragment("")              # "anon"
    """
    return _SESSION_UNSAFE_RE.sub("_", session_id)[:16] or "anon"


# ---------------------------------------------------------------------------
# Shared path / I/O helpers for bash_cache and web_cache
# ---------------------------------------------------------------------------


def safe_join_output_id(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> Path | None:
    """Validate *output_id* and return the corresponding ``<id>.txt`` path.

    Returns ``None`` (with a warning log) when the ID is malformed — for
    example a traversal attempt like ``../etc/passwd`` or an embedded null
    byte.  The on-disk store sits next to other token-goat data; an
    attacker-influenced ID must not be able to walk out of it.

    The returned path may or may not exist on disk; callers that need to
    read an existing file should check ``path.exists()``.  The read path
    (:func:`load_output_text`) adds a suffix-fallback scan for short ids;
    the write path uses this function directly and always writes to the
    full canonical path.

    Parameters
    ----------
    output_id:
        The raw ID string to validate (full id only; suffix resolution is
        handled by :func:`load_output_text`).
    cache_dir_fn:
        Zero-argument callable that returns (and creates if absent) the cache
        directory.  Matches the ``_bash_outputs_dir`` / ``_web_outputs_dir``
        pattern inside each module.
    log_name:
        Module prefix for warning messages (e.g. ``"bash_cache"``).
    """
    if not output_id:
        return None
    _log = get_logger(log_name)
    name = f"{output_id}.txt"
    if not OUTPUT_FILENAME_RE.match(name):
        _log.warning("%s: rejected output_id with invalid chars: %r", log_name, output_id[:200])
        return None
    base = cache_dir_fn().resolve()
    candidate = (base / name).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        _log.warning("%s: rejected output_id escaping base dir: %r", log_name, output_id[:200])
        return None
    return candidate


def store_blob(
    output_id: str,
    body: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> Path | None:
    """Validate *output_id*, write *body* atomically, and return the path.

    Returns ``None`` when the ID is malformed (same guard as
    :func:`safe_join_output_id`).  On success returns the ``.txt`` path that
    was written, so callers can derive the sidecar path or log the location.

    This consolidates the three-line pattern that every cache ``store_output``
    function repeats::

        path = safe_join_output_id(out_id, cache_dir_fn, log_name)
        if path is None:
            return None
        paths.atomic_write_text(path, body)

    into a single call.  Any :exc:`OSError` from the write propagates to the
    caller so the surrounding ``try/except OSError`` block in each store
    function still handles it uniformly.
    """
    from . import paths as _paths  # noqa: PLC0415

    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None:
        return None
    _paths.atomic_write_text(path, body)
    return path


def short_output_id(output_id: str) -> str:
    """Return the display form of *output_id*: ``…<last8>`` (13 chars total).

    Hints and manifests embed this short form so agents can copy-paste the
    suffix into ``token-goat bash-output <suffix>`` or ``web-output <suffix>``.
    The CLI resolves the suffix via :func:`safe_join_output_id`'s suffix fallback.

    For ids shorter than 8 chars the full id is returned unchanged (no ellipsis).
    """
    if len(output_id) <= 8:
        return output_id
    return f"…{output_id[-8:]}"


def load_output_text(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> str | None:
    """Return the cached output body for *output_id*, or ``None`` if absent.

    Shared implementation for :func:`bash_cache.load_output` and
    :func:`web_cache.load_output`.

    Accepts both full ids and trailing 8-char suffixes (as rendered by
    :func:`short_output_id`).  When the exact file is not found, scans the
    cache directory for any file whose stem ends with *output_id*.  If
    exactly one match is found it is loaded; if zero or multiple are found
    ``None`` is returned.
    """
    _log = get_logger(log_name)
    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None:
        return None
    if not path.exists():
        # Suffix fallback: allow short (8-char) ids as rendered in hints.
        base = cache_dir_fn()
        if base.is_dir():
            suffix = output_id.lower()
            matches = [
                p for p in base.iterdir()
                if p.suffix == ".txt"
                and OUTPUT_FILENAME_RE.match(p.name)
                and p.stem.lower().endswith(suffix)
            ]
            if len(matches) == 1:
                path = matches[0]
            elif len(matches) > 1:
                _log.warning(
                    "%s: ambiguous suffix %r matches %d entries; pass a longer id",
                    log_name, output_id[:200], len(matches),
                )
                return None
            else:
                return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _log.warning("%s: load failed for %s: %s", log_name, output_id[:200], exc)
        return None


def load_output_meta_stat(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None.

    Shared implementation for :func:`bash_cache.load_output_meta` and
    :func:`web_cache.load_output_meta`.
    """
    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None or not path.exists():
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return OutputStatDict(
        output_id=output_id,
        size_bytes=int(st.st_size),
        mtime=float(st.st_mtime),
    )


def list_cache_outputs(cache_dir_fn: Callable[[], Path]) -> list[OutputStatDict]:
    """Return metadata for every cached output in *cache_dir_fn()*, newest first.

    Shared implementation for :func:`bash_cache.list_outputs` and
    :func:`web_cache.list_outputs`.  Returns an empty list when the directory
    is missing or unreadable; never raises.
    """
    try:
        d = cache_dir_fn()
    except OSError:
        return []

    results: list[OutputStatDict] = []
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
            results.append(OutputStatDict(
                output_id=fp.stem,
                size_bytes=int(st.st_size),
                mtime=float(st.st_mtime),
            ))
    except OSError:
        return results

    results.sort(key=lambda r: r["mtime"], reverse=True)
    return results
