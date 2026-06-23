"""Project-wide architecture analysis using the import graph."""
from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass

_log = logging.getLogger(__name__)


@dataclass
class ArchResult:
    module_count: int
    edge_count: int
    hubs: list[tuple[str, int]]  # (file_rel, in_degree), sorted desc
    entry_points: list[str]
    cycles: list[list[str]]
    leaf_count: int  # modules that import nothing from the project
    avg_imports: float
    max_depth: int  # longest path in the DAG approximation


def _stem_map(indexed: set[str]) -> dict[str, list[str]]:
    """Map filename stem → [file_rel, ...] for all indexed files."""
    mapping: dict[str, list[str]] = {}
    for f in indexed:
        stem = f.rsplit("/", 1)[-1].removesuffix(".py")
        # __init__ is a package root, not a useful resolution target
        if stem and stem != "__init__":
            mapping.setdefault(stem, []).append(f)
    return mapping


def build_arch(project_hash: str, *, top_hubs: int = 10, max_cycles: int = 10) -> ArchResult:
    """Build an architecture summary from the project's import graph."""
    import networkx as nx

    from . import db

    try:
        with db.open_project_readonly(project_hash) as conn:
            indexed: set[str] = {
                row[0]
                for row in conn.execute("SELECT rel_path FROM files").fetchall()
            }
            try:
                import_rows = conn.execute(
                    "SELECT file_rel, target FROM imports_exports WHERE kind = 'import'"
                ).fetchall()
            except sqlite3.OperationalError:
                # imports_exports may not exist in DBs created before this table was added
                import_rows = []
    except FileNotFoundError:
        indexed = set()
        import_rows = []

    stem_to_files = _stem_map(indexed)

    G: nx.DiGraph = nx.DiGraph()
    G.add_nodes_from(indexed)

    for row in import_rows:
        importer: str = row[0]
        target: str = row[1]
        if importer not in indexed:
            continue
        stripped = target.lstrip(".")
        if not stripped:
            continue
        # Relative: first component after dots names the file; absolute: any component may match
        stems = [stripped.split(".")[0]] if target.startswith(".") else stripped.split(".")
        for stem in stems:
            for importee in stem_to_files.get(stem, []):
                if importee != importer:
                    G.add_edge(importer, importee)

    non_isolated = [n for n in G.nodes() if G.degree(n) > 0]
    subG: nx.DiGraph = G.subgraph(non_isolated).copy()

    in_degrees = dict(subG.in_degree())
    hubs = sorted(
        ((f, d) for f, d in in_degrees.items() if d > 0),
        key=lambda x: x[1],
        reverse=True,
    )[:top_hubs]

    entry_points = sorted(
        f for f in subG.nodes()
        if subG.in_degree(f) == 0 and subG.out_degree(f) > 0
    )

    cycles: list[list[str]] = []
    try:
        for cycle in nx.simple_cycles(subG):
            if len(cycles) >= max_cycles:
                break
            cycles.append(list(cycle))
    except Exception as e:
        # networkx cycle detection may fail on edge cases; degrade gracefully with empty cycles list.
        _log.debug("build_arch: cycle detection failed: %s", e)

    leaf_count = sum(1 for n in subG.nodes() if subG.out_degree(n) == 0)
    edge_count = subG.number_of_edges()
    avg_imports = round(edge_count / max(1, len(non_isolated)), 1)

    max_depth = 0
    try:
        dag = subG.copy()
        while True:
            try:
                cycle_edges = nx.find_cycle(dag)
                dag.remove_edge(*cycle_edges[0])
            except nx.NetworkXNoCycle:
                break
        if dag.nodes():
            max_depth = nx.dag_longest_path_length(dag)
    except Exception as e:
        # DAG depth calculation may fail on edge cases; default to 0 and log the failure.
        _log.debug("build_arch: DAG depth calculation failed: %s", e)

    return ArchResult(
        module_count=len(non_isolated),
        edge_count=edge_count,
        hubs=hubs,
        entry_points=entry_points,
        cycles=cycles,
        leaf_count=leaf_count,
        avg_imports=avg_imports,
        max_depth=max_depth,
    )


def format_arch_text(result: ArchResult, project_name: str) -> str:
    lines: list[str] = [
        f"# Architecture — {project_name} ({result.module_count} modules, {result.edge_count} import edges)",
        "",
        "## Hubs (most imported)",
    ]
    if result.hubs:
        max_len = max(len(f) for f, _ in result.hubs)
        for file_rel, count in result.hubs:
            label = "importer" if count == 1 else "importers"
            lines.append(f"  {file_rel:<{max_len}}  {count} {label}")
    else:
        lines.append("  (none)")
    lines.append("")

    lines.append("## Entry Points (not imported by others)")
    if result.entry_points:
        for f in result.entry_points:
            lines.append(f"  {f}")
    else:
        lines.append("  (none)")
    lines.append("")

    lines.append("## Circular Dependencies")
    if result.cycles:
        for cycle in result.cycles:
            lines.append("  " + " → ".join(cycle + [cycle[0]]))
    else:
        lines.append("  (none)")
    lines.append("")

    lines.append("## Statistics")
    lines.append(f"  Leaf modules (no imports):  {result.leaf_count}")
    lines.append(f"  Avg imports per file:       {result.avg_imports}")
    lines.append(f"  Max import depth:           {result.max_depth}")

    return "\n".join(lines)


def format_arch_json(result: ArchResult, project_name: str) -> str:
    import json
    return json.dumps(
        {
            "project": project_name,
            "module_count": result.module_count,
            "edge_count": result.edge_count,
            "hubs": [{"file": f, "importers": c} for f, c in result.hubs],
            "entry_points": result.entry_points,
            "cycles": result.cycles,
            "stats": {
                "leaf_modules": result.leaf_count,
                "avg_imports_per_file": result.avg_imports,
                "max_import_depth": result.max_depth,
            },
        },
        indent=2,
    )
