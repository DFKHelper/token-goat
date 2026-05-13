"""Session-context cache: tracks files/line ranges/symbols pulled into this session's context."""
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import paths

_LOG = logging.getLogger("tokenwise.session")
_FILE_LOCK = threading.Lock()  # in-process; multi-process safe enough via atomic write


@dataclass
class FileEntry:
    """Tracks reads of a single file within a session."""

    rel_or_abs: str  # path as Claude requested it (relative or absolute)
    last_read_ts: float  # unix
    read_count: int  # number of times Read fired for this file
    line_ranges: list[tuple[int, int]]  # [(start, end), ...] of read ranges, 1-indexed inclusive
    symbols_read: list[str]  # via tokenwise read file::symbol


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

    def to_dict(self) -> dict:
        """Serialize to dict for JSON."""
        return {
            "session_id": self.session_id,
            "started_ts": self.started_ts,
            "last_activity_ts": self.last_activity_ts,
            "files": {k: asdict(v) for k, v in self.files.items()},
            "greps": [asdict(g) for g in self.greps],
        }

    @classmethod
    def from_dict(cls, d: dict) -> SessionCache:
        """Deserialize from dict (JSON)."""
        files = {
            k: FileEntry(
                rel_or_abs=v["rel_or_abs"],
                last_read_ts=v["last_read_ts"],
                read_count=v["read_count"],
                line_ranges=[tuple(r) for r in v["line_ranges"]],
                symbols_read=v.get("symbols_read", []),
            )
            for k, v in d.get("files", {}).items()
        }
        greps = [GrepEntry(**g) for g in d.get("greps", [])]
        return cls(
            session_id=d["session_id"],
            started_ts=d["started_ts"],
            last_activity_ts=d["last_activity_ts"],
            files=files,
            greps=greps,
        )


def _normalize_path(p: str) -> str:
    """Normalize a path for use as a cache key. Lowercase Windows drive, forward slashes."""
    s = str(Path(p))
    s = s.replace("\\", "/")
    if len(s) >= 2 and s[1] == ":":
        s = s[0].lower() + s[1:]
    return s


def _atomic_write(path: Path, content: str) -> None:
    """Write to a temp file, then rename. Avoids partial writes if killed mid-flight."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


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
    if not all(c.isalnum() or c in "-_" for c in session_id):
        raise ValueError(f"session_id contains invalid characters: {session_id!r}")


def load(session_id: str) -> SessionCache:
    """Load a session cache, or return an empty one."""
    _validate_session_id(session_id)
    p = paths.session_cache_path(session_id)
    if not p.exists():
        now = time.time()
        return SessionCache(session_id=session_id, started_ts=now, last_activity_ts=now)
    try:
        return SessionCache.from_dict(json.loads(p.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        _LOG.warning("session cache corrupted (%s); resetting", e)
        now = time.time()
        return SessionCache(session_id=session_id, started_ts=now, last_activity_ts=now)


def save(cache: SessionCache) -> None:
    """Atomically persist the session cache to disk."""
    with _FILE_LOCK:
        _atomic_write(
            paths.session_cache_path(cache.session_id),
            json.dumps(cache.to_dict(), ensure_ascii=False),
        )


def mark_file_read(
    session_id: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
    *,
    symbol: str | None = None,
) -> SessionCache:
    """Record that a file (or symbol within) was read. Returns the updated cache."""
    cache = load(session_id)
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
    session_id: str, pattern: str, path: str | None = None, result_count: int | None = None
) -> SessionCache:
    """Record a Grep call. Returns the updated cache."""
    cache = load(session_id)
    cache.greps.append(
        GrepEntry(pattern=pattern, path=path, ts=time.time(), result_count=result_count)
    )
    cache.last_activity_ts = time.time()
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


def get_file_entry(session_id: str, path: str) -> FileEntry | None:
    """Get a file entry by path, or None if not found."""
    cache = load(session_id)
    return cache.files.get(_normalize_path(path))


def reset_session(session_id: str) -> None:
    """Wipe the cache for a session (called by SessionStart on /clear / compact)."""
    p = paths.session_cache_path(session_id)
    if p.exists():
        try:
            p.unlink()
        except OSError as e:
            _LOG.warning("failed to delete session cache %s: %s", p, e)


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
        except OSError:
            pass
    return removed
