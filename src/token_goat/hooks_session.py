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

import contextlib
import re
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
# Memory-index pruning throttle
# ---------------------------------------------------------------------------

_MEMORY_PRUNE_THROTTLE_H: Final[float] = 24.0


def _prune_memory_index(session_id: str | None, cwd: str | None) -> None:
    """Best-effort, throttled, never-raises: prune dead + dup entries from MEMORY.md.

    Runs at most once per project per ``_MEMORY_PRUNE_THROTTLE_H`` hours via a
    sentinel file.  Atomic rewrite via :func:`paths.atomic_write_text`.
    """
    import time

    try:
        from . import paths

        # Resolve the project slug dir from the session transcript.
        proj_dir: Path | None = None
        if session_id:
            proj_dir = paths.claude_session_project_dir(session_id)

        if proj_dir is None and cwd:
            # Fallback: scan projects dir for the slug matching cwd.
            from pathlib import Path

            cwd_path = Path(cwd).resolve()
            slug = re.sub(r"[^A-Za-z0-9]", "-", str(cwd_path)).strip("-")
            candidate = paths.claude_projects_dir() / slug
            if candidate.is_dir():
                proj_dir = candidate

        if proj_dir is None:
            return

        memory_dir = proj_dir / "memory"
        if not memory_dir.is_dir():
            return

        # Throttle: skip if sentinel mtime < throttle window.
        sentinel_dir = paths.ensure_dir(paths.data_dir() / "memory_prune")
        sentinel = sentinel_dir / f"{proj_dir.name}.last"
        now = time.time()
        with contextlib.suppress(OSError):
            if sentinel.exists() and (now - sentinel.stat().st_mtime) < _MEMORY_PRUNE_THROTTLE_H * 3600:
                return

        from . import memory_prune

        result = memory_prune.prune_index(memory_dir)
        if result.changed:
            _LOG.info(
                "memory-prune: removed %d dead + %d dup entries from %s (~%d tokens saved)",
                len(result.removed_dead),
                len(result.removed_dup),
                proj_dir.name,
                result.tokens_saved,
            )

        import contextlib as _cl
        with _cl.suppress(Exception):  # Update sentinel to suppress reruns; ignore write failures.
            paths.atomic_write_text(sentinel, str(now))

    except Exception:
        _LOG.debug("memory-prune: failed (non-fatal)", exc_info=True)


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
    from . import session

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


def _resume_anchor_for_recovery(
    raw_edited: dict[str, int], cache: object,
) -> str:
    """Return the RESUME anchor string for the recovery hint header.

    Returns the top-edited basename ("auth.py") when edits exist, otherwise
    an empty string.  The blocker fallback ("re-run pytest") is intentionally
    not handled here — that path runs through
    :func:`_build_blocker_section` so the bare command word and the prefix
    have one place to be derived, matching compact.py's sealed-block contract.

    Returns the bare basename — the caller wraps it with the prefix/emoji
    formatting.  The *cache* parameter is accepted but unused; kept for
    symmetry with compact.py::_build_sealed_block so future signal
    sources (e.g. WIP commit titles) can join without a signature change.
    """
    from pathlib import Path as _Path

    from .util import sanitize_surrogates as _san

    if not raw_edited:
        return ""
    try:
        # Reuse _BY_EDIT_COUNT semantics: sort by count desc, then by path
        # so the choice is deterministic on ties.
        top = max(raw_edited.items(), key=lambda kv: (kv[1], kv[0]))
        basename = _Path(top[0]).name or top[0]
        if basename:
            return _san(basename)[:40]
    except Exception:
        pass
    return ""


def _build_blocker_section(cache: object) -> tuple[str, str]:
    """Return ``(section_text, anchor_word)`` for the Blockers part of the hint.

    *section_text* is the rendered ``**Blockers**`` markdown block, or empty
    string when no qualifying failures exist.  *anchor_word* is the first
    token of the most-recent blocker command (e.g. ``"pytest"``) used as a
    fallback RESUME anchor when no edited files are present.

    The blocker selection and error-preview helpers live in
    :mod:`token_goat.compact` — reuse them here so the recovery hint stays
    in lockstep with the pre-compact manifest's vocabulary (✗ cmd  (exit N)
    — preview).  Fail-soft: any error returns ``("", "")``.
    """
    try:
        import time as _time

        from . import compact as _compact_mod

        bash_hist = getattr(cache, "bash_history", None)
        if not isinstance(bash_hist, dict) or not bash_hist:
            return "", ""
        now_ts = _time.time()
        blockers = _compact_mod._select_failed_bash_entries(bash_hist, now_ts)
        if not blockers:
            return "", ""
        lines = ["**Blockers**:"]
        anchor = ""
        lines.extend(_compact_mod._format_blocker_entry(entry) for entry in blockers)
        # Anchor: first non-flag, non-env token of the most-recent blocker.
        try:
            latest = max(blockers, key=lambda e: getattr(e, "ts", 0.0))
            cmd = getattr(latest, "cmd_preview", "")
            for tok in cmd.split():
                if "=" not in tok and not tok.startswith("-"):
                    anchor = tok[:30]
                    break
        except Exception:
            pass
        # Surface the recall command so the agent knows where to fetch the
        # full failing output (the inline preview is one line; the full body
        # has the traceback).
        lines.append(
            "- _retrieve full output via `token-goat bash-output <id>`_"
        )
        return "\n".join(lines), anchor
    except Exception:
        return "", ""


