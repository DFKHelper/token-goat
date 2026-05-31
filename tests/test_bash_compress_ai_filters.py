"""Tests for AiderFilter, GhCopilotFilter, GeminiCliFilter, and ClaudeCliFilter."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# AiderFilter
# ---------------------------------------------------------------------------

_AIDER_VERBOSE = """\
aider v0.52.1
Aider v0.52.1
Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]:
Tokens: 12345 sent, 1234 received. Cost: $0.0456 message, $0.1234 session.
Repo-map: using 4096 tokens, auto refresh
Loading repo map
Added src/auth.py to the chat.
> Apply these edits to src/auth.py?
Applying edits...
Applying edits...
Applying edits...
Applying edits...
src/auth.py: Updated login() function
Use ctrl-c to interrupt
Tip: Use /ask to ask questions without editing code
Note: Run aider --help for usage
"""

_AIDER_DIFF_OUTPUT = """\
aider v0.52.1
Tokens: 5000 sent, 500 received. Cost: $0.0200 message, $0.0500 session.
Repo-map: using 2048 tokens, auto refresh
Loading repo map
Added src/utils.py to the chat.

src/utils.py
<<<<<<< SEARCH
def old_function():
    pass
=======
def new_function():
    return "improved"
>>>>>>> REPLACE

Applying edits...
Applying edits...
Use ctrl-c to interrupt
"""

_AIDER_ERROR = """\
aider v0.52.1
Tokens: 1000 sent, 100 received.
Error: File not found: missing.py
"""


def test_aider_filter_matches() -> None:
    f = bc.AiderFilter()
    assert f.matches(["aider"])
    assert f.matches(["aider", "--model", "claude-3-5-sonnet"])
    assert not f.matches(["npm", "run", "aider"])
    assert not f.matches([])


def test_aider_drops_noise() -> None:
    out = apply_filter(bc.AiderFilter(), stdout=_AIDER_VERBOSE)
    # token/cost lines should be summarised, not dropped
    assert "0.0456" in out or "cost" in out.lower()
    # noise dropped
    assert "Loading repo map" not in out
    assert "Repo-map:" not in out
    assert "aider v0.52" not in out
    assert "ctrl-c" not in out
    assert "Tip:" not in out
    # edit kept
    assert "src/auth.py" in out


def test_aider_collapses_applying_edits() -> None:
    out = apply_filter(bc.AiderFilter(), stdout=_AIDER_VERBOSE)
    # 4 "Applying edits" lines → single collapsed line
    assert "applying edits" in out.lower() or "token-goat" in out


def test_aider_preserves_diff_headers() -> None:
    out = apply_filter(bc.AiderFilter(), stdout=_AIDER_DIFF_OUTPUT)
    assert "SEARCH" in out or "REPLACE" in out or "src/utils.py" in out


def test_aider_preserves_error_on_failure() -> None:
    out = apply_filter(bc.AiderFilter(), stdout=_AIDER_ERROR, exit_code=1)
    assert "Error" in out or "missing.py" in out


def test_aider_savings() -> None:
    ratio = savings_ratio(bc.AiderFilter(), stdout=_AIDER_VERBOSE)
    assert ratio >= 0.25, f"Expected ≥25% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# GhCopilotFilter
# ---------------------------------------------------------------------------

_GH_COPILOT_EXPLAIN = """\
Welcome to GitHub Copilot in the CLI!
version 1.0.0 (2024-01-15)
Authenticated as octocat

Asking GitHub Copilot...
Generating...

Explanation:

  • git rebase rewrites commit history by moving commits to a new base.
  • Use it to maintain a linear project history.
  • Common usage: git rebase main

Disclaimer: This response was provided by an AI model and may be incorrect.
Always review generated content before applying it.
Note: Use /help to see all available commands.
"""

_GH_COPILOT_SUGGEST = """\
Welcome to GitHub Copilot in the CLI!
Authenticated as octocat

Asking GitHub Copilot...
Thinking...

  grep -r "TODO" --include="*.py" .

Disclaimer: This response was provided by an AI model.
Please review the command before running it.
The commands above are suggestions. Always review.
"""

_GH_COPILOT_NOT_COPILOT = """\
Usage:
  gh [command]

Available Commands:
  auth        Authenticate gh and git with GitHub
  pr          Manage pull requests
  issue       Manage issues
