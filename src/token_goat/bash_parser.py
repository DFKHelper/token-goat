"""Detect Read/Grep-equivalent patterns inside Codex's Bash tool calls.

Codex (and other agent harnesses) issue file reads as raw Bash commands rather
than through a structured Read tool.  This module parses those command strings
and returns a ``BashIntent`` that callers can treat the same way as a Read,
Grep, or Glob tool invocation — enabling image-shrink and session-hint logic to
apply consistently regardless of which harness fired the tool.

Supported patterns
------------------
* **Read** — ``cat``, ``head``, ``tail``, ``bat``, ``batcat``, ``less``,
  ``more``, ``nl``, ``zcat``, ``zless``, ``zmore``, ``xxd``, ``od``, ``wc``,
  ``type`` (cmd.exe), ``Get-Content`` / ``gc`` (PowerShell).  Scripted readers
  (``sed``, ``awk``, ``perl``) are also recognized but treated as unknown when
  invoked with in-place edit flags.  Stdin redirection (``cmd < FILE``) is
  recognised as a read of ``FILE`` regardless of the leading command.
* **Grep** — ``rg``, ``grep``, ``ag``, ``ack``, ``ripgrep``.
* **Glob/find** — ``find``, ``fd``, ``fdfind``, ``ls``, ``eza``.

Line-range extraction
---------------------
Where the source command encodes a slice of the file, ``offset`` and ``limit``
are populated so session-tracking and hint generation can record exactly which
lines were consumed:

* ``head -n N FILE`` → ``offset=1, limit=N``
* ``sed -n 'M,Np' FILE`` → ``offset=M, limit=N-M+1``
* ``sed -n 'Np' FILE`` (single line) → ``offset=N, limit=1``
* ``awk 'NR==N' FILE`` → ``offset=N, limit=1``
* ``awk 'NR>=M && NR<=N' FILE`` → ``offset=M, limit=N-M+1``

False-positive guards
---------------------
* Heredocs (``cat << EOF ... EOF``) are *not* file reads — no path follows the
  command — and are classified as ``unknown``.
* In-place editors (``sed -i``, ``perl -i``) mutate files and are rejected.

All parsing is best-effort.  Unrecognized or malformed commands are returned as
``BashIntent(kind="unknown")`` without raising an exception.
"""
from __future__ import annotations

import logging
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

__all__ = ["BashIntent", "parse"]

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
#
# ``xxd`` / ``od`` are binary-content dumps but still consume the file's full
# byte content into the agent's context window, so they count as reads.
# ``wc`` is a line/byte counter that reads the whole file.  ``type`` is the
# cmd.exe analogue of ``cat``.  ``Get-Content`` / ``gc`` are the PowerShell
# equivalents; PowerShell is case-insensitive so we lowercase the stem before
# comparison and normalise the aliases.
READ_BINS = frozenset(
    [
        "cat",
        "head",
        "tail",
        "bat",
        "batcat",
        "less",
        "more",
        "nl",
        "zcat",
        "zless",
        "zmore",
        "sed",
        "awk",
        "perl",
        "xxd",
        "od",
        "wc",
        "type",
        "get-content",
        "gc",
    ]
)

# Subset of READ_BINS where the target file comes *last* (after the script expression)
# and where an in-place edit flag changes the operation from read to write.
SCRIPTED_READ_BINS = frozenset(["sed", "awk", "perl"])

# PowerShell binaries that take ``-Path``/``-LiteralPath`` flags before the file.
# These two consume one positional-style argument each.
_PS_PATH_FLAGS = frozenset(["-path", "-literalpath"])

# PowerShell ``Get-Content`` line-range flags.  ``-TotalCount N`` (alias
# ``-First``/``-Head``) bounds reads from the start; ``-Tail N`` bounds reads
# from the end.  Mapped to ``head -n N`` / ``tail -n N`` semantics.
_PS_HEAD_FLAGS = frozenset(["-totalcount", "-first", "-head"])
_PS_TAIL_FLAGS = frozenset(["-tail", "-last"])

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


# Matches ``sed -n`` slice expressions that copy a line range to stdout:
# ``Np`` (single line), ``M,Np`` (range), and the verbose ``M,N p`` with an
# optional space.  Anchored so that ``1,$p`` (read-to-end) and other forms fall
# through to "whole file" semantics.
_SED_RANGE_RE = re.compile(r"^\s*(\d+)(?:\s*,\s*(\d+))?\s*p\s*$")

# Matches the two awk patterns agents most commonly use to slice a file:
# ``NR==N`` (single line) and ``NR>=M && NR<=N`` (inclusive range).  Anything
# more elaborate falls through to whole-file semantics, which is a safe upper
# bound for session tracking.
_AWK_EQ_RE = re.compile(r"^\s*NR\s*==\s*(\d+)\s*$")
_AWK_RANGE_RE = re.compile(
    r"^\s*NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*(\d+)\s*$"
)


