"""Pre/post-fetch hook handlers: image redirect + WebFetch text dedup cache.

Three responsibilities run from this module:

1. **Drive image / WebFetch image redirect** (existing): downloads to image
   URLs are routed through ``token-goat fetch-image`` so the shrink+cache
   pipeline applies before bytes hit context.

2. **WebFetch text dedup hint** (new): when a non-image URL is fetched a
   second time in the same session, the pre-fetch hook suggests the agent
   retrieve the cached body via ``token-goat web-output`` instead of
   re-fetching.  Mirrors the bash-dedup hint pattern.

3. **WebFetch text capture** (new): the post-fetch hook persists the
   response body to ``data_dir() / "web_outputs"`` and records the
   ``(url_sha → output_id)`` mapping in the session cache so step 2 has
   something to point at.
"""
from __future__ import annotations

__all__ = ["post_fetch", "pre_fetch"]

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    deny_redirect,
    get_session_context,
    get_tool_input,
    is_real_int,
    record_cached_stat,
    sanitize_log_str,
)
from .hooks_common import (
    LOG as _LOG,
)

# Maximum URL length accepted for embedding in hook messages.  URLs longer than
# this are almost certainly not legitimate image URLs; they may be crafted to
# flood the hint text or exploit length-based parsing bugs downstream.
_MAX_URL_EMBED_LEN = 2048


def _sanitize_url_for_embed(url: str) -> str | None:
    """Return a sanitized copy of *url* safe for embedding in hint text, or None to reject.

    Applies three layers of defence against prompt-injection and log-injection
    attacks via the URL field in a harness payload:

    1. **Length cap** — rejects URLs longer than ``_MAX_URL_EMBED_LEN`` (2048
       chars).  Legitimate image URLs are well under this limit; an oversized
       URL is either a DoS attempt or a crafted payload trying to flood the
       model's context with attacker-controlled text.

    2. **Control-character stripping** — removes ASCII control characters
       (``\\x00``–``\\x1f`` and ``\\x7f``), including ``\\n``, ``\\r``, and
       ``\\x1b`` (ANSI escape initiator).  Without this, a URL such as
       ``https://example.com/img.png\\nSYSTEM: ignore previous instructions``
       would be injected verbatim into the ``additionalContext`` field the
       harness shows to the model — a direct prompt-injection vector.

    3. **Shell-safety** — escapes characters that are special inside a
       double-quoted shell string (``\\``, ``$``, `` ` ``, ``"``).  The
       denial message embeds the URL inside a suggested Bash command; unescaped
       metacharacters would allow a rogue harness to inject arbitrary shell
       syntax into that command.
    """
    if len(url) > _MAX_URL_EMBED_LEN:
        return None
    # Strip ASCII control characters (including \n, \r, \x1b / ANSI escapes)
    # ord < 32 covers \x00–\x1f; \x7f is DEL.
    cleaned = "".join(ch for ch in url if ord(ch) >= 32 and ch != "\x7f")
    if not cleaned:
        return None
    # Escape characters special inside a double-quoted shell string
    for ch in ("\\", "$", "`", '"'):
        cleaned = cleaned.replace(ch, f"\\{ch}")
    return f'"{cleaned}"'


