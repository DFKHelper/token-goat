"""Python symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

__all__ = ["extract"]

import re
from typing import TYPE_CHECKING

from ..util import get_logger
from . import common

if TYPE_CHECKING:
    from ..parser import ImpExp, Ref, Section, Symbol

_LOG = get_logger("languages.python")


# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

# Matches a decorator line (possibly indented) at the start of trimmed content.
# Used by _extend_starts_for_decorators below to walk start_line backward when
# tree-sitter reports the `def`/`class` line as the start of a decorated symbol.
_DECORATOR_LINE_RE = re.compile(r"^\s*@[A-Za-z_]")


_PY_ELIGIBLE_KINDS: frozenset[str] = frozenset({"function", "method", "class"})


def _py_decorator_walk(text_lines: list[str], def_line_1based: int) -> int:
    """Walk *def_line_1based* upward over consecutive Python decorator lines.

    Tolerates at most one blank line between stacked decorators (a common
    style seen with grouped ``@pytest.mark.*`` chains) but stops at any
    non-decorator, non-blank line.

    Returns the earliest 1-based line number that includes all preceding
    ``@decorator`` lines, or *def_line_1based* itself when no decorators
    precede the definition.
    """
    n_lines = len(text_lines)
    if def_line_1based <= 1 or def_line_1based > n_lines:
        return def_line_1based
    new_start = def_line_1based
    i = def_line_1based - 2  # 0-based index of the line directly above the def
    saw_decorator = False
    while i >= 0:
        line = text_lines[i]
        if _DECORATOR_LINE_RE.match(line):
            new_start = i + 1  # 1-based line number
            saw_decorator = True
            i -= 1
            continue
        if saw_decorator and not line.strip():
            # blank gap between decorators — keep looking one line further
            i -= 1
            continue
        break
    return new_start


def _extend_starts_for_decorators(symbols: list[Symbol], source: bytes) -> None:
    """Walk each function/class/method symbol's start_line back over leading decorators.

    Tree-sitter reports the ``def``/``class`` line as the symbol start, which
    excludes any preceding ``@decorator`` lines.  An agent asking for the
    function body via ``token-goat read "file.py::func"`` loses crucial
    information when decorators are stripped (``@property``, ``@cache``,
    ``@app.route("/path")``, ``@pytest.fixture`` all change the meaning of
    the function).

    Delegates to :func:`common.extend_starts_for_decorators` with the
    Python-specific walker :func:`_py_decorator_walk`.  Mutates symbols
    in-place.

    Only applied to ``function``, ``method``, and ``class`` kinds — decorators
    never appear on ``var`` / ``const`` symbols.
    """
    common.extend_starts_for_decorators(
        symbols,
        source,
        eligible_kinds=_PY_ELIGIBLE_KINDS,
        walk_fn=_py_decorator_walk,
    )


_CALL_NOISE = frozenset([
    # Python builtins
    "print", "len", "range", "str", "int", "float", "bool", "list",
    "dict", "set", "tuple", "type", "isinstance", "issubclass",
    "hasattr", "getattr", "setattr", "delattr", "callable", "iter",
    "next", "enumerate", "zip", "map", "filter", "sorted", "reversed",
    "min", "max", "sum", "abs", "round", "pow", "divmod",
    "open", "repr", "hash", "id", "vars", "dir", "help",
    "super", "object", "property", "staticmethod", "classmethod",
    "raise", "assert", "return", "yield", "lambda",
    "if", "for", "while", "with", "except",
    # Common decorators when used with ()
    "wraps",
])

# Import parsing patterns — compiled once at module level so _parse_import_source
# (called once per import line during indexing) does not pay re.compile() overhead.
_FROM_IMPORT_RE = re.compile(r"^from\s+(\S+)\s+import\s+(.+)$")
_PLAIN_IMPORT_RE = re.compile(r"^import\s+(.+)$")


def _parse_import_source(source_line: str) -> list[str]:
    """Return qualified import targets from one Python import statement source line.

    Handles both statement forms and expands multi-target imports into separate
    target strings so each name gets its own :class:`~token_goat.parser.ImpExp` row:

    - ``from foo.bar import A, B as C`` → ``["foo.bar.A", "foo.bar.B"]``
      (``as`` aliases are stripped; ``*`` is excluded)
    - ``import os, pathlib.Path as P`` → ``["os", "pathlib.Path"]``
    - Parenthesized ``from x import (A, B)`` is handled by stripping ``()``.
    - Unrecognised lines fall back to returning the raw stripped line.
    """
    line = source_line.strip()
    m = _FROM_IMPORT_RE.match(line)
    if m:
        module = m.group(1)
        names_raw = m.group(2)
        # Handle parenthesized imports — strip them
        names_raw = names_raw.strip("()")
        names = [n.strip().partition(" as ")[0] for n in names_raw.split(",")]
        return [f"{module}.{n}" for n in names if n and n != "*"]
    m = _PLAIN_IMPORT_RE.match(line)
    if m:
        names_raw = m.group(1)
        names = [n.strip().partition(" as ")[0] for n in names_raw.split(",")]
        return [n for n in names if n]
    return [line]


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Python source file.

    Symbols are collected in two passes:
    1. **Structure walk** via tree-sitter — discovers functions, classes, and
       methods (functions nested inside a class are promoted to ``kind="method"``
       via ``promote_methods=True`` in :func:`~common.make_add_symbol`).
    2. **SymbolInfo pass** — catches module-level variables and constants that
       the structure walk may miss (e.g. ``MY_CONST = 42``).

    Imports are expanded per-name via :func:`_parse_import_source`, so a single
    ``from os.path import join, exists`` statement produces two :class:`ImpExp`
    rows (``os.path.join`` and ``os.path.exists``).

    WHY regex instead of tree-sitter children for imports: tlp surfaces each
    import statement as a single ``.source`` text string, not as separate child
    nodes for the module name and each imported name.  ``from foo import A, B``
    and ``import os, sys`` both arrive as one opaque string, so regex
    post-processing in :func:`_parse_import_source` is the only way to split
    multi-name imports into individual per-name :class:`ImpExp` rows.

    Refs are extracted by regex (``_CALL_RE``) over the raw source text.
    Common builtins and keywords in ``_CALL_NOISE`` are excluded to keep the
    ref list focused on project-internal call sites.  Sections are always empty
    for Python files (use :mod:`token_goat.languages.markdown` for prose).
    """
    collected = common.collect_symbols_and_refs(
        source, "python", rel_path, _LOG, common.CALL_RE, _CALL_NOISE, promote_methods=True
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    # --- imports ---
    common.add_imports(
        imp_exp,
        result.imports,  # type: ignore[attr-defined]
        lambda imp: _parse_import_source(imp.source),  # type: ignore[attr-defined]
    )

    # --- post-pass: extend start_line over preceding decorator lines ---
    # WHY post-pass: tree-sitter's structure walk reports the `def`/`class` line
    # as the start, missing decorators that materially affect the symbol.
    _extend_starts_for_decorators(symbols, source)

    return symbols, refs, imp_exp, []
