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
    """

    rel_or_abs: str  # path as Claude requested it (relative or absolute)
    last_read_ts: float  # unix
    read_count: int  # number of times Read fired for this file
    line_ranges: list[tuple[int, int]]  # [(start, end), ...] of read ranges, 1-indexed inclusive
    symbols_read: list[str]  # via token-goat read file::symbol


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


# Computed once at import time — GrepEntry fields never change at runtime.
_GREP_FIELDS: frozenset[str] = frozenset(GrepEntry.__dataclass_fields__)  # type: ignore[attr-defined]

# attrgetter key for sorting FileEntry objects by last_read_ts.
# Defined at module level to avoid allocating a new lambda on every list_touched() call.
_BY_LAST_READ_TS = attrgetter("last_read_ts")


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

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SessionCache:
        """Deserialize from dict (JSON). Tolerates missing or corrupted fields."""
        now = time.time()

        schema_v = d.get("schema_version", 0)
        if schema_v and int(schema_v) > SESSION_SCHEMA_VERSION:
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

        return cls(
            session_id=session_id,
            started_ts=float(d.get("started_ts", now)),
            last_activity_ts=float(d.get("last_activity_ts", now)),
            files=files,
            greps=greps,
            edited_files=edited_files,
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

        return FileEntry(
            rel_or_abs=str(v.get("rel_or_abs", key)),
            last_read_ts=float(v.get("last_read_ts", now)),
            read_count=max(0, int(v.get("read_count", 0))),
            line_ranges=line_ranges,
            symbols_read=symbols_read,
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


class _FileEntryDict(TypedDict):
    """Wire format of a single FileEntry as it appears in the session JSON."""

    rel_or_abs: str
    last_read_ts: float
    read_count: int
    line_ranges: list[list[int]]
    symbols_read: list[str]


class _GrepEntryDict(TypedDict, total=False):
    """Wire format of a single GrepEntry as it appears in the session JSON."""

    pattern: str
    path: str | None
    ts: float
    result_count: int | None


class _SessionDict(TypedDict):
    """Wire format of a serialized SessionCache (written to / read from JSON on disk)."""

    schema_version: int
    created_by: str
    session_id: str
    started_ts: float
    last_activity_ts: float
    files: dict[str, _FileEntryDict]
    greps: list[_GrepEntryDict]
    edited_files: dict[str, int]


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


def _normalize_path(p: str) -> str:
    """Normalize a path for use as a cache key. Forward slashes; lowercase drive on Windows.

    Avoids constructing a Path object when the string contains no backslashes,
    which is the common case for absolute POSIX paths and already-normalized keys.
    The Path() round-trip was only needed to collapse mixed separators; a plain
    str.replace is sufficient and avoids the allocation on the hot pre-read path.
    """
    # Fast path: no backslashes — skip the Path allocation entirely.
    if "\\" not in p:
        if sys.platform == "win32" and len(p) >= 2 and p[1] == ":" and p[0].isupper():
            return p[0].lower() + p[1:]
        return p
    s = p.replace("\\", "/")
    if sys.platform == "win32" and len(s) >= 2 and s[1] == ":" and s[0].isupper():
        s = s[0].lower() + s[1:]
    return s




_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

_MAX_LOG_STR = 120  # truncation limit for user-controlled values embedded in log messages


def validate_session_id(session_id: str) -> None:
    """Validate session_id to prevent path traversal attacks. Raises ValueError on invalid input.

    Session IDs must be non-empty, at most 256 characters, and contain only
    alphanumeric characters, hyphens, and underscores — no path separators or
    other suspicious characters that could enable directory traversal.
    """
    if not session_id:
        raise ValueError("session_id cannot be empty")
    if len(session_id) > 256:
        raise ValueError("session_id too long (max 256 chars)")
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
            raise ValueError("cache.session_id does not match session_id")
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
        except (json.JSONDecodeError, KeyError, TypeError) as e:
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
            "session save failed after retries: %s (session=%s, files=%d, greps=%d)",
            last_exc,
            cache.session_id[:16],
            len(cache.files),
            len(cache.greps),
        )
        _record_cache_contention(cache.session_id, "save", last_exc)


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
    is_absolute = normalized.startswith("/") or (
        len(normalized) >= 2 and normalized[1] == ":" and normalized[0].isalpha()
    )
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
        return None
    cache = _resolve_cache(session_id, cache)
    if cache.unavailable:
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
        line_offset = max(0, int(offset)) if offset is not None else 0
        line_limit = max(0, int(limit)) if limit is not None else 0
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
    cache.last_activity_ts = now
    cache._invalidate_json_cache()
    save(cache)
    return cache


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
    cache.last_activity_ts = now
    cache._invalidate_json_cache()
    save(cache)
    return cache


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
    """
    validate_session_id(session_id)
    p = paths.session_cache_path(session_id)
    if p.exists():
        try:
            p.unlink()
        except OSError as e:
            _LOG.warning("failed to delete session cache %s: %s", p, e)


def mark_file_edited(
    session_id: str, path: str, *, cache: SessionCache | None = None
) -> SessionCache:
    """Record that a file was edited (written/modified) this session."""
    prep = _prepare_path_mutation(session_id, path, cache)
    if prep is None:
        return cache or _fresh_cache(session_id)
    cache, key = prep
    now = time.time()
    prev_count = cache.edited_files.get(key, 0)
    cache.edited_files[key] = prev_count + 1
    _LOG.debug(
        "mark_file_edited: %s (edit #%d this session, total edited files=%d)",
        key,
        prev_count + 1,
        len(cache.edited_files),
    )
    cache.last_activity_ts = now
    cache._invalidate_json_cache()
    save(cache)
    return cache


def list_edited(session_id: str) -> dict[str, int]:
    """Return edited files for this session: normalized_path → edit count."""
    return load(session_id).edited_files


def list_touched(session_id: str) -> list[FileEntry]:
    """List all files touched in a session, sorted by last read time (newest first)."""
    cache = load(session_id)
    return sorted(cache.files.values(), key=_BY_LAST_READ_TS, reverse=True)


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
