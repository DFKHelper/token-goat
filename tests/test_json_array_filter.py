"""Tests for JsonArrayFilter (JSON array deduplication / truncation)."""

from __future__ import annotations

import json

import pytest

from token_goat.bash_compress import JsonArrayFilter

_F = JsonArrayFilter()


def _compress(stdout: str, stderr: str = "", exit_code: int = 0) -> str:
    return _F.compress(stdout, stderr, exit_code, ["gh", "api", "/repos"])


# ---------------------------------------------------------------------------
# 1. Basic array passes through unchanged (< 50 items, all unique key-sets)
# ---------------------------------------------------------------------------

def test_basic_array_passthrough() -> None:
    # Each item has a distinct key-set so no dedup fires
    data = [{f"key_{i}": i} for i in range(5)]
    text = json.dumps(data)
    result = _compress(text)
    # No changes — original text returned
    assert result == text


# ---------------------------------------------------------------------------
# 2. Array > 50 items gets truncated with correct suffix
# ---------------------------------------------------------------------------

def test_truncation_over_50_items() -> None:
    # Each item has a distinct key-set → dedup does nothing; pure truncation
    data = [{f"id_{i}": i} for i in range(70)]
    text = json.dumps(data)
    result = _compress(text)
    assert "[... 20 more items not shown]" in result
    parsed = json.loads(result.split("\n[")[0])
    assert len(parsed) == 50
    assert list(parsed[0].keys()) == ["id_0"]
    assert list(parsed[49].keys()) == ["id_49"]


# ---------------------------------------------------------------------------
# 3. Array with duplicate key-sets gets dedup summary
# ---------------------------------------------------------------------------

def test_dedup_duplicate_keysets() -> None:
    data = [
        {"id": 1, "name": "a"},
        {"id": 2, "name": "b"},
        {"id": 3, "name": "c"},
    ]
    text = json.dumps(data)
    result = _compress(text)
    # Two duplicates of {"id", "name"} key-set
    assert "[... 2 duplicate objects with keys {id, name} omitted]" in result
    parsed = json.loads(result.split("\n[")[0])
    assert len(parsed) == 1
    assert parsed[0]["id"] == 1


# ---------------------------------------------------------------------------
# 4. Dedup + truncation combined (duplicates first, then cap at 50)
# ---------------------------------------------------------------------------

def test_dedup_then_truncation() -> None:
    # 30 unique key-sets {"a": i} + 40 duplicates of same key-set
    unique = [{"a": i, "b": i} for i in range(30)]
    dupes = [{"x": i} for i in range(40)] + [{"x": i + 1000} for i in range(40)]
    data = unique + dupes
    text = json.dumps(data)
    result = _compress(text)
    # After dedup: 30 (a,b) items + 1 (x) item = 31 items — under cap, no truncation suffix
    assert "[... 79 duplicate objects with keys {x} omitted]" in result
    assert "more items not shown" not in result


def test_dedup_and_truncation_suffix_both_present() -> None:
    # 55 unique key-sets + 10 duplicates of {"common": v} → after dedup 56 items → truncated to 50
    unique = [{f"u_{i}": i} for i in range(55)]
    dupes = [{"common": j} for j in range(10)]  # all same key-set; 9 are dups
    data = unique + dupes
    text = json.dumps(data)
    result = _compress(text)
    assert "duplicate objects" in result
    assert "more items not shown" in result


# ---------------------------------------------------------------------------
# 5. Non-array JSON (object {}) passes through unchanged
# ---------------------------------------------------------------------------

def test_non_array_json_object_passthrough() -> None:
    obj = {"key": "value", "count": 42}
    text = json.dumps(obj)
    result = _compress(text)
    assert result == text


# ---------------------------------------------------------------------------
# 6. Invalid JSON passes through unchanged
# ---------------------------------------------------------------------------

def test_invalid_json_passthrough() -> None:
    text = "[not valid json {"
    result = _compress(text)
    assert result == text


# ---------------------------------------------------------------------------
# 7. Empty array passes through unchanged
# ---------------------------------------------------------------------------

def test_empty_array_passthrough() -> None:
    text = "[]"
    result = _compress(text)
    assert result == text


# ---------------------------------------------------------------------------
# 8. Mixed types in array (non-dict items don't participate in key-set dedup)
# ---------------------------------------------------------------------------

def test_mixed_types_non_dicts_kept() -> None:
    data: list[object] = [
        "string-item",
        42,
        None,
        {"id": 1, "name": "first"},
        {"id": 2, "name": "second"},  # dup key-set
    ]
    text = json.dumps(data)
    result = _compress(text)
    # Non-dict items preserved; one dict deduped
    assert "[... 1 duplicate objects with keys {id, name} omitted]" in result
    parsed = json.loads(result.split("\n[")[0])
    # string, int, null, and first dict kept
    assert parsed[0] == "string-item"
    assert parsed[1] == 42
    assert parsed[2] is None
    assert parsed[3]["id"] == 1
    assert len(parsed) == 4


# ---------------------------------------------------------------------------
# 9. detect() fallback routes unknown command with '['-prefixed stdout
# ---------------------------------------------------------------------------

def test_detect_fallback_json_array(monkeypatch: pytest.MonkeyPatch) -> None:
    from token_goat import bash_detect
    result = bash_detect.detect(["some-unknown-tool"], stdout="[1, 2, 3]")
    assert result == "json_array"


def test_detect_no_fallback_for_non_array(monkeypatch: pytest.MonkeyPatch) -> None:
    from token_goat import bash_detect
    result = bash_detect.detect(["some-unknown-tool"], stdout='{"key": "val"}')
    assert result is None


def test_detect_known_binary_still_works() -> None:
    from token_goat import bash_detect
    assert bash_detect.detect(["pytest"]) == "pytest"
