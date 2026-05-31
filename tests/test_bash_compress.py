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

    def test_removes_osc_st_terminated(self):
        # OSC with ST (ESC \) terminator — used by hyperlink sequences
        text = "\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\after"
        assert bc.strip_ansi(text) == "clickafter"

    def test_removes_dcs_sequence(self):
        # DCS string terminated by ST — used by tmux passthrough, sixel, etc.
        text = "before\x1bPsomedata\x1b\\after"
        assert bc.strip_ansi(text) == "beforeafter"

    def test_is_same_function_as_render_ansi(self):
        # bc.strip_ansi must be the same object as render.ansi.strip_ansi
        from token_goat.render.ansi import strip_ansi as render_strip
        assert bc.strip_ansi is render_strip


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
        assert f is not None and f.name == "pnpm"

    def test_docker_build(self):
        f = bc.select_filter(["docker", "build", "-t", "x", "."])
        assert f is not None and f.name == "docker"

    def test_kubectl_get(self):
        f = bc.select_filter(["kubectl", "get", "pods"])
        assert f is not None and f.name == "kubectl"

    def test_git(self):
        # git status is now handled by GitStatusVerboseFilter (higher-fidelity)
        f = bc.select_filter(["git", "status"])
        assert f is not None and f.name in ("git", "git-status")

    def test_cargo(self):
        f = bc.select_filter(["cargo", "build"])
        assert f is not None and f.name == "cargo"

    def test_ruff(self):
        f = bc.select_filter(["ruff", "check", "src/"])
        assert f is not None and f.name == "ruff"

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
        # AwsCliFilter is registered before AwsFilter, so it wins dispatch.
        f = bc.select_filter(["aws", "s3", "ls"])
        assert f is not None and f.name == "aws-cli"

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

    def test_strips_banner_lines(self):
        """Banner lines (platform, cachedir, rootdir, plugins, configfile) are stripped."""
        text = (
            "platform linux -- Python 3.12.0, pytest-8.1.0\n"
            "cachedir: /tmp/pytest-cache\n"
            "rootdir: /home/user/project\n"
            "configfile: pyproject.toml\n"
            "plugins: xdist-3.5.0, cov-5.0.0\n"
            "= test session starts =\n"
            "collected 5 items\n"
            "FAILED tests/test_x.py::test_one\n"
            "= 1 failed, 4 passed in 0.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        assert "platform linux" not in result.text
        assert "cachedir:" not in result.text
        assert "rootdir:" not in result.text
        assert "configfile:" not in result.text
        assert "plugins:" not in result.text
        # Real signal must survive.
        assert "FAILED tests/test_x.py::test_one" in result.text
        assert "1 failed, 4 passed" in result.text


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
    def test_get_truncates_long_table(self):
        """Test kubectl get with many rows."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "get", "pods"])
        assert "NAME READY STATUS" in result.text
        assert "more rows" in result.text
        # Should preserve header + first 10 rows
        assert "pod-0" in result.text
        assert "pod-9" in result.text

    def test_get_keeps_short_table(self):
        """Test kubectl get with few rows (no truncation)."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(5)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "get", "pods"])
        # No truncation marker for short output
        assert "more rows" not in result.text
        assert result.text == text

    def test_top_truncates_long_table(self):
        """Test kubectl top (also uses table compression)."""
        rows = ["NAME CPU(cores) MEMORY(bytes)"] + [
            f"pod-{i} 100m 256Mi" for i in range(30)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "top", "pods"])
        assert "more rows" in result.text
        assert "NAME CPU" in result.text

    def test_describe_extracts_key_fields(self):
        """Test kubectl describe extracts Name/Namespace/Status."""
        text = (
            "Name:         my-pod\n"
            "Namespace:    default\n"
            "Status:       Running\n"
            "State:        Running\n"
            "Some other field: value\n"
            "Another field: data\n"
        )
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "describe", "pod", "my-pod"])
        assert "Name:         my-pod" in result.text
        assert "Namespace:    default" in result.text
        assert "Status:       Running" in result.text
        # Non-key fields should be dropped
        assert "Some other field" not in result.text

    def test_describe_preserves_events(self):
        """Test kubectl describe preserves Events section."""
        text = (
            "Name:         my-pod\n"
            "Namespace:    default\n"
            "Events:\n"
            "  Type    Reason   Age  From  Message\n"
            "  ----    ------   ---  ----  -------\n"
        )
        # Add 15 event lines
        text += "\n".join(
            [f"  Normal  Created  {i}s  ...  Event {i}" for i in range(15)]
        )
        text += "\n"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "describe", "pod", "my-pod"])
        assert "Events:" in result.text
        assert "earlier events elided" in result.text
        # Should keep last 10 events
        assert "Event 14" in result.text or "Event 13" in result.text

    def test_logs_compresses_large_output(self):
        """Test kubectl logs with head+tail compression."""
        lines = [f"Line {i}: log message" for i in range(100)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # Should use head=30, tail=20 when > 50 lines
        assert "log lines elided" in result.text
        assert "Line 0" in result.text
        assert "Line 99" in result.text

    def test_logs_keeps_short_output(self):
        """Test kubectl logs with few lines (no compression)."""
        lines = [f"Line {i}: log message" for i in range(10)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # No compression for short output
        assert "elided" not in result.text
        assert result.text == text

    def test_apply_passes_through(self):
        """Test kubectl apply (usually short, pass through)."""
        text = "pod/my-pod created"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "apply", "-f", "manifest.yaml"])
        assert result.text == text

    def test_delete_passes_through(self):
        """Test kubectl delete (usually short, pass through)."""
        text = "pod/my-pod deleted"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "delete", "pod", "my-pod"])
        assert result.text == text

    def test_diff_truncates_large_diff(self):
        """Test kubectl diff truncates large diffs to first 50 lines."""
        lines = [f"diff line {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "diff", "-f", "manifest.yaml"])
        assert "diff lines" in result.text
        assert "diff line 0" in result.text

    def test_error_preserves_stderr(self):
        """Test that errors preserve all stderr."""
        stdout_text = "Some output"
        stderr_text = "Error: something failed"
        f = bc.KubectlFilter()
        result = f.apply(
            stdout_text, stderr_text, 1, ["kubectl", "get", "pods"]
        )
        assert "Error: something failed" in result.text
        assert "---" in result.text  # Separator between stdout and stderr

    def test_k_alias_works(self):
        """Test kubectl alias 'k' is recognized."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["k", "get", "pods"])
        assert "more rows" in result.text

    def test_k9s_alias_works(self):
        """Test k9s alias is recognized."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["k9s", "get", "pods"])
        assert "more rows" in result.text


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
        # ruff is now handled by RuffFilter; verify RuffFilter collapses repeated
        # violations across multiple files into a summary line.
        lines = [f"src/mod_{i}.py:1:1: F401 imported but unused" for i in range(20)]
        text = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(text, "", 1, ["ruff", "check"])
        f401_lines = [ln for ln in result.text.splitlines() if "F401" in ln]
        assert len(f401_lines) == 1
        assert "20 occurrences" in f401_lines[0]

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
    """Tests for TerraformFilter."""

    def test_drops_refresh_lines(self) -> None:
        """Basic test: terraform plan drops refresh lines but keeps the Plan: summary."""
        text = "\n".join([
            f"aws_instance.web[{i}]: Refreshing state... [id=i-abc{i}]" for i in range(20)
        ]) + "\nPlan: 1 to add, 2 to change, 0 to destroy.\n"
        f = bc.TerraformFilter()
        result = f.apply(text, "", 0, ["terraform", "plan"])
        assert "Refreshing state" not in result.text
        assert "Plan: 1 to add" in result.text

    def test_terraform_plan_keeps_summary_line(self) -> None:
        """terraform plan drops refresh lines but keeps the Plan: summary."""
        stdout = (
            "aws_instance.example: Refreshing state… [id=i-1234]\n"
            "aws_instance.other: Refreshing state… [id=i-5678]\n"
            "Plan: 2 to add, 1 to change, 0 to destroy.\n"
            "# aws_instance.new will be created\n"
            "  + resource {\n"
            "      + id = (known after apply)\n"
            "    }\n"
        )
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        # Summary must be kept.
        assert "Plan: 2 to add, 1 to change, 0 to destroy" in text
        # Refresh lines should be dropped.
        assert "Refreshing state" not in text
        # Compressed size should be much smaller.
        assert result.compressed_bytes < len(stdout.encode())

    def test_terraform_plan_last_20_lines_kept(self) -> None:
        """terraform plan keeps the plan summary + last 20 lines of detailed diff."""
        lines = [
            "aws_instance.ex: Refreshing state… [id=i-1]",
            "Plan: 1 to add, 0 to change, 0 to destroy.",
            "# aws_instance.new will be created",
        ]
        # Add 50 more lines of plan diff.
        for i in range(50):
            lines.append(f"  line_{i:03d} = {i}")
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        # Plan summary should be present.
        assert "Plan: 1 to add" in text
        # Output should be much smaller (only ~20 tail lines + summary).
        assert result.compressed_bytes < len(stdout.encode())

    def test_terraform_apply_keeps_completion_line(self) -> None:
        """terraform apply keeps the 'Apply complete!' summary line."""
        stdout = (
            "aws_instance.example: Refreshing state… [id=i-1234]\n"
            "aws_instance.new: Creating…\n"
            "aws_instance.new: Creation complete after 5s\n"
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n"
        )
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        text = result.text
        # Completion summary must be kept.
        assert "Apply complete! Resources:" in text
        # Refresh lines should be dropped.
        assert "Refreshing state" not in text

    def test_terraform_apply_preserves_errors(self) -> None:
        """terraform apply preserves stderr on error (exit_code != 0)."""
        stdout = "aws_instance.example: Refreshing state…\n"
        stderr = "Error: Resource creation failed\nDetails: Invalid configuration\n"
        f = bc.TerraformFilter()
        result = f.apply(stdout, stderr, 1, ["terraform", "apply"])
        text = result.text
        # Stderr must be preserved on error.
        assert "Error: Resource creation failed" in text
        assert "Invalid configuration" in text

    def test_terraform_init_head_tail_compression(self) -> None:
        """terraform init uses head=5, tail=5 compression for progress bars."""
        lines = ["Initializing…"] + [f"Installing plugin {i}" for i in range(20)] + ["Init complete!"]
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "init"])
        text = result.text
        # Should compress to head + tail (5+5), not all 22 lines.
        assert len(text.split("\n")) <= 12  # head + marker + tail + blanks.
        # But must include some init info.
        assert "Initializing" in text or "Installing" in text or "complete" in text

    def test_terraform_validate_passthrough(self) -> None:
        """terraform validate passes through (usually short; no compression)."""
        stdout = "Valid!\nNo issues found.\n"
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "validate"])
        text = result.text
        # Should be passed through unchanged (or nearly so).
        assert "Valid!" in text
        assert "No issues found" in text

    def test_terraform_show_head_tail(self) -> None:
        """terraform show uses head=20, tail=10 compression for large state output."""
        lines = ["# Resource state"] + [f"resource.line_{i}" for i in range(100)] + ["# End of state"]
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "show"])
        text = result.text
        # Should compress to ~30 lines (head + tail).
        assert len(text.split("\n")) <= 35
        assert "Resource state" in text or "resource.line_" in text

    def test_matches_terraform_binaries(self) -> None:
        """TerraformFilter matches terraform, tofu, terragrunt."""
        f = bc.TerraformFilter()
        assert f.matches(["terraform", "plan"])
        assert f.matches(["tofu", "apply"])
        assert f.matches(["terragrunt", "run-all", "plan"])
        assert not f.matches(["ansible", "playbook.yml"])

    def test_select_filter_returns_terraform_filter(self) -> None:
        """select_filter dispatches terraform to TerraformFilter."""
        f = bc.select_filter(["terraform", "plan"])
        assert isinstance(f, bc.TerraformFilter)

    def test_terraform_empty_input(self) -> None:
        """TerraformFilter handles empty input without crashing."""
        f = bc.TerraformFilter()
        result = f.apply("", "", 0, ["terraform", "plan"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# AnsibleFilter — comprehensive tests
# ---------------------------------------------------------------------------


class TestAnsibleFilter:
    """Tests for AnsibleFilter."""

    def test_ansible_playbook_collapses_status_lines(self) -> None:
        """ansible-playbook collapses ok/changed/skipping counts per task."""
        stdout = (
            "PLAY [Install packages]\n"
            "TASK [apt-get update]\n"
            "ok: [host1]\n"
            "ok: [host2]\n"
            "ok: [host3]\n"
            "changed: [host4]\n"
            "changed: [host5]\n"
            "TASK [Install nginx]\n"
            "ok: [host1]\n"
            "ok: [host2]\n"
            "skipped: [host3]\n"
            "PLAY RECAP\n"
            "host1: ok=2, changed=0, unreachable=0, failed=0\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # Headers and recap must be present.
        assert "PLAY [Install packages]" in text
        assert "TASK [apt-get update]" in text
        assert "PLAY RECAP" in text
        # Status lines should be collapsed, not literal ok/changed/skipping lines.
        assert text.count("\nok:") == 0  # Raw ok: lines should be gone.
        # But we should have collapsed counts.
        assert "token-goat:" in text

    def test_ansible_playbook_keeps_failure_blocks(self) -> None:
        """ansible-playbook preserves fatal/failed/unreachable lines and payloads."""
        stdout = (
            "TASK [Might fail]\n"
            "ok: [host1]\n"
            "fatal: [host2]: FAILED! => {\n"
            '    "msg": "Something went wrong",\n'
            '    "error": "Connection refused"\n'
            "}\n"
            "PLAY RECAP\n"
            "host1: ok=1, changed=0, failed=1\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # Failure line and its JSON payload must be present.
        assert "fatal: [host2]" in text
        assert "Something went wrong" in text or "Connection refused" in text
        # PLAY RECAP must be present.
        assert "PLAY RECAP" in text

    def test_ansible_playbook_keeps_recap(self) -> None:
        """ansible-playbook always preserves the PLAY RECAP section."""
        stdout = (
            "PLAY [test]\n"
            "TASK [task1]\n"
            "ok: [host1]\n"
            "PLAY RECAP\n"
            "host1: ok=1, changed=0, unreachable=0, failed=0\n"
            "host2: ok=0, changed=0, unreachable=1, failed=0\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # PLAY RECAP block must be intact.
        assert "PLAY RECAP" in text
        assert "host1: ok=1" in text
        assert "host2: ok=0, changed=0, unreachable=1" in text

    def test_ansible_galaxy_install_head_tail(self) -> None:
        """ansible-galaxy install uses head=5, tail=5 compression for package lists."""
        lines = ["Starting galaxy install"] + [f"Installing package_{i}" for i in range(30)] + ["Galaxy install complete"]
        stdout = "\n".join(lines)
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-galaxy", "install", "-r", "requirements.yml"])
        text = result.text
        # Should compress to head + tail (5+5 = 10 lines max).
        non_blank = [ln for ln in text.split("\n") if ln.strip()]
        assert len(non_blank) <= 12
        # But must include some info.
        assert "Installing" in text or "complete" in text

    def test_ansible_lint_groups_by_rule(self) -> None:
        """ansible-lint groups violations by rule and keeps first 3 examples."""
        stdout = (
            "playbooks/site.yml:10:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:20:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:30:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:40:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:50:1: line-too-long: line too long (line-too-long)\n"
            "playbooks/site.yml:60:1: line-too-long: line too long (line-too-long)\n"
            "Linting failed.\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "playbooks/"])
        text = result.text
        # Should have the first 3 yaml-indent lines.
        yaml_lines = [ln for ln in text.split("\n") if "yaml-indent" in ln]
        assert len(yaml_lines) >= 1
        # Should note that some were elided.
        if "yaml-indent" in text and "elided" in text:
            assert "more occurrences" in text

    def test_matches_ansible_binaries(self) -> None:
        """AnsibleFilter matches ansible, ansible-playbook, ansible-galaxy, ansible-lint."""
        f = bc.AnsibleFilter()
        assert f.matches(["ansible", "all", "-m", "ping"])
        assert f.matches(["ansible-playbook", "site.yml"])
        assert f.matches(["ansible-galaxy", "install", "-r", "requirements.yml"])
        assert f.matches(["ansible-lint", "playbooks/"])
        assert not f.matches(["terraform", "plan"])

    def test_select_filter_returns_ansible_filter(self) -> None:
        """select_filter dispatches ansible to AnsibleFilter."""
        f = bc.select_filter(["ansible-playbook", "site.yml"])
        assert isinstance(f, bc.AnsibleFilter)

    def test_ansible_playbook_empty_input(self) -> None:
        """AnsibleFilter handles empty input without crashing."""
        f = bc.AnsibleFilter()
        result = f.apply("", "", 0, ["ansible-playbook", "site.yml"])
        assert isinstance(result.text, str)

    def test_ansible_playbook_compression_reduces_size(self) -> None:
        """AnsibleFilter substantially reduces size of large playbook output."""
        lines = ["PLAY [test]", "TASK [loop]"]
        # Add 100 ok/changed lines.
        for i in range(100):
            lines.append(f"ok: [host-{i % 10}]")
        lines.append("PLAY RECAP\nhost-0: ok=10\n")
        stdout = "\n".join(lines)
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        # Compressed output should be much smaller.
        assert result.compressed_bytes < len(stdout.encode()) * 0.5


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
        """Git log is handled by GitLogFilter (or GitFilter as fallback), not GrepFilter."""
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name in ("git", "git-log")

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


# ---------------------------------------------------------------------------
# UvFilter
# ---------------------------------------------------------------------------


def _make_uv_sync_output(n_packages: int = 10) -> str:
    """Build synthetic ``uv sync`` output."""
    lines = ["Resolved 42 packages in 0.12s"]
    for i in range(n_packages):
        lines.append(f"   Downloading package-{i}-1.0.0-py3-none-any.whl (1.2 MB)")
    lines.append("   Fetching wheel metadata for pip (23.3.1)")
    for i in range(n_packages):
        lines.append(f"   + package-{i}==1.0.0")
    lines.append(f"Installed {n_packages} packages in 0.45s")
    return "\n".join(lines)


class TestPythonFilter:
    """Tests for PythonFilter."""

    def _make_traceback(self, n_frames: int = 3, include_error: bool = True) -> str:
        """Build synthetic Python traceback output."""
        lines = ["Traceback (most recent call last):"]
        for i in range(n_frames):
            lines.append(f'  File "script.py", line {i + 1}, in func_{i}')
            lines.append(f"    result = func_{i + 1}()")
        if include_error:
            lines.append("ValueError: invalid value")
        return "\n".join(lines)

    def test_traceback_compressed(self):
        """Short traceback with 3 frames → only innermost frame + error kept."""
        text = self._make_traceback(n_frames=3)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "script.py"])
        # Should keep traceback header, innermost frame, and error.
        assert "Traceback" in result.text
        assert "ValueError: invalid value" in result.text
        # The innermost frame (line with "func_2") should be kept.
        assert "func_2" in result.text
        # But earlier frames should be dropped (func_0).
        assert "func_0" not in result.text

    def test_long_traceback_omission_marker(self):
        """12+ frames → first 2 + last 3 kept, '... N frames omitted ...' inserted."""
        text = self._make_traceback(n_frames=12)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "script.py"])
        # Should contain omission marker.
        assert "frames omitted" in result.text
        # Should keep first 2 frames.
        assert "func_0" in result.text
        assert "func_1" in result.text
        # Should keep last 3 frames.
        assert "func_9" in result.text or "func_10" in result.text or "func_11" in result.text
        # Middle frames should not appear.
        assert "func_5" not in result.text

    def test_repeated_lines_collapsed(self):
        """6 identical consecutive lines → collapsed to 'line × 6'."""
        # Build output with repeated lines after the error
        # (which will survive the traceback compression).
        text = "Traceback (most recent call last):\n"
        text += '  File "test.py", line 1, in func\n'
        text += "    x = 1\n"
        text += "ValueError: error\n"
        text += ("repeated output\n" * 6)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "test.py"])
        # Should collapse the 6 identical repeated lines to "line × 6".
        assert "(×6)" in result.text

    def test_warnings_summarized(self):
        """5+ identical warnings → collapsed to 'line × N' via _dedupe_repeated_lines."""
        # When warnings are repeated 5+ times consecutively, they're collapsed.
        lines = (
            ["Some output"]
            + ["DeprecationWarning: old api used"] * 5
            + ["Done"]
        )
        text = "\n".join(lines)
        f = bc.PythonFilter()
        result = f.apply(text, "", 0, ["python", "test.py"])
        # The repeated warnings should be collapsed to the "× N" format.
        assert "(×5)" in result.text

    def test_pytest_not_matched(self):
        """Command 'python -m pytest' should NOT be matched by PythonFilter."""
        f = bc.PythonFilter()
        assert not f.matches(["python", "-m", "pytest"])

    def test_plain_python_matched(self):
        """Command 'python script.py' IS matched by PythonFilter."""
        f = bc.PythonFilter()
        assert f.matches(["python", "script.py"])

    def test_python3_matched(self):
        """Command 'python3' with any args IS matched."""
        f = bc.PythonFilter()
        assert f.matches(["python3", "-c", "print('hello')"])

    def test_clean_output_passthrough(self):
        """Non-traceback output passes through unchanged."""
        text = "Hello\nWorld\nSuccess\n"
        f = bc.PythonFilter()
        result = f.apply(text, "", 0, ["python", "script.py"])
        # No traceback, so output should pass through with minimal changes.
        assert "Hello" in result.text
        assert "World" in result.text

    def test_select_filter_dispatches_python(self):
        """select_filter returns PythonFilter for 'python script.py'."""
        f = bc.select_filter(["python", "script.py"])
        assert f is not None
        assert f.name == "python"

    def test_select_filter_python3_dispatches(self):
        """select_filter returns PythonFilter for 'python3' commands."""
        f = bc.select_filter(["python3", "myscript.py"])
        assert f is not None
        assert f.name == "python"

    def test_select_filter_pytest_via_python_returns_pytest(self):
        """select_filter returns PytestFilter for 'python -m pytest', not PythonFilter."""
        f = bc.select_filter(["python", "-m", "pytest"])
        assert f is not None
        assert f.name == "pytest"


