"""Go symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.go")


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

# Regex to extract quoted import path from a Go import line
_GO_IMPORT_RE = re.compile(r'"([^"]+)"')

_IDENT_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|[A-Za-z_\(])")

# Patterns for package-level const/var declarations — hoisted to module level so
# _extract_const_var_inner (called once per Go file) does not recompile them on
# every source line.  Four patterns cover the two keywords × two forms (single-line
# and block-opening).
_CONST_SINGLE_RE = re.compile(r"^const\s+([A-Za-z_][A-Za-z0-9_]*)\s")
_CONST_BLOCK_RE = re.compile(r"^const\s*\($")
_VAR_SINGLE_RE = re.compile(r"^var\s+([A-Za-z_][A-Za-z0-9_]*)\s")
_VAR_BLOCK_RE = re.compile(r"^var\s*\($")


def _scan_decl_block(lines: list[str], start: int, kind: str) -> tuple[list[Symbol], int]:
    """Consume lines inside a Go ``const (`` or ``var (`` block starting at *start*.

    *start* is the index of the first line **after** the opening ``(`` line.
    Returns ``(symbols, next_i)`` where *next_i* is the index of the line
    after the closing ``)``.  Extracted to eliminate the identical loop body
    shared by the const and var block cases in ``_extract_const_var``.
    """
    symbols: list[Symbol] = []
    i = start
    n = len(lines)
    while i < n:
        line_stripped = lines[i].strip()
        if line_stripped == ")":
            break
        if line_stripped and not line_stripped.startswith("//"):
            ident_match = _IDENT_RE.match(line_stripped)
            if ident_match:
                name = ident_match.group(1)
                symbols.append(Symbol(name=name, kind=kind, line=i + 1, end_line=i + 1, signature=line_stripped[:200]))
        i += 1
    return symbols, i + 1  # skip past the closing ')'


def _extract_const_var(source: bytes) -> list[Symbol]:
    """Extract package-level const and var declarations via regex.

    WHY a separate regex pass: tlp's structure/symbols walk for Go focuses on
    named entities — functions, types, and interfaces — and does not emit
    ``const_declaration`` or ``var_declaration`` nodes.  iota-based const groups
    make this especially awkward for tree-sitter alone because the effective value
    of each constant depends on its ordinal position within the block, not just its
    own syntax node.  A line-by-line regex scan is simpler, predictable, and
    produces the same symbol name regardless of iota semantics.

    The single-line and block forms for both ``const`` and ``var`` share the same
    scanning logic, delegated to ``_scan_decl_block`` for block bodies.
    """
    try:
        return _extract_const_var_inner(source)
    except (re.error, ValueError, IndexError) as exc:
        _LOG.debug("_extract_const_var: parse error: %s", exc, exc_info=True)
        return []


def _extract_const_var_inner(source: bytes) -> list[Symbol]:
    """Inner implementation of _extract_const_var; separated for testable error boundary."""
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    n_lines = len(lines)
    i = 0
    while i < n_lines:
        line = lines[i]
        # Only process package-level declarations (not indented)
        if line.startswith((" ", "\t")):
            i += 1
            continue
        stripped = line.lstrip()

        for single_re, block_re, kind in (
            (_CONST_SINGLE_RE, _CONST_BLOCK_RE, "const"),
            (_VAR_SINGLE_RE, _VAR_BLOCK_RE, "var"),
        ):
            # Single-line: const/var Foo = ...
            m = single_re.match(stripped)
            if m:
                symbols.append(Symbol(name=m.group(1), kind=kind, line=i + 1, end_line=i + 1, signature=line.rstrip()[:200]))
                i += 1
                break

            # Block: const/var (
            if block_re.match(stripped):
                block_syms, i = _scan_decl_block(lines, i + 1, kind)
                symbols.extend(block_syms)
                break
        else:
            i += 1

    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Go file."""
    collected = common.collect_symbols_and_refs(
        source, "go", rel_path, _LOG, common.CALL_RE, _CALL_NOISE
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

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

    common.add_imports(imp_exp, result.imports, _extract_go_import_target)  # type: ignore[attr-defined]

    return symbols, refs, imp_exp, []
