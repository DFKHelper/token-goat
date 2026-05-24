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
    is_real_int,
    pre_tool_use_with_context,
    pre_tool_use_with_update,
    record_cached_stat,
    record_hint_stat_pair,
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
    import os  # noqa: PLC0415 — lazy: only the Bash hook path reads this env var

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
    from . import db, image_shrink  # noqa: PLC0415

    if not image_shrink.is_image_path(file_path):
        return None

    try:
        src_path = Path(file_path)
        shrunken = image_shrink.shrink(src_path)
        if shrunken is None:
            return None
        # Compute alt-text summary by reopening the shrunken file — keeps
        # shrink()'s return signature simple (Path|None) for the dozens of
        # callers and tests that monkeypatch it. Fail-soft: empty summary
        # on PIL/IO error so the redirect still fires.
        img_summary = ""
        try:
            from PIL import Image as _PILImage  # noqa: PLC0415

            with _PILImage.open(shrunken) as _img:
                img_summary = image_shrink.extract_image_summary(src_path, _img)
        except Exception:  # noqa: BLE001
            pass

        # Detect cache hit: if shrunken path is in the image cache directory and
        # matches the expected content-hash stem, it was served from cache (zero CPU cost).
        # Fresh shrinks also end up in cache, but we differentiate by checking the
        # timing: if the file already existed before shrink() was called, it's a hit.
        is_cache_hit = False
        try:
            stem = image_shrink._cache_path_for(src_path)
            # Cache hit means the shrunken path matches the cache stem pattern.
            if shrunken.parent == stem.parent and shrunken.stem == stem.stem:
                is_cache_hit = True
        except Exception:  # noqa: BLE001
            # Safe to ignore; we just won't differentiate cache hits from fresh shrinks.
            pass

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
        note = (
            f"Note: image auto-shrunk by token-goat "
            f"({img_stats['src_bytes']:,} → {img_stats['out_bytes']:,} bytes, "
            f"~{img_stats['bytes_saved']:,} bytes saved). "
            f"Original: {file_path}"
        )
        if img_summary:
            note = f"{note}\n{img_summary}"
        return pre_tool_use_with_update(shrink_response, note)
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


