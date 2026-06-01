"""Tests for the session-aware token-goat grep command."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from token_goat import session
from token_goat.read_commands import _compress_grep_output, _grep_output_hash, grep

# ---------------------------------------------------------------------------
# _compress_grep_output unit tests
# ---------------------------------------------------------------------------


class TestCompressGrepOutput:
    def test_short_output_unchanged(self) -> None:
        """Lines under the cap are returned as-is."""
        lines = [f"line {i}" for i in range(50)]
        assert _compress_grep_output(lines) == lines

    def test_exactly_at_cap_unchanged(self) -> None:
        """Exactly 200 lines are returned without compression."""
        lines = [f"line {i}" for i in range(200)]
        assert _compress_grep_output(lines) == lines

    def test_over_cap_compressed(self) -> None:
        """201 lines trigger compression: 100 head + marker + 20 tail."""
        lines = [f"line {i}" for i in range(300)]
        result = _compress_grep_output(lines)
        # Should have 100 head + 1 marker + 20 tail = 121 lines
        assert len(result) == 121
        # Marker present
        assert any("more lines" in ln for ln in result)
        # First and last lines preserved
        assert result[0] == "line 0"
        assert result[-1] == "line 299"

    def test_marker_shows_omitted_count(self) -> None:
        """The marker accurately reflects the number of omitted lines."""
        lines = [f"x{i}" for i in range(250)]
        result = _compress_grep_output(lines)
        marker = next(ln for ln in result if "more lines" in ln)
        # 250 - 100 - 20 = 130 omitted
        assert "130" in marker


# ---------------------------------------------------------------------------
# _grep_output_hash
# ---------------------------------------------------------------------------


class TestGrepOutputHash:
    def test_returns_8_hex_chars(self) -> None:
        h = _grep_output_hash("some output")
        assert len(h) == 8
        assert all(c in "0123456789abcdef" for c in h)

    def test_deterministic(self) -> None:
        assert _grep_output_hash("foo bar") == _grep_output_hash("foo bar")

    def test_different_inputs_differ(self) -> None:
        assert _grep_output_hash("abc") != _grep_output_hash("xyz")


# ---------------------------------------------------------------------------
# grep() — cache miss (first call)
# ---------------------------------------------------------------------------


class TestGrepCacheMiss:
    """First call: no session history → runs rg, records result."""

    def test_runs_rg_on_miss(self, tmp_data_dir, capsys: pytest.CaptureFixture[str]) -> None:
        rg_output = "src/foo.py:1: hello world\nsrc/bar.py:5: hello there\n"
        mock_proc = MagicMock()
        mock_proc.stdout = rg_output
        mock_proc.returncode = 0

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            grep("hello", "src/")

        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        assert call_args[0] == "rg"
        assert call_args[1] == "hello"
        assert call_args[2] == "src/"

        out = capsys.readouterr().out
        assert "src/foo.py:1: hello world" in out
        assert "Cached" not in out

    def test_no_cache_hint_on_miss(self, tmp_data_dir, capsys: pytest.CaptureFixture[str]) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = "result line\n"
        mock_proc.returncode = 0

        with patch("subprocess.run", return_value=mock_proc):
            grep("pattern", ".", session_id="miss-test-session")

        out = capsys.readouterr().out
        assert "⚡" not in out
        assert "Cached" not in out

    def test_session_updated_after_miss(self, tmp_data_dir) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = "found: line 1\nfound: line 2\n"
        mock_proc.returncode = 0

        sid = "update-session-1"
        with patch("subprocess.run", return_value=mock_proc):
            grep("found", ".", session_id=sid)

        loaded = session.load(sid)
        assert len(loaded.greps) == 1
        assert loaded.greps[0].pattern == "found"
        # result hash stored
        assert len(loaded.grep_result_hashes) == 1


# ---------------------------------------------------------------------------
# grep() — cache hit (same pattern+path, same results)
# ---------------------------------------------------------------------------


class TestGrepCacheHit:
    """Second call with identical output → emits cache hint."""

    def _seed_session(self, sid: str, pattern: str, output: str, path: str = ".") -> None:
        """Simulate a prior grep run by recording it in the session."""
        mock_proc = MagicMock()
        mock_proc.stdout = output
        mock_proc.returncode = 0
        with patch("subprocess.run", return_value=mock_proc):
            grep(pattern, path, session_id=sid)

    def test_cache_hint_on_second_identical_call(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        sid = "cache-hit-session-1"
        output = "src/foo.py:1: def foo():\n"

        # First call
        self._seed_session(sid, "def foo", output)
        capsys.readouterr()  # discard first call output

        # Second call — same output
        mock_proc = MagicMock()
        mock_proc.stdout = output
        mock_proc.returncode = 0
        with patch("subprocess.run", return_value=mock_proc):
            grep("def foo", ".", session_id=sid)

        out = capsys.readouterr().out
        assert "⚡" in out
        assert "Cached grep result (session hit)" in out

    def test_no_hint_when_results_changed(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        sid = "cache-hit-session-2"
        first_output = "src/foo.py:1: old result\n"
        second_output = "src/foo.py:1: new result — changed\n"

        self._seed_session(sid, "result", first_output)
        capsys.readouterr()

        mock_proc = MagicMock()
        mock_proc.stdout = second_output
        mock_proc.returncode = 0
        with patch("subprocess.run", return_value=mock_proc):
            grep("result", ".", session_id=sid)

        out = capsys.readouterr().out
        # Different content hash → no cache hint
        assert "⚡" not in out
        assert "Cached" not in out

    def test_no_hint_when_path_differs(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Same pattern but different path is a distinct search."""
        sid = "cache-hit-session-3"
        output = "match\n"

        self._seed_session(sid, "match", output, path="src/")
        capsys.readouterr()

        mock_proc = MagicMock()
        mock_proc.stdout = output
        mock_proc.returncode = 0
        with patch("subprocess.run", return_value=mock_proc):
            grep("match", "tests/", session_id=sid)

        out = capsys.readouterr().out
        assert "⚡" not in out


