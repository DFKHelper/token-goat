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
from operator import attrgetter, itemgetter
from typing import TYPE_CHECKING, Final

from . import session as session_mod
from .hooks_common import sanitize_log_str
from .repomap import estimate_tokens

if TYPE_CHECKING:
    from .session import SessionCache

_LOG = logging.getLogger("token_goat.compact")

# Maximum files listed in the "files read" section of the manifest.  The compaction
# LLM needs the most-accessed files to know what context mattered, but listing every
# file read in a long session would blow the token budget.  10 covers the handful of
# core files a typical feature or bug-fix session touches.
_MAX_FILES_READ: Final[int] = 10
# Maximum files that show per-symbol detail in the manifest.  Fewer than _MAX_FILES_READ
# because symbol lists are verbose (one line each); limiting to 8 keeps the symbols
# section from dominating a 400-token budget and crowding out the edited-files section.
_MAX_SYMBOLS_FILES: Final[int] = 8
# Maximum line-ranges shown per file.  Ranges help the compaction LLM understand *which
# parts* of a file were read, but beyond 4 ranges the list becomes noise — if a file
# was read in 5+ disjoint slices the whole-file summary conveys more than a range list.
_MAX_RANGES_PER_FILE: Final[int] = 4
# Max symbols listed per file entry in the manifest (separate from _MAX_SYMBOLS_FILES,
# which caps the number of *files* that show any symbols at all).
_MAX_SYMBOLS_PER_FILE_ENTRY: Final[int] = 6

# Hard ceiling on the max_tokens parameter accepted by build_manifest.
# The config layer sets a sensible default (400) but build_manifest is also part of
# the public API.  Without a cap, a caller could pass an arbitrarily large value,
# causing the manifest construction pass to allocate and render all sections before
# the trim loop brings it back down — a pointless memory/CPU spike with no benefit.
_MAX_MANIFEST_TOKENS_CAP: Final[int] = 4_000

# Key for sorting edited_files dict items by edit count (the second element of each pair).
# Defined at module level so it is created once rather than re-created on every manifest build.
_BY_EDIT_COUNT = itemgetter(1)

# Attribute-based key for heapq.nlargest over FileEntry objects.
# attrgetter is faster than a lambda for attribute access: it avoids the
# CALL_FUNCTION bytecode overhead of a Python lambda on every comparison.
_BY_READ_COUNT = attrgetter("read_count")


def _count_suffix(n: int) -> str:
    """Return '  ×N' when *n* > 1, or '' when the count is unremarkable.

    Used in the manifest to annotate files edited or read multiple times without
    cluttering single-occurrence entries.
    """
    return f"  ×{n}" if n > 1 else ""


def _short_path(p: str, max_len: int = 70) -> str:
    """Return a compact display representation of a file path.

    Normalises backslashes to forward slashes, strips the leading
    absolute-path component up to a recognised project-layout directory
    (``/src/``, ``/tests/``, ``/docs/``) so the manifest stays readable on
    both Windows and POSIX without leaking the user's home directory prefix,
    and sanitizes embedded newlines/CRs to prevent log/manifest injection.
    Falls back to tail-truncation with an ellipsis if the path is still over
    *max_len* after stripping (e.g. deeply nested monorepo paths).
    """
    # Sanitize before any further processing: paths come from harness payloads
    # and session cache entries written by hooks, both of which accept arbitrary
    # attacker-controlled strings.  Embedded newlines would break the manifest
    # structure and could inject fake manifest sections into the LLM context.
    p = sanitize_log_str(p, max_len=max_len * 2)
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


