"""Markdown extractor — ATX headings, Setext headings, front-matter titles."""
from __future__ import annotations

__all__ = ["extract"]

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.markdown")

# ATX headings: ^#{1,6} followed by text.
#
# WHY the leading-space cap at 3: CommonMark allows up to three leading spaces
# before an ATX marker; four or more spaces makes the line an indented code
# block, not a heading.  WHY exclude lines that start with `>` or list markers:
# `> ## Quoted` inside a blockquote is a heading *inside the blockquote* (level
# semantics differ) and including it as a top-level section corrupts the
# parent section's end_line.  The same applies to list-item-prefixed headings
# like `- ## item title` which are list content, not document structure.
# We require zero leading whitespace via the negative-look-around-free anchor
# combined with the post-match guard in :func:`_atx_line_is_genuine`.
_ATX_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)

# Setext headings: a line of text followed by a line of === (level 1) or ---
# (level 2).  WHY we don't use a single multi-line regex: the `===`/`---`
# underline must (a) sit immediately below a non-blank text line, (b) not be
# preceded by a blank line, and (c) the text line itself must not be a list
# item, blockquote, or another heading.  These constraints are clearer to
# express as a line-by-line scan than as a single regex.
_SETEXT_H1_UNDERLINE_RE = re.compile(r"^=+\s*$")
_SETEXT_H2_UNDERLINE_RE = re.compile(r"^-+\s*$")
# A horizontal rule (HR) of three or more `-`, `_`, or `*` separated by
# optional spaces.  `---` after a blank line is an HR, not a setext underline.
_HR_RE = re.compile(r"^ {0,3}([-_*])(?:\s*\1){2,}\s*$")

# Front-matter YAML: starts with --- and ends with ---
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)

# YAML key: value (simple extraction)
_YAML_TITLE_RE = re.compile(r"^\s*title\s*:\s*(.+?)\s*$", re.MULTILINE)

# Fenced code-block delimiter: opening / closing ``` or ~~~ at start of a line
# (CommonMark requires the fence be the first non-whitespace; here we accept up to
# three leading spaces, matching CommonMark's "indent less than 4 spaces" rule).
_FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")

# Synthetic heading name for the YAML front-matter block.  Exposed as a Section
# so callers can do `token-goat section path::__frontmatter__` to retrieve only
# the front-matter without dragging in the rest of the document.
FRONTMATTER_HEADING: str = "__frontmatter__"


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


def _is_blockquote_or_list_prefixed(line: str) -> bool:
    """Return True if *line* starts with a blockquote (``>``) or list marker.

    WHY this matters: ``> ## Quoted heading`` and ``- ## Item heading`` both
    match ``_ATX_RE`` because the regex anchors at line start but the indent
    rules let `>` and list markers slip through.  These are *not* document
    structure — they are content inside a blockquote / list item — and indexing
    them as top-level sections corrupts the surrounding section's end_line.
    """
    stripped = line.lstrip(" ")
    if not stripped:
        return False
    # Blockquote prefix.
    if stripped.startswith(">"):
        return True
    # Unordered list markers: -, +, * (with at least one trailing space).
    if len(stripped) >= 2 and stripped[0] in "-+*" and stripped[1] == " ":
        return True
    # Ordered list markers: `1.`, `42.`, `1)`, etc.  WHY the cap at 9 digits:
    # CommonMark caps ordered-list markers at 9 digits; anything longer is
    # treated as paragraph text.
    m = re.match(r"^\d{1,9}[.)]\s", stripped)
    return m is not None


