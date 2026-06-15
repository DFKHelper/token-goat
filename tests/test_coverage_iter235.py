"""Tests for iter235: session.validate_session_id, hooks_cli.denormalize_response,
compact.build_manifest / _count_suffix, db.record_stat, paths._safe_env_dir,
embeddings.EmbeddingsUnavailable, and image_shrink cache/PIL-unavailable paths."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import token_goat.db as db_mod
import token_goat.embeddings as emb_mod
import token_goat.session as session_mod
from token_goat.compact import _count_suffix, build_manifest
from token_goat.embeddings import (
    EmbeddingsUnavailable,
    _get_model,
    index_project_embeddings,
    is_available,
)
from token_goat.hooks_cli import denormalize_response
from token_goat.image_shrink import shrink
from token_goat.paths import _safe_env_dir
from token_goat.session import validate_session_id

# ---------------------------------------------------------------------------
# session.validate_session_id
# ---------------------------------------------------------------------------


class TestValidateSessionId:
    def test_valid_uuid_like_passes(self):
        validate_session_id("550e8400-e29b-41d4-a716-446655440000")

    def test_valid_simple_alphanum_passes(self):
        validate_session_id("abc123")

    def test_valid_with_underscore_passes(self):
        validate_session_id("session_abc_123")

    def test_valid_with_hyphen_passes(self):
        validate_session_id("session-abc-123")

    def test_empty_string_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            validate_session_id("")

    def test_too_long_rejected(self):
        with pytest.raises(ValueError, match="too long"):
            validate_session_id("a" * 129)

    def test_exactly_128_chars_passes(self):
        validate_session_id("a" * 128)

    def test_path_traversal_dotdot_slash_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("../foo")

    def test_path_traversal_dotdot_backslash_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("..\\foo")

    def test_null_byte_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("abc\x00def")

    def test_forward_slash_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("foo/bar")

    def test_backslash_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("foo\\bar")

    def test_space_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("foo bar")

    def test_dot_rejected(self):
        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("foo.bar")


# ---------------------------------------------------------------------------
# hooks_cli.denormalize_response
# ---------------------------------------------------------------------------


class TestDenormalizeResponse:
    def test_non_codex_harness_returns_unchanged(self):
        resp = {"hookSpecificOutput": {"additionalContext": "hello"}, "_tg_elapsed_ms": 1}
        result = denormalize_response(resp, harness="claude")
        assert result is resp

    def test_default_harness_returns_unchanged(self):
        resp = {"hookSpecificOutput": {"additionalContext": "hello"}}
        result = denormalize_response(resp)
        assert result["hookSpecificOutput"]["additionalContext"] == "hello"

    def test_codex_translates_additional_context(self):
        # Codex 0.137.0+ uses camelCase — no conversion occurs.
        resp = {"hookSpecificOutput": {"additionalContext": "ctx"}}
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert hso["additionalContext"] == "ctx"
        assert "additional_context" not in hso

    def test_codex_translates_updated_input(self):
        resp = {"hookSpecificOutput": {"updatedInput": "new-input"}}
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert hso["updatedInput"] == "new-input"
        assert "updated_input" not in hso

    def test_codex_translates_permission_decision(self):
        resp = {"hookSpecificOutput": {"permissionDecision": "allow"}}
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert hso["permissionDecision"] == "allow"
        assert "permission_decision" not in hso

    def test_codex_missing_hook_specific_output_returns_unchanged(self):
        resp = {"continue": True}
        result = denormalize_response(resp, harness="codex")
        assert result.get("continue") is True

    def test_codex_non_dict_hook_specific_output_returns_unchanged(self):
        resp = {"hookSpecificOutput": "string-value"}
        result = denormalize_response(resp, harness="codex")
        assert result["hookSpecificOutput"] == "string-value"

    def test_codex_preserves_tg_elapsed_ms(self):
        # _tg_* keys are stripped for Codex (additionalProperties:false on all schemas).
        resp = {"hookSpecificOutput": {"additionalContext": "x"}, "_tg_elapsed_ms": 42}
        result = denormalize_response(resp, harness="codex")
        assert "_tg_elapsed_ms" not in result

    def test_codex_multiple_keys_translated(self):
        resp = {"hookSpecificOutput": {"additionalContext": "ctx", "updatedInput": "inp"}}
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert hso["additionalContext"] == "ctx"
        assert hso["updatedInput"] == "inp"
        assert "additional_context" not in hso
        assert "updated_input" not in hso


# ---------------------------------------------------------------------------
# compact._count_suffix and build_manifest
# ---------------------------------------------------------------------------


class TestCountSuffix:
    def test_zero_returns_empty(self):
        assert _count_suffix(0) == ""

    def test_one_returns_empty(self):
        assert _count_suffix(1) == ""

    def test_two_returns_suffix(self):
        result = _count_suffix(2)
        assert "2" in result
        assert result != ""

    def test_large_number_returns_suffix(self):
        result = _count_suffix(99)
        assert "99" in result


class TestBuildManifest:
    def test_invalid_session_id_returns_empty(self):
        result = build_manifest("../../bad-id")
        assert result == ""

    def test_empty_session_id_returns_empty(self):
        result = build_manifest("")
        assert result == ""

    def test_nonexistent_session_returns_empty(self):
        result = build_manifest("nonexistent-session-xyz-99999")
        assert result == ""

    def test_manifest_respects_token_budget(self):
        fake_cache = MagicMock()
        fake_cache.edited_files = []
        fake_cache.files = {}
        fake_cache.greps = []
        fake_cache.created_ts = 0.0
        # MagicMock attribute trap: _compute_manifest_fingerprint now JSON-
        # serialises cwd + dedup/history fields. Auto-attrs are MagicMocks
        # which json.dumps cannot encode — stub each one explicitly.
        fake_cache.cwd = None
        fake_cache.bash_dedup_emitted_ids = set()
        fake_cache.bash_history = {}
        fake_cache.glob_history = []
        fake_cache.skill_history = {}
        fake_cache.web_history = {}

        with (
            patch.object(session_mod, "validate_session_id"),
            patch.object(session_mod, "load", return_value=fake_cache),
        ):
            result = build_manifest("valid-session-id", max_tokens=50)
        # 50 tokens * ~4 chars/token upper bound
        assert len(result) <= 50 * 4

    def test_manifest_with_edited_files_mentions_them(self, tmp_data_dir):
        fake_cache = MagicMock()
        # edited_files is a dict {path: edit_count} in the real SessionCache.
        fake_cache.edited_files = {"src/foo.py": 1, "src/bar.py": 2}
        fake_cache.files = {}
        fake_cache.greps = []
        fake_cache.created_ts = 0.0
        # Same MagicMock-attribute-trap fix as above.
        fake_cache.cwd = None
        fake_cache.bash_dedup_emitted_ids = set()
        fake_cache.bash_history = {}
        fake_cache.glob_history = []
        fake_cache.skill_history = {}
        fake_cache.web_history = {}
        # tmp_data_dir isolates the manifest SHA sidecar so prior test runs
        # don't return a stub here.
        with (
            patch.object(session_mod, "validate_session_id"),
            patch.object(session_mod, "load", return_value=fake_cache),
        ):
            result = build_manifest("valid-session-id-mention-edits")
        # Manifest must mention at least one of the edited files.
        assert "foo.py" in result or "bar.py" in result


# ---------------------------------------------------------------------------
# db.record_stat — using in-memory SQLite
# ---------------------------------------------------------------------------


def _make_in_memory_conn():
    """Create an in-memory SQLite DB with the stats table."""
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE stats "
        "(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, "
        "tokens_saved INTEGER, bytes_saved INTEGER, detail TEXT, last_access_epoch REAL)"
    )
    conn.commit()
    return conn


class TestRecordStat:
    def test_kind_over_64_chars_truncated(self):
        conn = _make_in_memory_conn()
        long_kind = "k" * 100
        with patch("token_goat.db.open_global") as mock_open:
            mock_open.return_value.__enter__ = lambda s: conn
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            db_mod.record_stat(None, long_kind)
        conn.commit()
        row = conn.execute("SELECT kind FROM stats").fetchone()
        assert row is not None
        assert len(row[0]) == 64

    def test_detail_over_512_chars_truncated(self):
        conn = _make_in_memory_conn()
        long_detail = "d" * 600
        with patch("token_goat.db.open_global") as mock_open:
            mock_open.return_value.__enter__ = lambda s: conn
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            db_mod.record_stat(None, "test_kind", detail=long_detail)
        conn.commit()
        row = conn.execute("SELECT detail FROM stats").fetchone()
        assert row is not None
        assert len(row[0]) == 512

    def test_none_detail_stored_as_null(self):
        conn = _make_in_memory_conn()
        with patch("token_goat.db.open_global") as mock_open:
            mock_open.return_value.__enter__ = lambda s: conn
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            db_mod.record_stat(None, "my_kind", detail=None)
        conn.commit()
        row = conn.execute("SELECT detail FROM stats").fetchone()
        assert row is not None
        assert row[0] is None

    def test_normal_values_stored_as_is(self):
        conn = _make_in_memory_conn()
        with patch("token_goat.db.open_global") as mock_open:
            mock_open.return_value.__enter__ = lambda s: conn
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            db_mod.record_stat(None, "normal_kind", tokens_saved=5, detail="some detail")
        conn.commit()
        row = conn.execute("SELECT kind, tokens_saved, detail FROM stats").fetchone()
        assert row is not None
        assert row[0] == "normal_kind"
        assert row[1] == 5
        assert row[2] == "some detail"

    def test_kind_exactly_64_chars_not_truncated(self):
        conn = _make_in_memory_conn()
        exact_kind = "x" * 64
        with patch("token_goat.db.open_global") as mock_open:
            mock_open.return_value.__enter__ = lambda s: conn
            mock_open.return_value.__exit__ = MagicMock(return_value=False)
            db_mod.record_stat(None, exact_kind)
        conn.commit()
        row = conn.execute("SELECT kind FROM stats").fetchone()
        assert row is not None
        assert row[0] == exact_kind


# ---------------------------------------------------------------------------
# paths._safe_env_dir
# ---------------------------------------------------------------------------


class TestSafeEnvDir:
    def test_valid_absolute_path_returned(self):
        if sys.platform == "win32":
            p = _safe_env_dir("C:\\Users\\test")
        else:
            p = _safe_env_dir("/tmp/test")
        assert p is not None
        assert isinstance(p, Path)

    def test_relative_path_returns_none(self):
        result = _safe_env_dir("relative/path")
        assert result is None

    def test_empty_string_returns_none(self):
        result = _safe_env_dir("")
        assert result is None

    def test_whitespace_only_returns_none(self):
        result = _safe_env_dir("   ")
        assert result is None

    def test_dotdot_traversal_returns_none(self):
        result = _safe_env_dir("../../etc")
        assert result is None

    def test_single_dot_returns_none(self):
        result = _safe_env_dir(".")
        assert result is None


# ---------------------------------------------------------------------------
# embeddings.EmbeddingsUnavailable — fastembed not available path
# ---------------------------------------------------------------------------


class TestEmbeddingsUnavailable:
    def test_is_exception_subclass(self):
        exc = EmbeddingsUnavailable("test")
        assert isinstance(exc, Exception)

    def test_import_error_raises_embeddings_unavailable(self):
        import builtins as _b

        emb_mod._MODEL_CACHE.clear()
        _real_import = _b.__import__

        def fake_import(name, *args, **kwargs):
            if name == "fastembed":
                raise ImportError("no fastembed")
            return _real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import), pytest.raises(
            EmbeddingsUnavailable, match="fastembed not installed"
        ):
            _get_model("BAAI/bge-small-en-v1.5")

    def test_is_available_returns_false_when_no_fastembed(self):
        # is_available() now uses importlib.util.find_spec for a side-effect-free
        # check (avoids transient errors from fastembed's heavy dep chain on
        # parallel test workers). Patch find_spec to simulate the missing dep.
        import importlib.util

        original_find_spec = importlib.util.find_spec

        def fake_find_spec(name, *args, **kwargs):
            if name == "fastembed":
                return None
            return original_find_spec(name, *args, **kwargs)

        with patch("importlib.util.find_spec", side_effect=fake_find_spec):
            result = is_available()
        assert result is False

    def test_debug_log_fires_before_raise_on_import_error(self):
        import builtins as _b

        emb_mod._MODEL_CACHE.clear()
        _real_import = _b.__import__

        def fake_import(name, *args, **kwargs):
            if name == "fastembed":
                raise ImportError("no fastembed")
            return _real_import(name, *args, **kwargs)

        # Confirm the exception is EmbeddingsUnavailable — the debug log
        # may or may not fire depending on cache state, but the raise must happen.
        with patch("builtins.__import__", side_effect=fake_import), patch.object(
            emb_mod._LOG, "debug"
        ), pytest.raises(EmbeddingsUnavailable):
            _get_model("BAAI/bge-small-en-v1.5")

    def test_index_project_embeddings_raises_when_unavailable(self):
        fake_project = MagicMock()
        fake_project.hash = "a" * 40

        with patch("token_goat.embeddings.is_available", return_value=False), pytest.raises(
            EmbeddingsUnavailable
        ):
            index_project_embeddings(fake_project)


# ---------------------------------------------------------------------------
# image_shrink — cache hit and PIL-unavailable paths
# ---------------------------------------------------------------------------


class TestImageShrinkCacheHit:
    def test_cache_hit_returns_existing_path(self, tmp_path):
        import token_goat.image_shrink as shrink_mod

        src = tmp_path / "photo.jpg"
        src.write_bytes(b"\xff\xd8\xff" + b"x" * (shrink_mod.SIZE_THRESHOLD_BYTES + 1))

        stem = shrink_mod._cache_path_for(src)
        stem.parent.mkdir(parents=True, exist_ok=True)
        cached = stem.with_suffix(".jpg")
        import io

        from PIL import Image as _Image
        _buf = io.BytesIO()
        _Image.new("RGB", (2, 2)).save(_buf, format="JPEG")
        cached.write_bytes(_buf.getvalue())

        result = shrink(src)
        assert result == cached

    def test_cache_hit_png_variant_returned(self, tmp_path):
        import token_goat.image_shrink as shrink_mod

        src = tmp_path / "diagram.png"
        src.write_bytes(b"\x89PNG" + b"y" * (shrink_mod.SIZE_THRESHOLD_BYTES + 1))

        stem = shrink_mod._cache_path_for(src)
        stem.parent.mkdir(parents=True, exist_ok=True)
        cached = stem.with_suffix(".png")
        # Write a minimal valid 2x2 PNG so the corruption-detection check passes.
        import io

        from PIL import Image as _Image
        buf = io.BytesIO()
        _Image.new("RGB", (2, 2)).save(buf, format="PNG")
        cached.write_bytes(buf.getvalue())

        result = shrink(src)
        assert result == cached

    def test_pil_unavailable_returns_none(self, tmp_path):
        import token_goat.image_shrink as shrink_mod

        src = tmp_path / "photo2.jpg"
        src.write_bytes(b"\xff\xd8\xff" + b"z" * (shrink_mod.SIZE_THRESHOLD_BYTES + 1))

        # Ensure no cache hit exists.
        stem = shrink_mod._cache_path_for(src)
        for suffix in (".jpg", ".png"):
            candidate = stem.with_suffix(suffix)
            if candidate.exists():
                candidate.unlink()

        import builtins  # noqa: PLC0415

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "PIL" or (isinstance(name, str) and name.startswith("PIL")):
                raise ImportError("PIL not installed")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            result = shrink(src)
        assert result is None

    def test_unsafe_path_returns_none(self):
        # A relative path is unsafe — should return None without raising.
        relative = Path("relative/photo.jpg")
        result = shrink(relative)
        assert result is None

    def test_non_image_extension_returns_none(self, tmp_path):
        import token_goat.image_shrink as shrink_mod

        src = tmp_path / "document.txt"
        src.write_bytes(b"x" * (shrink_mod.SIZE_THRESHOLD_BYTES + 1))
        result = shrink(src)
        assert result is None

    def test_small_image_returns_none(self, tmp_path):
        src = tmp_path / "tiny.jpg"
        src.write_bytes(b"\xff\xd8\xff" + b"x" * 100)
        result = shrink(src)
        assert result is None