class TestUvFilter:
    def test_matches_uv_sync(self):
        """UvFilter matches 'uv sync' argv."""
        f = bc.UvFilter()
        assert f.matches(["uv", "sync"])

    def test_matches_uv_add(self):
        """UvFilter matches 'uv add <pkg>' argv."""
        f = bc.UvFilter()
        assert f.matches(["uv", "add", "requests"])

    def test_matches_uv_remove(self):
        """UvFilter matches 'uv remove <pkg>' argv."""
        f = bc.UvFilter()
        assert f.matches(["uv", "remove", "requests"])

    def test_matches_uv_pip_install(self):
        """UvFilter matches 'uv pip install <pkg>' argv."""
        f = bc.UvFilter()
        assert f.matches(["uv", "pip", "install", "numpy"])

    def test_matches_uv_lock(self):
        """UvFilter matches 'uv lock' argv."""
        f = bc.UvFilter()
        assert f.matches(["uv", "lock"])

    def test_does_not_match_uv_run(self):
        """UvFilter does not match 'uv run' — not a package management command."""
        f = bc.UvFilter()
        assert not f.matches(["uv", "run", "pytest"])

    def test_does_not_match_uv_tool(self):
        """UvFilter does not match 'uv tool run' — not a package management command."""
        f = bc.UvFilter()
        assert not f.matches(["uv", "tool", "run", "ruff"])

    def test_does_not_match_pip(self):
        """UvFilter does not match plain 'pip' — that goes to PipFilter."""
        f = bc.UvFilter()
        assert not f.matches(["pip", "install", "numpy"])

    def test_drops_downloading_lines(self):
        """Downloading progress lines are dropped from output; only the elision note remains."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # Original "Downloading foo.whl (X MB)" lines must be gone.
        # The elision note contains "Downloading" as a word — check no
        # per-package download lines survived by scanning for the whl pattern.
        assert ".whl" not in result.text
        assert "Fetching wheel metadata" not in result.text

    def test_drops_diff_lines(self):
        """Per-package +/- diff lines are dropped from output."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # The "+  package-0==1.0.0" style lines should not appear
        assert "+ package-" not in result.text

    def test_keeps_resolved_summary(self):
        """'Resolved N packages' summary line is preserved."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "Resolved 42 packages" in result.text

    def test_keeps_installed_summary(self):
        """'Installed N packages' summary line is preserved."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "Installed 5 packages" in result.text

    def test_dropping_note_included(self):
        """A note is appended stating how many progress lines were dropped."""
        text = _make_uv_sync_output(n_packages=8)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "add", "numpy"])
        # Should have both a downloads note and a diff-lines note
        assert "token-goat" in result.text
        assert "dropped" in result.text

    def test_dropping_note_merged_into_single_line(self):
        """When both download and diff lines are dropped, they produce a single merged note.

        Merging the two notes saves ~25-35 bytes per uv invocation where both
        download-progress and +/- diff lines are present (the common case for
        'uv sync' with any package changes).
        """
        text = _make_uv_sync_output(n_packages=4)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # Count how many [token-goat: ...] note lines are in the output.
        note_lines = [
            line for line in result.text.splitlines()
            if line.startswith("[token-goat:")
        ]
        # Both dropping reasons must appear in the output
        assert any("Downloading" in ln or "Fetching" in ln for ln in note_lines)
        assert any("+/-" in ln or "diff" in ln.lower() for ln in note_lines)
        # They should be merged into one line (not two separate [token-goat: ...] lines)
        assert len(note_lines) == 1, (
            f"Expected 1 merged note line, got {len(note_lines)}: {note_lines}"
        )

    def test_error_output_preserved(self):
        """Error lines in output survive compression."""
        lines = [
            "Resolved 5 packages in 0.05s",
            "   Downloading foo-1.0-py3-none.whl (500 kB)",
            "error: Failed to fetch https://pypi.org/simple/foo/",
            "  Caused by: Connection refused (os error 111)",
        ]
        text = "\n".join(lines)
        f = bc.UvFilter()
        result = f.apply(text, "", 1, ["uv", "sync"])
        assert "error: Failed to fetch" in result.text
        assert "Connection refused" in result.text

    def test_select_filter_dispatches_uv_sync(self):
        """select_filter returns UvFilter for 'uv sync'."""
        f = bc.select_filter(["uv", "sync"])
        assert f is not None
        assert f.name == "uv"

    def test_select_filter_dispatches_uv_add(self):
        """select_filter returns UvFilter for 'uv add numpy'."""
        f = bc.select_filter(["uv", "add", "numpy"])
        assert f is not None
        assert f.name == "uv"

    def test_select_filter_uv_run_returns_none_or_generic(self):
        """select_filter does not dispatch 'uv run pytest' to UvFilter."""
        f = bc.select_filter(["uv", "run", "pytest"])
        # Should not be the uv filter (may be None or GenericFilter)
        assert f is None or f.name != "uv"

    def test_no_progress_output_no_note(self):
        """When there are no download/diff lines, no dropping note is appended."""
        text = "Resolved 5 packages in 0.01s\nInstalled 2 packages in 0.10s"
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "dropped" not in result.text
        assert "Resolved 5 packages" in result.text
        assert "Installed 2 packages" in result.text


