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
