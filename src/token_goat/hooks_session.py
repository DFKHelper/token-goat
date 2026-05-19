"""Session lifecycle hook handlers: session-start and post-compaction recovery.

``session_start`` fires on every new Claude Code session (SessionStart event).
It performs four ordered actions:

1. **Source detection** — reads the ``source`` field from the payload to
   distinguish ``"startup"`` / ``"resume"`` / ``"clear"`` / ``"compact"``.
   When the source is ``"compact"`` the cache is intentionally **preserved**
   and a recovery hint is built from it; otherwise the cache is reset.

2. **Cache reset (non-compact only)** — clears the per-session JSON cache
   for this session ID so stale line-range data from a previous run does
   not trigger false re-read hints.

3. **Project detection + auto-indexing** — resolves ``cwd`` from the harness
   payload to a project root.  If the project has never been indexed, a detached
   background ``token-goat index`` subprocess is spawned so the first Read of the
   session already has symbols available.  ``db.touch_project_last_seen`` is also
   called so the worker's periodic-reindex prioritises recently used projects.

4. **Worker watchdog** — calls ``worker.ensure_running()`` to start (or confirm)
   the background daemon.  The worker handles dirty-queue draining, LRU image
   eviction, log rotation, and stale-lock cleanup; it must be alive before any
   post-edit hooks fire.

When the recovery path runs, the hook returns ``additionalContext`` carrying
a compact summary of the session state immediately before compaction:
recently-edited files, top symbols accessed, the most recent cached Bash
outputs (with their ``token-goat bash-output <id>`` retrieval keys), and the
most recent cached WebFetch responses.  This lets the agent recover the
context it just lost to compaction without re-reading every file from scratch.

``cwd`` validation is intentional: the field comes from an untrusted harness
payload, so empty, non-directory, and excessively long values are rejected before
being passed to ``find_project``.
"""
from __future__ import annotations

__all__ = ["session_start"]

from typing import TYPE_CHECKING

from .compact import _humanize_bytes
from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    sanitize_opt,
    validate_cwd,
)
from .hooks_common import (
    LOG as _LOG,
)

if TYPE_CHECKING:
    # ``project`` pulls in ``hashlib`` (~6 ms cold) plus the marker regexes,
    # which are only needed when ``session-start`` actually fires.  The other
    # five hook events never touch this module's helpers, so defer the import.
    from .project import Project


def _reset_session_cache(session_id: str | None) -> None:
    """Reset session cache for /clear and fresh-start events.

    Intentionally NOT called for ``source == "compact"`` — we want the
    pre-compaction state to survive into the new context window so the
    recovery hint has something to point at.
    """
    if not session_id:
        return
    from . import session  # noqa: PLC0415

    session.reset_session(session_id)


# Recovery hint slot budget.  Each line costs ~25-40 tokens; the total budget
# keeps the whole hint comfortably under 400 tokens.  The per-section ``_MAX_``
# values are *floors* (guaranteed minimum allocation when items exist) and the
# ``_CEILING`` values are *soft caps* (max take when other sections leave slack).
# A web-empty session, for example, can grow the file/bash sections beyond
# their floors instead of wasting the unused web budget.
_RECOVERY_MAX_FILES: int = 6  # floor
_RECOVERY_MAX_BASH: int = 4  # floor
_RECOVERY_MAX_WEB: int = 4  # floor
_RECOVERY_TOTAL_ITEMS: int = 14  # global budget = sum of floors
_RECOVERY_FILES_CEILING: int = 12
_RECOVERY_BASH_CEILING: int = 10
_RECOVERY_WEB_CEILING: int = 10
# Minimum byte size before a cached output is worth listing in the recovery
# hint.  Below this the dedup hint would not have fired anyway, and the line
# the recovery hint costs in the budget would not be repaid.
_RECOVERY_MIN_BYTES: int = 400


