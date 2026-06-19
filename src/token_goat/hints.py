"""Hint generator for PreToolUse (Read, Grep, Bash) interception.

The ``hints`` module is the main decision layer executed by the pre-tool
hooks (``hooks_read.py``).  For each incoming ``Read``/``Grep``/``Bash``
event it decides whether to emit a hint that redirects the agent away from
re-reading content it has already seen, and if so, what that hint should say.

Key public entry points:

- :func:`get_hint` — main entry point called by the pre-read hook; returns
  a hint string or ``None`` if no hint applies.
- :func:`get_grep_hint` — equivalent for Grep events; deduplicates repeated
  patterns.
- :func:`get_bash_read_hint` — for Bash commands that are equivalent to
  file reads (``cat``, ``head``, ``tail``, ``bat``, …).

Hint categories (in priority order):

1. **Diff-aware re-read** — file was edited this session: tell the agent what
   changed rather than returning the whole new content.
2. **Session dedup** — file was already read this session: remind the agent of
   what it learned and suggest ``token-goat read`` for any new symbol lookups.
3. **Structured file** — TOML / YAML / JSON / INI / Dockerfile: suggest
   ``token-goat section`` instead of a full re-read.
4. **Grep dedup** — same pattern was already searched: show the cached result
   count instead of re-running.

All hint functions are fail-soft: exceptions are caught and logged; ``None``
is returned so a broken hint layer never interrupts the agent's work.
"""
from __future__ import annotations

import contextlib
import difflib
import functools
import hashlib
import json
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final, TypedDict, TypeVar, cast

from . import config, db, session, snapshots
from .hooks_common import load_session_safe, sanitize_log_str, validate_cwd
from .project import find_project
from .util import get_logger

# Maximum entries in the recent_hints ring buffer stored per session.
_RECENT_HINTS_MAX: int = 3

__all__ = [
    "DIFF_HINT_MAX_BYTES",
    "HINT_MAX_PER_TOOL_CALL",
    "HINT_PRIORITY_CRITICAL",
    "HINT_PRIORITY_HIGH",
    "HINT_PRIORITY_LOW",
    "HINT_PRIORITY_MEDIUM",
    "_HINT_KIND_DEDUP",
    "_HINT_KIND_INDEX_ONLY",
    "_HINT_KIND_STRUCTURED",
    "_MAX_CACHED_RANGES_DISPLAY",
    "_PROXIMITY_SLOP_LINES",
    "HintItem",
    "ReadHint",
    "_emit_json_sidecar",
    "_hint_budget_check",
    "_json_sidecar_enabled",
    "_line_ranges_global_bounds",
    "_record_index_only_hint_emitted",
    "_record_structured_hint_emitted",
    "apply_hint_priority_limit",
    "build_bash_dedup_hint",
    "build_diff_hint",
    "build_glob_dedup_hint",
    "build_grep_dedup_hint",
    "build_high_frequency_hint",
    "build_index_only_file_hint",
    "build_pinned_hint",
    "build_read_hint",
    "build_structured_file_hint",
    "build_symbol_stale_hint",
    "build_test_file_hint",
    "build_unchanged_file_hint",
    "build_web_cache_hit_hint",
    "build_web_dedup_hint",
    "compute_stale_threshold",
    "dedup_hints",
    "maybe_grep_advisory",
]

# ---------------------------------------------------------------------------
# Hint priority ordering
# ---------------------------------------------------------------------------
# Priority levels assigned to each hint type. Lower number = higher priority.
# CRITICAL (1): edited-file hints — file was edited this session (stale content warning)
# HIGH (2):     diff hints — file changed since last read (diff available)
# MEDIUM (3):   re-read hints — file already read this session (dedup/overlap)
# LOW (4):      grep/bash/glob dedup hints — dedup for tool calls
HINT_PRIORITY_CRITICAL: Final[int] = 1
HINT_PRIORITY_HIGH: Final[int] = 2
HINT_PRIORITY_MEDIUM: Final[int] = 3
HINT_PRIORITY_LOW: Final[int] = 4

# Maximum number of hints emitted per tool call.  When more hints would fire
# than this cap, only the highest-priority ones are emitted and a footer
# "(+N more hints suppressed)" is appended so the agent is aware.
HINT_MAX_PER_TOOL_CALL: Final[int] = 3


class HintItem:
    """A hint with an attached priority level for ordering and filtering.

    ``hint_priority`` determines ordering when multiple hints apply to the same
    tool call: lower values are emitted first.  Use the ``HINT_PRIORITY_*``
    constants (1=CRITICAL .. 4=LOW) so ordering is deterministic and testable.

    ``text`` is the prose hint string injected into ``additionalContext``.
    """

    hint_priority: int
    text: str

    def __init__(self, text: str, hint_priority: int) -> None:
        self.text = text
        self.hint_priority = hint_priority

    def __repr__(self) -> str:
        return f"HintItem(priority={self.hint_priority}, text={self.text!r:.40})"


_SLIM_HINT_MAX_CHARS: int = 220

# Reusable token-goat read command templates to reduce f-string duplication.
_CMD_READ_SYMBOL: str = "Use `token-goat read \"{path}::symbol\"` for more."
_CMD_READ_SYM_SURGICAL: str = "Use `token-goat read \"{path}::sym\"` for surgical access."
_CMD_READ_FIRST_SYM_FAST: str = "Use `token-goat read \"{path}::{symbol}\"` (~85% faster)."


def slim_hint_text(text: str, tier: str) -> str:
    """Compress a hint to its first paragraph at hot/critical context pressure.

    At cool/warm pressure the full text is returned unchanged.  At hot/critical,
    only the first paragraph (up to the first blank line) is kept, then capped
    at _SLIM_HINT_MAX_CHARS characters with a trailing ellipsis when truncated.
    This keeps the actionable command visible while dropping explanatory detail
    that costs tokens but adds little when context is scarce.

    The char cap is skipped for single-line first paragraphs (no internal newline)
    because those are invariably the actionable command itself — truncating them
    mid-command would produce an unrunnable fragment.
    """
    if tier not in ("hot", "critical"):
        return text
    # Keep only the first paragraph.
    first_para = text.split("\n\n")[0].strip()
    if not first_para:
        return text  # empty paragraph — return original rather than empty string
    # Single-line first paragraphs are the command line itself; skip char cap.
    if "\n" not in first_para:
        return first_para
    if len(first_para) <= _SLIM_HINT_MAX_CHARS:
        return first_para
    return first_para[:_SLIM_HINT_MAX_CHARS].rstrip() + "…"


def apply_hint_priority_limit(
    hints: list[HintItem],
    max_hints: int = HINT_MAX_PER_TOOL_CALL,
    *,
    tier: str = "cool",
) -> list[str]:
    """Sort hints by priority and return at most *max_hints* hint texts.

    Hints are sorted ascending by ``hint_priority`` (lower = more important),
    then by insertion order within the same priority level (stable sort).
    When ``len(hints) > max_hints``, the lowest-priority excess hints are
    dropped and a ``(+N more hints suppressed)`` footer is appended to the
    last emitted hint's text so the agent is aware that suppression occurred.

    At hot/critical *tier*, each hint text is compressed to its first paragraph
    via :func:`slim_hint_text` to reduce token cost at high context pressure.

    Returns a list of hint text strings ready to be joined with ``"\\n\\n"``
    and injected as ``additionalContext``.

    Examples:
        >>> items = [
        ...     HintItem("diff hint", HINT_PRIORITY_HIGH),
        ...     HintItem("edited hint", HINT_PRIORITY_CRITICAL),
        ...     HintItem("dedup hint", HINT_PRIORITY_LOW),
        ...     HintItem("reread hint", HINT_PRIORITY_MEDIUM),
        ... ]
        >>> apply_hint_priority_limit(items, max_hints=3)
        ['edited hint', 'diff hint', 'reread hint\n(+1 more hints suppressed)']
    """
    if not hints:
        return []
    # Stable sort by priority (lower value = higher priority = emitted first).
    sorted_hints = sorted(hints, key=lambda h: h.hint_priority)
    if len(sorted_hints) <= max_hints:
        return [slim_hint_text(h.text, tier) for h in sorted_hints]
    # Cap at max_hints; append suppression footer to the last emitted hint.
    emitted = sorted_hints[:max_hints]
    suppressed_count = len(sorted_hints) - max_hints
    result = [slim_hint_text(h.text, tier) for h in emitted]
    result[-1] = f"{result[-1]}\n(+{suppressed_count} more hints suppressed)"
    return result


def dedup_hints(
    hint_items: list[HintItem],
    session_cache: session.SessionCache | None,
) -> list[HintItem]:
    """Compress duplicate hints by content hash; replace repeats with short stubs.

    For each HintItem, computes a stable content hash of the normalized hint text.
    If the same content hash was seen before in this session, replaces the full hint
    text with a short "Same as previously shown hint for <context>" stub instead of
    full suppression.  This reduces token overhead while keeping the agent aware of
    the duplication.

    Args:
        hint_items: List of HintItem objects to dedup.
        session_cache: SessionCache for content-hash tracking, or None to skip dedup.

    Returns:
        Modified list of HintItem objects with duplicate content compressed.
        If session_cache is None, returns hint_items unchanged.
    """
    if session_cache is None:
        return hint_items

    result: list[HintItem] = []
    for item in hint_items:
        # Normalize hint text: strip whitespace, convert to lowercase for comparison.
        normalized = item.text.strip().lower()
        # Compute content hash: first 8 hex chars of SHA256.
        content_hash = _sha256_hex(normalized, 8)
        # Compute summary once (used in both branches below): first 50 chars without newlines.
        summary = item.text.replace("\n", " ")[:50]

        # Check if this content has been seen before.
        prior_summary = session_cache.get_hint_content_summary(content_hash)
        if prior_summary is not None:
            # Duplicate content: replace with short stub.
            session_cache.record_hint_content_seen(content_hash, summary)
            stub_text = f"Same as previously shown hint for '{prior_summary}...'"
            result.append(HintItem(stub_text, item.hint_priority))
        else:
            # First occurrence: keep original, record for future dedup.
            session_cache.record_hint_content_seen(content_hash, summary)
            result.append(item)

    return result

# ---------------------------------------------------------------------------
# Terse-mode substitution table
# ---------------------------------------------------------------------------
# Applied at the end of every hint constructor via _apply_terse().  Each entry
# replaces a verbose phrase with a compact token-saving equivalent.  Order
# matters: longer/more-specific patterns must precede shorter ones that share
# a prefix (e.g. "exit=" before "exit" if both were present).
#
# Savings per hint: ~4-8 chars saved × ~20-50 hints/session ≈ 150-400 tokens.
_TERSE: dict[str, str] = {
    "cached": "⌘",
    "exit=": "x=",
    "ran ": "×",
    "use `offset=": "→offset=",
    " tokens).": " tok).",
    "to read selectively.": "selectively.",
    "to read without re-running.": "(no re-run).",
    "to read without re-fetching.": "(no re-fetch).",
}


def _apply_terse(text: str) -> str:
    """Apply all _TERSE substitutions to *text* and return the result."""
    for verbose, terse in _TERSE.items():
        text = text.replace(verbose, terse)
    return text


def _make_short_stub_hint(seen_count: int) -> ReadHint:
    """Return a short stub hint for when a fingerprint has been seen Nx already.

    Used when verbose_until_seen_count has been reached — replaces the full
    hint text with a terse stub. Carries 0 tokens_saved because suppressing the
    verbose text is the saving (no duplicate action needed from the agent).
    """
    return ReadHint(
        f"(↳ same hint seen {seen_count}×, see prior context)",
        0,
    )


# ---------------------------------------------------------------------------
# Structured-JSON sidecar (opt-in via [hints] json_sidecar = true)
# ---------------------------------------------------------------------------
# When enabled, every dedup / re-read / unchanged-file / structured-file hint
# is prefixed with a one-line JSON object encoding the same information in a
# machine-parseable shape:
#
#   {"hint":"already_read","file":"foo.py","ranges":[[1,40]],"wasted":~120}
#   <existing prose line stays verbatim below>
#
# Goals:
#   1. Agents that parse JSON get a deterministic schema and can act on it
#      programmatically (jump straight to a token-goat recall command).
#   2. Agents that don't parse JSON still see the prose line — backward
#      compatible.
#   3. The prose line is unchanged byte-for-byte, so all existing tests, all
#      content-hash dedup and curator/budget bookkeeping keep working.
#
# Sidecar generation happens AFTER content-hash dedup (which keys on the prose
# only) so two semantically identical hints still dedup correctly even when
# the JSON sidecar is enabled.

# Cap on the size of any single sidecar JSON line to bound worst-case overhead.
# A pathological file path or symbol list will be tail-truncated rather than
# bloating ``additionalContext`` past this threshold.
_JSON_SIDECAR_MAX_BYTES: Final[int] = 350

# Separator placed between the sidecar JSON line and the existing prose hint.
# Newline keeps each line independently greppable by downstream agents while
# also matching the multi-line shape of bash/git output that LLMs already parse.
_JSON_SIDECAR_SEP: Final[str] = "\n"


def _json_sidecar_enabled() -> bool:
    """Return True when [hints] json_sidecar is enabled in config or env.

    Imports ``config`` lazily so the hot pre-read path does not pay the import
    cost when the feature is off (the default).  Fails closed (returns False)
    if config loading raises for any reason — keeping the sidecar invisible is
    the safe default since the prose line is fully self-sufficient.
    """
    try:
        from . import config as _config

        return bool(_config.load().hints.json_sidecar)
    except Exception:
        return False


def _emit_json_sidecar(hint: ReadHint | None, kind: str, **fields: Any) -> ReadHint | None:
    """Return *hint* unchanged when the JSON sidecar is disabled, else prepend it.

    The sidecar carries ``{"hint": kind, ...fields}`` rendered as a single
    compact JSON line with no internal whitespace.  ``None`` fields are dropped
    so the JSON stays terse.  Hint metadata (``tokens_saved``) is preserved on
    the wrapped result so curator/stats accounting is unaffected.

    Fail-soft: any exception (JSON encoding failure on an exotic value, missing
    config module) returns the original prose hint unchanged so the agent's
    work is never interrupted.
    """
    if hint is None:
        return None
    if not _json_sidecar_enabled():
        return hint
    try:
        payload: dict[str, Any] = {"hint": kind}
        for k, v in fields.items():
            if v is None:
                continue
            payload[k] = v
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        if len(line.encode("utf-8")) > _JSON_SIDECAR_MAX_BYTES:
            # Pathological payload — drop the sidecar rather than bloat context.
            return hint
        combined = f"{line}{_JSON_SIDECAR_SEP}{hint}"
        return ReadHint(combined, hint.tokens_saved)
    except (TypeError, ValueError) as exc:
        _LOG.debug("_emit_json_sidecar: skipped (encoding error: %s)", exc)
        return hint


_LOG = get_logger("hints")

# Max length for a file path embedded in an LLM-context hint string.
# Paths longer than this are tail-truncated; embedded newlines/CRs are always
# stripped because they would split a single hint line into fake separate entries
# when the hint is injected as ``additionalContext`` in the PreToolUse response.
_MAX_HINT_PATH_LEN = 300

# Max display length for a grep pattern in dedup hints.  Long regex patterns
# (multi-line PCRE, complex alternations) can be 100+ chars; the display string
# is truncated here to keep hints compact.  Dedup logic still keys on the full
# pattern hash — only the rendered text is shortened.
_MAX_GREP_PATTERN_DISPLAY_LEN = 60


