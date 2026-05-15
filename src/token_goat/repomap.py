"""PageRank-based repo map: token-budgeted overview of a project."""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from typing import TypedDict

import networkx as nx

from . import db
from .project import Project


class FileMapItem(TypedDict):
    """Structured representation of a file in the repo map."""
    path: str
    language: str
    rank: float
    symbols: list[dict[str, str]]
    sections: list[str]
    approx_lines: int

_LOG = logging.getLogger("token_goat.repomap")

# Files below this approximate line count are structural noise (empty __init__.py stubs, etc.)
_MIN_DISPLAY_LINES = 4
# POSIX path prefixes excluded from the map — these dirs are test fixtures, not source
_EXCLUDED_PREFIXES = ("tests/fixtures/",)


def _is_map_worthy(rel_path: str, approx_lines: int) -> bool:
    """Return True if this file should appear in the repo map.

    Excludes test fixture stubs (which distort PageRank by accumulating refs
    from all parser tests) and trivially small files (empty __init__.py, etc.).
    """
    posix = rel_path.replace("\\", "/")
    if any(posix.startswith(p) for p in _EXCLUDED_PREFIXES):
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
) -> tuple[dict, dict, dict, dict]:
    """Load files, symbols-by-file, sections-by-file, name->defining_files."""
    files: dict[str, dict] = {}
    for row in conn.execute("SELECT rel_path, language, size FROM files"):
        files[row["rel_path"]] = {"language": row["language"], "size": row["size"]}

    symbols_by_file: dict[str, list[tuple[str, str]]] = defaultdict(list)
    name_to_files: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute("SELECT name, kind, file_rel FROM symbols"):
        symbols_by_file[row["file_rel"]].append((row["kind"], row["name"]))
        name_to_files[row["name"]].add(row["file_rel"])

    sections_by_file: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for row in conn.execute(
        "SELECT file_rel, heading, level FROM sections ORDER BY file_rel, level, line"
    ):
        sections_by_file[row["file_rel"]].append((row["level"], row["heading"]))

    return files, symbols_by_file, sections_by_file, name_to_files


def _build_graph(
    conn: sqlite3.Connection, files: dict, name_to_files: dict
) -> nx.MultiDiGraph:
    """Edges: file -> file based on call refs that resolve to a defined symbol elsewhere."""
    graph = nx.MultiDiGraph()

    # Add all files as nodes
    for file_path in files:
        graph.add_node(file_path)

    # Add edges from references to their definitions
    for row in conn.execute("SELECT symbol_name, file_rel FROM refs"):
        referenced_symbol = row["symbol_name"]
        referencing_file = row["file_rel"]
        if referencing_file not in files:
            continue
        definition_files = name_to_files.get(referenced_symbol, set())

        for definition_file in definition_files:
            if definition_file != referencing_file and definition_file in files:
                graph.add_edge(referencing_file, definition_file)

    return graph


def _multigraph_to_weighted_digraph(multigraph: nx.MultiDiGraph) -> nx.DiGraph:
    """Convert multigraph to simple DiGraph, aggregating parallel edges as weights."""
    simple_graph = nx.DiGraph()

    # Add all nodes
    for node in multigraph.nodes:
        simple_graph.add_node(node)

    # Aggregate parallel edges into weights
    for source, target in multigraph.edges():
        if simple_graph.has_edge(source, target):
            simple_graph[source][target]["weight"] += 1.0
        else:
            simple_graph.add_edge(source, target, weight=1.0)

    return simple_graph


def compute_ranks(g: nx.MultiDiGraph, *, alpha: float = 0.85) -> dict[str, float]:
    """Run PageRank on the multigraph (collapsed to simple graph for nx).

    Uses the pure-Python power-iteration implementation to avoid a hard
    dependency on scipy, which is not in the project's dependency list.
    """
    if g.number_of_nodes() == 0:
        return {}

    simple_graph = _multigraph_to_weighted_digraph(g)

    # Use the pure-Python implementation — avoids requiring scipy.
    from networkx.algorithms.link_analysis.pagerank_alg import (  # noqa: PLC0415
        _pagerank_python,
    )

    try:
        return _pagerank_python(simple_graph, alpha=alpha, weight="weight", max_iter=200, tol=1e-6)
    except nx.PowerIterationFailedConvergence:
        return _pagerank_python(simple_graph, alpha=alpha, weight="weight", max_iter=500, tol=1e-4)


