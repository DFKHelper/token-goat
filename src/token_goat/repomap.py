"""PageRank-based repo map: token-budgeted overview of a project.

PageRank is used as the ranking strategy because it captures *architectural
centrality*: a file that is imported or referenced by many other files receives
a high score, just as a web page linked by many pages does.  Pure reference
counts would also work, but PageRank dampens the influence of files that are
only referenced by other peripheral files, so core modules (db.py, paths.py)
rank above leaf utilities even when those utilities have the same raw import
count.  The damping factor (0.85, networkx default) is the standard Wikipedia-
era value and needs no tuning for typical codebases.
"""
from __future__ import annotations

__all__ = [
    "KIND_PRIORITY",
    "FileSummary",
    "FileMapItem",
    "build_map",
    "build_map_json",
    "build_map_mermaid",
    "build_map_since",
    "changed_files_since",
    "compute_ranks",
    "estimate_tokens",
    "lang_breakdown",
    "render_summary",
]

import contextlib
import heapq
import sqlite3
import time
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Final, Protocol, TypedDict

from . import db
from .util import get_logger

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
    using_size_fallback: bool = False  # True when PageRank was uniform; ranks are byte sizes


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

_LOG = get_logger("repomap")

# Files below this approximate line count are structural noise (empty __init__.py stubs, etc.)
_MIN_DISPLAY_LINES: Final[int] = 4
# Maximum symbol names shown per kind group in render_summary output.
# Keeping this small prevents any one kind from dominating the text budget.
_MAX_NAMES_PER_KIND: Final[int] = 6
# POSIX path prefixes excluded from the map — these dirs are test files,
# generated/transient artifacts that distort PageRank and pollute "Top modules"
# with non-source content.  Test files accumulate refs to every production
# module they cover; uv build/cache dirs leak vendored packaging code when the
# cache is co-located with the source tree (a common Windows + uv layout).
#
# ``tests/`` is excluded by default because test files import production
# modules extensively, which inflates the PageRank of those modules via
# edges sourced from test code rather than actual production dependencies.
# The map is more useful when it reflects production structure only.
# Control this via config ``[repomap] exclude_tests = false`` or the
# ``TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS=0`` env var.
_EXCLUDED_PREFIXES_BASE: Final[tuple[str, ...]] = (
    ".uv-cache/",
    ".uv-cache-local/",
    "dist/",
    "build/",
    "node_modules/",
    ".next/",
    ".nuxt/",
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    "target/",         # Rust/Java build output
    "out/",            # general build output
    ".output/",        # Nuxt/Vite output
    "vendor/",         # Go vendor dirs
    ".venv/",
    "venv/",
    "env/",
    ".tox/",
    "htmlcov/",        # coverage HTML reports
    "site/",           # MkDocs / Sphinx generated site
)

_EXCLUDED_PREFIXES_TESTS: Final[tuple[str, ...]] = (
    "tests/fixtures/",
    "tests/",
    "__tests__/",
    "test/",
    "spec/",
    "e2e/",
)

# POSIX path substrings excluded from the map — used for transient directories
# whose name varies per run (uv-cache tmp dirs are named ``.tmp<random>``).
# Substring check is intentional so ``.uv-cache/.tmp2VqIvs/...`` is dropped
# without having to list every random suffix.  Kept separate from
# ``_EXCLUDED_PREFIXES`` because substring checks are O(n) per call; keeping
# the list tiny preserves the lru_cache benefit on the hot path.
_EXCLUDED_SUBSTRINGS: Final[tuple[str, ...]] = (
    "/.tmp",   # uv tmp build/cache dirs (``.uv-cache/.tmp<hash>/``)
    "/__pycache__/",  # nested pycache dirs (e.g. src/pkg/__pycache__/)
)

# Generated artifact filenames (exact match on basename, lowercase) that
# survive the parser's SKIP_FILE_BASENAMES check (because they are not
# language lockfiles) but still pollute the map.  ``coverage.json`` lands at
# the repo root with a high PageRank-adjacent rank simply because it has the
# indexable ``.json`` extension, but the LLM never benefits from seeing it
# listed alongside source modules.
_EXCLUDED_BASENAMES: Final[frozenset[str]] = frozenset({
    "coverage.json",
    "coverage.xml",
    ".coverage",
    "lcov.info",
})

