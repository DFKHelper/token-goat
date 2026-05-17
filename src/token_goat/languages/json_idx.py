"""JSON extractor — top-level keys for objects, array-of-N for arrays."""
from __future__ import annotations

__all__ = ["extract"]

import json
import logging
import re

from ..parser import ImpExp, Ref, Section, Symbol

_LOG = logging.getLogger("token_goat.languages.json_idx")

# Minimum file size to index JSON (50 KB)
_MIN_JSON_SIZE = 50_000

# Maximum symbols per JSON file
_MAX_SYMBOLS = 200

# Regex for extracting top-level keys without full JSON parse (for large/malformed files)
_TOP_LEVEL_KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:', re.MULTILINE)


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract top-level keys from a JSON file as indexed symbols.

    Only files at or above ``_MIN_JSON_SIZE`` (50 KB) are indexed.  Small JSON
    files — package.json, tsconfig.json, simple config blobs — are intentionally
    skipped because their keys are already known from the filename and indexing
    them would inflate the symbol table with dozens of near-identical entries
    across every project (``"name"``, ``"version"``, ``"scripts"`` …).

    For files that meet the size threshold, extraction proceeds in two passes:

    1. **Full JSON parse** — if ``json.loads`` succeeds, keys are taken directly
       from the parsed dict in insertion order.  Array files get a single
       ``json_array`` symbol recording the element count.
    2. **Regex fallback** — if the file is malformed or too large for the JSON
       parser, ``_TOP_LEVEL_KEY_RE`` extracts quoted keys at column 0, which
       reliably hits only top-level keys in most real-world JSON.

    Symbols are capped at ``_MAX_SYMBOLS`` (200) per file.  Refs, imports, and
    sections are always empty for JSON files.
    """
    if len(source) < _MIN_JSON_SIZE:
        # File too small; skip indexing
        return [], [], [], []

    text = source.decode("utf-8", errors="replace")
    symbols: list[Symbol] = []

    # Try full JSON parse first
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            for i, key in enumerate(data.keys()):
                if i >= _MAX_SYMBOLS:
                    break
                symbols.append(
                    Symbol(
                        name=key,
                        kind="json_key",
                        line=1,
                        signature=_safe_repr(data[key]),
                    )
                )
        elif isinstance(data, list):
            symbols.append(
                Symbol(
                    name=f"[{len(data)}]",
                    kind="json_array",
                    line=1,
                    signature=f"array of {len(data)} items",
                )
            )
        return symbols, [], [], []
    except (json.JSONDecodeError, ValueError) as exc:
        _LOG.debug("json_idx: full parse failed for %s, falling back to regex: %s", rel_path, exc)

    # Fallback: regex extraction of top-level keys (for large/malformed JSON)
    for match in _TOP_LEVEL_KEY_RE.finditer(text):
        if len(symbols) >= _MAX_SYMBOLS:
            break
        key = match.group(1)
        symbols.append(Symbol(name=key, kind="json_key", line=1))

    return symbols, [], [], []


def _safe_repr(obj: object, max_len: int = 100) -> str:
    """Return a safe string representation of a JSON value."""
    try:
        s = json.dumps(obj, default=str)
        if len(s) > max_len:
            s = s[:max_len] + "..."
        return s
    except (TypeError, ValueError, OverflowError) as exc:
        _LOG.debug("_safe_repr: json.dumps failed for %s: %s", type(obj).__name__, exc)
        return str(type(obj).__name__)
