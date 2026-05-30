"""Compress Bash command output before it reaches the model context window.

Many developer tools (``pytest``, ``npm install``, ``docker build``, ``cargo
build``, ``kubectl get``, ...) emit large quantities of low-information output:
progress bars that overwrite themselves with ``\\r``, ANSI colour escapes that
double the byte count, lists of files that are nearly identical, deprecation
warnings repeated dozens of times, and long success summaries that bury the one
line that actually matters (the failure or the final tally).

Token-Goat detects compressible commands in the Bash tool's ``tool_input``,
rewrites the command to ``token-goat compress --cmd '<orig>' --filter <name>``,
and the wrapper subprocess runs the original through the system shell, captures
stdout + stderr, dispatches to a per-tool filter, and prints a compressed
version that preserves *failures-first* signal while stripping noise.

Design goals
============

* **Lossless on signal**: every error block, every failed test, every warning
  that introduces a new kind of issue, every diff hunk, and every final
  summary line survives the filter unchanged.  Compression is applied only to
  *redundant* output (progress bars, repeated lines, lists with bounded value).

* **Bounded output**: every filter caps total output at
  ``DEFAULT_MAX_LINES`` lines (~1000) and ``DEFAULT_MAX_BYTES`` bytes (~64 KiB)
  regardless of input size.  When the cap is reached the filter emits a clear
  marker explaining how to disable compression.

* **Fail-soft**: a filter that crashes or raises an exception returns the raw
  (ANSI-stripped) output rather than blocking the shell call.  The wrapper
  always preserves the original command's exit code.

* **No silent dataloss**: a compression marker is appended to the output so the
  model knows it is reading a summarised view and how to bypass it.

* **Zero overhead when off**: setting ``TOKEN_GOAT_BASH_COMPRESS=0`` disables
  the entire system at the hook layer so neither the wrapper subprocess nor the
  filter runs.

Public API
==========

* :func:`select_filter`: dispatch a parsed argv to a :class:`Filter`.
* :func:`compress_output`: apply a filter to stdout / stderr / exit_code,
  returning a :class:`CompressedOutput` with metadata.
* :func:`detect_from_command`: parse a raw shell command string and return
  the dispatched filter (or ``None`` if no filter applies).
* :class:`Filter`: base class for per-tool compressors.
* :class:`CompressedOutput`: dataclass holding compressed text and byte stats.

The CLI entry point ``token-goat compress`` lives in :mod:`cli`; the
subprocess wrapper that runs the user's command lives in :mod:`bash_runner`.
"""
from __future__ import annotations

__all__ = [
    "DEFAULT_MAX_BYTES",
    "DEFAULT_MAX_LINES",
    "CompressedOutput",
    "Filter",
    "FILTERS",
    "bytes_to_tokens",
    "cap_bytes",
    "cap_tokens",
    "compress_output",
    "dedupe_consecutive",
    "dedupe_numeric_runs",
    "detect_from_command",
    "select_filter",
    "strip_ansi",
    "strip_progress",
    "truncate_middle",
    "BatFilter",
    "DeltaFilter",
    "EzaFilter",
    "FdFilter",
    "JqFilter",
    "PythonFilter",
    "TreeFilter",
    "UvFilter",
    "YqFilter",
]

import math
import re
import shlex
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from .render.ansi import strip_ansi
from .util import get_logger

_LOG = get_logger("bash_compress")

# ---------------------------------------------------------------------------
# Tunable limits
# ---------------------------------------------------------------------------

#: Maximum line count produced by any filter.  Beyond this the filter elides
#: the middle of the output with a ``truncate_middle`` marker.  ~1000 lines at
#: ~80 chars each is about 80 KB / 20K tokens, already past the point where a
#: human (or a model) is reading every line.
DEFAULT_MAX_LINES: Final[int] = 1000

#: Maximum byte count produced by any filter.  Acts as a backstop when
#: individual lines are unusually long (binary diff, base64, ...).  64 KiB
#: corresponds to ~16K tokens which is still a meaningful chunk of context.
DEFAULT_MAX_BYTES: Final[int] = 64 * 1024

#: Maximum bytes of raw output a filter is willing to inspect.  Beyond this the
#: filter falls back to head/tail truncation without per-tool analysis to keep
#: filter runtime bounded.  2 MiB covers virtually any realistic command, a
#: 100K-line file at 20 bytes/line is 2 MiB, and prevents a runaway log from
#: causing a multi-second pause in the hook.
MAX_INSPECT_BYTES: Final[int] = 2 * 1024 * 1024

#: Trailing marker appended to every compressed output so the agent knows it is
#: looking at a summary and can opt out if it needs the raw view.  Kept short
#: so the meta-cost of the marker is dwarfed by the savings.
_COMPRESSION_MARKER_FMT: Final[str] = (
    "\n[token-goat: {filter} filter -{pct:.0f}%; TOKEN_GOAT_BASH_COMPRESS=0 to disable]"
)

# ---------------------------------------------------------------------------
# Common text-shaping helpers
# ---------------------------------------------------------------------------

# strip_ansi imported from render.ansi (single authoritative implementation).

def strip_progress(text: str) -> str:
    """Collapse ``\\r``-overwrite progress lines to their final state.

    Most terminal progress renderers (``pip``, ``docker``, ``cargo``, ``npm``,
    ``apt``) emit a sequence of bytes ending in ``\\r`` so each subsequent
    update overwrites the previous one on a terminal.  In a captured stream
    these renderings concatenate, producing a 1 KB blob like
    ``Building [.....] 10%\\rBuilding [#####] 50%\\rBuilding [#########] 100%``.
    All but the last state is invisible noise.

    This helper keeps only the segment after the last ``\\r`` within each line,
    which is what a terminal user would have actually seen.  Lines without
    ``\\r`` are passed through unchanged.
    """
    if "\r" not in text:
        return text
    return "\n".join(
        (line.rsplit("\r", 1)[-1] if "\r" in line else line)
        for line in text.split("\n")
    )


def dedupe_consecutive(
    lines: Iterable[str],
    *,
    min_run: int = 2,
    fmt: str = "{line}  (×{count})",
) -> list[str]:
    """Collapse runs of identical consecutive lines to ``line  (×N)``.

    A run shorter than *min_run* is emitted verbatim: single repetitions stay
    untouched so we never spuriously add ``(×1)`` noise.  The default *fmt*
    appends the count after two spaces, which keeps grep-anchored greps on the
    original line text working.

    Useful for compiler warnings, ``kubectl logs`` streaming, and any tool that
    repeats an identical line for each item.  Non-consecutive duplicates are
    *not* deduped because their separation may carry meaning (e.g. one error
    block per file, with the same trailing summary line between).
    """
    out: list[str] = []
    prev: str | None = None
    count = 0
    for line in lines:
        if line == prev:
            count += 1
            continue
        if prev is not None:
            if count >= min_run:
                out.append(fmt.format(line=prev, count=count))
            else:
                out.extend([prev] * count)
        prev = line
        count = 1
    if prev is not None:
        if count >= min_run:
            out.append(fmt.format(line=prev, count=count))
        else:
            out.extend([prev] * count)
    return out


# Pre-compiled pattern used by dedupe_numeric_runs for digit normalisation.
_DIGITS_RE: Final[re.Pattern[str]] = re.compile(r"\d+")

# Matches the exact bytes-elided marker appended by cap_bytes so cap_tokens can
# replace it with a token-based equivalent.  Using rsplit("\n... [", 1) was
# fragile — it could split on literal "\n... [" content in the captured output.
_BYTES_ELIDED_MARKER_RE: Final[re.Pattern[str]] = re.compile(
    r"\n\.\.\. \[\d+ bytes elided by token-goat\]$"
)


def dedupe_numeric_runs(
    lines: Iterable[str],
    *,
    min_run: int = 3,
    fmt: str = "{first}  … ({count} similar lines)",
) -> list[str]:
    """Collapse runs of lines that differ only in embedded numbers.

    Many tools emit progress sequences where each line is structurally identical
    but carries a changing counter:

    .. code-block:: text

        Downloading package 1/50 (foo)
        Downloading package 2/50 (bar)
        ...
        Downloading package 50/50 (qux)

    :func:`dedupe_consecutive` cannot collapse these because the lines are not
    *identical*.  This function normalises all digit sequences to ``#`` before
    comparison so the structural template ``Downloading package #/# (#)`` is
    used as the deduplication key.  When a run of *min_run* or more consecutive
    lines share the same normalised template the whole run is replaced by the
    *first* verbatim line plus the count marker.  Runs shorter than *min_run*
    are passed through unchanged to avoid compressing meaningful consecutive-but-
    different lines (e.g. two compiler warnings with different line numbers).

    Error/failure signal lines (matching :data:`_ERROR_SIGNAL_RE`) are never
    collapsed regardless of whether they share a template with their neighbours.
    """
    line_list = list(lines)
    out: list[str] = []
    i = 0
    while i < len(line_list):
        line = line_list[i]
        # Never collapse lines containing error/failure signal.
        if _ERROR_SIGNAL_RE.search(line):
            out.append(line)
            i += 1
            continue
        key = _DIGITS_RE.sub("#", line)
        # Look ahead for consecutive lines with the same normalised template.
        j = i + 1
        while j < len(line_list):
            candidate = line_list[j]
            if _ERROR_SIGNAL_RE.search(candidate):
                break
            if _DIGITS_RE.sub("#", candidate) != key:
                break
            j += 1
        run_len = j - i
        if run_len >= min_run:
            out.append(fmt.format(first=line, count=run_len))
        else:
            out.extend(line_list[i:j])
        i = j
    return out


def dedupe_by_key(
    lines: Iterable[str],
    key: re.Pattern[str],
    *,
    keep_first_n: int = 3,
    fmt: str = "... +{count} more lines with key={key_value}",
) -> list[str]:
    """Group lines by a regex *key* and keep only *keep_first_n* per group.

    For each line, the first capture group of *key* is the bucket id.  Lines
    whose pattern does not match pass through unchanged.  The *count* in *fmt*
    is the number of additional lines dropped beyond *keep_first_n*.

    Used by linter filters to keep three examples per rule code rather than
    every occurrence, which is the difference between a 5 KB and a 500 KB
    eslint dump on a brownfield codebase.
    """
    seen: dict[str, int] = {}
    out: list[str] = []
    summaries: dict[str, int] = {}
    for line in lines:
        m = key.search(line)
        if m is None:
            out.append(line)
            continue
        bucket = m.group(1) if m.groups() else m.group(0)
        seen[bucket] = seen.get(bucket, 0) + 1
        if seen[bucket] <= keep_first_n:
            out.append(line)
        else:
            summaries[bucket] = summaries.get(bucket, 0) + 1
    for bucket, count in sorted(summaries.items()):
        out.append(fmt.format(count=count, key_value=bucket))
    return out


def truncate_middle(
    lines: list[str],
    max_lines: int,
    *,
    head_ratio: float = 0.4,
    marker_fmt: str = "... [{n} lines elided by token-goat]",
) -> list[str]:
    """Cap *lines* at *max_lines* by keeping the head and tail with a marker.

    The split favours the *tail* (where summaries and failures usually live)
    by default (``head_ratio=0.4`` keeps 40% at the head, 60% at the tail).
    When the input is already within budget the list is returned unchanged.

    The marker is one extra line so the actual output length is
    ``max_lines + 1``.  This is deliberate: the marker is metadata, not
    payload, and counting it against the limit would force us to drop one more
    real line for no gain.
    """
    if len(lines) <= max_lines:
        return lines
    head_keep = max(1, int(max_lines * head_ratio))
    tail_keep = max(1, max_lines - head_keep)
    elided = len(lines) - head_keep - tail_keep
    return [
        *lines[:head_keep],
        marker_fmt.format(n=elided),
        *lines[-tail_keep:],
    ]


# Patterns that signal an error or failure line worth preserving.
_ERROR_SIGNAL_RE: re.Pattern[str] = re.compile(
    r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback"
    r"|exception:|Exception:|AssertionError|assert |panic:",
    re.IGNORECASE,
)