# ---------------------------------------------------------------------------
# grep() — output truncation
# ---------------------------------------------------------------------------


class TestGrepOutputTruncation:
    def test_truncated_at_200_lines(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        big_output = "\n".join(f"line{i}" for i in range(300)) + "\n"
        mock_proc = MagicMock()
        mock_proc.stdout = big_output
        mock_proc.returncode = 0

        with patch("subprocess.run", return_value=mock_proc):
            grep("line", ".", session_id=None)

        out = capsys.readouterr().out
        output_lines = [ln for ln in out.splitlines() if ln]
        # 100 head + 1 marker + 20 tail = 121 lines
        assert len(output_lines) == 121
        assert any("more lines" in ln for ln in output_lines)

    def test_small_output_not_truncated(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        small_output = "a\nb\nc\n"
        mock_proc = MagicMock()
        mock_proc.stdout = small_output
        mock_proc.returncode = 0

        with patch("subprocess.run", return_value=mock_proc):
            grep("a", ".")

        out = capsys.readouterr().out
        assert "more lines" not in out
        assert "a" in out and "b" in out and "c" in out


# ---------------------------------------------------------------------------
# grep() — JSON output mode
# ---------------------------------------------------------------------------


class TestGrepJsonOutput:
    def test_json_miss_structure(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = "result1\nresult2\n"
        mock_proc.returncode = 0

        with patch("subprocess.run", return_value=mock_proc):
            grep("pattern", ".", json_output=True)

        raw = capsys.readouterr().out.strip()
        data = json.loads(raw)
        assert data["ok"] is True
        assert data["pattern"] == "pattern"
        assert data["path"] == "."
        assert data["total_lines"] == 2
        assert data["cache_hit"] is False
        assert "output" in data
        assert "cache_age_seconds" not in data

    def test_json_hit_includes_age(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        sid = "json-hit-session"
        output = "found it\n"

        # First call — seed
        mock_proc = MagicMock()
        mock_proc.stdout = output
        mock_proc.returncode = 0
        with patch("subprocess.run", return_value=mock_proc):
            grep("found", ".", session_id=sid, json_output=True)
        capsys.readouterr()

        # Second call — cache hit
        mock_proc2 = MagicMock()
        mock_proc2.stdout = output
        mock_proc2.returncode = 0
        with patch("subprocess.run", return_value=mock_proc2):
            grep("found", ".", session_id=sid, json_output=True)

        raw = capsys.readouterr().out.strip()
        data = json.loads(raw)
        assert data["ok"] is True
        assert data["cache_hit"] is True
        assert "cache_age_seconds" in data
        assert isinstance(data["cache_age_seconds"], int)


# ---------------------------------------------------------------------------
# grep() — rg not found / rg error handling
# ---------------------------------------------------------------------------


class TestGrepErrorHandling:
    def test_rg_not_found(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError):
            grep("pattern", ".")

        err = capsys.readouterr().err
        assert "ripgrep" in err.lower() or "rg" in err.lower()

    def test_rg_error_exit_code(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        mock_proc = MagicMock()
        mock_proc.stdout = ""
        mock_proc.stderr = "rg: error: bad regex"
        mock_proc.returncode = 2

        with patch("subprocess.run", return_value=mock_proc):
            grep("(invalid[", ".")

        err = capsys.readouterr().err
        assert "grep error" in err

    def test_rg_no_matches_exit_1_is_ok(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """rg exits 1 on no matches — should be treated as empty, not an error."""
        mock_proc = MagicMock()
        mock_proc.stdout = ""
        mock_proc.stderr = ""
        mock_proc.returncode = 1

        with patch("subprocess.run", return_value=mock_proc):
            grep("no_such_pattern", ".")

        # No error output — empty output is fine
        cap = capsys.readouterr()
        assert "error" not in cap.err.lower()

    def test_rg_not_found_json_output(
        self, tmp_data_dir, capsys: pytest.CaptureFixture[str]
    ) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError):
            grep("pattern", ".", json_output=True)

        raw = capsys.readouterr().out.strip()
        data = json.loads(raw)
        assert data["ok"] is False
        assert "error" in data
