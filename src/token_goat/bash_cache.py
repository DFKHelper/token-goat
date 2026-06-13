"""Persistent store for cached Bash tool output.

Every PostToolUse(Bash) hook invocation records the command's stdout/stderr to a
short text file under ``data_dir() / "bash_outputs"`` keyed by a content-derived
ID.  Subsequent invocations of the same command in the same session can detect
the duplicate via :func:`session.lookup_bash_entry`, and agents can retrieve
sliced views of any cached output via the ``token-goat bash-output`` CLI.

Why a separate disk store (vs. session JSON):

* Bash output can be megabytes (build logs, test runs).  Inlining that into the
  session JSON would bloat every subsequent load/save round trip on the hot
  pre-read path.  Storing the bytes once on disk and only a short ID in the
  session keeps the session JSON cheap.

* The CLI retrieval path (``token-goat bash-output``) can stream the file
  directly without re-parsing JSON.

* Retention is simple to bound by total bytes: scan the directory, evict the
  oldest files until the cap is met.  No cross-session coordination is needed.

The store is intentionally fail-soft: any I/O error on write is logged and
swallowed so a hook never aborts because the cache is full or read-only.
"""
from __future__ import annotations

__all__ = [
    "DEFAULT_MAX_TOTAL_BYTES",
    "DEFAULT_MAX_FILE_COUNT",
    "DEFAULT_MIN_CACHE_BYTES",
    "DEFAULT_MAX_CACHE_BYTES",
    "OUTPUT_FILENAME_RE",
    "BashOutputMeta",
    "command_hash",
    "dir_state_fingerprint",
    "evict_old_entries",
    "find_cached_for_command",
    "get_recent_error_outputs",
    "git_state_fingerprint",
    "glob_hash",
    "grep_hash",
    "is_dir_listing_command",
    "is_env_probe_command",
    "is_git_immutable_command",
    "is_git_mutable_command",
    "store_grep_result",
    "load_grep_result",
    "load_output",
    "load_output_meta",
    "normalize_command_for_cache_key",
    "output_id_for",
    "read_sidecar",
    "sidecar_meta_path",
    "store_glob_result",
    "load_glob_result",
    "store_output",
    "write_sidecar",
]

import re
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    build_keyed_output_id,
    build_output_id,
    evict_cache_dir,
    get_cache_dir,
    list_cache_outputs,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    path_mtime_key,
    safe_cache_op,
    safe_join_output_id,
    short_content_hash,
    sidecar_path_for,
    store_blob,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str
from .util import get_logger, normalize_path, strip_ansi

_LOG = get_logger("bash_cache")

# Total byte budget for the on-disk bash output store.  When exceeded, the
# oldest entries (by mtime) are evicted until the cap is met.  16 MB is small
# enough to be invisible on any modern disk while big enough to hold several
# full build/test logs (~1-3 MB each is typical).
DEFAULT_MAX_TOTAL_BYTES: int = 16 * 1024 * 1024
#: File-count cap.  Many sub-1 KB entries accumulate when the agent runs short
#: commands frequently; Windows NTFS ``iterdir`` over 10 K+ files adds ~200–500 ms
#: to hook cold-start.  4 096 entries × average 1 KB = 4 MB, well within the
#: byte cap, so file-count eviction rarely fires unless entries are tiny.
DEFAULT_MAX_FILE_COUNT: int = 4096
#: Minimum output size (bytes) to cache.  Outputs smaller than this are not stored
#: to disk, saving I/O and cache space.  A 200-byte output is ~50 tokens, and
#: a dedup hint costs ~12 tokens, so the saving is ~38 tokens.  Default 0 disables
#: the filter (all outputs cached). Set to 1024 or higher to skip tiny outputs.
#: Configurable via [bash_compress] cache_min_bytes in config.toml.
DEFAULT_MIN_CACHE_BYTES: int = 0
#: Maximum output size (bytes) to cache per single bash output.  Outputs larger than
#: this are not stored (to prevent one massive build log from filling the cache).
#: Default 50 MB. Configurable via [bash_compress] cache_max_bytes_per_output in config.toml.
#: Note: This is per-output cap; total directory cap is DEFAULT_MAX_TOTAL_BYTES.
DEFAULT_MAX_CACHE_BYTES: int = 50 * 1024 * 1024

# Minimum gap between eviction scans. The scan does a full iterdir+lstat of up to 4096 files;
# throttling it to once per minute makes the per-Bash-call overhead negligible.
_EVICTION_THROTTLE_SECONDS: float = 60.0
_last_eviction_ts: float = 0.0

# OUTPUT_FILENAME_RE is imported from cache_common — shared with web_cache.

# Sentinel placed at the head of every output file marking the truncation
# boundary, so a reader can immediately see when the stored bytes are partial.
_TRUNC_MARKER = "[token-goat: bash output truncated; stored {n} of {total} bytes]\n"

# Maximum bytes stored per output file.  Larger captures are truncated head-only
# (tail is preserved because the failing portion of a test log is usually at the
# end).  2 MB matches read_replacement._MAX_READ_BYTES so the surgical retrieval
# commands can return the entire stored file when asked.
_MAX_STORED_BYTES: int = 2 * 1024 * 1024

# Pre-compiled patterns for normalize_command_for_cache_key, called on every
# bash command to compute cache keys (hot path).
_WHITESPACE_RE: re.Pattern[str] = re.compile(r"\s+")
_SINGLE_CHAR_FLAG_RE: re.Pattern[str] = re.compile(r"^-[a-zA-Z0-9]$")
# Tools where short-flag sorting improves cache-hit rates.
_SORT_FLAG_TOOLS: frozenset[str] = frozenset({"pytest", "rg", "grep", "git"})

