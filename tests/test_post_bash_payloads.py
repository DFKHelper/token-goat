"""Robustness tests for `_extract_bash_response` payload-shape handling.

The PostToolUse Bash payload shape varies across harness versions, MCP relay
adapters, and Codex's snake-case wire format.  These tests exercise the
plausible variants we have seen documented or encountered in the wild and
guard the hook against silent breakage when a new harness ships.
"""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_read, session


def _run(payload: dict) -> dict | None:
    """Invoke ``post_bash`` with *payload* and return the recorded session entry.

    Returns ``None`` when the hook chose not to record (small output, missing
    session_id, etc.) so test cases can distinguish "extracted but suppressed"
    from "extracted and recorded".
    """
    _assert_continue(hooks_read.post_bash(payload))
    sid = payload.get("session_id")
    if not sid:
        return None
    cache = session.load(sid)
    if not cache.bash_history:
        return None
    return next(iter(cache.bash_history.values())).__dict__


class TestStandardClaudeShape:
    def test_dict_with_stdout_stderr_exit(self, tmp_data_dir):
        """The documented Claude Code shape: dict under ``tool_response``."""
        big = "X" * 5000
        entry = _run({
            "session_id": "shape-1",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest"},
            "tool_response": {"stdout": big, "stderr": "warn", "exit_code": 1},
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000
        assert entry["stderr_bytes"] == 4
        assert entry["exit_code"] == 1


class TestCodexAlternateKeys:
    def test_returncode_in_place_of_exit_code(self, tmp_data_dir):
        """Older harnesses use ``returncode`` instead of ``exit_code``."""
        entry = _run({
            "session_id": "shape-2",
            "tool_name": "Bash",
            "tool_input": {"command": "make"},
            "tool_response": {"stdout": "X" * 5000, "returncode": 2},
        })
        assert entry is not None
        assert entry["exit_code"] == 2

    def test_output_key_in_place_of_stdout(self, tmp_data_dir):
        entry = _run({
            "session_id": "shape-3",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "tool_response": {"output": "X" * 5000, "exit_code": 0},
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000

    def test_exit_as_string(self, tmp_data_dir):
        """A harness that sends exit as a string (``"0"``) parses cleanly."""
        entry = _run({
            "session_id": "shape-4",
            "tool_name": "Bash",
            "tool_input": {"command": "echo"},
            "tool_response": {"stdout": "X" * 5000, "exit_code": "0"},
        })
        assert entry is not None
        assert entry["exit_code"] == 0


class TestMcpContentArray:
    def test_top_level_content_list(self, tmp_data_dir):
        """An MCP CallToolResult ``content`` array at the top of tool_response."""
        entry = _run({
            "session_id": "shape-5",
            "tool_name": "Bash",
            "tool_input": {"command": "rg foo"},
            "tool_response": {
                "content": [
                    {"type": "text", "text": "X" * 3000},
                    {"type": "text", "text": "Y" * 3000},
                ],
                "exit_code": 0,
            },
        })
        assert entry is not None
        # 3000 + 3000 = 6000 bytes; all should land in stdout.
        assert entry["stdout_bytes"] == 6000

    def test_bare_string_tool_response(self, tmp_data_dir):
        """``tool_response`` itself a string (raw blob, no structured shape)."""
        entry = _run({
            "session_id": "shape-6",
            "tool_name": "Bash",
            "tool_input": {"command": "git log"},
            "tool_response": "X" * 5000,
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000
        assert entry["exit_code"] is None  # No exit code in a bare blob.

    def test_tool_response_as_list(self, tmp_data_dir):
        """``tool_response`` itself an MCP content array (no surrounding dict)."""
        entry = _run({
            "session_id": "shape-7",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "tool_response": [
                {"type": "text", "text": "X" * 5000},
            ],
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000


class TestFallbackKeys:
    def test_tool_result_in_place_of_tool_response(self, tmp_data_dir):
        """Older harness builds nested the response under ``tool_result``."""
        entry = _run({
            "session_id": "shape-8",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest"},
            "tool_result": {"stdout": "X" * 5000, "exit_code": 0},
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000

    def test_top_level_output_field(self, tmp_data_dir):
        """A flattened harness puts ``output`` on the payload itself."""
        entry = _run({
            "session_id": "shape-9",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest"},
            "output": "X" * 5000,
            "exit_code": 0,
        })
        assert entry is not None
        assert entry["stdout_bytes"] == 5000
        assert entry["exit_code"] == 0


class TestMisshapenInputs:
    def test_none_tool_response_no_crash(self, tmp_data_dir):
        _assert_continue(hooks_read.post_bash({
            "session_id": "shape-10",
            "tool_name": "Bash",
            "tool_input": {"command": "echo"},
            "tool_response": None,
        }))

    def test_integer_tool_response_coerces(self, tmp_data_dir):
        """A numeric tool_response is coerced via str() rather than crashing."""
        _assert_continue(hooks_read.post_bash({
            "session_id": "shape-11",
            "tool_name": "Bash",
            "tool_input": {"command": "echo"},
            "tool_response": 42,
        }))

    def test_garbage_payload_returns_continue(self, tmp_data_dir):
        _assert_continue(hooks_read.post_bash({}))
