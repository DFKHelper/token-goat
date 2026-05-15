"""Rust symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.rust")


# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

_CALL_NOISE = frozenset([
    "println", "print", "eprintln", "eprint", "format", "write", "writeln",
    "vec", "Vec", "String", "Some", "None", "Ok", "Err", "Box", "Arc", "Rc",
    "Option", "Result",
    "if", "for", "while", "loop", "match", "let", "fn", "mut", "impl", "trait",
    "return", "break", "continue", "self", "Self", "super", "crate",
    "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
    "f32", "f64", "bool", "char", "str",
])

# Regex: identifier NOT preceded by . or -> that is immediately followed by (
_CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")

# Regex to extract target path from a `use ...;` line
_USE_PATH_RE = re.compile(r"^use\s+([^;{]+)")


def _parse_use_target(source_line: str) -> str:
    """Extract the path from a `use path::to::Item;` source line."""
    line = source_line.strip()
    # Strip leading 'use ' and trailing ';'
    m = _USE_PATH_RE.match(line)
    if m:
        path = m.group(1).strip().rstrip(";").strip()
        return path
    return line


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Rust file."""
    tlp = common.get_tlp()
    if tlp is None:
        return [], [], [], []

    text = source.decode("utf-8", errors="replace")
    cfg = tlp.ProcessConfig(
        language="rust",
        structure=True,
        imports=True,
        exports=False,
        symbols=True,
    )
    try:
        result = tlp.process(text, cfg)
    except Exception:
        _LOG.debug("tree-sitter parse failed for rust source", exc_info=True)
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    # --- structure: functions, structs, enums, traits, impls, methods ---
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
        kind = common.kind_str(item.kind, language="rust")

        # Children of an impl block are methods
        effective_kind = kind
        if parent_name is not None and kind == "function":
            effective_kind = "method"

        sig = common.build_signature(source, span, body_span)

        # For impl blocks, record as "impl" only if it has a trait (Display, etc.)
        # For plain `impl TypeName`, record as impl with the type as name
        if kind == "impl":
            # name is the type being impl'd — record it so symbol lookups work
            key = (name, line)
            if key not in seen_names:
                seen_names.add(key)
                symbols.append(
                    Symbol(
                        name=name,
                        kind="impl",
                        line=line,
                        end_line=end_line,
                        signature=sig,
                        parent_name=parent_name,
                    )
                )
            # Recurse into children (the methods)
            for child in item.children:  # type: ignore[attr-defined]
                _add_symbol(child, parent_name=name)
            return

        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=effective_kind,
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

    # --- symbols from SymbolInfo (const, static, module-level items) ---
    for sym in result.symbols:
        name: str = sym.name  # type: ignore[attr-defined]
        span = sym.span
        line = span.start_line + 1
        kind = common.sym_kind_str(sym.kind, language="rust")
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

    # --- imports (use declarations) ---
    for imp in result.imports:
        target = _parse_use_target(imp.source)
        line = imp.span.start_line + 1
        imp_exp.append(ImpExp(kind="import", target=target, line=line))

    # --- refs ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)

    return symbols, refs, imp_exp, []
