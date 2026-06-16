"""Tests for SeverityLogFilter (severity-scored log stream compression)."""
from __future__ import annotations

from token_goat.bash_compress import SeverityLogFilter
from token_goat.config import SeverityLogConfig

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compress(
    stdout: str,
    *,
    context_lines: int = 3,
    score_threshold: float = 0.5,
    stderr: str = "",
    exit_code: int = 0,
) -> str:
    """Run SeverityLogFilter.compress with an overridden config."""
    from unittest.mock import MagicMock, patch
    cfg_mock = MagicMock()
    cfg_mock.bash_severity_log = SeverityLogConfig(
        context_lines=context_lines,
        score_threshold=score_threshold,
    )
    filt = SeverityLogFilter()
    # Patch token_goat.config.load (the real function) so the local import
    # alias inside compress() picks up the mock automatically.
    with patch("token_goat.config.load", return_value=cfg_mock):
        return filt.compress(stdout, stderr, exit_code, [])


# ---------------------------------------------------------------------------
# detect() tests
# ---------------------------------------------------------------------------

def test_detect_false_too_few_lines() -> None:
    """detect() returns False when fewer than 5 lines."""
    stream = "INFO: starting\nDEBUG: loaded\nINFO: ready\n"
    assert SeverityLogFilter.detect(stream) is False


def test_detect_false_low_keyword_ratio() -> None:
    """detect() returns False when fewer than 30 % of lines have log keywords."""
    lines = ["plain text line"] * 10 + ["INFO: only two keyword lines"] + ["more plain text"]
    # 1 keyword line out of 12 = 8.3 % < 30 %
    assert SeverityLogFilter.detect("\n".join(lines)) is False


def test_detect_true_structured_log() -> None:
    """detect() returns True for a well-formed structured log stream."""
    stream = "\n".join([
        "2024-01-01 00:00:01 INFO  Application starting",
        "2024-01-01 00:00:02 INFO  Loading config",
        "2024-01-01 00:00:03 DEBUG Config loaded ok",
        "2024-01-01 00:00:04 WARN  Deprecated option used",
        "2024-01-01 00:00:05 ERROR Connection refused",
        "2024-01-01 00:00:06 INFO  Retrying",
        "2024-01-01 00:00:07 DEBUG Attempt 2",
    ])
    assert SeverityLogFilter.detect(stream) is True


def test_detect_false_exactly_4_lines() -> None:
    """detect() rejects a stream with exactly 4 lines regardless of keyword ratio."""
    stream = "\n".join(["ERROR: a", "ERROR: b", "ERROR: c", "ERROR: d"])
    assert SeverityLogFilter.detect(stream) is False


# ---------------------------------------------------------------------------
# compress() suppression tests
# ---------------------------------------------------------------------------

def test_pure_debug_info_stream_all_suppressed() -> None:
    """All DEBUG/INFO lines below threshold are suppressed to a single sentinel."""
    lines = [f"DEBUG: step {i}" for i in range(10)] + [f"INFO: item {i}" for i in range(5)]
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    assert "[suppressed" in result
    assert "DEBUG" not in result
    assert "INFO" not in result


def test_error_line_kept_with_context() -> None:
    """An ERROR line and its N context lines are preserved."""
    lines = (
        ["DEBUG: before1", "DEBUG: before2", "DEBUG: before3"]
        + ["ERROR: boom"]
        + ["DEBUG: after1", "DEBUG: after2", "DEBUG: after3"]
    )
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=2)
    assert "ERROR: boom" in result
    # context before (only 2 lines before in this window)
    assert "DEBUG: before2" in result
    assert "DEBUG: before3" in result
    # context after
    assert "DEBUG: after1" in result
    assert "DEBUG: after2" in result


def test_warn_line_kept_at_default_threshold() -> None:
    """WARN lines score 0.5 and are kept unconditionally at default threshold."""
    lines = ["DEBUG: noise"] * 6 + ["WARN: deprecated call"] + ["DEBUG: more"] * 6
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    assert "WARN: deprecated call" in result


def test_stack_trace_after_error_preserved() -> None:
    """Multi-line stack trace opened by ERROR is preserved until blank line closes it."""
    lines = [
        "INFO: running",
        "INFO: connecting",
        "ERROR: connection failed",
        "    at connect (net.js:42)",
        "    at tryConnect (net.js:88)",
        "    at Socket.<anonymous> (net.js:120)",
        "",
        "INFO: retrying",
        "INFO: done",
    ]
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    assert "ERROR: connection failed" in result
    assert "at connect" in result
    assert "at tryConnect" in result
    assert "at Socket" in result