# Generated file suffixes (lowercase) — minified / compiled assets that are
# never worth reading in a repo map.  Checked against the full basename so
# ``app.bundle.js.map`` matches ``.js.map``.
_EXCLUDED_SUFFIXES: Final[tuple[str, ...]] = (
    ".min.js",
    ".min.css",
    ".bundle.js",
    ".js.map",
    ".css.map",
    ".pyc",
    ".pyo",
    ".pyd",
)
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


def _get_excluded_prefixes() -> tuple[str, ...]:
    """Return the active prefix exclusion tuple, including or excluding tests per config.

    Reads ``[repomap] exclude_tests`` from config (default ``True``).  The result
    is effectively process-constant because config is loaded once and the tuple is
    cached inside the caller's ``lru_cache`` via the ``_is_excluded_path`` key.
    The ``TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS=0`` env var overrides the config.
    """
    import os  # noqa: PLC0415
    env_val = os.environ.get("TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS", "").strip().lower()
    if env_val in ("0", "false", "no", "off"):
        exclude_tests = False
    elif env_val in ("1", "true", "yes", "on"):
        exclude_tests = True
    else:
        try:
            from . import config as _cfg  # noqa: PLC0415
            exclude_tests = _cfg.load().repomap.exclude_tests
        except (OSError, ValueError, AttributeError):
            exclude_tests = True
        except Exception:  # noqa: BLE001
            exclude_tests = True

    if exclude_tests:
        return _EXCLUDED_PREFIXES_BASE + _EXCLUDED_PREFIXES_TESTS
    return _EXCLUDED_PREFIXES_BASE


@lru_cache(maxsize=4096)
def _is_excluded_path_cached(rel_path: str, prefixes: tuple[str, ...]) -> bool:
    """Cached inner implementation — see :func:`_is_excluded_path` for the public API.

    Four filters apply, in cheap-to-expensive order:
      1. ``_EXCLUDED_BASENAMES`` — exact basename match (generated coverage
         artifacts that survive ``SKIP_FILE_BASENAMES``).
      2. ``_EXCLUDED_SUFFIXES`` — generated file suffix match (minified assets,
         compiled bytecode, source maps).
      3. ``prefixes`` — POSIX path prefix match (test dirs, build outputs, caches).
      4. ``_EXCLUDED_SUBSTRINGS`` — substring match (uv tmp dirs whose suffix
         is random per build).

    ``prefixes`` is a parameter (not a global) so the cache key captures the
    active exclude_tests setting — a config change in the same process issues
    a new cache key and avoids stale results.
    """
    posix = rel_path.replace("\\", "/") if "\\" in rel_path else rel_path
    # 1. basename (cheapest — single rsplit + frozenset lookup)
    basename = posix.rsplit("/", 1)[-1].lower()
    if basename in _EXCLUDED_BASENAMES:
        return True
    # 2. suffix (minified assets, bytecode — endswith on basename only)
    if any(basename.endswith(s) for s in _EXCLUDED_SUFFIXES):
        return True
    # 3. prefix
    if any(posix.startswith(p) for p in prefixes):
        return True
    # 4. substring (variable-suffix tmp dirs, nested pycache)
    return any(s in posix for s in _EXCLUDED_SUBSTRINGS)


def _is_excluded_path(rel_path: str) -> bool:
    """Return True if rel_path should be excluded from the repo map.

    Convenience wrapper around :func:`_is_excluded_path_cached` that resolves
    the active prefix tuple (including or excluding test dirs based on config).
    Tests and direct callers use this function; :func:`_is_map_worthy` also
    calls it internally.
    """
    return _is_excluded_path_cached(rel_path, _get_excluded_prefixes())


