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
    "HINTS_SEEN_MAX",
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
    "lookup_skill_entry",
    "lookup_web_entry",
    "mark_bash_run",
    "mark_decision",
    "mark_file_edited",
    "mark_file_read",
    "mark_glob_run",
    "mark_grep",
    "mark_skill_loaded",
    "mark_web_fetch",
    "put_result_cache",
    "record_hint_category",
    "reset_session",
    "save",
    "set_snapshot_sha",
    "safe_load",
    "validate_session_id",
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
]

import contextlib
import hashlib
import json
import os
import random
import re
import stat as _stat_module
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import islice
from operator import attrgetter
from pathlib import Path
from typing import Any, Final, TypedDict, TypeVar

from . import paths
from .hooks_common import is_real_int, sanitize_log_str
from .util import get_logger

_LOG = get_logger("session")

_T = TypeVar("_T")


def _coerce_ts(raw: Any) -> float:
    """Return *raw* as float if it is numeric, else 0.0."""
    return float(raw) if isinstance(raw, (int, float)) else 0.0


def _coerce_nonneg_int(raw: Any, default: int = 0) -> int:
    """Return ``int(raw)`` clamped to ≥ 0, or *default* on error."""
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return default


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
# Each session JSON gets a sidecar ``<session_id>.json.lock`` file used as a
# mutual-exclusion token between hook processes.  We use O_CREAT|O_EXCL for
# atomic creation — the process that wins the create owns the lock.  Stale
# lockfiles (empty/malformed content or PID gone) older than _LOCK_STALE_SECS
# are reclaimed automatically.
_LOCK_STALE_SECS: Final[float] = 30.0
# Maximum time (seconds) to spend waiting for a lock before giving up.
# Originally 2.0; raised to 5.0 because Windows pytest tmp-dir IO under concurrent
# load can push individual save() calls past 2 s, causing legitimate work to be
# dropped by the consecutive-timeout safety net. The hot path is unaffected
# (rare-event budget only kicks in when the lock is genuinely contended).
_LOCK_TIMEOUT_SECS: Final[float] = 5.0
# Poll interval when spinning for the lock. Jittered slightly inside the loop
# to prevent two starving processes from synchronising their polls.
_LOCK_POLL_SECS: Final[float] = 0.02
# Dedicated Random instance keeps the jitter deterministic per-process and
# independent of any seeded RNG state callers may have set globally.
_LOCK_JITTER: Final[random.Random] = random.Random()


def _session_lock_path(session_id: str) -> Path:
    """Return the lockfile path for *session_id*."""
    return paths.session_cache_path(session_id).with_suffix(".json.lock")


def _lock_is_stale(lock_path: Path) -> bool:
    """Return True if *lock_path* is stale and safe to reclaim.

    A lock is stale when:
    - It is older than _LOCK_STALE_SECS (process that created it is gone or
      frozen), OR
    - Its content is empty/malformed AND it is older than 5 seconds (empty
      file written then abandoned before the PID was recorded).
    """
    try:
        st = lock_path.stat()
    except OSError:
        return True  # already gone
    age = time.time() - st.st_mtime
    if age > _LOCK_STALE_SECS:
        return True
    # Empty/malformed content after 5 s → stale
    try:
        content = lock_path.read_text(encoding="utf-8").strip()
        if not content:
            return age > 5.0
        pid = int(content)
    except (OSError, ValueError):
        return age > 5.0
    # Reject obviously invalid PIDs before probing — os.kill(0, 0) raises
    # OSError on Windows and signals every process in the group on POSIX,
    # and Windows refuses PIDs outside the 32-bit unsigned range with
    # WinError 87. Either path can also surface as SystemError when the
    # interpreter is mid-exception. Treat any of those as "stale".
    if pid <= 0 or pid > 0xFFFFFFFF:
        return True
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return True
    except BaseException:  # noqa: BLE001
        # SystemError or any other unexpected wrapper from the C call —
        # be conservative and reclaim the lock rather than crash.
        return True
    return False


