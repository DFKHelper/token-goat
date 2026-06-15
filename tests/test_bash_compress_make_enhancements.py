"""Tests for MakeFilter iteration-105 enhancements."""
from __future__ import annotations

from token_goat.bash_compress import MakeFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return MakeFilter().compress(inp, "", 0, argv or ["make", "all"])


# ---------------------------------------------------------------------------
# Compiler echo suppression
# ---------------------------------------------------------------------------

class TestMakeCompilerEchoSuppression:
    def test_gcc_command_suppressed(self) -> None:
        # Plain compiler invocation with no following error is dropped
        inp = "\n".join([
            "gcc -O2 foo.c -o foo",
            "echo Build done",
            "Build done",
        ])
        out = _compress(inp)
        assert "gcc -O2 foo.c -o foo" not in out

    def test_gcc_kept_before_error(self) -> None:
        # Compiler line followed by an error diagnostic must be kept
        inp = "\n".join([
            "gcc -O2 foo.c -o foo",
            "foo.c:10:5: error: undeclared identifier",
        ])
        out = _compress(inp)
        assert "gcc -O2 foo.c -o foo" in out


# ---------------------------------------------------------------------------
# Directory noise suppression
# ---------------------------------------------------------------------------

class TestMakeDirectoryNoise:
    def test_entering_directory_suppressed(self) -> None:
        inp = "make[2]: Entering directory '/src'"
        out = _compress(inp)
        assert "Entering directory" not in out

    def test_leaving_directory_suppressed(self) -> None:
        inp = "make[2]: Leaving directory '/src'"
        out = _compress(inp)
        # Note line contains "Leaving directory"; assert the actual make line is gone
        assert not any("Leaving directory '/src'" in line for line in out.splitlines())

    def test_nothing_to_do_suppressed(self) -> None:
        inp = "make[1]: Nothing to be done for 'all'."
        out = _compress(inp)
        assert "Nothing to be done" not in out


# ---------------------------------------------------------------------------
# Error and warning lines always kept
# ---------------------------------------------------------------------------

class TestMakeDiagnosticsKept:
    def test_error_line_always_kept(self) -> None:
        inp = "foo.c:10:5: error: undeclared identifier 'foo'"
        out = _compress(inp)
        assert "error: undeclared identifier 'foo'" in out

    def test_warning_line_always_kept(self) -> None:
        inp = "foo.c:3:1: warning: implicit declaration of function 'bar'"
        out = _compress(inp)
        assert "warning: implicit declaration" in out
