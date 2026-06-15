"""Tests for CargoFilter in bash_compress.py.

Covers:
  - Compiling lines (<=4) kept in full at the start
  - Compiling lines (>4) collapsed to head+marker+tail
  - Collapse marker contains the suppressed count
  - warning:/error: lines preserved through build compression
  - Finished line preserved
  - Downloading/Updating/Fetching progress lines dropped with note
  - test pass lines suppressed, count in note
  - test fail lines always kept
  - test result: summary line kept
  - No-Compiling output passes through unchanged
  - cargo test flow: build stderr + test stdout sections joined with ---
  - cargo dispatch: build vs test vs clippy vs passthrough
  - clippy: Checking lines dropped, warnings kept
"""
from __future__ import annotations

from token_goat.bash_compress import CargoFilter


def _cf() -> CargoFilter:
    return CargoFilter()


def _compress(stdout: str, stderr: str = "", subcommand: str = "build", exit_code: int = 0) -> str:
    return _cf().compress(stdout, stderr, exit_code, ["cargo", subcommand])


# ---------------------------------------------------------------------------
# Build: Compiling line handling
# ---------------------------------------------------------------------------

def test_few_compiling_lines_kept_verbatim() -> None:
    # 4 compiling lines or fewer are kept in full (no collapse).
    out = "\n".join([
        "   Compiling foo v0.1.0 (/tmp/foo)",
        "   Compiling bar v0.2.0 (/tmp/bar)",
        "    Finished dev [unoptimized + debuginfo] target(s) in 1.2s",
    ])
    result = _compress(out)
    assert "Compiling foo" in result
    assert "Compiling bar" in result
    assert "Finished" in result
    assert "collapsed" not in result


def test_many_compiling_lines_collapsed() -> None:
    # ≥3 Compiling lines → single [compiling N crates…] sentinel (Pass A).
    lines = [f"   Compiling crate_{i} v0.1.{i} (/tmp/c{i})" for i in range(10)]
    lines.append("    Finished dev [unoptimized] target(s) in 3.0s")
    result = _compress("\n".join(lines))
    assert "[compiling 10 crates" in result
    assert "Compiling crate_0" not in result
    assert "Compiling crate_5" not in result


def test_collapse_marker_count_matches_suppressed() -> None:
    lines = [f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(8)]
    result = _compress("\n".join(lines))
    # ≥3 Compiling → single sentinel (Pass A).
    assert "[compiling 8 crates" in result
    assert "Compiling crate_0" not in result


# ---------------------------------------------------------------------------
# Build: warning / error / Finished lines preserved
# ---------------------------------------------------------------------------

def test_warning_lines_preserved() -> None:
    lines = [
        f"   Compiling crate_{i} v0.1.0 (/tmp)" for i in range(6)
    ] + [
        "warning: unused variable `x`",
        "  --> src/main.rs:5:9",
        "    Finished dev [unoptimized] target(s) in 2.1s",
    ]
    result = _compress("\n".join(lines), subcommand="build")
    assert "warning: unused variable" in result
    assert "--> src/main.rs:5:9" in result


def test_error_lines_preserved() -> None:
    lines = [
        "   Compiling myapp v0.1.0 (/tmp/myapp)",
        "   Compiling myapp v0.1.0 (/tmp/myapp)",
        "   Compiling myapp v0.1.0 (/tmp/myapp)",
        "   Compiling myapp v0.1.0 (/tmp/myapp)",
        "   Compiling myapp v0.1.0 (/tmp/myapp)",
        "error[E0282]: type annotations needed",
        "  --> src/lib.rs:3:9",
        "error: aborting due to previous error",
    ]
    result = _compress("\n".join(lines), exit_code=1)
    assert "error[E0282]" in result
    assert "aborting due to previous error" in result


def test_finished_line_suppressed_without_error() -> None:
    # Pass A collapses ≥3 Compiling; Pass C suppresses clean Finished preambles.
    lines = [
        "   Compiling foo v0.1.0 (/tmp/foo)",
        "   Compiling bar v0.1.0 (/tmp/bar)",
        "   Compiling baz v0.1.0 (/tmp/baz)",
        "   Compiling qux v0.1.0 (/tmp/qux)",
        "   Compiling quux v0.1.0 (/tmp/quux)",
        "    Finished release [optimized] target(s) in 10.5s",
    ]
    result = _compress("\n".join(lines))
    assert "[compiling 5 crates" in result
    assert "Finished release" not in result


