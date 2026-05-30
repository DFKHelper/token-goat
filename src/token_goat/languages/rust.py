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

# Trait block header: `pub trait Foo {` or `trait Foo<T> {`
_TRAIT_HEADER_RE = re.compile(r"^(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)")

# Trait method signature line: `fn method_name(` — may be indented, may have modifiers
_TRAIT_METHOD_RE = re.compile(r"^\s+(?:(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(\(.*)")

# Top-level static declaration: `pub static [mut] NAME: ...` or `static [mut] NAME: ...`
_STATIC_RE = re.compile(r"^(?:pub(?:\s*\([^)]*\))?\s+)?static\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:")


def _parse_use_target(source_line: str) -> str:
    line = source_line.strip()
    m = _USE_PATH_RE.match(line)
    if m:
        path = m.group(1).strip().rstrip(";").strip()
        return path
    return line


def _extract_trait_methods(source: bytes) -> list[Symbol]:
    try:
        return _extract_trait_methods_inner(source)
    except (re.error, ValueError, IndexError) as exc:
        _LOG.debug("_extract_trait_methods: parse error: %s", exc, exc_info=True)
        return []


def _extract_trait_methods_inner(source: bytes) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()
    n = len(lines)
    i = 0
    while i < n:
        m = _TRAIT_HEADER_RE.match(lines[i])
        if m:
            trait_name = m.group(1)
            depth = lines[i].count("{") - lines[i].count("}")
            j = i + 1
            while j < n and depth > 0:
                line = lines[j]
                depth += line.count("{") - line.count("}")
                if depth > 0:
                    mm = _TRAIT_METHOD_RE.match(line)
                    if mm:
                        method_name = mm.group(1)
                        sig_tail = mm.group(2).strip()
                        sig_text = f"fn {method_name}({sig_tail[1:]}"[:200] if sig_tail.startswith("(") else None
                        symbols.append(Symbol(
                            name=method_name,
                            kind="method",
                            line=j + 1,
                            end_line=j + 1,
                            signature=sig_text,
                            parent_name=trait_name,
                        ))
                j += 1
            i = j
        else:
            i += 1
    return symbols


def _extract_statics(source: bytes) -> list[Symbol]:
    try:
        return _extract_statics_inner(source)
    except (re.error, ValueError, IndexError) as exc:
        _LOG.debug("_extract_statics: parse error: %s", exc, exc_info=True)
        return []


def _extract_statics_inner(source: bytes) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        if line.startswith((" ", "\t")):
            continue
        m = _STATIC_RE.match(line)
        if m:
            symbols.append(Symbol(
                name=m.group(1),
                kind="const",
                line=i,
                end_line=i,
                signature=line.rstrip()[:200],
            ))
    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    collected = common.collect_symbols_and_refs(
        source, "rust", rel_path, _LOG, common.CALL_RE, _CALL_NOISE, promote_methods=True
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    # --- imports (use declarations) ---
    common.add_imports(
        imp_exp,
        result.imports,  # type: ignore[attr-defined]
        lambda imp: _parse_use_target(imp.source),  # type: ignore[attr-defined]
    )

    # --- trait method signatures (tree-sitter doesn't surface these individually) ---
    for trait_sym in _extract_trait_methods(source):
        key = (trait_sym.name, trait_sym.line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(trait_sym)

    # --- static declarations (tree-sitter misses `static [mut] NAME: ...`) ---
    for static_sym in _extract_statics(source):
        key = (static_sym.name, static_sym.line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(static_sym)

    _LOG.debug(
        "rust extract: %s → symbols=%d refs=%d imports=%d",
        rel_path,
        len(symbols),
        len(refs),
        len(imp_exp),
    )
    return symbols, refs, imp_exp, []
