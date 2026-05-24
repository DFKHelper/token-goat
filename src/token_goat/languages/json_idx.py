"""JSON extractor — top-level keys for objects, array-of-N for arrays."""
from __future__ import annotations

__all__ = ["extract"]

import json
import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger

_LOG = get_logger("languages.json_idx")

# Minimum file size to index JSON (50 KB)
_MIN_JSON_SIZE = 50_000

# Maximum symbols per JSON file
_MAX_SYMBOLS = 200

# Regex for extracting top-level keys without full JSON parse (for large/malformed files).
# Anchored at column 0 with MULTILINE so it reliably hits only top-level keys in
# pretty-printed JSON (nested keys are indented, so they don't match).
_TOP_LEVEL_KEY_RE = re.compile(r'^\s*"([^"]+)"\s*:', re.MULTILINE)

# Section-emission pattern: a pretty-printed JSON top-level key.  Anchored
# with MULTILINE so we can compute line numbers via positional offsets.
# Captures the column-2 indented form too — common for two-space pretty
# printers — by tolerating any leading whitespace that does not include a
# newline.  Section line tracking uses the regex's start offset rather than
# the captured group to keep newline arithmetic accurate.
_SECTION_KEY_RE = re.compile(r'^[ \t]*"([^"]+)"\s*:', re.MULTILINE)
# Maximum number of top-level keys promoted to Section entries per file.
# Mirrors the symbol cap so a giant config file does not flood the section
# table.  100 covers any realistic config (typical .json config files have
# <30 top-level keys).
_MAX_SECTIONS_PER_FILE: int = 100

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
    """Extract top-level keys from a JSON file as indexed symbols and Sections.

    Only files at or above ``_MIN_JSON_SIZE`` (50 KB) are indexed for symbols.
    Small JSON files — package.json, tsconfig.json, simple config blobs — are
    intentionally skipped because their keys are already known from the filename
    and indexing them would inflate the symbol table with dozens of near-identical
    entries across every project (``"name"``, ``"version"``, ``"scripts"`` …).

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

    Sections (NEW): pretty-printed JSON files additionally get one
    :class:`Section` per top-level key, with ``line`` and ``end_line`` covering
    the key's value span.  This lets ``token-goat section foo.json::scripts``
    pull just that block without touching the whole file.  Minified JSON
    (all on one line) yields no Sections — there is nothing to slice.
    """
    if len(source) < _MIN_JSON_SIZE:
        # File too small for symbol indexing; we still extract Sections for
        # pretty-printed files so ``token-goat section`` works on configs like
        # ``package.json``.  This is the most-requested use case for the
        # JSON section path: navigate to one well-known key without a full read.
        try:
            text_for_sections = source.decode("utf-8", errors="replace")
            sections = _extract_sections(text_for_sections)
        except (UnicodeDecodeError, AttributeError) as exc:
            _LOG.debug("json_idx: section decode failed for %s: %s", rel_path, exc)
            sections = []
        return [], [], [], sections

    text = source.decode("utf-8", errors="replace")
    symbols: list[Symbol] = []

    # Try full JSON parse first
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            _emit_dict_symbols(symbols, data)
        elif isinstance(data, list):
            _emit_array_symbols(symbols, data)
        sections = _extract_sections(text)
        return symbols, [], [], sections
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

    sections = _extract_sections(text)
    return symbols, [], [], sections


def _extract_sections(text: str) -> list[Section]:
    """Return one :class:`Section` per top-level key in pretty-printed JSON.

    Uses a column-anchored regex to find candidate keys at the file's
    outermost indent.  We then validate each match is *actually* at depth 1
    (immediately inside the root object) by counting opening/closing braces
    and brackets in the preceding text — this rejects keys at depth ≥ 2 that
    happen to share the file's two-space indent style (rare but possible in
    densely nested configs).

    Each Section's ``end_line`` is the line immediately before the next
    top-level Section, or the file's last line for the trailing entry.
    A minified file (one long line) yields no Sections because no key
    matches the column-anchored pattern.
    """
    if not text:
        return []

    matches: list[tuple[int, str]] = []
    seen_at_line: set[int] = set()
    for m in _SECTION_KEY_RE.finditer(text):
        key = m.group(1)
        if not key:
            continue
        depth = _depth_before(text, m.start())
        # depth==1 means we are directly inside the root ``{`` — the only
        # depth at which we want to emit a Section.  Reject deeper matches.
        if depth != 1:
            continue
        # Line is computed from byte offset to avoid surprises with mixed
        # line-endings; ``count("\n")`` works because the regex captures
        # column-0 matches in the normalized form.
        line = text[: m.start()].count("\n") + 1
        if line in seen_at_line:
            # Duplicate at same line — keep only the first match for stable output.
            continue
        seen_at_line.add(line)
        matches.append((line, key))
        if len(matches) >= _MAX_SECTIONS_PER_FILE:
            break

    if not matches:
        return []

    total_lines = text.count("\n") + 1
    sections: list[Section] = []
    for i, (line, key) in enumerate(matches):
        end_line = matches[i + 1][0] - 1 if i + 1 < len(matches) else total_lines
        end_line = max(line, end_line)
        sections.append(Section(heading=key, level=1, line=line, end_line=end_line))
    return sections


def _depth_before(text: str, offset: int) -> int:
    """Compute the brace/bracket depth at *offset* into *text*.

    Walks the text up to ``offset`` and tracks ``{``/``}`` and ``[``/``]``
    nesting while skipping over string literals (so a ``{`` inside a JSON
    string value does not falsely increment the depth).  Returns the
    integer depth — 0 outside the root, 1 inside the root object/array,
    2 inside a one-level-nested object, and so on.

    This is intentionally a manual scanner rather than ``json.loads``
    because the latter would require parsing the full file just to learn
    the depth at one offset.  The scanner is O(offset); for our use case
    (one pass over the file, computing depth at every regex hit) the total
    work amortises to O(N).
    """
    depth = 0
    in_string = False
    escape = False
    for i in range(offset):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{" or ch == "[":
            depth += 1
        elif ch == "}" or ch == "]":
            depth -= 1
    return depth


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
