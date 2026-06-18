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
  Multi-file reads (``cat f1.py f2.py``) are detected: ``target_path`` holds
  the first file for backward compatibility and ``target_paths`` holds all
  files when more than one is present.
* **Grep** — ``rg``, ``grep``, ``ag``, ``ack``, ``ripgrep``.
* **Glob/find** — ``find``, ``fd``, ``fdfind``, ``ls``, ``eza``.
* **jq/yq read-equivalent** — ``jq '.' file.json`` and ``yq '.' file.yaml``
  (trivial identity filter ``.`` only) are classified as ``kind='read'``
  because they stream the full file to stdout unchanged.  Non-trivial filter
  expressions fall through to ``unknown``.

PowerShell pipelines
--------------------
PowerShell's idiomatic read-then-filter pattern is a pipeline:
``Get-Content file | Select-String 'pat'`` or
``gc file | ? { $_ -match 'pat' } | select -First 5``.  When the source
command of such a pipeline is ``Get-Content``/``gc``, the downstream stages
are inspected for filter/limit cmdlets:

* ``Select-String`` / ``sls`` — pattern filter; sets ``filtered=True`` and
  records ``filter_pattern``.  Output is a subset of source lines, so the
  read must not be treated as a full read for dedup purposes.
* ``Where-Object`` / ``?`` / ``where`` — predicate filter; same treatment.
  When the predicate is ``{ $_ -match 'pat' }`` or ``{ $_ -notmatch 'pat' }``
  (and similar comparison operators) the pattern is captured.
* ``Select-Object -First N`` / ``select -First N`` — head-like slice; sets
  ``offset=1, limit=N`` if no limit was already specified.
* ``Select-Object -Last N`` — tail-like slice; sets ``limit=N`` with no offset.
* ``Out-String`` / formatting stages — passthrough; the source ``Get-Content``
  is still recognised as a full read.
* ``Sort-Object``, ``ForEach-Object``, ``Tee-Object``, ``Measure-Object``,
  ``Group-Object``, ``ConvertTo-*`` — passthrough; all source lines consumed.

Line-range extraction
---------------------
Where the source command encodes a slice of the file, ``offset`` and ``limit``
are populated so session-tracking and hint generation can record exactly which
lines were consumed:

* ``head -n N FILE`` → ``offset=1, limit=N``
* ``tail -n +N FILE`` → ``offset=N, limit=None`` (skip-to-line; normalized to 0-indexed in hooks_read)
* ``sed -n 'M,Np' FILE`` → ``offset=M, limit=N-M+1``
* ``sed -n 'Np' FILE`` (single line) → ``offset=N, limit=1``
* ``awk 'NR==N' FILE`` → ``offset=N, limit=1``
* ``awk 'NR>=M && NR<=N' FILE`` → ``offset=M, limit=N-M+1``

False-positive guards
---------------------
* Heredocs (``cat << EOF ... EOF``) are *not* file reads — no path follows the
  command — and are classified as ``unknown``.
* In-place editors (``sed -i``, ``perl -i``) mutate files and are rejected.
* ``type <name>`` is treated as a file read only when the argument is
  path-like (contains ``.``, ``/``, ``\\``, ``:``, or ``~``).  Bare
  identifiers like ``type ls`` are the POSIX command-lookup builtin and
  are classified as ``unknown``.
* ``type <name>`` is treated as a file read only when the argument is
  path-like (contains ``.``, ``/``, ``\\``, ``:``, or ``~``).  Bare
  identifiers like ``type ls`` are the POSIX command-lookup builtin and
  are classified as ``unknown``.

All parsing is best-effort.  Unrecognized or malformed commands are returned as
``BashIntent(kind="unknown")`` without raising an exception.
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .util import get_logger

__all__ = ["BashIntent", "parse", "split_compound"]

