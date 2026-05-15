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

    i = 0
    while i < len(lines):
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
            while i < len(lines):
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
            while i < len(lines):
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
    tlp = common.get_tlp()
    if tlp is None:
        return [], [], [], []

    text = source.decode("utf-8", errors="replace")
    cfg = tlp.ProcessConfig(
        language="go",
        structure=True,
        imports=True,
        exports=False,
        symbols=True,
    )
    try:
        result = tlp.process(text, cfg)
    except Exception:
        _LOG.debug("tree-sitter parse failed for go source", exc_info=True)
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    # --- structure: functions and methods ---
    def _add_symbol(item: object, parent_name: str | None = None) -> None:
        name: str = item.name  # type: ignore[attr-defined]
        if not name:
            for child in item.children:  # type: ignore[attr-defined]
                _add_symbol(child, parent_name=parent_name)
            return
        span = item.span
        body_span = item.body_span if hasattr(item, "body_span") else None
        line = span.start_line + 1
        end_line = span.end_line + 1
        kind = common.kind_str(item.kind)
        sig = common.build_signature(source, span, body_span)

        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=kind,
                    line=line,
                    end_line=end_line,
                    signature=sig,
                    parent_name=parent_name,
                )
            )

        for child in item.children:  # type: ignore[attr-defined]
            _add_symbol(child, parent_name=name)

    for item in result.structure:
        _add_symbol(item)

    # --- symbols from SymbolInfo (structs, interfaces, module-level funcs) ---
    for sym in result.symbols:
        name: str = sym.name  # type: ignore[attr-defined]
        span = sym.span
        line = span.start_line + 1
        kind = common.sym_kind_str(sym.kind)
        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=kind,
                    line=line,
                    end_line=span.end_line + 1,
                    signature=None,
                    parent_name=None,
                )
            )

    # --- const/var (not surfaced by tlp) ---
    for cv_sym in _extract_const_var(source):
        key = (cv_sym.name, cv_sym.line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(cv_sym)

    # --- imports ---
    for imp in result.imports:
        src = imp.source.strip()
        # Skip the block-level 'import (...)' item — the individual quoted paths are also emitted
        if src.startswith("import ("):
            continue
        m = _GO_IMPORT_RE.search(src)
        if m:
            line = imp.span.start_line + 1
            imp_exp.append(ImpExp(kind="import", target=m.group(1), line=line))

    # --- refs ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)  # type: ignore[assignment]

    return symbols, refs, imp_exp, []
