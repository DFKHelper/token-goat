"""Detect Read/Grep-equivalent patterns inside Codex's Bash tool calls."""
from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path


@dataclass
class BashIntent:
    """A high-level interpretation of a Bash command line."""

    kind: str  # 'read' | 'grep' | 'glob' | 'unknown'
    target_path: str | None = None  # for 'read'
    pattern: str | None = None  # for 'grep' and 'glob'
    offset: int | None = None
    limit: int | None = None


# Read tools we recognize: cat, head, tail, less, bat, more, nl
READ_BINS = frozenset(["cat", "head", "tail", "bat", "less", "more", "nl"])
# Grep tools
GREP_BINS = frozenset(["rg", "grep", "ag", "ack", "ripgrep"])
# Glob/find tools
GLOB_BINS = frozenset(["find", "fd", "fdfind", "ls", "eza"])


def _try_parse_int(value: str) -> int | None:
    """Attempt to parse a string as an integer, return None on failure.

    Consolidates repeated try/except ValueError patterns across argument parsing.
    """
    try:
        return int(value)
    except ValueError:
        return None


def parse(command: str) -> BashIntent:
    """Best-effort parse of a single Bash command line.

    Handles simple commands. For complex pipes (e.g. ``cat foo | grep bar``),
    prefers the leading command. For sudo / env prefixes, strips them.
    """
    # Only look at the first pipeline segment (before any |)
    command = command.split("|")[0].strip()

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return BashIntent(kind="unknown")

    # Strip common prefixes like sudo, time, nice, exec and env VAR=val assignments
    while tokens and (tokens[0] in {"sudo", "time", "nice", "exec"} or "=" in tokens[0]):
        tokens.pop(0)

    if not tokens:
        return BashIntent(kind="unknown")

    binary = Path(tokens[0]).stem
    args = tokens[1:]

    if binary in READ_BINS:
        return _parse_read(binary, args)
    if binary in GREP_BINS:
        return _parse_grep(binary, args)
    if binary in GLOB_BINS:
        return _parse_glob(binary, args)
    return BashIntent(kind="unknown")


def _parse_read(binary: str, args: list[str]) -> BashIntent:
    """Parse cat/head/tail/bat with their common flags."""
    offset: int | None = None
    limit: int | None = None
    paths: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if binary in ("head", "tail"):
            if a in ("-n", "--lines"):
                if i + 1 < len(args):
                    parsed = _try_parse_int(args[i + 1])
                    if parsed is not None:
                        limit = parsed
                    i += 2
                    continue
            elif a.startswith("-n") and len(a) > 2:
                parsed = _try_parse_int(a[2:])
                if parsed is not None:
                    limit = parsed
                i += 1
                continue
            elif a.startswith("--lines="):
                parsed = _try_parse_int(a.split("=", 1)[1])
                if parsed is not None:
                    limit = parsed
                i += 1
                continue
        if a.startswith("-"):
            i += 1
            continue
        paths.append(a)
        i += 1

    if not paths:
        return BashIntent(kind="unknown")
    return BashIntent(kind="read", target_path=paths[0], offset=offset, limit=limit)


def _parse_grep(binary: str, args: list[str]) -> BashIntent:
    """Extract the pattern from rg/grep arguments."""
    i = 0
    pattern: str | None = None
    while i < len(args):
        a = args[i]
        if a in ("-e", "--regexp", "-f", "--file") and i + 1 < len(args):
            pattern = args[i + 1]
            i += 2
            continue
        if a.startswith("--regexp="):
            pattern = a.split("=", 1)[1]
            i += 1
            continue
        if a.startswith("-"):
            i += 1
            continue
        if pattern is None:
            pattern = a
        i += 1

    if pattern is None:
        return BashIntent(kind="unknown")
    return BashIntent(kind="grep", pattern=pattern)


def _parse_glob(binary: str, args: list[str]) -> BashIntent:
    """Best-effort: pick up the first non-flag argument as the pattern."""
    for a in args:
        if not a.startswith("-"):
            return BashIntent(kind="glob", pattern=a)
    return BashIntent(kind="glob")
