"""Tests for KtlintFilter, ZigFilter, and SassFilter."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# KtlintFilter
# ---------------------------------------------------------------------------

_KTLINT_PLAIN = """\
src/main/kotlin/Foo.kt:10:5: error: Imports must be ordered alphabetically (import-ordering)
src/main/kotlin/Bar.kt:5:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:12:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:18:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:25:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Baz.kt:7:1: warning: Unnecessary trailing whitespace (trailing-whitespace)
"""

_KTLINT_CLEAN = """\
No lint errors found.
"""

_KTLINT_CHECKSTYLE = """\
<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="8.0">
<file name="src/main/kotlin/Foo.kt">
<error line="10" column="5" severity="error" message="Imports must be ordered alphabetically" source="import-ordering"/>
</file>
<file name="src/main/kotlin/Bar.kt">
<error line="5" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="12" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="18" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="22" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
</file>
</checkstyle>
"""


class TestKtlintFilter(FilterTestMixin):
    F = bc.KtlintFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_ktlint(self) -> None:
        assert self.F.matches(["ktlint", "src/"])

    def test_no_match_pylint(self) -> None:
        assert not self.F.matches(["pylint", "src/"])

    def test_no_match_eslint(self) -> None:
        assert not self.F.matches(["eslint", "src/"])

    # --- select -----------------------------------------------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["ktlint", "src/"])
        assert isinstance(f, bc.KtlintFilter), (
            f"Expected KtlintFilter but got {type(f).__name__}"
        )

    # --- compress: plain text dedup ----------------------------------------

    def test_error_always_kept(self) -> None:
        out = _compress(self.F, _KTLINT_PLAIN)
        # error severity line always kept
        assert "import-ordering" in out
        assert "10:5" in out

    def test_first_three_rule_occurrences_kept(self) -> None:
        out = _compress(self.F, _KTLINT_PLAIN)
        # curly-spacing appears 4 times in Bar.kt — first 3 should be kept
        assert "Bar.kt:5:3" in out
        assert "Bar.kt:12:3" in out
        assert "Bar.kt:18:3" in out

    def test_fourth_occurrence_deduplicated(self) -> None:
        out = _compress(self.F, _KTLINT_PLAIN)
        # Bar.kt:25:3 is the 4th curly-spacing — should not appear verbatim
        assert "Bar.kt:25:3" not in out

    def test_different_rule_not_suppressed(self) -> None:
        out = _compress(self.F, _KTLINT_PLAIN)
        assert "trailing-whitespace" in out

    def test_clean_output_preserved(self) -> None:
        out = _compress(self.F, _KTLINT_CLEAN)
        assert "No lint errors" in out

    def test_dedup_fires_on_fourth(self) -> None:
        # Build output that has 4 warnings of the same rule
        many_same = "\n".join(
            f"src/Foo.kt:{i}:1: warning: Redundant curly braces (curly-spacing)"
            for i in range(1, 6)
        )
        out = _compress(self.F, many_same)
        # First 3 kept, 4th and 5th collapsed
        assert "1:1" in out
        assert "2:1" in out
        assert "3:1" in out
        assert "4:1" not in out
        assert "more" in out.lower() or "deduplicated" in out.lower() or "token-goat" in out

    # --- compress: checkstyle XML format -----------------------------------

    def test_checkstyle_xml_tags_dropped(self) -> None:
        out = _compress(self.F, _KTLINT_CHECKSTYLE)
        assert "<checkstyle" not in out
        assert "<?xml" not in out
        assert "<file name" not in out

    def test_checkstyle_error_line_kept(self) -> None:
        out = _compress(self.F, _KTLINT_CHECKSTYLE)
        assert "import-ordering" in out

    def test_checkstyle_dedup_by_source(self) -> None:
        out = _compress(self.F, _KTLINT_CHECKSTYLE)
        # 4 curly-spacing <error> entries: first 3 kept, 4th collapsed
        assert "curly-spacing" in out
        # 4th entry (line="22") should be absent or replaced by a note
        assert 'line="22"' not in out

    # --- compress: empty input -------------------------------------------



# ---------------------------------------------------------------------------
# ZigFilter
# ---------------------------------------------------------------------------

_ZIG_BUILD_SUCCESS = """\
[1/7] Compiling foo.zig
[2/7] Compiling bar.zig
[3/7] Compiling baz.zig
[4/7] Compiling qux.zig
[5/7] Compiling quux.zig
[6/7] Linking lib.a
[7/7] Linking zig-out/bin/myapp
Build Summary: 7/7 steps succeeded
"""

_ZIG_BUILD_FAIL = """\
[1/3] Compiling main.zig
src/main.zig:15:5: error: expected type 'u32', found 'bool'
src/main.zig:15:5: note: operand must be an integer
Build Summary: 1/3 steps succeeded; 2 failed
"""

_ZIG_TEST_SUCCESS = """\
[1/1] test
test "addition works"... OK
test "subtraction works"... OK
test "multiplication works"... OK
All 3 tests passed.
"""

_ZIG_TEST_FAIL = """\
[1/1] test
test "addition works"... OK
test "bad division"... FAIL (DivisionByZero)
1 passed; 1 failed.
"""

_ZIG_FETCH = """\
info: Found cached package /home/user/.cache/zig/p/foo-1.2.3
fetch https://example.com/bar-2.0.tar.gz
[1/2] Compiling lib.zig
[2/2] Linking zig-out/lib/mylib.a
Build Summary: 2/2 steps succeeded
"""


class TestZigFilter(FilterTestMixin):
    F = bc.ZigFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_zig(self) -> None:
        assert self.F.matches(["zig", "build"])

    def test_matches_zig_test(self) -> None:
        assert self.F.matches(["zig", "test", "src/"])

    def test_no_match_zsh(self) -> None:
        assert not self.F.matches(["zsh", "-c", "echo hi"])

    def test_no_match_zip(self) -> None:
        assert not self.F.matches(["zip", "archive.zip"])

    # --- select -----------------------------------------------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["zig", "build"])
        assert isinstance(f, bc.ZigFilter), (
            f"Expected ZigFilter but got {type(f).__name__}"
        )

    # --- compress: build success ------------------------------------------

    def test_build_step_sample_kept(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_SUCCESS)
        # First 5 steps kept
        assert "[1/7]" in out
        assert "[5/7]" in out

    def test_build_step_extra_collapsed(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_SUCCESS)
        # [6/7] and [7/7] are beyond the 5-step sample
        assert "[6/7]" not in out
        assert "[7/7]" not in out
        assert "more" in out.lower() or "token-goat" in out

    def test_build_summary_kept(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_SUCCESS)
        assert "Build Summary" in out
        assert "7/7 steps succeeded" in out

    # --- compress: build failure ------------------------------------------

    def test_error_diagnostic_kept(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_FAIL, exit_code=1)
        assert "error:" in out
        assert "expected type 'u32'" in out

    def test_note_diagnostic_kept(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_FAIL, exit_code=1)
        assert "note:" in out

    def test_fail_summary_kept(self) -> None:
        out = _compress(self.F, _ZIG_BUILD_FAIL, exit_code=1)
        assert "Build Summary" in out
        assert "2 failed" in out

    # --- compress: test success -------------------------------------------

    def test_passing_tests_collapsed(self) -> None:
        out = _compress(self.F, _ZIG_TEST_SUCCESS)
        # "OK" test lines should be collapsed, not kept verbatim
        assert "addition works" not in out
        assert "subtraction works" not in out

    def test_passing_tests_collapse_note(self) -> None:
        out = _compress(self.F, _ZIG_TEST_SUCCESS)
        assert "collapsed" in out or "token-goat" in out

    def test_test_summary_kept(self) -> None:
        out = _compress(self.F, _ZIG_TEST_SUCCESS)
        assert "All 3 tests passed" in out

    # --- compress: test failure -------------------------------------------

    def test_failing_test_kept(self) -> None:
        out = _compress(self.F, _ZIG_TEST_FAIL, exit_code=1)
        assert "bad division" in out
        assert "FAIL" in out

    def test_test_fail_summary_kept(self) -> None:
        out = _compress(self.F, _ZIG_TEST_FAIL, exit_code=1)
        assert "1 passed" in out
        assert "1 failed" in out

    # --- compress: fetch lines -------------------------------------------

    def test_fetch_lines_collapsed(self) -> None:
        out = _compress(self.F, _ZIG_FETCH)
        assert "fetch https://" not in out
        assert "Found cached" not in out
        # Collapse note should appear
        assert "fetch" in out.lower() or "token-goat" in out

    # --- compress: empty input -------------------------------------------



# ---------------------------------------------------------------------------
# SassFilter
# ---------------------------------------------------------------------------

_SASS_OUTPUT = """\
      write dist/main.css
      write dist/main.css.map
      write dist/components/button.css
      write dist/components/button.css.map
      write dist/components/form.css
      write dist/components/form.css.map
      write dist/components/modal.css
      write dist/components/modal.css.map
      write dist/pages/home.css
      write dist/pages/home.css.map
      write dist/pages/about.css
      write dist/pages/about.css.map
      write dist/pages/contact.css
      write dist/pages/contact.css.map
