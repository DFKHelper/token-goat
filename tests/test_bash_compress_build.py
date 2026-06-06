"""Tests for GradleFilter (extended), AntFilter, and BazelFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# GradleFilter — extended: download progress + daemon messages
# ---------------------------------------------------------------------------


class TestGradleFilterDownloadProgress:
    """GradleFilter collapses download-progress lines into a count summary."""

    GRADLE = bc.GradleFilter()

    def _build_output(self, extra_lines: list[str]) -> str:
        lines = [
            "> Configure project :app",
            "> Task :app:compileJava",
            "Download https://repo.maven.apache.org/maven2/org/foo/foo-1.0.jar",
            "Download https://repo.maven.apache.org/maven2/org/bar/bar-2.0.jar",
            "Download https://repo.maven.apache.org/maven2/org/baz/baz-3.0.jar",
            *extra_lines,
            "BUILD SUCCESSFUL in 12s",
        ]
        return "\n".join(lines)

    def test_download_lines_collapsed_to_note(self) -> None:
        output = self._build_output([])
        argv = ["./gradlew", "build"]
        result = self.GRADLE.apply(output, "", 0, argv)
        assert "collapsed 3 dependency download lines" in result.text
        # None of the raw Download URLs should appear
        assert "https://repo.maven.apache.org" not in result.text

    def test_build_successful_preserved(self) -> None:
        output = self._build_output([])
        argv = ["./gradlew", "build"]
        result = self.GRADLE.apply(output, "", 0, argv)
        assert "BUILD SUCCESSFUL" in result.text

    def test_no_download_lines_no_note(self) -> None:
        output = "\n".join([
            "> Task :app:compileJava",
            "BUILD SUCCESSFUL in 1s",
        ])
        argv = ["./gradlew", "build"]
        result = self.GRADLE.apply(output, "", 0, argv)
        assert "download" not in result.text.lower()

    def test_downloading_prefix_also_collapsed(self) -> None:
        """'Downloading https://...' (progressive participle) is also collapsed."""
        output = "\n".join([
            "Downloading https://plugins.gradle.org/m2/com/foo/foo.jar",
            "Downloading https://plugins.gradle.org/m2/com/bar/bar.jar",
            "BUILD SUCCESSFUL in 5s",
        ])
        argv = ["gradle", "build"]
        result = self.GRADLE.apply(output, "", 0, argv)
        assert "collapsed 2 dependency download lines" in result.text
        assert "plugins.gradle.org" not in result.text


class TestGradleFilterDaemonMessages:
    """GradleFilter drops Gradle Daemon start messages on success."""

    GRADLE = bc.GradleFilter()

    def test_daemon_started_dropped_on_success(self) -> None:
        output = "\n".join([
            "Starting Gradle Daemon...",
            "Gradle Daemon started in 1 s",
            "> Task :app:test",
            "BUILD SUCCESSFUL in 8s",
        ])
        argv = ["./gradlew", "build"]
        result = self.GRADLE.apply(output, "", 0, argv)
        assert "Starting Gradle Daemon" not in result.text
        assert "Daemon started" not in result.text
        assert "dropped" in result.text.lower()

    def test_daemon_on_failure_preserved_in_last_20(self) -> None:
        """On failure (exit_code != 0), last 20 lines are kept verbatim."""
        output = "\n".join([
            "Starting Gradle Daemon...",
            "Daemon started in 2 s",
            "BUILD FAILED",
        ])
        argv = ["./gradlew", "build"]
        result = self.GRADLE.apply(output, "", 1, argv)
        # Failure path: last 20 lines are returned; daemon line may appear
        assert "BUILD FAILED" in result.text


class TestGradleFilterTestTask:
    """GradleFilter handles test task output correctly."""

    GRADLE = bc.GradleFilter()

    def test_test_task_progress_lines_dropped(self) -> None:
        output = "\n".join([
            "> Task :app:compileTestJava",
            "> Task :app:test",
            "3 tests completed, 0 failed",
            "BUILD SUCCESSFUL in 4s",
        ])
        argv = ["./gradlew", "test"]
        result = self.GRADLE.apply(output, "", 0, argv)
        # Task progress lines should be dropped
        assert "> Task :app:test" not in result.text
        # Test summary and build result should be kept (in last-30 tail)
        assert "BUILD SUCCESSFUL" in result.text


# ---------------------------------------------------------------------------
# AntFilter — dispatch + compression
# ---------------------------------------------------------------------------


class TestAntFilterMatches:
    ANT = bc.AntFilter()

    def test_ant_matches(self) -> None:
        assert self.ANT.matches(["ant"])
        assert self.ANT.matches(["ant", "compile"])
        assert self.ANT.matches(["ant", "clean", "build"])

    def test_ant_exe_matches(self) -> None:
        assert self.ANT.matches(["ant.exe"])

    def test_non_ant_no_match(self) -> None:
        assert not self.ANT.matches(["maven"])
        assert not self.ANT.matches(["gradle"])
        assert not self.ANT.matches([])

    def test_dispatch_routes_to_ant(self) -> None:
        f = bc.select_filter(["ant", "compile"])
        assert f is not None
        assert f.name == "ant"


_ANT_LONG_OUTPUT = """\
Buildfile: build.xml

