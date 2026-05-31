"""Tests for CursorFilter, WindsurfFilter, OpenCodeFilter, and ContinueFilter."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# CursorFilter
# ---------------------------------------------------------------------------

_CURSOR_STARTUP_VERBOSE = """\
Cursor 0.42.3
Extension host started
Extension 'cursor.cursor-always-local' activated
Extension 'cursor.anysphere-codewhisperer' activated
Telemetry is disabled
Starting debug adapter
Opening folder...
Connection established
Tunnel connected
> Your project is loaded successfully.
Error: failed to load extension cursor.bad-ext
"""

_CURSOR_CLEAN_OUTPUT = """\
> Running test suite...
All 42 tests passed.
Build completed in 3.2s.
"""

_CURSOR_ERROR_OUTPUT = """\
Cursor 0.42.3
Extension host started
Error: Cannot find module 'some-module'
"""


def test_cursor_filter_matches() -> None:
    f = bc.CursorFilter()
    assert f.matches(["cursor"])
    assert f.matches(["cursor", "--new-window"])
    assert f.matches(["cursor", "."])
    assert not f.matches(["code"])
    assert not f.matches(["windsurf"])
    assert not f.matches([])


def test_cursor_drops_startup_lines() -> None:
    out = apply_filter(bc.CursorFilter(), stdout=_CURSOR_STARTUP_VERBOSE)
    assert "Extension host started" not in out
    assert "Extension 'cursor." not in out
    assert "Telemetry is disabled" not in out
    assert "Starting debug adapter" not in out
    assert "Opening folder" not in out
    assert "Connection established" not in out
    assert "Tunnel connected" not in out


def test_cursor_drops_version_banner() -> None:
    out = apply_filter(bc.CursorFilter(), stdout=_CURSOR_STARTUP_VERBOSE)
    assert "Cursor 0.42.3" not in out


def test_cursor_keeps_error_signals() -> None:
    out = apply_filter(bc.CursorFilter(), stdout=_CURSOR_STARTUP_VERBOSE)
    assert "Error: failed to load extension" in out


def test_cursor_keeps_clean_output() -> None:
    out = apply_filter(bc.CursorFilter(), stdout=_CURSOR_CLEAN_OUTPUT)
    assert "42 tests passed" in out
    assert "Build completed" in out


def test_cursor_preserves_all_stderr_on_error() -> None:
    out = apply_filter(
        bc.CursorFilter(),
        stdout="Cursor 0.42.3\nExtension host started\n",
        stderr="Error: Cannot find module 'some-module'\n",
        exit_code=1,
    )
    assert "Cannot find module" in out


def test_cursor_savings() -> None:
    ratio = savings_ratio(bc.CursorFilter(), stdout=_CURSOR_STARTUP_VERBOSE)
    assert ratio >= 0.30, f"Expected ≥30% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# WindsurfFilter
# ---------------------------------------------------------------------------

_WINDSURF_STARTUP_VERBOSE = """\
Windsurf 1.3.0
Extension host started
Extension 'codeium.codeium' activated
Codeium: Activating...
Codeium index: loading...
Codeium index loaded
Connecting to Codeium server
Authentication status: authenticated
Model status: ready
Telemetry is disabled
Opening folder...

