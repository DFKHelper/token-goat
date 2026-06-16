"""Tests for hunk density scoring and capping in diff filters.

Covers _score_and_cap_hunks directly plus integration with DiffFilter and
_compress_git_diff_body for files that exceed max_hunks_per_file.
"""
from __future__ import annotations

import unittest.mock

import token_goat.bash_compress as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DENSITY_DEFAULT = 10


def _make_hunk(n_context: int, n_changed: int, index: int = 0) -> list[str]:
    """Build lines for a single hunk with the given context/changed ratio."""
    lines = [f"@@ -{index * 30 + 1},{n_context + n_changed} +{index * 30 + 1},{n_context + n_changed} @@"]
    for j in range(n_context):
        lines.append(f" context_{index}_{j}")
    for j in range(n_changed // 2):
        lines.append(f"-removed_{index}_{j}")
        lines.append(f"+added_{index}_{j}")
    return lines


def _make_file_block(filename: str, hunks: list[list[str]]) -> list[str]:
    """Wrap a set of hunk line-lists into a unified diff file block."""
    header = [f"--- a/{filename}", f"+++ b/{filename}"]
    out = list(header)
    for h in hunks:
        out.extend(h)
    return out


# ---------------------------------------------------------------------------
# Unit tests for _score_and_cap_hunks
# ---------------------------------------------------------------------------

class TestScoreAndCapHunks:
    def test_fewer_than_max_hunks_untouched(self) -> None:
        """File with <= max_hunks leaves output unchanged."""
        hunks = [_make_hunk(8, 2, i) for i in range(5)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        assert result == block

    def test_exactly_max_hunks_untouched(self) -> None:
        """Exactly max_hunks hunks: no sentinel emitted."""
        hunks = [_make_hunk(8, 2, i) for i in range(10)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        assert result == block
        assert not any("more hunks" in ln for ln in result)

    def test_15_hunks_keeps_top_10(self) -> None:
        """15 hunks → 10 emitted, 5 dropped."""
        hunks = [_make_hunk(8, 2, i) for i in range(15)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        hunk_headers = [ln for ln in result if ln.startswith("@@ ")]
        assert len(hunk_headers) == 10

    def test_dropped_hunks_produce_single_sentinel(self) -> None:
        """Dropped hunks are replaced by exactly one sentinel line."""
        hunks = [_make_hunk(8, 2, i) for i in range(15)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        sentinels = [ln for ln in result if "more hunks" in ln]
        assert len(sentinels) == 1

    def test_sentinel_contains_count(self) -> None:
        """Sentinel reports exactly how many hunks were dropped."""
        hunks = [_make_hunk(8, 2, i) for i in range(15)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        sentinel = next(ln for ln in result if "more hunks" in ln)
        assert "5 more hunks" in sentinel

    def test_sentinel_contains_avg_density_rounded_2dp(self) -> None:
        """Sentinel avg density is a 2-decimal float."""
        hunks = [_make_hunk(8, 2, i) for i in range(15)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        sentinel = next(ln for ln in result if "more hunks" in ln)
        # density value must appear as X.XX
        import re
        assert re.search(r"avg density \d+\.\d{2}", sentinel), sentinel

    def test_high_density_hunk_kept_over_low_density(self) -> None:
        """Hunk with 18/20 changed lines scores higher than one with 1/20 changed."""
        high_density = _make_hunk(n_context=2, n_changed=18, index=0)
        low_density = _make_hunk(n_context=19, n_changed=1, index=1)
        # Build a file where only 1 slot is available, one hunk must drop
        block = _make_file_block("foo.py", [high_density, low_density])
        result = bc._score_and_cap_hunks(block, max_hunks=1)
        kept = [ln for ln in result if ln.startswith("@@ ") and "0" in ln]
        dropped_sentinel = [ln for ln in result if "more hunks" in ln]
        assert kept, "high-density hunk should be kept"
        assert dropped_sentinel, "low-density hunk should produce sentinel"
        # Confirm the dropped hunk's low-density context makes it into the sentinel avg
        assert "1 more hunks" in dropped_sentinel[0]

    def test_max_hunks_zero_keeps_all(self) -> None:
        """max_hunks=0 disables the cap entirely — all hunks pass through."""
        hunks = [_make_hunk(8, 2, i) for i in range(15)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=0)
        assert result == block

    def test_density_in_sentinel_is_2dp_float(self) -> None:
        """Density is always formatted to exactly 2 decimal places."""
        # Construct hunks with density exactly 1/3 to trigger non-integer rounding
        # 1 changed + 2 context = density 0.33...
        hunks = [_make_hunk(n_context=18, n_changed=2, index=i) for i in range(12)]
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        sentinel = next((ln for ln in result if "more hunks" in ln), None)
        assert sentinel is not None
        import re
        m = re.search(r"avg density (\d+\.\d+)", sentinel)
        assert m is not None, sentinel
        # Must be exactly 2 decimal places
        assert len(m.group(1).split(".")[1]) == 2

    def test_pure_whitespace_hunk_dropped_before_mixed(self) -> None:
        """Hunk with density 0.05 is dropped before hunk with density 0.6."""
        # density ~0.05: 1 changed / 20 total content lines
        sparse = _make_hunk(n_context=19, n_changed=2, index=0)  # 2/21 content ≈ 0.095
        # density ~0.6: 12 changed / 20 total content
        dense = _make_hunk(n_context=8, n_changed=12, index=1)  # 12/20 = 0.6
        # Need 12 fillers at medium density so there are 14 hunks total
        fillers = [_make_hunk(n_context=4, n_changed=6, index=i + 2) for i in range(12)]  # 6/10 = 0.6
        block = _make_file_block("foo.py", [sparse] + [dense] + fillers)
        # keep 13 → the 'sparse' hunk (lowest density) should drop
        result = bc._score_and_cap_hunks(block, max_hunks=13)
        # sparse hunk header contains 'index=0' context marker context_0_0
        kept_sparse = any("context_0_0" in ln for ln in result)
        assert not kept_sparse, "pure-whitespace hunk should be dropped"

    def test_kept_hunks_maintain_original_order(self) -> None:
        """Kept hunks appear in original file order, not density order."""
        # Alternating density: high(0), low(1), high(2), low(3) ... 12 total
        hunks = []
        for i in range(12):
            if i % 2 == 0:
                hunks.append(_make_hunk(n_context=1, n_changed=9, index=i))  # high density
            else:
                hunks.append(_make_hunk(n_context=9, n_changed=1, index=i))  # low density
        block = _make_file_block("foo.py", hunks)
        result = bc._score_and_cap_hunks(block, max_hunks=10)
        hunk_indices = [
            int(ln.split("context_")[1].split("_")[0])
            for ln in result
            if ln.startswith(" context_") and "_0" in ln
        ]
        # Must be ascending (original order preserved)
        assert hunk_indices == sorted(hunk_indices)


# ---------------------------------------------------------------------------
# Integration: DiffFilter
# ---------------------------------------------------------------------------

_DIFF_ARGV = ["diff", "a.txt", "b.txt"]


def _apply_diff(stdout: str) -> str:
    from tests.filter_test_helpers import apply_filter  # type: ignore[import]
    return apply_filter(bc.DiffFilter(), stdout=stdout, stderr="", exit_code=0, argv=_DIFF_ARGV)


class TestDiffFilterDensityIntegration:
    def _unified_block(self, filename: str, n_hunks: int, lines_per_hunk: int = 20) -> str:
        """Build a large unified-diff block."""
        parts = [f"--- a/{filename}", f"+++ b/{filename}"]
        for i in range(n_hunks):
            start = i * 30 + 1
            parts.append(f"@@ -{start},{lines_per_hunk} +{start},{lines_per_hunk} @@")
            for j in range(lines_per_hunk - 2):
                parts.append(f" ctx_{i}_{j}")
            parts.append(f"-old_{i}")
            parts.append(f"+new_{i}")
        return "\n".join(parts)

    def test_file_with_10_or_fewer_hunks_untouched(self) -> None:
        diff = self._unified_block("small.py", n_hunks=10)
        result = _apply_diff(diff)
        # Sentinel must not appear for 10-hunk file
        assert "more hunks, avg density" not in result

    def test_file_with_15_hunks_triggers_density_cap(self) -> None:
        # Density cap reduces 15 → 10, then positional cap reduces further.
        # Both caps together leave fewer than 15 hunk headers.
        diff = self._unified_block("big.py", n_hunks=15)
        result = _apply_diff(diff)
        hunk_headers = [ln for ln in result.splitlines() if ln.startswith("@@ ")]
        assert len(hunk_headers) < 15, "at least one cap should have fired"
        assert "elided" in result or "more hunks" in result


# ---------------------------------------------------------------------------
# Integration: _compress_git_diff_body (GitDiffFilter path)
# ---------------------------------------------------------------------------

def _git_diff_block(n_hunks: int) -> str:
    """Build a git diff with *n_hunks* small hunks for one file."""
    lines = ["diff --git a/foo.py b/foo.py", "--- a/foo.py", "+++ b/foo.py"]
    for i in range(n_hunks):
        start = i * 30 + 1
        lines.append(f"@@ -{start},10 +{start},10 @@")
        for j in range(8):
            lines.append(f" ctx_{i}_{j}")
        lines.append(f"-old_{i}")
        lines.append(f"+new_{i}")
    return "\n".join(lines)


class TestGitDiffFilterDensityIntegration:
    def test_git_diff_with_11_hunks_triggers_density_cap(self) -> None:
        diff = _git_diff_block(n_hunks=11)
        result = bc._compress_git_diff_body(diff, "")
        assert "more hunks, avg density" in result

    def test_git_diff_with_10_hunks_untouched(self) -> None:
        diff = _git_diff_block(n_hunks=10)
        result = bc._compress_git_diff_body(diff, "")
        assert "more hunks, avg density" not in result

    def test_diff_with_15_hunks_not_capped_when_hunk_density_cap_disabled(self) -> None:
        """When hunk_density_cap=False in config, 15 hunks are NOT reduced to 10."""
        from token_goat import config as _cfg_mod
        diff = _git_diff_block(n_hunks=15)
        # Mock config.load() to return a config with hunk_density_cap=False
        mock_cfg = unittest.mock.MagicMock()
        mock_cfg.bash_diff.hunk_density_cap = False
        mock_cfg.bash_diff.max_hunks_per_file = 10
        with unittest.mock.patch.object(_cfg_mod, "load", return_value=mock_cfg):
            result = bc._compress_git_diff_body(diff, "")
        # With hunk_density_cap=False, the density cap is skipped; result should have all 15 hunks
        hunk_headers = [ln for ln in result.splitlines() if ln.startswith("@@ ")]
        assert len(hunk_headers) == 15, f"Expected 15 hunks, got {len(hunk_headers)}"
        assert "more hunks, avg density" not in result, "density cap marker should not appear"