def test_context_lines_exact_count() -> None:
    """Exactly context_lines=2 lines are kept before and after the ERROR line."""
    # Build: 5 debug lines, 1 error, 5 debug lines.
    before = [f"DEBUG: b{i}" for i in range(5)]
    after = [f"DEBUG: a{i}" for i in range(5)]
    lines = before + ["ERROR: boom"] + after
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=2)
    result_lines = [ln for ln in result.splitlines() if not ln.startswith("[suppressed")]
    # Should contain: b3, b4, ERROR, a0, a1 (the 2 before and 2 after)
    assert "DEBUG: b3" in result
    assert "DEBUG: b4" in result
    assert "ERROR: boom" in result
    assert "DEBUG: a0" in result
    assert "DEBUG: a1" in result
    # Confirm b0..b2 are NOT in the kept lines
    assert "DEBUG: b0" not in "\n".join(result_lines)
    assert "DEBUG: b1" not in "\n".join(result_lines)
    assert "DEBUG: b2" not in "\n".join(result_lines)


def test_gap_sentinel_correct_suppressed_count() -> None:
    """The sentinel accurately reports the number of suppressed lines in each gap."""
    lines = ["DEBUG: noise"] * 7 + ["ERROR: boom"] + ["DEBUG: tail"] * 4
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    # 7 noise lines before the error are suppressed
    assert "[suppressed 7 lines]" in result
    # 4 tail lines after the error are suppressed
    assert "[suppressed 4 lines]" in result


def test_score_threshold_one_drops_warn() -> None:
    """score_threshold=1.0 keeps only ERROR/FAIL lines; WARN (0.5) is dropped."""
    lines = ["INFO: ok"] * 3 + ["WARN: deprecated"] + ["INFO: ok"] * 3 + ["ERROR: fatal"]
    # Ensure enough lines for detect() — pad to >5 lines with keywords
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0, score_threshold=1.0)
    assert "ERROR: fatal" in result
    assert "WARN: deprecated" not in result.replace("[suppressed", "")


def test_context_lines_zero_keeps_only_matched() -> None:
    """context_lines=0 keeps only the exactly matching lines, no neighbours."""
    lines = (
        ["DEBUG: before1", "DEBUG: before2"]
        + ["ERROR: oops"]
        + ["DEBUG: after1", "DEBUG: after2"]
    )
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    assert "ERROR: oops" in result
    assert "DEBUG: before1" not in result.replace("[suppressed", "")
    assert "DEBUG: after1" not in result.replace("[suppressed", "")


def test_trace_window_closed_by_blank_line() -> None:
    """Lines after a blank line that closes a trace window are scored normally."""
    lines = [
        "INFO: start",
        "INFO: running",
        "ERROR: failure",
        "    at foo (bar.js:1)",
        "",
        "DEBUG: this is after blank",
        "INFO: resuming",
        "INFO: done",
        "INFO: finished",
    ]
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    # ERROR and trace line kept
    assert "ERROR: failure" in result
    assert "at foo (bar.js:1)" in result
    # Lines after the blank are scored normally — DEBUG/INFO suppressed
    assert "DEBUG: this is after blank" not in result.replace("[suppressed", "")


def test_non_log_stream_passes_through() -> None:
    """Output that does not look like a log stream passes through unchanged."""
    lines = ["Hello world", "This is plain text", "No log keywords here at all", "Just output"]
    stdout = "\n".join(lines)
    result = _compress(stdout)
    # No suppression — returned as-is (detect() returns False)
    assert "Hello world" in result
    assert "[suppressed" not in result


def test_python_traceback_preserved() -> None:
    """Stack trace lines matching _TRACE_CONTINUATION_RE are kept inside trace window.

    Uses indented File/in/raise lines that directly follow the ERROR line so they
    match the continuation regex (^SPACE+(?:File "|in |...) and ^SPACE+word(...)$).
    The bare 'Traceback (most recent call last):' header is intentionally omitted
    because it has no leading whitespace and does not match the spec regex.
    """
    lines = [
        "INFO: process starting",
        "INFO: connecting to db",
        "ERROR: RuntimeError occurred",
        '  File "app.py", line 42, in main',
        "    connect()",
        '  File "db.py", line 10, in connect',
        "    raise RuntimeError('timeout')",
        "",
        "INFO: exiting",
    ]
    stdout = "\n".join(lines)
    result = _compress(stdout, context_lines=0)
    assert "ERROR: RuntimeError occurred" in result
    assert 'File "app.py"' in result
    assert 'File "db.py"' in result
