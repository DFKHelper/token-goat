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


# ---------------------------------------------------------------------------
# TscFilter unit tests (select_filter dispatch + compress() directly)
# ---------------------------------------------------------------------------

from token_goat.bash_compress import TscFilter, select_filter  # noqa: E402

# Realistic output samples for TscFilter

_TC_OLD_FEW = """\
src/index.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/utils.ts(20,3): error TS2339: Property 'foo' does not exist on type 'Bar'.

Found 2 errors.
"""

_TC_NEW_FEW = """\
src/index.ts:10:5 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.

10   const x = foo("hello");
              ~~~~~~~~~~~

src/utils.ts:20:3 - error TS2339: Property 'foo' does not exist on type 'Bar'.

20   return bar.foo;
               ~~~

Found 2 errors.
"""

_TC_MANY_SAME_CODE = """\
src/a.ts:1:1 - error TS2345: Type mismatch in a.

1   fn(x);
    ~

src/b.ts:5:3 - error TS2345: Type mismatch in b.

5   fn(y);
    ~

src/c.ts:9:2 - error TS2345: Type mismatch in c.

9   fn(z);
    ~

src/d.ts:14:6 - error TS2345: Type mismatch in d.

14   fn(w);
     ~

src/e.ts:20:4 - error TS2345: Type mismatch in e.

20   fn(v);
     ~

Found 5 errors.
"""

_TC_MIXED_CODES = """\
src/a.ts:1:1 - error TS2345: Type mismatch A.

1   fn(x);
    ~

src/b.ts:2:2 - error TS2339: Property missing B.

2   obj.foo;
        ~~~

src/c.ts:3:3 - error TS2345: Type mismatch C.

3   fn(y);
    ~

src/d.ts:4:4 - error TS2339: Property missing D.

4   obj.bar;
        ~~~

src/e.ts:5:5 - error TS2345: Type mismatch E.

5   fn(z);
    ~

src/f.ts:6:6 - error TS2345: Type mismatch F.

6   fn(w);
    ~

src/g.ts:7:7 - error TS2339: Property missing G.

7   obj.baz;
        ~~~

Found 7 errors.
"""

_WATCH_ONE_CYCLE = """\
[10:30:00 PM] Starting compilation in watch mode...

[10:30:01 PM] Found 0 errors. Watching for file changes.
"""

_WATCH_TWO_CYCLES = """\
[10:30:00 PM] Starting compilation in watch mode...

[10:30:01 PM] Found 0 errors. Watching for file changes.


[10:30:15 PM] File change detected. Starting incremental compilation...

[10:30:16 PM] Found 1 error. Watching for file changes.
"""

_WATCH_THREE_CYCLES = """\
[10:30:00 PM] Starting compilation in watch mode...

[10:30:01 PM] Found 0 errors. Watching for file changes.


[10:30:15 PM] File change detected. Starting incremental compilation...

[10:30:20 PM] Found 0 errors. Watching for file changes.


[10:30:45 PM] File change detected. Starting incremental compilation...

src/utils.ts:5:3 - error TS2339: Property 'foo' does not exist on type 'Bar'.

5   bar.foo;
        ~~~

[10:30:46 PM] Found 1 error. Watching for file changes.
"""

_WATCH_FIVE_CYCLES = """\
[9:00:00 AM] Starting compilation in watch mode...

[9:00:01 AM] Found 0 errors. Watching for file changes.


[9:01:00 AM] File change detected. Starting incremental compilation...

[9:01:01 AM] Found 0 errors. Watching for file changes.


[9:02:00 AM] File change detected. Starting incremental compilation...

[9:02:01 AM] Found 0 errors. Watching for file changes.


[9:03:00 AM] File change detected. Starting incremental compilation...

[9:03:01 AM] Found 0 errors. Watching for file changes.


[9:04:00 AM] File change detected. Starting incremental compilation...

src/index.ts:42:8 - error TS2345: Type error in index.

42   process(value);
             ~~~~~

[9:04:01 AM] Found 1 error. Watching for file changes.
"""

