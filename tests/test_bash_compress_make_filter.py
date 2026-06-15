"""Tests for MakeFilter compression in bash_compress.py.

Covers compiler-echo suppression (direct compress), error/warning
preservation, star-error markers, and short-passthrough.

Compiler-echo tests call MakeFilter.compress() directly because that path
is exercised via the pre-hook command-wrap pipeline. Star-error and hook
tests verify hook-pipeline behavior for compiler output.
"""
from __future__ import annotations

from token_goat.bash_compress import MakeFilter

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Compression only fires in the hook pipeline once stdout reaches this many lines.
_MIN_LINES = 40

_FILTER = MakeFilter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_hook(stdout: str, cmd: str = "make", exit_code: int = 0) -> dict:
    """Fire the post_bash hook and return its result dict."""
    from token_goat import hooks_read

    payload: dict = {
        "tool": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
    }
    return hooks_read.post_bash(payload) or {}


def _build_lines(*extra: str, pad_to: int = _MIN_LINES) -> str:
    """Return stdout padded with [N%] Building progress lines so hook compression fires."""
    lines = list(extra)
    idx = 0
    while len(lines) < pad_to:
        idx += 1
        lines.insert(0, f"[{idx:3d}%] Building CXX object src/file{idx}.cpp.o")
    return "\n".join(lines) + "\n"


def _compress(stdout: str, cmd: str = "make") -> str:
    """Run MakeFilter.compress() directly with minimal argv."""
    return _FILTER.compress(stdout, "", 0, [cmd])


# ---------------------------------------------------------------------------
# Compiler-echo suppression (MakeFilter.compress directly)
# ---------------------------------------------------------------------------

class TestMakeFilterCompilerEchoes:
    def _pad_echoes(self, *echo_lines: str) -> str:
        """40 progress lines + echo lines so compress has content to work with."""
        progress = [f"[{i+1:3d}%] Building CXX object src/f{i}.cpp.o" for i in range(40)]
        return "\n".join(progress + list(echo_lines)) + "\n"

    def test_cc_invocation_suppressed(self):
        """Lines starting with 'cc ' are stripped by MakeFilter."""
        out = _compress(self._pad_echoes("cc -O2 -o src/foo.o src/foo.c"))
        assert "cc -O2" not in out

    def test_gcc_invocation_suppressed(self):
        """Lines starting with 'gcc ' are stripped by MakeFilter."""
        out = _compress(self._pad_echoes("gcc -Wall -c src/bar.c -o src/bar.o"))
        assert "gcc -Wall" not in out

    def test_clang_invocation_suppressed(self):
        """Lines starting with 'clang ' are stripped by MakeFilter."""
        out = _compress(self._pad_echoes("clang -std=c11 -c src/baz.c -o src/baz.o"))
        assert "clang -std=c11" not in out

    def test_gpp_invocation_suppressed(self):
        """Lines starting with 'g++ ' are stripped by MakeFilter."""
        out = _compress(self._pad_echoes("g++ -std=c++17 -c src/main.cpp -o src/main.o"))
        assert "g++ -std=c++17" not in out

    def test_compiler_echo_with_error_kept(self):
        """A compiler-echo line containing 'error' survives — error guard fires first."""
        out = _compress(self._pad_echoes("cc -o out/bad.o src/bad.c: error: no such file"))
        assert "error: no such file" in out

    def test_echo_suppression_noted(self):
        """Suppression note must mention compiler-invocation echoes."""
        out = _compress(self._pad_echoes("gcc -c src/a.c -o src/a.o"))
        assert "compiler-invocation" in out


# ---------------------------------------------------------------------------
# Error / warning preservation and star-error markers
# ---------------------------------------------------------------------------

class TestMakeFilterErrorPreservation:
    def test_star_error_marker_kept_via_hook(self):
        """make[N]: *** [...] Error lines are not suppressed by the hook pipeline."""
        stdout = _build_lines(
            "make[1]: Entering directory '/tmp/build'",
            "make[1]: *** [src/CMakeFiles/app.dir/main.cpp.o] Error 1",
        )
        msg = _run_hook(stdout, "make", exit_code=2).get("systemMessage", "")
        assert "*** [src/CMakeFiles/app.dir/main.cpp.o] Error 1" in msg

    def test_star_error_marker_kept_direct(self):
        """MakeFilter.compress keeps *** Error lines even in recursive noise."""
        progress = [f"[{i+1:3d}%] Building CXX object src/f{i}.cpp.o" for i in range(40)]
        lines = progress + [
            "make[1]: Entering directory '/tmp/build'",
            "make[1]: *** [Makefile] Error 2",
        ]
        out = _compress("\n".join(lines) + "\n")
        assert "*** [Makefile] Error 2" in out


# ---------------------------------------------------------------------------
# Short-output passthrough
# ---------------------------------------------------------------------------

class TestMakeFilterPassthrough:
    def test_short_output_not_compressed(self):
        """Output with fewer than _MIN_LINES lines passes through the hook unchanged."""
        lines = ["make[1]: Entering directory '/tmp'"] * 5 + ["Build done"]
        stdout = "\n".join(lines) + "\n"
        assert len(stdout.splitlines()) < _MIN_LINES
        result = _run_hook(stdout, "make")
        assert result.get("systemMessage") is None

    def test_large_build_only_errors_survive(self):
        """In a large mixed build, only error/warning diagnostics survive the hook."""
        error = "src/login.cpp:99:3: error: expected ';' before '}'"
        warning = "src/login.cpp:5:1: warning: missing return statement [-Wreturn-type]"
        stdout = _build_lines(
            "make[1]: Entering directory '/tmp/build'",
            error,
            warning,
            "make[1]: Leaving directory '/tmp/build'",
        )
        msg = _run_hook(stdout, "make", exit_code=1).get("systemMessage", "")
        assert "expected ';'" in msg
        assert "missing return statement" in msg
        assert "Entering directory" not in msg

    def test_compiler_echo_mixed_with_progress_via_hook(self):
        """Compiler echoes in large make output survive the hook (only direct compress suppresses them)."""
        stdout = _build_lines("gcc -c src/a.c -o build/a.o", "make[1]: *** [build/a.o] Error 1")
        msg = _run_hook(stdout, "make", exit_code=1).get("systemMessage", "")
        assert msg, "Large output should trigger hook compression and return systemMessage"
        assert "Error 1" in msg, "Error line should survive hook compression"
        assert "gcc -c src/a.c" in msg, "Compiler echo in hook output (only direct compress suppresses it)"
