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

__all__ = ["post_read", "pre_read"]

import os
from pathlib import Path

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    get_tool_input,
    pre_tool_use_with_context,
    pre_tool_use_with_update,
    sanitize_log_str,
    sanitize_opt,
)
from .hooks_common import (
    LOG as _LOG,
)

# Environment variable that disables Bash output compression at the hook layer.
# Recognised values: "0", "false", "no", "off" (case-insensitive).  Any other
# value (including unset) leaves compression enabled.  Matches the pattern used
# by compact_assist for consistency.
_ENV_BASH_COMPRESS = "TOKEN_GOAT_BASH_COMPRESS"


def _bash_compress_enabled() -> bool:
    """Return False when the user has explicitly disabled bash output compression.

    Defaults to True so the feature is opt-out: new installs benefit
    immediately, and an opt-out path is available for users who want the
    raw output (e.g. debugging a filter that strips too much).
    """
    val = os.environ.get(_ENV_BASH_COMPRESS, "").strip().lower()
    return val not in ("0", "false", "no", "off")


def _handle_bash_compress(payload: HookPayload) -> HookResponse | None:
    """Rewrite compressible Bash commands to flow through ``token-goat compress``.

    When the agent issues a Bash tool call whose first binary is one of the
    recognised noisy tools (``pytest``, ``npm install``, ``docker build``,
    ``git log``, ``cargo build``, ``kubectl get``, ...), we intercept the
    command and rewrite it to::

        token-goat compress --filter <name> --cmd '<original>'

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

    from . import bash_compress  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415
    from . import paths as paths_mod  # noqa: PLC0415

    cfg = config_mod.load().bash_compress
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

    detected = bash_compress.detect_from_command(cmd)
    if detected is None:
        return None
    filter_, _argv = detected

    if filter_.name in cfg.disabled_filters:
        _LOG.debug("bash_compress: filter %s disabled by config; skipping", filter_.name)
        return None

    # Build the wrapper invocation.  paths.python_runner_command gives us the
    # exact ``pythonw -m token_goat.cli`` form already used by the hook
    # entries, so the rewritten command works in any environment where the
    # hooks themselves work.
    wrapper = paths_mod.python_runner_command(
        "compress",
        "--filter", filter_.name,
        "--timeout", str(cfg.timeout_seconds),
        "--cmd", cmd,
    )
    rewritten_input: dict[str, object] = dict(tool_input)
    rewritten_input["command"] = wrapper
    _LOG.info(
        "bash_compress: wrapping command with %s filter (orig=%s)",
        filter_.name,
        sanitize_log_str(cmd, max_len=200),
    )
    return pre_tool_use_with_update(
        rewritten_input,
        (
            f"Note: command auto-wrapped by token-goat ({filter_.name} filter) "
            "to compress its output before it lands in context. "
            "Set TOKEN_GOAT_BASH_COMPRESS=0 to disable."
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
    from . import bash_parser  # noqa: PLC0415

    tool_input = get_tool_input(payload)
    cmd = tool_input.get("command", "")
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
        if intent.reason:
            _LOG.info("bash read near-miss: %s", sanitize_log_str(intent.reason))
        return None

    read_payload = dict(payload)
    read_payload["tool_name"] = "Read"
    read_payload["tool_input"] = {
        "file_path": intent.target_path,
        "offset": intent.offset,
        "limit": intent.limit,
    }
    return read_payload


def _try_shrink_image(
    file_path: str, tool_input: dict[str, object]
) -> HookResponse | None:
    """Attempt image shrinking and return hook-formatted response if successful.

    Compresses image files (PNG, JPEG, WebP, etc.) using cached shrinking, records
    token/byte savings to the stats DB, and returns a hook response that redirects
    the Read call to the shrunk copy. Non-image files are silently passed through as None.

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
    from . import db, image_shrink  # noqa: PLC0415

    if not image_shrink.is_image_path(file_path):
        return None

    try:
        shrunken = image_shrink.shrink(Path(file_path))
        if shrunken is None:
            return None

        img_stats = image_shrink.stats_for(Path(file_path), shrunken)
        tokens_saved = max(0,
            image_shrink.vision_tokens(img_stats["orig_width"], img_stats["orig_height"])
            - image_shrink.vision_tokens(img_stats["out_width"], img_stats["out_height"])
        )
        db.record_stat(
            None,
            "image_shrink",
            bytes_saved=img_stats["bytes_saved"],
            tokens_saved=tokens_saved,
            # Sanitize file_path before storing: it comes from the harness payload
            # and could contain newlines that corrupt multi-line DB detail queries.
            detail=f"{sanitize_log_str(file_path)} -> {shrunken.name}",
        )

        shrink_response = dict(tool_input)
        shrink_response["file_path"] = str(shrunken)
        return pre_tool_use_with_update(
            shrink_response,
            (
                f"Note: image auto-shrunk by token-goat "
                f"({img_stats['src_bytes']:,} → {img_stats['out_bytes']:,} bytes, "
                f"~{img_stats['bytes_saved']:,} bytes saved). "
                f"Original: {file_path}"
            ),
        )
    except Exception:  # noqa: BLE001
        _LOG.exception("image-shrink failed during pre-read")
        return None


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
    from . import db  # noqa: PLC0415
    from .hints import CHARS_PER_TOKEN  # noqa: PLC0415

    realized_tokens = getattr(hint, "tokens_saved", 0)
    injection_cost_tokens = max(1, int(len(hint) / CHARS_PER_TOKEN))
    realized_bytes = realized_tokens * 4  # project convention: ~4 bytes/token
    injection_bytes = len(hint)

    safe_path = sanitize_log_str(file_path, max_len=512)
    db.record_stat(
        None,
        "session_hint",
        bytes_saved=realized_bytes,
        tokens_saved=realized_tokens,
        detail=safe_path,
    )
    db.record_stat(
        None,
        "session_hint_overhead",
        bytes_saved=-injection_bytes,
        tokens_saved=-injection_cost_tokens,
        detail=safe_path,
    )


