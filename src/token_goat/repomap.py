"""PageRank-based repo map: token-budgeted overview of a project."""
from __future__ import annotations

__all__ = [
    "KIND_PRIORITY",
    "FileSummary",
    "FileMapItem",
    "build_map",
    "build_map_json",
    "compute_ranks",
    "estimate_tokens",
    "render_summary",
]

import contextlib
import heapq
import logging
import sqlite3
import time
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Final, Protocol, TypedDict

from . import db

if TYPE_CHECKING:
    from .project import Project


class _NxGraph(Protocol):
    """Structural protocol for a networkx graph used in PageRank helpers.

    Only the methods actually called by :func:`_build_graph`,
    :func:`_multigraph_to_weighted_digraph`, and :func:`compute_ranks` are
    declared here.  Using a Protocol (rather than bare ``object``) lets mypy
    verify that callers pass graph-like objects and that the return types flow
    correctly through the pipeline — without pulling in the optional networkx
    stubs package as a dependency.
    """

    def add_node(self, node: str) -> None: ...
    def add_edge(self, u: str, v: str) -> None: ...
    def add_edges_from(
        self, ebunch: Iterable[tuple[str, str] | tuple[str, str, dict[str, float]]]
    ) -> None: ...
    def number_of_nodes(self) -> int: ...
    def number_of_edges(self) -> int: ...

    @property
    def nodes(self) -> Iterable[str]: ...

    @property
    def edges(self) -> Iterable[tuple[str, str]]: ...


class _FileInfo(TypedDict):
    """Raw file metadata loaded from the ``files`` table of a project DB.

    Attributes:
        language: Detected language name as stored by the indexer (e.g. ``"python"``,
            ``"typescript"``).
        size: File size in bytes at the time of last indexing.  Used to estimate
            line count (size // _BYTES_PER_APPROX_LINE) and as a tie-breaker rank
            when all PageRank scores are identical (no cross-file edges).
        mtime: Modification time (Unix timestamp) at last indexing.  Together with
            *size*, this forms the cache key for pre-rendered summary strings stored
            in the ``repomap_cache`` table.
    """

    language: str
    size: int
    mtime: float


@dataclass
class _RankedProjectData:
    """Intermediate result from ``_load_and_rank`` — all data needed to render the repo map.

    Attributes:
        files: Map-worthy files only (fixtures and trivially small files excluded).
            Key is the repository-relative POSIX path; value is ``_FileInfo``.
        symbols_by_file: ``{rel_path: [(kind, name), ...]}`` — all indexed symbols
            for each file, used to build ``FileSummary.top_symbols``.
        sections_by_file: ``{rel_path: [(level, heading), ...]}`` — document headings
            for markdown/HTML/Liquid files, used to build ``FileSummary.top_sections``.
        ranked: All map-worthy files sorted by descending PageRank score (or file size
            as a fallback when the graph has no edges).  Callers iterate this list
            to fill the token budget from most- to least-important files.
        ranks: Raw PageRank scores keyed by rel_path.  Kept separate from ``ranked``
            so ``_summarize_file`` can look up any file's score by path without
            scanning the sorted list.
        summary_cache: Pre-rendered text strings keyed on ``(rel_path, mtime, size)``.
            A cache hit means the file has not changed since the last ``build_map``
            call and its summary can be reused without re-invoking ``_summarize_file``
            + ``render_summary``.
    """

    files: dict[str, _FileInfo]
    symbols_by_file: dict[str, list[tuple[str, str]]]
    sections_by_file: dict[str, list[tuple[int, str]]]
    ranked: list[tuple[str, _FileInfo]]
    ranks: dict[str, float]
    summary_cache: dict[tuple[str, float, int], str]  # (rel_path, mtime, size) → rendered text


