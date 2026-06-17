"""Prompt injection detection for content arriving from external sources.

Scans text from web pages, file hints, and other external inputs for patterns
that attempt to hijack the agent's behaviour. Detection is intentionally
conservative — false positives (flagging benign content) are better than false
negatives (silently passing injections through).
"""

from __future__ import annotations

import re

from .util import get_logger

_LOG = get_logger("injection")

# Patterns that signal an attempt to override or subvert agent instructions.
# All compile with IGNORECASE | MULTILINE so casing and line placement don't matter.
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE | re.MULTILINE)
    for p in [
        r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions",
        r"you\s+are\s+now\s+(?:a|an|acting\s+as)",
        r"new\s+instructions?:",
        r"system\s+prompt:",
        r"if\s+you\s+are\s+(?:an?\s+)?(?:AI|LLM|language\s+model|assistant)",
        r"<\s*/?(?:system|instruction|prompt)\s*>",
        r"\bDAN\b.*jailbreak",
        r"disregard\s+(?:your\s+)?(?:previous\s+)?(?:training|guidelines|constraints)",
    ]
)

_WARNING_PREFIX = "[WARNING: possible prompt injection detected in external content]\n\n"


def contains_injection(text: str) -> bool:
    """Return True if *text* matches any known injection pattern."""
    return any(p.search(text) for p in _INJECTION_PATTERNS)


def neutralize_injection(text: str) -> tuple[str, bool]:
    """Prepend a warning banner to *text* if injection patterns are detected.

    Returns ``(possibly_prefixed_text, was_flagged)``.
    """
    if contains_injection(text):
        return _WARNING_PREFIX + text, True
    return text, False


def check_hint_for_injection(hint: str, source: str = "") -> str | None:
    """Return *hint* unchanged if clean, or None to suppress it if injection is detected.

    Logs a warning when a hint is suppressed so the event is visible in debug logs.
    """
    if contains_injection(hint):
        _LOG.warning(
            "injection: suppressed hint from %s — matched injection pattern",
            source or "<unknown>",
        )
        return None
    return hint
