"""PageRank-based repo map: token-budgeted overview of a project."""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from dataclasses import dataclass

import networkx as nx

from . import db
from .project import Project

_LOG = logging.getLogger("tokenwise.repomap")

# rough token estimator: ~3.5 chars per token for English/code mix
def estimate_tokens(text: str) -> int:
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
        "SELECT file_rel, heading, level FROM sections ORDER BY level, line"
    ):
        sections_by_file[row["file_rel"]].append((row["level"], row["heading"]))

    return files, symbols_by_file, sections_by_file, name_to_files


def _build_graph(
    conn: sqlite3.Connection, files: dict, name_to_files: dict
) -> nx.MultiDiGraph:
    """Edges: file -> file based on call refs that resolve to a defined symbol elsewhere."""
    g = nx.MultiDiGraph()
    for f in files:
        g.add_node(f)
    for row in conn.execute("SELECT symbol_name, file_rel FROM refs"):
        ref_name = row["symbol_name"]
        src = row["file_rel"]
        targets = name_to_files.get(ref_name, set())
        for tgt in targets:
            if tgt != src:
                g.add_edge(src, tgt)
    return g


def compute_ranks(g: nx.MultiDiGraph, *, alpha: float = 0.85) -> dict[str, float]:
    """Run PageRank on the multigraph (collapsed to simple graph for nx).

    Uses the pure-Python power-iteration implementation to avoid a hard
    dependency on scipy, which is not in the project's dependency list.
    """
    if g.number_of_nodes() == 0:
        return {}
    simple = nx.DiGraph()
    for node in g.nodes:
        simple.add_node(node)
    for u, v in g.edges():
        if simple.has_edge(u, v):
            simple[u][v]["weight"] += 1.0
        else:
            simple.add_edge(u, v, weight=1.0)
    # Use the pure-Python implementation — avoids requiring scipy.
    from networkx.algorithms.link_analysis.pagerank_alg import (  # noqa: PLC0415
        _pagerank_python,
    )
    try:
        return _pagerank_python(simple, alpha=alpha, weight="weight", max_iter=200, tol=1e-6)
    except nx.PowerIterationFailedConvergence:
        return _pagerank_python(simple, alpha=alpha, weight="weight", max_iter=500, tol=1e-4)


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
    seen: set[tuple[str, str]] = set()
    top_symbols: list[tuple[str, str]] = []
    for kind, name in sorted_syms:
        if (kind, name) in seen:
            continue
        seen.add((kind, name))
        top_symbols.append((kind, name))
        if len(top_symbols) >= max_symbols:
            break

    top_sections = [h for (lvl, h) in sections if lvl <= 2][:max_sections]
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


def build_map(
    project: Project,
    *,
    budget_tokens: int = 4000,
    include_unranked_tail: bool = True,
) -> str:
    """Build the repo map text under the token budget."""
    with db.open_project(project.hash) as conn:
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        if not files:
            return (
                f"# {project.root.name}\n\n"
                "(no files indexed — run `tokenwise index --full`)\n"
            )
        graph = _build_graph(conn, files, name_to_files)

    ranks = compute_ranks(graph)
    # Fallback: if every node has the same rank (no edges), break ties by file size
    if not ranks or len(set(ranks.values())) <= 1:
        ranks = {f: float(info["size"]) for f, info in files.items()}

    ranked = sorted(files.items(), key=lambda kv: ranks.get(kv[0], 0.0), reverse=True)

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


def build_map_json(project: Project) -> list[dict]:
    """Same data as build_map but as structured list of dicts (for tools)."""
    with db.open_project(project.hash) as conn:
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        graph = _build_graph(conn, files, name_to_files)

    ranks = compute_ranks(graph)
    if not ranks or len(set(ranks.values())) <= 1:
        ranks = {f: float(info["size"]) for f, info in files.items()}

    ranked = sorted(files.items(), key=lambda kv: ranks.get(kv[0], 0.0), reverse=True)
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
            {
                "path": summary.rel_path,
                "language": summary.language,
                "rank": summary.rank,
                "symbols": [{"kind": k, "name": n} for k, n in summary.top_symbols],
                "sections": summary.top_sections,
                "approx_lines": summary.line_count,
            }
        )
    return out
