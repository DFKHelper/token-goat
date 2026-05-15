"""HTML extractor — headings, id/class attributes, link/script imports."""
from __future__ import annotations

import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.html")

# Heading tags
_H_TAG_RE = re.compile(r"<h([1-4])[^>]*>([^<]*)</h\1>", re.IGNORECASE | re.DOTALL)

# id and class attributes
_ID_RE = re.compile(r'id=["\']([^"\']+)["\']', re.IGNORECASE)
_CLASS_RE = re.compile(r'class=["\']([^"\']+)["\']', re.IGNORECASE)

# Links and scripts
_LINK_RE = re.compile(r'<link[^>]*href=["\']([^"\']+)["\']', re.IGNORECASE)
_SCRIPT_RE = re.compile(r'<script[^>]*src=["\']([^"\']+)["\']', re.IGNORECASE)

# Common HTML classes/ids to skip (noise filter)
_NOISE_IDS_CLASSES = {
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p",
    "container", "wrapper", "row", "col", "main", "content", "header", "footer",
    "nav", "navbar", "menu", "button", "link", "text", "box", "section", "page",
}


def _is_noise(name: str) -> bool:
    """Return True if this is a common/noisy id or class."""
    return name.lower() in _NOISE_IDS_CLASSES


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract HTML headings, ids, classes, links, scripts."""
    try:
        text = source.decode("utf-8", errors="replace")
        symbols: list[Symbol] = []
        sections: list[Section] = []
        imports: list[ImpExp] = []

        lines = text.split("\n")

        # --- Extract headings ---
        for match in _H_TAG_RE.finditer(text):
            level = int(match.group(1))
            heading_text = match.group(2).strip()
            if heading_text:
                heading_text = heading_text[:100]
                line = text[:match.start()].count("\n") + 1
                sections.append(Section(heading=heading_text, level=level, line=line))

        # Compute end_line for sections
        common._compute_section_end_lines(sections, lines)

        # --- Extract id attributes (with noise filter) ---
        for match in _ID_RE.finditer(text):
            id_val = match.group(1)
            if not _is_noise(id_val):
                line = text[:match.start()].count("\n") + 1
                symbols.append(Symbol(name=id_val, kind="html_id", line=line))

        # --- Extract class attributes (with noise filter) ---
        for match in _CLASS_RE.finditer(text):
            class_val = match.group(1)
            for cls in class_val.split():
                if not _is_noise(cls):
                    line = text[:match.start()].count("\n") + 1
                    symbols.append(Symbol(name=cls, kind="html_class", line=line))

        # --- Extract link href ---
        for match in _LINK_RE.finditer(text):
            href = match.group(1)
            line = text[:match.start()].count("\n") + 1
            imports.append(ImpExp(kind="html_link", target=href, line=line))

        # --- Extract script src ---
        for match in _SCRIPT_RE.finditer(text):
            src = match.group(1)
            line = text[:match.start()].count("\n") + 1
            imports.append(ImpExp(kind="html_script", target=src, line=line))

        return symbols, [], imports, sections
    except Exception:
        _LOG.debug("parse failed for html source: %s", rel_path, exc_info=True)
        return [], [], [], []
