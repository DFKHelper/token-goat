"""Fetch hook helpers."""
from __future__ import annotations

from typing import Any

from .hooks_common import (
    CONTINUE,
    HookResponse,
    deny_redirect,
    get_tool_input,
)


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


def _shell_safe_url(url: str) -> str:
    """Return a shell-safe representation of a URL for embedding in a suggested command.

    The suggestion is single-quote delimited, so any single-quote in the URL
    would break out of the quoting.  We use the standard POSIX workaround:
    end the single-quoted segment, emit the literal quote as $'\\'' or a
    double-quoted single char, then resume. For simplicity we just double-quote
    wrap the whole URL instead, escaping only the characters that matter inside
    double quotes: backslash, dollar, backtick, and double-quote.
    """
    # Characters that need escaping inside a double-quoted shell string
    for ch in ("\\", "$", "`", '"'):
        url = url.replace(ch, f"\\{ch}")
    return f'"{url}"'


def _intercept_webfetch_image(url: str) -> HookResponse:
    """Build denial response for WebFetch image with redirect to token-goat shim."""
    safe_url = _shell_safe_url(url)
    return deny_redirect(
        reason="token-goat redirects image URLs to its shrink+cache shim",
        context=(
            f"token-goat intercepted a WebFetch to an image URL to save tokens. "
            f"Run this Bash instead: `token-goat fetch-image {safe_url}` — "
            f"it downloads, shrinks, caches, and returns a local path you can then Read."
        ),
    )


def pre_fetch(payload: dict[str, Any]) -> HookResponse:
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
