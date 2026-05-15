"""Read-replacement: return just a symbol's source instead of the whole file."""
from __future__ import annotations

import logging
import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import db
from .paths import is_safe_rel_path as _is_safe_rel_path
from .project import Project

_LOG = logging.getLogger("token_goat.read_replacement")

# Lower value = higher priority when multiple symbols share the same name
_KIND_PRIORITY: dict[str, int] = {
    "class": 0,
    "interface": 1,
    "trait": 1,
    "type": 2,
    "enum": 2,
    "function": 3,
    "method": 4,
    "const": 5,
    "var": 6,
    "heading": 2,
}


class ReadLookupError(ValueError):
    """Structured read-resolution failure."""

    code = "read_lookup_error"


class ProjectIndexUnavailable(ReadLookupError):
    """Raised when indexed-project metadata cannot be queried safely."""

    code = "project_index_unavailable"

    def __init__(self, detail: str) -> None:
        self.detail = detail
        super().__init__(detail)


class AmbiguousFileMatch(ReadLookupError):
    """Raised when a file_part matches multiple indexed paths."""

    code = "ambiguous_file"

    def __init__(self, file_part: str, candidates: Sequence[str]) -> None:
        self.file_part = file_part
        self.candidates = tuple(candidates)
        super().__init__(f"ambiguous file match for {file_part}: {', '.join(self.candidates)}")