def _acquire_session_lock(session_id: str) -> int | None:
    """Acquire the cross-process lock for *session_id*.

    Returns the open file descriptor for the lockfile on success, or None if
    the lock could not be acquired within _LOCK_TIMEOUT_SECS.  The caller is
    responsible for calling :func:`_release_session_lock` with the returned fd.
    """
    lock_path = _session_lock_path(session_id)
    paths.ensure_dir(lock_path.parent)
    deadline = time.monotonic() + _LOCK_TIMEOUT_SECS
    while True:
        try:
            fd = os.open(
                str(lock_path),
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
            )
            # Write our PID so stale-check can verify liveness.
            # Retry once after a small delay if the first write fails.
            pid_bytes = str(os.getpid()).encode()
            try:
                os.write(fd, pid_bytes)
                # Flush to disk so a racing reader sees the full PID, not a
                # half-written prefix that would int-parse to a different PID
                # and confuse the stale-check.
                with contextlib.suppress(OSError):
                    os.fsync(fd)
            except OSError:
                time.sleep(0.01)
                try:
                    os.write(fd, pid_bytes)
                    with contextlib.suppress(OSError):
                        os.fsync(fd)
                except OSError:
                    # Both writes failed; lock file has no PID, making stale-check unreliable.
                    # Close fd and refuse the lock to avoid silent races.
                    with contextlib.suppress(OSError):
                        os.close(fd)
                    with contextlib.suppress(OSError):
                        lock_path.unlink(missing_ok=True)
                    _LOG.error("session lock PID write failed (retry); refusing lock: %s", session_id[:16])
                    return None
            return fd
        except (FileExistsError, OSError):
            pass
        # Lock exists — check if it is stale.
        if _lock_is_stale(lock_path):
            with contextlib.suppress(OSError):
                lock_path.unlink(missing_ok=True)
            continue  # retry create immediately
        if time.monotonic() >= deadline:
            _LOG.debug("session lock timeout: %s", session_id[:16])
            return None
        # Small jitter (±25%) on the poll interval — without it, two starving
        # processes settle into lockstep where they always check the lockfile
        # at the same moment, and the loser always loses.
        time.sleep(_LOCK_POLL_SECS * (0.75 + 0.5 * _LOCK_JITTER.random()))


