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
    "AntFilter",
    "BatFilter",
    "BazelFilter",
    "BundlerFilter",
    "CmakeFilter",
    "ComposerFilter",
    "CurlFilter",
    "DartFilter",
    "DeltaFilter",
    "DiffFilter",
    "DotnetFilter",
    "EzaFilter",
    "FdFilter",
    "FlutterFilter",
    "GoFilter",
    "GradleFilter",
    "JavacFilter",
    "JqFilter",
    "MavenFilter",
    "MixFilter",
    "MSBuildFilter",
    "NuGetFilter",
    "PowerShellFilter",
    "PubFilter",
    "PythonFilter",
    "RsyncFilter",
    "RubyFilter",
    "SbtFilter",
    "SwiftFilter",
    "TreeFilter",
    "UvFilter",
    "CondaFilter",
    "PnpmFilter",
    "YarnFilter",
    "XcodeFilter",
    "YqFilter",
    # Security scanners
    "BanditFilter",
    "TrivyFilter",
    "SnykFilter",
    "SemgrepFilter",
    # Cloud CLI filters
    "AwsCliFilter",
    "GcloudFilter",
    "AzureCliFilter",
    # Database CLI filters
    "PsqlFilter",
    "MySQLFilter",
    "Sqlite3Filter",
    "RedisCLIFilter",
    # Dedicated git sub-filters (higher-fidelity compression than GitFilter)
    "GitLogFilter",
    "GitDiffFilter",
    "GitStatusVerboseFilter",
    "GitBlameFilter",
    # Docker Compose / Helm / kubectl-logs
    "DockerComposeFilter",
    "HelmFilter",
    "KubectlLogsFilter",
    # CI log filters
    "GhRunLogFilter",
    "ActFilter",
    "GenericCIFilter",
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


def _head_tail_compress(
    lines: list[str],
    head: int,
    tail: int,
    label: str = "items",
) -> str:
    """Return head lines + marker + tail lines when len(lines) > head + tail.

    If len(lines) <= head + tail, returns the lines joined unchanged.
    The marker reads: "... [N more <label> elided by token-goat]"

    Args:
        lines: List of non-empty lines to compress.
        head: Number of lines to keep from the start.
        tail: Number of lines to keep from the end.
        label: Word to use in the marker (default "items"; can be "lines", "paths", etc).

    Returns:
        Joined string with marker inserted if compression was needed.
    """
    total = len(lines)
    if total <= head + tail:
        return "\n".join(lines)

    elided = total - head - tail
    head_lines = lines[:head]
    tail_lines = lines[-tail:]
    result = head_lines + [f"... [{elided} more {label} elided by token-goat]"] + tail_lines
    return "\n".join(result)


def _pass_if_short(text: str, threshold: int = 30) -> str | None:
    """Return *text* unchanged if it contains <= *threshold* non-empty lines.

    Used by filters that skip expensive processing when input is already short.
    Returns the text if short (no processing needed), or ``None`` to signal
    the caller to proceed with detailed compression logic.

    Args:
        text: The text to check.
        threshold: Maximum number of non-empty lines to consider "short".

    Returns:
        *text* if short, ``None`` if the filter should proceed with compression.
    """
    non_empty = [ln for ln in text.split("\n") if ln.strip()]
    if len(non_empty) <= threshold:
        return text
    return None


def _preserve_stderr_on_error(
    stdout: str, stderr: str, exit_code: int,
) -> str | None:
    """Return combined output when exit_code != 0 and stderr is non-empty.

    Centralises the pattern: when a command fails (non-zero exit code) and
    produces stderr, preserve both stdout and stderr with a separator. Returns
    ``None`` when no error condition is detected, signalling the caller to
    continue with normal (non-error) compression logic.

    Args:
        stdout: Standard output.
        stderr: Standard error.
        exit_code: The exit code of the command.

    Returns:
        Combined ``stdout + "\\n---\\n" + stderr`` if exit_code != 0 and stderr
        is non-empty, else ``None`` (continue with normal logic).
    """
    if exit_code != 0 and stderr.strip():
        return (stdout.rstrip() + "\n---\n" + stderr.rstrip()) if stdout.strip() else stderr
    return None


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
    # File-level PASS header: `PASS  src/foo.test.js` (optional leading spaces
    # for indentation) OR a bare `✓`/`√` file header at column 0.  Per-test
    # ticks are indented (2+ spaces before `✓`) and handled separately.
    r"^(?:\s*PASS\s+\S|[✓√]\s+\S)"
)
_JEST_FAIL_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:FAIL|✗|×|✘)\s+\S"
)
_JEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(Test Suites|Tests|Snapshots|Time|Ran all test suites):"
)
# console.log / console.error / console.warn header emitted by Jest's --verbose
_JEST_CONSOLE_HDR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*console\.(log|error|warn|info|debug)\s"
)
# Indented console-output body lines (spaces/tabs then non-whitespace, inside a
# console block.  We detect the block by tracking whether the previous line was
# a console header or another body line at the same indent depth.)
_JEST_CONSOLE_AT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+at\s+\S"
)


class JestFilter(Filter):
    """Compress Jest / Mocha / Ava / Tap output.

    Jest emits ``PASS`` and ``FAIL`` headers per test file plus a final
    summary block.  Failures include diff-style output (``Expected`` /
    ``Received``) that we preserve verbatim.

    Compression model:

    * **Drop** ``PASS path/to/file.test.js`` lines (collapse to count).
    * **Keep** ``FAIL`` blocks with their full body (signature + diff).
    * **Keep** the final ``Test Suites: …`` / ``Tests: …`` / ``Snapshots: …``
      / ``Time: …`` summary lines.
    * **Drop** the per-test passing tick lines (``✓ should do thing (5 ms)``)
      outside of a FAIL block, counting them instead.
    * **Collapse** ``console.log`` / ``console.error`` / ``console.warn`` output
      blocks to a single count line per block when outside a FAIL block.
    """

    name = "jest"
    binaries = frozenset(["jest", "mocha", "ava", "tap"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Jest writes summaries to stderr by default.
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_count = 0
        tick_count = 0
        in_fail_block = False
        console_lines = 0  # lines accumulated in a console.* block
        in_console_block = False

        def _flush_console() -> None:
            nonlocal console_lines, in_console_block
            if console_lines:
                kept.append(
                    f"  [token-goat: collapsed {console_lines} console output line"
                    f"{'s' if console_lines != 1 else ''}]"
                )
            console_lines = 0
            in_console_block = False

        for line in lines:
            # --- PASS file header ---
            if _JEST_PASS_LINE_RE.match(line) and not in_fail_block:
                _flush_console()
                pass_count += 1
                continue
            # --- FAIL file header ---
            if _JEST_FAIL_LINE_RE.match(line):
                _flush_console()
                in_fail_block = True
                kept.append(line)
                continue
            # Blank line ends a fail block.
            if not line.strip() and in_fail_block:
                in_fail_block = False
                kept.append(line)
                continue
            # Inside a FAIL block: pass everything through verbatim.
            if in_fail_block:
                kept.append(line)
                continue
            # --- console.* block handling (outside FAIL block only) ---
            if _JEST_CONSOLE_HDR_RE.match(line):
                _flush_console()
                in_console_block = True
                console_lines = 1  # count the header line itself
                continue
            if in_console_block:
                stripped = line.strip()
                # Empty line or a non-indented line ends the console block.
                if not stripped or (line and not line[0].isspace()):
                    _flush_console()
                    # Fall through to handle this line normally.
                else:
                    console_lines += 1
                    continue
            # --- per-test passing tick (✓ / √) ---
            stripped = line.lstrip()
            if stripped.startswith(("✓", "√")):
                tick_count += 1
                continue
            kept.append(line)

        _flush_console()
        notes: list[str] = []
        if pass_count:
            notes.append(f"collapsed {pass_count} PASS file{'s' if pass_count != 1 else ''}")
        if tick_count:
            notes.append(f"collapsed {tick_count} passing tick{'s' if tick_count != 1 else ''}")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Vitest ----------------------------------------------------------------

_VITEST_FILE_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*✓\s+\S.*\([\d.]+\s*\w+\)"
)
_VITEST_FILE_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:×|FAIL|✗|✘)\s+\S"
)
_VITEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(Test Files|Tests|Modules|Duration|Start at)[\s:]+\d"
)
# Per-test pass lines inside a suite file block: leading spaces + ✓
_VITEST_TEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s{2,}✓\s"
)
# stdout/stderr output blocks emitted by Vitest's `--reporter=verbose`
_VITEST_STDOUT_HDR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*stdout\s*\|"
)


class VitestFilter(Filter):
    """Compress Vitest output.

    Vitest's verbose reporter emits per-file blocks starting with ``✓ file``
    (pass) or ``× file`` / ``FAIL file`` (fail), followed by indented
    per-test lines.  Summary ends with ``Test Files: N passed`` and
    ``Duration: Xs``.

    Compression model:

    * **Drop** file-level ``✓ file`` pass lines — collapse to count.
    * **Keep** file-level ``×`` / ``FAIL`` lines verbatim with full body.
    * **Collapse** indented ``✓ test name`` pass lines to count per block.
    * **Keep** ``×`` / failing test lines within a FAIL block verbatim.
    * **Keep** ``Test Files: …`` / ``Tests: …`` / ``Duration: …`` summary.
    * **Collapse** stdout / console output blocks to line count.
    """

    name = "vitest"
    binaries = frozenset(["vitest"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_file_count = 0
        pass_tick_count = 0
        in_fail_block = False
        stdout_lines = 0
        in_stdout_block = False

        def _flush_stdout() -> None:
            nonlocal stdout_lines, in_stdout_block
            if stdout_lines:
                kept.append(
                    f"  [token-goat: collapsed {stdout_lines} stdout line"
                    f"{'s' if stdout_lines != 1 else ''}]"
                )
            stdout_lines = 0
            in_stdout_block = False

        for line in lines:
            # File-level PASS header.
            if _VITEST_FILE_PASS_RE.match(line) and not in_fail_block:
                _flush_stdout()
                pass_file_count += 1
                continue
            # File-level FAIL header.
            if _VITEST_FILE_FAIL_RE.match(line):
                _flush_stdout()
                in_fail_block = True
                kept.append(line)
                continue
            # Summary lines always kept.
            if _VITEST_SUMMARY_RE.match(line):
                _flush_stdout()
                kept.append(line)
                continue
            # Blank line ends a fail block.
            if not line.strip() and in_fail_block:
                in_fail_block = False
                kept.append(line)
                continue
            # Inside a FAIL block: pass everything verbatim.
            if in_fail_block:
                kept.append(line)
                continue
            # stdout block handling.
            if _VITEST_STDOUT_HDR_RE.match(line):
                _flush_stdout()
                in_stdout_block = True
                stdout_lines = 1
                continue
            if in_stdout_block:
                stripped = line.strip()
                if not stripped or (line and not line[0].isspace()):
                    _flush_stdout()
                    # Fall through.
                else:
                    stdout_lines += 1
                    continue
            # Per-test passing tick (indented ✓).
            if _VITEST_TEST_PASS_RE.match(line):
                pass_tick_count += 1
                continue
            kept.append(line)

        _flush_stdout()
        notes: list[str] = []
        if pass_file_count:
            notes.append(
                f"collapsed {pass_file_count} passing file{'s' if pass_file_count != 1 else ''}"
            )
        if pass_tick_count:
            notes.append(
                f"collapsed {pass_tick_count} passing tick{'s' if pass_tick_count != 1 else ''}"
            )
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Cargo ------------------------------------------------------------------

_CARGO_COMPILING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Compiling\s+\S+\s+v\S+"
)
_CARGO_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Downloading|Fetching|Updating|Documenting|Building)\s+\S"
)
_CARGO_CHECKING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Checking\s+\S+\s+v\S+"
)
_CARGO_FINISHED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Finished\s+(dev|release|test)"
)
_CARGO_TEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^test\s+\S.*\s\.\.\.\s+ok\s*$"
)
_CARGO_TEST_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^test\s+\S.*\s\.\.\.\s+FAILED\s*$"
)
_CARGO_TEST_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^test result:"
)
_CARGO_TEST_RUNNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Running\s+(?:unittests|tests/|target/)"
)
_CARGO_ERROR_CODE_RE: Final[re.Pattern[str]] = re.compile(
    r"^error\[E\d+\]"
)


class CargoFilter(Filter):
    """Compress cargo build / check / test / clippy / run output.

    Cargo emits a ``Compiling foo v0.1.0`` line per crate (often dozens),
    plus optional ``Downloading``, ``Fetching``, ``Updating`` lines.  These
    are noise unless they fail.

    Compression model:

    * **build / check**: drop ``Compiling`` lines beyond a head + tail sample
      (keep first 2 and last 2); drop ``Downloading``/``Fetching``/``Updating``
      progress; keep every ``warning:``/``error:`` block and the ``Finished``
      summary line.
    * **test**: drop passing ``test foo ... ok`` lines (count them); keep every
      ``FAILED`` line, failure details, and the final ``test result:`` summary.
    * **clippy**: suppress ``Checking crate v...`` progress lines; keep every
      ``warning:``/``error:`` diagnostic and the final summary.
    * **run**: pass through — script output is load-bearing.
    """

    name = "cargo"
    binaries = frozenset(["cargo"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""

        if subcommand == "test":
            return self._compress_test(stdout, stderr)
        if subcommand == "clippy":
            return self._compress_clippy(stdout, stderr)
        if subcommand == "run":
            return self._combine_output(stdout, stderr)
        return self._compress_build(stdout, stderr)

    def _compress_build(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stderr, stdout)
        lines = merged.split("\n")
        compiled: list[str] = []
        kept: list[str] = []
        dropped_progress = 0
        for line in lines:
            if _CARGO_COMPILING_RE.match(line):
                compiled.append(line)
                continue
            if _CARGO_CHECKING_RE.match(line) or _CARGO_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            kept.append(line)
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

    def _compress_test(self, stdout: str, stderr: str) -> str:
        # cargo test: stderr has compiler progress, stdout has test output.
        # Merge compiler noise first, then test results.
        build_part = self._compress_build("", stderr) if stderr.strip() else ""
        test_lines = stdout.split("\n")
        kept: list[str] = []
        pass_count = 0
        fail_names: list[str] = []
        for line in test_lines:
            if _CARGO_TEST_PASS_RE.match(line):
                pass_count += 1
                continue
            if _CARGO_TEST_FAIL_RE.match(line):
                fail_names.append(line)
                kept.append(line)
                continue
            if _CARGO_TEST_RUNNING_RE.match(line):
                # "Running unittests/tests/..." — keep as section marker.
                kept.append(line)
                continue
            kept.append(line)
        notes: list[str] = []
        if pass_count:
            notes.append(f"collapsed {pass_count} passing test lines")
        self._emit_notes(kept, notes)
        test_out = self._finalize(kept)
        if build_part.strip() and test_out.strip():
            return build_part.rstrip() + "\n---\n" + test_out
        return build_part if build_part.strip() else test_out

    def _compress_clippy(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stderr, stdout)
        lines = merged.split("\n")
        compiled: list[str] = []
        kept: list[str] = []
        dropped_checking = 0
        dropped_progress = 0
        for line in lines:
            if _CARGO_COMPILING_RE.match(line):
                compiled.append(line)
                continue
            if _CARGO_CHECKING_RE.match(line):
                dropped_checking += 1
                continue
            if _CARGO_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            kept.append(line)
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
        notes: list[str] = []
        if dropped_checking:
            notes.append(f"dropped {dropped_checking} 'Checking …' lines")
        if dropped_progress:
            notes.append(f"dropped {dropped_progress} cargo progress lines")
        self._emit_notes(kept, notes)
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
# Matches the start of a human-mode ``npm audit`` advisory block header:
# "# <package-name>\n  Severity: moderate\n  ..." repeated per advisory.
_NPM_AUDIT_ADVISORY_HDR_RE: Final[re.Pattern[str]] = re.compile(
    r"^# [a-z0-9@._/-]", re.IGNORECASE
)
_NPM_AUDIT_SEVERITY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Severity:\s+(low|moderate|high|critical)\s*$", re.IGNORECASE
)
# ``npm audit --json`` top-level vulnerability keys: "vulnerabilities": {...}
# The key count is determined by parsing, not a regex.


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
    * **``npm audit --json``**: collapse the ``vulnerabilities`` object when it
      has >10 entries, retaining only critical/high entries and emitting a
      count summary for the rest.
    * **``npm audit`` (human mode)**: collapse duplicate advisory blocks for
      the same severity that exceed 10 entries, keeping unique package names
      and the final ``found N vulnerabilities`` summary line verbatim.
    """

    name = "npm"
    binaries = frozenset(["npm", "pnpm", "yarn", "bun"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Detect ``npm audit`` subcommand.
        positionals = _positional_args(argv[1:])
        is_audit = "audit" in positionals

        if is_audit:
            # JSON mode: ``npm audit --json`` or ``npm audit --json --audit-level=...``
            if "--json" in argv:
                return _compress_npm_audit_json(merged)
            # Human mode: collapse duplicate advisory blocks.
            return _compress_npm_audit_human(merged)

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


def _compress_npm_audit_json(text: str) -> str:
    """Compress ``npm audit --json`` output.

    When the ``vulnerabilities`` object has more than 10 entries, keep only
    critical/high severity entries and replace the rest with a count sentinel.
    The ``metadata`` block (totals) is always preserved.
    """
    import json as _json  # noqa: PLC0415 — lazy import, json is stdlib

    try:
        data = _json.loads(text)
    except (ValueError, TypeError):
        return text  # Not valid JSON — pass through unchanged.

    vulns = data.get("vulnerabilities", {})
    if not isinstance(vulns, dict) or len(vulns) <= 10:
        return text  # Short enough — no compression needed.

    # Partition by severity: keep critical/high; summarise the rest.
    keep: dict[str, object] = {}
    collapsed_count = 0
    collapsed_severities: dict[str, int] = {}
    for pkg, info in vulns.items():
        severity = ""
        if isinstance(info, dict):
            severity = str(info.get("severity", "")).lower()
        if severity in ("critical", "high"):
            keep[pkg] = info
        else:
            collapsed_count += 1
            collapsed_severities[severity] = collapsed_severities.get(severity, 0) + 1

    if collapsed_count:
        sev_summary = ", ".join(
            f"{v} {k}" for k, v in sorted(collapsed_severities.items())
        )
        keep["__token_goat__"] = (
            f"{collapsed_count} lower-severity entries collapsed ({sev_summary}); "
            "run `npm audit --json` for full output"
        )
    data["vulnerabilities"] = keep
    return _json.dumps(data, indent=2)


_NPM_AUDIT_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^found \d+|^Severity:|^==|^-{3,}", re.IGNORECASE
)


def _compress_npm_audit_human(text: str) -> str:
    """Compress human-mode ``npm audit`` output.

    Advisory blocks share a common format:

    .. code-block:: text

        # <package>
          Severity: moderate
          <title>
          ...
        fix available via ...

    When more than 10 advisory blocks exist for any single severity level,
    keep only the first 10 for that severity and emit a count summary.  The
    final ``found N vulnerabilities`` summary line is always preserved.
    """
    lines = text.split("\n")
    # Identify advisory block boundaries (lines starting with "# <pkg>").
    # Each block runs from the header line until (but not including) the next
    # header line, a summary line, or the end of output.
    blocks: list[tuple[int, int, str]] = []  # (start_idx, end_idx, severity)
    i = 0
    while i < len(lines):
        if _NPM_AUDIT_ADVISORY_HDR_RE.match(lines[i]):
            start = i
            severity = "unknown"
            # Peek ahead up to 5 lines for "Severity: ..." to classify.
            for j in range(i + 1, min(i + 6, len(lines))):
                m = _NPM_AUDIT_SEVERITY_RE.match(lines[j])
                if m:
                    severity = m.group(1).lower()
                    break
            # Find the end of this block (next header, summary line, or EOF).
            end = i + 1
            while end < len(lines):
                ln = lines[end]
                if _NPM_AUDIT_ADVISORY_HDR_RE.match(ln):
                    break
                if _NPM_AUDIT_SUMMARY_RE.match(ln):
                    break
                end += 1
            blocks.append((start, end, severity))
            i = end
        else:
            i += 1

    if not blocks:
        return text  # No advisory blocks found — pass through.

    # Group blocks by severity; keep the first 10 per severity.
    MAX_PER_SEV = 10
    sev_count: dict[str, int] = {}
    # Build a set of block indices to keep.
    keep_blocks: set[int] = set()
    for idx, (_, _, sev) in enumerate(blocks):
        sev_count[sev] = sev_count.get(sev, 0) + 1
        if sev_count[sev] <= MAX_PER_SEV:
            keep_blocks.add(idx)

    # Build a set of line indices to drop.
    drop_lines: set[int] = set()
    collapsed_sev: dict[str, int] = {}
    for idx, (start, end, sev) in enumerate(blocks):
        if idx not in keep_blocks:
            for li in range(start, end):
                drop_lines.add(li)
            collapsed_sev[sev] = collapsed_sev.get(sev, 0) + 1

    if not drop_lines:
        return text  # Nothing to collapse.

    kept: list[str] = [ln for i, ln in enumerate(lines) if i not in drop_lines]
    notes: list[str] = []
    for sev, cnt in sorted(collapsed_sev.items()):
        notes.append(f"collapsed {cnt} duplicate {sev} advisories")
    Filter._emit_notes(kept, notes)
    return _squeeze_blank_lines("\n".join(kept))


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
    """Compress ``kubectl``, ``k9s``, ``oc``, and ``helm`` output.

    ``kubectl get`` returns tabular output (NAME, READY, STATUS, RESTARTS, AGE);
    on a large cluster this is thousands of lines.  Truncate to header + first
    10 data rows + tail summary.

    ``kubectl describe`` extracts key metadata (Name, Namespace, Status) and
    the Events section (last 10 lines).

    ``kubectl apply`` / ``kubectl create`` / ``kubectl delete`` are typically
    short; pass through with stderr appended if present.

    ``kubectl logs`` emits high-volume streaming text; use head+tail compression
    (head=30, tail=20) to preserve context without redundancy.

    ``kubectl exec`` is interactive; pass through.

    ``kubectl diff`` can produce large diffs; truncate to first 50 lines.

    Errors (exit_code != 0) preserve all stderr unchanged.
    """

    name = "kubectl"
    binaries = frozenset(["kubectl", "k", "k9s", "oc"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Always preserve stderr on error
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        text = stdout

        if subcommand in ("get", "top"):
            if "\n" in text:
                text = _compress_kubectl_table(text, max_rows=10)
        elif subcommand == "describe":
            if "\n" in text:
                text = _compress_kubectl_describe(text)
        elif subcommand in ("apply", "create", "delete"):
            # These are typically short; pass through
            pass
        elif subcommand == "logs":
            if "\n" in text:
                non_empty = [ln for ln in text.split("\n") if ln.strip()]
                if len(non_empty) > 50:
                    text = _head_tail_compress(non_empty, head=30, tail=20, label="log lines")
                else:
                    text = "\n".join(non_empty)
        elif subcommand == "exec":
            # Interactive; pass through
            pass
        elif subcommand == "diff":
            lines = text.split("\n")
            if len(lines) > 50:
                text = _head_tail_compress(lines, head=50, tail=0, label="diff lines")

        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text


def _compress_kubectl_table(text: str, max_rows: int = 10) -> str:
    """Truncate a kubectl tabular output to header + first *max_rows* data rows."""
    lines = text.split("\n")
    # Skip empty lines at the end
    non_empty = [ln for ln in lines if ln.strip()]
    if len(non_empty) <= max_rows + 1:
        return text
    return (
        "\n".join(non_empty[: max_rows + 1])
        + f"\n[token-goat: {len(non_empty) - max_rows - 1} more rows; use --selector or -l to narrow]"
    )


def _compress_kubectl_describe(text: str) -> str:
    """Extract Name/Namespace/Status and Events section from kubectl describe."""
    lines = text.split("\n")
    kept: list[str] = []

    # Scan for key fields in the header
    for line in lines:
        if any(key in line for key in ["Name:", "Namespace:", "Status:", "State:"]):
            kept.append(line)

    # Scan for Events section; keep last 10 event lines
    events_start = -1
    for i, line in enumerate(lines):
        if line.startswith("Events:"):
            events_start = i
            break

    if events_start >= 0:
        kept.append("")
        kept.append("Events:")
        event_lines = [ln for ln in lines[events_start + 1:] if ln.strip()]
        if event_lines:
            if len(event_lines) > 10:
                kept.append(f"[token-goat: {len(event_lines) - 10} earlier events elided]")
                kept.extend(event_lines[-10:])
            else:
                kept.extend(event_lines)

    if not kept:
        # Fallback: header + first 20 lines
        return "\n".join(lines[:20]) + "\n[token-goat: describe output truncated]"

    return "\n".join(kept)


# --- Docker Compose --------------------------------------------------------

# Patterns for docker-compose streaming output ("service_name | log line")
_DC_SERVICE_LOG_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<svc>[a-zA-Z0-9_\-\.]+(?:-\d+)?)\s*\|\s*(?P<msg>.*)$"
)
# Pulling service lines: "Pulling service_name (image:tag)..."
_DC_PULLING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Pulling\s+\S+\s+\(.*\)\s*\.\.\.\s*$"
)
# Health-check retry lines
_DC_HEALTH_RE: Final[re.Pattern[str]] = re.compile(
    r"Container\s+\S+\s+(Waiting|health:\s+\w+|starting|unhealthy)",
    re.IGNORECASE,
)


class DockerComposeFilter(Filter):
    """Compress ``docker-compose`` and ``docker compose`` output.

    Compression model:

    * **Pulling** lines: keep the first, collapse the rest to a count.
    * **Streaming service logs** (``svc | message``): when a service emits
      more than 50 lines in one capture, keep the last 10 with a count marker.
    * **Creating/Starting/Stopping** lines: keep verbatim (they are short).
    * **Build output**: delegate to :class:`DockerFilter` patterns.
    * **Health-check retries**: collapse repeated waiting/retry lines to a
      count per container.
    """

    name = "docker-compose"
    binaries = frozenset(["docker-compose", "docker"])

    def matches(self, argv: list[str]) -> bool:
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        # docker-compose binary
        if stem in {"docker-compose"} or name in {"docker-compose"}:
            return True
        # `docker compose` (subcommand form)
        if stem in {"docker"} or name in {"docker"}:
            positionals = _positional_args(argv[1:])
            return bool(positionals) and positionals[0] == "compose"
        return False

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        # Collect per-service log lines for streaming dedup
        service_lines: dict[str, list[str]] = {}
        kept: list[str] = []
        pulling_count = 0
        pulling_kept = 0
        health_counts: dict[str, int] = {}

        for line in lines:
            # Health-check retry collapsing
            hm = _DC_HEALTH_RE.search(line)
            if hm:
                # Use the container name as key (first word-like group after
                # "Container") to group retries
                container_key = line.split()[1] if len(line.split()) > 1 else "container"
                health_counts[container_key] = health_counts.get(container_key, 0) + 1
                # Emit only the first occurrence; the rest become the count
                if health_counts[container_key] == 1:
                    kept.append(line)
                continue

            # Pulling lines: keep the first, collapse the rest
            if _DC_PULLING_RE.match(line):
                pulling_count += 1
                if pulling_kept == 0:
                    kept.append(line)
                    pulling_kept = 1
                continue

            # Streaming service log lines: buffer per service
            sm = _DC_SERVICE_LOG_RE.match(line)
            if sm:
                svc = sm.group("svc")
                if svc not in service_lines:
                    service_lines[svc] = []
                service_lines[svc].append(line)
                continue

            kept.append(line)

        # Flush pulled-count summary
        if pulling_count > pulling_kept:
            kept.append(
                f"[token-goat: {pulling_count - pulling_kept} more Pulling lines elided]"
            )

        # Flush health-check summaries
        for container_key, count in sorted(health_counts.items()):
            if count > 1:
                kept.append(
                    f"[token-goat: {count - 1} more health-check wait lines for {container_key}]"
                )

        # Flush service log buffers — collapse services with >50 lines
        STREAM_THRESHOLD = 50
        STREAM_TAIL = 10
        for svc in sorted(service_lines):
            svc_lines = service_lines[svc]
            if len(svc_lines) <= STREAM_THRESHOLD:
                kept.extend(svc_lines)
            else:
                extra = len(svc_lines) - STREAM_TAIL
                kept.append(
                    f"[token-goat: {extra} lines from {svc} elided (showing last {STREAM_TAIL})]"
                )
                kept.extend(svc_lines[-STREAM_TAIL:])

        return self._finalize(kept)


# --- Helm ------------------------------------------------------------------

# Helm release description boilerplate patterns
_HELM_RELEASE_DESC_RE: Final[re.Pattern[str]] = re.compile(
    r"^(NAME|LAST DEPLOYED|NAMESPACE|CHART|APP VERSION|REVISION|TEST SUITE"
    r"|NOTES\.|RESOURCES:|==>|USER-SUPPLIED VALUES:|COMPUTED VALUES:"
    r"|HOOKS:|MANIFEST:)\b"
)
_HELM_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^STATUS:\s*\S+"
)
# Helm template section headers: "---" possibly followed by "# Source: ..."
_HELM_TEMPLATE_SECTION_RE: Final[re.Pattern[str]] = re.compile(
    r"^---\s*(?:#.*)?$"
)
# Helm table row (helm list): tab-separated or padded columns
_HELM_LIST_ROW_RE: Final[re.Pattern[str]] = re.compile(
    r"^\S+\s"
)


class HelmFilter(Filter):
    """Compress ``helm`` output.

    Compression model:

    * ``helm install`` / ``helm upgrade``: keep the ``STATUS:`` line verbatim;
      collapse the surrounding release description boilerplate.  Error messages
      are always preserved.
    * ``helm list``: when output exceeds 20 data rows, keep the header + first
      10 rows + a count of remaining rows.
    * ``helm template``: when the rendered YAML exceeds 200 lines, emit only
      the YAML document separators (``---``) with kind/name comments and a
      total line count.
    * All other subcommands: pass through.
    """

    name = "helm"
    binaries = frozenset(["helm"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        text = stdout

        if subcommand in ("install", "upgrade"):
            text = _compress_helm_install(text)
        elif subcommand == "list":
            text = _compress_helm_list(text)
        elif subcommand == "template":
            lines = text.split("\n")
            if len(lines) > 200:
                text = _compress_helm_template(lines)
        # else: rollback, status, history, etc. — pass through

        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text


def _compress_helm_install(text: str) -> str:
    """Collapse helm install/upgrade boilerplate; preserve STATUS and errors."""
    lines = text.split("\n")
    kept: list[str] = []
    dropped = 0
    in_notes = False

    for line in lines:
        # Always keep error signal lines
        if _ERROR_SIGNAL_RE.search(line):
            kept.append(line)
            continue
        # Always keep the STATUS line
        if _HELM_STATUS_RE.match(line):
            kept.append(line)
            continue
        # Track NOTES section start — keep NOTES header, drop body
        if line.strip() == "NOTES:":
            in_notes = True
            dropped += 1
            continue
        if in_notes:
            # Notes body: drop until a blank line or next section
            if not line.strip():
                in_notes = False
            dropped += 1
            continue
        # Drop verbose boilerplate field lines
        if _HELM_RELEASE_DESC_RE.match(line):
            dropped += 1
            continue
        kept.append(line)

    if dropped:
        kept.append(f"[token-goat: {dropped} helm release description lines elided]")
    return "\n".join(kept)


def _compress_helm_list(text: str) -> str:
    """Cap helm list output at header + 10 data rows."""
    lines = [ln for ln in text.split("\n") if ln.strip()]
    MAX_ROWS = 10
    # First line is header
    if len(lines) <= MAX_ROWS + 1:
        return text
    header = lines[0]
    data = lines[1:]
    kept = [header] + data[:MAX_ROWS]
    kept.append(
        f"[token-goat: {len(data) - MAX_ROWS} more helm releases elided; "
        "use --filter or --namespace to narrow]"
    )
    return "\n".join(kept)


def _compress_helm_template(lines: list[str]) -> str:
    """Emit only YAML document headers from a large helm template output."""
    total = len(lines)
    sections: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("---"):
            sections.append(line)
    if not sections:
        # No document separators found — just head/tail truncate
        return _head_tail_compress(lines, head=10, tail=10, label="template lines")
    sections.append(
        f"[token-goat: helm template {total} total lines; showing {len(sections)} document headers only]"
    )
    return "\n".join(sections)


# --- KubectlLogs enhanced compression --------------------------------------

# Timestamp prefix pattern common in structured/k8s log lines
_KUBE_TIMESTAMP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"
)
# Access-log pattern: IP + HTTP method/path/status
_KUBE_ACCESS_LOG_RE: Final[re.Pattern[str]] = re.compile(
    r"""(?:\d{1,3}\.){3}\d{1,3}.*?"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s"""
    r"""[^"]*"\s+(\d{3})\b"""
)
# Stack trace frame patterns (Java, Python, Go, Node)
_KUBE_STACKFRAME_RE: Final[re.Pattern[str]] = re.compile(
    r"""^\s+(?:at\s+[\w\.$<>]+\(|File "[^"]+", line \d+|goroutine \d+ \[|\s+\.\.\.)"""
)


class KubectlLogsFilter(Filter):
    """Compress high-volume ``kubectl logs`` output with richer deduplication.

    Compression model (applied on top of the base KubectlFilter head/tail):

    * **Repetitive lines** (same message, different timestamps): keep first 3,
      show ``N more similar lines`` for the rest.
    * **JSON log blobs**: compact single-line JSON passes through; JSON blobs
      spanning more than 5 lines are collapsed to a one-line summary.
    * **Stack traces**: keep first 5 frame lines + ``... N frames`` marker.
    * **HTTP access logs**: when more than 20 lines match the access-log
      pattern, collapse to ``N HTTP requests (2xx: N, 4xx: N, 5xx: N)``.
    """

    name = "kubectl-logs"
    binaries = frozenset(["kubectl", "k"])

    def matches(self, argv: list[str]) -> bool:
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        if stem not in {"kubectl", "k"} and name not in {"kubectl", "k"}:
            return False
        positionals = _positional_args(argv[1:])
        return bool(positionals) and positionals[0] == "logs"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        lines = stdout.split("\n")
        non_empty = [ln for ln in lines if ln.strip()]

        if len(non_empty) <= 50:
            return stdout

        # Step 1: access-log collapsing
        non_empty = _collapse_access_logs(non_empty)

        # Step 2: stack-trace collapsing
        non_empty = _collapse_stack_traces(non_empty)

        # Step 3: repetitive-line dedup (timestamp-normalised)
        non_empty = _dedup_log_lines(non_empty, keep_first_n=3)

        # Step 4: JSON blob collapsing
        non_empty = _collapse_json_blobs(non_empty, max_json_lines=5)

        if stderr.strip():
            result = "\n".join(non_empty)
            return (result.rstrip() + "\n---\n" + stderr.rstrip()) if result.strip() else stderr
        return "\n".join(non_empty)


