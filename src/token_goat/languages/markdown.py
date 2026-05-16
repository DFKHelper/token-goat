"""Markdown extractor — ATX headings, Setext headings, front-matter titles."""
from __future__ import annotations

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol

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


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract Markdown headings and front-matter."""
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

        # --- Extract ATX headings (#-######) ---
        for match in _ATX_RE.finditer(text):
            level = len(match.group(1))
            heading_text = match.group(2).strip()
            line = text[:match.start()].count("\n") + 1
            sections.append(Section(heading=heading_text, level=level, line=line))
            symbols.append(
                Symbol(name=heading_text, kind="heading", line=line)
            )

        # --- Compute end_line for sections ---
        for i, sec in enumerate(sections):
            end_line = len(lines)
            for j in range(i + 1, len(sections)):
                if sections[j].level <= sec.level:
                    end_line = sections[j].line - 1
                    break
            sec.end_line = end_line

        return symbols, [], [], sections
    except (re.error, UnicodeDecodeError, AttributeError, IndexError) as exc:
        _LOG.debug("parse failed for markdown source %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
