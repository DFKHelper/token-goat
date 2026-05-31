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

# Interface block header: `type Foo interface {`
_IFACE_HEADER_RE = re.compile(r"^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{")

# Interface method signature line: starts with an identifier followed by `(`
# Must be indented (not at column 0) to distinguish from top-level decls.
# Group 1 = method name; group 2 = everything from `(` to end of line (signature).
_IFACE_METHOD_RE = re.compile(r"^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.*)")

# Receiver method declaration: `func (recv ReceiverType) MethodName`
# Group 1 = receiver type (pointer stripped); group 2 = method name.
_RECEIVER_RE = re.compile(r"^func\s*\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+([A-Za-z_][A-Za-z0-9_]*)")

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
    return common.safe_regex_parse(_extract_const_var_inner, source, log=_LOG, label="_extract_const_var")  # type: ignore[return-value]


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


def _extract_interface_methods(source: bytes) -> list[Symbol]:
    """Extract method signatures from Go interface bodies as individual symbols.

    Tree-sitter's SymbolInfo pass surfaces only the interface name (e.g. ``Handler``),
    not the individual methods declared inside it (e.g. ``Serve``).  This regex pass
    walks each ``type Foo interface { ... }`` block and emits one Symbol per method
    with ``parent_name`` set to the enclosing interface name.

    Only callable method signatures (lines matching ``MethodName(``) are collected;
    embedded interface names (e.g. ``Reader`` inside ``ReadWriter``) are skipped.
    """
    return common.safe_regex_parse(_extract_interface_methods_inner, source, log=_LOG, label="_extract_interface_methods")  # type: ignore[return-value]


def _extract_interface_methods_inner(source: bytes) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()
    n = len(lines)
    i = 0
    while i < n:
        m = _IFACE_HEADER_RE.match(lines[i])
        if m:
            iface_name = m.group(1)
            depth = 1
            j = i + 1
            while j < n and depth > 0:
                line = lines[j]
                depth += line.count("{") - line.count("}")
                if depth > 0:
                    mm = _IFACE_METHOD_RE.match(line)
                    if mm:
                        method_name = mm.group(1)
                        sig_tail = mm.group(2).strip()
                        sig = f"{method_name}({sig_tail[1:]}"[:200] if sig_tail.startswith("(") else None
                        symbols.append(Symbol(
                            name=method_name,
                            kind="method",
                            line=j + 1,
                            end_line=j + 1,
                            signature=sig,
                            parent_name=iface_name,
                        ))
                j += 1
            i = j
        else:
            i += 1
    return symbols


def _set_receiver_parents(symbols: list[Symbol], source: bytes) -> None:
    """Set ``parent_name`` on receiver methods that tree-sitter left unparented.

    Tree-sitter's structure walk emits ``func (s *Server) Run()`` as a ``Method``
    node but does not populate the receiver type as ``parent_name``.  We scan the
    source for receiver declarations and match each one against the symbols list
    by name and line proximity, setting ``parent_name`` to the receiver type.
    """
    try:
        text = source.decode("utf-8", errors="replace")
    except (UnicodeDecodeError, AttributeError):
        return
    lines = text.splitlines()
    receiver_by_name: dict[tuple[str, int], str] = {}
    for i, line in enumerate(lines):
        m = _RECEIVER_RE.match(line)
        if m:
            receiver_type = m.group(1)
            method_name = m.group(2)
            receiver_by_name[(method_name, i + 1)] = receiver_type

    for sym in symbols:
        if sym.kind == "method" and sym.parent_name is None:
            parent = receiver_by_name.get((sym.name, sym.line))
            if parent:
                sym.parent_name = parent


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Go file."""
    collected = common.collect_symbols_and_refs(
        source, "go", rel_path, _LOG, common.CALL_RE, _CALL_NOISE
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    # --- const/var (not surfaced by tlp) ---
    common.merge_extra_symbols(symbols, seen_names, _extract_const_var(source))

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

    # --- interface methods (not surfaced by tlp structure/symbols walk) ---
    common.merge_extra_symbols(symbols, seen_names, _extract_interface_methods(source))

    # --- receiver method parent tracking ---
    _set_receiver_parents(symbols, source)

    return symbols, refs, imp_exp, []
