"""PHP symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.php")

_CALL_NOISE = frozenset([
    "if", "else", "elseif", "while", "for", "foreach", "switch", "case",
    "do", "break", "continue", "return", "yield", "throw", "try", "catch",
    "finally", "match", "echo", "print", "die", "exit",
    "isset", "empty", "unset", "list", "array", "null", "true", "false",
    "new", "clone", "instanceof", "class", "interface", "trait", "enum",
    "extends", "implements", "abstract", "final", "static", "public",
    "protected", "private", "function", "fn", "namespace", "use", "as",
    "require", "require_once", "include", "include_once",
    "self", "parent", "this",
    "count", "strlen", "str_replace", "sprintf", "printf",
    "array_map", "array_filter", "array_push", "array_pop",
    "in_array", "array_key_exists", "array_merge", "array_values",
    "implode", "explode", "trim", "strtolower", "strtoupper",
    "intval", "strval", "floatval", "boolval",
    "var_dump", "print_r", "var_export",
])

# Namespace declaration
_NAMESPACE_RE = re.compile(r"^namespace\s+([\w\\]+)\s*;")

# Class/interface/trait/enum declaration
_CLASS_RE = re.compile(
    r"^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)"
)

# Method/function declaration
_METHOD_RE = re.compile(
    r"^(?:(?:public|protected|private|static|abstract|final)\s+)*"
    r"function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("
)

# Arrow/anonymous functions are noise — skip lines that define them without a name
_ANON_FN_RE = re.compile(r"^\s*function\s*\(")

# Constant declaration: const FOO = ... or define('FOO', ...)
_CONST_RE = re.compile(r"^(?:(?:public|protected|private|static)\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)")
_DEFINE_RE = re.compile(r"^define\s*\(\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]")

# Property declaration: public/protected/private $name
_PROP_RE = re.compile(
    r"^(?:(?:public|protected|private|static|readonly)\s+)+"
    r"\??[A-Za-z_][A-Za-z0-9_|\\]*\s+\$([A-Za-z_][A-Za-z0-9_]*)"
)

# use statement: use Namespace\Class [as Alias];
_USE_RE = re.compile(r"^use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;")

# require/include
_REQUIRE_RE = re.compile(r"^(?:require|include)(?:_once)?\s+['\"]([^'\"]+)['\"]")


def _extract_php_symbols(
    source: bytes, seen_names: set[tuple[str, int]]
) -> tuple[list[Symbol], list[ImpExp]]:
    return common.safe_regex_parse(  # type: ignore[return-value]
        _extract_php_symbols_inner, source, seen_names,
        log=_LOG, label="_extract_php_symbols", empty=([], []),
    )


def _extract_php_symbols_inner(
    source: bytes, seen_names: set[tuple[str, int]]
) -> tuple[list[Symbol], list[ImpExp]]:
    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []

    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()

    # Context tracking: stack of (class_name, brace_depth_at_entry)
    context_stack: list[tuple[str, int]] = []
    brace_depth = 0
    in_comment = False

    def current_class() -> str | None:
        return context_stack[-1][0] if context_stack else None

    add = common.make_add_fn(symbols, seen_names)

    for i, raw_line in enumerate(lines, 1):
        line = raw_line.rstrip()
        stripped = line.lstrip()

        # Block comment handling
        if "/*" in stripped and not in_comment:
            in_comment = True
        if "*/" in stripped:
            in_comment = False
            continue
        if in_comment:
            continue

        # Skip single-line comments and empty lines
        if not stripped or stripped.startswith(("//", "#")):
            continue

        # Track brace depth for class context
        open_b = line.count("{") - line.count("\\{")
        close_b = line.count("}") - line.count("\\}")
        brace_depth += open_b

        # Pop context stack when we close the class brace
        while context_stack and brace_depth <= context_stack[-1][1]:
            context_stack.pop()

        brace_depth -= close_b

        # Namespace
        ns_m = _NAMESPACE_RE.match(stripped)
        if ns_m:
            add(ns_m.group(1), "namespace", i, stripped[:200])
            continue

        # use statement (import)
        use_m = _USE_RE.match(stripped)
        if use_m:
            target = use_m.group(1)
            imp_exp.append(ImpExp(kind="import", target=target, line=i))
            continue

        # require/include
        req_m = _REQUIRE_RE.match(stripped)
        if req_m:
            imp_exp.append(ImpExp(kind="import", target=req_m.group(1), line=i))
            continue

        # Class/interface/trait/enum
        cls_m = _CLASS_RE.match(stripped)
        if cls_m:
            name = cls_m.group(1)
            is_interface = "interface" in stripped.split(name)[0]
            is_trait = "trait" in stripped.split(name)[0]
            is_enum = "enum" in stripped.split(name)[0]
            if is_interface:
                kind = "interface"
            elif is_trait:
                kind = "trait"
            elif is_enum:
                kind = "enum"
            else:
                kind = "class"
            parent = current_class()
            add(name, kind, i, stripped[:200], parent=parent)
            # Push context at current brace depth (entry brace not yet counted for this line)
            context_stack.append((name, brace_depth - open_b))
            continue

        # Anonymous function — skip
        if _ANON_FN_RE.match(stripped):
            continue

        # Method/function
        meth_m = _METHOD_RE.match(stripped)
        if meth_m:
            name = meth_m.group(1)
            # Skip __construct/__destruct noise for small files, but index them
            parent = current_class()
            kind = "method" if parent else "function"
            sig_end = stripped.find(")")
            sig = stripped[:sig_end + 1] if sig_end >= 0 else stripped
            add(name, kind, i, sig[:200], parent=parent)
            continue

        # Property
        prop_m = _PROP_RE.match(stripped)
        if prop_m:
            name = prop_m.group(1)
            parent = current_class()
            if parent:
                add(name, "var", i, stripped[:200], parent=parent)
            continue

        # Class constant
        const_m = _CONST_RE.match(stripped)
        if const_m:
            name = const_m.group(1)
            parent = current_class()
            add(name, "const", i, stripped[:200], parent=parent)
            continue

        # Global define()
        define_m = _DEFINE_RE.match(stripped)
        if define_m:
            add(define_m.group(1), "const", i, stripped[:200])
            continue

    return symbols, imp_exp


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports from a PHP file."""
    collected = common.collect_symbols_and_refs(
        source, "php", rel_path, _LOG, common.CALL_RE, _CALL_NOISE,
    )
    if collected is None:
        symbols: list[Symbol] = []
        imp_exp: list[ImpExp] = []
        refs: list[Ref] = []
        seen_names: set[tuple[str, int]] = set()
    else:
        symbols, imp_exp, seen_names, refs, _result = collected

    extra_syms, extra_imports = _extract_php_symbols(source, seen_names)
    symbols.extend(extra_syms)
    imp_exp.extend(extra_imports)

    _LOG.debug(
        "php extract: %s → symbols=%d refs=%d imports=%d",
        rel_path, len(symbols), len(refs), len(imp_exp),
    )
    return symbols, refs, imp_exp, []
