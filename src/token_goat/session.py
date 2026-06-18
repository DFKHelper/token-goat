"""Session-context cache: tracks files, line ranges, and symbols read in the current session.

Each Claude Code session gets a ``SessionCache`` JSON file keyed by the
session ID.  Hooks populate it on every Read, Grep, Glob, and Edit tool call;
the pre-read hook reads it to emit "you already read lines X-Y of this file"
nudges that prevent the model from pulling in content it already holds in
context.

Concurrency model
-----------------
Multiple hooks can fire concurrently (one per tool call), so the module uses:
* An in-process ``threading.Lock`` (``_FILE_LOCK``) to serialise writes from
  the same process.
* Atomic rename via ``paths.atomic_write_text()`` to guard against partial
  writes being observed by a concurrent reader in another process.
* A short retry loop (3 attempts with exponential back-off) on both load and
  save to ride out brief contention windows.

When the cache is completely unavailable (e.g. a read-only filesystem) the
``unavailable`` flag is set and all mutation functions become no-ops, so a
broken cache never blocks the agent.
"""
from __future__ import annotations

__all__ = [
    "BASH_DEDUP_IDS_MAX",
    "BASH_HISTORY_MAX",
    "BashEntry",
    "DECISION_HISTORY_MAX",
    "DecisionEntry",
    "EDITED_FILES_MAX",
    "FILES_MAX",
    "FileEntry",
    "GLOB_HISTORY_MAX",
    "GlobEntry",
    "GrepEntry",
    "GREPS_HISTORY_MAX",
    "HINTS_CONTENT_DEDUP_MAX",
    "HINTS_SEEN_MAX",
    "IMAGE_SHRINK_COUNT_MAX",
    "PINNED_SYMBOLS_MAX",
    "RESULT_CACHE_MAX",
    "SKILL_HISTORY_MAX",
    "SNAPSHOT_SHAS_MAX",
    "ResultCacheEntry",
    "SESSION_SCHEMA_VERSION",
    "SessionCache",
    "SkillEntry",
    "WEB_HISTORY_MAX",
    "WebEntry",
    "cleanup_stale",
    "get_file_entry",
    "get_result_cache",
    "get_snapshot_sha",
    "list_edited",
    "list_touched",
    "load",
    "lookup_bash_entry",
    "lookup_glob_entry",
    "lookup_grep_entry",
    "lookup_skill_entry",
    "lookup_web_entry",
    "mark_bash_run",
    "mark_decision",
    "mark_file_edited",
    "mark_file_read",
    "mark_glob_run",
    "mark_grep",
    "get_skill_history",
    "mark_skill_loaded",
    "record_skill_compact_hit",
    "mark_web_fetch",
    "put_result_cache",
    "record_hint_category",
    "reset_session",
    "save",
    "set_snapshot_sha",
    "safe_load",
    "validate_session_id",
    # File-level lock context manager (exposed for testing)
    "_session_file_lock",
    # Internal helpers exposed for testing
    "_coerce_nonneg_int",
    "_coerce_ts",
    "_hint_category_should_suppress",
    "_lookup_in_cache",
    "_merge_session_caches",
    "_migrate_session",
    "_parse_file_entry",
    "_parse_glob_entry",
    "_parse_grep_entry",
    "_parse_pattern_entry_fields",
    "_round_ts",
    "_safe_parse",
    "_serialize_bash_entry",
    "_serialize_file_entry",
    "_serialize_glob_entry",
    "_serialize_grep_entry",
    "_serialize_pattern_entry",
    "_serialize_result_cache_entry",
    "_serialize_skill_entry",
    "_serialize_web_entry",
    # Size-cap helpers exposed for testing
    "_SESSION_MAX_BYTES",
    "_get_session_max_bytes",
    "_trim_session_for_size",
]

import contextlib
import hashlib
import json
import math
import os
import random
import re
import stat as _stat_module
import sys
import threading
import time
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from itertools import islice
from operator import attrgetter, itemgetter
from pathlib import Path
from typing import Any, Final, TypedDict, TypeVar, cast

from . import paths
from .hooks_common import is_real_int, sanitize_log_str
from .util import env_int, get_logger, utf8_bytes

_LOG = get_logger("session")

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
_IS_WINDOWS: bool = sys.platform == "win32"

_T = TypeVar("_T")
_V = TypeVar("_V")  # Entry-value type for _lookup_in_cache


def _coerce_ts(raw: object) -> float:
    """Return *raw* as float if it is numeric, else 0.0."""
    return float(raw) if isinstance(raw, (int, float)) else 0.0


def _safe_max_ts(a: float, b: float) -> float:
    """Return max(a, b) but treat NaN as -inf so a valid timestamp always wins.

    Python's built-in max() propagates NaN: max(nan, 5.0) returns nan.
    Timestamps in session caches should be non-negative finite floats; NaN can
    arrive via a corrupt session file that round-tripped through JSON (JSON
    supports the string "NaN" as a float literal in Python, even though it is
    not valid JSON per RFC 8259).  Treating NaN as -inf means the other side's
    valid value is always preferred over a nonsensical NaN.
    """
    a_val = a if not math.isnan(a) else -math.inf
    b_val = b if not math.isnan(b) else -math.inf
    result = max(a_val, b_val)
    # If both were NaN, result is -inf — return 0.0 (epoch) as the least-bad default.
    return result if result != -math.inf else 0.0


def _coerce_nonneg_int(raw: object, default: int = 0) -> int:
    """Return ``int(raw)`` clamped to ≥ 0, or *default* on error."""
    try:
        return max(0, int(raw))  # type: ignore[call-overload]  # deliberate: coerces arbitrary input via int(); TypeError caught below
    except (TypeError, ValueError):
        return default


def _coerce_nonneg_int_or_none(raw: object) -> int | None:
    """Return ``int(raw)`` clamped to ≥ 0, or ``None`` when *raw* is missing/None/invalid.

    Distinct from :func:`_coerce_nonneg_int` (which defaults to 0): the on-disk fingerprint
    fields must distinguish "not recorded" (None) from a legitimate epoch mtime of 0, so a
    missing/invalid value round-trips as None rather than collapsing into a real 0 reading.
    """
    if raw is None:
        return None
    try:
        return max(0, int(raw))  # type: ignore[call-overload]  # deliberate: coerces arbitrary input via int(); TypeError caught below
    except (TypeError, ValueError):
        return None


def _safe_parse(
    factory: Callable[[dict[str, Any]], _T],
    data: dict[str, Any],
    label: str,
) -> _T | None:
    """Call *factory(data)*, logging and returning None on any parse error."""
    try:
        return factory(data)
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted %s entry: %s", label, exc)
        return None


SESSION_SCHEMA_VERSION = 1
_FILE_LOCK = threading.Lock()  # in-process; multi-process safe enough via atomic write

# In-process record of the highest session version this process has written, keyed
# by session id.  Guarded by _FILE_LOCK (read/written only inside save()'s critical
# section).  The save() fast path skips the CAS re-read+merge when the on-disk
# (mtime_ns, size) fingerprint matches what load() recorded — but that fingerprint
# can ALIAS: two same-process threads adding equal-length keys can produce byte-
# identical JSON (same size) written within one mtime tick (same mtime_ns), so both
# threads trust a stale fingerprint and the second clobbers the first (lost update).
# This registry breaks the aliasing exactly: version is monotonic and never collides,
# so if another thread advanced the on-disk version past the loaded cache's version,
# the fast path is bypassed and the full CAS+merge runs regardless of the fingerprint.
_LAST_SAVED_VERSION: dict[str, int] = {}

# ---------------------------------------------------------------------------
# Process-local load cache
# ---------------------------------------------------------------------------
# user-prompt-submit and subagent-stop hooks both fire near-instantly in the
# same Claude tool turn.  Without this cache each fires a full JSON file read
# (~5-10 ms on Windows).  Within a single process invocation they can share.
#
# Keyed by session_id.  Value: (cache_obj, mtime_when_loaded).
# Invalidated by mtime change (another process wrote the file) or overflow.
# Cap: 4 entries (hook processes are single-session; 4 is a generous upper bound).
_PROC_LOAD_CACHE_MAX: Final[int] = 4
_proc_load_cache: dict[str, tuple[SessionCache, float]] = {}

# Tracks (session_id, phase) pairs that have already logged a telemetry row for
# cache contention.  Prevents flooding global.db with one stats row per hook call
# when the session file becomes persistently unavailable (e.g. full disk).
# This dedup is per-process only — a fresh hook process (each tool call spawns one)
# starts with an empty set, so a single row per (session_id, phase) per process is
# recorded rather than strictly one row per session lifetime.
# ---------------------------------------------------------------------------
# Disk-based contention dedup
# ---------------------------------------------------------------------------
# _REPORTED_CONTENTION used to be a module-level set — but each hook spawns a
# fresh process (~50 ms lifetime), so the set was always empty on entry and the
# "dedup" recorded one stat row per (session_id, phase) per hook process.
# Under disk pressure this flooded global.db with thousands of identical rows.
#
# Replaced with touch-files under data_dir()/contention_marks/.  The directory
# is created lazily on first use.  Worker maintenance sweeps marks older than
# _CONTENTION_MARK_TTL_SECS on each maintenance cycle.


def _contention_mark_path(session_id: str, phase: str) -> Path:
    """Return the touch-file path for a (session_id, phase) contention record."""
    from . import paths as _paths  # noqa: PLC0415

    # Sanitize both components: keep only alphanumeric, underscore, and hyphen;
    # truncate to 32 chars each so combined filenames stay well under FS limits.
    _SAFE_RE = re.compile(r"[^A-Za-z0-9_-]")
    safe_sid = _SAFE_RE.sub("_", session_id)[:32] or "anon"
    safe_phase = _SAFE_RE.sub("_", phase)[:32] or "phase"
    fragment = f"{safe_sid}_{safe_phase}.mark"
    return _paths.safe_join(_paths.data_dir() / "contention_marks", fragment)


# Touch-files older than this are considered expired and may be swept by the worker.
_CONTENTION_MARK_TTL_SECS: Final[float] = 3600.0

# ---------------------------------------------------------------------------
# Cross-process session lockfile helpers
# ---------------------------------------------------------------------------
# Each session JSON gets a sidecar ``<session_id>.json.lock`` file. The lock is an OS advisory byte-range lock (msvcrt on Windows, fcntl.flock on POSIX) held on a persistent, never-deleted lockfile; the OS drops it automatically when the owning process closes the fd or dies, so there is no PID bookkeeping, no staleness probe, and no unlink race. _LOCK_TIMEOUT_SECS is the maximum time (seconds) to spend waiting for a lock before giving up, raised from 2.0 to 5.0 because Windows pytest tmp-dir IO under concurrent load can push individual save() calls past 2 s; the hot path is unaffected (this budget only applies when the lock is genuinely contended).
_LOCK_TIMEOUT_SECS: Final[float] = 5.0
# Poll interval (seconds) when spinning for the lock, jittered inside the loop to prevent two starving processes from synchronising their polls.
_LOCK_POLL_SECS: Final[float] = 0.002
# Dedicated Random instance keeps the jitter deterministic per-process and independent of any seeded RNG state callers may have set globally.
_LOCK_JITTER: Final[random.Random] = random.Random()


def _session_lock_path(session_id: str) -> Path:
    """Return the lockfile path for *session_id*."""
    return paths.session_cache_path(session_id).with_suffix(".json.lock")


def _os_advisory_lock(fd: int) -> bool:
    """Try to take an exclusive OS advisory lock on *fd* without blocking.

    Returns True if the lock was acquired, False if another process holds it.
    The OS releases the lock automatically when *fd* is closed (including on
    process death), so there is no PID file to orphan and no staleness window.
    """
    if _IS_WINDOWS:
        import msvcrt  # noqa: PLC0415

        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    try:
        import fcntl  # noqa: PLC0415
    except ImportError:
        _LOG.warning("fcntl unavailable; session lock degraded to in-process only")
        return True  # fail open: in-process _FILE_LOCK still serialises threads
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[attr-defined]
    except OSError:
        return False
    return True


def _os_advisory_unlock(fd: int) -> None:
    """Release the advisory lock taken by :func:`_os_advisory_lock` on *fd*."""
    if _IS_WINDOWS:
        import msvcrt  # noqa: PLC0415

        with contextlib.suppress(OSError):
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return
    try:
        import fcntl  # noqa: PLC0415
    except ImportError:
        return
    with contextlib.suppress(OSError):
        fcntl.flock(fd, fcntl.LOCK_UN)  # type: ignore[attr-defined]


def _acquire_session_lock(session_id: str) -> int | None:
    """Acquire the cross-process lock for *session_id*.

    Returns the open file descriptor for the lockfile on success, or None if the
    lock could not be acquired within _LOCK_TIMEOUT_SECS. The caller must pass the
    returned fd to :func:`_release_session_lock`. The lockfile is persistent and
    never deleted; mutual exclusion comes from an OS advisory lock on the fd, not
    from the file's existence. Invariant: never write to or seek the lock fd — the
    Windows byte-range lock covers offset [0, 1) regardless of file contents.
    """
    lock_path = _session_lock_path(session_id)
    paths.ensure_dir(lock_path.parent)
    try:
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        _LOG.error("session lock open failed: %s", session_id[:16])
        return None
    deadline = time.monotonic() + _LOCK_TIMEOUT_SECS
    try:
        while True:
            if _os_advisory_lock(fd):
                return fd
            if time.monotonic() >= deadline:
                _LOG.debug("session lock timeout: %s", session_id[:16])
                with contextlib.suppress(OSError):
                    os.close(fd)
                return None
            # Jitter (±25%) on the poll interval so two starving processes do not settle into lockstep where the loser always loses.
            time.sleep(_LOCK_POLL_SECS * (0.75 + 0.5 * _LOCK_JITTER.random()))
    except BaseException:
        # _os_advisory_lock swallows OSError, but a non-OSError (bad fd, interpreter shutdown) would otherwise leak the open descriptor.
        with contextlib.suppress(OSError):
            os.close(fd)
        raise


def _release_session_lock(session_id: str, fd: int | None) -> None:
    """Release the cross-process lock acquired by :func:`_acquire_session_lock`.

    The lockfile is intentionally left on disk; closing the fd drops the OS
    advisory lock. *session_id* is retained for signature stability with callers.
    """
    if fd is None:
        return
    _os_advisory_unlock(fd)
    with contextlib.suppress(OSError):
        os.close(fd)


# ---------------------------------------------------------------------------
# File-level lock context manager (fcntl on POSIX, sidecar on Windows)
# ---------------------------------------------------------------------------
# _SESSION_FILE_LOCK_TIMEOUT_MS:  Maximum milliseconds to spin waiting for the
#   lock before giving up and proceeding without it.  200 ms is short enough
#   to keep hook latency imperceptible while long enough to outlast most
#   transient write bursts.
_SESSION_FILE_LOCK_TIMEOUT_MS: Final[int] = 200
# _SESSION_FILE_LOCK_POLL_MS: Interval between retry attempts (ms).
_SESSION_FILE_LOCK_POLL_MS: Final[int] = 10


@contextlib.contextmanager
def _session_file_lock(path: Path) -> Generator[None, None, None]:
    """Cross-process file-level lock for a session JSON path.

    On POSIX (Linux / macOS / WSL) uses ``fcntl.flock(LOCK_EX | LOCK_NB)``
    with a retry loop bounded to :data:`_SESSION_FILE_LOCK_TIMEOUT_MS`.
    On Windows uses an exclusive-create sidecar ``.flock`` file with the
    same timeout semantics.

    The lock is always released on context exit, even if the body raises.
    If the lock cannot be acquired within the timeout, a warning is logged
    and the body executes without the lock (fail-soft: never blocks the hook).

    Usage::

        with _session_file_lock(session_path):
            data = session_path.read_text()
            # ... mutate ...
            session_path.write_text(data)
    """
    if _IS_WINDOWS:
        yield from _session_file_lock_windows(path)
    else:
        yield from _session_file_lock_posix(path)


def _session_file_lock_posix(path: Path) -> Generator[None, None, None]:
    """POSIX implementation of :func:`_session_file_lock` using ``fcntl.flock``."""
    lock_fd: int | None = None
    acquired = False
    try:
        try:
            import fcntl  # noqa: PLC0415
        except ImportError:
            # fcntl is not available (e.g. running under a non-POSIX interpreter).
            # Proceed without lock — fail-soft contract.
            _LOG.debug("_session_file_lock: fcntl unavailable; skipping lock for %s", path.name)
            yield
            return

        deadline_ms = _SESSION_FILE_LOCK_TIMEOUT_MS
        elapsed_ms = 0
        # Open (or create) the file for locking; we use the session JSON path
        # itself so the flock is tied to the actual data file.
        try:
            paths.ensure_dir(path.parent)
            lock_fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as exc:
            _LOG.debug("_session_file_lock: open failed (%s); skipping lock", exc)
            yield
            return

        while elapsed_ms < deadline_ms:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[attr-defined]  # fcntl is POSIX-only; not in typeshed on Windows
                acquired = True
                break
            except OSError:
                time.sleep(_SESSION_FILE_LOCK_POLL_MS / 1000.0)
                elapsed_ms += _SESSION_FILE_LOCK_POLL_MS

        if not acquired:
            _LOG.warning(
                "_session_file_lock: POSIX flock timeout (%dms) for %s; proceeding without lock",
                _SESSION_FILE_LOCK_TIMEOUT_MS,
                path.name,
            )

        yield

    except BaseException:
        raise
    finally:
        if acquired and lock_fd is not None:
            try:
                import fcntl as _fcntl  # noqa: PLC0415
                _fcntl.flock(lock_fd, _fcntl.LOCK_UN)  # type: ignore[attr-defined]  # fcntl is POSIX-only; not in typeshed on Windows
            except Exception:  # noqa: BLE001
                pass
        if lock_fd is not None:
            with contextlib.suppress(OSError):
                os.close(lock_fd)