def _strip_timestamp(line: str) -> str:
    """Remove leading ISO-8601 timestamp from a log line for pattern comparison."""
    return _KUBE_TIMESTAMP_RE.sub("", line).strip()


def _dedup_log_lines(lines: list[str], keep_first_n: int = 3) -> list[str]:
    """Deduplicate log lines that differ only in leading timestamps.

    Groups consecutive lines by their timestamp-stripped content.  The first
    *keep_first_n* in each run are kept verbatim; additional lines are
    collapsed to a single ``N more similar lines`` marker.
    """
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        key = _strip_timestamp(line)
        # Count consecutive lines with the same de-timestamped content
        j = i + 1
        while j < len(lines) and _strip_timestamp(lines[j]) == key:
            j += 1
        run = lines[i:j]
        if len(run) <= keep_first_n:
            out.extend(run)
        else:
            out.extend(run[:keep_first_n])
            out.append(
                f"[token-goat: {len(run) - keep_first_n} more similar lines omitted]"
            )
        i = j
    return out


def _collapse_stack_traces(lines: list[str]) -> list[str]:
    """Collapse stack-trace frame runs to first 5 frames + count marker."""
    MAX_FRAMES = 5
    out: list[str] = []
    i = 0
    while i < len(lines):
        if _KUBE_STACKFRAME_RE.match(lines[i]):
            # Collect all contiguous frame lines
            j = i
            while j < len(lines) and _KUBE_STACKFRAME_RE.match(lines[j]):
                j += 1
            frames = lines[i:j]
            out.extend(frames[:MAX_FRAMES])
            if len(frames) > MAX_FRAMES:
                out.append(f"    ... {len(frames) - MAX_FRAMES} more frames")
            i = j
        else:
            out.append(lines[i])
            i += 1
    return out


def _collapse_access_logs(lines: list[str]) -> list[str]:
    """Collapse HTTP access log lines to a summary when there are more than 20."""
    ACCESS_THRESHOLD = 20
    access_lines: list[str] = []
    other_lines: list[str] = []
    for line in lines:
        if _KUBE_ACCESS_LOG_RE.search(line):
            access_lines.append(line)
        else:
            other_lines.append(line)
    if len(access_lines) <= ACCESS_THRESHOLD:
        return lines  # not enough to bother compressing
    # Tally status code buckets
    counts: dict[str, int] = {}
    for line in access_lines:
        m = _KUBE_ACCESS_LOG_RE.search(line)
        if m:
            status = m.group(1)
            bucket = f"{status[0]}xx"
            counts[bucket] = counts.get(bucket, 0) + 1
    detail = ", ".join(f"{k}: {v}" for k, v in sorted(counts.items()))
    summary = (
        f"[token-goat: {len(access_lines)} HTTP access log lines collapsed ({detail})]"
    )
    return other_lines + [summary]


def _collapse_json_blobs(lines: list[str], max_json_lines: int = 5) -> list[str]:
    """Collapse multi-line JSON blobs that span more than *max_json_lines* lines.

    Detects JSON blobs by looking for lines that start with ``{`` and end with
    ``}`` after accounting for nested structure via brace counting.  Compact
    single-line JSON objects are left unchanged.
    """
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        # Possible start of a JSON object blob
        if stripped.startswith("{") and not stripped.endswith("}"):
            depth = stripped.count("{") - stripped.count("}")
            j = i + 1
            while j < len(lines) and depth > 0:
                chunk = lines[j].strip()
                depth += chunk.count("{") - chunk.count("}")
                j += 1
            blob_lines = lines[i:j]
            if len(blob_lines) > max_json_lines:
                # Try to extract a summary key from the blob
                summary_key = _json_blob_summary(blob_lines)
                out.append(
                    f"[token-goat: JSON blob {len(blob_lines)} lines collapsed{summary_key}]"
                )
                i = j
                continue
        out.append(line)
        i += 1
    return out


def _json_blob_summary(blob_lines: list[str]) -> str:
    """Extract a short summary from a JSON blob (first key-value pair)."""
    import json as _json  # noqa: PLC0415 — lazy import inside helper
    try:
        obj = _json.loads("\n".join(blob_lines))
        if isinstance(obj, dict):
            for key in ("message", "msg", "level", "severity", "event", "type"):
                if key in obj:
                    return f': {key}={obj[key]!r}'
    except (ValueError, TypeError):
        pass
    return ""


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


# --- GitHub Actions log (gh run view --log) --------------------------------

# ISO-8601 timestamp prefix as emitted by ``gh run view --log``:
# ``2024-01-15T12:34:56.1234567Z ``
_GH_LOG_TIMESTAMP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?"
)
# ``##[group]Step name`` / ``##[endgroup]``
_GH_LOG_GROUP_RE: Final[re.Pattern[str]] = re.compile(
    r"^##\[group\](.*)"
)
_GH_LOG_ENDGROUP_RE: Final[re.Pattern[str]] = re.compile(
    r"^##\[endgroup\]"
)
# ``Run actions/checkout@v3`` setup lines (appear at the start of action runs).
_GH_LOG_SETUP_ACTION_RE: Final[re.Pattern[str]] = re.compile(
    r"^Run [a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+@"
)
# Post-run cleanup steps emitted by the runner after the job.
_GH_LOG_POST_STEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^Post job cleanup\.|^Cleaning up orphan processes|^Post Run "
)
# Runner boilerplate lines.
_GH_LOG_BOILERPLATE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Setting up runner|^Runner version |^Operating System\s+:\s|^Virtual Environment"
    r"|^Prepare all required actions|^Getting action download info"
    r"|^Download action repository|^Complete job name:"
)
# Failure indicators — always keep verbatim.
_GH_LOG_FAILURE_RE: Final[re.Pattern[str]] = re.compile(
    r"error:|Error:|ERROR|FAILED|failed|##\[error\]|##\[warning\]"
    r"|Process completed with exit code [^0]",
    re.IGNORECASE,
)


class GhRunLogFilter(Filter):
    """Compress ``gh run view --log`` GitHub Actions raw log output.

    ``gh run view --log`` dumps every log line from every step, each prefixed
    with an ISO-8601 timestamp.  A 100-step CI run easily produces 2,000+
    lines.

    Compression model:

    * **Strip** ISO-8601 timestamp prefixes (``2024-01-15T12:34:56.1234567Z``).
    * **Collapse** ``##[group]`` / ``##[endgroup]`` bodies when the group
      contains more than 20 lines and has no failure signal — keep the group
      name and a line count.
    * **Collapse** ``Run actions/checkout@v3`` and similar setup action blocks
      to a single ``Setup: N actions`` summary.
    * **Drop** post-run cleanup steps (``Post job cleanup.``, ``Cleaning up
      orphan processes``, ``Post Run <action>``).
    * **Drop** runner boilerplate (``Setting up runner``, OS/version headers).
    * **Keep** every failure line verbatim.
    """

    name = "gh-run-log"
    binaries = frozenset(["gh"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        if stem not in {"gh"} and name not in {"gh"}:
            return False
        positionals = _positional_args(argv[1:])
        # Must be ``gh run view`` with ``--log`` flag.
        return (
            len(positionals) >= 2
            and positionals[0] == "run"
            and positionals[1] == "view"
            and "--log" in argv
        )

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        setup_actions: list[str] = []
        dropped_boilerplate = 0
        dropped_cleanup = 0
        collapsed_groups = 0

        # Group-collapse state.
        in_group = False
        group_name = ""
        group_lines: list[str] = []
        group_has_failure = False
        GROUP_COLLAPSE_THRESHOLD = 20

        def _flush_group() -> None:
            nonlocal collapsed_groups
            if not group_lines:
                return
            if group_has_failure or len(group_lines) <= GROUP_COLLAPSE_THRESHOLD:
                kept.extend(group_lines)
            else:
                kept.append(
                    f"[group: {group_name} — {len(group_lines)} lines collapsed by token-goat]"
                )
                collapsed_groups += 1

        for raw_line in lines:
            # Strip timestamp prefix first.
            line = _GH_LOG_TIMESTAMP_RE.sub("", raw_line)

            # Boilerplate — drop.
            if _GH_LOG_BOILERPLATE_RE.match(line):
                dropped_boilerplate += 1
                continue

            # Post-run cleanup — drop.
            if _GH_LOG_POST_STEP_RE.match(line):
                dropped_cleanup += 1
                continue

            # Group markers.
            m_group = _GH_LOG_GROUP_RE.match(line)
            if m_group:
                # Flush any previous open group before starting a new one.
                _flush_group()
                in_group = True
                group_name = m_group.group(1).strip()
                group_lines = []
                group_has_failure = False
                continue

            if _GH_LOG_ENDGROUP_RE.match(line):
                _flush_group()
                in_group = False
                group_lines = []
                continue

            # Setup action lines ("Run actions/checkout@v3") — collect for summary.
            if _GH_LOG_SETUP_ACTION_RE.match(line):
                setup_actions.append(line)
                continue

            # All other lines: if we're inside a group, buffer them.
            if in_group:
                if _GH_LOG_FAILURE_RE.search(line):
                    group_has_failure = True
                group_lines.append(line)
            else:
                kept.append(line)

        # Flush any group that wasn't closed before EOF.
        _flush_group()

        # Emit setup actions summary.
        if setup_actions:
            kept.append(f"[token-goat: Setup: {len(setup_actions)} action(s) collapsed]")

        notes: list[str] = []
        if dropped_boilerplate:
            notes.append(f"dropped {dropped_boilerplate} boilerplate lines")
        if dropped_cleanup:
            notes.append(f"dropped {dropped_cleanup} cleanup lines")
        if collapsed_groups:
            notes.append(f"collapsed {collapsed_groups} log group(s)")
        Filter._emit_notes(kept, notes)
        return self._finalize(kept)


# --- act (local GitHub Actions runner) ------------------------------------

# ``act`` log lines look like: ``[job-name/step-name]   | output here``
# or ``[job-name/step-name] ✅`` / ``[job-name/step-name] ❌``
_ACT_JOB_PREFIX_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[(?P<job>[^\]]+)\]\s+\|\s*(?P<body>.*)"
)
_ACT_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[(?P<job>[^\]]+)\]\s+(?P<status>[✅❌✓✗])"
)
# Docker pull progress inside act (same shape as DockerFilter progress).
_ACT_DOCKER_PULL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[(?:[^\]]+)\]\s+\|\s*"
    r"(?:Pulling |Waiting\s*$|Verifying |Extracting |Pull complete|Digest:|Status:|Unable to find image)",
    re.IGNORECASE,
)
# Verbose matrix expansion: ``[matrix: {"os": "ubuntu-latest", "node": "18"}]``
_ACT_MATRIX_EXPAND_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[.*\]\s+Matrix:"
)


class ActFilter(Filter):
    """Compress ``act`` (local GitHub Actions runner) output.

    ``act`` prefixes every log line with ``[job-name/step-name] | ``.  Large
    runs produce thousands of prefix-decorated lines.

    Compression model:

    * **Strip** ``[job/step] | `` prefix from body lines when collapsing.
    * **Collapse** Docker pull progress inside act (``Pulling``, ``Waiting``,
      ``Pull complete``, ``Digest:``, etc.).
    * **Keep** ``✅`` / ``❌`` job status lines verbatim.
    * **Collapse** verbose matrix expansion lines to a count.
    * **Keep** every failure/error line verbatim.
    """

    name = "act"
    binaries = frozenset(["act"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        docker_pull_dropped = 0
        matrix_lines: list[str] = []

        for line in lines:
            # Always keep status lines (✅ ❌) verbatim (they carry the prefix
            # intentionally to show which job passed/failed).
            if _ACT_STATUS_RE.match(line):
                kept.append(line)
                continue

            # Docker pull progress — collapse.
            if _ACT_DOCKER_PULL_RE.match(line):
                docker_pull_dropped += 1
                continue

            # Matrix expansion lines — collect for summary.
            if _ACT_MATRIX_EXPAND_RE.match(line):
                matrix_lines.append(line)
                continue

            # Strip ``[job/step] | `` prefix from body lines before further checks.
            m = _ACT_JOB_PREFIX_RE.match(line)
            body = m.group("body") if m else line

            # Failure lines — keep stripped body verbatim.
            if _GH_LOG_FAILURE_RE.search(body):
                kept.append(body)
                continue

            kept.append(body)

        notes: list[str] = []
        if docker_pull_dropped:
            notes.append(f"collapsed {docker_pull_dropped} docker-pull progress lines")
        if matrix_lines:
            notes.append(f"collapsed {len(matrix_lines)} matrix expansion lines")
        Filter._emit_notes(kept, notes)
        return self._finalize(kept)


# --- GenericCIFilter (catch-all for CI log patterns) -----------------------

# ISO-8601 or date-time-like timestamp prefix in generic CI/pipeline logs.
# Matches: ``2024-01-15T12:34:56Z ``, ``2024-01-15 12:34:56 ``,
#          ``[2024-01-15T12:34:56.123Z] ``.
_CI_TIMESTAMP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s+"
)
# ANSI escape sequence (any CSI sequence or OSC sequence).
_CI_ANSI_RE: Final[re.Pattern[str]] = re.compile(
    r"\x1b(?:\[[0-9;]*[mABCDEFGHJKSTf]|\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\))"
)
# Heartbeat / ping / health-check log lines.
_CI_HEARTBEAT_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(?:heartbeat|ping|health.?check|keepalive|keep.alive)\b",
    re.IGNORECASE,
)
# Log level prefixes.
_CI_DEBUG_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:DEBUG|TRACE|VERBOSE)\b[\s:]", re.IGNORECASE
)
_CI_INFO_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*INFO\b[\s:]", re.IGNORECASE
)
# Keywords that trigger GenericCIFilter matching.
_CI_COMMAND_KEYWORDS: Final[frozenset[str]] = frozenset([
    "--log", "logs", "pipeline", "workflow",
])


