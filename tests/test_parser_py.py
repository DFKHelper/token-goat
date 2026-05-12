"""Tests for the Python extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from tokenwise.languages.python import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "py_sample"
APP_PY = FIXTURE_DIR / "app.py"


@pytest.fixture
def py_source() -> bytes:
    return APP_PY.read_bytes()


@pytest.fixture
def py_extracted(py_source):
    return extract(py_source, "app.py")


def test_extract_returns_three_lists(py_extracted):
    symbols, refs, imp_exp, _ = py_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_greet_function_extracted(py_extracted):
    symbols, _, _, _ = py_extracted
    names = {s.name for s in symbols}
    assert "greet" in names
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.kind == "function"
    assert greet.line >= 1


def test_userservice_class_extracted(py_extracted):
    symbols, _, _, _ = py_extracted
    names = {s.name for s in symbols}
    assert "UserService" in names
    svc = next(s for s in symbols if s.name == "UserService")
    assert svc.kind == "class"


def test_init_method_extracted(py_extracted):
    symbols, _, _, _ = py_extracted
    names = {s.name for s in symbols}
    assert "__init__" in names
    init = next(s for s in symbols if s.name == "__init__")
    assert init.kind == "method"
    assert init.parent_name == "UserService"


def test_hello_method_extracted(py_extracted):
    symbols, _, _, _ = py_extracted
    names = {s.name for s in symbols}
    assert "hello" in names
    hello = next(s for s in symbols if s.name == "hello")
    assert hello.kind == "method"
    assert hello.parent_name == "UserService"


def test_greet_has_signature(py_extracted):
    symbols, _, _, _ = py_extracted
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.signature is not None
    assert "greet" in greet.signature


def test_import_os_extracted(py_extracted):
    _, _, imp_exp, _ = py_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "os" in import_targets


def test_import_pathlib_extracted(py_extracted):
    _, _, imp_exp, _ = py_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    # from pathlib import Path -> pathlib.Path
    assert any("pathlib" in t for t in import_targets)


def test_refs_include_greet_call(py_extracted):
    _, refs, _, _ = py_extracted
    ref_names = {r.name for r in refs}
    assert "greet" in ref_names


def test_ref_has_line_and_context(py_extracted):
    _, refs, _, _ = py_extracted
    greet_refs = [r for r in refs if r.name == "greet"]
    assert len(greet_refs) > 0
    for r in greet_refs:
        assert r.line > 0
        assert r.context is not None


def test_no_single_char_refs(py_extracted):
    _, refs, _, _ = py_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(py_extracted):
    symbols, _, _, _ = py_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name} has 0-indexed line {s.line}"


def test_end_line_gte_start_line(py_extracted):
    symbols, _, _, _ = py_extracted
    for s in symbols:
        if s.end_line is not None:
            assert s.end_line >= s.line, f"{s.name}: end_line {s.end_line} < line {s.line}"


def test_class_end_line_spans_methods(py_extracted):
    symbols, _, _, _ = py_extracted
    svc = next(s for s in symbols if s.name == "UserService")
    assert svc.end_line is not None
    # Class must extend past the line where __init__ and hello are defined
    init = next(s for s in symbols if s.name == "__init__")
    assert svc.end_line >= init.line


def test_invalid_source_returns_empty():
    """Truncated/invalid source should return empty lists rather than raise."""
    result = extract(b"\xff\xfe garbage \x00\x01", "bad.py")
    for lst in result:
        assert isinstance(lst, list)
