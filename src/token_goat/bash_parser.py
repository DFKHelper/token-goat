"""Detect Read/Grep-equivalent patterns inside Codex's Bash tool calls.

Codex (and other agent harnesses) issue file reads as raw Bash commands rather
than through a structured Read tool.  This module parses those command strings
and returns a ``BashIntent`` that callers can treat the same way as a Read,
Grep, or Glob tool invocation — enabling image-shrink and session-hint logic to
apply consistently regardless of which harness fired the tool.

Supported patterns
------------------
* **Read** — ``cat``, ``head``, ``tail``, ``bat``, ``batcat``, ``less``,
  ``more``, ``nl``, ``zcat``, ``zless``, ``zmore``.  Scripted readers (``sed``,
  ``awk``, ``perl``) are also recognized but treated as unknown when invoked
  with in-place edit flags.
* **Grep** — ``rg``, ``grep``, ``ag``, ``ack``, ``ripgrep``.
* **Glob/find** — ``find``, ``fd``, ``fdfind``, ``ls``, ``eza``.

All parsing is best-effort.  Unrecognized or malformed commands are returned as
``BashIntent(kind="unknown")`` without raising an exception.
"""
from __future__ import annotations

import logging
import shlex
from dataclasses import dataclass
from pathlib import Path

_LOG = logging.getLogger("token_goat.bash_parser")


@dataclass
class BashIntent:
    """A high-level interpretation of a Bash command line.

    Attributes:
        kind: One of ``'read'`` (file read), ``'grep'`` (pattern search),
            ``'glob'`` (directory listing / find), or ``'unknown'`` (unrecognised
            or ambiguous command that should be passed through unchanged).
        target_path: Resolved file path for ``kind='read'`` commands.  ``None``
            for grep/glob/unknown.
        pattern: Search pattern for ``kind='grep'`` or root/name pattern for
            ``kind='glob'``.  ``None`` for read/unknown.
        offset: Line offset for ``kind='read'`` (from ``tail -n +N`` style args).
            Currently always ``None`` — reserved for future tail-offset parsing.
        limit: Line count for ``kind='read'`` (from ``head -n N`` / ``tail -n N``).
            ``None`` means the whole file.
        reason: Human-readable explanation for ``kind='unknown'``, used for debug
            logging when the hook skips processing.
    """

    kind: str
    target_path: str | None = None
    pattern: str | None = None
    offset: int | None = None
    limit: int | None = None
    reason: str | None = None


# Commands whose primary effect is reading a file into stdout without modifying it.
# ``sed``, ``awk``, and ``perl`` are included because agents often use them as
# read-only viewers (e.g. ``sed -n '10,20p' file``); they are separated into
# SCRIPTED_READ_BINS so in-place edit flags (``-i``) can be detected and the
# command reclassified as ``unknown`` rather than wrongly treated as a read.
READ_BINS = frozenset(
    ["cat", "head", "tail", "bat", "batcat", "less", "more", "nl", "zcat", "zless", "zmore", "sed", "awk", "perl"]
)

# Subset of READ_BINS where the target file comes *last* (after the script expression)
# and where an in-place edit flag changes the operation from read to write.
SCRIPTED_READ_BINS = frozenset(["sed", "awk", "perl"])

# Pattern-search tools.  All of these put the search pattern as the first
# non-flag positional argument, making extraction straightforward.
GREP_BINS = frozenset(["rg", "grep", "ag", "ack", "ripgrep"])

# Directory enumeration and file-discovery tools.  Treated as ``glob`` because
# their output is a list of paths, analogous to the Glob tool.
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

    Only the first pipeline segment (before any ``|``) is analysed.  This is
    intentional: for ``cat foo | grep bar`` the relevant operation for token-goat
    is the *read* of ``foo``, not the grep that filters it — the pre-read hook
    should fire on the read, and the grep hook on any standalone ``grep`` command.
    Analysing the whole pipeline would produce a misleading ``kind='grep'`` for
    what is fundamentally a file read.

    Prefix tokens that change resource use but not semantics (``sudo``, ``time``,
    ``nice``, ``exec``, shell variable assignments) are stripped before dispatch.
    """
    # Only look at the first pipeline segment (before any |)
    command = command.split("|")[0].strip()

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as e:
        _LOG.debug("bash_parser: shlex.split failed: %s", e)
        return BashIntent(kind="unknown", reason="invalid shell quoting")

    # Strip common prefixes like sudo, time, nice, exec and env VAR=val assignments
    while tokens and (tokens[0] in {"sudo", "time", "nice", "exec"} or "=" in tokens[0]):
        tokens.pop(0)

    if not tokens:
        return BashIntent(kind="unknown", reason="empty command after stripping prefixes")

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
    """Parse cat/head/tail/bat and scripted readers (sed/awk/perl) for the target path.

    For ``head``/``tail``, recognises ``-n N``, ``-nN``, and ``--lines=N`` to
    populate *limit*.  For scripted readers (``sed``, ``awk``, ``perl``) the
    target file is the *last* positional argument rather than the first, because
    the script expression comes before the filename (e.g. ``sed 's/a/b/' file``).
    Scripted readers invoked with an in-place flag (``-i``, ``--in-place``) are
    classified as ``unknown`` because they mutate the file rather than reading it.
    """
    if binary in SCRIPTED_READ_BINS and any(a == "--in-place" or a.startswith("-i") for a in args):
        return BashIntent(kind="unknown", reason=f"{binary} edits files in place")

    offset: int | None = None
    limit: int | None = None
    paths: list[str] = []
    # Cache repeated membership tests as locals — avoids re-evaluating the
    # frozenset lookup on every iteration of the arg loop.
    accepts_line_count_flag = binary in ("head", "tail")  # only head/tail use -n/--lines
    is_scripted = binary in SCRIPTED_READ_BINS
    i = 0
    while i < len(args):
        a = args[i]
        if accepts_line_count_flag:
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
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a file path")
    target_path = paths[-1] if is_scripted else paths[0]
    if is_scripted and len(paths) < 2:
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a target file")
    return BashIntent(kind="read", target_path=target_path, offset=offset, limit=limit)


def _parse_grep(binary: str, args: list[str]) -> BashIntent:
    """Extract the search pattern from rg/grep/ag argument lists.

    Recognises ``-e``/``--regexp``/``--regexp=`` to capture an explicit pattern
    argument.  Falls through to treating the first non-flag positional argument
    as the pattern, which is the normal form for ``rg <pattern> [path]`` and
    ``grep <pattern> [file...]``.  Returns ``BashIntent(kind="unknown")`` when
    no pattern can be identified (e.g. ``grep -h`` alone).
    """
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
    """Extract the root path/pattern from find/fd/ls/eza argument lists.

    Uses the first non-flag positional argument as the glob root or name
    pattern.  For ``find . -name "*.py"`` this yields ``.``; for
    ``fd -e py src/`` this yields ``src/``.  Returns
    ``BashIntent(kind="glob")`` with ``pattern=None`` when no positional
    argument is found (e.g. a bare ``ls`` with only flags).
    """
    for a in args:
        if not a.startswith("-"):
            return BashIntent(kind="glob", pattern=a)
    return BashIntent(kind="glob")
