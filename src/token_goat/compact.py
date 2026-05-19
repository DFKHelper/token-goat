"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

__all__ = [
    "build_manifest",
    "build_manifest_with_count",
    "event_count",
    "is_noise_path",
]

import heapq
import logging
import time
from datetime import UTC, datetime
from operator import attrgetter, itemgetter
from typing import TYPE_CHECKING, Final

from . import session as session_mod
from .hooks_common import sanitize_log_str
from .repomap import estimate_tokens

if TYPE_CHECKING:
    from .session import FileEntry, SessionCache

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
# Maximum number of cached Bash commands listed in the manifest.  Bash entries
# preserve the test/build context most likely to drive the next agent turn
# (a green pytest, a failing build, the most recent git log), but listing every
# command across a long session would crowd out higher-priority sections.  Six
# covers the typical iterate-test-fix-test-commit cycle without dominating the
# budget — most sessions accumulate fewer than that.
_MAX_BASH_ENTRIES: Final[int] = 6
# Smallest cached Bash output worth surfacing in the manifest.  Below ~400 bytes
# the dedup hint suppresses on size anyway, and the manifest line itself costs
# tokens that would not be paid back even if the agent acted on the hint.
_MIN_BASH_BYTES_FOR_MANIFEST: Final[int] = 400

# Sentinel gap used by session.mark_file_read() when no line limit is specified.
# A range whose (end - start) equals this value represents "whole file read, extent
# unknown" — _format_ranges() annotates these as "(full)" rather than printing
# "lines 1-100000", so the compaction LLM knows the entire file was in context.
_FULL_READ_SENTINEL_GAP: Final[int] = session_mod._UNKNOWN_END_SENTINEL

# Maximum grep patterns listed in the "Patterns Searched" section.  Grep entries
# give the compaction LLM context about what the user was investigating, but beyond
# 5 patterns the list becomes noise — the most-recently-searched ones dominate anyway.
_MAX_GREP_ENTRIES: Final[int] = 5

# Hard ceiling on the max_tokens parameter accepted by build_manifest.
# The config layer sets a sensible default (400) but build_manifest is also part of
# the public API.  Without a cap, a caller could pass an arbitrarily large value,
# causing the manifest construction pass to allocate and render all sections before
# the trim loop brings it back down — a pointless memory/CPU spike with no benefit.
_MAX_MANIFEST_TOKENS_CAP: Final[int] = 4_000

# Key for sorting edited_files dict items by edit count (the second element of each pair).
# Defined at module level so it is created once rather than re-created on every manifest build.
_BY_EDIT_COUNT = itemgetter(1)

# Composite sort key for FileEntry: primary read_count (descending), secondary
# last_read_ts (descending).  Using a tuple from attrgetter means heapq.nlargest
# compares both fields in one step — files tied on read_count are broken by
# recency, so the most recently touched files rise in the Key Files Read section.
_BY_READ_COUNT_THEN_TS = attrgetter("read_count", "last_read_ts")

# Attribute-based key for sorting FileEntry objects by recency.
# Used to rank "Symbols Accessed" entries — most-recently-touched first
# (the symbols a user just inspected are more load-bearing for the upcoming
# compaction than ones touched at the start of a long session).
_BY_LAST_READ_TS = attrgetter("last_read_ts")

# Same idea, applied to BashEntry — most-recently-run commands are the ones
# whose output the compaction LLM most needs to preserve as context.
_BY_BASH_TS = attrgetter("ts")

# Age threshold (seconds) for flagging cached Bash outputs as cold / evictable.
# Outputs this old are unlikely to be actively iterated on; surfacing them in
# the manifest lets the compaction LLM know they can be dropped from context.
_COLD_OUTPUT_AGE_SECS: Final[int] = 1_800  # 30 minutes

# Maximum cold bash entries surfaced in the "Cold Outputs" manifest section.
_MAX_COLD_OUTPUTS: Final[int] = 4

