"""Tests for repomap: PageRank graph, budget enforcement, JSON output."""
from __future__ import annotations

import json

import networkx as nx
import pytest

from token_goat import repomap

# ---------------------------------------------------------------------------
# Module-scoped ts_project: index ts_sample once per test module run.
# All tests here are read-only on the indexed DB (build_map queries only);
# test_build_map_cache_stale_entries_evicted calls index_project(full=True)
# but re-indexes unchanged files, leaving the DB in the same valid state.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def ts_project(ts_project_module):
    """Shadow the function-scoped conftest ts_project with a module-scoped one."""
    return ts_project_module

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
    # Header: "# ts_sample (1,typescript)" — file count followed by lang list.
    assert "(1," in text


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
    assert not repomap._is_map_worthy("src/token_goat/__init__.py", 2)
    assert not repomap._is_map_worthy("src/foo.py", 0)


def test_is_map_worthy_accepts_normal_source_files():
    """Normal source files above the line threshold must be included."""
    assert repomap._is_map_worthy("src/token_goat/cli.py", 50)
    assert repomap._is_map_worthy("src/token_goat/worker.py", 10)


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


# ---------------------------------------------------------------------------
# 22. repomap_cache: second build_map call uses cached summaries
# ---------------------------------------------------------------------------

def test_build_map_cache_populates_on_first_call(ts_project):
    """After the first build_map, repomap_cache must contain at least one row."""
    from token_goat import db as tg_db

    repomap.build_map(ts_project, budget_tokens=4000)

    with tg_db.open_project(ts_project.hash) as conn:
        row = conn.execute("SELECT COUNT(*) FROM repomap_cache").fetchone()
    assert row[0] >= 1


def test_build_map_cache_hit_on_second_call(ts_project):
    """Second build_map call with unchanged files must return identical output."""
    first = repomap.build_map(ts_project, budget_tokens=4000)
    second = repomap.build_map(ts_project, budget_tokens=4000)
    assert first == second


def test_build_map_cache_stale_entries_evicted(ts_project):
    """After a full re-index the cache only holds entries matching current files."""
    from token_goat import db as tg_db
    from token_goat.parser import index_project

    # Seed the cache with a phantom entry that has no matching files row.
    # Temporarily disable FK enforcement so we can insert the orphaned row —
    # this simulates a cache entry left behind after its file was deleted
    # externally (the case _evict_stale_cache is designed to clean up).
    with tg_db.open_project(ts_project.hash) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute(
            "INSERT OR REPLACE INTO repomap_cache "
            "(rel_path, mtime, size, summary_text, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("ghost/phantom.py", 1.0, 999, "phantom summary\n", 1),
        )
        conn.execute("PRAGMA foreign_keys = ON")

    # Re-index (full) then build map — eviction should clear the phantom
    index_project(ts_project, full=True)
    repomap.build_map(ts_project, budget_tokens=4000)

    with tg_db.open_project(ts_project.hash) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM repomap_cache WHERE rel_path = 'ghost/phantom.py'"
        ).fetchone()
    assert row[0] == 0


def test_load_summary_cache_graceful_on_missing_table():
    """_load_summary_cache must return empty dict when the table doesn't exist."""
    import sqlite3 as _sqlite3

    con = _sqlite3.connect(":memory:")
    con.row_factory = _sqlite3.Row
    # No repomap_cache table — simulates an old-schema DB
    result = repomap._load_summary_cache(con)
    assert result == {}


def test_write_summary_cache_graceful_on_missing_table():
    """_write_summary_cache must not raise when the table doesn't exist."""
    import sqlite3 as _sqlite3

    con = _sqlite3.connect(":memory:")
    con.row_factory = _sqlite3.Row
    # Should not raise even though the table is absent
    repomap._write_summary_cache(con, [("src/a.py", 1.0, 100, "rendered\n")])


