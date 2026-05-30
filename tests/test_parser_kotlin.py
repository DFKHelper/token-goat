from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.kotlin import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "kotlin_sample"
MAIN_KT = FIXTURE_DIR / "src" / "main" / "kotlin" / "com" / "example" / "UserService.kt"


@pytest.fixture
def kotlin_source() -> bytes:
    return MAIN_KT.read_bytes()


@pytest.fixture
def kotlin_extracted(kotlin_source: bytes):
    return extract(kotlin_source, "src/main/kotlin/com/example/UserService.kt")


def test_extract_returns_four_lists(kotlin_extracted):
    symbols, refs, imp_exp, sections = kotlin_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)
    assert isinstance(sections, list)


def test_class_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    cls = next((s for s in symbols if s.name == "UserService" and s.kind == "class"), None)
    assert cls is not None


def test_interface_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    iface = next((s for s in symbols if s.name == "Processor"), None)
    assert iface is not None
    assert iface.kind == "class"


def test_enum_class_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    status = next((s for s in symbols if s.name == "Status"), None)
    assert status is not None
    assert status.kind == "class"


def test_object_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    obj = next((s for s in symbols if s.name == "Singleton"), None)
    assert obj is not None
    assert obj.kind == "class"


def test_data_class_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    user = next((s for s in symbols if s.name == "User"), None)
    assert user is not None
    assert user.kind == "class"


def test_method_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    m = next((s for s in symbols if s.name == "getName"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "UserService"


def test_private_method_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    m = next((s for s in symbols if s.name == "count"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "UserService"


def test_interface_method_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    m = next((s for s in symbols if s.name == "process"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "Processor"


def test_enum_method_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    m = next((s for s in symbols if s.name == "isActive"), None)
    assert m is not None
    assert m.kind == "method"
    assert m.parent_name == "Status"


def test_companion_const_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    v = next((s for s in symbols if s.name == "VERSION"), None)
    assert v is not None
    assert v.kind == "const"
    assert v.parent_name == "UserService"


def test_top_level_function_extracted(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    fn = next((s for s in symbols if s.name == "topLevelFn"), None)
    assert fn is not None
    assert fn.kind == "function"
    assert fn.parent_name is None


def test_imports_extracted(kotlin_extracted):
    _, _, imp_exp, _ = kotlin_extracted
    targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "java.util.List" in targets
    assert "java.util.HashMap" in targets


def test_line_numbers_are_one_indexed(kotlin_extracted):
    symbols, _, _, _ = kotlin_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name!r} has zero-indexed line {s.line}"


def test_no_single_char_refs(kotlin_extracted):
    _, refs, _, _ = kotlin_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_invalid_source_returns_empty():
    result = extract(b"\xff\xfe garbage \x00\x01", "bad.kt")
    for lst in result:
        assert isinstance(lst, list)


def test_empty_file_returns_empty():
    result = extract(b"", "empty.kt")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []
