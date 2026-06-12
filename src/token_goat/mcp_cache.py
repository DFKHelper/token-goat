"""MCP tool result cache — dedup repeated read-only MCP calls within a session.

Storage mirrors web_cache: blobs are gzip-compressed under
``data_dir() / "mcp_outputs"``.  The session carries a
``mcp_result_hashes`` dict (tool+input hash → output_id) so the
pre-fetch hook can detect repeat calls and deny them with a cached hint.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .cache_common import (
    OutputStatDict,
    build_output_id,
    evict_cache_dir,
    get_cache_dir,
    list_cache_outputs,
    load_blob_gz,
    load_output_meta_stat,
    load_sidecar_json,
    safe_join_output_id,
    short_content_hash,
    sidecar_path_for,
    store_blob_gz,
    write_sidecar_metadata,
)

__all__ = [
    "McpOutputMeta",
    "MCP_MAX_CACHE_BYTES",
    "MCP_DEFAULT_MAX_TOTAL_BYTES",
    "compact_mcp_result",
    "evict_old_entries",
    "is_mcp_read_only",
    "list_outputs",
    "load_mcp_result",
    "load_output",
    "load_output_meta",
    "mcp_hash",
    "read_sidecar",
    "sidecar_meta_path",
    "store_mcp_result",
    "write_sidecar",
]

# Default eviction cap for the MCP output cache (32 MB).
MCP_DEFAULT_MAX_TOTAL_BYTES: int = 32 * 1024 * 1024

_LOG = logging.getLogger(__name__)

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
    r"modify|draft|fork|reply|move|rename|set|add|run|execute|close|copy|"
    r"request|upload|insert|revoke|reset|archive|restore|annotate|register|"
    r"unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban)(?=_|$)",
    re.IGNORECASE,
)

# Field selectors for compact_mcp_result.
_COMPACT_KEY_PRIORITY = re.compile(r"name|title|subject|label|display|summary|snippet|preview", re.IGNORECASE)
_COMPACT_KEY_STATUS = re.compile(r"state|status|type|kind|phase|stage|bucket", re.IGNORECASE)
_COMPACT_KEY_ID = re.compile(r"^(?:number|id|index|key|ref|sha)$", re.IGNORECASE)
# Skip keys whose values are almost always noisy URLs, hashes, or sub-objects.
_COMPACT_SKIP_KEY = re.compile(r"_url$|node_id$|gravatar|_sha$|_html$", re.IGNORECASE)


@dataclass
class McpOutputMeta:
    """Sidecar metadata persisted alongside each cached MCP result blob."""

    output_id: str
    tool_name: str
    input_preview: str
    result_bytes: int
    ts: float


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


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the ``.json`` sidecar path for *output_id*, or None on invalid id."""
    path = safe_join_output_id(output_id, _mcp_outputs_dir, "mcp_cache")
    if path is None:
        return None
    return sidecar_path_for(path)


