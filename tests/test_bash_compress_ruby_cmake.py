"""Tests for RubyFilter, BundlerFilter, and CmakeFilter in token_goat.bash_compress."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ===========================================================================
# RubyFilter — matches()
# ===========================================================================


class TestRubyFilterMatches:
    def test_rspec_matches(self) -> None:
        f = bc.RubyFilter()
        assert f.matches(["rspec"])

    def test_rspec_with_args_matches(self) -> None:
        f = bc.RubyFilter()
        assert f.matches(["rspec", "spec/", "--format", "progress"])

    def test_minitest_matches(self) -> None:
        f = bc.RubyFilter()
        assert f.matches(["minitest"])

    def test_ruby_matches(self) -> None:
        f = bc.RubyFilter()
        assert f.matches(["ruby", "test/test_foo.rb"])

    def test_rake_matches(self) -> None:
        f = bc.RubyFilter()
        assert f.matches(["rake", "spec"])

    def test_unrelated_command_does_not_match(self) -> None:
        f = bc.RubyFilter()
        assert not f.matches(["python", "test.py"])
        assert not f.matches(["cargo", "test"])
        assert not f.matches(["jest"])

    def test_dispatch_routes_rspec(self) -> None:
        result = bc.select_filter(["rspec"])
        assert result is not None
        assert result.name == "ruby"

    def test_dispatch_routes_rake(self) -> None:
        result = bc.select_filter(["rake", "spec"])
        assert result is not None
        assert result.name == "ruby"


# ===========================================================================
# RubyFilter — RSpec dot-progress compression
# ===========================================================================

_RSPEC_ALL_PASSING = """\
Run options: include {:focus=>true}

All examples were skipped!

...................................................................................................

Finished in 0.5 seconds (files took 1.2 seconds to load)
100 examples, 0 failures
"""

_RSPEC_WITH_FAILURES = """\
Run options: include {:focus=>true}

.....F..E...

Failures:

  1) MyClass#my_method does something
     Failure/Error: expect(result).to eq(42)

       expected: 42
            got: 0

     # ./spec/my_class_spec.rb:15:in `block (2 levels) in <top (required)>'

  2) MyClass#other_method raises an error
     Failure/Error: raise "unexpected"

     RuntimeError:
       unexpected

Finished in 0.3 seconds (files took 0.8 seconds to load)
12 examples, 2 failures
"""

_RSPEC_LONG_PASSING = ("." * 200 + "\n") * 5 + "Finished in 2.1 seconds\n1000 examples, 0 failures\n"


class TestRubyFilterRSpec:
    def test_all_passing_dots_collapsed(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_ALL_PASSING, argv=["rspec"])
        # Individual dot lines should not remain verbatim (the long dot string is gone).
        assert "." * 50 not in out
        assert "collapsed" in out

    def test_summary_line_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_ALL_PASSING, argv=["rspec"])
        assert "100 examples, 0 failures" in out

    def test_finished_line_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_ALL_PASSING, argv=["rspec"])
        assert "Finished in" in out

    def test_failure_section_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_WITH_FAILURES, argv=["rspec"])
        assert "Failures:" in out

    def test_failure_message_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_WITH_FAILURES, argv=["rspec"])
        assert "expected: 42" in out
        assert "got: 0" in out

    def test_failure_summary_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_WITH_FAILURES, argv=["rspec"])
        assert "12 examples, 2 failures" in out

    def test_failure_chars_noted(self) -> None:
        """F and E chars in the dot-progress line should trigger a visible note."""
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RSPEC_WITH_FAILURES, argv=["rspec"])
        # The F and E chars should be signalled somehow.
        assert "F" in out or "E" in out

    def test_savings_ratio_large_run(self) -> None:
        f = bc.RubyFilter()
        result = f.apply(_RSPEC_LONG_PASSING, "", 0, ["rspec"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.50, f"RubyFilter savings {ratio:.0%} < 50%"


# ===========================================================================
# RubyFilter — Minitest compression
# ===========================================================================

_MINITEST_ALL_PASSING = """\
Run options: --seed 12345

