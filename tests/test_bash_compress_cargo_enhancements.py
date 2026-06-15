"""Tests for CargoFilter iteration-105 enhancements: Pass A, B, C."""
from __future__ import annotations

from token_goat.bash_compress import CargoFilter


def _compress(stdout: str, stderr: str = "", subcommand: str = "build", exit_code: int = 0) -> str:
    return CargoFilter().compress(stdout, stderr, exit_code, ["cargo", subcommand])


# ---------------------------------------------------------------------------
# Pass A: ≥3 Compiling lines collapsed to single sentinel
# ---------------------------------------------------------------------------

class TestCargoPassACompilingSentinel:
    def test_three_compiling_lines_collapsed(self) -> None:
        inp = "\n".join([
            "   Compiling foo v0.1.0 (/tmp/foo)",
            "   Compiling bar v0.2.0 (/tmp/bar)",
            "   Compiling baz v0.3.0 (/tmp/baz)",
        ])
        out = _compress(inp)
        assert "[compiling 3 crates" in out
        assert "Compiling foo" not in out

    def test_two_compiling_lines_kept_verbatim(self) -> None:
        inp = "\n".join([
            "   Compiling foo v0.1.0 (/tmp/foo)",
            "   Compiling bar v0.2.0 (/tmp/bar)",
        ])
        out = _compress(inp)
        assert "Compiling foo" in out
        assert "Compiling bar" in out
        assert "[compiling" not in out

    def test_sentinel_count_matches_line_count(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.{i} (/tmp)" for i in range(7)]
        out = _compress("\n".join(lines))
        assert "[compiling 7 crates" in out


# ---------------------------------------------------------------------------
# Pass B: per-binary test sentinels (cargo test subcommand)
# ---------------------------------------------------------------------------

class TestCargoPassBTestSentinels:
    def test_passing_test_lines_suppressed_with_sentinel(self) -> None:
        stdout = "\n".join([
            "running 3 tests",
            "test foo::a ... ok",
            "test foo::b ... ok",
            "test foo::c ... ok",
            "",
            "test result: ok. 3 passed; 0 failed; 0 ignored",
        ])
        out = _compress(stdout, subcommand="test")
        assert "test foo::a ... ok" not in out
        assert "test result: ok." in out

    def test_failing_test_lines_always_kept(self) -> None:
        stdout = "\n".join([
            "running 2 tests",
            "test foo::a ... ok",
            "test foo::b ... FAILED",
            "",
            "test result: FAILED. 1 passed; 1 failed; 0 ignored",
        ])
        out = _compress(stdout, subcommand="test", exit_code=1)
        assert "test foo::b ... FAILED" in out
        assert "test foo::a ... ok" not in out


# ---------------------------------------------------------------------------
# Pass C: Finished preamble suppression in _compress_build
# ---------------------------------------------------------------------------

class TestCargoPassCPreambleSuppression:
    def test_finished_line_suppressed_on_clean_build(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(5)]
        lines.append("    Finished dev [unoptimized + debuginfo] target(s) in 3.5s")
        out = _compress("\n".join(lines))
        assert "[compiling 5 crates" in out
        assert "Finished dev" not in out

    def test_finished_kept_when_followed_by_error(self) -> None:
        lines = [
            "   Compiling foo v0.1.0 (/tmp)",
            "   Compiling bar v0.1.0 (/tmp)",
            "   Compiling baz v0.1.0 (/tmp)",
            "    Finished dev [unoptimized] target(s) in 1.0s",
            "error[E0001]: something broke",
        ]
        out = _compress("\n".join(lines), exit_code=1)
        assert "Finished dev" in out
        assert "error[E0001]" in out

    def test_running_unittests_suppressed_in_passing_run(self) -> None:
        stderr = "\n".join([
            f"   Compiling dep_{i} v0.1.0 (/tmp)" for i in range(4)
        ] + [
            "    Finished test [unoptimized + debuginfo] target(s) in 2s",
            "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)",
        ])
        stdout = "\n".join([
            "running 1 tests",
            "test it_works ... ok",
            "",
            "test result: ok. 1 passed; 0 failed; 0 ignored",
        ])
        out = _compress(stdout, stderr=stderr, subcommand="test")
        assert "Running unittests" not in out
        assert "test result: ok." in out

    def test_finished_release_suppressed(self) -> None:
        lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(3)]
        lines.append("    Finished release [optimized] target(s) in 10.5s")
        out = _compress("\n".join(lines))
        assert "Finished release" not in out

    def test_finished_kept_with_fewer_than_three_compiling(self) -> None:
        # suppress_finished is gated on len(compiled) >= 3; fewer compiling lines → kept
        lines = [
            "   Compiling foo v0.1.0 (/tmp)",
            "    Finished dev [unoptimized] target(s) in 0.5s",
        ]
        out = _compress("\n".join(lines))
        assert "Finished dev" in out