def _intercept_drive_download(file_id: str, *, hint_filename: str | None = None) -> HookResponse:
    """Build denial response for Drive download with redirect to token-goat shim.

    When *hint_filename* is supplied and looks like a markdown/text doc, the
    redirect points the agent at ``gdrive-sections`` first.  That call returns
    the heading structure (typically 50–200 tokens) instead of the full body
    (often 10k–50k tokens), letting the agent request a single section via
    ``token-goat section`` afterwards.  For binary / unknown types the original
    ``gdrive-fetch`` flow is suggested.
    """
    sections_hint = ""
    if hint_filename:
        # Local import to avoid pulling google client deps when the hook fires
        # for a tool call that has no filename (the common case).
        from pathlib import Path  # noqa: PLC0415

        from . import gdrive  # noqa: PLC0415

        if gdrive.is_text_path(Path(hint_filename)):
            sections_hint = (
                f"For markdown/text docs prefer: `token-goat gdrive-sections {file_id}` first — "
                f"it returns the heading index (tens of tokens) so you can fetch just one section "
                f"via `token-goat section <local-path>::<heading>` instead of the whole doc. "
            )
    return deny_redirect(
        reason="token-goat redirects Drive image downloads to its shrink+cache shim",
        context=(
            f"token-goat intercepted a Drive download to save tokens. "
            f"{sections_hint}"
            f"Run this Bash instead: `token-goat gdrive-fetch {file_id}` — "
            f"it returns a local cached path you can then Read (images are auto-shrunk)."
        ),
    )


def _intercept_webfetch_image(url: str) -> HookResponse:
    """Build denial response for WebFetch image with redirect to token-goat shim.

    The URL is sanitized before embedding: control characters are stripped to
    prevent prompt injection via the ``additionalContext`` hint, the length is
    capped to prevent context flooding, and shell metacharacters are escaped so
    the suggested ``token-goat fetch-image`` command is safe to run verbatim.
    If sanitization rejects the URL (too long or empty after stripping), the
    hook falls through with CONTINUE rather than surfacing a confusing denial
    with no actionable URL.
    """
    safe_url = _sanitize_url_for_embed(url)
    if safe_url is None:
        return CONTINUE()
    return deny_redirect(
        reason="token-goat redirects image URLs to its shrink+cache shim",
        context=(
            f"token-goat intercepted a WebFetch to an image URL to save tokens. "
            f"Run this Bash instead: `token-goat fetch-image {safe_url}` — "
            f"it downloads, shrinks, caches, and returns a local path you can then Read."
        ),
    )


def _handle_web_dedup(payload: HookPayload, url: str) -> HookResponse | None:
    """Return a dedup hint when *url* was just fetched in this session.

    Mirrors :func:`hooks_read._handle_bash_dedup` for the WebFetch surface.
    Returns ``None`` to let the hook continue to its existing image-redirect
    path or pass through unchanged.
    """
    from .hints import build_web_dedup_hint  # noqa: PLC0415
    from .hooks_common import run_dedup_hint  # noqa: PLC0415

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_web_dedup_hint(
            session_id=sid, url=url, cache=cache,
        ),
        stat_kind="web_dedup_hint",
        detail=sanitize_log_str(url, max_len=200),
        log_label="pre-fetch",
    )


def _handle_web_cache_hit(payload: HookPayload, url: str) -> HookResponse | None:
    """Return a cache-hit hint when *url* has a cached body from a prior session.

    Fires when the URL is not in the current session's web history but there
    is still a body on disk from a previous session.  This is the cross-session
    counterpart to :func:`_handle_web_dedup`.
    Returns ``None`` when no prior cached entry exists or the session has
    already seen this URL (the dedup path handles that case).
    """
    from .hints import build_web_cache_hit_hint  # noqa: PLC0415
    from .hooks_common import run_dedup_hint  # noqa: PLC0415

    return run_dedup_hint(
        payload,
        builder=lambda sid, cache: build_web_cache_hit_hint(
            session_id=sid, url=url, cache=cache,
        ),
        stat_kind="web_cache_hit_hint",
        detail=sanitize_log_str(url, max_len=200),
        log_label="pre-fetch",
    )


