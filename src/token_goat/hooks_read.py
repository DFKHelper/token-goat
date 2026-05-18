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

__all__ = ["post_bash", "post_read", "pre_read"]

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
    from . import session, snapshots  # noqa: PLC0415

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


def _try_diff_hint(
    session_id: str, file_path: str
) -> HookResponse | None:
    """Return a diff-hint hook response when one applies, otherwise ``None``.

    Loads *file_path* from disk so the diff builder can compare against the
    stored session snapshot.  Skips files that cannot be read or that exceed
    the snapshot size cap (the snapshot would be missing in that case anyway).

    Records the realized saving as a ``diff_hint`` stat row plus a
    ``diff_hint_overhead`` row covering the hint's own injection cost — same
    honest-accounting pattern used by the session_hint path.
    """
    from . import db, snapshots  # noqa: PLC0415
    from .hints import build_diff_hint  # noqa: PLC0415

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

    safe_path = sanitize_log_str(file_path, max_len=512)
    realized_tokens = hint.tokens_saved
    realized_bytes = realized_tokens * 4
    injection_bytes = len(hint)
    from .hints import CHARS_PER_TOKEN  # noqa: PLC0415
    injection_cost_tokens = max(1, int(injection_bytes / CHARS_PER_TOKEN))
    db.record_stat(
        None, "diff_hint",
        bytes_saved=realized_bytes, tokens_saved=realized_tokens, detail=safe_path,
    )
    db.record_stat(
        None, "diff_hint_overhead",
        bytes_saved=-injection_bytes, tokens_saved=-injection_cost_tokens, detail=safe_path,
    )
    _LOG.info(
        "pre-read: diff-hint injected for %s (tokens_saved=%d)",
        sanitize_log_str(file_path), realized_tokens,
    )
    return pre_tool_use_with_context(str(hint))


