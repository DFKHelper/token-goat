"""Implementation of ``token-goat context-stats``.

Shows the estimated startup context footprint broken down by source and
optionally runs safe structural pruning on the project's MEMORY.md index.
"""
from __future__ import annotations

import json as _json
import os
from pathlib import Path
from typing import Any

# Known-constant overhead estimates (tokens) for components token-goat cannot
# measure directly.  Derived from session L15/L29 measurements on a typical
# project (see context-stats design notes in CLAUDE.arch.md).
_SYSTEM_PROMPT_EST = 57_000   # system prompt + harness overhead
_SKILL_AGENT_EST = 14_000     # skill listing + agent listing injected at start
_CONTEXT_WINDOW = 200_000     # model window (conservative; Sonnet/Haiku = 200k)


def _find_claude_md_files(project_root: Path) -> list[Path]:
    """Return CLAUDE.md files that will be loaded for *project_root*.

    Claude Code loads: global ~/.claude/CLAUDE.md, then each CLAUDE.md walking
    down from the project root.  We walk up from the project root and include
    the global one.
    """
    found: list[Path] = []
    # Walk up from project root to filesystem root.
    current = project_root.resolve()
    while True:
        candidate = current / "CLAUDE.md"
        if candidate.is_file():
            found.append(candidate)
        parent = current.parent
        if parent == current:
            break
        current = parent
    # Global ~/.claude/CLAUDE.md.
    global_md = Path.home() / ".claude" / "CLAUDE.md"
    if global_md.is_file() and global_md not in found:
        found.append(global_md)
    return found


def _find_memory_md(project_root: Path) -> Path | None:
    """Return the MEMORY.md for *project_root* by scanning Claude's projects dir."""
    try:
        from . import paths

        projects_dir = paths.claude_projects_dir()
        if not projects_dir.is_dir():
            return None
        root_str = str(project_root.resolve())
        # Claude slugifies the path (non-alphanumerics → "-").
        import re
        expected_slug = re.sub(r"[^A-Za-z0-9]", "-", root_str).strip("-")
        candidate = projects_dir / expected_slug / "memory" / "MEMORY.md"
        if candidate.is_file():
            return candidate
        # Fallback: scan all project dirs for one whose slug matches prefix.
        for proj_dir in projects_dir.iterdir():
            if not proj_dir.is_dir():
                continue
            mem = proj_dir / "memory" / "MEMORY.md"
            if mem.is_file() and proj_dir.name == expected_slug:
                return mem
    except Exception:
        return None
    else:
        return None


def _tok(path: Path) -> int:
    """Token estimate for a file (bytes // 4)."""
    try:
        return max(0, path.stat().st_size) // 4
    except OSError:
        return 0


def _pct(tokens: int) -> str:
    return f"{tokens / _CONTEXT_WINDOW * 100:.1f}%"


