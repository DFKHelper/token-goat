"""Tests for the Markdown extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.markdown import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "md_sample"
ARTICLE_MD = FIXTURE_DIR / "article.md"


@pytest.fixture
def md_source() -> bytes:
    return ARTICLE_MD.read_bytes()


@pytest.fixture
def md_extracted(md_source):
    return extract(md_source, "article.md")


def test_extract_returns_four_lists(md_extracted):
    symbols, refs, imports, sections = md_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imports, list)
    assert isinstance(sections, list)


def test_frontmatter_title_extracted(md_extracted):
    symbols, _, _, _ = md_extracted
    names = {s.name for s in symbols}
    assert "Test Article" in names
    title_sym = next(s for s in symbols if s.name == "Test Article")
    assert title_sym.kind == "md_title"


def test_h1_heading_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Top Level" in headings


def test_h2_methodology_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Methodology" in headings


def test_h3_subsection_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Subsection" in headings


def test_h2_results_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Results" in headings


def test_heading_symbols_created(md_extracted):
    symbols, _, _, _ = md_extracted
    heading_symbols = [s for s in symbols if s.kind == "heading"]
    assert len(heading_symbols) >= 3


def test_methodology_end_line_computed(md_extracted):
    _, _, _, sections = md_extracted
    methodology = next(s for s in sections if s.heading == "Methodology")
    # Results heading comes after, so end_line should be before Results
    results = next(s for s in sections if s.heading == "Results")
    assert methodology.end_line < results.line


# ---------------------------------------------------------------------------
# Precision improvements: fenced-code heading skip + trailing-blank trim
# ---------------------------------------------------------------------------


def test_fenced_atx_heading_is_not_indexed_as_heading():
    """ATX-looking lines inside ``` fences must not be promoted to sections.

    Without this, a code-block comment ``# Not a heading`` shadows the real
    heading lookup and corrupts the preceding section's end_line.
    """
    src = (
        b"# Real Heading\n"
        b"\n"
        b"Intro.\n"
        b"\n"
        b"```python\n"
        b"# This is a comment, not a heading\n"
        b"## Also not a heading\n"
        b"def foo():\n"
        b"    pass\n"
        b"```\n"
        b"\n"
        b"## Real Subsection\n"
        b"\n"
        b"Content.\n"
    )
    _, _, _, sections = extract(src, "fenced.md")
    headings = {s.heading for s in sections}
    assert "Real Heading" in headings
    assert "Real Subsection" in headings
    # The two in-fence lines must be excluded.
    assert "This is a comment, not a heading" not in headings
    assert "Also not a heading" not in headings


def test_fenced_atx_heading_does_not_truncate_outer_section():
    """The end_line of an outer section must extend past fenced code blocks."""
    src = (
        b"# Outer\n"
        b"\n"
        b"intro\n"
        b"\n"
        b"```\n"
        b"## Fake H2\n"
        b"```\n"
        b"\n"
        b"more text\n"
        b"\n"
        b"# Next Top\n"
    )
    _, _, _, sections = extract(src, "fenced2.md")
    outer = next(s for s in sections if s.heading == "Outer")
    next_top = next(s for s in sections if s.heading == "Next Top")
    # Outer must extend to at least line 9 ("more text"), not stop at line 6.
    assert outer.end_line is not None
    assert outer.end_line >= 9
    assert outer.end_line < next_top.line


def test_tilde_fenced_code_block_also_skipped():
    """``~~~`` fences must be honoured just like backtick fences."""
    src = (
        b"# Real\n"
        b"\n"
        b"~~~\n"
        b"## Fake In Tilde\n"
        b"~~~\n"
        b"\n"
        b"## Real Sub\n"
    )
    _, _, _, sections = extract(src, "tilde.md")
    headings = {s.heading for s in sections}
    assert "Fake In Tilde" not in headings
    assert "Real Sub" in headings


def test_section_end_line_trims_trailing_blank_lines():
    """End_line should not include trailing blank lines before the next equal-level heading.

    Every trailing blank line returned by read_section is a wasted token in the
    LLM context window.
    """
    src = (
        b"## A\n"
        b"\n"
        b"Aaa.\n"
        b"\n"
        b"\n"
        b"\n"
        b"## B\n"
        b"\n"
        b"Bbb.\n"
    )
    _, _, _, sections = extract(src, "trim.md")
    a = next(s for s in sections if s.heading == "A")
    # Section A is heading on line 1, content "Aaa." on line 3, blanks 4-6, B on line 7.
    # end_line must be 3 (last non-blank content line), not 6 (last blank before B).
    assert a.end_line == 3


def test_trim_preserves_heading_only_section():
    """A heading with no body should still have end_line == heading line."""
    # Use sibling-level headings so the section terminates at the next one.
    src = b"## Only heading\n\n\n## Next\n"
    _, _, _, sections = extract(src, "only.md")
    only = next(s for s in sections if s.heading == "Only heading")
    # No body — end_line must still be at the heading line, never lower.
    assert only.end_line == 1


def test_trim_does_not_apply_when_section_contains_nested_subheading():
    """A level-1 section that contains level-2 children must extend through them.

    This is a sanity check: trim must NOT eat the section's body just because
    blank padding sits between the heading and a child heading.
    """
    src = (
        b"# Outer\n"
        b"\n"
        b"Outer intro.\n"
        b"\n"
        b"## Inner\n"
        b"\n"
        b"Inner body.\n"
    )
    _, _, _, sections = extract(src, "nested.md")
    outer = next(s for s in sections if s.heading == "Outer")
    inner = next(s for s in sections if s.heading == "Inner")
    # Outer wraps Inner, so it ends at the last non-blank line of Inner (7).
    assert outer.end_line is not None and outer.end_line >= inner.line
    # Inner has body "Inner body." on line 7 → end_line should be exactly 7.
    assert inner.end_line == 7


def test_fenced_skip_does_not_drop_heading_with_hash_before_fence():
    """Sanity: a real `# Heading` line that happens to immediately precede a
    fenced block must still be indexed."""
    src = (
        b"# Heading Before Fence\n"
        b"```\n"
        b"# fake\n"
        b"```\n"
    )
    _, _, _, sections = extract(src, "before.md")
    headings = {s.heading for s in sections}
    assert "Heading Before Fence" in headings
    assert "fake" not in headings