def _handle_bash_dedup(payload: HookPayload) -> HookResponse | None:
    """Return a dedup hint when this exact Bash command ran earlier in the session.

    Looks up the command's content hash in :attr:`session.SessionCache.bash_history`;
    on a hit, suggests retrieving the cached output via ``token-goat bash-output``
    rather than re-running.  Returns ``None`` to let the hook fall through to
    the normal bash-as-read handling when no dedup hit is available.
    """
    from . import db, session  # noqa: PLC0415
    from .hints import CHARS_PER_TOKEN, build_bash_dedup_hint  # noqa: PLC0415

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        return None

    tool_input = get_tool_input(payload)
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return None

    try:
        cache = session.load(session_id)
    except (OSError, ValueError):
        return None

    hint = build_bash_dedup_hint(
        session_id=session_id, command=command, cache=cache,
    )
    if hint is None:
        return None

    realized_tokens = hint.tokens_saved
    injection_bytes = len(hint)
    injection_cost_tokens = max(1, int(injection_bytes / CHARS_PER_TOKEN))
    db.record_stat(
        None, "bash_dedup_hint",
        bytes_saved=realized_tokens * 4, tokens_saved=realized_tokens,
        detail=sanitize_log_str(command, max_len=200),
    )
    db.record_stat(
        None, "bash_dedup_hint_overhead",
        bytes_saved=-injection_bytes, tokens_saved=-injection_cost_tokens,
        detail=sanitize_log_str(command, max_len=200),
    )
    _LOG.info(
        "pre-read: bash-dedup hint injected (tokens_saved=%d)", realized_tokens,
    )
    return pre_tool_use_with_context(str(hint))


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
    """
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")

    if tool_name == "Bash":
        # Step 1: detect duplicate Bash command from this session.  This must
        # happen *before* the read-equivalent dispatch because re-running
        # `cat file.py` after editing should pull the cached output rather
        # than re-dispatching through the Read pipeline.
        dedup = _handle_bash_dedup(payload)
        if dedup is not None:
            return dedup

        read_payload = _handle_bash_read_equivalent(payload)
        if read_payload:
            # Recurse once with a synthesized Read payload so image-shrink and
            # session-hint logic runs identically to a native Read call.
            # Depth is bounded at 1: _handle_bash_read_equivalent returns None
            # for any payload whose tool_name is not 'Bash', so the recursive
            # call always reaches the tool_name != "Read" branch at worst.
            return pre_read(read_payload)
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

    # Diff-aware path: file was read AND edited in this session AND we have
    # a snapshot to compare against.  When applicable, the diff hint replaces
    # the standard cache hint — both communicate the same idea (you've seen
    # this file before) but the diff carries the actually-changed bytes.
    entry = cache.files.get(session._normalize_path(file_path))  # type: ignore[attr-defined]
    if entry is not None and entry.last_edit_ts > entry.last_read_ts:
        diff_response = _try_diff_hint(session_id, file_path)
        if diff_response is not None:
            return diff_response

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
            # Capture a content snapshot so a future re-read after an edit can
            # be served as a small unified diff instead of a full-file Read.
            # Best-effort — snapshot failures never block the hook.
            _try_snapshot(session_id, file_path, cache=cache)
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


# ---------------------------------------------------------------------------
# post_bash — record Bash output to the on-disk cache + session history
# ---------------------------------------------------------------------------


# Bash outputs smaller than this are not worth caching to disk: the dedup hint
# would suppress on size anyway, and the disk + JSON churn outweighs the
# savings.  Aligned with the dedup minimum so we never cache something we
# would later refuse to surface.
_BASH_CACHE_MIN_BYTES: int = 400


def _extract_bash_response(payload: HookPayload) -> tuple[str, str, int | None]:
    """Pull (stdout, stderr, exit_code) from a PostToolUse Bash payload.

    Defensive against payload shape drift between harness versions: each field
    is read at multiple plausible keys and falls back to empty/None when absent.
    Non-string stdout/stderr is coerced via :func:`str` so a future change to
    structured output (e.g. JSON tool result) does not crash the hook.
    """
    raw_resp = payload.get("tool_response") or payload.get("tool_result") or {}
    if not isinstance(raw_resp, dict):
        return "", "", None
    stdout_val = raw_resp.get("stdout") or raw_resp.get("output") or ""
    stderr_val = raw_resp.get("stderr") or ""
    exit_val = raw_resp.get("exit_code")
    if exit_val is None:
        exit_val = raw_resp.get("returncode")
    stdout = stdout_val if isinstance(stdout_val, str) else str(stdout_val)
    stderr = stderr_val if isinstance(stderr_val, str) else str(stderr_val)
    exit_code: int | None = None
    if isinstance(exit_val, int) and not isinstance(exit_val, bool):
        exit_code = exit_val
    return stdout, stderr, exit_code


def post_bash(payload: HookPayload) -> HookResponse:
    """Post-Bash hook: persist large outputs to disk and record in session history.

    For every PostToolUse(Bash) invocation we:

    1. Extract stdout/stderr/exit_code from ``tool_response``.
    2. If the combined output is large enough to be worth caching
       (``_BASH_CACHE_MIN_BYTES``), write it to the on-disk bash cache and
       record a :class:`BashEntry` in the session so a future ``pre_read`` can
       dedupe a repeat invocation.
    3. Always return CONTINUE — this hook never blocks, never modifies output.

    Failures at any step are logged at debug and the hook still returns
    CONTINUE so a transient I/O issue cannot interrupt the agent.
    """
    session_id, _cwd = get_session_context(payload)
    tool_input = get_tool_input(payload)
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return CONTINUE()

    stdout, stderr, exit_code = _extract_bash_response(payload)
    total_bytes = len(stdout.encode("utf-8", errors="replace")) + len(
        stderr.encode("utf-8", errors="replace")
    )
    if total_bytes < _BASH_CACHE_MIN_BYTES:
        _LOG.debug(
            "post-bash: output too small to cache (%d bytes < %d threshold)",
            total_bytes, _BASH_CACHE_MIN_BYTES,
        )
        return CONTINUE()
    if not session_id:
        _LOG.debug("post-bash: no session_id; output not cached")
        return CONTINUE()

    from . import bash_cache, db, session  # noqa: PLC0415

    meta = bash_cache.store_output(
        session_id, command, stdout, stderr, exit_code,
    )
    if meta is None:
        return CONTINUE()
    bash_cache.write_sidecar(meta)

    try:
        session.mark_bash_run(
            session_id=session_id,
            cmd_sha=meta.cmd_sha,
            cmd_preview=command,
            output_id=meta.output_id,
            stdout_bytes=meta.stdout_bytes,
            stderr_bytes=meta.stderr_bytes,
            exit_code=meta.exit_code,
            truncated=meta.truncated,
        )
    except (ValueError, OSError) as exc:
        _LOG.debug("post-bash: session record failed: %s", exc)

    # Record a stat row for observability.  We do NOT claim a saving here:
    # the saving is realized when (and if) the agent later avoids a re-run.
    # The "bash_output_cached" kind is informational only — stats.py groups
    # it under a non-saving bucket so it never inflates the headline number.
    try:
        db.record_stat(
            None, "bash_output_cached",
            bytes_saved=0, tokens_saved=0,
            detail=sanitize_log_str(command, max_len=200),
        )
    except Exception:  # noqa: BLE001 — stat logging is best-effort
        _LOG.debug("post-bash: stat record failed", exc_info=True)

    _LOG.info(
        "post-bash: cached output id=%s bytes=%d exit=%s truncated=%s",
        meta.output_id, total_bytes, exit_code, meta.truncated,
    )
    return CONTINUE()