# ---------------------------------------------------------------------------
# bytes_to_tokens
# ---------------------------------------------------------------------------


class TestBytesToTokens:
    def test_converts_350_bytes_to_100_tokens(self):
        """350 bytes / 3.5 = 100 tokens."""
        assert bc.bytes_to_tokens(350) == 100

    def test_rounds_up(self):
        """Rounding up: 355 bytes / 3.5 = 101.43... -> 102 tokens."""
        assert bc.bytes_to_tokens(355) == 102

    def test_zero_converts_to_one(self):
        """Even 0 bytes is at least 1 token (fail-safe)."""
        assert bc.bytes_to_tokens(0) == 1

    def test_small_values(self):
        """1-3 bytes → 1 token."""
        assert bc.bytes_to_tokens(1) == 1
        assert bc.bytes_to_tokens(3) == 1

    def test_large_values(self):
        """Large byte counts scale proportionally."""
        assert bc.bytes_to_tokens(7000) == 2000


# ---------------------------------------------------------------------------
# cap_tokens
# ---------------------------------------------------------------------------


class TestCapTokens:
    def test_returns_text_unchanged_when_under_budget(self):
        """Text under token budget is unchanged."""
        text = "short text"
        result = bc.cap_tokens(text, max_tokens=1000)
        assert result == text

    def test_truncates_when_over_budget(self):
        """Text over token budget is truncated."""
        # Create text that's roughly 5000 tokens (5000 * 3.5 = 17,500 chars).
        text = "a" * 18000
        result = bc.cap_tokens(text, max_tokens=2000)
        # Result should be shorter and include the cap annotation.
        assert len(result) < len(text)
        assert "output capped at" in result
        assert "~2000 tokens" in result

    def test_preserves_newlines(self):
        """Truncation respects line boundaries when possible."""
        text = "\n".join(["line"] * 500)  # 500 lines = 2000 chars, ~570 tokens.
        result = bc.cap_tokens(text, max_tokens=300)
        # Should be truncated.
        assert len(result) < len(text)
        # Should not contain incomplete lines (no split in the middle).
        assert not result.endswith("lin") or result.endswith("\n")

    def test_marker_includes_token_count(self):
        """The truncation marker includes the token limit."""
        text = "x" * 20000  # ~5714 tokens.
        result = bc.cap_tokens(text, max_tokens=1500)
        assert "~1500 tokens" in result

    def test_empty_string(self):
        """Empty string is unchanged."""
        assert bc.cap_tokens("", max_tokens=100) == ""

    def test_single_line_over_budget(self):
        """A single very long line is still truncated."""
        text = "a" * 20000
        result = bc.cap_tokens(text, max_tokens=500)
        assert len(result) < len(text)
        assert "output capped at" in result

    def test_body_containing_bytes_elided_prefix_not_corrupted(self):
        """cap_tokens must not split on a literal '\\n... [' that appears in the body.

        Regression: cap_tokens used rsplit('\\n... [', 1) to strip cap_bytes's
        marker.  When the captured output itself contained that literal string
        (e.g. a command that prints progress like '... [3 items left]'), rsplit
        split on the first occurrence in the body rather than the terminal marker,
        silently dropping legitimate content and producing a malformed result.

        The fix uses a regex anchored to the exact bytes-elided suffix so only
        the real marker is stripped.
        """
        # Build a text body that contains the problematic literal and is large
        # enough to exceed the token budget.
        filler = "a" * 14000  # ~4000 tokens at 3.5 chars/token
        body_marker = "\n... [3 items still pending]"  # literal that looks like the real marker
        text = filler + body_marker + ("b" * 100)

        result = bc.cap_tokens(text, max_tokens=2000)

        # The token-based marker must be present.
        assert "[token-goat: output capped at ~2000 tokens]" in result, (
            "cap_tokens must append its token-based marker"
        )
        # The bytes-elided marker must NOT appear in the output.
        assert "bytes elided by token-goat" not in result, (
            "bytes-elided marker must be fully replaced by the token-based one"
        )
        # The truncation point must be inside the filler, not at the fake marker.
        # If rsplit split on the body marker, the result would end right before it
        # (at position ~14000); a correct truncation preserves filler up to ~7000
        # chars and the body_marker literal would not appear at all since it was
        # written AFTER the truncation point.
        # Simpler invariant: the result must not end right before body_marker text.
        assert "items still pending" not in result, (
            "body content written after truncation point must not appear in output; "
            "if it does, rsplit split on the body marker rather than the real suffix"
        )

    def test_ansi_codes_do_not_steal_token_budget(self):
        """ANSI escape sequences must not consume the byte budget.

        cap_tokens measures the budget against ANSI-stripped content, so
        ANSI codes in the original must not cause visible content to be
        clipped more aggressively than the stated token cap implies.
        """
        # 1000 visible 'x' characters plus heavy ANSI colouring (~500 extra bytes).
        ansi_reset = "\x1b[0m"
        ansi_red = "\x1b[31m"
        # Interleave ANSI codes to simulate coloured pytest output.
        coloured_line = ansi_red + "x" * 50 + ansi_reset
        # Repeat to get ~3500 visible chars (~1000 tokens) with ~1750 ANSI bytes on top.
        text_with_ansi = (coloured_line + "\n") * 70  # 70 * 52 = ~3640 visible chars
        clean_chars = len(bc.strip_ansi(text_with_ansi))

        # Budget covers the full visible content (no truncation expected).
        max_tokens = clean_chars // 3  # comfortably above len/3.5
        result = bc.cap_tokens(text_with_ansi, max_tokens=max_tokens)
        assert "output capped at" not in result, (
            "ANSI overhead should not cause truncation when visible content fits "
            f"within the token budget (budget={max_tokens} tokens, "
            f"visible chars={clean_chars})"
        )


# ---------------------------------------------------------------------------
# GenericFilter with cap_tokens
# ---------------------------------------------------------------------------


class TestGenericFilterCapTokens:
    def test_caps_very_large_output(self):
        """GenericFilter caps output that exceeds token budget."""
        # Create large output (10,000 identical lines = ~2M chars = ~570k tokens).
        lines = ["output line"] * 10000
        stdout = "\n".join(lines)
        f = bc.GenericFilter()
        result = f.apply(stdout, "", 0, ["some", "command"])
        # Should be capped at ~2000 tokens (~7KB).
        assert result.compressed_bytes < len(stdout.encode("utf-8"))
        # Should indicate it was capped.
        assert "output capped at" in result.text or result.text.count("\n") < 2000

    def test_caps_with_stderr(self):
        """GenericFilter caps large output even with stderr present."""
        stdout = "x" * 50000
        stderr = "error line"
        f = bc.GenericFilter()
        result = f.apply(stdout, stderr, 1, ["cmd"])
        # Should be capped (the output is much smaller than input).
        assert result.compressed_bytes < len((stdout + stderr).encode("utf-8"))
        # Should indicate it was capped.
        assert "output capped at" in result.text