def _session_file_lock_windows(path: Path) -> Generator[None, None, None]:
    """Windows implementation of :func:`_session_file_lock` using a sidecar file.

    Creates a ``.flock`` sidecar file with ``O_CREAT | O_EXCL`` (atomic on
    NTFS) as the mutual-exclusion token.  On timeout, logs a warning and
    yields without the lock (fail-soft).
    """
    sidecar = path.with_suffix(path.suffix + ".flock")
    acquired = False
    try:
        paths.ensure_dir(path.parent)
        deadline_ms = _SESSION_FILE_LOCK_TIMEOUT_MS
        elapsed_ms = 0

        # A stale flock is one held longer than 10× the timeout (2 s at defaults).
        # Legitimate lock holders complete well within the 200 ms timeout; anything
        # older is from a crashed process and is safe to evict.
        stale_threshold_secs = _SESSION_FILE_LOCK_TIMEOUT_MS * 10 / 1000.0

        while elapsed_ms < deadline_ms:
            try:
                fd = os.open(str(sidecar), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                acquired = True
                break
            except (FileExistsError, OSError):
                # Check for a stale sidecar left by a crashed process before sleeping.
                with contextlib.suppress(OSError):
                    if time.time() - sidecar.stat().st_mtime > stale_threshold_secs:
                        sidecar.unlink(missing_ok=True)
                        _LOG.debug(
                            "_session_file_lock: evicted stale flock for %s", path.name
                        )
                        continue
                time.sleep(_SESSION_FILE_LOCK_POLL_MS / 1000.0)
                elapsed_ms += _SESSION_FILE_LOCK_POLL_MS

        if not acquired:
            _LOG.warning(
                "_session_file_lock: Windows sidecar timeout (%dms) for %s; proceeding without lock",
                _SESSION_FILE_LOCK_TIMEOUT_MS,
                path.name,
            )

        yield

    except BaseException:
        raise
    finally:
        if acquired:
            with contextlib.suppress(OSError):
                sidecar.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# CAS merge helper
# ---------------------------------------------------------------------------

def _merge_session_caches(local: SessionCache, remote: SessionCache) -> SessionCache:
    """Merge *local* mutations into a newer *remote* on-disk state.

    Called when save() detects that *remote*.version > *local*.version,
    meaning another process saved the file while we held our in-memory copy.
    We keep *remote* as the base (it is authoritative for all uncontested
    fields) and re-apply *local*'s mutations field-by-field using the
    appropriate merge strategy:

    - sets   → union
    - dicts  → update remote with local (local's newer ts wins per-key)
    - counts → max(local, remote)
    - lists  → take whichever is longer, capped to the original list cap
    - scalar bookkeeping (last_activity_ts) → max
    """
    # Work on remote as the base so all fields it has that we don't touch are
    # preserved verbatim.
    merged = remote

    # --- dicts and sets ---
    # hints_seen: dict merge — take max count for each fingerprint, bounded by HINTS_SEEN_MAX
    merged_hints = dict(remote.hints_seen)
    for fp, count in local.hints_seen.items():
        merged_hints[fp] = max(merged_hints.get(fp, 0), count)
    merged.hints_seen = merged_hints
    if len(merged.hints_seen) > HINTS_SEEN_MAX:
        # LRU eviction: keep the entries with the highest seen counts
        # (most recent/frequently seen hints are more relevant for future dedup).
        sorted_hints = sorted(merged_hints.items(), key=itemgetter(1), reverse=True)
        merged.hints_seen = dict(sorted_hints[:HINTS_SEEN_MAX])

    # hints_content_dedup: dict merge — take max count for each content hash, bounded by HINTS_CONTENT_DEDUP_MAX
    # Preserves insertion order (FIFO eviction on cap) using dict + pop idiom for oldest.
    merged_content_dedup = dict(remote.hints_content_dedup)
    for ch, (summary, count) in local.hints_content_dedup.items():
        if ch in merged_content_dedup:
            # Update count to max; keep summary from whichever process has it first (remote)
            old_summary, old_count = merged_content_dedup[ch]
            merged_content_dedup[ch] = (old_summary, max(old_count, count))
        else:
            merged_content_dedup[ch] = (summary, count)
    merged.hints_content_dedup = merged_content_dedup
    if len(merged.hints_content_dedup) > HINTS_CONTENT_DEDUP_MAX:
        # FIFO eviction: keep newest entries; discard oldest when over cap.
        items_to_remove = len(merged.hints_content_dedup) - (HINTS_CONTENT_DEDUP_MAX - _HINTS_CONTENT_DEDUP_EVICT)
        for _ in range(items_to_remove):
            merged.hints_content_dedup.pop(next(iter(merged.hints_content_dedup)))

    # bash_dedup_emitted_ids: set union
    merged.bash_dedup_emitted_ids = local.bash_dedup_emitted_ids | remote.bash_dedup_emitted_ids

    # --- dicts: merge local into remote (local ts wins per-key when both have it) ---
    for k, v in local.files.items():
        if k not in remote.files:
            remote.files[k] = v
        else:
            # Keep the entry with the more recent last_read_ts.
            if v.last_read_ts > remote.files[k].last_read_ts:
                remote.files[k] = v
    merged.files = remote.files

    # edited_files: max (same conservative approximation as aggregate hint counters).
    # The formula r + max(0, l - r) = max(r, l) — the comment previously said "sum"
    # which was misleading.  Without tracking the fork-point base value we cannot
    # reconstruct the true sum, so max() is used: it never overcounts but may
    # undercount by ~1 when two processes each make one edit in the same CAS window.
    # The consequence is that heavily-edited files appear slightly less important
    # in the compact manifest, which is acceptable for a display-only counter.
    ec: int
    for efk, ec in local.edited_files.items():
        remote.edited_files[efk] = max(remote.edited_files.get(efk, 0), ec)
    merged.edited_files = remote.edited_files

    # result_cache, bash_history, web_history, skill_history: newer ts wins.
    rce: ResultCacheEntry
    for rck, rce in local.result_cache.items():
        if rck not in remote.result_cache or rce.ts > remote.result_cache[rck].ts:
            remote.result_cache[rck] = rce
    merged.result_cache = remote.result_cache

    be: BashEntry
    for bek, be in local.bash_history.items():
        if bek not in remote.bash_history or be.ts > remote.bash_history[bek].ts:
            remote.bash_history[bek] = be
    merged.bash_history = remote.bash_history

    we: WebEntry
    for wek, we in local.web_history.items():
        if wek not in remote.web_history or we.ts > remote.web_history[wek].ts:
            remote.web_history[wek] = we
    merged.web_history = remote.web_history

    ske: SkillEntry
    for skk, ske in local.skill_history.items():
        if skk not in remote.skill_history or ske.ts > remote.skill_history[skk].ts:
            remote.skill_history[skk] = ske
    merged.skill_history = remote.skill_history

    # snapshot_shas: local wins (it's the freshest content snapshot).
    remote.snapshot_shas.update(local.snapshot_shas)
    merged.snapshot_shas = remote.snapshot_shas

    # greps / glob_history: append local entries not already in remote, then
    # re-apply the size cap so repeated CAS merges cannot grow these lists
    # beyond their documented maximums.
    remote_grep_keys = {(grep.pattern, grep.path) for grep in remote.greps}
    for grep in local.greps:
        if (grep.pattern, grep.path) not in remote_grep_keys:
            remote.greps.append(grep)
    merged.greps = remote.greps[-GREPS_HISTORY_MAX:]

    # grep_result_hashes: dict merge — take max count per hash, similar to hints_content_dedup.
    # Preserves insertion order (FIFO eviction on cap) using dict + pop idiom for oldest.
    merged_grep_hashes = dict(remote.grep_result_hashes)
    for hash_key, pattern in local.grep_result_hashes.items():
        if hash_key not in merged_grep_hashes:
            merged_grep_hashes[hash_key] = pattern
    merged.grep_result_hashes = merged_grep_hashes
    if len(merged.grep_result_hashes) > GREP_RESULT_HASHES_MAX:
        items_to_remove = len(merged.grep_result_hashes) - (GREP_RESULT_HASHES_MAX - _GREP_RESULT_HASHES_EVICT)
        for _ in range(items_to_remove):
            merged.grep_result_hashes.pop(next(iter(merged.grep_result_hashes)))

    # mcp_result_hashes: first-seen wins (remote takes precedence, same as grep_result_hashes).
    merged_mcp_hashes = dict(remote.mcp_result_hashes)
    for hash_key, output_id in local.mcp_result_hashes.items():
        if hash_key not in merged_mcp_hashes:
            merged_mcp_hashes[hash_key] = output_id
    merged.mcp_result_hashes = merged_mcp_hashes
    if len(merged.mcp_result_hashes) > MCP_RESULT_HASHES_MAX:
        items_to_remove = len(merged.mcp_result_hashes) - (MCP_RESULT_HASHES_MAX - _MCP_RESULT_HASHES_EVICT)
        for _ in range(items_to_remove):
            merged.mcp_result_hashes.pop(next(iter(merged.mcp_result_hashes)))

    # file_content_seen: first-seen wins — remote (older writer) takes precedence.
    merged_fcs = dict(remote.file_content_seen)
    for sha16, fpath in local.file_content_seen.items():
        if sha16 not in merged_fcs:
            merged_fcs[sha16] = fpath
    merged.file_content_seen = merged_fcs
    if len(merged.file_content_seen) > FILE_CONTENT_SEEN_MAX:
        evict = len(merged.file_content_seen) - (FILE_CONTENT_SEEN_MAX - _FILE_CONTENT_SEEN_EVICT)
        for _ in range(evict):
            merged.file_content_seen.pop(next(iter(merged.file_content_seen)))

    # pytest_failures: local wins per cmd_sha — local's entry is from the run
    # that just completed, so it is always the most recent for that command.
    merged.pytest_failures = remote.pytest_failures | local.pytest_failures

    remote_glob_keys = {(glob.pattern, glob.path) for glob in remote.glob_history}
    for glob in local.glob_history:
        if (glob.pattern, glob.path) not in remote_glob_keys:
            remote.glob_history.append(glob)
    merged.glob_history = remote.glob_history[-GLOB_HISTORY_MAX:]

    # decisions: same append-only pattern as greps.  Dedup key is (ts, text) —
    # two entries with the same timestamp and text are the same decision.
    remote_decision_keys = {(d.ts, d.text) for d in remote.decisions}
    for d in local.decisions:
        if (d.ts, d.text) not in remote_decision_keys:
            remote.decisions.append(d)
    merged.decisions = remote.decisions[-DECISION_HISTORY_MAX:]

    # --- counts: max (conservative; no base-value tracking) ---
    # Without storing the value at fork time we cannot compute the true delta
    # each process added.  max() is safe (never overcounts) but undercounts by
    # ~1 when two processes each emit exactly one hint in the same CAS window.
    # All hint counters — both the flat scalars and the per-type dicts — are
    # stats/display values only.  None are used for budget gate logic (the gate
    # reads hints_emitted, structured_hints_emitted, and index_only_hints_emitted
    # directly via _hint_budget_check; hints_emitted_by_type is never read there).
    # Uniform max() semantics across all of them keeps the invariant:
    #   sum(hints_emitted_by_type.values()) <= hints_emitted
    # which would break under additive merges when both processes start from the
    # same non-zero base.
    # Use int() coercion via _safe_max_ts to guard against NaN sneaking into
    # these counters from a corrupt session file.  Under normal operation these
    # fields are always int; the _safe_max_ts path is purely defensive.
    merged.hints_emitted = int(_safe_max_ts(local.hints_emitted, remote.hints_emitted))
    merged.hints_ignored = int(_safe_max_ts(local.hints_ignored, remote.hints_ignored))
    merged.structured_hints_emitted = int(_safe_max_ts(local.structured_hints_emitted, remote.structured_hints_emitted))
    merged.index_only_hints_emitted = int(_safe_max_ts(local.index_only_hints_emitted, remote.index_only_hints_emitted))

    # --- per-type counters: max (consistent with the flat scalars above) ---
    # Using max() per key — rather than sum() — keeps these dicts consistent with
    # hints_emitted.  Additive merges could produce
    #   hints_emitted_by_type["already_read"] > hints_emitted
    # when two concurrent processes both start from a non-zero base (the shared
    # base value is counted twice).  max() never overcounts; it undercounts by ~1
    # in the same CAS window, which is acceptable for display-only counters.
    merged_emitted_by_type = dict(remote.hints_emitted_by_type)
    for hint_type, count in local.hints_emitted_by_type.items():
        merged_emitted_by_type[hint_type] = max(merged_emitted_by_type.get(hint_type, 0), count)
    merged.hints_emitted_by_type = merged_emitted_by_type

    merged_suppressed_by_type = dict(remote.hints_suppressed_by_type)
    for hint_type, count in local.hints_suppressed_by_type.items():
        merged_suppressed_by_type[hint_type] = max(merged_suppressed_by_type.get(hint_type, 0), count)
    merged.hints_suppressed_by_type = merged_suppressed_by_type

    # hint_category_history: union-with-cap per category.
    # Take whichever process observed more events for each category (longer list
    # wins), capped to _HINT_CAT_HISTORY_MAX — mirrors the per-entry eviction
    # in record_hint_category_event().  This preserves suppression signal that
    # would otherwise be silently dropped when a CAS collision occurs.
    merged_cat_hist: dict[str, list[bool]] = dict(remote.hint_category_history)
    for cat_key, local_vals in local.hint_category_history.items():
        remote_vals = remote.hint_category_history.get(cat_key, [])
        combined = local_vals if len(local_vals) >= len(remote_vals) else remote_vals
        merged_cat_hist[cat_key] = combined[-_HINT_CAT_HISTORY_MAX:]
    merged.hint_category_history = merged_cat_hist

    # --- lists: take the longer one, capped ---
    # recent_hints cap is 3 (enforced in from_dict); re-apply after merge so
    # a union of two near-full lists cannot silently double the size.
    merged.recent_hints = (
        local.recent_hints if len(local.recent_hints) >= len(remote.recent_hints)
        else remote.recent_hints
    )[-3:]

    # --- scalars: max ---
    # Use _safe_max_ts instead of plain max() to guard against NaN timestamps.
    # A NaN can arrive from a corrupt-or-hand-edited session JSON file:
    # Python's json.loads accepts the non-standard "NaN" float literal, and
    # max(nan, x) returns nan — silently poisoning every subsequent comparison.
    merged.last_activity_ts = _safe_max_ts(local.last_activity_ts, remote.last_activity_ts)

    # --- manifest delta-cache: take the newer emit ---
    # Compare timestamps safely: treat NaN as -inf so a valid timestamp always wins.
    local_ts = local.last_manifest_ts if not math.isnan(local.last_manifest_ts) else -math.inf
    remote_ts = remote.last_manifest_ts if not math.isnan(remote.last_manifest_ts) else -math.inf
    if local_ts >= remote_ts:
        merged.last_manifest_sha = local.last_manifest_sha
        merged.last_manifest_ts = local.last_manifest_ts if not math.isnan(local.last_manifest_ts) else 0.0
    # else remote already has the newer manifest fields (kept from base)

    # cwd: prefer local (the hook that fired knows the current working directory).
    if local.cwd is not None:
        merged.cwd = local.cwd

    # file_access_counts / symbol_access_counts: max per key (conservative, same
    # rationale as other hint counters — never overcounts, may undercount by ~1 in
    # a CAS window but these are display-only nudge counters, not correctness gates).
    merged_fac: dict[str, int] = dict(remote.file_access_counts)
    for fpath, count in local.file_access_counts.items():
        merged_fac[fpath] = max(merged_fac.get(fpath, 0), count)
    merged.file_access_counts = merged_fac

    merged_sac: dict[str, int] = dict(remote.symbol_access_counts)
    for sym_key, count in local.symbol_access_counts.items():
        merged_sac[sym_key] = max(merged_sac.get(sym_key, 0), count)
    merged.symbol_access_counts = merged_sac

    # grep_target_counts: max per key (same rationale as file_access_counts — display-only nudge counter).
    merged_gtc: dict[str, int] = dict(remote.grep_target_counts)
    for gtc_path, count in local.grep_target_counts.items():
        merged_gtc[gtc_path] = max(merged_gtc.get(gtc_path, 0), count)
    merged.grep_target_counts = merged_gtc

    # pinned_symbols: union-with-cap, preserving insertion order from remote base.
    # A pin set by the user in any concurrent process is authoritative; take the
    # union of both lists, capped at PINNED_SYMBOLS_MAX, remote-order first.
    merged_pinned: list[str] = list(remote.pinned_symbols)
    for spec in local.pinned_symbols:
        if spec not in merged_pinned:
            merged_pinned.append(spec)
    merged.pinned_symbols = merged_pinned[:PINNED_SYMBOLS_MAX]

    # read_content_hashes: local wins (most recent Read takes precedence).
    merged.read_content_hashes = remote.read_content_hashes | local.read_content_hashes
    if len(merged.read_content_hashes) > READ_CONTENT_HASHES_MAX:
        _rch_evict = len(merged.read_content_hashes) - (READ_CONTENT_HASHES_MAX - _READ_CONTENT_HASHES_EVICT)
        for _ in range(_rch_evict):
            merged.read_content_hashes.pop(next(iter(merged.read_content_hashes)))

    # log_file_cache: local wins (most recent stat+read takes precedence).
    merged.log_file_cache = remote.log_file_cache | local.log_file_cache
    if len(merged.log_file_cache) > LOG_FILE_CACHE_MAX:
        _lfc_evict = len(merged.log_file_cache) - (LOG_FILE_CACHE_MAX - _LOG_FILE_CACHE_EVICT)
        for _ in range(_lfc_evict):
            merged.log_file_cache.pop(next(iter(merged.log_file_cache)))

    # dir_listing_cache: local wins (most recent listing takes precedence).
    merged.dir_listing_cache = remote.dir_listing_cache | local.dir_listing_cache
    if len(merged.dir_listing_cache) > DIR_LISTING_CACHE_MAX:
        _dlc_evict = len(merged.dir_listing_cache) - (DIR_LISTING_CACHE_MAX - _DIR_LISTING_CACHE_EVICT)
        for _ in range(_dlc_evict):
            merged.dir_listing_cache.pop(next(iter(merged.dir_listing_cache)))

    # cmd_output_hashes: local wins (most recent run takes precedence).
    merged.cmd_output_hashes = remote.cmd_output_hashes | local.cmd_output_hashes
    if len(merged.cmd_output_hashes) > CMD_OUTPUT_HASHES_MAX:
        _coh_evict = len(merged.cmd_output_hashes) - (CMD_OUTPUT_HASHES_MAX - _CMD_OUTPUT_HASHES_EVICT)
        for _ in range(_coh_evict):
            merged.cmd_output_hashes.pop(next(iter(merged.cmd_output_hashes)))

    merged._invalidate_json_cache()
    return merged


@dataclass
class FileEntry:
    """Tracks reads of a single file within a session.

    Used by pre-read hooks to detect redundant reads and emit token-saving hints.
    Accumulates line ranges and symbol accesses across all reads in the session.

    ``last_edit_ts`` records when the file was last Write/Edit/MultiEdit'd in this
    session.  When ``last_edit_ts > last_read_ts`` the cached ``line_ranges`` no
    longer correspond to the file's current contents (an inserted/deleted line
    shifts every subsequent line number), so the dedup hint should suppress the
    "you already read lines X-Y" claim — that range may point at different code now.
    Default 0.0 means "never edited this session".

    ``symbols_ts`` maps symbol name → unix timestamp of access. Used by the
    compaction manifest to rank symbols by recency: recently-accessed symbols
    appear first in the Symbols Accessed section.
    """

    rel_or_abs: str  # path as Claude requested it (relative or absolute)
    last_read_ts: float  # unix
    read_count: int  # number of times Read fired for this file
    line_ranges: list[tuple[int, int]]  # [(start, end), ...] of read ranges, 1-indexed inclusive
    symbols_read: list[str]  # via token-goat read file::symbol
    last_edit_ts: float = 0.0  # unix ts of last edit; 0.0 = never edited this session
    symbols_ts: dict[str, float] = field(default_factory=dict)  # symbol → unix timestamp
    # On-disk fingerprint captured at the file's last read: st_mtime_ns and st_size.
    # None means "not recorded" (legacy entries / failed stat). 0 is a *legitimate* value —
    # an epoch-timestamped file stats st_mtime_ns == 0 — so None, not 0, is the unrecorded
    # sentinel; conflating the two silently disabled the freshness gate for epoch files.
    # Unlike last_edit_ts these are session-independent: post_edit keys edits on session_id,
    # so a sub-agent editing under a different session_id never bumps this session's
    # last_edit_ts. The on-disk stat is the only cross-session signal that a cached read
    # window has gone stale, so reread_deny compares it against the live stat before denying.
    # See _handle_reread_deny.
    read_mtime_ns: int | None = None  # os.stat(path).st_mtime_ns at last read; None = not recorded
    read_size: int | None = None  # os.stat(path).st_size at last read; None = not recorded
    last_read_call_index: int = 0  # hooks_read._call_index value when this file was last read; 0 = never recorded


@dataclass
class GrepEntry:
    """Tracks a Grep call (pattern + scope).

    Recorded to detect repeated Grep calls with the same pattern in the same session,
    enabling nudges toward reusing earlier results.
    """

    pattern: str
    path: str | None
    ts: float
    result_count: int | None = None  # if known


@dataclass
class GlobEntry:
    """Tracks a Glob call (pattern + optional path scope).

    Recorded to detect repeated Glob calls with the same pattern in the same session,
    enabling nudges toward reusing earlier results instead of re-scanning the tree.
    """

    pattern: str
    path: str | None
    ts: float
    result_count: int | None = None  # number of matching paths, if known


@dataclass
class WebEntry:
    """Tracks one WebFetch invocation within a session.

    Stored in :attr:`SessionCache.web_history` keyed by the SHA prefix of the
    URL so a future pre-fetch can quickly dedupe a repeat fetch.  The body
    itself lives on disk under the web-cache directory and is referenced here
    only by ``output_id``.

    ``url_preview`` stores up to 200 chars of the URL for human-readable
    display in ``token-goat web-history``; the full URL is not persisted
    because URLs longer than that are typically presigned download tokens or
    similar that should not live in session JSON longer than necessary.
    ``content_type`` is the MIME type from the response (e.g. "text/html") when
    captured, or None if not available.
    """

    url_sha: str
    url_preview: str
    output_id: str
    ts: float
    body_bytes: int
    status_code: int | None = None
    truncated: bool = False
    content_type: str | None = None


@dataclass
class BashEntry:
    """Tracks one execution of a Bash command within a session.

    Stored in :attr:`SessionCache.bash_history` keyed by the SHA prefix of the
    command string so a future ``pre_read`` for the same command can quickly
    look up its prior output.  The body itself lives on disk under the
    bash-cache directory and is referenced here only by ``output_id``.

    ``stdout_bytes`` / ``stderr_bytes`` are the *original* sizes (before any
    truncation applied by the cache) so dedup hints can quote the real cost of
    re-running.  ``cmd_preview`` stores up to 120 chars of the command for
    human-readable display in ``token-goat bash-history``; the full command is
    not persisted because it is recoverable from agent context if needed and
    storing arbitrary user input in session JSON is a privacy concern.

    ``output_sha`` is the content hash of post-compression stdout+stderr
    (first 16 hex chars of SHA-256). Used for content-aware dedup so the same
    command with different output does not trigger a false dedup hint.
    Empty string for backward compatibility with old session caches.
    """

    cmd_sha: str
    cmd_preview: str
    output_id: str
    ts: float
    stdout_bytes: int
    stderr_bytes: int
    exit_code: int | None = None
    truncated: bool = False
    run_count: int = 1
    output_sha: str = ""  # Content hash of post-compression output (16 hex chars)


@dataclass
class SkillEntry:
    """Tracks one Skill tool invocation within a session.

    Stored in :attr:`SessionCache.skill_history` keyed by skill name (the
    short form Claude Code presents, e.g. ``"ralph"`` or ``"plugin:skill"``)
    so the compaction manifest and post-compact recovery hint can list every
    skill the agent has loaded.  The body itself lives on disk under the
    skill-cache directory and is referenced here only by ``output_id``.

    ``content_sha`` lets the renderer distinguish "same skill, same content"
    (a duplicate load) from "same skill, new content" (the skill was updated
    between loads — keep both entries addressable).  ``body_bytes`` is the
    *original* body size before any cache truncation so the manifest can
    report the real footprint.
    """

    skill_name: str
    output_id: str
    content_sha: str
    ts: float
    body_bytes: int
    truncated: bool = False
    run_count: int = 1
    source_path: str = ""  # best-effort filesystem path for the skill body
    compact_served_count: int = 0  # times compact form was served from manifest this session


@dataclass
class DecisionEntry:
    """One agent decision captured via ``token-goat decision "<text>"``.

    Decision logs preserve the *why* behind a step — option-A-vs-B trade-offs,
    invariants locked, approaches ruled out — through compaction events.  Edited
    files, manifest blockers, and skill bodies already survive compaction, but
    the reasoning that produced them does not; this entry plugs that gap.

    Stored in :attr:`SessionCache.decisions` as an append-only list (newest at
    the end), capped at :data:`DECISION_HISTORY_MAX` with FIFO eviction.  The
    text is hard-trimmed to :data:`_MAX_DECISION_TEXT_LEN` so a runaway loop
    cannot bloat the session JSON.

    ``tag`` is an optional short label ("rationale", "ruled-out", "invariant")
    that the manifest renderer uses to colour-prefix the entry; an empty string
    renders the entry without a leading bracket.  ``ts`` is recorded in seconds
    since the epoch so the manifest can sort by recency.
    """

    text: str
    ts: float
    tag: str = ""


@dataclass
class ResultCacheEntry:
    """A cached read_symbol/read_section result, keyed elsewhere by (rel_path, item).

    Stores the JSON-serializable result dict alongside the file SHA at the time
    of computation.  The SHA is used as a cheap invalidation signal: when a file
    is re-indexed because the post-edit hook fired, its SHA changes and the next
    lookup recomputes rather than returning stale text.

    ``ts`` is the unix timestamp when the entry was stored, used both for FIFO
    eviction order tracking and for diagnostic logging — it is *not* a TTL.
    """

    file_sha: str  # hex SHA-1 of the file contents at cache time; empty when unknown
    kind: str  # "symbol" or "section" — disambiguates the two read-replacement paths
    result: dict[str, Any]  # the SymbolResult/SectionResult dict (JSON-serializable)
    ts: float  # unix timestamp at insertion (for FIFO ordering + observability)


# attrgetter key for sorting FileEntry objects by last_read_ts.
# Defined at module level to avoid allocating a new lambda on every list_touched() call.
_BY_LAST_READ_TS = attrgetter("last_read_ts")


def _round_ts(ts: float) -> float:
    """Round a Unix timestamp to millisecond precision (3 decimal places).

    Full microsecond precision (e.g. 1747854321.4839182) wastes ~7 bytes per
    field in the session JSON and is never needed for hint staleness logic.
    Millisecond precision is more than sufficient for all comparisons performed
    by the pre-read and diff-aware hint engines.
    """
    return round(ts, 3)

# Cap for the in-session result cache.  100 entries is enough to cover a typical
# multi-hour Claude Code session — agents rarely re-ask for more than a few
# dozen distinct (file, symbol) slices.  When the cap is hit we evict the oldest
# entries (FIFO via dict insertion order) so a long-running session does not
# bloat session JSON without bound.
RESULT_CACHE_MAX = 50
# Number of entries to evict at once when the cap is hit.  Batch eviction
# amortises the dict-rewrite cost across many cache inserts rather than
# reshuffling on every single insertion above the cap.  10 at a time keeps
# ~80 % of entries after eviction (at cap=50, 50→40 after a batch evict).
_RESULT_CACHE_EVICT = 10

# Maximum number of bash-history entries retained per session.  Each entry is
# tiny (well under 200 bytes), so 75 keeps the session JSON small while still
# covering a full work session; the cap exists to keep size predictable in
# pathological loops (e.g. a watch-mode rerunning every few seconds).
# FIFO eviction discards the oldest first.
BASH_HISTORY_MAX = 75
_BASH_HISTORY_EVICT = 15
# Length of the bash command preview persisted in session JSON.  Long enough
# to identify a command across re-runs ("pytest tests/test_x.py -k foo") but
# short enough to keep the manifest output bounded.
_MAX_BASH_PREVIEW = 120

# Maximum number of web-history entries retained per session, with the same
# FIFO-eviction semantics as bash history.  75 is more than enough for any
# real session; the prior value of 200 was over-allocated for web fetches,
# which are far less frequent than bash commands.
WEB_HISTORY_MAX = 75
_WEB_HISTORY_EVICT = 15
# Length of the URL preview persisted in session JSON.  100 chars is enough
# to identify any URL (hostname + path) while halving per-entry storage vs 200.
_MAX_WEB_URL_PREVIEW = 100

# Maximum number of skill-history entries retained per session, with the same
# FIFO-eviction semantics as bash history.  Skills are typically loaded a few
# times per session at most (Ralph + improve + a few specialist skills); 20 is
# enough to cover any realistic session and keeps the manifest section bounded.
SKILL_HISTORY_MAX: Final[int] = 20
_SKILL_HISTORY_EVICT: Final[int] = 5
# Length of the skill name persisted per entry — long enough for any realistic
# Claude Code skill including the ``plugin:skill`` namespaced form.
_MAX_SKILL_NAME_LEN: Final[int] = 128

# Maximum number of grep entries retained per session.  Grep calls accumulate
# across the session; without a cap the greps list grows without bound.
# FIFO eviction (keep most recent) prevents unbounded growth in long sessions.
GREPS_HISTORY_MAX: Final[int] = 75
_GREPS_HISTORY_EVICT: Final[int] = 15

# Maximum number of grep result-content hashes retained per session.  The
# grep_result_hashes dict tracks actual grep result content (by hash) to detect
# when two different grep patterns return the same results, enabling a "same
# results as pattern X" dedup hint.  When the cap is exceeded, FIFO eviction
# keeps the most recent hashes (most likely to be repeated).
GREP_RESULT_HASHES_MAX: Final[int] = 50
_GREP_RESULT_HASHES_EVICT: Final[int] = 5
# mcp_result_hashes dict maps (tool_name+input) hash → output_id for MCP call dedup.
MCP_RESULT_HASHES_MAX: Final[int] = 100
_MCP_RESULT_HASHES_EVICT: Final[int] = 10
# Maximum number of file-content SHA entries retained per session.
FILE_CONTENT_SEEN_MAX: Final[int] = 500
_FILE_CONTENT_SEEN_EVICT: Final[int] = 50
# Maximum number of read-content-hash entries retained per session.  The
# read_content_hashes dict maps normalized path → SHA256 hex of the last
# whole-file Read content for that path, enabling cross-tool dedup with
# Bash cat commands that produce identical output.
READ_CONTENT_HASHES_MAX: Final[int] = 100
_READ_CONTENT_HASHES_EVICT: Final[int] = 10
# Log-file content cache: maps compound key "{norm_path}:{size}:{mtime:.9f}" →
# first-16-hex-chars of SHA256 of the file content.  Used in post_bash to detect
# repeated reads of an unchanged log file (same path, same size, same mtime) and
# suppress duplicate output with an advisory.  Capped at 50 entries.
LOG_FILE_CACHE_MAX: Final[int] = 50
_LOG_FILE_CACHE_EVICT: Final[int] = 5

# Size cap for the dir-listing fingerprint cache.  Maps compound key
# "{norm_dir_path}:{cmd_fingerprint}" → 16-hex-char SHA256 of listing output.
# Capped at 30 entries (smaller than log_file_cache; recursive listings are rarer).
DIR_LISTING_CACHE_MAX: Final[int] = 30
_DIR_LISTING_CACHE_EVICT: Final[int] = 3

# Size cap for the command-output dedup hash map.  Maps display_cmd → sha256_hex of the
# last stdout seen for that command.  Capped at 50 entries; FIFO eviction on overflow.
CMD_OUTPUT_HASHES_MAX: Final[int] = 50
_CMD_OUTPUT_HASHES_EVICT: Final[int] = 5

# Maximum number of decision-log entries retained per session.  Decisions are
# opt-in (the agent calls ``token-goat decision "<text>"``), so the volume is
# self-limited — but a misbehaving loop could pin one entry per iteration; the
# cap is a safety net.  FIFO eviction keeps the most-recent decisions, which
# are the ones most likely to remain load-bearing for the next compaction.
DECISION_HISTORY_MAX: Final[int] = 30
_DECISION_HISTORY_EVICT: Final[int] = 5
# Hard cap on the persisted decision text length.  Long enough for "Chose option
# A because Y; rejected B (cost too high); locked invariant: X must hold" but
# short enough to keep session JSON bounded even at the cap.
_MAX_DECISION_TEXT_LEN: Final[int] = 280

# Maximum number of glob entries retained per session.  Glob calls are typically
# less frequent than Grep calls, so a cap of 20 is sufficient; FIFO eviction keeps
# the most recent patterns, which are the ones most likely to be repeated.
GLOB_HISTORY_MAX: Final[int] = 20
_GLOB_HISTORY_EVICT: Final[int] = 5
# Cap glob pattern length before storage to keep session JSON bounded.
_MAX_GLOB_PATTERN_LEN: int = 512

# Maximum number of distinct (non-overlapping, non-adjacent) line-range spans
# stored per file entry.  _merge_ranges() coalesces overlapping and adjacent
# reads into fewer spans, but non-adjacent reads of the same file accumulate
# indefinitely otherwise.  When the cap is hit, all retained spans are collapsed
# into one spanning range [first_start, last_end] — this is always a correct
# superset of the actual coverage (hints may over-report but never under-report),
# and keeps the per-file JSON footprint from growing without bound in sessions
# that sample a large file in many small offset-jumps.
_MAX_LINE_RANGES_PER_FILE: Final[int] = 15

# Read-count threshold for full-file collapse.  When a file has been read this many
# times or more, its line_ranges list is replaced with a single sentinel [(0, 0)]
# ("full file") to save JSON space and simplify hint generation.  A heavily-accessed
# file is almost certainly in context; hints become noise at this point and the
# savings in session JSON are worth the loss of granular range tracking.
_READ_COUNT_FULL_FILE_THRESHOLD: Final[int] = 10

# Maximum number of hint fingerprints retained per session.  The hints_seen set
# tracks emitted hints to suppress duplicates within the same session; without a
# cap it grows without bound.  When the cap is exceeded, the set is cleared
# (acceptable because false-positive re-emission of a suppressed hint is
# preferable to unbounded growth, and the fingerprint set is a performance
# optimization, not a correctness requirement).
HINTS_SEEN_MAX: Final[int] = 500

# Maximum number of hint content-hash entries retained per session.  The
# hints_content_dedup dict tracks emitted hint content to compress duplicate
# hints (same text shown multiple times) into short stubs.  When the cap is
# exceeded, FIFO eviction keeps the most recent entries (most likely to appear again).
HINTS_CONTENT_DEDUP_MAX: Final[int] = 100
_HINTS_CONTENT_DEDUP_EVICT: Final[int] = 10

# Per-category hint history ring buffer size.  10 entries per category is
# enough to detect a stable ignore streak without retaining stale signal.
_HINT_CAT_HISTORY_MAX: Final[int] = 10

# Maximum number of unique file entries tracked per session (files dict).  An
# agent that reads hundreds of files in a single session would otherwise grow
# the session JSON without bound.  FIFO eviction drops the least-recently-inserted
# entry (dict insertion order) — oldest reads are least likely to generate
# useful hints anyway.
FILES_MAX: Final[int] = 500
_FILES_EVICT: Final[int] = 50

# Maximum number of edited-file entries tracked per session.  Agentic scaffolding
# loops that generate many files would otherwise grow edited_files without bound.
EDITED_FILES_MAX: Final[int] = 500
_EDITED_FILES_EVICT: Final[int] = 50

# Maximum number of snapshot SHA entries retained per session.  One entry per
# unique edited file; 200 covers any realistic session while bounding JSON size.
SNAPSHOT_SHAS_MAX: Final[int] = 200
_SNAPSHOT_SHAS_EVICT: Final[int] = 50

# Maximum number of unique image paths tracked in the per-session shrink count
# dict.  In sessions that generate many screenshots with unique filenames, the
# dict would otherwise grow without bound.  When the cap is hit, FIFO eviction
# drops the entry with the smallest count (least likely to be a hot path).
IMAGE_SHRINK_COUNT_MAX: Final[int] = 200
_IMAGE_SHRINK_COUNT_EVICT: Final[int] = 40

# Maximum number of pinned symbols per session.  Pinned symbols always appear at
# the top of session hints and at the top of the compaction manifest.  Stored as
# a list of "<file>::<symbol>" spec strings.  20 is enough to cover any realistic
# pinned-symbol workflow; a hard cap prevents abuse in long-running loops.
PINNED_SYMBOLS_MAX: Final[int] = 20

# Maximum size of the bash_dedup_emitted_ids set.  Bash history is capped at
# BASH_HISTORY_MAX (75), but the id set is not evicted when history entries are
# dropped, so the set can drift above the history cap in long sessions.  Cap the
# set to 2× BASH_HISTORY_MAX to give the cross-run dedup logic headroom while
# bounding growth.
BASH_DEDUP_IDS_MAX: Final[int] = BASH_HISTORY_MAX * 2

# _CONTENTION_MAX / _REPORTED_CONTENTION removed — replaced by disk touch-files.
# See _contention_mark_path() and _record_cache_contention().


@dataclass
class SessionCache:
    """Session context cache keyed by session_id.

    Populated by post-read and post-edit hooks; used by pre-read hooks to emit hints.
    Persisted as JSON on disk and loaded on every Read/Grep call for fast hint lookup.
    """

    session_id: str
    started_ts: float
    last_activity_ts: float
    files: dict[str, FileEntry] = field(default_factory=dict)  # key = normalized path
    greps: list[GrepEntry] = field(default_factory=list)
    # Grep result content dedup: maps result_content_hash (first 8 hex chars) → pattern
    # that produced it.  Used to detect when two different grep patterns return the
    # same results, enabling a "Same results as pattern X" dedup hint.  FIFO-evicted
    # at GREP_RESULT_HASHES_MAX to prevent unbounded growth in long sessions.
    grep_result_hashes: dict[str, str] = field(default_factory=dict)
    # Per-session MCP result cache: maps (tool_name+input) hash → output_id.  Used
    # by pre-fetch hook to detect repeated read-only MCP calls and serve cached content.
    # Missing in older sessions → empty dict. FIFO-evicted at MCP_RESULT_HASHES_MAX.
    mcp_result_hashes: dict[str, str] = field(default_factory=dict)
    # Cross-tool content dedup: maps normalized-path → SHA256 hex of the last
    # whole-file Read content for that path.  Used in post_bash to detect when
    # a `cat FILE` output is identical to a prior Read and suppress the duplicate.
    # Missing in older sessions → empty dict. FIFO-evicted at READ_CONTENT_HASHES_MAX.
    read_content_hashes: dict[str, str] = field(default_factory=dict)
    # Log-file content cache: maps compound key "{norm_path}:{size}:{mtime:.9f}" →
    # first-16-hex-chars of SHA256 of the log content seen at that (path, size, mtime).
    # Enables post_bash to suppress repeated reads of unchanged log files without
    # re-hashing the full output (same size+mtime ⇒ same content).
    # Missing in older sessions → empty dict. FIFO-evicted at LOG_FILE_CACHE_MAX.
    log_file_cache: dict[str, str] = field(default_factory=dict)
    # Dir-listing fingerprint cache: maps compound key "{norm_dir_path}:{cmd_fingerprint}" →
    # first-16-hex-chars of SHA256 of the listing output seen for that command+directory.
    # Enables post_bash to suppress repeated recursive directory listings (find/fd/ls-R/eza-tree)
    # when the directory content has not changed.  cmd_fingerprint is a short hash of the
    # full argv string so commands with different flags produce different keys.
    # Missing in older sessions → empty dict. FIFO-evicted at DIR_LISTING_CACHE_MAX.
    dir_listing_cache: dict[str, str] = field(default_factory=dict)
    # Command output dedup: maps display_cmd → sha256_hex of the last stdout for that command.
    # Used by post_bash to suppress identical repeated outputs (e.g. git status, npm test).
    # Only applied when stdout >= _CMD_DEDUP_MIN_BYTES and exit_code is 0/None.
    # Missing in older sessions → empty dict. FIFO-evicted at CMD_OUTPUT_HASHES_MAX.
    cmd_output_hashes: dict[str, str] = field(default_factory=dict)
    # Cross-file content dedup: maps file_content_sha16 (first 16 SHA-1 hex chars) →
    # normalized path of the *first* file seen with that content.  Used by pre_read to
    # deny a read of a file whose content is identical to a file already read this session.
    file_content_seen: dict[str, str] = field(default_factory=dict)
    # Tracks files edited this session: normalized_path → edit count
    edited_files: dict[str, int] = field(default_factory=dict)
    # In-session cache of read_symbol/read_section results.  Keyed by a string
    # built from ``_result_cache_key(rel_path, item, kind)`` so the same item
    # cannot collide across the two read flavours.  FIFO-evicted at RESULT_CACHE_MAX.
    # Persisted to disk so subsequent hook invocations (each a separate process)
    # can hit the cache too — without persistence the cache is useless across the
    # one-hook-per-tool-call process model that Claude Code uses on Windows.
    result_cache: dict[str, ResultCacheEntry] = field(default_factory=dict)
    # Per-session bash command history keyed by short SHA of the command.  Used
    # by the pre-Bash dedup hint and by ``token-goat bash-history`` for listing.
    # Insertion-ordered dict; FIFO eviction at BASH_HISTORY_MAX prevents growth
    # in tight retry loops.
    bash_history: dict[str, BashEntry] = field(default_factory=dict)
    # Per-session glob history: list of GlobEntry objects in chronological order.
    # Used by the pre-Glob dedup hint to detect repeated directory scans with
    # the same pattern.  FIFO-evicted at GLOB_HISTORY_MAX (much smaller than
    # grep/bash history because glob patterns recur less frequently).
    glob_history: list[GlobEntry] = field(default_factory=list)
    # Per-session web-fetch history keyed by short SHA of the URL.  Used by
    # the pre-WebFetch dedup hint and by ``token-goat web-history`` for
    # listing.  Same FIFO + cap semantics as bash_history.
    web_history: dict[str, WebEntry] = field(default_factory=dict)
    # Per-session skill-load history keyed by skill name.  Populated by the
    # PostToolUse(Skill) hook; consumed by the compaction manifest's "Active
    # Skills" section and the post-compact recovery hint.  Same FIFO + cap
    # semantics as bash_history but with a much smaller cap (skills are loaded
    # rarely, dozens at most per session).  Repeat loads of the same skill
    # increment ``run_count`` and update ``ts`` rather than allocating a new
    # entry, so the history naturally deduplicates by name.
    skill_history: dict[str, SkillEntry] = field(default_factory=dict)
    # Opt-in decision log captured via ``token-goat decision "<text>"``.  Append-only,
    # newest-last; FIFO-capped at :data:`DECISION_HISTORY_MAX`.  Surfaced by the
    # compact manifest in a dedicated **Decisions:** section so the *why* behind
    # in-flight work survives compaction alongside the *what* (edited files,
    # blockers, skills).  Missing in older session JSON → empty list.
    decisions: list[DecisionEntry] = field(default_factory=list)
    # Per-session content snapshots used by the diff-aware re-read hint.  Maps
    # normalized file path → SHA of the snapshot bytes stored on disk under
    # ``data_dir() / "session_snapshots" / <session_short> / <pathhash>.bin``.
    # Storing only the SHA here (not the bytes) keeps the session JSON small.
    snapshot_shas: dict[str, str] = field(default_factory=dict)
    # Per-session hint fingerprints to suppress duplicate hint injection within the
    # same session. Maps hint_fingerprint (hash of hint text) → count; a dict persisted
    # as dict[str, int] for JSON serialization.  Tracks how many times each fingerprint
    # has been emitted to enable verbose suppression (short stub after N occurrences).
    # Cleared when session expires or approaches time-to-live limits to avoid false-positive
    # suppression on stale cached hints.
    hints_seen: dict[str, int] = field(default_factory=dict)
    # Per-session content hash → summary mapping for hint dedup compression.
    # When a hint has the same content as a previously-seen hint (by SHA256 hash of
    # normalized text), emit a short stub "Same as previously shown hint for <context>"
    # instead of the full repetition.  Maps content_hash (first 8 hex chars) → (summary_text, count).
    # Kept separate from hints_seen (fingerprint dedup) to enable independent control:
    # fingerprints suppress entirely, content_hash dedup compresses.  FIFO-evicted at
    # HINTS_CONTENT_DEDUP_MAX entries to prevent unbounded growth.
    hints_content_dedup: dict[str, tuple[str, int]] = field(default_factory=dict)
    # Tracks which bash output_ids have been surfaced in a dedup hint this session.
    # Serialized as a sorted list[str] in JSON for stability; parsed back to set[str].
    # Used by compact.py to skip manifest entries that the agent already saw via hint.
    bash_dedup_emitted_ids: set[str] = field(default_factory=set)
    # Task-output temp files stored as bash-output blobs this session.  Maps
    # ``task_id`` (hex stem from ``<id>.output``) to ``output_id`` (the blob ID
    # returned by bash_cache.store_output).  On the first read the hook stores the
    # content and records the mapping here; subsequent reads are denied with a redirect
    # to ``token-goat bash-output <output_id>``.
    # Serialised as a dict[str, str] in JSON; missing key in older sessions → {}.
    stored_task_outputs: dict[str, str] = field(default_factory=dict)
    # Curator: tracks how often dedup hints are emitted vs. ignored by the agent.
    # ``hints_emitted`` is incremented each time a dedup hint fires.
    # ``hints_ignored`` is incremented when a Read fires for a path that was
    # recently hinted (within the last 3 tool calls) — indicating the agent
    # read the file anyway, ignoring the hint.
    # When the ignore rate drops below config threshold (default 20%) AND
    # the sample is large enough (default 10), future dedup hints are suppressed
    # for the rest of the session, saving the ~25-token hint injection overhead.
    hints_emitted: int = 0
    hints_ignored: int = 0
    # Per-kind counters for structured-file and index-only hints.  Independent of
    # hints_emitted so the hint_budget caps for each category are separate.
    structured_hints_emitted: int = 0
    index_only_hints_emitted: int = 0
    # Ring buffer of (normalized_path, emit_ts) for paths recently hinted.
    # Capped at 3 entries; used by post-read to detect ignored hints.
    # Serialized as list[list[str|float]] for JSON; parsed back to list[tuple[str, float]].
    recent_hints: list[tuple[str, float]] = field(default_factory=list)
    # Per-hint-category acceptance history for adaptive suppression (item 7).
    # Maps category name (e.g. "session_hint", "bash_dedup_hint") → list of bool
    # where True = accepted (agent did not re-read), False = ignored.
    # Capped at _HINT_CAT_HISTORY_MAX entries per category (FIFO).
    # Serialized as dict[str, list[int]] (0/1) in JSON for forward compatibility.
    hint_category_history: dict[str, list[bool]] = field(default_factory=dict)
    # Working directory at session start, used by git diff operations in the manifest.
    # Optional — may be None if the session was created before this field was added.
    cwd: str | None = None
    # Timestamp when the session was created, used for session age display in the manifest.
    # For new sessions, defaults to time.time(); for legacy sessions loaded via from_dict,
    # defaults to the current time if the field is missing.
    created_ts: float = field(default_factory=time.time)
    # Manifest delta-cache fields (item #19).  Populated by compact.build_manifest
    # so subsequent PreCompact calls within the same session can skip rebuilding when
    # nothing material has changed.  ``last_manifest_sha`` is the first 16 hex chars of
    # the SHA-256 of the last-emitted manifest text; empty string means "no prior emit".
    # ``last_manifest_ts`` is the epoch timestamp of that emit; 0.0 means not yet set.
    last_manifest_sha: str = ""
    last_manifest_ts: float = 0.0
    # Per-hint-type emission counters: tracks how many hints of each type
    # were emitted in this session. Maps hint type → count (e.g. "read_dedup" → 5).
    # Used to measure the effectiveness of configurable thresholds and dedup knobs.
    # Missing in older sessions → empty dict. Persisted via to_dict/from_dict.
    hints_emitted_by_type: dict[str, int] = field(default_factory=dict)
    # Per-hint-type suppression counters: tracks how many hints of each type
    # were suppressed (below a threshold or skipped). Maps hint type → count
    # (e.g. "bash_dedup_below_threshold" → 3). Distinguishes emitted vs suppressed
    # so operators can tune thresholds based on real session data.
    # Missing in older sessions → empty dict. Persisted via to_dict/from_dict.
    hints_suppressed_by_type: dict[str, int] = field(default_factory=dict)
    # Per-session image shrink budget tracking: maps absolute file path (str(path.resolve()))
    # → count of times shrink() was called on that path this session.  Used to detect
    # and warn when the same large image is shrunk repeatedly (e.g., a generated
    # screenshot appearing 50 times). When count > 3, logs a hint suggesting surgical
    # reads via token-goat read/section instead of repeated shrinking.
    # Missing in older sessions → empty dict. Persisted via to_dict/from_dict.
    image_shrink_count: dict[str, int] = field(default_factory=dict)
    # Per-session file access frequency tracking: maps normalized file path → total
    # number of Read/Grep/Glob accesses for that file this session.  Incremented
    # whenever mark_file_read() adds or updates a file entry.  Used by
    # build_high_frequency_hint() to nudge toward surgical reads when a file has
    # been accessed multiple times.  Missing in older sessions → empty dict.
    # Persisted via to_dict/from_dict.
    file_access_counts: dict[str, int] = field(default_factory=dict)
    # Per-session symbol access frequency tracking: maps "{normalized_file}::{symbol}"
    # → count of surgical (token-goat read) accesses for that symbol this session.
    # Incremented by mark_file_read() when called with a symbol argument.
    # Missing in older sessions → empty dict. Persisted via to_dict/from_dict.
    symbol_access_counts: dict[str, int] = field(default_factory=dict)
    # Per-session grep-target frequency tracking: maps normalized file path → total
    # number of Grep/rg invocations that targeted that specific existing file this
    # session.  Only concrete existing files are counted; glob patterns, directories,
    # and non-existent paths are excluded.  Incremented by record_grep_target();
    # used by maybe_grep_advisory() in hints.py to nudge toward `token-goat read`
    # or `bash-output --grep` after ≥3 grep patterns hit the same file.
    # Missing in older sessions → empty dict. Persisted via to_dict/from_dict.
    grep_target_counts: dict[str, int] = field(default_factory=dict)
    # User-pinned symbols: list of "<file>::<symbol>" spec strings.  Pinned symbols
    # always appear at the top of session hints and at the top of the compaction
    # manifest.  Capped at PINNED_SYMBOLS_MAX (20).  Stored as an ordered list
    # so insertion order is preserved for display.  Missing in older sessions → [].
    pinned_symbols: list[str] = field(default_factory=list)
    # Context growth tracking for threshold-crossing advisory in user_prompt_submit.
    # turns_since_last_compact: incremented each turn, reset on PreCompact.
    # loaded_skill_total_tokens: aggregate of body_bytes//4 across all skill_history entries;
    #   recomputed on each mark_skill_loaded to avoid double-counting repeat loads.
    # last_context_advisory_threshold: the highest threshold (50 or 70) that has already
    #   fired; None means no crossing advisory has been emitted yet this session.
    turns_since_last_compact: int = 0
    loaded_skill_total_tokens: int = 0
    last_context_advisory_threshold: int | None = None
    # Tokens estimated at the last PreCompact — subtracted in get_context_pressure
    # so the fill fraction measures only incremental load since the last compaction
    # rather than the lifetime total (which would permanently pin sessions to critical).
    pressure_baseline_tokens: int = 0
    # Measured tokens from tool responses (Read/Bash/WebFetch) since last compact; 0 → use proxy estimates.
    observed_tool_tokens: int = 0
    # Timestamp of the most recent PreCompact event for this session.  Set by
    # record_compact(); used by pre_read to suppress "already in context" hints
    # for files whose last read pre-dates the compact (their content is gone).
    # 0.0 = no compact has occurred this session.
    last_compact_ts: float = 0.0
    # pytest failure tracking: maps cmd_sha → sorted list of FAILED/ERROR test IDs
    # from the most recent run of that command. post_bash uses this to compute a
    # delta ("2 new failures, 1 fixed") and inject it as a systemMessage so the agent
    # sees the signal without re-reading the full output. Missing in older sessions → empty dict.
    pytest_failures: dict[str, list[str]] = field(default_factory=dict)
    # Monotonically-incrementing version counter for optimistic CAS in save().
    # Starts at 0 for a new session; each successful save() increments by 1.
    # When two concurrent processes both load version N, the second to save
    # detects version mismatch, merges its changes into the on-disk state,
    # and writes version N+2 (or N+1 if the first also wrote N+1 before the
    # merge).
    version: int = 0
    # Deferred recovery injection flag (item 2).  Set to True by the pre-read
    # hook after it injects the pending recovery sidecar.  Prevents the hook
    # from injecting the hint a second time if the session JSON is reloaded in
    # the same process.  Not persisted to disk — the sidecar file is the
    # durable source of truth; this flag is an in-process guard only.
    recovery_injected: bool = field(default=False, repr=False, compare=False)
    unavailable: bool = field(default=False, repr=False, compare=False)
    # Internal: cached JSON string from last serialization — invalidated by any mutation.
    # Avoids O(N) re-serialization of files/greps dicts on every hook invocation when
    # the cache is loaded, mutated once, and immediately saved.  Not persisted to disk.
    _json_cache: str | None = field(default=None, repr=False, compare=False)
    # Disk-state fingerprint recorded by load() so save() can skip the CAS
    # from_dict round-trip when no concurrent writer has changed the file.
    # Both fields are 0 for freshly-created (unsaved) caches.  Not persisted.
    # mtime is stored in integer nanoseconds (st_mtime_ns) — the float st_mtime
    # rounds at ~0.5us near the epoch and aliased under sub-microsecond writes.
    _disk_mtime_ns: int = field(default=0, repr=False, compare=False)
    _disk_size: int = field(default=0, repr=False, compare=False)
    # Dirty flag set by mark_hint_seen() to defer its save() until the next
    # post-read/post-bash/post-edit save() picks it up.  Not persisted.
    _pending_hint_save: bool = field(default=False, repr=False, compare=False)
    # Sorted-list cache for bash_dedup_emitted_ids.  Avoids repeated sorted()
    # calls in to_dict() when the set has not changed.  Invalidated by
    # _invalidate_json_cache() on any mutation.  Not persisted.
    _bash_dedup_sorted_cache: list[str] | None = field(default=None, repr=False, compare=False)
    # Per-file hint cooldown: tracks normalized file paths for which a
    # ``tokens_saved > 0`` session hint has already been emitted this session.
    # When a file is in this set AND has not been edited since the hint was
    # injected, further identical-kind hints for that file are suppressed and
    # recorded as ``session_hint_suppressed`` stats instead of being injected
    # again.  The set is cleared for a specific file by mark_file_edited().
    # Not persisted to disk — a per-process-invocation guard only; losing it
    # on process restart causes at most one extra hint injection, which is
    # acceptable.
    _session_hinted_files: set[str] = field(default_factory=set, repr=False, compare=False)

    def to_dict(self) -> _SessionDict:
        """Serialize to dict for JSON."""
        return _SessionDict(
            schema_version=SESSION_SCHEMA_VERSION,
            created_by="token-goat",
            session_id=self.session_id,
            started_ts=_round_ts(self.started_ts),
            last_activity_ts=_round_ts(self.last_activity_ts),
            created_ts=_round_ts(self.created_ts),
            files={k: _serialize_file_entry(v) for k, v in self.files.items()},
            greps=[_serialize_grep_entry(g) for g in self.greps],
            grep_result_hashes=dict(self.grep_result_hashes),
            edited_files=self.edited_files,
            result_cache={
                k: _serialize_result_cache_entry(v)
                for k, v in self.result_cache.items()
            },
            bash_history={
                k: _serialize_bash_entry(v)
                for k, v in self.bash_history.items()
            },
            glob_history=[_serialize_glob_entry(g) for g in self.glob_history],
            web_history={
                k: _serialize_web_entry(v)
                for k, v in self.web_history.items()
            },
            skill_history={
                k: _serialize_skill_entry(v)
                for k, v in self.skill_history.items()
            },
            decisions=[_serialize_decision_entry(d) for d in self.decisions],
            snapshot_shas=dict(self.snapshot_shas),
            hints_seen=self._get_hints_seen_sorted(),
            hints_content_dedup={
                k: [v, c]
                for k, (v, c) in self.hints_content_dedup.items()
            },
            bash_dedup_emitted_ids=self._get_bash_dedup_sorted(),
            stored_task_outputs=dict(self.stored_task_outputs),
            hints_emitted=self.hints_emitted,
            hints_ignored=self.hints_ignored,
            structured_hints_emitted=self.structured_hints_emitted,
            index_only_hints_emitted=self.index_only_hints_emitted,
            hints_emitted_by_type=self.hints_emitted_by_type,
            hints_suppressed_by_type=self.hints_suppressed_by_type,
            recent_hints=[[p, t] for p, t in self.recent_hints],
            last_manifest_sha=self.last_manifest_sha,
            last_manifest_ts=self.last_manifest_ts,
            version=self.version,
            hint_category_history={k: [1 if v else 0 for v in lst] for k, lst in self.hint_category_history.items()},
            image_shrink_count=self.image_shrink_count,
            file_access_counts=self.file_access_counts,
            symbol_access_counts=self.symbol_access_counts,
            pinned_symbols=list(self.pinned_symbols),
            cwd=self.cwd,
            turns_since_last_compact=self.turns_since_last_compact,
            loaded_skill_total_tokens=self.loaded_skill_total_tokens,
            last_context_advisory_threshold=self.last_context_advisory_threshold,
            pressure_baseline_tokens=self.pressure_baseline_tokens,
            observed_tool_tokens=self.observed_tool_tokens,
            last_compact_ts=self.last_compact_ts,
            file_content_seen=dict(self.file_content_seen),
            pytest_failures=dict(self.pytest_failures),
            mcp_result_hashes=dict(self.mcp_result_hashes),
            grep_target_counts=dict(self.grep_target_counts),
            read_content_hashes=dict(self.read_content_hashes),
            log_file_cache=dict(self.log_file_cache),
            dir_listing_cache=dict(self.dir_listing_cache),
            cmd_output_hashes=dict(self.cmd_output_hashes),
        )

    def to_json(self) -> str:
        """Return a JSON string for this cache, using a cached result when available.

        The ``_json_cache`` is set here and cleared by ``_invalidate_json_cache()``
        on every mutation.  This avoids re-serializing O(N) files/greps dicts on
        each ``save()`` call when a hook loads → mutates once → saves.
        """
        if self._json_cache is None:
            self._json_cache = json.dumps(self.to_dict(), ensure_ascii=False)
        return self._json_cache

    def _invalidate_json_cache(self) -> None:
        """Invalidate the serialization cache after any mutation."""
        self._json_cache = None
        self._bash_dedup_sorted_cache = None

    def _get_hints_seen_sorted(self) -> dict[str, int]:
        """Return hints_seen dict for serialization to JSON.

        Note: hints_seen is now a dict[str, int], not a set[str].  Serialized
        directly (dict is JSON-serializable); no sorting needed anymore.
        """
        return self.hints_seen

    def _get_bash_dedup_sorted(self) -> list[str]:
        """Return a cached sorted list of bash_dedup_emitted_ids, recomputing only on invalidation."""
        if self._bash_dedup_sorted_cache is None:
            self._bash_dedup_sorted_cache = sorted(self.bash_dedup_emitted_ids)
        return self._bash_dedup_sorted_cache

    def is_bash_history_empty(self) -> bool:
        """Return True if bash_history is empty or not available."""
        return not self.bash_history

    def is_web_history_empty(self) -> bool:
        """Return True if web_history is empty or not available."""
        return not self.web_history

    def is_greps_empty(self) -> bool:
        """Return True if greps is empty or not available."""
        return not self.greps

    def is_glob_history_empty(self) -> bool:
        """Return True if glob_history is empty or not available."""
        return not self.glob_history

    def is_skill_history_empty(self) -> bool:
        """Return True if skill_history is empty or not available."""
        return not self.skill_history

    def has_hint_fingerprint(self, fingerprint: str) -> bool:
        """Check if a hint fingerprint was already seen this session.

        Returns True if the fingerprint is in hints_seen, False otherwise.
        Note: this checks for presence only; use hints_seen[fingerprint] to
        get the count (how many times it has been emitted).
        """
        return fingerprint in self.hints_seen

    def mark_hint_seen(self, fingerprint: str) -> None:
        """Record a hint fingerprint as seen this session.

        Increments the count for this fingerprint (or sets it to 1 if new).
        Defers the disk write: sets ``_pending_hint_save = True`` instead of
        calling ``save()`` inline.  The pending write is flushed by
        ``_flush_pending_hint_save(cache)`` in ``hooks_read.py``, which is
        called at every early-return path and at the end of each handler that
        may emit a hint without a subsequent ``save()`` call (e.g. Glob dedup,
        pre-read hint-only paths).

        If the hint fires in pre-read but the process exits before any
        post-read save (harness crash, tool denied), the count is lost
        and the same hint re-fires on the next invocation — a benign
        false-positive, not data loss.
        """
        # Increment count (or initialize to 1)
        current_count = self.hints_seen.get(fingerprint, 0)
        self.hints_seen[fingerprint] = current_count + 1
        # Enforce HINTS_SEEN_MAX via LRU eviction.
        # When the dict exceeds the cap, keep entries with the highest seen counts
        # (most relevant for dedup) and discard the lowest-count (least recent/important).
        # False-positive re-emission of a suppressed hint is acceptable;
        # unbounded growth is not.
        if len(self.hints_seen) > HINTS_SEEN_MAX:
            sorted_hints = sorted(self.hints_seen.items(), key=itemgetter(1), reverse=True)
            self.hints_seen = dict(sorted_hints[:HINTS_SEEN_MAX])
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()
        self._pending_hint_save = True

    def has_hint_content_hash(self, content_hash: str) -> bool:
        """Check if a hint content hash was already seen this session.

        Returns True if the content_hash is in hints_content_dedup, False otherwise.
        Use get_hint_content_summary() to retrieve the cached summary text.
        """
        return content_hash in self.hints_content_dedup

    def get_hint_content_summary(self, content_hash: str) -> str | None:
        """Retrieve the cached summary text for a content hash, or None if not seen.

        The summary is the first ~50 chars of the original hint text, used to
        construct a "Same as previously shown hint for <summary>" stub on repeat.
        """
        if content_hash in self.hints_content_dedup:
            summary, _count = self.hints_content_dedup[content_hash]
            return summary
        return None

    def record_hint_content_seen(self, content_hash: str, summary: str) -> None:
        """Record a hint's content hash and first ~50 chars of text for dedup compression.

        Called when a hint is emitted; on next occurrence of the same content hash,
        a stub "Same as previously shown hint for <summary>" is emitted instead.

        Increments the count for this content_hash (or sets it to 1 if new).
        Enforces HINTS_CONTENT_DEDUP_MAX via FIFO eviction when the cap is exceeded.
        """
        if content_hash in self.hints_content_dedup:
            summary_text, count = self.hints_content_dedup[content_hash]
            self.hints_content_dedup[content_hash] = (summary_text, count + 1)
        else:
            self.hints_content_dedup[content_hash] = (summary, 1)

        # Enforce HINTS_CONTENT_DEDUP_MAX via FIFO eviction.
        # Insertion order is preserved in Python 3.7+ dicts; evict oldest when over cap.
        if len(self.hints_content_dedup) > HINTS_CONTENT_DEDUP_MAX:
            items_to_remove = len(self.hints_content_dedup) - (HINTS_CONTENT_DEDUP_MAX - _HINTS_CONTENT_DEDUP_EVICT)
            for _ in range(items_to_remove):
                self.hints_content_dedup.pop(next(iter(self.hints_content_dedup)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()
        self._pending_hint_save = True

    def record_hint_emitted(self, hint_type: str) -> None:
        """Increment the emission counter for a specific hint type."""
        current = self.hints_emitted_by_type.get(hint_type, 0)
        self.hints_emitted_by_type[hint_type] = current + 1
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()
        self._pending_hint_save = True

    def record_hint_suppressed(self, hint_type: str) -> None:
        """Increment the suppression counter for a specific hint type."""
        current = self.hints_suppressed_by_type.get(hint_type, 0)
        self.hints_suppressed_by_type[hint_type] = current + 1
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()
        self._pending_hint_save = True

    # ------------------------------------------------------------------
    # Per-file hint cooldown helpers
    # ------------------------------------------------------------------

    def has_session_hint_been_emitted(self, file_key: str) -> bool:
        """Return True when a tokens_saved>0 session hint was already emitted for *file_key*.

        Called in pre-read before building a session hint to avoid injecting
        the same hint twice for a file that hasn't changed since the last hint.

        *file_key* must be the normalised path (output of ``_normalize_path``).
        """
        return file_key in self._session_hinted_files

    def mark_session_hint_emitted(self, file_key: str) -> None:
        """Record that a tokens_saved>0 session hint was emitted for *file_key*.

        After this call, :meth:`has_session_hint_been_emitted` returns True for
        *file_key* until the file is edited (which calls
        :meth:`clear_session_hint_cooldown`).

        *file_key* must be the normalised path (output of ``_normalize_path``).
        """
        self._session_hinted_files.add(file_key)

    def clear_session_hint_cooldown(self, file_key: str) -> None:
        """Remove *file_key* from the per-file hint cooldown set.

        Called by :func:`mark_file_edited` so that the next Read after an edit
        is eligible to receive a fresh session hint (the hint content changes
        when the file changes).

        *file_key* must be the normalised path (output of ``_normalize_path``).
        """
        self._session_hinted_files.discard(file_key)

    def get_file_access_count(self, file_path: str) -> int:
        """Return the number of times *file_path* has been accessed this session.

        Uses the normalized path key so callers can pass either the raw path
        (as returned by the Read tool) or the already-normalized form.  Returns
        0 when the file has never been accessed or when the session is unavailable.
        """
        key = paths.normalize_key(file_path)
        return self.file_access_counts.get(key, 0)

    def record_grep_target(self, file_path: str, cwd: str | None = None) -> bool:
        """Increment the grep-target count for *file_path* and return True on the 3rd hit.

        Normalizes *file_path* to a canonical absolute path key via
        :func:`~token_goat.paths.normalize_path_key` so that relative and
        absolute forms of the same file (e.g. ``./scripts/ads.js`` and
        ``C:/Projects/.../scripts/ads.js``) are deduplicated into the same
        counter bucket.  Pass *cwd* when available so relative paths can be
        resolved to absolute before keying.

        Returns ``True`` exactly when the count transitions from 2 → 3 (the
        one-shot advisory threshold); returns ``False`` on all other calls so
        the caller can emit the hint only once per file per session.

        No-ops (returns ``False``) when the session is unavailable.
        """
        if self.unavailable:
            return False
        key = paths.normalize_path_key(file_path, cwd)
        new_count = self.grep_target_counts.get(key, 0) + 1
        self.grep_target_counts[key] = new_count
        self._invalidate_json_cache()
        return new_count == 3

    def has_grep_result_hash(self, result_hash: str) -> bool:
        """Check if a grep result content hash was already seen this session.

        Returns True if the result_hash is in grep_result_hashes, False otherwise.
        Use get_grep_result_pattern() to retrieve the pattern that produced it.
        """
        return result_hash in self.grep_result_hashes

    def get_grep_result_pattern(self, result_hash: str) -> str | None:
        """Retrieve the pattern that produced a grep result content hash, or None.

        Returns the grep pattern that previously generated result content with
        this hash, for use in a "Same results as pattern X" dedup hint.
        """
        return self.grep_result_hashes.get(result_hash)

    def record_grep_result_hash(self, result_hash: str, pattern: str) -> None:
        """Record a grep result's content hash and the pattern that produced it.

        Called after grep executes; on next occurrence of the same result content,
        a "Same results as pattern X" dedup hint can be emitted.

        Stores the result_hash → pattern mapping. Enforces GREP_RESULT_HASHES_MAX
        via FIFO eviction when the cap is exceeded.
        """
        self.grep_result_hashes[result_hash] = pattern

        # Enforce GREP_RESULT_HASHES_MAX via FIFO eviction.
        # Insertion order is preserved in Python 3.7+ dicts; evict oldest when over cap.
        if len(self.grep_result_hashes) > GREP_RESULT_HASHES_MAX:
            items_to_remove = len(self.grep_result_hashes) - (GREP_RESULT_HASHES_MAX - _GREP_RESULT_HASHES_EVICT)
            for _ in range(items_to_remove):
                self.grep_result_hashes.pop(next(iter(self.grep_result_hashes)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def record_read_hash(self, path: str, content_hash: str) -> None:
        """Record the SHA256 content hash of a whole-file Read for cross-tool dedup.

        Called in post_read after a successful non-windowed Read.  A subsequent
        `cat FILE` bash command whose stdout produces the same hash will be
        suppressed with a dedup note in post_bash.

        Enforces READ_CONTENT_HASHES_MAX via FIFO eviction.
        """
        self.read_content_hashes[path] = content_hash
        if len(self.read_content_hashes) > READ_CONTENT_HASHES_MAX:
            items_to_remove = len(self.read_content_hashes) - (READ_CONTENT_HASHES_MAX - _READ_CONTENT_HASHES_EVICT)
            for _ in range(items_to_remove):
                self.read_content_hashes.pop(next(iter(self.read_content_hashes)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def get_read_hash(self, path: str) -> str | None:
        """Return the stored SHA256 hash for *path*, or None if not recorded.

        *path* must already be normalized (resolve + forward-slashes).
        """
        return self.read_content_hashes.get(path)

    @staticmethod
    def _log_cache_key(path: str, size: int, mtime: float) -> str:
        """Build the compound cache key for a log-file entry."""
        return f"{path}:{size}:{mtime:.9f}"

    def record_log_read(self, path: str, size: int, mtime: float, content_hash: str) -> None:
        """Record a log-file read keyed on (path, size, mtime) → content_hash.

        Called after a successful read of a log-like file.  A subsequent read
        that produces the same (path, size, mtime) triple will match this entry;
        post_bash can then suppress the duplicate output.

        Enforces LOG_FILE_CACHE_MAX via FIFO eviction.
        """
        key = self._log_cache_key(path, size, mtime)
        self.log_file_cache[key] = content_hash
        if len(self.log_file_cache) > LOG_FILE_CACHE_MAX:
            items_to_remove = len(self.log_file_cache) - (LOG_FILE_CACHE_MAX - _LOG_FILE_CACHE_EVICT)
            for _ in range(items_to_remove):
                self.log_file_cache.pop(next(iter(self.log_file_cache)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def get_log_cache_hit(self, path: str, size: int, mtime: float) -> str | None:
        """Return the stored content hash if (path, size, mtime) is cached, else None.

        A non-None return means the file has the same size and modification time
        as when it was last read — content is almost certainly unchanged.
        *path* must already be normalized (resolve + forward-slashes).
        """
        key = self._log_cache_key(path, size, mtime)
        return self.log_file_cache.get(key)

    def get_dir_listing_hit(self, key: str) -> str | None:
        """Return the stored output hash for *key* if cached, else None.

        *key* must be ``"{norm_dir_path}:{cmd_fingerprint}"`` as built by the
        post_bash dir-listing cache block.
        """
        return self.dir_listing_cache.get(key)

    def record_dir_listing(self, key: str, output_hash: str) -> None:
        """Record a dir-listing output hash for *key*.

        *key* should be ``"{norm_dir_path}:{cmd_fingerprint}"`` where
        *cmd_fingerprint* is a 16-hex-char hash of the full command string so
        commands with different flags produce different keys.
        Enforces DIR_LISTING_CACHE_MAX via FIFO eviction.
        """
        self.dir_listing_cache[key] = output_hash
        if len(self.dir_listing_cache) > DIR_LISTING_CACHE_MAX:
            items_to_remove = len(self.dir_listing_cache) - (DIR_LISTING_CACHE_MAX - _DIR_LISTING_CACHE_EVICT)
            for _ in range(items_to_remove):
                self.dir_listing_cache.pop(next(iter(self.dir_listing_cache)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def lookup_mcp_output_id(self, tool_input_hash: str) -> str | None:
        """Return the cached output_id for an MCP tool call hash, or None."""
        return self.mcp_result_hashes.get(tool_input_hash)

    def record_mcp_result(self, tool_input_hash: str, output_id: str) -> None:
        """Record a (tool_name+input) hash → output_id mapping for MCP dedup.

        FIFO-evicted at MCP_RESULT_HASHES_MAX when the cap is exceeded.
        """
        self.mcp_result_hashes[tool_input_hash] = output_id
        if len(self.mcp_result_hashes) > MCP_RESULT_HASHES_MAX:
            items_to_remove = len(self.mcp_result_hashes) - (MCP_RESULT_HASHES_MAX - _MCP_RESULT_HASHES_EVICT)
            for _ in range(items_to_remove):
                self.mcp_result_hashes.pop(next(iter(self.mcp_result_hashes)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def clear_mcp_result_hashes(self) -> int:
        """Wipe all MCP read result hashes; returns the number of entries cleared."""
        count = len(self.mcp_result_hashes)
        if count:
            self.mcp_result_hashes.clear()
            self.last_activity_ts = time.time()
            self._invalidate_json_cache()
        return count

    # ------------------------------------------------------------------
    # Cross-file content dedup helpers
    # ------------------------------------------------------------------

    def get_file_content_path(self, sha16: str) -> str | None:
        """Return the first normalized path seen with this content SHA, or None."""
        return self.file_content_seen.get(sha16)

    def register_file_content(self, sha16: str, norm_path: str) -> None:
        """Record sha16 → norm_path if not already present.

        First-seen wins: does not overwrite an existing entry.  Enforces
        FILE_CONTENT_SEEN_MAX via FIFO eviction.
        """
        if sha16 in self.file_content_seen:
            return
        self.file_content_seen[sha16] = norm_path
        if len(self.file_content_seen) > FILE_CONTENT_SEEN_MAX:
            evict = len(self.file_content_seen) - (FILE_CONTENT_SEEN_MAX - _FILE_CONTENT_SEEN_EVICT)
            for _ in range(evict):
                self.file_content_seen.pop(next(iter(self.file_content_seen)))
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    # ------------------------------------------------------------------
    # Pinned-symbol helpers
    # ------------------------------------------------------------------

    def add_pinned(self, spec: str) -> None:
        """Add *spec* (``"<file>::<symbol>"``) to the pinned-symbols list.

        No-ops when *spec* is already pinned.  Raises ``ValueError`` when the
        pinned list is at :data:`PINNED_SYMBOLS_MAX` (20 entries).
        """
        if spec in self.pinned_symbols:
            return
        if len(self.pinned_symbols) >= PINNED_SYMBOLS_MAX:
            raise ValueError(
                f"pinned-symbol limit reached ({PINNED_SYMBOLS_MAX}); "
                "remove an entry with `token-goat pinned remove` first"
            )
        self.pinned_symbols.append(spec)
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()

    def remove_pinned(self, spec: str) -> bool:
        """Remove *spec* from the pinned-symbols list.

        Returns True when the spec was present and removed, False when it was
        not in the list (idempotent — no error on missing spec).
        """
        if spec not in self.pinned_symbols:
            return False
        self.pinned_symbols.remove(spec)
        self.last_activity_ts = time.time()
        self._invalidate_json_cache()
        return True

    def list_pinned(self) -> list[str]:
        """Return the current list of pinned specs (insertion-ordered copy)."""
        return list(self.pinned_symbols)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SessionCache:
        """Deserialize from dict (JSON). Tolerates missing or corrupted fields."""
        now = time.time()

        schema_v = d.get("schema_version", 0)
        try:
            schema_v_int = int(schema_v) if schema_v else 0
        except (TypeError, ValueError):
            schema_v_int = 0
        if schema_v_int > SESSION_SCHEMA_VERSION:
            _LOG.warning(
                "session schema_version %s > current %s; some fields may be ignored",
                sanitize_log_str(str(schema_v), max_len=_MAX_LOG_STR),
                SESSION_SCHEMA_VERSION,
            )

        session_id = d.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError(f"session_id missing or invalid: {session_id!r}")

        files: dict[str, FileEntry] = {}
        skipped_file_entries = 0
        for k, v in d.get("files", {}).items():
            if not isinstance(v, dict):
                skipped_file_entries += 1
                continue
            entry = _parse_file_entry(k, v, now)
            if entry is None:
                skipped_file_entries += 1
            else:
                files[k] = entry

        greps: list[GrepEntry] = []
        skipped_grep_entries = 0
        for g in d.get("greps", []):
            if not isinstance(g, dict):
                skipped_grep_entries += 1
                continue
            grep_entry = _parse_grep_entry(g)
            if grep_entry is None:
                skipped_grep_entries += 1
            else:
                greps.append(grep_entry)

        if skipped_file_entries > 0 or skipped_grep_entries > 0:
            _LOG.info(
                "session cache: recovered with %d corrupted file entries, %d corrupted grep entries",
                skipped_file_entries,
                skipped_grep_entries,
            )

        # grep_result_hashes: dict[str, str] — content_hash → pattern.
        # Missing in older sessions → empty dict (backward compat). Malformed entries are skipped.
        raw_grep_hashes = d.get("grep_result_hashes", {})
        grep_result_hashes: dict[str, str] = {k: v for k, v in raw_grep_hashes.items() if isinstance(k, str) and isinstance(v, str) and k and v} if isinstance(raw_grep_hashes, dict) else {}

        # mcp_result_hashes: dict[str, str] — tool_input_hash → output_id.
        # Missing in older sessions → empty dict (backward compat). Malformed entries are skipped.
        raw_mcp_hashes = d.get("mcp_result_hashes", {})
        mcp_result_hashes: dict[str, str] = {k: v for k, v in raw_mcp_hashes.items() if isinstance(k, str) and isinstance(v, str) and k and v} if isinstance(raw_mcp_hashes, dict) else {}

        # file_content_seen: dict[str, str] — sha16 → first path seen with that content.
        # Missing in older sessions → empty dict (backward compat).
        raw_fcs = d.get("file_content_seen", {})
        file_content_seen: dict[str, str] = {k: v for k, v in raw_fcs.items() if isinstance(k, str) and isinstance(v, str) and k and v} if isinstance(raw_fcs, dict) else {}

        edited_files: dict[str, int] = {}
        for k, v in d.get("edited_files", {}).items():
            with contextlib.suppress(TypeError, ValueError):
                edited_files[k] = max(0, int(v))

        result_cache: dict[str, ResultCacheEntry] = {}
        for k, v in d.get("result_cache", {}).items():
            if not isinstance(v, dict) or not isinstance(k, str):
                continue
            rc_entry = _parse_result_cache_entry(v)
            if rc_entry is not None:
                result_cache[k] = rc_entry

        bash_history: dict[str, BashEntry] = {}
        for k, v in d.get("bash_history", {}).items():
            if not isinstance(v, dict) or not isinstance(k, str):
                continue
            be_entry = _parse_bash_entry(v)
            if be_entry is not None:
                bash_history[k] = be_entry

        glob_history: list[GlobEntry] = []
        for g in d.get("glob_history", []):
            if not isinstance(g, dict):
                continue
            glob_entry = _parse_glob_entry(g)
            if glob_entry is not None:
                glob_history.append(glob_entry)

        web_history: dict[str, WebEntry] = {}
        for k, v in d.get("web_history", {}).items():
            if not isinstance(v, dict) or not isinstance(k, str):
                continue
            we_entry = _parse_web_entry(v)
            if we_entry is not None:
                web_history[k] = we_entry

        skill_history: dict[str, SkillEntry] = {}
        for k, v in d.get("skill_history", {}).items():
            if not isinstance(v, dict) or not isinstance(k, str):
                continue
            sk_entry = _parse_skill_entry(v)
            if sk_entry is not None:
                skill_history[k] = sk_entry

        # decisions: list[DecisionEntry] — missing in older session JSON → empty.
        # Each malformed entry is dropped silently so a partially-upgraded file
        # never crashes the load path.
        decisions: list[DecisionEntry] = []
        raw_decisions = d.get("decisions", [])
        if isinstance(raw_decisions, list):
            for de_raw in raw_decisions:
                if not isinstance(de_raw, dict):
                    continue
                de_entry = _parse_decision_entry(de_raw)
                if de_entry is not None:
                    decisions.append(de_entry)
            # Defensive trim: a manually-edited cache could exceed the cap, so
            # we keep the newest DECISION_HISTORY_MAX entries (list is append-only,
            # newest-last per the contract).
            if len(decisions) > DECISION_HISTORY_MAX:
                decisions = decisions[-DECISION_HISTORY_MAX:]

        # snapshot_shas: dict[str, str] — coerce values defensively so a
        # malformed entry written by a future version (e.g. structured object)
        # is dropped silently rather than poisoning the lookup path.
        raw_snaps = d.get("snapshot_shas", {})
        snapshot_shas: dict[str, str] = {k: v for k, v in raw_snaps.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(raw_snaps, dict) else {}

        # hints_seen: dict[str, int] (persisted) → dict[str, int] (in-memory).
        # New format after verbose-suppression feature; backwards-compat with
        # old list[str] format (treat missing counts as 1).
        hints_seen: dict[str, int] = {}
        raw_hints = d.get("hints_seen", {})
        if isinstance(raw_hints, dict):
            # New format: dict[str, int]
            for h, count in raw_hints.items():
                if isinstance(h, str) and h:
                    try:
                        hints_seen[h] = max(1, int(count)) if count else 1
                    except (TypeError, ValueError):
                        hints_seen[h] = 1
        elif isinstance(raw_hints, list):
            # Legacy format: list[str] — treat each as count=1
            for h in raw_hints:
                if isinstance(h, str) and h:
                    hints_seen[h] = 1

        # hints_content_dedup: dict[str, [summary, count]] (persisted) → dict[str, tuple[str, int]] (in-memory).
        # Maps content_hash (first 8 hex chars) → (summary_text, count).
        # Missing in older sessions → empty dict (backward compat). Malformed entries are skipped.
        hints_content_dedup: dict[str, tuple[str, int]] = {}
        raw_content_dedup = d.get("hints_content_dedup", {})
        if isinstance(raw_content_dedup, dict):
            for hash_key, val in raw_content_dedup.items():
                if isinstance(hash_key, str) and isinstance(val, (list, tuple)) and len(val) == 2:
                    summary, count = val
                    if isinstance(summary, str) and isinstance(count, int):
                        hints_content_dedup[hash_key] = (summary, max(1, count))

        # bash_dedup_emitted_ids: list[str] (persisted) → set[str] (in-memory).
        # Missing in older sessions → empty set (no ids were tracked).
        bash_dedup_emitted_ids: set[str] = set()
        raw_dedup = d.get("bash_dedup_emitted_ids", [])
        if isinstance(raw_dedup, list):
            for oid in raw_dedup:
                if isinstance(oid, str) and oid:
                    bash_dedup_emitted_ids.add(oid)

        # stored_task_outputs: dict[str, str] (persisted) → dict[str, str] (in-memory).
        # Missing in older sessions (or stored as legacy list) → empty dict.
        stored_task_outputs: dict[str, str] = {}
        raw_task_outputs = d.get("stored_task_outputs", {})
        if isinstance(raw_task_outputs, dict):
            for tid, oid in raw_task_outputs.items():
                if isinstance(tid, str) and tid and isinstance(oid, str) and oid:
                    stored_task_outputs[tid] = oid

        # hints_emitted / hints_ignored: int counters, default 0 for older sessions.
        hints_emitted = _coerce_nonneg_int(d.get("hints_emitted", 0))
        hints_ignored = _coerce_nonneg_int(d.get("hints_ignored", 0))
        # Per-kind hint counters for budget enforcement (new fields, default 0 for older sessions).
        structured_hints_emitted = _coerce_nonneg_int(d.get("structured_hints_emitted", 0))
        index_only_hints_emitted = _coerce_nonneg_int(d.get("index_only_hints_emitted", 0))

        # hints_emitted_by_type / hints_suppressed_by_type: dict[str, int] maps hint type → count.
        # Missing in older sessions → empty dict (backward compat). Malformed entries are skipped.
        hints_emitted_by_type: dict[str, int] = {}
        raw_emitted_by_type = d.get("hints_emitted_by_type", {})
        if isinstance(raw_emitted_by_type, dict):
            for hint_type, count in raw_emitted_by_type.items():
                if isinstance(hint_type, str) and hint_type:
                    with contextlib.suppress(TypeError, ValueError):
                        hints_emitted_by_type[hint_type] = max(0, int(count))

        hints_suppressed_by_type: dict[str, int] = {}
        raw_suppressed_by_type = d.get("hints_suppressed_by_type", {})
        if isinstance(raw_suppressed_by_type, dict):
            for hint_type, count in raw_suppressed_by_type.items():
                if isinstance(hint_type, str) and hint_type:
                    with contextlib.suppress(TypeError, ValueError):
                        hints_suppressed_by_type[hint_type] = max(0, int(count))

        # recent_hints: list[[path, ts]], stored as list[list[str|float]] for JSON.
        # Cap to 3 entries for safety; drop malformed entries silently.
        recent_hints: list[tuple[str, float]] = []
        raw_recent = d.get("recent_hints", [])
        if isinstance(raw_recent, list):
            for item in raw_recent:
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    p, t = item
                    if isinstance(p, str) and isinstance(t, (int, float)):
                        recent_hints.append((p, float(t)))
            recent_hints = recent_hints[-3:]  # cap at 3

        # hint_category_history: dict[str, list[int]] (0/1) on disk → dict[str, list[bool]] in memory.
        hint_category_history: dict[str, list[bool]] = {}
        raw_cat_hist = d.get("hint_category_history", {})
        if isinstance(raw_cat_hist, dict):
            for cat_key, cat_vals in raw_cat_hist.items():
                if not isinstance(cat_key, str) or not isinstance(cat_vals, list):
                    continue
                bools: list[bool] = [bool(v) for v in cat_vals if isinstance(v, (int, bool))]
                if bools:
                    hint_category_history[cat_key] = bools[-_HINT_CAT_HISTORY_MAX:]

        # image_shrink_count: dict[str, int] — per-image shrink budget tracking.
        # Maps absolute path (str(path.resolve())) → shrink count this session.
        # Missing in older sessions → empty dict (backward compat). Malformed entries are skipped.
        image_shrink_count: dict[str, int] = {}
        raw_shrink_count = d.get("image_shrink_count", {})
        if isinstance(raw_shrink_count, dict):
            for img_path, count in raw_shrink_count.items():
                if isinstance(img_path, str) and img_path:
                    with contextlib.suppress(TypeError, ValueError):
                        image_shrink_count[img_path] = max(0, int(count))

        # file_access_counts: dict[str, int] — per-file Read access frequency this session.
        # Maps normalized path → access count. Missing in older sessions → empty dict.
        file_access_counts: dict[str, int] = {}
        raw_file_access = d.get("file_access_counts", {})
        if isinstance(raw_file_access, dict):
            for fpath, count in raw_file_access.items():
                if isinstance(fpath, str) and fpath:
                    with contextlib.suppress(TypeError, ValueError):
                        file_access_counts[fpath] = max(0, int(count))

        # symbol_access_counts: dict[str, int] — per-symbol surgical access frequency this session.
        # Maps "{normalized_file}::{symbol}" → access count. Missing in older sessions → empty dict.
        symbol_access_counts: dict[str, int] = {}
        raw_sym_access = d.get("symbol_access_counts", {})
        if isinstance(raw_sym_access, dict):
            for sym_key, count in raw_sym_access.items():
                if isinstance(sym_key, str) and sym_key:
                    with contextlib.suppress(TypeError, ValueError):
                        symbol_access_counts[sym_key] = max(0, int(count))

        # grep_target_counts: dict[str, int] — per-file grep-target frequency this session.
        # Maps normalized file path → grep invocation count. Missing in older sessions → empty dict.
        grep_target_counts: dict[str, int] = {}
        raw_gtc = d.get("grep_target_counts", {})
        if isinstance(raw_gtc, dict):
            for gtc_path, count in raw_gtc.items():
                if isinstance(gtc_path, str) and gtc_path:
                    with contextlib.suppress(TypeError, ValueError):
                        grep_target_counts[gtc_path] = max(0, int(count))

        # pinned_symbols: list[str] — user-pinned "<file>::<symbol>" specs.
        # Missing in older sessions → [] (backward compat). Malformed entries dropped.
        pinned_symbols: list[str] = []
        raw_pinned = d.get("pinned_symbols", [])
        if isinstance(raw_pinned, list):
            for spec in raw_pinned:
                if isinstance(spec, str) and spec and "::" in spec:
                    pinned_symbols.append(spec)
            # Defensive trim — manually-edited caches could exceed the cap.
            pinned_symbols = pinned_symbols[:PINNED_SYMBOLS_MAX]

        # Context growth tracking fields — missing in older sessions → defaults.
        _raw_tslc = d.get("turns_since_last_compact", 0)
        turns_since_last_compact: int = max(0, int(_raw_tslc)) if isinstance(_raw_tslc, (int, float)) else 0
        _raw_lstt = d.get("loaded_skill_total_tokens", 0)
        loaded_skill_total_tokens: int = max(0, int(_raw_lstt)) if isinstance(_raw_lstt, (int, float)) else 0
        _raw_lcat = d.get("last_context_advisory_threshold")
        last_context_advisory_threshold: int | None = _raw_lcat if _raw_lcat in (50, 70) else None
        _raw_pbt = d.get("pressure_baseline_tokens", 0)
        pressure_baseline_tokens: int = max(0, int(_raw_pbt)) if isinstance(_raw_pbt, (int, float)) else 0
        _raw_ott = d.get("observed_tool_tokens", 0)
        observed_tool_tokens: int = max(0, int(_raw_ott)) if isinstance(_raw_ott, (int, float)) else 0
        _raw_lcts = d.get("last_compact_ts", 0.0)
        last_compact_ts: float = float(_raw_lcts) if isinstance(_raw_lcts, (int, float)) else 0.0

        # pytest_failures: dict[str, list[str]] — maps cmd_sha → sorted failure IDs.
        pytest_failures: dict[str, list[str]] = {}
        raw_pf = d.get("pytest_failures", {})
        if isinstance(raw_pf, dict):
            for _pf_k, _pf_v in raw_pf.items():
                if isinstance(_pf_k, str) and isinstance(_pf_v, list):
                    pytest_failures[_pf_k] = [s for s in _pf_v if isinstance(s, str)]

        # read_content_hashes: dict[str, str] — missing in older sessions → empty dict.
        read_content_hashes: dict[str, str] = {}
        raw_rch = d.get("read_content_hashes", {})
        if isinstance(raw_rch, dict):
            for _rch_k, _rch_v in raw_rch.items():
                if isinstance(_rch_k, str) and isinstance(_rch_v, str):
                    read_content_hashes[_rch_k] = _rch_v

        # log_file_cache: dict[str, str] — missing in older sessions → empty dict.
        # Keys are compound strings "{norm_path}:{size}:{mtime:.9f}"; values are
        # content hashes.  Malformed or non-string entries are silently dropped.
        log_file_cache: dict[str, str] = {}
        raw_lfc = d.get("log_file_cache", {})
        if isinstance(raw_lfc, dict):
            for _lfc_k, _lfc_v in raw_lfc.items():
                if isinstance(_lfc_k, str) and isinstance(_lfc_v, str) and _lfc_k and _lfc_v:
                    log_file_cache[_lfc_k] = _lfc_v

        # dir_listing_cache: dict[str, str] — missing in older sessions → empty dict.
        # Keys are compound strings "{norm_dir_path}:{cmd_fingerprint}"; values are
        # 16-hex-char output hashes.  Malformed or non-string entries are silently dropped.
        dir_listing_cache: dict[str, str] = {}
        raw_dlc = d.get("dir_listing_cache", {})
        if isinstance(raw_dlc, dict):
            for _dlc_k, _dlc_v in raw_dlc.items():
                if isinstance(_dlc_k, str) and isinstance(_dlc_v, str) and _dlc_k and _dlc_v:
                    dir_listing_cache[_dlc_k] = _dlc_v

        # cmd_output_hashes: dict[str, str] — missing in older sessions → empty dict.
        # Keys are display_cmd strings; values are sha256_hex of the last stdout seen.
        # Malformed or non-string entries are silently dropped.
        cmd_output_hashes: dict[str, str] = {}
        raw_coh = d.get("cmd_output_hashes", {})
        if isinstance(raw_coh, dict):
            for _coh_k, _coh_v in raw_coh.items():
                if isinstance(_coh_k, str) and isinstance(_coh_v, str) and _coh_k and _coh_v:
                    cmd_output_hashes[_coh_k] = _coh_v

        return cls(
            session_id=session_id,
            started_ts=float(d.get("started_ts", now)),
            last_activity_ts=float(d.get("last_activity_ts", now)),
            created_ts=float(d.get("created_ts", now)),
            files=files,
            greps=greps,
            grep_result_hashes=grep_result_hashes,
            edited_files=edited_files,
            result_cache=result_cache,
            bash_history=bash_history,
            glob_history=glob_history,
            web_history=web_history,
            skill_history=skill_history,
            decisions=decisions,
            snapshot_shas=snapshot_shas,
            hints_seen=hints_seen,
            hints_content_dedup=hints_content_dedup,
            bash_dedup_emitted_ids=bash_dedup_emitted_ids,
            stored_task_outputs=stored_task_outputs,
            hints_emitted=hints_emitted,
            hints_ignored=hints_ignored,
            structured_hints_emitted=structured_hints_emitted,
            index_only_hints_emitted=index_only_hints_emitted,
            hints_emitted_by_type=hints_emitted_by_type,
            hints_suppressed_by_type=hints_suppressed_by_type,
            recent_hints=recent_hints,
            last_manifest_sha=str(d.get("last_manifest_sha", "")),
            last_manifest_ts=_coerce_ts(d.get("last_manifest_ts", 0.0)),
            version=_coerce_nonneg_int(d.get("version", 0)) if isinstance(d.get("version"), (int, float)) else 0,
            hint_category_history=hint_category_history,
            image_shrink_count=image_shrink_count,
            file_access_counts=file_access_counts,
            symbol_access_counts=symbol_access_counts,
            grep_target_counts=grep_target_counts,
            pinned_symbols=pinned_symbols,
            cwd=str(d["cwd"]) if isinstance(d.get("cwd"), str) else None,
            turns_since_last_compact=turns_since_last_compact,
            loaded_skill_total_tokens=loaded_skill_total_tokens,
            last_context_advisory_threshold=last_context_advisory_threshold,
            pressure_baseline_tokens=pressure_baseline_tokens,
            observed_tool_tokens=observed_tool_tokens,
            last_compact_ts=last_compact_ts,
            file_content_seen=file_content_seen,
            pytest_failures=pytest_failures,
            mcp_result_hashes=mcp_result_hashes,
            read_content_hashes=read_content_hashes,
            log_file_cache=log_file_cache,
            dir_listing_cache=dir_listing_cache,
            cmd_output_hashes=cmd_output_hashes,
        )


def _serialize_file_entry(entry: FileEntry) -> _FileEntryDict:
    """Serialize a FileEntry to its wire dict, omitting fields that equal their defaults.

    Skip-if-default rules (reduce JSON verbosity on entries read without symbol access):
    - ``symbols_read`` is omitted when empty (default []).
    - ``symbols_ts`` is omitted when empty (default {}).
    - ``line_ranges`` is omitted when empty (default []).
    - ``last_edit_ts`` is omitted when 0.0 (default; means "never edited this session").

    Timestamps are rounded to millisecond precision (3 decimal places) — full
    microsecond precision wastes ~7 bytes per field and is never needed for hint logic.
    """
    d = _FileEntryDict(
        rel_or_abs=entry.rel_or_abs,
        last_read_ts=_round_ts(entry.last_read_ts),
        read_count=entry.read_count,
    )
    if entry.line_ranges:
        d["line_ranges"] = [list(r) for r in entry.line_ranges]
    if entry.symbols_read:
        d["symbols_read"] = list(entry.symbols_read)
    # Serialize symbols_ts, rounding timestamp values
    symbols_ts = getattr(entry, 'symbols_ts', None)
    if symbols_ts:
        d["symbols_ts"] = {k: _round_ts(v) for k, v in symbols_ts.items()}
    if entry.last_edit_ts:
        d["last_edit_ts"] = _round_ts(entry.last_edit_ts)
    # On-disk fingerprint (nanosecond mtime + byte size) — omitted only when unrecorded
    # (None). A recorded 0 (epoch-mtime file) is a real value and IS serialized.
    if entry.read_mtime_ns is not None:
        d["read_mtime_ns"] = entry.read_mtime_ns
    if entry.read_size is not None:
        d["read_size"] = entry.read_size
    if entry.last_read_call_index:
        d["last_read_call_index"] = entry.last_read_call_index
    return d


def _serialize_pattern_entry(entry: GrepEntry | GlobEntry) -> dict[str, Any]:
    """Serialize a GrepEntry or GlobEntry to its wire dict with rounded timestamp."""
    d: dict[str, Any] = {
        "pattern": entry.pattern,
        "path": entry.path,
        "ts": _round_ts(entry.ts),
    }
    if entry.result_count is not None:
        d["result_count"] = entry.result_count
    return d


def _serialize_grep_entry(entry: GrepEntry) -> _GrepEntryDict:
    """Serialize a GrepEntry to its wire dict with rounded timestamp."""
    return cast("_GrepEntryDict", _serialize_pattern_entry(entry))


def _serialize_glob_entry(entry: GlobEntry) -> _GlobEntryDict:
    """Serialize a GlobEntry to its wire dict with rounded timestamp."""
    return cast("_GlobEntryDict", _serialize_pattern_entry(entry))


def _parse_pattern_entry_fields(
    g: dict[str, Any],
    factory: Callable[..., _T],
    label: str,
) -> _T | None:
    """Parse a grep-or-glob entry dict, constructing the dataclass via *factory*.

    Shared by :func:`_parse_grep_entry` and :func:`_parse_glob_entry` — they
    differ only in the dataclass constructor (*factory*) and the *label* string
    used in debug log messages.
    """
    try:
        raw_pattern = g.get("pattern", "")
        raw_path = g.get("path")
        raw_ts = g.get("ts", 0.0)
        raw_result_count = g.get("result_count")
        return factory(
            pattern=str(raw_pattern) if isinstance(raw_pattern, (str, int, float)) else "",
            path=str(raw_path) if isinstance(raw_path, str) else None,
            ts=_coerce_ts(raw_ts),
            result_count=(int(raw_result_count) if is_real_int(raw_result_count) else None),
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug(
            "session: skipping corrupted %s entry (%s): %s",
            label,
            exc,
            sanitize_log_str(repr(g)[:120]),
        )
        return None


def _parse_glob_entry(g: dict[str, Any]) -> GlobEntry | None:
    """Deserialize one glob-entry dict from JSON, returning None on any parse error."""
    return _parse_pattern_entry_fields(g, GlobEntry, "glob")


def _serialize_result_cache_entry(entry: ResultCacheEntry) -> _ResultCacheEntryDict:
    """Serialize a ResultCacheEntry to its wire dict with rounded timestamp."""
    return _ResultCacheEntryDict(
        file_sha=entry.file_sha,
        kind=entry.kind,
        result=entry.result,
        ts=_round_ts(entry.ts),
    )


def _serialize_bash_entry(entry: BashEntry) -> _BashEntryDict:
    """Serialize a BashEntry to its wire dict, omitting fields that equal their defaults.

    Skip-if-default rules (reduce JSON verbosity on the common case):
    - ``exit_code`` is omitted when None (default; means not yet recorded).
    - ``truncated`` is omitted when False (default; most commands are not truncated).
    - ``run_count`` is omitted when 1 (default; only repeated commands need it).
    - ``output_sha`` is omitted when empty string (default; backward-compat field).

    These four fields are present on nearly every entry.  Omitting them on entries
    with default values saves ~15–35 bytes per entry (depends on JSON key lengths),
    which compounds materially on sessions with large bash histories.
    """
    d = _BashEntryDict(
        cmd_sha=entry.cmd_sha,
        cmd_preview=entry.cmd_preview,
        output_id=entry.output_id,
        ts=_round_ts(entry.ts),
        stdout_bytes=entry.stdout_bytes,
        stderr_bytes=entry.stderr_bytes,
    )
    if entry.exit_code is not None:
        d["exit_code"] = entry.exit_code
    if entry.truncated:
        d["truncated"] = True
    if entry.run_count != 1:
        d["run_count"] = entry.run_count
    if entry.output_sha:
        d["output_sha"] = entry.output_sha
    return d


def _serialize_web_entry(entry: WebEntry) -> _WebEntryDict:
    """Serialize a WebEntry to its wire dict, omitting fields that equal their defaults.

    Skip-if-default rules:
    - ``status_code`` is omitted when None (default; means not yet recorded or unknown).
    - ``truncated`` is omitted when False (default; most fetches are not truncated).

    The parse path already uses ``.get()`` with these defaults so omitting them
    is fully backward-compatible with older session JSON.
    """
    d = _WebEntryDict(
        url_sha=entry.url_sha,
        url_preview=entry.url_preview,
        output_id=entry.output_id,
        ts=_round_ts(entry.ts),
        body_bytes=entry.body_bytes,
    )
    if entry.status_code is not None:
        d["status_code"] = entry.status_code
    if entry.truncated:
        d["truncated"] = True
    return d


def _serialize_skill_entry(entry: SkillEntry) -> _SkillEntryDict:
    """Serialize a SkillEntry to its wire dict with rounded timestamp.

    Omits ``source_path`` when empty (the default) to keep the JSON compact
    for the typical case where we did not resolve a filesystem path.
    """
    d = _SkillEntryDict(
        skill_name=entry.skill_name,
        output_id=entry.output_id,
        content_sha=entry.content_sha,
        ts=_round_ts(entry.ts),
        body_bytes=entry.body_bytes,
        truncated=entry.truncated,
        run_count=entry.run_count,
    )
    if entry.source_path:
        d["source_path"] = entry.source_path
    if entry.compact_served_count:
        d["compact_served_count"] = entry.compact_served_count
    return d


def _parse_skill_entry(v: dict[str, Any]) -> SkillEntry | None:
    """Deserialize one skill-history dict from JSON, returning None on parse error.

    Coerces every field defensively: the session JSON is user-readable on disk
    and could be corrupted, partially upgraded, or hand-edited.  A bad entry
    is dropped (logged at debug) rather than crashing the load path.
    """
    def _inner(d: dict[str, Any]) -> SkillEntry:
        raw_run_count = d.get("run_count", 1)
        run_count = max(1, int(raw_run_count)) if isinstance(raw_run_count, (int, float)) else 1
        raw_compact_served = d.get("compact_served_count", 0)
        compact_served_count = (
            max(0, int(raw_compact_served))
            if isinstance(raw_compact_served, (int, float))
            else 0
        )
        return SkillEntry(
            skill_name=str(d.get("skill_name", "")),
            output_id=str(d.get("output_id", "")),
            content_sha=str(d.get("content_sha", "")),
            ts=_coerce_ts(d.get("ts", 0.0)),
            body_bytes=_coerce_nonneg_int(d.get("body_bytes", 0)),
            truncated=bool(d.get("truncated", False)),
            run_count=run_count,
            source_path=str(d.get("source_path", "")),
            compact_served_count=compact_served_count,
        )
    return _safe_parse(_inner, v, "skill")


def _serialize_decision_entry(entry: DecisionEntry) -> _DecisionEntryDict:
    """Serialize a DecisionEntry to its wire dict with rounded timestamp.

    Omits ``tag`` when empty (the default) to keep the JSON compact for the
    common case where the caller passes a free-form rationale without a label.
    """
    d = _DecisionEntryDict(text=entry.text, ts=_round_ts(entry.ts))
    if entry.tag:
        d["tag"] = entry.tag
    return d


def _parse_decision_entry(v: dict[str, Any]) -> DecisionEntry | None:
    """Deserialize one decision-log dict from JSON, returning None on parse error.

    Strips the text to ``_MAX_DECISION_TEXT_LEN`` so a hand-edited cache with
    an oversized entry never bloats the in-memory representation.  Empty text
    is treated as invalid (the entry carries no signal); the parser drops it.
    """
    def _inner(d: dict[str, Any]) -> DecisionEntry:
        raw_text = str(d.get("text", "")).strip()
        if not raw_text:
            raise ValueError("decision text is empty")
        if len(raw_text) > _MAX_DECISION_TEXT_LEN:
            raw_text = raw_text[:_MAX_DECISION_TEXT_LEN]
        raw_tag = str(d.get("tag", "")).strip()
        # Tag length is bounded to keep the manifest column predictable —
        # anything longer than 24 chars is almost certainly a misuse.
        if len(raw_tag) > 24:
            raw_tag = raw_tag[:24]
        return DecisionEntry(
            text=raw_text,
            ts=_coerce_ts(d.get("ts", 0.0)),
            tag=raw_tag,
        )
    return _safe_parse(_inner, v, "decision")


def _parse_file_entry(key: str, v: dict[str, Any], now: float) -> FileEntry | None:
    """Deserialize one file-entry dict from JSON, returning None on any parse error.

    Coerces ``line_ranges`` to ``list[tuple[int, int]]`` (dropping malformed pairs)
    and ``symbols_read`` to ``list[str]`` (dropping non-scalar entries).  The coercions
    are intentionally strict to prevent untrusted JSON from injecting arbitrary objects
    into the session cache and corrupting hint output.
    """
    try:
        raw_ranges = v.get("line_ranges", [])
        line_ranges: list[tuple[int, int]] = []
        for r in raw_ranges:
            if isinstance(r, (list, tuple)) and len(r) == 2:
                start_val, end_val = r
                if isinstance(start_val, int) and isinstance(end_val, int):
                    line_ranges.append((start_val, end_val))

        # Coerce symbols_read entries to str and silently drop non-scalars.
        # Untrusted JSON could contain nested objects/lists; storing them as-is
        # would allow arbitrary objects into the cache and corrupt hint output.
        raw_symbols = v.get("symbols_read", [])
        symbols_read = [
            str(s) for s in raw_symbols
            if isinstance(s, (str, int, float)) and not isinstance(s, bool)
        ]

        # ``last_edit_ts`` is optional in the persisted JSON: older session
        # files predate the field, so missing/non-numeric values default to 0.0
        # (= "never edited this session"). This preserves backwards compat with
        # session caches written by prior token-goat versions.
        raw_last_edit_ts = v.get("last_edit_ts", 0.0)
        try:
            last_edit_ts = float(raw_last_edit_ts) if raw_last_edit_ts is not None else 0.0
        except (TypeError, ValueError):
            last_edit_ts = 0.0

        # ``symbols_ts`` is optional: maps symbol name → unix timestamp.
        # Backwards compatible with older session files that predate this field.
        raw_symbols_ts = v.get("symbols_ts", {})
        symbols_ts: dict[str, float] = {}
        if isinstance(raw_symbols_ts, dict):
            for sym_name, sym_ts in raw_symbols_ts.items():
                if isinstance(sym_name, str) and isinstance(sym_ts, (int, float)):
                    symbols_ts[sym_name] = float(sym_ts)

        return FileEntry(
            rel_or_abs=str(v.get("rel_or_abs", key)),
            last_read_ts=float(v.get("last_read_ts", now)),
            read_count=_coerce_nonneg_int(v.get("read_count", 0)),
            line_ranges=line_ranges,
            symbols_read=symbols_read,
            last_edit_ts=last_edit_ts,
            symbols_ts=symbols_ts,
            read_mtime_ns=_coerce_nonneg_int_or_none(v.get("read_mtime_ns")),
            read_size=_coerce_nonneg_int_or_none(v.get("read_size")),
            last_read_call_index=int(v.get("last_read_call_index") or 0),
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug(
            "session: skipping corrupted file entry for key %s: %s",
            sanitize_log_str(key, max_len=_MAX_LOG_STR),
            exc,
        )
        return None


def _parse_grep_entry(g: dict[str, Any]) -> GrepEntry | None:
    """Deserialize one grep-entry dict from JSON, returning None on any parse error."""
    return _parse_pattern_entry_fields(g, GrepEntry, "grep")


def _parse_result_cache_entry(v: dict[str, Any]) -> ResultCacheEntry | None:
    """Deserialize one result-cache entry from JSON, returning None on any parse error.

    The ``result`` field is stored as a plain dict; we accept any dict but reject
    non-dicts to prevent untrusted JSON from injecting arbitrary objects.  Empty
    or malformed entries are dropped silently — a stale cache miss is harmless
    (the slow path recomputes), while a corrupted entry could crash the hot path.
    """
    def _inner(d: dict[str, Any]) -> ResultCacheEntry | None:
        raw_sha = d.get("file_sha", "")
        raw_kind = d.get("kind", "")
        raw_result = d.get("result", {})
        raw_ts = d.get("ts", 0.0)
        if not isinstance(raw_result, dict):
            return None
        if not isinstance(raw_kind, str) or raw_kind not in ("symbol", "section"):
            return None
        return ResultCacheEntry(
            file_sha=str(raw_sha) if isinstance(raw_sha, (str, int, float)) else "",
            kind=raw_kind,
            result=dict(raw_result),  # shallow copy — JSON values are immutable scalars/dicts
            ts=_coerce_ts(raw_ts),
        )
    return _safe_parse(_inner, v, "result_cache")


class _ResultCacheEntryDict(TypedDict, total=False):
    """Wire format of a single ResultCacheEntry as it appears in the session JSON."""

    file_sha: str
    kind: str
    result: dict[str, Any]
    ts: float


class _BashEntryDict(TypedDict, total=False):
    """Wire format of a single BashEntry as it appears in the session JSON."""

    cmd_sha: str
    cmd_preview: str
    output_id: str
    ts: float
    stdout_bytes: int
    stderr_bytes: int
    exit_code: int | None
    truncated: bool
    run_count: int
    output_sha: str  # Content hash of post-compression output (new field, optional)


class _WebEntryDict(TypedDict, total=False):
    """Wire format of a single WebEntry as it appears in the session JSON."""

    url_sha: str
    url_preview: str
    output_id: str
    ts: float
    body_bytes: int
    status_code: int | None
    truncated: bool
    content_type: str | None


class _SkillEntryDict(TypedDict, total=False):
    """Wire format of a single SkillEntry as it appears in the session JSON.

    ``source_path`` is optional (``total=False``) because it is only populated
    when the post-skill hook successfully resolves a filesystem path for the
    skill body — the common case (plugin-served skills) omits it.
    """

    skill_name: str
    output_id: str
    content_sha: str
    ts: float
    body_bytes: int
    truncated: bool
    run_count: int
    source_path: str
    compact_served_count: int


class _DecisionEntryDict(TypedDict, total=False):
    """Wire format of a single :class:`DecisionEntry` in the session JSON.

    ``tag`` is optional (``total=False``) — the common case is a free-form
    rationale without a leading label, which is serialized without the field
    so the JSON stays compact.
    """

    text: str
    ts: float
    tag: str


def _parse_web_entry(v: dict[str, Any]) -> WebEntry | None:
    """Deserialize one web-history dict from JSON, returning None on parse error.

    Defensive about every field: session JSON is user-readable on disk and
    could be corrupted, partially upgraded, or hand-edited.  A bad entry is
    dropped at debug level rather than crashing the session-load path.
    """
    def _inner(d: dict[str, Any]) -> WebEntry:
        raw_status = d.get("status_code")
        status_code: int | None = None
        if is_real_int(raw_status):
            status_code = raw_status
        return WebEntry(
            url_sha=str(d.get("url_sha", "")),
            url_preview=str(d.get("url_preview", "")),
            output_id=str(d.get("output_id", "")),
            ts=_coerce_ts(d.get("ts", 0.0)),
            body_bytes=_coerce_nonneg_int(d.get("body_bytes", 0)),
            status_code=status_code,
            truncated=bool(d.get("truncated", False)),
        )
    return _safe_parse(_inner, v, "web")


def _parse_bash_entry(v: dict[str, Any]) -> BashEntry | None:
    """Deserialize one bash-history dict from JSON, returning None on parse error.

    Coerces every field defensively: the session JSON is user-readable on
    disk and could be corrupted, partially upgraded, or hand-edited.  A bad
    entry is dropped (logged at debug) rather than crashing the load path.
    """
    def _inner(d: dict[str, Any]) -> BashEntry:
        raw_exit = d.get("exit_code")
        exit_code: int | None = None
        if is_real_int(raw_exit):
            exit_code = raw_exit
        raw_run_count = d.get("run_count", 1)
        run_count = max(1, int(raw_run_count)) if isinstance(raw_run_count, (int, float)) else 1
        output_sha = str(d.get("output_sha", ""))  # Empty string for backward compat
        return BashEntry(
            cmd_sha=str(d.get("cmd_sha", "")),
            cmd_preview=str(d.get("cmd_preview", "")),
            output_id=str(d.get("output_id", "")),
            ts=_coerce_ts(d.get("ts", 0.0)),
            stdout_bytes=_coerce_nonneg_int(d.get("stdout_bytes", 0)),
            stderr_bytes=_coerce_nonneg_int(d.get("stderr_bytes", 0)),
            exit_code=exit_code,
            truncated=bool(d.get("truncated", False)),
            run_count=run_count,
            output_sha=output_sha if isinstance(output_sha, str) else "",
        )
    return _safe_parse(_inner, v, "bash")


class _FileEntryDict(TypedDict, total=False):
    """Wire format of a single FileEntry as it appears in the session JSON.

    ``last_edit_ts`` and ``symbols_ts`` are optional (``total=False``) for backwards compat with
    session caches written by token-goat versions that predate these fields.
    """

    rel_or_abs: str
    last_read_ts: float
    read_count: int
    line_ranges: list[list[int]]
    symbols_read: list[str]
    symbols_ts: dict[str, float]
    last_edit_ts: float
    read_mtime_ns: int
    read_size: int
    last_read_call_index: int


class _GrepEntryDict(TypedDict, total=False):
    """Wire format of a single GrepEntry as it appears in the session JSON."""

    pattern: str
    path: str | None
    ts: float
    result_count: int | None


class _GlobEntryDict(TypedDict, total=False):
    """Wire format of a single GlobEntry as it appears in the session JSON."""

    pattern: str
    path: str | None
    ts: float
    result_count: int | None


class _SessionDict(TypedDict, total=False):
    """Wire format of a serialized SessionCache (written to / read from JSON on disk).

    ``result_cache``, ``bash_history``, ``snapshot_shas``, ``hints_seen``, and ``created_ts``
    are optional (``total=False``) for backwards compatibility with session caches written
    by token-goat versions that predate these fields.  All other fields are
    still effectively required because :meth:`SessionCache.from_dict` supplies
    a default for each one.
    """

    schema_version: int
    created_by: str
    session_id: str
    started_ts: float
    last_activity_ts: float
    created_ts: float
    files: dict[str, _FileEntryDict]
    greps: list[_GrepEntryDict]
    grep_result_hashes: dict[str, str]
    mcp_result_hashes: dict[str, str]
    edited_files: dict[str, int]
    result_cache: dict[str, _ResultCacheEntryDict]
    bash_history: dict[str, _BashEntryDict]
    glob_history: list[_GlobEntryDict]
    web_history: dict[str, _WebEntryDict]
    skill_history: dict[str, _SkillEntryDict]
    decisions: list[_DecisionEntryDict]
    snapshot_shas: dict[str, str]
    hints_seen: dict[str, int] | list[str]
    hints_content_dedup: dict[str, list[str | int]]
    bash_dedup_emitted_ids: list[str]
    stored_task_outputs: dict[str, str]
    hints_emitted: int
    hints_ignored: int
    structured_hints_emitted: int
    index_only_hints_emitted: int
    hints_emitted_by_type: dict[str, int]
    hints_suppressed_by_type: dict[str, int]
    recent_hints: list[list[object]]
    last_manifest_sha: str
    last_manifest_ts: float
    version: int
    hint_category_history: dict[str, list[int]]
    image_shrink_count: dict[str, int]
    file_access_counts: dict[str, int]
    symbol_access_counts: dict[str, int]
    grep_target_counts: dict[str, int]
    pinned_symbols: list[str]
    cwd: str | None
    turns_since_last_compact: int
    loaded_skill_total_tokens: int
    last_context_advisory_threshold: int | None
    pressure_baseline_tokens: int
    observed_tool_tokens: int
    last_compact_ts: float
    file_content_seen: dict[str, str]
    pytest_failures: dict[str, list[str]]
    read_content_hashes: dict[str, str]
    log_file_cache: dict[str, str]
    dir_listing_cache: dict[str, str]
    cmd_output_hashes: dict[str, str]


def _fresh_cache(session_id: str, *, unavailable: bool = False) -> SessionCache:
    """Return a new empty SessionCache for the given session ID.

    When *unavailable* is True the cache is created with the unavailable flag
    set, signalling to callers that the backing file could not be written and
    that session tracking is degraded for this session.
    """
    now = time.time()
    return SessionCache(
        session_id=session_id,
        started_ts=now,
        last_activity_ts=now,
        unavailable=unavailable,
    )


def _has_windows_drive_prefix(s: str) -> bool:
    """Return True when *s* starts with a Windows drive letter followed by a colon.

    Matches both uppercase and lowercase drive letters (e.g. ``C:``, ``c:``) so
    the predicate is usable in both normalization contexts (where we need to
    detect an uppercase letter to lowercase it) and path-classification contexts
    (where we only need to know whether the path is absolute).
    Callers that only want to detect *uppercase* drives (for lowercasing) should
    additionally check ``s[0].isupper()``.
    """
    return len(s) >= 2 and s[1] == ":" and s[0].isalpha()


def _normalize_path(p: str) -> str:
    """Normalize a path for use as a cache key (thin alias to ``paths.normalize_key``).

    Retained as a module-private alias so existing in-module and external
    callers (``session._normalize_path``) continue to resolve.  The canonical
    public entrypoint is :func:`token_goat.paths.normalize_key`; see its
    docstring for the exact contract.
    """
    return paths.normalize_key(p)


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

_MAX_LOG_STR = 120  # truncation limit for user-controlled values embedded in log messages


def _evict_oldest(mapping: dict, cap: int, evict_n: int, label: str, session_id: str) -> None:
    """FIFO-evict the oldest `evict_n` entries from `mapping` when it hits `cap`.

    Uses dict insertion order (Python 3.7+). No-ops if len(mapping) < cap.
    """
    if len(mapping) < cap:
        return
    evict_keys = list(islice(mapping.keys(), evict_n))
    for k in evict_keys:
        del mapping[k]
    _LOG.debug("%s: evicted %d entries (cap=%d) for session=%s", label, evict_n, cap, session_id[:16])


def _append_to_dict_history(
    history_dict: dict,
    key: str,
    entry: Any,
    max_size: int,
    batch_size: int,
    label: str,
    session_id: str,
) -> None:
    """Append an entry to a dict-based history, evicting oldest if needed.

    Shared logic for bash_history and web_history: check if key exists before
    evicting (new keys trigger eviction, updates preserve insertion order),
    then store the entry.  Modifies history_dict in place.
    """
    if key not in history_dict:
        _evict_oldest(history_dict, max_size, batch_size, label, session_id)
    history_dict[key] = entry


def _append_to_list_history(
    history_list: list,
    entry: Any,
    max_size: int,
    batch_size: int,
    label: str,
    session_id: str,
) -> None:
    """Append an entry to a list-based history, evicting oldest if needed.

    Shared logic for greps and glob_history: append entry, then slice to keep
    only the most recent max_size entries.  Modifies history_list in place.
    """
    history_list.append(entry)
    if len(history_list) > max_size:
        history_list[:] = history_list[-max_size:]
        _LOG.debug(
            "%s: evicted %d entries (cap=%d) for session=%s",
            label,
            batch_size,
            max_size,
            session_id[:16],
        )


def validate_session_id(session_id: str) -> None:
    """Validate session_id to prevent path traversal attacks. Raises ValueError on invalid input.

    Session IDs must be non-empty, at most 128 characters, and contain only
    alphanumeric characters, hyphens, and underscores — no path separators or
    other suspicious characters that could enable directory traversal.

    The 128-character cap is conservative relative to the Windows MAX_PATH limit
    of 260 characters.  The session file lives at
    ``%LOCALAPPDATA%\\dfk-helper\\token-goat\\sessions\\<id>.json``; the base
    directory alone consumes roughly 60–80 chars on a typical Windows install,
    leaving less than 200 chars for the filename.  Claude session IDs are UUIDs
    (36 chars), so 128 is far above any legitimate value while providing a
    comfortable safety margin before MAX_PATH is reached.
    """
    if not session_id:
        raise ValueError("session_id cannot be empty")
    if len(session_id) > 128:
        raise ValueError("session_id too long (max 128 chars)")
    if not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"session_id contains invalid characters: {session_id!r}")


def _cleanup_stale_tmp_files(p: Path) -> None:
    """Clean up any stale .tmp files left behind by interrupted writes.

    On startup (or when loading the session cache), checks for orphaned .tmp
    files in the same directory that may have been left by a prior process
    that crashed mid-write. These files are deleted to prevent accumulation.

    This is best-effort: any OSError is caught and logged but does not propagate,
    since we always want to proceed with the load regardless of cleanup success.
    """
    try:
        parent = p.parent
        if not parent.exists():
            return
        for tmp_path in parent.glob(f"{p.name}.*.tmp"):
            try:
                tmp_path.unlink(missing_ok=True)
                _LOG.debug("cleaned up stale tmp file: %s", tmp_path.name)
            except OSError as e:
                _LOG.debug("failed to clean up tmp file %s: %s", tmp_path.name, e)
    except OSError as e:
        _LOG.debug("failed to scan for tmp files near %s: %s", p.name, e)


def _preserve_corrupt_file(p: Path) -> None:
    """Move a corrupt session JSON file to a timestamped archive for forensics.

    On corruption detection, the file is moved from ``path.json`` to
    ``path.corrupt.{timestamp}`` instead of being silently deleted. This
    preserves evidence for debugging while allowing the session to start fresh.

    Failures are logged but do not propagate — we always want to proceed with
    a fresh session regardless of archival success.
    """
    try:
        if not p.exists():
            return
        timestamp = int(time.time())
        corrupt_path = p.with_name(f"{p.name}.corrupt.{timestamp}")
        p.rename(corrupt_path)
        _LOG.warning("archived corrupt session file: %s → %s", p.name, corrupt_path.name)
    except OSError as e:
        _LOG.debug("failed to archive corrupt session file %s: %s", p.name, e)


def _record_cache_contention(session_id: str, phase: str, exc: OSError) -> None:
    """Record a best-effort telemetry row when the session cache is locked.

    Uses a disk touch-file under ``data_dir()/contention_marks/`` as the dedup
    token so the "already reported" check survives across processes.  Each hook
    spawns a fresh process, so an in-memory set was always empty on entry and
    effectively recorded one stat row *per hook call* rather than one per
    session lifetime.  The touch-file approach limits it to one row per
    (session_id, phase) until the worker sweeps marks older than
    ``_CONTENTION_MARK_TTL_SECS``.
    """
    mark = _contention_mark_path(session_id, phase)
    try:
        # Cheap existence check — one stat() per contention event.
        if mark.exists():
            return
        paths.ensure_dir(mark.parent)
        # O_CREAT|O_EXCL is atomic: the process that wins the create records
        # the stat row; concurrent losers see the file on the next stat().
        # 0o600: owner-only — consistent with other sentinel/lock files and
        # ensures session-ID fragments encoded in the path are not visible to
        # other local users on multi-user systems.
        fd = os.open(str(mark), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except FileExistsError:
        # Another process created the mark between our exists() check and
        # our O_EXCL open — treat as already reported.
        return
    except OSError:
        # Cannot create the mark file (e.g. read-only FS, quota exceeded).
        # Fall through and record the stat row anyway; duplicates are
        # acceptable in edge cases.
        pass
    try:
        from . import db  # noqa: PLC0415

        db.record_stat(
            None,
            "session_cache_unavailable",
            detail=f"{phase}:{session_id[:16]}:{type(exc).__name__}",
        )
    except Exception:  # noqa: BLE001
        _LOG.debug("failed to record session cache contention", exc_info=True)


def _resolve_cache(session_id: str, cache: SessionCache | None) -> SessionCache:
    """Validate session_id and return the given cache, or load one from disk.

    When *cache* is already loaded for this session, return it directly
    (avoids a redundant disk read).  When *cache* is None, load from disk.
    Raises ValueError if *cache* belongs to a different session_id.
    """
    validate_session_id(session_id)
    if cache is not None:
        if cache.session_id != session_id:
            raise ValueError(
                f"cache.session_id {cache.session_id!r} does not match session_id {session_id!r}"
            )
        return cache
    return load(session_id)


def _migrate_session(data: dict[str, Any]) -> dict[str, Any]:
    """Add missing top-level and nested fields to a session dict with safe defaults.

    This function ensures backwards compatibility when loading session JSON files
    written by older token-goat versions that predate new fields.  It runs before
    SessionCache.from_dict() so the dataclass constructor always sees complete fields.

    Top-level migrations:
    - ``edited_files``: defaults to ``{}`` (dict[str, int])
    - ``glob_history``: defaults to ``[]`` (list[GlobEntry])
    - ``cwd``: defaults to ``None`` (optional working directory)

    Per-FileEntry migrations (nested):
    - ``symbols_ts``: defaults to ``{}`` (dict[str, float] mapping symbol → unix ts)
    - ``last_edit_ts``: defaults to ``0.0`` (unix ts; 0.0 = "never edited this session")
    """
    # Top-level defaults
    if "edited_files" not in data:
        data["edited_files"] = {}
    if "glob_history" not in data:
        data["glob_history"] = []
    if "skill_history" not in data:
        data["skill_history"] = {}
    if "cwd" not in data:
        data["cwd"] = None
    if "bash_dedup_emitted_ids" not in data:
        data["bash_dedup_emitted_ids"] = []
    if "stored_task_outputs" not in data:
        data["stored_task_outputs"] = {}
    if "hints_emitted" not in data:
        data["hints_emitted"] = 0
    if "hints_ignored" not in data:
        data["hints_ignored"] = 0
    if "recent_hints" not in data:
        data["recent_hints"] = []
    if "hint_category_history" not in data:
        data["hint_category_history"] = {}
    if "version" not in data:
        data["version"] = 0

    # Per-file-entry defaults for nested objects
    for file_entry in data.get("files", {}).values():
        if not isinstance(file_entry, dict):
            continue
        if "symbols_ts" not in file_entry:
            file_entry["symbols_ts"] = {}
        if "last_edit_ts" not in file_entry:
            file_entry["last_edit_ts"] = 0.0

    return data


def load(session_id: str) -> SessionCache:
    """Load the on-disk session cache for *session_id*, or create a fresh one.

    Retries the file read up to three times with short sleeps to handle
    transient races on Windows (another hook may be writing the file).  On
    persistent failure or a missing file, returns a fresh empty cache.
    Corrupted JSON is treated the same as a missing file: the cache is reset
    rather than propagating an exception, because a stale hint is always
    preferable to a broken hook invocation.

    Before loading, cleans up any stale .tmp files left behind by interrupted
    atomic writes, and archives any corrupt .json file to .json.corrupt.{ts}
    for forensic analysis.
    """
    validate_session_id(session_id)
    t0 = time.monotonic()
    p = paths.session_cache_path(session_id)

    # Clean up orphaned .tmp files and prepare the path.
    _cleanup_stale_tmp_files(p)

    # --- Process-local load cache ---
    # Within a single process invocation (e.g. dual user-prompt-submit +
    # subagent-stop hooks) skip the JSON read when the file has not changed.
    # Keyed by session_id; invalidated by file mtime change or cap overflow.
    try:
        _cur_mtime = p.stat().st_mtime if p.exists() else -1.0
    except OSError:
        _cur_mtime = -1.0
    _proc_entry = _proc_load_cache.get(session_id)
    if _proc_entry is not None:
        _cached_obj, _cached_mtime = _proc_entry
        if _cached_mtime == _cur_mtime and _cur_mtime >= 0.0:
            _LOG.debug("session load: proc-cache hit for %s", session_id[:16])
            return _cached_obj

    try:
        if not p.exists():
            _LOG.info("session opened: %s (new)", session_id[:16])
            return _fresh_cache(session_id)
    except OSError as exc:
        _LOG.debug("session cache unavailable (%s); returning empty cache", exc)
        _record_cache_contention(session_id, "load", exc)
        return _fresh_cache(session_id, unavailable=True)

    read_error: OSError | None = None
    for delay in (0.0, 0.05, 0.15):
        if delay:
            time.sleep(delay)
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError as exc:
            read_error = exc
            continue
        try:
            data = json.loads(raw)
            # Schema version guard: drop any cache that wasn't written by the
            # current schema.  Mismatched caches are stale (too old) or from a
            # newer binary running alongside this one — either way the safe move
            # is to start fresh rather than silently misinterpret fields.
            cached_v = data.get("schema_version", 0)
            try:
                cached_v_int = int(cached_v) if cached_v else 0
            except (TypeError, ValueError):
                cached_v_int = 0
            if cached_v_int != SESSION_SCHEMA_VERSION:
                _LOG.info(
                    "session %s: schema_version %s != %s; dropping stale cache",
                    session_id[:16],
                    sanitize_log_str(str(cached_v), max_len=_MAX_LOG_STR),
                    SESSION_SCHEMA_VERSION,
                )
                return _fresh_cache(session_id)
            # Migrate missing fields before constructing SessionCache
            data = _migrate_session(data)
            cache = SessionCache.from_dict(data)
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            _LOG.warning("session cache corrupted (%s); resetting", e)
            _preserve_corrupt_file(p)
            return _fresh_cache(session_id)
        cache.unavailable = False
        # Record the on-disk fingerprint so save() can skip the CAS from_dict
        # round-trip when no concurrent writer has touched the file.
        try:
            st = p.stat()
            cache._disk_mtime_ns = st.st_mtime_ns
            cache._disk_size = st.st_size
            _cur_mtime = st.st_mtime
        except OSError:
            pass  # benign — save() falls back to full CAS if fingerprint is missing
        elapsed_ms = (time.monotonic() - t0) * 1000
        _LOG.info(
            "session opened: %s (resuming, %d files tracked, %d edited, %.1fms)",
            session_id[:16], len(cache.files), len(cache.edited_files), elapsed_ms,
        )
        # Store in process-local cache; evict oldest entry when at cap.
        if _cur_mtime >= 0.0:
            if len(_proc_load_cache) >= _PROC_LOAD_CACHE_MAX and session_id not in _proc_load_cache:
                _proc_load_cache.pop(next(iter(_proc_load_cache)), None)
            _proc_load_cache[session_id] = (cache, _cur_mtime)
        return cache

    if read_error is not None:
        _LOG.debug("session cache unavailable (%s); returning empty cache", read_error)
        _record_cache_contention(session_id, "load", read_error)
    return _fresh_cache(session_id, unavailable=True)


def safe_load(session_id: str, *, caller: str = "safe_load") -> SessionCache | None:
    """Validate *session_id* and load its cache, returning ``None`` on any failure.

    Wraps :func:`validate_session_id` + :func:`load` with a catch-all so callers
    that want to silently skip invalid or unreadable sessions do not need to
    replicate the try/except pattern.

    Parameters
    ----------
    session_id:
        The session identifier to validate and load.
    caller:
        Short label used in log messages so different call sites are
        distinguishable (e.g. ``"pre-compact"``, ``"hint-builder"``).

    Returns
    -------
    SessionCache | None
        The loaded cache, or ``None`` if *session_id* is invalid or loading
        raises an unexpected exception.
    """
    try:
        validate_session_id(session_id)
        return load(session_id)
    except ValueError as exc:
        _LOG.warning("%s: invalid session_id rejected: %s", caller, exc)
        return None
    except Exception as exc:  # noqa: BLE001
        sid_short = session_id[:8] if session_id else "<empty>"
        _LOG.debug("%s(%s) failed: %s", caller, sid_short, exc, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Session file size cap
# ---------------------------------------------------------------------------

_SESSION_MAX_BYTES: Final[int] = 2 * 1024 * 1024  # 2 MB default


def _get_session_max_bytes() -> int:
    """Return the session file size cap in bytes.

    Reads ``TOKEN_GOAT_SESSION_MAX_BYTES`` from the environment.  If the value
    is absent, non-numeric, or zero/negative, falls back to
    :data:`_SESSION_MAX_BYTES` (2 MB).
    """
    v = env_int("TOKEN_GOAT_SESSION_MAX_BYTES", 0)
    return v if v > 0 else _SESSION_MAX_BYTES


def _trim_session_for_size(cache: SessionCache, max_bytes: int) -> bool:
    """Trim *cache* in-place until its serialized size fits within *max_bytes*.

    Trim order (largest-contributor-first, repeated up to 5 passes):

    1. ``result_cache`` (dict keyed by ``file::symbol``)
    2. ``bash_history`` (dict keyed by cmd SHA)
    3. ``web_history`` (dict keyed by URL SHA)
    4. ``greps`` (list)
    5. ``glob_history`` (list)
    6. ``hints_seen`` (dict keyed by fingerprint)
    7. ``bash_dedup_emitted_ids`` (set)

    Each pass drops 25 % of the current entries from the largest collection
    (oldest-first for dicts/lists with a ``ts`` field; arbitrary order for
    ``bash_dedup_emitted_ids``).

    The following fields are **never** trimmed because they are load-bearing
    for hint correctness: ``files``, ``edited_files``, ``skill_history``,
    ``decisions``, ``hint_category_stats``.

    Returns ``True`` if any trimming was performed, ``False`` if the cache
    was already within the limit.
    """
    cache._invalidate_json_cache()
    current_size = len(utf8_bytes(cache.to_json()))
    if current_size <= max_bytes:
        return False

    _LOG.warning(
        "session size cap: %s serialized to %d bytes (cap=%d); trimming",
        cache.session_id[:16], current_size, max_bytes,
    )
    trimmed = False

    for _pass in range(5):
        cache._invalidate_json_cache()
        current_size = len(utf8_bytes(cache.to_json()))
        if current_size <= max_bytes:
            break

        # Build candidate list: (size_proxy, name) for non-empty trimmable collections.
        candidates: list[tuple[int, str]] = []
        if cache.result_cache:
            candidates.append((len(cache.result_cache), "result_cache"))
        if cache.bash_history:
            candidates.append((len(cache.bash_history), "bash_history"))
        if cache.web_history:
            candidates.append((len(cache.web_history), "web_history"))
        if cache.greps:
            candidates.append((len(cache.greps), "greps"))
        if cache.glob_history:
            candidates.append((len(cache.glob_history), "glob_history"))
        if cache.hints_seen:
            candidates.append((len(cache.hints_seen), "hints_seen"))
        if cache.bash_dedup_emitted_ids:
            candidates.append((len(cache.bash_dedup_emitted_ids), "bash_dedup_emitted_ids"))

        if not candidates:
            break  # nothing left to trim

        candidates.sort(reverse=True)
        target_name = candidates[0][1]
        target_count = candidates[0][0]
        drop_n = max(1, target_count // 4)  # drop 25 %

        if target_name == "result_cache":
            # Drop oldest entries (by ts).
            ordered = sorted(cache.result_cache.items(), key=lambda kv: kv[1].ts)
            to_remove = {k for k, _ in ordered[:drop_n]}
            cache.result_cache = {k: v for k, v in cache.result_cache.items() if k not in to_remove}
        elif target_name == "bash_history":
            ordered_bash = sorted(cache.bash_history.items(), key=lambda kv: kv[1].ts)
            to_remove_bash = {k for k, _ in ordered_bash[:drop_n]}
            cache.bash_history = {k: v for k, v in cache.bash_history.items() if k not in to_remove_bash}
        elif target_name == "web_history":
            ordered_web = sorted(cache.web_history.items(), key=lambda kv: kv[1].ts)
            to_remove_web = {k for k, _ in ordered_web[:drop_n]}
            cache.web_history = {k: v for k, v in cache.web_history.items() if k not in to_remove_web}
        elif target_name == "greps":
            # Oldest-first (list is ordered by insertion time; ts field confirms).
            cache.greps = sorted(cache.greps, key=lambda g: g.ts)[drop_n:]
        elif target_name == "glob_history":
            cache.glob_history = sorted(cache.glob_history, key=lambda g: g.ts)[drop_n:]
        elif target_name == "hints_seen":
            # Drop lowest-count (least-important) fingerprints first.
            sorted_hints = sorted(cache.hints_seen.items(), key=itemgetter(1))
            cache.hints_seen = dict(sorted_hints[drop_n:])
        elif target_name == "bash_dedup_emitted_ids":
            # Arbitrary order; just drop *drop_n* items.
            lst = list(cache.bash_dedup_emitted_ids)
            cache.bash_dedup_emitted_ids = set(lst[drop_n:])

        trimmed = True

    cache._invalidate_json_cache()
    final_size = len(utf8_bytes(cache.to_json()))
    if final_size > max_bytes:
        _LOG.warning(
            "session size cap: could not reduce %s below cap after 5 passes "
            "(final=%d bytes, cap=%d)",
            cache.session_id[:16], final_size, max_bytes,
        )
    else:
        _LOG.info(
            "session size cap: trimmed %s to %d bytes (cap=%d)",
            cache.session_id[:16], final_size, max_bytes,
        )
    return trimmed


def save(cache: SessionCache) -> None:
    """Atomically persist the session cache to disk with cross-process CAS.

    Uses a sidecar ``.lock`` file for mutual exclusion between concurrent hook
    processes (one per tool call on Windows).  Within the critical section the
    on-disk version is re-read; if another process wrote a newer version while
    we held our in-memory copy, :func:`_merge_session_caches` re-applies our
    mutations on top of the remote state before writing.  This prevents the
    classic load-modify-save lost-update race.

    Retry budget: up to 3 attempts for the underlying ``atomic_write_text``;
    the lock itself has a 5-second timeout (see ``_LOCK_TIMEOUT_SECS``).  On
    total write failure the cache is marked ``unavailable`` so future saves
    no-op until a fresh ``load`` rebuilds the cache.

    Lock-timeout handling: if ``_acquire_session_lock`` returns None (timeout)
    only *this* save attempt is aborted.  A lock timeout never marks the cache
    unavailable — a transiently busy lock must not silently drop future edits.
    """
    if cache.unavailable:
        _LOG.debug("session save skipped (cache unavailable): %s", cache.session_id[:16])
        return
    t0 = time.monotonic()
    last_exc: OSError | None = None

    for attempt in range(3):
        if attempt:
            time.sleep(0.05 * attempt)

        # _FILE_LOCK serializes same-process threads; the sidecar lockfile serializes across processes.
        with _FILE_LOCK:
            lock_fd = _acquire_session_lock(cache.session_id)
            if lock_fd is None:
                # Cross-process lock timed out — abort only this attempt. A busy lock must never mark the cache unavailable: doing so would latch off all future saves and silently drop edits (the loss bug).
                _LOG.debug(
                    "session lock timeout (attempt %d): %s",
                    attempt + 1, cache.session_id[:16],
                )
                with contextlib.suppress(Exception):
                    from . import db as _db_lock  # noqa: PLC0415
                    _db_lock.record_stat(
                        None,
                        "session_cache_lock_timeout",
                        bytes_saved=0,
                        tokens_saved=0,
                        detail=cache.session_id[:32],
                    )
                continue
            try:
                # CAS: re-read on-disk state inside the lock.
                # Fast path: if the file's mtime+size match the fingerprint we
                # recorded at load(), no concurrent writer has touched it — skip
                # the from_dict round-trip and write directly.
                disk_cache: SessionCache | None = None
                p = paths.session_cache_path(cache.session_id)
                _skip_cas = False
                # The fingerprint fast path is only sound when no other writer has
                # advanced the on-disk version since this cache loaded.  An in-process
                # thread that already wrote a newer version is invisible to a (mtime,
                # size) fingerprint when its write aliased — so consult the version
                # registry first: if a same-process save outran us, force full CAS.
                _in_proc_ahead = _LAST_SAVED_VERSION.get(cache.session_id, -1) > cache.version
                if not _in_proc_ahead and (cache._disk_mtime_ns != 0 or cache._disk_size != 0):
                    try:
                        st = os.stat(p)
                        if st.st_mtime_ns == cache._disk_mtime_ns and st.st_size == cache._disk_size:
                            _skip_cas = True
                    except OSError:
                        pass  # file may not exist yet; fall through to full CAS

                if not _skip_cas:
                    try:
                        if p.exists():
                            raw = p.read_text(encoding="utf-8")
                            data = json.loads(raw)
                            data = _migrate_session(data)
                            disk_cache = SessionCache.from_dict(data)
                    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
                        # On-disk file unreadable — treat as empty (will overwrite).
                        disk_cache = None

                # Merge if another process wrote a newer version since we loaded.
                if disk_cache is not None and disk_cache.version > cache.version:
                    _LOG.debug(
                        "session CAS merge: %s (local v%d, remote v%d)",
                        cache.session_id[:16], cache.version, disk_cache.version,
                    )
                    cache = _merge_session_caches(cache, disk_cache)

                # Bump version and write.
                cache.version = max(
                    disk_cache.version if disk_cache is not None else 0,
                    cache.version,
                ) + 1
                cache._invalidate_json_cache()

                # Size cap: trim oldest entries before writing if the serialized
                # JSON would exceed the configured maximum (default 2 MB).
                _trim_session_for_size(cache, _get_session_max_bytes())

                try:
                    paths.atomic_write_text(p, cache.to_json())
                    # Record the version we just wrote so a concurrent same-process
                    # thread holding an older cache is forced through full CAS even if
                    # its fingerprint aliases ours (the lost-update guard).
                    _LAST_SAVED_VERSION[cache.session_id] = cache.version
                    # Update fingerprint so subsequent saves in the same process
                    # also benefit from the fast-path skip.
                    try:
                        st2 = os.stat(p)
                        cache._disk_mtime_ns = st2.st_mtime_ns
                        cache._disk_size = st2.st_size
                        # Refresh the process-local load cache so a subsequent in-process load() returns this just-written state instead of a stale object cached under an aliased mtime. Windows mtime granularity is coarse enough that the post-save timestamp can equal the one a prior load() cached, which would otherwise serve the pre-save object on a proc-cache hit. Only refresh an existing entry — inserting new keys here would bypass load()'s LRU-cap accounting.
                        if cache.session_id in _proc_load_cache:
                            _proc_load_cache[cache.session_id] = (cache, st2.st_mtime)
                    except OSError:
                        pass
                except OSError as exc:
                    last_exc = exc
                    continue
            finally:
                _release_session_lock(cache.session_id, lock_fd)

        elapsed_ms = (time.monotonic() - t0) * 1000
        if elapsed_ms >= 100:
            _LOG.warning(
                "session save slow: %s (%d files, %d greps) %.1fms",
                cache.session_id[:16], len(cache.files), len(cache.greps), elapsed_ms,
            )
        else:
            _LOG.debug(
                "session saved: %s (%d files, %d greps) v%d %.1fms",
                cache.session_id[:16], len(cache.files), len(cache.greps),
                cache.version, elapsed_ms,
            )
        return

    if last_exc is not None:
        _LOG.warning(
            "session save failed after retries: %s (session=%s, files=%d, greps=%d) — "
            "marking cache unavailable to skip future save attempts",
            last_exc,
            cache.session_id[:16],
            len(cache.files),
            len(cache.greps),
        )
        cache.unavailable = True
        _record_cache_contention(cache.session_id, "save", last_exc)


# POSIX PATH_MAX on Linux; also the practical ceiling on Windows (MAX_PATH is 260,
# but the extended-length prefix \\?\ raises the limit to ~32 k — 4096 is a
# reasonable middle ground that fits any realistic path while bounding session-JSON
# size and log line length.
_MAX_PATH_LEN = 4096

# When the Read tool reports no limit (whole-file read), we record a range end
# that extends far enough to cover any realistic file.  This sentinel is chosen
# large enough to encompass files that tree-sitter can actually parse (~100 k lines)
# while remaining clearly artificial so grep/log output stands out.
# It must be ≥ any real end-line we might store; if it were too small, two reads
# of the same file could appear as non-overlapping ranges and fail to merge,
# causing the hint engine to incorrectly suggest the file has uncovered lines.
_UNKNOWN_END_SENTINEL = 99_999


def _sanitize_path(path: str) -> str:
    """Reject or normalise a file path before storing in the session cache.

    Absolute paths (used legitimately by Claude's Read tool) are allowed
    through.  Relative paths with ``..`` traversal components are rejected;
    the original value is returned unchanged so callers can log it, but a
    warning is emitted.  Null bytes are always stripped.
    """
    if not path:
        return path
    # Strip null bytes — never valid in a path
    path = path.replace("\x00", "")
    if len(path) > _MAX_PATH_LEN:
        _LOG.warning("mark_file: path exceeds max length (%d), truncating", _MAX_PATH_LEN)
        path = path[:_MAX_PATH_LEN]
    normalized = paths.normalize_key(path)
    # Relative paths must not contain traversal components
    is_absolute = normalized.startswith("/") or _has_windows_drive_prefix(normalized)
    if not is_absolute:
        parts = normalized.split("/")
        if ".." in parts:
            _LOG.warning("mark_file: rejected traversal path: %r", path)
            return ""
    return path


def _prepare_path_mutation(
    session_id: str,
    path: str,
    cache: SessionCache | None,
) -> tuple[SessionCache, str] | None:
    """Validate *path*, resolve the session cache, and return ``(cache, key)``.

    Shared prologue for :func:`mark_file_read` and :func:`mark_file_edited` —
    both functions perform the same four-step guard before doing their own work:

    1. Sanitize and reject empty paths.
    2. Resolve or load the session cache.
    3. Return early when the cache is marked unavailable.
    4. Normalize the path to a cache key.

    Returns ``None`` when the caller should bail out immediately (empty path or
    unavailable cache), or ``(cache, normalized_key)`` when it is safe to proceed.
    The caller is responsible for persisting the cache via :func:`save` after
    mutating it.
    """
    path = _sanitize_path(path)
    if not path:
        _LOG.debug("_prepare_path_mutation: empty path after sanitize (session=%s)", session_id[:16])
        return None
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        _LOG.debug("_prepare_path_mutation: session unavailable, skipping mutation (session=%s)", session_id[:16])
        return None
    return cache, _normalize_path(path)


def _commit_mutation(cache: SessionCache, now: float) -> SessionCache:
    """Stamp *now* as the last-activity time, flush the JSON cache, persist, and return.

    Every session mutation function ends with the same three-step epilogue:

    1. ``cache.last_activity_ts = now``   — keeps the session file fresh for TTL checks.
    2. ``cache._invalidate_json_cache()`` — forces re-serialization on the next save.
    3. ``save(cache)``                    — writes the JSON to disk.

    Centralising this avoids copy-pasting the same three lines across every
    ``mark_*`` function and makes the commit contract explicit.
    """
    cache.last_activity_ts = now
    cache._invalidate_json_cache()
    save(cache)
    return cache


def record_compact(session_id: str) -> None:
    """Record that a compaction just occurred for *session_id*.

    Sets ``last_compact_ts`` to the current time and persists the cache.
    Pre-read hooks use this timestamp to suppress re-read hints for files
    whose content no longer exists in the context window post-compact.
    """
    import time as _time  # noqa: PLC0415

    cache = safe_load(session_id, caller="record_compact")
    if cache is None:
        return
    cache.last_compact_ts = _time.time()
    save(cache)


def mark_file_read(
    session_id: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    *,
    symbol: str | None = None,
    cache: SessionCache | None = None,
    call_index: int | None = None,
) -> SessionCache:
    """Record that a file (or a named symbol within it) was read in this session.

    When *symbol* is supplied the read is recorded as a symbol-level access
    (e.g. ``token-goat read src/foo.py::MyClass``) and no line-range tracking
    is performed.

    When *symbol* is absent, *offset* and *limit* describe the slice that the
    Read tool delivered (0-indexed offset, line count).  These are converted to
    1-indexed inclusive ``(start, end)`` ranges and merged with any previously
    recorded ranges for the same file so the hint engine can report the total
    extent already in context.

    The pre-loaded *cache* is accepted as an optimisation: callers that already
    hold a ``SessionCache`` object can pass it in to skip the load-from-disk
    round-trip.  The returned cache is always saved to disk before returning.
    """
    prep = _prepare_path_mutation(session_id, path, cache)
    if prep is None:
        return cache or _fresh_cache(session_id)
    cache, key = prep
    entry = cache.files.get(key)
    now = time.time()
    if entry is None:
        _evict_oldest(cache.files, FILES_MAX, _FILES_EVICT, "files", session_id)
        entry = FileEntry(
            rel_or_abs=path, last_read_ts=now, read_count=0, line_ranges=[], symbols_read=[]
        )
        cache.files[key] = entry
    entry.read_count += 1
    entry.last_read_ts = now
    if call_index is not None:
        entry.last_read_call_index = call_index
    # Capture the file's on-disk fingerprint (mtime_ns, size) as of this read. A later
    # reread_deny compares it against the live stat to detect out-of-session edits: post_edit
    # records edits against the editing session's id, so when a sub-agent under a different
    # session_id modifies the file, this session's last_edit_ts never moves and a deny would
    # otherwise pin the model to stale content. Best-effort — an unstattable path leaves the
    # fingerprint at None (= unrecorded), which simply falls back to the prior deny behavior.
    try:
        _read_stat = os.stat(path)
        entry.read_mtime_ns = _read_stat.st_mtime_ns
        entry.read_size = _read_stat.st_size
    except OSError:
        pass
    # Increment per-file access frequency counter.  Capped at FILES_MAX to
    # match the cap on the files dict itself so one cannot grow without bound
    # while the other is evicted.  The count is incremented regardless of
    # whether the access is a full-file Read or a symbol-level surgical read.
    cache.file_access_counts[key] = cache.file_access_counts.get(key, 0) + 1
    if len(cache.file_access_counts) > FILES_MAX:
        _evict_oldest(cache.file_access_counts, FILES_MAX, _FILES_EVICT, "file_access_counts", session_id)
    if symbol:
        # Sanitize the symbol name before storing: it comes from harness tool_input
        # which is attacker-controlled.  Embedded newlines would split hint lines into
        # fake entries in LLM context; extreme lengths inflate the session JSON on disk.
        # sanitize_log_str strips \n/\r and caps length in one pass.
        symbol = sanitize_log_str(symbol, max_len=_MAX_SYMBOL_LEN)
        if not symbol:
            _LOG.debug("mark_file_read: symbol sanitized to empty string; skipping")
            return _commit_mutation(cache, now)
        # Cap the number of symbols tracked per file to prevent unbounded growth.
        if len(entry.symbols_read) >= _MAX_SYMBOLS_PER_FILE:
            _LOG.debug(
                "mark_file_read: symbols_read cap (%d) reached for %s; discarding %r",
                _MAX_SYMBOLS_PER_FILE,
                key,
                symbol,
            )
            return _commit_mutation(cache, now)
        # Direct list membership check — symbols_read is typically <10 entries so
        # the O(n) scan is cheaper than building a frozenset just to do one lookup.
        already_known = symbol in entry.symbols_read
        if not already_known:
            entry.symbols_read.append(symbol)
            _LOG.debug(
                "mark_file_read: symbol recorded %r in %s (total symbols=%d)",
                symbol,
                key,
                len(entry.symbols_read),
            )
        # Record or update the timestamp for this symbol (even if already known,
        # update ts to the latest access time for recency-based ranking).
        if not hasattr(entry, 'symbols_ts') or entry.symbols_ts is None:
            entry.symbols_ts = {}
        entry.symbols_ts[symbol] = now
        _LOG.debug(
            "mark_file_read: symbol %r timestamp recorded/updated to %.1f in %s",
            symbol,
            now,
            key,
        )
        # Increment per-symbol access frequency counter.
        sym_key = f"{key}::{symbol}"
        cache.symbol_access_counts[sym_key] = cache.symbol_access_counts.get(sym_key, 0) + 1
        # Cap the dict at FILES_MAX to prevent unbounded growth in pathological sessions.
        if len(cache.symbol_access_counts) > FILES_MAX:
            _evict_oldest(cache.symbol_access_counts, FILES_MAX, _FILES_EVICT, "symbol_access_counts", session_id)
    else:
        line_offset = min(max(0, int(offset)), _MAX_LINE_NUMBER) if offset is not None else 0
        line_limit = min(max(0, int(limit)), _MAX_LINE_NUMBER) if limit is not None else 0
        start = line_offset + 1  # Read tool's offset is 0-indexed; we store 1-indexed inclusive
        end = start + line_limit - 1 if line_limit else (start + _UNKNOWN_END_SENTINEL)
        prev_range_count = len(entry.line_ranges)
        # Check if we've hit the full-file collapse threshold BEFORE merging ranges.
        # If read_count (already incremented above) meets the threshold, collapse to
        # the sentinel [(0, 0)] to save JSON space. Do not merge further ranges.
        if entry.read_count >= _READ_COUNT_FULL_FILE_THRESHOLD:
            # Collapse to sentinel: (0, 0) means "full file tracked at high granularity".
            entry.line_ranges = [(0, 0)]
            _LOG.debug(
                "mark_file_read: line_ranges collapsed to full-file sentinel for %s "
                "(read_count=%d >= _READ_COUNT_FULL_FILE_THRESHOLD=%d)",
                key, entry.read_count, _READ_COUNT_FULL_FILE_THRESHOLD,
            )
        else:
            merged = _merge_ranges(entry.line_ranges + [(start, end)])
            if len(merged) > _MAX_LINE_RANGES_PER_FILE:
                # Collapse all spans into one spanning range to bound session JSON size.
                merged = [(merged[0][0], merged[-1][1])]
                _LOG.debug(
                    "mark_file_read: line_ranges collapsed to spanning range for %s "
                    "(exceeded _MAX_LINE_RANGES_PER_FILE=%d)",
                    key, _MAX_LINE_RANGES_PER_FILE,
                )
            entry.line_ranges = merged
        new_range_count = len(entry.line_ranges)
        if new_range_count < prev_range_count + 1:
            _LOG.debug(
                "mark_file_read: ranges merged for %s: added (%d-%d), "
                "consolidated %d→%d ranges",
                key,
                start,
                end,
                prev_range_count,
                new_range_count,
            )
        else:
            _LOG.debug(
                "mark_file_read: range (%d-%d) appended for %s (total ranges=%d)",
                start,
                end,
                key,
                new_range_count,
            )
    return _commit_mutation(cache, now)


# 200 chars covers any realistic grep pattern while blocking regex-bomb-sized
# strings from a malformed harness payload inflating every session JSON write.
_MAX_GREP_PATTERN_LEN = 200

# Maximum length of a symbol name stored in the session cache.  Symbol names come from
# harness tool_input (via ``token-goat read file::symbol``) and are later embedded in
# hint strings and the compaction manifest.  Embedded newlines would split hint lines
# into fake entries in LLM context; extreme lengths inflate the session JSON on disk.
_MAX_SYMBOL_LEN = 256

# Maximum number of symbol names tracked per file entry.  An adversarial or misbehaving
# harness could call ``token-goat read file::sym`` in a tight loop; without a cap the
# symbols_read list grows without bound, bloating session JSON and manifest output.
_MAX_SYMBOLS_PER_FILE = 50

# Maximum line number (1-indexed) stored in a FileEntry line-range.  The Read tool's
# ``offset`` and ``limit`` fields come from the harness payload (external input) and are
# converted to 1-indexed start/end before storage.  Without an upper cap, a crafted
# payload with offset=2**62 produces a line number that overflows JSON integer precision
# in some parsers, inflates session-JSON size on every save, and corrupts range-merge
# arithmetic.  100 million covers any file tree-sitter can realistically parse (~10 M
# lines) while keeping stored integers well within safe JSON/SQLite integer range.
_MAX_LINE_NUMBER = 100_000_000

# Maximum value stored for Grep result_count in the session cache.  The field arrives
# from the harness payload (external input) and is serialized to JSON on every save.
# Without a cap, a crafted payload could store an arbitrarily large integer, inflating
# session JSON and corrupting compaction-manifest output.  1 million is well above any
# realistic grep hit count (a repo-wide search rarely exceeds tens of thousands).
_MAX_RESULT_COUNT = 1_000_000

# Minimum result_count threshold mirrored from hints._GREP_DEDUP_MIN_RESULT_COUNT.
# Defined here as a local constant to avoid importing hints at module level
# (which would create a circular import: hints → session → hints).
# Keep in sync with hints._GREP_DEDUP_MIN_RESULT_COUNT.
_GREP_GLOBAL_MIN_RESULT_COUNT: int = 5


def _grep_pattern_hash(pattern: str) -> str:
    """Return a stable SHA-1 hex digest for *pattern*.

    Used as the primary key in global.db::grep_patterns.  SHA-1 is sufficient
    for collision-resistance at the scale of unique grep patterns (~thousands
    per project); storing a hash avoids using the raw pattern (up to
    ``_MAX_GREP_PATTERN_LEN`` = 200 chars) as the primary key.
    """
    return hashlib.sha1(pattern.encode("utf-8", errors="replace")).hexdigest()  # noqa: S324


def mark_grep(
    session_id: str,
    pattern: str,
    path: str | None = None,
    result_count: int | None = None,
    *,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Grep call. Returns the updated cache."""
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        return cache
    now = time.time()
    # Cap pattern length before storage: an unbounded pattern from a harness
    # payload could inflate the session JSON file on every Grep call.
    safe_pattern = pattern[:_MAX_GREP_PATTERN_LEN] if len(pattern) > _MAX_GREP_PATTERN_LEN else pattern
    entry = GrepEntry(pattern=safe_pattern, path=path, ts=now, result_count=result_count)
    _append_to_list_history(
        cache.greps,
        entry,
        GREPS_HISTORY_MAX,
        _GREPS_HISTORY_EVICT,
        "greps",
        session_id,
    )
    _LOG.debug(
        "mark_grep: pattern=%r path=%r results=%s (session=%s total_greps=%d)",
        sanitize_log_str(safe_pattern[:60], max_len=_MAX_LOG_STR),
        path,
        result_count,
        session_id[:16],
        len(cache.greps),
    )
    # Cross-session dedup: update global.db grep_patterns when result_count
    # meets the dedup threshold.  The write is amortized (~1/day per unique
    # pattern) inside db.update_global_grep_pattern.  Use a lazy import to
    # avoid the circular dependency (hints → session → hints at module level).
    if result_count is not None and result_count >= _GREP_GLOBAL_MIN_RESULT_COUNT:
        from . import db as _db  # noqa: PLC0415
        _db.update_global_grep_pattern(_grep_pattern_hash(safe_pattern), safe_pattern, now)
    return _commit_mutation(cache, now)


def mark_glob_run(
    session_id: str,
    pattern: str,
    path: str | None = None,
    result_count: int | None = None,
    *,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Glob call. Returns the updated cache.

    Stores the pattern (capped at :data:`_MAX_GLOB_PATTERN_LEN` to bound session
    JSON size) along with the optional scoping *path* and the number of matches.
    FIFO eviction keeps the :data:`GLOB_HISTORY_MAX` most recent entries.
    """
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        return cache
    now = time.time()
    safe_pattern = pattern[:_MAX_GLOB_PATTERN_LEN] if len(pattern) > _MAX_GLOB_PATTERN_LEN else pattern
    entry = GlobEntry(pattern=safe_pattern, path=path, ts=now, result_count=result_count)
    _append_to_list_history(
        cache.glob_history,
        entry,
        GLOB_HISTORY_MAX,
        _GLOB_HISTORY_EVICT,
        "glob_history",
        session_id,
    )
    _LOG.debug(
        "mark_glob_run: pattern=%r path=%r results=%s (session=%s total_globs=%d)",
        sanitize_log_str(safe_pattern[:60], max_len=_MAX_LOG_STR),
        path,
        result_count,
        session_id[:16],
        len(cache.glob_history),
    )
    return _commit_mutation(cache, now)


def lookup_glob_entry(
    session_id: str,
    pattern: str,
    path: str | None = None,
    *,
    cache: SessionCache | None = None,
) -> GlobEntry | None:
    """Return the most recent GlobEntry for *pattern* in this session, or None.

    Scans ``glob_history`` in reverse-chronological order so the most recent
    matching entry is found first.  Matches on both *pattern* and *path* so
    ``Glob("**/*.py")`` and ``Glob("**/*.py", path="src/")`` are tracked
    independently.  Returns ``None`` when no prior run is recorded.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable or not cache.glob_history:
        return None
    for entry in reversed(cache.glob_history):
        if entry.pattern == pattern and entry.path == path:
            return entry
    return None


def lookup_grep_entry(
    session_id: str,
    pattern: str,
    path: str | None = None,
    *,
    cache: SessionCache | None = None,
) -> GrepEntry | None:
    """Return the most recent GrepEntry for *pattern* in this session, or None.

    Scans ``greps`` in reverse-chronological order so the most recent matching
    entry is found first.  Matches on both *pattern* and *path*.
    Returns ``None`` when no prior run is recorded.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable or not cache.greps:
        return None
    for entry in reversed(cache.greps):
        if entry.pattern == pattern and entry.path == path:
            return entry
    return None


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Coalesce overlapping and adjacent (start, end) line-range pairs.

    Two ranges are merged when they overlap (start_b <= end_a) or are
    directly adjacent (start_b == end_a + 1) — reading lines 1-10 then
    11-20 is equivalent to reading 1-20 and should be tracked as a single
    span.  Input ranges need not be sorted or deduplicated; the output list
    is always sorted ascending with no overlaps.

    Example::

        _merge_ranges([(5, 10), (1, 6), (15, 20)])
        # → [(1, 10), (15, 20)]
    """
    if not ranges:
        return []
    # Fast path: a single range is already sorted and merged by definition.
    # This is the common case early in a session before many reads accumulate.
    if len(ranges) == 1:
        # A single range has no peer to overlap or be adjacent to, so it is
        # trivially sorted and merged.  Wrapping in list() gives a fresh copy.
        return list(ranges)
    sorted_r = sorted(ranges)
    out: list[tuple[int, int]] = [sorted_r[0]]
    for start, end in sorted_r[1:]:
        last_start, last_end = out[-1]
        if start <= last_end + 1:
            out[-1] = (last_start, max(last_end, end))
        else:
            out.append((start, end))
    return out


def get_file_entry(
    session_id: str, path: str, *, cache: SessionCache | None = None
) -> FileEntry | None:
    """Get a file entry by path, or None if not found."""
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        return None
    return cache.files.get(_normalize_path(path))


def reset_session(session_id: str) -> None:
    """Wipe the cache for a session (called by SessionStart on /clear / compact).

    Validates session_id before use (defense-in-depth: paths.session_cache_path
    also validates, but an explicit guard here makes the invariant obvious at the
    call site and prevents future callers from bypassing path-level checks).

    Also clears any per-session content snapshots written by the post-read
    hook so the diff-aware re-read hint engine cannot serve stale diffs that
    pre-date the reset.
    """
    validate_session_id(session_id)
    p = paths.session_cache_path(session_id)
    if p.exists():
        try:
            p.unlink()
        except OSError as e:
            _LOG.warning("failed to delete session cache %s: %s", p, e)
    # Snapshot directory cleanup is best-effort and isolated; failures must
    # not propagate up because they are inconsequential to session correctness.
    try:
        from . import snapshots  # noqa: PLC0415

        snapshots.cleanup_session(session_id)
    except Exception:  # noqa: BLE001
        _LOG.debug("reset_session: snapshot cleanup failed", exc_info=True)


def mark_file_edited(
    session_id: str, path: str, *, cache: SessionCache | None = None
) -> SessionCache:
    """Record that a file was edited (written/modified) this session.

    Also stamps ``last_edit_ts`` on the matching ``FileEntry`` (if one exists)
    so that the pre-read hint engine can detect "edited after last read" and
    suppress its line-range dedup nudges — those line numbers shift the moment
    an edit inserts or removes a line, making the cached ranges actively
    misleading rather than helpful.
    """
    prep = _prepare_path_mutation(session_id, path, cache)
    if prep is None:
        return cache or _fresh_cache(session_id)
    cache, key = prep
    now = time.time()
    prev_count = cache.edited_files.get(key, 0)
    if prev_count == 0:
        _evict_oldest(cache.edited_files, EDITED_FILES_MAX, _EDITED_FILES_EVICT, "edited_files", session_id)
    cache.edited_files[key] = prev_count + 1
    # Stamp last_edit_ts on the read entry too (if any) so build_read_hint can
    # detect "edited after last read" without an extra dict lookup on each
    # pre-read call.  Edits to files never read this session leave the read map
    # untouched — there is nothing to invalidate in that case.
    entry = cache.files.get(key)
    if entry is not None:
        entry.last_edit_ts = now
    # Clear the per-file hint cooldown so the next Read after an edit is
    # eligible to receive a fresh session hint (hint content changes when the
    # file changes, so the cooldown must not suppress the updated hint).
    cache.clear_session_hint_cooldown(key)
    _LOG.debug(
        "mark_file_edited: %s (edit #%d this session, total edited files=%d)",
        key,
        prev_count + 1,
        len(cache.edited_files),
    )
    return _commit_mutation(cache, now)


def list_edited(session_id: str) -> dict[str, int]:
    """Return edited files for this session: normalized_path → edit count."""
    return load(session_id).edited_files


def list_touched(session_id: str) -> list[FileEntry]:
    """List all files touched in a session, sorted by last read time (newest first)."""
    cache = load(session_id)
    return sorted(cache.files.values(), key=_BY_LAST_READ_TS, reverse=True)


def _result_cache_key(rel_path: str, item: str, kind: str) -> str:
    """Build the dict key for the in-session result cache.

    Combines normalized path, item name (symbol or section heading), and kind
    so that ``read_symbol("foo.py", "bar")`` and ``read_section("foo.py", "bar")``
    do not collide.  Path is normalized so backslash/forward-slash and drive-letter
    case differences map to the same cache entry on Windows.
    """
    return f"{kind}\x1f{_normalize_path(rel_path)}\x1f{item}"


def get_result_cache(
    session_id: str,
    rel_path: str,
    item: str,
    kind: str,
    file_sha: str,
    *,
    cache: SessionCache | None = None,
) -> dict[str, Any] | None:
    """Return a cached result dict when one exists for this (rel_path, item, kind, sha).

    Returns None on cache miss, on SHA mismatch (file changed since cache write),
    or when the session cache is unavailable.  ``file_sha`` is the SHA of the file's
    current contents on disk; when it differs from the stored SHA the entry is
    considered stale and dropped so the next call recomputes.

    Returns a fresh shallow copy of the result dict so callers can mutate it
    without leaking changes back into the cache.
    """
    try:
        validate_session_id(session_id)
    except ValueError:
        return None
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        return None
    key = _result_cache_key(rel_path, item, kind)
    entry = cache.result_cache.get(key)
    if entry is None:
        return None
    if entry.file_sha != file_sha:
        # SHA mismatch — the file changed since we cached this slice; drop the
        # stale entry so we do not keep checking it on every lookup and so the
        # next put_result_cache call can re-insert the fresh value.
        _LOG.debug(
            "result_cache: stale entry for %s (sha %s != %s); dropping",
            key, entry.file_sha[:8], file_sha[:8],
        )
        del cache.result_cache[key]
        _commit_mutation(cache, time.time())
        return None
    _LOG.debug("result_cache: hit for %s (kind=%s sha=%s)", key, kind, file_sha[:8])
    return dict(entry.result)


def put_result_cache(
    session_id: str,
    rel_path: str,
    item: str,
    kind: str,
    file_sha: str,
    result: dict[str, Any],
    *,
    cache: SessionCache | None = None,
) -> None:
    """Store *result* in the in-session cache under (rel_path, item, kind).

    Enforces the RESULT_CACHE_MAX cap by evicting the oldest _RESULT_CACHE_EVICT
    entries (FIFO via dict insertion order) when the cap is reached.  Updating
    an existing key preserves its insertion position so the new value does not
    jump to the front of the eviction queue — this matches the "first inserted,
    first evicted" semantics callers expect.
    """
    try:
        validate_session_id(session_id)
    except ValueError:
        return
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
        return
    if kind not in ("symbol", "section"):
        _LOG.debug("put_result_cache: rejecting unknown kind %r", kind)
        return
    key = _result_cache_key(rel_path, item, kind)
    # Evict oldest entries when at capacity — but only on a fresh insertion.
    # Updates to an existing key reuse the slot and never trigger eviction.
    if key not in cache.result_cache:
        _evict_oldest(cache.result_cache, RESULT_CACHE_MAX, _RESULT_CACHE_EVICT, "result_cache", session_id)
    cache.result_cache[key] = ResultCacheEntry(
        file_sha=file_sha,
        kind=kind,
        result=dict(result),  # shallow copy — defensive against caller mutating after store
        ts=time.time(),
    )
    _commit_mutation(cache, time.time())
    _LOG.debug(
        "result_cache: stored %s (kind=%s sha=%s size=%d)",
        key, kind, file_sha[:8], len(cache.result_cache),
    )


def mark_bash_run(
    session_id: str,
    cmd_sha: str,
    cmd_preview: str,
    output_id: str,
    stdout_bytes: int,
    stderr_bytes: int,
    exit_code: int | None,
    truncated: bool,
    *,
    output_sha: str = "",
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Bash invocation in the per-session history.

    *cmd_sha* is a short content-derived identifier (see :func:`bash_cache.command_hash`).
    Storing only the SHA — not the full command — keeps the session JSON small
    and avoids persisting potentially sensitive command arguments
    (credentials, file paths) longer than necessary.  ``cmd_preview`` is the
    first 120 characters of the command, which is enough to identify a re-run
    while remaining bounded.

    *output_sha* is the content hash of post-compression stdout+stderr
    (first 16 hex chars) for content-aware dedup. Empty string for backward compat.

    FIFO eviction batches removals at ``_BASH_HISTORY_EVICT`` so a hot retry
    loop does not rewrite the dict on every single insert.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError as exc:
        _LOG.warning("mark_bash_run: invalid session_id (%s); skipping", exc)
        return cache or _fresh_cache(session_id)
    if cache.unavailable:
        return cache

    # Sanitize the preview before storage: command strings can contain newlines
    # (here-docs) and bidi controls that would corrupt the manifest output.
    safe_preview = sanitize_log_str(cmd_preview, max_len=_MAX_BASH_PREVIEW)

    now = time.time()
    prior_run_count = cache.bash_history[cmd_sha].run_count if cmd_sha in cache.bash_history else 0
    entry = BashEntry(
        cmd_sha=cmd_sha,
        cmd_preview=safe_preview,
        output_id=output_id,
        ts=now,
        stdout_bytes=max(0, int(stdout_bytes)),
        stderr_bytes=max(0, int(stderr_bytes)),
        exit_code=exit_code if is_real_int(exit_code) else None,
        truncated=bool(truncated),
        run_count=prior_run_count + 1,
        output_sha=output_sha if isinstance(output_sha, str) else "",
    )
    _append_to_dict_history(
        cache.bash_history,
        cmd_sha,
        entry,
        BASH_HISTORY_MAX,
        _BASH_HISTORY_EVICT,
        "bash_history",
        session_id,
    )
    return _commit_mutation(cache, now)


def _lookup_in_cache(
    session_id: str,
    accessor: Callable[[SessionCache], dict[str, _V]],
    key: str,
    cache: SessionCache | None,
) -> _V | None:
    """Resolve *session_id*, guard on unavailable, then return ``accessor(cache).get(key)``.

    Shared by :func:`lookup_bash_entry`, :func:`lookup_web_entry`, and
    :func:`lookup_skill_entry` — they differ only in which dict field is accessed.
    Returns ``None`` on invalid session_id (ValueError) or unavailable cache.

    The generic parameter ``_V`` ties the return type to the dict value type
    declared by *accessor*, so callers get a typed result without a cast.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable:
        return None
    return accessor(cache).get(key)


def lookup_bash_entry(
    session_id: str, cmd_sha: str, *, cache: SessionCache | None = None
) -> BashEntry | None:
    """Return the :class:`BashEntry` for *cmd_sha* in *session_id*, or None."""
    return _lookup_in_cache(session_id, lambda c: c.bash_history, cmd_sha, cache)


def mark_web_fetch(
    session_id: str,
    url_sha: str,
    url_preview: str,
    output_id: str,
    body_bytes: int,
    status_code: int | None,
    truncated: bool,
    *,
    content_type: str | None = None,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a WebFetch invocation in the per-session history.

    Mirrors :func:`mark_bash_run` for the WebFetch surface.  Storing only the
    short URL SHA — not the full URL — keeps the session JSON small and
    avoids persisting potentially-sensitive query parameters (auth tokens,
    presigned URL signatures) longer than necessary.  ``url_preview`` is the
    first 200 chars of the URL, which is enough to identify a repeat fetch
    while remaining bounded.  ``content_type`` is the MIME type from the
    response when captured.

    FIFO eviction batches removals at ``_WEB_HISTORY_EVICT`` so a tight
    re-fetch loop does not rewrite the dict on every insert.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError as exc:
        _LOG.warning("mark_web_fetch: invalid session_id (%s); skipping", exc)
        return cache or _fresh_cache(session_id)
    if cache.unavailable:
        return cache

    safe_preview = sanitize_log_str(url_preview, max_len=_MAX_WEB_URL_PREVIEW)

    now = time.time()
    entry = WebEntry(
        url_sha=url_sha,
        url_preview=safe_preview,
        output_id=output_id,
        ts=now,
        body_bytes=max(0, int(body_bytes)),
        status_code=(
            status_code
            if is_real_int(status_code)
            else None
        ),
        truncated=bool(truncated),
        content_type=content_type,
    )
    _append_to_dict_history(
        cache.web_history,
        url_sha,
        entry,
        WEB_HISTORY_MAX,
        _WEB_HISTORY_EVICT,
        "web_history",
        session_id,
    )
    return _commit_mutation(cache, now)


def lookup_web_entry(
    session_id: str, url_sha: str, *, cache: SessionCache | None = None
) -> WebEntry | None:
    """Return the :class:`WebEntry` for *url_sha* in *session_id*, or None."""
    return _lookup_in_cache(session_id, lambda c: c.web_history, url_sha, cache)


def mark_skill_loaded(
    session_id: str,
    skill_name: str,
    output_id: str,
    content_sha: str,
    body_bytes: int,
    truncated: bool,
    *,
    source_path: str = "",
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Skill tool load in the per-session history.

    Keyed by *skill_name* so repeat loads of the same skill update the existing
    entry (incrementing ``run_count``, refreshing ``ts``) rather than allocating
    a new slot.  When the cached body is replaced (``content_sha`` changed
    because the underlying skill file was updated between loads), the new
    ``output_id`` overwrites the old one — the most recent body wins.

    FIFO eviction batches removals at ``_SKILL_HISTORY_EVICT`` so a degenerate
    loop that loads many distinct skills never rewrites the dict on every
    insert.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError as exc:
        _LOG.warning("mark_skill_loaded: invalid session_id (%s); skipping", exc)
        return cache or _fresh_cache(session_id)
    if cache.unavailable:
        return cache

    safe_name = sanitize_log_str(skill_name, max_len=_MAX_SKILL_NAME_LEN)
    if not safe_name:
        _LOG.debug("mark_skill_loaded: skill_name sanitized to empty; skipping")
        return cache

    now = time.time()
    prior_run_count = (
        cache.skill_history[safe_name].run_count
        if safe_name in cache.skill_history
        else 0
    )
    entry = SkillEntry(
        skill_name=safe_name,
        output_id=output_id,
        content_sha=content_sha,
        ts=now,
        body_bytes=max(0, int(body_bytes)),
        truncated=bool(truncated),
        run_count=prior_run_count + 1,
        source_path=source_path,
    )
    _append_to_dict_history(
        cache.skill_history,
        safe_name,
        entry,
        SKILL_HISTORY_MAX,
        _SKILL_HISTORY_EVICT,
        "skill_history",
        session_id,
    )
    # Recompute aggregate token count so user_prompt_submit can estimate context
    # fill without iterating skill_history on every turn.  Keyed by skill_name, so
    # repeat loads of the same skill update the entry rather than double-counting.
    cache.loaded_skill_total_tokens = sum(
        getattr(e, "body_bytes", 0) for e in cache.skill_history.values()
    ) // 4
    return _commit_mutation(cache, now)


def lookup_skill_entry(
    session_id: str, skill_name: str, *, cache: SessionCache | None = None
) -> SkillEntry | None:
    """Return the :class:`SkillEntry` for *skill_name* in *session_id*, or None.

    Normalises *skill_name* through the same :func:`sanitize_log_str` call that
    :func:`mark_skill_loaded` uses when writing the entry, so the dict key used
    for the lookup is byte-for-byte identical to the key used at write time.
    Without this normalisation, a caller passing a raw skill name longer than
    :data:`_MAX_SKILL_NAME_LEN` (128 chars) would receive ``None`` even though
    the entry exists under the truncated form — breaking re-load detection.
    """
    safe_name = sanitize_log_str(skill_name, max_len=_MAX_SKILL_NAME_LEN)
    if not safe_name:
        return None
    return _lookup_in_cache(session_id, lambda c: c.skill_history, safe_name, cache)


def get_skill_history(
    session_id: str,
    *,
    cache: SessionCache | None = None,
) -> dict[str, SkillEntry] | None:
    """Return the skill_history dict for *session_id*, or None on error.

    Returns a shallow reference to the dict (not a copy) so callers can
    iterate quickly without allocating.  Read-only callers must not mutate
    the returned dict.  Returns ``None`` when the session is unavailable or
    the skill_history field is absent.
    """
    try:
        resolved = _resolve_cache(session_id, cache)
        if resolved.unavailable:
            return None
        return resolved.skill_history or None
    except Exception:  # noqa: BLE001
        return None


def record_skill_compact_hit(
    session_id: str,
    skill_name: str,
    *,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Increment the ``compact_served_count`` for *skill_name* in *session_id*.

    Called by the compact manifest renderer each time it inlines a skill's
    compact form into the PreCompact manifest.  Tracking hits per skill per
    session lets ``token-goat skill-list`` show which compacts are actively
    saving context versus ones that were generated but never retrieved.

    Fails silently when the entry does not exist yet (race between the
    PostToolUse hook and an early manifest build) or when the session is
    unavailable.  Never raises — this is a best-effort metric.
    """
    try:
        safe_name = sanitize_log_str(skill_name, max_len=_MAX_SKILL_NAME_LEN)
        if not safe_name:
            return cache or _fresh_cache(session_id)
        resolved = _resolve_cache(session_id, cache)
        if resolved.unavailable:
            return resolved
        existing = resolved.skill_history.get(safe_name)
        if existing is None:
            return resolved
        now = time.time()
        updated = SkillEntry(
            skill_name=existing.skill_name,
            output_id=existing.output_id,
            content_sha=existing.content_sha,
            ts=existing.ts,
            body_bytes=existing.body_bytes,
            truncated=existing.truncated,
            run_count=existing.run_count,
            source_path=existing.source_path,
            compact_served_count=existing.compact_served_count + 1,
        )
        resolved.skill_history[safe_name] = updated
        return _commit_mutation(resolved, now)
    except Exception:  # noqa: BLE001
        _LOG.debug("record_skill_compact_hit: failed for skill %s", sanitize_log_str(skill_name, max_len=80))
        return cache or _fresh_cache(session_id)


def mark_decision(
    session_id: str,
    text: str,
    *,
    tag: str = "",
    cache: SessionCache | None = None,
) -> SessionCache:
    """Append a decision-log entry to *session_id* and persist the session cache.

    The append-only ``decisions`` list survives every compaction event — the
    compact manifest renderer surfaces the most recent entries in a dedicated
    section so the *why* behind in-flight work is recoverable alongside the
    *what* (edited files, blockers).

    *text* is stripped, sanitized, and trimmed to :data:`_MAX_DECISION_TEXT_LEN`.
    Empty/whitespace text is rejected (returns the cache unchanged with a debug
    log) — the entry would carry no signal.  *tag* is an optional short label
    capped at 24 characters; pass it to colour-prefix the entry ("rationale",
    "ruled-out", "invariant").  FIFO-capped at :data:`DECISION_HISTORY_MAX`.
    """
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError as exc:
        _LOG.warning("mark_decision: invalid session_id (%s); skipping", exc)
        return cache or _fresh_cache(session_id)
    if cache.unavailable:
        return cache

    # Strip leading/trailing whitespace BEFORE sanitization so a caller passing
    # ``" \n\t "`` is rejected as empty.  sanitize_log_str escapes ``\n`` to the
    # two-char literal ``\\n`` which would otherwise survive a post-sanitize
    # ``.strip()`` and produce a noise entry.  After the empty check we still
    # sanitize (defence-in-depth against bidi controls and log injection) and
    # apply a precise slice — sanitize_log_str appends a ``…`` truncation marker
    # that overshoots ``max_len`` by one character, which a naive use would
    # silently exceed the per-entry cap by.
    stripped_text = text.strip() if isinstance(text, str) else ""
    if not stripped_text:
        _LOG.debug("mark_decision: text sanitized to empty; skipping")
        return cache
    sanitized_text = sanitize_log_str(stripped_text, max_len=_MAX_DECISION_TEXT_LEN * 2)
    safe_text = sanitized_text[:_MAX_DECISION_TEXT_LEN]
    if not safe_text:
        _LOG.debug("mark_decision: text sanitized to empty; skipping")
        return cache
    if tag:
        stripped_tag = tag.strip()
        if stripped_tag:
            sanitized_tag = sanitize_log_str(stripped_tag, max_len=48)
            safe_tag = sanitized_tag[:24]
        else:
            safe_tag = ""
    else:
        safe_tag = ""

    now = time.time()
    entry = DecisionEntry(text=safe_text, ts=now, tag=safe_tag)
    cache.decisions.append(entry)
    # Batched FIFO eviction when the cap is exceeded — same shape as the
    # bash/web history paths.  Trims oldest entries (head of the list).
    if len(cache.decisions) > DECISION_HISTORY_MAX:
        excess = len(cache.decisions) - DECISION_HISTORY_MAX + _DECISION_HISTORY_EVICT
        del cache.decisions[: max(1, excess)]
    return _commit_mutation(cache, now)


def set_snapshot_sha(
    session_id: str,
    file_path: str,
    content_sha: str,
    *,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record that a snapshot for *file_path* with hash *content_sha* exists on disk.

    Stored separately from :attr:`SessionCache.files` so the snapshot index can
    be queried without loading file entries, and so a missing/empty snapshot
    does not invalidate the read-tracking state.
    """
    prep = _prepare_path_mutation(session_id, file_path, cache)
    if prep is None:
        return cache or _fresh_cache(session_id)
    cache, key = prep
    if key not in cache.snapshot_shas:
        _evict_oldest(cache.snapshot_shas, SNAPSHOT_SHAS_MAX, _SNAPSHOT_SHAS_EVICT, "snapshot_shas", session_id)
    cache.snapshot_shas[key] = content_sha
    return _commit_mutation(cache, time.time())


def get_snapshot_sha(
    session_id: str, file_path: str, *, cache: SessionCache | None = None
) -> str | None:
    """Return the stored snapshot SHA for *file_path*, or None when absent."""
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable:
        return None
    return cache.snapshot_shas.get(_normalize_path(file_path))


def cleanup_stale(max_age_hours: float = 24.0) -> int:
    """Delete session cache files older than max_age_hours. Returns count removed.

    Also removes companion sidecar files (``.json.lock``, ``.json.flock``) that
    were left behind by the cross-process lock mechanism.  These sidecars share
    the same stem as their session JSON and accumulate when a session's JSON is
    deleted (or when a crash left an unreleased lock file).  Removing them here
    prevents the sessions directory from growing without bound over long-running
    installations.
    """
    removed = 0
    sessions_dir = paths.session_cache_path("dummy").parent
    if not sessions_dir.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    examined = 0
    for f in sessions_dir.glob("*.json"):
        examined += 1
        # Validate that the filename matches the session-ID pattern before
        # touching it.  The sessions directory is user-writable; a planted file
        # with a crafted name (including symlinks) could otherwise be caught by
        # the glob and unlinked.  We also skip symlinks explicitly: unlinking a
        # symlink removes the link itself, not the target, which is safe, but
        # there is no legitimate reason for a session cache entry to be a symlink.
        stem = f.stem  # filename without .json suffix
        if not _SESSION_ID_RE.match(stem):
            _LOG.debug("cleanup_stale: skipping non-session-ID filename %r", f.name)
            continue
        # Use os.lstat() once to get both symlink status and mtime in a single
        # syscall, avoiding the separate is_symlink() + stat() pair (two syscalls).
        try:
            st = os.lstat(f)
        except OSError as e:
            _LOG.debug("cleanup_stale: could not stat %s: %s", f.name, e)
            continue
        if _stat_module.S_ISLNK(st.st_mode):
            _LOG.warning("cleanup_stale: skipping symlink in sessions dir: %s", f.name)
            continue
        try:
            if st.st_mtime < cutoff:
                f.unlink()
                removed += 1
                # Remove companion lock/flock sidecars for this session so they
                # do not accumulate after the session JSON is gone.
                for sidecar_suffix in (".json.lock", ".json.flock"):
                    sidecar = f.with_suffix(sidecar_suffix)
                    with contextlib.suppress(OSError):
                        sidecar.unlink(missing_ok=True)
        except OSError as e:
            _LOG.debug("cleanup_stale: could not remove %s: %s", f.name, e)

    # Also sweep orphaned lock/flock sidecars whose corresponding .json was
    # removed in a prior run (or never existed).  These are safe to delete
    # because a live hook process will recreate the sidecar atomically on its
    # next save — missing sidecar → lock attempt proceeds normally.
    for sidecar_suffix in ("*.json.lock", "*.json.flock"):
        for sidecar in sessions_dir.glob(sidecar_suffix):
            stem = sidecar.name.split(".json.")[0]  # e.g. "abc-123" from "abc-123.json.lock"
            if not _SESSION_ID_RE.match(stem):
                continue
            corresponding_json = sessions_dir / f"{stem}.json"
            if not corresponding_json.exists():
                with contextlib.suppress(OSError):
                    sidecar.unlink(missing_ok=True)
                    _LOG.debug("cleanup_stale: removed orphaned sidecar %s", sidecar.name)

    # Sweep orphaned .tmp files left by atomic_write_text() after a hard kill
    # (SIGKILL / power cut) between the temp-file creation and the rename.
    # The temp name pattern is: <session-id>.json.<thread-id>.<monotonic-ns>.tmp
    # Restrict by age to avoid clobbering a temp file that is actively being
    # written in another thread.
    _TMP_RE = re.compile(r"^([a-zA-Z0-9_-]+)\.json\.\d+\.\d+\.tmp$")
    for tmp_file in sessions_dir.glob("*.json.*.tmp"):
        m = _TMP_RE.match(tmp_file.name)
        if m is None:
            continue
        try:
            st = os.lstat(tmp_file)
        except OSError:
            continue
        if _stat_module.S_ISLNK(st.st_mode):
            continue
        if st.st_mtime < cutoff:
            with contextlib.suppress(OSError):
                tmp_file.unlink(missing_ok=True)
                _LOG.debug("cleanup_stale: removed orphaned tmp file %s", tmp_file.name)

    _LOG.info(
        "cleanup_stale: examined=%d removed=%d (max_age_hours=%.1f)",
        examined, removed, max_age_hours,
    )
    return removed


# ---------------------------------------------------------------------------
# Item 7: Adaptive hint suppression per category
# ---------------------------------------------------------------------------

def record_hint_category(cache: SessionCache, category: str, accepted: bool) -> None:
    """Record whether a hint in *category* was accepted (True) or ignored (False).

    Appends to the ring buffer for *category* in ``cache.hint_category_history``,
    capping at ``_HINT_CAT_HISTORY_MAX`` entries via FIFO eviction.  The buffer
    is not saved to disk here — callers must call ``save()`` when appropriate
    (the normal post-read save path handles this).

    Args:
        cache:    The live in-memory SessionCache to mutate.
        category: Hint category key (e.g. ``"session_hint"``, ``"bash_dedup_hint"``).
        accepted: True when the agent appeared to heed the hint (did not re-read
                  the hinted path in the next few tool calls); False otherwise.
    """
    if cache.unavailable:
        return
    hist = cache.hint_category_history.setdefault(category, [])
    hist.append(accepted)
    if len(hist) > _HINT_CAT_HISTORY_MAX:
        # FIFO: drop oldest entries from the front
        cache.hint_category_history[category] = hist[-_HINT_CAT_HISTORY_MAX:]
    cache._invalidate_json_cache()


def _hint_category_should_suppress(cache: SessionCache, category: str, threshold: int = 5) -> bool:
    """Return True when the last *threshold* hints in *category* were all ignored.

    Used by pre-read hook to skip emitting a hint whose category has a track
    record of being ignored.  Returns False (never suppress) when:
    - *threshold* <= 0 (feature disabled via config)
    - fewer than *threshold* entries exist for this category yet
    - any of the last *threshold* entries was accepted (True)

    Args:
        cache:     Live in-memory SessionCache.
        category:  Hint category key to check.
        threshold: Number of consecutive False entries required to suppress.
                   Defaults to 5; pass ``config.hints.suppress_after_ignored``.
    """
    if threshold <= 0:
        return False
    hist = cache.hint_category_history.get(category, [])
    if len(hist) < threshold:
        return False
    return not any(hist[-threshold:])