def _load_session_cache(session_id: str, caller: str) -> SessionCache | None:
    """Validate *session_id* and load the session cache, returning ``None`` on any failure.

    Both :func:`event_count` and :func:`build_manifest` need the same
    validate → load → except sequence.  Extracting it here avoids duplicating
    the exception-handling logic and the truncated-ID formatting in log messages.

    *caller* is a short label (e.g. ``"event_count"``) used in the log message
    so callers remain distinguishable in the log output without duplicating
    the full message string.
    """
    try:
        session_mod.validate_session_id(session_id)
        cache = session_mod.load(session_id)
        _LOG.debug(
            "%s: session=%s loaded (files=%d greps=%d edited=%d)",
            caller,
            session_id[:8],
            len(cache.files),
            len(cache.greps),
            len(cache.edited_files),
        )
        return cache
    except ValueError as exc:
        _LOG.warning("%s: invalid session_id: %s", caller, exc)
        return None
    except Exception as e:  # noqa: BLE001 — session load can fail for many reasons (missing file, corrupt JSON, etc.)
        sid_short = session_id[:8] if session_id else "<empty>"
        _LOG.debug("%s(%s) failed: %s", caller, sid_short, e, exc_info=True)
        return None


def event_count(session_id: str) -> int:
    """Count tracked events (reads + greps + edits) for a session."""
    cache = _load_session_cache(session_id, "event_count")
    if cache is None:
        return 0
    return len(cache.files) + len(cache.greps) + len(cache.edited_files)


def build_manifest(session_id: str, *, max_tokens: int = 400) -> str:
    """Build a compact session manifest from the session cache.

    Returns structured text under *max_tokens* tokens that summarises:
    - Files edited this session (most important: must survive compaction)
    - Symbols accessed via token-goat read/symbol commands
    - Key files read, deduped and sorted by access frequency

    *max_tokens* is clamped to [1, _MAX_MANIFEST_TOKENS_CAP] to prevent a caller
    from triggering unbounded manifest construction via an extreme value.

    Safe to call even when the session cache is empty or missing.
    """
    clamped = max(1, min(max_tokens, _MAX_MANIFEST_TOKENS_CAP))
    if clamped != max_tokens:
        _LOG.warning(
            "build_manifest: max_tokens=%d out of range [1, %d], clamped to %d",
            max_tokens,
            _MAX_MANIFEST_TOKENS_CAP,
            clamped,
        )
    max_tokens = clamped
    t0 = time.monotonic()
    _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id[:8], max_tokens)
    cache = _load_session_cache(session_id, "build_manifest")
    if cache is None:
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
            "_render: manifest suppressed for session=%s "
            "(no file activity tracked: edited=0 files_read=0 greps=%d)",
            session_id[:8],
            len(cache.greps),
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
    total_files_read = len(cache.files)
    top_files = heapq.nlargest(_MAX_FILES_READ, cache.files.values(), key=_BY_READ_COUNT)
    _LOG.debug(
        "_render: selected top %d/%d files by read_count (cap=%d); "
        "files_with_symbols=%d edited=%d",
        len(top_files),
        total_files_read,
        _MAX_FILES_READ,
        files_with_symbols_count,
        len(cache.edited_files),
    )

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
            syms = [sanitize_log_str(s, max_len=80) for s in entry.symbols_read[:_MAX_SYMBOLS_PER_FILE_ENTRY]]
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
    # The -1 makes the comparison strictly-less-than rather than at-most, so a
    # manifest that lands exactly on the char boundary (total_chars == max_tokens * 3)
    # still triggers one trim pass rather than slipping through as "within budget".
    char_budget = max_tokens * 3 - 1
    # Total chars = sum of line lengths + (n-1) newline separators
    total_chars = sum(len(ln) for ln in lines) + len(lines) - 1
    lines_before = len(lines)
    while total_chars > char_budget and len(lines) > 3:
        removed = lines.pop()
        total_chars -= len(removed) + 1  # +1 accounts for the '\n' separator removed with the line
    trimmed_result = "\n".join(lines)
    _LOG.debug(
        "_render: trimmed %d line(s) for session=%s; final ~%d tokens",
        lines_before - len(lines),
        session_id[:8],
        estimate_tokens(trimmed_result),
    )
    return trimmed_result, files_with_symbols_count
