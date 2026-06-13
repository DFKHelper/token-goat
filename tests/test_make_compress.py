"""Tests for make/cmake/ninja output detection and compression.

Covers _is_make_cmd (bash_compress) and the make post_bash compression block
(hooks_read).
"""
from __future__ import annotations

from token_goat.bash_compress import _is_make_cmd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MAKE_MIN_LINES = 40


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_stdout(
    *,
    progress_lines: int = 0,
    error_lines: int = 0,
    warning_lines: int = 0,
    blank_lines: int = 0,
    with_summary: bool = True,
    makefile_noise: bool = False,
) -> str:
    """Build a synthetic make/ninja stdout blob."""
    lines: list[str] = []
    for i in range(progress_lines):
        pct = (i + 1) * 2
        lines.append(f"[{pct:3d}%] Building CXX object src/foo{i}.cpp.o")
    if makefile_noise:
        lines.append("make[1]: Entering directory '/tmp/build'")
        lines.append("make[2]: Entering directory '/tmp/build/src'")
        lines.append("-- Configuring done")
        lines.append("Leaving directory '/tmp/build'")
    for i in range(error_lines):
        lines.append(f"src/foo{i}.cpp:10:5: error: use of undeclared identifier 'bar'")
    for i in range(warning_lines):
        lines.append(f"src/bar{i}.cpp:20:3: warning: unused variable 'x' [-Wunused-variable]")
    for _ in range(blank_lines):
        lines.append("")
    if with_summary:
        lines.append("Build complete: myapp")  # plain summary, not a [N%] progress line
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
# Detection tests — _is_make_cmd
# ---------------------------------------------------------------------------

class TestIsMakeCmd:
    # --- make / gmake ---

    def test_bare_make(self):
        assert _is_make_cmd(["make"]) is True

    def test_make_with_target(self):
        assert _is_make_cmd(["make", "all"]) is True

    def test_make_with_jobs_flag(self):
        assert _is_make_cmd(["make", "-j8"]) is True

    def test_make_with_file_flag(self):
        assert _is_make_cmd(["make", "-f", "Makefile.custom", "install"]) is True

    def test_make_with_multiple_flags(self):
        assert _is_make_cmd(["make", "-j4", "-C", "src", "all"]) is True

    def test_make_exe_extension(self):
        assert _is_make_cmd(["make.exe"]) is True

    def test_make_path_prefix(self):
        assert _is_make_cmd(["/usr/bin/make", "clean"]) is True

    def test_make_windows_path(self):
        assert _is_make_cmd(["C:\\MinGW\\bin\\make.exe", "all"]) is True

    def test_gmake_bare(self):
        assert _is_make_cmd(["gmake"]) is True

    def test_gmake_with_target(self):
        assert _is_make_cmd(["gmake", "install"]) is True

    def test_gmake_path_prefix(self):
        assert _is_make_cmd(["/usr/local/bin/gmake", "-j4"]) is True

    # --- ninja ---

    def test_bare_ninja(self):
        assert _is_make_cmd(["ninja"]) is True

    def test_ninja_with_target(self):
        assert _is_make_cmd(["ninja", "all"]) is True

    def test_ninja_with_jobs_flag(self):
        assert _is_make_cmd(["ninja", "-j8"]) is True

    def test_ninja_with_verbose(self):
        assert _is_make_cmd(["ninja", "-v"]) is True

    def test_ninja_path_prefix(self):
        assert _is_make_cmd(["/usr/bin/ninja", "-C", "build"]) is True

    def test_ninja_exe_extension(self):
        assert _is_make_cmd(["ninja.exe", "-j4"]) is True

    # --- cmake --build ---

    def test_cmake_build(self):
        assert _is_make_cmd(["cmake", "--build", "."]) is True

    def test_cmake_build_with_dir(self):
        assert _is_make_cmd(["cmake", "--build", "build/"]) is True

    def test_cmake_build_with_config_flag(self):
        assert _is_make_cmd(["cmake", "--build", ".", "--config", "Release"]) is True

    def test_cmake_build_with_preset_before(self):
        assert _is_make_cmd(["cmake", "--preset", "default", "--build", "."]) is True

    def test_cmake_build_flag_skips_G_value(self):
        assert _is_make_cmd(["cmake", "-G", "Ninja", "--build", "."]) is True

    def test_cmake_build_flag_skips_D_value(self):
        assert _is_make_cmd(["cmake", "-DCMAKE_BUILD_TYPE=Release", "--build", "."]) is True

    def test_cmake_path_prefix(self):
        assert _is_make_cmd(["/usr/bin/cmake", "--build", "."]) is True

    # --- False cases ---

    def test_empty_argv(self):
        assert _is_make_cmd([]) is False

    def test_unknown_command(self):
        assert _is_make_cmd(["gcc", "main.c"]) is False

    def test_cmake_without_build(self):
        assert _is_make_cmd(["cmake", "."]) is False

    def test_cmake_configure_only(self):
        assert _is_make_cmd(["cmake", "-G", "Ninja", "-B", "build"]) is False

    def test_cmake_install(self):
        assert _is_make_cmd(["cmake", "--install", "."]) is False

    def test_cmake_empty_argv_after_cmake(self):
        assert _is_make_cmd(["cmake"]) is False

    def test_make_upper_case_not_matched(self):
        # _base() lower-cases, so MAKE.exe → make → matches; pure upper "MAKE" w/o ext
        # On most systems this wouldn't exist, but let's confirm lowercase normalisation:
        assert _is_make_cmd(["MAKE"]) is True  # lower-cased by _base()

    def test_not_python(self):
        assert _is_make_cmd(["python", "build.py"]) is False

    def test_not_cargo(self):
        assert _is_make_cmd(["cargo", "build"]) is False


