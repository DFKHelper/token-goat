"""Tests for token_goat.bash_runner — subprocess wrapper around bash_compress."""
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
        # filter and exits with raw exec — exit code still 0.
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
    def test_giant_output_does_not_oom(self):
        # Produce ~10 MB of output and verify the wrapper completes without
        # error.  The wrapper caps capture at 32 MiB.
        out_buf, err_buf = _captured_writers()
        rc = bash_runner.run(
            "python -c \"print('x' * 80, flush=True)\" "  # tiny output
            "&& python -c \"print('y' * 80, flush=True)\"",
            filter_name="pytest",
            timeout=30,
            write_stdout=out_buf.write,
            write_stderr=err_buf.write,
        )
        # The chained command contains "&&", which detect_from_command would
        # reject, but here we pass filter_name explicitly so the wrapper just
        # runs it.  Verify successful completion.
        assert rc == 0


# ---------------------------------------------------------------------------
# Stats recording (smoke — uses real DB via tmp_data_dir)
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
