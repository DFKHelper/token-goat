"""Ruby symbol extractor using tree_sitter_language_pack.

Extracts modules, classes, methods (``def``), singleton methods, constants,
and attribute accessors.  A secondary regex pass adds ``require`` /
``require_relative`` calls as :class:`~token_goat.parser.ImpExp` import rows.
Method promotion is enabled so instance methods surface at the top of the
symbol list for easy ``token-goat symbol`` lookup.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.ruby")

_CALL_NOISE = frozenset([
    "if", "unless", "while", "until", "for", "case", "when", "then",
    "do", "begin", "rescue", "ensure", "raise", "return", "break", "next", "retry",
    "yield", "super", "self", "nil", "true", "false",
    "puts", "print", "p", "pp", "require", "require_relative", "include", "extend",
    "attr_reader", "attr_writer", "attr_accessor", "private", "protected", "public",
    "new", "class", "module", "def", "end", "and", "or", "not",
    "Integer", "String", "Array", "Hash", "Symbol", "Float", "Numeric",
    "Object", "Class", "Module", "Kernel",
    "map", "each", "select", "reject", "find", "inject", "reduce",
    "push", "pop", "shift", "unshift", "first", "last", "length", "size",
    "empty", "any", "all", "none", "count",
    "to_s", "to_i", "to_f", "to_a", "to_h", "inspect",
])

# module/class/struct declaration
_MODULE_RE = re.compile(r"^module\s+([A-Za-z_][A-Za-z0-9_:]*)")
_CLASS_RE = re.compile(r"^class\s+([A-Za-z_][A-Za-z0-9_:]*)(?:\s*<\s*[A-Za-z_][A-Za-z0-9_:]*)?")
_STRUCT_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Struct\.new\b")

# method declaration: def name or def self.name
_DEF_RE = re.compile(
    r"^(?P<indent>\s*)def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)\s*(?:\(|$)"
)

# constant (all-caps identifier at start of line or after module depth)
_CONST_RE = re.compile(r"^(?:\s+)?([A-Z][A-Z0-9_]{2,})\s*=(?!=)")

# require/require_relative
_REQUIRE_RE = re.compile(r"^require(?:_relative)?\s+['\"]([^'\"]+)['\"]")

# attr_accessor/reader/writer: attr_accessor :name, :other
_ATTR_RE = re.compile(r"^\s+attr_(?:accessor|reader|writer)\s+(.+)$")
_SYMBOL_RE = re.compile(r":([A-Za-z_][A-Za-z0-9_?!]*)")


def _extract_extras(source: bytes, seen_names: set[tuple[str, int]]) -> list[Symbol]:
    return common.safe_regex_parse(_extract_extras_inner, source, seen_names, log=_LOG, label="_extract_extras")  # type: ignore[return-value]


def _extract_extras_inner(source: bytes, seen_names: set[tuple[str, int]]) -> list[Symbol]:
    symbols: list[Symbol] = []
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    # context stack: list of (name, indent_level) pairs
    context_stack: list[tuple[str, int]] = []

    def current_class() -> str | None:
        for name, _ in reversed(context_stack):
            return name
        return None

    def base_indent() -> int:
        if context_stack:
            return context_stack[-1][1]
        return -1

    add = common.make_add_fn(symbols, seen_names)

    for i, raw_line in enumerate(lines, 1):
        line = raw_line.rstrip()
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip())

        # pop context when we're back to or above the class/module level
        while context_stack and indent <= context_stack[-1][1] and stripped == "end":
            context_stack.pop()

        # module
        mod_m = _MODULE_RE.match(stripped)
        if mod_m:
            name = mod_m.group(1).split("::")[-1]
            add(name, "const", i, stripped[:200])
            context_stack.append((name, indent))
            continue

        # class
        cls_m = _CLASS_RE.match(stripped)
        if cls_m:
            name = cls_m.group(1).split("::")[-1]
            add(name, "class", i, stripped[:200])
            context_stack.append((name, indent))
            continue

        # Struct.new assignment
        st_m = _STRUCT_RE.match(line)
        if st_m:
            add(st_m.group(1), "type", i, stripped[:200])
            continue

        # method
        def_m = _DEF_RE.match(raw_line)
        if def_m:
            name = def_m.group(2)
            sig_end = stripped.find(")")
            sig = stripped[:sig_end + 1] if sig_end >= 0 else stripped
            parent = current_class()
            kind = "method" if parent else "function"
            add(name, kind, i, sig[:200], parent=parent)
            continue

        # constant
        const_m = _CONST_RE.match(line)
        if const_m:
            name = const_m.group(1)
            if name not in _CALL_NOISE:
                add(name, "const", i, stripped[:200], parent=current_class())
            continue

        # attr_accessor/reader/writer — emit as property symbols
        attr_m = _ATTR_RE.match(line)
        if attr_m:
            parent = current_class()
            for sym_m in _SYMBOL_RE.finditer(attr_m.group(1)):
                attr_name = sym_m.group(1)
                add(attr_name, "var", i, parent=parent)

    return symbols


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a Ruby source file.

    Uses the ``ruby`` tree-sitter grammar with method promotion enabled so
    instance methods on classes surface at top-level symbol visibility.  A
    secondary pass via :func:`_extract_extras` catches additional patterns
    not covered by tree-sitter.  ``require`` / ``require_relative`` lines are
    parsed into :class:`~token_goat.parser.ImpExp` import rows.  Sections are
    not produced (returns ``[]``).

    :param source: Raw file bytes (UTF-8 encoding assumed; errors are replaced).
    :param rel_path: Project-relative path used for logging and symbol metadata.
    :return: ``(symbols, refs, imports, sections)`` — sections is always empty.
    """
    collected = common.collect_symbols_and_refs(
        source, "ruby", rel_path, _LOG, common.CALL_RE, _CALL_NOISE, promote_methods=True
    )
    if collected is None:
        return [], [], [], []
    symbols, imp_exp, seen_names, refs, result = collected

    for extra in _extract_extras(source, seen_names):
        symbols.append(extra)

    # require/require_relative imports
    text = source.decode("utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        m = _REQUIRE_RE.match(line.strip())
        if m:
            imp_exp.append(ImpExp(kind="import", target=m.group(1), line=i))

    _LOG.debug(
        "ruby extract: %s → symbols=%d refs=%d imports=%d",
        rel_path, len(symbols), len(refs), len(imp_exp),
    )
    return symbols, refs, imp_exp, []
