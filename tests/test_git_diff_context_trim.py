"""Tests for trailing-context trimming in _compress_git_diff_body (iter 8)."""
from __future__ import annotations

import textwrap

from token_goat.bash_compress import _compress_git_diff_body
from token_goat.render.stats_renderer import _kind_group_label

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_diff(hunks: list[str], filename: str = "foo.py") -> str:
    # Build a minimal diff string with one file block and the given hunk bodies.
    header = f"diff --git a/{filename} b/{filename}\n--- a/{filename}\n+++ b/{filename}"
    return header + "\n" + "\n".join(hunks)


def _make_hunk(header: str, body_lines: list[str]) -> str:
    return header + "\n" + "\n".join(body_lines)


# ---------------------------------------------------------------------------
# Positive: 5 trailing context lines → trimmed to 2, marker appended
# ---------------------------------------------------------------------------

def test_trim_5_trailing_context_lines():
    # 1 changed line followed by 5 context lines — expect 2 kept, 3 trimmed.
    hunk = _make_hunk(
        "@@ -1,8 +1,8 @@",
        [
            " context_before",
            "+changed_line",
            " ctx1",
            " ctx2",
            " ctx3",
            " ctx4",
            " ctx5",
        ],
    )
    diff = _make_diff([hunk])
    result = _compress_git_diff_body(diff, "")
    assert "[token-goat: 3 trailing context line(s) trimmed]" in result
    # ctx1 and ctx2 kept; ctx3/4/5 dropped
    assert " ctx1" in result
    assert " ctx2" in result
    assert " ctx3" not in result
    assert " ctx4" not in result
    assert " ctx5" not in result


# ---------------------------------------------------------------------------
# Positive: trailing context exactly 2 → no trimming, no marker
# ---------------------------------------------------------------------------

def test_trailing_context_exactly_2_no_trim():
    hunk = _make_hunk(
        "@@ -1,4 +1,4 @@",
        [
            "+changed_line",
            " ctx1",
            " ctx2",
        ],
    )
    diff = _make_diff([hunk])
    result = _compress_git_diff_body(diff, "")
    assert "trimmed" not in result
    assert " ctx1" in result
    assert " ctx2" in result


# ---------------------------------------------------------------------------
# Positive: trailing context 0 → no trimming
# ---------------------------------------------------------------------------

def test_trailing_context_zero_no_trim():
    hunk = _make_hunk(
        "@@ -1,2 +1,2 @@",
        [
            " leading_ctx",
            "+changed_line",
        ],
    )
    diff = _make_diff([hunk])
    result = _compress_git_diff_body(diff, "")
    assert "trimmed" not in result
    assert "+changed_line" in result


# ---------------------------------------------------------------------------
# Positive: multiple hunks each with excess trailing context → both trimmed
# ---------------------------------------------------------------------------

def test_multiple_hunks_both_trimmed():
    hunk1 = _make_hunk(
        "@@ -1,7 +1,7 @@",
        [
            "+change_a",
            " a1",
            " a2",
            " a3",
            " a4",
        ],
    )
    hunk2 = _make_hunk(
        "@@ -20,7 +20,7 @@",
        [
            "+change_b",
            " b1",
            " b2",
            " b3",
        ],
    )
    diff = _make_diff([hunk1, hunk2])
    result = _compress_git_diff_body(diff, "")
    # hunk1: 4 trailing → 2 kept, 2 trimmed
    assert " a1" in result
    assert " a2" in result
    assert " a3" not in result
    assert " a4" not in result
    # hunk2: 3 trailing → 2 kept, 1 trimmed
    assert " b1" in result
    assert " b2" in result
    assert " b3" not in result
    # both markers present (2 separate occurrences)
    assert result.count("[token-goat:") >= 2
    assert "trimmed]" in result


# ---------------------------------------------------------------------------
# Positive: large hunk (>50 changed lines) is NOT trimmed by the new path
# ---------------------------------------------------------------------------

def test_large_hunk_not_context_trimmed():
    # 51 added lines followed by 5 context lines — must use large-hunk truncation, not context trim.
    added = [f"+line{i}" for i in range(51)]
    context_after = [" ctx1", " ctx2", " ctx3", " ctx4", " ctx5"]
    hunk = _make_hunk("@@ -1,60 +1,60 @@", added + context_after)
    diff = _make_diff([hunk])
    result = _compress_git_diff_body(diff, "")
    # Large-hunk marker present, context-trim marker absent
    assert "lines omitted by token-goat" in result
    assert "trailing context line(s) trimmed" not in result


# ---------------------------------------------------------------------------
# Negative: binary file block → unchanged (binary summary path not affected)
# ---------------------------------------------------------------------------

def test_binary_file_not_affected():
    diff = textwrap.dedent("""\
        diff --git a/img.png b/img.png
        Binary files a/img.png and b/img.png differ
    """)
    result = _compress_git_diff_body(diff, "")
    assert "Binary files" in result
    assert "trimmed" not in result


# ---------------------------------------------------------------------------
# Edge case: \ No newline at end of file marker in trailing region
# ---------------------------------------------------------------------------

def test_no_newline_marker_after_context_dropped_with_context():
    # Marker appears after trailing context lines — it gets silently dropped along with the trimmed context.
    hunk = _make_hunk(
        "@@ -1,6 +1,6 @@",
        [
            "+changed",
            " ctx1",
            " ctx2",
            " ctx3",
            "\\ No newline at end of file",
        ],
    )
    diff = _make_diff([hunk])
    result = _compress_git_diff_body(diff, "")
    # ctx3 and the marker are in the dropped tail; ctx1+ctx2 are kept
    assert " ctx1" in result
    assert " ctx2" in result
    assert " ctx3" not in result
    assert "[token-goat: 1 trailing context line(s) trimmed]" in result


# ---------------------------------------------------------------------------
# Stat group: git_diff_context_trimmed belongs to "Bash"
# ---------------------------------------------------------------------------

def test_stat_group_label():
    assert _kind_group_label("git_diff_context_trimmed") == "Bash"