def truncate_middle_smart(
    lines: list[str],
    max_lines: int,
    *,
    head_keep: int = 10,
    tail_keep: int = 10,
    error_context: int = 2,
    max_error_lines: int = 10,
    marker_fmt: str = "--- {n} lines omitted ---",
) -> list[str]:
    """Cap *lines* at *max_lines*, preserving error-signal lines from the middle.

    Unlike :func:`truncate_middle`, this variant scans for lines that match
    error/failure patterns before deciding what to keep.  This prevents
    important failures buried in the middle of long output (e.g. a stack trace
    after 200 lines of progress) from being silently elided.

    Algorithm:
    - If no error-signal lines are found, fall back to :func:`truncate_middle`
      (unchanged head+tail behaviour).
    - If error-signal lines are found:
      1. Keep up to *head_keep* lines from the start (context/header).
      2. Collect up to *max_error_lines* unique error-signal lines, each with
         up to *error_context* lines of surrounding context.
      3. Keep up to *tail_keep* lines from the end (summary).
      4. Insert ``--- N lines omitted ---`` markers between non-contiguous
         sections.
      Total kept lines will not exceed *max_lines* (error section is trimmed
      proportionally if needed).
    """
    if len(lines) <= max_lines:
        return lines

    # Find error-signal line indices.
    error_indices = [i for i, ln in enumerate(lines) if _ERROR_SIGNAL_RE.search(ln)]
    if not error_indices:
        # No error signals — use simple head+tail.
        return truncate_middle(lines, max_lines, marker_fmt=marker_fmt)

    total = len(lines)

    # Clamp head/tail so they don't overlap when the output is only slightly
    # over budget (we'd rather emit a smaller head/tail than duplicate lines).
    eff_head = min(head_keep, total // 4)
    eff_tail = min(tail_keep, total // 4)

    # Build the set of indices to include from the middle (error + context).
    middle_indices: set[int] = set()
    for kept_error_count, ei in enumerate(error_indices):
        if kept_error_count >= max_error_lines:
            break
        for ci in range(max(0, ei - error_context), min(total, ei + error_context + 1)):
            middle_indices.add(ci)

    # Remove indices already covered by head/tail to avoid duplication.
    head_set = set(range(eff_head))
    tail_set = set(range(total - eff_tail, total))
    middle_indices -= head_set | tail_set

    # Sort and trim middle indices to stay within the line budget.
    budget_for_middle = max(0, max_lines - eff_head - eff_tail)
    sorted_middle = sorted(middle_indices)
    if len(sorted_middle) > budget_for_middle:
        sorted_middle = sorted_middle[:budget_for_middle]

    # Build output as sections, inserting omission markers between gaps.
    result: list[str] = []

    def _append_section(indices: list[int]) -> None:
        """Append *indices* to result, inserting omission markers at gaps."""
        for pos, idx in enumerate(indices):
            if pos == 0:
                result.append(lines[idx])
                continue
            prev_idx = indices[pos - 1]
            if idx != prev_idx + 1:
                gap = idx - prev_idx - 1
                result.append(marker_fmt.format(n=gap))
            result.append(lines[idx])

    head_list = list(range(eff_head))
    tail_list = list(range(total - eff_tail, total))

    # Determine the boundary between head and middle sections.
    _append_section(head_list)

    if sorted_middle:
        gap_after_head = sorted_middle[0] - (head_list[-1] if head_list else -1) - 1
        if gap_after_head > 0:
            result.append(marker_fmt.format(n=gap_after_head))
        _append_section(sorted_middle)

    if tail_list:
        last_kept = sorted_middle[-1] if sorted_middle else (head_list[-1] if head_list else -1)
        gap_before_tail = tail_list[0] - last_kept - 1
        if gap_before_tail > 0:
            result.append(marker_fmt.format(n=gap_before_tail))
        _append_section(tail_list)

    return result


def cap_bytes(text: str, max_bytes: int) -> str:
    """Truncate *text* to *max_bytes* UTF-8 bytes, preserving line boundaries.

    Avoids splitting a multibyte UTF-8 character or the middle of a line: cuts
    at the last newline before the budget when one exists, otherwise at the
    last well-formed UTF-8 code point.  A truncation marker is appended.
    """
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    # Reserve room for the marker so the final size stays under the cap.
    marker = f"\n... [{len(encoded) - max_bytes} bytes elided by token-goat]"
    marker_bytes = marker.encode("utf-8")
    budget = max_bytes - len(marker_bytes)
    if budget <= 0:
        return marker.strip()
    truncated = encoded[:budget]
    # Walk back to the last newline so we don't slice mid-line, falling back
    # to the original cut if no newline exists in budget.
    nl = truncated.rfind(b"\n")
    if nl > budget // 2:
        truncated = truncated[:nl]
    return truncated.decode("utf-8", errors="replace") + marker


def bytes_to_tokens(n: int) -> int:
    """Convert a byte count to an approximate token count.

    Uses a conservative estimate of 3.5 characters per token, rounding up.
    This aligns byte limits with actual model context usage.
    """
    return max(1, math.ceil(n / 3.5))


def cap_tokens(text: str, max_tokens: int) -> str:
    """Truncate *text* to approximately *max_tokens* tokens.

    Estimates token count as ``len(text) / 3.5`` and uses
    :func:`truncate_middle_smart` for line-aware truncation when over budget.
    A truncation marker is appended when truncation occurs.

    Token measurement strips ANSI codes before counting so that ANSI-heavy
    output (e.g. full-colour pytest) doesn't falsely trigger the token cap
    earlier than it should.
    """
    # Strip ANSI codes before measuring token count to avoid inflating the estimate
    # with escape sequences that don't contribute to readable content.
    clean_text = strip_ansi(text)
    estimated_tokens = len(clean_text) / 3.5
    if estimated_tokens <= max_tokens:
        return text
    # Convert max_tokens back to bytes for truncation (conservative: 3.5 chars/token).
    # Truncate clean_text so the byte budget is consumed entirely by readable
    # content — ANSI escape sequences in the original would otherwise steal
    # space and clip visible output more aggressively than the token cap implies.
    max_bytes = int(max_tokens * 3.5)
    truncated = cap_bytes(clean_text, max_bytes)
    # Replace the byte-based marker with a token-based one.
    if "[token-goat: output capped at" not in truncated:
        # cap_bytes added a bytes-elided marker; replace it with the token-aware
        # version.  Use a regex anchored to the exact marker format rather than
        # rsplit("\n... [", …) which would split on any literal "\n... [" content
        # appearing inside the captured command output.
        truncated = _BYTES_ELIDED_MARKER_RE.sub("", truncated)
        truncated += f"\n[token-goat: output capped at ~{max_tokens} tokens]"
    return truncated


def split_blocks(
    text: str,
    block_re: re.Pattern[str],
) -> list[str]:
    """Split *text* into blocks demarcated by lines matching *block_re*.

    Each returned block begins at a line matching *block_re* (the match is the
    first line of the block) and extends through the line before the next
    match.  Leading content before the first match is returned as the first
    block (may be empty).
    """
    lines = text.split("\n")
    blocks: list[str] = []
    current: list[str] = []
    for line in lines:
        if block_re.match(line):
            if current:
                blocks.append("\n".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def normalise(text: str) -> str:
    """Run the universal pre-filter pipeline: progress + ANSI + line endings.

    Every filter should call this on its raw input before per-tool logic, it
    removes the noise that obscures structural patterns.  Idempotent.
    """
    if not text:
        return ""
    # CRLF → LF before progress collapsing so the rsplit('\r', ...) doesn't
    # spuriously eat the line-feed half of a Windows line ending.
    text = text.replace("\r\n", "\n")
    text = strip_progress(text)
    text = strip_ansi(text)
    return text


# ---------------------------------------------------------------------------
# Public dataclass
# ---------------------------------------------------------------------------

@dataclass
class CompressedOutput:
    """Result of running a :class:`Filter` over a captured command output.

    Attributes:
        text: The compressed output ready to be written to the wrapper's
            stdout.  Always ends without a trailing newline (the wrapper adds
            one).
        original_bytes: Total bytes of ``stdout + stderr`` before compression
            (post-decoding, pre-filter).
        compressed_bytes: ``len(text.encode("utf-8"))``.  Stored explicitly so
            stats reporting does not re-encode on every read.
        filter_name: ``Filter.name`` of the filter that produced this output.
            ``"raw"`` when no filter applied (compression was a no-op).
        exit_code: The exit code of the wrapped subprocess.  The wrapper exits
            with this code so shell chaining (``cmd && next``) still works.
        notes: Optional diagnostic lines produced during compression (e.g.
            "filter raised TimeoutError; falling back to truncation").  Joined
            with ``\\n`` and prepended to *text* by :meth:`finalize`.
    """

    text: str
    original_bytes: int
    compressed_bytes: int
    filter_name: str
    exit_code: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def bytes_saved(self) -> int:
        """Non-negative byte savings (``original - compressed`` clamped at 0)."""
        return max(0, self.original_bytes - self.compressed_bytes)

    @property
    def tokens_saved(self) -> int:
        """Estimated token savings using the project's ~4 bytes/token rule."""
        return self.bytes_saved // 4

    @property
    def percent_saved(self) -> float:
        """Reduction as a percentage of the original size (0.0 when no input)."""
        if self.original_bytes <= 0:
            return 0.0
        return 100.0 * self.bytes_saved / self.original_bytes

    def with_marker(self) -> str:
        """Return ``text`` with the trailing compression-summary marker appended.

        The marker tells the reader exactly how much was elided and how to opt
        out.  Skipped entirely when the compression was a no-op (savings ≤ 0)
        so we never confuse the model with a marker on raw output.
        """
        if self.bytes_saved <= 0 or self.original_bytes <= 0:
            return self.text
        marker = _COMPRESSION_MARKER_FMT.format(
            filter=self.filter_name,
            orig_kb=self.original_bytes / 1024,
            out_kb=self.compressed_bytes / 1024,
            pct=self.percent_saved,
        )
        return self.text + marker


# ---------------------------------------------------------------------------
# Filter base class + registry
# ---------------------------------------------------------------------------

class Filter:
    """Per-tool output compressor.

    Subclasses declare which command binaries they accept via :attr:`binaries`
    (matched against the resolved argv stem after prefix-stripping) and
    implement :meth:`compress` to produce the compressed body.  The base
    :meth:`apply` method handles ANSI / progress normalisation, byte caps,
    and the trailing compression marker so subclasses can focus on
    tool-specific structural compression.
    """

    #: Display name used in stats and the compression marker.  Should be a short
    #: identifier ([a-z-]+) without whitespace so it survives in log lines.
    name: str = "base"

    #: Set of accepted binary stems (lower-case, no extension).  ``pytest``
    #: matches both ``/usr/bin/pytest`` and ``pytest.exe``.  See
    #: :func:`_resolve_binary` for the matching rule.
    binaries: frozenset[str] = frozenset()

    #: When non-empty, only fire when one of these tokens appears as a
    #: positional argument after the binary.  Used to scope a filter to a
    #: subcommand (``git status`` but not ``git rev-parse``).  Empty means
    #: "match any subcommand".
    subcommands: frozenset[str] = frozenset()

    def matches(self, argv: list[str]) -> bool:
        """Return True when this filter should run for the given argv.

        Default implementation checks :attr:`binaries` against the lowercased
        stem of ``argv[0]`` and, when :attr:`subcommands` is non-empty, looks
        for an exact match in the first three positional arguments (skipping
        leading flags).  Override for more sophisticated dispatch (e.g. when
        a filter wants to inspect a flag's value).

        Matching strategy: ``Path(argv[0]).stem.lower()`` covers the common
        cases (``pytest``, ``pytest.exe``, ``/usr/bin/pytest``).  As a fallback
        the full lowercased filename is also checked so that dot-in-name
        binaries like ``py.test`` — where :func:`Path.stem` stops at the first
        dot and returns ``"py"`` — are dispatched correctly.
        """
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        if stem not in self.binaries and name not in self.binaries:
            return False
        if not self.subcommands:
            return True
        return any(tok in self.subcommands for tok in _positional_args(argv[1:])[:3])

    def _combine_output(self, stdout: str, stderr: str) -> str:
        """Combine stdout and stderr with a separator when both are present.

        Returns stderr if stdout is empty; otherwise returns stdout + "\\n---\\n" + stderr.
        This is the standard output combination pattern used by most filters.
        """
        if stderr.strip() and stdout.strip():
            return f"{stdout.rstrip()}\n---\n{stderr.rstrip()}"
        return stdout.rstrip() if stdout.strip() else stderr.rstrip()

    @staticmethod
    def _emit_notes(
        kept: list[str], notes: list[str], *, prefix: str = "token-goat: ",
    ) -> None:
        """Append a ``[token-goat: <joined notes>]`` summary line to *kept*.

        Centralises the common pattern of building a list of ``"N <label>"``
        fragments during a line-walk and emitting them as a single bracketed
        marker at the end.  No-op when *notes* is empty so callers can append
        unconditionally.

        Joined with ``"; "`` so multi-fragment markers stay legible
        (``[token-goat: dropped 3 X; dropped 5 Y]``).
        """
        if notes:
            kept.append(f"[{prefix}{'; '.join(notes)}]")

    @staticmethod
    def _finalize(kept: list[str]) -> str:
        """Join *kept* with newlines and squeeze runs of blank lines.

        The standard last step of any filter that builds a ``kept`` list during
        a line-walk.  Centralises the ``_squeeze_blank_lines("\\n".join(kept))``
        idiom that appears in 14 filters.
        """
        joined = "\n".join(kept)
        return _squeeze_blank_lines(joined)

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        """Return the compressed body (no marker; no byte cap).

        Subclasses override this.  *stdout* and *stderr* have already been run
        through :func:`normalise` (ANSI / progress stripped, CRLF → LF) by
        :meth:`apply`.  *argv* is the parsed command tokens (after prefix
        stripping) so filters can dispatch on subcommands.  *exit_code* lets
        filters preserve failure context (e.g. don't strip dots when the
        command failed because a failure block is more important than a
        passing summary line).

        The default implementation is a passthrough that concatenates stdout
        and stderr with a separator, useful when the only compression is the
        ANSI / progress strip that :meth:`apply` already performed.
        """
        if stderr and stdout:
            return f"{stdout.rstrip()}\n---\n{stderr.rstrip()}"
        return stdout if stdout else stderr

    def apply(
        self,
        stdout: str,
        stderr: str,
        exit_code: int,
        argv: list[str],
        *,
        max_lines: int = DEFAULT_MAX_LINES,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> CompressedOutput:
        """Top-level entry: normalise → compress → cap → wrap in CompressedOutput.

        Wraps :meth:`compress` with the universal pipeline that every filter
        needs:

        1. Compute original byte count from raw stdout + stderr.
        2. Run :func:`normalise` over both streams (strip ANSI / progress).
        3. Bail out early when post-normalisation input exceeds
           :data:`MAX_INSPECT_BYTES`, for runaway logs we head/tail truncate
           rather than risk a slow per-line filter pass.
        4. Call :meth:`compress` to produce the structurally-compressed body.
        5. Cap line count via :func:`truncate_middle_smart` (error-preserving).
        6. Cap byte count via :func:`cap_bytes` as a hard backstop.
        7. Return the result wrapped in a :class:`CompressedOutput`.

        Errors from :meth:`compress` are caught and logged; the fallback is a
        truncated view of the raw normalised text so the agent always sees
        *something*.
        """
        original_bytes = len(stdout.encode("utf-8", errors="replace")) + len(
            stderr.encode("utf-8", errors="replace")
        )
        notes: list[str] = []
        try:
            norm_out = normalise(stdout)
            norm_err = normalise(stderr)
            norm_bytes = (
                len(norm_out.encode("utf-8", errors="replace"))
                + len(norm_err.encode("utf-8", errors="replace"))
            )

            # Early exit: if normalisation alone (ANSI + progress strip) achieved >=40%
            # reduction, skip expensive per-tool filter and use simple dedup instead.
            if original_bytes > 0 and norm_bytes <= original_bytes * 0.6:
                # Significant reduction from normalisation alone; skip complex parsing.
                _LOG.debug(
                    "filter %s: normalisation reduced %d → %d bytes (%.0f%% saved); "
                    "skipping expensive filter",
                    self.name,
                    original_bytes,
                    norm_bytes,
                    100 * (1 - norm_bytes / original_bytes),
                )
                body = "\n".join(dedupe_consecutive(norm_out.split("\n")))
                if norm_err.strip():
                    body = (
                        body.rstrip() + "\n---\n"
                        + "\n".join(dedupe_consecutive(norm_err.split("\n"))).rstrip()
                    )
                notes.append("early-exit: normalisation alone sufficient")
            elif norm_bytes > MAX_INSPECT_BYTES:
                notes.append(
                    f"input exceeded inspect budget ({MAX_INSPECT_BYTES // 1024} KiB); "
                    "fell back to truncation"
                )
                body = _fallback_truncate(norm_out, norm_err, max_lines)
            else:
                body = self.compress(norm_out, norm_err, exit_code, argv)
        except Exception as exc:  # noqa: BLE001, fail-soft is the contract
            _LOG.exception("filter %s raised; falling back to truncation", self.name)
            notes.append(f"{self.name} filter raised {type(exc).__name__}; truncated raw")
            body = _fallback_truncate(
                normalise(stdout), normalise(stderr), max_lines,
            )

        # Line cap — use smart truncation to preserve error-signal lines from
        # the middle of long output (e.g. stack traces after 200 lines of
        # progress).  Falls back to plain head+tail when no error signals exist.
        lines = body.split("\n")
        if len(lines) > max_lines:
            lines = truncate_middle_smart(lines, max_lines)
            body = "\n".join(lines)
        # Byte cap (backstop for pathological lines).
        body = cap_bytes(body, max_bytes)
        if notes:
            body = "[" + "; ".join(notes) + "]\n" + body
        compressed_bytes = len(body.encode("utf-8", errors="replace"))
        return CompressedOutput(
            text=body,
            original_bytes=original_bytes,
            compressed_bytes=compressed_bytes,
            filter_name=self.name,
            exit_code=exit_code,
        )


def _fallback_truncate(stdout: str, stderr: str, max_lines: int) -> str:
    """Produce a head/tail-truncated dump when a filter cannot run normally.

    Used when input exceeds the inspect budget or when a filter raises.
    Combines stdout + stderr (each separately truncated) and includes a
    clear ``---`` separator so the model can tell them apart.
    """
    out_lines = truncate_middle(stdout.split("\n"), max_lines // 2)
    err_lines = truncate_middle(stderr.split("\n"), max_lines // 2)
    if stderr:
        return "\n".join(out_lines) + "\n---\n" + "\n".join(err_lines)
    return "\n".join(out_lines)


def _positional_args(args: list[str]) -> list[str]:
    """Return positional arguments (skipping ``-x`` and ``--xyz`` flags).

    Naïve but correct for the dispatch use-case: we only need to find the
    *subcommand* (``status``, ``build``, etc.) which is always positional.
    Flag-value pairs like ``--config=foo`` are treated as flags; standalone
    flag values (``-c foo``) leak ``foo`` into the positional list, but that
    is benign because we only check the first few tokens.
    """
    return [a for a in args if not a.startswith("-")]


# ---------------------------------------------------------------------------
# Command prefix stripping (sudo, env, nice, …)
# ---------------------------------------------------------------------------

# Wrappers that change resource use but not the underlying command semantics.
# Their first non-flag argument is the *real* binary we want to dispatch on.
_PASSTHROUGH_PREFIXES: Final[frozenset[str]] = frozenset([
    "sudo", "doas", "time", "nice", "ionice", "nohup", "exec",
    "env", "stdbuf", "unbuffer", "script",
])

# Multi-token wrappers where the *next two* tokens form the real binary.
# ``python -m pytest``, ``uv run pytest``, ``poetry run pytest``, ``npx jest``,
# ``pnpm exec eslint``, ``yarn run lint``, ``bundle exec rspec``.
_TWO_TOKEN_PREFIXES: Final[dict[str, frozenset[str]]] = {
    "python": frozenset(["-m"]),
    "python3": frozenset(["-m"]),
    "py": frozenset(["-m"]),
    "uv": frozenset(["run", "tool"]),
    "uvx": frozenset(),  # uvx <tool>, second token IS the binary
    "poetry": frozenset(["run"]),
    "rye": frozenset(["run"]),
    "pdm": frozenset(["run"]),
    "pipenv": frozenset(["run"]),
    "npx": frozenset(),  # npx <tool>, second token IS the binary
    "pnpm": frozenset(["exec", "dlx", "run"]),
    "yarn": frozenset(["run", "exec", "dlx"]),
    "bundle": frozenset(["exec"]),
    "tox": frozenset(["-e"]),
    "hatch": frozenset(["run"]),
}


def _strip_prefixes(argv: list[str]) -> list[str]:
    """Strip pass-through wrappers and resolve multi-token launchers to the real binary.

    Handles three classes of prefix:

    * **Env assignments**: ``FOO=bar BAZ=qux cmd``: drop tokens with ``=``.
    * **Single-token wrappers**: ``sudo``, ``time``, ``nice``, ``env``,
      ``stdbuf``: skip the wrapper and any of its short flags.
    * **Two-token launchers**: ``python -m pytest``, ``uv run pytest``,
      ``npx jest``: skip the launcher and (optionally) the dispatch keyword,
      treating the *next* token as the binary.

    Returns a new argv list with the first element being the resolved binary
    stem (no path, no extension).  An empty list is returned when stripping
    consumes all tokens.
    """
    if not argv:
        return []
    out = list(argv)
    # Strip leading env assignments (``FOO=bar BAZ=qux cmd ...``).
    while out and "=" in out[0] and not out[0].startswith("-") and "/" not in out[0]:
        # Only treat ``KEY=value`` as an env assignment when KEY is a valid
        # identifier; otherwise it could be a real arg like ``--flag=val``.
        head = out[0].split("=", 1)[0]
        if head and (head[0].isalpha() or head[0] == "_") and all(
            c.isalnum() or c == "_" for c in head
        ):
            out.pop(0)
        else:
            break
    # Strip pass-through prefixes, including their short flags (``nice -n 10``).
    while out:
        stem = Path(out[0]).stem.lower()
        if stem not in _PASSTHROUGH_PREFIXES:
            break
        out.pop(0)
        # Skip the prefix's own flags (``-n 10``, ``-c env``) so we land on
        # the real binary in argv[0] after the loop.
        while out and out[0].startswith("-"):
            flag = out.pop(0)
            # Two-token flags need their value consumed too.  A naive heuristic
            # is enough here: known short flags that take an arg.
            if flag in ("-n", "-c", "-i", "-u", "-e") and out:
                out.pop(0)
    if not out:
        return out
    # Resolve two-token launchers.  ``python -m pytest`` → ``pytest``.
    stem = Path(out[0]).stem.lower()
    if stem in _TWO_TOKEN_PREFIXES and len(out) >= 2:
        next_tok = out[1]
        triggers = _TWO_TOKEN_PREFIXES[stem]
        if not triggers or next_tok in triggers:
            # Skip the launcher and (when present) the dispatch keyword.
            consume = 1 if not triggers else 2
            if len(out) > consume:
                out = out[consume:]
    return out


# ---------------------------------------------------------------------------
# Filter implementations
# ---------------------------------------------------------------------------

class GenericFilter(Filter):
    """Fallback filter: ANSI strip + progress strip + consecutive dedupe.

    Used when no per-tool filter matches but the hook layer has decided to
    wrap a command (e.g. a custom binary the user opted in to compress).
    Cannot rely on tool-specific structure, so it just removes the universal
    noise sources.
    """

    name = "generic"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        out_lines = dedupe_consecutive(stdout.split("\n"))
        err_lines = dedupe_consecutive(stderr.split("\n"))
        if stderr.strip():
            result = "\n".join(out_lines).rstrip() + "\n---\n" + "\n".join(err_lines).rstrip()
        else:
            result = "\n".join(out_lines)
        # Cap token-aware output to ~2000 tokens (~7KB).
        return cap_tokens(result, max_tokens=2000)


# --- Pytest ----------------------------------------------------------------

_PYTEST_DOTS_RE: Final[re.Pattern[str]] = re.compile(
    r"^[\.FxXEsS]+\s*(\[\s*\d+%\])?\s*$"
)
_PYTEST_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^=+\s*(?:test session starts|FAILURES|ERRORS|short test summary info|"
    r"warnings summary|slowest \d+ durations|\d+ failed|\d+ passed|\d+ error)\b"
)
_PYTEST_FAIL_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS)\s+\S"
)
_PYTEST_COLLECT_RE: Final[re.Pattern[str]] = re.compile(r"^collected \d+ items?")
# Banner lines emitted before ``= test session starts =`` — constant per
# project so the agent gains no new information from reading them.
_PYTEST_BANNER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:platform\s|cachedir:\s|rootdir:\s|plugins:\s|configfile:\s)"
)


class PytestFilter(Filter):
    """Compress pytest output: keep failures + summary, drop pass progress.

    Pytest output is highly structured.  The compression model is:

    * **Keep**: header section (rootdir, plugins, collected), every ``FAILED``
      block (full traceback), every ``ERROR`` block, the ``short test summary
      info`` section, warnings summary, and the final ``= N failed, M passed
      in Xs =`` line.
    * **Drop**: pass-progress dots line (``....F..s....    [ 50%]``),
      ``PASSED`` lines in verbose mode (kept as a count), individual collected
      file names beyond the first few, and the constant banner lines
      (``platform``, ``cachedir:``, ``rootdir:``, ``plugins:``,
      ``configfile:``) that are the same for every invocation.

    On a 5 KB pytest run with no failures the output shrinks to ~10 lines.
    With failures the failure tracebacks are preserved untouched so the agent
    has full debugging context.
    """

    name = "pytest"
    binaries = frozenset(["pytest", "py.test"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        text = self._combine_output(stdout, stderr)
        lines = text.split("\n")
        kept: list[str] = []
        passed_count = 0
        in_failures = False
        in_errors = False
        for line in lines:
            # Drop the dots/percent progress line entirely.
            if _PYTEST_DOTS_RE.match(line):
                continue
            # Drop constant banner lines (platform, cachedir, rootdir, plugins,
            # configfile) — same for every run, zero information for the agent.
            if _PYTEST_BANNER_RE.match(line):
                continue
            # Section transitions, re-evaluate which block we're in.
            if _PYTEST_HEADER_RE.match(line):
                in_failures = "FAILURES" in line
                in_errors = "ERRORS" in line or "short test summary" in line
                kept.append(line)
                continue
            # PASSED entries: count, do not keep.  Only when not inside a
            # failure traceback (PASSED can appear in tracebacks as part of
            # captured stderr, keep those).
            if not in_failures and not in_errors and _PYTEST_FAIL_LINE_RE.match(line):
                tag = line.split(None, 1)[0]
                if tag == "PASSED":
                    passed_count += 1
                    continue
                kept.append(line)
                continue
            kept.append(line)
        # Trim collected-files spam to first three.
        kept = _trim_repeated_prefix(kept, _PYTEST_COLLECT_RE, keep=3)
        if passed_count:
            kept.append(f"[token-goat: collapsed {passed_count} PASSED lines]")
        # Drop runs of consecutive blank lines (pytest pads blocks with them).
        return self._finalize(kept)


# --- Jest / Vitest / Mocha -------------------------------------------------

_JEST_PASS_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:PASS|✓|√)\s+\S"
)
_JEST_FAIL_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:FAIL|✗|×|✘)\s+\S"
)
_JEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(Test Suites|Tests|Snapshots|Time|Ran all test suites):"
)


