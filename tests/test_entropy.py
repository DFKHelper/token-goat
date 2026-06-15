"""Unit tests for token_goat.entropy."""
from __future__ import annotations

from token_goat.entropy import (
    _ENTROPY_MIN_LEN,
    _ENTROPY_THRESHOLD,
    has_high_entropy_token,
    score_entropy,
)


def test_uuid_high_entropy() -> None:
    assert score_entropy("550e8400-e29b-41d4-a716-446655440000") >= 0.85


def test_all_same_char_zero_entropy() -> None:
    # Single unique character → charset size < 2 → returns 0.0
    assert score_entropy("a" * 64) == 0.0


def test_varied_hex_high_entropy() -> None:
    # 64-char hex string with varied digit distribution
    hex_val = "d2f4e5b8c1a39f06d2e4b5c8a1f3e7d9b2a5c8e1f4d7a0b3c6e9f2a5d8b1c4e7"
    assert score_entropy(hex_val) >= 0.85


def test_hello_below_min_length() -> None:
    # "hello" is 5 chars, below the default min_length of 8
    assert has_high_entropy_token("hello") is False


def test_skewed_distribution_low_entropy() -> None:
    # Heavily skewed distribution → normalized entropy well below 0.85
    assert score_entropy("aaaaaaab") < 0.85


def test_jwt_header_high_entropy() -> None:
    assert score_entropy("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9") >= 0.85


def test_line_with_uuid_true() -> None:
    assert has_high_entropy_token("request_id=550e8400-e29b-41d4-a716-446655440000") is True


def test_line_without_high_entropy_false() -> None:
    # Splits on '=' and whitespace → tokens are "status", "ok", "count", "5" (all < 8 chars)
    assert has_high_entropy_token("status=ok count=5") is False


def test_empty_string_entropy() -> None:
    assert score_entropy("") == 0.0


def test_single_char_repeated_entropy() -> None:
    assert score_entropy("aaaaaaa") == 0.0


def test_entropy_threshold_constant() -> None:
    assert _ENTROPY_THRESHOLD == 0.85


def test_entropy_min_len_constant() -> None:
    assert _ENTROPY_MIN_LEN == 8


def test_custom_min_length_respected() -> None:
    # "a1b2c3" is 6 chars with high entropy and non-alpha chars;
    # lowering min_length to 5 lets it be scored (default is 8)
    assert has_high_entropy_token("a1b2c3", min_length=5) is True


def test_custom_threshold_respected() -> None:
    # Raise threshold above 1.0 — nothing can ever qualify
    assert has_high_entropy_token("550e8400-e29b-41d4-a716-446655440000", min_entropy=1.1) is False


def test_pure_english_word_no_entropy_flag() -> None:
    # "successfully" and "implemented" have high entropy (many unique chars)
    # but are pure alphabetic, so they should NOT be flagged
    assert has_high_entropy_token("successfully implemented") is False


def test_pure_alphabetic_token_no_entropy_flag() -> None:
    # "admin" token is pure alphabetic, even in a key=value pair; should NOT be flagged
    assert has_high_entropy_token("credentials=admin") is False


def test_colon_separator_and_uuid() -> None:
    # Colon should now split "host:uuid" into two tokens; uuid token has digits and hyphens
    assert has_high_entropy_token("host:550e8400-e29b-41d4-a716-446655440000") is True
