"""Go symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.go")


# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

_CALL_NOISE = frozenset([
    "make", "new", "len", "cap", "append", "copy", "delete",
    "panic", "recover", "print", "println", "close",
    "fmt", "fmt.Printf", "fmt.Println", "fmt.Errorf",
    "if", "for", "switch", "select", "go", "defer",
    "return", "func", "struct", "interface", "map", "chan",
    "string", "int", "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64",
    "bool", "byte", "rune", "error",
])

# Regex: identifier NOT preceded by . or -> that is immediately followed by (
_CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")

# Regex to extract quoted import path from a Go import line
_GO_IMPORT_RE = re.compile(r'"([^"]+)"')


def _extract_const_var(source: bytes) -> list[Symbol]:
    """Extract package-level const and var declarations via regex.

    tlp does not surface these via structure/symbols for Go, so we fall back
    to a regex pass over the raw source.
    """
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    n_lines = len(lines)
    i = 0
    while i < n_lines:
        line = lines[i]
        stripped = line.lstrip()

        # Single-line: const Foo = ...
        m = re.match(r"^const\s+([A-Za-z_][A-Za-z0-9_]*)\s", stripped)
        if m and not line.startswith(" ") and not line.startswith("\t"):
            name = m.group(1)
            sig = line.rstrip()[:200]
            symbols.append(Symbol(name=name, kind="const", line=i + 1, end_line=i + 1, signature=sig))
            i += 1
            continue

        # Block: const (
        m = re.match(r"^const\s*\($", stripped)
        if m and not line.startswith(" ") and not line.startswith("\t"):
            i += 1
            while i < n_lines:
                bline = lines[i]
                bstripped = bline.strip()
                if bstripped == ")":
                    break
                if bstripped and not bstripped.startswith("//"):
                    bm = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|[A-Za-z_\(])", bstripped)
                    if bm:
                        name = bm.group(1)
                        sig = bstripped[:200]
                        symbols.append(Symbol(name=name, kind="const", line=i + 1, end_line=i + 1, signature=sig))
                i += 1
            i += 1
            continue

        # Single-line: var Foo = ...
        m = re.match(r"^var\s+([A-Za-z_][A-Za-z0-9_]*)\s", stripped)
        if m and not line.startswith(" ") and not line.startswith("\t"):
            name = m.group(1)
            sig = line.rstrip()[:200]
            symbols.append(Symbol(name=name, kind="var", line=i + 1, end_line=i + 1, signature=sig))
            i += 1
            continue

        # Block: var (
        m = re.match(r"^var\s*\($", stripped)
        if m and not line.startswith(" ") and not line.startswith("\t"):
            i += 1
            while i < n_lines:
                bline = lines[i]
                bstripped = bline.strip()
                if bstripped == ")":
                    break
                if bstripped and not bstripped.startswith("//"):
                    bm = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|[A-Za-z_\(])", bstripped)
                    if bm:
                        name = bm.group(1)
                        sig = bstripped[:200]
                        symbols.append(Symbol(name=name, kind="var", line=i + 1, end_line=i + 1, signature=sig))
                i += 1
            i += 1
            continue

        i += 1

    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Go file."""
    result, _text = common.parse_source(source, "go", rel_path, _LOG)
    if result is None:
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    # --- structure: functions and methods ---
    _add_symbol = common.make_add_symbol(symbols, seen_names, source, language="go")
    for item in result.structure:
        _add_symbol(item)

    # --- symbols from SymbolInfo (structs, interfaces, module-level funcs) ---
    common.add_symbol_info(symbols, seen_names, result.symbols, language="go")

    # --- const/var (not surfaced by tlp) ---
    for cv_sym in _extract_const_var(source):
        key = (cv_sym.name, cv_sym.line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(cv_sym)

    # --- imports ---
    def _extract_go_import_target(imp: object) -> str:
        """Extract the bare import path from a Go ``import`` node.

        Block-level ``import (...)`` nodes are skipped (return ``""``) because
        the tree-sitter grammar also emits each individual quoted path inside
        the block, so processing the block header would produce a duplicate.
        Named imports (``alias "path"``) are normalised to just the path via
        ``_GO_IMPORT_RE``.
        """
        src = imp.source.strip()  # type: ignore[attr-defined]
        # Skip the block-level 'import (...)' item — the individual quoted paths are also emitted
        if src.startswith("import ("):
            return ""
        m = _GO_IMPORT_RE.search(src)
        return m.group(1) if m else ""

    common.add_imports(imp_exp, result.imports, _extract_go_import_target)

    # --- refs ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)

    return symbols, refs, imp_exp, []
