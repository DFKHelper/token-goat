"""Collapse repeated and structurally similar log lines to reduce noise."""
from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Timestamp / ID normalization patterns (used to group structural duplicates)
# ---------------------------------------------------------------------------

_NORMALIZERS: list[tuple[re.Pattern[str], str]] = [
    # ISO-8601 timestamps
    (re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<ts>"),
    # HH:MM:SS (optional ms)
    (re.compile(r"\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b"), "<ts>"),
    # Unix timestamps in ms (13 digits)
    (re.compile(r"\b\d{13}\b"), "<ts>"),
    # UUIDs
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<id>"),
    # Short hex IDs (request IDs, trace IDs — 8-32 hex chars prefixed by common patterns)
    (re.compile(r"(?:req_|trace_|span_|txn_|id[=: _])[0-9a-fA-F]{6,32}"), "<id>"),
    # IP addresses
    (re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "<ip>"),
    # Numeric line-variable values like "200ms", "1.2s", sizes "4096 bytes"
    (re.compile(r"\b\d+(?:\.\d+)?(?:ms|µs|us|ns|s\b|B|KB|MB|GB|bytes?)"), "<N>"),
]


def _normalize(line: str) -> str:
    for pattern, replacement in _NORMALIZERS:
        line = pattern.sub(replacement, line)
    return line


# ---------------------------------------------------------------------------
# Core folding logic
# ---------------------------------------------------------------------------


@dataclass
class FoldResult:
    lines: list[str]
    original_count: int
    output_count: int

    @property
    def reduction_pct(self) -> int:
        if not self.original_count:
            return 0
        return round(100 * (1 - self.output_count / self.original_count))


def fold_log(
    text: str,
    *,
    normalize: bool = True,
    tail: int | None = None,
) -> FoldResult:
    """Collapse repeated and structurally similar log lines.

    Consecutive identical lines are folded to ``[Nx] <line>``.
    When *normalize* is True, lines that differ only in timestamps, UUIDs, or
    numeric values are treated as identical for counting purposes (the first
    occurrence's raw text is preserved as the representative line).

    *tail* keeps only the last N output lines.
    """
    raw_lines = text.splitlines()
    original_count = len(raw_lines)

    if not raw_lines:
        return FoldResult(lines=[], original_count=0, output_count=0)

    out: list[str] = []
    current_raw = raw_lines[0]
    current_key = _normalize(current_raw) if normalize else current_raw
    run = 1

    def flush(raw: str, count: int) -> None:
        if count == 1:
            out.append(raw)
        else:
            out.append(f"[{count}x] {raw}")

    for raw in raw_lines[1:]:
        key = _normalize(raw) if normalize else raw
        if key == current_key:
            run += 1
        else:
            flush(current_raw, run)
            current_raw = raw
            current_key = key
            run = 1

    flush(current_raw, run)

    if tail is not None and tail > 0:
        out = out[-tail:]

    return FoldResult(lines=out, original_count=original_count, output_count=len(out))


def format_fold_text(result: FoldResult) -> str:
    body = "\n".join(result.lines)
    note = (
        f"\n— {result.output_count} line(s) from {result.original_count} "
        f"({result.reduction_pct}% reduction)"
    )
    return body + note if result.lines else "(empty)"