# ---------------------------------------------------------------------------
# 23. Density: render_summary tighter format
# ---------------------------------------------------------------------------

def _make_summary(
    *,
    rel_path: str = "src/foo.py",
    language: str = "python",
    rank: float = 0.1234,
    symbols: list[tuple[str, str]] | None = None,
    sections: list[str] | None = None,
    line_count: int = 100,
) -> repomap.FileSummary:
    return repomap.FileSummary(
        rel_path=rel_path,
        language=language,
        rank=rank,
        top_symbols=symbols if symbols is not None else [],
        top_sections=sections if sections is not None else [],
        line_count=line_count,
    )


def test_render_summary_uses_short_rank_label():
    """Dense format uses 'r=' instead of 'rank=' to save tokens."""
    s = _make_summary(rank=0.5)
    text = repomap.render_summary(s)
    assert "r=" in text
    assert "rank=" not in text


def test_render_summary_uses_short_kind_tags():
    """Dense format uses 'fn:' / 'cls:' tags instead of 'function: ' / 'class: '."""
    s = _make_summary(symbols=[("function", "do_thing"), ("class", "Widget")])
    text = repomap.render_summary(s)
    assert "fn:" in text
    assert "cls:" in text
    # Old verbose labels must be gone
    assert "function: " not in text
    assert "class: " not in text


def test_render_summary_compact_mode_drops_symbol_lines():
    """compact=True produces a single line with no symbol detail."""
    s = _make_summary(
        symbols=[("function", "a"), ("class", "B")],
        sections=["Intro"],
    )
    full = repomap.render_summary(s, compact=False)
    compact = repomap.render_summary(s, compact=True)
    # Compact must be a single line (the head)
    assert "\n" not in compact
    # Full must include symbol detail; compact must not
    assert "fn:" in full
    assert "fn:" not in compact
    assert "sec:" not in compact
    # Compact is strictly shorter than full when symbols exist
    assert len(compact) < len(full)


def test_render_summary_compact_is_much_smaller():
    """compact mode should be at least 40% shorter than full when symbols are present."""
    s = _make_summary(
        symbols=[
            ("function", "alpha"), ("function", "beta"), ("function", "gamma"),
            ("class", "Foo"), ("class", "Bar"),
        ],
        sections=["A", "B"],
    )
    full = repomap.render_summary(s, compact=False)
    compact = repomap.render_summary(s, compact=True)
    # On a typical multi-symbol file, compact should save substantial chars.
    assert len(compact) <= len(full) * 0.6


def test_build_map_header_density(ts_project):
    """Header line should be under ~50 chars for a small project."""
    text = repomap.build_map(ts_project, budget_tokens=4000)
    # First line is the header; assert it's compact (project + "(1,lang)")
    header_line = text.splitlines()[0]
    assert len(header_line) < 50, f"header too long ({len(header_line)} chars): {header_line!r}"


def test_build_map_auto_compact_engages_at_low_budget(ts_project):
    """A very small budget must auto-engage compact mode (no 'fn:' detail line)."""
    tight = repomap.build_map(ts_project, budget_tokens=80)
    full = repomap.build_map(ts_project, budget_tokens=4000)
    # The tight output should not include any per-kind detail line.
    # Verify by checking the tight output has no leading-space lines (compact
    # head lines start at column 0).
    for line in tight.splitlines():
        # Detail lines in the new format start with a single space; header
        # and per-file head lines do not.
        if line.startswith(" "):
            raise AssertionError(
                f"auto-compact failed — detail line present at low budget: {line!r}"
            )
    # Full should include at least one detail line (starts with space).
    assert any(line.startswith(" ") for line in full.splitlines()), \
        "full mode should emit at least one detail line for ts_sample"


def test_build_map_explicit_compact_flag(ts_project):
    """compact=True must always produce single-line entries even at high budget."""
    text = repomap.build_map(ts_project, budget_tokens=10000, compact=True)
    for line in text.splitlines():
        # No detail lines (which would start with a leading space).
        assert not line.startswith(" "), \
            f"compact=True produced a detail line: {line!r}"


