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

# Regex for extracting top-level keys without full JSON parse (for large/malformed files).
# Anchored at column 0 with MULTILINE so it reliably hits only top-level keys in
# pretty-printed JSON (nested keys are indented, so they don't match).
_TOP_LEVEL_KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:', re.MULTILINE)

# Fallback regex for *minified* JSON, where everything is on a single line so the
# MULTILINE anchor in ``_TOP_LEVEL_KEY_RE`` never fires.  This pattern is more
# permissive and will match nested keys as well, so it's only used when the
# stricter pattern returns zero hits AND the full parse already failed.
_ANY_KEY_RE = re.compile(r'"([^"\\]{1,200})"\s*:')

# When indexing top-level objects whose value is *also* an object, emit one level
# of nested keys as ``parent.child`` symbols up to this many total entries.  Keeps
# the symbol table useful for deeply structured config blobs without exploding
# beyond the ``_MAX_SYMBOLS`` budget.
_MAX_NESTED_SYMBOLS = 50

# For top-level arrays of objects, peek at element[0] and emit its keys as
# ``[].key`` symbols, capped to keep the budget healthy.
_MAX_ARRAY_ELEMENT_KEYS = 20


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract top-level keys from a JSON file as indexed symbols.

    Only files at or above ``_MIN_JSON_SIZE`` (50 KB) are indexed.  Small JSON
    files — package.json, tsconfig.json, simple config blobs — are intentionally
    skipped because their keys are already known from the filename and indexing
    them would inflate the symbol table with dozens of near-identical entries
    across every project (``"name"``, ``"version"``, ``"scripts"`` …).

    For files that meet the size threshold, extraction proceeds in two passes:

    1. **Full JSON parse** — if ``json.loads`` succeeds, keys are taken directly
       from the parsed dict in insertion order.  Top-level dict values that are
       themselves dicts contribute one nested layer of ``parent.child`` symbols
       (up to ``_MAX_NESTED_SYMBOLS``).  Array files get a ``json_array`` summary
       symbol plus, when element[0] is a dict, up to ``_MAX_ARRAY_ELEMENT_KEYS``
       ``[].key`` symbols capturing the inferred element schema.
    2. **Regex fallback** — if the file is malformed (or too large for the JSON
       parser), ``_TOP_LEVEL_KEY_RE`` extracts quoted keys at column 0.  When
       that pattern returns no matches (the typical case for *minified* JSON,
       which has no newlines), the permissive ``_ANY_KEY_RE`` is used as a
       last-resort fallback with key de-duplication.

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
            _emit_dict_symbols(symbols, data)
        elif isinstance(data, list):
            _emit_array_symbols(symbols, data)
        return symbols, [], [], []
    except (json.JSONDecodeError, ValueError) as exc:
        _LOG.debug("json_idx: full parse failed for %s, falling back to regex: %s", rel_path, exc)

    # Fallback: regex extraction of top-level keys (for large/malformed JSON).
    # First try the strict anchored pattern; it works for pretty-printed JSON.
    for match in _TOP_LEVEL_KEY_RE.finditer(text):
        if len(symbols) >= _MAX_SYMBOLS:
            break
        key = match.group(1)
        symbols.append(Symbol(name=key, kind="json_key", line=1))

    # If the anchored pattern found nothing, the file is likely minified (all on
    # one line, no leading whitespace).  Fall through to the permissive pattern,
    # which captures keys anywhere in the text.  This is only safe as a *last*
    # resort because it also matches nested keys; the strict pattern is
    # preferred so we don't pollute the symbol table when JSON is well-formatted.
    if not symbols:
        seen: set[str] = set()
        for match in _ANY_KEY_RE.finditer(text):
            if len(symbols) >= _MAX_SYMBOLS:
                break
            key = match.group(1)
            # De-duplicate aggressively — minified JSON often repeats keys across
            # array elements and we don't want 1000 copies of "id".
            if key in seen:
                continue
            seen.add(key)
            symbols.append(Symbol(name=key, kind="json_key", line=1))

    return symbols, [], [], []


def _emit_dict_symbols(symbols: list[Symbol], data: dict) -> None:
    """Emit top-level keys plus a capped layer of nested object keys.

    For each top-level key whose value is itself a dict, emit up to a shared
    budget of ``parent.child`` entries.  This makes settings/config blobs with
    sections like ``{"database": {"host": ..., "port": ...}}`` queryable as
    ``database.host`` instead of forcing the agent to re-read the file to
    discover the nested shape.
    """
    nested_budget = _MAX_NESTED_SYMBOLS
    for i, key in enumerate(data.keys()):
        if len(symbols) >= _MAX_SYMBOLS:
            break
        value = data[key]
        symbols.append(
            Symbol(
                name=key,
                kind="json_key",
                line=1,
                signature=_safe_repr(value),
            )
        )
        # Only descend one level, and only for dict values; arrays of objects
        # are summarized separately at top level (see _emit_array_symbols).
        if nested_budget > 0 and isinstance(value, dict):
            for child_key in value:
                if nested_budget <= 0 or len(symbols) >= _MAX_SYMBOLS:
                    break
                symbols.append(
                    Symbol(
                        name=f"{key}.{child_key}",
                        kind="json_nested_key",
                        line=1,
                        signature=_safe_repr(value[child_key]),
                    )
                )
                nested_budget -= 1
        # Avoid scanning everything after the budget is exhausted at the
        # top level — i is the natural cap.
        if i >= _MAX_SYMBOLS:
            break


def _emit_array_symbols(symbols: list[Symbol], data: list) -> None:
    """Emit the array summary and, when the first element is a dict, its keys.

    API log dumps and record-style payloads are usually homogeneous: every
    element shares a schema.  Indexing ``[].id``, ``[].timestamp``, etc. lets
    the agent reason about the array's shape without parsing the whole file.
    """
    symbols.append(
        Symbol(
            name=f"[{len(data)}]",
            kind="json_array",
            line=1,
            signature=f"array of {len(data)} items",
        )
    )
    if not data:
        return
    first = data[0]
    if not isinstance(first, dict):
        return
    for i, child_key in enumerate(first.keys()):
        if i >= _MAX_ARRAY_ELEMENT_KEYS or len(symbols) >= _MAX_SYMBOLS:
            break
        symbols.append(
            Symbol(
                name=f"[].{child_key}",
                kind="json_array_element_key",
                line=1,
                signature=_safe_repr(first[child_key]),
            )
        )


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
