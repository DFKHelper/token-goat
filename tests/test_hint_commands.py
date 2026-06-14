"""Validate the ``token-goat`` CLI commands embedded in hint templates.

Hints frequently end with a backtick-wrapped command the agent is meant to run
verbatim, e.g. ``token-goat read "src/foo.py::bar"``. Nothing previously checked
that those embedded commands actually parse against the Typer CLI, so seven
broken ``token-goat symbol`` templates shipped (P1 finding, session 6b476e93):

  * ``token-goat symbol {safe_path}`` — a *file path* passed as the symbol NAME;
    ``symbol`` resolves a symbol by name, so this always returns "No matches".
  * ``token-goat symbol <name> "{safe_path}"`` — a two-positional invocation;
    ``symbol`` accepts exactly one positional argument, so this is a hard usage
    error.

These tests close that gap: every backtick-wrapped ``token-goat <subcmd> …``
template in ``hints.py`` must name a registered subcommand, and any ``symbol``
invocation must carry exactly one positional that is not a file path.
"""
from __future__ import annotations

import re
from pathlib import Path

import typer

from token_goat.cli import app

HINTS_PATH = Path(__file__).resolve().parent.parent / "src" / "token_goat" / "hints.py"

# Backtick-delimited spans that invoke the token-goat CLI, constrained to a
# single line so an unbalanced backtick in prose can't capture a runaway blob.
_CMD_RE = re.compile(r"`(token-goat [^`\n]+)`")

# Tokenize a command into a double-quoted group or a bare run of non-space.
_TOKEN_RE = re.compile(r'"[^"]*"|\S+')

# File extensions that mark a positional as a path rather than a symbol name.
_PATH_EXTS = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass",
    ".sql", ".graphql", ".proto", ".md", ".yaml", ".yml", ".toml", ".xml",
)


def _registered_command_names() -> set[str]:
    """Actual subcommand names registered on the Typer app (incl. custom names)."""
    return set(typer.main.get_command(app).commands.keys())


def _extract_commands(text: str) -> list[str]:
    """Return every backtick-wrapped ``token-goat …`` command string in *text*."""
    return _CMD_RE.findall(text)


def _tokenize(cmd: str) -> list[str]:
    """Split a command into tokens, honoring double-quoted groups.

    The f-string source escapes inner quotes as ``\\"``; drop the backslashes
    first so a quoted ``"<file>::<symbol>"`` target tokenizes as one argument.
    """
    return _TOKEN_RE.findall(cmd.replace("\\", ""))


# Flags that consume the next token as their value (not boolean flags).
# Used by _positional_args to avoid treating a flag's value as a positional.
_VALUE_FLAGS: frozenset[str] = frozenset({
    "--grep", "--section", "--head", "--tail",
    "--max-distance", "--context", "--min-lines",
    "--area", "--iterations", "--session-id",
})


def _positional_args(tokens: list[str]) -> list[str]:
    """Args after ``token-goat <subcmd>`` that are not option flags or their values.

    Boolean flags (``--compact``, ``--strict``, etc.) are skipped in place.
    Value-consuming flags (``--grep``, ``--section``, etc.) cause both the flag
    and the immediately following token to be skipped, so the value is never
    counted as a positional argument.
    """
    positionals: list[str] = []
    args = tokens[2:]
    i = 0
    while i < len(args):
        t = args[i]
        if t.startswith("-"):
            # Value-consuming flag: skip the flag AND its value token.
            if t in _VALUE_FLAGS and i + 1 < len(args) and not args[i + 1].startswith("-"):
                i += 2
            else:
                i += 1
        else:
            positionals.append(t)
            i += 1
    return positionals


def _looks_like_path(arg: str) -> bool:
    """Heuristic: does *arg* look like a file path rather than a symbol name?"""
    stripped = arg.strip('"')
    if "/" in stripped or "\\" in stripped:
        return True
    # Unresolved f-string placeholder that interpolates a path, e.g. {safe_path}.
    if re.search(r"\{[^}]*(path|file|fname)[^}]*\}", stripped, re.IGNORECASE):
        return True
    return stripped.endswith(_PATH_EXTS)


def test_hint_commands_use_registered_subcommands() -> None:
    """Every embedded ``token-goat <subcmd>`` must name a real registered command."""
    text = HINTS_PATH.read_text(encoding="utf-8")
    commands = _extract_commands(text)
    assert commands, "expected token-goat command examples in hints.py"
    known = _registered_command_names()
    unknown: list[tuple[str, str]] = []
    for cmd in commands:
        tokens = _tokenize(cmd)
        if len(tokens) < 2:
            continue
        subcmd = tokens[1]
        if subcmd.startswith("-"):  # a global option like `token-goat --version`
            continue
        if "<" in subcmd or ">" in subcmd:  # meta-placeholder, e.g. `<tool>-output`
            continue
        if subcmd not in known:
            unknown.append((cmd, subcmd))
    assert not unknown, f"hint templates reference unknown token-goat subcommands: {unknown}"


def test_symbol_hint_commands_take_single_non_path_positional() -> None:
    """``token-goat symbol`` templates must pass exactly one non-path positional.

    Catches both the path-as-name form (``symbol {safe_path}``) and the
    two-positional usage error (``symbol <name> "{safe_path}"``).
    """
    text = HINTS_PATH.read_text(encoding="utf-8")
    offenders: list[tuple[str, str]] = []
    for cmd in _extract_commands(text):
        tokens = _tokenize(cmd)
        if len(tokens) < 2 or tokens[1] != "symbol":
            continue
        positionals = _positional_args(tokens)
        if len(positionals) > 1:
            offenders.append((cmd, f"{len(positionals)} positional args"))
        elif positionals and _looks_like_path(positionals[0]):
            offenders.append((cmd, "file path passed as symbol name"))
    assert not offenders, (
        "`token-goat symbol` takes exactly one positional symbol name; "
        f"broken hint templates: {offenders}"
    )


def test_symbol_command_detectors_catch_known_broken_forms() -> None:
    """Self-check: the detectors flag the P1 broken forms and accept valid ones.

    Proves the regression test would catch a reintroduction of either bug class,
    independent of the current (now-fixed) state of the live templates.
    """
    broken = [
        "token-goat symbol {safe_path}",                # path placeholder as name
        'token-goat symbol .class-name "{safe_path}"',  # two positionals
        'token-goat symbol table_name "{safe_path}"',
    ]
    for cmd in broken:
        tokens = _tokenize(cmd)
        positionals = _positional_args(tokens)
        flagged = len(positionals) > 1 or (
            bool(positionals) and _looks_like_path(positionals[0])
        )
        assert flagged, f"detector failed to catch broken form: {cmd}"

    good = [
        "token-goat symbol index_project",
        "token-goat symbol get_path",  # legit symbol whose name contains 'path'
    ]
    for cmd in good:
        tokens = _tokenize(cmd)
        positionals = _positional_args(tokens)
        ok = len(positionals) <= 1 and not (
            bool(positionals) and _looks_like_path(positionals[0])
        )
        assert ok, f"detector wrongly flagged valid form: {cmd}"
