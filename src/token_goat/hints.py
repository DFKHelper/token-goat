"""Builds informational hints for PreToolUse on Read."""
from __future__ import annotations

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
from .hooks_common import sanitize_log_str, validate_cwd
from .project import find_project
from .util import get_logger

# Maximum entries in the recent_hints ring buffer stored per session.
_RECENT_HINTS_MAX: int = 3

__all__ = [
    "DIFF_HINT_MAX_BYTES",
    "ReadHint",
    "build_bash_dedup_hint",
    "build_diff_hint",
    "build_glob_dedup_hint",
    "build_grep_dedup_hint",
    "build_index_only_file_hint",
    "build_read_hint",
    "build_structured_file_hint",
    "build_unchanged_file_hint",
    "build_web_dedup_hint",
    "compute_stale_threshold",
    "_emit_json_sidecar",
    "_json_sidecar_enabled",
    "_hint_budget_check",
    "_record_structured_hint_emitted",
    "_record_index_only_hint_emitted",
    "_HINT_KIND_DEDUP",
    "_HINT_KIND_STRUCTURED",
    "_HINT_KIND_INDEX_ONLY",
    "_PROXIMITY_SLOP_LINES",
]

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
}


def _apply_terse(text: str) -> str:
    """Apply all _TERSE substitutions to *text* and return the result."""
    for verbose, terse in _TERSE.items():
        text = text.replace(verbose, terse)
    return text


