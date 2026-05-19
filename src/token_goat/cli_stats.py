"""Stats CLI helpers."""
from __future__ import annotations

import json
import os
import sys
from re import sub as re_sub
from typing import Any

import typer

from . import stats as stats_mod


def _write_raw(text: str) -> None:
    """Write text with truecolor ANSI codes directly, bypassing colorama.

    Uses ``Any`` for the stream variable because we progressively unwrap
    colorama/Typer ``StreamWrapper`` objects at runtime via ``hasattr`` probes.
    The attribute accesses are guarded by ``hasattr`` so they are safe; we
    cannot express this precisely in mypy's type system without ``Any``.
    """
    if os.environ.get("NO_COLOR") or not sys.stdout.isatty():
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
) -> None:
    """Show cumulative token savings."""
    summary = stats_mod.summarize(window_days=window)
    if json_output:
        typer.echo(
            json.dumps(
                {
                    "total_events": summary.total_events,
                    "total_bytes_saved": summary.total_bytes_saved,
                    "total_tokens_saved": summary.total_tokens_saved,
                    "by_kind": summary.by_kind,
                    "by_day": summary.by_day,
                    "by_project": summary.by_project,
                    "window_days": summary.window_days,
                },
                separators=(",", ":"),
            )
        )
        return
    _write_raw(stats_mod.render_text(summary))
