"""Markdown extractor — ATX headings, Setext headings, front-matter titles."""
from __future__ import annotations

__all__ = ["extract"]

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.markdown")

# ATX headings: ^#{1,6} followed by text
_ATX_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)

# Setext headings: underline with === or ---
_SETEXT_H1_RE = re.compile(r"^(.+)\n=+\s*$", re.MULTILINE)
_SETEXT_H2_RE = re.compile(r"^(.+)\n-+\s*$", re.MULTILINE)

# Front-matter YAML: starts with --- and ends with ---
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)

# YAML key: value (simple extraction)
_YAML_TITLE_RE = re.compile(r"^\s*title\s*:\s*(.+?)\s*$", re.MULTILINE)

# Fenced code-block delimiter: opening / closing ``` or ~~~ at start of a line
# (CommonMark requires the fence be the first non-whitespace; here we accept up to
# three leading spaces, matching CommonMark's "indent less than 4 spaces" rule).
_FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")


def _compute_fenced_line_set(lines: list[str]) -> frozenset[int]:
    """Return the set of 1-based line numbers that fall inside a fenced code block.

    A line is considered "inside" if it is between an opening and closing fence
    of the same delimiter style (``` or ~~~).  The fence lines themselves are
    also considered inside so that a heading-like opening fence such as
    ``` ```python  # not a heading``` is never mis-parsed as an ATX heading
    when its first non-fence text is `#`.

    WHY this matters: ATX heading regex matches any line starting with `#`,
    which produces false positives for comments and decorative text inside
    code blocks that document shell scripts, Python code, or YAML.  Treating
    those lines as headings breaks both (a) symbol lookup for the wrong
    heading name and (b) end_line computation for the *real* preceding
    heading (its content gets prematurely truncated at the fake heading).
    """
    inside: set[int] = set()
    fence_char: str | None = None
    for idx, line in enumerate(lines, 1):
        m = _FENCE_RE.match(line)
        if m:
            delim = m.group(1)
            if fence_char is None:
                # Opening fence
                fence_char = delim
                inside.add(idx)
            elif fence_char == delim:
                # Matching closing fence
                inside.add(idx)
                fence_char = None
            # else: a different delimiter while we're inside an open fence — still inside
            else:
                inside.add(idx)
        elif fence_char is not None:
            inside.add(idx)
    return frozenset(inside)


def _trim_trailing_blanks(sections: list[Section], lines: list[str]) -> None:
    """Tighten each section's end_line by stepping back past trailing blank lines.

    After :func:`common._compute_section_end_lines` assigns end_line based on the
    next equal-or-higher-level heading, the resulting range typically includes
    one or more blank lines before that next heading.  Returning those blanks
    in the extracted snippet wastes tokens (the consumer is an LLM; every newline
    is a token).  This pass walks each section's end_line backward while the
    pointed-at line is whitespace-only, but never crosses below the heading
    line itself.

    Mutates *sections* in-place; lines is 0-indexed in the list, 1-indexed in
    the Section metadata.
    """
    n = len(lines)
    for sec in sections:
        if sec.end_line is None:
            continue
        end = min(sec.end_line, n)
        # Always preserve at least the heading line itself.
        while end > sec.line and not lines[end - 1].strip():
            end -= 1
        sec.end_line = end


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract headings and front-matter from a Markdown file.

    Symbols:
      - ``md_title``  — ``title:`` value from YAML front-matter (``---`` fences),
        recorded at line 1.  Only the first front-matter block is inspected.
      - ``heading``   — every ATX heading (``# H1`` … ``###### H6``).
        Setext headings (``===`` and ``---`` underlines) are *not* promoted to
        symbols because their line-number calculation is ambiguous when the
        underline and text are on separate lines, and they rarely appear in
        modern documentation.

    Sections:
      - All ATX headings also become :class:`Section` entries.  ``end_line``
        is assigned by :func:`common._compute_section_end_lines` after the ATX
        heading pass completes.

    Refs and imports are always empty for Markdown files.
    """
    try:
        text = source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        symbols: list[Symbol] = []
        sections: list[Section] = []

        lines = text.split("\n")

        # --- Extract front-matter title ---
        fm_match = _FRONTMATTER_RE.match(text)
        if fm_match:
            fm_content = fm_match.group(1)
            title_match = _YAML_TITLE_RE.search(fm_content)
            if title_match:
                title = title_match.group(1).strip(' "\'')
                symbols.append(Symbol(name=title, kind="md_title", line=1))

        # --- Identify fenced code-block regions so we skip false-positive ATX ---
        fenced_lines = _compute_fenced_line_set(lines)

        # --- Extract ATX headings (#-######), skipping those inside code fences ---
        for match in _ATX_RE.finditer(text):
            level = len(match.group(1))
            heading_text = match.group(2).strip()
            line = text[:match.start()].count("\n") + 1
            # WHY skip: a line starting with '#' inside ```/~~~ is code, not prose.
            # Indexing it as a heading would (a) shadow the real heading by name
            # collision and (b) corrupt the preceding section's end_line by
            # truncating it prematurely at the fake heading.
            if line in fenced_lines:
                continue
            sections.append(Section(heading=heading_text, level=level, line=line))
            symbols.append(
                Symbol(name=heading_text, kind="heading", line=line)
            )

        # --- Compute end_line for sections ---
        common._compute_section_end_lines(sections, lines)
        # Trim trailing blank lines from each section's end_line so extracted
        # snippets don't carry padding tokens before the next heading.
        _trim_trailing_blanks(sections, lines)

        return symbols, [], [], sections
    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        # OverflowError: text.count("\n") on a pathologically large file can overflow on
        # some Python builds; treat it the same as any other parse failure.
        _LOG.debug("parse failed for markdown source %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