# Noise file extensions and basenames that should never enter the manifest.
# These files are build artifacts, OS metadata, or auto-generated lockfiles that
# the compaction LLM does not need to "preserve" — listing them wastes budget on
# items that carry no semantic information about the user's work.  Keep the set
# small and conservative: false negatives (a real file mistakenly skipped) are
# worse than false positives (a noise file slipping through).
_NOISE_EXTS: Final[frozenset[str]] = frozenset({
    ".pyc", ".pyo", ".pyd",          # Python bytecode / extension binaries
    ".class",                          # Java
    ".o", ".obj", ".a", ".lib", ".dll", ".so", ".dylib",  # compiled native
    ".log",                            # log files
    ".tmp", ".temp", ".swp", ".swo",  # editor / scratch files
    ".bak",                            # backup files
})
_NOISE_BASENAMES: Final[frozenset[str]] = frozenset({
    ".ds_store", "thumbs.db", "desktop.ini",  # OS metadata
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",  # JS lockfiles
    "poetry.lock", "uv.lock", "pdm.lock",                # Python lockfiles
    "cargo.lock",                                         # Rust lockfile
    "composer.lock", "gemfile.lock",                      # PHP/Ruby lockfiles
})
# Path-substring noise markers — any normalized path containing one of these
# segments is considered noise.  Forward-slash form because _short_path already
# normalises backslashes; the matcher runs against the un-shortened normalized
# path so it works regardless of where the segment appears in the tree.
_NOISE_SEGMENTS: Final[tuple[str, ...]] = (
    "/__pycache__/", "/.git/", "/node_modules/", "/.venv/", "/venv/",
    "/dist/", "/build/", "/.mypy_cache/", "/.pytest_cache/", "/.ruff_cache/",
)


def is_noise_path(path: str) -> bool:
    """Return True when *path* should be excluded from the manifest as low-value noise.

    Build artifacts (``.pyc``, ``.o``), OS metadata (``.DS_Store``,
    ``Thumbs.db``), lockfiles (``package-lock.json``, ``poetry.lock``), and
    cache directories (``__pycache__/``, ``.git/``, ``node_modules/``) carry
    no information the compaction LLM needs to preserve, and would otherwise
    eat into the manifest's strict token budget.

    Matching is case-insensitive and tolerant of both POSIX and Windows
    separators.  Returns False for any empty or malformed input.
    """
    if not path:
        return False
    p = path.replace("\\", "/").lower()
    # Path-segment check first: catches whole noise directories regardless of
    # the file's own extension (e.g. ``project/.venv/lib/foo.py``).
    for segment in _NOISE_SEGMENTS:
        if segment in p:
            return True
    # Basename and extension checks — slice once and reuse.
    slash_idx = p.rfind("/")
    basename = p[slash_idx + 1:] if slash_idx >= 0 else p
    if basename in _NOISE_BASENAMES:
        return True
    dot_idx = basename.rfind(".")
    return dot_idx >= 0 and basename[dot_idx:] in _NOISE_EXTS


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
    had_sentinel = False
    for entry in ranges:
        try:
            start, end = entry
            start, end = int(start), int(end)
            if end - start >= _FULL_READ_SENTINEL_GAP:
                had_sentinel = True  # whole-file read — sentinel supersedes all partials
            else:
                valid.append((start, end))
        except (TypeError, ValueError):
            _LOG.debug("_format_ranges: skipping malformed range entry: %r", entry)
    if had_sentinel:
        return "  (full)"
    if not valid:
        return ""
    total_ranges = len(valid)
    shown = valid[:_MAX_RANGES_PER_FILE]
    # Generator expression avoids building an intermediate list just to join.
    parts = ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in shown)
    hidden_count = total_ranges - _MAX_RANGES_PER_FILE
    overflow_suffix = f" +{hidden_count} more" if hidden_count > 0 else ""
    return f"  lines {parts}{overflow_suffix}"


