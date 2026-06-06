"""SQL extractor — CREATE TABLE/VIEW/FUNCTION/PROCEDURE/INDEX/TRIGGER names.

SQL schema files and migrations are a common target for surgical reads: an
agent usually needs the definition of one specific table or function, not the
entire 2,000-line schema file.  This extractor gives
``token-goat section schema.sql::users`` the ability to return just the
``CREATE TABLE users (...)`` block.

What is extracted
-----------------
Symbols (each also becomes a Section):
* ``sql_table``     — ``CREATE [TEMP[ORARY]] TABLE [IF NOT EXISTS] name``
* ``sql_view``      — ``CREATE [OR REPLACE] [TEMP[ORARY]] VIEW name``
* ``sql_function``  — ``CREATE [OR REPLACE] FUNCTION name``
* ``sql_procedure`` — ``CREATE [OR REPLACE] PROCEDURE name``
* ``sql_index``     — ``CREATE [UNIQUE] INDEX [IF NOT EXISTS] name``
* ``sql_trigger``   — ``CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name``
* ``sql_type``      — ``CREATE [OR REPLACE] TYPE name``
* ``sql_schema``    — ``CREATE SCHEMA [IF NOT EXISTS] name``

What is NOT extracted
---------------------
* ``INSERT``, ``UPDATE``, ``DELETE``, ``SELECT`` statements — those are DML,
  not schema definitions, and are not useful as jump targets.
* Inline ``CONSTRAINT`` names inside ``CREATE TABLE`` bodies — they are part
  of the table symbol, not top-level definitions.
* Stored procedure bodies — the full body is captured in the Section range.

Design choices
--------------
Pure-regex, case-insensitive, no tree-sitter.  SQL dialects (PostgreSQL,
MySQL, SQLite, SQL Server, Oracle) differ in keyword ordering and quoting
rules; a regex approach that captures the common DDL stem is more portable
than a dialect-specific parser.  The regex is intentionally permissive to
handle the full matrix of optional qualifiers (OR REPLACE, IF NOT EXISTS,
TEMP, TEMPORARY, UNIQUE, CONSTRAINT, etc.).

Names are captured with or without double-quote, backtick, or square-bracket
quoting.  Schema-qualified names (``public.users``) are captured as-is so
``token-goat section schema.sql::public.users`` resolves correctly.

Comment stripping (``-- ...`` and ``/* ... */``) runs as a pre-pass.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_SQL_LINE_COMMENT_RE = re.compile(r"--[^\n]*")


def _strip_comments(text: str) -> str:
    """Replace SQL comment regions with whitespace, preserving line numbers."""
    return common.strip_cstyle_comments(text, line_re=_SQL_LINE_COMMENT_RE)

_LOG = get_logger("languages.sql_idx")

# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Name pattern
# ---------------------------------------------------------------------------

# SQL object names: bare identifiers, double-quoted ("name"), backtick-quoted
# (`name`), or square-bracket-quoted ([name]) names.  Schema-qualified names
# (schema.name) are captured as a single token via the optional prefix group.
# WHY no spaces inside quotes: real object names don't contain newlines; this
# keeps the regex fast.
_BARE = r"[A-Za-z_][A-Za-z0-9_$]*"
_QUOTED = r'"[^"]{1,128}"|`[^`]{1,128}`|\[[^\]]{1,128}\]'
_NAME = rf"(?:{_QUOTED}|{_BARE})(?:\.(?:{_QUOTED}|{_BARE}))?"

def _make_create_re(object_kw: str, opt_prefix: str = "") -> re.Pattern[str]:
    """Build a ``CREATE [opt_prefix] <object_kw> [IF NOT EXISTS] <name>`` regex.

    *opt_prefix* is a self-contained optional regex fragment (already including
    any trailing ``\\s+``) that is inserted verbatim between ``CREATE\\s+`` and
    *object_kw*.  Typical values:

    * ``r"(?:OR\\s+REPLACE\\s+)?"``         — for FUNCTION / VIEW / TRIGGER
    * ``r"(?:UNIQUE\\s+)?"``                 — for INDEX
    * ``r"(?:TEMP(?:ORARY)?\\s+)?"``         — for TABLE / VIEW

    Do NOT add an extra ``\\s+`` wrapper here — that is a common mistake that
    produces ``(?:(?:OPT\\s+)?\\s+)?`` which requires a mandatory whitespace
    token even when the optional block is absent and matches nothing.
    """
    return re.compile(
        rf"(?<!\w)CREATE\s+{opt_prefix}{object_kw}\s+(?:IF\s+NOT\s+EXISTS\s+)?({_NAME})",
        re.IGNORECASE,
    )

# TABLE (with optional TEMP[ORARY])
_TABLE_RE = _make_create_re(
    "TABLE",
    opt_prefix=r"(?:TEMP(?:ORARY)?\s+)?",
)

# VIEW (with optional OR REPLACE and optional TEMP[ORARY])
_VIEW_RE = _make_create_re(
    "VIEW",
    opt_prefix=r"(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?",
)

# FUNCTION / PROCEDURE (with optional OR REPLACE)
_FUNCTION_RE = _make_create_re("FUNCTION", opt_prefix=r"(?:OR\s+REPLACE\s+)?")
_PROCEDURE_RE = _make_create_re("PROCEDURE", opt_prefix=r"(?:OR\s+REPLACE\s+)?")

# INDEX (with optional UNIQUE)
_INDEX_RE = _make_create_re("INDEX", opt_prefix=r"(?:UNIQUE\s+)?")

# TRIGGER (with optional OR REPLACE and optional CONSTRAINT)
_TRIGGER_RE = _make_create_re(
    "TRIGGER",
    opt_prefix=r"(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?",
)

# TYPE (with optional OR REPLACE)
_TYPE_RE = _make_create_re("TYPE", opt_prefix=r"(?:OR\s+REPLACE\s+)?")

# SCHEMA
_SCHEMA_RE = _make_create_re("SCHEMA")

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (_TABLE_RE, "sql_table"),
    (_VIEW_RE, "sql_view"),
    (_FUNCTION_RE, "sql_function"),
    (_PROCEDURE_RE, "sql_procedure"),
    (_INDEX_RE, "sql_index"),
    (_TRIGGER_RE, "sql_trigger"),
    (_TYPE_RE, "sql_type"),
    (_SCHEMA_RE, "sql_schema"),
]

_MAX_SYMBOLS: int = 500
_MAX_HEADING_LEN: int = 128

def _unquote(name: str) -> str:
    """Strip outer quoting from an SQL identifier."""
    if len(name) >= 2 and (
        (name[0] == '"' and name[-1] == '"')
        or (name[0] == '`' and name[-1] == '`')
        or (name[0] == '[' and name[-1] == ']')
    ):
        return name[1:-1]
    return name

def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract SQL DDL object names from *source*.

    Returns ``(symbols, refs, imports, sections)``.  Refs and imports are
    always empty for SQL schema files.
    """
    text = common.decode_source_text(source, _LOG, "sql_idx")
    if text is None:
        return [], [], [], []

    try:
        stripped = _strip_comments(text)
        total_lines = len(text.split("\n"))

        symbols: list[Symbol] = []
        sections: list[Section] = []
        seen: set[tuple[str, int]] = set()

        def _emit(raw_name: str, kind: str, line: int) -> None:
            name = _unquote(raw_name).strip()
            if not name or len(name) > _MAX_HEADING_LEN:
                return
            if len(symbols) >= _MAX_SYMBOLS:
                return
            key = (name, line)
            if key in seen:
                return
            seen.add(key)
            symbols.append(Symbol(name=name, kind=kind, line=line))
            sections.append(Section(heading=name, level=1, line=line))

        for pattern, kind in _PATTERNS:
            for m in pattern.finditer(stripped):
                raw_name = m.group(1)
                if raw_name:
                    line = stripped[: m.start()].count("\n") + 1
                    _emit(raw_name, kind, line)

        # Sort by line for deterministic end-line assignment.
        sections.sort(key=lambda s: s.line)
        # Re-sort symbols to match sections order (they were inserted in pattern order).
        symbols.sort(key=lambda s: s.line)

        common.assign_flat_end_lines(sections, total_lines)
        # Propagate computed end_lines to Symbol objects so that
        # ``token-goat scope`` can match enclosing SQL definitions.
        common.propagate_section_end_lines_to_symbols(symbols, sections)

        return symbols, [], [], sections

    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        _LOG.debug("sql_idx: parse failed for %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
