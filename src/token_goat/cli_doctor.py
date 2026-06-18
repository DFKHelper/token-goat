"""Doctor CLI helpers."""
from __future__ import annotations

import contextlib
import sqlite3
import sys
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

import typer

from . import paths
from .util import _humanize_bytes as _humanize_bytes_doctor


def _cache_dir_stats(d: Path) -> tuple[int, int, int | None]:
    """Return ``(total_bytes, file_count, oldest_age_seconds_or_None)`` for *d*.

    Walks a single directory level — none of the cache directories the doctor
    inspects are nested.  ``session_snapshots/`` is the one exception (one
    subdir per session); we descend one level for it.  Symlinks are skipped
    defensively.  Raises :class:`OSError` only when the directory itself
    cannot be enumerated; per-file errors are silently skipped because the
    caller treats unreadable individual entries as zero-sized.
    """
    total_bytes = 0
    file_count = 0
    oldest_mtime: float | None = None
    now = time.time()
    for entry in d.iterdir():
        try:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                # One-level descent for session_snapshots/<session_id>/...
                for child in entry.iterdir():
                    if child.is_symlink() or not child.is_file():
                        continue
                    try:
                        st = child.stat()
                    except OSError:
                        continue
                    total_bytes += st.st_size
                    file_count += 1
                    if oldest_mtime is None or st.st_mtime < oldest_mtime:
                        oldest_mtime = st.st_mtime
                continue
            if not entry.is_file():
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            total_bytes += st.st_size
            file_count += 1
            if oldest_mtime is None or st.st_mtime < oldest_mtime:
                oldest_mtime = st.st_mtime
        except OSError:
            continue
    oldest_age = int(now - oldest_mtime) if oldest_mtime is not None else None
    return total_bytes, file_count, oldest_age


def _render_cache_section(
    label: str,
    dir_name: str,
    cap_bytes: int | None,
    cap_file_count: int | None,
    ok: Callable[[str, str], None],
    # `flag` accepts an optional `warn=True` keyword so the caller can
    # downgrade an over-cap line to a warning. Callable[..., None] is the
    # only way to express that without leaking the inner closure shape.
    flag: Callable[..., None],
) -> None:
    """Render a single cache section for the doctor output.

    Emits an ok/flag line based on cache directory size and file count.
    Caps are optional (None means no cap applies).
    """
    d = paths.data_dir() / dir_name
    if not d.exists():
        ok(label, "(not yet created)")
        return
    try:
        total_bytes, file_count, oldest_age = _cache_dir_stats(d)
    except OSError as e:
        flag(label, f"unreadable — {e}", warn=True)
        return
    if file_count == 0:
        ok(label, "0 files (empty)")
        return
    age_str = f", oldest {oldest_age // 3600}h ago" if oldest_age is not None else ""
    size_str = _humanize_bytes_doctor(total_bytes)
    # Detect over-cap: bytes cap OR file-count cap.  The file-count cap is
    # expressed in .txt bodies; _cache_dir_stats counts ALL files (bodies +
    # sidecars), so compare against cap_file_count * 2 to give a fair
    # threshold that accounts for each body having one sidecar.
    bytes_over = cap_bytes is not None and total_bytes > int(cap_bytes * 1.1)
    count_over = (
        cap_file_count is not None and file_count > cap_file_count * 2 * 1.1
    )
    if bytes_over or count_over:
        # 10% over the cap is the eviction's grace window; beyond that
        # the periodic sweep should have caught up by now.
        flag(label, f"{file_count} files, {size_str}{age_str} (over cap)", warn=True)
    else:
        ok(label, f"{file_count} files, {size_str}{age_str}")


def _compute_context_growth_trend(
    sentinels_dir: Path,
    current_tokens: int = 0,
    context_cap: int | None = None,
) -> str | None:
    """Return a human-readable context growth trend line from precompact sentinels.

    Reads up to 5 most-recent ``precompact_estimate_*.json`` sentinels and
    computes the average growth per sentinel (a rough proxy for session-level
    growth).  Returns None when fewer than 2 sentinels exist (no trend data).

    When the trend is growing and ``current_tokens`` is provided, appends a
    projection for how many sessions remain before the URGENT (85%) threshold
    is reached at the current growth rate.

    The returned string is suitable for direct inclusion in doctor output, e.g.::

        "↗ growing +12,400 tok/session avg (last 3 sessions)  [~4 sessions to URGENT]"
        "↘ shrinking −8,200 tok/session avg (last 3 sessions)"
        "→ stable ±3,000 tok/session avg (last 3 sessions)"
    """
    import json as _json  # noqa: PLC0415

    if not sentinels_dir.is_dir():
        return None

    samples: list[tuple[float, int]] = []
    try:
        for p in sentinels_dir.glob("precompact_estimate_*.json"):
            try:
                mtime = p.stat().st_mtime
                data = _json.loads(p.read_text(encoding="utf-8"))
                tok = max(0, int(data.get("bytes_estimate", 0))) // 4
                samples.append((mtime, tok))
            except (OSError, ValueError, KeyError):
                continue
    except OSError:
        return None

    if len(samples) < 2:
        return None

    samples.sort()  # oldest first
    samples = samples[-5:]  # keep at most 5 most-recent

    deltas = [samples[i + 1][1] - samples[i][1] for i in range(len(samples) - 1)]
    avg_delta = sum(deltas) / len(deltas)
    n_sessions = len(deltas)

    abs_avg = abs(int(avg_delta))
    stable_threshold = 5_000  # tokens

    if avg_delta > stable_threshold:
        arrow = "↗"  # ↗
        direction = "growing"
        sign = "+"
        # Project sessions until URGENT threshold (85%) at current growth rate
        from .compact import CONTEXT_AUTOCOMPACT_TOKENS  # noqa: PLC0415

        _effective_cap = context_cap if context_cap is not None else CONTEXT_AUTOCOMPACT_TOKENS
        urgent_threshold = int(_effective_cap * 0.85)
        sessions_eta_suffix = ""
        if current_tokens > 0 and avg_delta > 0:
            headroom = max(0, urgent_threshold - current_tokens)
            sessions_to_urgent = headroom / avg_delta
            if sessions_to_urgent <= 10:
                sessions_int = max(1, int(sessions_to_urgent))
                sessions_eta_suffix = f"  [~{sessions_int} session{'s' if sessions_int != 1 else ''} to URGENT]"
        trend_suffix = sessions_eta_suffix
    elif avg_delta < -stable_threshold:
        arrow = "↘"  # ↘
        direction = "shrinking"
        sign = "−"  # −
        trend_suffix = ""
    else:
        arrow = "→"  # →
        direction = "stable"
        sign = "±"  # ±
        trend_suffix = ""

    return (
        f"  {arrow} {direction} {sign}{abs_avg:,} tok/session avg"
        f"  (last {n_sessions} session{'s' if n_sessions != 1 else ''})"
        f"{trend_suffix}"
    )