def _summarize_file(
    rel: str,
    info: dict,
    symbols: list[tuple[str, str]],
    sections: list[tuple[int, str]],
    rank: float,
    *,
    max_symbols: int = 8,
    max_sections: int = 5,
) -> FileSummary:
    sorted_syms = sorted(
        symbols,
        key=lambda ks: (KIND_PRIORITY.get(ks[0], 99), ks[1]),
    )
    # Build top_symbols with single pass; duplicates are rare, so use linear check
    top_symbols: list[tuple[str, str]] = []
    for kind, name in sorted_syms:
        if (kind, name) not in top_symbols:  # Single check per item (faster for small lists)
            top_symbols.append((kind, name))
            if len(top_symbols) >= max_symbols:
                break

    # Filter sections to level <= 2 and limit to max_sections
    top_sections = [h for lvl, h in sections if lvl <= 2][:max_sections]
    approx_lines = max(1, info["size"] // 50)
    return FileSummary(
        rel_path=rel,
        language=info["language"],
        rank=rank,
        top_symbols=top_symbols,
        top_sections=top_sections,
        line_count=approx_lines,
    )


def render_summary(s: FileSummary) -> str:
    """Render a single file summary as text."""
    lines = [f"{s.rel_path}  [{s.language}, ~{s.line_count}L, rank={s.rank:.4f}]"]
    if s.top_symbols:
        by_kind: dict[str, list[str]] = defaultdict(list)
        for k, n in s.top_symbols:
            by_kind[k].append(n)
        for kind in sorted(by_kind, key=lambda k: KIND_PRIORITY.get(k, 99)):
            names = ", ".join(by_kind[kind][:6])
            lines.append(f"  {kind}: {names}")
    if s.top_sections:
        lines.append(f"  sections: {' > '.join(s.top_sections)}")
    return "\n".join(lines)


def _load_and_rank(
    project: Project,
) -> tuple[dict, dict, dict, list[tuple[str, dict]], dict[str, float]] | None:
    """Load project data, filter, compute PageRank, and return sorted ranking.

    Returns ``(files, symbols_by_file, sections_by_file, ranked, ranks)`` or
    ``None`` when there are no indexed files (callers handle the empty case).
    """
    with db.open_project(project.hash) as conn:
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        if not files:
            return None
        files = {
            rel: info
            for rel, info in files.items()
            if _is_map_worthy(rel, max(1, info["size"] // 50))
        }
        graph = _build_graph(conn, files, name_to_files)

    ranks = compute_ranks(graph)
    # Fallback: if every node has the same rank (no edges), break ties by file size
    if not ranks or len(set(ranks.values())) <= 1:
        ranks = {f: float(info["size"]) for f, info in files.items()}

    ranked = sorted(files.items(), key=lambda kv: ranks.get(kv[0], 0.0), reverse=True)
    return files, symbols_by_file, sections_by_file, ranked, ranks


def build_map(
    project: Project,
    *,
    budget_tokens: int = 4000,
    include_unranked_tail: bool = True,
) -> str:
    """Build the repo map text under the token budget."""
    result = _load_and_rank(project)
    if result is None:
        return (
            f"# {project.root.name}\n\n"
            "(no files indexed — run `token-goat index --full`)\n"
        )
    files, symbols_by_file, sections_by_file, ranked, ranks = result

    lang_set = sorted({info["language"] for info in files.values()})
    header = f"# {project.root.name}\n  files={len(files)} languages={','.join(lang_set)}\n\n"
    out = [header]
    used = estimate_tokens(header)
    included = 0

    for rel, info in ranked:
        if used >= budget_tokens:
            break
        summary = _summarize_file(
            rel,
            info,
            symbols_by_file.get(rel, []),
            sections_by_file.get(rel, []),
            ranks.get(rel, 0.0),
        )
        rendered = render_summary(summary) + "\n"
        if used + estimate_tokens(rendered) > budget_tokens:
            break
        out.append(rendered)
        used += estimate_tokens(rendered)
        included += 1

    if include_unranked_tail and included < len(ranked):
        omitted = len(ranked) - included
        out.append(
            f"\n... and {omitted} more files "
            f"(truncated to fit budget of ~{budget_tokens} tokens)\n"
        )

    return "".join(out)


def build_map_json(project: Project) -> list[FileMapItem]:
    """Same data as build_map but as structured list of dicts (for tools)."""
    result = _load_and_rank(project)
    if result is None:
        return []
    files, symbols_by_file, sections_by_file, ranked, ranks = result
    out = []
    for rel, info in ranked:
        summary = _summarize_file(
            rel,
            info,
            symbols_by_file.get(rel, []),
            sections_by_file.get(rel, []),
            ranks.get(rel, 0.0),
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
    return out
