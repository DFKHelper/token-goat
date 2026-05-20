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
    "FileEntry",
    "GrepEntry",
    "RESULT_CACHE_MAX",
    "ResultCacheEntry",
    "SESSION_SCHEMA_VERSION",
    "SessionCache",
    "WEB_HISTORY_MAX",
    "WebEntry",
    "get_file_entry",
    "get_result_cache",
    "list_edited",
    "list_touched",
    "load",
    "lookup_bash_entry",
    "lookup_web_entry",
    "mark_bash_run",
    "mark_file_edited",
    "mark_file_read",
    "mark_grep",
    "mark_web_fetch",
    "put_result_cache",
    "reset_session",
    "save",
    "validate_session_id",
]

import contextlib
import json
import logging
import os
import re
import stat as _stat_module
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from itertools import islice
from operator import attrgetter
from typing import Any, TypedDict, cast

from . import paths
from .hooks_common import sanitize_log_str

_LOG = logging.getLogger("token_goat.session")

SESSION_SCHEMA_VERSION = 1
_FILE_LOCK = threading.Lock()  # in-process; multi-process safe enough via atomic write
# Tracks (session_id, phase) pairs that have already logged a telemetry row for
# cache contention.  Prevents flooding global.db with one stats row per hook call
# when the session file becomes persistently unavailable (e.g. full disk).
# This dedup is per-process only — a fresh hook process (each tool call spawns one)
# starts with an empty set, so a single row per (session_id, phase) per process is
# recorded rather than strictly one row per session lifetime.
_REPORTED_CONTENTION: set[tuple[str, str]] = set()


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
    """

    rel_or_abs: str  # path as Claude requested it (relative or absolute)
    last_read_ts: float  # unix
    read_count: int  # number of times Read fired for this file
    line_ranges: list[tuple[int, int]]  # [(start, end), ...] of read ranges, 1-indexed inclusive
    symbols_read: list[str]  # via token-goat read file::symbol
    last_edit_ts: float = 0.0  # unix ts of last edit; 0.0 = never edited this session


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

# Cap for the in-session result cache.  100 entries is enough to cover a typical
# multi-hour Claude Code session — agents rarely re-ask for more than a few
# dozen distinct (file, symbol) slices.  When the cap is hit we evict the oldest
# entries (FIFO via dict insertion order) so a long-running session does not
# bloat session JSON without bound.
RESULT_CACHE_MAX = 100
# Number of entries to evict at once when the cap is hit.  Batch eviction
# (25 at a time) amortises the dict-rewrite cost across many cache inserts
# rather than reshuffling on every single insertion above the cap.
_RESULT_CACHE_EVICT = 25

# Maximum number of bash-history entries retained per session.  Each entry is
# tiny (well under 200 bytes), so 200 is comfortable; the cap exists to keep
# the session JSON size predictable in pathological loops (e.g. a watch-mode
# rerunning every few seconds).  FIFO eviction discards the oldest first.
BASH_HISTORY_MAX = 200
_BASH_HISTORY_EVICT = 50
# Length of the bash command preview persisted in session JSON.  Long enough
# to identify a command across re-runs ("pytest tests/test_x.py -k foo") but
# short enough to keep the manifest output bounded.
_MAX_BASH_PREVIEW = 120

# Maximum number of web-history entries retained per session, with the same
# FIFO-eviction semantics as bash history.  Web sessions tend to involve
# fewer distinct URLs than commands but bigger payloads on disk; the cap is
# chosen to mirror BASH_HISTORY_MAX so the operational mental model stays
# uniform between the two caches.
WEB_HISTORY_MAX = 200
_WEB_HISTORY_EVICT = 50
# Length of the URL preview persisted in session JSON.  200 covers any
# realistic page URL while keeping the per-entry footprint predictable.
_MAX_WEB_URL_PREVIEW = 200


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
    # Per-session web-fetch history keyed by short SHA of the URL.  Used by
    # the pre-WebFetch dedup hint and by ``token-goat web-history`` for
    # listing.  Same FIFO + cap semantics as bash_history.
    web_history: dict[str, WebEntry] = field(default_factory=dict)
    # Per-session content snapshots used by the diff-aware re-read hint.  Maps
    # normalized file path → SHA of the snapshot bytes stored on disk under
    # ``data_dir() / "session_snapshots" / <session_short> / <pathhash>.bin``.
    # Storing only the SHA here (not the bytes) keeps the session JSON small.
    snapshot_shas: dict[str, str] = field(default_factory=dict)
    # Per-session hint fingerprints to suppress duplicate hint injection within the
    # same session. Maps hint_fingerprint (hash of hint text) → bool; a set persisted
    # as list[str] for JSON serialization.  Cleared when session expires or approaches
    # time-to-live limits to avoid false-positive suppression on stale cached hints.
    hints_seen: set[str] = field(default_factory=set)
    # Working directory at session start, used by git diff operations in the manifest.
    # Optional — may be None if the session was created before this field was added.
    cwd: str | None = None
    unavailable: bool = field(default=False, repr=False, compare=False)
    # Internal: cached JSON string from last serialization — invalidated by any mutation.
    # Avoids O(N) re-serialization of files/greps dicts on every hook invocation when
    # the cache is loaded, mutated once, and immediately saved.  Not persisted to disk.
    _json_cache: str | None = field(default=None, repr=False, compare=False)

    def to_dict(self) -> _SessionDict:
        """Serialize to dict for JSON."""
        return _SessionDict(
            schema_version=SESSION_SCHEMA_VERSION,
            created_by="token-goat",
            session_id=self.session_id,
            started_ts=self.started_ts,
            last_activity_ts=self.last_activity_ts,
            files={k: cast("_FileEntryDict", asdict(v)) for k, v in self.files.items()},
            greps=[cast("_GrepEntryDict", asdict(g)) for g in self.greps],
            edited_files=self.edited_files,
            result_cache={
                k: cast("_ResultCacheEntryDict", asdict(v))
                for k, v in self.result_cache.items()
            },
            bash_history={
                k: cast("_BashEntryDict", asdict(v))
                for k, v in self.bash_history.items()
            },
            web_history={
                k: cast("_WebEntryDict", asdict(v))
                for k, v in self.web_history.items()
            },
            snapshot_shas=dict(self.snapshot_shas),
            hints_seen=sorted(self.hints_seen),  # sorted list for stable JSON
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

    def has_hint_fingerprint(self, fingerprint: str) -> bool:
        """Check if a hint fingerprint was already seen this session.

        Returns True if the fingerprint is in hints_seen, False otherwise.
        """
        return fingerprint in self.hints_seen

    def mark_hint_seen(self, fingerprint: str) -> None:
        """Record a hint fingerprint as seen this session, persisting to disk.

        Invalidates the JSON cache and persists to disk since we've mutated hints_seen.
        """
        if fingerprint not in self.hints_seen:
            self.hints_seen.add(fingerprint)
            self.last_activity_ts = time.time()
            self._invalidate_json_cache()
            save(self)

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

        web_history: dict[str, WebEntry] = {}
        for k, v in d.get("web_history", {}).items():
            if not isinstance(v, dict) or not isinstance(k, str):
                continue
            we_entry = _parse_web_entry(v)
            if we_entry is not None:
                web_history[k] = we_entry

        # snapshot_shas: dict[str, str] — coerce values defensively so a
        # malformed entry written by a future version (e.g. structured object)
        # is dropped silently rather than poisoning the lookup path.
        snapshot_shas: dict[str, str] = {}
        raw_snaps = d.get("snapshot_shas", {})
        if isinstance(raw_snaps, dict):
            for k, v in raw_snaps.items():
                if isinstance(k, str) and isinstance(v, str):
                    snapshot_shas[k] = v

        # hints_seen: list[str] (persisted) → set[str] (in-memory).  Coerce entries
        # to str defensively so a malformed entry is dropped silently.
        hints_seen: set[str] = set()
        raw_hints = d.get("hints_seen", [])
        if isinstance(raw_hints, list):
            for h in raw_hints:
                if isinstance(h, str) and h:
                    hints_seen.add(h)

        return cls(
            session_id=session_id,
            started_ts=float(d.get("started_ts", now)),
            last_activity_ts=float(d.get("last_activity_ts", now)),
            files=files,
            greps=greps,
            edited_files=edited_files,
            result_cache=result_cache,
            bash_history=bash_history,
            web_history=web_history,
            snapshot_shas=snapshot_shas,
            hints_seen=hints_seen,
        )


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

        return FileEntry(
            rel_or_abs=str(v.get("rel_or_abs", key)),
            last_read_ts=float(v.get("last_read_ts", now)),
            read_count=max(0, int(v.get("read_count", 0))),
            line_ranges=line_ranges,
            symbols_read=symbols_read,
            last_edit_ts=last_edit_ts,
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug(
            "session: skipping corrupted file entry for key %s: %s",
            sanitize_log_str(key, max_len=_MAX_LOG_STR),
            exc,
        )
        return None


def _parse_grep_entry(g: dict[str, Any]) -> GrepEntry | None:
    """Deserialize one grep-entry dict from JSON, returning None on any parse error.

    Narrows each field to the expected type before constructing ``GrepEntry`` so
    that unexpected JSON types don't silently become wrong-typed attributes.
    """
    try:
        raw_pattern = g.get("pattern", "")
        raw_path = g.get("path")
        raw_ts = g.get("ts", 0.0)
        raw_result_count = g.get("result_count")
        return GrepEntry(
            pattern=str(raw_pattern) if isinstance(raw_pattern, (str, int, float)) else "",
            path=str(raw_path) if isinstance(raw_path, str) else None,
            ts=float(raw_ts) if isinstance(raw_ts, (int, float)) else 0.0,
            result_count=(
                int(raw_result_count)
                if isinstance(raw_result_count, int) and not isinstance(raw_result_count, bool)
                else None
            ),
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug(
            "session: skipping corrupted grep entry (%s): %s",
            exc,
            sanitize_log_str(repr(g)[:120]),
        )
        return None


def _parse_result_cache_entry(v: dict[str, Any]) -> ResultCacheEntry | None:
    """Deserialize one result-cache entry from JSON, returning None on any parse error.

    The ``result`` field is stored as a plain dict; we accept any dict but reject
    non-dicts to prevent untrusted JSON from injecting arbitrary objects.  Empty
    or malformed entries are dropped silently — a stale cache miss is harmless
    (the slow path recomputes), while a corrupted entry could crash the hot path.
    """
    try:
        raw_sha = v.get("file_sha", "")
        raw_kind = v.get("kind", "")
        raw_result = v.get("result", {})
        raw_ts = v.get("ts", 0.0)
        if not isinstance(raw_result, dict):
            return None
        if not isinstance(raw_kind, str) or raw_kind not in ("symbol", "section"):
            return None
        return ResultCacheEntry(
            file_sha=str(raw_sha) if isinstance(raw_sha, (str, int, float)) else "",
            kind=raw_kind,
            result=dict(raw_result),  # shallow copy — JSON values are immutable scalars/dicts
            ts=float(raw_ts) if isinstance(raw_ts, (int, float)) else 0.0,
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted result cache entry: %s", exc)
        return None


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


class _WebEntryDict(TypedDict, total=False):
    """Wire format of a single WebEntry as it appears in the session JSON."""

    url_sha: str
    url_preview: str
    output_id: str
    ts: float
    body_bytes: int
    status_code: int | None
    truncated: bool


def _parse_web_entry(v: dict[str, Any]) -> WebEntry | None:
    """Deserialize one web-history dict from JSON, returning None on parse error.

    Defensive about every field: session JSON is user-readable on disk and
    could be corrupted, partially upgraded, or hand-edited.  A bad entry is
    dropped at debug level rather than crashing the session-load path.
    """
    try:
        raw_status = v.get("status_code")
        status_code: int | None = None
        if isinstance(raw_status, int) and not isinstance(raw_status, bool):
            status_code = raw_status
        return WebEntry(
            url_sha=str(v.get("url_sha", "")),
            url_preview=str(v.get("url_preview", "")),
            output_id=str(v.get("output_id", "")),
            ts=float(v.get("ts", 0.0)) if isinstance(v.get("ts", 0.0), (int, float)) else 0.0,
            body_bytes=max(0, int(v.get("body_bytes", 0))),
            status_code=status_code,
            truncated=bool(v.get("truncated", False)),
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted web entry: %s", exc)
        return None


def _parse_bash_entry(v: dict[str, Any]) -> BashEntry | None:
    """Deserialize one bash-history dict from JSON, returning None on parse error.

    Coerces every field defensively: the session JSON is user-readable on
    disk and could be corrupted, partially upgraded, or hand-edited.  A bad
    entry is dropped (logged at debug) rather than crashing the load path.
    """
    try:
        raw_exit = v.get("exit_code")
        exit_code: int | None = None
        if isinstance(raw_exit, int) and not isinstance(raw_exit, bool):
            exit_code = raw_exit
        raw_run_count = v.get("run_count", 1)
        run_count = max(1, int(raw_run_count)) if isinstance(raw_run_count, (int, float)) else 1
        return BashEntry(
            cmd_sha=str(v.get("cmd_sha", "")),
            cmd_preview=str(v.get("cmd_preview", "")),
            output_id=str(v.get("output_id", "")),
            ts=float(v.get("ts", 0.0)) if isinstance(v.get("ts", 0.0), (int, float)) else 0.0,
            stdout_bytes=max(0, int(v.get("stdout_bytes", 0))),
            stderr_bytes=max(0, int(v.get("stderr_bytes", 0))),
            exit_code=exit_code,
            truncated=bool(v.get("truncated", False)),
            run_count=run_count,
        )
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted bash entry: %s", exc)
        return None


class _FileEntryDict(TypedDict, total=False):
    """Wire format of a single FileEntry as it appears in the session JSON.

    ``last_edit_ts`` is optional (``total=False``) for backwards compat with
    session caches written by token-goat versions that predate the field.
    """

    rel_or_abs: str
    last_read_ts: float
    read_count: int
    line_ranges: list[list[int]]
    symbols_read: list[str]
    last_edit_ts: float


class _GrepEntryDict(TypedDict, total=False):
    """Wire format of a single GrepEntry as it appears in the session JSON."""

    pattern: str
    path: str | None
    ts: float
    result_count: int | None


class _SessionDict(TypedDict, total=False):
    """Wire format of a serialized SessionCache (written to / read from JSON on disk).

    ``result_cache``, ``bash_history``, ``snapshot_shas``, and ``hints_seen`` are optional
    (``total=False``) for backwards compatibility with session caches written
    by token-goat versions that predate these fields.  All other fields are
    still effectively required because :meth:`SessionCache.from_dict` supplies
    a default for each one.
    """

    schema_version: int
    created_by: str
    session_id: str
    started_ts: float
    last_activity_ts: float
    files: dict[str, _FileEntryDict]
    greps: list[_GrepEntryDict]
    edited_files: dict[str, int]
    result_cache: dict[str, _ResultCacheEntryDict]
    bash_history: dict[str, _BashEntryDict]
    web_history: dict[str, _WebEntryDict]
    snapshot_shas: dict[str, str]
    hints_seen: list[str]


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
    """Normalize a path for use as a cache key. Forward slashes; lowercase drive on Windows.

    Drive letters must be lowercased because the harness and the hook dispatcher
    can spawn separate processes that observe the same path with different cases
    (e.g. ``C:\\foo`` vs ``c:\\foo``).  Without normalization, post-read hooks
    writing ``C:\\`` and pre-read hooks reading ``c:\\`` miss the cache entirely,
    making hint deduplication ineffective for the most common Windows paths.

    Avoids constructing a Path object when the string contains no backslashes,
    which is the common case for absolute POSIX paths and already-normalized keys.
    The Path() round-trip was only needed to collapse mixed separators; a plain
    str.replace is sufficient and avoids the allocation on the hot pre-read path.
    """
    # Fast path: no backslashes — skip the Path allocation entirely.
    if "\\" not in p:
        if sys.platform == "win32" and _has_windows_drive_prefix(p) and p[0].isupper():
            return p[0].lower() + p[1:]
        return p
    s = p.replace("\\", "/")
    if sys.platform == "win32" and _has_windows_drive_prefix(s) and s[0].isupper():
        s = s[0].lower() + s[1:]
    return s


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

_MAX_LOG_STR = 120  # truncation limit for user-controlled values embedded in log messages


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
    """Record a best-effort telemetry row when the session cache is locked."""
    key = (session_id, phase)
    if key in _REPORTED_CONTENTION:
        return
    _REPORTED_CONTENTION.add(key)
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
            cache = SessionCache.from_dict(json.loads(raw))
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            _LOG.warning("session cache corrupted (%s); resetting", e)
            return _fresh_cache(session_id)
        cache.unavailable = False
        elapsed_ms = (time.monotonic() - t0) * 1000
        _LOG.info(
            "session opened: %s (resuming, %d files tracked, %d edited, %.1fms)",
            session_id[:16], len(cache.files), len(cache.edited_files), elapsed_ms,
        )
        return cache

    if read_error is not None:
        _LOG.debug("session cache unavailable (%s); returning empty cache", read_error)
        _record_cache_contention(session_id, "load", read_error)
    return _fresh_cache(session_id, unavailable=True)


def save(cache: SessionCache) -> None:
    """Atomically persist the session cache to disk."""
    if cache.unavailable:
        _LOG.debug("session save skipped (cache unavailable): %s", cache.session_id[:16])
        return
    t0 = time.monotonic()
    last_exc: OSError | None = None
    for delay in (0.0, 0.05, 0.15):
        if delay:
            time.sleep(delay)
        # _FILE_LOCK is acquired inside the retry loop, not outside, so that a
        # sibling thread waiting to retry does not hold the lock while sleeping.
        # Cross-process safety comes from atomic_write_text (write-to-temp +
        # rename), so the lock only needs to serialize same-process writers.
        with _FILE_LOCK:
            try:
                paths.atomic_write_text(
                    paths.session_cache_path(cache.session_id),
                    cache.to_json(),
                )
            except OSError as exc:
                last_exc = exc
                continue
        elapsed_ms = (time.monotonic() - t0) * 1000
        if elapsed_ms >= 100:
            _LOG.warning(
                "session save slow: %s (%d files, %d greps) %.1fms",
                cache.session_id[:16], len(cache.files), len(cache.greps), elapsed_ms,
            )
        else:
            _LOG.debug(
                "session saved: %s (%d files, %d greps) %.1fms",
                cache.session_id[:16], len(cache.files), len(cache.greps), elapsed_ms,
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
    normalized = path.replace("\\", "/")
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
            save(cache)
            return cache
        # Cap the number of symbols tracked per file to prevent unbounded growth.
        if len(entry.symbols_read) >= _MAX_SYMBOLS_PER_FILE:
            _LOG.debug(
                "mark_file_read: symbols_read cap (%d) reached for %s; discarding %r",
                _MAX_SYMBOLS_PER_FILE,
                key,
                symbol,
            )
            save(cache)
            return cache
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
        else:
            _LOG.debug("mark_file_read: symbol %r already tracked in %s", symbol, key)
    else:
        line_offset = min(max(0, int(offset)), _MAX_LINE_NUMBER) if offset is not None else 0
        line_limit = min(max(0, int(limit)), _MAX_LINE_NUMBER) if limit is not None else 0
        start = line_offset + 1  # Read tool's offset is 0-indexed; we store 1-indexed inclusive
        end = start + line_limit - 1 if line_limit else (start + _UNKNOWN_END_SENTINEL)
        prev_range_count = len(entry.line_ranges)
        entry.line_ranges = _merge_ranges(entry.line_ranges + [(start, end)])
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


# 1024 is well above any realistic grep pattern (~200 chars max in practice) but still
# blocks regex-bomb-sized strings from a malformed harness payload inflating every
# session JSON write.
_MAX_GREP_PATTERN_LEN = 1024

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
    cache.greps.append(GrepEntry(pattern=safe_pattern, path=path, ts=now, result_count=result_count))
    _LOG.debug(
        "mark_grep: pattern=%r path=%r results=%s (session=%s total_greps=%d)",
        sanitize_log_str(safe_pattern[:60], max_len=_MAX_LOG_STR),
        path,
        result_count,
        session_id[:16],
        len(cache.greps),
    )
    return _commit_mutation(cache, now)


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
        cache._invalidate_json_cache()
        save(cache)
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
    if key not in cache.result_cache and len(cache.result_cache) >= RESULT_CACHE_MAX:
        evict_keys = list(islice(cache.result_cache.keys(), _RESULT_CACHE_EVICT))
        for k in evict_keys:
            del cache.result_cache[k]
        _LOG.debug(
            "result_cache: evicted %d entries (cap=%d) for session=%s",
            _RESULT_CACHE_EVICT, RESULT_CACHE_MAX, session_id[:16],
        )
    cache.result_cache[key] = ResultCacheEntry(
        file_sha=file_sha,
        kind=kind,
        result=dict(result),  # shallow copy — defensive against caller mutating after store
        ts=time.time(),
    )
    cache._invalidate_json_cache()
    save(cache)
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
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Bash invocation in the per-session history.

    *cmd_sha* is a short content-derived identifier (see :func:`bash_cache.command_hash`).
    Storing only the SHA — not the full command — keeps the session JSON small
    and avoids persisting potentially sensitive command arguments
    (credentials, file paths) longer than necessary.  ``cmd_preview`` is the
    first 120 characters of the command, which is enough to identify a re-run
    while remaining bounded.

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
    # Evict oldest entries when at capacity — but only when adding a new key.
    # Updates to an existing cmd_sha keep their original insertion slot so the
    # eviction order reflects "first seen, first evicted".
    if cmd_sha not in cache.bash_history and len(cache.bash_history) >= BASH_HISTORY_MAX:
        evict_keys = list(islice(cache.bash_history.keys(), _BASH_HISTORY_EVICT))
        for k in evict_keys:
            del cache.bash_history[k]
        _LOG.debug(
            "bash_history: evicted %d entries (cap=%d) for session=%s",
            _BASH_HISTORY_EVICT, BASH_HISTORY_MAX, session_id[:16],
        )

    prior_run_count = cache.bash_history[cmd_sha].run_count if cmd_sha in cache.bash_history else 0
    cache.bash_history[cmd_sha] = BashEntry(
        cmd_sha=cmd_sha,
        cmd_preview=safe_preview,
        output_id=output_id,
        ts=now,
        stdout_bytes=max(0, int(stdout_bytes)),
        stderr_bytes=max(0, int(stderr_bytes)),
        exit_code=exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None,
        truncated=bool(truncated),
        run_count=prior_run_count + 1,
    )
    return _commit_mutation(cache, now)


def lookup_bash_entry(
    session_id: str, cmd_sha: str, *, cache: SessionCache | None = None
) -> BashEntry | None:
    """Return the :class:`BashEntry` for *cmd_sha* in *session_id*, or None."""
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable:
        return None
    return cache.bash_history.get(cmd_sha)


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
    if url_sha not in cache.web_history and len(cache.web_history) >= WEB_HISTORY_MAX:
        evict_keys = list(islice(cache.web_history.keys(), _WEB_HISTORY_EVICT))
        for k in evict_keys:
            del cache.web_history[k]
        _LOG.debug(
            "web_history: evicted %d entries (cap=%d) for session=%s",
            _WEB_HISTORY_EVICT, WEB_HISTORY_MAX, session_id[:16],
        )

    cache.web_history[url_sha] = WebEntry(
        url_sha=url_sha,
        url_preview=safe_preview,
        output_id=output_id,
        ts=now,
        body_bytes=max(0, int(body_bytes)),
        status_code=(
            status_code
            if isinstance(status_code, int) and not isinstance(status_code, bool)
            else None
        ),
        truncated=bool(truncated),
    )
    return _commit_mutation(cache, now)


def lookup_web_entry(
    session_id: str, url_sha: str, *, cache: SessionCache | None = None
) -> WebEntry | None:
    """Return the :class:`WebEntry` for *url_sha* in *session_id*, or None."""
    try:
        cache = _resolve_cache(session_id, cache)
    except ValueError:
        return None
    if cache.unavailable:
        return None
    return cache.web_history.get(url_sha)


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
    cache.snapshot_shas[key] = content_sha
    cache._invalidate_json_cache()
    save(cache)
    return cache


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
