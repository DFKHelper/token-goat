"""Tests for the hook-wrapper section added to token-goat doctor."""
from __future__ import annotations

import subprocess
import time
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

import token_goat.paths as paths
from token_goat import cli, db

runner = CliRunner()


# ---------------------------------------------------------------------------
# Hook wrapper section in doctor output
# ---------------------------------------------------------------------------


class TestDoctorHookWrapper:
    """doctor output covers the 'Hook wrapper' section correctly."""

    @pytest.fixture(autouse=True)
    def _mock_uv_check(self, monkeypatch, tmp_data_dir):
        """Prevent the real 'uv --version' subprocess call in doctor's _check_uv().

        Every ``runner.invoke(cli.app, ["doctor"])`` call runs _check_uv() which
        calls ``subprocess.run(["uv", "--version"], ...)`` — a 6 s overhead on
        Windows per test.  Replace it with a lightweight stub that returns
        immediately.  Tests that specifically test the wrapper invocation still
        control their own ``subprocess.run`` mock via patch() in the test body;
        this fixture wraps only the uv check.
        """
        _real_run = subprocess.run

        def _patched_run(args, **kwargs):
            if args and args[0] == "uv" and args[1:] == ["--version"]:
                return subprocess.CompletedProcess(args=args, returncode=0, stdout="uv 0.x.y\n", stderr="")
            return _real_run(args, **kwargs)

        monkeypatch.setattr(subprocess, "run", _patched_run)

    def test_hook_wrapper_missing_shows_fail(self, tmp_path, monkeypatch):
        """When hook_wrapper_path() points at a non-existent file, doctor shows [FAIL]."""
        missing = tmp_path / "bin" / "tg-hook.cmd"
        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: missing)
        # hook_wrapper_content() must return something to avoid AttributeError later
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: "@echo off\r\n")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Hook wrapper" in result.output
        assert "[FAIL]" in result.output
        assert "NOT FOUND" in result.output

    def test_hook_wrapper_up_to_date_shows_ok(self, tmp_path, monkeypatch):
        """When wrapper exists and matches expected content, doctor shows OK for both checks."""
        wrapper = tmp_path / "bin" / "tg-hook.cmd"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        expected_content = "@echo off\r\nREM token-goat hook wrapper\r\n"
        # Write with newline="" so line endings are stored verbatim (CRLF) and
        # the verbatim read in cli_doctor.py (also newline="") will match.
        wrapper.write_text(expected_content, encoding="utf-8", newline="")

        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: wrapper)
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: expected_content)

        # Mock subprocess.run so the invocation check always passes without
        # also intercepting the _check_uv() helper inside doctor.
        _real_run = subprocess.run

        def _selective_run(args, **kwargs):
            if args and str(args[0]) == str(wrapper):
                return subprocess.CompletedProcess(
                    args=args, returncode=0, stdout="token-goat 0.6.1\n", stderr=""
                )
            return _real_run(args, **kwargs)

        monkeypatch.setattr(subprocess, "run", _selective_run)

        result = runner.invoke(cli.app, ["doctor"])

        assert result.exit_code == 0
        assert "Hook wrapper" in result.output
        assert "up to date" in result.output

    def test_hook_wrapper_stale_content_shows_warn(self, tmp_path, monkeypatch):
        """When wrapper exists but content differs from expected, doctor shows [WARN]."""
        wrapper = tmp_path / "bin" / "tg-hook.cmd"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text("@echo off\r\nREM old content\r\n", encoding="utf-8", newline="")

        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: wrapper)
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: "@echo off\r\nREM new content\r\n")

        mock_completed = subprocess.CompletedProcess(
            args=[str(wrapper), "--version"],
            returncode=0,
            stdout="token-goat 0.6.1\n",
            stderr="",
        )
        with patch("subprocess.run", return_value=mock_completed):
            result = runner.invoke(cli.app, ["doctor"])

        assert result.exit_code == 0
        assert "Hook wrapper" in result.output
        assert "[WARN]" in result.output
        assert "differs from expected" in result.output

    def test_hook_wrapper_invoke_failure_shows_warn(self, tmp_path, monkeypatch):
        """When wrapper exists and content matches but invocation fails, doctor shows [WARN]."""
        wrapper = tmp_path / "bin" / "tg-hook.cmd"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        content = "@echo off\r\nREM token-goat\r\n"
        wrapper.write_text(content, encoding="utf-8", newline="")

        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: wrapper)
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: content)

        mock_failed = subprocess.CompletedProcess(
            args=[str(wrapper), "--version"],
            returncode=1,
            stdout="",
            stderr="error: something went wrong",
        )
        with patch("subprocess.run", return_value=mock_failed):
            result = runner.invoke(cli.app, ["doctor"])

        assert result.exit_code == 0
        assert "Hook wrapper" in result.output
        assert "[WARN]" in result.output

    def test_hook_wrapper_section_appears_before_worker(self, tmp_path, monkeypatch):
        """The Hook wrapper section must appear before the Worker section in doctor output."""
        missing = tmp_path / "bin" / "tg-hook.cmd"
        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: missing)
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: "@echo off\r\n")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0

        hook_wrapper_pos = result.output.find("Hook wrapper")
        worker_pos = result.output.find("\nWorker")
        assert hook_wrapper_pos != -1, "'Hook wrapper' section not found in doctor output"
        assert worker_pos != -1, "'Worker' section not found in doctor output"
        assert hook_wrapper_pos < worker_pos, (
            "Hook wrapper section should appear before Worker section"
        )

    def test_hook_wrapper_invoke_timeout_shows_warn(self, tmp_path, monkeypatch):
        """A subprocess.TimeoutExpired during wrapper invocation surfaces as [WARN]."""
        wrapper = tmp_path / "bin" / "tg-hook.cmd"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        content = "@echo off\r\n"
        wrapper.write_text(content, encoding="utf-8", newline="")

        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: wrapper)
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: content)

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="cmd", timeout=10)):
            result = runner.invoke(cli.app, ["doctor"])

        assert result.exit_code == 0
        assert "[WARN]" in result.output
        assert "timed out" in result.output


