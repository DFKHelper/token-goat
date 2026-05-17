"""Shopify Liquid template extractor — includes, sections, renders, schema, HTML headings."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from ..parser import ImpExp, Ref, Section, Symbol
from . import common
from .html import _build_line_index, _offset_to_line

_LOG = logging.getLogger("token_goat.languages.liquid")

# Regex for {% include 'snippet-name' %}, {% section 'name' %}, {% render 'name' %}
_INCLUDE_RE = re.compile(r"{%\s*include\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)
_SECTION_RE = re.compile(r"{%\s*section\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)
_RENDER_RE = re.compile(r"{%\s*render\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)

# {% schema %} ... {% endschema %}
_SCHEMA_RE = re.compile(
    r"{%\s*schema\s*%}(.*?){%\s*endschema\s*%}",
    re.IGNORECASE | re.DOTALL,
)

# Liquid tag regex → ImpExp kind triples (include/section/render all share the same structure)
_LIQUID_TAG_IMPORTS: list[tuple[re.Pattern[str], str]] = [
    (_INCLUDE_RE, "liquid_include"),
    (_SECTION_RE, "liquid_section"),
    (_RENDER_RE, "liquid_render"),
]


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, imports, and sections from a Shopify Liquid template.

    Symbols:
      - ``liquid_schema``        — the ``name`` field from a ``{% schema %}`` JSON block,
        recorded as a single symbol spanning the entire schema tag.
      - ``liquid_section_file``  — the stem of the filename when the file lives under
        ``sections/`` (e.g. ``sections/header.liquid`` → symbol name ``header``).
        This lets ``token-goat symbol header`` resolve the file without knowing the path.

    Imports:
      - ``liquid_include`` — ``{% include 'snippet' %}`` tag targets
      - ``liquid_section`` — ``{% section 'name' %}`` tag targets
      - ``liquid_render``  — ``{% render 'snippet' %}`` tag targets

    Sections:
      - ``<h1>``–``<h4>`` HTML headings found inside the template become
        :class:`Section` entries (shared logic with ``html.py`` via
        ``common.extract_html_headings``).  ``end_line`` is computed by
        ``common._compute_section_end_lines``.

    Liquid tags are matched by regex, not by a Liquid parser, so ``{% raw %}``
    blocks or comment-escaped tags may produce false positives.  Refs are always
    empty (Liquid variables have no callable call-sites that map meaningfully to
    cross-file symbols).
    """
    try:
        text = source.decode("utf-8", errors="replace")
        symbols: list[Symbol] = []
        imports: list[ImpExp] = []
        sections: list[Section] = []

        lines = text.split("\n")

        # Build a line-start offset index once; all match-position → line-number
        # conversions below use O(log n) binary search rather than O(n) slice-and-count.
        line_index = _build_line_index(text)

        # --- Extract includes/sections/renders ---
        for pattern, kind in _LIQUID_TAG_IMPORTS:
            for match in pattern.finditer(text):
                target = match.group(1)
                line = _offset_to_line(line_index, match.start())
                imports.append(ImpExp(kind=kind, target=target, line=line))

        # --- Extract schema block ---
        for match in _SCHEMA_RE.finditer(text):
            schema_content = match.group(1).strip()
            try:
                schema_json = json.loads(schema_content)
                if isinstance(schema_json, dict) and "name" in schema_json:
                    name = str(schema_json["name"])
                    line = _offset_to_line(line_index, match.start())
                    end_line = _offset_to_line(line_index, match.end())
                    symbols.append(
                        Symbol(name=name, kind="liquid_schema", line=line, end_line=end_line)
                    )
            except json.JSONDecodeError as exc:
                _LOG.debug("invalid JSON in {% schema %} block in %s: %s", rel_path, exc)

        # --- Section-file symbol (if file is in sections/ directory) ---
        rel_posix = rel_path.replace("\\", "/")
        if rel_posix.startswith("sections/"):
            section_name = Path(rel_path).stem
            symbols.append(Symbol(name=section_name, kind="liquid_section_file", line=1))

        # --- Extract HTML headings within Liquid ---
        common.extract_html_headings(text, sections)

        # Compute end_line for sections
        common._compute_section_end_lines(sections, lines)

        return symbols, [], imports, sections
    except Exception:  # noqa: BLE001
        _LOG.debug("parse failed for liquid source: %s", rel_path, exc_info=True)
        return [], [], [], []
