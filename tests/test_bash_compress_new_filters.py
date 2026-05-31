"""Tests for TurboFilter, OxlintFilter, and PylintFilter."""
from __future__ import annotations

from token_goat import bash_compress as bc


def _compress(filter_: bc.Filter, stdout: str = "", stderr: str = "", exit_code: int = 0) -> str:
    argv = [filter_.name]
    result = filter_.apply(stdout, stderr, exit_code, argv)
    return result.text


# ---------------------------------------------------------------------------
# TurboFilter
# ---------------------------------------------------------------------------

_TURBO_SUCCESS = """\
• Packages in scope: app, docs, web
• Running build in 3 packages
  app:build: cache miss, executing abcdef123456
  app:build: > webpack --config webpack.config.js
  app:build: asset main.js 1.23 MiB [emitted]
  app:build: webpack compiled successfully
  docs:build: cache hit, replaying output 111111111111
  docs:build: > next build
  docs:build: Creating an optimized production build...
  docs:build: ✓ Compiled successfully
  web:build: cache hit, replaying output 222222222222
  web:build: > next build
  web:build: info  - Generating static pages (3/3)

 Tasks:    3 successful, 3 total
 Cached:   2 cached, 3 total
 Time:     4.321s
"""

_TURBO_FAIL = """\
• Running test in 2 packages
  api:test: cache miss, executing aabbccdd1122
  api:test: FAIL src/auth.test.ts
  api:test: TypeError: Cannot read property 'token' of undefined
  ui:test: cache hit, replaying output 33445566
  ui:test: > jest --passWithNoTests

 Tasks:    1 successful, 1 failed, 2 total
 Time:     8.500s
"""