"""


def test_gh_copilot_filter_matches() -> None:
    f = bc.GhCopilotFilter()
    assert f.matches(["gh", "copilot", "explain", "git rebase"])
    assert f.matches(["gh", "copilot", "suggest", "list files"])
    # Must NOT match plain gh commands
    assert not f.matches(["gh", "pr", "list"])
    assert not f.matches(["gh"])
    assert not f.matches([])


def test_gh_copilot_drops_spinner_and_banner() -> None:
    out = apply_filter(
        bc.GhCopilotFilter(),
        stdout=_GH_COPILOT_EXPLAIN,
        argv=["gh", "copilot", "explain", "what is git rebase"],
    )
    assert "Welcome to GitHub Copilot" not in out
    assert "Asking GitHub Copilot" not in out
    assert "Authenticated as" not in out


def test_gh_copilot_drops_disclaimer() -> None:
    out = apply_filter(
        bc.GhCopilotFilter(),
        stdout=_GH_COPILOT_EXPLAIN,
        argv=["gh", "copilot", "explain", "git rebase"],
    )
    assert "Disclaimer" not in out
    assert "Always review" not in out


def test_gh_copilot_keeps_body() -> None:
    out = apply_filter(
        bc.GhCopilotFilter(),
        stdout=_GH_COPILOT_EXPLAIN,
        argv=["gh", "copilot", "explain", "git rebase"],
    )
    assert "git rebase" in out
    assert "linear project history" in out


def test_gh_copilot_suggest_keeps_command() -> None:
    out = apply_filter(
        bc.GhCopilotFilter(),
        stdout=_GH_COPILOT_SUGGEST,
        argv=["gh", "copilot", "suggest", "find TODOs"],
    )
    assert "grep" in out


def test_gh_copilot_savings() -> None:
    ratio = savings_ratio(
        bc.GhCopilotFilter(),
        stdout=_GH_COPILOT_EXPLAIN,
        argv=["gh", "copilot", "explain", "git rebase"],
    )
    assert ratio >= 0.30, f"Expected ≥30% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# GeminiCliFilter
# ---------------------------------------------------------------------------

_GEMINI_CLI_SESSION = """\
Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
✓ Theme: Default
✓ Tools: 8 tools enabled
✓ Sandbox: off
✓ Checkpointing: off
✓ Context limit: 1,048,576

Thinking...

The current directory contains 42 Python files.
The main entry point is src/main.py.

Token usage: 12345 / 1048576 (1%)
Type /help for commands. Press Ctrl-C to exit.
"""

_GEMINI_CLI_WITH_TOOLS = """\
Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
✓ Context limit: 1,048,576

✓ Called read_file(path='src/main.py')
⠋ Calling run_shell_command(command='pytest')
⠙ Calling run_shell_command(command='ls -la')

The test suite passes with 98% coverage.

Token usage: 45678 / 1048576 (4%)
"""

_GEMINI_CLI_ERROR = """\
Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
Error: Rate limit exceeded. Please retry after 60 seconds.
"""


def test_gemini_cli_filter_matches() -> None:
    f = bc.GeminiCliFilter()
    assert f.matches(["gemini"])
    assert f.matches(["gemini", "-p", "explain this code"])
    assert not f.matches(["npm"])
    assert not f.matches([])


def test_gemini_cli_drops_startup_block() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_SESSION)
    assert "Gemini CLI v0.1.5" not in out
    assert "✓ Model:" not in out
    assert "✓ Theme:" not in out
    assert "Thinking..." not in out
    assert "Type /help" not in out


def test_gemini_cli_collapses_startup_to_summary() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_SESSION)
    assert "startup" in out.lower() or "token-goat" in out


def test_gemini_cli_keeps_context_meter() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_SESSION)
    # Last token-usage meter should be surfaced
    assert "12345" in out or "context" in out.lower()


def test_gemini_cli_collapses_tool_spinners() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_WITH_TOOLS)
    # Spinner lines collapsed
    assert "⠋ Calling" not in out
    assert "⠙ Calling" not in out
    # But the count or summary should appear
    assert "token-goat" in out or "spinner" in out.lower() or "tool" in out.lower()


def test_gemini_cli_keeps_response_body() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_SESSION)
    assert "42 Python files" in out
    assert "src/main.py" in out


def test_gemini_cli_preserves_error() -> None:
    out = apply_filter(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_ERROR, exit_code=1)
    assert "Rate limit" in out or "Error" in out


def test_gemini_cli_savings() -> None:
    ratio = savings_ratio(bc.GeminiCliFilter(), stdout=_GEMINI_CLI_SESSION)
    assert ratio >= 0.15, f"Expected ≥15% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# ClaudeCliFilter
# ---------------------------------------------------------------------------

_CLAUDE_CLI_SESSION = """\
◆ claude-sonnet-4-5 (API)

