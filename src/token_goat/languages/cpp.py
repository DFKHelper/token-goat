"""C and C++ symbol extractor using regex-based heuristics.

Extracts functions, classes, structs, enums, typedefs, and ``#include``
directives.  The C++ extractor (``extract``) handles templates, methods,
and namespaces; the C extractor (``extract_c``) uses the same symbol
pipeline with ``language="c"`` so tree-sitter selects the C grammar.
"""
from __future__ import annotations

__all__ = ["extract", "extract_c"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.cpp")

_CALL_NOISE = frozenset([
    "if", "for", "while", "switch", "case", "return", "break", "continue", "goto",
    "sizeof", "typeof", "alignof", "decltype", "typeid",
    "new", "delete", "throw", "try", "catch",
    "this", "nullptr", "NULL", "true", "false",
    "int", "long", "short", "char", "double", "float", "void", "bool",
    "unsigned", "signed", "const", "static", "extern", "volatile", "inline",
    "auto", "register", "restrict",
    "printf", "fprintf", "sprintf", "snprintf", "scanf", "fscanf",
    "malloc", "calloc", "realloc", "free", "memcpy", "memset", "memmove",
    "strlen", "strcpy", "strncpy", "strcmp", "strncmp", "strcat", "strncat",
    "fopen", "fclose", "fread", "fwrite", "fgets", "fputs",
    "assert", "abort", "exit",
    "std", "endl", "cout", "cin", "cerr",
    "vector", "string", "map", "set", "pair", "list", "queue", "stack",
    "make_shared", "make_unique", "move", "forward",
    "begin", "end", "size", "empty", "push_back", "pop_back",
    "first", "second", "data", "find", "insert", "erase",
])

# All-caps #define macro (2+ chars)
_DEFINE_RE = re.compile(r"^#\s*define\s+([A-Z_][A-Z0-9_]{1,})\b")

# #include statement
_INCLUDE_RE = re.compile(r'^#\s*include\s+[<"]([^>"]+)[>"]')

# Function definition: return_type name(params) { — not extern, not inside a struct
# Matches both C and C++ top-level functions and static functions
_FUNC_DEF_RE = re.compile(
    r"^(?:static\s+|inline\s+|__attribute__\s*\([^)]*\)\s*)*"
    r"(?:(?:unsigned|signed|long|short|const)\s+)*"
    r"(?:[A-Za-z_][A-Za-z0-9_:*<>\[\]]*(?:\s*\*+)?)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*\("
    r"[^;]*$"
)

# C++ method outside class body: finds the last ClassName::method( pattern in a line
# Using finditer on the whole line handles qualified names like NS::Class::method
_CPP_SCOPE_RE = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_~]*)\s*\("
)

# struct/class/enum declaration — named form: struct Foo { or typedef struct Foo {
_STRUCT_RE = re.compile(
    r"^(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|;)"
)
# closing brace typedef: } TypeName; (anonymous struct alias)
_TYPEDEF_CLOSE_RE = re.compile(r"^\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;")
# anonymous typedef struct/union/enum opening (no name before {)
_ANON_TYPEDEF_RE = re.compile(r"^typedef\s+(?:struct|union|enum)\s*\{")
_CLASS_RE = re.compile(
    r"^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:{]|$)"
)

# extern function declaration
_EXTERN_RE = re.compile(
    r"^extern\s+(?:[A-Za-z_][A-Za-z0-9_\s*]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*;"
)

# typedef to a name: typedef ... OldName NewName;
_TYPEDEF_RE = re.compile(
    r"^typedef\s+.+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;"
)

# namespace declaration (C++ only)
_NAMESPACE_RE = re.compile(r"^namespace\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|$)")

# Lines that should not be mistaken for function defs
_NOT_FUNC = re.compile(
    r"\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\bdo\b|^\s*#|"
    r"\bextern\b|^\s*//"
)


def _extract_symbols(source: bytes, language: str) -> list[Symbol]:
    return common.safe_regex_parse(_extract_symbols_inner, source, language, log=_LOG, label=f"_extract_symbols({language})")  # type: ignore[return-value]


