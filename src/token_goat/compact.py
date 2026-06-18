"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

__all__ = [
    "build_manifest",
    "build_manifest_with_count",
    "build_manifest_adaptive",
    "compute_adaptive_budget",
    "_compute_budget_multiplier",
    "event_count",
    "is_noise_path",
    "_dedup_grep_entries",
    "CONTEXT_AUTOCOMPACT_TOKENS",
    "CATALOG_TOKENS",
    "CONTEXT_TIER_WARM",
    "CONTEXT_TIER_HOT",
    "CONTEXT_TIER_CRITICAL",
    "tier_for_fraction",
    "ContextPressure",
    "get_context_pressure",
    "_build_sealed_block",
    "_format_hint_telemetry",
    "_get_inline_diff_for_file",
    "_get_whole_repo_diff",
    "_extract_test_failures",
    "_extract_dep_changes",
    "_format_session_stats",
    "_score_manifest",
    "_score_manifest_breakdown",
    "_parse_manifest_sections",
    "_MANIFEST_THIN_THRESHOLD",
    "_TOP_FILES_GUARANTEED_MIN",
    "find_latest_session_id",
    "infer_session_goal",
    "_enforce_char_budget",
    "detect_harness",
    "get_auto_trigger_multiplier",
]

import hashlib
import heapq
import io
import json
import math
import os
import re
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from operator import attrgetter, itemgetter
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, Literal, TypeVar
from urllib.parse import urlparse

from . import paths
from .cache_common import short_content_hash as _short_content_hash
from .cache_common import short_output_id as _short_id
from .config import Config as _Config
from .config import load as _load_config
from .hooks_common import sanitize_log_str
from .util import _humanize_bytes, ellipsize, get_logger
from .util import run_git_silent as _run_git


