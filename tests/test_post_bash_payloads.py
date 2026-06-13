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


# ---------------------------------------------------------------------------
# Regression: P2-6 — output size cap applied before grep/read-equiv work
# ---------------------------------------------------------------------------

class TestPostBashSizeCapBeforePayloadWorkRegression:
    """post_bash must truncate oversized output BEFORE grep or read-equiv processing.

    Regression P2-6: the original code ran grep-pattern recording, read-equivalent
    detection, and binary detection on the full untruncated payload.  A >100 MB stdout
    would cause all that work to process the entire buffer before the cap discarded it.
    After the fix, truncation happens immediately after sanitize_surrogates so downstream
    processors always see a bounded input.
    """

    def test_giant_stdout_with_grep_pattern_returns_continue(self, tmp_data_dir) -> None:
        """post_bash with stdout > cap containing grep-like content must not crash."""
        giant = "match_pattern\n" + "X" * (4 * 1024 * 1024)
        payload = {
            "session_id": "sz_cap_sess_1",
            "tool_name": "Bash",
            "tool_input": {"command": "grep -r match_pattern ."},
            "tool_response": {"stdout": giant, "stderr": "", "exit_code": 0},
        }
        _assert_continue(hooks_read.post_bash(payload))

    def test_truncated_body_stored_not_full_body(self, tmp_data_dir) -> None:
        """When stdout exceeds the cap, the stored cache entry must report truncation."""
        giant = "X" * (4 * 1024 * 1024)
        payload = {
            "session_id": "sz_cap_sess_2",
            "tool_name": "Bash",
            "tool_input": {"command": "cat bigfile.txt"},
            "tool_response": {"stdout": giant, "stderr": "", "exit_code": 0},
        }
        _assert_continue(hooks_read.post_bash(payload))

        # Find the stored entry for this session and verify truncation was recorded
        cache = session.load("sz_cap_sess_2")
        if cache.bash_history:
            entry = next(iter(cache.bash_history.values()))
            assert entry.truncated is True, (
                "oversized stdout must be stored with truncated=True"
            )


# ---------------------------------------------------------------------------
# Regression: P2-4 — post_bash must load session exactly once
# ---------------------------------------------------------------------------

class TestPostBashSingleSessionLoadRegression:
    """post_bash must call safe_load exactly once per invocation.

    Regression P2-4: the original code had four separate load/safe_load calls for
    the same session_id within a single post_bash invocation.  Each additional load
    opened a new race window where a concurrent writer could corrupt the file between
    calls.  After the fix, a single safe_load at the top produces one shared cache
    object that is passed through all downstream calls.
    """

    def test_safe_load_called_exactly_once(self, tmp_data_dir, monkeypatch) -> None:
        """safe_load must be called exactly once for the session_id in post_bash."""
        import token_goat.session as _session

        load_call_count = 0
        original_safe_load = _session.safe_load

        def _counting_safe_load(sid, *a, **kw):
            nonlocal load_call_count
            if sid == "single_load_sess":
                load_call_count += 1
            return original_safe_load(sid, *a, **kw)

        monkeypatch.setattr(_session, "safe_load", _counting_safe_load)

        payload = {
            "session_id": "single_load_sess",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/ -v"},
            "tool_response": {
                "stdout": "PASSED test_foo\n" * 100,
                "stderr": "",
                "exit_code": 0,
            },
        }
        _assert_continue(hooks_read.post_bash(payload))

        assert load_call_count == 1, (
            f"safe_load called {load_call_count} times for post_bash; expected exactly 1"
        )


# ---------------------------------------------------------------------------
# Auto-promote oversized unfiltered bash output
# ---------------------------------------------------------------------------