class GenericCIFilter(Filter):
    """Catch-all filter for CI log patterns not covered by specific filters.

    Fires when the raw command contains any of: ``--log``, ``logs``,
    ``pipeline``, ``workflow``.  Applies universal CI log noise reduction
    without assuming any particular tool.

    Compression model:

    * **Strip** ISO-8601 / date-time timestamp prefixes from each line.
    * **Strip** stray ANSI escape sequences from non-interactive output.
    * **Collapse** ``DEBUG:`` / ``TRACE:`` lines to a count per run.
    * **Keep** ``INFO:`` lines verbatim.
    * **Collapse** repeated heartbeat / ping / health-check lines to a count.
    * **Keep** every failure/error line verbatim.
    """

    name = "generic-ci"
    binaries = frozenset()  # Matched via custom matches() only.

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        cmd_str = " ".join(argv).lower()
        return any(kw in cmd_str for kw in _CI_COMMAND_KEYWORDS)

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        debug_count = 0
        heartbeat_count = 0

        for line in lines:
            # Strip timestamp prefix.
            line = _CI_TIMESTAMP_RE.sub("", line)
            # Strip stray ANSI escapes (non-interactive CI output).
            line = _CI_ANSI_RE.sub("", line)

            # Always keep failure lines.
            if _GH_LOG_FAILURE_RE.search(line):
                kept.append(line)
                continue

            # Heartbeat / health-check lines — collapse.
            if _CI_HEARTBEAT_RE.search(line):
                heartbeat_count += 1
                continue

            # DEBUG / TRACE — collapse to count.
            if _CI_DEBUG_RE.match(line):
                debug_count += 1
                continue

            kept.append(line)

        notes: list[str] = []
        if debug_count:
            notes.append(f"collapsed {debug_count} DEBUG/TRACE lines")
        if heartbeat_count:
            notes.append(f"collapsed {heartbeat_count} heartbeat/health-check lines")
        Filter._emit_notes(kept, notes)
        return self._finalize(kept)


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
        # Preserve stderr if command failed
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

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

    * **pyright**: ``src/foo.py:3: error: incompatible type``
    * **pylint**: similar: falls through to dedupe_by_key.
    * **tsc / stylelint / biome / rome**: stanza-style (like ESLint).

    Note: ``eslint`` is handled by the more specific :class:`ESLintFilter`
    which is registered before this filter in ``FILTERS``.
    """

    name = "linter"
    binaries = frozenset([
        "pyright", "pylint", "tsc",
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
        # tsc / stylelint / biome / rome: stanza-style like ESLint.
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


# --- ESLint ----------------------------------------------------------------

# ESLint summary footer: "✖ 47 problems (12 errors, 35 warnings)"
_ESLINT_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^[✖✗✘x×]\s+\d+\s+problem"
)
# ESLint issue line: "  12:8  error   'foo' is defined…   no-unused-vars"
_ESLINT_ISSUE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\d+:\d+\s+(error|warning|info)\s+.+\S\s+\S+$"
)


class ESLintFilter(Filter):
    """Compress ESLint output.

    ESLint's default formatter emits a stanza per file::

        path/to/file.js
          12:8  error    'foo' is not defined   no-undef
          15:1  warning  Missing semicolon       semi
        ...
        ✖ 47 problems (12 errors, 35 warnings)

    Compression model:

    * **Fast path**: exit 0 → collapse to ``ESLint: no errors``.
    * **Drop** file stanzas that contain zero issue lines (blank/no-problem
      files that appear only because they were linted).
    * **Keep** all ``error`` severity issue lines verbatim.
    * **Deduplicate** ``warning`` lines: keep up to 3 per rule per file, then
      summarise ``+N more <rule> warnings``.
    * **Keep** the final ``✖ N problems (N errors, N warnings)`` summary.
    """

    name = "eslint"
    binaries = frozenset(["eslint"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        # Fast path: clean exit — all we need to communicate is "no errors".
        if exit_code == 0:
            # Look for a summary line; if none present (quiet mode), emit terse.
            lines = merged.splitlines()
            summary = next(
                (ln for ln in lines if _ESLINT_SUMMARY_RE.match(ln.strip())),
                None,
            )
            return summary if summary else "ESLint: no errors"

        lines = merged.split("\n")
        out: list[str] = []
        current_file_header: str | None = None
        # Actual issue lines (matching _ESLINT_ISSUE_RE) for the current file.
        current_issues: list[str] = []
        # Has the current stanza seen at least one line matching _ESLINT_ISSUE_RE?
        current_has_issues: bool = False

        def _flush_file() -> None:
            """Emit the current file stanza, skipping zero-issue files."""
            nonlocal current_file_header, current_issues, current_has_issues
            if current_file_header is None:
                current_issues = []
                current_has_issues = False
                return
            # Drop entire stanza when no actual issue lines were collected.
            if not current_has_issues:
                current_file_header = None
                current_issues = []
                current_has_issues = False
                return
            out.append(current_file_header)
            # Group warnings by rule for deduplication; errors are always kept.
            warn_by_rule: dict[str, list[str]] = {}
            for issue in current_issues:
                m = _ESLINT_ISSUE_RE.match(issue)
                if m and m.group(1) == "warning":
                    rule = issue.rsplit(None, 1)[-1].strip()
                    warn_by_rule.setdefault(rule, []).append(issue)
                else:
                    # Non-warning (error / info / unrecognised): keep as-is.
                    out.append(issue)
            # Emit deduplicated warnings.
            for rule, entries in sorted(warn_by_rule.items()):
                out.extend(entries[:3])
                if len(entries) > 3:
                    out.append(
                        f"  [token-goat: +{len(entries) - 3} more {rule} warnings]"
                    )
            current_file_header = None
            current_issues = []
            current_has_issues = False

        for line in lines:
            # Summary footer — always keep.
            if _ESLINT_SUMMARY_RE.match(line.strip()):
                _flush_file()
                out.append(line)
                continue
            # File header line.
            if _ESLINT_FILE_RE.match(line):
                _flush_file()
                current_file_header = line
                current_issues = []
                current_has_issues = False
                continue
            # Issue line inside a stanza.
            if current_file_header is not None and _ESLINT_ISSUE_RE.match(line):
                current_issues.append(line)
                current_has_issues = True
                continue
            # Any other line (blank, etc.) outside a stanza or between stanzas.
            if current_file_header is None:
                out.append(line)
            else:
                # Non-issue line inside a stanza (e.g. blank separator).
                # Collect in issues list; only emitted if stanza has real issues.
                current_issues.append(line)

        _flush_file()
        return _squeeze_blank_lines("\n".join(out))


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


# --- Git dedicated sub-filters ------------------------------------------------
#
# These four filters provide higher-fidelity compression than the generic
# GitFilter dispatch for the four highest-volume git subcommands.  They are
# registered *before* GitFilter in FILTERS so they claim first-match priority;
# GitFilter remains the catch-all for every other git subcommand.

# ---- GitLogFilter helpers ----------------------------------------------------

_GIT_LOG_ONELINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^[0-9a-f]{7,}\s"  # short hash followed by space (--oneline format)
)
_GIT_LOG_DIFF_HUNK_RE: Final[re.Pattern[str]] = re.compile(r"^@@\s")
_GIT_LOG_MERGE_RE: Final[re.Pattern[str]] = re.compile(r"^Merge:")
_GIT_LOG_STAT_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\d+ files? changed"
)
# Lines in full-format git log that are good candidates for a one-liner summary.
_GIT_LOG_AUTHOR_RE: Final[re.Pattern[str]] = re.compile(r"^Author:\s+(.+)")
_GIT_LOG_DATE_RE: Final[re.Pattern[str]] = re.compile(r"^Date:\s+(.+)")


def _compress_git_log_enhanced(stdout: str, stderr: str, argv: list[str]) -> str:
    """Compress ``git log`` output with format-aware strategies.

    Dispatch table (examined in order):
    * ``--oneline`` / ``--format=oneline``: keep first 20 lines, collapse rest.
    * ``-p`` / ``--patch``: full-log + patch; collapse large patch sections.
    * ``--stat``: keep first 10 commit stat blocks; collapse remaining files.
    * Full format (default): collapse each commit block to one line when >10.
    """
    flags = set(argv)

    # ------------------------------------------------------------------ oneline
    is_oneline = (
        "--oneline" in flags
        or "--format=oneline" in flags
        or "--pretty=oneline" in flags
        or any(a.startswith("--format=%h") or a.startswith("--pretty=%h") for a in argv)
    )
    # Heuristic: if every non-empty line matches the short-hash pattern it's oneline.
    non_empty = [ln for ln in stdout.split("\n") if ln.strip()]
    if non_empty and all(_GIT_LOG_ONELINE_RE.match(ln) for ln in non_empty[:5]):
        is_oneline = True

    if is_oneline:
        lines = [ln for ln in stdout.split("\n") if ln.strip()]
        if len(lines) > 20:
            elided = len(lines) - 20
            kept_lines = lines[:20] + [f"[token-goat: +{elided} more commits]"]
        else:
            kept_lines = lines
        out = "\n".join(kept_lines)
        if stderr.strip():
            out += "\n---\n" + stderr.rstrip()
        return out

    # ----------------------------------------------------------------- -p patch
    is_patch = "-p" in flags or "--patch" in flags or "-u" in flags
    if is_patch:
        return _compress_git_log_patch(stdout, stderr)

    # -------------------------------------------------------------------- --stat
    is_stat = "--stat" in flags or "--shortstat" in flags or "--name-status" in flags
    if is_stat:
        return _compress_git_log_stat(stdout, stderr)

    # ---------------------------------------------------------- full format (default)
    return _compress_git_log_full(stdout, stderr)


def _compress_git_log_full(stdout: str, stderr: str) -> str:
    """Collapse each commit block to one line when there are more than 10 commits."""
    blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE)
    if not blocks:
        return stdout
    prelude = blocks[0] if not _GIT_LOG_COMMIT_RE.match(blocks[0]) else ""
    commits = [b for b in blocks if _GIT_LOG_COMMIT_RE.match(b)]
    if len(commits) <= 10:
        return stdout

    collapsed: list[str] = []
    for block in commits:
        lines = block.split("\n")
        hash_line = lines[0] if lines else ""
        # Preserve merge indicator
        merge = next((ln for ln in lines if _GIT_LOG_MERGE_RE.match(ln)), "")
        author = ""
        date_str = ""
        subject = ""
        for ln in lines:
            if not author:
                m = _GIT_LOG_AUTHOR_RE.match(ln)
                if m:
                    author = m.group(1).split("<")[0].strip()
            if not date_str:
                m = _GIT_LOG_DATE_RE.match(ln)
                if m:
                    date_str = m.group(1).strip()
            # Subject is the first non-empty indented line after a blank line
            if not subject and ln.startswith("    ") and ln.strip():
                subject = ln.strip()
        parts = [hash_line]
        if merge:
            parts.append(merge)
        detail_parts = []
        if author:
            detail_parts.append(author)
        if date_str:
            detail_parts.append(date_str)
        if subject:
            detail_parts.append(f'"{subject}"')
        if detail_parts:
            parts.append("  " + " | ".join(detail_parts))
        collapsed.append("\n".join(parts))

    text = (prelude + "\n" if prelude else "") + "\n\n".join(collapsed)
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


def _compress_git_log_patch(stdout: str, stderr: str) -> str:
    """Compress ``git log -p``: collapse large per-commit diff sections."""
    _MAX_PATCH_LINES_PER_COMMIT = 30
    blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE)
    if not blocks:
        return stdout
    prelude = blocks[0] if not _GIT_LOG_COMMIT_RE.match(blocks[0]) else ""
    commits = [b for b in blocks if _GIT_LOG_COMMIT_RE.match(b)]

    out_blocks: list[str] = []
    for block in commits:
        lines = block.split("\n")
        # Separate the commit header from the diff body.
        diff_start = next(
            (i for i, ln in enumerate(lines) if _GIT_DIFF_FILE_RE.match(ln)), None
        )
        if diff_start is None:
            # No diff section — keep as-is.
            out_blocks.append(block)
            continue
        header_lines = lines[:diff_start]
        diff_lines = lines[diff_start:]
        if len(diff_lines) > _MAX_PATCH_LINES_PER_COMMIT:
            elided = len(diff_lines) - _MAX_PATCH_LINES_PER_COMMIT
            diff_lines = (
                diff_lines[:_MAX_PATCH_LINES_PER_COMMIT]
                + [f"--- patch: {elided} lines omitted by token-goat ---"]
            )
        out_blocks.append("\n".join(header_lines + diff_lines))

    text = (prelude + "\n" if prelude else "") + "\n".join(out_blocks)
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


def _compress_git_log_stat(stdout: str, stderr: str) -> str:
    """Compress ``git log --stat``: collapse file-stat sections when >20 files."""
    _MAX_STAT_FILES = 20
    blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE)
    if not blocks:
        return stdout
    prelude = blocks[0] if not _GIT_LOG_COMMIT_RE.match(blocks[0]) else ""
    commits = [b for b in blocks if _GIT_LOG_COMMIT_RE.match(b)]

    out_blocks: list[str] = []
    for block in commits:
        lines = block.split("\n")
        # Count lines that look like file-stat entries (contain "|" with +/-)
        stat_lines = [ln for ln in lines if " | " in ln and ("++" in ln or "--" in ln)]
        if len(stat_lines) > _MAX_STAT_FILES:
            elided = len(stat_lines) - _MAX_STAT_FILES
            # Replace all stat lines with first N + summary
            new_lines: list[str] = []
            stat_idx = 0
            replaced = False
            for ln in lines:
                if " | " in ln and ("++" in ln or "--" in ln):
                    if stat_idx < _MAX_STAT_FILES:
                        new_lines.append(ln)
                    elif not replaced:
                        new_lines.append(
                            f"[token-goat: +{elided} more stat lines omitted]"
                        )
                        replaced = True
                    stat_idx += 1
                else:
                    new_lines.append(ln)
            block = "\n".join(new_lines)
        out_blocks.append(block)

    text = (prelude + "\n" if prelude else "") + "\n".join(out_blocks)
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


class GitLogFilter(Filter):
    """Compress ``git log`` output with format-aware strategies.

    Registered before :class:`GitFilter` so it claims ``git log`` exclusively.
    Handles ``--oneline``, ``-p`` / ``--patch``, ``--stat``, and the default
    full format, each with tailored compression.
    """

    name = "git-log"
    binaries = frozenset(["git"])
    subcommands = frozenset(["log"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        return _compress_git_log_enhanced(stdout, stderr, argv)


# ---- GitDiffFilter helpers ---------------------------------------------------

_GIT_DIFF_BINARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^Binary files? .+ (?:and .+ )?differ$"
)
_GIT_DIFF_STAT_FILE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\S.*\|\s+\d+"  # "  path/to/file | N ++-"
)
_GIT_DIFF_STAT_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\d+ files? changed"
)
_GIT_DIFF_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:diff --git|index |--- |[+]{3} )"
)


def _compress_git_diff_enhanced(stdout: str, stderr: str, argv: list[str]) -> str:
    """Compress ``git diff`` / ``git show`` with stat-aware strategies.

    * ``--stat`` / ``--shortstat``: if >20 files, keep first 10 + summary.
    * Default: binary file diffs → one-line summary; large hunks → truncated.
    """
    flags = set(argv)
    is_stat = "--stat" in flags or "--shortstat" in flags or "--name-only" in flags

    if is_stat:
        return _compress_git_diff_stat(stdout, stderr)

    return _compress_git_diff_body(stdout, stderr)


def _compress_git_diff_stat(stdout: str, stderr: str) -> str:
    """Collapse ``git diff --stat`` when it lists more than 20 files."""
    _MAX_STAT_FILES = 20
    _HEAD_FILES = 10
    lines = stdout.split("\n")
    stat_lines = [ln for ln in lines if _GIT_DIFF_STAT_FILE_RE.match(ln)]
    summary_lines = [ln for ln in lines if _GIT_DIFF_STAT_SUMMARY_RE.match(ln)]
    other_lines = [
        ln for ln in lines
        if not _GIT_DIFF_STAT_FILE_RE.match(ln) and not _GIT_DIFF_STAT_SUMMARY_RE.match(ln)
    ]

    if len(stat_lines) <= _MAX_STAT_FILES:
        out = stdout
    else:
        elided = len(stat_lines) - _HEAD_FILES
        # Parse +/- totals from the dropped lines for the summary
        adds = dels = 0
        for ln in stat_lines[_HEAD_FILES:]:
            adds += ln.count("+")
            dels += ln.count("-")
        kept_stat = stat_lines[:_HEAD_FILES] + [
            f" [token-goat: +{elided} more files changed, +{adds} -{dels} lines]"
        ]
        out_lines = other_lines + kept_stat + summary_lines
        out = "\n".join(out_lines)

    if stderr.strip():
        out = out.rstrip() + "\n---\n" + stderr.rstrip()
    return out


def _compress_git_diff_body(stdout: str, stderr: str) -> str:
    """Compress full diff body: binary summaries + large-hunk truncation."""
    _MAX_HUNK_LINES = 50
    _HUNK_HEAD_KEEP = 20
    _HUNK_TAIL_KEEP = 5

    file_blocks = split_blocks(stdout, _GIT_DIFF_FILE_RE)
    if not file_blocks:
        return stdout

    out_blocks: list[str] = []
    for block in file_blocks:
        if not _GIT_DIFF_FILE_RE.match(block):
            out_blocks.append(block)
            continue

        block_lines = block.split("\n")

        # Binary file: collapse to the summary line (already one line in git output).
        if any(_GIT_DIFF_BINARY_RE.match(ln) for ln in block_lines):
            binary_summary = next(
                (ln for ln in block_lines if _GIT_DIFF_BINARY_RE.match(ln)), None
            )
            # Keep the diff --git header line for file context.
            header = block_lines[0] if block_lines else ""
            if binary_summary:
                out_blocks.append(header + "\n" + binary_summary)
            else:
                out_blocks.append(block)
            continue

        # Large-hunk truncation: compress each hunk independently.
        hunks = split_blocks(block, _GIT_DIFF_HUNK_RE)
        if len(hunks) <= 1:
            # No hunks or single hunk smaller than threshold — pass through.
            out_blocks.append(block)
            continue

        compressed_hunks: list[str] = []
        for hunk in hunks:
            hunk_lines = hunk.split("\n")
            # Keep all --- +++ header lines (they are in the non-hunk first block).
            changed = [
                ln for ln in hunk_lines
                if ln.startswith("+") or ln.startswith("-")
            ]
            if len(changed) > _MAX_HUNK_LINES:
                head = hunk_lines[:_HUNK_HEAD_KEEP]
                tail = hunk_lines[-_HUNK_TAIL_KEEP:]
                omitted = len(hunk_lines) - _HUNK_HEAD_KEEP - _HUNK_TAIL_KEEP
                compressed_hunks.append(
                    "\n".join(head)
                    + f"\n... {omitted} lines omitted by token-goat ...\n"
                    + "\n".join(tail)
                )
            else:
                compressed_hunks.append(hunk)
        out_blocks.append("\n".join(compressed_hunks))

    text = "\n".join(out_blocks)
    if stderr.strip():
        text += "\n---\n" + stderr.rstrip()
    return text


class GitDiffFilter(Filter):
    """Compress ``git diff`` and ``git show`` output.

    Handles binary-file summaries, large-hunk truncation, and ``--stat`` mode.
    Registered before :class:`GitFilter` so it claims ``git diff`` / ``git show``
    exclusively with richer compression than the baseline three-hunk cap.
    """

    name = "git-diff"
    binaries = frozenset(["git"])
    subcommands = frozenset(["diff", "show"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        return _compress_git_diff_enhanced(stdout, stderr, argv)


# ---- GitStatusVerboseFilter helpers -----------------------------------------

_GIT_STATUS_UNTRACKED_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^Untracked files:"
)
_GIT_STATUS_NOISE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\(use \"git (?:add|restore|rm|checkout|reset)"
    r"|^no changes added to commit"
    r"|^nothing to commit, working tree clean"
    r"|^nothing added to commit but untracked files present"
)


def _compress_git_status_verbose(stdout: str, stderr: str) -> str:
    """Compress full ``git status``.

    * Short / porcelain format (lines start with ``M ``, ``?? ``, etc.) is
      passed through as-is — already compact.
    * Full verbose format: strip boilerplate advice lines; if untracked file
      list exceeds 10 items, keep first 5 + count marker.
    """
    lines = stdout.split("\n")
    if not lines:
        return stdout

    # Detect short/porcelain format: non-empty lines all match XY-space pattern.
    non_empty = [ln for ln in lines if ln.strip()]
    _SHORT_STATUS_RE = re.compile(r"^[MADRCU?! ][MADRCU?! ] ")
    if non_empty and all(_SHORT_STATUS_RE.match(ln) for ln in non_empty[:5]):
        # Already compact — pass through.
        out = stdout
        if stderr.strip():
            out = out.rstrip() + "\n---\n" + stderr.rstrip()
        return out

    # Full verbose mode: strip noise lines, truncate untracked file list.
    kept: list[str] = []
    in_untracked = False
    untracked_files: list[str] = []

    for line in lines:
        if _GIT_STATUS_NOISE_RE.match(line):
            continue
        if _GIT_STATUS_UNTRACKED_HEADER_RE.match(line):
            in_untracked = True
            kept.append(line)
            continue
        if in_untracked:
            # Untracked file entries are indented with a tab.
            if line.startswith("\t") and line.strip():
                untracked_files.append(line)
                continue
            else:
                # Flush collected untracked files.
                _MAX_UNTRACKED = 5
                if len(untracked_files) > _MAX_UNTRACKED:
                    elided = len(untracked_files) - _MAX_UNTRACKED
                    kept.extend(untracked_files[:_MAX_UNTRACKED])
                    kept.append(
                        f"\t[token-goat: +{elided} more untracked files]"
                    )
                else:
                    kept.extend(untracked_files)
                untracked_files = []
                in_untracked = False
                kept.append(line)
                continue
        kept.append(line)

    # Flush any trailing untracked section.
    if untracked_files:
        _MAX_UNTRACKED = 5
        if len(untracked_files) > _MAX_UNTRACKED:
            elided = len(untracked_files) - _MAX_UNTRACKED
            kept.extend(untracked_files[:_MAX_UNTRACKED])
            kept.append(f"\t[token-goat: +{elided} more untracked files]")
        else:
            kept.extend(untracked_files)

    out = "\n".join(kept)
    if stderr.strip():
        out = out.rstrip() + "\n---\n" + stderr.rstrip()
    return _squeeze_blank_lines(out)


class GitStatusVerboseFilter(Filter):
    """Compress ``git status`` output.

    * Passes short / porcelain format (``-s`` / ``--short``) through unchanged.
    * Full verbose format: removes boilerplate advice lines; truncates untracked
      file lists exceeding 10 items to first 5 + count.

    Registered before :class:`GitFilter` for higher-fidelity status handling.
    """

    name = "git-status"
    binaries = frozenset(["git"])
    subcommands = frozenset(["status"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        return _compress_git_status_verbose(stdout, stderr)


# ---- GitBlameFilter helpers --------------------------------------------------

_GIT_BLAME_LINE_RE: Final[re.Pattern[str]] = re.compile(
    # Porcelain format: 40-char hash + line-no + ...  OR
    # Standard annotated format: hash (Author Date) line content
    r"^([0-9a-f]{7,40})\s"
)
_GIT_BLAME_AUTHOR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\^?([0-9a-f]{7,40})\s+\(([^)]+?)\s+\d{4}-\d\d-\d\d"
)


def _compress_git_blame(stdout: str, stderr: str) -> str:
    """Compress ``git blame``: collapse consecutive same-commit runs.

    For each run of lines attributed to the same commit hash, emit the first
    line of the run verbatim followed by a collapse marker; subsequent lines
    in the run are dropped.  This can reduce a large blame output by 80%+ on
    files with stable authorship.
    """
    lines = stdout.split("\n")
    if not lines:
        return stdout

    # Determine if this is porcelain format (40-hex-char at start).
    _PORCELAIN_RE = re.compile(r"^[0-9a-f]{40} \d+ \d+")
    is_porcelain = any(_PORCELAIN_RE.match(ln) for ln in lines[:5] if ln.strip())

    if is_porcelain:
        return _compress_git_blame_porcelain(lines, stderr)

    return _compress_git_blame_annotated(lines, stderr)


def _compress_git_blame_annotated(lines: list[str], stderr: str) -> str:
    """Collapse same-author runs in standard annotated blame format."""
    out: list[str] = []
    current_hash: str | None = None
    current_author: str | None = None
    run_count = 0
    run_start_line: str = ""

    def _flush() -> None:
        if run_count == 0:
            return
        out.append(run_start_line)
        if run_count > 1:
            out.append(
                f"[token-goat: {run_count - 1} more lines by {current_author} ({current_hash[:8] if current_hash else '?'})]"
            )

    for line in lines:
        m = _GIT_BLAME_AUTHOR_RE.match(line)
        if m:
            commit_hash = m.group(1)[:8]
            author = m.group(2).strip()
            if commit_hash == current_hash:
                run_count += 1
            else:
                _flush()
                current_hash = commit_hash
                current_author = author
                run_start_line = line
                run_count = 1
        else:
            # Non-blame line (empty, separator, etc.) — flush and emit as-is.
            _flush()
            current_hash = None
            current_author = None
            run_count = 0
            run_start_line = ""
            out.append(line)

    _flush()
    out_text = "\n".join(out)
    if stderr.strip():
        out_text += "\n---\n" + stderr.rstrip()
    return out_text


def _compress_git_blame_porcelain(lines: list[str], stderr: str) -> str:
    """Collapse same-commit runs in porcelain blame format (``git blame --porcelain``)."""
    _PORCELAIN_HEADER_RE = re.compile(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$")
    _AUTHOR_RE = re.compile(r"^author (.+)")

    out: list[str] = []
    current_hash: str | None = None
    current_author: str | None = None
    run_count = 0
    block_lines: list[str] = []

    i = 0
    while i < len(lines):
        line = lines[i]
        m = _PORCELAIN_HEADER_RE.match(line)
        if m:
            commit_hash = m.group(1)
            if commit_hash == current_hash:
                # Same commit — scan forward past this block's metadata to the content line.
                run_count += 1
                i += 1
                while i < len(lines) and not lines[i].startswith("\t"):
                    i += 1
                i += 1  # skip the content line
                continue
            else:
                # New commit — flush previous run.
                if block_lines:
                    out.extend(block_lines)
                    if run_count > 1:
                        out.append(
                            f"[token-goat: {run_count - 1} more lines by "
                            f"{current_author} ({current_hash[:8] if current_hash else '?'})]"
                        )
                # Start new block.
                current_hash = commit_hash
                current_author = None
                run_count = 1
                block_lines = [line]
                i += 1
                # Collect metadata lines until the content line.
                while i < len(lines) and not lines[i].startswith("\t"):
                    meta = lines[i]
                    am = _AUTHOR_RE.match(meta)
                    if am:
                        current_author = am.group(1).strip()
                    block_lines.append(meta)
                    i += 1
                if i < len(lines):
                    block_lines.append(lines[i])  # content line
                    i += 1
                continue
        else:
            out.append(line)
            i += 1

    # Flush final block.
    if block_lines:
        out.extend(block_lines)
        if run_count > 1:
            out.append(
                f"[token-goat: {run_count - 1} more lines by "
                f"{current_author} ({current_hash[:8] if current_hash else '?'})]"
            )

    out_text = "\n".join(out)
    if stderr.strip():
        out_text += "\n---\n" + stderr.rstrip()
    return out_text


class GitBlameFilter(Filter):
    """Compress ``git blame`` output by collapsing same-commit/author runs.

    Handles both the default annotated format and ``--porcelain``.  A file
    with stable authorship (e.g. written by one person) can be compressed
    from hundreds of lines to a handful.

    Registered before :class:`GitFilter` so it claims ``git blame`` exclusively.
    """

    name = "git-blame"
    binaries = frozenset(["git"])
    subcommands = frozenset(["blame"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        return _compress_git_blame(stdout, stderr)


# --- Go ----------------------------------------------------------------

# `go test [-v] ./...` emits a distinctive line shape per testcase that is
# disjoint from `go build` output, so it warrants dedicated handling.  The
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

# go build / go mod / go vet / go generate patterns
_GO_BUILD_PKG_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^#\s+[a-zA-Z0-9./\-]+"
)
_GO_MOD_DOWNLOADING_RE: Final[re.Pattern[str]] = re.compile(
    r"^go: (downloading|extracting) "
)
_GO_VET_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^go: vet "
)
_GO_GENERATE_TRIGGER_RE: Final[re.Pattern[str]] = re.compile(
    r"^go:generate "
)
# Generic go error pattern: file:line:col: error|warning message
_GO_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^[^:\s]+:\d+:\d+:\s+(?:error|warning):"
)


class GoTestFilter(Filter):
    """Compress ``go test`` output.

    Go test emits a line per testcase plus pass/fail summaries. When tests pass,
    the output is hundreds of lines of ``=== RUN TestName`` / ``--- PASS: TestName``
    pairs plus final summary. Failures emit stderr blocks interleaved with the
    pass/fail lines.

    Compression model:

    * **Keep**: FAIL / ERROR blocks (entire stderr captured under the RUN line).
    * **Keep**: Final summary (ok, FAILED, coverage %).
    * **Drop**: All ``=== RUN TestName`` lines that don't precede a FAIL.
    * **Drop**: All ``--- PASS: TestName`` / ``--- SKIP: TestName`` lines (count them).
    * **Drop**: ``go: downloading ...`` lines (often hundreds when deps aren't cached).
    """

    name = "go-test"
    binaries = frozenset(["go"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem != "go":
            return False
        # Fire only for `go test` subcommand; other go subcommands fall through.
        positionals = _positional_args(argv[1:])
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
            # FAIL / SKIP open a multi-line block preserved until next testcase.
            if _GO_TEST_FAIL_RE.match(line):
                in_fail_block = True
                kept.append(line)
                continue
            if _GO_TEST_PASS_RE.match(line):
                in_fail_block = False
                pass_count += 1
                continue
            if _GO_TEST_RUN_RE.match(line):
                # === RUN inside a FAIL block is the next testcase header —
                # close the block but keep the new RUN line for structure.
                # Outside a FAIL block, drop the RUN entirely.
                if in_fail_block:
                    in_fail_block = False
                else:
                    dropped_run += 1
                    continue
            # Indented continuation lines under a FAIL block — preserve.
            if in_fail_block and (line.startswith(("    ", "\t")) or not line.strip()):
                kept.append(line)
                continue
            # Anything else: preserve and exit fail block.
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


# --- GoFilter (go build / run / get / mod / install / clean) ------------------

#: ``go build ./...`` → keep error lines, drop "# pkg/path" headers
#: Reuses _GO_BUILD_PKG_HEADER_RE and _GO_MOD_DOWNLOADING_RE defined above.

#: ``go get`` / ``go mod download``: "go: downloading module@version"
_GO_GET_DOWNLOADING_RE: Final[re.Pattern[str]] = re.compile(
    r"^go: (downloading|extracting|finding|fetching)\s"
)
#: ``go mod tidy`` / ``go get`` informational lines (non-error)
_GO_MOD_INFO_RE: Final[re.Pattern[str]] = re.compile(
    r"^go: found\s|^go: added\s|^go: upgraded\s|^go: downgraded\s|^go: removed\s"
)
#: ``go run`` header / build phase noise
_GO_RUN_BUILDING_RE: Final[re.Pattern[str]] = re.compile(
    r"^go: building\s|^go: warning:"
)
#: ``go test ./...`` package-level result: "ok  pkg Xs" or "FAIL pkg Xs" or "?   pkg"
_GO_PKG_OK_RE: Final[re.Pattern[str]] = re.compile(
    r"^ok\s+\S"
)
_GO_PKG_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:FAIL|---)\s+\S"
)
#: Generic go error line (reuses _GO_ERROR_RE for file:line:col pattern)
#: but also covers plain "go build: ..." error messages
_GO_BUILD_ERROR_PLAIN_RE: Final[re.Pattern[str]] = re.compile(
    r"^go\s+\w+:|^# .*\(exit status"
)


class GoFilter(Filter):
    """Compress ``go build``, ``go run``, ``go get``, ``go mod``, ``go install``
    and ``go clean`` output.

    These subcommands emit download-progress spam, ``# pkg/path`` package
    header lines that carry no signal on success, and ``go: downloading …``
    dependency-fetch lines that can number in the hundreds. Signal is
    concentrated in error/warning diagnostics and the final status line.

    Compression model:

    * **go build / go install / go run** (pre-build phase):
      Drop ``# pkg/path`` package-header lines when the build succeeds
      (they have no error following them); keep all file:line:col error
      and warning lines verbatim.
    * **go get / go mod download**:
      Collapse ``go: downloading …`` / ``go: extracting …`` / ``go: finding …``
      lines to a single count note.
    * **go mod tidy**:
      Keep ``go: found/added/upgraded/downgraded/removed …`` module-change
      lines (these carry signal); collapse repetitive download lines.
    * **go test ./...** (package-level results only — per-test detail is
      handled by :class:`GoTestFilter`):
      Collapse ``ok  pkg Xs`` passing-package lines to a count; keep all
      ``FAIL pkg`` lines verbatim.

    ``go test`` is explicitly excluded from this filter's :meth:`matches`
    so that :class:`GoTestFilter` (registered first) handles it.
    """

    name = "go"
    binaries = frozenset(["go"])

    #: Subcommands handled by this filter.  ``test`` is intentionally absent
    #: so GoTestFilter (registered before GoFilter) wins for ``go test``.
    _GO_SUBCOMMANDS: frozenset[str] = frozenset([
        "build", "run", "get", "mod", "install", "clean", "generate",
        "vet", "env", "fix",
    ])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem != "go":
            return False
        positionals = _positional_args(argv[1:])
        # No subcommand (bare ``go``) or unrecognised — don't match, let
        # MakeFilter catch it as a generic build tool.
        if not positionals:
            return False
        return positionals[0] in self._GO_SUBCOMMANDS

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        if subcommand in ("get",) or (
            subcommand == "mod" and len(positionals) > 1 and positionals[1] == "download"
        ):
            return self._compress_go_get(lines)
        if subcommand == "mod":
            return self._compress_go_mod_tidy(lines)
        if subcommand in ("build", "install", "run", "clean", "fix", "env"):
            return self._compress_go_build_like(lines, exit_code)
        if subcommand in ("vet", "generate"):
            return self._compress_go_vet_like(lines, subcommand)
        # Fallback: apply download-line collapsing only.
        return self._compress_go_get(lines)

    # ------------------------------------------------------------------
    # Subcommand helpers
    # ------------------------------------------------------------------

    def _compress_go_build_like(self, lines: list[str], exit_code: int) -> str:
        """``go build`` / ``go install`` / ``go run``: drop headers, keep errors."""
        kept: list[str] = []
        dropped_headers = 0
        dropped_downloads = 0

        for line in lines:
            if _GO_GET_DOWNLOADING_RE.match(line) or _GO_MOD_DOWNLOADING_RE.match(line):
                dropped_downloads += 1
                continue
            if _GO_BUILD_PKG_HEADER_RE.match(line):
                # On success these carry no info.  On failure they precede the
                # actual error lines which we always keep, so suppress them
                # unconditionally — the errors that follow are enough context.
                dropped_headers += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if dropped_headers:
            notes.append(f"suppressed {dropped_headers} package header lines")
        if dropped_downloads:
            notes.append(f"collapsed {dropped_downloads} 'go: downloading' lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_go_get(self, lines: list[str]) -> str:
        """``go get`` / ``go mod download``: collapse download lines to count."""
        kept: list[str] = []
        dropped_downloads = 0

        for line in lines:
            if _GO_GET_DOWNLOADING_RE.match(line) or _GO_MOD_DOWNLOADING_RE.match(line):
                dropped_downloads += 1
                continue
            kept.append(line)

        if dropped_downloads:
            kept.append(
                f"[token-goat: collapsed {dropped_downloads} "
                f"'go: downloading/extracting' lines]"
            )
        return self._finalize(kept)

    def _compress_go_mod_tidy(self, lines: list[str]) -> str:
        """``go mod tidy``: keep module-change lines, collapse downloads."""
        kept: list[str] = []
        dropped_downloads = 0

        for line in lines:
            if _GO_GET_DOWNLOADING_RE.match(line) or _GO_MOD_DOWNLOADING_RE.match(line):
                dropped_downloads += 1
                continue
            # Module-change informational lines are always kept (signal).
            kept.append(line)

        if dropped_downloads:
            kept.append(
                f"[token-goat: collapsed {dropped_downloads} "
                f"'go: downloading/extracting' lines]"
            )
        return self._finalize(kept)

    def _compress_go_vet_like(self, lines: list[str], subcommand: str) -> str:
        """``go vet`` / ``go generate``: drop progress noise, keep warnings."""
        kept: list[str] = []
        dropped_progress = 0

        for line in lines:
            if _GO_VET_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            if _GO_GENERATE_TRIGGER_RE.match(line):
                dropped_progress += 1
                continue
            kept.append(line)

        if dropped_progress:
            kept.append(
                f"[token-goat: dropped {dropped_progress} '{subcommand}' progress lines]"
            )
        return self._finalize(kept)


# --- Make / Ninja / Gradle / Maven / Go build / mod / vet / generate ----------

_MAKE_RECURSE_RE: Final[re.Pattern[str]] = re.compile(
    r"^make\[\d+\]: (Entering|Leaving) directory"
)
_MAKE_ECHO_RE: Final[re.Pattern[str]] = re.compile(r"^(echo |cc |gcc |clang |g\+\+ )")


class MakeFilter(Filter):
    """Compress ``make`` / ``ninja`` / ``gradle`` / ``mvn`` / ``go build`` / ``go mod``
    / ``go vet`` / ``go generate`` output.

    Build systems and go subcommands emit one line per compilation unit, package,
    or progress marker. Errors and warnings are the only things the agent
    typically cares about.

    Compression model:

    * **Drop** ``make[N]: Entering/Leaving directory '...'`` recursion noise.
    * **Drop** plain ``cc``/``clang``/``g++`` invocation echoes: keep only
      the diagnostic lines (warning / error / undefined reference).
    * **Keep** every ``warning:`` / ``error:`` block.
    * **Keep** the final ``Error 1`` / ``BUILD FAILED`` summary.
    * **Go build**: suppress package header lines (``# pkg/path``), keep errors.
    * **Go mod**: suppress ``go: downloading/extracting`` progress, keep require changes.
    * **Go vet**: suppress ``go: vet`` progress lines, keep all warnings.
    * **Go generate**: suppress ``go:generate`` trigger lines, keep errors.
    """

    name = "make"
    binaries = frozenset([
        "make", "gmake", "ninja", "gradle", "mvn", "maven", "bazel", "buck",
        "go", "goimports",
    ])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Detect go subcommands (build, mod, vet, generate) for specialized handling.
        positionals = _positional_args(argv)
        go_subcommand = ""
        if positionals and Path(positionals[0]).stem.lower() == "go":
            go_subcommand = positionals[1] if len(positionals) > 1 else ""

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        if go_subcommand == "build":
            return self._compress_go_build(lines)
        if go_subcommand == "mod":
            return self._compress_go_mod(lines)
        if go_subcommand == "vet":
            return self._compress_go_vet(lines)
        if go_subcommand == "generate":
            return self._compress_go_generate(lines)

        # Generic make/ninja/gradle compression.
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

    def _compress_go_build(self, lines: list[str]) -> str:
        """Compress ``go build`` output: drop headers, keep errors."""
        kept: list[str] = []
        dropped_headers = 0

        for line in lines:
            if line.startswith("go: downloading"):
                # Suppress download progress lines.
                continue
            if _GO_BUILD_PKG_HEADER_RE.match(line):
                # Suppress "# package/path" headers.
                dropped_headers += 1
                continue
            # Always keep error and warning lines.
            if _GO_ERROR_RE.match(line):
                kept.append(line)
                continue
            # Keep build summary lines and blank lines.
            kept.append(line)

        if dropped_headers:
            kept.append(
                f"[token-goat: suppressed {dropped_headers} package header lines; "
                f"compile succeeded]"
            )
        return self._finalize(kept)

    def _compress_go_mod(self, lines: list[str]) -> str:
        """Compress ``go mod tidy`` output: drop download progress, keep changes."""
        kept: list[str] = []
        dropped_downloads = 0

        for line in lines:
            if _GO_MOD_DOWNLOADING_RE.match(line):
                dropped_downloads += 1
                continue
            kept.append(line)

        if dropped_downloads:
            kept.append(
                f"[token-goat: dropped {dropped_downloads} 'go: downloading/extracting' lines]"
            )
        return self._finalize(kept)

    def _compress_go_vet(self, lines: list[str]) -> str:
        """Compress ``go vet`` output: drop progress, keep all warnings."""
        kept: list[str] = []
        dropped_progress = 0

        for line in lines:
            if _GO_VET_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            kept.append(line)

        if dropped_progress:
            kept.append(f"[token-goat: dropped {dropped_progress} 'go: vet' progress lines]")
        return self._finalize(kept)

    def _compress_go_generate(self, lines: list[str]) -> str:
        """Compress ``go generate`` output: drop triggers, keep errors."""
        kept: list[str] = []
        dropped_triggers = 0

        for line in lines:
            if _GO_GENERATE_TRIGGER_RE.match(line):
                dropped_triggers += 1
                continue
            kept.append(line)

        if dropped_triggers:
            kept.append(
                f"[token-goat: dropped {dropped_triggers} 'go:generate' trigger lines]"
            )
        return self._finalize(kept)


# --- Terraform -------------------------------------------------------------

#: Terraform state refresh/read progress lines (one per resource, often hundreds).
_TF_REFRESH_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9_.\[\]\"-]+: (Refreshing state|Reading|Read complete|Still |Modifications complete)"
)
#: Terraform plan/apply summary line: ``Plan: 5 to add, 2 to change, 1 to destroy.``
_TF_PLAN_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^Plan: \d+ to (add|change|destroy|import)"
)
#: Terraform "No changes" plan output — resource is unchanged.
_TF_NO_CHANGES_RE: Final[re.Pattern[str]] = re.compile(
    r"^No changes\.|^(?:This plan does nothing|Nothing to do\.)",
    re.IGNORECASE,
)
#: Terraform "Still creating..." / "Still modifying..." progress lines.
_TF_STILL_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9_.\[\]\"-]+: Still (?:creating|modifying|destroying)\.\.\.",
    re.IGNORECASE,
)
#: Terraform apply completion: ``Apply complete! Resources: 5 added, 2 changed, 1 destroyed.``
_TF_APPLY_COMPLETE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Apply complete! Resources:"
)
#: Terraform creation/destruction completion lines.
_TF_RESOURCE_COMPLETE_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9_.\[\]\"-]+: (?:Creation|Destruction|Modifications?) complete",
    re.IGNORECASE,
)
#: Terraform error or warning markers.
_TF_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Error|Warning):|FAILED"
)


class TerraformFilter(Filter):
    """Compress ``terraform plan`` / ``apply`` / ``init`` / ``validate`` / ``show`` output.

    Terraform prints per-resource ``Refreshing state…`` lines (one per object,
    often hundreds), then a giant diff with full resource bodies (mostly
    unchanged attributes). Init outputs progress bars. Plan/apply produce
    multi-line summaries.

    Compression model:

    * **terraform plan**: Drop refresh/read progress, keep the ``Plan: N to add…``
      summary line + last 20 lines (detailed plan output can be thousands).
    * **terraform apply**: Keep the ``Apply complete! Resources: N …`` summary
      line + any error lines; drop refresh progress.
    * **terraform init**: Keep first 5 + last 5 lines (progress bars are noisy).
    * **terraform validate**: Keep all (usually short; diagnostics are brief).
    * **terraform show** / **terraform state**: Use head=20, tail=10 compression.
    * **Errors** (exit_code != 0): Keep all stderr unchanged.
    """

    name = "terraform"
    binaries = frozenset(["terraform", "tofu", "terragrunt"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Preserve all stderr on error.
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        text = stdout

        if subcommand == "plan":
            text = self._compress_terraform_plan(text)
        elif subcommand == "apply":
            text = self._compress_terraform_apply(text, stderr)
        elif subcommand == "init":
            if "\n" in text:
                non_empty = [ln for ln in text.split("\n") if ln.strip()]
                if len(non_empty) > 10:
                    text = _head_tail_compress(non_empty, head=5, tail=5, label="init lines")
                else:
                    text = "\n".join(non_empty)
        elif subcommand in ("validate", "validate-config"):
            # Pass through; validate output is typically brief.
            pass
        elif subcommand in ("show", "state"):
            non_empty = [ln for ln in text.split("\n") if ln.strip()]
            if len(non_empty) > 30:
                text = _head_tail_compress(non_empty, head=20, tail=10, label="lines")
            else:
                text = "\n".join(non_empty)
        else:
            # Unknown or missing subcommand: still strip terraform noise (Refreshing
            # state / Read complete lines) that appears in any terraform output.
            lines = text.split("\n")
            filtered = [ln for ln in lines if not _TF_REFRESH_RE.search(ln)]
            if len(filtered) > 30:
                filtered = [ln for ln in filtered if ln.strip()]
                text = _head_tail_compress(filtered, head=10, tail=20, label="lines")
            elif len(filtered) < len(lines):
                text = "\n".join(filtered)

        if stderr.strip() and subcommand not in ("apply",):
            # For non-apply commands, append stderr if not already included.
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text

    def _compress_terraform_plan(self, stdout: str) -> str:
        """Compress terraform plan output.

        Drops refresh/read lines, collapses ``No changes.`` blocks for
        unchanged resources, keeps addition/deletion/modification blocks,
        keeps the ``Plan: N to add…`` summary line, and keeps the last 20
        lines of detailed plan diff.
        """
        lines = stdout.split("\n")
        kept: list[str] = []
        dropped_refresh = 0
        dropped_no_change_blocks = 0
        plan_summary_idx = -1

        # First pass: identify the plan summary line index in the raw list.
        for i, line in enumerate(lines):
            if _TF_PLAN_SUMMARY_RE.match(line):
                plan_summary_idx = i
                break

        # Second pass: filter refresh lines and collapse "No changes." blocks.
        # A "No changes." block is: ``# resource.name is unchanged`` header
        # followed by lines until the next blank or ``#`` header.  We drop the
        # whole block because the Plan summary line already communicates the
        # count.
        i = 0
        while i < len(lines):
            line = lines[i]
            # Drop refresh/read progress lines.
            if _TF_REFRESH_RE.match(line):
                dropped_refresh += 1
                i += 1
                continue
            # Detect "# resource will not be changed" / "No changes." blocks.
            if (
                line.startswith("# ")
                and ("will not be" in line or "is up-to-date" in line or "not be created" in line)
            ):
                # Skip this comment block (indented body lines until the next blank line,
                # ``#`` block header, or plan-summary line — whichever comes first).
                i += 1
                while i < len(lines):
                    body = lines[i]
                    if not body.strip():
                        break  # blank line = block separator
                    if body.startswith("# "):
                        break  # next block comment
                    if _TF_PLAN_SUMMARY_RE.match(body) or _TF_APPLY_COMPLETE_RE.match(body):
                        break  # plan/apply summary — stop before consuming it
                    i += 1
                dropped_no_change_blocks += 1
                continue
            if _TF_NO_CHANGES_RE.match(line):
                # "No changes." — keep this single summary line (it's the plan result).
                kept.append(line)
                i += 1
                continue
            kept.append(line)
            i += 1

        # If we have a plan summary, keep it and the last 20 lines.
        if plan_summary_idx >= 0:
            summary_line = None
            tail_start = max(0, len(lines) - 20)
            final_kept: list[str] = []
            for line in kept:
                if _TF_PLAN_SUMMARY_RE.match(line):
                    summary_line = line
                    break
            if summary_line:
                final_kept.append(summary_line)
            # Append tail lines (excluding the summary if it's in the tail).
            for j, line in enumerate(lines):
                if j >= tail_start and j != plan_summary_idx:
                    if _TF_REFRESH_RE.match(line):
                        continue
                    final_kept.append(line)
            kept = final_kept

        notes: list[str] = []
        if dropped_refresh:
            notes.append(f"dropped {dropped_refresh} terraform refresh/read lines")
        if dropped_no_change_blocks:
            notes.append(f"collapsed {dropped_no_change_blocks} unchanged-resource block(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_terraform_apply(self, stdout: str, stderr: str) -> str:
        """Compress terraform apply output.

        Collapses ``Still creating…`` / ``Still modifying…`` progress lines to
        the last status per resource; keeps ``Creation complete`` /
        ``Destruction complete``; keeps ``Apply complete!`` summary; keeps
        all error blocks verbatim.
        """
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_refresh = 0
        # resource_key -> last "Still ..." line seen
        still_last: dict[str, str] = {}
        still_dropped = 0

        for line in lines:
            # Check resource-completion lines BEFORE the refresh filter because
            # _TF_REFRESH_RE also matches "Modifications complete" (which is a
            # completion signal, not noise).
            if _TF_RESOURCE_COMPLETE_RE.match(line):
                resource_key = line.split(":")[0].strip()
                last_still = still_last.pop(resource_key, None)
                if last_still:
                    kept.append(last_still)
                kept.append(line)
                continue
            if _TF_REFRESH_RE.match(line):
                dropped_refresh += 1
                continue
            # Collapse "Still creating/modifying..." — track last per resource.
            if _TF_STILL_RE.match(line):
                # Extract resource key (everything before ": Still")
                resource_key = line.split(": Still")[0].strip()
                if resource_key in still_last:
                    still_dropped += 1
                still_last[resource_key] = line
                continue
            if _TF_APPLY_COMPLETE_RE.match(line) or _TF_ERROR_RE.match(line):
                kept.append(line)
                continue
            # Keep non-refresh, non-progress lines.
            if line.strip():
                kept.append(line)

        # Flush any remaining "Still..." lines that didn't get a completion event.
        for last_still in still_last.values():
            kept.append(last_still)

        notes: list[str] = []
        if dropped_refresh:
            notes.append(f"dropped {dropped_refresh} terraform refresh/read lines")
        if still_dropped:
            notes.append(f"collapsed {still_dropped} Still creating/modifying line(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- AWS CLI (enhanced) ----------------------------------------------------

#: Matches AWS S3 upload lines: ``upload: local/path to s3://bucket/key``
_AWS_UPLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^upload:\s+\S+\s+to\s+s3://",
    re.IGNORECASE,
)
#: Matches AWS S3 download lines: ``download: s3://bucket/key to local/path``
_AWS_DOWNLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^download:\s+s3://",
    re.IGNORECASE,
)
#: Matches AWS S3 progress/transfer-rate lines emitted during cp/sync.
_AWS_S3_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Completed\s+\d|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|B)/s|Calculating|"
    r"upload\s+failed:|download\s+failed:)",
    re.IGNORECASE,
)


class AwsCliFilter(Filter):
    """Enhanced AWS CLI filter with S3 transfer collapsing and describe/list array truncation.

    Extends the intent of the existing :class:`AwsFilter` with targeted rules
    for the most common verbose patterns:

    * **JSON arrays > 10 items** (``describe-*`` / ``list-*``): collapse to
      "N items (showing first 3)" keeping only the first 3 items.
    * **S3 upload/download lines**: collapse to a count summary.
    * **S3 progress bars**: drop; keep only the final transfer summary line.
    * **Error messages**: kept verbatim (non-zero exit code or ``ERROR``/``An error``).
    """

    name = "aws-cli"
    binaries = frozenset(["aws", "aws2"])

    # number of items to keep from a large JSON array
    _JSON_ARRAY_THRESHOLD: int = 10
    _JSON_ARRAY_KEEP: int = 3

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Preserve all stderr on error.
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        positionals = _positional_args(argv[1:])
        # S3 transfer subcommands get transfer-line collapsing.
        is_s3_transfer = (
            len(positionals) >= 2
            and positionals[0] == "s3"
            and positionals[1] in ("cp", "sync", "mv")
        )

        text = stdout
        if is_s3_transfer:
            text = self._compress_s3_transfer(text)
        else:
            compressed = self._compress_json_array(text)
            if compressed is not None:
                text = compressed

        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text

    def _compress_json_array(self, text: str) -> str | None:
        """Collapse top-level or nested JSON arrays > _JSON_ARRAY_THRESHOLD items.

        Returns the compressed JSON string or ``None`` when no compression was
        applied (not JSON, or array is short enough).
        """
        import json  # noqa: PLC0415

        stripped = text.strip()
        if not stripped or stripped[0] not in "{[":
            return None
        try:
            data = json.loads(stripped)
        except (ValueError, json.JSONDecodeError):
            return None

        keep = self._JSON_ARRAY_KEEP
        threshold = self._JSON_ARRAY_THRESHOLD
        changed = False

        if isinstance(data, list) and len(data) > threshold:
            total = len(data)
            data = data[:keep]
            data.append({"__token_goat__": f"{total} items (showing first {keep})"})
            changed = True
        elif isinstance(data, dict):
            for key, value in list(data.items()):
                if isinstance(value, list) and len(value) > threshold:
                    total = len(value)
                    data[key] = [
                        *value[:keep],
                        {"__token_goat__": f"{total} items (showing first {keep})"},
                    ]
                    changed = True
        if not changed:
            return None
        return json.dumps(data, indent=2)

    def _compress_s3_transfer(self, text: str) -> str:
        """Collapse S3 upload/download lines and progress bars to count summaries."""
        lines = text.split("\n")
        kept: list[str] = []
        upload_count = 0
        download_count = 0
        progress_dropped = 0

        for line in lines:
            if _AWS_UPLOAD_RE.match(line):
                upload_count += 1
                continue
            if _AWS_DOWNLOAD_RE.match(line):
                download_count += 1
                continue
            if _AWS_S3_PROGRESS_RE.match(line):
                progress_dropped += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if upload_count:
            notes.append(f"uploaded {upload_count} file(s)")
        if download_count:
            notes.append(f"downloaded {download_count} file(s)")
        if progress_dropped:
            notes.append(f"dropped {progress_dropped} progress line(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Google Cloud SDK -------------------------------------------------------

#: gcloud progress spinner characters (braille spinner).
_GCLOUD_SPINNER_RE: Final[re.Pattern[str]] = re.compile(
    r"^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s",
)
#: gcloud "Updated/Created/Deleted [URL]" status lines — always keep.
_GCLOUD_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Updated|Created|Deleted)\s+\[https?://",
    re.IGNORECASE,
)
#: gcloud API enablement verbose lines.
_GCLOUD_API_ENABLE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Enabling service|Waiting for async operation|Operation \[operation-)",
    re.IGNORECASE,
)
#: gcloud "Do you want to continue" prompt — keep.
_GCLOUD_CONTINUE_RE: Final[re.Pattern[str]] = re.compile(
    r"Do you want to continue",
    re.IGNORECASE,
)


class GcloudFilter(Filter):
    """Compress ``gcloud`` (Google Cloud SDK) output.

    Compression model:

    * **Spinner lines** (⠏⠋⠙… prefix): dropped entirely.
    * **"Updated/Created/Deleted [url]"**: kept verbatim (actionable signal).
    * **"Do you want to continue (Y/n)?"**: kept verbatim.
    * **API enablement verbose lines**: collapsed to count.
    * **Large JSON/YAML resource descriptions** (> 20 lines of structured data):
      collapsed to ``Resource description: N lines (use --format=json for full output)``.
    * **Errors** (non-zero exit code): kept verbatim.
    """

    name = "gcloud"
    binaries = frozenset(["gcloud"])

    _STRUCTURED_LINE_THRESHOLD: int = 20

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        text = self._compress_gcloud(stdout)
        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text

    def _compress_gcloud(self, text: str) -> str:
        lines = text.split("\n")
        kept: list[str] = []
        spinners_dropped = 0
        api_enable_dropped = 0

        for line in lines:
            # Drop braille spinner progress lines.
            if _GCLOUD_SPINNER_RE.match(line):
                spinners_dropped += 1
                continue
            # Collapse API enablement verbose lines.
            if _GCLOUD_API_ENABLE_RE.match(line):
                api_enable_dropped += 1
                continue
            kept.append(line)

        # Check if the kept output is a large structured-data block.
        kept = self._maybe_collapse_structured(kept)

        notes: list[str] = []
        if spinners_dropped:
            notes.append(f"dropped {spinners_dropped} spinner line(s)")
        if api_enable_dropped:
            notes.append(f"collapsed {api_enable_dropped} API enablement line(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _maybe_collapse_structured(self, lines: list[str]) -> list[str]:
        """If the output looks like a large structured data block, collapse it."""
        non_empty = [ln for ln in lines if ln.strip()]
        if len(non_empty) <= self._STRUCTURED_LINE_THRESHOLD:
            return lines
        # Heuristic: structured data lines contain ":", "{", "}", "[", "]", "-"
        # at high density with no obvious prose patterns.
        structured_chars = frozenset(":{[]-")
        structured_count = sum(
            1 for ln in non_empty
            if any(ch in ln for ch in structured_chars)
            and not _GCLOUD_STATUS_RE.match(ln)
            and not _GCLOUD_CONTINUE_RE.search(ln)
        )
        ratio = structured_count / len(non_empty) if non_empty else 0.0
        if ratio >= 0.7:
            return [
                f"[Resource description: {len(non_empty)} lines "
                f"(use --format=json to see full output)]"
            ]
        return lines


# --- Azure CLI --------------------------------------------------------------

#: Azure CLI "Command group ... is in preview" warning.
_AZ_PREVIEW_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Command group|The command|This command).*\bis in preview",
    re.IGNORECASE,
)
#: Azure CLI "Resource provider ... is not registered" — actionable, keep.
_AZ_PROVIDER_RE: Final[re.Pattern[str]] = re.compile(
    r"Resource provider .* is not registered",
    re.IGNORECASE,
)
#: Azure CLI long-running operation progress JSON blobs.
#: e.g. {"status": "Running", "percentComplete": 50.0}
_AZ_PROGRESS_JSON_RE: Final[re.Pattern[str]] = re.compile(
    r'^\s*\{[^}]*"(?:status|percentComplete|provisioningState)"[^}]*\}\s*$',
)


class AzureCliFilter(Filter):
    """Compress ``az`` (Azure CLI) output.

    Compression model:

    * **Progress JSON blobs** (``{"status": "Running", ...}``): collapsed to
      the final status only.
    * **"Command group ... is in preview" warnings**: collapsed to a count.
    * **"Resource provider ... is not registered"**: kept verbatim (actionable).
    * **JSON arrays > 10 items**: collapsed to first 3 + count, like
      :class:`AwsCliFilter`.
    * **Error messages** (non-zero exit code): kept verbatim.
    """

    name = "azure-cli"
    binaries = frozenset(["az"])

    _JSON_ARRAY_THRESHOLD: int = 10
    _JSON_ARRAY_KEEP: int = 3

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        err_output = _preserve_stderr_on_error(stdout, stderr, exit_code)
        if err_output is not None:
            return err_output

        text = self._compress_az(stdout)
        if stderr.strip():
            text = (text.rstrip() + "\n---\n" + stderr.rstrip()) if text.strip() else stderr
        return text

    def _compress_az(self, text: str) -> str:
        # Try JSON array compression first (whole document).
        compressed = self._compress_json_array(text)
        if compressed is not None:
            return compressed

        lines = text.split("\n")
        kept: list[str] = []
        preview_dropped = 0
        last_progress_status: str | None = None
        in_progress_run = False

        for line in lines:
            # Collapse "is in preview" warnings.
            if _AZ_PREVIEW_RE.match(line):
                preview_dropped += 1
                continue
            # Collapse intermediate progress JSON blobs; keep the last one.
            if _AZ_PROGRESS_JSON_RE.match(line):
                last_progress_status = line.strip()
                in_progress_run = True
                continue
            # When we leave a progress-json run, emit the last status.
            if in_progress_run:
                if last_progress_status:
                    kept.append(last_progress_status)
                in_progress_run = False
                last_progress_status = None
            kept.append(line)

        # Flush any trailing progress run.
        if in_progress_run and last_progress_status:
            kept.append(last_progress_status)

        notes: list[str] = []
        if preview_dropped:
            notes.append(f"collapsed {preview_dropped} preview warning(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_json_array(self, text: str) -> str | None:
        """Collapse top-level or nested JSON arrays > _JSON_ARRAY_THRESHOLD items."""
        import json  # noqa: PLC0415

        stripped = text.strip()
        if not stripped or stripped[0] not in "{[":
            return None
        try:
            data = json.loads(stripped)
        except (ValueError, json.JSONDecodeError):
            return None

        keep = self._JSON_ARRAY_KEEP
        threshold = self._JSON_ARRAY_THRESHOLD
        changed = False

        if isinstance(data, list) and len(data) > threshold:
            total = len(data)
            data = data[:keep]
            data.append({"__token_goat__": f"{total} items (showing first {keep})"})
            changed = True
        elif isinstance(data, dict):
            for key, value in list(data.items()):
                if isinstance(value, list) and len(value) > threshold:
                    total = len(value)
                    data[key] = [
                        *value[:keep],
                        {"__token_goat__": f"{total} items (showing first {keep})"},
                    ]
                    changed = True
        if not changed:
            return None
        return json.dumps(data, indent=2)


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
#: Ansible-lint rule code pattern: ``rule-name:`` at line start.
_ANSIBLE_LINT_RULE_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9\-]+:\s+"
)


class AnsibleFilter(Filter):
    """Compress ``ansible`` / ``ansible-playbook`` / ``ansible-galaxy`` / ``ansible-lint`` output.

    Ansible playbook runs emit one ``ok: [host]`` (or ``changed:``/``skipping:``)
    line per (task × host).  On a 30-host inventory with 50 tasks this is 1500
    progress lines for a fully-successful run — pure noise unless a host
    failed.  The signal lives in: PLAY/TASK headers, any ``fatal:`` /
    ``failed:`` / ``unreachable:`` / ``[WARNING]`` lines, and the final
    ``PLAY RECAP`` block.

    ``ansible-galaxy install`` emits a progress line per package; compress
    with head=5, tail=5.

    ``ansible-lint`` emits rule violations (often 100+); group by rule code
    and keep only the first 3 examples per rule.

    Compression model (playbook):

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

    Compression model (ansible-lint):

    * **Group** violations by rule code.
    * **Keep** first 3 examples per rule (most rules are repetitive).
    * **Keep** the final summary line (``X linting errors found``).
    """

    name = "ansible"
    binaries = frozenset([
        "ansible", "ansible-playbook", "ansible-pull", "ansible-console",
        "ansible-galaxy", "ansible-lint",
    ])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Detect the binary name from argv[0].
        binary_name = Path(argv[0]).name.lower() if argv else ""

        # ansible-lint has its own compression.
        if "ansible-lint" in binary_name:
            return self._compress_ansible_lint(stdout, stderr)

        # ansible-galaxy has a simpler compression (head/tail).
        if "ansible-galaxy" in binary_name:
            return self._compress_ansible_galaxy(stdout, stderr)

        # Default: ansible, ansible-playbook, ansible-pull compression.
        return self._compress_ansible_playbook(stdout, stderr)

    def _compress_ansible_playbook(self, stdout: str, stderr: str) -> str:
        """Compress ansible-playbook output: collapse status lines, keep headers & recap."""
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        # Pending status counts for the current task.
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

    def _compress_ansible_lint(self, stdout: str, stderr: str) -> str:
        """Compress ansible-lint output: group by rule, keep first 3 per rule."""
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        # Group violations by rule code: code -> list of lines.
        by_rule: dict[str, list[str]] = {}
        # Non-violation lines (headers, summary, blank lines).
        other_lines: list[str] = []

        for line in lines:
            m = _ANSIBLE_LINT_RULE_RE.match(line)
            if m:
                rule_code = line.split(":", 1)[0].strip()
                if rule_code not in by_rule:
                    by_rule[rule_code] = []
                by_rule[rule_code].append(line)
            else:
                other_lines.append(line)

        # Build output: rules + summaries.
        kept.extend(other_lines)

        # Group violations: per rule, keep first 3 examples.
        emitted_rules: set[str] = set()
        # Rebuild: interleave violations grouped by rule.
        kept = []
        for line in other_lines:
            kept.append(line)
            m = _ANSIBLE_LINT_RULE_RE.match(line)
            if m:
                rule_code = line.split(":", 1)[0].strip()
                if rule_code in by_rule and rule_code not in emitted_rules:
                    # Emit first 3 examples.
                    for i, viol_line in enumerate(by_rule[rule_code][:3]):
                        if i > 0:
                            kept.append(viol_line)
                    if len(by_rule[rule_code]) > 3:
                        kept.append(
                            f"[token-goat: {len(by_rule[rule_code]) - 3} more occurrences of "
                            f"{rule_code} elided]"
                        )
                    emitted_rules.add(rule_code)

        return self._finalize(kept)

    def _compress_ansible_galaxy(self, stdout: str, stderr: str) -> str:
        """Compress ansible-galaxy output: head=5, tail=5 for install progress."""
        merged = self._combine_output(stdout, stderr)
        non_empty = [ln for ln in merged.split("\n") if ln.strip()]
        if len(non_empty) > 10:
            return _head_tail_compress(non_empty, head=5, tail=5, label="galaxy lines")
        return "\n".join(non_empty)


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

#: pip -v/-vv verbose debug lines: "DEBUG pip._internal...: ..."
_PIP_VERBOSE_DEBUG_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:DEBUG|VERBOSE|TRACE)\b"
)
#: pip -v HTTP/network trace lines: "  Added ... to ...", "  https?://...",
#:   "  Querying PyPI", "  Checking if link is supported"
_PIP_VERBOSE_HTTP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+(?:https?://|Added \S+ to |Querying |Checking if link|"
    r"Created temporary directory|Looking up|Skipping link|"
    r"Local version label|File was already downloaded|"
    r"\d+ location\(s\) for)\b"
)


class PipFilter(Filter):
    """Compress ``pip install`` / ``uv pip install`` / ``poetry install`` output.

    Pip emits ``Downloading X.whl (10 MB)`` lines per dependency plus the
    final ``Successfully installed`` list.  When everything succeeds the
    interesting line is just the final tally.

    Compression model:

    * **Drop** ``Downloading …`` progress lines.
    * **Drop** ``Using cached …`` (wheel already in pip cache).
    * **Drop** ``Building wheel for …`` / ``Created wheel for …`` / ``Stored in
      directory …`` build-wheel noise lines.
    * **Drop** ``Installing build dependencies`` / ``Preparing metadata``
      build-env setup chatter.
    * **Drop** ``Obtaining file://…`` editable-install path lines.
    * **Cap** ``Collecting …`` at 5 lines (keep first 5, summarise the rest).
    * **Keep** every ``error:`` / ``warning:`` / ``ERROR`` line verbatim.
    * **Keep** the final ``Successfully installed …`` / ``already satisfied``
      line and any requirement-not-found or conflict lines.
    * **Verbose mode** (``-v`` / ``--verbose`` in argv): also drop ``DEBUG``/
      ``VERBOSE``/``TRACE`` log lines and HTTP-trace chatter that pip emits
      when verbose flags are present.
    """

    name = "pip"
    binaries = frozenset(["pip", "pip3", "pipx"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        verbose = "-v" in argv or "--verbose" in argv or any(
            a.startswith("-v") and all(c == "v" for c in a[1:]) for a in argv if a.startswith("-")
        )
        kept: list[str] = []
        downloads = 0
        build_noise = 0
        collects = 0
        verbose_dropped = 0
        for line in lines:
            # Always preserve error/warning lines even in verbose mode.
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Verbose-mode extra noise: DEBUG/VERBOSE/TRACE log lines and HTTP trace.
            if verbose and (
                _PIP_VERBOSE_DEBUG_RE.match(line)
                or _PIP_VERBOSE_HTTP_RE.match(line)
            ):
                verbose_dropped += 1
                continue
            # Download progress (pip < 22 uses 2-space indent, newer uses no indent).
            if line.startswith("  Downloading ") or line.startswith("Downloading "):
                downloads += 1
                continue
            # Wheel cache hits — zero value for the model.
            if line.startswith("  Using cached ") or line.startswith("Using cached "):
                downloads += 1  # count alongside downloads (all are "fetch noise")
                continue
            # Build-wheel lifecycle noise.
            if (
                line.startswith("  Building wheel") or line.startswith("Building wheel")
                or line.startswith("  Created wheel") or line.startswith("Created wheel")
                or line.startswith("  Stored in directory") or line.startswith("Stored in directory")
                or line.startswith("  Installing build dep") or line.startswith("Installing build dep")
                or line.startswith("  Preparing metadata") or line.startswith("Preparing metadata")
                or line.startswith("  Getting requirements") or line.startswith("Getting requirements")
                or line.startswith("  Obtaining file://") or line.startswith("Obtaining file://")
            ):
                build_noise += 1
                continue
            if line.startswith("Collecting ") or line.startswith("  Collecting "):
                collects += 1
                if collects <= 5:
                    kept.append(line)
                continue
            kept.append(line)
        notes: list[str] = []
        if collects > 5:
            notes.append(f"+{collects - 5} more 'Collecting' lines elided")
        if downloads:
            notes.append(f"dropped {downloads} download/cache-hit lines")
        if build_noise:
            notes.append(f"dropped {build_noise} build-wheel/metadata lines")
        if verbose_dropped:
            notes.append(f"dropped {verbose_dropped} verbose debug/trace lines")
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
    """Compress ``uv sync`` / ``uv add`` / ``uv remove`` / ``uv pip`` / ``uv tool`` output.

    uv emits verbose per-package ``Downloading`` / ``Fetching`` lines while
    resolving and installing dependencies plus per-package ``+``/``-`` diff
    lines.  The interesting lines are the summary lines emitted at the end
    (``Resolved N packages``, ``Installed N packages``, ``Uninstalled N
    packages``, ``Audited N packages``).  Errors and warnings are always
    preserved.

    Also handles ``uv tool install/upgrade/uninstall`` and ``uv python install``
    which emit the same progress-bar noise while downloading tool binaries and
    Python interpreter builds.

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
        positionals = [tok for tok in argv[1:] if not tok.startswith("-")]
        if not positionals:
            return False
        first = positionals[0]
        # Direct package-management subcommands of ``uv``.
        pm_subcommands = frozenset([
            "sync", "add", "remove", "install", "uninstall", "pip", "lock",
        ])
        if first in pm_subcommands:
            return True
        # ``uv tool <action>`` — install/upgrade/uninstall emit the same
        # Downloading/Fetching noise as package management.  Exclude ``uv tool
        # run`` (handled by prefix-stripping + inner-tool filter).
        if first == "tool" and len(positionals) >= 2:
            tool_action = positionals[1]
            return tool_action in {"install", "upgrade", "uninstall", "update"}
        # ``uv python install`` / ``uv python pin`` — may emit interpreter
        # download progress.
        if first == "python" and len(positionals) >= 2:
            python_action = positionals[1]
            return python_action in {"install", "pin"}
        return False

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Detect freeze/list subcommands: ``uv pip freeze`` / ``uv pip list``
        positionals = [tok for tok in argv[1:] if not tok.startswith("-")]
        is_freeze_or_list = (
            len(positionals) >= 2
            and positionals[0] == "pip"
            and positionals[1] in {"freeze", "list"}
        )
        merged = self._combine_output(stdout, stderr)
        if is_freeze_or_list:
            return self._compress_freeze_list(merged)
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

    def _compress_freeze_list(self, text: str) -> str:
        """Compress ``uv pip freeze`` / ``uv pip list`` output.

        When the list exceeds 50 package lines, keep the first 20 and
        append a count summary.  Error lines are always preserved verbatim.
        """
        lines = [ln for ln in text.split("\n") if ln.strip()]
        # Preserve error lines regardless of list length.
        error_lines = [ln for ln in lines if _ERROR_SIGNAL_RE.search(ln)]
        pkg_lines = [ln for ln in lines if not _ERROR_SIGNAL_RE.search(ln)]
        _UV_FREEZE_THRESHOLD = 50
        _UV_FREEZE_SHOW = 20
        if len(pkg_lines) <= _UV_FREEZE_THRESHOLD:
            return text.rstrip()
        shown = pkg_lines[:_UV_FREEZE_SHOW]
        remaining = len(pkg_lines) - _UV_FREEZE_SHOW
        result = shown + [f"[token-goat: {remaining} more packages elided; use uv pip freeze for full list]"]
        if error_lines:
            result.extend(error_lines)
        return "\n".join(result)


# --- conda -------------------------------------------------------------------

#: Conda download/extract progress bar lines
_CONDA_DOWNLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:[A-Za-z0-9_\-.]+-[\d.]+\s+\||\[[-#\s]+\]|\d+%|\d+\s*(?:KB|MB|kB|B)/s|"
    r"Downloading and Extracting Packages:)",
)
#: Conda individual package install lines: "  - pkgname version build"
_CONDA_PKG_INSTALL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s{2}-\s+\S"
)
#: Conda solving/metadata lines to keep (status lines)
_CONDA_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Collecting package metadata|Solving environment|Preparing transaction|"
    r"Executing transaction|Verifying transaction|done\b)",
    re.IGNORECASE,
)


class CondaFilter(Filter):
    """Compress ``conda install`` / ``conda create`` / ``conda list`` output.

    Conda emits verbose per-package download progress, solver output, and
    install listings.  The interesting signals are the phase headers, solver
    outcome, and final transaction summary.

    Compression model for ``conda install`` / ``conda create``:

    * **Keep** phase headers: "Collecting package metadata...", "Solving
      environment:", "Preparing transaction:", "Executing transaction:", "done".
    * **Drop** progress bar lines (``[####] 100%``, speed/size bars, "Downloading
      and Extracting Packages:" body lines) — collapse to a count summary.
    * **Collapse** individual package install lines (``  - pkgname version``) to
      a count summary.
    * **Keep** every ``error:`` / ``ERROR`` / ``CondaError`` line verbatim.

    Compression model for ``conda list``:

    * **Pass-through** when ≤ 50 lines.
    * **Truncate** to first 20 lines + count when > 50 lines.

    Compression model for ``conda env export``:

    * **Pass-through** when ≤ 50 lines (YAML header + deps).
    * **Truncate** dep lines to first 20 + count when > 50 lines.
    """

    name = "conda"
    binaries = frozenset(["conda", "mamba", "micromamba"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem not in self.binaries:
            return False
        positionals = [tok for tok in argv[1:] if not tok.startswith("-")]
        if not positionals:
            return True
        return positionals[0] in {
            "install", "create", "update", "upgrade", "remove", "uninstall",
            "list", "env",
        }

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = [tok for tok in argv[1:] if not tok.startswith("-")]
        subcmd = positionals[0] if positionals else ""

        merged = self._combine_output(stdout, stderr)

        # ``conda list`` — simple package listing
        if subcmd == "list":
            return self._compress_pkg_list(merged, label="conda list")

        # ``conda env export`` — YAML with pinned deps
        if subcmd == "env" and len(positionals) >= 2 and positionals[1] == "export":
            return self._compress_env_export(merged)

        # ``conda install`` / ``conda create`` / ``conda update`` / ``conda remove``
        return self._compress_install(merged)

    def _compress_install(self, text: str) -> str:
        """Compress conda install/create/update/remove output."""
        lines = text.split("\n")
        kept: list[str] = []
        downloads_dropped = 0
        pkg_installs = 0
        in_download_section = False

        for line in lines:
            # Always preserve error lines.
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                in_download_section = False
                continue
            # Detect "Downloading and Extracting Packages:" section header.
            if re.match(r"^Downloading and Extracting Packages", line, re.IGNORECASE):
                in_download_section = True
                kept.append(line)
                continue
            # End download section when we see a blank line or a new phase.
            if in_download_section:
                if not line.strip():
                    in_download_section = False
                    kept.append(line)
                    continue
                if _CONDA_STATUS_RE.match(line):
                    in_download_section = False
                    # Fall through to normal processing below.
                elif _CONDA_DOWNLOAD_RE.match(line) or line.strip().startswith("|"):
                    downloads_dropped += 1
                    continue
                elif re.match(r"^\s{2,}[\w.-]", line):
                    # Package progress bar row like "  pkgname-1.0 | 100 KB |"
                    downloads_dropped += 1
                    continue
                else:
                    in_download_section = False
            # Phase header lines — always keep.
            if _CONDA_STATUS_RE.match(line):
                kept.append(line)
                continue
            # Individual package install diff lines "  - pkgname version build"
            if _CONDA_PKG_INSTALL_RE.match(line):
                pkg_installs += 1
                continue
            # Progress bar noise outside download section.
            if _CONDA_DOWNLOAD_RE.match(line):
                downloads_dropped += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if downloads_dropped:
            notes.append(f"collapsed {downloads_dropped} download/progress lines")
        if pkg_installs:
            notes.append(f"collapsed {pkg_installs} package install lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_pkg_list(self, text: str, label: str = "packages") -> str:
        """Compress ``conda list`` output (>50 packages → first 20 + count)."""
        lines = text.split("\n")
        # Preserve header comment lines (start with #).
        header = [ln for ln in lines if ln.startswith("#")]
        pkg_lines = [ln for ln in lines if ln.strip() and not ln.startswith("#")]
        _THRESHOLD = 50
        _SHOW = 20
        if len(pkg_lines) <= _THRESHOLD:
            return text.rstrip()
        shown = header + pkg_lines[:_SHOW]
        remaining = len(pkg_lines) - _SHOW
        shown.append(f"[token-goat: {remaining} more packages elided; run conda list for full output]")
        return "\n".join(shown)

    def _compress_env_export(self, text: str) -> str:
        """Compress ``conda env export`` YAML (>50 dep lines → first 20 + count)."""
        lines = text.split("\n")
        # Separate YAML header (name:, channels:, prefix:) from dep lines.
        dep_lines: list[str] = []
        other_lines: list[str] = []
        in_deps = False
        for ln in lines:
            if ln.strip().startswith("dependencies:"):
                in_deps = True
                other_lines.append(ln)
            elif in_deps and re.match(r"^\s+-\s", ln):
                dep_lines.append(ln)
            else:
                if in_deps:
                    in_deps = False
                other_lines.append(ln)

        _THRESHOLD = 50
        _SHOW = 20
        if len(dep_lines) <= _THRESHOLD:
            return text.rstrip()

        # Find insertion point (after "dependencies:" line).
        dep_start_idx = next(
            (i for i, ln in enumerate(other_lines) if ln.strip().startswith("dependencies:")),
            len(other_lines),
        )
        remaining = len(dep_lines) - _SHOW
        result = (
            other_lines[: dep_start_idx + 1]
            + dep_lines[:_SHOW]
            + [f"  # [token-goat: {remaining} more dependencies elided]"]
            + other_lines[dep_start_idx + 1 :]
        )
        return "\n".join(result)


# --- pnpm -------------------------------------------------------------------

#: pnpm per-package download/fetch progress lines
_PNPM_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:Resolving|Downloading|Fetching)[:\s].*\d+/\d+"
    r"|\s+\d+\s+packages?\s+(?:fetched|resolved|downloaded|linked)"
)
#: pnpm lockfile/packages summary lines to keep
_PNPM_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Packages:|Already up to date|Progress:|WARN|ERR!|added|removed|changed)",
    re.IGNORECASE,
)


