"""Tests for render/common.py helpers."""
from __future__ import annotations

from rich.panel import Panel
from rich.table import Table

from token_goat.render.common import render_list, render_panel, render_table


class TestRenderTable:
    """Tests for render_table function."""

    def test_render_table_basic(self) -> None:
        """Test basic table creation with headers and rows."""
        table = render_table(
            headers=["Name", "Value"],
            rows=[["foo", "100"], ["bar", "200"]],
        )
        assert isinstance(table, Table)

    def test_render_table_headers(self) -> None:
        """Test that headers are correctly set."""
        table = render_table(
            headers=["Col1", "Col2", "Col3"],
            rows=[["a", "b", "c"]],
        )
        assert isinstance(table, Table)
        # Rich Table's columns are accessed via the columns property
        assert len(table.columns) == 3

    def test_render_table_multiple_rows(self) -> None:
        """Test table with multiple rows."""
        rows = [["row1col1", "row1col2"], ["row2col1", "row2col2"], ["row3col1", "row3col2"]]
        table = render_table(headers=["A", "B"], rows=rows)
        assert isinstance(table, Table)
        # Verify table was created successfully
        assert len(table.columns) == 2

    def test_render_table_empty(self) -> None:
        """Test table creation with empty rows."""
        table = render_table(headers=["Name", "Value"], rows=[])
        assert isinstance(table, Table)
        assert len(table.columns) == 2

    def test_render_table_with_title(self) -> None:
        """Test table creation with title (reserved for future use)."""
        table = render_table(
            headers=["X", "Y"],
            rows=[["1", "2"]],
            title="Test Table",
        )
        assert isinstance(table, Table)


class TestRenderList:
    """Tests for render_list function."""

    def test_render_list_basic(self) -> None:
        """Test basic list rendering with default bullet."""
        items = ["item 1", "item 2", "item 3"]
        result = render_list(items)
        assert "• item 1" in result
        assert "• item 2" in result
        assert "• item 3" in result

    def test_render_list_custom_bullet(self) -> None:
        """Test list rendering with custom bullet character."""
        items = ["apple", "banana"]
        result = render_list(items, bullet="-")
        assert "- apple" in result
        assert "- banana" in result
        assert "•" not in result

    def test_render_list_empty(self) -> None:
        """Test list rendering with empty items."""
        result = render_list([])
        assert result == ""

    def test_render_list_single_item(self) -> None:
        """Test list rendering with single item."""
        result = render_list(["only item"])
        assert result == "• only item"

    def test_render_list_multiline_output(self) -> None:
        """Test that list items are separated by newlines."""
        items = ["first", "second", "third"]
        result = render_list(items)
        lines = result.split("\n")
        assert len(lines) == 3

    def test_render_list_with_title(self) -> None:
        """Test list rendering with title (reserved for future use)."""
        result = render_list(["item"], title="My List")
        assert "• item" in result

    def test_render_list_special_characters(self) -> None:
        """Test list rendering with items containing special characters."""
        items = ["item with → arrow", "item with → emoji"]
        result = render_list(items)
        assert "item with → arrow" in result
        assert "item with → emoji" in result


class TestRenderPanel:
    """Tests for render_panel function."""

    def test_render_panel_basic(self) -> None:
        """Test basic panel creation."""
        panel = render_panel("Hello, World!")
        assert isinstance(panel, Panel)

    def test_render_panel_with_title(self) -> None:
        """Test panel creation with title."""
        panel = render_panel("Content", title="My Panel")
        assert isinstance(panel, Panel)
        assert panel.title == "My Panel"

    def test_render_panel_with_style(self) -> None:
        """Test panel creation with custom border style."""
        panel = render_panel("Content", title="Panel", style="bright_cyan")
        assert isinstance(panel, Panel)
        assert panel.border_style == "bright_cyan"

    def test_render_panel_empty_title(self) -> None:
        """Test that empty title results in None (no title)."""
        panel = render_panel("Content", title="")
        assert isinstance(panel, Panel)
        # Empty string title should result in None
        assert panel.title is None

    def test_render_panel_default_style(self) -> None:
        """Test panel with default style."""
        panel = render_panel("Content")
        assert isinstance(panel, Panel)
        assert panel.border_style == "dim"

    def test_render_panel_multiline_content(self) -> None:
        """Test panel with multiline content."""
        content = "Line 1\nLine 2\nLine 3"
        panel = render_panel(content, title="Multi-line")
        assert isinstance(panel, Panel)

    def test_render_panel_all_styles(self) -> None:
        """Test panel with different style values."""
        for style in ["dim", "bright_cyan", "bold green", "red"]:
            panel = render_panel("Content", style=style)
            assert panel.border_style == style