def _allocate_recovery_slots(
    files_n: int, bash_n: int, web_n: int,
) -> tuple[int, int, int]:
    """Allocate recovery-hint slots across files / bash / web sections.

    Two-pass greedy allocator:

    1. **Floor pass** — each section claims ``min(available, floor)``.  Sections
       with fewer candidates than their floor release the slack immediately.
    2. **Reallocation pass** — leftover budget (total minus floor pass) is
       distributed greedily in priority order (Files → Bash → Web), each
       section capped at its ceiling AND at its true item count.

    Returns ``(files_keep, bash_keep, web_keep)`` — exact slice sizes to apply
    to the candidate lists.  Sum is ``min(files_n + bash_n + web_n, total)``.
    """
    files_keep = min(files_n, _RECOVERY_MAX_FILES)
    bash_keep = min(bash_n, _RECOVERY_MAX_BASH)
    web_keep = min(web_n, _RECOVERY_MAX_WEB)

    remaining = _RECOVERY_TOTAL_ITEMS - (files_keep + bash_keep + web_keep)
    if remaining <= 0:
        return files_keep, bash_keep, web_keep

    # Priority-ordered greedy expansion: files first (most reusable signal),
    # then bash (re-runnable evidence), then web (rarest re-fetch path).
    for current, total, ceiling in (
        ("files", files_n, _RECOVERY_FILES_CEILING),
        ("bash", bash_n, _RECOVERY_BASH_CEILING),
        ("web", web_n, _RECOVERY_WEB_CEILING),
    ):
        if remaining <= 0:
            break
        kept = {"files": files_keep, "bash": bash_keep, "web": web_keep}[current]
        headroom = min(ceiling, total) - kept
        if headroom <= 0:
            continue
        grant = min(headroom, remaining)
        if current == "files":
            files_keep += grant
        elif current == "bash":
            bash_keep += grant
        else:
            web_keep += grant
        remaining -= grant

    return files_keep, bash_keep, web_keep


def _build_recovery_hint(session_id: str) -> str | None:
    """Return a compact recovery hint summarising pre-compaction state.

    Loaded *after* the SessionStart hook detects ``source == "compact"`` but
    *before* the cache reset (so the hint has data to draw from).  Returns
    ``None`` when there is nothing worth surfacing — an empty session prior
    to compact, or a load failure — so the caller can fall through to a
    plain ``CONTINUE`` response.

    The hint is structured Markdown matching the compaction-manifest shape
    so a developer can mentally map between the two outputs: it is the
    counterpart that fires *after* the compaction LLM has processed the
    manifest.
    """
    try:
        from . import session as session_mod  # noqa: PLC0415

        cache = session_mod.load(session_id)
    except (OSError, ValueError) as exc:
        _LOG.debug("recovery hint: failed to load session %s: %s", session_id[:16], exc)
        return None
    if cache.unavailable:
        return None

    # Build full candidate lists first (sorted, floor-filtered) so the
    # allocator sees the true per-section item counts and can reclaim unused
    # budget from empty sections instead of silently dropping high-signal data.
    from operator import attrgetter  # noqa: PLC0415

    files_all = (
        sorted(cache.files.values(), key=attrgetter("last_read_ts"), reverse=True)
        if cache.files else []
    )
    bash_all = sorted(
        (be for be in cache.bash_history.values()
         if (be.stdout_bytes + be.stderr_bytes) >= _RECOVERY_MIN_BYTES),
        key=lambda be: be.ts, reverse=True,
    ) if cache.bash_history else []
    web_all = sorted(
        (we for we in cache.web_history.values() if we.body_bytes >= _RECOVERY_MIN_BYTES),
        key=lambda we: we.ts, reverse=True,
    ) if cache.web_history else []

    files_n, bash_n, web_n = _allocate_recovery_slots(
        len(files_all), len(bash_all), len(web_all),
    )
    files_keep = files_all[:files_n]
    bash_entries = bash_all[:bash_n]
    web_entries = web_all[:web_n]

    sections: list[str] = []

    # 1. Recently-touched files — the agent will likely want these back.
    if files_keep:
        lines = ["**Recently-read files**:"]
        for entry in files_keep:
            sym_count = len(entry.symbols_read)
            if sym_count > 3:
                sym_str = f" syms={','.join(entry.symbols_read[:3])}+{sym_count - 3}"
            elif sym_count:
                sym_str = f" syms={','.join(entry.symbols_read)}"
            else:
                sym_str = ""
            lines.append(f"- {entry.rel_or_abs}{sym_str}")
        dropped = len(files_all) - len(files_keep)
        if dropped > 0:
            lines.append(f"- …+{dropped} more files")
        sections.append("\n".join(lines))

    # 2. Recent Bash output IDs — the most likely "I had this in context" data.
    if bash_entries:
        lines = ["**Recent Bash outputs**:"]
        for be in bash_entries:
            exit_str = "" if be.exit_code is None else f" exit={be.exit_code}"
            total = be.stdout_bytes + be.stderr_bytes
            lines.append(
                f"- `{be.cmd_preview}` ({_humanize_bytes(total)}{exit_str}) `{be.output_id}`"
            )
        dropped = len(bash_all) - len(bash_entries)
        if dropped > 0:
            lines.append(f"- …+{dropped} more cached bash outputs")
        sections.append("\n".join(lines))

    # 3. Recent WebFetch outputs — same idea for network results.
    if web_entries:
        lines = ["**Recent WebFetch responses**:"]
        for we in web_entries:
            status_str = "" if we.status_code is None else f" status={we.status_code}"
            lines.append(
                f"- `{we.url_preview}` ({_humanize_bytes(we.body_bytes)}{status_str}) `{we.output_id}`"
            )
        dropped = len(web_all) - len(web_entries)
        if dropped > 0:
            lines.append(f"- …+{dropped} more cached web responses")
        sections.append("\n".join(lines))

    if not sections:
        return None

    parts = ["## Token-Goat Post-Compact Recovery"]
    # Name the recall command only for sections that actually appear.
    recall = []
    if bash_entries:
        recall.append("`token-goat bash-output <id>`")
    if web_entries:
        recall.append("`token-goat web-output <id>`")
    if recall:
        parts.append("Recall cached output with " + " / ".join(recall) + ".")
    parts.extend(sections)
    return "\n\n".join(parts)


