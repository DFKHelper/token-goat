"""Tests for Iter 2 — session-immutable env-probe cache.

Covers:
  - is_env_probe_command positive cases (version flags, which/where)
  - is_env_probe_command negative cases (non-probe commands)
  - Cross-session serve: output stored for session A is served on session B
  - Non-env-probe commands pass through to None
  - "env_probe_cache_hit" stat kind is in the "Bash" renderer group
"""
from __future__ import annotations

import pytest

from token_goat.bash_cache import is_env_probe_command

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pre_bash_payload(sid: str, cmd: str, *, cwd: str = "/proj") -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "cwd": cwd,
    }


# ---------------------------------------------------------------------------
# is_env_probe_command — positive
# ---------------------------------------------------------------------------

class TestIsEnvProbeCommandPositive:
    @pytest.mark.parametrize("cmd", [
        "node -v",
        "npm --version",
        "npm -v",
        "python --version",
        "python -V",
        "python3 --version",
        "python3 -V",
        "git --version",
        "uv --version",
        "which node",
        "where python",
        "  node -v  ",
        "go version",
        "rustc --version",
        "cargo --version",
        "java --version",
        "ruby --version",
        "gem --version",
        "php --version",
    ])
    def test_probe_commands_detected(self, cmd: str) -> None:
        assert is_env_probe_command(cmd), f"{cmd!r} should be detected as an env probe"


# ---------------------------------------------------------------------------
# is_env_probe_command — negative
# ---------------------------------------------------------------------------

class TestIsEnvProbeCommandNegative:
    @pytest.mark.parametrize("cmd", [
        "node app.js",
        "python script.py",
        "git commit",
        "git status",
        "ls -la",
        "cat file.py",
        "npm install",
        "go build ./...",
        "rustc main.rs",
    ])
    def test_non_probe_commands_not_detected(self, cmd: str) -> None:
        assert not is_env_probe_command(cmd), f"{cmd!r} should not be detected as an env probe"


# ---------------------------------------------------------------------------
# Cross-session serve via _handle_env_probe_serve
# ---------------------------------------------------------------------------

class TestEnvProbeServe:
    def test_cross_session_serve_returns_advisory(self, tmp_data_dir: object) -> None:
        """Output stored under session A is served as an advisory hint on session B (not a deny)."""
        import token_goat.bash_cache as bc
        from token_goat.hooks_read import _handle_env_probe_serve

        sid_a = "env-probe-sess-a"
        sid_b = "env-probe-sess-b"
        cmd = "node -v"
        cwd = "/proj"
        stdout = "v20.11.0\n"

        meta = bc.store_output(sid_a, cmd, stdout, "", 0, cwd=cwd)
        assert meta is not None
        bc.write_sidecar(meta)

        payload = _make_pre_bash_payload(sid_b, cmd, cwd=cwd)
        result = _handle_env_probe_serve(payload)

        assert result is not None, "_handle_env_probe_serve should return a response"
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny", "env probe serve must be advisory, not deny"
        ctx = result.get("additionalContext", "") or hso.get("additionalContext", "")
        assert "v20.11.0" in ctx, "cached output should appear in additionalContext"
        assert "env probe" in ctx, "hint text should mention env probe"

    def test_cross_session_serve_no_cache_returns_none(self, tmp_data_dir: object) -> None:
        """When no cached entry exists, _handle_env_probe_serve returns None."""
        from token_goat.hooks_read import _handle_env_probe_serve

        payload = _make_pre_bash_payload("env-probe-miss", "python --version")
        result = _handle_env_probe_serve(payload)
        assert result is None

    def test_non_probe_command_returns_none(self, tmp_data_dir: object) -> None:
        """Non-probe commands are not served even if they have cached output."""
        import token_goat.bash_cache as bc
        from token_goat.hooks_read import _handle_env_probe_serve

        sid = "env-probe-non-probe"
        cmd = "git status"
        cwd = "/proj"
        meta = bc.store_output(sid, cmd, "On branch main\n", "", 0, cwd=cwd)
        assert meta is not None
        bc.write_sidecar(meta)

        payload = _make_pre_bash_payload("env-probe-other-sess", cmd, cwd=cwd)
        result = _handle_env_probe_serve(payload)
        assert result is None, "non-probe commands must not be served by _handle_env_probe_serve"

    def test_non_bash_tool_returns_none(self, tmp_data_dir: object) -> None:
        """Payloads from non-Bash tools return None safely."""
        from token_goat.hooks_read import _handle_env_probe_serve

        payload = {
            "session_id": "env-probe-read-tool",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/foo.py"},
            "cwd": "/proj",
        }
        result = _handle_env_probe_serve(payload)
        assert result is None


# ---------------------------------------------------------------------------
# Stats renderer group
# ---------------------------------------------------------------------------

class TestEnvProbeStatGroup:
    def test_env_probe_cache_hit_in_bash_group(self) -> None:
        from token_goat.render.stats_renderer import _kind_group_label

        assert _kind_group_label("env_probe_cache_hit") == "Bash"
