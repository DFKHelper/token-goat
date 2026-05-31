from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.csharp import extract

FIXTURE = Path(__file__).parent / "fixtures" / "csharp_sample" / "UserService.cs"


@pytest.fixture
def cs_source() -> bytes:
    return FIXTURE.read_bytes()


@pytest.fixture
def cs_extracted(cs_source: bytes):
    return extract(cs_source, "UserService.cs")


def test_returns_four_lists(cs_extracted):
    assert all(isinstance(lst, list) for lst in cs_extracted)


def test_interface_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    iface = next((s for s in symbols if s.name == "IUserService"), None)
    assert iface is not None
    assert iface.kind == "interface"


def test_class_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    cls = next((s for s in symbols if s.name == "UserService" and s.kind == "class"), None)
    assert cls is not None


def test_struct_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    st = next((s for s in symbols if s.name == "Point"), None)
    assert st is not None
    assert st.kind in ("type", "class")


def test_abstract_class_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    ab = next((s for s in symbols if s.name == "AbstractBase"), None)
    assert ab is not None
    assert ab.kind == "class"


def test_enum_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    en = next((s for s in symbols if s.name == "Status"), None)
    assert en is not None
    assert en.kind == "enum"


def test_interface_methods_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    names = {s.name for s in symbols if s.kind == "method"}
    assert "GetUser" in names
    assert "DeleteUser" in names


def test_constructor_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    ctors = [s for s in symbols if s.name == "UserService" and s.kind == "method"]
    assert ctors, "constructor should be extracted as a method"
    assert ctors[0].parent_name == "UserService"


def test_property_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    prop = next((s for s in symbols if s.name == "ServiceName"), None)
    assert prop is not None
    assert prop.kind == "var"
    assert prop.parent_name == "UserService"


def test_delegate_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    d = next((s for s in symbols if s.name == "UserChangedHandler"), None)
    assert d is not None
    assert d.kind == "interface"


def test_namespace_extracted(cs_extracted):
    symbols, _, _, _ = cs_extracted
    ns = next((s for s in symbols if s.name == "MyApp.Services"), None)
    assert ns is not None


def test_imports_extracted(cs_extracted):
    _, _, imp_exp, _ = cs_extracted
    targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "System" in targets
    assert "System.Collections.Generic" in targets
    assert "System.Threading.Tasks" in targets


def test_line_numbers_one_indexed(cs_extracted):
    symbols, _, _, _ = cs_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name!r} has zero-indexed line {s.line}"


def test_no_single_char_refs(cs_extracted):
    _, refs, _, _ = cs_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_empty_file_returns_empty():
    result = extract(b"", "empty.cs")
    for lst in result:
        assert isinstance(lst, list)
        assert lst == []


def test_invalid_source_returns_empty():
    result = extract(b"\xff\xfe garbage", "bad.cs")
    for lst in result:
        assert isinstance(lst, list)