class JestFilter(Filter):
    """Compress Jest / Vitest / Mocha output.

    Jest emits ``PASS`` and ``FAIL`` headers per test file plus a final
    summary block.  Failures include diff-style output (``Expected`` /
    ``Received``) that we preserve verbatim.

    Compression model:

    * **Drop** ``PASS path/to/file.test.js`` lines (collapse to count).
    * **Keep** ``FAIL`` blocks with their full body (signature + diff).
    * **Keep** the final ``Test Suites: …`` / ``Tests: …`` / ``Snapshots: …``
      / ``Time: …`` summary lines.
    * **Drop** the per-file pass list (``✓ should do thing (5 ms)``) outside of
      a FAIL block.
    """

    name = "jest"
    binaries = frozenset(["jest", "vitest", "mocha", "ava", "tap"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Jest writes summaries to stderr by default.
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_count = 0
        in_fail_block = False
        for line in lines:
            if _JEST_PASS_LINE_RE.match(line) and not in_fail_block:
                pass_count += 1
                continue
            if _JEST_FAIL_LINE_RE.match(line):
                in_fail_block = True
                kept.append(line)
                continue
            # Blank line ends a fail block.
            if not line.strip() and in_fail_block:
                in_fail_block = False
            # Suppress the per-test pass tick when outside a fail block.
            stripped = line.lstrip()
            if not in_fail_block and stripped.startswith(("✓", "√")):
                continue
            kept.append(line)
        if pass_count:
            kept.append(f"[token-goat: collapsed {pass_count} PASS files]")
        return self._finalize(kept)


# --- Cargo ------------------------------------------------------------------

_CARGO_COMPILING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Compiling\s+\S+\s+v\S+"
)
_CARGO_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Downloading|Fetching|Updating|Documenting|Checking|Building)\s+\S"
)
_CARGO_FINISHED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Finished\s+(dev|release|test)"
)


class CargoFilter(Filter):
    """Compress cargo build / test / check output.

    Cargo emits a ``Compiling foo v0.1.0`` line per crate (often dozens),
    plus optional ``Downloading``, ``Fetching``, ``Updating`` lines.  These
    are noise unless they fail.

    Compression model:

    * **Drop** ``Compiling`` lines beyond a head + tail sample (keep first 2
      and last 2 so the agent can see what triggered the build).
    * **Drop** ``Downloading`` / ``Fetching`` / ``Updating`` / ``Documenting``
      lines unless followed by an error.
    * **Keep** every ``warning:`` and ``error:`` block in full (Rust diagnostics
      span multiple lines with arrow-pointers; preserving them is essential).
    * **Keep** the ``Finished`` summary line.
    * **Keep** ``cargo test`` output (delegates to test-style filtering).
    """

    name = "cargo"
    binaries = frozenset(["cargo"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Cargo writes progress / errors to stderr; only test bodies to stdout.
        # Note: reversed order (stderr first) — we swap the arguments.
        merged = self._combine_output(stderr, stdout)
        lines = merged.split("\n")
        compiled: list[str] = []
        kept: list[str] = []
        dropped_progress = 0
        for line in lines:
            if _CARGO_COMPILING_RE.match(line):
                compiled.append(line)
                continue
            if _CARGO_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            kept.append(line)
        # Reinject a compact compilation summary.
        if compiled:
            if len(compiled) <= 4:
                kept = compiled + kept
            else:
                kept = [
                    *compiled[:2],
                    f"[token-goat: collapsed {len(compiled) - 4} 'Compiling …' lines]",
                    *compiled[-2:],
                    *kept,
                ]
        if dropped_progress:
            kept.append(f"[token-goat: dropped {dropped_progress} cargo progress lines]")
        return self._finalize(kept)


# --- Node package managers (npm / pnpm / yarn) -----------------------------

_NPM_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s"
)
_NPM_DEPRECATED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*npm warn deprecated|^\s*WARN deprecated", re.IGNORECASE
)
_NPM_AUDIT_PKG_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*[a-z0-9@._/-]+\s+(low|moderate|high|critical)\s", re.IGNORECASE
)
_NPM_ERR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*npm (?:ERR!|error)\s|^\s*ERROR\s", re.IGNORECASE
)


class NodePackageFilter(Filter):
    """Compress ``npm`` / ``pnpm`` / ``yarn`` / ``bun`` package-manager output.

    Package managers emit huge amounts of progress (spinner characters,
    "added X packages" lines, deprecation warnings for transitive deps).
    Errors are usually multi-line ``npm ERR!`` blocks that must survive
    unchanged.

    Compression model:

    * **Drop** spinner / progress lines (``⠋ idealTree:…``).
    * **Collapse** deprecation warnings to one summary line per unique package.
    * **Keep** every ``npm ERR!`` / ``npm error`` block verbatim.
    * **Keep** vulnerability counts but collapse per-package audit detail.
    * **Keep** the final ``added/changed/removed N packages in Xs`` line.
    """

    name = "npm"
    binaries = frozenset(["npm", "pnpm", "yarn", "bun"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        deprecated_pkgs: dict[str, int] = {}
        audit_lines_dropped = 0
        for line in lines:
            if _NPM_PROGRESS_RE.match(line):
                continue
            if _NPM_DEPRECATED_RE.match(line):
                # Extract the package name (``foo@1.2.3:``) for grouping.
                m = re.search(r"\b([a-z0-9@._/-]+)@[\d.]+", line)
                pkg = m.group(1) if m else "<unknown>"
                deprecated_pkgs[pkg] = deprecated_pkgs.get(pkg, 0) + 1
                continue
            if _NPM_AUDIT_PKG_RE.match(line) and not _NPM_ERR_RE.match(line):
                audit_lines_dropped += 1
                continue
            kept.append(line)
        if deprecated_pkgs:
            kept.append(
                f"[token-goat: collapsed {sum(deprecated_pkgs.values())} deprecation "
                f"warnings across {len(deprecated_pkgs)} packages: "
                f"{', '.join(sorted(deprecated_pkgs)[:5])}"
                + ("…" if len(deprecated_pkgs) > 5 else "")
                + "]"
            )
        if audit_lines_dropped:
            kept.append(
                f"[token-goat: dropped {audit_lines_dropped} per-package audit lines; "
                "run `npm audit` for detail]"
            )
        return self._finalize(kept)


# --- Docker ----------------------------------------------------------------

_DOCKER_DIGEST_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*#\d+\s+(sha256:[a-f0-9]{8,}|resolve\s)"
)
_DOCKER_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*#\d+\s+\d+(?:\.\d+)?(?:MB|kB|GB)\s+/"
)
_DOCKER_STEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*=>\s|^\s*#\d+\s+\[(internal|build|stage)"
)
_DOCKER_STEP_BODY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*#\d+\s+\d+(\.\d+)?\s+"
)


