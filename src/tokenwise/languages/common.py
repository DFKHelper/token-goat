"""Shared utilities for language-specific symbol extractors."""
from __future__ import annotations

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
    """Convert tlp StructureKind to our kind string.

    Supports language-specific overrides for Impl, Module, Namespace mappings.
    Python, Go, TypeScript use base mapping; Rust has overrides.
    """
    s = str(structure_kind).split(".")[-1]
    mapping = _RUST_KIND_STR_MAPPING if language == "rust" else _BASE_KIND_STR_MAPPING
    return mapping.get(s, "var")


def sym_kind_str(sym_kind: object, language: str = "go") -> str:
    """Convert tlp SymbolKind to our kind string.

    Supports language-specific overrides for Module mappings.
    """
    s = str(sym_kind).split(".")[-1]
    mapping = _RUST_SYM_KIND_STR_MAPPING if language == "rust" else _BASE_SYM_KIND_STR_MAPPING
    return mapping.get(s, "var")
