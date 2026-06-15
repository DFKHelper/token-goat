"""Tests for iter 95 coverage targets.

Covers:
1. SSRF IPv4-mapped IPv6 bypass (iter 94) — _is_ssrf_safe in webfetch.py
2. Log injection sanitization (iter 94) — _sanitize_log_str in hooks_cli.py
3. _extract_snippet None safety (iter 92) — read_replacement.py
4. _SCHEMA_MIGRATED cache (iter 93) — db.py
5. _pick_best_match scoring & tie-breaking (iter 93) — read_replacement.py
6. _KNOWN_EXTENSIONS fast-path (iter 93) — parser.py iter_source_files
7. TYPE_CHECKING imports don't break runtime (iter 90) — embeddings, parser
"""
from __future__ import annotations

import sqlite3
from unittest.mock import patch

import token_goat.db as db_module
from token_goat.hooks_common import sanitize_log_str as _sanitize_log_str
from token_goat.parser import _KNOWN_EXTENSIONS, LANG_BY_EXT, iter_source_files
from token_goat.project import Project
from token_goat.read_replacement import _extract_snippet, _pick_best_match
from token_goat.webfetch import _is_ssrf_safe

# ---------------------------------------------------------------------------
# 1. SSRF IPv4-mapped IPv6 bypass
# ---------------------------------------------------------------------------


def _ssrf_url_for_ip(ip: str) -> str:
    """Build a minimal http URL whose hostname is the given IP literal."""
    # IPv6 literals must be bracketed in URLs
    if ":" in ip:
        return f"http://[{ip}]/path"
    return f"http://{ip}/path"


def _patch_getaddrinfo(ip: str):
    """Return a mock for socket.getaddrinfo that resolves to the given IP."""
    # sockaddr tuple: (address, port) for IPv4, (address, port, flow, scope) for IPv6
    sockaddr = (ip, 80, 0, 0) if ":" in ip else (ip, 80)
    return patch(
        "token_goat.webfetch.socket.getaddrinfo",
        return_value=[(None, None, None, None, sockaddr)],
    )


def test_ssrf_ipv4_mapped_ipv6_private_10_blocked():
    """::ffff:10.0.0.1 must be treated as private (10.x range)."""
    ip = "::ffff:10.0.0.1"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is False


def test_ssrf_ipv4_mapped_ipv6_private_192_168_blocked():
    """::ffff:192.168.1.1 must be treated as private (192.168.x range)."""
    ip = "::ffff:192.168.1.1"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is False


def test_ssrf_ipv4_mapped_ipv6_loopback_blocked():
    """::ffff:127.0.0.1 must be treated as loopback."""
    ip = "::ffff:127.0.0.1"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is False


def test_ssrf_ipv4_mapped_ipv6_public_allowed():
    """::ffff:1.2.3.4 maps to a public IP and must NOT be blocked."""
    ip = "::ffff:1.2.3.4"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is True


def test_ssrf_pure_ipv6_loopback_blocked():
    """::1 (pure IPv6 loopback) must be blocked."""
    ip = "::1"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is False


def test_ssrf_plain_private_ipv4_blocked():
    """10.0.0.1 as a plain IPv4 address must be blocked."""
    ip = "10.0.0.1"
    with _patch_getaddrinfo(ip):
        assert _is_ssrf_safe(_ssrf_url_for_ip(ip)) is False


def test_ssrf_file_scheme_blocked():
    """file:// URLs must always be blocked regardless of host."""
    assert _is_ssrf_safe("file:///etc/passwd") is False


def test_ssrf_localhost_blocked():
    """localhost must be blocked via the hostname blocklist (no DNS call)."""
    assert _is_ssrf_safe("http://localhost/api") is False


def test_ssrf_metadata_endpoint_blocked():
    """GCP metadata endpoint must be blocked via the hostname blocklist."""
    assert _is_ssrf_safe("http://metadata.google.internal/computeMetadata/v1/") is False


# ---------------------------------------------------------------------------
# 2. Log injection sanitization
# ---------------------------------------------------------------------------


def test_sanitize_replaces_newline():
    assert _sanitize_log_str("line1\nline2") == "line1\\nline2"


def test_sanitize_replaces_carriage_return():
    assert _sanitize_log_str("line1\rline2") == "line1\\rline2"


def test_sanitize_replaces_both():
    assert _sanitize_log_str("a\r\nb") == "a\\r\\nb"


