"""Property and fuzz tests for language extractor robustness with malformed source.

All extractors must satisfy two invariants regardless of input:
  1. Never raise — return ([], [], [], []) on any error.
  2. All returned objects pass structural validity checks (line >= 1, etc.).

Marked ``slow`` at module level: hypothesis fuzz across nine tree-sitter
adapters churns the parser's C allocator with arbitrary bytes. On the
Windows 2022 GH Actions runner this destabilises the worker process —
manifesting later in the suite as ``Windows fatal exception: code
0xc000001d`` (illegal instruction) / access violations / ``<freed thread
state>`` in unrelated tests. The invariants are still covered: the slow
tier runs them, and the per-adapter unit tests in test_parser_*.py
exercise the happy path in the fast tier.
"""
from __future__ import annotations

import string

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from token_goat.languages.dockerfile_idx import extract as dockerfile_extract
from token_goat.languages.go import extract as go_extract
from token_goat.languages.ini_idx import extract as ini_extract
from token_goat.languages.json_idx import extract as json_extract
from token_goat.languages.python import extract as py_extract
from token_goat.languages.rust import extract as rust_extract
from token_goat.languages.toml_idx import extract as toml_extract
from token_goat.languages.typescript import extract as ts_extract
from token_goat.languages.yaml_idx import extract as yaml_extract

pytestmark = pytest.mark.slow

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EXTRACTORS = [
    ("python", py_extract, "src/app.py"),
    ("typescript", ts_extract, "src/app.ts"),
    ("go", go_extract, "main.go"),
    ("rust", rust_extract, "src/main.rs"),
]


def _assert_valid_results(symbols, refs, imp_exp, sections, *, label: str) -> None:
    """Assert structural validity on all returned objects."""
    assert isinstance(symbols, list), f"{label}: symbols not a list"
    assert isinstance(refs, list), f"{label}: refs not a list"
    assert isinstance(imp_exp, list), f"{label}: imp_exp not a list"
    assert isinstance(sections, list), f"{label}: sections not a list"

    for sym in symbols:
        assert sym.line >= 1, f"{label}: symbol {sym.name!r} has line={sym.line}"
        assert len(sym.name) >= 1, f"{label}: empty symbol name"
        if sym.end_line is not None:
            assert sym.end_line >= sym.line, (
                f"{label}: symbol {sym.name!r} end_line={sym.end_line} < line={sym.line}"
            )

    for ref in refs:
        assert ref.line >= 1, f"{label}: ref {ref.name!r} has line={ref.line}"
        assert len(ref.name) > 1, f"{label}: single-char ref {ref.name!r} leaked"

    for ie in imp_exp:
        assert ie.kind in ("import", "export"), f"{label}: unknown imp_exp kind {ie.kind!r}"
        assert len(ie.target) >= 1, f"{label}: empty import/export target"

    for sec in sections:
        # Section uses ``heading`` (not ``title``); using getattr with a
        # fallback keeps the error-message diagnostic working even if an
        # adapter ever swaps the field name.
        _label = getattr(sec, "heading", getattr(sec, "title", "<no name>"))
        assert sec.line >= 1, f"{label}: section {_label!r} has line={sec.line}"


