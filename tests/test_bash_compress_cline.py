"""Tests for ClineFilter (Cline AI coding assistant CLI output compression)."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Realistic mixed Cline session output
# ---------------------------------------------------------------------------

_CLINE_SESSION = """\
Cline v3.2.1
Loading workspace...
MCP Server 'filesystem' connected (3 tools enabled)
MCP Server 'memory' connected (5 tools enabled)
Thinking...
Processing...
I'll analyze the authentication module and suggest improvements.

The current implementation has a few issues worth addressing:
1. The token refresh logic doesn't handle network timeouts gracefully.
2. Session expiry is checked only on login, not on each request.

Cline wants to execute: npm test -- --testPathPattern=auth
Reading file: src/auth.py...
Reading file: src/session.py...
Reading file: tests/test_auth.py...
Streaming response...
✅ Edited src/auth.py
✅ Edited src/session.py
Running: npm test
Command output:
  PASS tests/test_auth.py
Tokens: 45,123 (↑ 32,456 in, ↓ 12,667 out)
API Cost: $0.1234
Context Window: 45,123 / 200,000 tokens (22%)
Task completed successfully.
"""

_CLINE_SESSION_MULTI_COST = """\
Cline v3.1.0
Loading workspace...
Thinking...
Here is my plan for the refactor.
Tokens: 10,000 (↑ 7,000 in, ↓ 3,000 out)
API Cost: $0.0200
Context Window: 10,000 / 200,000 tokens (5%)
Processing...
Refactor complete.
Tokens: 25,500 (↑ 18,000 in, ↓ 7,500 out)
API Cost: $0.0512
Context Window: 25,500 / 200,000 tokens (12%)
"""

_CLINE_ERROR_SESSION = """\
Cline v3.2.1
Loading workspace...
Thinking...
Error: Cannot read property 'map' of undefined
Traceback (most recent call last):
  File "main.py", line 42, in run
    TypeError: 'NoneType' is not iterable
"""


# ---------------------------------------------------------------------------
# matches()
# ---------------------------------------------------------------------------


def test_cline_matches() -> None:
    f = bc.ClineFilter()
    assert f.matches(["cline"])
    assert f.matches(["cline", "--task", "refactor auth.py"])
    assert f.matches(["claude-dev"])
    assert f.matches(["claude-dev", "--help"])
    assert not f.matches(["npm"])
    assert not f.matches(["npx"])
    assert not f.matches(["aider"])
    assert not f.matches([])


# ---------------------------------------------------------------------------
# Version banner
# ---------------------------------------------------------------------------


def test_cline_drops_version_banner() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION)
    assert "Cline v3.2.1" not in out


# ---------------------------------------------------------------------------
# Spinner / progress lines
# ---------------------------------------------------------------------------


def test_cline_drops_spinner_lines() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION)
    # "Thinking..." / "Processing..." / "Streaming response..." dropped
    assert "Thinking..." not in out
    assert "Processing..." not in out
    assert "Streaming response..." not in out


# ---------------------------------------------------------------------------
# MCP noise
# ---------------------------------------------------------------------------


def test_cline_drops_mcp_noise() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION)
    assert "MCP Server" not in out


# ---------------------------------------------------------------------------
# Response body preserved
# ---------------------------------------------------------------------------


def test_cline_keeps_response_body() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION)
    assert "authentication module" in out
    assert "token refresh logic" in out
    assert "Task completed successfully" in out
    # Edit summaries kept
    assert "Edited src/auth.py" in out


# ---------------------------------------------------------------------------
# "Cline wants to execute:" preserved
# ---------------------------------------------------------------------------


def test_cline_keeps_wants_to_execute() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION)
    assert "Cline wants to execute" in out


# ---------------------------------------------------------------------------
# Token/cost collapsing
# ---------------------------------------------------------------------------


def test_cline_summarises_token_cost() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_SESSION_MULTI_COST)
    # Only the last-seen values should appear in notes; raw lines dropped
    assert "25,500" in out or "0.0512" in out
    # The first (intermediate) cost line should not appear verbatim in output
    assert out.count("API Cost") <= 1  # at most 1 note line, not both raw lines


# ---------------------------------------------------------------------------
# Non-zero exit: preserve stderr verbatim
# ---------------------------------------------------------------------------


def test_cline_preserves_error_on_nonzero_exit() -> None:
    stderr = "cline: fatal internal error\nCannot connect to extension host\n"
    out = apply_filter(bc.ClineFilter(), stdout="", stderr=stderr, exit_code=1)
    assert "fatal internal error" in out
    assert "extension host" in out


# ---------------------------------------------------------------------------
# Error signals in stdout always kept
# ---------------------------------------------------------------------------


def test_cline_keeps_error_signals_in_stdout() -> None:
    out = apply_filter(bc.ClineFilter(), stdout=_CLINE_ERROR_SESSION)
    assert "Cannot read property" in out
    assert "TypeError" in out


# ---------------------------------------------------------------------------
# Savings ratio
# ---------------------------------------------------------------------------


_CLINE_VERBOSE = """\
Cline v3.2.1
Loading workspace...
MCP Server 'filesystem' connected (3 tools enabled)
MCP Server 'memory' connected (5 tools enabled)
MCP Server 'browser' connected (2 tools enabled)
Thinking...
Processing...
Thinking...
Processing...
Thinking...
Processing...
Streaming response...
Streaming response...
Reading file: src/auth.py...
Reading file: src/session.py...
Reading file: src/models/user.py...
Reading file: tests/test_auth.py...
Reading file: src/middleware/jwt.py...
Reading file: src/utils/crypto.py...
The authentication module has several issues.
Tokens: 45,123 (↑ 32,456 in, ↓ 12,667 out)
API Cost: $0.1234
Context Window: 45,123 / 200,000 tokens (22%)
"""


def test_cline_savings() -> None:
    ratio = savings_ratio(bc.ClineFilter(), stdout=_CLINE_VERBOSE)
    assert ratio >= 0.20, f"Expected ≥20% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# Registry checks
# ---------------------------------------------------------------------------


def test_cline_registered_in_filters() -> None:
    names = {f.name for f in bc.FILTERS}
    assert "cline" in names


def test_cline_in_all_exports() -> None:
    assert "ClineFilter" in bc.__all__


def test_dispatch_routes_cline() -> None:
    result = bc.detect_from_command("cline --task 'refactor auth.py'")
    assert result is not None
    f, _argv = result
    assert f.name == "cline"