def run(*, fix: bool, json_out: bool, project: Path | None) -> None:
    """Entry point for ``token-goat context-stats``."""
    import typer

    from . import memory_prune

    project_root = (project or Path(os.getcwd())).resolve()

    # --- Collect CLAUDE.md files ---
    claude_mds = _find_claude_md_files(project_root)
    claude_md_rows: list[dict[str, Any]] = []
    claude_md_total = 0
    for p in claude_mds:
        tok = _tok(p)
        claude_md_total += tok
        label = "~/.claude/CLAUDE.md" if p.parent.name == ".claude" else str(p.relative_to(project_root) if p.is_relative_to(project_root) else p)
        claude_md_rows.append({"label": label, "tokens": tok, "path": str(p)})

    # --- MEMORY.md ---
    memory_md = _find_memory_md(project_root)
    memory_tok = _tok(memory_md) if memory_md else 0
    memory_dir = memory_md.parent if memory_md else None

    # Count entries in MEMORY.md.
    entry_count = 0
    if memory_md:
        try:
            text = memory_md.read_text(encoding="utf-8", errors="replace")
            _, entries = memory_prune.parse_index(text)
            entry_count = len(entries)
        except OSError:
            pass

    # --- Prune (optional) ---
    prune_result: memory_prune.PruneResult | None = None
    if fix and memory_dir:
        prune_result = memory_prune.prune_index(memory_dir)

    # --- Dry-run prune to show what's reclaimable ---
    dry_result: memory_prune.PruneResult | None = None
    if memory_dir and not fix:
        dry_result = memory_prune.prune_index(memory_dir, dry_run=True)

    # --- Content duplicate detection ---
    import contextlib as _cl
    dup_clusters: list[memory_prune.DupCluster] = []
    if memory_dir:
        with _cl.suppress(Exception):
            dup_clusters = memory_prune.find_content_duplicates(memory_dir)

    # --- CLAUDE.md audit ---
    audit_reports: list[memory_prune.ClaudeMdReport] = []
    with _cl.suppress(Exception):
        audit_reports = memory_prune.audit_claude_md(claude_mds)

    user_total = claude_md_total + memory_tok
    fixed_total = _SYSTEM_PROMPT_EST + _SKILL_AGENT_EST
    grand_total = fixed_total + user_total

    if json_out:
        out: dict[str, Any] = {
            "context_window": _CONTEXT_WINDOW,
            "system_prompt_est": _SYSTEM_PROMPT_EST,
            "skill_agent_est": _SKILL_AGENT_EST,
            "claude_md_files": claude_md_rows,
            "claude_md_total_tokens": claude_md_total,
            "memory_md": str(memory_md) if memory_md else None,
            "memory_md_tokens": memory_tok,
            "memory_entry_count": entry_count,
            "user_controlled_tokens": user_total,
            "fixed_overhead_tokens": fixed_total,
            "grand_total_est": grand_total,
            "fill_fraction": round(grand_total / _CONTEXT_WINDOW, 3),
        }
        if prune_result:
            out["prune"] = {
                "removed_dead": len(prune_result.removed_dead),
                "removed_dup": len(prune_result.removed_dup),
                "tokens_saved": prune_result.tokens_saved,
                "changed": prune_result.changed,
            }
        if dry_result and dry_result.changed:
            out["prune_available"] = {
                "dead": len(dry_result.removed_dead),
                "dup": len(dry_result.removed_dup),
                "tokens_saveable": dry_result.tokens_saved,
            }
        if dup_clusters:
            out["content_duplicates"] = [
                {
                    "members": [str(m) for m in c.members],
                    "similarity": c.similarity,
                    "method": c.method,
                    "tokens": c.tokens,
                }
                for c in dup_clusters
            ]
        typer.echo(_json.dumps(out, indent=2))
        return

    # --- Human output ---
    typer.echo(f"\nContext footprint — {project_root.name}")
    typer.echo(f"  Window assumed : {_CONTEXT_WINDOW:,} tokens\n")

    typer.echo("  Startup budget (injected before any work):")
    typer.echo(f"    {'System prompt (est.)':<32} ~{_SYSTEM_PROMPT_EST:>7,}   {_pct(_SYSTEM_PROMPT_EST):>6}   fixed")
    typer.echo(f"    {'Skill/agent listings (est.)':<32} ~{_SKILL_AGENT_EST:>7,}   {_pct(_SKILL_AGENT_EST):>6}   fixed")

    for row in claude_md_rows:
        lbl = row["label"]
        if len(lbl) > 32:
            lbl = "…" + lbl[-31:]
        typer.echo(f"    {lbl:<32} ~{row['tokens']:>7,}   {_pct(row['tokens']):>6}   you")

    if memory_md:
        mem_label = f"MEMORY.md ({entry_count} entries)"
        typer.echo(f"    {mem_label:<32} ~{memory_tok:>7,}   {_pct(memory_tok):>6}   you")
    else:
        typer.echo(f"    {'MEMORY.md':<32}     (not found)")

    typer.echo(f"    {'─' * 46}")
    typer.echo(f"    {'Total est. pre-consumed':<32} ~{grand_total:>7,}   {_pct(grand_total):>6}")

    # --- MEMORY.md health ---
    if memory_dir:
        typer.echo(f"\n  MEMORY.md health  ({memory_md})")
        typer.echo(f"    {entry_count} entries, ~{memory_tok:,} tokens")

        if prune_result and prune_result.changed:
            typer.echo(
                f"    Pruned: {len(prune_result.removed_dead)} dead link(s), "
                f"{len(prune_result.removed_dup)} duplicate(s) removed "
                f"(~{prune_result.tokens_saved} tokens reclaimed)"
            )
            for e in prune_result.removed_dead:
                typer.echo(f"      dead: {e.target}")
            for e in prune_result.removed_dup:
                typer.echo(f"      dup:  {e.target}")
        elif prune_result:
            typer.echo("    Index is clean — nothing to prune.")
        elif dry_result and dry_result.changed:
            typer.echo(
                f"    Dead links:            {len(dry_result.removed_dead)}"
                f"   → reclaimable now (--fix)   ~{dry_result.tokens_saved} tok"
            )
            typer.echo(
                f"    Exact-dup index lines: {len(dry_result.removed_dup)}"
            )
            for e in dry_result.removed_dead:
                typer.echo(f"      dead: {e.target}")
        else:
            typer.echo("    Index is clean — nothing to prune.")

        if dup_clusters:
            typer.echo("\n  Content near-duplicates (review — never auto-merged)")
            for cl in dup_clusters:
                sim_str = f"{cl.similarity:.2f} ({cl.method})"
                typer.echo(f"    cluster similarity={sim_str}, ~{cl.tokens} tok:")
                for m in cl.members:
                    typer.echo(f"      {m.name}")
                typer.echo("      → consider consolidating")

    # --- CLAUDE.md audit ---
    has_issues = any(
        r.exact_dup_lines or r.dup_sections or r.cross_file_overlaps
        for r in audit_reports
    )
    if has_issues:
        typer.echo("\n  CLAUDE.md audit (report only — token-goat never edits CLAUDE.md)")
        for r in audit_reports:
            lbl = "~/.claude/CLAUDE.md" if r.path.parent.name == ".claude" else r.path.name
            if r.exact_dup_lines:
                typer.echo(f"    {lbl}: {len(r.exact_dup_lines)} exact-dup line(s)")
                for first, dup, text in r.exact_dup_lines[:3]:
                    snippet = text[:50] + "…" if len(text) > 50 else text
                    typer.echo(f"      L{first+1} ↔ L{dup+1}: {snippet!r}")
            if r.dup_sections:
                for heading, lnos in r.dup_sections:
                    typer.echo(f"    {lbl}: duplicate heading {heading!r} at lines {lnos}")
            if r.cross_file_overlaps:
                typer.echo(f"    {lbl}: {len(r.cross_file_overlaps)} cross-file duplicate line(s)")

    # --- Summary ---
    reclaimable = (dry_result.tokens_saved if dry_result and dry_result.changed else 0)
    dup_tok = sum(c.tokens for c in dup_clusters)
    if reclaimable or dup_tok:
        typer.echo("\n  Summary")
        if reclaimable:
            typer.echo(f"    Reclaimable now (safe, --fix): ~{reclaimable} tok")
        if dup_tok:
            typer.echo(f"    Needs your review (clusters):  ~{dup_tok} tok")
    typer.echo("")