def _is_map_worthy(rel_path: str, approx_lines: int) -> bool:
    """Return True if this file should appear in the repo map.

    Excludes test dirs, generated build artifacts, and trivially small files
    (empty __init__.py stubs, etc.).  Test exclusion is controlled via config
    ``[repomap] exclude_tests`` (default True).
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
    # SQL indexer kinds — schema definitions are the most useful orientation targets
    "sql_table": 0,
    "sql_view": 1,
    "sql_function": 2,
    "sql_procedure": 2,
    "sql_type": 1,
    "sql_trigger": 3,
    "sql_index": 4,
    "sql_schema": 0,
    # GraphQL indexer kinds
    "graphql_type": 0,
    "graphql_interface": 0,
    "graphql_input": 1,
    "graphql_enum": 1,
    "graphql_union": 1,
    "graphql_scalar": 2,
    "graphql_extend": 3,
    # Protocol Buffers kinds
    "proto_message": 0,
    "proto_enum": 1,
    "proto_service": 0,
    # CSS/SCSS/Less kinds — selectors and variables are the most useful targets
    "css_selector": 2,
    "css_rule": 3,
    "css_var": 4,
    "css_keyframe": 3,
    "css_mixin": 2,
    # Makefile / Dockerfile kinds
    "makefile_target": 2,
    "makefile_define": 3,
    "dockerfile_stage": 2,
}

# Short tags emitted in the dense text format instead of full kind names.
# Each tag is 1-3 chars, saving ~5-8 chars per emitted line compared to the
# verbose form ("function: " → "fn:"). Falls back to the raw kind for any kind
# not listed here so adding a new language adapter does not silently drop info.
_KIND_TAG: Final[dict[str, str]] = {
    "class": "cls",
    "interface": "iface",
    "trait": "trait",
    "type": "ty",
    "enum": "enum",
    "function": "fn",
    "method": "m",
    "const": "k",
    "var": "v",
    "import": "imp",
    "heading": "h",
    "liquid_schema": "lqs",
    "abi_export": "abi",
    # SQL indexer kinds
    "sql_table": "tbl",
    "sql_view": "view",
    "sql_function": "fn",
    "sql_procedure": "proc",
    "sql_type": "ty",
    "sql_trigger": "trig",
    "sql_index": "idx",
    "sql_schema": "schema",
    # GraphQL indexer kinds
    "graphql_type": "ty",
    "graphql_interface": "iface",
    "graphql_input": "input",
    "graphql_enum": "enum",
    "graphql_union": "union",
    "graphql_scalar": "scalar",
    "graphql_extend": "ext",
    # Protocol Buffers kinds
    "proto_message": "msg",
    "proto_enum": "enum",
    "proto_service": "svc",
    # CSS/SCSS/Less kinds
    "css_selector": "sel",
    "css_rule": "rule",
    "css_var": "var",
    "css_keyframe": "kf",
    "css_mixin": "mix",
    # Makefile / Dockerfile kinds
    "makefile_target": "tgt",
    "makefile_define": "def",
    "dockerfile_stage": "stage",
}

# Budget below which build_map switches to "compact" mode automatically:
# header + one line per file (no symbol detail). Empirically the symbol-detail
# format averages ~25-40 tokens/file; below this threshold we can fit
# 5x more files by dropping symbol lines entirely, which is more useful for
# orientation than 1-2 fully-detailed entries.
#
# Tuning note (iter 17): raised from 200 → 300. With a 250-token budget — a
# common ask for inline orientation snippets — the old threshold dropped the
# caller into detailed mode, which fits only ~6-10 entries. Compact mode at
# the same budget fits ~30-50 entries (one short line per file at ~5-8
# tokens/file) which is far more useful for "where does X live" navigation.
# Calls with --budget=300+ still get detailed mode automatically, and
# `--compact` / no flag overrides still work unchanged.
_AUTO_COMPACT_BUDGET: Final[int] = 300


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

    _LOG.debug(
        "_build_graph: nodes=%d edges=%d refs_processed=%d",
        graph.number_of_nodes(),
        graph.number_of_edges(),
        len(ref_rows),
    )
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
    # multigraph.edges yields (src, dst, key) 3-tuples for MultiDiGraph; strip the
    # edge key so the Counter is keyed on (src, dst) pairs only.
    edge_weights: Counter[tuple[object, object]] = Counter(
        (src, dst) for src, dst, *_ in multigraph.edges
    )
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


def render_summary(summary: FileSummary, *, compact: bool = False) -> str:
    """Render a single file summary as text.

    Groups symbols by kind and emits kinds in priority order.  Uses a two-pass
    approach: first build a plain dict grouping names by kind (O(n)), then emit
    the unique kinds sorted by priority (O(k log k) where k = unique kinds, not
    n = total symbols).  This avoids re-sorting the entire symbol list on every
    call — only the small set of distinct kind strings is sorted.

    When ``compact`` is True the symbol/section detail lines are dropped and
    only the path/lang/lines/rank header line is emitted — useful when the
    caller has a tight token budget and wants orientation over depth.

    Density choices:
      - Single space between path and metadata bracket (was double).
      - ``r=`` instead of ``rank=`` and 3 decimals instead of 4
        (saves ~3 chars/line; rank is an ordering signal, not a precise score).
      - Single-char ``,`` separator inside the bracket instead of ``, ``.
      - Short kind tags (``fn``, ``cls``) from ``_KIND_TAG`` instead of full names.
      - Single space between symbol names instead of ``, `` (saves 1 char per
        symbol; comma is unambiguous because identifiers cannot contain ``,``).
    """
    head = (
        f"{summary.rel_path} [{summary.language},{summary.line_count},"
        f"r={summary.rank:.3f}]"
    )
    if compact:
        return head
    lines = [head]
    if summary.top_symbols:
        by_kind: dict[str, list[str]] = {}
        for kind, name in summary.top_symbols:
            by_kind.setdefault(kind, []).append(name)
        # Bind KIND_PRIORITY.get locally so the sort key avoids a global +
        # attribute lookup on every comparison (typically k=3-6 unique kinds).
        _kp_get = KIND_PRIORITY.get
        for kind in sorted(by_kind, key=lambda k: _kp_get(k, 99)):
            tag = _KIND_TAG.get(kind, kind)
            names = ",".join(by_kind[kind][:_MAX_NAMES_PER_KIND])
            lines.append(f" {tag}:{names}")
    if summary.top_sections:
        lines.append(f" sec:{'>'.join(summary.top_sections)}")
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
        using_size_fallback=all_ranks_equal,
    )


def _get_rendered_summary(
    rel: str,
    info: _FileInfo,
    data: _RankedProjectData,
    cache_writes: list[tuple[str, float, int, str]],
    *,
    compact: bool = False,
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

    Compact-mode renders are not cached: they are cheap to recompute
    (single-line, no symbol grouping) and the cache key would need an extra
    dimension to disambiguate compact vs. full strings.  Skipping the cache
    here keeps the schema simple and the compact path zero-allocation on hit.

    Returns ``(rendered_text, is_cache_hit)``.
    """
    mtime: float = info["mtime"]
    size: int = info["size"]
    if not compact:
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
    rendered = render_summary(summary, compact=compact) + "\n"
    if not compact:
        cache_writes.append((rel, mtime, size, rendered))
    return rendered, False


