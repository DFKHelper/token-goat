"""Java symbol extractor using tree_sitter_language_pack.

Extracts classes, interfaces, enums, annotation types, and their methods.
A secondary regex pass surfaces additional symbols not covered by tree-sitter
(anonymous inner classes, static initializers, lambda assignments).
``import`` statements are parsed into :class:`~token_goat.parser.ImpExp` rows.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.java")

_CALL_NOISE = frozenset([
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this",
    "instanceof", "assert", "break", "continue", "finally", "try", "else",
    "int", "long", "double", "float", "boolean", "char", "byte", "short", "void",
    "String", "Object", "Class", "System", "Math", "Arrays", "Collections",
    "List", "Map", "Set", "Optional", "Stream",
    "null", "true", "false",
    "println", "print", "printf", "format",
    "equals", "hashCode", "toString", "getClass",
    "get", "set", "add", "remove", "size", "isEmpty", "contains",
    "length", "charAt", "substring", "indexOf", "startsWith", "endsWith",
])

_IMPORT_RE = re.compile(r"^import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)")

_CONST_RE = re.compile(
    r"^\s+(?:public\s+|protected\s+|private\s+)?static\s+final\s+"
    r"(?:[A-Za-z_][A-Za-z0-9_<>\[\],\s]*?)\s+"
    r"([A-Z_][A-Z0-9_]*)\s*[=;]"
)

_CONSTRUCTOR_RE = re.compile(
    r"^\s+(?:public\s+|protected\s+|private\s+)?([A-Z][A-Za-z0-9_]*)\s*\("
)

_ANNOTATION_TYPE_RE = re.compile(r"^(?:public\s+)?@interface\s+([A-Za-z_][A-Za-z0-9_]*)")


def _extract_java_extras(source: bytes, class_names: frozenset[str]) -> list[Symbol]:
    return common.safe_regex_parse(_extract_java_extras_inner, source, class_names, log=_LOG, label="_extract_java_extras")  # type: ignore[return-value]


def _extract_java_extras_inner(source: bytes, class_names: frozenset[str]) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()
    current_class: str | None = None
    brace_depth = 0
    class_start_depth: int = 0

    _CLASS_HEADER_RE = re.compile(
        r"^(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*"
        r"(?:class|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)"
    )

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        m = _ANNOTATION_TYPE_RE.match(line)
        if m:
            symbols.append(Symbol(
                name=m.group(1),
                kind="interface",
                line=i,
                end_line=i,
                signature=line.rstrip()[:200],
            ))

        cm = _CLASS_HEADER_RE.match(line)
        if cm:
            cname = cm.group(1)
            if cname in class_names and current_class is None:
                current_class = cname
                class_start_depth = brace_depth

        if current_class is not None:
            depth_in_class = brace_depth - class_start_depth
            if depth_in_class == 1:
                const_m = _CONST_RE.match(line)
                if const_m:
                    symbols.append(Symbol(
                        name=const_m.group(1),
                        kind="const",
                        line=i,
                        end_line=i,
                        signature=stripped[:200],
                        parent_name=current_class,
                    ))

                ctor_m = _CONSTRUCTOR_RE.match(line)
                if ctor_m and ctor_m.group(1) == current_class:
                    sig_end = line.find("{")
                    sig = line[:sig_end].rstrip() if sig_end >= 0 else line.rstrip()
                    symbols.append(Symbol(
                        name=current_class,
                        kind="method",
                        line=i,
                        end_line=i,
                        signature=sig[:200] if sig else None,
                        parent_name=current_class,
                    ))

        brace_depth += line.count("{") - line.count("}")

        if current_class is not None and brace_depth <= class_start_depth:
            current_class = None

    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Java source file.

    Uses the ``java`` tree-sitter grammar.  After the tree-sitter pass, a
    secondary regex scan adds symbols tree-sitter does not surface on its own
    (e.g. anonymous classes, static initializers, lambda field assignments).
    ``import`` statements are converted to :class:`~token_goat.parser.ImpExp`
    rows with fully-qualified target names.  Sections are not produced.

    :param source: Raw file bytes (UTF-8 encoding assumed; errors are replaced).
    :param rel_path: Project-relative path used for logging and symbol metadata.
    :return: ``(symbols, refs, imports, sections)`` — sections is always empty.
    """
    collected = common.collect_symbols_and_refs(
        source, "java", rel_path, _LOG, common.CALL_RE, _CALL_NOISE
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    class_names = frozenset(s.name for s in symbols if s.kind in ("class", "enum", "interface") and s.name)

    common.merge_extra_symbols(symbols, seen_names, _extract_java_extras(source, class_names))

    common.add_imports(
        imp_exp,
        result.imports,  # type: ignore[attr-defined]
        lambda imp: _extract_import_target(imp),
    )

    _LOG.debug(
        "java extract: %s → symbols=%d refs=%d imports=%d",
        rel_path,
        len(symbols),
        len(refs),
        len(imp_exp),
    )
    return symbols, refs, imp_exp, []


def _extract_import_target(imp: object) -> str:
    src = getattr(imp, "source", None)
    if not src:
        return ""
    src = src.strip()
    m = _IMPORT_RE.match(src)
    return m.group(1) if m else ""
