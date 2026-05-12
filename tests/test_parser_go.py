"""Tests for the Go extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from cc_saver.languages.go import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "go_sample"
MAIN_GO = FIXTURE_DIR / "main.go"


@pytest.fixture
def go_source() -> bytes:
    return MAIN_GO.read_bytes()


@pytest.fixture
def go_extracted(go_source):
    return extract(go_source, "main.go")


def test_extract_returns_three_lists(go_extracted):
    symbols, refs, imp_exp = go_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_main_function_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "main" in names
    main = next(s for s in symbols if s.name == "main")
    assert main.kind == "function"


def test_newserver_function_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "NewServer" in names
    ns = next(s for s in symbols if s.name == "NewServer")
    assert ns.kind == "function"


def test_run_method_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Run" in names
    run = next(s for s in symbols if s.name == "Run")
    assert run.kind == "method"


def test_server_struct_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Server" in names
    server = next(s for s in symbols if s.name == "Server")
    assert server.kind == "type"


def test_handler_interface_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Handler" in names
    handler = next(s for s in symbols if s.name == "Handler")
    assert handler.kind == "interface"


def test_version_const_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Version" in names
    version = next(s for s in symbols if s.name == "Version")
    assert version.kind == "const"


def test_defaultport_var_extracted(go_extracted):
    symbols, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "defaultPort" in names
    dp = next(s for s in symbols if s.name == "defaultPort")
    assert dp.kind == "var"


def test_imports_include_fmt(go_extracted):
    _, _, imp_exp = go_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "fmt" in import_targets


def test_imports_include_errors(go_extracted):
    _, _, imp_exp = go_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "errors" in import_targets


def test_refs_include_newserver_call(go_extracted):
    _, refs, _ = go_extracted
    ref_names = {r.name for r in refs}
    assert "NewServer" in ref_names


def test_ref_has_line_and_context(go_extracted):
    _, refs, _ = go_extracted
    ns_refs = [r for r in refs if r.name == "NewServer"]
    assert len(ns_refs) > 0
    for r in ns_refs:
        assert r.line > 0
        assert r.context is not None


def test_function_has_signature(go_extracted):
    symbols, _, _ = go_extracted
    ns = next(s for s in symbols if s.name == "NewServer")
    assert ns.signature is not None
    assert "NewServer" in ns.signature


def test_method_has_signature(go_extracted):
    symbols, _, _ = go_extracted
    run = next(s for s in symbols if s.name == "Run")
    assert run.signature is not None
    assert "Run" in run.signature


def test_no_single_char_refs(go_extracted):
    _, refs, _ = go_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(go_extracted):
    symbols, _, _ = go_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name} has zero-indexed line {s.line}"


def test_invalid_source_returns_empty():
    result = extract(b"\xff\xfe garbage \x00\x01", "bad.go")
    for lst in result:
        assert isinstance(lst, list)


def test_const_block_extraction():
    """Multiple names in a const () block should each be a separate symbol."""
    src = b"""package main

const (
    MaxConn = 10
    Debug = false
    AppName = "myapp"
)
"""
    symbols, _, _ = extract(src, "consts.go")
    names = {s.name for s in symbols if s.kind == "const"}
    assert "MaxConn" in names
    assert "Debug" in names
    assert "AppName" in names