# ---------------------------------------------------------------------------
# RuffFilter
# ---------------------------------------------------------------------------

def _make_ruff_stdout(
    *,
    e501_files: int = 10,
    e501_per_file: int = 5,
    extra_codes: list[str] | None = None,
) -> str:
    """Build synthetic ruff stdout with E501 violations across many files
    plus optional one-off violations for other codes."""
    lines: list[str] = []
    for f_idx in range(e501_files):
        for ln in range(1, e501_per_file + 1):
            lines.append(
                f"src/module_{f_idx}.py:{ln}:101: E501 Line too long (120 > 100)"
            )
    for code in (extra_codes or []):
        lines.append(f"src/special.py:1:1: {code} Some message for {code}")
    lines.append(f"Found {len(lines)} errors.")
    return "\n".join(lines)


class TestRuffFilter:
    """Tests for RuffFilter."""

    def test_high_frequency_rule_collapsed_to_summary(self) -> None:
        """E501 across 10 files (50 lines) collapses to one summary line."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        text = result.text
        # Only one line for E501, not 50.
        e501_lines = [ln for ln in text.splitlines() if "E501" in ln]
        assert len(e501_lines) == 1
        assert "50 occurrences" in e501_lines[0]
        assert "10 files" in e501_lines[0]
        assert "example:" in e501_lines[0]

    def test_unique_codes_preserved(self) -> None:
        """Codes with < 3 occurrences are kept verbatim."""
        extra = ["F401", "W291", "E302", "B006", "N801"]
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5, extra_codes=extra)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        text = result.text
        for code in extra:
            assert code in text, f"Expected {code} to be preserved"

    def test_footer_preserved(self) -> None:
        """'Found N errors' footer line is always kept."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        assert "Found" in result.text and "errors" in result.text

    def test_output_is_smaller_than_input(self) -> None:
        """Compressed output is substantially smaller than raw input."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        assert result.compressed_bytes < len(stdout.encode())

    def test_low_frequency_rule_not_summarised(self) -> None:
        """A rule with only 2 occurrences in 1 file is not summarised."""
        lines = [
            "src/foo.py:1:1: E711 Comparison to None",
            "src/foo.py:2:1: E711 Comparison to None",
            "Found 2 errors.",
        ]
        stdout = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff"])
        e711_lines = [ln for ln in result.text.splitlines() if "E711" in ln]
        # Both kept verbatim (2 occurrences, same file — below threshold).
        assert len(e711_lines) == 2

    def test_three_occurrences_one_file_not_summarised(self) -> None:
        """3+ occurrences but only in 1 file should not be summarised."""
        lines = [
            "src/foo.py:1:1: E501 Line too long",
            "src/foo.py:2:1: E501 Line too long",
            "src/foo.py:3:1: E501 Line too long",
            "Found 3 errors.",
        ]
        stdout = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff"])
        e501_lines = [ln for ln in result.text.splitlines() if "E501" in ln]
        # All 3 kept (same file).
        assert len(e501_lines) == 3

    def test_empty_stdout(self) -> None:
        """Empty stdout produces empty (or whitespace-only) output without error."""
        f = bc.RuffFilter()
        result = f.apply("", "", 0, ["ruff", "check"])
        assert result.text.strip() == ""

    def test_matches_ruff_binary(self) -> None:
        """RuffFilter.matches returns True for ruff and False for pytest."""
        f = bc.RuffFilter()
        assert f.matches(["ruff", "check", "src/"])
        assert not f.matches(["pytest"])

    def test_select_filter_returns_ruff_filter(self) -> None:
        """select_filter dispatches ruff commands to RuffFilter, not LinterFilter."""
        f = bc.select_filter(["ruff", "check", "src/"])
        assert isinstance(f, bc.RuffFilter)

    def test_success_banner_stripped_on_clean_run(self) -> None:
        """'All checks passed!' is suppressed when exit_code is 0 and no violations."""
        f = bc.RuffFilter()
        result = f.apply("All checks passed!", "", 0, ["ruff", "check", "src/"])
        assert result.text.strip() == ""

    def test_no_errors_found_stripped_on_clean_run(self) -> None:
        """'No errors found.' is suppressed when exit_code is 0 and no violations."""
        f = bc.RuffFilter()
        result = f.apply("No errors found.", "", 0, ["ruff", "check"])
        assert result.text.strip() == ""

    def test_success_banner_preserved_on_failure(self) -> None:
        """When exit_code is non-zero, the output (including errors) is kept."""
        stdout = "src/foo.py:1:1: E501 Line too long\nAll checks passed!"
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check"])
        assert "E501" in result.text

    def test_fix_summary_kept_on_clean_run(self) -> None:
        """'ruff check --fix' may print a fix summary alongside a success line;
        the fix summary survives, only the bare success banner is stripped."""
        stdout = "Fixed 3 errors.\nAll checks passed!"
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 0, ["ruff", "check", "--fix"])
        assert "Fixed 3 errors" in result.text


# ---------------------------------------------------------------------------
# MypyFilter — additional edge-case tests
# ---------------------------------------------------------------------------

class TestMypyFilterExtra:
    """Additional edge cases for MypyFilter not covered by existing tests."""

    def test_multiple_success_lines_deduplicated(self) -> None:
        """Multiple 'Success: no issues found' lines are all kept (MypyFilter
        passes non-diagnostic lines through unchanged; deduplication is not
        its job — but the filter must not crash on them)."""
        lines = [
            "src/a.py:1: error: Incompatible return value",
            "src/b.py:2: error: Argument missing",
            "Success: no issues found",
            "Success: no issues found",
            "Success: no issues found",
            "Success: no issues found",
            "Found 2 errors in 2 files (checked 10 source files)",
        ]
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy", "src/"])
        text = result.text
        # Error lines must be present.
        assert "Incompatible return value" in text
        assert "Argument missing" in text
        # Summary line must be present.
        assert "Found 2 errors" in text

    def test_per_file_errors_kept(self) -> None:
        """Error lines from distinct files are all kept."""
        files = [f"src/mod_{i}.py" for i in range(3)]
        lines = [f"{f}:{i + 1}: error: Some error" for i, f in enumerate(files)]
        lines.append("Found 3 errors in 3 files (checked 3 source files)")
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy"])
        for fn in files:
            assert fn in result.text

    def test_empty_stdout(self) -> None:
        """Empty stdout produces empty output without error."""
        f = bc.MypyFilter()
        result = f.apply("", "", 0, ["mypy"])
        assert result.text.strip() == ""

    def test_select_filter_returns_mypy_filter(self) -> None:
        """select_filter dispatches mypy to MypyFilter."""
        f = bc.select_filter(["mypy", "src/"])
        assert isinstance(f, bc.MypyFilter)


# ---------------------------------------------------------------------------
# Edge cases: empty stdout / binary not in FILTERS
# ---------------------------------------------------------------------------

class TestFilterDispatchEdgeCases:
    """Edge cases for filter dispatch and empty-input handling."""

    def test_unknown_binary_returns_none(self) -> None:
        """select_filter returns None for an unrecognised binary."""
        assert bc.select_filter(["unknowntool", "--flag"]) is None

    def test_empty_argv_returns_none(self) -> None:
        """select_filter returns None for empty argv."""
        assert bc.select_filter([]) is None

    def test_ruff_empty_input_no_crash(self) -> None:
        """RuffFilter.apply does not crash on empty stdout+stderr."""
        f = bc.RuffFilter()
        result = f.apply("", "", 0, ["ruff"])
        assert isinstance(result.text, str)

    def test_mypy_empty_input_no_crash(self) -> None:
        """MypyFilter.apply does not crash on empty stdout+stderr."""
        f = bc.MypyFilter()
        result = f.apply("", "", 0, ["mypy"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# Early-exit logic: skip expensive filters when normalisation alone suffices
# ---------------------------------------------------------------------------


class TestEarlyExitOnNormalisationReduction:
    """Test that filter.apply skips expensive compress() when normalisation achieves >=40% reduction."""

    def test_ansi_heavy_output_triggers_early_exit(self) -> None:
        """Large ANSI/progress output: normalisation reduces bytes by >40% → early exit."""
        # Synthesize output with lots of ANSI codes that normalisation will strip.
        # Each line has ~100 bytes of ANSI cruft, shrinking to ~20 bytes after normalise().
        ansi_lines = [
            f"\x1b[31m\x1b[1m\x1b[5m>>> {i:04d}\x1b[0m\x1b[m\x1b[m repeated text here {i}\n"
            for i in range(100)
        ]
        stdout = "".join(ansi_lines)
        assert len(stdout) > 1000  # Ensure we have substantial ANSI-heavy output.

        f = bc.PytestFilter()  # Could be any filter; we're testing the base Filter.apply logic.
        result = f.apply(stdout, "", 0, ["pytest"])

        # Early exit should have kicked in; the output should contain the marker.
        assert "early-exit: normalisation alone sufficient" in result.text

    def test_progress_heavy_output_triggers_early_exit(self) -> None:
        """Carriage-return progress lines: normalisation reduces >40% → early exit."""
        # Progress lines with many \r updates shrink dramatically after strip_progress.
        progress_lines = [
            f"phase-{i}: 10%\r20%\r30%\r40%\r50%\r60%\r70%\r80%\r90%\r100% done {i}\n"
            for i in range(50)
        ]
        stdout = "".join(progress_lines)

        f = bc.GenericFilter()
        result = f.apply(stdout, "", 0, ["some-cmd"])

        # Early exit should fire; note field indicates it.
        assert "early-exit: normalisation alone sufficient" in result.text

    def test_minimal_savings_does_not_trigger_early_exit(self) -> None:
        """Small output with minimal ANSI: normalisation saves <40% → no early exit."""
        stdout = "clean output\nno ansi codes\n"
        assert bc.normalise(stdout) == stdout  # No change expected.

        f = bc.PytestFilter()
        result = f.apply(stdout, "", 0, ["pytest"])

        # Should not have early-exit marker; compress() was called normally.
        assert "early-exit" not in result.text

    def test_early_exit_preserves_combined_stdout_stderr(self) -> None:
        """Early exit correctly combines stdout and stderr with --- separator."""
        stdout_ansi = "\x1b[31m" * 500 + "some output\n"  # Lots of ANSI.
        stderr_ansi = "\x1b[1m" * 500 + "some error\n"

        f = bc.GenericFilter()
        result = f.apply(stdout_ansi, stderr_ansi, 1, ["cmd"])

        # Expect both parts in output, separated by ---.
        assert "some output" in result.text
        assert "some error" in result.text
        assert "---" in result.text or "some output" in result.text.split("\n")[0]


# ---------------------------------------------------------------------------
# EzaFilter and TreeFilter tests
# ---------------------------------------------------------------------------

class TestEzaFilter:
    def test_matches_eza_binary(self) -> None:
        """EzaFilter matches 'eza' binary."""
        f = bc.EzaFilter()
        assert f.matches(["eza", "--git", "--long"])

    def test_matches_exa_binary(self) -> None:
        """EzaFilter matches 'exa' (older name for eza)."""
        f = bc.EzaFilter()
        assert f.matches(["exa", "--long"])

    def test_matches_ls_binary(self) -> None:
        """EzaFilter matches 'ls' binary."""
        f = bc.EzaFilter()
        assert f.matches(["ls", "-la"])

    def test_matches_ls_with_exe_extension(self) -> None:
        """EzaFilter matches 'ls.exe' on Windows."""
        f = bc.EzaFilter()
        assert f.matches(["ls.exe", "-l"])

    def test_passthrough_short_output(self) -> None:
        """EzaFilter passes through output with ≤30 lines unchanged."""
        f = bc.EzaFilter()
        short_output = "\n".join([f"file{i}.txt" for i in range(20)])
        result = f.compress(short_output, "", 0, ["ls", "-l"])
        assert result == short_output

    def test_compress_long_flat_listing(self) -> None:
        """EzaFilter compresses flat listing >30 lines: head+marker+tail."""
        f = bc.EzaFilter()
        # Create a 50-line listing with header
        lines = ["Name                Size    Date"]
        lines.extend([f"file{i}.txt              1024    2026-05-29" for i in range(49)])
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--long"])

        # Should contain marker indicating items were elided
        assert "elided" in result or "more" in result
        # Should be shorter than original
        result_lines = result.split("\n")
        assert len(result_lines) < len(lines)
        # Should still contain header and some entries
        assert "Name" in result or "file0" in result

    def test_compress_tree_output(self) -> None:
        """EzaFilter compresses tree output (--tree flag detected)."""
        f = bc.EzaFilter()
        # Create a 100-line tree output
        lines = ["root/"]
        for i in range(99):
            lines.append(f"  ├── dir{i}/")

        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--tree", "--long"])

        # Tree mode should keep first 40 + last 10 = 50 lines max
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 55  # 50 + marker + some margin
        # Should contain marker
        assert "elided" in result or "items" in result

    def test_tree_output_short_passthrough(self) -> None:
        """EzaFilter passes through short tree output unchanged."""
        f = bc.EzaFilter()
        lines = ["root/", "  ├── file1.txt", "  └── file2.txt"]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])
        assert result == output


class TestFdFilter:
    """Test FdFilter compression for fd / fdfind output."""

    def test_matches_fd_binary(self) -> None:
        """FdFilter matches 'fd' binary."""
        f = bc.FdFilter()
        assert f.matches(["fd", "pattern"])

    def test_matches_fdfind_binary(self) -> None:
        """FdFilter matches 'fdfind' binary (Ubuntu package name)."""
        f = bc.FdFilter()
        assert f.matches(["fdfind", "pattern"])

    def test_matches_fd_with_exe_extension(self) -> None:
        """FdFilter matches 'fd.exe' on Windows."""
        f = bc.FdFilter()
        assert f.matches(["fd.exe", "pattern"])

    def test_small_output_passes_through(self) -> None:
        """Output with ≤40 lines passes through unchanged."""
        f = bc.FdFilter()
        paths = [f"path/to/file{i}.txt" for i in range(30)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "pattern"])
        # Should be unchanged
        assert result == output.rstrip()
        # No compression marker should appear
        assert "elided" not in result

    def test_large_output_compressed(self) -> None:
        """Output with >40 lines is compressed."""
        f = bc.FdFilter()
        paths = [f"path/to/file{i}.txt" for i in range(60)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "pattern"])
        # Should contain compression marker
        assert "elided" in result
        # Should contain "more paths" language
        assert "more paths" in result
        # First 35 paths should be present
        assert "path/to/file0.txt" in result
        assert "path/to/file34.txt" in result
        # Last 5 should be present
        assert "path/to/file59.txt" in result
        # Some middle paths should be missing
        assert "path/to/file40.txt" not in result

    def test_boundary_exactly_40_lines(self) -> None:
        """Exactly 40 lines passes through without compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(40)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should pass through unchanged
        assert result == output.rstrip()
        assert "elided" not in result

    def test_boundary_41_lines(self) -> None:
        """41 lines triggers compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(41)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should be compressed
        assert "elided" in result

    def test_exit_code_preserved(self) -> None:
        """Exit codes are preserved through compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(60)]
        output = "\n".join(paths)
        result = f.apply(output, "", 0, ["fd", "pattern"])
        assert result.exit_code == 0

        result_not_found = f.apply("", "", 1, ["fd", "pattern"])
        assert result_not_found.exit_code == 1

    def test_compression_ratio(self) -> None:
        """Compression reduces large outputs significantly."""
        f = bc.FdFilter()
        paths = [f"very/long/path/to/file{i:04d}.txt" for i in range(100)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should keep only ~40 lines (35 + marker + 5)
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) < len(paths) / 2  # Less than half the original

    def test_empty_output(self) -> None:
        """Empty output is handled correctly."""
        f = bc.FdFilter()
        result = f.compress("", "", 1, ["fd", "pattern"])
        assert result == ""

    def test_filter_in_registry(self) -> None:
        """FdFilter is registered in the global FILTERS list."""
        fd_filter = bc.select_filter(["fd", "pattern"])
        assert fd_filter is not None
        assert fd_filter.name == "fd"