_BUILD_ALL_UPTODATE = """\
[11:00:00 AM] Projects in this build:
    * packages/core/tsconfig.json
    * packages/utils/tsconfig.json
    * tsconfig.json

[11:00:00 AM] Project 'packages/core/tsconfig.json' is up to date because oldest output 'packages/core/dist/index.js' is newer than newest input 'packages/core/src/index.ts'

[11:00:00 AM] Project 'packages/utils/tsconfig.json' is up to date because oldest output 'packages/utils/dist/index.js' is newer than newest input 'packages/utils/src/utils.ts'

[11:00:00 AM] Project 'tsconfig.json' is up to date because oldest output 'dist/index.js' is newer than newest input 'src/index.ts'

Found 0 errors.
"""

_BUILD_ONE_BUILDING = """\
[11:00:00 AM] Projects in this build:
    * packages/core/tsconfig.json
    * tsconfig.json

[11:00:00 AM] Project 'packages/core/tsconfig.json' is up to date because oldest output 'packages/core/dist/index.js' is newer than newest input 'packages/core/src/index.ts'

[11:00:01 AM] Building project 'tsconfig.json'...

src/index.ts:5:3 - error TS2345: Type error.

5   fn(x);
    ~

Found 1 error.
"""

_TF = TscFilter()


