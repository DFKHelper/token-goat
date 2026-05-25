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

from typing import TYPE_CHECKING, Final

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
from .util import run_git as _run_git

if TYPE_CHECKING:
    # ``project`` pulls in ``hashlib`` (~6 ms cold) plus the marker regexes,
    # which are only needed when ``session-start`` actually fires.  The other
    # five hook events never touch this module's helpers, so defer the import.
    from .project import Project
    from .session import BashEntry


# ---------------------------------------------------------------------------
# Session-brief TTL cache (item 5)
# ---------------------------------------------------------------------------

# Module-level cache for _build_session_brief results.
# Key: cwd (str)
# Value: (brief: str | None, mtime_editmsg: float, mtime_index: float, mono_ts: float)
# TTL is 60 s (primary expiry).  Two mtime fields form a cheap git-state
# fingerprint: if either changes (new commit, staged change), the cache is
# invalidated on the next call without waiting for TTL expiry.
_BRIEF_CACHE_TTL_SECS: Final[float] = 60.0
_brief_cache: dict[str, tuple[str | None, float, float, float]] = {}


# ---------------------------------------------------------------------------
# Pytest-collapse helpers for the recovery hint bash section
# ---------------------------------------------------------------------------

# Case-insensitive prefix patterns that identify a pytest invocation.
# Matched after strip() so leading whitespace is ignored.
_PYTEST_PREFIXES: Final[tuple[str, ...]] = (
    "pytest",
    "uv run pytest",
    "python -m pytest",
)


def _is_green_pytest(entry: BashEntry) -> bool:
    """Return True when *entry* is a successful pytest run.

    A "green pytest" is defined as:
    - ``exit_code == 0`` (test run passed)
    - ``cmd_preview`` starts with one of :data:`_PYTEST_PREFIXES`
      (case-insensitive, after stripping leading whitespace)
    """
    if entry.exit_code != 0:
        return False
    preview = entry.cmd_preview.strip().lower()
    return any(preview.startswith(p) for p in _PYTEST_PREFIXES)


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
_RECOVERY_MAX_SKILL: int = 4  # floor — skills are the whole point of this hint after compaction
_RECOVERY_TOTAL_ITEMS: int = 18  # global budget = sum of floors
_RECOVERY_FILES_CEILING: int = 12
_RECOVERY_BASH_CEILING: int = 10
_RECOVERY_WEB_CEILING: int = 10
_RECOVERY_SKILL_CEILING: int = 8
# Minimum byte size before a cached output is worth listing in the recovery
# hint.  Below this the dedup hint would not have fired anyway, and the line
# the recovery hint costs in the budget would not be repaid.
_RECOVERY_MIN_BYTES: int = 400