def _try_recovery_response(session_id: str | None, source: str) -> HookResponse | None:
    """Build a recovery-hint response when *source* is "compact" and state exists.

    Returns ``None`` when the recovery path does not apply — caller should
    fall through to the normal session-start flow.  This isolates the
    source-string check from the hint builder so each is independently
    testable.
    """
    if source != "compact" or not session_id:
        return None
    hint = _build_recovery_hint(session_id)
    if not hint:
        return None

    # Record an observability stat row so the recovery path shows up in
    # ``token-goat stats`` if anyone is monitoring whether the feature fires.
    # No saving claimed: the actual saving is realised only when the agent
    # uses the cached IDs from the hint, and those usages are accounted
    # under their own kinds (bash_dedup_hint, web_dedup_hint).
    try:
        from . import db  # noqa: PLC0415

        db.record_stat(None, "compact_recovery", bytes_saved=0, tokens_saved=0, detail=session_id[:32])
    except Exception:  # noqa: BLE001
        _LOG.debug("recovery hint: stat record failed", exc_info=True)

    _LOG.info(
        "session-start: compact-recovery hint emitted for session=%s (%d chars)",
        session_id[:16], len(hint),
    )
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": hint,
        },
    }


def _detect(payload: HookPayload) -> Project | None:
    """Detect the current project from cwd. Returns None if not in a project root.

    Validates *cwd* via :func:`hooks_common.validate_cwd` before handing it to
    ``find_project``.  The ``cwd`` field comes from the harness payload (external
    input), so a malformed value — an empty string, a non-directory path, a
    relative path, or an excessively long value — is rejected before
    ``find_project`` is allowed to walk arbitrary filesystem locations.
    """
    cwd_path = validate_cwd(payload.get("cwd"), caller="session-start")
    if cwd_path is None:
        return None
    from .project import find_project  # noqa: PLC0415

    return find_project(cwd_path)


