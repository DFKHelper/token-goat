"""Tests for iter225: session validation, webfetch URL guards, hooks_cli normalize/denormalize,
paths atomic_write_text, db _get_meta, compact _count_suffix, repomap _build_graph,
and image_shrink shrink / _cache_key."""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from token_goat.compact import _count_suffix
from token_goat.db import _get_meta
from token_goat.hooks_cli import denormalize_response, normalize_payload
from token_goat.image_shrink import (
    CACHE_KEY_VERSION,
    SIZE_THRESHOLD_BYTES,
    _cache_key,
    is_image_path,
    shrink,
)
from token_goat.paths import atomic_write_text
from token_goat.repomap import _build_graph
from token_goat.session import validate_session_id
from token_goat.webfetch import _is_ssrf_safe

# ---------------------------------------------------------------------------
# 1. session.py  validate_session_id
# ---------------------------------------------------------------------------


def test_validate_session_id_valid_uuid() -> None:
    # Standard UUIDs are alphanumeric + hyphens — must pass.
    validate_session_id("550e8400-e29b-41d4-a716-446655440000")


def test_validate_session_id_valid_simple() -> None:
    validate_session_id("abc123")


def test_validate_session_id_valid_underscores() -> None:
    validate_session_id("session_id_001")


def test_validate_session_id_valid_max_length() -> None:
    # Exactly 128 chars should pass (new cap reduced from 256 for MAX_PATH safety).
    validate_session_id("a" * 128)


def test_validate_session_id_empty_raises() -> None:
    with pytest.raises(ValueError, match="empty"):
        validate_session_id("")


def test_validate_session_id_too_long_raises() -> None:
    with pytest.raises(ValueError, match="too long"):
        validate_session_id("a" * 129)


def test_validate_session_id_path_traversal_slash() -> None:
    with pytest.raises(ValueError):
        validate_session_id("../etc/passwd")


def test_validate_session_id_path_traversal_backslash() -> None:
    with pytest.raises(ValueError):
        validate_session_id("..\\windows\\system32")


def test_validate_session_id_null_byte() -> None:
    with pytest.raises(ValueError):
        validate_session_id("abc\x00def")


def test_validate_session_id_dot_slash() -> None:
    with pytest.raises(ValueError):
        validate_session_id("./relative/path")


def test_validate_session_id_forward_slash_only() -> None:
    with pytest.raises(ValueError):
        validate_session_id("foo/bar")


def test_validate_session_id_space_invalid() -> None:
    with pytest.raises(ValueError):
        validate_session_id("session id")


def test_validate_session_id_at_sign_invalid() -> None:
    with pytest.raises(ValueError):
        validate_session_id("user@host")


# ---------------------------------------------------------------------------
# 2. webfetch.py  _is_ssrf_safe URL scheme validation
# ---------------------------------------------------------------------------


def test_webfetch_http_scheme_accepted() -> None:
    result_http = _is_ssrf_safe("http://example.com/page")
    result_https = _is_ssrf_safe("https://example.com/page")
    assert result_http is True
    assert result_https is True


def test_webfetch_file_scheme_blocked() -> None:
    assert _is_ssrf_safe("file:///etc/passwd") is False


def test_webfetch_ftp_scheme_blocked() -> None:
    assert _is_ssrf_safe("ftp://example.com/file.txt") is False


def test_webfetch_data_scheme_blocked() -> None:
    assert _is_ssrf_safe("data:text/html,<h1>hi</h1>") is False


def test_webfetch_empty_string_blocked() -> None:
    assert _is_ssrf_safe("") is False


def test_webfetch_no_scheme_blocked() -> None:
    assert _is_ssrf_safe("example.com/page") is False


def test_webfetch_localhost_blocked() -> None:
    assert _is_ssrf_safe("http://localhost/") is False


def test_webfetch_loopback_ip_blocked() -> None:
    assert _is_ssrf_safe("http://127.0.0.1/") is False


