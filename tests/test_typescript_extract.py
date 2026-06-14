"""Tests for arrow-const export promotion in the TypeScript extractor.

Modern React/TS modules frequently expose their public surface entirely as
``export const fn = () => {}`` arrow-function exports.  These must be promoted
to ``kind="function"`` symbols so ``skeleton`` / ``outline`` (which filter to
structural kinds and exclude plain ``const``) do not report ``(0 symbols)``.

Performance note: every test here is a pure, in-process ``extract()`` call on a
byte string — no disk, DB, subprocess, or ``tmp_path``.  The 19 cases execute in
~0.15s.  When this file is run *in isolation* the wall-clock is dominated by
pytest-xdist spinning up one worker per core (``-n auto`` from ``addopts``), which
on a many-core box costs ~0.1s/worker of pure startup and is wasted on CPU-trivial
tests.  For a tight local edit loop run them serially:
``uv run pytest tests/test_typescript_extract.py -o addopts="--strict-markers"``
(or ``-n0``).  The full suite keeps ``-n auto`` because the startup amortizes
across ~14k tests, so no shared config is changed.
"""

from __future__ import annotations

import pytest

from token_goat.languages.typescript import extract


def _names_to_kinds(source: str, rel_path: str = "arrows.ts") -> dict[str, str]:
    symbols, _refs, _imp_exp, _sections = extract(source.encode("utf-8"), rel_path)
    return {s.name: s.kind for s in symbols}


# Arrow-const exports only — the exact shape that previously yielded (0 symbols).
ARROW_ONLY_SOURCE = """\
export const getClickCursor = (): string => { return 'pointer'; }
export const getDefaultCursor = async (): Promise<string> => { return 'default'; }
export const baz = (x: string): number => x.length;
"""


def test_arrow_const_exports_become_function_symbols():
    kinds = _names_to_kinds(ARROW_ONLY_SOURCE)
    assert set(kinds) == {"getClickCursor", "getDefaultCursor", "baz"}
    for name in ("getClickCursor", "getDefaultCursor", "baz"):
        assert kinds[name] == "function", f"{name} should be kind=function, got {kinds.get(name)!r}"


def test_arrow_const_exports_produce_three_symbols():
    symbols, _refs, _imp_exp, _sections = extract(ARROW_ONLY_SOURCE.encode("utf-8"), "arrows.ts")
    func_syms = [s for s in symbols if s.kind == "function"]
    assert len(func_syms) == 3


@pytest.mark.parametrize(
    "stmt,name",
    [
        ("export const f = () => 1;", "f"),
        ("export const g = async () => 1;", "g"),
        ("export const h = (a, b) => a + b;", "h"),
        ("export const single = x => x * 2;", "single"),
        ("export const typed = (n: number): number => n + 1;", "typed"),
        ("export const fnExpr = function () { return 1; };", "fnExpr"),
        ("export let mutable = () => 'm';", "mutable"),
    ],
)
def test_individual_arrow_and_function_expression_exports(stmt, name):
    kinds = _names_to_kinds(stmt)
    assert kinds.get(name) == "function", f"{stmt!r} -> {kinds!r}"


@pytest.mark.parametrize(
    "stmt,name",
    [
        ("export const PORT = 3000;", "PORT"),
        ("export const router = express();", "router"),
        ("export const config = { a: 1, b: 2 };", "config"),
        ("export const list = [1, 2, 3];", "list"),
        ("export const label = 'hello';", "label"),
    ],
)
def test_non_function_const_exports_stay_const(stmt, name):
    kinds = _names_to_kinds(stmt)
    assert kinds.get(name) == "const", f"{stmt!r} -> {kinds!r}"


def test_object_with_inner_arrow_is_not_promoted():
    # The arrow lives inside an object literal — the export itself is a const value.
    kinds = _names_to_kinds("export const handlers = { onClick: () => 1 };")
    assert kinds.get("handlers") == "const"


def test_mixed_module_skeleton_surface():
    source = """\
import { useState } from 'react';

export const useCounter = () => {
  const [n, setN] = useState(0);
  return { n, inc: () => setN(n + 1) };
};

export function helper(x: number): number {
  return x * 2;
}

export const VERSION = '1.0.0';
"""
    kinds = _names_to_kinds(source, "hook.ts")
    assert kinds.get("useCounter") == "function"
    assert kinds.get("helper") == "function"
    assert kinds.get("VERSION") == "const"


def test_multiline_arrow_export_is_function():
    # Prettier wraps long parameter lists across lines. tree-sitter's export pass
    # truncates `export const f =` to the first line and classifies it "const";
    # the source fallback must upgrade it to "function" once it sees the `=>`.
    source = "export const f = (\n  a: string,\n  b: number,\n) => {}\n"
    kinds = _names_to_kinds(source)
    assert kinds.get("f") == "function", kinds


def test_inline_value_after_eq_multiline_arrow():
    # The `=` and the arrow head sit on different lines, so the first-line view
    # is just `export const h =` — again classified "const" until the fallback.
    source = "export const h =\n  async (req, res) => {}\n"
    kinds = _names_to_kinds(source)
    assert kinds.get("h") == "function", kinds


def test_template_literal_export_not_phantom():
    # An `export const … =>` written inside a backtick template (e.g. a code
    # sample) must not surface a phantom symbol. Only the real export survives.
    source = (
        "export const realFn = () => 1;\n"
        "const code = `\n"
        "export const phantom = () => 2\n"
        "`;\n"
    )
    symbols, _refs, _imp_exp, _sections = extract(source.encode("utf-8"), "tmpl.ts")
    names = {s.name for s in symbols}
    assert "realFn" in names
    assert "phantom" not in names, names