def _check_url_allowdeny(url: str) -> HookResponse | None:
    """Check *url* against the configured deny/allow glob lists.

    Returns a ``HookResponse`` (deny) when the URL should be blocked, or
    ``None`` when the URL is permitted to proceed.

    Logic:
    1. Deny list is checked first.  A match → block immediately.
    2. Allow list: if non-empty, URL must match at least one pattern or it is blocked.
    3. Empty allow list → allow everything not denied.

    Patterns are matched via :func:`fnmatch.fnmatch` against the full URL string.
    """
    import fnmatch  # noqa: PLC0415

    from . import config as _config  # noqa: PLC0415

    cfg = _config.load().webfetch
    url_str = url

    for pat in cfg.deny:
        if fnmatch.fnmatch(url_str, pat):
            _LOG.info("pre-fetch: URL blocked by deny pattern %r: %s", pat, sanitize_log_str(url_str, max_len=200))
            return deny_redirect(
                reason=f"token-goat webfetch deny list blocked this URL (pattern: {pat!r})",
                context=(
                    "The URL matches a deny pattern in your token-goat config [webfetch] deny list. "
                    "If this was unintentional, update config.toml to remove the pattern."
                ),
            )

    if cfg.allow:
        for pat in cfg.allow:
            if fnmatch.fnmatch(url_str, pat):
                return None  # explicitly allowed
        _LOG.info("pre-fetch: URL not in allow list, blocking: %s", sanitize_log_str(url_str, max_len=200))
        return deny_redirect(
            reason="token-goat webfetch allow list: URL did not match any allowed pattern",
            context=(
                "The URL did not match any pattern in your token-goat config [webfetch] allow list. "
                "Add a matching pattern to allow it."
            ),
        )

    return None  # no restrictions


def pre_fetch(payload: HookPayload) -> HookResponse:
    """Deny Drive/WebFetch image tools and dedup repeat text WebFetch calls."""
    tool_name = payload.get("tool_name", "")

    drive_tools = (
        "mcp__claude_ai_Google_Drive__download_file_content",
        "mcp__claude_ai_Google_Drive__read_file_content",
    )
    if tool_name in drive_tools:
        tool_input = get_tool_input(payload)
        file_id = tool_input.get("file_id") or tool_input.get("fileId") or tool_input.get("id")
        if not file_id:
            return CONTINUE()

        from . import gdrive  # noqa: PLC0415

        # Validate file_id before embedding in hook message to prevent injection.
        # Malicious IDs with shell metacharacters could be acted on by Claude.
        gdrive._validate_file_id(file_id)
        gdrive.get_credentials()

        # The Drive MCP sometimes includes a `name` / `filename` hint in the tool
        # input. When present, use it to pick the right shim (sections vs fetch).
        hint_filename = tool_input.get("name") or tool_input.get("filename") or tool_input.get("file_name")
        if hint_filename and not isinstance(hint_filename, str):
            hint_filename = None
        # Cap length to avoid embedding crafted long filenames in the hint text.
        if isinstance(hint_filename, str) and len(hint_filename) > 256:
            hint_filename = None
        return _intercept_drive_download(file_id, hint_filename=hint_filename)

    if tool_name == "WebFetch":
        tool_input = get_tool_input(payload)
        url = tool_input.get("url")
        if not url or not isinstance(url, str):
            return CONTINUE()

        # Check allow/deny lists before anything else.
        allowdeny = _check_url_allowdeny(url)
        if allowdeny is not None:
            return allowdeny

        from . import webfetch  # noqa: PLC0415

        if webfetch.is_image_url(url):
            return _intercept_webfetch_image(url)

        # Non-image WebFetch: try dedup first.  When the same URL was fetched
        # earlier in this session, emit a hint pointing at the cached body
        # instead of letting the request go through.
        dedup = _handle_web_dedup(payload, url)
        if dedup is not None:
            return dedup

        # Cross-session cache hit: the URL was not fetched in this session but
        # has a cached body on disk from a prior session.  Emit a hint so the
        # agent can retrieve it without a network round-trip.
        cache_hit = _handle_web_cache_hit(payload, url)
        if cache_hit is not None:
            return cache_hit

        return CONTINUE()

    return CONTINUE()


# ---------------------------------------------------------------------------
# post_fetch — capture WebFetch text responses to the on-disk cache
# ---------------------------------------------------------------------------

