"""Tests for token_goat.bash_compress, common helpers and filter dispatch."""
from __future__ import annotations

import re

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# strip_ansi
# ---------------------------------------------------------------------------


class TestStripAnsi:
    def test_removes_basic_color_codes(self):
        text = "\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m"
        assert bc.strip_ansi(text) == "red green"

    def test_removes_256_color_codes(self):
        text = "\x1b[38;5;208mhello\x1b[0m"
        assert bc.strip_ansi(text) == "hello"

    def test_removes_truecolor(self):
        text = "\x1b[38;2;255;0;0mred truecolor\x1b[0m"
        assert bc.strip_ansi(text) == "red truecolor"

    def test_removes_osc_title_sequences(self):
        text = "\x1b]0;window title\x07after"
        assert bc.strip_ansi(text) == "after"

    def test_removes_cursor_movement(self):
        text = "first\x1b[2Asecond\x1b[3Bthird"
        assert bc.strip_ansi(text) == "firstsecondthird"

    def test_idempotent_on_plain_text(self):
        assert bc.strip_ansi("plain text") == "plain text"

    def test_handles_empty(self):
        assert bc.strip_ansi("") == ""

    def test_preserves_unicode(self):
        text = "\x1b[1m日本語\x1b[0m"
        assert bc.strip_ansi(text) == "日本語"


# ---------------------------------------------------------------------------
# strip_progress
# ---------------------------------------------------------------------------


class TestStripProgress:
    def test_collapses_carriage_return_progress(self):
        text = "10%\r50%\r100% done"
        assert bc.strip_progress(text) == "100% done"

    def test_preserves_lines_without_cr(self):
        text = "line1\nline2\nline3"
        assert bc.strip_progress(text) == text

    def test_collapses_per_line(self):
        text = "line1\n10%\r100% done\nline2"
        assert bc.strip_progress(text) == "line1\n100% done\nline2"

    def test_empty_string(self):
        assert bc.strip_progress("") == ""

    def test_only_carriage_returns(self):
        # Final state after multiple progress updates is empty.
        text = "phase1\rphase2\r"
        assert bc.strip_progress(text) == ""


# ---------------------------------------------------------------------------
# dedupe_consecutive
# ---------------------------------------------------------------------------


class TestDedupeConsecutive:
    def test_basic_run_collapses(self):
        out = bc.dedupe_consecutive(["a", "a", "a", "b"])
        assert out == ["a  (×3)", "b"]

    def test_single_repeat_kept_when_below_min_run(self):
        out = bc.dedupe_consecutive(["a", "a", "b"], min_run=3)
        assert out == ["a", "a", "b"]

    def test_no_repeats_passes_through(self):
        out = bc.dedupe_consecutive(["a", "b", "c"])
        assert out == ["a", "b", "c"]

    def test_non_consecutive_not_deduped(self):
        out = bc.dedupe_consecutive(["a", "b", "a"])
        assert out == ["a", "b", "a"]

    def test_custom_format(self):
        out = bc.dedupe_consecutive(["x", "x"], fmt="{line} [{count}]")
        assert out == ["x [2]"]

    def test_empty_input(self):
        assert bc.dedupe_consecutive([]) == []


# ---------------------------------------------------------------------------
# dedupe_by_key
# ---------------------------------------------------------------------------


class TestDedupeByKey:
    def test_keeps_first_n_per_bucket(self):
        lines = [f"F401 occurrence {i}" for i in range(10)]
        key = re.compile(r"(F\d+)")
        out = bc.dedupe_by_key(lines, key, keep_first_n=3)
        # First 3 kept verbatim; summary appended.
        kept = [ln for ln in out if "occurrence" in ln]
        assert len(kept) == 3
        assert any("+7" in ln and "F401" in ln for ln in out)

    def test_unmatched_lines_passed_through(self):
        lines = ["plain", "F401 foo", "F401 bar", "F401 baz", "F401 qux"]
        key = re.compile(r"(F\d+)")
        out = bc.dedupe_by_key(lines, key, keep_first_n=2)
        assert "plain" in out


# ---------------------------------------------------------------------------
# truncate_middle / cap_bytes
# ---------------------------------------------------------------------------


class TestTruncateMiddle:
    def test_under_budget_unchanged(self):
        lines = ["a", "b", "c"]
        assert bc.truncate_middle(lines, 100) == lines

    def test_over_budget_keeps_head_and_tail(self):
        lines = [str(i) for i in range(100)]
        out = bc.truncate_middle(lines, 10)
        assert len(out) == 11  # 4 head + marker + 6 tail
        assert "0" in out and "99" in out
        assert any("elided" in ln for ln in out)


