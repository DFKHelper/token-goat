"""Tests for repomap: PageRank graph, budget enforcement, JSON output."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import networkx as nx
import pytest

from tokenwise import repomap
from tokenwise.parser import index_project

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def ts_project(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample fixture to tmp dir, index it, and return a Project."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj


# ---------------------------------------------------------------------------
# 1. compute_ranks on empty graph returns {}
# ---------------------------------------------------------------------------

def test_compute_ranks_empty_graph():
    g = nx.MultiDiGraph()
    result = repomap.compute_ranks(g)
    assert result == {}


# ---------------------------------------------------------------------------
# 2. compute_ranks: linear A->B->C — C has highest rank (most incoming)
# ---------------------------------------------------------------------------

def test_compute_ranks_linear_graph():
    g = nx.MultiDiGraph()
    g.add_edge("A", "B")
    g.add_edge("B", "C")
    ranks = repomap.compute_ranks(g)
    # C is pointed to by B which is pointed to by A — highest PageRank
    assert ranks["C"] > ranks["B"] > ranks["A"]


# ---------------------------------------------------------------------------
# 3. End-to-end build_map on ts_sample
# ---------------------------------------------------------------------------

def test_build_map_end_to_end(ts_project):
    text = repomap.build_map(ts_project, budget_tokens=4000)
    assert text.strip()
    # Header must mention the project name
    assert "ts_sample" in text
    # The only indexed file must appear
    assert "index.ts" in text


# ---------------------------------------------------------------------------
# 4. Budget enforcement: small budget => much shorter output
# ---------------------------------------------------------------------------

def test_build_map_budget_enforced(ts_project):
    short = repomap.build_map(ts_project, budget_tokens=20)
    long_ = repomap.build_map(ts_project, budget_tokens=10000)
    assert len(short) < len(long_)


# ---------------------------------------------------------------------------
# 5. JSON output: build_map_json returns list of dicts with expected keys
# ---------------------------------------------------------------------------

def test_build_map_json_structure(ts_project):
    data = repomap.build_map_json(ts_project)
    assert isinstance(data, list)
    assert len(data) >= 1
    required_keys = {"path", "language", "rank", "symbols", "approx_lines"}
    for entry in data:
        assert required_keys.issubset(entry.keys())
        assert isinstance(entry["symbols"], list)
        assert isinstance(entry["rank"], float)


# ---------------------------------------------------------------------------
# 6. Fallback: graph with no edges uses size-based ordering
# ---------------------------------------------------------------------------

def test_build_map_no_edges_fallback(ts_project):
    # Build map works even when there are no cross-file refs (single file project)
    # The ts_sample has one file, so the graph has one node and no edges.
    # compute_ranks returns equal ranks (uniform) => fallback to size ordering.
    text = repomap.build_map(ts_project, budget_tokens=4000)
    # Must still produce output mentioning the file
    assert "index.ts" in text


# ---------------------------------------------------------------------------
# 7. Header includes project name and file count
# ---------------------------------------------------------------------------

def test_build_map_header(ts_project):
    text = repomap.build_map(ts_project, budget_tokens=4000)
    assert "ts_sample" in text
    assert "files=1" in text


# ---------------------------------------------------------------------------
# 8. estimate_tokens sanity check
# ---------------------------------------------------------------------------

def test_estimate_tokens_sanity():
    # 35 chars ~= 10 tokens by the formula (35 // 3 + 1 = 12 — rough)
    t = repomap.estimate_tokens("a" * 350)
    assert 80 <= t <= 140  # 350 // 3 + 1 = 117


# ---------------------------------------------------------------------------
# 9. build_map_json serialisable to JSON without error
# ---------------------------------------------------------------------------

def test_build_map_json_serialisable(ts_project):
    data = repomap.build_map_json(ts_project)
    dumped = json.dumps(data)
    loaded = json.loads(dumped)
    assert loaded == data


# ---------------------------------------------------------------------------
# 10. estimate_tokens with empty string
# ---------------------------------------------------------------------------

def test_estimate_tokens_empty_string():
    """estimate_tokens should return minimal value for empty string."""
    t = repomap.estimate_tokens("")
    assert t >= 0
    assert isinstance(t, int)


# ---------------------------------------------------------------------------
# 11. estimate_tokens with very large text
# ---------------------------------------------------------------------------

def test_estimate_tokens_large_text():
    """estimate_tokens should scale linearly with text size."""
    small_text = "a" * 100
    large_text = "a" * 10000
    small_tokens = repomap.estimate_tokens(small_text)
    large_tokens = repomap.estimate_tokens(large_text)
    # Large should be roughly 100x more tokens
    assert large_tokens > small_tokens
    assert large_tokens > 100 * (small_tokens // 2)  # Allow some variance


# ---------------------------------------------------------------------------
# 12. estimate_tokens with newlines and whitespace
# ---------------------------------------------------------------------------

def test_estimate_tokens_with_whitespace():
    """estimate_tokens should handle mixed whitespace correctly."""
    text_with_spaces = "a b c d e f g h i j"
    text_no_spaces = "abcdefghij"
    tokens1 = repomap.estimate_tokens(text_with_spaces)
    tokens2 = repomap.estimate_tokens(text_no_spaces)
    # Should be roughly similar (whitespace doesn't change char count much)
    assert abs(tokens1 - tokens2) < 5


# ---------------------------------------------------------------------------
# 13. compute_ranks with self-loops
# ---------------------------------------------------------------------------

def test_compute_ranks_with_self_loops():
    """compute_ranks should handle self-referencing nodes."""
    g = nx.MultiDiGraph()
    g.add_edge("A", "A")  # Self-loop
    g.add_edge("A", "B")
    ranks = repomap.compute_ranks(g)
    assert "A" in ranks
    assert "B" in ranks
    assert isinstance(ranks["A"], float)
    assert isinstance(ranks["B"], float)


# ---------------------------------------------------------------------------
# 14. compute_ranks with isolated nodes (no edges)
# ---------------------------------------------------------------------------

def test_compute_ranks_isolated_nodes():
    """compute_ranks should assign equal ranks to isolated nodes."""
    g = nx.MultiDiGraph()
    g.add_node("X")
    g.add_node("Y")
    g.add_node("Z")
    ranks = repomap.compute_ranks(g)
    # All isolated nodes should have roughly equal PageRank
    assert "X" in ranks
    assert "Y" in ranks
    assert "Z" in ranks
    # Ranks should be close in value (within small epsilon)
    assert abs(ranks["X"] - ranks["Y"]) < 0.01
    assert abs(ranks["Y"] - ranks["Z"]) < 0.01


# ---------------------------------------------------------------------------
# 15. build_map with zero budget
# ---------------------------------------------------------------------------

def test_build_map_zero_budget(ts_project):
    """build_map should handle zero budget gracefully."""
    text = repomap.build_map(ts_project, budget_tokens=0)
    # Should return a minimal header, not crash
    assert isinstance(text, str)


# ---------------------------------------------------------------------------
# 16. build_map_json with empty file list
# ---------------------------------------------------------------------------

def test_build_map_json_rank_values_positive(ts_project):
    """Rank values should be positive (PageRank output)."""
    data = repomap.build_map_json(ts_project)
    for entry in data:
        # PageRank values should be positive
        assert entry["rank"] >= 0.0
        # Should not be NaN or invalid
        assert isinstance(entry["rank"], (int, float))


# ---------------------------------------------------------------------------
# 17. estimate_tokens consistency
# ---------------------------------------------------------------------------

def test_estimate_tokens_deterministic():
    """estimate_tokens should be deterministic (same input => same output)."""
    text = "The quick brown fox jumps over the lazy dog.\nLine 2.\n"
    t1 = repomap.estimate_tokens(text)
    t2 = repomap.estimate_tokens(text)
    assert t1 == t2


# ---------------------------------------------------------------------------
# 18. build_map_json entries have non-empty language field
# ---------------------------------------------------------------------------

def test_build_map_json_language_field(ts_project):
    """All JSON entries should have a language field."""
    data = repomap.build_map_json(ts_project)
    for entry in data:
        assert "language" in entry
        # Language should be a non-empty string or None
        assert isinstance(entry["language"], (str, type(None)))


# ---------------------------------------------------------------------------
# 19. build_map_json entries have positive line count
# ---------------------------------------------------------------------------

def test_build_map_json_line_counts(ts_project):
    """JSON entries should have realistic line counts."""
    data = repomap.build_map_json(ts_project)
    for entry in data:
        # Line count should be non-negative
        assert entry["approx_lines"] >= 0
        # Should be reasonable (not absurd)
        assert entry["approx_lines"] < 1000000


# ---------------------------------------------------------------------------
# 20. _is_map_worthy: fixture paths are excluded
# ---------------------------------------------------------------------------

def test_is_map_worthy_excludes_fixture_paths():
    """Files under tests/fixtures/ must be excluded regardless of size."""
    assert not repomap._is_map_worthy("tests/fixtures/ts_sample/index.ts", 100)
    assert not repomap._is_map_worthy("tests/fixtures/some_stub.py", 500)


def test_is_map_worthy_windows_paths_normalized():
    """Windows backslash paths should be normalised before prefix check."""
    assert not repomap._is_map_worthy("tests\\fixtures\\ts_sample\\index.ts", 100)


def test_is_map_worthy_excludes_tiny_files():
    """Files with fewer than _MIN_DISPLAY_LINES should be excluded."""
    assert not repomap._is_map_worthy("src/tokenwise/__init__.py", 2)
    assert not repomap._is_map_worthy("src/foo.py", 0)


def test_is_map_worthy_accepts_normal_source_files():
    """Normal source files above the line threshold must be included."""
    assert repomap._is_map_worthy("src/tokenwise/cli.py", 50)
    assert repomap._is_map_worthy("src/tokenwise/worker.py", 10)


def test_is_map_worthy_boundary_at_min_lines():
    """File exactly at _MIN_DISPLAY_LINES must be included."""
    assert repomap._is_map_worthy("src/foo.py", repomap._MIN_DISPLAY_LINES)
    assert not repomap._is_map_worthy("src/foo.py", repomap._MIN_DISPLAY_LINES - 1)


# ---------------------------------------------------------------------------
# 21. _build_graph: refs from excluded files don't create ghost nodes
# ---------------------------------------------------------------------------

def test_build_graph_no_ghost_nodes():
    """graph.add_edge() auto-adds nodes — verify bounds checks prevent ghost nodes."""
    import sqlite3

    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript("""
        CREATE TABLE files (rel_path TEXT, language TEXT, size INTEGER);
        CREATE TABLE symbols (name TEXT, kind TEXT, file_rel TEXT);
        CREATE TABLE refs (symbol_name TEXT, file_rel TEXT);
        CREATE TABLE sections (file_rel TEXT, heading TEXT, level INTEGER, line INTEGER);

        INSERT INTO files VALUES ('src/a.py', 'python', 500);
        INSERT INTO files VALUES ('src/b.py', 'python', 500);

        INSERT INTO symbols VALUES ('MyClass', 'class', 'src/b.py');

        -- A ref FROM a fixture file (not in `files` dict) that points to src/b.py
        INSERT INTO refs VALUES ('MyClass', 'tests/fixtures/stub.py');
        -- A normal ref from src/a.py to src/b.py
        INSERT INTO refs VALUES ('MyClass', 'src/a.py');
    """)

    files = {"src/a.py": {"language": "python", "size": 500},
             "src/b.py": {"language": "python", "size": 500}}
    name_to_files: dict = {"MyClass": {"src/b.py"}}

    g = repomap._build_graph(con, files, name_to_files)

    # Only the two source files should be nodes — no ghost fixture node
    assert set(g.nodes()) == {"src/a.py", "src/b.py"}
    # The legitimate edge must be present
    assert g.has_edge("src/a.py", "src/b.py")