def _build_pending_work_section(
    cache: object,
    raw_edited: dict[str, int],
    bash_entries_in_hint: set[str],
) -> str:
    """Return a ``### Pending Work`` section string, or empty string.

    Scans the session's bash_history for commands that started work but may
    not have finished:

    * **Failed pytest** — a pytest invocation whose exit_code != 0, within the
      last 2 hours.  Reports the count of test failures extracted from stderr/
      stdout preview when available, plus how long ago it ran.
    * **Uncommitted edits** — files in *raw_edited* that have no successful
      ``git commit`` after the most-recent edit.  A ``git commit`` is
      considered successful when its ``exit_code == 0`` and ``cmd_preview``
      starts with ``git commit``.
    * **Non-zero uv run** — a ``uv run`` invocation (that is not pytest) whose
      exit_code != 0 within the last 2 hours.

    Returns at most 3 bullet points.  Returns an empty string when nothing
    actionable is found (fail-soft on any exception).
    """
    import time as _time

    try:
        bash_hist = getattr(cache, "bash_history", None) or {}
        now = _time.time()
        cutoff_2h = now - 7200  # 2-hour window
        items: list[str] = []

        # --- 1. Failed pytest ---
        pytest_failures: list[object] = []
        for be in bash_hist.values():
            preview = getattr(be, "cmd_preview", "").strip().lower()
            if not any(preview.startswith(p) for p in _PYTEST_PREFIXES):
                continue
            exit_code = getattr(be, "exit_code", None)
            if isinstance(exit_code, int) and exit_code != 0:
                ts = getattr(be, "ts", 0.0)
                if ts >= cutoff_2h:
                    pytest_failures.append(be)
        if pytest_failures:
            latest_fail = max(pytest_failures, key=lambda e: getattr(e, "ts", 0.0))
            age_secs = now - getattr(latest_fail, "ts", now)
            if age_secs < 60:
                age_str = f"{int(age_secs)}s ago"
            elif age_secs < 3600:
                age_str = f"{int(age_secs / 60)}m ago"
            else:
                age_str = f"{int(age_secs / 3600)}h ago"
            # Try to parse failure count from output (e.g. "2 failed" in pytest summary).
            fail_count_str = ""
            cmd_preview = getattr(latest_fail, "cmd_preview", "")
            # Attempt to read the cached output and parse "N failed" from it.
            try:
                from . import bash_cache as _bc
                output_id = getattr(latest_fail, "output_id", "")
                if output_id:
                    text = _bc.load_output(output_id)
                    if text:
                        import re as _re
                        m = _re.search(r"(\d+)\s+failed", text)
                        if m:
                            n = int(m.group(1))
                            fail_count_str = f": {n} failure{'s' if n != 1 else ''}"
            except Exception:
                pass
            items.append(f"pytest failed{fail_count_str} (last run {age_str})")

        # --- 2. Uncommitted edits ---
        if raw_edited:
            # Check whether any successful git commit occurred *after* the most
            # recent edit timestamp.  A "successful git commit" is exit_code==0
            # and cmd_preview starting with "git commit" (case-insensitive).
            latest_edit_ts = 0.0
            try:
                for _ep in raw_edited:
                    fe = cache.files.get(_ep)  # type: ignore[union-attr,attr-defined]  # cache typed as object; SessionCache.files dict at runtime
                    if fe is None:
                        continue
                    let = getattr(fe, "last_edit_ts", 0.0)
                    if let > latest_edit_ts:
                        latest_edit_ts = let
            except Exception:
                # Fall back: use current time so any commit is "before"
                latest_edit_ts = now

            last_commit_ts = 0.0
            for be in bash_hist.values():
                preview = getattr(be, "cmd_preview", "").strip().lower()
                if preview.startswith("git commit"):
                    ec = getattr(be, "exit_code", None)
                    if ec == 0:
                        ts = getattr(be, "ts", 0.0)
                        if ts > last_commit_ts:
                            last_commit_ts = ts

            # If there are edits and no successful commit after the last edit,
            # surface the uncommitted files.
            if latest_edit_ts == 0.0 or last_commit_ts < latest_edit_ts:
                import contextlib as _ctx_pw
                import os as _os_pw
                edited_names: list[str] = []
                for _ep in sorted(raw_edited, key=lambda k: raw_edited[k], reverse=True)[:4]:
                    with _ctx_pw.suppress(Exception):
                        bn = _os_pw.path.basename(_ep)
                        edited_names.append(bn or _ep)
                if edited_names:
                    remaining = len(raw_edited) - len(edited_names)
                    suffix = f", +{remaining} more" if remaining > 0 else ""
                    items.append(f"Uncommitted edits: {', '.join(edited_names)}{suffix}")

        # --- 3. Non-zero uv run (non-pytest) ---
        if len(items) < 3:
            uv_failures: list[object] = []
            for be in bash_hist.values():
                preview = getattr(be, "cmd_preview", "").strip().lower()
                # Skip pytest (already handled above) and trivial commands.
                if any(preview.startswith(p) for p in _PYTEST_PREFIXES):
                    continue
                if not preview.startswith("uv run"):
                    continue
                exit_code = getattr(be, "exit_code", None)
                if isinstance(exit_code, int) and exit_code != 0:
                    ts = getattr(be, "ts", 0.0)
                    if ts >= cutoff_2h:
                        uv_failures.append(be)
            if uv_failures:
                latest_uv = max(uv_failures, key=lambda e: getattr(e, "ts", 0.0))
                age_secs = now - getattr(latest_uv, "ts", now)
                age_str = (
                    f"{int(age_secs)}s ago" if age_secs < 60
                    else f"{int(age_secs / 60)}m ago" if age_secs < 3600
                    else f"{int(age_secs / 3600)}h ago"
                )
                cmd_preview = getattr(latest_uv, "cmd_preview", "uv run …")[:50]
                ec = getattr(latest_uv, "exit_code", "?")
                items.append(f"`{cmd_preview}` exited {ec} ({age_str})")

        if not items:
            return ""
        lines = ["### Pending Work"]
        lines.extend(f"- {item}" for item in items[:3])
        return "\n".join(lines)
    except Exception:
        return ""


def _build_key_commands_section(
    has_edited_python: bool,
    has_pytest: bool,
    has_web: bool,
) -> str:
    """Return a ``### Key Commands`` section with 3-5 relevant token-goat commands.

    The section is context-sensitive: which commands are included depends on
    what the session has done (edited Python files, run pytest, fetched URLs).
    ``token-goat map --compact`` is always included as the orientation command.

    Returns the section string (always non-empty).
    """
    lines = ["### Key Commands"]
    if has_edited_python:
        lines.append("- `token-goat symbol <name>` — find a function or class")
        lines.append("- `token-goat read \"file.py::FuncName\"` — read one function")
    if has_pytest:
        lines.append("- `token-goat bash-output <id> --tail 50` — see last test failure")
    if has_web:
        lines.append("- `token-goat web-output <id>` — re-read fetched page")
    lines.append("- `token-goat map --compact` — oriented repo overview (300-token budget)")
    return "\n".join(lines)


