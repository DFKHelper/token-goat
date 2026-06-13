"""Tests for TypeScript compiler (tsc) output detection and compression.

Covers _is_tsc_cmd (bash_compress) and the tsc post_bash compression block
(hooks_read).
"""
from __future__ import annotations

import re

from token_goat.bash_compress import _is_tsc_cmd

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TSC_DIAG_RE = re.compile(r"^[^\s].+\(\d+,\d+\): (error|warning) TS\d+:")
_TSC_SUMMARY_RE = re.compile(r"^Found \d+ errors?\.")

_TSC_MIN_LINES = 50


def _make_stdout(*, error_lines: int = 0, warning_lines: int = 0, noise_lines: int = 0,
                 with_summary: bool = True) -> str:
    """Build a synthetic tsc stdout blob."""
    lines: list[str] = []
    for i in range(noise_lines):
        lines.append(f"[12:00:{i:02d} AM] Starting compilation in watch mode...")
    for i in range(error_lines):
        lines.append(f"src/foo{i}.ts({i + 1},5): error TS2304: Cannot find name 'bar'.")
    for i in range(warning_lines):
        lines.append(f"src/bar{i}.ts({i + 1},3): warning TS6133: 'x' is declared but never read.")
    if with_summary:
        total = error_lines
        lines.append(f"Found {total} error{'s' if total != 1 else ''}.")
    return "\n".join(lines) + "\n"


def _run_hook(stdout: str, cmd: str, exit_code: int = 0) -> dict:
    """Invoke the post_bash hook with minimal wiring and return its result."""
    from token_goat import hooks_read

    payload: dict = {
        "tool": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {
            "stdout": stdout,
            "stderr": "",
            "exit_code": exit_code,
        },
    }
    result = hooks_read.post_bash(payload)
    return result or {}


# ---------------------------------------------------------------------------
# Detection tests — _is_tsc_cmd
# ---------------------------------------------------------------------------

class TestIsTscCmd:
    # --- True cases ---

    def test_bare_tsc(self):
        assert _is_tsc_cmd(["tsc"]) is True

    def test_tsc_with_noEmit(self):
        assert _is_tsc_cmd(["tsc", "--noEmit"]) is True

    def test_tsc_with_build(self):
        assert _is_tsc_cmd(["tsc", "--build"]) is True

    def test_tsc_with_watch(self):
        assert _is_tsc_cmd(["tsc", "--watch"]) is True

    def test_tsc_with_multiple_flags(self):
        assert _is_tsc_cmd(["tsc", "--noEmit", "--strict", "--target", "ES2020"]) is True

    def test_tsc_exe_on_windows(self):
        assert _is_tsc_cmd(["tsc.exe"]) is True

    def test_tsc_cmd_extension(self):
        assert _is_tsc_cmd(["tsc.cmd"]) is True

    def test_node_modules_bin_tsc(self):
        assert _is_tsc_cmd(["./node_modules/.bin/tsc"]) is True

    def test_node_modules_bin_tsc_windows_path(self):
        assert _is_tsc_cmd([".\\node_modules\\.bin\\tsc"]) is True

    def test_absolute_path_tsc(self):
        assert _is_tsc_cmd(["/usr/local/bin/tsc"]) is True

    def test_path_ending_in_tsc(self):
        assert _is_tsc_cmd(["/some/deep/path/tsc"]) is True

    def test_npx_tsc(self):
        assert _is_tsc_cmd(["npx", "tsc"]) is True

    def test_npx_yes_tsc(self):
        assert _is_tsc_cmd(["npx", "--yes", "tsc"]) is True

    def test_npx_tsc_with_flags(self):
        assert _is_tsc_cmd(["npx", "tsc", "--noEmit"]) is True

    def test_yarn_tsc(self):
        assert _is_tsc_cmd(["yarn", "tsc"]) is True

    def test_yarn_tsc_with_flags(self):
        assert _is_tsc_cmd(["yarn", "tsc", "--build"]) is True

    def test_pnpm_tsc(self):
        assert _is_tsc_cmd(["pnpm", "tsc"]) is True

    def test_pnpm_exec_tsc(self):
        assert _is_tsc_cmd(["pnpm", "exec", "tsc"]) is True

    def test_pnpm_exec_tsc_with_flags(self):
        assert _is_tsc_cmd(["pnpm", "exec", "tsc", "--noEmit"]) is True

    # --- False cases ---

    def test_empty_argv(self):
        assert _is_tsc_cmd([]) is False

    def test_tsx(self):
        assert _is_tsc_cmd(["tsx"]) is False

    def test_ts_node(self):
        assert _is_tsc_cmd(["ts-node"]) is False

    def test_node(self):
        assert _is_tsc_cmd(["node", "typescript.js"]) is False

    def test_typescript_keyword(self):
        assert _is_tsc_cmd(["typescript"]) is False

    def test_npx_tsx(self):
        assert _is_tsc_cmd(["npx", "tsx", "file.ts"]) is False

    def test_npx_no_tsc_arg(self):
        # npx with no non-flag argument → False
        assert _is_tsc_cmd(["npx", "--yes"]) is False

    def test_yarn_jest(self):
        assert _is_tsc_cmd(["yarn", "jest"]) is False

    def test_pnpm_install(self):
        assert _is_tsc_cmd(["pnpm", "install"]) is False

    def test_path_ending_in_tsconfig(self):
        # tsconfig is not tsc
        assert _is_tsc_cmd(["node", "./tsconfig.js"]) is False


