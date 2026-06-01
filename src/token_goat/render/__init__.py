"""Stats renderer package — ANSI truecolor terminal output.

Exports:
- ``render_table``, ``render_list``, ``render_panel`` — Common Rich-based helpers
  for unified CLI output formatting (see ``common.py``).
- ``render_stats`` — Full stats panel renderer (see ``stats_renderer.py``).
"""
from .common import render_list, render_panel, render_table

__all__ = ["render_list", "render_panel", "render_stats", "render_table"]
