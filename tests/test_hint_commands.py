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

import click
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


def _max_positional_arity() -> dict[str, int | None]:
    """Map each subcommand to its maximum positional-argument count.

    Derived from the live Click command tree so the arity model never drifts
    from the CLI: ``required`` and ``optional`` positionals each count once, and
    a variadic positional (``nargs == -1``) yields ``None`` meaning "unbounded".
    Under-supplying positionals is allowed (hints reference a command bare in
    prose, e.g. "use ``token-goat read``"); *over*-supplying is the bug class
    this guards — the original two-arg ``symbol <name> "<path>"`` shipped because
    nothing checked an embedded command against the command's real arity.
    """
    arity: dict[str, int | None] = {}
    for name, command in typer.main.get_command(app).commands.items():
        count = 0
        for param in command.params:
            if isinstance(param, click.Argument):
                if param.nargs == -1:
                    arity[name] = None  # variadic — no upper bound
                    break
                count += 1
        else:
            arity[name] = count
    return arity


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


# hints.py is static for the duration of a test run and the Typer command tree is
# expensive to build, so read the source and resolve the registered subcommand
# names exactly once at import time rather than re-doing the work in each test.
_HINTS_TEXT = HINTS_PATH.read_text(encoding="utf-8")
_KNOWN_COMMAND_NAMES = _registered_command_names()
_MAX_POSITIONAL_ARITY = _max_positional_arity()


def test_hint_commands_use_registered_subcommands() -> None:
    """Every embedded ``token-goat <subcmd>`` must name a real registered command."""
    commands = _extract_commands(_HINTS_TEXT)
    assert commands, "expected token-goat command examples in hints.py"
    known = _KNOWN_COMMAND_NAMES
    unknown: list[tuple[str, str]] = []
    for cmd in commands:
        tokens = _tokenize(cmd)
        if len(tokens) < 2:
            continue
        subcmd = tokens[1].rstrip('":,.')  # strip dict-key punctuation (_TERSE keys embed token-goat commands)
        if subcmd.startswith("-"):  # a global option like `token-goat --version`
            continue
        if "<" in subcmd or ">" in subcmd:  # meta-placeholder, e.g. `<tool>-output`
            continue
        if subcmd not in known:
            unknown.append((cmd, subcmd))
    assert not unknown, f"hint templates reference unknown token-goat subcommands: {unknown}"


def test_symbol_hint_commands_take_name_and_optional_file_positional() -> None:
    """``token-goat symbol`` templates pass a symbol name plus an optional file.

    ``symbol NAME [FILE]`` accepts at most two positionals: a symbol name (which
    must not itself be a path) and an optional file path that disambiguates a
    name defined in more than one file. Catches the path-as-name form
    (``symbol {safe_path}``) and the three-positional overflow
    (``symbol <name> <file> <extra>``).
    """
    offenders: list[tuple[str, str]] = []
    for cmd in _extract_commands(_HINTS_TEXT):
        tokens = _tokenize(cmd)
        if len(tokens) < 2 or tokens[1] != "symbol":
            continue
        positionals = _positional_args(tokens)
        if len(positionals) > 2:
            offenders.append((cmd, f"{len(positionals)} positional args"))
        elif positionals and _looks_like_path(positionals[0]):
            offenders.append((cmd, "file path passed as symbol name"))
    assert not offenders, (
        "`token-goat symbol` takes a symbol name plus an optional file path; "
        f"broken hint templates: {offenders}"
    )


def test_symbol_command_detectors_catch_known_broken_forms() -> None:
    """Self-check: the detectors flag the P1 broken forms and accept valid ones.

    Proves the regression test would catch a reintroduction of either bug class,
    independent of the current (now-fixed) state of the live templates.
    """
    broken = [
        "token-goat symbol {safe_path}",                       # path placeholder as name
        'token-goat symbol .class-name "{safe_path}" extra',   # three positionals
        'token-goat symbol name "models/user.py" "extra.py"',  # three positionals
    ]
    for cmd in broken:
        tokens = _tokenize(cmd)
        positionals = _positional_args(tokens)
        flagged = len(positionals) > 2 or (
            bool(positionals) and _looks_like_path(positionals[0])
        )
        assert flagged, f"detector failed to catch broken form: {cmd}"

    good = [
        "token-goat symbol index_project",
        "token-goat symbol get_path",  # legit symbol whose name contains 'path'
        'token-goat symbol MyClass "auth/service.py"',  # NAME + optional FILE scope
        'token-goat symbol table_name "models/user.py"',
    ]
    for cmd in good:
        tokens = _tokenize(cmd)
        positionals = _positional_args(tokens)
        ok = len(positionals) <= 2 and not (
            bool(positionals) and _looks_like_path(positionals[0])
        )
        assert ok, f"detector wrongly flagged valid form: {cmd}"


def test_hint_commands_do_not_oversupply_positionals() -> None:
    """No embedded command may pass more positionals than its subcommand accepts.

    Generalizes the ``symbol``-specific arity check to *every* subcommand, with
    the maximum positional count read from the live Typer/Click command tree
    (``_MAX_POSITIONAL_ARITY``) so it never drifts from the real CLI. This is the
    invariant the original two-arg ``symbol <name> "<path>"`` bug violated.

    Under-supplying is intentionally allowed: hints reference commands bare in
    running prose (``use `token-goat read` …``), which would be a usage error
    only if actually executed — but those are documentation, not literal
    runnable invocations, so only over-arity is treated as a defect.
    """
    offenders: list[tuple[str, int, int | None]] = []
    for cmd in _extract_commands(_HINTS_TEXT):
        tokens = _tokenize(cmd)
        if len(tokens) < 2:
            continue
        subcmd = tokens[1]
        # Skip meta-placeholders (``<tool>-output``) and bare global options.
        if subcmd.startswith("-") or "<" in subcmd or ">" in subcmd:
            continue
        max_arity = _MAX_POSITIONAL_ARITY.get(subcmd)
        if max_arity is None:  # unregistered (covered elsewhere) or variadic
            continue
        # An unresolved f-string placeholder may interpolate a whole quoted
        # sub-argument, but for any *registered* fixed-arity command the literal
        # token count after the subcommand is what would reach the parser.
        n = len(_positional_args(tokens))
        if n > max_arity:
            offenders.append((cmd, n, max_arity))
    assert not offenders, (
        "hint templates pass more positional arguments than the subcommand "
        f"accepts (cmd, supplied, max): {offenders}"
    )


def test_arity_model_tracks_known_command_signatures() -> None:
    """Self-check: the live-derived arity map matches the documented signatures.

    Pins the contract so a refactor that silently changes a referenced command's
    positional count surfaces here rather than as a confusing failure in the
    over-arity test. ``read``/``section`` take exactly one positional; ``symbol``
    takes up to two (name plus an optional file scope); ``index`` takes none;
    ``web-output`` accepts an optional one.
    """
    assert _MAX_POSITIONAL_ARITY.get("read") == 1
    assert _MAX_POSITIONAL_ARITY.get("section") == 1
    assert _MAX_POSITIONAL_ARITY.get("symbol") == 2
    assert _MAX_POSITIONAL_ARITY.get("outline") == 1
    assert _MAX_POSITIONAL_ARITY.get("index") == 0
    assert _MAX_POSITIONAL_ARITY.get("web-output") == 1
