"""Shared constants and helpers used by both :mod:`bash_cache` and :mod:`web_cache`.

This module exists solely to remove genuine duplication between the two
output-cache modules.  It must not grow into a generic cache base-class —
each cache retains its own directory helper, log module, and metadata shape.
"""
from __future__ import annotations

__all__ = [
    "OUTPUT_FILENAME_RE",
    "evict_cache_dir",
    "load_sidecar_json",
    "safe_session_fragment",
]

import json
import logging
import os
import re
import stat as _stat_module
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Filename pattern shared by both the bash-output and web-output caches.
# Components are intentionally kept short so the full path stays well within
# PATH_MAX even when the data directory lives several levels deep (e.g. roaming
# AppData on Windows).
# Format: <session_short>-<timestamp_ms>-<contenthash>.txt
OUTPUT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$")

# Pre-compiled pattern used by safe_session_fragment — module-level so it is
# only compiled once across both callers.
_SESSION_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def evict_cache_dir(
    *,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
    max_total_bytes: int,
) -> int:
    """Evict the oldest ``.txt`` entries from a cache directory until the total
    on-disk size is at or under *max_total_bytes*.

    This is the shared implementation of the LRU-eviction algorithm used by
    both :func:`bash_cache.evict_old_entries` and
    :func:`web_cache.evict_old_entries`.  Callers supply the three values that
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
    _log = logging.getLogger(f"token_goat.{log_name}")

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
            _log.debug("%s: sidecar cleanup failed for %s: %s", log_name, sidecar.name, exc)
    if removed:
        _log.info(
            "%s: evicted %d entries to fit cap=%d bytes",
            log_name, removed, max_total_bytes,
        )

    # Orphan-sidecar sweep — a sidecar whose body was deleted out-of-band
    # (e.g. a previous eviction whose body unlink succeeded before the sidecar
    # unlink could run, or a manual ``rm cache/*.txt``) would otherwise live
    # forever.  We list ``.json`` files and drop any without a matching ``.txt``.
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
                _log.debug("%s: orphan sidecar removal failed: %s: %s", log_name, sp.name, exc)
    except OSError:
        pass

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