def _parse_sed_script(script: str) -> tuple[int | None, int | None]:
    """Extract ``(offset, limit)`` from a ``sed -n`` script expression.

    Returns ``(offset, limit)`` where ``offset`` is the 1-based starting line
    and ``limit`` is the number of lines consumed.  Returns ``(None, None)``
    when the script does not match a recognised range form, in which case the
    caller should treat the read as covering the entire file.
    """
    m = _SED_RANGE_RE.match(script)
    if not m:
        return None, None
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else start
    if end < start:
        return None, None
    return start, end - start + 1


def _parse_awk_script(script: str) -> tuple[int | None, int | None]:
    """Extract ``(offset, limit)`` from an ``awk`` slice expression.

    Recognises ``NR==N`` (single line) and ``NR>=M && NR<=N`` (range).  Returns
    ``(None, None)`` for any other pattern so the caller falls back to
    whole-file semantics.
    """
    m = _AWK_EQ_RE.match(script)
    if m:
        line = int(m.group(1))
        return line, 1
    m = _AWK_RANGE_RE.match(script)
    if m:
        start = int(m.group(1))
        end = int(m.group(2))
        if end < start:
            return None, None
        return start, end - start + 1
    return None, None


def _extract_stdin_redirect(tokens: list[str]) -> tuple[list[str], str | None]:
    """Strip stdin-redirect tokens (``< FILE``) and return ``(tokens, file)``.

    Recognises both ``cmd < FILE`` (token sequence ``["<", "FILE"]``) and the
    rarer ``< FILE cmd``.  The redirect file is removed from the token list so
    it does not pollute positional-argument extraction.

    Heredocs (``<< EOF``) and here-strings (``<<<``) are *not* file reads and
    are left in place; callers that detect them should classify the command as
    ``unknown``.
    """
    redirect_file: str | None = None
    cleaned: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        # Skip heredoc / here-string operators entirely; leave them in place
        # so the heredoc guard in _parse_read can spot ``<<`` and bail.
        if tok in ("<<", "<<<") or tok.startswith("<<"):
            cleaned.append(tok)
            i += 1
            continue
        if tok == "<" and i + 1 < len(tokens):
            redirect_file = tokens[i + 1]
            i += 2
            continue
        # Attached form: ``<file.txt`` (rare but valid shell).
        if tok.startswith("<") and not tok.startswith("<<"):
            candidate = tok[1:]
            if candidate:
                redirect_file = candidate
                i += 1
                continue
        cleaned.append(tok)
        i += 1
    return cleaned, redirect_file


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

    # Heredocs and here-strings ("cat << EOF ... EOF", "cmd <<< 'foo'") look
    # like reads but consume the literal body, not a file on disk.  Reject
    # before extracting paths so we never feed a delimiter word like "EOF" or
    # the literal string after ``<<<`` to image-shrink or session-hint logic.
    if any(t == "<<" or t == "<<<" or t.startswith("<<") for t in tokens):
        return BashIntent(kind="unknown", reason="heredoc / here-string is not a file read")

    # Pull stdin-redirect file out of the token stream: ``cmd < FILE`` and
    # ``< FILE cmd`` both count as a read of FILE.  Leading-redirect form
    # leaves an empty token list once consumed, which means we still want to
    # classify it as a read even when no binary follows.
    tokens, redirect_file = _extract_stdin_redirect(tokens)

    if not tokens:
        # Pure ``< FILE`` with no command — uncommon but unambiguous: the file
        # is opened for reading.  Treat as a generic read with no slice info.
        if redirect_file:
            return _build_read_intent(redirect_file)
        return BashIntent(kind="unknown", reason="empty command after stripping redirects")

    # Lowercased stem handles Windows shell tools (``Get-Content``, ``GC``,
    # ``TYPE``) that PowerShell and cmd.exe accept case-insensitively, and
    # full-path invocations (``/usr/bin/cat``, ``C:\\bin\\type.exe``).
    raw_stem = Path(tokens[0]).stem
    binary = raw_stem.lower()
    args = tokens[1:]

    if binary in READ_BINS:
        intent = _parse_read(binary, args)
        # When the read failed (e.g. missing path) but stdin was redirected to
        # a file, fall back to the redirected file as the target.  This
        # captures ``wc -l < file.txt`` where the command itself has no
        # positional path.
        if intent.kind != "read" and redirect_file:
            return _build_read_intent(redirect_file)
        return intent
    if binary in GREP_BINS:
        return _parse_grep(binary, args)
    if binary in GLOB_BINS:
        return _parse_glob(binary, args)
    # Unknown binary but stdin redirected from a file — still a read.
    if redirect_file:
        return _build_read_intent(redirect_file)
    return BashIntent(kind="unknown")