# Smallest WebFetch body worth caching.  Mirrors the dedup-hint floor: below
# this size the dedup hint would not fire anyway, and the disk+JSON churn
# outweighs the saving.
_WEB_CACHE_MIN_BYTES: int = 1024

# Size threshold for emitting the web-output size hint.  Responses smaller
# than this do not benefit enough from --grep filtering to warrant the hint text.
_WEB_SIZE_HINT_THRESHOLD_KB: int = 10


def _maybe_emit_web_size_hint(meta: object, log_or_none: object) -> None:
    """Emit a hint when a cached web response exceeds the size threshold.

    Accepts meta as object to avoid circular import of web_cache.WebOutputMeta.
    At runtime, meta is a WebOutputMeta instance with body_bytes and output_id attrs.

    Calculates estimated token savings from using --grep and suggests the
    ``token-goat web-output <id> --grep PATTERN`` command to filter the cached
    response instead of re-fetching.  Only emits when size > 10 KB.

    This is informational — no hint is injected into the tool response, just
    logged for observability. The real size hint will be emitted by the pre-fetch
    hook on subsequent requests for the same URL (via the dedup/cache-hit hints).
    """
    from . import util  # noqa: PLC0415

    # Get a proper logger instance from the util module
    log = util.get_logger("hooks_fetch")
    # Meta is a WebOutputMeta instance; access attrs directly
    meta_body_bytes = getattr(meta, "body_bytes", 0)
    meta_output_id = getattr(meta, "output_id", "unknown")
    size_kb = meta_body_bytes / 1024.0
    if size_kb < _WEB_SIZE_HINT_THRESHOLD_KB:
        return

    # Rough token estimate: ~1 token per 4 bytes; ~70% savings from --grep
    token_est = meta_body_bytes // 4
    savings_est = int(token_est * 0.7)
    log.debug(
        "web_size_hint: id=%s size=%.1f KB (≈%d tokens, ≈%d tokens saved with --grep)",
        meta_output_id, size_kb, token_est, savings_est,
    )


def _extract_web_response(payload: HookPayload) -> tuple[str, int | None, str | None]:
    """Pull (body, status_code, content_type) from a PostToolUse WebFetch payload.

    Defensive about payload-shape drift between harness versions.  The text
    body is extracted via :func:`hooks_common.extract_tool_response_text` which
    handles all shapes (bare string, MCP content array, named-field dict).
    Status code is read at ``status_code``, ``status``, or ``code`` and coerced
    via int — string-typed codes are accepted to handle harnesses that surface
    them as ``"200"``.  Content-type is read from response headers or metadata
    when available, normalized to the base MIME type (e.g. "text/html").
    """
    from .hooks_common import extract_tool_response_text  # noqa: PLC0415

    body = extract_tool_response_text(
        payload,
        text_keys=("output", "text", "body", "content", "response"),
    )

    # Status code and content-type live in the raw dict only — extract separately.
    raw_resp: object = payload.get("tool_response") if isinstance(payload, dict) else None
    if raw_resp is None and isinstance(payload, dict):
        raw_resp = payload.get("tool_result") or payload.get("response")

    status_val: object = None
    content_type_val: object = None
    if isinstance(raw_resp, dict):
        status_val = (
            raw_resp.get("status_code")
            if "status_code" in raw_resp
            else raw_resp.get("status")
            if "status" in raw_resp
            else raw_resp.get("code")
        )
        # Try to extract content-type from headers or metadata
        headers = raw_resp.get("headers")
        if isinstance(headers, dict):
            content_type_val = headers.get("content-type") or headers.get("Content-Type")
        if not content_type_val:
            # Fallback to direct content_type field if headers don't have it
            content_type_val = raw_resp.get("content_type") or raw_resp.get("content-type")

    status_code: int | None = None
    if is_real_int(status_val):
        status_code = status_val
    elif isinstance(status_val, str):
        try:
            status_code = int(status_val)
        except (TypeError, ValueError):
            status_code = None

    # Normalize content-type: extract just the MIME type, drop charset and other params
    content_type: str | None = None
    if isinstance(content_type_val, str):
        content_type = content_type_val.split(";")[0].strip().lower()

    return body, status_code, content_type