_LOG = get_logger("bash_parser")

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
        target_path: Resolved file path for ``kind='read'`` commands.  When
            multiple files are read (e.g. ``cat f1.py f2.py``), this is the
            *first* path for backward compatibility.  ``None`` for
            grep/glob/unknown.
        target_paths: All file paths for multi-file ``kind='read'`` commands
            (e.g. ``cat f1.py f2.py``).  ``None`` when only one path is
            present or the kind is not ``'read'``.  Callers that only need a
            single path should continue using ``target_path``; callers that
            want to process every file in the command should iterate
            ``target_paths`` when it is non-``None``.
        pattern: Search pattern for ``kind='grep'`` or root/name pattern for
            ``kind='glob'``.  ``None`` for read/unknown.
        offset: Line offset for ``kind='read'`` — 1-indexed start line.  Set by
            ``tail -n +N`` (skip-to-line form), ``head -n N`` (always 1), and
            scripted readers (sed/awk).  ``None`` for plain ``tail -n N`` reads
            where the start line depends on total file length.
        limit: Line count for ``kind='read'`` (from ``head -n N`` / ``tail -n N``).
            ``None`` means the whole file.
        reason: Human-readable explanation for ``kind='unknown'``, used for debug
            logging when the hook skips processing.
        filtered: ``True`` when the read was followed by a pattern-matching
            pipeline filter (PowerShell ``Select-String``/``Where-Object``,
            etc.) so the agent only ever saw a *subset* of the file's lines.
            Session-tracking should not mark the source file as fully read in
            this case — re-reading later may still surface new content.
        filter_pattern: When ``filtered`` is True, the substring/regex that the
            downstream filter searched for.  Captured for debug logging; not
            currently used by session tracking but available for future
            "what did the agent actually see?" surfaces.
        is_interactive_pager: ``True`` for interactive pagers like ``less`` and
            ``more`` — the output is not a full structured file read and should
            not be redirected to the Read tool. A session hint is still emitted
            but the file is not marked as fully read.
    """

    kind: BashIntentKind
    target_path: str | None = None
    target_paths: list[str] | None = None
    pattern: str | None = None
    offset: int | None = None
    limit: int | None = None
    reason: str | None = None
    filtered: bool = False
    filter_pattern: str | None = None
    is_interactive_pager: bool = False


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

# Interactive pagers that should emit a session hint but NOT be redirected to
# the Read tool, since the user interaction (scrolling, searching) produces
# non-deterministic output for the agent.
INTERACTIVE_PAGER_BINS = frozenset(["less", "more"])

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

# PowerShell read cmdlets — the *source* of a read-then-filter pipeline.
# Lowercased for case-insensitive comparison.
_PS_READ_BINS = frozenset(["get-content", "gc"])

# PowerShell filter cmdlets that *narrow* the source's output to a subset of
# matching lines.  When one of these appears downstream of ``Get-Content`` we
# mark the read as ``filtered=True`` so session-tracking treats it as a
# partial-read and does not skip re-reading on a later request.
_PS_FILTER_CMDLETS = frozenset(
    [
        "select-string",
        "sls",
        "where-object",
        "where",
        "?",
    ]
)

# PowerShell limit cmdlets — ``Select-Object -First N`` is the canonical
# "head N" of a pipeline.  ``select`` is the standard alias.
_PS_LIMIT_CMDLETS = frozenset(["select-object", "select"])

# PowerShell formatting / display / transform cmdlets — pure passthrough for our
# purposes.  Their presence in a pipeline does *not* change the read
# classification; the agent still consumes the full source-file content via
# Get-Content.
#
# ``Sort-Object`` / ``sort`` re-orders lines but does not reduce their count.
# ``ForEach-Object`` / ``%`` / ``foreach`` iterates every line — still a full
# read.  ``Tee-Object`` / ``tee`` copies the stream to a file *and* passes it
# downstream — the source file is read in full.  ``Measure-Object`` / ``measure``
# aggregates statistics but reads every line.  ``ConvertTo-*`` serialises to
# another format — all source lines are consumed.  ``Group-Object`` / ``group``
# groups but does not drop lines.
_PS_PASSTHROUGH_CMDLETS = frozenset(
    [
        "out-string",
        "out-host",
        "out-default",
        "format-table",
        "format-list",
        "ft",
        "fl",
        "write-host",
        "write-output",
        # Ordering / aggregation (all lines consumed)
        "sort-object",
        "sort",
        "measure-object",
        "measure",
        "group-object",
        "group",
        # Iteration (every line visited)
        "foreach-object",
        "%",
        "foreach",
        # Tee — copies stream, does not narrow it
        "tee-object",
        "tee",
        # Serialisation — all source lines consumed
        "convertto-json",
        "convertto-csv",
        "convertto-html",
        "convertto-xml",
        "convertto-string",
    ]
)

# ``Select-String``'s pattern flag (long form).  Matches ``-Pattern`` /
# ``-pattern`` and the inline ``=`` form, plus shortened ``-pat`` / ``-p``
# which PowerShell accepts due to partial-name parameter matching.
_PS_PATTERN_FLAGS = frozenset(["-pattern", "-pat", "-p"])

# Regex extracts the pattern from a Where-Object script block.  Handles the
# positive comparison operators (``-match``, ``-like``, ``-imatch``,
# ``-cmatch``) and the negation operators (``-notmatch``, ``-notlike``,
# ``-inotmatch``, ``-cnotmatch``).  Both narrow the result to a subset of
# lines — a ``-notmatch`` filter still marks the read as partial since the
# agent only sees lines that do *not* match.  Single or double quotes accepted.
_PS_WHERE_MATCH_RE = re.compile(
    r"\$_\s*-(?:(?:c|i)?(?:not)?match|(?:not)?like)\s+(['\"])([^'\"]+)\1"
)

# Pattern-search tools.  All of these put the search pattern as the first
# non-flag positional argument, making extraction straightforward.
GREP_BINS = frozenset(["rg", "grep", "ag", "ack", "ripgrep", "findstr", "select-string", "sls"])

# Directory enumeration and file-discovery tools.  Treated as ``glob`` because
# their output is a list of paths, analogous to the Glob tool.
GLOB_BINS = frozenset(["find", "fd", "fdfind", "ls", "eza"])

# JSON/YAML query tools.  When invoked with a trivial identity filter (``jq '.'``
# or ``yq '.'``) the tool streams the entire file content to stdout, which is
# semantically equivalent to a full file read.  Non-trivial filter expressions
# are NOT treated as reads — the agent only sees a filtered projection.
JQ_BINS = frozenset(["jq", "yq"])

# Trivial jq/yq filter expressions that are equivalent to reading the whole
# file.  ``'.'`` is the identity filter; ``'.'`` (single quotes stripped by
# shlex) becomes ``'.'``.  An empty string also passes everything through.
# More complex expressions like ``.foo``, ``.[] | .name`` etc. are NOT
# trivial and fall through to ``unknown``.
_JQ_TRIVIAL_FILTERS = frozenset([".", ""])


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

# Heuristic for "looks like a file path".  ``type`` is the most ambiguous
# read-binary because it is *also* a bash/POSIX builtin (``type ls`` is a
# command-lookup, not a file read) and a cmd.exe / PowerShell file-print
# command.  To avoid mis-classifying command-lookup invocations we require
# the argument to contain at least one path-defining glyph (``.``, ``/``,
# ``\``, ``:``, ``~``) before treating ``type FOO`` as a file read.  Common
# command names like ``ls``, ``git``, ``python`` lack all four glyphs and
# fall through to ``unknown``.
_PATH_LIKE_RE = re.compile(r"[./\\:~]")


def _looks_like_path(token: str) -> bool:
    """Return True when *token* contains at least one path-defining glyph.

    Used to disambiguate ``type FOO`` between the cmd.exe / PowerShell
    file-read sense and the POSIX-shell command-lookup builtin.  A token
    like ``foo.txt``, ``./foo``, ``C:\\foo``, ``~/foo``, or ``foo/bar`` is
    treated as a path; a bare identifier like ``ls`` or ``git`` is not.
    """
    return bool(_PATH_LIKE_RE.search(token))


def _is_system_path(path_str: str) -> bool:
    """Return True when *path_str* is a system/OS path unlikely to be a project file.

    Guards against treating ``cat /etc/hosts``, ``cat /etc/passwd``,
    ``cat C:\\Windows\\System32\\...`` as project-file reads. Paths under
    /etc, /sys, /proc, /dev on POSIX and C:\\Windows, C:\\Program Files on
    Windows are classified as system paths and rejected. Notably, /var, /usr,
    /usr/local and application log files are NOT automatically rejected as they
    may be legitimate project resources.

    Paths are normalised to forward slashes before comparison so that Windows
    paths arriving with backslashes (``C:\\Windows\\...``) and the same path
    with forward slashes (``C:/Windows/...``) or from WSL (``/mnt/c/Windows/...``)
    are all treated consistently.
    """
    # Normalise to lowercase forward-slash form for uniform comparison.
    path_lower = path_str.lower().replace("\\", "/")
    # POSIX system paths (critical system dirs only)
    if path_lower.startswith(("/etc/", "/sys/", "/proc/", "/dev/")):
        return True
    # WSL-mounted Windows system paths (e.g. /mnt/c/windows/...)
    if path_lower.startswith(("/mnt/c/windows/", "/mnt/c/program files", "/mnt/c/programdata/")):
        return True
    # Windows system paths — match both backslash and forward-slash forms
    # after normalisation (backslashes already replaced above).
    return path_lower.startswith(
        (
            "c:/windows/",
            "c:/program files",
            "c:/programdata/",
            "c:/winnt/",
        )
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


def split_compound(cmd: str) -> list[str]:
    """Split a compound Bash command on ``&&``, ``;``, and ``||`` operators.

    Separators inside single quotes, double quotes, and ``$(...)``/``(...)``
    subshells are ignored so ``cmd "foo && bar"`` is returned as one segment.
    ``||`` branches are *dropped* — they represent failure-fallback commands
    that should not be treated as independently cacheable read operations.

    Returns a list of stripped command strings.  A command that contains no
    compound operators is returned as a one-element list with the original
    command (stripped).
    """
    segments: list[str] = []
    current: list[str] = []
    i = 0
    n = len(cmd)
    in_single = False
    in_double = False
    in_backtick = False
    paren_depth = 0
    skip_segment = False  # True when the current segment follows a || operator

    while i < n:
        ch = cmd[i]

        # ── Inside single quotes: no escaping, no subshells ──────────────────
        if in_single:
            current.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue

        # ── Inside backtick subshell: ` ... ` ────────────────────────────────
        if in_backtick:
            current.append(ch)
            if ch == "`":
                in_backtick = False
            i += 1
            continue

        # ── Inside double quotes: only \\ and \" escapes plus $( subshell ────
        if in_double:
            current.append(ch)
            if ch == "\\":
                i += 1
                if i < n:
                    current.append(cmd[i])
                i += 1
                continue
            if ch == '"':
                in_double = False
            elif ch == "$" and i + 1 < n and cmd[i + 1] == "(":
                paren_depth += 1
                current.append("(")
                i += 2
                continue
            i += 1
            continue

        # ── Inside $(...) or (...) subshell ───────────────────────────────────
        if paren_depth > 0:
            current.append(ch)
            if ch == "(":
                paren_depth += 1
            elif ch == ")":
                paren_depth -= 1
                if paren_depth < 0:
                    paren_depth = 0
            elif ch == "'":
                in_single = True
            elif ch == '"':
                in_double = True
            i += 1
            continue

        # ── Top-level characters ──────────────────────────────────────────────
        if ch == "`":
            in_backtick = True
            current.append(ch)
            i += 1
        elif ch == "'":
            in_single = True
            current.append(ch)
            i += 1
        elif ch == '"':
            in_double = True
            current.append(ch)
            i += 1
        elif ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            paren_depth += 1
            current.append(ch)
            current.append("(")
            i += 2
        elif ch == "(":
            paren_depth += 1
            current.append(ch)
            i += 1
        elif ch == "\\":
            current.append(ch)
            i += 1
            if i < n:
                current.append(cmd[i])
                i += 1
        elif cmd[i : i + 2] == "&&":
            seg = "".join(current).strip()
            if seg and not skip_segment:
                segments.append(seg)
            current = []
            skip_segment = False
            i += 2
        elif cmd[i : i + 2] == "||":
            seg = "".join(current).strip()
            if seg and not skip_segment:
                segments.append(seg)
            current = []
            skip_segment = True  # next segment is a fallback branch — drop it
            i += 2
        elif ch == ";":
            seg = "".join(current).strip()
            if seg and not skip_segment:
                segments.append(seg)
            current = []
            skip_segment = False
            i += 1
        else:
            current.append(ch)
            i += 1

    # Flush the final segment
    seg = "".join(current).strip()
    if seg and not skip_segment:
        segments.append(seg)

    return segments or [cmd.strip()]


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

    # Split on pipe.  For most shells we only inspect the first segment (the
    # source command); for PowerShell pipelines where the source is
    # Get-Content/gc, downstream filter/limit cmdlets are inspected as well so
    # the read can be marked ``filtered`` and given a correct limit.
    segments = [s.strip() for s in command.split("|")]
    command = segments[0]
    pipeline_tail = segments[1:]

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
        # PowerShell pipeline tail: ``Get-Content foo | Select-String 'bar'``
        # — annotate the read with filter/limit info derived from the tail.
        # Only applied when the source is a PowerShell read cmdlet; bash
        # pipelines like ``cat foo | grep bar`` keep their historical
        # whole-file-read semantics for backward compatibility.
        if intent.kind == "read" and binary in _PS_READ_BINS and pipeline_tail:
            _apply_powershell_pipeline_filters(intent, pipeline_tail)
        return intent
    if binary == "findstr":
        return _parse_findstr(binary, args)
    if binary in ("select-string", "sls"):
        return _parse_ps_grep(binary, args)
    if binary in GREP_BINS:
        return _parse_grep(binary, args)
    if binary in GLOB_BINS:
        return _parse_glob(binary, args)
    if binary in JQ_BINS:
        return _parse_jq_read(binary, args)
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


def _parse_line_count_flag(args: list[str], i: int) -> tuple[int | None, int, bool]:
    """Parse a line-count flag at position *i* and return ``(value, tokens_consumed, is_skip)``.

    Recognises three forms used by ``head`` and ``tail``:
    - ``-n N`` / ``--lines N`` — two-token form; returns ``(N, 2, ...)`` when the
      next token exists and parses as an integer, else ``(None, 2, False)`` (still
      skips the next token to avoid treating it as a positional argument).
    - ``-nN`` (compact form, e.g. ``-n10``) — single-token; returns ``(N, 1, ...)``.
    - ``--lines=N`` — single-token with ``=``; returns ``(N, 1, ...)``.

    ``is_skip`` is True when the numeric token is prefixed with ``+`` (e.g.
    ``tail -n +10``), meaning "output starting at line N" rather than "output
    the last N lines".

    Returns ``(None, 0, False)`` when the token at *i* is not a line-count flag,
    so the caller can fall through to generic flag / positional-argument handling.
    """
    a = args[i]
    if a in ("-n", "--lines"):
        raw = args[i + 1] if i + 1 < len(args) else None
        is_skip = isinstance(raw, str) and raw.startswith("+")
        value = _try_parse_int(raw.lstrip("+")) if raw else None
        return value, 2, is_skip
    if a.startswith("-n") and len(a) > 2:
        raw = a[2:]
        is_skip = raw.startswith("+")
        return _try_parse_int(raw.lstrip("+")), 1, is_skip
    if a.startswith("--lines="):
        raw = a.split("=", 1)[1]
        is_skip = raw.startswith("+")
        return _try_parse_int(raw.lstrip("+")), 1, is_skip
    return None, 0, False


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
    tail_skip_start: int | None = None  # 1-indexed start line for ``tail -n +N``
    positional_args: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if is_line_count_binary:
            value, consumed, is_skip = _parse_line_count_flag(args, i)
            if consumed:
                if value is not None:
                    if is_skip and binary == "tail":
                        tail_skip_start = value  # ``tail -n +N``: output from line N
                    else:
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
        all_file_paths: list[str] = [target_path]
    else:
        target_path = positional_args[0]
        # ``head -n N FILE`` reads lines 1..N.  Record the offset so session
        # tracking can mark the exact slice as already-read.  Plain ``tail -n N``
        # is left without an offset: the starting line depends on the file's
        # total length.  ``tail -n +N`` is the skip-to-line form — output starts
        # at line N regardless of file length — so the offset IS known.
        if binary == "head" and limit is not None:
            offset = 1
        elif tail_skip_start is not None:
            # ``tail -n +0`` is semantically ``+1`` on GNU tail (floor at 1 so
            # the hooks_read normalisation never produces a negative offset).
            offset = max(1, tail_skip_start)  # 1-indexed; hooks_read normalises to 0-indexed
        # Collect all positional arguments as file paths.  Commands like
        # ``cat f1.py f2.py`` read every named file.  Each path undergoes the
        # same system-path filter; any system path silently drops out of the
        # multi-file list (a single system path in an otherwise valid list does
        # not poison the whole read).
        all_file_paths = [p for p in positional_args if not _is_system_path(p)]

    # ``type`` ambiguity guard: in bash / POSIX shells ``type`` is a
    # command-lookup builtin (``type ls`` reports where ``ls`` lives), not a
    # file read.  In cmd.exe and PowerShell ``type`` is a file-print command.
    # We split the two by argument shape — a path-like token (containing
    # ``.``, ``/``, ``\``, ``:``, or ``~``) is treated as a read; a bare
    # identifier is treated as the POSIX builtin and classified ``unknown``.
    if binary == "type" and not _looks_like_path(target_path):
        return BashIntent(
            kind="unknown",
            reason="`type <name>` without a path-like argument is the POSIX builtin",
        )

    # System path guard: reject reads of /etc, /sys, /proc, C:\Windows, etc.
    # These are not project files and should not trigger session tracking or
    # image-shrink logic.  For a single-file read the first (and only) path
    # must pass; for multi-file reads the first path must pass (it becomes
    # ``target_path``).
    if _is_system_path(target_path):
        return BashIntent(
            kind="unknown",
            reason=f"system path {target_path} is not a project file",
        )

    # Interactive pagers: flag as interactive but still return a read intent
    # so the file can be marked in session tracking, but set is_interactive_pager
    # so the hook does not redirect to Read tool.
    intent = _build_read_intent(target_path)
    if intent.kind == "read":
        intent.offset = offset
        intent.limit = limit
        if binary in INTERACTIVE_PAGER_BINS:
            intent.is_interactive_pager = True
        # Populate target_paths for multi-file reads (e.g. ``cat f1.py f2.py``).
        # target_path holds the first path for backward compatibility; callers
        # that want all files iterate target_paths when it is non-None.
        if len(all_file_paths) > 1:
            intent.target_paths = all_file_paths
    return intent


def _parse_powershell_read(binary: str, args: list[str]) -> BashIntent:
    """Parse ``Get-Content`` / ``gc`` (PowerShell) argument lists.

    PowerShell flags are case-insensitive and use a leading dash with no
    second-character requirement, so ``-Path``, ``-path``, ``-PATH`` are all
    equivalent.  The target file is supplied either positionally
    (``Get-Content foo.txt``) or via ``-Path`` / ``-LiteralPath``; both forms
    must be accepted.

    Recognises ``-TotalCount N`` / ``-First N`` / ``-Head N`` as head-style
    limits and ``-Tail N`` / ``-Last N`` as tail-style limits.

    Multi-file reads (``gc file1.txt file2.txt``) populate ``target_paths``
    in the returned intent, matching the behaviour of POSIX ``cat f1 f2``.

    ``-Wait`` is the PowerShell equivalent of ``tail -f``: it streams new lines
    as they are appended continuously.  Like ``less`` / ``more``, this is
    treated as an interactive pager read — the session hint fires but the file
    is not marked fully read because output is unbounded and non-deterministic.
    """
    target_paths: list[str] = []
    limit: int | None = None
    offset: int | None = None
    is_tail = False
    is_wait = False
    i = 0
    while i < len(args):
        a = args[i]
        lower = a.lower()
        # ``-Wait`` — continuous file-follow mode (like ``tail -f``).
        if lower == "-wait":
            is_wait = True
            i += 1
            continue
        # ``-Path foo.txt`` / ``-LiteralPath foo.txt`` consumes the next token.
        if lower in _PS_PATH_FLAGS and i + 1 < len(args):
            target_paths.append(args[i + 1])
            i += 2
            continue
        # PowerShell also accepts the inline ``-Path=foo.txt`` form.
        if "=" in a:
            stem = lower.split("=", 1)[0]
            value_str = a.split("=", 1)[1]
            if stem in _PS_PATH_FLAGS and value_str:
                target_paths.append(value_str)
                i += 1
                continue
            if stem in _PS_HEAD_FLAGS:
                value = _try_parse_int(value_str)
                if value is not None:
                    limit = value
                i += 1
                continue
            if stem in _PS_TAIL_FLAGS:
                value = _try_parse_int(value_str)
                if value is not None:
                    limit = value
                    is_tail = True
                i += 1
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
            #
            # Unconditional arg-consumers: these flags ALWAYS take one argument
            # regardless of whether a file path has already been found.  Without
            # this guard the argument token would be appended to ``target_paths``.
            #
            # Flags that can appear either before or after the path:
            #   ``-Include *.txt``, ``-Exclude *.log``, ``-Filter *.py`` — glob filters
            #   ``-Encoding utf8``, ``-Delimiter ,`` — format options
            #   ``-Stream Zone.Identifier`` — NTFS alternate data stream name; the
            #       stream identifier is never a file path, so it must always be
            #       consumed.  Without this guard ``gc file.txt -Stream Zone.Identifier``
            #       would incorrectly add ``Zone.Identifier`` to ``target_paths``.
            #   ``-ReadCount N`` — pipeline batch size (all lines still consumed);
            #       without unconditional handling ``gc file.txt -ReadCount 10``
            #       would append ``10`` to ``target_paths``.
            if (
                i + 1 < len(args)
                and not args[i + 1].startswith("-")
                and lower in {"-include", "-exclude", "-filter", "-encoding", "-delimiter",
                               "-stream", "-readcount"}
            ):
                i += 2
                continue
            i += 1
            continue
        # Positional path argument.  Multiple positional args are allowed so
        # ``gc file1.txt file2.txt`` collects both files, matching ``cat f1 f2``.
        target_paths.append(a)
        i += 1

    if not target_paths:
        return BashIntent(kind="unknown", reason=f"{binary} command is missing a file path")

    # Filter system paths (same guard as the POSIX read path).
    valid_paths = [p for p in target_paths if not _is_system_path(p)]
    if not valid_paths:
        return BashIntent(
            kind="unknown",
            reason=f"{binary}: all file paths are system paths",
        )

    # ``-TotalCount N`` is equivalent to ``head -n N``; record offset=1 so
    # session tracking knows which slice was consumed.  ``-Tail N`` mirrors
    # ``tail -n N`` — limit only, no offset.
    if limit is not None and not is_tail:
        offset = 1

    intent = _build_read_intent(valid_paths[0])
    if intent.kind == "read":
        intent.offset = offset
        intent.limit = limit
        # ``-Wait`` is a continuous live-tail: mark as interactive pager so the
        # hook emits a hint but does not redirect to the Read tool or mark the
        # file as fully read.
        if is_wait:
            intent.is_interactive_pager = True
        # Multi-file: populate target_paths when more than one file was given.
        if len(valid_paths) > 1:
            intent.target_paths = valid_paths
    return intent


_FINDSTR_FLAG_RE: re.Pattern[str] = re.compile(r"^/[a-zA-Z!?]")
_FINDSTR_C_FLAG_RE: re.Pattern[str] = re.compile(r"^/[cC]:(.+)$")


def _parse_findstr(binary: str, args: list[str]) -> BashIntent:
    """Parse Windows findstr — flags use / prefix (e.g. /i /r /c:"str"). /c:<str> embeds the pattern in the flag."""
    pattern: str | None = None
    target_path: str | None = None
    for token in args:
        c_match = _FINDSTR_C_FLAG_RE.match(token)
        if c_match:
            if pattern is None:
                pattern = c_match.group(1)
            continue
        if _FINDSTR_FLAG_RE.match(token):
            continue
        if pattern is None:
            pattern = token
        elif target_path is None:
            target_path = token
    if pattern is None:
        return BashIntent(kind="unknown")
    return BashIntent(kind="grep", pattern=pattern, target_path=target_path)


def _parse_ps_grep(binary: str, args: list[str]) -> BashIntent:
    """Parse PowerShell Select-String / sls — handles -Pattern and -Path named params then falls back to positional order."""
    pattern: str | None = None
    target_path: str | None = None
    i = 0
    while i < len(args):
        token = args[i]
        lower = token.lower()
        if lower == "-pattern" and i + 1 < len(args):
            pattern = args[i + 1]
            i += 2
            continue
        if lower in ("-path", "-literalpath") and i + 1 < len(args):
            target_path = args[i + 1]
            i += 2
            continue
        if token.startswith("-"):
            i += 1
            continue
        if pattern is None:
            pattern = token
        elif target_path is None:
            target_path = token
        i += 1
    if pattern is None:
        return BashIntent(kind="unknown")
    return BashIntent(kind="grep", pattern=pattern, target_path=target_path)


def _parse_grep(binary: str, args: list[str]) -> BashIntent:
    """Extract the search pattern from rg/grep/ag argument lists.

    Recognises ``-e``/``--regexp``/``--regexp=`` to capture an explicit pattern
    argument.  Falls through to treating the first non-flag positional argument
    as the pattern, which is the normal form for ``rg <pattern> [path]`` and
    ``grep <pattern> [file...]``.  Returns ``BashIntent(kind="unknown")`` when
    no pattern can be identified (e.g. ``grep -h`` alone).

    Special case: ``grep "" <file>`` or ``rg "." <file>`` (trivial patterns that
    match everything) are treated as read-equivalents — the pattern matches
    the entire file, so it's semantically a full file read. In this case, the
    second positional argument (the file path) is returned as a read intent
    instead of a grep intent.
    """
    i = 0
    pattern: str | None = None
    target_path: str | None = None
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
        elif target_path is None:
            target_path = a
        i += 1

    if pattern is None:
        return BashIntent(kind="unknown")

    # Detect read-equivalents: empty pattern or "." matches everything,
    # so if we found a target file, treat it as a read, not a search.
    if target_path and pattern in ("", "."):
        # System path guard: reject system paths as project files
        if _is_system_path(target_path):
            return BashIntent(
                kind="unknown",
                reason=f"system path {target_path} is not a project file",
            )
        return _build_read_intent(target_path)

    return BashIntent(kind="grep", pattern=pattern, target_path=target_path)


def _apply_powershell_pipeline_filters(
    intent: BashIntent, pipeline_tail: list[str]
) -> None:
    """Annotate ``intent`` with filter/limit info from a PowerShell pipeline tail.

    Each segment in *pipeline_tail* is a string (everything between two ``|``
    characters in the original command).  For each segment we attempt to
    identify the cmdlet (case-insensitively, aliases resolved) and update the
    intent in place:

    * **Filter cmdlets** (``Select-String``, ``Where-Object``, ``?``, ``sls``,
      ``where``) mark ``intent.filtered = True`` and capture the pattern when
      it can be extracted (``-Pattern 'x'``, ``-match 'x'``, or the first
      positional argument).
    * **Limit cmdlets** (``Select-Object -First N`` / ``select -First N``)
      populate ``intent.limit`` and ``intent.offset = 1`` when no limit was
      already set by the source command's flags.  ``-Last N`` sets the limit
      without an offset (tail semantics).
    * **Passthrough cmdlets** (``Out-String``, ``Format-Table``, ...) are
      ignored — they do not narrow the read.

    Unrecognized cmdlets are skipped silently; this function never raises and
    never downgrades the intent kind.  The goal is best-effort enrichment so
    callers can distinguish a filtered partial-read from a full-file read.
    """
    for segment in pipeline_tail:
        if not segment:
            continue
        try:
            seg_tokens = shlex.split(segment, posix=True)
        except ValueError:
            # Malformed segment — skip; the source-command intent is still valid.
            continue
        if not seg_tokens:
            continue
        cmdlet = seg_tokens[0].lower()
        seg_args = seg_tokens[1:]
        if cmdlet in _PS_PASSTHROUGH_CMDLETS:
            continue
        if cmdlet in _PS_FILTER_CMDLETS:
            intent.filtered = True
            pattern = _extract_ps_filter_pattern(cmdlet, seg_args, segment)
            if pattern is not None and intent.filter_pattern is None:
                intent.filter_pattern = pattern
            continue
        if cmdlet in _PS_LIMIT_CMDLETS:
            _apply_ps_select_object(intent, seg_args)
            continue
        # Unknown cmdlet — leave the intent as-is.  We deliberately do *not*
        # set filtered=True here because we don't know whether it narrows the
        # output (could be ``ConvertTo-Json`` formatting, ``Tee-Object``
        # branching, etc.).


def _extract_ps_filter_pattern(
    cmdlet: str, args: list[str], raw_segment: str
) -> str | None:
    """Pull the search pattern out of a PowerShell filter-cmdlet segment.

    ``Select-String`` / ``sls`` accept the pattern positionally
    (``sls 'foo'``) or via ``-Pattern 'foo'`` / ``-Pattern=foo``.
    ``Where-Object`` / ``?`` embed the pattern inside a script block, e.g.
    ``{ $_ -match 'foo' }``; the regex :data:`_PS_WHERE_MATCH_RE` extracts it.

    Returns ``None`` when no pattern can be confidently identified.
    """
    if cmdlet in ("select-string", "sls"):
        i = 0
        while i < len(args):
            a = args[i]
            lower = a.lower()
            if lower in _PS_PATTERN_FLAGS and i + 1 < len(args):
                return args[i + 1]
            if "=" in a and lower.split("=", 1)[0] in _PS_PATTERN_FLAGS:
                return a.split("=", 1)[1]
            if not a.startswith("-"):
                # First positional argument is the pattern.
                return a
            i += 1
        return None
    if cmdlet in ("where-object", "where", "?"):
        m = _PS_WHERE_MATCH_RE.search(raw_segment)
        if m:
            return m.group(2)
        return None
    return None


def _apply_ps_select_object(intent: BashIntent, args: list[str]) -> None:
    """Apply ``Select-Object -First N`` / ``-Last N`` to *intent* in place.

    Only updates ``offset`` / ``limit`` when they have not already been set
    by the source command's own flags (e.g. ``Get-Content -TotalCount 50``).
    This preserves the upstream slice when both the cmdlet and the pipeline
    encode a limit, which is the conservative choice — we never widen the
    recorded range.
    """
    i = 0
    while i < len(args):
        a = args[i]
        lower = a.lower()
        if lower in ("-first", "-last") and i + 1 < len(args):
            value = _try_parse_int(args[i + 1])
            if value is not None and intent.limit is None:
                intent.limit = value
                if lower == "-first":
                    intent.offset = 1
            i += 2
            continue
        i += 1


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


def _parse_jq_read(binary: str, args: list[str]) -> BashIntent:
    """Detect ``jq '.' file.json`` / ``yq '.' file.yaml`` as read-equivalents.

    When the filter expression is a trivial identity (``.`` or empty string),
    ``jq``/``yq`` streams the entire file to stdout without modification — this
    is semantically equivalent to a full file read.  Any non-trivial filter
    (e.g. ``.foo``, ``.[] | .name``) produces only a projection of the file
    and is *not* treated as a read.

    Argument grammar (simplified):
    * Positional form: ``jq FILTER [FILE...]``
    * Flags are single-dash tokens (``-r``, ``-c``, ``--raw-output``, etc.)
      and are skipped during positional extraction.
    * ``--arg``, ``--argjson``, ``--slurpfile``, ``--rawfile``, and
      ``--jsonargs``/``--args`` each consume following tokens as values; these
      are skipped conservatively to avoid mistaking a jq variable name or JSON
      literal for the filter or file path.
    """
    # jq flags that consume a following token as a value (name + value pairs).
    _jq_value_flags = frozenset(
        ["--arg", "--argjson", "--slurpfile", "--rawfile", "--jsonargs", "--args",
         "--indent", "--tab"]
    )
    positional_args: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in _jq_value_flags:
            i += 2  # skip the flag and its value
            continue
        if a.startswith("-"):
            i += 1
            continue
        positional_args.append(a)
        i += 1

    if not positional_args:
        return BashIntent(kind="unknown", reason=f"{binary}: no filter or file argument")

    filter_expr = positional_args[0]
    if filter_expr not in _JQ_TRIVIAL_FILTERS:
        # Non-trivial filter — the agent only sees a projection, not the full file.
        return BashIntent(kind="unknown", reason=f"{binary}: non-trivial filter '{filter_expr}' is not a read-equivalent")

    # Trivial filter — the file(s) are read in full.
    file_paths = positional_args[1:]
    if not file_paths:
        # ``jq '.'`` with no file reads stdin — not a file read.
        return BashIntent(kind="unknown", reason=f"{binary}: trivial filter but no file argument (reads stdin)")

    # Filter out system paths and apply path-length guard.
    valid_paths = [p for p in file_paths if not _is_system_path(p)]
    if not valid_paths:
        return BashIntent(
            kind="unknown",
            reason=f"{binary}: all file paths are system paths",
        )

    intent = _build_read_intent(valid_paths[0])
    if intent.kind == "read" and len(valid_paths) > 1:
        intent.target_paths = valid_paths
    return intent