# git diff / git status: output changes with working-tree state (HEAD + index).
_GIT_MUTABLE_RE: re.Pattern[str] = re.compile(r"^\s*git\s+(diff|status)\b", re.IGNORECASE)
# git show <full-40-char-sha>: output is immutable — can never change for a given SHA.
_GIT_IMMUTABLE_RE: re.Pattern[str] = re.compile(r"^\s*git\s+show\s+[0-9a-f]{40}\b", re.IGNORECASE)
# Matches git diff with no path scope: allows flags and ref names but rejects " -- <path>" scoping.
_GIT_DIFF_UNSCOPED_RE: re.Pattern[str] = re.compile(r"^\s*git\s+diff\b", re.IGNORECASE)
_GIT_DIFF_SCOPED_RE: re.Pattern[str] = re.compile(r"\s--\s+\S")
# ls/eza/dir/Get-ChildItem: output changes with directory contents.
_LS_CMD_RE: re.Pattern[str] = re.compile(
    r"^\s*(?:ls|eza|exa|dir|Get-ChildItem|gci)\b", re.IGNORECASE
)
# Tokens that look like flags — skipped when extracting the target path.
_LS_FLAG_RE: re.Pattern[str] = re.compile(r"^-")
# Dependency-listing commands whose output is fully determined by their lockfile.
# Pattern: tool name at start, optional flags, then list/ls/freeze/tree/show sub-command.
# Rejects install/add/remove variants by requiring the specific sub-command words.
_DEP_LIST_RE: re.Pattern[str] = re.compile(
    r"^\s*(?:"
    r"npm\s+(?:-\S+\s+)*(?:ls|list)\b"
    r"|pip\s+(?:-\S+\s+)*(?:list|freeze)\b"
    r"|uv\s+pip\s+(?:-\S+\s+)*(?:list|freeze)\b"
    r"|pnpm\s+(?:-\S+\s+)*(?:list|ls)\b"
    r"|yarn\s+(?:-\S+\s+)*(?:list)\b"
    r"|cargo\s+(?:-\S+\s+)*tree\b"
    r"|bundle\s+(?:-\S+\s+)*(?:list|show)\b"
    r"|composer\s+(?:-\S+\s+)*show\b"
    r")",
    re.IGNORECASE,
)
# Session-immutable env probes: version strings and binary lookups that cannot
# change while the tool is running.  Output is safe to serve from disk cache
# across sessions without TTL.
_ENV_PROBE_RE: re.Pattern[str] = re.compile(
    r"^\s*(?:"
    r"node\s+(?:-v|--version)"
    r"|npm\s+(?:-v|--version)"
    r"|python3?\s+(?:(?-i:-V)\b|--?version)"
    r"|git\s+--version"
    r"|uv\s+--version"
    r"|go\s+version"
    r"|rustc\s+--version"
    r"|cargo\s+--version"
    r"|java\s+--version"
    r"|ruby\s+--version"
    r"|gem\s+--version"
    r"|php\s+--version"
    r"|which\b"
    r"|where\b"
    r")",
    re.IGNORECASE,
)


@dataclass
class BashOutputMeta:
    """Metadata associated with a cached Bash output entry.

    Persisted in the session cache (small) alongside an ID that points at the
    on-disk file (potentially large).  Carries everything a future pre-bash
    dedup check needs without re-reading the body from disk.
    """

    output_id: str
    cmd_sha: str
    cmd_preview: str
    stdout_bytes: int
    stderr_bytes: int
    exit_code: int | None
    ts: float
    truncated: bool


def _bash_outputs_dir() -> Path:
    """Return ``data_dir() / "bash_outputs"`` and create it on first use."""
    return get_cache_dir("bash_outputs")


def is_git_mutable_command(cmd: str) -> bool:
    """True for git diff / git status commands whose output changes with working-tree state."""
    return bool(_GIT_MUTABLE_RE.search(cmd))


def is_git_immutable_command(cmd: str) -> bool:
    """True for ``git show <full-40-char-sha>`` — output never changes for a given SHA."""
    return bool(_GIT_IMMUTABLE_RE.search(cmd))


def git_state_fingerprint(cwd: str) -> str | None:
    """Return a short fingerprint of the git working-tree state rooted at *cwd*.

    Incorporates HEAD ref content (current branch/SHA) and the git index mtime (which
    advances whenever files are staged or the working tree is modified via git operations).
    Returns None when *cwd* is not inside a git repo or any read fails.

    Used by :func:`command_hash` to salt the cache key for ``git diff``/``git status`` so the
    dedup system yields a cache miss after commits or file edits, preventing stale diff output.
    """
    try:
        from pathlib import Path as _P
        p = _P(cwd).resolve()
        git_dir: _P | None = None
        for ancestor in [p, *p.parents]:
            candidate = ancestor / ".git"
            if candidate.is_dir():
                git_dir = candidate
                break
            if candidate.is_file():
                text = candidate.read_text(encoding="utf-8", errors="replace").strip()
                if text.startswith("gitdir:"):
                    git_dir = _P(text[7:].strip()).resolve()
                break
        if git_dir is None:
            return None
        head_file = git_dir / "HEAD"
        if not head_file.is_file():
            return None
        head_content = head_file.read_text(encoding="utf-8", errors="replace").strip()
        if head_content.startswith("ref: "):
            ref_path = git_dir / head_content[5:].strip()
            if ref_path.is_file():
                head_content = ref_path.read_text(encoding="utf-8", errors="replace").strip()
        index_mtime = ""
        index_file = git_dir / "index"
        if index_file.is_file():
            index_mtime = str(index_file.stat().st_mtime_ns)
        return short_content_hash(f"{head_content}\x00{index_mtime}")
    except Exception:  # noqa: BLE001
        return None


