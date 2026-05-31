"""Regression tests for correctness bugs in the surgical-read commands.

Each test class covers one issue category:
  1. Symbol ranking: non-test files ranked above test files for same symbol name
  2. Section #N ordinal: duplicate headings, ordinal selection, edge cases
  3. Line-range clamping: end beyond file length handled correctly
  4. Cross-project symbol fall-through: most-recently-indexed project preferred
  5. Symbol --type filter: kind filtering applied correctly
"""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat import read_replacement
from token_goat.parser import index_project
from token_goat.project import Project, canonicalize, project_hash

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FIXTURE_DIR = Path(__file__).parent / "fixtures"
PY_SAMPLE = FIXTURE_DIR / "py_sample"
MD_SAMPLE = FIXTURE_DIR / "md_sample"


def _make_project(root: Path) -> Project:
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


# ---------------------------------------------------------------------------
# Issue 1 — Symbol ranking: non-test files preferred over test files
# ---------------------------------------------------------------------------


class TestSymbolRankingNonTestFirst:
    """_rank_symbol_results should prefer non-test files when symbol name ties."""

    def test_non_test_file_ranks_before_test_file(self):
        """A symbol in src/models.py must rank above the same name in tests/test_models.py."""
        from token_goat.cli import _rank_symbol_results

        results = [
            {"name": "Foo", "kind": "class", "file": "tests/test_models.py", "line": 5},
            {"name": "Foo", "kind": "class", "file": "src/models.py", "line": 10},
        ]
        ranked = _rank_symbol_results(results, "Foo")
        # Non-test file must come first regardless of input order.
        assert ranked[0]["file"] == "src/models.py", (
            f"Expected src/models.py first but got {ranked[0]['file']!r}. "
            "Non-test files should rank above test files for the same symbol."
        )

    def test_test_file_last_when_multiple_test_paths(self):
        """spec/ and __tests__/ are also test-path patterns and must rank below src."""
        from token_goat.cli import _rank_symbol_results

        results = [
            {"name": "Widget", "kind": "class", "file": "spec/widget_spec.py", "line": 3},
            {"name": "Widget", "kind": "class", "file": "__tests__/Widget.test.ts", "line": 1},
            {"name": "Widget", "kind": "class", "file": "src/ui/Widget.ts", "line": 20},
        ]
        ranked = _rank_symbol_results(results, "Widget")
        assert ranked[0]["file"] == "src/ui/Widget.ts", (
            "src/ file must come before spec/ and __tests__/ files."
        )

    def test_ranking_stable_when_all_test_files(self):
        """If every match is in a test file, order should still be deterministic (stable)."""
        from token_goat.cli import _rank_symbol_results

        results = [
            {"name": "Foo", "kind": "function", "file": "tests/test_a.py", "line": 10},
            {"name": "Foo", "kind": "function", "file": "tests/test_b.py", "line": 5},
        ]
        ranked = _rank_symbol_results(results, "Foo")
        # Both are test files — just check we get both back, no crash.
        assert len(ranked) == 2

    def test_non_test_file_ranked_first_regardless_of_input_order(self):
        """Input order must not determine output when a non-test file is present."""
        from token_goat.cli import _rank_symbol_results

        # Start with test file first in the input list.
        results = [
            {"name": "parse", "kind": "function", "file": "test_parser.py", "line": 1},
            {"name": "parse", "kind": "function", "file": "parser.py", "line": 50},
        ]
        ranked = _rank_symbol_results(results, "parse")
        assert ranked[0]["file"] == "parser.py", (
            "parser.py (non-test) must come before test_parser.py even when input order is reversed."
        )

    def test_non_test_file_ranked_first_in_indexed_project(self, tmp_path, tmp_data_dir, make_project):
        """Integration: symbol command returns the non-test file result first when both have same name."""
        from token_goat import db as _db

        proj_root = tmp_path / "dual_foo"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "src").mkdir()
        (proj_root / "tests").mkdir()

        (proj_root / "src" / "models.py").write_text(
            "class Foo:\n    '''The real Foo.'''\n    pass\n", encoding="utf-8"
        )
        (proj_root / "tests" / "test_models.py").write_text(
            "class Foo:\n    '''Test Foo stub.'''\n    pass\n", encoding="utf-8"
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)

        # Fetch raw DB rows.
        with _db.open_project(proj.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, file_rel, line FROM symbols WHERE name = 'Foo' ORDER BY file_rel"
            ).fetchall()

        assert len(rows) == 2, "Both files should define class Foo"

        # Simulate what _project_query does.
        from token_goat.cli import _rank_symbol_results
        result_dicts = [
            {"name": r["name"], "kind": r["kind"], "file": r["file_rel"], "line": r["line"]}
            for r in rows
        ]
        ranked = _rank_symbol_results(result_dicts, "Foo")
        assert ranked[0]["file"] == "src/models.py", (
            f"Expected src/models.py first, got {ranked[0]['file']!r}"
        )


