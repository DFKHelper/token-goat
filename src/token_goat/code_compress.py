"""Structural skeleton extraction for post-read code compression."""
from __future__ import annotations

import re

__all__ = ["compress_to_skeleton"]

_SUPPORTED_EXT: frozenset[str] = frozenset([".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java"])

# Python regexes
_PY_IMPORT_RE = re.compile(r"^(import |from )")
_PY_DEF_RE = re.compile(r"^(async\s+)?def\s|^class\s")
_PY_DECORATOR_RE = re.compile(r"^@")
_PY_DUNDER_ALL_RE = re.compile(r"^__all__\s*=")
# Matches CamelCase type aliases (MyType = ...) and explicit TypeAlias annotations (X: TypeAlias = ...)
_PY_TYPE_ALIAS_RE = re.compile(r"^[A-Z]\w*\s*(?::\s*\w+\s*)?=")

# JS/TS: matches function/class/interface/type/enum declarations and const/let/var arrow functions
_JS_SIG_RE = re.compile(
    r"^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+)*"
    r"(?:function\b|class\b|interface\b|type\b|enum\b|const\s+\w|let\s+\w|var\s+\w)"
)

# Go: function and type-struct/interface declarations
_GO_SIG_RE = re.compile(r"^\s*(?:func\s|type\s+\w+\s+(?:struct|interface)\b)")

# Rust: pub/priv fn, struct, enum, trait, impl
_RUST_SIG_RE = re.compile(r"^\s*(?:pub(?:\s+\(crate\))?\s+)?(?:async\s+)?(?:fn\s|struct\s|enum\s|trait\s|impl\b)")

# Java: method and class/interface/enum declarations with access modifiers
_JAVA_SIG_RE = re.compile(
    r"^\s*(?:(?:public|private|protected|static|abstract|final|native|synchronized)\s+)+"
    r"(?:class\b|interface\b|enum\b|void\b|\w+)\s+\w+\s*[\(<]"
)

# Import/use/require for non-Python languages
_IMPORT_RE = re.compile(r"^\s*(?:import\b|from\b|use\b|require\b)")


def compress_to_skeleton(source: str, file_ext: str) -> str | None:
    """Return a structural skeleton of source, or None for unsupported extensions.

    For Python files, keeps all import lines, __all__ assignments, top-level type
    aliases, and all def/class signatures (with decorators) at any nesting level.
    Each body block is replaced with ``# ... N lines`` at the appropriate indent.

    For JS/TS/Go/Rust/Java files, applies best-effort signature extraction based on
    common patterns, replacing brace-delimited bodies with ``// ... N lines``.

    Returns None for unsupported extensions (pass-through signal to the caller).
    """
    if file_ext not in _SUPPORTED_EXT:
        return None
    if not source:
        return ""
    if file_ext == ".py":
        return _compress_python(source)
    return _compress_brace_lang(source, file_ext)


def _compress_python(source: str) -> str:
    """Line-by-line Python skeleton extractor."""
    lines = source.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        if not stripped:
            i += 1
            continue

        # Top-level import lines kept verbatim
        if indent == 0 and _PY_IMPORT_RE.match(stripped):
            out.append(line)
            i += 1
            continue

        # Top-level __all__ = [...] kept verbatim
        if indent == 0 and _PY_DUNDER_ALL_RE.match(stripped):
            out.append(line)
            i += 1
            continue

        # Top-level type alias: CamelCase = ... or X: TypeAlias = ...
        if indent == 0 and _PY_TYPE_ALIAS_RE.match(stripped):
            out.append(line)
            i += 1
            continue

        # Decorator at any indent kept verbatim
        if _PY_DECORATOR_RE.match(stripped):
            out.append(line)
            i += 1
            continue

        # def / async def / class at any indent: emit signature, suppress body
        if _PY_DEF_RE.match(stripped):
            out.append(line)
            i += 1
            body_count = 0
            while i < n:
                nxt = lines[i]
                nxt_s = nxt.lstrip()
                if not nxt_s:
                    i += 1
                    continue
                nxt_indent = len(nxt) - len(nxt_s)
                if nxt_indent <= indent:
                    break
                # Nested def/class/decorator: stop counting, let outer loop emit it
                if _PY_DECORATOR_RE.match(nxt_s) or _PY_DEF_RE.match(nxt_s):
                    break
                body_count += 1
                i += 1
            if body_count > 0:
                body_pfx = " " * (indent + 4)
                out.append(f"{body_pfx}# ... {body_count} lines")
            continue

        # Skip all other lines (body code, non-type-alias assignments, comments, etc.)
        i += 1

    return "\n".join(out)


def _skip_brace_body(lines: list[str], start: int, initial_depth: int) -> tuple[int, int]:
    """Advance past a brace-delimited block starting at initial_depth > 0.

    Returns (next_line_index, body_line_count) where body_line_count counts
    lines consumed before the depth returned to zero. Correctly ignores braces
    inside string literals and comments.
    """
    depth = initial_depth
    body_count = 0
    i = start
    n = len(lines)
    in_block_comment = False
    while i < n and depth > 0:
        line = lines[i]
        j = 0
        line_len = len(line)
        while j < line_len and depth > 0:
            ch = line[j]
            if in_block_comment:
                if ch == "*" and j + 1 < line_len and line[j + 1] == "/":
                    in_block_comment = False
                    j += 2
                    continue
                j += 1
                continue
            if ch == "/" and j + 1 < line_len:
                if line[j + 1] == "/":
                    break
                elif line[j + 1] == "*":
                    in_block_comment = True
                    j += 2
                    continue
            elif ch == '"':
                j += 1
                while j < line_len:
                    if line[j] == "\\":
                        j += 2
                    elif line[j] == '"':
                        j += 1
                        break
                    else:
                        j += 1
                continue
            elif ch == "'":
                j += 1
                while j < line_len:
                    if line[j] == "\\":
                        j += 2
                    elif line[j] == "'":
                        j += 1
                        break
                    else:
                        j += 1
                continue
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if depth > 0:
            body_count += 1
        i += 1
    return i, body_count


def _compress_brace_lang(source: str, file_ext: str) -> str:
    """Best-effort skeleton extractor for brace-delimited languages."""
    if file_ext in {".js", ".jsx", ".ts", ".tsx"}:
        sig_re = _JS_SIG_RE
    elif file_ext == ".go":
        sig_re = _GO_SIG_RE
    elif file_ext == ".rs":
        sig_re = _RUST_SIG_RE
    else:
        sig_re = _JAVA_SIG_RE

    lines = source.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.lstrip()

        if not stripped:
            i += 1
            continue

        # Import/use/require lines kept verbatim
        if _IMPORT_RE.match(stripped):
            out.append(line)
            i += 1
            continue

        if sig_re.match(line) or sig_re.match(stripped):
            out.append(line)
            i += 1
            # Calculate brace depth opened by the signature line itself
            depth = line.count("{") - line.count("}")
            if depth > 0:
                next_i, body_count = _skip_brace_body(lines, i, depth)
                if body_count > 0:
                    out.append(f"// ... {body_count} lines")
                i = next_i
            elif i < n and lines[i].strip() == "{":
                # Allman-style: opening brace on its own line
                depth = 1
                i += 1
                next_i, body_count = _skip_brace_body(lines, i, depth)
                if body_count > 0:
                    out.append(f"// ... {body_count} lines")
                i = next_i
            continue

        i += 1

    return "\n".join(out)
