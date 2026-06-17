"""Prompt injection and exfiltration detection for content arriving from external sources.

Patterns require complete, unambiguous adversarial phrases so legitimate content —
security documentation, AI research papers, technical tutorials — never triggers a
false positive.  Every pattern must match phrasing that cannot appear in normal
writing without adversarial intent.

Detection uses a normalised copy (NFKC + invisible-char strip) so zero-width spaces,
Unicode homoglyphs, and Tag-block smuggling characters cannot bypass the patterns.
The original text is never modified during detection; only the returned prefix/fence
reflects the finding.
"""

from __future__ import annotations

import re
import unicodedata

from .util import get_logger

_LOG = get_logger("injection")

# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

# Unicode Tag-block U+E0000–U+E007F can smuggle invisible text past detectors.
_TAG_BLOCK_RE = re.compile(r"[\U000E0000-\U000E007F]+")

# Invisible / zero-width characters that adversaries insert to break keyword matching.
_INVISIBLE_RE = re.compile(
    r"[­​-‏  ‪-‮⁠-⁤⁪-⁯﻿]+"
)

# Bounded non-word separator between keywords: handles "**ignore** all" (markdown bold),
# punctuation-separated phrases, and single Unicode glue chars — but never bridges
# across a whole word so "ignore SAFE all" can't match "ignore all".
_SEP = r"[\s\W]{1,4}"


def _normalise(text: str) -> str:
    """Return a detection-only copy: NFKC-normalised with invisible chars stripped."""
    norm = unicodedata.normalize("NFKC", text)
    norm = _INVISIBLE_RE.sub("", norm)
    return norm


def _has_tag_block(text: str) -> bool:
    return bool(_TAG_BLOCK_RE.search(text))


# ---------------------------------------------------------------------------
# Named patterns: (label, compiled_pattern)
# ---------------------------------------------------------------------------

# Prompt injection patterns — each matches only complete adversarial phrases.
_INJECTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (label, re.compile(pattern, re.IGNORECASE | re.MULTILINE))
    for label, pattern in [
        (
            # "ignore all previous/prior instructions" — the canonical injection phrase.
            # Requires "all" to avoid FP on "ignore prior instructions from step 1" in docs.
            "ignore-all-instructions",
            r"ignore" + _SEP + r"all" + _SEP + r"(?:previous|prior)" + _SEP + r"instructions",
        ),
        (
            # Identity override with explicit restrictive-removal vocabulary.
            # Rejects "you are now acting as a helpful assistant" and "you are now a data scientist".
            "identity-override",
            r"you" + _SEP + r"are" + _SEP + r"now" + _SEP + r"(?:acting" + _SEP + r"as" + _SEP + r")?(?:an?" + _SEP + r")?(?:uncensored|unrestricted|jailbroken|unfiltered|free|different)" + _SEP + r"(?:AI|LLM|assistant|model|agent|version)",
        ),
        (
            # DAN (Do Anything Now) jailbreak — requires the adversarial qualifier.
            "dan-jailbreak",
            r"\bDAN\b.{0,80}(?:jailbreak|no" + _SEP + r"restrictions|no" + _SEP + r"limits|anything" + _SEP + r"now)",
        ),
        (
            # XML injection tags for false system/instruction context.
            # <prompt> omitted — used legitimately in LangChain/PromptLayer docs.
            "xml-system-instruction",
            r"<\s*/?(?:system|instruction)\s*>",
        ),
        (
            # "disregard your [previous] [training|guidelines] and" — requires the
            # action continuation so "disregard its training data assumptions" in ML
            # papers does not fire.
            "disregard-training",
            r"disregard" + _SEP + r"(?:your" + _SEP + r")?(?:previous" + _SEP + r")?(?:training|guidelines|alignment)" + _SEP + r"and",
        ),
    ]
)

# Secret exfiltration patterns — attempts to extract credentials or private config.
_EXFILTRATION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (label, re.compile(pattern, re.IGNORECASE | re.MULTILINE))
    for label, pattern in [
        (
            "reveal-system-prompt",
            r"(?:reveal|output|print|repeat|show|display)" + _SEP + r"(?:your" + _SEP + r")?(?:full" + _SEP + r")?system" + _SEP + r"prompt",
        ),
        (
            "exfil-api-key",
            r"(?:output|reveal|print|exfiltrate|leak|send|share)" + _SEP + r"(?:your" + _SEP + r")?(?:api" + _SEP + r"key|api" + _SEP + r"token|secret" + _SEP + r"key|access" + _SEP + r"token|auth" + _SEP + r"token)",
        ),
        (
            "dump-env-vars",
            r"(?:print|output|list|show|display)" + _SEP + r"(?:all" + _SEP + r")?(?:environment" + _SEP + r"variables?|env" + _SEP + r"vars?|\.env\b)",
        ),
        (
            "reveal-credentials",
            r"(?:reveal|output|print|show|send)" + _SEP + r"(?:the" + _SEP + r")?(?:ssh" + _SEP + r"(?:private" + _SEP + r")?key|private" + _SEP + r"key|credentials?)\b",
        ),
        (
            "exfil-to-url",
            r"(?:send|post|exfiltrate|upload|forward|transmit)" + _SEP + r"(?:the" + _SEP + r")?(?:conversation|context|session|history|prompt|secrets?|credentials?|key[s]?|tokens?)" + _SEP + r"(?:to" + _SEP + r")?(?:https?://|http://|ftp://|webhook|endpoint)",
        ),
    ]
)