def _make_short_stub_hint(seen_count: int) -> ReadHint:
    """Return a short stub hint for when a fingerprint has been seen Nx already.

    Used when verbose_until_seen_count has been reached — replaces the full
    hint text with a terse "(↳ same hint seen Nx, see prior context)" reminder.
    Carries 0 tokens_saved because suppressing the verbose text is the saving
    (no duplicate action needed from the agent).
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
_JSON_SIDECAR_MAX_BYTES: Final[int] = 400

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
        from . import config as _config  # noqa: PLC0415

        return bool(_config.load().hints.json_sidecar)
    except Exception:  # noqa: BLE001 — fail-soft; sidecar is purely additive
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
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return digest[:12]


def _hint_content_hash(hint_text: str) -> str:
    """Return a short MD5 hash (first 8 hex chars) of hint text for dedup.

    Used as secondary dedup to suppress hints with identical rendered content
    even when the fingerprint differs (e.g., same semantic content with slightly
    different line ranges). The 8-char prefix balances collision risk against
    session JSON size and is sufficient for content dedup within a session.
    """
    digest = hashlib.md5(hint_text.encode("utf-8")).hexdigest()
    return digest[:8]


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


# How many bytes to assume per line when estimating line count from file size.
# This is intentionally conservative (real code averages 30-50 bytes/line) so
# we slightly overestimate the line count rather than underestimate it.
_BYTES_PER_LINE_ESTIMATE = 75

# Maximum number of indexed symbols to fetch per file in one DB query.
# Enough to fill a useful hint; the full list is available via `token-goat symbol`.
_MAX_INDEXED_SYMBOLS_FETCHED = 50

# Maximum character budget for the "[symbols: ...]" suffix appended to cache hints.
# Keeps the suffix from inflating hints beyond their token ceiling.
_SYMBOLS_SUFFIX_MAX_CHARS = 60

# A file read this many times or more is a "working file" — the agent
# is clearly iterating on it. Stop emitting dedup nags that the agent
# is ignoring anyway.
_SUPPRESS_HINT_AT_READ_COUNT: Final[int] = 5

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
        except Exception as exc:  # noqa: BLE001 — fail-soft for the hot pre-tool hook path
            session_id = kwargs.get("session_id", "")
            session_id_str = str(session_id)[:16] if session_id else ""
            _LOG.warning(
                "%s: unexpected error (session=%s): %s",
                fn.__name__, session_id_str, exc, exc_info=True,
            )
            return None
    return cast(_F, _wrapper)


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
        with db.open_project(project_hash) as conn:
            # Fetch file metadata and symbols in one round-trip.
            # db_has_line_count_column tracks whether the schema supports line_count.
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
                WHERE file_rel = ? AND name IS NOT NULL
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
        )
        # Secondary dedup: suppress if the rendered hint content was already seen.
        if hint is not None and session_id and cache:
            content_hash = _hint_content_hash(str(hint))
            if content_hash in cache.hints_seen:
                _LOG.debug(
                    "build_read_hint: suppressed (content hash %s already seen)",
                    content_hash,
                )
                return None
            # Curator: record this file-level dedup hint emission.
            if hint.tokens_saved > 0:
                from . import session as _sess  # noqa: PLC0415
                norm_path = _sess._normalize_path(file_path)  # type: ignore[attr-defined]
                _record_hint_emitted(cache, norm_path)
        # JSON sidecar: opt-in machine-readable line prepended after dedup so
        # the prose-only hash above keeps deduping correctly. No-op when the
        # [hints] json_sidecar feature flag is off (default).
        if hint is not None:
            kind = "already_read" if hint.tokens_saved > 0 else "read_suggestion"
            hint = _emit_json_sidecar(
                hint, kind, file=file_path, wasted=hint.tokens_saved or None,
            )
            if cache is not None:
                cache.record_hint_emitted("read_dedup")
        return hint
    except Exception as exc:  # noqa: BLE001
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
    # An explicit limit signals "surgical intent" — the agent picked a narrow
    # window deliberately, not the implicit DEFAULT_READ_LIMIT fallback. Used
    # by _hint_from_cache to suppress nag-text on small intentional re-reads.
    has_explicit_limit = safe_limit > 0

    # Compute fname once; it is used in multiple debug log calls below and
    # forwarded to _hint_from_cache / _hint_from_index which also need it.
    # Both are sanitized here so every downstream hint f-string is safe: a path
    # with embedded newlines read from a crafted session JSON would otherwise
    # split a hint line into fake separate "Note:" entries in the LLM's context.
    fname = _sanitize_hint_path(Path(file_path).name)
    file_path = _sanitize_hint_path(file_path)

    # Compute a shorter recall_path for use in recall-command examples embedded
    # in hints.  Using the relative path (when cwd is available) instead of the
    # full absolute path saves ~25-40 tokens per hint on typical projects where
    # file_path is an absolute Windows path like C:/Projects/foo/src/bar.py.
    # When cwd is None or the path is not inside cwd, fall back to file_path so
    # recall commands remain copy-paste correct.
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
        cache = session.load(session_id)
    entry = session.get_file_entry(session_id, file_path, cache=cache)
    if entry is not None:
        # Curator: if the agent has been ignoring re-read dedup hints, stop emitting them.
        if not _curator_should_emit(cache):
            return None
        # Budget: hard cap on total dedup hints for the session.
        if cache is not None and not _hint_budget_check(cache, _HINT_KIND_DEDUP):
            return None
        hint = _hint_from_cache(
            entry, req_start, req_end, file_path,
            fname=fname, recall_path=recall_path,
            has_explicit_limit=has_explicit_limit,
            cache=cache,
        )
        if hint is not None:
            _LOG.debug(
                "build_read_hint: cache hint for %s lines %d-%d (tokens_saved=%d)",
                fname, req_start, req_end, hint.tokens_saved,
            )
        else:
            _LOG.debug("build_read_hint: no hint (non-overlapping prior read of %s)", fname)
        return hint

    # 2. Not cached — consider "large file with indexed symbols" suggestion.
    # Fast-path: a file smaller than LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE
    # bytes can never have enough lines to trigger a hint.  Skip the project-find + DB
    # query entirely for small files (the common case on the hot pre-read path).
    # Stat failure (missing file, permission error) falls through to _hint_from_index
    # so it can handle those cases with its existing logic.
    _stat_size: int | None = None
    try:
        _stat_size = Path(file_path).stat().st_size
        if _stat_size < LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE:
            _LOG.debug(
                "build_read_hint: stat-skip index for %s (%dB < %dB threshold)",
                fname, _stat_size, LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE,
            )
            return None
    except OSError:
        pass

    hint = _hint_from_index(file_path, cwd, req_start, req_end, fname=fname)
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


def _should_suppress_full_file_hint(n_lines: int | None) -> bool:
    """Return True when a full-file hint should be suppressed based on line count.

    Surgical hints (symbol/section/diff) always bypass this check; only full-file
    hints (already-read dedup, index-based large-file suggestions) are gated.
    When min_file_lines_for_hint is 0 (default), no suppression occurs.
    When n_lines is None (no cached line count), suppression is skipped to avoid
    adding new stat calls to the hot path.
    """
    cfg = config.load()
    threshold = cfg.hints.min_file_lines_for_hint
    if threshold <= 0 or n_lines is None:
        return False
    return n_lines < threshold


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
    _created_ts = getattr(cache, "created_ts", None)
    session_age = (time.time() - _created_ts) if _created_ts is not None else STALE_READ_AGE_SECONDS
    stale_threshold = compute_stale_threshold(session_age)
    read_is_stale = (time.time() - entry.last_read_ts) > stale_threshold
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
    # Compute the max line from cached ranges. This suppression applies only to the
    # "already read" dedup hint pathway; surgical hints (symbols/sections) bypass this.
    if entry.line_ranges and entry.line_ranges != [(0, 0)]:
        max_line = max(cached_end for cached_start, cached_end in entry.line_ranges)
        if _should_suppress_full_file_hint(max_line):
            _LOG.debug(
                "_hint_from_cache: suppressing full-file hint for %s "
                "(line_count=%d < threshold=%d)",
                fname, max_line, config.load().hints.min_file_lines_for_hint,
            )
            # Symbol-only hints are still emitted (surgical reads are never suppressed).
            if not entry.symbols_read:
                return None

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
                f"Use `token-goat read \"{recall_path}::sym\"` for surgical access."
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
    if entry.symbols_read and not entry.line_ranges:
        n_syms = len(entry.symbols_read)
        sym_list = ", ".join(f"`{s}`" for s in entry.symbols_read[:3])
        more = f" +{n_syms - 3}" if n_syms > 3 else ""
        return ReadHint(
            _apply_terse(
                f"`{fname}` read via `token-goat read`: {sym_list}{more}. "
                f"Use `token-goat read \"{recall_path}::symbol\"` for more."
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
        global_min = line_ranges[0][0]
        global_max = line_ranges[0][1]
        for _s, _e in line_ranges[1:]:
            if _s < global_min:
                global_min = _s
            if _e > global_max:
                global_max = _e
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

    cached_summary = ", ".join(f"{s}-{e}" for s, e in line_ranges[:3])
    extra = f" (+{n_ranges - 3} more ranges)" if n_ranges > 3 else ""

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
        wasted = _est_tokens_from_lines(requested_lines)
        sym_suffix = _symbols_suffix(entry.symbols_read)
        return ReadHint(
            _apply_terse(
                f"`{fname}` L{req_start}-{req_end} cached (L{cached_summary}{extra}){sym_suffix}. "
                f"~{wasted}t wasted — adjust offset/limit."
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
                f"Overlap: {overlap_lines}L (~{wasted}t) — use `offset={resume_offset}`."
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
) -> int | None:
    """Return a confirmed line count at or above the large-file threshold, or None.

    When the DB already stores an exact count, use it directly.  When the count
    is only an estimate (size-based), verify against the real file: estimates
    can be low enough to suppress hints for genuinely large files.  Returns None
    when the file is clearly below the threshold and no hint is warranted.
    """
    if line_count_is_exact:
        return estimated_lines if estimated_lines >= LARGE_FILE_LINE_THRESHOLD else None
    # Estimate is below threshold — check the real file before suppressing the hint.
    if estimated_lines < LARGE_FILE_LINE_THRESHOLD:
        actual = _line_count(abs_path)
        if actual is None or actual < LARGE_FILE_LINE_THRESHOLD:
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

    n_lines = _confirmed_line_count(estimated_lines, line_count_is_exact, abs_path)
    if n_lines is None:
        _LOG.debug("_hint_from_index: %s below large-file threshold (estimated=%s)", fname, estimated_lines)
        return None

    # Line-count threshold suppression: suppress index-based hints for tiny files
    # when the hint cost exceeds the value of a surgical read suggestion.
    if _should_suppress_full_file_hint(n_lines):
        _LOG.debug(
            "_hint_from_index: suppressing index hint for %s "
            "(line_count=%d < threshold=%d)",
            fname, n_lines, config.load().hints.min_file_lines_for_hint,
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
                f"No symbols indexed. Use `offset`/`limit` to read chunks."
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
    sym_overflow = " ..." if overflow > 0 else ""
    sym_clause = f"Symbols: {sym_list_str}{sym_overflow}. "

    # A *suggestion*, not a realized saving. tokens_saved=0: if the agent acts
    # on it, `token-goat read` records the real `read_replacement` stat — counting
    # a saving here too would double-count, and counting one when the agent
    # ignores the hint and reads the whole file is pure phantom inflation.
    #
    # Kept deliberately terse: the hint text itself costs tokens in the
    # conversation, so it carries one example command rather than enumerating
    # every indexed symbol (`token-goat symbol`/`map` cover that on demand).
    return ReadHint(
        _apply_terse(
            f"`{fname}`: {n_lines} lines (~{full_tokens} tokens). "
            f"{sym_clause}"
            f"Use `token-goat read \"{rel}::{first_sym_name}\"` (~85% faster)."
        ),
        0,
    )


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
    except Exception:  # noqa: BLE001 — sha lookup must never break the hint path
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
        import re  # noqa: PLC0415
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
        if tokens_saved_micro < _DIFF_HINT_MIN_TOKENS_SAVED:
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

    diff_iter = difflib.unified_diff(
        snapshot_lines,
        current_lines,
        fromfile=f"{fname} (previously read)",
        tofile=f"{fname} (current)",
        n=n_context,
        lineterm="",
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
    if tokens_saved < _DIFF_HINT_MIN_TOKENS_SAVED:
        _LOG.debug(
            "build_diff_hint: saving too small (%d < %d) for %s — suppressing",
            tokens_saved, _DIFF_HINT_MIN_TOKENS_SAVED, fname,
        )
        return None

    prose_diff = ReadHint(
        _apply_terse(f"`{fname}` diff (~{tokens_saved} tokens saved):\n")
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
            cache = session.load(session_id)
        if cache.unavailable:
            return None

    into a single call.  Callers that need additional post-load checks (e.g.
    :func:`_build_glob_dedup_hint_inner` which also tests
    ``cache.is_glob_history_empty()``) call this first, then apply their own
    guard on the returned cache.
    """
    if cache is None:
        cache = session.load(session_id)
    if cache.unavailable:
        return None
    return cache