class TestTruncateMiddleSmart:
    """Tests for truncate_middle_smart — error-preserving truncation."""

    # ------------------------------------------------------------------
    # No-error path: must fall back to plain head+tail behaviour
    # ------------------------------------------------------------------

    def test_under_budget_unchanged(self):
        """Lines within budget are returned as-is."""
        lines = ["a", "b", "c"]
        assert bc.truncate_middle_smart(lines, 100) == lines

    def test_no_errors_uses_head_tail(self):
        """Without error signals the output keeps first and last lines."""
        lines = [f"line {i}" for i in range(200)]
        out = bc.truncate_middle_smart(lines, 30)
        # head line and tail line must survive
        assert out[0] == "line 0"
        assert out[-1] == "line 199"
        # a marker must be present
        assert any("omitted" in ln or "elided" in ln for ln in out)
        # middle content without errors is gone
        assert "line 100" not in out

    def test_no_errors_marker_present(self):
        """Plain head+tail omission marker is present."""
        lines = [f"x{i}" for i in range(100)]
        out = bc.truncate_middle_smart(lines, 20)
        markers = [ln for ln in out if "omitted" in ln or "elided" in ln]
        assert len(markers) >= 1

    # ------------------------------------------------------------------
    # Error-preservation path
    # ------------------------------------------------------------------

    def test_error_in_middle_preserved(self):
        """An 'error:' line buried in the middle of output is kept."""
        lines = (
            [f"progress {i}" for i in range(100)]
            + ["src/foo.py:42: error: undefined variable 'x'"]
            + [f"progress {i}" for i in range(100, 200)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("error: undefined variable" in ln for ln in out)

    def test_error_context_lines_included(self):
        """Lines surrounding an error line (within error_context) are kept."""
        lines = (
            [f"build step {i}" for i in range(50)]
            + ["before_error_context"]
            + ["before_error_direct"]
            + ["ERROR: compilation failed"]
            + ["after_error_direct"]
            + ["after_error_context"]
            + [f"build step {i}" for i in range(50, 100)]
        )
        out = bc.truncate_middle_smart(lines, 40, error_context=2)
        joined = "\n".join(out)
        assert "before_error_direct" in joined
        assert "ERROR: compilation failed" in joined
        assert "after_error_direct" in joined

    def test_omission_markers_between_sections(self):
        """Omission markers appear between non-contiguous kept sections."""
        lines = (
            [f"header {i}" for i in range(20)]
            + [f"noise {i}" for i in range(200)]
            + ["FAILED: test_foo"]
            + [f"noise {i}" for i in range(200, 400)]
            + [f"summary {i}" for i in range(20)]
        )
        out = bc.truncate_middle_smart(lines, 60)
        markers = [ln for ln in out if "omitted" in ln or "elided" in ln]
        # Expect at least two markers: one between head→error section, one
        # between error section→tail.
        assert len(markers) >= 2

    def test_traceback_preserved(self):
        """'Traceback' keyword triggers error preservation."""
        lines = (
            ["Running tests..."] * 100
            + ["Traceback (most recent call last):"]
            + ['  File "test.py", line 10, in test_foo']
            + ["AssertionError: expected 1 got 2"]
            + ["......"] * 100
        )
        out = bc.truncate_middle_smart(lines, 40)
        joined = "\n".join(out)
        assert "Traceback" in joined

    def test_multiple_error_lines_capped_at_max_error_lines(self):
        """At most max_error_lines distinct error-signal lines are preserved."""
        error_lines = [f"Error: problem {i}" for i in range(30)]
        lines = (
            ["start"] * 20
            + [item for pair in zip(["noise"] * 30, error_lines, strict=False) for item in pair]
            + ["end"] * 20
        )
        out = bc.truncate_middle_smart(lines, 80, max_error_lines=5)
        # Should not blow past the line budget significantly.
        assert len(out) <= 90  # max_lines + some markers

    def test_panic_preserved(self):
        """'panic:' keyword (Go runtime panics) is treated as an error signal."""
        lines = (
            [f"compiling pkg {i}" for i in range(150)]
            + ["goroutine 1 [running]:"]
            + ["panic: runtime error: index out of range [3] with length 3"]
            + [f"output {i}" for i in range(150)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("panic:" in ln for ln in out)

    def test_failed_keyword_preserved(self):
        """'FAILED' keyword is treated as an error signal."""
        lines = (
            [f"test {i} ok" for i in range(200)]
            + ["FAILED tests/test_api.py::test_login - AssertionError"]
            + [f"test {i} ok" for i in range(200, 400)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("FAILED" in ln for ln in out)

    def test_head_and_tail_always_present_with_errors(self):
        """Header (first lines) and tail (last lines) survive even with errors."""
        lines = (
            ["=== build start ==="]
            + [f"step {i}" for i in range(200)]
            + ["Error: something went wrong"]
            + [f"step {i}" for i in range(200, 400)]
            + ["=== build end ==="]
        )
        out = bc.truncate_middle_smart(lines, 60)
        assert out[0] == "=== build start ==="
        assert out[-1] == "=== build end ==="
        assert any("Error:" in ln for ln in out)


class TestCapBytes:
    def test_under_budget_unchanged(self):
        assert bc.cap_bytes("hello", 100) == "hello"

    def test_over_budget_truncated(self):
        text = ("hello\n" * 1000)
        out = bc.cap_bytes(text, 200)
        assert len(out.encode("utf-8")) <= 220  # 200 budget + marker
        assert "elided" in out

    def test_handles_multibyte_safely(self):
        text = "日本語\n" * 100
        out = bc.cap_bytes(text, 50)
        # Must decode cleanly even after truncation.
        assert "elided" in out


# ---------------------------------------------------------------------------
# normalise
# ---------------------------------------------------------------------------


class TestNormalise:
    def test_strips_progress_and_ansi(self):
        text = "10%\r\x1b[32m100% done\x1b[0m"
        assert bc.normalise(text) == "100% done"

    def test_normalises_crlf(self):
        text = "a\r\nb\r\nc"
        assert bc.normalise(text) == "a\nb\nc"

    def test_empty(self):
        assert bc.normalise("") == ""


# ---------------------------------------------------------------------------
# Filter dispatch
# ---------------------------------------------------------------------------


class TestSelectFilter:
    def test_pytest_argv(self):
        f = bc.select_filter(["pytest", "tests/"])
        assert f is not None and f.name == "pytest"

    def test_pytest_via_python_m(self):
        f = bc.select_filter(["python", "-m", "pytest", "tests/"])
        assert f is not None and f.name == "pytest"

    def test_pytest_via_uv_run(self):
        f = bc.select_filter(["uv", "run", "pytest"])
        assert f is not None and f.name == "pytest"

    def test_jest_direct(self):
        f = bc.select_filter(["jest"])
        assert f is not None and f.name == "jest"

    def test_jest_via_npx(self):
        f = bc.select_filter(["npx", "jest"])
        assert f is not None and f.name == "jest"

    def test_npm_install(self):
        f = bc.select_filter(["npm", "install"])
        assert f is not None and f.name == "npm"

    def test_pnpm_install(self):
        f = bc.select_filter(["pnpm", "install"])
        # pnpm with no exec/run keyword is itself the package manager binary.
        assert f is not None and f.name == "npm"

    def test_docker_build(self):
        f = bc.select_filter(["docker", "build", "-t", "x", "."])
        assert f is not None and f.name == "docker"

    def test_kubectl_get(self):
        f = bc.select_filter(["kubectl", "get", "pods"])
        assert f is not None and f.name == "kubectl"

    def test_git(self):
        f = bc.select_filter(["git", "status"])
        assert f is not None and f.name == "git"

    def test_cargo(self):
        f = bc.select_filter(["cargo", "build"])
        assert f is not None and f.name == "cargo"

    def test_ruff(self):
        f = bc.select_filter(["ruff", "check", "src/"])
        assert f is not None and f.name == "linter"

    def test_mypy(self):
        f = bc.select_filter(["mypy", "src/"])
        assert f is not None and f.name == "mypy"

    def test_make(self):
        f = bc.select_filter(["make", "all"])
        assert f is not None and f.name == "make"

    def test_terraform(self):
        f = bc.select_filter(["terraform", "plan"])
        assert f is not None and f.name == "terraform"

    def test_aws(self):
        f = bc.select_filter(["aws", "s3", "ls"])
        assert f is not None and f.name == "aws"

    def test_pip(self):
        f = bc.select_filter(["pip", "install", "foo"])
        assert f is not None and f.name == "pip"

    def test_unknown_command_returns_none(self):
        assert bc.select_filter(["totally-unknown-binary"]) is None

    def test_empty_argv_returns_none(self):
        assert bc.select_filter([]) is None

    def test_sudo_prefix_stripped(self):
        f = bc.select_filter(["sudo", "docker", "build", "."])
        assert f is not None and f.name == "docker"

    def test_env_assignment_prefix_stripped(self):
        f = bc.select_filter(["NODE_ENV=test", "jest"])
        assert f is not None and f.name == "jest"

    def test_pythonpath_assignment_stripped(self):
        f = bc.select_filter(["PYTHONPATH=src", "python", "-m", "pytest"])
        assert f is not None and f.name == "pytest"


# ---------------------------------------------------------------------------
# detect_from_command (string entry)
# ---------------------------------------------------------------------------


class TestDetectFromCommand:
    def test_basic_command(self):
        result = bc.detect_from_command("pytest tests/")
        assert result is not None
        f, argv = result
        assert f.name == "pytest" and argv[0] == "pytest"

    def test_rejects_pipeline(self):
        # Pipes can't be safely wrapped, must skip.
        assert bc.detect_from_command("pytest | head") is None

    def test_rejects_redirect(self):
        assert bc.detect_from_command("pytest > out.txt") is None

    def test_rejects_command_substitution(self):
        assert bc.detect_from_command("echo $(pytest)") is None
        assert bc.detect_from_command("echo `pytest`") is None

    def test_rejects_chain(self):
        assert bc.detect_from_command("pytest && deploy") is None
        assert bc.detect_from_command("pytest; deploy") is None

    def test_rejects_oversized(self):
        cmd = "pytest " + "x" * 70_000
        assert bc.detect_from_command(cmd) is None

    def test_rejects_unbalanced_quotes(self):
        # shlex.split raises; we should silently skip rather than crash.
        assert bc.detect_from_command("pytest 'unclosed") is None

    def test_empty_string(self):
        assert bc.detect_from_command("") is None

    def test_unknown_binary(self):
        assert bc.detect_from_command("totally-unknown") is None


# ---------------------------------------------------------------------------
# Generic Filter contract
# ---------------------------------------------------------------------------


class TestFilterBase:
    def test_compress_output_preserves_exit_code(self):
        f = bc.GenericFilter()
        result = bc.compress_output(f, "hello\n", "", 42, ["foo"])
        assert result.exit_code == 42

    def test_compress_output_computes_savings(self):
        f = bc.GenericFilter()
        stdout = "same\n" * 100
        result = bc.compress_output(f, stdout, "", 0, ["foo"])
        # Generic dedupes consecutive, savings should be positive.
        assert result.original_bytes > result.compressed_bytes
        assert result.bytes_saved > 0
        assert result.tokens_saved > 0

    def test_compress_output_no_savings_returns_marker_free(self):
        f = bc.GenericFilter()
        result = bc.compress_output(f, "single line", "", 0, ["foo"])
        # No savings → with_marker returns text unchanged.
        assert result.with_marker() == result.text

    def test_filter_exception_falls_back_to_truncation(self):
        class BrokenFilter(bc.Filter):
            name = "broken"
            binaries = frozenset(["whatever"])

            def compress(self, stdout, stderr, exit_code, argv):
                raise ValueError("boom")

        f = BrokenFilter()
        result = f.apply("hello\nworld", "", 0, ["whatever"])
        # Should not propagate the exception.
        assert "hello" in result.text or "world" in result.text
        assert "broken filter raised" in result.text

    def test_byte_cap_enforced(self):
        f = bc.GenericFilter()
        huge_line = "x" * 100_000
        result = f.apply(huge_line, "", 0, ["foo"], max_bytes=1000)
        assert len(result.text.encode("utf-8")) <= 1100


# ---------------------------------------------------------------------------
# Pytest filter golden
# ---------------------------------------------------------------------------


class TestPytestFilter:
    def test_drops_dots_progress(self):
        f = bc.PytestFilter()
        # ``...... [100%]`` is a pure progress line, fully dropped by the
        # _PYTEST_DOTS_RE filter.  ``FAILED test_a`` must survive.
        out = f.compress("...... [100%]\nFAILED test_a\n", "", 0, ["pytest"])
        assert "[100%]" not in out
        assert "FAILED test_a" in out

    def test_keeps_failures(self):
        text = (
            "= test session starts =\n"
            "collected 100 items\n"
            "FAILED tests/test_x.py::test_one\n"
            "= 1 failed, 99 passed in 1.2s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        assert "FAILED tests/test_x.py::test_one" in result.text
        assert "1 failed, 99 passed" in result.text

    def test_collapses_passed_lines(self):
        text = "\n".join([f"PASSED tests/test_{i}.py::test_x" for i in range(50)])
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        assert "PASSED tests/test_0.py" not in result.text
        assert "collapsed 50 PASSED" in result.text


# ---------------------------------------------------------------------------
# Jest filter
# ---------------------------------------------------------------------------


class TestJestFilter:
    def test_collapses_pass_lines(self):
        text = "\n".join(["PASS  src/foo.test.js" for _ in range(10)])
        text += "\nTests: 50 passed\n"
        f = bc.JestFilter()
        result = f.apply(text, "", 0, ["jest"])
        assert "PASS  src/foo.test.js" not in result.text
        assert "collapsed 10 PASS files" in result.text
        assert "Tests: 50 passed" in result.text

    def test_keeps_fail_block(self):
        text = (
            "FAIL src/foo.test.js\n"
            "  expected: 1\n"
            "  received: 2\n"
            "\n"
            "Tests: 1 failed\n"
        )
        f = bc.JestFilter()
        result = f.apply(text, "", 1, ["jest"])
        assert "FAIL src/foo.test.js" in result.text
        assert "expected: 1" in result.text


# ---------------------------------------------------------------------------
# Cargo filter
# ---------------------------------------------------------------------------


class TestCargoFilter:
    def test_collapses_compiling_lines(self):
        text = "\n".join([f"   Compiling crate-{i} v0.1.0" for i in range(20)])
        text += "\n    Finished dev [unoptimized + debuginfo] target(s) in 5.0s\n"
        f = bc.CargoFilter()
        result = f.apply(text, "", 0, ["cargo", "build"])
        assert "Compiling crate-0" in result.text
        assert "Compiling crate-19" in result.text
        assert "collapsed 16 'Compiling" in result.text

    def test_keeps_short_compile_list(self):
        text = "   Compiling foo v0.1.0\n   Compiling bar v0.1.0\n"
        f = bc.CargoFilter()
        result = f.apply(text, "", 0, ["cargo", "build"])
        assert "Compiling foo" in result.text
        assert "Compiling bar" in result.text

    def test_keeps_errors(self):
        stderr = "error[E0308]: mismatched types\n  --> src/lib.rs:5:9\n"
        f = bc.CargoFilter()
        result = f.apply("", stderr, 1, ["cargo", "build"])
        assert "error[E0308]" in result.text
        assert "mismatched types" in result.text


# ---------------------------------------------------------------------------
# Node package filter
# ---------------------------------------------------------------------------


class TestNodePackageFilter:
    def test_drops_spinner_progress(self):
        text = "⠋ idealTree\n⠙ idealTree\n⠹ idealTree\nadded 50 packages\n"
        f = bc.NodePackageFilter()
        result = f.apply(text, "", 0, ["npm", "install"])
        assert "⠋ idealTree" not in result.text
        assert "added 50 packages" in result.text

    def test_collapses_deprecation_warnings(self):
        text = "\n".join([f"npm warn deprecated foo@1.0.{i}: use bar" for i in range(10)])
        f = bc.NodePackageFilter()
        result = f.apply(text, "", 0, ["npm", "install"])
        assert "collapsed 10 deprecation" in result.text

    def test_keeps_npm_err(self):
        stderr = "npm ERR! code ENOENT\nnpm ERR! syscall open\n"
        f = bc.NodePackageFilter()
        result = f.apply("", stderr, 1, ["npm", "install"])
        assert "npm ERR! code ENOENT" in result.text


# ---------------------------------------------------------------------------
# Docker filter
# ---------------------------------------------------------------------------


class TestDockerFilter:
    def test_drops_digest_and_progress(self):
        text = (
            "#1 [internal] load build context\n"
            "#2 sha256:abc123def456789\n"
            "#3 12.3MB / 50.0MB 0.5s\n"
            "#4 [1/3] FROM alpine\n"
        )
        f = bc.DockerFilter()
        result = f.apply(text, "", 0, ["docker", "build"])
        assert "sha256:" not in result.text
        assert "12.3MB / 50.0MB" not in result.text
        assert "[1/3] FROM alpine" in result.text


# ---------------------------------------------------------------------------
# Kubectl filter
# ---------------------------------------------------------------------------


class TestKubectlFilter:
    def test_truncates_long_table(self):
        rows = ["NAME READY STATUS RESTARTS AGE"] + [f"pod-{i} 1/1 Running 0 5m" for i in range(50)]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "get", "pods"])
        assert "NAME READY STATUS" in result.text
        assert "more rows" in result.text

    def test_dedupes_logs(self):
        text = "\n".join(["same line"] * 30)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "pod-foo"])
        assert "(×30)" in result.text


# ---------------------------------------------------------------------------
# AWS filter
# ---------------------------------------------------------------------------


class TestAwsFilter:
    def test_compresses_long_json_array(self):
        import json
        data = [{"id": i, "name": f"resource-{i}"} for i in range(50)]
        text = json.dumps(data)
        f = bc.AwsFilter()
        result = f.apply(text, "", 0, ["aws", "ec2", "describe-instances"])
        assert "items elided" in result.text

    def test_passes_short_json_through(self):
        text = '{"foo": "bar"}'
        f = bc.AwsFilter()
        result = f.apply(text, "", 0, ["aws", "s3", "ls"])
        # No compression triggered; output should contain original content.
        assert "foo" in result.text


# ---------------------------------------------------------------------------
# Linter filter
# ---------------------------------------------------------------------------


class TestLinterFilter:
    def test_ruff_dedupes_by_rule(self):
        text = "\n".join([f"src/foo.py:{i}:1: F401 imported but unused" for i in range(20)])
        f = bc.LinterFilter()
        result = f.apply(text, "", 1, ["ruff", "check"])
        assert "+17 more matching F401" in result.text

    def test_eslint_per_file_dedupe(self):
        text = (
            "src/foo.js\n"
            "  3:1  error  Missing semi  semi\n"
            "  5:1  error  Missing semi  semi\n"
            "  7:1  error  Missing semi  semi\n"
            "  9:1  error  Missing semi  semi\n"
            "  11:1  error  Missing semi  semi\n"
        )
        f = bc.LinterFilter()
        result = f.apply(text, "", 1, ["eslint"])
        assert "+2 more semi" in result.text


# ---------------------------------------------------------------------------
# Git filter
# ---------------------------------------------------------------------------


class TestGitFilter:
    def test_status_truncates_long_lists(self):
        text = (
            "On branch main\n"
            "Changes not staged for commit:\n"
            + "\n".join([f"\tmodified:   path/to/file{i}.py" for i in range(50)])
            + "\n"
        )
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "status"])
        assert "+20 more files" in result.text or "more files" in result.text

    def test_log_truncates_long_history(self):
        text = "\n\n".join([f"commit abc{i:04d}def\nAuthor: a\nDate: x\n\n    msg {i}" for i in range(50)])
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "log"])
        assert "earlier commits elided" in result.text

    def test_diff_truncates_hunks(self):
        block = "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n"
        block += "\n".join([f"@@ -{i},1 +{i},1 @@\n-old{i}\n+new{i}" for i in range(10)])
        f = bc.GitFilter()
        result = f.apply(block, "", 0, ["git", "diff"])
        assert "more hunks in this file elided" in result.text

    def test_remote_drops_progress(self):
        text = (
            "remote: Counting objects: 1000\n"
            "remote: Compressing objects: 500\n"
            "Receiving objects: 100%\n"
            "From github.com:foo/bar\n"
            "   abc123..def456  main -> origin/main\n"
        )
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "fetch"])
        assert "Counting objects" not in result.text
        assert "abc123..def456" in result.text