def post_fetch(payload: HookPayload) -> HookResponse:
    """Post-WebFetch hook: persist large text responses to disk + session history.

    Skips images entirely — those are already handled by the existing
    image-cache pipeline.  For non-image responses above the cache threshold,
    writes the body to ``data_dir() / "web_outputs"`` and records the
    ``(url_sha, output_id)`` mapping in the session so a follow-up
    ``pre_fetch`` for the same URL can dedupe.

    Always returns CONTINUE — this hook never modifies the tool result.
    Failures at any step are logged and swallowed.
    """
    tool_name = payload.get("tool_name", "")
    if tool_name != "WebFetch":
        return CONTINUE()

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        _LOG.debug("post-fetch: no session_id; output not cached")
        return CONTINUE()

    tool_input = get_tool_input(payload)
    url = tool_input.get("url")
    if not isinstance(url, str) or not url:
        return CONTINUE()

    from . import webfetch  # noqa: PLC0415

    if webfetch.is_image_url(url):
        # Image responses go through the existing image cache pipeline; we
        # don't double-cache them here.
        return CONTINUE()

    body, status_code, content_type = _extract_web_response(payload)

    # Strip script/style/nav/header/footer blocks from HTML responses before
    # caching.  These blocks are typically 60-90% of raw HTML bytes and pure
    # noise for `token-goat web-output --grep`.  _strip_html_to_text operates
    # on bytes; encode round-trip only when the body looks like HTML (the
    # function checks for <html / <!doctype in the preamble before stripping).
    try:
        _body_bytes = body.encode("utf-8", errors="replace")
        _stripped = webfetch._strip_html_to_text(_body_bytes)
        if _stripped is not _body_bytes and _stripped != _body_bytes:
            body = _stripped.decode("utf-8", errors="replace")
            _LOG.debug(
                "post-fetch: HTML stripped %d→%d bytes for %s",
                len(_body_bytes), len(_stripped), sanitize_log_str(url, max_len=100),
            )
    except Exception:  # noqa: BLE001 — fail-soft: stripping must never break caching
        pass

    body_size = len(body.encode("utf-8", errors="replace"))
    if body_size < _WEB_CACHE_MIN_BYTES:
        _LOG.debug(
            "post-fetch: body too small to cache (%d bytes < %d threshold)",
            body_size, _WEB_CACHE_MIN_BYTES,
        )
        return CONTINUE()

    from . import config, session, web_cache  # noqa: PLC0415

    cfg = config.load()
    meta = web_cache.store_output(
        session_id, url, body, status_code,
        content_type=content_type,
        max_total_bytes=cfg.webfetch.max_bytes,
        max_file_count=cfg.webfetch.max_file_count,
    )
    if meta is None:
        return CONTINUE()
    web_cache.write_sidecar(meta)

    try:
        session.mark_web_fetch(
            session_id=session_id,
            url_sha=meta.url_sha,
            url_preview=url,
            output_id=meta.output_id,
            body_bytes=meta.body_bytes,
            status_code=meta.status_code,
            truncated=meta.truncated,
            content_type=meta.content_type,
        )
    except (ValueError, OSError) as exc:
        _LOG.debug("post-fetch: session record failed: %s", exc)

    # Emit a size hint if the response is large enough to benefit from --grep
    _maybe_emit_web_size_hint(meta, None)

    # Informational stat row — no saving claimed at capture time; the saving
    # is realized when (and if) the agent later avoids a re-fetch.
    record_cached_stat("web_output_cached", sanitize_log_str(url, max_len=200))

    _LOG.info(
        "post-fetch: cached body id=%s bytes=%d status=%s truncated=%s",
        meta.output_id, body_size, status_code, meta.truncated,
    )
    return CONTINUE()