def _extract_symbols_inner(source: bytes, language: str) -> list[Symbol]:
    symbols: list[Symbol] = []
    seen: set[tuple[str, int]] = set()
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()
    n = len(lines)
    in_comment = False
    # Track anonymous typedef struct start lines: } TypeName; needs the start line
    anon_typedef_starts: list[int] = []

    add = common.make_add_fn(symbols, seen)

    for i, raw_line in enumerate(lines, 1):
        line = raw_line.strip()

        # block comment tracking (simple heuristic)
        if "/*" in line and not in_comment:
            in_comment = True
        if "*/" in line:
            in_comment = False
            continue
        if in_comment or line.startswith("//"):
            continue

        # #define macros (all-caps only)
        def_m = _DEFINE_RE.match(raw_line)
        if def_m:
            name = def_m.group(1)
            if len(name) >= 2:
                add(name, "const", i, raw_line.rstrip()[:200])
            continue

        if not line or line.startswith("#"):
            continue

        # closing brace typedef: } TypeName;  (anonymous struct pattern)
        close_m = _TYPEDEF_CLOSE_RE.match(line)
        if close_m:
            name = close_m.group(1)
            start_line = anon_typedef_starts.pop() if anon_typedef_starts else i
            add(name, "type", start_line, line[:200])
            continue

        # namespace (C++ only)
        if language == "cpp":
            ns_m = _NAMESPACE_RE.match(line)
            if ns_m:
                add(ns_m.group(1), "const", i, line[:200])
                continue

        # anonymous typedef struct { — track start line for closing brace resolution
        if _ANON_TYPEDEF_RE.match(line):
            anon_typedef_starts.append(i)
            continue

        # struct/union/enum
        st_m = _STRUCT_RE.match(line)
        if st_m:
            add(st_m.group(1), "type", i, line[:200])
            continue

        # class (C++ only)
        if language == "cpp":
            cl_m = _CLASS_RE.match(line)
            if cl_m and "(" not in line[:line.find("{") + 1 if "{" in line else len(line)]:
                name = cl_m.group(1)
                if name not in ("if", "for", "while", "switch"):
                    add(name, "class", i, line[:200])
                    continue

        # typedef alias (not typedef struct/union/enum — those are caught above)
        if line.startswith("typedef") and "struct" not in line and "union" not in line and "enum" not in line:
            td_m = _TYPEDEF_RE.match(line)
            if td_m:
                add(td_m.group(1), "type", i, line[:200])
                continue

        # extern function declaration
        ext_m = _EXTERN_RE.match(line)
        if ext_m:
            add(ext_m.group(1), "function", i, line[:200])
            continue

        # C++ out-of-class method ClassName::method(
        if language == "cpp" and "::" in line and not _NOT_FUNC.search(raw_line) and ";" not in line:
            scope_matches = list(_CPP_SCOPE_RE.finditer(line))
            if scope_matches:
                last_m = scope_matches[-1]
                class_name = last_m.group(1)
                method_name = last_m.group(2)
                if method_name not in _CALL_NOISE:
                    sig_end = line.find("{")
                    sig = line[:sig_end].rstrip() if sig_end >= 0 else line.rstrip()
                    add(method_name, "method", i, sig[:200], parent=class_name)
                    continue

        # Function definition: must end with { on same line or next line
        if "(" in line and ";" not in line and not _NOT_FUNC.search(raw_line):
            fn_m = _FUNC_DEF_RE.match(line)
            if fn_m:
                name = fn_m.group(1)
                if name not in _CALL_NOISE and len(name) > 1:
                    # look ahead for opening brace (may be on next line)
                    has_body = "{" in line or (i < n and "{" in lines[i])
                    if has_body:
                        sig_end = line.find("{")
                        sig = line[:sig_end].rstrip() if sig_end >= 0 else line.rstrip()
                        add(name, "function", i, sig[:200])

    return symbols


def _extract_imports(source: bytes) -> list[ImpExp]:
    imp_exp: list[ImpExp] = []
    text = source.decode("utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        m = _INCLUDE_RE.match(line)
        if m:
            imp_exp.append(ImpExp(kind="import", target=m.group(1), line=i))
    return imp_exp


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a C++ source file.

    Uses the ``cpp`` tree-sitter grammar via :func:`_extract_symbols` to
    pull out functions, classes, structs, enums, and typedefs.  Refs are
    extracted by scanning call-like patterns against ``_CALL_NOISE``.
    ``#include`` directives become :class:`~token_goat.parser.ImpExp` rows.
    Sections are not produced (C++ has no heading concept); returns ``[]``
    for the section list.

    :param source: Raw file bytes (UTF-8 or latin-1 content is tolerated via
        ``errors='replace'`` inside the tree-sitter layer).
    :param rel_path: Project-relative path used for logging and symbol
        metadata; not used for file I/O.
    :return: ``(symbols, refs, imports, sections)`` — sections is always
        an empty list for C++ files.
    """
    symbols = _extract_symbols(source, "cpp")
    refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE)
    imp_exp = _extract_imports(source)
    _LOG.debug(
        "cpp extract: %s → symbols=%d refs=%d imports=%d",
        rel_path, len(symbols), len(refs), len(imp_exp),
    )
    return symbols, refs, imp_exp, []


def extract_c(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a C source file.

    Identical pipeline to :func:`extract` but uses the ``c`` tree-sitter
    grammar, which does not include C++-specific constructs (templates,
    namespaces, classes).  Returns an empty section list.

    :param source: Raw file bytes.
    :param rel_path: Project-relative path used for logging and symbol metadata.
    :return: ``(symbols, refs, imports, sections)`` — sections is always empty.
    """
    symbols = _extract_symbols(source, "c")
    refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE)
    imp_exp = _extract_imports(source)
    _LOG.debug(
        "c extract: %s → symbols=%d refs=%d imports=%d",
        rel_path, len(symbols), len(refs), len(imp_exp),
    )
    return symbols, refs, imp_exp, []
