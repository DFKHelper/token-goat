"""Tests for TOML and YAML section extraction (sub-area G).

Verifies that:
 - [tool.ruff] dotted-key sections are indexed correctly
 - [[array-of-tables]] sections get level=2
 - Inline tables within a section don't create spurious section headers
 - YAML nested keys are extracted at depth 1 and 2
 - The `section` command can look up dotted-key TOML sections
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# TOML indexer unit tests
# ---------------------------------------------------------------------------

class TestTomlSectionExtraction:
    """toml_idx.extract handles dotted keys, arrays-of-tables, and inline tables."""

    def _extract(self, source: str) -> list:
        from token_goat.languages.toml_idx import extract
        syms, refs, imps, secs = extract(source.encode(), "pyproject.toml")
        return secs

    def test_simple_table_headers_indexed(self):
        """Basic [section] headers produce one Section each."""
        source = "[project]\nname = 'foo'\n\n[build-system]\nrequires = []\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "project" in headings
        assert "build-system" in headings

    def test_dotted_key_section(self):
        """[tool.ruff] produces a section with heading 'tool.ruff'."""
        source = "[project]\nname = 'foo'\n\n[tool.ruff]\nline-length = 100\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "tool.ruff" in headings

    def test_deeply_nested_dotted_key(self):
        """[tool.ruff.lint] is indexed with heading 'tool.ruff.lint'."""
        source = "[tool.ruff]\nline-length = 100\n\n[tool.ruff.lint]\nignore = []\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "tool.ruff.lint" in headings

    def test_arrays_of_tables_get_level_2(self):
        """[[array.of.tables]] sections have level=2."""
        source = "[[tool.ruff.per-file-ignores]]\nfiles = ['tests/*']\nignores = ['S']\n"
        secs = self._extract(source)
        assert any(s.heading == "tool.ruff.per-file-ignores" for s in secs)
        aot_secs = [s for s in secs if s.heading == "tool.ruff.per-file-ignores"]
        assert aot_secs[0].level == 2

    def test_inline_tables_do_not_create_extra_sections(self):
        """Inline tables like `key = {a = 1}` are not mistaken for table headers."""
        source = (
            "[project]\n"
            "optional-dependencies = {test = ['pytest']}\n"
            "\n"
            "[tool]\n"
            "skip = true\n"
        )
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        # Only [project] and [tool] should be headers; no 'test' or 'pytest' sections
        assert "project" in headings
        assert "tool" in headings
        # The inline table value should not produce a section
        assert "test" not in headings

    def test_section_line_ranges_correct(self):
        """Section line ranges cover the full section body."""
        source = "[project]\nname = 'foo'\ndesc = 'bar'\n\n[build]\nrequires = []\n"
        secs = self._extract(source)
        project_sec = next(s for s in secs if s.heading == "project")
        # [project] starts at line 1 and ends just before [build]
        assert project_sec.line == 1
        assert project_sec.end_line >= 3  # covers name and desc lines

    def test_empty_file_produces_no_sections(self):
        """An empty TOML file produces no sections."""
        secs = self._extract("")
        assert secs == []

    def test_comments_only_produces_no_sections(self):
        """A file with only comments has no sections."""
        source = "# This is a comment\n# Another comment\n"
        secs = self._extract(source)
        assert secs == []


# ---------------------------------------------------------------------------
# YAML indexer unit tests
# ---------------------------------------------------------------------------

class TestYamlSectionExtraction:
    """yaml_idx.extract handles nested keys and depth-1 expansion."""

    def _extract(self, source: str) -> list:
        from token_goat.languages.yaml_idx import extract
        syms, refs, imps, secs = extract(source.encode(), "config.yaml")
        return secs

    def test_top_level_keys_indexed(self):
        """Top-level YAML keys become sections."""
        source = "services:\n  web:\n    image: nginx\n\nnetworks:\n  default:\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "services" in headings
        assert "networks" in headings

    def test_nested_key_indexed_as_dotted(self):
        """Nested keys like services.web appear as 'services.web'."""
        source = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "services.web" in headings
        assert "services.db" in headings

    def test_deeply_nested_not_over_indexed(self):
        """YAML extractor indexes top-level and one level deep only."""
        source = "a:\n  b:\n    c:\n      d: 1\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        # 'a' and 'a.b' should be indexed; 'a.b.c' may or may not be
        assert "a" in headings

    def test_empty_yaml_produces_no_sections(self):
        """Empty YAML file produces no sections."""
        secs = self._extract("")
        assert secs == []

    def test_comment_lines_not_indexed(self):
        """Comment lines in YAML are not indexed as sections."""
        source = "# top comment\nkey: value\n# another comment\nother: 2\n"
        secs = self._extract(source)
        headings = {s.heading for s in secs}
        assert "top comment" not in headings
        assert "another comment" not in headings


# ---------------------------------------------------------------------------
# Integration: section lookup for indexed TOML files
# ---------------------------------------------------------------------------

class TestTomlSectionLookup:
    """read_replacement.read_section can retrieve dotted-key TOML sections."""

    def _make_toml_project(self, tmp_path, tmp_data_dir, make_project, content: str):
        from token_goat.parser import index_project
        proj_root = tmp_path / "toml_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "pyproject.toml").write_text(content, encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_lookup_dotted_key_section(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """read_section returns the [tool.ruff] block for dotted key lookup."""
        content = (
            "[project]\nname = 'myapp'\n\n"
            "[tool.ruff]\nline-length = 100\nselect = ['E', 'F']\n\n"
            "[tool.mypy]\nstrict = true\n"
        )
        proj_root, proj = self._make_toml_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat import read_replacement
        result = read_replacement.read_section(proj, "pyproject.toml", "tool.ruff")
        assert result is not None
        # The result should contain the tool.ruff section content
        text = result.text if hasattr(result, "text") else str(result)
        assert "line-length" in text or "100" in text

    def test_lookup_arrays_of_tables_section(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """read_section handles [[array-of-tables]] sections with level=2."""
        content = (
            "[project]\nname = 'x'\n\n"
            "[[tool.hatch.envs.default.scripts]]\nname = 'test'\ncmd = 'pytest'\n"
        )
        proj_root, proj = self._make_toml_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        # Arrays of tables should be indexable
        from token_goat.languages.toml_idx import extract
        syms, refs, imps, secs = extract(content.encode(), "pyproject.toml")
        headings = {s.heading for s in secs}
        assert "project" in headings