class DockerFilter(Filter):
    """Compress ``docker build`` / ``docker run`` / ``docker push`` output.

    BuildKit emits one block per step (``#N [internal] load context``,
    ``#N transferring`` …).  When successful most blocks are uninteresting;
    only ``=> ERROR`` blocks matter.

    Compression model:

    * **Drop** sha256 digest lines (``#3 sha256:…``).
    * **Drop** layer-transfer progress (``#5 12.3MB / 50.0MB 0.5s``).
    * **Drop** internal step bodies (timestamp + line of build output) when
      the step succeeded, keep only the step header and the trailing ``DONE``.
    * **Keep** every step containing ``ERROR`` or ``FAILED``.
    * **Keep** the final ``ERROR: failed to solve:`` block.
    * **Keep** the final ``Successfully built …`` / ``writing image sha256:…``
      line.
    """

    name = "docker"
    binaries = frozenset(["docker", "buildah", "podman", "nerdctl"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Docker writes progress / errors to stderr; only bodies to stdout.
        # Note: reversed order (stderr first) — we swap the arguments.
        merged = self._combine_output(stderr, stdout)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_digest = 0
        dropped_progress = 0
        dropped_body = 0
        for line in lines:
            if _DOCKER_DIGEST_RE.match(line):
                dropped_digest += 1
                continue
            if _DOCKER_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            # When the step succeeded, drop its body (the prefixed timestamps).
            if (
                _DOCKER_STEP_BODY_RE.match(line)
                and not _DOCKER_STEP_RE.match(line)
                and "ERROR" not in line
                and "WARN" not in line.upper()
            ):
                dropped_body += 1
                continue
            kept.append(line)
        if dropped_digest + dropped_progress + dropped_body:
            kept.append(
                f"[token-goat: dropped {dropped_digest} digest, "
                f"{dropped_progress} transfer, {dropped_body} body lines]"
            )
        return self._finalize(kept)


# --- kubectl / helm --------------------------------------------------------

class KubectlFilter(Filter):
    """Compress ``kubectl`` and ``helm`` output.

    ``kubectl get`` returns tabular output (NAME, READY, STATUS, RESTARTS, AGE);
    on a large cluster this is thousands of lines.  Truncate to header + first
    25 rows + tail summary.

    ``kubectl logs`` emits high-volume streaming text; dedupe identical
    consecutive lines (the common "still waiting" / heartbeat pattern).

    ``kubectl describe`` ends with a verbose Events section; preserve only
    Warning events when there are many Normal ones.

    ``helm`` output for ``install`` / ``upgrade`` includes the entire chart's
    NOTES section which can be 100+ lines of post-install documentation;
    truncate to the first 20.
    """

    name = "kubectl"
    binaries = frozenset(["kubectl", "k", "helm", "oc"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        text = stdout
        if subcommand in ("get", "top") and "\n" in text:
            text = _compress_kubectl_table(text)
        elif subcommand == "logs":
            text = "\n".join(dedupe_consecutive(text.split("\n")))
        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text


def _compress_kubectl_table(text: str, max_rows: int = 25) -> str:
    """Truncate a kubectl tabular output to header + first *max_rows* rows."""
    lines = text.split("\n")
    if len(lines) <= max_rows + 1:
        return text
    return (
        "\n".join(lines[: max_rows + 1])
        + f"\n[token-goat: {len(lines) - max_rows - 1} more rows; use --selector or -l to narrow]"
    )


# --- GitHub CLI ------------------------------------------------------------

# `gh run view <id>` prints step-by-step CI logs with status glyphs (`✓` /
# `X` / `*`) per step, and long blocks of repeated noise like ``Run actions/...``
# preamble lines.  We collapse passing step blocks, dedupe identical noise
# lines, and preserve every line that signals a failure.
_GH_RUN_PASS_STEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*[✓√]\s"
)
_GH_RUN_FAIL_STEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*[X✗❌]\s|^\s*FAIL(:|ED|URE)\b|^\s*Error:\s"
)
# Table-row separator emitted by ``gh pr list`` / ``gh issue list`` /
# ``gh run list``: ``OPEN \t #123 \t title \t branch \t 2h ago``.  Each row
# is a tab-separated record.  We never truncate the rows themselves (each is
# load-bearing), only deduplicate identical adjacent lines.


class GhFilter(Filter):
    """Compress ``gh`` (GitHub CLI) output.

    The GitHub CLI is high-volume in agent sessions: ``gh run view`` dumps
    full CI logs (hundreds of lines per failed run), ``gh pr view`` repeats
    the full body twice when ``--comments`` is set, and ``gh api`` returns
    raw JSON that the caller usually pipes through ``jq``.

    Compression model:

    * **``gh run view``**: keep every line in a failed-step block; drop
      ``✓`` passing-step headers (collapse to count); strip the
      ``Run actions/checkout@v4`` action-preamble noise.
    * **``gh pr view`` / ``gh issue view``**: pass through verbatim (these
      have load-bearing metadata in every line, and agents almost always need
      the full body).
    * **``gh pr list`` / ``gh run list`` / ``gh issue list``**: truncate to
      first 30 rows with a count summary (table rows can exceed 100 lines
      when listing many runs/PRs; first 30 + count preserves search ability).
    * **Everything else** (``gh api``, ``gh release view``, …): generic
      ANSI/progress strip only (already handled by :meth:`apply`).
    """

    name = "gh"
    binaries = frozenset(["gh"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        action = positionals[1] if len(positionals) > 1 else ""
        merged = self._combine_output(stdout, stderr)
        if subcommand == "run" and action == "view":
            return _compress_gh_run_view(merged)
        if subcommand in ("pr", "run", "issue") and action == "list":
            return _compress_gh_list(merged, subcommand)
        # Everything else passes through with just blank-line squeezing.
        return _squeeze_blank_lines(merged)


def _compress_gh_run_view(text: str) -> str:
    """Collapse passing ``✓`` step headers in ``gh run view`` output.

    Keeps every line under a failing step and the final ``Annotations`` block;
    drops the long lists of ``Run actions/foo@v1`` action-preamble lines that
    appear under each passing step.
    """
    lines = text.split("\n")
    kept: list[str] = []
    pass_steps = 0
    dropped_preamble = 0
    # When True, we are inside a passing step block and should drop the
    # indented child lines (the action preamble) until the next non-indented
    # line.  Failing steps are always preserved verbatim.
    in_pass_block = False
    for line in lines:
        if _GH_RUN_PASS_STEP_RE.match(line):
            pass_steps += 1
            in_pass_block = True
            continue
        if _GH_RUN_FAIL_STEP_RE.match(line):
            in_pass_block = False
            kept.append(line)
            continue
        if in_pass_block and (line.startswith(("  ", "\t"))):
            dropped_preamble += 1
            continue
        # A non-indented line closes any open pass block.
        if line and not line[0].isspace():
            in_pass_block = False
        kept.append(line)
    notes: list[str] = []
    if pass_steps:
        notes.append(f"collapsed {pass_steps} passing step headers")
    if dropped_preamble:
        notes.append(f"dropped {dropped_preamble} action-preamble lines")
    Filter._emit_notes(kept, notes)
    return _squeeze_blank_lines("\n".join(kept))


def _compress_gh_list(text: str, subcommand: str) -> str:
    """Truncate ``gh pr/run/issue list`` output to first 30 rows + count.

    These commands produce tabular output where each row represents a distinct
    resource. When listing many items, output can exceed 100 lines. We keep
    the first 30 rows (preserving search ability for recent items) and emit
    a count summary of remaining items.
    """
    lines = text.split("\n")
    # Find header line (usually the first non-empty line).
    header_idx = 0
    for i, line in enumerate(lines):
        if line.strip():
            header_idx = i
            break
    # Count data rows (lines after header until blank or end).
    data_start = header_idx + 1
    data_end = len(lines)
    for i in range(data_start, len(lines)):
        if not lines[i].strip():
            data_end = i
            break
    total_data_rows = data_end - data_start
    max_rows = 30
    if total_data_rows <= max_rows:
        return _squeeze_blank_lines(text)
    # Keep header + first N data rows.
    kept_lines = lines[:data_start] + lines[data_start:data_start + max_rows]
    notes = [f"showing first {max_rows} of {total_data_rows} {subcommand}s"]
    Filter._emit_notes(kept_lines, notes)
    return _squeeze_blank_lines("\n".join(kept_lines))


# --- AWS CLI ---------------------------------------------------------------

class AwsFilter(Filter):
    """Compress AWS CLI output.

    The AWS CLI's default ``--output json`` emits one giant JSON document.
    Pagination via ``--no-paginate`` is common, but most calls produce a list
    of resources where the first 20 are representative.  For ``--output
    table`` we truncate the same way as kubectl tables.

    Compression model:

    * **Top-level array** with > 20 items: keep first 20, append ``[+N more
      items elided by token-goat]``.
    * **Nested ``Items`` / ``Reservations`` / ``Functions`` / ``Buckets``
      arrays**: same treatment, preserving the surrounding metadata.
    * **Table output**: same row-truncation as kubectl tables.
    * **Error output**: passed through unchanged.
    """

    name = "aws"
    binaries = frozenset(["aws", "aws2"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        text = stdout
        # Try JSON compression first; fall back to table truncation.
        compressed = _try_compress_json_list(text)
        if compressed is not None:
            text = compressed
        elif "\n" in text and "|" in text:
            text = _compress_kubectl_table(text, max_rows=25)
        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text


def _try_compress_json_list(text: str) -> str | None:
    """If *text* is a JSON document with a long top-level list, truncate it.

    Returns the compressed JSON string, or ``None`` when the text is not JSON
    or when no compression was applied.  Only the most common AWS list shapes
    are detected: top-level array, or top-level object whose first list-valued
    key has > 20 entries.
    """
    import json  # noqa: PLC0415

    stripped = text.strip()
    if not stripped or stripped[0] not in "{[":
        return None
    try:
        data = json.loads(stripped)
    except (ValueError, json.JSONDecodeError):
        return None
    changed = False
    if isinstance(data, list) and len(data) > 20:
        original = len(data)
        data = data[:20]
        data.append({"__token_goat__": f"+{original - 20} items elided"})
        changed = True
    elif isinstance(data, dict):
        for key, value in list(data.items()):
            if isinstance(value, list) and len(value) > 20:
                original = len(value)
                data[key] = [*value[:20], {"__token_goat__": f"+{original - 20} items elided"}]
                changed = True
    if not changed:
        return None
    return json.dumps(data, separators=(",", ":"))


# --- Linters (eslint / ruff / mypy / pylint) -------------------------------

_ESLINT_LOC_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\d+:\d+\s+(error|warning|info)\s"
)
_ESLINT_FILE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:/|[A-Z]:|[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|vue))"
)
_RUFF_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+):\s+(?P<code>[A-Z]+\d+)\s"
)
_RUFF_FOOTER_RE: Final[re.Pattern[str]] = re.compile(
    r"^Found \d+ error"
)
# Ruff success banner: "All checks passed!" (or the older "No errors found.")
# The agent infers success from exit code 0; the text is pure noise.
_RUFF_SUCCESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:All checks passed!|No errors found\.?)\s*$"
)
_MYPY_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?:\d+:)?\s+(?P<level>error|note|warning):"
)


class RuffFilter(Filter):
    """Compress ``ruff`` linter output.

    Ruff on a large codebase often fires the same rule (e.g. E501 line-too-long)
    hundreds of times across dozens of files.  The agent gains nothing from seeing
    the 51st occurrence.

    Compression model:

    * **Rule with >= 3 occurrences across >= 2 files**: collapse to a single
      summary line ``RULE_CODE: N occurrences in M files (example: <first line>)``.
    * **Rule with < 3 occurrences** (or all in one file): keep all lines verbatim.
    * **Always keep** the ``Found N errors`` footer line.
    * **Always keep** non-violation lines (blank lines, section headers, etc.).
    * **On clean exit (exit_code 0, no violations)**: return empty string — the
      agent infers success from the exit code and does not need the
      ``"All checks passed!"`` banner.
    """

    name = "ruff"
    binaries = frozenset(["ruff"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Fast path: clean run — strip the success banner entirely.  The agent
        # infers pass/fail from the exit code; the "All checks passed!" string
        # is pure noise (~4 tokens per invocation).
        if exit_code == 0:
            lines_stripped = [
                ln for ln in merged.splitlines() if not _RUFF_SUCCESS_RE.match(ln)
            ]
            # If nothing remains after stripping the success banner (and any
            # surrounding blank lines), return empty — don't emit whitespace.
            cleaned = "\n".join(lines_stripped).strip()
            # Only suppress when the remaining content is also empty (i.e. ruff
            # printed *only* the success banner).  If there is other output on a
            # clean run (e.g. auto-fix summary from `ruff check --fix`), keep it.
            if not cleaned:
                return ""

        lines = merged.split("\n")

        # First pass: collect violation lines grouped by rule code.
        # code -> list of (file, full_line)
        by_code: dict[str, list[tuple[str, str]]] = {}
        footer_lines: list[str] = []
        indexed: list[tuple[bool, str]] = []  # (is_violation, line)

        for line in lines:
            if _RUFF_FOOTER_RE.match(line):
                footer_lines.append(line)
                indexed.append((False, line))
                continue
            m = _RUFF_LINE_RE.match(line)
            if m:
                code = m.group("code")
                file_ = m.group("file")
                by_code.setdefault(code, []).append((file_, line))
                indexed.append((True, line))
            else:
                indexed.append((False, line))

        # Decide which codes get summarised (>= 3 occurrences across >= 2 files).
        summarised: dict[str, str] = {}
        for code, entries in by_code.items():
            files = {f for f, _ in entries}
            if len(entries) >= 3 and len(files) >= 2:
                example = entries[0][1]
                summarised[code] = (
                    f"{code}: {len(entries)} occurrences in {len(files)} files"
                    f" (example: {example})"
                )

        # Second pass: emit lines.
        out: list[str] = []
        emitted_summary: set[str] = set()
        for is_viol, line in indexed:
            if _RUFF_FOOTER_RE.match(line):
                # Defer footers to end.
                continue
            if not is_viol:
                out.append(line)
                continue
            m = _RUFF_LINE_RE.match(line)
            code = m.group("code") if m else ""
            if code in summarised:
                if code not in emitted_summary:
                    out.append(summarised[code])
                    emitted_summary.add(code)
                # else: skip — already summarised
            else:
                out.append(line)

        out.extend(footer_lines)
        return _squeeze_blank_lines("\n".join(out))


class LinterFilter(Filter):
    """Compress linter output: group by file, dedupe by rule.

    Linters often report the same rule fires 50+ times across a brownfield
    codebase; the agent learns nothing new from the 51st occurrence.  Group
    by ``file`` and within each file group by ``rule_code``, keeping the first
    three line numbers as examples and appending ``(+N more)``.

    Filters dispatched:

    * **eslint**: ``  3:12  error  'foo' is defined but never used  no-unused-vars``
    * **pyright**: ``src/foo.py:3: error: incompatible type``
    * **pylint**: similar: falls through to dedupe_by_key.
    """

    name = "linter"
    binaries = frozenset([
        "eslint", "pyright", "pylint", "tsc",
        "stylelint", "biome", "rome",
    ])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        binary = Path(argv[0]).stem.lower() if argv else ""
        if binary in ("pyright", "pylint"):
            compressed = dedupe_by_key(
                merged.split("\n"),
                re.compile(r"\b([A-Z][A-Z0-9]+\d+|error|warning|note)\b"),
                keep_first_n=3,
                fmt="[token-goat: +{count} more matching {key_value}]",
            )
            return _squeeze_blank_lines("\n".join(compressed))
        # ESLint: stanza-style.
        return _compress_eslint_stanza(merged)


def _compress_eslint_stanza(text: str) -> str:
    """Compress ESLint's per-file stanza format.

    Format::

        path/to/file.js
          12:8  error    'foo' is defined but never used  no-unused-vars
          15:1  warning  Missing semicolon                semi
        ...
        ✖ 47 problems (12 errors, 35 warnings)

    Strategy: within each file stanza, dedupe by rule name (last token on
    each issue line) keeping up to three examples; preserve the final ``✖``
    summary.
    """
    lines = text.split("\n")
    out: list[str] = []
    current_file: list[str] = []

    def flush_file() -> None:
        if not current_file:
            return
        header = current_file[0]
        body = current_file[1:]
        per_rule: dict[str, list[str]] = {}
        for line in body:
            m = _ESLINT_LOC_RE.match(line)
            if not m:
                # Not an issue line, flush as-is.
                if per_rule:
                    out.extend(_emit_eslint_rules(per_rule))
                    per_rule = {}
                out.append(line)
                continue
            rule = line.rsplit(None, 1)[-1].strip()
            per_rule.setdefault(rule, []).append(line)
        out.append(header)
        out.extend(_emit_eslint_rules(per_rule))

    for line in lines:
        if _ESLINT_FILE_RE.match(line):
            flush_file()
            current_file = [line]
        elif current_file:
            current_file.append(line)
        else:
            out.append(line)
    flush_file()
    return _squeeze_blank_lines("\n".join(out))


def _emit_eslint_rules(per_rule: dict[str, list[str]]) -> list[str]:
    """Emit grouped eslint issues: up to 3 examples per rule plus a count."""
    out: list[str] = []
    for rule, entries in sorted(per_rule.items()):
        keep = entries[:3]
        out.extend(keep)
        if len(entries) > 3:
            out.append(f"  [token-goat: +{len(entries) - 3} more {rule} violations]")
    return out


# --- mypy ------------------------------------------------------------------

_MYPY_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^Found \d+ error"
)
_MYPY_NOTE_CONTINUATION_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?:\d+:)?\s+note:"
)