def _sha256_hex(text: str, length: int = 12) -> str:
    """Return the first *length* hex characters of the SHA-256 of *text*.

    Single low-level helper that removes the repeated inline pattern::

        hashlib.sha256(x.encode("utf-8")).hexdigest()[:N]

    used across multiple hint-related functions.  *length* defaults to 12
    (the width used by :func:`_hint_fingerprint`) but callers can pass 8 for
    the shorter content-dedup hashes used in hint-body and grep-result tracking.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:length]


def _hint_fingerprint(hint_text: str, path: str = "") -> str:
    """Return a stable SHA256 fingerprint (first 12 hex chars) of hint text + path.

    The fingerprint includes the file path so that two different files that
    produce identical hint text (e.g. a short "loop?" nudge) are not incorrectly
    treated as duplicates.  Passing ``path`` is optional for backwards compatibility
    with callers that have no file context, but all Read/Grep hook call sites
    should pass it.

    Used to suppress duplicate hints within the same session.  The 12-char
    prefix is a balance between collision risk (negligible at this length)
    and token overhead in session JSON (fingerprints stored in hints_seen set).
    """
    key = f"{path}|{hint_text}" if path else hint_text
    return _sha256_hex(key)


def _sanitize_hint_path(p: str) -> str:
    """Strip newlines/CRs and cap length for a path embedded in an LLM hint string.

    Hint strings are injected verbatim into ``additionalContext`` which the LLM
    sees as plain text.  An attacker-controlled path containing ``\\n`` or ``\\r``
    (written into the session JSON by a previous hook invocation) could split a
    single hint into what looks like multiple separate hint entries, injecting
    fake "Note:" lines into the model's context.  This helper neutralises that
    vector before any path reaches a hint f-string.
    """
    return sanitize_log_str(p, max_len=_MAX_HINT_PATH_LEN)


def _sanitize_hint_symbol(name: str) -> str:
    """Sanitise a symbol name for safe interpolation inside a double-quoted CLI hint.

    Builds on :func:`_sanitize_hint_path` (newline/CR strip + length cap) and
    additionally neutralises embedded ``"`` characters.  Symbol names can legally
    contain double quotes — a CSS attribute selector such as ``[type="submit"]``
    is the canonical example — which would otherwise break the surrounding
    ``token-goat read "<rel>::<symbol>"`` quoting and yield an un-runnable hint.
    Single quotes are safe inside a double-quoted CLI argument, so we substitute
    rather than backslash-escape (no shell-escaping ambiguity for the agent).
    """
    return _sanitize_hint_path(name).replace('"', "'")


# Process-local cache for pattern display strings.  Patterns recur within a
# session (e.g. exploratory grep loops, dedup hint re-emissions) and the
# sanitize→length-check→slice work is identical for every emit.  Keying on
# ``hash(pattern)`` keeps memory bounded (one int + ~80-char string per unique
# pattern) and avoids the SHA cost of a content-stable hash on the hot pre-tool
# hook path.  Soft-cap at :data:`_PATTERN_DISPLAY_CACHE_MAX` so a pathological
# session that hashes thousands of distinct patterns cannot grow the dict
# without bound — the cache is cleared (full reset) rather than LRU-evicted
# because dedup hint workloads concentrate on a small recurring pattern set.
_PATTERN_DISPLAY_CACHE: dict[int, str] = {}
_PATTERN_DISPLAY_CACHE_MAX: Final[int] = 256


def _truncate_pattern_display(pattern: str) -> str:
    """Return a display-safe version of a grep pattern for use in hint text.

    Sanitises newlines/CRs (injection defence via :func:`_sanitize_hint_path`),
    then truncates to :data:`_MAX_GREP_PATTERN_DISPLAY_LEN` characters so that
    long regex patterns (multi-line PCRE, complex alternations) do not bloat the
    hint.  Dedup keying always uses the full pattern hash — only the rendered
    text is shortened.

    Results are memoised in :data:`_PATTERN_DISPLAY_CACHE` keyed by
    ``hash(pattern)``: dedup hints for the same pattern reuse the display
    without re-sanitising on every emit.  Cache is cleared (full reset) when
    it exceeds :data:`_PATTERN_DISPLAY_CACHE_MAX` to bound memory.
    """
    key = hash(pattern)
    cached = _PATTERN_DISPLAY_CACHE.get(key)
    if cached is not None:
        return cached
    safe = _sanitize_hint_path(pattern)
    if len(safe) > _MAX_GREP_PATTERN_DISPLAY_LEN:
        display = safe[:_MAX_GREP_PATTERN_DISPLAY_LEN] + "…"
    else:
        display = safe
    if len(_PATTERN_DISPLAY_CACHE) >= _PATTERN_DISPLAY_CACHE_MAX:
        _PATTERN_DISPLAY_CACHE.clear()
    _PATTERN_DISPLAY_CACHE[key] = display
    return display


class _SymbolRow(TypedDict):
    """Shape of one row returned by the symbols SELECT in _get_indexed_symbols_and_line_count."""

    kind: str
    name: str
    line: int
    end_line: int

# Token estimator: ~3.5 chars/token, ~60 chars/line code → ~17 tokens/line average
CHARS_PER_TOKEN = 3.5
AVG_CHARS_PER_LINE = 60
TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN  # ≈17.1

# Thresholds
LARGE_FILE_LINE_THRESHOLD = 500
# Minimum overlap required before emitting a partial-overlap warning.
# Below ~50 lines the hint text itself (~25 tokens) costs almost as much as
# the saving it advertises, making the nudge net-negative.  50 lines ≈ 850
# tokens saved — comfortably above the ~25-token hint cost.
MIN_OVERLAP_TO_WARN = 50
# Claude Code's default lines-per-Read when the caller omits a limit.
# Used to compute the end of the requested range so overlap detection works
# even when the agent issues a bare Read without an explicit line count.
DEFAULT_READ_LIMIT = 2000

# How old a cached read may be before the dedup hint is suppressed.
# Rationale: in long conversations the model's actual context window evicts
# content well before the session JSON does.  Claiming "you already read X
# at turn 3" at turn 200 is a false positive — the lines have likely fallen
# out of context, so a re-read is legitimate.  30 minutes is conservative;
# many sessions run longer, but at the median this is well past the typical
# context-relevance window for any single file.
STALE_READ_AGE_SECONDS = 30 * 60

def compute_stale_threshold(session_age_secs: float) -> float:
    """Return an adaptive staleness threshold in seconds.

    In short sessions everything is likely still in context; in long
    sessions the context window scrolls faster so reads go stale sooner.
    Formula: clamp(session_age * 0.25, 900, STALE_READ_AGE_SECONDS)
    - Floor of 900s (15 min): always suppress reads older than 15 min
    - Ceiling of STALE_READ_AGE_SECONDS (30 min): never suppress reads
      newer than 30 min regardless of session age
    """
    return max(900.0, min(STALE_READ_AGE_SECONDS, session_age_secs * 0.25))


def _session_stale_threshold(cache: session.SessionCache | None, now: float) -> float:
    """Extract session age and compute stale threshold in one helper.

    This DRY helper eliminates the repeated pattern:
        _X_created_ts = getattr(cache, "created_ts", None)
        X_session_age = (now - _X_created_ts) if _X_created_ts is not None else STALE_READ_AGE_SECONDS
        X_stale_threshold = compute_stale_threshold(X_session_age)

    Args:
        cache: SessionCache object with optional created_ts attribute.
        now: Current time in seconds (e.g., time.time()).

    Returns:
        Stale threshold in seconds, computed adaptively from session age.
    """
    created_ts = getattr(cache, "created_ts", None)
    session_age = (now - created_ts) if created_ts is not None else STALE_READ_AGE_SECONDS
    return compute_stale_threshold(session_age)


# How many bytes to assume per line when estimating line count from file size.
# This is intentionally conservative (real code averages 30-50 bytes/line) so
# we slightly overestimate the line count rather than underestimate it.
_BYTES_PER_LINE_ESTIMATE = 75

# Maximum number of indexed symbols to fetch per file in one DB query.
# Enough to fill a useful hint; the full list is available via `token-goat symbol`.
_MAX_INDEXED_SYMBOLS_FETCHED = 50

# Maximum character budget for the "[symbols: ...]" suffix appended to cache hints.
# Keeps the suffix from inflating hints beyond their token ceiling.
_SYMBOLS_SUFFIX_MAX_CHARS = 50

# A file read this many times or more is a "working file" — the agent
# is clearly iterating on it. Stop emitting dedup nags that the agent
# is ignoring anyway.
_SUPPRESS_HINT_AT_READ_COUNT: Final[int] = 5

# Maximum number of cached ranges shown in the hint text.  When a file has
# been read in many non-overlapping slices the range list can grow long;
# listing all of them inflates the hint's own token cost.  Cap at 10 so
# the hint stays terse while still naming the most-recently-read areas.
# The 10 most-recently-accessed (highest-index) ranges are used, not the
# first 10 in insertion order, because recent context is more relevant to
# the agent's current task.
_MAX_CACHED_RANGES_DISPLAY: Final[int] = 10

# A request narrower than this (with an explicit limit set by the agent) is treated
# as "surgical intent" — the agent is already doing the right thing by reading a
# small slice, so the dedup nag is suppressed.  Two reasons:
#   1. The hint text itself costs ~50-80 tokens.  For a 50-line re-read
#      (~860 tokens saved at most) the advice barely breaks even, and the agent
#      may genuinely need those lines back in context.
#   2. The exact-match hint tells the agent to "use a different offset/limit",
#      which is misleading when the agent already provided a narrow explicit
#      offset/limit — it punishes the surgical behaviour we want to encourage.
# Bound is intentionally aligned with MIN_OVERLAP_TO_WARN so the "ignore tiny
# overlaps" and "ignore tiny exact-matches with explicit limit" thresholds
# move in lockstep if MIN_OVERLAP_TO_WARN is ever retuned.
_NARROW_EXPLICIT_READ_LINES = MIN_OVERLAP_TO_WARN

# Minimum line count for a file to warrant an "already read" hint.
# Tiny files (< 30 lines) are cheap to re-read; the hint itself (~25 tokens)
# costs almost as much as the saving it advertises, making the nudge net-negative.
# Skip hints entirely for small files with only a single prior read.
_MIN_LINES_FOR_HINT = 30


class ReadHint(str):
    """A pre-read hint string carrying the genuine token saving it represents.

    Subclasses ``str`` so every existing consumer (substring checks, JSON
    serialization as ``additionalContext``) keeps working unchanged, while
    ``tokens_saved`` rides along for honest stats accounting.

    ``tokens_saved`` is **0** for *suggestion* hints — "this file is large, you
    could use ``token-goat read``" — because firing the suggestion realizes no
    saving; if the agent acts on it, ``token-goat read`` records the real
    ``read_replacement`` stat itself. It is non-zero only for dedup hints that
    warn about re-reading content already in the session: a concrete, already-
    realized avoided cost.
    """

    tokens_saved: int

    def __new__(cls, text: str, tokens_saved: int = 0) -> ReadHint:
        """Construct a ReadHint string with an attached *tokens_saved* annotation.

        ``str.__new__`` requires the string value to be passed at construction
        time; ``tokens_saved`` is attached as a plain attribute afterwards.
        """
        obj = super().__new__(cls, text)
        obj.tokens_saved = tokens_saved
        return obj


# ---------------------------------------------------------------------------
# Shared fail-soft decorator for all hint builders
# ---------------------------------------------------------------------------
# Defined early in the module so every ``build_*_hint`` function below can
# decorate itself.  Catches any exception raised by the inner implementation
# and returns ``None`` so the calling hook stays fail-soft.

_F = TypeVar("_F", bound=Callable[..., "ReadHint | None"])


def _failsoft_hint(fn: _F) -> _F:
    """Decorator: catch any exception raised by a hint builder and return ``None``.

    Replaces the per-builder ``try: ... except Exception: _LOG.debug(...); return None``
    boilerplate that the eight public ``build_*_hint`` functions used to repeat.
    The wrapped callable's name is used in the warning message so log readers
    can correlate the failure to a specific hint builder.

    Session correlation: when the wrapped call passes ``session_id`` as a keyword
    argument it is included (truncated to 16 chars) in the log line — mirroring
    the behaviour the old per-function wrappers provided.
    """
    @functools.wraps(fn)
    def _wrapper(*args: object, **kwargs: object) -> ReadHint | None:
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            session_id = kwargs.get("session_id", "")
            session_id_str = str(session_id)[:16] if session_id else ""
            _LOG.warning(
                "%s: unexpected error (session=%s): %s",
                fn.__name__, session_id_str, exc, exc_info=True,
            )
            return None
    return cast("_F", _wrapper)


def _symbols_suffix(symbols_read: list[str], max_chars: int = _SYMBOLS_SUFFIX_MAX_CHARS) -> str:
    """Return a compact ' [symbols: a, b +N]' suffix, or '' if the list is empty.

    Lists the first three symbol names; shows '+N' when there are more.
    The whole suffix is capped at *max_chars* characters — if even the first
    symbol name makes the prefix exceed the cap, returns '' rather than
    truncating a name mid-way (an incomplete name is more confusing than silence).
    """
    if not symbols_read:
        return ""
    preview = symbols_read[:3]
    overflow = len(symbols_read) - len(preview)
    overflow_str = f" +{overflow}" if overflow > 0 else ""
    names_part = ", ".join(preview)
    suffix = f" [symbols: {names_part}{overflow_str}]"
    if len(suffix) > max_chars:
        return ""
    return suffix


def _est_tokens_from_lines(n_lines: int) -> int:
    """Rough token estimate from line count (integer, never < 1)."""
    return max(1, int(n_lines * TOKENS_PER_LINE))


def _est_tokens_from_chars(n_chars: int) -> int:
    """Rough token estimate from character count."""
    return max(1, int(n_chars / CHARS_PER_TOKEN))


def _line_count(path: Path) -> int | None:
    """Cheap newline count; returns None on any error."""
    try:
        if not path.is_file():
            return None
        with path.open("rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def _get_indexed_symbols_and_line_count(
    file_rel: str, project_hash: str
) -> tuple[list[_SymbolRow], int | None, bool]:
    """Return symbols AND actual or estimated line count in one query.

    Returns a third flag indicating whether the returned line count is exact
    (read from the ``line_count`` column) or estimated from file size.

    The two-step SELECT handles older DB schemas that pre-date the ``line_count``
    column: first try the full query; if ``line_count`` is missing, fall back to
    ``size``-only and mark the schema as lacking the column.
    """
    try:
        with db.open_project_readonly(project_hash) as conn:
            # Fetch file metadata and symbols in one round-trip.
            # db_has_line_count_column tracks whether the schema supports line_count.
            # open_project_readonly (not open_project) is used here because this function only runs SELECT queries, avoiding the sqlite-vec extension load, WAL-mode pragma, and schema DDL that open_project applies on every call (~10 ms per pre_read call).
            try:
                file_row = conn.execute(
                    "SELECT size, line_count FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                db_has_line_count_column = True
            except sqlite3.OperationalError as exc:
                if "line_count" not in str(exc).lower():
                    raise
                file_row = conn.execute(
                    "SELECT size FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                db_has_line_count_column = False

            sym_rows = conn.execute(
                f"""
                SELECT kind, name, line, end_line
                FROM symbols
                WHERE file_rel = ? AND name IS NOT NULL AND end_line IS NOT NULL
                ORDER BY line
                LIMIT {_MAX_INDEXED_SYMBOLS_FETCHED}
                """,
                (file_rel,),
            ).fetchall()

            # Resolve line count: prefer the stored exact value; fall back to a
            # size-based estimate when the column is absent or NULL.
            if file_row:
                if db_has_line_count_column and file_row["line_count"] is not None:
                    n_lines = int(file_row["line_count"])
                    line_count_is_exact = True
                else:
                    size = file_row["size"]
                    n_lines = max(1, size // _BYTES_PER_LINE_ESTIMATE)
                    line_count_is_exact = False
            else:
                n_lines = None
                line_count_is_exact = False

            sym_dicts: list[_SymbolRow] = [
                _SymbolRow(
                    kind=str(r["kind"]),
                    name=str(r["name"]),
                    line=int(r["line"]),
                    end_line=int(r["end_line"]),
                )
                for r in sym_rows
            ]
            return sym_dicts, n_lines, line_count_is_exact
    except (db.DBError, sqlite3.Error, OSError) as exc:
        _LOG.debug("failed to load indexed symbols for %s: %s", file_rel, exc)
        return [], None, False


def build_read_hint(
    *,
    session_id: str | None,
    file_path: str,
    offset: int | None,
    limit: int | None,
    cwd: str | None,
    cache: session.SessionCache | None = None,
    large_file_line_threshold: int = LARGE_FILE_LINE_THRESHOLD,
) -> ReadHint | None:
    """Return a ReadHint, or None when no hint is warranted.

    Never raises: any unexpected exception is caught and logged so the
    pre-read hook always continues regardless of hint-generation failures.
    """
    try:
        hint = _build_read_hint_inner(
            session_id=session_id,
            file_path=file_path,
            offset=offset,
            limit=limit,
            cwd=cwd,
            cache=cache,
            threshold=large_file_line_threshold,
        )
        # JSON sidecar: opt-in machine-readable line prepended after dedup so
        # fingerprint dedup above keeps deduping correctly. No-op when the
        # [hints] json_sidecar feature flag is off (default).
        if hint is not None:
            kind = "already_read" if hint.tokens_saved > 0 else "read_suggestion"
            hint = _emit_json_sidecar(
                hint, kind, file=file_path, wasted=hint.tokens_saved or None,
            )
        # NOTE: _record_hint_emitted and cache.record_hint_emitted are NOT called
        # here.  pre_read performs a second fingerprint dedup after receiving the
        # hint; incrementing counters before that check would count suppressed
        # hints as emitted.  Both calls live in hooks_read._handle_session_hint
        # inside the else-branch that only runs when the hint enters context.
        return hint
    except Exception as exc:
        _LOG.warning(
            "build_read_hint: unexpected error for %r (session=%s): %s",
            file_path,
            (session_id or "")[:16],
            exc,
            exc_info=True,
        )
        return None


def _build_read_hint_inner(
    *,
    session_id: str | None,
    file_path: str,
    offset: int | None,
    limit: int | None,
    cwd: str | None,
    cache: session.SessionCache | None = None,
    threshold: int = LARGE_FILE_LINE_THRESHOLD,
) -> ReadHint | None:
    """Inner implementation of build_read_hint; may raise."""
    if not session_id or not file_path:
        _LOG.debug("build_read_hint: skipped (session_id=%r, file_path=%r)", session_id, file_path)
        return None

    # Requested line range (1-indexed inclusive).
    safe_offset = max(0, int(offset)) if offset is not None else 0
    safe_limit = max(0, int(limit)) if limit is not None else 0
    req_start = safe_offset + 1
    req_end = req_start + (safe_limit or DEFAULT_READ_LIMIT) - 1
    # An explicit limit signals "surgical intent" — the agent picked a narrow window deliberately, not the implicit DEFAULT_READ_LIMIT fallback; used by _hint_from_cache to suppress nag-text on small intentional re-reads.
    has_explicit_limit = safe_limit > 0

    # Compute fname once; used in debug logs and forwarded to _hint_from_cache/_hint_from_index; both are sanitized here so every downstream hint f-string is safe (prevents newlines in crafted session JSON from splitting hint lines into fake "Note:" entries).
    fname = _sanitize_hint_path(Path(file_path).name)
    file_path = _sanitize_hint_path(file_path)

    # Compute a shorter recall_path for recall-command examples in hints; using relative path (if cwd available) instead of absolute saves ~25-40 tokens per hint; falls back to file_path if cwd is None or path not inside cwd.
    recall_path: str = file_path
    if cwd:
        try:
            _rel = Path(file_path).relative_to(Path(cwd))
            recall_path = _sanitize_hint_path(_rel.as_posix())
        except ValueError:
            pass  # file_path not under cwd — keep absolute path

    # 1. Check session cache first.
    # Load the cache once and pass it explicitly so _hint_from_cache can access
    # created_ts for the adaptive staleness threshold without a second disk read.
    if cache is None:
        cache = load_session_safe(session_id)
    entry = session.get_file_entry(session_id, file_path, cache=cache)
    if entry is not None:
        # Curator: if the agent has been ignoring re-read dedup hints, stop emitting them.
        if cache is None or not _curator_should_emit(cache):
            return None
        # Budget: hard cap on total dedup hints for the session.
        if cache is not None and not _hint_budget_check(cache, _HINT_KIND_DEDUP):
            return None
        hint = _hint_from_cache(
            entry, req_start, req_end, file_path,
            fname=fname, recall_path=recall_path,
            has_explicit_limit=has_explicit_limit,
            cache=cache,
            cwd=cwd,
        )
        if hint is not None:
            # Apply minimum-savings threshold: suppress re-read dedup hints where
            # the estimated bytes saved is below the configured floor.
            # Only applies to dedup hints (tokens_saved > 0); suggestion hints
            # (tokens_saved == 0) are never suppressed by this threshold since
            # they fire on large-file / index-miss paths regardless of prior read.
            if hint.tokens_saved > 0:
                try:
                    from . import config as _cfg
                    _min_bytes = _cfg.load().hints.min_session_hint_savings_bytes
                except Exception:
                    _min_bytes = 0
                if _min_bytes > 0:
                    estimated_bytes_saved = hint.tokens_saved * 3
                    if estimated_bytes_saved < _min_bytes:
                        _LOG.debug(
                            "build_read_hint: suppressing hint for %s (bytes_saved=%d < threshold=%d)",
                            fname, estimated_bytes_saved, _min_bytes,
                        )
                        return None
            _LOG.debug(
                "build_read_hint: cache hint for %s lines %d-%d (tokens_saved=%d)",
                fname, req_start, req_end, hint.tokens_saved,
            )
        else:
            _LOG.debug("build_read_hint: no hint (non-overlapping prior read of %s)", fname)
        return hint

    # 2. Not cached — consider "large file with indexed symbols" suggestion or
    # "co-read import suggestions" for small Python files.
    # Fast-path: a file smaller than LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE
    # bytes can never have enough lines to trigger a hint.  Skip the large-file index
    # query entirely for small files (the common case on the hot pre-read path).
    # Stat failure (missing file, permission error) falls through to _hint_from_index
    # so it can handle those cases with its existing logic.
    _stat_size: int | None = None
    try:
        _stat_size = Path(file_path).stat().st_size
        if _stat_size < threshold * _BYTES_PER_LINE_ESTIMATE:
            _LOG.debug(
                "build_read_hint: stat-skip index for %s (%dB < %dB threshold)",
                fname, _stat_size, threshold * _BYTES_PER_LINE_ESTIMATE,
            )
            # Before returning None, check for co-read suggestions on supported
            # source files on first read (when cache entry is None).
            _fp_lower = file_path.lower()
            _coread_eligible = (
                _fp_lower.endswith((_PY_SUFFIX, _GO_SUFFIX)) or any(_fp_lower.endswith(s) for s in _TS_JS_SUFFIXES)
            )
            if _coread_eligible:
                _cwd_path = validate_cwd(cwd, caller="_build_read_hint_inner (coread)")
                if _cwd_path is not None:
                    _project = find_project(_cwd_path)
                    if _project is not None:
                        _coread_hint = _build_coread_suggestion_hint(
                            file_path, _project.hash, cache
                        )
                        if _coread_hint is not None:
                            _LOG.debug(
                                "build_read_hint: coread hint for %s", fname
                            )
                            return _coread_hint
            return None
    except OSError:
        pass

    hint = _hint_from_index(file_path, cwd, req_start, req_end, fname=fname, threshold=threshold)
    if hint is not None:
        _LOG.debug("build_read_hint: index hint for %s (large file suggestion)", fname)
    else:
        _LOG.debug("build_read_hint: no hint for %s (not in session cache, not large/indexed)", fname)
    return hint


# ---------------------------------------------------------------------------
# Hint builders
# ---------------------------------------------------------------------------



# Minimum line proximity gap before a "you already read this file" hint is
# suppressed as a false positive.  When the new read's range is more than
# this many lines past the end of ALL cached ranges (or before the start),
# the agent is clearly reading a different section and the hint would be
# misleading noise — suppress it.
_PROXIMITY_SLOP_LINES: int = 200


def _line_ranges_global_bounds(
    line_ranges: list[tuple[int, int]],
) -> tuple[int, int]:
    """Return ``(global_min_start, global_max_end)`` across all cached line ranges.

    Computes the outermost line boundary of a list of ``(start, end)`` range
    tuples in a single pass.  Used by proximity-check guards in hint builders
    and hook handlers to determine whether a new read request falls within the
    ±:data:`_PROXIMITY_SLOP_LINES` band of any previously-read section.

    Args:
        line_ranges: Non-empty list of ``(start_line, end_line)`` tuples
                     (1-indexed, inclusive).  Callers must verify the list is
                     non-empty before calling; passing an empty list raises
                     ``IndexError``.

    Returns:
        A ``(global_min, global_max)`` pair where ``global_min`` is the
        smallest start line and ``global_max`` is the largest end line across
        all ranges.
    """
    global_min = line_ranges[0][0]
    global_max = line_ranges[0][1]
    for range_start, range_end in line_ranges[1:]:
        if range_start < global_min:
            global_min = range_start
        if range_end > global_max:
            global_max = range_end
    return global_min, global_max


def _total_cached_lines(line_ranges: list[tuple[int, int]]) -> int:
    """Return the count of distinct lines covered by ``line_ranges``.

    Computes the size of the *union* of the ``(start, end)`` tuples (1-indexed,
    inclusive), so overlapping ranges are not double-counted.  Used to size the
    "already in context" token figure for exact-match re-read hints: the waste a
    re-read implies is the full content already consumed across every cached
    range, not just the narrow window the agent re-requested.

    A ``(0, 0)`` sentinel range (full-file collapse marker) contributes nothing
    here; callers that see the sentinel handle it on a dedicated path before
    reaching this helper.

    Args:
        line_ranges: List of ``(start_line, end_line)`` tuples.  An empty list
                     returns 0.

    Returns:
        The number of distinct lines covered by the merged ranges.
    """
    spans = sorted(
        (s, e) for s, e in line_ranges if e >= s and (s, e) != (0, 0)
    )
    if not spans:
        return 0
    total = 0
    cur_start, cur_end = spans[0]
    for s, e in spans[1:]:
        if s <= cur_end + 1:  # contiguous or overlapping — extend the current span
            if e > cur_end:
                cur_end = e
        else:  # gap — close out the current span and start a new one
            total += cur_end - cur_start + 1
            cur_start, cur_end = s, e
    total += cur_end - cur_start + 1
    return total


def _should_suppress_full_file_hint(n_lines: int | None, threshold: int | None = None) -> bool:
    """Return True when a full-file hint should be suppressed based on line count.

    Surgical hints (symbol/section/diff) always bypass this check; only full-file
    hints (already-read dedup, index-based large-file suggestions) are gated.
    When min_file_lines_for_hint is 0 (default), no suppression occurs.
    When n_lines is None (no cached line count), suppression is skipped to avoid
    adding new stat calls to the hot path.

    Pass *threshold* explicitly when the caller already holds the config value to
    avoid a second ``config.load()`` call (e.g. for debug logging).  When
    omitted, the threshold is read from ``config.load()``.
    """
    if threshold is None:
        threshold = config.load().hints.min_file_lines_for_hint
    if threshold <= 0 or n_lines is None:
        return False
    return n_lines < threshold


def _indexed_line_count(file_path: str, cwd: str | None) -> int | None:
    """Return the DB-indexed line count for *file_path*, or None if unavailable.

    Used to verify the max_line proxy before applying the min_file_lines_for_hint
    suppression: a partial read of a large file yields a small max_line value that
    would otherwise incorrectly suppress the hint.  The DB lookup is skipped
    (returns None) when cwd is absent, the project isn't found, or the file isn't
    indexed — the caller falls back to the max_line proxy in all those cases.
    """
    if not cwd:
        return None
    try:
        from pathlib import Path as _Path

        from token_goat import db as _db
        from token_goat.project import find_project as _find_project

        cwd_path = _Path(cwd)
        project = _find_project(cwd_path)
        if project is None:
            return None
        abs_p = _Path(file_path)
        if not abs_p.is_absolute():
            abs_p = (project.root / file_path).resolve()
        try:
            rel = abs_p.relative_to(project.root).as_posix()
        except ValueError:
            return None
        with _db.open_project_readonly(project.hash) as conn:
            row = conn.execute(
                "SELECT line_count FROM files WHERE rel_path = ?", (rel,)
            ).fetchone()
        return int(row[0]) if row and row[0] is not None else None
    except Exception:
        return None


def _hint_from_cache(
    entry: session.FileEntry,
    req_start: int,
    req_end: int,
    file_path: str,
    *,
    fname: str | None = None,
    recall_path: str | None = None,
    has_explicit_limit: bool = False,
    cache: session.SessionCache | None = None,
    cwd: str | None = None,
) -> ReadHint | None:
    """Build hint when the file was already accessed this session.

    ``has_explicit_limit`` is True when the agent supplied a concrete ``limit``
    on the Read call (rather than relying on the implicit DEFAULT_READ_LIMIT).
    A small explicit-limit request is surgical intent — see
    ``_NARROW_EXPLICIT_READ_LINES`` for why this short-circuits the dedup nag.

    ``recall_path`` is the path used in recall-command examples embedded in
    hints.  When provided, it should be the shortest unambiguous path (e.g.
    relative path from project root) rather than the full absolute path.  If
    omitted, falls back to ``file_path``.
    """
    # Accept pre-computed fname from build_read_hint to avoid a redundant
    # Path allocation on the hot pre-read path (one Path per hook call saved).
    # Sanitize here too for direct callers that bypass build_read_hint.
    if fname is None:
        fname = _sanitize_hint_path(Path(file_path).name)
    file_path = _sanitize_hint_path(file_path)
    # recall_path: prefer the explicitly-supplied shorter path; fall back to
    # the absolute file_path (already sanitized above).
    if recall_path is None:
        recall_path = file_path
    requested_lines = req_end - req_start + 1

    # Suppress the line-range dedup hint when the cached ranges are no longer
    # trustworthy:
    #
    # 1. **Edited after last read.** A single Write/Edit/MultiEdit shifts every
    #    line number after the insertion/deletion point.  Telling the model
    #    "you already read lines 100-200" when those lines now contain
    #    different code is worse than no hint — it actively misleads.  We
    #    leave the symbol-only case below intact: symbols_read carries names,
    #    not line numbers, so it survives an edit.
    #
    # 2. **Read is stale.** If the last read was a long time ago, the content
    #    has likely scrolled out of the model's actual context window even
    #    though the session JSON still tracks it.  Re-reading is legitimate.
    edited_after_read = entry.last_edit_ts > entry.last_read_ts
    now = time.time()
    stale_threshold = _session_stale_threshold(cache, now)
    read_is_stale = (now - entry.last_read_ts) > stale_threshold
    if (edited_after_read or read_is_stale) and entry.line_ranges:
        _LOG.debug(
            "_hint_from_cache: suppressing line-range hint for %s "
            "(edited_after_read=%s, read_is_stale=%s)",
            fname, edited_after_read, read_is_stale,
        )
        # Fall through to symbol-only path below if symbols are present and
        # line_ranges happens to be empty (won't be on this branch); otherwise
        # return None — no actionable hint when the cache cannot be trusted.
        if not entry.symbols_read:
            return None
        # Symbols are still meaningful (names don't shift on edit), but the
        # combined symbols+ranges entry shouldn't emit either hint variant:
        # the symbol hint below assumes "no line_ranges" so we'd lie about the
        # access pattern. Suppress entirely.
        return None

    # Check for full-file collapse sentinel: line_ranges == [(0, 0)] means the file
    # has been read 10+ times and all range tracking has been collapsed to save JSON
    # space. This check must come before the working-file suppression so the sentinel
    # can emit its own hint before generic suppression rules apply.
    if entry.line_ranges == [(0, 0)]:
        sym_suffix = _symbols_suffix(entry.symbols_read)
        return ReadHint(
            _apply_terse(
                f"`{fname}` full file ×{entry.read_count}{sym_suffix}. "
                f"In context; range hints suppressed."
            ),
            0,  # No tokens saved — the file is in context; this is informational.
        )

    # Line-count threshold suppression: when min_file_lines_for_hint is configured,
    # suppress full-file dedup hints for tiny files where the hint cost exceeds savings.
    # max_line is the highest cached_end from stored ranges — a lower bound on file size,
    # not the actual total.  For a 500-line file read only up to line 40, max_line=40,
    # which would incorrectly trigger suppression.  When max_line falls below the
    # threshold, verify the actual line count before suppressing.
    if entry.line_ranges and entry.line_ranges != [(0, 0)]:
        max_line = max(cached_end for cached_start, cached_end in entry.line_ranges)
        _min_lines = config.load().hints.min_file_lines_for_hint
        if _should_suppress_full_file_hint(max_line, _min_lines):
            # max_line proxy says "maybe suppress".  Resolve the true line count:
            # 1. Indexed DB count (no extra I/O, most reliable).
            # 2. Disk count via _line_count (one file read; handles unindexed files).
            # If the true count is at or above the threshold, the file is large —
            # do not suppress.  Fall back to suppressing only if count is unavailable.
            _true_lines: int | None = _indexed_line_count(file_path, cwd)
            if _true_lines is None:
                _true_lines = _line_count(Path(file_path))
            if _true_lines is not None and _true_lines >= _min_lines:
                pass  # File is large; max_line undercount — do not suppress.
            else:
                _LOG.debug(
                    "_hint_from_cache: suppressing full-file hint for %s "
                    "(line_count=%d < threshold=%d)",
                    fname, _true_lines if _true_lines is not None else max_line, _min_lines,
                )
                # Symbol-only hints are still emitted (surgical reads are never suppressed).
                if not entry.symbols_read:
                    return None
                # File is small but has surgical-read symbols — emit the symbol-only hint and
                # return immediately.  Without this return, execution falls through to the
                # line-range hint path below; the dedicated symbol-only path at line ~891
                # (`if entry.symbols_read and not entry.line_ranges:`) is unreachable here
                # because entry.line_ranges is truthy inside this branch.
                n_syms = len(entry.symbols_read)
                sym_list = ", ".join(f"`{s}`" for s in entry.symbols_read[:3])
                more = f" +{n_syms - 3}" if n_syms > 3 else ""
                return ReadHint(
                    _apply_terse(
                        f"`{fname}` read via `token-goat read`: {sym_list}{more}. "
                        f"{_CMD_READ_SYMBOL.format(path=recall_path)}"
                    ),
                    0,
                )

    # Frequently-read files: emit a one-time surgical-read nudge instead of
    # repeating the line-range nag on every re-read.  The hint text is stable
    # (does not include the dynamic read count) so the fingerprint dedup in
    # pre_read suppresses it after the first injection — the model hears the
    # suggestion exactly once and is not nagged on subsequent accesses.
    if entry.read_count >= _SUPPRESS_HINT_AT_READ_COUNT and entry.line_ranges:
        sym_suffix = _symbols_suffix(entry.symbols_read)
        _LOG.debug(
            "_hint_from_cache: surgical-read nudge for %s (working file: read_count=%d)",
            fname, entry.read_count,
        )
        return ReadHint(
            _apply_terse(
                f"`{fname}` re-read often{sym_suffix}. "
                f"{_CMD_READ_SYM_SURGICAL.format(path=recall_path)}"
            ),
            0,
        )

    # Suppress hints for very small files (< 30 lines) with only a single prior read.
    # The hint text itself (~25 tokens) costs almost as much as the saving it advertises,
    # making the nudge net-negative. Tiny files are cheap to re-read.
    if entry.line_ranges and entry.read_count == 1:
        # Compute the max line number across all cached ranges.
        max_line = max(cached_end for cached_start, cached_end in entry.line_ranges)
        if max_line < _MIN_LINES_FOR_HINT:
            _LOG.debug(
                "_hint_from_cache: suppressing hint for %s "
                "(small file: %d lines, read_count=1)",
                fname, max_line,
            )
            return None

    # Case: file accessed only via token-goat read <file>::<symbol>.
    # A suggestion, not a realized saving → tokens_saved=0.
    # Suppress for stale symbol-only accesses — symbol names don't shift on
    # edit, but a very old access is no longer worth reminding the agent about.
    if read_is_stale and not entry.line_ranges:
        return None
    if entry.symbols_read and not entry.line_ranges:
        n_syms = len(entry.symbols_read)
        sym_list = ", ".join(f"`{s}`" for s in entry.symbols_read[:3])
        more = f" +{n_syms - 3}" if n_syms > 3 else ""
        return ReadHint(
            _apply_terse(
                f"`{fname}` read via `token-goat read`: {sym_list}{more}. "
                f"{_CMD_READ_SYMBOL.format(path=recall_path)}"
            ),
            0,
        )

    # Hoist entry.line_ranges to a local to avoid repeated attribute lookups
    # on this hot pre-read path (one hook call per Read tool invocation).
    # n_ranges caches len() so it is not recomputed for the summary/extra strings.
    line_ranges = entry.line_ranges
    n_ranges = len(line_ranges)

    # Proximity check (Item A28): when the new read is entirely outside every
    # cached range by more than _PROXIMITY_SLOP_LINES lines, the hint is a
    # false positive — the agent is reading a different section of the file.
    # Compute the global min/max cached line in a single pass and suppress
    # when the request falls entirely outside the ±slop band.
    if line_ranges:
        global_min, global_max = _line_ranges_global_bounds(line_ranges)
        if req_start > global_max + _PROXIMITY_SLOP_LINES or req_end < global_min - _PROXIMITY_SLOP_LINES:
            _LOG.debug(
                "_hint_from_cache: suppressing hint for %s "
                "(proximity: req=[%d,%d] cached=[%d,%d] slop=%d)",
                fname, req_start, req_end, global_min, global_max, _PROXIMITY_SLOP_LINES,
            )
            return None

    # Compute overlap against all cached ranges in a single pass.
    # Also track last_cached_end here to avoid a second generator scan later.
    overlap_lines = 0
    exact_match = False
    last_cached_end = 0
    for cached_start, cached_end in line_ranges:
        overlap_start = max(cached_start, req_start)
        overlap_end = min(cached_end, req_end)
        if overlap_end >= overlap_start:
            overlap_lines += overlap_end - overlap_start + 1
        if cached_start <= req_start and cached_end >= req_end:
            exact_match = True
        if cached_end > last_cached_end:
            last_cached_end = cached_end

    # Trim the displayed ranges to the _MAX_CACHED_RANGES_DISPLAY most-recent
    # (highest line numbers) to keep hint text terse.  The full range list is
    # still used for overlap/exact-match logic above; only the human-readable
    # summary is capped here.  Sorting by start line and taking the tail gives
    # the most recently accessed sections of the file, which are highest signal.
    _display_ranges = sorted(line_ranges, key=lambda r: r[0])[-_MAX_CACHED_RANGES_DISPLAY:]
    _n_hidden = n_ranges - len(_display_ranges)
    cached_summary = ", ".join(f"{s}-{e}" for s, e in _display_ranges)
    extra = f" (+{_n_hidden} more ranges)" if _n_hidden > 0 else ""

    # Exact re-read of already-cached lines — the full request is avoidable.
    if exact_match:
        # Surgical intent guard: when the agent picked a narrow window with an
        # explicit limit, suppress the nag. The advice "use a different
        # offset/limit" is misleading (the agent already did) and the hint
        # text itself (~50-80 tokens) approaches the realized saving for very
        # small re-reads, making the nudge net-neutral or net-negative.  The
        # surrounding-context Read may also be legitimate: a small slice the
        # agent needs back in active context after intervening turns.
        if has_explicit_limit and requested_lines <= _NARROW_EXPLICIT_READ_LINES:
            _LOG.debug(
                "_hint_from_cache: suppressing exact-match nag for %s "
                "(surgical re-read: %d lines with explicit limit)",
                fname, requested_lines,
            )
            return None
        # Report the waste against the full content already in context, not the
        # narrow requested sub-window.  On an exact-match re-read the agent
        # already holds every cached range; a partial re-read (offset=50,
        # limit=100 over a file cached 1-500) re-sends only those 100 lines, but
        # the figure the user cares about is how much of the file is already
        # consumed — the union of all cached line ranges, which for a fully-read
        # file is the whole file.  Using requested_lines undercounts that badly
        # (it would report ~300t for a 34kt file).  Fall back to the requested
        # window only when the cached coverage somehow resolves to less.
        cached_lines = _total_cached_lines(line_ranges)
        wasted = _est_tokens_from_lines(max(cached_lines, requested_lines))
        sym_suffix = _symbols_suffix(entry.symbols_read)
        return ReadHint(
            _apply_terse(
                f"`{fname}` L{req_start}-{req_end} cached (L{cached_summary}{extra}){sym_suffix}. "
                f"~{wasted}t wasted."
            ),
            wasted,
        )

    # Partial overlap — only the overlapping lines are avoidable.
    if overlap_lines > MIN_OVERLAP_TO_WARN:
        wasted = _est_tokens_from_lines(overlap_lines)
        # Suggest starting the next Read just past the last cached line.
        # The Read tool's `offset` is 0-indexed (lines skipped before reading),
        # so passing `last_cached_end` as offset resumes at line last_cached_end+1.
        # last_cached_end was already computed above during the overlap scan.
        resume_offset = last_cached_end
        sym_suffix = _symbols_suffix(entry.symbols_read)
        return ReadHint(
            _apply_terse(
                f"`{fname}` cached L{cached_summary}{extra}{sym_suffix}. "
                f"Overlap (~{wasted}t) — use `offset={resume_offset}`."
            ),
            wasted,
        )

    # Non-overlapping prior read — there is nothing actionable to say: the
    # agent is reading genuinely new content and the file is not necessarily
    # large. An "FYI, proceeding" note would cost tokens in the conversation
    # for zero benefit, so suppress it entirely rather than inject noise.
    return None


def _confirmed_line_count(
    estimated_lines: int,
    line_count_is_exact: bool,
    abs_path: Path,
    threshold: int = LARGE_FILE_LINE_THRESHOLD,
) -> int | None:
    """Return a confirmed line count at or above the large-file threshold, or None.

    When the DB already stores an exact count, use it directly.  When the count
    is only an estimate (size-based), verify against the real file: estimates
    can be low enough to suppress hints for genuinely large files.  Returns None
    when the file is clearly below the threshold and no hint is warranted.
    """
    if line_count_is_exact:
        return estimated_lines if estimated_lines >= threshold else None
    # Estimate is below threshold — check the real file before suppressing the hint.
    if estimated_lines < threshold:
        actual = _line_count(abs_path)
        if actual is None or actual < threshold:
            return None
        return actual
    # Estimate is at or above threshold — trust it without a disk read.
    return estimated_lines


def _hint_from_index(
    file_path: str,
    cwd: str | None,
    req_start: int,
    req_end: int,
    *,
    fname: str | None = None,
    threshold: int = LARGE_FILE_LINE_THRESHOLD,
) -> ReadHint | None:
    """Build hint when file is large and has indexed symbols but not yet cached."""
    # Accept a pre-computed fname to avoid a redundant Path allocation on the
    # hot pre-read path; fall back to computing it here for direct callers.
    # Sanitize here too for direct callers that bypass build_read_hint.
    if fname is None:
        fname = _sanitize_hint_path(Path(file_path).name)
    cwd_path = validate_cwd(cwd, caller="_hint_from_index")
    if cwd_path is None:
        _LOG.debug("_hint_from_index: skipped for %s (no valid cwd)", fname)
        return None

    project = find_project(cwd_path)
    if project is None:
        _LOG.debug("_hint_from_index: skipped for %s (no project found in %s)", fname, cwd)
        return None

    abs_path = Path(file_path)
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()

    # Compute relative path for DB lookup.
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        _LOG.debug("_hint_from_index: %s not under project root %s", file_path, project.root)
        return None

    symbols, estimated_lines, line_count_is_exact = _get_indexed_symbols_and_line_count(
        rel, project.hash
    )
    if estimated_lines is None:
        _LOG.debug("_hint_from_index: %s not in project index (no file row)", fname)
        return None

    n_lines = _confirmed_line_count(estimated_lines, line_count_is_exact, abs_path, threshold=threshold)
    if n_lines is None:
        _LOG.debug("_hint_from_index: %s below large-file threshold (estimated=%s)", fname, estimated_lines)
        return None

    # Line-count threshold suppression: suppress index-based hints for tiny files
    # when the hint cost exceeds the value of a surgical read suggestion.
    _min_lines = config.load().hints.min_file_lines_for_hint
    if _should_suppress_full_file_hint(n_lines, _min_lines):
        _LOG.debug(
            "_hint_from_index: suppressing index hint for %s "
            "(line_count=%d < threshold=%d)",
            fname, n_lines, _min_lines,
        )
        return None

    full_tokens = _est_tokens_from_lines(n_lines)

    if not symbols:
        _LOG.info(
            "_hint_from_index: %s is large (%d lines) but has no indexed symbols "
            "(project=%s) — emitting chunk-read hint",
            rel, n_lines, project.hash[:8],
        )
        return ReadHint(
            _apply_terse(
                f"`{fname}`: {n_lines} lines (~{full_tokens} tokens). "
                f"No symbols indexed. Use offset/limit to chunk."
            ),
            0,
        )

    n_total = len(symbols)
    # Sanitize symbol names: they come from source-file content stored in the DB
    # and could contain embedded newlines if the parser extracted a multi-line token.
    first_sym_name = _sanitize_hint_path(symbols[0]["name"])

    # Build a compact listing of up to 3 symbol names.
    # Sanitize each name; cap the list at 3 so the hint stays terse.
    preview_names = [_sanitize_hint_path(s["name"]) for s in symbols[:3]]
    sym_list_str = ", ".join(preview_names)
    overflow = n_total - len(preview_names)

    # A *suggestion*, not a realized saving. tokens_saved=0: if the agent acts
    # on it, `token-goat read` records the real `read_replacement` stat — counting
    # a saving here too would double-count, and counting one when the agent
    # ignores the hint and reads the whole file is pure phantom inflation.
    #
    # Kept deliberately terse: the hint text itself costs tokens in the
    # conversation, so it carries one example command rather than enumerating
    # every indexed symbol (`token-goat symbol`/`map` cover that on demand).
    if overflow > 0:
        # When there are more symbols than the 3-symbol preview, surface the
        # total count and offer skeleton as a lightweight browse step before
        # committing to a full read or a targeted `read "file::symbol"` call.
        sym_clause = f"Symbols: {sym_list_str} (+{overflow} more, {n_total} total). "
        return ReadHint(
            _apply_terse(
                f"`{fname}`: {n_lines} lines (~{full_tokens} tokens). "
                f"{sym_clause}"
                f"Use `token-goat skeleton \"{rel}\"` to browse all, "
                f"or `token-goat read \"{rel}::{first_sym_name}\"` for one symbol."
            ),
            0,
        )
    sym_clause = f"Symbols: {sym_list_str}. "
    return ReadHint(
        _apply_terse(
            f"`{fname}`: {n_lines} lines (~{full_tokens} tokens). "
            f"{sym_clause}"
            f"{_CMD_READ_FIRST_SYM_FAST.format(path=rel, symbol=first_sym_name)}"
        ),
        0,
    )


# ---------------------------------------------------------------------------
# Co-read suggestion hint (predictive import suggestions)
# ---------------------------------------------------------------------------

# TS/JS source extensions tried when resolving a bare relative import path.
# Order matters: .ts and .tsx first because most TS projects don't mix .js
# files in the same tree, so the hit rate for the first two candidates is high.
_TS_EXTENSIONS: tuple[str, ...] = (".ts", ".tsx", ".js", ".jsx")
_TS_JS_SUFFIXES: tuple[str, ...] = (".ts", ".tsx", ".js", ".jsx")
_GO_SUFFIX: str = ".go"
_PY_SUFFIX: str = ".py"


def _get_go_module_prefix(project_hash: str) -> str | None:
    """Return the Go module path declared in go.mod, or None if absent/unreadable.

    Reads the first ``module`` directive from go.mod using the project root
    stored in the global DB.  Result is intentionally not cached — this
    function is called at most once per co-read hint evaluation and go.mod is
    tiny.
    """
    try:
        import re as _re

        with db.open_global_readonly() as conn:
            row = conn.execute("SELECT root FROM projects WHERE hash = ?", (project_hash,)).fetchone()
        if not row:
            return None
        go_mod = Path(row[0]) / "go.mod"
        if not go_mod.is_file():
            return None
        text = go_mod.read_text(encoding="utf-8", errors="replace")
        m = _re.search(r"^\s*module\s+(\S+)", text, _re.MULTILINE)
        return m.group(1) if m else None
    except Exception:
        return None


def _should_include_in_unread(cache: session.SessionCache | None, rel_path: str) -> bool:
    """Determine if a matched file should be included in the unread list.

    Returns ``True`` when the file is a candidate for co-read suggestions:
    - cache is None (no session cache available, so we include everything), OR
    - the file is not in cache.files (not yet read in this session).

    Returns ``False`` if the cache is available and the file has already been
    read in this session, suppressing duplicate suggestions.
    """
    return not cache or rel_path not in cache.files


def _resolve_ts_candidates(target: str, importing_rel: str) -> list[str]:
    """Resolve a relative TS/JS import target to candidate rel_path strings.

    ``target`` is the raw import string (e.g. ``'./styles'``, ``'../utils'``).
    ``importing_rel`` is the project-relative path of the file containing the
    import (e.g. ``'src/components/Button.tsx'``).

    Returns a list of candidate rel_paths to check against the files table.
    Only called for targets that start with ``'./'`` or ``'../'``.
    """
    importing_dir = Path(importing_rel).parent
    # Strip leading ./ or ../
    resolved_base = (importing_dir / target).as_posix()
    # Normalise: collapse any .. segments that survived as literal dots
    parts: list[str] = []
    for part in resolved_base.split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    base = "/".join(parts)

    candidates = [f"{base}{ext}" for ext in _TS_EXTENSIONS]
    # index file variants
    candidates.extend(f"{base}/index{ext}" for ext in _TS_EXTENSIONS)
    return candidates


def _get_unread_coread_files_py(
    file_path: str,
    project_hash: str,
    cache: session.SessionCache | None,
    conn: sqlite3.Connection,
) -> list[tuple[str, str]]:
    """Python-specific co-read: resolve dot-separated module names to .py files."""
    stem = Path(file_path).name[:-3]
    cursor = conn.execute(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel LIKE ? LIMIT 10",
        (f"%{stem}%",),
    )
    imports = [row[0] for row in cursor.fetchall()]
    unread: list[tuple[str, str]] = []
    for target in imports:
        parts = target.split(".")
        module_name = parts[-1]
        candidates = [f"{module_name}.py"]
        candidates.extend("/".join(parts[:i]) + f"/{parts[i]}.py" for i in range(len(parts) - 1, 0, -1))
        for candidate in candidates:
            row = conn.execute(
                "SELECT rel_path FROM files WHERE rel_path LIKE ? AND rel_path LIKE '%.py' LIMIT 1",
                (f"%{candidate}",),
            ).fetchone()
            if row:
                matched_rel = row[0]
                if _should_include_in_unread(cache, matched_rel):
                    unread.append((matched_rel, module_name))
                break
        if len(unread) >= 3:
            break
    return unread


def _get_unread_coread_files_ts(
    file_path: str,
    project_hash: str,
    cache: session.SessionCache | None,
    conn: sqlite3.Connection,
) -> list[tuple[str, str]]:
    """TS/JS-specific co-read: resolve relative imports to local source files."""
    try:
        rel_path = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ? LIMIT 1",
            (f"%{Path(file_path).name}",),
        ).fetchone()
    except Exception:
        return []
    importing_rel = rel_path[0] if rel_path else Path(file_path).name

    cursor = conn.execute(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel = ? LIMIT 20",
        (importing_rel,),
    )
    all_targets = [row[0] for row in cursor.fetchall()]

    # Only local relative imports
    local_targets = [t for t in all_targets if t.startswith(("./", "../"))]
    if not local_targets:
        return []

    unread: list[tuple[str, str]] = []
    for target in local_targets:
        candidates = _resolve_ts_candidates(target, importing_rel)
        for candidate in candidates:
            row = conn.execute(
                "SELECT rel_path FROM files WHERE rel_path = ? LIMIT 1",
                (candidate,),
            ).fetchone()
            if row:
                matched_rel = row[0]
                display_name = Path(matched_rel).name
                if _should_include_in_unread(cache, matched_rel):
                    unread.append((matched_rel, display_name))
                break
        if len(unread) >= 3:
            break
    return unread


def _get_unread_coread_files_go(
    file_path: str,
    project_hash: str,
    cache: session.SessionCache | None,
    conn: sqlite3.Connection,
) -> list[tuple[str, str]]:
    """Go-specific co-read: resolve intra-module imports to local .go files."""
    module_prefix = _get_go_module_prefix(project_hash)
    if not module_prefix:
        return []

    importing_rel = conn.execute(
        "SELECT rel_path FROM files WHERE rel_path LIKE ? LIMIT 1",
        (f"%{Path(file_path).name}",),
    ).fetchone()
    if not importing_rel:
        return []
    file_rel = importing_rel[0]

    cursor = conn.execute(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel = ? LIMIT 20",
        (file_rel,),
    )
    all_targets = [row[0] for row in cursor.fetchall()]

    # Only imports that belong to this module
    local_targets = [t for t in all_targets if t.startswith(module_prefix + "/")]
    if not local_targets:
        return []

    unread: list[tuple[str, str]] = []
    for target in local_targets:
        # Strip the module prefix to get the directory path within the project
        pkg_dir = target[len(module_prefix) + 1:]  # e.g. "internal/cache"
        # Find any .go file in that directory
        row = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ? AND rel_path LIKE '%.go' LIMIT 1",
            (f"{pkg_dir}/%",),
        ).fetchone()
        if row:
            matched_rel = row[0]
            display_name = pkg_dir.split("/")[-1]  # just the package name
            if _should_include_in_unread(cache, matched_rel):
                unread.append((matched_rel, display_name))
        if len(unread) >= 3:
            break
    return unread


def _get_unread_coread_files(
    file_path: str,
    project_hash: str,
    cache: session.SessionCache | None = None,
) -> list[tuple[str, str]] | None:
    """Get unread local-import files that are imported by the given file.

    Supports Python (.py), TypeScript/JavaScript (.ts/.tsx/.js/.jsx), and Go
    (.go) source files.  For each language only local imports are considered:
    - Python: any dotted module that maps to a .py file in the project
    - TS/JS: imports with a ``./`` or ``../`` prefix (relative paths only)
    - Go: imports whose path starts with the current module prefix from go.mod

    Returns a list of (rel_path, display_name) tuples for up to 3 unread
    in-project files, or None if indexing is unavailable or no unread local
    imports exist.
    """
    lower = file_path.lower()
    is_py = lower.endswith(_PY_SUFFIX)
    is_ts_js = any(lower.endswith(s) for s in _TS_JS_SUFFIXES)
    is_go = lower.endswith(_GO_SUFFIX)
    if not (is_py or is_ts_js or is_go):
        return None

    try:
        with db.open_project_readonly(project_hash) as conn:
            if is_py:
                result = _get_unread_coread_files_py(file_path, project_hash, cache, conn)
            elif is_ts_js:
                result = _get_unread_coread_files_ts(file_path, project_hash, cache, conn)
            else:
                result = _get_unread_coread_files_go(file_path, project_hash, cache, conn)
        return result or None

    except (sqlite3.OperationalError, sqlite3.DatabaseError, AttributeError):
        _LOG.debug(
            "_get_unread_coread_files: db query failed for %s (project=%s)",
            file_path[:64],
            project_hash[:8],
            exc_info=True,
        )
        return None
    except Exception:
        _LOG.debug(
            "_get_unread_coread_files: unexpected error for %s",
            file_path[:64],
            exc_info=True,
        )
        return None


def _build_coread_suggestion_hint(
    file_path: str,
    project_hash: str,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Build a co-read suggestion hint when unread local imports exist.

    Returns a ReadHint suggesting related files to read, or None if:
    - The file extension is not supported (.py, .ts, .tsx, .js, .jsx, .go)
    - No unread local imports found
    - Indexing is unavailable
    """
    coread_files = _get_unread_coread_files(file_path, project_hash, cache)
    if not coread_files:
        return None

    fname = _sanitize_hint_path(Path(file_path).name)

    # Build suggestion text using actual filenames from DB rel_paths
    display_names = [_sanitize_hint_path(Path(rel).name) for rel, _ in coread_files[:3]]
    if len(display_names) == 1:
        suggestion = f"`{display_names[0]}` (unread)"
    else:
        suggestion = ", ".join(f"`{n}`" for n in display_names) + " (unread)"

    db_rel = coread_files[0][0]
    first_rel = _sanitize_hint_path(db_rel.replace("\\", "/"))

    # Replace the legacy ``::ClassName`` placeholder with a real top-of-file symbol from the index so the suggested read runs as-is; fall back to ``outline`` (which lists the symbols) when the file has none indexed.
    symbols, _lines, _exact = _get_indexed_symbols_and_line_count(db_rel, project_hash)
    if symbols:
        sym = _sanitize_hint_symbol(symbols[0]["name"])
        read_cmd = f"`token-goat read \"{first_rel}::{sym}\"`"
    else:
        read_cmd = f"`token-goat outline \"{first_rel}\"`"

    return ReadHint(
        _apply_terse(
            f"Note: `{fname}` imports {suggestion}. Use {read_cmd} to read selectively."
        ),
        0,
    )