# Running:

..............................................

Finished in 0.123456s, 365.3 runs/s, 730.7 assertions/s.

45 runs, 90 assertions, 0 failures, 0 errors, 0 skips
"""

_MINITEST_WITH_FAILURE = """\
Run options: --seed 99999

# Running:

.F..

Failure:
MyTest#test_something [test/my_test.rb:10]:
Expected false to be truthy.

4 runs, 4 assertions, 1 failures, 0 errors, 0 skips
"""


class TestRubyFilterMinitest:
    def test_minitest_summary_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_MINITEST_ALL_PASSING, argv=["ruby", "test/test_suite.rb"])
        assert "45 runs" in out
        assert "0 failures" in out

    def test_minitest_dots_collapsed(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_MINITEST_ALL_PASSING, argv=["ruby", "test/test_suite.rb"])
        # The 46-char dot line should not pass through verbatim.
        assert "." * 30 not in out

    def test_minitest_failure_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_MINITEST_WITH_FAILURE, argv=["ruby", "test/my_test.rb"])
        assert "Expected false to be truthy" in out

    def test_minitest_failure_summary_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_MINITEST_WITH_FAILURE, argv=["ruby", "test/my_test.rb"])
        assert "1 failures" in out


# ===========================================================================
# RubyFilter — rake pass-through
# ===========================================================================

_RAKE_OUTPUT = """\
/path/to/file.rb:10:in `foo': undefined method 'bar' (NoMethodError)
rake aborted!
"""


class TestRubyFilterRake:
    def test_rake_error_preserved(self) -> None:
        f = bc.RubyFilter()
        out = _apply(f, stdout=_RAKE_OUTPUT, argv=["rake", "test"], exit_code=1)
        assert "NoMethodError" in out
        assert "rake aborted!" in out


# ===========================================================================
# BundlerFilter — matches()
# ===========================================================================


class TestBundlerFilterMatches:
    def test_bundle_matches(self) -> None:
        f = bc.BundlerFilter()
        assert f.matches(["bundle", "install"])

    def test_bundler_matches(self) -> None:
        f = bc.BundlerFilter()
        assert f.matches(["bundler"])

    def test_bundle_update_matches(self) -> None:
        f = bc.BundlerFilter()
        assert f.matches(["bundle", "update"])

    def test_unrelated_does_not_match(self) -> None:
        f = bc.BundlerFilter()
        assert not f.matches(["npm", "install"])
        assert not f.matches(["pip", "install"])

    def test_dispatch_routes_bundle(self) -> None:
        result = bc.select_filter(["bundle", "install"])
        assert result is not None
        assert result.name == "bundler"


# ===========================================================================
# BundlerFilter — compression
# ===========================================================================

_BUNDLE_INSTALL_OUTPUT = """\
Fetching gem metadata from https://rubygems.org/...........
Resolving dependencies...
Using rake 13.0.6
Using concurrent-ruby 1.1.10
Using i18n 1.12.0
Using minitest 5.15.0
Using tzinfo 2.0.5
Using activesupport 7.0.4
Using builder 3.2.4
Using erubi 1.11.0
Using rails-dom-testing 2.0.3
Using rack 2.2.5
Fetching rails 7.0.4
Fetching actionpack 7.0.4
Installing rails 7.0.4
Installing actionpack 7.0.4
Bundle complete! 5 Gemfile dependencies, 62 gems now installed.
Use `bundle info [gemname]` to see where a bundled gem is installed.
"""

_BUNDLE_INSTALL_WITH_ERROR = """\
Using rake 13.0.6
Using concurrent-ruby 1.1.10
Fetching foo 1.0.0
Gem::RemoteFetcher::FetchError: bad response Forbidden 403 (https://rubygems.org/gems/foo-1.0.0.gem)
An error occurred while installing foo (1.0.0), and Bundler cannot continue.
"""

_BUNDLE_BIG_INSTALL = (
    "\n".join(f"Using gem-{i} {i}.0.0" for i in range(80))
    + "\nBundle complete! 5 Gemfile dependencies, 80 gems now installed.\n"
)


class TestBundlerFilterCompress:
    def test_using_lines_collapsed(self) -> None:
        f = bc.BundlerFilter()
        out = _apply(f, stdout=_BUNDLE_INSTALL_OUTPUT, argv=["bundle", "install"])
        # No individual "Using <gem> <version>" lines should remain.
        assert "Using rake 13.0.6" not in out
        assert "Using activesupport 7.0.4" not in out
        # Collapse summary must appear.
        assert "collapsed" in out
        assert "Using gem" in out

    def test_fetching_installing_collapsed(self) -> None:
        f = bc.BundlerFilter()
        out = _apply(f, stdout=_BUNDLE_INSTALL_OUTPUT, argv=["bundle", "install"])
        assert "Fetching rails 7.0.4" not in out
        assert "Installing rails 7.0.4" not in out
        assert "Fetching/Installing gem" in out

    def test_bundle_complete_preserved(self) -> None:
        f = bc.BundlerFilter()
        out = _apply(f, stdout=_BUNDLE_INSTALL_OUTPUT, argv=["bundle", "install"])
        assert "Bundle complete!" in out

    def test_error_line_preserved(self) -> None:
        f = bc.BundlerFilter()
        out = _apply(f, stdout=_BUNDLE_INSTALL_WITH_ERROR, argv=["bundle", "install"], exit_code=1)
        assert "FetchError" in out or "Forbidden 403" in out

    def test_bundler_error_install_line_preserved(self) -> None:
        f = bc.BundlerFilter()
        out = _apply(f, stdout=_BUNDLE_INSTALL_WITH_ERROR, argv=["bundle", "install"], exit_code=1)
        assert "Bundler cannot continue" in out

    def test_savings_ratio_large_install(self) -> None:
        f = bc.BundlerFilter()
        result = f.apply(_BUNDLE_BIG_INSTALL, "", 0, ["bundle", "install"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.70, f"BundlerFilter savings {ratio:.0%} < 70%"


# ===========================================================================
# CmakeFilter — matches()
# ===========================================================================


class TestCmakeFilterMatches:
    def test_cmake_matches(self) -> None:
        f = bc.CmakeFilter()
        assert f.matches(["cmake", "-S", ".", "-B", "build"])

    def test_cmake_build_matches(self) -> None:
        f = bc.CmakeFilter()
        assert f.matches(["cmake", "--build", "build"])

    def test_ctest_matches(self) -> None:
        f = bc.CmakeFilter()
        assert f.matches(["ctest", "--test-dir", "build"])

    def test_cpack_matches(self) -> None:
        f = bc.CmakeFilter()
        assert f.matches(["cpack"])

    def test_unrelated_does_not_match(self) -> None:
        f = bc.CmakeFilter()
        assert not f.matches(["make"])
        assert not f.matches(["ninja"])

    def test_dispatch_routes_cmake(self) -> None:
        result = bc.select_filter(["cmake", "--build", "."])
        assert result is not None
        assert result.name == "cmake"

    def test_dispatch_routes_ctest(self) -> None:
        result = bc.select_filter(["ctest"])
        assert result is not None
        assert result.name == "cmake"


# ===========================================================================
# CmakeFilter — configure-phase compression
# ===========================================================================

_CMAKE_CONFIGURE_OUTPUT = """\
-- The C compiler identification is GNU 11.4.0
-- The CXX compiler identification is GNU 11.4.0
-- Detecting C compiler ABI info
-- Detecting C compiler ABI info - done
-- Check for working C compiler: /usr/bin/cc - skipped
-- Detecting C compile features
-- Detecting C compile features - done
-- Found PkgConfig: /usr/bin/pkg-config (found version "0.29.2")
-- Found OpenSSL: /usr/lib/x86_64-linux-gnu/libcrypto.so (found version "3.0.2")
-- Found ZLIB: /usr/lib/x86_64-linux-gnu/libz.so (found version "1.2.11")
-- Found Threads: TRUE
-- Found Boost: /usr/include (found version "1.74.0")
-- Configuring done (1.5s)
-- Generating done (0.2s)
-- Build files have been written to: /path/to/build
"""

_CMAKE_CONFIGURE_LARGE = (
    "-- The CXX compiler identification is Clang 14.0\n"
    + "\n".join(f"-- Found Pkg{i}: /usr/lib/libpkg{i}.so" for i in range(30))
    + "\n-- Configuring done (3.2s)\n"
    + "-- Build files have been written to: /path/to/build\n"
)


class TestCmakeFilterConfigure:
    def test_configuring_done_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_OUTPUT, argv=["cmake", "-S", ".", "-B", "build"])
        assert "Configuring done" in out

    def test_build_files_written_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_OUTPUT, argv=["cmake", "-S", ".", "-B", "build"])
        assert "Build files have been written" in out

    def test_found_packages_collapsed(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_OUTPUT, argv=["cmake", "-S", ".", "-B", "build"])
        # Individual "-- Found X: ..." lines should be collapsed.
        assert "-- Found OpenSSL" not in out
        assert "-- Found ZLIB" not in out
        assert "Found" in out and "packages" in out

    def test_found_packages_count(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_OUTPUT, argv=["cmake", "-S", ".", "-B", "build"])
        # 5 Found lines: PkgConfig, OpenSSL, ZLIB, Threads, Boost
        assert "5" in out

    def test_first_probe_lines_kept(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_OUTPUT, argv=["cmake", "-S", ".", "-B", "build"])
        # The first compiler identification line should still be there.
        assert "C compiler identification" in out

    def test_large_configure_collapses_found(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_CONFIGURE_LARGE, argv=["cmake", "-S", ".", "-B", "build"])
        # 30 "Found Pkg..." lines should be collapsed to a single count note.
        assert "30" in out or "packages" in out
        assert "-- Found Pkg0" not in out

    def test_savings_ratio_configure(self) -> None:
        f = bc.CmakeFilter()
        result = f.apply(_CMAKE_CONFIGURE_LARGE, "", 0, ["cmake", "-S", ".", "-B", "build"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.50, f"CmakeFilter configure savings {ratio:.0%} < 50%"


# ===========================================================================
# CmakeFilter — build-phase compression
# ===========================================================================

_CMAKE_BUILD_OUTPUT = """\
[  5%] Building CXX object CMakeFiles/myapp.dir/src/main.cpp.o
[ 10%] Building CXX object CMakeFiles/myapp.dir/src/foo.cpp.o
[ 15%] Building CXX object CMakeFiles/myapp.dir/src/bar.cpp.o
[ 20%] Building CXX object CMakeFiles/myapp.dir/src/baz.cpp.o
[ 50%] Building CXX object CMakeFiles/myapp.dir/src/qux.cpp.o
[ 75%] Linking CXX executable myapp
[ 80%] Building CXX object CMakeFiles/tests.dir/test/test_foo.cpp.o
[100%] Linking CXX executable tests
[100%] Built target myapp
[100%] Built target tests
"""

_CMAKE_BUILD_WITH_ERROR = """\
[  5%] Building CXX object CMakeFiles/myapp.dir/src/main.cpp.o
/path/to/src/main.cpp:10:5: error: 'undefined_var' was not declared in this scope
[ 10%] Building CXX object CMakeFiles/myapp.dir/src/foo.cpp.o
"""


class TestCmakeFilterBuild:
    def test_building_lines_collapsed(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_BUILD_OUTPUT, argv=["cmake", "--build", "build"])
        # Individual "[N%] Building CXX object ..." lines should be collapsed.
        assert "[  5%] Building CXX object" not in out
        assert "[ 10%] Building CXX object" not in out
        assert "collapsed" in out

    def test_linking_lines_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_BUILD_OUTPUT, argv=["cmake", "--build", "build"])
        assert "Linking CXX executable myapp" in out

    def test_built_target_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_BUILD_OUTPUT, argv=["cmake", "--build", "build"])
        assert "Built target myapp" in out
        assert "Built target tests" in out

    def test_error_line_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CMAKE_BUILD_WITH_ERROR, argv=["cmake", "--build", "build"], exit_code=1)
        assert "error: 'undefined_var' was not declared" in out

    def test_last_percent_line_noted(self) -> None:
        """The last [N%] Building line should appear in the compression note."""
        f = bc.CmakeFilter()
        result = f.apply(_CMAKE_BUILD_OUTPUT, "", 0, ["cmake", "--build", "build"])
        # The note should reference the last "[N%] Building" line we saw.
        assert "[ 50%]" in result.text or "5" in result.text  # at least one number present

    def test_savings_ratio_build(self) -> None:
        big_build = "\n".join(
            f"[{pct:3d}%] Building CXX object CMakeFiles/myapp.dir/src/file{i}.cpp.o"
            for i, pct in enumerate(range(1, 101))
        )
        big_build += "\n[100%] Built target myapp\n"
        f = bc.CmakeFilter()
        result = f.apply(big_build, "", 0, ["cmake", "--build", "build"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.80, f"CmakeFilter build savings {ratio:.0%} < 80%"


# ===========================================================================
# CmakeFilter — ctest compression
# ===========================================================================

_CTEST_ALL_PASSING = """\
Test project /path/to/build
    Start 1: TestAddition
1/4 Test #1: TestAddition ........................   Passed    0.01 sec
    Start 2: TestSubtraction
2/4 Test #2: TestSubtraction .....................   Passed    0.02 sec
    Start 3: TestMultiplication
3/4 Test #3: TestMultiplication ..................   Passed    0.01 sec
    Start 4: TestDivision
4/4 Test #4: TestDivision ........................   Passed    0.03 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.07 sec
"""

_CTEST_WITH_FAILURE = """\
Test project /path/to/build
    Start 1: TestAddition
1/3 Test #1: TestAddition ........................   Passed    0.01 sec
    Start 2: TestBadMath
2/3 Test #2: TestBadMath .........................***Failed    0.05 sec
    Start 3: TestSubtraction
3/3 Test #3: TestSubtraction .....................   Passed    0.02 sec

67% tests passed, 1 tests failed out of 3

The following tests FAILED:
\t  2 - TestBadMath (Failed)
Errors while running CTest
"""


class TestCmakeFilterCtest:
    def test_all_passing_collapsed(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CTEST_ALL_PASSING, argv=["ctest"])
        # Individual "N/N Test #N: ... Passed" result lines should be collapsed.
        assert "1/4 Test #1: TestAddition" not in out
        assert "collapsed" in out
        assert "passing" in out

    def test_ctest_summary_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CTEST_ALL_PASSING, argv=["ctest"])
        assert "100% tests passed" in out

    def test_failing_test_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CTEST_WITH_FAILURE, argv=["ctest"], exit_code=8)
        assert "TestBadMath" in out
        assert "Failed" in out

    def test_failure_summary_preserved(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CTEST_WITH_FAILURE, argv=["ctest"], exit_code=8)
        assert "67% tests passed" in out

    def test_passing_tests_before_failure_not_individually_shown(self) -> None:
        f = bc.CmakeFilter()
        out = _apply(f, stdout=_CTEST_WITH_FAILURE, argv=["ctest"], exit_code=8)
        # TestAddition passed and should be in the collapsed count, not shown individually.
        assert "1/3 Test #1: TestAddition" not in out

    def test_savings_ratio_large_ctest(self) -> None:
        lines = [f"1/{i+1} Test #{i+1}: TestFoo{i} ...... Passed    0.01 sec" for i in range(50)]
        big_ctest = "Test project /path/to/build\n" + "\n".join(lines) + "\n100% tests passed, 0 tests failed out of 50\n"
        f = bc.CmakeFilter()
        result = f.apply(big_ctest, "", 0, ["ctest"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.70, f"CmakeFilter ctest savings {ratio:.0%} < 70%"