def _build_context_section() -> tuple[list[str], bool]:
    """Build lines for the Context footprint doctor section.

    Returns ``(lines, should_auto_show)`` where *should_auto_show* is True when
    estimated context fill > 40 % or any loaded skill > 2 K tokens lacks a compact.
    The caller emits the lines when ``--context`` is passed or should_auto_show is True.
    """
    import json  # noqa: PLC0415

    lines: list[str] = []
    should_auto_show = False

    # ------------------------------------------------------------------ #
    # 1. Skills catalog — scan actual file sizes (same logic as pregen)   #
    # ------------------------------------------------------------------ #
    skills_root = paths.claude_skills_dir()
    plugins_root = paths.claude_plugins_dir()
    plugins_cache = plugins_root / "cache"

    catalog_count = 0
    catalog_bytes = 0

    def _scan_skills_dir(root: Path, prefix: str = "") -> None:
        nonlocal catalog_count, catalog_bytes
        if not root.is_dir():
            return
        with contextlib.suppress(OSError):
            for entry in root.iterdir():
                if not entry.is_dir():
                    continue
                for candidate in (
                    entry / "SKILL.md",
                    entry / f"{entry.name}.md",
                    entry / entry.name / "SKILL.md",
                ):
                    if candidate.is_file():
                        with contextlib.suppress(OSError):
                            catalog_bytes += candidate.stat().st_size
                        catalog_count += 1
                        break

    _scan_skills_dir(skills_root)

    if plugins_cache.is_dir():
        with contextlib.suppress(OSError):
            for mkt in plugins_cache.iterdir():
                if not mkt.is_dir():
                    continue
                for plugin_dir in mkt.iterdir():
                    if not plugin_dir.is_dir():
                        continue
                    try:
                        versions = sorted(
                            (v for v in plugin_dir.iterdir() if v.is_dir()),
                            reverse=True,
                        )
                    except OSError:
                        continue
                    for ver in versions:
                        _scan_skills_dir(ver / "skills", prefix=plugin_dir.name)
                        break

    # catalog_bytes == 0 with catalog_count > 0 means every stat() failed
    # (e.g. permission error) or every skill file is genuinely empty.
    # In either case the 130-token floor is a conservative fallback.
    # Track which formula was used so the output can be annotated.
    if catalog_count > 0 and catalog_bytes == 0:
        catalog_tokens = catalog_count * 130
        catalog_size_note = "  [no byte sizes — using 130 tok/skill fallback]"
    else:
        catalog_tokens = max(catalog_bytes // 4, catalog_count * 130)
        catalog_size_note = ""

    # ------------------------------------------------------------------ #
    # 2. Compact coverage — one glob pass over the cache dir              #
    # ------------------------------------------------------------------ #
    # Build a set of safe names that have at least one compact file, then
    # check each discovered skill name against it (O(n) vs. O(n * glob)).
    compact_names: set[str] = set()
    try:
        from . import skill_cache as _sc  # noqa: PLC0415

        out_dir = _sc._skill_outputs_dir()  # type: ignore[attr-defined]
        if out_dir.is_dir():
            for p in out_dir.iterdir():
                if p.name.endswith("-compact"):
                    # Pattern: {session_fragment}-{safe_name}-compact
                    # session_fragment is up to 16 chars and may itself contain dashes,
                    # so we cannot split on the first dash.  Store the full stem and
                    # check with endswith() in _has_compact() instead.
                    compact_names.add(p.name[:-8])  # strip "-compact", keep full stem
    except Exception:  # noqa: BLE001
        pass

    def _has_compact(skill_name: str) -> bool:
        try:
            from . import skill_cache as _sc2  # noqa: PLC0415

            safe = _sc2._safe_skill_name(skill_name)  # type: ignore[attr-defined]
            if safe is None:
                return False
            safe_n = safe.replace(":", "_")
            if ":" in safe:
                safe_n += "n"
            # Each stem is "{session_fragment}-{safe_name}"; match by suffix.
            suffix = f"-{safe_n}"
            return any(s.endswith(suffix) for s in compact_names)
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------------ #
    # 3. New skills since last pre-generation                             #
    # ------------------------------------------------------------------ #
    new_since_pregen: int | None = None  # None = never run
    try:
        pregen_sentinel = paths.skill_pregen_sentinel_path()
        if pregen_sentinel.is_file():
            pregen_data = json.loads(pregen_sentinel.read_text(encoding="utf-8"))
            pregen_count = int(pregen_data.get("skill_count", 0))
            new_since_pregen = max(0, catalog_count - pregen_count)
    except Exception:  # noqa: BLE001
        pass

    # ------------------------------------------------------------------ #
    # 4. Loaded skills — most-recently-modified session file              #
    # ------------------------------------------------------------------ #
    loaded_skill_entries: list[tuple[str, int, bool]] = []  # (name, body_tokens, has_compact)
    session_turns = 0

    sessions_dir_path = paths.sessions_dir()
    if sessions_dir_path.is_dir():
        try:
            best_mtime = 0.0
            best_file: Path | None = None
            for f in sessions_dir_path.glob("*.json"):
                try:
                    mtime = f.stat().st_mtime
                    if mtime > best_mtime:
                        best_mtime = mtime
                        best_file = f
                except OSError:
                    continue
            if best_file is not None:
                from . import session as _ses  # noqa: PLC0415

                cache = _ses.load(best_file.stem)
                session_turns = getattr(cache, "turns_since_last_compact", 0)
                for skill_name, entry in getattr(cache, "skill_history", {}).items():
                    body_bytes = getattr(entry, "body_bytes", 0)
                    body_tokens = body_bytes // 4
                    hc = _has_compact(skill_name)
                    loaded_skill_entries.append((skill_name, body_tokens, hc))
                    if body_tokens > 2000 and not hc:
                        should_auto_show = True
        except Exception:  # noqa: BLE001
            pass

    loaded_skill_tokens = sum(bt for _, bt, _ in loaded_skill_entries)

    # ------------------------------------------------------------------ #
    # 5. CLAUDE.md + MEMORY.md sizes                                      #
    # ------------------------------------------------------------------ #
    claude_dir = Path.home() / ".claude"
    meta_bytes = 0
    try:
        claude_md = claude_dir / "CLAUDE.md"
        if claude_md.is_file():
            meta_bytes += claude_md.stat().st_size
    except OSError:
        pass
    try:
        projects_root = claude_dir / "projects"
        if projects_root.is_dir():
            for proj_dir in projects_root.iterdir():
                if not proj_dir.is_dir():
                    continue
                memory_md = proj_dir / "memory" / "MEMORY.md"
                if memory_md.is_file():
                    with contextlib.suppress(OSError):
                        meta_bytes += memory_md.stat().st_size
    except OSError:
        pass
    meta_tokens = meta_bytes // 4

    # ------------------------------------------------------------------ #
    # 6. Conversation estimate (iter 8: tool-output-aware)                #
    # The old formula (turns * 2000) underestimates sessions with heavy   #
    # bash or web tool use.  We now use actual output bytes from the      #
    # session cache — bash stdout/stderr and web fetch bodies — capped    #
    # per-entry to avoid double-counting truncated outputs.               #
    # Per-turn dialogue is estimated at 800 tokens (model text only);     #
    # tool outputs add on top of that.                                    #
    # ------------------------------------------------------------------ #
    _TOOL_OUTPUT_CAP = 32_768  # bytes per entry — prevents one giant bash output
    #                           from dominating; token-goat already truncates
    tool_output_bytes = 0
    try:
        if "cache" in locals():  # session was loaded earlier (section 4 above)
            bash_hist = getattr(cache, "bash_history", {})
            for be in bash_hist.values():
                tool_output_bytes += min(
                    getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0),
                    _TOOL_OUTPUT_CAP,
                )
            web_hist = getattr(cache, "web_history", {})
            for we in web_hist.values():
                tool_output_bytes += min(getattr(we, "body_bytes", 0), _TOOL_OUTPUT_CAP)
    except Exception:  # noqa: BLE001
        tool_output_bytes = 0

    tool_output_tokens = tool_output_bytes // 4
    dialogue_tokens = session_turns * 800  # model text per turn
    conversation_tokens = dialogue_tokens + tool_output_tokens

    # ------------------------------------------------------------------ #
    # 7. Precompact baseline — read without consuming the sentinel         #
    # The 300-second age cap previously meant any session older than 5     #
    # minutes produced "no compact baseline yet" even when a valid         #
    # sentinel existed on disk.  We now accept any sentinel, but report    #
    # its age so the user knows whether it reflects the current session.   #
    # ------------------------------------------------------------------ #
    precompact_tokens = 0
    has_precompact = False
    precompact_age_seconds: int | None = None
    sentinel_error: str | None = None  # set when the best sentinel is unreadable
    try:
        sentinels_dir_path = paths.sentinels_dir()
        if sentinels_dir_path.is_dir():
            now = time.time()
            candidates: list[tuple[float, Path]] = []
            for p in sentinels_dir_path.glob("precompact_estimate_*.json"):
                try:
                    mtime = p.stat().st_mtime
                    candidates.append((mtime, p))
                except OSError:
                    continue
            if candidates:
                candidates.sort(reverse=True)
                best_mtime, best_sentinel = candidates[0]
                try:
                    raw_text = best_sentinel.read_text(encoding="utf-8")
                except OSError as exc:
                    sentinel_error = f"unreadable ({exc.__class__.__name__})"
                    raw_text = None
                if raw_text is not None:
                    try:
                        sentinel_data = json.loads(raw_text)
                        raw_bytes = int(sentinel_data.get("bytes_estimate", 0))
                    except (json.JSONDecodeError, ValueError, TypeError):
                        sentinel_error = "malformed JSON in sentinel"
                        raw_bytes = 0
                    if raw_bytes > 0:
                        # Only treat as a valid baseline when bytes_estimate is positive.
                        # A zero-byte estimate means the sentinel was written before any
                        # content was captured — treat it the same as no baseline.
                        precompact_tokens = raw_bytes // 4
                        has_precompact = True
                        precompact_age_seconds = int(now - best_mtime)
    except Exception:  # noqa: BLE001
        sentinel_error = "unexpected error reading sentinels"

    # ------------------------------------------------------------------ #
    # 8. Totals, fill %, ETA                                               #
    # ------------------------------------------------------------------ #
    from .compact import CONTEXT_AUTOCOMPACT_TOKENS as CONTEXT_CAP  # noqa: PLC0415

    additional_tokens = catalog_tokens + loaded_skill_tokens + meta_tokens + conversation_tokens
    current_estimate = (precompact_tokens + additional_tokens) if has_precompact else additional_tokens
    fill_pct = current_estimate / CONTEXT_CAP

    if fill_pct > 0.40:
        should_auto_show = True

    tokens_per_turn = max(1, conversation_tokens // session_turns) if session_turns >= 3 else 2000
    remaining = max(0, CONTEXT_CAP - current_estimate)
    eta_turns = remaining / tokens_per_turn

    # ------------------------------------------------------------------ #
    # 9. Assemble output lines                                             #
    # ------------------------------------------------------------------ #
    lines.append("\nContext footprint")
    catalog_size_label = "[actual file sizes]" if not catalog_size_note else "[fallback estimate]"
    lines.append(f"  Skills catalog: {catalog_count} skills ≈ {catalog_tokens:,} tokens/turn  {catalog_size_label}")
    if catalog_size_note:
        lines.append(catalog_size_note)

    compact_count = sum(1 for sname in _iter_skill_names(skills_root, plugins_cache) if _has_compact(sname))
    if catalog_count > 0:
        lines.append(f"  Skill compacts: {compact_count} of {catalog_count} skills have fresh compacts")

    if new_since_pregen is None:
        lines.append("  Skills pre-gen: never run — run: token-goat skill-compact --all")
    elif new_since_pregen > 0:
        lines.append(f"  Skills installed since last pre-gen: {new_since_pregen}")

    if loaded_skill_entries:
        lines.append(
            f"  Loaded skills this session: {len(loaded_skill_entries)}"
            f" (~{loaded_skill_tokens:,} tokens in system-reminder)"
        )
        for skill_name, body_tokens, hc in loaded_skill_entries:
            if hc:
                try:
                    from . import skill_cache as _sc3  # noqa: PLC0415
                    compact_text = _sc3.get_compact_any_session(skill_name) or ""
                except Exception:  # noqa: BLE001
                    compact_text = ""
                compact_tok = len(compact_text) // 4
                saves = max(0, body_tokens - compact_tok)
                lines.append(
                    f"    {skill_name:<24}~{body_tokens:,} tok"
                    f"   compact: {compact_tok:,} tok"
                    f"   saves ~{saves:,} tok at next /compact"
                )
            else:
                lines.append(
                    f"    {skill_name:<24}~{body_tokens:,} tok"
                    f"   no compact"
                    f"          run: token-goat skill-compact {skill_name}"
                )
    else:
        lines.append("  Loaded skills this session: none")

    lines.append(f"  CLAUDE.md + MEMORY.md: ~{meta_tokens:,} tokens/turn")

    if session_turns > 0:
        per_turn_est = conversation_tokens // session_turns
        if tool_output_tokens > 0:
            lines.append(
                f"  Conversation (~{session_turns} turns): ~{conversation_tokens:,} tokens"
                f"  (~{per_turn_est:,}/turn)"
                f"  [dialogue ~{dialogue_tokens:,} + tool outputs ~{tool_output_tokens:,}]"
            )
        else:
            lines.append(
                f"  Conversation (~{session_turns} turns): ~{conversation_tokens:,} tokens"
                f"  (~{per_turn_est:,}/turn)"
            )
    else:
        lines.append("  Conversation: no active session found")

    lines.append("  " + "─" * 54)
    lines.append(f"  Estimated additional: ~{additional_tokens:,} tokens")

    if has_precompact:
        if precompact_age_seconds is not None and precompact_age_seconds > 3600:
            age_hrs = precompact_age_seconds // 3600
            age_note = f"  [{age_hrs}h old — may not reflect current session]"
        elif precompact_age_seconds is not None and precompact_age_seconds > 300:
            age_min = precompact_age_seconds // 60
            age_note = f"  [{age_min}m old]"
        else:
            age_note = ""
        lines.append(f"  Context at last compact: ~{precompact_tokens:,}{age_note}")
        lines.append(
            f"  Current estimate: ~{current_estimate:,} / {CONTEXT_CAP:,}"
            f"  ({int(fill_pct * 100)}%)"
        )
    else:
        lines.append("  Context at last compact: < no compact baseline yet >")
        if sentinel_error:
            lines.append(f"    (sentinel error: {sentinel_error})")
        lines.append(
            f"  Current estimate: ~{current_estimate:,} / {CONTEXT_CAP:,}"
            f"  ({int(fill_pct * 100)}%)"
        )

    # ------------------------------------------------------------------ #
    # Fill bar + per-component breakdown (iter 2)                          #
    # Shows which budget components dominate at a glance.                  #
    # ------------------------------------------------------------------ #
    BAR_WIDTH = 40
    filled = min(BAR_WIDTH, int(fill_pct * BAR_WIDTH))
    bar = "█" * filled + "░" * (BAR_WIDTH - filled)
    fill_label = f"{int(fill_pct * 100)}%"
    # Threshold markers in the bar string
    if fill_pct >= 0.85:
        severity = "CRIT"
    elif fill_pct >= 0.70:
        severity = "HIGH"
    elif fill_pct >= 0.40:
        severity = "WARN"
    else:
        severity = "ok"
    lines.append(f"  [{bar}] {fill_label} ({severity})")

    # Per-component percentages — only show components that are >2% of total
    components: list[tuple[str, int]] = [
        ("precompact", precompact_tokens if has_precompact else 0),
        ("catalog", catalog_tokens),
        ("loaded skills", loaded_skill_tokens),
        ("meta (CLAUDE.md)", meta_tokens),
        ("conversation", conversation_tokens),
    ]
    if current_estimate > 0:
        breakdown_parts = []
        for cname, ctok in components:
            pct = ctok / current_estimate * 100
            if pct >= 2.0:
                breakdown_parts.append(f"{cname} {pct:.0f}%")
        if breakdown_parts:
            lines.append(f"  Breakdown: {', '.join(breakdown_parts)}")

    if session_turns >= 3:
        if eta_turns > 20:
            lines.append("  ETA: > 20 turns at current rate")
        else:
            lines.append(f"  ETA: ~{max(1, int(eta_turns))} turns at current rate")
    elif session_turns > 0:
        lo = max(1, int(eta_turns) - 3)
        hi = int(eta_turns) + 3
        lines.append(f"  ETA: ~{lo}–{hi} turns  (estimated, < 3 turns of history)")
    else:
        lines.append("  ETA: unknown  (no active session found)")

    # ------------------------------------------------------------------ #
    # 10. Session-to-session growth trend (iter 3)                         #
    # Reads multiple precompact sentinels to show whether context usage     #
    # is growing, shrinking, or stable across sessions.                    #
    # ------------------------------------------------------------------ #
    try:
        sentinels_dir_for_trend = paths.sentinels_dir()
        trend_line = _compute_context_growth_trend(
            sentinels_dir_for_trend,
            current_tokens=current_estimate,
            context_cap=CONTEXT_CAP,
        )
        if trend_line is not None:
            lines.append(trend_line)
    except Exception:  # noqa: BLE001
        pass

    # ------------------------------------------------------------------ #
    # 11. Recommendations (iter 4)                                         #
    # Tiered actionable advice based on fill %, ETA, and growth trend.     #
    # Priority ordering: compact-now > skill-compact > pregen.             #
    # ------------------------------------------------------------------ #
    recommendations: list[str] = []

    # Count uncompacted large loaded skills (used in compound warnings below)
    uncompacted_large_skills = [
        name for name, btok, hc in loaded_skill_entries if not hc and btok > 2000
    ]

    # Tier 0: over-capacity — estimate exceeds CONTEXT_CAP (100%)
    if fill_pct >= 1.0:
        recommendations.append(
            "    [OVER CAPACITY] Estimated context exceeds 100% — responses may degrade."
            " Run /compact immediately."
        )

    # Tier 1: immediate compaction recommended
    elif fill_pct >= 0.85:
        if uncompacted_large_skills:
            # Compound: high fill + uncompacted skills — mention skill-compact first
            skill_list = ", ".join(uncompacted_large_skills[:3])
            more = f" (+{len(uncompacted_large_skills) - 3} more)" if len(uncompacted_large_skills) > 3 else ""
            recommendations.append(
                f"    [URGENT] Run skill-compact first ({skill_list}{more}),"
                f" then /compact — uncompacted skills re-inflate context every turn."
            )
        else:
            recommendations.append("    [URGENT] Run /compact now — context is >= 85% full.")
    elif fill_pct >= 0.70:
        recommendations.append("    Run /compact soon — context is >= 70% full.")
    elif fill_pct >= 0.40 and session_turns >= 10:
        recommendations.append(
            f"    Consider /compact — context at {int(fill_pct * 100)}% with"
            f" {session_turns} turns; compact to reset baseline."
        )

    # Tier 2: skill compact opportunities (uncompacted loaded skills)
    for skill_name, body_tokens, hc in loaded_skill_entries:
        if not hc and body_tokens > 2000:
            savings_note = f"  # ~{(body_tokens - body_tokens // 5):,} tok saved"
            recommendations.append(f"    token-goat skill-compact {skill_name}{savings_note}")

    # Tier 3: catalog-wide pregen gap
    if compact_count < catalog_count or new_since_pregen is None or (new_since_pregen or 0) > 0:
        recommendations.append("    token-goat skill-compact --all  # update compact catalog")

    # Tier 4: early session with heavy context
    if session_turns < 5 and fill_pct >= 0.30:
        # Determine dominant early-session cost component
        component_costs: list[tuple[str, int]] = [
            ("loaded skills", loaded_skill_tokens),
            ("meta (CLAUDE.md)", meta_tokens),
            ("catalog", catalog_tokens),
        ]
        dominant = max(component_costs, key=lambda x: x[1])
        if dominant[1] > 0:
            recommendations.append(
                f"    Context is {int(fill_pct * 100)}% after only {session_turns} turn(s)"
                f" — dominant cost: {dominant[0]} ({dominant[1]:,} tok)."
                f" Skill compacts will help most."
            )
        else:
            recommendations.append(
                f"    Context at {int(fill_pct * 100)}% with only {session_turns} turn(s)"
                f" — run: token-goat skill-compact --all"
            )

    if recommendations:
        lines.append("")
        lines.append("  Recommendations:")
        lines.extend(recommendations)

    return lines, should_auto_show


def _iter_skill_names(skills_root: Path, plugins_cache: Path) -> list[str]:
    """Return all skill names discovered on disk (same traversal as pregen)."""
    names: list[str] = []
    if skills_root.is_dir():
        with contextlib.suppress(OSError):
            for entry in skills_root.iterdir():
                if entry.is_dir():
                    names.append(entry.name)
    if plugins_cache.is_dir():
        with contextlib.suppress(OSError):
            for mkt in plugins_cache.iterdir():
                if not mkt.is_dir():
                    continue
                for plugin_dir in mkt.iterdir():
                    if not plugin_dir.is_dir():
                        continue
                    try:
                        versions = sorted(
                            (v for v in plugin_dir.iterdir() if v.is_dir()),
                            reverse=True,
                        )
                    except OSError:
                        continue
                    for ver in versions:
                        ver_skills = ver / "skills"
                        if not ver_skills.is_dir():
                            continue
                        with contextlib.suppress(OSError):
                            for skill_entry in ver_skills.iterdir():
                                if skill_entry.is_dir():
                                    names.append(f"{plugin_dir.name}:{skill_entry.name}")
                        break
    return names


def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
    crashes: bool = typer.Option(  # noqa: B008
        False, "--crashes", help="Show the last 5 hook crash entries from hooks-stderr.log."
    ),
    context: bool = typer.Option(  # noqa: B008
        False, "--context", help="Always show the Context footprint section (shown automatically when context > 40% or an uncompacted loaded skill exists)."
    ),
) -> None:
    """Diagnose indexing health.

    Pass ``--fix`` to also clear the stale ``.indexing`` spawn markers doctor
    flags — the same reaping the worker does on startup, available on demand
    for when the worker is down.

    Pass ``--crashes`` to tail the last 5 entries from hooks-stderr.log so
    hook crash backtraces are visible without manually opening the log file.
    """
    import importlib
    import subprocess

    import psutil

    from . import db as _db
    from . import paths, project

    def ok(label: str, value: str) -> None:
        """Print a passing doctor-check line (plain indented ``label: value``)."""
        typer.echo(f"  {label}: {value}")

    def flag(label: str, value: str, *, warn: bool = False) -> None:
        """Print a failing or warning doctor-check line prefixed with [FAIL] or [WARN]."""
        prefix = "WARN" if warn else "FAIL"
        typer.echo(f"  [{prefix}] {label}: {value}")

    def _check_step(
        label: str,
        fn: Callable[[], object],
        *,
        warn: bool = False,
        time_ms: bool = False,
    ) -> None:
        """Execute a check step, emitting a pass or failure message.

        Wraps the try/except pattern for doctor check steps: calls *fn()*, emits
        a passing message via ``ok(label, str(result))``, and catches exceptions
        to emit a failure message via ``flag(label, str(e), warn=warn)``.

        Parameters
        ----------
        label
            The check label to pass to ok/flag.
        fn
            The callable that performs the check. Its return value is converted
            to a string for the ok message. If None, an empty string is used.
        warn
            If True, failures are emitted as warnings; otherwise as failures.
            Defaults to False.
        time_ms
            If True, append the elapsed wall-clock time of *fn()* (in ms) to
            the passing message.  Useful for cold-import probes (sqlite-vec,
            fastembed) where a slow load points to a fresh-install model
            download or a slow filesystem — both are operationally relevant
            even though the check itself succeeded.
        """
        try:
            t0 = time.monotonic() if time_ms else 0.0
            result = fn()
            if time_ms:
                elapsed_ms = (time.monotonic() - t0) * 1000
                base = str(result) if result is not None else ""
                ok(label, f"{base} ({elapsed_ms:.0f} ms)" if base else f"{elapsed_ms:.0f} ms")
            else:
                ok(label, str(result) if result is not None else "")
        except Exception as e:  # noqa: BLE001
            flag(label, str(e), warn=warn)

    typer.echo("\ntoken-goat doctor\n")

    # ------------------------------------------------------------------
    # 0. Platform
    # ------------------------------------------------------------------
    typer.echo("Platform")
    if sys.platform == "win32":
        ok("OS", f"Windows (sys.platform={sys.platform})")
    elif sys.platform == "darwin":
        ok("OS", f"macOS (sys.platform={sys.platform})")
    else:
        ok("OS", f"Linux/POSIX (sys.platform={sys.platform})")
    ok("WSL", "yes" if paths.is_wsl() else "no")

    # ------------------------------------------------------------------
    # 1. Versions
    # ------------------------------------------------------------------
    typer.echo("\nVersions")
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info < (3, 11):  # noqa: UP036
        flag("Python", f"{py_ver} — minimum supported is 3.11; upgrade to avoid compatibility issues")
    else:
        ok("Python", py_ver)
    try:
        import importlib.metadata

        cc_ver = importlib.metadata.version("token-goat")
    except importlib.metadata.PackageNotFoundError:
        cc_ver = "unknown"
    ok("token-goat", cc_ver)

    # PyPI version check — non-blocking, 2 s timeout, skip gracefully if offline.
    def _check_pypi_version() -> str:
        import json as _json  # noqa: PLC0415
        import urllib.request  # noqa: PLC0415

        if cc_ver == "unknown":
            return "installed version unknown — skipping"
        try:
            url = "https://pypi.org/pypi/token-goat/json"
            req = urllib.request.Request(url, headers={"User-Agent": "token-goat-doctor/1.0"})
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = _json.loads(resp.read())
            latest = data["info"]["version"]
            if latest == cc_ver:
                return f"{cc_ver} (latest)"
            # Simple version comparison using tuple split on dots.
            def _vtup(v: str) -> tuple[int, ...]:
                try:
                    return tuple(int(x) for x in v.split("."))
                except ValueError:
                    return (0,)
            if _vtup(latest) > _vtup(cc_ver):
                raise ValueError(f"{cc_ver} installed, {latest} available — run `uv tool install --reinstall token-goat`")
            return f"{cc_ver} (PyPI has {latest})"
        except OSError:
            return "PyPI unreachable (offline?)"

    _check_step("token-goat (PyPI)", _check_pypi_version, warn=True)

    def _check_uv() -> str:
        uv_out = subprocess.run(
            ["uv", "--version"], capture_output=True, text=True, timeout=5
        )
        return uv_out.stdout.strip() or "installed"

    _check_step("uv", _check_uv, warn=True)

    # ------------------------------------------------------------------
    # 1b. Detected harnesses
    # ------------------------------------------------------------------
    def _check_harnesses() -> str:
        from . import install as _install  # noqa: PLC0415

        harnesses_dict = _install.detect_installed_harnesses()
        found = [name for name, installed in harnesses_dict.items() if installed]
        # Return in deterministic order: claude first, then others alphabetically
        if "claude" in found:
            found.remove("claude")
        found = ["claude"] + sorted(found)
        return ", ".join(found) if found else "none"

    _check_step("harnesses detected", _check_harnesses, warn=True)

    # ------------------------------------------------------------------
    # 2. Paths
    # ------------------------------------------------------------------
    typer.echo("\nPaths")
    path_checks = [
        ("data_dir", paths.data_dir()),
        ("global.db", paths.global_db_path()),
        ("models_dir", paths.models_dir()),
        ("logs_dir", paths.logs_dir()),
    ]
    for label, p in path_checks:
        if p.exists():
            ok(label, str(p))
        else:
            flag(label, f"{p}  (missing)", warn=True)

    # Fastembed ONNX model file: models_dir exists is not enough — the embedding
    # path silently degrades to zero-vectors if the .onnx blob is missing.
    # Surface the actual file presence so a fresh-install user without network
    # gets an actionable signal.
    try:
        models_dir = paths.models_dir()
        if models_dir.exists():
            onnx_files = list(models_dir.rglob("*.onnx"))
            if onnx_files:
                total_size = sum(f.stat().st_size for f in onnx_files if f.is_file())
                ok(
                    "fastembed model",
                    f"{len(onnx_files)} onnx file(s), {_humanize_bytes_doctor(total_size)}",
                )
            else:
                flag(
                    "fastembed model",
                    "no .onnx file found in models_dir — semantic search will be unavailable until first download",
                    warn=True,
                )
    except OSError as _e:
        flag("fastembed model", f"could not enumerate models_dir — {_e}", warn=True)

    # ------------------------------------------------------------------
    # 2a. Disk space
    # ------------------------------------------------------------------
    # Token-goat caches (models, images, bash/web outputs, project DBs) can
    # grow to several GB on a busy install.  Warn early if the data directory
    # partition is running low so the user can run `token-goat clean` before
    # hitting an OS-level write error inside a hook.
    typer.echo("\nDisk space")
    try:
        import shutil as _shutil  # noqa: PLC0415

        _data = paths.data_dir()
        # Use the parent if data_dir doesn't exist yet — shutil.disk_usage
        # requires an existing path.
        _check_path = _data if _data.exists() else _data.parent if _data.parent.exists() else Path.cwd()
        _total, _used, _free = _shutil.disk_usage(_check_path)
        _free_mb = _free // (1024 * 1024)
        _total_gb = _total / (1024 ** 3)
        _pct_free = _free / _total * 100 if _total > 0 else 0
        _free_str = f"{_free_mb:,} MB free of {_total_gb:.1f} GB ({_pct_free:.0f}% free) on {_check_path}"
        _WARN_MB = 500
        if _free_mb < _WARN_MB:
            flag(
                "data dir partition",
                f"{_free_str} — below {_WARN_MB} MB; run `token-goat clean` to reclaim cache space",
            )
        elif _free_mb < 2048:
            flag(
                "data dir partition",
                f"{_free_str} — getting low; consider `token-goat clean`",
                warn=True,
            )
        else:
            ok("data dir partition", _free_str)
    except Exception as _e_disk:  # noqa: BLE001
        flag("data dir partition", f"disk_usage failed — {_e_disk}", warn=True)

    # ------------------------------------------------------------------
    # 2b. Installation status — verify token-goat artefacts actually landed in
    # the harness configs.  Doctor previously only checked runtime/cache health;
    # if `token-goat install` had never been run (or had partially failed),
    # nothing surfaced that fact.  Pulls _check_* status strings from install.py
    # so the wire is the same as `token-goat install --verify`.
    # ------------------------------------------------------------------
    typer.echo("\nInstallation")
    try:
        from . import install as _install  # noqa: PLC0415

        # Always check the Claude side (settings.json + CLAUDE.md + skill).
        # Codex side only when the harness is detected, so users without Codex
        # don't see a confusing "codex config: not installed" warning.
        installation_checks: list[tuple[str, str]] = [
            ("settings.json", _install._check_settings_json()),
            ("CLAUDE.md", _install._check_claude_md()),
            ("skill", _install._check_skill()),
        ]
        try:
            harnesses_dict = _install.detect_installed_harnesses()
        except Exception:  # noqa: BLE001 — detect_installed_harnesses is best-effort
            harnesses_dict = {}
        if harnesses_dict.get("codex", False):
            installation_checks.append(("codex config.toml", _install._check_codex_config()))
        if sys.platform == "win32":
            installation_checks.append(("worker autostart", _install._check_worker_task()))
        for label, status in installation_checks:
            if status.startswith("installed"):
                ok(label, status)
            elif status.startswith("not installed"):
                flag(label, status + " — run `token-goat install`", warn=True)
            else:
                flag(label, status, warn=True)
    except Exception as _e:  # noqa: BLE001 — installation check must never abort doctor
        flag("installation", f"check failed — {_e}", warn=True)

    # ------------------------------------------------------------------
    # 2c. Third-party AI tool compatibility hints
    # ------------------------------------------------------------------
    typer.echo("\nThird-party AI tools")
    try:
        from . import install as _install  # noqa: PLC0415

        if _install.detect_aider():
            flag(
                "aider",
                "detected — aider does not support hook-based auto-integration; "
                "add `--read <file>` in your .aider.conf.yml to pass context manually",
                warn=True,
            )
        else:
            ok("aider", "not detected")

        gemini_dir = Path.home() / ".gemini"
        if gemini_dir.exists():
            from . import install as _inst  # noqa: PLC0415
            gemini_status = _inst._check_gemini_settings()  # noqa: SLF001
            if "installed" in gemini_status:
                ok("gemini", f"detected, hooks {gemini_status}")
            else:
                flag(
                    "gemini",
                    f"detected — hooks {gemini_status}; run `token-goat install --target gemini` to install",
                    warn=True,
                )
        else:
            ok("gemini", "not detected")

        if _install.detect_cline():
            ok("cline", "detected — bash output compression active for `cline` commands")
        else:
            ok("cline", "not detected")

        if _install.detect_windsurf():
            ok("windsurf", "detected — bash output compression active for `windsurf` commands")
        else:
            ok("windsurf", "not detected")

        if _install.detect_copilot_cli():
            ok("copilot-cli", "detected — bash output compression active for `copilot` commands")
        else:
            ok("copilot-cli", "not detected")
    except Exception as _e_tools:  # noqa: BLE001
        flag("third-party tools", f"check failed — {_e_tools}", warn=True)

    # ------------------------------------------------------------------
    # 3. SQLite
    # ------------------------------------------------------------------
    typer.echo("\nSQLite")
    ok("version", sqlite3.sqlite_version)

    # WAL check requires a real file — :memory: always returns "memory" mode.
    import tempfile  # noqa: PLC0415

    def _wal_supported() -> bool:
        """Test whether SQLite WAL journal mode is available on this filesystem.

        Creates a temporary on-disk database (WAL requires a real file — not
        ``:memory:``), applies ``PRAGMA journal_mode = WAL``, and checks whether
        SQLite confirmed the switch.  The temp file is cleaned up in a
        ``finally`` block even if the PRAGMA or ``conn.close()`` raises.
        Returns ``False`` on any exception (e.g. read-only filesystem, OS
        restrictions on file-locking) so the doctor check degrades gracefully.
        """
        # Use mkstemp so the OS-allocated fd is closed before sqlite3 opens the
        # file.  Wrapping everything in try/finally guarantees the temp file is
        # deleted even if the PRAGMA or conn.close() raises, closing the window
        # where an exception would leave a permanent temp file behind.
        import os  # noqa: PLC0415

        fd, tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        wal_conn: sqlite3.Connection | None = None
        try:
            wal_conn = sqlite3.connect(tmp_db_path, isolation_level=None)
            actual_mode: str = wal_conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            return actual_mode == "wal"
        except (sqlite3.Error, OSError):
            return False
        finally:
            with contextlib.suppress(Exception):
                if wal_conn is not None:
                    wal_conn.close()
            Path(tmp_db_path).unlink(missing_ok=True)

    ext_check_conn = sqlite3.connect(":memory:", isolation_level=None)
    if _wal_supported():
        ok("WAL", "yes")
    else:
        flag("WAL", "not supported or errored")
    try:
        ext_check_conn.enable_load_extension(True)
        ext_check_conn.enable_load_extension(False)
        ok("extensions", "yes")
        ext_ok = True
    except (AttributeError, sqlite3.OperationalError) as e:
        flag("extensions", f"no — {e}")
        ext_ok = False
    ext_check_conn.close()

    # ------------------------------------------------------------------
    # 4. sqlite-vec
    # ------------------------------------------------------------------
    def _check_sqlite_vec() -> object:
        import sqlite_vec  # noqa: PLC0415

        conn2 = sqlite3.connect(":memory:", isolation_level=None)
        conn2.enable_load_extension(True)
        sqlite_vec.load(conn2)
        conn2.enable_load_extension(False)
        vec_ver = conn2.execute("SELECT vec_version()").fetchone()[0]
        conn2.close()
        return vec_ver

    if ext_ok:
        _check_step("sqlite-vec", _check_sqlite_vec, time_ms=True)
    else:
        flag("sqlite-vec", "skipped (no extension support)", warn=True)

    # ------------------------------------------------------------------
    # 5. fastembed
    # ------------------------------------------------------------------
    def _check_fastembed() -> str:
        importlib.import_module("fastembed")
        return "importable"

    # time_ms=True surfaces the cold-import duration: fastembed pulls in
    # onnxruntime, huggingface_hub, and tokenizers, so an "importable" check
    # that takes >1 s is a flag that the venv is on a slow disk or the model
    # cache is being initialised; either way it explains slow first-time
    # `token-goat semantic` invocations.
    _check_step("fastembed", _check_fastembed, time_ms=True)

    # ------------------------------------------------------------------
    # 6. Pillow
    # ------------------------------------------------------------------
    # Probe codec availability, not just import — image_shrink defaults to
    # WebP encoding (~39% smaller than JPEG on screenshots), so missing
    # libwebp on Linux source builds silently breaks the shrink pipeline.
    try:
        import PIL  # noqa: PLC0415
        from PIL import Image, features  # noqa: PLC0415

        ok("Pillow", PIL.__version__)
        codec_status = []
        for codec, label in (("webp", "WebP"), ("jpg", "JPEG"), ("zlib", "PNG")):
            if features.check(codec):
                codec_status.append(f"{label}=ok")
            else:
                codec_status.append(f"{label}=MISSING")
        # Smoke-test actual encode for the default lossy format so a half-broken
        # libwebp (loadable but encode-broken) surfaces here.
        try:
            import io  # noqa: PLC0415

            buf = io.BytesIO()
            Image.new("RGB", (4, 4), (200, 100, 50)).save(buf, "WEBP", quality=80)
            codec_status.append("WebP-encode=ok")
        except Exception as exc:  # noqa: BLE001
            codec_status.append(f"WebP-encode=FAIL ({type(exc).__name__})")
        joined = ", ".join(codec_status)
        if "MISSING" in joined or "FAIL" in joined:
            flag(
                "Pillow codecs",
                f"{joined} — see README 'Image support' for platform install hints",
                warn=True,
            )
        else:
            ok("Pillow codecs", joined)
    except ImportError as e:
        flag("Pillow", f"not importable — {e}")

    # ------------------------------------------------------------------
    # 7. tree-sitter
    # ------------------------------------------------------------------
    try:
        import tree_sitter  # noqa: PLC0415

        ts_ver = getattr(tree_sitter, "__version__", "installed")
        try:
            importlib.import_module("tree_sitter_language_pack")
            ok("tree-sitter", f"{ts_ver} — language-pack importable")
        except ImportError:
            flag("tree-sitter", f"{ts_ver} — tree_sitter_language_pack missing", warn=True)
    except ImportError as e:
        flag("tree-sitter", f"not importable — {e}")

    # ------------------------------------------------------------------
    # 8. Project
    # ------------------------------------------------------------------
    typer.echo("\nProject")
    cwd = Path.cwd()
    ok("cwd", str(cwd))
    proj = project.find_project(cwd)
    if proj is not None:
        ok("detected", f"yes (marker: {proj.marker})")
        ok("hash", f"{proj.hash[:8]}...")
        # Surface the canonical-form input that produced the hash so users
        # can verify drive-letter case, separator style, and symlink-resolved
        # target match expectations.  The full posix string is what gets
        # SHA1-hashed; mismatch here is the source of fragmented indexes.
        ok("canonical_root", proj.root.as_posix())
        try:
            with _db.open_project(proj.hash) as conn:
                row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                sv = row[0] if row else "?"
                fc_row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
                fc = fc_row[0] if fc_row else 0
            ok("schema_version", sv)
            ok("file_count", f"{fc} (not yet indexed)" if fc == 0 else str(fc))
        except Exception as e:  # noqa: BLE001
            flag("project db", str(e))
    else:
        flag("detected", "no project marker found in cwd or parents", warn=True)

    # ------------------------------------------------------------------
    # 8a. All-projects index health
    # ------------------------------------------------------------------
    # The per-project check above only covers the cwd.  Surfacing all indexed
    # projects lets a user spot a large index they forgot about, detect a DB
    # that went corrupt or missing, and understand the total index footprint.
    typer.echo("\nIndexed projects")
    try:
        with _db.open_global_readonly() as _idx_conn:
            _idx_conn.row_factory = __import__("sqlite3").Row
            _all_projs = _idx_conn.execute("SELECT hash, root FROM projects").fetchall()
        if not _all_projs:
            ok("(none)", "no projects indexed yet — run `token-goat index` inside a project")
        else:
            _total_files_all = 0
            _inaccessible: list[str] = []
            _proj_rows_out: list[str] = []
            for _pr in _all_projs:
                _ph = _pr["hash"]
                _pr_root = _pr["root"]
                _proj_db_path = paths.project_db_path(_ph)
                if not _proj_db_path.exists():
                    _inaccessible.append(f"{_pr_root} (DB missing: {_proj_db_path})")
                    continue
                try:
                    with _db.open_project_readonly(_ph) as _pc:
                        _pfc = _pc.execute("SELECT COUNT(*) FROM files").fetchone()[0]
                    _total_files_all += _pfc
                    _proj_rows_out.append(f"{_pr_root} ({_pfc} files)")
                except Exception as _pe:  # noqa: BLE001
                    _inaccessible.append(f"{_pr_root} ({_pe})")
            ok("total projects", str(len(_all_projs)))
            ok("total indexed files", str(_total_files_all))
            # Show up to 5 projects inline to avoid overwhelming output.
            for _pline in _proj_rows_out[:5]:
                ok("project", _pline)
            if len(_proj_rows_out) > 5:
                ok("...", f"({len(_proj_rows_out) - 5} more — run `token-goat stats --by-project` for full list)")
            for _bad in _inaccessible:
                flag("inaccessible", _bad, warn=True)
    except FileNotFoundError:
        ok("(none)", "no global.db yet — nothing indexed")
    except Exception as _e_idx:  # noqa: BLE001
        flag("index health", str(_e_idx), warn=True)

    # ------------------------------------------------------------------
    # 8a-large. Large file summary across all indexed projects
    # ------------------------------------------------------------------
    # Surfaces how many files across all projects are currently in the skip or
    # symbol-only tiers.  Useful to confirm the thresholds are actually doing
    # something and to spot unexpectedly large files that might need attention.
    typer.echo("\nLarge files (current thresholds)")
    try:
        from . import config as _config_lf  # noqa: PLC0415

        _lf_cfg = _config_lf.load().indexing
        _lf_skip_bytes = _lf_cfg.large_file_skip_kb * 1024
        _lf_symbol_only_bytes = _lf_cfg.large_file_symbol_only_kb * 1024
        _lf_total_skipped = 0
        _lf_total_symbol_only = 0
        _lf_project_count = 0
        try:
            with _db.open_global_readonly() as _lf_gconn:
                _lf_all_projs = _lf_gconn.execute("SELECT hash, root FROM projects").fetchall()
            for _lf_pr in _lf_all_projs:
                _lf_ph = _lf_pr["hash"]
                _lf_db_path = paths.project_db_path(_lf_ph)
                if not _lf_db_path.exists():
                    continue
                try:
                    with _db.open_project_readonly(_lf_ph) as _lf_pc:
                        # Count files over skip threshold
                        _s = _lf_pc.execute(
                            "SELECT COUNT(*) FROM files WHERE size > ?", (_lf_skip_bytes,)
                        ).fetchone()
                        _lf_total_skipped += int(_s[0] if _s else 0)
                        # Count files in the symbol-only tier (> symbol_only but <= skip)
                        _so = _lf_pc.execute(
                            "SELECT COUNT(*) FROM files WHERE size > ? AND size <= ?",
                            (_lf_symbol_only_bytes, _lf_skip_bytes),
                        ).fetchone()
                        _lf_total_symbol_only += int(_so[0] if _so else 0)
                    _lf_project_count += 1
                except Exception:  # noqa: BLE001
                    continue
        except FileNotFoundError:
            pass  # no global.db yet
        if _lf_project_count == 0:
            ok("summary", "no projects indexed yet")
        else:
            ok(
                "symbol-only files",
                f"{_lf_total_symbol_only} (>{_lf_cfg.large_file_symbol_only_kb} KB, "
                f"≤{_lf_cfg.large_file_skip_kb} KB, symbols indexed but not embedded)",
            )
            if _lf_total_skipped > 0:
                flag(
                    "oversized files in index",
                    f"{_lf_total_skipped} files >{_lf_cfg.large_file_skip_kb} KB found in DB "
                    f"(indexed before threshold was applied; re-run `token-goat index --full` to enforce)",
                    warn=True,
                )
            else:
                ok("oversized files in index", "0 (none exceed the skip threshold)")
    except Exception as _e_lf:  # noqa: BLE001
        flag("large files", f"check failed — {_e_lf}", warn=True)

    # ------------------------------------------------------------------
    # 8b. Hook wrapper
    # Checked before the Worker section: a missing or stale wrapper causes
    # hooks to silently fail, which then manifests as worker symptoms.
    # ------------------------------------------------------------------
    typer.echo("\nHook wrapper")
    wrapper_path = paths.hook_wrapper_path()
    if not wrapper_path.exists():
        flag("exists", f"NOT FOUND at {wrapper_path} — run `token-goat install` to create it")
    else:
        ok("exists", str(wrapper_path))

        # Drift detection: compare on-disk content with what install would write today.
        # Read in binary mode and decode so line endings are preserved verbatim
        # (the wrapper uses CRLF on Windows; Python text-mode open() translates
        # \r\n → \n, which would cause a false "differs" on every Windows install).
        try:
            on_disk = wrapper_path.read_bytes().decode("utf-8", errors="replace")
            expected = paths.hook_wrapper_content()
            if on_disk == expected:
                ok("content", "up to date")
            else:
                flag(
                    "content",
                    "differs from expected — run `token-goat install` to refresh",
                    warn=True,
                )
        except Exception as _e:  # noqa: BLE001
            flag("content", f"could not read — {_e}", warn=True)

        # Functional check: invoke the wrapper with --version and verify a response.
        try:
            _wrap_result = subprocess.run(
                [str(wrapper_path), "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if _wrap_result.returncode == 0 and _wrap_result.stdout.strip():
                ok("invoke", f"ok — {_wrap_result.stdout.strip()[:80]}")
            else:
                flag(
                    "invoke",
                    f"exit {_wrap_result.returncode} — {(_wrap_result.stderr or _wrap_result.stdout).strip()[:120]}",
                    warn=True,
                )
        except FileNotFoundError:
            flag("invoke", "wrapper not executable or not found by shell", warn=True)
        except subprocess.TimeoutExpired:
            flag("invoke", "timed out after 10s", warn=True)
        except Exception as _e:  # noqa: BLE001
            flag("invoke", f"error — {_e}", warn=True)

    # ------------------------------------------------------------------
    # 9. Worker
    # ------------------------------------------------------------------
    typer.echo("\nWorker")
    pid_path = paths.worker_pid_path()
    hb_path = paths.worker_heartbeat_path()
    if pid_path.exists():
        try:
            from . import worker as _worker_pid  # noqa: PLC0415
            pid_val, pid_interpreter = _worker_pid._read_pid_info(
                pid_path.read_text(encoding="utf-8")
            )
            if psutil.pid_exists(pid_val):
                _pid_label = f"PID {pid_val}"
                if pid_interpreter:
                    _pid_label += f", interpreter {pid_interpreter}"
                ok("pid file", f"present ({_pid_label})")
                if hb_path.exists():
                    # Derive the doctor's freshness threshold from the
                    # worker's authoritative formula rather than a hard-coded
                    # 120s — keeps `doctor` consistent with `_is_heartbeat_fresh`
                    # and `_nudge_worker_if_down` if HEARTBEAT_INTERVAL is ever
                    # tuned.  Doctor is a snapshot rather than a watchdog, so
                    # any age above the stale threshold is reported verbatim.
                    from . import worker as _worker_hb  # noqa: PLC0415

                    hb_age = time.time() - hb_path.stat().st_mtime
                    stale_after = _worker_hb.heartbeat_stale_threshold()
                    if hb_age <= stale_after:
                        ok("heartbeat", f"{int(hb_age)}s ago — fresh")
                    else:
                        flag(
                            "heartbeat",
                            f"{int(hb_age)}s ago — stale "
                            f"(threshold {int(stale_after)}s)",
                            warn=True,
                        )
                else:
                    flag("heartbeat", "missing", warn=True)
            else:
                _dead_label = f"present but PID {pid_val} not alive"
                if pid_interpreter:
                    _dead_label += f" (interpreter {pid_interpreter})"
                flag("pid file", _dead_label, warn=True)
                # Heartbeat age is meaningful even for zombie workers: a very
                # recent heartbeat suggests the process just exited cleanly,
                # while a stale heartbeat (>5 min) with a dead PID strongly
                # suggests the worker crashed or was killed without cleanup.
                if hb_path.exists():
                    try:
                        hb_age = time.time() - hb_path.stat().st_mtime
                        _ZOMBIE_THRESHOLD = 300  # 5 minutes
                        if hb_age > _ZOMBIE_THRESHOLD:
                            flag(
                                "heartbeat",
                                f"{int(hb_age)}s ago — zombie worker (pid gone, heartbeat stale)",
                                warn=True,
                            )
                        else:
                            ok("heartbeat", f"{int(hb_age)}s ago — process recently exited")
                    except OSError:
                        pass  # heartbeat file disappeared between exists() and stat()
        except Exception as e:  # noqa: BLE001
            flag("pid file", f"unreadable — {e}", warn=True)
    else:
        ok("pid file", "not present")
        flag("status", "not running — run `token-goat worker --start` to enable incremental indexing", warn=True)

    # Worker claim file — the authoritative single-worker lock. A stale claim
    # left by a crashed worker is auto-reclaimed on the next spawn, but it is
    # worth surfacing so an unexpected one is visible.
    from . import worker as _worker  # noqa: PLC0415

    claim_path = _worker._worker_claim_path()
    if not claim_path.exists():
        ok("claim file", "not present")
    elif _worker._worker_claim_is_stale(claim_path):
        flag("claim file", "stale (owner gone) — auto-reclaimed on next spawn", warn=True)
    else:
        try:
            claim_pid = int(claim_path.read_text(encoding="utf-8").split("\n", 1)[0])
            ok("claim file", f"held by live PID {claim_pid}")
        except (OSError, ValueError):
            ok("claim file", "held (owner mid-startup)")

    # Worker pool size — show configured max_pool_workers and ceiling so the user
    # can verify the thread-pool cap is active and tune it if desired.
    try:
        from . import config as _cfg_doc  # noqa: PLC0415
        _wk_cfg = _cfg_doc.load().worker
        _ceil = _cfg_doc.WORKER_MAX_POOL_CEILING
        ok(
            "pool workers",
            f"max_pool_workers={_wk_cfg.max_pool_workers} (ceiling={_ceil})",
        )
    except Exception as _e_pool:  # noqa: BLE001
        flag("pool workers", f"config unavailable — {_e_pool}", warn=True)

    # Index-spawn markers (locks/{hash}.indexing). A stale marker is harmless
    # — _index_spawn_active() ignores it — but a pile of them hints at indexers
    # that crashed or were killed. With --fix, reap them here (the same logic
    # the worker runs on startup) rather than only reporting them.
    locks_dir = paths.locks_dir()
    if fix:
        reaped = _worker.reap_stale_index_markers()
        ok("index markers", f"reaped {reaped} stale marker(s)")
    markers = sorted(locks_dir.glob("*.indexing")) if locks_dir.exists() else []
    if not markers:
        ok("index markers", "none")
    else:
        for m in markers:
            if _worker._index_spawn_active(m):
                ok("index marker", f"{m.stem[:8]} — index spawn active")
            else:
                flag("index marker", f"{m.stem[:8]} — stale, safe to delete", warn=True)

    # ------------------------------------------------------------------
    # 10. Dirty queue
    # ------------------------------------------------------------------
    typer.echo("\nDirty queue")
    queue_path = paths.dirty_queue_path()
    if not queue_path.exists():
        ok("depth", "0 (no queue file)")
    else:
        try:
            depth = sum(
                1 for ln in queue_path.read_text(encoding="utf-8").splitlines() if ln.strip()
            )
        except OSError as e:
            flag("depth", f"unreadable — {e}", warn=True)
        else:
            if depth == 0:
                ok("depth", "0 (empty)")
            elif depth < 200:
                ok("depth", f"{depth} pending (worker drains on next poll)")
            else:
                flag("depth", f"{depth} pending — worker may be down or behind", warn=True)

    # ------------------------------------------------------------------
    # 11. Scheduled tasks / autostart
    # ------------------------------------------------------------------
    typer.echo("\nScheduled tasks")
    # Worker uses HKCU Run registry key (no admin required); update uses schtasks WEEKLY.
    import sys as _sys

    if _sys.platform == "win32":
        try:
            import winreg

            _rk = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_READ,
            )
            _val, _ = winreg.QueryValueEx(_rk, "token-goat-worker")
            winreg.CloseKey(_rk)
            ok("token-goat-worker", f"Run key: {_val}")
        except FileNotFoundError:
            flag("token-goat-worker", "NOT INSTALLED (run `token-goat install`)", warn=True)
        except Exception as _e:  # noqa: BLE001
            flag("token-goat-worker", f"registry error: {_e}", warn=True)
    elif _sys.platform == "darwin":
        from . import install as _install  # noqa: PLC0415

        _plist = _install._launchd_plist_path()
        if _plist.exists():
            ok("token-goat-worker", f"LaunchAgent: {_plist}")
        else:
            flag("token-goat-worker", "LaunchAgent NOT INSTALLED (run `token-goat install`)", warn=True)
    else:
        from . import install as _install  # noqa: PLC0415

        _systemd = _install._systemd_service_path()
        _xdg = _install._xdg_autostart_path()
        if _systemd.exists():
            ok("token-goat-worker", f"systemd user service: {_systemd}")
        elif _xdg.exists():
            ok("token-goat-worker", f"XDG autostart: {_xdg}")
        else:
            flag("token-goat-worker", "autostart NOT INSTALLED (run `token-goat install`)", warn=True)

    # ------------------------------------------------------------------
    # 12. Recent log
    # ------------------------------------------------------------------
    typer.echo("\nRecent log")
    today = date.today().strftime("%Y-%m-%d")
    log_file = paths.logs_dir() / f"{today}.log"
    if log_file.exists():
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
            for line in lines[-5:]:
                typer.echo(f"  {line}")
        except Exception as e:  # noqa: BLE001
            flag("log", str(e), warn=True)
    else:
        ok("(none)", "no log for today")

    # ------------------------------------------------------------------
    # 12a. Session health
    # ------------------------------------------------------------------
    # Session files track per-session read history for hint generation.  Surfacing
    # the count, oldest age, and total size helps spot stale sessions that could
    # be cleaned up and verifies the session cache is being populated.
    typer.echo("\nSession health")
    try:
        sessions_dir = paths.sessions_dir()
        if not sessions_dir.exists():
            ok("session files", "0 (directory not yet created)")
        else:
            session_files = list(sessions_dir.glob("*.json"))
            if not session_files:
                ok("session files", "0 (empty)")
            else:
                now = time.time()
                total_size = 0
                oldest_mtime = None
                for sf in session_files:
                    try:
                        st = sf.stat()
                        total_size += st.st_size
                        if oldest_mtime is None or st.st_mtime < oldest_mtime:
                            oldest_mtime = st.st_mtime
                    except OSError:
                        continue
                oldest_age_sec = int(now - oldest_mtime) if oldest_mtime is not None else None
                ok("session files", f"{len(session_files)} file(s)")
                if oldest_age_sec is not None:
                    oldest_age_days = oldest_age_sec / 86400
                    if oldest_age_days > 7:
                        flag(
                            "oldest session",
                            f"{oldest_age_days:.1f}d ago (7+ days; consider `token-goat clean --sessions`)",
                            warn=True,
                        )
                    else:
                        ok("oldest session", f"{oldest_age_sec // 3600}h ago")
                ok("sessions/ size", _humanize_bytes_doctor(total_size))
    except Exception as e:  # noqa: BLE001
        flag("session health", str(e), warn=True)

    # ------------------------------------------------------------------
    # 13. Cache sizes
    # ------------------------------------------------------------------
    # In addition to the per-cache section below, surface an aggregated cache
    # directory size breakdown so the user can see the total footprint and identify
    # which cache (images, bash_outputs, web_outputs, skills) is dominating.
    typer.echo("\nCache sizes")
    cache_dirs = [
        ("bash_outputs", "bash_outputs"),
        ("web_outputs", "web_outputs"),
        ("images", "images"),
        ("skills", "skills"),
    ]
    cache_total_bytes = 0
    cache_details: list[tuple[str, int, int]] = []  # (label, bytes, files)
    for label, dir_name in cache_dirs:
        d = paths.data_dir() / dir_name
        if not d.exists():
            continue
        try:
            total_bytes, file_count, _ = _cache_dir_stats(d)
            cache_total_bytes += total_bytes
            cache_details.append((label, total_bytes, file_count))
        except OSError:
            continue
    if cache_details:
        for label, total_bytes, file_count in cache_details:
            ok(f"{label}", f"{file_count} files, {_humanize_bytes_doctor(total_bytes)}")
        ok("total cache size", _humanize_bytes_doctor(cache_total_bytes))
    else:
        ok("(none)", "cache directories not yet created")

    # ------------------------------------------------------------------
    # 13-skill. Skill cache health
    # ------------------------------------------------------------------
    # Shows how many distinct skills are cached, the total on-disk size,
    # the age of the oldest/newest entry, and whether any cached entry is
    # stale (the source file on disk was modified after the body was cached).
    typer.echo("\nSkill cache health")
    try:
        import pathlib as _pathlib  # noqa: PLC0415

        from . import skill_cache as _skill_cache  # noqa: PLC0415

        all_outputs = _skill_cache.list_outputs()
        # Filter to non-compact body files only (compact entries end with "-compact").
        body_entries = [e for e in all_outputs if not str(e.get("output_id", "")).endswith("-compact")]
        if not body_entries:
            ok("(none)", "no skill bodies cached yet")
        else:
            # Count distinct skill names and aggregate metrics.
            # Prefer sidecar metadata when available; fall back to stat-derived
            # mtime and disk size so entries stored without a sidecar are still
            # counted and aged correctly.
            skill_names: set[str] = set()
            total_body_bytes = 0
            oldest_ts: float | None = None
            newest_ts: float | None = None
            stale_count = 0
            for entry in body_entries:
                oid = entry.get("output_id")
                if not oid:
                    continue
                meta = _skill_cache.read_sidecar(oid)
                if meta is not None:
                    skill_names.add(meta.skill_name)
                    total_body_bytes += meta.body_bytes
                    entry_ts = meta.ts
                else:
                    # No sidecar — derive name from output_id and size from disk.
                    # output_id format: {session_prefix}-{safe_name}-{sha}
                    parts = str(oid).split("-")
                    if len(parts) >= 3:
                        # skill name is everything between prefix and sha (last part)
                        skill_names.add("-".join(parts[1:-1]))
                    disk_bytes = int(entry.get("size_bytes", 0))
                    total_body_bytes += disk_bytes
                    entry_ts = float(entry.get("mtime", 0.0))

                if entry_ts:
                    if oldest_ts is None or entry_ts < oldest_ts:
                        oldest_ts = entry_ts
                    if newest_ts is None or entry_ts > newest_ts:
                        newest_ts = entry_ts

                # Stale detection: if source_path is known (via sidecar) and
                # the source file on disk is newer than the cached body, flag it.
                if meta is not None and meta.source_path:
                    try:
                        src_path = _pathlib.Path(meta.source_path)
                        if src_path.is_file():
                            src_mtime = src_path.stat().st_mtime
                            if src_mtime > meta.ts:
                                stale_count += 1
                    except Exception:  # noqa: BLE001
                        pass

            ok("distinct skills", str(len(skill_names)))
            ok("cached entries", str(len(body_entries)))
            ok("total body bytes", _humanize_bytes_doctor(total_body_bytes))
            if oldest_ts is not None:
                oldest_age_days = (time.time() - oldest_ts) / 86400
                ok("oldest entry", f"{oldest_age_days:.1f}d ago")
            if newest_ts is not None:
                newest_age_h = (time.time() - newest_ts) / 3600
                ok("newest entry", f"{newest_age_h:.1f}h ago")
            if stale_count > 0:
                flag(
                    "stale entries",
                    f"{stale_count} (source file changed after caching; "
                    "use `token-goat skill-body <name>` to check currency)",
                    warn=True,
                )
            else:
                ok("stale entries", "0")

            # ----------------------------------------------------------
            # Compact-to-body ratio guard: warn when a skill's compact is
            # less than 20% of the full body — the compact is so small
            # relative to the body that it may be missing load-bearing
            # content, or the skill body has grown significantly since the
            # compact was generated (so token savings estimates are stale).
            # Threshold: compact must be at least 5% of the body (below
            # that it is likely a stub) and at most 20% of the body to be
            # considered healthy.  The upper bound is intentionally loose —
            # compacts above 20% are fine (more coverage).  The "< 5%"
            # lower bound flags near-empty compacts that would provide
            # little recall value.
            # ----------------------------------------------------------
            try:
                compact_entries = [
                    e for e in all_outputs
                    if str(e.get("output_id", "")).endswith("-compact")
                ]
                _COMPACT_RATIO_WARN = 0.20  # < 20% → compact too small relative to body
                low_ratio_skills: list[str] = []
                for ce in compact_entries:
                    coid = ce.get("output_id", "")
                    # Derive the skill name from the compact output ID.
                    # Compact IDs end with "-compact"; the preceding segment is
                    # "{session_prefix}-{safe_skill_name}-compact".
                    name_candidate = str(coid)
                    if name_candidate.endswith("-compact"):
                        name_candidate = name_candidate[:-len("-compact")]
                    # Strip session prefix (first segment, separated by "-").
                    parts = name_candidate.split("-")
                    skill_label = "-".join(parts[1:]) if len(parts) >= 2 else name_candidate

                    compact_size = int(ce.get("size_bytes", 0))
                    if compact_size == 0:
                        continue

                    # Find the corresponding body entry to get body_bytes.
                    # Match by skill name: look for a sidecar whose skill_name
                    # normalises to the same label.
                    body_size: int | None = None
                    for be in body_entries:
                        boid = be.get("output_id", "")
                        bm = _skill_cache.read_sidecar(boid)
                        if bm is not None and bm.skill_name and bm.skill_name.lower() == skill_label.lower():
                            body_size = bm.body_bytes
                            break

                    if body_size is None or body_size == 0:
                        continue

                    ratio = compact_size / body_size
                    if ratio < _COMPACT_RATIO_WARN:
                        low_ratio_skills.append(
                            f"{skill_label} ({ratio:.0%} of body — "
                            f"run `token-goat skill-compact {skill_label}` to refresh)"
                        )

                if low_ratio_skills:
                    flag(
                        "compact coverage",
                        f"{len(low_ratio_skills)} skill(s) with compact < 20% of body: "
                        + ", ".join(low_ratio_skills),
                        warn=True,
                    )
                else:
                    ok("compact coverage", "ok (all compacts ≥ 20% of body, or no compacts yet)")

                # ----------------------------------------------------------
                # Compact SHA-staleness check: the compact header embeds a
                # 12-char prefix of the body SHA used to generate it.  When
                # that prefix no longer matches the sidecar's content_sha,
                # the compact was built from a different version of the body
                # and the cached summary may be misleading.  This is distinct
                # from the mtime-based stale check above, which only catches
                # on-disk source-file changes; here we catch cases where the
                # body was replaced via cross-session dedup without touching
                # the source file on disk.
                # ----------------------------------------------------------
                sha_stale_skills: list[str] = []
                try:

                    cache_dir_p = _skill_cache._skill_outputs_dir()  # type: ignore[attr-defined]
                    for ce2 in compact_entries:
                        coid2 = str(ce2.get("output_id", ""))
                        if not coid2:
                            continue
                        compact_path = cache_dir_p / coid2
                        if not compact_path.is_file():
                            continue
                        try:
                            compact_text = compact_path.read_text(encoding="utf-8", errors="replace")
                        except OSError:
                            continue
                        embedded_sha = _skill_cache.extract_compact_source_sha(compact_text)
                        if not embedded_sha:
                            # Compact was written by an older build without SHA — skip.
                            continue

                        # Derive skill_label from compact ID.
                        name_c = coid2
                        if name_c.endswith("-compact"):
                            name_c = name_c[:-len("-compact")]
                        parts_c = name_c.split("-")
                        label_c = "-".join(parts_c[1:]) if len(parts_c) >= 2 else name_c

                        # Find the body sidecar that matches this skill label.
                        body_sha: str | None = None
                        for be2 in body_entries:
                            boid2 = be2.get("output_id", "")
                            bm2 = _skill_cache.read_sidecar(boid2)
                            if bm2 is not None and bm2.skill_name and bm2.skill_name.lower() == label_c.lower():
                                body_sha = bm2.content_sha
                                break

                        if body_sha is None:
                            continue
                        # Compare the embedded 12-char prefix against the body SHA.
                        if not body_sha.startswith(embedded_sha):
                            sha_stale_skills.append(
                                f"{label_c} (compact sha={embedded_sha[:8]} ≠ body sha={body_sha[:8]};"
                                f" run `token-goat skill-compact {label_c}` to refresh)"
                            )
                except Exception:  # noqa: BLE001
                    pass

                if sha_stale_skills:
                    flag(
                        "sha-stale compacts",
                        f"{len(sha_stale_skills)} compact(s) built from a superseded body version: "
                        + ", ".join(sha_stale_skills),
                        warn=True,
                    )
                else:
                    ok("sha-stale compacts", "0 (all compacts match their body SHA, or no SHA recorded)")
            except Exception:  # noqa: BLE001 — compact ratio check is best-effort
                pass

    except Exception as _e_skill_health:  # noqa: BLE001
        flag("skill cache health", str(_e_skill_health), warn=True)

    # ------------------------------------------------------------------
    # 13a. Index health per project
    # ------------------------------------------------------------------
    # For each indexed project, report file count, symbol count, and last-indexed
    # timestamp so the user can verify indexing is up-to-date and understand
    # the index footprint per project.
    typer.echo("\nIndex health per project")
    try:
        with _db.open_global_readonly() as gconn:
            gconn.row_factory = __import__("sqlite3").Row
            all_projs = gconn.execute("SELECT hash, root FROM projects").fetchall()
        if not all_projs:
            ok("(none)", "no projects indexed yet")
        else:
            for proj in all_projs:
                proj_hash = proj["hash"]
                proj_root = proj["root"]
                proj_db_path = paths.project_db_path(proj_hash)
                if not proj_db_path.exists():
                    flag(
                        f"project {proj_root[:40]}",
                        f"DB missing ({proj_db_path})",
                        warn=True,
                    )
                    continue
                try:
                    with _db.open_project_readonly(proj_hash) as pconn:
                        # File count
                        fc_row = pconn.execute("SELECT COUNT(*) FROM files").fetchone()
                        file_count = fc_row[0] if fc_row else 0
                        # Symbol count
                        sym_row = pconn.execute("SELECT COUNT(*) FROM symbols").fetchone()
                        symbol_count = sym_row[0] if sym_row else 0
                        # Last-indexed timestamp (max(mtime) from files table)
                        ts_row = pconn.execute("SELECT MAX(mtime) FROM files").fetchone()
                        last_mtime = ts_row[0] if ts_row and ts_row[0] else None
                    now = time.time()
                    timestamp_str = "never"
                    if last_mtime is not None:
                        age_sec = int(now - last_mtime)
                        if age_sec < 3600:
                            timestamp_str = f"{age_sec // 60}m ago"
                        elif age_sec < 86400:
                            timestamp_str = f"{age_sec // 3600}h ago"
                        else:
                            timestamp_str = f"{age_sec // 86400}d ago"
                    ok(
                        f"project {proj_root[:40]}",
                        f"{file_count} files, {symbol_count} symbols, last indexed {timestamp_str}",
                    )
                except Exception as pe:  # noqa: BLE001
                    flag(
                        f"project {proj_root[:40]}",
                        str(pe),
                        warn=True,
                    )
    except FileNotFoundError:
        ok("(none)", "no global.db yet")
    except Exception as e:  # noqa: BLE001
        flag("index health per project", str(e), warn=True)

    # ------------------------------------------------------------------
    # 14. New-cache stores (bash outputs, web outputs, session snapshots)
    # ------------------------------------------------------------------
    # Surfaces the disk-store stats added by the bash-output / WebFetch /
    # diff-aware-re-read features so a long-lived install can be inspected
    # for runaway growth without grep-ing the data directory by hand.
    typer.echo("\nCache details")
    # cap_file_count is the max number of .txt body files (each may also have a
    # .json sidecar, so the physical directory-entry count can be up to 2× this).
    # None means no file-count cap applies (e.g. session_snapshots).
    for label, dir_name, cap_bytes, cap_file_count in (
        ("bash outputs", "bash_outputs", 16 * 1024 * 1024, 4096),
        ("web outputs", "web_outputs", 32 * 1024 * 1024, 4096),
        ("session snapshots", "session_snapshots", None, None),
    ):
        _render_cache_section(label, dir_name, cap_bytes, cap_file_count, ok, flag)

    # ------------------------------------------------------------------
    # 13a. Cache hit-rate telemetry (30 d)
    # ------------------------------------------------------------------
    # The cache directories above show *capacity* (size / count) but not how
    # *useful* the cache has been.  A cache that is at 80% of its byte cap but
    # has a 5% hit rate is wasting space; one with a 95% hit rate has the cap
    # tuned right.  Reads `kind`-grouped stats over the trailing 30 days and
    # reports hit / (hit + miss) for the three caches that record both halves:
    #
    #   • image_shrink_cache_hit vs image_shrink (fresh shrink) — content-hash
    #     dedup on the same image showing up twice in a session.
    #   • bash_output_recall vs bash_output_recall_miss — agent calling
    #     `token-goat bash-output <id>` for a known vs an evicted ID.
    #   • web_output_recall vs web_output_recall_miss — same shape for
    #     `token-goat web-output <id>`.
    #
    # Misses are only recorded when [stats] record_zero_savings = true, so a
    # 100% rate may mean "miss telemetry is disabled" rather than "no misses".
    # The note is surfaced inline so the user is not misled.
    typer.echo("\nCache hit rates (30 d)")
    try:
        _cache_cutoff = int(time.time()) - 30 * 86400
        _miss_telemetry_on = False
        try:
            from . import config as _config_for_rate  # noqa: PLC0415

            _miss_telemetry_on = _config_for_rate.load().stats.record_zero_savings
        except Exception:  # noqa: BLE001
            pass
        with _db.open_global_readonly() as conn:
            for cache_label, hit_kind, miss_kind in (
                ("image shrink", "image_shrink_cache_hit", "image_shrink"),
                ("bash recall", "bash_output_recall", "bash_output_recall_miss"),
                ("web recall", "web_output_recall", "web_output_recall_miss"),
            ):
                _hit_row = conn.execute(
                    "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                    (hit_kind, _cache_cutoff),
                ).fetchone()
                _miss_row = conn.execute(
                    "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                    (miss_kind, _cache_cutoff),
                ).fetchone()
                _hits = int(_hit_row[0] if _hit_row else 0)
                _misses = int(_miss_row[0] if _miss_row else 0)
                _total = _hits + _misses
                if _total == 0:
                    ok(cache_label, "no events")
                    continue
                _rate = _hits / _total
                # For image_shrink the "miss" column is "fresh shrink" — both
                # are productive (a fresh shrink still saves tokens vs a raw
                # image), so a lower rate is not a problem.  The note clarifies
                # the asymmetry.
                if hit_kind == "image_shrink_cache_hit":
                    ok(
                        cache_label,
                        f"{_rate*100:.0f}% ({_hits} hits / {_total} shrinks; "
                        f"misses are fresh shrinks, also productive)",
                    )
                elif _miss_telemetry_on:
                    if _rate < 0.50 and _total >= 10:
                        flag(
                            cache_label,
                            f"{_rate*100:.0f}% ({_hits} hits / {_misses} misses) "
                            "— low; cap may be too small or eviction too aggressive",
                            warn=True,
                        )
                    else:
                        ok(
                            cache_label,
                            f"{_rate*100:.0f}% ({_hits} hits / {_misses} misses)",
                        )
                else:
                    # Misses are not recorded when record_zero_savings=false;
                    # we can still show hit count but not a rate.
                    ok(
                        cache_label,
                        f"{_hits} hits (misses not tracked — set stats.record_zero_savings=true)",
                    )
    except FileNotFoundError:
        ok("(none)", "no global.db yet")
    except Exception as _e_cache_rate:  # noqa: BLE001
        flag("cache hit rates", str(_e_cache_rate), warn=True)

    # ------------------------------------------------------------------
    # 13b. Configuration — opt-in flags + their effective values
    # ------------------------------------------------------------------
    # Surfaces the major opt-in flags (compact_assist, skill_preservation,
    # hints.json_sidecar, etc.) with their currently effective values so a
    # confused user (or a future agent) can answer "is feature X actually on?"
    # without grep-ing config.toml.  Honours env-var overrides since `config.load()`
    # applies them before returning the Config object.
    typer.echo("\nConfiguration")
    try:
        from . import config as _config  # noqa: PLC0415

        cfg = _config.load()
        # Show the config file path so users know where to put their config.toml.
        _config_path = paths.config_path()
        if _config_path.exists():
            ok("config file", str(_config_path))
        else:
            ok(
                "config file",
                f"{_config_path} (not present — all defaults active; create this file to customise)",
            )
        # compact_assist: master switch + the auto-trigger multiplier added in run 1 iter 3.
        ok("compact_assist.enabled", str(cfg.compact_assist.enabled).lower())
        ok(
            "compact_assist.auto_trigger_multiplier",
            f"{cfg.compact_assist.auto_trigger_multiplier:g}",
        )
        ok(
            "compact_assist.max_manifest_tokens",
            str(cfg.compact_assist.max_manifest_tokens),
        )
        # lazy_skill_injection: emit recall pointer instead of full compact body in manifest.
        ok(
            "compact_assist.lazy_skill_injection",
            str(cfg.compact_assist.lazy_skill_injection).lower(),
        )
        # skill_preservation: enabled / cache cap / large-skill knobs.
        ok("skill_preservation.enabled", str(cfg.skill_preservation.enabled).lower())
        ok(
            "skill_preservation.max_cache_bytes",
            str(cfg.skill_preservation.max_cache_bytes),
        )
        ok(
            "skill_preservation.truncation_budget_tokens",
            str(cfg.skill_preservation.truncation_budget_tokens),
        )
        ok(
            "skill_preservation.compress_bodies",
            str(cfg.skill_preservation.compress_bodies).lower(),
        )
        ok(
            "skill_preservation.compress_min_bytes",
            str(cfg.skill_preservation.compress_min_bytes),
        )
        # hints: json_sidecar (r2 iter 1) plus the quiet-hours window if set.
        ok("hints.json_sidecar", str(cfg.hints.json_sidecar).lower())
        if cfg.hints.quiet_hours:
            ok("hints.quiet_hours", cfg.hints.quiet_hours)
        ok(
            "hints.suppress_after_ignored",
            str(cfg.hints.suppress_after_ignored),
        )
        # serve_diff_on_reread: intercept re-reads of changed files and inject a diff.
        ok(
            "hints.serve_diff_on_reread",
            str(cfg.hints.serve_diff_on_reread).lower(),
        )
        # bash_compress: enabled + max line/byte caps so the user can verify
        # the safety net is intact.
        ok("bash_compress.enabled", str(cfg.bash_compress.enabled).lower())
        ok("bash_compress.max_lines", str(cfg.bash_compress.max_lines))
        # session_brief (r1): startup git-status orientation brief.
        ok("session_brief.enabled", str(cfg.session_brief.enabled).lower())
        # image_shrink (r1): AVIF/JPEG fallback + decode pixel cap.  Surfaces
        # the format threshold knobs added in run 1 so a user wondering "why
        # is my screenshot still 800 KB" can confirm AVIF is on (or see that
        # libaom is missing via the Pillow codec line above).
        ok("image_shrink.prefer_avif", str(cfg.image_shrink.prefer_avif).lower())
        ok("image_shrink.avif_quality", str(cfg.image_shrink.avif_quality))
        ok("image_shrink.jpeg_quality", str(cfg.image_shrink.jpeg_quality))
        ok("image_shrink.max_image_pixels", str(cfg.image_shrink.max_image_pixels))
        # curator (r2-r3): adaptive hint suppression once the agent ignores too
        # many.  Threshold + sample size answer "why did dedup hints go quiet?".
        ok("curator.enabled", str(cfg.curator.enabled).lower())
        ok("curator.min_samples", str(cfg.curator.min_samples))
        ok("curator.threshold_pct", str(cfg.curator.threshold_pct))
        # hint_budget: hard per-session caps that take over after curator.
        ok("hint_budget.enabled", str(cfg.hint_budget.enabled).lower())
        ok("hint_budget.max_per_session", str(cfg.hint_budget.max_per_session))
        ok(
            "hint_budget.max_structured_per_session",
            str(cfg.hint_budget.max_structured_per_session),
        )
        ok(
            "hint_budget.max_index_only_per_session",
            str(cfg.hint_budget.max_index_only_per_session),
        )
        # repomap (r1): compact-mode file threshold for `token-goat map --compact`.
        ok("repomap.compact_file_threshold", str(cfg.repomap.compact_file_threshold))
        # repomap (r2): exclude test dirs from repo map PageRank computation.
        ok("repomap.exclude_tests", str(cfg.repomap.exclude_tests).lower())
        # stats (r2): record_zero_savings switch.  Suggestion-only hints (zero
        # tokens saved, zero injection cost) skip writing stat rows by default
        # to keep the hot pre-read path cheap.  Surfacing it explicitly avoids
        # a "where did my zero-savings rows go?" investigation.
        ok("stats.record_zero_savings", str(cfg.stats.record_zero_savings).lower())
        # webfetch (security-relevant): URL allowlist / denylist sizes.  Showing
        # the list lengths rather than full contents avoids leaking sensitive
        # internal hostnames into doctor output that the user might paste into
        # a bug report.
        ok("webfetch.allow", f"{len(cfg.webfetch.allow)} pattern(s)")
        ok("webfetch.deny", f"{len(cfg.webfetch.deny)} pattern(s)")
        # indexing: large-file thresholds added in iter 18.
        ok(
            "indexing.large_file_symbol_only_kb",
            f"{cfg.indexing.large_file_symbol_only_kb} KB "
            f"(files larger than this get symbol-only indexing, no embeddings)",
        )
        ok(
            "indexing.large_file_skip_kb",
            f"{cfg.indexing.large_file_skip_kb} KB "
            f"(files larger than this are skipped entirely)",
        )
        # decision log: always-on opt-in CLI feature; surface the per-session
        # cap so the user knows the implicit ceiling.
        try:
            from . import session as _session  # noqa: PLC0415

            ok("decision_log.max_per_session", str(_session.DECISION_HISTORY_MAX))
        except Exception as exc:  # noqa: BLE001
            flag("decision_log.max_per_session", str(exc), warn=True)
    except Exception as e:  # noqa: BLE001
        flag("config load", str(e), warn=True)

    # ------------------------------------------------------------------
    # 13c. Compaction budget utilization (r5 iter 4)
    # ------------------------------------------------------------------
    # Reads compact_manifest stat rows (written by pre_compact hook) and reports
    # p50/p95/max utilization (actual_tokens / budget) over the trailing 30
    # days, plus a manual-vs-auto trigger breakdown.  Answers "are real
    # manifests landing near their budget caps or always under?" so the caps
    # can be tuned against data instead of guessed.  Warns when consistently
    # >95 % (sections being truncated, raise the cap) or <30 % (waste budget,
    # lower the cap).
    typer.echo("\nCompaction utilization (30 d)")
    try:
        _compact_cutoff = int(time.time()) - 30 * 86400
        _compact_rows: list[tuple[int, int, str]] = []
        with _db.open_global_readonly() as conn:
            for _detail_row in conn.execute(
                "SELECT detail FROM stats WHERE kind = ? AND ts >= ?",
                ("compact_manifest", _compact_cutoff),
            ).fetchall():
                _detail = _detail_row[0]
                if not _detail or not isinstance(_detail, str):
                    continue
                # Parse "budget=N,actual=M,trigger=T,events=E" — tolerant to
                # ordering, extra keys, and partial corruption.  Anything that
                # does not yield a positive budget+actual is silently skipped.
                _kv: dict[str, str] = {}
                for _part in _detail.split(","):
                    if "=" in _part:
                        _k, _v = _part.split("=", 1)
                        _kv[_k.strip()] = _v.strip()
                try:
                    _budget = int(_kv.get("budget", "0"))
                    _actual = int(_kv.get("actual", "0"))
                except ValueError:
                    continue
                if _budget <= 0 or _actual < 0:
                    continue
                _trigger = _kv.get("trigger", "unknown")
                _compact_rows.append((_budget, _actual, _trigger))

        if not _compact_rows:
            ok("(none)", "no manifest emits in last 30 d")
        else:
            _utils = sorted(_a / _b for _b, _a, _ in _compact_rows)
            _n = len(_utils)
            # p50/p95 via nearest-rank (no numpy dep): index = ceil(p/100 * n) - 1.
            # Both use the same ceiling formula: (n*p + 99) // 100 - 1.
            _p50 = _utils[max(0, (_n * 50 + 99) // 100 - 1)]
            _p95 = _utils[max(0, (_n * 95 + 99) // 100 - 1)]
            _u_max = _utils[-1]
            ok(
                "emits",
                f"{_n} (p50={_p50*100:.0f}%, p95={_p95*100:.0f}%, max={_u_max*100:.0f}%)",
            )

            # Trigger breakdown — auto-trigger manifests get the multiplier,
            # so their effective budget is larger; separating them avoids
            # blending two distinct distributions into one summary line.
            _by_trigger: dict[str, list[float]] = {}
            for _b, _a, _t in _compact_rows:
                _by_trigger.setdefault(_t, []).append(_a / _b)
            for _t in ("manual", "auto"):
                _vals = _by_trigger.get(_t)
                if _vals:
                    _avg = sum(_vals) / len(_vals)
                    ok(
                        f"{_t} trigger",
                        f"{len(_vals)} emits, avg={_avg*100:.0f}% utilization",
                    )

            # Tier breakdown — group emits by budget bucket so a single
            # outlier budget does not skew the global p50/p95.  Buckets
            # follow the repomap token tiers (300/500/1500/4000+) to surface
            # whether each tier hits its cap consistently.
            _tiers: list[tuple[str, int, int]] = [
                ("≤300", 0, 300),
                ("301-500", 301, 500),
                ("501-1500", 501, 1500),
                (">1500", 1501, 10**9),
            ]
            for _label, _lo, _hi in _tiers:
                _bucket = [
                    _a / _b
                    for _b, _a, _ in _compact_rows
                    if _lo <= _b <= _hi
                ]
                if _bucket:
                    _bucket_avg = sum(_bucket) / len(_bucket)
                    ok(
                        f"tier {_label}",
                        f"{len(_bucket)} emits, avg={_bucket_avg*100:.0f}% utilization",
                    )

            # Warnings — consistent over-utilization means sections are being
            # truncated; consistent under-utilization means the budget cap is
            # too generous and the manifest could afford a wider scope.
            if _p95 > 0.95:
                flag(
                    "utilization",
                    f"p95={_p95*100:.0f}% — manifests routinely hit the budget cap; "
                    "consider raising compact_assist.max_manifest_tokens",
                    warn=True,
                )
            elif _p95 < 0.30 and _n >= 5:
                flag(
                    "utilization",
                    f"p95={_p95*100:.0f}% — manifests rarely fill the budget; "
                    "consider lowering compact_assist.max_manifest_tokens to free context",
                    warn=True,
                )
    except FileNotFoundError:
        ok("(none)", "no global.db yet")
    except Exception as _e_compact:  # noqa: BLE001
        flag("compaction utilization", str(_e_compact), warn=True)

    # ------------------------------------------------------------------
    # 14. Stats summary + 14b. Cumulative-savings projection (item 11)
    # ------------------------------------------------------------------
    # Both sections read from global.db, so they share a single connection.
    # doctor only reads here — use the read-only opener. open_global() runs
    # PRAGMA integrity_check on connect, which is multi-second on a large
    # global.db; a diagnostic must not pay that cost or create the DB.
    typer.echo("\nStats")
    _row: tuple[Any, ...] | None = None
    _cache_row: tuple[Any, ...] | None = None
    _proj_row: tuple[Any, ...] | None = None
    _top_kinds: list[tuple[str, int]] = []
    _unknown_kinds: list[tuple[str, int]] = []
    _last_write_ts: float | None = None
    try:
        with _db.open_global_readonly() as conn:
            _row = conn.execute(
                "SELECT COUNT(*), SUM(tokens_saved), SUM(bytes_saved) FROM stats"
            ).fetchone()
            _cache_row = conn.execute(
                "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                ("session_cache_unavailable", int(time.time()) - 3600),
            ).fetchone()
            # Oldest stats row gives elapsed time; sum gives total savings.
            _proj_row = conn.execute(
                "SELECT SUM(tokens_saved), MIN(ts), MAX(ts) FROM stats"
            ).fetchone()

            # Top three mechanisms by tokens_saved over the last 30 days.  A
            # quick health signal: an install where one mechanism dominates
            # may be missing adoption of the others (e.g. surgical reads).
            _cutoff = int(time.time()) - 30 * 86400
            _top_kinds = [
                (r[0], int(r[1] or 0))
                for r in conn.execute(
                    "SELECT kind, SUM(tokens_saved) AS s "
                    "FROM stats WHERE ts >= ? "
                    "GROUP BY kind ORDER BY s DESC LIMIT 3",
                    (_cutoff,),
                ).fetchall()
            ]

            # Unknown kinds — anything that lands in SOURCE_OTHER.  A non-zero
            # count means a record_stat call uses a kind name that is not yet
            # in _KIND_TO_SOURCE (or its prefix table); the rows still appear
            # in totals but lose their mechanism attribution in the rollup.
            _all_kinds = [
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT kind FROM stats"
                ).fetchall()
            ]
            from . import stats as _stats_mod  # noqa: PLC0415
            _unknown_kind_names = [
                k for k in _all_kinds
                if _stats_mod.kind_to_source(k) == _stats_mod.SOURCE_OTHER
            ]
            if _unknown_kind_names:
                # Surface up to three with their event counts so the user can
                # tell whether the unmapped kind is a one-off or a leak.
                placeholders = ",".join("?" * len(_unknown_kind_names))
                _unknown_kinds = [
                    (r[0], int(r[1]))
                    for r in conn.execute(
                        f"SELECT kind, COUNT(*) FROM stats "
                        f"WHERE kind IN ({placeholders}) "
                        f"GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 3",
                        tuple(_unknown_kind_names),
                    ).fetchall()
                ]
    except FileNotFoundError:
        ok("(none)", "no recorded savings yet")
    except Exception as e:  # noqa: BLE001
        flag("stats", str(e), warn=True)

    if _row and _row[0]:
        ok("events", str(_row[0]))
        ok("tokens saved", str(_row[1] or 0))
        ok("bytes saved", str(_row[2] or 0))
    elif _row is not None:
        ok("(none)", "no recorded savings yet")

    # Last-write recency — a stats DB with no fresh rows in the last 24 h on a
    # supposedly-active install is a leading indicator of broken hook wiring.
    if _proj_row and _proj_row[2]:
        _last_write_ts = float(_proj_row[2])
        _age_s = max(0.0, time.time() - _last_write_ts)
        if _age_s < 3600:
            ok("last write", f"{_age_s/60:.0f}m ago")
        elif _age_s < 86400:
            ok("last write", f"{_age_s/3600:.1f}h ago")
        elif _age_s < 7 * 86400:
            flag("last write", f"{_age_s/86400:.1f}d ago (no recent activity)", warn=True)
        else:
            flag("last write", f"{_age_s/86400:.0f}d ago (stats DB looks stale)", warn=True)

    # Top 3 mechanisms by tokens_saved in the last 30 days — answers the
    # question "which intercept is paying off the most" at a glance, and
    # surfaces any mechanism that is silently underperforming.
    if _top_kinds:
        for kind_name, tokens in _top_kinds:
            ok(f"top kind: {kind_name}", f"{tokens} tokens (30d)")

    # Unknown-kind leak — surfaces invisible-bucket rows so a new record_stat
    # call site that forgot to register its kind in _KIND_TO_SOURCE gets
    # caught the next time someone runs doctor.
    if _unknown_kinds:
        names = ", ".join(f"{k} ({c})" for k, c in _unknown_kinds)
        flag(
            "unmapped kinds",
            f"{names} (add the base kind to _KIND_TO_SOURCE or a family to _KIND_PREFIX_TO_SOURCE; "
            f"`_overhead` suffix routes via the parent kind automatically)",
            warn=True,
        )
    elif _row and _row[0]:
        # Only show the all-clear line when there ARE rows; otherwise the
        # absence is just an empty DB, not a successful mapping audit.
        ok("kind coverage", "all kinds mapped to a source bucket")

    if _cache_row and _cache_row[0]:
        flag(
            "session-cache",
            f"{_cache_row[0]} contention event(s) in the last hour",
            warn=True,
        )
    elif _cache_row is not None:
        ok("session-cache", "no contention events in the last hour")

    # ------------------------------------------------------------------
    # 14b. Cumulative-savings projection (item 11)
    # ------------------------------------------------------------------
    # Estimate monthly cost savings assuming $3/1M input tokens and reading
    # the cumulative tokens_saved + the age of the oldest stats row.
    # This is intentionally a rough projection — the point is a ballpark
    # "are you getting value?" number, not an invoice.
    _COST_PER_1M_TOKENS: float = 3.0  # USD, conservative Claude input price
    if _proj_row and _proj_row[0] and _proj_row[1] and _proj_row[2]:
        _total_tokens = int(_proj_row[0])
        _oldest_ts = float(_proj_row[1])
        _newest_ts = float(_proj_row[2])
        _elapsed_days = (_newest_ts - _oldest_ts) / 86400.0
        if _elapsed_days >= 1.0:
            _tokens_per_day = _total_tokens / _elapsed_days
            _tokens_per_month = _tokens_per_day * 30
            _usd_per_month = (_tokens_per_month / 1_000_000) * _COST_PER_1M_TOKENS
            ok(
                "projected savings",
                f"${_usd_per_month:.2f}/month at current rate "
                f"({_tokens_per_month:,.0f} tokens/month, ${_COST_PER_1M_TOKENS}/1M)",
            )
        else:
            ok("projected savings", "< 1 day of data — check back tomorrow")

    # ------------------------------------------------------------------
    # 15b. DB contention metric (worker-stderr.log slow-session warnings)
    # ------------------------------------------------------------------
    # Counts "session slow" WARNING lines in worker-stderr.log written in the
    # last 24 h.  Each line represents a DB session that took ≥1 s — on a
    # single-user machine this means a reader was serialised behind a writer
    # (typically a full project reindex holding the connection open).  Surfacing
    # the count lets the user correlate perceived hook latency with real data.
    typer.echo("\nDB contention")
    _worker_stderr = paths.logs_dir() / "worker-stderr.log"
    try:
        if not _worker_stderr.exists():
            ok("slow sessions (24 h)", "0 (no worker-stderr.log)")
        else:
            import re as _re_dc  # noqa: PLC0415
            _SLOW_RE = _re_dc.compile(r"session slow: ([\d.]+)ms", _re_dc.IGNORECASE)
            _cutoff_dc = time.time() - 86400
            _slow_count = 0
            _slow_max_ms = 0.0
            # Parse ISO-8601-ish timestamps at the start of each line.
            # Worker log lines are formatted by Python's logging module:
            # "2026-05-25 12:34:56,789 WARNING … session slow: 2345.6ms …"
            _TS_RE = _re_dc.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
            import datetime  # noqa: PLC0415
            for _line in _worker_stderr.read_text(encoding="utf-8", errors="replace").splitlines():
                _m_slow = _SLOW_RE.search(_line)
                if not _m_slow:
                    continue
                # Check whether this line falls within the last 24 h.
                _m_ts = _TS_RE.match(_line)
                if _m_ts:
                    try:
                        _ts = datetime.datetime.strptime(
                            _m_ts.group(1), "%Y-%m-%d %H:%M:%S"
                        ).replace(tzinfo=datetime.UTC).timestamp()
                        if _ts < _cutoff_dc:
                            continue
                    except ValueError:
                        pass  # unparseable timestamp — include the line anyway
                _slow_count += 1
                try:
                    _ms = float(_m_slow.group(1))
                    if _ms > _slow_max_ms:
                        _slow_max_ms = _ms
                except ValueError:
                    pass
            if _slow_count == 0:
                ok("slow sessions (24 h)", "0 — no contention detected")
            elif _slow_count < 10:
                ok(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — low",
                )
            elif _slow_count < 50:
                flag(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — moderate; large reindexes hold DB open",
                    warn=True,
                )
            else:
                flag(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — HIGH; hooks may stall during reindex",
                    warn=True,
                )
    except Exception as _e_dc:  # noqa: BLE001
        flag("slow sessions (24 h)", f"unreadable — {_e_dc}", warn=True)

    # ------------------------------------------------------------------
    # 15. Recent hook crashes (item 9) — only shown with --crashes
    # ------------------------------------------------------------------
    if crashes:
        typer.echo("\nRecent hook crashes")
        try:
            crash_log = paths.hooks_stderr_log_path()
            if not crash_log.exists():
                ok("(none)", "hooks-stderr.log not found")
            else:
                raw_text = crash_log.read_text(encoding="utf-8", errors="replace")
                # Each crash is a block starting with "token-goat hook" and
                # followed by a traceback. Split on that prefix to get blocks.
                blocks = [b.strip() for b in raw_text.split("\ntoken-goat hook") if b.strip()]
                # Re-add the stripped prefix to all but the first block.
                if raw_text.startswith("token-goat hook"):
                    # First block already has the prefix
                    display_blocks = [("token-goat hook " + b if i > 0 else b) for i, b in enumerate(blocks)]
                else:
                    display_blocks = [("token-goat hook " + b) for b in blocks]
                last_5 = display_blocks[-5:] if len(display_blocks) > 5 else display_blocks
                if not last_5:
                    ok("(none)", "log exists but contains no crash entries")
                else:
                    typer.echo(f"  (showing last {len(last_5)} of {len(display_blocks)} crash block(s))")
                    for block in last_5:
                        for line in block.splitlines()[:6]:
                            typer.echo(f"  {line}")
                        typer.echo("  ---")
        except Exception as e:  # noqa: BLE001
            flag("crashes", str(e), warn=True)

    # ------------------------------------------------------------------
    # Context footprint
    # ------------------------------------------------------------------
    try:
        ctx_lines, ctx_auto_show = _build_context_section()
        if context or ctx_auto_show:
            for line in ctx_lines:
                typer.echo(line)
    except Exception as e:  # noqa: BLE001
        if context:
            flag("context footprint", str(e), warn=True)

    typer.echo("")