# ---------------------------------------------------------------------------
# Parametrized fixed edge cases
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name,extract_fn,rel_path", _EXTRACTORS)
class TestExtractorRobustness:
    def test_empty_bytes(self, name, extract_fn, rel_path):
        result = extract_fn(b"", rel_path)
        _assert_valid_results(*result, label=f"{name}/empty")

    def test_null_bytes(self, name, extract_fn, rel_path):
        result = extract_fn(b"\x00" * 64, rel_path)
        _assert_valid_results(*result, label=f"{name}/nulls")

    def test_invalid_utf8(self, name, extract_fn, rel_path):
        result = extract_fn(b"\xff\xfe\x80\x81\x82" * 20, rel_path)
        _assert_valid_results(*result, label=f"{name}/invalid_utf8")

    def test_truncated_mid_token(self, name, extract_fn, rel_path):
        # Truncate a realistic snippet mid-token
        snippet = b"def foo(x, y):\n    return x + y\n\nclass Bar:\n    def me"
        result = extract_fn(snippet, rel_path)
        _assert_valid_results(*result, label=f"{name}/truncated")

    def test_only_whitespace(self, name, extract_fn, rel_path):
        result = extract_fn(b"   \n\t\n   \n", rel_path)
        _assert_valid_results(*result, label=f"{name}/whitespace")

    def test_only_comments(self, name, extract_fn, rel_path):
        result = extract_fn(b"# comment\n// comment\n/* comment */\n", rel_path)
        _assert_valid_results(*result, label=f"{name}/comments")

    def test_deeply_nested_braces(self, name, extract_fn, rel_path):
        # 50 levels of nesting — enough to exercise the recursive path without
        # hitting the native stack limit inside tree-sitter's C runtime.
        source = b"{\n" * 50 + b"}\n" * 50
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/deep_nesting")

    def test_very_long_line(self, name, extract_fn, rel_path):
        # ~500 tokens — enough to stress the parser without hitting the C stack limit
        source = b"x = " + b"1 + " * 500 + b"0\n"
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/long_line")

    def test_mixed_binary_and_text(self, name, extract_fn, rel_path):
        source = b"def foo():\n    pass\n" + bytes(range(256)) + b"\ndef bar():\n    pass\n"
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/mixed_binary")

    def test_wrong_language_source(self, name, extract_fn, rel_path):
        # Feed each extractor valid source from a different language
        foreign = {
            "python": b"fn main() { println!(\"hello\"); }\n",
            "typescript": b"package main\nfunc main() {}\n",
            "go": b"class Foo { void bar() {} }\n",
            "rust": b"def foo():\n    pass\n",
        }
        result = extract_fn(foreign[name], rel_path)
        _assert_valid_results(*result, label=f"{name}/wrong_language")

    def test_nul_embedded_in_valid_source(self, name, extract_fn, rel_path):
        source = b"def foo():\n    x = \x00'hello'\n    return x\n"
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/embedded_nul")

    def test_extremely_long_identifier(self, name, extract_fn, rel_path):
        ident = b"a" * 10_000
        source = b"def " + ident + b"():\n    pass\n"
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/long_ident")

    def test_unicode_identifiers(self, name, extract_fn, rel_path):
        source = "def héllo_wörld(αβγ):\n    return αβγ\n".encode()
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/unicode_idents")

    def test_no_newline_at_eof(self, name, extract_fn, rel_path):
        result = extract_fn(b"def foo(): pass", rel_path)
        _assert_valid_results(*result, label=f"{name}/no_eof_newline")


# ---------------------------------------------------------------------------
# Cross-language: Python-specific edge cases
# ---------------------------------------------------------------------------

class TestPythonEdgeCases:
    def test_decorator_with_args(self):
        src = b"@app.route('/foo', methods=['GET'])\ndef view():\n    pass\n"
        syms, refs, _, _ = py_extract(src, "views.py")
        _assert_valid_results(syms, refs, [], [], label="py/decorator")

    def test_nested_classes(self):
        src = b"class Outer:\n    class Inner:\n        def method(self):\n            pass\n"
        syms, _, _, _ = py_extract(src, "nested.py")
        names = {s.name for s in syms}
        assert "Outer" in names
        assert "Inner" in names

    def test_multiline_string_does_not_create_fake_refs(self):
        src = b'def foo():\n    x = """\n    bar()\n    baz()\n    """\n    return x\n'
        _, refs, _, _ = py_extract(src, "multi.py")
        # bar/baz are inside a string literal — they may or may not appear
        # but must not crash and any that appear must be valid
        for r in refs:
            assert r.line >= 1

    def test_walrus_operator(self):
        src = b"def foo(data):\n    if n := len(data):\n        return n\n"
        result = py_extract(src, "walrus.py")
        _assert_valid_results(*result, label="py/walrus")

    def test_type_alias(self):
        src = b"type Vector = list[float]\n\ndef scale(v: Vector) -> Vector:\n    return v\n"
        result = py_extract(src, "alias.py")
        _assert_valid_results(*result, label="py/type_alias")


# ---------------------------------------------------------------------------
# Hypothesis property tests
# ---------------------------------------------------------------------------

_BYTE_STRATEGY = st.binary(min_size=0, max_size=4096)

_TEXT_STRATEGY = st.text(
    alphabet=st.characters(
        blacklist_categories=("Cs",),  # exclude surrogates
    ),
    min_size=0,
    max_size=2000,
).map(lambda s: s.encode("utf-8", errors="replace"))