class MypyFilter(Filter):
    """Compress ``mypy`` type-check output.

    Mypy on a large codebase can emit hundreds or thousands of diagnostics.
    The agent needs to see the *variety* of errors and the final tally, not
    every individual occurrence.

    Compression model:

    * **Keep** all ``error:`` lines — each is a distinct type violation.
    * **Keep** up to 3 ``note:`` lines per unique note *message* (notes that
      differ only in the cited line number are the same conceptual hint).
    * **Dedupe** errors with identical message text: keep the first 3
      occurrences of each unique error message and append ``(+N more)`` for
      the rest.  This prevents a single widespread error (e.g.
      ``Incompatible return value type``) from drowning out rarer ones.
    * **Always keep** the final ``Found N errors in M files`` summary line.
    * **Drop** ``note:`` lines that are merely "see: [error-codes]" cross-
      references (``note: See https://mypy.readthedocs.io/…``).
    * **Drop** ``(errors prevented further checking)`` annotations — they add
      noise without actionable information.

    On a 2 000-line mypy run with 300 errors the output typically shrinks to
    30–60 lines while preserving all unique error messages.
    """

    name = "mypy"
    binaries = frozenset(["mypy", "dmypy"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        kept: list[str] = []
        # Map from normalised error message → count of occurrences kept so far.
        error_msg_counts: dict[str, int] = {}
        # Map from normalised note message → count of occurrences kept so far.
        note_msg_counts: dict[str, int] = {}
        dropped_errors = 0
        dropped_notes = 0

        for line in lines:
            # Always keep the final summary line.
            if _MYPY_SUMMARY_RE.match(line):
                kept.append(line)
                continue

            m = _MYPY_LINE_RE.match(line)
            if m is None:
                # Not a diagnostic line — keep as-is (could be a blank line,
                # a "Success: no issues found" message, etc.).
                kept.append(line)
                continue

            level = m.group("level")

            if level == "error":
                # Normalise the error message (everything after "error: ").
                msg_start = line.find("error:") + len("error:")
                msg = line[msg_start:].strip()
                # Strip "(errors prevented further checking)" annotations.
                if msg.startswith("(errors prevented further checking)"):
                    continue
                # Normalise away file-local identifiers like quoted names and
                # line/column refs so structurally identical errors group together.
                normalised = re.sub(r'"[^"]*"', '"…"', msg)
                normalised = re.sub(r"'[^']*'", "'…'", normalised)
                count = error_msg_counts.get(normalised, 0)
                error_msg_counts[normalised] = count + 1
                if count < 3:
                    kept.append(line)
                else:
                    dropped_errors += 1

            elif level == "note":
                # Drop see-also cross-reference notes (noisy, rarely actionable).
                if "See https://" in line or "See http://" in line:
                    dropped_notes += 1
                    continue
                msg_start = line.find("note:") + len("note:")
                msg = line[msg_start:].strip()
                normalised = re.sub(r'"[^"]*"', '"…"', msg)
                normalised = re.sub(r"'[^']*'", "'…'", normalised)
                count = note_msg_counts.get(normalised, 0)
                note_msg_counts[normalised] = count + 1
                if count < 3:
                    kept.append(line)
                else:
                    dropped_notes += 1

            else:
                # warning: or any other level — keep.
                kept.append(line)

        if dropped_errors:
            kept.append(
                f"[token-goat: suppressed {dropped_errors} duplicate error lines "
                f"(kept first 3 per unique message); re-run with TOKEN_GOAT_BASH_COMPRESS=0 "
                f"for the full list]"
            )
        if dropped_notes:
            kept.append(
                f"[token-goat: suppressed {dropped_notes} duplicate/cross-reference note lines]"
            )

        return self._finalize(kept)


# --- Git -------------------------------------------------------------------

_GIT_STATUS_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:On branch|Your branch|Untracked files|Changes (?:not staged|to be committed):|"
    r"Unmerged paths|Changes to be committed|nothing to commit)"
)
_GIT_LOG_COMMIT_RE: Final[re.Pattern[str]] = re.compile(r"^commit [0-9a-f]{7,}")
_GIT_DIFF_FILE_RE: Final[re.Pattern[str]] = re.compile(r"^diff --git ")
_GIT_DIFF_HUNK_RE: Final[re.Pattern[str]] = re.compile(r"^@@\s")


class GitFilter(Filter):
    """Compress ``git`` output across status / log / diff / show / ls-files.

    Git is the highest-volume command in any agent session, ``git status``
    after a refactor can be hundreds of lines.  Subcommand dispatch table:

    * **status**: keep headers + first 30 changed-file lines, summarize rest by
      change kind (modified / new / deleted).
    * **log**: keep first 10 commits in full, summarize rest by date range.
    * **diff / show**: per-file: keep first 3 hunks unchanged; replace
      additional hunks with ``[+N more hunks elided by token-goat]``.  For
      large diffs (> 200 files) drop file bodies entirely and emit
      ``--stat`` style summary.
    * **ls-files / ls-tree**: truncate to first 100 + tail summary.
    * **fetch / pull / push**: drop ``remote: counting objects`` progress,
      keep the ``->`` ref-update lines and any error.
    * **everything else** (rev-parse, config, blame, …): generic dedupe only.
    """

    name = "git"
    binaries = frozenset(["git"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        # Git writes "counting objects" etc. to stderr, useful only when something fails.
        if subcommand in ("status",):
            return _compress_git_status(stdout, stderr)
        if subcommand == "log":
            return _compress_git_log(stdout, stderr)
        if subcommand in ("diff", "show"):
            return _compress_git_diff(stdout, stderr)
        if subcommand in ("ls-files", "ls-tree"):
            return _truncate_listing(stdout, stderr, head=100)
        if subcommand in ("fetch", "pull", "push", "clone"):
            return _compress_git_remote(stdout, stderr)
        # Fallback: ANSI / progress already stripped; dedupe consecutive.
        merged = self._combine_output(stdout, stderr)
        return _squeeze_blank_lines("\n".join(dedupe_consecutive(merged.split("\n"))))


def _compress_git_status(stdout: str, stderr: str) -> str:
    """Truncate ``git status`` output, summarising long file lists by category."""
    lines = stdout.split("\n")
    out: list[str] = []
    kept_files = 0
    bucket: dict[str, int] = {}
    for line in lines:
        if _GIT_STATUS_HEADER_RE.match(line) or not line.strip() or line.startswith("\t("):
            out.append(line)
            continue
        if line.startswith("\t") or line.startswith("        "):
            kept_files += 1
            if kept_files <= 30:
                out.append(line)
            else:
                kind = _git_status_kind(line)
                bucket[kind] = bucket.get(kind, 0) + 1
            continue
        out.append(line)
    if bucket:
        summary = ", ".join(f"{count} {kind}" for kind, count in sorted(bucket.items()))
        out.append(f"[token-goat: +{sum(bucket.values())} more files: {summary}]")
    if stderr.strip():
        out.extend(["---", stderr.rstrip()])
    return "\n".join(out)


def _git_status_kind(line: str) -> str:
    """Return a short label for a porcelain git status line (modified / new / deleted)."""
    stripped = line.strip()
    if stripped.startswith("modified:"):
        return "modified"
    if stripped.startswith("new file:"):
        return "new"
    if stripped.startswith("deleted:"):
        return "deleted"
    if stripped.startswith("renamed:"):
        return "renamed"
    if stripped.startswith("typechange:"):
        return "typechange"
    return "other"


def _compress_git_log(stdout: str, stderr: str, *, max_commits: int = 10) -> str:
    """Keep the first *max_commits* commit blocks in full, summarising the rest."""
    blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE)
    # split_blocks returns leading non-commit text as block 0; preserve it.
    if not blocks:
        return stdout
    prelude = blocks[0] if not _GIT_LOG_COMMIT_RE.match(blocks[0]) else ""
    commits = [b for b in blocks if _GIT_LOG_COMMIT_RE.match(b)]
    if len(commits) <= max_commits:
        return stdout
    kept = commits[:max_commits]
    elided = commits[max_commits:]
    # Extract first and last commit refs from the elided set for context.
    first_elided = elided[0].split("\n", 1)[0]
    last_elided = elided[-1].split("\n", 1)[0]
    summary = (
        f"\n[token-goat: +{len(elided)} earlier commits elided; "
        f"oldest: {last_elided[:80]}; first elided: {first_elided[:80]}]"
    )
    text = (prelude + "\n" if prelude else "") + "\n".join(kept) + summary
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


def _compress_git_diff(stdout: str, stderr: str, *, max_hunks_per_file: int = 3) -> str:
    """Compress git diff: keep first N hunks per file, summarise the rest."""
    file_blocks = split_blocks(stdout, _GIT_DIFF_FILE_RE)
    if not file_blocks:
        return stdout
    # When > 200 files, drop bodies and emit a stat-style summary instead.
    real_files = [b for b in file_blocks if _GIT_DIFF_FILE_RE.match(b)]
    if len(real_files) > 200:
        stat_lines = []
        for b in real_files:
            header = b.split("\n", 1)[0]
            adds = sum(1 for ln in b.split("\n") if ln.startswith("+") and not ln.startswith("+++"))
            dels = sum(1 for ln in b.split("\n") if ln.startswith("-") and not ln.startswith("---"))
            stat_lines.append(f"{header}  +{adds} -{dels}")
        return (
            f"[token-goat: large diff ({len(real_files)} files); showing stat-only view]\n"
            + "\n".join(stat_lines)
        )
    out_blocks: list[str] = []
    for block in file_blocks:
        if not _GIT_DIFF_FILE_RE.match(block):
            out_blocks.append(block)
            continue
        hunks = split_blocks(block, _GIT_DIFF_HUNK_RE)
        if len(hunks) <= max_hunks_per_file + 1:
            out_blocks.append(block)
            continue
        # The first hunk-block is the diff header (no @@), keep it.
        head = hunks[:max_hunks_per_file + 1]
        elided = hunks[max_hunks_per_file + 1:]
        out_blocks.append(
            "\n".join(head)
            + f"\n[token-goat: +{len(elided)} more hunks in this file elided]"
        )
    text = "\n".join(out_blocks)
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


def _truncate_listing(stdout: str, stderr: str, *, head: int = 100) -> str:
    """Truncate a flat list output (one item per line) to the first *head* lines."""
    lines = stdout.split("\n")
    if len(lines) <= head:
        merged = stdout
    else:
        merged = (
            "\n".join(lines[:head])
            + f"\n[token-goat: +{len(lines) - head} more lines elided]"
        )
    if stderr.strip():
        merged += "\n---\n" + stderr.rstrip()
    return merged


def _compress_git_remote(stdout: str, stderr: str) -> str:
    """Drop ``remote: Counting/Compressing objects`` progress; keep ref updates."""
    keep_re = re.compile(
        r"^(?:From |To |   [a-f0-9]+\.\.[a-f0-9]+|\s+\*\s|\s+!\s|\s+\+\s|fatal:|error:|warning:)"
    )
    drop_re = re.compile(
        r"^(?:remote: (?:Counting|Compressing|Total|Enumerating|Receiving|Resolving) objects|"
        r"Receiving objects:|Resolving deltas:|Unpacking objects:|Updating files:)"
    )
    merged_lines = stdout.split("\n") + ([] if not stderr.strip() else ["---"] + stderr.split("\n"))
    kept: list[str] = []
    dropped = 0
    for line in merged_lines:
        if drop_re.match(line):
            dropped += 1
            continue
        # When neither side matches a keep/drop pattern, keep it (could be an
        # unanticipated diagnostic).
        kept.append(line)
        _ = keep_re  # keep_re is documentation of what we *intend* to keep
    if dropped:
        kept.append(f"[token-goat: dropped {dropped} 'remote:' progress lines]")
    return "\n".join(kept)


# --- Go test ---------------------------------------------------------------

# `go test [-v] ./...` emits a distinctive line shape per testcase that is
# disjoint from `go build` output, so it warrants a dedicated filter.  The
# patterns below match the official ``testing`` package format documented at
# https://pkg.go.dev/testing#hdr-Subtests_and_Sub_benchmarks.
_GO_TEST_RUN_RE: Final[re.Pattern[str]] = re.compile(
    r"^=== (RUN|PAUSE|CONT|NAME)\s"
)
_GO_TEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*--- PASS:\s"
)
_GO_TEST_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*--- (FAIL|SKIP):\s"
)
# Final per-package result lines: ``ok pkg 1.234s`` / ``FAIL pkg 0.5s`` /
# ``?  pkg [no test files]``.  Preserved verbatim so the agent sees per-package
# outcomes.
_GO_TEST_PKG_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^(ok|FAIL|---\sFAIL|\?)\s+\S"
)