init:
   [mkdir] Created dir: /project/build
   [mkdir] Created dir: /project/dist

compile:
   [echo] Compiling sources...
   [javac] Compiling 42 source files to /project/build
   [echo] Done compiling.
   [copy] Copying 10 files to /project/build
   [copy] Copying 5 files to /project/dist

BUILD SUCCESSFUL
Total time: 3 seconds
"""


class TestAntFilterBuildSuccessful:
    ANT = bc.AntFilter()

    def test_build_successful_preserved(self) -> None:
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        assert "BUILD SUCCESSFUL" in result

    def test_echo_lines_collapsed(self) -> None:
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        # Raw [echo] lines should not appear; they're collapsed to a count
        assert "[echo] Compiling sources..." not in result
        assert "[echo] Done compiling." not in result
        assert "[echo]" not in result or "×" in result or "collapsed" in result

    def test_mkdir_lines_collapsed(self) -> None:
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        assert "[mkdir] Created dir: /project/build" not in result
        # Should have a count note
        assert "mkdir" in result

    def test_copy_lines_collapsed(self) -> None:
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        assert "[copy] Copying 10 files" not in result

    def test_javac_non_diag_passed_through(self) -> None:
        """[javac] lines that are not error/warning pass through (they carry info)."""
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        # The [javac] compilation line is not a diagnostic — passes through
        assert "[javac] Compiling 42 source files" in result

    def test_total_time_preserved(self) -> None:
        result = _compress(self.ANT, _ANT_LONG_OUTPUT)
        assert "Total time" in result


_ANT_FAIL_OUTPUT = """\
compile:
   [echo] Compiling...
   [javac] Compiling 5 source files
   [javac] /project/src/Main.java:10: error: ';' expected
   [javac] /project/src/Main.java:15: warning: unchecked cast

BUILD FAILED
/project/build.xml:25: Compile failed; see the compiler error output for details.

Total time: 1 second
"""


class TestAntFilterBuildFailed:
    ANT = bc.AntFilter()

    def test_build_failed_preserved(self) -> None:
        result = _compress(self.ANT, _ANT_FAIL_OUTPUT)
        assert "BUILD FAILED" in result

    def test_javac_error_preserved(self) -> None:
        result = _compress(self.ANT, _ANT_FAIL_OUTPUT)
        assert "error: ';' expected" in result

    def test_javac_warning_preserved(self) -> None:
        result = _compress(self.ANT, _ANT_FAIL_OUTPUT)
        assert "warning: unchecked cast" in result

    def test_echo_lines_still_collapsed_on_failure(self) -> None:
        result = _compress(self.ANT, _ANT_FAIL_OUTPUT)
        # Even on failure the echo lines are collapsed (not in path through filter)
        assert "[echo] Compiling..." not in result


class TestAntFilterSavings:
    ANT = bc.AntFilter()

    def test_savings_on_verbose_build(self) -> None:
        # Build with 50 [echo] and 50 [copy] lines — should compress well
        echo_lines = [f"   [echo] Processing file {i}" for i in range(50)]
        copy_lines = [f"   [copy] Copying file{i}.jar" for i in range(50)]
        output = "\n".join(["compile:"] + echo_lines + copy_lines + ["BUILD SUCCESSFUL"])
        result = self.ANT.apply(output, "", 0, ["ant", "compile"])
        assert result.percent_saved > 50, (
            f"Expected >50% savings on verbose ant build, got {result.percent_saved:.1f}%"
        )


# ---------------------------------------------------------------------------
# BazelFilter — dispatch + compression
# ---------------------------------------------------------------------------


class TestBazelFilterMatches:
    BAZEL = bc.BazelFilter()

    def test_bazel_build_matches(self) -> None:
        assert self.BAZEL.matches(["bazel", "build", "//..."])

    def test_bazel_test_matches(self) -> None:
        assert self.BAZEL.matches(["bazel", "test", "//..."])

    def test_bazel_run_matches(self) -> None:
        assert self.BAZEL.matches(["bazel", "run", "//app:main"])

    def test_bazelisk_matches(self) -> None:
        assert self.BAZEL.matches(["bazelisk", "build", "//..."])

    def test_non_bazel_no_match(self) -> None:
        assert not self.BAZEL.matches(["gradle"])
        assert not self.BAZEL.matches(["make"])
        assert not self.BAZEL.matches([])

    def test_dispatch_routes_to_bazel(self) -> None:
        f = bc.select_filter(["bazel", "build", "//..."])
        assert f is not None
        assert f.name == "bazel"

    def test_bazelisk_dispatch(self) -> None:
        f = bc.select_filter(["bazelisk", "test", "//..."])
        assert f is not None
        assert f.name == "bazel"


_BAZEL_BUILD_OUTPUT = """\
INFO: Analyzed 42 targets (120 packages loaded, 3400 targets configured).
INFO: Found 42 targets...
INFO: From Compiling src/main/java/com/example/Foo.java:
INFO: From Compiling src/main/java/com/example/Bar.java:
INFO: From Compiling src/main/java/com/example/Baz.java:
INFO: From Linking //src/main:app:
INFO: Build option --compilation_mode has changed, discarding analysis cache.
Build completed successfully, 45 total actions
Elapsed time: 15.234s, Critical Path: 8.5s
"""


class TestBazelFilterBuildOutput:
    BAZEL = bc.BazelFilter()

    def test_analyzed_targets_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        assert "INFO: Analyzed 42 targets" in result

    def test_found_targets_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        assert "INFO: Found 42 targets" in result

    def test_compile_actions_collapsed(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        assert "INFO: From Compiling src/main/java/com/example/Foo.java" not in result
        assert "collapsed" in result.lower() and "compile" in result.lower()

    def test_elapsed_time_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        assert "Elapsed time: 15.234s" in result

    def test_build_completed_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        assert "Build completed successfully" in result

    def test_misc_info_progress_collapsed(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_BUILD_OUTPUT)
        # "Build option --compilation_mode has changed..." is a misc INFO line
        assert "compilation_mode" not in result


_BAZEL_TEST_OUTPUT = """\
INFO: Analyzed 10 targets (5 packages loaded, 200 targets configured).
INFO: Found 10 test targets...
//com/example:FooTest                                        PASSED in 0.5s
//com/example:BarTest                                        PASSED in 1.2s
//com/example:BazTest                                        PASSED in 0.3s
//com/example:QuxTest                                        FAILED in 2.1s
  /tmp/bazel-test/_objs/BazTest/test.log
