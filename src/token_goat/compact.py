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
    "event_count",
    "is_noise_path",
]

import heapq
import logging
import math
import subprocess
import time
from collections.abc import Callable
from datetime import UTC, datetime
from operator import attrgetter, itemgetter
from typing import TYPE_CHECKING, Any, Final

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
_FULL_READ_SENTINEL_GAP: Final[int] = session_mod._UNKNOWN_END_SENTINEL

# Files read this many times or more are "hot" — the model knows them intimately.
# Listing them individually wastes manifest lines on content the compaction LLM
# would never evict. Consolidate to a single summary line instead.
_HOT_FILE_READ_THRESHOLD: Final[int] = 5

# Maximum number of hot files shown by name in the consolidated summary line.
# Beyond this, a "+N more" suffix is appended so the line stays compact.
_HOT_FILE_MAX_SHOWN: Final[int] = 6

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
    "/appdata/local/temp/", "/appdata/roaming/",
    "/tmp/",  # Unix temp dir — ephemeral files (improve_commit_msg, etc.)
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
    # Basename prefix checks: ephemeral state files from automation tools.
    if basename.startswith(".improve-state-") or basename.startswith("improve_commit_msg_"):
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

    try:
        # Run git diff --stat HEAD for the given files
        result = subprocess.run(
            ["git", "diff", "--stat", "HEAD", "--"] + edited_paths,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
        )

        # Only use output if git succeeded
        if result.returncode != 0:
            _LOG.debug(
                "_get_git_diff_stat: git diff failed with code %d (cwd=%s)",
                result.returncode,
                cwd,
            )
            return None

        if not result.stdout.strip():
            _LOG.debug("_get_git_diff_stat: git diff returned empty output")
            return None

        # Split into lines and filter out summary line (contains "file changed")
        all_lines = result.stdout.strip().splitlines()
        diff_lines = [
            line for line in all_lines
            if "file changed" not in line.lower() and "insertion" not in line.lower()
        ]

        if not diff_lines:
            _LOG.debug("_get_git_diff_stat: no diff lines after filtering summary")
            return None

        # Truncate to 8 lines
        lines = diff_lines[:8]
        output = "\n".join(lines)

        # Cap total output at 200 chars
        if len(output) > 200:
            output = output[:200].rsplit("\n", 1)[0]  # Backtrack to last newline

        return output
    except FileNotFoundError:
        _LOG.debug("_get_git_diff_stat: git not found")
        return None
    except subprocess.TimeoutExpired:
        _LOG.debug("_get_git_diff_stat: git diff timed out (>2s)")
        return None
    except Exception as e:  # noqa: BLE001
        _LOG.debug("_get_git_diff_stat: error running git diff: %s", e)
        return None


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
    try:
        # Run git diff --stat HEAD to see tracked file changes with +/- counts.
        diff_result = subprocess.run(
            ["git", "diff", "--no-color", "--stat", "HEAD"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        diff_lines: list[str] = []
        if diff_result.returncode == 0 and diff_result.stdout.strip():
            diff_lines = [
                line.rstrip()
                for line in diff_result.stdout.strip().splitlines()
                if line.strip()
            ]

        # Run git status --short to catch untracked (??) and staged files not
        # reflected in diff --stat HEAD (e.g. new files added to the index).
        status_result = subprocess.run(
            ["git", "status", "--short"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        status_lines: list[str] = []
        if status_result.returncode == 0 and status_result.stdout.strip():
            status_lines = [
                line.rstrip()
                for line in status_result.stdout.strip().splitlines()
                if line.strip()
            ]

        if not diff_lines and not status_lines:
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
            return None

        # Truncate to 8 lines and cap total chars at 200.
        lines = combined[:8]
        output = "\n".join(lines)
        if len(output) > 200:
            output = output[:200].rsplit("\n", 1)[0]
        return output if output.strip() else None
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
        from pathlib import Path as _Path  # noqa: PLC0415
        root_str = str(_Path(root)) if not isinstance(root, str) else root
        result = subprocess.run(
            ["git", "diff", "--no-color", "--stat", "HEAD"],
            cwd=root_str,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return ""
        lines = result.stdout.strip().splitlines()
        # Keep at most 6 lines (last 5 file-stat lines + the summary line which is last).
        # git --stat outputs file lines first then a summary line at the end; taking the
        # last 6 lines captures the summary and up to 5 file entries.
        last6 = lines[-6:]
        output = "\n".join(last6)
        # Hard cap: if still too long, drop the manifest section entirely rather than
        # truncating mid-line (a partial diff stat is misleading).
        if len(output) > 300:
            return ""
        return output
    except Exception:  # noqa: BLE001
        return ""


def _get_session_commits(cwd: str | None, session_start_ts: float) -> list[str]:
    """Return git log lines for commits made after session_start_ts.

    Returns at most 5 commits, formatted as "- {short_hash} {subject}".
    Returns [] when git is unavailable, not in a repo, or cwd is None.
    Times out after 2 seconds.
    """
    if not cwd or session_start_ts <= 0:
        return []
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", f"--since={int(session_start_ts)}", "--max-count=5"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return []
        lines = result.stdout.strip().splitlines()
        return [f"- {sanitize_log_str(line, max_len=100)}" for line in lines[:5]]
    except Exception:  # noqa: BLE001
        return []


def _count_suffix(n: int) -> str:
    """Return '  ×N' when *n* > 1, or '' when the count is unremarkable.

    Used in the manifest to annotate files edited or read multiple times without
    cluttering single-occurrence entries.
    """
    return f"  ×{n}" if n > 1 else ""


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


def _extract_path_from_line(line: str) -> str | None:
    """Extract the path string from a manifest line if it contains one.

    Recognizes lines with path-bearing markers: '- ✎ ', '- → ', '- ⚠ ', '- ❄ ',
    and plain symbol lines '- '.  Returns the path token (first non-empty token
    after the marker) or None if the line doesn't contain a path.

    Examples:
        "- ✎ token_goat/compact.py  ×2" → "token_goat/compact.py"
        "- → token_goat/hints.py  lines 1-100" → "token_goat/hints.py"
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

    result = []
    session_line_idx = -1

    # Find the session line and copy header lines
    for i, line in enumerate(sections):
        result.append(line)
        if line.startswith("Session: "):
            session_line_idx = i
            break

    # Insert the prefix note after the session line
    if session_line_idx >= 0:
        result.insert(session_line_idx + 1, f"Paths: {common_prefix} (stripped)")

    # Process remaining lines, stripping prefix from path-bearing lines
    for i in range(session_line_idx + 1 if session_line_idx >= 0 else 0, len(sections)):
        line = sections[i]
        path = _extract_path_from_line(line)
        if path and path.startswith(common_prefix):
            # Reconstruct the line with the prefix stripped
            # Extract the marker and rest of the line
            if line.startswith("- "):
                rest = line[2:]
                marker = ""
                if rest and rest[0] in ("✎", "→", "⚠", "❄"):
                    marker = rest[0]
                    rest = rest[1:].lstrip()
                else:
                    rest = rest.lstrip()

                # Remove old path and build new one
                parts = rest.split(None, 1)
                new_path = path[len(common_prefix):]
                tail = f" {parts[1]}" if len(parts) > 1 else ""
                if marker:
                    result.append(f"- {marker} {new_path}{tail}")
                else:
                    result.append(f"- {new_path}{tail}")
            else:
                result.append(line)
        else:
            result.append(line)

    return result


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
    for pattern in ("git status", "git diff --stat", "git log"):
        if cmd_lower.startswith(pattern):
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
        and e.exit_code != 0  # type: ignore[union-attr]
        and getattr(e, "ts", 0.0) >= cutoff
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_BLOCKER_ENTRIES, candidates, key=_BY_BASH_TS)


def _format_blocker_entry(entry: object) -> str:
    """Render one failed :class:`session.BashEntry` as a "Current Blockers" line.

    Format::

        - ✗ pytest tests/  (exit 1)
        - ✗ make build  (exit 2)

    Kept deliberately terse — the compaction LLM only needs to know *what*
    failed and *how* (exit code), not the full output size or cache ID.  The
    agent can retrieve details via ``token-goat bash-output <id>`` if needed.
    """
    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    exit_code = getattr(entry, "exit_code", "?")
    return f"- ✗ {cmd_preview}  (exit {exit_code})"


def _select_top_bash_entries(bash_history: object) -> list[object]:
    """Pick up to :data:`_MAX_BASH_ENTRIES` cached Bash runs worth surfacing.

    Filters out entries below :data:`_MIN_BASH_BYTES_FOR_MANIFEST` (the dedup
    hint would suppress them anyway), no-op commands (git status, pwd, etc.),
    and ranks by recency — the most recent runs are the ones whose output drives
    the next agent turn.  Accepts the ``bash_history`` attribute typed as
    ``object`` so the helper is safe to call on legacy SessionCache instances
    written by token-goat versions that predate the field (``None`` / missing →
    empty list).

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
        and not _is_noop_bash_command(e)
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


def _select_top_web_entries(web_history: object) -> list[object]:
    """Pick up to :data:`_MAX_WEB_ENTRIES` web fetches worth surfacing in the manifest.

    Filters entries below :data:`_MIN_WEB_BYTES_FOR_MANIFEST` (tiny redirects
    and empty responses provide no recoverable context) and ranks by recency —
    the most recently fetched pages are the ones whose content is most likely
    to drive the next agent turn.

    Accepts ``web_history`` typed as ``object`` to remain safe on legacy
    SessionCache instances that predate the field (``None`` / missing → empty list).
    Entries are :class:`session.WebEntry` instances accessed via :func:`getattr`.
    """
    if not isinstance(web_history, dict) or not web_history:
        return []
    candidates = [
        e for e in web_history.values()
        if getattr(e, "body_bytes", 0) >= _MIN_WEB_BYTES_FOR_MANIFEST
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_WEB_ENTRIES, candidates, key=lambda e: getattr(e, "ts", 0.0))


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
    truncated_marker = " (truncated)" if getattr(entry, "truncated", False) else ""
    status_str = str(status_code) if status_code is not None else "?"
    return (
        f"- 🌐 {url_preview}  "
        f"({status_str}, {_humanize_bytes(body_bytes)}{truncated_marker}, id={output_id})"
    )


def _token_count(text: str) -> int:
    """Rough token estimate: 1 token ≈ 4 characters.

    Used for per-section budget enforcement inside :func:`_render`.  The same
    ratio is used by :func:`~token_goat.repomap.estimate_tokens` (which divides
    by 3.5); using 4 here makes section budgets slightly conservative so the
    assembled manifest fits the global budget even before the final
    ``estimate_tokens`` check.
    """
    return len(text) // 4


def _section_budgets(total_budget: int, edited_tokens: int) -> dict[str, int]:
    """Distribute the manifest token budget across variable sections.

    The edited-files section is must-preserve and gets its full allocation first.
    The remaining budget is split proportionally:

        - ``symbols``  — 40 %
        - ``files``    — 30 %
        - ``greps``    — 15 %
        - ``bash``     — 15 %

    Every section is guaranteed at least *_MIN_SECTION_TOKENS* tokens so that a
    section with a very tight budget still renders at least one line.

    Args:
        total_budget:  The global token ceiling for the entire manifest.
        edited_tokens: Token estimate for the already-rendered edited-files block
                       (header + file lines + diff stat + commits).  This is
                       subtracted from *total_budget* before distribution.

    Returns:
        A dict with keys ``"symbols"``, ``"files"``, ``"greps"``, ``"bash"``
        mapping to their respective token budgets.
    """
    _MIN_SECTION_TOKENS = 20
    remaining = max(0, total_budget - edited_tokens)

    # Proportions must sum to 1.0.
    proportions: dict[str, float] = {
        "symbols": 0.40,
        "files":   0.25,
        "greps":   0.15,
        "bash":    0.10,
        "web":     0.10,
    }
    budgets: dict[str, int] = {}
    for name, ratio in proportions.items():
        budgets[name] = max(_MIN_SECTION_TOKENS, int(remaining * ratio))
    return budgets


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


def compute_adaptive_budget(
    cache: SessionCache,
    age_seconds: float = 0.0,
    *,
    has_pending_diff: bool = False,
    has_uncommitted_changes: bool = False,
) -> int:
    """Compute an adaptive token budget for the manifest based on session complexity.

    Simple sessions (few edits, no bash history) waste no budget; complex sessions
    get more room to preserve signal.  Formula:

        Base: 200 tokens
        + min(200, edited_files_count × 50)       [up to 4 files]
        + min(150, symbols_accessed_files × 30)   [up to 5 files with symbols]
        + 20 tokens if bash_history has entries
        + 50 tokens if there are pending git changes (git diff --stat HEAD non-empty)
        + 10 tokens if there are uncommitted changes (git diff/status non-empty)
        × tier multiplier (young=0.6, active=1.0, mature=1.4)
        Capped to [200, 800]

    *age_seconds* is the session age in seconds.  When omitted (or 0) the session
    is treated as young.  Pass ``time.time() - cache.created_ts`` at call sites
    that have the cache in hand.

    *has_pending_diff* should be ``True`` when ``_get_git_diff_stat_summary()``
    returned a non-empty string for this session's working directory.  Adds 50
    tokens to account for the "Pending Changes" section in the manifest.

    *has_uncommitted_changes* should be ``True`` when ``_get_uncommitted_changes()``
    returned a non-empty string.  Adds 10 tokens to account for the
    "Uncommitted Changes" section in the manifest.

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

    raw_total = base + edited_bonus + symbols_bonus + bash_bonus + web_bonus + diff_bonus + uncommitted_bonus

    # Apply session-age tier multiplier: young sessions need less manifest space
    # (little context has accumulated); mature sessions need more.
    tier = _session_age_tier(age_seconds)
    tier_factors = {"young": 0.6, "active": 1.0, "mature": 1.4}
    factor = tier_factors[tier]
    total = int(round(raw_total * factor))

    return max(min_total, min(max_total, total))


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
    budget = compute_adaptive_budget(
        cache,
        age_seconds=age_seconds,
        has_pending_diff=bool(pending_diff),
        has_uncommitted_changes=bool(uncommitted),
    )
    _LOG.debug(
        "build_manifest_adaptive: session=%s budget=%d tier=%s (edited=%d symbols=%d bash=%s web=%s diff=%s uncommitted=%s)",
        session_id[:8],
        budget,
        _session_age_tier(age_seconds),
        len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0,
        sum(1 for e in cache.files.values() if e.symbols_read),
        bool(getattr(cache, "bash_history", None) and cache.bash_history),
        bool(getattr(cache, "web_history", None) and cache.web_history),
        bool(pending_diff),
        bool(uncommitted),
    )
    return _build_manifest_from_cache(cache, session_id, budget)


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
    n_events = (
        len(cache.files)
        + len(cache.greps)
        + len(cache.edited_files)
        + len(getattr(cache, "bash_history", {}) or {})
    )
    manifest = _build_manifest_from_cache(cache, session_id, max_tokens)
    return manifest, n_events


def _render_section(
    header: str,
    entries: list[Any],
    fmt: Callable[[Any], str],
) -> list[str]:
    """Render a manifest section as a list of lines.

    Returns an empty list when *entries* is empty (so the caller can safely
    concatenate with ``+`` without adding a blank section).  Lines produced by
    *fmt* that are themselves empty strings are silently skipped.

    This covers the common section shape::

        ### Header
        - line_1
        - line_2

    Sections with token-budget loops, sub-sections, or non-trivial formatting
    keep their own inline implementation in :func:`_render`.
    """
    if not entries:
        return []
    lines: list[str] = [f"### {header}"]
    for entry in entries:
        line = fmt(entry)
        if line:
            lines.append(line)
    return lines


def _render(cache: SessionCache, session_id: str, max_tokens: int) -> tuple[str, int]:
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
    2. **Bash history** — cached command outputs; the current work context.
       Capped at 15 % of remaining budget.
    3. **Symbols accessed** — files where specific symbols were read via ``token-goat read``.
       Ranked by ``last_read_ts`` (most-recent first), capped at 40 % of remaining budget.
    4. **Web fetches** — reference material loaded mid-session, capped at 10 %.
    5. **Grep history** — recent search patterns, capped at 15 % of remaining budget.
    6. **Key files read** — top files by ``read_count`` (most re-read first), capped at 30 %.

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
    # edited_files covers writes; files covers reads; greps covers searches;
    # bash_history covers commands run.  All four empty → just a header → not worth injecting.
    raw_greps = getattr(cache, "greps", None) or []
    _raw_bash = getattr(cache, "bash_history", None)
    raw_bash: dict = _raw_bash if isinstance(_raw_bash, dict) else {}
    _raw_web = getattr(cache, "web_history", None)
    raw_web: dict = _raw_web if isinstance(_raw_web, dict) else {}
    if not edited_clean and not files_clean and not raw_greps and not raw_bash and not raw_web:
        _LOG.info(
            "_render: manifest suppressed for session=%s "
            "(no activity tracked: edited=0 files_read=0 greps=0 bash=0)",
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
        if key.replace("\\", "/").lower() not in edited_keys
    ]
    # Files that are also in edited_files (path key match) get an edit_bonus even
    # when they appear in key_files_candidates — this handles the case where a file
    # was both read and edited but its edit-section entry predates the re-read so it
    # wasn't deduplicated into edited_keys.  Normalized key lookup for robustness.
    edited_keys_set = edited_keys  # already a set of normalized lower/forward-slash keys
    # Mature sessions (> 60 min) get 2 extra key-file slots: more context has
    # accumulated and the compaction LLM benefits from a broader file picture.
    max_key_files = _MAX_FILES_READ + (2 if age_tier == "mature" else 0)
    top_files = heapq.nlargest(
        max_key_files,
        key_files_candidates,
        key=lambda e: _importance_score(
            e,
            now_for_scoring,
            edit_bonus=15.0 if e.rel_or_abs.replace("\\", "/").lower() in edited_keys_set else 0.0,
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

    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M")
    sid = session_id[:8]
    age_str = _format_duration(age_secs) if age_secs >= 60 else None
    age_part = f"  |  age: {age_str}" if age_str else ""
    header_lines: list[str] = [
        "## Token-Goat Session Manifest",
        f"Session: {sid}  |  {now}{age_part}",
    ]

    # Get cwd early so it can be used by both diff summary and commits section.
    cwd = getattr(cache, "cwd", None)
    created_ts = getattr(cache, "created_ts", 0.0)

    # ── 0. Current Blockers — failed commands from the last 60 min ───────────
    # Built before everything else so it appears at the top of the manifest.
    # Young sessions are included here too — a failure is critical regardless of age.
    now_ts_for_blockers = time.time()
    blocker_entries = _select_failed_bash_entries(raw_bash, now_ts_for_blockers)
    blocker_lines = _render_section("Current Blockers", blocker_entries, _format_blocker_entry)

    # ── 0b. Uncommitted Changes — git diff --stat + status --short ───────────
    # Ground-truth picture of what's on disk regardless of which tool made the
    # changes.  Shown before Files Edited so the compaction LLM sees both the
    # Claude-tool-tracked edits and any manual changes in one pass.
    # Budget: ~40 tokens / ~200 chars max for the content; not counted against
    # the adaptive per-section budget (it's additional fixed context).
    uncommitted_changes: str | None = _get_uncommitted_changes(cwd)
    uncommitted_lines: list[str] = []
    if uncommitted_changes:
        uncommitted_lines.append("### Uncommitted Changes")
        for line in uncommitted_changes.splitlines():
            uncommitted_lines.append(f"  {line.rstrip()}")

    # ── 1. Edited files — highest priority (no cap) ───────────────────────────
    # Build the entire edited-files block first so we can measure its token cost
    # before allocating the remaining budget to variable sections.
    edited_lines: list[str] = []
    # Run the whole-repo git diff --stat once here so both the "Pending Changes"
    # section and the adaptive budget computation can use the cached result.
    pending_diff_stat: str = _get_git_diff_stat_summary(cwd)

    if edited_clean:
        edited_lines.append("### Files Edited (preserve in summary)")
        # Sort by edit count descending so the most-touched files appear first.
        for path, count in sorted(edited_clean.items(), key=_BY_EDIT_COUNT, reverse=True):
            edited_lines.append(f"- ✎ {_short_path(path)}{_count_suffix(count)}")

        # ── 1a. Pending Changes (git diff --stat HEAD) ────────────────────────
        # Whole-repo stat placed immediately after Files Edited so the compaction
        # LLM sees the scope and magnitude of in-flight work alongside the list of
        # edited files.  Omitted entirely when there are no uncommitted changes.
        if pending_diff_stat:
            edited_lines.append("### Pending Changes (git diff --stat)")
            for line in pending_diff_stat.splitlines():
                edited_lines.append(f"  {line}")

        # ── 1b. Diff summary — show git changes for edited files ──────────────
        diff_stat = _get_git_diff_stat(list(edited_clean.keys()), cwd)
        if diff_stat:
            edited_lines.append("### Diff Summary")
            for line in diff_stat.splitlines():
                edited_lines.append(f"- {line}")

        # ── 1b. Commits this session ──────────────────────────────────────────
        if created_ts > 0:
            session_commits = _get_session_commits(cwd, created_ts)
            if session_commits:
                edited_lines.append("### Commits This Session")
                edited_lines.extend(session_commits)

    # ── 1d. Stale file snapshots ──────────────────────────────────────────────
    stale_lines = _render_section(
        "Outdated File Snapshots",
        stale_read_files[:6],
        lambda path: f"- ⚠ {_short_path(path)}",
    )

    # Measure the "fixed" cost (header + blockers + uncommitted + edited + stale)
    # to derive per-section budgets.  Blocker lines are small (≤3 lines) so they
    # rarely consume more than ~15 tokens, but we count them to keep the budget
    # accurate.  The uncommitted-changes section is additional fixed context and
    # is not counted against any per-section proportional budget.
    fixed_text = "\n".join(header_lines + blocker_lines + uncommitted_lines + edited_lines + stale_lines)
    fixed_tokens = _token_count(fixed_text)
    sec_budgets = _section_budgets(max_tokens, fixed_tokens)
    _LOG.debug(
        "_render: fixed_tokens=%d  section_budgets=%s  (session=%s)",
        fixed_tokens, sec_budgets, session_id[:8],
    )

    # ── 2. Symbols accessed — up to 40 % of remaining budget ─────────────────
    sym_budget = sec_budgets["symbols"]
    sym_lines: list[str] = []
    sym_used = 0
    if files_with_symbols:
        header = "### Symbols Accessed"
        header_cost = _token_count(header)
        sym_entries_for_section: list[str] = []
        for entry in files_with_symbols:
            syms = [sanitize_log_str(s, max_len=80) for s in entry.symbols_read[:_MAX_SYMBOLS_PER_FILE_ENTRY]]
            overflow = len(entry.symbols_read) - _MAX_SYMBOLS_PER_FILE_ENTRY
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "")
            line = f"- {_short_path(entry.rel_or_abs)} → {sym_str}"
            cost = _token_count(line)
            if sym_used + header_cost + cost <= sym_budget:
                sym_entries_for_section.append(line)
                sym_used += cost
            else:
                break
        # Only emit header if we have entries to show
        if sym_entries_for_section:
            sym_lines.append(header)
            sym_lines.extend(sym_entries_for_section)
            sym_used += header_cost

    # ── 3. Bash history — up to 15 % of remaining budget ─────────────────────
    # (built before files so bash is never crowded out by the files section)
    # Young sessions (< 10 min) skip bash/web sections: few commands have run
    # and the overhead of listing them is not worth it relative to the budget.
    bash_budget = sec_budgets["bash"]
    bash_lines: list[str] = []
    bash_used = 0

    bash_entries = (
        _select_top_bash_entries(getattr(cache, "bash_history", None))
        if age_tier != "young"
        else []
    )
    if bash_entries:
        header = "### Commands Run (cached output)"
        header_cost = _token_count(header)
        bash_entries_for_section: list[str] = []
        for be in bash_entries:
            line = _format_bash_entry(be)
            cost = _token_count(line)
            if bash_used + header_cost + cost <= bash_budget:
                bash_entries_for_section.append(line)
                bash_used += cost
            else:
                break
        # Only emit header if we have entries to show
        if bash_entries_for_section:
            bash_lines.append(header)
            bash_lines.extend(bash_entries_for_section)
            bash_used += header_cost

    # Cold outputs are grouped with bash history (same budget slice).
    # Skip for young sessions — same rationale as bash_entries above.
    now_ts = time.time()
    bash_hist_raw = getattr(cache, "bash_history", None) or {} if age_tier != "young" else {}
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
        cold_header = "### Cold Outputs (evict — recall via `token-goat bash-output <id>`)"
        cold_header_cost = _token_count(cold_header)
        if bash_used + cold_header_cost <= bash_budget:
            bash_lines.append(cold_header)
            bash_used += cold_header_cost
            for be in cold_candidates[:_MAX_COLD_OUTPUTS]:
                age_min = int((now_ts - getattr(be, "ts", now_ts)) / 60)
                total = getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
                oid = sanitize_log_str(getattr(be, "output_id", "?"), max_len=24)
                prev = sanitize_log_str(getattr(be, "cmd_preview", "?"), max_len=60)
                line = f"- ❄ `{prev}` ({_humanize_bytes(total)}, {age_min}min old) `{oid}`"
                cost = _token_count(line)
                if bash_used + cost > bash_budget:
                    break
                bash_lines.append(line)
                bash_used += cost
                cold_outputs.append(be)
            dropped_cold = len(cold_candidates) - len(cold_outputs)
            if dropped_cold > 0 and bash_used < bash_budget:
                overflow_line = f"- …+{dropped_cold} more cold outputs"
                if bash_used + _token_count(overflow_line) <= bash_budget:
                    bash_lines.append(overflow_line)

    # ── 3b. Web fetches — up to 10 % of remaining budget ─────────────────────
    # Young sessions skip web sections — same rationale as bash_entries above.
    web_budget = sec_budgets["web"]
    web_lines: list[str] = []
    web_used = 0
    web_entries = (
        _select_top_web_entries(raw_web)
        if age_tier != "young"
        else []
    )
    if web_entries:
        header = "### Web Fetches (cached body)"
        header_cost = _token_count(header)
        web_entries_for_section: list[str] = []
        for we in web_entries:
            line = _format_web_entry(we)
            cost = _token_count(line)
            if web_used + header_cost + cost <= web_budget:
                web_entries_for_section.append(line)
                web_used += cost
            else:
                break
        # Only emit header if we have entries to show
        if web_entries_for_section:
            web_lines.append(header)
            web_lines.extend(web_entries_for_section)
            web_used += header_cost

    # ── 4. Grep patterns — up to 15 % of remaining budget ────────────────────
    grep_budget = sec_budgets["greps"]
    grep_lines: list[str] = []
    grep_used = 0
    grep_entries = _select_top_grep_entries(raw_greps)
    if grep_entries:
        header = "### Patterns Searched"
        header_cost = _token_count(header)
        grep_entries_for_section: list[str] = []
        included_greps = 0
        for ge in grep_entries:
            line = _format_grep_entry(ge)
            cost = _token_count(line)
            if grep_used + header_cost + cost <= grep_budget:
                grep_entries_for_section.append(line)
                grep_used += cost
                included_greps += 1
            else:
                break
        # Only emit header if we have entries to show
        if grep_entries_for_section:
            grep_lines.append(header)
            grep_lines.extend(grep_entries_for_section)
            grep_used += header_cost
            distinct_patterns = len({getattr(g, "pattern", "") for g in raw_greps})
            dropped_greps = distinct_patterns - included_greps
            if dropped_greps > 0:
                overflow_line = f"- …+{dropped_greps} more patterns"
                if grep_used + _token_count(overflow_line) <= grep_budget:
                    grep_lines.append(overflow_line)

    # ── 5. Key files read — up to 30 % of remaining budget ───────────────────
    files_budget = sec_budgets["files"]
    files_lines: list[str] = []
    files_used = 0
    included_top_files: list[object] = []

    if top_files:
        header = "### Key Files Read"
        header_cost = _token_count(header)
        files_entries_for_section: list[str] = []

        # Hot files (≥ threshold reads) get a single consolidated summary line.
        hot_files = [e for e in top_files if e.read_count >= _HOT_FILE_READ_THRESHOLD]
        normal_files = [e for e in top_files if e.read_count < _HOT_FILE_READ_THRESHOLD]

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
            if files_used + header_cost + cost <= files_budget:
                files_entries_for_section.append(hot_line)
                files_used += cost
                included_top_files.extend(shown)

        for entry in normal_files:
            ranges_str = _format_ranges(entry.line_ranges)
            line = f"- → {_short_path(entry.rel_or_abs)}{_count_suffix(entry.read_count)}{ranges_str}"
            cost = _token_count(line)
            if files_used + header_cost + cost > files_budget:
                break
            files_entries_for_section.append(line)
            files_used += cost
            included_top_files.append(entry)

        # Only emit header if we have entries to show
        if files_entries_for_section:
            files_lines.append(header)
            files_lines.extend(files_entries_for_section)
            files_used += header_cost

    # ── Legend — only list markers that actually appear above ─────────────────
    has_edit = bool(edited_clean)
    has_read = bool(included_top_files or sym_lines)
    has_stale = bool(stale_read_files)
    has_cold = bool(cold_outputs)
    legend_parts = []
    if has_edit:
        legend_parts.append("edited=✎")
    if has_read:
        legend_parts.append("read=→")
    if has_stale:
        legend_parts.append("stale=⚠")
    if has_cold:
        legend_parts.append("cold=❄")

    # Assemble the final manifest in inverted-pyramid order: most critical first
    # so that if the manifest is truncated mid-token the surviving content is
    # the highest-value information for the compaction LLM.
    #   0. Current Blockers  — active failures the agent must know about
    #   1. Files Edited       — ongoing work (must survive compaction)
    #   2. Bash history       — current work context (what was just run)
    #   3. Symbols accessed   — precise code read
    #   4. Web fetches        — reference material
    #   5. Grep patterns      — investigation history (least critical)
    #   6. Key files read     — broader context
    sections: list[str] = (
        header_lines
        + blocker_lines
        + uncommitted_lines
        + edited_lines
        + stale_lines
        + bash_lines
        + sym_lines
        + web_lines
        + grep_lines
        + files_lines
    )
    if legend_parts:
        sections.append("Legend: " + "  ".join(legend_parts))

    # ── Common prefix stripping — save tokens by detecting shared path prefixes ─
    path_lines = [line for line in sections if _extract_path_from_line(line) is not None]
    paths_only = [p for line in path_lines if (p := _extract_path_from_line(line)) is not None]
    if (
        len(path_lines) >= 3  # Worthwhile only with 3+ paths
        and len(paths_only) > 0
        and (common_prefix := _find_common_prefix(paths_only))
        and len(common_prefix) >= 6  # Prefix must be at least 6 chars to justify header
        and len(paths_only) >= int(len(path_lines) * 0.7)  # Must cover 70% of path lines
    ):
        sections = _strip_common_prefix_from_sections(sections, common_prefix)

    result = "\n".join(sections).rstrip()
    token_count = estimate_tokens(result)
    _LOG.debug(
        "_render: manifest assembled for session=%s; ~%d tokens (budget=%d) "
        "sym=%d bash=%d web=%d grep=%d files=%d",
        session_id[:8], token_count, max_tokens,
        sym_used, bash_used, web_used, grep_used, files_used,
    )

    # Safety net: per-section budgets use _token_count (len//4, conservative) while
    # estimate_tokens uses len/3.5 (slightly more generous).  In rare cases the
    # assembled total can still exceed max_tokens by a few tokens.  Trim from the
    # bottom (lowest-priority sections) to stay within the global ceiling.
    if token_count > max_tokens:
        _LOG.info(
            "_render: safety trim for session=%s (%d tokens > %d budget)",
            session_id[:8], token_count, max_tokens,
        )
        lines = result.splitlines()
        while len(lines) > 3 and estimate_tokens("\n".join(lines)) > max_tokens:
            lines.pop()
        result = "\n".join(lines)

    return result, files_with_symbols_count