def _diff_stats_for_file(session_id: str, file_path: str) -> tuple[int, int] | None:
    """Return ``(added, removed)`` line counts between snapshot and current file.

    Loads the snapshot stored at pre-edit time for *file_path* in *session_id*,
    reads the current file from disk, and computes unified-diff line statistics.
    Returns ``None`` when the snapshot is absent, the file is unreadable, or
    diff computation fails (fail-soft).

    The result is used to annotate edited-file entries in the recovery hint with
    a ``(+N/-M lines)`` badge giving the model a sense of the change magnitude.

    Path lookup strategy: snapshots are stored keyed by the literal path string
    used at write time (e.g. ``C:/path/file.py``), while ``edited_files`` keys
    are normalized (e.g. ``c:/path/file.py`` on Windows).  When the first load
    attempt returns ``None``, a secondary attempt is made with the drive letter
    upper-cased so that hook-stored snapshots are reachable from the normalized
    dict key without platform-specific coupling in the caller.
    """
    import difflib as _difflib

    try:
        from . import snapshots as _snap

        snap_bytes = _snap.load(session_id, file_path)
        if snap_bytes is None:
            # Secondary attempt: snapshots are stored using the literal path string
            # from the agent's tool payload (e.g. "C:\path\file.py" on Windows),
            # but edited_files keys are normalized ("c:/path/file.py").  Try several
            # common variants so the lookup succeeds regardless of which form was
            # used at store time.
            import re as _re_dp
            _candidates: list[str] = []
            # 1. Forward slashes → backslashes (Windows snapshot stored with backslashes)
            _bs = file_path.replace("/", "\\")
            if _bs != file_path:
                _candidates.append(_bs)
            # 2. Uppercase drive letter + backslashes (Windows normalised → native)
            for _fp in [file_path, _bs]:
                _up = _re_dp.sub(r"^([a-z]):[/\\]", lambda m: m.group(1).upper() + ":\\", _fp)
                if _up != _fp:
                    _candidates.append(_up)
            for _alt in _candidates:
                _ab = _snap.load(session_id, _alt)
                if _ab is not None:
                    snap_bytes = _ab
                    break
        if snap_bytes is None:
            return None
        try:
            snap_text = snap_bytes.decode("utf-8", errors="replace")
        except Exception:
            return None
        # Resolve the disk path to read the current file.
        disk_path = file_path
        # Read current file bytes.
        try:
            import pathlib as _pathlib
            current_bytes = _pathlib.Path(disk_path).read_bytes()
            current_text = current_bytes.decode("utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            return None
        snap_lines = snap_text.splitlines(keepends=True)
        current_lines = current_text.splitlines(keepends=True)
        probe = list(_difflib.unified_diff(snap_lines, current_lines, n=0, lineterm=""))
        added = sum(1 for ln in probe if ln[:1] == "+" and not ln.startswith("+++"))
        removed = sum(1 for ln in probe if ln[:1] == "-" and not ln.startswith("---"))
        return added, removed
    except Exception:
        return None


# Approximate chars-per-token ratio used by the recovery hint size guard.
# A real tokenizer is not available in the hook subprocess; 4 chars/token is
# a conservative underestimate for English prose with code mixed in.  Using a
# slight underestimate means the guard fires a little early (better than over-
# running the budget).
_RECOVERY_CHARS_PER_TOKEN: int = 4


def _truncate_recovery_hint(text: str, max_tokens: int = 400) -> str:
    """Truncate *text* to at most *max_tokens* by dropping lower-priority sections.

    Sections are dropped in ascending priority order:
    1. ``### Key Commands`` (lowest: navigational reference, not load-bearing state)
    2. ``### Pending Work`` (medium: useful but reconstructible from bash history)
    3. ``**Symbols**`` (lower than Files/Bash/Web: the symbol list can be re-derived)

    Truncation works at section granularity: an entire section is kept or
    dropped, never split mid-section.  This ensures the surviving sections
    remain coherent even at the cost of using slightly more budget than strictly
    necessary.

    If the text is still over budget after dropping all three sections, the
    function hard-truncates at the character budget and appends an ellipsis.

    Returns the (possibly shortened) text unchanged when it is within budget.
    """
    budget_chars = max_tokens * _RECOVERY_CHARS_PER_TOKEN
    if len(text) <= budget_chars:
        return text

    def _drop_section(body: str, heading_prefix: str) -> str:
        """Return *body* with the first section beginning ``heading_prefix``
        removed.  A section extends from its heading line to (but not including)
        the next blank-line-then-heading sequence or end of string."""
        import re as _re
        # Match the heading and everything up to the next \n\n#-level heading or EOS.
        pat = _re.compile(
            r"(?:^|\n\n)" + _re.escape(heading_prefix) + r"[^\n]*\n(?:[^\n].*\n?)*",
            _re.MULTILINE,
        )
        return pat.sub("", body).lstrip("\n")

    # Drop in priority order.
    for marker in ("### Key Commands", "### Pending Work", "**Symbols**"):
        if len(text) <= budget_chars:
            break
        new_text = _drop_section(text, marker)
        if new_text != text:
            text = new_text

    # Final fallback: hard truncate with ellipsis.
    if len(text) > budget_chars:
        text = text[:budget_chars - 3] + "..."

    return text


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
    from .cache_common import short_output_id as _short_id
    from .compact import _humanize_bytes

    try:
        from . import session as session_mod

        cache = session_mod.load(session_id)
    except (OSError, ValueError) as exc:
        _LOG.debug("recovery hint: failed to load session %s: %s", session_id[:16], exc)
        return None
    if cache.unavailable:
        return None

    # Build full candidate lists first (sorted, floor-filtered) so the
    # allocator sees the true per-section item counts and can reclaim unused
    # budget from empty sections instead of silently dropping high-signal data.
    from operator import attrgetter

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

    # Pre-compute the edited-files map keyed by the same normalised key that
    # files-dict uses, so we can annotate file entries with their edit count.
    # Falling back to a basename match handles the case where the read path and
    # edit path differ only in absolute-vs-relative form.
    from . import paths as _paths_mod

    raw_edited = (
        cache.edited_files if isinstance(cache.edited_files, dict) else {}
    )
    edit_count_by_norm: dict[str, int] = {}
    edit_count_by_basename: dict[str, int] = {}
    import contextlib as _contextlib
    from pathlib import Path as _Path
    for _ep, _ec in raw_edited.items():
        with _contextlib.suppress(Exception):
            edit_count_by_norm[_paths_mod.normalize_key(_ep).lower()] = _ec
        with _contextlib.suppress(Exception):
            _bn = _Path(_ep).name.lower()
            if _bn:
                # Keep the max edit count when multiple paths share a basename.
                edit_count_by_basename[_bn] = max(
                    edit_count_by_basename.get(_bn, 0), _ec,
                )

    def _edit_count_for(entry: object) -> int:
        """Return the edit count for ``entry`` (file dict value), 0 if unedited."""
        try:
            key = getattr(entry, "key", "") or getattr(entry, "rel_or_abs", "")
            if key:
                norm = _paths_mod.normalize_key(str(key)).lower()
                if norm in edit_count_by_norm:
                    return edit_count_by_norm[norm]
            # Fallback: basename match catches absolute-vs-relative mismatches.
            rel = getattr(entry, "rel_or_abs", "")
            if rel:
                from pathlib import Path as _Path
                bn = _Path(rel).name.lower()
                if bn and bn in edit_count_by_basename:
                    return edit_count_by_basename[bn]
        except Exception:
            pass
        return 0

    # Compute the RESUME anchor once (used in the header section below).
    # Priority order mirrors compact.py::_build_sealed_block:
    #   1. Top-edited basename (ongoing work)
    #   2. First-word of the most-recent blocker command (most-recent attempt)
    # Both helpers fail-soft to "" when their inputs are missing.
    resume_anchor = _resume_anchor_for_recovery(raw_edited, cache)

    # -1. Edited files — highest-value recovery context. Surfaces the files
    # the agent was actively modifying, sorted by edit count desc. This section
    # complements the annotated Files section below: it covers files that were
    # edited but never read (so absent from cache.files) and ensures
    # heavily-edited files appear first regardless of read recency.
    # Cap at 5 entries so the section stays under ~60 tokens.
    # Diff stats: try to annotate each entry with (+N/-M lines) from snapshots.
    if raw_edited:
        import contextlib as _contextlib2
        import os as _os2
        edited_sorted = sorted(raw_edited.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
        edited_lines = ["**Edited**:"]
        for _ep, _ec in edited_sorted[:5]:
            # Compute diff stats from snapshot (best-effort; None → omit badge).
            # The snapshot is keyed by the original path Claude used (rel_or_abs),
            # while _ep is the normalized key.  Try rel_or_abs first (from the
            # FileEntry if present), then fall back to the normalized key.
            _snap_path = _ep
            with _contextlib2.suppress(Exception):
                _fe = cache.files.get(_ep)  # type: ignore[union-attr,attr-defined]  # cache typed as object; SessionCache.files dict at runtime
                if _fe is not None and getattr(_fe, "rel_or_abs", ""):  # type: ignore[arg-type]  # getattr returns object; non-empty string is truthy
                    _snap_path = _fe.rel_or_abs  # type: ignore[attr-defined]  # FileEntry.rel_or_abs; _fe is object-typed by dict.get()
            _diff = _diff_stats_for_file(session_id, _snap_path)
            if _diff is None and _snap_path != _ep:
                # Fallback: try the normalized key form
                _diff = _diff_stats_for_file(session_id, _ep)
            if _diff is not None:
                _added, _removed = _diff
                _diff_str = f" (+{_added}/-{_removed})"
            else:
                _diff_str = ""
            _basename = _ep
            with _contextlib2.suppress(Exception):
                _basename = _os2.path.basename(_ep) or _ep
            edited_lines.append(f"- {_basename} ✎×{_ec}{_diff_str}")
        dropped_edited = len(raw_edited) - len(edited_sorted[:5])
        if dropped_edited > 0:
            edited_lines.append(f"- +{dropped_edited} more")
        sections.append("\n".join(edited_lines))

    # -0.5. Last bash commands — compact recap of commands NOT already covered
    # by the full Bash section below (i.e. commands whose output is below the
    # _RECOVERY_MIN_BYTES threshold). This surfaces small-output commands like
    # `git commit`, `git push`, or a quick `uv run ruff check --fix` that would
    # otherwise be invisible. Commands already in bash_entries are skipped here
    # to avoid duplication.
    # Gate: only emit when there are edited files (context is worth surfacing)
    # or when there are >= 2 bash history entries. A single trivial command
    # (e.g. ls) with no edits is noise, not signal.
    _has_meaningful_bash = bool(raw_edited) or len(cache.bash_history) >= 2
    if cache.bash_history and _has_meaningful_bash:
        import datetime as _datetime2
        _bash_entry_ids = {be.output_id for be in bash_entries}
        _small_cmds = sorted(
            (
                be for be in cache.bash_history.values()
                if be.output_id not in _bash_entry_ids
            ),
            key=lambda be: be.ts, reverse=True,
        )[:3]
        if _small_cmds:
            cmd_lines = ["**Last commands**:"]
            for _be in _small_cmds:
                _ts_str = _datetime2.datetime.fromtimestamp(_be.ts).strftime("%H:%M")
                _exit_str = "" if _be.exit_code is None else f" exit={_be.exit_code}"
                cmd_lines.append(f"- `{_be.cmd_preview}`{_exit_str} @ {_ts_str}")
            sections.append("\n".join(cmd_lines))

    # 0. Loaded skills — single-line format matching compact.py's manifest.
    # Deduplicate by skill name to avoid listing the same skill multiple times
    # if it was updated mid-session, and flag stale skills (loaded 6+ hours ago).
    if skill_entries:
        import time as _time
        now = _time.time()
        stale_threshold = 6 * 3600  # 6 hours, mirrors compact.py::_SKILL_STALE_FOR_SESSION_SECS

        # Deduplicate: keep only the most-recent ts per skill name.
        # Two-pass dedup: first collect all unique skill names across the full
        # skill_all list (for accurate overflow count), then deduplicate the
        # visible slice (skill_entries) for rendering.
        all_unique_names: set[str] = {
            sn for se in skill_all
            if (sn := getattr(se, "skill_name", ""))
        }
        deduped_skills: dict[str, object] = {}
        for se in skill_entries:
            sname = getattr(se, "skill_name", "")
            ts = getattr(se, "ts", 0.0)
            if sname and (sname not in deduped_skills or ts > getattr(deduped_skills[sname], "ts", 0.0)):
                deduped_skills[sname] = se

        # Sort by ts descending and flag stale ones
        sorted_skills = sorted(deduped_skills.values(), key=lambda s: getattr(s, "ts", 0.0), reverse=True)
        skill_parts = []
        for se in sorted_skills[:8]:
            sname = getattr(se, "skill_name", "?")
            ts = getattr(se, "ts", 0.0)
            age_secs = now - ts
            stale_marker = ""
            if age_secs > stale_threshold:
                age_hours = int(age_secs / 3600)
                stale_marker = f" (stale: {age_hours}h)"
            skill_parts.append(f"{sname}{stale_marker}")

        # Overflow count: use unique skill names from skill_all so repeated
        # loads of the same skill (run_count > 1) don't inflate the "+N more"
        # counter — we only report unique skills not shown in the visible slice.
        shown_names = {getattr(se, "skill_name", "") for se in sorted_skills[:8]}
        dropped = len(all_unique_names - shown_names)
        suffix = f", +{dropped} more" if dropped > 0 else ""
        skill_str = ", ".join(skill_parts) + suffix
        # Use ### heading for consistency with the pre-compact manifest format
        # (compact.py uses "### Active Skills").  Inline colon form keeps the
        # skill names on the same line as the header so downstream consumers
        # can extract them with a single line scan.
        skill_header = "### Active Skills"
        line = f"{skill_header}: {skill_str} (recall via `token-goat skill-body <name>`)"
        sections.append(line)

    # 0.25. Active task list — pending and in-progress tasks from Claude's
    # TaskList (``~/.claude/tasks/<session_id>/``).  After compaction the agent
    # loses awareness of open tasks; surfacing them here restores the "what was
    # I working on?" thread without requiring a full /compact-recall cycle.
    # Reuses compact.py's ``_load_task_list`` + ``_render_tasks_section`` so
    # the format is identical to the pre-compact manifest's ### TODOs section.
    try:
        from . import compact as _compact_tasks
        _raw_tasks = _compact_tasks._load_task_list(session_id)
        if _raw_tasks:
            _task_lines = _compact_tasks._render_tasks_section(
                _raw_tasks,
                edited_paths=set(raw_edited.keys()),
            )
            if _task_lines:
                sections.append("\n".join(_task_lines))
    except Exception:
        pass

    # 0.5. Active blockers — failed bash commands within the blocker window.
    # The post-compact agent's most-load-bearing question is "what was failing?";
    # surfacing it with an error preview from the cached output gives a
    # one-glance answer without re-running the failing command to diagnose.
    blocker_section, blocker_anchor = _build_blocker_section(cache)
    if blocker_section:
        sections.append(blocker_section)
        # If no edit anchor was available, fall back to the blocker command word
        # so the RESUME line always points somewhere when there is something
        # actionable in the hint.
        if not resume_anchor and blocker_anchor:
            resume_anchor = f"re-run {blocker_anchor}"

    # 1. Recently-touched files — the agent will likely want these back.
    # Use ### heading for consistency with the pre-compact manifest format
    # (compact.py uses "### Files Edited" for the equivalent section).
    if files_keep:
        lines = ["### Edited Files"]
        for entry in files_keep:
            sym_count = len(entry.symbols_read)
            if sym_count > 3:
                sym_str = f" syms={','.join(entry.symbols_read[:3])}+{sym_count - 3}"
            elif sym_count:
                sym_str = f" syms={','.join(entry.symbols_read)}"
            else:
                sym_str = ""
            # Edit count badge: surfaces actively-worked files at a glance.
            # ✎×N is the same notation used in compact.py's sealed block so a
            # developer comparing pre- and post-compact outputs sees a stable
            # vocabulary.  Only emit for count >= 1 to avoid noise on read-only entries.
            ec = _edit_count_for(entry)
            edit_str = f" ✎×{ec}" if ec >= 1 else ""
            lines.append(f"- {entry.rel_or_abs}{edit_str}{sym_str}")
        dropped = len(files_all) - len(files_keep)
        if dropped > 0:
            lines.append(f"- +{dropped} more")
        sections.append("\n".join(lines))

    # 1.5. Symbol cross-references — most-accessed symbols across edited and read
    # files.  Provides the post-compact agent with precise entry points (file +
    # line number) for the symbols it was working with, so it can navigate
    # directly to the right location without re-scanning whole files.
    #
    # Source priority:
    #   1. symbols_read with symbols_ts (gives per-symbol timestamps for recency sort)
    #   2. symbols_read without timestamps (sort by file recency then alpha)
    #   3. Edited files that have corresponding session file entries with symbols
    # Cap: 10 symbols, one line each.  Format: "SymbolName (file.py:Lstart)"
    # where the line number comes from symbols_ts access order when available.
    _MAX_SYMBOLS_RECOVERY: int = 10
    _symbol_entries: list[tuple[float, str, str, int]] = []  # (ts, symbol, rel_path, line_hint)
    for _fe in cache.files.values():
        _rel = getattr(_fe, "rel_or_abs", "") or ""
        _syms = getattr(_fe, "symbols_read", None) or []
        _sym_ts = getattr(_fe, "symbols_ts", None) or {}
        _file_ts = getattr(_fe, "last_read_ts", 0.0)
        for _sym in _syms:
            _ts = _sym_ts.get(_sym, _file_ts)
            _symbol_entries.append((_ts, _sym, _rel, 0))

    if _symbol_entries:
        import os as _os_sym

        # Sort by timestamp descending (most-recently-accessed first), then alpha.
        _symbol_entries.sort(key=lambda e: (-e[0], e[1]))
        # Deduplicate: keep first occurrence of each symbol name.
        _seen_syms: set[str] = set()
        _deduped_syms: list[tuple[float, str, str, int]] = []
        for _entry in _symbol_entries:
            if _entry[1] not in _seen_syms:
                _seen_syms.add(_entry[1])
                _deduped_syms.append(_entry)

        _top_syms = _deduped_syms[:_MAX_SYMBOLS_RECOVERY]
        if _top_syms:
            sym_lines = ["**Symbols**:"]
            for _ts, _sym, _rel, _line in _top_syms:
                _basename = _os_sym.path.basename(_rel) if _rel else "?"
                sym_lines.append(f"- {_sym} ({_basename})")
            sections.append("\n".join(sym_lines))

    # 2. Recent Bash output IDs — the most likely "I had this in context" data.
    if bash_entries:
        import datetime

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

    # 4. Pending work — surface unfinished tasks the agent may need to resume.
    # This section is appended after the inventory sections so it reads as
    # "here is what you were doing, and here is what was left unfinished".
    _bash_in_hint_ids: set[str] = {be.output_id for be in bash_entries}
    pending_section = _build_pending_work_section(cache, raw_edited, _bash_in_hint_ids)
    if pending_section:
        sections.append(pending_section)

    # 5. Key commands — context-sensitive reminder of the most useful token-goat
    # CLI commands for this session.  Always appended last (lowest priority for
    # truncation) because it is navigational reference, not load-bearing state.
    _has_edited_python = any(
        getattr(entry, "rel_or_abs", "").endswith(".py")
        for entry in files_keep
    ) or any(str(ep).endswith(".py") for ep in raw_edited)
    _has_pytest_in_hint = any(
        any(getattr(be, "cmd_preview", "").strip().lower().startswith(p) for p in _PYTEST_PREFIXES)
        for be in bash_entries
    ) or any(
        any(getattr(be, "cmd_preview", "").strip().lower().startswith(p) for p in _PYTEST_PREFIXES)
        for be in (getattr(cache, "bash_history", {}) or {}).values()
    )
    _has_web_in_hint = bool(web_entries)
    key_cmds_section = _build_key_commands_section(
        _has_edited_python, _has_pytest_in_hint, _has_web_in_hint,
    )
    sections.append(key_cmds_section)

    parts = ["## Post-Compact Recovery"]

    # --- Session goal inference ---
    # Infer what the session was trying to accomplish from edited files, symbols,
    # and bash history. This gives the post-compact agent immediate context
    # without requiring them to reconstruct intent from file names alone.
    try:
        from . import compact as _compact_mod
        session_goal = _compact_mod.infer_session_goal(cache)
        if session_goal:
            parts.append(f"**Session goal:** {session_goal}")
    except Exception:
        pass  # fail-soft: missing goal is not critical

    # RESUME pointer — same anchor format as compact.py's sealed block, so the
    # pre-compact manifest's 🎯 RESUME line carries straight through to the
    # post-compact recovery hint without translation.  Tells the agent in one
    # glance which single file/command is the load-bearing thread to pick up.
    if resume_anchor:
        parts.append(f"🎯 **RESUME**: {resume_anchor}")
    # One-shot restoration shortcut: emit the resume command next so the agent
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
    hint_text = "\n\n".join(parts)
    # Apply the 800-token size guard: drop lower-priority sections when over
    # budget so the surviving hint stays coherent and within budget.
    return _truncate_recovery_hint(hint_text)


def _read_precompact_estimate() -> int:
    """Return the bytes_estimate from the most recently written precompact estimate sentinel.

    The PreCompact hook writes ``sentinels/precompact_estimate_{session_id}.json``
    immediately after loading the session cache (before compaction destroys the
    bash/web history).  This function scans the sentinels directory for all such
    files, picks the newest one written within the last 5 minutes, reads its
    ``bytes_estimate`` field, and deletes the file.

    Returns 0 when no suitable sentinel is found (fail-soft).
    """
    import json as _json
    import time as _time

    try:
        from . import paths as _paths

        sentinels = _paths.sentinels_dir()
        if not sentinels.exists():
            return 0
        # Find all precompact_estimate_*.json files written within the last 5 minutes.
        cutoff = _time.time() - 300.0
        candidates = []
        for p in sentinels.glob("precompact_estimate_*.json"):
            try:
                mtime = p.stat().st_mtime
                if mtime >= cutoff:
                    candidates.append((mtime, p))
            except OSError:
                continue
        if not candidates:
            return 0
        # Pick the most recently written estimate sentinel.
        candidates.sort(key=lambda x: x[0], reverse=True)
        _, best = candidates[0]
        try:
            data = _json.loads(best.read_text(encoding="utf-8"))
            estimate = int(data.get("bytes_estimate", 0))
        except (OSError, ValueError, TypeError):
            estimate = 0
        # Delete the sentinel so it is not consumed again.
        import contextlib as _contextlib
        with _contextlib.suppress(OSError):
            best.unlink(missing_ok=True)
        _LOG.debug(
            "session-start: read precompact estimate %d bytes from %s",
            estimate, best.name,
        )
        return max(0, estimate)
    except Exception:
        return 0


def _try_recovery_response(session_id: str | None, source: str) -> HookResponse | None:
    """Defer a recovery hint by writing a sidecar when *source* is "compact".

    Instead of injecting the recovery hint immediately at SessionStart, this
    function writes the hint payload to a ``sentinels/recovery_pending_{session_id}``
    sidecar file and returns ``None`` (CONTINUE).  The pre-read hook in
    ``hooks_read.py`` checks for this sidecar on the first ``PreToolUse(Read)``
    or ``PreToolUse(Bash)`` after compaction, injects it there, and deletes the
    file.  This defers the token cost to the moment when the agent actually
    needs the context (item 2 — deferred recovery hint).

    The sidecar is stored as a JSON payload::

        {"hint": "<hint text>", "bytes_estimate": N}

    The ``bytes_estimate`` is read from the precompact estimate sentinel written
    by the PreCompact hook (``precompact_estimate_{session_id}.json``).  This
    ensures the stat pair recorded when the hint fires reflects the pre-compaction
    bash/web history size rather than the (empty) new session cache.

    Returns ``None`` in all cases so the caller always falls through to the
    normal session-start flow.  A writing failure is logged but does not
    prevent the session from continuing — the recovery hint is advisory and
    its loss is benign.
    """
    import json as _json

    if source != "compact" or not session_id:
        return None
    hint = _build_recovery_hint(session_id)
    if not hint:
        return None

    # Recover the bytes estimate from the PreCompact-phase sentinel.  The
    # pre-compact hook wrote it when the session cache still had bash/web
    # history; by the time we reach here (post-compact SessionStart) the
    # new session cache is empty.
    bytes_estimate = _read_precompact_estimate()

    # Write the hint + estimate as JSON to the sidecar for deferred injection.
    try:
        from . import paths

        payload = _json.dumps(
            {"hint": hint, "bytes_estimate": bytes_estimate},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        sidecar = paths.recovery_pending_path(session_id)
        paths.atomic_write_text(sidecar, payload)
        _LOG.info(
            "session-start: compact-recovery hint deferred to sidecar for session=%s"
            " (%d chars, bytes_estimate=%d)",
            session_id[:16], len(hint), bytes_estimate,
        )
    except Exception:
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
    skip_next = False

    for field in fields:
        if not field:
            continue
        if skip_next:
            skip_next = False
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
            # Porcelain v1-style "XY filename"; for renames/copies the *next*
            # NUL-delimited field is the old/source name — skip it so we only
            # count the destination.
            xy = field[:2]
            if xy[0] in ("R", "C") or xy[1] in ("R", "C"):
                skip_next = True
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
    import os
    import time

    # Feature gate: env var override (checked first, cheapest)
    env_val = os.environ.get("TOKEN_GOAT_SESSION_BRIEF", "").strip().lower()
    if env_val in ("0", "false", "no", "off"):
        return None

    # Feature gate: config file
    try:
        from . import config as cfg_mod

        cfg = cfg_mod.load()
        if not cfg.session_brief.enabled:
            return None
    except Exception:
        pass  # fail-open: config load errors don't suppress the brief

    try:
        import pathlib

        cwd_path = pathlib.Path(cwd)
        if not cwd_path.is_dir():
            return None
    except Exception:
        return None

    # --- Git-state fingerprint (two stat calls, ~0.2 ms total) ---
    # Stat .git/COMMIT_EDITMSG and .git/index to detect new commits or
    # staged changes without running any git subprocess.
    import contextlib
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

    import subprocess
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
    from .project import find_project

    return find_project(cwd_path)


def _auto_index_if_needed(proj: Project) -> None:
    """Auto-index unindexed projects on first contact."""
    try:
        from . import db, worker

        if not db.project_has_files(proj.hash):
            pid = worker.spawn_index_detached(str(proj.root), proj.hash)
            if pid:
                _LOG.info(
                    "session-start: auto-indexing %s in background (pid=%s)",
                    proj.root,
                    pid,
                )
            else:
                _LOG.warning(
                    "session-start: auto-index spawn returned no PID for %s; "
                    "indexing may be already active or spawn failed; "
                    "check index-spawn.log for details",
                    proj.root,
                )
        else:
            _LOG.debug(
                "session-start: project %s already indexed; skipping auto-index",
                proj.hash[:8],
            )
    except Exception:
        _LOG.exception("auto-index spawn failed")


# How old (in seconds) the index must be before we emit a stale-index hint.
# Default: 1 hour.  Overridable via ``TOKEN_GOAT_INDEX_STALE_SECS`` env var.
_INDEX_STALE_SECS: int = 3600


def _index_stale_hint(proj: Project) -> str | None:
    """Return a stale-index hint string when the project index is more than
    :data:`_INDEX_STALE_SECS` seconds old, or ``None`` when the index is fresh
    or the age cannot be determined.

    The hint is a single line such as::

        Index may be stale (last indexed 3h ago) — run `token-goat index` to refresh.

    Designed to be appended to the session-start ``additionalContext`` so agents
    know when symbol results may be outdated without having to diagnose stale
    results after the fact.

    Fail-soft: any error returns ``None`` so a broken DB never blocks startup.
    """
    import os as _os
    import time as _time

    try:
        stale_secs = int(_os.environ.get("TOKEN_GOAT_INDEX_STALE_SECS", _INDEX_STALE_SECS))
    except (ValueError, TypeError):
        stale_secs = _INDEX_STALE_SECS

    try:
        from . import db as _db

        last_ts = _db.project_last_indexed_ts(proj.hash)
        if last_ts == 0.0:
            # Never indexed — auto-indexing handles this; no stale hint needed.
            return None
        age = _time.time() - last_ts
        if age <= stale_secs:
            return None

        # Format the age in a human-readable way.
        if age < 3600:
            age_str = f"{int(age / 60)}m ago"
        elif age < 86400:
            age_str = f"{int(age / 3600)}h ago"
        else:
            age_str = f"{int(age / 86400)}d ago"

        return (
            f"Index may be stale (last indexed {age_str})"
            " — run `token-goat index` to refresh."
        )
    except Exception:
        return None


def _build_startup_context(proj: Project) -> str | None:
    """Build additionalContext from project memory for the session-start response.

    Returns None when the project has no stored memory entries.
    """
    try:
        from . import project_memory

        return project_memory.build_injection(proj.hash)
    except Exception:
        _LOG.debug("session-start: project memory injection failed", exc_info=True)
        return None


def _ensure_worker_running() -> None:
    """Watchdog: start or verify worker daemon is alive."""
    try:
        from . import worker

        pid = worker.ensure_running()
        if pid:
            _LOG.info("session-start: worker pid=%s", pid)
    except Exception:
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


def _maybe_baseline_advisory(session_id: str | None, cwd: str | None) -> str | None:
    """Return a one-line environmental-baseline advisory, or ``None``.

    Opt-in via ``[hints] baseline_budget_tokens`` (default 0 = off). When the
    budget is positive and the cheap *fixed* baseline — the recurring
    every-session sources a fresh window pays for (both CLAUDE.md files,
    MEMORY.md, MCP instruction blocks, and any other plugin's recurring
    SessionStart dump) — exceeds it, emit one quiet line pointing at
    ``token-goat baseline`` for the per-source breakdown.

    The estimate is file-stat based (no transcript parse) and uses the same
    ``bytes // 4`` convention as ``token-goat doctor`` so the numbers reconcile.
    Only the *fixed* total is gated on: variable, prompt-driven pushes are
    deliberately excluded so a one-off does not trip a recurring advisory.

    Deduped to once per session via a sentinel written only when the advisory
    actually fires — so an under-counting cold start (dumps not yet on disk)
    can still trip on a later resume. Fully fail-soft: any error returns
    ``None`` and the sentinel is left untouched.
    """
    if not session_id:
        return None
    try:
        from . import config as _config

        budget = _config.load().hints.baseline_budget_tokens
    except Exception:
        return None
    if budget <= 0:
        return None
    try:
        from . import paths as _paths

        sentinel = _paths.baseline_advisory_sent_path(session_id)
        if sentinel.exists():
            return None
    except Exception:
        return None
    try:
        from pathlib import Path

        from . import baseline as _baseline

        base = Path(cwd) if cwd else Path.cwd()
        fixed = _baseline.collect_baseline(base, session_id).fixed_tokens
    except Exception:
        return None
    if fixed <= budget:
        return None
    try:
        _paths.atomic_write_text(sentinel, "1")
    except Exception:
        _LOG.debug("session-start: baseline advisory sentinel write failed", exc_info=True)
    return (
        f"[token-goat] Environmental baseline is ~{fixed:,} fixed tokens "
        f"(over the {budget:,}-token budget). Run `token-goat baseline` to see "
        "which sources cost the most and how to trim them."
    )


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

    # Best-effort stale session cleanup: remove session JSON files older than
    # 7 days.  This supplements the worker's periodic _cleanup_old_sessions
    # task and ensures cleanup happens even when the worker is not running.
    # The 7-day cutoff matches _SESSION_RETENTION_DAYS in worker.py.
    # All errors are suppressed — cleanup must never block session startup.
    try:
        from . import session as _session
        _cleaned = _session.cleanup_stale(max_age_hours=168.0)
        if _cleaned:
            _LOG.info("session-start: cleaned up %d stale session file(s) (>7d)", _cleaned)
    except Exception:
        _LOG.debug("session-start: stale session cleanup failed (non-fatal)", exc_info=True)

    _try_recovery_response(session_id, source)
    # Project detection and worker watchdog must run in both branches —
    # ``source == "compact"`` doesn't change the fact that the worker may
    # have died, or that the project root may need its last-seen bumped.
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        from . import db

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

    # Best-effort: prune dead + dup MEMORY.md entries (throttled 24 h, never raises, atomic rewrite).
    _prune_memory_index(session_id, cwd)

    # Build the git orientation brief (injected as systemMessage so it takes
    # priority over additionalContext and is visible immediately at session start).
    brief: str | None = None
    if cwd:
        try:
            brief = _build_session_brief(cwd)
        except Exception:
            _LOG.debug("session-start: brief build failed", exc_info=True)

    # Inject project memory facts for the new session (non-compact only —
    # compact sessions preserve prior context and don't need a re-injection).
    mem_ctx: str | None = None
    stale_hint: str | None = None
    if proj is not None:
        mem_ctx = _build_startup_context(proj)
        stale_hint = _index_stale_hint(proj)

    # Merge project memory and stale-index hint into a single additionalContext
    # string.  Either or both may be absent; if the stale hint fires without
    # any memory content it is still surfaced on its own.
    additional_ctx_parts: list[str] = []
    if mem_ctx:
        additional_ctx_parts.append(mem_ctx)
    if stale_hint:
        additional_ctx_parts.append(stale_hint)
    # Opt-in environmental-baseline advisory (default off). Folded in here so it
    # rides the existing additionalContext response; deduped once-per-session.
    baseline_advisory = _maybe_baseline_advisory(session_id, cwd)
    if baseline_advisory:
        additional_ctx_parts.append(baseline_advisory)
    combined_mem: str | None = "\n\n".join(additional_ctx_parts) if additional_ctx_parts else None

    # Combine brief (systemMessage) and project memory (additionalContext) into
    # a single response.  Either or both may be absent.
    if brief or combined_mem:
        resp: HookResponse = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
            },
        }
        if brief:
            resp["systemMessage"] = brief
        if combined_mem:
            hso = resp.get("hookSpecificOutput")
            if isinstance(hso, dict):
                hso["additionalContext"] = combined_mem
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
        except Exception:
            pass

    # Edit count and last bash exit from session cache
    cache = None
    try:
        from . import session as _session

        cache = _session.safe_load(session_id, caller="user-prompt-submit")
        if cache is not None:
            edit_count = len(getattr(cache, "edited_files", {}))
            parts.append(f"edits: {edit_count}")
    except Exception:
        pass

    # Last Bash exit code from session cache bash history
    with contextlib.suppress(Exception):
        if cache is not None:
            bash_hist = getattr(cache, "bash_history", {})
            if bash_hist:
                latest = max(bash_hist.values(), key=lambda e: getattr(e, "ts", 0), default=None)
                if latest is not None:
                    exit_code = getattr(latest, "exit_code", None)
                    if exit_code is not None:
                        parts.append(f"last_exit: {exit_code}")

    # Context threshold advisory — fires on first crossing of 50% / 70%, or every
    # turn above 85% (urgency zone).  Gates on config [hints] context_threshold_advisory.
    _ctx_advisory_prefix: str | None = None
    try:
        from . import config as _cfg_mod

        _hints_cfg = _cfg_mod.load().hints
        if _hints_cfg.context_threshold_advisory and cache is not None:
            cache.turns_since_last_compact = getattr(cache, "turns_since_last_compact", 0) + 1

            from .compact import get_context_pressure

            _pressure = get_context_pressure(getattr(cache, "session_id", None), cache=cache)
            _ctx_pct = _pressure.fill_fraction
            _pct_int = int(_ctx_pct * 100)
            _last_thr = getattr(cache, "last_context_advisory_threshold", None)

            if _ctx_pct >= 0.85:
                _ctx_advisory_prefix = f"CONTEXT ~{_pct_int}% full. /compact now. "
            elif _ctx_pct >= 0.70 and _last_thr != 70:
                cache.last_context_advisory_threshold = 70
                _ctx_advisory_prefix = f"CONTEXT ~{_pct_int}% full. Consider /compact soon. "
            elif _ctx_pct >= 0.50 and _last_thr is None:
                cache.last_context_advisory_threshold = 50
                parts.append(f"ctx: ~{_pct_int}% — context approaching midpoint")

            from . import session as _ses_save
            _ses_save.save(cache)
    except Exception:
        pass

    # Keyword-triggered hints: check prompt words against configured prompt_triggers.
    # Fires even when parts is empty so keyword hints can stand alone.
    _keyword_hints: list[str] = []
    try:
        from . import config as _cfg_kw

        _triggers = _cfg_kw.load().hints.prompt_triggers
        if _triggers and isinstance(_raw_prompt, str) and _raw_prompt.strip():
            import re as _re
            _prompt_words = set(_re.sub(r"[^a-z0-9]", " ", _raw_prompt.lower()).split())
            _keyword_hints.extend(_trig.hint for _trig in _triggers if any(kw in _prompt_words for kw in _trig.keywords))
    except Exception:
        pass

    if not parts and _ctx_advisory_prefix is None and not _keyword_hints:
        return CONTINUE()

    _summary_parts = list(parts)
    _summary_parts.extend(f"hint: {_kh}" for _kh in _keyword_hints)

    if _ctx_advisory_prefix is not None:
        summary = "[" + _ctx_advisory_prefix + " | ".join(_summary_parts) + "]"
    else:
        summary = "[" + " | ".join(_summary_parts) + "]"
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
    from . import session as _session

    cache = _session.safe_load(session_id, caller="subagent-stop")
    if cache is None:
        return CONTINUE()
    edited: dict[str, int] = getattr(cache, "edited_files", {})
    if not edited:
        return CONTINUE()

    # Run git status --porcelain to check for actual disk changes.
    r = _run_git(["-C", cwd, "status", "--porcelain"], timeout=5)
    git_output = r.stdout.strip()

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
        import json as _json
        import time as _time

        from . import paths as _paths

        sidecar_dir = _paths.ensure_dir(_paths.sessions_dir())
        sidecar_path = sidecar_dir / _SUBAGENT_HALLUCINATION_SIDECAR
        record = _json.dumps({
            "ts": _time.time(),
            "session_id": session_id,
            "cwd": cwd,
            "trigger": "SubagentStop",
        })
        with sidecar_path.open("a", encoding="utf-8") as fh:
            fh.write(record + "\n")
    except Exception:
        pass

    return CONTINUE()
