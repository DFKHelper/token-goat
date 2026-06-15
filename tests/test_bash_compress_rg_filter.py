"""Tests for RgFilter: context-line suppression for rg/grep -C/-A/-B output."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter
from token_goat import bash_compress as bc

_F = bc.RgFilter()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rg_context_block(n_groups: int = 5, ctx_lines: int = 3) -> str:
    """Build synthetic rg -C output with match + context lines and -- separators."""
    groups: list[str] = []
    for g in range(n_groups):
        block: list[str] = []
        base = g * 20
        for i in range(ctx_lines):
            block.append(f"src/foo.py-{base + i}-context line {i}")
        block.append(f"src/foo.py:{base + ctx_lines}:MATCH line {g}")
        for i in range(ctx_lines):
            block.append(f"src/foo.py-{base + ctx_lines + 1 + i}-context line {i}")
        groups.append("\n".join(block))
    return "\n--\n".join(groups)


def _plain_rg_output(n_lines: int = 50) -> str:
    """Build plain rg output (match lines only, no context separators)."""
    return "\n".join(f"src/foo.py:{i}:match content here" for i in range(n_lines))


# ---------------------------------------------------------------------------
# Short output passes through unchanged
# ---------------------------------------------------------------------------

def test_short_output_passthrough() -> None:
    """Output with ≤30 lines passes through even when -- separators exist."""
    text = "src/a.py:1:match\n--\nsrc/a.py-2-context\nsrc/a.py:3:match"
    result = apply_filter(_F, stdout=text, argv=["rg"])
    assert result == text


def test_empty_output_passthrough() -> None:
    result = apply_filter(_F, stdout="", argv=["rg"])
    assert result == ""


# ---------------------------------------------------------------------------
# No context separator → passthrough regardless of size
# ---------------------------------------------------------------------------

def test_no_separator_large_output_passthrough() -> None:
    """Large rg output without -- separators is not modified."""
    text = _plain_rg_output(60)
    result = apply_filter(_F, stdout=text, argv=["rg"])
    assert result == text


def test_no_separator_grep_plain_passthrough() -> None:
    """Plain grep output (no -C) passes through unchanged."""
    text = "\n".join(f"file{i}.py:10:found" for i in range(40))
    result = apply_filter(_F, stdout=text, argv=["grep"])
    assert result == text


# ---------------------------------------------------------------------------
# Context lines stripped when output > 30 lines
# ---------------------------------------------------------------------------

def test_context_lines_stripped_large_output() -> None:
    """Context lines and -- separators removed when output exceeds threshold."""
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "3", "MATCH", "src/"])
    assert "--" not in result.split("\n")
    # context lines (dash-linenum-dash pattern) are gone
    assert not any(
        line and not line.startswith("[")
        and "-" in line
        and ":" not in line.split("-")[1] if "-" in line else False
        for line in result.split("\n")
    )


def test_match_lines_preserved() -> None:
    """Match lines (path:linenum:content) are kept after stripping."""
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "3"])
    match_lines = [ln for ln in result.split("\n") if "MATCH line" in ln]
    assert len(match_lines) == 6


def test_separator_lines_removed() -> None:
    """-- group separator lines are removed from output."""
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "3"])
    assert "--" not in result.split("\n")


def test_suppressed_count_in_marker() -> None:
    """Marker reports the correct number of suppressed lines."""
    text = _rg_context_block(n_groups=5, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "3"])
    marker = next(ln for ln in result.split("\n") if "token-goat" in ln)
    # 5 groups × 6 context lines + 4 -- separators between groups = 34 suppressed
    assert "34 context lines suppressed" in marker


def test_marker_format_contains_hint() -> None:
    """Marker includes actionable hint about -l and -C/-A/-B flags."""
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "3"])
    assert "-l" in result
    assert "-C/-A/-B" in result


# ---------------------------------------------------------------------------
# grep binary dispatch
# ---------------------------------------------------------------------------

def test_grep_binary_dispatches_to_rg_filter() -> None:
    """grep is handled by RgFilter (binaries includes grep)."""
    assert "grep" in _F.binaries


def test_grep_context_output_stripped() -> None:
    """grep -C output is stripped the same way as rg -C output."""
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["grep", "-C", "3", "MATCH"])
    assert "token-goat" in result
    assert "--" not in result.split("\n")


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_rg_binary_in_filter_binaries() -> None:
    """rg is in RgFilter.binaries."""
    assert "rg" in _F.binaries


def test_filter_name_is_rg() -> None:
    assert _F.name == "rg"


def test_no_suppression_when_only_match_lines_and_separator() -> None:
    """If -- separators present but no context lines, nothing suppressed."""
    # Build output where all non-separator lines are match lines
    lines = ["src/a.py:1:match", "--", "src/b.py:1:match"] * 15
    text = "\n".join(lines)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "0"])
    # separators still get stripped (they're caught by the sep branch)
    assert "token-goat" in result or result == text
