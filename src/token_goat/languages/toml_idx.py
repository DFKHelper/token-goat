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

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol

_LOG = logging.getLogger("token_goat.languages.toml_idx")

# Maximum table-header line value persisted as ``end_line`` for the last
# section in a file.  Pegged at the actual EOF line — TOML files do not have
# nested headers, so the last header runs to the bottom.
_MAX_HEADING_LEN: int = 200
_MAX_SYMBOLS_PER_FILE: int = 500

# Strict TOML table-header regex:
#   * Column-0 anchored — no leading whitespace (per the TOML spec).
#   * Table name allows the standard bare-key character class plus dots; we
#     intentionally accept hyphens and underscores because both are common
#     and explicitly allowed by TOML.
#   * Trailing comment after the closing bracket is tolerated.
#   * Quoted keys (``["tool.ruff"]``) are matched separately because their
#     bracket content can contain dots that are *not* path separators.
_BARE_TABLE_RE = re.compile(
    r"^(\[\[?)\s*([A-Za-z0-9_\-][A-Za-z0-9_\-.]*)\s*(\]\]?)\s*(?:#.*)?$"
)
_QUOTED_TABLE_RE = re.compile(
    r"^(\[\[?)\s*\"([^\"\n]+)\"\s*(\]\]?)\s*(?:#.*)?$"
)


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
    try:
        text = source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except (UnicodeDecodeError, AttributeError) as exc:
        _LOG.debug("toml_idx: decode failed for %s: %s", rel_path, exc)
        return [], [], [], []

    lines = text.split("\n")
    sections: list[Section] = []
    symbols: list[Symbol] = []

    for idx, line in enumerate(lines, start=1):
        # Strip a UTF-8 BOM if present at file start.  The regex anchors at
        # column 0 and would otherwise miss a header on line 1 of a BOM file.
        candidate = line.lstrip("﻿") if idx == 1 else line
        # Headers must start at column 0 — leading whitespace makes the line
        # either invalid TOML or a key inside an inline table.
        if not candidate.startswith("["):
            continue
        m = _BARE_TABLE_RE.match(candidate)
        if m is None:
            m = _QUOTED_TABLE_RE.match(candidate)
            if m is None:
                continue
        open_bracket, name, close_bracket = m.group(1), m.group(2).strip(), m.group(3)
        # ``[[...]]`` requires matching ``]]``; reject mismatched bracket
        # pairs (``[[name]`` or ``[name]]``) as malformed and skip them.
        if len(open_bracket) != len(close_bracket):
            continue
        if not name or len(name) > _MAX_HEADING_LEN:
            continue
        level = 2 if open_bracket == "[[" else 1
        sections.append(
            Section(heading=name, level=level, line=idx)
        )
        symbols.append(
            Symbol(name=name, kind="toml_key", line=idx)
        )
        if len(symbols) >= _MAX_SYMBOLS_PER_FILE:
            break

    # Compute end_line for each section.  TOML has no nested table structure
    # at the source level — every header is a top-level marker — so the end
    # of section N is simply the line before section N+1, or the last line of
    # the file for the final section.
    total = len(lines)
    for i, sec in enumerate(sections):
        if i + 1 < len(sections):
            sec.end_line = max(sec.line, sections[i + 1].line - 1)
        else:
            sec.end_line = max(sec.line, total)

    return symbols, [], [], sections
