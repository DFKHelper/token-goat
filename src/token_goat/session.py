"""Session-context cache: tracks files/line ranges/symbols pulled into this session's context."""
from __future__ import annotations

import contextlib
import json
import logging
import re
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import paths

_LOG = logging.getLogger("token_goat.session")

SESSION_SCHEMA_VERSION = 1
_FILE_LOCK = threading.Lock()  # in-process; multi-process safe enough via atomic write
_REPORTED_CONTENTION: set[tuple[str, str]] = set()


@dataclass
class FileEntry:
    """Tracks reads of a single file within a session."""

    rel_or_abs: str  # path as Claude requested it (relative or absolute)
    last_read_ts: float  # unix
    read_count: int  # number of times Read fired for this file
    line_ranges: list[tuple[int, int]]  # [(start, end), ...] of read ranges, 1-indexed inclusive
    symbols_read: list[str]  # via token-goat read file::symbol


@dataclass
class GrepEntry:
    """Tracks a Grep call (pattern + scope)."""

    pattern: str
    path: str | None
    ts: float
    result_count: int | None = None  # if known


@dataclass
class SessionCache:
    """Session context cache keyed by session_id."""

    session_id: str
    started_ts: float
    last_activity_ts: float
    files: dict[str, FileEntry] = field(default_factory=dict)  # key = normalized path
    greps: list[GrepEntry] = field(default_factory=list)
    # Tracks files edited this session: normalized_path → edit count
    edited_files: dict[str, int] = field(default_factory=dict)
    unavailable: bool = field(default=False, repr=False, compare=False)

    def to_dict(self) -> dict:
        """Serialize to dict for JSON."""
        return {
            "schema_version": SESSION_SCHEMA_VERSION,
            "created_by": "token-goat",
            "session_id": self.session_id,
            "started_ts": self.started_ts,
            "last_activity_ts": self.last_activity_ts,
            "files": {k: asdict(v) for k, v in self.files.items()},
            "greps": [asdict(g) for g in self.greps],
            "edited_files": self.edited_files,
        }

    @classmethod
    def from_dict(cls, d: dict) -> SessionCache:
        """Deserialize from dict (JSON). Tolerates missing or corrupted fields."""
        now = time.time()

        schema_v = d.get("schema_version", 0)
        if schema_v and int(schema_v) > SESSION_SCHEMA_VERSION:
            _LOG.warning(
                "session schema_version %s > current %s; some fields may be ignored",
                schema_v,
                SESSION_SCHEMA_VERSION,
            )

        session_id = d.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError(f"session_id missing or invalid: {session_id!r}")

        files: dict[str, FileEntry] = {}
        for k, v in d.get("files", {}).items():
            if not isinstance(v, dict):
                continue
            try:
                raw_ranges = v.get("line_ranges", [])
                line_ranges = [tuple(r) for r in raw_ranges if isinstance(r, (list, tuple)) and len(r) == 2]
                files[k] = FileEntry(
                    rel_or_abs=str(v.get("rel_or_abs", k)),
                    last_read_ts=float(v.get("last_read_ts", now)),
                    read_count=max(0, int(v.get("read_count", 0))),
                    line_ranges=line_ranges,
                    symbols_read=list(v.get("symbols_read", [])),
                )
            except (TypeError, ValueError, KeyError):
                _LOG.debug("session: skipping corrupted file entry for key %r", k)

        greps: list[GrepEntry] = []
        _grep_fields = {f.name for f in GrepEntry.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        for g in d.get("greps", []):
            if not isinstance(g, dict):
                continue
            try:
                greps.append(GrepEntry(**{k: v for k, v in g.items() if k in _grep_fields}))
            except (TypeError, ValueError, KeyError):
                _LOG.debug("session: skipping corrupted grep entry")

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
    """Normalize a path for use as a cache key. Forward slashes; lowercase drive on Windows."""
    s = str(Path(p))
    s = s.replace("\\", "/")
    if sys.platform == "win32" and len(s) >= 2 and s[1] == ":":
        s = s[0].lower() + s[1:]
    return s




_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_session_id(session_id: str) -> None:
    """Validate session_id to prevent path traversal attacks.

    Session IDs should be alphanumeric, hyphens, and underscores only.
    Reject anything with path separators or suspicious characters.
    """
    if not session_id:
        raise ValueError("session_id cannot be empty")
    if len(session_id) > 256:
        raise ValueError("session_id too long (max 256 chars)")
    # Allow alphanumeric, hyphen, underscore only
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


def _cache_for(session_id: str, cache: SessionCache | None) -> SessionCache:
    """Return the provided cache after validating that it belongs to session_id."""
    _validate_session_id(session_id)
    if cache is not None:
        if cache.session_id != session_id:
            raise ValueError("cache.session_id does not match session_id")
        return cache
    return load(session_id)


def load(session_id: str) -> SessionCache:
    """Load a session cache, or return an empty one."""
    _validate_session_id(session_id)
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
        _LOG.info("session opened: %s (resuming, %d files tracked)", session_id[:16], len(cache.files))
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
    last_exc: OSError | None = None
    for delay in (0.0, 0.05, 0.15):
        if delay:
            time.sleep(delay)
        with _FILE_LOCK:
            try:
                paths.atomic_write_text(
                    paths.session_cache_path(cache.session_id),
                    json.dumps(cache.to_dict(), ensure_ascii=False),
                )
            except OSError as exc:
                last_exc = exc
                continue
        _LOG.debug(
            "session saved: %s (%d files, %d greps)",
            cache.session_id[:16],
            len(cache.files),
            len(cache.greps),
        )
        return
    if last_exc is not None:
        _LOG.debug("session save skipped (locked/unavailable): %s", last_exc)
        _record_cache_contention(cache.session_id, "save", last_exc)


def mark_file_read(
    session_id: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    *,
    symbol: str | None = None,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record that a file (or symbol within) was read. Returns the updated cache."""
    cache = _cache_for(session_id, cache)
    if cache.unavailable:
        return cache
    key = _normalize_path(path)
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
        if symbol not in entry.symbols_read:
            entry.symbols_read.append(symbol)
    else:
        start = (offset or 0) + 1  # Read tool's offset is 0-indexed; we store 1-indexed inclusive
        end = start + (limit or 2000) - 1 if limit else (start + 99999)
        entry.line_ranges = _merge_ranges([*entry.line_ranges, (start, end)])
    cache.last_activity_ts = now
    save(cache)
    return cache


def mark_grep(
    session_id: str,
    pattern: str,
    path: str | None = None,
    result_count: int | None = None,
    *,
    cache: SessionCache | None = None,
) -> SessionCache:
    """Record a Grep call. Returns the updated cache."""
    cache = _cache_for(session_id, cache)
    if cache.unavailable:
        return cache
    now = time.time()
    cache.greps.append(GrepEntry(pattern=pattern, path=path, ts=now, result_count=result_count))
    cache.last_activity_ts = now
    save(cache)
    return cache


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Coalesce overlapping/adjacent (start, end) ranges."""
    if not ranges:
        return []
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
    cache = _cache_for(session_id, cache)
    if cache.unavailable:
        return None
    return cache.files.get(_normalize_path(path))


def reset_session(session_id: str) -> None:
    """Wipe the cache for a session (called by SessionStart on /clear / compact).

    Validates session_id before use (defense-in-depth: paths.session_cache_path
    also validates, but an explicit guard here makes the invariant obvious at the
    call site and prevents future callers from bypassing path-level checks).
    """
    _validate_session_id(session_id)
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
    cache = _cache_for(session_id, cache)
    if cache.unavailable:
        return cache
    key = _normalize_path(path)
    cache.edited_files[key] = cache.edited_files.get(key, 0) + 1
    cache.last_activity_ts = time.time()
    save(cache)
    return cache


def list_edited(session_id: str) -> dict[str, int]:
    """Return edited files for this session: normalized_path → edit count."""
    return load(session_id).edited_files


def list_touched(session_id: str) -> list[FileEntry]:
    """List all files touched in a session, sorted by last read time (newest first)."""
    cache = load(session_id)
    return sorted(cache.files.values(), key=lambda e: e.last_read_ts, reverse=True)


def cleanup_stale(max_age_hours: float = 24.0) -> int:
    """Delete session cache files older than max_age_hours. Returns count removed."""
    removed = 0
    sessions_dir = paths.session_cache_path("dummy").parent
    if not sessions_dir.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    for f in sessions_dir.glob("*.json"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        except OSError as e:
            _LOG.debug("cleanup_stale: could not remove %s: %s", f.name, e)
    return removed