def _release_session_lock(session_id: str, fd: int | None) -> None:
    """Release the cross-process lock acquired by :func:`_acquire_session_lock`."""
    lock_path = _session_lock_path(session_id)
    if fd is not None:
        with contextlib.suppress(OSError):
            os.close(fd)
    with contextlib.suppress(OSError):
        lock_path.unlink(missing_ok=True)


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
        merged.hints_seen = {}
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
    merged.hints_emitted = max(local.hints_emitted, remote.hints_emitted)
    merged.hints_ignored = max(local.hints_ignored, remote.hints_ignored)
    merged.structured_hints_emitted = max(local.structured_hints_emitted, remote.structured_hints_emitted)
    merged.index_only_hints_emitted = max(local.index_only_hints_emitted, remote.index_only_hints_emitted)

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
    merged.last_activity_ts = max(local.last_activity_ts, remote.last_activity_ts)

    # --- manifest delta-cache: take the newer emit ---
    if local.last_manifest_ts >= remote.last_manifest_ts:
        merged.last_manifest_sha = local.last_manifest_sha
        merged.last_manifest_ts = local.last_manifest_ts
    # else remote already has the newer manifest fields (kept from base)

    # cwd: prefer local (the hook that fired knows the current working directory).
    if local.cwd is not None:
        merged.cwd = local.cwd

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
    """

    url_sha: str
    url_preview: str
    output_id: str
    ts: float
    body_bytes: int
    status_code: int | None = None
    truncated: bool = False


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
    # Tracks which bash output_ids have been surfaced in a dedup hint this session.
    # Serialized as a sorted list[str] in JSON for stability; parsed back to set[str].
    # Used by compact.py to skip manifest entries that the agent already saw via hint.
    bash_dedup_emitted_ids: set[str] = field(default_factory=set)
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
    # Both fields are 0.0/0 for freshly-created (unsaved) caches.  Not persisted.
    _disk_mtime: float = field(default=0.0, repr=False, compare=False)
    _disk_size: int = field(default=0, repr=False, compare=False)
    # Dirty flag set by mark_hint_seen() to defer its save() until the next
    # post-read/post-bash/post-edit save() picks it up.  Not persisted.
    _pending_hint_save: bool = field(default=False, repr=False, compare=False)
    # Sorted-list cache for bash_dedup_emitted_ids.  Avoids repeated sorted()
    # calls in to_dict() when the set has not changed.  Invalidated by
    # _invalidate_json_cache() on any mutation.  Not persisted.
    _bash_dedup_sorted_cache: list[str] | None = field(default=None, repr=False, compare=False)

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
            bash_dedup_emitted_ids=self._get_bash_dedup_sorted(),
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
            cwd=self.cwd,
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
        # Enforce HINTS_SEEN_MAX by clearing when cap is exceeded.
        # False-positive re-emission of a suppressed hint is acceptable;
        # unbounded growth is not.
        if len(self.hints_seen) > HINTS_SEEN_MAX:
            self.hints_seen.clear()
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
        snapshot_shas: dict[str, str] = {}
        raw_snaps = d.get("snapshot_shas", {})
        if isinstance(raw_snaps, dict):
            for k, v in raw_snaps.items():
                if isinstance(k, str) and isinstance(v, str):
                    snapshot_shas[k] = v

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

        # bash_dedup_emitted_ids: list[str] (persisted) → set[str] (in-memory).
        # Missing in older sessions → empty set (no ids were tracked).
        bash_dedup_emitted_ids: set[str] = set()
        raw_dedup = d.get("bash_dedup_emitted_ids", [])
        if isinstance(raw_dedup, list):
            for oid in raw_dedup:
                if isinstance(oid, str) and oid:
                    bash_dedup_emitted_ids.add(oid)

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

        return cls(
            session_id=session_id,
            started_ts=float(d.get("started_ts", now)),
            last_activity_ts=float(d.get("last_activity_ts", now)),
            created_ts=float(d.get("created_ts", now)),
            files=files,
            greps=greps,
            edited_files=edited_files,
            result_cache=result_cache,
            bash_history=bash_history,
            glob_history=glob_history,
            web_history=web_history,
            skill_history=skill_history,
            decisions=decisions,
            snapshot_shas=snapshot_shas,
            hints_seen=hints_seen,
            bash_dedup_emitted_ids=bash_dedup_emitted_ids,
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
            cwd=str(d["cwd"]) if isinstance(d.get("cwd"), str) else None,
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
    return _serialize_pattern_entry(entry)  # type: ignore[return-value]


def _serialize_glob_entry(entry: GlobEntry) -> _GlobEntryDict:
    """Serialize a GlobEntry to its wire dict with rounded timestamp."""
    return _serialize_pattern_entry(entry)  # type: ignore[return-value]


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
    """Serialize a BashEntry to its wire dict with rounded timestamp."""
    return _BashEntryDict(
        cmd_sha=entry.cmd_sha,
        cmd_preview=entry.cmd_preview,
        output_id=entry.output_id,
        ts=_round_ts(entry.ts),
        stdout_bytes=entry.stdout_bytes,
        stderr_bytes=entry.stderr_bytes,
        exit_code=entry.exit_code,
        truncated=entry.truncated,
        run_count=entry.run_count,
        output_sha=entry.output_sha,
    )


def _serialize_web_entry(entry: WebEntry) -> _WebEntryDict:
    """Serialize a WebEntry to its wire dict with rounded timestamp."""
    return _WebEntryDict(
        url_sha=entry.url_sha,
        url_preview=entry.url_preview,
        output_id=entry.output_id,
        ts=_round_ts(entry.ts),
        body_bytes=entry.body_bytes,
        status_code=entry.status_code,
        truncated=entry.truncated,
    )


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
        return SkillEntry(
            skill_name=str(d.get("skill_name", "")),
            output_id=str(d.get("output_id", "")),
            content_sha=str(d.get("content_sha", "")),
            ts=_coerce_ts(d.get("ts", 0.0)),
            body_bytes=_coerce_nonneg_int(d.get("body_bytes", 0)),
            truncated=bool(d.get("truncated", False)),
            run_count=run_count,
            source_path=str(d.get("source_path", "")),
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
    edited_files: dict[str, int]
    result_cache: dict[str, _ResultCacheEntryDict]
    bash_history: dict[str, _BashEntryDict]
    glob_history: list[_GlobEntryDict]
    web_history: dict[str, _WebEntryDict]
    skill_history: dict[str, _SkillEntryDict]
    decisions: list[_DecisionEntryDict]
    snapshot_shas: dict[str, str]
    hints_seen: dict[str, int] | list[str]
    bash_dedup_emitted_ids: list[str]
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
    cwd: str | None


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
        fd = os.open(str(mark), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
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
    for _file_key, file_entry in data.get("files", {}).items():
        if not isinstance(file_entry, dict):
            continue
        if "symbols_ts" not in file_entry:
            file_entry["symbols_ts"] = {}
        if "last_edit_ts" not in file_entry:
            file_entry["last_edit_ts"] = 0.0

    return data


def _load_or_empty_json(path: Path) -> dict[str, object]:
    """Load JSON from *path*, returning empty dict on read or parse errors.

    Attempts to read and parse the file at *path* as JSON. If the file cannot
    be read (OSError) or parsed (JSONDecodeError), logs a debug message and
    returns an empty dict.

    Parameters
    ----------
    path
        The file path to read JSON from.

    Returns
    -------
    dict[str, object]
        The parsed JSON as a dict, or an empty dict on any error.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        _LOG.debug("load failed for %s: %s — returning empty", path, e)
        return {}


