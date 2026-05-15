"""Read hook helpers."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from . import session

_LOG = logging.getLogger("token_goat.hooks")


def _handle_bash_read_equivalent(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Convert Bash read-equivalent commands to Read payload for recursive processing."""
    from . import bash_parser  # noqa: PLC0415

    tool_input = payload.get("tool_input") or {}
    cmd = tool_input.get("command", "")
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
        if intent.reason:
            _LOG.info("bash read near-miss: %s", intent.reason)
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
    file_path: str, tool_input: dict[str, Any]
) -> dict[str, Any] | None:
    """Attempt image shrinking."""
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
            detail=f"{file_path} -> {shrunken.name}",
        )

        shrink_response = dict(tool_input)
        shrink_response["file_path"] = str(shrunken)
        return {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": shrink_response,
                "additionalContext": (
                    f"Note: image auto-shrunk by token-goat "
                    f"({img_stats['src_bytes']:,} → {img_stats['out_bytes']:,} bytes, "
                    f"~{img_stats['bytes_saved']:,} bytes saved). "
                    f"Original: {file_path}"
                ),
            },
        }
    except Exception:  # noqa: BLE001
        _LOG.exception("image-shrink failed during pre-read")
        return None


def _record_session_hint_impact(file_path: str, hint: str) -> None:
    """Record gross session-hint savings plus the injected hint overhead."""
    from . import db  # noqa: PLC0415
    from .hints import CHARS_PER_TOKEN  # noqa: PLC0415

    realized_tokens = getattr(hint, "tokens_saved", 0)
    injection_cost_tokens = max(1, int(len(hint) / CHARS_PER_TOKEN))
    realized_bytes = realized_tokens * 4  # project convention: ~4 bytes/token
    injection_bytes = len(hint)

    db.record_stat(
        None,
        "session_hint",
        bytes_saved=realized_bytes,
        tokens_saved=realized_tokens,
        detail=file_path,
    )
    db.record_stat(
        None,
        "session_hint_overhead",
        bytes_saved=-injection_bytes,
        tokens_saved=-injection_cost_tokens,
        detail=file_path,
    )


def pre_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 10: session-cache hints. Phase 12 (image shrink) wires in here too."""
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")

    if tool_name == "Bash":
        read_payload = _handle_bash_read_equivalent(payload)
        if read_payload:
            return pre_read(read_payload)
        return {"continue": True}

    if tool_name != "Read":
        return {"continue": True}

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    if not file_path:
        return {"continue": True}

    session_id = payload.get("session_id")
    cwd = payload.get("cwd")

    shrink_response = _try_shrink_image(file_path, tool_input)
    if shrink_response:
        return shrink_response

    cache = session.load(session_id) if session_id else None

    hint = build_read_hint(
        session_id=session_id,
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
        cwd=cwd,
        cache=cache,
    )
    if not hint:
        return {"continue": True}

    _record_session_hint_impact(file_path, hint)

    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": str(hint),
        },
    }


def post_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Record Read/Grep calls to session cache."""
    session_id = payload.get("session_id")
    if not session_id:
        return {"continue": True}

    cache = session.load(session_id)

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}

    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        if file_path:
            offset = tool_input.get("offset")
            limit = tool_input.get("limit")
            session.mark_file_read(session_id, file_path, offset, limit, cache=cache)
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        result_count = payload.get("result_count")
        if pattern:
            session.mark_grep(session_id, pattern, path, result_count, cache=cache)
    elif tool_name == "Glob":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        _LOG.debug("post-read: Glob pattern=%s path=%s", pattern, path)

    return {"continue": True}
