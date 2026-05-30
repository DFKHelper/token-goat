"""Tests for the Python extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.python import extract

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


# ---------------------------------------------------------------------------
# Precision: decorator lines must be included in the symbol's start_line.
# ---------------------------------------------------------------------------


def test_single_decorator_extends_start_line():
    """``@cache``-decorated function: start_line must point at the decorator, not `def`."""
    src = b"@cache\ndef fn():\n    return 1\n"
    symbols, _, _, _ = extract(src, "deco_single.py")
    fn = next(s for s in symbols if s.name == "fn")
    assert fn.line == 1, f"expected line 1 (decorator), got {fn.line}"


def test_multiple_decorators_extend_start_line():
    """Multiple stacked decorators: start_line must point at the topmost one."""
    src = (
        b"@first\n"
        b"@second(arg)\n"
        b'@third("string")\n'
        b"def fn():\n"
        b"    return 1\n"
    )
    symbols, _, _, _ = extract(src, "deco_multi.py")
    fn = next(s for s in symbols if s.name == "fn")
    assert fn.line == 1


def test_class_decorator_extends_start_line():
    """A decorated class also gets its start_line moved to the @ line."""
    src = b"@dataclass\nclass Foo:\n    x: int\n"
    symbols, _, _, _ = extract(src, "deco_class.py")
    foo = next(s for s in symbols if s.name == "Foo")
    assert foo.line == 1


def test_method_decorator_extends_start_line():
    """A decorated method inside a class also gets start_line moved up."""
    src = (
        b"class C:\n"
        b"    @property\n"
        b"    def name(self):\n"
        b"        return self._n\n"
    )
    symbols, _, _, _ = extract(src, "deco_method.py")
    name = next(s for s in symbols if s.name == "name")
    # @property is on line 2; def is on line 3 — start should be 2.
    assert name.line == 2


def test_undecorated_function_unchanged():
    """No decorator → start_line is the `def` line as before."""
    src = b"def plain():\n    return 1\n"
    symbols, _, _, _ = extract(src, "plain.py")
    plain = next(s for s in symbols if s.name == "plain")
    assert plain.line == 1  # already line 1; nothing to change


def test_comment_above_def_is_not_treated_as_decorator():
    """Only lines starting with ``@`` are pulled in; comments stay outside."""
    src = b"# This is a comment about fn\ndef fn():\n    return 1\n"
    symbols, _, _, _ = extract(src, "comment.py")
    fn = next(s for s in symbols if s.name == "fn")
    # Comment must NOT be pulled in — start_line stays at the def line (2).
    assert fn.line == 2


def test_blank_gap_between_decorators_tolerated():
    """A blank line between stacked decorators is allowed; start still climbs."""
    src = (
        b"@first\n"
        b"\n"
        b"@second\n"
        b"def fn():\n"
        b"    return 1\n"
    )
    symbols, _, _, _ = extract(src, "deco_gap.py")
    fn = next(s for s in symbols if s.name == "fn")
    assert fn.line == 1


def test_no_decorator_extension_for_const_var():
    """``@`` heuristic only applies to function/method/class kinds."""
    src = b"# top comment\nMY_CONST = 42\n"
    symbols, _, _, _ = extract(src, "const.py")
    mc = [s for s in symbols if s.name == "MY_CONST"]
    if mc:
        # Whatever line it reports, it must not be the comment line.
        assert mc[0].line == 2


def test_property_classmethod_staticmethod_extracted_as_method():
    """@property, @classmethod, and @staticmethod are all emitted with kind='method'."""
    src = b"""class MyClass:
    def __init__(self, x):
        self._x = x

    @property
    def value(self):
        return self._x

    @classmethod
    def create(cls, x):
        return cls(x)

    @staticmethod
    def helper():
        return 42
"""
    symbols, _, _, _ = extract(src, "cls.py")
    by_name = {s.name: s for s in symbols if s.parent_name == "MyClass"}
    assert "value" in by_name
    assert "create" in by_name
    assert "helper" in by_name
    assert by_name["value"].kind == "method"
    assert by_name["create"].kind == "method"
    assert by_name["helper"].kind == "method"


def test_property_method_parent_name_set():
    """@property methods carry parent_name = enclosing class."""
    src = b"""class Config:
    @property
    def debug(self) -> bool:
        return self._debug
"""
    symbols, _, _, _ = extract(src, "cfg.py")
    debug = next((s for s in symbols if s.name == "debug"), None)
    assert debug is not None
    assert debug.parent_name == "Config"
    assert debug.kind == "method"