//com/example:QuuxTest                                       PASSED in 0.8s
Elapsed time: 5.6s, Critical Path: 2.1s
INFO: Build completed, 1 test FAILED, 10 total actions
"""


class TestBazelFilterTestOutput:
    BAZEL = bc.BazelFilter()

    def test_passing_tests_collapsed(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_TEST_OUTPUT)
        assert "//com/example:FooTest" not in result
        assert "//com/example:BarTest" not in result
        assert "//com/example:QuuxTest" not in result
        assert "collapsed 4 PASSED test targets" in result

    def test_failed_test_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_TEST_OUTPUT)
        assert "//com/example:QuxTest" in result
        assert "FAILED in 2.1s" in result

    def test_elapsed_time_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_TEST_OUTPUT)
        assert "Elapsed time: 5.6s" in result

    def test_analyzed_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_TEST_OUTPUT)
        assert "INFO: Analyzed 10 targets" in result


_BAZEL_FAIL_OUTPUT = """\
INFO: Analyzed 5 targets.
INFO: From Compiling src/main.cc:
ERROR: /workspace/BUILD:10:5: CppCompile src/main.cc failed: (Exit 1): bash failed
src/main.cc:25:3: error: use of undeclared identifier 'foo'
FAILED: Build did NOT complete successfully
Elapsed time: 3.2s, Critical Path: 3.2s
"""


class TestBazelFilterBuildFailed:
    BAZEL = bc.BazelFilter()

    def test_failed_banner_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_FAIL_OUTPUT)
        assert "FAILED: Build did NOT complete successfully" in result

    def test_error_line_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_FAIL_OUTPUT)
        assert "ERROR:" in result

    def test_elapsed_time_kept(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_FAIL_OUTPUT)
        assert "Elapsed time: 3.2s" in result

    def test_compile_action_still_collapsed(self) -> None:
        result = _compress(self.BAZEL, _BAZEL_FAIL_OUTPUT)
        assert "INFO: From Compiling src/main.cc:" not in result


class TestBazelFilterSavings:
    BAZEL = bc.BazelFilter()

    def test_savings_on_large_build(self) -> None:
        compile_lines = [
            f"INFO: From Compiling src/module_{i}/file.cc:" for i in range(100)
        ]
        info_lines = [
            f"INFO: Running action {i}..." for i in range(50)
        ]
        pass_lines = [
            f"//test:Test{i}                              PASSED in 0.{i}s"
            for i in range(30)
        ]
        output = "\n".join([
            "INFO: Analyzed 130 targets.",
            "INFO: Found 130 targets...",
            *compile_lines,
            *info_lines,
            *pass_lines,
            "Elapsed time: 120.5s",
            "Build completed successfully, 180 total actions",
        ])
        result = self.BAZEL.apply(output, "", 0, ["bazel", "build", "//..."])
        assert result.percent_saved > 70, (
            f"Expected >70% savings on large bazel build, got {result.percent_saved:.1f}%"
        )
