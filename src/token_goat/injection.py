"""Prompt injection and exfiltration detection for content arriving from external sources.

Patterns require complete, unambiguous adversarial phrases so legitimate content —
security documentation, AI research papers, technical tutorials — never triggers a
false positive.  Every pattern must match phrasing that cannot appear in normal
writing without adversarial intent.
"""

from __future__ import annotations

import re

from .util import get_logger

_LOG = get_logger("injection")

# Prompt injection patterns — each matches only complete adversarial phrases.
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE | re.MULTILINE)
    for p in [
        # "ignore all previous/prior instructions" — the canonical injection phrase.
        # Requires "all" to avoid FP on "ignore prior instructions from step 1" in docs.
        r"ignore\s+all\s+(?:previous|prior)\s+instructions",
        # Identity override with explicit restrictive-removal vocabulary.
        # Rejects "you are now acting as a helpful assistant" (docs) and
        # "you are now a data scientist" (role descriptions).
        r"you\s+are\s+now\s+(?:acting\s+as\s+)?(?:an?\s+)?(?:uncensored|unrestricted|jailbroken|unfiltered|free|different)\s+(?:AI|LLM|assistant|model|agent|version)",
        # DAN (Do Anything Now) jailbreak — requires the adversarial qualifier.
        r"\bDAN\b.{0,80}(?:jailbreak|no\s+restrictions|no\s+limits|anything\s+now)",
        # XML injection tags for false system/instruction context.
        # <prompt> omitted — used legitimately in LangChain/PromptLayer docs.
        r"<\s*/?(?:system|instruction)\s*>",
        # "disregard your [previous] [training|guidelines] and" — requires the
        # action continuation so "disregard its training data assumptions" in ML
        # papers does not fire.
        r"disregard\s+(?:your\s+)?(?:previous\s+)?(?:training|guidelines|alignment)\s+and",
    ]
)

# Secret exfiltration patterns — attempts to extract credentials or private config.
_EXFILTRATION_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE | re.MULTILINE)
    for p in [
        # Reveal/output system prompt verbatim.
        r"(?:reveal|output|print|repeat|show|display)\s+(?:your\s+)?(?:full\s+)?system\s+prompt",
        # Extract API key or token from the model's context.
        r"(?:output|reveal|print|exfiltrate|leak|send|share)\s+(?:your\s+)?(?:api\s+key|api\s+token|secret\s+key|access\s+token|auth\s+token)",
        # Dump environment variables.
        r"(?:print|output|list|show|display)\s+(?:all\s+)?(?:environment\s+variables?|env\s+vars?|\.env\b)",
        # Reveal SSH private key or credentials.
        r"(?:reveal|output|print|show|send)\s+(?:the\s+)?(?:ssh\s+(?:private\s+)?key|private\s+key|credentials?)\b",
    ]
)

_WARNING_PREFIX = "[WARNING: possible prompt injection detected in external content]\n\n"
_EXFIL_WARNING_PREFIX = "[WARNING: possible secret exfiltration attempt detected in external content]\n\n"


def _classify(text: str) -> tuple[bool, bool]:
    """Return ``(injection_found, exfiltration_found)`` for *text*."""
    inj = any(p.search(text) for p in _INJECTION_PATTERNS)
    exf = any(p.search(text) for p in _EXFILTRATION_PATTERNS)
    return inj, exf


def contains_injection(text: str) -> bool:
    """Return True if *text* matches any injection or exfiltration pattern."""
    inj, exf = _classify(text)
    return inj or exf


def neutralize_injection(text: str) -> tuple[str, bool]:
    """Prepend a warning banner to *text* if injection or exfiltration patterns are detected.

    Returns ``(possibly_prefixed_text, was_flagged)``.
    """
    inj, exf = _classify(text)
    if exf:
        return _EXFIL_WARNING_PREFIX + text, True
    if inj:
        return _WARNING_PREFIX + text, True
    return text, False


def check_hint_for_injection(hint: str, source: str = "") -> str:
    """Return *hint* unchanged if clean, or warning-prefixed if injection is detected.

    Always returns a string — never suppresses the hint entirely so that false
    positives do not silently drop session context.
    """
    inj, exf = _classify(hint)
    if inj or exf:
        prefix = _EXFIL_WARNING_PREFIX if exf else _WARNING_PREFIX
        _LOG.warning(
            "injection: flagged hint from %s — matched %s pattern",
            source or "<unknown>",
            "exfiltration" if exf else "injection",
        )
        return prefix + hint
    return hint
