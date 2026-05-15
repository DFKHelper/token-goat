"""Tests for the Liquid extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.liquid import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "liquid_sample"
HEADER_LIQUID = FIXTURE_DIR / "sections" / "header.liquid"
SOCIAL_LIQUID = FIXTURE_DIR / "snippets" / "social-icons.liquid"


@pytest.fixture
def header_source() -> bytes:
    return HEADER_LIQUID.read_bytes()


@pytest.fixture
def header_extracted(header_source):
    return extract(header_source, "sections/header.liquid")


def test_extract_returns_four_lists(header_extracted):
    symbols, refs, imports, sections = header_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imports, list)
    assert isinstance(sections, list)


def test_schema_symbol_extracted(header_extracted):
    symbols, _, _, _ = header_extracted
    names = {s.name for s in symbols}
    assert "Header" in names
    header_sym = next(s for s in symbols if s.name == "Header")
    assert header_sym.kind == "liquid_schema"
    assert header_sym.line >= 1


def test_section_file_symbol(header_extracted):
    symbols, _, _, _ = header_extracted
    names = {s.name for s in symbols}
    assert "header" in names
    header_file = next(s for s in symbols if s.name == "header")
    assert header_file.kind == "liquid_section_file"


def test_include_import_extracted(header_extracted):
    _, _, imports, _ = header_extracted
    targets = {imp.target for imp in imports}
    assert "social-icons" in targets
    include_imp = next(i for i in imports if i.target == "social-icons")
    assert include_imp.kind == "liquid_include"


def test_section_import_extracted(header_extracted):
    _, _, imports, _ = header_extracted
    targets = {imp.target for imp in imports}
    assert "navigation" in targets
    section_imp = next(i for i in imports if i.target == "navigation")
    assert section_imp.kind == "liquid_section"


def test_h1_section_extracted(header_extracted):
    _, _, _, sections = header_extracted
    headings = {s.heading for s in sections}
    # The h1 content is "{{ shop.name }}"
    assert any("shop.name" in h or "{{" in h for h in headings)


def test_social_render_import():
    source = SOCIAL_LIQUID.read_bytes()
    _, _, imports, _ = extract(source, "snippets/social-icons.liquid")
    targets = {imp.target for imp in imports}
    assert "icon" in targets
    render_imp = next(i for i in imports if i.target == "icon")
    assert render_imp.kind == "liquid_render"
