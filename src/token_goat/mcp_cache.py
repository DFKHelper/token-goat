"""MCP tool result cache — dedup repeated read-only MCP calls within a session.

Storage mirrors web_cache: blobs are gzip-compressed under
``data_dir() / "mcp_outputs"``.  The session carries a
``mcp_result_hashes`` dict (tool+input hash → output_id) so the
pre-fetch hook can detect repeat calls and deny them with a cached hint.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .cache_common import (
    build_output_id,
    get_cache_dir,
    load_blob_gz,
    short_content_hash,
    store_blob_gz,
)

__all__ = [
    "is_mcp_read_only",
    "mcp_hash",
    "store_mcp_result",
    "load_mcp_result",
    "MCP_MAX_CACHE_BYTES",
]

# Maximum bytes stored per MCP result blob (2 MB).
MCP_MAX_CACHE_BYTES: int = 2 * 1024 * 1024

# Blocklist of mutation verbs matched against the trailing method component of
# the tool name (e.g. "create_issue" in "mcp__plugin_github_github__create_issue").
# Uses (?:^|_)verb(?=_|$) anchoring because underscore is \w, so \b does not fire
# between a verb and the following _ separator (e.g. \bcreate\b misses create_issue).
# Assumes snake_case method names — all Claude Code / Codex CLI MCP tool registries
# use lowercase_snake_case; camelCase tools are not present in practice.
_MUTABLE_VERBS_RE = re.compile(
    r"(?:^|_)(?:create|update|delete|send|write|push|post|remove|label|unlabel|merge|"
    r"modify|draft|fork|reply|move|rename|set|add|run|execute|close|"
    r"request|upload|insert|revoke|reset|archive|restore|annotate|register|"
    r"unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban)(?=_|$)",
    re.IGNORECASE,
)


def is_mcp_read_only(tool_name: str) -> bool:
    """Return True when *tool_name* is a read-only MCP tool safe to cache.

    Only ``mcp__``-prefixed tools are considered.  Applies a blocklist of
    mutation verbs to the last ``__``-delimited component (the method name).
    """
    if not tool_name.startswith("mcp__"):
        return False
    method = tool_name.rsplit("__", 1)[-1]
    return not bool(_MUTABLE_VERBS_RE.search(method))


def mcp_hash(tool_name: str, tool_input: dict) -> str:  # type: ignore[type-arg]
    """Return a 16-char hex hash for the (tool_name, tool_input) pair.

    Input dict is JSON-serialized with sorted keys for stability across
    invocations that construct the same dict in different insertion orders.
    """
    canonical = json.dumps(
        {"tool": tool_name, "input": tool_input},
        sort_keys=True,
        ensure_ascii=False,
    )
    return short_content_hash(canonical)


def _mcp_outputs_dir() -> Path:
    return get_cache_dir("mcp_outputs")


def store_mcp_result(
    session_id: str,
    tool_input_hash: str,
    result_text: str,
    ts: float | None = None,
) -> str | None:
    """Write *result_text* gzip-compressed to the MCP output store.

    Returns the ``output_id`` on success, or ``None`` when the blob exceeds
    :data:`MCP_MAX_CACHE_BYTES` or the write fails.
    """
    if len(result_text.encode("utf-8", errors="replace")) > MCP_MAX_CACHE_BYTES:
        return None
    _ts = ts if ts is not None else time.time()
    output_id = build_output_id(session_id, tool_input_hash, _ts)
    path = store_blob_gz(output_id, result_text, _mcp_outputs_dir, "mcp_cache")
    return output_id if path is not None else None


def load_mcp_result(output_id: str) -> str | None:
    """Return the cached MCP result text for *output_id*, or ``None``."""
    return load_blob_gz(output_id, _mcp_outputs_dir, "mcp_cache")