def test_sanitize_truncates_at_200():
    long_str = "x" * 300
    result = _sanitize_log_str(long_str)
    # Result should be 200 chars + ellipsis character
    assert len(result) == 201  # 200 + "…" (1 unicode char)
    assert result.endswith("…")


def test_sanitize_does_not_truncate_at_200_exactly():
    exact_str = "y" * 200
    result = _sanitize_log_str(exact_str)
    assert result == exact_str
    assert "…" not in result


def test_sanitize_custom_max_len():
    result = _sanitize_log_str("abcdefghij", max_len=5)
    assert result == "abcde…"


def test_sanitize_empty_string():
    assert _sanitize_log_str("") == ""


def test_sanitize_clean_string_unchanged():
    s = "normal log message"
    assert _sanitize_log_str(s) == s


# ---------------------------------------------------------------------------
# 3. _extract_snippet None safety
# ---------------------------------------------------------------------------


def test_extract_snippet_none_row_start():
    """row_start=None must default to 1 without raising TypeError."""
    lines = ["line one", "line two", "line three"]
    snippet, snippet_bytes, start, end = _extract_snippet(lines, 100, None, 2, 0)
    assert start == 1
    assert end == 2
    assert snippet_bytes > 0


def test_extract_snippet_none_row_end():
    """row_end=None must default to row_start without raising."""
    lines = ["alpha", "beta", "gamma"]
    snippet, snippet_bytes, start, end = _extract_snippet(lines, 100, 2, None, 0)
    assert start == 2
    assert end == 2
    assert "beta" in snippet


def test_extract_snippet_both_none():
    """Both None must default to line 1 without raising."""
    lines = ["only line"]
    snippet, snippet_bytes, start, end = _extract_snippet(lines, 50, None, None, 0)
    assert start == 1
    assert end == 1
    assert snippet == "only line"


def test_extract_snippet_with_context():
    """Context lines expand the window correctly."""
    lines = [f"L{i}" for i in range(1, 11)]
    snippet, snippet_bytes, start, end = _extract_snippet(lines, 200, 5, 5, 2)
    assert start == 3
    assert end == 7


def test_extract_snippet_clamped_to_bounds():
    """Context must not exceed file boundaries."""
    lines = ["A", "B", "C"]
    snippet, snippet_bytes, start, end = _extract_snippet(lines, 50, 2, 2, 10)
    assert start == 1
    assert end == 3


# ---------------------------------------------------------------------------
# 4. _SCHEMA_MIGRATED cache
# ---------------------------------------------------------------------------