# ---------------------------------------------------------------------------
# High-frequency file access hint
# ---------------------------------------------------------------------------

# Minimum number of times a file must be accessed in one session before the
# high-frequency hint fires.  Below this threshold the hint cost (~25 tokens)
# exceeds the value of the nudge.
_HIGH_FREQ_THRESHOLD: Final[int] = 3


def build_high_frequency_hint(
    session_cache: session.SessionCache,
    file_path: str,
    *,
    threshold: int = _HIGH_FREQ_THRESHOLD,
    resolved_symbol: str | None = None,
) -> HintItem | None:
    """Return a HintItem nudging toward surgical reads when a file is accessed often.

    Fires at MEDIUM priority when *file_path* has been accessed at least
    *threshold* times in the current session.  The hint text names the access
    count, the file basename, and two surgical-read alternatives so the agent
    has an immediately actionable command.

    When *resolved_symbol* is supplied (resolved by an earlier surgical hint in
    the same pre-read pass), the generic ``<symbol>`` placeholder is replaced
    with the concrete name so the agent gets a directly runnable command.

    Returns ``None`` when:
    - The access count is below *threshold*.
    - *file_path* is empty.
    - Any unexpected error occurs (fail-soft).
    """
    try:
        if not file_path:
            return None
        count = session_cache.get_file_access_count(file_path)
        if count < threshold:
            return None
        fname = _sanitize_hint_path(Path(file_path).name)
        safe_path = _sanitize_hint_path(file_path)
        sym = resolved_symbol if resolved_symbol else "<symbol>"
        text = _apply_terse(
            f"`{fname}` read {count}x this session — consider "
            f"`token-goat outline {safe_path}` or "
            f"`token-goat read \"{safe_path}::{sym}\"` for a narrower read."
        )
        return HintItem(text, HINT_PRIORITY_MEDIUM)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Diff-aware re-read hint
