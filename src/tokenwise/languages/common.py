"""Shared utilities for language-specific symbol extractors."""
from __future__ import annotations

import re

# Base mapping shared by most languages (Go, TypeScript, Python)
_BASE_KIND_STR_MAPPING = {
    "Function": "function",
    "Method": "method",
    "Class": "class",
    "Struct": "type",
    "Interface": "interface",
    "Enum": "enum",
    "Trait": "interface",
    "Impl": "class",
    "Module": "const",
    "Namespace": "const",
    "Other": "var",
}

# Python-specific mapping (uses same base plus "Method")
_PYTHON_KIND_STR_MAPPING = _BASE_KIND_STR_MAPPING

# Rust-specific overrides (Impl -> impl, Module -> module, Namespace -> module)
_RUST_KIND_STR_MAPPING = {
    **_BASE_KIND_STR_MAPPING,
    "Impl": "impl",
    "Module": "module",
    "Namespace": "module",
}

# Base mapping shared by all languages
_BASE_SYM_KIND_STR_MAPPING = {
    "Function": "function",
    "Class": "class",
    "Interface": "interface",
    "Type": "type",
    "Enum": "enum",
    "Constant": "const",
    "Variable": "var",
    "Module": "const",
    "Other": "var",
}

# Rust-specific overrides (Module -> module)
_RUST_SYM_KIND_STR_MAPPING = {
    **_BASE_SYM_KIND_STR_MAPPING,
    "Module": "module",
}


def kind_str(structure_kind: object, language: str = "go") -> str:
    """Convert tree-sitter StructureKind to canonical kind string.

    Supports language-specific overrides for Impl, Module, Namespace mappings.
    Python, Go, TypeScript use base mapping; Rust has overrides.
    """
    s = str(structure_kind).split(".")[-1]
    mapping = _RUST_KIND_STR_MAPPING if language == "rust" else _BASE_KIND_STR_MAPPING
    return mapping.get(s, "var")


def sym_kind_str(sym_kind: object, language: str = "go") -> str:
    """Convert tree-sitter SymbolKind to canonical kind string.

    Supports language-specific overrides for Module mappings.
    """
    s = str(sym_kind).split(".")[-1]
    mapping = _RUST_SYM_KIND_STR_MAPPING if language == "rust" else _BASE_SYM_KIND_STR_MAPPING
    return mapping.get(s, "var")


def get_tlp() -> object | None:
    """Return the tree_sitter_language_pack module, or None if not installed."""
    try:
        import tree_sitter_language_pack as tlp  # noqa: PLC0415
    except ModuleNotFoundError:
        return None
    return tlp


def build_signature(source: bytes, item_span: object, body_span: object | None) -> str | None:
    """Extract declaration header (before body brace/colon) from raw source bytes.

    Returns at most 200 characters of the header, or None if unavailable.
    """
    if body_span is None:
        return None
    try:
        header = source[item_span.start_byte : body_span.start_byte]  # type: ignore[union-attr]
        text = header.decode("utf-8", errors="replace").strip()
        if len(text) > 200:
            text = text[:200]
        return text or None
    except (IndexError, AttributeError):
        return None


def extract_refs_from_source(
    source: bytes,
    call_re: re.Pattern[str],
    call_noise: frozenset[str],
) -> list[object]:
    """Extract call-site refs using regex on the source text.

    Shared implementation for all language adapters.  Each adapter supplies its
    own ``call_re`` (identifier pattern) and ``call_noise`` (builtins to skip).

    Returns a list of :class:`~tokenwise.parser.Ref` objects.  The return type
    is ``list[object]`` to avoid a circular import; callers type-narrow as needed.
    """
    from ..parser import Ref  # noqa: PLC0415

    refs: list[object] = []
    seen: set[tuple[str, int]] = set()
    text = source.decode("utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in call_re.finditer(line):
            name = m.group(1)
            if name in call_noise or len(name) <= 1:
                continue
            key = (name, lineno)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Ref(name=name, line=lineno, col=m.start(1), context=line.strip()[:120]))
    return refs
