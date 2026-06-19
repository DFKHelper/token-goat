"""Tests for the failures command — test output extraction."""
from __future__ import annotations

import pytest

from token_goat.failures import (
    FailureResult,
    extract_failures,
    format_failures_json,
    format_failures_text,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_PYTEST_OUT = """\
========================= test session starts ==========================
collected 3 items

tests/test_auth.py::test_login PASSED
tests/test_auth.py::test_logout FAILED
tests/test_auth.py::test_signup FAILED

================================ FAILURES =================================
_______________________ test_logout ____________________________

    def test_logout():
>       assert session.valid is False
E       AssertionError: assert True is False

tests/test_auth.py:15: AssertionError
_______________________ test_signup ____________________________

    def test_signup():
>       raise ValueError("bad email")
E       ValueError: bad email

tests/test_auth.py:22: ValueError
========================= short test summary info ==========================
FAILED tests/test_auth.py::test_logout - AssertionError
FAILED tests/test_auth.py::test_signup - ValueError
=============== 2 failed, 1 passed in 0.12s ===============
"""

_JEST_OUT = """\
FAIL src/auth.test.js
  ● login › rejects bad password

    Expected: "error"
    Received: "ok"

      12 | expect(result).toBe("error")
      13 |
Tests: 1 failed, 2 passed, 3 total
"""

_GO_OUT = """\
--- FAIL: TestLogin (0.01s)
--- PASS: TestLogout (0.00s)
FAIL\tcmd/server\t0.01s
"""

_CARGO_OUT = """\
test auth::test_login ... FAILED
test auth::test_logout ... ok
test result: FAILED. 1 passed; 1 failed;
"""


@pytest.fixture(scope="module")
def pytest_result() -> FailureResult:
    return extract_failures(_PYTEST_OUT)


@pytest.fixture(scope="module")
def jest_result() -> FailureResult:
    return extract_failures(_JEST_OUT)


# ---------------------------------------------------------------------------
# Detection & extraction
# ---------------------------------------------------------------------------


class TestDetection:
    def test_detects_pytest(self, pytest_result):
        assert pytest_result.runner == "pytest"

    def test_detects_jest(self, jest_result):
        assert jest_result.runner == "jest"

    def test_detects_go(self):
        assert extract_failures(_GO_OUT).runner == "go"

    def test_detects_cargo(self):
        assert extract_failures(_CARGO_OUT).runner == "cargo"

    def test_force_runner(self):
        r = extract_failures(_PYTEST_OUT, runner="go")
        assert r.runner == "go"


class TestPytestExtraction:
    def test_block_count(self, pytest_result):
        assert len(pytest_result.blocks) == 2

    def test_block_names(self, pytest_result):
        names = {b.name for b in pytest_result.blocks}
        assert "test_logout" in names and "test_signup" in names

    def test_block_body_contains_assertion(self, pytest_result):
        logout = next(b for b in pytest_result.blocks if "logout" in b.name)
        assert "AssertionError" in logout.body

    def test_summary_lines(self, pytest_result):
        assert any("test_logout" in s for s in pytest_result.summary_lines)

    def test_no_passing_tests_in_output(self, pytest_result):
        text = format_failures_text(pytest_result)
        assert "PASSED" not in text


class TestJestExtraction:
    def test_finds_block(self, jest_result):
        assert len(jest_result.blocks) >= 1

    def test_block_contains_expected(self, jest_result):
        assert any("Expected" in b.body for b in jest_result.blocks)


class TestGoCargoExtraction:
    def test_go_block_name(self):
        r = extract_failures(_GO_OUT)
        assert any("TestLogin" in b.name for b in r.blocks)

    def test_cargo_block(self):
        r = extract_failures(_CARGO_OUT)
        assert r.count >= 1


class TestEmptyAndEdgeCases:
    def test_empty_input(self):
        r = extract_failures("")
        assert r.count == 0

    def test_all_pass(self):
        text = "1 passed in 0.01s"
        r = extract_failures(text)
        assert r.count == 0

    def test_no_failures_message(self):
        r = extract_failures("")
        assert "No failures" in format_failures_text(r)


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


class TestFormatText:
    def test_includes_fail_label(self, pytest_result):
        out = format_failures_text(pytest_result)
        assert "FAIL" in out

    def test_includes_count(self, pytest_result):
        out = format_failures_text(pytest_result)
        assert "2 failure" in out

    def test_separator_present(self, pytest_result):
        assert "─" in format_failures_text(pytest_result)


class TestFormatJson:
    def test_valid_json_structure(self, pytest_result):
        import json
        data = json.loads(format_failures_json(pytest_result))
        assert data["runner"] == "pytest"
        assert isinstance(data["failures"], list)
        assert data["count"] >= 1
