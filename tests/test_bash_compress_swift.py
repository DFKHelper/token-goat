"""Tests for SwiftFilter and XcodeFilter in token_goat.bash_compress."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# SwiftFilter — applies()
# ---------------------------------------------------------------------------


class TestSwiftFilterApplies:
    def test_swift_build_matches(self) -> None:
        f = bc.SwiftFilter()
        assert f.matches(["swift", "build"])

    def test_swift_test_matches(self) -> None:
        f = bc.SwiftFilter()
        assert f.matches(["swift", "test"])

    def test_swift_run_matches(self) -> None:
        f = bc.SwiftFilter()
        assert f.matches(["swift", "run"])

    def test_swift_package_matches(self) -> None:
        f = bc.SwiftFilter()
        assert f.matches(["swift", "package", "resolve"])

    def test_swiftc_does_not_match(self) -> None:
        """swiftc is not the swift CLI; SwiftFilter only matches 'swift'."""
        f = bc.SwiftFilter()
        # swiftc is a separate binary — no subcommand; SwiftFilter requires one
        # of build/test/run/package as subcommand.
        assert not f.matches(["swiftc", "main.swift"])

    def test_swift_without_subcommand_does_not_match(self) -> None:
        f = bc.SwiftFilter()
        assert not f.matches(["swift"])

    def test_unrelated_command_does_not_match(self) -> None:
        f = bc.SwiftFilter()
        assert not f.matches(["python", "script.py"])
        assert not f.matches(["cargo", "build"])

    def test_dispatch_routes_swift_build(self) -> None:
        result = bc.select_filter(["swift", "build"])
        assert result is not None
        assert result.name == "swift"

    def test_dispatch_routes_swift_test(self) -> None:
        result = bc.select_filter(["swift", "test"])
        assert result is not None
        assert result.name == "swift"


# ---------------------------------------------------------------------------
# SwiftFilter — build output compression
# ---------------------------------------------------------------------------

_SWIFT_BUILD_OUTPUT = """\
Build complete!
CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift
CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift
CompileSwift normal arm64 /path/to/Sources/MyApp/Network.swift
CompileSwift normal arm64 /path/to/Sources/MyApp/Utils.swift
MergeSwiftModule normal arm64 /path/to/.build/arm64-apple-macosx/debug/MyApp.swiftmodule
Ld /path/to/.build/arm64-apple-macosx/debug/MyApp normal arm64
/path/to/Sources/MyApp/Network.swift:42:5: warning: result of 'send' is unused
Build complete!
"""

_SWIFT_BUILD_ERRORS = """\
CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift
/path/to/Sources/MyApp/main.swift:10:12: error: use of unresolved identifier 'Foo'
/path/to/Sources/MyApp/main.swift:15:8: warning: variable 'x' was never used
CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift
/path/to/Sources/MyApp/Model.swift:5:1: error: expected declaration
"""


class TestSwiftFilterBuild:
    def test_build_complete_preserved(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text
        assert "Build complete!" in out

    def test_compile_lines_collapsed(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text
        # Individual CompileSwift lines should be gone.
        assert "CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift" not in out
        assert "CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift" not in out
        # A collapse marker must appear.
        assert "collapsed" in out
        assert "Swift build-phase lines" in out

    def test_warning_preserved(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text
        assert "warning: result of 'send' is unused" in out

    def test_error_lines_preserved(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_BUILD_ERRORS, "", 1, ["swift", "build"]).text
        assert "error: use of unresolved identifier 'Foo'" in out
        assert "error: expected declaration" in out

    def test_savings_ratio(self) -> None:
        f = bc.SwiftFilter()
        big = "Build complete!\n"
        for i in range(100):
            big += f"CompileSwift normal arm64 /path/to/Sources/App/File{i}.swift\n"
        big += "Build complete!\n"
        result = f.apply(big, "", 0, ["swift", "build"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.70, f"SwiftFilter build savings {ratio:.0%} < 70%"


# ---------------------------------------------------------------------------
# SwiftFilter — test output compression
# ---------------------------------------------------------------------------

_SWIFT_TEST_PASSING = """\
Test Suite 'All tests' started at 2026-05-30 12:00:00.000
Test Suite 'MyAppTests.xctest' started at 2026-05-30 12:00:00.001
Test Suite 'MyAppTests' started at 2026-05-30 12:00:00.002
Test Case '-[MyAppTests.MyAppTests testAddition]' started.
Test Case '-[MyAppTests.MyAppTests testAddition]' passed (0.001 seconds).
Test Case '-[MyAppTests.MyAppTests testSubtraction]' started.
Test Case '-[MyAppTests.MyAppTests testSubtraction]' passed (0.001 seconds).
Test Case '-[MyAppTests.MyAppTests testMultiplication]' started.
Test Case '-[MyAppTests.MyAppTests testMultiplication]' passed (0.001 seconds).
Test Suite 'MyAppTests' passed at 2026-05-30 12:00:00.010.
\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.009) seconds
Test Suite 'MyAppTests.xctest' passed at 2026-05-30 12:00:00.011.
\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.010) seconds
Test Suite 'All tests' passed at 2026-05-30 12:00:00.012.
\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.011) seconds
"""

_SWIFT_TEST_WITH_FAILURE = """\
Test Suite 'All tests' started at 2026-05-30 12:00:00.000
Test Case '-[MyAppTests.MyAppTests testPassing]' started.
Test Case '-[MyAppTests.MyAppTests testPassing]' passed (0.001 seconds).
Test Case '-[MyAppTests.MyAppTests testFailing]' started.
/path/to/Tests/MyAppTests/MyAppTests.swift:25: error: -[MyAppTests.MyAppTests testFailing] : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case '-[MyAppTests.MyAppTests testFailing]' failed (0.002 seconds).
Test Case '-[MyAppTests.MyAppTests testAnotherPassing]' started.
Test Case '-[MyAppTests.MyAppTests testAnotherPassing]' passed (0.001 seconds).
Test Suite 'All tests' failed at 2026-05-30 12:00:00.020.
\t Executed 3 tests, with 1 failure (0 unexpected) in 0.004 (0.020) seconds
"""


class TestSwiftFilterTests:
    def test_passing_tests_collapsed(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_TEST_PASSING, "", 0, ["swift", "test"]).text
        assert "Test Case '-[MyAppTests.MyAppTests testAddition]' passed" not in out
        assert "Test Case '-[MyAppTests.MyAppTests testSubtraction]' passed" not in out
        assert "collapsed" in out
        assert "passing Swift test cases" in out

    def test_suite_summary_preserved(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_TEST_PASSING, "", 0, ["swift", "test"]).text
        # "Executed N tests" lines should survive.
        assert "Executed 3 tests" in out

    def test_failure_preserved(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text
        assert "testFailing" in out
        assert "failed" in out

    def test_failure_body_preserved(self) -> None:
        """The XCTAssertEqual error line after a failing test must survive."""
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text
        assert "XCTAssertEqual failed" in out

    def test_passing_tests_before_failure_collapsed(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text
        # The two passing test cases should be collapsed to a count.
        assert "testPassing]' passed" not in out
        assert "testAnotherPassing]' passed" not in out
        assert "collapsed 2 passing Swift test cases" in out

    def test_savings_ratio_all_passing(self) -> None:
        f = bc.SwiftFilter()
        lines = [
            "Test Suite 'All tests' started at 2026-05-30 12:00:00.000",
        ]
        for i in range(200):
            lines.append(f"Test Case '-[MyTests.TestClass test{i}]' started.")
            lines.append(f"Test Case '-[MyTests.TestClass test{i}]' passed (0.001 seconds).")
        lines.append("Test Suite 'All tests' passed at 2026-05-30 12:00:00.999.")
        lines.append("\t Executed 200 tests, with 0 failures in 0.200 (0.999) seconds")
        big = "\n".join(lines) + "\n"
        result = f.apply(big, "", 0, ["swift", "test"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.70, f"SwiftFilter test savings {ratio:.0%} < 70%"

    def test_empty_input_no_crash(self) -> None:
        f = bc.SwiftFilter()
        out = f.apply("", "", 0, ["swift", "test"]).text
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# XcodeFilter — applies()
# ---------------------------------------------------------------------------


class TestXcodeFilterApplies:
    def test_xcodebuild_matches(self) -> None:
        f = bc.XcodeFilter()
        assert f.matches(["xcodebuild", "-scheme", "MyApp", "-configuration", "Debug"])

    def test_xcodebuild_test_matches(self) -> None:
        f = bc.XcodeFilter()
        assert f.matches(["xcodebuild", "test", "-scheme", "MyApp"])

    def test_xcodebuild_plain_matches(self) -> None:
        f = bc.XcodeFilter()
        assert f.matches(["xcodebuild"])

    def test_unrelated_does_not_match(self) -> None:
        f = bc.XcodeFilter()
        assert not f.matches(["swift", "build"])
        assert not f.matches(["cargo", "build"])
        assert not f.matches(["gradle", "build"])

    def test_dispatch_routes_xcodebuild(self) -> None:
        result = bc.select_filter(["xcodebuild", "-scheme", "MyApp"])
        assert result is not None
        assert result.name == "xcode"


# ---------------------------------------------------------------------------
# XcodeFilter — build output compression
# ---------------------------------------------------------------------------

_XCODE_BUILD_OUTPUT = """\
=== BUILD TARGET MyApp OF PROJECT MyApp WITH CONFIGURATION Debug ===

