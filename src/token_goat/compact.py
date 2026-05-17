"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

__all__ = [
    "build_manifest",
    "event_count",
]

import heapq
import logging
import time
from datetime import UTC, datetime
from itertools import islice
from operator import itemgetter
from typing import TYPE_CHECKING

from . import session as session_mod
from .repomap import estimate_tokens

if TYPE_CHECKING:
    from .session import SessionCache

_LOG = logging.getLogger("token_goat.compact")

_MAX_FILES_READ = 10
_MAX_SYMBOLS_FILES = 8
_MAX_RANGES_PER_FILE = 4
# Max symbols listed per file entry in the manifest (separate from _MAX_SYMBOLS_FILES,
# which caps the number of *files* that show any symbols at all).
_MAX_SYMBOLS_PER_FILE_ENTRY = 6

# Key for sorting edited_files dict items by edit count (the second element of each pair).
# Defined at module level so it is created once rather than re-created on every manifest build.
_BY_EDIT_COUNT = itemgetter(1)


def _count_suffix(n: int) -> str:
    """Return '  ×N' when *n* > 1, or '' when the count is unremarkable.

    Used in the manifest to annotate files edited or read multiple times without
    cluttering single-occurrence entries.
    """
    return f"  ×{n}" if n > 1 else ""


def _short_path(p: str, max_len: int = 70) -> str:
    """Return a compact display representation of a file path.

    Normalises backslashes to forward slashes, then strips the leading
    absolute-path component up to a recognised project-layout directory
    (``/src/``, ``/tests/``, ``/docs/``) so the manifest stays readable on
    both Windows and POSIX without leaking the user's home directory prefix.
    Falls back to tail-truncation with an ellipsis if the path is still over
    *max_len* after stripping (e.g. deeply nested monorepo paths).
    """
    p = p.replace("\\", "/")
    # Strip common prefixes to keep paths short
    for prefix in ("/src/", "/tests/", "/docs/"):
        idx = p.find(prefix)
        if idx >= 0:
            return p[idx + 1:]
    if len(p) > max_len:
        return "…" + p[-(max_len - 1):]
    return p


def _format_ranges(ranges: list[tuple[int, int]]) -> str:
    """Render merged line ranges compactly for inclusion in the manifest.

    Examples::

        _format_ranges([(1, 50)])          # →  "  lines 1-50"
        _format_ranges([(1, 1)])           # →  "  lines 1"      (single line)
        _format_ranges([(1, 50), (100, 200), (300, 400), (500, 600), (700, 800)])
        # →  "  lines 1-50, 100-200, 300-400, 400-500 +1 more"

    Single-line ranges (start == end) are formatted without a dash to keep the
    output readable.  Ranges beyond _MAX_RANGES_PER_FILE are summarised as
    "+N more" so the manifest line stays short enough to fit within the token
    budget even for files read in many separate slices.

    Silently skips any malformed entries (non-sequence or wrong length) that
    could arise from a corrupt or downgrade-migrated session JSON file.
    """
    if not ranges:
        return ""
    valid: list[tuple[int, int]] = []
    for entry in ranges:
        try:
            start, end = entry
            valid.append((int(start), int(end)))
        except (TypeError, ValueError):
            _LOG.debug("_format_ranges: skipping malformed range entry: %r", entry)
    if not valid:
        return ""
    total_ranges = len(valid)
    shown = valid[:_MAX_RANGES_PER_FILE]
    # Generator expression avoids building an intermediate list just to join.
    parts = ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in shown)
    hidden_count = total_ranges - _MAX_RANGES_PER_FILE
    overflow_suffix = f" +{hidden_count} more" if hidden_count > 0 else ""
    return f"  lines {parts}{overflow_suffix}"


def event_count(session_id: str) -> int:
    """Count tracked events (reads + greps + edits) for a session."""
    try:
        session_mod.validate_session_id(session_id)
        cache = session_mod.load(session_id)
        return len(cache.files) + len(cache.greps) + len(cache.edited_files)
    except Exception as e:  # noqa: BLE001 — session load can fail for many reasons (missing file, corrupt JSON, etc.)
        _LOG.debug("event_count(%s) failed: %s", session_id[:8] if session_id else "<empty>", e, exc_info=True)
        return 0


def build_manifest(session_id: str, *, max_tokens: int = 400) -> str:
    """Build a compact session manifest from the session cache.

    Returns structured text under *max_tokens* tokens that summarises:
    - Files edited this session (most important: must survive compaction)
    - Symbols accessed via token-goat read/symbol commands
    - Key files read, deduped and sorted by access frequency

    Safe to call even when the session cache is empty or missing.
    """
    t0 = time.monotonic()
    try:
        session_mod.validate_session_id(session_id)
    except ValueError as exc:
        _LOG.warning("build_manifest: invalid session_id: %s", exc)
        return ""
    _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id[:8], max_tokens)
    try:
        cache = session_mod.load(session_id)
    except Exception as e:  # noqa: BLE001 — session load can fail for many reasons (missing file, corrupt JSON, etc.)
        _LOG.warning("compact: could not load session %s: %s", session_id[:8], e, exc_info=True)
        return ""

    result, files_with_symbols_count = _render(cache, session_id, max_tokens)
    elapsed = time.monotonic() - t0
    token_estimate = estimate_tokens(result)
    _LOG.info(
        "build_manifest: session=%s edited_files=%d files_read=%d symbols_files=%d "
        "manifest_tokens=%d elapsed=%.3fs",
        session_id[:8],
        len(cache.edited_files),
        len(cache.files),
        files_with_symbols_count,
        token_estimate,
        elapsed,
    )
    return result