class PnpmFilter(Filter):
    """Compress ``pnpm install`` / ``pnpm add`` / ``pnpm run`` output.

    pnpm emits resolver/download progress lines while installing packages.
    The interesting signals are the ``Packages: +N -M`` summary and the
    lockfile change notice.

    Compression model for ``pnpm install`` / ``pnpm add``:

    * **Keep** "Packages: +N -M" (install summary) → always kept.
    * **Keep** "Already up to date" → kept.
    * **Keep** lockfile change lines (``Lockfile is up to date``, ``Saved
      lockfile``) → kept.
    * **Collapse** individual package download/fetch progress (``Resolving N/M``,
      ``Downloading N/M``) → count note.
    * **Keep** every ``warn``/``ERR!``/error line verbatim.

    Compression model for ``pnpm run <script>``:

    * Prepend "pnpm run: " label to first non-empty output line, keep rest.
    """

    name = "pnpm"
    binaries = frozenset(["pnpm"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem == "pnpm"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = [tok for tok in argv[1:] if not tok.startswith("-")]
        subcmd = positionals[0] if positionals else ""

        merged = self._combine_output(stdout, stderr)

        if subcmd == "run" and len(positionals) >= 2:
            return self._compress_run(merged, positionals[1])

        # install / add / remove / update / import
        return self._compress_install(merged)

    def _compress_install(self, text: str) -> str:
        lines = text.split("\n")
        kept: list[str] = []
        progress_dropped = 0

        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Keep summary/status lines verbatim.
            if _PNPM_SUMMARY_RE.match(line):
                kept.append(line)
                continue
            # Lockfile / workspace notices.
            if re.match(r"^\s*(?:Lockfile|Saved|node_modules|symlink)", line, re.IGNORECASE):
                kept.append(line)
                continue
            # Collapse resolver/download progress.
            if _PNPM_PROGRESS_RE.search(line):
                progress_dropped += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if progress_dropped:
            notes.append(f"collapsed {progress_dropped} resolver/download progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_run(self, text: str, script: str) -> str:
        """Prepend 'pnpm run <script>: ' to the first non-empty output line."""
        lines = text.split("\n")
        out: list[str] = []
        labelled = False
        for line in lines:
            if not labelled and line.strip():
                out.append(f"pnpm run {script}: {line}")
                labelled = True
            else:
                out.append(line)
        return self._finalize(out)


# --- yarn -------------------------------------------------------------------

#: Yarn classic fetch individual package lines
_YARN_CLASSIC_FETCH_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:Fetching|Saving|Linking)\s+dependency\s+graph"
    r"|\[2/4\]\s+Fetching\s+packages\.\.\.\s*$"
    r"|\s{2,}Fetching\s+\S"
)
#: Yarn classic warning dedup key (normalize warning message)
_YARN_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^warning\s+", re.IGNORECASE,
)
#: Yarn berry (v2+) resolution/fetch progress
_YARN_BERRY_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^➤\s+YN\d{4}:\s+(?:[│└]\s+)?\S.*(?:\d+/\d+|\d+\.\d+\s*[KMG]?B)"
)
#: Yarn berry "Done" summary line
_YARN_BERRY_DONE_RE: Final[re.Pattern[str]] = re.compile(
    r"^➤\s+YN0000:\s+·\s+Done"
)


class YarnFilter(Filter):
    """Compress ``yarn install`` output for both classic (v1) and berry (v2+).

    Yarn classic emits ``[1/4]`` phase headers and per-package fetch lines.
    Yarn berry (PnP) emits ``YN####`` structured log lines.

    Compression model — Yarn classic:

    * **Keep** "yarn install v1.X.X" banner → kept.
    * **Keep** "[1/4] Resolving packages..." / "[3/4] Linking dependencies..."
      / "[4/4] Building..." phase lines → kept.
    * **Collapse** "[2/4] Fetching packages..." body (individual fetch lines)
      → count summary.
    * **Keep** "Done in Xs." → kept.
    * **Deduplicate** ``warning ...`` lines (keep first occurrence per
      unique message prefix).

    Compression model — Yarn berry:

    * **Keep** resolution summary (``YN0000: Resolution step``) → kept.
    * **Collapse** per-package fetch progress lines → count summary.
    * **Keep** ``YN0000: Done`` → kept.
    * **Keep** every ``YN0001`` (error) line verbatim.
    """

    name = "yarn"
    binaries = frozenset(["yarn"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem.endswith(".exe"):
            stem = stem[:-4]
        return stem == "yarn"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        # Detect berry by presence of YN#### prefixes.
        if re.search(r"^➤\s+YN\d{4}:", merged, re.MULTILINE):
            return self._compress_berry(merged)
        return self._compress_classic(merged)

    def _compress_classic(self, text: str) -> str:
        """Compress yarn classic (v1) install output."""
        lines = text.split("\n")
        kept: list[str] = []
        fetch_dropped = 0
        warnings_seen: dict[str, int] = {}
        in_fetch_phase = False

        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                in_fetch_phase = False
                continue
            # Deduplicate warning lines.
            if _YARN_WARNING_RE.match(line):
                # Key on the first 60 chars of the warning message.
                key = line[:60]
                warnings_seen[key] = warnings_seen.get(key, 0) + 1
                if warnings_seen[key] == 1:
                    kept.append(line)
                # else: duplicate warning — silently drop
                continue
            # Detect fetch phase start: "[2/4] Fetching packages..."
            if re.match(r"^\[2/4\]", line):
                in_fetch_phase = True
                kept.append(line)
                continue
            # Any other phase header ends the fetch phase.
            if re.match(r"^\[\d/\d\]", line):
                in_fetch_phase = False
                kept.append(line)
                continue
            # In fetch phase: collapse individual package fetch lines.
            if in_fetch_phase and line.strip() and not re.match(r"^\[", line):
                fetch_dropped += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if fetch_dropped:
            notes.append(f"collapsed {fetch_dropped} individual fetch lines")
        dup_warnings = sum(v - 1 for v in warnings_seen.values() if v > 1)
        if dup_warnings:
            notes.append(f"deduplicated {dup_warnings} repeated warning lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_berry(self, text: str) -> str:
        """Compress yarn berry (v2+) install output."""
        lines = text.split("\n")
        kept: list[str] = []
        fetch_dropped = 0

        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Always keep error YN codes (YN0001) and done line.
            if re.match(r"^➤\s+YN0001:", line) or _YARN_BERRY_DONE_RE.match(line):
                kept.append(line)
                continue
            # Collapse per-package fetch progress (lines with byte counts or N/M).
            if _YARN_BERRY_PROGRESS_RE.match(line):
                fetch_dropped += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if fetch_dropped:
            notes.append(f"collapsed {fetch_dropped} per-package fetch/progress lines")
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
        if len(non_empty) <= 60:
            return "\n".join(lines).rstrip()
        return _head_tail_compress(non_empty, head=40, tail=10, label="items").rstrip()

    def _compress_flat_listing(
        self, lines: list[str], non_empty: list[str], argv: list[str],
    ) -> str:
        """Compress flat listing: keep header, first 25 items, last 5."""
        if len(non_empty) <= 30:
            return "\n".join(lines).rstrip()

        # Identify header line (usually contains column names like "permissions size date")
        header_idx = 0
        if non_empty and any(kw in non_empty[0].lower() for kw in ["permission", "size", "date", "user", "name"]):
            header_idx = 1

        kept: list[str] = []

        # Add header lines
        if header_idx > 0:
            kept.extend(non_empty[:header_idx])

        # Compress data lines using the helper
        data_lines = non_empty[header_idx:]
        if len(data_lines) > 30:
            data_compressed = _head_tail_compress(data_lines, head=25, tail=5, label="entries")
            kept.extend(data_compressed.split("\n"))
        else:
            kept.extend(data_lines)

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

        return _head_tail_compress(non_empty, head=35, tail=5, label="paths")


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

        return _head_tail_compress(non_empty, head=50, tail=10, label="items").rstrip()


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

        return _head_tail_compress(non_empty, head=40, tail=10, label="lines").rstrip()


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

        return _head_tail_compress(non_empty, head=60, tail=20, label="lines").rstrip()


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

        return _head_tail_compress(non_empty, head=40, tail=10, label="lines").rstrip()


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

        return _head_tail_compress(non_empty, head=150, tail=50, label="lines").rstrip()


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

        return _head_tail_compress(non_empty, head=100, tail=50, label="lines").rstrip()


# --- curl / wget (HTTP clients) --------------------------------------------

# curl -v prefix characters: '*' = metadata, '>' = request, '<' = response headers.
# The trailing bare '>' (empty separator after request headers) has no trailing space,
# so we match '>' or '*' followed by optional whitespace or end-of-line.
_CURL_VERBOSE_META_RE: Final[re.Pattern[str]] = re.compile(r"^[*>](\s|$)")
# The response status line: "< HTTP/1.1 200 OK" or "< HTTP/2 404"
_CURL_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^<\s+HTTP/[\d.]+\s+(\d{3})"
)
# Response headers we care about (content-type, location, content-length)
_CURL_USEFUL_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^<\s+(content-type|location|content-length|www-authenticate|x-ratelimit):",
    re.IGNORECASE,
)
# curl progress bars: "  % Total    % Received..." / "100  1234"
_CURL_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+%\s+Total|^\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+"
)
# wget log lines: "--YYYY-MM-DD HH:MM:SS--" / "Resolving ..." / "Connecting ..."
_WGET_NOISE_RE: Final[re.Pattern[str]] = re.compile(
    r"^--\d{4}-\d{2}-\d{2}|^(Resolving|Connecting to|Reusing|Sending|Saving to|HTTP request sent|Length:|Location:)"
)
_WGET_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^HTTP request sent|(\d{3} [A-Za-z ]+)\."
)


class CurlFilter(Filter):
    """Compress ``curl`` and ``wget`` HTTP client output.

    These tools are frequently invoked with ``-v`` (verbose) or ``-I`` flags,
    producing TLS handshake details, per-header dumps, and progress bars that
    overwhelm the actual signal (HTTP status code + response body).

    Compression model:

    * **curl -v / --verbose**: drop ``*`` (connection metadata) and ``>``
      (request headers) lines entirely.  Of the ``<`` (response header) lines,
      keep only the status line and a small allowlist of useful headers
      (Content-Type, Location, Content-Length).
    * **curl progress bars**: drop the ``  % Total  % Received …`` progress
      table lines (emitted to stderr when not redirected).
    * **wget**: drop connection-setup noise lines; keep the HTTP status and
      the final ``saved`` / ``error`` line.
    * **Response body**: always preserved verbatim (that is the payload).
    * **Errors**: any line containing ``curl: (N)`` or ``wget: …`` error text
      is preserved verbatim.
    """

    name = "curl"
    binaries = frozenset(["curl", "wget"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        binary = Path(argv[0]).stem.lower() if argv else "curl"
        # curl writes body to stdout and verbose/progress to stderr by default.
        # wget writes progress to stderr and body to stdout (or file).
        combined = self._combine_output(stdout, stderr)
        lines = combined.split("\n")
        kept: list[str] = []
        dropped_meta = 0
        dropped_req_headers = 0
        dropped_resp_headers = 0
        dropped_progress = 0

        if binary == "wget":
            for line in lines:
                if _WGET_NOISE_RE.match(line):
                    dropped_meta += 1
                    continue
                kept.append(line)
        else:
            # curl
            for line in lines:
                if _CURL_PROGRESS_RE.match(line):
                    dropped_progress += 1
                    continue
                if _CURL_STATUS_RE.match(line):
                    # Keep response status verbatim (strip leading "< ")
                    kept.append(line[2:].strip() if line.startswith("< ") else line)
                    continue
                if _CURL_USEFUL_HEADER_RE.match(line):
                    # Keep useful response headers (strip leading "< ")
                    kept.append(line[2:].strip() if line.startswith("< ") else line)
                    dropped_resp_headers += 0  # counted below
                    continue
                if line.startswith("< "):
                    # Other response headers: drop silently
                    dropped_resp_headers += 1
                    continue
                if _CURL_VERBOSE_META_RE.match(line):
                    if line.startswith(">"):
                        dropped_req_headers += 1
                    else:
                        dropped_meta += 1
                    continue
                kept.append(line)

        notes: list[str] = []
        if dropped_meta:
            notes.append(f"dropped {dropped_meta} connection-metadata lines")
        if dropped_req_headers:
            notes.append(f"dropped {dropped_req_headers} request-header lines")
        if dropped_resp_headers:
            notes.append(f"dropped {dropped_resp_headers} response-header lines")
        if dropped_progress:
            notes.append(f"dropped {dropped_progress} progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- rsync -----------------------------------------------------------------

# rsync per-file transfer lines: "     1,234 100%  123.45kB/s    0:00:00 (xfr#1, to-chk=99/100)"
_RSYNC_FILE_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+[\d,]+\s+\d+%\s"
)
# rsync summary lines we want to keep
_RSYNC_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(sent|received|total size|Number of files|Number of created|Number of deleted|Number of regular|speedup)"
)
# rsync error / warning lines
_RSYNC_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(error|ERROR|failed|cannot|permission denied|No such file|rsync error)\b"
)