def _allocate_recovery_slots(
    files_n: int, bash_n: int, web_n: int, skill_n: int = 0,
) -> tuple[int, int, int, int]:
    """Allocate recovery-hint slots across files / bash / web / skill sections.

    Two-pass greedy allocator:

    1. **Floor pass** — each section claims ``min(available, floor)``.  Sections
       with fewer candidates than their floor release the slack immediately.
    2. **Reallocation pass** — leftover budget (total minus floor pass) is
       distributed greedily in priority order (Skills → Files → Bash → Web),
       each section capped at its ceiling AND at its true item count.  Skills
       lead the priority order because they're the load-bearing protocol
       content the feature exists to preserve — files/bash/web survive
       compaction better than skill prose does.

    Returns ``(files_keep, bash_keep, web_keep, skill_keep)`` — exact slice
    sizes.  Sum is ``min(files_n + bash_n + web_n + skill_n, total)``.

    The *skill_n* parameter is kwarg-style for backwards compatibility with
    callers that haven't yet been migrated; defaulting to 0 means a legacy
    3-argument call still produces the original 3-section allocation
    (skill_keep returned as 0).
    """
    files_keep = min(files_n, _RECOVERY_MAX_FILES)
    bash_keep = min(bash_n, _RECOVERY_MAX_BASH)
    web_keep = min(web_n, _RECOVERY_MAX_WEB)
    skill_keep = min(skill_n, _RECOVERY_MAX_SKILL)

    remaining = _RECOVERY_TOTAL_ITEMS - (files_keep + bash_keep + web_keep + skill_keep)
    if remaining <= 0:
        return files_keep, bash_keep, web_keep, skill_keep

    # Priority-ordered greedy expansion: skills first (whole-point of the
    # feature), then files (most reusable signal), then bash (re-runnable
    # evidence), then web (rarest re-fetch path).
    for current, total, ceiling in (
        ("skill", skill_n, _RECOVERY_SKILL_CEILING),
        ("files", files_n, _RECOVERY_FILES_CEILING),
        ("bash", bash_n, _RECOVERY_BASH_CEILING),
        ("web", web_n, _RECOVERY_WEB_CEILING),
    ):
        if remaining <= 0:
            break
        kept = {
            "files": files_keep, "bash": bash_keep, "web": web_keep, "skill": skill_keep,
        }[current]
        headroom = min(ceiling, total) - kept
        if headroom <= 0:
            continue
        grant = min(headroom, remaining)
        if current == "files":
            files_keep += grant
        elif current == "bash":
            bash_keep += grant
        elif current == "web":
            web_keep += grant
        else:
            skill_keep += grant
        remaining -= grant

    return files_keep, bash_keep, web_keep, skill_keep


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
    from .cache_common import short_output_id as _short_id  # noqa: PLC0415
    from .compact import _humanize_bytes  # noqa: PLC0415

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
    # Skill entries: every loaded skill is high-signal so no min-bytes filter.
    skill_hist = getattr(cache, "skill_history", None) or {}
    skill_all = (
        sorted(skill_hist.values(), key=lambda se: getattr(se, "ts", 0.0), reverse=True)
        if skill_hist else []
    )

    files_n, bash_n, web_n, skill_n = _allocate_recovery_slots(
        len(files_all), len(bash_all), len(web_all), len(skill_all),
    )
    files_keep = files_all[:files_n]
    bash_entries = bash_all[:bash_n]
    web_entries = web_all[:web_n]
    skill_entries = skill_all[:skill_n]

    sections: list[str] = []

    # 0. Loaded skills — first because they're the load-bearing protocol prose
    #    the compaction LLM most aggressively trims.  When a cached body is
    #    available, we inline the first checklist/DoD section (≤400 chars) so
    #    the agent gets the actionable fraction immediately without a follow-up
    #    tool call.  Fall back to the recall command when no checklist is found
    #    or the body can't be loaded.
    if skill_entries:
        from . import skill_cache as _skill_cache  # noqa: PLC0415

        # Dedup by content_sha.  The session already consolidates repeat loads of
        # the same skill body into a single SkillEntry (incrementing run_count).
        # But if the skill body changed mid-session (different content_sha), the
        # session only keeps the latest entry — the older sha is still on disk.
        # We scan the on-disk cache for this session to surface those extra shas.
        #
        # Result: group by (skill_name, content_sha).
        #   - One sha per name → display as-is (×N from run_count if >1).
        #   - Multiple shas per name → list each with sha[:8] suffix so the
        #     agent can distinguish skill versions.

        # Build a map: normalised_skill_name -> list[SkillMeta], newest first.
        # output_id uses ":" → "_" substitution in plugin-namespaced names;
        # normalise the same way for grouping.
        disk_by_name: dict[str, list[_skill_cache.SkillMeta]] = {}
        for disk_meta in _skill_cache.list_by_session(session_id):
            disk_by_name.setdefault(disk_meta.skill_name, []).append(disk_meta)

        lines = ["**Skills**:"]
        for se in skill_entries:
            name = getattr(se, "skill_name", "?")
            body_bytes = int(getattr(se, "body_bytes", 0))
            run_count = int(getattr(se, "run_count", 1))
            current_sha = getattr(se, "content_sha", "")
            output_id = getattr(se, "output_id", None)

            # Collect distinct shas for this skill from disk (newest first).
            # Normalise ":" → "_" to match the safe_name encoding in output_id.
            disk_key = name.replace(":", "_")
            disk_entries = disk_by_name.get(disk_key, [])
            distinct_shas: list[str] = []
            seen_shas: set[str] = set()
            for dm in disk_entries:
                if dm.content_sha not in seen_shas:
                    distinct_shas.append(dm.content_sha)
                    seen_shas.add(dm.content_sha)
            # Always include the session's current sha even if not on disk.
            if current_sha and current_sha not in seen_shas:
                distinct_shas.append(current_sha)

            multi_sha = len(distinct_shas) > 1

            if multi_sha:
                # Different content shas observed: list each with sha8 suffix.
                # Show most recent first (disk_entries is already newest-first).
                for sha in distinct_shas:
                    sha8 = sha[:8]
                    # Find the disk entry for this sha to get its output_id.
                    sha_meta = next((dm for dm in disk_entries if dm.content_sha == sha), None)
                    sha_output_id = sha_meta.output_id if sha_meta else output_id
                    # Count badge: only the current (latest) sha gets run_count.
                    is_current = sha == current_sha
                    count_str = f" ×{run_count}" if (is_current and run_count > 1) else ""
                    checklist: str | None = None
                    if sha_output_id:
                        body = _skill_cache.load_output(sha_output_id)
                        if body:
                            checklist = _skill_cache.extract_checklist_section(body)
                    if checklist:
                        preview_lines = checklist.splitlines()[:3]
                        indented = "\n  > ".join(preview_lines)
                        lines.append(f"- \U0001f9e0 {name}{count_str} [{sha8}]")
                        lines.append(f"  > {indented}")
                    else:
                        lines.append(
                            f"- {name}{count_str} [{sha8}] ({_humanize_bytes(body_bytes)}) — "
                            f"`token-goat skill-body {name}`"
                        )
            else:
                # Single sha: standard display with ×N count badge.
                count_str = f" ×{run_count}" if run_count > 1 else ""
                checklist = None
                if output_id:
                    body = _skill_cache.load_output(output_id)
                    if body:
                        checklist = _skill_cache.extract_checklist_section(body)
                if checklist:
                    # Indent each checklist line with "  > " for visual offset.
                    preview_lines = checklist.splitlines()[:3]
                    indented = "\n  > ".join(preview_lines)
                    lines.append(f"- \U0001f9e0 {name}{count_str}")
                    lines.append(f"  > {indented}")
                else:
                    lines.append(
                        f"- {name}{count_str} ({_humanize_bytes(body_bytes)}) — "
                        f"`token-goat skill-body {name}`"
                    )
        dropped = len(skill_all) - len(skill_entries)
        if dropped > 0:
            lines.append(f"- +{dropped} more")
        sections.append("\n".join(lines))

    # 1. Recently-touched files — the agent will likely want these back.
    if files_keep:
        lines = ["**Files**:"]
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
            lines.append(f"- +{dropped} more")
        sections.append("\n".join(lines))

    # 2. Recent Bash output IDs — the most likely "I had this in context" data.
    if bash_entries:
        import datetime  # noqa: PLC0415

        has_edits = bool(getattr(cache, "edited_files", None))
        lines = ["**Bash**:"]
        for be in bash_entries:
            if _is_green_pytest(be) and has_edits:
                # Collapsed format: green pytest with edits in context.
                ts_str = datetime.datetime.fromtimestamp(be.ts).strftime("%H:%M")
                lines.append(
                    f"- ✓ pytest passed @ {ts_str}"
                    f" (token-goat bash-output {_short_id(be.output_id)} for details)"
                )
            else:
                exit_str = "" if be.exit_code is None else f" exit={be.exit_code}"
                total = be.stdout_bytes + be.stderr_bytes
                lines.append(
                    f"- `{be.cmd_preview}` ({_humanize_bytes(total)}{exit_str}) `{_short_id(be.output_id)}`"
                )
        dropped = len(bash_all) - len(bash_entries)
        if dropped > 0:
            lines.append(f"- +{dropped} more")
        sections.append("\n".join(lines))

    # 3. Recent WebFetch outputs — same idea for network results.
    if web_entries:
        lines = ["**Web**:"]
        for we in web_entries:
            status_str = "" if we.status_code is None else f" status={we.status_code}"
            lines.append(
                f"- `{we.url_preview}` ({_humanize_bytes(we.body_bytes)}{status_str}) `{_short_id(we.output_id)}`"
            )
        dropped = len(web_all) - len(web_entries)
        if dropped > 0:
            lines.append(f"- +{dropped} more")
        sections.append("\n".join(lines))

    if not sections:
        return None

    parts = ["## Post-Compact Recovery"]
    # One-shot restoration shortcut: emit the resume pointer first so the agent
    # can use a single command instead of individual recall calls.
    parts.append(f"**Quick restore:** `token-goat resume {session_id[:8]}`")
    # Name the individual recall commands for sections that actually appear.
    recall = []
    if skill_entries:
        recall.append("`token-goat skill-body <name>`")
    if bash_entries:
        recall.append("`token-goat bash-output <id>`")
    if web_entries:
        recall.append("`token-goat web-output <id>`")
    if recall:
        parts.append("Recall: " + " / ".join(recall) + ".")
    # Tip: surface the --section flag for skill bodies so agents know they can
    # fetch just a DoD/Steps/Checklist section without pulling the full body.
    if skill_entries:
        parts.append(
            "_Tip: use `token-goat skill-body <name> --section DoD` to fetch only one section._"
        )
    parts.extend(sections)
    return "\n\n".join(parts)