# ---------------------------------------------------------------------------
# Issue 2 — Section ordinal #N: duplicate headings
# ---------------------------------------------------------------------------


class TestSectionOrdinalDuplicateHeadings:
    """read_section with #2 should return the second occurrence of a duplicate heading."""

    @pytest.fixture
    def dup_heading_project(self, tmp_path, tmp_data_dir, make_project):
        """Project with a markdown file containing two ## Setup sections."""
        proj_root = tmp_path / "dup_heading"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        doc = (
            "# Guide\n"
            "\n"
            "## Setup\n"
            "\n"
            "First setup section.\n"
            "\n"
            "## Usage\n"
            "\n"
            "Some usage.\n"
            "\n"
            "## Setup\n"
            "\n"
            "Second setup section.\n"
        )
        (proj_root / "guide.md").write_text(doc, encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_section_first_occurrence_default(self, dup_heading_project):
        """Without #N, read_section returns the first occurrence."""
        _, proj = dup_heading_project
        result = read_replacement.read_section(proj, "guide.md", "Setup")
        assert result is not None, "Should find the Setup heading"
        assert "First setup section" in result["text"], (
            "Default (no ordinal) must return the first Setup section."
        )

    def test_section_second_occurrence_with_ordinal_2(self, dup_heading_project):
        """With #2, read_section returns the second occurrence."""
        _, proj = dup_heading_project
        result = read_replacement.read_section(proj, "guide.md", "Setup#2")
        assert result is not None, "Should find Setup#2"
        assert "Second setup section" in result["text"], (
            "#2 must return the second Setup section."
        )

    def test_section_ordinal_beyond_count_returns_none(self, dup_heading_project):
        """Requesting #3 when only 2 sections exist returns None."""
        _, proj = dup_heading_project
        result = read_replacement.read_section(proj, "guide.md", "Setup#3")
        assert result is None, "Ordinal 3 exceeds count 2; should return None."

    def test_section_ordinal_one_returns_first(self, dup_heading_project):
        """#1 is equivalent to no ordinal: returns the first occurrence."""
        _, proj = dup_heading_project
        result = read_replacement.read_section(proj, "guide.md", "Setup#1")
        assert result is not None
        assert "First setup section" in result["text"], (
            "#1 must select the first (same as default)."
        )

    def test_parse_section_ordinal_zero_ignored(self):
        """#0 is not a valid ordinal (1-based); the heading is treated literally."""
        base, ordinal = read_replacement._parse_section_ordinal("Setup#0")
        assert ordinal is None, "#0 should be rejected (ordinals are 1-based)."
        assert base == "Setup#0", "The heading text must not be stripped when ordinal is invalid."

    def test_parse_section_ordinal_negative_ignored(self):
        """Negative ordinals like #-1 are treated as literal heading text."""
        base, ordinal = read_replacement._parse_section_ordinal("Setup#-1")
        # rpartition on "#-1" → base="Setup#", ordinal_str="-1" … int("-1")=-1 < 1 → rejected
        assert ordinal is None

    def test_parse_section_ordinal_non_numeric_ignored(self):
        """Non-numeric suffix like Setup#abc is treated as literal heading text."""
        base, ordinal = read_replacement._parse_section_ordinal("Setup#abc")
        assert ordinal is None
        assert base == "Setup#abc"

    def test_section_ordinal_case_insensitive_fallback(self, dup_heading_project):
        """#2 works even when using wrong-case heading via case-insensitive fallback."""
        _, proj = dup_heading_project
        # "setup#2" vs stored "Setup" — fallback to case-insensitive, then pick ordinal 2.
        result = read_replacement.read_section(proj, "guide.md", "setup#2")
        assert result is not None, "Case-insensitive #2 must still find second occurrence."
        assert "Second setup section" in result["text"]


# ---------------------------------------------------------------------------
# Issue 3 — Line-range clamping: end beyond file length
# ---------------------------------------------------------------------------


class TestLineRangeClamping:
    """read_line_range clamps end to actual file length; large end values work correctly."""

    @pytest.fixture
    def short_file_project(self, tmp_path, tmp_data_dir, make_project):
        """Project with a 5-line Python file."""
        proj_root = tmp_path / "short_file"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        content = "line1\nline2\nline3\nline4\nline5\n"
        (proj_root / "short.py").write_text(content, encoding="utf-8")
        proj = make_project(proj_root)
        # No index needed — read_line_range reads the file directly.
        return proj_root, proj

    def test_end_beyond_file_length_clamped(self, short_file_project):
        """end=99999 on a 5-line file is clamped to 5; all lines are returned."""
        _, proj = short_file_project
        result = read_replacement.read_line_range(proj, "short.py", 1, 99999)
        assert result is not None, "Large end should be clamped, not return None."
        assert result["end_line"] == 5, "end_line must be clamped to file length."
        assert result["start_line"] == 1
        assert "line1" in result["text"]
        assert "line5" in result["text"]

    def test_start_within_range_end_beyond(self, short_file_project):
        """start=3, end=99999 → returns lines 3-5."""
        _, proj = short_file_project
        result = read_replacement.read_line_range(proj, "short.py", 3, 99999)
        assert result is not None
        assert result["start_line"] == 3
        assert result["end_line"] == 5
        assert "line3" in result["text"]
        assert "line5" in result["text"]
        assert "line1" not in result["text"]

    def test_start_at_last_line(self, short_file_project):
        """start=5, end=99999 on a 5-line file → returns only line 5."""
        _, proj = short_file_project
        result = read_replacement.read_line_range(proj, "short.py", 5, 99999)
        assert result is not None
        assert result["start_line"] == 5
        assert result["end_line"] == 5

    def test_start_beyond_file_returns_none(self, short_file_project):
        """start=10 on a 5-line file → None (start is beyond the file)."""
        _, proj = short_file_project
        result = read_replacement.read_line_range(proj, "short.py", 10, 99999)
        assert result is None, (
            "start beyond file length has no available lines to return."
        )

    def test_exact_file_length_range(self, short_file_project):
        """Requesting exactly lines 1-5 on a 5-line file returns all 5 lines."""
        _, proj = short_file_project
        result = read_replacement.read_line_range(proj, "short.py", 1, 5)
        assert result is not None
        assert result["start_line"] == 1
        assert result["end_line"] == 5

    def test_parse_line_range_rejects_zero_start(self):
        """parse_line_range rejects start=0 (line numbers are 1-based)."""
        assert read_replacement.parse_line_range("0-5") is None

    def test_parse_line_range_rejects_end_before_start(self):
        """parse_line_range rejects end < start."""
        assert read_replacement.parse_line_range("10-5") is None

    def test_parse_line_range_accepts_single_line(self):
        """parse_line_range accepts start==end (single-line range)."""
        result = read_replacement.parse_line_range("3-3")
        assert result == (3, 3)

    def test_parse_line_range_accepts_large_end(self):
        """parse_line_range accepts a very large end value."""
        result = read_replacement.parse_line_range("1-99999")
        assert result == (1, 99999)


# ---------------------------------------------------------------------------
# Issue 4 — Cross-project fall-through: prefer most-recently-indexed project
# ---------------------------------------------------------------------------


class TestCrossProjectFallthrough:
    """find_in_all_projects prefers the most-recently-indexed project when the same
    filename exists in multiple projects, instead of always raising AmbiguousFileMatch."""

    def _setup_two_projects(self, tmp_path, tmp_data_dir, make_project, *, older_last_seen: int, newer_last_seen: int):
        """Create two projects each containing 'shared.py'.

        Returns (proj_old, proj_new) ordered by last_seen value.
        """
        from token_goat import db as _db

        # Project A (older index)
        proj_a_root = tmp_path / "proj_a"
        proj_a_root.mkdir()
        (proj_a_root / ".git").mkdir()
        (proj_a_root / "shared.py").write_text("def from_proj_a(): pass\n", encoding="utf-8")
        proj_a = make_project(proj_a_root)
        index_project(proj_a, full=True)

        # Project B (newer index)
        proj_b_root = tmp_path / "proj_b"
        proj_b_root.mkdir()
        (proj_b_root / ".git").mkdir()
        (proj_b_root / "shared.py").write_text("def from_proj_b(): pass\n", encoding="utf-8")
        proj_b = make_project(proj_b_root)
        index_project(proj_b, full=True)

        # Manually set last_seen to control which is "newer".
        with _db.open_global() as gconn:
            gconn.execute(
                "UPDATE projects SET last_seen = ? WHERE hash = ?",
                (older_last_seen, proj_a.hash),
            )
            gconn.execute(
                "UPDATE projects SET last_seen = ? WHERE hash = ?",
                (newer_last_seen, proj_b.hash),
            )
        return proj_a, proj_b

    def test_most_recently_indexed_project_preferred(self, tmp_path, tmp_data_dir, make_project):
        """When shared.py exists in two projects, the newer-indexed one is returned."""
        proj_a, proj_b = self._setup_two_projects(
            tmp_path, tmp_data_dir, make_project,
            older_last_seen=1000,
            newer_last_seen=2000,
        )
        # Should return proj_b (newer last_seen=2000) not raise AmbiguousFileMatch.
        result = read_replacement.find_in_all_projects("shared.py")
        assert result is not None, "Should find shared.py in one of the projects."
        found_proj, found_rel = result
        assert found_proj.hash == proj_b.hash, (
            f"Expected newer project (proj_b hash={proj_b.hash[:8]}) "
            f"but got hash={found_proj.hash[:8]}. Most-recently-indexed project must be preferred."
        )
        assert found_rel == "shared.py"

    def test_older_project_chosen_when_it_is_newer(self, tmp_path, tmp_data_dir, make_project):
        """Ordering is dynamic: if proj_a has a larger last_seen, it should win."""
        proj_a, proj_b = self._setup_two_projects(
            tmp_path, tmp_data_dir, make_project,
            older_last_seen=9000,
            newer_last_seen=1000,
        )
        result = read_replacement.find_in_all_projects("shared.py")
        assert result is not None
        found_proj, _ = result
        assert found_proj.hash == proj_a.hash, (
            "proj_a has larger last_seen=9000 so it should be preferred over proj_b."
        )


# ---------------------------------------------------------------------------
# Issue 5 — Symbol --type filter correctness
# ---------------------------------------------------------------------------


class TestSymbolTypeFilter:
    """_symbol_kind_filter and the --type SQL filter work correctly."""

    def test_kind_filter_fn_maps_to_function(self):
        """--type fn expands to ['function'] for the SQL query."""
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["fn"])
        assert result == ["function"]

    def test_kind_filter_func_maps_to_function(self):
        """--type func also expands to ['function']."""
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["func"])
        assert result == ["function"]

    def test_kind_filter_class_maps_to_class(self):
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["class"])
        assert result == ["class"]

    def test_kind_filter_uppercase_input_lowercased(self):
        """User-supplied type names are lowercased before use."""
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["Class"])
        assert result == ["class"]
        result2 = _symbol_kind_filter(["FN"])
        assert result2 == ["function"]

    def test_kind_filter_deduplicates(self):
        """--type fn --type function should deduplicate to ['function']."""
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["fn", "function"])
        assert result == ["function"], f"Expected ['function'], got {result}"

    def test_kind_filter_multiple_kinds(self):
        """--type class --type method produces both kinds."""
        from token_goat.cli import _symbol_kind_filter

        result = _symbol_kind_filter(["class", "method"])
        assert "class" in result
        assert "method" in result
        assert len(result) == 2

    def test_kind_filter_applied_in_db_query(self, tmp_path, tmp_data_dir, make_project):
        """SQL query with kind filter returns only symbols of the requested kind."""
        from token_goat import db as _db

        proj_root = tmp_path / "kind_filter_test"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        # File with both a class and a function sharing a similar-sounding name.
        (proj_root / "widget.py").write_text(
            "class Widget:\n    pass\n\ndef widget_factory():\n    pass\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)

        with _db.open_project(proj.hash) as conn:
            # Filter by class only — must not return the function.
            rows = conn.execute(
                "SELECT name, kind FROM symbols WHERE kind IN ('class') AND file_rel = 'widget.py'"
            ).fetchall()
        kinds = {r["kind"] for r in rows}
        names = {r["name"] for r in rows}

        assert kinds == {"class"}, f"Expected only 'class' kind, got {kinds}"
        assert "Widget" in names
        assert "widget_factory" not in names, "Function must not appear when filtering by class."

    def test_kind_filter_fn_excludes_class(self, tmp_path, tmp_data_dir, make_project):
        """--type fn filter must exclude class symbols even if they share a name prefix."""
        from token_goat import db as _db
        from token_goat.cli import _symbol_kind_filter

        proj_root = tmp_path / "fn_class_test"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "auth.py").write_text(
            "class Auth:\n    pass\n\ndef auth_check():\n    pass\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)

        kind_filter = _symbol_kind_filter(["fn"])  # → ["function"]
        placeholders = ",".join("?" * len(kind_filter))
        sql = f"SELECT name, kind FROM symbols WHERE kind IN ({placeholders}) AND file_rel = 'auth.py'"  # noqa: S608

        with _db.open_project(proj.hash) as conn:
            rows = conn.execute(sql, tuple(kind_filter)).fetchall()

        names = {r["name"] for r in rows}
        kinds = {r["kind"] for r in rows}

        assert "Auth" not in names, "Class symbol must be excluded by --type fn filter."
        assert all(k == "function" for k in kinds), f"Only functions expected, got {kinds}"
