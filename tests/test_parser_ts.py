"""Tests for the TypeScript extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.typescript import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "ts_sample"
INDEX_TS = FIXTURE_DIR / "index.ts"


@pytest.fixture
def ts_source() -> bytes:
    return INDEX_TS.read_bytes()


@pytest.fixture
def ts_extracted(ts_source):
    return extract(ts_source, "index.ts")


def test_extract_returns_three_lists(ts_extracted):
    symbols, refs, imp_exp, _ = ts_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_greet_function_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "greet" in names
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.kind == "function"
    assert greet.line == 4


def test_userservice_class_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "UserService" in names
    svc = next(s for s in symbols if s.name == "UserService")
    assert svc.kind == "class"


def test_hello_method_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "hello" in names
    hello = next(s for s in symbols if s.name == "hello")
    assert hello.kind == "method"
    assert hello.parent_name == "UserService"


def test_user_interface_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "User" in names
    user = next(s for s in symbols if s.name == "User")
    assert user.kind == "interface"


def test_userid_type_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "UserId" in names
    uid = next(s for s in symbols if s.name == "UserId")
    assert uid.kind == "type"


def test_router_const_extracted(ts_extracted):
    symbols, _, _, _ = ts_extracted
    names = {s.name for s in symbols}
    assert "router" in names
    router = next(s for s in symbols if s.name == "router")
    assert router.kind == "const"


def test_greet_has_signature(ts_extracted):
    symbols, _, _, _ = ts_extracted
    greet = next(s for s in symbols if s.name == "greet")
    assert greet.signature is not None
    assert "greet" in greet.signature
    assert "name" in greet.signature


def test_imports_include_node_path(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "node:path" in import_targets


def test_imports_include_express(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "express" in import_targets


def test_exports_include_greet(ts_extracted):
    _, _, imp_exp, _ = ts_extracted
    export_targets = {ie.target for ie in imp_exp if ie.kind == "export"}
    assert "greet" in export_targets


def test_refs_include_greet_call(ts_extracted):
    _, refs, _, _ = ts_extracted
    ref_names = {r.name for r in refs}
    # greet is called inside hello()
    assert "greet" in ref_names


def test_refs_include_express_call(ts_extracted):
    _, refs, _, _ = ts_extracted
    ref_names = {r.name for r in refs}
    assert "express" in ref_names


def test_ref_has_line_and_context(ts_extracted):
    _, refs, _, _ = ts_extracted
    greet_refs = [r for r in refs if r.name == "greet"]
    assert len(greet_refs) > 0
    for r in greet_refs:
        assert r.line > 0
        assert r.context is not None


def test_no_single_char_refs(ts_extracted):
    _, refs, _, _ = ts_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(ts_extracted):
    symbols, _, _, _ = ts_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name} has 0-indexed line {s.line}"


def test_tsx_extension_accepted():
    """tsx files should parse without error."""
    source = b"export const Comp = () => <div>hello</div>;\n"
    symbols, refs, imp_exp, _ = extract(source, "comp.tsx")
    assert isinstance(symbols, list)


def test_js_extension_accepted():
    """Plain .js files should parse."""
    source = b"export function foo() { return 1; }\n"
    symbols, refs, imp_exp, _ = extract(source, "util.js")
    names = {s.name for s in symbols}
    assert "foo" in names
