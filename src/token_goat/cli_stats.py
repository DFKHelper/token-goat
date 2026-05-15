"""Stats CLI helpers."""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

import typer

from . import stats as stats_mod


def _write_raw(text: str) -> None:
    """Write text with truecolor ANSI codes directly, bypassing colorama."""
    if os.environ.get("NO_COLOR") or not sys.stdout.isatty():
        text = re.sub(r"\x1b\[[0-9;]*m", "", text)

    stream: Any = sys.stdout
    if hasattr(stream, "_StreamWrapper__wrapped"):
        stream = stream._StreamWrapper__wrapped  # type: ignore[attr-defined]
    while hasattr(stream, "stream"):
        stream = stream.stream  # type: ignore[attr-defined]
    encoded = (text + "\n").encode("utf-8")
    if hasattr(stream, "buffer"):
        stream.buffer.write(encoded)  # type: ignore[attr-defined]
        stream.buffer.flush()  # type: ignore[attr-defined]
    else:
        stream.write(text + "\n")  # type: ignore[attr-defined]
        stream.flush()  # type: ignore[attr-defined]


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
                indent=2,
            )
        )
        return
    _write_raw(stats_mod.render_text(summary))
