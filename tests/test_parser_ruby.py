from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.ruby import extract

FIXTURE = Path(__file__).parent / "fixtures" / "ruby_sample" / "animal.rb"


@pytest.fixture
def rb_source() -> bytes:
    return FIXTURE.read_bytes()


@pytest.fixture
def rb_extracted(rb_source: bytes):
    return extract(rb_source, "animal.rb")


def test_returns_four_lists(rb_extracted):
    assert all(isinstance(lst, list) for lst in rb_extracted)


def test_module_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    mod = next((s for s in symbols if s.name == "Animals"), None)
    assert mod is not None
    assert mod.kind == "const"


def test_class_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    cls = next((s for s in symbols if s.name == "Animal" and s.kind == "class"), None)
    assert cls is not None


def test_subclass_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    cls = next((s for s in symbols if s.name == "Dog" and s.kind == "class"), None)
    assert cls is not None


def test_instance_method_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    names = {s.name for s in symbols if s.kind == "method"}
    assert "speak" in names
    assert "bark" in names
    assert "initialize" in names


def test_class_method_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    mth = next((s for s in symbols if s.name == "create"), None)
    assert mth is not None
    assert mth.kind == "method"
    assert mth.parent_name == "Animal"


def test_method_parent_name(rb_extracted):
    symbols, _, _, _ = rb_extracted
    speak = next((s for s in symbols if s.name == "speak"), None)
    assert speak is not None
    assert speak.parent_name == "Animal"


def test_constant_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    names = {s.name for s in symbols if s.kind == "const"}
    assert "KINGDOM" in names
    assert "MAX_AGE" in names


def test_struct_new_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    pt = next((s for s in symbols if s.name == "Point"), None)
    assert pt is not None
    assert pt.kind == "type"


def test_attr_reader_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    attr_names = {s.name for s in symbols if s.kind == "var"}
    assert "name" in attr_names
    assert "age" in attr_names


def test_attr_accessor_extracted(rb_extracted):
    symbols, _, _, _ = rb_extracted
    attr_names = {s.name for s in symbols if s.kind == "var"}
    assert "status" in attr_names


def test_imports_extracted(rb_extracted):
    _, _, imp_exp, _ = rb_extracted
    targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "json" in targets
    assert "../lib/utils" in targets


def test_line_numbers_one_indexed(rb_extracted):
    symbols, _, _, _ = rb_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name!r} has line {s.line}"


def test_no_single_char_refs(rb_extracted):
    _, refs, _, _ = rb_extracted
    for r in refs:
        assert len(r.name) > 1


def test_empty_file():
    result = extract(b"", "empty.rb")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []


def test_invalid_source():
    result = extract(b"\xff\xfe garbage", "bad.rb")
    for lst in result:
        assert isinstance(lst, list)