class RsyncFilter(Filter):
    """Compress ``rsync`` file-synchronisation output.

    ``rsync -av`` emits one line per transferred file (can be thousands of
    lines for a large tree), followed by a compact statistics summary.  The
    per-file list is noise unless something fails.

    Compression model:

    * **Drop** per-file transfer lines (``path/to/file``) except on error.
    * **Drop** inline progress bars (``  100%  123kB/s``).
    * **Keep** all lines matching error/warning patterns verbatim.
    * **Keep** the statistics summary (``sent … received … total size …``).
    * **Summarise** dropped file count so the agent knows how many were synced.
    """

    name = "rsync"
    binaries = frozenset(["rsync"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_files = 0

        for line in lines:
            # Always keep errors/warnings
            if _RSYNC_ERROR_RE.search(line):
                kept.append(line)
                continue
            # Always keep summary statistics
            if _RSYNC_SUMMARY_RE.match(line):
                kept.append(line)
                continue
            # Drop inline progress bars
            if _RSYNC_FILE_PROGRESS_RE.match(line):
                continue
            # Heuristic: rsync -av emits bare file paths (relative or absolute).
            # Lines that don't start with whitespace and look like paths (contain
            # "/" or are plain filenames) are per-file listing noise.
            stripped = line.strip()
            if stripped and "/" in stripped and not stripped.startswith("["):
                dropped_files += 1
                continue
            # Keep everything else (blank lines, headers like "sending incremental…")
            kept.append(line)

        notes: list[str] = []
        if dropped_files:
            notes.append(f"collapsed {dropped_files} per-file transfer lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- dotnet (MSBuild / .NET CLI) -------------------------------------------

# MSBuild-style build output: "  Foo -> /path/to/Foo.dll"
_DOTNET_BUILD_ARROW_RE: Final[re.Pattern[str]] = re.compile(r"^\s+\S+ ->\s+")
# Restore/download progress lines
_DOTNET_RESTORE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Determining projects|Writing assets|Restoring packages for|Installing|Generating|"
    r"OK https?://|log\s+:\s+Restore[d]? |MSBuild auto-detection|Feeds used:)\b",
    re.IGNORECASE,
)
# Per-project build summary repetition lines — "Build succeeded" repeats once per project in
# multi-project solutions; the final occurrence is the only one that matters.
_DOTNET_BUILD_SUCCEEDED_RE: Final[re.Pattern[str]] = re.compile(
    r"^Build succeeded\.\s*$",
    re.IGNORECASE,
)
# Per-project build/pack lines (not errors)
_DOTNET_BUILD_NOISE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(Build succeeded|Restore succeeded|\s+\d+ Warning\(s\)|\s+\d+ Error\(s\)|"
    r"Time Elapsed|Build FAILED)",
    re.IGNORECASE,
)
# MSBuild project evaluation noise
_DOTNET_MSBUILD_NOISE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Project|Target|Task|Using|Overriding) \"|"
    r"^\s*MSBuild version",
    re.IGNORECASE,
)
# Test result lines
_DOTNET_TEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Passed|passed)\s+\S"
)
_DOTNET_TEST_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Failed|failed|Error)\s+\S"
)
_DOTNET_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(Test Run|Total tests|Passed:|Failed:|Skipped:|Test results file)"
)


class DotnetFilter(Filter):
    """Compress ``dotnet`` (.NET CLI) build, test, and restore output.

    ``dotnet build`` emits per-project compilation lines and MSBuild noise.
    ``dotnet restore`` emits per-package download lines.
    ``dotnet test`` emits one line per passing test (similar to pytest verbose).

    Compression model:

    * **restore**: drop package download / feed / assets lines; keep errors and
      the final ``Restore succeeded / failed`` summary.
    * **build**: drop ``Project -> dll`` arrow lines beyond the first 5; drop
      MSBuild evaluation noise; keep all warnings and errors verbatim.
    * **test**: drop ``Passed TestName`` lines (collapse to count); keep
      ``Failed`` / ``Error`` blocks verbatim; keep the ``Test Run`` summary.
    * **run**: pass through — script output is load-bearing.
    """

    name = "dotnet"
    binaries = frozenset(["dotnet"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        return stem == "dotnet"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0].lower() if positionals else ""

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        if subcommand == "test":
            return self._compress_test(lines)
        if subcommand in ("restore",):
            return self._compress_restore(lines)
        if subcommand in ("build", "publish", "pack"):
            return self._compress_build(lines)
        # run, ef, tool, etc. — pass through with basic dedup
        return _squeeze_blank_lines("\n".join(dedupe_consecutive(lines)))

    def _compress_restore(self, lines: list[str]) -> str:
        kept: list[str] = []
        dropped = 0
        for line in lines:
            if _DOTNET_RESTORE_RE.match(line) and _ERROR_SIGNAL_RE.search(line) is None:
                dropped += 1
                continue
            kept.append(line)
        notes = [f"dropped {dropped} restore-progress lines"] if dropped else []
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_build(self, lines: list[str]) -> str:
        # Two-pass: first collect all lines with standard per-line drops, then
        # collapse repeated "Build succeeded." lines (common in multi-project solutions
        # where MSBuild emits one per project before the final global summary).
        kept: list[str] = []
        arrow_count = 0
        dropped_arrows = 0
        dropped_msbuild = 0
        for line in lines:
            if _DOTNET_MSBUILD_NOISE_RE.match(line) and _ERROR_SIGNAL_RE.search(line) is None:
                dropped_msbuild += 1
                continue
            if _DOTNET_BUILD_ARROW_RE.match(line) and _ERROR_SIGNAL_RE.search(line) is None:
                arrow_count += 1
                if arrow_count <= 5:
                    kept.append(line)
                else:
                    dropped_arrows += 1
                continue
            kept.append(line)

        # Collapse repeated "Build succeeded." lines: keep only the last occurrence.
        succeeded_indices = [
            i for i, ln in enumerate(kept) if _DOTNET_BUILD_SUCCEEDED_RE.match(ln)
        ]
        dropped_succeeded = 0
        if len(succeeded_indices) > 1:
            drop_set = set(succeeded_indices[:-1])
            kept = [ln for i, ln in enumerate(kept) if i not in drop_set]
            dropped_succeeded = len(drop_set)

        notes: list[str] = []
        if dropped_arrows:
            notes.append(f"collapsed {dropped_arrows} additional project-output arrows")
        if dropped_msbuild:
            notes.append(f"dropped {dropped_msbuild} MSBuild evaluation lines")
        if dropped_succeeded:
            notes.append(f"collapsed {dropped_succeeded} repeated 'Build succeeded' lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_test(self, lines: list[str]) -> str:
        kept: list[str] = []
        pass_count = 0
        in_fail_block = False
        for line in lines:
            if _DOTNET_TEST_FAIL_RE.match(line):
                in_fail_block = True
                kept.append(line)
                continue
            if _DOTNET_TEST_PASS_RE.match(line):
                in_fail_block = False
                pass_count += 1
                continue
            if _DOTNET_TEST_SUMMARY_RE.match(line):
                in_fail_block = False
                kept.append(line)
                continue
            if in_fail_block and (line.startswith(("  ", "\t")) or not line.strip()):
                kept.append(line)
                continue
            in_fail_block = False
            kept.append(line)
        notes = [f"collapsed {pass_count} passing test lines"] if pass_count else []
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Gradle ----------------------------------------------------------------

#: Gradle task progress: "> Task :foo:bar" or "> Configure project"
_GRADLE_TASK_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^>\s+(?:Task :|Configure project|Run tasks)"
)
#: Gradle build result: "BUILD SUCCESSFUL" or "BUILD FAILED"
_GRADLE_BUILD_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^BUILD (?:SUCCESSFUL|FAILED)"
)
#: Gradle failure section: "FAILURE: ..."
_GRADLE_FAILURE_SECTION_RE: Final[re.Pattern[str]] = re.compile(
    r"^\* What went wrong:"
)
#: Gradle test summary: "X tests passed" or similar
_GRADLE_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^.*tests? (?:passed|failed)"
)
#: Gradle download progress: "Download https://..." or "Downloading https://..."
_GRADLE_DOWNLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Download|Downloading)\s+https?://"
)
#: Gradle daemon startup messages
_GRADLE_DAEMON_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Starting Gradle Daemon|Gradle Daemon|Daemon started)"
)


class GradleFilter(Filter):
    """Compress Gradle build, test, and dependency output.

    Gradle emits task progress lines, dependency resolution, and extensive
    build output that is mostly noise unless there's a failure.

    Compression model:

    * **build/test/check**: keep ``BUILD SUCCESSFUL/FAILED`` line + last 30
      lines (includes test summary). Drop progress output (``> Task :``,
      ``> Configure project``).
    * **download progress** (``Download https://...``): collapse to a count
      summary line regardless of subcommand.
    * **daemon messages** (``Starting Gradle Daemon``, ``Daemon started``):
      drop on successful builds; keep on failure so context is preserved.
    * **dependencies**: head=10, tail=10 compression (dependency trees are
      massive).
    * **tasks**: head=20, tail=5 compression (task list can be large).
    * **Failures** (exit_code != 0): keep all stderr + last 20 lines of stdout.
    * **BUILD FAILED**: keep FAILURE section and "What went wrong:" block.
    """

    name = "gradle"
    binaries = frozenset(["gradle", "gradlew", "./gradlew"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0].lower() if positionals else ""

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        # On failure, preserve stderr and last 20 lines of output.
        if exit_code != 0:
            last_lines = "\n".join(lines[-20:])
            err_output = _preserve_stderr_on_error(last_lines, stderr, exit_code)
            if err_output is not None:
                return err_output
            return last_lines

        # Subcommand-specific compression.
        if subcommand in ("dependencies", "deps"):
            return _head_tail_compress(lines, head=10, tail=10, label="lines")
        if subcommand == "tasks":
            return _head_tail_compress(lines, head=20, tail=5, label="lines")
        if subcommand in ("build", "test", "check", "assemble", "verify"):
            return self._compress_build(lines)

        # Default: use head/tail for unknown subcommands.
        return _head_tail_compress(lines, head=10, tail=10, label="lines")

    def _compress_build(self, lines: list[str]) -> str:
        """Compress build/test/check output: keep result + last 30 lines.

        Also collapses download-progress lines and drops daemon start messages
        (both are pure noise on a successful build).
        """
        kept: list[str] = []
        dropped_progress = 0
        dropped_downloads = 0
        dropped_daemon = 0

        for line in lines:
            # Drop task/configure progress lines.
            if _GRADLE_TASK_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            # Collapse download progress lines.
            if _GRADLE_DOWNLOAD_RE.match(line):
                dropped_downloads += 1
                continue
            # Drop daemon startup messages on successful builds.
            if _GRADLE_DAEMON_RE.match(line):
                dropped_daemon += 1
                continue
            kept.append(line)

        # Keep last 30 lines (includes test summary and result).
        tail_lines = kept[-30:] if len(kept) > 30 else kept

        notes: list[str] = []
        if dropped_progress:
            notes.append(f"dropped {dropped_progress} task-progress lines")
        if dropped_downloads:
            notes.append(f"collapsed {dropped_downloads} dependency download lines")
        if dropped_daemon:
            notes.append(f"dropped {dropped_daemon} Gradle Daemon startup lines")

        self._emit_notes(tail_lines, notes)
        return self._finalize(tail_lines)


# --- Ant -------------------------------------------------------------------

#: Ant task output lines: "[echo] ..." / "[mkdir] ..." / "[copy] ..." / "[javac] ..."
_ANT_TASK_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\[([a-zA-Z0-9_-]+)\]\s"
)
#: Ant build result banners
_ANT_BUILD_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^BUILD (?:SUCCESSFUL|FAILED)"
)
#: Ant javac error/warning lines: "[javac] /path/to/File.java:N: error: ..."
#: or "[javac] error:" or "[javac] warning:"
_ANT_JAVAC_DIAG_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\[javac\]\s+(?:.*:\s+)?(?:error|warning):"
)
#: Pure-noise task types: echo, mkdir, copy, delete, move — collapsed to counts
_ANT_COLLAPSIBLE_TASKS: Final[frozenset[str]] = frozenset([
    "echo", "mkdir", "copy", "delete", "move", "chmod", "touch", "get",
])


class AntFilter(Filter):
    """Compress ``ant`` build output.

    Apache Ant emits one bracketed task line per action (``[echo]``, ``[mkdir]``,
    ``[copy]``, ``[javac]``, etc.).  On a large build this produces hundreds of
    identical-pattern lines that are pure noise unless compilation fails.

    Compression model:

    * **Collapsible task types** (``[echo]``, ``[mkdir]``, ``[copy]``, ``[delete]``,
      ``[move]``, ``[chmod]``, ``[touch]``, ``[get]``): collapse consecutive runs of
      the same task type to ``[task ×N]`` counts.
    * **[javac] error:** and **[javac] warning:** lines: always keep verbatim.
    * **BUILD SUCCESSFUL / BUILD FAILED** banners: always keep.
    * **Other task types** (``[jar]``, ``[junit]``, etc.): pass through unchanged
      (these are usually short and carry signal).
    """

    name = "ant"
    binaries = frozenset(["ant"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        # task_type -> count of lines collapsed in the current run
        task_counts: dict[str, int] = {}

        def flush_task_counts() -> None:
            for task_type, count in sorted(task_counts.items()):
                kept.append(f"[token-goat: [{task_type}] ×{count} lines collapsed]")
            task_counts.clear()

        for line in lines:
            # Always preserve diagnostics from [javac] (errors, warnings).
            if _ANT_JAVAC_DIAG_RE.match(line):
                flush_task_counts()
                kept.append(line)
                continue
            # Always preserve build result banners.
            if _ANT_BUILD_RESULT_RE.match(line):
                flush_task_counts()
                kept.append(line)
                continue
            m = _ANT_TASK_LINE_RE.match(line)
            if m:
                task_type = m.group(1).lower()
                if task_type in _ANT_COLLAPSIBLE_TASKS:
                    task_counts[task_type] = task_counts.get(task_type, 0) + 1
                    continue
                else:
                    # Non-collapsible task: flush pending counts, then keep.
                    flush_task_counts()
                    kept.append(line)
                    continue
            # Non-task line (timestamps, blank lines, etc.).
            flush_task_counts()
            kept.append(line)

        flush_task_counts()
        return self._finalize(kept)


# --- Bazel -----------------------------------------------------------------

#: Bazel INFO lines worth keeping: analyzed/found targets, elapsed time
_BAZEL_INFO_KEEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^INFO:\s+(?:Analyzed|Found)\s+\d+"
)
#: Bazel INFO "From Compiling ..." lines — collapse to count
_BAZEL_INFO_COMPILE_RE: Final[re.Pattern[str]] = re.compile(
    r"^INFO:\s+(?:From Compiling|From Generating|From Linking|From "
    r"ProtoCompile|From [A-Za-z]+ src/)"
)
#: Generic INFO progress lines to collapse (e.g. "INFO: Build option ...")
_BAZEL_INFO_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(r"^INFO:\s")
#: Bazel test result lines: "//pkg:target    PASSED in Xs" or "FAILED in Xs"
_BAZEL_TEST_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^//\S+\s+(PASSED|FAILED|TIMEOUT|NO STATUS)\b"
)
#: Bazel elapsed time: "Elapsed time: X.Xs"
_BAZEL_ELAPSED_RE: Final[re.Pattern[str]] = re.compile(r"^Elapsed time:\s+\d")
#: Bazel build failure banner
_BAZEL_FAIL_BANNER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:FAILED:|ERROR:|FAIL:|Build did NOT complete|Target //)"
)
#: Bazel "Build completed successfully" summary
_BAZEL_BUILD_OK_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Build completed successfully|INFO: Build completed)"
)


class BazelFilter(Filter):
    """Compress ``bazel build`` / ``bazel test`` / ``bazel run`` output.

    Bazel emits hundreds of ``INFO: From Compiling …`` lines per build plus
    per-test result lines.  Signal is concentrated in failure lines and a few
    key INFO summaries.

    Compression model:

    * **Keep** ``INFO: Analyzed N targets`` and ``INFO: Found N targets`` verbatim.
    * **Collapse** ``INFO: From Compiling src/…`` and similar action-progress
      lines to a single count summary.
    * **Collapse** other ``INFO:`` progress lines to a single count summary.
    * **Keep** ``//pkg:target  PASSED in Xs`` lines for failing targets verbatim;
      collapse passing targets to a count.
    * **Keep** ``Elapsed time: X.Xs`` lines verbatim.
    * **Keep** ``FAILED: Build did NOT complete successfully`` and any error
      banners verbatim.
    * **Keep** ``Build completed successfully`` / ``INFO: Build completed`` lines.
    """

    name = "bazel"
    binaries = frozenset(["bazel", "bazelisk"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        compile_count = 0
        info_progress_count = 0
        test_pass_count = 0

        for line in lines:
            # Always keep elapsed time and build result banners.
            if _BAZEL_ELAPSED_RE.match(line) or _BAZEL_FAIL_BANNER_RE.match(line):
                kept.append(line)
                continue
            # Always keep build success summaries.
            if _BAZEL_BUILD_OK_RE.match(line):
                kept.append(line)
                continue
            # Keep "Analyzed / Found N targets" INFO lines.
            if _BAZEL_INFO_KEEP_RE.match(line):
                kept.append(line)
                continue
            # Collapse "From Compiling …" and similar action-progress INFO lines.
            if _BAZEL_INFO_COMPILE_RE.match(line):
                compile_count += 1
                continue
            # Test result lines: keep failures verbatim, count passes.
            if _BAZEL_TEST_RESULT_RE.match(line):
                m = _BAZEL_TEST_RESULT_RE.match(line)
                status = m.group(1) if m else ""
                if status == "PASSED":
                    test_pass_count += 1
                else:
                    # FAILED / TIMEOUT / NO STATUS — always keep
                    kept.append(line)
                continue
            # Remaining INFO: lines — collapse to count.
            if _BAZEL_INFO_PROGRESS_RE.match(line):
                info_progress_count += 1
                continue
            # Everything else: keep.
            kept.append(line)

        notes: list[str] = []
        if compile_count:
            notes.append(f"collapsed {compile_count} 'INFO: From …' compile-action lines")
        if info_progress_count:
            notes.append(f"collapsed {info_progress_count} INFO: progress lines")
        if test_pass_count:
            notes.append(f"collapsed {test_pass_count} PASSED test targets")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Maven -----------------------------------------------------------------

#: Maven test summary: "Tests run: X"
_MAVEN_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\[INFO\]\s+)?Tests run:"
)
#: Maven download progress: "Downloading:" or "Downloaded:"
_MAVEN_DOWNLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\[INFO\]\s+)?(?:Downloading|Downloaded):"
)
#: Maven build result: "BUILD SUCCESS" or "BUILD FAILURE"
_MAVEN_BUILD_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[INFO\]\s+BUILD (?:SUCCESS|FAILURE)"
)
#: Maven failure block start
_MAVEN_FAILURE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[ERROR\]"
)


class MavenFilter(Filter):
    """Compress Maven build, test, and dependency output.

    Maven emits download progress, plugin info, and extensive build output
    with [INFO], [WARN], [ERROR] prefixes.

    Compression model:

    * **test/verify/package**: keep ``BUILD SUCCESS/FAILURE``, test summary
      lines (``Tests run: X``), and ERROR lines. Drop download progress
      (``Downloading:``, ``Downloaded:``).
    * **dependency:tree**: head=10, tail=10 compression (dependency trees are
      large).
    * **install**: keep last 30 lines + any ERROR lines.
    * **BUILD FAILURE**: keep FAILURE block and full ERROR output.
    """

    name = "maven"
    binaries = frozenset(["mvn", "mvnw", "./mvnw"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0].lower() if positionals else ""

        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        # On failure, preserve all errors.
        if exit_code != 0:
            error_lines = [line for line in lines if _MAVEN_FAILURE_RE.match(line)]
            if error_lines:
                tail_output = "\n".join(lines[-20:])
                errors_output = "\n".join(error_lines)
                return tail_output + "\n---\n" + errors_output
            return "\n".join(lines[-20:])

        # Subcommand-specific compression.
        if "dependency" in subcommand and "tree" in subcommand:
            return _head_tail_compress(lines, head=10, tail=10, label="lines")
        if subcommand == "install":
            return _head_tail_compress(lines[-30:], head=30, tail=10, label="lines")
        if subcommand in ("test", "verify", "package"):
            return self._compress_test(lines)

        # Default: use head/tail for unknown subcommands.
        return _head_tail_compress(lines, head=10, tail=10, label="lines")

    def _compress_test(self, lines: list[str]) -> str:
        """Compress test output: keep result, summary, and errors."""
        kept: list[str] = []
        dropped_downloads = 0

        for line in lines:
            # Drop download progress lines.
            if _MAVEN_DOWNLOAD_RE.match(line):
                dropped_downloads += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if dropped_downloads:
            notes.append(f"dropped {dropped_downloads} download-progress lines")

        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- JavacFilter (standalone javac invocations) ----------------------------

#: javac "Note: file.java uses unchecked or unsafe operations" lines
_JAVAC_NOTE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Note:\s+\S.*\.java\s+uses (unchecked or unsafe|preview language|deprecated)"
)
#: javac "Note: Some input files use unchecked or unsafe operations." (summary note)
_JAVAC_NOTE_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^Note:\s+(?:Some input files use|Recompile with -Xlint)"
)
#: javac error line: "File.java:N: error: ..." or "error: N error(s)"
_JAVAC_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\S.*\.java:\d+:|error:|Error\s+\(|\d+ error)"
)
#: javac warning line: "File.java:N: warning: ..." or "warning: N warning(s)"
_JAVAC_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\S.*\.java:\d+: warning:|warning:|\d+ warning)"
)
#: javac summary line: "N error(s)" or "N warning(s)"
_JAVAC_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ (?:error|warning)s?"
)
#: javac "^" caret pointer lines (diagnostic context)
_JAVAC_CARET_RE: Final[re.Pattern[str]] = re.compile(r"^\s*\^\s*$")
#: javac source-context line embedded in error block: looks like source code
#: These are lines immediately after "file:N: error:" that show the source snippet
_JAVAC_SOURCE_SNIPPET_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\s{4,}|\t)"
)


class JavacFilter(Filter):
    """Compress standalone ``javac`` compiler output.

    ``javac`` emits one ``Note:`` line per source file that uses unchecked or
    unsafe operations (can be dozens), plus optional ``error:`` / ``warning:``
    diagnostic blocks with source-context snippets.  On a large project the
    note spam dwarfs the actual errors.

    Compression model:

    * **Note: file.java uses unchecked …** lines: collapse to a count note.
    * **Note: Some input files use …** / **Recompile with -Xlint**: drop
      (redundant with the count note above).
    * **error:** lines: always keep verbatim.
    * **warning:** lines: always keep verbatim.
    * **N error(s) / N warning(s)** summary: always keep.
    * **Source-context snippets** (indented source lines + ``^`` caret under
      an error): keep verbatim (they are the most useful part of the error).
    * **Blank lines** between error blocks: drop (reduce visual noise).
    """

    name = "javac"
    binaries = frozenset(["javac"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_notes = 0
        in_diag_block = False  # True while inside an error/warning block

        for line in lines:
            # Collapse per-file Note: lines.
            if _JAVAC_NOTE_RE.match(line):
                dropped_notes += 1
                continue
            # Drop summary note lines (redundant).
            if _JAVAC_NOTE_SUMMARY_RE.match(line):
                continue
            # Always keep error and warning diagnostic lines; they open a block.
            if _JAVAC_ERROR_RE.match(line) or _JAVAC_WARNING_RE.match(line):
                in_diag_block = True
                kept.append(line)
                continue
            # Keep N error(s) / N warning(s) summary lines.
            if _JAVAC_SUMMARY_RE.match(line):
                in_diag_block = False
                kept.append(line)
                continue
            # Inside a diagnostic block keep source snippets and caret lines.
            if in_diag_block and (
                _JAVAC_CARET_RE.match(line)
                or _JAVAC_SOURCE_SNIPPET_RE.match(line)
                or line.strip()  # any non-blank continuation
            ):
                if not line.strip():
                    # Blank line ends the block; drop it to reduce noise.
                    in_diag_block = False
                else:
                    kept.append(line)
                continue
            # Blank lines outside a block: drop.
            if not line.strip():
                continue
            # Anything else (e.g. "1 error" summary not matched above): keep.
            in_diag_block = False
            kept.append(line)

        notes: list[str] = []
        if dropped_notes:
            notes.append(
                f"collapsed {dropped_notes} 'Note: … uses unchecked/unsafe' lines"
            )
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- SbtFilter (Scala Build Tool) ------------------------------------------

#: sbt [info] lines worth keeping: compilation start and done
_SBT_INFO_COMPILING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[info\]\s+Compiling\s+\d+"
)
_SBT_INFO_DONE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[info\]\s+Done (?:compiling|packaging)\."
)
#: sbt [info] loading / project-resolution lines: collapse to count
_SBT_INFO_LOADING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[info\]\s+(?:Loading |Set current project|Resolving |Fetching |"
    r"Download|Updating|Wrote |Packaging |"
    r"Main Scala API documentation|Making\s)"
)
#: sbt [warn] lines
_SBT_WARN_RE: Final[re.Pattern[str]] = re.compile(r"^\[warn\]\s")
#: sbt [error] lines (always keep)
_SBT_ERROR_RE: Final[re.Pattern[str]] = re.compile(r"^\[error\]\s")
#: sbt test-run ScalaTest/MUnit/JUnit dot-progress (dots and letters on their own line)
_SBT_TEST_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[info\]\s+[\.FEI!]+\s*$"
)
#: sbt "Total time: Xs" summary
_SBT_TOTAL_TIME_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[(?:success|info)\]\s+Total time:"
)
#: sbt "[success] Total time: ..." or "BUILD SUCCESS"
_SBT_SUCCESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[success\]\s"
)
#: sbt "Failed tests:" error block header
_SBT_FAILED_TESTS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[error\]\s+Failed tests:"
)
#: sbt test result summary: "[info] Tests: succeeded X, failed Y"
_SBT_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[info\]\s+(?:Tests: succeeded|All tests passed|Test run (?:finished|failed))"
)

#: Maximum [warn] lines per unique category prefix to keep (first N kept, rest collapsed).
_SBT_MAX_WARN_PER_CATEGORY: Final[int] = 5


class SbtFilter(Filter):
    """Compress ``sbt`` (Scala Build Tool) output.

    sbt produces extensive ``[info]`` loading/resolution spam before any
    compilation starts, ScalaTest dot-progress bars, and verbose warning
    blocks.  Signal is concentrated in ``[error]`` lines, the compilation
    status, and the test summary.

    Compression model:

    * **[info] Compiling N Scala sources …**: keep verbatim.
    * **[info] Done compiling.** / **[info] Done packaging.**: keep verbatim.
    * **[info] Loading …** / **[info] Set current project …** / resolution
      noise: collapse to a count note.
    * **[warn] …** lines: keep the first :data:`_SBT_MAX_WARN_PER_CATEGORY`
      per unique warning-category prefix, collapse the rest.
    * **[error] …** lines: always keep verbatim.
    * **[info] …** ScalaTest/MUnit dot-progress (lines of ``.FEI!``):
      collapse to a count note.
    * **Total time: Xs** / **[success] …**: keep verbatim.
    * **[error] Failed tests:** block: keep verbatim.
    * **[info] Tests: succeeded …** summary: keep verbatim.
    """

    name = "sbt"
    binaries = frozenset(["sbt"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        # Match "sbt" and "./sbt" (common wrapper script invocation).
        return stem in self.binaries or name in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped_loading = 0
        dropped_test_progress = 0
        # Track [warn] lines per category; category = first ~40 chars of text.
        warn_counts: dict[str, int] = {}
        dropped_warn_extra = 0

        for line in lines:
            # Always keep [error] lines.
            if _SBT_ERROR_RE.match(line):
                kept.append(line)
                continue
            # Always keep compilation start / done messages.
            if _SBT_INFO_COMPILING_RE.match(line) or _SBT_INFO_DONE_RE.match(line):
                kept.append(line)
                continue
            # Always keep test summary lines.
            if _SBT_TEST_SUMMARY_RE.match(line):
                kept.append(line)
                continue
            # Always keep total-time / success lines.
            if _SBT_TOTAL_TIME_RE.match(line) or _SBT_SUCCESS_RE.match(line):
                kept.append(line)
                continue
            # Collapse loading / resolution [info] noise.
            if _SBT_INFO_LOADING_RE.match(line):
                dropped_loading += 1
                continue
            # Collapse test dot-progress [info] lines.
            if _SBT_TEST_PROGRESS_RE.match(line):
                dropped_test_progress += 1
                continue
            # Deduplicate [warn] lines per category.
            if _SBT_WARN_RE.match(line):
                # Use the first 60 chars as the category key (strips variable
                # file/line suffixes but preserves the warning type).
                category = line[:60].strip()
                count = warn_counts.get(category, 0)
                warn_counts[category] = count + 1
                if count < _SBT_MAX_WARN_PER_CATEGORY:
                    kept.append(line)
                else:
                    dropped_warn_extra += 1
                continue
            # Anything else: keep.
            kept.append(line)

        notes: list[str] = []
        if dropped_loading:
            notes.append(f"collapsed {dropped_loading} [info] loading/resolution lines")
        if dropped_test_progress:
            notes.append(f"collapsed {dropped_test_progress} test dot-progress lines")
        if dropped_warn_extra:
            notes.append(f"collapsed {dropped_warn_extra} duplicate [warn] lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Ruby / RSpec / Minitest ------------------------------------------------

#: RSpec dot-progress line: a line containing only ".", "F", "E", "*" chars + optional
#: newline (emitted without any leading text in RSpec's default progress formatter).
_RSPEC_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(r"^[\.FE\*]+$")
#: RSpec example-summary line: "N examples, N failures" (or "N failure")
_RSPEC_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ examples?,\s+\d+ failures?"
)
#: RSpec finished-with-time summary: "Finished in X seconds"
_RSPEC_FINISHED_RE: Final[re.Pattern[str]] = re.compile(r"^Finished in \d")
#: RSpec failure block header: "Failures:" section header
_RSPEC_FAILURE_SECTION_RE: Final[re.Pattern[str]] = re.compile(r"^Failures:\s*$")
#: RSpec failed example index: "  1) SomeClass some method ..."
_RSPEC_FAIL_INDEX_RE: Final[re.Pattern[str]] = re.compile(r"^\s+\d+\)\s+\S")
#: Minitest pass-line: "X runs, X assertions, 0 failures, 0 errors, 0 skips"
_MINITEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ runs?,\s+\d+ assertions?"
)
#: Minitest single-test result line: "E" or "." or "F" or "S" standing alone
#: (Minitest uses the same dot-progress as RSpec)


class RubyFilter(Filter):
    """Compress ``ruby``, ``rspec``, ``minitest``, and ``rake`` output.

    RSpec default formatter emits a "." per passing example and an "F" / "E"
    per failure, with full failure messages printed at the end.  Minitest
    uses the same dot-progress style.

    Compression model:

    * **RSpec dot-progress lines**: count "." chars (passes) and keep "F" / "E"
      chars verbatim (each signals a failure that will appear in the failure
      section).  Emit ``[token-goat: N passing examples]`` in place of all
      dot-lines.
    * **Keep** the ``Failures:`` section and every failure block verbatim.
    * **Keep** the ``Finished in X seconds`` and ``N examples, N failures``
      summary lines.
    * **Minitest**: same dot-counting; keep ``N runs, N assertions, N failures``
      summary.
    * **rake**: pass through with basic dedupe (rake output is tool-specific
      and not safely compressible without schema knowledge).
    """

    name = "ruby"
    binaries = frozenset(["ruby", "rspec", "minitest", "rake", "rspec2"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        p = Path(argv[0])
        stem = p.stem.lower()
        name = p.name.lower()
        # Match rspec, minitest, ruby, rake directly.
        # "bundle exec rspec" is handled by prefix stripping → the inner binary
        # (rspec) becomes argv[0] after _strip_prefixes.
        return stem in self.binaries or name in self.binaries

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)

        binary = Path(argv[0]).stem.lower() if argv else ""

        # rake: dedupe only — task output is load-bearing.
        if binary == "rake":
            return _squeeze_blank_lines("\n".join(dedupe_consecutive(merged.split("\n"))))

        # rspec / minitest / ruby: dot-progress compression.
        return self._compress_test(merged)

    def _compress_test(self, text: str) -> str:
        """Collapse dot-progress, keep failures and summary lines."""
        lines = text.split("\n")
        kept: list[str] = []
        pass_count = 0
        in_failure_section = False

        for line in lines:
            # Blank lines close the current fail block but are still kept for
            # separation when we are already in the failure section.
            if not line.strip():
                if in_failure_section:
                    kept.append(line)
                continue

            # RSpec "Failures:" section header.
            if _RSPEC_FAILURE_SECTION_RE.match(line):
                in_failure_section = True
                kept.append(line)
                continue

            # Inside the failure section: keep everything verbatim.
            if in_failure_section:
                kept.append(line)
                continue

            # Dot-progress lines: count passes, preserve failures.
            if _RSPEC_PROGRESS_RE.match(line):
                dot_passes = line.count(".")
                pass_count += dot_passes
                # Keep any failure/error chars verbatim on a separate line so
                # the agent sees there are failures even before the Failures: block.
                fail_chars = "".join(c for c in line if c in "FE")
                if fail_chars:
                    kept.append(f"[{fail_chars}]  (failures in progress output)")
                continue

            # Summary / finished lines: always keep.
            if _RSPEC_SUMMARY_RE.match(line) or _MINITEST_SUMMARY_RE.match(line):
                kept.append(line)
                continue
            if _RSPEC_FINISHED_RE.match(line):
                kept.append(line)
                continue

            # Everything else: keep.
            kept.append(line)

        if pass_count:
            # Prepend the collapsed count just before the failure section (or at end).
            note = f"[token-goat: collapsed {pass_count} passing examples/dots]"
            # Insert before first kept failure-section line or at end.
            for i, kline in enumerate(kept):
                if _RSPEC_FAILURE_SECTION_RE.match(kline):
                    kept.insert(i, note)
                    break
            else:
                kept.append(note)

        return self._finalize(kept)


# --- Bundler ----------------------------------------------------------------

#: "Using gem-name N.N.N" lines emitted during `bundle install`
_BUNDLER_USING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Using\s+\S+\s+[\d.]+"
)
#: "Fetching gem-name N.N.N" or "Installing gem-name N.N.N" progress lines
_BUNDLER_FETCH_INSTALL_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Fetching|Installing)\s+\S+\s+[\d.]+"
)
#: Completion banners: "Bundle complete!" / "Bundle updated!"
_BUNDLER_COMPLETE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Bundle (?:complete!|updated!|installed!)"
)
#: Gems-in-groups line: "Gems in the groups..."
_BUNDLER_GROUPS_RE: Final[re.Pattern[str]] = re.compile(
    r"^Gems in the groups?"
)
#: Gemfile.lock diff summary: "Gemfile.lock was changed" / "N gemfiles changed"
_BUNDLER_LOCK_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Gemfile\.lock|gemfiles?) (?:was|were) (?:changed|updated)|"
    r"^\d+ gems? (?:installed|updated|removed)"
)