# ---------------------------------------------------------------------------

# Largest diff (in bytes of unified-diff output) eligible for inclusion in the
# hint.  Beyond this the diff itself stops being a saving — it would push more
# tokens into context than the original Read.  4 KB ≈ 1100 tokens, comfortably
# smaller than even a small full-file Read and still big enough to express
# meaningful refactoring changes (typically tens of changed lines).
DIFF_HINT_MAX_BYTES: int = 4096

# Minimum *raw* tokens saved (full-file tokens - diff tokens) before the diff
# hint is emitted.  Below this the hint text and diff itself approach the
# saving they advertise, so the nudge is suppressed entirely.  ~250 tokens
# represents roughly 15 lines of code — the rough breakeven point with the
# ~80-token hint preamble.
_DIFF_HINT_MIN_TOKENS_SAVED: int = 250

# Number of context lines kept around each changed hunk in the unified diff.
# Two lines on each side is the same default git uses for code review — wide
# enough to anchor a hunk visually but narrow enough to keep diff bytes low.
_DIFF_CONTEXT_LINES: int = 2

# For tiny edits (≤ this many changed lines), one context line on each side is
# plenty of anchor — saves ~6 lines of duplicated context per small hunk.
_DIFF_TINY_CHANGE_THRESHOLD: int = 3
_DIFF_TINY_CONTEXT_LINES: int = 1


@_failsoft_hint
def build_diff_hint(
    *,
    session_id: str,
    file_path: str,
    current_text: str,
) -> ReadHint | None:
    """Return a diff-based hint when a snapshot is available and the diff fits.

    Computes a unified diff between the prior session snapshot of *file_path*
    and *current_text* (the file's contents the agent is about to re-read).
    When the diff is small enough to inject as ``additionalContext`` and
    represents a meaningful saving over re-reading the whole file, returns a
    :class:`ReadHint` carrying the diff in a fenced code block.

    Returns ``None`` (no hint) when:

    * no snapshot exists for this (session, file_path)
    * the snapshot is identical to current contents (no diff to show)
    * the file is the same length but no meaningful change is detected
    * the diff would exceed :data:`DIFF_HINT_MAX_BYTES`
    * the realized saving falls below :data:`_DIFF_HINT_MIN_TOKENS_SAVED`

    Never raises; the ``@_failsoft_hint`` decorator catches any unexpected
    exception (an error in hint generation must not break the pre-read hook's
    fail-soft contract).
    """
    return _build_diff_hint_inner(
        session_id=session_id, file_path=file_path, current_text=current_text,
    )


def _build_diff_hint_inner(
    *,
    session_id: str,
    file_path: str,
    current_text: str,
) -> ReadHint | None:
    """Inner implementation of :func:`build_diff_hint`; may raise."""
    try:
        _min_tokens_saved = config.load().hints.diff_hint_min_tokens_saved
    except Exception:
        _min_tokens_saved = _DIFF_HINT_MIN_TOKENS_SAVED

    # Integrity-gated load: when the session cache has a recorded sha for this
    # snapshot, pass it to snapshots.load so a corrupted / partially-written /
    # evicted-and-rewritten-under-same-key snapshot file is detected and
    # discarded rather than driving a misleading diff hint.  When no sha is on
    # record (legacy snapshots from before set_snapshot_sha was wired, or a
    # predictive snapshot whose sha sidecar was not persisted), we fall back to
    # the unverified load — the diff against the snapshot bytes is still the
    # best evidence we have, and a missing sha must not silently suppress all
    # legacy diff hints.
    try:
        expected_sha = session.get_snapshot_sha(session_id, file_path)
    except Exception:
        expected_sha = None
    snapshot_bytes = snapshots.load(
        session_id, file_path, expected_sha=expected_sha,
    )
    if snapshot_bytes is None:
        return None

    # Decode defensively: snapshots are stored as raw bytes so an arbitrary
    # binary file (or one with mixed encodings) does not crash the diff.
    snapshot_text = snapshot_bytes.decode("utf-8", errors="replace")
    if snapshot_text == current_text:
        return None

    fname = _sanitize_hint_path(Path(file_path).name)

    snapshot_lines = snapshot_text.splitlines(keepends=True)
    current_lines = current_text.splitlines(keepends=True)

    # Adaptive context sizing: count the actual `+`/`-` changes (excluding the
    # `+++`/`---` header) using a zero-context probe, then re-emit with the
    # right width.  Tiny edits get 1 line of context; everything else gets the
    # standard 2.  Two unified_diff calls, but the n=0 pass is tiny by design.
    probe_lines = list(difflib.unified_diff(
        snapshot_lines, current_lines, n=0, lineterm="",
    ))
    added_count = sum(
        1 for line in probe_lines
        if line[:1] == "+" and not line.startswith("+++")
    )
    removed_count = sum(
        1 for line in probe_lines
        if line[:1] == "-" and not line.startswith("---")
    )
    changed_count = added_count + removed_count
    hunk_lines = [line for line in probe_lines if line.startswith("@@")]
    hunk_count = len(hunk_lines)

    # Micro-diff collapse: a single hunk with fewer than 3 changed lines total
    # produces 6+ overhead lines (---, +++, @@, context) for one substantive
    # change.  Emit a one-liner summary instead.  The full-file token saving
    # check still applies so very small files are not emitted.
    _MICRO_DIFF_MAX_CHANGED = 3
    if hunk_count == 1 and 0 < changed_count < _MICRO_DIFF_MAX_CHANGED:
        # Parse the first (only) hunk header to extract the line number.
        # Unified diff hunk header format: "@@ -a,b +c,d @@ optional text"
        # We use the destination line number (c) for the "@ L<n>" annotation.
        import re
        hunk_match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", hunk_lines[0])
        line_num = int(hunk_match.group(1)) if hunk_match else 0

        if added_count > 0 and removed_count > 0:
            summary_change = f"±{changed_count} lines"
        elif added_count > 0:
            n_word = "line" if added_count == 1 else "lines"
            summary_change = f"+{added_count} {n_word}"
        else:
            n_word = "line" if removed_count == 1 else "lines"
            summary_change = f"-{removed_count} {n_word}"

        line_str = f" @ L{line_num}" if line_num else ""
        full_tokens_micro = _est_tokens_from_chars(len(current_text))
        # A one-liner hint costs ~8 tokens; saving is full-read minus that.
        tokens_saved_micro = max(0, full_tokens_micro - 8)
        if tokens_saved_micro < _min_tokens_saved:
            return None
        prose_micro = ReadHint(
            _apply_terse(f"`{fname}` changed: {summary_change}{line_str}"),
            tokens_saved_micro,
        )
        return _emit_json_sidecar(
            prose_micro, "diff_since_last_read",
            file=_sanitize_hint_path(file_path),
            added=added_count, removed=removed_count,
            line=line_num or None, wasted=tokens_saved_micro,
        )

    n_context = (
        _DIFF_TINY_CONTEXT_LINES
        if 0 < changed_count <= _DIFF_TINY_CHANGE_THRESHOLD
        else _DIFF_CONTEXT_LINES
    )

    # NOTE: snapshot_lines/current_lines carry their own trailing "\n"
    # (splitlines(keepends=True) above), so the control rows must use the
    # default lineterm="\n" to pair with the "".join below. Forcing
    # lineterm="" here glues the ---/+++/@@ headers onto one line.
    diff_iter = difflib.unified_diff(
        snapshot_lines,
        current_lines,
        fromfile=f"{fname} (previously read)",
        tofile=f"{fname} (current)",
        n=n_context,
    )
    diff_text = "".join(diff_iter)
    if not diff_text:
        # difflib returns nothing when the sequences are identical at the line
        # level (e.g. only trailing-newline differences).  Treat that as "no
        # change worth reporting" — re-read is the safe path.
        return None

    diff_bytes = len(diff_text.encode("utf-8"))
    if diff_bytes > DIFF_HINT_MAX_BYTES:
        _LOG.debug(
            "build_diff_hint: diff too large (%d bytes > %d cap) for %s — suppressing",
            diff_bytes, DIFF_HINT_MAX_BYTES, fname,
        )
        return None

    # Compute the saving: full-file re-read tokens minus diff tokens.  Both
    # the hint preamble and the fenced diff text cost tokens, so the saving
    # we record is the net — what the agent actually avoids in conversation.
    full_tokens = _est_tokens_from_chars(len(current_text))
    diff_tokens = _est_tokens_from_chars(diff_bytes)
    tokens_saved = max(0, full_tokens - diff_tokens)
    if tokens_saved < _min_tokens_saved:
        _LOG.debug(
            "build_diff_hint: saving too small (%d < %d) for %s — suppressing",
            tokens_saved, _min_tokens_saved, fname,
        )
        return None

    prose_diff = ReadHint(
        _apply_terse(f"`{fname}` changed:\n")
        + f"```diff\n{diff_text}\n```\n",
        tokens_saved,
    )
    return _emit_json_sidecar(
        prose_diff, "diff_since_last_read",
        file=_sanitize_hint_path(file_path),
        added=added_count, removed=removed_count,
        wasted=tokens_saved,
    )


# ---------------------------------------------------------------------------
# Symbol-level stale-edit hint
# ---------------------------------------------------------------------------


def build_symbol_stale_hint(
    *,
    session_id: str,
    file_path: str,
    symbol_name: str,
    current_start_line: int,
    current_end_line: int,
    current_text: str,
) -> str | None:
    """Return a warning string when *symbol_name* changed since the agent last read it.

    Called by ``token-goat read`` and ``token-goat symbol`` just before emitting
    the symbol body.  Checks whether the agent's prior snapshot of *file_path*
    contains the same body as *current_text*; if not, returns a one-line warning
    that the agent can prepend to the output.

    Returns ``None`` when:

    * the agent has not read the file this session (no snapshot)
    * the symbol body is unchanged
    * ``session_id`` is absent (CLI invocations without ``--session-id``)
    * any error occurs (fail-soft)

    The return value is intentionally a plain ``str`` (not ``ReadHint``) because
    the caller emits it to stdout before the symbol body — it is not injected
    into ``additionalContext`` and tokens_saved does not apply.
    """
    if not session_id or not file_path or not symbol_name:
        return None
    try:
        changed = snapshots.symbol_changed_since_read(
            session_id=session_id,
            file_path=file_path,
            symbol_name=symbol_name,
            current_start_line=current_start_line,
            current_end_line=current_end_line,
            current_text=current_text,
        )
        if not changed:
            return None
        safe_file = _sanitize_hint_path(file_path)
        safe_sym = _sanitize_hint_path(symbol_name)
        return (
            f"⚠ {safe_file}::{safe_sym} was modified since your last read. "
            "The function body may have changed."
        )
    except Exception:
        _LOG.debug(
            "build_symbol_stale_hint: unexpected error for %r::%r",
            file_path, symbol_name,
        )
        return None


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Session-cache helpers
# ---------------------------------------------------------------------------


def _require_cache(
    session_id: str,
    cache: session.SessionCache | None,
) -> session.SessionCache | None:
    """Load the session cache if not already loaded; return None when unavailable.

    Consolidates the four-line guard that every inner hint function repeats::

        if cache is None:
            cache = load_session_safe(session_id)
        if cache is None or cache.unavailable:
            return None

    into a single call.  Callers that need additional post-load checks (e.g.
    :func:`build_glob_dedup_hint` which also tests
    ``cache.is_glob_history_empty()``) call this first, then apply their own
    guard on the returned cache.
    """
    if cache is None:
        cache = load_session_safe(session_id)
    if cache is None or cache.unavailable:
        return None
    return cache


# Configurable bash_dedup_min_bytes
# ---------------------------------------------------------------------------


def _get_config_threshold(attr: str, fallback: int) -> int:
    """Load a hints config threshold by attribute name, returning fallback on error.

    Reduces duplication for bash_dedup_min_bytes, grep_dedup_min_matches, etc.
    Never raises; fail-soft returns the fallback default.
    """
    try:
        from . import config as _config
        return getattr(_config.load().hints, attr)
    except Exception:
        return fallback


def _get_bash_dedup_min_bytes() -> int:
    """Return the configured bash dedup minimum bytes threshold.

    Reads from hints.bash_dedup_min_bytes in config (or TOKEN_GOAT_BASH_DEDUP_MIN_BYTES
    env var). Defaults to _BASH_DEDUP_MIN_BYTES (200) on any error or when config
    is unavailable. Never raises; fail-soft returns the fallback default.
    """
    return _get_config_threshold("bash_dedup_min_bytes", _BASH_DEDUP_MIN_BYTES)


def _get_grep_dedup_min_matches() -> int:
    """Return the configured grep dedup minimum match count threshold.

    Reads from hints.grep_dedup_min_matches in config (or TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES
    env var). Defaults to _GREP_DEDUP_MIN_RESULT_COUNT (5) on any error or when config
    is unavailable. Never raises; fail-soft returns the fallback default.
    """
    return _get_config_threshold("grep_dedup_min_matches", _GREP_DEDUP_MIN_RESULT_COUNT)


# Curator pass: suppress dedup hints when the agent ignores them
# ---------------------------------------------------------------------------


