"""Tests: GenericFilter entropy bypass in consecutive dedup."""

from token_goat.bash_compress import GenericFilter

_F = GenericFilter()


def _compress(stdout: str, stderr: str = "") -> str:
    return _F.compress(stdout, stderr, 0, ["cmd"])


# 1. Baseline: identical plain lines ARE deduplicated.
def test_plain_lines_deduped() -> None:
    out = _compress("foo\nfoo\nfoo")
    assert "foo  (×3)" in out
    assert out.count("foo") == 1  # only the collapsed form


# 2. UUID lines are NOT deduplicated.
def test_uuid_not_deduped() -> None:
    line = "transaction_id=550e8400-e29b-41d4-a716-446655440000"
    out = _compress(f"{line}\n{line}")
    assert out.count(line) == 2


# 3. SHA-256 hex lines are NOT deduplicated.
def test_sha256_not_deduped() -> None:
    line = "checksum=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    out = _compress(f"{line}\n{line}")
    assert out.count(line) == 2


# 4. JWT-like token lines are NOT deduplicated.
def test_jwt_not_deduped() -> None:
    line = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    out = _compress(f"{line}\n{line}")
    assert out.count(line) == 2


# 5. 40-char git hash lines are NOT deduplicated.
def test_git_hash_not_deduped() -> None:
    line = "commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    out = _compress(f"{line}\n{line}")
    assert out.count(line) == 2


# 6. Regression: plain identical English lines still get deduplicated.
def test_plain_english_still_deduped() -> None:
    out = _compress("warning: deprecated\nwarning: deprecated\nwarning: deprecated")
    assert "warning: deprecated  (×3)" in out


# 7. Mix: 3 identical UUID lines all emitted; 3 identical plain lines → 1 collapsed.
def test_mix_uuid_and_plain() -> None:
    uuid_line = "id=550e8400-e29b-41d4-a716-446655440000"
    plain_line = "done"
    stdout = "\n".join([uuid_line] * 3 + [plain_line] * 3)
    out = _compress(stdout)
    assert out.count(uuid_line) == 3
    assert f"{plain_line}  (×3)" in out
    assert out.count(plain_line) == 1


# 8. Short high-entropy-looking token (< 8 chars) does NOT prevent dedup.
def test_short_token_still_deduped() -> None:
    # "abc123" is only 6 chars — below the min_length gate in entropy.py (_ENTROPY_MIN_LEN=8).
    line = "result=abc123"
    out = _compress(f"{line}\n{line}\n{line}")
    assert "×3" in out