class BundlerFilter(Filter):
    """Compress ``bundle install``, ``bundle update``, and ``bundler`` output.

    Bundler emits one "Using gem-name version" line per gem already satisfied
    plus "Fetching …" / "Installing …" lines for new gems.  On a project with
    100+ gems this produces 100+ identical-looking lines.  The only lines the
    agent needs are the completion banner and any error output.

    Compression model:

    * **Collapse** "Using gem-name version" lines to a single count summary.
    * **Collapse** "Fetching … version" / "Installing … version" lines to a
      count summary (separate from "Using" because these indicate actual work).
    * **Keep** ``Bundle complete!`` / ``Bundle updated!`` banners verbatim.
    * **Keep** ``Gems in the groups: …`` lines verbatim (group membership is
      actionable context).
    * **Keep** Gemfile.lock change-summary lines verbatim.
    * **Keep** every error/warning line verbatim.
    """

    name = "bundler"
    binaries = frozenset(["bundle", "bundler"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        using_count = 0
        fetch_install_count = 0

        for line in lines:
            # Always keep errors/warnings verbatim.
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Collapse "Using …" lines.
            if _BUNDLER_USING_RE.match(line):
                using_count += 1
                continue
            # Collapse "Fetching …" / "Installing …" lines.
            if _BUNDLER_FETCH_INSTALL_RE.match(line):
                fetch_install_count += 1
                continue
            # Keep completion banners, group lines, and lock summaries.
            if (
                _BUNDLER_COMPLETE_RE.match(line)
                or _BUNDLER_GROUPS_RE.match(line)
                or _BUNDLER_LOCK_SUMMARY_RE.match(line)
            ):
                kept.append(line)
                continue
            # Everything else: keep.
            kept.append(line)

        notes: list[str] = []
        if using_count:
            notes.append(f"collapsed {using_count} 'Using gem' lines")
        if fetch_install_count:
            notes.append(f"collapsed {fetch_install_count} 'Fetching/Installing gem' lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- cmake -----------------------------------------------------------------

#: CMake configure-phase progress: "-- Configuring done (0.2s)"
_CMAKE_CONFIG_RE: Final[re.Pattern[str]] = re.compile(
    r"^-- (?:Configuring|Generating|Build files|Detecting|Check for|Looking for|"
    r"Found|Using|CMAKE|Performing Test|Could(?: NOT)? find|The (?:C|CXX|Fortran) compiler)"
)
#: CMake "-- Found PackageName: ..." package-found lines
_CMAKE_FOUND_RE: Final[re.Pattern[str]] = re.compile(r"^-- Found \S")
#: CMake "-- Configuring done" / "-- Build files have been written to:" — always keep
_CMAKE_DONE_RE: Final[re.Pattern[str]] = re.compile(
    r"^-- (?:Configuring done|Generating done|Build files have been written)"
)
#: CMake build-phase percentage lines: "[  5%] Building CXX object ..."
_CMAKE_PERCENT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[\s*\d+%\]\s+(?:Building|Compiling|Generating|Scanning|Creating)\s"
)
#: CMake "[N%] Linking CXX/C executable/library ..." — always keep
_CMAKE_LINK_PERCENT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[\s*\d+%\]\s+Linking\s"
)
#: CMake "[100%] Built target ..." — always keep
_CMAKE_BUILT_TARGET_RE: Final[re.Pattern[str]] = re.compile(
    r"^\[\s*100%\]\s+Built target\s"
)
#: CMake Makefile link/ar lines (emitted without a percentage prefix).
_CMAKE_LINK_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Linking\s|Archiving\s|cd\s.*&&\s*(?:ar |ranlib |ld ))"
)
#: ctest: "N/N Test #N: TestName ... Passed Xs" passing result (no leading whitespace)
_CTEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+/\d+\s+Test\s+#\d+:.*\bPassed\b"
)
#: ctest: "N/N Test #N: TestName ... ***Failed" or "***Not Run" failing result
_CTEST_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+/\d+\s+Test\s+#\d+:.*\*\*\*"
)
#: ctest summary: "N% tests passed, N tests failed out of N"
_CTEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+% tests passed"
)


class CmakeFilter(Filter):
    """Compress ``cmake`` configure, build, and ``ctest`` output.

    CMake produces two kinds of noisy output:

    * **Configure phase** (``cmake -S . -B build``): emits a ``--`` line for
      every feature probe, compiler detection, and ``find_package()`` search.
      On a large project this can exceed 200 lines before a single source file
      is compiled.

    * **Build phase** (``cmake --build .``): emits one ``[N%] Building CXX
      object …`` line per translation unit.  A project with 500 .cpp files
      produces 500 identical-looking progress lines.

    * **ctest**: emits one result line per test (``Test #N: … Passed Xs``).

    Compression model:

    * **Configure phase**: collapse ``-- Found PackageName: …`` lines to a
      count ``[token-goat: Found N packages]``; keep the first 5 other ``--``
      probe lines; always keep ``-- Configuring done`` / ``-- Build files have
      been written to:`` lines; drop the rest.
    * **Build phase**: collapse ``[N%] Building …`` lines to a progress summary;
      keep ``[N%] Linking …`` and ``[100%] Built target …`` verbatim.
    * **ctest**: collapse passing ``Passed`` result lines to a count; keep
      every ``***Failed`` / ``***Not Run`` line verbatim; keep the summary.
    * **Keep** every ``warning:`` / ``error:`` / ``CMake Error`` / ``CMake
      Warning`` diagnostic verbatim.
    """

    name = "cmake"
    binaries = frozenset(["cmake", "ccmake", "ctest", "cpack"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        binary = Path(argv[0]).stem.lower() if argv else ""
        if binary == "ctest":
            return self._compress_ctest(stdout, stderr)
        merged = self._combine_output(stdout, stderr)
        return self._compress_cmake(merged)

    def _compress_cmake(self, text: str) -> str:
        """Compress cmake configure + build output."""
        lines = text.split("\n")
        kept: list[str] = []
        config_probes_kept = 0
        dropped_probes = 0
        dropped_percent = 0
        found_packages = 0
        last_percent_line: str | None = None

        for line in lines:
            # Always keep error/warning diagnostics.
            if _ERROR_SIGNAL_RE.search(line) or "CMake Error" in line or "CMake Warning" in line:
                kept.append(line)
                continue
            # Always keep "-- Configuring done" and "-- Build files" lines.
            if _CMAKE_DONE_RE.match(line):
                kept.append(line)
                continue
            # Collapse "-- Found PackageName: ..." lines to a count.
            if _CMAKE_FOUND_RE.match(line):
                found_packages += 1
                continue
            # Configure-phase ``-- …`` probe lines: keep first 5, drop rest.
            if _CMAKE_CONFIG_RE.match(line):
                config_probes_kept += 1
                if config_probes_kept <= 5:
                    kept.append(line)
                else:
                    dropped_probes += 1
                continue
            # Keep "[N%] Linking ..." verbatim.
            if _CMAKE_LINK_PERCENT_RE.match(line):
                kept.append(line)
                continue
            # Keep "[100%] Built target ..." verbatim.
            if _CMAKE_BUILT_TARGET_RE.match(line):
                kept.append(line)
                continue
            # Build-phase "[N%] Building ..." lines — count and track last.
            if _CMAKE_PERCENT_RE.match(line):
                dropped_percent += 1
                last_percent_line = line
                continue
            kept.append(line)

        # Emit found-packages summary before any other notes.
        if found_packages:
            kept.append(f"[token-goat: Found {found_packages} packages (-- Found ... lines collapsed)]")
        notes: list[str] = []
        if dropped_probes:
            notes.append(f"collapsed {dropped_probes} cmake probe/feature-check lines")
        if dropped_percent:
            # Include the last percent line so the agent sees the peak progress.
            if last_percent_line:
                notes.append(
                    f"collapsed {dropped_percent} [N%] build-progress lines "
                    f"(last: {last_percent_line.strip()})"
                )
            else:
                notes.append(f"collapsed {dropped_percent} [N%] build-progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_ctest(self, stdout: str, stderr: str) -> str:
        """Compress ctest output: collapse passing tests, keep failures."""
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_count = 0

        for line in lines:
            # Always keep error/warning lines.
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Passing test: count, drop.
            if _CTEST_PASS_RE.match(line):
                pass_count += 1
                continue
            # Failing test: keep verbatim.
            if _CTEST_FAIL_RE.match(line):
                kept.append(line)
                continue
            # Summary line: always keep.
            if _CTEST_SUMMARY_RE.match(line):
                kept.append(line)
                continue
            kept.append(line)

        notes: list[str] = []
        if pass_count:
            notes.append(f"collapsed {pass_count} passing ctest results")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- diff ------------------------------------------------------------------

#: A diff file start marker: "diff …" or "--- a/foo".  The "+++ b/foo" line
#: is NOT included here because it always follows immediately after "---" and
#: belongs to the same file block.  Including "+++" would split each file into
#: two blocks and inflate the file count.
_DIFF_FILE_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:diff\s|---\s)"
)
#: Unified diff hunk header: "@@ -N,N +N,N @@ ..."
_DIFF_HUNK_RE: Final[re.Pattern[str]] = re.compile(r"^@@ ")
#: Lines that are pure context (no change): space-prefixed in unified diff.
_DIFF_CONTEXT_RE: Final[re.Pattern[str]] = re.compile(r"^ ")

#: Maximum hunks to keep per file in a plain diff.
_DIFF_MAX_HUNKS_PER_FILE = 3
#: Maximum total files to show in full before switching to stat-only view.
_DIFF_MAX_FULL_FILES = 20


class DiffFilter(Filter):
    """Compress ``diff`` / ``diff -u`` / ``diff -r`` output.

    Plain ``diff`` on large trees or large files can produce thousands of
    lines.  For single-file diffs that are small the output passes through
    unchanged.  For large diffs the compression strategy is:

    * **Small diff** (≤ 50 lines): pass through unchanged.
    * **Per-file cap**: keep up to :data:`_DIFF_MAX_HUNKS_PER_FILE` hunks per
      file; replace remaining hunks with a ``[+N more hunks elided]`` marker.
    * **Large diff** (> :data:`_DIFF_MAX_FULL_FILES` files): drop all hunk
      bodies and emit a ``stat``-style summary (file path + +adds/-dels count).
    * **Context lines**: in large files, strip trailing unchanged-context lines
      beyond the first 3 and last 3 in each hunk to reduce repetition.
    * **Keep** every line that modifies content (``+`` or ``-`` prefix) verbatim.

    Note: ``git diff`` is handled by :class:`GitFilter` which has richer hunk
    awareness.  :class:`DiffFilter` handles plain POSIX ``diff`` output which
    lacks the ``diff --git`` header and uses ``<`` / ``>`` markers for the
    non-unified format.
    """

    name = "diff"
    binaries = frozenset(["diff", "diff3", "sdiff", "colordiff", "wdiff"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        text = self._combine_output(stdout, stderr)
        lines = text.split("\n")
        non_empty = [ln for ln in lines if ln]

        # Small diff: pass through.
        if len(non_empty) <= 50:
            return text

        # Detect unified diff (has hunk headers) vs. normal diff (has < / > markers).
        has_unified = any(_DIFF_HUNK_RE.match(ln) for ln in lines[:20])
        if has_unified:
            return self._compress_unified(lines)
        # Normal diff: dedupe numerically and truncate middle.
        deduped = dedupe_numeric_runs(lines, min_run=5)
        return "\n".join(truncate_middle(deduped, 300))

    def _compress_unified(self, lines: list[str]) -> str:
        """Compress a unified diff by capping hunks per file."""
        # split_blocks operates on a string; join the lines first.
        text = "\n".join(lines)
        # Split into per-file blocks (each block is a string starting at a
        # file header line).
        raw_blocks = split_blocks(text, _DIFF_FILE_HEADER_RE)
        # Convert each block back to a list of lines for hunk-level processing.
        file_blocks_str = raw_blocks
        real_files = [b for b in file_blocks_str if _DIFF_FILE_HEADER_RE.match(b.split("\n", 1)[0])]

        if len(real_files) > _DIFF_MAX_FULL_FILES:
            # Stat-only view for very wide diffs.
            stat_lines = [f"[token-goat: large diff ({len(real_files)} files); stat-only view]"]
            for block_str in real_files:
                block_lines = block_str.split("\n")
                header = block_lines[0]
                adds = sum(1 for ln in block_lines if ln.startswith("+") and not ln.startswith("+++"))
                dels = sum(1 for ln in block_lines if ln.startswith("-") and not ln.startswith("---"))
                stat_lines.append(f"{header}  +{adds} -{dels}")
            return "\n".join(stat_lines)

        out_parts: list[str] = []
        for block_str in file_blocks_str:
            block_lines = block_str.split("\n")
            first_line = block_lines[0] if block_lines else ""
            if not first_line or not _DIFF_FILE_HEADER_RE.match(first_line):
                out_parts.append(block_str)
                continue
            # Split this file's block into hunks.
            hunk_blocks = _split_into_hunks(block_lines)
            if len(hunk_blocks) <= _DIFF_MAX_HUNKS_PER_FILE + 1:
                out_parts.append(block_str)
                continue
            head = hunk_blocks[:_DIFF_MAX_HUNKS_PER_FILE + 1]
            elided = len(hunk_blocks) - _DIFF_MAX_HUNKS_PER_FILE - 1
            flat = [ln for chunk in head for ln in chunk]
            flat.append(f"[token-goat: +{elided} more hunks in this file elided]")
            out_parts.append("\n".join(flat))
        return "\n".join(out_parts)


def _split_into_hunks(block: list[str]) -> list[list[str]]:
    """Split a per-file diff block into sub-lists at ``@@ …`` hunk boundaries.

    The first sub-list is the file header (before the first ``@@`` line);
    subsequent sub-lists each start with an ``@@`` line.  Mirrors the hunk
    splitting logic in :func:`_compress_git_diff` but operates on a ``list[str]``
    rather than a single string.
    """
    hunks: list[list[str]] = []
    current: list[str] = []
    for line in block:
        if _DIFF_HUNK_RE.match(line) and current:
            hunks.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        hunks.append(current)
    return hunks


# --- Flutter / Dart / pub --------------------------------------------------

#: Flutter build compilation lines: "Compiling lib/..." noise
_FLUTTER_COMPILING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Compiling\s+lib/"
)
#: Flutter build success line: "✓ Built build/..." — always keep
_FLUTTER_BUILT_RE: Final[re.Pattern[str]] = re.compile(
    r"^[✓✔]\s+Built\s+\S"
)
#: Flutter font asset lines: "Font asset ..."
_FLUTTER_FONT_ASSET_RE: Final[re.Pattern[str]] = re.compile(
    r"^Font asset\s"
)
#: Flutter "Running Gradle task" — always keep
_FLUTTER_GRADLE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Running Gradle task\s"
)
#: Flutter test progress lines: "00:XX +N:" or "00:XX +N -M:"
_FLUTTER_TEST_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d{2}:\d{2}\s+[+\d]"
)
#: Flutter test summary: "All tests passed!" / "N tests passed" / "N tests failed"
_FLUTTER_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:All tests passed!|\d+\s+test[s]?\s+(?:passed|failed))"
)
#: Flutter pub dependency resolution/change lines to keep
_FLUTTER_PUB_KEEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|"
    r"Downloading packages|Building package executable|Package\s+\w+\s+is)"
)
#: Flutter pub new package lines: "+ package_name version" — collapse to count
_FLUTTER_PUB_PKG_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\+\s+\S+\s+\S+"
)


class FlutterFilter(Filter):
    """Compress ``flutter build``, ``flutter test``, ``flutter run``, ``flutter pub`` output.

    Flutter emits hundreds of verbose compilation lines and dependency resolution
    lines that obscure the few signals the agent actually needs.

    Compression model:

    * **flutter build**:

      - Collapse ``Compiling lib/…`` lines to a count.
      - Keep ``✓ Built build/…`` success lines verbatim.
      - Collapse ``Font asset …`` lines to a count.
      - Keep ``Running Gradle task…`` lines verbatim.
      - Keep every ``warning:`` / ``error:`` diagnostic.

    * **flutter test**:

      - Collapse ``00:XX +N:`` progress lines to a final summary count.
      - Keep failure blocks verbatim (lines containing ``FAILED``/``Error``).
      - Keep ``All tests passed!`` / ``N tests passed/failed`` summary.

    * **flutter pub get / pub upgrade**:

      - Keep ``Resolving dependencies…`` verbatim.
      - Collapse ``+ package_name version`` lines to a count.
      - Keep ``Changed N dependencies`` / ``No dependencies changed`` verbatim.
      - Keep every ``error:`` / ``warning:`` line verbatim.
    """

    name = "flutter"
    binaries = frozenset(["flutter"])
    subcommands = frozenset(["build", "test", "run", "pub"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        if subcommand == "test":
            return self._compress_test(stdout, stderr)
        if subcommand == "pub":
            return self._compress_pub(stdout, stderr)
        # build / run and anything else
        return self._compress_build(stdout, stderr)

    def _compress_build(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        compile_count = 0
        font_count = 0
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if _FLUTTER_GRADLE_RE.match(line) or _FLUTTER_BUILT_RE.match(line):
                kept.append(line)
                continue
            if _FLUTTER_COMPILING_RE.match(line):
                compile_count += 1
                continue
            if _FLUTTER_FONT_ASSET_RE.match(line):
                font_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if compile_count:
            notes.append(f"collapsed {compile_count} 'Compiling lib/' lines")
        if font_count:
            notes.append(f"collapsed {font_count} font asset lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_test(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        progress_count = 0
        in_failure = False
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                in_failure = True
                kept.append(line)
                continue
            # Check summary before progress — "00:XX +N: All tests passed!" is both.
            if _FLUTTER_TEST_SUMMARY_RE.search(line):
                in_failure = False
                kept.append(line)
                continue
            if in_failure:
                # Keep indented failure body until a blank or progress line.
                if not line.strip() or _FLUTTER_TEST_PROGRESS_RE.match(line):
                    in_failure = False
                    if not line.strip():
                        kept.append(line)
                    else:
                        progress_count += 1
                else:
                    kept.append(line)
                continue
            if _FLUTTER_TEST_PROGRESS_RE.match(line):
                progress_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if progress_count:
            notes.append(f"collapsed {progress_count} test progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_pub(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pkg_count = 0
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if _FLUTTER_PUB_KEEP_RE.match(line):
                kept.append(line)
                continue
            if _FLUTTER_PUB_PKG_LINE_RE.match(line):
                pkg_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if pkg_count:
            notes.append(f"collapsed {pkg_count} package dependency lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Dart ------------------------------------------------------------------

#: dart analyze: "Analyzing ..." header
_DART_ANALYZING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Analyzing\s"
)
#: dart analyze result lines to always keep
_DART_ANALYZE_RESULT_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:No issues found!|\d+ issue[s]? found\.|warning -|error -|info -|hint -)"
)
#: dart test progress: dots or "00:XX +N" style progress lines
_DART_TEST_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d{2}:\d{2}\s+[+\d]|^[\.]+$"
)
#: dart compile completion line
_DART_COMPILE_DONE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Generated:\s|Compiling\s)"
)
#: dart test summary: "All tests passed" / "N tests failed"
_DART_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:All tests passed\.?|\d+\s+test[s]?\s+(?:passed|failed))"
)


class DartFilter(Filter):
    """Compress ``dart compile``, ``dart test``, ``dart pub``, ``dart analyze`` output.

    Dart toolchain output can be verbose with progress dots and dependency lists.

    Compression model:

    * **dart analyze**:

      - Keep ``Analyzing …`` header.
      - Keep ``No issues found!`` / ``N issues found`` summary.
      - Keep individual diagnostic lines verbatim (already compact).

    * **dart test**:

      - Collapse dot-progress and ``00:XX +N`` progress lines to a count.
      - Keep failure blocks and final summary verbatim.

    * **dart compile exe**:

      - Keep ``Compiling …`` and ``Generated: …`` lines verbatim.
      - Keep every ``error:`` / ``warning:`` diagnostic.

    * **dart pub get / upgrade**:

      - Delegate to :class:`PubFilter` logic (same package-count collapsing).
    """

    name = "dart"
    binaries = frozenset(["dart"])
    subcommands = frozenset(["compile", "test", "pub", "analyze", "run", "format"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        if subcommand == "analyze":
            return self._compress_analyze(stdout, stderr)
        if subcommand == "test":
            return self._compress_test(stdout, stderr)
        if subcommand == "pub":
            return self._compress_pub(stdout, stderr)
        # compile, run, format: light compression — keep everything except noise
        return self._compress_generic(stdout, stderr)

    def _compress_analyze(self, stdout: str, stderr: str) -> str:
        # dart analyze output is already compact; mostly pass through.
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        for line in lines:
            # Keep all analyze output — it's already compact and high-signal.
            if (
                _DART_ANALYZING_RE.match(line)
                or _DART_ANALYZE_RESULT_RE.match(line)
                or _ERROR_SIGNAL_RE.search(line)
                or line.strip()
            ):
                kept.append(line)
        return self._finalize(kept)

    def _compress_test(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        progress_count = 0
        in_failure = False
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                in_failure = True
                kept.append(line)
                continue
            # Check summary before progress — "00:XX +N: All tests passed." is both.
            if _DART_TEST_SUMMARY_RE.search(line):
                in_failure = False
                kept.append(line)
                continue
            if in_failure:
                if not line.strip() or _DART_TEST_PROGRESS_RE.match(line):
                    in_failure = False
                    if not line.strip():
                        kept.append(line)
                    else:
                        progress_count += 1
                else:
                    kept.append(line)
                continue
            if _DART_TEST_PROGRESS_RE.match(line):
                progress_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if progress_count:
            notes.append(f"collapsed {progress_count} test progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_pub(self, stdout: str, stderr: str) -> str:
        """Delegate to pub-style compression."""
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pkg_count = 0
        download_count = 0
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if _PUB_KEEP_RE.match(line):
                kept.append(line)
                continue
            if _PUB_PKG_LINE_RE.match(line):
                pkg_count += 1
                continue
            if _PUB_DOWNLOADING_RE.match(line):
                download_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if pkg_count:
            notes.append(f"collapsed {pkg_count} package lines")
        if download_count:
            notes.append(f"collapsed {download_count} download lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_generic(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        for line in lines:
            if _DART_COMPILE_DONE_RE.match(line) or _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            kept.append(line)
        return self._finalize(kept)


# --- pub (standalone) -------------------------------------------------------

#: pub keep lines: resolution headers and change summaries
_PUB_KEEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|"
    r"Downloading packages|Building package executable)"
)
#: pub new/changed package lines: "+ package_name version" or "> package_name version"
_PUB_PKG_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^[+>!]\s+\S+\s+\S+"
)
#: pub downloading lines: "Downloading package_name version..."
_PUB_DOWNLOADING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Downloading\s+\S+\s+\S+"
)


class PubFilter(Filter):
    """Compress ``pub get``, ``pub upgrade``, and ``pub publish`` output.

    The Dart/Flutter ``pub`` package manager emits one line per package during
    dependency resolution, which can be hundreds of lines on a large project.
    The only signals the agent needs are the resolution header, any errors, and
    the final "Changed N dependencies" summary.

    Compression model:

    * Keep ``Resolving dependencies…`` header verbatim.
    * Collapse ``Downloading package_name version…`` lines to a count.
    * Collapse ``+ package_name version`` lines (new/upgraded packages) to a
      count.
    * Keep ``Changed N dependencies`` / ``No dependencies changed`` verbatim.
    * Keep every ``error:`` / ``warning:`` line verbatim.
    """

    name = "pub"
    binaries = frozenset(["pub"])
    subcommands = frozenset(["get", "upgrade", "publish", "add", "remove"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pkg_count = 0
        download_count = 0
        for line in lines:
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if _PUB_KEEP_RE.match(line):
                kept.append(line)
                continue
            if _PUB_PKG_LINE_RE.match(line):
                pkg_count += 1
                continue
            if _PUB_DOWNLOADING_RE.match(line):
                download_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if pkg_count:
            notes.append(f"collapsed {pkg_count} package lines")
        if download_count:
            notes.append(f"collapsed {download_count} download lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Swift -----------------------------------------------------------------

#: Swift compiler build-phase lines: "CompileSwift normal arm64 path/to/File.swift"
_SWIFT_COMPILE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(CompileSwift|CompileSwiftSources|MergeSwiftModule|"
    r"PhaseScriptExecution|CpResource|CpHeader|ProcessInfoPlistFile|"
    r"Ld\s|CodeSign\s|Touch\s|"
    r"note:\s+compile\s+Swift\s+module)"
    r"\s"
)
#: Swift test result lines: "Test Case '-[Module.TestClass testMethod]' passed"
_SWIFT_TEST_PASS_RE: Final[re.Pattern[str]] = re.compile(
    r"^Test Case\s+.+\s+passed\s+\(",
)
#: Swift test case "started" lines — pure noise, always dropped
_SWIFT_TEST_START_RE: Final[re.Pattern[str]] = re.compile(
    r"^Test Case\s+.+\s+started\.$",
)
#: Swift test failure lines
_SWIFT_TEST_FAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"^Test Case\s+.+\s+failed\s+\(",
)
#: Swift test suite summary: "Test Suite '…' passed" / "Test Suite '…' failed"
_SWIFT_SUITE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Test Suite\s+.+\s+(passed|failed)\s+at\b",
)
#: Swift overall test results: "Executed N tests, with N failures"
_SWIFT_RESULTS_RE: Final[re.Pattern[str]] = re.compile(
    r"^Executed \d+ test",
)
#: Swift build completion line
_SWIFT_BUILD_COMPLETE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\*\*\s*BUILD SUCCEEDED\s*\*\*|^\*\*\s*BUILD FAILED\s*\*\*"
    r"|^Build complete!",
)
#: Swift warning/error lines (file:line:col: warning/error: message)
_SWIFT_DIAG_RE: Final[re.Pattern[str]] = re.compile(
    r"^.*:\d+:\d+:\s+(warning|error):\s"
)


class SwiftFilter(Filter):
    """Compress ``swift build`` / ``swift test`` / ``swift run`` / ``swift package`` output.

    The Swift Package Manager (SPM) and Swift compiler emit verbose build-phase
    lines (``CompileSwift normal arm64 …``) for every source file and verbose
    test-case lines for every passing test.  These are pure noise unless the
    build or a test fails.

    Compression model:

    * **Build phase** (``swift build``, ``swift package``):

      - Collapse ``CompileSwift`` / ``CompileSwiftSources`` / ``MergeSwiftModule``
        / ``Ld`` / ``CodeSign`` / ``Touch`` build-phase lines into a count summary.
      - Keep every ``warning:`` / ``error:`` diagnostic line verbatim.
      - Keep ``Build complete!`` and ``** BUILD SUCCEEDED/FAILED **`` lines.

    * **Test phase** (``swift test``):

      - Collapse ``Test Case '…' passed`` lines into a count.
      - Keep every failing test case line and any indented failure body.
      - Keep ``Test Suite …`` summary lines.
      - Keep ``Executed N tests, with N failures`` final result lines.
    """

    name = "swift"
    binaries = frozenset(["swift"])
    subcommands = frozenset(["build", "test", "run", "package"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""
        if subcommand == "test":
            return self._compress_test(stdout, stderr)
        return self._compress_build(stdout, stderr)

    def _compress_build(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        compile_count = 0
        for line in lines:
            # Always keep diagnostics (warnings, errors) and completion lines.
            if _SWIFT_DIAG_RE.match(line) or _SWIFT_BUILD_COMPLETE_RE.match(line):
                kept.append(line)
                continue
            # Collapse verbose build-phase lines.
            if _SWIFT_COMPILE_RE.match(line):
                compile_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if compile_count:
            notes.append(f"collapsed {compile_count} Swift build-phase lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_test(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        pass_count = 0
        in_fail_block = False
        for line in lines:
            # "Test Case '…' started." — always noise, drop silently.
            if _SWIFT_TEST_START_RE.match(line):
                continue
            # Passing test: count, drop.
            if _SWIFT_TEST_PASS_RE.match(line):
                in_fail_block = False
                pass_count += 1
                continue
            # Failing test: keep and open fail block.
            if _SWIFT_TEST_FAIL_RE.match(line):
                in_fail_block = True
                kept.append(line)
                continue
            # Suite summaries and overall results are always kept.
            if _SWIFT_SUITE_RE.match(line) or _SWIFT_RESULTS_RE.match(line):
                in_fail_block = False
                kept.append(line)
                continue
            # Indented failure body lines inside a fail block.
            if in_fail_block and (line.startswith(("  ", "\t")) or not line.strip()):
                kept.append(line)
                continue
            # Any other non-indented line exits the fail block.
            in_fail_block = False
            # Also keep build-phase output that may appear before the tests.
            if _SWIFT_COMPILE_RE.match(line):
                # Silently drop compile lines during test run.
                continue
            kept.append(line)
        notes: list[str] = []
        if pass_count:
            notes.append(f"collapsed {pass_count} passing Swift test cases")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Xcode -----------------------------------------------------------------

#: xcodebuild section banner: "=== BUILD TARGET Foo OF PROJECT Bar WITH CONFIGURATION Debug ==="
_XCODE_SECTION_RE: Final[re.Pattern[str]] = re.compile(
    r"^=== .+ ===$"
)
#: xcodebuild build-phase compilation lines (the most voluminous output)
_XCODE_COMPILE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(CompileSwiftSources|CompileSwift|CompileC|CpHeader|"
    r"ProcessInfoPlistFile|CopySwiftLibs|GenerateDSYMFile|"
    r"Ld\s|CodeSign\s|Touch\s|PhaseScriptExecution\s|"
    r"MergeSwiftModule\s|CompileAssetCatalog\s|"
    r"RegisterWithLaunchServices\s|Validate\s|CreateBuildDirectory\s)"
    r"\s*"
)
#: xcodebuild final status banner
_XCODE_STATUS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\*\*\s*BUILD (SUCCEEDED|FAILED)\s*\*\*"
    r"|^\*\*\s*TEST (SUCCEEDED|FAILED)\s*\*\*"
    r"|^\*\*\s*RUN (SUCCEEDED|FAILED)\s*\*\*"
)
#: xcodebuild warning/error diagnostics (file:line:col: warning/error)
_XCODE_DIAG_RE: Final[re.Pattern[str]] = re.compile(
    r"^.+:\d+:\d+:\s+(warning|error):\s"
)
#: xcodebuild sub-task lines with a leading timestamp/progress number
_XCODE_TASK_BODY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s{4,}"
)


class XcodeFilter(Filter):
    """Compress ``xcodebuild`` output.

    ``xcodebuild`` is one of the most verbose build tools in the Apple
    ecosystem.  A typical build of an iOS app emits thousands of lines for
    each compilation unit (``CompileSwiftSources``, ``CpHeader``,
    ``ProcessInfoPlistFile``, etc.) followed by section banners and the final
    ``** BUILD SUCCEEDED **`` or ``** BUILD FAILED **`` line.

    Compression model:

    * **Keep** ``=== BUILD TARGET … ===`` section headers verbatim (useful for
      navigation; usually 1–5 lines per target).
    * **Keep** ``** BUILD SUCCEEDED **`` / ``** BUILD FAILED **`` banner.
    * **Keep** every ``warning:`` / ``error:`` diagnostic line verbatim.
    * **Collapse** ``CompileSwiftSources``, ``CpHeader``, ``ProcessInfoPlistFile``
      and other repetitive build-phase lines into a per-type count summary.
    """

    name = "xcode"
    binaries = frozenset(["xcodebuild"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        compile_count = 0
        for line in lines:
            # Always keep section headers, status banners, and diagnostics.
            if (
                _XCODE_SECTION_RE.match(line)
                or _XCODE_STATUS_RE.match(line)
                or _XCODE_DIAG_RE.match(line)
            ):
                kept.append(line)
                continue
            # Collapse verbose build-phase task lines.
            if _XCODE_COMPILE_RE.match(line):
                compile_count += 1
                continue
            # Deeply indented task-body lines (sub-output of a build phase):
            # drop when the parent phase is already collapsed.
            if _XCODE_TASK_BODY_RE.match(line):
                compile_count += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if compile_count:
            notes.append(f"collapsed {compile_count} xcodebuild build-phase lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Elixir Mix -------------------------------------------------------------

#: mix deps.get: "* Getting dep-name (hex package)"
_MIX_GETTING_DEP_RE: Final[re.Pattern[str]] = re.compile(
    r"^\* Getting (\S+)\s"
)
#: mix compile: "Compiling N files (.ex)"
_MIX_COMPILING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Compiling \d+ file"
)
#: mix compile: "Generated app_name app"
_MIX_GENERATED_RE: Final[re.Pattern[str]] = re.compile(
    r"^Generated \S+ app$"
)
#: mix compile: "warning: ..."
_MIX_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*warning:"
)
#: mix test: ExUnit progress dots / letters (. E F *)
_MIX_TEST_DOTS_RE: Final[re.Pattern[str]] = re.compile(
    r"^[.EF*]+\s*$"
)
#: mix test: "N tests, N failures" summary
_MIX_TEST_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ tests?, \d+ failure"
)
#: mix test: "Finished in N.Ns (..." — keep
_MIX_TEST_FINISHED_RE: Final[re.Pattern[str]] = re.compile(
    r"^Finished in \d"
)
#: mix test: failure section header "  N) TestModule.test_name"
_MIX_TEST_FAILURE_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\d+\)"
)
#: mix ecto.migrate: migration lines to keep (may be prefixed by Logger timestamp)
_MIX_MIGRATION_RE: Final[re.Pattern[str]] = re.compile(
    r"== (?:Running|Migrated)"
)


class MixFilter(Filter):
    """Compress ``mix`` Elixir task output.

    Mix is the Elixir build and task runner.  It covers dependency fetching
    (``mix deps.get``), compilation (``mix compile``), testing (``mix test``),
    and database migrations (``mix ecto.migrate``).

    Compression model:

    * **mix deps.get**: ``* Getting dep-name (hex package)`` lines → collapsed
      to a single ``[token-goat: Fetching N dependencies]`` summary.
    * **mix compile**: ``Compiling N files (.ex)`` lines → kept; ``warning: …``
      lines → kept; ``Generated app_name app`` lines → kept; other progress
      dropped.
    * **mix test**: ExUnit dot/letter progress (``...EF*``) collapsed to a
      pass/fail count; failure blocks with their context kept verbatim; the
      ``N tests, N failures`` / ``Finished in Xs`` summary kept.
    * **mix ecto.migrate**: ``== Running …`` / ``== Migrated …`` lines kept;
      per-query noise dropped.
    * **Errors** (exit_code != 0): stderr preserved unchanged.
    """

    name = "mix"
    binaries = frozenset(["mix"])
    subcommands = frozenset([
        "compile", "test", "deps.get", "phx.server", "ecto.migrate",
        "ecto.create", "ecto.drop", "ecto.rollback", "run", "release",
    ])

    def matches(self, argv: list[str]) -> bool:
        """Match ``mix`` with any subcommand listed in :attr:`subcommands` or no subcommand."""
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        if stem != "mix":
            return False
        # When no subcommand is given, still match so output is at least normalised.
        if not self.subcommands:
            return True
        positionals = _positional_args(argv[1:])
        if not positionals:
            return True
        return positionals[0] in self.subcommands

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        positionals = _positional_args(argv[1:])
        subcommand = positionals[0] if positionals else ""

        if subcommand == "deps.get":
            return self._compress_deps_get(stdout, stderr)
        if subcommand == "compile":
            return self._compress_compile(stdout, stderr)
        if subcommand == "test":
            return self._compress_test(stdout, stderr, exit_code)
        if subcommand in ("ecto.migrate", "ecto.rollback"):
            return self._compress_migrate(stdout, stderr)
        # Generic: ANSI/progress already stripped; just combine.
        return self._combine_output(stdout, stderr)

    def _compress_deps_get(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        fetch_count = 0
        for line in lines:
            if _MIX_GETTING_DEP_RE.match(line):
                fetch_count += 1
                continue
            kept.append(line)
        if fetch_count:
            kept.insert(0, f"[token-goat: Fetching {fetch_count} dependencies]")
        return self._finalize(kept)

    def _compress_compile(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped = 0
        for line in lines:
            if (
                _MIX_COMPILING_RE.match(line)
                or _MIX_WARNING_RE.match(line)
                or _MIX_GENERATED_RE.match(line)
                or _ERROR_SIGNAL_RE.search(line)
            ):
                kept.append(line)
                continue
            # Drop other mix compile noise (e.g. "Resolving Hex dependencies...")
            if line.strip() and not line.startswith("[") and not line.startswith("="):
                dropped += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if dropped:
            notes.append(f"dropped {dropped} mix compile progress lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_test(self, stdout: str, stderr: str, exit_code: int) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dot_pass = 0
        dot_fail = 0
        in_failure = False

        for line in lines:
            # Summary and timing lines: always keep.
            if _MIX_TEST_SUMMARY_RE.match(line) or _MIX_TEST_FINISHED_RE.match(line):
                in_failure = False
                kept.append(line)
                continue
            # Failure header "  N) Test.name" starts a failure block.
            if _MIX_TEST_FAILURE_HEADER_RE.match(line):
                in_failure = True
                kept.append(line)
                continue
            # Inside a failure block, keep everything (context is load-bearing).
            if in_failure:
                kept.append(line)
                continue
            # Dot progress lines: count passes and failures.
            if _MIX_TEST_DOTS_RE.match(line):
                dot_pass += line.count(".")
                dot_fail += line.count("F") + line.count("E")
                continue
            kept.append(line)

        notes: list[str] = []
        if dot_pass or dot_fail:
            notes.append(f"collapsed progress: {dot_pass} passed, {dot_fail} failed")
        self._emit_notes(kept, notes)
        return self._finalize(kept)

    def _compress_migrate(self, stdout: str, stderr: str) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        dropped = 0
        for line in lines:
            if _MIX_MIGRATION_RE.search(line) or _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if line.strip():
                dropped += 1
                continue
            kept.append(line)
        notes: list[str] = []
        if dropped:
            notes.append(f"dropped {dropped} migration detail lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- PHP Composer -----------------------------------------------------------

#: composer install/update: "  - Installing vendor/package (version): Loading from cache"
_COMPOSER_INSTALL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+- Installing (\S+) \("
)
#: composer install/update: "  - Downloading vendor/package (version)"
_COMPOSER_DOWNLOADING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+- Downloading (\S+) \("
)
#: composer: progress percentage lines "  - Downloading vendor/package (version) (100%)"
_COMPOSER_DOWNLOAD_PROGRESS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+- (?:Installing|Downloading) .+\(\d+%\)"
)
#: composer autoload lines to keep
_COMPOSER_AUTOLOAD_RE: Final[re.Pattern[str]] = re.compile(
    r"^Generating(?: optimized)? autoload"
)
#: composer "Package operations: N installs, M updates, ..." — keep
_COMPOSER_OPERATIONS_RE: Final[re.Pattern[str]] = re.compile(
    r"^Package operations:"
)
#: composer: "N packages you are using are looking for funding" — drop (pure noise)
_COMPOSER_FUNDING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ packages? you are using are looking for funding"
)
#: composer: deprecation / constraint warning lines
_COMPOSER_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:Warning|Deprecation|deprecated|constraint):", re.IGNORECASE
)


class ComposerFilter(Filter):
    """Compress ``composer install``, ``composer update``, and ``composer require`` output.

    PHP Composer emits one line per package for installs, downloads, and
    cache hits.  A project with 100+ dependencies can produce 300+ lines
    that are essentially all noise.

    Compression model:

    * **Collapse** ``  - Installing vendor/package (version): Loading from cache``
      and ``  - Downloading …`` lines into install/download counts.
    * **Drop** partial-download percentage lines (``(10%)``, ``(50%)``, …).
    * **Drop** ``N packages you are using are looking for funding`` (pure noise).
    * **Keep first occurrence** of each unique deprecation/constraint warning;
      deduplicate repeated warnings.
    * **Keep** ``Generating autoload files`` / ``Generated optimized autoload files``
      banners verbatim.
    * **Keep** ``Package operations: N installs, M updates`` summary line.
    * **Keep** every error line verbatim.
    """

    name = "composer"
    binaries = frozenset(["composer", "composer.phar"])
    subcommands = frozenset(["install", "update", "require", "remove", "dump-autoload"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        install_count = 0
        download_count = 0
        dropped_progress = 0
        dropped_funding = 0
        seen_warnings: set[str] = set()
        dropped_dup_warnings = 0

        for line in lines:
            # Always keep errors verbatim.
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # Drop partial-download percentage lines (noise).
            if _COMPOSER_DOWNLOAD_PROGRESS_RE.match(line):
                dropped_progress += 1
                continue
            # Drop funding noise.
            if _COMPOSER_FUNDING_RE.match(line):
                dropped_funding += 1
                continue
            # Collapse install lines to a count.
            if _COMPOSER_INSTALL_RE.match(line):
                install_count += 1
                continue
            # Collapse download lines to a count.
            if _COMPOSER_DOWNLOADING_RE.match(line):
                download_count += 1
                continue
            # Deduplicate deprecation/constraint warnings (keep first occurrence).
            if _COMPOSER_WARNING_RE.match(line):
                key = line.strip()
                if key in seen_warnings:
                    dropped_dup_warnings += 1
                    continue
                seen_warnings.add(key)
                kept.append(line)
                continue
            # Always keep autoload, operations summary, and other informational lines.
            kept.append(line)

        notes: list[str] = []
        if install_count:
            notes.append(f"collapsed {install_count} package install lines")
        if download_count:
            notes.append(f"collapsed {download_count} package download lines")
        if dropped_progress:
            notes.append(f"dropped {dropped_progress} download-progress lines")
        if dropped_funding:
            notes.append(f"dropped {dropped_funding} funding-notice lines")
        if dropped_dup_warnings:
            notes.append(f"deduplicated {dropped_dup_warnings} repeated warnings")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# ---------------------------------------------------------------------------
# MSBuild
# ---------------------------------------------------------------------------

#: "Build started" / project-is-building header lines
_MSBUILD_BUILD_STARTED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Build started",
    re.IGNORECASE,
)
#: "Project ... is building" project header (multi-project parallel builds)
_MSBUILD_PROJECT_BUILDING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Project\s+\".+\"\s+\(targets?\)",
    re.IGNORECASE,
)
#: "Copying file from ... to ..." lines
_MSBUILD_COPY_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Copying file from\s+",
    re.IGNORECASE,
)
#: "Creating directory ..." lines
_MSBUILD_MKDIR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Creating directory\s+",
    re.IGNORECASE,
)
#: Task name lines like "  GenerateResource:" / "  Csc:" / "  Link:"
_MSBUILD_TASK_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s{2,4}[A-Z][A-Za-z0-9]+:\s*$",
)
#: "Build succeeded." line
_MSBUILD_SUCCEEDED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Build succeeded\.\s*$",
    re.IGNORECASE,
)
#: "X Error(s) / Warning(s)" summary lines
_MSBUILD_SUMMARY_COUNT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*\d+\s+(?:Error|Warning)\(s\)\s*$",
    re.IGNORECASE,
)
#: MSBuild error line with (file:line) location  e.g. "file.cs(10,5): error CS0001: ..."
_MSBUILD_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r".*\(\d+(?:,\d+)?\)\s*:\s*error\s+",
    re.IGNORECASE,
)
#: MSBuild warning line with (file:line) location
_MSBUILD_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r".*\(\d+(?:,\d+)?\)\s*:\s*warning\s+(\w+)",
    re.IGNORECASE,
)
#: General MSBuild "done building" / "target ... skipped" noise lines
_MSBUILD_NOISE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:Done building|Target\s+\".+\"\s+skipped|Time Elapsed)\b",
    re.IGNORECASE,
)