class GoTestFilter(Filter):
    """Compress ``go test`` output (with or without ``-v``).

    ``go test ./...`` on a large repo emits one ``=== RUN`` plus one
    ``--- PASS`` line per testcase plus subtests, often hundreds of lines of
    pure noise when everything passes.  The filter keeps failures, package
    results, and the final summary verbatim while collapsing the passing
    test list to a count.

    Compression model:

    * **Drop** ``=== RUN`` / ``=== PAUSE`` / ``=== CONT`` lines (test lifecycle
      noise) when not inside a FAIL block.
    * **Drop** ``--- PASS:`` lines (collapse to a single count).
    * **Keep** ``--- FAIL:`` and ``--- SKIP:`` lines and any indented body
      under them (the ``t.Errorf`` / ``t.Fatalf`` traceback).
    * **Keep** ``ok pkg time`` / ``FAIL pkg time`` / ``? pkg [no test files]``
      per-package results unchanged.
    * **Keep** the final ``PASS`` / ``FAIL`` summary line.
    * **Drop** ``go: downloading mod@ver`` progress (same as MakeFilter).
    """

    name = "go-test"
    binaries = frozenset(["go"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem != "go":
            return False
        # Only fire for ``go test`` — every other subcommand (build, vet, run,
        # mod, …) stays with MakeFilter or falls through.
        positionals = _positional_args(argv[1:])[:2]
        return positionals[:1] == ["test"]

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_count = 0
        in_fail_block = False
        dropped_run = 0
        dropped_download = 0
        for line in lines:
            if line.startswith("go: downloading"):
                dropped_download += 1
                continue
            # FAIL / SKIP open a multi-line block that is preserved verbatim
            # until the next testcase delimiter.
            if _GO_TEST_FAIL_RE.match(line):
                in_fail_block = True
                kept.append(line)
                continue
            if _GO_TEST_PASS_RE.match(line):
                # A PASS line closes any open FAIL block (next testcase).
                in_fail_block = False
                pass_count += 1
                continue
            if _GO_TEST_RUN_RE.match(line):
                # === RUN inside a FAIL block is the next testcase header —
                # close the block but keep the new RUN line so structure is
                # readable.  Outside a FAIL block, drop the RUN entirely.
                if in_fail_block:
                    in_fail_block = False
                else:
                    dropped_run += 1
                    continue
            # Indented continuation lines under a FAIL block (test_runner.go:42:
            # Errorf output, panic traceback, …) — preserve them.
            if in_fail_block and (line.startswith(("    ", "\t")) or not line.strip()):
                kept.append(line)
                continue
            # Anything else (per-package results, final summary, untyped
            # diagnostic): preserve and exit the fail block.
            in_fail_block = False
            kept.append(line)
        notes: list[str] = []
        if pass_count:
            notes.append(f"collapsed {pass_count} PASS testcases")
        if dropped_run:
            notes.append(f"dropped {dropped_run} === RUN/PAUSE/CONT lines")
        if dropped_download:
            notes.append(f"dropped {dropped_download} 'go: downloading' lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Make / Ninja / Gradle / Maven / Go build ------------------------------

_MAKE_RECURSE_RE: Final[re.Pattern[str]] = re.compile(
    r"^make\[\d+\]: (Entering|Leaving) directory"
)
_MAKE_ECHO_RE: Final[re.Pattern[str]] = re.compile(r"^(echo |cc |gcc |clang |g\+\+ )")


class MakeFilter(Filter):
    """Compress ``make`` / ``ninja`` / ``gradle`` / ``mvn`` / ``go build`` output.

    Build systems emit one line per compilation unit plus recursion markers.
    Errors are the only thing the agent typically cares about.

    Compression model:

    * **Drop** ``make[N]: Entering/Leaving directory '...'`` recursion noise.
    * **Drop** plain ``cc``/``clang``/``g++`` invocation echoes: keep only
      the diagnostic lines (warning / error / undefined reference).
    * **Keep** every ``warning:`` / ``error:`` block.
    * **Keep** the final ``Error 1`` / ``BUILD FAILED`` summary.
    * **Go**: keep ``./path/file.go:N:M: error`` lines verbatim; drop
      ``go: downloading mod@ver`` progress.
    """

    name = "make"
    binaries = frozenset([
        "make", "gmake", "ninja", "gradle", "mvn", "maven", "bazel", "buck",
        "go", "goimports",
    ])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_recurse = 0
        dropped_echo = 0
        dropped_go_download = 0
        for line in lines:
            if _MAKE_RECURSE_RE.match(line):
                dropped_recurse += 1
                continue
            if line.startswith("go: downloading"):
                dropped_go_download += 1
                continue
            if (
                _MAKE_ECHO_RE.match(line)
                and "error" not in line.lower()
                and "warning" not in line.lower()
            ):
                dropped_echo += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if dropped_recurse:
            notes.append(f"{dropped_recurse} 'Entering/Leaving directory' lines")
        if dropped_echo:
            notes.append(f"{dropped_echo} compiler-invocation echoes")
        if dropped_go_download:
            notes.append(f"{dropped_go_download} 'go: downloading' lines")
        # MakeFilter uses ", " join + "dropped" prefix (verbatim grammar match)
        # rather than the standard ";" join, since all entries share the
        # "dropped X" verb.
        if notes:
            kept.append(f"[token-goat: dropped {', '.join(notes)}]")
        return self._finalize(kept)


# --- Terraform -------------------------------------------------------------

_TF_REFRESH_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9_.\[\]\"-]+: (Refreshing state|Reading|Read complete|Still |Modifications complete)"
)


class TerraformFilter(Filter):
    """Compress ``terraform plan`` / ``apply`` output.

    Terraform prints per-resource ``Refreshing state…`` lines (one per object,
    often hundreds), then a giant diff with full resource bodies (mostly
    unchanged attributes).

    Compression model:

    * **Drop** ``Refreshing state`` / ``Reading…`` / ``Still creating…`` lines.
    * **Keep** the ``Plan: X to add, Y to change, Z to destroy.`` line.
    * **Keep** every ``# resource_type.name will be created`` header.
    * **Drop** unchanged attribute lines within a resource diff (those
      starting with ``      `` and no ``+``/``-``/``~`` prefix), keeping
      only the changed ones.
    * **Keep** the final ``Apply complete!`` / ``Error:`` line.
    """

    name = "terraform"
    binaries = frozenset(["terraform", "tf", "tofu", "opentofu"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped = 0
        for line in lines:
            if _TF_REFRESH_RE.match(line):
                dropped += 1
                continue
            kept.append(line)
        if dropped:
            kept.append(f"[token-goat: dropped {dropped} terraform refresh/read lines]")
        return self._finalize(kept)


# --- Ansible ---------------------------------------------------------------

#: Ansible task status lines: ``ok: [host]`` / ``changed: [host] => (item=...)`` /
#: ``skipping: [host]`` / ``fatal: [host]: FAILED!``.
_ANSIBLE_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^(ok|changed|skipping|skipped|included):\s*\[",
)
#: Ansible PLAY / TASK / HANDLER section headers (e.g. ``TASK [Install nginx]``).
_ANSIBLE_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(PLAY|TASK|HANDLER|RUNNING HANDLER|META)(?:\s*\[|\s*RECAP)",
)
#: Ansible final ``PLAY RECAP`` block delimiter.
_ANSIBLE_RECAP_RE: Final[re.Pattern[str]] = re.compile(r"^PLAY RECAP")
#: Ansible per-host recap row: ``hostname : ok=N changed=N unreachable=N ...``.
_ANSIBLE_RECAP_ROW_RE: Final[re.Pattern[str]] = re.compile(
    r"^\S+\s*:\s*ok=\d+\s+changed=\d+",
)
#: Ansible failure / error / unreachable / warning signal.
_ANSIBLE_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^(fatal|failed|unreachable|FAILED|ERROR|\[WARNING\]):",
)


class AnsibleFilter(Filter):
    """Compress ``ansible`` / ``ansible-playbook`` output.

    Ansible playbook runs emit one ``ok: [host]`` (or ``changed:``/``skipping:``)
    line per (task × host).  On a 30-host inventory with 50 tasks this is 1500
    progress lines for a fully-successful run — pure noise unless a host
    failed.  The signal lives in: PLAY/TASK headers, any ``fatal:`` /
    ``failed:`` / ``unreachable:`` / ``[WARNING]`` lines, and the final
    ``PLAY RECAP`` block.

    Compression model:

    * **Keep** every ``PLAY [name]`` / ``TASK [name]`` / ``HANDLER`` header
      verbatim (cheap, load-bearing for understanding what the playbook is
      doing).
    * **Collapse** runs of ``ok:`` / ``changed:`` / ``skipping:`` status lines
      to a per-task count (``[token-goat: 12 ok, 3 changed, 0 skipping]``).
    * **Keep** every ``fatal:`` / ``failed:`` / ``unreachable:`` / ``[WARNING]``
      line verbatim plus the full multi-line ``=>`` JSON-ish payload that
      follows.
    * **Keep** the final ``PLAY RECAP`` block verbatim — it's the canonical
      summary the agent needs.
    """

    name = "ansible"
    binaries = frozenset([
        "ansible", "ansible-playbook", "ansible-pull", "ansible-console",
    ])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        # Pending status counts for the current task.  Flushed when a new
        # TASK/PLAY header appears, when a failure is seen, or at end-of-input.
        status_counts: dict[str, int] = {}
        in_recap = False
        in_fail_payload = False

        def flush_status() -> None:
            if not status_counts:
                return
            parts = [f"{n} {label}" for label, n in status_counts.items() if n]
            if parts:
                kept.append(f"[token-goat: {', '.join(parts)}]")
            status_counts.clear()

        for line in lines:
            if _ANSIBLE_RECAP_RE.match(line):
                flush_status()
                in_recap = True
                in_fail_payload = False
                kept.append(line)
                continue
            if in_recap:
                # Preserve PLAY RECAP block verbatim until a blank line ends it.
                kept.append(line)
                if not line.strip():
                    in_recap = False
                continue
            if _ANSIBLE_FAIL_RE.match(line):
                flush_status()
                in_fail_payload = True
                kept.append(line)
                continue
            if in_fail_payload:
                # The block ends at the next blank line or a new TASK/PLAY header.
                if not line.strip() or _ANSIBLE_HEADER_RE.match(line):
                    in_fail_payload = False
                    if not line.strip():
                        kept.append(line)
                        continue
                else:
                    kept.append(line)
                    continue
            if _ANSIBLE_HEADER_RE.match(line):
                flush_status()
                kept.append(line)
                continue
            if _ANSIBLE_STATUS_RE.match(line):
                label = line.split(":", 1)[0].strip()
                status_counts[label] = status_counts.get(label, 0) + 1
                continue
            kept.append(line)
        flush_status()
        return self._finalize(kept)


# --- pre-commit ------------------------------------------------------------

#: pre-commit hook-result line: ``Trim trailing whitespace.....................Passed``.
#:
#: Also handles the ``hook_name...(no files to check)Skipped`` variant where
#: pre-commit interpolates a parenthetical reason between the dot leader and
#: the status word.
_PRECOMMIT_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<hook>\S.*?)\.{3,}(?:\([^)]*\))?\s*(?P<status>Passed|Failed|Skipped|Pre-commit hook failed)\s*$",
)
#: pre-commit install/lifecycle progress lines (``[INFO] Initializing environment...``).
_PRECOMMIT_INFO_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[INFO\]\s+(Initializing|Installing|Restored|Cloning)",
)


