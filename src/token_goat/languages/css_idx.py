"""CSS / SCSS / Less extractor — selectors, custom properties, @rules, and mixins.

CSS files can be large (thousands of lines) but agents typically need only one
selector, variable declaration, or @rule block.  This extractor gives
``token-goat section style.css::.btn-primary`` the ability to return a 20-line
rule-set instead of the full stylesheet.

What is extracted
-----------------
Symbols:
* ``css_selector``  — class selectors (``.foo``) and ID selectors (``#foo``),
  one entry per unique selector at its first definition.
* ``css_var``       — custom property declarations (``--name``) at the point of
  their first ``--name:`` assignment.
* ``css_mixin``     — ``@mixin name`` declarations (SCSS / Less).
* ``css_keyframe``  — ``@keyframes name`` declarations.
* ``css_rule``      — general ``@rule`` names not covered above
  (``@media``, ``@layer``, ``@font-face``, ``@supports``, etc.).

Imports:
* ``@import "path"`` / ``@import url("path")`` — CSS / Less file imports.
* ``@use "path"`` — Sass module system import (SCSS).
* ``@forward "path"`` — Sass module re-export (SCSS).
  Each directive produces an :class:`ImpExp` with ``kind="import"`` and
  ``target`` set to the resolved path string.  These entries feed the PageRank
  cross-reference graph and are surfaced by ``token-goat imports``.

Sections:
Each symbol also becomes a Section so ``token-goat section`` can slice the
block body.  End-lines are assigned by the flat algorithm (content up to the
next section header, or EOF for the last one).

What is NOT extracted
---------------------
* Attribute selectors (``[type="text"]``), pseudo-classes (``:hover``), and
  combinators (``>``, ``~``) — far too noisy as standalone symbols.
* Nested SCSS rules inside a mixin — only the top-level mixin is emitted.
* Vendor-prefixed property declarations other than custom properties.

Design choices
--------------
Pure-regex scanner, no tree-sitter.  CSS / SCSS grammars in the tree-sitter
ecosystem have incomplete Windows wheel support as of 2026, and the token-goat
test matrix runs on Windows 2022.  The regex approach covers >95% of real-world
CSS/SCSS/Less patterns with zero native-extension dependencies and is fast
enough for files up to the 2 MB indexer cap.

One regex per category, all column-0-anchored or otherwise positioned to avoid
matching property values that happen to contain selector-like text.  Comment
stripping runs as a pre-pass to avoid false positives inside ``/* ... */``
blocks.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_strip_comments = common.strip_cstyle_comments

_LOG = get_logger("languages.css_idx")

# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

# Block comments ``/* ... */``.  DOTALL so the content can span lines.
# WHY strip rather than track: a comment that opens on line N and closes on
# line M makes every line in [N, M] unreliable for column-0 regex matching.
# Replacing with the same number of newlines preserves line numbers so that
# every extracted symbol's ``line`` is accurate in the *original* source.

# Line comments ``// ...`` (SCSS / Less only; not valid CSS3, but common in
# the wild and harmless to strip unconditionally).

# ---------------------------------------------------------------------------
# Extraction regexes
# ---------------------------------------------------------------------------

# @keyframes name — SCSS and CSS3.  Names can be custom identifiers (no
# leading digit, may include hyphens).  WHY allow "from" / "to": those are
# valid keyframe names in theory, but are so rare at the @keyframes level that
# they're not worth special-casing.
_KEYFRAMES_RE = re.compile(
    r"^[ \t]*@keyframes\s+([-\w]+)", re.MULTILINE
)

# @mixin name (SCSS / Less).
_MIXIN_RE = re.compile(
    r"^[ \t]*@mixin\s+([-\w]+)", re.MULTILINE
)

# @media / @layer / @supports / @font-face / @container / @page etc.
# We capture @rule-name so callers can navigate to e.g. ``@media (max-width:
# 768px)`` blocks.  WHY NOT @keyframes / @mixin: those are extracted above with
# their own kind.  WHY capture up to 80 chars after the @rule-name: media
# queries often span the entire condition (``screen and (max-width: 768px)``)
# and users search for the full expression.
_ATRULE_RE = re.compile(
    r"^[ \t]*(@(?:media|layer|supports|container|page|font-face|charset|namespace|import|use|forward|include)\b[^{;\n]*)",
    re.MULTILINE,
)

# Custom properties: ``--name:`` anywhere in a rule body.  Custom properties
# appear indented inside rule-sets (``  --name: value``) or inline after a ``{``
# (``{ --name: value }``).  We anchor on a preceding whitespace character or
# block-open ``{`` / statement-separator ``;`` so we don't match ``--foo`` inside
# a property value like ``calc(var(--foo) + 1px)``.
# WHY capture only the name: the value is long and varies per override; the name
# is what the user searches for.
_CUSTOM_PROP_RE = re.compile(
    r"(?:^|[\s{;,])\s*(--[-\w]+)\s*:", re.MULTILINE
)

# Class selectors: ``.name`` at column 0 or on its own selector line.  We
# require either the start of a line (with optional whitespace) or a comma-
# separator context.  The character after must NOT be ``{`` / ``,`` / ``}``,
# which would be an empty selector or a block delimiter rather than a name.
# WHY only class/ID: element selectors (``div``, ``p``) are too generic to be
# useful as jump targets; they'd flood the index.
_CLASS_SELECTOR_RE = re.compile(
    r"(?:^|\s|,)(\.[-\w]+)(?=\s*[{,\s])", re.MULTILINE
)

# ID selectors: ``#name`` — same constraints as class selectors.
_ID_SELECTOR_RE = re.compile(
    r"(?:^|\s|,)(#[-\w]+)(?=\s*[{,\s])", re.MULTILINE
)

# ---------------------------------------------------------------------------
# Import extraction
# ---------------------------------------------------------------------------

# CSS ``@import "path"`` / ``@import url("path")``
# SCSS ``@use "path"`` / ``@forward "path"``
# Matches both quoted strings and url() forms, strips optional layer/with
# modifiers.  Single or double quotes accepted.
# WHY three distinct patterns collapsed into one: ``@import``, ``@use``, and
# ``@forward`` all introduce a cross-file dependency; tooling (PageRank,
# ``token-goat imports``) should see all three as import edges.
_CSS_IMPORT_RE = re.compile(
    r"""^[ \t]*@(?:import|use|forward)\s+          # directive keyword
        (?:url\()?                                  # optional url( wrapper
        ['"]([^'"]+)['"]                            # the path in quotes
    """,
    re.MULTILINE | re.VERBOSE,
)

# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

_MAX_SYMBOLS: int = 1000
_MAX_HEADING_LEN: int = 120

def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract CSS / SCSS / Less symbols, imports, and sections from *source*.

    The return signature matches every other language extractor in
    ``token_goat.languages``: ``(symbols, refs, imports, sections)``.
    ``@import``, ``@use``, and ``@forward`` directives are returned as
    :class:`ImpExp` entries with ``kind="import"``, feeding the PageRank
    cross-reference graph used by ``token-goat imports``.
    """
    text = common.decode_source_text(source, _LOG, "css_idx")
    if text is None:
        return [], [], [], []

    try:
        stripped = _strip_comments(text)
        lines = text.split("\n")
        total_lines = len(lines)

        symbols: list[Symbol] = []
        imp_exp: list[ImpExp] = []
        sections: list[Section] = []
        seen: set[tuple[str, int]] = set()

        _emit = common.make_symbol_emitter(
            symbols, sections, seen, max_symbols=_MAX_SYMBOLS
        )

        # @import / @use / @forward — extract import edges
        for m in _CSS_IMPORT_RE.finditer(stripped):
            path = m.group(1).strip()
            if path:
                line = stripped[: m.start()].count("\n") + 1
                imp_exp.append(ImpExp(kind="import", target=path, line=line))

        # @keyframes
        for m in _KEYFRAMES_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(f"@keyframes {name}", "css_keyframe", line)

        # @mixin
        for m in _MIXIN_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(f"@mixin {name}", "css_mixin", line)

        # @rules (media, layer, supports, etc.)
        for m in _ATRULE_RE.finditer(stripped):
            raw = m.group(1).strip()
            # Normalize whitespace runs inside the query for compact headings.
            name = re.sub(r"\s+", " ", raw)
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "css_rule", line)

        # Custom properties (--name).
        # WHY start(1): the match includes a leading whitespace/punctuation
        # character before the --name; using start(1) gives the position of the
        # captured group itself so line numbers are accurate.
        seen_vars: set[str] = set()
        for m in _CUSTOM_PROP_RE.finditer(stripped):
            name = m.group(1).strip()
            if name and name not in seen_vars:
                seen_vars.add(name)
                line = stripped[: m.start(1)].count("\n") + 1
                _emit(name, "css_var", line)

        # Class selectors.  WHY start(1): same reason as custom properties above.
        seen_cls: set[str] = set()
        for m in _CLASS_SELECTOR_RE.finditer(stripped):
            name = m.group(1).strip()
            if name and name not in seen_cls:
                seen_cls.add(name)
                line = stripped[: m.start(1)].count("\n") + 1
                _emit(name, "css_selector", line)

        # ID selectors.  WHY start(1): same reason as custom properties above.
        seen_ids: set[str] = set()
        for m in _ID_SELECTOR_RE.finditer(stripped):
            name = m.group(1).strip()
            if name and name not in seen_ids:
                seen_ids.add(name)
                line = stripped[: m.start(1)].count("\n") + 1
                _emit(name, "css_selector", line)

        # Sort sections by line then assign end_lines.
        sections.sort(key=lambda s: s.line)
        common.assign_flat_end_lines(sections, total_lines)
        # Propagate computed end_lines to Symbol objects so that
        # ``token-goat scope`` can match enclosing CSS blocks.
        common.propagate_section_end_lines_to_symbols(symbols, sections)

        return symbols, [], imp_exp, sections

    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        _LOG.debug("css_idx: parse failed for %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