Context: 45678 / 200000 (23%)
◎ Thinking...

The function `process_data` in src/pipeline.py handles the ETL pipeline.
It reads from S3, transforms using Pandas, and writes to PostgreSQL.

↑ 5432 ↓ 890 tokens · $0.0123
Press Ctrl-C to stop
Enter / to show menu
"""

_CLAUDE_CLI_WITH_TOOLS = """\
◆ claude-sonnet-4-5 (API)

> Using tool: Read(file_path='src/pipeline.py')
✓ Tool result: [2847 chars]
> Using tool: Bash(command='pytest tests/test_pipeline.py -v')
✓ Tool result: [1234 chars]
◎ Tool: Write

All tests pass. The pipeline processes 10k records/second.

↑ 12000 ↓ 2500 tokens · $0.0456
Context: 89000 / 200000 (45%)
"""

_CLAUDE_CLI_SKIP_SUBCMDS = [
    ["claude", "install"],
    ["claude", "update"],
    ["claude", "doctor"],
    ["claude", "config"],
    ["claude", "login"],
    ["claude", "logout"],
]


def test_claude_cli_filter_matches() -> None:
    f = bc.ClaudeCliFilter()
    assert f.matches(["claude"])
    assert f.matches(["claude", "--print", "explain this"])
    assert f.matches(["claude", "-p", "explain this"])
    assert not f.matches(["claude-code"])
    assert not f.matches(["npm"])
    assert not f.matches([])


def test_claude_cli_filter_skips_subcommands() -> None:
    f = bc.ClaudeCliFilter()
    for argv in _CLAUDE_CLI_SKIP_SUBCMDS:
        assert not f.matches(argv), f"Should not match {argv}"


def test_claude_cli_drops_session_header() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    assert "◆ claude-sonnet" not in out


def test_claude_cli_drops_spinner() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    assert "◎ Thinking" not in out


def test_claude_cli_drops_footer() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    assert "Press Ctrl-C" not in out
    assert "Enter / to show menu" not in out


def test_claude_cli_keeps_response_body() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    assert "process_data" in out
    assert "ETL pipeline" in out


def test_claude_cli_keeps_stats_and_context() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    # Last stats/context should appear as notes
    assert "5432" in out or "stats" in out.lower() or "token" in out.lower()


def test_claude_cli_collapses_tool_log() -> None:
    out = apply_filter(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_WITH_TOOLS)
    assert "> Using tool:" not in out
    assert "✓ Tool result:" not in out
    # Should have collapsed summary
    assert "tool" in out.lower()


def test_claude_cli_savings() -> None:
    ratio = savings_ratio(bc.ClaudeCliFilter(), stdout=_CLAUDE_CLI_SESSION)
    assert ratio >= 0.08, f"Expected ≥8% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# FILTERS list registration
# ---------------------------------------------------------------------------


def test_ai_filters_registered() -> None:
    """All AI tool filters appear in the FILTERS dispatch list."""
    names = {f.name for f in bc.FILTERS}
    assert "aider" in names
    assert "gh-copilot" in names
    assert "gemini-cli" in names
    assert "claude-cli" in names


def test_ai_filters_in_all_exports() -> None:
    """AI filter classes exported via __all__."""
    assert "AiderFilter" in bc.__all__
    assert "GhCopilotFilter" in bc.__all__
    assert "GeminiCliFilter" in bc.__all__
    assert "ClaudeCliFilter" in bc.__all__


def test_dispatch_routes_aider() -> None:
    result = bc.detect_from_command("aider --model gpt-4o")
    assert result is not None
    filter_, argv = result
    assert filter_.name == "aider"


def test_dispatch_routes_gemini_cli() -> None:
    result = bc.detect_from_command("gemini -p 'explain this code'")
    assert result is not None
    filter_, argv = result
    assert filter_.name == "gemini-cli"


def test_dispatch_routes_claude_cli() -> None:
    result = bc.detect_from_command("claude --print 'what does this do'")
    assert result is not None
    filter_, argv = result
    assert filter_.name == "claude-cli"


def test_dispatch_routes_gh_copilot_explain() -> None:
    result = bc.detect_from_command("gh copilot explain 'git rebase'")
    assert result is not None
    filter_, argv = result
    assert filter_.name == "gh-copilot"


def test_dispatch_does_not_route_gh_pr() -> None:
    # gh pr list should NOT route to GhCopilotFilter
    result = bc.detect_from_command("gh pr list")
    if result is not None:
        assert result[0].name != "gh-copilot"
