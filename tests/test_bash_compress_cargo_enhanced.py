"""Large-scale and edge-case tests for CargoFilter's three compression passes."""

from token_goat.bash_compress import CargoFilter


def _compress(stdout: str, stderr: str = "", subcommand: str = "build", exit_code: int = 0) -> str:
    return CargoFilter().compress(stdout, stderr, exit_code, ["cargo", subcommand])


class TestCompilingSentinelLargeScale:
    """Pass A: ≥3 Compiling lines collapse to a single sentinel."""

    def test_50_compiling_lines_produce_single_sentinel(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.{i} (/tmp/crate_{i})" for i in range(50)]
        out = _compress("\n".join(lines))
        assert "[compiling 50 crates" in out
        # No individual Compiling line should survive
        assert "Compiling crate_0" not in out
        assert "Compiling crate_49" not in out

    def test_sentinel_count_exact_for_50(self) -> None:
        lines = [f"   Compiling dep_{i} v0.2.{i} (/home/user)" for i in range(50)]
        out = _compress("\n".join(lines))
        assert "[compiling 50 crates" in out
        assert "[compiling 49" not in out
        assert "[compiling 51" not in out

    def test_sentinel_appears_before_other_output(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(50)]
        lines.append("error[E0001]: something went wrong")
        out = _compress("\n".join(lines), exit_code=1)
        sentinel_pos = out.index("[compiling 50 crates")
        error_pos = out.index("error[E0001]")
        assert sentinel_pos < error_pos


class TestTestPassSentinelLargeScale:
    """Pass B: 'test … ok' lines collapse to per-binary [N tests passed] sentinel."""

    def test_198_passing_plus_2_failing_produces_sentinel_and_keeps_failures(self) -> None:
        lines = [f"test module::test_{i} ... ok" for i in range(198)]
        lines.append("test module::fail_a ... FAILED")
        lines.append("test module::fail_b ... FAILED")
        stdout = "\n".join(lines)
        out = _compress(stdout, subcommand="test", exit_code=1)
        # Failures are always kept
        assert "test module::fail_a ... FAILED" in out
        assert "test module::fail_b ... FAILED" in out
        # Pass sentinel present
        assert "[198 tests passed]" in out
        # No individual passing line should survive
        assert "test module::test_0 ... ok" not in out
        assert "test module::test_197 ... ok" not in out

    def test_200_passing_no_failures_produces_sentinel(self) -> None:
        lines = [f"test ns::test_{i} ... ok" for i in range(200)]
        stdout = "\n".join(lines)
        out = _compress(stdout, subcommand="test")
        assert "[200 tests passed]" in out
        assert "test ns::test_0 ... ok" not in out

    def test_only_failures_no_sentinel_appended_when_zero_pass(self) -> None:
        lines = ["test a::b ... FAILED", "test a::c ... FAILED"]
        stdout = "\n".join(lines)
        out = _compress(stdout, subcommand="test", exit_code=1)
        assert "test a::b ... FAILED" in out
        assert "test a::c ... FAILED" in out
        assert "tests passed]" not in out


class TestFinishedPreambleSuppression:
    """Pass C: 'Finished …' suppressed on clean build; kept before a failure line."""

    def test_finished_at_end_of_clean_build_suppressed(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(5)]
        lines.append("    Finished dev [unoptimized + debuginfo] target(s) in 4.2s")
        out = _compress("\n".join(lines))
        assert "Finished dev" not in out
        assert "[compiling 5 crates" in out

    def test_finished_before_failure_line_is_kept(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(4)]
        lines += [
            "    Finished dev [unoptimized + debuginfo] target(s) in 2.1s",
            "error[E0308]: mismatched types",
        ]
        out = _compress("\n".join(lines), exit_code=1)
        assert "Finished dev" in out
        assert "error[E0308]" in out

    def test_finished_before_aborting_line_is_kept(self) -> None:
        lines = [f"   Compiling c_{i} v0.1.0 (/tmp)" for i in range(3)]
        lines += [
            "    Finished release [optimized] target(s) in 10.0s",
            "error[E0505]: FAILED something",
        ]
        out = _compress("\n".join(lines), exit_code=1)
        assert "Finished release" in out

    def test_finished_release_suppressed_on_clean_build(self) -> None:
        lines = [f"   Compiling pkg_{i} v1.0.{i} (/workspace)" for i in range(6)]
        lines.append("    Finished release [optimized] target(s) in 30.0s")
        out = _compress("\n".join(lines))
        assert "Finished release" not in out


class TestRunningUnitTestsPreambleSuppression:
    """'Running unittests …' kept before failure; suppressed on clean pass."""

    def test_running_unittests_suppressed_in_passing_test_run(self) -> None:
        stderr = "\n".join(
            [f"   Compiling dep_{i} v0.1.0 (/tmp)" for i in range(4)]
            + ["    Finished test [unoptimized + debuginfo] target(s) in 2s",
               "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)"]
        )
        stdout = "\n".join([
            "running 3 tests",
            "test util::a ... ok",
            "test util::b ... ok",
            "test util::c ... ok",
            "",
            "test result: ok. 3 passed; 0 failed; 0 ignored",
        ])
        out = _compress(stdout, stderr=stderr, subcommand="test")
        assert "Running unittests" not in out
        assert "test result: ok." in out

    def test_running_unittests_kept_when_test_fails(self) -> None:
        stderr = "\n".join(
            [f"   Compiling dep_{i} v0.1.0 (/tmp)" for i in range(4)]
            + ["    Finished test [unoptimized + debuginfo] target(s) in 2s",
               "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)"]
        )
        stdout = "\n".join([
            "running 2 tests",
            "test util::pass_case ... ok",
            "test util::fail_case ... FAILED",
            "",
            "test result: FAILED. 1 passed; 1 failed; 0 ignored",
        ])
        out = _compress(stdout, stderr=stderr, subcommand="test", exit_code=1)
        assert "Running unittests" in out
        assert "test util::fail_case ... FAILED" in out