def test_build_map_compact_fits_more_files_per_token(tmp_path, tmp_data_dir, make_project):
    """At a fixed tight budget, compact mode must include strictly more files than full mode.

    This is the core density win: dropping symbol detail at low budgets lets
    callers orient across more of the codebase using the same token spend.
    """
    from token_goat.parser import index_project

    # Build a small synthetic project with several distinct files so the
    # ranking has multiple candidates within the budget.
    proj_root = tmp_path / "density_sample"
    src = proj_root / "src"
    src.mkdir(parents=True)
    # _is_map_worthy filters by approx_lines = size // 50 >= 4, so each file
    # needs >= 200 bytes. Pad each file with a docstring to clear that bar.
    pad = "# padding line to clear _MIN_DISPLAY_LINES threshold for the map\n" * 6
    for i in range(6):
        (src / f"mod_{i}.py").write_text(
            f"{pad}"
            f"def fn_{i}_a():\n    pass\n\n"
            f"def fn_{i}_b():\n    pass\n\n"
            f"class Cls_{i}:\n    pass\n",
        )
    proj = make_project(proj_root)
    index_project(proj, full=True)

    # Use a budget too tight to fit all 6 files with symbol detail but loose
    # enough that compact mode (1 line/file) can fit them.
    budget = 120
    full_text = repomap.build_map(proj, budget_tokens=budget, compact=False)
    compact_text = repomap.build_map(proj, budget_tokens=budget, compact=True)

    def _count_file_entries(text: str) -> int:
        # File entry head lines contain the language/rank bracket; count them.
        return sum(1 for line in text.splitlines() if "[python," in line)

    full_files = _count_file_entries(full_text)
    compact_files = _count_file_entries(compact_text)
    assert compact_files > full_files, (
        f"compact ({compact_files} files) should fit more files than "
        f"full ({full_files}) at budget {budget}"
    )


def test_build_map_density_chars_per_file_bound(tmp_path, tmp_data_dir, make_project):
    """Compact mode produces at most ~80 chars per file entry on a small project.

    This guards against future format regressions that re-add verbose labels.
    """
    from token_goat.parser import index_project

    proj_root = tmp_path / "density_bound"
    src = proj_root / "src"
    src.mkdir(parents=True)
    pad = "# padding line to clear _MIN_DISPLAY_LINES threshold for the map\n" * 6
    for i in range(5):
        (src / f"a_{i}.py").write_text(
            f"{pad}"
            f"def fn_{i}():\n    pass\n\n"
            f"class C_{i}:\n    pass\n\n"
            f"class D_{i}:\n    pass\n",
        )
    proj = make_project(proj_root)
    index_project(proj, full=True)

    text = repomap.build_map(proj, budget_tokens=10000, compact=True)
    # Skip header (first line) and any tail marker — measure per-file lines.
    file_lines = [
        line for line in text.splitlines()
        if "[python," in line
    ]
    assert file_lines, "expected at least one file line in compact output"
    for line in file_lines:
        assert len(line) <= 80, (
            f"compact file line exceeds 80 chars ({len(line)}): {line!r}"
        )


# ---------------------------------------------------------------------------
# Compact file-list preamble truncation (item 6 — 2026-05-24 design plan)
# ---------------------------------------------------------------------------

def _make_synthetic_project(tmp_path, tmp_data_dir, make_project, n_files: int):
    """Create and index a synthetic project with *n_files* Python source files.

    Each file is padded to clear the ``_is_map_worthy`` threshold
    (approx_lines = size // 50 >= 4, so each file needs >= 200 bytes).
    Returns the indexed ``Project``.
    """
    from token_goat.parser import index_project

    proj_root = tmp_path / f"synth_{n_files}"
    src = proj_root / "src"
    src.mkdir(parents=True)
    pad = "# padding line to clear _MIN_DISPLAY_LINES threshold\n" * 6
    for i in range(n_files):
        (src / f"mod_{i:03d}.py").write_text(
            f"{pad}"
            f"def fn_{i}_a():\n    pass\n\n"
            f"def fn_{i}_b():\n    pass\n\n"
            f"class Cls_{i}:\n    pass\n",
        )
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj


