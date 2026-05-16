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
    text = source.decode("utf-8", errors="replace")
    tlp, cfg = common.make_process_config(language="rust")
    if tlp is None:
        return [], [], [], []
    try:
        result = tlp.process(text, cfg)
    except Exception:  # noqa: BLE001
        _LOG.debug("tree-sitter parse failed for rust source: %s", rel_path, exc_info=True)
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    # --- structure: functions, structs, enums, traits, impls, methods ---
    def _add_symbol(item: object, parent_name: str | None = None) -> None:
        """Recursively walk a tree-sitter node and append named Rust symbols to *symbols*.

        Rust-specific behaviour:
        - ``impl`` blocks are recorded once under the type name, then their
          children (methods) are recursed with ``parent_name`` set to that type.
        - Plain ``impl TypeName`` blocks without a trait are still recorded so
          that symbol lookups on the type name work correctly.
        - Functions nested inside an ``impl`` block are promoted to
          ``kind="method"`` for cleaner display in ``token-goat symbol`` output.
        - Unnamed nodes are transparently descended into (same as common adapter).
        """
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
    common.add_symbol_info(symbols, seen_names, result.symbols, language="rust")

    # --- imports (use declarations) ---
    common.add_imports(
        imp_exp,
        result.imports,
        lambda imp: _parse_use_target(imp.source),  # type: ignore[attr-defined]
    )

    # --- refs ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)

    return symbols, refs, imp_exp, []