def is_dir_listing_command(cmd: str) -> bool:
    """True for ls/eza/dir commands whose output changes with directory contents."""
    return bool(_LS_CMD_RE.search(cmd))


def is_env_probe_command(cmd: str) -> bool:
    """True for version-check and binary-lookup commands whose output is immutable within a session."""
    return bool(_ENV_PROBE_RE.search(cmd))


def is_unscoped_git_diff(cmd: str) -> bool:
    """True when cmd is a git diff with no path scope (no ' -- <path>' suffix).

    Returns False for already-scoped diffs (git diff -- src/foo.py) so the hint
    only fires when there is a realistic opportunity to narrow the output.
    """
    if not _GIT_DIFF_UNSCOPED_RE.search(cmd):
        return False
    return not _GIT_DIFF_SCOPED_RE.search(cmd)


def is_dep_list_command(cmd: str) -> bool:
    """True for dependency-listing commands whose output is fully determined by their lockfile.

    Matches npm ls/list, pip list/freeze, uv pip list/freeze, pnpm list/ls,
    yarn list, cargo tree, bundle list/show, and composer show.  Intentionally
    rejects install/add/remove variants by anchoring on the sub-command word.
    """
    return bool(_DEP_LIST_RE.search(cmd))


# Lockfile names keyed by the leading tool token extracted from the command.
_DEP_LOCKFILES: dict[str, list[str]] = {
    "npm": ["package-lock.json", "yarn.lock"],
    "pip": ["requirements.txt"],
    "uv": ["uv.lock", "requirements.txt"],
    "pnpm": ["pnpm-lock.yaml"],
    "yarn": ["yarn.lock"],
    "cargo": ["Cargo.lock"],
    "bundle": ["Gemfile.lock"],
    "composer": ["composer.lock"],
}


def dep_lockfile_fingerprint(cmd: str, cwd: str | None) -> str | None:
    """Return a 16-char hex SHA-256 of the relevant lockfile for *cmd* run in *cwd*.

    Maps the recognized dependency-listing command to its canonical lockfile,
    resolves it relative to *cwd*, and hashes the raw bytes.  Returns None when
    *cwd* is None, when the command is not recognised, or when no lockfile exists
    in *cwd*.  The fingerprint changes whenever the lockfile changes, so salting
    :func:`command_hash` with this value causes automatic cache invalidation on
    any dependency update.
    """
    if cwd is None:
        return None
    # Extract the leading tool token (first non-whitespace word).
    stripped = cmd.strip()
    first_token = stripped.split()[0].lower() if stripped else ""
    # uv pip … needs two-token prefix match.
    if first_token == "uv":
        candidates = _DEP_LOCKFILES.get("uv", [])
    else:
        candidates = _DEP_LOCKFILES.get(first_token, [])
    if not candidates:
        return None
    import hashlib as _hashlib
    from pathlib import Path as _P
    base = _P(cwd)
    for lockfile_name in candidates:
        lockfile = base / lockfile_name
        try:
            raw = lockfile.read_bytes()
            return _hashlib.sha256(raw).hexdigest()[:16]
        except OSError:
            continue
    return None


def _extract_ls_target(cmd: str, cwd: str | None) -> str | None:
    """Return the directory path targeted by a listing command.

    Strips the binary name and flag tokens (anything starting with ``-``),
    returning the first positional argument. Falls back to *cwd* when no path
    argument is found (a bare ``ls`` lists the current directory).
    """
    tokens = cmd.strip().split()
    for token in tokens[1:]:
        if not _LS_FLAG_RE.match(token):
            return token
    return cwd


def dir_state_fingerprint(path: str) -> str | None:
    """Return a short fingerprint sensitive to namespace changes in a directory.

    Uses the directory mtime (nanoseconds), which advances on NTFS, ext4, and
    APFS when files are created, deleted, or renamed inside the directory. This
    covers namespace-change cache busting for ``ls``/``eza``/``dir`` output.
    It does NOT track edits to existing files (mtime of existing children, size
    changes) — for that, the existing dedup system already serves stale output
    without this salt, so this is a net improvement over the baseline. Returns
    ``None`` on any I/O error so callers fall back to fingerprint-free hashing.
    """
    try:
        from pathlib import Path as _P
        target = _P(path)
        if not target.is_dir():
            return None
        return short_content_hash(str(target.stat().st_mtime_ns))
    except Exception:  # noqa: BLE001
        return None