> Cascade is ready.
Your workspace has 127 Python files.
"""

_WINDSURF_ERROR_OUTPUT = """\
Windsurf 1.3.0
Extension host started
Codeium: Activating...
Error: Codeium authentication failed
"""


def test_windsurf_filter_matches() -> None:
    f = bc.WindsurfFilter()
    assert f.matches(["windsurf"])
    assert f.matches(["windsurf", "--new-window"])
    assert f.matches(["windsurf", "."])
    assert not f.matches(["cursor"])
    assert not f.matches(["code"])
    assert not f.matches([])


def test_windsurf_drops_startup_lines() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert "Extension host started" not in out
    assert "Extension 'codeium." not in out
    assert "Opening folder" not in out


def test_windsurf_drops_codeium_noise() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert "Codeium: Activating" not in out
    assert "Codeium index: loading" not in out
    assert "Connecting to Codeium server" not in out
    assert "Authentication status:" not in out
    assert "Model status:" not in out


def test_windsurf_drops_version_banner() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert "Windsurf 1.3.0" not in out


def test_windsurf_drops_telemetry() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert "Telemetry is disabled" not in out


def test_windsurf_keeps_actual_output() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert "Cascade is ready" in out
    assert "127 Python files" in out


def test_windsurf_keeps_error_signals() -> None:
    out = apply_filter(bc.WindsurfFilter(), stdout=_WINDSURF_ERROR_OUTPUT)
    assert "Error: Codeium authentication failed" in out


def test_windsurf_preserves_all_stderr_on_error() -> None:
    out = apply_filter(
        bc.WindsurfFilter(),
        stdout="Windsurf 1.3.0\nExtension host started\n",
        stderr="Error: License expired\n",
        exit_code=1,
    )
    assert "License expired" in out


def test_windsurf_savings() -> None:
    ratio = savings_ratio(bc.WindsurfFilter(), stdout=_WINDSURF_STARTUP_VERBOSE)
    assert ratio >= 0.30, f"Expected ≥30% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# OpenCodeFilter
# ---------------------------------------------------------------------------

_OPENCODE_SESSION = """\
OpenCode v0.3.1
Provider: anthropic
Model: claude-3-5-sonnet-20241022
Mode: auto

Context: 8234 / 200000

The project uses a monorepo layout with packages under src/.
Each package has its own pyproject.toml.

Context: 9101 / 200000
Session saved to ~/.opencode/sessions/abc123.json
"""

_OPENCODE_WITH_TOOLS = """\
OpenCode v0.3.1
Provider: openai
Model: gpt-4o

→ read_file(path="src/main.py")
← result (1847 chars)
→ bash(command="pytest tests/ -q")
← result (342 chars)
...

All tests pass. The entry point is src/main.py:main().

Context: 15000 / 128000
"""

_OPENCODE_ERROR = """\
OpenCode v0.3.1
Provider: anthropic
Model: claude-3-5-sonnet-20241022
Error: API key invalid or expired
"""


def test_opencode_filter_matches() -> None:
    f = bc.OpenCodeFilter()
    assert f.matches(["opencode"])
    assert f.matches(["opencode", "--model", "gpt-4o"])
    assert not f.matches(["aider"])
    assert not f.matches(["cursor"])
    assert not f.matches([])


def test_opencode_drops_banner() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    assert "OpenCode v0.3.1" not in out


def test_opencode_drops_spinner() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_WITH_TOOLS)
    # bare "..." spinner should not be in the final output
    assert "\n...\n" not in out


def test_opencode_drops_session_footer() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    assert "Session saved to" not in out


def test_opencode_collapses_tool_calls() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_WITH_TOOLS)
    assert "→ read_file" not in out
    assert "← result" not in out
    # collapsed summary should appear
    assert "tool call" in out.lower() or "token-goat" in out


def test_opencode_keeps_last_provider_and_model() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    assert "anthropic" in out.lower() or "provider" in out.lower()
    assert "claude" in out.lower() or "model" in out.lower()


def test_opencode_keeps_context_meter() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    # Last context value should be surfaced
    assert "9101" in out or "context" in out.lower()


def test_opencode_keeps_response_body() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    assert "monorepo" in out
    assert "pyproject.toml" in out


def test_opencode_keeps_error_signals() -> None:
    out = apply_filter(bc.OpenCodeFilter(), stdout=_OPENCODE_ERROR)
    assert "Error:" in out


def test_opencode_preserves_all_stderr_on_error() -> None:
    out = apply_filter(
        bc.OpenCodeFilter(),
        stdout="OpenCode v0.3.1\nProvider: openai\n",
        stderr="Error: rate limit exceeded\n",
        exit_code=1,
    )
    assert "rate limit exceeded" in out


def test_opencode_savings() -> None:
    ratio = savings_ratio(bc.OpenCodeFilter(), stdout=_OPENCODE_SESSION)
    assert ratio >= 0.08, f"Expected ≥8% savings, got {ratio:.0%}"


def test_dispatch_routes_opencode() -> None:
    result = bc.detect_from_command("opencode --model gpt-4o")
    assert result is not None
    filter_, _argv = result
    assert filter_.name == "opencode"


# ---------------------------------------------------------------------------
# ContinueFilter
# ---------------------------------------------------------------------------

_CONTINUE_VERBOSE = """\
Continue v0.9.215
Config loaded from /home/user/.continue/config.json
Loading model: codestral-latest...
Indexing: 1/1234 files...
Indexing: 42/1234 files...
Indexing: 500/1234 files...
Indexing: 1234/1234 files...