def _try_recovery_response(session_id: str | None, source: str) -> HookResponse | None:
    """Defer a recovery hint by writing a sidecar when *source* is "compact".

    Instead of injecting the recovery hint immediately at SessionStart, this
    function writes the hint text to a ``sentinels/recovery_pending_{session_id}``
    sidecar file and returns ``None`` (CONTINUE).  The pre-read hook in
    ``hooks_read.py`` checks for this sidecar on the first ``PreToolUse(Read)``
    or ``PreToolUse(Bash)`` after compaction, injects it there, and deletes the
    file.  This defers the token cost to the moment when the agent actually
    needs the context (item 2 — deferred recovery hint).

    Returns ``None`` in all cases so the caller always falls through to the
    normal session-start flow.  A writing failure is logged but does not
    prevent the session from continuing — the recovery hint is advisory and
    its loss is benign.
    """
    if source != "compact" or not session_id:
        return None
    hint = _build_recovery_hint(session_id)
    if not hint:
        return None

    # Write the hint to a sidecar file for deferred injection.
    try:
        from . import paths  # noqa: PLC0415

        sidecar = paths.recovery_pending_path(session_id)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(hint, encoding="utf-8")
        _LOG.info(
            "session-start: compact-recovery hint deferred to sidecar for session=%s (%d chars)",
            session_id[:16], len(hint),
        )
    except Exception:  # noqa: BLE001
        _LOG.debug("recovery hint: sidecar write failed", exc_info=True)

    return None


