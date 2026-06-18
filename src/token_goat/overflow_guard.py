"""Overflow guard — cap oversized command output to protect the model's context.

token-goat's whole purpose is to *reduce* token burn, so a surgical-read command
that dumps a 10k-line file would be self-defeating. ``guard()`` is the final
safety net: it head-truncates text on a line boundary when the estimated token
count exceeds the configured ceiling, appending an actionable marker that tells
the agent how to narrow the request.
"""

from __future__ import annotations

from . import config
from .util import sanitize_surrogates, strip_ansi

# House marker style matches bash_cache._TRUNC_MARKER: "[token-goat: …]".
_MARKER_MARGIN_TOKENS = 64  # reserve headroom so the appended marker itself stays within budget


def estimate_tokens(text: str) -> int:
    """Conservative token estimate: ~3 chars/token after stripping ANSI color.

    Mirrors ``compact.estimate_tokens`` (the most conservative estimator in the
    codebase) so the guard never *under*-counts and lets an oversized payload slip
    through. ANSI escapes are stripped first because color codes inflate length
    without adding model-visible tokens.
    """
    stripped = strip_ansi(text)
    return max(1, len(stripped) // 3 + 1)


def guard(
    text: str,
    *,
    command: str = "",
    max_tokens: int | None = None,
    enabled: bool | None = None,
) -> str:
    """Return *text* unchanged, or head-truncated with a marker if it overflows.

    When *enabled* / *max_tokens* are ``None`` they are loaded from
    ``config.load().overflow_guard``. The guard is a no-op when disabled, when
    ``max_tokens <= 0`` (explicit "never cap"), or when the estimate is within
    budget. Otherwise it keeps as many leading whole lines as fit under the
    budget (reserving ~64 tokens for the marker) and appends a single marker
    line explaining the cap and how to narrow the request.
    """
    if enabled is None or max_tokens is None:
        cfg = config.load().overflow_guard
        if enabled is None:
            enabled = cfg.enabled
        if max_tokens is None:
            max_tokens = cfg.max_tokens

    if not enabled or max_tokens <= 0:
        return text

    total_tokens = estimate_tokens(text)
    if total_tokens <= max_tokens:
        return text

    lines = text.split("\n")
    total_lines = len(lines)

    # Token budget for the body, reserving margin for the marker line itself.
    body_budget = max(1, max_tokens - _MARKER_MARGIN_TOKENS)
    # ~3 chars/token -> char budget. Keep leading whole lines until we'd exceed it.
    char_budget = body_budget * 3

    kept: list[str] = []
    used = 0
    for ln in lines:
        cost = len(strip_ansi(ln)) + 1  # +1 for the newline that rejoins this line.
        if not kept and cost > char_budget:
            # Single giant leading line (no early newline) already blows the budget: hard-slice it so a minified blob can't pass through whole.
            kept.append(ln[:char_budget])
            break
        if kept and used + cost > char_budget:
            break
        kept.append(ln)
        used += cost

    shown = len(kept)
    hint = _hint_for(command)
    marker = (
        f"[token-goat: output capped at ~{max_tokens} tokens to protect context "
        f"— showing {shown} of {total_lines} lines. {hint}]"
    )
    # sanitize_surrogates guards the non-fail-soft typer.echo at the emit sites: the hard-slice can sever a multi-byte char (or carry a pre-existing lone surrogate), which would raise UnicodeEncodeError on the Windows codepage. Identity on clean text.
    return sanitize_surrogates("\n".join(kept) + "\n" + marker)


def _hint_for(command: str) -> str:
    """Tailor the remediation hint to the originating command label."""
    cmd = (command or "").strip().lower()
    if cmd == "symbol":
        return "Request a specific method (file.py::Class.method) or use --json for structured access."
    if cmd in {"heading", "section"}:
        return "Request a narrower sub-heading, e.g. 'doc.md::Section#2'."
    if cmd == "lines":
        return "Request a smaller line range, e.g. 'file.py::100-150'."
    if cmd in {"bash-output", "web-output"}:
        return "Use --grep PATTERN, --section HEADING, or --tail N to narrow the cached output."
    return "Narrow your query or raise [overflow_guard] max_tokens in config."