def _build_compact_file_summary(
    ranked: list[tuple[str, _FileInfo]],
    total: int,
    *,
    top_n: int = 3,
    include_ext_counts: bool = False,
) -> str:
    """Return the 1-line file-list preamble used when compact mode suppresses the full list.

    Format (default): ``"N files indexed. Top modules: a.py, b.py, c.py (+M more)\\n"``
    Format (ext counts): ``"N files: 15 .py, 8 .ts, 4 .sql (+2 more types). Top: a.py, b.py, c.py\\n"``

    *ranked* is the full PageRank-sorted list; we take the top ``top_n``
    basenames.  *total* is the total map-worthy file count (== len(ranked)).

    ``top_n`` defaults to 3 to preserve the original compact-output budget
    (~30 tokens) used by the auto-engaged 300-token compact mode.  Callers
    with larger budgets can pass higher values to expose more head-of-rank
    files for orientation without dropping into the full per-file detail
    rendering — adding 5 extra basenames costs roughly 10 additional tokens.

    ``include_ext_counts`` adds a file-type breakdown before the top modules
    list, e.g. ``"5 .py, 3 .ts, 2 .sql"``. This is more information-dense for
    heterogeneous polyglot projects where knowing the file-type mix matters as
    much as knowing the top module names.  At most 4 extension types are shown
    before collapsing the rest into ``"+N more types"``.
    """
    from pathlib import Path as _Path  # noqa: PLC0415

    if top_n < 1:
        top_n = 1
    top = [_Path(rel).name for rel, _ in ranked[:top_n]]
    rest = total - len(top)
    modules_str = ", ".join(top)
    if rest > 0:
        modules_str += f" (+{rest} more)"

    if not include_ext_counts:
        return f"{total} files indexed. Top modules: {modules_str}\n"

    # Build extension counts for the type-breakdown prefix.
    ext_counts: Counter[str] = Counter()
    for rel, _ in ranked:
        suffix = _Path(rel).suffix.lower()
        ext_counts[suffix if suffix else "(no ext)"] += 1
    _MAX_EXT_COLS = 4
    ext_ranked = ext_counts.most_common()
    if len(ext_ranked) <= _MAX_EXT_COLS:
        ext_parts = [f"{c} {e}" for e, c in ext_ranked]
        ext_str = ", ".join(ext_parts)
    else:
        top_ext = ext_ranked[:_MAX_EXT_COLS]
        rest_types = len(ext_ranked) - _MAX_EXT_COLS
        ext_parts = [f"{c} {e}" for e, c in top_ext]
        ext_str = ", ".join(ext_parts) + f" (+{rest_types} more types)"
    return f"{total} files: {ext_str}. Top: {modules_str}\n"