def _parse_status_z_b(output: str) -> tuple[str, list[str], int]:
    """Parse the NUL-separated output of ``git status -z -b``.

    The ``-b`` flag prepends a branch header as the first NUL-terminated field::

        ## main...origin/main\\0XY file1\\0XY file2\\0...

    For detached HEAD git emits ``## HEAD (no branch)`` or ``## HEAD``.
    For a new repo with no commits: ``## No commits yet on main``.

    Returns ``(branch, status_lines, total_count)`` where *status_lines* is a
    list of ``"XY filename"`` strings (the same shape as ``--porcelain`` output)
    capped at 50 entries, *branch* is the short branch name (or ``"unknown"``),
    and *total_count* is the actual number of changed files observed (may exceed
    50 when the dirty tree is very large).  When *total_count* > len(status_lines)
    the caller can emit a ``(+N more files)`` notice.

    Rename entries in ``-z`` format are two consecutive NUL fields
    (``"XY new\\0old\\0"``); we surface only the *new* name (the first field)
    for counting purposes, matching what the old ``--porcelain`` parser did.
    """
    if not output:
        return "unknown", [], 0

    # Fields are separated by NUL; trailing NUL produces an empty final field.
    fields = output.split("\0")

    branch = "unknown"
    status_lines: list[str] = []
    total_count: int = 0

    for _i, field in enumerate(fields):
        if not field:
            continue
        if field.startswith("## "):
            # Branch header: "## main...origin/main" or "## HEAD (no branch)"
            # or "## No commits yet on main"
            header = field[3:]  # strip "## "
            # Extract just the local branch name (before "...")
            local = header.split("...")[0].strip()
            if local.startswith("No commits yet on "):
                local = local[len("No commits yet on "):].strip()
            if local and local not in ("HEAD (no branch)", "HEAD"):
                branch = local
            elif local in ("HEAD (no branch)", "HEAD"):
                branch = "HEAD"
        elif len(field) >= 3 and field[2] == " ":
            # Porcelain v1-style "XY filename"; for renames the *next* field is
            # the old name — skip it (we only count the destination).
            total_count += 1
            if len(status_lines) < 50:
                status_lines.append(field)

    return branch, status_lines, total_count


