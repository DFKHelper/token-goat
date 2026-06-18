"""Single-command post-compact restoration packet (item 25).

``token-goat resume <session_id>`` emits a structured context bundle that
replaces 5–10 individual recall round-trips the agent would otherwise need
after a compaction event:

  1. Skill checklists inline (up to 3 skills, ≤ 400 chars each).
  2. Last 2 Bash outputs — first 20 + last 20 lines with a gap marker.
  3. Per-file diffs for the top 2 edited files (``git diff HEAD <path>``).
  4. Current git diff stat summary.

Each section carries a freshness annotation (``as of HH:MM``) so the agent
can judge staleness without running additional commands.  Total output is
hard-capped at :data:`_MAX_RESUME_TOKENS` (≈ 2000 tokens ≈ 8000 chars) so
one command cannot balloon the context unexpectedly.
"""
from __future__ import annotations

__all__ = ["build_resume_packet"]

import time
from typing import Final

_MAX_RESUME_TOKENS: Final[int] = 2000
# Approximate chars-per-token for the hard cap.  Conservative (4 chars/tok)
# so we stay safely under the limit even for code-heavy content.
_CHARS_PER_TOKEN: Final[int] = 4
_MAX_RESUME_CHARS: Final[int] = _MAX_RESUME_TOKENS * _CHARS_PER_TOKEN  # 8000

# Per-section char budgets (soft limits; hard cap enforced at assembly time).
_SKILL_MAX_CHARS_EACH: Final[int] = 400
_SKILL_MAX_COUNT: Final[int] = 3
_BASH_HEAD_LINES: Final[int] = 20
_BASH_TAIL_LINES: Final[int] = 20
_BASH_MAX_COUNT: Final[int] = 2
_DIFF_MAX_COUNT: Final[int] = 2


def _now_hhmm() -> str:
    """Return the current local time as HH:MM."""
    return time.strftime("%H:%M")


def _ts_hhmm(ts: float) -> str:
    """Return *ts* (unix timestamp) as HH:MM local time."""
    return time.strftime("%H:%M", time.localtime(ts))


def _head_tail(lines: list[str], head: int, tail: int) -> str:
    """Return head + gap + tail, or the full list when it is short enough."""
    n = len(lines)
    if n <= head + tail:
        return "\n".join(lines)
    head_part = lines[:head]
    tail_part = lines[n - tail:]
    gap = f"--- {n - head - tail} lines omitted ---"
    return "\n".join(head_part) + "\n" + gap + "\n" + "\n".join(tail_part)


def _load_bash_output(output_id: str) -> str | None:
    """Load cached bash output text by output_id. Fail-soft."""
    try:
        from . import bash_cache
        return bash_cache.load_output(output_id)
    except Exception:
        return None


def _inline_diff(path: str, cwd: str | None) -> str | None:
    """Return a short git diff for *path* using compact._get_inline_diff_for_file."""
    if not cwd:
        return None
    try:
        from .compact import _get_inline_diff_for_file
        return _get_inline_diff_for_file(path, cwd)
    except Exception:
        return None


def _git_diff_stat(cwd: str | None) -> str:
    """Return the git diff stat summary using compact._get_git_diff_stat_summary."""
    if not cwd:
        return ""
    try:
        from .compact import _get_git_diff_stat_summary
        return _get_git_diff_stat_summary(cwd)
    except Exception:
        return ""