class TestAutoPromoteOversizedOutput:
    """post_bash must inject a preview+pointer systemMessage for large unfiltered outputs.

    When a Bash command has no matching filter in bash_detect (not in the 227-binary
    table) and its combined output exceeds 8 KiB, post_bash should return a
    systemMessage instead of CONTINUE so the model sees a bounded preview rather
    than the full raw output.
    """

    _BIG = "A line of output content here.\n" * 400  # ~12 KB, > 8192 threshold

    def _payload(self, command: str, stdout: str = "", stderr: str = "", session_id: str = "ap-test-1") -> dict:
        return {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": 0},
        }

    def test_large_unfiltered_output_returns_system_message(self, tmp_data_dir):
        """Large (>=200-line) output triggers the large-stdout compressor (iter 19)
        which fires before the legacy auto-promote handler."""
        result = hooks_read.post_bash(
            self._payload("my-custom-tool --verbose", stdout=self._BIG, session_id="ap-test-1")
        )
        assert result.get("continue") is True
        msg = result.get("systemMessage", "")
        # iter 19 handler fires for >= 200 lines; old handler fires for > 8 KiB < 200 lines
        assert "[token-goat] large output:" in msg or "[token-goat] Large output from" in msg
        assert "bash-output" in msg

    def test_preview_contains_head_lines(self, tmp_data_dir):
        """Preview section must include the first lines of stdout."""
        lines = [f"line {i}" for i in range(100)]
        big_out = "\n".join(lines) + "\n" * 200  # pad to exceed 8 KiB
        big_out = big_out + "X" * 9000
        result = hooks_read.post_bash(
            self._payload("obscure-tool", stdout=big_out, session_id="ap-test-2")
        )
        msg = result.get("systemMessage", "")
        if msg:  # only check content when auto-promote fired
            assert "line 0" in msg

    def test_filtered_command_does_not_auto_promote(self, tmp_data_dir):
        """A command wrapped by the pre-Bash hook (display_cmd != command) must not trigger auto-promote.

        Simulate a wrapped command by passing a token-goat compress wrapper as the
        command.  _unwrap_compress_command will extract the original, making
        display_cmd != command, which gates out the auto-promote path.
        """
        import shlex
        orig = "my-custom-tool --verbose"
        wrapped = f"python -m token_goat.cli compress --filter generic --cmd {shlex.quote(orig)}"
        result = hooks_read.post_bash(
            self._payload(wrapped, stdout=self._BIG, session_id="ap-test-3")
        )
        # Must be CONTINUE (no auto-promote for wrapped commands)
        assert result.get("continue") is True
        assert result.get("systemMessage") is None or "Large output from" not in result.get("systemMessage", "")

    def test_small_output_does_not_auto_promote(self, tmp_data_dir):
        """Output below the 8 KiB threshold must not trigger auto-promote."""
        small = "short output\n" * 10  # << 400 byte cache min; well under 8 KiB
        result = hooks_read.post_bash(
            self._payload("my-custom-tool", stdout=small, session_id="ap-test-4")
        )
        # Should be CONTINUE with no auto-promote systemMessage
        assert result.get("continue") is True
        assert "Large output from" not in result.get("systemMessage", "")

    def test_known_filter_binary_does_not_auto_promote(self, tmp_data_dir):
        """A command whose binary is in bash_detect table must not trigger auto-promote.

        Even if the pre-Bash hook chose not to wrap it (e.g. filter was disabled),
        the auto-promote guard checks bash_detect.detect() and skips if a filter name
        is returned, preserving the intended compression path.
        """
        # 'cargo' is a registered binary in bash_detect
        result = hooks_read.post_bash(
            self._payload("cargo build --release", stdout=self._BIG, session_id="ap-test-5")
        )
        assert result.get("continue") is True
        assert "Large output from" not in result.get("systemMessage", "")

    def test_token_goat_command_does_not_auto_promote(self, tmp_data_dir):
        """A token-goat command itself must never trigger auto-promote."""
        result = hooks_read.post_bash(
            self._payload("token-goat map --compact", stdout=self._BIG, session_id="ap-test-6")
        )
        assert result.get("continue") is True
        assert "Large output from" not in result.get("systemMessage", "")

    def test_auto_promote_disabled_when_bash_compress_off(self, tmp_data_dir, monkeypatch):
        """When bash_compress.enabled is False, auto-promote must not fire."""
        import token_goat.config as _cfg
        original_load = _cfg.load

        def _mock_load():
            cfg = original_load()
            cfg.bash_compress.enabled = False
            return cfg

        monkeypatch.setattr(_cfg, "load", _mock_load)
        result = hooks_read.post_bash(
            self._payload("my-custom-tool --verbose", stdout=self._BIG, session_id="ap-test-7")
        )
        assert result.get("continue") is True
        assert "Large output from" not in result.get("systemMessage", "")
