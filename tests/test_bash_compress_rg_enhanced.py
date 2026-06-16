"""Enhanced tests for RgFilter: -A/-B flags, files-only/count-only passthrough, inter-match group compression."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter
from token_goat import bash_compress as bc

_F = bc.RgFilter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rg_context_block(n_groups: int = 5, ctx_lines: int = 3) -> str:
    # Build synthetic rg -C output with match + context lines and -- separators.
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


def _rg_match_groups(n_groups: int, matches_per_group: int = 1) -> str:
    # Build synthetic rg output with only match lines separated by -- (no context).
    groups: list[str] = []
    for g in range(n_groups):
        block = [f"src/file{g}.py:{g * 10 + j}:match {g}-{j}" for j in range(matches_per_group)]
        groups.append("\n".join(block))
    return "\n--\n".join(groups)


# ---------------------------------------------------------------------------
# _parse_context_depth unit tests
# ---------------------------------------------------------------------------

def test_parse_context_depth_A_flag() -> None:
    # -A N should be parsed and returned.
    assert _F._parse_context_depth(["rg", "-A", "3", "pattern"]) == 3


def test_parse_context_depth_B_flag() -> None:
    # -B N should be parsed and returned.
    assert _F._parse_context_depth(["rg", "-B", "5", "pattern"]) == 5


def test_parse_context_depth_C_flag() -> None:
    assert _F._parse_context_depth(["rg", "-C", "2", "pattern"]) == 2


def test_parse_context_depth_combined_form() -> None:
    # -A3 (no space) should also be parsed.
    assert _F._parse_context_depth(["rg", "-A3"]) == 3


def test_parse_context_depth_max_of_multiple() -> None:
    # Returns max when multiple flags are present.
    assert _F._parse_context_depth(["rg", "-A", "2", "-B", "7"]) == 7


def test_parse_context_depth_none() -> None:
    # Returns 0 when no context flags present.
    assert _F._parse_context_depth(["rg", "pattern", "src/"]) == 0


def test_parse_context_depth_long_flag() -> None:
    assert _F._parse_context_depth(["rg", "--context", "4"]) == 4


def test_parse_context_depth_C_zero() -> None:
    # -C 0 is valid; depth is 0.
    assert _F._parse_context_depth(["rg", "-C", "0"]) == 0


# ---------------------------------------------------------------------------
# Files-only passthrough (-l / --files-with-matches)
# ---------------------------------------------------------------------------

def test_files_only_short_flag_no_compression() -> None:
    # -l output (one filename per line) must pass through unchanged even when large.
    text = "\n".join(f"src/file{i}.py" for i in range(60))
    result = apply_filter(_F, stdout=text, argv=["rg", "-l", "pattern"])
    assert result == text


def test_files_only_long_flag_no_compression() -> None:
    text = "\n".join(f"src/file{i}.py" for i in range(60))
    result = apply_filter(_F, stdout=text, argv=["rg", "--files-with-matches", "pattern"])
    assert result == text


# ---------------------------------------------------------------------------
# Count-only passthrough (-c / --count)
# ---------------------------------------------------------------------------

def test_count_only_short_flag_no_compression() -> None:
    # -c output (file:N per line) must pass through unchanged.
    text = "\n".join(f"src/file{i}.py:{i * 3}" for i in range(60))
    result = apply_filter(_F, stdout=text, argv=["rg", "-c", "pattern"])
    assert result == text


def test_count_only_long_flag_no_compression() -> None:
    text = "\n".join(f"src/file{i}.py:{i}" for i in range(60))
    result = apply_filter(_F, stdout=text, argv=["rg", "--count", "pattern"])
    assert result == text


# ---------------------------------------------------------------------------
# -A / -B flag triggers context compression on large output
# ---------------------------------------------------------------------------

def test_A_flag_context_compression_applied() -> None:
    # -A 3 large output with -- separators → context lines stripped.
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-A", "3", "MATCH", "src/"])
    assert "token-goat" in result


def test_B_flag_context_compression_applied() -> None:
    # -B 3 large output with -- separators → context lines stripped.
    text = _rg_context_block(n_groups=6, ctx_lines=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "-B", "3", "MATCH", "src/"])
    assert "token-goat" in result


# ---------------------------------------------------------------------------
# Small output → no compression regardless of flags
# ---------------------------------------------------------------------------

def test_small_output_no_compression_with_A_flag() -> None:
    # ≤30 lines always passes through unchanged even with -A flag.
    text = "src/a.py:1:match\n--\nsrc/a.py-2-context"
    result = apply_filter(_F, stdout=text, argv=["rg", "-A", "3"])
    assert result == text


def test_small_output_no_compression_with_B_flag() -> None:
    text = "src/a.py-0-context\n--\nsrc/a.py:1:match"
    result = apply_filter(_F, stdout=text, argv=["rg", "-B", "2"])
    assert result == text


# ---------------------------------------------------------------------------
# Inter-match group compression
# ---------------------------------------------------------------------------

def test_inter_match_15_groups_keeps_5() -> None:
    # 15 groups → inter-match compression keeps only 5, suppresses 10.
    text = _rg_match_groups(n_groups=15, matches_per_group=2)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "0", "match"])
    lines = result.split("\n")
    group_sep_count = sum(1 for ln in lines if ln == "--")
    # 5 kept groups → at most 4 separators between them
    assert group_sep_count <= 4
    assert "token-goat" in result


def test_inter_match_sentinel_correct_count() -> None:
    # 15 groups × 3 matches = 59 lines > threshold; 5 kept → sentinel reports 10 suppressed.
    text = _rg_match_groups(n_groups=15, matches_per_group=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "match"])
    assert "10 more match groups suppressed" in result


def test_inter_match_top_groups_selected_by_match_count() -> None:
    # Groups with more matches should be preferred.
    # Build 12 groups: first 5 have 3 matches each, rest have 1 match each.
    heavy = "\n".join(f"src/a.py:{j}:HEAVY match" for j in range(3))
    light = "src/b.py:0:light match"
    groups = [heavy] * 5 + [light] * 7
    text = "\n--\n".join(groups)
    result = apply_filter(_F, stdout=text, argv=["rg", "match"])
    # All 5 heavy groups should be in the result (they win on match count)
    assert result.count("HEAVY match") == 15  # 5 groups × 3 lines


def test_inter_match_exactly_10_groups_no_compression() -> None:
    # Exactly 10 groups → threshold not exceeded → context-line stripping path, not group compression.
    text = _rg_context_block(n_groups=10, ctx_lines=1)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "1"])
    # Context-line path appends the standard context-lines-suppressed marker
    assert "context lines suppressed" in result
    assert "more match groups suppressed" not in result


def test_inter_match_11_groups_triggers_compression() -> None:
    # 11 groups × 3 matches = 43 lines > threshold → inter-match group compression.
    text = _rg_match_groups(n_groups=11, matches_per_group=3)
    result = apply_filter(_F, stdout=text, argv=["rg", "match"])
    assert "more match groups suppressed" in result


# ---------------------------------------------------------------------------
# -C 0 edge case
# ---------------------------------------------------------------------------

def test_C_zero_match_only_output_no_crash() -> None:
    # -C 0 with many groups still runs without error.
    text = _rg_match_groups(n_groups=15, matches_per_group=1)
    result = apply_filter(_F, stdout=text, argv=["rg", "-C", "0", "match"])
    assert isinstance(result, str)
    assert len(result) > 0


def test_C_zero_few_groups_passthrough_or_sep_strip() -> None:
    # -C 0, only 4 groups (≤10), large output (many lines built manually) → no group compression.
    many_matches = "\n".join(f"src/f.py:{i}:match" for i in range(50))
    result = apply_filter(_F, stdout=many_matches, argv=["rg", "-C", "0"])
    # No -- separators → passes through unchanged
    assert result == many_matches


# ---------------------------------------------------------------------------
# _is_files_only / _is_count_only unit tests
# ---------------------------------------------------------------------------

def test_is_files_only_true_short() -> None:
    assert _F._is_files_only(["-l"]) is True


def test_is_files_only_true_long() -> None:
    assert _F._is_files_only(["--files-with-matches"]) is True


def test_is_files_only_false() -> None:
    assert _F._is_files_only(["rg", "-C", "3"]) is False


def test_is_count_only_true_short() -> None:
    assert _F._is_count_only(["-c"]) is True


def test_is_count_only_true_long() -> None:
    assert _F._is_count_only(["--count"]) is True


def test_is_count_only_false() -> None:
    assert _F._is_count_only(["rg", "pattern"]) is False