# ---------------------------------------------------------------------------
# Stats section in doctor output: top kinds, last-write recency, kind coverage
# ---------------------------------------------------------------------------


class TestDoctorStatsSection:
    """doctor surfaces stats-DB health: top mechanisms, recency, kind coverage."""

    def test_top_kinds_listed_when_rows_exist(self, tmp_data_dir):
        """When stats has rows, doctor shows the top mechanisms by tokens."""
        db.record_stat(None, "image_shrink", bytes_saved=10000, tokens_saved=2500)
        db.record_stat(None, "read_replacement", bytes_saved=4000, tokens_saved=1000)
        db.record_stat(None, "session_hint", bytes_saved=2000, tokens_saved=500)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "top kind: image_shrink" in result.output
        assert "2500 tokens" in result.output

    def test_unmapped_kind_surfaces_as_warn(self, tmp_data_dir):
        """A record_stat with an unknown kind name lands in SOURCE_OTHER and
        doctor flags it as ``[WARN] unmapped kinds`` so a future regression
        (someone adds a kind but forgets to map it) does not silently lose
        attribution in `token-goat stats`."""
        db.record_stat(None, "totally_new_kind_2026", bytes_saved=500, tokens_saved=125)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "unmapped kinds" in result.output
        assert "totally_new_kind_2026" in result.output
        # Must surface as a [WARN] so doctor exit reflects the problem.
        warn_pos = result.output.find("[WARN] unmapped kinds")
        assert warn_pos != -1, (
            "expected '[WARN] unmapped kinds' line, got:\n" + result.output
        )

    def test_all_mapped_kinds_show_all_clear(self, tmp_data_dir):
        """When every kind has a source-bucket mapping, doctor shows OK."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "session_hint", bytes_saved=500, tokens_saved=125)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "kind coverage" in result.output
        assert "all kinds mapped" in result.output

    def test_recent_write_shows_minutes(self, tmp_data_dir):
        """A row written moments ago surfaces as ``last write: Nm ago``."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "last write" in result.output
        assert "m ago" in result.output  # minute granularity

    def test_stale_write_surfaces_as_warn(self, tmp_data_dir, monkeypatch):
        """A stats DB with no fresh rows in the last week is a leading
        indicator of broken hook wiring — doctor surfaces this as [WARN]."""
        # Write a row, then back-date its ts to 10 days ago.
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        ten_days_ago = int(time.time()) - 10 * 86400
        with db.open_global() as conn:
            conn.execute("UPDATE stats SET ts = ? WHERE kind = ?", (ten_days_ago, "image_shrink"))
            conn.commit()

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "last write" in result.output
        assert "stats DB looks stale" in result.output

    def test_bash_compress_prefix_does_not_count_as_unmapped(self, tmp_data_dir):
        """``bash_compress:<filter>`` rows must NOT show up as unmapped — they
        are routed by the _KIND_PREFIX_TO_SOURCE table."""
        db.record_stat(None, "bash_compress:pytest", bytes_saved=500, tokens_saved=125)
        db.record_stat(None, "bash_compress:npm", bytes_saved=300, tokens_saved=75)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        # No [WARN] unmapped kinds line.
        assert "[WARN] unmapped kinds" not in result.output
        # The all-clear line should be present.
        assert "all kinds mapped" in result.output


