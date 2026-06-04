"""Makefile extractor — target names and ``define`` blocks.

Makefiles are common in Go, C/C++, Python, and many other projects as the
top-level build orchestrator.  Agents often need to know "what targets does
this Makefile have?" without reading the full file.  This extractor surfaces
target names and ``define … endef`` variable blocks so
``token-goat symbol test`` jumps to the ``test:`` target and
``token-goat section Makefile::build`` returns just the build recipe.

What is extracted
-----------------
Symbols:
* ``makefile_target`` — any target declared at column 0 matching
  ``target:`` or ``target::`` (phony targets, double-colon rules).
  Variable-expansion targets (``$(foo):``) and pattern rules (``%.o:``)
  are included when the whole expression precedes the colon; they are
  excluded only when the target is nothing but whitespace.
  POSIX-special internal targets (``.PHONY``, ``.DEFAULT``, ``.SUFFIXES``,
  ``.SILENT``, ``.PRECIOUS``, ``.IGNORE``, ``.NOTPARALLEL``, ``.ONESHELL``,
  ``.EXPORT_ALL_VARIABLES``, ``.INTERMEDIATE``, ``.SECONDARY``,
  ``.DELETE_ON_ERROR``, ``.LOW_RESOLUTION_TIME``, ``.POSIX``) are NOT
  emitted as user-visible symbols to avoid polluting the symbol list with
  internal directives.
* ``makefile_define`` — ``define VARNAME … endef`` multi-line variable blocks.

Sections:
Each target and define block also becomes a Section so
``token-goat section Makefile::clean`` can return just that target's recipe.
Section end-lines follow the flat algorithm: content runs from the line after
the header up to the line before the next section header (or EOF).

What is NOT extracted
---------------------
* Simple variable assignments (``CC = gcc``, ``CC := gcc``, ``CC ?= gcc``) —
  these are too numerous and ephemeral to be useful as jump targets; use
  ``token-goat section`` for the surrounding recipe instead.
* Pattern rules with no named target (``%.o: %.c``) are included, since
  ``%.o`` is a legitimate named pattern useful to navigate.
* Implicit rule bodies (rules whose ``target:`` has no recipe) are still
  indexed; the extractor doesn't look inside recipe bodies.

Design choices
--------------
Pure-regex scanner, no tree-sitter.  The Makefile tree-sitter grammar has
incomplete Windows wheel support as of 2026, and the token-goat test matrix
runs on Windows 2022.  A regex-based approach covers all standard Makefile
dialects (GNU make, BSD make, POSIX make) with zero native-extension
dependencies.

Comment stripping runs as a pre-pass (``# …`` to end-of-line) so that
commented-out targets don't pollute the index.  Line continuations
(``trailing-backslash`` newlines) inside recipe bodies are not significant
for the extractor since we only care about target-definition lines, which
are never continued.

Column-0 anchoring for both the target pattern and ``define`` is mandatory:
a recipe line that happens to look like ``\tclean:`` (inside another
target's body) must not create a new target.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.makefile_idx")

# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

# A Makefile comment is ``# …`` to end-of-line.  We preserve the newline so
# that line numbers stay accurate.  Backslash-escaped ``\#`` inside values is
# rare in practice and we intentionally don't handle it here — this extractor
# only cares about column-0 patterns which are never inside ``\#`` contexts.
_COMMENT_RE = re.compile(r"#[^\n]*")


def _strip_comments(text: str) -> str:
    """Replace comment regions with blanks, preserving line numbers."""
    return _COMMENT_RE.sub(lambda m: " " * len(m.group()), text)


# ---------------------------------------------------------------------------
# Extraction regexes
# ---------------------------------------------------------------------------

# Target rule: column-0 non-whitespace characters followed by a colon (single
# or double), optionally followed by prerequisites on the same line.
# Groups: (1) target name (everything before the first colon, stripped).
# WHY allow leading tab on prerequisites: we only match column-0 lines so the
# tab on the target line can't appear.
# WHY stop at ``=``: lines like ``VAR = value`` are variable assignments, not
# targets.  We exclude them via the negative lookahead ``(?![^:]*=)``.
# WHY [^\t\n#]: tabs or newlines before the colon mean this is a recipe
# continuation, not a target declaration.
_TARGET_RE = re.compile(
    r"^([^\t\n#:=][^:\n#=]*?):{1,2}\s*(?:[^=\n]|$)",
    re.MULTILINE,
)

# ``define VARNAME`` at column 0.
# Groups: (1) the variable name following ``define``.
_DEFINE_RE = re.compile(
    r"^define\s+([\w./%$()\-]+)",
    re.MULTILINE,
)

# Internal (special) targets that GNU make reserves — never emitted as symbols.
_SPECIAL_TARGETS: frozenset[str] = frozenset({
    ".PHONY", ".DEFAULT", ".SUFFIXES", ".SILENT", ".PRECIOUS",
    ".IGNORE", ".NOTPARALLEL", ".ONESHELL", ".EXPORT_ALL_VARIABLES",
    ".INTERMEDIATE", ".SECONDARY", ".DELETE_ON_ERROR",
    ".LOW_RESOLUTION_TIME", ".POSIX", ".MAKEFLAGS",
})

# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

_MAX_SYMBOLS: int = 500
_MAX_HEADING_LEN: int = 120


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract Makefile targets and ``define`` blocks as symbols and sections.

    Returns ``(symbols, refs, imports, sections)``.  Refs and imports are
    always empty — Makefiles have no cross-file call-site model meaningful
    to this extractor.
    """
    text = common.decode_source_text(source, _LOG, "makefile_idx")
    if text is None:
        return [], [], [], []

    try:
        stripped = _strip_comments(text)
        lines = text.split("\n")
        total_lines = len(lines)

        symbols: list[Symbol] = []
        sections: list[Section] = []
        seen: set[tuple[str, int]] = set()

        def _emit(name: str, kind: str, line: int) -> None:
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

        # Targets
        for m in _TARGET_RE.finditer(stripped):
            raw_target = m.group(1).strip()
            # Skip purely whitespace or empty targets (shouldn't happen with
            # the regex but defensive).
            if not raw_target:
                continue
            # Skip internal special targets.
            if raw_target in _SPECIAL_TARGETS:
                continue
            line = stripped[: m.start()].count("\n") + 1
            _emit(raw_target, "makefile_target", line)

        # define blocks
        for m in _DEFINE_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "makefile_define", line)

        # Sort sections by line then assign end-lines using the flat algorithm.
        sections.sort(key=lambda s: s.line)
        common.assign_flat_end_lines(sections, total_lines)
        # Propagate computed end_lines to Symbol objects so that
        # ``token-goat scope`` can match enclosing Makefile targets.
        common.propagate_section_end_lines_to_symbols(symbols, sections)

        return symbols, [], [], sections

    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        _LOG.debug("makefile_idx: parse failed for %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