def __getattr__(name: str) -> object:
    """Lazy-load heavy submodules on first attribute access.

    ``session_mod`` is deferred so importing ``compact`` during the PreCompact
    hook cold-start does not pay the cost of loading ``session`` (and its
    transitive deps) until the first actual call to ``build_manifest`` /
    ``event_count``.  Saves ~25 ms on Windows cold-subprocess startup.

    The attribute is intentionally NOT written back to the module dict so that
    ``unittest.mock.patch("token_goat.compact.session_mod.X")`` continues to
    work: patch resolves the target by calling ``getattr(compact_mod,
    "session_mod")`` on each enter/exit, which goes through ``__getattr__``
    every time — no stale reference is cached in the module namespace.
    """
    if name == "session_mod":
        from . import session as _session  # noqa: PLC0415
        return _session
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _norm_key(path: object) -> str:
    """Return the case-insensitive normalized path key used in compact lookups."""
    return paths.normalize_key(str(path)).lower()


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~3 chars/token (conservative vs. the true 3.5 ratio).

    Inlined from repomap.estimate_tokens to avoid loading repomap (and its db
    dependency) during the PreCompact hook cold-start, which runs as a separate
    Python process on Windows with no shared module cache.
    """
    return max(1, len(text) // 3 + 1)


_LOG = get_logger("compact")

# ---------------------------------------------------------------------------
# Context pressure constants
# ---------------------------------------------------------------------------

#: The token count at which Claude Code auto-compacts the conversation.
#: All context-fill fraction computations divide by this value.
CONTEXT_AUTOCOMPACT_TOKENS: Final[int] = 660_000

#: Estimated tokens consumed by the skill catalog listing injected by token-goat
#: (one entry per available skill × ~6 tokens, ~1,800 skills).
CATALOG_TOKENS: Final[int] = 10_800

#: Context-fill fraction boundaries separating the four pressure tiers.  These
#: are the single source of truth for tier semantics: ``get_context_pressure``,
#: the pre-read hint thresholds, and the pre-skill advisory all key off them
#: (directly or via :func:`tier_for_fraction`).  A fill at or above each bound
#: promotes to the next tier:
#:   fill <  CONTEXT_TIER_WARM      → "cool"
#:   CONTEXT_TIER_WARM     ≤ fill   → "warm"
#:   CONTEXT_TIER_HOT      ≤ fill   → "hot"
#:   CONTEXT_TIER_CRITICAL ≤ fill   → "critical"
CONTEXT_TIER_WARM: Final[float] = 0.50
CONTEXT_TIER_HOT: Final[float] = 0.70
CONTEXT_TIER_CRITICAL: Final[float] = 0.85


def tier_for_fraction(fill: float) -> Literal["cool", "warm", "hot", "critical"]:
    """Map a context-fill *fraction* to its qualitative pressure tier.

    The boundaries are the module-level ``CONTEXT_TIER_*`` constants.  This is
    the single canonical fraction→tier mapping; ``get_context_pressure`` and any
    other caller that needs a tier from a raw fraction must route through here so
    tier semantics never drift between call sites.

    Args:
        fill: Context-fill fraction in [0.0, ∞).  Values above 1.0 simply map to
            ``"critical"`` (no clamping is needed — the comparisons are monotone).

    Returns:
        One of ``"cool"``, ``"warm"``, ``"hot"``, ``"critical"``.
    """
    if fill >= CONTEXT_TIER_CRITICAL:
        return "critical"
    if fill >= CONTEXT_TIER_HOT:
        return "hot"
    if fill >= CONTEXT_TIER_WARM:
        return "warm"
    return "cool"


@dataclass(frozen=True)
class ContextPressure:
    """Snapshot of estimated context fill at a point in time.

    Attributes:
        fill_fraction: Fraction of the autocompact budget consumed [0.0, ∞).
            Values > 1.0 are clamped when computing the tier but the raw value
            is preserved for diagnostics.
        tier: Qualitative tier derived from *fill_fraction*.
            ``cool``  < 50 %  — context is comfortable.
            ``warm``  50–70 % — approaching midpoint; monitor.
            ``hot``   70–85 % — elevated pressure; prefer surgical reads.
            ``critical`` ≥ 85 % — compact soon; lower every hint threshold.
    """

    fill_fraction: float
    tier: Literal["cool", "warm", "hot", "critical"]


def _pressure_raw_total(cache: object) -> int:  # type: ignore[name-defined]  # SessionCache
    """Return the raw (pre-baseline-subtraction) context pressure total for *cache*.

    Separated from get_context_pressure so pre_compact can snapshot the total
    before resetting it as the new baseline.
    """
    skill_tokens: int = getattr(cache, "loaded_skill_total_tokens", 0)
    observed: int = getattr(cache, "observed_tool_tokens", 0)
    if observed > 0:
        # Measured path: actual response bytes accumulated by post-hooks (len(text)//4 per call).
        return skill_tokens + CATALOG_TOKENS + observed
    # Legacy fallback: per-count proxies for sessions without measured token data.
    bash_history = getattr(cache, "bash_history", None)
    bash_count: int = len(bash_history) if bash_history else 0
    web_history = getattr(cache, "web_history", None)
    web_count: int = len(web_history) if web_history else 0
    files = getattr(cache, "files", None)
    read_count: int = len(files) if files else 0
    return (
        skill_tokens
        + CATALOG_TOKENS
        + bash_count * 500
        + web_count * 1_000
        + read_count * 200
    )


def get_context_pressure(  # type: ignore[name-defined]  # SessionCache imported under TYPE_CHECKING
    session_id: str | None = None,
    *,
    cache: SessionCache | None = None,
) -> ContextPressure:
    """Return the estimated context fill fraction and pressure tier.

    Sums all known context contributors from the session cache:

    * ``loaded_skill_total_tokens`` — skill bodies loaded via PostToolUse(Skill)
    * ``CATALOG_TOKENS`` (10,800) — constant overhead for the skill catalog
    * ``bash_history`` entries × 500 tokens each
    * ``web_history`` entries × 1,000 tokens each
    * ``read_paths`` (``files`` dict) entries × 200 tokens each

    Divides by ``CONTEXT_AUTOCOMPACT_TOKENS`` (660,000) — the budget at which
    Claude Code triggers auto-compaction, *not* the full model window — to get
    a fill fraction, then maps to a tier via :func:`tier_for_fraction` using the
    ``CONTEXT_TIER_*`` boundary constants:

        cool     < 0.50
        warm     0.50 – 0.70
        hot      0.70 – 0.85
        critical ≥ 0.85

    Returns a ``ContextPressure`` with ``fill_fraction=0.0`` and ``tier="cool"``
    when the session cache is unavailable or the session_id is None.

    The optional *cache* keyword argument accepts an already-loaded
    :class:`session.SessionCache`.  When provided, the function skips the
    ``safe_load`` disk read — callers that have already loaded the cache (e.g.
    :func:`build_manifest_adaptive`, ``user_prompt_submit``) should pass it to
    avoid a redundant JSON parse.

    This function is the single canonical implementation.  All other context-fill
    estimates in the codebase (``_estimate_context_fill`` in ``hooks_skill``, the
    inline calculation in ``hooks_session``) delegate here.
    """
    try:
        from . import session as _ses  # noqa: PLC0415

        if cache is None:
            cache = _ses.safe_load(session_id, caller="get-context-pressure") if session_id else None
        if cache is None:
            return ContextPressure(fill_fraction=0.0, tier="cool")

        raw_total = _pressure_raw_total(cache)
        baseline: int = getattr(cache, "pressure_baseline_tokens", 0)
        total = max(0, raw_total - baseline)
        window = CONTEXT_AUTOCOMPACT_TOKENS
        fill = total / window

        return ContextPressure(fill_fraction=fill, tier=tier_for_fraction(fill))
    except Exception:  # noqa: BLE001
        return ContextPressure(fill_fraction=0.0, tier="cool")


# ---------------------------------------------------------------------------
# Harness detection
# ---------------------------------------------------------------------------

#: Known harness identifiers returned by :func:`detect_harness`.
_KNOWN_HARNESSES: Final[frozenset[str]] = frozenset(
    ["claudecode", "codex", "opencode", "generic"]
)

#: Per-harness default multipliers for auto_trigger_multiplier.
#: These are used when the user has not explicitly set a multiplier in config.
#: - claudecode: 2.0x — large context window, aggressive auto-compaction benefits from larger manifests
#: - codex: 1.5x — moderate context, less aggressive compaction
#: - opencode: 2.5x — can handle more context via output.context.push()
#: - generic: 1.0x — unknown harness, minimal boost
_HARNESS_MULTIPLIER_DEFAULTS: Final[dict[str, float]] = {
    "claudecode": 2.0,
    "codex": 1.5,
    "opencode": 2.5,
    "generic": 1.0,
}


def detect_harness(config_override: str = "auto") -> str:
    """Detect the active AI harness from environment variables.

    When *config_override* is not ``"auto"``, returns it directly (allows the
    user to pin the harness via ``[compact_assist] harness = "codex"``).

    Detection order:
    0. ``TOKEN_GOAT_HARNESS_OVERRIDE`` env var → use that value directly (CI /
       test environments that need a deterministic harness without injecting
       harness-specific secrets like ``ANTHROPIC_API_KEY``).
    1. ``CLAUDE_CODE_SESSION_ID`` or ``ANTHROPIC_API_KEY`` → ``"claudecode"``
    2. ``CODEX_SESSION`` env var present → ``"codex"``
    3. ``OPENAI_API_KEY`` present without ``ANTHROPIC_API_KEY`` → ``"codex"``
    4. ``OPENCODE_SESSION`` env var present → ``"opencode"``
    5. Fallback → ``"generic"``

    Returns one of: ``"claudecode"``, ``"codex"``, ``"opencode"``, ``"generic"``.
    """
    if config_override != "auto":
        if config_override in _KNOWN_HARNESSES:
            return config_override
        _LOG.warning(
            "detect_harness: unknown override %r; falling back to env detection",
            config_override,
        )

    # Explicit override for CI / test environments — takes precedence over all
    # other env-var probes so CI doesn't need to inject harness-specific secrets.
    _harness_override = os.environ.get("TOKEN_GOAT_HARNESS_OVERRIDE", "").strip().lower()
    if _harness_override in _KNOWN_HARNESSES:
        return _harness_override
    if _harness_override:
        _LOG.warning(
            "detect_harness: TOKEN_GOAT_HARNESS_OVERRIDE=%r not a known harness; ignoring",
            _harness_override,
        )

    # Claude Code: specific session ID env var or Anthropic API key
    if os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("ANTHROPIC_API_KEY"):
        return "claudecode"

    # Codex: explicit session flag
    if os.environ.get("CODEX_SESSION"):
        return "codex"

    # opencode: explicit session flag
    if os.environ.get("OPENCODE_SESSION"):
        return "opencode"

    # OpenAI key without Anthropic key → most likely Codex
    if os.environ.get("OPENAI_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        return "codex"

    return "generic"


def get_auto_trigger_multiplier(
    config_explicit_multiplier: float | None = None,
    harness: str | None = None,
    is_config_default: bool | None = None,
) -> float:
    """Get the effective auto_trigger_multiplier for the detected harness.

    When the user has not explicitly configured auto_trigger_multiplier (is still
    at the default 2.0), applies per-harness defaults. When the user has explicitly
    set a value, that value is always used.

    Args:
        config_explicit_multiplier: The multiplier value from config
            (CompactAssistConfig.auto_trigger_multiplier). Should always be provided.
        harness: The detected harness name (e.g., "claudecode"). If None,
            detect_harness() is called to determine it.
        is_config_default: When True, treat the config_explicit_multiplier as the
            default value (so per-harness defaults apply). When False, treat it as
            user-configured (so the value is used as-is). When None (default), auto-detect:
            if config_explicit_multiplier == 2.0 (the hardcoded default in config.py),
            assume it's the default and apply per-harness logic. Otherwise, assume the
            user set it explicitly.

    Returns:
        The effective multiplier value (clamped to [1.0, 10.0]).
    """
    # Determine if the config value is the default or user-configured
    if is_config_default is None:
        # Auto-detect: 2.0 is the hardcoded default in CompactAssistConfig
        is_config_default = (config_explicit_multiplier == 2.0)

    # If the user explicitly set a non-default value, use it
    if not is_config_default and config_explicit_multiplier is not None:
        return max(1.0, min(10.0, config_explicit_multiplier))

    # The user did not configure it (still at default), so use per-harness defaults
    # Determine the harness if not provided
    if harness is None:
        harness = detect_harness()

    # Look up the per-harness default
    default_multiplier = _HARNESS_MULTIPLIER_DEFAULTS.get(harness, 1.0)
    return max(1.0, min(10.0, default_multiplier))


def infer_session_goal(cache: object, max_tokens: int = 80) -> str:
    """Infer the session's goal from edited files, accessed symbols, and recent bash commands.

    Returns a factual 1-2 sentence description of what the session was trying to accomplish,
    or an empty string if insufficient data exists (fewer than 2 edited files and no symbols).

    The inference combines three signals:
    1. **Edited files**: area/component being modified (extracted from paths)
    2. **Top symbols**: key functions/classes being accessed (top 3 by count)
    3. **Recent git commits**: intent from latest commit messages in bash history

    All analysis is mechanical string construction — no LLM call.  Returns "" when there
    is insufficient context (< 2 edited files and no symbols accessed).

    Args:
        cache: A :class:`session.SessionCache` or cache-like object with ``edited_files``,
               ``symbol_access_counts``, and ``bash_history`` attributes.
        max_tokens: Target maximum token count for the goal text (default 80).
                   Used to keep the goal concise and suitable for a one-liner context header.

    Returns:
        A single-sentence or two-sentence goal description, or "" if insufficient data.
        Examples:
          "Working on async refactoring in core/async, focusing on EventLoop and AsyncTask."
          "Fixing authentication tests in tests/auth, improving login and session handling."
    """
    try:
        import re as _re  # noqa: PLC0415
        from pathlib import Path as _Path  # noqa: PLC0415

        # Extract data from cache with defensive getattr.
        edited_files_raw = getattr(cache, "edited_files", None) or {}
        symbol_access_raw = getattr(cache, "symbol_access_counts", None) or {}
        bash_hist = getattr(cache, "bash_history", None) or {}

        # Gate: need at least 2 edited files OR symbols to infer a goal
        if len(edited_files_raw) < 2 and len(symbol_access_raw) == 0:
            return ""

        # --- Signal 1: Extract area/component from edited file paths ---
        # Group edited files by directory; count files per dir
        dir_counts: dict[str, int] = {}
        for fpath in edited_files_raw:
            try:
                parent = str(_Path(str(fpath)).parent)
                # Normalize: strip leading ./
                if parent.startswith("."):
                    parent = parent[2:].lstrip("/\\") or "root"
                if parent:
                    dir_counts[parent] = dir_counts.get(parent, 0) + 1
            except Exception:  # noqa: BLE001
                _LOG.debug("_build_session_topic: failed to parse path %r (skip)", fpath, exc_info=True)

        # Pick the top directory (most edits there = likely focus area)
        top_area = ""
        if dir_counts:
            top_area = max(dir_counts, key=lambda k: dir_counts[k])

        # --- Signal 2: Top 3 symbols by access count ---
        top_symbols: list[str] = []
        if symbol_access_raw:
            sorted_syms = sorted(symbol_access_raw.items(), key=itemgetter(1), reverse=True)
            top_symbols = [sym for sym, _ in sorted_syms[:3]]

        # --- Signal 3: Recent git commit messages and bash work patterns ---
        recent_commits: list[str] = []
        # Classify bash commands to infer the dominant work mode.
        # Each category gets a counter; the most frequent wins if no commit message is found.
        work_mode_counts: dict[str, int] = {
            "testing": 0,
            "linting": 0,
            "type-checking": 0,
            "building": 0,
            "reviewing": 0,
        }
        _BASH_WORK_PATTERNS: list[tuple[str, str]] = [
            # Testing
            ("pytest", "testing"),
            ("python -m pytest", "testing"),
            ("uv run pytest", "testing"),
            ("npm test", "testing"),
            ("cargo test", "testing"),
            # Linting / formatting
            ("ruff", "linting"),
            ("flake8", "linting"),
            ("eslint", "linting"),
            ("prettier", "linting"),
            # Type checking
            ("mypy", "type-checking"),
            ("pyright", "type-checking"),
            ("tsc", "type-checking"),
            # Building / dependency management
            ("uv sync", "building"),
            ("pip install", "building"),
            ("npm install", "building"),
            ("cargo build", "building"),
            # Code review / inspection
            ("git diff", "reviewing"),
            ("git log", "reviewing"),
            ("git show", "reviewing"),
        ]
        for entry in bash_hist.values():
            cmd = getattr(entry, "cmd_preview", "").strip()
            cmd_lower = cmd.lower()
            if cmd_lower.startswith("git commit"):
                # Extract commit message via -m flag or similar
                # Pattern: git commit -m "message" or git commit ... -m "message"
                m = _re.search(r'-m\s+["\']([^"\']+)["\']', cmd)
                if m:
                    msg = m.group(1).strip()
                    if msg:
                        recent_commits.append(msg[:60])  # truncate long messages
            else:
                for prefix, mode in _BASH_WORK_PATTERNS:
                    if cmd_lower.startswith(prefix) or f" {prefix}" in cmd_lower:
                        work_mode_counts[mode] += 1
                        break
        recent_commits = recent_commits[:2]  # keep last 2 commits

        # Pick dominant work mode (if any mode has >= 2 occurrences it adds signal).
        dominant_mode = ""
        max_mode_count = max(work_mode_counts.values(), default=0)
        if max_mode_count >= 2:
            dominant_mode = max(work_mode_counts, key=lambda k: work_mode_counts[k])

        # --- Build the goal sentence ---
        parts: list[str] = []

        # Base: "Working on {area}" or "Focusing on {symbols}"
        if top_area and top_symbols:
            parts.append(f"Working on {top_area}, focusing on {' and '.join(top_symbols[:2])}.")
        elif top_area:
            parts.append(f"Working on changes in {top_area}.")
        elif top_symbols:
            parts.append(f"Focusing on {' and '.join(top_symbols[:2])}.")

        # Append commit intent if available (adds 10-20 tokens)
        if recent_commits and len(" ".join(parts)) < max_tokens * 2:
            intent = recent_commits[0]
            parts.append(f"Recent work: {intent}.")
        elif dominant_mode and not recent_commits and len(" ".join(parts)) < max_tokens * 2:
            # No commit messages but a dominant bash work pattern gives useful context.
            parts.append(f"Session activity: {dominant_mode}.")

        goal = " ".join(parts)

        # Sanity trim: estimate token count (3 chars ≈ 1 token) and truncate if needed
        estimated_tokens = estimate_tokens(goal)
        if estimated_tokens > max_tokens and len(parts) > 1:
            # Simple truncation: drop the second sentence
            goal = parts[0]

        return goal.strip()

    except Exception:  # noqa: BLE001 — fail-soft: always return a safe default
        return ""

if TYPE_CHECKING:
    from collections.abc import Callable

    from .session import FileEntry, SessionCache
    from .session import FileEntry as _FileEntry


# Wall-clock timeout for build_manifest() to prevent the PreCompact hook from stalling.
# The function makes git subprocess calls which may hang on network mounts or large repos.
# This is a belt-and-suspenders guard: individual git subprocesses have their own 2-5s
# timeouts, but the overall function has an 8s wall-clock limit so the hook always
# returns within a reasonable time, even if multiple git calls run sequentially.
_MANIFEST_TIMEOUT_SECS: Final[float] = 8.0

# Maximum files listed in the "files read" section of the manifest.  The compaction
# LLM needs the most-accessed files to know what context mattered, but listing every
# file read in a long session would blow the token budget.  10 covers the handful of
# core files a typical feature or bug-fix session touches.
_MAX_FILES_READ: Final[int] = 10
# Guaranteed minimum of top-ranked key files that always appear in the manifest,
# regardless of section budget.  In long sessions the "Key Files Read" section may
# exhaust its budget before the most-accessed files are emitted.  The top-5 by
# importance_score are always included so the compaction LLM never loses the core
# working set — even when 50+ files have been read and the budget is tight.
_TOP_FILES_GUARANTEED_MIN: Final[int] = 5
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
# Maximum pending/in-progress TaskList entries shown in the ### TODOs section.
# Five covers the typical feature-branch task list without consuming too much of
# the manifest budget; additional tasks get an overflow note.
_MAX_TODO_ENTRIES: Final[int] = 5
# Max characters for a task subject in the manifest.  Subjects are user-authored
# strings of arbitrary length; truncating at 50 chars keeps each line short
# enough to fit the compact token budget without losing the essential meaning.
_MAX_TODO_SUBJECT_CHARS: Final[int] = 50
# Smallest cached Bash output worth surfacing in the manifest.  Below ~400 bytes
# the dedup hint suppresses on size anyway, and the manifest line itself costs
# tokens that would not be paid back even if the agent acted on the hint.
_MIN_BASH_BYTES_FOR_MANIFEST: Final[int] = 400

# Maximum FAILED test names extracted from pytest output for the
# "### Recent Test Failures" section.  10 covers the typical red-bar scenario
# without overwhelming the manifest with a long failure list.
_MAX_TEST_FAILURES: Final[int] = 10

# Maximum dependency change lines shown in the "### Dependency Changes" section.
# Package manager installs often list many packages; cap at 8 so the section
# stays within budget while still surfacing the most important changes.
_MAX_DEP_CHANGES: Final[int] = 8

# Maximum number of last bash command previews added to the MUST_PRESERVE
# sealed block for continuity.  Three covers the recent command context without
# bloating the sealed block beyond its 80-token cap.
_MAX_SEALED_BASH_CMDS: Final[int] = 3

# Maximum web fetches listed in the "Web Fetches" section of the manifest.
# Web fetches capture documentation, API responses, and external context the
# agent loaded mid-session.  Four entries cover the common case (fetch a docs
# page, maybe an API reference or two) without crowding the bash section.
_MAX_WEB_ENTRIES: Final[int] = 4
# Smallest cached web body worth surfacing in the manifest.  Small fetches
# (redirects, tiny JSON blobs) don't pay back the manifest line's token cost.
_MIN_WEB_BYTES_FOR_MANIFEST: Final[int] = 200

# Sentinel gap used by session.mark_file_read() when no line limit is specified.
# A range whose (end - start) equals this value represents "whole file read, extent
# unknown" — _format_ranges() annotates these as "(full)" rather than printing
# "lines 1-100000", so the compaction LLM knows the entire file was in context.
# Value mirrors session._UNKNOWN_END_SENTINEL (99_999); inlined here to avoid
# importing session at module level so the PreCompact hook cold-start stays fast.
_FULL_READ_SENTINEL_GAP: Final[int] = 99_999

# Files read this many times or more are "hot" — the model knows them intimately.
# Listing them individually wastes manifest lines on content the compaction LLM
# would never evict. Consolidate to a single summary line instead.
_HOT_FILE_READ_THRESHOLD: Final[int] = 5

# Maximum number of hot files shown by name in the consolidated summary line.
# Beyond this, a "+N more" suffix is appended so the line stays compact.
_HOT_FILE_MAX_SHOWN: Final[int] = 6

# Maximum glob patterns listed in the "Directory Scans" section.  Three entries
# cover the typical file-discovery queries without crowding higher-priority sections.
_MAX_GLOB_ENTRIES: Final[int] = 3

# Maximum grep patterns listed in the "Patterns Searched" section.  Grep entries
# give the compaction LLM context about what the user was investigating, but beyond
# 5 patterns the list becomes noise — the most-recently-searched ones dominate anyway.
_MAX_GREP_ENTRIES: Final[int] = 5

# Grep patterns older than this are considered stale and dropped from the manifest.
# 45 minutes is a practical session horizon: patterns from more than 45 minutes ago
# predate most recent context switches and carry little signal for the upcoming compact.
# If *all* patterns are older than this threshold, the 2 most recent are surfaced anyway
# so the section is never entirely empty when searches exist.
_GREP_STALE_SECS: Final[int] = 2700  # 45 minutes

# Kept for external callers (e.g. tests) that may reference the old name.  The new
# constant _GREP_STALE_SECS is the authoritative staleness threshold used internally.
_GREP_MANIFEST_STALE_SECS: Final[int] = _GREP_STALE_SECS

# Minimum number of grep entries to show even when all are stale.  Avoids rendering
# an empty "Patterns Searched" section when the session only has old searches.
_GREP_MIN_WHEN_ALL_STALE: Final[int] = 2

# Half-life used by the grep recency weight in _select_top_grep_entries.
# At age=0 weight=1.0; at age=30min weight≈0.5; at age=45min weight≈0.35.
# The weight is multiplied by a normalised match_count so high-result searches
# that are still recent beat zero-result searches of the same age.
_GREP_RECENCY_HALF_LIFE_SECS: Final[float] = 1800.0  # 30 minutes

# Hard ceiling on the max_tokens parameter accepted by build_manifest.
# The config layer sets a sensible default (400) but build_manifest is also part of
# the public API.  Without a cap, a caller could pass an arbitrarily large value,
# causing the manifest construction pass to allocate and render all sections before
# the trim loop brings it back down — a pointless memory/CPU spike with no benefit.
_MAX_MANIFEST_TOKENS_CAP: Final[int] = 4_000
# Directives appended after sidecar write — seen by the compaction LLM but excluded from the SHA/fingerprint.
_COMPACT_DIRECTIVES: Final[str] = ("\n### Compact Directives\n- `skill_listing` messages (the full available-skills list) are auto-regenerated at session start — replace each with: `[skill_listing: auto-injected]`\n- `hook_success` / `hook_error` messages are diagnostic telemetry — collapse all to: `[N hook events]`")
_DIRECTIVE_TOKEN_RESERVE: Final[int] = -(-len(_COMPACT_DIRECTIVES) // 3)  # ceiling div
# Minimum budget at which the boilerplate directives are appended. Below this the directives would consume a disproportionate share of the budget and crowd out the protected session payload (edited/read files) the manifest exists to preserve, so they are skipped entirely and the body keeps the full budget. Set to 2x the reserve so once directives DO attach the body still retains at least half the budget. Tying the reserve to actual append also fixes the prior bug where body_budget collapsed to 1 at tiny budgets while reserving 93 tokens for directives that the append gate then never added.
_DIRECTIVE_APPEND_MIN_TOKENS: Final[int] = 2 * _DIRECTIVE_TOKEN_RESERVE
# Token reserve for the stable "# as-of: YYYY-MM-DDTHH:MM:SSZ" suffix appended by
# build_manifest.  The suffix is ~32 chars ≈ 11 tokens; reserving it from body_budget
# ensures the total emitted manifest (body + directives + as-of) stays within max_tokens.
_AS_OF_TOKEN_RESERVE: Final[int] = 11
# Minimum variable-section budget (sec_budget_max) at which the wide-session map-pointer is guaranteed its own slot even when the proportional symbols slice is 0. The pointer summarizes ALL file access (not just symbol reads), so it must not be starved by an empty symbols section when the overall budget has room; below this floor the budget is tight enough that protected top-files take priority and the pointer defers to sym_budget.
_WIDE_POINTER_MIN_SECTION_BUDGET: Final[int] = 100
# Manifest delta-cache TTL (item #19).  If less than this many seconds have elapsed
# since the last emit AND the rendered text is byte-for-byte identical, return a
# brief stub instead of rebuilding.  Force a full rebuild after 10 min regardless.
_MANIFEST_CACHE_TTL_SECS: Final[float] = 600.0
# Process-local set of session IDs for which we wrote a new manifest SHA this
# process run.  On Windows Claude Code launches a fresh hook process per tool
# call, so this set is always empty at the start of a hook invocation — the
# cache-hit path is only reachable when the SHA was written by a *prior* process
# (i.e., a prior PreCompact fire).  In tests (same process, multiple calls) the
# set prevents a false stub on the call that immediately follows a write.
_manifest_sha_written_this_process: set[str] = set()

# ---------------------------------------------------------------------------
# Pre-compiled regex patterns used during manifest construction.
# ---------------------------------------------------------------------------
# Hoisted to module level so they are compiled once at import time rather than
# on every build_manifest() / _extract_* / _find_open_questions() call.

# Matches "FAILED tests/foo.py::ClassName::test_name" lines in pytest output.
_PYTEST_FAILED_RE: Final[re.Pattern[str]] = re.compile(
    r"FAILED\s+((?:tests?|src)[^\s]+::[\w\[\]<>-]+(?:::[\w\[\]<>-]+)*)",
    re.IGNORECASE,
)

# Package-manager install/update lines (pip/uv, npm, cargo, yarn).
_DEP_CHANGE_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"successfully installed\s+(.+)", re.IGNORECASE),
    re.compile(r"^\+\s+([\w@/-][\w@/.-]+)", re.MULTILINE),
    re.compile(r"added\s+\d+\s+package", re.IGNORECASE),
    re.compile(r"^\s*added\s+([\w@/-].+)", re.IGNORECASE | re.MULTILINE),
    re.compile(r"updated\s+([\w@/-].+)", re.IGNORECASE),
    re.compile(r"resolved\s+([\w@/-].+)", re.IGNORECASE),
    re.compile(r"compiling\s+([\w-]+)\s+v([\d.]+)", re.IGNORECASE),
)

# TODO/FIXME/WHY/HACK/XXX markers in source files.
_OPEN_QUESTION_MARKER_RE: Final[re.Pattern[str]] = re.compile(
    r"#\s*(TODO|FIXME|WHY|HACK|XXX)\b[:\s]*(.*?)(?:\s*$|\s*[#?])",
    re.IGNORECASE,
)
_OPEN_QUESTION_INLINE_RE: Final[re.Pattern[str]] = re.compile(r"#[^#]*\?(?:\s|$)")

# ---------------------------------------------------------------------------
# Manifest sidecar helpers (item #1 of 2026-05-24 design)
# ---------------------------------------------------------------------------
# The sidecar file ``sentinels/manifest_sha_{session_id}`` stores a small JSON
# record: {"sha": <hex>, "fp": <fingerprint-hex>, "ts": <float>}.  Reading it
# is ~0.1 ms (stat + open + json.loads on a 200-byte file) vs ~5–50 ms for a
# full manifest render, so the fast-path saves meaningful wall time as well as
# ~300–600 tokens per redundant compaction.

def _compute_manifest_fingerprint(cache: SessionCache) -> str:  # type: ignore[name-defined]  # SessionCache imported under TYPE_CHECKING; used only as annotation so safe at runtime with 'from __future__ import annotations'
    """Return a hex fingerprint that changes when manifest-driving state changes.

    The sidecar cache must invalidate when the session state that feeds the
    rendered manifest changes: file access details, edits, grep history, bash /
    web / skill / glob history, bash dedup exclusions, cwd, and the current
    age tier. Build-manifest bookkeeping fields are intentionally excluded.
    """

    def _entry_payload(entry: object) -> object:
        if hasattr(entry, "__dataclass_fields__"):
            entry_dict = asdict(entry)  # type: ignore[call-overload]  # entry typed as object; dataclass check above (hasattr __dataclass_fields__) guarantees asdict() works
            # Exclude symbols_ts from FileEntry — it changes on every symbol access
            # but doesn't affect the manifest output (only symbols_read matters).
            # This prevents unnecessary fingerprint cache invalidation.
            if isinstance(entry_dict, dict) and "symbols_ts" in entry_dict:
                entry_dict = {k: v for k, v in entry_dict.items() if k != "symbols_ts"}
            return entry_dict
        return entry

    def _dict_payload(mapping: object) -> dict[str, object]:
        if not isinstance(mapping, dict) or not mapping:
            return {}
        return {str(key): _entry_payload(mapping[key]) for key in sorted(mapping)}

    def _list_payload(items: object) -> list[object]:
        if not isinstance(items, list) or not items:
            return []
        return [_entry_payload(item) for item in items]

    now = time.time()
    created_ts = float(getattr(cache, "created_ts", 0.0) or 0.0)
    age_tier = _session_age_tier(max(0.0, now - created_ts))
    edited_files = cache.edited_files if isinstance(cache.edited_files, dict) else {}
    bash_dedup_ids = sorted(getattr(cache, "bash_dedup_emitted_ids", set()) or [])

    hints_emitted = int(getattr(cache, "hints_emitted", 0) or 0)
    _suppressed_raw = getattr(cache, "hints_suppressed_by_type", None) or {}
    hints_suppressed = sum(_suppressed_raw.values()) if isinstance(_suppressed_raw, dict) else 0

    # Explicit counts added alongside the full dicts: even if two sessions
    # produce identical compressed manifest text (same SHA), a difference in
    # edited_count or bash_count signals that meaningful activity happened and
    # the cache should be invalidated.  The dict payloads already capture this
    # information, but including the raw counts as a top-level key makes the
    # invalidation intent explicit and ensures fingerprint comparisons are
    # stable even when the dict serialization order changes.
    edited_count = len(edited_files)
    bash_count = len(getattr(cache, "bash_history", None) or {})

    payload = json.dumps(
        {
            "age_tier": age_tier,
            "bash_count": bash_count,
            "bash_dedup_emitted_ids": bash_dedup_ids,
            "bash_history": _dict_payload(getattr(cache, "bash_history", None)),
            "cwd": getattr(cache, "cwd", None),
            "decisions": _list_payload(getattr(cache, "decisions", None)),
            "edited_count": edited_count,
            "edited_files": sorted(edited_files.items()),
            "files": _dict_payload(getattr(cache, "files", None)),
            "glob_history": _list_payload(getattr(cache, "glob_history", None)),
            "greps": _list_payload(getattr(cache, "greps", None)),
            "hints_emitted": hints_emitted,
            "hints_suppressed": hints_suppressed,
            "skill_history": _dict_payload(getattr(cache, "skill_history", None)),
            "web_history": _dict_payload(getattr(cache, "web_history", None)),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# Sidecar payload version.  v1 = {sha, fp, ts}.  v2 adds {counts: {...}} for
# item #26 (Manifest Delta).  Bumping `_SIDECAR_VERSION` is how we ensure that
# legacy v1 sidecars are gracefully ignored when the reader expects v2 fields.
_SIDECAR_VERSION: Final[int] = 2


def _read_manifest_sidecar(
    session_id: str,
) -> tuple[str, str, float, dict[str, int] | None] | None:
    """Read the manifest sidecar and return (sha, fingerprint, emit_ts, counts) or None.

    *counts* is a small dict of section-element counts from the prior render
    (``{"edited": N, "bash": N, ...}``) used by item #26's Manifest Delta
    section, or ``None`` for v1 sidecars / when the field is absent / malformed.
    All other parse errors return ``None`` for the whole tuple.
    """
    from . import paths  # noqa: PLC0415

    try:
        sidecar = paths.manifest_sha_sidecar_path(session_id)
        raw = sidecar.read_text(encoding="utf-8")
        data = json.loads(raw)
        sha = str(data["sha"])
        fp = str(data["fp"])
        ts = float(data["ts"])
        # Non-finite ts (NaN, inf) would compare-false in every cache-hit
        # predicate but the upstream caller has no reason to inspect for it.
        # Treat the whole sidecar as unreadable to keep the contract simple
        # (returns None → caller rebuilds).  Empty sha/fp likewise indicate a
        # corrupted write — refuse to surface them as a cache key.
        import math  # noqa: PLC0415
        if not math.isfinite(ts) or not sha or not fp:
            return None
        # Best-effort extraction of v2 counts.  A v1 sidecar (no "counts" key)
        # OR a malformed counts dict yields counts=None — the caller falls back
        # to skipping the delta section, never crashes.
        counts_raw = data.get("counts")
        counts: dict[str, int] | None = None
        if isinstance(counts_raw, dict):
            try:
                counts = {str(k): int(v) for k, v in counts_raw.items()}
            except (TypeError, ValueError):
                counts = None
        return sha, fp, ts, counts
    except Exception:  # noqa: BLE001
        return None


def _write_manifest_sidecar(
    session_id: str,
    sha: str,
    fingerprint: str,
    ts: float,
    counts: dict[str, int] | None = None,
) -> None:
    """Write the manifest sidecar atomically.  Errors are silently swallowed.

    *counts* (item #26): per-section element counts emitted in the current
    manifest, persisted so the next compact can compute a "Δ since last compact"
    line.  Omitted (or empty) → no counts written, treated as v1-compatible.
    """
    from . import paths  # noqa: PLC0415

    try:
        sidecar = paths.manifest_sha_sidecar_path(session_id)
        paths.ensure_dir(sidecar.parent)
        payload_dict: dict[str, object] = {
            "v": _SIDECAR_VERSION,
            "sha": sha,
            "fp": fingerprint,
            "ts": ts,
        }
        if counts:
            payload_dict["counts"] = {k: int(v) for k, v in counts.items()}
        payload = json.dumps(payload_dict, separators=(",", ":"), sort_keys=True)
        paths.atomic_write_text(sidecar, payload)
    except Exception:  # noqa: BLE001
        pass


def _compute_section_counts(cache: object) -> dict[str, int]:
    """Return per-section element counts for the current cache snapshot.

    Used by item #26 (Manifest Delta) to persist a small fingerprint of "how
    much was in the manifest last time" so the next compact can show what grew.
    Defensive ``getattr`` calls so a legacy/test cache without one of these
    fields contributes 0 rather than raising.
    """
    def _len(obj: object) -> int:
        try:
            return len(obj)  # type: ignore[arg-type]  # obj typed as object; len() accepts Sized but mypy cannot narrow object to Sized without isinstance
        except (TypeError, AttributeError):
            return 0

    files: object = getattr(cache, "files", None) or {}
    return {
        "edited": _len(getattr(cache, "edited_files", None) or {}),
        "files": _len(files),
        "bash": _len(getattr(cache, "bash_history", None) or {}),
        "web": _len(getattr(cache, "web_history", None) or {}),
        "grep": _len(getattr(cache, "greps", None) or []),
        "glob": _len(getattr(cache, "glob_history", None) or []),
        "skill": _len(getattr(cache, "skill_history", None) or {}),
        "decision": _len(getattr(cache, "decisions", None) or []),
        "symbols": sum(
            1 for e in (files.values() if hasattr(files, "values") else [])  # type: ignore[union-attr]  # files is object; hasattr check above guarantees .values() is callable
            if getattr(e, "symbols_read", None)
        ),
    }


def _format_manifest_delta(
    prior: dict[str, int] | None, current: dict[str, int]
) -> str | None:
    """Item #26: return a one-line delta string or None.

    Format:  ``**Δ since last compact:** +2 edited, +3 bash``

    - Returns None if *prior* is None (no prior sidecar; first compact).
    - Returns None when no section count changed (manifest is steady-state).
    - Reports both growth (+N) and shrinkage (-N) — a shrink usually means
      session reset / cache trim and is just as informative.
    - Section order is fixed (most load-bearing first) so the line is stable
      across compactions and easy to scan.
    """
    if not prior:
        return None
    # Stable display order — matches the manifest's own section emission order.
    _ORDER = ("edited", "files", "bash", "web", "grep", "glob", "skill", "decision", "symbols")
    parts: list[str] = []
    for key in _ORDER:
        cur = int(current.get(key, 0))
        old = int(prior.get(key, 0))
        delta = cur - old
        if delta == 0:
            continue
        sign = "+" if delta > 0 else ""
        parts.append(f"{sign}{delta} {key}")
    if not parts:
        return None
    return "**Δ since last compact:** " + ", ".join(parts)


# Maximum number of edited files listed individually in the "Files Edited" section.
# The section is documented as "uncapped — every edited file is must-preserve", but
# in practice a session that touches 30–100 files (e.g. a large refactor or mass
# rename) would let the edited-files block alone consume the entire 400-token budget,
# squeezing out the Symbols Accessed and other variable sections that carry the most
# useful compaction signal.  Cap at 20: the top-20 most-edited files are listed by
# name (sorted by edit count descending), and any overflow gets a single "+N more
# edited" line so the compaction LLM knows additional files exist without paying the
# per-line token cost.  20 files × ~13 tokens/line ≈ 260 tokens, leaving ~140 for
# the rest of the sections at a 400-token budget.
_MAX_EDITED_FILES_SHOWN: Final[int] = 20

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

# Maximum skills surfaced in the "Active Skills" manifest section.  Sessions
# load a handful of skills at most (Ralph + improve + a few specialist skills);
# 6 covers any realistic session without crowding higher-priority blockers.
_MAX_ACTIVE_SKILLS: Final[int] = 6

# Skills not loaded in the last N minutes are excluded from the manifest to avoid
# cluttering with "done" skills.  30 minutes is conservative: a typical task may
# involve loading multiple skills sequentially (1–2 min each); 30 min covers that
# plus a buffer for quick re-invocations of the same skill without stale noise.
_SKILL_STALE_THRESHOLD_SECS: Final[int] = 30 * 60

# Skills loaded more than N hours ago are flagged as potentially stale (old-session
# data). Used in _format_skill_entry to warn the post-compact agent that the
# cached body may be outdated if the underlying skill file was updated since.
_SKILL_STALE_FOR_SESSION_SECS: Final[int] = 6 * 3600  # 6 hours

# Per-skill inline compact text budget in the manifest.  When a skill's cached
# compact exceeds this character limit it is truncated at a newline boundary so
# the manifest stays within its global token budget even when many large skills
# (ralph + improve + marketing + humanizer) are all loaded simultaneously.
# 600 chars ≈ 150 tokens — enough for the key-rules / DoD section of any skill
# without drowning the higher-priority edited-files and blockers sections.
# Callers can always retrieve the full compact via ``token-goat skill-body --compact``.
_SKILL_COMPACT_INLINE_MAX_CHARS: Final[int] = 600

# Total token budget for ALL inline skill compacts injected into the manifest.
# A session can load up to _MAX_ACTIVE_SKILLS (6) skills, each with up to
# _SKILL_COMPACT_INLINE_MAX_CHARS (600 chars ≈ 150 tokens).  Without a total
# cap, 6 × 150 = 900 tokens can be injected — more than twice the 400-token
# manifest budget.  This ceiling distributes the budget fairly: each skill gets
# at most total_budget / n_skills tokens.  100 tokens per skill is enough to
# surface the 3–5 key rules that survive compaction; the full compact is
# always available via ``token-goat skill-body --compact <name>``.
# 300 tokens × 3 chars/token = 900 chars total, shared across all skills.
_SKILL_INLINE_TOTAL_TOKEN_BUDGET: Final[int] = 300

# Maximum decisions surfaced in the **Decisions:** manifest section.  Opt-in via
# ``token-goat decision "<text>"``, so the volume is self-limited — typical
# sessions log 0–3 decisions per task.  5 covers heavier sessions while keeping
# the section bounded; older entries are still on disk for ``token-goat
# decision --list`` recall.
_MAX_DECISIONS: Final[int] = 5
# Hard per-line cap when rendering a decision into the manifest.  Long enough
# to surface the reasoning ("Chose option A because Y; rejected B due to Z")
# but short enough that 5 entries fit comfortably in a 60–80 token slice.
_MAX_DECISION_RENDER_LEN: Final[int] = 140


# Minimum weighted activity score required to emit a full session manifest.
# Below this floor the manifest is suppressed entirely (or replaced by a 1-line
# stub) because there is not enough session context worth preserving across a
# compaction.  The weights are:
#   edited_files  × 2  — edits are the most load-bearing signal
#   bash_history  × 1  — commands run are secondary context
#   web_history   × 1  — web fetches are secondary context
#   skill_history × 1  — loaded skills are useful but lighter
#   active blockers × 5  — a current failure is always worth surfacing
# A score of 3 means roughly: 1 edit + 1 bash run, or 2 edits, or 3 fetches.
# Short sessions (a single file read, no edits, no commands) score 0 and are
# suppressed — there is nothing to preserve.
_ACTIVITY_FLOOR: Final[int] = 3

# TTL for the process-level git diff stat summary cache (seconds).
# `_get_git_diff_stat_summary` runs two git subprocesses per call; caching
# avoids repeated invocations when build_manifest is called in quick succession
# (e.g. `token-goat compact-hint --session-id <id>` runs, then PreCompact fires).
_DIFF_STAT_SUMMARY_TTL: Final[float] = 30.0
# Cache: {cwd_str → (result, monotonic_timestamp)}
_diff_stat_summary_cache: dict[str | None, tuple[str, float]] = {}

# Parallel cache for `_get_uncommitted_changes` (two git subprocesses per call,
# called from both compute_adaptive_budget and _render during the same manifest
# build). Same TTL semantics as the diff-stat cache above.
_uncommitted_changes_cache: dict[str | None, tuple[str | None, float]] = {}

# Item #35: LRU cap for the process-level caches above.  Long-lived worker
# processes can hit hundreds of project switches over a session; an unbounded
# dict slowly leaks memory and degrades dict-lookup performance.  32 is enough
# for the common case (one or two repos under active iteration) with headroom
# for monorepo sub-projects, and small enough that eviction overhead is trivial.
_DIFF_STAT_CACHE_MAX_ENTRIES: Final[int] = 32


def _put_bounded(cache: dict, key: object, value: object) -> None:
    """Insert *value* under *key* in *cache*, evicting the oldest entry past the cap.

    Dict insertion order is FIFO in CPython 3.7+, so popping ``next(iter(cache))``
    removes the oldest key — close enough to LRU for these caches (TTL-bounded
    + write-once-per-key) without the OrderedDict bookkeeping overhead.
    """
    if key in cache:
        # Re-insert so the key becomes the most-recently-touched entry.
        del cache[key]
    elif len(cache) >= _DIFF_STAT_CACHE_MAX_ENTRIES:
        # Drop the oldest entry to make room.
        try:
            oldest = next(iter(cache))
        except StopIteration:  # pragma: no cover — empty dict, len == 0
            oldest = None
        if oldest is not None:
            cache.pop(oldest, None)
    cache[key] = value

# Process-level cache for _is_git_repo() results.
# A single stat() call per cwd is enough for the lifetime of the hook process
# (the working directory doesn't change between git repo and non-git repo
# within a single hook invocation). Saves ~30–60 ms per non-git cwd by
# avoiding two git subprocess spawns per helper.
_is_git_repo_cache: dict[str, bool] = {}

# Maximum number of failed bash commands surfaced in the "Current Blockers" section.
# Three is enough to identify the active failure without crowding the header.
_MAX_BLOCKER_ENTRIES: Final[int] = 3

# Failed commands older than this are not considered active blockers.
# 60 minutes: if a command failed more than an hour ago the agent has likely
# already moved on and the failure is no longer the immediate problem.
_BLOCKER_STALE_SECS: Final[int] = 3600  # 60 minutes

# Half-life for the recency component of _importance_score, in seconds.
# At t=0 the recency bonus is 3.0; at t=30min it is ~1.5; at t=60min it is ~0.75.
# Files read within the last 5 minutes receive a bonus close to the full 3.0.
_RECENCY_HALF_LIFE_SECS: Final[float] = 1800.0  # 30 minutes

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
    ".pid",                            # daemon/process id files
    ".lock",                           # generic lockfiles (worker locks, etc.)
})
_NOISE_BASENAMES: Final[frozenset[str]] = frozenset({
    ".ds_store", "thumbs.db", "desktop.ini",  # OS metadata
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",  # JS lockfiles
    "poetry.lock", "uv.lock", "pdm.lock",                # Python lockfiles
    "cargo.lock",                                         # Rust lockfile
    "composer.lock", "gemfile.lock",                      # PHP/Ruby lockfiles
    "coverage.xml", ".coverage", "lcov.info",            # coverage artifacts
})
# Path-substring noise markers — any normalized path containing one of these
# segments is considered noise.  Forward-slash form because _short_path already
# normalises backslashes; the matcher runs against the un-shortened normalized
# path so it works regardless of where the segment appears in the tree.
_NOISE_SEGMENTS: Final[tuple[str, ...]] = (
    "/__pycache__/", "/.git/", "/node_modules/", "/.venv/", "/venv/",
    "/dist/", "/build/", "/.mypy_cache/", "/.pytest_cache/", "/.ruff_cache/",
    "/appdata/local/temp/", "/appdata/roaming/",
    "/tmp/",  # Unix temp dir — ephemeral files (improve_commit_msg, etc.)
    # Frontend build outputs and framework caches
    "/.next/", "/.nuxt/", "/.svelte-kit/", "/.turbo/", "/.parcel-cache/",
    # General-purpose cache dirs (one level up from .pytest_cache etc.)
    "/.cache/", "/.tox/",
    # Coverage outputs
    "/coverage/", "/.nyc_output/",
    # Python virtualenv / package payloads installed under the project tree
    "/site-packages/", ".egg-info/",
    # Rust / JVM compiled output
    "/target/",
)


def _importance_score(entry: FileEntry, now: float, edit_bonus: float = 0.0) -> float:
    """Composite importance score for manifest ranking of 'Key Files Read' entries.

    Combines four signals so the most genuinely important files rise to the top
    of the manifest, not just the most-frequently-polled ones:

    - **read_score**: raw read frequency, capped at 10 to avoid dominating.
    - **symbol_score**: each unique symbol accessed adds 2.0 — a file read once
      for a specific function is more load-bearing than one blindly scanned.
    - **edit_bonus**: 15.0 when the file was edited this session, 0.0 otherwise.
      (Edited files are *already* pinned in the 'Files Edited' section; this
      bonus only affects files that are in ``files_clean`` but NOT in
      ``edited_files`` — i.e. files that were both read and edited but whose
      edited-section entry predates the read, or files whose edit path key
      differs slightly from their read key.)
    - **recency**: exponential decay with a 30-minute half-life so a file read
      five minutes ago outweighs one read two hours ago even when counts tie.

    Args:
        entry:      A :class:`session.FileEntry` with ``read_count``,
                    ``symbols_read``, and ``last_read_ts`` attributes.
        now:        Current Unix timestamp (``time.time()``).  Passed in so the
                    caller can snapshot it once per render pass rather than
                    calling ``time.time()`` per entry.
        edit_bonus: Additional score for files edited this session.  The caller
                    passes 15.0 when ``entry``'s path is in ``edited_files``,
                    0.0 otherwise.

    Returns:
        A float importance score.  Higher is more important.
    """
    # Base: read frequency, capped so a file read 50× doesn't drown symbol signal.
    read_score = min(entry.read_count, 10) * 1.0
    # Symbol bonus: each unique symbol is strong evidence the agent used this file.
    symbol_score = min(len(entry.symbols_read), 20) * 2.0
    # Recency bonus: exponential decay, half-life = 30 minutes.
    age_seconds = max(0.0, now - entry.last_read_ts)
    recency = math.exp(-age_seconds * math.log(2) / _RECENCY_HALF_LIFE_SECS)
    return read_score + symbol_score + edit_bonus + recency * 3.0


def is_noise_path(path: str) -> bool:
    """Return True when *path* should be excluded from the manifest as low-value noise.

    Build artifacts (``.pyc``, ``.o``), OS metadata (``.DS_Store``,
    ``Thumbs.db``), lockfiles (``package-lock.json``, ``poetry.lock``), and
    cache directories (``__pycache__/``, ``.git/``, ``node_modules/``) carry
    no information the compaction LLM needs to preserve, and would otherwise
    eat into the manifest's strict token budget.

    Also filters temporary files in /tmp/, Windows temp paths (AppData/Local/Temp,
    AppData/Roaming), and loop-state files (.improve-state-*.json,
    improve_commit_msg_*.txt) created by automation tools.

    Matching is case-insensitive and tolerant of both POSIX and Windows
    separators.  Returns False for any empty or malformed input.
    """
    if not path:
        return False
    p = _norm_key(path)
    # Path-segment check first: catches whole noise directories regardless of
    # the file's own extension (e.g. ``project/.venv/lib/foo.py``).
    if any(segment in p for segment in _NOISE_SEGMENTS):
        return True
    # Basename and extension checks — slice once and reuse.
    slash_idx = p.rfind("/")
    basename = p[slash_idx + 1:] if slash_idx >= 0 else p
    if basename in _NOISE_BASENAMES:
        return True
    # Basename prefix checks: ephemeral state files from automation tools.
    if basename.startswith((".improve-state-", "improve_commit_msg_")):
        return True
    dot_idx = basename.rfind(".")
    return dot_idx >= 0 and basename[dot_idx:] in _NOISE_EXTS


def _get_git_diff_stat(
    edited_paths: list[str],
    cwd: str | None,
) -> str | None:
    """Get git diff --stat output for edited files, truncated to 8 lines and 200 chars.

    Returns a formatted string like:
        src/foo.py    | 12 ++++-----
        src/bar.py    |  3 +-

    Or None if: git unavailable, not a repo, no differences, or cwd is None.

    Timeout: 2 seconds. Output is capped at 8 lines and 200 characters total.
    """
    if not cwd or not edited_paths:
        return None

    raw = _run_git(["diff", "--stat", "HEAD", "--"] + edited_paths, cwd, timeout=2)
    if not raw:
        return None
    # Filter out summary line (contains "file changed" / "insertions")
    diff_lines = [
        line for line in raw.splitlines()
        if "file changed" not in line.lower() and "insertion" not in line.lower()
    ]
    if not diff_lines:
        _LOG.debug("_get_git_diff_stat: no diff lines after filtering summary")
        return None

    # Truncate to 8 lines and cap total at 200 chars.
    output = "\n".join(diff_lines[:8])
    if len(output) > 200:
        output = output[:200].rsplit("\n", 1)[0]
    return output


_INLINE_DIFF_MAX_BYTES: Final[int] = 500  # per-file diff size gate (#7)
_INLINE_DIFF_TOTAL_CAP: Final[int] = 800  # total inlined diff bytes in manifest (#7); ~200 tokens at typical code density (4 bytes/token).
# NOTE: _INLINE_DIFF_TOTAL_CAP is denominated in bytes, while the manifest budget
# (_render's max_tokens arg) is denominated in tokens.  The inline diff section can
# therefore consume up to ~200 tokens without the token-budget system being aware.
# For the default 400-token manifest this is ≤50 % of budget, acceptable because
# inline diffs displace the (lower-value) edited-file list entries they replace.
# If the manifest budget is shrunk significantly, revisit this constant or convert
# it to a token-denominated cap derived from max_tokens.
_SINGLE_FILE_DIFF_CAP: Final[int] = 400  # whole-repo diff cap for single-file replace (#17)

# Item #2: short-TTL cache for the whole-repo ``git diff HEAD`` output keyed
# by cwd.  ``_get_whole_repo_diff`` and ``_get_inline_diff_for_file`` both
# need the diff; running git separately for each path multiplies the
# subprocess cost across a manifest build.  We fetch once, slice for the
# per-file callers, and let the TTL expire so a fresh diff is picked up
# between consecutive PreCompact fires.
_WHOLE_DIFF_TTL_SECS: Final[float] = 30.0
_whole_diff_cache: dict[str, tuple[str | None, float]] = {}


def _fetch_whole_repo_diff_cached(cwd: str) -> str | None:
    """Return the full ``git diff HEAD`` output for *cwd*, cached for the TTL.

    Returns ``None`` when git is unavailable, the repo has no diff, or the
    subprocess fails.  Empty-string is normalised to ``None`` so callers can
    use the simple ``if diff is None`` idiom.
    """
    if not cwd:
        return None
    now = time.monotonic()
    cached = _whole_diff_cache.get(cwd)
    if cached is not None and now - cached[1] < _WHOLE_DIFF_TTL_SECS:
        return cached[0]
    diff = _run_git(["diff", "--no-color", "HEAD"], cwd, timeout=1.5)
    _put_bounded(_whole_diff_cache, cwd, (diff, now))
    return diff


def _slice_diff_for_file(whole_diff: str, path: str) -> str | None:
    """Extract the per-file segment for *path* from a full ``git diff HEAD`` output.

    Splits *whole_diff* on the ``diff --git`` boundary that opens each file's
    section and returns the chunk whose header references *path*.  Path
    matching tolerates both ``a/path`` / ``b/path`` prefixes and case-
    insensitive matches so Windows-cased paths still resolve.

    Returns ``None`` when no chunk matches (e.g. path is staged-but-unmodified
    or has been added via ``git add`` only).
    """
    if not whole_diff or not path:
        return None
    norm_path = paths.normalize_key(path)
    # Split on each "diff --git" boundary; keep the prefix attached to its chunk.
    chunks = [c for c in whole_diff.split("\ndiff --git ") if c.strip()]
    # The first chunk may or may not start with "diff --git " depending on the
    # split shape; normalise by ensuring every chunk's first line is the file
    # header so we can match consistently.
    needle_a = f"a/{norm_path}"
    needle_b = f"b/{norm_path}"
    for chunk in chunks:
        header = chunk.split("\n", 1)[0]
        # Case-insensitive search handles Windows case-folding inside git.
        if needle_a in header or needle_b in header or norm_path in header:
            # Re-prepend the "diff --git " token we stripped during split.
            if not chunk.startswith("diff --git "):
                chunk = "diff --git " + chunk
            return chunk
    return None


def _get_inline_diff_for_file(path: str, cwd: str) -> str | None:
    """Return per-file ``git diff HEAD`` when the diff is small enough to inline.

    Used by the edited-files section (#7) to replace the bare "edited Nx" note
    with the actual diff when it fits within *_INLINE_DIFF_MAX_BYTES*.

    Item #2: routes through the per-manifest whole-diff cache instead of
    spawning a fresh ``git diff HEAD -- <path>`` subprocess per file.  The
    cached diff is sliced down to just this file's segment via
    :func:`_slice_diff_for_file`.

    Falls back to ``None`` on any failure or when the sliced diff is too large.
    """
    if not cwd or not path:
        return None
    whole = _fetch_whole_repo_diff_cached(cwd)
    if not whole:
        return None
    segment = _slice_diff_for_file(whole, path)
    if segment is None or len(segment) > _INLINE_DIFF_MAX_BYTES:
        return None
    return segment


def _get_whole_repo_diff(cwd: str) -> str | None:
    """Return ``git diff HEAD`` for the whole repo if under *_SINGLE_FILE_DIFF_CAP* bytes.

    Used by the single-file inline path (#17).  Returns ``None`` on any failure
    or when the diff exceeds the cap.

    Item #2: shares the cached subprocess result with
    :func:`_get_inline_diff_for_file`.
    """
    if not cwd:
        return None
    diff = _fetch_whole_repo_diff_cached(cwd)
    if diff is None or len(diff) > _SINGLE_FILE_DIFF_CAP:
        return None
    return diff


def _is_git_repo(cwd: str) -> bool:
    """Return True when *cwd* is inside a git repository.

    Checks for the presence of a ``.git`` entry (directory **or** file — the
    latter is used by git worktrees and submodules).  A single ``os.path.exists``
    call, sub-millisecond.  Result is cached per cwd for the lifetime of the
    process so repeated calls within the same hook invocation pay zero cost.
    """
    cached = _is_git_repo_cache.get(cwd)
    if cached is not None:
        return cached
    result = (Path(cwd) / ".git").exists()
    _is_git_repo_cache[cwd] = result
    return result


def _get_uncommitted_changes(project_root: str | None) -> str | None:
    """Return a compact summary of all uncommitted changes in *project_root*.

    Combines ``git diff --stat HEAD`` (tracked file changes) with
    ``git status --short`` (which also surfaces untracked files not yet staged).
    Returns a non-empty string on success, or ``None`` on any failure (git
    unavailable, not a repo, nothing changed, timeout, etc.).

    Caps:
    - At most 8 lines total (across both commands, deduplicated).
    - At most 200 characters total (header not included — caller adds it).
    - Timeout 5 s so a slow git never blocks the PreCompact hook.
    - Each line has trailing whitespace stripped.

    This function must never raise.
    """
    if project_root is None:
        return None
    if not _is_git_repo(project_root):
        return None
    try:
        # Process-level cache: skip the subprocesses when called again within TTL.
        # build_manifest_adaptive calls this once for the budget calculation and
        # _render calls it again to emit the section, both within the same
        # manifest build — without the cache, that doubles the four git
        # subprocess invocations needed.
        now = time.monotonic()
        cached = _uncommitted_changes_cache.get(project_root)
        if cached is not None and now - cached[1] < _DIFF_STAT_SUMMARY_TTL:
            return cached[0]

        # Run git diff --stat HEAD to see tracked file changes with +/- counts.
        _diff_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], project_root, timeout=5)
        diff_lines: list[str] = (
            [line.rstrip() for line in _diff_out.splitlines() if line.strip()]
            if _diff_out else []
        )

        # Run git status --short to catch untracked (??) and staged files not
        # reflected in diff --stat HEAD (e.g. new files added to the index).
        _status_out = _run_git(["status", "--short"], project_root, timeout=5)
        status_lines: list[str] = (
            [line.rstrip() for line in _status_out.splitlines() if line.strip()]
            if _status_out else []
        )

        if not diff_lines and not status_lines:
            _put_bounded(_uncommitted_changes_cache, project_root, (None, now))
            return None

        # Prefer diff --stat lines (they include +/- counts which are more
        # informative) and supplement with status lines that mention files not
        # already covered by the diff output.  We extract the filename from
        # each status line ("?? foo.py" → "foo.py") to check for overlap.
        diff_filenames: set[str] = set()
        for dl in diff_lines:
            # diff --stat lines look like " src/foo.py | 12 +++---"
            parts = dl.split("|")
            if parts:
                diff_filenames.add(parts[0].strip())

        combined: list[str] = list(diff_lines)
        for sl in status_lines:
            # status --short lines: "?? foo.py", " M src/bar.py", "A  new.py"
            tokens = sl.split(None, 1)
            filename = tokens[1].strip() if len(tokens) > 1 else sl.strip()
            if filename not in diff_filenames:
                combined.append(sl)

        if not combined:
            _put_bounded(_uncommitted_changes_cache, project_root, (None, now))
            return None

        # Truncate to 8 lines and cap total chars at 200.
        lines = combined[:8]
        output = "\n".join(lines)
        if len(output) > 200:
            output = output[:200].rsplit("\n", 1)[0]
        result = output if output.strip() else None
        _put_bounded(_uncommitted_changes_cache, project_root, (result, now))
        return result
    except Exception:  # noqa: BLE001
        return None


def _get_git_diff_stat_summary(root: object) -> str:
    """Run ``git diff --stat HEAD`` in *root* and return a compact summary string.

    Designed for the "Pending Changes" section of the compaction manifest.
    Unlike :func:`_get_git_diff_stat` (which queries specific files and strips the
    summary line), this helper runs on the whole working tree and *keeps* the
    ``N files changed, M insertions(+), K deletions(-)`` summary line so the
    compaction LLM sees the scope at a glance.

    Caps:
    - At most 6 lines (5 per-file lines + 1 summary line).
    - At most 300 characters total (avoid ballooning the manifest).
    - Timeout 5 s so a slow git never blocks the PreCompact hook.

    ANSI escape codes are stripped from the output (git --no-color is used
    directly, which is simpler and more reliable than a regex).

    Returns:
        A non-empty string on success, or ``""`` on any failure (git not found,
        not a git repo, no changes, output too large, timeout, etc.).  This
        function must never raise.
    """
    if root is None:
        return ""
    try:
        root_str = root if isinstance(root, str) else str(root)
        if not _is_git_repo(root_str):
            return ""

        # Process-level cache: skip the subprocess when called again within TTL.
        now = time.monotonic()
        cached = _diff_stat_summary_cache.get(root_str)
        if cached is not None and now - cached[1] < _DIFF_STAT_SUMMARY_TTL:
            return cached[0]

        _stat_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], root_str, timeout=5)
        if not _stat_out:
            _put_bounded(_diff_stat_summary_cache, root_str, ("", now))
            return ""
        lines = _stat_out.splitlines()
        # Keep at most 6 lines (last 5 file-stat lines + the summary line which is last).
        # git --stat outputs file lines first then a summary line at the end; taking the
        # last 6 lines captures the summary and up to 5 file entries.
        last6 = lines[-6:]
        # Drop alignment padding that git --stat adds for column alignment.
        # "src/foo.py    | 12 +++--" → "src/foo.py | 12 +++--"
        # Each stat line saves 2–8 spaces.  Summary line is unaffected (no "|").
        compressed = []
        for ln in last6:
            ln = re.sub(r"\s{2,}\|", " |", ln)
            ln = re.sub(r"\|\s{2,}(\d)", r"| \1", ln)
            compressed.append(ln)
        output = "\n".join(compressed)
        # Hard cap: if still too long, drop the manifest section entirely rather than
        # truncating mid-line (a partial diff stat is misleading).
        if len(output) > 300:
            _put_bounded(_diff_stat_summary_cache, root_str, ("", now))
            return ""
        _put_bounded(_diff_stat_summary_cache, root_str, (output, now))
        return output
    except Exception:  # noqa: BLE001
        return ""


def _get_stash_count(cwd: str | None) -> int:
    """Return the number of entries in ``git stash list``, or 0 on any failure.

    Item #27: stash count is load-bearing state currently invisible to the
    compaction LLM — a forgotten ``git stash`` carries pending work the agent
    must remember.  Lightweight subprocess (no pathspec), 2 s timeout.  The
    return value gates emit-vs-suppress in the manifest renderer; 0 disables
    the section entirely so the common (no-stashes) path costs nothing.
    """
    if not cwd:
        return 0
    out = _run_git(["stash", "list"], cwd, timeout=2)
    if not out:
        return 0
    return sum(1 for line in out.splitlines() if line.strip())


def _get_session_commits(cwd: str | None, session_start_ts: float) -> list[str]:
    """Return git log lines for commits made after session_start_ts.

    Returns at most 5 commits, formatted as ``{short_hash} {subject}``.

    Item #5: the leading ``- `` prefix was dropped — the commits section is
    already rendered under an ``### Commits This Session`` header inside an
    already-bulleted block, and the prefix added ~2 tokens per commit × 5
    commits with no information gain.

    Returns [] when git is unavailable, not in a repo, or cwd is None.
    Times out after 2 seconds.
    """
    if not cwd or session_start_ts <= 0:
        return []
    out = _run_git(
        ["log", "--oneline", f"--since={int(session_start_ts)}", "--max-count=5"],
        cwd,
        timeout=2,
    )
    if not out:
        return []
    return [sanitize_log_str(line, max_len=100) for line in out.splitlines()[:5]]


def _get_committed_files(session_cache: object, cwd: str | None) -> set[str]:
    """Return normalized file paths that were committed since session start.

    Queries ``git log --name-only`` for commits since the session's creation
    timestamp and returns a set of normalized (lowercase, forward-slash) paths
    that have been committed.  Used by the manifest builder to identify which
    edited files are recoverable from git history (lower priority for the
    compaction manifest) vs. staged/uncommitted (CRITICAL).

    Returns an empty set on any error (git unavailable, not in repo, cwd is None,
    invalid timestamp, or command timeout).  Fail-soft: never blocks the manifest.

    Times out after 2 seconds.
    """
    try:
        if not cwd:
            return set()
        created_ts = float(getattr(session_cache, "created_ts", 0.0) or 0.0)
        if created_ts <= 0:
            return set()

        # Use --name-only to get the list of files per commit.
        # --since uses unix timestamp format (seconds, not ISO 8601).
        out = _run_git(
            ["log", "--name-only", "--format=", f"--since={int(created_ts)}"],
            cwd,
            timeout=2,
        )
        if not out:
            return set()

        # Normalize each file path: lowercase and forward slashes (same as
        # session._normalize_path does). One file path per line.
        committed = set()
        for line in out.splitlines():
            line = line.strip()
            if line:
                # Normalize the path key: same operation as _norm_key()
                normalized = _norm_key(line)
                committed.add(normalized)
        return committed
    except (ValueError, TypeError):
        # In case created_ts cannot be coerced to float
        return set()


def _detect_orchestrator_mode(
    session_cache: object,
    repo_root: str | None,
    threshold: int = 5,
) -> bool:
    """Return True when the session looks like a /improve orchestrator loop.

    Detection criteria:
    - ``git log --oneline --since=<session_start_ts>`` returns >= *threshold* commits
    - The session has fewer than 10 edited files

    Both conditions together distinguish the orchestrator (many commits, small
    per-iteration file set) from a broad refactor session (many commits AND many
    edited files).

    Fail-soft: returns False on any error (git unavailable, no cwd, etc.).
    """
    try:
        if not repo_root:
            return False
        # Gate on edited_files count first — cheap dict-len check before subprocess.
        edited_count = len(getattr(session_cache, "edited_files", None) or {})
        if edited_count >= 10:
            return False
        created_ts = float(getattr(session_cache, "created_ts", 0.0) or 0.0)
        if created_ts <= 0:
            return False
        out = _run_git(
            ["log", "--oneline", f"--since={int(created_ts)}"],
            repo_root,
            timeout=3,
        )
        if not out:
            return False
        commit_count = sum(1 for line in out.splitlines() if line.strip())
        return commit_count >= threshold
    except Exception:  # noqa: BLE001 — fail-soft per hook contract
        return False


def _get_current_branch(repo_root: str | None) -> str | None:
    """Return the current git branch name, or ``None`` on detached HEAD / non-repo.

    Uses ``git symbolic-ref --short HEAD`` which exits non-zero on detached HEAD
    (where HEAD points directly to a commit SHA, not a branch ref).  Returns None
    in that case and on any other failure (git absent, not a repo, etc.) so callers
    can omit the branch line rather than showing an unhelpful error.
    """
    if not repo_root:
        return None
    out = _run_git(["symbolic-ref", "--short", "HEAD"], repo_root, timeout=3)
    if not out:
        return None
    branch = out.strip()
    return branch or None


def _get_recent_commits_for_orchestrator(repo_root: str | None, n: int = 10) -> list[str]:
    """Return the last *n* git commits as oneline strings for the orchestrator manifest.

    Returns an empty list on any failure (git unavailable, not a repo, etc.).
    """
    if not repo_root:
        return []
    out = _run_git(["log", "--oneline", f"-{n}"], repo_root, timeout=3)
    if not out:
        return []
    return [sanitize_log_str(line, max_len=100) for line in out.splitlines() if line.strip()]


def _count_suffix(n: int) -> str:
    """Return '  ×N' when *n* > 1, or '' when the count is unremarkable.

    Used in the manifest to annotate files edited or read multiple times without
    cluttering single-occurrence entries.
    """
    return f"  ×{n}" if n > 1 else ""


def _group_edited_by_dir(
    entries: list[tuple[str, int]],
    project_root: str | None = None,
    threshold: int = 3,
) -> list[str]:
    """Group edited files by directory when >= threshold files share the same parent.

    When multiple files share a common parent directory, group them under one
    directory header to save tokens. Directories with fewer than threshold files
    remain on their own lines. Set threshold=0 to disable grouping entirely.

    Args:
        entries: List of (path, edit_count) tuples, already sorted by edit count descending.
        project_root: Optional project root for path shortening.
        threshold: Minimum number of files in a directory to trigger grouping.
                  Set to 0 to disable grouping. Defaults to 3.

    Returns:
        A list of formatted strings ready for the manifest. Each string is either:
        - A single-file line: "- ✎ path/to/file.py  ×N"
        - A grouped line: "  path/to/dir/ (N files):  file1.py ×2, file2.py ×1, ..."
    """
    from collections import defaultdict

    if not entries or threshold < 0:
        return []

    # Special case: threshold=0 disables grouping
    if threshold == 0:
        ungrouped_result = []
        for path, count in entries:
            ungrouped_result.append(f"- ✎ {_short_path(path, project_root=project_root)}{_count_suffix(count)}")
        return ungrouped_result

    # Group by directory
    dir_groups: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for path, count in entries:
        _p = Path(path)
        dirname = str(_p.parent)  # Path("file.txt").parent == Path(".") → "."
        basename = _p.name
        dir_groups[dirname].append((basename, count))

    result: list[str] = []
    for dirname in sorted(dir_groups.keys(), key=lambda d: -max(c for _, c in dir_groups[d])):
        group = dir_groups[dirname]

        if len(group) < threshold:
            # Below threshold: list each file on its own line
            for basename, count in group:
                full_path = str(Path(dirname) / basename) if dirname != "." else basename
                result.append(f"- ✎ {_short_path(full_path, project_root=project_root)}{_count_suffix(count)}")
        else:
            # 3+ files: use grouped format
            # Sort files within the group by edit count descending, maintaining relative order
            group_sorted = sorted(group, key=itemgetter(1), reverse=True)
            file_parts = [f"{basename}{_count_suffix(count)}" for basename, count in group_sorted]
            files_str = ", ".join(file_parts)

            # Cap the grouped line to fit within reasonable manifest bounds (~120 chars)
            display_dir = _short_path(dirname + "/", project_root=project_root) if dirname != "." else ""
            line = f"  {display_dir} ({len(group)} files):  {files_str}"

            if len(line) > 120:
                # If too long, truncate the file list
                files_str = ", ".join(file_parts[:2])
                overflow = len(group_sorted) - 2
                if overflow > 0:
                    files_str += f", +{overflow} more"
                line = f"  {display_dir} ({len(group)} files):  {files_str}"

            result.append(line)

    return result


def _format_duration(seconds: float) -> str:
    """Format a duration in seconds as a compact human-readable string.

    Examples: 65 → "1m", 3665 → "1h 1m", 7200 → "2h"
    """
    secs = int(seconds)
    if secs < 3600:
        return f"{secs // 60}m"
    hours = secs // 3600
    mins = (secs % 3600) // 60
    return f"{hours}h {mins}m" if mins > 0 else f"{hours}h"


def _short_path(p: str, max_len: int = 70, project_root: str | None = None) -> str:
    """Return a compact display representation of a file path.

    Normalises backslashes to forward slashes, strips the leading
    absolute-path component up to a recognised project-layout directory
    (``/src/``, ``/tests/``, ``/docs/``) so the manifest stays readable on
    both Windows and POSIX without leaking the user's home directory prefix,
    and sanitizes embedded newlines/CRs to prevent log/manifest injection.
    Falls back to tail-truncation with an ellipsis if the path is still over
    *max_len* after stripping (e.g. deeply nested monorepo paths).

    If *project_root* is provided and the path starts with the project
    basename as its first component (e.g. ``token-goat/src/file.py``), that
    leading component is stripped so the manifest shows ``src/file.py`` rather
    than ``token-goat/src/file.py``.  Paths from other projects keep their
    leading component intact.
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
    # Strip the project basename when it's the first path component.
    # E.g. with project_root="/Projects/token-goat", a path that after the
    # above stripping starts with "token-goat/" becomes just the remainder.
    # Only applies to the *current* project — other projects keep their name.
    if project_root:
        proj_name = Path(project_root.rstrip("/\\")).name
        if proj_name:
            prefix_check = proj_name + "/"
            p = p.removeprefix(prefix_check)
    if len(p) > max_len:
        return "…" + p[-(max_len - 1):]
    return p


def _extract_path_from_line(line: str) -> str | None:
    """Extract the path string from a manifest line if it contains one.

    Recognizes lines with path-bearing markers: '- ✎ ', '- → ', '- ⚠ ', '- ❄ ',
    and plain symbol lines '- '.  Returns the path token (first non-empty token
    after the marker) or None if the line doesn't contain a path.

    Examples:
        "- ✎ token_goat/compact.py  ×2" → "token_goat/compact.py"
        "- → token_goat/hints.py  L:1-100" → "token_goat/hints.py"
        "- token_goat/session.py → FileEntry" → "token_goat/session.py"
        "### Files Edited" → None
        "Legend: edited=✎" → None
    """
    line = line.rstrip()
    if not line.startswith("- "):
        return None

    # Remove the "- " prefix
    rest = line[2:]

    # Skip marker symbols (✎, →, ⚠, ❄) if present
    if rest and rest[0] in ("✎", "→", "⚠", "❄"):
        rest = rest[1:].lstrip()

    # Extract the first whitespace-delimited token
    if not rest:
        return None
    parts = rest.split()
    if not parts:
        return None

    path = parts[0]
    # Validate: a path should not start with a backtick or look like a command
    if path.startswith("`"):
        return None
    return path


def _find_common_prefix(paths: list[str]) -> str | None:
    """Find the longest common directory prefix shared by all paths.

    A directory prefix is one that ends at a '/' boundary.  Single-segment
    paths (no '/') contribute no prefix.  Returns None if no common directory
    prefix exists or if the prefix is too short to be worthwhile.

    Examples:
        ["token_goat/compact.py", "token_goat/hints.py"] → "token_goat/"
        ["src/foo.py", "src/bar.py"] → "src/"
        ["a/b/c.py", "x/y/z.py"] → None (no common prefix)
        ["compact.py", "hints.py"] → None (single-segment paths)
    """
    if not paths:
        return None

    # If only one path, extract its directory
    if len(paths) == 1:
        p = paths[0]
        if "/" in p:
            idx = p.rfind("/")
            return p[:idx + 1]
        return None

    # Find the longest common string prefix across all paths
    # First, find the shortest common substring that is a prefix of all
    common = paths[0]
    for p in paths[1:]:
        # Shorten 'common' until it's a prefix of p (or becomes empty)
        while common and not p.startswith(common):
            common = common[:-1]

    if not common:
        return None

    # Ensure the common prefix ends at a directory boundary ('/')
    # Trim back to the last '/', or return None if there is no '/'
    if "/" not in common:
        return None

    # Find the directory boundary (last '/' in the common part)
    slash_idx = common.rfind("/")
    # Include the '/' in the result
    return common[:slash_idx + 1]


def _strip_common_prefix_lines(
    lines: list[str],
    common_prefix: str,
) -> list[str]:
    """Strip ``common_prefix`` from path-bearing lines, leaving non-path lines intact.

    Unlike :func:`_strip_common_prefix_from_sections`, this helper does NOT
    insert a ``(paths relative to ...)`` header line — it only rewrites
    existing path-bearing lines.  Use this when you need to apply the same
    transformation to a single section in isolation (e.g. during priority-
    aware safety trim, where the manifest body is rebuilt section-by-section).
    """
    if not common_prefix:
        return list(lines)
    out: list[str] = []
    for line in lines:
        path = _extract_path_from_line(line)
        if path and path.startswith(common_prefix) and line.startswith("- "):
            rest = line[2:]
            marker = ""
            if rest and rest[0] in ("✎", "→", "⚠", "❄"):
                marker = rest[0]
                rest = rest[1:].lstrip()
            else:
                rest = rest.lstrip()
            parts = rest.split(None, 1)
            new_path = path[len(common_prefix):]
            tail = f" {parts[1]}" if len(parts) > 1 else ""
            if marker:
                out.append(f"- {marker} {new_path}{tail}")
            else:
                out.append(f"- {new_path}{tail}")
        else:
            out.append(line)
    return out


def _strip_common_prefix_from_sections(
    sections: list[str],
    common_prefix: str,
) -> list[str]:
    """Rewrite sections list to strip common_prefix from all path-bearing lines.

    Inserts a header note after the "Session: ..." line indicating the stripped prefix.
    All path-bearing lines have their paths rewritten to remove the prefix.

    Args:
        sections: The list of manifest lines to transform.
        common_prefix: The directory prefix to strip (e.g., "token_goat/").

    Returns:
        A new list of sections with the prefix stripped and a header note inserted.
    """
    if not common_prefix:
        return sections

    result: list[str] = []
    session_line_idx = -1

    # Find the session line and copy header lines
    for i, line in enumerate(sections):
        result.append(line)
        if line.startswith("Session: "):
            session_line_idx = i
            break

    if session_line_idx >= 0:
        # Insert the prefix note after the session line, then process the tail.
        result.insert(session_line_idx + 1, f"(paths relative to {common_prefix})")
        result.extend(_strip_common_prefix_lines(sections[session_line_idx + 1:], common_prefix))
    else:
        # No session header (e.g. body-only slices from the safety-trim path).
        # The loop already consumed every line into result, but those copies are
        # unprocessed originals.  Replace them with the prefix-stripped version.
        result = _strip_common_prefix_lines(sections, common_prefix)

    return result


def _format_ranges(ranges: list[tuple[int, int]]) -> str:
    """Render merged line ranges compactly for inclusion in the manifest.

    Examples::

        _format_ranges([(1, 50)])          # →  "  L:1-50"
        _format_ranges([(1, 1)])           # →  "  L:1"      (single line)
        _format_ranges([(1, 50), (100, 200), (300, 400), (500, 600), (700, 800)])
        # →  "  L:1-50, 100-200, 300-400, 400-500 +1 more"

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
    return f"  L:{parts}{overflow_suffix}"


def _is_noop_bash_command(entry: object) -> bool:
    """Check if a bash entry is a no-op command (status check, pwd, cd, etc).

    No-op commands consume manifest token budget with zero compaction value.
    Examples: `git status`, `ls`, `pwd`, `echo`, `cd`, `cat` on tiny files,
    or any command shorter than 5 characters.

    Returns True if the command is deemed a no-op and should be excluded from
    the manifest bash section.
    """
    cmd_preview = getattr(entry, "cmd_preview", "").strip()
    if not cmd_preview:
        return False

    # Commands shorter than 5 chars are typically inaudible (ls, cd, pwd, git, etc.)
    if len(cmd_preview) < 5:
        return True

    # Extract the base command (first word, handling pipes/redirects)
    first_word = cmd_preview.split()[0] if cmd_preview.split() else ""
    first_word_lower = first_word.lower()

    # No-op patterns: common status/navigation commands
    noop_patterns = {
        "git status", "git diff --stat", "git log --oneline",
        "ls", "pwd", "cd", "echo", "cat", "head", "tail",
    }

    # Check exact match first
    if cmd_preview.lower() in noop_patterns:
        return True

    # Check prefix match for common no-ops
    cmd_lower = cmd_preview.lower()
    if any(cmd_lower.startswith(pattern) for pattern in ("git status", "git diff --stat", "git log")):
        return True

    # Commands that are inherently silent (cd, echo)
    if first_word_lower in ("cd", "echo"):
        return True

    # 'cat' or 'head' on tiny outputs (< 200 bytes) are inaudible
    if first_word_lower in ("cat", "head", "tail"):
        total_bytes = getattr(entry, "stdout_bytes", 0) + getattr(entry, "stderr_bytes", 0)
        if total_bytes < 200:
            return True

    return False


def _select_failed_bash_entries(bash_history: object, now_ts: float) -> list[object]:
    """Return up to :data:`_MAX_BLOCKER_ENTRIES` recently-failed bash commands.

    A "failure" is any entry whose ``exit_code`` is a real integer != 0.
    Entries with ``exit_code=None`` (unknown / not captured) are excluded —
    we cannot assert they failed, so surfacing them as blockers would be noisy.

    Only commands run within the last :data:`_BLOCKER_STALE_SECS` seconds (60
    min) are considered; older failures are stale and no longer the active
    problem.  Results are sorted most-recent-first so the freshest failure is
    listed first in the "Current Blockers" section.

    Accepts ``bash_history`` typed as ``object`` for the same defensive reason
    as :func:`_select_top_bash_entries` — legacy or test SessionCache instances
    may not have the field.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []
    cutoff = now_ts - _BLOCKER_STALE_SECS
    candidates = [
        e for e in bash_history.values()
        if isinstance(getattr(e, "exit_code", None), int)
        and e.exit_code != 0  # type: ignore[union-attr]  # e is object from bash_history.values(); isinstance(getattr(...), int) check above guarantees exit_code exists
        and getattr(e, "ts", 0.0) >= cutoff
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_BLOCKER_ENTRIES, candidates, key=_BY_BASH_TS)


def _session_activity_score(cache: SessionCache) -> int:
    """Compute a weighted activity score for the session.

    Used by :func:`build_manifest_adaptive` to decide whether to emit a full
    manifest or suppress it.  See :data:`_ACTIVITY_FLOOR` for weight rationale.

    Returns a non-negative integer; higher means more session activity.
    """
    edited_count = len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0
    bash_count = len(getattr(cache, "bash_history", None) or {})
    web_count = len(getattr(cache, "web_history", None) or {})
    skill_count = len(getattr(cache, "skill_history", None) or {})

    # Active blockers: recent failed bash commands
    now_ts = time.time()
    blocker_count = len(
        _select_failed_bash_entries(
            getattr(cache, "bash_history", None) or {}, now_ts
        )
    )

    return (
        edited_count * 2
        + bash_count * 1
        + web_count * 1
        + skill_count * 1
        + blocker_count * 5
    )


# ---------------------------------------------------------------------------
# Manifest quality score
# ---------------------------------------------------------------------------

# Score threshold below which the manifest is treated as a noop (score == 0)
# or flagged as thin (score < _MANIFEST_THIN_THRESHOLD) at DEBUG level.
_MANIFEST_THIN_THRESHOLD: Final[int] = 5


def _score_manifest(sections: list[str]) -> int:
    """Assign a quality score to the manifest sections list.

    Scoring weights:
    - ``+10`` for each edited file line (``✎×`` badge in Files Edited section)
    - ``+5``  for each test failure line (``✗`` prefix)
    - ``+3``  for each bash command line (``- `` prefix in **Bash** section)
    - ``+2``  for each symbol entry line (``- `` prefix in **Symbols** section)

    The function operates on rendered section strings, not on raw session data,
    so it reflects the actual content of the manifest rather than a proxy count.

    Returns a non-negative integer.  Score 0 means the manifest is empty (noop).
    Score < :data:`_MANIFEST_THIN_THRESHOLD` means the manifest is thin and may
    not preserve enough context across compaction.

    Args:
        sections: List of rendered section strings, as returned by the manifest
                  builder (e.g. the list of ``"**Edited**:..."`` blocks).

    Returns:
        Non-negative integer quality score.
    """
    score = 0
    in_edited = False
    in_bash = False
    in_symbols = False
    for section in sections:
        in_edited = False
        in_bash = False
        in_symbols = False
        for line in section.splitlines():
            stripped = line.strip()
            # Section header detection — determines which scoring rule to apply.
            if stripped.startswith("**Edited**"):
                in_edited = True
                in_bash = False
                in_symbols = False
                continue
            if stripped.startswith("**Bash**"):
                in_edited = False
                in_bash = True
                in_symbols = False
                continue
            if stripped.startswith("**Symbols**"):
                in_edited = False
                in_bash = False
                in_symbols = True
                continue
            if stripped.startswith("**") and stripped.endswith("**:"):
                # Unknown section header — reset context.
                in_edited = False
                in_bash = False
                in_symbols = False
                continue
            if not stripped.startswith("- "):
                continue
            # Score based on active section context and line content.
            if in_edited:
                score += 10
            elif in_bash:
                score += 3
            elif in_symbols:
                score += 2
            # Test failure lines: present in multiple sections as "✗" prefix.
            if "✗" in stripped:
                score += 5
    return score


def _score_manifest_breakdown(
    sections: list[str],
) -> dict[str, int]:
    """Return per-section score contributions for ``compact-hint --score``.

    Returns a dict of ``{label: points}`` showing what each section contributed
    to the total quality score.  The label is the section header text (e.g.
    ``"**Edited**"``) or ``"Test Failures"`` for ``✗`` lines.  The sum of all
    values equals :func:`_score_manifest`.
    """
    result: dict[str, int] = {}
    in_edited = False
    in_bash = False
    in_symbols = False
    current_section = "(header)"
    for section in sections:
        in_edited = False
        in_bash = False
        in_symbols = False
        for line in section.splitlines():
            stripped = line.strip()
            if stripped.startswith("**Edited**"):
                in_edited = True
                in_bash = False
                in_symbols = False
                current_section = "**Edited**"
                continue
            if stripped.startswith("**Bash**"):
                in_edited = False
                in_bash = True
                in_symbols = False
                current_section = "**Bash**"
                continue
            if stripped.startswith("**Symbols**"):
                in_edited = False
                in_bash = False
                in_symbols = True
                current_section = "**Symbols**"
                continue
            if stripped.startswith("**") and stripped.endswith("**:"):
                in_edited = False
                in_bash = False
                in_symbols = False
                current_section = stripped.rstrip(":")
                continue
            if not stripped.startswith("- "):
                continue
            pts = 0
            if in_edited:
                pts += 10
            elif in_bash:
                pts += 3
            elif in_symbols:
                pts += 2
            if "✗" in stripped:
                pts += 5
            if pts > 0:
                result[current_section] = result.get(current_section, 0) + pts
    return result


def _parse_manifest_sections(
    manifest: str,
) -> list[tuple[str, int, bool]]:
    """Return a list of ``(section_name, token_count, is_empty)`` tuples.

    Parses the rendered manifest into its structural sections (identified by
    ``### Heading`` or ``**Bold**:`` markers) and estimates the token cost
    of each section's content.  Used by ``compact-hint --sections``.

    Empty sections (no content lines) are flagged with ``is_empty=True``.
    """
    if not manifest:
        return []

    sections: list[tuple[str, int, bool]] = []
    current_name: str = "(header)"
    current_lines: list[str] = []

    def _flush(name: str, lines: list[str]) -> None:
        text = "\n".join(lines)
        tokens = estimate_tokens(text)
        non_blank = [ln for ln in lines if ln.strip()]
        empty = len(non_blank) == 0
        sections.append((name, tokens, empty))

    for line in manifest.splitlines():
        stripped = line.strip()
        # Detect section boundaries: ### headers or **Bold**: markers
        if stripped.startswith("### "):
            _flush(current_name, current_lines)
            current_name = stripped[4:]
            current_lines = []
        elif stripped.startswith("**") and ("**:" in stripped or stripped.endswith("**")):
            _flush(current_name, current_lines)
            # Use the bold text as section name, strip trailing ":"
            current_name = stripped.strip("*").rstrip(":")
            current_lines = []
        else:
            current_lines.append(line)

    _flush(current_name, current_lines)
    return sections


def find_latest_session_id() -> str | None:
    """Return the session_id of the most-recently-modified session file.

    Scans ``sessions/`` under the token-goat data directory and returns the
    session_id (filename without ``.json``) of the file with the latest
    modification time.  Returns ``None`` when the sessions directory does
    not exist or contains no ``.json`` files.

    Used by ``compact-hint --session-id auto`` to avoid forcing the developer
    to look up their current session ID manually.
    """
    try:
        sessions_dir = paths.sessions_dir()
        if not sessions_dir.is_dir():
            return None
        candidates = list(sessions_dir.glob("*.json"))
        if not candidates:
            return None
        # Most recently modified file — safe on all platforms.
        latest = max(candidates, key=lambda p: p.stat().st_mtime)
        return latest.stem
    except Exception:  # noqa: BLE001
        return None


# Cache for blocker error previews keyed by output_id.  A render of the manifest
# typically references each blocker output_id at most twice (once in
# _build_sealed_block, once via _format_blocker_entry), so a small LRU is enough
# to halve the disk reads without bounding growth across long sessions.  Sized
# generously to cover the rare case where many blocker entries share a render.
_BLOCKER_PREVIEW_CACHE_MAX: Final[int] = 32
_blocker_preview_cache: dict[str, str] = {}


def _extract_blocker_error_preview(entry: object, *, max_chars: int = 70) -> str:
    """Return a short error line extracted from a blocker's cached bash output.

    The cached output stored under ``entry.output_id`` is read via
    :mod:`token_goat.bash_cache` and scanned for the most discriminating line:
    lines containing ``"error"``, ``"failed"``, ``"traceback"``, ``"fatal"``,
    or ``"exception"`` (case-insensitive) win first; otherwise the last
    non-blank line is returned (typical exit summary or final stderr line).

    Returns an empty string on any failure — missing output_id, cache miss,
    permission error, parse error, etc.  Manifest assembly never blocks on
    this helper.

    Result is cached per-process by output_id so the sealed-block render and
    the per-blocker entry render share one disk read.  Cache is bounded at
    :data:`_BLOCKER_PREVIEW_CACHE_MAX`; FIFO eviction is good enough for the
    short-lived cache lifetime (one manifest render).
    """
    output_id = getattr(entry, "output_id", "") or ""
    if not output_id:
        return ""
    cached = _blocker_preview_cache.get(output_id)
    if cached is not None:
        return cached
    try:
        from . import bash_cache  # noqa: PLC0415  — deferred to keep cold-start cheap
        raw_output = bash_cache.load_output(output_id)
    except Exception:  # noqa: BLE001 — fail-soft per manifest contract
        _blocker_preview_cache[output_id] = ""
        return ""
    if not raw_output:
        _blocker_preview_cache[output_id] = ""
        return ""

    # Cap how many lines we scan so a huge cached output never adds latency
    # to manifest construction.  Most real error output surfaces a tag in
    # the first ~200 lines (or trails at the very end).
    lines = raw_output.splitlines()
    head = lines[:200]
    tail = lines[-20:] if len(lines) > 220 else []
    error_tokens = ("error", "failed", "traceback", "fatal", "exception", "✗")
    picked: str = ""
    for line in head + tail:
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        if any(tok in low for tok in error_tokens):
            picked = stripped
            break
    if not picked:
        # Fall back to last non-blank line — usually the exit summary.
        for line in reversed(lines):
            stripped = line.strip()
            if stripped:
                picked = stripped
                break

    picked = sanitize_log_str(picked, max_len=max_chars)
    # FIFO eviction once we hit the cap.
    if len(_blocker_preview_cache) >= _BLOCKER_PREVIEW_CACHE_MAX:
        # Pop the oldest entry (insertion order is preserved in Python dicts).
        oldest_key = next(iter(_blocker_preview_cache))
        _blocker_preview_cache.pop(oldest_key, None)
    _blocker_preview_cache[output_id] = picked
    return picked


def _format_blocker_entry(entry: object) -> str:
    """Render one failed :class:`session.BashEntry` as a "Current Blockers" line.

    Format::

        - ✗ pytest tests/  (exit 1) — AssertionError: expected 5, got 4
        - ✗ make build  (exit 2)

    The trailing "—" clause is a one-line error preview pulled from the cached
    output via :func:`_extract_blocker_error_preview` when available.  It is
    omitted when the preview is empty (cache miss, no output_id, or no
    discriminating line) — the compaction LLM still sees what failed and how,
    and the agent can retrieve details via ``token-goat bash-output <id>`` for
    the full trace.
    """
    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    exit_code = getattr(entry, "exit_code", "?")
    error_preview = _extract_blocker_error_preview(entry, max_chars=70)
    if error_preview:
        return f"- ✗ {cmd_preview}  (exit {exit_code}) — {error_preview}"
    return f"- ✗ {cmd_preview}  (exit {exit_code})"


def _select_top_entries(
    history: object,
    min_bytes: int,
    size_fn: Callable[[object], int],
    max_n: int,
    exclude_fn: Callable[[object], bool] | None = None,
) -> list[object]:
    """Recency-ranked selector shared by bash and web history dicts.

    Filters *history* values whose size (per *size_fn*) is below *min_bytes*,
    optionally excludes entries where *exclude_fn* returns True, and returns
    the *max_n* most-recent survivors.  Safe on legacy or missing fields
    (``None`` / non-dict input → empty list).
    """
    if not isinstance(history, dict) or not history:
        return []
    candidates = [
        e for e in history.values()
        if size_fn(e) >= min_bytes
        and (exclude_fn is None or not exclude_fn(e))
    ]
    if not candidates:
        return []
    return heapq.nlargest(max_n, candidates, key=lambda e: getattr(e, "ts", 0.0))


def _rank_symbols_by_recency(entry: FileEntry, now: float) -> list[str]:
    """Return symbols from *entry* ranked by recency (most recent first).

    Uses exponential decay with a 5-minute, 30-minute, and open-ended tiers:
    - Accessed within last 5 minutes: 1.5× recency multiplier
    - Accessed within last 30 minutes: 1.2× multiplier
    - Accessed earlier: 1.0× multiplier

    Symbols without timestamps (from legacy sessions) fall back to 1.0×.
    """
    # Backwards compatibility: symbols_ts may not exist on old entries
    symbols_ts = getattr(entry, 'symbols_ts', None)
    if not symbols_ts:
        # No timestamp info; return symbols in original order
        return entry.symbols_read

    # Build (symbol, score) pairs using recency multiplier
    scored_symbols: list[tuple[str, float, float]] = []
    for symbol in entry.symbols_read:
        ts = symbols_ts.get(symbol, 0.0)
        age_seconds = max(0.0, now - ts)
        # Tier-based multiplier: recent symbols rank first
        if age_seconds < 300:  # < 5 minutes
            multiplier = 1.5
        elif age_seconds < 1800:  # < 30 minutes
            multiplier = 1.2
        else:
            multiplier = 1.0
        scored_symbols.append((symbol, multiplier, ts))

    # Sort by tier desc, then raw timestamp desc (most recent within same tier first)
    scored_symbols.sort(key=lambda x: (x[1], x[2]), reverse=True)
    return [item[0] for item in scored_symbols]


def _collapse_class_methods(symbols: list[str]) -> list[str]:
    """Collapse 3+ methods of the same class to "ClassName.* (N methods)".

    When 3 or more methods of the same class are present, collapse them into
    a single "ClassName.* (N methods)" entry to save manifest tokens. Classes
    are detected using the ClassName.method_name pattern.

    Examples:
        ["Session.load", "Session.save", "Session.refresh"] → ["Session.* (3 methods)"]
        ["Session.load", "Session.save"] → ["Session.load", "Session.save"]  # not collapsed
        ["parse", "is_valid", "Session.refresh"] → ["parse", "is_valid", "Session.refresh"]

    Args:
        symbols: List of symbol names, potentially with ClassName.method patterns.

    Returns:
        A new list with 3+ methods of the same class collapsed into a single entry.
    """
    if not symbols:
        return []

    # Group symbols by class name
    class_methods: dict[str, list[str]] = {}
    non_methods: list[str] = []

    for symbol in symbols:
        if "." in symbol:
            parts = symbol.rsplit(".", 1)
            if len(parts) == 2:
                class_name, method = parts
                # Only treat as a method if class name looks like a class (starts with uppercase)
                if class_name and class_name[0].isupper():
                    if class_name not in class_methods:
                        class_methods[class_name] = []
                    class_methods[class_name].append(method)
                else:
                    non_methods.append(symbol)
            else:
                non_methods.append(symbol)
        else:
            non_methods.append(symbol)

    # Build result: collapsed groups + individual non-methods
    result: list[str] = []

    # Add collapsed class methods
    for class_name in sorted(class_methods.keys()):
        methods = class_methods[class_name]
        if len(methods) >= 3:
            result.append(f"{class_name}.* ({len(methods)} methods)")
        else:
            # 1-2 methods: keep them individually
            result.extend(f"{class_name}.{method}" for method in methods)

    # Add non-methods
    result.extend(non_methods)

    return result


def _dedup_symbols_across_files(
    entries: list,  # list[FileEntry]
    now: float,
) -> dict[str, tuple[str, float]]:
    """Deduplicate symbols across multiple files, keeping only most-recent reference.

    When the same symbol appears in multiple files, keep only the reference from
    the file where it was most recently accessed. This saves manifest tokens by
    eliminating redundant symbol listings.

    Args:
        entries: List of FileEntry objects with symbols_read.
        now: Current timestamp for recency ranking.

    Returns:
        A dict mapping symbol name to (file_path, access_timestamp).
        Only the most-recent file reference is kept per symbol.
    """
    symbol_map: dict[str, tuple[str, float]] = {}

    for entry in entries:  # type: ignore[var-annotated]  # entries is list without element type annotation; mypy cannot infer the item type for the loop variable
        if not getattr(entry, "symbols_read", None):
            continue
        ranked = _rank_symbols_by_recency(entry, now)  # type: ignore[arg-type]  # entry inferred as object from the untyped list; _rank_symbols_by_recency expects FileEntry
        symbols_ts = getattr(entry, "symbols_ts", None) or {}  # type: ignore[union-attr]  # entry is object; getattr returns object, but the or {} produces dict at runtime
        for symbol in ranked:
            ts = symbols_ts.get(symbol, 0.0)
            rel_or_abs = getattr(entry, "rel_or_abs", "")
            if symbol not in symbol_map or ts > symbol_map[symbol][1]:
                symbol_map[symbol] = (rel_or_abs, ts)

    return symbol_map


def _adaptive_bash_max(bash_history: object) -> int:
    """Compute the effective Bash entry cap based on session size.

    Short sessions (< 10 commands) are dominated by the bash section if the
    full _MAX_BASH_ENTRIES constant is used — the handful of commands run so
    far would fill the manifest while the agent still has fresh context.
    Scaling down for short sessions keeps the manifest proportional.

    Formula: ``min(_MAX_BASH_ENTRIES, max(2, len(bash_history) // 5))``.
    Examples:
    - 10 commands → 2  (10 // 5 = 2)
    - 25 commands → 5  (25 // 5 = 5, capped at 6)
    - 30 commands → 6  (30 // 5 = 6)
    - 60 commands → 6  (capped at _MAX_BASH_ENTRIES)
    """
    n = len(bash_history) if isinstance(bash_history, dict) else 0
    return min(_MAX_BASH_ENTRIES, max(2, n // 5))


def _select_top_bash_entries(bash_history: object) -> list[object]:
    """Pick up to an adaptive cap of cached Bash runs worth surfacing.

    The cap scales with session length (see :func:`_adaptive_bash_max`) so
    short sessions don't let the bash section dominate the manifest budget.
    """
    effective_max = _adaptive_bash_max(bash_history)
    return _select_top_entries(
        bash_history,
        min_bytes=_MIN_BASH_BYTES_FOR_MANIFEST,
        size_fn=lambda e: getattr(e, "stdout_bytes", 0) + getattr(e, "stderr_bytes", 0),
        max_n=effective_max,
        exclude_fn=_is_noop_bash_command,
    )


# Prefixes that identify test-runner commands eligible for the "What Worked" section.
# The heuristic matches the command preview string (lowercased, leading whitespace stripped)
# against this tuple using str.startswith — any command that begins with one of these
# is considered a test run.  Keep the list conservative: false positives (e.g. surfacing
# a non-test command as "What Worked") are more confusing than false negatives.
_TEST_COMMAND_PREFIXES: Final[tuple[str, ...]] = (
    "pytest",
    "uv run pytest",
    "python -m pytest",
    "npm test",
    "npm run test",
    "yarn test",
    "cargo test",
    "go test",
    "mocha",
    "jest",
    "make test",
    "make check",
)


def _is_test_command(entry: object) -> bool:
    """Return True when *entry*'s cmd_preview looks like a test-runner invocation.

    Matches against :data:`_TEST_COMMAND_PREFIXES` (case-insensitive prefix check).
    Short or empty previews never match.
    """
    cmd = getattr(entry, "cmd_preview", "").strip().lower()
    if not cmd:
        return False
    return any(cmd.startswith(prefix) for prefix in _TEST_COMMAND_PREFIXES)


def _select_what_worked(bash_history: object, blocker_ids: set[object]) -> list[object]:
    """Return at most 2 most-recent green (exit 0) test runs from *bash_history*.

    Criteria:
    - ``exit_code == 0`` (green pass)
    - ``cmd_preview`` matches a test-runner prefix (see :data:`_TEST_COMMAND_PREFIXES`)
    - ``output_id`` not in *blocker_ids* — don't surface the passing version of a
      command that is currently blocking (defensive: the current state is what matters)

    Results are returned most-recent-first.  Returns an empty list when no
    qualifying entries exist.

    *bash_history* is typed as ``object`` for the same defensive reason as
    :func:`_select_top_bash_entries` — legacy/test fixtures may not supply a dict.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []
    candidates = [
        e for e in bash_history.values()
        if getattr(e, "exit_code", None) == 0
        and _is_test_command(e)
        and getattr(e, "output_id", None) not in blocker_ids
    ]
    if not candidates:
        return []
    return heapq.nlargest(2, candidates, key=_BY_BASH_TS)


def _render_active_errors_section(session_id: str, max_errors: int = 3) -> list[str]:
    """Render recent error outputs from bash cache as an "Active Errors" section.

    Queries the bash_outputs cache for entries with error indicators (non-zero
    exit codes or error-pattern matches in output) and formats up to *max_errors*
    recent ones as a compact manifest section.

    Returns an empty list when no errors are found (section is omitted entirely).
    All errors are swallowed (fail-soft contract); manifest construction must never
    block on cache reads.

    Format::

        ### Active Errors
        - `pytest tests/` — AssertionError: expected 5, got 4
        - `uv sync` — error: some dependency conflict

    This section surfaces unresolved errors so the compaction LLM knows what is
    actively blocking and must be preserved in context across compaction.
    """
    if not session_id:
        return []

    try:
        from . import bash_cache as _bash_cache_mod  # noqa: PLC0415
        error_outputs = _bash_cache_mod.get_recent_error_outputs(session_id, max_entries=max_errors)
    except Exception:  # noqa: BLE001
        return []

    if not error_outputs:
        return []

    lines: list[str] = ["### Active Errors"]
    for error_entry in error_outputs[:max_errors]:
        cmd = sanitize_log_str(error_entry.get("command", ""), max_len=80)
        summary = sanitize_log_str(error_entry.get("error_summary", ""), max_len=100)
        if cmd and summary:
            lines.append(f"- `{cmd}` — {summary}")
        elif cmd:
            lines.append(f"- `{cmd}`")

    return lines if len(lines) > 1 else []  # Only return if we have at least the header + 1 entry


def _render_what_worked_section(entries: list[object], now_ts: float) -> list[str]:
    """Render a ``**Passed:**`` section listing at most 2 recent green test runs.

    Item #6: when there are 1–2 entries (the common case — the selector caps
    at 2 anyway) the section collapses to a single ``**Passed:** cmd1 (Nm),
    cmd2 (Nm)`` line.  Saves ~5 tokens vs. the previous header + bullet form
    and keeps the entries visually adjacent so the compaction LLM can see
    "what's green" at a glance.

    The cmd_preview is truncated to 60 characters.  Age is expressed in whole
    minutes (rounded down).  Output-id recall hints are dropped from the
    collapsed form — the agent can recover them from the bash section's
    cache pointers; duplicating them here was redundant context.

    Returns an empty list when *entries* is empty (no section emitted).
    """
    if not entries:
        return []

    def _format_entry(entry: object) -> str:
        raw_cmd = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=200)
        cmd = raw_cmd[:57] + "..." if len(raw_cmd) > 60 else raw_cmd
        ts = getattr(entry, "ts", now_ts)
        age_min = max(0, int((now_ts - ts) / 60))
        return f"`{cmd}` ({age_min}m)"

    # Item #6 collapse: 1-2 entries → single line.
    if len(entries) <= 2:
        joined = ", ".join(_format_entry(e) for e in entries)
        return [f"**Passed:** {joined}"]

    # Fallback for the hypothetical case where future selector loosens the cap:
    # keep the bulleted form with the old recall-id suffix so we still preserve
    # the per-entry output pointer when more than 2 entries are listed.
    lines: list[str] = ["**Passed:**"]
    for entry in entries:
        raw_cmd = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=200)
        cmd = raw_cmd[:57] + "..." if len(raw_cmd) > 60 else raw_cmd
        ts = getattr(entry, "ts", now_ts)
        age_min = max(0, int((now_ts - ts) / 60))
        oid = _short_id(sanitize_log_str(getattr(entry, "output_id", ""), max_len=64))
        lines.append(f"- ✅ `{cmd}` ({age_min} min ago) `{oid}`")
    return lines


def _extract_test_failures(bash_history: object) -> list[str]:
    """Scan bash_history for pytest runs and extract FAILED test names.

    Searches all test-runner entries (any ``_is_test_command`` match) in
    *bash_history* and loads their cached outputs via :mod:`bash_cache`.
    Lines matching the ``FAILED tests/...::...`` pattern are extracted and
    returned as a deduplicated list, newest-run first, capped at
    :data:`_MAX_TEST_FAILURES`.

    Returns an empty list when: no test commands ran, no cached output is
    available, or no ``FAILED`` lines are found.  All errors are swallowed
    — manifest construction must never raise.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []

    # Collect test-runner entries, sorted most-recent first.
    test_entries = sorted(
        (e for e in bash_history.values() if _is_test_command(e)),
        key=lambda e: getattr(e, "ts", 0.0),
        reverse=True,
    )
    if not test_entries:
        return []

    try:
        from . import bash_cache as _bash_cache_mod  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return []

    seen: set[str] = set()
    failures: list[str] = []

    for entry in test_entries:
        if len(failures) >= _MAX_TEST_FAILURES:
            break
        output_id = getattr(entry, "output_id", "") or ""
        if not output_id:
            continue
        try:
            raw = _bash_cache_mod.load_output(output_id)
        except Exception:  # noqa: BLE001
            continue
        if not raw:
            continue
        for line in raw.splitlines():
            m = _PYTEST_FAILED_RE.search(line)
            if m:
                name = sanitize_log_str(m.group(1), max_len=120)
                if name and name not in seen:
                    seen.add(name)
                    failures.append(name)
                    if len(failures) >= _MAX_TEST_FAILURES:
                        break

    return failures


# Package manager command prefixes that indicate a dependency change.
# Matches the beginning of cmd_preview (lowercased, stripped).
_DEP_COMMAND_PREFIXES: Final[tuple[str, ...]] = (
    "pip install",
    "pip3 install",
    "uv add",
    "uv pip install",
    "npm install",
    "npm i ",
    "yarn add",
    "yarn install",
    "pnpm add",
    "pnpm install",
    "cargo add",
    "poetry add",
    "gem install",
)


def _is_dep_command(entry: object) -> bool:
    """Return True when *entry*'s cmd_preview looks like a package-install command."""
    cmd = getattr(entry, "cmd_preview", "").strip().lower()
    return any(cmd.startswith(prefix) for prefix in _DEP_COMMAND_PREFIXES)


def _extract_dep_changes(bash_history: object) -> list[str]:
    """Scan bash_history for package-manager runs and extract dependency change lines.

    Searches the most-recent install command entries, loads their cached outputs,
    and returns lines that indicate packages were added or updated (e.g.
    ``Added: requests==2.31.0`` or ``+ requests 2.31.0``).  Capped at
    :data:`_MAX_DEP_CHANGES`.

    Returns an empty list when no relevant commands are found or all fail.
    All errors are swallowed.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []

    dep_entries = sorted(
        (e for e in bash_history.values() if _is_dep_command(e)),
        key=lambda e: getattr(e, "ts", 0.0),
        reverse=True,
    )
    if not dep_entries:
        return []

    try:
        from . import bash_cache as _bash_cache_mod  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return []

    # Patterns that indicate a package was added/updated/installed.
    # Covers pip/uv ("Successfully installed foo-1.0"), npm ("added 3 packages"),
    # cargo ("Compiling / Adding foo v1.0"), yarn ("info Direct dependencies").
    # (Pre-compiled at module level as _DEP_CHANGE_PATTERNS.)

    seen: set[str] = set()
    changes: list[str] = []

    for entry in dep_entries[:3]:  # only check the 3 most-recent installs
        if len(changes) >= _MAX_DEP_CHANGES:
            break
        output_id = getattr(entry, "output_id", "") or ""
        if not output_id:
            continue
        try:
            raw = _bash_cache_mod.load_output(output_id)
        except Exception:  # noqa: BLE001
            continue
        if not raw:
            continue
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            for pat in _DEP_CHANGE_PATTERNS:
                m = pat.search(stripped)
                if m:
                    clean = sanitize_log_str(stripped, max_len=100)
                    if clean and clean not in seen:
                        seen.add(clean)
                        changes.append(clean)
                        if len(changes) >= _MAX_DEP_CHANGES:
                            break
            if len(changes) >= _MAX_DEP_CHANGES:
                break

    return changes


def _format_session_stats(cache: object) -> str | None:
    """Return a compact 1-line session stats summary for the manifest header.

    Format: ``Stats: 3 edited  12 bash  7 suppressed``

    Shows: edited file count, bash command count, total hints suppressed.
    Returns None when all three values are zero (nothing worth showing).
    """
    edited_count = len(getattr(cache, "edited_files", None) or {})
    bash_count = len(getattr(cache, "bash_history", None) or {})
    _sup_raw = getattr(cache, "hints_suppressed_by_type", None) or {}
    suppressed = sum(_sup_raw.values()) if isinstance(_sup_raw, dict) else 0

    if edited_count == 0 and bash_count == 0 and suppressed == 0:
        return None

    parts: list[str] = []
    if edited_count:
        parts.append(f"{edited_count} edited")
    if bash_count:
        parts.append(f"{bash_count} bash")
    if suppressed:
        parts.append(f"{suppressed} suppressed")

    return "Stats: " + "  ".join(parts) if parts else None


def _middle_truncate(text: str, max_lines: int = 20) -> str:
    """Return *text* middle-truncated to at most *max_lines* lines.

    When the line count is within *max_lines* the text is returned unchanged.
    Otherwise the first ``ceil(max_lines * 0.4)`` lines and the last
    ``ceil(max_lines * 0.4)`` lines are kept, with a human-readable omission
    marker inserted between them::

        line 1
        line 2
        ... [8 lines omitted] ...
        line 11
        line 12

    The split is intentionally biased toward showing both the beginning (which
    usually contains the command header / test summary) and the end (which
    usually contains the final error or result), dropping the noisy middle.

    *max_lines* must be >= 2; values below 2 are clamped to 2.
    """
    if max_lines < 2:
        max_lines = 2
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    keep = math.ceil(max_lines * 0.4)
    head = lines[:keep]
    tail = lines[-keep:]
    omitted = len(lines) - keep * 2
    marker = f"... [{omitted} lines omitted] ..."
    return "\n".join(head + [marker] + tail)


def _render_cache_meta(
    status: str,
    body_bytes: int,
    *,
    truncated: bool = False,
    output_id: str = "",
) -> str:
    """Build the parenthesised metadata suffix shared by bash and web manifest lines.

    Examples::

        _render_cache_meta("e=0", 12345)
        # → "(e=0, 12.1KB)"

        _render_cache_meta("200", 14200, truncated=True, output_id="abc123ef")
        # → "(200, 13.9KB (truncated), id=abc123ef)"

    When *output_id* is non-empty the ``id=<short>`` component is appended so
    the compaction LLM can recall the body via ``token-goat web-output <id>``.
    When *truncated* is True ``" (truncated)"`` is inserted after the byte count.
    """
    truncated_marker = " (truncated)" if truncated else ""
    bytes_str = _humanize_bytes(body_bytes)
    id_part = f", id={_short_id(output_id)}" if output_id else ""
    return f"({status}, {bytes_str}{truncated_marker}{id_part})"


def _format_bash_entry(entry: object, inline_snippet: bool = True, *, is_blocker: bool = False) -> str:
    """Render one :class:`session.BashEntry` as a single manifest line.

    Format::

        - $ pytest -v tests/  (e=1, 12.3KB)
        - $ pytest -v tests/  [×3] (e=1, 12.3KB)

    When *inline_snippet* is True and a cached output body is available it is
    loaded from disk, passed through :func:`_middle_truncate` (keeping the
    first+last ~40 % of lines), and appended as an indented block so the
    compaction LLM can see both the header and tail of long outputs without
    paying for the noisy middle.

    When *inline_snippet* is False the header line only is returned.
    Byte counts use a compact human suffix (KB/MB) because the raw integer
    (``12345``) is harder to scan in a glance-level summary.  ``[×N]`` appears
    when the command was retried (same SHA, run_count > 1) so retry loops are
    immediately visible.

    *is_blocker* controls the inline snippet line cap: blocker entries keep 20
    lines (failure context is load-bearing); non-blocker entries cap at 12 to
    save ~60-200 tokens/session.
    """
    from . import bash_cache as bash_cache_mod

    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    total = int(getattr(entry, "stdout_bytes", 0)) + int(getattr(entry, "stderr_bytes", 0))
    exit_code = getattr(entry, "exit_code", None)
    output_id = getattr(entry, "output_id", "")
    run_count = int(getattr(entry, "run_count", 1))
    run_count_marker = f" [×{run_count}]" if run_count > 1 else ""
    exit_str = "e=?" if exit_code is None else f"e={exit_code}"
    truncated = bool(getattr(entry, "truncated", False))
    # Item #10: when the command's output is small (<1KB) AND not truncated,
    # the byte count carries no useful signal — drop it entirely.  Saves
    # ~3 tokens/entry across the typical short-command-heavy session.
    if not truncated and total < 1024:
        meta = f"({exit_str})"
    else:
        meta = _render_cache_meta(exit_str, total, truncated=truncated)
    header = f"- $ {cmd_preview}{run_count_marker}  {meta}"

    if not inline_snippet:
        return header

    # Attempt to load cached output for inline snippet.  Failures are silently
    # ignored — the metadata line is always emitted even without the body.
    # Non-blocker entries are capped at 12 lines (was 20) to save ~60-200
    # tokens/session; blocker entries keep 20 lines because failure output is
    # the most load-bearing content in the manifest and needs more context.
    snippet: str | None = None
    if output_id:
        try:
            raw = bash_cache_mod.load_output(output_id)
            if raw and raw.strip():
                snippet_max_lines = 20 if is_blocker else 12
                snippet = _middle_truncate(raw.strip(), max_lines=snippet_max_lines)
        except Exception:  # noqa: BLE001
            pass

    if snippet:
        indented = "\n".join(f"  {line}" for line in snippet.splitlines())
        return f"{header}\n{indented}"
    return header


def _select_top_web_entries(web_history: object) -> list[object]:
    """Pick up to :data:`_MAX_WEB_ENTRIES` web fetches worth surfacing in the manifest.

    Filters out dead-end fetches:
    - HTTP errors (4xx, 5xx status codes) carry no useful content
    - Bodies below :data:`_MIN_WEB_BYTES_FOR_MANIFEST` threshold are filtered by _select_top_entries
    """
    def is_dead_end(entry: object) -> bool:
        """Return True if this web fetch is a dead-end (error or worthless)."""
        status_code = getattr(entry, "status_code", None)
        return status_code is not None and status_code >= 400

    return _select_top_entries(
        web_history,
        min_bytes=_MIN_WEB_BYTES_FOR_MANIFEST,
        size_fn=lambda e: getattr(e, "body_bytes", 0),
        max_n=_MAX_WEB_ENTRIES,
        exclude_fn=is_dead_end,
    )


def _format_web_entry(entry: object) -> str:
    """Render one :class:`session.WebEntry` as a single manifest line.

    Format::

        - 🌐 https://docs.example.com/api  (200, 14.2KB, id=abc123...)
        - 🌐 https://example.com/page  (404, 0.5KB, id=def456...)

    The cache ID is included so the compaction LLM can hand the agent
    ``token-goat web-output <id>`` to recover the body without re-fetching.
    Status code distinguishes successful fetches from error responses so the
    LLM knows whether the cached body is useful content or an error page.
    """
    url_preview = sanitize_log_str(getattr(entry, "url_preview", ""), max_len=100)
    body_bytes = int(getattr(entry, "body_bytes", 0))
    status_code = getattr(entry, "status_code", None)
    output_id = sanitize_log_str(getattr(entry, "output_id", ""), max_len=24)
    status_str = str(status_code) if status_code is not None else "?"
    meta = _render_cache_meta(
        status_str,
        body_bytes,
        truncated=bool(getattr(entry, "truncated", False)),
        output_id=output_id,
    )
    return f"- 🌐 {url_preview}  {meta}"


def _group_web_entries_by_domain(entries: list[object]) -> list[str]:
    """Group web entries by domain to save tokens in the manifest.

    When multiple URLs share the same domain, they are grouped as:
        → domain (N): path1, path2, ...

    Single URLs per domain show the full path. Very long aggregations are
    truncated with an indication of overflow.

    Args:
        entries: List of :class:`session.WebEntry` objects.

    Returns:
        List of formatted strings, one per domain or single-URL entry.
    """
    from collections import defaultdict

    if not entries:
        return []

    # Group entries by netloc (domain)
    domain_groups: dict[str, list[object]] = defaultdict(list)
    for entry in entries:
        url_preview = getattr(entry, "url_preview", "")
        if not url_preview:
            continue
        try:
            parsed = urlparse(url_preview)
            netloc = parsed.netloc or "unknown"
        except Exception:  # noqa: BLE001
            netloc = "unknown"
        domain_groups[netloc].append(entry)

    result = []
    for netloc in sorted(domain_groups.keys()):
        group = domain_groups[netloc]
        if len(group) == 1:
            # Single URL: use full format
            line = _format_web_entry(group[0])
            result.append(line)
        else:
            # Multiple URLs from same domain: compact format
            # Extract paths from each URL
            paths = []
            for entry in group:
                url_preview = getattr(entry, "url_preview", "")
                try:
                    parsed = urlparse(url_preview)
                    path = parsed.path or "/"
                    if parsed.params or parsed.query:
                        path += f"{parsed.params}{('?' + parsed.query) if parsed.query else ''}"
                    paths.append(path)
                except Exception:  # noqa: BLE001
                    paths.append("?")

            # Format as compact line: "→ domain (N): path1, path2, ..."
            path_str = ", ".join(paths)
            # Truncate if too long (keep to ~80 chars for path summary)
            if len(path_str) > 80:
                path_str = path_str[:77] + "..."
            line = f"- 🌐 {netloc} ({len(group)}): {path_str}"
            result.append(line)

    return result


def _select_top_skill_entries(
    skill_history: object,
    *,
    session_started_ts: float = 0.0,
) -> list[object]:
    """Pick up to :data:`_MAX_ACTIVE_SKILLS` skill loads worth surfacing.

    Returns the most-recently-loaded skills, newest first.  Any skill entry
    whose ``ts`` falls within the current session window (i.e. after
    *session_started_ts* minus a small clock-skew buffer) is included
    regardless of how long ago it was loaded — a skill loaded at the very
    start of a 4-hour session is just as load-bearing at hour 3 as it was at
    hour 0.

    The legacy :data:`_SKILL_STALE_THRESHOLD_SECS` fixed-window filter was
    dropped because it caused skills to silently vanish from the compaction
    manifest roughly 30 minutes after they were first loaded, even though the
    session was still active and the agent still relied on the skill's protocol.

    Filtering rule (first match wins, top priority first):
    1. Skill was loaded within the current session (ts >= session_started_ts - 60 s).
    2. Skill was loaded within the last :data:`_SKILL_STALE_THRESHOLD_SECS`
       (fallback when session_started_ts is 0/unknown).
    3. Skill is excluded — it pre-dates the session and the staleness window.

    When the same skill was loaded multiple times (e.g. loaded, then updated
    on disk, then loaded again with different content_sha), returns only the
    most recent version to avoid cluttering the manifest with superseded bodies.
    Sessions typically load a handful of skills total; stale skills are excluded.
    """
    if not isinstance(skill_history, dict) or not skill_history:
        return []

    now = time.time()
    # Determine the earliest timestamp we accept.  When session_started_ts is
    # available (non-zero), use it as the lower bound (with a 60-second grace
    # buffer for minor clock-skew between the session-start write and the first
    # skill load).  When not available, fall back to the legacy 30-min window.
    if session_started_ts > 0.0:
        cutoff_ts = session_started_ts - 60.0  # 60 s grace for clock-skew
    else:
        cutoff_ts = now - _SKILL_STALE_THRESHOLD_SECS

    # Filter to skills loaded within the accepted window.
    recent_skills = [
        entry for entry in skill_history.values()
        if getattr(entry, "ts", 0.0) >= cutoff_ts
    ]

    # Deduplicate by skill name: keep only the most-recent content_sha per skill.
    # When a skill file is updated mid-session, multiple entries may exist with
    # the same name but different content_sha / output_id. Retaining all versions
    # would clutter the manifest; the most-recent body is what the agent should use.
    deduped: dict[str, object] = {}
    for entry in recent_skills:
        skill_name = getattr(entry, "skill_name", "")
        ts = getattr(entry, "ts", 0.0)
        if skill_name not in deduped or ts > getattr(deduped[skill_name], "ts", 0.0):
            deduped[skill_name] = entry

    # Sort by a composite score: recency (ts) + a small boost per extra load.
    # A skill with run_count=3 loaded 10 minutes ago should rank above one
    # with run_count=1 loaded 8 minutes ago — both are actively in use, but
    # the repeated load signals the agent relies on it more heavily.  The
    # boost is capped so an ancient but frequently-loaded skill from a prior
    # session cannot displace a genuinely recent one: each extra load is
    # worth at most 60 seconds of recency.
    _RECENCY_BOOST_PER_LOAD_SECS = 60.0

    def _skill_rank(e: object) -> float:
        ts = getattr(e, "ts", 0.0)
        rc = max(1, int(getattr(e, "run_count", 1)))
        return ts + (rc - 1) * _RECENCY_BOOST_PER_LOAD_SECS

    return heapq.nlargest(
        _MAX_ACTIVE_SKILLS,
        deduped.values(),
        key=_skill_rank,
    )


def _format_skill_entry(entry: object) -> str:
    """Render one :class:`session.SkillEntry` as a single manifest line.

    Format::

        - 🧠 ralph  ×3  (28KB)  recall: `token-goat skill-body ralph`
        - 🧠 plugin:improve  (12KB)  (stale: 8h)  recall: `token-goat skill-body plugin:improve`
        - 🧠 brainstorm  (30KB)*  recall: `token-goat skill-body brainstorm`

    Annotations:
    - ``×N``: skill was loaded N times in the session (only shown if N > 1)
    - ``(stale: Xh)``: skill body cached more than :data:`_SKILL_STALE_FOR_SESSION_SECS`
      ago; the underlying skill file may have been updated since and the cached
      body could be outdated. Agent should verify freshness via ``token-goat
      skill-body`` or re-invoke if critical.
    - ``*`` (after byte size): skill body was truncated when stored; the cached
      version is partial, typically last ~256 KB kept with head dropped.

    The recall hint points the post-compact agent at the cached body so the full
    prose can be retrieved without re-invoking the skill (which would replay any
    side effects).
    """
    name = sanitize_log_str(getattr(entry, "skill_name", ""), max_len=80)
    body_bytes = int(getattr(entry, "body_bytes", 0))
    run_count = int(getattr(entry, "run_count", 1))
    truncated = bool(getattr(entry, "truncated", False))
    ts = float(getattr(entry, "ts", time.time()))

    count_str = f"  ×{run_count}" if run_count > 1 else ""
    size_str = _humanize_bytes(body_bytes)
    trunc_marker = "*" if truncated else ""

    # Flag stale skills: loaded more than 6 hours ago
    now = time.time()
    age_secs = now - ts
    stale_str = ""
    if age_secs > _SKILL_STALE_FOR_SESSION_SECS:
        age_hours = int(age_secs / 3600)
        stale_str = f"  (stale: {age_hours}h)"

    return f"- 🧠 {name}{count_str}  ({size_str}{trunc_marker}){stale_str}  recall: `token-goat skill-body {name}`"


def _select_top_decision_entries(decisions: object) -> list[object]:
    """Pick up to :data:`_MAX_DECISIONS` recent decision entries for the manifest.

    The session ``decisions`` list is append-only, newest-last, so returning the
    last ``_MAX_DECISIONS`` slice preserves chronological order without a sort.
    Older entries remain on disk and are reachable via ``token-goat decision
    --list``; this selector intentionally favours recency over breadth.
    """
    if not isinstance(decisions, list) or not decisions:
        return []
    return list(decisions[-_MAX_DECISIONS:])


def _format_decision_entry(entry: object) -> str:
    """Render one :class:`session.DecisionEntry` as a single manifest line.

    Format::

        - 💡 [rationale] Picked option A because lower risk
        - 💡 Chose plan B — fits budget

    The tag (if any) is wrapped in square brackets as a column-style prefix so
    grep + tag-filtering is straightforward.  Text is hard-trimmed at
    :data:`_MAX_DECISION_RENDER_LEN`; the on-disk entry retains the full body
    for the ``token-goat decision --list`` recall path.
    """
    text = sanitize_log_str(getattr(entry, "text", ""), max_len=_MAX_DECISION_RENDER_LEN)
    tag = sanitize_log_str(getattr(entry, "tag", ""), max_len=24)
    tag_str = f"[{tag}] " if tag else ""
    return f"- 💡 {tag_str}{text}"


def _format_hint_telemetry(cache: object) -> str | None:
    """Return a one-line hint activity summary for the manifest header, or None.

    Emitted only when at least one hint was emitted or suppressed this session.
    Both zeroes means no hints fired at all (e.g. first tool call, cold session)
    and the line adds no signal.

    Format: ``(12 hints, 4 suppressed)``
    """
    emitted = int(getattr(cache, "hints_emitted", 0) or 0)
    _sup_raw = getattr(cache, "hints_suppressed_by_type", None) or {}
    suppressed = sum(_sup_raw.values()) if isinstance(_sup_raw, dict) else 0
    if emitted == 0 and suppressed == 0:
        return None
    if suppressed == 0:
        return f"({emitted} hints)"
    return f"({emitted} hints, {suppressed} suppressed)"


def _select_top_glob_entries(glob_history: object) -> list[object]:
    """Pick up to :data:`_MAX_GLOB_ENTRIES` glob scans worth surfacing in the manifest.

    Filters trivially broad patterns (``*``, ``**``, empty) that carry no useful
    context for the compaction LLM, and returns the most recent survivors.
    Accepts ``glob_history`` typed as ``object`` for defensive compatibility with
    legacy SessionCache instances (``None`` / non-list → empty list).
    """
    if not isinstance(glob_history, list) or not glob_history:
        return []
    _TRIVIAL = {"", "*", "**"}
    candidates = [
        e for e in glob_history
        if sanitize_log_str(getattr(e, "pattern", ""), max_len=256).strip() not in _TRIVIAL
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_GLOB_ENTRIES, candidates, key=lambda e: getattr(e, "ts", 0.0))


def _format_glob_entry(entry: object, *, cwd: str | None = None) -> str:
    """Render one :class:`session.GlobEntry` as a single manifest line.

    Format::

        - g: **/*.py  (src/, 42 files)
        - g: tests/**  (27 files)
        - g: src/**/*.ts

    Item #4: the ``📂`` emoji prefix is replaced with the ASCII marker ``g:``
    (multi-byte emojis cost more tokens than 2 ASCII chars), and the scope
    path is suppressed when it equals *cwd* (the path scope is then redundant
    — the agent already knows the working directory).
    """
    pattern = sanitize_log_str(getattr(entry, "pattern", ""), max_len=80)
    path = getattr(entry, "path", None)
    if path and cwd:
        # Suppress scope path when it equals the session cwd.
        norm_path = _norm_key(str(path)).rstrip("/")
        norm_cwd = _norm_key(str(cwd)).rstrip("/")
        if norm_path == norm_cwd:
            path = None
    count = getattr(entry, "result_count", None)
    scope = f"  ({path}" if path else ""
    hits = (f", {count} files)" if scope else f"  ({count} files)") if isinstance(count, int) else (")" if scope else "")
    return f"- g: {pattern}{scope}{hits}"


def _token_count(text: str) -> int:
    """Rough token estimate: 1 token ≈ 4 characters.

    Used for per-section budget enforcement inside :func:`_render`.
    :func:`estimate_tokens` uses ``len // 3 + 1`` (more generous).  Using 4
    here makes section budgets slightly conservative so the assembled manifest
    fits the global budget even before the final ``estimate_tokens`` check.
    """
    return len(text) // 4


def _section_budgets(total_budget: int, edited_tokens: int, section_content_counts: dict[str, int] | None = None) -> dict[str, int]:
    """Distribute the manifest token budget across variable sections.

    The edited-files section is must-preserve and gets its full allocation first.
    The remaining budget is split proportionally among sections with content:

        - ``symbols``  — 38 %
        - ``files``    — 22 %
        - ``greps``    — 15 %
        - ``bash``     — 10 %
        - ``web``      — 10 %
        - ``glob``     — 5 %

    Sections with zero entries are excluded from budget allocation, and their share
    flows proportionally to sections with content.

    Every non-empty section is guaranteed at least *_MIN_SECTION_TOKENS* tokens so that a
    section with a very tight budget still renders at least one line.

    Args:
        total_budget:          The global token ceiling for the entire manifest.
        edited_tokens:         Token estimate for the already-rendered edited-files block
                               (header + file lines + diff stat + commits).  This is
                               subtracted from *total_budget* before distribution.
        section_content_counts: Optional dict mapping section names to entry counts.
                               If provided, sections with count==0 get 0 allocation.
                               If None, all sections are treated as potentially having content
                               (backward-compat mode: static proportions).

    Returns:
        A dict with keys ``"symbols"``, ``"files"``, ``"greps"``, ``"bash"``, ``"web"``, ``"glob"``
        mapping to their respective token budgets.
    """
    remaining = max(0, total_budget - edited_tokens)

    # Proportions must sum to 1.0.
    base_proportions: dict[str, float] = {
        "symbols": 0.38,
        "files":   0.22,
        "greps":   0.15,
        "bash":    0.10,
        "web":     0.10,
        "glob":    0.05,
    }

    # If no content info provided, use static proportions (backward compatible).
    if section_content_counts is None:
        _MIN_SECTION_TOKENS = 20  # Old minimum for backward compat
        budgets: dict[str, int] = {}
        for name, ratio in base_proportions.items():
            budgets[name] = max(_MIN_SECTION_TOKENS, int(remaining * ratio))
        return budgets

    # Content-aware mode: filter out empty sections and redistribute their budget.
    # Identify which sections have content.
    sections_with_content = {
        name for name in base_proportions
        if section_content_counts.get(name, 0) > 0
    }

    # If no sections have content, return all zeros.
    if not sections_with_content:
        return dict.fromkeys(base_proportions, 0)

    # Redistribute proportions: renormalize to sum to 1.0 among non-empty sections.
    active_proportions = {
        name: base_proportions[name] for name in sections_with_content
    }
    proportion_sum = sum(active_proportions.values())
    normalized_proportions = {
        name: (prop / proportion_sum) for name, prop in active_proportions.items()
    }

    # Allocate: empty sections get 0, others get proportional share with floor applied.
    _MIN_SECTION_TOKENS = 40  # Minimum for non-empty sections in content-aware mode
    result_budgets: dict[str, int] = {}
    for name in base_proportions:
        if name not in sections_with_content:
            result_budgets[name] = 0
        else:
            result_budgets[name] = max(_MIN_SECTION_TOKENS, int(remaining * normalized_proportions[name]))

    return result_budgets


def _grep_sort_key(entry: object, now_ts: float) -> float:
    """Composite sort key for grep entries: recency_weight * (1 + normalised match_count).

    Recency weight uses exponential decay with :data:`_GREP_RECENCY_HALF_LIFE_SECS`
    so a search from 30 minutes ago is worth half as much as one from just now.
    The match_count factor rewards searches that actually found results — a search
    that returned 20 matches is more load-bearing context than one that returned 0.
    Match counts are normalised to [0, 1] by capping at 100 so a single mega-result
    search does not completely swamp recency.

    Returns a float in (0, 2] — higher is more important.
    """
    age = max(0.0, now_ts - getattr(entry, "ts", 0.0))
    recency = math.exp(-age * math.log(2) / _GREP_RECENCY_HALF_LIFE_SECS)
    match_count = getattr(entry, "result_count", None)
    # Treat unknown result_count as 1 (neutral) so it neither boosts nor penalises.
    count_factor = 1.0 + min(100, match_count or 1) / 100.0
    return recency * count_factor


def _select_top_grep_entries(greps: list[object]) -> list[object]:
    """Pick up to :data:`_MAX_GREP_ENTRIES` best unique grep patterns for the manifest.

    **Step 1 — Dedup by pattern text**: iterate oldest→newest so the most-recent
    search (with its current path scope and result_count) overwrites earlier ones.
    Deduplicating by pattern alone (not pattern+path) avoids listing the same search
    term twice just because the scope changed between runs.

    **Step 2 — Drop stale entries**: patterns older than :data:`_GREP_STALE_SECS`
    (45 min) are unlikely to drive the next agent turn.  If *all* patterns are stale,
    the :data:`_GREP_MIN_WHEN_ALL_STALE` most-recent ones are kept so the section is
    never entirely empty when searches exist.

    **Step 3 — Rank by composite score**: :func:`_grep_sort_key` combines a
    30-minute recency half-life with a normalised match_count factor so searches that
    found more results AND were more recent surface first.

    Accepts ``greps`` typed as ``list[object]`` (rather than ``list[GrepEntry]``) to
    avoid importing :class:`session.GrepEntry` at cold-start time; all field access is
    via :func:`getattr`.
    """
    if not greps:
        return []

    # Step 1: Deduplicate by pattern — keep the most-recent occurrence.
    seen: dict[str, object] = {}
    for g in sorted(greps, key=lambda g: getattr(g, "ts", 0.0)):
        seen[getattr(g, "pattern", "")] = g
    candidates = list(seen.values())
    if not candidates:
        return []

    # Step 1b: Drop zero-result greps — searches that found nothing carry no
    # context the compaction LLM should preserve. If every grep was zero-result
    # (the user is exploring blindly and nothing matches yet), keep them all so
    # the section still surfaces — better to show "looking for X, no hits yet"
    # than nothing.
    with_hits = [g for g in candidates if (getattr(g, "result_count", 0) or 0) > 0]
    if with_hits:
        candidates = with_hits

    # Step 2: Staleness filter — drop entries older than _GREP_STALE_SECS.
    now_ts = time.time()
    fresh = [g for g in candidates if (now_ts - getattr(g, "ts", 0.0)) < _GREP_STALE_SECS]
    if not fresh:
        # All entries are stale — surface the _GREP_MIN_WHEN_ALL_STALE most-recent ones
        # so the section is never entirely empty when searches exist.
        fresh = heapq.nlargest(
            _GREP_MIN_WHEN_ALL_STALE,
            candidates,
            key=lambda g: getattr(g, "ts", 0.0),
        )

    # Step 3: Rank by composite (recency × match_count) score, then pick top N.
    return heapq.nlargest(_MAX_GREP_ENTRIES, fresh, key=lambda g: _grep_sort_key(g, now_ts))


def _dedup_grep_entries(
    entries: list[object],
    raw_counts: dict[str, int] | None = None,
) -> list[object]:
    """Deduplicate and annotate grep entries: group by pattern, keep best representative.

    When the same grep pattern appears multiple times in the entries list,
    this function collapses them into a single entry and appends " [×N]"
    to the pattern string where N is the count.  The entry with the most
    matches (or the latest timestamp if counts tie) is chosen as the
    representative.

    ``raw_counts`` is an optional pre-computed dict mapping pattern text to its
    total occurrence count in the *original* (unfiltered) session history.
    When provided, its count overrides the internal count that would otherwise
    always be 1 (because callers typically pass already-deduped entries from
    :func:`_select_top_grep_entries`).  This lets the annotation reflect how
    many times the agent actually ran each search.

    Args:
        entries: List of grep entry objects.
        raw_counts: Optional mapping of pattern → raw occurrence count.

    Returns:
        A deduplicated list where each unique pattern appears once,
        with the pattern field annotated with a count suffix when N > 1.
    """
    if not entries:
        return []

    # Group entries by pattern text
    pattern_groups: dict[str, tuple[object, int]] = {}
    for entry in entries:
        pattern = getattr(entry, "pattern", "")
        if not pattern:
            continue

        result_count = getattr(entry, "result_count", None)
        ts = getattr(entry, "ts", 0.0)

        if pattern not in pattern_groups:
            # First occurrence: store entry and count
            pattern_groups[pattern] = (entry, 1)
        else:
            # Subsequent occurrence: increment count and possibly replace entry
            existing_entry, count = pattern_groups[pattern]
            existing_count = getattr(existing_entry, "result_count", None)
            existing_ts = getattr(existing_entry, "ts", 0.0)

            # Prefer entry with more matches; on tie, prefer more recent
            should_replace = False
            if result_count is not None and existing_count is not None:
                should_replace = result_count > existing_count
            elif result_count is not None or ts > existing_ts:
                should_replace = True

            if should_replace:
                pattern_groups[pattern] = (entry, count + 1)
            else:
                pattern_groups[pattern] = (existing_entry, count + 1)

    # Build result: create modified entries with annotated patterns when count > 1.
    # When raw_counts is provided, use its value — the internal count is always 1
    # because _select_top_grep_entries already deduplicated before calling us.
    class _AugmentedEntry:
        """Wrapper that substitutes an annotated pattern without mutating the original."""
        def __init__(self, orig: object, new_pattern: str) -> None:
            self._orig = orig
            self._pattern = new_pattern

        def __getattr__(self, name: str) -> Any:
            if name == "pattern":
                return self._pattern
            return getattr(self._orig, name)

    result: list[object] = []
    for pattern, (entry, count) in pattern_groups.items():
        effective_count = (raw_counts or {}).get(pattern, count)
        if effective_count == 1:
            result.append(entry)
        else:
            annotated_pattern = f"{pattern} [×{effective_count}]"
            result.append(_AugmentedEntry(entry, annotated_pattern))

    return result


def _format_grep_entry(entry: object) -> str:
    """Render one :class:`session.GrepEntry` as a single manifest line.

    Format::

        - `pattern` in src/token_goat/ (12)
        - `pattern` (0)                (zero = dead end, still informative)
        - `pattern` in src/            (when result_count is unknown)

    Item #3: the explicit "results"/"result" noun is dropped — bare ``(N)`` is
    unambiguous in context and saves ~1 token per entry × _MAX_GREP_ENTRIES.
    The compaction LLM infers the count semantics from the grep line shape.
    """
    pattern = sanitize_log_str(getattr(entry, "pattern", ""), max_len=80)
    path = getattr(entry, "path", None)
    result_count = getattr(entry, "result_count", None)
    path_str = f" in {_short_path(path)}" if path else ""
    count_str = f" ({result_count})" if result_count is not None else ""
    return f"- `{pattern}`{path_str}{count_str}"


def _load_session_cache(session_id: str, caller: str) -> SessionCache | None:
    """Validate *session_id* and load the session cache, returning ``None`` on any failure.

    Thin shim over :func:`session_mod.safe_load` that adds a structured debug
    log line with file/grep/edit counts on success.  The four
    ``build_manifest*`` / ``event_count`` callers each pass a distinct *caller*
    label so log lines remain distinguishable.
    """
    from . import (
        session as session_mod,  # deferred — cold-start; __getattr__ handles external access
    )
    cache = session_mod.safe_load(session_id, caller=caller)
    if cache is not None:
        _LOG.debug(
            "%s: session=%s loaded (files=%d greps=%d edited=%d)",
            caller,
            session_id[:8],
            len(cache.files),
            len(cache.greps),
            len(cache.edited_files),
        )
    return cache


def _session_age_tier(age_seconds: float) -> str:
    """Classify session age into a tier that controls manifest verbosity.

    young  < 10 min  → minimal manifest; session is fresh, little to preserve
    active 10-60 min → standard manifest
    mature > 60 min  → expanded manifest; session has significant context
    """
    if age_seconds < 600:
        return "young"
    if age_seconds < 3600:
        return "active"
    return "mature"


def _compute_activity_multiplier(age_seconds: float, edit_count: int) -> float:
    """Return an adaptive tier multiplier that considers both session age and edit density.

    Starts from the age-based tier factor and applies a downgrade when the session
    has been running long but accumulated little edit activity — a long idle session
    should not consume the same manifest budget as a long busy one.

    Age factors:  young(<10min)=0.6  active(10-60min)=1.0  mature(>60min)=1.4
    Density downgrade: when age >= 10 min and edits/minute < 0.3, cap at 1.0 (active).
    Density is not meaningful for very short sessions, so sessions below 10 min
    always use their age factor unchanged.
    """
    tier = _session_age_tier(age_seconds)
    age_factors = {"young": 0.6, "active": 1.0, "mature": 1.4}
    factor = age_factors[tier]

    if age_seconds >= 600:  # only apply density logic once session is past the young threshold
        age_minutes = age_seconds / 60.0
        density = edit_count / max(1.0, age_minutes)
        if density < 0.3:
            # Low-activity session: cap at active-tier factor even if age would give mature.
            factor = min(factor, 1.0)

    return factor


def _compute_stale_compact_fraction(session_id: str, skill_history: dict) -> float:  # type: ignore[type-arg]
    """Return the fraction of loaded skills whose compact is missing or stale.

    A compact is considered **stale** when:
    - No compact file exists for the skill, OR
    - The compact file's embedded SHA (12-char prefix from the header) does not
      match the first 12 characters of the session's recorded ``content_sha`` for
      that skill entry.

    A compact is considered **fresh** when a compact file exists whose embedded
    SHA is a prefix of the session's ``content_sha`` (or the compact has no SHA
    header at all — treated as unknown/fresh to be conservative).

    Returns ``0.0`` when no skills are loaded.  Returns a value in ``[0.0, 1.0]``.

    This fraction drives :func:`compute_adaptive_budget`: sessions where many
    skills cannot contribute compacts to the manifest need more token budget to
    compensate with other context sections.
    """
    if not skill_history:
        return 0.0

    from . import skill_cache as _sc  # noqa: PLC0415

    total = 0
    stale_count = 0
    for name, entry in skill_history.items():
        total += 1
        entry_sha: str = getattr(entry, "content_sha", "") or ""
        compact_text = _sc.get_compact_any_session(name)
        if compact_text is None:
            # No compact at all → stale
            stale_count += 1
            continue
        embedded_sha = _sc.extract_compact_source_sha(compact_text)  # type: ignore[attr-defined]
        if embedded_sha is None:
            # No SHA in header (old-format compact) → treat as fresh (unknown ≠ stale)
            continue
        if entry_sha and not entry_sha.startswith(embedded_sha):
            stale_count += 1

    return stale_count / total if total > 0 else 0.0


def compute_adaptive_budget(
    cache: SessionCache,
    age_seconds: float = 0.0,
    *,
    has_pending_diff: bool = False,
    has_uncommitted_changes: bool = False,
    stale_compact_fraction: float = 0.0,
    context_pressure: ContextPressure | None = None,
) -> int:
    """Compute an adaptive token budget for the manifest based on session complexity.

    Simple sessions (few edits, no bash history) waste no budget; complex sessions
    get more room to preserve signal.  Formula:

        Base: 200 tokens
        + min(200, edited_files_count × 50)       [up to 4 files]
        + min(150, symbols_accessed_files × 30)   [up to 5 files with symbols]
        + 20 tokens if bash_history has entries
        + 15 tokens if web_history has entries
        + 50 tokens if there are pending git changes (git diff --stat HEAD non-empty)
        + 10 tokens if there are uncommitted changes (git diff/status non-empty)
        + min(60, round(stale_compact_fraction × 60)) if skills have stale/missing compacts
        × activity multiplier: age-based tier, with density downgrade for idle sessions
            age tiers: young(<10min)=0.6  active(10-60min)=1.0  mature(>60min)=1.4
            density downgrade: if age>=10min and edits/min<0.3 → cap multiplier at 1.0
        Capped to [200, 800], then further capped by context pressure:
            critical → max 300 (force aggressive compaction)
            hot      → max 500

    *age_seconds* is the session age in seconds.  When omitted (or 0) the session
    is treated as young.  Pass ``time.time() - cache.created_ts`` at call sites
    that have the cache in hand.

    *has_pending_diff* should be ``True`` when ``_get_git_diff_stat_summary()``
    returned a non-empty string for this session's working directory.  Adds 50
    tokens to account for the "Pending Changes" section in the manifest.

    *has_uncommitted_changes* should be ``True`` when ``_get_uncommitted_changes()``
    returned a non-empty string.  Adds 10 tokens to account for the
    "Uncommitted Changes" section in the manifest.

    *stale_compact_fraction* is the fraction of loaded skills whose compact is
    missing or has a SHA mismatch (0.0 = all fresh, 1.0 = all stale/missing).
    When skills cannot contribute their compacts to the manifest, the manifest
    needs more room to compensate with other context.  Up to 60 bonus tokens are
    added, scaling linearly with the fraction.  Use
    :func:`_compute_stale_compact_fraction` to compute this from the session cache.

    *context_pressure* when provided, caps the budget at lower values when the
    context window is heavily loaded.  A detailed 800-token manifest at critical
    fill tells the compaction LLM to preserve more, worsening the stuck-compact
    loop.  A minimal manifest at critical fill forces aggressive compaction.

    Returns a value guaranteed to be in the range [200, 800].
    """
    base = 200
    max_total = 800
    min_total = 200

    # Edited files bonus: 50 tokens per file, capped at 200
    edited_count = len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0
    edited_bonus = min(200, edited_count * 50)

    # Symbols accessed files bonus: 30 tokens per file, capped at 150
    symbols_files = sum(1 for e in cache.files.values() if e.symbols_read)
    symbols_bonus = min(150, symbols_files * 30)

    # Bash history bonus: 20 tokens if there are any entries
    bash_bonus = 20 if (getattr(cache, "bash_history", None) and cache.bash_history) else 0

    # Web history bonus: 15 tokens if there are any cached web fetches
    web_bonus = 15 if (getattr(cache, "web_history", None) and cache.web_history) else 0

    # Pending diff bonus: 50 tokens when there are uncommitted changes to show
    diff_bonus = 50 if has_pending_diff else 0

    # Uncommitted changes bonus: 10 tokens for the "Uncommitted Changes" section
    uncommitted_bonus = 10 if has_uncommitted_changes else 0

    # Stale compact bonus: sessions where skills lack fresh compacts need more
    # manifest room to preserve skill context via other means (e.g. last-seen
    # sections, bash history, edited files).  Scale 0→60 tokens linearly.
    _safe_frac = max(0.0, min(1.0, stale_compact_fraction))
    stale_bonus = min(60, round(_safe_frac * 60))

    raw_total = (
        base
        + edited_bonus
        + symbols_bonus
        + bash_bonus
        + web_bonus
        + diff_bonus
        + uncommitted_bonus
        + stale_bonus
    )

    # Apply activity multiplier: combines age tier and edit-density so a long
    # idle session doesn't inflate the budget the same way a busy session does.
    factor = _compute_activity_multiplier(age_seconds, edited_count)
    total = int(round(raw_total * factor))

    # Context-pressure cap: shrink the manifest at high fill so the compaction LLM compresses aggressively rather than preserving everything (large manifest at high fill worsens the stuck-compact loop where repeated compactions never reduce context below ~80%).
    if context_pressure is not None:
        if context_pressure.tier == "critical":
            max_total = min(max_total, 300)
        elif context_pressure.tier == "hot":
            max_total = min(max_total, 500)

    return max(min_total, min(max_total, total))


def _compute_budget_multiplier(
    cache: SessionCache,  # type: ignore[name-defined]  # SessionCache imported under TYPE_CHECKING; annotation is safe at runtime with 'from __future__ import annotations'
    base_multiplier: float,
) -> float:
    """Return an adaptive multiplier for the manifest token budget.

    Escalates automatically when the session is complex enough to warrant a
    larger manifest without operator intervention.  Two triggers:

    - **Large edit surface**: > 10 edited files → the agent touched many files
      and the manifest must list more of them to be useful post-compact.
    - **Many test failures**: > 5 distinct failing tests in recent bash history →
      a failing test suite is the highest-value context to preserve.

    When either trigger fires the returned multiplier is ``max(base, 2.5)``,
    which exceeds the default ``auto_trigger_multiplier`` of 2.0.  When neither
    fires the base multiplier is returned unchanged.

    Args:
        cache: Loaded :class:`session.SessionCache` for the current session.
        base_multiplier: The configured ``auto_trigger_multiplier`` (e.g. 2.0).

    Returns:
        A float ≥ *base_multiplier*.
    """
    _EDITED_FILES_THRESHOLD: int = 10
    _TEST_FAILURES_THRESHOLD: int = 5
    _ESCALATED_MULTIPLIER: float = 2.5

    edited_count = len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0
    if edited_count > _EDITED_FILES_THRESHOLD:
        return max(base_multiplier, _ESCALATED_MULTIPLIER)

    bash_hist = getattr(cache, "bash_history", None) or {}
    failure_names = _extract_test_failures(bash_hist)
    if len(failure_names) > _TEST_FAILURES_THRESHOLD:
        return max(base_multiplier, _ESCALATED_MULTIPLIER)

    return base_multiplier


def build_manifest_adaptive(session_id: str) -> str:
    """Load session cache and build manifest with adaptively-computed token budget.

    Convenience wrapper that loads the cache once and calls build_manifest with
    a budget computed from session complexity via :func:`compute_adaptive_budget`.

    Returns empty string when the session cache is missing or unreadable.
    """
    _LOG.debug("build_manifest_adaptive: session=%s", session_id[:8])
    cache = _load_session_cache(session_id, "build_manifest_adaptive")
    if cache is None:
        return ""
    created_ts = getattr(cache, "created_ts", None)
    age_seconds = max(0.0, time.time() - created_ts) if created_ts is not None else 0.0
    cwd = getattr(cache, "cwd", None)
    pending_diff = _get_git_diff_stat_summary(cwd)
    uncommitted = _get_uncommitted_changes(cwd)
    # Compute the stale compact fraction for skills loaded in this session.
    # When many skills lack fresh compacts, the manifest needs more room to
    # preserve skill context via other sections (bash history, edited files, etc).
    skill_history = getattr(cache, "skill_history", None) or {}
    stale_frac = _compute_stale_compact_fraction(session_id, skill_history)
    pressure = get_context_pressure(session_id, cache=cache)
    budget = compute_adaptive_budget(
        cache,
        age_seconds=age_seconds,
        has_pending_diff=bool(pending_diff),
        has_uncommitted_changes=bool(uncommitted),
        stale_compact_fraction=stale_frac,
        context_pressure=pressure,
    )
    # Activity-floor suppression: if the session has too little activity, skip
    # the full manifest.  A score below _ACTIVITY_FLOOR means essentially
    # "session started but nothing worth preserving happened" — a single file
    # read with no edits or commands is not worth injecting into the compaction.
    activity_score = _session_activity_score(cache)
    if activity_score < _ACTIVITY_FLOOR:
        _LOG.info(
            "build_manifest_adaptive: session=%s suppressed (activity_score=%d < floor=%d)",
            session_id[:8],
            activity_score,
            _ACTIVITY_FLOOR,
        )
        return ""

    _LOG.debug(
        "build_manifest_adaptive: session=%s budget=%d tier=%s pressure=%s (edited=%d symbols=%d bash=%s web=%s diff=%s uncommitted=%s stale_frac=%.2f activity=%d)",
        session_id[:8],
        budget,
        _session_age_tier(age_seconds),
        pressure.tier,
        len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0,
        sum(1 for e in cache.files.values() if e.symbols_read),
        bool(getattr(cache, "bash_history", None) and cache.bash_history),
        bool(getattr(cache, "web_history", None) and cache.web_history),
        bool(pending_diff),
        bool(uncommitted),
        stale_frac,
        activity_score,
    )
    cfg = _load_config()
    return _build_manifest_from_cache(cache, session_id, budget, **_compact_render_kwargs(cfg))


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
        + len(getattr(cache, "skill_history", {}) or {})
    )


def _compact_render_kwargs(cfg: _Config) -> dict[str, Any]:
    """Unpack the render-tuning fields from *cfg* into a kwargs dict.

    Used by the three public ``build_manifest*`` entry points so the field
    list lives in exactly one place.

    ``lazy_skill_injection`` is derived from two sources:

    * ``[skill_preservation] inline_snippets`` (the user-facing knob added in
      iteration 9): ``True`` (default) means "inline snippets eagerly", which
      maps to ``lazy_skill_injection=False``.  Set to ``False`` to revert to
      recall-command-only behaviour (``lazy_skill_injection=True``).
    * ``[compact_assist] lazy_skill_injection``: the legacy low-level override
      for advanced users.  When ``[skill_preservation] inline_snippets`` is
      ``True`` (the default), this legacy key is effectively overridden because
      the skill-preservation setting takes precedence.  The legacy key only has
      independent effect when ``inline_snippets=False``.
    """
    ca = cfg.compact_assist
    sp = cfg.skill_preservation
    # inline_snippets=True (default) → eager snippet injection → lazy_skill_injection=False.
    # inline_snippets=False → recall-command-only → fall back to the compact_assist
    # setting (lazy_skill_injection defaults to True).
    lazy = False if sp.inline_snippets else ca.lazy_skill_injection
    return {
        "edited_dir_group_threshold": ca.edited_dir_group_threshold,
        "max_section_lines": ca.max_section_lines,
        "noise_floor_tokens": ca.noise_floor_tokens,
        "wide_session_threshold": ca.wide_session_threshold,
        "orchestrator_commit_threshold": ca.orchestrator_commit_threshold,
        "lazy_skill_injection": lazy,
        "harness": detect_harness(ca.harness),
    }


def _build_manifest_from_cache(
    cache: SessionCache,
    session_id: str,
    max_tokens: int,
    edited_dir_group_threshold: int = 3,
    max_section_lines: int = 0,
    noise_floor_tokens: int = 0,
    wide_session_threshold: int = 15,
    orchestrator_commit_threshold: int = 5,
    lazy_skill_injection: bool = True,
    harness: str = "claudecode",
) -> str:
    """Render the manifest from an already-loaded *cache*.

    Separated from :func:`build_manifest` so :func:`build_manifest_with_count`
    can share the render + log path without a second disk load.

    Wall-clock timeout: if manifest construction exceeds _MANIFEST_TIMEOUT_SECS,
    returns what has been assembled so far with a note appended.
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
    start = time.monotonic()
    result, files_with_symbols_count = _render(
        cache,
        session_id,
        max_tokens,
        edited_dir_group_threshold=edited_dir_group_threshold,
        max_section_lines=max_section_lines,
        noise_floor_tokens=noise_floor_tokens,
        wide_session_threshold=wide_session_threshold,
        orchestrator_commit_threshold=orchestrator_commit_threshold,
        lazy_skill_injection=lazy_skill_injection,
        harness=harness,
    )
    elapsed = time.monotonic() - start

    # Check if we exceeded the wall-clock timeout
    if elapsed > _MANIFEST_TIMEOUT_SECS:
        result += f"\n\n⚠ manifest build timed out after {elapsed:.2f}s — output may be incomplete"
        _LOG.warning(
            "build_manifest: timeout exceeded for session=%s (%.2fs > %.2fs)",
            session_id[:8],
            elapsed,
            _MANIFEST_TIMEOUT_SECS,
        )
    elif elapsed > _MANIFEST_TIMEOUT_SECS * 0.8:
        # Item #30: graduated warning — when render time crosses 80 % of the
        # hard timeout, emit a footer signal so operators see slow-render
        # sessions before they tip over into truncation.  Plain text, single
        # line, ~10 tokens cost; the compaction LLM ignores it but downstream
        # tooling and humans can grep for "(rendered in" to spot trouble.
        result += f"\n\n(rendered in {int(elapsed * 1000)}ms)"
        _LOG.info(
            "build_manifest: slow-render warning for session=%s (%.2fs > 80%% of %.2fs)",
            session_id[:8],
            elapsed,
            _MANIFEST_TIMEOUT_SECS,
        )

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

    # Manifest quality check: score the rendered output and log a DEBUG note
    # when the manifest is thin (low signal) so operators can tune thresholds.
    # Pass the full manifest as a single section — _score_manifest scans all lines.
    if result:
        _quality_score = _score_manifest([result])
        if _quality_score == 0:
            _LOG.debug(
                "build_manifest: quality score=0 (noop manifest) session=%s — "
                "consider tightening min_events gate",
                session_id[:8],
            )
        elif _quality_score < _MANIFEST_THIN_THRESHOLD:
            _LOG.debug(
                "build_manifest: thin manifest quality score=%d (<%d) session=%s — "
                "manifest may not preserve enough context",
                _quality_score, _MANIFEST_THIN_THRESHOLD, session_id[:8],
            )

    return result


# ---------------------------------------------------------------------------
# Hard character-budget enforcement (applied after full manifest render)
# ---------------------------------------------------------------------------

def _enforce_char_budget(manifest: str, max_chars: int) -> str:
    """Truncate *manifest* to *max_chars* characters with section-aware priority.

    Called by :func:`build_manifest` when ``config.compact_assist.max_manifest_chars``
    is set and the rendered manifest exceeds the limit.  Truncation preserves the
    highest-value content first:

    1. The version header + edited files section (always kept — these are the
       most critical must-preserve items).  If even the header + edited section
       exceeds the budget, the result is line-truncated from the bottom.
    2. The symbols section (kept if it fits; truncated to first N lines otherwise).
    3. The skills section (kept if it fits; truncated to first N lines otherwise).
    4. All remaining sections (dropped or line-truncated to fit the budget).

    Appends "... (manifest truncated at budget limit)" as the final line so
    downstream parsers can detect that truncation occurred.

    Returns the original manifest unchanged when ``max_chars <= 0`` (disabled)
    or when ``len(manifest) <= max_chars`` (already within budget).
    """
    if max_chars <= 0 or len(manifest) <= max_chars:
        return manifest

    _TRUNCATION_SUFFIX = "\n... (manifest truncated at budget limit)"
    # Reserve space for the truncation suffix itself.
    suffix_len = len(_TRUNCATION_SUFFIX)
    available = max_chars - suffix_len
    if available <= 0:
        # Budget too small to fit anything — return just the suffix.
        return _TRUNCATION_SUFFIX.lstrip()

    lines = manifest.splitlines(keepends=False)

    # Classify each line into a named segment group.
    # Segment names: "header", "edited", "symbols", "skills", "other"
    def _classify(line: str) -> str:
        if line.startswith(("**Staged/Uncommitted:**", "**Edited:**", "**Files:**", "**Committed This Session:**")):
            return "edited"
        if line.startswith("**Symbols Accessed:**"):
            return "symbols"
        if line.startswith("**Skills:**"):
            return "skills"
        return None  # type: ignore[return-value]  # None means "keep current segment"

    # Build segments as (name, [line_indices]) preserving document order.
    segments: list[tuple[str, list[int]]] = []
    current_seg_name = "header"
    current_seg_indices: list[int] = []

    for idx, line in enumerate(lines):
        new_seg = _classify(line)
        if new_seg is not None and new_seg != current_seg_name:
            # Start of a new named segment — flush the current one.
            if current_seg_indices:
                segments.append((current_seg_name, current_seg_indices))
            current_seg_name = new_seg
            current_seg_indices = [idx]
        else:
            current_seg_indices.append(idx)

    if current_seg_indices:
        segments.append((current_seg_name, current_seg_indices))

    # Assemble the output greedily in priority order.
    # Use a list of line indices to avoid repeated string joins; assemble once at end.
    _PRIORITY_ORDER = ["header", "edited", "symbols", "skills"]

    kept_indices: list[int] = []

    def _current_result_len() -> int:
        """Compute exact length of the joined kept lines (N lines joined by N-1 newlines)."""
        if not kept_indices:
            return 0
        return sum(len(lines[i]) for i in kept_indices) + max(0, len(kept_indices) - 1)

    def _add_line_fits(line_idx: int) -> bool:
        """Return True and add line_idx to kept_indices if it fits in available budget."""
        # First line: no preceding newline. Each subsequent line adds one "\n" separator.
        separator_cost = 1 if kept_indices else 0
        line_cost = len(lines[line_idx]) + separator_cost
        current_len = _current_result_len()
        if current_len + line_cost <= available:
            kept_indices.append(line_idx)
            return True
        return False

    # Pass 1: header + edited — always keep, line-by-line until budget exhausted.
    for seg_name, seg_idxs in segments:
        if seg_name in ("header", "edited"):
            for idx in seg_idxs:
                _add_line_fits(idx)

    # Pass 2: symbols and skills — add line-by-line while budget allows.
    for seg_name in ("symbols", "skills"):
        for s_name, s_idxs in segments:
            if s_name == seg_name:
                for idx in s_idxs:
                    if not _add_line_fits(idx):
                        break  # budget exhausted for this segment

    # Pass 3: remaining segments — add whole segments if they fit.
    for seg_name, seg_idxs in segments:
        if seg_name in _PRIORITY_ORDER:
            continue
        for idx in seg_idxs:
            if not _add_line_fits(idx):
                break

    result_body = "\n".join(lines[i] for i in kept_indices).rstrip()
    result = result_body + _TRUNCATION_SUFFIX
    # Safety: final trim to max_chars if still over (shouldn't happen but guards against edge cases).
    if len(result) > max_chars:
        result = result[:max_chars - suffix_len].rstrip() + _TRUNCATION_SUFFIX
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

    # --- Manifest delta-cache (item #1, 2026-05-24 design) ---
    # Compute a cheap fingerprint from session inputs BEFORE rendering.  If the
    # sidecar exists, is fresh (< TTL), and the fingerprint matches, we can skip
    # the full _render and return a 1-line stub (~300-600 tokens saved per idle
    # multi-compaction session).  The fingerprint includes the last-bash exit_code
    # so a new red test result always busts the cache.
    now = time.time()
    fingerprint = _compute_manifest_fingerprint(cache)

    sidecar_data = _read_manifest_sidecar(session_id)
    prior_counts: dict[str, int] | None = None
    if (
        sidecar_data is not None
        and session_id not in _manifest_sha_written_this_process
    ):
        _cached_sha, cached_fp, cached_ts, prior_counts = sidecar_data
        sidecar_age = now - cached_ts
        # Cache-hit predicate requires 0 <= sidecar_age < TTL.  A negative age
        # means the sidecar's ``ts`` is in the future relative to the current
        # clock — clock skew, NTP step, a wall-clock rollback, or a manually
        # edited sentinel file.  Without the lower bound, ``-7_000_000_000s <
        # 600s`` would pass and pin the cache to a stub indefinitely.  A
        # cached_ts <= 0 means the sidecar was parsed from corrupted/legacy
        # data and should likewise force a full rebuild (the read helper
        # coerces ``data["ts"]`` to float, but a missing/zero stored ts would
        # arrive here as 0.0 if ever serialized by an older writer).
        if (
            cached_ts > 0.0
            and 0.0 <= sidecar_age < _MANIFEST_CACHE_TTL_SECS
            and cached_fp == fingerprint
        ):
            emit_time = datetime.fromtimestamp(cached_ts, tz=UTC).strftime("%H:%M")
            short_id = session_id[:8] if len(session_id) >= 8 else session_id
            _LOG.debug(
                "build_manifest: sidecar cache-hit session=%s fp=%s age=%.0fs — returning stub",
                session_id[:8], fingerprint, sidecar_age,
            )
            return (
                f"## Token-Goat Manifest — unchanged since {emit_time}. "
                f"Recall: `token-goat compact-hint --session-id {short_id}`."
            )
        # Log negative-age incidents so operators notice clock-skew problems.
        if sidecar_age < 0.0:
            _LOG.warning(
                "build_manifest: sidecar ts is in the future session=%s skew=%.0fs"
                " — ignoring cache, rebuilding manifest",
                session_id[:8], -sidecar_age,
            )
            # Drop the poisoned prior_counts: an out-of-band/future ts often
            # implies the sidecar is from a different machine or session swap,
            # so its counts would yield a misleading delta.
            prior_counts = None
        elif cached_ts <= 0.0:
            _LOG.warning(
                "build_manifest: sidecar ts is non-positive session=%s ts=%r"
                " — ignoring cache, rebuilding manifest",
                session_id[:8], cached_ts,
            )
            prior_counts = None
        elif sidecar_age >= _MANIFEST_CACHE_TTL_SECS:
            _LOG.debug(
                "build_manifest: sidecar cache expired session=%s age=%.0fs ttl=%.0fs"
                " — rebuilding manifest",
                session_id[:8], sidecar_age, _MANIFEST_CACHE_TTL_SECS,
            )
        elif cached_fp != fingerprint:
            _LOG.debug(
                "build_manifest: sidecar fingerprint mismatch session=%s"
                " — session changed, rebuilding manifest (stored=%s current=%s)",
                session_id[:8], cached_fp, fingerprint,
            )
    elif sidecar_data is not None:
        # Cache write happened earlier in this process — still surface prior_counts
        # for the delta line so the new manifest reflects the growth/shrink.
        _cached_sha, cached_fp, cached_ts, prior_counts = sidecar_data

    # Cache miss or TTL expired: render the full manifest.
    cfg = _load_config()
    # Reserve directive space iff we will actually append directives (see _DIRECTIVE_APPEND_MIN_TOKENS); otherwise the body gets the full budget instead of being starved for boilerplate that never attaches.
    _will_append_directives = max_tokens >= _DIRECTIVE_APPEND_MIN_TOKENS
    _reserve = _DIRECTIVE_TOKEN_RESERVE if _will_append_directives else 0
    body_budget = max(1, max_tokens - _reserve - _AS_OF_TOKEN_RESERVE)
    full_manifest = _build_manifest_from_cache(
        cache, session_id, body_budget, **_compact_render_kwargs(cfg)
    )
    if not full_manifest:
        return full_manifest

    # Item #26: prepend a one-line **Δ since last compact:** when the prior
    # sidecar carried a counts payload AND any section count changed.  First-time
    # compactions (prior_counts is None) skip the line — no "Δ: first compact"
    # noise.  The line is inserted as the very first content line of the manifest
    # so the compaction LLM sees what changed before reading anything else.
    current_counts = _compute_section_counts(cache)
    delta_line = _format_manifest_delta(prior_counts, current_counts)
    if delta_line:
        full_manifest = delta_line + "\n" + full_manifest

    # Hard char-budget enforcement: apply after delta prepend so the final
    # emitted length is bounded.  max_manifest_chars=0 disables the cap.
    _max_chars = cfg.compact_assist.max_manifest_chars
    if _max_chars > 0 and len(full_manifest) > _max_chars:
        _original_len = len(full_manifest)
        full_manifest = _enforce_char_budget(full_manifest, _max_chars)
        _final_len = len(full_manifest)
        _LOG.debug(
            "manifest truncated: %d chars → %d chars (budget: %d)",
            _original_len, _final_len, _max_chars,
        )

    # Persist the sidecar with the new SHA + fingerprint + counts so the next
    # PreCompact can skip rendering AND compute a delta against current counts.
    sha = _short_content_hash(full_manifest)
    _write_manifest_sidecar(session_id, sha, fingerprint, now, counts=current_counts)
    _manifest_sha_written_this_process.add(session_id)

    # Also update the session-JSON fields so legacy callers and stats remain consistent.
    from . import (
        session as session_mod,  # deferred — cold-start; __getattr__ handles external access
    )
    cache.last_manifest_sha = sha
    cache.last_manifest_ts = now
    cache._invalidate_json_cache()
    session_mod.save(cache)

    # Inject the static directive block BEFORE the first dynamic section so it forms a
    # stable prefix-cache target — static content at the front maximises the byte-identical
    # prefix that the LLM provider can cache across sessions.  The block is placed right
    # before the first bold-labelled section (**...) or pinned block (## Pinned) so the
    # manifest header (## Token-Goat Session Manifest + metadata) still appears first.
    # The text sidecar is written AFTER injection so compact-hint --diff sees the same
    # bytes as the emitted manifest.  Skip directives when the budget is too small.
    if _will_append_directives:
        _dir_block = _COMPACT_DIRECTIVES.lstrip("\n")
        _ins_pos = full_manifest.find("\n**")
        if _ins_pos == -1:
            _ins_pos = full_manifest.find("\n## Pinned")
        if _ins_pos != -1:
            full_manifest = full_manifest[:_ins_pos + 1] + _dir_block + "\n" + full_manifest[_ins_pos + 1:]
        else:
            full_manifest = _dir_block + "\n" + full_manifest

    # Append a stable as-of timestamp suffix so normalize_for_cache() can strip it and
    # produce byte-identical output for two manifests built from the same session content
    # at different wall-clock times.  The suffix never appears in the middle of the body.
    as_of_str = datetime.fromtimestamp(now, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    full_manifest = full_manifest.rstrip("\n") + f"\n# as-of: {as_of_str}"

    # Save the full manifest text so `compact-hint --diff` can produce a unified diff between the prior emit and the current one. Silently skip on any error — this is a developer-tooling sidecar, never a critical path.
    try:
        text_sidecar = paths.manifest_text_sidecar_path(session_id)
        paths.ensure_dir(text_sidecar.parent)
        paths.atomic_write_text(text_sidecar, full_manifest)
    except Exception:  # noqa: BLE001
        pass

    return full_manifest


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
    n_events = (
        len(cache.files)
        + len(cache.greps)
        + len(cache.edited_files)
        + len(getattr(cache, "bash_history", {}) or {})
        + len(getattr(cache, "skill_history", {}) or {})
    )
    # Delegate to build_manifest so the sidecar cache fast-path, delta-line,
    # and session write-back all apply.  The extra JSON deserialisation inside
    # build_manifest is negligible vs. the git subprocess calls in the cache-miss
    # path, and the sidecar hit path avoids those entirely.
    manifest = build_manifest(session_id, max_tokens=max_tokens)
    return manifest, n_events


def normalize_for_cache(manifest_text: str) -> str:
    """Strip the trailing ``# as-of: ...`` line so two manifests built at different
    wall-clock times from identical session content compare as byte-equal.

    The ``# as-of:`` line is appended by :func:`build_manifest` to record when the
    manifest was last rendered.  Stripping it yields a canonical form suitable for
    equality checks, caching, and regression tests that must not depend on the clock.
    Returns the input unchanged when no ``# as-of:`` suffix is present.
    """
    lines = manifest_text.rstrip("\n").splitlines()
    if lines and lines[-1].startswith("# as-of:"):
        lines = lines[:-1]
    return "\n".join(lines)


def write_session_manifest(project_hash: str, session_id: str, manifest_json: dict[str, Any]) -> None:
    """Write per-session manifest JSON for cross-session deduplication.

    Writes atomically to <data_dir>/projects/<project_hash>/sessions/<session_id>.json.
    Safe to call from concurrent processes — atomic rename prevents torn reads.
    """
    sessions_dir = paths.data_dir() / "projects" / project_hash / "sessions"
    paths.ensure_dir(sessions_dir)
    dest = sessions_dir / f"{session_id}.json"
    paths.atomic_write_text(dest, json.dumps(manifest_json))


def read_all_session_manifests(project_hash: str, max_age_seconds: int = 3600) -> list[dict[str, Any]]:
    """Read all session manifest JSON files for *project_hash*, skipping stale and corrupt entries.

    Files older than *max_age_seconds* (based on filesystem mtime) are excluded so
    abandoned sessions do not pollute the merged view.  Unreadable or corrupt JSON
    is silently skipped to remain robust against concurrent writes.
    """
    sessions_dir = paths.data_dir() / "projects" / project_hash / "sessions"
    if not sessions_dir.exists():
        return []
    now = time.time()
    results: list[dict[str, Any]] = []
    for p in sessions_dir.glob("*.json"):
        try:
            if now - p.stat().st_mtime > max_age_seconds:
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "files" in data:
                results.append(data)
        except Exception:  # noqa: BLE001
            pass
    return results


def merge_session_manifests(manifests: list[dict[str, Any]], budget_tokens: int) -> list[dict[str, Any]]:
    """Merge file entries from multiple sessions, deduplicating by rel_path.

    When the same path appears in multiple manifests, keeps the entry with the
    highest *hit_count* (read frequency).  Returns entries sorted by hit_count
    descending, capped so that total estimated tokens does not exceed *budget_tokens*
    (rough estimate: 10 characters of rel_path ≈ 1 token).
    """
    merged: dict[str, dict[str, Any]] = {}
    for manifest in manifests:
        for entry in manifest.get("files", []):
            rel = entry.get("rel_path", "")
            if not rel:
                continue
            existing = merged.get(rel)
            if existing is None or entry.get("hit_count", 0) > existing.get("hit_count", 0):
                merged[rel] = entry
    sorted_entries = sorted(merged.values(), key=lambda e: e.get("hit_count", 0), reverse=True)
    result: list[dict[str, Any]] = []
    total_tokens = 0
    for entry in sorted_entries:
        entry_tokens = max(1, len(entry.get("rel_path", "")) // 10)
        if total_tokens + entry_tokens > budget_tokens:
            break
        result.append(entry)
        total_tokens += entry_tokens
    return result


def _cap_line(line: str, max_len: int = 120) -> str:
    """Cap a line to max_len characters, truncating with '…' if exceeded.

    If the line is longer than *max_len*, returns ``line[:max_len-1] + "…"``.
    Otherwise returns *line* unchanged.  Header lines (starting with '###')
    are never capped — they are structural and must be preserved whole.

    Args:
        line: The line to cap.
        max_len: Maximum line length (default 120).

    Returns:
        The original line, or a truncated version with ellipsis.
    """
    return ellipsize(line, max_len)


def _load_task_list(session_id: str) -> list[dict[str, str]]:
    """Load TaskList entries for *session_id* from ``~/.claude/tasks/<session_id>/``.

    Claude Code persists each task as a separate JSON file named ``<id>.json``
    inside a per-session subdirectory.  We read every ``*.json`` file in that
    directory, parse the ``id``, ``subject``, and ``status`` fields, and return
    the raw list (unsorted, unfiltered — callers apply their own predicate).

    Returns an empty list on any error (missing directory, permission denied,
    malformed JSON) so callers never need to handle exceptions.
    """
    from . import paths as paths_mod  # noqa: PLC0415

    try:
        tasks_dir = paths_mod.safe_join(paths_mod.claude_config_dir() / "tasks", session_id)
    except ValueError:
        return []
    if not tasks_dir.is_dir():
        return []

    results: list[dict[str, str]] = []
    try:
        for p in tasks_dir.glob("*.json"):
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    continue
                task_id = str(data.get("id", p.stem))
                subject = str(data.get("subject", "")).strip()
                status = str(data.get("status", "")).strip().lower()
                if subject and status:
                    results.append({"id": task_id, "subject": subject, "status": status})
            except Exception:  # noqa: BLE001
                _LOG.debug("_load_task_list: skipping malformed task file %s", p)
    except Exception:  # noqa: BLE001
        _LOG.debug("_load_task_list: error reading tasks dir %s", tasks_dir)
    return results


def _find_open_questions(edited_file_paths: list[str], max_questions: int = 5) -> list[str]:
    """Extract TODO/FIXME/WHY/HACK/XXX comments from edited files.

    Reads each edited file (up to first 500 lines) and searches for lines containing
    common open-question markers in comments. Returns up to max_questions items
    formatted as "filename:line — TODO: description".

    Args:
        edited_file_paths: List of file paths to scan.
        max_questions: Maximum number of questions to return (default 5).

    Returns:
        List of formatted strings like "auth.py:42 — TODO: handle token refresh".
        Empty list on any error or if no questions found.
    """
    if not edited_file_paths:
        return []

    # Patterns pre-compiled at module level as _OPEN_QUESTION_MARKER_RE
    # and _OPEN_QUESTION_INLINE_RE.

    questions: list[tuple[str, int, str]] = []  # (filepath, line_num, description)

    for filepath in edited_file_paths:
        try:
            path = Path(filepath)

            # Skip non-existent, binary, and very large files
            if not path.exists():
                continue
            try:
                size = path.stat().st_size
                if size > 500_000:  # 500 KB
                    continue
            except OSError:
                continue

            # Try to read as text
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                continue

            # Scan first 500 lines for markers
            lines = text.splitlines()[:500]
            for line_num, line in enumerate(lines, start=1):
                # Skip pure comment lines without useful content
                if line.strip().startswith("#") and len(line.strip()) < 5:
                    continue

                # Check for TODO/FIXME/WHY/HACK/XXX markers
                m = _OPEN_QUESTION_MARKER_RE.search(line)
                if m:
                    marker, description = m.groups()
                    description = description.strip()
                    # If no description after marker, use marker itself
                    if not description:
                        description = marker
                    # Truncate to 80 chars
                    description = description[:80]
                    rel_path = path.name  # basename only
                    # Format with marker included
                    formatted = f"{marker}: {description}" if description and description != marker else marker
                    questions.append((rel_path, line_num, formatted))
                    continue

                # Check for inline ? in comments (e.g., "# should this be here?")
                if _OPEN_QUESTION_INLINE_RE.search(line) and "#" in line:
                    # Extract just the comment part
                    comment_start = line.index("#")
                    comment = line[comment_start:].strip()[:80]
                    rel_path = path.name
                    questions.append((rel_path, line_num, comment))

        except Exception:  # noqa: BLE001
            # Fail-soft: skip any file that causes issues
            continue

    # Deduplicate by (filepath, line_num) and cap at max_questions
    seen: set[tuple[str, int]] = set()
    deduped: list[tuple[str, int, str]] = []
    for filepath, line_num, desc in questions:
        key = (filepath, line_num)
        if key not in seen:
            seen.add(key)
            deduped.append((filepath, line_num, desc))
            if len(deduped) >= max_questions:
                break

    # Format as "filename:line — description"
    return [f"{fp}:{ln} — {desc}" for fp, ln, desc in deduped]


def _render_tasks_section(
    tasks: list[dict[str, str]],
    *,
    edited_paths: set[str] | None = None,
) -> list[str]:
    """Render a ``### TODOs`` manifest section from a raw task list.

    Filters to ``pending`` and ``in_progress`` (``in-progress``) tasks, caps at
    :data:`_MAX_TODO_ENTRIES`, truncates subjects to :data:`_MAX_TODO_SUBJECT_CHARS`
    chars, and returns an empty list when no qualifying tasks remain.

    The status prefix uses ``[ ]`` for pending and ``[→]`` for in-progress so
    the compaction LLM can distinguish work not yet started from work underway.

    Item #29: when *edited_paths* is provided, tasks whose subject contains the
    basename or trailing path component of any edited file are suppressed —
    those files are already pinned in the Edited section, so the TODO line
    duplicates context that the compaction LLM already has.  Path matching is
    case-insensitive against both basename and the last two path segments to
    catch common phrasings like "update auth.py" and "fix src/auth.py".
    """
    active_statuses = {"pending", "in_progress", "in-progress"}
    active = [t for t in tasks if t.get("status", "") in active_statuses]
    if not active:
        return []

    # Item #29: build a deduped set of edited-file basenames + last-two-segments
    # so a substring match against the task subject is fast and predictable.
    _suppress_tokens: set[str] = set()
    if edited_paths:
        for p in edited_paths:
            norm = _norm_key(p)
            basename = Path(norm).name
            if basename:
                _suppress_tokens.add(basename)
            # Last two path segments (e.g. "src/auth.py") catch
            # "src/auth.py is broken"-style subjects without matching too broadly.
            parts = norm.strip("/").split("/")
            if len(parts) >= 2:
                _suppress_tokens.add("/".join(parts[-2:]))

    def _is_about_edited_file(subject: str) -> bool:
        if not _suppress_tokens:
            return False
        s = subject.lower()
        return any(tok in s for tok in _suppress_tokens)

    filtered_active = [t for t in active if not _is_about_edited_file(t["subject"])]
    if not filtered_active:
        return []

    lines: list[str] = ["**TODOs:**"]
    shown = filtered_active[:_MAX_TODO_ENTRIES]
    for t in shown:
        subject = t["subject"]
        subject = ellipsize(subject, _MAX_TODO_SUBJECT_CHARS)
        status = t.get("status", "pending")
        marker = "[→]" if status in ("in_progress", "in-progress") else "[ ]"
        lines.append(f"- {marker} {subject}")

    overflow = len(filtered_active) - len(shown)
    if overflow > 0:
        lines.append(f"- …+{overflow} more")

    return lines


def _apply_section_line_cap(lines: list[str], cap: int) -> list[str]:
    """Truncate a section's bullet list to at most *cap* items, appending a "+N more" tail.

    When cap <= 0 (disabled) or cap >= len(lines), returns *lines* unchanged.
    Otherwise, returns a new list with the first *cap* items plus a final
    "(+N more)" line indicating the number of truncated entries.

    This prevents a single bloated section (e.g. 80 edited files) from dominating
    the manifest budget at the expense of other sections. Apply this AFTER
    directory-grouping so grouped lines count as 1 item each.

    Args:
        lines: List of manifest lines, typically header + bullet items.
               Expected format: ["### Header", "- item1", "- item2", ...].
        cap: Maximum number of items (lines after the header) to keep.
             Values <= 0 disable the cap and return *lines* unchanged.

    Returns:
        Either *lines* unchanged (if cap is disabled or >= len(lines)),
        or a new list with the header + first *cap* items + a "+N more" tail.
    """
    if cap <= 0 or not lines:
        return lines

    # The first line is the header; count items after it.
    if len(lines) <= 1:
        return lines

    # Skip the header (line 0) when counting items.
    item_count = len(lines) - 1
    if item_count <= cap:
        return lines

    # Truncate: keep header + first cap items, then add "+N more" tail.
    kept_lines = lines[:cap + 1]  # header + cap items
    overflow = item_count - cap
    kept_lines.append(f"- ... (+{overflow} more)")
    return kept_lines


_E = TypeVar("_E")  # Entry type for _render_section — ties list element to formatter argument


def _render_section(
    header: str,
    entries: list[_E],
    fmt: Callable[[_E], str],
) -> list[str]:
    """Render a manifest section as a list of lines.

    Returns an empty list when *entries* is empty (so the caller can safely
    concatenate with ``+`` without adding a blank section).  Lines produced by
    *fmt* that are themselves empty strings are silently skipped.

    This covers the common section shape::

        ### Header
        - line_1
        - line_2

    Content lines are capped at 120 characters to guarantee predictable token
    use; header lines are never capped.

    Sections with token-budget loops, sub-sections, or non-trivial formatting
    keep their own inline implementation in :func:`_render`.
    """
    if not entries:
        return []
    # Bold-label headers (starting with "**") are already fully formed; plain
    # header strings get the markdown H3 prefix so legacy callers are unaffected.
    hdr_line = header if header.startswith("**") else f"### {header}"
    lines: list[str] = [hdr_line]
    for entry in entries:
        line = fmt(entry)
        if line:
            lines.append(_cap_line(line))
    return lines


# Item #28: threshold for the **Slow:** bash group.  A successfully-exited
# command that took longer than this many seconds is surfaced separately so
# the compaction LLM (and post-compact agent) can see "this passes but is
# expensive" candidates worth speeding up.
_SLOW_BASH_THRESHOLD_SECS: Final[float] = 5.0


def _classify_bash_entry(entry: object) -> str:
    """Return one of ``"failed"``, ``"slow"``, or ``"ok"`` for grouped emission.

    - ``failed``: exit_code is not None and not zero.
    - ``slow``:   exit_code == 0 AND wall time > _SLOW_BASH_THRESHOLD_SECS.
    - ``ok``:     everything else (including exit_code is None — unknown class
                   defaults to ok rather than failed to avoid scary false alarms).

    Wall-time is read defensively via ``getattr(entry, "elapsed_ms", 0)`` then
    ``elapsed_s`` so the function works with both the in-memory ``BashEntry``
    dataclass (which may grow either field in future) and the test fixtures
    that only set a subset of attributes.
    """
    exit_code = getattr(entry, "exit_code", None)
    if exit_code is not None and exit_code != 0:
        return "failed"
    elapsed_ms = getattr(entry, "elapsed_ms", None)
    if elapsed_ms is None:
        elapsed_s = float(getattr(entry, "elapsed_s", 0.0) or 0.0)
    else:
        try:
            elapsed_s = float(elapsed_ms) / 1000.0
        except (TypeError, ValueError):
            elapsed_s = 0.0
    if exit_code == 0 and elapsed_s > _SLOW_BASH_THRESHOLD_SECS:
        return "slow"
    return "ok"


def _render_bash_grouped(
    bash_entries: list[object],
    budget: int,
    should_inline: Callable[[object], bool],
) -> tuple[list[str], int]:
    """Item #28: emit bash entries grouped by exit-code class.

    Produces::

        **Recent Commands:**
        **Failed:**
        - $ pytest tests/  (e=1, ...)
        **Slow:**
        - $ pip install ...  (e=0, ...)
        **Ok:**
        - $ ls (e=0, ...)

    Within each group the existing entry order (recency-then-size, as built
    by :func:`_select_top_bash_entries`) is preserved.  Empty groups omit
    their sub-header.  When every retained entry is in a single group AND
    that group is ``ok``, the sub-header is omitted entirely (**Recent Commands:**
    alone is sufficient context — saves ~3 tokens on the common all-passing case).
    Token budget is honoured greedily in group-priority order (failed first).
    """
    if not bash_entries:
        return [], 0

    # Partition while preserving original order within each bucket.
    by_class: dict[str, list[object]] = {"failed": [], "slow": [], "ok": []}
    for be in bash_entries:
        by_class[_classify_bash_entry(be)].append(be)

    header = "**Recent Commands:**"
    header_cost = _token_count(header)
    out: list[str] = [header]
    used = header_cost

    # Item #28 micro-opt: skip the **Ok:** sub-header on the common case where
    # every entry passes — the **Recent Commands:** label is enough context and we save
    # ~3 tokens per all-green manifest.
    only_ok = (
        not by_class["failed"] and not by_class["slow"] and bool(by_class["ok"])
    )

    # Emit groups in priority order so a tight budget still surfaces failures.
    _ORDER: tuple[tuple[str, str | None], ...] = (
        ("failed", "**Failed:**"),
        ("slow", "**Slow:**"),
        ("ok", None if only_ok else "**Ok:**"),
    )

    emitted_any = False
    for group_key, sub_header in _ORDER:
        group_entries = by_class[group_key]
        if not group_entries:
            continue
        # Reserve room for the sub-header before trying to fit content lines.
        sub_header_cost = _token_count(sub_header) if sub_header else 0
        if sub_header and used + sub_header_cost > budget:
            break  # Even the sub-header doesn't fit — stop here.

        group_lines: list[str] = []
        group_cost = 0
        for be in group_entries:
            line = _format_bash_entry(be, inline_snippet=should_inline(be))
            cost = _token_count(line)
            if used + sub_header_cost + group_cost + cost > budget:
                break
            group_lines.append(line)
            group_cost += cost

        if not group_lines:
            continue  # No content fits — don't emit a lone sub-header.

        if sub_header:
            out.append(sub_header)
            used += sub_header_cost
        out.extend(group_lines)
        used += group_cost
        emitted_any = True

    if not emitted_any:
        return [], 0
    return out, used


def _render_budget_lines(
    header: str,
    lines: list[str],
    budget: int,
    min_lines: int = 1,
) -> tuple[list[str], int]:
    """Emit header + as many pre-formatted lines as fit within *budget* tokens.

    Returns ``(output_lines, tokens_used)``; ``output_lines`` is empty when
    nothing fits.  Callers pre-format their entries so this helper owns only
    the header-gating and budget-loop logic, eliminating the repeated 15-line
    pattern across the symbols / bash / web / grep sections of :func:`_render`.

    *min_lines* (default 1): the minimum number of content lines required for
    the section to be emitted at all.  Sections like ``### Web Fetches`` and
    ``### Directory Scans`` with only one entry are rarely worth the header
    overhead; pass ``min_lines=2`` for those callers.
    """
    if not lines:
        return [], 0
    header_cost = _token_count(header)
    out: list[str] = []
    used = 0
    for line in lines:
        cost = _token_count(line)
        if used + header_cost + cost <= budget:
            out.append(line)
            used += cost
        else:
            break
    if len(out) < min_lines:
        return [], 0
    return [header] + out, used + header_cost


def _build_sealed_block(
    edited_clean: dict[str, int],
    blocker_entries: list[object],
    raw_skills: dict,
    test_failure_names: list[str] | None = None,
    raw_bash: dict | None = None,
    *,
    session_started_ts: float = 0.0,
) -> list[str]:
    """Build the above-the-fold sealed block prepended before the main manifest body.

    Format::

        ### MUST_PRESERVE
        <<preserve>>
        🎯 RESUME: auth.py
        ✎ auth.py×3  db.py  session.py
        ⛔ pytest tests/  (exit 1)
        🧠 ralph  plugin:improve
        ❌ tests/test_auth.py::test_login
        🕐 uv run pytest  git diff  ruff check
        <</preserve>>

    The RESUME line tells the post-compact agent which single file to re-read
    first to recover state — the same anchor recovery that Ralph's
    ``RESUME_POINT`` protocol calls for after a compaction event.  Priority
    order: most-edited file > most-recent blocker's command > skipped.  This
    line is small (~14-25 chars) and sits inside the preserve markers
    so the compaction LLM is unlikely to summarise it away.

    Slot (d): up to 3 unique source files extracted from *test_failure_names*
    (the ``tests/...`` paths before the ``::`` separator).  These are the files
    the agent most likely needs to re-read after compaction to fix the failures.

    Slot (e): the last :data:`_MAX_SEALED_BASH_CMDS` bash command previews
    extracted from *raw_bash* (most-recent first).  Provides continuity of the
    command sequence even after compaction drops the full bash section.

    The block is omitted entirely (empty list) when all five content slots are
    empty.  Content is bounded at 80 tokens (≤ 320 characters).  The markdown
    header makes the block discoverable to structured queries while the XML-like
    inner markers provide fail-safe signal for the compaction LLM.
    """

    # Slot (a): ≤3 edited basenames with edit counts
    edit_slot = ""
    top_edited_basename = ""  # for the RESUME line below
    if edited_clean:
        # Sort by edit count descending, take top 3
        top_edits = sorted(edited_clean.items(), key=_BY_EDIT_COUNT, reverse=True)[:3]
        parts = []
        for path, count in top_edits:
            basename = sanitize_log_str(Path(path).name or path, max_len=40)
            parts.append(f"{basename}×{count}" if count > 1 else basename)
        edit_slot = "✎ " + "  ".join(parts)
        # First (most-edited) basename anchors the RESUME pointer.
        if top_edits:
            top_edited_basename = sanitize_log_str(
                Path(top_edits[0][0]).name or top_edits[0][0], max_len=40
            )

    # Slot (b): most-recent blocker (truncated to 80 chars).
    # When the cached output yields a usable error preview, prefer it over
    # the bare "(exit N)" tail — the preview carries WHY the command failed
    # (e.g. "AssertionError: …", "ModuleNotFoundError: …"), which lets a
    # post-compact agent skip re-running the command to diagnose.
    blocker_slot = ""
    blocker_cmd_word = ""  # first word of the failing cmd, fallback RESUME anchor
    if blocker_entries:
        most_recent = max(blocker_entries, key=lambda e: getattr(e, "ts", 0.0))
        cmd = sanitize_log_str(getattr(most_recent, "cmd_preview", ""), max_len=70)
        exit_code = getattr(most_recent, "exit_code", "?")
        # Compute remaining char budget for the rationale clause: the sealed
        # block hard-caps each slot at 80 chars, so subtract the cmd + "⛔ " +
        # " — " framing to know how much room is left for the preview text.
        framing = f"⛔ {cmd} — "
        room = max(0, 80 - len(framing))
        preview = _extract_blocker_error_preview(most_recent, max_chars=room) if room >= 12 else ""
        raw = f"⛔ {cmd} — {preview}" if preview else f"⛔ {cmd}  (exit {exit_code})"
        blocker_slot = raw[:80]
        # Strip leading flags / env vars to land on the actual binary, e.g.
        # "FOO=bar pytest tests/" → "pytest".  Falls back to the first token
        # when no obvious binary is present.
        for tok in cmd.split():
            if "=" not in tok and not tok.startswith("-"):
                blocker_cmd_word = sanitize_log_str(tok, max_len=30)
                break

    # Slot (c): ≤2 active skill names (all skills from the current session).
    # Use the same session-window filter as _select_top_skill_entries so that
    # skills loaded earlier in a long session are not silently dropped here
    # while remaining visible in the main manifest section.
    skill_slot = ""
    if raw_skills:
        _sealed_top = _select_top_skill_entries(
            raw_skills, session_started_ts=session_started_ts
        )
        top_skills = _sealed_top[:2]
        names = [sanitize_log_str(getattr(e, "skill_name", ""), max_len=40) for e in top_skills]
        names = [n for n in names if n]
        if names:
            skill_slot = "🧠 " + "  ".join(names)

    # Slot (d): up to 3 unique test-file paths extracted from test_failure_names.
    # These are the files the agent will most likely need to re-read/fix after
    # compaction — listing them in the sealed block guards against them being
    # elided even when the full ### Recent Test Failures section is dropped.
    fail_files_slot = ""
    if test_failure_names:
        # Extract the file path from each "tests/foo.py::TestClass::test_name" entry.
        _seen_fail_files: set[str] = set()
        _fail_file_names: list[str] = []
        for _fn in test_failure_names:
            _parts = _fn.split("::")
            if _parts:
                _fpath = Path(_parts[0]).name
                if _fpath and _fpath not in _seen_fail_files:
                    _seen_fail_files.add(_fpath)
                    _fail_file_names.append(sanitize_log_str(_fpath, max_len=40))
                    if len(_fail_file_names) >= 3:
                        break
        if _fail_file_names:
            fail_files_slot = "❌ " + "  ".join(_fail_file_names)

    # Slot (e): last _MAX_SEALED_BASH_CMDS bash command previews for continuity.
    # Gives the post-compact agent the immediate command context (what was just
    # run) without relying on the full bash section surviving compaction.
    bash_cmds_slot = ""
    if isinstance(raw_bash, dict) and raw_bash:
        # Pick the most-recent commands, excluding no-ops and blockers.
        _blocker_oids = {getattr(e, "output_id", None) for e in blocker_entries}
        _recent_bash = heapq.nlargest(
            _MAX_SEALED_BASH_CMDS,
            (
                e for e in raw_bash.values()
                if not _is_noop_bash_command(e)
                and getattr(e, "output_id", None) not in _blocker_oids
            ),
            key=lambda e: getattr(e, "ts", 0.0),
        )
        _bash_previews = [
            sanitize_log_str(getattr(e, "cmd_preview", ""), max_len=40)
            for e in _recent_bash
        ]
        _bash_previews = [p for p in _bash_previews if p]
        if _bash_previews:
            bash_cmds_slot = "🕐 " + "  ".join(_bash_previews)

    # Skip the entire block when all five content slots are empty.
    # The RESUME line is derived from those slots so an empty block stays empty.
    if not edit_slot and not blocker_slot and not skill_slot and not fail_files_slot and not bash_cmds_slot:
        return []

    # RESUME pointer — first inner line so post-compact attention lands on it first.
    # Prefer the most-edited file (ongoing work); fall back to the failing command
    # (the most recent thing the agent tried).  Skip silently when neither applies
    # (e.g. skills-only sealed block — the skill list already implies the anchor).
    resume_slot = ""
    if top_edited_basename:
        resume_slot = f"🎯 RESUME: {top_edited_basename}"
    elif blocker_cmd_word:
        resume_slot = f"🎯 RESUME: re-run {blocker_cmd_word}"

    inner = [s for s in (resume_slot, edit_slot, blocker_slot, skill_slot, fail_files_slot, bash_cmds_slot) if s]
    block = ["### MUST_PRESERVE", "<<preserve>>"] + inner + ["<</preserve>>"]

    # Enforce 80-token cap: if the block is too large, truncate inner content.
    # The RESUME line is the highest-priority anchor — keep it intact and trim
    # the other slots first.  Drop in priority order: bash_cmds (lowest) first,
    # then fail_files, then skill.
    block_text = "\n".join(block)
    if _token_count(block_text) > 80:
        # Preserve resume_slot verbatim; trim the rest to 60 chars each.
        trimmed_rest = [
            line[:60]
            for line in (edit_slot, blocker_slot, skill_slot, fail_files_slot, bash_cmds_slot)
            if line
        ]
        inner_trimmed = ([resume_slot] if resume_slot else []) + trimmed_rest
        block = ["### MUST_PRESERVE", "<<preserve>>"] + inner_trimmed + ["<</preserve>>"]
        # Drop lowest-signal slots until we fit, in order: bash_cmds → fail_files → skill.
        for _drop_slot in (bash_cmds_slot[:60] if bash_cmds_slot else "",
                           fail_files_slot[:60] if fail_files_slot else "",
                           skill_slot[:60] if skill_slot else ""):
            if _drop_slot and _drop_slot in inner_trimmed and _token_count("\n".join(block)) > 80:
                inner_trimmed.remove(_drop_slot)
                block = ["### MUST_PRESERVE", "<<preserve>>"] + inner_trimmed + ["<</preserve>>"]

    return block


def _apply_noise_floor(
    section_groups: list[tuple[str, list[str], bool]],
    noise_floor: int,
) -> list[tuple[str, list[str], bool]]:
    """Filter out small unprotected sections when their token count is below the noise floor.

    Args:
        section_groups: List of (name, lines, protected) tuples representing manifest sections.
        noise_floor: Minimum token count threshold. Sections with fewer tokens are dropped.
                     If 0, no filtering is applied.

    Returns:
        A new list with small unprotected sections removed. Protected sections (protected=True)
        are always kept. Only body subsections (not header/legend) can be dropped.
    """
    if noise_floor <= 0:
        return section_groups

    filtered: list[tuple[str, list[str], bool]] = []
    for name, lines, protected in section_groups:
        if protected:
            # Always keep protected sections
            filtered.append((name, lines, protected))
        else:
            # For unprotected sections, check token count
            if not lines:
                # Empty section — drop it
                continue
            section_text = "\n".join(lines)
            section_tokens = _token_count(section_text)
            if section_tokens >= noise_floor:
                # Keep it — above noise floor
                filtered.append((name, lines, protected))
            else:
                # Drop it — below noise floor
                _LOG.debug(
                    "_apply_noise_floor: dropped section=%s tokens=%d < floor=%d",
                    name, section_tokens, noise_floor,
                )
    return filtered


def _render_most_accessed_section(
    symbol_access_counts: dict[str, int],
    max_entries: int = 5,
) -> list[str]:
    """Render the "Most Accessed Symbols" section from session.symbol_access_counts.

    Args:
        symbol_access_counts: dict[str, int] mapping "{file}::{symbol}" → access count.
        max_entries: Maximum number of symbols to show (default 5).

    Returns:
        List of formatted lines, or empty list if no symbols meet the threshold.

    Format:
        ### Most Accessed
        - Session.refresh (session.py) — 7 reads
        - build_manifest (compact.py) — 5 reads
    """
    if not symbol_access_counts:
        return []

    # Filter symbols with count >= 2 (single reads aren't interesting)
    # Sort by count descending
    candidates = [
        (key, count) for key, count in symbol_access_counts.items()
        if count >= 2
    ]
    if not candidates:
        return []

    candidates.sort(key=itemgetter(1), reverse=True)
    top_symbols = candidates[:max_entries]

    lines: list[str] = ["### Most Accessed"]
    for key, count in top_symbols:
        # Parse "file::symbol" format
        if "::" in key:
            filepath, symbol = key.rsplit("::", 1)
            # Extract basename from filepath
            basename = Path(filepath).name
            symbol_safe = sanitize_log_str(symbol, max_len=60)
            lines.append(f"- {symbol_safe} ({basename}) — {count} reads")
        else:
            # Fallback: should not happen with well-formed keys
            key_safe = sanitize_log_str(key, max_len=80)
            lines.append(f"- {key_safe} — {count} reads")

    return lines


def _render(
    cache: SessionCache,
    session_id: str,
    max_tokens: int,
    edited_dir_group_threshold: int = 3,
    max_section_lines: int = 0,
    noise_floor_tokens: int = 0,
    wide_session_threshold: int = 15,
    orchestrator_commit_threshold: int = 5,
    lazy_skill_injection: bool = True,
    harness: str = "claudecode",
) -> tuple[str, int]:
    """Build the Markdown session manifest string from *cache* for the PreCompact hook.

    Priority order (inverted pyramid — most critical first so truncation hurts least):
    0. **Current Blockers** — failed bash commands from the last 60 min (up to 3).
       Omitted entirely when there are no recent failures.
    0b.**Uncommitted Changes** — ``git diff --stat HEAD`` + ``git status --short``,
       capped at 8 lines / 200 chars.  Provides a ground-truth view of what's on
       disk (including manual edits and untracked files) before the Claude-tracked
       sections.  Omitted when the working tree is clean or git is unavailable.
    1. **Edited files** — always listed after blockers; the compaction LLM must preserve these.
       This section is uncapped — every edited file is must-preserve.
    2. **Recent Commands** — cached command outputs from session; the current work context.
       Capped at 15 % of remaining budget.
    3. **Symbols Accessed** — files where specific symbols were read via ``token-goat read``,
       ranked by most-recent access first, capped at 40 % of remaining budget.
    4. **Web Fetches** — reference material (docs, API responses) loaded mid-session, capped at 10 %.
    5. **Patterns Searched** — recent grep/search patterns, capped at 15 % of remaining budget.
    6. **Key files read** — top files by ``read_count`` (most re-read first), capped at 30 %.
    6b.**TODOs** — pending/in-progress TaskList entries read from
       ``~/.claude/tasks/<session_id>/``.  No budget slice — the section is small
       (≤5 lines) and uses overall headroom.  Omitted when the task directory is
       absent or all tasks are completed.

    Budget allocation via :func:`_section_budgets`: the edited-files block is rendered
    first and its token cost is subtracted from the global budget before the remaining
    sections split the remainder proportionally.  Each section builder stops adding
    entries when its slice is exhausted.  No post-hoc bottom-trimming is needed.

    Each manifest line is prefixed with an activity marker so the compaction LLM
    can distinguish edited (``✎``) from read-only (``→``) files — edited files
    represent ongoing work and must always survive compaction, whereas a file
    read once for context can be safely summarised.

    Noise paths (``.pyc``, ``__pycache__/``, lockfiles, OS metadata, build dirs)
    are filtered out before any ranking so the budget is spent on entries the
    compaction LLM can actually use.  See :func:`is_noise_path` for the full
    deny-list.

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
    # Item #32: cache is_noise_path() results per render so each path is
    # classified at most once.  On wide sessions (200+ files) the previous
    # repeated calls (edited_clean, files_clean.rel_or_abs, files_clean.key)
    # ran 600+ regex/segment checks; routing through a local dict drops that
    # to one classification per unique path.
    _noise_cache: dict[str, bool] = {}

    def _is_noise(path: str) -> bool:
        cached = _noise_cache.get(path)
        if cached is None:
            cached = is_noise_path(path)
            _noise_cache[path] = cached
        return cached

    edited_clean: dict[str, int] = {
        path: count for path, count in raw_edited.items()
        if not _is_noise(path)
    }
    files_clean: dict[str, FileEntry] = {
        key: entry for key, entry in cache.files.items()
        if not _is_noise(entry.rel_or_abs) and not _is_noise(key)
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
    # edited_files covers writes; files covers reads; greps covers searches;
    # bash_history covers commands run.  All four empty → just a header → not worth injecting.
    raw_greps = getattr(cache, "greps", None) or []
    _raw_bash = getattr(cache, "bash_history", None)
    raw_bash: dict = _raw_bash if isinstance(_raw_bash, dict) else {}
    _raw_web = getattr(cache, "web_history", None)
    raw_web: dict = _raw_web if isinstance(_raw_web, dict) else {}
    _raw_skills = getattr(cache, "skill_history", None)
    raw_skills: dict = _raw_skills if isinstance(_raw_skills, dict) else {}
    _raw_decisions = getattr(cache, "decisions", None)
    raw_decisions_for_activity: list = _raw_decisions if isinstance(_raw_decisions, list) else []
    if (
        not edited_clean and not files_clean and not raw_greps
        and not raw_bash and not raw_web and not raw_skills
        and not raw_decisions_for_activity
    ):
        _LOG.info(
            "_render: manifest suppressed for session=%s "
            "(no activity tracked: edited=0 files_read=0 greps=0 bash=0 skills=0 decisions=0)",
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
    edited_keys = {_norm_key(p) for p in edited_clean}

    # Compute session age and tier once up-front — used in multiple sections below.
    _created_ts = getattr(cache, "created_ts", None)
    age_secs = max(0.0, time.time() - _created_ts) if _created_ts is not None else 0.0
    age_tier = _session_age_tier(age_secs)

    # Files where the agent has a cached read that predates a subsequent edit —
    # the snapshot in context may no longer match the file on disk.
    stale_read_files: list[str] = [
        entry.rel_or_abs
        for key, entry in files_clean.items()
        if getattr(entry, "last_edit_ts", 0.0) > entry.last_read_ts
        and _norm_key(key) not in edited_keys
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

    # Most-important files, capped at _MAX_FILES_READ, for the "Key Files Read" section.
    # Uses _importance_score() — a composite of read frequency, symbols accessed,
    # edit status, and recency — rather than read_count alone.  This surfaces files
    # the agent genuinely worked with (e.g. read once but accessed many symbols, or
    # read/edited recently) over files that were merely scanned many times.
    #
    # heapq.nlargest is O(n log k) instead of O(n log n) full sort — material when a
    # long session has hundreds of file entries but we only need the top 10.
    # The heap keeps only k items in memory, so this is also more memory-efficient
    # than sorting the full list when sessions accumulate many hundreds of file reads.
    # We exclude files that already appear in the Edited section: those are pinned
    # at higher priority and re-listing them duplicates manifest budget.
    now_for_scoring = time.time()
    total_files_read = len(files_clean)
    key_files_candidates = [
        entry for key, entry in files_clean.items()
        if _norm_key(key) not in edited_keys
    ]
    # Files that are also in edited_files (path key match) get an edit_bonus even
    # when they appear in key_files_candidates — this handles the case where a file
    # was both read and edited but its edit-section entry predates the re-read so it
    # wasn't deduplicated into edited_keys.  Normalized key lookup for robustness.
    edited_keys_set = edited_keys  # already a set of normalized lower/forward-slash keys
    # Mature sessions (> 60 min) get 2 extra key-file slots: more context has
    # accumulated and the compaction LLM benefits from a broader file picture.
    # Item #23: dynamically reduce max_files_read when there are many edited files —
    # the Files Edited section already covers those paths, so the Key Files Read
    # section has diminishing value and should yield budget to higher-signal sections.
    _n_edited = len(edited_clean)
    if _n_edited >= 10:
        _dynamic_max_files = 4
    elif _n_edited >= 5:
        _dynamic_max_files = 6
    else:
        _dynamic_max_files = _MAX_FILES_READ
    # The guaranteed-minimum floor must be respected even when dynamic_max_files
    # is reduced by a high edited-file count.  Without this, heapq.nlargest
    # returns fewer entries than the guarantee requires, leaving the guarantee
    # logic with nothing extra to add.
    max_key_files = max(
        _dynamic_max_files + (2 if age_tier == "mature" else 0),
        _TOP_FILES_GUARANTEED_MIN,
    )
    top_files = heapq.nlargest(
        max_key_files,
        key_files_candidates,
        key=lambda e: _importance_score(
            e,
            now_for_scoring,
            edit_bonus=15.0 if _norm_key(e.rel_or_abs) in edited_keys_set else 0.0,
        ),
    )
    _LOG.debug(
        "_render: selected top %d/%d files by importance_score (cap=%d); "
        "files_with_symbols=%d edited=%d noise_skipped=%d",
        len(top_files),
        total_files_read,
        _MAX_FILES_READ,
        files_with_symbols_count,
        len(edited_clean),
        noise_skipped,
    )

    # Get cwd early so it can be used for the branch line and diff/commits sections.
    cwd = getattr(cache, "cwd", None)
    created_ts = getattr(cache, "created_ts", 0.0)

    header_lines: list[str] = [
        "## Token-Goat Session Manifest",
        "manifest_version: 1",
    ]
    # Add the current git branch to orient the compaction LLM about which
    # feature branch or context is active.  Omitted gracefully on detached HEAD
    # or when the working directory is not a git repo.
    _branch = _get_current_branch(cwd) if cwd else None
    if _branch:
        header_lines.append(f"branch: {_branch}")

    _hint_telemetry = _format_hint_telemetry(cache)
    if _hint_telemetry:
        header_lines.append(_hint_telemetry)

    # ── Pinned symbols — always-top, zero-budget-impact ──────────────────────
    # Pinned symbols are added by the user via ``token-goat pinned add`` and
    # must survive compaction because they represent load-bearing anchor points
    # for the session (e.g. the class the agent is refactoring, the function
    # under test).  They are rendered at the top of the manifest, before all
    # other sections, so truncation never removes them.
    _raw_pinned = getattr(cache, "pinned_symbols", None)
    pinned_symbols_list: list[str] = list(_raw_pinned) if isinstance(_raw_pinned, list) else []
    pinned_lines: list[str] = []
    if pinned_symbols_list:
        pinned_lines.append("## Pinned")
        pinned_lines.extend(f"- {_ps}" for _ps in pinned_symbols_list)

    # Session stats: edited count, bash count, hints suppressed — 1 compact line.
    _session_stats = _format_session_stats(cache)
    if _session_stats:
        header_lines.append(_session_stats)

    # ── 0. Current Blockers — failed commands from the last 60 min ───────────
    # Built before everything else so it appears at the top of the manifest.
    # Young sessions are included here too — a failure is critical regardless of age.
    now_ts_for_blockers = time.time()
    blocker_entries = _select_failed_bash_entries(raw_bash, now_ts_for_blockers)
    blocker_lines = _render_section("**Blocked:**", blocker_entries, _format_blocker_entry)

    # ── 0a. Active Skills — load-bearing protocol content ───────────────────
    # Built early so it sits high in the inverted-pyramid order: a loaded skill
    # (Ralph, /improve, etc.) is multi-thousand-token prose that the compaction
    # LLM aggressively summarises, dropping load-bearing rules.  Listing every
    # loaded skill with a recall hint tells the compaction LLM "preserve these"
    # and gives the post-compact agent an exact command to re-fetch the body.
    #
    # Item #9 / A25 — always collapse to a single summary line.
    # Listing each skill on its own bullet with a per-skill recall hint wastes
    # 15–25 tokens per skill (6 skills × ~30t = 180t).  The agent already knows
    # the recall pattern from one example; the per-skill body is available via
    # the recovery hint that fires after compaction.  Use the summary format
    # unconditionally: one line, names + a single generic recall example.
    # ── 0a-bis. Decisions — opt-in agent decision log ───────────────────────
    # Built right next to skills because both carry load-bearing *intent* that
    # compaction otherwise drops.  The list is opt-in (the agent must call
    # ``token-goat decision "<text>"``) so the typical session has 0 entries
    # and the section is suppressed entirely.  When present, we surface the
    # most recent ``_MAX_DECISIONS`` items so the post-compact agent inherits
    # the *why* behind the work-in-progress, not just the *what*.
    raw_decisions = getattr(cache, "decisions", None)
    decision_entries = _select_top_decision_entries(raw_decisions)
    if decision_entries:
        decision_lines: list[str] = ["**Decisions:**"]
        decision_lines.extend(_format_decision_entry(_de) for _de in decision_entries)
        # Overflow note when older decisions exist beyond the surfaced slice.
        if isinstance(raw_decisions, list) and len(raw_decisions) > len(decision_entries):
            overflow_n = len(raw_decisions) - len(decision_entries)
            decision_lines.append(
                f"- …+{overflow_n} more — recall via `token-goat decision --list`"
            )
    else:
        decision_lines = []

    _session_started_ts = float(getattr(cache, "started_ts", 0.0) or 0.0)
    skill_entries = _select_top_skill_entries(
        raw_skills, session_started_ts=_session_started_ts
    )
    if skill_entries:
        # Build summary: "ralph ×3, improve ×1 — recall via token-goat skill-body <name>"
        _skill_parts = []
        for _se in skill_entries:
            _sname = sanitize_log_str(getattr(_se, "skill_name", ""), max_len=40)
            _src = int(getattr(_se, "run_count", 1))
            _skill_parts.append(f"{_sname} ×{_src}" if _src > 1 else _sname)
        # Overflow count: how many distinct skill names exist beyond the surfaced
        # cap.  Compare unique names in the full history (not total entries, which
        # can be > unique names when the same skill has multiple content_sha rows)
        # against the number of entries we are about to surface.
        _unique_skill_names = {
            getattr(e, "skill_name", "") for e in raw_skills.values()
            if getattr(e, "skill_name", "")
        }
        overflow_skills = max(0, len(_unique_skill_names) - len(skill_entries))
        if overflow_skills > 0:
            _skill_parts.append(f"+{overflow_skills} more")
        _skills_summary = ", ".join(_skill_parts)
        skill_lines = [
            f"**Skills:** {_skills_summary} — recall via `token-goat skill-body <name>`"
        ]

        from . import skill_cache  # noqa: PLC0415

        if lazy_skill_injection:
            # Lazy injection: list each skill as a one-line recall pointer.
            # The model fetches compacts on demand after compaction, paying the
            # token cost only for skills it actually needs.  A session with 5
            # skills × 200-token compacts saves ~1 000 tokens at manifest-build
            # time; the recall command is ~12 tokens per skill.
            for _se in skill_entries:
                _skill_name = sanitize_log_str(getattr(_se, "skill_name", ""), max_len=40)
                if not _skill_name:
                    continue
                # Estimate compact token count from cached text size (4 chars/token).
                # Fall back to cross-session lookup so a skill that was compacted in
                # a previous session still shows its token estimate rather than a bare
                # recall pointer with no size hint.
                _compact_text = skill_cache.get_compact(session_id, _skill_name)
                if not _compact_text:
                    _compact_text = skill_cache.get_compact_any_session(_skill_name)
                if _compact_text:
                    # Strip the compact header (e.g. "--- compact form (N tokens, sha=...) ---\n")
                    # before estimating tokens so the count reflects usable content only.
                    _bare_compact = skill_cache._strip_compact_header(_compact_text)  # type: ignore[attr-defined]
                    _tok_est = max(1, len(_bare_compact) // 4)
                    # Detect SHA staleness: the compact header embeds the first 12 hex chars
                    # of the body SHA at compact-generation time.  If the session's recorded
                    # content_sha has a different prefix, the skill was updated after the
                    # compact was written — annotate so the post-compact model knows to
                    # re-run `skill-compact` before relying on the recalled compact.
                    _entry_sha = getattr(_se, "content_sha", "") or ""
                    _compact_sha = skill_cache.extract_compact_source_sha(_compact_text)  # type: ignore[attr-defined]
                    _stale_ann = ""
                    if _compact_sha and _entry_sha and not _entry_sha.startswith(_compact_sha):
                        _stale_ann = " [stale]"
                    skill_lines.append(
                        f"- {_skill_name} ({_tok_est} tok{_stale_ann})"
                        f" → `token-goat skill-body {_skill_name} --compact`"
                    )
                else:
                    skill_lines.append(
                        f"- {_skill_name} → `token-goat skill-body {_skill_name} --compact`"
                    )
        else:
            # Eager injection: inline the full compact text for each skill.
            # Distribute the total inline token budget evenly across all skills
            # that have a cached compact.  This prevents sessions with many large
            # skills (ralph + improve + marketing + humanizer + …) from inflating
            # the skills section beyond the global manifest token budget.
            # Budget is in tokens; convert to chars at 3 chars/token (conservative).
            _skills_with_compact = [
                (getattr(_se, "skill_name", ""), skill_cache.get_compact(session_id, getattr(_se, "skill_name", "")))
                for _se in skill_entries
                if getattr(_se, "skill_name", "")
            ]
            _skills_with_compact = [(_name, _ct) for _name, _ct in _skills_with_compact if _ct]
            _n_with_compact = len(_skills_with_compact)
            if _n_with_compact > 0:
                # Per-skill char budget: evenly divide total budget; also respect the
                # absolute per-skill ceiling (_SKILL_COMPACT_INLINE_MAX_CHARS).
                _per_skill_chars = min(
                    _SKILL_COMPACT_INLINE_MAX_CHARS,
                    (_SKILL_INLINE_TOTAL_TOKEN_BUDGET * 3) // _n_with_compact,
                )
            else:
                _per_skill_chars = _SKILL_COMPACT_INLINE_MAX_CHARS

            for _skill_name, compact_text in _skills_with_compact:
                if not compact_text:
                    continue
                # Apply combined per-skill cap (budget-derived and absolute ceiling).
                if len(compact_text) > _per_skill_chars:
                    cut = compact_text.rfind("\n", 0, _per_skill_chars)
                    if cut <= 0:
                        cut = _per_skill_chars
                    compact_text = compact_text[:cut].rstrip() + "…"
                # Indent the compact as a continuation of the skills line
                skill_lines.append("")
                skill_lines.append(f"**{_skill_name} key-rules:**")
                skill_lines.extend(f"  {line}" for line in compact_text.splitlines())
                # Track that this compact was served: increments compact_served_count
                # in the SkillEntry so skill-list can report hit vs miss stats.
                try:
                    from . import session as _session_mod  # noqa: PLC0415
                    _session_mod.record_skill_compact_hit(session_id, _skill_name)
                except Exception:  # noqa: BLE001
                    pass
    else:
        skill_lines = []

    # ── 0c. Recent Test Failures — pytest FAILED lines from bash history ────────
    # Extracted from the most-recent test-runner outputs in bash_history.
    # Helps the compaction LLM preserve "what is still broken" context without
    # requiring the agent to re-run tests after compaction.
    # Cap: _MAX_TEST_FAILURES names; each name is ~30 chars → ~8 tokens/entry.
    _test_failure_names = _extract_test_failures(raw_bash)
    test_failure_lines: list[str] = []
    if _test_failure_names:
        test_failure_lines.append("### Recent Test Failures")
        test_failure_lines.extend(f"- {_tf}" for _tf in _test_failure_names)

    # ── 0d. Dependency Changes — pip/uv/npm install output ──────────────────
    # Captures packages added/updated this session so the compaction LLM knows
    # about new dependencies even if the install command is no longer in context.
    # Cap: _MAX_DEP_CHANGES lines from the 3 most-recent install commands.
    _dep_changes = _extract_dep_changes(raw_bash)
    dep_change_lines: list[str] = []
    if _dep_changes:
        dep_change_lines.append("### Dependency Changes")
        dep_change_lines.extend(f"- {_dc}" for _dc in _dep_changes)

    # ── 0b. Uncommitted Changes — git diff --stat + status --short ───────────
    # Ground-truth picture of what's on disk regardless of which tool made the
    # changes.  Shown before Files Edited so the compaction LLM sees both the
    # Claude-tool-tracked edits and any manual changes in one pass.
    # Budget: ~40 tokens / ~200 chars max for the content; not counted against
    # the adaptive per-section budget (it's additional fixed context).
    uncommitted_changes: str | None = _get_uncommitted_changes(cwd)
    uncommitted_lines: list[str] = []
    if uncommitted_changes:
        uncommitted_lines.append("**Uncommitted:**")
        uncommitted_lines.extend(f"  {line.rstrip()}" for line in uncommitted_changes.splitlines())

    # ── 1. Edited files — highest priority (no cap) ───────────────────────────
    # Build the entire edited-files block first so we can measure its token cost
    # before allocating the remaining budget to variable sections.
    edited_lines: list[str] = []
    # Run the whole-repo git diff --stat once here so both the "Pending Changes"
    # section and the adaptive budget computation can use the cached result.
    pending_diff_stat: str = _get_git_diff_stat_summary(cwd)

    # Pre-compute a normalized-path → last_edit_ts lookup from files_clean once here.
    # Used both by the Edited section sort and (via sorted_edited) by the merged-files
    # section, so we pay the O(|files_clean|) build cost only once per manifest render.
    # Files only edited but never read have no FileEntry, so they map to 0.0.
    _edit_ts_by_norm: dict[str, float] = {
        _norm_key(key): getattr(entry, "last_edit_ts", 0.0)
        for key, entry in files_clean.items()
        if getattr(entry, "last_edit_ts", 0.0) > 0.0
    }

    # Get committed files — if a file was edited AND committed this session, it is
    # recoverable from git and lower-priority for the manifest vs. staged/uncommitted.
    committed_files_norm = _get_committed_files(cache, cwd)

    if edited_clean:
        # Split edited files into two categories: staged/uncommitted (CRITICAL) and
        # committed (recoverable from git, lower priority).  Only show the Staged/
        # Uncommitted section when there are uncommitted files; when all edits are
        # committed, emit a brief summary instead.
        uncommitted_edits = {
            path: count for path, count in edited_clean.items()
            if _norm_key(path) not in committed_files_norm
        }
        committed_edits = {
            path: count for path, count in edited_clean.items()
            if _norm_key(path) in committed_files_norm
        }

        # Sort all edited files by recency (most recently edited first) so truncation at
        # _MAX_EDITED_FILES_SHOWN drops the OLDEST edits rather than the newest.
        # When two files share the same last_edit_ts, edit count is the tiebreaker.
        # This sorted_edited list is used for all downstream logic (inline diffs, overflow, etc.)
        sorted_edited = sorted(
            edited_clean.items(),
            key=lambda item: (_edit_ts_by_norm.get(_norm_key(item[0]), 0.0), item[1]),
            reverse=True,
        )
        shown_edited = sorted_edited[:_MAX_EDITED_FILES_SHOWN]
        overflow_edited = len(sorted_edited) - len(shown_edited)

        # Determine which section header to show and set up tracking for inline diffs.
        # Split shown_edited into uncommitted and committed subsets for display.
        shown_uncommitted = [item for item in shown_edited if _norm_key(item[0]) not in committed_files_norm]
        shown_committed = [item for item in shown_edited if _norm_key(item[0]) in committed_files_norm]

        if uncommitted_edits:
            # Render Staged/Uncommitted section (critical — must preserve).
            edited_lines.append("**Staged/Uncommitted:**")
            _tracked_edits = uncommitted_edits  # Track for inline diffs below
            # Will render shown_uncommitted via inline diffs / grouped dir below
        elif committed_edits:
            # All edits are committed — emit brief summary instead of full listing.
            edited_lines.append("**Edited:** All edits committed — see git log")
            _tracked_edits = {}  # No inline diffs needed
        else:
            # This shouldn't happen since we're in the `if edited_clean` block.
            _tracked_edits = {}

        # Committed section (lower priority, only if there are uncommitted files too).
        if uncommitted_edits and committed_edits and shown_committed:
            edited_lines.append("**Committed This Session:**")
            for path, count in shown_committed:
                short = _short_path(path, project_root=cwd)
                suffix = _count_suffix(count)
                edited_lines.append(f"- {short}{suffix}")
            overflow_committed = len([item for item in sorted_edited if _norm_key(item[0]) in committed_files_norm]) - len(shown_committed)
            if overflow_committed > 0:
                edited_lines.append(f"- …+{overflow_committed} more committed")

        # ── #17: single-file inline diff ─────────────────────────────────────
        # When there is exactly one uncommitted/staged file AND the whole-repo diff
        # is small (<= _SINGLE_FILE_DIFF_CAP bytes), replace the file-list entry with
        # the inline diff so the compaction LLM has the exact change without a
        # round-trip.  Only attempted when cwd is available and there are uncommitted files.
        # Use shown_uncommitted if available (when we're splitting staged/committed);
        # otherwise use shown_edited (backward compat for all-committed case).
        _files_to_render = shown_uncommitted if uncommitted_edits else shown_edited

        _single_file_diff_used = False
        _inline_diffs_were_emitted = False  # Item #13: track for Pending Changes gate
        if len(_files_to_render) == 1 and cwd:
            _only_path, _only_count = _files_to_render[0]
            _whole_diff = _get_whole_repo_diff(cwd)
            if _whole_diff:
                edited_lines.append(f"#### {_short_path(_only_path, project_root=cwd)} (inline diff)")
                edited_lines.extend(f"  {_dl}" for _dl in _whole_diff.splitlines())
                _single_file_diff_used = True
                _inline_diffs_were_emitted = True

        if not _single_file_diff_used:
            # ── #7: per-file inline diffs for top 2 ──────────────────────────
            # For the top-2 most-edited files, attempt to inline git diff HEAD
            # output when the diff is small (< _INLINE_DIFF_MAX_BYTES).  Fall
            # back to the grouped directory format when diff is too large or git
            # is unavailable.  Total inlined bytes are capped at _INLINE_DIFF_TOTAL_CAP.
            _inline_budget = _INLINE_DIFF_TOTAL_CAP
            _inlined_paths: set[str] = set()
            if cwd and len(_files_to_render) >= 1:
                for _ip, _ic in _files_to_render[:2]:
                    if _inline_budget <= 0:
                        break
                    _idiff = _get_inline_diff_for_file(_ip, cwd)
                    if _idiff and len(_idiff) <= _inline_budget:
                        edited_lines.append(
                            f"#### {_short_path(_ip, project_root=cwd)}{_count_suffix(_ic)} (inline diff)"
                        )
                        edited_lines.extend(f"  {_dl}" for _dl in _idiff.splitlines())
                        _inlined_paths.add(_ip)
                        _inline_budget -= len(_idiff)
                        _inline_diffs_were_emitted = True

            # Remaining files (not inlined) use the grouped directory format.
            remaining_shown = [item for item in _files_to_render if item[0] not in _inlined_paths]
            if remaining_shown:
                # Item #35: adaptive directory grouping — increase grouping threshold
                # when many files are edited to save tokens. If >= 15 edited files,
                # group more aggressively (threshold=2 instead of 3) to consolidate
                # the directory listing.
                _adaptive_threshold = edited_dir_group_threshold
                if len(remaining_shown) >= 15:
                    _adaptive_threshold = max(2, edited_dir_group_threshold - 1)
                grouped_lines = _group_edited_by_dir(
                    remaining_shown,
                    project_root=cwd,
                    threshold=_adaptive_threshold,
                )
                edited_lines.extend(grouped_lines)
        else:
            _inlined_paths = set()

        if overflow_edited > 0 and _tracked_edits:
            edited_lines.append(f"- …+{overflow_edited} more staged/uncommitted")

        # ── 1a. Pending Changes (git diff --stat HEAD) ────────────────────────
        # Whole-repo stat placed immediately after Files Edited so the compaction
        # LLM sees the scope and magnitude of in-flight work alongside the list of
        # edited files.  Omitted entirely when there are no uncommitted changes.
        # Item #13: skip when nearly all edited files already have inline diffs —
        # the per-file diffs carry more information than the aggregate stat.
        # "Nearly all" = at most one file without an inline diff.
        _skip_pending = (
            _inline_diffs_were_emitted
            and len(_inlined_paths) >= len(_tracked_edits) - 1
        )
        if pending_diff_stat and not _skip_pending:
            edited_lines.append("**Pending:**")
            edited_lines.extend(f"  {line}" for line in pending_diff_stat.splitlines())

        # ── 1b. Diff summary + Commits this session ───────────────────────────
        # Both helpers are fail-soft and skip immediately when cwd is not a git
        # repo (via _is_git_repo). Sequential calls avoid ~3–8 ms of
        # ThreadPoolExecutor creation overhead on every manifest build; the
        # process-level TTL caches mean both results are usually already warm
        # on the second call within the same session anyway.
        # Only show diff stat for uncommitted files (committed ones are recoverable from git).
        edited_paths = list(uncommitted_edits.keys()) if uncommitted_edits else list(edited_clean.keys())
        diff_stat = _get_git_diff_stat(edited_paths, cwd)
        session_commits = _get_session_commits(cwd, created_ts) if created_ts > 0 else []

        # Item #27: surface non-zero stash count.  A forgotten stash is real
        # in-flight work the compaction LLM should know about; silent zero
        # stashes pay no token cost.
        stash_count = _get_stash_count(cwd) if cwd else 0
        if stash_count > 0:
            edited_lines.append(f"**Stashes:** {stash_count}  (run `git stash list` to inspect)")

        if diff_stat:
            edited_lines.append("### Diff Summary")
            edited_lines.extend(f"- {line}" for line in diff_stat.splitlines())

        if session_commits:
            edited_lines.append("### Commits This Session")
            edited_lines.extend(session_commits)

    # ── 1c-bis. Recent Branch Commits — pre-session git context ─────────────
    # When the session has made fewer than 2 commits (including the case of no
    # edited files at all), the manifest lacks "what was done before this session"
    # context.  Surface the last 3 commits from the branch so the compaction LLM
    # knows the recent work history even at the start of a fresh session or in a
    # read-only (no edits) session.
    #
    # Suppressed when:
    # - orchestrator mode is active (it has its own recent-commits section)
    # - the session already has >= 2 session commits (ample in-session context)
    # - cwd is not a git repo
    # - age_tier == "young" (< 10 min: the branch history hasn't changed yet)
    #
    # Token cost: ~30-50 tokens for 3 commit lines; comes from overall headroom,
    # not a dedicated budget slice.  Capped at 3 commits to keep cost predictable.
    _session_commits_for_branch = (
        session_commits if edited_clean else []  # type: ignore[possibly-undefined]
    )
    _need_branch_context = len(_session_commits_for_branch) < 2 and age_tier != "young"
    recent_branch_commit_lines: list[str] = []
    if _need_branch_context and cwd and _is_git_repo(cwd):
        _branch_commits = _get_recent_commits_for_orchestrator(cwd, n=3)
        if _branch_commits:
            recent_branch_commit_lines.append("### Recent Branch Commits")
            recent_branch_commit_lines.extend(
                f"  {line}" for line in _branch_commits
            )

    # ── 1d. Stale file snapshots ──────────────────────────────────────────────
    stale_lines = _render_section(
        "Outdated File Snapshots",
        stale_read_files[:6],
        lambda path: f"- ⚠ {_short_path(path, project_root=cwd)}",
    )

    # ── 1e. Most accessed symbols — top 5 by access count ──────────────────────
    # Render symbols that were accessed via surgical reads (token-goat read).
    # Only include symbols with count >= 2; single reads aren't interesting.
    raw_symbol_access = getattr(cache, "symbol_access_counts", None) or {}
    most_accessed_lines = _render_most_accessed_section(raw_symbol_access, max_entries=5)

    # Measure the "fixed" cost (header + blockers + uncommitted + edited + stale)
    # to derive per-section budgets.  Blocker lines are small (≤3 lines) so they
    # rarely consume more than ~15 tokens, but we count them to keep the budget
    # accurate.  The uncommitted-changes section is additional fixed context and
    # is not counted against any per-section proportional budget.
    # Compute sealed block early (same inputs as the final call below) so its
    # token cost can be deducted from the section-budget pool.  The sealed block
    # is protected — the safety-trim pass can never remove it — so any tokens it
    # consumes are not available to the proportional sections.  Without this
    # deduction _section_budgets over-allocates by ~20-80 tokens and the assembled
    # manifest consistently exceeds max_tokens on sessions with active blockers /
    # edited files / skills.
    sealed_block = _build_sealed_block(
        edited_clean, blocker_entries, raw_skills, _test_failure_names, raw_bash,
        session_started_ts=_session_started_ts,
    )
    sealed_tokens = _token_count("\n".join(sealed_block)) if sealed_block else 0

    fixed_text = "\n".join(
        header_lines + pinned_lines + blocker_lines + decision_lines + skill_lines
        + test_failure_lines + dep_change_lines
        + uncommitted_lines + edited_lines + recent_branch_commit_lines + stale_lines
    )
    fixed_tokens = _token_count(fixed_text) + sealed_tokens

    # Compute content-aware section budgets: identify which sections have entries
    # so empty sections (e.g., no web fetches) don't consume budget.
    # Count from raw/candidate sets to avoid redundant selection function calls.
    section_content_counts: dict[str, int] = {
        "symbols": len(files_with_symbols),  # files with accessed symbols
        "files": len(top_files),  # top files by read count
        "greps": len(raw_greps),  # grep searches (raw count; dedup is for rendering)
        "bash": len(raw_bash),  # bash commands in history
        "web": len(raw_web),  # web fetches
        "glob": len(getattr(cache, "glob_history", None) or []),  # glob scans
    }

    # Safety margin: the internal ``_token_count`` helper uses ``len // 4``
    # (conservative) while the final ``estimate_tokens`` check uses
    # ``len // 3 + 1`` (more generous, ~33 % higher for the same text).
    # This discrepancy means assembled sections can collectively use more
    # tokens than ``max_tokens`` when measured by ``estimate_tokens``, causing
    # the safety-trim pass to fire and burn extra CPU.  Reducing the budget
    # seen by ``_section_budgets`` by 15 % provides a headroom cushion so the
    # assembled manifest stays under the limit on the first pass in the common
    # case, without meaningfully shrinking useful content (15 % of a 400-token
    # budget is 60 tokens — the safety-trim pass already handles up to ~80).
    _SECTION_BUDGET_SAFETY_FACTOR: float = 0.85
    sec_budget_max = max(1, int(max_tokens * _SECTION_BUDGET_SAFETY_FACTOR))
    sec_budgets = _section_budgets(sec_budget_max, fixed_tokens, section_content_counts)
    _LOG.debug(
        "_render: fixed_tokens=%d  section_budgets=%s content_counts=%s "
        "safety_margin=15%% (max_tokens=%d sec_budget_max=%d) (session=%s)",
        fixed_tokens, sec_budgets, section_content_counts,
        max_tokens, sec_budget_max, session_id[:8],
    )

    # ── 2. Symbols accessed — up to 40 % of remaining budget ─────────────────
    sym_budget = sec_budgets["symbols"]
    # Item #24 — Wide session: replace per-file symbol list with map pointer.
    # When the session has accessed >= wide_session_threshold unique files,
    # the per-file symbol listing consumes 200–300 tokens the compaction LLM
    # can't usefully retain.  Emit a single actionable pointer instead.
    _wide_session = len(cache.files) >= wide_session_threshold
    # Only the cheap single-line wide-session pointer is force-protected from the safety-trim; large per-file symbol listings and orchestrator commits stay droppable.
    _syms_protected = False
    if _wide_session:
        _wide_line = (
            f"**Symbols Accessed:** {len(cache.files)} files accessed"
            " — use `token-goat map --compact` to re-orient."
        )
        _wide_cost = _token_count(_wide_line)
        # The map-pointer IS the symbols-section content in a wide session, so don't let it be starved when the proportional symbols slice is 0 (no distinct symbol reads): floor its budget at its own cost when the overall section budget has room (sec_budget_max >= _WIDE_POINTER_MIN_SECTION_BUDGET). At tighter budgets keep deferring to sym_budget so protected top-files win the contested space.
        _pointer_budget = max(sym_budget, _wide_cost) if sec_budget_max >= _WIDE_POINTER_MIN_SECTION_BUDGET else sym_budget
        sym_lines: list[str] = [_wide_line] if _wide_cost <= _pointer_budget else []
        sym_used: int = _wide_cost if sym_lines else 0
        _syms_protected = bool(sym_lines)
    else:
        # Item #8: suppress symbol-detail lines for files that already appear in
        # the **Files:** read list (top_files).  The read entry implies the file
        # is interesting; repeating its symbol breakdown is redundant
        # (~25 tokens per dual-listed file).  We use the `top_files` candidate
        # set rather than the budget-filtered `included_top_files` because the
        # files section is rendered later; in practice nearly every entry in
        # top_files survives budget filtering, so the suppression set is
        # essentially the same.
        _top_files_paths_norm = {
            _norm_key(getattr(e, "rel_or_abs", ""))
            for e in top_files
        }

        # Item #33: cross-file symbol deduplication. When the same symbol appears
        # in multiple files, keep only the reference from the most-recently-accessed
        # file. This saves manifest tokens by eliminating redundant listings.
        _global_symbol_refs = _dedup_symbols_across_files(files_with_symbols, now_for_scoring)

        # Item #34: stale symbol filtering when budget is tight (< 80 tokens remaining).
        # Drop symbols accessed more than 60 min ago to preserve budget for recent context.
        _budget_tight = sym_budget < 80
        _stale_threshold_secs = 3600 if _budget_tight else float("inf")

        # Item #36: cross-section symbol deduplication. When a file is in the Edited
        # section, its symbols are already covered by the edited-file listing.
        # Drop all symbols from edited files to avoid redundant listings in the
        # symbols-accessed section. Keep only read-only files (not in edited_keys).
        _readonly_symbol_files: list[FileEntry] = []  # type: ignore[name-defined]  # FileEntry imported under TYPE_CHECKING; annotation safe at runtime with 'from __future__ import annotations'
        for entry in files_with_symbols:
            entry_norm = _norm_key(entry.rel_or_abs)
            if entry_norm not in edited_keys:
                _readonly_symbol_files.append(entry)  # type: ignore[arg-type]  # entry is from files_with_symbols (list[FileEntry]) but typed as object in the loop
        _prioritized_symbol_files = _readonly_symbol_files

        sym_formatted: list[str] = []
        _suppressed_sym_files = 0
        for entry in _prioritized_symbol_files:
            _entry_path_norm = _norm_key(entry.rel_or_abs)
            if _entry_path_norm in _top_files_paths_norm:
                # Skip — the file already appears in **Files:** so the symbol
                # detail line would be a redundant ~25-token repeat.
                _suppressed_sym_files += 1
                continue
            ranked_symbols = _rank_symbols_by_recency(entry, now_for_scoring)
            # Item #11: dedup consecutive/repeated symbols before rendering (order-preserving).
            _seen_syms: set[str] = set()
            deduped_symbols = [s for s in ranked_symbols if not (_seen_syms.__contains__(s) or _seen_syms.add(s))]  # type: ignore[func-returns-value]  # set.add() returns None which is falsy; this is an order-preserving dedup idiom

            # Item #33: filter out symbols that are duplicated in other files
            # (keep only if this file is the most-recent reference).
            filtered_symbols = [
                s for s in deduped_symbols
                if _global_symbol_refs.get(s, ("", 0.0))[0] == entry.rel_or_abs
            ]

            # Item #34: filter stale symbols when budget is tight
            if _budget_tight:
                symbols_ts = getattr(entry, "symbols_ts", None) or {}
                fresh_symbols = [
                    s for s in filtered_symbols
                    if (now_for_scoring - symbols_ts.get(s, 0.0)) < _stale_threshold_secs
                ]
                stale_removed = len(filtered_symbols) - len(fresh_symbols)
                filtered_symbols = fresh_symbols
            else:
                stale_removed = 0

            # Task: Apply class method grouping when 3+ methods share the same class
            grouped_symbols = _collapse_class_methods(filtered_symbols)

            dupes_removed = len(ranked_symbols) - len(deduped_symbols)
            cross_file_dupes = len(deduped_symbols) - len(filtered_symbols) - stale_removed
            syms = [sanitize_log_str(s, max_len=80) for s in grouped_symbols[:_MAX_SYMBOLS_PER_FILE_ENTRY]]
            overflow = len(grouped_symbols) - _MAX_SYMBOLS_PER_FILE_ENTRY
            dupe_note = f" (+{dupes_removed} dupes)" if dupes_removed >= 3 else ""
            xfile_note = f" (-{cross_file_dupes} xfile)" if cross_file_dupes >= 1 else ""
            stale_note = f" (-{stale_removed} stale)" if stale_removed >= 1 else ""
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "") + dupe_note + xfile_note + stale_note
            sym_formatted.append(f"- {_short_path(entry.rel_or_abs, project_root=cwd)} → {sym_str}")
        if _suppressed_sym_files:
            _LOG.debug(
                "_render: suppressed %d symbol-detail line(s) for files in **Files:** "
                "(item #8)", _suppressed_sym_files,
            )
        sym_lines, sym_used = _render_budget_lines("**Symbols Accessed:**", sym_formatted, sym_budget)

    # ── 3. Bash history — up to 15 % of remaining budget ─────────────────────
    # Young sessions (< 10 min) skip bash/web sections: few commands have run
    # and the overhead of listing them is not worth it relative to the budget.
    bash_budget = sec_budgets["bash"]
    _all_bash_entries = (
        _select_top_bash_entries(getattr(cache, "bash_history", None))
        if age_tier != "young"
        else []
    )
    # Exclude entries already listed in "Current Blockers" — showing a failed
    # command as both a brief blocker note and a full entry with output snippet
    # wastes manifest tokens on the same information twice.
    # Also exclude entries whose output_id was already surfaced to the agent via
    # a bash dedup hint earlier in the session — the agent has already seen a
    # recall pointer; repeating the full snippet in the manifest is redundant.
    # Blocker entries are exempt from the dedup-hint exclusion so a failing
    # command always appears in the manifest regardless of prior hint exposure.
    _blocker_ids = {getattr(e, "output_id", None) for e in blocker_entries}
    _dedup_emitted_ids: set[str] = getattr(cache, "bash_dedup_emitted_ids", set()) or set()
    bash_entries = [
        e for e in _all_bash_entries
        if getattr(e, "output_id", None) not in _blocker_ids
        and getattr(e, "output_id", None) not in _dedup_emitted_ids
    ]
    # Inline snippet only when the entry is large enough that the preview pays
    # for itself (>= 600 bytes).  Small outputs are trivially recalled via
    # `token-goat bash-output <id>`; emitting the snippet wastes manifest tokens.
    # Blockers always get inline_snippet=True — their output is the most
    # load-bearing content in the manifest and must be visible without a
    # recall round-trip.
    _blocker_ids_for_snippet = {getattr(e, "output_id", None) for e in blocker_entries}
    def _should_inline(be: object) -> bool:
        oid = getattr(be, "output_id", None)
        if oid and oid in _blocker_ids_for_snippet:
            return True
        total = int(getattr(be, "stdout_bytes", 0)) + int(getattr(be, "stderr_bytes", 0))
        return total >= 600

    # Item #28: group bash entries by exit-code class within the **Ran:** section.
    # Order: **Failed:** (exit != 0) first, then **Slow:** (exit == 0, elapsed > 5s),
    # then **Ok:** (the rest).  Within each group the existing recency/size ordering
    # from `_select_top_bash_entries` is preserved.  Empty groups omit their header.
    # When all entries are in a single group AND that group is **Ok:**, we skip the
    # sub-header entirely (the **Ran:** label is sufficient).
    bash_lines, bash_used = _render_bash_grouped(
        bash_entries, bash_budget, _should_inline,
    )

    # ── 3a. What Worked — last 2 green test runs ──────────────────────────────
    # A dedicated curated section so the compaction LLM (and post-compact agent)
    # knows "tests passed as of N minutes ago" without re-running them.
    # Uses the same _blocker_ids set as the Commands Run exclusion above so we
    # never surface the passing version of a command that is currently blocking.
    # Also excludes _dedup_emitted_ids so an entry the agent already received a
    # recall pointer for is not re-surfaced via this different section path.
    _what_worked_exclude = _blocker_ids | _dedup_emitted_ids
    _what_worked_entries = _select_what_worked(raw_bash, _what_worked_exclude)
    now_ts_for_worked = time.time()
    what_worked_lines = _render_what_worked_section(_what_worked_entries, now_ts_for_worked)

    # ── Orchestrator mode override ────────────────────────────────────────────
    # When the session looks like a /improve orchestrator loop (many commits,
    # few edited files), replace sym_lines with a recent-commits section and
    # suppress bash history (too noisy across long loop iterations).
    _orchestrator_mode = _detect_orchestrator_mode(
        cache, cwd, threshold=orchestrator_commit_threshold
    )
    if _orchestrator_mode:
        # Count all session commits for the header line.
        _orch_total_raw = _run_git(
            ["log", "--oneline", f"--since={int(created_ts)}"],
            cwd,
            timeout=3,
        ) if cwd and created_ts and created_ts > 0 else None
        _orch_total_count = sum(1 for ln in (_orch_total_raw or "").splitlines() if ln.strip())
        _orch_header_line = f"⚙ Orchestrator session detected ({_orch_total_count} commits)"
        _orch_commits = _get_recent_commits_for_orchestrator(cwd, n=10)
        sym_lines = [_orch_header_line, "### Recent Commits"]
        sym_lines.extend(_orch_commits)
        sym_used = _token_count("\n".join(sym_lines))
        _syms_protected = False  # orchestrator commits are droppable, not the force-protected pointer
        # Suppress bash history and what_worked — too noisy in orchestrator loops.
        bash_lines = []
        bash_used = 0
        what_worked_lines = []
        _LOG.info(
            "_render: orchestrator mode active session=%s commits=%d edited=%d",
            session_id[:8], _orch_total_count, len(edited_clean),
        )

    # Cold outputs are grouped with bash history (same budget slice).
    # Skip for young and active sessions — only emit for mature sessions (>60 min).
    # Rationale: Cold Outputs advises the compaction LLM to evict old bash output
    # from context.  For active sessions the outputs are still likely relevant and
    # emitting the section wastes budget; for mature sessions the 30-min-old outputs
    # are almost certainly stale and the eviction hint pays back its token cost.
    now_ts = time.time()
    bash_hist_raw = getattr(cache, "bash_history", None) or {} if age_tier == "mature" else {}
    cold_candidates = sorted(
        [
            be for be in bash_hist_raw.values()
            if (now_ts - getattr(be, "ts", now_ts)) > _COLD_OUTPUT_AGE_SECS
            and (getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0))
            >= _MIN_BASH_BYTES_FOR_MANIFEST
            and getattr(be, "exit_code", 0) == 0  # Exclude failed commands (unresolved issues)
        ],
        key=lambda be: getattr(be, "ts", 0.0),
        reverse=True,
    )
    cold_outputs: list[object] = []
    if cold_candidates:
        # Item #11: shortened from "### Cold Outputs (evict — recall via …)" to a
        # bold-label one-liner.  Saves ~2 tokens per session that has cold outputs.
        cold_header = "**Cold:** evict, recall via `token-goat bash-output <id>`"
        cold_header_cost = _token_count(cold_header)
        if bash_used + cold_header_cost <= bash_budget:
            # Collect content lines first; emit header only when ≥2 entries fit
            # (min_lines=2: a single cold-output row isn't worth the header cost).
            cold_content_lines: list[str] = []
            cold_content_used = 0
            for be in cold_candidates[:_MAX_COLD_OUTPUTS]:
                age_min = int((now_ts - getattr(be, "ts", now_ts)) / 60)
                total = getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
                oid = _short_id(sanitize_log_str(getattr(be, "output_id", "?"), max_len=64))
                prev = sanitize_log_str(getattr(be, "cmd_preview", "?"), max_len=60)
                line = f"- ❄ `{prev}` ({_humanize_bytes(total)}, {age_min}min old, {oid})"
                cost = _token_count(line)
                if bash_used + cold_header_cost + cold_content_used + cost > bash_budget:
                    break
                cold_content_lines.append(line)
                cold_content_used += cost
                cold_outputs.append(be)
            if len(cold_outputs) >= 2:
                bash_lines.append(cold_header)
                bash_used += cold_header_cost
                bash_lines.extend(cold_content_lines)
                bash_used += cold_content_used
                dropped_cold = len(cold_candidates) - len(cold_outputs)
                if dropped_cold > 0 and bash_used < bash_budget:
                    overflow_line = f"- …+{dropped_cold} more cold outputs"
                    if bash_used + _token_count(overflow_line) <= bash_budget:
                        bash_lines.append(overflow_line)

    # ── 3b. Web fetches — up to 10 % of remaining budget ─────────────────────
    # Young sessions skip web sections — same rationale as bash_entries above.
    web_budget = sec_budgets["web"]
    web_entries = (
        _select_top_web_entries(raw_web)
        if age_tier != "young"
        else []
    )
    # min_lines=1: a single fetched URL is genuine signal (the agent did one
    # WebFetch and that URL is worth surfacing); min_lines=2 here hid useful
    # entries.  Cold Outputs and Directory Scans keep min_lines=2 because a
    # single stale/empty-ish entry is genuinely noisy there.
    web_lines, web_used = _render_budget_lines(
        "**Web Fetches:**",
        _group_web_entries_by_domain(web_entries) if web_entries else [],
        web_budget,
    )

    # ── 4. Grep patterns — up to 15 % of remaining budget ────────────────────
    grep_budget = sec_budgets["greps"]
    # Tally raw occurrence counts BEFORE _select_top_grep_entries deduplicates by
    # pattern; otherwise _dedup_grep_entries always sees count=1 and [×N] never fires.
    _raw_grep_counts: dict[str, int] = {}
    for _rg in raw_greps:
        _rp = getattr(_rg, "pattern", "")
        if _rp:
            _raw_grep_counts[_rp] = _raw_grep_counts.get(_rp, 0) + 1
    grep_entries = _dedup_grep_entries(
        _select_top_grep_entries(raw_greps),
        raw_counts=_raw_grep_counts,
    )
    # #35: when the all-zero fallback is active (every remaining entry has 0 hits)
    # AND the session is older than 5 minutes, the section carries no useful signal —
    # drop it entirely.  Young sessions keep the section so the agent sees it tried.
    _all_grep_zero = bool(grep_entries) and all(
        (getattr(g, "result_count", None) or 0) == 0 for g in grep_entries
    )
    if _all_grep_zero and age_secs > 300:
        grep_entries = []
    grep_lines, grep_used = _render_budget_lines(
        "**Patterns Searched:**",
        [_format_grep_entry(ge) for ge in grep_entries],
        grep_budget,
    )
    if grep_lines:
        included_greps = len(grep_lines) - 1  # index 0 is the header
        # Count only selector-surviving entries — stale/zero-result patterns
        # were intentionally discarded by _select_top_grep_entries and must
        # not inflate the "+N more" count shown to the compaction LLM.
        dropped_greps = len(grep_entries) - included_greps
        if dropped_greps > 0:
            overflow_line = f"- …+{dropped_greps} more patterns"
            if grep_used + _token_count(overflow_line) <= grep_budget:
                grep_lines.append(overflow_line)

    # ── 4b. Glob scans — up to 5 % of remaining budget ───────────────────────
    glob_budget = sec_budgets["glob"]
    glob_lines: list[str] = []
    glob_used = 0
    glob_entries = (
        _select_top_glob_entries(getattr(cache, "glob_history", None))
        if age_tier != "young"
        else []
    )
    glob_lines = _render_section(
        "Directory Scans",
        glob_entries,
        lambda e: _format_glob_entry(e, cwd=cwd),
    )
    if glob_lines:
        # min_lines=2: a single-entry Directory Scans section is rarely worth the
        # header overhead — suppress it the same way _render_budget_lines does.
        content_lines = len(glob_lines) - 1  # index 0 is the header
        if content_lines < 2:
            glob_lines = []
            glob_used = 0
        else:
            glob_used = _token_count("\n".join(glob_lines))
            if glob_used > glob_budget:
                glob_lines = []
                glob_used = 0

    # ── 5. Key files read — up to 30 % of remaining budget ───────────────────
    # Output is split into two groups:
    #   files_core_lines — top-_TOP_FILES_GUARANTEED_MIN files (protected: always survive)
    #   files_lines      — remaining files beyond the guarantee (unprotected: dropped on pressure)
    # This guarantees the most-accessed files always appear in the manifest regardless
    # of budget or safety-trim pressure.  In long sessions (50+ files) the compaction
    # LLM must know which files received the most attention even when the overall
    # manifest token budget is nearly exhausted by edited/blocker/skills sections.
    files_budget = sec_budgets["files"]
    files_lines: list[str] = []
    files_core_lines: list[str] = []
    files_used = 0
    included_top_files: list[_FileEntry] = []

    if top_files:
        header = "**Files:**"
        header_cost = _token_count(header)
        files_entries_for_section: list[str] = []

        # Hot files (≥ threshold reads) get a single consolidated summary line.
        hot_files = [e for e in top_files if e.read_count >= _HOT_FILE_READ_THRESHOLD]
        # Non-hot files: sort by importance score (highest first) so that low-score
        # files appear at the tail and are dropped first under budget/trim pressure.
        # Fall back to alphabetical order when no DB score data is available.
        _score_map: dict[str, float] = {}
        if cwd is not None:
            try:
                from pathlib import Path as _Path  # noqa: PLC0415

                from . import db as _db_mod  # noqa: PLC0415
                from .project import canonicalize as _canonicalize  # noqa: PLC0415
                from .project import project_hash as _project_hash_fn
                _score_map = _db_mod.get_entry_scores(_project_hash_fn(_canonicalize(_Path(cwd))))
            except Exception:  # noqa: BLE001
                pass
        _normal_candidates = [e for e in top_files if e.read_count < _HOT_FILE_READ_THRESHOLD]
        if _score_map:
            normal_files = sorted(_normal_candidates, key=lambda e: _score_map.get(e.rel_or_abs, 0.0), reverse=True)
        else:
            normal_files = sorted(_normal_candidates, key=lambda e: e.rel_or_abs.lower())

        if hot_files:
            shown = hot_files[:_HOT_FILE_MAX_SHOWN]
            overflow = len(hot_files) - _HOT_FILE_MAX_SHOWN

            def _basename(p: str) -> str:
                p = p.replace("\\", "/")
                return p.rsplit("/", 1)[-1] if "/" in p else p

            name_parts = [
                f"{_basename(e.rel_or_abs)}{_count_suffix(e.read_count)}"
                for e in shown
            ]
            hot_line_text = "Hot (5+×): " + ", ".join(name_parts)
            if overflow > 0:
                hot_line_text += f" +{overflow} more"
            hot_line = f"- → {hot_line_text}"
            cost = _token_count(hot_line)
            # Always include the consolidated hot-files line: hot files represent
            # the most-accessed files in the session and must not be silently dropped
            # when the files_budget is tight.  (Budget will be reclaimed via the
            # safety-trim pass if the manifest exceeds max_tokens.)
            files_entries_for_section.append(hot_line)
            files_used += cost
            included_top_files.extend(shown)

        # Item #37: Build a lookup of symbol lists for files that have symbols but
        # whose symbol lines were suppressed from "Symbols Accessed" because they
        # also appear in "Key Files Read" (item #8 suppression).  When a file is
        # read 3+ times AND has symbols, annotating the Files entry with the top
        # symbols recovers that information inline rather than silently dropping it.
        # Only include symbols not already shown in the Symbols Accessed section
        # (i.e. files that ARE in _top_files_paths_norm — the suppression set).
        # Use _rank_symbols_by_recency so the most recently accessed symbols are shown.
        _symbols_by_norm_path: dict[str, list[str]] = {}
        for _sym_entry in files_with_symbols_all:
            _entry_norm = _norm_key(_sym_entry.rel_or_abs)
            if _entry_norm not in edited_keys:
                _ranked = _rank_symbols_by_recency(_sym_entry, now_for_scoring)
                # Deduplicate preserving order (same idiom as sym_formatted loop above).
                _seen: set[str] = set()
                _deduped = [s for s in _ranked if not (_seen.__contains__(s) or _seen.add(s))]  # type: ignore[func-returns-value]
                if _deduped:
                    _symbols_by_norm_path[_entry_norm] = _deduped

        for entry in normal_files:
            ranges_str = _format_ranges(entry.line_ranges)
            # Files read 3+ times get an explicit "(read Nx)" annotation so post-compaction
            # Claude can immediately identify which files received the most attention.
            # Files read once or twice get no annotation — the path alone is sufficient.
            read_annotation = f" (read {entry.read_count}x)" if entry.read_count >= 3 else ""
            # Item #37: Inline top symbols for frequently-read files (3+ reads).
            # These symbols were suppressed from "Symbols Accessed" by item #8 because
            # the file is already listed here; recovering them inline preserves the
            # information without duplication.  Cap at 3 symbols to keep the line short.
            _sym_suffix = ""
            if entry.read_count >= 3:
                _file_syms = _symbols_by_norm_path.get(_norm_key(entry.rel_or_abs), [])
                if _file_syms:
                    _top_syms = [sanitize_log_str(s, max_len=50) for s in _file_syms[:3]]
                    _sym_suffix = ": " + ", ".join(_top_syms)
            line = f"- → {_short_path(entry.rel_or_abs, max_len=80, project_root=cwd)}{read_annotation}{_sym_suffix}{ranges_str}"
            cost = _token_count(line)
            # Guaranteed minimum: the first _TOP_FILES_GUARANTEED_MIN entries always
            # get included regardless of files_budget.  Hot files (added before this
            # loop) count toward the guarantee so the counter is never double-counted.
            total_included = len(included_top_files)
            within_guarantee = total_included < _TOP_FILES_GUARANTEED_MIN
            if not within_guarantee and files_used + header_cost + cost > files_budget:
                break
            files_entries_for_section.append(line)
            files_used += cost
            included_top_files.append(entry)

        # Split the assembled entries into a protected "core" block (top-N files)
        # and an unprotected "rest" block.  The header is shared: if both blocks
        # have content we only emit one "**Files:**" heading by attaching it to
        # the core block.  If only rest-files exist (no core entries), the header
        # goes with the rest block (normal unprotected path).
        if files_entries_for_section:
            # Core entries: header + up to _TOP_FILES_GUARANTEED_MIN bullet lines.
            # Because hot_files produces a single consolidated line that represents
            # many files, count the individual file objects in included_top_files to
            # determine how many bullet lines belong in the core block.  The
            # guarantee is per-entry in the *list* (bullets 1..N), not per FileEntry.
            core_entry_count = min(_TOP_FILES_GUARANTEED_MIN, len(files_entries_for_section))
            core_entries = files_entries_for_section[:core_entry_count]
            rest_entries = files_entries_for_section[core_entry_count:]
            # Emit core (protected) with the shared header.
            files_core_lines.append(header)
            files_core_lines.extend(core_entries)
            files_used += header_cost
            # Emit rest (unprotected) — no second header needed; it continues the
            # same logical section in the manifest.
            if rest_entries:
                files_lines.extend(rest_entries)

    # ── 6b. TODOs — pending/in-progress TaskList entries (no budget slice) ──────
    # TaskList state is persisted by the harness at ~/.claude/tasks/<session_id>/.
    # Loading it is a fast local disk read; the section is small (≤5 lines) so it
    # does not need a dedicated budget slice — it comes out of the overall headroom
    # after the budgeted sections are assembled.
    raw_tasks = _load_task_list(session_id)
    # Item #29: pass the set of edited paths so the section suppresses TODOs
    # whose subject already references a pinned edited file.
    todo_lines = _render_tasks_section(
        raw_tasks,
        edited_paths=set(edited_clean) if edited_clean else None,
    )

    # ── 6b.5. Session Goal — inferred from edited files, symbols, and commands ────
    # Gives the compaction LLM immediate context about what the session was trying
    # to accomplish without requiring reverse-engineering from file names alone.
    # Low priority: trimmed first if under space pressure.
    session_goal_lines: list[str] = []
    _session_goal = infer_session_goal(cache)
    if _session_goal:
        session_goal_lines = [f"**Session goal:** {_session_goal}"]

    # ── 6c. Open Questions — TODO/FIXME/WHY comments in edited files ────────────
    # Scan edited files for open questions (TODO, FIXME, WHY, HACK, XXX markers
    # and inline '?' in comments).  Like TODOs, this uses no budget slice — the
    # section is small and comes out of overall headroom.  Helps the compaction
    # LLM preserve awareness of pending issues and questions embedded in code.
    open_questions_lines: list[str] = []
    if edited_clean:
        questions = _find_open_questions(list(edited_clean.keys()), max_questions=5)
        if questions:
            open_questions_lines.append("### Open Questions")
            open_questions_lines.extend(f"- {q}" for q in questions)

    # ── 6d. Active Errors — unresolved bash errors from cache ──────────────────
    # Surfaces recent bash outputs with error indicators (non-zero exit codes or
    # error patterns in output) so the compaction LLM knows what is actively
    # blocking the agent.  Like TODOs and Open Questions, uses no budget slice —
    # the section is small and comes out of overall headroom.
    active_errors_lines = _render_active_errors_section(session_id, max_errors=3)

    # ── Item #16 — Merge Files Edited + Key Files Read when overlap >= 50% ──────
    # When many of the same paths appear in both the Edited and Files sections,
    # collapsing them into one "**Files:**" section saves one section header plus
    # one listing per overlapping path (~13 tokens/path).  The merged section uses
    # a combined "✎×N →×M" annotation so the compaction LLM still distinguishes
    # edited paths from read-only ones.
    #
    # Overlap ratio = |edited ∩ all_reads| / max(|edited|, 1).
    # We compare against files_clean (the full read map including edited files —
    # edited files are explicitly excluded from key_files_candidates so they never
    # appear in included_top_files, but they were still read by the session).
    # Only merge when ratio >= 0.5 AND both the Edited section and Files section
    # have content (so we are not collapsing a section that doesn't exist yet).
    _all_read_paths_norm = {
        _norm_key(key)
        for key in files_clean
    }
    _edited_paths_norm = {_norm_key(p): p for p in edited_clean}
    _overlap_set = set(_edited_paths_norm.keys()) & _all_read_paths_norm
    _overlap_ratio = len(_overlap_set) / max(len(edited_clean), 1)
    _do_merge = (
        _overlap_ratio >= 0.5
        and bool(edited_clean)
        and bool(included_top_files)
        and not _inline_diffs_were_emitted  # keep inline diffs — higher value than merge savings
    )
    if _do_merge:
        # Build a merged **Files:** section.
        # Collect all unique paths: edited paths first (preserving recency-then-count order),
        # then read-only top-files not in edited.
        merged_entries: list[str] = []
        _read_count_map = {
            _norm_key(entry.rel_or_abs): entry
            for entry in included_top_files
        }
        # Also check files_clean for read counts of edited paths.
        _files_clean_norm = {
            _norm_key(key): entry
            for key, entry in files_clean.items()
        }
        # Reuse sorted_edited (pre-computed above) — same recency-then-count ordering
        # as the Edited section, so the merged section is consistent with it.
        for _ep, _ec in sorted_edited:
            _ep_norm = _norm_key(_ep)
            # Prefer read-count from included_top_files; fall back to files_clean.
            _re = _read_count_map.get(_ep_norm) or _files_clean_norm.get(_ep_norm)
            _rc = _re.read_count if _re else 0
            _annotation = f"✎×{_ec}" if _ec > 1 else "✎"
            if _rc > 0:
                _annotation += f" →×{_rc}"
            merged_entries.append(f"- {_short_path(_ep, project_root=cwd)} {_annotation}")
        # Add read-only top-files not in edited_clean.
        _edited_norm_set = set(_edited_paths_norm.keys())
        for _re in included_top_files:
            _rp_norm = _norm_key(_re.rel_or_abs)
            if _rp_norm not in _edited_norm_set:
                _rc = _re.read_count
                _annotation = f"→×{_rc}" if _rc > 1 else "→"
                merged_entries.append(
                    f"- {_short_path(_re.rel_or_abs, project_root=cwd)} {_annotation}"
                )
        # Replace both edited_lines and files_lines with the merged section.
        # Drop the existing edited content (header + file list) and files_lines.
        # Keep only the non-file sub-sections from edited_lines: diff, commits, pending.
        # The merged block goes where edited_lines was; files_lines is suppressed.
        _merged_section_lines = ["**Files:**"] + merged_entries
        # Preserve diff/commit/pending sub-sections that were appended after the file list.
        # These start with "**Pending:**", "### Diff Summary", "### Commits This Session".
        _edited_subsections: list[str] = []
        _in_subsection = False
        for _el in edited_lines:
            if _el.startswith(("**Pending:**", "### Diff Summary", "### Commits This Session")):
                _in_subsection = True
            if _in_subsection:
                _edited_subsections.append(_el)
        edited_lines = _merged_section_lines + _edited_subsections
        files_lines = []       # suppressed — merged into edited_lines
        files_core_lines = []  # suppressed — merged into edited_lines

    # ── Legend — only list markers that actually appear above ─────────────────
    has_edit = bool(edited_clean)
    has_read = bool(included_top_files or sym_lines)
    has_stale = bool(stale_read_files)
    has_cold = bool(cold_outputs)
    has_skill = bool(skill_lines)
    legend_parts = []
    if has_edit:
        legend_parts.append("edited=✎")
    if has_read:
        legend_parts.append("read=→")
    if has_stale:
        legend_parts.append("stale=⚠")
    if has_cold:
        legend_parts.append("cold=❄")
    if has_skill:
        legend_parts.append("skill=🧠")

    # ── Sealed above-the-fold block — survives aggressive compaction ─────────
    # Built last so it has access to all three inputs (edited_clean, blocker_entries,
    # raw_skills).  Prepended before the header so it appears at the very top of the
    # manifest — compaction LLMs attend most to the top of long documents, and the
    # explicit <<MUST_PRESERVE>> markers are unlikely to be summarised away.
    # (sealed_block is computed earlier near the fixed_tokens calculation — reuse it.)

    # Assemble the final manifest in inverted-pyramid order: most critical first
    # so that if the manifest is truncated mid-token the surviving content is
    # the highest-value information for the compaction LLM.
    #   [sealed] Above-the-fold MUST_PRESERVE block — edited files, blocker, skills
    #   0. Current Blockers  — active failures the agent must know about
    #   1. Files Edited       — ongoing work (must survive compaction)
    #   1a.Recent Commits     — session commit history
    #   2. Bash history       — current work context (what was just run)
    #   2a.What Worked        — last 2 green test runs (curated "good state" pointer)
    #   3. Symbols accessed   — precise code read
    #   4. Web fetches        — reference material
    #   4b. Glob scans        — directory scan history
    #   5. Grep patterns      — investigation history (least critical)
    #   6. Key files read     — broader context
    #   6b. TODOs             — pending/in-progress TaskList entries
    #   6c. Active Skills     — skill recall hints (protected, after edited files)
    # ── Section assembly with truncation priority ───────────────────────────
    # Each tuple is (name, lines, protected).  ``protected`` sections are NEVER
    # dropped wholesale during the safety-trim pass — they carry the highest
    # post-compact recovery signal (sealed block, header, blockers, decisions,
    # active skills, uncommitted/edited state).  Unprotected sections are
    # dropped in reverse list order (lowest-signal first) when the manifest
    # exceeds ``max_tokens``.  This replaces the previous naive bottom-up
    # line-popping which could leave orphan section headers (e.g. ``**Files:**``
    # with no entries) and silently strip the legend line before any content.
    #
    # Drop order (lowest signal → highest):
    #   1. open_questions — TODO/FIXME/WHY comments in edited files (cheap to recover)
    #   2. files       — Key Files Read (read-only context, already implied by syms)
    #   3. grep        — Investigation history (least load-bearing)
    #   4. glob        — Directory scan history
    #   5. web         — Reference material URLs
    #   6. syms        — Symbol detail per file
    #   7. what_worked — Curated "tests were green" pointer
    #   8. dep_changes — Dependency changes (recoverable from git diff)
    #   9. bash        — Command history (current work context — only drop under extreme pressure)
    #  10. stale       — Outdated snapshot warnings (small, useful — kept above bash)
    #  11. test_failures — Recent test failures (high value for active fix cycles)
    # Protected (never wholesale-dropped):
    #   sealed, header, blockers, decisions, skills, uncommitted, edited, todos, legend.
    #   (todos is protected so the compaction LLM always sees pending tasks.)
    # Section order (inverted pyramid — most critical first):
    #   sealed/header/pinned/blockers/decisions — framing and active failures
    #   test_failures/uncommitted/edited        — must-preserve work-in-progress
    #   recent_commits                          — session commit history
    #   stale/most_accessed/session_goal        — context signals
    #   bash/what_worked                        — command history
    #   syms                                    — symbol details per file
    #   web/glob/dep_changes/grep               — reference / search history
    #   todos                                   — pending tasks (protected, before files so
    #                                             line-popper pops files before tasks)
    #   files_core/files                        — key files read (broader context)
    #   open_questions/active_errors            — pending issues
    #   skills                                  — active skill recall hints (last,
    #                                             but protected so never dropped;
    #                                             positioned after edited so edited
    #                                             files appear first in the manifest)
    _section_groups: list[tuple[str, list[str], bool]] = [
        ("sealed",        sealed_block,          True),
        ("header",        header_lines,          True),
        ("pinned",        pinned_lines,          True),
        ("blockers",      blocker_lines,         True),
        ("decisions",     decision_lines,        True),
        ("test_failures", test_failure_lines,    True),
        ("uncommitted",   uncommitted_lines,     True),
        ("edited",        edited_lines,          True),
        ("recent_commits", recent_branch_commit_lines, False),
        ("stale",         stale_lines,           False),
        ("most_accessed", most_accessed_lines,   False),
        ("session_goal",  session_goal_lines,    False),
        ("bash",          bash_lines,            False),
        ("what_worked",   what_worked_lines,     False),
        ("syms",          sym_lines,             _syms_protected),
        ("web",           web_lines,             False),
        ("glob",          glob_lines,            False),
        ("dep_changes",   dep_change_lines,      False),
        ("grep",          grep_lines,            False),
        # TODOs appear before the files sections so they survive last-resort line-popping:
        # the line-popper pops from the bottom of the assembled body, so higher
        # placement = later removal.  Protected=True means todos are never wholesale-dropped
        # by the priority-drop pass; the placement also protects them from the line-popper.
        # Pending tasks are higher-value pre-compact context than "files read" because
        # the task state is not embedded in conversation history and cannot be recovered
        # after a compact without re-querying the harness's task API.
        ("todos",         todo_lines,            True),
        # files_core: protected top-_TOP_FILES_GUARANTEED_MIN entries — always survive
        # files: remaining entries beyond the guarantee — dropped under pressure
        ("files_core",    files_core_lines,      True),
        ("files",         files_lines,           False),
        ("open_questions", open_questions_lines, False),
        ("active_errors", active_errors_lines,  False),
        ("skills",        skill_lines,           True),
    ]

    # ── Harness-specific section filtering ───────────────────────────────────
    # Different downstream AI harnesses care about different sections.  Apply
    # harness-level filtering BEFORE the noise floor and section-cap passes so
    # that suppressed sections consume no budget at all.
    #
    # claudecode (default): no changes — current behaviour unchanged.
    # codex: skills are not applicable (no skill system); skip skills + decisions.
    #         Bash history is more relevant to Codex workflows so it is kept.
    # opencode: inject a ``### harness: opencode`` tag into the header so
    #           opencode's context.push() machinery can detect and route the
    #           manifest; otherwise keep all sections.
    # generic: emit only the minimal set — sealed + header + edited + syms.
    #          Everything else is stripped to produce the safest possible output
    #          for unknown consumers.
    if harness == "codex":
        _section_groups = [
            (name, lines, prot)
            for name, lines, prot in _section_groups
            if name not in ("skills", "decisions")
        ]
        _LOG.debug("_render: codex harness — skipped skills and decisions sections")
    elif harness == "opencode":
        # Insert a harness tag as the second line of the header block so opencode's
        # context.push() machinery can detect and route the manifest correctly.
        _new_header = list(header_lines)
        _new_header.insert(1, "### harness: opencode")
        _section_groups = [
            (name, _new_header if name == "header" else lines, prot)
            for name, lines, prot in _section_groups
        ]
        _LOG.debug("_render: opencode harness — injected harness tag into header")
    elif harness == "generic":
        _GENERIC_KEEP: frozenset[str] = frozenset(
            ["sealed", "header", "uncommitted", "edited", "syms"]
        )
        _section_groups = [
            (name, lines, prot)
            for name, lines, prot in _section_groups
            if name in _GENERIC_KEEP
        ]
        _LOG.debug("_render: generic harness — keeping only minimal sections: %s", _GENERIC_KEEP)

    # ── Apply noise floor: drop small unprotected sections ───────────────────
    _section_groups = _apply_noise_floor(_section_groups, noise_floor_tokens)
    max_section_lines_cap = max_section_lines

    # ── Apply per-section line cap to prevent bloated sections dominating budget ─
    # The cap is applied AFTER directory-grouping so grouped lines count as 1 item.
    # Only apply to the four list-shaped sections; skip single-line sections and
    # protected sections (header, blockers, decisions, skills, uncommitted).
    if max_section_lines_cap > 0:
        for idx, (_name, _lines, _protected) in enumerate(_section_groups):
            if not _protected and _name in ("edited", "files", "syms"):
                _section_groups[idx] = (_name, _apply_section_line_cap(_lines, max_section_lines_cap), _protected)

    sections: list[str] = []
    for _name, _lines, _ in _section_groups:
        sections.extend(_lines)
    # #22: When only one marker kind appears the verbose "Legend: key=symbol"
    # prefix is self-evident — drop the "Legend: " label to save ~3-5 tokens.
    # With two or more kinds the full legend is a useful key, so keep the prefix.
    legend_line: str | None = None
    if len(legend_parts) == 1:
        legend_line = legend_parts[0]
    elif len(legend_parts) >= 2:
        legend_line = "Legend: " + "  ".join(legend_parts)
    if legend_line is not None:
        sections.append(legend_line)

    # ── Common prefix stripping — save tokens by detecting shared path prefixes ─
    path_lines = [line for line in sections if _extract_path_from_line(line) is not None]
    paths_only = [p for line in path_lines if (p := _extract_path_from_line(line)) is not None]
    _applied_prefix: str | None = None
    if (
        len(path_lines) >= 3  # Worthwhile only with 3+ paths
        and len(paths_only) > 0
        and (common_prefix := _find_common_prefix(paths_only))
        and len(common_prefix) >= 6  # Prefix must be at least 6 chars to justify header
        and len(paths_only) >= int(len(path_lines) * 0.7)  # Must cover 70% of path lines
    ):
        sections = _strip_common_prefix_from_sections(sections, common_prefix)
        _applied_prefix = common_prefix

    # Item #21: StringIO write-buffer assembly — avoids the N-object intermediate
    # list copy that "\n".join() creates for the full manifest string.
    _buf = io.StringIO()
    for _sec_line in sections:
        _buf.write(_sec_line)
        _buf.write("\n")
    result = _buf.getvalue().rstrip()
    token_count = estimate_tokens(result)
    _LOG.debug(
        "_render: manifest assembled for session=%s; ~%d tokens (budget=%d) "
        "sym=%d bash=%d web=%d glob=%d grep=%d files=%d",
        session_id[:8], token_count, max_tokens,
        sym_used, bash_used, web_used, glob_used, grep_used, files_used,
    )

    # ── Safety net: priority-aware section truncation ────────────────────────
    # Per-section budgets use _token_count (len//4, conservative) while
    # estimate_tokens uses (len//3 + 1), slightly more generous.  In rare cases
    # the assembled total can still exceed max_tokens by a few tokens.
    #
    # Strategy: for each droppable section in priority order, first try
    # truncating it to 3 items (keeping the header + a "+N more" tail) before
    # wholesale-dropping it.  This preserves the section header — which tells
    # the compaction LLM that the section *exists* — while recovering most of
    # the token cost.  Only if truncation is still over budget do we remove the
    # section entirely.
    #
    # Drop order (lowest signal → highest):
    #   open_questions → active_errors → session_goal → files → grep → glob
    #   → web → syms → what_worked → dep_changes → bash → stale
    # Protected sections (sealed, header, blockers, decisions, skills,
    # uncommitted, edited, todos) and the legend are never wholesale-dropped —
    # they carry the highest post-compact recovery signal.  As a final fallback when
    # wholesale drops are exhausted, the tail is line-trimmed but the legend
    # (last line) is pinned in place so marker explanations always survive.
    if token_count > max_tokens:
        _LOG.info(
            "_render: safety trim for session=%s (%d tokens > %d budget)",
            session_id[:8], token_count, max_tokens,
        )

        def _assemble(live_groups: list[tuple[str, list[str], bool]]) -> str:
            """Rebuild the manifest string from *live_groups*, applying the same
            common-prefix stripping that was applied to the original assembly."""
            body: list[str] = []
            for _name, _lines, _ in live_groups:
                body.extend(_lines)
            if legend_line is not None:
                body.append(legend_line)
            if _applied_prefix:
                body = _strip_common_prefix_from_sections(body, _applied_prefix)
            return "\n".join(body).rstrip()

        def _truncate_section_lines(lines: list[str], keep_items: int = 3) -> list[str]:
            """Return *lines* truncated to *keep_items* bullet items plus a "+N more" tail.

            The first line is treated as the section header and is always kept.
            When there are *keep_items* or fewer bullet lines the original list
            is returned unchanged (nothing to gain from truncation).

            A "+N more" suffix line is appended so the compaction LLM knows the
            section has additional entries it can recover on demand.
            """
            if len(lines) <= keep_items + 1:  # header + keep_items
                return lines
            item_lines = lines[1:]  # lines after the header
            hidden = len(item_lines) - keep_items
            if hidden <= 0:
                return lines
            return [lines[0]] + item_lines[:keep_items] + [f"- ... (+{hidden} more)"]

        # How many items to keep when truncating a section before wholesale drop.
        _SECTION_TRUNCATE_KEEP: int = 3

        # All unprotected section names in lowest-signal-first order.
        # Sections omitted here fall through to the destructive line-popping
        # fallback, which is much blunter — always list every unprotected section.
        # Drop order rationale:
        #   open_questions — cheapest to recover (grep edited files)
        #   active_errors  — small, recoverable from bash history
        #   session_goal   — inferred; other sections imply the same intent
        #   files          — read-only context, implied by syms
        #   grep           — investigation history
        #   glob           — directory scan history
        #   web            — reference material URLs
        #   most_accessed  — symbol access counts, secondary signal
        #   recent_commits — git context, recoverable via `git log`
        #   syms           — symbol details per file
        #   what_worked    — curated "tests were green" pointer
        #   dep_changes    — recoverable from `git diff`
        #   bash           — work context (high value, drop late)
        #   stale          — outdated snapshot warnings (small, kept late)
        # Note: "todos" is NOT in this list because it is protected (True) in
        # _section_groups — the compaction LLM must see active tasks so it knows
        # what work is still pending after the compact.
        _droppable_names_in_drop_order = [
            "open_questions", "active_errors", "session_goal",
            "files", "grep", "glob", "web",
            "most_accessed", "recent_commits",
            "syms", "what_worked", "dep_changes", "bash", "stale",
        ]
        _live_groups = list(_section_groups)
        _solved = False
        for _drop_name in _droppable_names_in_drop_order:
            # Respect the protected flag: a group explicitly marked protected (e.g. the wide-session map-pointer) must survive the safety trim even though its name appears in the droppable list for its unprotected variant (large per-file symbol listings).
            _named = next(((n, _l, _p) for (n, _l, _p) in _live_groups if n == _drop_name), None)
            if _named is not None and _named[2]:
                continue
            # Phase 1: try truncating the section to 3 items before dropping.
            _truncate_idx = next(
                (i for i, (n, _l, _p) in enumerate(_live_groups) if n == _drop_name),
                -1,
            )
            if _truncate_idx >= 0:
                _orig_name, _orig_lines, _orig_protected = _live_groups[_truncate_idx]
                _truncated_lines = _truncate_section_lines(_orig_lines, _SECTION_TRUNCATE_KEEP)
                if len(_truncated_lines) < len(_orig_lines):
                    _trial_groups = list(_live_groups)
                    _trial_groups[_truncate_idx] = (_orig_name, _truncated_lines, _orig_protected)
                    _trial_text = _assemble(_trial_groups)
                    if estimate_tokens(_trial_text) <= max_tokens:
                        _live_groups = _trial_groups
                        result = _trial_text
                        _solved = True
                        _LOG.info(
                            "_render: safety trim truncated section=%s to %d items (session=%s)",
                            _drop_name, _SECTION_TRUNCATE_KEEP, session_id[:8],
                        )
                        break
                    _LOG.debug(
                        "_render: safety trim truncation of section=%s still over budget, will drop",
                        _drop_name,
                    )

            # Phase 2: wholesale-drop the section.
            _live_groups = [
                (n, lns, p) for (n, lns, p) in _live_groups if n != _drop_name
            ]
            _candidate_text = _assemble(_live_groups)
            if estimate_tokens(_candidate_text) <= max_tokens:
                result = _candidate_text
                _solved = True
                _LOG.info(
                    "_render: safety trim dropped section=%s (session=%s)",
                    _drop_name, session_id[:8],
                )
                break
            _LOG.debug(
                "_render: safety trim dropped section=%s, still over budget",
                _drop_name,
            )
        if not _solved:
            # All droppable sections gone and still over budget.  Fall back
            # to bottom line-popping on what remains, but pin the legend so
            # marker explanations survive (they explain markers still in
            # the body — losing the legend leaves orphan symbols).
            # Pop floor: never trim below sealed + header lines so the
            # non-negotiable framing and MUST_PRESERVE markers always survive.
            # (The edited section is protected from wholesale-drop above; if
            # the budget is so tight that even protected sections can't fit,
            # line-popping of lower-priority protected content is unavoidable.)
            _pop_floor_names = {"sealed", "header"}
            _pop_floor = sum(
                len(_lines)
                for _name, _lines, _ in _live_groups
                if _name in _pop_floor_names
            )
            _pop_floor = max(3, _pop_floor)
            # Pin the protected wide-session map-pointer (cheap, single high-value line) like the legend so the popper sheds large protected detail (e.g. edited file lines, where only the header must survive) before this pointer. Pulled out of the popped body and re-appended below it.
            _pinned_lines: list[str] = []
            _body_lines: list[str] = []
            for _name, _lines, _prot in _live_groups:
                if _name == "syms" and _prot:
                    _pinned_lines.extend(_lines)
                else:
                    _body_lines.extend(_lines)
            _legend_suffix = [legend_line] if legend_line is not None else []
            _pinned_suffix = _pinned_lines + _legend_suffix
            _trimmed = _body_lines[:]
            while len(_trimmed) > _pop_floor and estimate_tokens(
                "\n".join(
                    _strip_common_prefix_from_sections(
                        _trimmed + _pinned_suffix, _applied_prefix,
                    ) if _applied_prefix else _trimmed + _pinned_suffix
                )
            ) > max_tokens:
                _trimmed.pop()
            _final = _trimmed + _pinned_suffix
            if _applied_prefix:
                _final = _strip_common_prefix_from_sections(_final, _applied_prefix)
            result = "\n".join(_final).rstrip()

    final_tokens = estimate_tokens(result)
    _LOG.debug(
        "_render: final manifest for session=%s; %d tokens (budget=%d, trimmed=%s)",
        session_id[:8], final_tokens, max_tokens, str(token_count > max_tokens),
    )
    return result, files_with_symbols_count
