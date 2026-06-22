"""Tests for container log output compression.

Covers:
  - _is_container_log_cmd: docker logs, kubectl logs, podman logs,
    docker compose logs, docker-compose logs
  - docker with global flags before subcommand (docker -H host:port logs container) -> True
  - docker pull (not logs) -> False
  - kubectl get pods (not logs) -> False
  - post_bash: 60-line docker logs -> compressed
  - post_bash: last 20 lines present in message
  - post_bash: error lines present in message
  - post_bash: error section absent when no errors
  - post_bash: short output (< 50 lines) -> NOT compressed
  - post_bash: exit_code=1 -> NOT compressed
  - post_bash: bash-output recall hint when session active
  - post_bash: "+N more" when > 30 error lines
"""
from __future__ import annotations

import pytest

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _is_container_log_cmd
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


def _make_app_log(n: int, *, error_every: int | None = None) -> str:
    """Generate n fake application log lines, optionally with errors."""
    lines: list[str] = []
    for i in range(n):
        if error_every and i % error_every == 0:
            lines.append(f"2024-01-01T12:{i:02d}:00Z ERROR service failed at step {i}")
        else:
            lines.append(f"2024-01-01T12:{i:02d}:00Z INFO processing request {i}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# _is_container_log_cmd unit tests
# ---------------------------------------------------------------------------


class TestIsContainerLogCmd:
    def test_docker_logs_basic(self):
        assert _is_container_log_cmd(["docker", "logs", "mycontainer"]) is True

    def test_docker_logs_with_flags(self):
        assert _is_container_log_cmd(["docker", "logs", "--follow", "-n", "100", "mycontainer"]) is True

    def test_docker_logs_global_flag_host(self):
        # docker -H tcp://host:2375 logs mycontainer
        assert _is_container_log_cmd(["docker", "-H", "tcp://host:2375", "logs", "mycontainer"]) is True

    def test_docker_logs_global_flag_context(self):
        assert _is_container_log_cmd(["docker", "--context", "myctx", "logs", "mycontainer"]) is True

    def test_docker_compose_logs(self):
        assert _is_container_log_cmd(["docker", "compose", "logs", "web"]) is True

    def test_docker_compose_logs_no_service(self):
        assert _is_container_log_cmd(["docker", "compose", "logs"]) is True

    def test_docker_compose_logs_with_flags(self):
        assert _is_container_log_cmd(["docker", "compose", "--project-name", "myapp", "logs"]) is True

    def test_docker_hyphen_compose_logs(self):
        assert _is_container_log_cmd(["docker-compose", "logs", "web"]) is True

    def test_docker_hyphen_compose_logs_with_flags(self):
        assert _is_container_log_cmd(["docker-compose", "-f", "docker-compose.yml", "logs"]) is True

    def test_kubectl_logs_basic(self):
        assert _is_container_log_cmd(["kubectl", "logs", "mypod"]) is True

    def test_kubectl_logs_with_namespace(self):
        assert _is_container_log_cmd(["kubectl", "-n", "default", "logs", "mypod"]) is True

    def test_kubectl_logs_with_context(self):
        assert _is_container_log_cmd(["kubectl", "--context", "prod", "logs", "mypod-abc"]) is True

    def test_podman_logs_basic(self):
        assert _is_container_log_cmd(["podman", "logs", "mycontainer"]) is True

    def test_podman_logs_with_flags(self):
        assert _is_container_log_cmd(["podman", "--log-level", "debug", "logs", "c1"]) is True

    def test_docker_pull_not_logs(self):
        assert _is_container_log_cmd(["docker", "pull", "nginx"]) is False

    def test_docker_run_not_logs(self):
        assert _is_container_log_cmd(["docker", "run", "nginx"]) is False

    def test_kubectl_get_pods_not_logs(self):
        assert _is_container_log_cmd(["kubectl", "get", "pods"]) is False

    def test_kubectl_exec_not_logs(self):
        assert _is_container_log_cmd(["kubectl", "exec", "-it", "mypod", "--", "bash"]) is False

    def test_too_short_argv(self):
        assert _is_container_log_cmd(["docker"]) is False

    def test_unrelated_command(self):
        assert _is_container_log_cmd(["git", "log"]) is False

    def test_docker_global_flag_then_compose_logs(self) -> None:
        # docker -H <host> compose logs <svc>: global flag pushes sub_idx to 3,
        # exercising the two-level dispatch path where sub_idx > 1
        assert _is_container_log_cmd(
            ["docker", "-H", "tcp://host:2375", "compose", "logs", "web"]
        ) is True


# ---------------------------------------------------------------------------
# post_bash integration tests
# ---------------------------------------------------------------------------


class TestPostBashContainerLogCompress:
    @pytest.fixture(autouse=True)
    def _no_db_stat(self, monkeypatch):
        """Prevent db.record_stat from opening the global SQLite DB during tests."""
        monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)

    def test_docker_logs_60_lines_compressed(self, tmp_path):
        sid = "cl-test-001"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg

    def test_last_20_lines_present(self, tmp_path):
        sid = "cl-test-002"
        _bootstrap_session(sid)
        lines = [f"line {i}" for i in range(60)]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Last 20 lines should appear (lines 40-59)
        assert "line 59" in msg
        assert "line 40" in msg
        # Line 39 should NOT be in the tail section header area — it's before last 20
        # (it may appear in error section but not in tail)
        assert "--- recent (last 20 lines) ---" in msg

    def test_error_lines_present(self, tmp_path):
        sid = "cl-test-003"
        _bootstrap_session(sid)
        stdout = _make_app_log(60, error_every=5)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "errors/warnings" in msg
        assert "--- errors/warnings" in msg
        assert "ERROR" in msg

    def test_no_error_section_when_clean(self, tmp_path):
        sid = "cl-test-004"
        _bootstrap_session(sid)
        # Generate clean log lines (no error keywords)
        lines = [f"2024-01-01 INFO request processed {i}" for i in range(60)]
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg
        assert "--- errors/warnings" not in msg

    def test_short_output_not_compressed(self, tmp_path):
        sid = "cl-test-005"
        _bootstrap_session(sid)
        stdout = _make_app_log(20)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_exit_code_1_not_compressed(self, tmp_path):
        sid = "cl-test-006"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(
            sid, "docker logs mycontainer", stdout, str(tmp_path), exit_code=1,
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_bash_output_recall_hint_when_session_active(self, tmp_path):
        sid = "cl-test-007"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "bash-output" in msg

    def test_plus_n_more_when_over_30_error_lines(self, tmp_path):
        sid = "cl-test-008"
        _bootstrap_session(sid)
        # Generate 100 lines, every other one is an ERROR -> 50 error lines
        lines: list[str] = []
        for i in range(100):
            if i % 2 == 0:
                lines.append(f"ERROR something went wrong at step {i}")
            else:
                lines.append(f"INFO ok {i}")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "+20 more" in msg or "+ more" in msg or "more" in msg
        # Must have "+N more" pattern
        import re
        assert re.search(r"\+\d+ more", msg), f"Expected '+N more' in: {msg!r}"

    def test_kubectl_logs_compressed(self, tmp_path):
        sid = "cl-test-009"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "kubectl logs mypod", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg

    def test_podman_logs_compressed(self, tmp_path):
        sid = "cl-test-010"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "podman logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg

    def test_docker_compose_logs_compressed(self, tmp_path):
        sid = "cl-test-011"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "docker compose logs web", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg

    def test_header_includes_line_count_and_cmd(self, tmp_path):
        sid = "cl-test-012"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "60 lines" in msg
        assert "docker logs mycontainer" in msg

    def test_fatal_keyword_caught(self, tmp_path):
        sid = "cl-test-013"
        _bootstrap_session(sid)
        lines = [f"INFO line {i}" for i in range(59)]
        lines.insert(10, "FATAL out of memory")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "FATAL" in msg
        assert "--- errors/warnings" in msg

    def test_panic_keyword_caught(self, tmp_path):
        sid = "cl-test-014"
        _bootstrap_session(sid)
        lines = [f"INFO line {i}" for i in range(59)]
        lines.insert(5, "goroutine 1 [running]: panic: runtime error")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "panic" in msg

    def test_exception_keyword_caught(self, tmp_path):
        sid = "cl-test-015"
        _bootstrap_session(sid)
        lines = [f"INFO line {i}" for i in range(59)]
        lines.insert(3, "java.lang.NullPointerException: null")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "Exception" in msg or "exception" in msg

    def test_unrelated_command_not_compressed(self, tmp_path):
        # A non-container command with many lines must not trigger container compression
        sid = "cl-test-016b"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "cat /var/log/syslog", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_docker_pull_not_triggered(self, tmp_path):
        sid = "cl-test-016"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "docker pull nginx:latest", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_kubectl_get_not_triggered(self, tmp_path):
        sid = "cl-test-017"
        _bootstrap_session(sid)
        stdout = _make_app_log(60)
        payload = _make_payload(sid, "kubectl get pods", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_exactly_50_lines_triggers(self, tmp_path):
        sid = "cl-test-018"
        _bootstrap_session(sid)
        stdout = _make_app_log(50)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" in msg

    def test_49_lines_does_not_trigger(self, tmp_path):
        sid = "cl-test-019"
        _bootstrap_session(sid)
        stdout = _make_app_log(49)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] container logs:" not in msg

    def test_error_count_in_header(self, tmp_path):
        sid = "cl-test-020"
        _bootstrap_session(sid)
        stdout = _make_app_log(60, error_every=10)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "errors/warnings" in msg
        # Header line should have non-zero error count
        header_line = msg.splitlines()[0]
        assert "0 errors/warnings" not in header_line

    def test_exception_stack_frames_preserved(self, tmp_path):
        # Regression: stack frame lines following an exception line must be captured,
        # not dropped, even though they do not contain an error keyword themselves.
        sid = "cl-test-021"
        _bootstrap_session(sid)
        base_lines = [f"INFO line {i}" for i in range(60)]
        # Insert a Java exception block at position 5
        exception_block = [
            "java.lang.NullPointerException: something was null",
            "    at com.example.Foo.doThing(Foo.java:42)",
            "    at com.example.Bar.process(Bar.java:18)",
            "    at com.example.Main.main(Main.java:7)",
        ]
        for i, line in enumerate(exception_block):
            base_lines.insert(5 + i, line)
        stdout = "\n".join(base_lines)
        payload = _make_payload(sid, "docker logs mycontainer", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "NullPointerException" in msg, "exception line must appear in compressed output"
        assert "at com.example.Foo" in msg, "stack frame line must be captured after exception"
        assert "at com.example.Bar" in msg, "second stack frame line must be captured"
        assert "at com.example.Main" in msg, "third stack frame line must be captured"

    def test_tail_flag_skips_compression(self, tmp_path):
        # Regression: when the caller passes --tail N, the hook must not compress
        # the output — the user explicitly chose their own window.
        sid = "cl-test-022"
        _bootstrap_session(sid)
        stdout = _make_app_log(65)  # > _CONTAINER_LOG_MIN_LINES (50)
        payload = _make_payload(
            sid,
            "docker logs --tail 50 mycontainer",
            stdout,
            str(tmp_path),
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # No systemMessage from the container-log block means no compression occurred
        assert "[token-goat] container logs" not in msg, (
            "--tail flag must bypass container log compression"
        )
