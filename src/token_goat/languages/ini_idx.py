"""INI / CFG / .env extractor — one Section per ``[section]`` header.

INI-family configuration files are line-oriented and unambiguous: a
``[name]`` header at column 0 opens a section that spans every following
line until the next header or EOF.  ``.env`` (dotenv) files have no section
syntax at all — they are flat ``KEY=value`` pairs — so for those we emit
one ``env_key`` symbol per top-level assignment and skip sections entirely.

Why a custom scanner rather than :mod:`configparser`:

* :mod:`configparser` parses to a dict and discards source positions.  We
  need start/end line numbers so ``token-goat section`` can slice the source
  file back out.

* INI dialects vary (Windows ``;`` comments vs Unix ``#``; multi-line values
  with continuation indent; spaces in keys).  A targeted line scanner gives
  predictable, low-surprise behaviour without inheriting configparser's
  strictness on edge cases that token-goat does not need to enforce.

Section model
-------------
* ``heading``: the bracketed name, lowercased and trimmed.  Dotted/colon-
  separated sections like ``[tool.black]`` or ``[mysqld:replica]`` are kept
  verbatim so callers can target the exact name they see in the file.
* ``level``: always 1 — INI has no nested headers.
* ``line``: 1-based line of the header.
* ``end_line``: 1-based last line of the section's content (the line
  immediately before the next header, or EOF for the trailing entry).

The ``.env`` path emits no sections — only the per-key symbols — because
treating each top-level key as a "section" would produce one entry per
line and inflate the index for what is already a small flat file.
"""
from __future__ import annotations

__all__ = ["extract", "extract_env"]

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol

_LOG = logging.getLogger("token_goat.languages.ini_idx")

# Column-0-anchored ``[name]`` header.  We allow letters, digits, underscores,
# hyphens, dots, colons, and slashes in the name — this covers every dialect
# I've seen in the wild (``[tool.black]`` in setup.cfg, ``[mysqld:replica]``
# in my.cnf, ``[group/sub]`` in PHP-FPM pools) without admitting whitespace
# or quotes that would indicate a malformed line.
_HEADER_RE = re.compile(r"^\[([A-Za-z0-9_\-.:/]+)\]\s*(?:[;#].*)?$")

# Maximum number of headers indexed per file.  Real INI files top out in the
# low tens; the cap is generous so a hand-typed config never hits it but
# tight enough to bound a pathological generated file (Apache ``vhost`` dumps,
# Windows ``.ini`` exports with thousands of entries).
_MAX_SECTIONS: int = 200
# Maximum length of a section header we accept.  Real names are short.
_MAX_HEADING_LEN: int = 200


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract INI/CFG ``[section]`` headers as Section + Symbol entries.

    Refs and imports are always empty for INI files — there is no cross-file
    reference model in this format.
    """
    try:
        text = source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except (UnicodeDecodeError, AttributeError) as exc:
        _LOG.debug("ini_idx: decode failed for %s: %s", rel_path, exc)
        return [], [], [], []

    lines = text.split("\n")
    sections: list[Section] = []
    symbols: list[Symbol] = []

    for idx, line in enumerate(lines, start=1):
        # Strip a UTF-8 BOM if present at file start so the column-0 anchor
        # still matches a header on line 1 of a BOM-saved file (Notepad on
        # Windows defaults to UTF-8 with BOM for plain-text saves).
        candidate = line.lstrip("﻿") if idx == 1 else line
        if not candidate or candidate[0] != "[":
            continue
        m = _HEADER_RE.match(candidate)
        if m is None:
            continue
        name = m.group(1).strip()
        if not name or len(name) > _MAX_HEADING_LEN:
            continue
        sections.append(Section(heading=name, level=1, line=idx))
        symbols.append(Symbol(name=name, kind="ini_section", line=idx))
        if len(sections) >= _MAX_SECTIONS:
            break

    # End-line computation: each section spans from its header through the
    # line before the next header (or EOF for the trailing section).  This is
    # the same shape as TOML — both formats are flat at the source level even
    # when their names look hierarchical.
    total = len(lines)
    for i, sec in enumerate(sections):
        if i + 1 < len(sections):
            sec.end_line = max(sec.line, sections[i + 1].line - 1)
        else:
            sec.end_line = max(sec.line, total)

    return symbols, [], [], sections


# A flat ``KEY=value`` assignment at column 0.  ``=`` and ``:`` are both
# accepted as the separator because real-world ``.env`` and ``.envrc`` files
# use either; the key body matches the standard shell-identifier character
# class.  Lines with leading whitespace are intentionally skipped — they are
# either continuation values or invalid — and lines starting with ``#`` /
# ``;`` are comments.
_ENV_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]")

# Maximum number of env keys captured per file.  Production ``.env`` files
# rarely exceed a few dozen; the cap is conservative against pathological
# auto-generated dumps.
_MAX_ENV_KEYS: int = 200


def extract_env(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract ``.env`` / ``.envrc`` top-level keys as ``env_key`` symbols.

    Sections, refs, and imports are always empty for dotenv files: the format
    is flat by design and there is no surrounding "block" to slice.  Each
    captured key carries its 1-based line number so ``token-goat symbol``
    points at the assignment.
    """
    try:
        text = source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except (UnicodeDecodeError, AttributeError) as exc:
        _LOG.debug("ini_idx: env decode failed for %s: %s", rel_path, exc)
        return [], [], [], []

    symbols: list[Symbol] = []
    for idx, line in enumerate(text.split("\n"), start=1):
        candidate = line.lstrip("﻿") if idx == 1 else line
        if not candidate or candidate[0] in "#;":
            continue
        # Reject leading whitespace defensively: continuation lines and shell
        # heredoc bodies must not be mistaken for key assignments.
        if candidate[0] in " \t":
            continue
        m = _ENV_KEY_RE.match(candidate)
        if m is None:
            continue
        name = m.group(1)
        if not name or len(name) > _MAX_HEADING_LEN:
            continue
        symbols.append(Symbol(name=name, kind="env_key", line=idx))
        if len(symbols) >= _MAX_ENV_KEYS:
            break

    return symbols, [], [], []