def build_map(
    project: Project,
    *,
    budget_tokens: int = 4000,
    include_unranked_tail: bool = True,
    compact: bool | None = None,
    full: bool = False,
    compact_file_threshold: int | None = None,
    top_n: int | None = None,
) -> str:
    """Build the repo map text under the token budget.

    Uses an incremental cache (``repomap_cache`` table in the project DB) to
    skip re-rendering file summaries whose ``(mtime, size)`` hasn't changed
    since the last run.  Only files that are new or modified incur the full
    ``_summarize_file`` + ``render_summary`` cost.  New rendered strings are
    written back to the cache at the end of the call.

    ``compact`` controls per-file detail:
      - ``None`` (default): auto-engage compact mode when
        ``budget_tokens < _AUTO_COMPACT_BUDGET``, so a tight budget produces
        a list of more files (one line each) rather than 1-2 fully-detailed
        entries.  Above the threshold the full symbol/section detail is shown.
      - ``True``: always one line per file.
      - ``False``: always show full symbol detail (caller takes responsibility
        for budget — useful when piping into a downstream summarizer).

    ``full``: when ``True``, overrides the compact-mode file-list truncation
    and always emits the full per-file list even when the project has more
    files than ``compact_file_threshold``.

    ``compact_file_threshold``: when compact mode is active AND the number of
    map-worthy files exceeds this value, the per-file list preamble is replaced
    with a 1-line summary (``"N files indexed. Top modules: …"``).  Callers
    may pass this explicitly; if ``None``, the value is read from the
    token-goat config (default 50).  Passing 0 disables the truncation.

    ``top_n``: when set to a positive integer, return only the top N files by
    PageRank score, ignoring the token budget. Overrides all other filtering.
    """
    t0 = time.monotonic()
    data = _load_and_rank(project)
    if data is None:
        return (
            f"# {project.root.name}\n\n"
            "(no files indexed — run `token-goat index --full`)\n"
        )

    # When --top N is set, return only the top N files in compact (score) format
    if top_n is not None and top_n > 0:
        if top_n > len(data.ranked):
            top_n = len(data.ranked)
        out = []
        for rel, _info in data.ranked[:top_n]:
            score = data.ranks.get(rel, 0.0)
            out.append(f"{rel} (rank: {score:.3f})\n")
        elapsed = time.monotonic() - t0
        _LOG.debug(
            "build_map: top_n=%d project=%s dur=%.3fs",
            top_n,
            project.root.name,
            elapsed,
        )
        return "".join(out)

    # Resolve compact mode: explicit caller wins, else auto-engage on tight budget.
    use_compact = compact if compact is not None else budget_tokens < _AUTO_COMPACT_BUDGET

    # Resolve the compact-file-list threshold.
    if compact_file_threshold is None:
        from . import config as _cfg  # noqa: PLC0415
        compact_file_threshold = _cfg.load().repomap.compact_file_threshold

    lang_set = sorted({info["language"] for info in data.files.values()})
    # Header: project name + (file count, langs). No "f" suffix — the count
    # position is unambiguous. Saves ~2 chars per call.
    header = (
        f"# {project.root.name} "
        f"({len(data.files)},{','.join(lang_set)})\n"
    )
    out = [header]
    used = estimate_tokens(header)
    included = 0
    cache_hits = 0
    cache_misses = 0

    # Collect new summaries that need to be written back to the cache
    cache_writes: list[tuple[str, float, int, str]] = []

    # When compact mode is active and the project has more files than the
    # threshold (and --full was not requested), replace the full per-file list
    # with a concise 1-line summary and go straight to the symbol clusters
    # (which are emitted by the caller via the standard per-file loop below).
    # The summary line itself counts against the token budget.
    use_summary_line = (
        use_compact
        and not full
        and compact_file_threshold > 0
        and len(data.ranked) > compact_file_threshold
    )

    if use_summary_line:
        # Scale top_n with the available token budget.  The default of 3 keeps
        # the auto-engaged 300-token compact mode within ~35 tokens (header +
        # one short summary line).  When the caller passes a larger budget
        # (e.g. ``--compact --budget 2000``) we have headroom to surface more
        # head-of-rank module names — each extra basename costs ~2 tokens.
        #
        # Mapping (chosen so the summary never consumes more than ~10% of the
        # budget):
        #   <  400 tokens → 3 modules   (legacy default)
        #   <  800 tokens → 5 modules
        #   <2000 tokens → 8 modules
        #   ≥2000 tokens → 12 modules
        if budget_tokens < 400:
            top_n = 3
        elif budget_tokens < 800:
            top_n = 5
        elif budget_tokens < 2000:
            top_n = 8
        else:
            top_n = 12
        # Use extension-count format for polyglot projects (multiple languages)
        # to give a more information-dense orientation snapshot.  Single-language
        # projects keep the module-names-only format since extension counts
        # add no orientation value when every file has the same suffix.
        include_ext_counts = len(lang_set) > 1
        summary_line = _build_compact_file_summary(
            data.ranked, len(data.ranked), top_n=top_n,
            include_ext_counts=include_ext_counts,
        )
        out.append(summary_line)
        used += estimate_tokens(summary_line)
    else:
        # In compact mode, count low-PageRank noise entries.  When 5 or more files
        # have a score below the minor-file threshold, collapse them into a single
        # "(+N minor files)" tail annotation rather than rendering each one.  This
        # saves 100-400 tokens on large repos where the long tail of rarely-referenced
        # files would otherwise consume a disproportionate share of the budget.
        _LOW_RANK_THRESHOLD: float = 0.05
        _MIN_MINOR_FILES: int = 5
        # Minor-file collapsing is only meaningful when ranks are true PageRank
        # scores (0.0–1.0).  When the fallback replaced them with raw file sizes
        # (bytes), every file has a "rank" well above 0.05, so the threshold is
        # meaningless — skip the feature to avoid the silent no-op.
        if use_compact and not data.using_size_fallback:
            minor_file_count = sum(
                1 for rel, _ in data.ranked
                if data.ranks.get(rel, 0.0) < _LOW_RANK_THRESHOLD
            )
        else:
            minor_file_count = 0

        for rel, info in data.ranked:
            if used >= budget_tokens:
                break

            # In compact mode, skip low-ranked tail files when there are enough
            # of them to warrant collapsing.  The tail annotation is appended
            # below after the main loop.
            if use_compact and minor_file_count >= _MIN_MINOR_FILES and data.ranks.get(rel, 0.0) < _LOW_RANK_THRESHOLD:
                continue

            rendered, is_hit = _get_rendered_summary(
                rel, info, data, cache_writes, compact=use_compact,
            )
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
            if use_compact and minor_file_count >= _MIN_MINOR_FILES and omitted > 0:
                # Distinguish collapsed minor files from budget-truncated files.
                # When ALL omitted entries are minor-file skips, use the informative
                # label; when some were budget-truncated, fall back to "+N more".
                budget_truncated = omitted - minor_file_count
                if budget_truncated <= 0:
                    out.append(f"(+{omitted} minor files)\n")
                else:
                    out.append(f"+{budget_truncated} more (+{minor_file_count} minor)\n")
            else:
                # Tail marker: just the count — the model needs to know N were omitted,
                # not what the budget was.
                out.append(f"+{omitted} more\n")

    # Language breakdown footer (one line, e.g. "Python: 60%  TypeScript: 40%").
    # Suppressed in two cases:
    #   1. use_summary_line is active: the header already lists the language set
    #      and the summary line shows ext counts.
    #   2. Single-language projects: the header already contains the only language
    #      (e.g. "(12,python)"), so "Python: 100%" adds zero information.
    # The footer is useful only when multiple languages are present and percentages
    # actually convey the mix — that is when len(lang_set) > 1.
    if not use_summary_line and len(lang_set) > 1:
        breakdown = lang_breakdown(data.files)
        if breakdown:
            out.append(f"{breakdown}\n")

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
        "cache hits=%d misses=%d summary_line=%s dur=%.3fs",
        project.root.name,
        included,
        len(data.files),
        budget_tokens,
        cache_hits,
        cache_misses,
        use_summary_line,
        elapsed,
    )
    return "".join(out)