class TestTurboFilter:
    F = bc.TurboFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_turbo(self) -> None:
        assert self.F.matches(["turbo", "run", "build"])

    def test_matches_npx_turbo(self) -> None:
        assert self.F.matches(["npx", "turbo", "run", "build"])

    def test_matches_pnpx_turbo(self) -> None:
        assert self.F.matches(["pnpx", "turbo", "run", "test"])

    def test_no_match_npm(self) -> None:
        assert not self.F.matches(["npm", "run", "build"])

    def test_no_match_npx_other(self) -> None:
        assert not self.F.matches(["npx", "webpack"])

    # --- select -----------------------------------------------------------

    def test_select_filter(self) -> None:
        assert isinstance(bc.select_filter(["turbo", "run", "build"]), bc.TurboFilter)

    def test_select_npx_turbo(self) -> None:
        assert isinstance(bc.select_filter(["npx", "turbo", "run", "build"]), bc.TurboFilter)

    # --- compress: success path -------------------------------------------

    def test_scope_header_kept(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        assert "Packages in scope" in out

    def test_running_header_kept(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        assert "Running build in 3 packages" in out

    def test_summary_kept(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        assert "Tasks:" in out
        assert "Cached:" in out
        assert "Time:" in out

    def test_cache_miss_task_header_kept(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        assert "cache miss" in out

    def test_cache_hit_task_headers_dropped(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        # "cache hit, replaying output" lines should be gone
        assert "replaying output" not in out

    def test_cache_hit_body_lines_dropped(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        # The next build lines from the cache-hit tasks should not appear
        assert "next build" not in out
        assert "Generating static pages" not in out

    def test_compression_note_present(self) -> None:
        out = _compress(self.F, _TURBO_SUCCESS)
        # Should mention dropped cache-hit entries
        assert "cache-hit" in out

    # --- compress: failure path -------------------------------------------

    def test_error_lines_kept_on_failure(self) -> None:
        out = _compress(self.F, _TURBO_FAIL, exit_code=1)
        assert "TypeError" in out

    def test_fail_summary_kept(self) -> None:
        out = _compress(self.F, _TURBO_FAIL, exit_code=1)
        assert "1 failed" in out

    # --- compress: empty input -------------------------------------------

    def test_empty_input(self) -> None:
        out = _compress(self.F, "")
        assert isinstance(out, str)


# ---------------------------------------------------------------------------
# OxlintFilter
# ---------------------------------------------------------------------------

_OXLINT_OUTPUT = """\
  src/auth.ts
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:10:5]
    │  10 │   var x = 1;
    ·        ───
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:15:1]
    │  15 │   var y = 2;
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:20:1]
    │  20 │   var z = 3;
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:25:1]
    │  25 │   var w = 4;
    ╰─
  src/utils.ts
    × 'foo' is defined but never used (no-unused-vars)
    ╭─[src/utils.ts:5:1]
    ╰─

Found 5 warnings and 0 errors.
Finished in 120ms on 2 files with 7 rules used.
"""

_OXLINT_CLEAN = """\
Found 0 warnings and 0 errors.
Finished in 50ms on 2 files with 7 rules used.
"""


class TestOxlintFilter:
    F = bc.OxlintFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_oxlint(self) -> None:
        assert self.F.matches(["oxlint", "src/"])

    def test_matches_oxc_linter(self) -> None:
        assert self.F.matches(["oxc_linter", "src/"])

    def test_no_match_eslint(self) -> None:
        assert not self.F.matches(["eslint", "src/"])

    # --- select -----------------------------------------------------------

    def test_select_filter(self) -> None:
        assert isinstance(bc.select_filter(["oxlint", "src/"]), bc.OxlintFilter)

    # --- compress: dedup ---------------------------------------------------

    def test_first_three_occurrences_kept(self) -> None:
        out = _compress(self.F, _OXLINT_OUTPUT)
        # 3 no-var issues should be kept — their location boxes include line numbers
        assert "10:5" in out
        assert "15:1" in out
        assert "20:1" in out

    def test_fourth_occurrence_deduplicated(self) -> None:
        out = _compress(self.F, _OXLINT_OUTPUT)
        # The 4th no-var issue — its location box (25:1) should be suppressed
        assert "25:1" not in out

    def test_dedup_note_emitted(self) -> None:
        out = _compress(self.F, _OXLINT_OUTPUT)
        assert "more" in out.lower() or "deduplicated" in out.lower()

    def test_different_rule_not_deduplicated(self) -> None:
        out = _compress(self.F, _OXLINT_OUTPUT)
        # no-unused-vars appears only once — should be kept
        assert "no-unused-vars" in out

    def test_summary_always_kept(self) -> None:
        out = _compress(self.F, _OXLINT_OUTPUT)
        assert "Found 5 warnings" in out
        assert "Finished in 120ms" in out

    def test_clean_output_preserved(self) -> None:
        out = _compress(self.F, _OXLINT_CLEAN)
        assert "Found 0 warnings" in out

    # --- compress: empty input -------------------------------------------

    def test_empty_input(self) -> None:
        out = _compress(self.F, "")
        assert isinstance(out, str)


# ---------------------------------------------------------------------------
# PylintFilter
# ---------------------------------------------------------------------------

_PYLINT_OUTPUT = """\
************* Module src.auth
src/auth.py:10:0: C0301 (line-too-long) Line too long (120/100)
src/auth.py:20:0: C0301 (line-too-long) Line too long (115/100)
src/auth.py:30:0: C0301 (line-too-long) Line too long (112/100)
src/auth.py:40:0: C0301 (line-too-long) Line too long (108/100)
src/auth.py:5:0: W0611 (unused-import) Unused import os
src/auth.py:6:0: W0611 (unused-import) Unused import sys
src/auth.py:7:0: W0611 (unused-import) Unused import re
src/auth.py:8:0: W0611 (unused-import) Unused import json
src/auth.py:50:4: E0001 (syntax-error) invalid syntax
************* Module src.utils
src/utils.py:1:0: C0114 (missing-module-docstring) Missing module docstring
src/utils.py:10:0: C0301 (line-too-long) Line too long (105/100)

------------------------------------------------------------------
Your code has been rated at 6.50/10 (previous run: 5.00/10, +1.50)
"""

_PYLINT_CLEAN = """\
--------------------------------------------------------------------
Your code has been rated at 10.00/10 (previous run: 10.00/10, +0.00)
"""


class TestPylintFilter:
    F = bc.PylintFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_pylint(self) -> None:
        assert self.F.matches(["pylint", "src/"])

    def test_no_match_pytest(self) -> None:
        assert not self.F.matches(["pytest"])

    def test_no_match_pyright(self) -> None:
        # pyright still routes to LinterFilter
        assert not self.F.matches(["pyright", "src/"])

    # --- select: PylintFilter precedes LinterFilter ----------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["pylint", "src/"])
        assert isinstance(f, bc.PylintFilter), (
            f"Expected PylintFilter but got {type(f).__name__}"
        )

    # --- compress: dedup by message code ----------------------------------

    def test_first_three_c0301_kept(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # Lines at :10, :20, :30 should appear
        assert "10:0: C0301" in out
        assert "20:0: C0301" in out
        assert "30:0: C0301" in out

    def test_fourth_c0301_deduplicated(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # Line at :40 is the 4th C0301 — should not appear verbatim
        assert "40:0: C0301" not in out

    def test_dedup_note_for_c0301(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        assert "C0301" in out  # note should mention the code

    def test_error_lines_always_kept(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # E0001 is severity=E — always kept regardless of dedup count
        assert "E0001" in out

    def test_rating_line_kept(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        assert "Your code has been rated at" in out
        assert "6.50/10" in out

    def test_separator_lines_dropped(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # Long separator (---...) should not appear
        assert "---" * 5 not in out

    def test_module_header_kept_when_has_issues(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        assert "Module src.auth" in out

    def test_clean_output_rating_kept(self) -> None:
        out = _compress(self.F, _PYLINT_CLEAN)
        assert "10.00/10" in out

    def test_w0611_third_occurrence_kept(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # W0611 appears 4 times; first 3 should be kept
        assert "W0611" in out

    def test_w0611_fourth_occurrence_deduplicated(self) -> None:
        out = _compress(self.F, _PYLINT_OUTPUT)
        # json is the 4th W0611 — should not appear verbatim
        assert "Unused import json" not in out

    # --- compress: empty input -------------------------------------------

    def test_empty_input(self) -> None:
        out = _compress(self.F, "")
        assert isinstance(out, str)