# ---------------------------------------------------------------------------
# Make filter
# ---------------------------------------------------------------------------


class TestMakeFilter:
    def test_drops_recursion_markers(self):
        text = (
            "make[1]: Entering directory '/build/foo'\n"
            "make[1]: Leaving directory '/build/foo'\n"
            "make: *** [Makefile:5: target] Error 1\n"
        )
        f = bc.MakeFilter()
        result = f.apply(text, "", 1, ["make"])
        assert "Entering directory" not in result.text
        assert "Error 1" in result.text


# ---------------------------------------------------------------------------
# Terraform filter
# ---------------------------------------------------------------------------


class TestTerraformFilter:
    def test_drops_refresh_lines(self):
        text = "\n".join([
            f"aws_instance.web[{i}]: Refreshing state... [id=i-abc{i}]" for i in range(20)
        ]) + "\nPlan: 1 to add, 2 to change, 0 to destroy.\n"
        f = bc.TerraformFilter()
        result = f.apply(text, "", 0, ["terraform", "plan"])
        assert "Refreshing state" not in result.text
        assert "Plan: 1 to add" in result.text


# ---------------------------------------------------------------------------
# Pip filter
# ---------------------------------------------------------------------------


class TestPipFilter:
    def test_drops_download_progress(self):
        text = (
            "Collecting numpy\n"
            "  Downloading numpy-1.0.0.whl (10 MB)\n"
            "  Downloading numpy-1.0.0.whl (10 MB)\n"
            "Installing collected packages: numpy\n"
            "Successfully installed numpy-1.0.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "numpy"])
        assert "Downloading numpy" not in result.text
        assert "Successfully installed numpy" in result.text


# ---------------------------------------------------------------------------
# Grep filter
# ---------------------------------------------------------------------------


def _make_grep_output(n_files: int, matches_per_file: int) -> str:
    """Build a synthetic grep-style output with ``n_files`` files."""
    lines = []
    for i in range(n_files):
        for j in range(matches_per_file):
            lines.append(f"src/module_{i}.py:{j + 1}:    some_pattern_here()")
    return "\n".join(lines)


class TestGrepFilter:
    def test_large_output_compressed(self):
        """Output with >30 non-empty lines is compressed to a summary."""
        text = _make_grep_output(n_files=5, matches_per_file=10)  # 50 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "some_pattern"])
        assert "grep:" in result.text
        assert "matches across" in result.text
        # Original match lines should NOT be present
        assert "some_pattern_here" not in result.text

    def test_small_output_passes_through(self):
        """Output with ≤30 non-empty lines is returned unchanged."""
        text = _make_grep_output(n_files=3, matches_per_file=5)  # 15 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "some_pattern"])
        # Original content should be preserved
        assert "some_pattern_here" in result.text
        # No summary header
        assert "matches across" not in result.text

    def test_exit_code_preserved_found(self):
        """Exit code 0 (match found) is preserved through compression."""
        text = _make_grep_output(n_files=5, matches_per_file=10)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "-r", "pattern"])
        assert result.exit_code == 0

    def test_exit_code_preserved_not_found(self):
        """Exit code 1 (no match) is preserved through compression."""
        text = ""  # empty output = no matches
        f = bc.GrepFilter()
        result = f.apply(text, "", 1, ["grep", "-r", "pattern"])
        assert result.exit_code == 1

    def test_per_file_line_counts(self):
        """Summary lists files with correct match counts."""
        # 4 matches in file0, 3 in file1, 3 in file2 → total 10 matches per group
        lines = []
        for _ in range(4):
            lines.append("src/alpha.py:1:hit")
        for _ in range(3):
            lines.append("src/beta.py:1:hit")
        # Pad to >30 lines with a third file
        for i in range(30):
            lines.append(f"src/gamma.py:{i}:hit")
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "src/alpha.py: 4 match(es)" in result.text
        assert "src/beta.py: 3 match(es)" in result.text
        assert "src/gamma.py: 30 match(es)" in result.text

    def test_sorted_by_count_descending(self):
        """Files are listed highest-count first."""
        lines = []
        for _ in range(2):
            lines.append("src/rare.py:1:hit")
        for _ in range(20):
            lines.append("src/common.py:1:hit")
        # Pad to >30
        for i in range(15):
            lines.append(f"src/mid_{i}.py:1:hit")
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["ag", "hit"])
        # common.py should appear before rare.py
        common_pos = result.text.find("src/common.py")
        rare_pos = result.text.find("src/rare.py")
        assert common_pos < rare_pos

    def test_git_grep_matched(self):
        """GrepFilter matches 'git grep' argv."""
        f = bc.GrepFilter()
        assert f.matches(["git", "grep", "pattern"])

    def test_git_grep_not_matched_other_subcommand(self):
        """GrepFilter does NOT match other git subcommands (those go to GitFilter)."""
        f = bc.GrepFilter()
        assert not f.matches(["git", "log"])
        assert not f.matches(["git", "status"])
        assert not f.matches(["git", "diff"])

    def test_rg_matched(self):
        """GrepFilter matches 'rg' argv."""
        f = bc.GrepFilter()
        assert f.matches(["rg", "pattern", "src/"])

    def test_plain_grep_r_matched(self):
        """GrepFilter matches 'grep -r' argv."""
        f = bc.GrepFilter()
        assert f.matches(["grep", "-r", "pattern", "."])

    def test_ag_matched(self):
        """GrepFilter matches 'ag' argv."""
        f = bc.GrepFilter()
        assert f.matches(["ag", "pattern"])

    def test_ack_matched(self):
        """GrepFilter matches 'ack' argv."""
        f = bc.GrepFilter()
        assert f.matches(["ack", "pattern"])

    def test_top_20_files_limit(self):
        """When >20 files match, only top 20 are shown with an elision note."""
        lines = []
        for i in range(25):
            # Each file gets 2 matches; pad to >30 total lines
            lines.append(f"src/file_{i:02d}.py:1:hit")
            lines.append(f"src/file_{i:02d}.py:2:hit")
        text = "\n".join(lines)  # 50 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "+5 more file(s) elided" in result.text

    def test_git_grep_large_compressed(self):
        """'git grep' output above threshold is compressed."""
        lines = [f"src/file_{i}.py:1:matched" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["git", "grep", "matched"])
        assert "grep:" in result.text
        assert "matches across" in result.text

    def test_select_filter_returns_grep_for_rg(self):
        """select_filter dispatches 'rg' to GrepFilter."""
        f = bc.select_filter(["rg", "pattern", "src/"])
        assert f is not None
        assert f.name == "grep"

    def test_select_filter_returns_grep_for_grep(self):
        """select_filter dispatches 'grep' to GrepFilter."""
        f = bc.select_filter(["grep", "-r", "pattern", "."])
        assert f is not None
        assert f.name == "grep"

    def test_select_filter_git_still_dispatches_git_log(self):
        """Git log is still handled by GitFilter, not GrepFilter."""
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name == "git"

    def test_boundary_exactly_30_lines(self):
        """Exactly 30 non-empty lines: pass-through (not compressed)."""
        lines = [f"src/f.py:{i}:hit" for i in range(30)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "matches across" not in result.text

    def test_boundary_31_lines(self):
        """31 non-empty lines: compressed."""
        lines = [f"src/f.py:{i}:hit" for i in range(31)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "matches across" in result.text

    def test_bare_word_before_colon_not_treated_as_filename(self):
        """Lines like 'INFO: message' should not be counted as filename matches."""
        # Build output that is above the threshold so compression fires.
        lines = [f"INFO: some log message {i}" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "message"])
        # The 40 lines should all be unattributed, not attributed to "INFO".
        assert "INFO" not in result.text or "unattributed" in result.text

    def test_path_with_dot_counted_as_filename(self):
        """Lines like 'setup.py:10:match' should be attributed to 'setup.py'."""
        lines = [f"setup.py:{i}:match" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "match"])
        assert "setup.py" in result.text