def normalize_command_for_cache_key(cmd: str) -> str:
    """Normalize a command string before hashing to increase cache hit rate.

    Normalizations applied:
    1. Strip leading/trailing whitespace
    2. Normalize internal whitespace runs to single spaces
    3. Normalize Windows path separators (backslash to forward slash) inside tokens
    3.5. Strip redundant ``./`` prefix from path tokens (``./file.py`` → ``file.py``)
         and trailing ``/`` from non-root path tokens (``src/`` → ``src``).
         This ensures semantically equivalent path forms share the same cache key,
         e.g. ``cat ./src/auth.py`` and ``cat src/auth.py`` deduplicate correctly.
    4. Sort single-char flags (e.g., ``-x -q`` → ``-q -x``) for tools like pytest/rg/git

    Examples:
        ``uv run pytest  tests/  -q`` → ``uv run pytest tests -q`` (trailing / stripped)
        ``rg pattern -o -i`` → ``rg pattern -i -o`` (flags sorted)
        ``cd C:\\foo && rg`` → ``cd C:/foo && rg`` (path sep normalized)
        ``cat ./src/auth.py`` → ``cat src/auth.py`` (dot-slash stripped)
        ``pytest ./tests/`` → ``pytest tests`` (dot-slash + trailing slash stripped)

    *Important:* This normalization is **only** for the cache key, not for the
    actual command executed. The original command is always run.
    """
    # Step 1: Strip outer whitespace
    normalized = cmd.strip()

    # Step 2: Normalize internal whitespace to single spaces
    normalized = _WHITESPACE_RE.sub(' ', normalized)

    # Step 3: Normalize Windows path separators within tokens
    # A token is a contiguous run of non-whitespace characters.
    # We split, normalize each token, then rejoin.
    tokens = normalized.split(' ')
    normalized_tokens = []
    for token in tokens:
        # Replace backslashes with forward slashes in the token.
        # This catches C:\foo, paths in flags, etc.
        normalized_tokens.append(token.replace('\\', '/'))
    normalized = ' '.join(normalized_tokens)

    # Step 3.5: Normalize redundant path prefixes / suffixes.
    # Strip leading ``./`` from tokens that start with it but NOT ``../`` (which
    # changes the referent).  Also strip a trailing ``/`` from tokens that are not
    # the filesystem root ``/`` — ``src/`` and ``src`` refer to the same path for
    # dedup purposes.  Skip flag tokens (starting with ``-``) and shell operators
    # (``&&``, ``||``, ``|``, ``>``, etc.) so we don't mutate argument values.
    tokens = normalized.split(' ')
    normalized_tokens = []
    for token in tokens:
        if token.startswith('-') or token in ('&&', '||', '|', '>', '>>', ';', '&'):
            normalized_tokens.append(token)
            continue
        if token:
            # Strip leading ./  but not ../
            if token.startswith('./') and not token.startswith('../'):
                token = token[2:]
            # Strip trailing / unless the token is just '/' (filesystem root)
            if token.endswith('/') and token != '/':
                token = token.rstrip('/')
            # After stripping "./" the token may be empty — normalise to "." (current dir)
            if not token:
                token = '.'
        normalized_tokens.append(token)
    normalized = ' '.join(normalized_tokens)

    # Step 4: Sort single-char flags for common tools.
    # A single-char flag is a token like -x, -q, -v (but not --flag or positional args).
    # We collect all single-char flags, sort them, then reconstruct the command.
    # Only apply to commands that commonly have flag combinations: pytest, rg/grep, git, etc.
    #
    # Strategy: find the tool name (first token after 'uv run' or the first token overall),
    # and if it's a known tool, sort its flags.

    tokens = normalized.split(' ')
    if not tokens:
        return normalized

    # Extract tool name: skip 'uv run' if present
    tool_start_idx = 0
    if len(tokens) >= 2 and tokens[0] == 'uv' and tokens[1] == 'run':
        tool_start_idx = 2
    if tool_start_idx >= len(tokens):
        return normalized

    tool = tokens[tool_start_idx]

    if tool in _SORT_FLAG_TOOLS and len(tokens) > tool_start_idx + 1:
        # Collect leading single-char flags after the tool, preserve order until
        # we hit the first non-flag argument (positional arg or --long-flag).
        pre_tool = tokens[:tool_start_idx]
        tool_and_args = tokens[tool_start_idx:]

        # Split tool_and_args into: [tool_name, *flags_and_args]
        cmd_tool = tool_and_args[0]
        rest = tool_and_args[1:]

        # Identify contiguous single-char flags at the start of rest
        single_char_flags = []
        other_args = []
        found_non_flag = False

        for token in rest:
            if not found_non_flag and _SINGLE_CHAR_FLAG_RE.match(token):
                # Single-char flag: -x, -q, -1, etc.
                single_char_flags.append(token)
            else:
                found_non_flag = True
                other_args.append(token)

        # Sort the single-char flags
        if single_char_flags:
            single_char_flags.sort()
            normalized = ' '.join(pre_tool + [cmd_tool] + single_char_flags + other_args)
        else:
            normalized = normalized  # No change needed

    return normalized