def _auto_index_if_needed(proj: Project) -> None:
    """Auto-index unindexed projects on first contact."""
    try:
        from . import db, worker  # noqa: PLC0415

        if not db.project_has_files(proj.hash):
            pid = worker.spawn_index_detached(str(proj.root), proj.hash)
            if pid:
                _LOG.info(
                    "session-start: auto-indexing %s in background (pid=%s)",
                    proj.root,
                    pid,
                )
        else:
            _LOG.debug(
                "session-start: project %s already indexed; skipping auto-index",
                proj.hash[:8],
            )
    except Exception:  # noqa: BLE001
        _LOG.exception("auto-index spawn failed")


def _index_git_history(proj: Project) -> None:
    """Trigger git history indexing in a daemon background thread."""
    try:
        import threading  # noqa: PLC0415

        from . import git_history  # noqa: PLC0415

        t = threading.Thread(
            target=git_history.index_project_history,
            args=(proj.root, proj.hash),
            daemon=True,
            name="tg-git-history",
        )
        t.start()
        _LOG.debug("session-start: git history indexing started (background thread)")
    except Exception:  # noqa: BLE001
        _LOG.debug("session-start: git history indexing failed to start", exc_info=True)


def _build_startup_context(proj: Project) -> str | None:
    """Build additionalContext from project memory for the session-start response.

    Returns None when the project has no stored memory entries.
    """
    try:
        from . import project_memory  # noqa: PLC0415

        return project_memory.build_injection(proj.hash)
    except Exception:  # noqa: BLE001
        _LOG.debug("session-start: project memory injection failed", exc_info=True)
        return None


def _ensure_worker_running() -> None:
    """Watchdog: start or verify worker daemon is alive."""
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        if pid:
            _LOG.info("session-start: worker pid=%s", pid)
    except Exception:  # noqa: BLE001
        _LOG.exception("watchdog failed")


def _read_source(payload: HookPayload) -> str:
    """Return the SessionStart ``source`` field, defaulting to ``"startup"``.

    Claude Code emits one of ``"startup"`` / ``"resume"`` / ``"clear"`` /
    ``"compact"`` in this field.  Older harness versions or non-Claude
    callers may omit it; we treat absence as ``"startup"`` so cache-reset
    behaviour stays correct for the common case.
    """
    raw = payload.get("source")
    if isinstance(raw, str):
        return raw
    return "startup"


def session_start(payload: HookPayload) -> HookResponse:
    """Run the appropriate session-lifecycle action for the inbound source.

    * ``source == "compact"``: PRESERVE the cache and emit a recovery hint
      so the agent's new context window has pointers back to the cached
      resources it just lost.
    * Any other source (startup / resume / clear / unknown): RESET the
      cache so stale line-range data does not trigger false hints in the
      fresh run.

    Worker startup and auto-indexing happen in both branches.  Returning
    early in the compact path keeps the recovery hint's ``hookSpecificOutput``
    shape clean (no risk of clobbering it with a later return).
    """
    session_id, cwd = get_session_context(payload)
    source = _read_source(payload)
    _LOG.info(
        "session-start: session_id=%s cwd=%s source=%s",
        sanitize_opt(session_id), sanitize_opt(cwd), sanitize_opt(source),
    )

    recovery = _try_recovery_response(session_id, source)
    # Project detection and worker watchdog must run in both branches —
    # ``source == "compact"`` doesn't change the fact that the worker may
    # have died, or that the project root may need its last-seen bumped.
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        from . import db  # noqa: PLC0415

        db.touch_project_last_seen(proj.hash)
        _auto_index_if_needed(proj)
        _index_git_history(proj)
    _ensure_worker_running()

    if recovery is not None:
        return recovery

    # Non-compact branch: cache reset happens here, AFTER recovery has had
    # a chance to fire (so a misdetection of source can't both reset the
    # cache and lose the recovery data).
    _reset_session_cache(session_id)

    # Inject project memory facts for the new session (non-compact only —
    # compact sessions preserve prior context and don't need a re-injection).
    if proj is not None:
        mem_ctx = _build_startup_context(proj)
        if mem_ctx:
            return {
                "continue": True,
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": mem_ctx,
                },
            }

    return CONTINUE()