# ---------------------------------------------------------------------------
# Compression block tests (hooks_read.post_bash)
# ---------------------------------------------------------------------------

class TestMakeCompression:
    """Test the make/cmake/ninja post_bash compression block in hooks_read."""

    def test_short_output_falls_through(self):
        """Output with < 40 lines must not be compressed."""
        stdout = _make_stdout(progress_lines=20, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) < _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" not in msg

    def test_non_make_command_not_compressed(self):
        """Large output from a non-make command must not trigger make compression."""
        stdout = _make_stdout(progress_lines=50, with_summary=True)
        result = _run_hook(stdout, "cargo build", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" not in msg

    def test_exit_code_3_falls_through(self):
        """exit_code=3 is outside (None, 0, 1, 2) — must not be compressed."""
        stdout = _make_stdout(progress_lines=50, error_lines=5, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=3)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" not in msg

    def test_no_progress_lines_falls_through(self):
        """Output with 0 suppressible lines must not emit a make header."""
        # 42 plain lines — none match progress patterns
        lines = [f"real output line {i}" for i in range(42)]
        stdout = "\n".join(lines) + "\n"
        result = _run_hook(stdout, "make all", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" not in msg

    def test_progress_lines_suppressed(self):
        """[  N%] progress lines must be stripped from output."""
        stdout = _make_stdout(progress_lines=45, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg
        assert "[  2%] Building" not in msg

    def test_make_bracket_noise_suppressed(self):
        """make[N]: lines must be suppressed."""
        stdout = _make_stdout(progress_lines=35, makefile_noise=True, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "make[1]: Entering" not in msg

    def test_entering_directory_suppressed(self):
        """'Entering directory' lines must be suppressed."""
        stdout = _make_stdout(progress_lines=35, makefile_noise=True, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "Entering directory" not in msg

    def test_leaving_directory_suppressed(self):
        """'Leaving directory' lines must be suppressed."""
        stdout = _make_stdout(progress_lines=35, makefile_noise=True, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "Leaving directory" not in msg

    def test_double_dash_lines_suppressed(self):
        """Lines beginning with '--' must be suppressed."""
        stdout = _make_stdout(progress_lines=35, makefile_noise=True, error_lines=2, with_summary=True)
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "-- Configuring done" not in msg

    def test_blank_lines_suppressed(self):
        """Blank lines must be counted as suppressed."""
        stdout = _make_stdout(progress_lines=35, blank_lines=10, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg
        assert "progress lines hidden" in msg

    def test_error_lines_kept(self):
        """Lines containing 'error:' must be preserved."""
        stdout = _make_stdout(progress_lines=38, error_lines=3, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "error: use of undeclared identifier" in msg

    def test_warning_lines_kept(self):
        """Lines containing 'warning:' must be preserved."""
        stdout = _make_stdout(progress_lines=38, warning_lines=3, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=0)
        msg = result.get("systemMessage", "")
        assert "warning: unused variable" in msg

    def test_summary_line_kept(self):
        """A plain build summary line (no [N%] prefix) must be kept."""
        stdout = _make_stdout(progress_lines=39, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make", exit_code=0)
        msg = result.get("systemMessage", "")
        # "Build complete: myapp" has no progress-line prefix so it must survive
        assert "Build complete: myapp" in msg

    def test_header_contains_line_counts(self):
        """Header must report total lines and kept count."""
        stdout = _make_stdout(progress_lines=40, error_lines=2, with_summary=True)
        total = len(stdout.splitlines())
        assert total >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert f"{total} lines" in msg
        assert "kept" in msg

    def test_suppressed_count_in_header(self):
        """Header must mention how many progress lines were hidden."""
        stdout = _make_stdout(progress_lines=40, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "progress lines hidden" in msg

    def test_bash_output_hint_present(self):
        """When no session_id, no bash-output id is available but hint block absent."""
        stdout = _make_stdout(progress_lines=40, error_lines=1, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        # result must be a systemMessage dict
        assert "systemMessage" in result

    def test_continue_true_returned(self):
        """Result must contain continue=True so the hook chain proceeds."""
        stdout = _make_stdout(progress_lines=40, error_lines=1, with_summary=True)
        result = _run_hook(stdout, "make all", exit_code=1)
        assert result.get("continue") is True

    def test_ninja_command_detected(self):
        """ninja command must trigger make compression."""
        stdout = _make_stdout(progress_lines=42, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "ninja -j8 all", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_cmake_build_command_detected(self):
        """cmake --build must trigger make compression."""
        stdout = _make_stdout(progress_lines=42, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "cmake --build . --config Release", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_gmake_command_detected(self):
        """gmake command must trigger make compression."""
        stdout = _make_stdout(progress_lines=42, error_lines=2, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "gmake -j4", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_exit_code_none_accepted(self):
        """exit_code=None (timeout/unknown) must still trigger compression."""
        stdout = _make_stdout(progress_lines=40, error_lines=1, with_summary=True)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=None)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_exit_code_2_accepted(self):
        """exit_code=2 (make error) must trigger compression."""
        stdout = _make_stdout(progress_lines=40, error_lines=3, with_summary=False)
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=2)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_exact_40_lines_triggers(self):
        """Exactly 40 lines must trigger compression (boundary condition)."""
        # Build stdout with exactly 40 lines total, at least some suppressible
        lines = []
        for i in range(37):
            lines.append(f"[{i + 1:3d}%] Building src/file{i}.o")
        lines.append("src/bad.cpp:1:1: error: bad")
        lines.append("")  # blank — suppressible
        lines.append("Build complete: myapp")
        stdout = "\n".join(lines) + "\n"
        assert len(stdout.splitlines()) == 40
        result = _run_hook(stdout, "make", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" in msg

    def test_39_lines_falls_through(self):
        """39 lines must not trigger compression."""
        lines = []
        for i in range(36):
            lines.append(f"[{i + 1:3d}%] Building src/file{i}.o")
        lines.append("src/bad.cpp:1:1: error: bad")
        lines.append("")
        lines.append("Build complete: myapp")
        stdout = "\n".join(lines) + "\n"
        assert len(stdout.splitlines()) == 39
        result = _run_hook(stdout, "make", exit_code=1)
        msg = result.get("systemMessage", "")
        assert "[token-goat] make:" not in msg

    def test_make_error_bracket_line_kept(self):
        """make[N]: *** [...] Error lines must be kept, not suppressed."""
        lines = []
        for i in range(37):
            lines.append(f"[{i + 1:3d}%] Building CXX object src/CMakeFiles/myapp.dir/file{i}.cpp.o")
        lines.append("make[1]: Entering directory '/tmp/build'")
        lines.append("make[2]: Entering directory '/tmp/build/src'")
        lines.append("make[1]: *** [src/CMakeFiles/myapp.dir/main.cpp.o] Error 1")
        lines.append("Build complete: myapp")
        stdout = "\n".join(lines) + "\n"
        assert len(stdout.splitlines()) >= _MAKE_MIN_LINES
        result = _run_hook(stdout, "make all", exit_code=1)
        msg = result.get("systemMessage", "")
        # The *** Error line is a build diagnostic — it must survive compression.
        assert "make[1]: *** [src/CMakeFiles/myapp.dir/main.cpp.o] Error 1" in msg
        # Directory-entry noise lines must still be suppressed.
        assert "make[1]: Entering directory" not in msg
        assert "make[2]: Entering directory" not in msg