def load(session_id: str) -> SessionCache:
    """Load the on-disk session cache for *session_id*, or create a fresh one.

    Retries the file read up to three times with short sleeps to handle
    transient races on Windows (another hook may be writing the file).  On
    persistent failure or a missing file, returns a fresh empty cache.
    Corrupted JSON is treated the same as a missing file: the cache is reset
    rather than propagating an exception, because a stale hint is always
    preferable to a broken hook invocation.
    """
    validate_session_id(session_id)
    t0 = time.monotonic()
    p = paths.session_cache_path(session_id)

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
            return _fresh_cache(session_id)
        cache.unavailable = False
        # Record the on-disk fingerprint so save() can skip the CAS from_dict
        # round-trip when no concurrent writer has touched the file.
        try:
            st = p.stat()
            cache._disk_mtime = st.st_mtime
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


def save(cache: SessionCache) -> None:
    """Atomically persist the session cache to disk with cross-process CAS.

    Uses a sidecar ``.lock`` file for mutual exclusion between concurrent hook
    processes (one per tool call on Windows).  Within the critical section the
    on-disk version is re-read; if another process wrote a newer version while
    we held our in-memory copy, :func:`_merge_session_caches` re-applies our
    mutations on top of the remote state before writing.  This prevents the
    classic load-modify-save lost-update race.

    Retry budget: up to 3 attempts for the underlying ``atomic_write_text``;
    the lock itself has a 2-second timeout (see ``_LOCK_TIMEOUT_SECS``).  On
    total failure the cache is marked ``unavailable`` so future saves no-op.

    Lock-timeout handling: if ``_acquire_session_lock`` returns None (timeout)
    the save is aborted for that attempt.  After 3 consecutive lock timeouts the
    cache is marked unavailable to stop future save attempts.
    """
    if cache.unavailable:
        _LOG.debug("session save skipped (cache unavailable): %s", cache.session_id[:16])
        return
    t0 = time.monotonic()
    last_exc: OSError | None = None
    consecutive_lock_timeouts = 0

    for attempt in range(3):
        if attempt:
            time.sleep(0.05 * attempt)

        # _FILE_LOCK serializes same-process threads; the sidecar lockfile
        # serializes across processes.
        with _FILE_LOCK:
            lock_fd = _acquire_session_lock(cache.session_id)
            if lock_fd is None:
                # Cross-process lock timed out — skip this attempt but track
                # the consecutive count so we can bail after 3 failures.
                consecutive_lock_timeouts += 1
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
                if consecutive_lock_timeouts >= 3:
                    _LOG.warning(
                        "session save: 3 consecutive lock timeouts — "
                        "marking cache unavailable (session=%s)",
                        cache.session_id[:16],
                    )
                    cache.unavailable = True
                    return
                continue
            consecutive_lock_timeouts = 0
            try:
                # CAS: re-read on-disk state inside the lock.
                # Fast path: if the file's mtime+size match the fingerprint we
                # recorded at load(), no concurrent writer has touched it — skip
                # the from_dict round-trip and write directly.
                disk_cache: SessionCache | None = None
                p = paths.session_cache_path(cache.session_id)
                _skip_cas = False
                if cache._disk_mtime != 0.0 or cache._disk_size != 0:
                    try:
                        st = os.stat(p)
                        if st.st_mtime == cache._disk_mtime and st.st_size == cache._disk_size:
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

                try:
                    paths.atomic_write_text(p, cache.to_json())
                    # Update fingerprint so subsequent saves in the same process
                    # also benefit from the fast-path skip.
                    try:
                        st2 = os.stat(p)
                        cache._disk_mtime = st2.st_mtime
                        cache._disk_size = st2.st_size
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