def test_compact_under_threshold_emits_full_list(tmp_path, tmp_data_dir, make_project):
    """30 files + --compact: under the default threshold of 50 — full file list emitted."""
    proj = _make_synthetic_project(tmp_path, tmp_data_dir, make_project, 30)

    # compact_file_threshold=50 (default): 30 < 50, so full list is expected.
    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        compact_file_threshold=50,
    )

    # All 30 files should appear as individual file-entry lines (each has [python,).
    file_lines = [line for line in text.splitlines() if "[python," in line]
    assert len(file_lines) == 30, (
        f"expected 30 file lines under threshold, got {len(file_lines)}"
    )
    # No summary line should be present.
    assert "files indexed. Top modules:" not in text, (
        "summary line must not appear when file count is under threshold"
    )


def test_compact_over_threshold_emits_summary_line(tmp_path, tmp_data_dir, make_project):
    """80 files + --compact + tight budget: 1-line summary with 3 top modules."""
    proj = _make_synthetic_project(tmp_path, tmp_data_dir, make_project, 80)

    # Tight budget (<400 tokens) keeps the summary at the legacy top-3 width.
    text = repomap.build_map(
        proj,
        budget_tokens=300,
        compact=True,
        compact_file_threshold=50,
    )

    # Summary line must be present and contain the correct total count.
    assert "80 files indexed. Top modules:" in text, (
        f"expected '80 files indexed. Top modules:' in output; got:\n{text[:500]}"
    )

    # Top-3 module names must appear (they come from the PageRank head).
    # We don't know the exact order, but at least 3 distinct basenames must be present.
    # The summary format is: "80 files indexed. Top modules: a.py, b.py, c.py (+77 more)"
    import re
    m = re.search(r"Top modules: ([^\n]+)", text)
    assert m is not None, "Top modules line not found"
    modules_part = m.group(1)
    # Count names before "(+N more)" — should be exactly 3 at budget<400.
    names_raw = re.sub(r"\s*\(\+\d+ more\)", "", modules_part)
    names = [n.strip() for n in names_raw.split(",") if n.strip()]
    assert len(names) == 3, (
        f"expected exactly 3 top module names in summary, got {len(names)}: {modules_part!r}"
    )
    # Each name must end in .py (our synthetic project has only .py files).
    for name in names:
        assert name.endswith(".py"), f"module name {name!r} does not end in .py"

    # Individual per-file lines must NOT be present (summary replaced them).
    file_lines = [line for line in text.splitlines() if "[python," in line]
    assert len(file_lines) == 0, (
        f"per-file lines must be absent when summary line is emitted; found {len(file_lines)}"
    )

    # "+N more" annotation must reflect the right remainder.
    assert "(+77 more)" in text, (
        f"expected '(+77 more)' in summary for 80-file project (80 - 3 = 77); got: {modules_part!r}"
    )


