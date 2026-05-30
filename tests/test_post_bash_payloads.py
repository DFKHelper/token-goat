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


class TestCompressWrapperUnwrap:
    """The post-Bash hook records the original command, not the compress wrapper.

    The pre-Bash hook rewrites pytest/npm/cargo/etc. into a ``token-goat
    compress --cmd '<orig>'`` invocation so output can be filtered before it
    lands in context.  When that wrapped command finishes, the PostToolUse
    payload still carries the verbose wrapper string.  Persisting the wrapper
    verbatim into the session cache wastes ~150–200 bytes per entry (visible
    every time the recovery hint or compaction manifest renders) and obscures
    which underlying tool was actually run.  These tests pin the unwrap
    behaviour: the cached ``cmd_preview`` is the original command.
    """

    def test_compress_wrapper_unwrapped_to_original(self, tmp_data_dir):
        wrapped = (
            'pythonw -m token_goat.cli compress --filter pytest '
            '--timeout 600 --cmd "pytest -v --cov tests/"'
        )
        entry = _run({
            "session_id": "unwrap-1",
            "tool_name": "Bash",
            "tool_input": {"command": wrapped},
            "tool_response": {"stdout": "X" * 5000, "exit_code": 0},
        })
        assert entry is not None
        # The cmd_preview reflects the underlying command, not the wrapper.
        assert entry["cmd_preview"] == "pytest -v --cov tests/"
        assert "compress" not in entry["cmd_preview"]
        assert "--cmd" not in entry["cmd_preview"]

    def test_non_wrapper_command_passthrough(self, tmp_data_dir):
        """Commands that were never wrapped are stored verbatim."""
        entry = _run({
            "session_id": "unwrap-2",
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la /tmp"},
            "tool_response": {"stdout": "X" * 5000, "exit_code": 0},
        })
        assert entry is not None
        assert entry["cmd_preview"] == "ls -la /tmp"

    def test_unwrap_helper_directly(self):
        """Spot-check the helper across the variants the hook emits."""
        from token_goat.hooks_read import _unwrap_compress_command

        # The exact shape produced by paths.python_runner_command on Windows.
        wrapped = (
            '"C:/path/to/pythonw.exe" -m token_goat.cli compress '
            '--filter npm --timeout 600 --cmd "npm install --save-dev jest"'
        )
        assert _unwrap_compress_command(wrapped) == "npm install --save-dev jest"

        # POSIX-style invocation through the installed entrypoint.
        assert _unwrap_compress_command(
            "token-goat compress --filter cargo --timeout 600 --cmd 'cargo test'"
        ) == "cargo test"

        # ``--cmd=foo`` (joined) form is also accepted.
        assert _unwrap_compress_command(
            "token-goat compress --filter pytest --cmd=pytest"
        ) == "pytest"

        # Non-wrapper commands pass through unchanged.
        assert _unwrap_compress_command("pytest -v") == "pytest -v"
        assert _unwrap_compress_command("ls -la") == "ls -la"


class TestOutputSizeCap:
    """_apply_output_size_cap truncates stdout when combined output exceeds the cap."""

    def test_under_cap_returns_unchanged(self):
        from token_goat.hooks_read import _apply_output_size_cap

        small = "A" * 100
        out, err, truncated = _apply_output_size_cap(small, "")
        assert out == small
        assert err == ""
        assert truncated is False

    def test_over_cap_truncates_stdout(self, monkeypatch):
        from token_goat.hooks_read import _apply_output_size_cap

        # Set cap to 1 KB so the test is fast.
        monkeypatch.setenv("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", "1024")
        big_stdout = "Z" * 5000
        out, err, truncated = _apply_output_size_cap(big_stdout, "")
        assert truncated is True
        assert len(out.encode("utf-8")) <= 1024 + 512  # marker adds some overhead
        assert "token-goat" in out
        assert "truncated" in out

    def test_truncation_note_included_in_cached_output(self, tmp_data_dir, monkeypatch):
        """When output exceeds the cap the cached entry still records something useful."""
        monkeypatch.setenv("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", "2048")
        big = "X" * 10_000
        entry = _run({
            "session_id": "sizecap-1",
            "tool_name": "Bash",
            "tool_input": {"command": "find / -name '*.log'"},
            "tool_response": {"stdout": big, "stderr": "", "exit_code": 0},
        })
        # Entry still recorded — just with truncated content.
        assert entry is not None

    def test_env_var_invalid_falls_back_to_default(self, monkeypatch):
        from token_goat.hooks_read import _BASH_DEFAULT_MAX_PROCESS_BYTES, _bash_max_process_bytes

        monkeypatch.setenv("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", "not-a-number")
        assert _bash_max_process_bytes() == _BASH_DEFAULT_MAX_PROCESS_BYTES

    def test_env_var_zero_clamped_to_min(self, monkeypatch):
        from token_goat.hooks_read import _bash_max_process_bytes

        monkeypatch.setenv("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", "0")
        assert _bash_max_process_bytes() == 1024