# Configurable bash_dedup_min_bytes
# ---------------------------------------------------------------------------


def _get_bash_dedup_min_bytes() -> int:
    """Return the configured bash dedup minimum bytes threshold.

    Reads from hints.bash_dedup_min_bytes in config (or TOKEN_GOAT_BASH_DEDUP_MIN_BYTES
    env var). Defaults to _BASH_DEDUP_MIN_BYTES (200) on any error or when config
    is unavailable. Never raises; fail-soft returns the fallback default.
    """
    try:
        from . import config as _config  # noqa: PLC0415

        cfg = _config.load().hints
        return cfg.bash_dedup_min_bytes
    except Exception:  # noqa: BLE001 — fail-soft
        return _BASH_DEDUP_MIN_BYTES


def _get_grep_dedup_min_matches() -> int:
    """Return the configured grep dedup minimum match count threshold.

    Reads from hints.grep_dedup_min_matches in config (or TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES
    env var). Defaults to _GREP_DEDUP_MIN_RESULT_COUNT (5) on any error or when config
    is unavailable. Never raises; fail-soft returns the fallback default.
    """
    try:
        from . import config as _config  # noqa: PLC0415

        cfg = _config.load().hints
        return cfg.grep_dedup_min_matches
    except Exception:  # noqa: BLE001 — fail-soft
        return _GREP_DEDUP_MIN_RESULT_COUNT


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
        from . import config as _config  # noqa: PLC0415

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
    except Exception:  # noqa: BLE001 — fail-soft
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
    import time as _time  # noqa: PLC0415

    cache.hints_emitted += 1
    cache.recent_hints.append((norm_path, _time.time()))
    if len(cache.recent_hints) > _RECENT_HINTS_MAX:
        cache.recent_hints = cache.recent_hints[-_RECENT_HINTS_MAX:]
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
        from . import config as _config  # noqa: PLC0415

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
    except Exception:  # noqa: BLE001 — fail-soft
        return True