def _build_read_intent(target_path: str) -> BashIntent:
    """Construct a ``kind='read'`` intent after enforcing the path length cap.

    Centralises the ``_MAX_PATH_BYTES`` guard so every code path that produces
    a read intent applies the same defence against pathological inputs.
    """
    if len(target_path) > _MAX_PATH_BYTES:
        _LOG.warning(
            "bash_parser: target_path too long (%d chars > %d limit); rejecting",
            len(target_path),
            _MAX_PATH_BYTES,
        )
        return BashIntent(kind="unknown", reason="target path too long")
    return BashIntent(kind="read", target_path=target_path)


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

    For ``head``, recognises ``-n N``, ``-nN``, and ``--lines=N`` and populates
    ``offset=1, limit=N``.  For ``tail`` the limit is recorded without an
    offset because the line number depends on the file's total length, which
    is unknown at parse time.  For scripted readers (``sed``, ``awk``,
    ``perl``) the target file is the *last* positional argument rather than
    the first, because the script expression comes before the filename
    (e.g. ``sed 's/a/b/' file``).  Scripted readers invoked with an in-place
    flag (``-i``, ``--in-place``) are classified as ``unknown`` because they
    mutate the file rather than reading it.

    PowerShell ``Get-Content`` / ``gc`` is dispatched to
    :func:`_parse_powershell_read` because its argument grammar
    (``-Path file -TotalCount 50``) is not bash-compatible.
    """
    if binary in ("get-content", "gc"):
        return _parse_powershell_read(binary, args)

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

    offset: int | None = None
    if is_scripted:
        target_path = positional_args[-1]
        # The "script" for awk/sed is everything between the binary and the
        # final positional argument.  Most slice expressions live in a single
        # positional token (``'10,20p'``, ``'NR==5'``), so we inspect the
        # second-to-last positional.  Perl is left unparsed because its slice
        # idioms vary too widely to detect reliably.
        if binary == "sed":
            offset, limit = _parse_sed_script(positional_args[-2])
        elif binary == "awk":
            offset, limit = _parse_awk_script(positional_args[-2])
    else:
        target_path = positional_args[0]
        # ``head -n N FILE`` reads lines 1..N.  Record the offset so session
        # tracking can mark the exact slice as already-read.  ``tail`` is
        # intentionally left without an offset: without the file's total line
        # count we cannot derive the starting line number.
        if binary == "head" and limit is not None:
            offset = 1

    intent = _build_read_intent(target_path)
    if intent.kind == "read":
        intent.offset = offset
        intent.limit = limit
    return intent


def _parse_powershell_read(binary: str, args: list[str]) -> BashIntent:
    """Parse ``Get-Content`` / ``gc`` (PowerShell) argument lists.

    PowerShell flags are case-insensitive and use a leading dash with no
    second-character requirement, so ``-Path``, ``-path``, ``-PATH`` are all
    equivalent.  The target file is supplied either positionally
    (``Get-Content foo.txt``) or via ``-Path`` / ``-LiteralPath``; both forms
    must be accepted.

    Recognises ``-TotalCount N`` / ``-First N`` / ``-Head N`` as head-style
    limits and ``-Tail N`` / ``-Last N`` as tail-style limits.  Stream flags
    like ``-Raw`` and ``-Wait`` are simply skipped.
    """
    target_path: str | None = None
    limit: int | None = None
    offset: int | None = None
    is_tail = False
    i = 0
    while i < len(args):
        a = args[i]
        lower = a.lower()
        # ``-Path foo.txt`` / ``-LiteralPath foo.txt`` consumes the next token.
        if lower in _PS_PATH_FLAGS and i + 1 < len(args):
            target_path = args[i + 1]
            i += 2
            continue
        if lower in _PS_HEAD_FLAGS and i + 1 < len(args):
            value = _try_parse_int(args[i + 1])
            if value is not None:
                limit = value
            i += 2
            continue
        if lower in _PS_TAIL_FLAGS and i + 1 < len(args):
            value = _try_parse_int(args[i + 1])
            if value is not None:
                limit = value
                is_tail = True
            i += 2
            continue
        if a.startswith("-"):
            # Skip unknown PowerShell flags (e.g. ``-Raw``, ``-Encoding utf8``).
            # Flag-with-arg shapes are heuristically detected: if the next
            # token does not itself start with ``-`` and we haven't yet found
            # a path, treat the next token as the flag's value rather than as
            # the positional path.  This avoids ``-Encoding utf8 file.txt``
            # being parsed as ``target=utf8``.
            if (
                i + 1 < len(args)
                and not args[i + 1].startswith("-")
                and target_path is None
                and lower in {"-encoding", "-delimiter", "-stream", "-readcount"}
            ):
                i += 2
                continue
            i += 1
            continue
        if target_path is None:
            target_path = a
        i += 1

    if target_path is None:
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a file path")

    # ``-TotalCount N`` is equivalent to ``head -n N``; record offset=1 so
    # session tracking knows which slice was consumed.  ``-Tail N`` mirrors
    # ``tail -n N`` — limit only, no offset.
    if limit is not None and not is_tail:
        offset = 1

    intent = _build_read_intent(target_path)
    if intent.kind == "read":
        intent.offset = offset
        intent.limit = limit
    return intent


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