Check dependencies

CompileSwiftSources normal arm64 com.apple.xcode.tools.swift.compiler
    /path/to/Sources/MyApp/main.swift
    /path/to/Sources/MyApp/Model.swift

CompileSwift normal arm64 /path/to/Sources/MyApp/ContentView.swift (in target 'MyApp' from project 'MyApp')
    cd /path/to
    /usr/bin/swiftc ... -c /path/to/Sources/MyApp/ContentView.swift

CpHeader /path/to/build/MyApp.build/Debug/MyApp.hmap /path/to/Sources/MyApp/include/MyApp.h
    cd /path/to
    builtin-copy -exclude .DS_Store ...

ProcessInfoPlistFile /path/to/build/Debug-iphonesimulator/MyApp.app/Info.plist

/path/to/Sources/MyApp/ContentView.swift:42:5: warning: unused variable 'tmp'

Ld /path/to/build/Debug-iphonesimulator/MyApp.app/MyApp normal arm64
    cd /path/to

CodeSign /path/to/build/Debug-iphonesimulator/MyApp.app

** BUILD SUCCEEDED **
"""

_XCODE_FAILED_OUTPUT = """\
=== BUILD TARGET MyApp OF PROJECT MyApp WITH CONFIGURATION Debug ===

CompileSwiftSources normal arm64 com.apple.xcode.tools.swift.compiler