class TestTreeFilter:
    def test_matches_tree_binary(self) -> None:
        """TreeFilter matches 'tree' binary."""
        f = bc.TreeFilter()
        assert f.matches(["tree"])

    def test_matches_tree_with_args(self) -> None:
        """TreeFilter matches 'tree' with arguments."""
        f = bc.TreeFilter()
        assert f.matches(["tree", "-L", "2"])

    def test_passthrough_short_output(self) -> None:
        """TreeFilter passes through output with ≤60 lines unchanged."""
        f = bc.TreeFilter()
        short_output = "\n".join([f"├── file{i}.txt" for i in range(30)])
        result = f.compress(short_output, "", 0, ["tree"])
        assert result == short_output

    def test_compress_long_tree_output(self) -> None:
        """TreeFilter compresses >60 lines: first 50 + last 10 + marker."""
        f = bc.TreeFilter()
        # Create a 100-line tree output
        lines = ["root/"]
        for i in range(99):
            lines.append(f"├── item{i}/")
        # Add summary line
        lines.append("10 directories")
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Should contain marker
        assert "elided" in result
        # Result should be shorter
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 65  # 50 + 10 + marker + summary

    def test_preserves_summary_line(self) -> None:
        """TreeFilter preserves the final summary line."""
        f = bc.TreeFilter()
        lines = ["root/"]
        for i in range(70):
            lines.append(f"├── file{i}.txt")
        lines.append("5 directories, 65 files")
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Final summary should be preserved
        assert "directories, 65 files" in result or "directories" in result


# --- BatFilter tests --------------------------------------------------------