def command_hash(command: str, cwd: str | None = None) -> str:
    """Return a short content hash for *command* scoped to *cwd*.

    Including the working directory prevents cross-project cache collisions:
    ``pytest tests/`` run in two different project roots would otherwise hash
    identically and the pre-Bash dedup hint could surface output from the wrong
    project.  When *cwd* is ``None`` (backwards-compat callers without CWD),
    only the command string is hashed.

    The command string is normalized (whitespace, path seps, flag ordering) before
    hashing to increase cache hit rate for semantically identical commands.

    *cwd* is likewise normalized (drive-letter case, path separators, WSL ``/mnt/c``
    form) so the same physical directory reached via different representations
    (``C:\\proj`` from a Windows tool vs ``c:/proj`` vs ``/mnt/c/proj`` from WSL)
    shares one cache key. Normalization is string-only: symlinks and junctions are
    not resolved, so distinct logical paths to one directory cache-miss rather than
    risk a wrong-project hit (conservative, never incorrect).
    """
    normalized = normalize_command_for_cache_key(command)
    key = normalized if cwd is None else f"{normalize_path(cwd)}\x00{normalized}"
    # For git diff/status, salt the key with the working-tree fingerprint so cache misses
    # correctly after commits or file edits — prevents serving stale diff output.
    # Use the already-normalized cwd so WSL (/mnt/c/...) and Windows (C:\...) paths that
    # refer to the same directory always produce the same fingerprint.
    if cwd is not None and is_git_mutable_command(command):
        fp = git_state_fingerprint(normalize_path(cwd))
        if fp is not None:
            key = f"{key}\x00git:{fp}"
    # For directory-listing commands (ls, eza, dir), salt with the target
    # directory's mtime so the cache busts on namespace changes (create/delete/rename).
    # Relative targets are resolved against the command cwd, not the Python process cwd.
    if cwd is not None and is_dir_listing_command(command):
        norm_cwd = normalize_path(cwd)
        raw_target = _extract_ls_target(command, norm_cwd)
        if raw_target is not None:
            from pathlib import Path as _tgt_P
            _t = _tgt_P(raw_target)
            resolved_target = str((_tgt_P(norm_cwd) / _t) if not _t.is_absolute() else _t)
            fp = dir_state_fingerprint(resolved_target)
            if fp is not None:
                key = f"{key}\x00dir:{fp}"
    # For dependency-listing commands (npm ls, pip list, cargo tree, …), salt with
    # the lockfile hash so the cache invalidates automatically whenever dependencies
    # change — without any TTL.  When no lockfile is found, the key is left unsalted
    # (plain command+cwd hash) so the entry is still stored and served; it just won't
    # auto-invalidate on lockfile changes in that edge case.
    if is_dep_list_command(command):
        fp = dep_lockfile_fingerprint(command, cwd)
        if fp is not None:
            key = f"{key}\x00lockfile:{fp}"
    return short_content_hash(key)


def glob_hash(pattern: str, path: str | None) -> str:
    """Return a content hash for a (pattern, path) Glob call key.

    Used by :func:`store_glob_result` and :func:`load_glob_result` to derive
    a stable, filesystem-safe cache key for a specific Glob invocation.
    The ``path`` component is normalised to the empty string when ``None`` so
    ``glob_hash("**/*.py", None)`` and ``glob_hash("**/*.py", "")`` collide
    intentionally — they represent the same unbounded pattern.
    """
    canonical = f"{pattern}\x00{path or ''}"
    return short_content_hash(canonical)


# Glob result cache: entries stored under bash_outputs dir with a "glob_" prefix
# in the output_id so they can be distinguished from real bash outputs.
# The stored body is the newline-separated list of matching paths (tool_response
# text), exactly as the Glob tool would have returned it.  The staleness check
# is enforced by the caller (pre_read) via STALE_READ_AGE_SECONDS.

_GLOB_RESULT_PREFIX = "glob_"


def store_glob_result(
    session_id: str,
    pattern: str,
    path: str | None,
    result_text: str,
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = DEFAULT_MAX_FILE_COUNT,
) -> str | None:
    """Cache the text result of a Glob call and return the output_id, or None on error.

    *result_text* is the raw text response from the Glob tool (newline-separated
    file paths).  The cached entry lives in the bash_outputs directory under an
    ID prefixed with ``glob_`` so it is distinguishable from bash outputs and
    not surfaced by ``token-goat bash-history``.

    Eviction is shared with bash outputs: the oldest entries are removed first
    regardless of whether they are bash or glob entries.
    """
    try:
        g_hash = glob_hash(pattern, path)
        # Build a stable output_id: glob_ prefix + session fragment + hash.
        # No timestamp: same (session, pattern, path) deliberately collides so
        # repeat Glob calls refresh the cache in place rather than accumulate.
        out_id = build_keyed_output_id(_GLOB_RESULT_PREFIX, session_id, g_hash)
        if store_blob(out_id, result_text, _bash_outputs_dir, "bash_cache") is None:
            return None
        evict_old_entries(max_total_bytes=max_total_bytes, max_file_count=max_file_count)
        _LOG.debug("bash_cache: stored glob result id=%s pattern=%s", out_id, sanitize_log_str(pattern))
        return out_id
    except OSError as exc:
        _LOG.debug("bash_cache: glob store failed: %s", exc)
        return None


def load_glob_result(
    session_id: str,
    pattern: str,
    path: str | None,
) -> str | None:
    """Return the cached Glob result text for *(session_id, pattern, path)*, or None.

    Returns None when no cached entry exists (first call, or evicted).  The
    staleness / age check is the caller's responsibility.
    """
    try:
        g_hash = glob_hash(pattern, path)
        out_id = build_keyed_output_id(_GLOB_RESULT_PREFIX, session_id, g_hash)
        return load_output_text(out_id, _bash_outputs_dir, "bash_cache")
    except Exception:  # noqa: BLE001
        return None


_GREP_RESULT_PREFIX = "grep_"
_DOT_SLASH_RE: re.Pattern[str] = re.compile(r"^(\./)+")


def _normalize_grep_path(path: str) -> str:
    """Normalize a grep search path for cache key stability.

    ``./src/``, ``src/``, and ``src`` all map to the same key so that
    callers using different path conventions hit the same cache entry.
    Backslashes are converted to forward slashes first.
    Absolute roots like ``/`` are preserved — not collapsed to empty string.
    """
    p = path.replace("\\", "/")
    p = _DOT_SLASH_RE.sub("", p)
    stripped = p.rstrip("/")
    return stripped or p