def _record_structured_hint_emitted(cache: session.SessionCache) -> None:
    """Increment structured_hints_emitted counter on *cache*. Never raises."""
    cache.structured_hints_emitted += 1
    cache.record_hint_emitted("structured_file")
    cache._invalidate_json_cache()


def _record_index_only_hint_emitted(cache: session.SessionCache) -> None:
    """Increment index_only_hints_emitted counter on *cache*. Never raises."""
    cache.index_only_hints_emitted += 1
    cache.record_hint_emitted("index_only_file")
    cache._invalidate_json_cache()


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
    import contextlib  # noqa: PLC0415
    with contextlib.suppress(Exception):
        db.record_stat(
            None,
            kind,
            bytes_saved=0,
            tokens_saved=0,
            detail=detail[:64],
        )


def _failsoft_dedup_hint(
    fn: Callable[[], ReadHint | None],
    *,
    caller: str,
    session_id: str,
) -> ReadHint | None:
    """Invoke *fn* and return its result, suppressing any exception.

    All three dedup hint builders (bash, grep, web) share the same fail-soft
    contract: if the inner implementation raises unexpectedly, the exception
    is logged at WARNING level and ``None`` is returned so the pre-tool hook
    continues unchanged.  This helper centralises that boilerplate — the only
    per-caller variation is the *caller* label used in the warning message.

    Args:
        fn:         Zero-argument callable wrapping the inner hint builder with
                    all its keyword arguments already bound (typically a lambda
                    or :func:`functools.partial`).
        caller:     Short name used in the warning log, e.g. ``"build_bash_dedup_hint"``.
        session_id: Used in the warning log to help correlate the error to a session.

    Returns:
        The hint returned by *fn*, or ``None`` on any exception.
    """
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — fail-soft for the hot pre-tool hook path
        _LOG.warning(
            "%s: unexpected error (session=%s): %s",
            caller, (session_id or "")[:16], exc, exc_info=True,
        )
        return None