def _build_git_hint(cwd: str | None, file_path: str) -> str | None:
    """Return a compact git-history hint for *file_path*, or None on any failure.

    Looks up the per-project git commit index for recent commits touching the
    file and formats them as a short bullet list.  Fail-soft: any exception
    (missing index, git absent, non-project file) returns None silently.
    """
    try:
        from . import git_history  # noqa: PLC0415
        from .hooks_common import validate_cwd  # noqa: PLC0415
        from .project import find_project  # noqa: PLC0415

        cwd_path = validate_cwd(cwd, caller="pre-read-git-hint")
        if cwd_path is None:
            return None
        proj = find_project(cwd_path)
        if proj is None:
            return None
        try:
            abs_file = Path(file_path) if Path(file_path).is_absolute() else (cwd_path / file_path)
            rel_path = abs_file.relative_to(proj.root).as_posix()
        except ValueError:
            return None
        return git_history.build_hint(proj.hash, rel_path)
    except Exception:  # noqa: BLE001
        return None


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
    from .hints import _hint_fingerprint, build_index_only_file_hint  # noqa: PLC0415

    offset = tool_input.get("offset")
    limit = tool_input.get("limit")

    hint = build_index_only_file_hint(
        file_path=file_path,
        offset=offset,
        limit=limit,
    )
    if hint is None:
        return None

    # Dedup: suppress if identical hint already seen this session for this path.
    fingerprint = _hint_fingerprint(str(hint), path=file_path)
    has_seen = getattr(cache, "has_hint_fingerprint", lambda _: False)(fingerprint)  # type: ignore[arg-type]
    if has_seen:
        _LOG.debug(
            "pre-read: index-only hint already seen for %s; suppressing",
            sanitize_log_str(file_path),
        )
        return None

    # Budget: hard cap on index-only hints per session.
    from . import session as _session  # noqa: PLC0415
    from .hints import (  # noqa: PLC0415
        _HINT_KIND_INDEX_ONLY,
        _hint_budget_check,
        _record_index_only_hint_emitted,
    )
    if isinstance(cache, _session.SessionCache) and not _hint_budget_check(cache, _HINT_KIND_INDEX_ONLY):
        _LOG.debug("pre-read: index-only hint budget exhausted for %s", sanitize_log_str(file_path))
        return None

    mark_seen = getattr(cache, "mark_hint_seen", None)
    if callable(mark_seen):
        mark_seen(fingerprint)

    if isinstance(cache, _session.SessionCache):
        _record_index_only_hint_emitted(cache)

    record_hint_stat_pair("index_only_hint", hint, sanitize_log_str(file_path, max_len=512))
    _LOG.info(
        "pre-read: index-only hint injected for %s (%s)",
        sanitize_log_str(file_path), str(hint)[:60],
    )
    return pre_tool_use_with_context(str(hint))


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
    from .hints import _hint_fingerprint, build_structured_file_hint  # noqa: PLC0415

    offset = tool_input.get("offset")
    limit = tool_input.get("limit")

    hint = build_structured_file_hint(
        file_path=file_path,
        offset=offset,
        limit=limit,
    )
    if hint is None:
        return None

    # Dedup: suppress if identical hint already seen this session for this path.
    fingerprint = _hint_fingerprint(str(hint), path=file_path)
    has_seen = getattr(cache, "has_hint_fingerprint", lambda _: False)(fingerprint)  # type: ignore[arg-type]
    if has_seen:
        _LOG.debug(
            "pre-read: structured-file hint already seen for %s; suppressing",
            sanitize_log_str(file_path),
        )
        return None

    # Budget: hard cap on structured-file hints per session.
    from . import session as _session  # noqa: PLC0415
    from .hints import (  # noqa: PLC0415
        _HINT_KIND_STRUCTURED,
        _hint_budget_check,
        _record_structured_hint_emitted,
    )
    if isinstance(cache, _session.SessionCache) and not _hint_budget_check(cache, _HINT_KIND_STRUCTURED):
        _LOG.debug("pre-read: structured-file hint budget exhausted for %s", sanitize_log_str(file_path))
        return None

    mark_seen = getattr(cache, "mark_hint_seen", None)
    if callable(mark_seen):
        mark_seen(fingerprint)

    if isinstance(cache, _session.SessionCache):
        _record_structured_hint_emitted(cache)

    record_hint_stat_pair("structured_file_hint", hint, sanitize_log_str(file_path, max_len=512))
    _LOG.info(
        "pre-read: structured-file hint injected for %s (%s)",
        sanitize_log_str(file_path), hint[:60],
    )
    return pre_tool_use_with_context(str(hint))


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
    from .hints import build_unchanged_file_hint  # noqa: PLC0415

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
    from . import snapshots  # noqa: PLC0415
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

    record_hint_stat_pair("diff_hint", hint, sanitize_log_str(file_path, max_len=512))
    _LOG.info(
        "pre-read: diff-hint injected for %s (tokens_saved=%d)",
        sanitize_log_str(file_path), hint.tokens_saved,
    )
    return pre_tool_use_with_context(str(hint))


def _handle_grep_dedup(payload: HookPayload) -> HookResponse | None:
    """Return a dedup hint when the same Grep pattern just ran in this session.

    Mirrors :func:`_handle_bash_dedup` for the Grep tool surface.  Returns
    ``None`` to let the hook fall through to ``CONTINUE`` when no dedup
    hit is available — we never deny a Grep call, only suggest the agent
    reuse the prior result.
    """
    from .hints import build_grep_dedup_hint  # noqa: PLC0415
    from .hooks_common import run_dedup_hint  # noqa: PLC0415

    tool_input = get_tool_input(payload)
    pattern = tool_input.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return None
    path = tool_input.get("path")
    if path is not None and not isinstance(path, str):
        path = None

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_grep_dedup_hint(
            session_id=sid, pattern=pattern, path=path, cache=cache,
        ),
        stat_kind="grep_dedup_hint",
        detail=sanitize_log_str(pattern, max_len=200),
        log_label="pre-read",
    )


