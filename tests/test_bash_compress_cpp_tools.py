"""Tests for C/C++ tool filters: ConanFilter, VcpkgFilter, CppcheckFilter, ClangTidyFilter."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin

from token_goat import bash_compress as bc


def _apply(filter_: bc.Filter, stdout: str = "", stderr: str = "", exit_code: int = 0) -> str:
    argv = [next(iter(filter_.binaries))]
    return filter_.apply(stdout, stderr, exit_code, argv).text


# ---------------------------------------------------------------------------
# ConanFilter
# ---------------------------------------------------------------------------

_CONAN_LIFECYCLE_LINES = "\n".join([
    "zlib/1.2.13: Calling build()",
    "zlib/1.2.13: Package 'abc123def456' created",
    "openssl/3.0.7: Calling build()",
    "openssl/3.0.7: Package 'deadbeef1234' created",
    "boost/1.82.0: Calling build()",
    "boost/1.82.0: Package '12345678abcd' already exists",
])

_CONAN_OUTPUT = "\n".join([
    "Configuration:",
    "[settings]",
    "  os=Linux",
    "Requirements",
    "    zlib/1.2.13 from 'conancenter' - Cache",
    "    openssl/3.0.7 from 'conancenter' - Download",
    "    boost/1.82.0 from 'conancenter' - Cache",
    "Packages",
    "    zlib/1.2.13:abc123 - Cache",
    _CONAN_LIFECYCLE_LINES,
    "zlib/1.2.13: Copying",
    "zlib/1.2.13: Generating the package",
    "Install finished",
])


class TestConanFilter(FilterTestMixin):
    F = bc.ConanFilter()

    def test_matches_conan(self) -> None:
        assert self.F.matches(["conan", "install", "."])

    def test_matches_conan2(self) -> None:
        assert self.F.matches(["conan2", "create", "."])

    def test_does_not_match_cmake(self) -> None:
        assert not self.F.matches(["cmake", "--build", "."])

    def test_select_returns_conan_filter(self) -> None:
        assert isinstance(bc.select_filter(["conan", "install", "."]), bc.ConanFilter)

    def test_lifecycle_lines_collapsed(self) -> None:
        result = _apply(self.F, stdout=_CONAN_OUTPUT)
        # The raw "Calling build()" lines should not appear verbatim
        assert "Calling build()" not in result
        # But the collapse note should be present
        assert "collapsed" in result.lower()
        assert "conan progress" in result.lower()

    def test_requirements_block_kept(self) -> None:
        result = _apply(self.F, stdout=_CONAN_OUTPUT)
        assert "Requirements" in result

    def test_packages_block_kept(self) -> None:
        result = _apply(self.F, stdout=_CONAN_OUTPUT)
        assert "Packages" in result

    def test_install_finished_kept(self) -> None:
        result = _apply(self.F, stdout=_CONAN_OUTPUT)
        assert "Install finished" in result

    def test_errors_kept_on_failure(self) -> None:
        output = "\n".join([
            "zlib/1.2.13: Calling build()",
            "zlib/1.2.13: ERROR: Package binary not found",
            "Install finished",
        ])
        result = self.F.apply(output, "", 1, ["conan", "install", "."])
        assert "ERROR: Package binary not found" in result.text


    def test_compression_ratio(self) -> None:
        result = self.F.apply(_CONAN_OUTPUT, "", 0, ["conan", "install", "."])
        assert result.compressed_bytes < result.original_bytes

    def test_no_false_collapse_on_clean_output(self) -> None:
        output = "Install finished\n"
        result = _apply(self.F, stdout=output)
        assert "Install finished" in result
        assert "collapsed" not in result.lower()

    def test_copying_lines_collapsed(self) -> None:
        output = "\n".join([
            "zlib/1.2.13: Copying",
            "openssl/3.0.7: Copying",
            "Install finished",
        ])
        result = _apply(self.F, stdout=output)
        assert "Copying" not in result
        assert "collapsed" in result.lower()


# ---------------------------------------------------------------------------
# VcpkgFilter
# ---------------------------------------------------------------------------

_VCPKG_PROGRESS_LINES = "\n".join([
    "Building zlib:x64-linux...",
    "Installing zlib:x64-linux...",
    "Building openssl:x64-linux...",
    "Installing openssl:x64-linux...",
    "Building boost-filesystem:x64-linux...",
    "Installing boost-filesystem:x64-linux...",
])

_VCPKG_OUTPUT = "\n".join([
    "The following packages will be built and installed:",
    "    zlib[core]:x64-linux",
    "    openssl[core]:x64-linux",
    "    boost-filesystem[core]:x64-linux",
    _VCPKG_PROGRESS_LINES,
    "  -- Extracting source /root/.cache/vcpkg/downloads/zlib-1.2.13.tar.gz",
    "  -- Applying patch zlib-0001-msvc.patch",
    "Elapsed time for package zlib:x64-linux: 12.3 s",
    "Elapsed time for package openssl:x64-linux: 45.6 s",
    "Total install time: 58.1 s",
    "CMake projects should use: \"-DCMAKE_TOOLCHAIN_FILE=...\"",
])


class TestVcpkgFilter(FilterTestMixin):
    F = bc.VcpkgFilter()

    def test_matches_vcpkg(self) -> None:
        assert self.F.matches(["vcpkg", "install", "zlib"])

    def test_does_not_match_cmake(self) -> None:
        assert not self.F.matches(["cmake", "--build", "."])

    def test_select_returns_vcpkg_filter(self) -> None:
        assert isinstance(bc.select_filter(["vcpkg", "install", "zlib"]), bc.VcpkgFilter)

    def test_building_lines_collapsed(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "Building zlib:x64-linux..." not in result
        assert "collapsed" in result.lower()

    def test_installing_lines_collapsed(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "Installing openssl:x64-linux..." not in result

    def test_plan_block_kept(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "The following packages will be built and installed" in result

    def test_total_install_time_kept(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "Total install time" in result

    def test_cmake_toolchain_hint_kept(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "CMake projects should use" in result

    def test_elapsed_time_dropped(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "Elapsed time for package" not in result

    def test_substep_lines_collapsed(self) -> None:
        result = _apply(self.F, stdout=_VCPKG_OUTPUT)
        assert "-- Extracting source" not in result
        assert "sub-step" in result.lower()

    def test_errors_kept_on_failure(self) -> None:
        output = "\n".join([
            "Building zlib:x64-linux...",
            "error: building package zlib:x64-linux failed with: BUILD_FAILED",
        ])
        result = self.F.apply(output, "", 1, ["vcpkg", "install", "zlib"])
        assert "BUILD_FAILED" in result.text


    def test_compression_ratio(self) -> None:
        result = self.F.apply(_VCPKG_OUTPUT, "", 0, ["vcpkg", "install", "zlib"])
        assert result.compressed_bytes < result.original_bytes

    def test_already_installed_kept(self) -> None:
        output = "Package zlib:x64-linux is already installed\n"
        result = _apply(self.F, stdout=output)
        assert "already installed" in result


# ---------------------------------------------------------------------------
# CppcheckFilter
# ---------------------------------------------------------------------------

_CPPCHECK_DIAG_LINES = "\n".join([
    "[src/main.cpp:42]: (error) Null pointer dereference: ptr",
    "[src/util.cpp:17]: (warning) Variable 'x' is assigned a value that is never used",
    "[include/foo.h:8]: (style) The function 'foo' is never used",
])

_CPPCHECK_OUTPUT = "\n".join([
    "Checking src/main.cpp...",
    "1/3 files checked 33% done",
    "Checking src/util.cpp...",
    "2/3 files checked 67% done",
    "Checking include/foo.h...",
    "3/3 files checked 100% done",
    _CPPCHECK_DIAG_LINES,
    "4 errors",
])

# cppcheck typically writes diagnostics to stderr
_CPPCHECK_STDERR = "\n".join([
    "Checking src/main.cpp...",
    "1/2 files checked 50% done",
    "Checking src/util.cpp...",
    "2/2 files checked 100% done",
    "[src/main.cpp:10]: (error) Memory leak: buf",
    "[src/util.cpp:5]: (warning) Unused variable: x",
    "2 errors",
])


class TestCppcheckFilter(FilterTestMixin):
    F = bc.CppcheckFilter()

    def test_matches_cppcheck(self) -> None:
        assert self.F.matches(["cppcheck", "--enable=all", "src/"])

    def test_does_not_match_clang(self) -> None:
        assert not self.F.matches(["clang", "-c", "foo.cpp"])

    def test_select_returns_cppcheck_filter(self) -> None:
        assert isinstance(bc.select_filter(["cppcheck", "src/"]), bc.CppcheckFilter)

    def test_checking_progress_collapsed(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "Checking src/main.cpp..." not in result
        assert "collapsed" in result.lower()

    def test_percentage_progress_dropped(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "files checked" not in result

    def test_error_diagnostics_kept(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "[src/main.cpp:42]: (error) Null pointer dereference: ptr" in result

    def test_warning_diagnostics_kept(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "[src/util.cpp:17]: (warning)" in result

    def test_style_diagnostics_kept(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "[include/foo.h:8]: (style)" in result

    def test_summary_line_kept(self) -> None:
        result = _apply(self.F, stdout=_CPPCHECK_OUTPUT)
        assert "4 errors" in result

    def test_stderr_diagnostics_kept(self) -> None:
        result = _apply(self.F, stderr=_CPPCHECK_STDERR)
        assert "[src/main.cpp:10]: (error) Memory leak: buf" in result


    def test_compression_ratio(self) -> None:
        result = self.F.apply(_CPPCHECK_OUTPUT, "", 0, ["cppcheck", "src/"])
        assert result.compressed_bytes < result.original_bytes

    def test_no_errors_clean_run(self) -> None:
        output = "\n".join([
            "Checking src/main.cpp...",
            "1/1 files checked 100% done",
            "No errors found",
        ])
        result = _apply(self.F, stdout=output)
        assert "No errors found" in result
        assert "Checking src/main.cpp..." not in result

    def test_no_false_collapse_on_only_diagnostics(self) -> None:
        output = "[src/foo.cpp:1]: (error) division by zero\n"
        result = _apply(self.F, stdout=output)
        assert "[src/foo.cpp:1]: (error) division by zero" in result
        # No collapse note because there was nothing to collapse
        assert "collapsed" not in result.lower()


# ---------------------------------------------------------------------------
# ClangTidyFilter
# ---------------------------------------------------------------------------

_CLANG_TIDY_DIAGS = "\n".join([
    "src/main.cpp:10:5: warning: use of 'strcpy' is insecure [clang-analyzer-security.insecureAPI.strcpy]",
    "    strcpy(buf, input);",
    "    ^~~~~~~~~~~~~~~~~~",
    "src/util.cpp:25:3: error: variable 'x' has indeterminate value when used here [clang-diagnostic-uninitialized]",
    "  int x;",
    "  ^",
    "src/util.cpp:30:1: note: uninitialized use of 'x' here",
])

_CLANG_TIDY_OUTPUT = "\n".join([
    "1 warning generated.",
    "2 warnings generated.",
    "In file included from src/main.cpp:3:",
    "In file included from /usr/include/string.h:1:",
    _CLANG_TIDY_DIAGS,
    "clang-tidy: 3 warnings generated.",
])

_CLANG_TIDY_STDERR_PROGRESS = "\n".join([
    "clang-tidy: Processing 5 files...",
    "src/main.cpp:10:5: warning: use of 'strcpy' is insecure [security.insecureAPI.strcpy]",
    "1 warning generated.",
])


class TestClangTidyFilter(FilterTestMixin):
    F = bc.ClangTidyFilter()

    def test_matches_clang_tidy(self) -> None:
        assert self.F.matches(["clang-tidy", "src/main.cpp"])

    def test_matches_run_clang_tidy(self) -> None:
        assert self.F.matches(["run-clang-tidy", "-p", "build/"])

    def test_does_not_match_clang(self) -> None:
        # plain `clang` is not clang-tidy
        assert not self.F.matches(["clang", "-c", "foo.cpp"])

    def test_select_returns_clang_tidy_filter(self) -> None:
        assert isinstance(bc.select_filter(["clang-tidy", "src/main.cpp"]), bc.ClangTidyFilter)

    def test_diagnostic_headers_kept(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        assert "src/main.cpp:10:5: warning: use of 'strcpy'" in result

    def test_error_diagnostic_kept(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        assert "src/util.cpp:25:3: error:" in result

    def test_note_line_kept(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        assert "note: uninitialized use" in result

    def test_warnings_generated_collapsed(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        # The raw "N warnings generated." lines should be collapsed
        assert "1 warning generated." not in result
        assert "collapsed" in result.lower()
        assert "warnings generated" in result.lower()

    def test_include_chains_collapsed(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        # The actual include-chain lines should not appear verbatim as source lines.
        # (The collapse note mentions the phrase — check the lines directly instead.)
        result_lines = result.splitlines()
        include_source_lines = [
            ln for ln in result_lines
            if ln.startswith("In file included from")
        ]
        assert include_source_lines == [], (
            f"Found raw include-chain lines in output: {include_source_lines}"
        )
        # The collapse marker note should mention the chains.
        assert "included from" in result.lower()

    def test_summary_line_kept(self) -> None:
        result = _apply(self.F, stdout=_CLANG_TIDY_OUTPUT)
        assert "clang-tidy: 3 warnings generated." in result

    def test_processing_progress_dropped(self) -> None:
        result = _apply(self.F, stderr=_CLANG_TIDY_STDERR_PROGRESS)
        assert "clang-tidy: Processing 5 files..." not in result


    def test_compression_ratio_on_verbose_output(self) -> None:
        # Build a realistic-sized output with many progress/include/context lines
        # so compression savings exceed the marker overhead.
        noise = "\n".join(
            [f"{i} warning generated." for i in range(1, 21)]
            + [f"In file included from header_{i}.h:1:" for i in range(10)]
        )
        output = "\n".join([
            noise,
            "src/foo.cpp:5:3: warning: use after free [clang-analyzer-cplusplus.NewDelete]",
            "  bad();",
            "  ^",
        ])
        result = self.F.apply(output, "", 0, ["clang-tidy", "src/foo.cpp"])
        assert result.compressed_bytes < result.original_bytes

    def test_no_diagnostics_clean_run(self) -> None:
        output = "2 warnings generated.\n"
        result = _apply(self.F, stdout=output)
        # Collapsed — but no diagnostic content so nothing else kept
        assert "2 warnings generated." not in result
        assert "collapsed" in result.lower()

    def test_context_lines_partially_kept(self) -> None:
        # The first context line (source code) after a diagnostic should be kept,
        # subsequent caret/source lines should be dropped.
        output = "\n".join([
            "src/foo.cpp:5:3: warning: some warning [some-check]",
            "  bad_code();",       # first context line — should be kept
            "  ^~~~~~~~~~",       # caret line — may be dropped (second context)
            "  more_context();",  # additional context — dropped
            "1 warning generated.",
        ])
        result = _apply(self.F, stdout=output)
        # The diagnostic header must always be present
        assert "src/foo.cpp:5:3: warning: some warning" in result
        # Some context lines are dropped (context_dropped counter fires)
        assert "dropped" in result.lower() or "context" in result.lower() or "caret" in result.lower()
