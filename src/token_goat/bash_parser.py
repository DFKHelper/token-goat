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
from typing import Literal

_LOG = logging.getLogger("token_goat.bash_parser")

# Hard cap on the raw command string before shlex.split to prevent a crafted
# multi-megabyte payload from causing linear memory allocation in the tokenizer.
# 64 KiB is far larger than any legitimate single-line shell command that an
# agent would issue; anything beyond this is anomalous and rejected early.
_MAX_COMMAND_BYTES: int = 65_536  # 64 KiB

# Hard cap on the extracted target_path.  Real file-system paths are bounded
# by PATH_MAX (~4096 bytes on Linux, 32767 on Windows); 8 KiB leaves headroom
# while still preventing an unbounded heap allocation in the synthesized Read
# payload that bash_parser feeds into hooks_read.
_MAX_PATH_BYTES: int = 8_192  # 8 KiB

#: All valid values for :attr:`BashIntent.kind`.
BashIntentKind = Literal["read", "grep", "glob", "unknown"]


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

    kind: BashIntentKind
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

    Rejects commands exceeding ``_MAX_COMMAND_BYTES`` (64 KiB) early, before
    any memory-allocating parse step, to defend against crafted payloads that
    would cause linear memory use in ``shlex.split``.
    """
    # Reject oversized commands before any memory-allocating work.
    # encode() length is an upper bound on byte count; len() would undercount
    # for non-ASCII content but is cheaper and sufficient here — a 64 KiB
    # char-count cap is still far beyond any legitimate shell command.
    if len(command) > _MAX_COMMAND_BYTES:
        _LOG.warning(
            "bash_parser: command too long (%d chars > %d limit); rejecting",
            len(command),
            _MAX_COMMAND_BYTES,
        )
        return BashIntent(kind="unknown", reason="command too long")

    # Only look at the first pipeline segment (before any |)
    command = command.split("|")[0].strip()

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as e:
        # str(e) may echo back characters from the command; sanitise before logging.
        safe_err = str(e).replace("\n", "\\n").replace("\r", "\\r")[:200]
        _LOG.debug("bash_parser: shlex.split failed: %s", safe_err)
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


def _parse_line_count_flag(args: list[str], i: int) -> tuple[int | None, int]:
    """Parse a line-count flag at position *i* and return ``(value, tokens_consumed)``.

    Recognises three forms used by ``head`` and ``tail``:
    - ``-n N`` / ``--lines N`` — two-token form; returns ``(N, 2)`` when the next
      token exists and parses as an integer, else ``(None, 2)`` (still skips the
      next token to avoid treating it as a positional argument).
    - ``-nN`` (compact form, e.g. ``-n10``) — single-token; returns ``(N, 1)``.
    - ``--lines=N`` — single-token with ``=``; returns ``(N, 1)``.

    Returns ``(None, 0)`` when the token at *i* is not a line-count flag, so the
    caller can fall through to the generic flag / positional-argument handling.
    """
    a = args[i]
    if a in ("-n", "--lines"):
        value = _try_parse_int(args[i + 1]) if i + 1 < len(args) else None
        return value, 2
    if a.startswith("-n") and len(a) > 2:
        return _try_parse_int(a[2:]), 1
    if a.startswith("--lines="):
        return _try_parse_int(a.split("=", 1)[1]), 1
    return None, 0


def _parse_read(binary: str, args: list[str]) -> BashIntent:
    """Parse cat/head/tail/bat and scripted readers (sed/awk/perl) for the target path.

    For ``head``/``tail``, recognises ``-n N``, ``-nN``, and ``--lines=N`` to
    populate *limit*.  For scripted readers (``sed``, ``awk``, ``perl``) the
    target file is the *last* positional argument rather than the first, because
    the script expression comes before the filename (e.g. ``sed 's/a/b/' file``).
    Scripted readers invoked with an in-place flag (``-i``, ``--in-place``) are
    classified as ``unknown`` because they mutate the file rather than reading it.
    """
    is_scripted = binary in SCRIPTED_READ_BINS
    if is_scripted and any(a == "--in-place" or a.startswith("-i") for a in args):
        return BashIntent(kind="unknown", reason=f"{binary} edits files in place")

    # Only head and tail support -n/--lines; pre-compute to avoid a frozenset
    # lookup on every iteration of the arg loop.
    is_line_count_binary = binary in ("head", "tail")
    limit: int | None = None
    positional_args: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if is_line_count_binary:
            value, consumed = _parse_line_count_flag(args, i)
            if consumed:
                if value is not None:
                    limit = value
                i += consumed
                continue
        if a.startswith("-"):
            i += 1
            continue
        positional_args.append(a)
        i += 1

    if not positional_args:
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a file path")
    # Scripted readers (sed/awk/perl) put the script expression first and the
    # target file last, so they need at least two positional args.
    if is_scripted and len(positional_args) < 2:
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a target file")
    target_path = positional_args[-1] if is_scripted else positional_args[0]
    # Reject paths that exceed the filesystem-safe ceiling.  Real paths are
    # bounded by PATH_MAX; anything beyond _MAX_PATH_BYTES is anomalous and
    # must not be forwarded to the synthesised Read payload.
    if len(target_path) > _MAX_PATH_BYTES:
        _LOG.warning(
            "bash_parser: target_path too long (%d chars > %d limit); rejecting",
            len(target_path),
            _MAX_PATH_BYTES,
        )
        return BashIntent(kind="unknown", reason="target path too long")
    return BashIntent(kind="read", target_path=target_path, offset=None, limit=limit)


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
