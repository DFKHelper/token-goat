"""Python symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.python")


# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

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

# Regex: identifier NOT preceded by . that is immediately followed by (
_CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")

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

    Refs are extracted by regex (``_CALL_RE``) over the raw source text.
    Common builtins and keywords in ``_CALL_NOISE`` are excluded to keep the
    ref list focused on project-internal call sites.  Sections are always empty
    for Python files (use :mod:`token_goat.languages.markdown` for prose).
    """
    result, _text = common.parse_source(source, "python", rel_path, _LOG)
    if result is None:
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    # promote_methods=True: function inside a class becomes "method"
    _add_symbol = common.make_add_symbol(
        symbols, seen_names, source, language="python", promote_methods=True
    )
    for item in result.structure:
        _add_symbol(item)

    # --- additional symbols from SymbolInfo (module-level vars/consts) ---
    common.add_symbol_info(symbols, seen_names, result.symbols, language="python")

    # --- imports ---
    common.add_imports(
        imp_exp,
        result.imports,
        lambda imp: _parse_import_source(imp.source),  # type: ignore[attr-defined]
    )

    # --- refs ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)

    return symbols, refs, imp_exp, []
