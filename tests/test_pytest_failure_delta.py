"""Tests for pytest failure delta injection (Iter 10).

Covers:
  - _is_pytest_command detects pytest / py.test / python -m pytest
  - _extract_pytest_failure_ids returns sorted FAILED/ERROR node IDs
  - SessionCache.pytest_failures round-trips through to_dict/from_dict
  - post_bash stores failures on first pytest run (no delta emitted)
  - post_bash emits systemMessage delta on second run with new/fixed failures
  - post_bash suppresses delta when failures are unchanged
  - post_bash suppresses delta when no prior run exists
"""
from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Unit: _is_pytest_command
# ---------------------------------------------------------------------------

class TestIsPytestCommand:
    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.hooks_read import _is_pytest_command
        self.fn = _is_pytest_command

    def test_plain_pytest(self):
        assert self.fn("pytest")

    def test_pytest_with_flags(self):
        assert self.fn("pytest -v -x tests/")

    def test_py_dot_test(self):
        assert self.fn("py.test tests/")

    def test_python_m_pytest(self):
        assert self.fn("python -m pytest tests/")

    def test_not_pytest(self):
        assert not self.fn("rg TODO src/")

    def test_not_pytest_in_path(self):
        # "pytest" embedded in path component should not false-positive
        assert self.fn("/usr/bin/pytest tests/")

    def test_uv_run_pytest(self):
        assert self.fn("uv run pytest -m 'not slow'")


# ---------------------------------------------------------------------------
# Unit: _extract_pytest_failure_ids
# ---------------------------------------------------------------------------

class TestExtractPytestFailureIds:
    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.hooks_read import _extract_pytest_failure_ids
        self.fn = _extract_pytest_failure_ids

    def test_single_failure(self):
        output = "FAILED tests/test_foo.py::test_bar - AssertionError\n"
        assert self.fn(output) == ["tests/test_foo.py::test_bar"]

    def test_multiple_failures(self):
        output = (
            "FAILED tests/test_a.py::test_x\n"
            "FAILED tests/test_b.py::test_y\n"
            "ERROR tests/test_c.py::test_z\n"
        )
        ids = self.fn(output)
        assert ids == sorted(["tests/test_a.py::test_x", "tests/test_b.py::test_y", "tests/test_c.py::test_z"])

    def test_deduplicates(self):
        output = "FAILED tests/test_foo.py::test_bar\nFAILED tests/test_foo.py::test_bar\n"
        assert self.fn(output) == ["tests/test_foo.py::test_bar"]

    def test_ignores_passed_lines(self):
        output = "PASSED tests/test_foo.py::test_ok\nFAILED tests/test_foo.py::test_bad\n"
        assert self.fn(output) == ["tests/test_foo.py::test_bad"]

    def test_empty_output(self):
        assert self.fn("") == []

    def test_no_failures(self):
        output = "1 passed in 0.12s\n"
        assert self.fn(output) == []

    def test_parametrized_with_spaces_in_id(self):
        # Node ID contains spaces (string parameter); suffix must be stripped cleanly
        output = "FAILED tests/test_foo.py::test_bar[hello world] - AssertionError: x != y\n"
        assert self.fn(output) == ["tests/test_foo.py::test_bar[hello world]"]

    def test_strips_exception_suffix(self):
        output = "FAILED tests/test_a.py::test_x - ValueError: bad input\n"
        assert self.fn(output) == ["tests/test_a.py::test_x"]

    def test_error_without_suffix(self):
        output = "ERROR tests/test_a.py\n"
        assert self.fn(output) == ["tests/test_a.py"]


# ---------------------------------------------------------------------------
# Unit: SessionCache.pytest_failures serialization
# ---------------------------------------------------------------------------