def _handle_grep_written_not_read(payload: HookPayload) -> HookResponse | None:
    """Hint when Grep targets a single file written this session but not yet read back.

    When ``path`` resolves to a file that was written (Edit/Write/MultiEdit)
    this session and has never been read back, the content the agent wrote may
    still be visible in context from the Write/Edit tool result — making a Grep
    redundant.  Only fires when ``path`` is a specific file (not a directory);
    directory-scoped Greps are let through without a hint.
    """
    from . import session  # noqa: PLC0415

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        return None

    tool_input = get_tool_input(payload)
    path = tool_input.get("path")
    if not isinstance(path, str) or not path:
        return None

    try:
        cache = session.load(session_id)
    except (OSError, ValueError):
        return None

    _written_key = session._normalize_path(path)  # type: ignore[attr-defined]
    _edited: dict[str, int] = cache.edited_files if isinstance(cache.edited_files, dict) else {}
    _edit_count = _edited.get(_written_key, 0)
    if _edit_count < 1 or _written_key in cache.files:
        return None

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
    from .hints import STALE_READ_AGE_SECONDS, build_glob_dedup_hint  # noqa: PLC0415
    from .hooks_common import run_dedup_hint  # noqa: PLC0415

    tool_input = get_tool_input(payload)
    pattern = tool_input.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return None
    path = tool_input.get("path")
    if path is not None and not isinstance(path, str):
        path = None

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        return None

    # Check for a cached result in bash_cache (item 19).
    # Only serve the cached result when the glob entry is in the session history
    # AND is recent enough (within STALE_READ_AGE_SECONDS).
    try:
        from . import bash_cache as _bc  # noqa: PLC0415
        from . import session as _sess  # noqa: PLC0415

        cache = _sess.load(session_id)
        # Find the most recent GlobEntry for this (pattern, path).
        glob_entry = _sess.lookup_glob_entry(session_id, pattern, path, cache=cache)
        if glob_entry is not None:
            import time as _time  # noqa: PLC0415
            age = _time.time() - glob_entry.ts
            if age <= STALE_READ_AGE_SECONDS:
                cached_result = _bc.load_glob_result(session_id, pattern, path)
                if cached_result is not None:
                    path_label = f" in {path!r}" if path else ""
                    hint_text = (
                        f"Note: Glob `{sanitize_log_str(pattern, max_len=100)}`{path_label} "
                        f"ran {int(age)}s ago — cached result ({glob_entry.result_count or '?'} paths):\n"
                        f"{cached_result}\n"
                        "(Serving from cache. Run without hints to force a fresh scan.)"
                    )
                    from .hooks_common import record_cached_stat  # noqa: PLC0415
                    record_cached_stat("glob_result_cache_hit", sanitize_log_str(pattern, max_len=200))
                    _LOG.info(
                        "pre-read: glob result cache hit for pattern=%s (age=%ds)",
                        sanitize_log_str(pattern, max_len=100), int(age),
                    )
                    return pre_tool_use_with_context(hint_text)
    except Exception:  # noqa: BLE001
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


def _handle_bash_dedup(payload: HookPayload) -> HookResponse | None:
    """Return a dedup hint when this exact Bash command ran earlier in the session.

    Looks up the command's content hash in :attr:`session.SessionCache.bash_history`;
    on a hit, suggests retrieving the cached output via ``token-goat bash-output``
    rather than re-running.  Returns ``None`` to let the hook fall through to
    the normal bash-as-read handling when no dedup hit is available.
    """
    from .hints import build_bash_dedup_hint  # noqa: PLC0415
    from .hooks_common import run_dedup_hint  # noqa: PLC0415

    tool_input = get_tool_input(payload)
    command = tool_input.get("command")
    if not isinstance(command, str) or not command:
        return None

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_bash_dedup_hint(
            session_id=sid, command=command, cache=cache,
        ),
        stat_kind="bash_dedup_hint",
        detail=sanitize_log_str(command, max_len=200),
        log_label="pre-read",
    )