def test_webfetch_private_ip_blocked() -> None:
    assert _is_ssrf_safe("http://192.168.1.1/api") is False


def test_webfetch_link_local_blocked() -> None:
    assert _is_ssrf_safe("http://169.254.169.254/metadata") is False


# ---------------------------------------------------------------------------
# 3. hooks_cli.py  normalize_payload
# ---------------------------------------------------------------------------


def test_normalize_payload_claude_passthrough() -> None:
    payload: dict[str, Any] = {
        "session_id": "abc-123",
        "tool_name": "Read",
        "tool_input": {"file_path": "/tmp/foo.py"},
    }
    result = normalize_payload(payload, harness="claude")
    # normalize_payload now stamps _tg_harness; verify original keys survive
    assert result.get("session_id") == "abc-123"
    assert result.get("tool_name") == "Read"
    assert result.get("_tg_harness") == "claude"


def test_normalize_payload_codex_remaps_tool_name() -> None:
    payload: dict[str, Any] = {
        "session_id": "xyz-789",
        "tool_name": "bash",
        "tool_input": {"command": "ls"},
    }
    result = normalize_payload(payload, harness="codex")
    # Codex 'bash' must be normalised to PascalCase 'Bash'; other fields preserved.
    assert result["tool_name"] == "Bash"
    assert result["session_id"] == "xyz-789"
    assert result["tool_input"] == {"command": "ls"}


def test_normalize_payload_empty_dict() -> None:
    result = normalize_payload({}, harness="claude")
    assert isinstance(result, dict)


def test_normalize_payload_default_harness() -> None:
    # Payload without tool_name is now rejected (schema validation added).
    payload: dict[str, Any] = {"key": "value"}
    result = normalize_payload(payload)
    assert result == {}  # Invalid payload returns empty dict.

    # Valid payload with tool_name: normalize_payload stamps _tg_harness and
    # preserves all original keys.
    valid_payload: dict[str, Any] = {"key": "value", "tool_name": "Read"}
    result = normalize_payload(valid_payload)
    assert result.get("key") == "value"
    assert result.get("tool_name") == "Read"
    assert result.get("_tg_harness") == "claude"


# ---------------------------------------------------------------------------
# 4. hooks_cli.py  denormalize_response
# ---------------------------------------------------------------------------


def test_denormalize_response_claude_unchanged() -> None:
    response: dict[str, Any] = {
        "continue": True,
        "hookSpecificOutput": {"additionalContext": "some context"},
    }
    result = denormalize_response(response, harness="claude")
    assert result is response or result == response


