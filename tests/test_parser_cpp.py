from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.cpp import extract, extract_c

CPP_FIXTURE = Path(__file__).parent / "fixtures" / "cpp_sample" / "sample.cpp"
C_FIXTURE = Path(__file__).parent / "fixtures" / "cpp_sample" / "sample.c"


@pytest.fixture
def cpp_source() -> bytes:
    return CPP_FIXTURE.read_bytes()


@pytest.fixture
def c_source() -> bytes:
    return C_FIXTURE.read_bytes()


@pytest.fixture
def cpp_extracted(cpp_source: bytes):
    return extract(cpp_source, "sample.cpp")


@pytest.fixture
def c_extracted(c_source: bytes):
    return extract_c(c_source, "sample.c")


# --- C++ tests ---

def test_cpp_returns_four_lists(cpp_extracted):
    assert all(isinstance(lst, list) for lst in cpp_extracted)


def test_cpp_macro_uppercase_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    names = {s.name for s in symbols if s.kind == "const"}
    assert "MAX_SIZE" in names
    assert "MIN_VAL" in names


def test_cpp_macro_lowercase_excluded(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    names = {s.name for s in symbols}
    assert "debug_log" not in names


def test_cpp_struct_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    st = next((s for s in symbols if s.name == "Point" and s.kind == "type"), None)
    assert st is not None


def test_cpp_enum_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    en = next((s for s in symbols if s.name == "Color"), None)
    assert en is not None
    assert en.kind == "type"


def test_cpp_function_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    fn = next((s for s in symbols if s.name == "add" and s.kind == "function"), None)
    assert fn is not None


def test_cpp_static_function_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    fn = next((s for s in symbols if s.name == "helper" and s.kind == "function"), None)
    assert fn is not None


def test_cpp_class_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    cls = next((s for s in symbols if s.name == "Calculator"), None)
    assert cls is not None
    assert cls.kind in ("class", "type")


def test_cpp_namespace_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    ns = next((s for s in symbols if s.name == "MyNS"), None)
    assert ns is not None


def test_cpp_out_of_class_method(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    mth = next((s for s in symbols if s.name == "multiply" and s.kind == "method"), None)
    assert mth is not None
    assert mth.parent_name == "Calculator"


def test_cpp_extern_extracted(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    ext = next((s for s in symbols if s.name == "external_api"), None)
    assert ext is not None
    assert ext.kind == "function"


def test_cpp_includes_extracted(cpp_extracted):
    _, _, imp_exp, _ = cpp_extracted
    targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "stdio.h" in targets
    assert "vector" in targets


def test_cpp_line_numbers_one_indexed(cpp_extracted):
    symbols, _, _, _ = cpp_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name!r} has line {s.line}"


def test_cpp_no_single_char_refs(cpp_extracted):
    _, refs, _, _ = cpp_extracted
    for r in refs:
        assert len(r.name) > 1


# --- C tests ---

def test_c_returns_four_lists(c_extracted):
    assert all(isinstance(lst, list) for lst in c_extracted)


def test_c_macro_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    names = {s.name for s in symbols if s.kind == "const"}
    assert "BUFFER_SIZE" in names
    assert "MAX_RETRIES" in names


def test_c_typedef_struct_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    st = next((s for s in symbols if s.name == "Vector2"), None)
    assert st is not None
    assert st.kind == "type"


def test_c_struct_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    st = next((s for s in symbols if s.name == "Queue"), None)
    assert st is not None


def test_c_enum_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    en = next((s for s in symbols if s.name == "Direction"), None)
    assert en is not None
    assert en.kind == "type"


def test_c_function_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    names = {s.name for s in symbols if s.kind == "function"}
    assert "add" in names
    assert "process" in names


def test_c_static_function_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    fn = next((s for s in symbols if s.name == "compare"), None)
    assert fn is not None


def test_c_extern_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    ext = next((s for s in symbols if s.name == "platform_init"), None)
    assert ext is not None


def test_c_includes_extracted(c_extracted):
    _, _, imp_exp, _ = c_extracted
    targets = {ie.target for ie in imp_exp}
    assert "stdio.h" in targets
    assert "stdlib.h" in targets


def test_c_no_class_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    classes = [s for s in symbols if s.kind == "class"]
    assert len(classes) == 0


def test_c_no_namespace_extracted(c_extracted):
    symbols, _, _, _ = c_extracted
    ns = [s for s in symbols if s.name == "namespace"]
    assert len(ns) == 0


def test_empty_file_cpp():
    result = extract(b"", "empty.cpp")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []


def test_empty_file_c():
    result = extract_c(b"", "empty.c")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []


def test_invalid_source_cpp():
    result = extract(b"\xff\xfe garbage", "bad.cpp")
    for lst in result:
        assert isinstance(lst, list)