def _curator_should_emit(cache: session.SessionCache) -> bool:
    """Return False when the session's hint-acceptance rate is too low.

    The curator suppresses future dedup hints once:
    - ``cache.hints_emitted >= cfg.min_samples`` (enough data to decide), AND
    - ``cache.hints_ignored / cache.hints_emitted * 100 < cfg.threshold_pct``
      (the agent accepted fewer than threshold_pct% of hinted suppressions).

    Returns True (emit the hint) in all other cases, including when the config
    feature is disabled or the cache is unavailable.  Never raises.
    """
    try:
        from . import config as _config

        cfg = _config.load().curator
        if not cfg.enabled:
            return True

        emitted = cache.hints_emitted
        if emitted < cfg.min_samples:
            return True  # Not enough data yet — keep emitting

        ignored = cache.hints_ignored
        acceptance_pct = (emitted - ignored) / emitted * 100
        if acceptance_pct < cfg.threshold_pct:
            _LOG.debug(
                "_curator_should_emit: suppressing dedup hints (acceptance=%.1f%% < %d%%, "
                "emitted=%d, ignored=%d)",
                acceptance_pct, cfg.threshold_pct, emitted, ignored,
            )
            return False
        return True
    except Exception:
        return True


def _record_hint_emitted(
    cache: session.SessionCache,
    norm_path: str,
) -> None:
    """Increment hints_emitted and add *norm_path* to the recent_hints ring buffer.

    Called immediately after a dedup hint is about to be returned (non-None).
    Mutates *cache* in place; caller is responsible for persisting via save().
    The ring buffer is capped at _RECENT_HINTS_MAX entries (oldest dropped first).
    """
    import time as _time

    cache.hints_emitted += 1
    cache.recent_hints.append((norm_path, _time.time()))
    if len(cache.recent_hints) > _RECENT_HINTS_MAX:
        cache.recent_hints = cache.recent_hints[-_RECENT_HINTS_MAX:]
    cache._invalidate_json_cache()


def _record_dedup_hint_emitted(
    cache: session.SessionCache,
    hint_key: str,
    hint_type: str,
    fp_key: str,
) -> None:
    """Consolidate the triple recording call for dedup hints.

    Combines _record_hint_emitted, cache.record_hint_emitted, and
    cache.mark_hint_seen into a single call to eliminate repeated patterns.
    """
    _record_hint_emitted(cache, hint_key)
    cache.record_hint_emitted(hint_type)
    cache.mark_hint_seen(fp_key)


def _record_bash_dedup_emitted(
    cache: session.SessionCache,
    dedup_key: str,
) -> None:
    """Record that a bash dedup was emitted to avoid re-emitting the same output.

    Adds *dedup_key* to the bash_dedup_emitted_ids set and invalidates the JSON cache.
    When the set exceeds BASH_DEDUP_IDS_MAX, the oldest entries (by sort order,
    which approximates insertion order for hex-prefixed IDs) are dropped to keep
    the set bounded even if bash_history entries have been evicted.
    """
    cache.bash_dedup_emitted_ids.add(dedup_key)
    if len(cache.bash_dedup_emitted_ids) > session.BASH_DEDUP_IDS_MAX:
        # Sets are unordered; keep a deterministic tail slice from the sorted
        # representation.  Dropping half the set at once amortises the rebuild.
        _sorted = sorted(cache.bash_dedup_emitted_ids)
        cache.bash_dedup_emitted_ids = set(_sorted[session.BASH_HISTORY_MAX:])
    cache._invalidate_json_cache()


# ---------------------------------------------------------------------------
# Hint budget check — hard cap on total hints per session
# ---------------------------------------------------------------------------

_HINT_KIND_DEDUP: Final[str] = "dedup"
_HINT_KIND_STRUCTURED: Final[str] = "structured"
_HINT_KIND_INDEX_ONLY: Final[str] = "index_only"


def _hint_budget_check(cache: session.SessionCache, hint_kind: str) -> bool:
    """Return False (suppress) when the session has exhausted the budget for *hint_kind*.

    Three independent budgets:
    - ``"dedup"``       — checked against ``cache.hints_emitted`` vs ``max_per_session``
    - ``"structured"``  — checked against ``cache.structured_hints_emitted`` vs ``max_structured_per_session``
    - ``"index_only"``  — checked against ``cache.index_only_hints_emitted`` vs ``max_index_only_per_session``

    Returns True (emit) when the config feature is disabled, the kind is unknown,
    or the relevant counter is below the cap.  Never raises.
    """
    try:
        from . import config as _config

        cfg = _config.load().hint_budget
        if not cfg.enabled:
            return True

        if hint_kind == _HINT_KIND_DEDUP:
            over = cache.hints_emitted >= cfg.max_per_session
        elif hint_kind == _HINT_KIND_STRUCTURED:
            over = cache.structured_hints_emitted >= cfg.max_structured_per_session
        elif hint_kind == _HINT_KIND_INDEX_ONLY:
            over = cache.index_only_hints_emitted >= cfg.max_index_only_per_session
        else:
            return True  # unknown kind — don't suppress

        if over:
            _LOG.debug(
                "_hint_budget_check: suppressing %s hint (budget exhausted for kind=%s)",
                hint_kind,
                hint_kind,
            )
            return False
        return True
    except Exception:
        return True


def _record_non_dedup_hint_emitted(
    cache: session.SessionCache,
    counter_attr: str,
    hint_type: str,
) -> None:
    """Record emission of a non-dedup hint by incrementing counter and recording type.

    Generic helper for structured_file and index_only_file hints that follow the
    same pattern: increment a per-cache counter, record the hint type, and invalidate
    the JSON cache.

    Args:
        cache:          Session cache to mutate.
        counter_attr:   Name of the counter attribute on cache (e.g., 'structured_hints_emitted').
        hint_type:      Hint type string for record_hint_emitted (e.g., 'structured_file').
    """
    setattr(cache, counter_attr, getattr(cache, counter_attr) + 1)
    cache.record_hint_emitted(hint_type)
    cache._invalidate_json_cache()


def _record_structured_hint_emitted(cache: session.SessionCache) -> None:
    """Increment structured_hints_emitted counter on *cache*. Never raises."""
    _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file")


def _record_index_only_hint_emitted(cache: session.SessionCache) -> None:
    """Increment index_only_hints_emitted counter on *cache*. Never raises."""
    _record_non_dedup_hint_emitted(cache, "index_only_hints_emitted", "index_only_file")


# ---------------------------------------------------------------------------
# Per-tool recall-command emission tracking
# ---------------------------------------------------------------------------
# After the agent has seen the verbose "`token-goat <tool>-output ID`" recall
# pointer twice in the same session it has learned the convention; subsequent
# hints drop the full command and emit only the bare ID.  Saves ~11-15 tokens
# per emission across dozens of hints per session.  Counter is persisted via
# the session cache's hints_seen set using sentinel keys per tool — avoids a
# session schema change while surviving the multi-process hook lifecycle
# (each hook invocation is a fresh process; only the on-disk session JSON
# carries state across invocations).

_RECALL_HINT_SUPPRESS_AFTER: Final[int] = 2


def _should_emit_recall_command(
    cache: session.SessionCache | None,
    tool: str,
) -> bool:
    """Return True when the verbose recall command should be included for *tool*.

    Increments the per-tool emission counter (stored as sentinel fingerprints in
    ``cache.hints_seen``) and returns False once the counter exceeds
    :data:`_RECALL_HINT_SUPPRESS_AFTER` — at that point the caller should emit
    the bare output ID instead of the full ``token-goat <tool>-output <id>``
    string.

    Returns True when *cache* is None (no session cache available — emit the
    helpful pointer rather than silently drop it).
    """
    if cache is None:
        return True
    for n in range(1, _RECALL_HINT_SUPPRESS_AFTER + 1):
        key = f"recall_count:{tool}:{n}"
        if not cache.has_hint_fingerprint(key):
            cache.mark_hint_seen(key)
            return True
    return False


# ---------------------------------------------------------------------------
# Shared fail-soft wrapper for all dedup hint builders
# ---------------------------------------------------------------------------


def _record_dedup_stale(kind: str, detail: str) -> None:
    """Record a zero-savings stat row when a dedup hint is suppressed due to age.

    ``kind`` is ``"bash_dedup_stale"`` or ``"web_dedup_stale"``.  These rows
    pair with ``bash_dedup_hint`` / ``web_dedup_hint`` to make the bypass rate
    measurable: ``stale / (stale + hit)`` shows what fraction of cached
    entries were too old to suppress a re-run, which lets us tune the stale
    threshold.  Best-effort; any DB error is swallowed because telemetry
    must never break the hint pipeline (cf. fail-soft hooks contract).
    """
    import contextlib
    with contextlib.suppress(Exception):
        db.record_stat(
            None,
            kind,
            bytes_saved=0,
            tokens_saved=0,
            detail=detail[:64],
        )


def _check_dedup_preconditions(
    *,
    session_id: str,
    required_param: str | None,
    cache: session.SessionCache | None,
) -> bool:
    """Check common preconditions for all dedup builders. Return True if should proceed.

    All dedup builders (bash, grep, glob, web) share the same guards:
    1. Require session_id and a required parameter (command/pattern/url)
    2. When cache is available, check curator should emit
    3. When cache is available, check hint budget

    Args:
        session_id:      Session ID (required).
        required_param:  The required tool parameter (command/pattern/url). If falsy, return False.
        cache:           Session cache (optional; only checked if not None).

    Returns:
        True if all available preconditions pass; False if any fails (should suppress hint).
        Note: Returns True if session_id and required_param are valid, even if cache is None.
    """
    if not session_id or not required_param:
        return False

    # For dedup builders that have optional cache (bash, web), we only check
    # curator/budget if cache is not None. For those that always have cache
    # (grep, glob via _require_cache), the check still applies.
    if cache is not None:
        if not _curator_should_emit(cache):
            return False
        if not _hint_budget_check(cache, _HINT_KIND_DEDUP):
            return False

    return True


def _fp_already_seen(cache: session.SessionCache | None, fp_key: str, caller: str) -> bool:
    """Return True (and log) when *fp_key* is already in the session fingerprint set.

    Centralises the four-line guard that appears in every dedup/cache-hit hint builder:
    check the fingerprint, log a debug line, return None from the caller.  Usage::

        if _fp_already_seen(cache, fp_key, "build_bash_dedup_hint"):
            return None
    """
    if cache is not None and cache.has_hint_fingerprint(fp_key):
        _LOG.debug("%s: fingerprint key %s already seen; skipping construction", caller, fp_key)
        return True
    return False


def _check_entry_staleness(
    entry: object,
    cache: session.SessionCache | None,
    log_label: str,
    stale_reason_key: str,
    detail: str = "",
) -> tuple[bool, float]:
    """Check if a cache entry is stale and record suppression. Return (is_stale, age).

    Used by bash, grep, glob, web dedup builders to consolidate the age/threshold check.
    When an entry is too old, logs and records a suppression stat.

    Args:
        entry:              The cache entry (must have ``.ts`` timestamp).
        cache:              Session cache (for stale threshold).
        log_label:          Label for the debug log, e.g. ``"build_bash_dedup_hint"``.
        stale_reason_key:   Key for recording suppression, e.g. ``"bash_dedup_stale"``.
        detail:             Optional detail string for the stale stat (e.g. the command or URL).

    Returns:
        Tuple of (is_stale: bool, age: float).  When is_stale is True, the entry
        is too old to use; age is the entry's age in seconds either way.
    """
    now = time.time()
    age = now - entry.ts  # type: ignore[attr-defined]  # entry typed as object; callers pass BashEntry/WebEntry/GrepEntry/GlobEntry which all have .ts
    stale_threshold = _session_stale_threshold(cache, now)
    if age > stale_threshold:
        _LOG.debug(
            "%s: entry stale (age=%.0fs > %.0fs); suppressing",
            log_label,
            age,
            stale_threshold,
        )
        _record_dedup_stale(stale_reason_key, detail)
        return True, age
    return False, age


def _check_dedup_min_threshold(
    value: int | None,
    min_fn: Callable[[], int],
    cache: session.SessionCache | None,
    suppression_key: str,
) -> bool:
    """Check if a value meets the dedup minimum threshold. Return True if it does NOT.

    When a cache entry's result count / byte size is below threshold, suppresses the hint
    and records the suppression in the cache. Used by bash, grep, glob, web builders.

    Args:
        value:              The value to check (result count or byte size).
        min_fn:             Callable that returns the minimum threshold.
        cache:              Session cache (records suppression).
        suppression_key:    Key for recording suppression, e.g. ``"bash_dedup_below_threshold"``.

    Returns:
        True if the value is below threshold or None (i.e., should suppress the hint).
    """
    if value is None or value < min_fn():
        if cache is not None:
            cache.record_hint_suppressed(suppression_key)
        return True
    return False


# ---------------------------------------------------------------------------
# Bash dedup hint
# ---------------------------------------------------------------------------


@_failsoft_hint
def build_bash_dedup_hint(
    *,
    session_id: str,
    command: str,
    cache: session.SessionCache | None = None,
    cwd: str | None = None,
) -> ReadHint | None:
    """Return a hint when *command* was run earlier in this session.

    The pre-Bash hook calls this before executing a Bash command.  When the
    same command has been run before and its output cached on disk, we suggest
    the agent retrieve the cached output via ``token-goat bash-output``
    instead of re-running — avoiding both the runtime cost and the duplicated
    output bytes in the conversation.

    *cwd* scopes the cache key to the current project so ``pytest tests/`` run
    in project A does not match a prior run from project B.

    Returns ``None`` (no hint) when:

    * no session_id is provided
    * the command has never been recorded
    * the previous output was too small to be worth deduplicating
    * the previous output is older than :data:`STALE_READ_AGE_SECONDS`
      (same staleness boundary used by the read-dedup path: above that
      window the model's context has likely scrolled past the old result)

    Never raises; the ``@_failsoft_hint`` decorator catches any unexpected
    exception and returns ``None`` (the pre-Bash path must stay fail-soft).
    """
    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=command,
        cache=cache,
    ):
        return None

    from . import bash_cache

    cmd_sha = bash_cache.command_hash(command, cwd)
    entry = session.lookup_bash_entry(session_id, cmd_sha, cache=cache)
    if entry is None:
        return None

    cmd_short = _format_bash_command_for_hint(command)
    is_stale, age = _check_entry_staleness(
        entry, cache, "build_bash_dedup_hint", "bash_dedup_stale",
        detail=cmd_short,
    )
    if is_stale:
        return None

    total_bytes = entry.stdout_bytes + entry.stderr_bytes
    if _check_dedup_min_threshold(
        total_bytes,
        _get_bash_dedup_min_bytes,
        cache,
        "bash_dedup_below_threshold",
    ):
        return None

    # Content-aware dedup: only emit hint if we've seen this exact output before.
    # When output_sha is set (new entries), check if we've already shown this
    # output content. When output_sha is empty (old sessions), fall back to
    # checking if we've shown this output_id.
    dedup_key = entry.output_sha or entry.output_id
    if dedup_key and dedup_key in (cache.bash_dedup_emitted_ids if cache else set()):
        # Already showed this output or its content earlier — suppress to avoid repetition.
        _LOG.debug(
            "build_bash_dedup_hint: dedup key %s already shown; suppressing",
            dedup_key[:8] if dedup_key else "?",
        )
        return None

    tokens_avoided = _est_tokens_from_chars(total_bytes)
    run_count = getattr(entry, "run_count", 1)
    from . import cache_common as _cc
    short_id = _cc.short_output_id(entry.output_id)

    # Two-phase dedup: check the fingerprint key BEFORE constructing expensive hint text.
    # We compute a lightweight key fingerprint based on command+run_count pattern to avoid
    # building the full hint text when it would be suppressed anyway by the content-hash
    # dedup in hooks_read.
    key_for_dedup = f"{cmd_sha}|{run_count}"
    fp_key = _hint_fingerprint(key_for_dedup, path="bash")
    if _fp_already_seen(cache, fp_key, "build_bash_dedup_hint"):
        return None

    # After the agent has seen the verbose recall pointer twice, drop the
    # full command string and emit just the bare ID — the agent has learned
    # the recall convention and the extra ~13 tokens per hint are noise.
    if _should_emit_recall_command(cache, "bash"):
        recall_cmd = f"token-goat bash-output {short_id}"
    else:
        recall_cmd = f"id={short_id}"

    # Front-load failure signal so the agent sees it immediately.
    # When the prefix carries the exit code, drop it from the body to avoid
    # repeating it twice.
    is_failed = entry.exit_code is not None and entry.exit_code != 0
    if is_failed:
        fail_prefix = f"FAILED (exit={entry.exit_code}): "
        exit_str = ""
    else:
        fail_prefix = ""
        exit_str = "" if entry.exit_code is None else f" x={entry.exit_code}"

    if total_bytes <= _BASH_DEDUP_LIGHT_MAX_BYTES:
        # For very small output, include outcome indicator for context
        outcome = " (empty)" if total_bytes == 0 else f" {total_bytes}B"
        hint_text = f"{fail_prefix}`{cmd_short}` cached ({int(age)}s{outcome}{exit_str}). `{recall_cmd}`"
        if cache is not None and dedup_key:
            _record_bash_dedup_emitted(cache, dedup_key)
        if cache is not None:
            _record_dedup_hint_emitted(cache, cmd_sha, "bash_dedup", fp_key)
        result = ReadHint(_apply_terse(hint_text), tokens_avoided)
        return _emit_json_sidecar(
            result, "bash_dedup", command=cmd_short, bytes_size=total_bytes, age_s=int(age), wasted=tokens_avoided,
        )

    grep_suffix = " (add --grep PATTERN to filter)" if total_bytes >= _BASH_DEDUP_GREP_SUGGEST_BYTES else ""

    if run_count >= 3:
        hint_text = (
            f"{fail_prefix}⚠ `{cmd_short}` ran {run_count}x — loop? "
            f"Cached: ({total_bytes:,}B{exit_str}): `{recall_cmd}`{grep_suffix}"
        )
    elif run_count == 2:
        hint_text = (
            f"{fail_prefix}`{cmd_short}` ran 2x — cached ({total_bytes:,}B{exit_str}, ~{tokens_avoided}t). "
            f"`{recall_cmd}`{grep_suffix}"
        )
    else:
        hint_text = (
            f"{fail_prefix}`{cmd_short}` ({int(age)}s): {total_bytes:,}B{exit_str} cached. "
            f"`{recall_cmd}`{grep_suffix}"
        )
    if cache is not None and dedup_key:
        _record_bash_dedup_emitted(cache, dedup_key)
    if cache is not None:
        _record_dedup_hint_emitted(cache, cmd_sha, "bash_dedup", fp_key)
    result = ReadHint(_apply_terse(hint_text), tokens_avoided)
    return _emit_json_sidecar(
        result, "bash_dedup", command=cmd_short, bytes_size=total_bytes, age_s=int(age), wasted=tokens_avoided,
    )


# Minimum output size before the bash dedup hint fires. Default 200 bytes (~50 tokens);
# a short hint costs ~12 tokens, netting ~38 tokens saved. Configurable via
# hints.bash_dedup_min_bytes or TOKEN_GOAT_BASH_DEDUP_MIN_BYTES env var.
# When below threshold, dedup hint is suppressed and the command re-runs.
_BASH_DEDUP_MIN_BYTES: int = 200  # fallback default; use _get_bash_dedup_min_bytes() at runtime
# Below this threshold use a compact one-liner hint to keep net savings positive.
_BASH_DEDUP_LIGHT_MAX_BYTES: int = 999
# At this size suggest --grep filtering; the output is large enough that loading
# it whole when only a snippet is needed wastes significant context.
_BASH_DEDUP_GREP_SUGGEST_BYTES: int = 5000

# Maximum length for a command string in a hint before it's truncated with ellipsis.
# Commands often contain long argument lists (e.g., test paths) that don't add
# clarity to the dedup hint; this cap ensures the hint stays focused on the
# subcommand and key args while staying within token budget.
_MAX_BASH_COMMAND_DISPLAY_LEN: int = 60


def _format_bash_command_for_hint(command: str) -> str:
    """Format a bash command for display in a dedup hint with intelligent truncation.

    - Sanitizes newlines/CRs (injection defence)
    - Extracts the main command/subcommand for clarity
    - Truncates long argument lists to stay concise
    - Shows enough context for the agent to understand what ran

    Examples:
        "pytest tests/auth/test_login.py::test_valid_password"
        -> "pytest tests/auth/test_login.py::test_valid…" (if too long)

        "find /srv/data -name '*.log' -type f -mtime +30"
        -> "find /srv/data -name '*.log'…"

        "uv run ruff check --fix src/"
        -> "uv run ruff check --fix src/"
    """
    # First sanitize for injection safety
    safe = _sanitize_hint_path(command)

    # If already short, return as-is
    if len(safe) <= _MAX_BASH_COMMAND_DISPLAY_LEN:
        return safe

    # For longer commands, greedily include parts until we hit the limit
    parts = safe.split()
    if not parts:
        return safe

    result_parts: list[str] = []
    current_len = 0

    for part in parts:
        # Calculate length if we add this part (accounting for space separator)
        sep = " " if result_parts else ""
        candidate_len = current_len + len(sep) + len(part)

        # Stop if adding this part would exceed limit
        if candidate_len > _MAX_BASH_COMMAND_DISPLAY_LEN:
            break

        result_parts.append(part)
        current_len = candidate_len

    result = " ".join(result_parts)

    # Append ellipsis if truncated
    if result != safe:
        result = result + "…"

    return result


def _get_first_line_preview(output_text: str, max_len: int = 60) -> str | None:
    """Extract the first non-empty line from bash output for display in a hint.

    Returns None if the output is empty or contains only whitespace.
    Truncates lines longer than *max_len* with an ellipsis.
    Sanitizes for injection safety.
    """
    if not output_text:
        return None
    for line in output_text.splitlines():
        stripped = line.strip()
        if stripped:
            # Sanitize the line for hint-text injection safety
            safe = _sanitize_hint_path(stripped)
            # Truncate if needed
            if len(safe) > max_len:
                safe = safe[:max_len] + "…"
            return safe
    return None


# ---------------------------------------------------------------------------
# Cross-session bash cache-hit hint
# ---------------------------------------------------------------------------


