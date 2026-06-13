"""Tests for environment variable listing output compression.

Covers:
  - _is_env_list_cmd: env, printenv, export -p, declare -x, negatives
  - post_bash integration: >= 10 env lines → compressed systemMessage
  - post_bash integration: < 10 lines → passes through unchanged
  - post_bash integration: exit_code=1 → not compressed
  - post_bash integration: env VAR=val cmd → not compressed
  - post_bash integration: values never appear in systemMessage (secret safety)
  - post_bash integration: bash-output recall hint when session active
  - post_bash integration: variable count, category breakdown in message
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _is_env_list_cmd
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    stderr: str = "",
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


def _make_env_output(n: int, *, include_secret: bool = False) -> str:
    """Generate n fake env KEY=VALUE lines."""
    lines = [
        "HOME=/home/user",
        "USER=testuser",
        "SHELL=/bin/bash",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "MANPATH=/usr/local/share/man:/usr/share/man",
        "PYTHONPATH=/home/user/lib",
        "PYTHONSTARTUP=/home/user/.pythonrc",
        "NODE_ENV=development",
        "NPM_CONFIG_CACHE=/home/user/.npm",
        "AWS_REGION=us-east-1",
        "AWS_DEFAULT_REGION=us-east-1",
        "GIT_AUTHOR_NAME=Dev",
        "GITHUB_ACTIONS=true",
        "CI=true",
    ]
    if include_secret:
        lines.append("AWS_SECRET_ACCESS_KEY=SUPER_SECRET_TOKEN_DO_NOT_LEAK")
        lines.append("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
    # Pad to requested length with generic vars
    for i in range(len(lines), n):
        lines.append(f"VAR_{i}=value_{i}")
    return "\n".join(lines[:n])


def _make_declare_output(n: int) -> str:
    """Generate n fake 'declare -x KEY=value' lines."""
    lines = [
        'declare -x HOME="/home/user"',
        'declare -x USER="testuser"',
        'declare -x SHELL="/bin/bash"',
        'declare -x TERM="xterm-256color"',
        'declare -x PATH="/usr/local/bin:/usr/bin:/bin"',
        'declare -x PYTHONPATH="/home/user/lib"',
        'declare -x NODE_ENV="development"',
        'declare -x AWS_REGION="us-east-1"',
        'declare -x GIT_AUTHOR_NAME="Dev"',
        'declare -x GITHUB_ACTIONS="true"',
    ]
    for i in range(len(lines), n):
        lines.append(f'declare -x VAR_{i}="value_{i}"')
    return "\n".join(lines[:n])


# ---------------------------------------------------------------------------
# _is_env_list_cmd tests
# ---------------------------------------------------------------------------


class TestIsEnvListCmd:
    def test_bare_env(self):
        assert _is_env_list_cmd(["env"]) is True

    def test_env_null_flag(self):
        assert _is_env_list_cmd(["env", "--null"]) is True

    def test_env_zero_flag(self):
        assert _is_env_list_cmd(["env", "-0"]) is True

    def test_env_ignore_environment(self):
        assert _is_env_list_cmd(["env", "-i"]) is True
        assert _is_env_list_cmd(["env", "--ignore-environment"]) is True

    def test_env_unset_flag(self):
        # env -u HOME is still listing (minus one var)
        assert _is_env_list_cmd(["env", "-u", "HOME"]) is True
        assert _is_env_list_cmd(["env", "--unset", "HOME"]) is True

    def test_env_command_prefix_false(self):
        # env VAR=val cmd → command prefix, not a listing
        assert _is_env_list_cmd(["env", "FOO=bar", "bash"]) is False

    def test_env_single_assignment_false(self):
        # env VAR=val (even without a following command) contains '='
        assert _is_env_list_cmd(["env", "MY_VAR=hello"]) is False

    def test_env_with_program_name_not_detected(self):
        # env node (no VAR=val, but still running a program) → not a listing
        assert _is_env_list_cmd(["env", "node"]) is False
        assert _is_env_list_cmd(["env", "bash", "-c", "something"]) is False

    def test_env_exe_suffix(self):
        assert _is_env_list_cmd(["env.exe"]) is True

    def test_env_full_path(self):
        assert _is_env_list_cmd(["/usr/bin/env"]) is True

    def test_printenv_bare(self):
        assert _is_env_list_cmd(["printenv"]) is True

    def test_printenv_with_var_names(self):
        # printenv HOME PATH — still a listing (prints specific vars)
        assert _is_env_list_cmd(["printenv", "HOME"]) is True
        assert _is_env_list_cmd(["printenv", "HOME", "PATH"]) is True

    def test_printenv_full_path(self):
        assert _is_env_list_cmd(["/usr/bin/printenv"]) is True

    def test_export_p(self):
        assert _is_env_list_cmd(["export", "-p"]) is True

    def test_export_bare(self):
        # bare export without args also lists exports
        assert _is_env_list_cmd(["export"]) is True

    def test_export_assignment_false(self):
        # export FOO=bar is not a listing
        assert _is_env_list_cmd(["export", "FOO=bar"]) is False

    def test_declare_x(self):
        assert _is_env_list_cmd(["declare", "-x"]) is True

    def test_declare_x_with_other_flags(self):
        assert _is_env_list_cmd(["declare", "-x", "-l"]) is True

    def test_declare_no_x_false(self):
        # declare -a (arrays) is not env listing
        assert _is_env_list_cmd(["declare", "-a"]) is False

    def test_empty_argv_false(self):
        assert _is_env_list_cmd([]) is False

    def test_unrelated_command_false(self):
        assert _is_env_list_cmd(["echo", "env"]) is False
        assert _is_env_list_cmd(["cat", "/etc/environment"]) is False


# ---------------------------------------------------------------------------
# post_bash integration tests
# ---------------------------------------------------------------------------


class TestEnvListPostBashIntegration:
    def test_env_30_vars_compressed(self, tmp_path, tmp_data_dir):
        """30-line env output should be compressed into a systemMessage."""
        sid = "sess-env-1"
        _bootstrap_session(sid)
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" in msg
        assert "variables" in msg

    def test_printenv_compressed(self, tmp_path, tmp_data_dir):
        """printenv with >= 10 lines of output → compressed."""
        sid = "sess-env-2"
        _bootstrap_session(sid)
        stdout = _make_env_output(20)
        payload = _make_payload(sid, "printenv", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" in msg

    def test_declare_x_compressed(self, tmp_path, tmp_data_dir):
        """declare -x with >= 10 lines → compressed."""
        sid = "sess-env-3"
        _bootstrap_session(sid)
        stdout = _make_declare_output(15)
        payload = _make_payload(sid, "declare -x", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" in msg

    def test_short_output_not_compressed(self, tmp_path, tmp_data_dir):
        """Fewer than 10 lines of env output passes through unchanged."""
        sid = "sess-env-4"
        _bootstrap_session(sid)
        stdout = "HOME=/home/user\nUSER=testuser\n"
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" not in msg

    def test_exit_code_1_not_compressed(self, tmp_path, tmp_data_dir):
        """env with exit_code=1 should not be compressed."""
        sid = "sess-env-5"
        _bootstrap_session(sid)
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env", stdout, str(tmp_path), exit_code=1)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" not in msg

    def test_env_command_prefix_not_compressed(self, tmp_path, tmp_data_dir):
        """env VAR=val cmd is NOT an env listing — must not be compressed."""
        sid = "sess-env-6"
        _bootstrap_session(sid)
        # This is output from running a command, not from env listing
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env FOO=bar bash -c 'printenv'", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" not in msg

    def test_values_never_in_message(self, tmp_path, tmp_data_dir):
        """Variable values must never appear in the systemMessage."""
        sid = "sess-env-7"
        _bootstrap_session(sid)
        stdout = _make_env_output(30, include_secret=False)
        # Embed a unique sentinel value that must not leak
        stdout = stdout + "\nSECRET_KEY=s3cr3t_v@lue_sentinel_xyz"
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "s3cr3t_v@lue_sentinel_xyz" not in msg
        assert "[token-goat] env:" in msg

    def test_secret_token_value_not_leaked(self, tmp_path, tmp_data_dir):
        """AWS_SECRET_ACCESS_KEY and GITHUB_TOKEN values must not appear."""
        sid = "sess-env-8"
        _bootstrap_session(sid)
        stdout = _make_env_output(30, include_secret=True)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "SUPER_SECRET_TOKEN_DO_NOT_LEAK" not in msg
        assert "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" not in msg
        # But the names should appear
        assert "AWS_SECRET_ACCESS_KEY" in msg
        assert "GITHUB_TOKEN" in msg

    def test_variable_count_in_message(self, tmp_path, tmp_data_dir):
        """systemMessage must report the total variable count."""
        sid = "sess-env-9"
        _bootstrap_session(sid)
        stdout = _make_env_output(25)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Should report 25 variables (25 KEY=VALUE lines)
        assert "25 variables" in msg

    def test_categories_in_message(self, tmp_path, tmp_data_dir):
        """systemMessage should list recognized categories."""
        sid = "sess-env-10"
        _bootstrap_session(sid)
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Output includes PATH-related, Python, Node/npm, AWS, Git, CI, Other
        assert "PATH-related" in msg
        assert "Python" in msg
        assert "Other" in msg

    def test_bash_output_recall_hint_with_session(self, tmp_path, tmp_data_dir):
        """When session is active, systemMessage should include bash-output recall hint."""
        sid = "sess-env-11"
        _bootstrap_session(sid)
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "bash-output" in msg

    def test_var_names_present_in_message(self, tmp_path, tmp_data_dir):
        """Variable names (not values) must appear in the systemMessage."""
        sid = "sess-env-12"
        _bootstrap_session(sid)
        stdout = _make_env_output(20)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # HOME, USER, SHELL etc. are names — they should appear
        assert "HOME" in msg or "USER" in msg or "SHELL" in msg

    def test_category_counts_shown(self, tmp_path, tmp_data_dir):
        """Each non-empty category line must show count in parens."""
        sid = "sess-env-13"
        _bootstrap_session(sid)
        stdout = _make_env_output(30)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Pattern: "CategoryName (N): ..." — ensure at least one such line
        import re
        assert re.search(r"\w[\w/\-]+ \(\d+\): ", msg)

    def test_export_p_compressed(self, tmp_path, tmp_data_dir):
        """export -p output (export KEY=value format) → compressed."""
        sid = "sess-env-14"
        _bootstrap_session(sid)
        lines = [f'export VAR_{i}="/some/value/{i}"' for i in range(20)]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "export -p", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] env:" in msg

    def test_large_category_truncated_at_10(self, tmp_path, tmp_data_dir):
        """When a category has >10 vars, output shows first 10 + '+N more'."""
        sid = "sess-env-15"
        _bootstrap_session(sid)
        # 15 OTHER_xxx vars — all land in Other
        lines = [f"OTHER_{i}=val_{i}" for i in range(15)]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "more" in msg

    def test_no_session_no_recall_hint(self, tmp_path, tmp_data_dir):
        """Without a session_id, bash-output recall hint should be absent."""
        stdout = _make_env_output(20)
        payload = _make_payload("", "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Compression still fires but no recall hint (no session to store to)
        if "[token-goat] env:" in msg:
            assert "bash-output" not in msg

    def test_ci_category_recognized(self, tmp_path, tmp_data_dir):
        """GITHUB_* and CI vars should land in CI category."""
        sid = "sess-env-16"
        _bootstrap_session(sid)
        lines = [f"FILLER_{i}=x" for i in range(8)]
        lines += [
            "CI=true",
            "GITHUB_ACTIONS=true",
            "GITHUB_WORKFLOW=build",
        ]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "CI" in msg

    def test_aws_category_recognized(self, tmp_path, tmp_data_dir):
        """AWS_* vars should land in the AWS category."""
        sid = "sess-env-17"
        _bootstrap_session(sid)
        lines = [f"FILLER_{i}=x" for i in range(8)]
        lines += [
            "AWS_REGION=us-east-1",
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
            "AWS_DEFAULT_REGION=us-east-1",
        ]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "env", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Values must not leak, but name should be visible
        assert "AWS_REGION" in msg or "AWS" in msg
        assert "AKIAIOSFODNN7EXAMPLE" not in msg