class TestDedupeNumericRuns:
    """Tests for dedupe_numeric_runs."""

    def test_collapses_counter_sequence(self):
        """Lines differing only in a counter should be collapsed."""
        lines = [f"Downloading package {i}/50 (foo)" for i in range(1, 21)]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert len(result) == 1
        assert "20 similar lines" in result[0]
        assert "Downloading package 1/50" in result[0]

    def test_short_run_passes_through(self):
        """Runs shorter than min_run should not be collapsed."""
        lines = ["Downloading 1/5", "Downloading 2/5"]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert result == lines

    def test_non_numeric_diff_not_collapsed(self):
        """Lines that differ in non-numeric content should not be collapsed."""
        lines = ["alpha line", "beta line", "gamma line"]
        result = bc.dedupe_numeric_runs(lines, min_run=2)
        assert result == lines

    def test_error_lines_never_collapsed(self):
        """Lines matching the error signal should never be collapsed even in a run."""
        lines = [f"error: type mismatch at line {i}" for i in range(10)]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        # All 10 lines must be preserved because each matches _ERROR_SIGNAL_RE.
        assert len(result) == 10

    def test_mixed_run_splits_correctly(self):
        """A run followed by a different template produces two separate groups."""
        lines = (
            [f"Downloading {i}/10" for i in range(1, 6)]
            + [f"Installing pkg-{i}" for i in range(1, 6)]
        )
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert len(result) == 2
        assert "5 similar lines" in result[0]
        assert "5 similar lines" in result[1]

    def test_empty_input(self):
        assert bc.dedupe_numeric_runs([]) == []

    def test_single_line(self):
        assert bc.dedupe_numeric_runs(["only line"]) == ["only line"]