def _render(cache: SessionCache, session_id: str, max_tokens: int) -> tuple[str, int]:
    """Build the Markdown session manifest string from *cache* for the PreCompact hook.

    Priority order:
    1. **Edited files** — always listed first; the compaction LLM must preserve these.
    2. **Symbols accessed** — files where specific symbols were read via ``token-goat read``.
    3. **Key files read** — top files by ``read_count`` (most re-read first).

    If the rendered manifest exceeds *max_tokens*, lines are trimmed from the
    bottom until the budget is met, preserving the highest-priority sections.
    Returns a (manifest_string, symbols_files_count) tuple.  The string is empty
    when the cache has no meaningful data (nothing edited, no symbols accessed,
    no files read).
    """
    # Nothing to report when the session has no file activity at all.
    # edited_files covers writes; files covers reads/greps — both empty means
    # the manifest would be just the header, which isn't worth injecting.
    if not cache.edited_files and not cache.files:
        _LOG.info(
            "_render: manifest suppressed for session=%s (no file activity tracked)",
            session_id[:8],
        )
        return "", 0

    # Use a generator so we only materialise up to _MAX_SYMBOLS_FILES entries
    # instead of scanning every file entry when only the first few are needed.
    files_with_symbols = list(
        islice((e for e in cache.files.values() if e.symbols_read), _MAX_SYMBOLS_FILES)
    )
    files_with_symbols_count = len(files_with_symbols)
    # Most-frequently-read files, capped at _MAX_FILES_READ, for the "Key Files Read" section.
    # heapq.nlargest is O(n log k) instead of O(n log n) full sort — material when a
    # long session has hundreds of file entries but we only need the top 10.
    # The heap keeps only k items in memory, so this is also more memory-efficient
    # than sorting the full list when sessions accumulate many hundreds of file reads.
    top_files = heapq.nlargest(_MAX_FILES_READ, cache.files.values(), key=lambda e: e.read_count)

    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    sid = session_id[:8]
    sections: list[str] = [
        "## Token-Goat Session Manifest",
        f"Session: {sid}  |  {now}",
        "",
    ]

    # ── 1. Edited files — highest priority ────────────────────────────────────
    if cache.edited_files:
        sections.append("### Files Edited (preserve in summary)")
        # Sort by edit count descending so the most-touched files appear first.
        for path, count in sorted(cache.edited_files.items(), key=_BY_EDIT_COUNT, reverse=True):
            sections.append(f"- {_short_path(path)}{_count_suffix(count)}")
        sections.append("")

    # ── 2. Symbols accessed via token-goat read / symbol ────────────────────────
    if files_with_symbols:
        sections.append("### Symbols Accessed")
        for entry in files_with_symbols:
            syms = entry.symbols_read[:_MAX_SYMBOLS_PER_FILE_ENTRY]
            overflow = len(entry.symbols_read) - _MAX_SYMBOLS_PER_FILE_ENTRY
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "")
            sections.append(f"- {_short_path(entry.rel_or_abs)} → {sym_str}")
        sections.append("")

    # ── 3. Key files read (top N by read_count) ───────────────────────────────
    if top_files:
        sections.append("### Key Files Read")
        for entry in top_files:
            ranges_str = _format_ranges(entry.line_ranges)
            sections.append(f"- {_short_path(entry.rel_or_abs)}{_count_suffix(entry.read_count)}{ranges_str}")
        sections.append("")

    result = "\n".join(sections).rstrip()
    token_count = estimate_tokens(result)
    if token_count <= max_tokens:
        return result, files_with_symbols_count

    _LOG.info(
        "_render: manifest over budget (%d tokens > %d limit) for session=%s — trimming",
        token_count,
        max_tokens,
        session_id[:8],
    )

    # Trim: drop lines from the bottom until within budget, preserving the header.
    # Strategy: work in character space (1 token ≈ 3 chars per estimate_tokens),
    # tracking running length incrementally to avoid the O(n²) cost of re-joining
    # the full string on every iteration of the trim loop.  We keep at least 3
    # lines (the "## Token-Goat Session Manifest", session line, and blank), so
    # the output is always a valid Markdown fragment even when heavily truncated.
    #
    # Priority is preserved by construction: edited files appear first (top of the
    # string), so trimming from the bottom sheds Key Files Read before Symbols
    # Accessed before Edited Files — exactly the priority order we want.
    lines = result.splitlines()
    # Budget in chars: max_tokens * 3 chars/token (conservative, matches estimate_tokens logic).
    char_budget = max_tokens * 3 - 1
    # Total chars = sum of line lengths + (n-1) newline separators
    total_chars = sum(len(ln) for ln in lines) + len(lines) - 1
    while total_chars > char_budget and len(lines) > 3:
        removed = lines.pop()
        total_chars -= len(removed) + 1  # +1 accounts for the '\n' separator removed with the line
    return "\n".join(lines), files_with_symbols_count
