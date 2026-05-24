"""Dockerfile extractor — one Section per ``FROM`` build stage.

A Dockerfile is a flat list of instructions where ``FROM`` introduces a new
build stage and every subsequent ``RUN`` / ``COPY`` / ``ENV`` / etc. applies
within that stage until the next ``FROM`` or EOF.  Multi-stage Dockerfiles
(``FROM ... AS builder`` followed by ``FROM ... AS runtime``) are the natural
unit of sectioning: an agent debugging a build typically wants one stage's
body, not the whole file.

Sections
--------
* Each ``FROM`` line opens a new section.  When the line ends with
  ``AS <name>`` the section heading is the stage name; otherwise it is the
  image reference (e.g. ``python:3.11``) so the section is still addressable.
* ``level`` is always 1 — Dockerfiles have no nesting at the section level.
* ``end_line`` is the line before the next ``FROM`` or EOF for the last stage.

Symbols
-------
The same headings are emitted as ``dockerfile_stage`` symbols so
``token-goat symbol builder`` jumps straight to ``FROM python:3.11 AS builder``.
Other instructions (``RUN``, ``COPY``, etc.) are intentionally not indexed —
they don't have stable names and inflating the symbol table with per-line
entries would hurt the surrounding map / global search.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.dockerfile_idx")

# Column-0-anchored ``FROM`` instruction.  Dockerfile keywords are
# case-insensitive ("FROM" and "from" both work) per the official spec; we
# also tolerate trailing comments after the instruction body.  The trailing
# ``AS <name>`` clause is captured separately so we can prefer the stage
# name as the section heading when present.
_FROM_RE = re.compile(
    r"^\s*FROM\s+(?P<image>[^\s#]+)(?:\s+AS\s+(?P<alias>[A-Za-z0-9_\-]+))?\s*(?:#.*)?$",
    re.IGNORECASE,
)

# Maximum number of stages indexed.  Real multi-stage Dockerfiles top out at
# a handful (build → test → runtime is common; >10 stages is rare).
_MAX_STAGES: int = 50
# Maximum heading length we accept (image refs can be long but anything past
# this is pathological).
_MAX_HEADING_LEN: int = 200


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract ``FROM`` stages as Section + Symbol entries.

    Refs and imports are always empty for Dockerfiles — there is no
    cross-file reference model.
    """
    text = common.decode_source_text(source, _LOG, "dockerfile_idx")
    if text is None:
        return [], [], [], []

    lines = text.split("\n")
    sections: list[Section] = []
    symbols: list[Symbol] = []

    for idx, line in enumerate(lines, start=1):
        # BOM-strip on line 1 (Notepad-on-Windows defaults to UTF-8-BOM).
        candidate = common.bom_strip_first_line(line, idx)
        m = _FROM_RE.match(candidate)
        if m is None:
            continue
        alias = (m.group("alias") or "").strip()
        image = (m.group("image") or "").strip()
        # Prefer the AS-alias when present — it is the stage's *intended*
        # name, the one ``COPY --from=<name>`` will reference.  Fall back to
        # the image reference so unnamed stages remain addressable.
        heading = alias or image
        if not heading or len(heading) > _MAX_HEADING_LEN:
            continue
        sections.append(Section(heading=heading, level=1, line=idx))
        symbols.append(Symbol(name=heading, kind="dockerfile_stage", line=idx))
        if len(sections) >= _MAX_STAGES:
            break

    common.assign_flat_end_lines(sections, len(lines))

    return symbols, [], [], sections