class TestPytestFailuresSerialization:
    def test_roundtrip(self):
        from token_goat.session import SessionCache
        cache = SessionCache(session_id="s1", started_ts=0.0, last_activity_ts=0.0)
        cache.pytest_failures = {"abc123": ["tests/a.py::test_x", "tests/b.py::test_y"]}
        d = cache.to_dict()
        assert "pytest_failures" in d
        restored = SessionCache.from_dict(d)
        assert restored.pytest_failures == cache.pytest_failures

    def test_defaults_to_empty(self):
        from token_goat.session import SessionCache
        cache = SessionCache(session_id="s2", started_ts=0.0, last_activity_ts=0.0)
        assert cache.pytest_failures == {}

    def test_from_dict_missing_key(self):
        from token_goat.session import _fresh_cache
        c = _fresh_cache("s3")
        d = c.to_dict()
        d.pop("pytest_failures", None)
        restored = type(c).from_dict(d)
        assert restored.pytest_failures == {}

    def test_from_dict_malformed_values_skipped(self):
        from token_goat.session import _fresh_cache
        c = _fresh_cache("s4")
        d = c.to_dict()
        d["pytest_failures"] = {"good_key": ["tests/a.py::ok"], "bad_key": 42}
        restored = type(c).from_dict(d)
        assert restored.pytest_failures == {"good_key": ["tests/a.py::ok"]}


# ---------------------------------------------------------------------------
# Integration: post_bash failure delta
# ---------------------------------------------------------------------------

def _make_pytest_payload(sid, cmd, stdout, *, exit_code=1, cwd="/proj"):
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


class TestPostBashPytestDelta:
    def test_no_delta_on_first_run(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        output = "FAILED tests/test_a.py::test_x\n1 failed in 0.5s\n" + "x" * 500
        payload = _make_pytest_payload("pd-first", "pytest tests/", output)
        result = post_bash(payload)
        assert result.get("systemMessage") is None

    def test_delta_emitted_on_new_failure(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        cmd = "pytest tests/"
        output1 = "FAILED tests/test_a.py::test_x\n" + "x" * 500
        output2 = "FAILED tests/test_a.py::test_x\nFAILED tests/test_b.py::test_y\n" + "x" * 500
        post_bash(_make_pytest_payload("pd-new", cmd, output1))
        result = post_bash(_make_pytest_payload("pd-new", cmd, output2))
        msg = result.get("systemMessage", "")
        assert "new" in msg
        assert "tests/test_b.py::test_y" in msg

    def test_delta_emitted_on_fixed_failure(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        cmd = "pytest tests/"
        output1 = "FAILED tests/test_a.py::test_x\nFAILED tests/test_b.py::test_y\n" + "x" * 500
        output2 = "FAILED tests/test_a.py::test_x\n" + "x" * 500
        post_bash(_make_pytest_payload("pd-fixed", cmd, output1))
        result = post_bash(_make_pytest_payload("pd-fixed", cmd, output2))
        msg = result.get("systemMessage", "")
        assert "fixed" in msg
        assert "tests/test_b.py::test_y" in msg

    def test_no_delta_when_unchanged(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        cmd = "pytest tests/"
        output = "FAILED tests/test_a.py::test_x\n" + "x" * 500
        post_bash(_make_pytest_payload("pd-same", cmd, output))
        result = post_bash(_make_pytest_payload("pd-same", cmd, output))
        assert result.get("systemMessage") is None

    def test_no_delta_for_non_pytest_command(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        output = "FAILED tests/test_a.py::test_x\n" + "x" * 500
        payload = _make_pytest_payload("pd-notpy", "rg FAILED src/", output)
        post_bash(payload)
        result = post_bash(payload)
        assert result.get("systemMessage") is None

    def test_delta_shows_both_new_and_fixed(self, tmp_data_dir):
        from token_goat.hooks_read import post_bash
        cmd = "pytest tests/"
        output1 = "FAILED tests/test_a.py::test_x\n" + "x" * 500
        output2 = "FAILED tests/test_b.py::test_y\n" + "x" * 500
        post_bash(_make_pytest_payload("pd-both", cmd, output1))
        result = post_bash(_make_pytest_payload("pd-both", cmd, output2))
        msg = result.get("systemMessage", "")
        assert "new" in msg
        assert "fixed" in msg
        assert "tests/test_b.py::test_y" in msg
        assert "tests/test_a.py::test_x" in msg
