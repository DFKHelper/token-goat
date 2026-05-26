"""TOML extractor — emits one Section per ``[table]`` / ``[[array]]`` header.

Why a custom scanner rather than ``tomllib``:

* ``tomllib.loads`` parses TOML into a plain Python dict and discards source
  positions.  We need start/end line numbers so ``token-goat section`` can
  slice the source file back out.

* The TOML grammar for table headers is unambiguous and easy to recognise
  line-by-line: ``[name]`` or ``[[name]]`` at column 0, with the table
  spanning every line until the next header (or EOF).  A regex scan over the
  lines gives correct results without depending on a third-party tree-sitter
  grammar.

Section model
-------------
* ``heading``: the dotted key inside the brackets, e.g. ``tool.ruff``.
* ``level``: 1 for ``[name]`` tables, 2 for ``[[array]]`` array-of-tables
  entries.  This is purely a convenience for downstream sorting; both flavours
  are addressable via the same ``token-goat section file.toml::name`` lookup.
* ``line``: 1-based line of the header.
* ``end_line``: 1-based last line of the section's content (header inclusive),
  which is the line immediately before the next header or the file's last
  line for the final section.

Symbols
-------
We also emit one ``toml_key`` symbol per table header so ``token-goat symbol
ruff`` can locate the relevant table in any indexed config file across the
repo.  Within-table keys (e.g. ``line-length = 100``) are not indexed
individually — the section payload from a small surgical read already exposes
them, and indexing every leaf would bloat the symbol table for what is
typically a small file.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.toml_idx")

# Maximum table-header line value persisted as ``end_line`` for the last
# section in a file.  Pegged at the actual EOF line — TOML files do not have
# nested headers, so the last header runs to the bottom.
_MAX_HEADING_LEN: int = 200
_MAX_SYMBOLS_PER_FILE: int = 500

# Strict TOML table-header regex — combined bare-or-quoted form is defined
# below (``_TABLE_RE``).  Combined into one pattern so :func:`common.scan_flat_headers`
# can walk each candidate line exactly once.
#
# Both forms share:
#   * Column-0 anchor — no leading whitespace (per the TOML spec).
#   * Trailing comment after the closing bracket is tolerated.
# Form differences:
#   * Bare key (``[tool.ruff]``): standard bare-key character class plus dots,
#     hyphens, and underscores (all spec-allowed).
#   * Quoted key (``["tool.ruff"]``): bracket content can contain characters
#     (dots, slashes) that would otherwise be path separators in a bare key.


# Combined bare-or-quoted TOML table-header regex.  We match both forms in a
# single alternation so :func:`common.scan_flat_headers` only walks the file
# once.  Group ``open`` / ``close`` capture the brackets so we can detect a
# mismatch (``[[name]`` or ``[name]]``); ``bare`` and ``quoted`` capture the
# heading text, exactly one of which is non-empty per successful match.
_TABLE_RE = re.compile(
    r"^(?P<open>\[\[?)\s*"
    r"(?:(?P<bare>[A-Za-z0-9_\-][A-Za-z0-9_\-.]*)"
    r"|\"(?P<quoted>[^\"\n]+)\")"
    r"\s*(?P<close>\]\]?)\s*(?:#.*)?$"
)


def _toml_get_name(m: re.Match[str]) -> str:
    """Return the table heading from a ``_TABLE_RE`` match, or '' to skip.

    Rejects mismatched bracket pairs (``[[name]`` / ``[name]]``) by returning
    the empty string — :func:`common.scan_flat_headers` treats empty headings
    as a skip signal so the malformed line is silently dropped.
    """
    if len(m.group("open")) != len(m.group("close")):
        return ""
    return (m.group("bare") or m.group("quoted") or "").strip()


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract table headers from a TOML file as :class:`Section` entries.

    Always returns four lists (symbols, refs, imports, sections); refs and
    imports are empty for TOML — there is no cross-file reference model.

    Tolerant of malformed input: lines that do not match a header pattern
    are simply not emitted.  A file with no table headers at all produces an
    empty result, which is the correct behaviour — there is nothing to index.
    """
    result = common.scan_flat_headers(
        source,
        _LOG,
        "toml_idx",
        pattern=_TABLE_RE,
        get_name=_toml_get_name,
        symbol_kind="toml_key",
        max_entries=_MAX_SYMBOLS_PER_FILE,
        max_heading_len=_MAX_HEADING_LEN,
        # ``[[`` -> level 2 (array-of-tables); ``[`` -> level 1 (table).
        level_from_match=lambda m: 2 if m.group("open") == "[[" else 1,
        # Headers must start at column 0; the prefilter skips the regex cost
        # on every non-header line (the vast majority of a real TOML file).
        prefilter=lambda c: c.startswith("["),
    )
    if result is None:
        return [], [], [], []
    symbols, sections = result
    return symbols, [], [], sections