def pre_read(payload: HookPayload) -> HookResponse:
    """Pre-read hook: image shrinking and session-cache hints.

    Dispatches based on tool_name:
    - Bash: Convert read-equivalent commands (cat, head, etc.) to Read, then recurse.
    - Read: Attempt image shrinking, then emit session hints (if cached or large-file candidate).
    - Other: Pass through unchanged (CONTINUE).

    Returns hook response dict with optional updatedInput (image shrinking) or
    additionalContext (hint text).
    """
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")

    if tool_name == "Bash":
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

    if tool_name != "Read":
        _LOG.debug("pre-read: skipping non-Read tool %s", sanitize_opt(tool_name))
        return CONTINUE()

    tool_input = get_tool_input(payload)
    file_path = tool_input.get("file_path")
    if not file_path:
        _LOG.debug("pre-read: no file_path in tool_input; skipping")
        return CONTINUE()

    session_id, cwd = get_session_context(payload)

    shrink_response = _try_shrink_image(file_path, tool_input)
    if shrink_response:
        return shrink_response

    if not session_id:
        _LOG.debug("pre-read: no session_id; skipping hint for %s", sanitize_log_str(file_path))
        return CONTINUE()

    from . import session  # noqa: PLC0415

    cache = session.load(session_id)

    hint = build_read_hint(
        session_id=session_id,
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
        cwd=cwd,
        cache=cache,
    )
    if not hint:
        _LOG.debug("pre-read: no hint for %s", sanitize_log_str(file_path))
        return CONTINUE()

    if hint.tokens_saved > 0:
        _LOG.debug(
            "pre-read: hint injected for %s (tokens_saved=%d)",
            sanitize_log_str(file_path), hint.tokens_saved,
        )
        _record_session_hint_impact(file_path, hint)
    else:
        _LOG.debug("pre-read: hint built for %s but tokens_saved=0; no stat recorded", sanitize_log_str(file_path))

    return pre_tool_use_with_context(str(hint))


def post_read(payload: HookPayload) -> HookResponse:
    """Post-read hook: record file/symbol accesses to session cache.

    Logs Read, Grep, and Glob operations into the persistent session cache so that
    subsequent reads can detect overlaps and re-read attempts, enabling session hints
    on follow-up file accesses in the same session.

    Returns CONTINUE() after recording; never modifies tool input/output.
    """
    session_id, _cwd = get_session_context(payload)
    if not session_id:
        return CONTINUE()

    from . import session  # noqa: PLC0415

    cache = session.load(session_id)

    tool_name = payload.get("tool_name")
    tool_input = get_tool_input(payload)

    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        if file_path:
            offset = tool_input.get("offset")
            limit = tool_input.get("limit")
            session.mark_file_read(session_id, file_path, offset, limit, cache=cache)
            _LOG.debug(
                "post-read: recorded Read file=%s offset=%s limit=%s",
                sanitize_log_str(file_path), offset, limit,
            )
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        raw_result_count = payload.get("result_count")
        # Validate result_count: it arrives as raw Any from the harness payload.
        # Accept only plain ints (not bool subclass); clamp to [0, _MAX_RESULT_COUNT]
        # so a crafted payload cannot store an absurd integer in the session JSON.
        result_count: int | None = None
        if isinstance(raw_result_count, int) and not isinstance(raw_result_count, bool):
            result_count = max(0, min(raw_result_count, session._MAX_RESULT_COUNT))
        if pattern:
            session.mark_grep(session_id, pattern, path, result_count, cache=cache)
            _LOG.debug(
                "post-read: recorded Grep pattern=%s path=%s result_count=%s",
                sanitize_opt(pattern), sanitize_opt(path), result_count,
            )
    elif tool_name == "Glob":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        # Sanitize user-controlled strings before logging to prevent log injection
        # via embedded newlines that would forge additional log records.
        _LOG.debug("post-read: Glob pattern=%s path=%s", sanitize_opt(pattern), sanitize_opt(path))

    return CONTINUE()
