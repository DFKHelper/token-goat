"""Shannon entropy utilities for protecting high-entropy tokens (UUIDs, hashes, JWTs)."""
from __future__ import annotations

import math
import re
from collections import Counter

__all__ = [
    "score_entropy",
    "has_high_entropy_token",
    "_ENTROPY_THRESHOLD",
    "_ENTROPY_MIN_LEN",
]

_ENTROPY_THRESHOLD: float = 0.85
_ENTROPY_MIN_LEN: int = 8

# Split on whitespace, '=', and ':' so "key=value" and "host:token" pairs are scored separately.
_TOKEN_SPLIT_RE: re.Pattern[str] = re.compile(r"[\s=:]+")

# Match tokens with non-alphabetic characters (digits, hyphens, underscores, etc.).
_HAS_NONALPHA_RE: re.Pattern[str] = re.compile(r"[0-9\-_./+=@]")


def score_entropy(token: str) -> float:
    """Return normalized Shannon entropy of token in [0.0, 1.0].

    H = -sum(p_i * log2(p_i)) / log2(len(charset))
    where charset = set of unique characters in token.
    Returns 0.0 for tokens with fewer than 2 unique characters.
    """
    charset = set(token)
    if len(charset) < 2:
        return 0.0
    n = len(token)
    counts = Counter(token)
    entropy = -sum((cnt / n) * math.log2(cnt / n) for cnt in counts.values())
    return entropy / math.log2(len(charset))


def has_high_entropy_token(
    line: str,
    min_entropy: float = _ENTROPY_THRESHOLD,
    min_length: int = _ENTROPY_MIN_LEN,
) -> bool:
    """Return True if any token in line has normalized entropy >= min_entropy, length >= min_length, and contains non-alphabetic chars.

    Tokens are extracted by splitting on whitespace, '=', and ':' so that key=value
    and host:token pairs are evaluated independently. A token is only flagged if it
    has both high entropy AND contains at least one digit, hyphen, underscore, or other
    special character — this filters out normal English words.
    """
    return any(
        len(token) >= min_length and score_entropy(token) >= min_entropy and _HAS_NONALPHA_RE.search(token) is not None
        for token in _TOKEN_SPLIT_RE.split(line)
    )