def write_sidecar(meta: McpOutputMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    write_sidecar_metadata(
        sidecar_meta_path(meta.output_id),
        meta,
        log=_LOG,
        log_prefix="mcp_cache",
    )


def read_sidecar(output_id: str) -> McpOutputMeta | None:
    """Return parsed :class:`McpOutputMeta` from the sidecar JSON, or None."""
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        return McpOutputMeta(
            output_id=str(data.get("output_id", output_id)),
            tool_name=str(data.get("tool_name", "")),
            input_preview=str(data.get("input_preview", "")),
            result_bytes=int(data.get("result_bytes", 0)),
            ts=float(data.get("ts", 0.0)),
        )
    except (TypeError, ValueError):
        return None


def store_mcp_result(
    session_id: str,
    tool_input_hash: str,
    result_text: str,
    ts: float | None = None,
    *,
    tool_name: str = "",
    input_preview: str = "",
) -> str | None:
    """Write *result_text* gzip-compressed to the MCP output store.

    Returns the ``output_id`` on success, or ``None`` when the blob exceeds
    :data:`MCP_MAX_CACHE_BYTES` or the write fails.  When *tool_name* is
    provided, a JSON sidecar is written alongside the blob so ``mcp-output
    --json`` can surface the originating tool and input preview.
    """
    if len(result_text.encode("utf-8", errors="replace")) > MCP_MAX_CACHE_BYTES:
        return None
    _ts = ts if ts is not None else time.time()
    output_id = build_output_id(session_id, tool_input_hash, _ts)
    path = store_blob_gz(output_id, result_text, _mcp_outputs_dir, "mcp_cache")
    if path is None:
        return None
    if tool_name:
        write_sidecar(McpOutputMeta(
            output_id=output_id,
            tool_name=tool_name,
            input_preview=input_preview[:200],
            result_bytes=len(result_text.encode("utf-8", errors="replace")),
            ts=_ts,
        ))
    return output_id


def load_mcp_result(output_id: str) -> str | None:
    """Return the cached MCP result text for *output_id*, or ``None``."""
    return load_blob_gz(output_id, _mcp_outputs_dir, "mcp_cache")


def load_output(output_id: str) -> str | None:
    """Alias for :func:`load_mcp_result`; matches the ``_run_output_recall_command`` interface."""
    return load_mcp_result(output_id)


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an MCP output file (size, mtime), or None."""
    return load_output_meta_stat(output_id, _mcp_outputs_dir, "mcp_cache")


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for all cached MCP outputs, newest first."""
    return list_cache_outputs(_mcp_outputs_dir)


def evict_old_entries(
    *,
    max_total_bytes: int = MCP_DEFAULT_MAX_TOTAL_BYTES,
    max_file_count: int = 4096,
) -> int:
    """Evict the oldest MCP output entries until size/count limits are met.

    Returns the number of body files removed.  Errors are swallowed —
    eviction is opportunistic.  Delegates to :func:`cache_common.evict_cache_dir`
    which handles sidecar pairs atomically.
    """
    return evict_cache_dir(
        cache_dir_fn=_mcp_outputs_dir,
        log_name="mcp_cache",
        max_total_bytes=max_total_bytes,
        max_file_count=max_file_count,
    )


# ---------------------------------------------------------------------------
# MCP result compaction
# ---------------------------------------------------------------------------

def _fmt_compact_val(v: object) -> str:
    """Format a scalar value for compact display."""
    if isinstance(v, str):
        s = v.strip()
        if len(s) > 60:
            s = s[:57] + "..."
        return f'"{s}"'
    if isinstance(v, bool):
        return str(v).lower()
    return str(v)


def _pick_compact_fields(item: dict) -> list[tuple[str, object]]:  # type: ignore[type-arg]
    """Return up to 5 (key, value) pairs from *item* suitable for compact display.

    Fields are ordered: identity (name/title) → status → id → other scalars.
    URL-like values and nested objects are skipped; long strings are truncated by _fmt_compact_val.
    """
    def _is_skippable(key: str, val: object) -> bool:
        if _COMPACT_SKIP_KEY.search(key):
            return True
        if not isinstance(val, (str, int, float, bool)):
            return True
        return bool(isinstance(val, str) and val.startswith("http") and len(val) > 40)

    candidates: list[tuple[int, str, object]] = []
    for key, val in item.items():
        if _is_skippable(key, val):
            continue
        if _COMPACT_KEY_PRIORITY.search(key):
            prio = 0
        elif _COMPACT_KEY_STATUS.search(key):
            prio = 1
        elif _COMPACT_KEY_ID.match(key):
            prio = 2
        else:
            prio = 3
        candidates.append((prio, key, val))

    candidates.sort(key=lambda t: t[0])
    return [(k, v) for _, k, v in candidates[:5]]


def _human_size(n: int) -> str:
    """Return a human-readable byte size string."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def compact_mcp_result(result_text: str, *, inline_threshold: int = 2048) -> str | None:
    """Return a compact text representation of a JSON list MCP result, or None.

    Returns None when:
    - The result is already at or below *inline_threshold* bytes (no compaction needed)
    - The result is not valid JSON or not a list-like structure
    - The compacted form is not meaningfully smaller than the original

    When the result is a JSON array, or a dict with a dominant list value,
    each item is rendered as a single line showing the most informative scalar
    fields.  A header line states the item count and original size so the model
    knows what was omitted.
    """
    raw_bytes = len(result_text.encode("utf-8", errors="replace"))
    if raw_bytes <= inline_threshold:
        return None

    try:
        data = json.loads(result_text)
    except (json.JSONDecodeError, ValueError):
        return None

    list_key: str | None = None
    items: list[object] = []
    extra_scalars: dict[str, object] = {}

    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        best_key: str | None = None
        best_len = 0
        for k, v in data.items():
            if isinstance(v, list) and len(v) > best_len:
                best_key = k
                best_len = len(v)
        if best_key is not None and best_len > 0:
            list_key = best_key
            items = data[best_key]
            for k, v in data.items():
                if k != best_key and isinstance(v, (str, int, float, bool)):
                    extra_scalars[k] = v

    if not items or not isinstance(items[0], dict):
        return None

    compact_lines: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        fields = _pick_compact_fields(item)
        if not fields:
            continue
        pairs = "  ".join(f"{k}={_fmt_compact_val(v)}" for k, v in fields)
        compact_lines.append(f"{i + 1:>3}.  {pairs}")

    if not compact_lines:
        return None

    header_parts: list[str] = [f"{len(items)} item(s)"]
    if list_key:
        header_parts.append(f'key="{list_key}"')
    if extra_scalars:
        ctx = "  ".join(f"{k}={_fmt_compact_val(v)}" for k, v in list(extra_scalars.items())[:3])
        header_parts.append(ctx)
    header_parts.append(f"compacted from {_human_size(raw_bytes)}")
    header = "[" + "  ".join(header_parts) + "]"

    body = header + "\n" + "\n".join(compact_lines)
    compact_bytes = len(body.encode("utf-8", errors="replace"))

    # Only compact when there is a meaningful reduction (≥ 20%); structured output is better even at modest savings.
    if compact_bytes > raw_bytes * 0.8:
        return None
    return body