class _TrackingConnection(sqlite3.Connection):
    """sqlite3.Connection subclass that counts PRAGMA table_info calls."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pragma_calls: list[str] = []

    def execute(self, sql, parameters=(), /):  # type: ignore[override]
        if "PRAGMA table_info" in sql:
            self.pragma_calls.append(sql)
        return super().execute(sql, parameters)


def test_schema_migrated_cache_prevents_repeated_pragma(tmp_path):
    """PRAGMA table_info(files) must be called at most once per db_path."""
    db_path = tmp_path / "test.db"

    # Clear the cache before the test
    db_module._SCHEMA_MIGRATED.pop(db_path, None)

    conn = _TrackingConnection(str(db_path))
    conn.row_factory = sqlite3.Row

    # First call: should run PRAGMA for files and stats (2 calls).
    db_module._ensure_project_schema(conn, db_path=db_path)
    first_count = len(conn.pragma_calls)
    assert first_count == 2, f"Expected 2 PRAGMA calls on first open, got {first_count}"

    # Second call: cache hit, should skip all PRAGMA calls.
    db_module._ensure_project_schema(conn, db_path=db_path)
    second_count = len(conn.pragma_calls)
    assert second_count == 2, (
        f"Expected no additional PRAGMA calls, got {second_count - first_count} extra"
    )

    conn.close()
    # Cleanup
    db_module._SCHEMA_MIGRATED.pop(db_path, None)


def test_schema_migrated_cache_runs_pragma_when_db_path_is_none():
    """When db_path=None the migration check must always run."""
    conn = _TrackingConnection(":memory:")
    conn.row_factory = sqlite3.Row

    db_module._ensure_project_schema(conn, db_path=None)
    db_module._ensure_project_schema(conn, db_path=None)
    assert len(conn.pragma_calls) == 4, (
        f"Expected 4 PRAGMA calls (2 per open, no caching when db_path=None), got {len(conn.pragma_calls)}"
    )

    conn.close()


# ---------------------------------------------------------------------------
# 5. _pick_best_match scoring & tie-breaking
# ---------------------------------------------------------------------------


def test_pick_best_match_unique_winner():
    """More specific path wins over shallow match."""
    candidates = ["src/token_goat/parser.py", "other/parser.py"]
    result = _pick_best_match("token_goat/parser.py", candidates)
    assert result == "src/token_goat/parser.py"


def test_pick_best_match_single_candidate():
    """Single candidate is always returned."""
    assert _pick_best_match("foo.py", ["src/foo.py"]) == "src/foo.py"


def test_pick_best_match_empty_returns_none():
    """Empty candidate list returns None."""
    assert _pick_best_match("foo.py", []) is None


def test_pick_best_match_tie_returns_none():
    """Two equally specific candidates return None (ambiguous)."""
    candidates = ["a/parser.py", "b/parser.py"]
    result = _pick_best_match("parser.py", candidates)
    assert result is None


def test_pick_best_match_prefers_shallower_on_depth_tie():
    """When suffix length ties, the shallower (shorter) path wins."""
    # Both end in "parser.py" with equal suffix match, but one is shallower
    candidates = ["parser.py", "deep/nested/parser.py"]
    result = _pick_best_match("parser.py", candidates)
    assert result == "parser.py"


def test_pick_best_match_longer_suffix_wins():
    """A longer tail match beats a shorter one."""
    candidates = ["goat/cli.py", "token_goat/cli.py"]
    result = _pick_best_match("token_goat/cli.py", candidates)
    assert result == "token_goat/cli.py"


# ---------------------------------------------------------------------------
# 6. _KNOWN_EXTENSIONS fast-path / iter_source_files
# ---------------------------------------------------------------------------


def test_known_extensions_contains_python():
    assert ".py" in _KNOWN_EXTENSIONS


def test_known_extensions_contains_typescript():
    assert ".ts" in _KNOWN_EXTENSIONS


def test_known_extensions_contains_go():
    assert ".go" in _KNOWN_EXTENSIONS


def test_known_extensions_contains_rust():
    assert ".rs" in _KNOWN_EXTENSIONS


def test_known_extensions_excludes_tmp():
    assert ".tmp" not in _KNOWN_EXTENSIONS


def test_known_extensions_excludes_log():
    assert ".log" not in _KNOWN_EXTENSIONS


def test_known_extensions_matches_lang_by_ext():
    """_KNOWN_EXTENSIONS must be exactly the keyset of LANG_BY_EXT."""
    assert frozenset(LANG_BY_EXT.keys()) == _KNOWN_EXTENSIONS


def test_iter_source_files_finds_py_files(tmp_path):
    """iter_source_files must yield .py files and skip non-source files."""
    (tmp_path / "main.py").write_text("print('hello')")
    (tmp_path / "notes.txt").write_text("not source")
    (tmp_path / "data.log").write_text("log entry")

    project = Project(root=tmp_path, hash="abc123", marker="manual")
    found = {p.name for p in iter_source_files(project)}

    assert "main.py" in found
    assert "notes.txt" not in found
    assert "data.log" not in found


def test_iter_source_files_skips_node_modules(tmp_path):
    """iter_source_files must skip node_modules."""
    nm = tmp_path / "node_modules"
    nm.mkdir()
    (nm / "index.js").write_text("module.exports = {}")
    (tmp_path / "app.py").write_text("pass")

    project = Project(root=tmp_path, hash="def456", marker="manual")
    found = {p.name for p in iter_source_files(project)}

    assert "app.py" in found
    assert "index.js" not in found


# ---------------------------------------------------------------------------
# 7. TYPE_CHECKING imports don't break runtime
# ---------------------------------------------------------------------------


def test_import_embeddings_embed_texts():
    """embed_texts must be importable at runtime."""
    from token_goat.embeddings import embed_texts  # noqa: F401

    assert callable(embed_texts)


def test_import_parser_index_project():
    """index_project must be importable at runtime."""
    from token_goat.parser import index_project  # noqa: F401

    assert callable(index_project)


def test_import_parser_iter_source_files():
    """iter_source_files must be importable at runtime."""
    from token_goat.parser import iter_source_files as isf  # noqa: F401

    assert callable(isf)
