"""Fetch hook helpers."""
from __future__ import annotations

from typing import Any


def _intercept_drive_download(file_id: str) -> dict[str, Any]:
    """Build denial response for Drive download with redirect to token-goat shim."""
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "token-goat redirects Drive image downloads to its shrink+cache shim",
            "additionalContext": (
                f"token-goat intercepted a Drive download to save tokens. "
                f"Run this Bash instead: `token-goat gdrive-fetch {file_id}` — "
                f"it returns a local cached path you can then Read (images are auto-shrunk)."
            ),
        },
    }


def _intercept_webfetch_image(url: str) -> dict[str, Any]:
    """Build denial response for WebFetch image with redirect to token-goat shim."""
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "token-goat redirects image URLs to its shrink+cache shim",
            "additionalContext": (
                f"token-goat intercepted a WebFetch to an image URL to save tokens. "
                f"Run this Bash instead: `token-goat fetch-image '{url}'` — "
                f"it downloads, shrinks, caches, and returns a local path you can then Read."
            ),
        },
    }


def pre_fetch(payload: dict[str, Any]) -> dict[str, Any]:
    """Deny Drive/WebFetch image tools and redirect to token-goat shims."""
    tool_name = payload.get("tool_name", "")

    drive_tools = (
        "mcp__claude_ai_Google_Drive__download_file_content",
        "mcp__claude_ai_Google_Drive__read_file_content",
    )
    if tool_name in drive_tools:
        tool_input = payload.get("tool_input") or {}
        file_id = tool_input.get("file_id") or tool_input.get("fileId") or tool_input.get("id")
        if not file_id:
            return {"continue": True}

        from . import gdrive  # noqa: PLC0415

        # Validate file_id before embedding in hook message to prevent injection.
        # Malicious IDs with shell metacharacters could be acted on by Claude.
        try:
            gdrive._validate_file_id(file_id)
        except ValueError:
            return {"continue": True}

        try:
            gdrive.get_credentials()
        except gdrive.GDriveCredsUnavailable:
            return {"continue": True}

        return _intercept_drive_download(file_id)

    if tool_name == "WebFetch":
        tool_input = payload.get("tool_input") or {}
        url = tool_input.get("url")
        if not url:
            return {"continue": True}

        from . import webfetch  # noqa: PLC0415

        if not webfetch.is_image_url(url):
            return {"continue": True}

        return _intercept_webfetch_image(url)

    return {"continue": True}