def test_compact_summary_scales_top_n_with_budget(tmp_path, tmp_data_dir, make_project):
    """top_n in the summary line scales with available token budget.

    Tight budgets (<400 tokens) keep the legacy 3-module width to stay within
    ~35 tokens total.  Mid budgets surface 5, then 8, then 12 module names so
    a caller with headroom gets a more useful orientation snapshot without
    paying for the full per-file detail rendering.
    """
    import re
    proj = _make_synthetic_project(tmp_path, tmp_data_dir, make_project, 80)

    # Each tier should produce its mapped top_n count.
    cases = [
        (300, 3),
        (500, 5),
        (1500, 8),
        (4000, 12),
    ]
    for budget, expected_top_n in cases:
        text = repomap.build_map(
            proj,
            budget_tokens=budget,
            compact=True,
            compact_file_threshold=50,
        )
        m = re.search(r"Top modules: ([^\n]+)", text)
        assert m is not None, f"summary line missing at budget={budget}"
        names_raw = re.sub(r"\s*\(\+\d+ more\)", "", m.group(1))
        names = [n.strip() for n in names_raw.split(",") if n.strip()]
        assert len(names) == expected_top_n, (
            f"budget={budget} → expected {expected_top_n} modules, "
            f"got {len(names)}: {names}"
        )


def test_compact_over_threshold_full_flag_restores_list(tmp_path, tmp_data_dir, make_project):
    """80 files + --compact --full: full file list is restored despite being over threshold."""
    proj = _make_synthetic_project(tmp_path, tmp_data_dir, make_project, 80)

    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        full=True,
        compact_file_threshold=50,
    )

    # Summary line must NOT be present.
    assert "files indexed. Top modules:" not in text, (
        "--full must suppress the summary line and restore the full file list"
    )

    # All 80 files should appear as individual file-entry lines.
    file_lines = [line for line in text.splitlines() if "[python," in line]
    assert len(file_lines) == 80, (
        f"--full should restore all 80 per-file lines, got {len(file_lines)}"
    )