class TestDoctorCompactionUtilization:
    """Compaction budget utilization section in doctor output."""

    def _write_compact_row(self, budget: int, actual: int, trigger: str = "manual") -> None:
        detail = f"budget={budget},actual={actual},trigger={trigger},events=1"
        db.record_stat(None, "compact_manifest", tokens_saved=0, bytes_saved=0, detail=detail)

    def test_p50_correct_for_three_values(self, tmp_data_dir):
        """p50 must return the median (index 1 of 3) not the minimum (index 0).

        With n=3 and values [0.3, 0.6, 0.9] the floor formula gives index 0 (30%)
        but the correct ceiling nearest-rank formula gives index 1 (60%).
        """
        # utilizations: 30/100=0.30, 60/100=0.60, 90/100=0.90
        self._write_compact_row(100, 30)
        self._write_compact_row(100, 60)
        self._write_compact_row(100, 90)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        # p50 must be 60% (median), not 30% (minimum)
        assert "p50=60%" in result.output

    def test_p50_correct_for_five_values(self, tmp_data_dir):
        """p50 must return the middle value (index 2 of 5) not index 1.

        With n=5 and sorted values [10%, 20%, 50%, 80%, 90%] the floor formula
        gives index 1 (20%) but the ceiling formula gives index 2 (50%).
        """
        for actual in (10, 20, 50, 80, 90):
            self._write_compact_row(100, actual)

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "p50=50%" in result.output


class TestDoctorSkillPreservationConfig:
    """doctor output covers all skill_preservation config knobs for large-skill tuning."""

    def test_doctor_reports_skill_preservation_truncation_budget(self, tmp_data_dir):
        """skill_preservation.truncation_budget_tokens must appear in doctor output."""
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, f"doctor exited non-zero: {result.output}"
        assert "skill_preservation.truncation_budget_tokens" in result.output, (
            f"Expected truncation_budget_tokens in doctor output, got:\n{result.output}"
        )

    def test_doctor_reports_skill_preservation_compress_bodies(self, tmp_data_dir):
        """skill_preservation.compress_bodies must appear in doctor output."""
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, f"doctor exited non-zero: {result.output}"
        assert "skill_preservation.compress_bodies" in result.output, (
            f"Expected compress_bodies in doctor output, got:\n{result.output}"
        )

    def test_doctor_reports_skill_preservation_compress_min_bytes(self, tmp_data_dir):
        """skill_preservation.compress_min_bytes must appear in doctor output."""
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, f"doctor exited non-zero: {result.output}"
        assert "skill_preservation.compress_min_bytes" in result.output, (
            f"Expected compress_min_bytes in doctor output, got:\n{result.output}"
        )
