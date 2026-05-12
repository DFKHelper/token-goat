"""Python symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

import re

import tree_sitter_language_pack as tlp

from ..parser import ImpExp, Ref, Symbol

# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

_CALL_NOISE = frozenset([
    # Python builtins
    "print", "len", "range", "str", "int", "float", "bool", "list",
    "dict", "set", "tuple", "type", "isinstance", "issubclass",
    "hasattr", "getattr", "setattr", "delattr", "callable", "iter",
    "next", "enumerate", "zip", "map", "filter", "sorted", "reversed",
    "min", "max", "sum", "abs", "round", "pow", "divmod",
    "open", "repr", "hash", "id", "vars", "dir", "help",
    "super", "object", "property", "staticmethod", "classmethod",
    "raise", "assert", "return", "yield", "lambda",
    "if", "for", "while", "with", "except",
    # Common decorators when used with ()
    "wraps",
])

# Regex: identifier NOT preceded by . that is immediately followed by (
_CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")

# Regex for import source parsing
_FROM_IMPORT_RE = re.compile(
    r"^from\s+(\S+)\s+import\s+(.+)$", re.MULTILINE
)
_PLAIN_IMPORT_RE = re.compile(r"^import\s+(\S+(?:\s*,\s*\S+)*)", re.MULTILINE)


def _parse_import_source(source_line: str) -> list[str]:
    """Return list of import targets from an import statement source line."""
    line = source_line.strip()
    m = re.match(r"^from\s+(\S+)\s+import\s+(.+)$", line)
    if m:
        module = m.group(1)
        names_raw = m.group(2)
        # Handle parenthesized imports — strip them
        names_raw = names_raw.strip("()")
        names = [n.strip().split(" as ")[0].strip() for n in names_raw.split(",")]
        return [f"{module}.{n}" for n in names if n and n != "*"]
    m = re.match(r"^import\s+(.+)$", line)
    if m:
        names_raw = m.group(1)
        names = [n.strip().split(" as ")[0].strip() for n in names_raw.split(",")]
        return [n for n in names if n]
    return [line]


def _kind_str(structure_kind: object) -> str:
    """Convert StructureKind to our kind string."""
    s = str(structure_kind).split(".")[-1]
    mapping = {
        "Function": "function",
        "Class": "class",
        "Method": "method",
        "Interface": "interface",
        "Other": "var",
    }
    return mapping.get(s, "var")


def _build_signature(source: bytes, item_span: object, body_span: object | None) -> str | None:
    """Extract header text (before body colon) from raw source bytes."""
    if body_span is None:
        return None
    try:
        header = source[item_span.start_byte : body_span.start_byte]
        text = header.decode("utf-8", errors="replace").strip()
        if len(text) > 200:
            text = text[:200]
        return text or None
    except (IndexError, AttributeError):
        return None


def _extract_refs(source: bytes) -> list[Ref]:
    """Extract call-site refs using regex."""
    refs: list[Ref] = []
    seen: set[tuple[str, int]] = set()
    text = source.decode("utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in _CALL_RE.finditer(line):
            name = m.group(1)
            if name in _CALL_NOISE or len(name) <= 1:
                continue
            key = (name, lineno)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Ref(name=name, line=lineno, col=m.start(1), context=line.strip()[:120]))
    return refs


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp]]:
    """Extract symbols, refs, and imports from a Python file."""
    text = source.decode("utf-8", errors="replace")
    cfg = tlp.ProcessConfig(
        language="python",
        structure=True,
        imports=True,
        exports=False,
        symbols=True,
    )
    try:
        result = tlp.process(text, cfg)
    except Exception:
        return [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    def _add_symbol(item: object, parent_name: str | None = None) -> None:
        name: str = item.name  # type: ignore[attr-defined]
        span = item.span
        body_span = item.body_span if hasattr(item, "body_span") else None
        line = span.start_line + 1
        end_line = span.end_line + 1
        kind = _kind_str(item.kind)
        # Use "method" if this is a function inside a class
        if parent_name is not None and kind == "function":
            kind = "method"
        sig = _build_signature(source, span, body_span)

        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=kind,
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

    # --- additional symbols from SymbolInfo (module-level vars/consts) ---
    for sym in result.symbols:
        name: str = sym.name  # type: ignore[attr-defined]
        span = sym.span
        line = span.start_line + 1
        # Determine kind: SymbolKind.Constant -> "const", else "var"
        sk = str(sym.kind).split(".")[-1]
        if sk == "Constant":
            kind = "const"
        elif sk == "Variable":
            kind = "var"
        elif sk == "Function":
            kind = "function"
        elif sk == "Class":
            kind = "class"
        else:
            kind = "var"
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
                )
            )

    # --- imports ---
    for imp in result.imports:
        targets = _parse_import_source(imp.source)
        line = imp.span.start_line + 1
        for target in targets:
            imp_exp.append(ImpExp(kind="import", target=target, line=line))

    # --- refs ---
    refs = _extract_refs(source)

    return symbols, refs, imp_exp