def build_resume_packet(session_id: str) -> str:
    """Build and return the full resume packet for *session_id*.

    Assembles up to four sections:

    1. **Skills** — checklist excerpts (≤ 400 chars each, up to 3 skills).
    2. **Bash** — head+tail views of the last 2 cached bash outputs.
    3. **Diffs** — ``git diff HEAD`` for the top 2 edited files.
    4. **Stat** — whole-repo ``git diff --stat HEAD`` summary.

    Total output is hard-capped at :data:`_MAX_RESUME_CHARS` so one command
    cannot balloon the context window.

    Returns an empty string when the session cache is unavailable or empty.
    """
    try:
        from . import session as _session
        cache = _session.load(session_id)
    except (OSError, ValueError):
        return ""
    if cache.unavailable:
        return ""

    now_str = _now_hhmm()
    parts: list[str] = [f"## Resume — session {session_id[:8]} (as of {now_str})"]
    char_budget = _MAX_RESUME_CHARS - len(parts[0])

    # -----------------------------------------------------------------------
    # Section 1: Skill checklists
    # -----------------------------------------------------------------------
    skill_hist = getattr(cache, "skill_history", None) or {}
    if skill_hist:
        try:

            from . import skill_cache as _skill_cache

            skill_entries = sorted(
                skill_hist.values(),
                key=lambda se: getattr(se, "ts", 0.0),
                reverse=True,
            )[:_SKILL_MAX_COUNT]

            skill_lines: list[str] = ["### Skills"]
            for se in skill_entries:
                name = getattr(se, "skill_name", "?")
                output_id = getattr(se, "output_id", None)
                ts = getattr(se, "ts", 0.0)
                ts_str = _ts_hhmm(ts) if ts else now_str
                checklist: str | None = None
                if output_id:
                    body = _skill_cache.load_output(output_id)
                    if body:
                        checklist = _skill_cache.extract_checklist_section(body)
                if checklist:
                    # Trim to per-skill budget.
                    if len(checklist) > _SKILL_MAX_CHARS_EACH:
                        checklist = checklist[:_SKILL_MAX_CHARS_EACH].rstrip() + "…"
                    skill_lines.append(f"**{name}** (as of {ts_str}):")
                    skill_lines.append(checklist)
                else:
                    skill_lines.append(
                        f"**{name}** (as of {ts_str}) — "
                        f"`token-goat skill-body {name} --section DoD`"
                    )
            skill_block = "\n".join(skill_lines)
            if len(skill_block) <= char_budget:
                parts.append(skill_block)
                char_budget -= len(skill_block)
        except Exception:
            pass

    # -----------------------------------------------------------------------
    # Section 2: Recent Bash outputs (head + tail)
    # -----------------------------------------------------------------------
    bash_hist = getattr(cache, "bash_history", None) or {}
    if bash_hist and char_budget > 200:
        try:

            bash_entries = sorted(
                bash_hist.values(),
                key=lambda be: getattr(be, "ts", 0.0),
                reverse=True,
            )[:_BASH_MAX_COUNT]

            bash_lines: list[str] = ["### Bash outputs"]
            for be in bash_entries:
                cmd = getattr(be, "cmd_preview", "?")
                output_id = getattr(be, "output_id", None)
                ts = getattr(be, "ts", 0.0)
                ts_str = _ts_hhmm(ts) if ts else now_str
                exit_code = getattr(be, "exit_code", None)
                exit_str = f" exit={exit_code}" if exit_code is not None else ""
                bash_lines.append(f"**`{cmd}`** ({ts_str}{exit_str}):")
                if output_id:
                    text = _load_bash_output(output_id)
                    if text:
                        raw_lines = text.splitlines()
                        bash_lines.append(
                            _head_tail(raw_lines, _BASH_HEAD_LINES, _BASH_TAIL_LINES)
                        )
                    else:
                        bash_lines.append(
                            f"`token-goat bash-output {output_id[:16]}` (body evicted)"
                        )
                else:
                    bash_lines.append("(no output_id)")
            bash_block = "\n".join(bash_lines)
            # Trim to remaining budget (leave at least 400 chars for diff + stat).
            if len(bash_block) <= char_budget - 400:
                parts.append(bash_block)
                char_budget -= len(bash_block)
            elif char_budget > 400:
                # Partial: emit truncated bash block up to budget.
                trimmed = bash_block[: char_budget - 400]
                parts.append(trimmed + "\n--- bash section truncated ---")
                char_budget = 400
        except Exception:
            pass

    # -----------------------------------------------------------------------
    # Section 3: Per-file diffs for top edited files
    # -----------------------------------------------------------------------
    cwd = getattr(cache, "cwd", None)
    edited = getattr(cache, "edited_files", None) or {}
    if edited and cwd and char_budget > 100:
        try:
            # Sort by edit count descending, take top DIFF_MAX_COUNT.
            top_edited = sorted(edited.items(), key=lambda kv: kv[1], reverse=True)
            diff_lines: list[str] = ["### Diffs (top edited files)"]
            shown = 0
            for path, count in top_edited:
                if shown >= _DIFF_MAX_COUNT:
                    break
                if char_budget <= 100:
                    break
                diff_text = _inline_diff(path, cwd)
                if diff_text:
                    entry = f"**{path}** (edited ×{count}, as of {now_str}):\n```diff\n{diff_text}\n```"
                    if len(entry) <= char_budget - 50:
                        diff_lines.append(entry)
                        char_budget -= len(entry)
                        shown += 1
            if len(diff_lines) > 1:  # more than just the header
                parts.append("\n".join(diff_lines))
        except Exception:
            pass

    # -----------------------------------------------------------------------
    # Section 4: Git diff stat summary
    # -----------------------------------------------------------------------
    if cwd and char_budget > 50:
        try:
            stat = _git_diff_stat(cwd)
            if stat:
                stat_block = f"### Git stat (as of {now_str})\n{stat}"
                if len(stat_block) <= char_budget:
                    parts.append(stat_block)
        except Exception:
            pass

    if len(parts) <= 1:
        return ""

    return "\n\n".join(parts)