def _escape_like_pattern(value: str) -> str:
    """Escape SQLite LIKE wildcards so file names are matched literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ---------------------------------------------------------------------------
# File-resolution cache (item 8)
# ---------------------------------------------------------------------------
# Bounded in-process cache for (project_hash, normalized_file_part) → rel_path.
# Keyed on project_hash so invalidation per project is O(n) on cache size.
# AmbiguousFileMatch results are never cached — callers see the exception each time.
# Max 512 entries; evict oldest 128 when full (simple FIFO — LRU not needed here).

_RESOLVE_CACHE: dict[tuple[str, str], str | None] = {}
_RESOLVE_CACHE_MAX = 512
_RESOLVE_CACHE_EVICT = 128


def _resolve_cache_get(project_hash: str, file_part: str) -> tuple[bool, str | None]:
    """Return (found, value). Value is None for 'not found' or the rel_path."""
    key = (project_hash, file_part)
    if key in _RESOLVE_CACHE:
        return True, _RESOLVE_CACHE[key]
    return False, None


def _resolve_cache_put(project_hash: str, file_part: str, rel_path: str | None) -> None:
    """Store a resolution result. Evicts oldest entries when cache is full."""
    key = (project_hash, file_part)
    if key in _RESOLVE_CACHE:
        _RESOLVE_CACHE[key] = rel_path
        return
    if len(_RESOLVE_CACHE) >= _RESOLVE_CACHE_MAX:
        # Evict oldest entries (dict preserves insertion order in Python 3.7+)
        evict_keys = list(_RESOLVE_CACHE.keys())[:_RESOLVE_CACHE_EVICT]
        for k in evict_keys:
            del _RESOLVE_CACHE[k]
    _RESOLVE_CACHE[key] = rel_path


def invalidate_file_cache(project_hash: str) -> int:
    """Remove all cached resolutions for a project. Returns count evicted.

    Called by the post-edit hook after a file is reindexed so the next lookup
    gets a fresh result from the DB.
    """
    stale = [k for k in _RESOLVE_CACHE if k[0] == project_hash]
    for k in stale:
        del _RESOLVE_CACHE[k]
    return len(stale)


# ---------------------------------------------------------------------------
# Specificity ranking for ambiguous file matches (item 14)
# ---------------------------------------------------------------------------

def _match_specificity(file_part: str, rel_path: str) -> tuple[int, int]:
    """Score how specifically file_part matches rel_path (higher = more specific).

    Returns (suffix_match_len, neg_path_depth) as a tuple for sort comparison.
    - suffix_match_len: number of path components in file_part that tail-match rel_path.
      Longer suffix match = more specific.
    - neg_path_depth: negative of the total path depth in rel_path.
      Shorter total path (fewer components) ranks higher when suffix depth ties.
    """
    fp_parts = file_part.replace("\\", "/").split("/")
    rp_parts = rel_path.split("/")
    # Count how many trailing components of rel_path match the full file_part
    suffix_len = 0
    for i, part in enumerate(reversed(fp_parts)):
        rp_idx = len(rp_parts) - 1 - i
        if rp_idx < 0 or rp_parts[rp_idx] != part:
            break
        suffix_len += 1
    return (suffix_len, -len(rp_parts))


def _pick_best_match(file_part: str, candidates: list[str]) -> str | None:
    """Return the single best match by specificity, or None if ambiguous.

    Returns None when two or more candidates tie for the highest specificity score,
    so callers can raise AmbiguousFileMatch with the full candidate list.
    """
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    scored = sorted(candidates, key=lambda r: _match_specificity(file_part, r), reverse=True)
    best_score = _match_specificity(file_part, scored[0])
    if _match_specificity(file_part, scored[1]) == best_score:
        return None  # tie → still ambiguous
    return scored[0]


def resolve_file_rel(project: Project, file_part: str) -> str | None:
    """Given the file part from a 'file::symbol' target, find the matching rel_path.

    Accepts:
    - Full relative path  (e.g., 'src/token_goat/parser.py')
    - Bare filename       (e.g., 'parser.py' — only when unique)
    - Partial path        (e.g., 'token_goat/parser.py' — only when unique)
    - Absolute path       (resolved against project root)

    Raises AmbiguousFileMatch when multiple indexed files match file_part at equal
    specificity. When one candidate is more specific than the others (longer suffix
    match or shallower path depth on tie), it is returned without raising.
    Results are cached in-process keyed on (project_hash, file_part).
    """
    file_part = file_part.replace("\\", "/").strip()

    # Cache hit — avoids DB round-trips for repeated lookups within same process
    hit, cached = _resolve_cache_get(project.hash, file_part)
    if hit:
        return cached

    result = _resolve_file_rel_db(project, file_part)
    _resolve_cache_put(project.hash, file_part, result)
    return result


def _resolve_file_rel_db(project: Project, file_part: str) -> str | None:
    """Un-cached DB-backed resolution. Called by resolve_file_rel."""
    with db.open_project(project.hash) as conn:
        # 1. Exact relative match
        row = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path = ?", (file_part,)
        ).fetchone()
        if row:
            return row["rel_path"]

        # 2. Absolute path — make it relative to project root
        p = Path(file_part)
        if p.is_absolute():
            try:
                rel = p.resolve().relative_to(project.root.resolve()).as_posix()
                row = conn.execute(
                    "SELECT rel_path FROM files WHERE rel_path = ?", (rel,)
                ).fetchone()
                if row:
                    return row["rel_path"]
            except ValueError:
                pass  # path is not under this project root — expected control flow
            except OSError as e:
                _LOG.debug("resolve_file_rel: could not resolve absolute path %s: %s", file_part, e)

        # 3. Endswith match — handles bare filename or partial path
        rows = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\'",
            (f"%{_escape_like_pattern(file_part)}",),
        ).fetchall()
        if len(rows) == 0:
            return None
        if len(rows) == 1:
            return rows[0]["rel_path"]

        # Multiple candidates — try to pick the most specific one before raising
        candidate_paths = [r["rel_path"] for r in rows]
        best = _pick_best_match(file_part, candidate_paths)
        if best is not None:
            _LOG.debug(
                "ambiguity resolved by specificity in %s for %s → %s",
                project.hash[:8], file_part, best,
            )
            return best

        candidates = tuple(sorted(candidate_paths))
        _LOG.debug(
            "ambiguous file match in %s for %s: %s",
            project.hash[:8],
            file_part,
            ", ".join(candidates),
        )
        raise AmbiguousFileMatch(file_part, candidates)


def find_in_all_projects(file_part: str) -> tuple[Project, str] | None:
    """Search every indexed project for a file matching file_part.

    Returns (project, rel_path) for the single unambiguous match, or None.
    Raises AmbiguousFileMatch when multiple indexed files match across projects.
    Used as a cross-project fallback so `token-goat section
    "superman/SKILL.md::Heading"` works from any working directory once the
    skills dir has been indexed.
    """
    from . import db as _db  # noqa: PLC0415

    try:
        with _db.open_global_readonly() as gconn:
            rows = gconn.execute("SELECT hash, root, marker FROM projects").fetchall()
    except FileNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001 — any DB failure is non-fatal for cross-project lookup
        _LOG.warning("find_in_all_projects: global DB unavailable: %s", exc)
        if isinstance(exc, (OSError, sqlite3.Error)):
            raise ProjectIndexUnavailable(
                "Project index database is unavailable. Run `token-goat index --full` again."
            ) from exc
        return None

    matches: list[tuple[Project, str]] = []
    ambiguous_candidates: list[str] = []
    project_errors: list[str] = []
    for row in rows:
        proj = Project(root=Path(row["root"]), hash=row["hash"], marker=row["marker"])
        try:
            rel = resolve_file_rel(proj, file_part)
        except AmbiguousFileMatch as exc:
            ambiguous_candidates.extend(
                f"{proj.hash[:8]}:{candidate}" for candidate in exc.candidates
            )
            continue
        except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as exc:
            _LOG.warning(
                "find_in_all_projects: resolve failed for project %s (%s)",
                proj.hash[:8],
                exc,
            )
            project_errors.append(f"{proj.hash[:8]}: {exc}")
            continue
        if rel is not None:
            matches.append((proj, rel))
    if len(matches) == 1:
        return matches[0]
    candidates = [f"{proj.hash[:8]}:{rel}" for proj, rel in matches]
    candidates.extend(ambiguous_candidates)
    if len(candidates) > 1:
        candidates = sorted(dict.fromkeys(candidates))
        _LOG.debug(
            "ambiguous cross-project file match for %s: %s",
            file_part,
            ", ".join(candidates),
        )
        raise AmbiguousFileMatch(file_part, candidates)
    if project_errors:
        raise ProjectIndexUnavailable(
            "Project index database is unavailable for one or more indexed projects. "
            "Run `token-goat index --full` again."
        )
    return matches[0] if matches else None


def _read_file_lines(abs_path: Path) -> tuple[list[str], int] | None:
    """Read *abs_path*, split into lines, and return (lines, byte_size).

    Returns ``None`` on any I/O error or if the file is empty, so callers can
    ``result = _read_file_lines(p); if result is None: return None`` without
    repeating the try/except or empty-file check.
    """
    try:
        full_text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        _LOG.warning("read failed: %s: %s", abs_path, e)
        return None
    lines = full_text.splitlines()
    if not lines:
        return None
    return lines, len(full_text.encode("utf-8"))


def read_symbol(
    project: Project,
    rel_path: str,
    symbol: str,
    *,
    context_lines: int = 0,
) -> dict[str, Any] | None:
    """Look up symbol in DB, slice the file, return extraction dict.

    Returns a dict with keys:
        file, symbol, kind, start_line, end_line, text,
        signature, bytes_total, bytes_extracted, bytes_saved
    Returns None if the symbol is not found or the file cannot be read.
    """
    # Prevent path traversal attacks
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("rejected unsafe rel_path: %s", rel_path)
        return None

    with db.open_project(project.hash) as conn:
        rows = conn.execute(
            "SELECT name, kind, line, end_line, signature FROM symbols "
            "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL ORDER BY line",
            (rel_path, symbol),
        ).fetchall()
        if not rows:
            return None

    # If multiple matches (e.g., a top-level function and a method of the same name),
    # prefer by kind priority then by earliest line.
    chosen = min(rows, key=lambda r: (_KIND_PRIORITY.get(r["kind"], 9), r["line"]))

    abs_path = project.root / rel_path
    read_result = _read_file_lines(abs_path)
    if read_result is None:
        return None
    lines, full_bytes = read_result

    start = max(1, chosen["line"] - context_lines)
    end = min(len(lines), chosen["end_line"] + context_lines)
    snippet = "\n".join(lines[start - 1 : end])
    snippet_bytes = len(snippet.encode("utf-8"))

    return {
        "file": rel_path,
        "symbol": chosen["name"],
        "kind": chosen["kind"],
        "start_line": start,
        "end_line": end,
        "text": snippet,
        "signature": chosen["signature"],
        "bytes_total": full_bytes,
        "bytes_extracted": snippet_bytes,
        "bytes_saved": max(0, full_bytes - snippet_bytes),
    }


def read_section(
    project: Project,
    rel_path: str,
    heading: str,
    *,
    context_lines: int = 0,
) -> dict[str, Any] | None:
    """Same as read_symbol but for markdown/HTML/Liquid section headings.

    Returns a dict with keys:
        file, heading, level, start_line, end_line, text,
        bytes_total, bytes_extracted, bytes_saved
    Returns None if the heading is not found or the file cannot be read.
    """
    # Prevent path traversal attacks
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("rejected unsafe rel_path: %s", rel_path)
        return None

    with db.open_project(project.hash) as conn:
        rows = conn.execute(
            "SELECT heading, level, line, end_line FROM sections "
            "WHERE file_rel = ? AND heading = ? AND end_line IS NOT NULL ORDER BY line",
            (rel_path, heading),
        ).fetchall()
        if not rows:
            # Fallback: case-insensitive match
            rows = conn.execute(
                "SELECT heading, level, line, end_line FROM sections "
                "WHERE file_rel = ? AND lower(heading) = lower(?) AND end_line IS NOT NULL ORDER BY line",
                (rel_path, heading),
            ).fetchall()
            if not rows:
                return None

    chosen = rows[0]  # first match by line order

    abs_path = project.root / rel_path
    read_result = _read_file_lines(abs_path)
    if read_result is None:
        return None
    lines, full_bytes = read_result

    start = max(1, chosen["line"] - context_lines)
    end = min(len(lines), chosen["end_line"] + context_lines)
    snippet = "\n".join(lines[start - 1 : end])
    snippet_bytes = len(snippet.encode("utf-8"))

    return {
        "file": rel_path,
        "heading": chosen["heading"],
        "level": chosen["level"],
        "start_line": start,
        "end_line": end,
        "text": snippet,
        "bytes_total": full_bytes,
        "bytes_extracted": snippet_bytes,
        "bytes_saved": max(0, full_bytes - snippet_bytes),
    }
