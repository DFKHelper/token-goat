"""Tests for the bash-compression rewrite path in token_goat.hooks_read.pre_read."""
from __future__ import annotations

import pytest

from token_goat import hooks_cli, hooks_read


def _payload(cmd: str, *, session_id: str = "s1") -> dict:
    """Build a minimal Bash PreToolUse payload."""
    return {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "cwd": "/tmp",
    }


def _dispatch(payload: dict) -> dict:
    """Dispatch a pre-read hook event end-to-end and return the response."""
    return hooks_cli.dispatch("pre-read", payload)


# ---------------------------------------------------------------------------
# Wrapping fires for compressible commands
# ---------------------------------------------------------------------------


class TestRewriteFires:
    def test_pytest_command_gets_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("pytest tests/"))
        assert "hookSpecificOutput" in result
        hso = result["hookSpecificOutput"]
        assert "updatedInput" in hso
        new_cmd = hso["updatedInput"]["command"]
        assert "token_goat.cli" in new_cmd
        assert "compress" in new_cmd
        assert "--filter" in new_cmd and "pytest" in new_cmd

    def test_npm_install_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("npm install"))
        assert "hookSpecificOutput" in result
        new_cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--filter" in new_cmd and "npm" in new_cmd

    def test_git_status_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("git status"))
        assert "hookSpecificOutput" in result
        new_cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--filter" in new_cmd and "git" in new_cmd

    def test_additional_context_explains_wrap(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("pytest"))
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "token-goat" in ctx
        assert "TOKEN_GOAT_BASH_COMPRESS=0" in ctx


# ---------------------------------------------------------------------------
# No-rewrite cases
# ---------------------------------------------------------------------------


class TestNoRewrite:
    def test_unknown_binary_passes_through(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("totally-bogus-binary"))
        assert result.get("continue") is True
        assert "hookSpecificOutput" not in result

    def test_pipeline_not_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        # Pipelines cannot be safely wrapped.
        result = _dispatch(_payload("pytest | grep FAIL"))
        assert "hookSpecificOutput" not in result

    def test_redirect_not_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("pytest > out.txt"))
        assert "hookSpecificOutput" not in result

    def test_chain_not_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        result = _dispatch(_payload("pytest && deploy"))
        assert "hookSpecificOutput" not in result

    def test_already_wrapped_command_not_double_wrapped(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        # Simulate the wrapper invocation — must not recurse.
        result = _dispatch(_payload("token-goat compress --filter pytest --cmd 'pytest'"))
        assert "hookSpecificOutput" not in result

    def test_read_equivalent_command_takes_read_branch(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        # `cat foo.py` should be handled by the read-equivalent branch, not
        # the compress branch.  The result shape depends on whether the file
        # is found; but it should NOT contain a compress wrapper command.
        result = _dispatch(_payload("cat foo.py"))
        hso = result.get("hookSpecificOutput", {})
        updated = hso.get("updatedInput", {})
        new_cmd = updated.get("command", "")
        assert "compress" not in str(new_cmd)


# ---------------------------------------------------------------------------
# Disable via environment variable
# ---------------------------------------------------------------------------


class TestEnvDisable:
    @pytest.mark.parametrize("value", ["0", "false", "no", "off", "FALSE", "Off"])
    def test_env_var_disables_compression(self, tmp_data_dir, monkeypatch, value):
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", value)
        result = _dispatch(_payload("pytest tests/"))
        # No rewrite when disabled.
        assert "hookSpecificOutput" not in result

    @pytest.mark.parametrize("value", ["1", "true", "yes", "on", "anything"])
    def test_truthy_values_keep_compression_enabled(self, tmp_data_dir, monkeypatch, value):
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", value)
        result = _dispatch(_payload("pytest tests/"))
        assert "hookSpecificOutput" in result


# ---------------------------------------------------------------------------
# Disable via TOML config
# ---------------------------------------------------------------------------


class TestConfigDisable:
    def test_config_enabled_false_skips_wrapping(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        from token_goat import config as config_mod

        cfg = config_mod.Config()
        cfg.bash_compress.enabled = False
        config_mod.save(cfg)
        result = _dispatch(_payload("pytest tests/"))
        assert "hookSpecificOutput" not in result

    def test_disabled_filters_skips_matched_filter(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        from token_goat import config as config_mod

        cfg = config_mod.Config()
        cfg.bash_compress.disabled_filters = ["pytest"]
        config_mod.save(cfg)
        # pytest is disabled — should not wrap.
        result = _dispatch(_payload("pytest tests/"))
        assert "hookSpecificOutput" not in result
        # git is still enabled — should wrap.
        result = _dispatch(_payload("git status"))
        assert "hookSpecificOutput" in result

    def test_timeout_seconds_threaded_into_wrapper(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        from token_goat import config as config_mod

        cfg = config_mod.Config()
        cfg.bash_compress.timeout_seconds = 42
        config_mod.save(cfg)
        result = _dispatch(_payload("pytest tests/"))
        cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--timeout" in cmd and " 42 " in cmd


# ---------------------------------------------------------------------------
# Other tool calls untouched
# ---------------------------------------------------------------------------


class TestOtherToolsUntouched:
    def test_grep_tool_not_wrapped(self, tmp_data_dir):
        payload = {
            "session_id": "s1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "foo"},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        assert "hookSpecificOutput" not in result

    def test_glob_tool_not_wrapped(self, tmp_data_dir):
        payload = {
            "session_id": "s1",
            "tool_name": "Glob",
            "tool_input": {"pattern": "*.py"},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        assert "hookSpecificOutput" not in result


# ---------------------------------------------------------------------------
# Helper function
# ---------------------------------------------------------------------------


class TestEnvHelper:
    def test_helper_returns_true_by_default(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        assert hooks_read._bash_compress_enabled() is True

    def test_helper_returns_false_when_disabled(self, monkeypatch):
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", "0")
        assert hooks_read._bash_compress_enabled() is False