# ---------------------------------------------------------------------------
# Build: progress lines (Downloading / Updating / Fetching) dropped
# ---------------------------------------------------------------------------

def test_progress_lines_dropped_with_note() -> None:
    lines = [
        "    Updating crates.io index",
        "  Downloading crates ...",
        "  Downloaded serde v1.0.0 (registry+...)",
        "   Compiling serde v1.0.0",
        "    Finished dev [unoptimized] target(s) in 5s",
    ]
    result = _compress("\n".join(lines))
    assert "Updating" not in result
    assert "Downloading" not in result
    assert "downloaded" not in result.lower() or "dropped" in result
    assert "dropped" in result


# ---------------------------------------------------------------------------
# No-Compiling passthrough
# ---------------------------------------------------------------------------

def test_no_compiling_lines_passes_through_unchanged() -> None:
    # Pure non-cargo output (no Compiling, no test ok) should not be modified.
    out = "Hello, world!\nDone in 0ms.\n"
    result = _compress(out)
    assert "Hello, world!" in result
    assert "Done in 0ms." in result
    assert "token-goat" not in result


# ---------------------------------------------------------------------------
# cargo test: pass / fail / summary
# ---------------------------------------------------------------------------

def test_test_pass_lines_suppressed_with_count() -> None:
    stdout = "\n".join([
        "running 3 tests",
        "test foo::bar ... ok",
        "test foo::baz ... ok",
        "test foo::qux ... ok",
        "",
        "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured",
    ])
    result = _compress(stdout, subcommand="test")
    assert "test foo::bar ... ok" not in result
    assert "collapsed 3" in result
    assert "test result: ok. 3 passed" in result


def test_test_fail_lines_always_kept() -> None:
    stdout = "\n".join([
        "running 4 tests",
        "test foo::a ... ok",
        "test foo::b ... ok",
        "test foo::c ... FAILED",
        "test foo::d ... ok",
        "",
        "test result: FAILED. 3 passed; 1 failed; 0 ignored",
    ])
    result = _compress(stdout, subcommand="test")
    assert "test foo::c ... FAILED" in result
    assert "test foo::a ... ok" not in result
    assert "test result: FAILED" in result


def test_test_summary_line_kept() -> None:
    stdout = "\n".join([
        "test alpha ... ok",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ])
    result = _compress(stdout, subcommand="test")
    assert "test result: ok." in result


# ---------------------------------------------------------------------------
# cargo test: build stderr + test stdout joined
# ---------------------------------------------------------------------------

def test_cargo_test_build_stderr_and_test_stdout_joined() -> None:
    # Build noise on stderr, test output on stdout; they should be separated by ---.
    stderr = "\n".join([
        f"   Compiling dep_{i} v0.1.0 (/tmp)" for i in range(6)
    ] + ["    Finished test [unoptimized] target(s) in 2s"])
    stdout = "\n".join([
        "running 1 tests",
        "test my_test ... ok",
        "",
        "test result: ok. 1 passed; 0 failed; 0 ignored",
    ])
    result = _compress(stdout, stderr=stderr, subcommand="test")
    assert "---" in result
    assert "Finished test" in result
    assert "test result: ok." in result


# ---------------------------------------------------------------------------
# cargo clippy: Checking lines dropped, warnings kept
# ---------------------------------------------------------------------------

def test_clippy_checking_lines_dropped() -> None:
    stderr = "\n".join([
        "   Checking myapp v0.1.0 (/tmp/myapp)",
        "   Checking dep v0.2.0 (/tmp/dep)",
        "warning: clippy::needless_return",
        "  --> src/main.rs:10:5",
        "    Finished dev [unoptimized] target(s) in 0.5s",
    ])
    result = _cf().compress("", stderr, 0, ["cargo", "clippy"])
    assert "Checking myapp" not in result
    assert "Checking dep" not in result
    assert "needless_return" in result
    assert "Finished" in result


# ---------------------------------------------------------------------------
# Dispatch: cargo run passes through
# ---------------------------------------------------------------------------

def test_cargo_run_passthrough() -> None:
    # cargo run output is the script's own output — don't suppress it.
    stdout = "Hello from my binary!\nExiting with code 0.\n"
    result = _cf().compress(stdout, "", 0, ["cargo", "run"])
    assert "Hello from my binary!" in result