def grep_hash(
    pattern: str,
    path: str | None,
    glob_filter: str | None,
    type_filter: str | None,
    output_mode: str | None,
) -> str:
    """Return a content hash for a Grep call's full key tuple.

    All five parameters affect the result, so all five are included.
    None values are normalized to empty strings so callers don't need
    to handle the distinction.
    """
    canonical = "\x00".join([
        pattern,
        _normalize_grep_path(path) if path else "",
        glob_filter or "",
        type_filter or "",
        output_mode or "",
    ])
    return short_content_hash(canonical)


def store_grep_result(
    session_id: str,
    pattern: str,
    path: str | None,
    glob_filter: str | None,
    type_filter: str | None,
    output_mode: str | None,
    result_text: str,
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = DEFAULT_MAX_FILE_COUNT,
) -> str | None:
    """Cache the text result of a Grep call and return the output_id, or None on error.

    Same-key calls intentionally collide (replace) so repeat Grep calls
    refresh the cache in place rather than accumulate entries.
    """
    try:
        g_hash = grep_hash(pattern, path, glob_filter, type_filter, output_mode)
        out_id = build_keyed_output_id(_GREP_RESULT_PREFIX, session_id, g_hash)
        if store_blob(out_id, result_text, _bash_outputs_dir, "bash_cache") is None:
            return None
        evict_old_entries(max_total_bytes=max_total_bytes, max_file_count=max_file_count)
        _LOG.debug("bash_cache: stored grep result id=%s pattern=%s", out_id, sanitize_log_str(pattern))
        return out_id
    except OSError as exc:
        _LOG.debug("bash_cache: grep store failed: %s", exc)
        return None


def load_grep_result(
    session_id: str,
    pattern: str,
    path: str | None,
    glob_filter: str | None,
    type_filter: str | None,
    output_mode: str | None,
) -> str | None:
    """Return the cached Grep result text for the given key tuple, or None.

    Returns None when no cached entry exists (first call, or evicted).
    Staleness / age check is the caller's responsibility.
    """
    try:
        g_hash = grep_hash(pattern, path, glob_filter, type_filter, output_mode)
        out_id = build_keyed_output_id(_GREP_RESULT_PREFIX, session_id, g_hash)
        return load_output_text(out_id, _bash_outputs_dir, "bash_cache")
    except Exception:  # noqa: BLE001
        return None


def output_id_for(
    session_id: str,
    command: str,
    ts: float | None = None,
    *,
    cwd: str | None = None,
) -> str:
    """Build a filesystem-safe ID for the (session, command, time) tuple.

    Delegates to :func:`cache_common.build_output_id` with the command hash as
    the content token.  The millisecond timestamp ensures two invocations of
    the same command in the same session do not collide.  *cwd* is forwarded to
    :func:`command_hash` so the ID is project-scoped.
    """
    return build_output_id(session_id, command_hash(command, cwd), ts)


