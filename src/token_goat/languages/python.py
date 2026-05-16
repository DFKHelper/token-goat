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



def _parse_import_source(source_line: str) -> list[str]:
    """Return list of import targets from an import statement source line."""
    line = source_line.strip()
    m = re.match(r"^from\s+(\S+)\s+import\s+(.+)$", line)
    if m:
        module = m.group(1)
        names_raw = m.group(2)
        # Handle parenthesized imports — strip them
        names_raw = names_raw.strip("()")
        names = [n.strip().split(" as ")[0].strip() for n in names_raw.split(",")]
        return [f"{module}.{n}" for n in names if n and n != "*"]
    m = re.match(r"^import\s+(.+)$", line)
    if m:
        names_raw = m.group(1)
        names = [n.strip().split(" as ")[0].strip() for n in names_raw.split(",")]
        return [n for n in names if n]
    return [line]


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Python file."""
    text = source.decode("utf-8", errors="replace")
    tlp, cfg = common.make_process_config(language="python")
    if tlp is None:
        return [], [], [], []
    try:
        result = tlp.process(text, cfg)
    except Exception:  # noqa: BLE001
        _LOG.debug("tree-sitter parse failed for python source: %s", rel_path, exc_info=True)
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
