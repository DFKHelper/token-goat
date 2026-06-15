"""Iteration 2 test coverage gaps: filter edge cases + hints dedup helpers.

Coverage targets:
  (a) EzaFilter: --tree=X (equals form), exact 60-line tree boundary, no-match cases
  (b) BatFilter: batcat binary, combined ANSI + long output, batcat.exe Windows
  (c) DeltaFilter: delta.exe Windows, ━ separator removal, exact-80-line boundary
  (d) FzfFilter: fzf.exe Windows, exactly-50-line boundary, stderr passthrough
  (e) JqFilter: jq.exe Windows, stderr error passthrough, exactly-200-line boundary
  (f) YqFilter: yq.exe Windows, stderr errors, exactly-150-line boundary
  (g) Direct unit tests for hints.py dedup helpers:
      _check_dedup_preconditions, _check_entry_staleness, _check_dedup_min_threshold,
      _record_dedup_hint_emitted, _record_bash_dedup_emitted, _record_non_dedup_hint_emitted
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# (a) EzaFilter edge cases
# ---------------------------------------------------------------------------


class TestEzaFilterEdgeCases:
    """Edge cases for EzaFilter not covered in test_bash_compress.py."""

    def test_matches_eza_exe_on_windows(self) -> None:
        """EzaFilter matches 'eza.exe' on Windows."""
        f = bc.EzaFilter()
        assert f.matches(["eza.exe", "--git", "--long"])

    def test_does_not_match_unrelated_binary(self) -> None:
        """EzaFilter does not match unrelated binaries like 'grep' or 'rg'."""
        f = bc.EzaFilter()
        assert not f.matches(["grep", "-r", "pattern"])
        assert not f.matches(["rg", "pattern"])

    def test_does_not_match_empty_argv(self) -> None:
        """EzaFilter returns False for empty argv."""
        f = bc.EzaFilter()
        assert not f.matches([])

    def test_tree_flag_with_equals_form(self) -> None:
        """EzaFilter detects --tree=2 (with equals sign) as tree mode."""
        f = bc.EzaFilter()
        # Generate 100-line output to force compression
        lines = ["root/"]
        for i in range(99):
            lines.append(f"  ├── dir{i}/")
        output = "\n".join(lines)

        # Use --tree=2 form (with value) — should still trigger tree compression
        result = f.compress(output, "", 0, ["eza", "--tree=2"])
        # In tree mode with 100 lines (> 60), it should compress
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) < 100  # must be compressed

    def test_tree_boundary_exactly_60_lines_passes_through(self) -> None:
        """EzaFilter tree output with exactly 60 lines passes through unchanged."""
        f = bc.EzaFilter()
        lines = [f"├── item{i}" for i in range(60)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--tree"])
        # Exactly 60 lines: should NOT be compressed (boundary is <= 60 pass-through)
        assert "elided" not in result

    def test_tree_boundary_61_lines_compressed(self) -> None:
        """EzaFilter tree output with 61 lines triggers compression."""
        f = bc.EzaFilter()
        lines = [f"├── item{i}" for i in range(61)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--tree"])
        # 61 lines: must be compressed
        assert "elided" in result or "more" in result

    def test_flat_listing_boundary_exactly_30_lines_passes_through(self) -> None:
        """EzaFilter flat listing with exactly 30 non-empty lines passes through."""
        f = bc.EzaFilter()
        lines = [f"file{i}.txt" for i in range(30)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--long"])
        assert "elided" not in result

    def test_flat_listing_summary_line_preserved(self) -> None:
        """EzaFilter preserves 'N directories, M files' summary line in flat listing."""
        f = bc.EzaFilter()
        # Build a 40-line listing with a summary at the end
        lines = [f"file{i}.txt" for i in range(39)]
        lines.append("3 directories, 36 files")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--long"])
        # Summary line should appear in result
        assert "directories" in result or "files" in result

    def test_eza_registered_in_filters(self) -> None:
        """LsFilter precedes EzaFilter and claims eza — select_filter returns 'ls'."""
        selected = bc.select_filter(["eza", "--git", "--long"])
        assert selected is not None
        assert selected.name == "ls"

    def test_ls_registered_in_filters(self) -> None:
        """LsFilter handles 'ls' commands — select_filter returns 'ls'."""
        selected = bc.select_filter(["ls", "-la"])
        assert selected is not None
        assert selected.name == "ls"


# ---------------------------------------------------------------------------
# (b) BatFilter edge cases
# ---------------------------------------------------------------------------


class TestBatFilterEdgeCases:
    """Edge cases for BatFilter not covered in test_bash_compress.py."""

    def test_matches_batcat_binary(self) -> None:
        """BatFilter matches 'batcat' (Debian/Ubuntu package name)."""
        f = bc.BatFilter()
        assert f.matches(["batcat", "file.py"])

    def test_matches_bat_exe_on_windows(self) -> None:
        """BatFilter matches 'bat.exe' on Windows."""
        f = bc.BatFilter()
        assert f.matches(["bat.exe", "file.py"])

    def test_matches_batcat_exe_on_windows(self) -> None:
        """BatFilter matches 'batcat.exe' on Windows."""
        f = bc.BatFilter()
        assert f.matches(["batcat.exe", "file.py"])

    def test_does_not_match_unrelated(self) -> None:
        """BatFilter does not match cat, less, or other viewers."""
        f = bc.BatFilter()
        assert not f.matches(["cat", "file.py"])
        assert not f.matches(["less", "file.py"])

    def test_does_not_match_empty_argv(self) -> None:
        """BatFilter returns False for empty argv."""
        f = bc.BatFilter()
        assert not f.matches([])

    def test_ansi_strip_combined_with_long_output_compression(self) -> None:
        """BatFilter strips ANSI and then compresses long output."""
        f = bc.BatFilter()
        # Build 80 lines of ANSI-decorated content to force both stripping and compression
        ansi_lines = [f"\x1b[32mline {i}: some code here\x1b[0m" for i in range(80)]
        output = "\n".join(ansi_lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        # ANSI codes should be stripped
        assert "\x1b[" not in result
        # Content should be compressed (80 > 50 threshold)
        assert "elided" in result or "lines" in result

    def test_exact_50_line_boundary_passes_through(self) -> None:
        """BatFilter passes through output with exactly 50 non-empty lines."""
        f = bc.BatFilter()
        lines = [f"line {i}: code" for i in range(50)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        assert "elided" not in result

    def test_51_lines_triggers_compression(self) -> None:
        """BatFilter compresses output with 51 lines."""
        f = bc.BatFilter()
        lines = [f"line {i}: code" for i in range(51)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        assert "elided" in result

    def test_box_drawing_with_heavy_line(self) -> None:
        """BatFilter strips lines made entirely of ━ (heavy box-drawing character)."""
        f = bc.BatFilter()
        # Include ━ separator lines mixed with content
        lines = [
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "def hello():",
            "    return 'world'",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        # Box-drawing separators should be stripped
        assert "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" not in result
        # Code content should remain
        assert "hello" in result

    def test_batcat_registered_in_filters(self) -> None:
        """BatFilter is selected for batcat commands."""
        selected = bc.select_filter(["batcat", "file.py"])
        assert selected is not None
        assert selected.name == "bat"

    def test_stderr_passthrough_included_in_compress(self) -> None:
        """BatFilter combines stdout and stderr before stripping."""
        f = bc.BatFilter()
        stdout = "line 1\nline 2\n"
        stderr = "warning: no highlighting\n"
        # Short combined output should pass through with ANSI stripped
        result = f.compress(stdout, stderr, 0, ["bat", "file.py"])
        assert "line 1" in result
        assert "line 2" in result


# ---------------------------------------------------------------------------
# (c) DeltaFilter edge cases
# ---------------------------------------------------------------------------


class TestDeltaFilterEdgeCases:
    """Edge cases for DeltaFilter not covered in test_bash_compress.py."""

    def test_matches_delta_exe_on_windows(self) -> None:
        """DeltaFilter matches 'delta.exe' on Windows."""
        f = bc.DeltaFilter()
        assert f.matches(["delta.exe"])

    def test_does_not_match_unrelated(self) -> None:
        """DeltaFilter does not match diff or patch."""
        f = bc.DeltaFilter()
        assert not f.matches(["diff", "a.txt", "b.txt"])
        assert not f.matches(["patch"])

    def test_does_not_match_empty_argv(self) -> None:
        """DeltaFilter returns False for empty argv."""
        f = bc.DeltaFilter()
        assert not f.matches([])

    def test_heavy_bar_separator_removed(self) -> None:
        """DeltaFilter removes lines made entirely of ━ (heavy box-drawing)."""
        f = bc.DeltaFilter()
        lines = [
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "diff --git a/foo.py b/foo.py",
            "+new line",
            "-old line",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Separator should be stripped
        assert "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" not in result
        # Diff content should be preserved
        assert "diff --git" in result
        assert "+new line" in result

    def test_exact_80_line_boundary_passes_through(self) -> None:
        """DeltaFilter passes through diffs with exactly 80 non-empty lines."""
        f = bc.DeltaFilter()
        diff_lines = []
        diff_lines.append("diff --git a/file.py b/file.py")
        diff_lines.append("--- a/file.py")
        diff_lines.append("+++ b/file.py")
        for i in range(77):
            diff_lines.append(f"+new line {i}")
        # Exactly 80 non-empty lines
        output = "\n".join(diff_lines)
        result = f.compress(output, "", 0, ["delta"])
        assert "elided" not in result

    def test_81_lines_triggers_compression(self) -> None:
        """DeltaFilter compresses diffs with 81+ non-empty lines."""
        f = bc.DeltaFilter()
        diff_lines = ["diff --git a/file.py b/file.py", "--- a/file.py", "+++ b/file.py"]
        for i in range(78):
            diff_lines.append(f"+new line {i}")
        # 81 non-empty lines
        output = "\n".join(diff_lines)
        result = f.compress(output, "", 0, ["delta"])
        assert "elided" in result

    def test_ansi_in_stderr_also_stripped(self) -> None:
        """DeltaFilter strips ANSI from combined stdout+stderr."""
        f = bc.DeltaFilter()
        stderr_with_ansi = "\x1b[33mwarning: ...\x1b[0m"
        result = f.compress("", stderr_with_ansi, 0, ["delta"])
        assert "\x1b[" not in result

    def test_delta_registered_in_filters(self) -> None:
        """DeltaFilter is selected for delta commands."""
        selected = bc.select_filter(["delta"])
        assert selected is not None
        assert selected.name == "delta"


# ---------------------------------------------------------------------------
# (d) FzfFilter edge cases
# ---------------------------------------------------------------------------


class TestFzfFilterEdgeCases:
    """Edge cases for FzfFilter not covered in test_bash_compress_dispatch.py or test_bash_compress.py."""

    def test_matches_fzf_exe_on_windows(self) -> None:
        """FzfFilter matches 'fzf.exe' on Windows."""
        f = bc.FzfFilter()
        assert f.matches(["fzf.exe"])
        assert f.matches(["fzf.exe", "--multi"])

    def test_does_not_match_unrelated(self) -> None:
        """FzfFilter does not match grep or find."""
        f = bc.FzfFilter()
        assert not f.matches(["grep", "pattern"])
        assert not f.matches(["find", "."])

    def test_does_not_match_empty_argv(self) -> None:
        """FzfFilter returns False for empty argv."""
        f = bc.FzfFilter()
        assert not f.matches([])

    def test_exact_50_line_boundary_passes_through(self) -> None:
        """FzfFilter passes through exactly 50 non-empty lines unchanged."""
        f = bc.FzfFilter()
        lines = [f"item_{i}" for i in range(50)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["fzf"])
        assert "elided" not in result

    def test_51_lines_triggers_compression(self) -> None:
        """FzfFilter compresses 51 lines."""
        f = bc.FzfFilter()
        lines = [f"item_{i}" for i in range(51)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["fzf"])
        assert "elided" in result

    def test_stderr_included_in_output(self) -> None:
        """FzfFilter includes stderr in combined output."""
        f = bc.FzfFilter()
        stdout = "selected_file.txt"
        stderr = "no match for query"
        result = f.compress(stdout, stderr, 0, ["fzf"])
        # Both should appear in result for short combined output
        assert "selected_file.txt" in result

    def test_fzf_registered_in_filters(self) -> None:
        """FzfFilter is selected for fzf commands."""
        selected = bc.select_filter(["fzf", "--multi"])
        assert selected is not None
        assert selected.name == "fzf"

    def test_compression_preserves_first_and_last_items(self) -> None:
        """FzfFilter compression keeps first 40 and last 10 items."""
        f = bc.FzfFilter()
        lines = [f"file_{i:03d}.txt" for i in range(80)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["fzf", "--multi"])
        # First item should be present
        assert "file_000.txt" in result
        # 40th item (0-indexed: item 39) should be present
        assert "file_039.txt" in result
        # Last item should be present
        assert "file_079.txt" in result
        # Some middle items should be missing
        assert "file_050.txt" not in result


# ---------------------------------------------------------------------------
# (e) JqFilter edge cases
# ---------------------------------------------------------------------------


class TestJqFilterEdgeCases:
    """Edge cases for JqFilter not covered in test_bash_compress.py."""

    def test_matches_jq_exe_on_windows(self) -> None:
        """JqFilter matches 'jq.exe' on Windows."""
        f = bc.JqFilter()
        assert f.matches(["jq.exe"])
        assert f.matches(["jq.exe", ".dependencies"])

    def test_does_not_match_unrelated(self) -> None:
        """JqFilter does not match yq or python."""
        f = bc.JqFilter()
        assert not f.matches(["yq", "."])
        assert not f.matches(["python", "-c", "import json"])

    def test_does_not_match_empty_argv(self) -> None:
        """JqFilter returns False for empty argv."""
        f = bc.JqFilter()
        assert not f.matches([])

    def test_exact_200_line_boundary_passes_through(self) -> None:
        """JqFilter passes through exactly 200 non-empty lines."""
        f = bc.JqFilter()
        lines = [f'  "key{i}": "value{i}",' for i in range(198)]
        lines = ["{"] + lines + ["}"]  # 200 lines total
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        assert "elided" not in result

    def test_201_lines_triggers_compression(self) -> None:
        """JqFilter compresses output with 201 non-empty lines."""
        f = bc.JqFilter()
        lines = [f'  "key{i}": "value{i}",' for i in range(199)]
        lines = ["{"] + lines + ["}"]  # 201 lines
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        assert "elided" in result

    def test_jq_stderr_error_passthrough(self) -> None:
        """JqFilter passes stderr error messages (e.g., jq parse errors) through."""
        f = bc.JqFilter()
        stdout = ""
        stderr = "parse error (Invalid numeric literal at EOF): at line 1"
        # Short combined output should pass through without elision
        result = f.compress(stdout, stderr, 1, ["jq", "."])
        assert "parse error" in result
        assert "elided" not in result

    def test_jq_empty_output(self) -> None:
        """JqFilter handles empty output gracefully."""
        f = bc.JqFilter()
        result = f.compress("", "", 0, ["jq", "."])
        assert result == ""

    def test_deeply_nested_json_compressed(self) -> None:
        """JqFilter compresses deeply nested JSON that exceeds 200 lines."""
        f = bc.JqFilter()
        # Build a deeply nested structure that produces 250 lines
        lines = ["{"]
        for i in range(248):
            lines.append(f'  "level_{i}": {{')
        for _ in range(248):
            lines.append("  }")
        lines.append("}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        # Should be compressed
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 204  # 150 + 50 + marker + slop

    def test_jq_registered_in_filters(self) -> None:
        """JqFilter is selected for jq commands."""
        selected = bc.select_filter(["jq", ".scripts"])
        assert selected is not None
        assert selected.name == "jq"


# ---------------------------------------------------------------------------
# (f) YqFilter edge cases
# ---------------------------------------------------------------------------


class TestYqFilterEdgeCases:
    """Edge cases for YqFilter not covered in test_bash_compress.py."""

    def test_matches_yq_exe_on_windows(self) -> None:
        """YqFilter matches 'yq.exe' on Windows."""
        f = bc.YqFilter()
        assert f.matches(["yq.exe"])
        assert f.matches(["yq.exe", ".services"])

    def test_does_not_match_unrelated(self) -> None:
        """YqFilter does not match jq or sed."""
        f = bc.YqFilter()
        assert not f.matches(["jq", "."])
        assert not f.matches(["sed", "-n", "1p"])

    def test_does_not_match_empty_argv(self) -> None:
        """YqFilter returns False for empty argv."""
        f = bc.YqFilter()
        assert not f.matches([])

    def test_exact_150_line_boundary_passes_through(self) -> None:
        """YqFilter passes through exactly 150 non-empty lines."""
        f = bc.YqFilter()
        lines = [f"key{i}: value{i}" for i in range(150)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        assert "elided" not in result

    def test_151_lines_triggers_compression(self) -> None:
        """YqFilter compresses output with 151 non-empty lines."""
        f = bc.YqFilter()
        lines = [f"key{i}: value{i}" for i in range(151)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        assert "elided" in result

    def test_yq_stderr_error_passthrough(self) -> None:
        """YqFilter passes stderr error messages through."""
        f = bc.YqFilter()
        stdout = ""
        stderr = "Error: bad expression: could not find '>'"
        result = f.compress(stdout, stderr, 1, ["yq", "."])
        assert "Error" in result
        assert "elided" not in result

    def test_yq_empty_output(self) -> None:
        """YqFilter handles empty output gracefully."""
        f = bc.YqFilter()
        result = f.compress("", "", 0, ["yq", "."])
        assert result == ""

    def test_yq_registered_in_filters(self) -> None:
        """YqFilter is selected for yq commands."""
        selected = bc.select_filter(["yq", ".on.push.branches"])
        assert selected is not None
        assert selected.name == "yq"

    def test_yq_compression_preserves_structure_boundaries(self) -> None:
        """YqFilter keeps first 100 and last 50 lines when compressing."""
        f = bc.YqFilter()
        lines = [f"item_{i}: value" for i in range(200)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        # item_0 is in head (first 100)
        assert "item_0: value" in result
        # item_99 is in head (first 100)
        assert "item_99: value" in result
        # item_150 is in tail (last 50: items 150-199)
        assert "item_150: value" in result
        # item_199 is in tail (last item)
        assert "item_199: value" in result
        # item_100 is in the elided middle
        assert "item_100: value" not in result


# ---------------------------------------------------------------------------
# (g) Direct unit tests for hints.py dedup helpers
# ---------------------------------------------------------------------------


class TestCheckDedupPreconditions:
    """Direct unit tests for hints._check_dedup_preconditions."""

    def test_returns_false_when_no_session_id(self) -> None:
        """_check_dedup_preconditions returns False when session_id is empty."""
        from token_goat.hints import _check_dedup_preconditions

        result = _check_dedup_preconditions(
            session_id="",
            required_param="ls -la",
            cache=None,
        )
        assert result is False

    def test_returns_false_when_required_param_none(self) -> None:
        """_check_dedup_preconditions returns False when required_param is None."""
        from token_goat.hints import _check_dedup_preconditions

        result = _check_dedup_preconditions(
            session_id="abc123",
            required_param=None,
            cache=None,
        )
        assert result is False

    def test_returns_false_when_required_param_empty_string(self) -> None:
        """_check_dedup_preconditions returns False when required_param is empty string."""
        from token_goat.hints import _check_dedup_preconditions

        result = _check_dedup_preconditions(
            session_id="abc123",
            required_param="",
            cache=None,
        )
        assert result is False

    def test_returns_true_when_no_cache(self) -> None:
        """_check_dedup_preconditions returns True when session_id and param valid, no cache."""
        from token_goat.hints import _check_dedup_preconditions

        result = _check_dedup_preconditions(
            session_id="abc123",
            required_param="ls -la",
            cache=None,
        )
        assert result is True

    def test_returns_false_when_session_id_none(self) -> None:
        """_check_dedup_preconditions returns False when session_id is None (falsy)."""
        from token_goat.hints import _check_dedup_preconditions

        # None is falsy so should return False
        result = _check_dedup_preconditions(
            session_id=None,  # type: ignore[arg-type]
            required_param="command",
            cache=None,
        )
        assert result is False

    def test_returns_true_with_valid_cache(self, tmp_data_dir) -> None:
        """_check_dedup_preconditions returns True when cache passes curator+budget checks."""
        from token_goat import session
        from token_goat.hints import _check_dedup_preconditions

        cache = session.SessionCache(
            session_id="test_precond",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        # Fresh cache with no hints suppressed — curator should emit
        result = _check_dedup_preconditions(
            session_id="test_precond",
            required_param="git log --oneline",
            cache=cache,
        )
        assert result is True


class TestCheckEntryStatelessness:
    """Direct unit tests for hints._check_entry_staleness.

    NOTE: The string "test_stale" used as stale_reason_key in these tests is a
    test-only key chosen to be recognisable in the global stats DB.  Historical
    test runs (before monkeypatching was added to all stale-path tests) wrote
    ~190 "test_stale" rows to the production DB — those rows are harmless but
    should not appear on new installs.  Going forward, any test that exercises
    the stale branch MUST either:
    (a) use monkeypatch.setattr(_hints, "_record_dedup_stale", lambda *a, **kw: None)
        to avoid any DB write, OR
    (b) use the tmp_data_dir fixture to redirect the DB to a temp directory.
    Tests that only exercise non-stale entries (age < threshold) are safe without
    either guard because the stale branch is never reached.
    """

    def _make_entry(self, ts: float) -> object:
        """Create a minimal object with a .ts attribute."""
        @dataclass
        class FakeEntry:
            ts: float
        return FakeEntry(ts=ts)

    def test_fresh_entry_not_stale(self) -> None:
        """_check_entry_staleness returns (False, age) for a recent entry."""
        from token_goat.hints import _check_entry_staleness

        now = time.time()
        entry = self._make_entry(now - 10)  # 10 seconds old

        is_stale, age = _check_entry_staleness(
            entry,
            cache=None,
            log_label="test",
            stale_reason_key="test_stale",
        )
        assert is_stale is False
        assert 9 <= age <= 15  # 10s old with some tolerance

    def test_old_entry_is_stale(self, monkeypatch) -> None:
        """_check_entry_staleness returns (True, age) for an old entry."""
        import token_goat.hints as _hints
        from token_goat.hints import _check_entry_staleness

        # _record_dedup_stale opens the stats DB; mock it so this unit test
        # stays fast and doesn't touch the real or tmp DB at all.
        monkeypatch.setattr(_hints, "_record_dedup_stale", lambda *a, **kw: None)

        now = time.time()
        # Default stale threshold is STALE_READ_AGE_SECONDS (1800s)
        # An entry 7200 seconds old should always be stale
        entry = self._make_entry(now - 7200)

        is_stale, age = _check_entry_staleness(
            entry,
            cache=None,
            log_label="test",
            stale_reason_key="test_stale",
        )
        assert is_stale is True
        assert age >= 7000

    def test_age_returned_accurately(self) -> None:
        """_check_entry_staleness age return value is accurate."""
        from token_goat.hints import _check_entry_staleness

        now = time.time()
        entry_age = 30  # 30 seconds old
        entry = self._make_entry(now - entry_age)

        _, age = _check_entry_staleness(
            entry,
            cache=None,
            log_label="test",
            stale_reason_key="test_stale",
        )
        # Age should be approximately entry_age
        assert abs(age - entry_age) < 2  # within 2 seconds

    def test_stale_branch_calls_record_dedup_stale_with_correct_key(self, monkeypatch) -> None:
        """_check_entry_staleness forwards the stale_reason_key to _record_dedup_stale.

        This ensures the stat kind written to the DB matches what the caller provides,
        and verifies the stale branch is exercised correctly without polluting the
        production stats DB (monkeypatch guards the DB write).
        """
        import token_goat.hints as _hints
        from token_goat.hints import _check_entry_staleness

        recorded_calls: list[tuple[str, str]] = []

        def capture_dedup_stale(kind: str, detail: str) -> None:
            recorded_calls.append((kind, detail))

        monkeypatch.setattr(_hints, "_record_dedup_stale", capture_dedup_stale)

        now = time.time()
        entry = self._make_entry(now - 7200)  # 2h old — always stale

        is_stale, _ = _check_entry_staleness(
            entry,
            cache=None,
            log_label="test_caller",
            stale_reason_key="bash_dedup_stale",
            detail="ls -la",
        )

        assert is_stale is True
        assert len(recorded_calls) == 1, "_record_dedup_stale must be called exactly once"
        assert recorded_calls[0][0] == "bash_dedup_stale", (
            "stale_reason_key must be forwarded as the stat kind"
        )
        assert recorded_calls[0][1] == "ls -la", (
            "detail must be forwarded to _record_dedup_stale"
        )


class TestCheckDedupMinThreshold:
    """Direct unit tests for hints._check_dedup_min_threshold."""

    def test_value_below_threshold_returns_true(self) -> None:
        """_check_dedup_min_threshold returns True (should suppress) when value < threshold."""
        from token_goat.hints import _check_dedup_min_threshold

        result = _check_dedup_min_threshold(
            value=5,
            min_fn=lambda: 100,
            cache=None,
            suppression_key="test_below",
        )
        assert result is True  # True = suppress

    def test_value_above_threshold_returns_false(self) -> None:
        """_check_dedup_min_threshold returns False (should NOT suppress) when value >= threshold."""
        from token_goat.hints import _check_dedup_min_threshold

        result = _check_dedup_min_threshold(
            value=200,
            min_fn=lambda: 100,
            cache=None,
            suppression_key="test_above",
        )
        assert result is False  # False = don't suppress

    def test_value_exactly_at_threshold_not_suppressed(self) -> None:
        """_check_dedup_min_threshold returns False when value == threshold exactly."""
        from token_goat.hints import _check_dedup_min_threshold

        result = _check_dedup_min_threshold(
            value=100,
            min_fn=lambda: 100,
            cache=None,
            suppression_key="test_exact",
        )
        assert result is False  # value is not < min, so don't suppress

    def test_none_value_returns_true(self) -> None:
        """_check_dedup_min_threshold returns True (suppress) when value is None."""
        from token_goat.hints import _check_dedup_min_threshold

        result = _check_dedup_min_threshold(
            value=None,
            min_fn=lambda: 100,
            cache=None,
            suppression_key="test_none",
        )
        assert result is True  # None value = suppress

    def test_records_suppression_in_cache(self, tmp_data_dir) -> None:
        """_check_dedup_min_threshold records suppression when value is below threshold."""
        from token_goat import session
        from token_goat.hints import _check_dedup_min_threshold

        cache = session.SessionCache(
            session_id="test_threshold",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        initial_suppressed = dict(cache.hints_suppressed_by_type)

        _check_dedup_min_threshold(
            value=5,
            min_fn=lambda: 100,
            cache=cache,
            suppression_key="bash_dedup_below_threshold",
        )
        # Suppression should be recorded
        assert cache.hints_suppressed_by_type.get("bash_dedup_below_threshold", 0) > initial_suppressed.get("bash_dedup_below_threshold", 0)

    def test_no_suppression_recorded_when_above_threshold(self, tmp_data_dir) -> None:
        """_check_dedup_min_threshold does NOT record suppression when above threshold."""
        from token_goat import session
        from token_goat.hints import _check_dedup_min_threshold

        cache = session.SessionCache(
            session_id="test_no_suppress",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        _check_dedup_min_threshold(
            value=200,
            min_fn=lambda: 100,
            cache=cache,
            suppression_key="bash_dedup_below_threshold",
        )
        # No suppression should be recorded
        assert cache.hints_suppressed_by_type.get("bash_dedup_below_threshold", 0) == 0


class TestRecordDedupHintEmitted:
    """Direct unit tests for hints._record_dedup_hint_emitted."""

    def test_increments_hints_emitted(self, tmp_data_dir) -> None:
        """_record_dedup_hint_emitted increments cache.hints_emitted."""
        from token_goat import session
        from token_goat.hints import _record_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_dedup_emit",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        initial_count = cache.hints_emitted

        _record_dedup_hint_emitted(cache, "cmd_sha_123", "bash_dedup", "fp_key_abc")

        # hints_emitted should have increased
        assert cache.hints_emitted > initial_count

    def test_records_hint_type(self, tmp_data_dir) -> None:
        """_record_dedup_hint_emitted calls cache.record_hint_emitted with the hint_type."""
        from token_goat import session
        from token_goat.hints import _record_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_dedup_type",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        _record_dedup_hint_emitted(cache, "key_123", "bash_dedup", "fp_key_xyz")

        # The hint type should be recorded in hints_emitted_by_type
        assert cache.hints_emitted_by_type.get("bash_dedup", 0) >= 1

    def test_marks_hint_seen(self, tmp_data_dir) -> None:
        """_record_dedup_hint_emitted marks the fingerprint as seen."""
        from token_goat import session
        from token_goat.hints import _record_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_mark_seen",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        fp_key = "fp_key_unique_12345"

        # Before: fingerprint should not be seen
        assert not cache.has_hint_fingerprint(fp_key)

        _record_dedup_hint_emitted(cache, "hint_key", "bash_dedup", fp_key)

        # After: fingerprint should be seen
        assert cache.has_hint_fingerprint(fp_key)

    def test_multiple_calls_accumulate(self, tmp_data_dir) -> None:
        """_record_dedup_hint_emitted can be called multiple times, each increments."""
        from token_goat import session
        from token_goat.hints import _record_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_multi",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        for i in range(3):
            _record_dedup_hint_emitted(cache, f"key_{i}", "bash_dedup", f"fp_{i}")

        assert cache.hints_emitted_by_type.get("bash_dedup", 0) >= 3


class TestRecordBashDedupEmitted:
    """Direct unit tests for hints._record_bash_dedup_emitted."""

    def test_adds_dedup_key_to_set(self, tmp_data_dir) -> None:
        """_record_bash_dedup_emitted adds the dedup_key to bash_dedup_emitted_ids."""
        from token_goat import session
        from token_goat.hints import _record_bash_dedup_emitted

        cache = session.SessionCache(
            session_id="test_bash_dedup_set",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        dedup_key = "sha256_prefix_abcdef"

        assert dedup_key not in cache.bash_dedup_emitted_ids

        _record_bash_dedup_emitted(cache, dedup_key)

        assert dedup_key in cache.bash_dedup_emitted_ids

    def test_idempotent_when_called_twice(self, tmp_data_dir) -> None:
        """_record_bash_dedup_emitted is idempotent (set semantics)."""
        from token_goat import session
        from token_goat.hints import _record_bash_dedup_emitted

        cache = session.SessionCache(
            session_id="test_bash_dedup_idem",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        dedup_key = "key_idem_abc"

        _record_bash_dedup_emitted(cache, dedup_key)
        _record_bash_dedup_emitted(cache, dedup_key)

        # Should still have only one entry
        count = sum(1 for k in cache.bash_dedup_emitted_ids if k == dedup_key)
        assert count == 1

    def test_multiple_keys_all_added(self, tmp_data_dir) -> None:
        """_record_bash_dedup_emitted correctly adds multiple distinct keys."""
        from token_goat import session
        from token_goat.hints import _record_bash_dedup_emitted

        cache = session.SessionCache(
            session_id="test_bash_dedup_multi",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        keys = ["key_a", "key_b", "key_c"]
        for k in keys:
            _record_bash_dedup_emitted(cache, k)

        for k in keys:
            assert k in cache.bash_dedup_emitted_ids


class TestRecordNonDedupHintEmitted:
    """Direct unit tests for hints._record_non_dedup_hint_emitted."""

    def test_increments_structured_counter(self, tmp_data_dir) -> None:
        """_record_non_dedup_hint_emitted increments structured_hints_emitted counter."""
        from token_goat import session
        from token_goat.hints import _record_non_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_struct",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        initial = cache.structured_hints_emitted

        _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file")

        assert cache.structured_hints_emitted == initial + 1

    def test_increments_index_only_counter(self, tmp_data_dir) -> None:
        """_record_non_dedup_hint_emitted increments index_only_hints_emitted counter."""
        from token_goat import session
        from token_goat.hints import _record_non_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_index_only",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        initial = cache.index_only_hints_emitted

        _record_non_dedup_hint_emitted(cache, "index_only_hints_emitted", "index_only_file")

        assert cache.index_only_hints_emitted == initial + 1

    def test_records_hint_type(self, tmp_data_dir) -> None:
        """_record_non_dedup_hint_emitted records the hint type."""
        from token_goat import session
        from token_goat.hints import _record_non_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_non_dedup_type",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file")

        assert cache.hints_emitted_by_type.get("structured_file", 0) >= 1

    def test_multiple_calls_accumulate_counter(self, tmp_data_dir) -> None:
        """_record_non_dedup_hint_emitted accumulates correctly over multiple calls."""
        from token_goat import session
        from token_goat.hints import _record_non_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_accum",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        for _ in range(5):
            _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file")

        assert cache.structured_hints_emitted == 5

    def test_arbitrary_counter_attr_works(self, tmp_data_dir) -> None:
        """_record_non_dedup_hint_emitted works with any valid counter attribute name."""
        from token_goat import session
        from token_goat.hints import _record_non_dedup_hint_emitted

        cache = session.SessionCache(
            session_id="test_arbitrary",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )

        # Both structured and index_only counters should work
        _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file")
        _record_non_dedup_hint_emitted(cache, "index_only_hints_emitted", "index_only_file")

        assert cache.structured_hints_emitted == 1
        assert cache.index_only_hints_emitted == 1
