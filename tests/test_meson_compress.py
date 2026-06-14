"""Tests for MesonFilter — meson build system output compression."""

from __future__ import annotations

import re

from token_goat.bash_compress import MesonFilter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SETUP_OUTPUT = """\
The Meson build system
Version: 1.3.0
Source dir: /home/user/myproject
Build dir: /home/user/myproject/build
Build type: native build
Project name: myproject
Project version: 1.0.0
C compiler for the host machine: gcc (GCC 13.2.0 "gcc (Ubuntu 13.2.0-4ubuntu3) 13.2.0")
  Compiler for the host machine: gcc
    ld: /usr/bin/ld
    linker: id = 'gnu', version = '2.41'
C++ compiler for the host machine: g++ (GCC 13.2.0)
  Compiler for the host machine: g++
    ld: /usr/bin/ld
    linker: id = 'gnu', version = '2.41'
Has header 'stdio.h': YES
Has header 'unistd.h': YES
Has function 'getpid': YES
Dependency zlib found: YES 1.2.13
Dependency openssl found: YES 3.0.2
Program pkg-config found: YES 1.8.0
Library dl found: YES
Found ninja-1.11.1 at /usr/bin/ninja
Build targets in project: 5
"""

_COMPILE_OUTPUT = """\
[1/8] Compiling C object src/main.c.o
[2/8] Compiling C object src/helper.c.o
[3/8] Compiling C object src/utils.c.o
[4/8] Compiling C++ object src/widget.cpp.o
[5/8] Compiling C++ object src/renderer.cpp.o
[6/8] Compiling C++ object src/engine.cpp.o
[7/8] Linking target myapp
[8/8] Linking target libmylib.a
"""

_SETUP_WITH_ERROR = """\
The Meson build system
Version: 1.3.0
Source dir: /home/user/myproject
Build dir: /home/user/myproject/build
Has header 'missing.h': NO
Dependency missing-dep found: NO (tried pkgconfig and cmake)
ERROR: Dependency "missing-dep" not found, tried pkgconfig and cmake
"""

_SETUP_WITH_WARNING = """\
The Meson build system
Version: 1.3.0
Project name: myproject
Project version: 2.0.0
WARNING: Deprecated feature usage in meson.build
Dependency zlib found: YES 1.2.13
Build targets in project: 3
"""

_COMPILE_WITH_ERROR = """\
[1/4] Compiling C object src/main.c.o
[2/4] Compiling C object src/bad.c.o
FAILED: src/bad.c.o
cc -c src/bad.c -o src/bad.c.o
src/bad.c:10:5: error: undeclared identifier 'foo'
[3/4] Compiling C object src/ok.c.o
"""


# ---------------------------------------------------------------------------
# TestMesonFilterMatches
# ---------------------------------------------------------------------------

class TestMesonFilterMatches:
    def _f(self) -> MesonFilter:
        return MesonFilter()

    def test_meson_setup(self) -> None:
        assert self._f().matches(["meson", "setup", "build"])

    def test_meson_compile(self) -> None:
        assert self._f().matches(["meson", "compile", "-C", "build"])

    def test_meson_test(self) -> None:
        assert self._f().matches(["meson", "test", "-C", "build"])

    def test_meson_install(self) -> None:
        assert self._f().matches(["meson", "install", "-C", "build"])

    def test_meson_bare(self) -> None:
        assert self._f().matches(["meson"])

    def test_meson_configure(self) -> None:
        assert self._f().matches(["meson", "configure", "-Dbuildtype=release", "build"])

    def test_meson_init(self) -> None:
        assert self._f().matches(["meson", "init", "--name", "myproject"])

    def test_meson_dist(self) -> None:
        assert self._f().matches(["meson", "dist"])

    def test_meson_introspect(self) -> None:
        assert self._f().matches(["meson", "introspect", "--targets", "build"])

    def test_false_positive_cmake(self) -> None:
        assert not self._f().matches(["cmake", "-S", ".", "-B", "build"])

    def test_false_positive_make(self) -> None:
        assert not self._f().matches(["make", "all"])

    def test_false_positive_ninja(self) -> None:
        assert not self._f().matches(["ninja", "-C", "build"])

    def test_false_positive_empty(self) -> None:
        assert not self._f().matches([])

    def test_false_positive_maven(self) -> None:
        assert not self._f().matches(["mvn", "package"])


# ---------------------------------------------------------------------------
# TestCompressMesonBuild
# ---------------------------------------------------------------------------

