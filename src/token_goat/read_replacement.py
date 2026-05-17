"""Read-replacement: return just a symbol's source instead of the whole file."""
from __future__ import annotations

import logging
import operator
import sqlite3
import time
from collections.abc import Sequence
from itertools import islice
from pathlib import Path
from typing import Final, TypedDict

from . import db
from .paths import is_safe_rel_path as _is_safe_rel_path
from .project import Project

# Maximum file size allowed for symbol/section extraction.  Mirrors parser.MAX_FILE_SIZE
# (2 MB) so a file that grew after indexing cannot cause an unbounded in-memory read
# when the caller requests a slice from it.  Defined here as a local constant to avoid
# importing the heavy parser module (tree-sitter, language grammars) at CLI startup time.
_MAX_READ_BYTES = 2_000_000  # 2 MB — keep in sync with parser.MAX_FILE_SIZE

# Maximum length accepted for symbol names and section headings supplied by the
# caller (CLI args or harness payload).  Real identifiers are bounded by language
# specs (Python/JS: ~256 chars; Go: no explicit limit but convention is short);
# anything beyond 1 KiB is anomalous and must not be forwarded to a DB query or
# log message as an unbounded heap allocation.
_MAX_SYMBOL_LEN: int = 1_024  # 1 KiB

_LOG = logging.getLogger("token_goat.read_replacement")


class SymbolResult(TypedDict):
    """Return value of :func:`read_symbol`."""

    file: str
    symbol: str
    kind: str
    start_line: int
    end_line: int
    text: str
    signature: str | None
    bytes_total: int
    bytes_extracted: int
    bytes_saved: int


class SectionResult(TypedDict):
    """Return value of :func:`read_section`."""

    file: str
    heading: str
    level: int
    start_line: int
    end_line: int
    text: str
    bytes_total: int
    bytes_extracted: int
    bytes_saved: int


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


def _coerce_line(val: object, default: int) -> int:
    """Return *val* as int, or *default* when *val* is None.

    DB row columns retrieved via sqlite3.Row are typed as ``object``; this
    helper centralises the ``int(x) if x is not None else default`` idiom used
    when extracting line numbers from query results.
    """
    if isinstance(val, int):
        return val
    return default


def _coerce_end_line(val: object) -> int | None:
    """Return *val* as int, or None when *val* is None.

    Companion to :func:`_coerce_line` for the end_line DB column, which may be
    NULL (None) when only the start line is known.  Both ``read_symbol`` and
    ``read_section`` contain the identical ``int(x) if x is not None else None``
    expression; this helper eliminates that duplication.
    """
    return val if isinstance(val, int) else None


def _validate_lookup_args(caller: str, rel_path: str, name: str) -> bool:
    """Validate the common preamble shared by read_symbol and read_section.

    Both functions begin with the same two guards:
    1. Reject unsafe relative paths (path traversal).
    2. Reject oversized name/heading strings (unbounded heap allocation).

    Extracting the guards here eliminates copy-paste and ensures both callers
    apply the same limits from a single source of truth.

    Parameters
    ----------
    caller:
        Short label for log messages (e.g. ``"read_symbol"`` or ``"read_section"``).
    rel_path:
        File-relative path to validate.
    name:
        Symbol name or section heading to validate.

    Returns
    -------
    bool
        ``True`` when both guards pass; ``False`` when either rejects the input
        (a warning is logged before returning ``False``).
    """
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("%s: rejected unsafe rel_path: %s", caller, rel_path)
        return False
    if len(name) > _MAX_SYMBOL_LEN:
        _LOG.warning(
            "%s: name/heading too long (%d chars > %d limit); rejecting",
            caller,
            len(name),
            _MAX_SYMBOL_LEN,
        )
        return False
    return True


class ReadLookupError(ValueError):
    """Structured read-resolution failure."""

    code = "read_lookup_error"


class ProjectIndexUnavailable(ReadLookupError):
    """Raised when indexed-project metadata cannot be queried safely."""

    code = "project_index_unavailable"

    def __init__(self, detail: str) -> None:
        """Store *detail* as an attribute and forward it as the exception message."""
        self.detail = detail
        super().__init__(detail)


