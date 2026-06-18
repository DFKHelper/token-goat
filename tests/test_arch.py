"""Tests for the `token-goat arch` command and arch.build_arch helper."""
from __future__ import annotations

import hashlib
import json

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_hash(tmp_path) -> str:
    return hashlib.sha1(str(tmp_path).encode()).hexdigest()


def _setup_project(tmp_data_dir, project_hash: str, files: list[str], edges: list[tuple[str, str]]) -> None:
    """Populate files and import edges in a test project DB."""
    from token_goat import db

    with db.open_project(project_hash) as conn:
        for rel_path in files:
            conn.execute(
                "INSERT OR REPLACE INTO files"
                " (rel_path, language, size, line_count, mtime, content_sha256, indexed_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (rel_path, "python", 100, 10, 0.0, "deadbeef", 0),
            )
        for importer, target in edges:
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?,?,?,?)",
                (importer, "import", target, 1),
            )


# ---------------------------------------------------------------------------
# build_arch unit tests
# ---------------------------------------------------------------------------


def test_build_arch_empty_project(tmp_path, tmp_data_dir):
    """A project with no files returns a zeroed-out result without error."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    _setup_project(tmp_data_dir, ph, files=[], edges=[])

    result = build_arch(ph)

    assert result.module_count == 0
    assert result.edge_count == 0
    assert result.hubs == []
    assert result.entry_points == []
    assert result.cycles == []
    assert result.leaf_count == 0


def test_build_arch_no_db(tmp_path, tmp_data_dir):
    """A missing project DB (never indexed) returns a zeroed-out result gracefully."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    # Do NOT call _setup_project — DB must not exist
    result = build_arch(ph)

    assert result.module_count == 0
    assert result.edge_count == 0
    assert result.hubs == []
    assert result.entry_points == []


def test_build_arch_finds_hubs(tmp_path, tmp_data_dir):
    """Files imported by multiple others appear in hubs sorted by in-degree."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    _setup_project(
        tmp_data_dir,
        ph,
        files=["src/a.py", "src/b.py", "src/c.py"],
        edges=[
            ("src/a.py", ".c"),  # a imports c
            ("src/b.py", ".c"),  # b imports c  → c has in_degree 2
        ],
    )

    result = build_arch(ph)

    assert result.module_count == 3
    assert result.edge_count == 2
    assert result.hubs[0] == ("src/c.py", 2)


def test_build_arch_entry_points(tmp_path, tmp_data_dir):
    """A file that imports others but is itself never imported is an entry point."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    _setup_project(
        tmp_data_dir,
        ph,
        files=["src/cli.py", "src/db.py"],
        edges=[("src/cli.py", ".db")],
    )

    result = build_arch(ph)

    assert "src/cli.py" in result.entry_points
    assert "src/db.py" not in result.entry_points


def test_build_arch_finds_cycles(tmp_path, tmp_data_dir):
    """A mutual import pair produces a cycle in the result."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    _setup_project(
        tmp_data_dir,
        ph,
        files=["src/a.py", "src/b.py"],
        edges=[
            ("src/a.py", ".b"),
            ("src/b.py", ".a"),
        ],
    )

    result = build_arch(ph)

    assert len(result.cycles) > 0
    # Each cycle is a list of file_rels
    all_cycle_files = {f for cycle in result.cycles for f in cycle}
    assert "src/a.py" in all_cycle_files
    assert "src/b.py" in all_cycle_files


def test_build_arch_leaf_count(tmp_path, tmp_data_dir):
    """A file with importers but no outgoing imports counts as a leaf."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    # db.py is imported by cli.py but imports nothing itself
    _setup_project(
        tmp_data_dir,
        ph,
        files=["src/cli.py", "src/db.py"],
        edges=[("src/cli.py", ".db")],
    )

    result = build_arch(ph)

    # db.py: in_degree=1, out_degree=0 → leaf
    assert result.leaf_count == 1


def test_build_arch_top_hubs_limit(tmp_path, tmp_data_dir):
    """top_hubs caps the number of hubs returned."""
    from token_goat.arch import build_arch

    ph = _project_hash(tmp_path)
    files = [f"src/f{i}.py" for i in range(6)]
    # f0 is imported by f1..f5 (in_degree 5); f1 by f2..f5 (in_degree 4), etc.
    edges = [(f"src/f{i}.py", f".f{j}") for i in range(1, 6) for j in range(i)]
    _setup_project(tmp_data_dir, ph, files=files, edges=edges)

    result = build_arch(ph, top_hubs=2)

    assert len(result.hubs) <= 2


# ---------------------------------------------------------------------------
# format_arch_text
# ---------------------------------------------------------------------------


def test_format_arch_text_structure(tmp_path, tmp_data_dir):
    """Text output contains all expected section headers."""
    from token_goat.arch import ArchResult, format_arch_text

    result = ArchResult(
        module_count=3,
        edge_count=2,
        hubs=[("src/db.py", 2)],
        entry_points=["src/cli.py"],
        cycles=[],
        leaf_count=1,
        avg_imports=0.7,
        max_depth=1,
    )
    text = format_arch_text(result, "myproject")

    assert "# Architecture" in text
    assert "myproject" in text
    assert "## Hubs" in text
    assert "src/db.py" in text
    assert "## Entry Points" in text
    assert "src/cli.py" in text
    assert "## Circular Dependencies" in text
    assert "(none)" in text
    assert "## Statistics" in text


def test_format_arch_text_cycles_shown(tmp_path, tmp_data_dir):
    """Cycles are formatted as arrow-separated paths looping back to start."""
    from token_goat.arch import ArchResult, format_arch_text

    result = ArchResult(
        module_count=2,
        edge_count=2,
        hubs=[],
        entry_points=[],
        cycles=[["src/a.py", "src/b.py"]],
        leaf_count=0,
        avg_imports=1.0,
        max_depth=1,
    )
    text = format_arch_text(result, "proj")

    assert "src/a.py → src/b.py → src/a.py" in text


# ---------------------------------------------------------------------------
# format_arch_json
# ---------------------------------------------------------------------------


def test_format_arch_json_keys(tmp_path, tmp_data_dir):
    """JSON output contains all required top-level keys."""
    from token_goat.arch import ArchResult, format_arch_json

    result = ArchResult(
        module_count=2,
        edge_count=1,
        hubs=[("src/db.py", 1)],
        entry_points=["src/cli.py"],
        cycles=[],
        leaf_count=1,
        avg_imports=0.5,
        max_depth=1,
    )
    data = json.loads(format_arch_json(result, "proj"))

    assert data["project"] == "proj"
    assert data["module_count"] == 2
    assert data["edge_count"] == 1
    assert isinstance(data["hubs"], list)
    assert data["hubs"][0] == {"file": "src/db.py", "importers": 1}
    assert data["entry_points"] == ["src/cli.py"]
    assert data["cycles"] == []
    assert "stats" in data
    stats = data["stats"]
    assert stats["leaf_modules"] == 1
    assert stats["avg_imports_per_file"] == 0.5
    assert stats["max_import_depth"] == 1
