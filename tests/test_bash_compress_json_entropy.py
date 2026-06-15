"""Integration tests: JsonArrayFilter preserves objects with high-entropy values."""
from __future__ import annotations

import json

from token_goat.bash_compress import JsonArrayFilter

_F = JsonArrayFilter()


def _compress(stdout: str, stderr: str = "", exit_code: int = 0) -> str:
    return _F.compress(stdout, stderr, exit_code, ["gh", "api", "/repos"])


def test_uuid_value_prevents_dedup() -> None:
    # Two objects share the same key-set; the second has a UUID value → both must be emitted.
    data = [
        {"id": 1, "token": "plain"},
        {"id": 2, "token": "550e8400-e29b-41d4-a716-446655440000"},
    ]
    result = _compress(json.dumps(data))
    # No dedup suffix should appear — both objects must survive
    assert "[... 1 duplicate" not in result
    parsed = json.loads(result)
    assert len(parsed) == 2
    assert any(item["token"] == "550e8400-e29b-41d4-a716-446655440000" for item in parsed)


def test_non_uuid_values_deduplicated_normally() -> None:
    # Three objects with the same key-set, no high-entropy values → normal dedup.
    # Use short values (<8 chars) so the entropy guard never fires.
    data = [
        {"status": "ok", "code": 200},
        {"status": "ok", "code": 200},
        {"status": "ok", "code": 200},
    ]
    result = _compress(json.dumps(data))
    assert "[... 2 duplicate objects with keys {code, status} omitted]" in result
    parsed = json.loads(result.split("\n[")[0])
    assert len(parsed) == 1


def test_git_sha_value_prevents_dedup() -> None:
    # Object whose value is a 40-char git SHA must not be deduplicated.
    sha = "d2f4e5b8c1a39f06d2e4b5c8a1f3e7d9b2a5c8e1"
    data = [
        {"commit": "abc", "hash": "none"},
        {"commit": "def", "hash": sha},
    ]
    result = _compress(json.dumps(data))
    assert "[... 1 duplicate" not in result
    parsed = json.loads(result)
    assert len(parsed) == 2
    assert any(item["hash"] == sha for item in parsed)


def test_mixed_array_some_uuid_some_plain() -> None:
    # Short (<8 char) ref values never trigger the entropy guard → normal dedup applies.
    # Only the UUID item (36 chars, high entropy) is preserved unconditionally.
    uuid = "550e8400-e29b-41d4-a716-446655440000"
    data = [
        {"id": 1, "ref": "plain"},  # 5 chars < 8 → preserve=False, first seen
        {"id": 2, "ref": uuid},     # UUID value → preserve=True
        {"id": 3, "ref": "check"},  # 5 chars < 8 → preserve=False → deduped
    ]
    result = _compress(json.dumps(data))
    # Third object must be deduped
    assert "[... 1 duplicate" in result
    # Both the plain first and the UUID second must appear
    parsed = json.loads(result.split("\n[")[0])
    assert len(parsed) == 2
    refs = {item["ref"] for item in parsed}
    assert uuid in refs
    assert "plain" in refs


def test_jwt_value_prevents_dedup() -> None:
    jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    data = [
        {"user": "alice", "token": "low"},
        {"user": "bob", "token": jwt},
    ]
    result = _compress(json.dumps(data))
    assert "[... 1 duplicate" not in result
    parsed = json.loads(result)
    assert len(parsed) == 2
