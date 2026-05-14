"""Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}."""
from __future__ import annotations

import contextlib
import json
import logging
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, TypedDict

from . import paths
from .project import Project, find_project


class HookPayload(TypedDict, total=False):
    """Base hook payload structure (optional fields depend on hook event)."""

    session_id: str
    cwd: str
    turn_id: str
    tool_name: str
    tool_input: dict[str, Any]
    file_path: str
    file_content: str
    line_number: int

_LOG = logging.getLogger("tokenwise.hooks")


def _setup_logging() -> None:
    """Idempotent: daily-rotated log file in logs/.

    In sandboxed environments (e.g. Codex unelevated) the log directory may be
    read-only or inaccessible.  Fall back to a NullHandler so the hook still
    runs and returns ``{"continue": true}`` instead of failing on logger setup.
    """
    if _LOG.handlers:
        return
    try:
        paths.ensure_dirs()
        log_path = paths.logs_dir() / f"{datetime.now():%Y-%m-%d}.log"
        paths.roll_log_if_oversized(log_path, paths.LOG_FILE_MAX_BYTES)
        handler: logging.Handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    except (OSError, PermissionError):
        handler = logging.NullHandler()
    _LOG.addHandler(handler)
    _LOG.setLevel(logging.INFO)


def normalize_payload(payload: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate harness-specific payloads to tokenwise's internal format.

    Codex sends snake_case keys for some fields and uses 'turn_id'; Claude uses
    camelCase. tokenwise handlers work with the Claude shape internally.
    Most fields (session_id, cwd, tool_name, tool_input) are already identical
    between the two harnesses — nothing needs renaming in the input direction.
    """
    if harness == "codex":
        # turn_id is Codex-only — keep it in payload; no other remapping needed.
        return payload
    return payload


def _translate_hso_to_codex(hso: dict[str, Any]) -> dict[str, Any]:
    """Convert camelCase hookSpecificOutput keys to snake_case for Codex wire format."""
    camel_to_snake = {
        "additionalContext": "additional_context",
        "updatedInput": "updated_input",
        "permissionDecision": "permission_decision",
        "permissionDecisionReason": "permission_decision_reason",
        "hookEventName": "hook_event_name",
    }
    translated = dict(hso)
    for camel_key, snake_key in camel_to_snake.items():
        if camel_key in translated:
            translated[snake_key] = translated.pop(camel_key)
    return translated


def denormalize_response(response: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate tokenwise's internal response format to harness-specific wire format.

    Claude: hookSpecificOutput.{additionalContext, updatedInput, permissionDecision, ...}
    Codex:  hookSpecificOutput.{additional_context, updated_input, permission_decision, ...}
    """
    if harness != "codex":
        return response

    hso = response.get("hookSpecificOutput")
    if not isinstance(hso, dict):
        return response

    result = dict(response)
    result["hookSpecificOutput"] = _translate_hso_to_codex(hso)
    return result


def read_payload(input_file: Path | None = None) -> dict[str, Any]:
    """Read JSON payload from stdin (or a file, for testing).

    Always returns a dict. Coerces non-dict JSON (``null``, lists, scalars)
    to ``{}`` so handlers can safely call ``payload.get(...)``.
    Catches JSON decode errors and returns empty dict instead of crashing.
    """
    try:
        if input_file is not None:
            data = json.loads(input_file.read_text(encoding="utf-8"))
        else:
            raw = sys.stdin.read()
            if not raw.strip():
                return {}
            data = json.loads(raw)
    except json.JSONDecodeError as e:
        _LOG.warning("failed to decode JSON payload: %s", e)
        return {}
    except OSError as e:
        _LOG.warning("failed to read payload from file: %s", e)
        return {}
    return data if isinstance(data, dict) else {}


def emit(result: dict[str, Any]) -> None:
    """Write the hook result to stdout as JSON, swallowing every output error.

    Forces UTF-8 on stdout (Windows defaults to cp1252 which can't encode → and
    other punctuation we use in hints). Never raises: a broken pipe, missing
    buffer, or closed stream simply ends the call without surfacing an error
    to the harness, which would otherwise see the hook as failed.
    """
    payload = json.dumps(result, ensure_ascii=False)
    # Preferred: raw bytes through .buffer so UTF-8 is correct on Windows.
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        with contextlib.suppress(Exception):
            sys.stdout.buffer.flush()
        return
    except Exception:  # noqa: BLE001
        pass
    # Fallback: text-mode write.
    with contextlib.suppress(Exception):
        sys.stdout.write(payload)
        with contextlib.suppress(Exception):
            sys.stdout.flush()


def safe_run(event: str, input_file: Path | None = None, harness: str = "claude") -> None:
    """Run a hook event end-to-end with absolute fail-soft semantics.

    Catches every exception (including BaseException) so the process always
    exits with code 0, no matter what. On failure we still emit a valid
    ``{"continue": true}`` response so the harness has something to parse,
    and we log a one-line diagnostic to stderr so the harness's
    hook-error display has the cause if you go looking for it.
    """
    result: dict[str, Any] = {"continue": True}
    try:
        raw = read_payload(input_file)
        payload = normalize_payload(raw, harness)
        result = dispatch(event, payload)
        result = denormalize_response(result, harness)
    except BaseException as exc:  # noqa: BLE001 — bulletproof
        with contextlib.suppress(Exception):
            print(
                f"tokenwise hook {event} failed: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
        result = {"continue": True}
    emit(result)


def fail_soft(handler: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Decorator: wrap hook handler to never raise or crash the harness.

    CRITICAL INVARIANT: A broken tokenwise hook must NEVER interrupt Claude Code's work.
    This decorator guarantees:
      1. Returns {'continue': True} even if handler raises/crashes.
      2. Logs exception without surfacing it to the caller.
      3. Exits with code 0 (no error signal to harness).

    Used on all hook dispatchers to ensure harness resilience.
    """

    def wrapper(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return handler(payload)
        except Exception:  # noqa: BLE001 — fail-soft is the entire point
            with contextlib.suppress(Exception):
                _LOG.exception("hook handler crashed: payload=%s", json.dumps(payload)[:500])
            return {"continue": True}

    return wrapper


# --- handlers (stubs for later phases, but real fail-soft wrappers) ---


def _reset_session_cache(session_id: str | None) -> None:
    """Reset session cache for /clear, /compact, fresh-start events."""
    if not session_id:
        return
    try:
        from . import session  # noqa: PLC0415

        session.reset_session(session_id)
    except Exception:  # noqa: BLE001
        _LOG.exception("failed to reset session cache")


def _auto_index_if_needed(proj: Project) -> None:
    """Auto-index unindexed projects on first contact to avoid downstream DB-failure misinterpretation."""
    try:
        from . import db, worker  # noqa: PLC0415

        if db.file_count(proj.hash) == 0:
            pid = worker.spawn_index_detached(str(proj.root), proj.hash)
            if pid:
                _LOG.info(
                    "session-start: auto-indexing %s in background (pid=%s)",
                    proj.root, pid,
                )
    except Exception:  # noqa: BLE001
        _LOG.exception("auto-index spawn failed")


def _ensure_worker_running() -> None:
    """Watchdog: start or verify worker daemon is alive."""
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        if pid:
            _LOG.info("session-start: worker pid=%s", pid)
    except Exception:  # noqa: BLE001
        _LOG.exception("watchdog failed")


@fail_soft
def session_start(payload: dict[str, Any]) -> dict[str, Any]:
    """Reset session cache and ensure worker daemon is running."""
    session_id = payload.get("session_id")
    cwd = payload.get("cwd")
    _LOG.info("session-start: session_id=%s cwd=%s", session_id, cwd)

    _reset_session_cache(session_id)

    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        # Mark user activity so the worker's periodic-reindex window stays
        # anchored to projects actually in use.
        with contextlib.suppress(Exception):
            from . import db  # noqa: PLC0415

            db.touch_project_last_seen(proj.hash)
        _auto_index_if_needed(proj)

    _ensure_worker_running()
    return {"continue": True}


def _handle_bash_read_equivalent(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Convert Bash read-equivalent commands to Read payload for recursive processing.

    Returns updated payload if Bash command is a read-equivalent (cat/head/tail/bat),
    or None if it's not a read or if parsing fails.
    """
    from . import bash_parser  # noqa: PLC0415

    tool_input = payload.get("tool_input") or {}
    cmd = tool_input.get("command", "")
    intent = bash_parser.parse(cmd)
    if intent.kind != "read" or not intent.target_path:
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
    """Attempt image shrinking. Returns hook response with updated input, or None if no shrinking occurred."""
    from . import db, image_shrink  # noqa: PLC0415

    if not image_shrink.is_image_path(file_path):
        return None

    try:
        shrunken = image_shrink.shrink(Path(file_path))
        if shrunken is None:
            return None

        img_stats = image_shrink.stats_for(Path(file_path), shrunken)
        tokens_saved = img_stats["bytes_saved"] // 4  # Estimate: 1 token per 4 base64 chars
        with contextlib.suppress(Exception):
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
                    f"Note: image auto-shrunk by tokenwise "
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
    """Record the *net* token impact of injecting a pre-read hint.

    A hint is not free: the text tokenwise injects as ``additionalContext``
    costs tokens in the conversation every time it fires. The honest figure to
    track is therefore *net* — the realized avoided cost minus the cost of the
    injected text:

      net = hint.tokens_saved - (len(hint) / chars-per-token)

    ``hint.tokens_saved`` is non-zero only for dedup hints that warn about
    re-reading already-cached content (see ``hints.ReadHint``). Suggestion
    hints ("this file is large, use tokenwise read") carry 0, so they record a
    small *negative* net — which is the truth: they cost tokens now and realize
    their saving only later, via the ``read_replacement`` stat that
    ``tokenwise read`` records if the agent acts on the suggestion. Counting a
    saving here too would double-count; counting nothing would hide the cost.
    Summing this kind in ``tokenwise stats`` thus answers "is the pre-read hook
    net-positive?" directly.
    """
    from . import db  # noqa: PLC0415
    from .hints import CHARS_PER_TOKEN  # noqa: PLC0415

    realized_tokens = getattr(hint, "tokens_saved", 0)
    injection_cost_tokens = max(1, int(len(hint) / CHARS_PER_TOKEN))
    net_tokens = realized_tokens - injection_cost_tokens
    net_bytes = realized_tokens * 4 - len(hint)  # project convention: ~4 bytes/token

    try:
        db.record_stat(
            None,
            "session_hint",
            bytes_saved=net_bytes,
            tokens_saved=net_tokens,
            detail=file_path,
        )
    except Exception:  # noqa: BLE001
        _LOG.exception("failed to record session_hint impact")


@fail_soft
def pre_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 10: session-cache hints. Phase 12 (image shrink) wires in here too.

    Also handles Codex's Bash tool when the command is a read-equivalent
    (cat/head/tail/bat/…). In that case a synthetic Read payload is built and
    the function calls itself recursively so all image-shrink and hint logic
    fires identically regardless of harness.
    """
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")

    # Codex path: Bash command that is really a Read
    if tool_name == "Bash":
        read_payload = _handle_bash_read_equivalent(payload)
        if read_payload:
            return pre_read(read_payload)
        # Grep/glob via Bash: could mark session but can't rewrite easily. Pass through.
        return {"continue": True}

    if tool_name != "Read":
        return {"continue": True}

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    if not file_path:
        return {"continue": True}

    session_id = payload.get("session_id")
    cwd = payload.get("cwd")

    # Attempt image shrinking (Phase 12)
    shrink_response = _try_shrink_image(file_path, tool_input)
    if shrink_response:
        return shrink_response

    # Build session-cache hint (Phase 10)
    hint = build_read_hint(
        session_id=session_id,
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
        cwd=cwd,
    )
    if not hint:
        return {"continue": True}

    # Every injected hint has a token cost (the additionalContext text) and,
    # for dedup hints, a realized saving. Record the net of the two so
    # `tokenwise stats` reflects the hook's true contribution, not just its
    # upside.
    _record_session_hint_impact(file_path, hint)

    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": str(hint),
        },
    }


def _intercept_drive_download(file_id: str) -> dict[str, Any]:
    """Build denial response for Drive download with redirect to tokenwise shim."""
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "tokenwise redirects Drive image downloads to its shrink+cache shim",
            "additionalContext": (
                f"tokenwise intercepted a Drive download to save tokens. "
                f"Run this Bash instead: `tokenwise gdrive-fetch {file_id}` — "
                f"it returns a local cached path you can then Read (images are auto-shrunk)."
            ),
        },
    }


def _intercept_webfetch_image(url: str) -> dict[str, Any]:
    """Build denial response for WebFetch image with redirect to tokenwise shim."""
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "tokenwise redirects image URLs to its shrink+cache shim",
            "additionalContext": (
                f"tokenwise intercepted a WebFetch to an image URL to save tokens. "
                f"Run this Bash instead: `tokenwise fetch-image '{url}'` — "
                f"it downloads, shrinks, caches, and returns a local path you can then Read."
            ),
        },
    }


@fail_soft
def pre_fetch(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 13+14: deny Drive/WebFetch image tools, redirect to tokenwise shims."""
    tool_name = payload.get("tool_name", "")

    # --- Drive intercept (Phase 13) ---
    _DRIVE_TOOLS = (
        "mcp__claude_ai_Google_Drive__download_file_content",
        "mcp__claude_ai_Google_Drive__read_file_content",
    )
    if tool_name in _DRIVE_TOOLS:
        tool_input = payload.get("tool_input") or {}
        file_id = tool_input.get("file_id") or tool_input.get("fileId") or tool_input.get("id")
        if not file_id:
            return {"continue": True}

        # Only intercept if tokenwise has working Drive credentials; otherwise pass through
        from . import gdrive  # noqa: PLC0415

        try:
            gdrive.get_credentials()
        except gdrive.GDriveCredsUnavailable:
            return {"continue": True}

        return _intercept_drive_download(file_id)

    # --- WebFetch intercept (Phase 14) ---
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


@fail_soft
def post_edit(payload: dict[str, Any]) -> dict[str, Any]:
    """Post-edit hook: record edited files + queue them for incremental reindex.

    Two responsibilities:
      1. Mark the file in the session cache (compaction assist).
      2. Append the file to the dirty queue so the worker reindexes it.  Without
         (2) a project's symbol index goes stale the moment you edit a file —
         `tokenwise read`/`symbol` then return wrong line ranges and the
         pre-read hint shows stale data, costing tokens for no benefit.
    """
    from . import session  # noqa: PLC0415

    session_id = payload.get("session_id")
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path")

    if session_id and file_path:
        session.mark_file_edited(session_id, file_path)

    if file_path:
        _enqueue_for_reindex(file_path, payload.get("cwd"))
        _nudge_worker_if_down()

    return {"continue": True}


def _nudge_worker_if_down() -> None:
    """Mid-session watchdog: respawn the worker if its heartbeat has gone stale.

    The ``SessionStart`` hook starts the worker, but if it crashes or hangs
    *mid-session* nothing notices until the next session begins — and the
    dirty queue this hook just appended to would silently never drain.
    ``post_edit`` is the right place to check because it is the hook that
    *feeds* the queue.

    The common path is a single ``stat()`` on the heartbeat file. The heavy
    ``worker`` import — which pulls in tree-sitter via ``parser`` — happens
    only on the rare stale path, so the per-edit cost stays negligible.
    """
    import time  # noqa: PLC0415

    try:
        hb_path = paths.worker_heartbeat_path()
        try:
            # 2 × heartbeat interval (30 s) + margin — matches is_worker_alive().
            fresh = (time.time() - hb_path.stat().st_mtime) <= 65.0
        except OSError:
            fresh = False  # missing heartbeat → worker not confirmed alive
        if fresh:
            return
        from . import worker  # noqa: PLC0415

        worker.ensure_running()
    except Exception:  # noqa: BLE001
        _LOG.exception("worker nudge failed")


def _enqueue_for_reindex(file_path: str, cwd: str | None) -> None:
    """Resolve *file_path* to (project_hash, rel_path) and append to the dirty queue.

    The enqueue is inlined (rather than calling ``worker.enqueue_dirty``) so the
    per-edit hook stays light — importing ``worker`` would pull in tree-sitter
    via ``parser``.  The line format must stay in sync with
    ``worker.drain_dirty_queue``: one JSON object per line with ``path``,
    ``project_hash``, ``project_root``, ``project_marker``, and ``ts`` keys.
    ``project_root``/``project_marker`` make the entry self-sufficient: if the
    project has never been indexed (so its hash is not yet in ``global.db``),
    the worker can still reconstruct it and run a first index instead of
    dropping the edit.
    """
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from .project import find_project  # noqa: PLC0415

    abs_path = Path(file_path)
    search_root = abs_path.parent if abs_path.is_absolute() else Path(cwd or ".")
    project = find_project(search_root)
    if project is None:
        return
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return  # edited file lives outside the detected project

    queue_path = paths.dirty_queue_path()
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {
            "path": rel,
            "project_hash": project.hash,
            "project_root": project.root.as_posix(),
            "project_marker": project.marker,
            "ts": time.time(),
        }
    )
    try:
        with queue_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as e:
        _LOG.warning("failed to enqueue %s for reindex: %s", rel, e)


@fail_soft
def post_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 7: record Read/Grep calls to session cache."""
    from . import session  # noqa: PLC0415

    session_id = payload.get("session_id")
    if not session_id:
        return {"continue": True}

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}

    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        if file_path:
            offset = tool_input.get("offset")
            limit = tool_input.get("limit")
            session.mark_file_read(session_id, file_path, offset, limit)
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        result_count = payload.get("result_count")
        if pattern:
            session.mark_grep(session_id, pattern, path, result_count)
    elif tool_name == "Glob":
        pass  # just log it

    return {"continue": True}


def _detect(payload: dict[str, Any]) -> Project | None:
    """Detect the current project from cwd. Returns None if not in a project root."""
    cwd = payload.get("cwd")
    if not cwd:
        return None
    return find_project(Path(cwd))


# --- dispatcher entry point used by cli.py ---

@fail_soft
def pre_compact(payload: dict[str, Any]) -> dict[str, Any]:
    """PreCompact hook: inject a session manifest as systemMessage before compaction.

    The compaction LLM receives the manifest in its context and includes it in
    the summary, so edited files and accessed symbols survive the compaction.
    Configurable via config.toml [compact_assist] or TOKENWISE_COMPACT_ASSIST=0.
    """
    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415

    cfg = config_mod.load().compact_assist
    if not cfg.enabled:
        return {"continue": True}

    trigger = payload.get("trigger", "manual")
    if trigger not in cfg.triggers:
        _LOG.info("pre-compact: skipping (trigger=%s not in %s)", trigger, cfg.triggers)
        return {"continue": True}

    session_id = payload.get("session_id")
    if not session_id:
        return {"continue": True}

    n_events = compact_mod.event_count(session_id)
    if n_events < cfg.min_events:
        _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events)
        return {"continue": True}

    manifest = compact_mod.build_manifest(session_id, max_tokens=cfg.max_manifest_tokens)
    if not manifest:
        return {"continue": True}

    _LOG.info(
        "pre-compact: injecting manifest (%d chars, trigger=%s, events=%d)",
        len(manifest), trigger, n_events,
    )
    return {"continue": True, "systemMessage": manifest}


EVENTS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "session-start": session_start,
    "pre-read": pre_read,
    "pre-fetch": pre_fetch,
    "post-edit": post_edit,
    "post-read": post_read,
    "pre-compact": pre_compact,
}


def dispatch(event: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a hook event. Always returns at minimum {'continue': True}."""
    _setup_logging()
    handler = EVENTS.get(event)
    if handler is None:
        _LOG.warning("unknown hook event: %s", event)
        return {"continue": True}
    return handler(payload)