def _build_session_brief(cwd: str) -> str | None:
    """Build a compact git orientation brief for the session start context.

    Runs ``git --no-optional-locks status -z -b`` (branch + status in one
    round-trip) and ``git log --oneline -5`` in *cwd*.
    Returns a single-line summary (under 80 tokens) or ``None`` when:

    - The directory is not a git repo or git is not available
    - Both status and log are empty (clean repo with no commits)
    - Any subprocess call times out or raises
    - The feature is disabled via env var or config

    Git log is skipped when the branch is ``main`` or ``master``, the working
    tree is clean, and local HEAD matches ``origin/<branch>`` — a session at
    a stable baseline gains nothing from the log (#26).

    The brief format (single line, em-dash-separated)::

        main | 2 modified, 1 untracked — abc1234 fix auth | def5678 add tests
        main — abc1234 fix auth | def5678 add tests
        main | 2 modified, 1 untracked
        main

    When status is empty (clean repo): branch — commits.
    When commits are empty: branch | status.
    When both empty: branch only.

    The ``source`` guard (only fires on non-compact starts) is enforced by the
    caller.  This function just builds the string; it has no knowledge of
    session source.
    """
    import os  # noqa: PLC0415
    import time  # noqa: PLC0415

    # Feature gate: env var override (checked first, cheapest)
    env_val = os.environ.get("TOKEN_GOAT_SESSION_BRIEF", "").strip().lower()
    if env_val in ("0", "false", "no", "off"):
        return None

    # Feature gate: config file
    try:
        from . import config as cfg_mod  # noqa: PLC0415

        cfg = cfg_mod.load()
        if not cfg.session_brief.enabled:
            return None
    except Exception:  # noqa: BLE001
        pass  # fail-open: config load errors don't suppress the brief

    try:
        import pathlib  # noqa: PLC0415

        cwd_path = pathlib.Path(cwd)
        if not cwd_path.is_dir():
            return None
    except Exception:  # noqa: BLE001
        return None

    # --- Git-state fingerprint (two stat calls, ~0.2 ms total) ---
    # Stat .git/COMMIT_EDITMSG and .git/index to detect new commits or
    # staged changes without running any git subprocess.
    import contextlib  # noqa: PLC0415
    _git_dir = cwd_path / ".git"
    _mtime_editmsg = 0.0
    _mtime_index = 0.0
    with contextlib.suppress(OSError):
        _mtime_editmsg = (_git_dir / "COMMIT_EDITMSG").stat().st_mtime
    with contextlib.suppress(OSError):
        _mtime_index = (_git_dir / "index").stat().st_mtime

    # --- TTL + fingerprint cache check ---
    _now_mono = time.monotonic()
    _cached = _brief_cache.get(cwd)
    if _cached is not None:
        _cached_brief, _cached_em, _cached_idx, _cached_ts = _cached
        _age = _now_mono - _cached_ts
        if (
            _age < _BRIEF_CACHE_TTL_SECS
            and _mtime_editmsg == _cached_em
            and _mtime_index == _cached_idx
        ):
            _LOG.debug("session-start: brief cache hit for %s (age=%.1fs)", cwd, _age)
            return _cached_brief

    import subprocess  # noqa: PLC0415 — needed for TimeoutExpired reference
    # Whole-brief wall-clock budget: the git calls share one deadline so a slow repo can't stack timeouts into a long session-start pause.
    deadline = time.monotonic() + 2.5

    def _remaining() -> float:
        return deadline - time.monotonic()

    # Single-call refactor (Option A): `git --no-optional-locks status -z -b`
    # returns branch + porcelain status in one round-trip, eliminating a
    # separate `rev-parse --abbrev-ref HEAD` call and closing the file-handle
    # leak on TimeoutExpired (design doc item #9).  The `-z -b` format is
    # stable since git 1.7.11 and covers every field the old two-call path used.
    branch = "unknown"
    status_lines: list[str] = []
    _status_total: int = 0
    try:
        sz = _run_git(["status", "-z", "-b"], cwd=cwd, timeout=max(0.1, min(2.0, _remaining())))
        if sz.returncode == 128:
            # Not a git repo — cache the None so repeated calls skip subprocesses
            _brief_cache[cwd] = (None, _mtime_editmsg, _mtime_index, _now_mono)
            return None
        if sz.returncode == 0:
            branch, status_lines, _status_total = _parse_status_z_b(sz.stdout)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None

    # git log --oneline (adaptive count)
    # Skip when we're on clean main/master and local HEAD is in sync with
    # origin/<branch> — the session is at a stable baseline and the recent
    # commit list adds no actionable signal (#26).
    #
    # Item A4: replace two separate rev-parse calls with a single
    # `git rev-list --left-right --count HEAD...origin/<branch>` call.
    # Returns "ahead\tbehind" counts; "0\t0" means in-sync.  One spawn
    # instead of two saves ~30-80 ms on Windows per SessionStart.
    #
    # Item A2: adaptive log entry count — on a clean baseline (empty status,
    # main/master/develop, in-sync with origin) emit only 2 entries instead of 5.
    # A clean session at a stable baseline gains very little from extra SHAs;
    # saving ~40-80 tokens per clean SessionStart is worthwhile.
    log_lines: list[str] = []
    _skip_log = False
    _log_count = 5  # default; may be reduced for clean stable sessions
    if branch in ("main", "master", "develop") and not status_lines:
        _log_skip_budget = _remaining()
        if _log_skip_budget > 0.1:
            try:
                _rl = _run_git(
                    ["rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"],
                    cwd=cwd,
                    timeout=max(0.1, min(0.8, _log_skip_budget)),
                )
                if _rl.returncode == 0:
                    _parts = _rl.stdout.strip().split()
                    if len(_parts) == 2:
                        _ahead, _behind = _parts
                        if _ahead == "0" and _behind == "0":
                            # In-sync: skip the log entirely
                            _skip_log = True
                        elif _ahead == "0":
                            # Behind origin — reduce to 2 to save tokens
                            _log_count = 2
            except (subprocess.TimeoutExpired, OSError):
                pass  # fail-open: if we can't check, emit the log

    log_budget = _remaining()
    if log_budget > 0.1 and not _skip_log:
        try:
            lg = _run_git(["log", "--oneline", f"-{_log_count}"], cwd=cwd, timeout=log_budget)
            if lg.returncode == 0:
                log_lines = [line.strip() for line in lg.stdout.splitlines() if line.strip()]
        except (subprocess.TimeoutExpired, OSError):
            pass

    # When clean and in-sync with origin (log was intentionally skipped),
    # emit a terse one-liner rather than returning None.  This covers the
    # ~30% of sessions that start at a stable baseline: the model still gets
    # branch context without the overhead of a multi-line structured block.
    # Apply only when: no status changes AND branch is a stable branch AND
    # we confirmed in-sync (ahead=0, behind=0) via rev-list above.
    if not status_lines and not log_lines:
        if _skip_log and branch in ("main", "master", "develop"):
            brief = f"{branch} (clean)"
            _brief_cache[cwd] = (brief, _mtime_editmsg, _mtime_index, _now_mono)
            return brief
        _brief_cache[cwd] = (None, _mtime_editmsg, _mtime_index, _now_mono)
        return None

    # Build single-line brief: branch [| status] [— commits]
    parts: list[str] = [branch]

    # Add status if there are any changes
    if status_lines:
        # XY format: X is index (staged), Y is work-tree
        staged = sum(1 for line in status_lines if line[:1] not in (" ", "?", "!"))
        modified = sum(1 for line in status_lines if line[1:2] == "M")
        untracked = sum(1 for line in status_lines if line.startswith("??"))
        counts: list[str] = []
        if staged:
            counts.append(f"{staged} staged")
        if modified:
            counts.append(f"{modified} modified")
        if untracked:
            counts.append(f"{untracked} untracked")
        status_str = ", ".join(counts) if counts else "changes"
        # When the dirty tree is larger than the parse cap (50 entries), append
        # the overflow count so the agent knows the repo is massively dirty
        # without all N files being listed individually.
        truncated = _status_total - len(status_lines)
        if truncated > 0:
            status_str += f" (+{_status_total - len(status_lines)} more files)"
        parts.append(f"| {status_str}")

    # Add recent commits if present (em-dash separator)
    if log_lines:
        # Each commit: "abc1234 message" — keep short (hash + 40 chars max per entry)
        short_commits: list[str] = []
        for entry in log_lines[:5]:
            tokens = entry.split(" ", 1)
            if len(tokens) == 2:
                h, msg = tokens
                msg = msg[:40]
                short_commits.append(f"{h} {msg}")
            else:
                short_commits.append(entry[:50])
        parts.append("— " + " | ".join(short_commits))

    brief = " ".join(parts)
    _LOG.debug("session-start: orientation brief built (%d chars)", len(brief))
    _brief_cache[cwd] = (brief, _mtime_editmsg, _mtime_index, _now_mono)
    return brief


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

    _try_recovery_response(session_id, source)
    # Project detection and worker watchdog must run in both branches —
    # ``source == "compact"`` doesn't change the fact that the worker may
    # have died, or that the project root may need its last-seen bumped.
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        from . import db  # noqa: PLC0415

        db.touch_project_last_seen(proj.hash)
        _auto_index_if_needed(proj)
    _ensure_worker_running()

    if source == "compact":
        # Compact path: cache is preserved; sidecar was already written by
        # _try_recovery_response.  Return immediately — skip the cache reset
        # and git-brief that belong only to the non-compact branch.
        return CONTINUE()

    # Non-compact branch: cache reset happens here, AFTER recovery has had
    # a chance to fire (so a misdetection of source can't both reset the
    # cache and lose the recovery data).
    _reset_session_cache(session_id)

    # Build the git orientation brief (injected as systemMessage so it takes
    # priority over additionalContext and is visible immediately at session start).
    brief: str | None = None
    if cwd:
        try:
            brief = _build_session_brief(cwd)
        except Exception:  # noqa: BLE001
            _LOG.debug("session-start: brief build failed", exc_info=True)

    # Inject project memory facts for the new session (non-compact only —
    # compact sessions preserve prior context and don't need a re-injection).
    mem_ctx: str | None = None
    if proj is not None:
        mem_ctx = _build_startup_context(proj)

    # Combine brief (systemMessage) and project memory (additionalContext) into
    # a single response.  Either or both may be absent.
    if brief or mem_ctx:
        resp: HookResponse = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
            },
        }
        if brief:
            resp["systemMessage"] = brief
        if mem_ctx:
            hso = resp.get("hookSpecificOutput")
            if isinstance(hso, dict):
                hso["additionalContext"] = mem_ctx
        return resp

    return CONTINUE()


