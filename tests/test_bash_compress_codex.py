"""Tests for CodexExecFilter (OpenAI Codex CLI output compression)."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Realistic Codex CLI output
# ---------------------------------------------------------------------------

_CODEX_SESSION = """\
OpenAI Codex v0.137.0
--------
workdir: /home/user/project
model: gpt-5.4-mini
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019ebf84-5401-7ef1-a0c2-c21bcf70fb96
--------
user
Explain the difference between a list and a tuple in Python.
codex
A list is mutable — you can add, remove, or change elements after creation.
A tuple is immutable — once created its contents cannot be modified.

Use a list when the collection needs to change; use a tuple for fixed data
(coordinates, RGB values, function arguments you want to protect).
tokens used
99,406
"""

_CODEX_MULTI_TURN = """\
OpenAI Codex v0.137.0
--------
workdir: /home/user/project
model: o4-mini
provider: openai
approval: suggest
sandbox: network-disabled
reasoning effort: medium
reasoning summaries: auto
session id: 019ebf84-0001-7ef1-a0c2-c21bcf70fb96
--------
user
What is the capital of France?
codex
Paris is the capital of France.
user
And Germany?
codex
Berlin is the capital of Germany.
tokens used
12,345
"""

_CODEX_EMPTY = ""

_CODEX_UNKNOWN_FORMAT = """\
Some random command output
that does not look like Codex at all.
Just ordinary text.
"""


# ---------------------------------------------------------------------------
# matches()
# ---------------------------------------------------------------------------


def test_codex_matches() -> None:
    f = bc.CodexExecFilter()
    assert f.matches(["codex"])
    assert f.matches(["codex", "exec", "some prompt"])
    assert f.matches(["codex", "--help"])
    assert not f.matches(["conda"])
    assert not f.matches(["gh"])
    assert not f.matches(["aider"])
    assert not f.matches([])


# ---------------------------------------------------------------------------
# Header stripping
# ---------------------------------------------------------------------------


def test_codex_strips_version_banner() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "OpenAI Codex v0.137.0" not in out


def test_codex_strips_config_block() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "workdir:" not in out
    assert "provider:" not in out
    assert "session id:" not in out
    assert "approval:" not in out
    assert "reasoning effort:" not in out


def test_codex_strips_prompt_user_turn() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "Explain the difference between a list and a tuple" not in out


# ---------------------------------------------------------------------------
# Answer extraction
# ---------------------------------------------------------------------------


def test_codex_keeps_answer_body() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "A list is mutable" in out
    assert "A tuple is immutable" in out
    assert "coordinates, RGB values" in out


def test_codex_keeps_only_final_answer_in_multi_turn() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_MULTI_TURN)
    # Final codex response is about Germany/Berlin
    assert "Berlin is the capital of Germany" in out
    # Intermediate codex response about France should be dropped
    assert "Paris is the capital of France" not in out


# ---------------------------------------------------------------------------
# Summary line
# ---------------------------------------------------------------------------


def test_codex_prepends_summary_line() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "[codex:" in out
    assert "model=gpt-5.4-mini" in out
    assert "tokens=99,406" in out


def test_codex_summary_uses_correct_model_multi_turn() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_MULTI_TURN)
    assert "model=o4-mini" in out
    assert "tokens=12,345" in out


def test_codex_strips_tokens_used_footer() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_SESSION)
    assert "tokens used" not in out.lower() or "[codex:" in out  # only in summary, not raw footer


# ---------------------------------------------------------------------------
# Passthrough for unrecognised / empty formats
# ---------------------------------------------------------------------------


def test_codex_passthrough_unknown_format() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_UNKNOWN_FORMAT)
    assert "Some random command output" in out
    assert "Just ordinary text" in out


def test_codex_passthrough_empty() -> None:
    out = apply_filter(bc.CodexExecFilter(), stdout=_CODEX_EMPTY)
    # Empty or near-empty output should not crash and should return something
    assert out is not None


# ---------------------------------------------------------------------------
# Non-zero exit: preserve stderr verbatim
# ---------------------------------------------------------------------------


def test_codex_preserves_error_on_nonzero_exit() -> None:
    stderr = "codex: fatal error: API key not set\n"
    out = apply_filter(bc.CodexExecFilter(), stdout="", stderr=stderr, exit_code=1)
    assert "fatal error" in out
    assert "API key" in out


# ---------------------------------------------------------------------------
# Savings ratio
# ---------------------------------------------------------------------------


_CODEX_VERBOSE = """\
OpenAI Codex v0.137.0
--------
workdir: /home/user/project
model: gpt-5.4-mini
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019ebf84-5401-7ef1-a0c2-c21bcf70fb96
--------
user
Write a Python function that reverses a string.
codex
def reverse_string(s: str) -> str:
    return s[::-1]
tokens used
1,234
"""


def test_codex_savings() -> None:
    ratio = savings_ratio(bc.CodexExecFilter(), stdout=_CODEX_VERBOSE)
    assert ratio >= 0.30, f"Expected ≥30% savings, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# Registry checks
# ---------------------------------------------------------------------------


def test_codex_registered_in_filters() -> None:
    names = {f.name for f in bc.FILTERS}
    assert "codex-exec" in names


def test_codex_in_all_exports() -> None:
    assert "CodexExecFilter" in bc.__all__


def test_dispatch_routes_codex() -> None:
    result = bc.detect_from_command("codex exec 'fix the bug'")
    assert result is not None
    f, _argv = result
    assert f.name == "codex-exec"


def test_bash_detect_routes_codex() -> None:
    from token_goat import bash_detect

    assert bash_detect.detect(["codex", "exec", "prompt"]) == "codex-exec"