def store_output(
    session_id: str,
    command: str,
    stdout: str,
    stderr: str,
    exit_code: int | None,
    *,
    cwd: str | None = None,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = DEFAULT_MAX_FILE_COUNT,
    min_cache_bytes: int = DEFAULT_MIN_CACHE_BYTES,
    max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
) -> BashOutputMeta | None:
    """Write *stdout* + *stderr* to the cache and return descriptive metadata.

    Returns ``None`` on any I/O error so the calling hook can degrade silently,
    OR when output size is below *min_cache_bytes* or above *max_cache_bytes*
    (size threshold filtering).  Output larger than ``_MAX_STORED_BYTES`` is
    tail-preserved (head truncated) because failing test output is typically at
    the bottom.  After the write the function opportunistically evicts the oldest
    files until the total store size is back under ``max_total_bytes`` and the
    file count is at or under ``max_file_count``; the eviction is best-effort
    and a failed pass simply leaves the directory slightly over budget — the next
    call will try again. *cwd* is included in the cache key so commands from
    different projects do not share entries.

    Size thresholds:
        min_cache_bytes: Do not cache outputs smaller than this (default 1 KB).
            Saves disk space and cache pollution for tiny outputs.
        max_cache_bytes: Do not cache outputs larger than this per-file cap
            (default 50 MB). Prevents a single huge build log from filling the
            entire cache directory.
    """
    # Strip ANSI/VT100 escape sequences before storing so cached content is
    # always clean text.  Tools like lefthook, delta, eza, and pytest emit
    # heavy colour codes that inflate token counts without adding information.
    stdout = strip_ansi(stdout)
    stderr = strip_ansi(stderr)

    meta: BashOutputMeta | None = None
    with safe_cache_op("store_output", log=_LOG):
        stdout_bytes = len(stdout.encode("utf-8", errors="replace"))
        stderr_bytes = len(stderr.encode("utf-8", errors="replace"))
        total = stdout_bytes + stderr_bytes

        # Check size thresholds: do not cache if below min or above max.
        # Returns None silently so the caller knows not to write the sidecar.
        if total < min_cache_bytes:
            _LOG.debug(
                "bash_cache: output too small (%d bytes < min %d); skipping cache",
                total, min_cache_bytes,
            )
            return None
        if total > max_cache_bytes:
            _LOG.debug(
                "bash_cache: output too large (%d bytes > max %d); skipping cache",
                total, max_cache_bytes,
            )
            return None

        out_id = output_id_for(session_id, command, cwd=cwd)
        path = safe_join_output_id(out_id, _bash_outputs_dir, "bash_cache")
        if path is None:
            return None

        truncated = False
        body_parts: list[str] = []

        if total > _MAX_STORED_BYTES:
            # Preserve the tail: take the last _MAX_STORED_BYTES of the
            # combined stream, prefixing a truncation marker so any consumer
            # immediately knows what they are looking at.  We compose the
            # combined stream as stdout then a blank line then stderr; this
            # matches what the agent would have seen had it copied the tool
            # result directly.
            #
            # Slice on raw utf-8 bytes (not codepoints) so the stored body's
            # byte length is bounded by _MAX_STORED_BYTES even when the output
            # contains multi-byte characters (CJK, emoji).  Codepoint slicing
            # could otherwise store up to 4× the cap on disk for non-ASCII
            # output and silently break the 16 MB directory cap.
            combined = stdout
            if stderr:
                combined = f"{stdout}\n--- stderr ---\n{stderr}" if stdout else stderr
            combined_bytes = combined.encode("utf-8", errors="replace")
            keep_bytes = combined_bytes[-_MAX_STORED_BYTES:]
            # Advance past any utf-8 continuation bytes at the cut boundary so
            # the decode does not insert a U+FFFD (3 bytes) that would push
            # the stored slice over the cap.
            skip = 0
            while skip < len(keep_bytes) and (keep_bytes[skip] & 0xC0) == 0x80:
                skip += 1
            if skip:
                keep_bytes = keep_bytes[skip:]
            keep = keep_bytes.decode("utf-8", errors="replace")
            body_parts.append(_TRUNC_MARKER.format(n=_MAX_STORED_BYTES, total=total))
            body_parts.append(keep)
            truncated = True
        else:
            if stdout:
                body_parts.append(stdout)
            if stderr:
                if stdout:
                    body_parts.append("\n--- stderr ---\n")
                body_parts.append(stderr)

        body = "".join(body_parts)
        paths.atomic_write_text(path, body)

        meta = BashOutputMeta(
            output_id=out_id,
            cmd_sha=command_hash(command, cwd),
            cmd_preview=sanitize_log_str(command, max_len=120),
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            exit_code=exit_code,
            ts=time.time(),
            truncated=truncated,
        )

        _LOG.debug(
            "bash_cache: stored id=%s bytes=%d truncated=%s",
            out_id, total, truncated,
        )
    # Best-effort eviction runs outside safe_cache_op so an OSError during the
    # directory walk never discards a confirmed write (the file is already on disk).
    if meta is not None:
        try:
            global _last_eviction_ts
            _now = time.monotonic()
            if _now - _last_eviction_ts >= _EVICTION_THROTTLE_SECONDS:
                _last_eviction_ts = _now
                evict_old_entries(max_total_bytes=max_total_bytes, max_file_count=max_file_count)
        except OSError as _exc:
            _LOG.warning("bash_cache: eviction failed (best-effort): %s", _exc)
    return meta