# ---------------------------------------------------------------------------
# UserPromptSubmit: inject 1-line session-context summary
# ---------------------------------------------------------------------------


def user_prompt_submit(payload: HookPayload) -> HookResponse:
    """UserPromptSubmit hook: inject a 1-line session-context summary.

    Injects a compact line showing the current git branch, how many files
    have been edited this session, and the last Bash exit code.  This gives
    the model instant orientation without burning a tool call.

    Format: ``[branch: main | edits: 3 | last_exit: 0]``

    All errors are swallowed — the hook must never block prompt submission.
    """
    # Short-circuit for trivial prompts (e.g. "k", "yes", "no", "/help").
    # The session-state context adds no value when the user types fewer than
    # 8 characters; skip the git subprocess and cache load entirely.
    _raw_prompt = payload.get("prompt", "")
    if isinstance(_raw_prompt, str) and len(_raw_prompt.strip()) < 8:
        return CONTINUE()

    session_id, cwd = get_session_context(payload)
    if not session_id:
        return CONTINUE()

    parts: list[str] = []

    # Git branch — fast, reads .git/HEAD via subprocess
    if cwd:
        try:
            r = _run_git(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], timeout=3)
            branch = r.stdout.strip()
            if branch:
                parts.append(f"branch: {branch}")
        except Exception:  # noqa: BLE001
            pass

    # Edit count and last bash exit from session cache
    cache = None
    try:
        from . import session as _session  # noqa: PLC0415

        cache = _session.safe_load(session_id, caller="user-prompt-submit")
        if cache is not None:
            edit_count = len(getattr(cache, "edited_files", set()))
            parts.append(f"edits: {edit_count}")
    except Exception:  # noqa: BLE001
        pass

    # Last Bash exit code from session cache bash history
    try:
        if cache is not None:
            bash_hist = getattr(cache, "bash_history", {})
            if bash_hist:
                latest = max(bash_hist.values(), key=lambda e: getattr(e, "ts", 0), default=None)
                if latest is not None:
                    exit_code = getattr(latest, "exit_code", None)
                    if exit_code is not None:
                        parts.append(f"last_exit: {exit_code}")
    except Exception:  # noqa: BLE001
        pass

    if not parts:
        return CONTINUE()

    summary = "[" + " | ".join(parts) + "]"
    _LOG.debug("user-prompt-submit: injecting context summary: %s", summary)
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": summary,
        },
    }