def changed_files_since(project: Project, ref: str) -> frozenset[str]:
    """Return POSIX-relative paths of files changed since *ref*.

    Runs ``git diff --name-only <ref>`` in the project root and returns the
    set of changed file paths relative to the project root.  Fail-soft: any
    git error (invalid ref, no git repo) returns an empty frozenset so the
    caller can still render a normal map.
    """
    from .util import run_git  # noqa: PLC0415

    try:
        result = run_git(
            ["diff", "--name-only", ref],
            cwd=str(project.root),
            timeout=10,
        )
        if result.returncode != 0:
            _LOG.debug(
                "changed_files_since: git diff failed for ref=%r: %s",
                ref, result.stderr.strip(),
            )
            return frozenset()
        paths: set[str] = set()
        for line in result.stdout.splitlines():
            p = line.strip()
            if p:
                paths.add(p)
        return frozenset(paths)
    except Exception:  # noqa: BLE001
        _LOG.debug("changed_files_since: unexpected error for ref=%r", ref, exc_info=True)
        return frozenset()


def build_map_since(
    project: Project,
    ref: str,
    *,
    budget_tokens: int = 4000,
    compact: bool | None = None,
    full: bool = False,
) -> str:
    """Build a repo map filtered to files changed since *ref*.

    Runs ``git diff --name-only <ref>`` to find changed files, then renders a
    map that shows only those files (sorted by PageRank descending).  When no
    files match (clean working tree or invalid ref), a short informational
    message is returned.  Unknown refs produce the same message rather than an
    error, since fail-soft is preferred for hook/CLI contexts.

    The header includes the ref and the change count so the agent can see at a
    glance what was diffed.  Changed-only mode skips the minor-file collapsing
    logic (there is no long tail) and does not emit the language breakdown
    footer.
    """
    changed = changed_files_since(project, ref)
    if not changed:
        return (
            f"# {project.root.name} — changes since {ref}\n\n"
            f"(no changed files found, or `{ref}` is not a valid git ref)\n"
        )

    data = _load_and_rank(project)
    if data is None:
        return (
            f"# {project.root.name} — changes since {ref}\n\n"
            "(no files indexed — run `token-goat index --full`)\n"
        )

    use_compact = compact if compact is not None else budget_tokens < _AUTO_COMPACT_BUDGET

    header = (
        f"# {project.root.name} — {len(changed)} file(s) changed since `{ref}`\n"
    )
    out = [header]
    used = estimate_tokens(header)
    included = 0
    cache_writes: list[tuple[str, float, int, str]] = []

    for rel, info in data.ranked:
        if rel not in changed:
            continue
        if used >= budget_tokens:
            break

        rendered, _is_hit = _get_rendered_summary(
            rel, info, data, cache_writes, compact=use_compact,
        )
        # Prefix with a [changed] marker so it stands out visually.
        rendered = f"[changed] {rendered}"

        rendered_tokens = estimate_tokens(rendered)
        if used + rendered_tokens > budget_tokens:
            break
        out.append(rendered)
        used += rendered_tokens
        included += 1

    # Files that changed but are not in the index (new/deleted/untracked)
    indexed_rels = frozenset(rel for rel, _ in data.ranked)
    unindexed = sorted(changed - indexed_rels)
    if unindexed:
        unindexed_block = "Unindexed changed files:\n" + "".join(
            f"  {p}\n" for p in unindexed
        )
        out.append(unindexed_block)

    indexed_changed_count = len(changed & indexed_rels)
    if included < indexed_changed_count:
        omitted = indexed_changed_count - included
        out.append(f"+{omitted} more changed files (budget exhausted)\n")

    if cache_writes:
        with contextlib.suppress(Exception), db.open_project(project.hash) as conn:
            _write_summary_cache(conn, cache_writes)

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