class AmbiguousFileMatch(ReadLookupError):
    """Raised when a file_part matches multiple indexed paths."""

    code = "ambiguous_file"

    def __init__(self, file_part: str, candidates: Sequence[str]) -> None:
        """Record *file_part* and *candidates*, then forward a human-readable message."""
        self.file_part = file_part
        self.candidates = tuple(candidates)
        super().__init__(f"ambiguous file match for {file_part}: {', '.join(self.candidates)}")


def _escape_like_pattern(value: str) -> str:
    """Escape SQLite LIKE wildcards (%, _) so file names are matched literally.

    Necessary before using a user-supplied file name in a LIKE query.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ---------------------------------------------------------------------------
# File-resolution cache (item 8)
# ---------------------------------------------------------------------------
# Bounded in-process cache for (project_hash, normalized_file_part) → rel_path.
# Keyed on project_hash so invalidation per project is O(n) on cache size.
# AmbiguousFileMatch results are never cached — callers see the exception each time.
# Max 512 entries; evict oldest 128 when full (simple FIFO — LRU not needed here).
#
# Cache values are `str` (a resolved rel_path) or `None` (confirmed not found in
# this project's DB).  We need a third state — "not yet cached" — that is distinct
# from both of those.  _CACHE_MISS is that sentinel.

_RESOLVE_CACHE: dict[tuple[str, str], str | None] = {}
_RESOLVE_CACHE_MAX = 512
_RESOLVE_CACHE_EVICT = 128

# Sentinel returned by _resolve_cache_lookup when the key is absent from the cache.
# Distinct from None so callers can tell "not cached yet" apart from "cached as not found".
# Typed as a module-level Final so isinstance checks and `is` comparisons are type-safe.
class _CacheMissSentinel:
    """Singleton sentinel type for cache misses; distinct from None (confirmed not found)."""
    _instance: _CacheMissSentinel | None = None

    def __new__(cls) -> _CacheMissSentinel:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "<CACHE_MISS>"


_CACHE_MISS: Final[_CacheMissSentinel] = _CacheMissSentinel()


def _resolve_cache_lookup(project_hash: str, file_part: str) -> str | None | _CacheMissSentinel:
    """Return the cached rel_path, None (confirmed-not-found), or _CACHE_MISS (absent).

    Callers should check ``result is _CACHE_MISS`` to detect a cache miss and
    fall through to the DB query.  Any other return value (str or None) is a
    cache hit and should be returned directly.
    """
    key = (project_hash, file_part)
    result = _RESOLVE_CACHE.get(key, _CACHE_MISS)
    if result is _CACHE_MISS:
        _LOG.debug("resolve_cache miss: project=%s file=%r cache_size=%d", project_hash[:8], file_part, len(_RESOLVE_CACHE))
    else:
        _LOG.debug("resolve_cache hit: project=%s file=%r -> %r cache_size=%d", project_hash[:8], file_part, result, len(_RESOLVE_CACHE))
    return result


def _resolve_cache_put(project_hash: str, file_part: str, rel_path: str | None) -> None:
    """Store a file-resolution result in the in-process cache.

    If cache is full (512 entries), evicts 128 oldest entries (FIFO). Stores either
    a rel_path string or None (meaning "this file not found in this project").
    """
    key = (project_hash, file_part)
    if key in _RESOLVE_CACHE:
        _RESOLVE_CACHE[key] = rel_path
        _LOG.debug("resolve_cache update: project=%s file=%r -> %r", project_hash[:8], file_part, rel_path)
        return
    if len(_RESOLVE_CACHE) >= _RESOLVE_CACHE_MAX:
        # Evict oldest entries (dict preserves insertion order in Python 3.7+).
        # islice over the keys view avoids materialising the full key list (512
        # entries) just to slice the first 128.  list() is still needed because
        # we cannot delete from a dict while iterating its keys view.
        evict_keys = list(islice(_RESOLVE_CACHE.keys(), _RESOLVE_CACHE_EVICT))
        for k in evict_keys:
            del _RESOLVE_CACHE[k]
        _LOG.debug("resolve_cache evicted %d entries (project=%s)", _RESOLVE_CACHE_EVICT, project_hash[:8])
    _RESOLVE_CACHE[key] = rel_path
    _LOG.debug("resolve_cache store: project=%s file=%r -> %r cache_size=%d", project_hash[:8], file_part, rel_path, len(_RESOLVE_CACHE))


def invalidate_file_cache(project_hash: str) -> int:
    """Remove all cached resolutions for a project. Returns count evicted.

    Called by the post-edit hook after a file is reindexed so the next lookup
    gets a fresh result from the DB.
    """
    # Rebuild in-place, keeping only entries that belong to other projects.
    # Snapshot items first, then clear and repopulate to avoid a separate
    # list-of-stale-keys pass followed by individual deletes.
    kept = {k: v for k, v in _RESOLVE_CACHE.items() if k[0] != project_hash}
    evicted = len(_RESOLVE_CACHE) - len(kept)
    _RESOLVE_CACHE.clear()
    _RESOLVE_CACHE.update(kept)
    if evicted:
        _LOG.debug(
            "invalidate_file_cache: evicted %d resolution(s) for project=%s (cache_size now=%d)",
            evicted,
            project_hash[:8],
            len(_RESOLVE_CACHE),
        )
    else:
        _LOG.debug(
            "invalidate_file_cache: no cached entries for project=%s (cache_size=%d)",
            project_hash[:8],
            len(_RESOLVE_CACHE),
        )
    return evicted


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
    # Score every candidate once upfront, then sort by score descending.
    # This avoids calling _match_specificity a second time for the tie-break
    # comparison (was 3 calls for 2 candidates; now exactly n calls).
    scored = sorted(
        ((r, _match_specificity(file_part, r)) for r in candidates),
        key=operator.itemgetter(1),
        reverse=True,
    )
    if scored[1][1] == scored[0][1]:
        return None  # tie → still ambiguous
    return scored[0][0]


def _is_absolute(file_part: str) -> bool:
    """Return True when file_part is an absolute path on any platform.

    Covers POSIX (/foo), Windows drive-letter (C:/foo or C:\\foo), and
    UNC (//host/share) forms so the traversal guards in resolve_file_rel
    and _resolve_file_rel_db never reject legitimate absolute-path inputs.
    """
    if file_part.startswith("/") or file_part.startswith("\\"):
        return True
    # Windows drive-letter form: X: or X:/ or X:\
    return len(file_part) >= 2 and file_part[1] == ":" and file_part[0].isalpha()


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

    Rejects relative paths that contain ``..`` traversal components.  Absolute
    paths are allowed through; ``_resolve_file_rel_db`` resolves them against
    the project root and enforces containment via ``Path.relative_to``.
    """
    file_part = file_part.replace("\\", "/").strip()

    # Reject relative-path traversal attempts early. Absolute paths are
    # handled safely in _resolve_file_rel_db via relative_to() which enforces
    # project root containment — they must not be filtered here.
    if not _is_absolute(file_part) and ".." in file_part.split("/"):
        _LOG.warning("resolve_file_rel: rejected traversal attempt: %r", file_part)
        return None

    # Cache hit — avoids DB round-trips for repeated lookups within same process
    cached = _resolve_cache_lookup(project.hash, file_part)
    if not isinstance(cached, _CacheMissSentinel):
        return cached  # str | None — narrowed away from _CacheMissSentinel

    result = _resolve_file_rel_db(project, file_part)
    _resolve_cache_put(project.hash, file_part, result)
    return result


def _resolve_file_rel_db(project: Project, file_part: str) -> str | None:
    """Un-cached DB-backed resolution. Called by resolve_file_rel."""
    with db.open_project(project.hash) as conn:
        # 1. Exact relative match — guard against any traversal that slipped
        #    through (e.g. callers that bypass resolve_file_rel).
        #    Absolute paths are exempt: they are validated via relative_to()
        #    in step 2 below, which enforces project root containment.
        if not _is_absolute(file_part) and not _is_safe_rel_path(file_part):
            _LOG.warning("_resolve_file_rel_db: rejected unsafe rel_path: %r", file_part)
            return None
        row = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path = ?", (file_part,)
        ).fetchone()
        if row:
            return row["rel_path"]

        # 2. Absolute path — make it relative to project root
        abs_path = Path(file_part)
        if abs_path.is_absolute():
            try:
                rel = abs_path.resolve().relative_to(project.root.resolve()).as_posix()
                row = conn.execute(
                    "SELECT rel_path FROM files WHERE rel_path = ?", (rel,)
                ).fetchone()
                if row:
                    return row["rel_path"]
            except ValueError:
                # path is not under this project root — expected control flow when
                # an absolute path from a different drive/mount is passed in
                _LOG.debug(
                    "_resolve_file_rel_db: absolute path %s is not under project root %s",
                    file_part,
                    project.root,
                )
            except OSError as e:
                _LOG.debug("resolve_file_rel: could not resolve absolute path %s: %s", file_part, e)

        # 3. Endswith match — handles bare filename or partial path
        rows = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\'",
            (f"%{_escape_like_pattern(file_part)}",),
        ).fetchall()
        if not rows:
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
    except (OSError, sqlite3.Error) as exc:
        _LOG.warning("find_in_all_projects: global DB unavailable: %s", exc)
        raise ProjectIndexUnavailable(
            "Project index database is unavailable. Run `token-goat index --full` again."
        ) from exc
    except Exception as exc:  # noqa: BLE001 — unexpected error; fail-soft for cross-project lookup
        _LOG.warning(
            "find_in_all_projects: unexpected error opening global DB (%s: %s); skipping cross-project lookup",
            type(exc).__name__,
            exc,
        )
        return None

    _LOG.debug("find_in_all_projects: searching %d indexed project(s) for %r", len(rows), file_part)
    matches: list[tuple[Project, str]] = []
    # Formatted as "{project_hash_prefix}:{rel_path}" for error messages.
    # Collects both within-project ambiguities (from AmbiguousFileMatch) and
    # cross-project ambiguities (multiple projects each returning a distinct match).
    cross_project_candidates: list[str] = []
    project_errors: list[str] = []
    for row in rows:
        proj = Project(root=Path(row["root"]), hash=row["hash"], marker=row["marker"])
        try:
            rel = resolve_file_rel(proj, file_part)
        except AmbiguousFileMatch as exc:
            # Multiple files within this single project matched — record all of them.
            cross_project_candidates.extend(
                f"{proj.hash[:8]}:{rel_path}" for rel_path in exc.candidates
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
        proj, rel = matches[0]
        _LOG.debug("find_in_all_projects: found %r in project %s", rel, proj.hash[:8])
        return matches[0]
    # Combine unambiguous-but-multiple matches with any per-project ambiguous candidates,
    # deduplicate, and raise so the caller can surface all possibilities.
    all_candidates = [f"{proj.hash[:8]}:{rel}" for proj, rel in matches]
    all_candidates.extend(cross_project_candidates)
    if len(all_candidates) > 1:
        # sorted(set(...)) deduplicates without allocating a temporary dict —
        # dict.fromkeys preserves insertion order, but sorted() discards it anyway,
        # so a set is the right dedup structure here.
        all_candidates = sorted(set(all_candidates))
        _LOG.debug(
            "ambiguous cross-project file match for %s: %s",
            file_part,
            ", ".join(all_candidates),
        )
        raise AmbiguousFileMatch(file_part, all_candidates)
    if project_errors:
        raise ProjectIndexUnavailable(
            "Project index database is unavailable for one or more indexed projects. "
            "Run `token-goat index --full` again."
        )
    if not matches:
        _LOG.debug("find_in_all_projects: no match found for %r across %d project(s)", file_part, len(rows))
    return matches[0] if matches else None


def _extract_snippet(
    lines: list[str],
    full_bytes: int,
    row_start: int | None,
    row_end: int | None,
    context_lines: int,
) -> tuple[str, int, int, int]:
    """Slice *lines* to the requested range plus optional context.

    Both ``read_symbol`` and ``read_section`` share the identical logic of
    clamping start/end, joining the slice, and computing byte statistics.
    Centralising it here keeps both callers in sync and removes the duplication.

    Parameters
    ----------
    lines:
        All lines of the file (1-indexed in DB; 0-indexed list).
    full_bytes:
        Total byte size of the file (for bytes_saved calculation).
    row_start, row_end:
        1-based line numbers from the DB row (``row["line"]``, ``row["end_line"]``).
        Either may be None when the DB row has a NULL value; both default to 1 so
        callers get an empty-but-valid result rather than a TypeError.
    context_lines:
        Extra lines to include before/after the symbol or section.

    Returns
    -------
    snippet, snippet_bytes, start, end
        The extracted text, its byte size, and the clamped 1-based start/end
        line numbers actually used.
    """
    safe_start = int(row_start) if row_start is not None else 1
    safe_end = int(row_end) if row_end is not None else safe_start
    start = max(1, safe_start - context_lines)
    end = min(len(lines), safe_end + context_lines)
    snippet = "\n".join(lines[start - 1 : end])
    snippet_bytes = len(snippet.encode("utf-8"))
    return snippet, snippet_bytes, start, end



def _pct_saved(snippet_bytes: int, full_bytes: int) -> float:
    """Return the percentage of bytes saved by extracting *snippet_bytes* from *full_bytes*.

    Returns 0.0 when *full_bytes* is zero to avoid division by zero.
    """
    if not full_bytes:
        return 0.0
    return 100.0 * max(0, full_bytes - snippet_bytes) / full_bytes


def _read_file_lines(abs_path: Path) -> tuple[list[str], int] | None:
    """Read *abs_path*, split into lines, and return (lines, byte_size).

    Returns ``None`` on any I/O error, if the file is empty, or if the file
    exceeds ``_MAX_READ_BYTES``.  The size cap prevents an unbounded in-memory
    read when a file grows well past the indexer's 2 MB cap after it was
    indexed (e.g. a generated file appended to repeatedly).

    Callers can use ``result = _read_file_lines(p); if result is None: return
    None`` without repeating the try/except or size/empty check.
    """
    try:
        file_size = abs_path.stat().st_size
    except OSError as e:
        _LOG.warning("stat failed: %s: %s", abs_path, e)
        return None

    if file_size > _MAX_READ_BYTES:
        _LOG.warning(
            "read_file_lines: skipping oversized file %s (%d bytes > %d limit)",
            abs_path, file_size, _MAX_READ_BYTES,
        )
        return None

    try:
        full_text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        _LOG.warning("read failed: %s: %s", abs_path, e)
        return None
    lines = full_text.splitlines()
    if not lines:
        _LOG.debug("_read_file_lines: empty file (no lines): %s", abs_path)
        return None
    return lines, len(full_text.encode("utf-8"))


def read_symbol(
    project: Project,
    rel_path: str,
    symbol: str,
    *,
    context_lines: int = 0,
) -> SymbolResult | None:
    """Look up symbol in DB, slice the file, return extraction dict.

    Returns a SymbolResult with keys:
        file, symbol, kind, start_line, end_line, text,
        signature, bytes_total, bytes_extracted, bytes_saved
    Returns None if the symbol is not found or the file cannot be read.
    """
    t0 = time.monotonic()
    if not _validate_lookup_args("read_symbol", rel_path, symbol):
        return None

    try:
        with db.open_project(project.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, line, end_line, signature FROM symbols "
                "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL ORDER BY line",
                (rel_path, symbol),
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        _LOG.warning(
            "read_symbol: DB error for project=%s file=%s symbol=%s: %s",
            project.hash[:8],
            rel_path,
            symbol,
            exc,
        )
        return None
    if not rows:
        _LOG.debug(
            "symbol not found: project=%s file=%s symbol=%s",
            project.hash[:8],
            rel_path,
            symbol,
        )
        return None

    # If multiple matches (e.g., a top-level function and a method of the same name),
    # prefer by kind priority then by earliest line.
    # Pre-bind _KIND_PRIORITY.get to avoid repeated global + attribute lookup in min().
    _kp_get = _KIND_PRIORITY.get
    chosen = min(rows, key=lambda r: (_kp_get(r["kind"], 9), r["line"]))

    read_result = _read_file_lines(project.root / rel_path)
    if read_result is None:
        _LOG.debug("read_symbol: cannot read file %s in project %s", rel_path, project.hash[:8])
        return None
    lines, full_bytes = read_result

    sym_line: int = _coerce_line(chosen["line"], 1)
    sym_end_line: int | None = _coerce_end_line(chosen["end_line"])
    snippet, snippet_bytes, start, end = _extract_snippet(
        lines, full_bytes, sym_line, sym_end_line, context_lines
    )
    elapsed = time.monotonic() - t0
    _LOG.debug(
        "read_symbol: %s::%s (%s) lines %d-%d, %d/%d bytes extracted (%.1f%% saved, %.3fs)",
        rel_path,
        chosen["name"],
        chosen["kind"],
        start,
        end,
        snippet_bytes,
        full_bytes,
        _pct_saved(snippet_bytes, full_bytes),
        elapsed,
    )
    return SymbolResult(
        file=rel_path,
        symbol=chosen["name"],
        kind=chosen["kind"],
        start_line=start,
        end_line=end,
        text=snippet,
        signature=chosen["signature"],
        bytes_total=full_bytes,
        bytes_extracted=snippet_bytes,
        bytes_saved=max(0, full_bytes - snippet_bytes),
    )


def read_section(
    project: Project,
    rel_path: str,
    heading: str,
    *,
    context_lines: int = 0,
) -> SectionResult | None:
    """Same as read_symbol but for markdown/HTML/Liquid section headings.

    Returns a SectionResult with keys:
        file, heading, level, start_line, end_line, text,
        bytes_total, bytes_extracted, bytes_saved
    Returns None if the heading is not found or the file cannot be read.
    """
    t0 = time.monotonic()
    if not _validate_lookup_args("read_section", rel_path, heading):
        return None

    try:
        with db.open_project(project.hash) as conn:
            rows = conn.execute(
                "SELECT heading, level, line, end_line FROM sections "
                "WHERE file_rel = ? AND heading = ? AND end_line IS NOT NULL ORDER BY line",
                (rel_path, heading),
            ).fetchall()
            case_sensitive_match = len(rows) > 0
            if not rows:
                # Fallback: case-insensitive match
                rows = conn.execute(
                    "SELECT heading, level, line, end_line FROM sections "
                    "WHERE file_rel = ? AND lower(heading) = lower(?) AND end_line IS NOT NULL ORDER BY line",
                    (rel_path, heading),
                ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        _LOG.warning(
            "read_section: DB error for project=%s file=%s heading=%s: %s",
            project.hash[:8],
            rel_path,
            heading,
            exc,
        )
        return None
    if not rows:
        _LOG.debug(
            "section not found: project=%s file=%s heading=%s",
            project.hash[:8],
            rel_path,
            heading,
        )
        return None

    chosen = rows[0]  # first match by line order

    read_result = _read_file_lines(project.root / rel_path)
    if read_result is None:
        _LOG.debug("read_section: cannot read file %s in project %s", rel_path, project.hash[:8])
        return None
    lines, full_bytes = read_result

    sec_line: int = _coerce_line(chosen["line"], 1)
    sec_end_line: int | None = _coerce_end_line(chosen["end_line"])
    snippet, snippet_bytes, start, end = _extract_snippet(
        lines, full_bytes, sec_line, sec_end_line, context_lines
    )
    elapsed = time.monotonic() - t0
    match_kind = "exact" if case_sensitive_match else "case-insensitive"
    if not case_sensitive_match:
        _LOG.info(
            "read_section: heading %r not found by exact match in %s — "
            "fell back to case-insensitive match → %r",
            heading,
            rel_path,
            chosen["heading"],
        )
    _LOG.debug(
        "read_section: %s#%s (h%d, %s-match) lines %d-%d, %d/%d bytes extracted (%.1f%% saved, %.3fs)",
        rel_path,
        chosen["heading"],
        chosen["level"],
        match_kind,
        start,
        end,
        snippet_bytes,
        full_bytes,
        _pct_saved(snippet_bytes, full_bytes),
        elapsed,
    )
    return SectionResult(
        file=rel_path,
        heading=chosen["heading"],
        level=chosen["level"],
        start_line=start,
        end_line=end,
        text=snippet,
        bytes_total=full_bytes,
        bytes_extracted=snippet_bytes,
        bytes_saved=max(0, full_bytes - snippet_bytes),
    )
