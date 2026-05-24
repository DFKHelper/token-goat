"""YAML extractor — emits Sections for top-level keys and (optionally) nested ones.

Why a line-scanner rather than PyYAML:

* PyYAML is not a token-goat dependency.  Pulling it in just for source-line
  positions is disproportionate: the indexer already takes ~1 s on a fresh
  install and a YAML parse for every file would add measurable overhead.

* The structure we need is shallow: top-level keys and (optionally) the keys
  one level below.  Both can be detected by a line-by-line scan that tracks
  column-0 keys (top level) and configurable-indent keys (one level deep).

What counts as a "section"
--------------------------
* A line of the form ``^([A-Za-z_][\\w-]*):`` at column 0 starts a top-level
  section.  Its content runs from that line through the line before the next
  column-0 key (or EOF for the last one).

* Inside each section, lines indented with exactly the file's detected
  indent (almost always 2 spaces) of the form ``<indent>([A-Za-z_][\\w-]*):``
  are emitted as nested ``parent.child`` sections.  This lets callers do
  ``token-goat section deployment.yaml::spec.replicas`` instead of pulling
  the whole spec block.

What is intentionally skipped
-----------------------------
* List items (``- foo:``) — these are sequence entries, not keys, and would
  bloat the section table with positional noise.
* Multi-document YAML (``---``-separated streams) — we treat the file as a
  single logical document.  In practice ``---`` is rarely used for source-
  code-adjacent YAML (CI configs, ansible playbooks, k8s manifests) where
  this hint matters; the rare multi-doc file simply gets its first document
  indexed and the rest fall through.
* Lines inside flow-style mappings (``{ … }``) — the line scanner cannot
  reliably track flow scope without a full parse, so any line that starts
  inside a brace block is left to the read path to handle.
* Comments and blank lines.

Safety
------
A pathologically structured file (mixed indents, tabs, alternating styles)
may produce inaccurate end_line values for nested sections.  This degrades
gracefully: the worst outcome is that ``token-goat section`` returns a
slightly larger or smaller slice than the user expected, never a crash.
"""
from __future__ import annotations

__all__ = ["extract"]

import re
from collections.abc import Iterable

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.yaml_idx")

# Largest indent width (in spaces) we treat as a single nesting level.  Above
# this the file is assumed to use an unusual style and we suppress nested
# section emission rather than guess wrong.
_MAX_DETECTED_INDENT: int = 8
# Maximum number of top-level + nested sections combined per file.  A
# misbehaving generated YAML (thousands of leaf keys at column 0) could
# otherwise inflate the index without bound.
_MAX_SECTIONS_PER_FILE: int = 400
# Maximum length of a heading we accept.  Real YAML keys are short
# (tens of characters); a giant captured "key" is almost certainly a
# pathological line and we drop it rather than store it.
_MAX_HEADING_LEN: int = 200

# Match a top-level key: column-0 anchor, ASCII identifier-ish characters,
# trailing colon.  We allow hyphens and dots because those are common in
# real-world YAML (e.g. Kubernetes labels), but stop before ``:`` so the
# captured name does not include the value or inline annotation.
_TOP_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)")
# A generic indented key — same body, but with leading spaces.  The caller
# decides whether the indent matches a nesting level we are willing to emit.
_INDENTED_KEY_RE = re.compile(r"^( +)([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)")


def _detect_indent(lines: Iterable[str]) -> int:
    """Heuristically detect the file's per-level indent width (in spaces).

    Returns the smallest non-zero indent observed on a key-shaped line, capped
    at :data:`_MAX_DETECTED_INDENT`.  Falls back to ``2`` when no indented
    key is found — that is the default for nearly every modern YAML style guide.
    Tabs are not supported as indent leaders (rare in modern YAML; the spec
    technically forbids them for indentation though some parsers accept them).
    """
    smallest = 0
    for line in lines:
        if not line or line[0] != " ":
            continue
        # Skip pure comment/empty lines.
        stripped = line.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        m = _INDENTED_KEY_RE.match(line)
        if m is None:
            continue
        width = len(m.group(1))
        if 0 < width <= _MAX_DETECTED_INDENT and (smallest == 0 or width < smallest):
            smallest = width
            if smallest == 1:
                break
    return smallest or 2


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract top-level (and one-level-nested) YAML keys as :class:`Section` entries.

    Symbols mirror the section headings as ``yaml_key`` (top level) and
    ``yaml_nested_key`` (one level deep).  Refs and imports are always empty.
    """
    text = common.decode_source_text(source, _LOG, "yaml_idx")
    if text is None:
        return [], [], [], []

    lines = text.split("\n")
    if not lines:
        return [], [], [], []

    indent_unit = _detect_indent(lines)

    sections: list[Section] = []
    symbols: list[Symbol] = []
    # Tracks the most recent top-level section so we can prefix nested keys
    # with their parent name (``spec.replicas`` rather than just ``replicas``).
    current_top: Section | None = None

    for idx, line in enumerate(lines, start=1):
        # Strip a UTF-8 BOM if present on line 1; otherwise the column-0
        # regex anchor would miss the first key.
        candidate = common.bom_strip_first_line(line, idx)
        if not candidate or candidate.startswith("#"):
            continue
        # Multi-document marker resets the parser state for the next doc.
        if candidate.startswith("---") or candidate.startswith("..."):
            current_top = None
            continue

        # Top-level key (column 0)
        m = _TOP_KEY_RE.match(candidate)
        if m is not None:
            name = m.group(1)
            if not name or len(name) > _MAX_HEADING_LEN:
                continue
            sec = Section(heading=name, level=1, line=idx)
            sections.append(sec)
            symbols.append(Symbol(name=name, kind="yaml_key", line=idx))
            current_top = sec
            if len(sections) >= _MAX_SECTIONS_PER_FILE:
                break
            continue

        # Nested key at exactly one indent level deep.
        m = _INDENTED_KEY_RE.match(candidate)
        if m is None or current_top is None:
            continue
        leading = m.group(1)
        if len(leading) != indent_unit:
            continue
        child_name = m.group(2)
        if not child_name or len(child_name) > _MAX_HEADING_LEN:
            continue
        full_name = f"{current_top.heading}.{child_name}"
        if len(full_name) > _MAX_HEADING_LEN:
            continue
        sections.append(
            Section(heading=full_name, level=2, line=idx)
        )
        symbols.append(
            Symbol(name=full_name, kind="yaml_nested_key", line=idx)
        )
        if len(sections) >= _MAX_SECTIONS_PER_FILE:
            break

    # End-line computation.  Each section runs until the line before the next
    # section at the *same or shallower* level — same logic as Markdown's
    # heading nesting.  The last section runs to EOF.
    total = len(lines)
    for i, sec in enumerate(sections):
        end_line = total
        for j in range(i + 1, len(sections)):
            if sections[j].level <= sec.level:
                end_line = max(sec.line, sections[j].line - 1)
                break
        sec.end_line = end_line

    return symbols, [], [], sections
