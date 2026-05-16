"""JSON extractor — top-level keys for objects, array-of-N for arrays."""
from __future__ import annotations

import json
import re

from ..parser import ImpExp, Ref, Section, Symbol

# Minimum file size to index JSON (50 KB)
_MIN_JSON_SIZE = 50_000

# Maximum symbols per JSON file
_MAX_SYMBOLS = 200

# Regex for extracting top-level keys without full JSON parse (for large/malformed files)
_TOP_LEVEL_KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:', re.MULTILINE)


def extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract JSON top-level keys as symbols."""
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
    except (json.JSONDecodeError, ValueError):
        pass

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
    except Exception:  # noqa: BLE001
        return str(type(obj).__name__)
