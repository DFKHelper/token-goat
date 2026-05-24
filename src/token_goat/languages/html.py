"""HTML extractor — headings, id/class attributes, link/script imports."""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.html")

# id and class attributes
_ID_RE = re.compile(r'id=["\']([^"\']+)["\']', re.IGNORECASE)
_CLASS_RE = re.compile(r'class=["\']([^"\']+)["\']', re.IGNORECASE)

# Links and scripts
_LINK_RE = re.compile(r'<link[^>]*href=["\']([^"\']+)["\']', re.IGNORECASE)
_SCRIPT_RE = re.compile(r'<script[^>]*src=["\']([^"\']+)["\']', re.IGNORECASE)

# Common HTML classes/ids to skip (noise filter).
# frozenset: immutable (documents intent) and avoids accidental mutation; lookup
# cost is identical to set but construction communicates "this is a constant".
_NOISE_IDS_CLASSES = frozenset({
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p",
    "container", "wrapper", "row", "col", "main", "content", "header", "footer",
    "nav", "navbar", "menu", "button", "link", "text", "box", "section", "page",
})


def _is_noise(name: str) -> bool:
    """Return True if this is a common/noisy id or class."""
    return name.lower() in _NOISE_IDS_CLASSES


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, imports, and sections from an HTML file.

    Symbols:
      - ``html_id``  — ``id="..."`` attribute values (noise-filtered)
      - ``html_class`` — individual class tokens from ``class="..."`` attributes (noise-filtered)

    Imports:
      - ``html_link``   — ``href`` values from ``<link>`` tags (CSS, canonical, etc.)
      - ``html_script`` — ``src`` values from ``<script>`` tags

    Sections:
      - ``<h1>``–``<h6>`` headings become :class:`Section` entries with computed
        ``end_line`` (each heading closes at the next heading of equal or lesser depth).
      - When a heading has an ``id="..."`` attribute, an additional anchor-keyed
        :class:`Section` covering the same span is emitted so the heading can be
        looked up by either text or anchor id.

    The noise filter (``_is_noise``) suppresses generic ids/classes like
    ``container``, ``wrapper``, ``row``, ``col`` that appear in virtually every
    HTML file and produce more noise than signal in symbol indexes.  HTML does
    not expose callable refs, so the refs list is always empty.
    """
    try:
        text = source.decode("utf-8", errors="replace")
        symbols: list[Symbol] = []
        sections: list[Section] = []
        imports: list[ImpExp] = []

        lines = text.split("\n")

        # Build a line-start offset index once; reuse it for all O(log n) lookups
        # instead of the O(n) slice-and-count pattern per match.
        line_index = common.build_line_index(text)

        # --- Extract headings and compute end_line for each section ---
        common.extract_and_finalize_html_sections(text, sections, lines)

        # --- Extract id attributes (with noise filter) ---
        for match in _ID_RE.finditer(text):
            id_val = match.group(1)
            if not _is_noise(id_val):
                line = common.offset_to_line(line_index, match.start())
                symbols.append(Symbol(name=id_val, kind="html_id", line=line))

        # --- Extract class attributes (with noise filter) ---
        for match in _CLASS_RE.finditer(text):
            class_val = match.group(1)
            if any(not _is_noise(cls) for cls in class_val.split()):
                line = common.offset_to_line(line_index, match.start())
                for cls in class_val.split():
                    if not _is_noise(cls):
                        symbols.append(Symbol(name=cls, kind="html_class", line=line))

        # --- Extract link href ---
        for match in _LINK_RE.finditer(text):
            href = match.group(1)
            line = common.offset_to_line(line_index, match.start())
            imports.append(ImpExp(kind="html_link", target=href, line=line))

        # --- Extract script src ---
        for match in _SCRIPT_RE.finditer(text):
            src = match.group(1)
            line = common.offset_to_line(line_index, match.start())
            imports.append(ImpExp(kind="html_script", target=src, line=line))

        return symbols, [], imports, sections
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("parse failed for html source: %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
