"""Thorough tests for WindsurfFilter Cascade AI patterns."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Fixture: a realistic Windsurf + Cascade session
# ---------------------------------------------------------------------------

_WINDSURF_CASCADE_SESSION = """\
Windsurf v1.4.2
Codeium: Activating...
Codeium index: loading...
Codeium index loaded
Connecting to Codeium server
Authentication status: authenticated
Model status: ready
Cascade: connected
Cascade: ready
Cascade v2.1.0
AI assistant ready
Loading workspace...
Indexing workspace... (234/1456 files)
Workspace loading
Scanning files...
File watcher started
Thinking...
Thinking...
Generating...

The `process_data` function in src/pipeline.py handles the main ETL flow.
It reads from S3, transforms the data, and writes to PostgreSQL.

Cascade is reading file: src/pipeline.py
Cascade is reading file: src/config.py
Cascade is reading file: src/models.py
Context: 45678 / 200000 tokens (23%)

I recommend refactoring the transform step into a separate class.

Telemetry is disabled
"""

# ---------------------------------------------------------------------------
# Individual Cascade-pattern tests
# ---------------------------------------------------------------------------


def test_windsurf_drops_cascade_status() -> None:
    """Cascade status lines are dropped as startup noise."""
    lines = (
        "Cascade: connected\n"
        "Cascade: disconnected\n"
        "Cascade: ready\n"
        "Cascade: connecting\n"
        "Cascade: starting\n"
        "Cascade: model loaded\n"
        "Cascade v2.1.0\n"
        "AI assistant ready\n"
        "AI assistant loaded\n"
        "AI assistant connecting\n"
        "Actual response content here.\n"
    )
    out = apply_filter(bc.WindsurfFilter(), stdout=lines)
    assert "Cascade: connected" not in out
    assert "Cascade: disconnected" not in out
    assert "Cascade: ready" not in out
    assert "Cascade v2.1.0" not in out
    assert "AI assistant ready" not in out
    assert "AI assistant loaded" not in out
    assert "AI assistant connecting" not in out
    assert "Actual response content here." in out


def test_windsurf_drops_cascade_spinner() -> None:
    """Cascade spinner / thinking lines are dropped."""
    lines = (
        "Thinking...\n"
        "Thinking\n"
        "Generating...\n"
        "Generating\n"
        "Cascade is thinking...\n"
        "Processing request...\n"
        "The answer is 42.\n"
    )
    out = apply_filter(bc.WindsurfFilter(), stdout=lines)
    assert "Thinking" not in out
    assert "Generating" not in out
    assert "Cascade is thinking" not in out
    assert "Processing request" not in out
    assert "The answer is 42." in out


def test_windsurf_collapses_cascade_tool_calls() -> None:
    """Cascade tool-call lines are collapsed to a count, not shown verbatim."""
    lines = (
        "Cascade is reading file: src/pipeline.py\n"
        "Cascade is reading file: src/config.py\n"
        "Cascade is writing file: src/output.py\n"
        "Cascade is running: pytest tests/\n"
        "Here is my analysis of the code.\n"
    )
    out = apply_filter(bc.WindsurfFilter(), stdout=lines)
    assert "src/pipeline.py" not in out
    assert "src/config.py" not in out
    assert "src/output.py" not in out
    # The count note should mention the collapsed calls
    assert "4" in out or "tool-call" in out or "collapsed" in out
    assert "Here is my analysis of the code." in out


def test_windsurf_drops_workspace_loading() -> None:
    """Workspace loading and scanning lines are dropped."""
    lines = (
        "Loading workspace...\n"
        "Indexing workspace... (234/1456 files)\n"
        "Workspace indexed\n"
        "Workspace ready\n"
        "Workspace loading\n"
        "Scanning files...\n"
        "File watcher started\n"
        "Ready to assist.\n"
    )
    out = apply_filter(bc.WindsurfFilter(), stdout=lines)
    assert "Loading workspace" not in out
    assert "Indexing workspace" not in out
    assert "Workspace indexed" not in out
    assert "Workspace ready" not in out
    assert "Scanning files" not in out
    assert "File watcher" not in out
    assert "Ready to assist." in out


def test_windsurf_keeps_context_as_note() -> None:
    """Context window meter lines are kept as a note, not inline."""
    lines = (
        "Context: 45678 / 200000 tokens (23%)\n"
        "Context: 67890 / 200000 tokens (34%)\n"
        "The refactoring is complete.\n"
    )
    out = apply_filter(bc.WindsurfFilter(), stdout=lines)
    # Raw context lines should not appear verbatim in output
    assert "67890 / 200000" in out  # last seen value preserved in note
    # Earlier meter line is superseded
    assert "45678 / 200000" not in out
    assert "The refactoring is complete." in out


def test_windsurf_keeps_response_body() -> None:
    """The actual AI response body is always kept verbatim."""
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_CASCADE_SESSION)
    assert "process_data" in out
    assert "src/pipeline.py" in out or "pipeline.py" in out or "ETL flow" in out
    assert "refactoring the transform step" in out


def test_windsurf_savings_on_cascade_session() -> None:
    """Savings on a realistic Cascade session are at least 35%."""
    ratio = savings_ratio(bc.WindsurfFilter(), stdout=_WINDSURF_CASCADE_SESSION)
    assert ratio >= 0.35, f"Expected >=35% savings, got {ratio:.0%}"


def test_windsurf_dispatch_routes() -> None:
    """detect_from_command('windsurf .') resolves to the WindsurfFilter."""
    result = bc.detect_from_command("windsurf .")
    assert result is not None
    filter_, _argv = result
    assert filter_.name == "windsurf"
    assert isinstance(filter_, bc.WindsurfFilter)
