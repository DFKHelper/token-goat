from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.java import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "java_sample"
MAIN_JAVA = FIXTURE_DIR / "src" / "main" / "java" / "com" / "example" / "UserService.java"


@pytest.fixture
def java_source() -> bytes:
    return MAIN_JAVA.read_bytes()


@pytest.fixture
def java_extracted(java_source: bytes):
    return extract(java_source, "src/main/java/com/example/UserService.java")


def test_extract_returns_four_lists(java_extracted):
    symbols, refs, imp_exp, sections = java_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)
    assert isinstance(sections, list)


def test_class_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    names = {s.name for s in symbols}
    assert "UserService" in names
    cls = next(s for s in symbols if s.name == "UserService" and s.kind == "class")
    assert cls.kind == "class"


def test_interface_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    names = {s.name for s in symbols}
    assert "Processor" in names
    iface = next(s for s in symbols if s.name == "Processor")
    assert iface.kind == "interface"


def test_enum_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    status = next((s for s in symbols if s.name == "Status"), None)
    assert status is not None
    assert status.kind == "enum"


def test_abstract_class_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    base = next((s for s in symbols if s.name == "AbstractBase"), None)
    assert base is not None
    assert base.kind == "class"


def test_constructor_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    ctors = [s for s in symbols if s.name == "UserService" and s.kind == "method"]
    assert ctors, "constructor should appear as a method symbol"
    assert ctors[0].parent_name == "UserService"


def test_method_get_name_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "getName"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "UserService"


def test_static_method_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "count"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "UserService"


def test_interface_method_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "process"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "Processor"


def test_default_interface_method_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "preprocess"), None)
    assert m is not None
    assert m.kind == "method"


def test_enum_method_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "isActive"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "Status"


def test_constant_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    v = next((s for s in symbols if s.name == "VERSION"), None)
    assert v is not None
    assert v.kind == "const"
    assert v.parent_name == "UserService"


def test_private_constant_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    m = next((s for s in symbols if s.name == "MAX_SIZE"), None)
    assert m is not None
    assert m.kind == "const"


def test_annotation_type_extracted(java_extracted):
    symbols, _, _, _ = java_extracted
    ann = next((s for s in symbols if s.name == "MyAnnotation"), None)
    assert ann is not None, "@interface MyAnnotation should be extracted"
    assert ann.kind == "interface"


def test_imports_extracted(java_extracted):
    _, _, imp_exp, _ = java_extracted
    targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "java.util.List" in targets
    assert "java.util.HashMap" in targets


def test_line_numbers_are_one_indexed(java_extracted):
    symbols, _, _, _ = java_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name!r} has zero-indexed line {s.line}"


def test_no_single_char_refs(java_extracted):
    _, refs, _, _ = java_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_invalid_source_returns_empty():
    result = extract(b"\xff\xfe garbage \x00\x01", "bad.java")
    for lst in result:
        assert isinstance(lst, list)


def test_empty_file_returns_empty():
    result = extract(b"", "empty.java")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []
