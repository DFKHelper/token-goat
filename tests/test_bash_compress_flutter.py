"""Tests for FlutterFilter, DartFilter, and PubFilter in token_goat.bash_compress."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# FlutterFilter — matches()
# ---------------------------------------------------------------------------


class TestFlutterFilterMatches:
    def test_flutter_build_matches(self) -> None:
        f = bc.FlutterFilter()
        assert f.matches(["flutter", "build", "apk"])

    def test_flutter_test_matches(self) -> None:
        f = bc.FlutterFilter()
        assert f.matches(["flutter", "test"])

    def test_flutter_run_matches(self) -> None:
        f = bc.FlutterFilter()
        assert f.matches(["flutter", "run"])

    def test_flutter_pub_get_matches(self) -> None:
        f = bc.FlutterFilter()
        assert f.matches(["flutter", "pub", "get"])

    def test_flutter_without_subcommand_does_not_match(self) -> None:
        f = bc.FlutterFilter()
        assert not f.matches(["flutter"])

    def test_flutter_version_does_not_match(self) -> None:
        f = bc.FlutterFilter()
        # "flutter --version" has no subcommand in our set
        assert not f.matches(["flutter", "--version"])

    def test_unrelated_command_does_not_match(self) -> None:
        f = bc.FlutterFilter()
        assert not f.matches(["dart", "test"])
        assert not f.matches(["cargo", "build"])

    def test_dispatch_routes_flutter_build(self) -> None:
        result = bc.select_filter(["flutter", "build", "apk"])
        assert result is not None
        assert result.name == "flutter"

    def test_dispatch_routes_flutter_test(self) -> None:
        result = bc.select_filter(["flutter", "test"])
        assert result is not None
        assert result.name == "flutter"


# ---------------------------------------------------------------------------
# FlutterFilter — build output compression
# ---------------------------------------------------------------------------

_FLUTTER_BUILD_OUTPUT = """\
Running Gradle task 'assembleRelease'...
Compiling lib/main.dart for target platform android-arm64...
Compiling lib/screens/home.dart for target platform android-arm64...
Compiling lib/screens/settings.dart for target platform android-arm64...
Compiling lib/widgets/button.dart for target platform android-arm64...
Font asset "assets/fonts/Roboto-Regular.ttf"
Font asset "assets/fonts/Roboto-Bold.ttf"
✓ Built build/app/outputs/flutter-apk/app-release.apk (17.2MB)
"""

_FLUTTER_BUILD_WITH_ERROR = """\
Running Gradle task 'assembleDebug'...
Compiling lib/main.dart for target platform android-arm64...
Compiling lib/broken.dart for target platform android-arm64...
Error: lib/broken.dart:10:5: Error: Member not found: 'Foo'.
✓ Built build/app/outputs/flutter-apk/app-debug.apk (12.1MB)
"""


class TestFlutterFilterBuild:
    def test_gradle_line_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_BUILD_OUTPUT, argv=["flutter", "build", "apk"])
        assert "Running Gradle task" in out

    def test_built_line_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_BUILD_OUTPUT, argv=["flutter", "build", "apk"])
        assert "Built build/app" in out

    def test_compiling_lines_collapsed(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_BUILD_OUTPUT, argv=["flutter", "build", "apk"])
        assert "Compiling lib/main.dart" not in out
        assert "Compiling lib/screens/home.dart" not in out
        assert "collapsed" in out
        assert "'Compiling lib/'" in out

    def test_font_asset_lines_collapsed(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_BUILD_OUTPUT, argv=["flutter", "build", "apk"])
        assert "Font asset" not in out or "collapsed" in out
        assert "font asset" in out.lower()

    def test_error_line_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_BUILD_WITH_ERROR, exit_code=1, argv=["flutter", "build", "apk"])
        assert "Error:" in out
        assert "Member not found" in out

    def test_savings_on_large_build(self) -> None:
        lines = ["Running Gradle task 'assembleRelease'..."]
        for i in range(100):
            lines.append(f"Compiling lib/src/file_{i}.dart for target platform android-arm64...")
        for i in range(20):
            lines.append(f"Font asset \"assets/fonts/Font{i}.ttf\"")
        lines.append("✓ Built build/app/outputs/flutter-apk/app-release.apk (18.0MB)")
        stdout = "\n".join(lines) + "\n"
        f = bc.FlutterFilter()
        result = f.apply(stdout, "", 0, ["flutter", "build", "apk"])
        assert result.percent_saved >= 70.0, f"FlutterFilter build savings {result.percent_saved:.0f}% < 70%"

    def test_empty_input_no_crash(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, "", argv=["flutter", "build", "apk"])
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# FlutterFilter — test output compression
# ---------------------------------------------------------------------------

_FLUTTER_TEST_PASSING = """\
00:01 +0: loading /path/to/test/widget_test.dart
00:02 +1: widget renders correctly
00:03 +2: widget handles tap
00:04 +3: All tests passed!
"""

_FLUTTER_TEST_WITH_FAILURES = """\
00:01 +0: loading /path/to/test/widget_test.dart
00:02 +1: widget renders correctly
00:03 +1 -1: Some tests failed.
Error: Test failed. See exception above.
  Expected: <true>
  Actual: <false>
00:04 +1 -1: 1 tests failed.
"""


class TestFlutterFilterTest:
    def test_progress_lines_collapsed(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_TEST_PASSING, argv=["flutter", "test"])
        assert "00:01 +0:" not in out
        assert "00:02 +1:" not in out
        assert "collapsed" in out

    def test_summary_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_TEST_PASSING, argv=["flutter", "test"])
        assert "All tests passed!" in out

    def test_failure_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_TEST_WITH_FAILURES, exit_code=1, argv=["flutter", "test"])
        assert "Error:" in out or "failed" in out

    def test_savings_on_large_test_run(self) -> None:
        lines = []
        for i in range(200):
            lines.append(f"00:{i // 60:02d} +{i}: test_{i} passes")
        lines.append("00:03 +200: All tests passed!")
        stdout = "\n".join(lines) + "\n"
        f = bc.FlutterFilter()
        result = f.apply(stdout, "", 0, ["flutter", "test"])
        assert result.percent_saved >= 70.0, f"FlutterFilter test savings {result.percent_saved:.0f}% < 70%"


# ---------------------------------------------------------------------------
# FlutterFilter — pub get output compression
# ---------------------------------------------------------------------------

_FLUTTER_PUB_OUTPUT = """\
Resolving dependencies...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
+ collection 1.17.0
+ intl 0.18.0
Changed 5 dependencies.
"""

_FLUTTER_PUB_NO_CHANGE = """\
Resolving dependencies...
No dependencies changed.
"""


class TestFlutterFilterPub:
    def test_resolving_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_PUB_OUTPUT, argv=["flutter", "pub", "get"])
        assert "Resolving dependencies" in out

    def test_package_lines_collapsed(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_PUB_OUTPUT, argv=["flutter", "pub", "get"])
        assert "+ http 1.2.0" not in out
        assert "collapsed" in out
        assert "package" in out

    def test_changed_summary_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_PUB_OUTPUT, argv=["flutter", "pub", "get"])
        assert "Changed 5 dependencies" in out

    def test_no_change_preserved(self) -> None:
        f = bc.FlutterFilter()
        out = _apply(f, _FLUTTER_PUB_NO_CHANGE, argv=["flutter", "pub", "get"])
        assert "No dependencies changed" in out

    def test_savings_on_large_pub_get(self) -> None:
        lines = ["Resolving dependencies..."]
        for i in range(100):
            lines.append(f"+ package_{i} 1.0.{i}")
        lines.append("Changed 100 dependencies.")
        stdout = "\n".join(lines) + "\n"
        f = bc.FlutterFilter()
        result = f.apply(stdout, "", 0, ["flutter", "pub", "get"])
        assert result.percent_saved >= 70.0, f"FlutterFilter pub savings {result.percent_saved:.0f}% < 70%"


# ---------------------------------------------------------------------------
# DartFilter — matches()
# ---------------------------------------------------------------------------


class TestDartFilterMatches:
    def test_dart_compile_matches(self) -> None:
        f = bc.DartFilter()
        assert f.matches(["dart", "compile", "exe", "bin/main.dart"])

    def test_dart_test_matches(self) -> None:
        f = bc.DartFilter()
        assert f.matches(["dart", "test"])

    def test_dart_pub_matches(self) -> None:
        f = bc.DartFilter()
        assert f.matches(["dart", "pub", "get"])

    def test_dart_analyze_matches(self) -> None:
        f = bc.DartFilter()
        assert f.matches(["dart", "analyze"])

    def test_dart_run_matches(self) -> None:
        f = bc.DartFilter()
        assert f.matches(["dart", "run"])

    def test_dart_without_subcommand_does_not_match(self) -> None:
        f = bc.DartFilter()
        assert not f.matches(["dart"])

    def test_flutter_does_not_match_dart(self) -> None:
        f = bc.DartFilter()
        assert not f.matches(["flutter", "test"])

    def test_dispatch_routes_dart_analyze(self) -> None:
        result = bc.select_filter(["dart", "analyze"])
        assert result is not None
        assert result.name == "dart"

    def test_dispatch_routes_dart_test(self) -> None:
        result = bc.select_filter(["dart", "test"])
        assert result is not None
        assert result.name == "dart"

    def test_dispatch_routes_dart_pub(self) -> None:
        result = bc.select_filter(["dart", "pub", "get"])
        assert result is not None
        assert result.name == "dart"


# ---------------------------------------------------------------------------
# DartFilter — analyze output
# ---------------------------------------------------------------------------

_DART_ANALYZE_CLEAN = """\
Analyzing lib...
No issues found!
"""

_DART_ANALYZE_WITH_ISSUES = """\
Analyzing lib...
error - lib/src/broken.dart:10:5 - Undefined class 'Foo'. - undefined_class
warning - lib/src/helper.dart:22:3 - Dead code. - dead_code
2 issues found.
"""


class TestDartFilterAnalyze:
    def test_analyzing_header_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_ANALYZE_CLEAN, argv=["dart", "analyze"])
        assert "Analyzing" in out

    def test_no_issues_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_ANALYZE_CLEAN, argv=["dart", "analyze"])
        assert "No issues found!" in out

    def test_issue_lines_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_ANALYZE_WITH_ISSUES, argv=["dart", "analyze"])
        assert "Undefined class 'Foo'" in out
        assert "Dead code" in out

    def test_summary_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_ANALYZE_WITH_ISSUES, argv=["dart", "analyze"])
        assert "2 issues found" in out


# ---------------------------------------------------------------------------
# DartFilter — test output compression
# ---------------------------------------------------------------------------

_DART_TEST_PASSING = """\
00:00 +0: loading test/widget_test.dart
00:01 +1: example test passes
00:02 +2: another test passes
00:03 +3: All tests passed.
"""

_DART_TEST_WITH_FAILURE = """\
00:00 +0: loading test/widget_test.dart
00:01 +1: passing test
00:02 +1 -1: failing test
Error: Expected: <42>
  Actual: <0>
00:03 +1 -1: 1 test failed.
"""


class TestDartFilterTest:
    def test_progress_lines_collapsed(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_TEST_PASSING, argv=["dart", "test"])
        assert "00:00 +0:" not in out
        assert "00:01 +1:" not in out
        assert "collapsed" in out

    def test_summary_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_TEST_PASSING, argv=["dart", "test"])
        assert "All tests passed" in out

    def test_failure_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_TEST_WITH_FAILURE, exit_code=1, argv=["dart", "test"])
        assert "Error:" in out

    def test_savings_on_large_test_run(self) -> None:
        lines = []
        for i in range(200):
            lines.append(f"00:{i // 60:02d} +{i}: test_{i} passes")
        lines.append("00:03 +200: All tests passed.")
        stdout = "\n".join(lines) + "\n"
        f = bc.DartFilter()
        result = f.apply(stdout, "", 0, ["dart", "test"])
        assert result.percent_saved >= 70.0, f"DartFilter test savings {result.percent_saved:.0f}% < 70%"


# ---------------------------------------------------------------------------
# DartFilter — compile output
# ---------------------------------------------------------------------------

_DART_COMPILE_OUTPUT = """\
Compiling bin/main.dart to bin/main...
Generated: /path/to/project/bin/main
"""

_DART_COMPILE_WITH_ERROR = """\
Compiling bin/main.dart to bin/main...
Error: bin/main.dart:5:3: Error: 'Bar' is not a type.
"""


class TestDartFilterCompile:
    def test_compiling_line_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_COMPILE_OUTPUT, argv=["dart", "compile", "exe", "bin/main.dart"])
        assert "Compiling" in out

    def test_generated_line_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_COMPILE_OUTPUT, argv=["dart", "compile", "exe", "bin/main.dart"])
        assert "Generated:" in out

    def test_error_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_COMPILE_WITH_ERROR, exit_code=1,
                     argv=["dart", "compile", "exe", "bin/main.dart"])
        assert "Error:" in out
        assert "'Bar' is not a type" in out


# ---------------------------------------------------------------------------
# DartFilter — pub output compression
# ---------------------------------------------------------------------------

_DART_PUB_OUTPUT = """\
Resolving dependencies...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
Changed 3 dependencies.
"""


class TestDartFilterPub:
    def test_resolving_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_PUB_OUTPUT, argv=["dart", "pub", "get"])
        assert "Resolving dependencies" in out

    def test_package_lines_collapsed(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_PUB_OUTPUT, argv=["dart", "pub", "get"])
        assert "+ http 1.2.0" not in out
        assert "collapsed" in out

    def test_changed_summary_preserved(self) -> None:
        f = bc.DartFilter()
        out = _apply(f, _DART_PUB_OUTPUT, argv=["dart", "pub", "get"])
        assert "Changed 3 dependencies" in out


# ---------------------------------------------------------------------------
# PubFilter — matches()
# ---------------------------------------------------------------------------


class TestPubFilterMatches:
    def test_pub_get_matches(self) -> None:
        f = bc.PubFilter()
        assert f.matches(["pub", "get"])

    def test_pub_upgrade_matches(self) -> None:
        f = bc.PubFilter()
        assert f.matches(["pub", "upgrade"])

    def test_pub_publish_matches(self) -> None:
        f = bc.PubFilter()
        assert f.matches(["pub", "publish"])

    def test_pub_add_matches(self) -> None:
        f = bc.PubFilter()
        assert f.matches(["pub", "add", "http"])

    def test_pub_without_subcommand_does_not_match(self) -> None:
        f = bc.PubFilter()
        assert not f.matches(["pub"])

    def test_dart_pub_does_not_match_pub_filter(self) -> None:
        """dart pub get routes to DartFilter, not PubFilter."""
        f = bc.PubFilter()
        assert not f.matches(["dart", "pub", "get"])

    def test_dispatch_routes_pub_get(self) -> None:
        result = bc.select_filter(["pub", "get"])
        assert result is not None
        assert result.name == "pub"

    def test_dispatch_routes_pub_upgrade(self) -> None:
        result = bc.select_filter(["pub", "upgrade"])
        assert result is not None
        assert result.name == "pub"


# ---------------------------------------------------------------------------
# PubFilter — compression
# ---------------------------------------------------------------------------

_PUB_GET_OUTPUT = """\
Resolving dependencies...
Downloading http 1.2.0...
Downloading path 1.8.3...
Downloading meta 1.9.0...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
> collection 1.17.2 (was 1.17.0)
Changed 4 dependencies.
"""

_PUB_GET_NO_CHANGE = """\
Resolving dependencies...
No dependencies changed.
"""

_PUB_GET_WITH_ERROR = """\
Resolving dependencies...
Error: Package http has no versions that match >=2.0.0.
"""


class TestPubFilterCompression:
    def test_resolving_preserved(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_OUTPUT, argv=["pub", "get"])
        assert "Resolving dependencies" in out

    def test_download_lines_collapsed(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_OUTPUT, argv=["pub", "get"])
        assert "Downloading http 1.2.0" not in out
        assert "collapsed" in out
        assert "download" in out

    def test_package_add_lines_collapsed(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_OUTPUT, argv=["pub", "get"])
        assert "+ http 1.2.0" not in out
        assert "+ path 1.8.3" not in out

    def test_changed_summary_preserved(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_OUTPUT, argv=["pub", "get"])
        assert "Changed 4 dependencies" in out

    def test_no_change_preserved(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_NO_CHANGE, argv=["pub", "get"])
        assert "No dependencies changed" in out

    def test_error_preserved(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, _PUB_GET_WITH_ERROR, exit_code=1, argv=["pub", "get"])
        assert "Error:" in out
        assert "no versions that match" in out

    def test_savings_on_large_pub_get(self) -> None:
        lines = ["Resolving dependencies..."]
        for i in range(50):
            lines.append(f"Downloading package_{i} 1.0.{i}...")
        for i in range(50):
            lines.append(f"+ package_{i} 1.0.{i}")
        lines.append("Changed 50 dependencies.")
        stdout = "\n".join(lines) + "\n"
        f = bc.PubFilter()
        result = f.apply(stdout, "", 0, ["pub", "get"])
        assert result.percent_saved >= 70.0, f"PubFilter savings {result.percent_saved:.0f}% < 70%"

    def test_empty_input_no_crash(self) -> None:
        f = bc.PubFilter()
        out = _apply(f, "", argv=["pub", "get"])
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# Registry guards
# ---------------------------------------------------------------------------


def test_flutter_dart_pub_in_registry() -> None:
    """All three new filters are registered and reachable by name."""
    names = [f.name for f in bc.FILTERS]
    assert names.count("flutter") == 1
    assert names.count("dart") == 1
    assert names.count("pub") == 1
    assert bc.filter_by_name("flutter") is not None
    assert bc.filter_by_name("dart") is not None
    assert bc.filter_by_name("pub") is not None


def test_flutter_precedes_python_in_registry() -> None:
    names = [f.name for f in bc.FILTERS]
    assert "flutter" in names and "python" in names
    assert names.index("flutter") < names.index("python")


def test_dart_precedes_python_in_registry() -> None:
    names = [f.name for f in bc.FILTERS]
    assert "dart" in names and "python" in names
    assert names.index("dart") < names.index("python")


def test_pub_precedes_python_in_registry() -> None:
    names = [f.name for f in bc.FILTERS]
    assert "pub" in names and "python" in names
    assert names.index("pub") < names.index("python")


def test_flutter_routes_correctly() -> None:
    f = bc.select_filter(["flutter", "build", "apk"])
    assert f is not None
    assert f.name == "flutter"


def test_dart_routes_correctly() -> None:
    f = bc.select_filter(["dart", "analyze"])
    assert f is not None
    assert f.name == "dart"


def test_pub_routes_correctly() -> None:
    f = bc.select_filter(["pub", "get"])
    assert f is not None
    assert f.name == "pub"