Compilation complete.
"""

_SASS_DEPRECATION = """\
Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    ╷
1   │   .icon { width: $size/2; }
    │                  ──────
    ╵
  styles/mixins.scss 1:20  mixin icon()
  styles/main.scss 5:3     @import

Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    ╷
2   │   .btn { height: $h/4; }
    ╵
  styles/buttons.scss 2:10  mixin btn()

Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    ╷
3   │   .card { padding: $p/3; }
    ╵
  styles/cards.scss 3:12   rule card

      write dist/app.css
Compilation complete.
"""

_SASS_ERROR = """\
Error: Expected expression.
  ╷
3 │   color: ;
  │          ^
  ╵
  src/styles/main.scss 3:10  root stylesheet
"""

_LESS_OUTPUT = """\
      write dist/main.css
      write dist/vendor.css
      write dist/print.css
Done compiling sass.
"""


class TestSassFilter(FilterTestMixin):
    F = bc.SassFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_sass(self) -> None:
        assert self.F.matches(["sass", "src/", "dist/"])

    def test_matches_scss(self) -> None:
        assert self.F.matches(["scss", "input.scss", "output.css"])

    def test_matches_lessc(self) -> None:
        assert self.F.matches(["lessc", "input.less", "output.css"])

    def test_matches_node_sass(self) -> None:
        assert self.F.matches(["node-sass", "--output-style", "compressed"])

    def test_no_match_tsc(self) -> None:
        assert not self.F.matches(["tsc", "--build"])

    def test_no_match_ruff(self) -> None:
        assert not self.F.matches(["ruff", "check"])

    # --- select -----------------------------------------------------------

    def test_select_sass(self) -> None:
        f = bc.select_filter(["sass", "styles/", "dist/"])
        assert isinstance(f, bc.SassFilter), (
            f"Expected SassFilter but got {type(f).__name__}"
        )

    def test_select_lessc(self) -> None:
        f = bc.select_filter(["lessc", "input.less"])
        assert isinstance(f, bc.SassFilter), (
            f"Expected SassFilter but got {type(f).__name__}"
        )

    # --- compress: file-write sample --------------------------------------

    def test_first_five_write_lines_kept(self) -> None:
        out = _compress(self.F, _SASS_OUTPUT)
        assert "dist/main.css" in out
        assert "dist/components/button.css" in out
        assert "dist/components/form.css" in out

    def test_write_extra_collapsed(self) -> None:
        out = _compress(self.F, _SASS_OUTPUT)
        # 7 CSS files in fixture, only 5 fit in sample; 6th and 7th are collapsed
        assert "dist/pages/contact.css" not in out
        assert "token-goat" in out or "more" in out.lower()

    def test_source_map_lines_dropped(self) -> None:
        out = _compress(self.F, _SASS_OUTPUT)
        assert ".css.map" not in out

    def test_source_map_drop_note(self) -> None:
        out = _compress(self.F, _SASS_OUTPUT)
        assert "source-map" in out or "token-goat" in out

    def test_summary_kept(self) -> None:
        out = _compress(self.F, _SASS_OUTPUT)
        assert "Compilation complete" in out

    # --- compress: deprecation dedup --------------------------------------

    def test_first_two_deprecations_kept(self) -> None:
        out = _compress(self.F, _SASS_DEPRECATION)
        # The first two deprecation warning headers should appear
        deprecation_count = out.count("Deprecation Warning")
        assert deprecation_count >= 2

    def test_third_deprecation_collapsed(self) -> None:
        out = _compress(self.F, _SASS_DEPRECATION)
        # There are 3 identical deprecation warnings; third should be collapsed
        deprecation_count = out.count("Deprecation Warning")
        # Should be 2 (kept) and a note, not 3
        assert deprecation_count <= 2 or "collapsed" in out or "token-goat" in out

    def test_deprecation_note_emitted(self) -> None:
        out = _compress(self.F, _SASS_DEPRECATION)
        assert "collapsed" in out or "token-goat" in out

    def test_compile_summary_kept_with_deprecations(self) -> None:
        out = _compress(self.F, _SASS_DEPRECATION)
        assert "Compilation complete" in out

    # --- compress: error output -------------------------------------------

    def test_error_kept(self) -> None:
        out = _compress(self.F, _SASS_ERROR, exit_code=1)
        assert "Error:" in out
        assert "Expected expression" in out

    def test_error_context_kept(self) -> None:
        out = _compress(self.F, _SASS_ERROR, exit_code=1)
        assert "main.scss" in out

    # --- compress: Less output -------------------------------------------

    def test_less_write_lines_sampled(self) -> None:
        out = _compress(self.F, _LESS_OUTPUT)
        assert "dist/main.css" in out

    def test_less_summary_kept(self) -> None:
        out = _compress(self.F, _LESS_OUTPUT)
        assert "Done compiling sass" in out

    # --- compress: empty input -------------------------------------------

