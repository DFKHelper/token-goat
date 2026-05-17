"""Fetch hook helpers."""
from __future__ import annotations

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    deny_redirect,
    get_tool_input,
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


def _intercept_drive_download(file_id: str) -> HookResponse:
    """Build denial response for Drive download with redirect to token-goat shim."""
    return deny_redirect(
        reason="token-goat redirects Drive image downloads to its shrink+cache shim",
        context=(
            f"token-goat intercepted a Drive download to save tokens. "
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


def pre_fetch(payload: HookPayload) -> HookResponse:
    """Deny Drive/WebFetch image tools and redirect to token-goat shims."""
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
        try:
            gdrive._validate_file_id(file_id)
        except ValueError:
            return CONTINUE()

        try:
            gdrive.get_credentials()
        except gdrive.GDriveCredsUnavailable:
            return CONTINUE()

        return _intercept_drive_download(file_id)

    if tool_name == "WebFetch":
        tool_input = get_tool_input(payload)
        url = tool_input.get("url")
        if not url:
            return CONTINUE()

        from . import webfetch  # noqa: PLC0415

        if not webfetch.is_image_url(url):
            return CONTINUE()

        return _intercept_webfetch_image(url)

    return CONTINUE()