def load_output(output_id: str) -> str | None:
    """Return the cached output body for *output_id*, or ``None`` if absent."""
    return load_output_text(output_id, _bash_outputs_dir, "bash_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None.

    Used by ``token-goat bash-history`` to render a listing without reading
    every body.
    """
    return load_output_meta_stat(output_id, _bash_outputs_dir, "bash_cache")


def evict_old_entries(
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = DEFAULT_MAX_FILE_COUNT,
) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*.

    Each cached output is a pair of files: the body (``<id>.txt``) and the
    JSON sidecar (``<id>.json``).  Eviction removes both atomically — leaving
    an orphan sidecar after deleting its body would let stale metadata
    accumulate over time and would also confuse ``token-goat bash-history``
    on subsequent calls.

    Returns the number of body files removed; orphan sidecar pairs count as
    one removal each, matching the per-entry abstraction callers expect.
    Skips symlinks (defensive: an attacker who can plant a symlink into the
    cache directory should not be able to direct deletes elsewhere by name).
    All errors are swallowed — eviction is opportunistic, not authoritative.

    The shared algorithm lives in :func:`cache_common.evict_cache_dir`; this
    wrapper supplies the bash-specific directory, log name, and default caps.
    Override caps via ``TOKEN_GOAT_BASH_CACHE_MAX_FILES`` and
    ``TOKEN_GOAT_BASH_CACHE_MAX_BYTES`` env vars, or pass them explicitly.
    """
    return evict_cache_dir(
        cache_dir_fn=_bash_outputs_dir,
        log_name="bash_cache",
        max_total_bytes=max_total_bytes,
        max_file_count=max_file_count,
    )


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for every cached output, newest first.

    Used by ``token-goat bash-history`` for human inspection.  Returns an
    empty list when the directory is missing or unreadable; never raises.
    """
    return list_cache_outputs(_bash_outputs_dir)


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID.

    The sidecar stores the structured :class:`BashOutputMeta` so that callers
    (CLI, hints) can answer questions like "what was the exit code?" without
    re-parsing the body.  Sidecar absence is non-fatal: the cache body is
    always the source of truth for output text.
    """
    base = safe_join_output_id(output_id, _bash_outputs_dir, "bash_cache")
    if base is None:
        return None
    return sidecar_path_for(base)


def write_sidecar(meta: BashOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    write_sidecar_metadata(
        sidecar_meta_path(meta.output_id),
        meta,
        log=_LOG,
        log_prefix="bash_cache",
    )


def read_sidecar(output_id: str) -> BashOutputMeta | None:
    """Return parsed :class:`BashOutputMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added later — missing fields
    fall back to safe defaults so an old cache survives a token-goat upgrade.
    """
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        return BashOutputMeta(
            output_id=str(data.get("output_id", output_id)),
            cmd_sha=str(data.get("cmd_sha", "")),
            cmd_preview=str(data.get("cmd_preview", "")),
            stdout_bytes=int(data.get("stdout_bytes", 0)),
            stderr_bytes=int(data.get("stderr_bytes", 0)),
            exit_code=(
                int(data["exit_code"])
                if isinstance(data.get("exit_code"), (int, float))
                else None
            ),
            ts=float(data.get("ts", 0.0)),
            truncated=bool(data.get("truncated", False)),
        )
    except (TypeError, ValueError):
        return None


def get_recent_error_outputs(session_id: str, max_entries: int = 5) -> list[dict[str, str]]:
    """Return up to *max_entries* recent bash outputs with errors, for manifest assist.

    Scans the bash_outputs cache for entries matching session_id that contain
    error indicators (error patterns) or non-zero exit codes. Returns a list of
    {command: str, error_summary: str} dicts where error_summary is the first
    error line truncated to 120 chars. Returns an empty list on any error
    (fail-soft contract).

    Error detection looks for:
    - exit_code != 0 (from sidecar metadata)
    - Output lines containing: "Error:", "FAILED", "Traceback", "error:" (exact case-sensitive matches)
    """
    result: list[dict[str, str]] = []
    with safe_cache_op("get_recent_error_outputs", log=_LOG):
        try:
            cache_dir = _bash_outputs_dir()
            if not cache_dir.is_dir():
                return []

            # Collect entries with non-zero exit codes from sidecars
            for sidecar_path in sorted(
                cache_dir.glob("*.json"), key=path_mtime_key, reverse=True
            ):
                if len(result) >= max_entries:
                    break
                candidate_id = sidecar_path.stem
                # Skip glob-result entries
                if candidate_id.startswith("glob_"):
                    continue
                meta = read_sidecar(candidate_id)
                if meta is None:
                    continue
                # Filter by session_id: the candidate_id (sidecar filename) should match session pattern
                # Format: session_id + underscore + hash + optional timestamp
                # We need to check if this entry belongs to the requested session
                # The output_id in the meta should match the sidecar filename (candidate_id)
                # Simple check: does the sidecar filename/output_id contain the session_id?
                if session_id and not (session_id in candidate_id or session_id in str(meta.output_id)):
                    continue

                # Check for error indicators
                has_error = False
                error_summary = ""

                # First try to extract error pattern from output
                if (meta.stdout_bytes + meta.stderr_bytes) > 0:
                    try:
                        raw_output = load_output(candidate_id)
                        if raw_output:
                            for line in raw_output.splitlines():
                                stripped = line.strip()
                                if any(
                                    pattern in stripped
                                    for pattern in ("Error:", "FAILED", "Traceback", "error:")
                                ):
                                    error_summary = sanitize_log_str(stripped, max_len=120)
                                    has_error = True
                                    break
                    except Exception:  # noqa: BLE001
                        pass

                # If no pattern match, check for non-zero exit code
                if not has_error and isinstance(meta.exit_code, int) and meta.exit_code != 0:
                    has_error = True

                if has_error:
                    cmd = sanitize_log_str(meta.cmd_preview, max_len=80)
                    if not error_summary:
                        error_summary = f"exit {meta.exit_code}" if meta.exit_code else "unknown error"
                    result.append({"command": cmd, "error_summary": error_summary})

        except Exception:  # noqa: BLE001
            pass

    return result


def find_cached_for_command(command: str, cwd: str | None = None) -> BashOutputMeta | None:
    """Return the most recent on-disk cached entry for *command*, or None.

    Scans all sidecar files in the bash_outputs store and returns the entry
    whose ``cmd_sha`` matches the hash of *command* (scoped to *cwd*),
    favouring the most recently written file.  Used by the pre-Bash hook to
    emit a cross-session cache-hit hint when the same command was run in a
    prior session and the output is still on disk but has not been recorded in
    the current session.

    *cwd* scopes the lookup to the current project so ``pytest tests/`` run in
    project A does not return cached output from project B.

    This is intentionally a linear scan over sidecar metadata — not body text
    — so the I/O cost is proportional to the number of cached entries (not
    their sizes).  In the typical usage pattern (≤ a few hundred cached commands)
    the scan completes in milliseconds.

    Returns ``None`` on any I/O error (fail-soft contract).
    """
    target_sha = command_hash(command, cwd)
    best: BashOutputMeta | None = None
    with safe_cache_op("find_cached_for_command", log=_LOG):
        cache_dir = _bash_outputs_dir()
        if not cache_dir.is_dir():
            return None
        for sidecar_path in sorted(
            cache_dir.glob("*.json"), key=path_mtime_key, reverse=True
        ):
            # Extract output_id from sidecar filename (strip .json)
            candidate_id = sidecar_path.stem
            # Skip glob-result entries (prefixed with "glob_")
            if candidate_id.startswith("glob_"):
                continue
            meta = read_sidecar(candidate_id)
            if meta is None:
                continue
            if meta.cmd_sha == target_sha and (meta.stdout_bytes + meta.stderr_bytes) > 0:
                best = meta
                break  # sorted newest-first; first match is the freshest
    return best