# ---------------------------------------------------------------------------
# SubagentStop: detect subagent hallucination (claimed work but no disk changes)
# ---------------------------------------------------------------------------

# Sidecar filename written inside sessions_dir() when a suspicious stop fires.
_SUBAGENT_HALLUCINATION_SIDECAR = "subagent_hallucination_flags.jsonl"


def subagent_stop(payload: HookPayload) -> HookResponse:
    """SubagentStop hook: detect when a subagent claimed work but left no disk changes.

    Runs ``git status --porcelain`` in the session's cwd.  If the output is
    empty (no staged, unstaged, or untracked changes) while the session cache
    records at least one edited file, appends a JSON flag record to a per-session
    sidecar so the orchestrator can surface it.

    Flag record shape::

        {"ts": <unix_float>, "session_id": "...", "cwd": "...", "trigger": "SubagentStop"}

    Fail-soft: every error is swallowed so the hook never blocks the harness.
    """
    session_id, cwd = get_session_context(payload)
    if not session_id or not cwd:
        return CONTINUE()

    # Only flag when the session cache records edited files — a subagent that
    # didn't claim edits doesn't need scrutiny.
    try:
        from . import session as _session  # noqa: PLC0415

        cache = _session.safe_load(session_id, caller="subagent-stop")
        if cache is None:
            return CONTINUE()
        edited: set[str] = getattr(cache, "edited_files", set())
        if not edited:
            return CONTINUE()
    except Exception:  # noqa: BLE001
        return CONTINUE()

    # Run git status --porcelain to check for actual disk changes.
    try:
        r = _run_git(["-C", cwd, "status", "--porcelain"], timeout=5)
        git_output = r.stdout.strip()
    except Exception:  # noqa: BLE001
        return CONTINUE()

    if git_output:
        # Disk changes present — subagent did real work, no flag needed.
        return CONTINUE()

    # No disk changes but session cache has edited_files → possible hallucination.
    _LOG.warning(
        "subagent-stop: possible hallucination — session=%s recorded %d edit(s) but git status is clean",
        sanitize_opt(session_id),
        len(edited),
    )
    try:
        import json as _json  # noqa: PLC0415
        import time as _time  # noqa: PLC0415

        from . import paths as _paths  # noqa: PLC0415

        sidecar_dir = _paths.data_dir() / "sessions"
        sidecar_dir.mkdir(parents=True, exist_ok=True)
        sidecar_path = sidecar_dir / _SUBAGENT_HALLUCINATION_SIDECAR
        record = _json.dumps({
            "ts": _time.time(),
            "session_id": session_id,
            "cwd": cwd,
            "trigger": "SubagentStop",
        })
        with sidecar_path.open("a", encoding="utf-8") as fh:
            fh.write(record + "\n")
    except Exception:  # noqa: BLE001
        pass

    return CONTINUE()