The quicksort implementation in src/sort.py is correct but can be
optimised by switching to an iterative approach for large inputs.

Tokens: 2048 prompt, 412 completion
"""

_CONTINUE_PARTIAL = """\
Continue v0.9.215
Config loaded from ~/.continue/config.json
Loading model: claude-3-5-haiku-20241022...
Indexing: 10/200 files...
Indexing: 200/200 files...
Here is the refactored code.
"""

_CONTINUE_ERROR = """\
Continue v0.9.215
Config loaded from ~/.continue/config.json
Loading model: codestral-latest...
Error: Model endpoint returned 503
"""


def test_continue_filter_matches() -> None:
    f = bc.ContinueFilter()
    assert f.matches(["continue"])
    assert f.matches(["continue", "--model", "codestral"])
    assert not f.matches(["aider"])
    assert not f.matches(["opencode"])
    assert not f.matches([])


def test_continue_drops_banner() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert "Continue v0.9.215" not in out


def test_continue_drops_config_load() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert "Config loaded from" not in out


def test_continue_drops_model_load() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert "Loading model:" not in out


def test_continue_collapses_indexing_progress() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    # Individual progress lines must be gone
    assert "Indexing: 1/1234" not in out
    assert "Indexing: 42/1234" not in out
    assert "Indexing: 500/1234" not in out
    # But a collapsed summary should appear
    assert "indexing" in out.lower() or "token-goat" in out


def test_continue_collapses_partial_indexing() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_PARTIAL)
    # Individual progress lines should not appear as standalone output lines
    # (they may appear inside the collapsed token-goat summary note)
    body_lines = [
        ln for ln in out.splitlines()
        if not ln.startswith("[token-goat:")
    ]
    body = "\n".join(body_lines)
    assert "Indexing: 10/200" not in body
    assert "Indexing: 200/200" not in body
    # Collapsed summary must appear
    assert "indexing" in out.lower() or "token-goat" in out


def test_continue_keeps_token_stats() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert "2048" in out or "412" in out or "token" in out.lower()


def test_continue_keeps_response_body() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert "quicksort" in out
    assert "src/sort.py" in out


def test_continue_keeps_error_signals() -> None:
    out = apply_filter(bc.ContinueFilter(), stdout=_CONTINUE_ERROR)
    assert "Error:" in out


def test_continue_preserves_all_stderr_on_error() -> None:
    out = apply_filter(
        bc.ContinueFilter(),
        stdout="Continue v0.9.215\nConfig loaded from ~/.continue/config.json\n",
        stderr="Error: cannot connect to language server\n",
        exit_code=1,
    )
    assert "cannot connect to language server" in out


def test_continue_savings() -> None:
    ratio = savings_ratio(bc.ContinueFilter(), stdout=_CONTINUE_VERBOSE)
    assert ratio >= 0.05, f"Expected ≥5% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# FILTERS list registration
# ---------------------------------------------------------------------------


def test_new_ai_filters_registered() -> None:
    """All new AI editor filters appear in the FILTERS dispatch list."""
    names = {f.name for f in bc.FILTERS}
    assert "cursor" in names
    assert "windsurf" in names
    assert "opencode" in names
    assert "continue" in names


def test_new_ai_filters_in_all_exports() -> None:
    """New AI filter classes are exported via __all__."""
    assert "CursorFilter" in bc.__all__
    assert "WindsurfFilter" in bc.__all__
    assert "OpenCodeFilter" in bc.__all__
    assert "ContinueFilter" in bc.__all__


def test_dispatch_routes_cursor() -> None:
    result = bc.detect_from_command("cursor .")
    assert result is not None
    filter_, _argv = result
    assert filter_.name == "cursor"


def test_dispatch_routes_windsurf() -> None:
    result = bc.detect_from_command("windsurf --new-window")
    assert result is not None
    filter_, _argv = result
    assert filter_.name == "windsurf"


def test_dispatch_routes_continue() -> None:
    result = bc.detect_from_command("continue --model codestral")
    assert result is not None
    filter_, _argv = result
    assert filter_.name == "continue"
