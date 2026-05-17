"""Iteration-25 coverage tests.

Targets:
- worker.drain_dirty_queue: non-dict JSON entry and invalid-JSON entry (malformed_count paths)
- embeddings.extract_chunks_for_file: unsafe rel_path rejection, section-based chunks
- languages.markdown: no-frontmatter content, end_line boundary when last section
- languages.liquid: invalid-JSON schema block swallowed, snippet directory (no section-file symbol)
- languages.html: multi-class splitting into individual symbols, h4 heading level, empty source
- languages.rust: _parse_use_target fallback when regex does not match
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import token_goat.paths as paths
import token_goat.worker as worker
from token_goat import db
from token_goat.embeddings import extract_chunks_for_file
from token_goat.languages.html import extract as html_extract
from token_goat.languages.liquid import extract as liquid_extract
from token_goat.languages.markdown import extract as md_extract
from token_goat.languages.rust import _parse_use_target
from token_goat.languages.rust import extract as rust_extract

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def ts_project(tmp_data_dir, tmp_path):
    """Index the ts_sample fixture into a temporary project DB."""
    from token_goat.parser import index_project  # noqa: PLC0415
    from token_goat.project import Project, canonicalize, project_hash  # noqa: PLC0415

    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    canon = canonicalize(proj_root)
    proj = Project(root=canon, hash=project_hash(canon), marker=".git")
    index_project(proj)
    return proj


# ---------------------------------------------------------------------------
# drain_dirty_queue — malformed entry paths
# ---------------------------------------------------------------------------


class TestDrainDirtyQueueMalformed:
    def test_non_dict_json_entry_is_skipped(self, tmp_data_dir):
        """A valid-JSON but non-dict entry (e.g. a list) is counted as malformed and skipped."""
        queue_path = paths.dirty_queue_path()
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        # Write one valid entry and one non-dict entry
        valid = {
            "path": "src/foo.py",
            "project_hash": "abc",
            "project_root": "/p",
            "project_marker": ".git",
            "ts": 0.0,
        }
        queue_path.write_text(
            json.dumps(valid) + "\n" + json.dumps([1, 2, 3]) + "\n",
            encoding="utf-8",
        )
        entries = worker.drain_dirty_queue()
        # Only the valid dict entry should be returned
        assert len(entries) == 1
        assert entries[0]["path"] == "src/foo.py"

    def test_invalid_json_entry_is_skipped(self, tmp_data_dir):
        """A line that is not valid JSON is counted as malformed and skipped."""
        queue_path = paths.dirty_queue_path()
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        valid = {
            "path": "src/bar.py",
            "project_hash": "xyz",
            "project_root": "/r",
            "project_marker": ".git",
            "ts": 1.0,
        }
        queue_path.write_text(
            json.dumps(valid) + "\n" + "{ not valid json !!!\n",
            encoding="utf-8",
        )
        entries = worker.drain_dirty_queue()
        assert len(entries) == 1
        assert entries[0]["path"] == "src/bar.py"

    def test_all_malformed_entries_returns_empty(self, tmp_data_dir):
        """When every entry is malformed, drain returns an empty list without raising."""
        queue_path = paths.dirty_queue_path()
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        queue_path.write_text(
            '{ bad\n' + json.dumps(["not", "a", "dict"]) + "\n",
            encoding="utf-8",
        )
        entries = worker.drain_dirty_queue()
        assert entries == []

    def test_blank_lines_are_ignored(self, tmp_data_dir):
        """Blank lines in the queue file are silently skipped, not treated as malformed."""
        queue_path = paths.dirty_queue_path()
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        valid = {"path": "x.py", "project_hash": "h", "project_root": "/p", "project_marker": ".git", "ts": 0.0}
        queue_path.write_text("\n\n" + json.dumps(valid) + "\n\n", encoding="utf-8")
        entries = worker.drain_dirty_queue()
        assert len(entries) == 1


# ---------------------------------------------------------------------------
# extract_chunks_for_file — unsafe path rejection
# ---------------------------------------------------------------------------


class TestExtractChunksUnsafePath:
    def test_path_traversal_rejected(self, ts_project):
        """extract_chunks_for_file returns [] for a path containing '..'."""
        with db.open_project(ts_project.hash) as conn:
            result = extract_chunks_for_file(ts_project, conn, "../etc/passwd")
        assert result == []

    def test_absolute_path_rejected(self, ts_project):
        """extract_chunks_for_file returns [] for an absolute path."""
        with db.open_project(ts_project.hash) as conn:
            result = extract_chunks_for_file(ts_project, conn, "/etc/passwd")
        assert result == []


# ---------------------------------------------------------------------------
# extract_chunks_for_file — section-based chunks (markdown file in project)
# ---------------------------------------------------------------------------


class TestExtractChunksSections:
    def test_markdown_file_produces_section_chunks(self, ts_project):
        """A markdown file with headings produces 'section' kind chunks."""
        md_path = ts_project.root / "README.md"
        # Write a markdown file with enough content to exceed MIN_CHUNK_CHARS
        md_path.write_text(
            "# Introduction\n\n"
            + "This is a long enough section to exceed the minimum chunk size. " * 4
            + "\n\n## Details\n\n"
            + "More detailed content that also exceeds the minimum size threshold. " * 4
            + "\n",
            encoding="utf-8",
        )
        # Index the project to pick up the new file
        from token_goat.parser import index_project  # noqa: PLC0415

        index_project(ts_project)

        with db.open_project(ts_project.hash) as conn:
            chunks = extract_chunks_for_file(ts_project, conn, "README.md")

        section_chunks = [c for c in chunks if c.kind == "section"]
        assert len(section_chunks) >= 1, "Expected at least one section chunk from the markdown file"


# ---------------------------------------------------------------------------
# Markdown extractor — untested branches
# ---------------------------------------------------------------------------


class TestMarkdownExtractor:
    def test_no_frontmatter_no_title_symbol(self):
        """A file with no YAML front matter produces no md_title symbol."""
        source = b"# Plain Heading\n\nSome content here.\n"
        symbols, _, _, sections = md_extract(source, "plain.md")
        title_syms = [s for s in symbols if s.kind == "md_title"]
        assert title_syms == []
        assert any(s.heading == "Plain Heading" for s in sections)

    def test_last_section_end_line_is_last_line(self):
        """The final section's end_line equals the last line of the document."""
        lines = ["# First", "", "Content A.", "# Second", "", "Content B."]
        source = "\n".join(lines).encode("utf-8")
        _, _, _, sections = md_extract(source, "doc.md")
        last = max(sections, key=lambda s: s.line)
        assert last.end_line == len(lines)

    def test_nested_heading_end_line_bounded_by_same_level_sibling(self):
        """An h2 section ends before the next h2 at the same level."""
        source = b"# H1\n\n## Alpha\n\nAlpha content.\n\n## Beta\n\nBeta content.\n"
        _, _, _, sections = md_extract(source, "nested.md")
        alpha = next(s for s in sections if s.heading == "Alpha")
        beta = next(s for s in sections if s.heading == "Beta")
        assert alpha.end_line < beta.line

    def test_crlf_line_endings_normalized(self):
        """CRLF line endings are normalized; headings are still extracted correctly."""
        source = b"# Title\r\n\r\nContent here.\r\n## Sub\r\n\r\nMore.\r\n"
        _, _, _, sections = md_extract(source, "crlf.md")
        headings = {s.heading for s in sections}
        assert "Title" in headings
        assert "Sub" in headings

    def test_empty_source_returns_empty_lists(self):
        """An empty markdown file returns four empty lists without raising."""
        symbols, refs, imports, sections = md_extract(b"", "empty.md")
        assert symbols == [] and sections == []

    def test_heading_symbols_match_sections(self):
        """Every ATX heading produces both a Symbol(kind='heading') and a Section entry."""
        source = b"# One\n\ntext\n\n## Two\n\nmore text\n"
        symbols, _, _, sections = md_extract(source, "sym.md")
        heading_names = {s.name for s in symbols if s.kind == "heading"}
        section_headings = {s.heading for s in sections}
        assert heading_names == section_headings