class TestBatFilter:
    def test_matches_bat_binary(self) -> None:
        """BatFilter matches 'bat' binary."""
        f = bc.BatFilter()
        assert f.matches(["bat"])
        assert f.matches(["batcat"])
        assert not f.matches(["cat"])

    def test_strips_ansi_codes(self) -> None:
        """BatFilter strips ANSI escape sequences."""
        f = bc.BatFilter()
        # Simulated bat output with ANSI codes
        output = "\x1b[1m1  \x1b[0mfn main() {"
        result = f.compress(output, "", 0, ["bat", "file.rs"])
        # ANSI codes should be stripped
        assert "\x1b[" not in result
        assert "fn main()" in result

    def test_passthrough_short_output(self) -> None:
        """BatFilter passes through output with ≤50 lines unchanged."""
        f = bc.BatFilter()
        lines = [f"line {i}: content" for i in range(30)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.txt"])
        # Should pass through (minus ANSI) when short
        assert "line 0" in result
        assert "elided" not in result

    def test_compress_long_bat_output(self) -> None:
        """BatFilter compresses >50 lines: first 40 + last 10 + marker."""
        f = bc.BatFilter()
        lines = [f"    {i:3d}  line {i}: content with some text" for i in range(100)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        # Should contain marker
        assert "elided" in result
        # Result should be shorter
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 52  # 40 + 10 + marker

    def test_removes_border_lines(self) -> None:
        """BatFilter removes box-drawing border lines."""
        f = bc.BatFilter()
        lines = [
            "───────────────",  # top border
            "    1  code line 1",
            "    2  code line 2",
            "───────────────",  # bottom border
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.txt"])
        # Borders should be stripped
        assert "code line 1" in result
        assert "code line 2" in result
        assert "───" not in result

    def test_preserves_file_content(self) -> None:
        """BatFilter preserves actual code content when removing chrome."""
        f = bc.BatFilter()
        code_lines = [
            "def hello():",
            "    print('hello')",
            "    return True",
        ]
        output = "\n".join(code_lines)
        result = f.compress(output, "", 0, ["bat", "test.py"])
        # All code should be present
        assert "def hello():" in result
        assert "print" in result


# --- DeltaFilter tests -------------------------------------------------------

class TestDeltaFilter:
    def test_matches_delta_binary(self) -> None:
        """DeltaFilter matches 'delta' binary."""
        f = bc.DeltaFilter()
        assert f.matches(["delta"])
        assert not f.matches(["diff"])

    def test_strips_ansi_codes(self) -> None:
        """DeltaFilter strips ANSI escape sequences."""
        f = bc.DeltaFilter()
        output = "\x1b[32m+added line\x1b[0m\n\x1b[31m-removed line\x1b[0m"
        result = f.compress(output, "", 0, ["delta", "diff"])
        # ANSI codes should be stripped
        assert "\x1b[" not in result
        assert "+added line" in result
        assert "-removed line" in result

    def test_passthrough_short_diff(self) -> None:
        """DeltaFilter passes through short diffs (≤80 lines) unchanged."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.txt b/file.txt",
            "--- a/file.txt",
            "+++ b/file.txt",
        ]
        lines.extend([f"- old line {i}" for i in range(30)])
        lines.extend([f"+ new line {i}" for i in range(30)])
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        assert "old line" in result
        assert "elided" not in result

    def test_compress_long_diff(self) -> None:
        """DeltaFilter compresses >80 lines: first 60 + last 20 + marker."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.txt b/file.txt",
            "--- a/file.txt",
            "+++ b/file.txt",
        ]
        lines.extend([f"-old line {i}" for i in range(100)])
        lines.extend([f"+new line {i}" for i in range(100)])
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 83  # 60 + 20 + marker

    def test_removes_decorative_separators(self) -> None:
        """DeltaFilter removes decorative separator lines."""
        f = bc.DeltaFilter()
        lines = [
            "─────────────────",
            "+section 1 changes",
            "─────────────────",
            "-section 2 changes",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Separators should be stripped
        assert "section 1 changes" in result
        assert "section 2 changes" in result
        assert "─────" not in result

    def test_preserves_diff_hunks(self) -> None:
        """DeltaFilter preserves diff hunk headers."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.py b/file.py",
            "--- a/file.py",
            "+++ b/file.py",
            "@@ -10,5 +10,6 @@",
            " context line",
            "-old implementation",
            "+new implementation",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Diff structure should be preserved
        assert "@@ -10" in result
        assert "-old implementation" in result
        assert "+new implementation" in result


# --- JqFilter tests ----------------------------------------------------------

class TestJqFilter:
    def test_matches_jq_binary(self) -> None:
        """JqFilter matches 'jq' binary."""
        f = bc.JqFilter()
        assert f.matches(["jq"])
        assert not f.matches(["grep"])

    def test_passthrough_short_json(self) -> None:
        """JqFilter passes through short JSON (≤200 lines) unchanged."""
        f = bc.JqFilter()
        json_lines = ["{", '  "key": "value",', '  "nested": {', '    "depth": 2', "  }", "}"]
        output = "\n".join(json_lines)
        result = f.compress(output, "", 0, ["jq", "."])
        assert "key" in result
        assert "value" in result
        assert "elided" not in result

    def test_compress_large_json(self) -> None:
        """JqFilter compresses >200 lines: first 150 + last 50 + marker."""
        f = bc.JqFilter()
        lines = ["{"]
        for i in range(300):
            lines.append(f'  "item{i}": {i},')
        lines[-1] = lines[-1].rstrip(",")  # Remove trailing comma from last item
        lines.append("}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 204  # 150 + 50 + marker

    def test_preserves_json_structure(self) -> None:
        """JqFilter preserves JSON structure when truncating."""
        f = bc.JqFilter()
        lines = ["{"]
        for i in range(250):
            lines.append(f'  "key{i}": {i},')
        lines[-1] = lines[-1].rstrip(",")
        lines.append("}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        # Result should still have JSON structure
        result = result.strip()
        assert result.startswith("{") or result.startswith("[")
        # Last non-empty line should be a closing bracket
        last_line = [ln for ln in result.split("\n") if ln.strip()][-1]
        assert last_line.rstrip(",;") in ("}", "]")

    def test_handles_empty_json(self) -> None:
        """JqFilter handles empty JSON correctly."""
        f = bc.JqFilter()
        output = "{}"
        result = f.compress(output, "", 0, ["jq", "."])
        assert result == "{}"


# --- YqFilter tests ----------------------------------------------------------

class TestYqFilter:
    def test_matches_yq_binary(self) -> None:
        """YqFilter matches 'yq' binary."""
        f = bc.YqFilter()
        assert f.matches(["yq"])
        assert not f.matches(["grep"])

    def test_passthrough_short_yaml(self) -> None:
        """YqFilter passes through short YAML (≤150 lines) unchanged."""
        f = bc.YqFilter()
        yaml_lines = [
            "version: 1.0",
            "services:",
            "  - name: web",
            "    port: 8080",
        ]
        output = "\n".join(yaml_lines)
        result = f.compress(output, "", 0, ["yq", "."])
        assert "version" in result
        assert "services" in result
        assert "elided" not in result

    def test_compress_large_yaml(self) -> None:
        """YqFilter compresses >150 lines: first 100 + last 50 + marker."""
        f = bc.YqFilter()
        lines = ["items:"]
        for i in range(200):
            lines.append(f"  - id: {i}")
            lines.append(f"    value: item_{i}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 154  # 100 + 50 + marker

    def test_preserves_yaml_structure(self) -> None:
        """YqFilter preserves YAML structure when truncating."""
        f = bc.YqFilter()
        lines = ["data:"]
        for i in range(180):
            lines.append(f"  key{i}: value{i}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        # Structure should be readable
        assert "data:" in result
        assert "key" in result

    def test_handles_empty_yaml(self) -> None:
        """YqFilter handles empty YAML correctly."""
        f = bc.YqFilter()
        output = "{}"
        result = f.compress(output, "", 0, ["yq", "."])
        assert result == "{}"


# --- FzfFilter tests (fuzzy finder output compression) -------------------------

class TestFzfFilter:
    """Test FzfFilter compression for fzf output."""

    def test_fzf_matches_binary(self) -> None:
        """FzfFilter matches 'fzf' binary."""
        f = bc.FzfFilter()
        assert f.matches(["fzf", "--multi"])
        assert f.matches(["fzf"])

    def test_fzf_short_output_passthrough(self) -> None:
        """FzfFilter passes through short output (≤50 lines) unchanged."""
        f = bc.FzfFilter()
        lines = "\n".join([f"item_{i}" for i in range(30)])
        result = f.compress(lines, "", 0, ["fzf"])
        assert result == lines
        assert "elided" not in result

    def test_fzf_long_output_compressed(self) -> None:
        """FzfFilter compresses long output (>50 lines): first 40 + last 10 + marker."""
        f = bc.FzfFilter()
        lines = "\n".join([f"item_{i}" for i in range(100)])
        result = f.compress(lines, "", 0, ["fzf"])
        assert "elided" in result
        result_lines = result.split("\n")
        # Should have: 40 head + 1 marker + 10 tail = 51 lines
        assert len(result_lines) == 51
        assert result_lines[0] == "item_0"
        assert result_lines[40].startswith("...")
        assert result_lines[-1] == "item_99"

    def test_fzf_empty_output(self) -> None:
        """FzfFilter handles empty output without error."""
        f = bc.FzfFilter()
        result = f.compress("", "", 0, ["fzf"])
        assert result == ""


# --- LazyGitFilter tests (git TUI output compression) --------------------------

class TestLazyGitFilter:
    """Test LazyGitFilter compression for lazygit output."""

    def test_lazygit_matches_binary(self) -> None:
        """LazyGitFilter matches 'lazygit' binary."""
        f = bc.LazyGitFilter()
        assert f.matches(["lazygit"])
        assert f.matches(["lazygit", "--version"])

    def test_lazygit_empty_output(self) -> None:
        """LazyGitFilter returns helpful message for empty output."""
        f = bc.LazyGitFilter()
        result = f.compress("", "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_ansi_codes_detected(self) -> None:
        """LazyGitFilter detects ANSI escape codes and returns helpful message."""
        f = bc.LazyGitFilter()
        output_with_ansi = "Some output\x1b[1;32mcolored text\x1b[0m"
        result = f.compress(output_with_ansi, "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_plain_text_passthrough(self) -> None:
        """LazyGitFilter passes through plain text output (unusual but possible)."""
        f = bc.LazyGitFilter()
        output = "plain text log output\nline 2\nline 3"
        result = f.compress(output, "", 0, ["lazygit"])
        # Plain text without ANSI codes should pass through
        assert result.strip() == output.strip()

    def test_lazygit_esc_paren_ansi_variant_detected(self) -> None:
        """LazyGitFilter detects \\x1b( escape (character-set sequences) as TUI."""
        f = bc.LazyGitFilter()
        # \x1b( is a character-set designation sequence used by lazygit TUI
        output = "\x1b(Bsome terminal data"
        result = f.compress(output, "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_exe_matches_on_windows(self) -> None:
        """LazyGitFilter matches 'lazygit.exe' (Windows binary name)."""
        f = bc.LazyGitFilter()
        assert f.matches(["lazygit.exe"])
        assert f.matches(["lazygit.exe", "--version"])


# ---------------------------------------------------------------------------
# _head_tail_compress — direct unit tests
# ---------------------------------------------------------------------------

class TestHeadTailCompress:
    """Unit tests for the _head_tail_compress helper function."""

    def test_short_list_returns_all_lines(self) -> None:
        """Lines at or below head+tail budget are returned unchanged."""
        lines = ["a", "b", "c", "d", "e"]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        # 5 lines <= 3+3, so no compression
        assert result == "a\nb\nc\nd\ne"

    def test_exact_boundary_no_marker(self) -> None:
        """Exactly head+tail lines produces no elision marker."""
        lines = [f"line{i}" for i in range(6)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "elided" not in result
        assert result == "\n".join(lines)

    def test_one_over_boundary_inserts_marker(self) -> None:
        """head+tail+1 lines triggers compression with a marker."""
        lines = [f"line{i}" for i in range(7)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "elided" in result
        assert "1 more items elided by token-goat" in result

    def test_head_lines_preserved(self) -> None:
        """The first ``head`` lines always appear in the result."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        for i in range(5):
            assert f"item{i}" in result

    def test_tail_lines_preserved(self) -> None:
        """The last ``tail`` lines always appear in the result."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        for i in range(45, 50):
            assert f"item{i}" in result

    def test_middle_lines_elided(self) -> None:
        """Lines in the middle are not present when compression fires."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        # Item in the middle should be gone
        assert "item25" not in result

    def test_elided_count_correct(self) -> None:
        """The marker count equals total - head - tail."""
        total = 40
        head = 10
        tail = 5
        lines = [f"x{i}" for i in range(total)]
        result = bc._head_tail_compress(lines, head=head, tail=tail)
        expected_elided = total - head - tail
        assert f"{expected_elided} more items elided" in result

    def test_custom_label_used_in_marker(self) -> None:
        """The ``label`` parameter appears in the elision marker."""
        lines = [f"path{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=10, tail=5, label="paths")
        assert "paths elided" in result

    def test_default_label_is_items(self) -> None:
        """The default label is 'items'."""
        lines = [f"x{i}" for i in range(20)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        assert "items elided" in result

    def test_empty_list_returns_empty_string(self) -> None:
        """An empty list produces an empty string (no crash)."""
        result = bc._head_tail_compress([], head=5, tail=5)
        assert result == ""

    def test_single_line_returns_that_line(self) -> None:
        """A single-line list is always returned as-is."""
        result = bc._head_tail_compress(["only line"], head=5, tail=5)
        assert result == "only line"

    def test_marker_format_token_goat_attribution(self) -> None:
        """Elision marker always includes 'token-goat' attribution."""
        lines = [f"l{i}" for i in range(20)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "token-goat" in result


# ---------------------------------------------------------------------------
# Windows .exe matching — BatFilter, DeltaFilter, FzfFilter, JqFilter, YqFilter
# ---------------------------------------------------------------------------

class TestWindowsExeMatching:
    """Verify that .exe suffix is stripped correctly for all new filter classes."""

    def test_bat_exe_matches(self) -> None:
        """BatFilter matches 'bat.exe' on Windows."""
        f = bc.BatFilter()
        assert f.matches(["bat.exe"])

    def test_batcat_exe_matches(self) -> None:
        """BatFilter matches 'batcat.exe' on Windows."""
        f = bc.BatFilter()
        assert f.matches(["batcat.exe"])

    def test_bat_exe_does_not_match_cat(self) -> None:
        """BatFilter does not match 'cat.exe'."""
        f = bc.BatFilter()
        assert not f.matches(["cat.exe"])

    def test_delta_exe_matches(self) -> None:
        """DeltaFilter matches 'delta.exe' on Windows."""
        f = bc.DeltaFilter()
        assert f.matches(["delta.exe"])

    def test_delta_exe_does_not_match_diff(self) -> None:
        """DeltaFilter does not match 'diff.exe'."""
        f = bc.DeltaFilter()
        assert not f.matches(["diff.exe"])

    def test_fzf_exe_matches(self) -> None:
        """FzfFilter matches 'fzf.exe' on Windows."""
        f = bc.FzfFilter()
        assert f.matches(["fzf.exe"])

    def test_jq_exe_matches(self) -> None:
        """JqFilter matches 'jq.exe' on Windows."""
        f = bc.JqFilter()
        assert f.matches(["jq.exe"])

    def test_jq_exe_does_not_match_unrelated(self) -> None:
        """JqFilter does not match 'xq.exe'."""
        f = bc.JqFilter()
        assert not f.matches(["xq.exe"])

    def test_yq_exe_matches(self) -> None:
        """YqFilter matches 'yq.exe' on Windows."""
        f = bc.YqFilter()
        assert f.matches(["yq.exe"])

    def test_yq_exe_does_not_match_jq(self) -> None:
        """YqFilter does not match 'jq.exe'."""
        f = bc.YqFilter()
        assert not f.matches(["jq.exe"])


# ---------------------------------------------------------------------------
# EzaFilter tree mode — precision tests (iteration 3)
# ---------------------------------------------------------------------------

class TestEzaFilterTreeMode:
    """Focused tests for EzaFilter tree-mode detection and limits."""

    def test_tree_eq_depth_detected_as_tree_mode(self) -> None:
        """--tree=N (value form) is recognised as tree mode."""
        f = bc.EzaFilter()
        # Build 80 non-empty lines so flat-mode would also compress — but
        # the tree-mode limit (40+10=50 head+tail) should apply, not flat (25+5).
        lines = [f"dir{i}/" for i in range(80)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree=2", "--long"])

        # Tree-mode uses head=40, tail=10; flat-mode uses head=25, tail=5.
        # With 80 lines the elided count differs: tree elides 30, flat elides 50.
        # The marker text reveals which branch ran.
        assert "30 more items elided" in result

    def test_tree_mode_bare_flag_elides_correct_count(self) -> None:
        """--tree (bare flag) uses head=40, tail=10 so elided count = total - 50."""
        f = bc.EzaFilter()
        lines = [f"file{i}.txt" for i in range(70)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # 70 total - 40 head - 10 tail = 20 elided
        assert "20 more items elided" in result

    def test_tree_mode_exactly_60_lines_passthrough(self) -> None:
        """Tree mode: exactly 60 non-empty lines passes through unchanged."""
        f = bc.EzaFilter()
        lines = [f"node{i}" for i in range(60)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # No truncation at exactly the threshold
        assert "elided" not in result
        assert result.rstrip() == output.rstrip()

    def test_tree_mode_61_lines_triggers_compression(self) -> None:
        """Tree mode: 61 non-empty lines triggers head+tail compression."""
        f = bc.EzaFilter()
        lines = [f"node{i}" for i in range(61)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # 61 - 40 - 10 = 11 elided
        assert "11 more items elided" in result

    def test_tree_mode_preserves_first_lines_as_headers(self) -> None:
        """Tree mode: first 40 lines (headers/root) are always in the output."""
        f = bc.EzaFilter()
        # Make first line a recognisable root header.
        # Total: 1 root + 69 modules = 70 lines (>60 threshold so compression fires).
        lines = ["project/"]
        lines += [f"  ├── module_{i}/" for i in range(69)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # The very first line must survive.
        assert "project/" in result
        # The first 40 non-empty lines are kept as the head.
        # lines[0] = "project/", lines[1..40] = module_0..module_38 (39 modules).
        # So module_38 is the last module guaranteed in the head.
        assert "module_0" in result
        assert "module_38" in result
        # module_39..module_58 are in the elided middle (20 items).
        assert "module_39" not in result

    def test_flat_mode_does_not_use_tree_limits(self) -> None:
        """Without --tree flag the flat limits (25+5) apply, not tree limits (40+10)."""
        f = bc.EzaFilter()
        lines = [f"file{i}.txt" for i in range(70)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--long"])

        # Flat mode elides 70 - 25 - 5 = 40; tree mode would elide 70 - 40 - 10 = 20.
        assert "40 more entries elided" in result


# ---------------------------------------------------------------------------
# TreeFilter boundary tests (iteration 3)
# ---------------------------------------------------------------------------

class TestTreeFilterBoundaries:
    """Exact boundary and summary-preservation tests for TreeFilter."""

    def test_passthrough_at_exactly_60_lines(self) -> None:
        """60 non-empty lines passes through without any elision marker."""
        f = bc.TreeFilter()
        lines = ["root/"]
        lines += [f"├── file{i}.txt" for i in range(59)]
        assert len(lines) == 60
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "elided" not in result
        assert result.rstrip() == output.rstrip()

    def test_truncation_at_61_lines(self) -> None:
        """61 non-empty lines triggers compression: 61 - 50 - 10 = 1 elided."""
        f = bc.TreeFilter()
        lines = ["root/"]
        lines += [f"├── file{i}.txt" for i in range(60)]
        assert len(lines) == 61
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "1 more items elided" in result

    def test_summary_line_always_in_tail(self) -> None:
        """The canonical 'N directories, M files' summary is in the tail so it survives."""
        f = bc.TreeFilter()
        lines = ["root/"]
        lines += [f"├── item{i}" for i in range(80)]
        lines.append("3 directories, 77 files")  # summary as last line
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Summary must survive — it is always the last line(s) so the tail keeps it.
        assert "3 directories, 77 files" in result

    def test_summary_line_preserved_near_60_boundary(self) -> None:
        """Summary line at position 61+ still survives (tail keeps last 10 lines)."""
        f = bc.TreeFilter()
        # Build exactly 65 lines so tail covers positions 55-64.
        lines = ["root/"]
        lines += [f"├── file{i}" for i in range(63)]
        lines.append("5 directories, 58 files")
        assert len(lines) == 65
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "5 directories, 58 files" in result
        assert "elided" in result  # compression did fire


# ---------------------------------------------------------------------------
# Gradle filter
# ---------------------------------------------------------------------------

class TestGradleFilter:
    def test_drops_task_progress_lines(self) -> None:
        """Gradle filter drops > Task : and > Configure project lines."""
        text = "> Task :compileJava\n> Task :processResources\n> Task :classes\n"
        text += "BUILD SUCCESSFUL in 2.5s"
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "> Task" not in result.text
        assert "BUILD SUCCESSFUL" in result.text
        assert "dropped 3 task-progress" in result.text

    def test_keeps_build_successful_line(self) -> None:
        """BUILD SUCCESSFUL line is preserved."""
        text = "> Task :build\nBUILD SUCCESSFUL in 1.0s"
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "BUILD SUCCESSFUL" in result.text

    def test_keeps_test_summary(self) -> None:
        """Test summaries in the output are kept (in last 30 lines)."""
        lines = [f"> Task :test_{i}" for i in range(5)]
        lines += ["5 tests passed", "BUILD SUCCESSFUL"]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "test"])
        assert "5 tests passed" in result.text
        assert "BUILD SUCCESSFUL" in result.text

    def test_dependencies_head_tail_compression(self) -> None:
        """gradle dependencies uses head=10, tail=10 compression."""
        lines = [f"dependency{i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "dependencies"])
        # Should have head (10) + marker + tail (10) = at most 21 lines + overhead
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_tasks_head_tail_compression(self) -> None:
        """gradle tasks uses head=20, tail=5 compression."""
        lines = [f"task{i}: Description {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "tasks"])
        # Should have head (20) + marker + tail (5)
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_failure_preserves_stderr_and_last_lines(self) -> None:
        """On exit_code != 0, preserve stderr and last 20 lines of stdout."""
        stdout = "\n".join([f"line {i}" for i in range(100)])
        stderr = "FAILURE: Build failed with an exception."
        f = bc.GradleFilter()
        result = f.apply(stdout, stderr, 1, ["gradle", "build"])
        assert "FAILURE: Build failed" in result.text
        assert "line 99" in result.text

    def test_short_build_output_passthrough(self) -> None:
        """Short build output (< 30 lines) passes through."""
        lines = ["line 1", "BUILD SUCCESSFUL"]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "line 1" in result.text
        assert "BUILD SUCCESSFUL" in result.text
        assert "elided" not in result.text

    def test_matches_gradle_binaries(self) -> None:
        """GradleFilter matches gradle, gradlew, ./gradlew."""
        f = bc.GradleFilter()
        assert f.matches(["gradle", "build"])
        assert f.matches(["gradlew", "build"])
        assert f.matches(["./gradlew", "build"])


# ---------------------------------------------------------------------------
# Maven filter
# ---------------------------------------------------------------------------

class TestMavenFilter:
    def test_drops_download_progress_lines(self) -> None:
        """Maven filter drops Downloading: and Downloaded: lines."""
        text = "[INFO] Downloading: http://example.com/foo.jar\n"
        text += "[INFO] Downloaded: http://example.com/foo.jar\n"
        text += "[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "Downloading" not in result.text
        assert "Downloaded" not in result.text
        assert "BUILD SUCCESS" in result.text
        assert "dropped 2 download-progress" in result.text

    def test_keeps_test_summary(self) -> None:
        """Tests run: X summary lines are kept."""
        text = "[INFO] Tests run: 42, Failures: 0, Errors: 0, Skipped: 0"
        text += "\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "Tests run: 42" in result.text
        assert "BUILD SUCCESS" in result.text

    def test_keeps_error_lines(self) -> None:
        """[ERROR] lines are preserved."""
        text = "[ERROR] Some compilation error\n[INFO] BUILD FAILURE"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "[ERROR]" in result.text

    def test_dependency_tree_head_tail_compression(self) -> None:
        """mvn dependency:tree uses head=10, tail=10 compression."""
        lines = [f"dep{i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "dependency:tree"])
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_install_keeps_last_30_lines(self) -> None:
        """mvn install keeps last 30 lines."""
        lines = [f"[INFO] line {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "install"])
        # Should have head (30) + maybe tail
        assert "line 99" in result.text

    def test_failure_preserves_error_lines(self) -> None:
        """On exit_code != 0, preserve ERROR lines and summary."""
        stdout = "\n".join([f"[INFO] line {i}" for i in range(100)])
        stderr = "[ERROR] Compilation failure"
        f = bc.MavenFilter()
        result = f.apply(stdout, stderr, 1, ["mvn", "package"])
        assert "[ERROR]" in result.text
        assert "line 99" in result.text

    def test_verify_subcommand_compression(self) -> None:
        """mvn verify compresses download lines but keeps summaries."""
        text = "[INFO] Downloading: foo\n[INFO] Downloaded: foo\n"
        text += "[INFO] Tests run: 10\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "verify"])
        assert "Downloading" not in result.text
        assert "Tests run: 10" in result.text
        assert "BUILD SUCCESS" in result.text

    def test_package_subcommand_compression(self) -> None:
        """mvn package compresses download lines."""
        text = "[INFO] Downloading: foo\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "package"])
        assert "Downloading" not in result.text
        assert "BUILD SUCCESS" in result.text

    def test_matches_maven_binaries(self) -> None:
        """MavenFilter matches mvn, mvnw, ./mvnw."""
        f = bc.MavenFilter()
        assert f.matches(["mvn", "test"])
        assert f.matches(["mvnw", "test"])
        assert f.matches(["./mvnw", "test"])

    def test_unknown_subcommand_uses_default(self) -> None:
        """Unknown Maven subcommands use default head/tail compression."""
        lines = [f"line {i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "unknown-command"])
        # Default is head=10, tail=10, so should show compression
        assert "more items elided" in result.text or "more lines elided" in result.text


# ---------------------------------------------------------------------------
# DotnetFilter
# ---------------------------------------------------------------------------


def _make_dotnet_build_output(n_projects: int = 3) -> str:
    """Synthetic `dotnet build` output for a multi-project solution."""
    lines = ["Microsoft (R) Build Engine version 17.9.0+blah"]
    for i in range(n_projects):
        lines.append(f"  Project{i} -> /src/Project{i}/bin/Debug/net8.0/Project{i}.dll")
        lines.append("Build succeeded.")
        lines.append("    0 Warning(s)")
        lines.append("    0 Error(s)")
    lines.append("")
    lines.append("Build succeeded.")
    lines.append("    0 Warning(s)")
    lines.append("    0 Error(s)")
    lines.append("")
    lines.append("Time Elapsed 00:00:03.12")
    return "\n".join(lines)


class TestDotnetFilter:
    def test_matches_dotnet(self) -> None:
        f = bc.DotnetFilter()
        assert f.matches(["dotnet", "build"])
        assert f.matches(["dotnet", "test"])
        assert f.matches(["dotnet", "restore"])

    def test_build_collapses_repeated_build_succeeded(self) -> None:
        """Repeated 'Build succeeded.' lines from multi-project build are collapsed to one."""
        text = _make_dotnet_build_output(n_projects=5)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        # Only one "Build succeeded." should remain (the last/final one).
        assert result.text.count("Build succeeded.") == 1

    def test_build_keeps_single_build_succeeded(self) -> None:
        """Single-project build: 'Build succeeded.' is kept unchanged."""
        text = "  MyApp -> /src/MyApp/bin/Debug/net8.0/MyApp.dll\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n\nTime Elapsed 00:00:01.50"
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "Build succeeded." in result.text

    def test_build_note_emitted_when_collapsed(self) -> None:
        """A note is emitted when Build succeeded. lines were collapsed."""
        text = _make_dotnet_build_output(n_projects=4)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "token-goat" in result.text
        assert "Build succeeded" in result.text

    def test_build_drops_msbuild_noise(self) -> None:
        """MSBuild evaluation lines starting with 'Project "...' are dropped."""
        text = (
            'Project "C:\\repo\\foo.csproj" on node 1\n'
            "  MyApp -> /src/MyApp/bin/Debug/net8.0/MyApp.dll\n"
            "Build succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert 'Project "C:\\repo\\foo.csproj"' not in result.text
        assert "Build succeeded." in result.text

    def test_build_keeps_error_lines(self) -> None:
        """Error lines survive even if they match a drop pattern."""
        text = (
            "Build succeeded.\n"
            "error CS0001: Unexpected error in compilation\n"
            "Build succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "error CS0001" in result.text

    def test_restore_drops_progress_lines(self) -> None:
        """Restore progress lines (Determining projects, Writing assets, etc.) are dropped."""
        text = (
            "Determining projects to restore...\n"
            "  Restored /src/MyApp/MyApp.csproj (5.32 sec)\n"
            "Restore succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "restore"])
        assert "Determining projects" not in result.text
        assert "Restore succeeded." in result.text

    def test_test_collapses_passed_lines(self) -> None:
        """Passed test lines are collapsed to a count."""
        lines = ["Test run for /src/Tests/bin/net8.0/Tests.dll (.NETCoreApp,Version=v8.0)"]
        for i in range(20):
            lines.append(f"  Passed MyNamespace.Tests.TestMethod{i}")
        lines.append("  Failed MyNamespace.Tests.TestMethodBroken")
        lines.append("    Assert.Equal() Failure")
        lines.append("Test Run Summary")
        lines.append("  Total   : 21")
        lines.append("  Passed  : 20")
        lines.append("  Failed  : 1")
        text = "\n".join(lines)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 1, ["dotnet", "test"])
        # All passing lines should be summarised away.
        assert "TestMethod0" not in result.text
        assert "TestMethodBroken" in result.text
        assert "token-goat" in result.text
        # The note should mention the collapsed count.
        assert "collapsed" in result.text

    def test_select_filter_dispatches_dotnet_build(self) -> None:
        """select_filter routes 'dotnet build' to DotnetFilter."""
        f = bc.select_filter(["dotnet", "build"])
        assert f is not None
        assert f.name == "dotnet"

    def test_select_filter_dispatches_dotnet_test(self) -> None:
        """select_filter routes 'dotnet test' to DotnetFilter."""
        f = bc.select_filter(["dotnet", "test"])
        assert f is not None
        assert f.name == "dotnet"


# ---------------------------------------------------------------------------
# PipFilter verbose mode
# ---------------------------------------------------------------------------


class TestPipFilterVerbose:
    def test_verbose_flag_drops_debug_lines(self) -> None:
        """DEBUG log lines from 'pip install -v' are dropped."""
        text = (
            "Collecting requests\n"
            "DEBUG pip._internal.utils.logging: Checking if requests-2.31.0 is already installed\n"
            "DEBUG pip._internal.network.session: Created new session\n"
            "  Downloading requests-2.31.0-py3-none-any.whl (62 kB)\n"
            "Installing collected packages: requests\n"
            "Successfully installed requests-2.31.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "requests"])
        assert "DEBUG" not in result.text
        assert "Successfully installed requests" in result.text

    def test_verbose_flag_drops_http_trace_lines(self) -> None:
        """HTTP-trace indented lines from verbose pip are dropped."""
        text = (
            "Collecting numpy\n"
            "  https://pypi.org/simple/numpy/\n"
            "  Querying https://pypi.org/simple/numpy/\n"
            "  Added numpy-1.26.0-cp311-cp311-win_amd64.whl to the build\n"
            "Successfully installed numpy-1.26.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "numpy"])
        assert "pypi.org" not in result.text
        assert "Querying" not in result.text
        assert "Successfully installed numpy" in result.text

    def test_verbose_double_v_flag_drops_debug(self) -> None:
        """'-vv' flag (double verbose) also triggers verbose mode dropping."""
        text = (
            "DEBUG high-verbosity line\n"
            "Successfully installed numpy-1.26.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-vv", "numpy"])
        assert "DEBUG" not in result.text
        assert "Successfully installed" in result.text

    def test_verbose_long_flag_drops_debug(self) -> None:
        """'--verbose' long flag triggers verbose mode dropping."""
        text = (
            "VERBOSE something\n"
            "Successfully installed requests-2.31.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "--verbose", "requests"])
        assert "VERBOSE" not in result.text
        assert "Successfully installed" in result.text

    def test_non_verbose_keeps_debug_like_output(self) -> None:
        """Without -v, DEBUG-prefixed lines from user code are NOT stripped (pass-through)."""
        text = (
            "Successfully installed some-package-1.0\n"
            "DEBUG this is from a post-install script\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "some-package"])
        assert "DEBUG this is from a post-install script" in result.text

    def test_verbose_preserves_error_lines(self) -> None:
        """Error lines are kept even in verbose mode."""
        text = (
            "DEBUG something noisy\n"
            "ERROR: Could not find a version that satisfies the requirement badpkg\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 1, ["pip", "install", "-v", "badpkg"])
        assert "ERROR: Could not find" in result.text

    def test_verbose_note_included(self) -> None:
        """A note is emitted when verbose debug lines are dropped."""
        text = "\n".join([
            "Collecting foo",
            "DEBUG pip._internal.req.req_install: foo",
        ] * 10 + ["Successfully installed foo-1.0"])
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "foo"])
        assert "verbose" in result.text.lower() or "debug" in result.text.lower()


# ---------------------------------------------------------------------------
# _safe_decode
# ---------------------------------------------------------------------------


class TestSafeDecode:
    def test_strips_null_bytes_from_str(self) -> None:
        assert bc._safe_decode("hello\x00world") == "helloworld"

    def test_strips_null_bytes_from_bytes(self) -> None:
        assert bc._safe_decode(b"foo\x00bar") == "foobar"

    def test_decodes_utf8_bytes(self) -> None:
        assert bc._safe_decode(b"hello") == "hello"

    def test_replaces_invalid_utf8(self) -> None:
        # 0xFF is invalid UTF-8; must not raise, must produce replacement char.
        result = bc._safe_decode(b"\xff\xfe")
        assert "�" in result or result == ""  # replacement char or empty

    def test_passthrough_clean_str(self) -> None:
        assert bc._safe_decode("plain text") == "plain text"

    def test_empty_bytes(self) -> None:
        assert bc._safe_decode(b"") == ""

    def test_empty_str(self) -> None:
        assert bc._safe_decode("") == ""

    def test_multiple_null_bytes(self) -> None:
        assert bc._safe_decode("a\x00b\x00c\x00") == "abc"

    def test_null_bytes_in_bytes(self) -> None:
        data = b"line1\x00\nline2\x00"
        result = bc._safe_decode(data)
        assert "\x00" not in result
        assert "line1" in result
        assert "line2" in result


# ---------------------------------------------------------------------------
# Filter.apply — empty input, MAX_INPUT_BYTES, encoding safety
# ---------------------------------------------------------------------------


class TestFilterApplyRobustness:
    """Tests for the encoding / edge-case guards added to Filter.apply."""

    def test_empty_stdout_and_stderr_returns_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("", "", 0, ["pytest"])
        assert result.text == ""
        assert result.original_bytes == 0
        assert result.compressed_bytes == 0

    def test_whitespace_only_returns_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("   \n\t\n", "  ", 0, ["pytest"])
        assert result.text == ""

    def test_null_bytes_stripped_before_filter(self) -> None:
        # Null bytes in stdout must not reach the filter logic.
        f = bc.GenericFilter()
        result = f.apply("ok\x00output", "", 0, ["custom"])
        assert "\x00" not in result.text
        assert "ok" in result.text or result.text == ""

    def test_max_input_bytes_cap_truncates(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "100")
        # Build a stdout that exceeds 100 bytes.
        long_stdout = "x" * 500
        f = bc.GenericFilter()
        result = f.apply(long_stdout, "", 0, ["custom"])
        # The note must mention truncation.
        notes_text = " ".join(result.notes) if result.notes else ""
        combined = result.text + notes_text
        assert "truncated" in combined.lower() or "100KB" in combined or "0KB" in combined

    def test_max_input_bytes_env_override_respected(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "50")
        long_stdout = "a" * 200
        f = bc.GenericFilter()
        result = f.apply(long_stdout, "", 0, ["custom"])
        # The compressed output must be shorter than the 200-byte input.
        assert result.compressed_bytes < 200

    def test_filter_exception_falls_back_gracefully(self) -> None:
        """A filter that raises must not propagate — apply falls back to truncation."""
        class BrokenFilter(bc.Filter):
            name = "broken"
            binaries = frozenset(["broken"])

            def compress(self, stdout, stderr, exit_code, argv):
                raise RuntimeError("intentional test failure")

        f = BrokenFilter()
        result = f.apply("some output\n" * 10, "", 0, ["broken"])
        # Must not raise, and the output should contain something from the raw input.
        assert isinstance(result, bc.CompressedOutput)
        assert "broken" in result.filter_name

    def test_exit_code_preserved_on_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("", "", 42, ["pytest"])
        assert result.exit_code == 42

    def test_exit_code_preserved_on_normal(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("1 passed", "", 0, ["pytest"])
        assert result.exit_code == 0

    def test_notes_field_populated_on_truncation(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "10")
        f = bc.GenericFilter()
        result = f.apply("x" * 500, "", 0, ["custom"])
        # notes list should be non-empty when truncation occurred.
        assert result.notes or "truncated" in result.text.lower()


# ---------------------------------------------------------------------------
# MAX_INPUT_BYTES constant and _get_max_input_bytes
# ---------------------------------------------------------------------------


class TestMaxInputBytesConstant:
    def test_default_is_500kb(self) -> None:
        assert bc.DEFAULT_MAX_INPUT_BYTES == 500 * 1024

    def test_exported_in_all(self) -> None:
        assert "DEFAULT_MAX_INPUT_BYTES" in bc.__all__

    def test_safe_decode_exported(self) -> None:
        assert "_safe_decode" in bc.__all__