# ---------------------------------------------------------------------------
# Bash dedup hint
# ---------------------------------------------------------------------------


@_failsoft_hint
def build_bash_dedup_hint(
    *,
    session_id: str,
    command: str,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a hint when *command* was run earlier in this session.

    The pre-Bash hook calls this before executing a Bash command.  When the
    same command has been run before and its output cached on disk, we suggest
    the agent retrieve the cached output via ``token-goat bash-output``
    instead of re-running — avoiding both the runtime cost and the duplicated
    output bytes in the conversation.

    Returns ``None`` (no hint) when:

    * no session_id is provided
    * the command has never been recorded
    * the previous output was too small to be worth deduplicating
    * the previous output is older than :data:`STALE_READ_AGE_SECONDS`
      (same staleness boundary used by the read-dedup path: above that
      window the model's context has likely scrolled past the old result)
    """
    return _build_bash_dedup_hint_inner(
        session_id=session_id, command=command, cache=cache,
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


def _build_bash_dedup_hint_inner(
    *,
    session_id: str,
    command: str,
    cache: session.SessionCache | None,
) -> ReadHint | None:
    """Inner implementation; may raise.

    Imported lazily so the hot pre-read path does not pay the bash_cache
    import cost on every Read invocation — bash_cache is only needed when
    we are actually about to dispatch a Bash dedup.
    """
    if not session_id or not command:
        return None
    if cache is not None and not _curator_should_emit(cache):
        return None
    if cache is not None and not _hint_budget_check(cache, _HINT_KIND_DEDUP):
        return None

    from . import bash_cache  # noqa: PLC0415

    cmd_sha = bash_cache.command_hash(command)
    entry = session.lookup_bash_entry(session_id, cmd_sha, cache=cache)
    if entry is None:
        return None

    now = time.time()
    age = now - entry.ts
    _bash_created_ts = getattr(cache, "created_ts", None)
    bash_session_age = (now - _bash_created_ts) if _bash_created_ts is not None else STALE_READ_AGE_SECONDS
    bash_stale_threshold = compute_stale_threshold(bash_session_age)
    if age > bash_stale_threshold:
        _LOG.debug(
            "build_bash_dedup_hint: prior run stale (age=%.0fs > %.0fs); suppressing",
            age, bash_stale_threshold,
        )
        _record_dedup_stale("bash_dedup_stale", _sanitize_hint_path(command))
        return None

    total_bytes = entry.stdout_bytes + entry.stderr_bytes
    min_bytes = _get_bash_dedup_min_bytes()
    if total_bytes < min_bytes:
        if cache is not None:
            cache.record_hint_suppressed("bash_dedup_below_threshold")
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
    cmd_short = _sanitize_hint_path(command)
    run_count = getattr(entry, "run_count", 1)
    from . import cache_common as _cc  # noqa: PLC0415
    short_id = _cc.short_output_id(entry.output_id)
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
        exit_str = "" if entry.exit_code is None else f" exit={entry.exit_code}"

    if total_bytes <= _BASH_DEDUP_LIGHT_MAX_BYTES:
        hint_text = f"{fail_prefix}`{cmd_short}` cached ({int(age)}s, {total_bytes}B{exit_str}). `{recall_cmd}`"
        if cache is not None and dedup_key:
            cache.bash_dedup_emitted_ids.add(dedup_key)
            cache._invalidate_json_cache()
        if cache is not None:
            _record_hint_emitted(cache, cmd_sha)
            cache.record_hint_emitted("bash_dedup")
        return ReadHint(_apply_terse(hint_text), tokens_avoided)

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
        cache.bash_dedup_emitted_ids.add(dedup_key)
        cache._invalidate_json_cache()
    if cache is not None:
        _record_hint_emitted(cache, cmd_sha)
        cache.record_hint_emitted("bash_dedup")
    return ReadHint(_apply_terse(hint_text), tokens_avoided)


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

    Never raises; any unexpected exception is caught and the hint is
    suppressed (the pre-Grep path must stay fail-soft).
    """
    return _build_grep_dedup_hint_inner(
        session_id=session_id, pattern=pattern, path=path, cache=cache,
    )


def _build_grep_dedup_hint_inner(
    *,
    session_id: str,
    pattern: str,
    path: str | None,
    cache: session.SessionCache | None,
) -> ReadHint | None:
    """Inner implementation of :func:`build_grep_dedup_hint`; may raise.

    Walks the session ``greps`` list in reverse-chronological order looking
    for a prior entry with the same ``(pattern, path)`` pair.  The list is
    typically short (well under 100 entries even in long sessions); a linear
    scan in reverse is cheap and avoids the cost of indexing by pattern up
    front, which would not pay back for the common case of distinct patterns.
    """
    if not session_id or not pattern:
        return None
    cache = _require_cache(session_id, cache)
    if cache is None:
        return None

    now = time.time()
    # Cross-session hint: fires even when the session has no prior greps yet,
    # because the pattern may be a frequent exploratory query run at session
    # start (where cache.greps is still empty).  Check this before the
    # intra-session guard so new sessions benefit from cross-session dedup.
    if _curator_should_emit(cache) and _hint_budget_check(cache, _HINT_KIND_DEDUP):
        cross_session_hint = _build_grep_cross_session_hint(pattern, now)
        if cross_session_hint is not None:
            _record_hint_emitted(cache, f"grep_xsess:{pattern}")
            return cross_session_hint

    # Intra-session scan: requires at least one prior grep in this session.
    if not cache.greps:
        return None
    if not _curator_should_emit(cache):
        return None
    if not _hint_budget_check(cache, _HINT_KIND_DEDUP):
        return None

    for entry in reversed(cache.greps):
        if entry.pattern != pattern:
            continue
        if entry.path != path:
            continue
        age = now - entry.ts
        if age > STALE_READ_AGE_SECONDS:
            # Older entries are even older — short-circuit the scan.
            return None
        min_matches = _get_grep_dedup_min_matches()
        if entry.result_count is None or entry.result_count < min_matches:
            if cache is not None:
                cache.record_hint_suppressed("grep_dedup_below_threshold")
            return None
        # Estimate the bytes that would land in context if the agent re-runs.
        bytes_avoided = entry.result_count * _GREP_AVG_BYTES_PER_RESULT
        tokens_avoided = _est_tokens_from_chars(bytes_avoided)
        pattern_short = _truncate_pattern_display(pattern)
        path_str = f" in `{_sanitize_hint_path(path)}`" if path else ""
        # Curator: record emission keyed on the pattern (grep has no file path).
        _record_hint_emitted(cache, f"grep:{pattern}")
        cache.record_hint_emitted("grep_dedup")
        return ReadHint(
            _apply_terse(
                f"Grep `{pattern_short}`{path_str} ({int(age)}s): {entry.result_count} matches, ~{tokens_avoided}t."
            ),
            tokens_avoided,
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
    pattern_hash = hashlib.sha1(  # noqa: S324
        pattern.encode("utf-8", errors="replace")
    ).hexdigest()
    try:
        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count, last_ts FROM grep_patterns WHERE pattern_hash = ?",
                (pattern_hash,),
            ).fetchone()
    except Exception:  # noqa: BLE001
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

    Never raises; any unexpected exception is caught and the hint is suppressed
    (the pre-Glob path must stay fail-soft).
    """
    return _build_glob_dedup_hint_inner(
        session_id=session_id, pattern=pattern, path=path, cache=cache,
    )


def _build_glob_dedup_hint_inner(
    *,
    session_id: str,
    pattern: str,
    path: str | None,
    cache: session.SessionCache | None,
) -> ReadHint | None:
    """Inner implementation of :func:`build_glob_dedup_hint`; may raise.

    Delegates lookup to :func:`session.lookup_glob_entry` which walks the
    glob_history list in reverse-chronological order for the matching
    ``(pattern, path)`` pair.
    """
    if not session_id or not pattern:
        return None
    cache = _require_cache(session_id, cache)
    if cache is None or cache.is_glob_history_empty():
        return None
    if not _curator_should_emit(cache):
        return None
    if not _hint_budget_check(cache, _HINT_KIND_DEDUP):
        return None

    entry = session.lookup_glob_entry(session_id, pattern, path, cache=cache)
    if entry is None:
        return None

    age = time.time() - entry.ts
    if age > STALE_READ_AGE_SECONDS:
        return None
    if entry.result_count is None or entry.result_count < _GLOB_DEDUP_MIN_RESULT_COUNT:
        return None

    bytes_avoided = entry.result_count * _GLOB_AVG_BYTES_PER_RESULT
    tokens_avoided = _est_tokens_from_chars(bytes_avoided)
    pattern_short = _sanitize_hint_path(pattern)
    path_str = f" in `{_sanitize_hint_path(path)}`" if path else ""
    # Curator: record emission keyed on the pattern (glob has no file path).
    _record_hint_emitted(cache, f"glob:{pattern}")
    cache.record_hint_emitted("glob_dedup")
    return ReadHint(
        _apply_terse(
            f"Glob `{pattern_short}`{path_str} ({int(age)}s): {entry.result_count} results, ~{tokens_avoided}t."
        ),
        tokens_avoided,
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
    """
    return _build_web_dedup_hint_inner(
        session_id=session_id, url=url, cache=cache,
    )


def _build_web_dedup_hint_inner(
    *,
    session_id: str,
    url: str,
    cache: session.SessionCache | None,
) -> ReadHint | None:
    """Inner implementation; may raise.

    Imported lazily so the hot path does not pay the web_cache import cost
    on every WebFetch invocation — web_cache is only needed when we are
    actually about to dispatch a dedup.
    """
    if not session_id or not url:
        return None
    if cache is not None and not _curator_should_emit(cache):
        return None
    if cache is not None and not _hint_budget_check(cache, _HINT_KIND_DEDUP):
        return None

    from . import web_cache  # noqa: PLC0415

    url_sha = web_cache.url_hash(url)
    entry = session.lookup_web_entry(session_id, url_sha, cache=cache)
    if entry is None:
        return None

    age = time.time() - entry.ts
    if age > STALE_READ_AGE_SECONDS:
        _LOG.debug(
            "build_web_dedup_hint: prior fetch stale (age=%.0fs > %ds); suppressing",
            age, STALE_READ_AGE_SECONDS,
        )
        _record_dedup_stale("web_dedup_stale", _sanitize_hint_path(url))
        return None
    cfg = config.load()
    if cfg.hints.web_dedup_min_bytes == 0 or entry.body_bytes < cfg.hints.web_dedup_min_bytes:
        if cache is not None:
            cache.record_hint_suppressed("web_dedup_below_threshold")
        return None

    tokens_avoided = _est_tokens_from_chars(entry.body_bytes)
    status_str = (
        f" status={entry.status_code}" if entry.status_code is not None else ""
    )
    from . import cache_common as _cc  # noqa: PLC0415

    # Show the --grep PATTERN recall hint only once per session.  On the first
    # large-body WebFetch dedup the agent learns the pattern; subsequent fetches
    # only show the id so the hint stays short.
    _WEB_RECALL_HINT_KEY = "web_output_grep_hint_shown"  # noqa: N806
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
        _record_hint_emitted(cache, f"web:{url_sha}")
        cache.record_hint_emitted("web_dedup")
    # After the agent has seen the verbose recall pointer twice, drop the
    # full command string and emit just the bare ID — see _should_emit_recall_command.
    short_id = _cc.short_output_id(entry.output_id)
    if _should_emit_recall_command(cache, "web"):
        recall_str = f"`token-goat web-output {short_id}`"
    else:
        recall_str = f"id={short_id}"
    return ReadHint(
        _apply_terse(
            f"URL ({int(age)}s): {entry.body_bytes:,}B{status_str}, ~{tokens_avoided}t. "
            f"{recall_str}{grep_suffix}"
        ),
        tokens_avoided,
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
    import hashlib as _hashlib  # noqa: PLC0415 — avoid top-level cost on hot path
    import time as _time  # noqa: PLC0415

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

    current_sha = _hashlib.sha256(current_bytes).hexdigest()
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

    prose = ReadHint(
        _apply_terse(
            f"`{fname}` unchanged since your edit ({age_s}s ago, ~{full_tokens}t). "
            f"Content already in context from Edit result. "
            f"Re-read only if you need line numbers. "
            f"For a symbol use `token-goat read \"{safe_path}::Symbol\"`."
        ),
        full_tokens,
    )
    # Opt-in machine-readable sidecar; no-op when [hints] json_sidecar is off.
    cache.record_hint_emitted("unchanged_file")
    return _emit_json_sidecar(
        prose, "unchanged_since_edit",
        file=safe_path, age_s=age_s, wasted=full_tokens,
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
    has_offset = offset is not None and isinstance(offset, int) and offset > 0
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
        elif basename_lower in ("package-lock.json",):
            alt = f'`npm ls` or `jq \'.dependencies.NAME\' {fname}`'
        elif basename_lower in ("yarn.lock", "pnpm-lock.yaml"):
            alt = "`yarn list` / `pnpm list` instead"
        elif basename_lower == "cargo.lock":
            alt = '`cargo tree` or `grep -A5 \'name = "NAME"\' ' + fname + "`"
        elif basename_lower in ("gemfile.lock",):
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

# Minimum size in bytes before the structured-file hint fires.  Below this the
# file is cheap to read whole and the hint would approach the saving it advertises.
_STRUCTURED_FILE_MIN_BYTES: int = 50_000

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
    has_offset = offset is not None and isinstance(offset, int) and offset > 0
    has_limit = limit is not None and isinstance(limit, int) and limit > 0
    if has_offset and has_limit:
        return None

    path = Path(file_path)
    ext = path.suffix.lower()

    is_tabular = ext in _STRUCTURED_EXT_TABULAR
    is_json = ext in _STRUCTURED_EXT_JSON
    is_log = ext in _STRUCTURED_EXT_LOG

    if not (is_tabular or is_json or is_log):
        return None

    # Cheap size check first — skip the row-count probe for small files.
    try:
        file_size = path.stat().st_size
    except OSError:
        return None

    if file_size < _STRUCTURED_FILE_MIN_BYTES:
        return None

    size_kb = file_size // 1024
    safe_path = _sanitize_hint_path(file_path)

    if is_tabular:
        row_count = _estimate_row_count(path, file_size)
        row_str = f"~{row_count:,}rows" if row_count > 0 else "many rows"
        return ReadHint(
            _apply_terse(
                f"📊 large {ext} ({size_kb}KB, {row_str}) — "
                f"use offset/limit or `token-goat section \"{safe_path}::row N\"`"
            ),
            0,
        )

    if is_json:
        return ReadHint(
            _apply_terse(
                f"📄 large json ({size_kb}KB) — "
                f"use `token-goat read \"{safe_path}::Key.path\"` or jq"
            ),
            0,
        )

    # is_log
    row_count = _estimate_row_count(path, file_size)
    row_str = f"~{row_count:,}lines" if row_count > 0 else "many lines"
    return ReadHint(
        _apply_terse(
            f"📜 log ({size_kb}KB, {row_str}) — use tail/head or grep instead of full Read"
        ),
        0,
    )