_PRINTABLE_STRATEGY = st.text(
    alphabet=string.printable,
    min_size=0,
    max_size=2000,
).map(str.encode)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_py_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = py_extract(source, "fuzz.py")
    _assert_valid_results(*result, label="py/fuzz_bytes")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_ts_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = ts_extract(source, "fuzz.ts")
    _assert_valid_results(*result, label="ts/fuzz_bytes")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_go_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = go_extract(source, "fuzz.go")
    _assert_valid_results(*result, label="go/fuzz_bytes")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_rust_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = rust_extract(source, "fuzz.rs")
    _assert_valid_results(*result, label="rust/fuzz_bytes")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_py_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = py_extract(source, "fuzz.py")
    _assert_valid_results(*result, label="py/fuzz_printable")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_ts_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = ts_extract(source, "fuzz.ts")
    _assert_valid_results(*result, label="ts/fuzz_printable")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_go_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = go_extract(source, "fuzz.go")
    _assert_valid_results(*result, label="go/fuzz_printable")


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_rust_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = rust_extract(source, "fuzz.rs")
    _assert_valid_results(*result, label="rust/fuzz_printable")


# ---------------------------------------------------------------------------
# common.extract_refs_from_source property test
# ---------------------------------------------------------------------------

@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_extract_refs_from_source_never_raises(source: bytes) -> None:
    import re

    from token_goat.languages.common import extract_refs_from_source

    call_re = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    noise: frozenset[str] = frozenset(["print", "len"])
    refs = extract_refs_from_source(source, call_re, noise)
    assert isinstance(refs, list)
    for r in refs:
        assert r.line >= 1  # type: ignore[attr-defined]
        assert len(r.name) > 1  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Flat-config adapters — fixed edge cases + property tests
# ---------------------------------------------------------------------------
# These adapters (toml_idx / yaml_idx / json_idx / ini_idx / dockerfile_idx)
# were added in r4 iter 2's structured-config refactor and share the
# common.py decode/BOM-strip/end-line plumbing.  They have the same
# never-raise contract as the tree-sitter adapters, so they get the same
# robustness coverage to lock the invariant in.

_FLAT_CONFIG_EXTRACTORS = [
    ("toml", toml_extract, "pyproject.toml"),
    ("yaml", yaml_extract, ".github/workflows/ci.yml"),
    ("json", json_extract, "package.json"),
    ("ini", ini_extract, "setup.cfg"),
    ("dockerfile", dockerfile_extract, "Dockerfile"),
]


@pytest.mark.parametrize("name,extract_fn,rel_path", _FLAT_CONFIG_EXTRACTORS)
class TestFlatConfigRobustness:
    """Mirror of TestExtractorRobustness for the structured-config adapters.

    Each case exercises a different malformed-input shape so a regression in
    common.py's decode/BOM-strip path surfaces against every concrete adapter
    rather than only the one that happens to be re-imported in a CI run.
    """

    def test_empty_bytes(self, name, extract_fn, rel_path):
        result = extract_fn(b"", rel_path)
        _assert_valid_results(*result, label=f"{name}/empty")

    def test_null_bytes(self, name, extract_fn, rel_path):
        result = extract_fn(b"\x00" * 64, rel_path)
        _assert_valid_results(*result, label=f"{name}/nulls")

    def test_invalid_utf8(self, name, extract_fn, rel_path):
        result = extract_fn(b"\xff\xfe\x80\x81\x82" * 20, rel_path)
        _assert_valid_results(*result, label=f"{name}/invalid_utf8")

    def test_utf8_bom_only(self, name, extract_fn, rel_path):
        # BOM-only file exercises the BOM-strip helper in common.py without
        # any content to follow it — a common Windows editor output for a
        # newly created config file.
        result = extract_fn(b"\xef\xbb\xbf", rel_path)
        _assert_valid_results(*result, label=f"{name}/bom_only")

    def test_huge_single_line(self, name, extract_fn, rel_path):
        # 200 KB single-line input — exercises the per-file/heading caps in
        # the adapters and ensures none of them blow up on absent newlines.
        result = extract_fn(b"x" * 200_000, rel_path)
        _assert_valid_results(*result, label=f"{name}/huge_oneline")

    def test_crlf_line_endings(self, name, extract_fn, rel_path):
        # Windows CRLF — common in real-world config files; the common.py
        # end-line helper must treat \r\n and \n identically.
        result = extract_fn(b"[section]\r\nkey=value\r\n" * 10, rel_path)
        _assert_valid_results(*result, label=f"{name}/crlf")

    def test_unicode_section_names(self, name, extract_fn, rel_path):
        # Section / table / heading names with non-ASCII content; each
        # adapter has its own regex but they all share the decode path.
        source = "[héllo_wörld]\nkey=value\n".encode()
        result = extract_fn(source, rel_path)
        _assert_valid_results(*result, label=f"{name}/unicode_section")

    def test_no_newline_at_eof(self, name, extract_fn, rel_path):
        result = extract_fn(b"[section]\nkey=value", rel_path)
        _assert_valid_results(*result, label=f"{name}/no_eof_newline")


