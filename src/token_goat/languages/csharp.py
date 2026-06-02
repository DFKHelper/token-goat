"""C# symbol extractor using tree_sitter_language_pack.

Extracts classes, interfaces, enums, structs, records, delegates, methods,
properties, and ``using`` import directives.  Extra symbols (constructors,
static members, constants, events, and indexers not surfaced by tree-sitter)
are discovered by a secondary regex pass.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.csharp")

_CALL_NOISE = frozenset([
    "if", "for", "foreach", "while", "switch", "catch", "return", "throw", "new",
    "base", "this", "typeof", "sizeof", "default", "is", "as", "in", "out", "ref",
    "break", "continue", "try", "else", "finally", "using", "await", "async",
    "int", "long", "double", "float", "bool", "char", "byte", "short", "void", "string",
    "var", "object", "dynamic", "decimal", "uint", "ulong", "ushort", "sbyte",
    "String", "Object", "Console", "Math", "Task", "List", "Dictionary", "Array",
    "Enumerable", "Linq", "Exception", "Convert", "Type", "Enum", "Nullable",
    "IEnumerable", "IList", "ICollection", "IDictionary",
    "null", "true", "false",
    "ToString", "Equals", "GetHashCode", "GetType",
    "Add", "Remove", "Contains", "Count", "Length", "First", "Last",
    "Where", "Select", "OrderBy", "GroupBy", "Join",
    "WriteLine", "Write", "ReadLine", "Format",
])

_USING_RE = re.compile(r"^using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;")

# namespace declaration
_NAMESPACE_RE = re.compile(
    r"^(?:namespace\s+)([A-Za-z_][A-Za-z0-9_.]*)"
)

# property: optional modifiers + type + name + { get; (set;)? }
_PROPERTY_RE = re.compile(
    r"^\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\s+)*"
    r"(?:[A-Za-z_][A-Za-z0-9_<>?,\[\]\s]*?)\s+"
    r"([A-Z][A-Za-z0-9_]*)\s*\{[^}]*(?:get|set)"
)

# delegate declaration
_DELEGATE_RE = re.compile(
    r"^\s*(?:public|protected|private|internal)?\s*delegate\s+"
    r"(?:[A-Za-z_][A-Za-z0-9_<>?,\[\]\s]*?)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*[<(]"
)

# constructor: ClassName(
_CONSTRUCTOR_RE = re.compile(
    r"^\s+(?:(?:public|protected|private|internal|static)\s+)+"
    r"([A-Z][A-Za-z0-9_]*)\s*\("
)


def _extract_extras(source: bytes, class_names: frozenset[str]) -> list[Symbol]:
    return common.safe_regex_parse(_extract_extras_inner, source, class_names, log=_LOG, label="_extract_extras")  # type: ignore[return-value]


def _extract_extras_inner(source: bytes, class_names: frozenset[str]) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    current_class: str | None = None
    brace_depth = 0
    class_start_depth = 0

    _CLASS_HEADER_RE = re.compile(
        r"^(?:(?:public|protected|private|internal|abstract|sealed|static|partial)\s+)*"
        r"(?:class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)"
    )

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # namespace
        ns_m = _NAMESPACE_RE.match(stripped)
        if ns_m:
            symbols.append(Symbol(
                name=ns_m.group(1),
                kind="const",
                line=i,
                end_line=i,
                signature=stripped[:200],
            ))

        # delegate
        del_m = _DELEGATE_RE.match(stripped)
        if del_m:
            symbols.append(Symbol(
                name=del_m.group(1),
                kind="interface",
                line=i,
                end_line=i,
                signature=stripped[:200],
            ))

        # track class context for constructor/property detection
        cm = _CLASS_HEADER_RE.match(stripped)
        if cm:
            cname = cm.group(1)
            if cname in class_names and current_class is None:
                current_class = cname
                class_start_depth = brace_depth

        if current_class is not None:
            depth_in_class = brace_depth - class_start_depth
            if depth_in_class == 1:
                # constructor
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
                # property
                prop_m = _PROPERTY_RE.match(line)
                if prop_m:
                    symbols.append(Symbol(
                        name=prop_m.group(1),
                        kind="var",
                        line=i,
                        end_line=i,
                        signature=stripped[:200],
                        parent_name=current_class,
                    ))

        brace_depth += line.count("{") - line.count("}")
        if current_class is not None and brace_depth <= class_start_depth:
            current_class = None

    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a C# source file.

    Uses the ``csharp`` tree-sitter grammar.  After the main tree-sitter pass,
    a secondary regex scan adds constructors, static fields, constants, events,
    and indexers that tree-sitter does not surface individually.  ``using``
    directives become :class:`~token_goat.parser.ImpExp` import rows.
    Method promotion is enabled so instance methods on classes bubble up to
    top-level symbol visibility.  Sections are not produced (returns ``[]``).

    :param source: Raw file bytes (UTF-8 encoding assumed; errors are replaced).
    :param rel_path: Project-relative path used for logging and symbol metadata.
    :return: ``(symbols, refs, imports, sections)`` — sections is always empty.
    """
    collected = common.collect_symbols_and_refs(
        source, "csharp", rel_path, _LOG, common.CALL_RE, _CALL_NOISE, promote_methods=True
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    class_names = frozenset(s.name for s in symbols if s.kind in ("class", "enum", "interface", "type") and s.name)

    common.merge_extra_symbols(symbols, seen_names, _extract_extras(source, class_names))

    # using imports
    text = source.decode("utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        m = _USING_RE.match(line)
        if m:
            target = m.group(1).strip()
            if target:
                imp_exp.append(ImpExp(kind="import", target=target, line=i))

    _LOG.debug(
        "csharp extract: %s → symbols=%d refs=%d imports=%d",
        rel_path,
        len(symbols),
        len(refs),
        len(imp_exp),
    )
    return symbols, refs, imp_exp, []