class MSBuildFilter(Filter):
    """Compress ``msbuild`` / ``MSBuild.exe`` output.

    MSBuild emits verbose per-target task and file-copy lines that add little
    signal.  This filter collapses them to counts while keeping all actionable
    content.

    Compression model:

    * **Build started / project-building headers**: keep the first occurrence;
      collapse repeats to a count note.
    * **Copying file from ... to ...**:  collapse all occurrences per pass to
      a count note.
    * **Creating directory ...**: collapse to a count note.
    * **Task-name-only lines** (``  Csc:``, ``  Link:``): collapse to a count
      note when no errors follow immediately.
    * **Build succeeded.**: keep verbatim.
    * **X Error(s) / X Warning(s)** summary lines: keep verbatim.
    * **Error lines** with ``(file:line)`` location: keep verbatim.
    * **Warning lines**: keep, but deduplicate same warning code.
    * **General noise** (``Done building``, skipped targets, ``Time Elapsed``):
      drop on success; keep on failure.
    """

    name = "msbuild"
    binaries = frozenset(["msbuild", "msbuild.exe"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        name = Path(argv[0]).name.lower()
        return stem == "msbuild" or name == "msbuild.exe"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        kept: list[str] = []
        build_started_count = 0
        copy_count = 0
        mkdir_count = 0
        task_count = 0
        dropped_noise = 0
        seen_warning_codes: set[str] = set()
        dup_warning_count = 0

        for line in lines:
            # Error lines: always keep
            if _MSBUILD_ERROR_RE.match(line):
                kept.append(line)
                continue
            # Summary count lines and build-succeeded: always keep
            if _MSBUILD_SUCCEEDED_RE.match(line) or _MSBUILD_SUMMARY_COUNT_RE.match(line):
                kept.append(line)
                continue
            # Warning lines: keep, but deduplicate same warning code
            m = _MSBUILD_WARNING_RE.match(line)
            if m:
                code = m.group(1).upper()
                if code in seen_warning_codes:
                    dup_warning_count += 1
                else:
                    seen_warning_codes.add(code)
                    kept.append(line)
                continue
            # "Build started" headers: keep first, collapse repeats
            if _MSBUILD_BUILD_STARTED_RE.match(line) or _MSBUILD_PROJECT_BUILDING_RE.match(line):
                build_started_count += 1
                if build_started_count == 1:
                    kept.append(line)
                continue
            # Copying file lines
            if _MSBUILD_COPY_RE.match(line):
                copy_count += 1
                continue
            # Creating directory lines
            if _MSBUILD_MKDIR_RE.match(line):
                mkdir_count += 1
                continue
            # Task-name-only lines (e.g. "  Csc:")
            if _MSBUILD_TASK_RE.match(line):
                task_count += 1
                continue
            # Noise lines on success
            if _MSBUILD_NOISE_RE.match(line) and exit_code == 0:
                dropped_noise += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if build_started_count > 1:
            notes.append(f"collapsed {build_started_count - 1} repeated build-started headers")
        if copy_count:
            notes.append(f"collapsed {copy_count} file-copy lines")
        if mkdir_count:
            notes.append(f"collapsed {mkdir_count} directory-creation lines")
        if task_count:
            notes.append(f"collapsed {task_count} task-name lines")
        if dropped_noise:
            notes.append(f"dropped {dropped_noise} noise lines")
        if dup_warning_count:
            notes.append(f"deduplicated {dup_warning_count} repeated warnings")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# ---------------------------------------------------------------------------
# NuGet
# ---------------------------------------------------------------------------

#: "Installing PackageName version X.Y.Z" lines
_NUGET_INSTALLING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Installing\s+\S+\s+\d+\.\d+",
    re.IGNORECASE,
)
#: "Restoring packages for ..." lines
_NUGET_RESTORING_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Restoring packages for\b",
    re.IGNORECASE,
)
#: "OK https://..." download-confirmation lines
_NUGET_OK_HTTPS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*OK\s+https?://",
    re.IGNORECASE,
)
#: "Package X [version] is already installed" lines
_NUGET_ALREADY_INSTALLED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Package\s+\S+.*\bis already installed",
    re.IGNORECASE,
)
#: "Successfully installed 'Package Version'" lines
_NUGET_SUCCESS_INSTALL_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Successfully installed\s+",
    re.IGNORECASE,
)


class NuGetFilter(Filter):
    """Compress ``nuget`` / ``nuget.exe`` / ``nuget restore`` output.

    NuGet emits per-package download, restore, and install lines for each
    package in the dependency graph.  This filter collapses them to counts.

    Compression model:

    * **Installing PackageName version**: collapse to a count note.
    * **Restoring packages for ...**: collapse multiple to a single line.
    * **OK https://...**: collapse per-package download confirmations to count.
    * **Package ... is already installed**: collapse to a count note.
    * **Successfully installed 'pkg version'**: keep a single summary count.
    * **Error lines**: keep verbatim.
    """

    name = "nuget"
    binaries = frozenset(["nuget", "nuget.exe"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        name_lower = Path(argv[0]).name.lower()
        return stem == "nuget" or name_lower == "nuget.exe"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        kept: list[str] = []
        installing_count = 0
        restoring_paths: list[str] = []
        ok_download_count = 0
        already_installed_count = 0
        success_install_count = 0

        for line in lines:
            # Error lines: always keep
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            if _NUGET_INSTALLING_RE.match(line):
                installing_count += 1
                continue
            if _NUGET_RESTORING_RE.match(line):
                restoring_paths.append(line.strip())
                continue
            if _NUGET_OK_HTTPS_RE.match(line):
                ok_download_count += 1
                continue
            if _NUGET_ALREADY_INSTALLED_RE.match(line):
                already_installed_count += 1
                continue
            if _NUGET_SUCCESS_INSTALL_RE.match(line):
                success_install_count += 1
                continue
            kept.append(line)

        # Emit a single "Restoring packages" line if any were seen
        if restoring_paths:
            if len(restoring_paths) == 1:
                kept.insert(0, restoring_paths[0])
            else:
                kept.insert(0, f"Restoring packages for {len(restoring_paths)} projects")

        notes: list[str] = []
        if installing_count:
            notes.append(f"collapsed {installing_count} package-install lines")
        if ok_download_count:
            notes.append(f"collapsed {ok_download_count} package-download lines")
        if already_installed_count:
            notes.append(f"collapsed {already_installed_count} already-installed lines")
        if success_install_count:
            notes.append(f"collapsed {success_install_count} successfully-installed lines")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# ---------------------------------------------------------------------------
# PowerShell
# ---------------------------------------------------------------------------

#: "VERBOSE: ..." lines (Set-PSDebug -Trace or $VerbosePreference)
_PWSH_VERBOSE_RE: Final[re.Pattern[str]] = re.compile(
    r"^VERBOSE:\s",
    re.IGNORECASE,
)
#: "DEBUG: ..." lines
_PWSH_DEBUG_RE: Final[re.Pattern[str]] = re.compile(
    r"^DEBUG:\s",
    re.IGNORECASE,
)
#: "WARNING: ..." lines
_PWSH_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^WARNING:\s",
    re.IGNORECASE,
)
#: Install-Module progress lines ("PackageManagement\...") or "Install-Module: ..."
_PWSH_INSTALL_MODULE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Install-Module:|PackageManagement\\|Installing package)\s",
    re.IGNORECASE,
)
#: Progress-record lines e.g. "Processing record X of Y" / "PROGRESS: X% complete"
_PWSH_PROGRESS_RECORD_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Processing record\s+\d+\s+of\s+\d+|PROGRESS:\s+\d+%)",
    re.IGNORECASE,
)
#: Terminating error indicator lines ("At line:", "CategoryInfo:", "FullyQualifiedErrorId:")
_PWSH_TERMINATING_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:At\s+\S+:\d+\s+char:\d+|CategoryInfo\s*:|FullyQualifiedErrorId\s*:|\+\s+~~~)",
)


class PowerShellFilter(Filter):
    """Compress ``pwsh`` / ``powershell`` / ``powershell.exe`` output.

    PowerShell scripts commonly emit VERBOSE/DEBUG streams, Install-Module
    progress, and progress-record lines that add noise without signal.

    Compression model:

    * **VERBOSE: ...** lines: collapse to a count note.
    * **DEBUG: ...** lines: collapse to a count note.
    * **WARNING: ...** lines: keep, but deduplicate identical warnings.
    * **Install-Module / PackageManagement progress** lines: collapse to count.
    * **Processing record X of Y** / progress-percent lines: collapse to count.
    * **Terminating error blocks** (``At line:``, ``CategoryInfo:``): keep verbatim.
    """

    name = "powershell"
    binaries = frozenset(["pwsh", "powershell", "powershell.exe"])

    def matches(self, argv: list[str]) -> bool:  # noqa: D102
        if not argv:
            return False
        stem = Path(argv[0]).stem.lower()
        name_lower = Path(argv[0]).name.lower()
        return stem in {"pwsh", "powershell"} or name_lower == "powershell.exe"

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        kept: list[str] = []
        verbose_count = 0
        debug_count = 0
        install_module_count = 0
        progress_count = 0
        seen_warnings: set[str] = set()
        dup_warning_count = 0

        for line in lines:
            # Terminating error detail lines: always keep
            if _PWSH_TERMINATING_ERROR_RE.match(line):
                kept.append(line)
                continue
            # General error signals: always keep
            if _ERROR_SIGNAL_RE.search(line):
                kept.append(line)
                continue
            # VERBOSE lines
            if _PWSH_VERBOSE_RE.match(line):
                verbose_count += 1
                continue
            # DEBUG lines
            if _PWSH_DEBUG_RE.match(line):
                debug_count += 1
                continue
            # WARNING lines: keep unique, deduplicate repeats
            if _PWSH_WARNING_RE.match(line):
                key = line.strip()
                if key in seen_warnings:
                    dup_warning_count += 1
                else:
                    seen_warnings.add(key)
                    kept.append(line)
                continue
            # Install-Module progress lines
            if _PWSH_INSTALL_MODULE_RE.match(line):
                install_module_count += 1
                continue
            # Progress-record lines
            if _PWSH_PROGRESS_RECORD_RE.match(line):
                progress_count += 1
                continue
            kept.append(line)

        notes: list[str] = []
        if verbose_count:
            notes.append(f"collapsed {verbose_count} VERBOSE lines")
        if debug_count:
            notes.append(f"collapsed {debug_count} DEBUG lines")
        if install_module_count:
            notes.append(f"collapsed {install_module_count} Install-Module progress lines")
        if progress_count:
            notes.append(f"collapsed {progress_count} progress-record lines")
        if dup_warning_count:
            notes.append(f"deduplicated {dup_warning_count} repeated warnings")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


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
# Security scanners: Bandit, Trivy, Snyk, Semgrep
# ---------------------------------------------------------------------------

# --- Bandit ----------------------------------------------------------------

#: "Run started:" banner line.
_BANDIT_RUN_STARTED_RE: Final[re.Pattern[str]] = re.compile(r"^Run started:")
#: "Test results:" section header.
_BANDIT_TEST_RESULTS_RE: Final[re.Pattern[str]] = re.compile(r"^Test results:")
#: Issue header — Severity + Confidence columns.
_BANDIT_ISSUE_SEVERITY_RE: Final[re.Pattern[str]] = re.compile(
    r"^>>\s+Issue:\s+\[", re.IGNORECASE,
)
#: Individual issue metadata lines (Location, More Info, …).
_BANDIT_ISSUE_META_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+(Severity|Confidence|CWE|Location|More Info):",
)
#: "Code scanned:" stats block opener.
_BANDIT_CODE_SCANNED_RE: Final[re.Pattern[str]] = re.compile(r"^Code scanned:")
#: "Total issues (by severity)" table header.
_BANDIT_TOTAL_ISSUES_RE: Final[re.Pattern[str]] = re.compile(
    r"^Total issues \(by",
)
#: Numeric stat line inside the Code scanned / Total issues blocks.
_BANDIT_STAT_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\|?\s*\d"
)
#: "testing <file>" per-file progress line emitted with -v or in some versions.
_BANDIT_TESTING_RE: Final[re.Pattern[str]] = re.compile(r"^testing\s")


class BanditFilter(Filter):
    """Compress ``bandit`` Python security-scan output.

    Bandit emits one issue block per finding:

    .. code-block:: text

        >> Issue: [B101:assert_used] Use of assert detected.
           Severity: Low   Confidence: High
           CWE: CWE-703
           Location: src/foo.py:42:4

    On a large codebase the LOW severity blocks are often 80 %+ of the output
    and rarely require immediate action.

    Compression model:

    * **Keep** the ``Run started:`` banner.
    * **Keep** the ``Test results:`` section header.
    * **Keep** HIGH and MEDIUM severity issue blocks verbatim.
    * **Collapse** LOW severity issue blocks to a running count.
    * **Keep** the ``Code scanned:`` stats block.
    * **Keep** the ``Total issues (by severity)`` table.
    * **Drop** per-file ``testing <file>`` progress lines.
    """

    name = "bandit"
    binaries = frozenset(["bandit"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []
        low_dropped = 0

        # State machine: are we inside an issue block?
        in_issue = False
        current_severity: str = ""
        issue_buf: list[str] = []

        def flush_issue() -> None:
            nonlocal low_dropped
            sev = current_severity.upper()
            if sev in ("HIGH", "MEDIUM"):
                kept.extend(issue_buf)
            else:
                low_dropped += 1

        in_stats_block = False

        for line in lines:
            # Always drop per-file progress lines.
            if _BANDIT_TESTING_RE.match(line):
                continue

            # Detect stats block openers — flush any pending issue first.
            if _BANDIT_CODE_SCANNED_RE.match(line) or _BANDIT_TOTAL_ISSUES_RE.match(line):
                if in_issue:
                    flush_issue()
                    in_issue = False
                    issue_buf = []
                    current_severity = ""
                in_stats_block = True
                kept.append(line)
                continue

            # Inside stats block: keep numeric stat lines and blank delimiters.
            if in_stats_block:
                if _BANDIT_STAT_LINE_RE.match(line) or not line.strip():
                    kept.append(line)
                else:
                    # Next non-blank non-stat line closes the stats block.
                    in_stats_block = False
                    # Fall through to normal processing below.

            if in_stats_block:
                continue

            # Issue block opener.
            if _BANDIT_ISSUE_SEVERITY_RE.match(line):
                if in_issue:
                    flush_issue()
                    issue_buf = []
                    current_severity = ""
                in_issue = True
                issue_buf.append(line)
                continue

            # Inside an issue block, accumulate metadata lines.
            if in_issue and (
                _BANDIT_ISSUE_META_RE.match(line) or line.strip().startswith("--") or line.strip() == ""
            ):
                issue_buf.append(line)
                if line.strip() == "" or line.strip().startswith("--"):
                    # Blank or separator line terminates the block.
                    flush_issue()
                    in_issue = False
                    issue_buf = []
                    current_severity = ""
                    if line.strip():
                        kept.append(line)
                else:
                    # Extract severity for later decision.
                    sev_m = re.search(r"Severity:\s*(\w+)", line, re.IGNORECASE)
                    if sev_m:
                        current_severity = sev_m.group(1)
                continue

            # Always keep: run banner, section headers, other lines.
            if (
                _BANDIT_RUN_STARTED_RE.match(line)
                or _BANDIT_TEST_RESULTS_RE.match(line)
            ):
                kept.append(line)
                continue

            kept.append(line)

        # Flush a trailing open issue block.
        if in_issue:
            flush_issue()

        notes: list[str] = []
        if low_dropped:
            notes.append(f"collapsed {low_dropped} LOW severity issue block(s)")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- Trivy -----------------------------------------------------------------

#: Trivy INFO / WARN / DEBUG log lines emitted to stderr.
_TRIVY_LOG_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*\s+(?:INFO|WARN|DEBUG|ERROR)\s",
)
#: Trivy table separator line (all dashes / plus).
_TRIVY_TABLE_SEP_RE: Final[re.Pattern[str]] = re.compile(r"^[+|-]+$")
#: Trivy vulnerability table data row — starts with "| library |".
_TRIVY_TABLE_ROW_RE: Final[re.Pattern[str]] = re.compile(r"^\|")
#: "Total: N (CRITICAL: X, HIGH: Y, MEDIUM: Z, LOW: W)" summary line.
_TRIVY_TOTAL_RE: Final[re.Pattern[str]] = re.compile(
    r"^Total:\s*\d+", re.IGNORECASE,
)
#: "No vulnerabilities found" messages.
_TRIVY_NO_VULN_RE: Final[re.Pattern[str]] = re.compile(
    r"no\s+vulnerabilit", re.IGNORECASE,
)
#: Target / library header lines (e.g. "Python (python-pkg)", "OS Packages").
_TRIVY_TARGET_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:[-=]+\s+)?(?:Python|Ruby|Node\.js|Go|Java|PHP|Rust|OS Packages|Alpine|"
    r"Debian|Ubuntu|RHEL|CentOS|npm|pip|gem|cargo|pom\.xml|Gemfile\.lock|"
    r"requirements|package-lock|yarn\.lock|composer\.lock|go\.sum|Cargo\.lock|\S+\s+\("
    r")",
    re.IGNORECASE,
)