def lang_breakdown(files: dict[str, _FileInfo]) -> str:
    """Return a one-line language breakdown string, e.g. ``Python: 60%  TypeScript: 40%``.

    Languages are sorted by file count descending, then alphabetically.  The
    smallest languages are merged into ``Other`` when there are more than four
    distinct languages so the line stays readable.  Returns an empty string when
    *files* is empty.
    """
    if not files:
        return ""
    counts: Counter[str] = Counter()
    for info in files.values():
        lang = info["language"] or "unknown"
        counts[lang.capitalize()] += 1
    total = sum(counts.values())
    ranked = counts.most_common()
    _MAX_LANG_COLS = 4
    buckets = ranked if len(ranked) <= _MAX_LANG_COLS else ranked[:_MAX_LANG_COLS]
    other_count = 0 if len(ranked) <= _MAX_LANG_COLS else total - sum(c for _, c in buckets)
    parts = [f"{lang}: {round(count * 100 / total)}%" for lang, count in buckets]
    if other_count:
        parts.append(f"Other: {round(other_count * 100 / total)}%")
    return "  ".join(parts)


def build_map_mermaid(
    project: Project,
    *,
    top_n: int = 20,
) -> str:
    """Return a Mermaid ``graph TD`` diagram of the top-*n* files by PageRank.

    Each node is labelled with the file's basename and approximate line count.
    Edges represent cross-file symbol references (from the dependency graph):
    an arrow from A to B means A imports / references a symbol defined in B.

    The diagram is capped at *top_n* files (default 20) to keep it readable
    inside a README or GitHub wiki page.  Only edges where both endpoints are
    in the selected set are included.
    """
    t0 = time.monotonic()
    data = _load_and_rank(project)
    if data is None:
        return "graph TD\n    empty[\"No files indexed — run `token-goat index --full`\"]\n"

    from pathlib import Path as _Path  # noqa: PLC0415

    top_files = {rel for rel, _ in data.ranked[:top_n]}

    lines: list[str] = ["graph TD"]

    # Node definitions — use the basename as the label to keep nodes compact.
    for rel, info in data.ranked[:top_n]:
        node_id = _mermaid_id(rel)
        basename = _Path(rel).name
        approx_lines = max(1, info["size"] // _BYTES_PER_APPROX_LINE)
        lang = info["language"] or "?"
        lines.append(f'    {node_id}["{basename}<br/>{lang}, ~{approx_lines}L"]')

    # Build a set of edges for the top-N files from the ranked data.
    # We rebuild a lightweight edge set without spinning up a full graph object.
    try:
        with db.open_project(project.hash) as conn:
            try:
                ref_rows = conn.execute("SELECT symbol_name, file_rel FROM refs").fetchall()
            except Exception:  # noqa: BLE001
                ref_rows = []
    except Exception:  # noqa: BLE001
        ref_rows = []

    # name_to_files maps symbol_name → set of files that define it
    name_to_files: dict[str, set[str]] = {}
    for rel, _ in data.ranked:
        for _kind, name in data.symbols_by_file.get(rel, []):
            name_to_files.setdefault(name, set()).add(rel)

    seen_edges: set[tuple[str, str]] = set()
    for row in ref_rows:
        src = row["file_rel"] if hasattr(row, "__getitem__") else row[1]
        sym = row["symbol_name"] if hasattr(row, "__getitem__") else row[0]
        if src not in top_files:
            continue
        for dst in name_to_files.get(sym, ()):
            if dst != src and dst in top_files:
                edge = (src, dst)
                if edge not in seen_edges:
                    seen_edges.add(edge)
                    lines.append(f"    {_mermaid_id(src)} --> {_mermaid_id(dst)}")

    breakdown = lang_breakdown(data.files)
    if breakdown:
        lines.append('    classDef note fill:#f9f,stroke:#333')
        lines.append(f'    langs["{breakdown}"]:::note')

    elapsed = time.monotonic() - t0
    _LOG.debug("build_map_mermaid: project=%s top_n=%d edges=%d dur=%.3fs",
               project.root.name, top_n, len(seen_edges), elapsed)
    return "\n".join(lines) + "\n"


def _mermaid_id(rel_path: str) -> str:
    """Convert a relative file path to a safe Mermaid node identifier.

    Replaces any character that is not alphanumeric or underscore with ``_``.
    Prepends ``f_`` to guard against identifiers starting with a digit.
    """
    safe = "".join(c if c.isalnum() or c == "_" else "_" for c in rel_path)
    return f"f_{safe}"
