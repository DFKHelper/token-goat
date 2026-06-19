"""Tests for the trace command — traceback condenser."""
from __future__ import annotations

import json

import pytest

from token_goat.trace import TraceResult, condense_trace, format_trace_json, format_trace_text

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

_PROJECT_ROOT = "/home/user/myproject"

_SIMPLE = f"""\
Traceback (most recent call last):
  File "{_PROJECT_ROOT}/src/auth.py", line 42, in login
    check_password(user, pwd)
  File "/home/user/.venv/lib/python3.12/site-packages/bcrypt/__init__.py", line 100, in checkpw
    _bcrypt.checkpw(password, hashed_password)
  File "{_PROJECT_ROOT}/src/db.py", line 18, in get_user
    return session.query(User).filter_by(email=email).one()
ValueError: No row found for email
"""

_CHAINED = f"""\
Traceback (most recent call last):
  File "{_PROJECT_ROOT}/src/worker.py", line 10, in run
    process()
KeyError: 'missing_key'

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "{_PROJECT_ROOT}/src/main.py", line 5, in main
    worker.run()
RuntimeError: Worker failed
"""

_ALL_LIB = """\
Traceback (most recent call last):
  File "/usr/lib/python3/dist-packages/requests/api.py", line 72, in get
    return request("get", url, params=params, **kwargs)
ConnectionError: timeout
"""


@pytest.fixture(scope="module")
def simple_result() -> TraceResult:
    return condense_trace(_SIMPLE)


@pytest.fixture(scope="module")
def chained_result() -> TraceResult:
    return condense_trace(_CHAINED)


# ---------------------------------------------------------------------------
# Frame filtering
# ---------------------------------------------------------------------------


class TestFrameFiltering:
    def test_strips_library_frames(self, simple_result):
        for block in simple_result.blocks:
            for frame in block.frames:
                assert "site-packages" not in frame.path

    def test_keeps_project_frames(self, simple_result):
        all_paths = [f.path for b in simple_result.blocks for f in b.frames]
        assert any("auth.py" in p or "db.py" in p for p in all_paths)

    def test_total_frames_counted(self, simple_result):
        assert simple_result.total_frames == 3

    def test_kept_fewer_than_total(self, simple_result):
        assert simple_result.kept_frames < simple_result.total_frames

    def test_all_lib_falls_back_to_last_frames(self):
        r = condense_trace(_ALL_LIB, keep_frames=5)
        assert r.blocks[0].frames  # should not be empty

    def test_keep_param_limits_frames(self):
        r = condense_trace(_SIMPLE, keep_frames=1)
        total_kept = sum(len(b.frames) for b in r.blocks)
        assert total_kept <= 1


class TestExceptionParsing:
    def test_exception_type(self, simple_result):
        assert any(b.exception_type == "ValueError" for b in simple_result.blocks)

    def test_exception_message(self, simple_result):
        assert any("No row found" in b.exception_msg for b in simple_result.blocks)

    def test_chained_blocks(self, chained_result):
        assert len(chained_result.blocks) == 2

    def test_chained_cause_note(self, chained_result):
        # Second block should carry the cause note
        assert any(b.cause_note for b in chained_result.blocks)


class TestEdgeCases:
    def test_empty_input(self):
        r = condense_trace("")
        assert r.blocks == []

    def test_no_traceback_message(self):
        assert "No traceback" in format_trace_text(condense_trace(""))

    def test_bare_exception_type_detected(self):
        r = condense_trace(
            "Traceback (most recent call last):\n"
            f'  File "{_PROJECT_ROOT}/app.py", line 1, in run\n'
            "    signal_handler()\n"
            "KeyboardInterrupt\n"
        )
        assert any(b.exception_type == "KeyboardInterrupt" for b in r.blocks)

    def test_exception_msg_does_not_absorb_frame_line(self):
        text = (
            "Traceback (most recent call last):\n"
            f'  File "{_PROJECT_ROOT}/outer.py", line 1, in outer\n'
            "    inner()\n"
            "RuntimeError: primary failure\n"
            f'  File "{_PROJECT_ROOT}/inner.py", line 5, in inner\n'
            "    do_work()\n"
        )
        r = condense_trace(text)
        exc_msg = r.blocks[0].exception_msg if r.blocks else ""
        assert 'File "' not in exc_msg


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


class TestFormatText:
    def test_contains_condensed_label(self, simple_result):
        assert "condensed" in format_trace_text(simple_result)

    def test_contains_exception_line(self, simple_result):
        out = format_trace_text(simple_result)
        assert "ValueError" in out

    def test_hidden_frames_noted(self, simple_result):
        out = format_trace_text(simple_result)
        assert "hidden" in out


class TestFormatJson:
    def test_valid_json(self, simple_result):
        data = json.loads(format_trace_json(simple_result))
        assert "blocks" in data and "total_frames" in data

    def test_json_block_has_exception(self, simple_result):
        data = json.loads(format_trace_json(simple_result))
        assert any("ValueError" in b["exception"] for b in data["blocks"])