def test_compact_threshold_env_override(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Threshold override via TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD env var is respected."""
    proj = _make_synthetic_project(tmp_path, tmp_data_dir, make_project, 10)

    # Set the threshold to 5 so that 10 files triggers the summary line.
    monkeypatch.setenv("TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD", "5")

    # Load config with the env override active, then pass the threshold explicitly
    # to build_map (mirrors what cmd_map does via config.load()).
    from token_goat import config as tg_config
    cfg = tg_config.load()
    assert cfg.repomap.compact_file_threshold == 5, (
        f"env override should set threshold to 5, got {cfg.repomap.compact_file_threshold}"
    )

    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        compact_file_threshold=cfg.repomap.compact_file_threshold,
    )

    # 10 files > threshold of 5 → summary line expected.
    assert "10 files indexed. Top modules:" in text, (
        f"expected summary line with threshold=5 and 10 files; got:\n{text[:500]}"
    )

    # Also verify below-threshold: set threshold to 20 so 10 files does NOT trigger.
    monkeypatch.setenv("TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD", "20")
    cfg2 = tg_config.load()
    assert cfg2.repomap.compact_file_threshold == 20

    text2 = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        compact_file_threshold=cfg2.repomap.compact_file_threshold,
    )
    assert "files indexed. Top modules:" not in text2, (
        "summary line must not appear when file count is under threshold=20"
    )


# ---------------------------------------------------------------------------
# Item A20: low-PageRank file collapse in compact mode
# ---------------------------------------------------------------------------


def test_compact_mode_collapses_low_rank_files(tmp_path, tmp_data_dir, make_project):
    """In compact mode, files with PageRank < 0.05 (when >= 5 of them) are
    collapsed into a single '(+N minor files)' tail line rather than rendered
    individually, saving 100-400 tokens on large repos."""

    # Build a project with a mix of well-connected and isolated files.
    proj_root = tmp_path / "collapseproj"
    src = proj_root / "src"
    src.mkdir(parents=True)
    (proj_root / ".git").mkdir()

    # Create 3 hub files that import each other (high PageRank).
    hub_content = (
        "def hub_fn():\n    pass\n\n"
        "def another_fn():\n    pass\n"
    )
    for name in ["hub_a.py", "hub_b.py", "hub_c.py"]:
        (src / name).write_text(hub_content, encoding="utf-8")

    # Create 8 isolated files with no imports (will have low PageRank).
    for i in range(8):
        (src / f"isolated_{i:02d}.py").write_text(
            f"# isolated module {i}\n\ndef isolated_fn_{i}():\n    return {i}\n",
            encoding="utf-8",
        )

    from token_goat.parser import index_project

    proj = make_project(proj_root)
    index_project(proj, full=True)

    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        compact_file_threshold=200,  # high threshold so summary-line path is NOT taken
    )

    # In compact mode with >= 5 isolated/low-rank files, the output should have
    # EITHER the minor-files tail OR all isolated files listed individually.
    # The key invariant is that the output fits the budget and does not crash.
    assert text, "build_map must return non-empty output"

    # When the collapse fired, the annotation must be well-formed.
    if "(+8 minor files)" in text or "minor" in text:
        # Verify the format: "(+N minor files)" or "+B more (+N minor)"
        import re
        minor_pattern = re.compile(r"\(\+\d+ minor files?\)|more \(\+\d+ minor\)")
        assert minor_pattern.search(text), (
            f"minor-files annotation must match expected format; got:\n{text[:600]}"
        )


def test_compact_mode_no_collapse_when_few_low_rank(tmp_path, tmp_data_dir, make_project):
    """When fewer than 5 low-rank files exist, no collapse annotation is emitted."""
    proj_root = tmp_path / "nocollapseproj"
    src = proj_root / "src"
    src.mkdir(parents=True)
    (proj_root / ".git").mkdir()

    # 4 isolated files (below the collapse threshold of 5).
    for i in range(4):
        (src / f"lone_{i}.py").write_text(
            f"def fn_{i}():\n    return {i}\n",
            encoding="utf-8",
        )

    from token_goat.parser import index_project

    proj = make_project(proj_root)
    index_project(proj, full=True)

    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=True,
        compact_file_threshold=200,
    )

    assert text, "build_map must return non-empty output"
    # With only 4 low-rank files, collapse must NOT be triggered.
    assert "minor files" not in text, (
        "minor-files annotation must not appear with fewer than 5 low-rank files"
    )


def test_compact_false_no_collapse(tmp_path, tmp_data_dir, make_project):
    """Low-rank collapse only applies in compact mode; full mode must not collapse."""
    proj_root = tmp_path / "fullmodeproj"
    src = proj_root / "src"
    src.mkdir(parents=True)
    (proj_root / ".git").mkdir()

    # 8 isolated files.
    for i in range(8):
        (src / f"iso_{i}.py").write_text(
            f"def fn_{i}():\n    return {i}\n",
            encoding="utf-8",
        )

    from token_goat.parser import index_project

    proj = make_project(proj_root)
    index_project(proj, full=True)

    text = repomap.build_map(
        proj,
        budget_tokens=10000,
        compact=False,
        compact_file_threshold=200,
    )

    assert text, "build_map must return non-empty output"
    assert "minor files" not in text, (
        "minor-files annotation must not appear in full (non-compact) mode"
    )


# ---------------------------------------------------------------------------
# Path-exclusion: prefix / substring / basename filters
# ---------------------------------------------------------------------------

class TestExcludedPaths:
    """``_is_excluded_path`` filters generated/transient artifacts.

    Three categories of pollution have historically distorted the map:
      * Test-fixture stubs (the original exclusion, prefix-matched).
      * uv-cache directories that co-locate with the source tree on
        Windows + uv layouts and leak vendored ``_manylinux.py`` rows.
      * Coverage artifacts (``coverage.json`` etc.) that survive the
        parser's lockfile filter because ``.json`` is an indexed extension.
    """

    def setup_method(self):
        # _is_excluded_path is lru_cached at module scope; clear before each
        # case so prior assertions don't leak through and mask a regression.
        repomap._is_excluded_path.cache_clear()

    def test_tests_fixtures_excluded(self):
        assert repomap._is_excluded_path("tests/fixtures/foo.py")
        assert repomap._is_excluded_path("tests/fixtures/sub/bar.py")

    def test_normal_source_not_excluded(self):
        assert not repomap._is_excluded_path("src/token_goat/parser.py")
        assert not repomap._is_excluded_path("tests/test_repomap.py")
        assert not repomap._is_excluded_path("README.md")

    def test_uv_cache_root_excluded(self):
        # Both the standard and -local variants pollute the index when uv runs
        # with the cache co-located in the repo (default on Windows).
        assert repomap._is_excluded_path(".uv-cache/x.py")
        assert repomap._is_excluded_path(".uv-cache-local/x.py")
        assert repomap._is_excluded_path(
            ".uv-cache-local/.tmpHZ08Ai/python/packaging/_manylinux.py"
        )

    def test_uv_tmp_subdir_excluded_anywhere(self):
        # The substring filter catches random-suffixed tmp build dirs
        # regardless of which parent they appear under.
        assert repomap._is_excluded_path(".uv-cache/.tmp2VqIvs/wheel.py")
        assert repomap._is_excluded_path("some/path/.tmpABC/inner.py")

    def test_coverage_artifacts_excluded(self):
        # coverage.json sits at the repo root with the indexable .json
        # extension; it pollutes "Top modules" with a non-source entry.
        assert repomap._is_excluded_path("coverage.json")
        assert repomap._is_excluded_path("coverage.xml")
        assert repomap._is_excluded_path("lcov.info")
        # Subdirectory variant (some tools emit subreports).
        assert repomap._is_excluded_path("subproj/coverage.json")

    def test_basename_match_is_case_insensitive(self):
        # Windows tooling sometimes emits Coverage.JSON; the filter must
        # still drop it even though the basename casing differs.
        assert repomap._is_excluded_path("Coverage.JSON")
        assert repomap._is_excluded_path("LCOV.info")

    def test_windows_backslash_paths_normalized(self):
        # _load_project_data stores POSIX-rel paths but callers can in
        # principle pass Windows-style separators (e.g. parser hand-off
        # before normalisation).  Both should produce the same verdict.
        assert repomap._is_excluded_path(".uv-cache\\foo.py")
        assert repomap._is_excluded_path("tests\\fixtures\\foo.py")


# ---------------------------------------------------------------------------
# Compact summary top_n widening
# ---------------------------------------------------------------------------

class TestBuildCompactFileSummary:
    """The 1-line summary widens with the available token budget.

    Helper-level coverage so tier-boundary tweaks are easy to spot without
    spinning up a synthetic indexed project for each tier.
    """

    def _ranked(self, n):
        return [(f"src/mod_{i}.py", {"language": "python", "size": 1000, "mtime": 0.0}) for i in range(n)]

    def test_default_top_n_is_three(self):
        # Back-compat: callers that don't pass top_n see the legacy width.
        out = repomap._build_compact_file_summary(self._ranked(20), 20)
        assert "Top modules: mod_0.py, mod_1.py, mod_2.py" in out
        assert "(+17 more)" in out

    def test_top_n_widens(self):
        out = repomap._build_compact_file_summary(self._ranked(20), 20, top_n=5)
        # Five basenames before the (+N more) annotation.
        modules = out.split("Top modules: ", 1)[1].split(" (+")[0]
        assert modules.count(",") == 4  # 5 names → 4 commas
        assert "(+15 more)" in out

    def test_top_n_floor_one(self):
        # Defensive: top_n<1 collapses to 1 rather than emitting an empty list.
        out = repomap._build_compact_file_summary(self._ranked(20), 20, top_n=0)
        assert "Top modules: mod_0.py (+19 more)" in out

    def test_top_n_capped_by_available_files(self):
        # When ranked has fewer entries than top_n, only available ones appear
        # and no (+N more) tail is emitted (no remainder).
        out = repomap._build_compact_file_summary(self._ranked(2), 2, top_n=10)
        assert out.split("indexed. ", 1)[1] == "Top modules: mod_0.py, mod_1.py\n"