def _select_top_bash_entries(bash_history: object) -> list[object]:
    """Pick up to :data:`_MAX_BASH_ENTRIES` cached Bash runs worth surfacing.

    Filters out entries below :data:`_MIN_BASH_BYTES_FOR_MANIFEST` (the dedup
    hint would suppress them anyway) and ranks by recency — the most recent
    runs are the ones whose output drives the next agent turn.  Accepts the
    ``bash_history`` attribute typed as ``object`` so the helper is safe to
    call on legacy SessionCache instances written by token-goat versions that
    predate the field (``None`` / missing → empty list).

    Returns an iterable suitable for unpacking; entries are
    :class:`session.BashEntry` instances but the helper does not import that
    type to keep this module light at hook-cold-start time.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []
    candidates = [
        e for e in bash_history.values()
        if (getattr(e, "stdout_bytes", 0) + getattr(e, "stderr_bytes", 0))
        >= _MIN_BASH_BYTES_FOR_MANIFEST
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_BASH_ENTRIES, candidates, key=_BY_BASH_TS)


def _format_bash_entry(entry: object) -> str:
    """Render one :class:`session.BashEntry` as a single manifest line.

    Format::

        - $ pytest -v tests/  (exit 1, 12.3KB, id=abc123def...)

    The cache ID is included so the compaction LLM hands the agent something
    actionable — the agent can call ``token-goat bash-output <id>`` to recover
    the full body instead of re-running.  Byte counts use a compact human
    suffix (KB/MB) because the raw integer (``12345``) is harder to scan in a
    glance-level summary.
    """
    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    total = int(getattr(entry, "stdout_bytes", 0)) + int(getattr(entry, "stderr_bytes", 0))
    exit_code = getattr(entry, "exit_code", None)
    output_id = getattr(entry, "output_id", "")
    truncated_marker = " (truncated)" if getattr(entry, "truncated", False) else ""
    exit_str = "exit ?" if exit_code is None else f"exit {exit_code}"
    return (
        f"- $ {cmd_preview}  "
        f"({exit_str}, {_humanize_bytes(total)}{truncated_marker}, id={output_id})"
    )


def _humanize_bytes(n: int) -> str:
    """Return a short human-readable byte count: ``1.2KB``, ``3.4MB``, ``120B``.

    Compact (no spaces, two significant digits) so it fits inside a manifest
    line without competing with the command preview for visual space.  Sizes
    below 1024 use plain bytes; above that we step through KB/MB at 1024-byte
    boundaries.  GB is not represented because the on-disk store caps each
    entry at 2 MB before any truncation marker is applied — values higher than
    a few MB indicate the *original* output size, not the stored bytes, but
    even then GB-scale captures are not realistic for a Bash command surfaced
    in the manifest.
    """
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n / (1024 * 1024):.1f}MB"


def _select_top_grep_entries(greps: list[object]) -> list[object]:
    """Pick up to :data:`_MAX_GREP_ENTRIES` most-recent unique grep patterns.

    Deduplicates by ``(pattern, path)`` keeping the most recent occurrence of
    each pair — repeated searches for the same pattern clutter the manifest
    without adding information.  Returns entries ranked by recency so the
    patterns most likely to drive the next agent turn appear first.

    Accepts the ``greps`` attribute typed as ``list[object]`` (rather than
    ``list[GrepEntry]``) to avoid importing :class:`session.GrepEntry` at
    cold-start time; all field access is via :func:`getattr`.
    """
    if not greps:
        return []
    # Deduplicate by pattern text: iterate oldest→newest so the most-recent
    # search (with its current path scope and result_count) overwrites earlier
    # ones.  Deduplicating by pattern alone (not pattern+path) avoids listing
    # the same search term twice just because the scope changed between runs.
    seen: dict[str, object] = {}
    for g in sorted(greps, key=lambda g: getattr(g, "ts", 0.0)):
        seen[getattr(g, "pattern", "")] = g
    candidates = list(seen.values())
    if not candidates:
        return []
    return heapq.nlargest(_MAX_GREP_ENTRIES, candidates, key=lambda g: getattr(g, "ts", 0.0))


def _format_grep_entry(entry: object) -> str:
    """Render one :class:`session.GrepEntry` as a single manifest line.

    Format::

        - `pattern` in src/token_goat/ (12 results)
        - `pattern` (0 results)        (zero = dead end, still informative)
        - `pattern` in src/            (when result_count is unknown)

    Single space before the count parens (was double) — saves ~1 token per
    entry × _MAX_GREP_ENTRIES, no information lost.  The "results" noun is
    kept because tests assert on the literal "N results" / "1 result" form
    and the singular distinction is load-bearing for compaction-LLM context.
    """
    pattern = sanitize_log_str(getattr(entry, "pattern", ""), max_len=80)
    path = getattr(entry, "path", None)
    result_count = getattr(entry, "result_count", None)
    path_str = f" in {_short_path(path)}" if path else ""
    if result_count is not None:
        noun = "result" if result_count == 1 else "results"
        count_str = f" ({result_count} {noun})"
    else:
        count_str = ""
    return f"- `{pattern}`{path_str}{count_str}"


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
    """Count tracked events (reads + greps + edits + bash runs) for a session.

    Bash invocations are counted alongside reads/greps/edits so a session
    whose only activity is a cached test run still clears the
    ``min_events`` threshold for compaction-manifest emission — that command's
    output is exactly what the manifest is meant to preserve.
    """
    cache = _load_session_cache(session_id, "event_count")
    if cache is None:
        return 0
    return (
        len(cache.files)
        + len(cache.greps)
        + len(cache.edited_files)
        + len(getattr(cache, "bash_history", {}) or {})
    )


def _build_manifest_from_cache(
    cache: SessionCache,
    session_id: str,
    max_tokens: int,
) -> str:
    """Render the manifest from an already-loaded *cache*.

    Separated from :func:`build_manifest` so :func:`build_manifest_with_count`
    can share the render + log path without a second disk load.
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
    _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id[:8], max_tokens)
    cache = _load_session_cache(session_id, "build_manifest")
    if cache is None:
        return ""
    return _build_manifest_from_cache(cache, session_id, max_tokens)