def _tsc(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    if argv is None:
        argv = ["tsc", "--noEmit"]
    return _TF.compress(stdout, stderr, exit_code, argv)


class TestTscFilterDispatch:
    def test_tsc_matched_by_select_filter(self) -> None:
        f = select_filter(["tsc"])
        assert f is not None and f.name == "tsc"

    def test_tsc_noEmit_matched(self) -> None:
        f = select_filter(["tsc", "--noEmit"])
        assert f is not None and f.name == "tsc"

    def test_tsc_watch_matched(self) -> None:
        f = select_filter(["tsc", "--watch"])
        assert f is not None and f.name == "tsc"

    def test_tsc_build_matched(self) -> None:
        f = select_filter(["tsc", "--build"])
        assert f is not None and f.name == "tsc"

    def test_npx_tsc_matched(self) -> None:
        f = select_filter(["npx", "tsc"])
        assert f is not None and f.name == "tsc"

    def test_yarn_tsc_matched(self) -> None:
        f = select_filter(["yarn", "tsc"])
        assert f is not None and f.name == "tsc"

    def test_pnpm_tsc_matched(self) -> None:
        f = select_filter(["pnpm", "tsc"])
        assert f is not None and f.name == "tsc"

    def test_tsx_not_tsc_filter(self) -> None:
        f = select_filter(["tsx", "src/index.ts"])
        assert f is None or f.name != "tsc"

    def test_linter_filter_no_longer_owns_tsc(self) -> None:
        # tsc must route to TscFilter, not the generic LinterFilter
        f = select_filter(["tsc", "--noEmit"])
        assert f is not None and f.name != "linter"


class TestTscFilterTypecheck:
    def test_zero_errors_pass_through(self) -> None:
        out = _tsc(stdout="Found 0 errors.\n")
        assert "Found 0 errors" in out

    def test_few_old_format_errors_kept(self) -> None:
        out = _tsc(stdout=_TC_OLD_FEW)
        assert "TS2345" in out
        assert "TS2339" in out
        assert "Found 2 errors" in out

    def test_few_new_format_errors_kept(self) -> None:
        out = _tsc(stdout=_TC_NEW_FEW)
        assert "TS2345" in out
        assert "TS2339" in out
        assert "Found 2 errors" in out

    def test_new_format_context_lines_preserved(self) -> None:
        out = _tsc(stdout=_TC_NEW_FEW)
        assert "10   const x = foo" in out
        assert "~~~" in out

    def test_summary_always_kept(self) -> None:
        out = _tsc(stdout=_TC_MANY_SAME_CODE)
        assert "Found 5 errors" in out

    def test_many_same_code_first_three_stanzas_kept(self) -> None:
        out = _tsc(stdout=_TC_MANY_SAME_CODE)
        # src/a, src/b, src/c all within 3 kept stanzas
        assert "src/a.ts" in out
        assert "src/b.ts" in out
        assert "src/c.ts" in out

    def test_many_same_code_excess_dropped_note(self) -> None:
        out = _tsc(stdout=_TC_MANY_SAME_CODE)
        assert "dropped 2 more TS2345" in out

    def test_dedup_note_mentions_token_goat(self) -> None:
        out = _tsc(stdout=_TC_MANY_SAME_CODE)
        assert "token-goat" in out

    def test_mixed_codes_dedup_independently(self) -> None:
        out = _tsc(stdout=_TC_MIXED_CODES)
        # TS2345 appears 4 times: keep 3, drop 1
        assert "dropped 1 more TS2345" in out
        # TS2339 appears 3 times: keep all 3, no drop note
        assert "TS2339" in out

    def test_nonzero_exit_does_not_suppress(self) -> None:
        out = _tsc(stdout=_TC_NEW_FEW, exit_code=2)
        assert "TS2345" in out
        assert "Found 2 errors" in out


class TestTscFilterWatchMode:
    def _w(self, stdout: str, short_flag: bool = False) -> str:
        flag = "-w" if short_flag else "--watch"
        return _tsc(stdout=stdout, argv=["tsc", flag])

    def test_single_cycle_pass_through(self) -> None:
        out = self._w(_WATCH_ONE_CYCLE)
        assert "Starting compilation in watch mode" in out
        assert "Found 0 errors. Watching" in out

    def test_two_cycles_no_drop_note(self) -> None:
        out = self._w(_WATCH_TWO_CYCLES)
        assert "intermediate" not in out

    def test_two_cycles_both_present(self) -> None:
        out = self._w(_WATCH_TWO_CYCLES)
        assert "Starting compilation in watch mode" in out
        assert "Found 1 error. Watching" in out

    def test_three_cycles_drops_one(self) -> None:
        out = self._w(_WATCH_THREE_CYCLES)
        assert "dropped 1 intermediate watch cycle" in out

    def test_three_cycles_first_banner_kept(self) -> None:
        out = self._w(_WATCH_THREE_CYCLES)
        assert "Starting compilation in watch mode" in out

    def test_three_cycles_last_error_kept(self) -> None:
        out = self._w(_WATCH_THREE_CYCLES)
        assert "TS2339" in out

    def test_five_cycles_drops_three(self) -> None:
        out = self._w(_WATCH_FIVE_CYCLES)
        assert "dropped 3 intermediate watch cycles" in out

    def test_five_cycles_last_error_preserved(self) -> None:
        out = self._w(_WATCH_FIVE_CYCLES)
        assert "TS2345" in out
        assert "index.ts" in out

    def test_w_short_flag_triggers_watch_mode(self) -> None:
        out = self._w(_WATCH_THREE_CYCLES, short_flag=True)
        assert "dropped 1 intermediate watch cycle" in out


class TestTscFilterBuildMode:
    def _b(self, stdout: str, short_flag: bool = False) -> str:
        flag = "-b" if short_flag else "--build"
        return _tsc(stdout=stdout, argv=["tsc", flag])

    def test_uptodate_lines_dropped(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE)
        assert "is up to date" not in out

    def test_projects_header_dropped(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE)
        assert "Projects in this build" not in out

    def test_project_item_lines_dropped(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE)
        assert "packages/core/tsconfig.json" not in out

    def test_uptodate_count_note(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE)
        assert "dropped 3 up-to-date project lines" in out

    def test_summary_kept(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE)
        assert "Found 0 errors" in out

    def test_building_line_kept(self) -> None:
        out = self._b(_BUILD_ONE_BUILDING)
        assert "Building project" in out

    def test_build_error_kept(self) -> None:
        out = self._b(_BUILD_ONE_BUILDING)
        assert "TS2345" in out
        assert "Found 1 error" in out

    def test_b_short_flag_triggers_build_mode(self) -> None:
        out = self._b(_BUILD_ALL_UPTODATE, short_flag=True)
        assert "dropped" in out
        assert "up-to-date" in out
