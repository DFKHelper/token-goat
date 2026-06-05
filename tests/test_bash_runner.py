"""Tests for token_goat.bash_runner, subprocess wrapper around bash_compress."""
from __future__ import annotations

import io
import os

import pytest

from token_goat import bash_runner


def _captured_writers() -> tuple[io.StringIO, io.StringIO]:
    """Return ``(stdout, stderr)`` StringIO writers for mockable injection."""
    return io.StringIO(), io.StringIO()


# ---------------------------------------------------------------------------
# Passthrough mode (no filter matches)
# ---------------------------------------------------------------------------


class TestPassthrough:
    def test_unrecognised_command_runs_unchanged(self):
        rc = bash_runner.run("echo hello-passthrough", timeout=10)
        assert rc == 0

    def test_exit_code_preserved(self):
        rc = bash_runner.run("exit 7", timeout=10)
        assert rc == 7

    def test_command_not_found(self):
        rc = bash_runner.run("totally-bogus-binary-1234", timeout=10)
        # Shell returns 127 for command not found.
        assert rc in (127, 1, 2)


# ---------------------------------------------------------------------------
# Wrapped + compressed mode
# ---------------------------------------------------------------------------


class TestWrapAndCompress:
    def test_pytest_summary_compressed(self, tmp_data_dir):
        # Use a fake pytest invocation via printf-driven echo to control output.
        # We pick a filter we know exists by passing filter_name explicitly.
        out_buf, err_buf = _captured_writers()
        # Pipe 200 fake PASSED lines through the pytest filter.
        cmd = (
            "python -c \"import sys; [sys.stdout.write(f'PASSED tests/test_{i}.py::test_x\\n')"
            " for i in range(200)]; print('= 200 passed, 0 failed in 1s =')\""
        )
        rc = bash_runner.run(
            cmd,
            filter_name="pytest",
            timeout=30,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        assert rc == 0
        text = out_buf.getvalue()
        assert "200 passed" in text
        # 200 individual PASSED lines should be collapsed.
        assert "collapsed" in text and "PASSED" in text

    def test_exit_code_surfaces_through_wrapper(self):
        # A failing command must propagate its exit code.
        out_buf, err_buf = _captured_writers()
        rc = bash_runner.run(
            "python -c \"import sys; sys.exit(3)\"",
            filter_name="pytest",
            timeout=10,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        assert rc == 3

    def test_stderr_captured(self):
        out_buf, err_buf = _captured_writers()
        # generic filter merges stderr into stdout output.
        rc = bash_runner.run(
            "python -c \"import sys; sys.stderr.write('errmsg\\n'); sys.stdout.write('outmsg\\n')\"",
            filter_name="generic",
            timeout=10,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        # generic doesn't exist as a name lookup target, so falls back to no
        # filter and exits with raw exec, exit code still 0.
        assert rc == 0


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class TestTimeout:
    @pytest.mark.skipif(os.name == "nt", reason="POSIX-only sleep semantics")
    def test_timeout_kills_long_command(self):
        out_buf, err_buf = _captured_writers()
        rc = bash_runner.run(
            "sleep 30",
            filter_name="pytest",  # any filter; just exercise the timeout path
            timeout=2,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        # 124 = timeout(1) convention.
        assert rc == 124

    @pytest.mark.skipif(os.name == "nt", reason="POSIX-only sleep semantics")
    def test_passthrough_timeout(self):
        rc = bash_runner.run("sleep 30", timeout=2)
        assert rc == 124


# ---------------------------------------------------------------------------
# Output cap (smoke)
# ---------------------------------------------------------------------------


class TestOverflow:
    def test_chained_command_with_explicit_filter(self):
        # "&&" chains are rejected by detect_from_command but pass when filter_name
        # is given explicitly.  Use cheap shell built-ins to avoid Python startup cost.
        out_buf, err_buf = _captured_writers()
        rc = bash_runner.run(
            "echo x && echo y",
            filter_name="pytest",
            timeout=10,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        assert rc == 0


# ---------------------------------------------------------------------------
# Stats recording (smoke, uses real DB via tmp_data_dir)
# ---------------------------------------------------------------------------


class TestStatsRecording:
    def test_savings_recorded_for_compressed_run(self, tmp_data_dir):
        # Force a heavy compression scenario and verify the stat row appears.
        out_buf, err_buf = _captured_writers()
        cmd = (
            "python -c \"import sys; [print(f'PASSED tests/test_{i}.py::test_x')"
            " for i in range(500)]\""
        )
        bash_runner.run(
            cmd,
            filter_name="pytest",
            timeout=30,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        # Query the stats DB for our row.
        from token_goat import db

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, bytes_saved, tokens_saved FROM stats WHERE kind LIKE 'bash_compress:%'"
            ).fetchall()
        assert rows, "expected at least one bash_compress stat row"
        assert any(r["bytes_saved"] > 0 for r in rows)

    def test_small_savings_below_threshold_not_recorded(self, tmp_data_dir):
        """Savings below MIN_RECORD_STAT_BYTES must not produce a stat row."""
        from unittest.mock import patch

        from token_goat import bash_runner as br

        # Build a CompressedOutput that saves only 3 bytes (below threshold of 32).
        result = br.bash_compress.CompressedOutput(
            text="x",
            original_bytes=10,
            compressed_bytes=7,
            filter_name="python",
        )
        assert result.bytes_saved == 3
        assert result.bytes_saved < br.MIN_RECORD_STAT_BYTES

        # _record_savings should return before importing db — patch at the db module level.
        with patch("token_goat.db.record_stat") as mock_record:
            br._record_savings(result, "python -c 'pass'", elapsed_ms=1.0)
        mock_record.assert_not_called()

    def test_savings_at_threshold_are_recorded(self, tmp_data_dir):
        """Savings at exactly MIN_RECORD_STAT_BYTES must produce a stat row."""
        from unittest.mock import patch

        from token_goat import bash_runner as br

        threshold = br.MIN_RECORD_STAT_BYTES
        result = br.bash_compress.CompressedOutput(
            text="x",
            original_bytes=threshold + 50,
            compressed_bytes=50,
            filter_name="pytest",
        )
        assert result.bytes_saved == threshold

        # Verify record_savings runs the DB call for bytes_saved == threshold.
        with patch("token_goat.db.record_stat") as mock_record:
            br._record_savings(result, "pytest tests/", elapsed_ms=5.0)
        assert mock_record.called, "record_stat must be called at threshold"
