"""Stats CLI helpers."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from re import sub as re_sub
from typing import Any

import typer

from . import stats as stats_mod
from .render.ansi import color_stdout


def _write_raw(text: str) -> None:
    """Write text with truecolor ANSI codes directly, bypassing colorama.

    Uses ``Any`` for the stream variable because we progressively unwrap
    colorama/Typer ``StreamWrapper`` objects at runtime via ``hasattr`` probes.
    The attribute accesses are guarded by ``hasattr`` so they are safe; we
    cannot express this precisely in mypy's type system without ``Any``.
    """
    if not color_stdout():
        text = re_sub(r"\x1b\[[0-9;]*m", "", text)

    stream: Any = sys.stdout
    if hasattr(stream, "_StreamWrapper__wrapped"):
        stream = stream._StreamWrapper__wrapped
    while hasattr(stream, "stream"):
        stream = stream.stream
    encoded = (text + "\n").encode("utf-8")
    if hasattr(stream, "buffer"):
        stream.buffer.write(encoded)
        stream.buffer.flush()
    else:
        stream.write(text + "\n")
        stream.flush()


def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = typer.Option(False, "--json"),
    by_project: bool = False,
    by_command: bool = False,
    top: int = 10,
) -> None:
    """Show cumulative token savings."""
    summary = stats_mod.summarize(window_days=window)
    if json_output:
        from . import __version__
        typer.echo(
            json.dumps(
                {
                    "version": __version__,
                    "total_events": summary.total_events,
                    "total_bytes_saved": summary.total_bytes_saved,
                    "total_tokens_saved": summary.total_tokens_saved,
                    "by_kind": summary.by_kind,
                    "by_day": summary.by_day,
                    "by_project": summary.by_project,
                    "by_command": summary.by_command,
                    "window_days": summary.window_days,
                },
                separators=(",", ":"),
            )
        )
        return
    if by_project:
        _write_raw(stats_mod.render_by_project(summary, top=top))
        return
    if by_command:
        _write_raw(stats_mod.render_by_command(summary))
        return
    _write_raw(stats_mod.render_text(summary))
    top_files_text = _render_top_session_files(top_n=5)
    if top_files_text:
        _write_raw(top_files_text)


def _render_top_session_files(top_n: int = 5) -> str:
    """Return a plain-text summary of the top N most-read files in the most recent session.

    Loads the most recently modified session JSON and sorts ``file_access_counts``
    by count descending.  Returns an empty string when no session data is available
    or when no file has been accessed more than once (single-access sessions produce
    no actionable nudge).

    Fail-soft: any I/O or parse error returns an empty string so the stats
    command never fails due to session-file issues.
    """
    try:
        from . import paths as _paths
        from . import session as session_mod

        sessions_dir = _paths.sessions_dir()
        if not sessions_dir.is_dir():
            return ""

        # Find the most recently modified session file.
        session_files = sorted(
            sessions_dir.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not session_files:
            return ""

        # Try files in order until one parses cleanly.
        cache = None
        for sf in session_files[:3]:  # try at most 3 to keep startup fast
            try:
                session_id = sf.stem
                session_mod.validate_session_id(session_id)
                cache = session_mod.safe_load(session_id)
                if cache is not None and not cache.unavailable:
                    break
            except Exception:
                continue

        if cache is None or cache.unavailable:
            return ""

        counts = getattr(cache, "file_access_counts", {})
        if not counts:
            return ""

        # Sort descending by count; skip files accessed only once (not informative).
        ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        ranked = [(k, v) for k, v in ranked if v > 1][:top_n]
        if not ranked:
            return ""

        lines = ["Top files this session:"]
        for filepath, count in ranked:
            basename = Path(filepath).name
            lines.append(f"  {count:>3}x  {basename}  ({filepath})")
        return "\n".join(lines)
    except Exception:
        return ""