@pytest.mark.parametrize("name,extract_fn,rel_path", _FLAT_CONFIG_EXTRACTORS)
class TestFlatConfigDeterminism:
    """The flat-config adapters use regex scanning with no nondeterministic
    inputs (no hash randomisation, no file mtimes). Same bytes must yield the
    same (count, ordered) result every time so cache hits in parser.py stay
    valid across reruns."""

    def test_same_input_same_output_counts(self, name, extract_fn, rel_path):
        # Use a representative format-specific payload; each adapter sees a
        # mix of valid headers and noise so symbol + section counts are > 0
        # for at least one adapter (any non-empty count exercises ordering).
        sources = {
            "toml": b"[tool.ruff]\nline-length = 100\n\n[[tool.mypy.overrides]]\nmodule = 'x'\n",
            "yaml": b"name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
            "json": b'{"name": "pkg", "scripts": {"build": "tsc"}, "dependencies": {"a": "1.0"}}',
            "ini": b"[section1]\nkey1=value1\n\n[section2]\nkey2=value2\n",
            "dockerfile": b"FROM python:3.12-slim\nRUN apt-get update\nWORKDIR /app\nCOPY . .\n",
        }
        source = sources[name]
        r1 = extract_fn(source, rel_path)
        r2 = extract_fn(source, rel_path)
        syms1, refs1, ie1, sec1 = r1
        syms2, refs2, ie2, sec2 = r2
        assert len(syms1) == len(syms2), f"{name}: non-deterministic symbol count"
        assert len(refs1) == len(refs2), f"{name}: non-deterministic ref count"
        assert len(ie1) == len(ie2), f"{name}: non-deterministic import count"
        assert len(sec1) == len(sec2), f"{name}: non-deterministic section count"
        # Ordering also matters — line numbers must come out in the same
        # sequence so DB upsert keys stay stable across re-indexes.
        assert [s.line for s in syms1] == [s.line for s in syms2], (
            f"{name}: symbol ordering changed across runs"
        )
        assert [s.line for s in sec1] == [s.line for s in sec2], (
            f"{name}: section ordering changed across runs"
        )


# Hypothesis fuzz: never raise on arbitrary bytes / printable text for each
# flat-config adapter.  Same shape as the tree-sitter adapters above.

@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_toml_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = toml_extract(source, "fuzz.toml")
    _assert_valid_results(*result, label="toml/fuzz_bytes")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_yaml_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = yaml_extract(source, "fuzz.yml")
    _assert_valid_results(*result, label="yaml/fuzz_bytes")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_json_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = json_extract(source, "fuzz.json")
    _assert_valid_results(*result, label="json/fuzz_bytes")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_ini_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = ini_extract(source, "fuzz.ini")
    _assert_valid_results(*result, label="ini/fuzz_bytes")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_BYTE_STRATEGY)
def test_dockerfile_extract_never_raises_on_arbitrary_bytes(source: bytes) -> None:
    result = dockerfile_extract(source, "Dockerfile.fuzz")
    _assert_valid_results(*result, label="dockerfile/fuzz_bytes")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_toml_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = toml_extract(source, "fuzz.toml")
    _assert_valid_results(*result, label="toml/fuzz_printable")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_yaml_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = yaml_extract(source, "fuzz.yml")
    _assert_valid_results(*result, label="yaml/fuzz_printable")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_json_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = json_extract(source, "fuzz.json")
    _assert_valid_results(*result, label="json/fuzz_printable")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_ini_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = ini_extract(source, "fuzz.ini")
    _assert_valid_results(*result, label="ini/fuzz_printable")


@settings(max_examples=80, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_dockerfile_extract_never_raises_on_printable_text(source: bytes) -> None:
    result = dockerfile_extract(source, "Dockerfile.fuzz")
    _assert_valid_results(*result, label="dockerfile/fuzz_printable")


# ---------------------------------------------------------------------------
# Determinism property: same input -> same output
# ---------------------------------------------------------------------------

@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
@given(source=_PRINTABLE_STRATEGY)
def test_py_extract_is_deterministic(source: bytes) -> None:
    r1 = py_extract(source, "det.py")
    r2 = py_extract(source, "det.py")
    syms1, refs1, ie1, sec1 = r1
    syms2, refs2, ie2, sec2 = r2
    assert len(syms1) == len(syms2), "non-deterministic symbol count"
    assert len(refs1) == len(refs2), "non-deterministic ref count"
    assert len(ie1) == len(ie2), "non-deterministic import count"