class FileMapItem(TypedDict):
    """Structured representation of a single file in the repo map (JSON output form).

    Attributes:
        path: Repository-relative POSIX path (e.g. ``"src/token_goat/db.py"``).
        language: Detected language (e.g. ``"python"``, ``"typescript"``).
        rank: PageRank score.  Higher means more cross-referenced by other files.
            Values are not normalized to a fixed range — compare relative magnitudes.
        symbols: Top symbols as ``[{"kind": "function", "name": "load"}, ...]``,
            ordered by ``KIND_PRIORITY``.  Maximum 8 entries per file.
        sections: Top-level and second-level headings for doc files.  Empty list
            for code files that have no extracted sections.
        approx_lines: Estimated line count derived from ``size // _BYTES_PER_APPROX_LINE``.
            Intentionally approximate — callers should not rely on exact values.
    """

    path: str
    language: str
    rank: float
    symbols: list[dict[str, str]]
    sections: list[str]
    approx_lines: int

_LOG = logging.getLogger("token_goat.repomap")

# Files below this approximate line count are structural noise (empty __init__.py stubs, etc.)
_MIN_DISPLAY_LINES: Final[int] = 4
# Maximum symbol names shown per kind group in render_summary output.
# Keeping this small prevents any one kind from dominating the text budget.
_MAX_NAMES_PER_KIND: Final[int] = 6
# POSIX path prefixes excluded from the map — these dirs are test fixtures, not source
_EXCLUDED_PREFIXES: Final[tuple[str, ...]] = ("tests/fixtures/",)
# Bytes-per-line divisor used to estimate line count from file size.
# Code files average 30–60 bytes/line; 50 gives a conservative (slightly
# over-counting) estimate so we include borderline files rather than drop them.
_BYTES_PER_APPROX_LINE: Final[int] = 50

# PageRank power-iteration parameters.
# First attempt uses tight tolerance for accuracy; on convergence failure a
# second pass relaxes both to give a usable (approximate) result.
_PAGERANK_MAX_ITER_NORMAL: Final[int] = 200
_PAGERANK_MAX_ITER_FALLBACK: Final[int] = 500
_PAGERANK_TOL_NORMAL: Final[float] = 1e-6
_PAGERANK_TOL_FALLBACK: Final[float] = 1e-4


@lru_cache(maxsize=2048)
def _is_excluded_path(rel_path: str) -> bool:
    """Return True if rel_path is under an excluded prefix.

    Cached with lru_cache so repeated calls across build_map invocations for
    the same file pay only a dict lookup.  The result depends only on rel_path
    and the module-level _EXCLUDED_PREFIXES constant, both of which are stable
    within a process lifetime.
    """
    posix = rel_path.replace("\\", "/") if "\\" in rel_path else rel_path
    return any(posix.startswith(p) for p in _EXCLUDED_PREFIXES)


def _is_map_worthy(rel_path: str, approx_lines: int) -> bool:
    """Return True if this file should appear in the repo map.

    Excludes test fixture stubs (which distort PageRank by accumulating refs
    from all parser tests) and trivially small files (empty __init__.py, etc.).
    """
    if _is_excluded_path(rel_path):
        return False
    return approx_lines >= _MIN_DISPLAY_LINES