@_failsoft_hint
def build_bash_cache_hit_hint(
    *,
    session_id: str,
    command: str,
    cache: session.SessionCache | None = None,
    cwd: str | None = None,
) -> ReadHint | None:
    """Return a hint when *command* has a cached output from a prior session.

    Complements :func:`build_bash_dedup_hint` which fires when the same command
    has been run *in the current session*.  This function fires when the command
    has never been run in the current session but there is still output cached
    on disk from a previous session — saving the runtime cost and the duplicated
    bytes in the conversation.

    *cwd* scopes the lookup to the current project so ``pytest tests/`` in
    project A does not return a hit from project B's prior session.

    Returns ``None`` (no hint) when:

    * no session_id or command is provided
    * the command is already recorded in the current session (dedup path handles it)
    * no on-disk cached entry exists for this command
    * the cached output is too small to be worth the hint overhead
    * the cached output is older than :data:`STALE_READ_AGE_SECONDS`
    """
    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=command,
        cache=cache,
    ):
        return None

    from . import bash_cache

    cmd_sha = bash_cache.command_hash(command, cwd)

    # If the current session already has this command, the dedup hint handles it.
    current_entry = session.lookup_bash_entry(session_id, cmd_sha, cache=cache)
    if current_entry is not None:
        return None

    # Look for a cached output from any prior session.
    meta = bash_cache.find_cached_for_command(command, cwd)
    if meta is None:
        return None

    # Apply the same minimum-size guard used by the dedup hint.
    total_bytes = meta.stdout_bytes + meta.stderr_bytes
    if _check_dedup_min_threshold(
        total_bytes,
        _get_bash_dedup_min_bytes,
        cache,
        "bash_cache_hit_below_threshold",
    ):
        return None

    # Apply staleness guard: a very old cache entry is likely stale.
    import time as _time

    now = _time.time()
    age = now - meta.ts
    stale_threshold = _session_stale_threshold(cache, now) if cache is not None else STALE_READ_AGE_SECONDS
    # Immutable git commands (git show <full-sha>) never go stale — bypass staleness check.
    if age > stale_threshold and not bash_cache.is_git_immutable_command(command):
        _LOG.debug(
            "build_bash_cache_hit_hint: prior-session cache entry for %s is %.0fs old (threshold=%.0fs); skipping",
            sanitize_log_str(command, max_len=100), age, stale_threshold,
        )
        if cache is not None:
            cache.record_hint_suppressed("bash_cache_hit_stale")
        return None

    # Fingerprint dedup: emit only once per command per session.
    fp_key = _hint_fingerprint(cmd_sha, path="bash_prior")
    if _fp_already_seen(cache, fp_key, "build_bash_cache_hit_hint"):
        return None

    if cache is not None:
        cache.mark_hint_seen(fp_key)

    from . import cache_common as _cc

    tokens_avoided = _est_tokens_from_chars(total_bytes)
    exit_str = "" if meta.exit_code is None else f" x={meta.exit_code}"
    short_id = _cc.short_output_id(meta.output_id)
    age_str = f"{int(age // 3600)}h" if age >= 3600 else f"{int(age // 60)}m"

    # Try to load the first line of output for a preview hint
    preview_text = ""
    try:
        from . import bash_cache as _bc
        body = _bc.load_output(meta.output_id)
        if body:
            first_line = _get_first_line_preview(body)
            if first_line:
                # Escape single quotes for display
                preview_text = f" ↪'{first_line}'"
    except Exception:
        pass

    result = ReadHint(
        _apply_terse(
            f"Command cached {age_str} ago: {total_bytes:,}B{exit_str}, ~{tokens_avoided}t. "
            f"Use `token-goat bash-output {short_id}` to read without re-running.{preview_text}"
        ),
        tokens_avoided,
    )
    return _emit_json_sidecar(
        result, "bash_cache_hit", command=command, bytes_size=total_bytes, age_s=int(age), wasted=tokens_avoided,
    )


# ---------------------------------------------------------------------------
# Grep dedup hint
# ---------------------------------------------------------------------------

# Minimum result_count before the grep dedup hint fires.  At 5 results ×
# 120 B ≈ 600 B ≈ 150 tokens saved; the hint itself costs ~12 tokens, netting
# ~138 tokens saved. Configurable via hints.grep_dedup_min_matches or
# TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES env var.
_GREP_DEDUP_MIN_RESULT_COUNT: int = 5  # fallback default; use _get_grep_dedup_min_matches() at runtime

# Rough bytes-per-Grep-result estimate.  A real grep result line is one line of
# match + path + line-number context, typically 80-160 bytes.  120 is a
# reasonable mid-point used solely for the tokens-avoided estimate that the
# hint quotes back to the agent.
_GREP_AVG_BYTES_PER_RESULT: int = 120

# Cross-session grep dedup: minimum number of sessions in which the pattern
# must have been seen before the cross-session hint fires.
_GREP_CROSS_SESSION_MIN_COUNT: int = 3

# Cross-session grep dedup: maximum age (seconds) of last_ts for the cross-
# session hint to fire.  Patterns last seen >1 hour ago are considered stale
# (the agent is probably exploring fresh code), so the hint is suppressed.
_GREP_CROSS_SESSION_STALE_SECS: float = 3600.0


@_failsoft_hint
def build_grep_dedup_hint(
    *,
    session_id: str,
    pattern: str,
    path: str | None,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when the same Grep pattern was just run in this session.

    Mirrors :func:`build_bash_dedup_hint` for the Grep tool surface: a repeat
    invocation with the same ``(pattern, path)`` pair within
    :data:`STALE_READ_AGE_SECONDS` produces a "this just ran, reuse the
    prior response" advisory.  The hint quotes the previous result count so
    the agent knows whether the re-run is materially different from the
    prior one.

    Returns ``None`` (no hint) when:

    * no session_id is provided
    * no prior Grep with the same pattern has been recorded
    * the previous result was too small to be worth deduplicating
      (:data:`_GREP_DEDUP_MIN_RESULT_COUNT` matches)
    * the previous run is older than :data:`STALE_READ_AGE_SECONDS`

    Never raises; the ``@_failsoft_hint`` decorator catches any unexpected
    exception and returns ``None`` (the pre-Grep path must stay fail-soft).
    """
    cache = _require_cache(session_id, cache)
    if cache is None:
        return None

    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=pattern,
        cache=cache,
    ):
        return None

    now = time.time()
    # Cross-session hint: fires even when the session has no prior greps yet,
    # because the pattern may be a frequent exploratory query run at session
    # start (where cache.greps is still empty).  Check this before the
    # intra-session guard so new sessions benefit from cross-session dedup.
    if _curator_should_emit(cache) and _hint_budget_check(cache, _HINT_KIND_DEDUP):
        # Two-phase dedup: check fingerprint BEFORE calling the cross-session hint builder.
        key_for_xsess = f"{pattern}|xsess"
        fp_key_xsess = _hint_fingerprint(key_for_xsess, path="grep_xsess")
        if not cache.has_hint_fingerprint(fp_key_xsess):
            cross_session_hint = _build_grep_cross_session_hint(pattern, now)
            if cross_session_hint is not None:
                _record_dedup_hint_emitted(cache, f"grep_xsess:{pattern}", "grep_dedup", fp_key_xsess)
                return cross_session_hint

    # Intra-session scan: requires at least one prior grep in this session.
    if not cache.greps:
        return None

    grep_stale_threshold = _session_stale_threshold(cache, now)
    for entry in reversed(cache.greps):
        if entry.pattern != pattern:
            continue
        if entry.path != path:
            continue
        age = now - entry.ts
        if age > grep_stale_threshold:
            # Older entries are even older — short-circuit the scan.
            return None
        if _check_dedup_min_threshold(
            entry.result_count,
            _get_grep_dedup_min_matches,
            cache,
            "grep_dedup_below_threshold",
        ):
            return None

        # Two-phase dedup: check the fingerprint key BEFORE constructing expensive hint text.
        # Key is pattern+path to avoid rebuilding identical hints.
        key_for_dedup = f"{pattern}|{path or ''}"
        fp_key = _hint_fingerprint(key_for_dedup, path="grep")
        if _fp_already_seen(cache, fp_key, "build_grep_dedup_hint"):
            return None

        # Estimate the bytes that would land in context if the agent re-runs.
        bytes_avoided = (entry.result_count or 0) * _GREP_AVG_BYTES_PER_RESULT
        tokens_avoided = _est_tokens_from_chars(bytes_avoided)
        pattern_short = _truncate_pattern_display(pattern)
        path_str = f" in `{_sanitize_hint_path(path)}`" if path else ""
        # Curator: record emission keyed on the pattern (grep has no file path).
        _record_dedup_hint_emitted(cache, f"grep:{pattern}", "grep_dedup", fp_key)
        result = ReadHint(
            _apply_terse(
                f"Grep `{pattern_short}`{path_str} ({int(age)}s): {entry.result_count} matches, ~{tokens_avoided}t."
            ),
            tokens_avoided,
        )
        return _emit_json_sidecar(
            result, "grep_dedup", pattern=pattern, path=path, result_count=entry.result_count, age_s=int(age), wasted=tokens_avoided,
        )
    return None


def _build_grep_cross_session_hint(pattern: str, now: float) -> ReadHint | None:
    """Query global.db for cross-session grep frequency and emit a hint if warranted.

    Returns a hint when:

    * The pattern has been seen in >= ``_GREP_CROSS_SESSION_MIN_COUNT`` sessions.
    * The most recent occurrence (``last_ts``) is within
      ``_GREP_CROSS_SESSION_STALE_SECS`` (pattern is a recent recurrence, not an
      ancient one).

    The hint nudges the agent toward ``token-goat semantic`` for results already
    indexed.  Returns ``None`` on any DB error (fail-soft: never block the grep
    path).
    """
    pattern_hash = hashlib.sha1(
        pattern.encode("utf-8", errors="replace")
    ).hexdigest()
    try:
        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count, last_ts FROM grep_patterns WHERE pattern_hash = ?",
                (pattern_hash,),
            ).fetchone()
    except Exception:
        return None
    if row is None:
        return None
    count = int(row[0])
    last_ts = float(row[1])
    if count < _GREP_CROSS_SESSION_MIN_COUNT:
        return None
    age = now - last_ts
    if age > _GREP_CROSS_SESSION_STALE_SECS:
        return None
    # Pattern is frequent and recent — nudge toward semantic search.
    pattern_short = _truncate_pattern_display(pattern)
    return ReadHint(
        _apply_terse(
            f"Grep `{pattern_short}` is a frequent pattern ({count} sessions). "
            f"Try: token-goat semantic '{pattern_short}'"
        ),
        0,
    )


# ---------------------------------------------------------------------------
# Glob dedup hint
# ---------------------------------------------------------------------------

# Minimum result count before the glob dedup hint fires.  A glob returning
# fewer than this many paths is cheap enough to re-run that the hint preamble
# would approach the saving.  5 paths × ~60 B each ≈ 300 B ≈ 75 tokens;
# the hint itself costs ~25 tokens, so this threshold gives a clear positive margin.
_GLOB_DEDUP_MIN_RESULT_COUNT: int = 5

# Rough bytes-per-Glob-result estimate.  Each result is a file path — typically
# 40–80 bytes on real projects.  60 is a reasonable mid-point used solely for
# the tokens-avoided estimate quoted in the hint.
_GLOB_AVG_BYTES_PER_RESULT: int = 60


@_failsoft_hint
def build_glob_dedup_hint(
    *,
    session_id: str,
    pattern: str,
    path: str | None,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when the same Glob pattern was already run in this session.

    Mirrors :func:`build_grep_dedup_hint` for the Glob tool surface: a repeat
    invocation with the same ``(pattern, path)`` pair within
    :data:`STALE_READ_AGE_SECONDS` produces a "this just ran, reuse the prior
    response" advisory.  The hint quotes the previous result count so the agent
    knows whether a re-run would produce different results.

    Returns ``None`` (no hint) when:

    * no session_id is provided
    * no prior Glob with the same pattern has been recorded
    * the previous result count was below :data:`_GLOB_DEDUP_MIN_RESULT_COUNT`
    * the previous run is older than :data:`STALE_READ_AGE_SECONDS`

    Never raises; the ``@_failsoft_hint`` decorator catches any unexpected
    exception and returns ``None`` (the pre-Glob path must stay fail-soft).
    """
    cache = _require_cache(session_id, cache)
    if cache is None or cache.is_glob_history_empty():
        return None

    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=pattern,
        cache=cache,
    ):
        return None

    entry = session.lookup_glob_entry(session_id, pattern, path, cache=cache)
    if entry is None:
        return None

    is_stale, age = _check_entry_staleness(
        entry, cache, "build_glob_dedup_hint", "glob_dedup_stale",
        detail=_sanitize_hint_path(pattern),
    )
    if is_stale:
        return None

    if _check_dedup_min_threshold(
        entry.result_count,
        lambda: _GLOB_DEDUP_MIN_RESULT_COUNT,
        cache,
        "glob_dedup_below_threshold",
    ):
        return None

    # Two-phase dedup: check the fingerprint key BEFORE constructing expensive hint text.
    # Key is pattern+path to avoid rebuilding identical hints when the dedup fingerprint
    # would suppress them anyway in hooks_read.
    key_for_dedup = f"{pattern}|{path or ''}"
    fp_key = _hint_fingerprint(key_for_dedup, path="glob")
    if _fp_already_seen(cache, fp_key, "build_glob_dedup_hint"):
        return None

    bytes_avoided = (entry.result_count or 0) * _GLOB_AVG_BYTES_PER_RESULT
    tokens_avoided = _est_tokens_from_chars(bytes_avoided)
    pattern_short = _sanitize_hint_path(pattern)
    path_str = f" in `{_sanitize_hint_path(path)}`" if path else ""
    # Curator: record emission keyed on the pattern (glob has no file path).
    _record_dedup_hint_emitted(cache, f"glob:{pattern}", "glob_dedup", fp_key)
    result = ReadHint(
        _apply_terse(
            f"Glob `{pattern_short}`{path_str} ({int(age)}s): {entry.result_count} results, ~{tokens_avoided}t."
        ),
        tokens_avoided,
    )
    return _emit_json_sidecar(
        result, "glob_dedup", pattern=pattern, path=path, result_count=entry.result_count, age_s=int(age), wasted=tokens_avoided,
    )


# ---------------------------------------------------------------------------
# WebFetch dedup hint
# ---------------------------------------------------------------------------



