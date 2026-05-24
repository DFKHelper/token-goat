"""Rust symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.rust")


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
    # promote_methods=True: functions nested inside an impl block (parent_name set)
    # are recorded with kind="method". common.kind_str("Impl", language="rust")
    # returns "impl" so impl blocks are recorded correctly without special-casing here.
    collected = common.collect_symbols_and_refs(
        source, "rust", rel_path, _LOG, common.CALL_RE, _CALL_NOISE, promote_methods=True
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, _seen_names, refs, result = collected

    # --- imports (use declarations) ---
    common.add_imports(
        imp_exp,
        result.imports,  # type: ignore[attr-defined]
        lambda imp: _parse_use_target(imp.source),  # type: ignore[attr-defined]
    )

    _LOG.debug(
        "rust extract: %s → symbols=%d refs=%d imports=%d",
        rel_path,
        len(symbols),
        len(refs),
        len(imp_exp),
    )
    return symbols, refs, imp_exp, []