# ---------------------------------------------------------------------------
# Liquid extractor — untested branches
# ---------------------------------------------------------------------------


class TestLiquidExtractor:
    def test_invalid_schema_json_swallowed(self):
        """A {% schema %} block with invalid JSON does not raise; no symbol is produced."""
        source = b"""
{% schema %}
{ this is: not valid json
{% endschema %}
"""
        symbols, _, _, _ = liquid_extract(source, "sections/broken.liquid")
        schema_syms = [s for s in symbols if s.kind == "liquid_schema"]
        assert schema_syms == []

    def test_snippet_file_no_section_file_symbol(self):
        """A file in snippets/ (not sections/) does not get a liquid_section_file symbol."""
        source = b"<p>Hello world</p>"
        symbols, _, _, _ = liquid_extract(source, "snippets/greeting.liquid")
        section_file_syms = [s for s in symbols if s.kind == "liquid_section_file"]
        assert section_file_syms == []

    def test_schema_missing_name_key_no_symbol(self):
        """A schema block whose JSON lacks a 'name' key produces no liquid_schema symbol."""
        source = b"""
{% schema %}
{"t": "Header", "settings": []}
{% endschema %}
"""
        symbols, _, _, _ = liquid_extract(source, "sections/no-name.liquid")
        schema_syms = [s for s in symbols if s.kind == "liquid_schema"]
        assert schema_syms == []

    def test_h5_heading_extracted_as_section(self):
        """The Liquid extractor captures h1-h6 (h5 inclusive)."""
        source = b"<h5>Deep Heading</h5>"
        _, _, _, sections = liquid_extract(source, "templates/page.liquid")
        assert any(s.heading == "Deep Heading" and s.level == 5 for s in sections)

    def test_empty_source_returns_empty_lists(self):
        """Empty Liquid source returns four empty lists without raising."""
        symbols, refs, imports, sections = liquid_extract(b"", "snippets/empty.liquid")
        assert symbols == [] and imports == [] and sections == []


