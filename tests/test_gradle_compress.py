"""Tests for the enhanced GradleFilter state machine.

Covers:
- Successful build: noise collapsed, BUILD SUCCESSFUL kept
- Failed build: FAILURE block, task FAILED line, stacktrace frame limits
- ./gradlew path dispatch
- Test run: PASSED/SKIPPED method lines dropped, completion summary kept
- Build scan lines dropped
- Deprecation / See-docs lines dropped
- Compile error lines kept
- Daemon messages dropped
- Subcommand routing (assemble, jar, war, bootjar, clean)
- Exception / Caused by: stack trace tracking
"""
from __future__ import annotations

from token_goat import bash_compress as bc

GRADLE = bc.GradleFilter()


def _apply(stdout: str, argv: list[str], *, exit_code: int = 0) -> str:
    return GRADLE.apply(stdout, "", exit_code, argv).text


# ---------------------------------------------------------------------------
# Successful build -- noise collapsed, result kept
# ---------------------------------------------------------------------------


class TestSuccessfulBuild:
    def test_build_successful_always_kept(self) -> None:
        out = "\n".join([
            "> Configure project :app",
            "> Task :app:compileJava",
            "BUILD SUCCESSFUL in 5s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "BUILD SUCCESSFUL" in result

    def test_download_lines_dropped(self) -> None:
        out = "\n".join([
            "Download https://repo1.maven.org/maven2/org/foo/foo-1.0.jar",
            "Downloading https://plugins.gradle.org/m2/bar/bar-2.0.jar",
            "BUILD SUCCESSFUL in 10s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "repo1.maven.org" not in result
        assert "plugins.gradle.org" not in result
        assert "collapsed 2 dependency download lines" in result

    def test_task_progress_lines_dropped(self) -> None:
        out = "\n".join([
            "> Configure project :app",
            "> Task :app:compileJava",
            "> Task :app:processResources",
            "BUILD SUCCESSFUL in 3s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "> Task :app:compileJava" not in result
        assert "> Configure project" not in result
        assert "dropped" in result

    def test_daemon_messages_dropped(self) -> None:
        out = "\n".join([
            "Starting Gradle Daemon...",
            "Gradle Daemon started in 1.234 s",
            "> Task :app:build",
            "BUILD SUCCESSFUL in 8s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "Starting Gradle Daemon" not in result
        assert "Daemon started" not in result
        assert "dropped" in result

    def test_gradlew_path_prefix_handled(self) -> None:
        """./gradlew argv[0] is resolved to stem 'gradlew' -- filter matches."""
        out = "BUILD SUCCESSFUL in 1s"
        result = _apply(out, ["./gradlew", "build"])
        assert "BUILD SUCCESSFUL" in result

    def test_build_failed_line_always_kept(self) -> None:
        out = "\n".join([
            "> Task :app:test FAILED",
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "BUILD FAILED" in result


# ---------------------------------------------------------------------------
# Subcommand routing
# ---------------------------------------------------------------------------


class TestSubcommandRouting:
    def test_assemble_routes_to_compress_build(self) -> None:
        out = "\n".join([
            "> Task :app:assemble",
            "BUILD SUCCESSFUL in 2s",
        ])
        result = _apply(out, ["./gradlew", "assemble"])
        assert "BUILD SUCCESSFUL" in result
        assert "> Task :app:assemble" not in result

    def test_jar_subcommand_routes_to_compress_build(self) -> None:
        out = "\n".join([
            "> Task :lib:jar",
            "BUILD SUCCESSFUL in 1s",
        ])
        result = _apply(out, ["gradle", "jar"])
        assert "BUILD SUCCESSFUL" in result

    def test_clean_subcommand_routes_to_compress_build(self) -> None:
        out = "\n".join([
            "> Task :app:clean",
            "BUILD SUCCESSFUL in 0s",
        ])
        result = _apply(out, ["./gradlew", "clean"])
        assert "BUILD SUCCESSFUL" in result

    def test_bootjar_subcommand_matches(self) -> None:
        assert GRADLE.matches(["./gradlew", "bootJar"])
        assert GRADLE.matches(["gradlew", "bootjar"])


# ---------------------------------------------------------------------------
# Failed build -- FAILURE block and stacktrace limits
# ---------------------------------------------------------------------------


class TestFailedBuild:
    def _failed_output(self, *, extra_frames: int = 0) -> str:
        frames = [f"        at com.example.Foo.method{i}(Foo.java:{i})" for i in range(extra_frames)]
        lines = [
            "> Task :app:compileJava FAILED",
            "",
            "FAILURE: Build failed with an exception.",
            "",
            "* What went wrong:",
            "Execution failed for task ':app:compileJava'.",
            "> Could not compile Java.",
            "",
            *frames,
            "BUILD FAILED",
        ]
        return "\n".join(lines)

    def test_task_failed_line_kept(self) -> None:
        result = _apply(self._failed_output(), ["./gradlew", "build"])
        assert "> Task :app:compileJava FAILED" in result

    def test_failure_header_kept(self) -> None:
        result = _apply(self._failed_output(), ["./gradlew", "build"])
        assert "FAILURE: Build failed with an exception." in result

    def test_what_went_wrong_kept(self) -> None:
        result = _apply(self._failed_output(), ["./gradlew", "build"])
        assert "* What went wrong:" in result

    def test_stacktrace_first_10_frames_kept(self) -> None:
        out = "\n".join([
            "> Task :app:test FAILED",
            "org.gradle.api.GradleException: compilation failed",
            *[f"    at com.example.Cls.m{i}(Cls.java:{i})" for i in range(15)],
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        # First 10 frames must appear
        for i in range(10):
            assert f"m{i}(Cls.java:{i})" in result

    def test_excess_stacktrace_frames_dropped(self) -> None:
        out = "\n".join([
            "> Task :app:test FAILED",
            "org.gradle.api.GradleException: compilation failed",
            *[f"    at com.example.Cls.m{i}(Cls.java:{i})" for i in range(15)],
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        # Frames 10-14 must NOT appear
        for i in range(10, 15):
            assert f"m{i}(Cls.java:{i})" not in result
        assert "dropped" in result

    def test_compile_error_line_kept(self) -> None:
        out = "\n".join([
            "> Task :app:compileJava FAILED",
            "src/main/java/Foo.java:10: error: ';' expected",
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "error: ';' expected" in result

    def test_exception_line_starts_stack_trace(self) -> None:
        out = "\n".join([
            "FAILURE: Build failed with an exception.",
            "* What went wrong:",
            "java.lang.RuntimeException: something went wrong",
            *[f"    at com.example.Foo.m{i}(Foo.java:{i})" for i in range(12)],
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        # RuntimeException line kept, first 10 frames kept, excess dropped
        assert "RuntimeException" in result
        for i in range(10):
            assert f"m{i}(Foo.java:{i})" in result
        for i in range(10, 12):
            assert f"m{i}(Foo.java:{i})" not in result

    def test_caused_by_kept(self) -> None:
        out = "\n".join([
            "FAILURE: Build failed with an exception.",
            "* What went wrong:",
            "Execution failed for task ':app:test'.",
            "> Caused by: java.lang.NullPointerException",
            "    at com.example.Foo.bar(Foo.java:5)",
            "BUILD FAILED",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "Caused by: java.lang.NullPointerException" in result


# ---------------------------------------------------------------------------
# Test run output
# ---------------------------------------------------------------------------


class TestTestRun:
    def test_passed_method_lines_dropped(self) -> None:
        out = "\n".join([
            "> Task :app:test",
            "com.example.SomeTest > testAdd() PASSED",
            "com.example.SomeTest > testSubtract() PASSED",
            "com.example.SomeTest > testDivide() SKIPPED",
            "2 tests completed, 0 failed",
            "BUILD SUCCESSFUL in 6s",
        ])
        result = _apply(out, ["./gradlew", "test"])
        assert "testAdd() PASSED" not in result
        assert "testSubtract() PASSED" not in result
        assert "testDivide() SKIPPED" not in result
        assert "dropped" in result

    def test_test_completion_summary_kept(self) -> None:
        out = "\n".join([
            "com.example.SomeTest > testAdd() PASSED",
            "2 tests completed, 0 failed",
            "BUILD SUCCESSFUL in 4s",
        ])
        result = _apply(out, ["./gradlew", "test"])
        assert "2 tests completed, 0 failed" in result

    def test_build_successful_kept_in_test_run(self) -> None:
        out = "\n".join([
            "> Task :app:test",
            "com.example.T > testA() PASSED",
            "1 tests completed, 0 failed",
            "BUILD SUCCESSFUL in 2s",
        ])
        result = _apply(out, ["./gradlew", "test"])
        assert "BUILD SUCCESSFUL" in result


# ---------------------------------------------------------------------------
# Build scan and deprecation noise
# ---------------------------------------------------------------------------


class TestNoiseDropped:
    def test_build_scan_publishing_dropped(self) -> None:
        out = "\n".join([
            "> Task :app:build",
            "Publishing build scan...",
            "https://scans.gradle.com/s/abc123xyz",
            "BUILD SUCCESSFUL in 7s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "Publishing build scan" not in result
        assert "scans.gradle.com" not in result
        assert "dropped" in result

    def test_deprecation_warning_dropped(self) -> None:
        out = "\n".join([
            "> Task :app:build",
            "> The compile configuration has been deprecated",
            "See https://docs.gradle.org/current/userguide/...",
            "BUILD SUCCESSFUL in 3s",
        ])
        result = _apply(out, ["./gradlew", "build"])
        assert "has been deprecated" not in result
        assert "docs.gradle.org" not in result
        assert "dropped" in result