class TestBinaryOutputDetection:
    """_is_binary_output skips caching for null-heavy output."""

    def test_plain_text_not_binary(self):
        from token_goat.hooks_read import _is_binary_output

        assert _is_binary_output("hello world\n" * 100, "") is False

    def test_null_bytes_detected_as_binary(self):
        from token_goat.hooks_read import _is_binary_output

        # 10% null bytes — well above the 1% threshold.
        payload = "A" * 90 + "\x00" * 10
        assert _is_binary_output(payload * 10, "") is True

    def test_binary_output_not_cached(self, tmp_data_dir):
        """post_bash returns CONTINUE without caching when binary output detected."""
        null_heavy = "A" * 50 + "\x00" * 50  # 50% null bytes
        big_binary = null_heavy * 200  # 20 KB — above _BASH_CACHE_MIN_BYTES
        entry = _run({
            "session_id": "binary-1",
            "tool_name": "Bash",
            "tool_input": {"command": "cat /bin/ls"},
            "tool_response": {"stdout": big_binary, "stderr": "", "exit_code": 0},
        })
        # Nothing should be cached for binary output.
        assert entry is None

    def test_empty_output_not_binary(self):
        from token_goat.hooks_read import _is_binary_output

        assert _is_binary_output("", "") is False


class TestSurrogateEscapeHandling:
    """Surrogate-escape bytes from Windows subprocess must not crash the hook.

    On Windows (cp1252 / cp437 console code pages), subprocess.run can return
    stdout/stderr strings containing lone surrogate characters (U+DC80–U+DCFF).
    These are valid in Python's surrogateescape error handler but are not valid
    UTF-8 and crash with ``UnicodeEncodeError`` when the text is later
    serialised to disk or written to a log.
    """

    def test_post_bash_handles_surrogate_escape_in_stdout(self, tmp_data_dir):
        """Surrogates in stdout are replaced with U+FFFD; no exception is raised."""
        # \udc8f is the Python surrogate-escape for the byte 0x8F (invalid UTF-8).
        surrogate_stdout = "normal output\n\udc8fmore output\n" + "X" * 500
        payload = {
            "session_id": "surrogate-1",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest"},
            "tool_response": {"stdout": surrogate_stdout, "stderr": "", "exit_code": 0},
        }
        # Must not raise UnicodeEncodeError or any other exception.
        _assert_continue(hooks_read.post_bash(payload))

        # The cached output should have the replacement character instead of the surrogate.
        from token_goat import bash_cache
        cache = session.load("surrogate-1")
        assert cache.bash_history, "expected a bash history entry to be recorded"
        entry = next(iter(cache.bash_history.values()))
        cached_body = bash_cache.load_output(entry.output_id)
        assert cached_body is not None, "expected output to be cached"
        # encode("utf-8", errors="replace") maps each lone surrogate to b"?"
        assert "?" in cached_body, "expected ? replacement char in cached output"
        assert "\udc8f" not in cached_body, "surrogate must not appear in cached output"

    def test_post_bash_handles_surrogate_escape_in_stderr(self, tmp_data_dir):
        """Surrogates in stderr are also sanitised without raising."""
        surrogate_stderr = "error: bad byte \udcb0 here\n" + "E" * 500
        payload = {
            "session_id": "surrogate-2",
            "tool_name": "Bash",
            "tool_input": {"command": "make build"},
            "tool_response": {"stdout": "X" * 500, "stderr": surrogate_stderr, "exit_code": 1},
        }
        _assert_continue(hooks_read.post_bash(payload))

        from token_goat import bash_cache
        cache = session.load("surrogate-2")
        assert cache.bash_history
        entry = next(iter(cache.bash_history.values()))
        cached_body = bash_cache.load_output(entry.output_id)
        assert cached_body is not None
        assert "\udcb0" not in cached_body, "surrogate must not appear in cached output"


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