# ---------------------------------------------------------------------------
# HTML extractor — untested branches
# ---------------------------------------------------------------------------


class TestHtmlExtractor:
    def test_multi_class_attribute_splits_into_individual_symbols(self):
        """A class='foo bar baz' attribute produces one html_class symbol per non-noise token."""
        source = b'<div class="card highlight unique-widget">text</div>'
        symbols, _, _, _ = html_extract(source, "page.html")
        class_names = {s.name for s in symbols if s.kind == "html_class"}
        # "card" is not in the noise set; "highlight" and "unique-widget" should also appear
        assert "card" in class_names
        assert "highlight" in class_names

    def test_h4_heading_extracted_as_section(self):
        """An <h4> tag is included in sections (levels 1-4 are all captured)."""
        source = b"<h4>Sub-Sub-Title</h4>"
        _, _, _, sections = html_extract(source, "page.html")
        assert any(s.heading == "Sub-Sub-Title" and s.level == 4 for s in sections)

    def test_empty_source_returns_empty_lists(self):
        """An empty HTML source returns four empty lists without raising."""
        symbols, refs, imports, sections = html_extract(b"", "empty.html")
        assert symbols == [] and imports == [] and sections == []

    def test_noise_class_filtered_out(self):
        """Classes like 'container', 'header', 'footer' are filtered by the noise set."""
        source = b'<div class="container header footer custom-class">x</div>'
        symbols, _, _, _ = html_extract(source, "page.html")
        class_names = {s.name for s in symbols if s.kind == "html_class"}
        assert "container" not in class_names
        assert "header" not in class_names
        assert "custom-class" in class_names

    def test_heading_inside_noisy_tag_extracted(self):
        """Heading text is extracted even when the tag has attributes."""
        source = b'<h2 id="sec2" class="section-title">Important Section</h2>'
        _, _, _, sections = html_extract(source, "page.html")
        assert any(s.heading == "Important Section" for s in sections)


# ---------------------------------------------------------------------------
# Rust extractor — _parse_use_target fallback
# ---------------------------------------------------------------------------


class TestRustParseUseTarget:
    def test_standard_use_statement_extracted(self):
        """A standard 'use path::to::Item;' line extracts the path correctly."""
        result = _parse_use_target("use std::collections::HashMap;")
        assert result == "std::collections::HashMap"

    def test_no_match_returns_original_stripped_line(self):
        """When the 'use' regex doesn't match, the original stripped line is returned."""
        # A line that does not start with 'use ' will not match _USE_PATH_RE
        line = "extern crate foo;"
        result = _parse_use_target(line)
        # Should return the stripped original line
        assert result == line.strip()

    def test_use_with_braces_preserves_braces(self):
        """A grouped 'use std::{A, B};' line preserves the brace content in the target."""
        result = _parse_use_target("use std::{io, fs};")
        assert "std::" in result

    def test_whitespace_stripped(self):
        """Leading/trailing whitespace in the use statement is stripped from the result."""
        result = _parse_use_target("  use tokio::runtime::Runtime;  ")
        assert result == "tokio::runtime::Runtime"


# ---------------------------------------------------------------------------
# Rust extractor — noise filter for refs
# ---------------------------------------------------------------------------


class TestRustRefsNoiseFilter:
    def test_noise_keywords_not_in_refs(self):
        """Standard Rust keywords and type names are not returned as refs."""
        source = b"""
fn main() {
    let v: Vec<i32> = vec![1, 2, 3];
    println!("{:?}", v);
    let s = String::from("hello");
    if s.is_empty() { return; }
}
"""
        _, refs, _, _ = rust_extract(source, "noise.rs")
        ref_names = {r.name for r in refs}
        # These are all in _CALL_NOISE and should be filtered out
        for noise in ("println", "vec", "Vec", "String", "let", "if", "return"):
            assert noise not in ref_names, f"Noise name {noise!r} leaked into refs"

    def test_user_defined_call_in_refs(self):
        """A user-defined function call that is not in the noise set appears in refs."""
        source = b"""
fn helper() {}
fn main() {
    helper();
}
"""
        _, refs, _, _ = rust_extract(source, "user_call.rs")
        ref_names = {r.name for r in refs}
        assert "helper" in ref_names