def build_manifest_with_count(
    session_id: str,
    *,
    max_tokens: int = 400,
) -> tuple[str, int]:
    """Load the session cache once and return ``(manifest, event_count)``.

    Callers that need both values (e.g. the PreCompact hook, which checks the
    event count before deciding whether to inject the manifest) should prefer
    this function over calling :func:`event_count` and :func:`build_manifest`
    separately — the separate calls each deserialize the session JSON from disk,
    paying the I/O and parse cost twice for every compaction trigger.

    Returns ``("", 0)`` when the session cache is missing or unreadable.
    """
    _LOG.debug("build_manifest_with_count: session=%s max_tokens=%d", session_id[:8], max_tokens)
    cache = _load_session_cache(session_id, "build_manifest_with_count")
    if cache is None:
        return "", 0
    n_events = len(cache.files) + len(cache.greps) + len(cache.edited_files)
    manifest = _build_manifest_from_cache(cache, session_id, max_tokens)
    return manifest, n_events


def _render(cache: SessionCache, session_id: str, max_tokens: int) -> tuple[str, int]:
    """Build the Markdown session manifest string from *cache* for the PreCompact hook.

    Priority order:
    1. **Edited files** — always listed first; the compaction LLM must preserve these.
    2. **Symbols accessed** — files where specific symbols were read via ``token-goat read``.
       Ranked by ``last_read_ts`` (most-recent first), not insertion order, so the
       symbols a user just inspected take precedence over symbols touched earlier.
    3. **Key files read** — top files by ``read_count`` (most re-read first).
       Files that already appear in the Edited section are excluded here to avoid
       wasting budget on duplicate entries.

    Each manifest line is prefixed with an activity marker so the compaction LLM
    can distinguish edited (``✎``) from read-only (``→``) files — edited files
    represent ongoing work and must always survive compaction, whereas a file
    read once for context can be safely summarised.

    Noise paths (``.pyc``, ``__pycache__/``, lockfiles, OS metadata, build dirs)
    are filtered out before any ranking so the budget is spent on entries the
    compaction LLM can actually use.  See :func:`is_noise_path` for the full
    deny-list.

    If the rendered manifest exceeds *max_tokens*, lines are trimmed from the
    bottom until the budget is met, preserving the highest-priority sections.
    Returns a (manifest_string, symbols_files_count) tuple.  The string is empty
    when the cache has no meaningful data (nothing edited, no symbols accessed,
    no files read).
    """
    # Filter noise paths out of both maps before any other work.
    # Build artifacts, lockfiles, and cache dirs eat manifest budget for items the
    # compaction LLM can't usefully preserve.  Filter once up-front so every
    # downstream selection (top_files, files_with_symbols, edited_files) inherits
    # the cleaned input — no need to repeat the predicate per-section.
    # Defensive: legacy/test fixtures sometimes hand us a list for edited_files
    # rather than a dict; guard with isinstance so the filter never KeyErrors.
    raw_edited = cache.edited_files if isinstance(cache.edited_files, dict) else {}
    edited_clean: dict[str, int] = {
        path: count for path, count in raw_edited.items()
        if not is_noise_path(path)
    }
    files_clean: dict[str, FileEntry] = {
        key: entry for key, entry in cache.files.items()
        if not is_noise_path(entry.rel_or_abs) and not is_noise_path(key)
    }
    noise_skipped = (
        (len(raw_edited) - len(edited_clean))
        + (len(cache.files) - len(files_clean))
    )
    if noise_skipped:
        _LOG.debug(
            "_render: filtered %d noise path(s) from manifest input (session=%s)",
            noise_skipped, session_id[:8],
        )

    # Nothing to report when the session has no activity at all.
    # edited_files covers writes; files covers reads; greps covers searches.
    # All three empty means the manifest would be just the header — not worth injecting.
    raw_greps = getattr(cache, "greps", None) or []
    if not edited_clean and not files_clean and not raw_greps:
        _LOG.info(
            "_render: manifest suppressed for session=%s "
            "(no activity tracked: edited=0 files_read=0 greps=0)",
            session_id[:8],
        )
        return "", 0

    # Normalised key set of edited files (lower-cased forward-slash form) so we can
    # de-dup the "Key Files Read" section against the "Files Edited" section.
    # An edited file is *already* flagged as must-preserve in the edited section;
    # listing it a second time under Key Files Read wastes budget without adding
    # signal.  We compare normalised forms because edited_files keys come from
    # session._normalize_path() and files-dict keys come from the same helper —
    # but the rel_or_abs display strings differ (relative vs. absolute), so we
    # match on the dict keys, not the display path.
    edited_keys = {p.replace("\\", "/").lower() for p in edited_clean}

    # Files where the agent has a cached read that predates a subsequent edit —
    # the snapshot in context may no longer match the file on disk.
    stale_read_files: list[str] = [
        entry.rel_or_abs
        for key, entry in files_clean.items()
        if getattr(entry, "last_edit_ts", 0.0) > entry.last_read_ts
        and key.replace("\\", "/").lower() not in edited_keys
    ]

    # Rank "Symbols Accessed" by most-recent read first.  When a long session
    # touches many files, the *recent* symbols are more load-bearing for the
    # upcoming compaction than ones inspected at the start.  Previously we used
    # insertion order (whatever dict-iteration gave us), which is arbitrary and
    # often dumps the earliest reads into the manifest while burying the latest.
    files_with_symbols_all = [
        e for e in files_clean.values()
        if e.symbols_read
    ]
    files_with_symbols = heapq.nlargest(
        _MAX_SYMBOLS_FILES, files_with_symbols_all, key=_BY_LAST_READ_TS
    )
    files_with_symbols_count = len(files_with_symbols)

    # Most-frequently-read files, capped at _MAX_FILES_READ, for the "Key Files Read" section.
    # heapq.nlargest is O(n log k) instead of O(n log n) full sort — material when a
    # long session has hundreds of file entries but we only need the top 10.
    # The heap keeps only k items in memory, so this is also more memory-efficient
    # than sorting the full list when sessions accumulate many hundreds of file reads.
    # We exclude files that already appear in the Edited section: those are pinned
    # at higher priority and re-listing them duplicates manifest budget.
    total_files_read = len(files_clean)
    key_files_candidates = [
        entry for key, entry in files_clean.items()
        if key.replace("\\", "/").lower() not in edited_keys
    ]
    top_files = heapq.nlargest(_MAX_FILES_READ, key_files_candidates, key=_BY_READ_COUNT_THEN_TS)
    _LOG.debug(
        "_render: selected top %d/%d files by read_count+ts (cap=%d); "
        "files_with_symbols=%d edited=%d noise_skipped=%d",
        len(top_files),
        total_files_read,
        _MAX_FILES_READ,
        files_with_symbols_count,
        len(edited_clean),
        noise_skipped,
    )

    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    sid = session_id[:8]
    sections: list[str] = [
        "## Token-Goat Session Manifest",
        f"Session: {sid}  |  {now}",
        # Legend tells the compaction LLM what the prefixes mean — single line,
        # ~12 tokens — pays back many times over by making the markers unambiguous.
        "Legend: edited=✎  read=→  stale=⚠  cold=❄",
        "",
    ]

    # ── 1. Edited files — highest priority ────────────────────────────────────
    if edited_clean:
        sections.append("### Files Edited (preserve in summary)")
        # Sort by edit count descending so the most-touched files appear first.
        for path, count in sorted(edited_clean.items(), key=_BY_EDIT_COUNT, reverse=True):
            sections.append(f"- ✎ {_short_path(path)}{_count_suffix(count)}")
        sections.append("")

    # ── 1b. Stale file snapshots — read before a subsequent edit ─────────────
    # Warn the compaction LLM that these cached reads are outdated so it does
    # not preserve the old snapshot as if it reflects current file state.
    if stale_read_files:
        sections.append("### Outdated File Snapshots (edited after last read — discard old copy)")
        for path in stale_read_files[:6]:
            sections.append(f"- ⚠ {_short_path(path)}")
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

    # ── 3. Commands run (cached Bash output worth recalling) ──────────────────
    # Surfacing the most recent meaningful Bash invocations preserves the
    # test/build context that drives the next agent turn.  Each entry quotes
    # the cache ID so the agent can retrieve the full body via
    # `token-goat bash-output <id>` instead of re-running the command.
    bash_entries = _select_top_bash_entries(getattr(cache, "bash_history", None))
    if bash_entries:
        sections.append("### Commands Run (cached output)")
        for be in bash_entries:
            sections.append(_format_bash_entry(be))
        sections.append("")

    # ── 4. Grep patterns searched ─────────────────────────────────────────────
    # Surface the most-recent distinct patterns so the compaction LLM knows
    # what the user was investigating — not just which files were open.
    # Distinct-by-pattern count is the right baseline for the truncation tail:
    # _select_top_grep_entries() dedups before capping, so reporting the raw
    # grep count would double-count repeated searches for the same pattern.
    grep_entries = _select_top_grep_entries(raw_greps)
    if grep_entries:
        distinct_patterns = len({getattr(g, "pattern", "") for g in raw_greps})
        sections.append("### Patterns Searched")
        for ge in grep_entries:
            sections.append(_format_grep_entry(ge))
        dropped_greps = distinct_patterns - len(grep_entries)
        if dropped_greps > 0:
            sections.append(f"- …+{dropped_greps} more patterns")
        sections.append("")

    # ── 4b. Cold outputs (old cached Bash runs, safe to drop from context) ────
    # Outputs older than _COLD_OUTPUT_AGE_SECS are unlikely to be the active
    # iteration target.  Listing their IDs lets the compaction LLM mark them
    # evictable while still giving the agent a recall path via bash-output.
    now_ts = time.time()
    bash_hist_raw = getattr(cache, "bash_history", None) or {}
    cold_candidates = sorted(
        [
            be for be in bash_hist_raw.values()
            if (now_ts - getattr(be, "ts", now_ts)) > _COLD_OUTPUT_AGE_SECS
            and (getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0))
            >= _MIN_BASH_BYTES_FOR_MANIFEST
        ],
        key=lambda be: getattr(be, "ts", 0.0),
        reverse=True,
    )
    cold_outputs = cold_candidates[:_MAX_COLD_OUTPUTS]
    if cold_outputs:
        # Header carries the recall instruction once.  Per-line `id=` prefix is
        # redundant when every line already trails a backticked id — strip it
        # to save ~2 tokens per entry × _MAX_COLD_OUTPUTS (matches the recovery
        # hint convention established in iter 3).
        sections.append("### Cold Outputs (safe to evict — recall via `token-goat bash-output <id>`)")
        for be in cold_outputs:
            age_min = int((now_ts - getattr(be, "ts", now_ts)) / 60)
            total = getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
            oid = sanitize_log_str(getattr(be, "output_id", "?"), max_len=24)
            prev = sanitize_log_str(getattr(be, "cmd_preview", "?"), max_len=60)
            sections.append(
                f"- ❄ `{prev}` ({_humanize_bytes(total)}, {age_min}min old) `{oid}`"
            )
        dropped_cold = len(cold_candidates) - len(cold_outputs)
        if dropped_cold > 0:
            sections.append(f"- …+{dropped_cold} more cold outputs")
        sections.append("")

    # ── 5. Key files read (top N by read_count+ts) ────────────────────────────
    if top_files:
        sections.append("### Key Files Read")
        for entry in top_files:
            ranges_str = _format_ranges(entry.line_ranges)
            sections.append(
                f"- → {_short_path(entry.rel_or_abs)}{_count_suffix(entry.read_count)}{ranges_str}"
            )
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