def _check_recovery_pending(session_id: str, cache: object) -> str | None:
    """Return the deferred recovery hint text and consume the sidecar, or None.

    Called once per session on the first pre-read (Read or Bash) after a
    compaction event.  The sidecar ``sentinels/recovery_pending_{session_id}``
    is written by the SessionStart handler when ``source == "compact"``.  On
    first hit we read the payload, delete the sidecar, and mark the session so
    subsequent calls in the same process skip the disk check.

    Fail-soft: any I/O error returns None so a missing or unreadable sidecar
    never blocks the hook.
    """
    # Fast path: already injected in this process (in-memory flag).
    if getattr(cache, "recovery_injected", False):
        return None
    try:
        from . import paths as _paths  # noqa: PLC0415

        sidecar = _paths.recovery_pending_path(session_id)
        if not sidecar.exists():
            return None
        hint = sidecar.read_text(encoding="utf-8")
        sidecar.unlink(missing_ok=True)
        # Mark in-process so we don't re-check on subsequent calls.
        try:  # noqa: SIM105
            cache.recovery_injected = True  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            pass
        _LOG.info(
            "pre-read: deferred recovery hint injected for session=%s (%d chars)",
            session_id[:16], len(hint),
        )
        # Record injection overhead now that the hint is actually being used.
        try:
            from . import db as _db  # noqa: PLC0415
            from .hooks_common import bytes_to_tokens  # noqa: PLC0415

            injection_bytes = len(hint.encode("utf-8"))
            _db.record_stat(
                None,
                "compact_recovery_overhead",
                bytes_saved=-injection_bytes,
                tokens_saved=-bytes_to_tokens(injection_bytes),
                detail=session_id[:32],
            )
        except Exception:  # noqa: BLE001
            pass
        return hint
    except Exception:  # noqa: BLE001
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
    try:
        if getattr(cache, "_pending_hint_save", False):
            cache._pending_hint_save = False  # type: ignore[union-attr]
            from . import session as _sess  # noqa: PLC0415
            _sess.save(cache)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        pass


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
        # Deferred recovery hint: inject on the first Bash call after compaction
        # if a recovery sidecar exists.  We need a session_id for this so pull
        # it early; if unavailable, fall through without the recovery check.
        _bash_session_id, _bash_cwd = get_session_context(payload)
        if _bash_session_id:
            from . import session as _sess_mod  # noqa: PLC0415
            _bash_cache = _sess_mod.load(_bash_session_id)
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
        dedup = _handle_grep_dedup(payload)
        if dedup is not None:
            return dedup
        written = _handle_grep_written_not_read(payload)
        if written is not None:
            return written
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

    session_id, cwd = get_session_context(payload)

    shrink_response = _try_shrink_image(file_path, tool_input)
    if shrink_response:
        return shrink_response

    if not session_id:
        _LOG.debug("pre-read: no session_id; skipping hint for %s", sanitize_log_str(file_path))
        return CONTINUE()

    from . import session  # noqa: PLC0415

    cache = session.load(session_id)

    # Deferred recovery hint: inject on the first Read after compaction.
    # This fires before all other hints so the recovery context is the first
    # additionalContext the agent receives in its new post-compact window.
    _recovery_text = _check_recovery_pending(session_id, cache)
    if _recovery_text:
        return pre_tool_use_with_context(_recovery_text)

    # Index-only file hint: fires first so machine-generated lockfiles and bundles
    # (uv.lock, package-lock.json, *.min.js, *.map, …) are intercepted before any
    # other hint logic runs.  These files are never worth reading in full and the
    # hint saves thousands of tokens per avoided read.
    index_only_response = _handle_index_only_file(session_id, file_path, tool_input, cache)
    if index_only_response is not None:
        _flush_pending_hint_save(cache)
        return index_only_response

    # Structured-file hint: fires before session/diff hints so a first-time read
    # of a large CSV/JSON/log is intercepted immediately.  Short-circuits when
    # the caller already uses offset+limit (surgical intent) or the file is small.
    structured_response = _handle_structured_file(session_id, file_path, tool_input, cache)
    if structured_response is not None:
        _flush_pending_hint_save(cache)
        return structured_response

    # Collect context parts from all hint sources; combine and return once.
    context_parts: list[str] = []

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

    # Diff-aware path: file was read AND edited in this session AND we have
    # a snapshot to compare against.  When applicable, the diff hint replaces
    # the standard cache hint — both communicate the same idea (you've seen
    # this file before) but the diff carries the actually-changed bytes.
    entry = cache.files.get(session._normalize_path(file_path))  # type: ignore[attr-defined]
    if entry is not None and entry.last_edit_ts > entry.last_read_ts:
        diff_response = _try_diff_hint(session_id, file_path)
        if diff_response is not None:
            # Extract the text so we can combine with the git hint if present.
            hso = diff_response.get("hookSpecificOutput") or {}
            diff_text = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
            if diff_text:
                context_parts.append(diff_text)

    if not context_parts:
        hint = build_read_hint(
            session_id=session_id,
            file_path=file_path,
            offset=tool_input.get("offset"),
            limit=tool_input.get("limit"),
            cwd=cwd,
            cache=cache,
        )
        if hint:
            from .hints import _hint_fingerprint  # noqa: PLC0415

            hint_text = str(hint)
            fingerprint = _hint_fingerprint(hint_text, path=file_path)

            # Suppress hint if identical hint was already seen in this session.
            if cache.has_hint_fingerprint(fingerprint):
                _LOG.debug(
                    "pre-read: hint fingerprint %s already seen; suppressing duplicate for %s",
                    fingerprint,
                    sanitize_log_str(file_path),
                )
            else:
                if hint.tokens_saved > 0:
                    _LOG.debug(
                        "pre-read: hint injected for %s (tokens_saved=%d)",
                        sanitize_log_str(file_path), hint.tokens_saved,
                    )
                    _record_session_hint_impact(file_path, hint)
                else:
                    _LOG.debug(
                        "pre-read: hint built for %s but tokens_saved=0; no stat recorded",
                        sanitize_log_str(file_path),
                    )
                context_parts.append(hint_text)
                cache.mark_hint_seen(fingerprint)

    # File written this session but never read back — the content the model
    # wrote may still be in context from the Write/Edit tool result, making a
    # full re-read redundant.  Only fires when no other hint was emitted, so
    # it never shadows a more specific diff-hint or cache-overlap hint.
    if not context_parts:
        _written_key = session._normalize_path(file_path)  # type: ignore[attr-defined]
        _edited: dict[str, int] = cache.edited_files if isinstance(cache.edited_files, dict) else {}
        _edit_count = _edited.get(_written_key, 0)
        if _edit_count >= 1 and _written_key not in cache.files:
            _fname = sanitize_log_str(Path(file_path).name, max_len=256)
            context_parts.append(
                f"Note: `{_fname}` was written {_edit_count}x this session and not yet read back. "
                f"The content you wrote may still be in context from the tool result — "
                f"verify there rather than re-reading. For a specific symbol use "
                f"`token-goat read \"{file_path}::SymbolName\"`."
            )
            _LOG.debug(
                "pre-read: written-not-read hint for %s (edit_count=%d)",
                sanitize_log_str(file_path), _edit_count,
            )

    # Append git commit history for the file (always, when available).
    git_ctx = _build_git_hint(cwd, file_path)
    if git_ctx:
        context_parts.append(git_ctx)

    if not context_parts:
        _LOG.debug("pre-read: no hint for %s", sanitize_log_str(file_path))
        return CONTINUE()

    _flush_pending_hint_save(cache)
    return pre_tool_use_with_context("\n\n".join(context_parts))


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
        from . import session as _sess  # noqa: PLC0415

        recent_hints = getattr(cache, "recent_hints", [])
        if not recent_hints:
            return
        norm = _sess._normalize_path(file_path)  # type: ignore[attr-defined]
        for hint_path, _ts in recent_hints:
            if hint_path == norm:
                cache.hints_ignored += 1  # type: ignore[union-attr, attr-defined]
                cache._invalidate_json_cache()  # type: ignore[union-attr, attr-defined]
                # Remove from ring buffer so a second Read doesn't double-count.
                cache.recent_hints = [  # type: ignore[union-attr, attr-defined]
                    (p, t) for p, t in cache.recent_hints  # type: ignore[union-attr, attr-defined]
                    if p != norm
                ]
                _LOG.debug(
                    "curator: hints_ignored++ for %s (total=%d)",
                    sanitize_log_str(file_path), cache.hints_ignored,  # type: ignore[union-attr, attr-defined]
                )
                break
    except Exception:  # noqa: BLE001 — fail-soft
        pass


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
            # Curator: check if this Read is for a path that was recently hinted.
            # If the agent reads the file anyway within the hint window, it ignored the hint.
            _check_ignored_hint(cache, file_path)
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
        if is_real_int(raw_result_count):
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
                    from . import bash_cache as _bc  # noqa: PLC0415
                    _bc.store_glob_result(session_id, pattern, path, output_text)
                except Exception:  # noqa: BLE001
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
                # Older harnesses use "text" as the only key.
                txt = item.get("text") if item.get("type") == "text" else None
                if txt is None:
                    txt = item.get("text")
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
    import shlex  # noqa: PLC0415

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
    from .hooks_common import extract_tool_response_text  # noqa: PLC0415

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
        from typing import cast as _cast  # noqa: PLC0415

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

    # When the pre-Bash hook wrapped this command for output compression, the
    # tool_input still carries the verbose wrapper invocation.  Persist the
    # original user-facing command (via shlex-unwrap) so the session cache,
    # recovery hints, compaction manifest, and ``token-goat stats`` show the
    # agent's intent ("pytest -v"), not ~200 bytes of wrapper boilerplate.
    # Falls through to *command* unchanged when the input was never wrapped.
    display_cmd = _unwrap_compress_command(command)

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

    from . import bash_cache, session  # noqa: PLC0415

    # Hash and preview the *original* command so reruns of the same logical
    # invocation (whether wrapped or not) collide on the same cache entry.
    meta = bash_cache.store_output(
        session_id, display_cmd, stdout, stderr, exit_code,
    )
    if meta is None:
        return CONTINUE()
    bash_cache.write_sidecar(meta)

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
        )
    except (ValueError, OSError) as exc:
        _LOG.debug("post-bash: session record failed: %s", exc)

    # Record a stat row for observability.  No saving is claimed here — the
    # saving is realized when (and if) the agent later avoids a re-run.
    record_cached_stat("bash_output_cached", sanitize_log_str(display_cmd, max_len=200))

    _LOG.info(
        "post-bash: cached output id=%s bytes=%d exit=%s truncated=%s",
        meta.output_id, total_bytes, exit_code, meta.truncated,
    )
    return CONTINUE()