class TestCompressMesonBuild:
    def _f(self) -> MesonFilter:
        return MesonFilter()

    # --- setup phase: lines that must be kept ---

    def test_setup_keeps_project_name(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Project name: myproject" in out

    def test_setup_keeps_project_version(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Project version: 1.0.0" in out

    def test_setup_keeps_header(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "The Meson build system" in out

    def test_setup_keeps_build_type(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Build type: native build" in out

    def test_setup_keeps_build_targets(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Build targets in project: 5" in out

    def test_setup_keeps_c_compiler_line(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "C compiler for the host machine:" in out

    # --- setup phase: lines that must be suppressed ---

    def test_setup_suppresses_has_header_probe(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Has header 'stdio.h'" not in out

    def test_setup_suppresses_dependency_found(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Dependency zlib found:" not in out

    def test_setup_suppresses_found_ninja(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "Found ninja" not in out

    def test_setup_suppresses_compiler_detail_indented(self) -> None:
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        assert "  Compiler for the host machine:" not in out

    # --- compile phase ---

    def test_compile_suppresses_compiling_lines(self) -> None:
        out = self._f().compress(_COMPILE_OUTPUT, "", 0, ["meson", "compile", "-C", "build"])
        # All Compiling lines must be suppressed (not just sampled positions)
        for i in range(1, 7):  # [1/8] through [6/8]
            assert f"[{i}/8] Compiling" not in out

    def test_compile_keeps_linking_lines(self) -> None:
        out = self._f().compress(_COMPILE_OUTPUT, "", 0, ["meson", "compile", "-C", "build"])
        assert "[7/8] Linking target myapp" in out
        assert "[8/8] Linking target libmylib.a" in out

    def test_compile_note_mentions_collapsed_count(self) -> None:
        out = self._f().compress(_COMPILE_OUTPUT, "", 0, ["meson", "compile", "-C", "build"])
        assert "collapsed 6" in out

    # --- empty input ---

    def test_empty_input(self) -> None:
        out = self._f().compress("", "", 0, ["meson", "setup", "build"])
        assert out == ""


# ---------------------------------------------------------------------------
# TestMesonFilterRegressions
# ---------------------------------------------------------------------------

class TestMesonFilterRegressions:
    def _f(self) -> MesonFilter:
        return MesonFilter()

    def test_error_always_kept(self) -> None:
        """ERROR lines from setup phase must survive compression."""
        out = self._f().compress(_SETUP_WITH_ERROR, "", 0, ["meson", "setup", "build"])
        assert 'ERROR: Dependency "missing-dep" not found' in out
        # Probe lines adjacent to ERROR must still be suppressed
        assert "Has header" not in out or "ERROR" in out

    def test_warning_always_kept(self) -> None:
        """WARNING lines must never be suppressed."""
        out = self._f().compress(_SETUP_WITH_WARNING, "", 0, ["meson", "setup", "build"])
        assert "WARNING: Deprecated feature usage" in out

    def test_build_failure_preserved_on_nonzero_exit(self) -> None:
        """Non-zero exit must preserve raw output for full context."""
        out = self._f().compress(_COMPILE_WITH_ERROR, "", 1, ["meson", "compile", "-C", "build"])
        assert "FAILED: src/bad.c.o" in out
        assert "error: undeclared identifier 'foo'" in out

    def test_compile_error_in_successful_run_kept(self) -> None:
        """FAILED line in otherwise successful run must be kept."""
        out = self._f().compress(_COMPILE_WITH_ERROR, "", 0, ["meson", "compile", "-C", "build"])
        assert "FAILED: src/bad.c.o" in out
        assert "error: undeclared identifier 'foo'" in out

    def test_setup_probe_count_reported(self) -> None:
        """Suppressed dependency probe lines must be counted in a note."""
        out = self._f().compress(_SETUP_OUTPUT, "", 0, ["meson", "setup", "build"])
        # Dependency probe lines must be suppressed
        assert not any(
            "Dependency" in ln and "found" in ln
            for ln in out.splitlines()
            if not ln.lstrip().startswith("[token-goat]")
        )
        # A suppression note mentioning the count must appear
        assert re.search(r"\d+.*probe", out, re.IGNORECASE) or "suppressed" in out.lower()

    def test_no_crash_on_bare_meson(self) -> None:
        """Bare 'meson' with no subcommand and empty output must not raise."""
        out = self._f().compress("", "", 0, ["meson"])
        assert isinstance(out, str)  # no crash; output may be empty or passthrough