class TestMypyFilter:
    """Tests for MypyFilter."""

    def _make_mypy_output(
        self,
        *,
        n_errors: int = 5,
        unique_messages: int = 2,
        include_summary: bool = True,
        include_notes: bool = False,
        include_see_also: bool = False,
    ) -> str:
        """Build synthetic mypy output."""
        lines: list[str] = []
        messages = [f"Incompatible type {i}" for i in range(unique_messages)]
        for i in range(n_errors):
            msg = messages[i % unique_messages]
            lines.append(f"src/foo.py:{i + 1}: error: {msg}  [assignment]")
        if include_notes:
            for i in range(4):
                lines.append(f"src/foo.py:{i + 1}: note: Revealed type is 'int'")
        if include_see_also:
            lines.append(
                "src/foo.py:1: note: See https://mypy.readthedocs.io/en/stable/error_codes.html"
            )
        if include_summary:
            lines.append(f"Found {n_errors} errors in 1 file (checked 3 source files)")
        return "\n".join(lines)

    def test_select_filter_dispatches_mypy(self):
        f = bc.select_filter(["mypy", "src/"])
        assert f is not None and f.name == "mypy"

    def test_dmypy_dispatches_to_mypy_filter(self):
        f = bc.select_filter(["dmypy", "run", "--", "src/"])
        assert f is not None and f.name == "mypy"

    def test_summary_line_always_kept(self):
        text = self._make_mypy_output(n_errors=100, unique_messages=1)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "Found 100 errors" in result.text

    def test_duplicate_errors_deduplicated(self):
        """When the same error message fires many times, only 3 are kept."""
        # 20 errors all with the same message.
        text = self._make_mypy_output(n_errors=20, unique_messages=1)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        # Exactly 3 error lines + summary + dedup note.
        error_lines = [ln for ln in result.text.split("\n") if "error:" in ln and "src/foo.py" in ln]
        assert len(error_lines) == 3
        assert "suppressed" in result.text

    def test_diverse_errors_all_kept(self):
        """When every error has a unique message, all are kept."""
        n = 6
        text = self._make_mypy_output(n_errors=n, unique_messages=n)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        error_lines = [ln for ln in result.text.split("\n") if "error:" in ln and "src/foo.py" in ln]
        assert len(error_lines) == n

    def test_see_also_notes_dropped(self):
        """'See https://…' note lines should be dropped."""
        text = self._make_mypy_output(include_see_also=True, include_notes=False)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "mypy.readthedocs.io" not in result.text

    def test_duplicate_notes_deduplicated(self):
        """Note lines with the same message are deduplicated (keep first 3)."""
        # 4 identical note lines.
        text = self._make_mypy_output(n_errors=1, include_notes=True)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        note_lines = [ln for ln in result.text.split("\n") if " note:" in ln and "src/foo.py" in ln]
        assert len(note_lines) <= 3

    def test_success_output_passes_through(self):
        """'Success: no issues found' should survive unchanged."""
        text = "Success: no issues found in 3 source files"
        f = bc.MypyFilter()
        result = f.apply(text, "", 0, ["mypy", "src/"])
        assert "Success" in result.text

    def test_errors_prevented_further_checking_dropped(self):
        """'(errors prevented further checking)' annotations should be dropped."""
        lines = [
            "src/foo.py:1: error: (errors prevented further checking)",
            "Found 1 error in 1 file (checked 3 source files)",
        ]
        text = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "errors prevented further checking" not in result.text