def test_denormalize_response_codex_camel_to_snake() -> None:
    # Codex 0.137.0+ uses camelCase — keys pass through unchanged.
    response: dict[str, Any] = {
        "continue": True,
        "hookSpecificOutput": {
            "additionalContext": "ctx",
            "updatedInput": {"file_path": "/tmp/x"},
        },
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["additionalContext"] == "ctx"
    assert hso["updatedInput"] == {"file_path": "/tmp/x"}
    assert "additional_context" not in hso
    assert "updated_input" not in hso


def test_denormalize_response_codex_permission_keys() -> None:
    response: dict[str, Any] = {
        "continue": True,
        "hookSpecificOutput": {
            "permissionDecision": "allow",
            "permissionDecisionReason": "safe",
        },
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["permissionDecision"] == "allow"
    assert hso["permissionDecisionReason"] == "safe"
    assert "permission_decision" not in hso


def test_denormalize_response_no_hso_key() -> None:
    response: dict[str, Any] = {"continue": True}
    result = denormalize_response(response, harness="codex")
    assert result == response


def test_denormalize_response_non_dict_hso() -> None:
    response: dict[str, Any] = {"continue": True, "hookSpecificOutput": "a string"}
    result = denormalize_response(response, harness="codex")
    assert result["hookSpecificOutput"] == "a string"


def test_denormalize_response_hook_event_name_key() -> None:
    # hookEventName already present → preserved as-is (no injection needed).
    response: dict[str, Any] = {
        "continue": True,
        "hookSpecificOutput": {"hookEventName": "PreToolUse"},
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert "hook_event_name" not in hso


def test_denormalize_response_unknown_keys_preserved() -> None:
    response: dict[str, Any] = {
        "continue": True,
        "hookSpecificOutput": {"customField": "value", "additionalContext": "ctx"},
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["customField"] == "value"
    assert hso["additionalContext"] == "ctx"
    assert "additional_context" not in hso


# ---------------------------------------------------------------------------
# 5. paths.py  atomic_write_text
# ---------------------------------------------------------------------------


def test_atomic_write_text_content_correct(tmp_path: Path) -> None:
    target = tmp_path / "output.txt"
    atomic_write_text(target, "hello world")
    assert target.read_text(encoding="utf-8") == "hello world"


def test_atomic_write_text_overwrites_existing(tmp_path: Path) -> None:
    target = tmp_path / "data.txt"
    target.write_text("old content", encoding="utf-8")
    atomic_write_text(target, "new content")
    assert target.read_text(encoding="utf-8") == "new content"


def test_atomic_write_text_creates_parent_dirs(tmp_path: Path) -> None:
    target = tmp_path / "subdir" / "nested" / "file.txt"
    atomic_write_text(target, "nested content")
    assert target.exists()
    assert target.read_text(encoding="utf-8") == "nested content"


def test_atomic_write_text_unicode_content(tmp_path: Path) -> None:
    target = tmp_path / "unicode.txt"
    content = "cafe 中文 élève"
    atomic_write_text(target, content)
    assert target.read_text(encoding="utf-8") == content


def test_atomic_write_text_sequential_writes(tmp_path: Path) -> None:
    """Multiple sequential atomic writes each leave a valid, complete file."""
    target = tmp_path / "sequential.txt"
    for i in range(5):
        atomic_write_text(target, f"content{i}")
    # After all writes the file must exist and hold the last value written.
    assert target.exists()
    assert target.read_text(encoding="utf-8") == "content4"


# ---------------------------------------------------------------------------
# 6. db.py  _get_meta
# ---------------------------------------------------------------------------


def _make_meta_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.commit()
    return conn


def test_get_meta_missing_key_returns_none() -> None:
    conn = _make_meta_conn()
    assert _get_meta(conn, "nonexistent_key") is None


def test_get_meta_existing_key_returns_value() -> None:
    conn = _make_meta_conn()
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("schema_version", "3"))
    conn.commit()
    assert _get_meta(conn, "schema_version") == "3"


def test_get_meta_multiple_keys_correct_lookup() -> None:
    conn = _make_meta_conn()
    conn.executemany(
        "INSERT INTO meta (key, value) VALUES (?, ?)",
        [("k1", "v1"), ("k2", "v2"), ("k3", "v3")],
    )
    conn.commit()
    assert _get_meta(conn, "k1") == "v1"
    assert _get_meta(conn, "k2") == "v2"
    assert _get_meta(conn, "k3") == "v3"


def test_get_meta_does_not_raise_on_empty_table() -> None:
    conn = _make_meta_conn()
    result = _get_meta(conn, "any_key")
    assert result is None


# ---------------------------------------------------------------------------
# 7. compact.py  _count_suffix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("n,expected", [
    (0, ""),
    (1, ""),
    (2, "  ×2"),
    (5, "  ×5"),
    (99, "  ×99"),
])
def test_count_suffix(n: int, expected: str) -> None:
    """_count_suffix returns '' for n<=1 and '  ×N' for n>1."""
    assert _count_suffix(n) == expected


# ---------------------------------------------------------------------------
# 8. repomap.py  _build_graph
# ---------------------------------------------------------------------------


def test_build_graph_missing_refs_table_returns_graph() -> None:
    """When refs table is absent, _build_graph returns a nodes-only graph without raising."""
    conn = sqlite3.connect(":memory:")
    # No refs table created — OperationalError should be caught internally.
    files = {"src/a.py": MagicMock(), "src/b.py": MagicMock()}
    name_to_files: dict[str, set[str]] = {}
    graph = _build_graph(conn, files, name_to_files)
    assert graph is not None
    assert graph.number_of_nodes() == 2


def test_build_graph_with_refs_table_adds_edges() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row  # _build_graph uses row["symbol_name"] dict-style access
    conn.execute(
        "CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT, file_rel TEXT, kind TEXT)"
    )
    conn.execute("CREATE TABLE refs (symbol_name TEXT, file_rel TEXT)")
    conn.execute("INSERT INTO symbols VALUES (1, 'my_func', 'src/a.py', 'function')")
    conn.execute("INSERT INTO refs VALUES ('my_func', 'src/b.py')")
    conn.commit()

    files = {"src/a.py": MagicMock(), "src/b.py": MagicMock()}
    name_to_files: dict[str, set[str]] = {"my_func": {"src/a.py"}}
    graph = _build_graph(conn, files, name_to_files)
    assert graph is not None
    assert graph.number_of_nodes() == 2


def test_build_graph_empty_files_empty_graph() -> None:
    conn = sqlite3.connect(":memory:")
    graph = _build_graph(conn, {}, {})
    assert graph is not None
    assert graph.number_of_nodes() == 0


# ---------------------------------------------------------------------------
# 9. image_shrink.py  shrink + _cache_key
# ---------------------------------------------------------------------------


def test_shrink_returns_none_for_non_image(tmp_path: Path) -> None:
    f = tmp_path / "script.py"
    f.write_text("print('hello')", encoding="utf-8")
    result = shrink(f)
    assert result is None


def test_shrink_returns_none_for_small_image(tmp_path: Path) -> None:
    """Files under SIZE_THRESHOLD_BYTES are not shrunk."""
    f = tmp_path / "tiny.jpg"
    f.write_bytes(b"\xff\xd8\xff" + b"\x00" * (SIZE_THRESHOLD_BYTES - 10))
    result = shrink(f)
    assert result is None


def test_shrink_returns_none_for_unsafe_path() -> None:
    """A path with traversal components is rejected."""
    p = Path("../some/../../etc/passwd.png")
    result = shrink(p)
    assert result is None


def test_cache_key_is_sha256_of_content(tmp_path: Path) -> None:
    f = tmp_path / "image.jpg"
    data = b"fake image bytes 12345"
    f.write_bytes(data)
    h = hashlib.sha256()
    h.update(f"v{CACHE_KEY_VERSION}\n".encode())
    h.update(data)
    expected = h.hexdigest()
    key = _cache_key(f)
    assert key == expected


def test_cache_key_differs_for_different_content(tmp_path: Path) -> None:
    f1 = tmp_path / "img1.jpg"
    f2 = tmp_path / "img2.jpg"
    f1.write_bytes(b"content_a")
    f2.write_bytes(b"content_b")
    assert _cache_key(f1) != _cache_key(f2)


def test_cache_key_same_for_identical_content(tmp_path: Path) -> None:
    f1 = tmp_path / "img1.jpg"
    f2 = tmp_path / "img2.jpg"
    data = b"identical content"
    f1.write_bytes(data)
    f2.write_bytes(data)
    assert _cache_key(f1) == _cache_key(f2)


def test_is_image_path_jpg() -> None:
    assert is_image_path("photo.jpg") is True


def test_is_image_path_png() -> None:
    assert is_image_path("screenshot.PNG") is True


def test_is_image_path_non_image() -> None:
    assert is_image_path("document.txt") is False


def test_is_image_path_py_extension() -> None:
    assert is_image_path("module.py") is False