def _find_setext_headings(
    lines: list[str],
    fenced_lines: frozenset[int],
    atx_lines: frozenset[int],
) -> list[tuple[int, int, str]]:
    """Scan *lines* for Setext headings, returning ``(line, level, text)`` tuples.

    A Setext heading is a text line followed by an underline line of ``=`` (H1)
    or ``-`` (H2).  We require:

    * The text line is non-blank, not inside a fenced code block, not itself an
      ATX heading, and not blockquote/list-prefixed.
    * The underline matches ``^=+$`` (H1) or ``^-+$`` (H2) with optional
      trailing whitespace.
    * The underline is *not* a horizontal rule (HR).  An HR like ``---`` after
      a blank line is not a setext underline.  We disambiguate by requiring the
      preceding text line to be non-blank — which is the CommonMark rule.

    The returned ``line`` is the 1-indexed line of the *heading text*, not the
    underline.  Callers can compute the end of the heading block (underline
    line) as ``line + 1`` if needed.
    """
    results: list[tuple[int, int, str]] = []
    n = len(lines)
    # Iterate over potential underline lines (i is 0-indexed).
    for i in range(1, n):
        underline = lines[i]
        if (i + 1) in fenced_lines:
            continue
        h1 = bool(_SETEXT_H1_UNDERLINE_RE.match(underline))
        h2 = bool(_SETEXT_H2_UNDERLINE_RE.match(underline))
        if not (h1 or h2):
            continue
        text_line = lines[i - 1]
        text_lineno = i  # 1-indexed line of the text
        # Skip when text line is blank, inside a fence, an ATX heading, or
        # blockquote/list-prefixed — see CommonMark setext rules.
        if not text_line.strip():
            continue
        if text_lineno in fenced_lines:
            continue
        if text_lineno in atx_lines:
            continue
        if _is_blockquote_or_list_prefixed(text_line):
            continue
        # H2 (`---`) ambiguity with HR: if the previous line is blank, the
        # `---` is an HR, not a setext underline.  We already filtered blank
        # text_line above, so this is implicitly handled.  An H2 underline
        # that is also a valid HR (e.g. ``---``) is *still* a setext underline
        # under CommonMark when the line above is paragraph text.
        level = 1 if h1 else 2
        text = text_line.strip()
        if not text:
            continue
        results.append((text_lineno, level, text))
    return results


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
      - ``heading``   — every ATX heading (``# H1`` … ``###### H6``) **and**
        every Setext heading (``Title\\n===`` / ``Title\\n---``).  Setext
        heading symbols are recorded at the text line, not the underline.

    Sections:
      - All ATX and Setext headings become :class:`Section` entries.
        ``end_line`` is assigned by :func:`common._compute_section_end_lines`
        after both passes complete.
      - When YAML front-matter is present, a synthetic Section named
        ``__frontmatter__`` covers its delimited range.  This lets callers
        retrieve just the front-matter block via
        ``token-goat section path::__frontmatter__``.

    Skipped (intentional):
      - ATX-looking lines inside ``` / ~~~ fenced code blocks.
      - ATX-looking lines that begin with a blockquote marker (``>``) or list
        marker (``-``, ``+``, ``*``, ``1.``, ``1)``).  These are content
        inside a quote/list, not document structure.

    Refs and imports are always empty for Markdown files.
    """
    try:
        text = source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        symbols: list[Symbol] = []
        sections: list[Section] = []

        lines = text.split("\n")

        # --- Extract front-matter title + synthetic section ---
        fm_match = _FRONTMATTER_RE.match(text)
        if fm_match:
            fm_content = fm_match.group(1)
            title_match = _YAML_TITLE_RE.search(fm_content)
            if title_match:
                title = title_match.group(1).strip(' "\'')
                symbols.append(Symbol(name=title, kind="md_title", line=1))
            # The front-matter block runs from line 1 (opening `---`) through
            # the line containing the closing `---`.  We compute the closing
            # line by counting newlines up to (but not including) the matched
            # end offset; this avoids assuming a specific number of lines.
            fm_end_line = text[: fm_match.end()].count("\n")
            # Level 0 keeps it from being treated as a parent of H1 sections
            # by `_compute_section_end_lines` — front-matter is metadata, not
            # document hierarchy.  We pre-assign end_line so the pass below
            # leaves it alone.
            sections.append(
                Section(
                    heading=FRONTMATTER_HEADING,
                    level=0,
                    line=1,
                    end_line=max(1, fm_end_line),
                )
            )

        # --- Identify fenced code-block regions so we skip false-positive ATX ---
        fenced_lines = _compute_fenced_line_set(lines)

        # Track which lines have an ATX heading so the setext pass doesn't
        # double-count a line that's already an ATX heading.
        atx_lines: set[int] = set()

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
            # WHY skip blockquoted / list-prefixed ATX: `> ## Title` and
            # `- ## item` are content inside their container, not top-level
            # document structure.  Indexing them inflates the section count
            # and breaks end_line for the real ancestor section.
            raw_line = lines[line - 1] if 0 <= line - 1 < len(lines) else ""
            if _is_blockquote_or_list_prefixed(raw_line):
                continue
            atx_lines.add(line)
            sections.append(Section(heading=heading_text, level=level, line=line))
            symbols.append(
                Symbol(name=heading_text, kind="heading", line=line)
            )

        # --- Extract Setext headings (Title\n=== or Title\n---) ---
        # WHY after ATX: we need atx_lines populated so setext doesn't pick up
        # text that is already an ATX heading on the line above an underline.
        for s_line, s_level, s_text in _find_setext_headings(
            lines, fenced_lines, frozenset(atx_lines)
        ):
            sections.append(Section(heading=s_text, level=s_level, line=s_line))
            symbols.append(Symbol(name=s_text, kind="heading", line=s_line))

        # Sort sections by line so _compute_section_end_lines walks them in
        # document order.  Without this, an interleaved setext+atx file would
        # produce wrong end_lines because the algorithm assumes sorted input.
        sections.sort(key=lambda sec: sec.line)

        # --- Compute end_line for sections (skip front-matter; already set) ---
        # We split out the front-matter section temporarily so the standard
        # end_line algorithm doesn't try to use its level-0 heading as a
        # boundary for the H1 that may follow it.
        fm_sections = [s for s in sections if s.heading == FRONTMATTER_HEADING]
        body_sections = [s for s in sections if s.heading != FRONTMATTER_HEADING]
        common._compute_section_end_lines(body_sections, lines)
        # Trim trailing blank lines from each body section's end_line so
        # extracted snippets don't carry padding tokens before the next heading.
        _trim_trailing_blanks(body_sections, lines)
        sections = sorted(fm_sections + body_sections, key=lambda sec: sec.line)

        return symbols, [], [], sections
    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        # OverflowError: text.count("\n") on a pathologically large file can overflow on
        # some Python builds; treat it the same as any other parse failure.
        _LOG.debug("parse failed for markdown source %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