/path/to/Sources/MyApp/main.swift:10:5: error: use of unresolved identifier 'Bar'
/path/to/Sources/MyApp/main.swift:15:1: error: expected declaration

** BUILD FAILED **
"""


class TestXcodeFilterBuild:
    def test_section_header_preserved(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        assert "=== BUILD TARGET MyApp" in out

    def test_build_succeeded_preserved(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        assert "BUILD SUCCEEDED" in out

    def test_build_failed_preserved(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_FAILED_OUTPUT, "", 1, ["xcodebuild"]).text
        assert "BUILD FAILED" in out

    def test_compile_swift_sources_collapsed(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        # CompileSwiftSources line should be gone.
        assert "CompileSwiftSources normal arm64" not in out
        # A collapse marker must appear.
        assert "collapsed" in out
        assert "xcodebuild build-phase lines" in out

    def test_cp_header_collapsed(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        assert "CpHeader /path/to/build" not in out

    def test_process_info_plist_collapsed(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        assert "ProcessInfoPlistFile" not in out

    def test_warning_preserved(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text
        assert "warning: unused variable 'tmp'" in out

    def test_errors_preserved_on_failure(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply(_XCODE_FAILED_OUTPUT, "", 1, ["xcodebuild"]).text
        assert "error: use of unresolved identifier 'Bar'" in out
        assert "error: expected declaration" in out

    def test_savings_ratio(self) -> None:
        f = bc.XcodeFilter()
        lines = ["=== BUILD TARGET App OF PROJECT App WITH CONFIGURATION Debug ===", ""]
        for i in range(150):
            lines.append(f"CompileSwiftSources normal arm64 file{i}.swift")
            lines.append(f"    /path/to/Sources/App/File{i}.swift")
        for i in range(50):
            lines.append(f"CpHeader /path/to/build/App.build/Debug/header{i}.h")
        lines.append("** BUILD SUCCEEDED **")
        big = "\n".join(lines) + "\n"
        result = f.apply(big, "", 0, ["xcodebuild"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.70, f"XcodeFilter savings {ratio:.0%} < 70%"

    def test_empty_input_no_crash(self) -> None:
        f = bc.XcodeFilter()
        out = f.apply("", "", 0, ["xcodebuild"]).text
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# Registry guards
# ---------------------------------------------------------------------------


def test_swift_and_xcode_in_registry() -> None:
    """Both new filters are registered exactly once and reachable by name."""
    names = [f.name for f in bc.FILTERS]
    assert names.count("swift") == 1
    assert names.count("xcode") == 1
    assert bc.filter_by_name("swift") is not None
    assert bc.filter_by_name("xcode") is not None


def test_swift_routes_correctly() -> None:
    """select_filter(['swift', 'build']) → SwiftFilter."""
    f = bc.select_filter(["swift", "build"])
    assert f is not None
    assert f.name == "swift"


def test_xcode_routes_correctly() -> None:
    """select_filter(['xcodebuild', ...]) → XcodeFilter."""
    f = bc.select_filter(["xcodebuild", "-scheme", "MyApp"])
    assert f is not None
    assert f.name == "xcode"


def test_swift_precedes_python_in_registry() -> None:
    """SwiftFilter must precede PythonFilter (the catch-all) in FILTERS."""
    names = [f.name for f in bc.FILTERS]
    assert "swift" in names and "python" in names
    assert names.index("swift") < names.index("python"), (
        "SwiftFilter must be registered before PythonFilter (catch-all)."
    )


def test_xcode_precedes_python_in_registry() -> None:
    """XcodeFilter must precede PythonFilter in FILTERS."""
    names = [f.name for f in bc.FILTERS]
    assert "xcode" in names and "python" in names
    assert names.index("xcode") < names.index("python"), (
        "XcodeFilter must be registered before PythonFilter (catch-all)."
    )
