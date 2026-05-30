"""Tests for the Rust extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.rust import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "rust_sample"
MAIN_RS = FIXTURE_DIR / "src" / "main.rs"


@pytest.fixture
def rust_source() -> bytes:
    return MAIN_RS.read_bytes()


@pytest.fixture
def rust_extracted(rust_source):
    return extract(rust_source, "src/main.rs")


def test_extract_returns_three_lists(rust_extracted):
    symbols, refs, imp_exp, _ = rust_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imp_exp, list)


def test_main_function_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "main" in names
    main = next(s for s in symbols if s.name == "main")
    assert main.kind == "function"


def test_server_struct_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "Server" in names
    server = next(s for s in symbols if s.name == "Server" and s.kind == "type")
    assert server.kind == "type"


def test_handler_trait_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "Handler" in names
    handler = next(s for s in symbols if s.name == "Handler")
    assert handler.kind == "interface"


def test_error_enum_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "Error" in names
    error = next(s for s in symbols if s.name == "Error" and s.kind == "enum")
    assert error.kind == "enum"


def test_new_method_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "new" in names
    new = next(s for s in symbols if s.name == "new")
    assert new.kind == "method"
    assert new.parent_name == "Server"


def test_run_method_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "run" in names
    run = next(s for s in symbols if s.name == "run")
    assert run.kind == "method"
    assert run.parent_name == "Server"


def test_version_const_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    names = {s.name for s in symbols}
    assert "VERSION" in names
    v = next(s for s in symbols if s.name == "VERSION")
    assert v.kind == "const"


def test_imports_include_hashmap(rust_extracted):
    _, _, imp_exp, _ = rust_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert any("HashMap" in t for t in import_targets)


def test_imports_include_fmt(rust_extracted):
    _, _, imp_exp, _ = rust_extracted
    import_targets = {ie.target for ie in imp_exp if ie.kind == "import"}
    assert any("fmt" in t for t in import_targets)


def test_method_has_signature(rust_extracted):
    symbols, _, _, _ = rust_extracted
    new = next(s for s in symbols if s.name == "new" and s.kind == "method")
    assert new.signature is not None
    assert "fn new" in new.signature


def test_no_single_char_refs(rust_extracted):
    _, refs, _, _ = rust_extracted
    for r in refs:
        assert len(r.name) > 1, f"single-char ref {r.name!r} should be filtered"


def test_line_numbers_are_one_indexed(rust_extracted):
    symbols, _, _, _ = rust_extracted
    for s in symbols:
        assert s.line >= 1, f"symbol {s.name} has zero-indexed line {s.line}"


def test_impl_block_recorded(rust_extracted):
    """The impl Server block should produce an 'impl' symbol."""
    symbols, _, _, _ = rust_extracted
    impl_syms = [s for s in symbols if s.kind == "impl"]
    assert len(impl_syms) >= 1
    assert any(s.name == "Server" for s in impl_syms)


def test_trait_method_serve_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    serve = [s for s in symbols if s.name == "serve"]
    assert serve, "trait method 'serve' should be extracted"
    assert serve[0].kind == "method"
    assert serve[0].parent_name == "Handler"


def test_trait_method_preflight_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    preflight = [s for s in symbols if s.name == "preflight"]
    assert preflight, "async trait method 'preflight' should be extracted"
    assert preflight[0].kind == "method"
    assert preflight[0].parent_name == "Handler"


def test_static_extracted(rust_extracted):
    symbols, _, _, _ = rust_extracted
    statics = [s for s in symbols if s.name == "MAX_CONNECTIONS"]
    assert statics, "static declaration MAX_CONNECTIONS should be extracted"
    assert statics[0].kind == "const"


def test_trait_methods_not_duplicated(rust_extracted):
    symbols, _, _, _ = rust_extracted
    serve_syms = [s for s in symbols if s.name == "serve"]
    assert len(serve_syms) == 1, f"serve should appear exactly once, got {len(serve_syms)}"


def test_invalid_source_returns_empty():
    result = extract(b"\xff\xfe garbage \x00\x01", "bad.rs")
    for lst in result:
        assert isinstance(lst, list)
