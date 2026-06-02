"""Kotlin symbol extractor using regex-based heuristics.

Extracts classes, interfaces, objects, data classes, sealed classes,
companion objects, functions, properties, and ``import`` statements.
Tree-sitter is not used for Kotlin; the entire extraction is regex-driven
against the raw source bytes.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.kotlin")

_CALL_NOISE = frozenset([
    "if", "for", "while", "when", "return", "throw", "try", "catch", "finally",
    "is", "as", "in", "by", "to", "and", "or", "not", "also", "let", "run",
    "apply", "with", "takeIf", "takeUnless", "repeat",
    "println", "print", "error", "check", "require",
    "Int", "Long", "Double", "Float", "Boolean", "Char", "Byte", "Short", "String",
    "Unit", "Any", "Nothing", "Pair", "Triple",
    "List", "Map", "Set", "Array", "MutableList", "MutableMap", "MutableSet",
    "listOf", "mapOf", "setOf", "arrayOf", "mutableListOf", "mutableMapOf",
    "emptyList", "emptyMap", "emptySet",
    "null", "true", "false", "it", "this", "super",
    "get", "set", "add", "remove", "size", "isEmpty", "contains",
    "equals", "hashCode", "toString", "copy", "component1", "component2",
])

_IMPORT_RE = re.compile(r"^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)")

_FUN_RE = re.compile(
    r"^\s*(?:(?:public|internal|protected|private|open|override|abstract|"
    r"suspend|inline|infix|operator|external|actual|expect|final|sealed)\s+)*"
    r"fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]"
)

_CONST_RE = re.compile(
    r"^\s+(?:(?:public|internal|protected|private|open|override|abstract|"
    r"final|actual|expect|const|lateinit|companion)\s+)*"
    r"(?:const\s+)?val\s+([A-Z_][A-Z0-9_]*)\s*(?::|=)"
)

_CLASS_HEADER_RE = re.compile(
    r"^(?:(?:public|internal|protected|private|open|abstract|sealed|data|"
    r"inner|expect|actual|value|annotation)\s+)*"
    r"(?:class|interface|object|enum\s+class)\s+([A-Za-z_][A-Za-z0-9_]*)"
)

_TOP_FUN_RE = re.compile(
    r"^(?:(?:public|internal|private|suspend|inline|infix|operator|"
    r"external|actual|expect)\s+)*"
    r"fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]"
)


def _extract_kotlin_symbols(source: bytes) -> list[Symbol]:
    return common.safe_regex_parse(_extract_kotlin_symbols_inner, source, log=_LOG, label="_extract_kotlin_symbols")  # type: ignore[return-value]


def _extract_kotlin_symbols_inner(source: bytes) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    current_class: str | None = None
    class_brace_depth: int = 0
    brace_depth = 0

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            brace_depth += line.count("{") - line.count("}")
            continue

        is_indented = line[:1] in (" ", "\t")

        cm = _CLASS_HEADER_RE.match(line) if not is_indented else None
        if cm:
            cname = cm.group(1)
            symbols.append(Symbol(
                name=cname,
                kind="class",
                line=i,
                end_line=i,
                signature=line.rstrip()[:200],
            ))
            current_class = cname
            class_brace_depth = brace_depth

        if current_class is not None:
            depth_in_class = brace_depth - class_brace_depth
            if depth_in_class >= 1:
                fm = _FUN_RE.match(line)
                if fm:
                    fname = fm.group(1)
                    sig_end = line.find("{")
                    sig = line[:sig_end].strip() if sig_end >= 0 else line.rstrip()
                    symbols.append(Symbol(
                        name=fname,
                        kind="method",
                        line=i,
                        end_line=i,
                        signature=sig[:200] if sig else None,
                        parent_name=current_class,
                    ))

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

        elif not is_indented:
            tfm = _TOP_FUN_RE.match(line)
            if tfm:
                fname = tfm.group(1)
                sig_end = line.find("{")
                sig = line[:sig_end].strip() if sig_end >= 0 else line.rstrip()
                symbols.append(Symbol(
                    name=fname,
                    kind="function",
                    line=i,
                    end_line=i,
                    signature=sig[:200] if sig else None,
                ))

        brace_depth += line.count("{") - line.count("}")

        if current_class is not None and brace_depth <= class_brace_depth:
            current_class = None

    return symbols


def _extract_kotlin_imports(source: bytes) -> list[ImpExp]:
    imports: list[ImpExp] = []
    text = source.decode("utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        m = _IMPORT_RE.match(line.strip())
        if m:
            imports.append(ImpExp(kind="import", target=m.group(1), line=i))
    return imports


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Kotlin source file.

    Uses a regex-based pipeline (no tree-sitter grammar for Kotlin).
    :func:`_extract_kotlin_symbols` handles ``class``, ``interface``,
    ``object``, ``fun``, and ``val``/``var`` declarations at any nesting level.
    Refs are extracted by scanning call-like patterns against ``_CALL_NOISE``.
    ``import`` directives become :class:`~token_goat.parser.ImpExp` rows.
    Sections are not produced (returns ``[]``).

    :param source: Raw file bytes (UTF-8 encoding assumed; errors are replaced).
    :param rel_path: Project-relative path used for logging and symbol metadata.
    :return: ``(symbols, refs, imports, sections)`` — sections is always empty.
    """
    symbols = _extract_kotlin_symbols(source)
    refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE)
    imp_exp = _extract_kotlin_imports(source)

    _LOG.debug(
        "kotlin extract: %s → symbols=%d refs=%d imports=%d",
        rel_path,
        len(symbols),
        len(refs),
        len(imp_exp),
    )
    return symbols, refs, imp_exp, []