def _symbols_set(entry: FileEntry) -> frozenset[str]:
    """Return a frozenset of already-read symbols for fast O(1) membership tests.

    Built inline from the list on each call; the list stays authoritative for
    serialization.  This helper is only called when a new symbol is being
    considered for addition — the common case (no new symbol) never pays this
    cost.  A frozenset is used rather than a set because its construction from
    a list is equally fast and it communicates immutability clearly.
    """
    return frozenset(entry.symbols_read)


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


def mark_file_read(
    session_id: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    *,
    symbol: str | None = None,
    cache: SessionCache | None = None,
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
        # _symbols_set() is retained for callers that do repeated lookups, but the
        # single-lookup case here avoids the frozenset allocation entirely.
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
    accessor: Callable[[SessionCache], dict[str, Any]],
    key: str,
    cache: SessionCache | None,
) -> Any | None:
    """Resolve *session_id*, guard on unavailable, then return ``accessor(cache).get(key)``.

    Shared by :func:`lookup_bash_entry`, :func:`lookup_web_entry`, and
    :func:`lookup_skill_entry` — they differ only in which dict field is accessed.
    Returns ``None`` on invalid session_id (ValueError) or unavailable cache.
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
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a WebFetch invocation in the per-session history.

    Mirrors :func:`mark_bash_run` for the WebFetch surface.  Storing only the
    short URL SHA — not the full URL — keeps the session JSON small and
    avoids persisting potentially-sensitive query parameters (auth tokens,
    presigned URL signatures) longer than necessary.  ``url_preview`` is the
    first 200 chars of the URL, which is enough to identify a repeat fetch
    while remaining bounded.

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
    return _commit_mutation(cache, now)


def lookup_skill_entry(
    session_id: str, skill_name: str, *, cache: SessionCache | None = None
) -> SkillEntry | None:
    """Return the :class:`SkillEntry` for *skill_name* in *session_id*, or None."""
    return _lookup_in_cache(session_id, lambda c: c.skill_history, skill_name, cache)


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
    """Delete session cache files older than max_age_hours. Returns count removed."""
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
        except OSError as e:
            _LOG.debug("cleanup_stale: could not remove %s: %s", f.name, e)
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