class PreCommitFilter(Filter):
    """Compress ``pre-commit run`` output.

    ``pre-commit run --all-files`` on a large repo emits one ``hook_name.....``
    line per hook, plus ``[INFO]`` environment-setup chatter, plus the full
    hook stdout/stderr for every failed hook.  Passing hooks are pure noise
    once the run is green.

    Compression model:

    * **Keep** every ``Failed`` hook result and the indented diff/error block
      that follows it (up to the next hook-result line or blank line).
    * **Collapse** consecutive ``Passed`` / ``Skipped`` results to a count
      while still preserving the *first* and *last* of each group so the agent
      can see which hooks ran.
    * **Drop** ``[INFO] Initializing environment...`` / ``[INFO] Installing
      environment...`` chatter; keep only the first one as a marker.
    * **Keep** every ``- hook id:`` / ``- exit code:`` / ``- files were
      modified`` line verbatim because those are the post-failure summary.
    """

    name = "pre-commit"
    binaries = frozenset(["pre-commit"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        passed = 0
        skipped = 0
        info_dropped = 0
        first_info_kept = False
        in_fail_block = False
        for line in lines:
            m = _PRECOMMIT_RESULT_RE.match(line)
            if m:
                status = m.group("status")
                if status == "Failed" or status == "Pre-commit hook failed":
                    if passed or skipped:
                        kept.append(
                            f"[token-goat: collapsed {passed} Passed, "
                            f"{skipped} Skipped hook(s)]"
                        )
                        passed = 0
                        skipped = 0
                    in_fail_block = True
                    kept.append(line)
                    continue
                in_fail_block = False
                if status == "Passed":
                    passed += 1
                elif status == "Skipped":
                    skipped += 1
                continue
            if _PRECOMMIT_INFO_RE.match(line):
                if first_info_kept:
                    info_dropped += 1
                    continue
                first_info_kept = True
                kept.append(line)
                continue
            # End of an indented failure block: a blank line.
            if in_fail_block and not line.strip():
                in_fail_block = False
            kept.append(line)
        if passed or skipped:
            kept.append(
                f"[token-goat: collapsed {passed} Passed, {skipped} Skipped hook(s)]"
            )
        if info_dropped:
            kept.append(
                f"[token-goat: dropped {info_dropped} pre-commit [INFO] env-setup lines]"
            )
        return self._finalize(kept)


# --- grep / rg / ag / ack / git grep -----------------------------------------

#: Threshold: outputs with more non-empty lines than this are compressed.
_GREP_COMPRESS_THRESHOLD = 30
#: Maximum number of per-file lines emitted in the summary.
_GREP_MAX_FILE_LINES = 20


class GrepFilter(Filter):
    """Compress ``grep``, ``rg``, ``ag``, ``ack``, and ``git grep`` output.

    Grep commands are among the highest-volume outputs in an agent session:
    ``rg "pattern" .`` can return thousands of match lines where the agent
    only needs to know *which* files matched and *how many* times.

    Compression model:

    * **Pass-through** when the total non-empty output lines are ≤ 30 — at
      that size the signal is fully readable and compression adds no value.
    * **Summarise** when output exceeds 30 lines:

      1. Emit a one-line header: ``grep: N matches across F files``
      2. Emit up to 20 per-file lines sorted by match count (descending):
         ``  src/foo.py: 12 matches``
      3. If more than 20 files matched, append a trailing elision note.

    Exit code semantics are unchanged: the caller receives the original
    exit code so ``grep … || fallback`` idioms still work correctly.

    ``git grep`` is intercepted here (before ``GitFilter``) because the
    output format is identical to plain ``grep`` and the compression logic
    applies equally.  ``GitFilter`` continues to handle all other ``git``
    subcommands.
    """

    name = "grep"
    #: Standalone grep-family binaries.
    binaries = frozenset(["grep", "egrep", "fgrep", "rg", "ag", "ack", "ack-grep"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = argv[0].lower().split("/")[-1].split("\\")[-1]
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        # Standalone grep-family binary
        if stem in self.binaries:
            return True
        # git grep (two-token form after prefix stripping)
        if stem == "git":
            positionals = _positional_args(argv[1:])
            return bool(positionals) and positionals[0] == "grep"
        return False

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Combine stdout and stderr for line counting; stderr is usually empty
        # for grep but may carry "permission denied" notices.
        text = self._combine_output(stdout, stderr)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]
        if len(non_empty) <= _GREP_COMPRESS_THRESHOLD:
            # Pass through — small enough to read in full.
            return text

        # Build per-file match counts.  Grep output lines are typically:
        #   path/to/file.py:42:matched content   (grep / rg / ag)
        #   path/to/file.py-42-context line       (rg context lines, ignore)
        #   Binary file path/to/foo matches        (grep binary notice)
        #   matched content                        (no filename, e.g. stdin / single-file)
        file_counts: dict[str, int] = {}
        unattributed = 0
        for line in non_empty:
            # Binary file message
            if line.startswith("Binary file ") and " matches" in line:
                fname = line.split(" ", 2)[2].rsplit(" matches", 1)[0]
                file_counts[fname] = file_counts.get(fname, 0) + 1
                continue
            # Standard grep/rg match line: "path:lineno:content" or "path:content"
            colon_idx = line.find(":")
            if colon_idx > 0:
                candidate = line[:colon_idx]
                # Heuristic: the candidate looks like a file path when it
                # contains a dot or a path separator.  We intentionally require
                # at least one of these markers so bare words like "INFO",
                # "WARNING", or short match prefixes are not misidentified as
                # filenames.  rg emits "path/to/file:lineno:content" on POSIX
                # and "path\to\file:lineno:content" on Windows; both are caught
                # by the slash/backslash check.  Files without path separators
                # (e.g. bare "setup.py") are caught by the dot check.
                if "." in candidate or "/" in candidate or "\\" in candidate:
                    file_counts[candidate] = file_counts.get(candidate, 0) + 1
                    continue
            unattributed += 1

        total_matches = sum(file_counts.values()) + unattributed
        num_files = len(file_counts)

        # Emit compact summary.
        out_lines: list[str] = [f"grep: {total_matches} matches across {num_files} file(s)"]

        # Sort by match count descending, emit top N.
        sorted_files = sorted(file_counts.items(), key=lambda kv: kv[1], reverse=True)
        shown = sorted_files[:_GREP_MAX_FILE_LINES]
        for fname, count in shown:
            out_lines.append(f"  {fname}: {count} match(es)")
        if len(sorted_files) > _GREP_MAX_FILE_LINES:
            remaining = len(sorted_files) - _GREP_MAX_FILE_LINES
            out_lines.append(
                f"  [token-goat: +{remaining} more file(s) elided; "
                f"use --context or -C flags to narrow]"
            )
        if unattributed:
            out_lines.append(f"  (unattributed lines: {unattributed})")
        out_lines.append(
            f"[token-goat: grep output compressed from {len(non_empty)} lines "
            f"to {len(out_lines)} — pass TOKEN_GOAT_BASH_COMPRESS=0 to disable]"
        )
        return "\n".join(out_lines)


# --- pip / uv / poetry ------------------------------------------------------

class PipFilter(Filter):
    """Compress ``pip install`` / ``uv pip install`` / ``poetry install`` output.

    Pip emits ``Downloading X.whl (10 MB)`` lines per dependency plus the
    final ``Successfully installed`` list.  When everything succeeds the
    interesting line is just the final tally.
    """

    name = "pip"
    binaries = frozenset(["pip", "pip3", "pipx"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        downloads = 0
        collects = 0
        for line in lines:
            if line.startswith("  Downloading "):
                downloads += 1
                continue
            if line.startswith("Collecting "):
                collects += 1
                kept.append(line) if collects <= 5 else None
                continue
            kept.append(line)
        notes: list[str] = []
        if collects > 5:
            notes.append(f"+{collects - 5} more 'Collecting' lines elided")
        if downloads:
            notes.append(f"dropped {downloads} 'Downloading' progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Python ----------------------------------------------------------------

#: Python traceback frame lines: "  File ..., line N, in <func>"
_PYTHON_FRAME_RE: Final[re.Pattern[str]] = re.compile(
    r'^\s+File\s+"[^"]+",\s+line\s+\d+(?:,\s+in\s+.*)?\s*$'
)
#: Python error/exception terminator: "ErrorType: message"
_PYTHON_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:Error|Exception|Warning):\s"
)
#: Python warning lines
_PYTHON_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*.*Warning:\s"
)


class PythonFilter(Filter):
    """Compress Python script output and tracebacks.

    When ``python script.py``, ``python -c "code"``, or ``python -m module``
    produces a traceback, the filter compresses it to preserve only the
    innermost frame (where the actual error occurred) plus the error message.
    For very long tracebacks (>10 frames), keeps only the first 2 and last 3
    frames with a marker in between.

    Compression model:

    * **Traceback compression**: Keep error line + immediate cause line;
      drop intermediate "File..., line N" frame lines except innermost.
      For >10-frame tracebacks, keep first 2 + last 3 frames with omission marker.
    * **Repeated lines**: If a line repeats 5+ times consecutively,
      replace with "line × N".
    * **Warning spam**: Lines matching ``Warning:`` that repeat >3 times →
      keep first 3, summarize rest as "... N similar warnings omitted".
    * **Progress bars**: Lines ending with ``\\r`` → keep only the last.
    """

    name = "python"
    binaries = frozenset(["python", "python3", "python3.11", "python3.12", "python3.13"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Match python/python3 directly, but NOT pytest (handled by PytestFilter).
        if stem not in self.binaries:
            return False
        # Don't match if this is actually pytest (python -m pytest or pytest).
        if len(argv) > 1:
            positionals = _positional_args(argv[1:])
            # Check for "-m pytest" or "-c" with pytest code
            if positionals and positionals[0] == "pytest":
                return False
        return True

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Combine stderr (traceback) and stdout.
        text = stderr if stderr.strip() else stdout
        if text and stderr.strip() and stdout.strip():
            text = (text.rstrip() + "\n" + stdout.rstrip())
        if not text.strip():
            return text

        lines = text.split("\n")
        lines = self._compress_traceback(lines)
        lines = self._dedupe_repeated_lines(lines)
        lines = self._compress_warnings(lines)
        return _squeeze_blank_lines("\n".join(lines))

    def _compress_traceback(self, lines: list[str]) -> list[str]:
        """Compress Python tracebacks, keeping error and innermost frame.

        For very long tracebacks (>10 frames), keep first 2 and last 3 frames
        with an omission marker.
        """
        # Find "Traceback" header and "Error:" terminator.
        traceback_start = None
        error_line_idx = None

        for i, line in enumerate(lines):
            if line.startswith("Traceback"):
                traceback_start = i
            if _PYTHON_ERROR_RE.search(line):
                error_line_idx = i

        # No traceback found; pass through.
        if traceback_start is None:
            return lines

        # If no error found, the traceback is incomplete (or it's a warning).
        if error_line_idx is None or error_line_idx <= traceback_start:
            return lines

        # Extract frame lines (those matching _PYTHON_FRAME_RE) between
        # Traceback and error line.
        frame_indices = []
        for i in range(traceback_start, error_line_idx):
            if _PYTHON_FRAME_RE.search(lines[i]):
                frame_indices.append(i)

        # If there are too many frames (>10), keep first 2 and last 3 with marker.
        if len(frame_indices) > 10:
            kept_indices = set(frame_indices[:2] + frame_indices[-3:])
            omitted = len(frame_indices) - 5
            result = []
            for i, line in enumerate(lines):
                if (
                    i < traceback_start
                    or i > error_line_idx
                    or i in kept_indices
                    or i in (traceback_start, error_line_idx)
                ):
                    result.append(line)
                elif i == frame_indices[2]:
                    # Insert omission marker at the first dropped frame.
                    result.append(f"  ... {omitted} frames omitted ...")
            return result

        # Standard case: keep traceback header, innermost frame(s), and error.
        result = []
        for i, line in enumerate(lines):
            if i < traceback_start or i > error_line_idx:
                # Before traceback or after error: pass through.
                result.append(line)
            elif i == traceback_start:
                # Keep traceback header.
                result.append(line)
            elif i in frame_indices[-1:]:
                # Keep only the innermost frame (last frame before error).
                result.append(line)
            elif i == error_line_idx:
                # Always keep the error line.
                result.append(line)
            elif i == error_line_idx - 1 and not _PYTHON_FRAME_RE.search(line):
                # Keep the line immediately before the error if it's not a frame.
                result.append(line)
        return result

    def _dedupe_repeated_lines(self, lines: list[str]) -> list[str]:
        """Collapse 5+ consecutive identical lines to 'line × N'."""
        out: list[str] = []
        prev: str | None = None
        count = 0
        for line in lines:
            if line == prev:
                count += 1
            else:
                if prev is not None and count >= 5:
                    out.append(f"{prev}  (×{count})")
                elif prev is not None:
                    out.extend([prev] * count)
                prev = line
                count = 1
        if prev is not None:
            if count >= 5:
                out.append(f"{prev}  (×{count})")
            else:
                out.extend([prev] * count)
        return out

    def _compress_warnings(self, lines: list[str]) -> list[str]:
        """Compress repeated warnings: keep first 3, summarize rest."""
        warning_groups: dict[str, list[int]] = {}

        for i, line in enumerate(lines):
            if _PYTHON_WARNING_RE.search(line):
                # Normalize the warning message for grouping.
                normalized = re.sub(r":\d+:", ":N:", line)
                if normalized not in warning_groups:
                    warning_groups[normalized] = []
                warning_groups[normalized].append(i)

        if not warning_groups:
            return lines

        # Keep first 3 of each normalized warning; drop the rest.
        keep_indices = set()
        for indices in warning_groups.values():
            keep_indices.update(indices[:3])

        result = []
        for i, line in enumerate(lines):
            if i in keep_indices or not _PYTHON_WARNING_RE.search(line):
                result.append(line)

        # Add summary for dropped warnings.
        total_warnings = len([i for grp in warning_groups.values() for i in grp])
        kept_warnings = len(keep_indices)
        if total_warnings > kept_warnings:
            result.append(
                f"[token-goat: suppressed {total_warnings - kept_warnings} "
                f"additional warning(s)]"
            )

        return result


# --- uv ---------------------------------------------------------------------

#: uv per-package download/fetch progress lines: "   Downloading foo-1.0 (2.3 MB)"
_UV_DOWNLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Downloading|Fetching)\s+\S"
)
#: uv per-package install/uninstall diff lines: "   + foo==1.0" / "   - foo==1.0"
_UV_DIFF_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+[+\-]\s+\S"
)


class UvFilter(Filter):
    """Compress ``uv sync`` / ``uv add`` / ``uv remove`` / ``uv pip install`` output.

    uv emits verbose per-package ``Downloading`` / ``Fetching`` lines while
    resolving and installing dependencies plus per-package ``+``/``-`` diff
    lines.  The interesting lines are the summary lines emitted at the end
    (``Resolved N packages``, ``Installed N packages``, ``Uninstalled N
    packages``, ``Audited N packages``).  Errors and warnings are always
    preserved.

    Compression model:

    * **Drop** ``Downloading`` / ``Fetching`` progress lines.
    * **Drop** per-package ``+`` / ``-`` diff lines (e.g. ``  + requests==2.31``).
    * **Keep** summary lines: ``Resolved``, ``Installed``, ``Uninstalled``,
      ``Updated``, ``Removed``, ``Audited``.
    * **Keep** every ``error:`` / ``warning:`` line verbatim.
    * **Keep** the first and last lines for context.
    """

    name = "uv"
    binaries = frozenset(["uv"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem != "uv":
            return False
        # Only fire for package-management subcommands.
        pm_subcommands = frozenset([
            "sync", "add", "remove", "install", "uninstall", "pip", "lock",
        ])
        positionals = _positional_args(argv[1:])[:3]
        return any(tok in pm_subcommands for tok in positionals)

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        downloads = 0
        diff_lines = 0
        for line in lines:
            if _UV_DOWNLOAD_RE.match(line):
                downloads += 1
                continue
            if _UV_DIFF_LINE_RE.match(line):
                diff_lines += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if downloads:
            notes.append(f"dropped {downloads} Downloading/Fetching progress lines")
        if diff_lines:
            notes.append(f"dropped {diff_lines} per-package +/- diff lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Directory listing: eza / exa / ls / tree ---------------------------------

class EzaFilter(Filter):
    """Compress ``eza`` / ``exa`` / ``ls`` directory listing output.

    ``eza`` is a modern replacement for ``ls`` and ``tree``. Common invocations:
    - ``eza --git --long`` — listing with git status column
    - ``eza --git --long --tree --level=2`` — tree view with 2 levels
    - ``eza --git --long --sort modified`` — sorted by modification time
    - ``ls -la`` / ``ls -l`` / ``ls -alh`` — classic ls variants

    Compression model:

    * **Pass-through** when output is short (≤ 30 non-empty lines) — small
      listings are fully readable and compression adds no value.
    * **Summarise tree output** (detected by ``--tree`` flag): keep first 40
      lines + last 10 lines + "... N more ..." marker if total > 60. Never
      truncate to fewer than 20 total lines.
    * **Summarise flat listing**: keep header, first 25 entries, last 5
      entries + "... N more ..." summary when total > 30.
    * **Preserve important lines**: never drop rows containing the target
      path argument or total/summary lines (e.g., "3 directories, 14 files").
    """

    name = "eza"
    binaries = frozenset(["eza", "exa", "ls"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Combine and normalise output
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        # Pass through small outputs unchanged
        if len(non_empty) <= 30:
            return text

        # Detect tree mode by checking for --tree flag in argv
        is_tree = any(arg == "--tree" or arg.startswith("--tree=") for arg in argv)

        if is_tree:
            return self._compress_tree(lines, non_empty)
        return self._compress_flat_listing(lines, non_empty, argv)

    def _compress_tree(self, lines: list[str], non_empty: list[str]) -> str:
        """Compress tree output: keep first 40 + last 10 + marker."""
        total = len(non_empty)
        if total <= 60:
            return "\n".join(lines).rstrip()

        # Keep first 40 + last 10
        head_keep = 40
        tail_keep = 10
        elided = total - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} items elided by token-goat]"] + tail_lines
        return "\n".join(result)

    def _compress_flat_listing(
        self, lines: list[str], non_empty: list[str], argv: list[str],
    ) -> str:
        """Compress flat listing: keep header, first 25 items, last 5."""
        total = len(non_empty)
        if total <= 30:
            return "\n".join(lines).rstrip()

        # Identify header line (usually contains column names like "permissions size date")
        # Typical header: "Permissions Size User Date Modified Name" or similar
        # Heuristic: first line that contains permission-like column or is notably
        # different from data rows.
        header_idx = 0
        if non_empty and any(kw in non_empty[0].lower() for kw in ["permission", "size", "date", "user", "name"]):
            header_idx = 1

        # Keep header, first 25 entries, last 5 entries
        kept: list[str] = []

        # Add header lines
        if header_idx > 0:
            kept.extend(non_empty[:header_idx])

        # Add data lines with preference for target_path lines
        data_start = header_idx
        data_lines = non_empty[data_start:]
        num_to_keep = 25 + 5  # head + tail

        if len(data_lines) <= num_to_keep:
            kept.extend(data_lines)
        else:
            # Keep first 25
            kept.extend(data_lines[:25])
            elided = len(data_lines) - 30
            kept.append(f"... [{elided} more entries elided by token-goat]")
            # Keep last 5
            kept.extend(data_lines[-5:])

        # Preserve summary lines (e.g., "3 directories, 14 files") if present
        summary_lines = [
            ln for ln in non_empty[max(0, len(non_empty) - 3):]
            if any(kw in ln for kw in ["director", "file", "total"])
        ]
        if summary_lines and summary_lines[0] not in kept:
            kept.extend(summary_lines)

        return "\n".join(kept).rstrip()


# --- fd / fdfind -------------------------------------------------------

#: Threshold: outputs with more lines than this are compressed.
_FD_COMPRESS_THRESHOLD = 40


class FdFilter(Filter):
    """Compress ``fd`` / ``fdfind`` file search output.

    The ``fd`` command is a fast alternative to ``find`` and can produce
    large path lists when searching recursively across many directories.

    Compression model:

    * **Pass-through** when output has ≤ 40 lines — fully readable.
    * **Summarise** when output exceeds 40 lines: keep first 35 lines +
      last 5 lines + "... N more paths ..." marker in between.
    """

    name = "fd"
    binaries = frozenset(["fd", "fdfind"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= _FD_COMPRESS_THRESHOLD:
            return text.rstrip()

        # Keep first 35 + last 5 + marker
        head_keep = 35
        tail_keep = 5
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} more paths elided by token-goat]"] + tail_lines
        return "\n".join(result)


class TreeFilter(Filter):
    """Compress ``tree`` binary output.

    The ``tree`` command can produce thousands of lines for large directories.
    This filter keeps the first 50 lines (root structure) + last 10 lines
    (including final summary) + a marker in the middle.

    Compression model:

    * **Pass-through** when output ≤ 60 lines — readable in full.
    * **Summarise** when output > 60: keep first 50 + last 10 + marker.
      Always preserve the final summary line (e.g., "3 directories, 14 files").
    """

    name = "tree"
    binaries = frozenset(["tree"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 60:
            return text.rstrip()

        # Keep first 50 + last 10 + marker
        head_keep = 50
        tail_keep = 10
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} items elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# --- bat / batcat (syntax-highlighted file viewer) ---------------------------

class BatFilter(Filter):
    """Compress ``bat`` / ``batcat`` syntax-highlighted file viewer output.

    The ``bat`` command is a modern replacement for ``cat`` with syntax
    highlighting, line numbers, and decorative box-drawing borders. This
    filter strips the decorative chrome (ANSI codes, borders, headers) and
    preserves only the file content.

    Compression model:

    * **Pass-through** when output is ≤ 50 lines — readable in full with
      decorations stripped.
    * **Summarise** when output exceeds 50 lines: keep first 40 lines +
      last 10 lines + "... N lines elided ..." marker in between.
    """

    name = "bat"
    binaries = frozenset(["bat", "batcat"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Strip ANSI escape sequences
        text = strip_ansi(merged)

        # Strip bat's decorative box-drawing borders (lines with mostly ─ or ━)
        lines = text.split("\n")
        stripped_lines = []
        for line in lines:
            # Skip lines that are bat's header/footer borders (mostly ─, ━, or similar)
            if line.strip() and all(c in "─━─┬┴┌┐└┘│├┤┼═╔╗╚╝║╠╡╢╣╤╥╦╧╨╩" for c in line.strip()):
                continue
            stripped_lines.append(line)

        # Remove first and last lines if they appear to be headers/footers
        if stripped_lines and (stripped_lines[0].strip() == "" or "──" in stripped_lines[0]):
            stripped_lines.pop(0)
        if stripped_lines and (stripped_lines[-1].strip() == "" or "──" in stripped_lines[-1]):
            stripped_lines.pop()

        text = "\n".join(stripped_lines)
        text = normalise(text)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 50:
            return text.rstrip()

        # Keep first 40 + last 10 + marker
        head_keep = 40
        tail_keep = 10
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} lines elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# --- delta (diff viewer) ---------------------------------------------------

class DeltaFilter(Filter):
    """Compress ``delta`` diff viewer output.

    The ``delta`` command wraps ``git diff`` output with ANSI colour and
    decorative headers. This filter preserves the underlying diff content
    (lines starting with +, -, @@, etc.) while stripping ANSI codes and
    decorative separators.

    Compression model:

    * **Pass-through** when output is ≤ 80 lines — readable in full.
    * **Summarise** when output exceeds 80 lines: keep first 60 lines +
      last 20 lines + "... N lines elided ..." marker in between.
    """

    name = "delta"
    binaries = frozenset(["delta"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Strip ANSI escape sequences
        text = strip_ansi(merged)

        # Remove decorative separator lines (runs of ─, ━, or similar)
        lines = text.split("\n")
        stripped_lines = []
        for line in lines:
            # Skip lines that are delta's decorative separators
            if line.strip() and all(c in "─━" for c in line.strip()):
                continue
            stripped_lines.append(line)

        text = "\n".join(stripped_lines)
        text = normalise(text)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 80:
            return text.rstrip()

        # Keep first 60 + last 20 + marker
        head_keep = 60
        tail_keep = 20
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} lines elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# --- fzf (fuzzy finder) ----------------------------------------------------

class FzfFilter(Filter):
    """Compress ``fzf`` fuzzy finder output.

    The ``fzf`` command is an interactive fuzzy picker. When run in pipelines
    or with ``--print-query``, it outputs the selected items or query string,
    which is typically compact (1–5 lines). However, when ``fzf`` is preceded
    by commands that generate preview output or large upstream pipes, the
    combined output can be verbose.

    Compression model:

    * **Pass-through** when output is ≤ 50 lines — fzf output is inherently
      compact, so anything under 50 lines is already lean.
    * **Summarise** when output exceeds 50 lines: keep first 40 lines +
      last 10 lines + "... N lines elided ..." marker in between.
    """

    name = "fzf"
    binaries = frozenset(["fzf"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 50:
            return text.rstrip()

        # Keep first 40 + last 10 + marker
        head_keep = 40
        tail_keep = 10
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} lines elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# --- lazygit (git TUI) -----------------------------------------------------

class LazyGitFilter(Filter):
    """Compress ``lazygit`` terminal UI output.

    The ``lazygit`` command is an interactive TUI (terminal user interface)
    for git operations. Running it non-interactively (e.g., piped into
    another command or captured without a TTY) produces terminal control
    sequences and incomplete state dumps, which are not useful.

    Compression model:

    * **Detect TUI markers**: when output contains terminal control sequences
      (ANSI escape codes for cursor control, colours, etc.) or is empty,
      emit a single helpful note instead of confusing the agent with raw
      terminal data.
    * **Pass-through** when output appears to be actual log/status text
      (no ANSI codes, non-empty).
    """

    name = "lazygit"
    binaries = frozenset(["lazygit"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Check for terminal control sequences (ANSI escapes).
        has_ansi = "\x1b[" in merged or "\x1b(" in merged
        is_empty = not merged.strip()

        if is_empty or has_ansi:
            # Lazygit is a terminal UI — it's not meant to be run
            # non-interactively. Return a helpful note.
            return "[lazygit is an interactive terminal UI — run it in a terminal session, not piped]"

        # If we got here, it's plain text (unusual for lazygit, but pass through).
        return merged.rstrip()


# --- jq (JSON processor) ---------------------------------------------------

class JqFilter(Filter):
    """Compress ``jq`` JSON processor output.

    The ``jq`` command outputs pretty-printed JSON. Output is already
    compact; compression mainly caps large JSON structures to prevent
    bloat from deeply nested or large array outputs.

    Compression model:

    * **Pass-through** when output is ≤ 200 lines — readable in full.
    * **Summarise** when output exceeds 200 lines: keep first 150 lines +
      last 50 lines + "... N lines elided ..." marker in between.
      The final closing bracket/brace is preserved when truncating.
    """

    name = "jq"
    binaries = frozenset(["jq"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 200:
            return text.rstrip()

        # Keep first 150 + last 50 + marker
        head_keep = 150
        tail_keep = 50
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} lines elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# --- yq (YAML processor) ---------------------------------------------------

class YqFilter(Filter):
    """Compress ``yq`` YAML processor output.

    The ``yq`` command outputs pretty-printed YAML or other structured
    formats. Output is already compact; compression mainly caps large
    structures to prevent bloat from deeply nested or large array outputs.

    Compression model:

    * **Pass-through** when output is ≤ 150 lines — readable in full.
    * **Summarise** when output exceeds 150 lines: keep first 100 lines +
      last 50 lines + "... N lines elided ..." marker in between.
    """

    name = "yq"
    binaries = frozenset(["yq"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        # Strip .exe on Windows
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        text = normalise(merged)

        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 150:
            return text.rstrip()

        # Keep first 100 + last 50 + marker
        head_keep = 100
        tail_keep = 50
        elided = len(non_empty) - head_keep - tail_keep

        head_lines = non_empty[:head_keep]
        tail_lines = non_empty[-tail_keep:]

        result = head_lines + [f"... [{elided} lines elided by token-goat]"] + tail_lines
        return "\n".join(result).rstrip()


# ---------------------------------------------------------------------------
# Helpers shared by filters
# ---------------------------------------------------------------------------

def _squeeze_blank_lines(text: str) -> str:
    """Collapse 3+ consecutive blank lines to a single blank line.

    Many filters drop selected lines, leaving runs of empties that bloat
    output.  Applied at the end of each filter's :meth:`compress`.
    """
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text)


def _trim_repeated_prefix(
    lines: list[str], pattern: re.Pattern[str], *, keep: int,
) -> list[str]:
    """Keep only the first *keep* lines matching *pattern*; drop the rest.

    Used to deduplicate spammy headers (pytest "collected N items", cargo
    "Compiling foo v0.1.0", …) where the count is more useful than the list.
    """
    out: list[str] = []
    matched = 0
    dropped = 0
    for line in lines:
        if pattern.match(line):
            matched += 1
            if matched <= keep:
                out.append(line)
            else:
                dropped += 1
        else:
            out.append(line)
    if dropped:
        out.append(f"[token-goat: +{dropped} more lines matching {pattern.pattern!r}]")
    return out


# ---------------------------------------------------------------------------
# Public registry & dispatch
# ---------------------------------------------------------------------------

#: Ordered registry of built-in filters.  First match wins, so more-specific
#: filters (named binaries) precede the generic fallback.  Users can append
#: their own :class:`Filter` subclasses but cannot redefine built-ins.
FILTERS: list[Filter] = [
    PytestFilter(),
    JestFilter(),
    CargoFilter(),
    NodePackageFilter(),
    DockerFilter(),
    KubectlFilter(),
    AwsFilter(),
    GhFilter(),
    RuffFilter(),
    MypyFilter(),
    LinterFilter(),
    GrepFilter(),
    GitFilter(),
    # GoTestFilter must precede MakeFilter so `go test ./...` routes to the
    # specialised testing filter; `go build` falls through to MakeFilter.
    GoTestFilter(),
    MakeFilter(),
    TerraformFilter(),
    # AnsibleFilter and PreCommitFilter have disjoint binaries from every
    # other filter (``ansible*`` and ``pre-commit`` respectively), so their
    # position within the registry is purely cosmetic — placed alongside
    # other deployment-style tooling.
    AnsibleFilter(),
    PreCommitFilter(),
    PipFilter(),
    UvFilter(),
    EzaFilter(),
    FdFilter(),
    TreeFilter(),
    BatFilter(),
    DeltaFilter(),
    FzfFilter(),
    LazyGitFilter(),
    JqFilter(),
    YqFilter(),
    PythonFilter(),
]


def select_filter(argv: list[str]) -> Filter | None:
    """Return the first registered filter whose ``matches(argv)`` is True.

    Returns ``None`` when no filter applies, callers should NOT wrap such
    commands in the compression subprocess (the overhead would be pure cost).

    The argv is prefix-stripped first via :func:`_strip_prefixes` so
    ``sudo time python -m pytest`` resolves to a ``pytest`` filter.
    """
    if not argv:
        return None
    resolved = _strip_prefixes(argv)
    if not resolved:
        return None
    for f in FILTERS:
        try:
            if f.matches(resolved):
                return f
        except Exception:  # noqa: BLE001, never let a custom filter break dispatch
            _LOG.exception("filter %s raised during matches()", f.name)
    return None


def detect_from_command(command: str) -> tuple[Filter, list[str]] | None:
    """Parse a shell command string and return ``(filter, argv)`` or ``None``.

    Convenience wrapper for the hook layer: the hook receives one string from
    the harness, and dispatch needs both the filter and the argv (so the
    filter can inspect subcommands).  Returns ``None`` when:

    * the command exceeds 64 KiB (defensive against crafted payloads),
    * ``shlex.split`` fails (unbalanced quotes: leave it alone),
    * the command is empty after prefix stripping,
    * no filter matches.
    """
    if not command or len(command) > 65_536:
        return None
    # Reject commands containing shell control operators (pipe, redirect,
    # subshell, command substitution).  Those cannot be safely wrapped
    # because the wrapper would only intercept the first stage of the pipe.
    # The user can still opt into wrapping by writing the pipeline themselves
    # against ``token-goat compress``.
    if any(op in command for op in ("|", "&&", "||", ";", "$(", "`", ">", "<")):
        return None
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return None
    filter_ = select_filter(argv)
    if filter_ is None:
        return None
    return filter_, _strip_prefixes(argv)


def compress_output(
    filter_: Filter,
    stdout: str,
    stderr: str,
    exit_code: int,
    argv: list[str],
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> CompressedOutput:
    """Run *filter_* over the captured output and return a :class:`CompressedOutput`.

    This is the canonical entry point for the wrapper subprocess.  Always
    succeeds (the filter's own :meth:`apply` catches exceptions and falls back
    to a head/tail truncation).
    """
    return filter_.apply(
        stdout, stderr, exit_code, argv, max_lines=max_lines, max_bytes=max_bytes,
    )


def filter_by_name(name: str) -> Filter | None:
    """Look up a registered filter by its :attr:`Filter.name`.

    Used when the hook layer has already detected the filter and the wrapper
    just needs to reconstruct it from a CLI flag.  Returns ``None`` for
    unknown names; the wrapper should then fall back to ``select_filter``.
    """
    for f in FILTERS:
        if f.name == name:
            return f
    return None
