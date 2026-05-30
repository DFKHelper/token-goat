"""Tests for the Go extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.go import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "go_sample"
MAIN_GO = FIXTURE_DIR / "main.go"


@pytest.fixture
def go_source() -> bytes:
    return MAIN_GO.read_bytes()


@pytest.fixture
def go_extracted(go_source):
    return extract(go_source, "main.go")


def test_extract_returns_three_lists(go_extracted):
    symbols, refs, imp_exp, _ = go_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_main_function_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "main" in names
    main = next(s for s in symbols if s.name == "main")
    assert main.kind == "function"


def test_newserver_function_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "NewServer" in names
    ns = next(s for s in symbols if s.name == "NewServer")
    assert ns.kind == "function"


def test_run_method_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Run" in names
    run = next(s for s in symbols if s.name == "Run")
    assert run.kind == "method"


def test_server_struct_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Server" in names
    server = next(s for s in symbols if s.name == "Server")
    assert server.kind == "type"


def test_handler_interface_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Handler" in names
    handler = next(s for s in symbols if s.name == "Handler")
    assert handler.kind == "interface"


def test_version_const_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "Version" in names
    version = next(s for s in symbols if s.name == "Version")
    assert version.kind == "const"


def test_defaultport_var_extracted(go_extracted):
    symbols, _, _, _ = go_extracted
    names = {s.name for s in symbols}
    assert "defaultPort" in names
    dp = next(s for s in symbols if s.name == "defaultPort")
    assert dp.kind == "var"


def test_imports_include_fmt(go_extracted):
    _, _, imp_exp, _ = go_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "fmt" in import_targets


def test_imports_include_errors(go_extracted):
    _, _, imp_exp, _ = go_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert "errors" in import_targets


def test_refs_include_newserver_call(go_extracted):
    _, refs, _, _ = go_extracted
    ref_names = {r.name for r in refs}
    assert "NewServer" in ref_names


def test_ref_has_line_and_context(go_extracted):
    _, refs, _, _ = go_extracted
    ns_refs = [r for r in refs if r.name == "NewServer"]
    assert len(ns_refs) > 0
    for r in ns_refs:
        assert r.line > 0
        assert r.context is not None


def test_function_has_signature(go_extracted):
    symbols, _, _, _ = go_extracted
    ns = next(s for s in symbols if s.name == "NewServer")
    assert ns.signature is not None
    assert "NewServer" in ns.signature


def test_method_has_signature(go_extracted):
    symbols, _, _, _ = go_extracted
    run = next(s for s in symbols if s.name == "Run")
    assert run.signature is not None
    assert "Run" in run.signature


def test_no_single_char_refs(go_extracted):
    _, refs, _, _ = go_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(go_extracted):
    symbols, _, _, _ = go_extracted
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
    symbols, _, _, _ = extract(src, "consts.go")
    names = {s.name for s in symbols if s.kind == "const"}
    assert "MaxConn" in names
    assert "Debug" in names
    assert "AppName" in names


def test_interface_method_extracted():
    """Methods inside a Go interface should be emitted as individual method symbols."""
    src = b"""package io

type Reader interface {
    Read(p []byte) (n int, err error)
}
"""
    symbols, _, _, _ = extract(src, "reader.go")
    names = {s.name for s in symbols}
    assert "Read" in names
    read = next(s for s in symbols if s.name == "Read")
    assert read.kind == "method"
    assert read.parent_name == "Reader"


def test_interface_method_parent_name_set():
    """Interface method symbols carry the enclosing interface name as parent_name."""
    src = b"""package net

type Conn interface {
    Read(b []byte) (n int, err error)
    Write(b []byte) (n int, err error)
    Close() error
}
"""
    symbols, _, _, _ = extract(src, "conn.go")
    method_syms = {s.name: s for s in symbols if s.kind == "method"}
    assert "Read" in method_syms
    assert "Write" in method_syms
    assert "Close" in method_syms
    assert method_syms["Read"].parent_name == "Conn"
    assert method_syms["Write"].parent_name == "Conn"
    assert method_syms["Close"].parent_name == "Conn"


def test_receiver_method_parent_name_set():
    """Receiver methods should have parent_name set to the receiver type."""
    src = b"""package main

type Server struct {
    Port int
}

func (s *Server) Run() error {
    return nil
}
"""
    symbols, _, _, _ = extract(src, "server.go")
    run = next((s for s in symbols if s.name == "Run"), None)
    assert run is not None
    assert run.kind == "method"
    assert run.parent_name == "Server"


def test_interface_method_line_numbers():
    """Interface method symbols should have accurate 1-indexed line numbers."""
    src = b"""package io

type Writer interface {
    Write(p []byte) (n int, err error)
}
"""
    symbols, _, _, _ = extract(src, "writer.go")
    write = next((s for s in symbols if s.name == "Write"), None)
    assert write is not None
    assert write.line == 4


def test_embedded_interface_not_extracted_as_method():
    """Embedded interface names inside an interface body are not emitted as methods."""
    src = b"""package io

type Reader interface {
    Read(p []byte) (n int, err error)
}

type ReadWriter interface {
    Reader
    Write(p []byte) (n int, err error)
}
"""
    symbols, _, _, _ = extract(src, "rw.go")
    method_names = {s.name for s in symbols if s.kind == "method" and s.parent_name == "ReadWriter"}
    assert "Write" in method_names
    assert "Reader" not in method_names


def test_handler_interface_method_in_fixture(go_extracted):
    """The fixture's Handler.Serve method should be extracted as a symbol."""
    symbols, _, _, _ = go_extracted
    serve = next((s for s in symbols if s.name == "Serve"), None)
    assert serve is not None
    assert serve.kind == "method"
    assert serve.parent_name == "Handler"


def test_run_method_has_receiver_parent(go_extracted):
    """The fixture's Server.Run receiver method should have parent_name='Server'."""
    symbols, _, _, _ = go_extracted
    run = next(s for s in symbols if s.name == "Run")
    assert run.parent_name == "Server"
