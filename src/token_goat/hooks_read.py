"""Pre- and post-read hook handlers.

Pre-read (``pre_read``)
-----------------------
Runs before every Read, Bash, Grep, and Glob tool call.  Three distinct
responsibilities are applied in order:

1. **Bash synthesis** — Bash tool calls whose command is a read-equivalent
   (``cat``, ``head``, ``tail``, ``bat``, …) are converted to a synthetic Read
   payload via :mod:`bash_parser` and processed identically to a native Read.
   This ensures Codex-style harnesses get image-shrinking and session hints
   even though they never issue a structured Read tool.

2. **Image shrinking** — Read calls targeting image files are intercepted,
   the image is compressed to ≤1024 px on its long axis via
   :func:`image_shrink.shrink`, and the hook response redirects the harness
   to the cached shrunk copy so Claude receives a cheaper version transparently.

3. **Session hints** — If neither of the above fired, the session cache is
   consulted.  When the requested lines were already read this session, a
   "re-reading wastes ~N tokens" hint is injected as ``additionalContext``.
   When the file is large and has indexed symbols, a surgical-read suggestion
   is injected instead.

Post-read (``post_read``)
--------------------------
Runs after Read, Grep, and Glob tool calls.  Records the accessed file paths,
line ranges, Grep patterns, and result counts into the per-session JSON cache
so that subsequent pre-read calls have accurate overlap data.  Always returns
CONTINUE; never modifies tool output.
"""
from __future__ import annotations

__all__ = ["_safe_split_argv", "post_bash", "post_read", "pre_read"]

import contextlib
import hashlib
import re as _re
import shlex as _shlex
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import types
    from collections.abc import Callable


from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    continue_with_message,
    deny_redirect,
    emit_if_new_hint,
    extract_tool_response_text,
    get_hook_context,
    get_session_context,
    get_tool_input,
    is_real_int,
    load_session_safe,
    pre_tool_use_with_context,
    pre_tool_use_with_update,
    record_cached_stat,
    record_hint_stat_pair,
    run_dedup_hint,
    sanitize_log_str,
    sanitize_opt,
    validate_cwd,
)
from .hooks_common import LOG as _LOG
from .util import env_int as _env_int
from .util import sanitize_surrogates as _sanitize_surrogates
from .util import strip_lower as _strip_lower
from .util import utf8_bytes as _utf8_bytes

# Environment variable that disables Bash output compression at the hook layer.
# Recognised values: "0", "false", "no", "off" (case-insensitive).  Any other
# value (including unset) leaves compression enabled.  Matches the pattern used
# by compact_assist for consistency.
_ENV_BASH_COMPRESS = "TOKEN_GOAT_BASH_COMPRESS"
_FALSY_ENV: frozenset[str] = frozenset(("0", "false", "no", "off"))

# Monotonically increasing counter incremented at the top of pre_read on every tool call.
# Stored in FileEntry.last_read_call_index so the recent-read suppression window can
# compute how many tool calls have elapsed since a file was last read.
_call_index: int = 0

# File extensions that are known to be binary (non-text) content.  Pre-read
# hints (session hints, diff hints, structured-file hints) are skipped for
# these files because token-goat never indexes them and the hints would be
# meaningless noise.  Image extensions are handled separately by the shrink
# path; this set covers non-image binaries.
_BINARY_EXTENSIONS: frozenset[str] = frozenset([
    # Archives
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
    # Compiled / object code
    ".so", ".dylib", ".dll", ".exe", ".pyd", ".pyc", ".pyo", ".o", ".a",
    ".lib", ".obj", ".wasm",
    # Databases / binary blobs
    ".db", ".sqlite", ".sqlite3", ".parquet", ".feather", ".npy", ".npz",
    ".arrow", ".pb", ".bin", ".dat",
    # Media (non-image)
    ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".aac", ".m4a",
    ".avi", ".mov", ".mkv", ".webm",
    # Fonts
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    # PDF / office
    ".pdf", ".docx", ".xlsx", ".pptx", ".odt",
    # Misc
    ".class", ".jar", ".war",
])

# Files larger than this threshold (in bytes) are skipped for pre-read hints.
# Token-goat does not index such files and any hint would be useless overhead.
_LARGE_FILE_HINT_SKIP_BYTES: int = 10 * 1024 * 1024  # 10 MB

# Image extensions not covered by _BINARY_EXTENSIONS (those go via the shrink path).
_IMAGE_EXTENSIONS: frozenset[str] = frozenset([".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".svg", ".webp", ".tiff", ".tif"])
# Combined skip set for truncated-read advisory hints (binary + image).
_TRUNCATED_HINT_SKIP_EXTS: frozenset[str] = _BINARY_EXTENSIONS | _IMAGE_EXTENSIONS

# Regex patterns to detect Claude Code partial-read sentinels in tool result text.
# Pattern A: "lines 1-200 of 1500" or "lines 1–200 of 1500" (hyphen or en-dash).
_PARTIAL_READ_RE_HYPHEN: _re.Pattern[str] = _re.compile(
    r"lines?\s+(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)", _re.IGNORECASE,
)
# Pattern B: "showing lines 1 to 200 of 1500".
_PARTIAL_READ_RE_TO: _re.Pattern[str] = _re.compile(
    r"showing\s+lines?\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)", _re.IGNORECASE,
)


def _safe_split_argv(cmd: str) -> list[str]:
    """Split a shell command string into an argv list, safely handling metacharacters.

    Uses :func:`shlex.split` for correct POSIX tokenisation (handles quoted
    strings, escaped characters, and multi-word arguments).  Falls back to a
    simple whitespace split when ``shlex.split`` raises ``ValueError`` (e.g.
    unbalanced quotes — common in generated or partial commands).

    Shell metacharacters (``|``, ``&&``, ``;``, ``>``, ``<``, ``$()``,
    backticks) are **not stripped**: they are passed through so callers that
    need to detect pipeline stages can still find them in the result.  Callers
    that want to reject piped commands should check ``any(op in cmd ...)``
    before splitting, or inspect the returned tokens for metacharacter presence.

    Args:
        cmd: Raw shell command string from the hook payload.

    Returns:
        A list of argument tokens.  Returns ``[]`` for empty or whitespace-only
        input.  Never raises.
    """
    if not cmd or not cmd.strip():
        return []
    try:
        return _shlex.split(cmd, posix=True)
    except ValueError:
        # Unbalanced quotes or other shlex parse error — fall back to whitespace split.
        return cmd.split()


def _is_binary_or_large_file(file_path: str) -> bool:
    """Return True when hints should be skipped for *file_path*.

    Skips when:
    - The file extension is in :data:`_BINARY_EXTENSIONS` (non-text binary).
    - The file size exceeds :data:`_LARGE_FILE_HINT_SKIP_BYTES` (10 MB).

    Both checks are best-effort: stat failures are silently ignored (fail-soft).
    Images are handled by the shrink path and are excluded here.
    """
    ext = Path(file_path).suffix.lower()
    if ext in _BINARY_EXTENSIONS:
        return True
    try:
        size = Path(file_path).stat().st_size
        return size >= _LARGE_FILE_HINT_SKIP_BYTES
    except OSError:
        return False


# ============================================================================
# Predicate Helpers: Cache & File Validation
# ============================================================================
# These extract repeated boolean conditions for cache availability, file
# size gates, modification detection, and fingerprint dedup. Reduces nesting
# and clarifies intent at call sites.

def _cache_is_available(cache: object) -> bool:
    """Check if cache object is available and not None."""
    return cache is not None


def _is_file_size_sufficient(file_size: int, min_bytes: int) -> bool:
    """Check if file size meets threshold (skip hint if too small)."""
    return min_bytes <= 0 or file_size >= min_bytes


def _file_is_modified(
    disk_mtime_ns: int,
    disk_size: int,
    entry_mtime_ns: int | None,
    entry_size: int,
) -> bool:
    """Check if file has been modified since last read.

    Returns True if file was modified (deny re-read); False if unchanged.
    Requires entry_mtime_ns to be not None (legacy entries skip this gate).
    """
    if entry_mtime_ns is None:
        return False  # legacy entry — fall through to SHA check
    return disk_mtime_ns != entry_mtime_ns or disk_size != entry_size


def _fingerprint_already_seen(cache: object, fingerprint: str) -> bool:
    """Check if a hint fingerprint has already been emitted (dedup gate)."""
    try:
        return cache.has_hint_fingerprint(fingerprint)  # type: ignore[attr-defined]
    except Exception:
        return False


def _bash_compress_enabled() -> bool:
    """Return False when the user has explicitly disabled bash output compression.

    Defaults to True so the feature is opt-out: new installs benefit
    immediately, and an opt-out path is available for users who want the
    raw output (e.g. debugging a filter that strips too much).
    """
    import os

    val = _strip_lower(os.environ.get(_ENV_BASH_COMPRESS, ""))
    return val not in _FALSY_ENV


def _resolve_compression_profile(harness: str, config_profile: str) -> str:
    """Resolve the effective compression profile for the given harness.

    When *config_profile* is ``"auto"``, the harness drives the choice:
    Gemini (large context window) → ``"minimal"``; Claude Code and Codex
    → ``"balanced"``.  An explicit config profile always wins over auto-detection.

    Args:
        harness: Active harness identifier (``"claude"``, ``"codex"``, ``"gemini"``).
        config_profile: Profile from config (``"auto"``, ``"aggressive"``,
            ``"balanced"``, or ``"minimal"``).

    Returns:
        One of ``"aggressive"``, ``"balanced"``, or ``"minimal"``.
    """
    if config_profile != "auto":
        return config_profile
    # Auto mode: Gemini has a 1 M token context window and can tolerate less
    # aggressive compression.  Claude Code and Codex stay on "balanced".
    return "minimal" if harness == "gemini" else "balanced"


#: Binaries absent from bash_detect/_BINARY_TO_FILTER and bash_parser READ/GREP/GLOB_BINS
#: that still have handler-specific logic and must NOT be short-circuited by the fast-path.
#: which / where → _handle_env_probe_serve caches version-probe results.
_BASH_FAST_PATH_EXCLUDE: frozenset[str] = frozenset({"which", "where"})


def _handle_bash_compress(payload: HookPayload) -> HookResponse | None:
    """Rewrite compressible Bash commands to flow through ``token-goat compress``.

    When the agent issues a Bash tool call whose first binary is one of the
    recognised noisy tools (``pytest``, ``npm install``, ``docker build``,
    ``git log``, ``cargo build``, ``kubectl get``, ...), we intercept the
    command and rewrite it to::

        token-goat compress --filter <name> --profile <profile> --cmd '<original>'

    The wrapper subprocess runs the original through the system shell,
    captures stdout + stderr, applies the per-tool filter, and prints a
    compressed view that keeps every error block while dropping progress
    bars, deprecation noise, duplicate lines, and verbose passes.

    Returns ``None`` when:
    * the user has disabled bash compression via ``TOKEN_GOAT_BASH_COMPRESS=0``
      or the ``[bash_compress] enabled = false`` config entry,
    * the matched filter appears in the ``disabled_filters`` config list,
    * the command contains shell pipeline / redirect operators (the wrapper
      can only intercept the first stage of a pipeline, so wrapping would be
      semantically wrong),
    * no filter matches the command's binary, or
    * the command already starts with ``token-goat`` (avoid double-wrapping
      when the agent invokes the wrapper itself).
    """
    if not _bash_compress_enabled():
        return None

    from . import config as config_mod

    cfg_obj = config_mod.load()
    cfg = cfg_obj.bash_compress
    if not cfg.enabled:
        return None

    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str) or not cmd.strip():
        return None
    # Avoid recursive wrapping: if the command already invokes token-goat,
    # leave it alone.  This catches both direct calls and the wrapper's own
    # rewrite (which would otherwise compose infinitely).
    stripped = cmd.lstrip()
    if stripped.startswith(("token-goat", "token_goat")) or "token_goat.cli" in stripped:
        return None

    # Fast pre-check via static binary lookup (O(1) dict, ~1 ms import) before
    # committing to the full bash_compress import (~75 ms, 737 regex compiles).
    # Compound commands (&&) may have a matching filter in a later segment, so
    # they bypass the pre-check and always proceed to the full detection.
    from . import bash_detect
    _first_word = cmd.split()[0] if cmd.split() else ""
    if "&&" not in cmd and not bash_detect.detect([_first_word]):
        return None

    from . import bash_compress
    from . import paths as paths_mod

    harness = str(payload.get("_tg_harness", "claude"))
    effective_profile = _resolve_compression_profile(harness, cfg_obj.compression.profile)

    # Resolve context-pressure tier to compute a pressure-scaled output token cap.
    _bash_tier = "cool"
    _bash_session_id, _ = get_session_context(payload)
    if _bash_session_id:
        try:
            from .compact import get_context_pressure as _gcp_bash
            _bash_tier = _gcp_bash(_bash_session_id).tier
        except Exception:
            pass
    _bash_max_tokens = _pressure_scaled_bash_cap(_BASH_COMPRESS_BASE_TOKENS, _bash_tier)

    def _mk_wrapper(filter_name: str, seg: str) -> str | None:
        if filter_name in cfg.disabled_filters:
            return None
        return paths_mod.python_runner_command(
            "compress",
            "--filter", filter_name,
            "--timeout", str(cfg.timeout_seconds),
            "--profile", effective_profile,
            "--max-tokens", str(_bash_max_tokens),
            "--cmd", seg,
        )

    detected = bash_compress.detect_from_command(cmd)
    if detected is not None:
        filter_, _ = detected
        if filter_.name in cfg.disabled_filters:
            _LOG.debug("bash_compress: filter %s disabled by config; skipping", filter_.name)
            return None
        wrapper = _mk_wrapper(filter_.name, cmd)
        if wrapper is None:
            return None
        rewritten_input: dict[str, object] = dict(tool_input)
        rewritten_input["command"] = wrapper
        _LOG.info(
            "bash_compress: wrapping command with %s filter profile=%s (orig=%s)",
            filter_.name,
            effective_profile,
            sanitize_log_str(cmd, max_len=200),
        )
        return pre_tool_use_with_update(
            rewritten_input,
            (
                f"Note: command auto-wrapped by token-goat ({filter_.name} filter) "
                "to compress its output before it lands in context. "
                "Disable via TOKEN_GOAT_BASH_COMPRESS."
            ),
        )

    # Fallback: wrap each &&-segment independently — handles compound commands like ``git diff && git log`` where the compound guard would otherwise skip compression and let large output (e.g. JSONL diffs) enter context uncompressed.
    rewritten_cmd = bash_compress.try_wrap_compound_segments(cmd, wrapper_args=_mk_wrapper)
    if rewritten_cmd is None:
        return None
    rewritten_input = dict(tool_input)
    rewritten_input["command"] = rewritten_cmd
    _LOG.info(
        "bash_compress: compound-wrapped command profile=%s (orig=%s)",
        effective_profile,
        sanitize_log_str(cmd, max_len=200),
    )
    return pre_tool_use_with_update(
        rewritten_input,
        (
            "Note: compound command auto-wrapped by token-goat to compress each "
            "stage's output before it lands in context. "
            "Disable via TOKEN_GOAT_BASH_COMPRESS."
        ),
    )


def _handle_bash_read_equivalent(payload: HookPayload) -> HookPayload | None:
    """Convert Bash read-equivalent commands to Read payload for recursive processing.

    Intercepts Bash tool invocations with read-like commands (cat, head, tail, bat, etc.)
    and synthesizes an equivalent Read tool payload so that image shrinking and session-hint
    logic apply identically to Bash-based reads as they do to direct Read calls.

    Args:
        payload: Hook payload dict with tool_name='Bash' and tool_input containing 'command'.

    Returns:
        A new payload dict with tool_name='Read' and adjusted tool_input (file_path, offset, limit),
        or None if the command is not recognized as a read-equivalent or parsing fails.
    """
    from . import bash_parser

    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
        if intent.reason:
            _LOG.info("bash read near-miss: %s", sanitize_log_str(intent.reason))
        return None

    read_payload = dict(payload)
    read_payload["tool_name"] = "Read"
    # bash_parser returns 1-indexed line offsets (head -n N → offset=1; sed -n
    # '10,30p' → offset=10).  The native Read tool uses 0-indexed offset, where
    # offset=0 means "start from line 1".  Subtract 1 here so downstream logic
    # that receives the synthesised payload sees a uniform 0-indexed offset.
    read_payload["tool_input"] = {
        "file_path": intent.target_path,
        "offset": (intent.offset - 1) if intent.offset is not None else None,
        "limit": intent.limit,
    }
    # Mark whole-file bash reads (cat/bat, no limit) so _handle_indexed_cat_deny can intercept at warm+.
    if intent.limit is None and intent.offset is None:
        read_payload["_tg_from_bash_cat"] = True
    # Mark this as converted from bash so surgical-hint logic doesn't suppress hints for small ranges.
    read_payload["_tg_from_bash_parser"] = True
    return read_payload


def _try_shrink_image(
    file_path: str, tool_input: dict[str, object]
) -> HookResponse | None:
    """Attempt image shrinking and return hook-formatted response if successful.

    Compresses image files (PNG, JPEG, WebP, etc.) using cached shrinking, records
    token/byte savings to the stats DB, and returns a hook response that redirects
    the Read call to the shrunk copy. Non-image files are silently passed through as None.

    Optimizes stats recording by reusing the source file size from the initial stat()
    call in image_shrink.shrink() rather than re-statting the file in stats_for().

    Args:
        file_path: Absolute or relative path to a file being read.
        tool_input: Read tool input dict (will be copied and file_path updated if
            shrinking succeeds).

    Returns:
        A hook response dict with updated file_path pointing to the shrunk image, or None if:
        - file_path is not an image file
        - shrinking returns None (already optimal, no temp space, etc.)
        - shrinking or stats recording raises an exception (logged but not re-raised)
    """
    from . import db, image_shrink

    if not image_shrink.is_image_path(file_path):
        return None

    try:
        src_path = Path(file_path)
        # Record "considered but bypassed" telemetry for files that fall under
        # the per-format threshold.  Without this, the bypass rate is invisible
        # and the threshold can only be guessed.  The stat is recorded with
        # bytes_saved=0 + tokens_saved=0 (informational row) so it shows up in
        # `token-goat stats` only when `stats.record_zero_savings = true` is
        # configured.  We compute the actual file size once and reuse it for
        # the detail string so the histogram is queryable from the stats DB.
        try:
            _src_stat = src_path.stat()
            if _src_stat.st_size <= image_shrink.format_threshold(src_path):
                db.record_stat(
                    None,
                    "image_shrink_skipped",
                    bytes_saved=0,
                    tokens_saved=0,
                    detail=(
                        f"{sanitize_log_str(file_path)} "
                        f"size={_src_stat.st_size} "
                        f"threshold={image_shrink.format_threshold(src_path)}"
                    ),
                )
                return None
        except OSError as _exc:
            # Missing file / permission: fall through to image_shrink.shrink
            # which has its own OSError handling and returns None silently.
            _LOG.debug("image-shrink: pre-check failed for %s: %s", sanitize_log_str(file_path), _exc)
        shrunken = image_shrink.shrink(src_path)
        if shrunken is None:
            return None
        # Compute alt-text summary by reopening the shrunken file — keeps
        # shrink()'s return signature simple (Path|None) for the dozens of
        # callers and tests that monkeypatch it. Fail-soft: empty summary
        # on PIL/IO error so the redirect still fires.
        img_summary = ""
        try:
            from PIL import Image as _PILImage

            with _PILImage.open(shrunken) as _img:
                img_summary = image_shrink.extract_image_summary(src_path, _img)
        except (OSError, AttributeError):
            # OSError: file not found or permission denied (transient race)
            # AttributeError: PIL module issues or missing image methods
            pass

        # Detect cache hit: if shrunken path is in the image cache directory and
        # matches the expected content-hash stem, it was served from cache (zero CPU cost).
        # Fresh shrinks also end up in cache, but we differentiate by checking the
        # timing: if the file already existed before shrink() was called, it's a hit.
        try:
            stem = image_shrink._cache_path_for(src_path)
            # Cache hit means the shrunken path matches the cache stem pattern.
            is_cache_hit = shrunken.parent == stem.parent and shrunken.stem == stem.stem
        except (AttributeError, ValueError, TypeError):
            # AttributeError: private _cache_path_for not found (API change)
            # ValueError/TypeError: src_path validation failed in the function
            # Safe to ignore; we just won't differentiate cache hits from fresh shrinks.
            _LOG.debug("image-shrink: cache-hit detection failed for %s", sanitize_log_str(file_path))
            is_cache_hit = False

        img_stats = image_shrink.stats_for(src_path, shrunken)
        tokens_saved = max(0,
            image_shrink.vision_tokens(img_stats["orig_width"], img_stats["orig_height"])
            - image_shrink.vision_tokens(img_stats["out_width"], img_stats["out_height"])
        )
        # Track cache hits separately to differentiate zero-CPU fast path from
        # actual compression work. Both save tokens, but with different costs.
        stat_kind = "image_shrink_cache_hit" if is_cache_hit else "image_shrink"
        db.record_stat(
            None,
            stat_kind,
            bytes_saved=img_stats["bytes_saved"],
            tokens_saved=tokens_saved,
            # Sanitize file_path before storing: it comes from the harness payload
            # and could contain newlines that corrupt multi-line DB detail queries.
            detail=f"{sanitize_log_str(file_path)} -> {shrunken.name}",
        )

        shrink_response = dict(tool_input)
        shrink_response["file_path"] = str(shrunken)
        _src_b = img_stats["src_bytes"]
        _out_b = img_stats["out_bytes"]

        def _fmt_bytes(n: int) -> str:
            """Format bytes as KB or MB with one decimal place."""
            if n >= 1_000_000:
                return f"{n / 1_000_000:.1f} MB"
            if n >= 1_000:
                return f"{n / 1_000:.0f} KB"
            return f"{n} B"

        # Always show before→after sizes and the percentage reduction so the
        # agent understands what happened at a glance without opening the file.
        # Example: "2.3 MB → 180 KB (saving ~92%)"
        _size_str = f"{_fmt_bytes(_src_b)} → {_fmt_bytes(_out_b)} (saving ~{100.0 * img_stats['bytes_saved'] / _src_b if _src_b > 0 else 0.0:.0f}%)"
        note = (
            f"Note: image auto-shrunk by token-goat "
            f"({_size_str}). "
            f"Original: {file_path}"
        )
        if img_summary:
            note = f"{note}\n{img_summary}"
        return pre_tool_use_with_update(shrink_response, note)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        # OSError: file I/O failures, permission denied, disk full
        # ValueError/TypeError: invalid path or type conversion failure
        # AttributeError: API changes or missing methods on shrink result
        _LOG.exception("image-shrink failed during pre-read: %s", type(exc).__name__)
        return None
    except Exception:
        _LOG.warning("image-shrink: unexpected exception type during pre-read", exc_info=True)
        return None


def _try_snapshot(
    session_id: str,
    file_path: str,
    *,
    cache: object | None = None,
) -> None:
    """Persist a content snapshot for *file_path* so future diff hints can fire.

    Skips files that cannot be read (transient I/O race, permission denied) or
    that exceed :data:`snapshots.MAX_SNAPSHOT_BYTES` (the diff would not fit
    in a hint anyway).  Records the resulting SHA in the session so the
    pre-read hook can skip the disk roundtrip when no change has occurred.
    """
    session = _get_session()
    from . import snapshots

    try:
        with Path(file_path).open("rb") as fh:
            data = fh.read(snapshots.MAX_SNAPSHOT_BYTES + 1)
    except OSError as exc:
        _LOG.debug(
            "post-read snapshot: cannot read %s: %s",
            sanitize_log_str(file_path), exc,
        )
        return
    if len(data) > snapshots.MAX_SNAPSHOT_BYTES:
        _LOG.debug(
            "post-read snapshot: skipping oversized file %s (%d bytes)",
            sanitize_log_str(file_path), len(data),
        )
        return

    result = snapshots.store(session_id, file_path, data)
    if result is None:
        return
    try:
        session.set_snapshot_sha(session_id, file_path, result.content_sha, cache=cache)
    except (ValueError, OSError) as exc:
        _LOG.debug(
            "post-read snapshot: failed to persist SHA for %s: %s",
            sanitize_log_str(file_path), exc,
        )


_surg_hint_cache: dict[tuple[str, int, int, int, bool], str | None] = {}

def _try_surgical_read_hint(
    file_path: str,
    offset: int,
    limit: int,
    cwd: str | None,
    *,
    limit_is_sentinel: bool = False,
) -> str | None:
    """Return a symbol-level suggestion when a line-range read maps to known symbols.

    When the agent uses a Bash read-equivalent command (``sed -n 'M,Np'``,
    ``head``, ``tail``) to read a specific line range, this function queries the
    project index for symbols that overlap [offset, offset+limit-1].  If 1–3
    symbols are found, it returns a hint naming them with the exact
    ``token-goat read`` command, so the agent knows the cheaper path for the
    next access.

    Returns None on any error, when the file is not indexed, or when the range
    overlaps too many symbols (>3) to name usefully.

    ``offset`` is 0-indexed (native Read tool convention: 0 = start at line 1).
    The DB stores 1-indexed line numbers, so the query uses ``offset + 1`` as
    the lower bound and ``offset + limit`` as the inclusive upper bound.

    ``limit_is_sentinel`` — set to True when ``limit`` is a fabricated upper
    bound (used as an EOF proxy for open-ended tail reads).  Prevents the
    sentinel value from leaking into the displayed line range; instead the hint
    shows "Lines N–EOF" rather than an arbitrary large number.
    """
    if offset < 0 or limit <= 0:
        return None
    req_start = offset + 1   # 0-indexed Read offset → 1-indexed DB line number
    req_end = offset + limit  # inclusive upper bound in 1-indexed space
    try:
        from . import db as _db
        from . import read_replacement as _rr
        from .project import find_project

        cwd_path = validate_cwd(cwd, caller="surgical-read-hint")
        if cwd_path is None:
            return None
        proj = find_project(cwd_path)
        if proj is None:
            return None

        abs_path = Path(file_path) if Path(file_path).is_absolute() else (cwd_path / file_path)

        try:
            _mtime_ns = abs_path.stat().st_mtime_ns
        except OSError:
            _mtime_ns = 0
        _abs_str = str(abs_path).lower() if sys.platform == "win32" else str(abs_path)
        _cache_key = (_abs_str, _mtime_ns, req_start, req_end, limit_is_sentinel)
        if _cache_key in _surg_hint_cache:
            return _surg_hint_cache[_cache_key]

        file_rel = _rr.resolve_file_rel(proj, str(abs_path))
        if not file_rel:
            _surg_hint_cache[_cache_key] = None
            return None

        with _db.open_project_readonly(proj.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind FROM symbols "
                "WHERE file_rel = ? AND line <= ? AND end_line >= ? AND end_line IS NOT NULL "
                "ORDER BY line LIMIT 4",
                (file_rel, req_end, req_start),
            ).fetchall()

        if not rows or len(rows) > 3:
            _surg_hint_cache[_cache_key] = None
            return None

        fname = Path(file_rel).name
        sym_names = [row["name"] for row in rows]
        sym_list = ", ".join(f"`{n}`" for n in sym_names)
        primary = sym_names[0]
        cmd = f'token-goat read "{file_rel}::{primary}"'
        range_str = f"Lines {req_start}–EOF" if limit_is_sentinel else f"Lines {req_start}–{req_end}"
        _result = (
            f"{range_str} of `{fname}` span {sym_list}. "
            f"Use `{cmd}` for a surgical read (~90% fewer tok on repeat access)."
        )
        _surg_hint_cache[_cache_key] = _result
        return _result
    except (OSError, ValueError, AttributeError):
        # OSError: DB/file access errors (transient locks, permission)
        # ValueError: path resolution failures, invalid line ranges
        # AttributeError: missing DB column, project attributes
        return None
    except Exception:
        _LOG.warning("surgical-read-hint: unexpected exception", exc_info=True)
        return None


def _build_git_hint(cwd: str | None, file_path: str) -> str | None:
    """Return a compact git-history hint for *file_path*, or None on any failure.

    Looks up the per-project git commit index for recent commits touching the
    file and formats them as a short bullet list.  Fail-soft: any exception
    (missing index, git absent, non-project file) returns None silently.

    The operation is bounded by ``[hints] git_hint_max_ms`` (default 50 ms).
    When the SQLite lookup exceeds this wall-clock threshold the hint is
    skipped and a ``git_hint_timeout`` stat event is recorded so operators
    can observe how often the cap fires.  Set ``git_hint_max_ms = 0`` to
    disable the cap and always wait.
    """
    try:
        from . import config as _cfg_mod
        from . import git_history
        from .project import find_project

        _max_ms: int = _cfg_mod.load().hints.git_hint_max_ms

        cwd_path = validate_cwd(cwd, caller="pre-read-git-hint")
        if cwd_path is None:
            return None
        proj = find_project(cwd_path)
        if proj is None:
            return None
        try:
            _fp = Path(file_path)
            abs_file = _fp if _fp.is_absolute() else (cwd_path / file_path)
            rel_path = abs_file.relative_to(proj.root).as_posix()
        except ValueError:
            return None

        _t0 = time.monotonic()
        result = git_history.build_hint(proj.hash, rel_path)
        _elapsed_ms = (time.monotonic() - _t0) * 1000.0

        if _max_ms > 0 and _elapsed_ms > _max_ms:
            # Hint took too long — skip it this read and record an event so
            # operators can observe the cap via `token-goat stats`.
            _LOG.debug(
                "git-history hint: skipped (%.1f ms > %d ms cap) for %s",
                _elapsed_ms,
                _max_ms,
                sanitize_log_str(file_path),
            )
            record_cached_stat("git_hint_timeout", sanitize_log_str(file_path))
            return None

        return result
    except (OSError, ValueError, AttributeError):
        # OSError: DB/git access failures
        # ValueError: path validation or conversion failures
        # AttributeError: missing git module or project attributes
        return None
    except Exception:
        _LOG.warning("git-history hint: unexpected exception", exc_info=True)
        return None


# Pattern for skill body files: */.claude/skills/<name>/SKILL.md or */.claude/skills/<name>.md
# Also catches plugin layout: */.claude/plugins/<plugin>/skills/<name>/SKILL.md
# And marketplace cache layout:
#   */.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
# The (?:[^/\\]+[/\\])* quantifier allows any number of path segments between
# "plugins/" and "skills/" so all three layout depths are covered by one pattern.
#
# Two match groups are returned:
#   group(1) — the path segment immediately after "skills/".  This is the
#              canonical outer-directory skill name in all known layouts.
#   group(2) — an optional extra segment that appears in the nested subdir
#              layout ``skills/<outer>/<inner>/SKILL.md`` (e.g.
#              ``skills/brainstorming/brainstorming/SKILL.md``).  When
#              present the outer directory (group 1) is the skill name and
#              group(2) is discarded.
_SKILL_FILE_RE = _re.compile(
    r"[/\\]\.claude[/\\](?:plugins[/\\](?:[^/\\]+[/\\])*)?skills[/\\]([^/\\]+)"
    r"(?:"
    r"[/\\]([^/\\]+)[/\\]SKILL\.md"  # nested: <outer>/<inner>/SKILL.md — use <outer>
    r"|[/\\]SKILL\.md"               # standard: <name>/SKILL.md
    r"|\.md"                         # flat: <name>.md
    r")$",
    _re.IGNORECASE,
)


def _detect_skill_name_from_path(file_path: str) -> str | None:
    """Return the skill name if *file_path* points to a skill body file, else None.

    Recognises:
    * ``~/.claude/skills/<name>/SKILL.md``
    * ``~/.claude/skills/<name>.md``
    * ``~/.claude/skills/<name>/<name>/SKILL.md``  (nested subdir layout)
    * ``~/.claude/plugins/<plugin>/skills/<name>/SKILL.md``
    * ``~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/skills/<name>/SKILL.md``
    * The same shapes with Windows backslash separators.

    Returns the bare skill name (e.g. ``"ralph"``), or ``None`` when the path
    is not a skill file.  Always fail-soft.
    """
    try:
        # Fast-exit: both ".claude" and "skills" must be present in the path
        # string before we invest in the full regex.  For the vast majority of
        # Read calls (source files, config files, etc.) this short-circuit saves
        # the regex compile+search entirely.
        fp_lower = file_path.lower()
        if ".claude" not in fp_lower or "skills" not in fp_lower:
            return None
        m = _SKILL_FILE_RE.search(file_path.replace("\\", "/"))
        if m:
            name = m.group(1)
            # Normalize: strip any trailing .md suffix if the file itself IS <name>.md
            # (the flat layout without a subdirectory).
            if name.lower().endswith(".md"):
                name = name[:-3]
            return name.lower() if name else None
    except Exception:
        pass
    return None


def _build_skill_path_index(skill_history: dict) -> dict[str, str]:
    """Build a ``source_path → skill_name`` reverse index from *skill_history*.

    When ``skill_history`` entries carry a non-empty ``source_path``, this
    function maps each normalised path (forward slashes, lower-cased) to its
    skill name so :func:`_handle_skill_file_read` can do an O(1) dict lookup
    for paths it has already seen — bypassing the regex for the common
    "skill already loaded" case.

    Returns an empty dict when *skill_history* is empty or no entries have
    a ``source_path``.  Always fail-soft.
    """
    index: dict[str, str] = {}
    with contextlib.suppress(Exception):
        for name, entry in skill_history.items():
            sp = getattr(entry, "source_path", "") or ""
            if sp:
                normalised = sp.replace("\\", "/").lower()
                index[normalised] = str(name)
    return index


def _handle_skill_file_read(
    session_id: str,
    file_path: str,
    cache: object,
) -> HookResponse | None:
    """Return a hint when the agent tries to Read a skill body file directly.

    When the session already has the skill loaded (via PostToolUse(Skill)), the
    full body is in context and re-reading the file is wasteful.  Suggest
    ``token-goat skill-body <name>`` as the cheaper recall path.

    Returns None when:
    * *file_path* is not a skill body file
    * the skill is not recorded in the session (first load — let it proceed)
    * the session cache is unavailable

    When the body has changed on disk since caching, lets the read proceed
    (returns None) but also emits a stale-compact advisory hint so the model
    knows to run ``token-goat skill-compact <name>`` after loading the new body.
    """
    if not _cache_is_available(cache):
        return None

    skill_history: dict[str, object] = getattr(cache, "skill_history", {})
    if not isinstance(skill_history, dict) or not skill_history:
        return None

    # --- O(1) path-index lookup (Improvement 2) ----------------------------
    # Build (or reuse) a {normalised_source_path: skill_name} index from the
    # session's skill_history so we can identify known skill files without
    # running the regex on every Read.  The index is cached as _skill_path_index
    # on the cache object to amortise the build cost across hook invocations.
    #
    # Type-check the retrieved value: MagicMock test objects yield a MagicMock
    # for every attribute access, so we must verify the cached value is actually
    # a dict before treating it as a valid index.
    skill_name: str | None = None
    _cached_index = getattr(cache, "_skill_path_index", None)
    path_index: dict[str, str] | None = _cached_index if isinstance(_cached_index, dict) else None
    if path_index is None:
        path_index = _build_skill_path_index(skill_history)
        with contextlib.suppress(AttributeError):
            cache._skill_path_index = path_index  # type: ignore[attr-defined]

    if path_index:
        normed = file_path.replace("\\", "/").lower()
        skill_name = path_index.get(normed)

    # Fall back to regex when not in the index (new skill path or index miss).
    if skill_name is None:
        skill_name = _detect_skill_name_from_path(file_path)
    if skill_name is None:
        return None

    # Check both the bare name and common casing variants.
    matched_entry = (
        skill_history.get(skill_name)
        or skill_history.get(skill_name.lower())
    )
    if matched_entry is None:
        return None

    # Diff-aware staleness check: if the skill file on disk has changed SINCE
    # the body was cached, the cached copy no longer matches.  Redirecting to a
    # stale cache would cause the agent to miss updates; let the read proceed and
    # the PostToolUse(Skill) handler will refresh the cache on the next load.
    #
    # Gate: we only consider staleness when:
    #   1. content_sha and source_path are both non-empty (cache has provenance).
    #   2. The file's mtime is NEWER than the cache timestamp (entry.ts).  If the
    #      file was last modified BEFORE the cache was written, the cache is not
    #      stale — there is nothing new to re-read.  This prevents false-positives
    #      when a test or user caches a synthetic body for a real skill file: the
    #      cache timestamp would be newer than the file, so the check is skipped.
    cached_sha = getattr(matched_entry, "content_sha", "") or ""
    source_path = getattr(matched_entry, "source_path", "") or ""
    # ts is a Unix timestamp; 0.0 = epoch (also valid).  Use -1.0 as the
    # "unknown" sentinel — a missing or non-numeric ts means skip the check.
    _raw_ts = getattr(matched_entry, "ts", None)
    try:
        cache_ts = float(_raw_ts) if _raw_ts is not None else -1.0
    except (TypeError, ValueError):
        cache_ts = -1.0
    if cached_sha and source_path and cache_ts >= 0.0:
        try:
            from pathlib import Path as _Path

            src_path_obj = _Path(source_path)
            file_mtime = src_path_obj.stat().st_mtime
            # Only perform the SHA comparison when the file was modified after
            # the cache was written.  If file_mtime <= cache_ts the file has not
            # changed since caching — short-circuit without reading the full file.
            if file_mtime > cache_ts:
                disk_bytes = src_path_obj.read_bytes()
                disk_sha = hashlib.sha256(disk_bytes).hexdigest()
                if disk_sha != cached_sha:
                    _LOG.info(
                        "pre-read: skill '%s' cache stale (file mtime %.0f > cache ts %.0f, "
                        "disk sha %s…  != cached %s…); allowing read to proceed",
                        sanitize_log_str(skill_name),
                        file_mtime,
                        cache_ts,
                        disk_sha[:12],
                        cached_sha[:12],
                    )
                    # --- Stale compact advisory hint (Improvement 3) -------
                    # The body changed; the read will proceed. Check whether
                    # the stored compact is also stale (its embedded source_sha
                    # no longer matches the new disk_sha). If so, emit a
                    # stale-compact warning so the model knows to regenerate it
                    # after loading the refreshed skill body.
                    _emit_stale_compact_hint(
                        skill_name=skill_name,
                        disk_sha=disk_sha,
                        session_id=getattr(cache, "session_id", ""),
                        cache=cache,
                        file_path=file_path,
                    )
                    # Invalidate the path index so a fresh build picks up the
                    # updated source_path when the skill is re-cached.
                    with contextlib.suppress(AttributeError):
                        del cache._skill_path_index  # type: ignore[attr-defined]
                    return None
        except OSError:
            # File not found or unreadable — can't verify staleness; emit hint.
            pass

    from .hints import _hint_fingerprint

    hint_text = (
        f"Skill '{skill_name}' in context (loaded via Skill tool). "
        f"Recall: `token-goat skill-body {skill_name}` (~95% fewer tok). "
        f"Section: `token-goat skill-section {skill_name} <heading>`."
    )
    fingerprint = _hint_fingerprint(hint_text, path=file_path)
    mark_seen = getattr(cache, "mark_hint_seen", None)
    if callable(mark_seen):
        # Suppress if already emitted for this path this session.
        if getattr(cache, "has_hint_fingerprint", lambda _: False)(fingerprint):
            return None
        mark_seen(fingerprint)

    record_hint_stat_pair("skill_file_read_hint", hint_text, sanitize_log_str(file_path, max_len=512))
    _LOG.info(
        "pre-read: skill-file hint injected for %s (skill=%s)",
        sanitize_log_str(file_path), sanitize_log_str(skill_name),
    )
    return pre_tool_use_with_context(hint_text)


def _emit_stale_compact_hint(
    *,
    skill_name: str,
    disk_sha: str,
    session_id: str,
    cache: object,
    file_path: str,
) -> None:
    """Emit a best-effort advisory when a skill body change makes the compact stale.

    Called by :func:`_handle_skill_file_read` immediately before returning
    ``None`` (allowing the read) when diff-aware invalidation detects that the
    on-disk skill body has changed since the cached copy was written.

    Checks whether the session has a stored compact for *skill_name* whose
    embedded ``source_sha`` no longer matches the new *disk_sha*.  When stale,
    injects a one-line advisory via ``pre_tool_use_with_context`` so the model
    learns it should regenerate the compact after loading the updated body.

    The hint is always dedup-gated (suppressed when already emitted this
    session) and fail-soft (any I/O error is logged at DEBUG and swallowed).
    """
    if not skill_name or not session_id:
        return
    try:
        from . import skill_cache as _sc
        from .hints import _hint_fingerprint

        compact_text = _sc.get_compact(session_id, skill_name)
        if compact_text is None:
            return  # no compact to be stale

        compact_sha = _sc.extract_compact_source_sha(compact_text) or ""
        if not compact_sha:
            return  # compact predates source-sha tracking — nothing to compare

        if compact_sha == disk_sha[:len(compact_sha)]:
            return  # compact is current; no advisory needed

        hint_text = (
            f"Note: skill '{skill_name}' body has changed on disk (SHA mismatch). "
            f"The cached compact is now stale. "
            f"After loading the updated skill, run: `token-goat skill-compact {skill_name}` "
            f"to regenerate the compact with the new body."
        )
        fingerprint = _hint_fingerprint(hint_text, path=file_path)
        mark_seen = getattr(cache, "mark_hint_seen", None)
        if callable(mark_seen):
            if getattr(cache, "has_hint_fingerprint", lambda _: False)(fingerprint):
                return
            mark_seen(fingerprint)

        record_hint_stat_pair(
            "stale_compact_hint",
            hint_text,
            sanitize_log_str(file_path, max_len=512),
        )
        _LOG.info(
            "pre-read: stale-compact advisory for skill '%s' "
            "(compact sha %s… != disk sha %s…)",
            sanitize_log_str(skill_name),
            compact_sha[:8],
            disk_sha[:8],
        )
        # Advisory only — we intentionally do NOT return the hint response here.
        # The caller (_handle_skill_file_read) already returns None to let the
        # read proceed; the advisory is recorded in stats for session awareness.
    except Exception:
        _LOG.debug("_emit_stale_compact_hint: unexpected error (fail-soft)", exc_info=True)


def _emit_dedup_budgeted_hint(
    *,
    hint: object,
    file_path: str,
    cache: object,
    budget_kind: str,
    record_emitted_fn: Callable[[object], None],
    stat_kind: str,
    display_name: str,
) -> HookResponse | None:
    """Shared dedup → budget → mark-seen → record → emit pipeline for one-shot pre-read hints.

    Caller supplies the already-built *hint* (or ``None`` for "do nothing") plus
    four event-specific knobs: *budget_kind* (``_HINT_KIND_*`` constant),
    *record_emitted_fn* (per-session emit counter), *stat_kind* (stats DB label),
    *display_name* (hyphenated label for log lines).  Returns the hook response
    when the hint fires, or ``None`` when suppressed (already seen, budget
    exhausted) or no hint was supplied.  Previously inlined identically in
    ``_handle_index_only_file`` and ``_handle_structured_file``.

    Budget semantics — ``record_emitted_fn`` (and therefore the per-kind counter
    such as ``structured_hints_emitted``) is called **only when a hint or stub is
    actually emitted**.  Hints suppressed entirely by the dedup gate (seen in this
    session and ``verbose_until_seen_count == 0``) do **not** increment the counter.
    This is intentional: the ``max_structured_per_session`` cap counts
    *total hint firings* (i.e., messages the model actually received), not the
    number of file paths that triggered the check.  A suppressed hint consumes no
    model context, so it should not be charged against the budget.
    """
    if hint is None:
        return None

    from .hints import _hint_budget_check, _hint_fingerprint, _make_short_stub_hint

    # Dedup: check if identical hint already seen this session for this path.
    fingerprint = _hint_fingerprint(str(hint), path=file_path)
    hints_seen_dict = getattr(cache, "hints_seen", {})  # type: ignore[arg-type]  # getattr returns object; dict literal default keeps this safe at runtime
    seen_count = hints_seen_dict.get(fingerprint, 0) if isinstance(hints_seen_dict, dict) else 0

    if seen_count > 0:
        # Hint has been emitted before in this session.
        # Check if we should emit a short stub instead of suppressing entirely.
        try:
            from . import config as _config
            cfg = _config.load().hints
            verbose_until = cfg.verbose_until_seen_count
        except (OSError, ValueError, AttributeError):
            # OSError: config file not found or unreadable
            # ValueError: invalid TOML/config format
            # AttributeError: missing config sections
            verbose_until = 2  # default
        except Exception:
            _LOG.debug("dedup budget check: config load failed unexpectedly", exc_info=True)
            verbose_until = 2  # default

        if verbose_until == 0:
            # Feature disabled: always suppress duplicate hints entirely.
            _LOG.debug(
                "pre-read: %s hint already seen for %s; suppressing (verbose_until_seen_count=0)",
                display_name, sanitize_log_str(file_path),
            )
            return None
        if seen_count >= verbose_until:
            # Threshold reached: emit short stub instead of full hint.
            # Apply the same budget gate as the full-emit path so the cap
            # cannot be bypassed via unlimited stub emissions.
            _session_mod = _get_session()
            if isinstance(cache, _session_mod.SessionCache) and not _hint_budget_check(cache, budget_kind):
                _LOG.debug(
                    "pre-read: %s stub budget exhausted for %s",
                    display_name, sanitize_log_str(file_path),
                )
                return None
            stub_hint = _make_short_stub_hint(seen_count)
            mark_seen = getattr(cache, "mark_hint_seen", None)
            if callable(mark_seen):
                mark_seen(fingerprint)
            if isinstance(cache, _session_mod.SessionCache):
                record_emitted_fn(cache)
            record_hint_stat_pair(stat_kind, stub_hint, sanitize_log_str(file_path, max_len=512))
            _LOG.debug(
                "pre-read: %s hint short-stub for %s (seen %d times)",
                display_name, sanitize_log_str(file_path), seen_count,
            )
            return pre_tool_use_with_context(str(stub_hint))
        # else: within verbose_until window — fall through to the full emit path below.
        # The budget check, mark-seen, and record steps all apply to re-emissions too.

    # Budget: hard cap on hints of this kind per session.
    _session = _get_session()
    if isinstance(cache, _session.SessionCache) and not _hint_budget_check(cache, budget_kind):
        _LOG.debug(
            "pre-read: %s hint budget exhausted for %s",
            display_name, sanitize_log_str(file_path),
        )
        return None

    mark_seen = getattr(cache, "mark_hint_seen", None)
    if callable(mark_seen):
        mark_seen(fingerprint)

    if isinstance(cache, _session.SessionCache):
        record_emitted_fn(cache)

    record_hint_stat_pair(stat_kind, hint, sanitize_log_str(file_path, max_len=512))
    _LOG.info(
        "pre-read: %s hint injected for %s (%s)",
        display_name, sanitize_log_str(file_path), str(hint)[:60],
    )
    return pre_tool_use_with_context(str(hint))


def _handle_index_only_file(
    session_id: str,
    file_path: str,
    tool_input: dict[str, object],
    cache: object,
) -> HookResponse | None:
    """Return a hint when Read targets a machine-generated index-only file.

    Fires BEFORE the structured-file branch so lockfiles and bundles are caught
    immediately without falling through to the CSV/JSON/log heuristics.  Tracks
    the hint in the session fingerprint set so it fires at most once per file
    per session.

    Returns ``None`` when the file is small, not an index-only type, or the
    caller already scoped the read with offset AND limit (surgical intent).
    """
    from .hints import (
        _HINT_KIND_INDEX_ONLY,
        _record_index_only_hint_emitted,
        build_index_only_file_hint,
    )

    hint = build_index_only_file_hint(
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
    )
    return _emit_dedup_budgeted_hint(
        hint=hint,
        file_path=file_path,
        cache=cache,
        budget_kind=_HINT_KIND_INDEX_ONLY,
        record_emitted_fn=_record_index_only_hint_emitted,
        stat_kind="index_only_hint",
        display_name="index-only",
    )


def _handle_doc_compact(
    file_path: str,
    cwd: str | None,
    cache: object,
) -> HookResponse | None:
    """Serve a user-created compact sidecar for a large markdown reference doc.

    When a fresh compact sidecar exists, returns a deny-redirect that serves the
    compact body instead of the full file.  For large uncompacted markdown with
    indexed sections, returns a section-map hint.  Returns None for non-markdown
    files, small files, and when stable_doc_compacts is disabled.
    """
    from .hints import DOC_COMPACT_SERVE_SENTINEL, build_doc_compact_hint

    hint = build_doc_compact_hint(file_path, cwd, cache=cache)  # type: ignore[arg-type]
    if hint is None:
        return None

    hint_text = str(hint)
    if hint_text.startswith(DOC_COMPACT_SERVE_SENTINEL):
        # Compact serve: deny the full read, inject compact body as context.
        content = hint_text[len(DOC_COMPACT_SERVE_SENTINEL):]
        from .db import record_stat
        if hint.tokens_saved > 0:
            try:
                from .project import find_project
                _proj = find_project(validate_cwd(cwd) or Path())
                record_stat(
                    _proj.hash if _proj else None,
                    "doc_compact_served",
                    tokens_saved=hint.tokens_saved,
                    detail=file_path,
                )
            except Exception:
                pass
        return deny_redirect("doc-compact: serving compact instead of full file", content)

    # Section-map hint or stale warning: let the read proceed, inject hint.
    # Fire-and-forget compact-doc so the sidecar is ready on the next read.
    _fp_key = f"compact_doc_spawned:{file_path}"
    if cache is not None:
        with contextlib.suppress(Exception):
            if not cache.has_hint_fingerprint(_fp_key):  # type: ignore[attr-defined]
                cache.mark_hint_seen(_fp_key)  # type: ignore[attr-defined]
                import shutil as _shutil
                import subprocess as _subprocess
                _exe = _shutil.which("token-goat")
                if _exe:
                    _subprocess.Popen(
                        [_exe, "compact-doc", file_path],
                        stdin=_subprocess.DEVNULL,
                        stdout=_subprocess.DEVNULL,
                        stderr=_subprocess.DEVNULL,
                    )
    return pre_tool_use_with_context(hint_text)


def _handle_structured_file(
    session_id: str,
    file_path: str,
    tool_input: dict[str, object],
    cache: object,
) -> HookResponse | None:
    """Return a hint when Read targets a large structured data file (CSV/JSON/log).

    Fires BEFORE session-hint and diff-hint paths so that a first-time Read of a
    large CSV is intercepted immediately, not only on repeat reads.  Tracks the hint
    in the session fingerprint set so it fires at most once per file per session.

    Returns ``None`` when the file is small, not a structured type, or the caller
    already scoped the read with offset AND limit (surgical intent).
    """
    from .hints import (
        _HINT_KIND_STRUCTURED,
        _record_structured_hint_emitted,
        build_structured_file_hint,
    )

    hint = build_structured_file_hint(
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
    )
    return _emit_dedup_budgeted_hint(
        hint=hint,
        file_path=file_path,
        cache=cache,
        budget_kind=_HINT_KIND_STRUCTURED,
        record_emitted_fn=_record_structured_hint_emitted,
        stat_kind="structured_file_hint",
        display_name="structured-file",
    )


def _record_session_hint_impact(file_path: str, hint: str) -> None:
    """Record net impact of session hints: avoided re-reads minus injection overhead.

    Session hints warn the user about file content already in context, enabling them to
    skip redundant reads. This function records both the gross tokens/bytes saved
    (realized when user avoids the re-read) and the injection cost (the hint text itself).
    Net impact = savings - overhead.

    Args:
        file_path: Path of the file being read (recorded in stats detail).
        hint: ReadHint string instance with .tokens_saved attribute set.
    """
    record_hint_stat_pair("session_hint", hint, sanitize_log_str(file_path, max_len=512))


def _try_unchanged_file_hint(
    session_id: str,
    file_path: str,
    tool_input: dict[str, object],
    cache: object,
) -> HookResponse | None:
    """Return a hint when the file content matches its session snapshot.

    Fires only for full-file reads (no offset AND no limit supplied) because a
    surgical read with explicit bounds is intentional — the agent wants a
    specific slice, not the whole file, and the short-circuit advice would be
    misleading.

    Returns None when:
    * the agent supplied offset or limit (surgical intent)
    * no snapshot SHA is stored for this (session, file)
    * the file was not edited after the last read in this session
    * the current SHA differs from the stored snapshot SHA (content changed)
    * the snapshot is older than the staleness cap
    * the file is too small to be worth a hint
    """
    from .hints import build_unchanged_file_hint

    # Only short-circuit full reads.  offset OR limit present → let through.
    offset = tool_input.get("offset")
    limit = tool_input.get("limit")
    if offset is not None or limit is not None:
        return None

    hint = build_unchanged_file_hint(
        session_id=session_id, file_path=file_path, cache=cache,
    )
    if hint is None:
        return None

    record_hint_stat_pair(
        "unchanged_file_hint", hint, sanitize_log_str(file_path, max_len=512)
    )
    _LOG.info(
        "pre-read: unchanged-file hint injected for %s (tokens_saved=%d)",
        sanitize_log_str(file_path), hint.tokens_saved,
    )
    return pre_tool_use_with_context(str(hint))


def _try_diff_hint(
    session_id: str,
    file_path: str,
    *,
    req_start: int | None = None,
    req_end: int | None = None,
    entry_line_ranges: list[tuple[int, int]] | None = None,
) -> HookResponse | None:
    """Return a diff-hint hook response when one applies, otherwise ``None``.

    Loads *file_path* from disk so the diff builder can compare against the
    stored session snapshot.  Skips files that cannot be read or that exceed
    the snapshot size cap (the snapshot would be missing in that case anyway).

    When *req_start* / *req_end* and *entry_line_ranges* are provided, the hint
    is suppressed when the requested read range does not overlap any of the
    previously-read line ranges.  This avoids false positives when the agent is
    reading a section of the file that was never in context before — there is
    nothing to diff against for that section, so emitting the diff is noise.

    Records the realized saving as a ``diff_hint`` stat row plus a
    ``diff_hint_overhead`` row covering the hint's own injection cost — same
    honest-accounting pattern used by the session_hint path.
    """
    # Range-overlap guard (Item A26): suppress the diff hint when the requested
    # read range is entirely outside every cached read range.  Uses the same
    # proximity-slop constant as the read-hint proximity check so both checks
    # are tuned by a single constant.
    if (
        req_start is not None
        and req_end is not None
        and entry_line_ranges
        and entry_line_ranges != [(0, 0)]  # collapsed sentinel = full file
    ):
        from .hints import _PROXIMITY_SLOP_LINES, _line_ranges_global_bounds

        global_min, global_max = _line_ranges_global_bounds(entry_line_ranges)
        if req_start > global_max + _PROXIMITY_SLOP_LINES or req_end < global_min - _PROXIMITY_SLOP_LINES:
            _LOG.debug(
                "diff-hint: suppressed for %s (range [%d,%d] outside cached [%d,%d] ±%d)",
                sanitize_log_str(file_path),
                req_start,
                req_end,
                global_min,
                global_max,
                _PROXIMITY_SLOP_LINES,
            )
            return None

    from . import snapshots
    from .hints import build_diff_hint

    try:
        with Path(file_path).open("rb") as fh:
            current_bytes = fh.read(snapshots.MAX_SNAPSHOT_BYTES + 1)
    except OSError as exc:
        _LOG.debug("diff-hint: cannot read %s: %s", sanitize_log_str(file_path), exc)
        return None
    if len(current_bytes) > snapshots.MAX_SNAPSHOT_BYTES:
        # Beyond the snapshot cap there is nothing on disk to diff against;
        # fall back to the standard hint path.
        return None

    current_text = current_bytes.decode("utf-8", errors="replace")
    hint = build_diff_hint(
        session_id=session_id, file_path=file_path, current_text=current_text,
    )
    if hint is None:
        return None

    record_hint_stat_pair("diff_hint", hint, sanitize_log_str(file_path, max_len=512))
    # Predictive-prefetch attribution.  When the snapshot was written
    # speculatively by post_edit's import-following path, count this diff hit
    # as a predictive prefetch payoff: the hint saved tokens *because* the
    # snapshot existed *before* the agent ever read the file.  Without the
    # prefetch, no snapshot would exist and no diff hint would fire.  A
    # second stat row makes this measurable in `token-goat stats` without
    # double-counting the saving (we record bytes_saved=0 to avoid that).
    try:
        snapshot_kind = snapshots.load_kind(session_id, file_path)
    except (OSError, KeyError, AttributeError):
        # OSError: snapshot file not found or unreadable
        # KeyError: session entry missing from snapshot index
        # AttributeError: missing snapshot attributes
        snapshot_kind = None
    except Exception:
        _LOG.debug("diff-hint: snapshot kind lookup failed", exc_info=True)
        snapshot_kind = None
    if snapshot_kind == "predictive":
        from . import db as _db

        try:
            _db.record_stat(
                None,
                "predictive_prefetch_hit",
                bytes_saved=0,
                tokens_saved=0,
                detail=sanitize_log_str(file_path, max_len=512),
            )
        except (OSError, ValueError):
            # OSError: database write failure (disk full, permission denied)
            # ValueError: invalid stat kind or detail format
            _LOG.debug("predictive-snapshot: stat record failed", exc_info=True)
        except Exception:
            _LOG.warning("predictive-snapshot: unexpected error during stat record", exc_info=True)
        _LOG.info(
            "pre-read: predictive-snapshot hit for %s (tokens_saved=%d)",
            sanitize_log_str(file_path), hint.tokens_saved,
        )
    _LOG.info(
        "pre-read: diff-hint injected for %s (tokens_saved=%d)",
        sanitize_log_str(file_path), hint.tokens_saved,
    )
    from . import config as _cfg_inj
    from .injection import check_hint_for_injection
    if _cfg_inj.load().injection.enabled:
        hint_str = check_hint_for_injection(str(hint), source=file_path)
    else:
        hint_str = str(hint)
    return pre_tool_use_with_context(hint_str)


def _try_diff_serve(
    session_id: str,
    file_path: str,
    *,
    req_start: int | None = None,
    req_end: int | None = None,
    entry_line_ranges: list[tuple[int, int]] | None = None,
) -> HookResponse | None:
    """Intercept a re-read of a changed file and serve a unified diff instead.

    When ``[hints] serve_diff_on_reread = true``, this function fires *before*
    the normal diff-hint path.  If a session snapshot exists for *file_path* and
    the file content has changed since the snapshot was taken, the pre-read hook
    is converted from "add a hint and let the Read proceed" to "block the Read
    and serve the diff as the tool result."  The model receives a compact unified
    diff in context rather than the full file, which can save 10-100x tokens when
    only a few lines changed.

    The function re-uses the same range-overlap guard from :func:`_try_diff_hint`
    so partial reads of unrelated file sections are not intercepted.

    Returns a :data:`~hooks_common.HookResponse` using :func:`deny_redirect` (a
    ``permissionDecision: deny`` response with the diff in ``additionalContext``)
    when a diff was generated and the saving clears a minimum threshold, or
    ``None`` otherwise.

    Records the realized saving as a ``diff_served`` stat row with
    ``bytes_saved = file_size - diff_size``.

    Note: the *serve_diff_on_reread* config flag **must** be checked by the
    caller before invoking this function — the function itself does not re-read
    the config so it can be called from a hot path without an extra config load.
    """
    import difflib

    # Range-overlap guard: same logic as _try_diff_hint.
    if (
        req_start is not None
        and req_end is not None
        and entry_line_ranges
        and entry_line_ranges != [(0, 0)]
    ):
        from .hints import _PROXIMITY_SLOP_LINES, _line_ranges_global_bounds

        global_min, global_max = _line_ranges_global_bounds(entry_line_ranges)
        if req_start > global_max + _PROXIMITY_SLOP_LINES or req_end < global_min - _PROXIMITY_SLOP_LINES:
            _LOG.debug(
                "diff-serve: suppressed for %s (range [%d,%d] outside cached [%d,%d] ±%d)",
                sanitize_log_str(file_path),
                req_start,
                req_end,
                global_min,
                global_max,
                _PROXIMITY_SLOP_LINES,
            )
            return None

    from . import snapshots

    # Load the snapshot (what the model last saw for this file).
    snapshot_bytes = snapshots.load(session_id, file_path)
    if snapshot_bytes is None:
        return None

    # Load the current file content.
    try:
        with Path(file_path).open("rb") as fh:
            current_bytes = fh.read(snapshots.MAX_SNAPSHOT_BYTES + 1)
    except OSError as exc:
        _LOG.debug("diff-serve: cannot read %s: %s", sanitize_log_str(file_path), exc)
        return None
    if len(current_bytes) > snapshots.MAX_SNAPSHOT_BYTES:
        return None

    # If file unchanged, nothing to serve.
    if current_bytes == snapshot_bytes:
        return None

    # Decode both sides for difflib.
    snapshot_text = snapshot_bytes.decode("utf-8", errors="replace")
    current_text = current_bytes.decode("utf-8", errors="replace")

    # Generate a unified diff.
    import os.path as _osp

    fname = _osp.basename(file_path)
    # NOTE: splitlines() WITHOUT keepends pairs with lineterm="" and "\n".join
    # below. Mixing keepends=True with lineterm="" double-counts newlines —
    # content rows keep their own "\n" and the join adds another, producing
    # doubled blank lines in the rendered diff.
    diff_lines = list(difflib.unified_diff(
        snapshot_text.splitlines(),
        current_text.splitlines(),
        fromfile=f"a/{fname}",
        tofile=f"b/{fname}",
        lineterm="",
    ))

    if not diff_lines:
        # No textual diff (e.g. only BOM or encoding change) — fall through.
        return None

    diff_text = "\n".join(diff_lines)
    diff_bytes = len(_utf8_bytes(diff_text))
    file_size = len(current_bytes)

    # Only intercept when the diff is meaningfully smaller than the full file.
    # A diff larger than 50% of the file provides diminishing returns and risks
    # confusing the model with a near-complete diff instead of the file itself.
    if diff_bytes >= file_size * 0.5:
        _LOG.debug(
            "diff-serve: skipping for %s (diff=%d bytes >= 50%% of file=%d bytes)",
            sanitize_log_str(file_path), diff_bytes, file_size,
        )
        return None

    bytes_saved = max(0, file_size - diff_bytes)

    # Record the stat.
    from . import db as _db

    try:
        _db.record_stat(
            None,
            "diff_served",
            bytes_saved=bytes_saved,
            tokens_saved=max(1, bytes_saved // 3 + 1) if bytes_saved > 0 else 0,
            detail=sanitize_log_str(file_path, max_len=512),
        )
    except Exception:
        _LOG.debug("diff-serve: stat record failed for %s", sanitize_log_str(file_path), exc_info=True)

    _LOG.info(
        "pre-read: diff-serve blocking Read for %s (bytes_saved=%d, diff=%d bytes)",
        sanitize_log_str(file_path), bytes_saved, diff_bytes,
    )

    _tokens_saved_est = max(1, bytes_saved // 3 + 1) if bytes_saved > 0 else 0
    context_msg = (
        f"token-goat intercepted the Read of `{sanitize_log_str(file_path, max_len=200)}` "
        f"and is serving a unified diff instead of the full file to save ~{_tokens_saved_est} tokens.\n"
        f"The diff shows changes since you last read this file:\n\n"
        f"```diff\n{diff_text}\n```\n\n"
        f"If you need the full file content, run: `token-goat read \"{sanitize_log_str(file_path, max_len=200)}\"`"
    )

    return deny_redirect(
        reason="token-goat serves diff instead of full file re-read to save tokens",
        context=context_msg,
    )


def _extract_grep_args(payload: HookPayload) -> tuple[str, str | None] | None:
    """Extract and validate the ``pattern`` and optional ``path`` from a Grep payload.

    Returns ``(pattern, path)`` when ``pattern`` is a non-empty string.
    Returns ``None`` when the pattern is absent, non-string, or empty — which
    signals the caller to short-circuit and return ``None`` itself.

    ``path`` is normalised to ``None`` when the payload value is present but
    not a string (e.g. the harness sent a list or integer).

    Previously copied verbatim into :func:`_handle_grep_dedup` and
    :func:`_handle_glob_dedup`; centralised here so the identical validation
    logic lives once.
    """
    tool_input = get_tool_input(payload)
    pattern = tool_input.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return None
    path = tool_input.get("path")
    if path is not None and not isinstance(path, str):
        path = None
    return pattern, path


def _handle_grep_dedup(payload: HookPayload) -> HookResponse | None:
    """Return cached Grep results or a dedup hint when the same pattern ran recently.

    When a cached result exists in bash_cache for this (session, pattern, path,
    glob, type, output_mode) key and the entry is within STALE_READ_AGE_SECONDS,
    the cached text is injected as additionalContext so the agent receives the
    result without the Grep tool running again.  Falls back to the advisory
    hint when no cached result is available.
    """
    from .hints import (
        STALE_READ_AGE_SECONDS,
        build_grep_dedup_hint,
        compute_stale_threshold,
    )

    args = _extract_grep_args(payload)
    if args is None:
        return None
    pattern, path = args

    tool_input = get_tool_input(payload)
    glob_filter = tool_input.get("glob") if isinstance(tool_input.get("glob"), str) else None
    type_filter = tool_input.get("type") if isinstance(tool_input.get("type"), str) else None
    output_mode = tool_input.get("output_mode") if isinstance(tool_input.get("output_mode"), str) else None

    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return None

    try:
        import time as _time

        from . import bash_cache as _bc
        from . import session as _sess_mod2
        _sess = _get_session()
        cache = _sess.load(session_id)
        grep_entry = _sess_mod2.lookup_grep_entry(session_id, pattern, path, cache=cache)
        if grep_entry is not None:
            _now = _time.time()
            age = _now - grep_entry.ts
            _sess_created = getattr(cache, "created_ts", None)
            _sess_age = (_now - _sess_created) if _sess_created is not None else STALE_READ_AGE_SECONDS
            _stale_thresh = compute_stale_threshold(_sess_age)
            if age <= _stale_thresh:
                cached_result = _bc.load_grep_result(session_id, pattern, path, glob_filter, type_filter, output_mode)
                if cached_result is not None:
                    path_label = f" in {path!r}" if path else ""
                    # Apply rollup for large files_with_matches results; pass content mode verbatim.
                    _cached_lines = [ln for ln in cached_result.splitlines() if ln.strip()]
                    if (output_mode or "files_with_matches") == "files_with_matches" and len(_cached_lines) > _GLOB_ROLLUP_THRESHOLD:
                        _cached_display = _rollup_glob_paths(cached_result)
                    else:
                        _cached_display = cached_result
                    result_count = grep_entry.result_count
                    hint_text = (
                        f"Note: Grep `{sanitize_log_str(pattern, max_len=100)}`{path_label} "
                        f"ran {int(age)}s ago — cached result ({result_count or '?'} matches):\n"
                        f"{_cached_display}\n"
                        "(Serving from cache. Run without hints to force a fresh search.)"
                    )
                    record_cached_stat("grep_result_cache_hit", sanitize_log_str(pattern, max_len=200))
                    _LOG.info(
                        "pre-read: grep result cache hit for pattern=%s (age=%ds)",
                        sanitize_log_str(pattern, max_len=100), int(age),
                    )
                    return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: grep result cache check failed", exc_info=True)

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_grep_dedup_hint(
            session_id=sid, pattern=pattern, path=path, cache=cache,
        ),
        stat_kind="grep_dedup_hint",
        detail=sanitize_log_str(pattern, max_len=200),
        log_label="pre-read",
    )


_GREP_WRITTEN_NOT_READ_MAX_PATHS = 5


def _handle_grep_written_not_read(payload: HookPayload) -> HookResponse | None:
    """Hint when Grep targets a file (or directory) written this session but not yet read back.

    Single-file path: when ``path`` resolves to a specific file that was written
    (Edit/Write/MultiEdit) this session and has never been read back, the content
    the agent wrote may still be visible in context from the Write/Edit tool result
    — making a Grep redundant.

    Directory path: when ``path`` is a directory, scan all edited files under that
    directory and emit a capped hint listing up to
    :data:`_GREP_WRITTEN_NOT_READ_MAX_PATHS` of them.
    """
    session = _get_session()

    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return None

    tool_input = get_tool_input(payload)
    path = tool_input.get("path")
    if not isinstance(path, str) or not path:
        return None

    cache = load_session_safe(session_id)
    if not _cache_is_available(cache):
        return None

    _edited: dict[str, int] = cache.edited_files if isinstance(cache.edited_files, dict) else {}  # type: ignore[union-attr]

    # --- single-file path ---------------------------------------------------
    _written_key = session._normalize_path(path)  # type: ignore[attr-defined]  # private function on lazy-loaded session module (types.ModuleType has no typed attrs)
    _edit_count = _edited.get(_written_key, 0)
    if _edit_count >= 1 and _written_key not in cache.files:  # type: ignore[union-attr]
        fname = sanitize_log_str(Path(path).name, max_len=256)
        hint_text = (
            f"Note: `{fname}` was written {_edit_count}x this session and not yet read back. "
            f"The content you wrote may still be in context from the tool result — "
            f"check there before grepping. For a specific symbol use "
            f"`token-goat read \"{path}::SymbolName\"`."
        )
        _LOG.debug(
            "pre-read: grep written-not-read hint for %s (edit_count=%d)",
            sanitize_log_str(path), _edit_count,
        )
        return pre_tool_use_with_context(hint_text)

    # --- directory-scope path -----------------------------------------------
    # Collect edited-but-not-yet-read files whose normalised key starts with
    # the normalised directory prefix.  Cap the list at _GREP_WRITTEN_NOT_READ_MAX_PATHS
    # to avoid injecting a 30–50 path blob when a large refactor touched many files.
    _dir_key = session._normalize_path(path)  # type: ignore[attr-defined]  # private function on lazy-loaded session module (types.ModuleType has no typed attrs)
    # Normalised paths use forward slashes; ensure the prefix ends with one so
    # "src/foo" doesn't match "src/foobar".
    _dir_prefix = _dir_key if _dir_key.endswith("/") else _dir_key + "/"
    _dir_matches = [
        (p, c) for p, c in _edited.items()
        if p.startswith(_dir_prefix) and p not in cache.files and c >= 1  # type: ignore[union-attr]
    ]
    if not _dir_matches:
        return None

    _dir_matches.sort(key=lambda x: x[1], reverse=True)
    _shown = _dir_matches[:_GREP_WRITTEN_NOT_READ_MAX_PATHS]
    _overflow = len(_dir_matches) - len(_shown)
    _path_lines = "\n".join(f"  {sanitize_log_str(p, max_len=256)}" for p, _ in _shown)
    if _overflow > 0:
        _path_lines += f"\n  (+{_overflow} more edited)"
    hint_text = (
        f"Note: {len(_dir_matches)} file(s) under `{sanitize_log_str(path, max_len=200)}` "
        f"were written this session and not yet read back:\n{_path_lines}\n"
        f"Their content may still be in context from the tool results — "
        f"check there before grepping. For a specific symbol use "
        f"`token-goat read \"<path>::SymbolName\"`."
    )
    _LOG.debug(
        "pre-read: grep written-not-read dir hint for %s (%d files)",
        sanitize_log_str(path), len(_dir_matches),
    )
    return pre_tool_use_with_context(hint_text)


# Matches pure code identifiers (letters, digits, underscores, $) that are
# valid symbol names in Python, JS, TS, Go, Rust, etc.  Patterns with regex
# metacharacters, spaces, dots, slashes, or other special chars are excluded
# so we only query the index for unambiguous symbol-name greps.
_IDENTIFIER_RE = _re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]{2,}$")

# Matches two-part dotted names (e.g. ``Session.load``, ``self.process``) where
# each component is a valid identifier.  Used to recognise method-access greps
# and redirect to the cheaper ``token-goat symbol <method>`` lookup.
_DOTTED_NAME_RE = _re.compile(
    r"^([A-Za-z_$][A-Za-z0-9_$]+)\.([A-Za-z_$][A-Za-z0-9_$]+)$"
)


def _try_grep_symbol_hint(pattern: str, cwd: str | None) -> str | None:
    """Return a `token-goat symbol` suggestion when the grep pattern is a known indexed symbol.

    When the agent greps for a pure identifier (no regex metacharacters, no dots,
    no path separators), the pattern is almost certainly a symbol name.  Querying
    the project index is orders of magnitude cheaper than scanning the codebase
    file-by-file: one SQL WHERE-clause lookup vs. reading thousands of files.

    Returns a hint string when 1–5 matching symbols are found in the project
    index, or None when the pattern is not identifier-shaped, the project is
    not indexed, or no matching symbol exists.  Always fail-soft.
    """
    if not _IDENTIFIER_RE.match(pattern):
        return None
    try:
        from . import db as _db
        from .project import find_project

        cwd_path = validate_cwd(cwd, caller="grep-symbol-hint")
        if cwd_path is None:
            return None
        proj = find_project(cwd_path)
        if proj is None:
            return None

        with _db.open_project_readonly(proj.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, file_rel, line FROM symbols "
                "WHERE name = ? AND end_line IS NOT NULL "
                "ORDER BY kind, line LIMIT 6",
                (pattern,),
            ).fetchall()

        if not rows or len(rows) > 5:
            return None

        if len(rows) == 1:
            row = rows[0]
            file_short = Path(row["file_rel"]).name
            loc = f"`{file_short}:{row['line']}` ({row['kind']})"
            read_cmd = f'token-goat read "{row["file_rel"]}::{pattern}"'
            return (
                f"Symbol `{pattern}` is indexed at {loc} — use `{read_cmd}` "
                f"to read its body directly, or `token-goat symbol {pattern}` "
                f"for all references (~95% fewer tok than grep)."
            )

        locations = []
        for row in rows:
            file_short = Path(row["file_rel"]).name
            locations.append(f"`{file_short}:{row['line']}` ({row['kind']})")

        loc_str = ", ".join(locations)
        return (
            f"Symbol `{pattern}` is indexed — use `token-goat symbol {pattern}` "
            f"to jump directly to its definition(s) ({loc_str}) "
            f"instead of scanning files with grep (~95% fewer tok)."
        )
    except Exception:
        return None


def _try_grep_dotted_hint(pattern: str, cwd: str | None) -> str | None:
    """Return a ``token-goat symbol`` suggestion for a dotted-name grep pattern.

    Handles two-part patterns like ``Session.load`` or ``self.process`` where the
    agent is searching for a method definition.  The method-name component is
    looked up in the project index; results whose file-stem fuzzy-matches the
    qualifier (e.g. ``session.py`` for qualifier ``Session``) are preferred.
    Returns None when no clear 1–3 result match exists.  Always fail-soft.
    """
    m = _DOTTED_NAME_RE.match(pattern)
    if m is None:
        return None
    qualifier, method = m.group(1), m.group(2)
    try:
        from . import db as _db
        from .project import find_project

        cwd_path = validate_cwd(cwd, caller="grep-dotted-hint")
        if cwd_path is None:
            return None
        proj = find_project(cwd_path)
        if proj is None:
            return None

        with _db.open_project_readonly(proj.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, file_rel, line FROM symbols "
                "WHERE name = ? AND end_line IS NOT NULL "
                "ORDER BY kind, line LIMIT 8",
                (method,),
            ).fetchall()

        if not rows:
            return None

        qual_lower = qualifier.lower()
        preferred = [r for r in rows if qual_lower in Path(r["file_rel"]).stem.lower()]
        # Require at least one file-stem match.  Without it, any hint would
        # name unrelated symbols (e.g., every method called "load" in the
        # project when the qualifier is "self", "response", or any other
        # variable name that never appears in a file stem).
        if not preferred:
            return None
        display_rows = preferred
        if len(display_rows) > 3:
            return None

        if len(display_rows) == 1:
            row = display_rows[0]
            file_short = Path(row["file_rel"]).name
            loc = f"`{file_short}:{row['line']}` ({row['kind']})"
            read_cmd = f'token-goat read "{row["file_rel"]}::{method}"'
            return (
                f"For `{pattern}`, `{method}` is indexed at {loc} — use "
                f"`{read_cmd}` to read its body directly (~95% fewer tok than grep)."
            )

        locations = []
        for row in display_rows:
            file_short = Path(row["file_rel"]).name
            locations.append(f"`{file_short}:{row['line']}` ({row['kind']})")

        loc_str = ", ".join(locations)
        return (
            f"For `{pattern}`, `{method}` is indexed — use "
            f"`token-goat symbol {method}` to jump to its definition(s) "
            f"({loc_str}) instead of scanning files with grep (~95% fewer tok)."
        )
    except Exception:
        return None


def _try_grep_advisory_for_path(path: str | None, session_id: str, cwd: str | None = None) -> str | None:
    """Increment grep-target count for *path* and return advisory text if threshold crossed.

    Calls ``hints.maybe_grep_advisory`` which normalises the path, checks that it
    is an existing file, increments ``session_cache.grep_target_counts``, and returns
    a formatted hint on the 2 → 3 threshold crossing (one-shot per file per session).

    *cwd* is forwarded to ``maybe_grep_advisory`` so that relative paths such as
    ``./scripts/ads.js`` resolve to the same dedup key as their absolute equivalent.

    Returns ``None`` when the path is empty, the file does not exist, the session
    is unavailable, or the threshold has not yet been crossed.  Fail-soft — any
    exception produces ``None`` so the pre-read hook always continues normally.
    """
    if not path or not session_id:
        return None
    try:
        from .hints import maybe_grep_advisory
        sess = _get_session()
        cache = sess.safe_load(session_id, caller="grep_advisory")
        if cache is None:
            return None
        hint = maybe_grep_advisory(path, cache, cwd=cwd)
        # Save unconditionally — record_grep_target always increments the count when
        # the file exists, invalidating _json_cache even when no hint fires.
        with contextlib.suppress(Exception):
            sess.save(cache)
        return hint
    except Exception:
        _LOG.debug("_try_grep_advisory_for_path: error for path=%s", sanitize_log_str(path), exc_info=True)
        return None


def _handle_grep_advisory(payload: HookPayload) -> str | None:
    """Check re-grep advisory for the native Grep tool.

    Extracts the ``path`` argument from the Grep payload and delegates to
    :func:`_try_grep_advisory_for_path`.  Returns the advisory hint text when the
    threshold (3 greps of the same file this session) is first crossed, else ``None``.
    """
    args = _extract_grep_args(payload)
    if args is None:
        return None
    _pattern, path = args
    if not path:
        return None
    session_id, cwd = get_session_context(payload)
    if not session_id:
        return None
    return _try_grep_advisory_for_path(path, session_id, cwd=cwd)


def _handle_bash_grep_advisory(payload: HookPayload) -> str | None:
    """Check re-grep advisory for rg/grep Bash invocations.

    Parses the bash command via ``bash_parser`` to extract the file/directory
    target, then delegates to :func:`_try_grep_advisory_for_path`.  Returns
    the advisory hint text when the threshold is crossed, else ``None``.
    """
    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None
    from . import bash_parser
    intent = bash_parser.parse(command)
    if intent.kind != "grep" or not intent.pattern:
        return None
    path = intent.target_path
    if not path:
        return None
    session_id, cwd = get_session_context(payload)
    if not session_id:
        return None
    return _try_grep_advisory_for_path(path, session_id, cwd=cwd)


def _handle_grep_symbol_redirect(payload: HookPayload) -> HookResponse | None:
    """Inject a ``token-goat symbol`` suggestion when the Grep pattern is an indexed symbol.

    Advisory only — the grep is allowed to proceed so the agent still receives
    full match results.  The hint teaches the agent a cheaper lookup path for
    repeat access and definition navigation.

    Returns None when the pattern is not identifier-shaped, the symbol is not
    indexed, or the hint was already seen this session (fingerprint dedup).
    """
    from . import session as _sess
    from .hints import _hint_fingerprint

    session_id, cwd = get_hook_context(payload)
    if session_id is None:
        return None

    tool_input = get_tool_input(payload)
    pattern = tool_input.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return None
    # Fast-path guard: route to the appropriate lookup based on pattern shape.
    # This check runs at the handler level so it gates correctly even in tests
    # that monkeypatch the inner hint functions.
    if _IDENTIFIER_RE.match(pattern):
        hint_text = _try_grep_symbol_hint(pattern, cwd)
        stat_key = "grep_symbol_redirect"
    elif _DOTTED_NAME_RE.match(pattern):
        hint_text = _try_grep_dotted_hint(pattern, cwd)
        stat_key = "grep_dotted_redirect"
    else:
        return None

    if not hint_text:
        return None

    try:
        cache = _sess.load(session_id)
    except Exception:
        return None

    fp = _hint_fingerprint(hint_text, path=pattern)
    if cache.has_hint_fingerprint(fp):
        return None

    cache.mark_hint_seen(fp)
    cache.record_hint_emitted(stat_key)
    with contextlib.suppress(Exception):
        _sess.save(cache)
    return pre_tool_use_with_context(hint_text)


def _read_is_windowed(tool_input: dict[str, object]) -> bool:
    """True when a Read already bounds its output via an explicit offset or limit.

    A deliberately windowed read is already surgical, so the large-read redirect
    must let it through.  This also breaks any redirect loop: the redirect tells
    the agent to re-issue *with* offset/limit, and that retry has to be allowed.
    """
    return tool_input.get("offset") is not None or tool_input.get("limit") is not None


def _human_bytes(n: int) -> str:
    """Format a byte count as KB or MB with one decimal place (e.g. ``73 KB``)."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    return f"{n / 1_000:.0f} KB"


def _large_read_threshold() -> int:
    """Return the configured large-read redirect threshold in bytes (0 = disabled)."""
    from . import config as _config_mod
    try:
        return _config_mod.load().hints.large_read_redirect_bytes
    except Exception:
        return 0


# Multipliers applied to the configured threshold by context-pressure tier.
# Tighten thresholds as context fills so surgical-read denies kick in earlier
# when the window can least afford a large file.  cool=no change, critical≈18%.
_PRESSURE_THRESHOLD_MULTIPLIERS: dict[str, float] = {
    "cool": 1.0,
    "warm": 0.67,
    "hot": 0.33,
    "critical": 0.18,
}


def _pressure_scaled_threshold(base: int, tier: str) -> int:
    """Return *base* scaled down by the context-pressure multiplier for *tier*.

    Falls back to the unscaled value for unknown tier strings so a future tier
    name never accidentally disables the deny.
    """
    return max(1, int(base * _PRESSURE_THRESHOLD_MULTIPLIERS.get(tier, 1.0)))


# Multipliers applied to the bash compress output token cap by context-pressure tier.
# At cool the cap is generous (8 K tokens); as context fills, compress output is trimmed
# harder so that helm/kubectl/git-log blobs don't crowd out code reads.
_PRESSURE_BASH_CAP_MULTIPLIERS: dict[str, float] = {
    "cool": 1.0,
    "warm": 0.7,
    "hot": 0.45,
    "critical": 0.25,
}

# Base token cap for post-compress bash output at cool pressure.
_BASH_COMPRESS_BASE_TOKENS: int = 8_000


def _pressure_scaled_bash_cap(base: int, tier: str) -> int:
    """Return *base* scaled by the bash-cap multiplier for *tier*.

    Falls back to *base* for unknown tier strings.
    """
    return max(1, int(base * _PRESSURE_BASH_CAP_MULTIPLIERS.get(tier, 1.0)))


def _handle_notebook_read(file_path: str, tool_input: dict[str, object]) -> HookResponse | None:
    """Strip outputs from a Jupyter notebook and redirect the agent to the stripped copy.

    Only fires for ``.ipynb`` files when stripping saves at least
    ``NB_STRIP_MIN_SAVINGS`` bytes.  Windowed reads (offset/limit) pass through
    so the agent can still inspect specific cells of the stripped sidecar.
    """
    if not file_path.lower().endswith(".ipynb"):
        return None
    if _read_is_windowed(tool_input):
        return None
    try:
        from . import notebook_compact as _nb
        from . import paths as _paths

        path = Path(file_path)
        if not path.exists():
            return None
        raw = path.read_bytes()
        if not raw:
            return None
        sidecar_path, _ = _nb.get_or_create_sidecar(raw, _paths.data_dir())
        saved = len(raw) - sidecar_path.stat().st_size
        if saved < _nb.NB_STRIP_MIN_SAVINGS:
            return None
        saved_kb = saved // 1024
        reason = f"Notebook outputs stripped to save ~{saved_kb} KB"
        context = (
            f"Cell outputs were stripped to reduce token cost (~{saved_kb} KB saved).\n\n"
            f"Read the stripped notebook (code sources preserved) at:\n  {sidecar_path}\n\n"
            f"To read the original with outputs: add `offset: 0` to bypass this redirect."
        )
        return deny_redirect(reason, context)
    except Exception:
        return None


def _handle_large_read_redirect(
    file_path: str, tool_input: dict[str, object], floor: int = 0, tier: str = "cool"
) -> HookResponse | None:
    """Deny a full Read of an oversized file and redirect to surgical reads.

    Fires only when the configured ``hints.large_read_redirect_bytes`` threshold is
    > 0, the file is not a known binary type (skeleton/section/semantic cannot help
    there), the Read is not already windowed (:func:`_read_is_windowed`), and the
    file's on-disk size meets or exceeds the *effective* threshold.

    A full read of a 45 KB+ file can overflow a context window already near-full from
    the harness-injected session baseline — the dominant death mode for spawned
    subagents reading large recon dumps or transcripts.  The deny points at
    token-goat's surgical commands and at offset/limit windowing as the universal
    escape hatch (which works even for unindexed files like transcripts).

    *floor* raises the size gate for this call only: the effective threshold is
    ``max(configured_threshold, floor)``.  ``pre_read`` invokes this twice — once
    early with ``floor=_LARGE_FILE_HINT_SKIP_BYTES`` to hard-deny the catastrophic
    ≥10 MB tier (those files are skipped wholesale by the hint pipeline and reach no
    type-specific handler), and once as a fallback (``floor=0``) after the
    skill/index/structured/diff handlers have had first claim.  A 0 (disabled)
    configured threshold disables BOTH calls regardless of floor.

    Session-independent and intentionally NOT deduped: a repeated attempt to read the
    whole file *should* be denied again; only a windowed retry passes through.
    Fail-soft — any stat/config error returns None so the read proceeds normally.
    """
    threshold = _large_read_threshold()
    if threshold <= 0:
        return None
    # Apply pressure scaling only when no floor override is active (floor>0 means
    # the catastrophic ≥10 MB early call — keep that tier-independent).
    scaled = _pressure_scaled_threshold(threshold, tier) if floor == 0 else threshold
    effective = max(scaled, floor)
    if _read_is_windowed(tool_input):
        return None
    if Path(file_path).suffix.lower() in _BINARY_EXTENSIONS:
        return None
    try:
        size = Path(file_path).stat().st_size
    except OSError:
        return None
    if size < effective:
        return None

    name = Path(file_path).name
    size_h = _human_bytes(size)
    approx_k = max(1, size // 3 // 1000)  # ~3 chars/token, displayed in thousands
    reason = (
        f"{name} is {size_h} — a full read may overflow the context window; "
        f"use a surgical read or re-issue Read with offset/limit to window it."
    )
    context = (
        f"`{name}` is {size_h} (~{approx_k}k tokens) — reading it whole can overflow a "
        f"context window already loaded with the session baseline (the common failure mode "
        f"for spawned subagents). Read only what you need instead:\n"
        f'  - `token-goat skeleton "{file_path}"` — structure / symbol list\n'
        f'  - `token-goat section "{file_path}::<Heading>"` — one section\n'
        f'  - `token-goat semantic "<what you need>"` — search by meaning\n'
        f"  - `token-goat symbol <NAME>` — jump to a definition\n"
        f"Or re-issue this Read with `offset`/`limit` to window it — windowed reads pass "
        f"through unchanged, and unindexed files (transcripts, logs) support that path too."
    )
    skeleton_text = _try_get_inline_skeleton(file_path)
    if skeleton_text:
        context += f"\n\nIndexed symbols in this file:\n{skeleton_text}"

    with contextlib.suppress(Exception):
        from . import db
        db.record_stat(None, "large_read_redirect", detail=f"{sanitize_log_str(file_path)} size={size}")
    return deny_redirect(reason, context)


def _handle_indexed_cat_deny(
    file_path: str, tool_input: dict[str, object], tier: str
) -> HookResponse | None:
    """Deny a whole-file bash cat/bat read of an indexed source file at warm+ pressure.

    Fires only when the payload was synthesised from a bash read-equivalent command
    (flag ``_tg_from_bash_cat``), the read is not windowed (offset/limit absent),
    the file is indexed (symbols in the DB), and context pressure is warm or above.
    Returns a deny_redirect with the inline skeleton so the agent can target the
    exact symbol it needs rather than loading the full file content.
    """
    if tier not in ("warm", "hot", "critical"):
        return None
    if _read_is_windowed(tool_input):
        return None
    skeleton_text = _try_get_inline_skeleton(file_path)
    if not skeleton_text:
        return None  # not indexed or no symbols — fall through
    name = Path(file_path).name
    reason = (
        f"`{name}` is indexed — use surgical reads instead of cat at {tier} pressure."
    )
    context = (
        f"**{name}** is indexed by token-goat. "
        f"Read only what you need instead of the whole file:\n"
        f'  - `token-goat read "{file_path}::<symbol>"` — one function/class\n'
        f'  - `token-goat skeleton "{file_path}"` — symbol list\n'
        f'  - `token-goat section "{file_path}::<Heading>"` — one section\n'
        f"Or re-issue as Read with offset+limit to window it.\n\n"
        f"Indexed symbols in this file:\n{skeleton_text}"
    )
    with contextlib.suppress(Exception):
        from . import db
        db.record_stat(None, "indexed_cat_deny", detail=sanitize_log_str(file_path))
    return deny_redirect(reason, context)


def _handle_indexed_cat_advisory(
    file_path: str, tool_input: dict[str, object], cache: object | None
) -> HookResponse | None:
    """Advisory (non-blocking) surgical-read nudge for a whole-file bash cat of an indexed file.

    The deny path (:func:`_handle_indexed_cat_deny`) only fires at warm+ context
    pressure.  At the default *cool* tier a whole-file ``cat``/``bat``/``Get-Content``
    of an indexed source file would otherwise receive no nudge at all — the agent
    pays full file tokens with no pointer to ``token-goat read "file::symbol"``.
    This handler fills that gap: same trigger conditions as the deny (bash-cat
    flag set by :func:`_handle_bash_read_equivalent`, no offset/limit window, file
    indexed with symbols) but it *injects* a hint and lets the read proceed rather
    than blocking it.

    Returns ``None`` for non-indexed files (no skeleton), windowed reads, or when
    the hint was already emitted this session (dedup via ``emit_if_new_hint``).
    Files already read this session are intercepted earlier in :func:`pre_read`
    by :func:`_handle_bash_already_read`, so this only fires on a first cat.
    """
    if _read_is_windowed(tool_input):
        return None
    skeleton_text = _try_get_inline_skeleton(file_path)
    if not skeleton_text:
        return None  # not indexed or no symbols — fall through
    name = Path(file_path).name
    hint = (
        f"`{name}` is indexed by token-goat — read only what you need instead of the whole file:\n"
        f'  `token-goat read "{file_path}::<symbol>"` — one function/class\n'
        f'  `token-goat skeleton "{file_path}"` — symbol list\n'
        f"Indexed symbols in this file:\n{skeleton_text}"
    )
    from .hints import _hint_fingerprint
    fp = _hint_fingerprint(hint, path=file_path)
    parts: list[str] = []
    if not emit_if_new_hint(cache, fp, hint, "indexed_cat_advisory", parts):
        return None
    with contextlib.suppress(Exception):
        from . import db
        db.record_stat(None, "indexed_cat_advisory", detail=sanitize_log_str(file_path))
    return pre_tool_use_with_context(parts[0])


def _handle_bash_range_read_hint(payload: HookPayload) -> HookResponse | None:
    """Advisory hint for sed/awk windowed reads of indexed files.

    When a Bash command is a line-range read (e.g. ``sed -n '10,30p' file.py``
    or ``awk 'NR>=10&&NR<=30' file.py``) and the target file is indexed, inject
    an advisory suggesting the equivalent ``token-goat read "file::symbol"``
    command so the agent can use a symbol name instead of guessing line numbers.

    Always advisory (never a deny) — the windowed read is already targeted and
    small; we just surface the surgical form for future reference.
    """
    from . import bash_parser

    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str):
        return None
    intent = bash_parser.parse(cmd)
    if intent.kind != "read":
        return None
    if intent.offset is None and intent.limit is None:
        return None  # whole-file read — handled by _handle_indexed_cat_deny
    if not intent.target_path:
        return None
    skeleton_text = _try_get_inline_skeleton(intent.target_path)
    if not skeleton_text:
        return None
    name = Path(intent.target_path).name
    range_desc = ""
    if intent.offset is not None and intent.limit is not None:
        range_desc = f" lines {intent.offset}–{intent.offset + intent.limit - 1}"
    elif intent.offset is not None:
        range_desc = f" from line {intent.offset}"
    elif intent.limit is not None:
        range_desc = f" first {intent.limit} lines"
    hint = (
        f"`{name}`{range_desc} is indexed — use a symbol name instead of a line range:\n"
        f'  `token-goat read "{intent.target_path}::<symbol>"`\n\n'
        f"Indexed symbols:\n{skeleton_text}"
    )
    with contextlib.suppress(Exception):
        from . import db as _db
        _db.record_stat(None, "bash_range_read_hint", detail=sanitize_log_str(intent.target_path))
    return pre_tool_use_with_context(hint)


def _handle_compound_cmd_hint(payload: HookPayload) -> HookResponse | None:
    """Advisory hint when a compound command has ≥1 read-type segment already cached.

    When a command like ``wc -l X && tail -30 X`` arrives and one or more of
    its ``&&``/``;``-separated segments have cached output from this session or
    a prior session, emit an advisory telling the agent which segments can be
    recalled via ``token-goat bash-output`` instead of re-running the full
    chain.

    Always advisory — always returns ``{"continue": True, ...}`` or ``None``.
    Never blocks or rewrites the command.
    """
    from . import bash_cache as _bc
    from . import bash_parser

    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str) or not cmd:
        return None

    # Only attempt splitting when the command looks compound — fast-path exit
    # for the common single-command case to keep hook latency low.
    if "&&" not in cmd and ";" not in cmd:
        return None

    segments = bash_parser.split_compound(cmd)
    if len(segments) < 2:
        return None

    # Identify segments that are read-type (cat, tail, wc, head, bat, …) or
    # grep-type — these are the ones whose outputs are worth caching.
    read_type_segments = [
        s for s in segments
        if bash_parser.parse(s).kind in ("read", "grep")
    ]
    if len(read_type_segments) < 2:
        return None

    _, cwd = get_session_context(payload)

    # Check each read-type segment against the bash output cache.
    cached_hits: list[tuple[str, str]] = []  # (segment, output_id)
    try:
        for seg in read_type_segments:
            meta = _bc.find_cached_for_command(seg, cwd)
            if meta is not None:
                from . import cache_common as _cc
                short_id = _cc.short_output_id(meta.output_id)
                cached_hits.append((seg, short_id))
    except Exception:
        _LOG.debug("compound_cmd_hint: cache lookup failed", exc_info=True)
        return None

    if not cached_hits:
        return None

    parts = [f"  '{seg}' → token-goat bash-output {oid}" for seg, oid in cached_hits]
    hint = (
        "[token-goat] Parts of this compound command are cached:\n"
        + "\n".join(parts)
        + "\nRun them separately to use the cache."
    )
    with contextlib.suppress(Exception):
        from . import db as _db
        _db.record_stat(None, "compound_cmd_hint", detail=sanitize_log_str(cmd, max_len=200))
    _LOG.debug("compound_cmd_hint: %d/%d segments cached", len(cached_hits), len(read_type_segments))
    return pre_tool_use_with_context(hint)


def _handle_bash_streak_hint(payload: HookPayload) -> HookResponse | None:
    """Advisory hint when the same file is Bash-read 3+ times in a session."""
    import shlex

    from . import bash_parser
    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str):
        return None
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
        return None
    sid, _ = get_session_context(payload)
    if not sid:
        return None
    sess = _get_session()
    cache = sess.safe_load(sid, caller="bash_streak_hint")
    if not _cache_is_available(cache):
        return None
    from . import paths as _paths
    key = _paths.normalize_key(intent.target_path)
    entry = cache.files.get(key)
    if entry is None or entry.read_count < 2:
        return None
    # Skip if file was last read before the most recent compact — that content is
    # gone from the context window and a re-read is not redundant.
    _compact_ts = getattr(cache, "last_compact_ts", 0.0)
    if _compact_ts and entry.last_read_ts < _compact_ts:
        return None
    name = Path(intent.target_path).name
    rel = intent.target_path
    skeleton_text = _try_get_inline_skeleton(rel)
    read_arg = shlex.quote(f"{rel}::<symbol>")
    sym_arg = shlex.quote(rel)
    if skeleton_text:
        hint = (
            f"`{name}` has been read {entry.read_count}× this session — use a symbol name instead of re-reading:\n"
            f"  `token-goat read {read_arg}`\n\n"
            f"Indexed symbols:\n{skeleton_text}"
        )
    else:
        hint = (
            f"`{name}` has been read {entry.read_count}× this session — use surgical reads to avoid re-sending the whole file:\n"
            f"  `token-goat symbol {sym_arg}`   (list symbols)\n"
            f"  `token-goat read {read_arg}`   (read one symbol)"
        )
    with contextlib.suppress(Exception):
        from . import db as _db
        _db.record_stat(sid, "bash_streak_hint", detail=sanitize_log_str(rel))
    return pre_tool_use_with_context(hint)


#: Commands that indicate status-checking / polling behaviour.
_POLL_CMDS_RE = _re.compile(
    r"\b(?:gh\s+(?:run|pr|workflow|check)|curl\b|wget\b|ping\b|"
    r"docker\s+(?:ps|logs|stats|wait|inspect)|kubectl\s+(?:get|describe|logs|wait)|"
    r"\bwatch\b)\b",
    _re.IGNORECASE,
)
_POLL_STALE_SECS: float = 600.0  # suppress hint if last run was > 10 min ago (session moved on)
_POLL_MIN_RUNS: int = 2  # run_count >= 2 means this would be the 3rd+ run


def _handle_bash_poll_hint(payload: HookPayload) -> HookResponse | None:
    """Advisory hint when a status-checking command is run rapidly 3+ times."""
    import time as _time

    from . import bash_cache as _bc
    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str) or not _POLL_CMDS_RE.search(cmd):
        return None
    sid, cwd = get_session_context(payload)
    if not sid:
        return None
    cmd_sha = _bc.command_hash(cmd, cwd)
    sess = _get_session()
    cache = sess.safe_load(sid, caller="bash_poll_hint")
    entry = sess.lookup_bash_entry(sid, cmd_sha, cache=cache)
    if entry is None or entry.run_count < _POLL_MIN_RUNS:
        return None
    if _time.time() - entry.ts > _POLL_STALE_SECS:
        return None
    hint = (
        f"This command has run {entry.run_count}× recently — looks like manual polling.\n"
        f"Replace repeated calls with a loop:\n"
        f"  `until <success-condition>; do sleep 5; done`\n"
        f"Or retrieve the cached output: `token-goat bash-output {entry.output_id}`"
    )
    with contextlib.suppress(Exception):
        from . import db as _db
        _db.record_stat(sid, "bash_poll_hint", detail=sanitize_log_str(cmd[:80]))
    return pre_tool_use_with_context(hint)


#: Max file size to hash for cross-file content-dedup check in pre_read.
_CONTENT_DEDUP_MAX_BYTES: int = 500_000
#: Maximum result bytes to cache for Grep result dedup serving.
_GREP_RESULT_CACHE_MAX_BYTES: int = 50_000

#: Compress glob results to a directory rollup above this path count.
_GLOB_ROLLUP_THRESHOLD: int = 40
#: Flat file names to always emit before the directory rollup.
_GLOB_SAMPLE_PATHS: int = 20
#: Max directory lines in a rollup summary.
_GLOB_ROLLUP_MAX_DIRS: int = 20

_INLINE_SKELETON_MAX_CHARS: int = 800
_INLINE_SKELETON_KINDS: frozenset[str] = frozenset({
    "function", "method", "class", "interface", "struct", "trait", "enum",
    "type_alias", "constructor", "property", "decorator",
})


def _try_get_inline_skeleton(file_path: str) -> str:
    """Return a compact skeleton listing for *file_path* from the index DB.

    Queries the symbol DB to produce a ``line  kind  name`` table — the same
    content as ``token-goat skeleton`` but without spawning a subprocess.  Returns
    ``""`` on any error so it is safe to call unconditionally from deny handlers.
    The output is capped at _INLINE_SKELETON_MAX_CHARS characters; a ``(+N more)``
    note is appended when symbols were truncated.
    """
    try:
        from . import db as _db
        from . import read_replacement as _rr
        from .project import find_project

        abs_path = Path(file_path) if Path(file_path).is_absolute() else Path.cwd() / file_path
        cwd_path = abs_path.parent
        proj = find_project(cwd_path)
        if proj is None:
            return ""
        file_rel = _rr.resolve_file_rel(proj, str(abs_path))
        if not file_rel:
            return ""

        with _db.open_project_readonly(proj.hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, line FROM symbols "
                "WHERE file_rel = ? AND kind IN ("
                + ",".join("?" * len(_INLINE_SKELETON_KINDS))
                + ") AND end_line IS NOT NULL ORDER BY line",
                (file_rel, *_INLINE_SKELETON_KINDS),
            ).fetchall()

        if not rows:
            return ""

        lines = [f"  {row['line']:4d}  {row['kind']:<12}  {row['name']}" for row in rows]

        text = "\n".join(lines)
        if len(text) <= _INLINE_SKELETON_MAX_CHARS:
            return text
        truncated = text[:_INLINE_SKELETON_MAX_CHARS].rsplit("\n", 1)[0]
        shown = truncated.count("\n") + 1
        remaining = len(lines) - shown
        if remaining > 0:
            return truncated + f"\n  (+{remaining} more symbols)"
        return truncated
    except Exception:
        return ""


def _check_content_dedup(
    file_path: str, cache: object
) -> HookResponse | None:
    """Return a deny response if file_path's content was already read under a different path.

    Computes a 16-hex-char SHA-1 prefix over the file bytes and looks it up in the session
    cache. Returns None when the file is new to the session, unreadable, too large, or the
    same path was previously registered. Only fires on full (non-windowed) reads.
    """
    try:
        p = Path(file_path)
        if not p.is_file():
            return None
        size = p.stat().st_size
        if size == 0 or size > _CONTENT_DEDUP_MAX_BYTES:
            return None
        raw = p.read_bytes()
        sha16 = hashlib.sha1(raw, usedforsecurity=False).hexdigest()[:16]
        norm = str(p.resolve()).replace("\\", "/")
        existing = cache.get_file_content_path(sha16)  # type: ignore[attr-defined]  # cache is typed as object; SessionCache has this method at runtime
        if existing is None or existing == norm:
            return None
        return deny_redirect(
            "Duplicate file content",
            f"This file has identical content to `{existing}`, which was already read this session.\n"
            f"Use `{existing}` instead to avoid loading identical bytes twice.",
        )
    except Exception:
        return None


def _rollup_glob_paths(paths_text: str) -> str:
    """Compress a large glob result into a flat sample plus a directory-grouped summary.

    Emits up to _GLOB_SAMPLE_PATHS concrete file names (so the agent can act immediately
    in the compaction-recovery case) followed by a directory count table for structural
    orientation. Used when the cached result exceeds _GLOB_ROLLUP_THRESHOLD paths.
    """
    from collections import Counter
    lines = [ln for ln in paths_text.splitlines() if ln.strip()]
    total = len(lines)
    if total <= _GLOB_ROLLUP_THRESHOLD:
        return paths_text
    sample = lines[:_GLOB_SAMPLE_PATHS]
    hidden_sample = total - len(sample)
    dir_counts: Counter[str] = Counter()
    for line in lines:
        dir_counts[str(Path(line.strip()).parent)] += 1
    sorted_dirs = sorted(dir_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    shown_dirs = sorted_dirs[:_GLOB_ROLLUP_MAX_DIRS]
    hidden_dirs = len(sorted_dirs) - len(shown_dirs)
    hidden_dir_files = sum(cnt for _, cnt in sorted_dirs[_GLOB_ROLLUP_MAX_DIRS:])
    dir_rows = [f"  {cnt:>4}  {d}" for d, cnt in shown_dirs]
    n_dirs = len(sorted_dirs)
    dir_label = "directory" if n_dirs == 1 else "directories"
    out = (
        f"{total} paths — first {len(sample)} shown; {n_dirs} {dir_label}:\n"
        + "\n".join(sample)
        + (f"\n  (+{hidden_sample} more not shown)\n" if hidden_sample else "\n")
        + "Directory breakdown:\n"
        + "\n".join(dir_rows)
    )
    if hidden_dirs:
        hidden_dir_label = "directory" if hidden_dirs == 1 else "directories"
        out += f"\n  ... and {hidden_dirs} more {hidden_dir_label} ({hidden_dir_files} files)"
    return out


def _handle_large_grep_redirect(payload: HookPayload) -> HookResponse | None:
    """Deny a content-mode Grep over a single oversized file; redirect to bounded search.

    Narrow by design: fires only when ``output_mode`` is ``"content"`` (the expensive
    mode that streams matching lines), no ``head_limit`` is set (a capped grep is
    already bounded — and exempting it prevents a redirect loop), and ``path`` points
    at a single existing file at or above the large-read threshold.  Directory greps
    and the cheap ``files_with_matches`` / ``count`` modes are left untouched: the risk
    is a content dump of a 45 KB+ transcript, not a normal repo-wide search.
    """
    threshold = _large_read_threshold()
    if threshold <= 0:
        return None
    tool_input = get_tool_input(payload)
    if tool_input.get("output_mode") != "content" or tool_input.get("head_limit") is not None:
        return None
    path = tool_input.get("path")
    if not isinstance(path, str) or not path:
        return None
    p = Path(path)
    try:
        if not p.is_file():
            return None
        size = p.stat().st_size
    except OSError:
        return None
    if size < threshold:
        return None

    name = p.name
    size_h = _human_bytes(size)
    pattern = tool_input.get("pattern")
    pat_s = pattern if isinstance(pattern, str) and pattern else "<pattern>"
    reason = (
        f"Content grep over {name} ({size_h}) can return a large slice of the file — "
        f"narrow the search to avoid overflowing context."
    )
    context = (
        f"`{name}` is {size_h}; a `content`-mode Grep over it can stream back a large "
        f"fraction of the file. Prefer a bounded search:\n"
        f'  - `token-goat semantic "{pat_s}"` — ranked matches by meaning\n'
        f'  - `token-goat section "{path}::<Heading>"` — the relevant section only\n'
        f"  - re-run Grep with `head_limit` set to cap the lines returned\n"
        f"  - or Read with `offset`/`limit` to window the file directly."
    )
    with contextlib.suppress(Exception):
        from . import db
        db.record_stat(None, "large_grep_redirect", detail=f"{sanitize_log_str(path)} size={size}")
    return deny_redirect(reason, context)


def _handle_glob_dedup(payload: HookPayload) -> HookResponse | None:
    """Return cached Glob results or a dedup hint when the same pattern ran recently.

    When a cached result exists in ``bash_cache`` for this (session, pattern, path)
    and the entry is within :data:`hints.STALE_READ_AGE_SECONDS`, the cached
    file list is injected as ``additionalContext`` so the agent receives the
    result without the Glob tool running again.  This converts the advisory
    hint into a real result dedup — the agent sees the matching paths inline.

    Falls back to the standard advisory dedup hint when no cached result exists.
    Returns ``None`` when no dedup applies (first run, or cache evicted).
    """
    from .hints import (
        STALE_READ_AGE_SECONDS,
        build_glob_dedup_hint,
        compute_stale_threshold,
    )

    args = _extract_grep_args(payload)
    if args is None:
        return None
    pattern, path = args

    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return None

    # Check for a cached result in bash_cache (item 19).
    # Only serve the cached result when the glob entry is in the session history
    # AND is recent enough (within STALE_READ_AGE_SECONDS).
    try:
        from . import bash_cache as _bc
        _sess = _get_session()

        cache = _sess.load(session_id)
        # Find the most recent GlobEntry for this (pattern, path).
        glob_entry = _sess.lookup_glob_entry(session_id, pattern, path, cache=cache)
        if glob_entry is not None:
            import time as _time
            _now = _time.time()
            age = _now - glob_entry.ts
            _glob_created_ts = getattr(cache, "created_ts", None)
            _glob_session_age = (_now - _glob_created_ts) if _glob_created_ts is not None else STALE_READ_AGE_SECONDS
            _glob_stale_threshold = compute_stale_threshold(_glob_session_age)
            if age <= _glob_stale_threshold:
                cached_result = _bc.load_glob_result(session_id, pattern, path)
                if cached_result is not None:
                    path_label = f" in {path!r}" if path else ""
                    # Roll up large results into directory groups; pass through small ones verbatim.
                    _cached_lines = [ln for ln in cached_result.splitlines() if ln.strip()]
                    if len(_cached_lines) > _GLOB_ROLLUP_THRESHOLD:
                        _cached_display = _rollup_glob_paths(cached_result)
                    else:
                        _cached_display = cached_result
                    hint_text = (
                        f"Note: Glob `{sanitize_log_str(pattern, max_len=100)}`{path_label} "
                        f"ran {int(age)}s ago — cached result ({glob_entry.result_count or '?'} paths):\n"
                        f"{_cached_display}\n"
                        "(Serving from cache. Run without hints to force a fresh scan.)"
                    )
                    record_cached_stat("glob_result_cache_hit", sanitize_log_str(pattern, max_len=200))
                    _LOG.info(
                        "pre-read: glob result cache hit for pattern=%s (age=%ds)",
                        sanitize_log_str(pattern, max_len=100), int(age),
                    )
                    return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: glob result cache check failed", exc_info=True)

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_glob_dedup_hint(
            session_id=sid, pattern=pattern, path=path, cache=cache,
        ),
        stat_kind="glob_dedup_hint",
        detail=sanitize_log_str(pattern, max_len=200),
        log_label="pre-read",
    )


def _get_bash_command_from_payload(payload: HookPayload) -> str | None:
    """Extract and validate the ``command`` string from a Bash tool payload.

    Returns the command string when it is a non-empty string, or ``None``
    when the field is absent, non-string, or empty — which signals the
    caller to short-circuit with ``return None``.

    Previously copied verbatim into :func:`_handle_bash_dedup` and
    :func:`_handle_bash_cache_hit`; centralised here so the identical
    validation lives once.
    """
    tool_input = get_tool_input(payload)
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return None
    return command


def _try_bash_dedup_serve(payload: HookPayload) -> HookResponse | None:
    """Inject a small cached Bash output inline as additionalContext (direct-serve path).

    When the command has already run in this session, the prior output is still
    within the staleness window, and the total output is ≤ _BASH_DIRECT_SERVE_MAX_BYTES,
    embed the cached text directly so the agent gets the result without re-running.
    Returns None to fall through to the advisory hint path otherwise.
    """
    from .hints import STALE_READ_AGE_SECONDS, compute_stale_threshold

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None

    session_id, cwd = get_hook_context(payload)
    if session_id is None:
        return None

    try:
        import time as _time

        from . import bash_cache as _bc
        from . import session as _sess_mod

        cmd_sha = _bc.command_hash(command, cwd)
        _sess = _get_session()
        cache = _sess.load(session_id)
        entry = _sess_mod.lookup_bash_entry(session_id, cmd_sha, cache=cache)
        if entry is None:
            return None

        # Only direct-serve on the first repeat (run_count==1).  On subsequent repeats the
        # advisory path's loop-detection warning is more useful than silently serving cache.
        if getattr(entry, "run_count", 1) > 1:
            return None

        # For git diff/status: if any session file was edited after this bash entry was
        # cached, the working tree has changed — the cached diff output is stale even though
        # the git index (and therefore git_state_fingerprint) may not have updated yet.
        if _bc.is_git_mutable_command(command) and any(
            getattr(fe, "last_edit_ts", 0.0) > entry.ts for fe in cache.files.values()
        ):
            return None

        _now = _time.time()
        age = _now - entry.ts
        _sess_created = getattr(cache, "created_ts", None)
        _sess_age = (_now - _sess_created) if _sess_created is not None else STALE_READ_AGE_SECONDS
        _stale_thresh = compute_stale_threshold(_sess_age)
        # Immutable git commands (git show <full-sha>) never go stale — bypass staleness check.
        if age > _stale_thresh and not _bc.is_git_immutable_command(command):
            return None

        text = _bc.load_output(entry.output_id)
        if not text:
            return None

        # Check the actual stored text size; original may differ from on-disk due to truncation.
        actual_bytes = len(text.encode("utf-8", errors="replace"))
        if actual_bytes > _BASH_DIRECT_SERVE_MAX_BYTES:
            return None

        cmd_short = sanitize_log_str(command, max_len=80)
        hint_text = (
            f"Note: Bash `{cmd_short}` ran {int(age)}s ago — cached output "
            f"({actual_bytes} bytes):\n{text}\n"
            "(Serving from cache. Re-run to force a fresh result.)"
        )
        record_cached_stat("bash_direct_serve", sanitize_log_str(command, max_len=200))
        _LOG.info(
            "pre-read: bash direct serve command=%s age=%ds bytes=%d",
            sanitize_log_str(command, max_len=80), int(age), actual_bytes,
        )
        return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: bash direct serve failed", exc_info=True)
        return None


def _handle_bash_dedup(payload: HookPayload) -> HookResponse | None:
    """Return a dedup hint when this exact Bash command ran earlier in the session.

    Looks up the command's content hash in :attr:`session.SessionCache.bash_history`;
    on a hit, suggests retrieving the cached output via ``token-goat bash-output``
    rather than re-running.  Returns ``None`` to let the hook fall through to
    the normal bash-as-read handling when no dedup hit is available.
    """
    from .hints import build_bash_dedup_hint

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None

    direct = _try_bash_dedup_serve(payload)
    if direct is not None:
        return direct

    _, cwd = get_session_context(payload)
    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_bash_dedup_hint(
            session_id=sid, command=command, cache=cache, cwd=cwd,
        ),
        stat_kind="bash_dedup_hint",
        detail=sanitize_log_str(command, max_len=200),
        log_label="pre-read",
    )


def _handle_env_probe_serve(payload: HookPayload) -> HookResponse | None:
    """Serve advisory context for env probe commands from the cross-session disk cache. Env probes (node -v, python --version, which node, ...) are advisory-only so the agent can re-run if the toolchain changed between sessions."""
    from . import bash_cache as _bc

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None
    if not _bc.is_env_probe_command(command):
        return None

    _, cwd = get_session_context(payload)
    try:
        meta = _bc.find_cached_for_command(command, cwd)
        if meta is None:
            return None
        text = _bc.load_output(meta.output_id)
        if not text:
            return None
        cmd_short = sanitize_log_str(command, max_len=80)
        hint_text = f"[token-goat] `{cmd_short}` prior output (env probe — re-run to get a fresh result):\n{text.rstrip()}"
        record_cached_stat("env_probe_cache_hit", sanitize_log_str(command, max_len=200))
        _LOG.info("pre-read: env-probe serve command=%s bytes=%d", sanitize_log_str(command, max_len=80), len(text))
        return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: env-probe serve failed", exc_info=True)
        return None


def _handle_bash_already_read(payload: HookPayload) -> HookResponse | None:
    from . import bash_parser

    tool_name = payload.get("tool_name")
    if tool_name != "Bash":
        return None
    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    if not isinstance(cmd, str):
        return None
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
        return None
    sid, cwd = get_session_context(payload)
    if not sid:
        return None
    try:
        sess = _get_session()
        cache = sess.safe_load(sid, caller="bash_already_read")
        if cache is None:
            return None
        from . import paths as _paths
        path_key = _paths.normalize_path_key(intent.target_path, cwd)
        entry = cache.files.get(path_key)
        if entry is None or entry.read_count != 1:  # streak_hint handles read_count >= 2
            return None
        # Skip if file was last read before the most recent compact — that content is
        # gone from the context window and a re-read is not redundant.
        _compact_ts = getattr(cache, "last_compact_ts", 0.0)
        if _compact_ts and entry.last_read_ts < _compact_ts:
            return None
        display = sanitize_log_str(intent.target_path, max_len=80)
        hint_text = f"[token-goat] `{display}` already read {entry.read_count}× this session — use `token-goat read \"{display}::SymbolName\"` for a surgical pull"
        record_cached_stat("bash_read_equiv_already_read", sanitize_log_str(intent.target_path, max_len=200))
        _LOG.info("pre-read: bash-already-read path=%s read_count=%d", sanitize_log_str(intent.target_path, max_len=80), entry.read_count)
        return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: bash-already-read failed", exc_info=True)
        return None


def _handle_dep_list_serve(payload: HookPayload) -> HookResponse | None:
    """Serve advisory context for dependency-listing commands from the cross-session disk cache.

    Dep-list commands (npm ls, pip list, cargo tree, …) are advisory-only: the
    lockfile hash is baked into the cache key by :func:`command_hash`, so a hit
    guarantees the output matches the current dependency state.  The agent can
    still re-run the command if it prefers a live result.
    """
    from . import bash_cache as _bc

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None
    if not _bc.is_dep_list_command(command):
        return None

    _, cwd = get_session_context(payload)
    try:
        meta = _bc.find_cached_for_command(command, cwd)
        if meta is None:
            return None
        text = _bc.load_output(meta.output_id)
        if not text:
            return None
        cmd_short = sanitize_log_str(command, max_len=80)
        hint_text = f"[token-goat] `{cmd_short}` prior output (lockfile unchanged — re-run to refresh):\n{text.rstrip()}"
        record_cached_stat("dep_list_cache_hit", sanitize_log_str(command, max_len=200))
        _LOG.info("pre-read: dep-list serve command=%s bytes=%d", sanitize_log_str(command, max_len=80), len(text))
        return pre_tool_use_with_context(hint_text)
    except Exception:
        _LOG.debug("pre-read: dep-list serve failed", exc_info=True)
        return None


def _handle_bash_cache_hit(payload: HookPayload) -> HookResponse | None:
    """Return a cache-hit hint when this Bash command has a cached output from a prior session.

    Fires when the command is not in the current session's bash history but there
    is still output on disk from a previous session.  This is the cross-session
    counterpart to :func:`_handle_bash_dedup`.  Returns ``None`` when no prior
    cached entry exists or the session has already seen this command (the dedup
    path handles that case).
    """
    from .hints import build_bash_cache_hit_hint

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None

    _, cwd = get_session_context(payload)
    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_bash_cache_hit_hint(
            session_id=sid, command=command, cache=cache, cwd=cwd,
        ),
        stat_kind="bash_cache_hit_hint",
        detail=sanitize_log_str(command, max_len=200),
        log_label="pre-read",
    )


def _handle_bash_grep_dedup(payload: HookPayload) -> HookResponse | None:
    """Return cached Grep results or a dedup hint when a Bash grep repeats a prior search.

    When the native Grep tool ran the same (pattern, path) recently and its result
    is cached in bash_cache, the cached text is injected as additionalContext so
    the Bash command can be skipped.  Falls back to the advisory dedup hint when
    no cached result is available.

    Handles ``rg``, ``grep``, ``ag``, and other pattern-search tools invoked via
    the Bash tool.

    Returns ``None`` when:

    * the command is not a grep-family invocation
    * no prior session Grep with the same pattern/path exists
    * the prior result falls below the minimum-match dedup threshold
    * the prior result is older than the stale-age threshold
    """
    from .hints import build_grep_dedup_hint

    command = _get_bash_command_from_payload(payload)
    if command is None:
        return None

    from . import bash_parser

    intent = bash_parser.parse(command)
    if intent.kind != "grep" or not intent.pattern:
        return None

    pattern = intent.pattern
    path = intent.target_path  # search root/file argument from _parse_grep

    sid, _ = get_session_context(payload)
    if sid:
        try:
            import time as _time

            from .bash_cache import _normalize_grep_path as _ngp
            from .bash_cache import load_grep_result as _lgr
            from .hints import STALE_READ_AGE_SECONDS, compute_stale_threshold
            _sess = _get_session()
            cache = _sess.load(sid)
            # Normalize the bash-side path for comparison; grep_hash() uses the same normalization,
            # so this aligns the in-memory lookup key with the disk cache key.
            norm_path = _ngp(path) if path is not None else ""
            grep_entry = None
            if cache is not None and getattr(cache, "greps", None):
                for _e in reversed(cache.greps):
                    if _e.pattern == pattern and (_ngp(_e.path) if _e.path is not None else "") == norm_path:
                        grep_entry = _e
                        break
            if grep_entry is not None:
                _now = _time.time()
                age = _now - grep_entry.ts
                _sess_created = getattr(cache, "created_ts", None)
                _sess_age = (_now - _sess_created) if _sess_created is not None else STALE_READ_AGE_SECONDS
                _stale_thresh = compute_stale_threshold(_sess_age)
                if age <= _stale_thresh:
                    # Use the stored entry path for the disk lookup — grep_hash normalizes it internally.
                    stored_path = grep_entry.path
                    # Bash grep always returns content-style output; try "content" first, then files_with_matches.
                    cached_result = _lgr(sid, pattern, stored_path, None, None, "content")
                    if cached_result is None:
                        cached_result = _lgr(sid, pattern, stored_path, None, None, None)
                    if cached_result is not None:
                        path_label = f" in {path!r}" if path else ""
                        hint_text = (
                            f"Note: Grep `{sanitize_log_str(pattern, max_len=100)}`{path_label} "
                            f"ran {int(age)}s ago via Grep tool — cached result ({grep_entry.result_count or '?'} matches):\n"
                            f"{cached_result}\n"
                            "(Serving from cache. Run without hints to force a fresh search.)"
                        )
                        record_cached_stat("bash_grep_result_cache_hit", sanitize_log_str(pattern, max_len=200))
                        _LOG.info("pre-read: bash-grep cache hit pattern=%s (age=%ds)", sanitize_log_str(pattern, max_len=100), int(age))
                        return pre_tool_use_with_context(hint_text)
        except Exception:
            _LOG.debug("pre-read: bash-grep cache check failed", exc_info=True)

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_grep_dedup_hint(
            session_id=sid, pattern=pattern, path=path, cache=cache,
        ),
        stat_kind="grep_dedup_hint",
        detail=sanitize_log_str(pattern, max_len=200),
        log_label="pre-read",
    )


def _estimate_recovery_context_bytes(cache: object) -> int:
    """Estimate bytes of context the recovery hint prevents from being re-read.

    Sums the stored byte sizes of bash outputs and web-fetch bodies present in
    the session cache.  These are the concrete blobs that the agent would
    otherwise need to re-run or re-fetch to rebuild its post-compact context.
    File sizes are not included because file byte counts are not stored in the
    session cache (only line ranges are tracked), so including them would
    require disk reads on the hot pre-read path.

    Returns 0 on any error (fail-soft).
    """
    try:
        total = 0
        bash_hist = getattr(cache, "bash_history", None) or {}
        for be in bash_hist.values():
            total += getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
        web_hist = getattr(cache, "web_history", None) or {}
        for we in web_hist.values():
            total += getattr(we, "body_bytes", 0)
        return max(0, total)
    except Exception:
        return 0


def _parse_recovery_sidecar(raw: str) -> tuple[str, int]:
    """Parse a recovery_pending sidecar file, returning (hint_text, bytes_estimate).

    The sidecar may be in one of two formats:

    * **JSON** (new format): ``{"hint": "<hint text>", "bytes_estimate": N}``
      Written by the post-compact SessionStart handler after reading the
      precompact estimate sentinel.  ``bytes_estimate`` reflects the actual
      bash/web history size from the pre-compaction session cache.

    * **Plain text** (legacy): the entire file content is the hint text.
      Written by older versions of the handler.  ``bytes_estimate`` falls back
      to 0 in this case (the previous behaviour).

    Returns ``(hint, bytes_estimate)``.  Errors in JSON parsing fall back to
    treating the whole content as plain-text hint with 0 estimate.
    """
    import json as _json

    raw_stripped = raw.strip()
    if raw_stripped.startswith("{"):
        try:
            data = _json.loads(raw_stripped)
            hint = str(data.get("hint", raw))
            estimate = int(data.get("bytes_estimate", 0))
            return hint, max(0, estimate)
        except (ValueError, TypeError):
            pass
    # Plain-text fallback: treat entire content as hint with no estimate.
    return raw, 0


def _check_recovery_pending(session_id: str, cache: object) -> str | None:
    """Return the deferred recovery hint text and consume the sidecar, or None.

    Called once per session on the first pre-read (Read or Bash) after a
    compaction event.  The sidecar ``sentinels/recovery_pending_{session_id}``
    is written by the SessionStart handler when ``source == "compact"``.  On
    first hit we read the payload, delete the sidecar, and mark the session so
    subsequent calls in the same process skip the disk check.

    Also records a matched stat pair:
    - ``compact_recovery``: positive bytes/tokens saved (bash + web content that
      would need re-loading without the hint).  The estimate is read from the
      JSON sidecar payload written by the SessionStart handler, which in turn
      reads it from the precompact estimate sentinel written by the PreCompact
      hook while the session cache still had live data.  This ensures the stat
      reflects real pre-compaction history rather than the empty new session.
    - ``compact_recovery_overhead``: negative bytes/tokens (the hint text cost).

    Fail-soft: any I/O error returns None so a missing or unreadable sidecar
    never blocks the hook.
    """
    # Fast path: already injected in this process (in-memory flag).
    if getattr(cache, "recovery_injected", False):
        return None
    try:
        from . import paths as _paths

        sidecar = _paths.recovery_pending_path(session_id)
        if not sidecar.exists():
            return None
        raw = sidecar.read_text(encoding="utf-8")
        sidecar.unlink(missing_ok=True)
        # Parse sidecar: new JSON format carries bytes_estimate; legacy plain-text falls back to 0.
        hint, stored_bytes_estimate = _parse_recovery_sidecar(raw)
        # Mark in-process so we don't re-check on subsequent calls.
        with contextlib.suppress(Exception):
            cache.recovery_injected = True  # type: ignore[attr-defined]  # cache is typed as object; SessionCache has this attribute at runtime
        hint_bytes = len(_utf8_bytes(hint))
        _LOG.info(
            "pre-read: deferred recovery hint injected for session=%s (%d chars, stored_estimate=%d)",
            session_id[:16], hint_bytes, stored_bytes_estimate,
        )
        # Record matched stat pair: savings (context prevented from being
        # re-read) plus injection overhead (the hint text itself costs tokens).
        # Use the stored_bytes_estimate from the JSON sidecar (written by
        # _try_recovery_response from the PreCompact-phase estimate sentinel)
        # rather than re-computing from the current (possibly empty) session cache.
        # Fall back to live estimation only when the sidecar was in legacy plain-text format.
        try:
            from . import db as _db

            _BYTES_PER_TOKEN = 4  # conservative estimate matching hints.CHARS_PER_TOKEN
            context_bytes = (
                stored_bytes_estimate
                if stored_bytes_estimate > 0
                else _estimate_recovery_context_bytes(cache)
            )
            context_tokens = max(1, context_bytes // _BYTES_PER_TOKEN) if context_bytes > 0 else 0
            overhead_tokens = max(1, hint_bytes // _BYTES_PER_TOKEN)
            if context_bytes > 0:
                _db.record_stat(
                    None,
                    "compact_recovery",
                    bytes_saved=context_bytes,
                    tokens_saved=context_tokens,
                    detail=f"session={session_id[:8]}",
                )
            _db.record_stat(
                None,
                "compact_recovery_overhead",
                bytes_saved=-hint_bytes,
                tokens_saved=-overhead_tokens,
                detail=f"session={session_id[:8]}",
            )
        except Exception:
            _LOG.debug("pre-read: recovery stat record failed", exc_info=True)
        return hint
    except Exception:
        _LOG.debug("pre-read: recovery sidecar check failed", exc_info=True)
        return None


def _flush_pending_hint_save(cache: object) -> None:
    """Flush a deferred mark_hint_seen save if _pending_hint_save is set.

    mark_hint_seen() sets ``_pending_hint_save = True`` instead of calling
    save() inline (item 4 optimisation).  This helper is called at every
    early-return point in pre_read() that follows a hint emission so that
    the fingerprint is persisted before the hook process exits, even when
    no post-read save follows in the same process.  Fail-soft: any exception
    is swallowed so a flush failure never breaks the hook response.
    """
    with contextlib.suppress(Exception):
        if getattr(cache, "_pending_hint_save", False):
            cache._pending_hint_save = False  # type: ignore[attr-defined]  # cache is typed as object; SessionCache has this private attribute at runtime
            _sess = _get_session()
            _sess.save(cache)  # type: ignore[arg-type]  # types.ModuleType; save() accepts SessionCache which cache is at runtime


# mirrors session.py _UNKNOWN_END_SENTINEL — stored when a Read has no limit
_SESSION_UNKNOWN_END = 99_999


def _window_is_covered(
    line_ranges: list[tuple[int, int]],
    req_start: int,
    req_end: int | None,
) -> bool:
    """Return True if [req_start, req_end] is fully covered by the recorded ranges.

    req_end=None means unbounded (the Read has no limit). An unbounded request is
    covered only by the full-file sentinel (0, 0) or a prior unbounded range.
    """
    if (0, 0) in line_ranges:
        return True  # full-file sentinel: whole file already tracked
    if req_end is None:
        # Stored unbounded reads have span == _SESSION_UNKNOWN_END (re = rs + 99_999).
        # Check (re - rs) not (re >= req_start + sentinel): the latter fails when req_start > rs
        # (later-start unbounded re-read after an earlier full-file read slips through).
        return any(rs <= req_start and (re - rs) >= _SESSION_UNKNOWN_END for rs, re in line_ranges)
    return any(rs <= req_start and re >= req_end for rs, re in line_ranges)


def _format_read_ranges(line_ranges: list[tuple[int, int]]) -> str:
    """Format recorded line_ranges for a deny message (short, human-readable)."""
    if (0, 0) in line_ranges:
        return "full file"
    parts = []
    for s, e in line_ranges[:5]:
        parts.append(f"{s}+" if e >= s + _SESSION_UNKNOWN_END else f"{s}–{e}")
    if len(line_ranges) > 5:
        parts.append(f"+{len(line_ranges) - 5} more")
    return ", ".join(parts)


def _uncovered_subranges(
    cached_ranges: list[tuple[int, int]],
    req_start: int,
    req_end: int,
) -> list[tuple[int, int]]:
    """Return sub-ranges of [req_start, req_end] not covered by cached_ranges (1-indexed inclusive)."""
    if (0, 0) in cached_ranges:
        return []
    pending = [(req_start, req_end)]
    for cs, ce in sorted(cached_ranges):
        nxt: list[tuple[int, int]] = []
        for us, ue in pending:
            if ce < us or cs > ue:
                nxt.append((us, ue))
            else:
                if cs > us:
                    nxt.append((us, cs - 1))
                if ce < ue:
                    nxt.append((ce + 1, ue))
        pending = nxt
    return pending


def _handle_partial_overlap_hint(
    file_path: str,
    tool_input: dict[str, object],
    entry: object,
) -> HookResponse | None:
    """Advisory hint when a Read range partially overlaps cached line ranges.

    Fires only when: prior session entry exists, file not edited since last read,
    window is NOT fully covered (deny handles that), and at least one line in the
    requested range is already cached.
    """
    from .hooks_common import record_cached_stat

    line_ranges: list[tuple[int, int]] = getattr(entry, "line_ranges", [])
    if not line_ranges:
        return None

    raw_offset = tool_input.get("offset")
    raw_limit = tool_input.get("limit")
    if not is_real_int(raw_offset) or not is_real_int(raw_limit) or int(raw_limit) <= 0:
        return None  # unbounded or offset-only reads — skip; can't compute uncovered sub-range

    req_start = max(0, int(raw_offset)) + 1  # convert 0-indexed offset → 1-indexed start
    req_end = req_start + int(raw_limit) - 1

    # Must have at least one cached line that overlaps the requested range.
    has_overlap = any(
        cs <= req_end and ce >= req_start
        for cs, ce in line_ranges
        if (cs, ce) != (0, 0)
    ) or (0, 0) in line_ranges
    if not has_overlap:
        return None

    uncovered = _uncovered_subranges(line_ranges, req_start, req_end)
    if not uncovered:
        return None  # fully covered — should have been caught by _handle_reread_deny

    # Build suggestion for the first (and usually only) uncovered sub-range.
    first_start, first_end = uncovered[0]
    suggested_offset = first_start - 1  # back to 0-indexed
    suggested_limit = first_end - first_start + 1

    covered_count = (req_end - req_start + 1) - sum(e - s + 1 for s, e in uncovered)
    filename = Path(file_path).name
    ranges_fmt = _format_read_ranges(line_ranges)

    if len(uncovered) == 1:
        hint = (
            f"Note: {covered_count} line(s) of `{filename}` in the requested range are already in context "
            f"(cached: {ranges_fmt}).\n"
            f"Consider reading only the uncovered portion: offset={suggested_offset} limit={suggested_limit}"
        )
    else:
        parts = [f"offset={s - 1} limit={e - s + 1}" for s, e in uncovered]
        hint = (
            f"Note: {covered_count} line(s) of `{filename}` in the requested range are already in context "
            f"(cached: {ranges_fmt}).\n"
            f"Uncovered sub-ranges: {', '.join(parts)}"
        )

    record_cached_stat("read_partial_overlap_hint", sanitize_log_str(file_path, max_len=200))
    _LOG.debug("pre-read: partial overlap hint file=%s covered=%d", sanitize_log_str(file_path, max_len=100), covered_count)
    return pre_tool_use_with_context(hint)


def _handle_reread_deny(
    session_id: str,
    file_path: str,
    tool_input: dict[str, object],
    cache: object,
) -> HookResponse | None:
    """Deny a Read whose window is already in context from this session.

    Fires when the file has a session FileEntry (was read before), the file was NOT
    edited since its last read (last_edit_ts <= last_read_ts), the requested window
    is fully contained in the recorded line_ranges, and the file is large enough that
    saving the re-read is worth the deny cost.

    Anti-loop guard: the denial is recorded as a hint fingerprint; a second identical
    request for the same (path, window) passes through unconditionally so the model
    is never hard-blocked.
    """
    try:
        from . import config as _cfg_mod

        hints_cfg = _cfg_mod.load().hints
        if not hints_cfg.reread_deny:
            return None
        min_bytes = hints_cfg.reread_deny_min_bytes
    except Exception:
        return None

    if not _cache_is_available(cache):
        return None

    try:
        _sess = _get_session()
        key = _sess._normalize_path(file_path)  # type: ignore[attr-defined]
        entry = cache.files.get(key)  # type: ignore[attr-defined]
    except Exception:
        return None

    if entry is None:
        return None  # first read this session — no history to match against

    # Only fire when the file has NOT been edited since it was last read.
    # If it was edited, the diff-hint path (below in pre_read) handles it.
    if entry.last_edit_ts > entry.last_read_ts:
        return None

    # Single on-disk stat drives both the size gate and the cross-session freshness
    # check below. If the file cannot be stat'd we cannot prove it is unchanged, so
    # we never deny.
    try:
        disk_stat = Path(file_path).stat()
    except OSError:
        return None

    # Size gate: skip tiny files where the hint cost (~25 tok) exceeds the saving.
    if not _is_file_size_sufficient(disk_stat.st_size, min_bytes):
        return None

    # Cross-session freshness gate: if the file's on-disk (mtime_ns, size) no longer
    # matches what was recorded at the last read, it has been modified since — possibly by
    # a sub-agent running under a different session_id, whose edit post_edit recorded against
    # that session's last_edit_ts, never this one. The in-session last_edit_ts guard above is
    # blind to such cross-session edits; denying here would pin the model to stale content and
    # push it to bypass token-goat entirely. Let the re-read through. (Only applies when a
    # fingerprint was recorded; legacy None entries fall through to the SHA/deny path below.
    # The guard is `is not None`, not a truthiness test: an epoch-mtime file records 0, a
    # real value that must still be compared — treating 0 as unrecorded would silently
    # disable the freshness gate for such files and deny stale content.)
    if _file_is_modified(disk_stat.st_mtime_ns, disk_stat.st_size, entry.read_mtime_ns, entry.read_size):
        return None

    # Parse the requested window (1-indexed inclusive).
    raw_offset = tool_input.get("offset")
    raw_limit = tool_input.get("limit")
    req_start: int = max(0, int(raw_offset)) + 1 if is_real_int(raw_offset) else 1
    req_end: int | None
    if is_real_int(raw_limit) and int(raw_limit) > 0:
        req_end = req_start + int(raw_limit) - 1
    else:
        req_end = None  # unbounded — whole file from req_start

    if not _window_is_covered(entry.line_ranges, req_start, req_end):
        return None

    # SHA verification: confirm the file is actually unchanged before denying.
    # When a snapshot SHA exists, compute the on-disk SHA and compare; a mismatch
    # means the file was modified outside the edit hooks (external tool, manual save).
    # Falls through to deny when no snapshot exists (timestamp guard above is sufficient).
    try:
        from . import session as _sess_mod
        stored_sha = _sess_mod.get_snapshot_sha(session_id, file_path, cache=cache)
        if stored_sha:
            current_sha = hashlib.sha256(Path(file_path).read_bytes()).hexdigest()
            if current_sha != stored_sha:
                return None  # changed externally — let the read through
    except Exception:
        pass

    # Anti-loop guard: allow the read through on the second identical attempt.
    _end_tag = str(req_end) if req_end is not None else "eof"
    deny_fp = f"reread_deny:{key}:{req_start}:{_end_tag}"
    if _fingerprint_already_seen(cache, deny_fp):
        _LOG.debug("reread_deny: anti-loop pass-through for %s (%d+)", sanitize_log_str(file_path), req_start)
        return None
    try:
        cache.mark_hint_seen(deny_fp)  # type: ignore[attr-defined]
    except Exception:
        return None

    name = Path(file_path).name
    prior = _format_read_ranges(entry.line_ranges)
    window_str = f"lines {req_start}–{req_end}" if req_end is not None else f"lines {req_start}+"
    reason = f"{name} {window_str} already in context this session — re-read is redundant."
    # Build the symbol-read hint line using real indexed symbols when available.
    _symbol_read_line = f'  `token-goat read "{file_path}::SymbolName"` — extract one symbol'
    try:
        from . import db as _db
        from . import read_replacement as _rr
        from .project import find_project

        _proj = find_project(Path(file_path).parent)
        if _proj is not None:
            _file_rel = _rr.resolve_file_rel(_proj, file_path)
            if _file_rel:
                with _db.open_project_readonly(_proj.hash) as _conn:
                    _sym_rows = _conn.execute(
                        "SELECT name FROM symbols "
                        "WHERE file_rel = ? AND kind NOT IN ('import', 'variable') "
                        "ORDER BY line LIMIT 8",
                        (_file_rel,),
                    ).fetchall()
                if _sym_rows:
                    _names = [r["name"] for r in _sym_rows]
                    _rest = "".join(f", `::{_n}`" for _n in _names[1:])
                    _symbol_read_line = (
                        f'  `token-goat read "{_file_rel}::{_names[0]}"`{_rest}'
                        f" — extract one symbol"
                    )
    except Exception:
        pass
    context = (
        f"`{name}` {window_str} is already in context (prior reads this session: {prior}). "
        f"The file is unchanged. Use what is already in context, or read only the new lines:\n"
        f"  `token-goat symbol <NAME>` — jump to a definition\n"
        f"{_symbol_read_line}\n"
        f"  Re-issue this Read with `offset`/`limit` set to just the lines you need.\n"
        f"(A second identical request passes through automatically if you genuinely need it.)"
    )
    with contextlib.suppress(Exception):
        record_cached_stat("reread_deny", sanitize_log_str(file_path, max_len=512))
    return deny_redirect(reason, context)


def _handle_task_output_read(
    file_path: str,
    session_id: str | None,
) -> HookResponse | None:
    """Detect Claude task-output temp files and redirect subsequent reads to bash-output.

    Claude Code writes agent task results to temp paths like:
    - Windows: ...\\AppData\\Local\\Temp\\claude\\<proj>\\<sess>\\tasks\\<id>.output
    - Unix:    /tmp/claude/<proj>/<sess>/tasks/<id>.output

    First read: store the file content as a bash-output blob, inject a hint showing the
    available recall commands, and let the read proceed (returns pre_tool_use_with_context).

    Subsequent reads: deny the read entirely and redirect to ``token-goat bash-output <id>``.

    Returns None to pass through when the path does not match, session_id is missing,
    or any I/O error occurs (fail-soft: never blocks a read due to an internal error).
    """
    from .bash_compress import _task_output_id

    task_id = _task_output_id(str(file_path))
    if task_id is None:
        return None
    if not session_id:
        return None

    _sess_mod = _get_session()
    cache = _sess_mod.safe_load(session_id, caller="_handle_task_output_read")
    if not _cache_is_available(cache):
        return None

    stored: dict[str, str] = getattr(cache, "stored_task_outputs", {})
    if task_id in stored:
        output_id = stored[task_id]
        reason = f"Task output {task_id} already stored as bash-output blob {output_id}."
        context = (
            f"[tg] Task output `{task_id}` already stored as bash-output `{output_id}`. "
            f"Recall without re-reading:\n"
            f"  token-goat bash-output {output_id}\n"
            f"  token-goat bash-output {output_id} --grep <pattern>\n"
            f"  token-goat bash-output {output_id} --head 50\n"
            f"  token-goat bash-output {output_id} --tail 50\n"
            f"  token-goat bash-output {output_id} --section \"Heading\"\n"
        )
        return deny_redirect(reason, context)

    # First read — read file from disk, store as bash-output blob.
    # Cap at 512 KB to avoid blocking the hook on very large task outputs.
    _MAX_TASK_BYTES = 512 * 1024
    try:
        p = Path(file_path)
        file_size = p.stat().st_size
        if file_size > _MAX_TASK_BYTES:
            raw = p.read_bytes()[:_MAX_TASK_BYTES]
            content = raw.decode("utf-8", errors="replace") + "\n[token-goat: truncated at 512 KB]"
        else:
            content = p.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _LOG.debug(
            "task-output: could not read %s: %s",
            sanitize_log_str(str(file_path)),
            exc,
        )
        return None

    try:
        from . import bash_cache as _bc

        meta = _bc.store_output(
            session_id,
            command=f"# task-output {task_id}",
            stdout=content,
            stderr="",
            exit_code=0,
        )
    except Exception:
        _LOG.debug("task-output: store_output failed for task_id=%s", task_id, exc_info=True)
        return None

    if meta is None:
        return None

    # Mark as stored so subsequent reads are denied, recording the blob ID for recall.
    cache.stored_task_outputs[task_id] = meta.output_id
    with contextlib.suppress(Exception):
        _sess_mod.save(cache)

    n_lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    oid = meta.output_id
    hint = (
        f"[tg] Task output `{task_id}` stored ({n_lines:,} lines / "
        f"{len(content):,} bytes) as bash-output `{oid}`. "
        f"Use surgical reads instead of re-reading this file:\n"
        f"  token-goat bash-output {oid}\n"
        f"  token-goat bash-output {oid} --head 50\n"
        f"  token-goat bash-output {oid} --tail 50\n"
        f"  token-goat bash-output {oid} --grep <pattern>\n"
        f'  token-goat bash-output {oid} --section "Heading"\n'
    )
    return pre_tool_use_with_context(hint)


def pre_read(payload: HookPayload) -> HookResponse:
    """Pre-read hook: image shrinking, dedup hints, and diff-aware re-read hints.

    Dispatches based on tool_name:
    - Bash: first try dedup against prior bash output; then fall through to
      convert read-equivalent commands (cat, head, etc.) to Read and recurse.
    - Read: Attempt image shrinking, then emit diff hint (if file was edited
      since last read and a snapshot exists) or fall back to session hints
      (cached re-read or large-file surgical-read suggestion).
    - Other: Pass through unchanged (CONTINUE).

    Returns hook response dict with optional updatedInput (image shrinking) or
    additionalContext (hint text).

    Hint dedup state is protected by a try/finally: _flush_pending_hint_save
    is guaranteed to run regardless of which return path is taken from the
    Read-tool path, so no new early-return can silently drop the dedup
    fingerprint.
    """
    global _call_index
    _call_index += 1

    from .hints import build_read_hint

    tool_name = payload.get("tool_name")

    if tool_name == "Bash":
        # Fast-path: for commands whose binary is not in any handler's recognition
        # table, return CONTINUE immediately without loading the session cache or
        # DB — saves ~1 s per hook call for the ~50% of Bash invocations that
        # produce nothing.  Excluded: bash_detect binaries (compress), READ/GREP/GLOB
        # binaries (read-equiv / grep handlers), token-goat commands (env-probe /
        # dep-list), _BASH_FAST_PATH_EXCLUDE (which/where), and && commands (compound hint).
        _fp_input = get_tool_input(payload)
        _fp_cmd = (_fp_input.get("command") or "").strip()
        if _fp_cmd and "&&" not in _fp_cmd:
            _fp_parts = _fp_cmd.split()
            _fp_first = (_fp_parts[0] if _fp_parts else "").lower()
            if _fp_first and not _fp_first.startswith(("token-goat", "token_goat")):
                from . import bash_detect as _bdet
                from . import bash_parser as _bpar
                if (
                    not _bdet.detect([_fp_first])
                    and _fp_first not in _bpar.READ_BINS
                    and _fp_first not in _bpar.GREP_BINS
                    and _fp_first not in _bpar.GLOB_BINS
                    and _fp_first not in _BASH_FAST_PATH_EXCLUDE
                ):
                    return CONTINUE()
        # Deferred recovery hint: inject on the first Bash call after compaction
        # if a recovery sidecar exists.  We need a session_id for this so pull
        # it early; if unavailable, fall through without the recovery check.
        _bash_session_id, _bash_cwd = get_session_context(payload)
        if _bash_session_id:
            _sess_mod = _get_session()
            _bash_cache = _sess_mod.safe_load(_bash_session_id, caller="pre_read_bash")
            _recovery_text = _check_recovery_pending(_bash_session_id, _bash_cache)
            if _recovery_text:
                return pre_tool_use_with_context(_recovery_text)

        # Step 1: detect duplicate Bash command from this session.  This must
        # happen *before* the read-equivalent dispatch because re-running
        # `cat file.py` after editing should pull the cached output rather
        # than re-dispatching through the Read pipeline.
        dedup = _handle_bash_dedup(payload)
        if dedup is not None:
            return dedup

        env_probe = _handle_env_probe_serve(payload)
        if env_probe is not None:
            return env_probe

        dep_list = _handle_dep_list_serve(payload)
        if dep_list is not None:
            return dep_list

        bash_already_read = _handle_bash_already_read(payload)
        if bash_already_read is not None:
            return bash_already_read

        # Cross-session cache hit: the command was not run in this session but
        # has a cached output on disk from a prior session.  Emit a hint so the
        # agent can retrieve it without a network round-trip.
        cache_hit = _handle_bash_cache_hit(payload)
        if cache_hit is not None:
            return cache_hit

        # Compound-command hint: when a && / ; chain has ≥1 read-type segment
        # already cached, suggest recalling the cached segment individually.
        # Must run after the exact-match dedup checks (whole command not in
        # cache) but before read-equivalent dispatch (which only sees the first
        # segment).  Always advisory — never blocks.
        compound_hint = _handle_compound_cmd_hint(payload)
        if compound_hint is not None:
            return compound_hint

        # Pattern-level grep dedup: fires for rg/grep/ag/ack commands when the
        # same search pattern has already been run in this session.  Distinct from
        # _handle_bash_dedup (exact-command hash) — this matches by pattern even
        # when flags or paths differ slightly.  Must run before read-equivalent
        # dispatch so that ``rg "TODO" src/`` after a prior ``rg "TODO"`` gets
        # the same advisory as a repeated native Grep tool call.
        bash_grep_dedup = _handle_bash_grep_dedup(payload)
        if bash_grep_dedup is not None:
            return bash_grep_dedup

        # Re-grep advisory for bash rg/grep targeting a specific file.
        _bash_grep_advisory = _handle_bash_grep_advisory(payload)
        if _bash_grep_advisory:
            return pre_tool_use_with_context(_bash_grep_advisory)

        bash_range_hint = _handle_bash_range_read_hint(payload)
        if bash_range_hint is not None:
            return bash_range_hint

        bash_streak_hint = _handle_bash_streak_hint(payload)
        if bash_streak_hint is not None:
            return bash_streak_hint

        bash_poll_hint = _handle_bash_poll_hint(payload)
        if bash_poll_hint is not None:
            return bash_poll_hint

        read_payload = _handle_bash_read_equivalent(payload)
        if read_payload:
            # Recurse once with a synthesized Read payload so image-shrink and
            # session-hint logic runs identically to a native Read call.
            # Depth is bounded at 1: _handle_bash_read_equivalent returns None
            # for any payload whose tool_name is not 'Bash', so the recursive
            # call always reaches the tool_name != "Read" branch at worst.
            return pre_read(read_payload)
        # Not a read-equivalent. Check whether it's a compressible command
        # (pytest, npm install, docker build, ...) and rewrite if so.
        compress_response = _handle_bash_compress(payload)
        if compress_response is not None:
            return compress_response
        return CONTINUE()

    if tool_name == "Grep":
        # Record grep-target count first (before dedup may short-circuit the branch).
        # The advisory is emitted only if no blocking handler fires below.
        dedup = _handle_grep_dedup(payload)
        if dedup is not None:
            return dedup
        written = _handle_grep_written_not_read(payload)
        if written is not None:
            return written
        symbol_redirect = _handle_grep_symbol_redirect(payload)
        if symbol_redirect is not None:
            return symbol_redirect
        large_grep = _handle_large_grep_redirect(payload)
        if large_grep is not None:
            return large_grep
        # Lazy construction: only build advisory if all blocking handlers returned None.
        advisory_text = _handle_grep_advisory(payload)
        if advisory_text:
            return pre_tool_use_with_context(advisory_text)
        return CONTINUE()

    if tool_name == "Glob":
        dedup = _handle_glob_dedup(payload)
        if dedup is not None:
            return dedup
        return CONTINUE()

    if tool_name != "Read":
        _LOG.debug("pre-read: skipping non-Read tool %s", sanitize_opt(tool_name))
        return CONTINUE()

    tool_input = get_tool_input(payload)
    file_path = tool_input.get("file_path")
    if not file_path:
        _LOG.debug("pre-read: no file_path in tool_input; skipping")
        return CONTINUE()

    shrink_response = _try_shrink_image(file_path, tool_input)
    if shrink_response:
        return shrink_response

    notebook_response = _handle_notebook_read(file_path, tool_input)
    if notebook_response:
        return notebook_response

    # Catastrophic-tier guard: hard-deny a full read of a >=10 MB file here, before the binary/large skip and session gate below drop it from the hint pipeline entirely. Such files reach no type-specific handler, so this early position is the only place to catch them; it also covers sessionless and cache-load-failure huge reads. The 45 KB-10 MB band is handled by the fallback call later (after the skill/index/structured/diff handlers get first claim) so those richer redirects are not preempted.
    large_read = _handle_large_read_redirect(
        file_path, tool_input, floor=_LARGE_FILE_HINT_SKIP_BYTES
    )
    if large_read is not None:
        return large_read

    # Load session context only after non-session checks have early-exited; deferred
    # until needed to avoid overhead for sessionless reads.
    session_id, cwd = get_session_context(payload)
    if not session_id:
        _LOG.debug("pre-read: no session_id; skipping hint for %s", sanitize_log_str(file_path))
        return CONTINUE()

    # Task-output intercept: detect Claude agent task temp files and redirect
    # subsequent reads to `token-goat bash-output <id>` instead of re-reading.
    # This must run BEFORE the binary/large file check, since task-output temp files
    # can be large or binary and should be intercepted regardless.
    task_output_response = _handle_task_output_read(file_path, session_id)
    if task_output_response is not None:
        return task_output_response

    # Skip all hint logic for binary files and very large unindexed files.
    # These files are never indexed by token-goat so session hints, diff hints,
    # and structured-file hints would all be meaningless overhead.
    if _is_binary_or_large_file(file_path):
        _LOG.debug("pre-read: skipping hints for binary/large file %s", sanitize_log_str(file_path))
        return CONTINUE()

    session = _get_session()

    cache = load_session_safe(session_id)
    try:
        # Context-pressure tier: used both to lower the surgical-read suggestion
        # threshold (fewer lines needed to trigger a hint under pressure) and to
        # inject a session-wide urgency note when approaching the context limit.
        _ctx_tier = "cool"
        _ctx_fill = 0.0
        _eff_threshold = 500  # lines — default LARGE_FILE_LINE_THRESHOLD
        if cache is not None:
            try:
                from .compact import get_context_pressure as _gcp
                _cp = _gcp(session_id, cache=cache)
                _ctx_tier = _cp.tier
                _ctx_fill = _cp.fill_fraction
                if _ctx_tier == "critical":
                    _eff_threshold = 50
                elif _ctx_tier == "hot":
                    _eff_threshold = 200
                elif _ctx_tier == "warm":
                    _eff_threshold = 350
            except Exception:
                pass

        # Deny whole-file bash cat/bat on indexed files at warm+; flag set by _handle_bash_read_equivalent only for no-limit reads.
        if payload.get("_tg_from_bash_cat"):
            if _ctx_tier in ("warm", "hot", "critical"):
                _cat_deny = _handle_indexed_cat_deny(file_path, tool_input, _ctx_tier)
                if _cat_deny is not None:
                    return _cat_deny
            else:
                # Cool tier: non-blocking advisory so a first whole-file cat of an
                # indexed source file still learns the surgical-read path. Skipped
                # when already read this session (handled by _handle_bash_already_read).
                _cat_adv = _handle_indexed_cat_advisory(file_path, tool_input, cache)
                if _cat_adv is not None:
                    return _cat_adv

        # Deferred recovery hint: inject on the first Read after compaction.
        # This fires before all other hints so the recovery context is the first
        # additionalContext the agent receives in its new post-compact window.
        _recovery_text = _check_recovery_pending(session_id, cache)
        if _recovery_text:
            return pre_tool_use_with_context(_recovery_text)

        # Skill-file read hint: fires first when the agent tries to Read a skill body
        # file directly (e.g. ~/.claude/skills/ralph/SKILL.md) for a skill already
        # loaded this session.  The body is already in context from the Skill tool
        # result; suggest token-goat skill-body instead.
        skill_file_response = _handle_skill_file_read(session_id, file_path, cache)
        if skill_file_response is not None:
            return skill_file_response

        # Index-only file hint: fires first so machine-generated lockfiles and bundles
        # (uv.lock, package-lock.json, *.min.js, *.map, …) are intercepted before any
        # other hint logic runs.  These files are never worth reading in full and the
        # hint saves thousands of tokens per avoided read.
        index_only_response = _handle_index_only_file(session_id, file_path, tool_input, cache)
        if index_only_response is not None:
            return index_only_response

        # Content-dedup: deny full reads of files whose bytes are identical to a file
        # already read this session. Catches symlinks, copies, and vendored duplicates.
        if not _read_is_windowed(tool_input) and cache is not None:
            dedup_response = _check_content_dedup(file_path, cache)
            if dedup_response is not None:
                return dedup_response

        # Stable-doc compact serving: fires before session/diff hints so a user-created
        # compact sidecar is served on first read (not just re-reads).  For fresh
        # compacts this is a deny-redirect that serves the compact body instead of the
        # full file.  For large uncompacted markdown it emits a section-map suggestion.
        doc_compact_response = _handle_doc_compact(file_path, cwd, cache)
        if doc_compact_response is not None:
            return doc_compact_response

        # Structured-file hint: fires before session/diff hints so a first-time read
        # of a large CSV/JSON/log is intercepted immediately.  Short-circuits when
        # the caller already uses offset+limit (surgical intent) or the file is small.
        structured_response = _handle_structured_file(session_id, file_path, tool_input, cache)
        if structured_response is not None:
            return structured_response

        # Collect context parts from all hint sources with priority levels.
        # Each item is a (priority, text) tuple; lower priority value = higher importance.
        # Priority constants: CRITICAL=1 (edited-file), HIGH=2 (diff), MEDIUM=3 (re-read),
        # LOW=4 (grep/bash/glob dedup). At the end, hints are sorted by priority and
        # capped at HINT_MAX_PER_TOOL_CALL with a suppression footer when over the cap.
        from .hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_HIGH,
            HINT_PRIORITY_LOW,
            HINT_PRIORITY_MEDIUM,
            HintItem,
            apply_hint_priority_limit,
        )
        hint_items: list[HintItem] = []

        # Content-unchanged short-circuit: file was edited in this session AND the
        # current on-disk SHA matches the snapshot taken after the last Read.  This
        # means the agent's edit IS the current file content — a full re-read
        # returns bytes already visible in the Edit tool result.  Fires before the
        # diff-hint path because SHA-match is a stronger signal (no diff to show).
        # Only fires for unscooped full reads (no offset/limit).
        unchanged_response = _try_unchanged_file_hint(
            session_id, file_path, tool_input, cache
        )
        if unchanged_response is not None:
            return unchanged_response

        # Session cache required for all hint paths below — bail early if unavailable.
        if cache is None:
            return CONTINUE()

        # Re-read deny: file window already in context and file is unchanged.
        # Fires after skill/index/structured/unchanged handlers (which have richer redirects);
        # before the diff block (which handles the edited-file case).
        _reread_deny = _handle_reread_deny(session_id, file_path, tool_input, cache)
        if _reread_deny is not None:
            return _reread_deny

        entry = cache.files.get(session._normalize_path(file_path))  # type: ignore[attr-defined]  # private function on lazy-loaded session module (types.ModuleType has no typed attrs)

        # Partial-overlap advisory: some lines already in context; suggest narrowed read.
        # Only check for overlaps if entry exists and file hasn't been edited since last read.
        if entry is not None and entry.last_edit_ts <= entry.last_read_ts:
            _partial_overlap = _handle_partial_overlap_hint(file_path, tool_input, entry)
            if _partial_overlap is not None:
                return _partial_overlap

        # Diff-aware path: file was read AND edited in this session AND we have
        # a snapshot to compare against.  When applicable, the diff hint replaces
        # the standard cache hint — both communicate the same idea (you've seen
        # this file before) but the diff carries the actually-changed bytes.
        #
        # Predictive-prefetch unlock: when the file has never been read in this
        # session BUT a predictive snapshot exists (written by post_edit's
        # import-following path), still route through the diff hint.  The
        # snapshot represents what the agent would have seen at the moment of
        # the editing peer's last read of the disk file; if the file has changed
        # since then the diff is genuinely useful, and if it hasn't,
        # build_diff_hint returns None (its size + min-saving thresholds remain
        # the only emission gate).  Without this branch, every predictive
        # snapshot is pure overhead with no payoff path.
        _predictive_unlock = False
        if entry is None or entry.last_edit_ts <= entry.last_read_ts:
            try:
                from . import snapshots as _snap_mod

                if _snap_mod.load_kind(session_id, file_path) == "predictive":
                    _predictive_unlock = True
            except (OSError, KeyError, AttributeError):
                # OSError: snapshot file not found or unreadable
                # KeyError: session entry missing from snapshot index
                # AttributeError: missing snapshot module or attributes
                _predictive_unlock = False
            except Exception:
                _LOG.debug("pre-read: predictive unlock check failed", exc_info=True)
                _predictive_unlock = False
        if (entry is not None and entry.last_edit_ts > entry.last_read_ts) or _predictive_unlock:
            # Compute requested read range for the overlap guard in _try_diff_hint
            # and _try_diff_serve.
            _raw_offset = tool_input.get("offset")
            _raw_limit = tool_input.get("limit")
            _req_start: int | None = None
            _req_end: int | None = None
            try:
                from .hints import DEFAULT_READ_LIMIT

                _safe_offset = max(0, int(_raw_offset)) if _raw_offset is not None else 0
                _safe_limit = max(0, int(_raw_limit)) if _raw_limit is not None else 0
                _req_start = _safe_offset + 1
                _req_end = _req_start + (_safe_limit or DEFAULT_READ_LIMIT) - 1
            except (TypeError, ValueError):
                pass

            # serve_diff_on_reread: when enabled, block the Read and serve the
            # unified diff as the tool result instead of the full file.  Fires
            # before the normal diff-hint path — if it returns a response we
            # short-circuit the entire hint pipeline.
            _hints_cfg = None
            try:
                from . import config as _cfg_mod

                _hints_cfg = _cfg_mod.load().hints
            except Exception:
                pass
            if _hints_cfg is not None and getattr(_hints_cfg, "serve_diff_on_reread", False):
                _diff_serve_response = _try_diff_serve(
                    session_id,
                    file_path,
                    req_start=_req_start,
                    req_end=_req_end,
                    entry_line_ranges=entry.line_ranges if entry is not None else None,
                )
                if _diff_serve_response is not None:
                    return _diff_serve_response

            diff_response = _try_diff_hint(
                session_id,
                file_path,
                req_start=_req_start,
                req_end=_req_end,
                entry_line_ranges=entry.line_ranges if entry is not None else None,
            )
            if diff_response is not None:
                # Extract the text so we can combine with other hints via priority ordering.
                hso = diff_response.get("hookSpecificOutput") or {}
                diff_text = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
                if diff_text:
                    # Fingerprint dedup: suppress diff hints whose content hasn't changed
                    # since the last emission (i.e., same edit, same diff, repeated re-read).
                    # The fingerprint includes the diff text so a new edit produces new
                    # content → new fingerprint → emits again.
                    from .hints import _hint_fingerprint as _dhfp

                    _diff_fp = _dhfp(diff_text, path=file_path)
                    if cache.has_hint_fingerprint(_diff_fp):
                        # Identical diff hint already emitted in this session — suppress.
                        _LOG.debug(
                            "pre-read: diff hint fingerprint %s already seen; suppressing duplicate for %s",
                            _diff_fp,
                            sanitize_log_str(file_path),
                        )
                        record_cached_stat(
                            "diff_hint_backoff_suppressed",
                            sanitize_log_str(file_path, max_len=512),
                        )
                    else:
                        # New fingerprint — mark seen and emit.
                        cache.mark_hint_seen(_diff_fp)
                        # Diff hints are HIGH priority: file changed since last read.
                        hint_items.append(HintItem(diff_text, HINT_PRIORITY_HIGH))

        if not hint_items:
            # Large-read fallback (45 KB-10 MB band): no recovery/skill/index/structured/unchanged/serve-diff/diff hint claimed this read, so it is a full read of a large file with no cheaper context already available. Hard-deny and redirect to surgical/windowed reads before build_read_hint softens it to an advisory — the user-chosen mechanism is a deny, not a nudge. Placed after the diff block so serve_diff_on_reread and real diff hints (which populate hint_items above) always win; windowed/binary/small/under-threshold reads return None and fall through to the normal hint logic below.
            large_read = _handle_large_read_redirect(file_path, tool_input, tier=_ctx_tier)
            if large_read is not None:
                return large_read
            # Per-file hint cooldown: if a tokens_saved>0 session hint was already
            # emitted for this file this session AND the file has not been edited
            # since then, suppress the hint to reduce noise.  Record the suppression
            # as a session_hint_suppressed stat so operators can see the benefit.
            _file_key = session._normalize_path(file_path)  # type: ignore[attr-defined]
            _hint_cooldown_active = (
                hasattr(cache, "has_session_hint_been_emitted")
                and cache.has_session_hint_been_emitted(_file_key)
                and not (entry is not None and entry.last_edit_ts > entry.last_read_ts)
            )
            hint = None
            if _hint_cooldown_active:
                _LOG.debug(
                    "pre-read: session hint suppressed (per-file cooldown) for %s",
                    sanitize_log_str(file_path),
                )
                cache.record_hint_suppressed("session_hint_suppressed")
                # Record to the stats DB as a zero-saving suppression event so
                # ``token-goat stats`` can show the per-file cooldown savings.
                record_cached_stat(
                    "session_hint_suppressed",
                    sanitize_log_str(file_path, max_len=512),
                )
            else:
                # Exponential-backoff suppression: emit the session hint only at
                # specific read_count thresholds so heavily-used files do not
                # produce a hint on every re-read.  read_count is the number of
                # prior reads (already recorded by the post-Read hook); a file
                # with read_count=0 has never been read this session (no hint
                # possible yet).  The backoff thresholds {1, 3, 10, 30} fire on
                # the 2nd, 4th, 11th, and 31st reads, cutting volume by ~70%.
                # Backoff only applies when entry exists (read_count >= 1); a
                # missing entry means this is the first read and build_read_hint
                # returns None anyway.  An empty threshold list disables backoff
                # (original behaviour: emit on every re-read).
                _backoff_active = False
                if entry is not None:
                    _entry_read_count = entry.read_count
                    try:
                        from . import config as _cfg_mod_bo
                        _bo_thresholds = _cfg_mod_bo.load().hints.backoff_thresholds
                    except Exception:
                        _bo_thresholds = [1, 3, 10, 30]
                    if _bo_thresholds and _entry_read_count not in _bo_thresholds:
                        _backoff_active = True
                        _LOG.debug(
                            "pre-read: session hint suppressed (backoff) for %s "
                            "(read_count=%d not in thresholds=%s)",
                            sanitize_log_str(file_path),
                            _entry_read_count,
                            _bo_thresholds,
                        )
                        cache.record_hint_suppressed("hint_backoff_suppressed")
                        record_cached_stat(
                            "hint_backoff_suppressed",
                            sanitize_log_str(file_path, max_len=512),
                        )
                if not _backoff_active:
                    # Recent-read suppression: skip hint when file was read very recently
                    # (within protect_recent_reads tool calls) — content is still in context.
                    _recent_suppress = False
                    if entry is not None and entry.last_read_call_index > 0:
                        try:
                            from . import config as _cfg_mod_rr
                            _protect = _cfg_mod_rr.load().hints.protect_recent_reads
                        except Exception:
                            _protect = 4
                        if _protect > 0 and (_call_index - entry.last_read_call_index) <= _protect:
                            _recent_suppress = True
                            _LOG.debug(
                                "pre-read: session hint suppressed (recent-read window=%d, gap=%d) for %s",
                                _protect,
                                _call_index - entry.last_read_call_index,
                                sanitize_log_str(file_path),
                            )
                            cache.record_hint_suppressed("hint_recent_read_suppressed")
                            record_cached_stat(
                                "hint_recent_read_suppressed",
                                sanitize_log_str(file_path, max_len=512),
                            )
                    if _recent_suppress:
                        pass
                    # Skip if file was last read before the most recent compact —
                    # that content is gone from the context window.
                    elif (
                        entry is not None
                        and (compact_ts := getattr(cache, "last_compact_ts", 0.0))
                        and entry.last_read_ts < compact_ts
                    ):
                        _LOG.debug(
                            "pre-read: session hint suppressed (post-compact) for %s",
                            sanitize_log_str(file_path),
                        )
                        cache.record_hint_suppressed("hint_post_compact_suppressed")
                        record_cached_stat(
                            "hint_post_compact_suppressed",
                            sanitize_log_str(file_path, max_len=512),
                        )
                    else:
                        hint = build_read_hint(
                            session_id=session_id,
                            file_path=file_path,
                            offset=tool_input.get("offset"),
                            limit=tool_input.get("limit"),
                            cwd=cwd,
                            cache=cache,
                            large_file_line_threshold=_eff_threshold,
                        )
            if hint:
                from .hints import _hint_fingerprint

                hint_text = str(hint)
                fingerprint = _hint_fingerprint(hint_text, path=file_path)

                # Suppress hint if identical hint was already seen in this session.
                # NOTE: this block intentionally does NOT use emit_if_new_hint()
                # because it has unique side effects absent from the surgical/git paths:
                # a tokens_saved branch that calls _record_session_hint_impact() and the
                # curator's _record_hint_emitted() (hints.py), plus a separate log line for
                # the tokens_saved=0 case.  Adding those as optional callbacks would make
                # emit_if_new_hint more complex than the inlined form.
                if cache.has_hint_fingerprint(fingerprint):
                    _LOG.debug(
                        "pre-read: hint fingerprint %s already seen; suppressing duplicate for %s",
                        fingerprint,
                        sanitize_log_str(file_path),
                    )
                else:
                    _hint_kind = "already_read" if hint.tokens_saved > 0 else "read_suggestion"
                    if hint.tokens_saved > 0:
                        _LOG.debug(
                            "pre-read: hint injected for %s (tokens_saved=%d)",
                            sanitize_log_str(file_path), hint.tokens_saved,
                        )
                        _record_session_hint_impact(file_path, hint)
                        # Curator: record emission keyed by path — only after confirming the
                        # hint passes fingerprint dedup and will actually enter context.
                        from .hints import _record_hint_emitted as _rhe
                        _rhe(cache, session._normalize_path(file_path))  # type: ignore[attr-defined]  # private function on lazy-loaded session module
                        # Per-file cooldown: mark this file as already hinted so
                        # subsequent reads (without an intervening edit) are suppressed.
                        if hasattr(cache, "mark_session_hint_emitted"):
                            cache.mark_session_hint_emitted(_file_key)
                    else:
                        _LOG.debug(
                            "pre-read: hint built for %s but tokens_saved=0; no stat recorded",
                            sanitize_log_str(file_path),
                        )
                    # per-type counter: increment only when hint enters context.
                    cache.record_hint_emitted(_hint_kind)
                    # Re-read hints are MEDIUM priority.
                    hint_items.append(HintItem(hint_text, HINT_PRIORITY_MEDIUM))
                    cache.mark_hint_seen(fingerprint)

            # When the file was edited since the last read AND no diff hint or
            # session hint fired (diff too small, no snapshot, first-read-after-edit),
            # inject a lightweight "file changed since last read" note so the agent
            # knows the content it may remember from context is stale.  This fires
            # only when hint_items is still empty to avoid duplicating a message
            # already present from the diff or session hint paths above.
            if not hint_items and entry is not None and entry.last_edit_ts > entry.last_read_ts:
                _fname = sanitize_log_str(file_path, max_len=256)
                from .hints import _hint_fingerprint as _hfp
                _changed_note = (
                    f"Note: `{sanitize_log_str(file_path, max_len=200)}` was edited since you last read it. "
                    f"The version you may remember from context may be stale."
                )
                _changed_fp = _hfp(_changed_note, path=file_path)
                if not cache.has_hint_fingerprint(_changed_fp):
                    cache.mark_hint_seen(_changed_fp)
                    cache.record_hint_emitted("file_changed_since_read")
                    record_hint_stat_pair("file_changed_since_read", _changed_note, _fname)
                    # Edited-file notes are CRITICAL priority: highest importance.
                    hint_items.append(HintItem(_changed_note, HINT_PRIORITY_CRITICAL))
                    _LOG.debug(
                        "pre-read: file-changed-since-read note for %s",
                        sanitize_log_str(file_path),
                    )

        # File written this session but never read back — the content the model
        # wrote may still be in context from the Write/Edit tool result, making a
        # full re-read redundant.  Only fires when no other hint was emitted, so
        # it never shadows a more specific diff-hint or cache-overlap hint.
        if not hint_items:
            _written_key = session._normalize_path(file_path)  # type: ignore[attr-defined]  # private function on lazy-loaded session module
            _edited: dict[str, int] = cache.edited_files if isinstance(cache.edited_files, dict) else {}
            _edit_count = _edited.get(_written_key, 0)
            if _edit_count >= 1 and _written_key not in cache.files:
                _fname = sanitize_log_str(Path(file_path).name, max_len=256)
                # Written-but-not-read hints are CRITICAL priority: edited-file context.
                hint_items.append(HintItem(
                    f"Note: `{_fname}` was written {_edit_count}x this session and not yet read back. "
                    f"The content you wrote may still be in context from the tool result — "
                    f"verify there rather than re-reading. For a specific symbol use "
                    f"`token-goat read \"{file_path}::SymbolName\"`.",
                    HINT_PRIORITY_CRITICAL,
                ))
                _LOG.debug(
                    "pre-read: written-not-read hint for %s (edit_count=%d)",
                    sanitize_log_str(file_path), _edit_count,
                )

        # Surgical-read suggestion: when the read covers a specific line range that
        # maps to known indexed symbols, name them so the agent has the precise
        # `token-goat read` command for repeat access.  Fires even on the first
        # read — the value is teaching the cheaper path before the second trip.
        # Uses fingerprint dedup so it only fires once per unique (file, range) pair.
        _raw_offset = tool_input.get("offset")
        _raw_limit = tool_input.get("limit")
        # Fire the surgical hint for any bounded read (offset known).  When limit
        # is absent (open-ended ``tail -n +N`` reads), use 2000 as a proxy for
        # "rest of file" — matches the Read tool's default page size and is large
        # enough to cover typical function/class bodies while the ≤3-symbol guard
        # prevents false-positive hints on files with dense symbol coverage.
        # Skip the hint if the Read tool was called directly with both offset and limit ≤ 80 lines.
        # (Don't suppress for bash-converted reads, which always benefit from the hint.)
        _is_from_bash = payload.get("_tg_from_bash_parser", False)
        _surg_hint: str | None = None
        if _raw_offset is not None and not (not _is_from_bash and _raw_limit is not None and int(_raw_limit) <= 80):
            try:
                _limit_is_sentinel = _raw_limit is None
                _eff_limit = int(_raw_limit) if _raw_limit is not None else 2000
                _surg_hint = _try_surgical_read_hint(
                    file_path, int(_raw_offset), _eff_limit, cwd,
                    limit_is_sentinel=_limit_is_sentinel,
                )
            except (TypeError, ValueError):
                _surg_hint = None
            if _surg_hint:
                from .hints import _hint_fingerprint
                _surg_fp = _hint_fingerprint(_surg_hint, path=file_path)
                # Surgical hints are LOW priority: informational, not urgent.
                _surg_parts: list[str] = []
                if emit_if_new_hint(cache, _surg_fp, _surg_hint, "surgical_suggestion", _surg_parts):
                    hint_items.append(HintItem(_surg_parts[0], HINT_PRIORITY_LOW))

        # Append git commit history for the file (with dedup and session-age gate).
        # Skip git hint for files edited this session (agent already knows they changed).
        # Skip for new sessions (<120s) where git history is not yet relevant.
        _written_key = session._normalize_path(file_path)  # type: ignore[attr-defined]  # private function on lazy-loaded session module
        _git_edited: dict[str, int] = cache.edited_files if isinstance(cache.edited_files, dict) else {}
        _created_ts = getattr(cache, 'created_ts', time.time())
        _is_edited = _written_key in _git_edited
        _is_new_session = False
        if isinstance(_created_ts, (int, float)):
            _session_age = time.time() - _created_ts
            _is_new_session = _session_age < 120.0

        if not _is_edited and not _is_new_session:
            git_ctx = _build_git_hint(cwd, file_path)
            if git_ctx:
                from .hints import _hint_fingerprint
                _git_fp = _hint_fingerprint(git_ctx, path=file_path)
                # Git history hints are LOW priority: supplemental context.
                _git_parts: list[str] = []
                if emit_if_new_hint(cache, _git_fp, git_ctx, "git_history", _git_parts):
                    hint_items.append(HintItem(_git_parts[0], HINT_PRIORITY_LOW))

        # High-frequency access hint: when this file has been read 3+ times in
        # the session, emit a MEDIUM-priority nudge toward surgical reads so the
        # agent is aware of cheaper alternatives.  Uses fingerprint dedup so it
        # fires at most once per file per session (the read count in the text
        # is intentionally omitted from the fingerprint to keep the dedup stable
        # as count increases past the threshold).
        from .hints import _hint_fingerprint as _hfp2
        from .hints import build_high_frequency_hint
        _sym_from_surg: str | None = None
        if _surg_hint:
            import re as _re
            _sym_m = _re.search(r'token-goat read "[^"]+::([^"<]+)"', _surg_hint)
            if _sym_m:
                _sym_from_surg = _sym_m.group(1)
        _freq_item = build_high_frequency_hint(cache, file_path, resolved_symbol=_sym_from_surg)
        if _freq_item is not None:
            _freq_fp = _hfp2(_freq_item.text, path=file_path)
            if not cache.has_hint_fingerprint(_freq_fp):
                cache.mark_hint_seen(_freq_fp)
                cache.record_hint_emitted("high_frequency_read")
                hint_items.append(_freq_item)
                _LOG.debug(
                    "pre-read: high-frequency hint for %s (access count=%d)",
                    sanitize_log_str(file_path),
                    cache.get_file_access_count(file_path),
                )

        # Test-file hint: when reading a test file, check if the corresponding
        # implementation file has been read this session. If not, suggest reading it first.
        try:
            from .hints import build_test_file_hint
            from .project import find_project as _find_project_for_test

            _cwd_path = validate_cwd(cwd, caller="test-file-hint")
            if _cwd_path is not None:
                _proj = _find_project_for_test(_cwd_path)
                if _proj is not None:
                    _test_hint = build_test_file_hint(file_path, cache, _proj.root)
                    if _test_hint is not None:
                        _test_fp = _hfp2(_test_hint.text, path=file_path)
                        if not cache.has_hint_fingerprint(_test_fp):
                            cache.mark_hint_seen(_test_fp)
                            hint_items.append(_test_hint)
                            _LOG.debug(
                                "pre-read: test-file hint for %s",
                                sanitize_log_str(file_path),
                            )
        except (AttributeError, ValueError, OSError):
            # OSError: path validation or project lookup failed
            # AttributeError: missing project attributes
            # ValueError: path resolution failed
            pass
        except Exception:
            _LOG.debug("test-file-hint: unexpected exception", exc_info=True)

        # Context-pressure urgency note: emit once per session per tier transition
        # at warm (≥50%), hot (≥70%), or critical (≥85%) fill to remind the agent
        # to read surgically.  The message escalates with the tier so the agent
        # gets a gentle nudge early and a hard warning late.  Uses a tier-keyed
        # fingerprint so it fires exactly once per tier level regardless of how
        # many files are subsequently read.
        if _ctx_tier in ("warm", "hot", "critical") and cache is not None:
            try:
                from .hints import _hint_fingerprint as _cpfp
                _pct = int(_ctx_fill * 100)
                if _ctx_tier == "critical":
                    _cp_text = (
                        f"CONTEXT CRITICAL ({_pct}% full): context window is almost full. "
                        f"Read ONLY with surgical token-goat commands — "
                        f"files ≥{_eff_threshold} lines now trigger surgical hints. "
                        f"Avoid full-file reads; compact or wrap up soon."
                    )
                elif _ctx_tier == "hot":
                    _cp_text = (
                        f"Context pressure ({_pct}% full): prefer surgical reads. "
                        f"Files ≥{_eff_threshold} lines now trigger surgical-read suggestions."
                    )
                else:  # warm
                    _cp_text = (
                        f"Context warming ({_pct}% full): consider surgical reads for large "
                        f"files. Files ≥{_eff_threshold} lines now trigger surgical-read "
                        f"suggestions."
                    )
                _cp_fp = _cpfp(_cp_text, path=f"__ctx_pressure_{_ctx_tier}__")
                if not cache.has_hint_fingerprint(_cp_fp):
                    cache.mark_hint_seen(_cp_fp)
                    cache.record_hint_emitted("context_pressure_warning")
                    # Context-pressure warnings are MEDIUM priority.
                    hint_items.append(HintItem(_cp_text, HINT_PRIORITY_MEDIUM))
                    _LOG.debug(
                        "pre-read: context-pressure urgency note (tier=%s, fill=%.2f)",
                        _ctx_tier, _ctx_fill,
                    )
            except Exception:
                pass

        if not hint_items:
            _LOG.debug("pre-read: no hint for %s", sanitize_log_str(file_path))
            return CONTINUE()

        # Compress duplicate hints by content hash: replace repeats with short stubs.
        from .hints import dedup_hints
        deduped_items = dedup_hints(hint_items, cache)

        # Apply priority ordering and cap: sort by priority, emit at most
        # HINT_MAX_PER_TOOL_CALL hints, append suppression footer when over cap.
        ordered_texts = apply_hint_priority_limit(deduped_items, tier=_ctx_tier)
        return pre_tool_use_with_context("\n\n".join(ordered_texts))
    finally:
        _flush_pending_hint_save(cache)


def _check_ignored_hint_by_key(cache: object, key: str, label: str) -> None:
    """Increment hints_ignored when *key* is found in ``cache.recent_hints``.

    Shared implementation for :func:`_check_ignored_hint` (file-path key) and
    :func:`_check_ignored_bash_hint` (command SHA key).  Both use the same
    ring-buffer scan: find the key, increment ``hints_ignored``, remove the
    entry so a second hit in the same session does not double-count, and log.

    *label* is used only in the debug log line to distinguish the two callers.

    Fail-soft: any exception is swallowed — the hook must never fail due to
    curator bookkeeping.
    """
    try:
        recent_hints = getattr(cache, "recent_hints", [])
        if not recent_hints:
            return
        for hint_key, _ts in recent_hints:
            if hint_key == key:
                cache.hints_ignored += 1  # type: ignore[union-attr, attr-defined]  # cache typed as object; SessionCache has this attr at runtime
                cache._invalidate_json_cache()  # type: ignore[union-attr, attr-defined]  # private method on SessionCache; guarded by try/except
                # Remove from ring buffer so a second Read/Bash doesn't double-count.
                cache.recent_hints = [  # type: ignore[union-attr, attr-defined]  # SessionCache attr; object typing from load_session_safe()
                    (k, t) for k, t in cache.recent_hints  # type: ignore[union-attr, attr-defined]  # same
                    if k != key
                ]
                _LOG.debug(
                    "curator: hints_ignored++ for %s (total=%d)",
                    label, cache.hints_ignored,  # type: ignore[union-attr, attr-defined]  # same
                )
                break
    except Exception:
        pass


def _check_ignored_hint(cache: object, file_path: str) -> None:
    """Increment hints_ignored when a Read fires for a recently-hinted path.

    When the agent was told "you already read <path>, ~N tokens wasted" and then
    immediately reads the file anyway, the hint had no effect.  We record that
    as an ignored hint so the curator can suppress future hints once the ignore
    rate exceeds the configured threshold.

    A hint is considered "recent" when the path appears in ``cache.recent_hints``
    (the last 3 emitted hint paths tracked by ``_record_hint_emitted``).  The
    ring buffer is small enough that a linear scan is O(3) = O(1).

    Fail-soft: any attribute access error or unexpected exception is swallowed
    silently — the hook must never fail due to curator bookkeeping.
    """
    try:
        _sess = _get_session()
        norm = _sess._normalize_path(file_path)  # type: ignore[attr-defined]  # private function on lazy-loaded session module
    except Exception:
        return
    _check_ignored_hint_by_key(cache, norm, sanitize_log_str(file_path))


def _check_ignored_bash_hint(cache: object, command: str, cwd: str | None = None) -> None:
    """Increment hints_ignored when a Bash command runs after a bash-dedup hint.

    When the agent was told "this command ran earlier, use bash-output <id>" and
    then runs the same command anyway via Bash, the hint had no effect.  Recording
    that as an ignored hint lets the curator reduce bash-dedup hint frequency once
    the ignore rate exceeds the configured threshold — exactly the same feedback
    loop that ``_check_ignored_hint`` provides for file-read hints.

    ``_record_hint_emitted`` stores ``cmd_sha`` (a hex content hash of the command
    scoped to *cwd*) in ``cache.recent_hints`` alongside file paths.  We compute
    the same hash here and scan the ring buffer for a match.  Because ``cmd_sha``
    is already a normalised hex string, no path-normalization step is needed.

    Fail-soft: any exception is swallowed — the hook must never fail due to
    curator bookkeeping.
    """
    try:
        from . import bash_cache as _bc
        cmd_sha = _bc.command_hash(command, cwd)
    except Exception:
        return
    _check_ignored_hint_by_key(cache, cmd_sha, f"bash cmd {sanitize_log_str(command, max_len=60)}")


def _is_memory_file(path: str) -> bool:
    """Return True when *path* is an individual Claude memory file.

    Matches paths that contain both ``.claude`` and ``memory`` directory
    components and end with ``.md``, but excludes ``MEMORY.md`` (the index).
    """
    p = Path(path)
    name_lower = p.name.lower()
    if name_lower == "memory.md":
        return False
    if not name_lower.endswith(".md"):
        return False
    parts_lower = [part.lower() for part in p.parts]
    return ".claude" in parts_lower and "memory" in parts_lower


def _strip_memory_frontmatter(content: str) -> tuple[str, int]:
    """Strip YAML frontmatter from a memory file body.

    If *content* starts with ``---\\n`` (LF or CRLF), strips everything up to
    and including the closing ``---`` fence line and any immediately following
    blank line.

    Returns ``(stripped_content, lines_stripped)`` where *lines_stripped* is 0
    when no frontmatter was found or the closing fence is missing.
    """
    if not content.startswith("---\n") and not content.startswith("---\r\n"):
        return content, 0

    lines = content.splitlines(keepends=True)
    close_idx: int | None = None
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r\n") == "---":
            close_idx = i
            break

    if close_idx is None:
        # Malformed — no closing fence; pass through unchanged.
        return content, 0

    body_start = close_idx + 1
    # Skip a single blank line that conventionally follows YAML frontmatter.
    if body_start < len(lines) and lines[body_start].rstrip("\r\n") == "":
        body_start += 1

    return "".join(lines[body_start:]), body_start


def _detect_partial_read(text: str) -> tuple[int, int, int] | None:
    """Parse a Claude Code partial-read sentinel from tool result text.

    Returns (start_line, end_line, total_lines) when a sentinel is found, or None.
    Supports hyphen/en-dash form ("lines 1-200 of 1500") and word form
    ("showing lines 1 to 200 of 1500").
    """
    m = _PARTIAL_READ_RE_HYPHEN.search(text)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))
    m = _PARTIAL_READ_RE_TO.search(text)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))
    return None


def post_read(payload: HookPayload) -> HookResponse:
    """Post-read hook: record file/symbol accesses to session cache.

    Logs Read, Grep, and Glob operations into the persistent session cache so that
    subsequent reads can detect overlaps and re-read attempts, enabling session hints
    on follow-up file accesses in the same session.

    For individual Claude memory files (paths matching ``*/.claude/*/memory/*.md``,
    excluding ``MEMORY.md``), strips the YAML frontmatter block and returns the body
    via ``systemMessage`` to avoid repeating metadata already present in the index.

    Returns CONTINUE() after recording; modifies tool output only for memory files
    with frontmatter.
    """
    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return CONTINUE()

    session = _get_session()

    cache = load_session_safe(session_id)
    if cache is None:
        return CONTINUE()

    # Accumulate measured response tokens before any branch saves the cache.
    _resp_text = extract_tool_response_text(payload)
    if _resp_text:
        cache.observed_tool_tokens += len(_resp_text) // 4

    tool_name = payload.get("tool_name")
    tool_input = get_tool_input(payload)

    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        if file_path:
            offset = tool_input.get("offset")
            limit = tool_input.get("limit")
            session.mark_file_read(session_id, file_path, offset, limit, cache=cache, call_index=_call_index)
            _LOG.debug(
                "post-read: recorded Read file=%s offset=%s limit=%s",
                sanitize_log_str(file_path), offset, limit,
            )
            # Curator: check if this Read is for a path that was recently hinted.
            # If the agent reads the file anyway within the hint window, it ignored the hint.
            _check_ignored_hint(cache, file_path)
            # Register file content SHA for cross-file dedup on future reads.
            # Also record a SHA256 for cross-tool dedup (cat vs Read in post_bash).
            if not _read_is_windowed(tool_input):
                try:
                    _p = Path(file_path)
                    if _p.is_file() and 0 < _p.stat().st_size <= _CONTENT_DEDUP_MAX_BYTES:
                        _raw = _p.read_bytes()
                        _sha16 = hashlib.sha1(_raw, usedforsecurity=False).hexdigest()[:16]
                        _norm = str(_p.resolve()).replace("\\", "/")
                        cache.register_file_content(_sha16, _norm)
                        # SHA256 for cross-tool dedup with `cat FILE`.
                        # Normalize CRLF → LF before hashing so the comparison
                        # is stable across Windows text-mode / Unix LF variations.
                        _sha256 = hashlib.sha256(_raw.replace(b"\r\n", b"\n")).hexdigest()
                        cache.record_read_hash(_norm, _sha256)
                except Exception:
                    pass
            # Persist curator mutations (hints_ignored, recent_hints) unconditionally.
            # _try_snapshot only saves when it stores a snapshot, so for files that
            # exceed MAX_SNAPSHOT_BYTES or fail to open the increment would be lost.
            with contextlib.suppress(Exception):
                session.save(cache)
            # Capture a content snapshot so a future re-read after an edit can
            # be served as a small unified diff instead of a full-file Read.
            # Best-effort — snapshot failures never block the hook.
            _try_snapshot(session_id, file_path, cache=cache)
            # Truncated-read advisory: detect partial-read sentinels in the tool result
            # and suggest surgical alternatives to avoid token-expensive full-file re-reads.
            if _resp_text:
                _partial = _detect_partial_read(_resp_text)
                if _partial is not None:
                    _pr_start, _pr_end, _pr_total = _partial
                    _pr_ext = Path(file_path).suffix.lower()
                    import os as _os
                    _pr_disabled = _strip_lower(_os.environ.get(_ENV_BASH_COMPRESS, "")) in _FALSY_ENV
                    try:
                        from . import config as _cfg_trunc
                        _pr_min = _cfg_trunc.load().hints.truncated_read_min_lines
                    except Exception:
                        _pr_min = 200
                    _pr_skip = (
                        (_pr_start == 1 and _pr_end >= _pr_total)
                        or _pr_total <= _pr_min
                        or _pr_ext in _TRUNCATED_HINT_SKIP_EXTS
                        or _pr_disabled
                    )
                    if not _pr_skip:
                        _pr_hint = (
                            f"[token-goat] File is {_pr_total} lines. Consider:\n"
                            f'  token-goat section "{file_path}::Heading"  — extract named section (~95% smaller)\n'
                            f"  token-goat skeleton {file_path}            — full symbol list without bodies\n"
                            f'  token-goat read "{file_path}::N-M"        — targeted line range'
                        )
                        return continue_with_message(_pr_hint)
            # Memory file frontmatter stripping: when the agent reads an
            # individual memory file, strip the YAML block (already captured in
            # MEMORY.md) and surface only the body via systemMessage.
            if _is_memory_file(file_path) and _resp_text:
                _mem_body, _n_stripped = _strip_memory_frontmatter(_resp_text)
                if _n_stripped > 0:
                    _note = f"[token-goat] memory file: {_n_stripped} frontmatter lines stripped\n"
                    return continue_with_message(_note + _mem_body)
            # Structural code compression: for large source files replace verbatim content with a skeleton that keeps only signatures and imports.
            import os as _os_cc
            _cc_disabled = _strip_lower(_os_cc.environ.get(_ENV_BASH_COMPRESS, "")) in _FALSY_ENV
            if not _cc_disabled and _resp_text:
                _cc_ext = Path(file_path).suffix.lower()
                _cc_line_count = _resp_text.count("\n") + 1
                try:
                    from . import config as _cc_cfg_mod
                    _cc_raw_min = _cc_cfg_mod.load().post_read_code_compress.min_lines
                    _cc_min: int = _cc_raw_min if is_real_int(_cc_raw_min) else 200
                except Exception:
                    _cc_min = 200
                if _cc_line_count >= _cc_min:
                    try:
                        from .code_compress import (
                            compress_to_skeleton as _compress_skel,
                        )
                        _skeleton = _compress_skel(_resp_text, _cc_ext)
                        if _skeleton is not None:
                            _sk_lines = _skeleton.count("\n") + 1
                            _cc_footer = (
                                f"\n[token-goat: structural view — {_cc_line_count} lines → {_sk_lines} skeleton lines;"
                                f' use `token-goat read "{file_path}::SymbolName"` for full body]'
                            )
                            return continue_with_message(_skeleton + _cc_footer)
                    except Exception:
                        pass
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        raw_result_count = payload.get("result_count")
        # Validate result_count: it arrives as raw Any from the harness payload.
        # Accept only plain ints (not bool subclass); clamp to [0, _MAX_RESULT_COUNT]
        # so a crafted payload cannot store an absurd integer in the session JSON.
        result_count: int | None = None
        if is_real_int(raw_result_count):
            result_count = max(0, min(raw_result_count, session._MAX_RESULT_COUNT))
        if pattern:
            session.mark_grep(session_id, pattern, path, result_count, cache=cache)
            _LOG.debug(
                "post-read: recorded Grep pattern=%s path=%s result_count=%s",
                sanitize_opt(pattern), sanitize_opt(path), result_count,
            )
            # Fetch the grep output once; used by both the hash recorder and the result cache.
            _grep_raw = payload.get("tool_response")
            _grep_text = _coerce_text(_grep_raw)
            # Grep result content dedup: hash the actual grep result content.
            # This detects when two different patterns return the same results.
            try:
                if _grep_text:
                    normalized = _grep_text.strip()
                    if normalized:
                        from .hints import _sha256_hex
                        result_hash = _sha256_hex(normalized, 8)
                        if cache is not None:
                            cache.record_grep_result_hash(result_hash, pattern)
                            _LOG.debug(
                                "post-read: recorded grep result hash=%s for pattern=%s",
                                result_hash, sanitize_opt(pattern),
                            )
            except Exception:
                _LOG.debug("post-read: grep result hash computation failed", exc_info=True)
            # Cache the result text for dedup serving on the next identical Grep call.
            with contextlib.suppress(Exception):
                if _grep_text and len(_grep_text) <= _GREP_RESULT_CACHE_MAX_BYTES:
                    from . import bash_cache as _bc2
                    from . import config as _cfg_mod2
                    _glob_filter = tool_input.get("glob") if isinstance(tool_input.get("glob"), str) else None
                    _type_filter = tool_input.get("type") if isinstance(tool_input.get("type"), str) else None
                    _output_mode = tool_input.get("output_mode") if isinstance(tool_input.get("output_mode"), str) else None
                    _bc2_cfg = _cfg_mod2.load().bash_compress
                    _bc2.store_grep_result(
                        session_id, pattern, path, _glob_filter, _type_filter, _output_mode, _grep_text,
                        max_total_bytes=_bc2_cfg.cache_max_bytes,
                        max_file_count=_bc2_cfg.cache_max_file_count,
                    )
    elif tool_name == "Glob":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        if pattern:
            # Derive result_count from the tool response: the Glob output is a
            # newline-separated list of matching file paths.  Count non-empty lines.
            raw_output = payload.get("tool_response")
            output_text = _coerce_text(raw_output)
            glob_result_count: int | None = None
            if output_text:
                glob_result_count = sum(1 for ln in output_text.splitlines() if ln.strip())
            session.mark_glob_run(session_id, pattern, path, glob_result_count, cache=cache)
            # Item 19: persist glob result to bash_cache for dedup serving.
            if output_text:
                try:
                    from . import bash_cache as _bc
                    from . import config as _cfg_mod
                    _bc_cfg = _cfg_mod.load().bash_compress
                    _bc.store_glob_result(
                        session_id, pattern, path, output_text,
                        max_total_bytes=_bc_cfg.cache_max_bytes,
                        max_file_count=_bc_cfg.cache_max_file_count,
                    )
                except Exception:
                    pass
            _LOG.debug(
                "post-read: recorded Glob pattern=%s path=%s result_count=%s",
                sanitize_opt(pattern), sanitize_opt(path), glob_result_count,
            )

    return CONTINUE()


# ---------------------------------------------------------------------------
# post_bash — record Bash output to the on-disk cache + session history
# ---------------------------------------------------------------------------


# Bash outputs smaller than this are not worth caching to disk: the dedup hint
# would suppress on size anyway, and the disk + JSON churn outweighs the
# savings.  Aligned with the dedup minimum so we never cache something we
# would later refuse to surface.
_BASH_CACHE_MIN_BYTES: int = 400
# Minimum stdout size (bytes) before repeated-command output dedup fires.
# Small outputs (echo, pwd, …) are cheap and pass through unchanged.
_CMD_DEDUP_MIN_BYTES: int = 100  # catches git status, docker ps, npm test (all < 500 bytes)
# Maximum number of display_cmd → stdout_hash entries kept per session.
# FIFO-evicted when exceeded to bound session JSON size.
_CMD_DEDUP_MAX_CMDS: int = 50
#: Bash outputs at or below this byte count are injected inline as additionalContext rather than
#: emitting an advisory hint.  Keeps the serve payload comfortably under one LLM context chunk.
_BASH_DIRECT_SERVE_MAX_BYTES: int = 8_192

#: Regex to detect pytest / py.test / python -m pytest commands.
_PYTEST_CMD_RE: _re.Pattern[str] = _re.compile(r"\bpy(?:test|\.test)\b|python\s+-m\s+pytest")
#: Captures the full rest-of-line after FAILED/ERROR on a pytest summary line.
#: A second pass strips the " - ExceptionClass..." suffix so parametrized node
#: IDs containing spaces (e.g. test_foo[hello world]) are captured correctly.
_PYTEST_FAILURE_FULL_RE: _re.Pattern[str] = _re.compile(r"^(?:FAILED|ERROR)\s+(.+)$", _re.MULTILINE)
#: Matches the " - ExceptionType: message" suffix after a pytest node ID.
#: Requires the type name to be word-chars only (no spaces) so it does not
#: incorrectly strip mid-parameter content like "[a - B class]".
_PYTEST_FAILURE_SUFFIX_RE: _re.Pattern[str] = _re.compile(r"\s+-\s+[A-Za-z][\w.]*(?::\s.*)?$")
#: Minimum stdout size (bytes) before pytest traceback suppression fires (Iter 18).
_PYTEST_COMPRESS_MIN_BYTES: int = 2000
#: Matches individual-test separator lines inside the pytest FAILURES section.
#: e.g. "______________ test_my_function[param] ______________"
_PYTEST_TB_SEP_RE: _re.Pattern[str] = _re.compile(r"^_{4,}\s+\S.*\s+_{4,}\s*$")
#: Minimum line count before verbose pytest PASSED-line suppression fires.
_VERBOSE_TEST_MIN_LINES: int = 80
#: Minimum line count before cargo compilation output compression fires.
_CARGO_COMPILE_MIN_LINES: int = 40
#: Minimum line count before make/cmake/ninja output compression fires.
_MAKE_MIN_LINES: int = 40
#: Minimum line count before go test -v output compression fires.
_GO_TEST_V_MIN_LINES: int = 60
#: Minimum line count before tsc output compression fires.
_TSC_MIN_LINES: int = 50
#: Matches position-less tsc --build errors/warnings (no ``(row,col)`` token).
_TSC_BARE_DIAG_RE: _re.Pattern[str] = _re.compile(r"^(error|warning) TS\d+:")
#: Matches the base command name of directory-exploration invocations (ls, eza, tree, fd).
_RECON_CMD_RE: _re.Pattern[str] = _re.compile(r"^(?:ls|ll|la|eza|exa|tree|fd|fdfind)\b")

# Hard cap on raw output size before any processing.  Outputs larger than this
# are truncated to the *last* N bytes (tail bias keeps errors/summaries) before
# passing to the rest of the post_bash pipeline.  Prevents OOM on runaway
# commands like ``find / -name "*.log"`` returning 50 000 lines.
# Override via TOKEN_GOAT_BASH_MAX_PROCESS_BYTES (integer, bytes).
_BASH_DEFAULT_MAX_PROCESS_BYTES: int = 10 * 1024 * 1024  # 10 MB

# Threshold used to classify output as "mostly binary": if the fraction of
# null bytes or bytes outside the printable-UTF-8 range exceeds this fraction
# of the total bytes, we skip compression and note the binary detection.
_BINARY_DETECTION_SAMPLE_BYTES: int = 4096  # inspect only the first 4 KiB
_BINARY_NULL_THRESHOLD: float = 0.01  # 1 % null bytes → binary

# Maximum number of path lines replayed inline when serving a cached Glob result.
# Capping prevents injecting large path lists (e.g. 200+ matches) into context.
# Excess entries are summarised as "(+N more)".
_GLOB_RESULT_CACHE_MAX_PATHS: int = 20
_GIT_DIFF_MIN_BYTES: int = 400  # minimum stdout size to engage delta caching
_GIT_DIFF_SMALL_DELTA: int = 20  # delta lines < this → pass through full diff
_GIT_DIFF_DELTA_PREVIEW_LINES: int = 30  # max lines shown in large-delta summary
_STDERR_DELTA_MIN_BYTES: int = 300  # minimum stderr size to engage stderr delta
_STDERR_DELTA_SMALL: int = 8  # total delta lines < this → pass through full stderr
_STDERR_DELTA_MAX_PREVIEW: int = 40  # max new error lines shown in delta summary
# Sleep / watch / poll-loop output suppression (Iter 16)
# Non-empty stdout from a sleep command: suppress with a one-liner instead of passing through.
# Empty stdout from sleep is suppressed silently (no systemMessage).
# watch and poll-loop commands (while/until + sleep) always suppress with a one-liner.
_SLEEP_SUPPRESS_NONEMPTY: bool = True  # sentinel — feature is always on; kept for grep-ability
# Large JSON/XML output summarization (Iter 17)
# JSON dicts/lists at or above this size are summarized structurally instead of passed raw.
# XML blobs at or above this size are suppressed with a one-liner recall hint.
_JSON_SUMMARY_MIN_BYTES: int = 4000
_JSON_SUMMARY_MAX_BYTES: int = 2_000_000  # skip json.loads on files > 2 MB to avoid memory pressure
# Large plain-text stdout fallback compressor (Iter 19)
# Fires after all specialized handlers when a successful command emits many lines of plain text.
_LARGE_STDOUT_LINE_THRESHOLD: int = 200
# Git log output compressor (Iter 21)
# git log with many commits can emit thousands of lines; compress when >= this many.
_GIT_LOG_COMPRESS_MIN_LINES: int = 50
# Package manager install output compressor
# pip/cargo/npm/yarn/uv install with many progress lines; compress when >= this many.
_PKG_INSTALL_MIN_LINES: int = 30
# Environment variable listing compressor
# env/printenv/export -p/declare -x dumps; compress when >= this many lines.
_ENV_LIST_MIN_LINES: int = 10
# Container log compressor
# docker/kubectl/podman logs can emit thousands of lines; compress when >= this many.
_CONTAINER_LOG_MIN_LINES: int = 50
#: Minimum stderr line count before Python script traceback compression fires (Iter 31).
_PYTHON_TB_MIN_STDERR_LINES: int = 25

# Lazy-load cache for the session module.  All function bodies that previously
# did ``from . import session`` (or ``as _session``/``as _sess``) now call
# ``_get_session()`` instead — the import cost is paid only once per process.
_session_module = None  # cached on first access for lazy-load


def _get_session() -> types.ModuleType:
    global _session_module
    if _session_module is None:
        from . import session as _s
        _session_module = _s
    return _session_module  # type: ignore[return-value]  # _session_module starts as None but is set above before returning


def _coerce_text(value: object) -> str:
    """Best-effort string coercion for a payload field of unknown shape.

    Handles the three shapes a Bash PostToolUse payload can legitimately carry
    for an output field:

    * **str** — already textual; returned as-is.
    * **list** — an MCP-style ``content`` array of ``{"type": "text",
      "text": "..."}`` items.  We concatenate the ``text`` of every text-typed
      item; non-text items are skipped (binary results would need different
      handling and have no place in a stdout-replacement cache).
    * **anything else** — coerced via ``str()``.  This catches int/float exit
      lines from a misshapen harness ("0\\n" sent as the int 0) and lets the
      cache still record an approximate body rather than dropping the event.

    Returns ``""`` for ``None`` and empty containers so the calling threshold
    check is a single numeric comparison.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                # MCP CallToolResult shape: {"type": "text", "text": "..."}
                # Older harnesses omit the type key entirely; accept those.
                # Explicitly non-text types (image, resource, …) are skipped.
                if item.get("type") in ("text", None):
                    txt = item.get("text")  # type: ignore[assignment]
                    if isinstance(txt, str):
                        parts.append(txt)
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return str(value)


def _unwrap_compress_command(cmd: str) -> str:
    """Return the original command if *cmd* is a ``token-goat compress`` wrapper.

    The pre-Bash hook rewrites filter-eligible commands (``pytest``, ``npm``,
    ``cargo``, …) to ``pythonw -m token_goat.cli compress --filter <name>
    --timeout <n> --cmd '<orig>'`` so the wrapper can capture and compress
    output before it lands in context.  When the PostToolUse hook then
    persists the executed command into the session cache, recording the
    wrapper verbatim is wasteful: the wrapper boilerplate is ~150–200 bytes
    of repeated, agent-irrelevant noise per entry.  This helper extracts the
    ``--cmd`` payload via :mod:`shlex` parsing so downstream consumers
    (recovery hint, compaction manifest, ``token-goat stats``) can display
    the user-facing command instead.

    Returns *cmd* unchanged when:

    * The string does not parse as a shell command (``shlex`` raises).
    * The argv does not include a recognisable token-goat invocation.
    * The ``compress`` subcommand or ``--cmd`` flag is missing.

    Any failure path is silent: this is a presentation-layer cleanup, never
    a correctness gate.
    """
    if "compress" not in cmd or "--cmd" not in cmd:
        # Cheap rejection: avoid shlex.split on the (overwhelming) common case
        # where the command is not a wrapper at all.
        return cmd
    import shlex

    try:
        argv = shlex.split(cmd, posix=True)
    except ValueError:
        return cmd
    # Locate the ``compress`` subcommand following a token_goat.cli or
    # token-goat invocation.  The interpreter / module prefix varies across
    # platforms (pythonw on Windows, python on POSIX, direct ``token-goat``
    # entrypoint when installed), so we scan for the marker tokens rather
    # than asserting a specific argv shape.
    is_wrapper = False
    for i, token in enumerate(argv):
        if token in ("token-goat", "token_goat.cli") or token.endswith("token_goat.cli"):
            # Look ahead for the ``compress`` subcommand.
            for j in range(i + 1, min(i + 4, len(argv))):
                if argv[j] == "compress":
                    is_wrapper = True
                    break
            if is_wrapper:
                break
    if not is_wrapper:
        return cmd
    # Extract the value following ``--cmd``.  Both ``--cmd foo`` (separate)
    # and ``--cmd=foo`` (joined) forms are accepted because either is valid
    # Typer input.
    for k, token in enumerate(argv):
        if token == "--cmd" and k + 1 < len(argv):
            return argv[k + 1]
        if token.startswith("--cmd="):
            return token[len("--cmd="):]
    return cmd


def _extract_bash_response(payload: HookPayload) -> tuple[str, str, int | None]:
    """Pull (stdout, stderr, exit_code) from a PostToolUse Bash payload.

    Defensive against payload shape drift across harness versions and tool
    flavours.  Three concrete shapes are accepted at the top level:

    1. ``payload["tool_response"]`` is a **dict** with named subfields
       (``stdout`` / ``stderr`` / ``exit_code`` and their snake_case + alt
       spellings).  This is the documented Claude Code shape.
    2. ``payload["tool_response"]`` is a **str** carrying the raw output as
       one blob — used by older harness builds and some MCP relays.
    3. ``payload["tool_response"]`` is an **MCP CallToolResult dict** with a
       ``content`` array of ``{"type": "text", "text": "..."}`` items —
       common when Bash is exposed through an MCP server adapter.

    The function also probes ``tool_result``, ``response``, ``output``, and
    the top-level payload itself for stdout (in that order) so a harness
    version that promotes the result to the top-level still works.  stdout
    extraction is delegated to :func:`hooks_common.extract_tool_response_text`;
    stderr and exit_code are Bash-specific and extracted here directly.
    """
    # stdout: use the common extractor (handles str / list / dict shapes).
    # Bash payloads use "stdout" as the primary key, then fall back to the
    # generic "output"/"text"/"content" keys used by other tools.
    stdout = extract_tool_response_text(
        payload,
        text_keys=("stdout", "output", "text", "content"),
    )

    # stderr and exit_code are Bash-specific — extract them from the raw dict.
    raw_resp: object = (
        payload.get("tool_response")
        if isinstance(payload, dict) else None
    )
    if raw_resp is None and isinstance(payload, dict):
        raw_resp = payload.get("tool_result") or payload.get("response")

    stderr = ""
    exit_val: object = None

    if isinstance(raw_resp, dict):
        stderr_raw = raw_resp.get("stderr") or raw_resp.get("err")
        stderr = _coerce_text(stderr_raw)
        exit_val = (
            raw_resp.get("exit_code")
            if "exit_code" in raw_resp
            else raw_resp.get("returncode")
            if "returncode" in raw_resp
            else raw_resp.get("exit")
        )

    # Top-level fallbacks for flattened harness shapes.
    if not stdout and isinstance(payload, dict):
        stdout = _coerce_text(payload.get("stdout") or payload.get("output"))
    if not stderr and isinstance(payload, dict):
        stderr = _coerce_text(payload.get("stderr"))
    if exit_val is None and isinstance(payload, dict):
        # HookPayload is a TypedDict that does not declare these keys (they
        # are harness-version-specific extras), but the runtime payload may
        # carry them; ``dict.get`` on a TypedDict instance is type-erased so
        # we route through a ``cast`` to keep mypy strict elsewhere.
        from typing import cast as _cast

        plain: dict[str, object] = _cast("dict[str, object]", payload)
        if "exit_code" in plain:
            exit_val = plain["exit_code"]
        elif "returncode" in plain:
            exit_val = plain["returncode"]

    exit_code: int | None = None
    if is_real_int(exit_val):
        exit_code = exit_val
    elif isinstance(exit_val, str):
        # Some harnesses send the exit code as a string ("0", "1").  Accept
        # numerics within int range; reject anything else silently rather
        # than crash on int("oops").
        try:
            exit_code = int(exit_val)
        except (TypeError, ValueError):
            exit_code = None

    return stdout, stderr, exit_code


def _bash_max_process_bytes() -> int:
    """Return the hard cap on raw Bash output size before processing.

    Reads TOKEN_GOAT_BASH_MAX_PROCESS_BYTES from the environment; falls back to
    ``_BASH_DEFAULT_MAX_PROCESS_BYTES`` on parse failure or when the variable is
    unset.  Clamped to at least 1 KiB so a misconfigured zero does not truncate
    all output.
    """
    return _env_int("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", _BASH_DEFAULT_MAX_PROCESS_BYTES, lo=1024)


def _apply_output_size_cap(stdout: str, stderr: str) -> tuple[str, str, bool]:
    """Truncate combined output to the configured byte cap.

    Returns ``(stdout, stderr, truncated)`` where *truncated* is ``True`` when
    any trimming occurred.  When the combined size exceeds the cap we keep the
    *last* N bytes of stdout (tail bias: errors and summaries usually appear at
    the end) and pass stderr through unchanged up to the remaining budget, so
    that error context is preserved.

    The truncation note is appended to stdout so it is visible in the cached
    output and in any hint that surfaces the text.
    """
    cap = _bash_max_process_bytes()
    stdout_b = stdout.encode("utf-8", errors="replace")
    stderr_b = stderr.encode("utf-8", errors="replace")
    total = len(stdout_b) + len(stderr_b)
    if total <= cap:
        return stdout, stderr, False

    # Reserve a slice for stderr (up to 20 % of cap or 100 KB, whichever is smaller).
    stderr_budget = min(cap // 5, 100 * 1024)
    stdout_budget = cap - min(len(stderr_b), stderr_budget)

    original_total = total
    truncated_stdout = stdout
    if len(stdout_b) > stdout_budget and stdout_budget > 0:
        # Keep the *tail* of stdout so error summaries survive.
        tail = stdout_b[-stdout_budget:]
        # Walk forward to the next newline boundary to avoid mid-line cuts.
        nl = tail.find(b"\n")
        if 0 < nl < 256:
            tail = tail[nl + 1:]
        truncated_stdout = (
            f"[token-goat: stdout truncated to last {len(tail):,} bytes"
            f" of {len(stdout_b):,} bytes total"
            f" (TOKEN_GOAT_BASH_MAX_PROCESS_BYTES={cap:,})]\n"
            + tail.decode("utf-8", errors="replace")
        )
    _LOG.info(
        "post-bash: output size cap applied: %d → %d bytes (cap=%d)",
        original_total, len(truncated_stdout.encode("utf-8", errors="replace")) + len(stderr_b),
        cap,
    )
    return truncated_stdout, stderr, True


def _is_binary_output(stdout: str, stderr: str) -> bool:
    """Return True when the output looks like binary data.

    Samples the first ``_BINARY_DETECTION_SAMPLE_BYTES`` bytes of the combined
    output.  If the null-byte fraction exceeds ``_BINARY_NULL_THRESHOLD`` we
    classify the output as binary and skip compression.  This handles commands
    like ``xxd``, ``od``, ``strings``, and accidental reads of binary files via
    shell redirects that leak raw bytes into the captured output.

    Operates on encoded bytes derived from the already-decoded Python strings so
    this works even after surrogate sanitisation.
    """
    sample_src = (stdout + stderr)[:_BINARY_DETECTION_SAMPLE_BYTES * 4]
    sample_bytes = sample_src.encode("utf-8", errors="replace")[:_BINARY_DETECTION_SAMPLE_BYTES]
    if not sample_bytes:
        return False
    null_count = sample_bytes.count(b"\x00")
    return (null_count / len(sample_bytes)) > _BINARY_NULL_THRESHOLD


def _is_recon_command(cmd: str) -> bool:
    """True when *cmd* is a directory-listing/exploration command (ls, eza, tree, fd)."""
    import shlex as _shlex
    try:
        tokens = _shlex.split(cmd.strip(), posix=True)
    except ValueError:
        tokens = cmd.strip().split()
    first = tokens[0] if tokens else ""
    base = first.replace("\\", "/").rsplit("/", 1)[-1].strip('"\'')
    return bool(_RECON_CMD_RE.match(base))


def _is_pytest_command(cmd: str) -> bool:
    return bool(_PYTEST_CMD_RE.search(cmd))


def _compress_pytest_failures(stdout: str, output_id: str | None) -> str:
    """Suppress traceback bodies in the pytest FAILURES section.

    Finds each ``___ test_name ___`` separator block in the FAILURES section
    and replaces it (separator + body lines) with a one-liner stub.  The
    short test summary section and final ``=== N passed, M failed ===`` line
    are preserved unchanged because they live outside the FAILURES section.

    Returns *stdout* unchanged (the same object, ``is`` identity) when:
    - ``"FAILED"`` is not present in the text, or
    - no traceback-separator lines were found within the FAILURES section.
    """
    if "FAILED" not in stdout:
        return stdout

    # Section-header pattern: lines that start with one or more ``=`` signs.
    # Covers both "=== FAILURES ===" and the final "= N failed in Xs =" line.
    _sect_re = _re.compile(r"^=+\s")

    lines = stdout.splitlines(keepends=True)
    out: list[str] = []
    in_failures_section = False
    in_tb_block = False
    current_tb_name = ""
    failure_count = 0
    recall = f" (bash-output {output_id} for full output)" if output_id else ""

    for line in lines:
        stripped = line.rstrip("\r\n")

        # Section header — re-evaluate which section we're in.
        if _sect_re.match(stripped):
            in_failures_section = "FAILURES" in stripped
            in_tb_block = False
            out.append(line)
            continue

        if in_failures_section:
            # Individual-test separator: "_____ test_name _____"
            if _PYTEST_TB_SEP_RE.match(stripped):
                failure_count += 1
                in_tb_block = True
                current_tb_name = stripped.strip("_").strip()
                out.append(
                    f"[token-goat] traceback omitted — re-run with:"
                    f" pytest {current_tb_name} -x for details{recall}\n"
                )
                continue

            if in_tb_block:
                # Body lines of the current traceback block — suppress.
                continue

        out.append(line)

    if failure_count == 0:
        return stdout

    header = (
        f"[token-goat] pytest: {failure_count}"
        f" failure{'s' if failure_count != 1 else ''}"
        f" detected — tracebacks suppressed{recall}:\n"
    )
    return header + "".join(out)


def _is_log_file_path(norm_path: str) -> bool:
    """Return True when *norm_path* looks like a log file.

    Matches:
    - Files whose basename ends in .log or .out
    - Files whose path contains /log/ or /logs/ as a directory segment

    *norm_path* must already be forward-slash normalized (as produced by
    ``str(path.resolve()).replace("\\\\", "/")``) so segment checks are reliable.
    """
    lower = norm_path.lower()
    if lower.endswith((".log", ".out")):
        return True
    return "/log/" in lower or "/logs/" in lower or lower.endswith(("/log", "/logs"))


_GIT_NOISE_FLAGS: frozenset[str] = frozenset({
    "--color", "--no-color", "--color=never", "--color=always", "--color=auto",
})

_GIT_STAT_FLAGS: frozenset[str] = frozenset({"--stat", "--shortstat", "--numstat"})


def _is_git_diff_target(argv: list[str]) -> bool:
    """Return True when argv is a `git diff` command eligible for delta caching.

    Excludes ``--stat`` / ``--shortstat`` / ``--numstat`` variants because those
    are handled by :class:`~bash_compress.GitDiffFilter` in a separate path.
    Accepts bare ``git``, full-path variants (``/usr/bin/git``), and
    ``git.exe`` on Windows.
    """
    if not argv or len(argv) < 2:
        return False
    # Extract basename, normalise slashes, strip .exe suffix.
    cmd_base = argv[0].lower().replace("\\", "/").rsplit("/", 1)[-1]
    cmd_base = cmd_base.removesuffix(".exe")
    if cmd_base != "git":
        return False
    if argv[1] != "diff":
        return False
    return not any(a in _GIT_STAT_FLAGS for a in argv[2:])


def _normalize_git_diff_args(argv: list[str]) -> str:
    """Return a canonical string of git diff args with noise flags stripped.

    Drops colour-control flags (``--color``, ``--no-color``, etc.) so that
    ``git diff HEAD`` and ``git diff --no-color HEAD`` resolve to the same
    cache key.  Pass the full argv (``git`` at [0], ``diff`` at [1]); the
    function slices at [2:] internally.
    """
    return " ".join(a for a in argv[2:] if a not in _GIT_NOISE_FLAGS)


def _get_head_sha(cwd: str | None) -> str | None:
    """Return the current HEAD commit SHA string, or ``None`` on failure.

    Runs ``git rev-parse HEAD`` in *cwd*.  Returns ``None`` when the directory
    is not a git repository, the repo has no commits yet, or the subprocess
    call fails for any reason.  Never raises.
    """
    import subprocess as _subp
    try:
        kwargs: dict[str, object] = {"capture_output": True, "text": True, "timeout": 5, "check": False}
        if cwd:
            kwargs["cwd"] = cwd
        result = _subp.run(["git", "rev-parse", "HEAD"], **kwargs)  # type: ignore[call-overload]
        if result.returncode == 0:
            sha = result.stdout.strip()
            if sha:
                return sha
    except Exception:
        pass
    return None


def _extract_pytest_failure_ids(output: str) -> list[str]:
    """Return sorted FAILED/ERROR test node IDs from a pytest stdout/stderr blob.

    Captures the full node ID including spaces (e.g. parametrized tests like
    test_foo[hello world]) by stripping the " - ExceptionClass..." suffix that
    pytest appends after the node ID on summary lines.
    """
    ids: set[str] = set()
    for m in _PYTEST_FAILURE_FULL_RE.finditer(output):
        node_id = _PYTEST_FAILURE_SUFFIX_RE.sub("", m.group(1)).rstrip()
        if node_id:
            ids.add(node_id)
    return sorted(ids)


def _json_structural_summary(data: object, max_depth: int = 2, max_keys: int = 12) -> str:
    """Return a compact structural description of a parsed JSON value.

    Only handles dict and list at the top level (callers must pre-check).
    Depth 0 = top-level summary line; depth 1 = one level of sub-key expansion.
    Output is kept under ~20 lines so it fits cleanly in a systemMessage.
    """
    lines: list[str] = []

    def _repr_value(v: object) -> str:
        if isinstance(v, dict):
            sub = list(v.keys())
            shown = ", ".join(sub[:8])
            suffix = f", +{len(sub) - 8} more" if len(sub) > 8 else ""
            return "{" + shown + suffix + "}"
        if isinstance(v, list):
            return f"[list, {len(v)} items]"
        return type(v).__name__

    if isinstance(data, dict):
        keys = list(data.keys())
        shown_keys = keys[:max_keys]
        truncated = len(keys) - max_keys
        key_line = ", ".join(str(k) for k in shown_keys)
        if truncated > 0:
            key_line += f", ... (+{truncated} more)"
        lines.append("Type: object (dict)")
        lines.append(f"Keys ({len(keys)}): {key_line}")
        # One level of sub-key expansion for values that are dicts or lists
        expanded = 0
        for k in shown_keys:
            v = data[k]
            if isinstance(v, (dict, list)) and expanded < (max_depth * 6):
                lines.append(f"└── {k}: {_repr_value(v)}")
                expanded += 1
    elif isinstance(data, list):
        lines.append("Type: array (list)")
        lines.append(f"Length: {len(data)} items")
        if data:
            first = data[0]
            if isinstance(first, dict):
                sub_keys = list(first.keys())
                shown = sub_keys[:max_keys]
                trunc = len(sub_keys) - max_keys
                key_line = ", ".join(str(k) for k in shown)
                if trunc > 0:
                    key_line += f", ... (+{trunc} more)"
                lines.append(f"First item type: object — Keys ({len(sub_keys)}): {key_line}")
                for k in shown[:6]:
                    v = first[k]
                    if isinstance(v, (dict, list)):
                        lines.append(f"  └── {k}: {_repr_value(v)}")
            elif isinstance(first, list):
                lines.append(f"First item type: array — {len(first)} items")
            else:
                lines.append(f"First item type: {type(first).__name__}")

    return "\n".join(lines)


def _bash_recall(out_id: str | None) -> str:
    """Return a '[Full output: bash-output <id>]' recall hint, or '' when *out_id* is None."""
    return f"\n[Full output: bash-output {out_id}]" if out_id else ""


def _safe_int(v: object, default: int = 0) -> int:
    """Return ``int(v)`` or *default* when *v* is empty, None, or non-numeric."""
    try:
        return int(v)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return default


def _summarize_junit_xml(stdout: str) -> str | None:
    """Parse JUnit XML *stdout* and return a token-goat summary string, or ``None`` on parse error.

    Handles both ``<testsuite>`` as root element and ``<testsuites>`` wrapper containing
    multiple ``<testsuite>`` children.  Aggregates counts across all suites and lists up
    to 10 failure/error test cases with their messages (truncated at 160 chars).
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(stdout.strip())
    except ET.ParseError:
        return None

    # Normalise to a flat list of <testsuite> elements — direct children only.
    # Using root.iter("testsuite") would recurse into nested <testsuite> children and
    # double-count totals (outer suite tests="5" + inner suites tests="2"+"3" = 10).
    if root.tag == "testsuites":
        suites = [el for el in root if el.tag == "testsuite"]
    elif root.tag == "testsuite":
        suites = [root]
    else:
        return None

    total = errors = failures = skipped = 0
    failed_cases: list[tuple[str, str]] = []  # (name, message)

    for suite in suites:
        total += _safe_int(suite.get("tests", 0))
        errors += _safe_int(suite.get("errors", 0))
        failures += _safe_int(suite.get("failures", 0))
        skipped += _safe_int(suite.get("skipped", 0))

        for tc in suite.iter("testcase"):
            fail = tc.find("failure")
            err = tc.find("error")
            node = fail if fail is not None else err
            if node is not None:
                classname = tc.get("classname", "")
                testname = tc.get("name", "")
                name = f"{classname}.{testname}".strip(".")
                msg = (node.get("message") or node.text or "")[:200]
                failed_cases.append((name, msg))

    passed = total - errors - failures - skipped
    status = "PASS" if (errors + failures) == 0 else "FAIL"

    lines = [
        f"[token-goat] JUnit XML [{status}]: {passed} passed, {failures} failed,"
        f" {errors} errors, {skipped} skipped ({total} total)"
    ]

    if failed_cases:
        lines.append("Failures:")
        for name, msg in failed_cases[:10]:
            lines.append(f"  {name}")
            if msg.strip():
                lines.append(f"    {msg.strip()[:160]}")
        if len(failed_cases) > 10:
            lines.append(f"  ... {len(failed_cases) - 10} more failures (use bash-output to see all)")

    return "\n".join(lines)


def post_bash(payload: HookPayload) -> HookResponse:
    """Post-Bash hook: persist large outputs to disk and record in session history.

    For every PostToolUse(Bash) invocation we:

    1. Extract stdout/stderr/exit_code from ``tool_response``.
    2. Check whether this command matches a recently-emitted bash-dedup hint;
       if so, increment ``hints_ignored`` so the curator can adapt.
    3. If the command is a grep-family invocation, record the pattern and path
       in session.greps so that subsequent Grep dedup hints can fire.
    4. If the command is a read-equivalent invocation (``cat``, ``Get-Content``,
       ``bat``, ``head``, ``tail``, etc.) and the command succeeded, record the
       file path in session.files via :func:`~session.mark_file_read` so that
       the "already read" session hint fires identically to a native Read call.
    5. If the combined output is large enough to be worth caching
       (``_BASH_CACHE_MIN_BYTES``), write it to the on-disk bash cache and
       record a :class:`BashEntry` in the session so a future ``pre_read`` can
       dedupe a repeat invocation.
    6. Always return CONTINUE — this hook never blocks, never modifies output.

    Failures at any step are logged at debug and the hook still returns
    CONTINUE so a transient I/O issue cannot interrupt the agent.
    """
    session_id, cwd = get_session_context(payload)
    tool_input = get_tool_input(payload)
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return CONTINUE()

    # When the pre-Bash hook wrapped this command for output compression, the
    # tool_input still carries the verbose wrapper invocation.  Persist the
    # original user-facing command (via shlex-unwrap) so the session cache,
    # recovery hints, compaction manifest, and ``token-goat stats`` show the
    # agent's intent ("pytest -v"), not ~200 bytes of wrapper boilerplate.
    # Falls through to *command* unchanged when the input was never wrapped.
    display_cmd = _unwrap_compress_command(command)

    # Curator ignored-hint tracking: if a bash-dedup hint was recently emitted
    # for this command and the agent ran it anyway, record the ignored hint so
    # the curator can suppress future bash-dedup hints when the ignore rate is
    # consistently high.  Must run before any early-return so even small-output
    # reruns are counted.  Uses display_cmd (unwrapped) to match the hash stored
    # by build_bash_dedup_hint, which also hashes the unwrapped command.
    # Extract response early so observed_tool_tokens is accurate before the first save.
    stdout, stderr, exit_code = _extract_bash_response(payload)
    # Sanitize at the boundary: Windows subprocess can produce surrogate-escape bytes (\udcXX) that crash utf-8 serialisation.
    stdout = _sanitize_surrogates(stdout)
    stderr = _sanitize_surrogates(stderr)
    # Hard size cap before any downstream work: tail-bias truncation keeps error summaries at the end.
    stdout, stderr, _was_truncated = _apply_output_size_cap(stdout, stderr)

    # Load the session cache once; all subsequent session operations share this object.
    _sess_mod = _get_session() if session_id else None
    _session_cache = _sess_mod.safe_load(session_id, caller="post_bash") if (_sess_mod and session_id) else None
    if _sess_mod is not None and _session_cache is not None:
        _session_cache.observed_tool_tokens += (len(stdout) + len(stderr)) // 4
        _check_ignored_bash_hint(_session_cache, display_cmd, cwd)
        with contextlib.suppress(Exception):
            _sess_mod.save(_session_cache)  # fallback save if no mark_* runs below

    # Directory-recon consolidation: track ls/eza/tree/fd invocations via
    # hints_seen[@recon_seen] and inject token-goat map --compact after the 3rd.
    # Runs before the output-size check so tiny ls outputs are still counted.
    # Only count successful recon commands (exit 0) to avoid injecting after a
    # failed path-exploration sequence.  @recon_map_fail gates retry-on-error
    # so a timed-out subprocess does not stall every subsequent recon call.
    _RECON_SEEN_KEY = "@recon_seen"
    _RECON_MAP_KEY = "@recon_map"
    _RECON_FAIL_KEY = "@recon_map_fail"
    if (
        _is_recon_command(display_cmd)
        and exit_code in (None, 0)
        and _sess_mod is not None
        and _session_cache is not None
    ):
        try:
            _session_cache.mark_hint_seen(_RECON_SEEN_KEY)
            _recon_n = _session_cache.hints_seen.get(_RECON_SEEN_KEY, 0)
            _already_injected = _session_cache.has_hint_fingerprint(_RECON_MAP_KEY)
            _prev_failed = _session_cache.has_hint_fingerprint(_RECON_FAIL_KEY)
            if _recon_n >= 3 and not _already_injected and not _prev_failed:
                import subprocess as _subp
                _run_kw: dict[str, object] = {"capture_output": True, "text": True, "timeout": 10, "check": False}
                if cwd:
                    _run_kw["cwd"] = cwd
                _map_r = _subp.run(["token-goat", "map", "--compact"], **_run_kw)  # type: ignore[call-overload]
                if _map_r.returncode == 0 and _map_r.stdout.strip():
                    _session_cache.mark_hint_seen(_RECON_MAP_KEY)
                    with contextlib.suppress(Exception):
                        _sess_mod.save(_session_cache)
                    return {
                        "continue": True,
                        "systemMessage": (
                            "[token-goat] Project map (injected after repeated directory reads):\n\n"
                            + _map_r.stdout.strip()
                        ),
                    }
                else:
                    _LOG.warning(
                        "post-bash: map --compact exited %d: %s", _map_r.returncode, _map_r.stderr[:200]
                    )
                    _session_cache.mark_hint_seen(_RECON_FAIL_KEY)
            elif _already_injected:
                # Bump count so @recon_map stays competitive against LRU eviction.
                _session_cache.mark_hint_seen(_RECON_MAP_KEY)
            with contextlib.suppress(Exception):
                _sess_mod.save(_session_cache)  # persist @recon_seen count and any gate updates
        except Exception:
            _session_cache.mark_hint_seen(_RECON_FAIL_KEY)  # prevent retry on timeout
            with contextlib.suppress(Exception):
                _sess_mod.save(_session_cache)
            _LOG.debug("post-bash: recon map inject failed", exc_info=True)

    # Grep-pattern session recording: when the Bash command is a grep-family
    # invocation (rg, grep, ag, ack, …), record the pattern and path in
    # session.greps so that subsequent pre-Grep and pre-Bash grep dedup hints
    # can fire.  Uses stdout line count as a cheap result_count estimate since
    # the harness only delivers raw text, not a structured match count.
    if _sess_mod is not None and _session_cache is not None:
        try:
            from . import bash_parser as _bp
            _grep_intent = _bp.parse(display_cmd)
            if _grep_intent.kind == "grep" and _grep_intent.pattern:
                _grep_result_count = sum(1 for _ln in stdout.splitlines() if _ln.strip()) if stdout else 0
                _sess_mod.mark_grep(
                    session_id,
                    _grep_intent.pattern,
                    _grep_intent.target_path,
                    _grep_result_count,
                    cache=_session_cache,
                )
                _LOG.debug(
                    "post-bash: recorded grep pattern=%r path=%r result_count=%d",
                    _grep_intent.pattern, _grep_intent.target_path, _grep_result_count,
                )
        except Exception:
            _LOG.debug("post-bash: grep session record failed", exc_info=True)

    # Read-equivalent session tracking: when the Bash command is a read-like
    # invocation (cat, Get-Content, bat, head, tail, …), record the file path
    # in session.files via mark_file_read so that subsequent pre-Read and
    # pre-Bash hint logic fires identically to a native Read tool call.
    # This closes the gap where ``Get-Content foo.py`` was intercepted by
    # pre_read for image-shrink/hint purposes but never persisted in the
    # session read-history, preventing the "already read" dedup hint from
    # firing on a repeat access.
    #
    # Skip when exit_code is non-zero: a failed Get-Content (file not found,
    # permission denied) should not be recorded as a successful read.
    if _sess_mod is not None and _session_cache is not None and exit_code in (None, 0):
        try:
            from . import bash_parser as _bp
            _read_intent = _bp.parse(display_cmd)
            if (
                _read_intent.kind == "read"
                and _read_intent.target_path
                and not _read_intent.is_interactive_pager
            ):
                # bash_parser returns 1-indexed offset; mark_file_read expects 0-indexed.
                _norm_offset = (_read_intent.offset - 1) if _read_intent.offset is not None else None
                # For multi-file reads (gc f1 f2 …) mark every path.
                _all_paths = _read_intent.target_paths or [_read_intent.target_path]
                for _path in _all_paths:
                    _sess_mod.mark_file_read(
                        session_id,
                        _path,
                        _norm_offset,
                        _read_intent.limit,
                        cache=_session_cache,
                    )
                _LOG.debug(
                    "post-bash: recorded read-equivalent paths=%r offset=%s limit=%s",
                    _all_paths, _norm_offset, _read_intent.limit,
                )
        except Exception:
            _LOG.debug("post-bash: read-equivalent session record failed", exc_info=True)

    # Cross-tool content dedup: when the Bash command is a whole-file `cat FILE`
    # with no transforming flags, and the stdout matches a prior Read of the same
    # file this session, suppress the duplicate and inject a dedup note.
    # Only matches plain `cat FILE` — head/tail/sed are skipped (offset/limit set).
    if _sess_mod is not None and _session_cache is not None and exit_code in (None, 0) and stdout:
        try:
            import shlex as _shlex

            from . import bash_parser as _bp
            _ct_intent = _bp.parse(display_cmd)
            if (
                _ct_intent.kind == "read"
                and _ct_intent.target_path is not None
                and _ct_intent.target_paths is None  # single file only
                and _ct_intent.offset is None
                and _ct_intent.limit is None
                and not _ct_intent.filtered
            ):
                # bash_parser uses posix=True shlex which strips Windows backslashes
                # (C:\foo → C:foo).  Re-split with posix=False to preserve them, then
                # skip the command name and any flags to find the first path token.
                try:
                    _argv_raw = _shlex.split(display_cmd.split("|")[0].strip(), posix=False)
                except ValueError:
                    _argv_raw = []
                while _argv_raw and _argv_raw[0].strip("\"'").lower() in {"sudo", "time", "nice", "exec"}:
                    _argv_raw.pop(0)
                _argv_raw = _argv_raw[1:]  # drop command name
                _raw_path_str = next((t.strip("\"'") for t in _argv_raw if not t.startswith("-")), None)
                if not _raw_path_str:
                    raise ValueError("no path token found in argv")
                _ct_path = Path(_raw_path_str)
                if not _ct_path.is_absolute() and cwd:
                    _ct_path = Path(cwd) / _raw_path_str
                _ct_norm = str(_ct_path.resolve()).replace("\\", "/")
                # Normalize CRLF → LF before hashing (mirrors post_read normalization).
                _ct_hash = hashlib.sha256(stdout.replace("\r\n", "\n").encode()).hexdigest()
                _prior_hash = _session_cache.get_read_hash(_ct_norm)
                if _prior_hash is not None and _prior_hash == _ct_hash:
                    _LOG.info(
                        "post-bash: cross-tool dedup suppressed cat output path=%s",
                        sanitize_log_str(_ct_norm),
                    )
                    with contextlib.suppress(Exception):
                        _sess_mod.save(_session_cache)
                    return {
                        "continue": True,
                        "systemMessage": (
                            f"[token-goat] Output identical to recent Read of '{_raw_path_str}'"
                            " — suppressed duplicate (use Read tool directly)"
                        ),
                    }
        except Exception:
            _LOG.debug("post-bash: cross-tool content dedup check failed", exc_info=True)

    # Log-file content cache: suppress repeated reads of unchanged log files.
    # Key: (normalized_path, size_bytes, mtime_float) stored in session.log_file_cache.
    # When the same log file is read with identical (size, mtime), the file has not
    # changed → the output is identical → suppress with an advisory note.
    # Only fires on single-file read-equivalent commands targeting log-like paths.
    #
    # Path extraction uses posix=False shlex (same technique as cross-tool dedup above)
    # to preserve Windows backslashes that posix=True shlex would strip (C:\foo → C:foo).
    if _sess_mod is not None and _session_cache is not None and exit_code in (None, 0) and stdout:
        try:
            import shlex as _shlex_lf

            from . import bash_parser as _bp

            _lf_intent = _bp.parse(display_cmd)
            if (
                _lf_intent.kind == "read"
                and _lf_intent.target_path is not None
                and _lf_intent.target_paths is None  # single-file only
            ):
                # Re-split with posix=False to get the unmangled path token.
                try:
                    _lf_argv_raw = _shlex_lf.split(display_cmd.split("|")[0].strip(), posix=False)
                except ValueError:
                    _lf_argv_raw = []
                while _lf_argv_raw and _lf_argv_raw[0].strip("\"'").lower() in {"sudo", "time", "nice", "exec"}:
                    _lf_argv_raw.pop(0)
                _lf_argv_raw = _lf_argv_raw[1:]  # drop command name
                _lf_raw = next((t.strip("\"'") for t in _lf_argv_raw if not t.startswith("-")), None)
                if _lf_raw:
                    _lf_p = Path(_lf_raw)
                    if not _lf_p.is_absolute() and cwd:
                        _lf_p = Path(cwd) / _lf_raw
                    try:
                        _lf_resolved = _lf_p.resolve()
                        _lf_norm = str(_lf_resolved).replace("\\", "/")
                    except (OSError, ValueError):
                        _lf_norm = ""
                    if _lf_norm and _is_log_file_path(_lf_norm):
                        try:
                            _lf_st = _lf_resolved.stat()
                            _lf_size = _lf_st.st_size
                            _lf_mtime = _lf_st.st_mtime
                        except OSError:
                            pass  # cannot stat → skip cache; no exception propagates
                        else:
                            # Use a 16-hex-char hash (64-bit collision resistance is more
                            # than sufficient for in-session dedup; keeps session JSON compact).
                            _lf_hash = hashlib.sha256(stdout.replace("\r\n", "\n").encode()).hexdigest()[:16]
                            _lf_cached = _session_cache.get_log_cache_hit(_lf_norm, _lf_size, _lf_mtime)
                            if _lf_cached is not None and _lf_cached == _lf_hash:
                                _LOG.info(
                                    "post-bash: log-file cache hit suppressed output path=%s",
                                    sanitize_log_str(_lf_norm),
                                )
                                with contextlib.suppress(Exception):
                                    _sess_mod.save(_session_cache)
                                return {
                                    "continue": True,
                                    "systemMessage": (
                                        f"[token-goat] Log file '{_lf_raw}' unchanged since last read"
                                        " — suppressed duplicate output"
                                        " (use `token-goat bash-output` to recall full content)"
                                    ),
                                }
                            # Cache miss or content changed: record for future suppression.
                            _session_cache.record_log_read(_lf_norm, _lf_size, _lf_mtime, _lf_hash)
                            with contextlib.suppress(Exception):
                                _sess_mod.save(_session_cache)
        except Exception:
            _LOG.debug("post-bash: log-file cache check failed", exc_info=True)

    # Sleep / watch / poll-loop suppression (Iter 16):
    # - Pure sleep with empty stdout  → silent CONTINUE (no noise in context)
    # - Pure sleep with non-empty stdout → one-liner + bash-output recall id
    # - watch COMMAND                  → one-liner + bash-output recall id
    # - Poll loop (while/until + sleep)→ one-liner with condensed iteration count
    # Only fires when exit_code is 0 or None (failures pass through unchanged).
    if exit_code in (None, 0):
        try:
            import shlex as _shlex_sp

            from . import bash_compress as _bc_sp
            try:
                _sp_argv = _shlex_sp.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _sp_argv = display_cmd.strip().split()
            _sp_argv_clean = [t.strip("\"'") for t in _sp_argv]

            # --- pure sleep -------------------------------------------------------
            if _bc_sp._sleep_cmd_type(_sp_argv_clean) is not None:
                if not stdout.strip():
                    _LOG.debug("post-bash: sleep cmd empty stdout suppressed cmd=%.60s", display_cmd)
                    return CONTINUE()
                # Non-empty stdout: store output so bash-output recall works, emit one-liner.
                _sp_out_id: str | None = None
                if session_id:
                    from . import bash_cache as _bc_sp_cache
                    with contextlib.suppress(Exception):
                        _sp_meta = _bc_sp_cache.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code, cwd=cwd, min_cache_bytes=0,
                        )
                        if _sp_meta is not None:
                            _bc_sp_cache.write_sidecar(_sp_meta)
                            _sp_out_id = _sp_meta.output_id
                _sp_recall = f" (use bash-output {_sp_out_id} to see)" if _sp_out_id else ""
                _LOG.info("post-bash: sleep cmd nonempty stdout suppressed cmd=%.60s", display_cmd)
                return {
                    "continue": True,
                    "systemMessage": f"[token-goat] {display_cmd} — output suppressed{_sp_recall}",
                }

            # --- watch ------------------------------------------------------------
            _sp_watch_cmd = _bc_sp._watch_cmd_info(_sp_argv_clean)
            if _sp_watch_cmd is not None:
                _sp_out_id = None
                if session_id:
                    from . import bash_cache as _bc_sp_cache
                    with contextlib.suppress(Exception):
                        _sp_meta = _bc_sp_cache.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code, cwd=cwd, min_cache_bytes=0,
                        )
                        if _sp_meta is not None:
                            _bc_sp_cache.write_sidecar(_sp_meta)
                            _sp_out_id = _sp_meta.output_id
                _sp_recall = f" (use bash-output {_sp_out_id} to see)" if _sp_out_id else ""
                _LOG.info("post-bash: watch cmd suppressed watched=%s", _sp_watch_cmd[:80])
                return {
                    "continue": True,
                    "systemMessage": (
                        f"[token-goat] watch: {_sp_watch_cmd} — output suppressed{_sp_recall}"
                    ),
                }

            # --- poll loop --------------------------------------------------------
            if _bc_sp._is_poll_loop_cmd(display_cmd):
                _sp_out_id = None
                if session_id:
                    from . import bash_cache as _bc_sp_cache
                    with contextlib.suppress(Exception):
                        _sp_meta = _bc_sp_cache.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code, cwd=cwd, min_cache_bytes=0,
                        )
                        if _sp_meta is not None:
                            _bc_sp_cache.write_sidecar(_sp_meta)
                            _sp_out_id = _sp_meta.output_id
                _sp_n_lines = len([ln for ln in stdout.splitlines() if ln.strip()])
                _sp_exit_info = f"exit code: {exit_code if exit_code is not None else 0}"
                _LOG.info("post-bash: poll loop suppressed lines=%d cmd=%.60s", _sp_n_lines, display_cmd)
                return {
                    "continue": True,
                    "systemMessage": (
                        f"[token-goat] poll loop detected — {_sp_n_lines} output lines condensed"
                        f" ({_sp_exit_info})"
                    ),
                }
        except Exception:
            _LOG.debug("post-bash: sleep/watch/poll suppress failed", exc_info=True)

    # Package manager install output compression:
    # pip/cargo/npm/yarn/uv install invocations emit hundreds of "Collecting ...",
    # "Compiling ...", "Downloading ..." progress lines per package on every run.
    # When output reaches _PKG_INSTALL_MIN_LINES, store the full output and return
    # a compact summary: total line count, error/warning lines, and the final
    # status line ("Successfully installed ...", "Finished ...", etc.).
    # Fires for exit_code in (None, 0, 1) — 1 covers partial-install failures.
    if exit_code in (None, 0, 1) and stdout and len(stdout.splitlines()) >= _PKG_INSTALL_MIN_LINES:
        try:
            import shlex as _shlex_pkg

            from . import bash_compress as _bc_pkg

            try:
                _pkg_argv = _shlex_pkg.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _pkg_argv = display_cmd.strip().split()
            _pkg_argv_clean = [t.strip("\"'") for t in _pkg_argv]

            if _bc_pkg._is_pkg_install_cmd(_pkg_argv_clean):
                _pkg_lines = stdout.splitlines()
                _pkg_n_lines = len(_pkg_lines)

                _PROGRESS_PREFIXES = (
                    "Collecting", "Compiling", "Downloading", "Installing",
                    "Fetching", "Updating", "Resolving",
                )
                _PROGRESS_BAR_CHARS = set("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏█▉▊▋▌▍▎▏|#")

                _pkg_error_lines: list[str] = []
                _pkg_progress_count = 0

                for _pl in _pkg_lines:
                    _pl_stripped = _pl.strip()
                    if not _pl_stripped:
                        continue
                    _pl_lower = _pl_stripped.lower()
                    if (
                        "error" in _pl_lower or "failed" in _pl_lower or "warning:" in _pl_lower or " err!" in _pl_lower or _pl_lower.startswith(("npm warn", "npm err"))
                    ):
                        _pkg_error_lines.append(_pl_stripped)
                    if _pl_stripped.startswith(_PROGRESS_PREFIXES) or (
                        bool(_pl_stripped) and _pl_stripped[0] in _PROGRESS_BAR_CHARS
                    ):
                        _pkg_progress_count += 1

                # Last non-empty line is usually the summary ("Successfully installed ...", etc.)
                _pkg_summary_line = ""
                for _pl in reversed(_pkg_lines):
                    if _pl.strip():
                        _pkg_summary_line = _pl.strip()
                        break

                _pkg_out_id: str | None = None
                if session_id:
                    from . import bash_cache as _bc_pkg_cache
                    with contextlib.suppress(Exception):
                        _pkg_meta = _bc_pkg_cache.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _pkg_meta is not None:
                            _bc_pkg_cache.write_sidecar(_pkg_meta)
                            _pkg_out_id = _pkg_meta.output_id

                _pkg_unique_kept: set[str] = set(_pkg_error_lines)
                if _pkg_summary_line:
                    _pkg_unique_kept.add(_pkg_summary_line)
                _pkg_kept = len(_pkg_unique_kept)
                _pkg_cmd_short = display_cmd[:60]
                _pkg_recall = _bash_recall(_pkg_out_id)

                _pkg_parts = [
                    f"[token-goat] pkg install: {_pkg_n_lines} lines → {_pkg_kept} kept | {_pkg_cmd_short}",
                ]
                if _pkg_summary_line and _pkg_summary_line not in _pkg_error_lines:
                    _pkg_parts.append(_pkg_summary_line)
                if _pkg_error_lines:
                    _pkg_parts.extend(_pkg_error_lines)
                if _pkg_recall:
                    _pkg_parts.append(_pkg_recall)

                _LOG.info(
                    "post-bash: pkg install compressed lines=%d progress=%d errors=%d cmd=%.60s",
                    _pkg_n_lines, _pkg_progress_count, len(_pkg_error_lines), display_cmd,
                )
                return {
                    "continue": True,
                    "systemMessage": "\n".join(_pkg_parts),
                }
        except Exception:
            _LOG.debug("post-bash: pkg install compression failed", exc_info=True)

    # Environment variable listing compression:
    # env / printenv / export -p / declare -x dump all environment variables —
    # typically 30-80 KEY=VALUE lines per run.  Values can be enormous and may
    # contain secrets/tokens, so the systemMessage shows variable NAMES only.
    # Fires when output reaches _ENV_LIST_MIN_LINES (10) lines on a successful run.
    if exit_code in (None, 0) and stdout and len(stdout.splitlines()) >= _ENV_LIST_MIN_LINES:
        try:
            import re as _re_env
            import shlex as _shlex_env

            from . import bash_compress as _bc_env

            try:
                _env_argv = _shlex_env.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _env_argv = display_cmd.strip().split()
            _env_argv_clean = [t.strip("\"'") for t in _env_argv]

            if _bc_env._is_env_list_cmd(_env_argv_clean):
                _env_lines = stdout.splitlines()
                _env_n_lines = len(_env_lines)

                # Extract variable names only — never values (may contain secrets).
                # Handles three output formats:
                #   KEY=value               (env / printenv)
                #   declare -x KEY=value    (declare -x)
                #   export KEY=value        (export -p)
                _env_var_names: list[str] = []
                _env_var_pattern = _re_env.compile(
                    r"^(?:declare\s+-x\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:=|$)"
                )
                for _el in _env_lines:
                    _em = _env_var_pattern.match(_el.strip())
                    if _em:
                        _env_var_names.append(_em.group(1))

                _env_total_vars = len(_env_var_names)

                if _env_total_vars > 0:
                    # Group into well-known prefix categories.
                    _env_cats: dict[str, list[str]] = {
                        "PATH-related": [],
                        "Python": [],
                        "Node/npm": [],
                        "AWS": [],
                        "Git": [],
                        "CI": [],
                        "Other": [],
                    }
                    for _vn in _env_var_names:
                        _vnu = _vn.upper()
                        if "PATH" in _vnu:
                            _env_cats["PATH-related"].append(_vn)
                        elif _vnu.startswith("PYTHON"):
                            _env_cats["Python"].append(_vn)
                        elif _vnu.startswith(("NODE", "NPM")):
                            _env_cats["Node/npm"].append(_vn)
                        elif _vnu.startswith("AWS_"):
                            _env_cats["AWS"].append(_vn)
                        elif _vnu.startswith("GIT_"):
                            _env_cats["Git"].append(_vn)
                        elif (
                            _vnu.startswith(("CI", "GITHUB_", "TRAVIS_", "CIRCLE_"))
                        ):
                            _env_cats["CI"].append(_vn)
                        else:
                            _env_cats["Other"].append(_vn)

                    _env_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_env_cache
                        with contextlib.suppress(Exception):
                            _env_meta = _bc_env_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _env_meta is not None:
                                _bc_env_cache.write_sidecar(_env_meta)
                                _env_out_id = _env_meta.output_id

                    _env_recall = _bash_recall(_env_out_id)
                    _env_msg_parts = [
                        f"[token-goat] env: {_env_total_vars} variables ({_env_n_lines} lines)",
                    ]
                    for _cat_name, _cat_vars in _env_cats.items():
                        if not _cat_vars:
                            continue
                        _cat_count = len(_cat_vars)
                        if _cat_count <= 10:
                            _cat_display = ", ".join(_cat_vars)
                        else:
                            _cat_display = ", ".join(_cat_vars[:10]) + f" +{_cat_count - 10} more"
                        _env_msg_parts.append(f"{_cat_name} ({_cat_count}): {_cat_display}")
                    if _env_recall:
                        _env_msg_parts.append(_env_recall)

                    _LOG.info(
                        "post-bash: env list compressed lines=%d vars=%d cmd=%.60s",
                        _env_n_lines, _env_total_vars, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": "\n".join(_env_msg_parts),
                    }
        except Exception:
            _LOG.debug("post-bash: env list compression failed", exc_info=True)

    # Container log compression:
    # docker logs / kubectl logs / podman logs / docker compose logs can emit thousands of
    # application log lines.  The model rarely needs every line — it needs recent output and
    # any ERROR/WARN lines.  Fires when output reaches _CONTAINER_LOG_MIN_LINES on a
    # successful run (exit_code in (None, 0)).
    if exit_code in (None, 0) and stdout and len(stdout.splitlines()) >= _CONTAINER_LOG_MIN_LINES:
        try:
            import shlex as _shlex_cl

            from . import bash_compress as _bc_cl

            try:
                _cl_argv = _shlex_cl.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _cl_argv = display_cmd.strip().split()
            _cl_argv_clean = [t.strip("\"'") for t in _cl_argv]

            if _bc_cl._is_container_log_cmd(_cl_argv_clean):
                if "--tail" in display_cmd or "--tail=" in display_cmd:
                    _LOG.debug("post-bash: container logs has --tail, skipping compression")
                else:
                    _cl_lines = stdout.splitlines()
                    _cl_n_lines = len(_cl_lines)

                    # Tail: last 20 lines (most recent output).
                    _cl_tail = _cl_lines[-20:]

                    # Error/warn lines: sequential scan that also captures stack frames
                    # immediately following a matched error line.
                    _CL_ERROR_PATTERNS = (
                        "error", "ERROR", "FATAL", "fatal", "CRITICAL", "panic",
                        "exception", "Exception",
                    )
                    _cl_error_lines: list[str] = []
                    _cl_ei = 0
                    while _cl_ei < len(_cl_lines):
                        _cl_ln = _cl_lines[_cl_ei]
                        if any(_cp in _cl_ln for _cp in _CL_ERROR_PATTERNS):
                            _cl_error_lines.append(_cl_ln.rstrip())
                            _cl_ei += 1
                            # Capture stack frames immediately following the error line
                            while _cl_ei < len(_cl_lines):
                                _cl_nxt = _cl_lines[_cl_ei]
                                _cl_nxt_s = _cl_nxt.strip()
                                if (
                                    _cl_nxt_s.startswith("at ")
                                    or _cl_nxt_s.lower().startswith("caused by:")
                                    or (_cl_nxt and _cl_nxt[0] in (" ", "\t") and _cl_nxt_s)
                                ):
                                    _cl_error_lines.append(_cl_nxt.rstrip())
                                    _cl_ei += 1
                                else:
                                    break
                        else:
                            _cl_ei += 1
                    _cl_error_count = len(_cl_error_lines)

                    _cl_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_cl_cache
                        with contextlib.suppress(Exception):
                            _cl_meta = _bc_cl_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _cl_meta is not None:
                                _bc_cl_cache.write_sidecar(_cl_meta)
                                _cl_out_id = _cl_meta.output_id

                    _cl_recall = _bash_recall(_cl_out_id)
                    _cl_short_cmd = display_cmd[:80]
                    _cl_msg_parts = [
                        f"[token-goat] container logs: {_cl_n_lines} lines"
                        f" | {_cl_error_count} errors/warnings | {_cl_short_cmd}",
                        "--- recent (last 20 lines) ---",
                        "\n".join(_cl_tail),
                    ]
                    if _cl_error_count > 0:
                        _cl_msg_parts.append(f"--- errors/warnings ({_cl_error_count} lines) ---")
                        if _cl_error_count > 30:
                            _cl_msg_parts.append("\n".join(_cl_error_lines[:30]))
                            _cl_msg_parts.append(f"+{_cl_error_count - 30} more")
                        else:
                            _cl_msg_parts.append("\n".join(_cl_error_lines))
                    if _cl_recall:
                        _cl_msg_parts.append(_cl_recall)

                    _LOG.info(
                        "post-bash: container logs compressed lines=%d errors=%d cmd=%.60s",
                        _cl_n_lines, _cl_error_count, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": "\n".join(_cl_msg_parts),
                    }
        except Exception:
            _LOG.debug("post-bash: container log compression failed", exc_info=True)

    # Git log output compression (Iter 21):
    # When git log emits >= _GIT_LOG_COMPRESS_MIN_LINES lines, store the full output
    # in bash-cache and return a compact summary with the first 5 lines so the model
    # gets orientation without burning context on hundreds of log lines.
    # Only fires on successful commands (exit_code in (None, 0)).
    if exit_code in (None, 0) and stdout and display_cmd.lstrip().startswith("git"):
        try:
            import re as _re_gl
            import shlex as _shlex_gl

            from . import bash_compress as _bc_gl

            try:
                _gl_argv = _shlex_gl.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _gl_argv = display_cmd.strip().split()
            _gl_argv_clean = [t.strip("\"'") for t in _gl_argv]

            if _bc_gl._is_git_log_cmd(_gl_argv_clean):
                _gl_lines = stdout.splitlines()
                _gl_n_lines = len(_gl_lines)
                if _gl_n_lines >= _GIT_LOG_COMPRESS_MIN_LINES:
                    # Count commits: full format uses "commit <40-hex>" headers;
                    # --oneline format uses "<7+ hex> <message>" lines.
                    _gl_n_commits = len(_re_gl.findall(r"^commit [0-9a-f]{40}", stdout, _re_gl.MULTILINE))
                    if _gl_n_commits == 0:
                        _gl_n_commits = len(_re_gl.findall(r"^[0-9a-f]{7,}\s", stdout, _re_gl.MULTILINE))

                    if _gl_n_commits == 0:
                        _LOG.debug("git log: unrecognized format (no commit markers found), skipping compression")
                    else:
                        _gl_out_id: str | None = None
                        if session_id:
                            from . import bash_cache as _bc_gl_cache
                            with contextlib.suppress(Exception):
                                _gl_meta = _bc_gl_cache.store_output(
                                    session_id, display_cmd, stdout, stderr, exit_code,
                                    cwd=cwd, min_cache_bytes=0,
                                )
                                if _gl_meta is not None:
                                    _bc_gl_cache.write_sidecar(_gl_meta)
                                    _gl_out_id = _gl_meta.output_id

                        _gl_recall = f" (bash-output {_gl_out_id})" if _gl_out_id else ""
                        _gl_first5 = "\n".join(_gl_lines[:5])
                        _gl_omitted = _gl_n_lines - 5
                        _gl_msg_parts = [
                            f"[token-goat] git log: {_gl_n_commits} commits shown ({_gl_n_lines} lines)"
                            f" — full output stored{_gl_recall}",
                            "First 5 commits:",
                            _gl_first5,
                        ]
                        if _gl_omitted > 0:
                            _gl_msg_parts.append(f"... ({_gl_omitted} lines omitted) ...")
                        _LOG.info(
                            "post-bash: git log compressed lines=%d commits=%d cmd=%.60s",
                            _gl_n_lines, _gl_n_commits, display_cmd,
                        )
                        return {
                            "continue": True,
                            "systemMessage": "\n".join(_gl_msg_parts),
                        }
        except Exception:
            _LOG.debug("post-bash: git log compression failed", exc_info=True)

    # Verbose pytest PASSED-line suppression:
    # Fires when the command is a pytest verbose run (-v/--verbose) and stdout is
    # long (>= _VERBOSE_TEST_MIN_LINES lines).  Strips per-test PASSED progress
    # lines which are pure noise on re-runs while keeping FAILED/ERROR lines,
    # failure sections, and the final summary.  Full output is cached so
    # ``bash-output <id>`` recall works.
    # Must sit BEFORE the iter-18 pytest block so verbose-but-passing runs get
    # compressed here (the iter-18 block only fires when "FAILED" is present).
    if exit_code in (None, 0, 1) and stdout and len(stdout.splitlines()) >= _VERBOSE_TEST_MIN_LINES:
        try:
            import shlex as _shlex_vt

            from .bash_compress import _VT_PASSED_LINE_RE as _vt_passed_re
            from .bash_compress import _is_verbose_test_cmd as _vt_check

            _vt_argv = _shlex_vt.split(display_cmd, posix=True)
            if _vt_argv and _vt_check(_vt_argv):
                _vt_lines = stdout.splitlines()
                _vt_kept: list[str] = []
                _vt_suppressed = 0
                for _vt_line in _vt_lines:
                    if _vt_passed_re.match(_vt_line):
                        _vt_suppressed += 1
                    else:
                        _vt_kept.append(_vt_line)
                if _vt_suppressed > 0:
                    _vt_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_vt
                        with contextlib.suppress(Exception):
                            _vt_meta = _bc_vt.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _vt_meta is not None:
                                _bc_vt.write_sidecar(_vt_meta)
                                _vt_out_id = _vt_meta.output_id
                    _vt_recall = _bash_recall(_vt_out_id)
                    _vt_body = "\n".join(_vt_kept)
                    if stdout.endswith(("\n", "\r\n")):
                        _vt_body += "\n"
                    _vt_msg = (
                        f"[token-goat] pytest -v: {len(_vt_lines)} lines"
                        f" → {len(_vt_kept)} kept"
                        f" ({_vt_suppressed} PASSED lines suppressed)\n"
                        + _vt_body
                        + _vt_recall
                    )
                    _LOG.info(
                        "post-bash: verbose pytest PASSED suppressed count=%d cmd=%.60s",
                        _vt_suppressed, display_cmd,
                    )
                    if _sess_mod is not None and _session_cache is not None:
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
                    return continue_with_message(_vt_msg)
        except Exception:
            _LOG.debug("post-bash: verbose pytest suppress failed", exc_info=True)

    # Cargo compilation output compression:
    # Fires when the command is a cargo build/check/clippy/fix/rustc invocation
    # and stdout has >= _CARGO_COMPILE_MIN_LINES lines.  Strips Compiling/Checking/
    # Downloading noise lines, keeping only error/warning diagnostic blocks plus
    # the terminal summary line (Finished / error count).  Full output is cached so
    # ``bash-output <id>`` recall works.  exit_code=101 (cargo panic) passes through
    # because the outer guard limits to (None, 0, 1).
    if exit_code in (None, 0, 1) and stdout and len(stdout.splitlines()) >= _CARGO_COMPILE_MIN_LINES:
        try:
            import re as _re_cg
            import shlex as _shlex_cg
            import sys as _sys_cg

            from .bash_compress import _is_cargo_compile_cmd as _cg_check

            _cg_argv = _shlex_cg.split(display_cmd, posix=(_sys_cg.platform != "win32"))
            if _cg_argv and _cg_check(_cg_argv):
                _DIAG_START_RE = _re_cg.compile(r"^(error|warning)(\[[\w:]+\])?:")
                _CARGO_NOISE_RE = _re_cg.compile(
                    r"^(   Compiling |   Checking |   Downloaded |    Blocking "
                    r"|   Generating |     Running |   Downloading |   Updating )"
                )
                _CARGO_TERMINAL_RE = _re_cg.compile(
                    r"^(Finished |error: (?:aborting|could not compile))"
                )
                # Matches any continuation line inside a diagnostic block:
                # arrow (-->), gutter (optional-digits + |), note/help (= note:/= help:),
                # and underline carets (^ ~).  Variable-width left margin handles files with
                # 1-, 2-, or 3+-digit line numbers correctly.
                _CARGO_CONT_RE = _re_cg.compile(
                    r"^\s*(-->|\d*\s*\||=\s*(note|help)|[~\^]+)"
                )
                _cg_lines = stdout.splitlines()
                _cg_total = len(_cg_lines)

                # Pass 1: collect diagnostic blocks (header line + context lines).
                # Terminal lines (Finished / could not compile / aborting) are checked
                # first so they are NOT added to diag_lines and not counted.
                _cg_diag_lines: list[str] = []
                _cg_in_diag = False
                for _cg_line in _cg_lines:
                    if _CARGO_TERMINAL_RE.match(_cg_line):
                        _cg_in_diag = False  # terminal line ends current diagnostic block
                    elif _DIAG_START_RE.match(_cg_line):
                        _cg_in_diag = True
                        _cg_diag_lines.append(_cg_line)
                    elif _cg_in_diag and _CARGO_CONT_RE.match(_cg_line):
                        _cg_diag_lines.append(_cg_line.rstrip())
                    else:
                        _cg_in_diag = False

                # Count error/warning header lines
                _cg_error_count = sum(
                    1 for _l in _cg_diag_lines if _re_cg.match(r"^error", _l)
                )
                _cg_warn_count = sum(
                    1 for _l in _cg_diag_lines if _re_cg.match(r"^warning", _l)
                )

                # Pass 2: find terminal summary line (search from end)
                _cg_terminal: str | None = None
                for _cg_line in reversed(_cg_lines):
                    if _CARGO_TERMINAL_RE.match(_cg_line):
                        _cg_terminal = _cg_line
                        break

                # Count noise lines to decide if clean-build compression is worthwhile
                _cg_noise_count = sum(
                    1 for _l in _cg_lines if _CARGO_NOISE_RE.match(_l)
                )

                if exit_code not in (None, 0) and _cg_error_count == 0 and _cg_warn_count == 0:
                    # Cargo exited with an error but stdout has no diagnostic headers.
                    # The real errors are likely on stderr.  Suppress compression so
                    # the model sees the full output rather than a misleading
                    # "0 errors, 0 warnings" banner.
                    _cg_should_compress = False
                elif _cg_error_count == 0 and _cg_warn_count == 0:
                    _cg_should_compress = _cg_noise_count >= 5
                else:
                    _cg_should_compress = True

                if _cg_should_compress:
                    _cg_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_cg
                        with contextlib.suppress(Exception):
                            _cg_meta = _bc_cg.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _cg_meta is not None:
                                _bc_cg.write_sidecar(_cg_meta)
                                _cg_out_id = _cg_meta.output_id
                    _cg_recall = _bash_recall(_cg_out_id)

                    if _cg_error_count == 0 and _cg_warn_count == 0:
                        # Clean but noisy build — only the terminal line matters
                        _cg_body = (_cg_terminal + "\n") if _cg_terminal else ""
                        if not stdout.endswith(("\n", "\r\n")) and _cg_body.endswith("\n"):
                            _cg_body = _cg_body.rstrip("\n")
                        _cg_suppressed = _cg_total - (1 if _cg_terminal else 0)
                        _cg_msg = (
                            f"[token-goat] cargo: 0 errors, 0 warnings"
                            f" ({_cg_suppressed}/{_cg_total} lines suppressed)\n"
                            + _cg_body
                            + _cg_recall
                        )
                    else:
                        # Has diagnostics — show them all plus terminal line
                        _cg_body_lines = list(_cg_diag_lines)
                        if _cg_terminal and (
                            not _cg_body_lines or _cg_body_lines[-1] != _cg_terminal
                        ):
                            _cg_body_lines.append(_cg_terminal)
                        _cg_body = "\n".join(_cg_body_lines)
                        if stdout.endswith(("\n", "\r\n")):
                            _cg_body += "\n"
                        _cg_suppressed = _cg_total - len(_cg_body_lines)
                        _cg_msg = (
                            f"[token-goat] cargo: {_cg_error_count} errors,"
                            f" {_cg_warn_count} warnings"
                            f" ({_cg_suppressed}/{_cg_total} lines suppressed)\n"
                            + _cg_body
                            + _cg_recall
                        )
                    _LOG.info(
                        "post-bash: cargo compile compressed lines=%d errors=%d warnings=%d cmd=%.60s",
                        _cg_total, _cg_error_count, _cg_warn_count, display_cmd,
                    )
                    if _sess_mod is not None and _session_cache is not None:
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
                    return continue_with_message(_cg_msg)
        except Exception:
            _LOG.debug("post-bash: cargo compile compression failed", exc_info=True)

    # make/cmake/ninja compression: suppress progress lines, keep errors/warnings; fires at >= _MAKE_MIN_LINES lines.
    if stdout and len(stdout.splitlines()) >= _MAKE_MIN_LINES and exit_code in (None, 0, 1, 2):
        try:
            import re as _re_mk
            import shlex as _shlex_mk
            import sys as _sys_mk

            from .bash_compress import _is_make_cmd as _mk_check

            _mk_argv = _shlex_mk.split(display_cmd, posix=(_sys_mk.platform != "win32"))
            if _mk_argv and _mk_check(_mk_argv):
                _MK_PROGRESS_RE = _re_mk.compile(
                    r"^\[[ \d]+%\]|^make\[\d+\]: (?:Entering|Leaving) directory|^Entering directory|^Leaving directory|^--"
                )
                _mk_lines = stdout.splitlines()
                _mk_total = len(_mk_lines)
                _mk_kept: list[str] = []
                _mk_suppressed = 0
                for _mk_line in _mk_lines:
                    if not _mk_line.strip() or _MK_PROGRESS_RE.match(_mk_line):
                        _mk_suppressed += 1
                    else:
                        _mk_kept.append(_mk_line)

                if _mk_suppressed > 0:
                    _mk_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_mk
                        with contextlib.suppress(Exception):
                            _mk_meta = _bc_mk.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _mk_meta is not None:
                                _bc_mk.write_sidecar(_mk_meta)
                                _mk_out_id = _mk_meta.output_id
                    _mk_recall = _bash_recall(_mk_out_id)

                    _mk_body = "\n".join(_mk_kept)
                    if stdout.endswith(("\n", "\r\n")):
                        _mk_body += "\n"
                    _mk_msg = (
                        f"[token-goat] make: {_mk_total} lines → {len(_mk_kept)} kept"
                        f" ({_mk_suppressed} progress lines hidden)\n"
                        + _mk_body
                        + _mk_recall
                    )
                    _LOG.info(
                        "post-bash: make compressed lines=%d kept=%d suppressed=%d cmd=%.60s",
                        _mk_total, len(_mk_kept), _mk_suppressed, display_cmd,
                    )
                    if _sess_mod is not None and _session_cache is not None:
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
                    return continue_with_message(_mk_msg)
        except Exception:
            _LOG.debug("post-bash: make compression failed", exc_info=True)

    # go test -v compression: suppress clean-pass RUN/PASS pairs, keep tests with logs or failures.
    if stdout and len(stdout.splitlines()) >= _GO_TEST_V_MIN_LINES and exit_code in (None, 0, 1):
        try:
            import shlex as _shlex_go
            import sys as _sys_go

            from .bash_compress import _is_go_test_verbose_cmd as _go_check

            _go_argv = _shlex_go.split(display_cmd, posix=(_sys_go.platform != "win32"))
            if _go_argv and _go_check(_go_argv):
                _go_lines = stdout.splitlines()
                _go_total = len(_go_lines)
                _go_kept: list[str] = []
                _go_hidden = 0
                _go_pending_run: str | None = None  # single-slot; interleaved t.Parallel() CONT may land in wrong slot
                _go_pending_logs: list[str] = []  # subtest RUN/PASS + real log lines buffered here
                _go_pending_has_user_logs = False  # True only when pending_logs has real (non-subtest-noise) content

                for _go_line in _go_lines:
                    _go_stripped = _go_line.strip()
                    if _go_stripped.startswith("=== PAUSE"):
                        # pure scheduling noise — suppress
                        _go_hidden += 1
                    elif _go_stripped.startswith("=== RUN"):
                        _go_test_name = _go_stripped.split()[-1] if _go_stripped.split() else ""
                        if "/" in _go_test_name and _go_pending_run is not None:
                            # subtest RUN — buffer as noise; don't evict the parent slot
                            _go_pending_logs.append(_go_line)
                        else:
                            # top-level test — flush buffered test then open a new slot
                            if _go_pending_run is not None:
                                if _go_pending_has_user_logs:
                                    _go_kept.append(_go_pending_run)
                                    _go_kept.extend(_go_pending_logs)
                                else:
                                    _go_hidden += 1 + len(_go_pending_logs)
                            _go_pending_run = _go_line
                            _go_pending_logs = []
                            _go_pending_has_user_logs = False
                    elif _go_stripped.startswith("--- PASS:"):
                        _go_pass_name = _go_stripped.split()[2] if len(_go_stripped.split()) >= 3 else ""
                        if "/" in _go_pass_name and _go_pending_run is not None:
                            # subtest PASS — buffer as noise alongside the parent slot
                            _go_pending_logs.append(_go_line)
                        elif _go_pending_run is not None and not _go_pending_has_user_logs:
                            # clean parent pass (no real user logs, only subtest noise) — suppress all
                            _go_hidden += 2 + len(_go_pending_logs)
                            _go_pending_run = None
                            _go_pending_logs = []
                            _go_pending_has_user_logs = False
                        else:
                            # parent pass with real logs — flush pending run + logs + this PASS line
                            if _go_pending_run is not None:
                                _go_kept.append(_go_pending_run)
                                _go_kept.extend(_go_pending_logs)
                            _go_kept.append(_go_line)
                            _go_pending_run = None
                            _go_pending_logs = []
                            _go_pending_has_user_logs = False
                    elif _go_stripped.startswith("--- FAIL:"):
                        # always keep failed tests
                        if _go_pending_run is not None:
                            _go_kept.append(_go_pending_run)
                            _go_kept.extend(_go_pending_logs)
                        _go_kept.append(_go_line)
                        _go_pending_run = None
                        _go_pending_logs = []
                        _go_pending_has_user_logs = False
                    elif _go_pending_run is not None:
                        # real log lines and === CONT — buffer and mark as user content
                        _go_pending_logs.append(_go_line)
                        _go_pending_has_user_logs = True
                    else:
                        # package-level lines (ok/FAIL pkg, coverage, etc.)
                        _go_kept.append(_go_line)

                # flush any remaining buffered test
                if _go_pending_run is not None:
                    if _go_pending_has_user_logs:
                        _go_kept.append(_go_pending_run)
                        _go_kept.extend(_go_pending_logs)
                    else:
                        _go_hidden += 1 + len(_go_pending_logs)

                if _go_hidden > 0:
                    _go_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_go
                        with contextlib.suppress(Exception):
                            _go_meta = _bc_go.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _go_meta is not None:
                                _bc_go.write_sidecar(_go_meta)
                                _go_out_id = _go_meta.output_id
                    _go_recall = _bash_recall(_go_out_id)
                    _go_body = "\n".join(_go_kept)
                    if stdout.endswith(("\n", "\r\n")):
                        _go_body += "\n"
                    _go_msg = (
                        f"[token-goat] go test -v: {_go_total} lines → {len(_go_kept)} kept"
                        f" ({_go_hidden} lines suppressed)\n"
                        + _go_body
                        + _go_recall
                    )
                    _LOG.info(
                        "post-bash: go test -v compressed lines=%d kept=%d hidden=%d cmd=%.60s",
                        _go_total, len(_go_kept), _go_hidden, display_cmd,
                    )
                    if _sess_mod is not None and _session_cache is not None:
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
                    return continue_with_message(_go_msg)
        except Exception:
            _LOG.debug("post-bash: go test -v compression failed", exc_info=True)

    # tsc compression: strip timestamp/watch noise, keep diagnostics + summary; fires at >= _TSC_MIN_LINES lines.
    if stdout and len(stdout.splitlines()) >= _TSC_MIN_LINES:
        try:
            import re as _re_tsc
            import shlex as _shlex_tsc
            import sys as _sys_tsc

            from .bash_compress import _is_tsc_cmd as _tsc_check

            _tsc_argv = _shlex_tsc.split(display_cmd, posix=(_sys_tsc.platform != "win32"))
            if _tsc_argv and _tsc_check(_tsc_argv):
                _TSC_DIAG_RE = _re_tsc.compile(r"^[^\s].+\(\d+,\d+\): (error|warning) TS\d+:")
                _TSC_SUMMARY_RE = _re_tsc.compile(r"^Found \d+ errors?\.")
                _tsc_lines = stdout.splitlines()
                _tsc_total = len(_tsc_lines)
                _tsc_diag_lines: list[str] = []
                _tsc_noise_lines: list[str] = []
                _tsc_summary: str | None = None
                for _tsc_line in _tsc_lines:
                    if _TSC_SUMMARY_RE.match(_tsc_line):
                        _tsc_summary = _tsc_line
                    elif _TSC_DIAG_RE.match(_tsc_line) or _TSC_BARE_DIAG_RE.match(_tsc_line):
                        _tsc_diag_lines.append(_tsc_line)
                    else:
                        _tsc_noise_lines.append(_tsc_line)

                if not _tsc_noise_lines:
                    pass  # nothing to suppress — fall through
                else:
                    _tsc_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_tsc
                        with contextlib.suppress(Exception):
                            _tsc_meta = _bc_tsc.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _tsc_meta is not None:
                                _bc_tsc.write_sidecar(_tsc_meta)
                                _tsc_out_id = _tsc_meta.output_id
                    _tsc_recall = _bash_recall(_tsc_out_id)

                    if not _tsc_diag_lines and exit_code in (None, 0):
                        # Clean build with verbose/timestamp noise only
                        _tsc_summary_line = _tsc_summary or next(
                            (_l for _l in reversed(_tsc_lines) if _l.strip()), None
                        )
                        _tsc_body = (_tsc_summary_line + "\n") if _tsc_summary_line else ""
                        if not stdout.endswith(("\n", "\r\n")) and _tsc_body.endswith("\n"):
                            _tsc_body = _tsc_body.rstrip("\n")
                        _tsc_suppressed = _tsc_total - (1 if _tsc_summary_line else 0)
                        _tsc_msg = (
                            f"[token-goat] tsc: 0 errors, 0 warnings"
                            f" ({_tsc_suppressed}/{_tsc_total} lines suppressed)\n"
                            + _tsc_body
                            + _tsc_recall
                        )
                    else:
                        # Has diagnostics — keep all, strip noise lines
                        _tsc_error_count = sum(
                            1 for _l in _tsc_diag_lines
                            if _re_tsc.search(r"(?:^|: )error TS\d+:", _l)
                        )
                        _tsc_warn_count = sum(
                            1 for _l in _tsc_diag_lines
                            if _re_tsc.search(r"(?:^|: )warning TS\d+:", _l)
                        )
                        _tsc_body_lines = list(_tsc_diag_lines)
                        if _tsc_summary and (
                            not _tsc_body_lines or _tsc_body_lines[-1] != _tsc_summary
                        ):
                            _tsc_body_lines.append(_tsc_summary)
                        _tsc_body = "\n".join(_tsc_body_lines)
                        if stdout.endswith(("\n", "\r\n")):
                            _tsc_body += "\n"
                        _tsc_suppressed = _tsc_total - len(_tsc_body_lines)
                        _tsc_msg = (
                            f"[token-goat] tsc: {_tsc_error_count} errors,"
                            f" {_tsc_warn_count} warnings"
                            f" ({_tsc_suppressed}/{_tsc_total} lines suppressed)\n"
                            + _tsc_body
                            + _tsc_recall
                        )
                    _LOG.info(
                        "post-bash: tsc compressed lines=%d diag=%d cmd=%.60s",
                        _tsc_total, len(_tsc_diag_lines), display_cmd,
                    )
                    if _sess_mod is not None and _session_cache is not None:
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
                    return continue_with_message(_tsc_msg)
        except Exception:
            _LOG.debug("post-bash: tsc compression failed", exc_info=True)

    # Pytest failure traceback suppression (Iter 18):
    # Fires when pytest output is large (>= _PYTEST_COMPRESS_MIN_BYTES) and contains
    # FAILED markers.  Stores full output in bash-cache first so ``bash-output <id>``
    # recall works, then replaces each ``___ test_name ___`` block with a one-liner stub.
    # Exit code 1 is pytest's normal failure exit — guard on (None, 0, 1) not (None, 0).
    if (
        _is_pytest_command(display_cmd)
        and exit_code in (None, 0, 1)
        and stdout
        and len(stdout) >= _PYTEST_COMPRESS_MIN_BYTES
        and "FAILED" in stdout
    ):
        try:
            _pt_out_id: str | None = None
            if session_id:
                from . import bash_cache as _bc_pt
                with contextlib.suppress(Exception):
                    _pt_meta = _bc_pt.store_output(
                        session_id, display_cmd, stdout, stderr, exit_code,
                        cwd=cwd, min_cache_bytes=0,
                    )
                    if _pt_meta is not None:
                        _bc_pt.write_sidecar(_pt_meta)
                        _pt_out_id = _pt_meta.output_id

            _pt_compressed = _compress_pytest_failures(stdout, _pt_out_id)
            if _pt_compressed is not stdout:
                _LOG.info(
                    "post-bash: pytest failures compressed bytes=%d->%d cmd=%.60s",
                    len(stdout), len(_pt_compressed), display_cmd,
                )
                if _sess_mod is not None and _session_cache is not None:
                    with contextlib.suppress(Exception):
                        _sess_mod.save(_session_cache)
                return {
                    "continue": True,
                    "systemMessage": _pt_compressed,
                }
        except Exception:
            _LOG.debug("post-bash: pytest compression failed", exc_info=True)

    # Large JSON/XML output summarization (Iter 17):
    # - Valid JSON dict/list >= _JSON_SUMMARY_MIN_BYTES → structural summary + store
    # - XML >= _JSON_SUMMARY_MIN_BYTES → one-liner suppression + store
    # Only fires on successful commands (exit_code in (None, 0)) with non-empty stdout.
    if exit_code in (None, 0) and stdout and _JSON_SUMMARY_MIN_BYTES <= len(stdout) <= _JSON_SUMMARY_MAX_BYTES:
        try:
            import json as _json

            _jx_data: object = _json.loads(stdout)
            if isinstance(_jx_data, (dict, list)):
                _jx_out_id: str | None = None
                if session_id:
                    from . import bash_cache as _bc_jx
                    with contextlib.suppress(Exception):
                        _jx_meta = _bc_jx.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _jx_meta is not None:
                            _bc_jx.write_sidecar(_jx_meta)
                            _jx_out_id = _jx_meta.output_id
                _jx_recall = f" (use bash-output {_jx_out_id} for full)" if _jx_out_id else ""
                _jx_summary = _json_structural_summary(_jx_data)
                _jx_size = len(stdout)
                _LOG.info("post-bash: large JSON summarized bytes=%d cmd=%.60s", _jx_size, display_cmd)
                return {
                    "continue": True,
                    "systemMessage": (
                        f"[token-goat] large JSON output ({_jx_size:,} bytes)"
                        f" — structural summary{_jx_recall}:\n\n"
                        + _jx_summary
                    ),
                }
        except ValueError:  # json.JSONDecodeError subclasses ValueError; catches parse failures only
            pass  # fall through to XML check and normal handling

        # XML detection: check for XML declaration or root element tag opener.
        # JUnit XML is excluded here — it is handled by the dedicated JUnit handler below.
        try:
            _jx_stripped = stdout.lstrip()
            _jx_is_xml = _jx_stripped[:5] == "<?xml" or (
                _jx_stripped[:1] == "<" and len(_jx_stripped) > 1 and _jx_stripped[1:2].isalpha()
            )
            from . import bash_compress as _bc_jx_junit
            if _jx_is_xml and not _bc_jx_junit._is_junit_xml_output(stdout):
                _jx_out_id = None
                if session_id:
                    from . import bash_cache as _bc_jx
                    with contextlib.suppress(Exception):
                        _jx_meta = _bc_jx.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _jx_meta is not None:
                            _bc_jx.write_sidecar(_jx_meta)
                            _jx_out_id = _jx_meta.output_id
                _jx_recall = f" (use bash-output {_jx_out_id} to recall)" if _jx_out_id else ""
                _jx_size = len(stdout)
                _LOG.info("post-bash: large XML suppressed bytes=%d cmd=%.60s", _jx_size, display_cmd)
                return {
                    "continue": True,
                    "systemMessage": (
                        f"[token-goat] large XML output ({_jx_size:,} bytes)"
                        f" — stored{_jx_recall}"
                    ),
                }
        except Exception:
            _LOG.debug("post-bash: XML detection failed", exc_info=True)

    # Python script traceback compression (Iter 31):
    # When a Python script crashes with an uncaught exception, compress the multi-line
    # traceback down to the last 15 stderr lines plus a header with the exception type.
    # Guards: non-zero exit, "Traceback" in stderr, python invocation, not pytest,
    # stderr line count >= _PYTHON_TB_MIN_STDERR_LINES.
    if (
        exit_code not in (None, 0)
        and stderr
        and "Traceback (most recent call last):" in stderr
        and len(stderr.splitlines()) >= _PYTHON_TB_MIN_STDERR_LINES
        and not _is_pytest_command(display_cmd)
    ):
        try:
            import shlex as _shlex_py
            import sys as _sys_py

            from .bash_compress import _is_python_script_cmd as _py_check

            _py_argv = _shlex_py.split(display_cmd, posix=(_sys_py.platform != "win32"))
            if _py_argv and _py_check(_py_argv):
                _py_stderr_lines = stderr.splitlines()
                _py_total = len(_py_stderr_lines)
                _py_tail = _py_stderr_lines[-15:]
                # Extract exception type+message from last non-empty stderr line
                _py_exc = next(
                    (ln.strip() for ln in reversed(_py_stderr_lines) if ln.strip()),
                    "unknown error",
                )
                _py_out_id: str | None = None
                if session_id:
                    from . import bash_cache as _bc_py
                    with contextlib.suppress(Exception):
                        _py_meta = _bc_py.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _py_meta is not None:
                            _bc_py.write_sidecar(_py_meta)
                            _py_out_id = _py_meta.output_id
                _py_recall = (
                    "\nbash-output " + _py_out_id + " for full output"
                ) if _py_out_id else ""
                _py_msg = (
                    "[token-goat] python crash: " + _py_exc
                    + " (stderr: " + str(_py_total) + " lines → 15 kept)\n"
                    + "\n".join(_py_tail)
                    + _py_recall
                )
                _LOG.info(
                    "post-bash: python traceback compressed stderr_lines=%d cmd=%.60s",
                    _py_total, display_cmd,
                )
                if _sess_mod is not None and _session_cache is not None:
                    with contextlib.suppress(Exception):
                        _sess_mod.save(_session_cache)
                return continue_with_message(_py_msg)
        except Exception:
            _LOG.debug("post-bash: python traceback compression failed", exc_info=True)

    # Minified-file grep elision (Iter 32): when rg/grep/git-grep hits a minified
    # JS/CSS file the matched "line" can be 100k+ chars.  Truncate to first 120 chars
    # and store the full output as a bash-output blob for recall.
    if stdout:
        try:
            import shlex as _shlex_min
            import sys as _sys_min

            from .bash_compress import (
                _has_minified_grep_hit as _min_grep_hit,
            )
            from .bash_compress import (
                _is_grep_cmd as _min_is_grep,
            )
            from .bash_compress import (
                _is_minified_file as _min_file,
            )
            _min_argv = _shlex_min.split(display_cmd, posix=(_sys_min.platform != "win32"))
            if _min_argv and _min_is_grep(_min_argv) and _min_grep_hit(stdout):
                _min_out_id: str | None = None
                if session_id:
                    from . import bash_cache as _bc_min
                    with contextlib.suppress(Exception):
                        _min_meta = _bc_min.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _min_meta is not None:
                            _bc_min.write_sidecar(_min_meta)
                            _min_out_id = _min_meta.output_id
                _min_recall = _bash_recall(_min_out_id)
                _min_elided = 0
                _min_kept: list[str] = []
                for _min_line in stdout.splitlines():
                    _mc_search_from = 2 if (len(_min_line) >= 3 and _min_line[1] == ":" and _min_line[2] in "/\\") else 0
                    _mc_idx = _min_line.find(":", _mc_search_from)
                    if _mc_idx >= 1:
                        _mc_path = _min_line[:_mc_idx]
                        _mc_rest = _min_line[_mc_idx + 1:]
                        _mc_content = _re.sub(r"^\d+:", "", _mc_rest, count=1)
                        if _min_file(_mc_path) and len(_mc_content) > 500:
                            _min_kept.append(
                                f"{_mc_path}:...<{len(_mc_content)} chars elided, "
                                f"match at offset 0>...{_mc_content[:120]}"
                            )
                            _min_elided += 1
                            continue
                    _min_kept.append(_min_line)
                if _min_elided:
                    _recall_clause = (
                        f" (full content in bash-output {_min_out_id})"
                        if _min_out_id
                        else " (full output not stored — no active session)"
                    )
                    _min_header = (
                        f"[token-goat] grep: minified file match — long lines truncated to first 120 chars"
                        f"{_recall_clause}\n"
                    )
                    _LOG.info(
                        "post-bash: minified grep elision elided=%d cmd=%.60s",
                        _min_elided, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": _min_header + "\n".join(_min_kept) + _min_recall,
                    }
        except Exception:
            _LOG.debug("post-bash: minified grep elision failed", exc_info=True)

    # JUnit XML summary (Iter 35):
    # When stdout looks like JUnit XML (<?xml ... <testsuite) and has >= 10 lines OR >= 4096
    # bytes (catches compact single-line XML from pytest-junit compact mode / machine-gen XML),
    # parse it and emit a structured pass/fail summary instead of raw XML.
    # Fires before the large-stdout fallback so verbose stacktrace XML is caught here.
    if stdout:
        try:
            from . import bash_compress as _bc_junit
            if (_bc_junit._is_junit_xml_output(stdout)
                    and (len(stdout.splitlines()) >= 10 or len(stdout) >= 4096)):
                _junit_summary = _summarize_junit_xml(stdout)
                if _junit_summary is not None:
                    _junit_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_junit_cache
                        with contextlib.suppress(Exception):
                            _junit_meta = _bc_junit_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _junit_meta is not None:
                                _bc_junit_cache.write_sidecar(_junit_meta)
                                _junit_out_id = _junit_meta.output_id
                    _junit_recall = f"\n[Full XML: bash-output {_junit_out_id}]" if _junit_out_id else ""
                    _LOG.info("post-bash: JUnit XML summarised cmd=%.60s", display_cmd)
                    return {
                        "continue": True,
                        "systemMessage": _junit_summary + _junit_recall,
                    }
        except Exception:
            _LOG.debug("post-bash: JUnit XML summary failed", exc_info=True)

    # Jest / Vitest verbose output (Iter 36):
    # Fires after JUnit XML and before the large-stdout fallback.
    # Suppresses PASS suite headers (and their per-test ✓ children) from jest/vitest
    # output, keeping FAIL blocks and the summary block intact.  Catches ``npm test``,
    # ``npx jest``, ``yarn test``, and ``pnpm test`` invocations that don't match the
    # pre-bash JestFilter / VitestFilter (which only fires on direct binary names).
    if stdout and len(stdout.splitlines()) >= 5:
        try:
            import shlex as _shlex_jest

            from . import bash_compress as _bc_jest
            try:
                _jest_argv = _shlex_jest.split(display_cmd, posix=False)
            except ValueError:
                _jest_argv = display_cmd.strip().split()
            _jest_argv_clean = [t.strip("\"'") for t in _jest_argv]
            if (
                _bc_jest._is_jest_cmd(_jest_argv_clean)
                and (_bc_jest._has_jest_output(stdout) or _bc_jest._has_vitest_output(stdout))
                and exit_code in (None, 0, 1)
            ):
                _jest_compressed, _jest_pass_ct, _jest_fail_ct = _bc_jest.compress_jest_output(stdout)
                if _jest_pass_ct > 0 and _jest_compressed.strip():
                    _jest_lines_orig = len(stdout.splitlines())
                    _jest_lines_new = len(_jest_compressed.splitlines())
                    _jest_saved = _jest_lines_orig - _jest_lines_new
                    _jest_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_jest_cache
                        with contextlib.suppress(Exception):
                            _jest_meta = _bc_jest_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _jest_meta is not None:
                                _bc_jest_cache.write_sidecar(_jest_meta)
                                _jest_out_id = _jest_meta.output_id
                    _jest_recall = (
                        f" (bash-output {_jest_out_id} to recall full output)"
                        if _jest_out_id else ""
                    )
                    _jest_header = (
                        f"[token-goat] jest: {_jest_pass_ct} PASS suite(s) suppressed "
                        f"({_jest_saved} lines removed), {_jest_fail_ct} FAIL suite(s) shown"
                        f"{_jest_recall}"
                    )
                    _LOG.info(
                        "post-bash: jest output compressed pass=%d fail=%d cmd=%.60s",
                        _jest_pass_ct, _jest_fail_ct, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": _jest_header + "\n\n" + _jest_compressed,
                    }
        except Exception:
            _LOG.debug("post-bash: jest compress failed", exc_info=True)

    # curl -v verbose output compressor (Iter 37):
    # Strips TLS handshake noise, connection info, and redundant response headers
    # from `curl -v` output.  Keeps the request line, HTTP status, content-type,
    # and response body.  Fires on successful or zero-exit curl verbose commands.
    # Failures (exit_code != 0 and != None) are left untouched so the model sees
    # the full error context.
    if stdout and exit_code in (None, 0) and len(stdout.splitlines()) >= 10:
        try:
            import shlex as _shlex_curl

            from . import bash_compress as _bc_curl
            try:
                _curl_argv = _shlex_curl.split(display_cmd, posix=False)
            except ValueError:
                _curl_argv = display_cmd.strip().split()
            _curl_argv_clean = [t.strip("\"'") for t in _curl_argv]
            if (
                _bc_curl._is_curl_verbose_cmd(_curl_argv_clean)
                and _bc_curl._has_curl_verbose_output(stdout)
            ):
                _curl_compressed, _curl_lines_removed = _bc_curl.compress_curl_verbose(stdout)
                if _curl_lines_removed > 0 and _curl_compressed.strip():
                    _curl_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_curl_cache
                        with contextlib.suppress(Exception):
                            _curl_meta = _bc_curl_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _curl_meta is not None:
                                _bc_curl_cache.write_sidecar(_curl_meta)
                                _curl_out_id = _curl_meta.output_id
                    # Extract HTTP status code for the message (e.g. "200")
                    _curl_status_code = ""
                    for _cln in stdout.splitlines():
                        import re as _re_curl
                        _sm = _re_curl.match(r"^< HTTP/[12](?:\.\d)? (\d{3})", _cln)
                        if _sm:
                            _curl_status_code = _sm.group(1)
                            break
                    _curl_recall = (
                        f"\nFull output: bash-output {_curl_out_id}"
                        if _curl_out_id else ""
                    )
                    _curl_status_str = f", HTTP {_curl_status_code}" if _curl_status_code else ""
                    _curl_header = (
                        f"[token-goat] curl -v: {_curl_lines_removed} verbose lines stripped "
                        f"(TLS/connection/headers). Kept: request line{_curl_status_str}, "
                        f"content-type.{_curl_recall}"
                    )
                    _LOG.info(
                        "post-bash: curl verbose compressed lines_removed=%d cmd=%.60s",
                        _curl_lines_removed, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": _curl_header + "\n\n" + _curl_compressed,
                    }
        except Exception:
            _LOG.debug("post-bash: curl verbose compress failed", exc_info=True)

    # docker build output compressor (Iter 38):
    # Collapses redundant `---> Using cache` / `---> <hash>` / BuildKit sub-step
    # lines, keeping only step headers, RUN output, and error lines.
    # Fires on successful docker build / buildx build commands with >= 10 lines.
    if stdout and exit_code in (None, 0) and len(stdout.splitlines()) >= 10:
        try:
            import shlex as _shlex_docker

            from . import bash_compress as _bc_docker
            try:
                _docker_argv = _shlex_docker.split(display_cmd, posix=False)
            except ValueError:
                _docker_argv = display_cmd.strip().split()
            _docker_argv_clean = [t.strip("\"'") for t in _docker_argv]
            if (
                _bc_docker._is_docker_build_cmd(_docker_argv_clean)
                and _bc_docker._has_docker_build_output(stdout)
            ):
                _docker_compressed, _docker_lines_removed = _bc_docker.compress_docker_build(stdout)
                if _docker_lines_removed > 0 and _docker_compressed.strip():
                    _docker_out_id: str | None = None
                    if session_id:
                        from . import bash_cache as _bc_docker_cache
                        with contextlib.suppress(Exception):
                            _docker_meta = _bc_docker_cache.store_output(
                                session_id, display_cmd, stdout, stderr, exit_code,
                                cwd=cwd, min_cache_bytes=0,
                            )
                            if _docker_meta is not None:
                                _bc_docker_cache.write_sidecar(_docker_meta)
                                _docker_out_id = _docker_meta.output_id
                    _docker_recall = (
                        f"\nFull output: bash-output {_docker_out_id}"
                        if _docker_out_id else ""
                    )
                    _docker_header = (
                        f"[token-goat] docker build: {_docker_lines_removed} build steps "
                        f"compressed (cache/hash/sub-step lines removed). "
                        f"Kept: step headers, RUN output, errors.{_docker_recall}"
                    )
                    _LOG.info(
                        "post-bash: docker build compressed lines_removed=%d cmd=%.60s",
                        _docker_lines_removed, display_cmd,
                    )
                    return {
                        "continue": True,
                        "systemMessage": _docker_header + "\n\n" + _docker_compressed,
                    }
        except Exception:
            _LOG.debug("post-bash: docker build compress failed", exc_info=True)

    # Large plain-text stdout fallback compressor (Iter 19):
    # Fires AFTER all specialized handlers (JSON/XML, pytest, sleep/poll, etc.).
    # When a successful command emits >= _LARGE_STDOUT_LINE_THRESHOLD lines of plain text,
    # stores the full output in bash_cache and returns a compact head+tail preview
    # so the model gets orientation without burning context on thousands of lines.
    if (
        exit_code in (None, 0)
        and stdout
        and len(stdout.splitlines()) >= _LARGE_STDOUT_LINE_THRESHOLD
    ):
        try:
            _lc_lines = stdout.splitlines()
            _lc_total = len(_lc_lines)
            _lc_out_id: str | None = None
            if session_id:
                from . import bash_cache as _bc_lc
                with contextlib.suppress(Exception):
                    _lc_meta = _bc_lc.store_output(
                        session_id, display_cmd, stdout, stderr, exit_code,
                        cwd=cwd, min_cache_bytes=0,
                    )
                    if _lc_meta is not None:
                        _bc_lc.write_sidecar(_lc_meta)
                        _lc_out_id = _lc_meta.output_id
            _lc_recall = f" (bash-output {_lc_out_id} to recall)" if _lc_out_id else ""
            _lc_head = "\n".join(_lc_lines[:10])
            _lc_tail = "\n".join(_lc_lines[-5:])
            _lc_omitted = _lc_total - 15
            _LOG.info("post-bash: large stdout compressed lines=%d cmd=%.60s", _lc_total, display_cmd)
            return {
                "continue": True,
                "systemMessage": (
                    f"[token-goat] large output: {_lc_total} lines"
                    f" {'stored' if _lc_out_id else 'preview'}{_lc_recall}\n\n"
                    f"```\n{_lc_head}\n```\n\n"
                    f"... ({_lc_omitted} lines omitted) ...\n\n"
                    f"```\n{_lc_tail}\n```"
                ),
            }
        except Exception:
            _LOG.debug("post-bash: large stdout compression failed", exc_info=True)

    # Dir-listing fingerprint cache: suppress repeated find/fd/ls-R/eza-tree listings
    # when the directory content has not changed since the last run.
    # Key: "{norm_dir_path}:{cmd_fingerprint}" where cmd_fingerprint is a 16-hex-char
    # SHA256 of the full display_cmd string (different flags → different fingerprint).
    # Value: 16-hex-char SHA256 of the stdout output.
    # Only fires on successful listings (exit 0) with non-empty stdout.
    if _sess_mod is not None and _session_cache is not None and exit_code in (None, 0) and stdout:
        try:
            import shlex as _shlex_dl

            from . import bash_compress as _bc_dl
            try:
                _dl_argv = _shlex_dl.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _dl_argv = display_cmd.strip().split()
            _dl_type = _bc_dl._dir_listing_cmd_type(_dl_argv)
            if _dl_type is not None:
                # Extract target directory: first non-flag, non-option argument after
                # the command name, skipping flags that consume the next token.
                _dl_args = _dl_argv[1:]
                _dl_dir_raw: str | None = None
                _dl_skip_next = False
                # fd's positional signature is: fd [FLAGS] [PATTERN] [PATH]...
                # The first non-flag arg is the pattern, not the directory.
                _dl_skip_positional = _dl_type == "fd"
                _DL_CONSUME_NEXT = {
                    "--max-depth", "--maxdepth", "-maxdepth", "--min-depth", "--mindepth",
                    "--type", "-type", "--extension", "-e", "--exclude", "--name", "-name",
                    "--ignore", "-d", "--depth", "-l", "--level",
                }
                for _dl_tok in _dl_args:
                    if _dl_skip_next:
                        _dl_skip_next = False
                        continue
                    _dl_clean = _dl_tok.strip("\"'")
                    if _dl_clean.startswith("-"):
                        if _dl_clean in _DL_CONSUME_NEXT:
                            _dl_skip_next = True
                        continue
                    if _dl_skip_positional:
                        _dl_skip_positional = False
                        continue
                    _dl_dir_raw = _dl_clean
                    break
                if _dl_dir_raw:
                    _dl_p = Path(_dl_dir_raw)
                    if not _dl_p.is_absolute() and cwd:
                        _dl_p = Path(cwd) / _dl_dir_raw
                    try:
                        _dl_norm = str(_dl_p.resolve()).replace("\\", "/")
                    except (OSError, ValueError):
                        _dl_norm = ""
                    if _dl_norm:
                        _dl_cmd_fp = hashlib.sha256(display_cmd.encode()).hexdigest()[:16]
                        _dl_key = f"{_dl_norm}:{_dl_cmd_fp}"
                        _dl_out_hash = hashlib.sha256(stdout.replace("\r\n", "\n").encode()).hexdigest()[:16]
                        _dl_cached = _session_cache.get_dir_listing_hit(_dl_key)
                        if _dl_cached is not None and _dl_cached == _dl_out_hash:
                            _LOG.info(
                                "post-bash: dir-listing cache hit suppressed output dir=%s type=%s",
                                sanitize_log_str(_dl_norm), _dl_type,
                            )
                            with contextlib.suppress(Exception):
                                _sess_mod.save(_session_cache)
                            return {
                                "continue": True,
                                "systemMessage": (
                                    f"[token-goat] Directory listing for '{_dl_dir_raw}' unchanged"
                                    " — suppressed duplicate output (re-run to see full listing)"
                                ),
                            }
                        # Cache miss or changed output: record for future suppression.
                        _session_cache.record_dir_listing(_dl_key, _dl_out_hash)
                        with contextlib.suppress(Exception):
                            _sess_mod.save(_session_cache)
        except Exception:
            _LOG.debug("post-bash: dir-listing cache check failed", exc_info=True)

    # Git diff delta cache: when the same git diff command (same normalised args +
    # HEAD commit SHA) is re-run within a session, compare the new output against
    # the previously cached diff and emit only the delta rather than the full blob.
    # - Identical diff → suppress entirely with an advisory note.
    # - Small delta (< _GIT_DIFF_SMALL_DELTA lines) → pass through the full new
    #   diff; the model needs the context to understand what changed.
    # - Large delta → emit a summary header + first _GIT_DIFF_DELTA_PREVIEW_LINES
    #   delta lines so the model sees what changed without re-reading everything.
    # Only fires when: exit_code == 0, len(stdout) >= _GIT_DIFF_MIN_BYTES, and the
    # command is git diff (excluding --stat/--shortstat/--numstat variants).
    if exit_code in (None, 0) and len(stdout) >= _GIT_DIFF_MIN_BYTES and session_id:
        try:
            import shlex as _shlex_gd
            try:
                _gd_argv = _shlex_gd.split(display_cmd.split("|")[0].strip(), posix=False)
            except ValueError:
                _gd_argv = display_cmd.strip().split()
            # Strip shell quoting from every token before classification.
            _gd_argv_clean = [t.strip("\"'") for t in _gd_argv]
            if _is_git_diff_target(_gd_argv_clean):
                _gd_norm_args = _normalize_git_diff_args(_gd_argv_clean)
                _gd_head_sha = _get_head_sha(cwd)
                if _gd_head_sha is not None:
                    _gd_key = f"{session_id}:{_gd_norm_args}:{_gd_head_sha}"
                    _gd_marker_cmd = f"__git_diff_cache__:{_gd_key}"
                    from . import bash_cache as _bc_gd
                    _gd_prior_meta = _bc_gd.find_cached_for_command(_gd_marker_cmd, cwd=cwd)
                    _gd_prior_text: str | None = None
                    if _gd_prior_meta is not None:
                        _gd_prior_text = _bc_gd.load_output(_gd_prior_meta.output_id)
                    # Persist current diff under the marker key for future comparisons.
                    # min_cache_bytes=0 bypasses the size floor (we already checked above).
                    # write_sidecar is required so find_cached_for_command can locate
                    # the entry by cmd_sha when the second diff arrives.
                    with contextlib.suppress(Exception):
                        _gd_stored = _bc_gd.store_output(
                            session_id, _gd_marker_cmd, stdout, "", 0,
                            cwd=cwd, min_cache_bytes=0,
                        )
                        if _gd_stored is not None:
                            _bc_gd.write_sidecar(_gd_stored)
                    if _gd_prior_text is not None:
                        from collections import Counter as _Counter
                        _gd_new_lines = stdout.splitlines()
                        _gd_old_lines = _gd_prior_text.splitlines()
                        _gd_old_cnt = _Counter(_gd_old_lines)
                        _gd_new_cnt = _Counter(_gd_new_lines)
                        # Use multiset difference so repeated lines (context lines,
                        # blank lines, hunk markers) are counted correctly.
                        _gd_added: list[str] = []
                        for _ln, _cnt in _gd_new_cnt.items():
                            _extra = _cnt - _gd_old_cnt.get(_ln, 0)
                            if _extra > 0:
                                _gd_added.extend([_ln] * _extra)
                        _gd_removed: list[str] = []
                        for _ln, _cnt in _gd_old_cnt.items():
                            _extra = _cnt - _gd_new_cnt.get(_ln, 0)
                            if _extra > 0:
                                _gd_removed.extend([_ln] * _extra)
                        _gd_delta_n = len(_gd_added) + len(_gd_removed)
                        if _gd_delta_n == 0:
                            _LOG.info(
                                "post-bash: git diff unchanged; suppressing output key=%.60s", _gd_key
                            )
                            return {
                                "continue": True,
                                "systemMessage": (
                                    "[token-goat] git diff unchanged since last run — output suppressed"
                                ),
                            }
                        if _gd_delta_n < _GIT_DIFF_SMALL_DELTA:
                            pass  # small delta: full new diff passes through unchanged
                        else:
                            _gd_delta_lines = (
                                [f"+ {ln}" for ln in _gd_added]
                                + [f"- {ln}" for ln in _gd_removed]
                            )
                            _gd_preview = "\n".join(_gd_delta_lines[:_GIT_DIFF_DELTA_PREVIEW_LINES])
                            _LOG.info(
                                "post-bash: git diff changed; delta summary key=%.60s added=%d removed=%d",
                                _gd_key, len(_gd_added), len(_gd_removed),
                            )
                            return {
                                "continue": True,
                                "systemMessage": (
                                    f"[token-goat] git diff changed: {len(_gd_added)} lines added,"
                                    f" {len(_gd_removed)} lines removed vs prior run\n{_gd_preview}"
                                ),
                            }
        except Exception:
            _LOG.debug("post-bash: git diff delta cache check failed", exc_info=True)

    # Stderr delta: when the same failing command is re-run and produces near-identical
    # stderr, show only lines that changed rather than re-emitting the full error blob.
    # - Identical stderr → single "N lines suppressed" advisory (avoids repeating noise).
    # - Small delta (< _STDERR_DELTA_SMALL total changed lines) → full stderr passes through.
    # - Large delta → summary header + first _STDERR_DELTA_MAX_PREVIEW new lines + resolved.
    # Only fires when: exit_code != 0, len(stderr) >= _STDERR_DELTA_MIN_BYTES, and the
    # same command was previously run with a non-zero exit code (prior stderr available).
    if exit_code not in (None, 0) and len(stderr) >= _STDERR_DELTA_MIN_BYTES and session_id:
        try:
            from . import bash_cache as _bc_sd
            _sd_prior_meta = _bc_sd.find_cached_for_command(display_cmd, cwd=cwd)
            if (
                _sd_prior_meta is not None
                and _sd_prior_meta.exit_code not in (None, 0)
                and _sd_prior_meta.stderr_bytes > 0
            ):
                _sd_prior_body = _bc_sd.load_output(_sd_prior_meta.output_id)
                if _sd_prior_body is not None:
                    # Extract stderr from the combined body.
                    # Format: "{stdout}\n--- stderr ---\n{stderr}" when both present,
                    # or bare stderr text when no stdout was captured.
                    _SD_SEP = "\n--- stderr ---\n"
                    if _SD_SEP in _sd_prior_body:
                        _sd_prior_stderr = _sd_prior_body.split(_SD_SEP, 1)[1]
                    else:
                        _sd_prior_stderr = _sd_prior_body
                    from collections import Counter as _Counter_sd
                    _sd_old_lines = _sd_prior_stderr.splitlines()
                    _sd_new_lines = stderr.splitlines()
                    _sd_old_cnt = _Counter_sd(_sd_old_lines)
                    _sd_new_cnt = _Counter_sd(_sd_new_lines)
                    # Multiset difference so repeated lines (repeated warnings from
                    # multiple files) are counted correctly — not collapsed by set ops.
                    _sd_added: list[str] = []
                    for _ln, _cnt in _sd_new_cnt.items():
                        _extra = _cnt - _sd_old_cnt.get(_ln, 0)
                        if _extra > 0:
                            _sd_added.extend([_ln] * _extra)
                    _sd_removed: list[str] = []
                    for _ln, _cnt in _sd_old_cnt.items():
                        _extra = _cnt - _sd_new_cnt.get(_ln, 0)
                        if _extra > 0:
                            _sd_removed.extend([_ln] * _extra)
                    _sd_delta_n = len(_sd_added) + len(_sd_removed)
                    # Persist current run before any early return so the NEXT
                    # comparison always sees the most recent stderr, not stale data.
                    with contextlib.suppress(Exception):
                        _sd_cur_meta = _bc_sd.store_output(
                            session_id, display_cmd, stdout, stderr, exit_code, cwd=cwd,
                        )
                        if _sd_cur_meta is not None:
                            _bc_sd.write_sidecar(_sd_cur_meta)
                    if _sd_delta_n == 0:
                        _LOG.info(
                            "post-bash: stderr identical; suppressing %d lines cmd=%.60s",
                            len(_sd_new_lines), display_cmd,
                        )
                        return {
                            "continue": True,
                            "systemMessage": (
                                f"[token-goat] stderr identical to prior run"
                                f" — {len(_sd_new_lines)} error lines suppressed"
                            ),
                        }
                    if _sd_delta_n < _STDERR_DELTA_SMALL:
                        pass  # small delta: full stderr passes through unchanged
                    else:
                        _sd_new_section = "\n".join(_sd_added[:_STDERR_DELTA_MAX_PREVIEW])
                        _sd_msg = (
                            f"[token-goat] stderr changed vs prior run:"
                            f" {len(_sd_added)} new lines, {len(_sd_removed)} resolved\n"
                            f"--- New error lines ---\n{_sd_new_section}"
                        )
                        if _sd_removed:
                            _sd_msg += f"\n({len(_sd_removed)} prior error line(s) resolved)"
                        _LOG.info(
                            "post-bash: stderr changed; delta cmd=%.60s added=%d resolved=%d",
                            display_cmd, len(_sd_added), len(_sd_removed),
                        )
                        return {
                            "continue": True,
                            "systemMessage": _sd_msg,
                        }
        except Exception:
            _LOG.debug("post-bash: stderr delta check failed", exc_info=True)

    # Binary output detection: if the output contains a high proportion of null
    # bytes it is almost certainly binary data (compiled artifact, compressed
    # stream, raw device read).  Skip caching entirely — binary blobs are not
    # useful context and could corrupt the session JSON.
    if _is_binary_output(stdout, stderr):
        _LOG.info(
            "post-bash: binary output detected; skipping cache (cmd=%.80s)",
            display_cmd,
        )
        return CONTINUE()

    # Repeated-command output dedup: when the same command produces byte-identical
    # stdout as its previous run in this session, suppress the duplicate and replace
    # it with a one-liner.  Saves context when agents re-run git status, npm test,
    # docker ps, etc. repeatedly without anything having changed.
    # Placed AFTER all specialised handlers so json/xml-compress, git-diff, etc.
    # always get first dibs.  On MATCH, calls mark_bash_run so run_count stays
    # accurate before returning early.  On NO MATCH, updates cmd_output_hashes
    # in-memory; the bash cache block below persists the session.
    if (
        _sess_mod is not None
        and _session_cache is not None
        and session_id
        and exit_code in (None, 0)
        and stdout
        and len(stdout) >= _CMD_DEDUP_MIN_BYTES
        # git diff commands use HEAD-SHA-keyed caching; identical raw content
        # with a different SHA is a legitimate cache miss, so let the
        # git-diff-delta handler own those commands exclusively.
        and not display_cmd.lstrip().startswith("git diff")
    ):
        try:
            _coh = _session_cache.cmd_output_hashes
            _new_hash = hashlib.sha256(stdout.encode()).hexdigest()
            _prev_hash = _coh.get(display_cmd)
            if _prev_hash is not None and _prev_hash == _new_hash:
                _n_lines = stdout.count("\n") + (1 if stdout and not stdout.endswith("\n") else 0)
                _LOG.info("post-bash: cmd-output dedup suppressed cmd=%.60s", display_cmd)
                _dedup_recall = ""
                try:
                    from . import bash_cache as _bc_dedup
                    _dedup_cmd_sha = _bc_dedup.command_hash(display_cmd, cwd)
                    _dedup_hist = _session_cache.bash_history.get(_dedup_cmd_sha)
                    if _dedup_hist and _dedup_hist.output_id:
                        _dedup_recall = f" (bash-output {_dedup_hist.output_id} to recall)"
                    if _dedup_hist:
                        _sess_mod.mark_bash_run(
                            session_id=session_id,
                            cmd_sha=_dedup_cmd_sha,
                            cmd_preview=display_cmd,
                            output_id=_dedup_hist.output_id,
                            stdout_bytes=len(_utf8_bytes(stdout)),
                            stderr_bytes=len(_utf8_bytes(stderr)),
                            exit_code=exit_code,
                            truncated=_dedup_hist.truncated,
                            output_sha=_dedup_hist.output_sha or "",
                            cache=_session_cache,
                        )
                except Exception:
                    _LOG.debug("post-bash: dedup mark_bash_run failed", exc_info=True)
                with contextlib.suppress(Exception):
                    _sess_mod.save(_session_cache)
                return {
                    "continue": True,
                    "systemMessage": (
                        f"[token-goat] output unchanged from previous run ({_n_lines} lines{_dedup_recall})"
                    ),
                }
            if len(_coh) >= _CMD_DEDUP_MAX_CMDS:
                del _coh[next(iter(_coh))]
            _coh[display_cmd] = _new_hash
            with contextlib.suppress(Exception):
                _sess_mod.save(_session_cache)
        except Exception:
            _LOG.debug("post-bash: cmd-output dedup check failed", exc_info=True)

    total_bytes = len(_utf8_bytes(stdout)) + len(_utf8_bytes(stderr))
    if total_bytes < _BASH_CACHE_MIN_BYTES:
        _LOG.debug(
            "post-bash: output too small to cache (%d bytes < %d threshold)",
            total_bytes, _BASH_CACHE_MIN_BYTES,
        )
        # Failed tiny commands are not cached to disk but we still record a
        # lightweight session entry so the compact manifest's "Current Blockers"
        # section can surface them.  A small "npm test" → "Error: missing dep"
        # output that is forgotten causes the agent to re-run the command
        # unnecessarily on the next turn.
        if exit_code not in (None, 0) and session_id and _sess_mod is not None:
            from . import bash_cache as _bc
            _cmd_sha = _bc.command_hash(display_cmd, cwd)
            # Inline snippet capped at 200 chars so the manifest line stays short.
            _snippet = (stdout + stderr)[:200].strip()
            _output_id = f"small:{_cmd_sha[:8]}:{int(exit_code)}"
            from . import cache_common as _cc
            _output_sha = _cc.short_content_hash(stdout + stderr)
            try:
                _sess_mod.mark_bash_run(
                    session_id=session_id,
                    cmd_sha=_cmd_sha,
                    cmd_preview=display_cmd,
                    output_id=_output_id,
                    stdout_bytes=len(_utf8_bytes(stdout)),
                    stderr_bytes=len(_utf8_bytes(stderr)),
                    exit_code=exit_code,
                    truncated=False,
                    output_sha=_output_sha,
                    cache=_session_cache,
                )
                _LOG.debug(
                    "post-bash: recorded failed small command exit=%s bytes=%d cmd=%.60s",
                    exit_code, total_bytes, display_cmd,
                )
            except (ValueError, OSError) as exc:
                _LOG.debug("post-bash: failed-small session record failed: %s", exc)
        return CONTINUE()
    if not session_id:
        _LOG.debug("post-bash: no session_id; output not cached")
        return CONTINUE()

    from . import bash_cache
    from . import config as _config
    assert _sess_mod is not None  # guaranteed: session_id truthy above implies _get_session() returned a module
    session = _sess_mod

    _bc_cfg = _config.load().bash_compress
    # Hash and preview the *original* command so reruns of the same logical
    # invocation (whether wrapped or not) collide on the same cache entry.
    meta = bash_cache.store_output(
        session_id, display_cmd, stdout, stderr, exit_code,
        cwd=cwd,
        max_total_bytes=_bc_cfg.cache_max_bytes,
        max_file_count=_bc_cfg.cache_max_file_count,
        min_cache_bytes=_bc_cfg.cache_min_bytes,
        max_cache_bytes=_bc_cfg.cache_max_bytes_per_output,
    )
    if meta is None:
        # Output was not cached due to size threshold (too small or too large).
        # Record a stat so we can see how often this happens.
        record_cached_stat("bash_output_too_small", sanitize_log_str(display_cmd, max_len=200), bytes_saved=0)
        return CONTINUE()
    bash_cache.write_sidecar(meta)

    # Compute content hash of post-compression output for content-aware dedup.
    from . import cache_common as _cc
    output_sha = _cc.short_content_hash(stdout + stderr)

    try:
        session.mark_bash_run(
            session_id=session_id,
            cmd_sha=meta.cmd_sha,
            cmd_preview=display_cmd,
            output_id=meta.output_id,
            stdout_bytes=meta.stdout_bytes,
            stderr_bytes=meta.stderr_bytes,
            exit_code=meta.exit_code,
            truncated=meta.truncated,
            output_sha=output_sha,
            cache=_session_cache,
        )
    except (ValueError, OSError) as exc:
        _LOG.debug("post-bash: session record failed: %s", exc)

    # Record bytes cached so the stats view reflects actual content stored.
    record_cached_stat("bash_output_cached", sanitize_log_str(display_cmd, max_len=200), bytes_saved=total_bytes)

    _LOG.info(
        "post-bash: cached output id=%s bytes=%d exit=%s truncated=%s",
        meta.output_id, total_bytes, exit_code, meta.truncated,
    )

    # Scoped-diff hint: when an unscoped git diff produces a large output and the session
    # has a small number of edited files, suggest the scoped form to cut token cost.
    if _session_cache is not None:
        try:
            from .bash_cache import is_unscoped_git_diff as _is_unscoped_git_diff
            from .hints import build_scoped_diff_hint as _build_scoped_diff_hint
            if _is_unscoped_git_diff(display_cmd):
                _diff_output_len = len(_utf8_bytes(stdout)) + len(_utf8_bytes(stderr))
                if _diff_output_len >= 4096:
                    _diff_edited = list(_session_cache.edited_files.keys())
                    if 1 <= len(_diff_edited) <= 10:
                        _diff_hint = _build_scoped_diff_hint(_diff_output_len, _diff_edited)
                        record_cached_stat("git_diff_scope_hint", sanitize_log_str(display_cmd, max_len=200))
                        _LOG.info("post-bash: git diff scope hint injected, output=%d bytes, edited=%d files", _diff_output_len, len(_diff_edited))
                        return continue_with_message(_diff_hint)
        except Exception:
            _LOG.debug("post-bash: git diff scope hint failed", exc_info=True)

    # pytest failure delta: compare current failures to prior run of the same command.
    # Returns a systemMessage so the agent sees the signal without re-reading the output.
    if _is_pytest_command(display_cmd) and _sess_mod is not None and _session_cache is not None:
        try:
            _curr = set(_extract_pytest_failure_ids(stdout + stderr))
            _prev = set(_session_cache.pytest_failures.get(meta.cmd_sha, []))
            _new_failures = sorted(_curr - _prev)
            _fixed = sorted(_prev - _curr)
            _session_cache.pytest_failures[meta.cmd_sha] = sorted(_curr)
            _session_cache._invalidate_json_cache()
            with contextlib.suppress(Exception):
                _sess_mod.save(_session_cache)
            if _prev and (_new_failures or _fixed):
                _parts: list[str] = []
                if _new_failures:
                    _shown = ", ".join(_new_failures[:5])
                    _more = f" (+{len(_new_failures) - 5} more)" if len(_new_failures) > 5 else ""
                    _parts.append(f"{len(_new_failures)} new: {_shown}{_more}")
                if _fixed:
                    _shown_f = ", ".join(_fixed[:5])
                    _more_f = f" (+{len(_fixed) - 5} more)" if len(_fixed) > 5 else ""
                    _parts.append(f"{len(_fixed)} fixed: {_shown_f}{_more_f}")
                _delta_msg = "pytest delta — " + "; ".join(_parts)
                return continue_with_message(_delta_msg)
        except Exception:
            _LOG.debug("post-bash: pytest delta failed", exc_info=True)

    # Auto-promote oversized unfiltered bash output: when the command has no
    # matching filter in bash_detect (it was not wrapped by the pre-Bash hook),
    # the model would otherwise see the full raw output verbatim.  For outputs
    # that were successfully cached and exceed the threshold, inject a truncated
    # preview + pointer so the model can skip re-reading what is already stored.
    #
    # Guard conditions (any failing → skip and fall through to CONTINUE):
    #   - bash_compress must be enabled (reuses existing on/off gate)
    #   - command must NOT have been wrapped (display_cmd == command means no wrap)
    #   - total output > _AUTO_PROMOTE_BYTES (8 KiB)
    #   - no filter match in bash_detect (unrecognised binary, not in the 227-entry table)
    #   - not a token-goat command itself (avoid self-referential loops)
    _AUTO_PROMOTE_BYTES = 8192
    _was_filtered = display_cmd != command
    if _bc_cfg.enabled and not _was_filtered and total_bytes > _AUTO_PROMOTE_BYTES:
        try:
            import shlex as _shlex

            from . import bash_detect as _bd
            try:
                _argv = _shlex.split(display_cmd, posix=True)
            except ValueError:
                _argv = []
            _filter_match = _bd.detect(_argv) if _argv else None
            _stem = Path(_argv[0].replace("\\", "/")).stem.lower() if _argv else ""
            _is_tg_cmd = _stem in ("token-goat", "token_goat", "tg")
            if _filter_match is None and not _is_tg_cmd:
                _combined = stdout.rstrip("\n") + ("\n" + stderr.rstrip("\n") if stderr.strip() else "")
                _lines = _combined.splitlines()
                _HEAD = 30
                _TAIL = 10
                if len(_lines) <= _HEAD + _TAIL:
                    _preview = "\n".join(_lines)
                else:
                    _omitted = len(_lines) - _HEAD - _TAIL
                    _preview = (
                        "\n".join(_lines[:_HEAD])
                        + f"\n... [{_omitted} lines omitted] ...\n"
                        + "\n".join(_lines[-_TAIL:])
                    )
                _short_cmd = display_cmd[:80] + ("..." if len(display_cmd) > 80 else "")
                _promote_msg = (
                    f"[token-goat] Large output from `{_short_cmd}` ({total_bytes:,} bytes)"
                    f" stored as bash-output {meta.output_id}.\n"
                    f"Preview (first {_HEAD} lines):\n"
                    f"{_preview}\n"
                    f"[{total_bytes:,} bytes total — retrieve full output:"
                    f" `token-goat bash-output {meta.output_id}`]"
                )
                record_cached_stat(
                    "bash_output_auto_promote",
                    sanitize_log_str(display_cmd, max_len=200),
                    bytes_saved=total_bytes,
                )
                _LOG.info(
                    "post-bash: auto-promote id=%s bytes=%d cmd=%.80s",
                    meta.output_id, total_bytes, display_cmd,
                )
                return continue_with_message(_promote_msg)
        except Exception:
            _LOG.debug("post-bash: auto-promote failed", exc_info=True)

    return CONTINUE()



def pre_screenshot(payload: HookPayload) -> HookResponse:
    """Deny MCP screenshot calls without a save-to-disk arg; force save so image-shrink applies."""
    import tempfile

    from . import config as _cfg_mod

    cfg = _cfg_mod.load().image_shrink
    if not cfg.screenshot_redirect:
        return CONTINUE()

    tool_input = get_tool_input(payload)
    # chrome-devtools uses "filePath"; playwright uses "filename"; accept all three.
    if tool_input.get("filePath") or tool_input.get("file_path") or tool_input.get("filename"):
        return CONTINUE()

    # Unique path per call — avoids concurrent-call overwrites.
    # Use TemporaryFile to get a secure path; we won't use the file handle, just the path.
    with tempfile.NamedTemporaryFile(suffix=".png", prefix="tg-screenshot-", delete=False) as tmp:
        tmp_path = tmp.name
    reason = "Screenshot result not saved — add the save-to-disk argument first."
    context = (
        "MCP screenshot tools return raw image bytes that bypass image-shrink and consume "
        "~39K tokens per call. Re-issue with the save argument set, then Read the path — "
        "the Read hook will compress it automatically.\n"
        "  chrome-devtools: add `\"filePath\": \"" + tmp_path + "\"` to this tool call\n"
        "  playwright:      add `\"filename\": \"" + tmp_path + "\"` to this tool call\n"
        f"  then `Read({{\"file_path\": \"{tmp_path}\"}})`."
    )
    return deny_redirect(reason, context)