class TrivyFilter(Filter):
    """Compress ``trivy`` container/filesystem vulnerability scan output.

    Trivy tables can be enormous when scanning a base image that carries
    hundreds of MEDIUM/LOW findings while only a handful are CRITICAL/HIGH.

    Compression model:

    * **Drop** INFO/WARN/DEBUG log lines (timestamped lines to stderr) — they
      are download/setup chatter, not findings.
    * **Keep** CRITICAL and HIGH vulnerability rows in the table.
    * **Collapse** MEDIUM, LOW, and UNKNOWN rows to per-library counts.
    * **Keep** the ``Total: N (CRITICAL: X, HIGH: Y, ...)`` summary line.
    * **Keep** "No vulnerabilities found" messages verbatim.
    * **Keep** table header rows (column names + separator lines).
    * **Keep** target/library section headers.
    """

    name = "trivy"
    binaries = frozenset(["trivy"])

    # Severity ordering — rows in the table have a SEVERITY column.
    _HIGH_SEPS: Final[frozenset[str]] = frozenset(["CRITICAL", "HIGH"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        # Merge stderr (log lines) and stdout (table) separately then combine.
        # First strip log-noise from stderr.
        clean_err_lines = [
            ln for ln in stderr.split("\n")
            if not _TRIVY_LOG_RE.match(ln)
        ]
        log_dropped = len(stderr.split("\n")) - len(clean_err_lines) if stderr.strip() else 0
        clean_err = "\n".join(clean_err_lines).strip()

        # Process stdout table.
        out_lines = stdout.split("\n")
        kept: list[str] = []
        # Per-library MEDIUM/LOW/UNKNOWN collapsed counts: library → {sev: count}
        low_med_counts: dict[str, dict[str, int]] = {}
        in_table = False
        # Column index of SEVERITY field — we parse it from the header row.
        sev_col_idx: int = -1
        lib_col_idx: int = -1

        def _parse_table_cols(header_line: str) -> None:
            nonlocal sev_col_idx, lib_col_idx
            cols = [c.strip() for c in header_line.split("|")]
            for i, c in enumerate(cols):
                cu = c.upper()
                if cu == "SEVERITY":
                    sev_col_idx = i
                if cu in ("LIBRARY", "PACKAGE", "VULNERABILITY ID") and lib_col_idx == -1:
                    lib_col_idx = i

        def _flush_low_med() -> None:
            for lib, sev_counts in sorted(low_med_counts.items()):
                summary = ", ".join(f"{sev}: {cnt}" for sev, cnt in sorted(sev_counts.items()))
                kept.append(f"[token-goat: {lib} — {summary} (collapsed)]")
            low_med_counts.clear()

        for line in out_lines:
            # No-vuln messages are always preserved.
            if _TRIVY_NO_VULN_RE.search(line):
                kept.append(line)
                continue
            # Total summary line — always keep.
            if _TRIVY_TOTAL_RE.match(line):
                _flush_low_med()
                kept.append(line)
                continue
            # Table separator line.
            if _TRIVY_TABLE_SEP_RE.match(line):
                kept.append(line)
                in_table = bool(line)
                continue
            # Table header row — detect column positions.
            if in_table and line.startswith("|") and "SEVERITY" in line.upper():
                _parse_table_cols(line)
                kept.append(line)
                continue
            # Table data row.
            if in_table and _TRIVY_TABLE_ROW_RE.match(line):
                cols = [c.strip() for c in line.split("|")]
                sev = ""
                if 0 <= sev_col_idx < len(cols):
                    sev = cols[sev_col_idx].upper()
                if sev in self._HIGH_SEPS:
                    kept.append(line)
                else:
                    # Collapse MEDIUM/LOW/UNKNOWN by library.
                    lib = "unknown"
                    if 0 <= lib_col_idx < len(cols):
                        lib = cols[lib_col_idx] or "unknown"
                    if lib not in low_med_counts:
                        low_med_counts[lib] = {}
                    low_med_counts[lib][sev or "UNKNOWN"] = (
                        low_med_counts[lib].get(sev or "UNKNOWN", 0) + 1
                    )
                continue
            # Target/library section header.
            if _TRIVY_TARGET_RE.match(line) or line.startswith("=") or line.startswith("-"):
                _flush_low_med()
                in_table = False
                sev_col_idx = -1
                lib_col_idx = -1
                kept.append(line)
                continue
            kept.append(line)

        _flush_low_med()

        out_text = self._finalize(kept)
        notes: list[str] = []
        if log_dropped:
            notes.append(f"dropped {log_dropped} Trivy INFO/WARN/DEBUG log lines")
        self._emit_notes(kept, notes)

        if clean_err:
            out_text = (out_text.rstrip() + "\n---\n" + clean_err) if out_text.strip() else clean_err
        return out_text


# --- Snyk ------------------------------------------------------------------

#: Snyk "Testing <package>..." first line.
_SNYK_TESTING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Testing\s", re.IGNORECASE,
)
#: Snyk dependency tree lines using box-drawing characters.
_SNYK_TREE_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:[├└│\s]|[|\\`][-\s]|  )"
)
#: Snyk vuln block opener — lines like "✗ High severity vulnerability found"
#: or "Low severity vulnerability found in foo".
_SNYK_VULN_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:✗|x|X)?\s*(?:Critical|High|Medium|Low|Info)\s+severity",
    re.IGNORECASE,
)
#: "More about this vulnerability:" URL-only lines.
_SNYK_MORE_ABOUT_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:More about this vulnerability|https?://\S+)",
    re.IGNORECASE,
)
#: Snyk summary line — "✔ X unique vulnerabilities" or "✗ X issues".
_SNYK_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:✔|✗|Tested\s+\d+|unique vulnerabilities|no vulnerable paths|issues found)",
    re.IGNORECASE,
)
#: License issue lines.
_SNYK_LICENSE_RE: Final[re.Pattern[str]] = re.compile(
    r"license", re.IGNORECASE,
)


class SnykFilter(Filter):
    """Compress ``snyk`` security scan output.

    Snyk output for a large monorepo can contain deep dependency trees,
    lengthy vulnerability blocks, and "More about..." URL sections.

    Compression model:

    * **Keep** the first ``Testing <pkg>...`` line; drop subsequent progress
      lines.
    * **Collapse** deep dependency tree lines (├─, └─, │) to a count after
      the first 10.
    * **Keep** vulnerability block headers (severity + package name +
      description opener).
    * **Collapse** ``More about this vulnerability:`` / bare URL lines inside
      a vuln block (typically 3–5 lines) to a single token-goat note.
    * **Keep** summary lines (unique vulnerabilities, issues found, licence
      issues).
    * **Keep** license issue lines verbatim.
    """

    name = "snyk"
    binaries = frozenset(["snyk"])

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []

        testing_seen = False
        tree_lines = 0
        tree_hidden = 0
        in_more_about = False
        more_about_dropped = 0

        for line in lines:
            # --- Testing progress ---
            if _SNYK_TESTING_RE.match(line):
                if not testing_seen:
                    kept.append(line)
                    testing_seen = True
                # else drop subsequent "Testing ..." lines
                continue

            # --- Summary lines always kept ---
            if _SNYK_SUMMARY_RE.search(line):
                if tree_hidden:
                    kept.append(f"[token-goat: +{tree_hidden} dependency tree lines collapsed]")
                    tree_hidden = 0
                kept.append(line)
                continue

            # --- License issue lines always kept ---
            if _SNYK_LICENSE_RE.search(line) and not _SNYK_TREE_LINE_RE.match(line):
                kept.append(line)
                continue

            # --- "More about..." / URL-only lines ---
            if _SNYK_MORE_ABOUT_RE.match(line):
                in_more_about = True
                more_about_dropped += 1
                continue
            if in_more_about:
                # The block ends when we hit a non-URL, non-blank line.
                if line.strip() and not line.strip().startswith("http"):
                    in_more_about = False
                    if more_about_dropped:
                        kept.append(
                            f"[token-goat: collapsed {more_about_dropped} 'More about' URL line(s)]"
                        )
                        more_about_dropped = 0
                    # Fall through to normal handling.
                else:
                    more_about_dropped += 1
                    continue

            # --- Vulnerability block headers ---
            if _SNYK_VULN_HEADER_RE.search(line):
                if tree_hidden:
                    kept.append(f"[token-goat: +{tree_hidden} dependency tree lines collapsed]")
                    tree_hidden = 0
                kept.append(line)
                continue

            # --- Dependency tree lines ---
            if _SNYK_TREE_LINE_RE.match(line) and line.strip():
                tree_lines += 1
                if tree_lines <= 10:
                    kept.append(line)
                else:
                    tree_hidden += 1
                continue

            # --- All other lines pass through ---
            if tree_hidden and not _SNYK_TREE_LINE_RE.match(line):
                kept.append(f"[token-goat: +{tree_hidden} dependency tree lines collapsed]")
                tree_hidden = 0
            if more_about_dropped:
                kept.append(
                    f"[token-goat: collapsed {more_about_dropped} 'More about' URL line(s)]"
                )
                more_about_dropped = 0
            kept.append(line)

        # Flush trailing counts.
        if tree_hidden:
            kept.append(f"[token-goat: +{tree_hidden} dependency tree lines collapsed]")
        if more_about_dropped:
            kept.append(
                f"[token-goat: collapsed {more_about_dropped} 'More about' URL line(s)]"
            )
        return self._finalize(kept)


# --- Semgrep ---------------------------------------------------------------

#: "Scanning N files..." progress line.
_SEMGREP_SCANNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Scanning\s+\d+|Running\s+\d+)",
    re.IGNORECASE,
)
#: Semgrep rule match header — "  severity   rule-id" or "rule-id" lines.
_SEMGREP_RULE_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(ERROR|WARNING|INFO|HIGH|MEDIUM|LOW|CRITICAL)\s+\S"
    r"|^[^\s/][^/\s]*\.[a-zA-Z0-9_-]+\s*$",
    re.IGNORECASE,
)
#: File:line citation inside a rule match block.
_SEMGREP_FILE_LOC_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s+\d+\s*[│|]\s|^\s*[^:\s]+:\d+",
)
#: "Details:" URL line.
_SEMGREP_DETAILS_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*Details:\s*https?://",
    re.IGNORECASE,
)
#: Final summary line.
_SEMGREP_SUMMARY_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:Ran\s+\d+|Findings?:|✔|✘|\d+\s+finding)",
    re.IGNORECASE,
)
#: Semgrep autofix / rule source annotation lines.
_SEMGREP_ANNOTATION_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?:run|fix|autofix|rule):\s*https?://",
    re.IGNORECASE,
)


class SemgrepFilter(Filter):
    """Compress ``semgrep`` static analysis output.

    Semgrep can emit thousands of lines when the same rule fires across
    hundreds of files.  The agent needs rule identity, severity, and the
    first few instances — not every occurrence.

    Compression model:

    * **Keep** the first ``Scanning N files...`` line.
    * **Keep** rule match blocks (rule id + file:line + code snippet); drop
      ``Details:`` / annotation URL lines.
    * **Collapse** repeated matches for the same rule across many files: show
      the first 3 instances, collapse the rest to a count.
    * **Keep** the ``Ran N rules on N files: N findings`` summary.
    """

    name = "semgrep"
    binaries = frozenset(["semgrep"])

    # Max instances of the same rule to keep before collapsing.
    _MAX_PER_RULE: int = 3

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        kept: list[str] = []

        scanning_seen = False
        details_dropped = 0
        # rule_id → count of instances already emitted
        rule_counts: dict[str, int] = {}
        # rule_id → count of instances suppressed
        rule_suppressed: dict[str, int] = {}

        # We do a two-pass approach:
        # Pass 1: split into blocks (each rule match is a block).
        # Pass 2: emit first _MAX_PER_RULE blocks per rule, suppress rest.

        # Build blocks: a block starts at a non-indented rule-id line and
        # ends just before the next such line or the summary.
        # For simplicity, we do a single pass with state tracking.

        current_rule: str | None = None
        current_block: list[str] = []

        def flush_block() -> None:
            nonlocal details_dropped
            if current_rule is None:
                kept.extend(current_block)
                return
            count = rule_counts.get(current_rule, 0)
            if count < self._MAX_PER_RULE:
                # Emit block, stripping Details: lines.
                block_out = []
                local_dropped = 0
                for bl in current_block:
                    if _SEMGREP_DETAILS_RE.match(bl) or _SEMGREP_ANNOTATION_RE.match(bl):
                        local_dropped += 1
                    else:
                        block_out.append(bl)
                if local_dropped:
                    block_out.append(
                        f"  [token-goat: collapsed {local_dropped} Details/annotation URL line(s)]"
                    )
                    details_dropped += local_dropped
                kept.extend(block_out)
                rule_counts[current_rule] = count + 1
            else:
                rule_suppressed[current_rule] = rule_suppressed.get(current_rule, 0) + 1

        for line in lines:
            # Scanning banner — keep first occurrence only.
            if _SEMGREP_SCANNING_RE.match(line):
                if not scanning_seen:
                    # Flush any open block first.
                    flush_block()
                    current_rule = None
                    current_block = []
                    kept.append(line)
                    scanning_seen = True
                continue

            # Summary line — flush and always keep.
            if _SEMGREP_SUMMARY_RE.match(line):
                flush_block()
                current_rule = None
                current_block = []
                # Emit suppression notes before summary.
                for rule_id, sup_cnt in sorted(rule_suppressed.items()):
                    kept.append(
                        f"[token-goat: {rule_id} — {sup_cnt} additional match(es) collapsed "
                        f"(kept first {self._MAX_PER_RULE})]"
                    )
                rule_suppressed.clear()
                kept.append(line)
                continue

            # Rule match header — non-indented rule id or severity+rule line.
            # Detect by: non-blank, not starting with spaces, and looks like a
            # rule path or severity keyword.
            is_rule_header = (
                line
                and not line[0].isspace()
                and (
                    _SEMGREP_RULE_HEADER_RE.match(line)
                    or "." in line.split("/")[-1]
                    or re.match(r"^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+", line)
                )
                and not _SEMGREP_SUMMARY_RE.match(line)
                and not _SEMGREP_SCANNING_RE.match(line)
            )
            if is_rule_header:
                flush_block()
                current_rule = line.strip()
                current_block = [line]
                continue

            # Everything else goes into the current block.
            current_block.append(line)

        # Flush trailing block.
        flush_block()
        # Emit any unseen suppression notes at end.
        for rule_id, sup_cnt in sorted(rule_suppressed.items()):
            kept.append(
                f"[token-goat: {rule_id} — {sup_cnt} additional match(es) collapsed "
                f"(kept first {self._MAX_PER_RULE})]"
            )

        return self._finalize(kept)


# ---------------------------------------------------------------------------
# Database CLI filters
# ---------------------------------------------------------------------------

# --- psql ------------------------------------------------------------------

#: psql connection error prefix emitted before any query result.
_PSQL_CONN_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^psql:\s+error:", re.IGNORECASE,
)
#: psql \timing output: "Time: 3.412 ms"
_PSQL_TIMING_RE: Final[re.Pattern[str]] = re.compile(
    r"^Time:\s+[\d.]+\s+ms", re.IGNORECASE,
)
#: DML result lines: "INSERT 0 5", "UPDATE 3", "DELETE 7", "CREATE TABLE", etc.
_PSQL_CMD_TAG_RE: Final[re.Pattern[str]] = re.compile(
    r"^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|CREATE|DROP|ALTER|COPY|"
    r"DO|GRANT|REVOKE|SET|BEGIN|COMMIT|ROLLBACK)\b",
    re.IGNORECASE,
)
#: psql NOTICE / WARNING server messages.
_PSQL_NOTICE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(NOTICE|WARNING|HINT|DETAIL):", re.IGNORECASE,
)
#: psql ERROR lines — kept verbatim.
_PSQL_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(ERROR|FATAL|PANIC):", re.IGNORECASE,
)
#: psql table border line: starts with one or more dashes/plusses (ASCII art table).
_PSQL_TABLE_BORDER_RE: Final[re.Pattern[str]] = re.compile(r"^[+\-]+$|^\([\d]+ rows?\)$")
#: psql "N rows" footer.
_PSQL_ROWS_RE: Final[re.Pattern[str]] = re.compile(r"^\((\d+) rows?\)$")
#: Migration DDL lines: CREATE TABLE, CREATE INDEX, CREATE SEQUENCE, CREATE TYPE, etc.
_PSQL_CREATE_RE: Final[re.Pattern[str]] = re.compile(
    r"^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE SEQUENCE|"
    r"CREATE TYPE|CREATE FUNCTION|CREATE VIEW|CREATE TRIGGER|ALTER TABLE|"
    r"ADD CONSTRAINT)\b",
    re.IGNORECASE,
)


class PsqlFilter(Filter):
    """Compress ``psql`` PostgreSQL CLI output.

    Compression model:

    * **Keep** ``\\timing`` output (``Time: Xms``).
    * **Keep** DML result tags (``INSERT N``, ``UPDATE N``, ``DELETE N``, etc.).
    * **Keep** NOTICE / WARNING / HINT / DETAIL messages.
    * **Keep** ERROR / FATAL / PANIC messages verbatim.
    * **Keep** ``psql: error:`` connection errors verbatim.
    * **Collapse** SELECT table output with >20 rows: keep headers + first 5
      data rows + ``(N rows)`` footer.
    * **Collapse** long migration output (repeated CREATE TABLE/INDEX lines):
      summarise as ``Created N tables, N indexes``.
    """

    name = "psql"
    binaries = frozenset(["psql"])

    _TABLE_ROW_THRESHOLD: int = 20
    _TABLE_KEEP_ROWS: int = 5

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        return self._compress_psql(merged)

    def _compress_psql(self, text: str) -> str:
        lines = text.split("\n")

        # Check for migration-style output first (bulk DDL).
        create_tables = sum(
            1 for ln in lines if re.match(r"^CREATE TABLE\b", ln, re.IGNORECASE)
        )
        create_indexes = sum(
            1 for ln in lines
            if re.match(r"^CREATE (UNIQUE )?INDEX\b", ln, re.IGNORECASE)
        )
        if create_tables >= 3:
            # Summarise the bulk DDL block; keep non-DDL lines.
            non_ddl: list[str] = []
            for ln in lines:
                if _PSQL_CREATE_RE.match(ln):
                    continue
                non_ddl.append(ln)
            summary_parts = [f"{create_tables} tables"]
            if create_indexes:
                summary_parts.append(f"{create_indexes} indexes")
            non_ddl.insert(0, f"[token-goat: Created {', '.join(summary_parts)}]")
            return self._finalize(non_ddl)

        # Pass for SELECT table output: detect header separator and data rows.
        kept: list[str] = []
        # State: collecting a tabular SELECT result.
        in_table = False
        header_lines: list[str] = []  # column header + separator border
        data_rows: list[str] = []
        after_header = False

        def flush_table() -> None:
            nonlocal in_table, header_lines, data_rows, after_header
            if not header_lines:
                in_table = False
                return
            total_rows = len(data_rows)
            kept.extend(header_lines)
            if total_rows > self._TABLE_ROW_THRESHOLD:
                kept.extend(data_rows[: self._TABLE_KEEP_ROWS])
                kept.append(
                    f"[token-goat: {total_rows} rows (showing first {self._TABLE_KEEP_ROWS})]"
                )
            else:
                kept.extend(data_rows)
            in_table = False
            header_lines = []
            data_rows = []
            after_header = False

        for line in lines:
            # Always keep connection errors, errors, timing, DML tags, notices.
            if (
                _PSQL_CONN_ERROR_RE.match(line)
                or _PSQL_ERROR_RE.match(line)
                or _PSQL_TIMING_RE.match(line)
                or _PSQL_CMD_TAG_RE.match(line)
                or _PSQL_NOTICE_RE.match(line)
            ):
                if in_table:
                    flush_table()
                kept.append(line)
                continue

            # Detect start of ASCII table (top border or column header border).
            # psql renders: " col1 | col2 \n------+------\n val | val \n------+------\n(N rows)"
            # The first dashes-only line after the column names is the separator.
            stripped = line.strip()

            # Top border of aligned table output (e.g. "------+------").
            is_border = bool(re.match(r"^[-+]+$", stripped))
            # "N rows" footer.
            rows_m = _PSQL_ROWS_RE.match(stripped)

            if rows_m:
                # Footer of a SELECT result.
                if in_table:
                    flush_table()
                kept.append(line)
                continue

            if is_border:
                if not in_table:
                    # Beginning of a table: the line before this was the header.
                    # Move last kept line into header_lines.
                    if kept:
                        header_lines.append(kept.pop())
                    header_lines.append(line)
                    in_table = True
                    after_header = True
                else:
                    if after_header:
                        header_lines.append(line)
                        after_header = False
                    else:
                        # Closing border — flush.
                        flush_table()
                        kept.append(line)
                continue

            if in_table:
                data_rows.append(line)
            else:
                kept.append(line)

        if in_table:
            flush_table()

        return self._finalize(kept)


# --- mysql / mysqldump -------------------------------------------------------

#: "N rows in set (0.00 sec)" — keep.
_MYSQL_ROWS_IN_SET_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ rows? in set", re.IGNORECASE,
)
#: "N row affected (0.00 sec)" — keep.
_MYSQL_ROWS_AFFECTED_RE: Final[re.Pattern[str]] = re.compile(
    r"^\d+ rows? affected", re.IGNORECASE,
)
#: MySQL WARNING line (from mysql CLI).
_MYSQL_WARNING_RE: Final[re.Pattern[str]] = re.compile(
    r"^(WARNING|WARN)\b", re.IGNORECASE,
)
#: MySQL ERROR line.
_MYSQL_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(ERROR|FATAL)\b", re.IGNORECASE,
)
#: mysqldump "-- Table structure for table `foo`" comment.
_MYSQLDUMP_TABLE_STRUCT_RE: Final[re.Pattern[str]] = re.compile(
    r"^-- Table structure for table\b", re.IGNORECASE,
)
#: mysqldump header banner lines ("-- MySQL dump …", "-- Host:", "-- Server version:").
_MYSQLDUMP_BANNER_RE: Final[re.Pattern[str]] = re.compile(
    r"^-- (MySQL dump|Host:|Server version:|Dump completed)", re.IGNORECASE,
)
#: mysqldump "-- Dumping data for table" comment.
_MYSQLDUMP_DATA_RE: Final[re.Pattern[str]] = re.compile(
    r"^-- Dumping (data|events|routines|triggers) for\b", re.IGNORECASE,
)
#: MySQL table border line in tabular query output.
_MYSQL_TABLE_BORDER_RE: Final[re.Pattern[str]] = re.compile(r"^\+-+")


class MySQLFilter(Filter):
    """Compress ``mysql`` and ``mysqldump`` output.

    Compression model (mysql query results):

    * **Collapse** SELECT table results with >20 rows: keep headers + first 5
      rows + ``"X rows in set"`` footer.
    * **Keep** ``"N rows in set"`` / ``"N rows affected"`` summary lines.
    * **Keep** WARNING lines.
    * **Keep** ERROR lines verbatim.

    Compression model (mysqldump):

    * **Keep** the dump header banner.
    * **Keep** the first 3 CREATE TABLE blocks; collapse the rest to a count.
    * **Keep** ``-- Dumping data for table`` markers.
    * **Keep** ERROR lines verbatim.
    """

    name = "mysql"
    binaries = frozenset(["mysql", "mysqldump"])

    _TABLE_ROW_THRESHOLD: int = 20
    _TABLE_KEEP_ROWS: int = 5
    _DUMP_KEEP_TABLES: int = 3

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        binary_name = Path(argv[0]).name.lower() if argv else ""
        merged = self._combine_output(stdout, stderr)
        if "mysqldump" in binary_name:
            return self._compress_dump(merged)
        return self._compress_query(merged)

    def _compress_query(self, text: str) -> str:
        """Compress tabular mysql query results."""
        lines = text.split("\n")
        kept: list[str] = []
        # State machine phases:
        #   0 = outside table
        #   1 = saw top border
        #   2 = saw column header row
        #   3 = saw second border (now collecting data rows)
        phase = 0
        header_lines: list[str] = []
        data_rows: list[str] = []

        def flush_table() -> None:
            nonlocal phase, header_lines, data_rows
            kept.extend(header_lines)
            total = len(data_rows)
            if total > self._TABLE_ROW_THRESHOLD:
                kept.extend(data_rows[: self._TABLE_KEEP_ROWS])
                kept.append(
                    f"[token-goat: {total} rows (showing first {self._TABLE_KEEP_ROWS})]"
                )
            else:
                kept.extend(data_rows)
            phase = 0
            header_lines = []
            data_rows = []

        for line in lines:
            # Always keep signal lines.
            if (
                _MYSQL_ERROR_RE.match(line)
                or _MYSQL_WARNING_RE.match(line)
                or _MYSQL_ROWS_IN_SET_RE.match(line)
                or _MYSQL_ROWS_AFFECTED_RE.match(line)
            ):
                if phase > 0:
                    flush_table()
                kept.append(line)
                continue

            stripped = line.strip()
            is_border = bool(_MYSQL_TABLE_BORDER_RE.match(stripped))

            if is_border:
                if phase == 0:
                    # Top border: start collecting header.
                    phase = 1
                    header_lines.append(line)
                elif phase == 1:
                    # Second border immediately after top: malformed; keep.
                    header_lines.append(line)
                    phase = 2
                elif phase == 2:
                    # Border after column name row: this is the header separator.
                    header_lines.append(line)
                    phase = 3
                else:
                    # phase == 3: closing border.
                    flush_table()
                    kept.append(line)
                continue

            if phase == 0:
                kept.append(line)
            elif phase == 1:
                # Column name row.
                header_lines.append(line)
                phase = 2
            elif phase == 2:
                # Should be the separator border; treat as column row just in case.
                header_lines.append(line)
            else:
                # phase == 3: data rows.
                data_rows.append(line)

        if phase > 0:
            flush_table()

        return self._finalize(kept)

    def _compress_dump(self, text: str) -> str:
        """Compress mysqldump output: keep first N CREATE TABLE blocks."""
        lines = text.split("\n")
        kept: list[str] = []
        tables_kept = 0
        tables_collapsed = 0
        in_create = False  # inside a CREATE TABLE block
        skip_block = False  # skipping a collapsed CREATE TABLE block

        for line in lines:
            # Always keep errors.
            if _MYSQL_ERROR_RE.match(line):
                kept.append(line)
                continue

            # mysqldump banner / data markers — always keep.
            if _MYSQLDUMP_BANNER_RE.match(line) or _MYSQLDUMP_DATA_RE.match(line):
                kept.append(line)
                continue

            # "-- Table structure for table `name`" comment — keep with first N tables.
            if _MYSQLDUMP_TABLE_STRUCT_RE.match(line):
                if tables_kept < self._DUMP_KEEP_TABLES:
                    tables_kept += 1
                    in_create = True
                    skip_block = False
                    kept.append(line)
                else:
                    tables_collapsed += 1
                    in_create = True
                    skip_block = True
                continue

            if in_create:
                # A blank line between table blocks closes the block.
                if not line.strip():
                    in_create = False
                    skip_block = False
                    if not skip_block:
                        kept.append(line)
                    continue
                if not skip_block:
                    kept.append(line)
                continue

            kept.append(line)

        notes: list[str] = []
        if tables_collapsed:
            notes.append(f"Dumping {tables_kept + tables_collapsed} tables...")
        self._emit_notes(kept, notes)
        return self._finalize(kept)


# --- sqlite3 ---------------------------------------------------------------

#: sqlite3 error lines.
_SQLITE3_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(Error:|Parse error:|Runtime error:)", re.IGNORECASE,
)
#: sqlite3 .schema / .tables output opener (CREATE TABLE / CREATE INDEX / etc.).
_SQLITE3_SCHEMA_RE: Final[re.Pattern[str]] = re.compile(
    r"^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIEW|CREATE TRIGGER)\b",
    re.IGNORECASE,
)


class Sqlite3Filter(Filter):
    """Compress ``sqlite3`` CLI output.

    Compression model:

    * **Collapse** long SELECT results (>20 rows): keep first 5 + count marker.
    * **Keep** ``.schema`` output as-is (usually compact; only truncate when
      giant via the universal line cap).
    * **Keep** error lines (``Error:``, ``Parse error:``, ``Runtime error:``)
      verbatim.
    """

    name = "sqlite3"
    binaries = frozenset(["sqlite3"])

    _ROW_THRESHOLD: int = 20
    _KEEP_ROWS: int = 5

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")
        # Schema output (detected by majority of lines starting with CREATE): pass through.
        non_empty = [ln for ln in lines if ln.strip()]
        schema_lines = [ln for ln in non_empty if _SQLITE3_SCHEMA_RE.match(ln)]
        if non_empty and len(schema_lines) / len(non_empty) >= 0.5:
            # Majority is schema — keep as-is; line cap handles giant files.
            return merged

        # For query results: keep errors always; collapse long output.
        errors = [ln for ln in lines if _SQLITE3_ERROR_RE.match(ln)]
        data_lines = [ln for ln in lines if not _SQLITE3_ERROR_RE.match(ln)]
        non_empty_data = [ln for ln in data_lines if ln.strip()]

        kept: list[str] = []
        kept.extend(errors)

        if len(non_empty_data) > self._ROW_THRESHOLD:
            kept.extend(non_empty_data[: self._KEEP_ROWS])
            kept.append(
                f"[token-goat: {len(non_empty_data)} rows "
                f"(showing first {self._KEEP_ROWS})]"
            )
        else:
            kept.extend(data_lines)

        return self._finalize(kept)


# --- redis-cli ---------------------------------------------------------------

#: redis-cli error lines ("ERR ...", "WRONGTYPE ...", "(error) ...").
_REDIS_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"^(\(error\)|ERR |WRONGTYPE |NOAUTH |NOSCRIPT |BUSYKEY |MISCONF )",
    re.IGNORECASE,
)
#: A single "OK" line (from SET / HSET / etc.).
_REDIS_OK_RE: Final[re.Pattern[str]] = re.compile(r"^OK$")
#: SCAN output: "1) (cursor)" line or "2) 1) key" list lines.
_REDIS_SCAN_CURSOR_RE: Final[re.Pattern[str]] = re.compile(r"^\d+\) \(integer\) \d+")
#: Individual key/value lines in list output: "1) \"key\"" or " 1) \"key\"".
_REDIS_LIST_ITEM_RE: Final[re.Pattern[str]] = re.compile(r"^\s*\d+\)\s+")


class RedisCLIFilter(Filter):
    """Compress ``redis-cli`` output.

    Compression model:

    * **Collapse** ``KEYS *`` output with >20 keys: keep first 10 + count.
    * **Collapse** ``LRANGE`` / ``SMEMBERS`` / ``HGETALL`` results with >20
      items: keep first 10 + count.
    * **Collapse** bulk ``OK`` lines (repeated SET operations): count summary.
    * **Collapse** ``SCAN`` cursor pages: emit final key total.
    * **Keep** error lines verbatim.
    """

    name = "redis-cli"
    binaries = frozenset(["redis-cli"])

    _LIST_THRESHOLD: int = 20
    _LIST_KEEP: int = 10

    def compress(
        self, stdout: str, stderr: str, exit_code: int, argv: list[str],
    ) -> str:
        merged = self._combine_output(stdout, stderr)
        lines = merged.split("\n")

        # Detect SCAN output: multiple cursor blocks.
        if self._is_scan_output(lines):
            return self._compress_scan(lines)

        # Detect bulk OK (multiple consecutive OK lines).
        ok_count = sum(1 for ln in lines if _REDIS_OK_RE.match(ln.strip()))
        if ok_count >= 5:
            return self._compress_bulk_ok(lines, ok_count)

        # Detect long list-style output (numbered items).
        list_items = [ln for ln in lines if _REDIS_LIST_ITEM_RE.match(ln)]
        if len(list_items) > self._LIST_THRESHOLD:
            return self._compress_list(lines, list_items)

        # Default: keep everything; errors always pass through.
        return self._finalize(lines)

    def _is_scan_output(self, lines: list[str]) -> bool:
        """Return True when output looks like one or more SCAN cursor responses.

        SCAN responses have the distinctive shape:
          1) (integer) <cursor>   ← cursor line
          2) 1) "key1"            ← start of key sublist
             2) "key2"
        The cursor line matches ``^\\d+\\) \\(integer\\) \\d+``.  Plain list
        output (LRANGE / SMEMBERS) never has that cursor pattern.
        """
        return any(re.match(r"^\d+\) \(integer\) \d+", ln) for ln in lines)

    def _compress_scan(self, lines: list[str]) -> str:
        """Collapse SCAN pages to a total key count."""
        all_keys: list[str] = []
        errors: list[str] = []
        # Collect all quoted key entries from the nested list.
        for line in lines:
            if _REDIS_ERROR_RE.match(line):
                errors.append(line)
                continue
            # Key entries look like: `1) "keyname"` (indented or not).
            m = re.match(r'^\s*\d+\)\s+"(.+)"', line)
            if m:
                all_keys.append(m.group(1))

        kept: list[str] = errors
        total = len(all_keys)
        if total > self._LIST_KEEP:
            kept += [f'"{k}"' for k in all_keys[: self._LIST_KEEP]]
            kept.append(
                f"[token-goat: {total} keys total (showing first {self._LIST_KEEP})]"
            )
        else:
            kept += [f'"{k}"' for k in all_keys]
        return self._finalize(kept)

    def _compress_bulk_ok(self, lines: list[str], ok_count: int) -> str:
        """Collapse repeated OK lines to a count; keep non-OK lines."""
        kept: list[str] = []
        for line in lines:
            if _REDIS_OK_RE.match(line.strip()):
                continue
            if _REDIS_ERROR_RE.match(line):
                kept.append(line)
                continue
            kept.append(line)
        kept.append(f"[token-goat: {ok_count} OK responses]")
        return self._finalize(kept)

    def _compress_list(self, lines: list[str], list_items: list[str]) -> str:
        """Collapse long list output to first N items + count."""
        kept: list[str] = []
        item_count = 0
        total = len(list_items)
        for line in lines:
            if _REDIS_ERROR_RE.match(line):
                kept.append(line)
                continue
            if _REDIS_LIST_ITEM_RE.match(line):
                if item_count < self._LIST_KEEP:
                    kept.append(line)
                item_count += 1
            else:
                kept.append(line)
        if total > self._LIST_KEEP:
            kept.append(
                f"[token-goat: {total} items (showing first {self._LIST_KEEP})]"
            )
        return self._finalize(kept)


# ---------------------------------------------------------------------------
# Public registry & dispatch
# ---------------------------------------------------------------------------

#: Ordered registry of built-in filters.  First match wins, so more-specific
#: filters (named binaries) precede the generic fallback.  Users can append
#: their own :class:`Filter` subclasses but cannot redefine built-ins.
FILTERS: list[Filter] = [
    PytestFilter(),
    JestFilter(),
    # VitestFilter must follow JestFilter: vitest binaries are disjoint from
    # jest/mocha/ava/tap so ordering is cosmetic, but explicit placement keeps
    # test-runner filters together and documents the split clearly.
    VitestFilter(),
    CargoFilter(),
    # PnpmFilter and YarnFilter are more specific than NodePackageFilter and must
    # precede it so that pnpm/yarn commands get dedicated compression rather than
    # the generic npm/pnpm/yarn/bun handler.
    PnpmFilter(),
    YarnFilter(),
    NodePackageFilter(),
    # DockerComposeFilter must precede DockerFilter: both match `docker`, but
    # DockerComposeFilter only fires when the `compose` subcommand is present,
    # so it is strictly more specific.  docker-compose binary is also claimed
    # exclusively here.
    DockerComposeFilter(),
    DockerFilter(),
    # KubectlLogsFilter must precede KubectlFilter: both match `kubectl`/`k`,
    # but KubectlLogsFilter only fires for the `logs` subcommand and provides
    # richer deduplication (timestamp normalisation, JSON blob collapsing,
    # stack-trace collapsing, access-log summary).
    KubectlLogsFilter(),
    # HelmFilter handles `helm` exclusively.  KubectlFilter previously claimed
    # `helm` as one of its binaries; HelmFilter precedes it so helm commands
    # get the dedicated install/list/template compression.
    HelmFilter(),
    KubectlFilter(),
    # AwsCliFilter precedes AwsFilter: both match the `aws` binary, but
    # AwsCliFilter provides richer S3 transfer collapsing and tighter JSON
    # array thresholds.  AwsFilter is kept as a fallback for any edge case
    # not covered by AwsCliFilter.
    AwsCliFilter(),
    AwsFilter(),
    # GcloudFilter handles the Google Cloud SDK `gcloud` binary.
    GcloudFilter(),
    # AzureCliFilter handles the Azure CLI `az` binary.
    AzureCliFilter(),
    # GhRunLogFilter must precede GhFilter: both match `gh`, but GhRunLogFilter
    # only fires for `gh run view --log` (the raw log variant) and provides
    # richer timestamp-stripping and group-collapsing.  GhFilter remains the
    # catch-all for all other `gh` subcommands.
    GhRunLogFilter(),
    GhFilter(),
    # ActFilter handles the `act` local GitHub Actions runner.
    ActFilter(),
    # GenericCIFilter is a keyword-matched catch-all for generic CI log output.
    # It must be placed LAST (or near last) because its matches() fires on any
    # command containing ``--log``/``logs``/``pipeline``/``workflow`` — which
    # would incorrectly claim commands handled by more specific filters if
    # placed earlier.  The only exception is that it must appear before the
    # truly generic GenericFilter (if one exists).
    GenericCIFilter(),
    RuffFilter(),
    MypyFilter(),
    # ESLintFilter precedes LinterFilter so `eslint` routes to the dedicated
    # filter; LinterFilter handles tsc / stylelint / biome / rome / pyright /
    # pylint which share no binaries with ESLintFilter.
    ESLintFilter(),
    LinterFilter(),
    GrepFilter(),
    # Dedicated git sub-filters must precede GitFilter: each claims a specific
    # subcommand (log / diff / show / status / blame) with richer compression.
    # GitFilter remains the catch-all for every other git subcommand.
    GitLogFilter(),
    GitDiffFilter(),
    GitStatusVerboseFilter(),
    GitBlameFilter(),
    GitFilter(),
    # GoTestFilter must precede GoFilter: `go test` routes to the dedicated
    # test filter; other go subcommands (build/get/mod/…) route to GoFilter.
    # GoFilter must precede MakeFilter so `go build` routes to GoFilter rather
    # than the generic make/build-system compression in MakeFilter.
    # GradleFilter, MavenFilter, AntFilter, and BazelFilter must also precede
    # MakeFilter for the same reason.
    GoTestFilter(),
    GoFilter(),
    GradleFilter(),
    MavenFilter(),
    # JavacFilter handles standalone `javac` invocations; disjoint from
    # AntFilter (which handles [javac] lines inside ant builds).
    JavacFilter(),
    AntFilter(),
    BazelFilter(),
    # SbtFilter handles `sbt` and `./sbt`; disjoint from every other filter.
    SbtFilter(),
    MakeFilter(),
    TerraformFilter(),
    # AnsibleFilter and PreCommitFilter have disjoint binaries from every
    # other filter (``ansible*`` and ``pre-commit`` respectively), so their
    # position within the registry is purely cosmetic — placed alongside
    # other deployment-style tooling.
    AnsibleFilter(),
    PreCommitFilter(),
    # FlutterFilter handles `flutter build/test/run/pub`; DartFilter handles
    # `dart compile/test/pub/analyze`; PubFilter handles standalone `pub get/upgrade`.
    # All three are disjoint from every other filter.
    FlutterFilter(),
    DartFilter(),
    PubFilter(),
    # SwiftFilter handles `swift build/test/run/package`; registered before
    # XcodeFilter (disjoint binaries so ordering is cosmetic but explicit).
    SwiftFilter(),
    # XcodeFilter handles `xcodebuild` (disjoint from every other filter).
    XcodeFilter(),
    PipFilter(),
    UvFilter(),
    # CondaFilter handles conda/mamba/micromamba package management; disjoint
    # binaries from every other filter so position is cosmetic.
    CondaFilter(),
    CurlFilter(),
    RsyncFilter(),
    DotnetFilter(),
    # MSBuildFilter handles standalone `msbuild` / `MSBuild.exe` invocations;
    # disjoint from DotnetFilter (which handles `dotnet build` MSBuild wrapping).
    MSBuildFilter(),
    # NuGetFilter handles standalone `nuget` / `nuget.exe` invocations;
    # disjoint from DotnetFilter (which handles `dotnet restore`).
    NuGetFilter(),
    # PowerShellFilter handles `pwsh`, `powershell`, and `powershell.exe`.
    PowerShellFilter(),
    # RubyFilter handles rspec / minitest / ruby / rake.  BundlerFilter handles
    # `bundle install` / `bundle update` / `bundler`.  Both have disjoint
    # binaries from every other filter so their position is cosmetic.
    RubyFilter(),
    BundlerFilter(),
    # MixFilter handles Elixir mix tasks (compile, test, deps.get, ecto.migrate, …).
    # ComposerFilter handles PHP Composer (install, update, require).  Both have
    # disjoint binaries from every other filter so position is cosmetic.
    MixFilter(),
    ComposerFilter(),
    # CmakeFilter precedes MakeFilter so cmake's configure/build output gets
    # the specialised percentage-line collapsing; cmake can also drive make
    # but cmake --build wraps the actual build system transparently.
    CmakeFilter(),
    # DiffFilter handles plain POSIX diff output.  GitFilter already covers
    # git-diff; DiffFilter is for diff, diff3, sdiff, and colordiff.
    DiffFilter(),
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
    # Security scanners — disjoint binaries from all other filters.
    BanditFilter(),
    TrivyFilter(),
    SnykFilter(),
    SemgrepFilter(),
    # Database CLI filters — disjoint binaries from all other filters.
    PsqlFilter(),
    MySQLFilter(),
    Sqlite3Filter(),
    RedisCLIFilter(),
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
