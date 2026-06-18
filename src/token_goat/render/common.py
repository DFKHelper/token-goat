"""Common Rich-based rendering helpers for consistent CLI output formatting.

This module provides unified, reusable components for building terminal UI:
- ``render_table`` — Creates a Rich Table with consistent styling
- ``render_list`` — Formats a bulleted list as a string
- ``render_panel`` — Creates a Rich Panel with consistent styling

All helpers follow a single design system (colors, spacing, borders) so panels,
tables, and lists match across all CLI outputs.
"""
from __future__ import annotations

__all__ = ["render_list", "render_panel", "render_table"]

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from rich.console import RenderableType
    from rich.panel import Panel as RichPanel
    from rich.table import Table as RichTable


def render_table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    title: str = "",
) -> RichTable:
    """Create a Rich Table with consistent styling.

    Args:
        headers: Column header strings.
        rows: Each row is a sequence of cell values (strings).
        title: Optional table title (currently unused but reserved for future expansion).

    Returns:
        A configured ``rich.table.Table`` object ready to print.

    Example::

        table = render_table(
            headers=["Name", "Value"],
            rows=[["foo", "100"], ["bar", "200"]],
        )
        console.print(table)
    """
    from rich.table import Table

    tbl = Table(
        show_header=True,
        header_style="bold dim",
        show_edge=False,
        box=None,
        pad_edge=False,
        padding=(0, 1),
    )
    for header in headers:
        tbl.add_column(header)
    for row in rows:
        tbl.add_row(*row)
    return tbl


def render_list(
    items: Sequence[str],
    title: str = "",
    bullet: str = "•",
) -> str:
    """Format a bulleted list as a string.

    Args:
        items: List of item strings.
        title: Optional title (currently unused but reserved for future expansion).
        bullet: The bullet character to prepend to each item (default: "•").

    Returns:
        A multi-line string with each item prefixed by the bullet character
        and one space.

    Example::

        text = render_list(["item 1", "item 2"], bullet="—")
        print(text)
        # Output:
        # — item 1
        # — item 2
    """
    lines = [f"{bullet} {item}" for item in items]
    return "\n".join(lines)


def render_panel(
    content: str | RenderableType,
    title: str = "",
    style: str = "dim",
) -> RichPanel:
    """Create a Rich Panel with consistent styling.

    Args:
        content: The panel content (string or Rich Renderable).
        title: Optional panel title.
        style: Panel border style (default: "dim"). Common values: "dim", "bright_cyan", "bold green".

    Returns:
        A configured ``rich.panel.Panel`` object ready to print.

    Example::

        panel = render_panel("Hello, World!", title="Greeting", style="bright_cyan")
        console.print(panel)
    """
    from rich.panel import Panel

    return Panel(
        content,
        title=title or None,
        border_style=style,
    )