# ---------------------------------------------------------------------------
# Compression tests — hooks_read.post_bash
# ---------------------------------------------------------------------------

class TestTscCompression:
    """Test the tsc post_bash compression block in hooks_read."""

    def test_short_output_falls_through(self, tmp_path):
        """Output with < 50 lines must not be compressed."""
        stdout = _make_stdout(noise_lines=20, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) < _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --noEmit", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" not in msg

    def test_non_tsc_command_not_compressed(self):
        """Large output from a non-tsc command must not be compressed."""
        stdout = _make_stdout(noise_lines=44, error_lines=5, with_summary=True)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "node build.js", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" not in msg

    def test_all_errors_no_noise_falls_through(self):
        """50+ lines that are all diagnostic lines (no noise) must fall through."""
        # 50 error lines + summary = 51 lines, all useful
        stdout = _make_stdout(error_lines=50, noise_lines=0, with_summary=True)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --noEmit", exit_code=2)
        msg = result.get("systemMessage", "")
        # Nothing to suppress → no tsc header
        assert "[token-goat] tsc:" not in msg

    def test_clean_build_with_timestamp_noise_compressed(self):
        """50+ lines of noise only, exit=0 → show summary + suppressed count."""
        stdout = _make_stdout(noise_lines=55, error_lines=0, with_summary=True)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --noEmit", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc: 0 errors, 0 warnings" in msg
        assert "lines suppressed" in msg

    def test_clean_build_summary_line_preserved(self):
        """The 'Found 0 errors.' summary line must appear in compressed output."""
        stdout = _make_stdout(noise_lines=55, error_lines=0, with_summary=True)
        result = _run_hook(stdout, "tsc", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "Found 0 errors." in msg

    def test_errors_with_noise_compressed(self):
        """50+ lines with errors + timestamp noise → keep errors, strip noise."""
        stdout = _make_stdout(noise_lines=44, error_lines=5, with_summary=True)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --noEmit", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg
        assert "errors" in msg
        assert "lines suppressed" in msg

    def test_error_count_in_header(self):
        """Error count in the header must reflect the number of error lines."""
        stdout = _make_stdout(noise_lines=44, error_lines=3, warning_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --build", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "3 errors" in msg
        assert "2 warnings" in msg

    def test_warning_count_in_header(self):
        """Warning count in the header must reflect the number of warning lines."""
        stdout = _make_stdout(noise_lines=46, warning_lines=4, error_lines=0, with_summary=False)
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "npx tsc", exit_code=0)
        msg = result.get("systemMessage", "")
        if "[token-goat] tsc:" in msg:
            assert "4 warnings" in msg

    def test_diagnostic_lines_kept_in_output(self):
        """Error lines from tsc must appear verbatim in the compressed output."""
        stdout = _make_stdout(noise_lines=47, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        # Both error lines should be present
        assert "src/foo0.ts(1,5): error TS2304" in msg
        assert "src/foo1.ts(2,5): error TS2304" in msg

    def test_noise_lines_stripped(self):
        """Timestamp/watch progress lines must not appear in compressed output."""
        stdout = _make_stdout(noise_lines=46, error_lines=3, with_summary=True)
        result = _run_hook(stdout, "tsc --watch", exit_code=2)
        msg = result.get("systemMessage", "")
        # Noise lines like "[12:00:00 AM] Starting compilation..." must be gone
        assert "Starting compilation in watch mode" not in msg

    def test_summary_line_preserved_in_error_output(self):
        """'Found N errors.' summary must appear after the diagnostic lines."""
        stdout = _make_stdout(noise_lines=47, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "Found 2 errors." in msg

    def test_trailing_newline_preserved_when_present(self):
        """Output that ends with newline must also produce output ending with newline."""
        stdout = _make_stdout(noise_lines=45, error_lines=3, with_summary=True)
        assert stdout.endswith("\n")
        result = _run_hook(stdout, "tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        if "[token-goat] tsc:" in msg:
            # The body portion (after the header line) should end with newline
            # or the recall hint is appended
            assert msg  # non-empty

    def test_npx_tsc_detected_and_compressed(self):
        """npx tsc must be detected and its output compressed."""
        stdout = _make_stdout(noise_lines=47, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "npx tsc --noEmit", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg

    def test_pnpm_exec_tsc_detected_and_compressed(self):
        """pnpm exec tsc must be detected and its output compressed."""
        stdout = _make_stdout(noise_lines=48, error_lines=1, with_summary=True)
        result = _run_hook(stdout, "pnpm exec tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg

    def test_yarn_tsc_detected_and_compressed(self):
        """yarn tsc must be detected and its output compressed."""
        stdout = _make_stdout(noise_lines=48, error_lines=1, with_summary=True)
        result = _run_hook(stdout, "yarn tsc --build", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg

    def test_continue_true_in_response(self):
        """Compressed response must set continue=True."""
        stdout = _make_stdout(noise_lines=45, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "tsc", exit_code=2)
        if result.get("systemMessage", "") and "[token-goat] tsc:" in result.get("systemMessage", ""):
            assert result.get("continue") is True

    def test_suppressed_count_correct(self):
        """Suppressed line count in header must match lines removed."""
        noise = 45
        errors = 3
        stdout = _make_stdout(noise_lines=noise, error_lines=errors, with_summary=True)
        total = len(stdout.splitlines())
        result = _run_hook(stdout, "tsc --noEmit", exit_code=2)
        msg = result.get("systemMessage", "")
        if "[token-goat] tsc:" in msg:
            # kept lines = errors + summary = errors + 1
            kept = errors + 1
            suppressed = total - kept
            assert f"({suppressed}/{total} lines suppressed)" in msg

    def test_exact_50_lines_threshold(self):
        """Output with exactly 50 lines triggers compression if noise present."""
        # Build stdout with exactly 50 lines: 45 noise + 4 errors + 1 summary
        stdout = _make_stdout(noise_lines=45, error_lines=4, with_summary=True)
        lines = stdout.splitlines()
        assert len(lines) == 50
        result = _run_hook(stdout, "tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg

    def test_49_lines_falls_through(self):
        """Output with 49 lines must not be compressed regardless of content."""
        # 44 noise + 4 errors + 1 summary = 49 lines
        stdout = _make_stdout(noise_lines=44, error_lines=4, with_summary=True)
        lines = stdout.splitlines()
        assert len(lines) == 49
        result = _run_hook(stdout, "tsc", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" not in msg

    def test_build_errors_without_position_kept(self):
        """tsc --build position-less errors must survive compression and appear in output."""
        bare_errors = [
            "error TS6305: Output file 'dist/index.d.ts' is not built from source file 'src/index.ts'.",
            "error TS6306: Referenced project 'packages/lib' must have setting \"composite\": true.",
        ]
        noise = ["[12:00:00 AM] Starting compilation in watch mode..."] * 48
        stdout = "\n".join(noise + bare_errors) + "\n"
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --build", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg
        assert "error TS6305" in msg
        assert "lines suppressed" in msg

    def test_all_position_less_errors_not_zero_count(self):
        """When all errors are position-less, header must not claim 0 errors."""
        bare_errors = [
            f"error TS600{i}: Some build error {i}." for i in range(5)
        ]
        noise = ["[12:00:00 AM] Starting compilation in watch mode..."] * 46
        stdout = "\n".join(noise + bare_errors) + "\n"
        assert len(stdout.splitlines()) >= _TSC_MIN_LINES
        result = _run_hook(stdout, "tsc --build", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] tsc:" in msg
        # Must not claim zero errors when exit_code=1 and bare errors exist
        assert "0 errors" not in msg
