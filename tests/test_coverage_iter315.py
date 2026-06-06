"""Tests for iter 315: Linux systemd service improvements + worker --status command."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Systemd service file content assertions
# ---------------------------------------------------------------------------

class TestSystemdServiceFileContent:
    """The generated .service file must include restart / rate-limit directives."""

    @pytest.fixture(autouse=True)
    def _linux_install_env(self, tmp_path, monkeypatch):
        """Simulate a Linux environment with a no-op subprocess.run."""
        from token_goat import install

        self._install = install

        def _fake_run(cmd, **kwargs):
            r = MagicMock()
            r.returncode = 0
            return r

        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        monkeypatch.setattr(install, "_systemd_user_available", lambda: True)
        monkeypatch.setattr(install.subprocess, "run", _fake_run)
        install.install_linux_autostart()

    def _service_content(self) -> str:
        return self._install._systemd_service_path().read_text()

    def test_service_file_contains_restart_on_failure(self):
        """Generated service file has Restart=on-failure."""
        assert "Restart=on-failure" in self._service_content()

    def test_service_file_contains_restart_sec_5(self):
        """Generated service file has RestartSec=5."""
        assert "RestartSec=5" in self._service_content()

    def test_service_file_contains_start_limit_interval(self):
        """Generated service file has StartLimitIntervalSec=60."""
        assert "StartLimitIntervalSec=60" in self._service_content()

    def test_service_file_contains_start_limit_burst(self):
        """Generated service file has StartLimitBurst=3."""
        assert "StartLimitBurst=3" in self._service_content()


# ---------------------------------------------------------------------------
# query_worker_status tests
# ---------------------------------------------------------------------------

class TestQueryWorkerStatus:
    """Unit tests for worker_daemon.query_worker_status()."""

    def test_returns_stopped_when_no_pid_file(self, tmp_data_dir):
        """With no PID file, running=False and pid=None."""
        from token_goat import worker_daemon

        with patch.object(worker_daemon, "_read_pid_from_file", return_value=worker_daemon._PID_UNKNOWN):
            result = worker_daemon.query_worker_status()

        assert result["running"] is False
        assert result["pid"] is None

    def test_returns_running_when_pid_alive(self, tmp_data_dir):
        """With a live PID, running=True."""
        from token_goat import worker_daemon

        with (
            patch.object(worker_daemon, "_read_pid_from_file", return_value=12345),
            patch.object(worker_daemon, "_pid_is_alive", return_value=True),
        ):
            result = worker_daemon.query_worker_status()

        assert result["running"] is True
        assert result["pid"] == 12345

    def test_returns_stopped_when_pid_dead(self, tmp_data_dir):
        """With a stale PID (process dead), running=False but pid is set."""
        from token_goat import worker_daemon

        with (
            patch.object(worker_daemon, "_read_pid_from_file", return_value=99999),
            patch.object(worker_daemon, "_pid_is_alive", return_value=False),
        ):
            result = worker_daemon.query_worker_status()

        assert result["running"] is False
        assert result["pid"] == 99999

    def test_result_has_required_keys(self, tmp_data_dir):
        """Result dict always has the expected keys."""
        from token_goat import worker_daemon

        with patch.object(worker_daemon, "_read_pid_from_file", return_value=worker_daemon._PID_UNKNOWN):
            result = worker_daemon.query_worker_status()

        for key in ("running", "pid", "autostart", "autostart_active", "last_log_line"):
            assert key in result, f"missing key: {key}"

    def test_last_log_line_from_todays_log(self, tmp_data_dir, monkeypatch):
        """last_log_line is populated from today's log file if it exists."""
        import datetime

        from token_goat import paths, worker_daemon

        today = datetime.date.today().strftime("%Y-%m-%d")
        log_path = paths.logs_dir() / f"{today}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("first line\nsecond line\n", encoding="utf-8")

        with patch.object(worker_daemon, "_read_pid_from_file", return_value=worker_daemon._PID_UNKNOWN):
            result = worker_daemon.query_worker_status()

        assert result["last_log_line"] == "second line"

    def test_last_log_line_none_when_no_log(self, tmp_data_dir):
        """last_log_line is None when no log file exists for today."""
        from token_goat import worker_daemon

        with patch.object(worker_daemon, "_read_pid_from_file", return_value=worker_daemon._PID_UNKNOWN):
            result = worker_daemon.query_worker_status()

        assert result["last_log_line"] is None


# ---------------------------------------------------------------------------
# `token-goat worker --status` CLI tests
# ---------------------------------------------------------------------------

class TestWorkerStatusCLI:
    """Integration tests for `token-goat worker --status`."""

    def test_status_flag_exits_zero(self):
        """worker --status exits 0."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with patch.object(
            worker_daemon,
            "query_worker_status",
            return_value={
                "running": False,
                "pid": None,
                "autostart": None,
                "autostart_active": None,
                "last_log_line": None,
            },
        ):
            result = runner.invoke(app, ["worker", "--status"])

        assert result.exit_code == 0

    def test_status_shows_stopped(self):
        """worker --status shows 'stopped' when worker is not running."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with patch.object(
            worker_daemon,
            "query_worker_status",
            return_value={
                "running": False,
                "pid": None,
                "autostart": None,
                "autostart_active": None,
                "last_log_line": None,
            },
        ):
            result = runner.invoke(app, ["worker", "--status"])

        assert "stopped" in result.output

    def test_status_shows_running_with_pid(self):
        """worker --status shows 'running' and pid when worker is alive."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with patch.object(
            worker_daemon,
            "query_worker_status",
            return_value={
                "running": True,
                "pid": 42,
                "autostart": None,
                "autostart_active": None,
                "last_log_line": None,
            },
        ):
            result = runner.invoke(app, ["worker", "--status"])

        assert "running" in result.output
        assert "42" in result.output

    def test_status_shows_autostart_info(self):
        """worker --status includes autostart mechanism when available."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with patch.object(
            worker_daemon,
            "query_worker_status",
            return_value={
                "running": False,
                "pid": None,
                "autostart": "systemd",
                "autostart_active": True,
                "last_log_line": None,
            },
        ):
            result = runner.invoke(app, ["worker", "--status"])

        assert "systemd" in result.output
        assert "enabled" in result.output

    def test_status_shows_last_log_line(self):
        """worker --status shows last log line when available."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with patch.object(
            worker_daemon,
            "query_worker_status",
            return_value={
                "running": True,
                "pid": 7,
                "autostart": "registry",
                "autostart_active": True,
                "last_log_line": "2026-06-01 INFO worker heartbeat",
            },
        ):
            result = runner.invoke(app, ["worker", "--status"])

        assert "heartbeat" in result.output

    def test_status_does_not_start_daemon(self):
        """worker --status never calls run_daemon."""
        from typer.testing import CliRunner

        from token_goat import worker_daemon
        from token_goat.cli import app

        runner = CliRunner()
        with (
            patch.object(
                worker_daemon,
                "query_worker_status",
                return_value={
                    "running": False,
                    "pid": None,
                    "autostart": None,
                    "autostart_active": None,
                    "last_log_line": None,
                },
            ),
            patch.object(worker_daemon, "run_daemon") as mock_run,
        ):
            runner.invoke(app, ["worker", "--status"])

        mock_run.assert_not_called()