def estimate_tokens(text: str) -> int:
    """Rough token estimate for a string (~3.5 chars/token for English/code mix).

    Uses integer division by 3 rather than the precise 3.5 ratio to keep the
    estimate conservative (slightly over-counts), ensuring the caller stays
    within token budgets rather than exceeding them.

    Returns at least 1 so callers never divide-by-zero on empty inputs.
    """
    return max(1, len(text) // 3 + 1)


# Symbol kinds in priority order (which to show first in a file summary)
KIND_PRIORITY: dict[str, int] = {
    "class": 0,
    "interface": 0,
    "trait": 0,
    "type": 1,
    "enum": 1,
    "function": 2,
    "method": 3,
    "const": 4,
    "var": 5,
    "import": 9,
    "heading": 1,        # for markdown/html
    "liquid_schema": 1,  # for shopify themes
    "abi_export": 5,
}


@dataclass
class FileSummary:
    """PageRank-weighted summary of a single file for the repo map output.

    Attributes:
        rel_path: Repository-relative POSIX path (e.g. ``src/token_goat/db.py``).
        language: Detected language name (e.g. ``python``, ``typescript``).
        rank: PageRank score — higher means more cross-referenced by other files.
        top_symbols: Priority-ordered symbols as ``(kind, name)`` pairs, e.g.
            ``[('class', 'SessionCache'), ('function', 'load')]``.
        top_sections: Headings extracted from docs/markdown files.
        line_count: Approximate line count derived from the file's stored size.
    """

    rel_path: str
    language: str
    rank: float
    top_symbols: list[tuple[str, str]]  # [(kind, name)]
    top_sections: list[str]             # headings
    line_count: int                     # approx


def _load_project_data(
    conn: sqlite3.Connection,
) -> tuple[dict[str, _FileInfo], dict[str, list[tuple[str, str]]], dict[str, list[tuple[int, str]]], dict[str, set[str]]]:
    """Load all indexed data for a project: files, symbols, sections, and reverse-index.

    Returns (files, symbols_by_file, sections_by_file, name_to_files):
      - files: {rel_path: {language, size, mtime}}
      - symbols_by_file: {rel_path: [(kind, name), ...]}
      - sections_by_file: {rel_path: [(level, heading), ...]}
      - name_to_files: {symbol_name: {rel_path, ...}} — all files defining this symbol

    Each table is queried independently so a missing or corrupt auxiliary table
    (symbols, sections, refs) degrades gracefully: the map still renders using
    whatever data is available rather than raising an unhandled OperationalError.
    """
    files: dict[str, _FileInfo] = {}
    try:
        for row in conn.execute("SELECT rel_path, language, size, mtime FROM files"):
            files[row["rel_path"]] = {
                "language": row["language"],
                "size": row["size"],
                "mtime": row["mtime"],
            }
    except sqlite3.OperationalError as exc:
        # files table missing or schema mismatch — nothing to map.
        _LOG.error("repomap: failed to read files table: %s", exc)
        return {}, defaultdict(list), defaultdict(list), defaultdict(set)

    symbols_by_file: dict[str, list[tuple[str, str]]] = defaultdict(list)
    name_to_files: dict[str, set[str]] = defaultdict(set)
    try:
        for row in conn.execute("SELECT name, kind, file_rel FROM symbols"):
            symbols_by_file[row["file_rel"]].append((row["kind"], row["name"]))
            name_to_files[row["name"]].add(row["file_rel"])
    except sqlite3.OperationalError as exc:
        _LOG.warning("repomap: failed to read symbols table (map will have no symbols): %s", exc)

    sections_by_file: dict[str, list[tuple[int, str]]] = defaultdict(list)
    try:
        for row in conn.execute(
            # ORDER BY file_rel removed: results land in a defaultdict keyed by
            # file_rel, so DB-level grouping by file is wasted sort work — O(S log S)
            # over all sections with no benefit.  level, line ordering is kept so
            # headings within each file appear in document order (top-level first,
            # then by position), which _summarize_file relies on for top_sections.
            "SELECT file_rel, heading, level FROM sections ORDER BY level, line"
        ):
            sections_by_file[row["file_rel"]].append((row["level"], row["heading"]))
    except sqlite3.OperationalError as exc:
        _LOG.warning("repomap: failed to read sections table (map will have no sections): %s", exc)

    return files, symbols_by_file, sections_by_file, name_to_files


def _build_graph(
    conn: sqlite3.Connection, files: dict[str, _FileInfo], name_to_files: dict[str, set[str]]
) -> _NxGraph:
    """Build a directed dependency graph: edge from file A to file B if A references a symbol defined in B.

    Nodes are all indexed files; edges represent cross-file symbol references (calls, attribute access, etc.).
    May have multiple edges between same pair (A references multiple symbols from B).
    """
    import networkx as nx  # noqa: PLC0415

    graph = nx.MultiDiGraph()

    # Add all files as nodes
    for file_path in files:
        graph.add_node(file_path)

    # Add edges from references to their definitions
    try:
        ref_rows = conn.execute("SELECT symbol_name, file_rel FROM refs").fetchall()
    except sqlite3.OperationalError as exc:
        # refs table is absent on a freshly-initialised project DB (schema migrates lazily).
        # Return a nodes-only graph so PageRank still ranks files by degree rather than failing.
        _LOG.warning("repomap: failed to read refs table (graph will have no edges): %s", exc)
        return graph

    for row in ref_rows:
        referenced_symbol = row["symbol_name"]
        referencing_file = row["file_rel"]
        if referencing_file not in files:
            continue
        # Use an empty tuple as the miss-default instead of set() to avoid
        # allocating a new empty set object on every cache miss.  A tuple is
        # iterable (the only operation performed below) and does not allocate.
        definition_files = name_to_files.get(referenced_symbol) or ()

        for definition_file in definition_files:
            if definition_file != referencing_file and definition_file in files:
                graph.add_edge(referencing_file, definition_file)

    return graph


def _multigraph_to_weighted_digraph(multigraph: _NxGraph) -> _NxGraph:
    """Collapse a multigraph to a simple weighted DiGraph for PageRank input.

    The dependency graph is built as a ``MultiDiGraph`` because the same pair of
    files (A → B) can share multiple edges when A references several different
    symbols defined in B.  NetworkX's PageRank algorithm requires a simple graph
    (at most one edge per pair), so those parallel edges are collapsed into a
    single edge whose ``weight`` equals the edge count.  A higher weight means
    A depends more heavily on B — the more symbols A imports from B, the more
    PageRank "votes" B receives, reflecting its true structural importance.
    """
    import networkx as nx  # noqa: PLC0415

    simple_graph = nx.DiGraph()

    # Add all nodes
    for node in multigraph.nodes:
        simple_graph.add_node(node)

    # Count parallel edges in a single pass, then add them all at once.
    # This avoids a has_edge() + dict-lookup conditional on every edge,
    # replacing O(E) graph attribute writes with one Counter pass + one
    # add_edges_from call.
    edge_weights: Counter[tuple[object, object]] = Counter(multigraph.edges)
    simple_graph.add_edges_from(
        (src, dst, {"weight": float(w)}) for (src, dst), w in edge_weights.items()
    )

    return simple_graph


def compute_ranks(graph: _NxGraph, *, alpha: float = 0.85) -> dict[str, float]:
    """Run PageRank on the multigraph (collapsed to simple graph for nx).

    Uses the pure-Python power-iteration implementation to avoid a hard
    dependency on scipy, which is not in the project's dependency list.

    Falls back gracefully on any failure: first relaxes convergence parameters,
    then falls back to uniform ranks if the private API is unavailable (e.g.
    future networkx versions that rename/remove ``_pagerank_python``).
    """
    import networkx as nx  # noqa: PLC0415

    if graph.number_of_nodes() == 0:
        return {}

    simple_graph = _multigraph_to_weighted_digraph(graph)

    def _uniform_ranks() -> dict[str, float]:
        node_count = simple_graph.number_of_nodes()
        rank = 1.0 / node_count if node_count else 1.0
        return {node: rank for node in simple_graph.nodes}

    # _pagerank_python is a private networkx symbol — guard the import so a
    # future networkx rename does not crash the entire map command.
    try:
        from networkx.algorithms.link_analysis.pagerank_alg import (  # noqa: PLC0415
            _pagerank_python,
        )
    except ImportError:
        _LOG.warning(
            "networkx._pagerank_python unavailable (API changed?); "
            "falling back to nx.pagerank with scipy"
        )
        try:
            return nx.pagerank(simple_graph, alpha=alpha, weight="weight")
        except Exception as exc:  # noqa: BLE001
            _LOG.warning("nx.pagerank also failed (%s); using uniform ranks", exc)
            return _uniform_ranks()

    # Use the pure-Python implementation — avoids requiring scipy.
    try:
        return _pagerank_python(
            simple_graph, alpha=alpha, weight="weight",
            max_iter=_PAGERANK_MAX_ITER_NORMAL, tol=_PAGERANK_TOL_NORMAL,
        )
    except nx.PowerIterationFailedConvergence:
        _LOG.debug("PageRank did not converge at tol=%s; retrying with relaxed parameters", _PAGERANK_TOL_NORMAL)
        try:
            return _pagerank_python(
                simple_graph, alpha=alpha, weight="weight",
                max_iter=_PAGERANK_MAX_ITER_FALLBACK, tol=_PAGERANK_TOL_FALLBACK,
            )
        except nx.PowerIterationFailedConvergence:
            _LOG.warning(
                "PageRank failed to converge even with relaxed parameters "
                "(max_iter=%d, tol=%s); using uniform ranks",
                _PAGERANK_MAX_ITER_FALLBACK, _PAGERANK_TOL_FALLBACK,
            )
            return _uniform_ranks()
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("PageRank raised unexpected error (%s); using uniform ranks", exc)
        return _uniform_ranks()


def _summarize_file(
    rel: str,
    info: _FileInfo,
    symbols: list[tuple[str, str]],
    sections: list[tuple[int, str]],
    rank: float,
    *,
    max_symbols: int = 8,
    max_sections: int = 5,
) -> FileSummary:
    """Produce a concise FileSummary for a single file.

    Filters to top N symbols (by priority: class, interface, trait, type, enum, function, etc.),
    top N level-1/2 sections (document headings), and computes approximate line count
    from file size. Used by build_map for text rendering and build_map_json for structured output.
    """
    # heapq.nsmallest avoids a full O(N log N) sort when symbols >> max_symbols.
    # For a file with 200 symbols and max_symbols=8 this is O(N log 8) vs O(N log N),
    # typically 3-5x faster.  The key tuple is (priority, name) so the order matches
    # the previous sorted() output exactly.
    # Pre-bind KIND_PRIORITY.get to a local to avoid a global lookup + attribute
    # access on every comparison inside nsmallest (called once per symbol).
    _kp_get_sym = KIND_PRIORITY.get
    top_n = heapq.nsmallest(
        max_symbols * 4,  # over-fetch to have room to deduplicate duplicates
        symbols,
        key=lambda ks: (_kp_get_sym(ks[0], 99), ks[1]),
    )
    # Build top_symbols with a set for O(1) duplicate detection
    top_symbols: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for kind, name in top_n:
        entry = (kind, name)
        if entry not in seen:
            seen.add(entry)
            top_symbols.append(entry)
            if len(top_symbols) >= max_symbols:
                break

    # Filter sections to level <= 2 and limit to max_sections
    top_sections = [h for lvl, h in sections if lvl <= 2][:max_sections]
    approx_lines = max(1, info["size"] // _BYTES_PER_APPROX_LINE)
    return FileSummary(
        rel_path=rel,
        language=info["language"],
        rank=rank,
        top_symbols=top_symbols,
        top_sections=top_sections,
        line_count=approx_lines,
    )


def render_summary(summary: FileSummary) -> str:
    """Render a single file summary as text.

    Groups symbols by kind and emits kinds in priority order.  Uses a two-pass
    approach: first build a plain dict grouping names by kind (O(n)), then emit
    the unique kinds sorted by priority (O(k log k) where k = unique kinds, not
    n = total symbols).  This avoids re-sorting the entire symbol list on every
    call — only the small set of distinct kind strings is sorted.
    """
    lines = [f"{summary.rel_path}  [{summary.language}, ~{summary.line_count}L, rank={summary.rank:.4f}]"]
    if summary.top_symbols:
        by_kind: dict[str, list[str]] = {}
        for kind, name in summary.top_symbols:
            by_kind.setdefault(kind, []).append(name)
        # Bind KIND_PRIORITY.get locally so the sort key avoids a global +
        # attribute lookup on every comparison (typically k=3-6 unique kinds).
        _kp_get = KIND_PRIORITY.get
        for kind in sorted(by_kind, key=lambda k: _kp_get(k, 99)):
            names = ", ".join(by_kind[kind][:_MAX_NAMES_PER_KIND])
            lines.append(f"  {kind}: {names}")
    if summary.top_sections:
        lines.append(f"  sections: {' > '.join(summary.top_sections)}")
    return "\n".join(lines)


def _load_summary_cache(conn: sqlite3.Connection) -> dict[tuple[str, float, int], str]:
    """Load all cached summary texts keyed on (rel_path, mtime, size).

    Returns a dict for O(1) cache hits during the per-file summary loop.
    Only called once per build_map invocation so the single full-table scan
    pays for itself immediately when even one file is unchanged.
    """
    cache: dict[tuple[str, float, int], str] = {}
    try:
        for row in conn.execute(
            "SELECT rel_path, mtime, size, summary_text FROM repomap_cache"
        ):
            cache[(row["rel_path"], row["mtime"], row["size"])] = row["summary_text"]
    except sqlite3.OperationalError as exc:
        # Table may not exist yet in older DBs — treat as empty cache.
        _LOG.debug("repomap_cache table unavailable (older schema?): %s", exc)
    return cache


def _write_summary_cache(
    conn: sqlite3.Connection,
    entries: list[tuple[str, float, int, str]],
) -> None:
    """Persist new cache entries as (rel_path, mtime, size, summary_text).

    Uses INSERT OR REPLACE so a file re-indexed with the same mtime+size
    (e.g. after a content revert) gets a fresh entry rather than a constraint
    error.  Silently no-ops when the table is absent (old schema fallback).
    """
    if not entries:
        return
    now = int(time.time())
    rows = [(rel, mtime, size, text, now) for rel, mtime, size, text in entries]
    with contextlib.suppress(sqlite3.OperationalError):
        conn.executemany(
            "INSERT OR REPLACE INTO repomap_cache "
            "(rel_path, mtime, size, summary_text, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            rows,
        )


def _evict_stale_cache(conn: sqlite3.Connection, current_files: dict[str, _FileInfo]) -> None:
    """Remove cache entries for files no longer in the files table.

    The FOREIGN KEY ON DELETE CASCADE on repomap_cache.rel_path handles
    deletions that go through the files table (normal re-index path).  This
    function handles the edge case where the files table was wiped externally
    or a full re-index reset the file rows, leaving orphaned cache rows with
    stale mtime/size keys that will never be hit again.
    """
    if not current_files:
        return
    try:
        ph = ",".join("?" for _ in current_files)
        conn.execute(
            f"DELETE FROM repomap_cache WHERE rel_path NOT IN ({ph})",  # noqa: S608
            list(current_files.keys()),
        )
    except sqlite3.OperationalError as exc:
        _LOG.debug("repomap_cache eviction skipped (table absent or schema mismatch): %s", exc)


def _load_and_rank(project: Project) -> _RankedProjectData | None:
    """Load project data, filter, compute PageRank, and return sorted ranking.

    Returns a ``_RankedProjectData`` struct or ``None`` when there are no
    indexed files (callers handle the empty case).

    ``summary_cache`` maps ``(rel_path, mtime, size)`` to pre-rendered summary
    text strings.  Callers that produce text output (``build_map``) use it to
    skip re-computing unchanged file summaries; callers that need structured
    data (``build_map_json``) bypass it and recompute ``FileSummary`` objects.
    """
    t0 = time.monotonic()
    try:
        with db.open_project(project.hash) as conn:
            all_files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
            if not all_files:
                _LOG.debug("_load_and_rank: no indexed files for project %s", project.root.name)
                return None
            total_file_count = len(all_files)
            map_worthy_files = {
                rel: info
                for rel, info in all_files.items()
                if _is_map_worthy(rel, max(1, info["size"] // _BYTES_PER_APPROX_LINE))
            }
            graph = _build_graph(conn, map_worthy_files, name_to_files)
            summary_cache = _load_summary_cache(conn)
            _evict_stale_cache(conn, map_worthy_files)
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "_load_and_rank: failed to load project data for %s: %s",
            project.root.name, exc, exc_info=True,
        )
        return None
    t_db = time.monotonic()

    ranks = compute_ranks(graph)
    # Fallback: if every node has the same rank (no edges), break ties by file size.
    # Short-circuit with min/max comparison instead of building a full set of float
    # values — O(n) single pass vs O(n) set build + O(1) len check, but avoids
    # allocating a set of N floats (one per indexed file).
    _rank_values = ranks.values()
    all_ranks_equal = not ranks or (min(_rank_values) == max(_rank_values))
    if all_ranks_equal:
        _LOG.debug(
            "_load_and_rank: PageRank produced uniform scores (no edges or empty); "
            "falling back to file-size ranking for %s (%d files)",
            project.root.name, len(map_worthy_files),
        )
        ranks = {rel: float(info["size"]) for rel, info in map_worthy_files.items()}
    t_rank = time.monotonic()

    # Pre-bind ranks.get to avoid attribute lookup on every sort comparison.
    _ranks_get = ranks.get
    ranked = sorted(map_worthy_files.items(), key=lambda kv: _ranks_get(kv[0], 0.0), reverse=True)
    filtered_count = total_file_count - len(map_worthy_files)
    _LOG.debug(
        "_load_and_rank: project=%s files=%d/%d (filtered=%d) db=%.3fs pagerank=%.3fs total=%.3fs",
        project.root.name,
        len(map_worthy_files),
        total_file_count,
        filtered_count,
        t_db - t0,
        t_rank - t_db,
        t_rank - t0,
    )
    return _RankedProjectData(
        files=map_worthy_files,
        symbols_by_file=symbols_by_file,
        sections_by_file=sections_by_file,
        ranked=ranked,
        ranks=ranks,
        summary_cache=summary_cache,
    )


def _get_rendered_summary(
    rel: str,
    info: _FileInfo,
    data: _RankedProjectData,
    cache_writes: list[tuple[str, float, int, str]],
) -> tuple[str, bool]:
    """Return the rendered text for one file and whether it was a cache hit.

    Checks ``data.summary_cache`` for a pre-rendered string keyed on
    ``(rel_path, mtime, size)``.  On a miss, calls ``_summarize_file`` +
    ``render_summary`` and appends the result to *cache_writes* for
    persistence at the end of the ``build_map`` call.

    *cache_writes* is an out-parameter owned by the caller (``build_map``).
    Each entry is ``(rel_path, mtime, size, rendered_text)`` — the same tuple
    shape used as the cache key so the caller can bulk-insert without re-deriving
    the key components.

    Returns ``(rendered_text, is_cache_hit)``.
    """
    mtime: float = info["mtime"]
    size: int = info["size"]
    cached_text = data.summary_cache.get((rel, mtime, size))
    if cached_text is not None:
        return cached_text, True

    _LOG.debug("repomap summary cache miss: %s (mtime=%.3f size=%d)", rel, mtime, size)
    summary = _summarize_file(
        rel,
        info,
        data.symbols_by_file.get(rel, []),
        data.sections_by_file.get(rel, []),
        data.ranks.get(rel, 0.0),
    )
    rendered = render_summary(summary) + "\n"
    cache_writes.append((rel, mtime, size, rendered))
    return rendered, False


def build_map(
    project: Project,
    *,
    budget_tokens: int = 4000,
    include_unranked_tail: bool = True,
) -> str:
    """Build the repo map text under the token budget.

    Uses an incremental cache (``repomap_cache`` table in the project DB) to
    skip re-rendering file summaries whose ``(mtime, size)`` hasn't changed
    since the last run.  Only files that are new or modified incur the full
    ``_summarize_file`` + ``render_summary`` cost.  New rendered strings are
    written back to the cache at the end of the call.
    """
    t0 = time.monotonic()
    data = _load_and_rank(project)
    if data is None:
        return (
            f"# {project.root.name}\n\n"
            "(no files indexed — run `token-goat index --full`)\n"
        )

    lang_set = sorted({info["language"] for info in data.files.values()})
    header = f"# {project.root.name}\n  files={len(data.files)} languages={','.join(lang_set)}\n\n"
    out = [header]
    used = estimate_tokens(header)
    included = 0
    cache_hits = 0
    cache_misses = 0

    # Collect new summaries that need to be written back to the cache
    cache_writes: list[tuple[str, float, int, str]] = []

    for rel, info in data.ranked:
        if used >= budget_tokens:
            break

        rendered, is_hit = _get_rendered_summary(rel, info, data, cache_writes)
        if is_hit:
            cache_hits += 1
        else:
            cache_misses += 1

        rendered_tokens = estimate_tokens(rendered)
        if used + rendered_tokens > budget_tokens:
            break
        out.append(rendered)
        used += rendered_tokens
        included += 1

    if include_unranked_tail and included < len(data.ranked):
        omitted = len(data.ranked) - included
        out.append(
            f"\n... and {omitted} more files "
            f"(truncated to fit budget of ~{budget_tokens} tokens)\n"
        )

    # Persist new cache entries (best-effort; failure must not affect output)
    if cache_writes:
        try:
            with db.open_project(project.hash) as conn:
                _write_summary_cache(conn, cache_writes)
            _LOG.debug("repomap_cache: wrote %d new entries", len(cache_writes))
        except Exception:  # noqa: BLE001
            _LOG.debug("repomap_cache write failed (non-fatal)", exc_info=True)

    elapsed = time.monotonic() - t0
    _LOG.debug(
        "repomap: built map for %s: %d/%d files included (budget ~%d tokens), "
        "cache hits=%d misses=%d, dur=%.3fs",
        project.root.name,
        included,
        len(data.files),
        budget_tokens,
        cache_hits,
        cache_misses,
        elapsed,
    )
    return "".join(out)


def build_map_json(project: Project) -> list[FileMapItem]:
    """Return the full ranked file list as structured dicts rather than formatted text.

    Intended for programmatic consumers (the ``token-goat map --json`` CLI flag,
    MCP tool calls) that need to inspect individual fields rather than display a
    pre-rendered string.  The list is ordered by descending PageRank score, same
    as ``build_map``, but there is no token-budget truncation — all map-worthy
    files are returned regardless of count.

    Always recomputes ``FileSummary`` objects for structured output — the text
    cache stores rendered strings, not the intermediate ``FileSummary`` data
    (symbols list, sections list, etc.) needed here.
    """
    t0 = time.monotonic()
    data = _load_and_rank(project)
    if data is None:
        return []
    out = []
    for rel, info in data.ranked:
        summary = _summarize_file(
            rel,
            info,
            data.symbols_by_file.get(rel, []),
            data.sections_by_file.get(rel, []),
            data.ranks.get(rel, 0.0),
        )
        out.append(
            FileMapItem(
                path=summary.rel_path,
                language=summary.language,
                rank=summary.rank,
                symbols=[{"kind": k, "name": n} for k, n in summary.top_symbols],
                sections=summary.top_sections,
                approx_lines=summary.line_count,
            )
        )
    elapsed = time.monotonic() - t0
    _LOG.debug("build_map_json: project=%s files=%d dur=%.3fs", project.root.name, len(out), elapsed)
    return out
