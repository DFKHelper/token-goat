"""Tests for the HTML extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.html import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "html_sample"
ARTICLE_HTML = FIXTURE_DIR / "article.html"


@pytest.fixture
def html_source() -> bytes:
    return ARTICLE_HTML.read_bytes()


@pytest.fixture
def html_extracted(html_source):
    return extract(html_source, "article.html")


def test_extract_returns_four_lists(html_extracted):
    symbols, refs, imports, sections = html_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imports, list)
    assert isinstance(sections, list)


def test_h1_heading_extracted(html_extracted):
    _, _, _, sections = html_extracted
    headings = {s.heading for s in sections}
    assert "Main Heading" in headings


def test_h2_section_one_extracted(html_extracted):
    _, _, _, sections = html_extracted
    headings = {s.heading for s in sections}
    assert "Section One" in headings


def test_h2_section_two_extracted(html_extracted):
    _, _, _, sections = html_extracted
    headings = {s.heading for s in sections}
    assert "Section Two" in headings


def test_id_attribute_extracted(html_extracted):
    symbols, _, _, _ = html_extracted
    names = {s.name for s in symbols if s.kind == "html_id"}
    assert "masthead" in names
    masthead = next(s for s in symbols if s.name == "masthead")
    assert masthead.kind == "html_id"


def test_class_attribute_extracted(html_extracted):
    symbols, _, _, _ = html_extracted
    names = {s.name for s in symbols if s.kind == "html_class"}
    assert "article-body" in names


def test_link_import_extracted(html_extracted):
    _, _, imports, _ = html_extracted
    targets = {imp.target for imp in imports}
    assert "/style.css" in targets
    link = next(i for i in imports if i.target == "/style.css")
    assert link.kind == "html_link"


def test_script_import_extracted(html_extracted):
    _, _, imports, _ = html_extracted
    targets = {imp.target for imp in imports}
    assert "/main.js" in targets
    script = next(i for i in imports if i.target == "/main.js")
    assert script.kind == "html_script"


def test_noise_filter_skips_common_ids(html_extracted):
    symbols, _, _, _ = html_extracted
    names = {s.name for s in symbols if s.kind == "html_id"}
    # Common classes like "container", "main" should be filtered
    assert "container" not in names
    assert "main" not in names


# ---------------------------------------------------------------------------
# H1-H6 coverage and anchor-id-aware heading sections
# ---------------------------------------------------------------------------


def test_h5_and_h6_headings_extracted():
    """`<h5>` and `<h6>` were dropped under the prior `[1-4]` cap."""
    src = (
        b"<html><body>\n"
        b"<h5>Deep Heading 5</h5>\n"
        b"<h6>Deepest Heading 6</h6>\n"
        b"</body></html>\n"
    )
    _, _, _, sections = extract(src, "deep.html")
    headings = {s.heading for s in sections}
    assert "Deep Heading 5" in headings
    assert "Deepest Heading 6" in headings
    h5 = next(s for s in sections if s.heading == "Deep Heading 5")
    h6 = next(s for s in sections if s.heading == "Deepest Heading 6")
    assert h5.level == 5
    assert h6.level == 6


def test_heading_with_anchor_id_extracted_under_both_keys():
    """`<h2 id="install">Install</h2>` is reachable by text *and* by anchor id."""
    src = (
        b"<html><body>\n"
        b'<h2 id="install">Install</h2>\n'
        b"<p>Run pip.</p>\n"
        b"</body></html>\n"
    )
    _, _, _, sections = extract(src, "anchor.html")
    headings = {s.heading for s in sections}
    assert "Install" in headings
    assert "install" in headings


def test_heading_with_inline_tags_strips_them():
    """`<h2><a href="...">Title</a></h2>` must yield heading text "Title"."""
    src = (
        b"<html><body>\n"
        b'<h2><a href="#x">My Title</a></h2>\n'
        b"</body></html>\n"
    )
    _, _, _, sections = extract(src, "inner.html")
    assert any(s.heading == "My Title" for s in sections)


def test_heading_spanning_multiple_lines_collapsed():
    """A heading whose inner text spans multiple lines must be a single space-joined token."""
    src = b"<html><body>\n<h2>\n  Wrapped\n  Title\n</h2>\n</body></html>\n"
    _, _, _, sections = extract(src, "wrap.html")
    assert any(s.heading == "Wrapped Title" for s in sections)