@_failsoft_hint
def build_web_dedup_hint(
    *,
    session_id: str,
    url: str,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when *url* was fetched earlier in this session.

    The pre-WebFetch hook calls this before fetching.  When the same URL has
    been fetched before and its body cached on disk, we suggest the agent
    retrieve the cached body via ``token-goat web-output`` instead of
    re-fetching — avoiding the network round-trip and the duplicated bytes
    in the conversation.

    Returns ``None`` (no hint) when:

    * no session_id or url is provided
    * the URL has never been recorded
    * the previous body was too small to be worth deduplicating
    * the previous fetch is older than :data:`STALE_READ_AGE_SECONDS`
      (above that window the page content is likely to have changed and a
      re-fetch is legitimate)

    Never raises; the ``@_failsoft_hint`` decorator catches any unexpected
    exception and returns ``None`` (the pre-WebFetch path must stay fail-soft).
    """
    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=url,
        cache=cache,
    ):
        return None

    from . import web_cache

    url_sha = web_cache.url_hash(url)
    entry = session.lookup_web_entry(session_id, url_sha, cache=cache)
    if entry is None:
        return None

    is_stale, age = _check_entry_staleness(
        entry, cache, "build_web_dedup_hint", "web_dedup_stale",
        detail=_sanitize_hint_path(url),
    )
    if is_stale:
        return None

    cfg = config.load()
    if _check_dedup_min_threshold(
        entry.body_bytes,
        lambda: cfg.hints.web_dedup_min_bytes,
        cache,
        "web_dedup_below_threshold",
    ):
        return None

    # Two-phase dedup: check the fingerprint key BEFORE constructing expensive hint text.
    # Key is url_sha to avoid rebuilding identical hints.
    fp_key = _hint_fingerprint(url_sha, path="web")
    if _fp_already_seen(cache, fp_key, "build_web_dedup_hint"):
        return None

    tokens_avoided = _est_tokens_from_chars(entry.body_bytes)
    status_str = (
        f" status={entry.status_code}" if entry.status_code is not None else ""
    )
    # Format content-type for display (e.g., "html" from "text/html")
    content_type_str = ""
    content_type = getattr(entry, "content_type", None)
    if content_type:
        # Extract the main type: "text/html" → "html", "application/json" → "json"
        ct_parts = content_type.split("/")
        content_type_str = f" {ct_parts[1]}" if len(ct_parts) >= 2 else f" {content_type}"

    from . import cache_common as _cc

    # Show the --grep PATTERN recall hint only once per session.  On the first
    # large-body WebFetch dedup the agent learns the pattern; subsequent fetches
    # only show the id so the hint stays short.
    _WEB_RECALL_HINT_KEY = "web_output_grep_hint_shown"
    _grep_hint_shown = (
        cache is not None and cache.has_hint_fingerprint(_WEB_RECALL_HINT_KEY)
    )
    if entry.body_bytes >= _BASH_DEDUP_GREP_SUGGEST_BYTES and not _grep_hint_shown:
        grep_suffix = " (add --grep PATTERN to filter)"
        # Mark the pattern as shown so subsequent fetches omit it.
        if cache is not None:
            cache.mark_hint_seen(_WEB_RECALL_HINT_KEY)
    else:
        grep_suffix = ""

    # Curator: record emission keyed on url_sha (web dedup is URL-keyed, not file-keyed).
    if cache is not None:
        _record_dedup_hint_emitted(cache, f"web:{url_sha}", "web_dedup", fp_key)
    # After the agent has seen the verbose recall pointer twice, drop the
    # full command string and emit just the bare ID — see _should_emit_recall_command.
    short_id = _cc.short_output_id(entry.output_id)
    if _should_emit_recall_command(cache, "web"):
        recall_str = f"`token-goat web-output {short_id}`"
    else:
        recall_str = f"id={short_id}"
    result = ReadHint(
        _apply_terse(
            f"URL ({int(age)}s): {entry.body_bytes:,}B{status_str}{content_type_str}, ~{tokens_avoided}t. "
            f"{recall_str}{grep_suffix}"
        ),
        tokens_avoided,
    )
    return _emit_json_sidecar(
        result, "web_dedup", url=url, bytes_size=entry.body_bytes, age_s=int(age), wasted=tokens_avoided,
    )


# ---------------------------------------------------------------------------
# Cross-session web cache-hit hint
# ---------------------------------------------------------------------------


@_failsoft_hint
def build_web_cache_hit_hint(
    *,
    session_id: str,
    url: str,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when *url* has a cached body on disk from a prior session.

    Complements :func:`build_web_dedup_hint` which fires when the same URL has
    been fetched *in the current session*.  This function fires when the URL
    has never been fetched in the current session but there is still a body
    cached on disk from a previous session — saving the network round-trip and
    the duplicated bytes in the conversation.

    Returns ``None`` (no hint) when:

    * no session_id or url is provided
    * the URL is already recorded in the current session (dedup path handles it)
    * no on-disk cached entry exists for this URL
    * the cached body is too small to be worth the hint overhead
    * the cached body is older than :data:`STALE_READ_AGE_SECONDS` (the page
      likely changed; a fresh fetch is the right call)
    """
    if not _check_dedup_preconditions(
        session_id=session_id,
        required_param=url,
        cache=cache,
    ):
        return None

    from . import web_cache

    url_sha = web_cache.url_hash(url)

    # If the current session already has this URL, the dedup hint handles it.
    current_entry = session.lookup_web_entry(session_id, url_sha, cache=cache)
    if current_entry is not None:
        return None

    # Look for a cached body from any prior session.
    meta = web_cache.find_cached_for_url(url)
    if meta is None:
        return None

    # Apply the same minimum-size guard used by the dedup hint.
    cfg = config.load()
    if _check_dedup_min_threshold(
        meta.body_bytes,
        lambda: cfg.hints.web_dedup_min_bytes,
        cache,
        "web_cache_hit_below_threshold",
    ):
        return None

    # Apply staleness guard: a very old cache entry is likely stale.
    import time as _time

    now = _time.time()
    age = now - meta.ts
    stale_threshold = _session_stale_threshold(cache, now) if cache is not None else STALE_READ_AGE_SECONDS
    if age > stale_threshold:
        _LOG.debug(
            "build_web_cache_hit_hint: prior-session cache entry for %s is %.0fs old (threshold=%.0fs); skipping",
            sanitize_log_str(url, max_len=100), age, stale_threshold,
        )
        if cache is not None:
            cache.record_hint_suppressed("web_cache_hit_stale")
        return None

    # Fingerprint dedup: emit only once per URL per session.
    fp_key = _hint_fingerprint(url_sha, path="web_prior")
    if _fp_already_seen(cache, fp_key, "build_web_cache_hit_hint"):
        return None

    if cache is not None:
        cache.mark_hint_seen(fp_key)

    from . import cache_common as _cc

    tokens_avoided = _est_tokens_from_chars(meta.body_bytes)
    status_str = (
        f" status={meta.status_code}" if meta.status_code is not None else ""
    )
    # Format content-type for display (e.g., "html" from "text/html")
    content_type_str = ""
    content_type = getattr(meta, "content_type", None)
    if content_type:
        # Extract the main type: "text/html" → "html", "application/json" → "json"
        ct_parts = content_type.split("/")
        content_type_str = f" {ct_parts[1]}" if len(ct_parts) >= 2 else f" {content_type}"

    short_id = _cc.short_output_id(meta.output_id)
    age_str = f"{int(age // 3600)}h" if age >= 3600 else f"{int(age // 60)}m"
    result = ReadHint(
        _apply_terse(
            f"URL cached {age_str} ago: {meta.body_bytes:,}B{status_str}{content_type_str}, ~{tokens_avoided}t. "
            f"Use `token-goat web-output {short_id}` to read without re-fetching."
        ),
        tokens_avoided,
    )
    return _emit_json_sidecar(
        result, "web_cache_hit", url=url, bytes_size=meta.body_bytes, age_s=int(age), wasted=tokens_avoided,
    )


# ---------------------------------------------------------------------------
# Content-unchanged short-circuit hint
# ---------------------------------------------------------------------------

# Maximum age of a snapshot before the "unchanged since your edit" hint is
# suppressed.  Beyond this the file may have been modified externally (another
# process, a git operation) in a way our snapshot would miss.  10 minutes is
# conservative; the common case is a same-turn re-read seconds after an edit.
_UNCHANGED_MAX_AGE_SECONDS: int = 10 * 60

# Minimum file size (bytes) before the unchanged hint fires.  For tiny files
# the full-file read is cheap and the hint text itself approaches the saving.
_UNCHANGED_MIN_BYTES: int = 800


@_failsoft_hint
def build_unchanged_file_hint(
    *,
    session_id: str,
    file_path: str,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when a file's on-disk content matches its session snapshot.

    Fires when ALL of the following hold:

    * A snapshot exists for ``(session_id, file_path)`` — written by
      ``post_read._try_snapshot`` after the agent last read the file.
    * The file was edited in this session after it was last read
      (``entry.last_edit_ts > entry.last_read_ts``).
    * The current on-disk SHA matches the snapshot SHA — meaning no external
      change has landed since the agent's edit.
    * The snapshot is fresh enough (< :data:`_UNCHANGED_MAX_AGE_SECONDS`).

    When all conditions hold the agent's edit IS the current content.  The file
    it is about to re-read contains exactly the bytes it already wrote, which
    are still visible in context from the Edit/Write tool result.  A full Read
    would duplicate those bytes for zero new information.

    Returns a :class:`ReadHint` (tokens_saved > 0) or ``None`` (no hint).
    Never raises; the ``@_failsoft_hint`` decorator catches any I/O error so
    the hint is suppressed silently.
    """
    return _build_unchanged_file_hint_inner(
        session_id=session_id, file_path=file_path, cache=cache,
    )


def _build_unchanged_file_hint_inner(
    *,
    session_id: str,
    file_path: str,
    cache: session.SessionCache | None,
) -> ReadHint | None:
    """Inner implementation; may raise."""
    import hashlib as _hashlib
    import time as _time

    if not session_id or not file_path:
        return None

    cache = _require_cache(session_id, cache)
    if cache is None:
        return None

    # Require that the file was read AND subsequently edited this session.
    # Without that edit signal there is nothing new to short-circuit; the
    # normal diff/session-hint path already handles the pure-re-read case.
    entry = session.get_file_entry(session_id, file_path, cache=cache)
    if entry is None or entry.last_edit_ts <= entry.last_read_ts:
        return None

    # Snapshot must exist — it was written right after the last Read.
    stored_sha = session.get_snapshot_sha(session_id, file_path, cache=cache)
    if not stored_sha:
        return None

    # Snapshot age check: if the snapshot is stale the file may have changed
    # via an external process our hook wouldn't have caught.
    snapshot_age = _time.time() - entry.last_read_ts
    if snapshot_age > _UNCHANGED_MAX_AGE_SECONDS:
        _LOG.debug(
            "build_unchanged_file_hint: snapshot too old (%.0fs > %ds) for %s",
            snapshot_age, _UNCHANGED_MAX_AGE_SECONDS, _sanitize_hint_path(file_path),
        )
        return None

    # Read the current file and compute its SHA.  Limit to MAX_SNAPSHOT_BYTES
    # so we never spend time hashing a huge file — if it's over the cap the
    # snapshot wouldn't exist anyway (store() rejects oversized files).
    try:
        with Path(file_path).open("rb") as fh:
            current_bytes = fh.read(snapshots.MAX_SNAPSHOT_BYTES + 1)
    except OSError as exc:
        _LOG.debug(
            "build_unchanged_file_hint: cannot read %s: %s",
            _sanitize_hint_path(file_path), exc,
        )
        return None

    if len(current_bytes) > snapshots.MAX_SNAPSHOT_BYTES:
        # File grown past snapshot cap — can't compare.
        return None

    if len(current_bytes) < _UNCHANGED_MIN_BYTES:
        return None

    # For files larger than the truncation threshold, the stored snapshot holds
    # only the first SNAPSHOT_TRUNCATE_BYTES (plus a sentinel).  Recompute the
    # comparison SHA over the same truncated prefix so the "unchanged" check
    # stays consistent: both sides hash the same number of bytes.  For smaller
    # files (below the threshold) nothing changes — we hash the full content.
    compare_bytes = current_bytes
    if len(current_bytes) > snapshots.SNAPSHOT_TRUNCATE_BYTES:
        compare_bytes = current_bytes[:snapshots.SNAPSHOT_TRUNCATE_BYTES]
    current_sha = _hashlib.sha256(compare_bytes).hexdigest()
    if current_sha != stored_sha:
        # Content changed on disk since the snapshot — let diff-hint handle it.
        return None

    # SHA matches: the file is byte-for-byte identical to when it was last read.
    # The agent's subsequent edit(s) are what produced the current content, and
    # that content is already visible in the Edit/Write tool results in context.
    fname = _sanitize_hint_path(Path(file_path).name)
    safe_path = _sanitize_hint_path(file_path)
    age_s = int(snapshot_age)
    full_tokens = _est_tokens_from_chars(len(current_bytes))
    sha_prefix = current_sha[:8]

    prose = ReadHint(
        _apply_terse(
            f"`{fname}` unchanged since your edit ({age_s}s ago, sha:{sha_prefix}, ~{full_tokens}t). "
            f"Edit result still in context — for symbols: `token-goat read \"{safe_path}::Symbol\"`."
        ),
        full_tokens,
    )
    # Opt-in machine-readable sidecar; no-op when [hints] json_sidecar is off.
    cache.record_hint_emitted("unchanged_file")
    return _emit_json_sidecar(
        prose, "unchanged_since_edit",
        file=safe_path, age_s=age_s, wasted=full_tokens, sha=sha_prefix,
    )


# ---------------------------------------------------------------------------
# Index-only file hint
# ---------------------------------------------------------------------------
# Machine-generated files that are never intended to be read in full by a
# human or an LLM.  Reading them burns thousands of tokens with zero benefit.
#
# Two categories:
#   lockfiles  — dependency lockfiles produced by package managers
#   bundles    — minified JS/CSS, source maps, TypeScript build info
#
# The hint fires (a) for files whose basename matches a known lockfile name OR
# whose suffix matches a known bundle extension, (b) only when the file is
# larger than _INDEX_ONLY_MIN_BYTES (avoids false positives on toy projects),
# and (c) only when the caller did NOT supply BOTH offset and limit (surgical
# intent guard — someone reading a 20-line slice of uv.lock knows what they
# want).

# Exact basenames that are always lockfiles, matched case-insensitively.
_INDEX_ONLY_LOCKFILE_NAMES: frozenset[str] = frozenset({
    "uv.lock",
    "poetry.lock",
    "cargo.lock",
    "gemfile.lock",
    "composer.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "bun.lockb",
})

# Suffixes that indicate machine-generated bundles / artefacts.
_INDEX_ONLY_BUNDLE_SUFFIXES: frozenset[str] = frozenset({
    ".min.js",
    ".min.css",
    ".bundle.js",
    ".bundle.css",
    ".tsbuildinfo",
    ".map",
})

# Minimum file size (bytes) before the index-only hint fires.
# Below this the file is either tiny or a human-written file that happens to
# share a name (e.g. an empty stub Cargo.lock in a test fixture).
_INDEX_ONLY_MIN_BYTES: int = 5_000


def _is_index_only_file(basename_lower: str) -> str | None:
    """Return the category ('lockfile', 'bundle', 'map', 'buildinfo') or None.

    Accepts the lowercased basename of the file.  Returns a short category
    string used to pick the appropriate hint wording, or ``None`` when the
    file does not match any index-only pattern.
    """
    if basename_lower in _INDEX_ONLY_LOCKFILE_NAMES:
        return "lockfile"
    # Multi-part suffix matching (.min.js, .bundle.css, …) — check for known
    # two-part suffixes by scanning _INDEX_ONLY_BUNDLE_SUFFIXES.
    for suffix in _INDEX_ONLY_BUNDLE_SUFFIXES:
        if basename_lower.endswith(suffix):
            if suffix == ".map":
                return "map"
            if suffix == ".tsbuildinfo":
                return "buildinfo"
            return "bundle"
    return None


@_failsoft_hint
def build_index_only_file_hint(
    *,
    file_path: str,
    offset: object | None,
    limit: object | None,
) -> ReadHint | None:
    """Return a hint when Read targets a machine-generated index-only file.

    Fires when:
    - The basename matches a known lockfile OR the extension matches a known
      bundle/artefact pattern AND
    - The file is larger than ``_INDEX_ONLY_MIN_BYTES`` AND
    - The caller did NOT specify BOTH offset AND limit (surgical intent guard).

    Returns ``None`` (no hint) for small files, unrecognised names, or when
    the caller already scoped the read with offset+limit.  Never raises; the
    ``@_failsoft_hint`` decorator catches any exception silently.
    """
    return _build_index_only_file_hint_inner(
        file_path=file_path, offset=offset, limit=limit,
    )


def _build_index_only_file_hint_inner(
    *,
    file_path: str,
    offset: object | None,
    limit: object | None,
) -> ReadHint | None:
    """Inner implementation; may raise."""
    # Surgical guard: both offset AND limit present means intentional scoped read.
    has_offset = offset is not None and isinstance(offset, int) and offset >= 0
    has_limit = limit is not None and isinstance(limit, int) and limit > 0
    if has_offset and has_limit:
        return None

    path = Path(file_path)
    basename_lower = path.name.lower()

    category = _is_index_only_file(basename_lower)
    if category is None:
        return None

    # Cheap size check — skip hint for tiny files.
    try:
        file_size = path.stat().st_size
    except OSError:
        return None

    if file_size < _INDEX_ONLY_MIN_BYTES:
        return None

    size_kb = file_size // 1024
    fname = _sanitize_hint_path(path.name)

    if category == "lockfile":
        # Identify the package manager and give a concrete alternative command.
        if basename_lower == "uv.lock":
            alt = f'`uv pip list` or `jq \'.package[] | select(.name=="NAME")\' {fname}`'
        elif basename_lower == "package-lock.json":
            alt = f'`npm ls` or `jq \'.dependencies.NAME\' {fname}`'
        elif basename_lower in ("yarn.lock", "pnpm-lock.yaml"):
            alt = "`yarn list` / `pnpm list` instead"
        elif basename_lower == "cargo.lock":
            alt = '`cargo tree` or `grep -A5 \'name = "NAME"\' ' + fname + "`"
        elif basename_lower == "gemfile.lock":
            alt = "`bundle list` instead"
        elif basename_lower == "poetry.lock":
            alt = '`poetry show` or `grep -A5 \'name = "NAME"\' ' + fname + "`"
        else:
            alt = f"`grep NAME {fname}` instead"
        return ReadHint(
            _apply_terse(
                f"`{fname}` (lockfile, {size_kb}KB). "
                f"Use {alt} — do not read {size_kb}K lines of pinned dep hashes."
            ),
            0,
        )

    if category == "map":
        return ReadHint(
            _apply_terse(
                f"`{fname}` (source map, {size_kb}KB). "
                f"Use browser devtools or source-map-cli; do not read in full."
            ),
            0,
        )

    if category == "buildinfo":
        return ReadHint(
            _apply_terse(
                f"`{fname}` (TS incremental build cache, {size_kb}KB). "
                f"Machine-only artefact — do not read."
            ),
            0,
        )

    # category == "bundle"
    # Try to suggest the source equivalent.
    if ".min.js" in basename_lower or ".bundle.js" in basename_lower:
        src_hint = "Read the source in `src/` instead."
    elif ".min.css" in basename_lower or ".bundle.css" in basename_lower:
        src_hint = "Read the source SCSS/CSS in `src/` instead."
    else:
        src_hint = "Read the original source instead."
    return ReadHint(
        _apply_terse(
            f"`{fname}` (minified bundle, {size_kb}KB). "
            f"{src_hint}"
        ),
        0,
    )


# ---------------------------------------------------------------------------
# Structured-file hint
# ---------------------------------------------------------------------------

# File extensions considered structured data files.  These fall into three
# flavours that each get their own hint wording:
#   - tabular  (.csv, .tsv, .jsonl, .ndjson): row-slice suggestion
#   - document (.json): key-path or jq suggestion
#   - log      (.log): tail/head suggestion
_STRUCTURED_EXT_TABULAR: frozenset[str] = frozenset({".csv", ".tsv", ".jsonl", ".ndjson"})
_STRUCTURED_EXT_JSON: frozenset[str] = frozenset({".json"})
_STRUCTURED_EXT_LOG: frozenset[str] = frozenset({".log"})
# Large XML / YAML / TOML / lock files benefit from surgical reads too.
# These are typically config or dependency trees where a section read is
# far cheaper than a full-file read.
_STRUCTURED_EXT_XML: frozenset[str] = frozenset({".xml", ".plist", ".csproj", ".vbproj", ".fsproj", ".props", ".targets"})
_STRUCTURED_EXT_YAML: frozenset[str] = frozenset({".yaml", ".yml"})
_STRUCTURED_EXT_TOML: frozenset[str] = frozenset({".toml"})
_STRUCTURED_EXT_LOCK: frozenset[str] = frozenset({".lock", ".lockb"})

# New file types with surgical-read hints.
# CSS / SCSS / Sass — suggest token-goat symbol / section for rule lookup.
_STRUCTURED_EXT_CSS: frozenset[str] = frozenset({".css", ".scss", ".sass"})
# SQL — suggest token-goat symbol for table / procedure names.
_STRUCTURED_EXT_SQL: frozenset[str] = frozenset({".sql"})
# GraphQL — suggest token-goat symbol for type / query names.
_STRUCTURED_EXT_GRAPHQL: frozenset[str] = frozenset({".graphql", ".gql"})
# Protocol Buffers — suggest token-goat symbol for message / service names.
_STRUCTURED_EXT_PROTO: frozenset[str] = frozenset({".proto"})

# Basenames (lowercased) that are env-variable files — matched by name, not extension.
_STRUCTURED_BASENAME_ENV: frozenset[str] = frozenset({
    ".env",
    ".env.example",
    ".env.local",
    ".env.test",
    ".env.production",
    ".env.staging",
    ".env.development",
    ".env.defaults",
})
# Basenames (lowercased) that are Makefiles — matched by name, not extension.
_STRUCTURED_BASENAME_MAKEFILE: frozenset[str] = frozenset({
    "makefile",
    "gnumakefile",
    "bsdmakefile",
})

# Minimum size in bytes before the structured-file hint fires.  Below this the
# file is cheap to read whole and the hint would approach the saving it advertises.
_STRUCTURED_FILE_MIN_BYTES: int = 50_000

# Per-category minimum sizes for new file types that are valuable to hint even
# when the file is smaller than the global _STRUCTURED_FILE_MIN_BYTES threshold.
# These are set lower because even medium-sized files of these types benefit from
# surgical reads (e.g. a 3 KB GraphQL schema with 20 types).
_STRUCTURED_CSS_MIN_BYTES: int = 10_000   # 10 KB — CSS can be large even when "small"
_STRUCTURED_SQL_MIN_BYTES: int = 5_000    # 5 KB — any multi-table schema benefits
_STRUCTURED_GRAPHQL_MIN_BYTES: int = 2_000  # 2 KB — schemas with a few types
_STRUCTURED_PROTO_MIN_BYTES: int = 2_000    # 2 KB — proto with a few messages
_STRUCTURED_ENV_MIN_BYTES: int = 500        # 500 B — any non-trivial .env benefits
_STRUCTURED_MAKEFILE_MIN_BYTES: int = 1_000  # 1 KB — any Makefile with targets

# Maximum bytes to read when counting newlines for the row estimate.
# 32 KB is enough for a tight estimate at a cheap I/O cost.
_STRUCTURED_NEWLINE_PROBE_BYTES: int = 32_768


def _estimate_row_count(path: Path, file_size: int) -> int:
    """Estimate rows/lines in a structured file from a 32 KB probe.

    Reads the first _STRUCTURED_NEWLINE_PROBE_BYTES, counts newlines, and
    extrapolates to the full file size.  Fast and cheap for the pre-read hot
    path.  Returns a non-negative integer; never raises.
    """
    try:
        with path.open("rb") as fh:
            probe = fh.read(_STRUCTURED_NEWLINE_PROBE_BYTES)
        if not probe:
            return 0
        probe_lines = probe.count(b"\n")
        if len(probe) < _STRUCTURED_NEWLINE_PROBE_BYTES:
            # Whole file fit in the probe — exact count.
            return probe_lines
        # Extrapolate: lines_per_byte × full_size.
        return max(0, int(probe_lines * file_size / len(probe)))
    except OSError:
        return 0


def _extract_csv_headers(path: Path) -> str | None:
    """Extract CSV header line from first 4 KB.

    Returns comma-separated column names, or None on error/empty file.
    Never raises.
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            first_line = fh.readline().strip()
        if first_line:
            # Truncate to fit in hint; max 60 chars for column list.
            if len(first_line) > 60:
                first_line = first_line[:57] + "..."
            return first_line
        return None
    except (OSError, UnicodeDecodeError):
        return None


def _extract_json_array_schema(path: Path) -> str | None:
    """Extract schema from first object in a JSON array.

    Reads up to 4 KB, tries to locate first array element, returns schema
    as comma-separated key types. Returns None on error or non-array.
    Never raises.
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            chunk = fh.read(4096)
        if not chunk:
            return None

        # Lightweight: look for [ and then first { to skip to object.
        bracket_idx = chunk.find("[")
        if bracket_idx == -1:
            return None
        brace_idx = chunk.find("{", bracket_idx)
        if brace_idx == -1:
            return None

        # Try to extract a complete object by finding matching }.
        # Start from the { and find the closing }.
        obj_start = brace_idx
        depth = 0
        in_string = False
        escape = False
        for i, c in enumerate(chunk[obj_start:], obj_start):
            if escape:
                escape = False
                continue
            if c == "\\":
                escape = True
                continue
            if c == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    obj_str = chunk[obj_start : i + 1]
                    break
        else:
            return None

        # Parse the extracted object and build schema.
        obj = json.loads(obj_str)
        if not isinstance(obj, dict):
            return None

        schema_parts = []
        for key in list(obj.keys())[:5]:  # Limit to first 5 keys.
            val = obj[key]
            if isinstance(val, bool):
                type_name = "bool"
            elif isinstance(val, int):
                type_name = "int"
            elif isinstance(val, float):
                type_name = "float"
            elif isinstance(val, str):
                type_name = "str"
            elif isinstance(val, list):
                type_name = "list"
            elif isinstance(val, dict):
                type_name = "dict"
            elif val is None:
                type_name = "null"
            else:
                type_name = "?"
            schema_parts.append(f"{key}: {type_name}")

        if schema_parts:
            schema_str = ", ".join(schema_parts)
            # Truncate if too long.
            if len(schema_str) > 60:
                schema_str = schema_str[:57] + "..."
            return schema_str
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None


def _extract_ndjson_first_line_schema(path: Path) -> str | None:
    """Extract schema from first line of NDJSON/JSONL file.

    Reads first line, parses as JSON, returns schema as comma-separated
    key types. Returns None on error or non-object first line.
    Never raises.
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            first_line = fh.readline().strip()
        if not first_line:
            return None

        obj = json.loads(first_line)
        if not isinstance(obj, dict):
            return None

        schema_parts = []
        for key in list(obj.keys())[:5]:  # Limit to first 5 keys.
            val = obj[key]
            if isinstance(val, bool):
                type_name = "bool"
            elif isinstance(val, int):
                type_name = "int"
            elif isinstance(val, float):
                type_name = "float"
            elif isinstance(val, str):
                type_name = "str"
            elif isinstance(val, list):
                type_name = "list"
            elif isinstance(val, dict):
                type_name = "dict"
            elif val is None:
                type_name = "null"
            else:
                type_name = "?"
            schema_parts.append(f"{key}: {type_name}")

        if schema_parts:
            schema_str = ", ".join(schema_parts)
            # Truncate if too long.
            if len(schema_str) > 60:
                schema_str = schema_str[:57] + "..."
            return schema_str
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None


def _lookup_top_indexed_symbol(file_path: str) -> tuple[str, str] | None:
    """Return ``(rel_path, top_symbol_name)`` for *file_path* from the index, or None.

    Resolves the owning project by walking up from the file's own directory (no
    ``cwd`` needed), computes the project-relative path, and runs the *same*
    single indexed-symbols query the large-file read hint uses
    (:func:`_get_indexed_symbols_and_line_count`).  Returns the first indexed
    symbol — ordered by line, i.e. the top of the file.  Both the relative path
    and the symbol name are sanitised for safe hint interpolation: the path via
    :func:`_sanitize_hint_path` (newline/CR strip) and the symbol additionally
    via :func:`_sanitize_hint_symbol` (double-quote neutralisation).

    Used to replace literal ``::Placeholder`` tokens (``::table_name``,
    ``::TypeName`` …) in structured-file hints with a concrete, runnable symbol
    name when the index has one.

    Returns ``None`` when the path is not absolute, no project is found, the file
    is not under the project root, or the file has no indexed symbols.  Cheap:
    one ``find_project`` walk plus one DB ``SELECT``.  Never raises.
    """
    try:
        abs_path = Path(file_path)
        if not abs_path.is_absolute():
            return None
        project = find_project(abs_path.parent)
        if project is None:
            return None
        try:
            rel = abs_path.relative_to(project.root).as_posix()
        except ValueError:
            return None
        symbols, _lines, _exact = _get_indexed_symbols_and_line_count(rel, project.hash)
        if not symbols:
            return None
        return _sanitize_hint_path(rel), _sanitize_hint_symbol(symbols[0]["name"])
    except Exception:
        return None


def _structured_read_or_outline(
    top: tuple[str, str] | None,
    safe_path: str,
    one_label: str,
    list_label: str,
    *,
    fallback_cmd: str = "outline",
) -> str:
    """Build the surgical-command clause for a structured-file hint.

    When *top* names a real indexed symbol, suggest a concrete
    ``token-goat read "<rel>::<symbol>"`` without the outline fallback,
    since the agent can see the resolved symbol.
    Otherwise fall back to a command that works without an index so the agent
    never receives an un-actionable ``::Placeholder`` token it cannot run.

    *fallback_cmd* selects that no-symbol fallback. ``"outline"`` (the default)
    suits types whose parsers map to indexed symbols. ``"section"`` suits raw-text
    types such as CSS and SQL, whose parsers commonly yield *no* indexed symbols:
    ``outline`` would then print the misleading "No indexed top-level symbols
    found, run ``token-goat index --full``" — even though the index is fine —
    whereas ``token-goat section`` operates on the raw text and degrades
    gracefully (it lists the available headings when the placeholder misses).
    """
    if top is not None:
        rel, sym = top
        return f"use `token-goat read \"{rel}::{sym}\"` for {one_label}"
    if fallback_cmd == "section":
        return (
            f"use `token-goat section \"{safe_path}::<heading>\"` to read {list_label} by name"
        )
    return f"use `token-goat outline \"{safe_path}\"` to list {list_label}, then read one"


@_failsoft_hint
def build_structured_file_hint(
    *,
    file_path: str,
    offset: object | None,
    limit: object | None,
) -> ReadHint | None:
    """Return a hint when Read targets a large structured data file.

    Fires when:
    - The extension is one of the recognised structured types AND
    - The file is larger than _STRUCTURED_FILE_MIN_BYTES AND
    - The caller did NOT already specify both offset AND limit (surgical intent).

    Returns ``None`` (no hint) for small files, non-structured extensions,
    or when the caller already uses offset/limit.  Never raises; the
    ``@_failsoft_hint`` decorator catches any exception silently.
    """
    return _build_structured_file_hint_inner(
        file_path=file_path, offset=offset, limit=limit,
    )


def _build_structured_file_hint_inner(
    *,
    file_path: str,
    offset: object | None,
    limit: object | None,
) -> ReadHint | None:
    """Inner implementation; may raise."""
    # If the caller already scoped the read with both offset AND limit, they are
    # reading surgically — do not nag them.
    has_offset = offset is not None and isinstance(offset, int) and offset >= 0
    has_limit = limit is not None and isinstance(limit, int) and limit > 0
    if has_offset and has_limit:
        return None

    path = Path(file_path)
    ext = path.suffix.lower()
    basename_lower = path.name.lower()

    is_tabular = ext in _STRUCTURED_EXT_TABULAR
    is_json = ext in _STRUCTURED_EXT_JSON
    is_log = ext in _STRUCTURED_EXT_LOG
    is_xml = ext in _STRUCTURED_EXT_XML
    is_yaml = ext in _STRUCTURED_EXT_YAML
    is_toml = ext in _STRUCTURED_EXT_TOML
    is_lock = ext in _STRUCTURED_EXT_LOCK
    # New file types matched by extension or basename.
    is_css = ext in _STRUCTURED_EXT_CSS
    is_sql = ext in _STRUCTURED_EXT_SQL
    is_graphql = ext in _STRUCTURED_EXT_GRAPHQL
    is_proto = ext in _STRUCTURED_EXT_PROTO
    is_env = basename_lower in _STRUCTURED_BASENAME_ENV
    is_makefile = basename_lower in _STRUCTURED_BASENAME_MAKEFILE

    if not (
        is_tabular or is_json or is_log or is_xml or is_yaml or is_toml or is_lock
        or is_css or is_sql or is_graphql or is_proto or is_env or is_makefile
    ):
        return None

    # Cheap size check first — skip the row-count probe for small files.
    try:
        file_size = path.stat().st_size
    except OSError:
        return None

    # New file types use per-category thresholds that are lower than the global
    # minimum, since even small files of these types benefit from surgical reads.
    if is_css and file_size < _STRUCTURED_CSS_MIN_BYTES:
        return None
    if is_sql and file_size < _STRUCTURED_SQL_MIN_BYTES:
        return None
    if is_graphql and file_size < _STRUCTURED_GRAPHQL_MIN_BYTES:
        return None
    if is_proto and file_size < _STRUCTURED_PROTO_MIN_BYTES:
        return None
    if is_env and file_size < _STRUCTURED_ENV_MIN_BYTES:
        return None
    if is_makefile and file_size < _STRUCTURED_MAKEFILE_MIN_BYTES:
        return None

    # For the legacy types, apply the original global threshold.
    if (
        is_tabular or is_json or is_log or is_xml or is_yaml or is_toml or is_lock
    ) and file_size < _STRUCTURED_FILE_MIN_BYTES:
        return None

    size_kb = file_size // 1024
    safe_path = _sanitize_hint_path(file_path)

    if is_tabular:
        row_count = _estimate_row_count(path, file_size)
        row_str = f"~{row_count:,}rows" if row_count > 0 else "many rows"
        hint_text = f"📊 large {ext} ({size_kb}KB, {row_str}) — "

        # Add schema for CSV.
        if ext == ".csv":
            headers = _extract_csv_headers(path)
            if headers:
                hint_text += f"columns: {headers}. "
        # Add schema for NDJSON/JSONL.
        elif ext in (".jsonl", ".ndjson"):
            schema = _extract_ndjson_first_line_schema(path)
            if schema:
                hint_text += f"schema: {schema}. "

        hint_text += f"use offset/limit or `token-goat section \"{safe_path}::row N\"`"
        return ReadHint(
            _apply_terse(hint_text),
            0,
        )

    if is_json:
        hint_text = f"📄 large json ({size_kb}KB) — "
        # Add schema for JSON arrays.
        schema = _extract_json_array_schema(path)
        if schema:
            hint_text += f"array schema: {schema}. "
        hint_text += f"use `token-goat read \"{safe_path}::Key.path\"` or jq"
        return ReadHint(
            _apply_terse(hint_text),
            0,
        )

    if is_log:
        row_count = _estimate_row_count(path, file_size)
        row_str = f"~{row_count:,}lines" if row_count > 0 else "many lines"
        return ReadHint(
            _apply_terse(
                f"📜 log ({size_kb}KB, {row_str}) — use tail/head or grep instead of full Read"
            ),
            0,
        )

    if is_xml:
        return ReadHint(
            _apply_terse(
                f"📋 large xml ({size_kb}KB) — "
                f"use `token-goat section \"{safe_path}::ElementName\"` or yq/xmllint"
            ),
            0,
        )

    if is_yaml:
        return ReadHint(
            _apply_terse(
                f"📋 large yaml ({size_kb}KB) — "
                f"use `token-goat section \"{safe_path}::key\"` or yq"
            ),
            0,
        )

    if is_toml:
        return ReadHint(
            _apply_terse(
                f"📋 large toml ({size_kb}KB) — "
                f"use `token-goat section \"{safe_path}::section\"` to read one block"
            ),
            0,
        )

    # New structured types (CSS/SQL/GraphQL/proto/env/Makefile) historically
    # emitted literal ``::Placeholder`` tokens the agent could not run.  Look up
    # the real top-of-file symbol from the index once (single DB query) so the
    # hint can name a concrete symbol; ``None`` triggers the ``outline`` fallback.
    # Skipped for the legacy ``is_lock`` tail below, which suggests grep instead.
    if is_css or is_sql or is_graphql or is_proto or is_env or is_makefile:
        top = _lookup_top_indexed_symbol(file_path)
    else:
        top = None

    if is_css:
        css_kind = ext.lstrip(".")  # "css", "scss", or "sass"
        clause = _structured_read_or_outline(
            top, safe_path, "a rule", "rules", fallback_cmd="section"
        )
        return ReadHint(_apply_terse(f"🎨 large {css_kind} ({size_kb}KB) — {clause}"), 0)

    if is_sql:
        clause = _structured_read_or_outline(
            top, safe_path, "one table/procedure", "tables/procedures", fallback_cmd="section"
        )
        return ReadHint(_apply_terse(f"🗄️ large sql ({size_kb}KB) — {clause}"), 0)

    if is_graphql:
        clause = _structured_read_or_outline(top, safe_path, "one type", "types")
        return ReadHint(_apply_terse(f"📐 large graphql ({size_kb}KB) — {clause}"), 0)

    if is_proto:
        clause = _structured_read_or_outline(
            top, safe_path, "one message/service", "messages/services"
        )
        return ReadHint(_apply_terse(f"📦 large proto ({size_kb}KB) — {clause}"), 0)

    if is_env:
        sz = size_kb if size_kb > 0 else "<1"
        if top is not None:
            rel, sym = top
            clause = (
                f"use `token-goat read \"{rel}::{sym}\"` for one variable "
                f"or grep/rg for the key you need"
            )
        else:
            clause = (
                f"use `token-goat outline \"{safe_path}\"` to list variables "
                f"or grep/rg for the key you need"
            )
        return ReadHint(_apply_terse(f"🔑 env file ({sz}KB) — {clause}"), 0)

    if is_makefile:
        row_count = _estimate_row_count(path, file_size)
        row_str = f"~{row_count:,}lines" if row_count > 0 else "many lines"
        sz = size_kb if size_kb > 0 else "<1"
        if top is not None:
            rel, sym = top
            clause = (
                f"use `token-goat read \"{rel}::{sym}\"` for one target "
                f"or `token-goat outline \"{safe_path}\"` to list all"
            )
        else:
            clause = f"use `token-goat outline \"{safe_path}\"` to list targets, then read one"
        return ReadHint(_apply_terse(f"⚙️ Makefile ({sz}KB, {row_str}) — {clause}"), 0)

    # is_lock
    row_count = _estimate_row_count(path, file_size)
    row_str = f"~{row_count:,}lines" if row_count > 0 else "many lines"
    return ReadHint(
        _apply_terse(
            f"🔒 lock file ({size_kb}KB, {row_str}) — "
            f"use grep/rg for specific package rather than full Read"
        ),
        0,
    )


# ---------------------------------------------------------------------------
# Test-file implementation-hint
# ---------------------------------------------------------------------------
# When reading a test file, check if the corresponding implementation file
# has been read in this session. If not, suggest reading it first.


def _resolve_impl_file_from_test(test_file_path: str, project_root: Path) -> Path | None:
    """Resolve the likely implementation file path from a test file path.

    Heuristic:
    - ``tests/test_foo.py`` → ``src/token_goat/foo.py``
    - ``tests/test_foo_bar.py`` → ``src/token_goat/foo_bar.py``

    Only returns the path if the file actually exists. Returns None if:
    - The path cannot be resolved
    - The resolved file does not exist on disk
    """
    try:
        test_path = Path(test_file_path)
        basename = test_path.name

        # Only handle test_* files
        if not basename.startswith("test_"):
            return None

        # Strip test_ prefix
        impl_basename = basename[5:]  # Remove 'test_' prefix
        if not impl_basename:
            return None

        # Try src/token_goat/impl_basename path
        impl_rel = project_root / "src" / "token_goat" / impl_basename
        if impl_rel.is_file():
            return impl_rel

        return None
    except (ValueError, OSError, AttributeError):
        return None


def build_test_file_hint(
    test_file_path: str,
    session_cache: session.SessionCache | None,
    project_root: Path,
) -> HintItem | None:
    """Return a HintItem when reading a test file with unread implementation.

    When the agent reads a test file (path contains "tests/" or filename starts with "test_"),
    checks if the corresponding implementation file has been read this session.
    If not, returns a LOW-priority hint suggesting to read the implementation first.

    Args:
        test_file_path: Absolute or relative path to the file being read.
        session_cache: SessionCache with read_files dict, or None to skip hint.
        project_root: Project root path for resolving impl file location.

    Returns:
        A HintItem with HINT_PRIORITY_LOW, or None when:
        - The file is not a test file
        - The implementation file doesn't exist
        - The implementation file has already been read this session
        - session_cache is None
    """
    if session_cache is None:
        return None

    # Check if this looks like a test file by checking the filename
    basename = Path(test_file_path).name
    test_path_lower = test_file_path.lower()
    is_test_file = (
        basename.lower().startswith("test_") or
        "tests/" in test_path_lower or
        "tests\\" in test_path_lower
    )

    if not is_test_file:
        return None

    # Try to resolve the implementation file
    impl_file = _resolve_impl_file_from_test(test_file_path, project_root)
    if impl_file is None:
        return None

    # Check if the impl file has been read this session
    # Import paths module to use the same normalization as the session cache
    from . import paths as _paths

    # Normalize the path the same way the session cache does
    impl_file_str = str(impl_file)
    normalized_impl_path = _paths.normalize_key(impl_file_str)

    files_dict = getattr(session_cache, "files", {})
    if isinstance(files_dict, dict) and normalized_impl_path in files_dict:
        # Already read; no hint needed
        return None

    # Build the hint
    fname = _sanitize_hint_path(Path(test_file_path).name)
    impl_name = _sanitize_hint_path(impl_file.name)
    impl_rel = _sanitize_hint_path(str(impl_file))

    text = (
        f"Reading test file `{fname}`. Implementation `{impl_name}` not yet read this session. "
        f"Consider reading `{impl_rel}` first for context."
    )

    return HintItem(text, HINT_PRIORITY_LOW)


def build_pinned_hint(
    session_cache: session.SessionCache | None,
    file_path: str,
    symbol_name: str,
) -> HintItem | None:
    """Return a CRITICAL hint when *symbol_name* in *file_path* matches a pinned spec.

    Called by the pre-Read hook when a symbol read is in progress.  When the
    ``<file>::<symbol>`` spec is in :attr:`SessionCache.pinned_symbols`, the
    hint fires at :data:`HINT_PRIORITY_CRITICAL` (1) so it always leads all
    other hints for that tool call.

    Returns ``None`` when there are no pinned symbols or the current read does
    not match any pin.

    Args:
        session_cache: A :class:`SessionCache` instance, or ``None`` (returns
            ``None`` immediately when absent).
        file_path: The path of the file being read (raw, as supplied to the tool).
        symbol_name: The symbol name extracted from the read request.  May be
            empty when the read is not symbol-targeted, in which case the
            function returns ``None`` immediately.
    """
    if session_cache is None or not symbol_name:
        return None

    pinned: list = getattr(session_cache, "pinned_symbols", [])
    if not pinned:
        return None

    from . import paths as _paths

    # Normalise the file path so comparisons are drive-letter and separator safe.
    norm_file = _paths.normalize_key(file_path)

    for spec in pinned:
        if "::" not in spec:
            continue
        spec_file, spec_sym = spec.split("::", 1)
        if _paths.normalize_key(spec_file) == norm_file and spec_sym == symbol_name:
            text = f"Pinned: `{spec}` — always prioritized."
            return HintItem(text, HINT_PRIORITY_CRITICAL)

    return None


# ---------------------------------------------------------------------------
# Stable-doc compact hints
# ---------------------------------------------------------------------------

# Minimum file size (bytes) before section-map / compact hints fire.
_DOC_COMPACT_MIN_BYTES = 5_000
# Minimum indexed section count before section-map hints fire.
_DOC_COMPACT_MIN_SECTIONS = 5
# Maximum heading entries shown inline in section-map / compact hints.
_DOC_COMPACT_SECTION_MAP_MAX = 10

# Sentinel prefix: hooks_read detects this to deny the read and serve the compact.
DOC_COMPACT_SERVE_SENTINEL = "\x00doc-compact-serve\x00"


def build_doc_compact_hint(
    file_path: str,
    cwd: str | None,
    *,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint for a large reference doc: serve compact or suggest one.

    Three outcomes:
    - Compact exists and is fresh: returns a ReadHint whose text begins with
      DOC_COMPACT_SERVE_SENTINEL.  hooks_read interprets this as a deny-redirect
      and serves the compact body instead of the full file.
    - Compact is stale: returns a short advisory letting the full read proceed.
    - No compact, large markdown with sections: returns a section-map hint
      suggesting token-goat compact-doc for future savings.
    - Compact disabled, file not markdown, or too small: returns None.

    Never raises.
    """
    try:
        return _build_doc_compact_hint_inner(file_path, cwd, cache=cache)
    except Exception as exc:
        _LOG.debug(
            "build_doc_compact_hint: unexpected error for %r: %s", file_path, exc,
            exc_info=True,
        )
        return None


def _build_doc_compact_hint_inner(
    file_path: str,
    cwd: str | None,
    *,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    # Config gate
    with contextlib.suppress(Exception):
        if not config.load().hints.stable_doc_compacts:
            return None

    # Only handle markdown files
    fp_lower = file_path.lower()
    if not (fp_lower.endswith((".md", ".markdown"))):
        return None

    # Resolve to absolute path
    try:
        abs_path = Path(file_path)
        if not abs_path.is_absolute() and cwd:
            abs_path = (Path(cwd) / file_path).resolve()
        if not abs_path.exists():
            return None
    except (OSError, ValueError):
        return None

    cwd_path = validate_cwd(cwd, caller="build_doc_compact_hint")
    if cwd_path is None:
        return None

    project = find_project(cwd_path)
    if project is None:
        return None

    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return None

    fname = _sanitize_hint_path(abs_path.name)
    recall_path = _sanitize_hint_path(rel)

    from . import doc_compact as _dc

    compact_p = _dc.find_compact_for_path(abs_path, project.hash)

    if compact_p is not None:
        header = _dc.read_compact_header(compact_p)
        if header is not None and header[0] == "STALE":
            return ReadHint(
                _apply_terse(
                    f"doc-compact: compact for `{fname}` is stale (source was edited). "
                    f"Run `token-goat compact-doc \"{recall_path}\"` to refresh."
                ),
                0,
            )

        if _dc.is_compact_fresh(compact_p, abs_path):
            body = _dc.read_compact_body(compact_p)
            if body:
                headings = _dc.get_section_headings(
                    rel, project.hash, limit=_DOC_COMPACT_SECTION_MAP_MAX
                )
                try:
                    file_bytes = abs_path.stat().st_size
                    compact_bytes = compact_p.stat().st_size
                    full_tokens = max(1, file_bytes // 4)
                    compact_tokens = compact_bytes // 4
                    pct = int(100 - compact_tokens * 100 / full_tokens)
                except OSError:
                    full_tokens = 0
                    compact_tokens = 0
                    pct = 0
                section_line = _format_section_map(headings)
                size_note = (
                    f"~{compact_tokens} tokens, {pct}% smaller than full file"
                    if full_tokens > 0
                    else "compact"
                )
                hint_lines = [
                    f"doc-compact: serving compact for `{fname}` ({size_note}).",
                ]
                if section_line:
                    hint_lines.append(f"  Sections: {section_line}")
                hint_lines.append(
                    f"  Full content: `token-goat read \"{recall_path}\"` to bypass."
                )
                hint_lines.append("")
                hint_lines.append(body.rstrip())
                serve_text = DOC_COMPACT_SERVE_SENTINEL + "\n".join(hint_lines)
                tokens_saved = max(0, full_tokens - compact_tokens)
                return ReadHint(serve_text, tokens_saved)

    # No compact: if large markdown with sections, emit section-map hint
    try:
        stat_size = abs_path.stat().st_size
    except OSError:
        return None

    if stat_size < _DOC_COMPACT_MIN_BYTES:
        return None

    headings = _dc.get_section_headings(
        rel, project.hash, limit=_DOC_COMPACT_SECTION_MAP_MAX
    )
    if len(headings) < _DOC_COMPACT_MIN_SECTIONS:
        return None

    full_tokens = stat_size // 4
    compact_est = full_tokens // 10
    section_line = _format_section_map(headings)
    hint_text = (
        f"doc-compact: `{fname}` has {len(headings)} sections (~{full_tokens} tokens). "
        f"Sections: {section_line}. "
        f"Use `token-goat section \"{recall_path}::Heading\"` for targeted reads. "
        f"Run `token-goat compact-doc \"{recall_path}\"` for a reusable compact "
        f"(~{compact_est} tokens on future reads)."
    )
    return ReadHint(_apply_terse(hint_text), 0)


def _format_section_map(headings: list[str], max_items: int = 8) -> str:
    """Format a list of headings as a compact inline string."""
    if not headings:
        return ""
    preview = [h if h.startswith("#") else f"## {h}" for h in headings[:max_items]]
    overflow = len(headings) - len(preview)
    result = " · ".join(preview)
    if overflow > 0:
        result += f" [+{overflow} more]"
    return result


def build_scoped_diff_hint(output_bytes: int, edited_files: list[str]) -> str:
    """Build a hint suggesting the scoped form of git diff when the unscoped diff is large.

    Shows up to 5 files. Overflow count goes on a separate line so the command stays copy-pasteable.
    """
    kb = output_bytes / 1024
    shown = edited_files[:5]
    overflow = len(edited_files) - len(shown)
    file_args = " ".join(shown)
    n = len(edited_files)
    cmd_line = f"  git diff -- {file_args}"
    overflow_note = f"\n  (and {overflow} more session-edited file(s) not listed)" if overflow > 0 else ""
    return (
        f"[token-goat] Large diff ({kb:.1f} KB). "
        f"You've edited {n} file(s) this session — scope it next time:\n"
        f"{cmd_line}{overflow_note}"
    )


def maybe_grep_advisory(path: str, session_cache: session.SessionCache, cwd: str | None = None) -> str | None:
    """Return a one-shot advisory hint when a file has been grepped ≥3 times this session.

    Increments the grep-target counter for *path* in *session_cache* and returns a
    hint string exactly when the count crosses the threshold (2 → 3).  Returns ``None``
    on every other call so the hint fires only once per file per session.

    The path is only counted when it refers to an existing file (not a directory,
    glob pattern, or stdin placeholder such as ``-``).  Non-existent and special
    paths are silently skipped.

    Args:
        path: The file path that was targeted by a Grep or rg invocation.
        session_cache: The current session cache object (may have ``unavailable=True``
            in which case ``record_grep_target`` is a safe no-op returning ``False``).
        cwd: Optional working directory for resolving relative *path* values.
            When provided, ``./scripts/ads.js`` and the equivalent absolute path
            resolve to the same dedup key.  Pass ``None`` when unavailable.

    Returns:
        A formatted advisory string on threshold crossing, or ``None`` otherwise.
    """
    try:
        if not path or path == "-":
            return None
        p = Path(path)
        if not p.is_file():
            return None
        crossed = session_cache.record_grep_target(path, cwd=cwd)
        if not crossed:
            return None
        safe_path = _sanitize_hint_path(str(p))
        return (
            f"[token-goat] You've grepped '{safe_path}' 3× this session. "
            f"Consider reading it once with `token-goat read \"{safe_path}\"` or using "
            f"`token-goat bash-output <id> --grep <pat>` to filter cached output."
        )
    except Exception:
        return None

