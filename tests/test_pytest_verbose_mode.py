"""Tests for PytestFilter handling of pytest -v (verbose) progress lines.

Verbose mode emits path-first lines:  tests/foo.py::test_bar PASSED [ 1%]
as opposed to the non-verbose dots line or xdist PASSED-first lines.
"""
from __future__ import annotations

import token_goat.bash_compress as bc


def _apply(text: str, stderr: str = "", exit_code: int = 0) -> str:
    return bc.PytestFilter().apply(text, stderr, exit_code, ["pytest", "-v"]).text


# ---------------------------------------------------------------------------
# Core collapse behaviour
# ---------------------------------------------------------------------------


def test_verbose_passed_collapsed():
    # Path-first PASSED lines (pytest -v format) must be counted and dropped.
    text = (
        "= test session starts =\n"
        "collected 3 items\n\n"
        "tests/test_foo.py::test_a PASSED                                    [  33%]\n"
        "tests/test_foo.py::test_b PASSED                                    [  66%]\n"
        "tests/test_foo.py::test_c PASSED                                    [ 100%]\n"
        "= 3 passed in 0.12s =\n"
    )
    out = _apply(text)
    assert "tests/test_foo.py::test_a PASSED" not in out
    assert "collapsed 3 PASSED" in out
    assert "3 passed" in out


def test_verbose_failed_kept():
    # FAILED verbose lines must be kept even though PASSED lines are dropped.
    text = (
        "= test session starts =\n"
        "collected 3 items\n\n"
        "tests/test_foo.py::test_a PASSED                                    [  33%]\n"
        "tests/test_foo.py::test_b FAILED                                    [  66%]\n"
        "tests/test_foo.py::test_c PASSED                                    [ 100%]\n"
        "= 2 passed, 1 failed in 0.12s =\n"
    )
    out = _apply(text)
    assert "tests/test_foo.py::test_b FAILED" in out
    assert "tests/test_foo.py::test_a PASSED" not in out
    assert "collapsed 2 PASSED" in out


def test_verbose_skipped_with_reason_kept():
    # SKIPPED lines with inline reason text must match and be kept.
    text = (
        "tests/test_foo.py::test_a PASSED                                    [  50%]\n"
        "tests/test_foo.py::test_b SKIPPED (needs network) [100%]\n"
        "= 1 passed, 1 skipped in 0.05s =\n"
    )
    out = _apply(text)
    assert "SKIPPED (needs network)" in out
    assert "collapsed 1 PASSED" in out


def test_verbose_skipped_reason_with_colon_kept():
    # SKIPPED reason text containing a colon (e.g. marker: text) must not break the match.
    text = (
        "tests/test_foo.py::test_a SKIPPED (mark: windows only) [100%]\n"
        "= 1 skipped in 0.01s =\n"
    )
    out = _apply(text)
    assert "SKIPPED (mark: windows only)" in out


def test_verbose_xfail_kept():
    text = (
        "tests/test_foo.py::test_known_bug XFAIL                            [ 100%]\n"
        "= 1 xfailed in 0.02s =\n"
    )
    out = _apply(text)
    assert "XFAIL" in out


def test_verbose_parameterized_passed_collapsed():
    # Parameterized tests: path contains [ ] in the node ID.
    lines = [
        f"tests/test_foo.py::test_bar[param{i}] PASSED                      [{i + 1:3d}%]\n"
        for i in range(10)
    ]
    text = "".join(lines) + "= 10 passed in 0.10s =\n"
    out = _apply(text)
    assert "test_bar[param0] PASSED" not in out
    assert "collapsed 10 PASSED" in out


def test_verbose_mixed_with_traceback():
    # PASSED lines that appear inside a failure traceback (captured output) must NOT be counted.
    text = (
        "= test session starts =\n"
        "tests/test_foo.py::test_a PASSED                                    [  50%]\n"
        "tests/test_foo.py::test_b FAILED                                    [ 100%]\n"
        "= FAILURES =\n"
        "_ test_b _\n"
        "    assert 'tests/foo.py::helper PASSED' in output\n"
        "E   AssertionError\n"
        "= short test summary info =\n"
        "FAILED tests/test_foo.py::test_b\n"
        "= 1 failed, 1 passed in 0.05s =\n"
    )
    out = _apply(text)
    # Progress PASSED line is collapsed.
    assert "collapsed 1 PASSED" in out
    # Traceback content referencing PASSED must survive intact.
    assert "tests/foo.py::helper PASSED" in out


def test_verbose_no_false_positive_in_traceback_assert():
    # A line inside the FAILURES section that contains '::' and 'PASSED'
    # must not be counted as a PASSED progress line.
    text = (
        "= FAILURES =\n"
        "_ test_auth _\n"
        "    assert result == 'tests/test_auth::login PASSED'\n"
        "E   AssertionError\n"
        "= 1 failed in 0.03s =\n"
    )
    out = _apply(text, exit_code=1)
    # The traceback assertion line must survive verbatim.
    assert "tests/test_auth::login PASSED" in out
    # No PASSED collapse — the line is inside in_failures, not a progress line.
    assert "collapsed" not in out


def test_verbose_indented_line_with_path_not_collapsed():
    # Indented lines (e.g. captured stdout inside a test) that happen to
    # contain '::test PASSED' must not be misidentified as progress lines.
    # The regex anchors to a non-whitespace first character.
    text = (
        "= test session starts =\n"
        "tests/test_foo.py::test_a PASSED                                    [ 50%]\n"
        "tests/test_foo.py::test_b PASSED                                    [100%]\n"
        "= 2 passed in 0.05s =\n"
    )
    out = _apply(text)
    # Indented lines should pass through; only the progress lines collapse.
    assert "collapsed 2 PASSED" in out