_WARNING_PREFIX = "[WARNING: possible prompt injection detected in external content]\n\n"
_EXFIL_WARNING_PREFIX = "[WARNING: possible secret exfiltration attempt detected in external content]\n\n"
_TAG_BLOCK_PREFIX = "[WARNING: Unicode Tag-block characters detected — possible injection smuggling attempt]\n\n"

_UNTRUSTED_FENCE_OPEN = "=== BEGIN UNTRUSTED WEB CONTENT ===\n"
_UNTRUSTED_FENCE_CLOSE = "\n=== END UNTRUSTED WEB CONTENT ==="

# Head + tail window for large content scans (4 KB each).
_SCAN_WINDOW = 4096


# ---------------------------------------------------------------------------
# Internal classification
# ---------------------------------------------------------------------------

def _classify(text: str) -> tuple[bool, bool, str]:
    """Return ``(injection_found, exfiltration_found, label)`` for *text*.

    Detection runs on a normalised copy; *text* itself is never modified.
    The returned *label* is the first matching pattern label, or "tag-block"
    if only the Unicode Tag-block heuristic fired.
    """
    norm = _normalise(text)

    for label, pat in _INJECTION_PATTERNS:
        if pat.search(norm):
            return True, False, label

    for label, pat in _EXFILTRATION_PATTERNS:
        if pat.search(norm):
            return False, True, label

    if _has_tag_block(text):
        return True, False, "tag-block"

    return False, False, ""


def _classify_window(text: str) -> tuple[bool, bool, str]:
    """Like _classify but scans only the head and tail windows of large content."""
    if len(text) <= _SCAN_WINDOW * 2:
        return _classify(text)
    head = text[:_SCAN_WINDOW]
    tail = text[-_SCAN_WINDOW:]
    inj, exf, label = _classify(head)
    if inj or exf:
        return inj, exf, label
    return _classify(tail)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def contains_injection(text: str) -> bool:
    """Return True if *text* matches any injection or exfiltration pattern."""
    inj, exf, _ = _classify(text)
    return inj or exf


def neutralize_injection(text: str) -> tuple[str, bool]:
    """Prepend a warning banner to *text* if injection or exfiltration patterns are detected.

    Returns ``(possibly_prefixed_text, was_flagged)``.
    """
    inj, exf, _ = _classify(text)
    if exf:
        return _EXFIL_WARNING_PREFIX + text, True
    if inj:
        return _WARNING_PREFIX + text, True
    return text, False


def flag_external_content(text: str) -> tuple[str, str]:
    """Classify *text* and return ``(warning_prefix, label)``.

    Returns empty strings if no pattern matches.  Uses head+tail windowing for
    large content so O(n) full-text scans are avoided.
    """
    inj, exf, label = _classify_window(text)
    if exf:
        return _EXFIL_WARNING_PREFIX, label
    if inj:
        prefix = _TAG_BLOCK_PREFIX if label == "tag-block" else _WARNING_PREFIX
        return prefix, label
    return "", ""


def wrap_external_content(text: str) -> str:
    """Wrap *text* in an untrusted-content fence.

    Applied to all fetched web content regardless of injection detection,
    so the model always knows the provenance of content between the fences.
    """
    return _UNTRUSTED_FENCE_OPEN + text + _UNTRUSTED_FENCE_CLOSE


def check_hint_for_injection(hint: str, source: str = "") -> str:
    """Return *hint* unchanged if clean; redact the matching span if exfil or tag-block is detected.

    Prose injection patterns (e.g. "ignore all previous instructions") are not
    checked here because hint text is short and model-authored, not user-supplied;
    only exfiltration attempts and Tag-block smuggling need the precision-first path.

    Always returns a string — never suppresses the hint entirely so that false
    positives do not silently drop session context.
    """
    norm = _normalise(hint)

    # Check exfiltration patterns only.
    for label, pat in _EXFILTRATION_PATTERNS:
        m = pat.search(norm)
        if m:
            _LOG.warning(
                "injection: flagged hint from %s — exfiltration pattern '%s'",
                source or "<unknown>",
                label,
            )
            # Redact the matched span, preserving surrounding context.
            redacted = hint[: m.start()] + "[REDACTED]" + hint[m.end() :]
            return redacted

    # Tag-block smuggling check.
    if _has_tag_block(hint):
        _LOG.warning(
            "injection: flagged hint from %s — Unicode Tag-block characters detected",
            source or "<unknown>",
        )
        cleaned = _TAG_BLOCK_RE.sub("[REDACTED]", hint)
        return cleaned

    return hint
