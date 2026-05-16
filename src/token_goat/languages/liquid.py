"""Shopify Liquid template extractor — includes, sections, renders, schema, HTML headings."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

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

# HTML headings
_H_TAG_RE = re.compile(r"<h([1-4])[^>]*>([^<]*)</h\1>", re.IGNORECASE | re.DOTALL)


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract Liquid template symbols, imports, and sections."""
    try:
        text = source.decode("utf-8", errors="replace")
        symbols: list[Symbol] = []
        imports: list[ImpExp] = []
        sections: list[Section] = []

        lines = text.split("\n")

        # --- Extract includes/sections/renders ---
        for match in _INCLUDE_RE.finditer(text):
            target = match.group(1)
            line = text[:match.start()].count("\n") + 1
            imports.append(ImpExp(kind="liquid_include", target=target, line=line))

        for match in _SECTION_RE.finditer(text):
            target = match.group(1)
            line = text[:match.start()].count("\n") + 1
            imports.append(ImpExp(kind="liquid_section", target=target, line=line))

        for match in _RENDER_RE.finditer(text):
            target = match.group(1)
            line = text[:match.start()].count("\n") + 1
            imports.append(ImpExp(kind="liquid_render", target=target, line=line))

        # --- Extract schema block ---
        for match in _SCHEMA_RE.finditer(text):
            schema_content = match.group(1).strip()
            try:
                schema_json = json.loads(schema_content)
                if isinstance(schema_json, dict) and "name" in schema_json:
                    name = str(schema_json["name"])
                    line = text[:match.start()].count("\n") + 1
                    end_line = text[:match.end()].count("\n") + 1
                    symbols.append(
                        Symbol(name=name, kind="liquid_schema", line=line, end_line=end_line)
                    )
            except json.JSONDecodeError:
                pass

        # --- Section-file symbol (if file is in sections/ directory) ---
        rel_posix = rel_path.replace("\\", "/")
        if rel_posix.startswith("sections/"):
            section_name = Path(rel_path).stem
            symbols.append(Symbol(name=section_name, kind="liquid_section_file", line=1))

        # --- Extract HTML headings within Liquid ---
        for match in _H_TAG_RE.finditer(text):
            level = int(match.group(1))
            heading_text = match.group(2).strip()
            if heading_text:
                heading_text = heading_text[:100]
                line = text[:match.start()].count("\n") + 1
                sections.append(Section(heading=heading_text, level=level, line=line))

        # Compute end_line for sections
        common._compute_section_end_lines(sections, lines)

        return symbols, [], imports, sections
    except Exception:  # noqa: BLE001
        _LOG.debug("parse failed for liquid source: %s", rel_path, exc_info=True)
        return [], [], [], []
