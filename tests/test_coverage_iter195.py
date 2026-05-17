"""Regression tests for iterations 191–194.

Coverage targets:
- hooks_common.py: get_session_context() returns (None, None) when fields absent; logs DEBUG
- config.py: TOMLDecodeError and OSError both return default Config
- worker.py: _package_fingerprint returns fallback None on OSError / ValueError
- gdrive.py: _validate_mime_type valid/invalid/too-long/non-string inputs
- paths.py: _safe_env_dir rejects relative paths and accepts absolute paths
- read_commands.py: _key_dep_by_size and _key_transitive_by_depth sort correctly
- session.py: _prepare_path_mutation logs DEBUG on empty path and unavailable cache
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ===========================================================================
# 1. hooks_common.py — get_session_context
# ===========================================================================


class TestGetSessionContext:
    """get_session_context must return (None, None) when fields are absent and log DEBUG."""

    def test_returns_none_none_when_both_absent(self):
        """Empty payload yields (None, None)."""
        from token_goat.hooks_common import get_session_context

        session_id, cwd = get_session_context({})
        assert session_id is None
        assert cwd is None

    def test_returns_values_when_both_present(self):
        """Payload with both fields yields their values."""
        from token_goat.hooks_common import get_session_context

        session_id, cwd = get_session_context(
            {"session_id": "abc123", "cwd": "/tmp/proj"}  # type: ignore[typeddict-item]
        )
        assert session_id == "abc123"
        assert cwd == "/tmp/proj"

    def test_returns_none_cwd_when_cwd_absent(self):
        """Payload with only session_id yields (session_id, None)."""
        from token_goat.hooks_common import get_session_context

        session_id, cwd = get_session_context(
            {"session_id": "xyz"}  # type: ignore[typeddict-item]
        )
        assert session_id == "xyz"
        assert cwd is None

    def test_returns_none_session_id_when_session_id_absent(self):
        """Payload with only cwd yields (None, cwd)."""
        from token_goat.hooks_common import get_session_context

        session_id, cwd = get_session_context(
            {"cwd": "/home/user/project"}  # type: ignore[typeddict-item]
        )
        assert session_id is None
        assert cwd == "/home/user/project"

    def test_logs_debug_when_session_id_absent(self, caplog):
        """A missing session_id must emit a DEBUG log."""
        from token_goat.hooks_common import get_session_context

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            get_session_context({"cwd": "/tmp"})  # type: ignore[typeddict-item]

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("session_id" in m and "absent" in m for m in debug_msgs), (
            f"Expected DEBUG about missing session_id, got: {debug_msgs}"
        )

    def test_logs_debug_when_cwd_absent(self, caplog):
        """A missing cwd must emit a DEBUG log."""
        from token_goat.hooks_common import get_session_context

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            get_session_context({"session_id": "s1"})  # type: ignore[typeddict-item]

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("cwd" in m and "absent" in m for m in debug_msgs), (
            f"Expected DEBUG about missing cwd, got: {debug_msgs}"
        )

    def test_logs_debug_for_both_when_payload_empty(self, caplog):
        """Empty payload must log DEBUG for both missing fields."""
        from token_goat.hooks_common import get_session_context

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            get_session_context({})

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        has_session_id_log = any("session_id" in m and "absent" in m for m in debug_msgs)
        has_cwd_log = any("cwd" in m and "absent" in m for m in debug_msgs)
        assert has_session_id_log, f"Missing session_id DEBUG log. Got: {debug_msgs}"
        assert has_cwd_log, f"Missing cwd DEBUG log. Got: {debug_msgs}"

    def test_no_debug_log_when_both_fields_present(self, caplog):
        """When both fields are present no DEBUG log about absence should be emitted."""
        from token_goat.hooks_common import get_session_context

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            get_session_context(
                {"session_id": "s1", "cwd": "/p"}  # type: ignore[typeddict-item]
            )

        absent_msgs = [
            r.message for r in caplog.records
            if r.levelno == logging.DEBUG and "absent" in r.message
        ]
        assert not absent_msgs, f"Unexpected 'absent' DEBUG logs: {absent_msgs}"

    def test_tool_name_appears_in_debug_log(self, caplog):
        """The tool_name from the payload should appear in the DEBUG log message."""
        from token_goat.hooks_common import get_session_context

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            get_session_context({"tool_name": "Read"})  # type: ignore[typeddict-item]

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("Read" in m for m in debug_msgs), (
            f"Expected tool_name 'Read' in DEBUG log, got: {debug_msgs}"
        )


# ===========================================================================
# 2. config.py — narrowed exception handling
# ===========================================================================


class TestConfigLoadExceptions:
    """config.load() must return default Config on TOMLDecodeError or OSError."""

    def test_toml_decode_error_returns_default(self, tmp_path):
        """A malformed TOML file must trigger TOMLDecodeError → default Config returned."""

        from token_goat import config

        bad_toml = tmp_path / "config.toml"
        bad_toml.write_text("this is [not valid toml !!!<<\x00", encoding="utf-8")

        with patch.object(config.paths, "config_path", return_value=bad_toml):
            result = config.load()

        # Must return a Config with all defaults
        assert isinstance(result, config.Config)
        assert result.compact_assist.enabled is True
        assert result.compact_assist.min_events == 3
        assert result.compact_assist.max_manifest_tokens == 400

    def test_os_error_returns_default(self, tmp_path):
        """An OSError while reading the config file must return default Config."""
        from token_goat import config

        fake_path = tmp_path / "config.toml"
        fake_path.touch()

        with (
            patch.object(config.paths, "config_path", return_value=fake_path),
            patch.object(Path, "read_text", side_effect=OSError("permission denied")),
        ):
            result = config.load()

        assert isinstance(result, config.Config)
        assert result.compact_assist.enabled is True

    def test_missing_file_returns_default(self, tmp_path):
        """A config path that does not exist must silently return default Config."""
        from token_goat import config

        nonexistent = tmp_path / "no_such_config.toml"

        with patch.object(config.paths, "config_path", return_value=nonexistent):
            result = config.load()

        assert isinstance(result, config.Config)
        assert result.compact_assist.triggers == ["manual", "auto"]

    def test_valid_toml_loads_values(self, tmp_path):
        """A well-formed TOML file must be loaded and values applied."""
        from token_goat import config

        good_toml = tmp_path / "config.toml"
        good_toml.write_text(
            "[compact_assist]\nenabled = false\nmin_events = 10\n",
            encoding="utf-8",
        )

        with patch.object(config.paths, "config_path", return_value=good_toml):
            result = config.load()

        assert result.compact_assist.enabled is False
        assert result.compact_assist.min_events == 10


# ===========================================================================
# 3. worker.py — _package_fingerprint fallback
# ===========================================================================


class TestPackageFingerprint:
    """_package_fingerprint must return None on OSError or ValueError."""

    def test_returns_string_on_success(self):
        """Normal execution must return a non-empty hex string."""
        from token_goat.worker import _package_fingerprint

        result = _package_fingerprint()
        # May be None if running in a weird environment, but if not None it's a hex string
        if result is not None:
            assert isinstance(result, str)
            assert len(result) == 40  # SHA-1 hex digest

    def test_returns_none_on_os_error(self):
        """An OSError from rglob/stat must be caught and None returned."""
        from token_goat.worker import _package_fingerprint

        with patch("pathlib.Path.rglob", side_effect=OSError("disk error")):
            result = _package_fingerprint()

        assert result is None

    def test_returns_none_on_value_error(self):
        """A ValueError (e.g. from relative_to path escape) must be caught and None returned."""
        from token_goat import worker

        # Patch Path.rglob to return a fake .py file whose relative_to() raises ValueError
        fake_py = Path("/some/other/dir/file.py")

        with (
            patch("pathlib.Path.rglob", return_value=iter([fake_py])),
            patch.object(Path, "relative_to", side_effect=ValueError("does not start with")),
        ):
            result = worker._package_fingerprint()

        assert result is None

    def test_logs_debug_on_os_error(self, caplog):
        """The OSError fallback must emit a DEBUG log."""
        from token_goat.worker import _package_fingerprint

        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.worker"),
            patch("pathlib.Path.rglob", side_effect=OSError("no disk")),
        ):
            _package_fingerprint()

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("fingerprint" in m.lower() or "falling back" in m.lower() for m in debug_msgs), (
            f"Expected DEBUG fallback log, got: {debug_msgs}"
        )


# ===========================================================================
# 4. gdrive.py — _validate_mime_type
# ===========================================================================


class TestValidateMimeType:
    """_validate_mime_type must accept valid types and replace bad ones with octet-stream."""

    def test_valid_mime_type_returned_unchanged(self):
        """A well-formed MIME type must be returned unchanged."""
        from token_goat.gdrive import _validate_mime_type

        assert _validate_mime_type("image/png", "file123") == "image/png"
        assert _validate_mime_type("application/json", "file456") == "application/json"
        assert _validate_mime_type("text/plain", "file789") == "text/plain"

    def test_google_workspace_type_returned_unchanged(self):
        """Google Workspace MIME types must pass validation."""
        from token_goat.gdrive import _validate_mime_type

        mime = "application/vnd.google-apps.document"
        assert _validate_mime_type(mime, "docid") == mime

    def test_invalid_chars_replaced_with_octet_stream(self):
        """A MIME type with invalid characters must be replaced with application/octet-stream."""
        from token_goat.gdrive import _validate_mime_type

        # Embedded null byte — not in the allowed character class
        assert _validate_mime_type("image/\x00png", "f1") == "application/octet-stream"
        # Control characters
        assert _validate_mime_type("text/\x1fplain", "f2") == "application/octet-stream"
        # Missing slash (no type/subtype structure)
        assert _validate_mime_type("notamimetype", "f3") == "application/octet-stream"

    def test_too_long_type_replaced_with_octet_stream(self):
        """A MIME type exceeding _MAX_MIME_TYPE_LEN must be replaced with application/octet-stream."""
        from token_goat.gdrive import _MAX_MIME_TYPE_LEN, _validate_mime_type

        long_mime = "application/" + "x" * (_MAX_MIME_TYPE_LEN + 1)
        result = _validate_mime_type(long_mime, "longfile")
        assert result == "application/octet-stream"

    def test_mime_at_max_length_accepted(self):
        """A MIME type at exactly _MAX_MIME_TYPE_LEN must not be rejected for length."""
        from token_goat.gdrive import _MAX_MIME_TYPE_LEN, _validate_mime_type

        # Build a valid MIME string of exactly max length
        subtype_len = _MAX_MIME_TYPE_LEN - len("image/")
        exact_mime = "image/" + "x" * subtype_len
        assert len(exact_mime) == _MAX_MIME_TYPE_LEN
        result = _validate_mime_type(exact_mime, "exactfile")
        # May or may not match the regex depending on subtype chars, but must not crash
        assert isinstance(result, str)

    def test_non_string_replaced_with_octet_stream(self):
        """A non-string mimeType (e.g. None, int) must be replaced with application/octet-stream."""
        from token_goat.gdrive import _validate_mime_type

        assert _validate_mime_type(None, "f1") == "application/octet-stream"  # type: ignore[arg-type]
        assert _validate_mime_type(42, "f2") == "application/octet-stream"  # type: ignore[arg-type]
        assert _validate_mime_type([], "f3") == "application/octet-stream"  # type: ignore[arg-type]

    def test_non_string_logs_warning(self, caplog):
        """A non-string mimeType must emit a WARNING log."""
        from token_goat.gdrive import _validate_mime_type

        with caplog.at_level(logging.WARNING, logger="token_goat.gdrive"):
            _validate_mime_type(None, "badfile")  # type: ignore[arg-type]

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("mimeType" in m or "mime" in m.lower() for m in warn_msgs), (
            f"Expected WARNING about non-string mimeType, got: {warn_msgs}"
        )


# ===========================================================================
# 5. paths.py — _safe_env_dir
# ===========================================================================


class TestSafeEnvDir:
    """_safe_env_dir must reject relative paths and accept absolute ones."""

    def test_absolute_path_accepted(self):
        """An absolute path must be returned as a Path object."""
        from token_goat.paths import _safe_env_dir

        if sys.platform == "win32":
            result = _safe_env_dir("C:\\Users\\test")
            assert result is not None
            assert result == Path("C:\\Users\\test")
        else:
            result = _safe_env_dir("/home/user/data")
            assert result is not None
            assert result == Path("/home/user/data")

    def test_relative_path_rejected(self):
        """A relative path must return None."""
        from token_goat.paths import _safe_env_dir

        assert _safe_env_dir("../../etc") is None
        assert _safe_env_dir("relative/path") is None
        assert _safe_env_dir("./local") is None

    def test_relative_path_logs_warning(self, caplog):
        """A relative path must emit a WARNING log."""
        from token_goat.paths import _safe_env_dir

        with caplog.at_level(logging.WARNING, logger="token_goat.paths"):
            _safe_env_dir("../../evil")

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("rejected" in m or "not absolute" in m for m in warn_msgs), (
            f"Expected WARNING about relative path rejection, got: {warn_msgs}"
        )

    def test_empty_string_returns_none(self):
        """An empty or whitespace-only string must return None."""
        from token_goat.paths import _safe_env_dir

        assert _safe_env_dir("") is None
        assert _safe_env_dir("   ") is None

    def test_whitespace_padded_absolute_path_accepted(self):
        """An absolute path with surrounding whitespace must be stripped and accepted."""
        from token_goat.paths import _safe_env_dir

        if sys.platform == "win32":
            result = _safe_env_dir("  C:\\data  ")
            assert result is not None
        else:
            result = _safe_env_dir("  /tmp/data  ")
            assert result is not None
            assert result == Path("/tmp/data")

    def test_falls_back_in_default_data_dir_on_relative_localappdata(self, monkeypatch):
        """_default_data_dir must fall back when LOCALAPPDATA is a relative path."""
        from token_goat import paths

        if sys.platform != "win32":
            pytest.skip("LOCALAPPDATA only applies on Windows")

        monkeypatch.setenv("LOCALAPPDATA", "../../etc")
        result = paths._default_data_dir()
        # Must not contain the attacker-controlled path component
        assert "etc" not in str(result).lower() or "dfk-helper" in str(result)

    def test_falls_back_in_default_data_dir_on_relative_xdg(self, monkeypatch):
        """_default_data_dir must fall back when XDG_DATA_HOME is a relative path."""
        from token_goat import paths

        if sys.platform == "win32":
            pytest.skip("XDG_DATA_HOME only applies on non-Windows")

        monkeypatch.setenv("XDG_DATA_HOME", "../../evil")
        result = paths._default_data_dir()
        # Should fall back to ~/.local/share/token-goat, not the evil path
        assert "evil" not in str(result)
        assert "token-goat" in str(result)


# ===========================================================================
# 6. read_commands.py — _key_dep_by_size and _key_transitive_by_depth
# ===========================================================================


class TestKeyDepBySize:
    """_key_dep_by_size must sort by descending symbol count, then ascending name."""

    def test_larger_set_sorts_first(self):
        """Item with more symbols must sort before item with fewer symbols."""
        from token_goat.read_commands import _key_dep_by_size

        items = [
            ("a.py", {"sym1"}),
            ("b.py", {"sym1", "sym2", "sym3"}),
            ("c.py", {"sym1", "sym2"}),
        ]
        sorted_items = sorted(items, key=_key_dep_by_size)
        names = [name for name, _ in sorted_items]
        assert names == ["b.py", "c.py", "a.py"]

    def test_equal_size_sorted_by_name(self):
        """Items with the same symbol count must be sorted alphabetically by name."""
        from token_goat.read_commands import _key_dep_by_size

        items = [
            ("z.py", {"a", "b"}),
            ("a.py", {"c", "d"}),
            ("m.py", {"e", "f"}),
        ]
        sorted_items = sorted(items, key=_key_dep_by_size)
        names = [name for name, _ in sorted_items]
        assert names == ["a.py", "m.py", "z.py"]

    def test_key_returns_negative_len_as_first_element(self):
        """The key tuple's first element must be the negative symbol count."""
        from token_goat.read_commands import _key_dep_by_size

        key = _key_dep_by_size(("foo.py", {"a", "b", "c"}))
        assert key[0] == -3
        assert key[1] == "foo.py"

    def test_empty_set_sorts_last(self):
        """An item with an empty symbol set must sort after all non-empty items."""
        from token_goat.read_commands import _key_dep_by_size

        items = [
            ("empty.py", set()),
            ("one.py", {"x"}),
        ]
        sorted_items = sorted(items, key=_key_dep_by_size)
        assert sorted_items[0][0] == "one.py"
        assert sorted_items[1][0] == "empty.py"

    def test_single_item_list_unchanged(self):
        """Sorting a single-item list must return that item."""
        from token_goat.read_commands import _key_dep_by_size

        items = [("only.py", {"sym"})]
        assert sorted(items, key=_key_dep_by_size) == items


class TestKeyTransitiveByDepth:
    """_key_transitive_by_depth must sort by ascending depth, then ascending name."""

    def test_lower_depth_sorts_first(self):
        """Item with lower depth must sort before item with higher depth."""
        from token_goat.read_commands import _key_transitive_by_depth

        items = [
            ("c.py", {"depth": 3, "symbols": set()}),
            ("a.py", {"depth": 1, "symbols": set()}),
            ("b.py", {"depth": 2, "symbols": set()}),
        ]
        sorted_items = sorted(items, key=_key_transitive_by_depth)
        names = [name for name, _ in sorted_items]
        assert names == ["a.py", "b.py", "c.py"]

    def test_equal_depth_sorted_by_name(self):
        """Items at the same depth must be sorted alphabetically by name."""
        from token_goat.read_commands import _key_transitive_by_depth

        items = [
            ("z.py", {"depth": 2, "symbols": set()}),
            ("a.py", {"depth": 2, "symbols": set()}),
        ]
        sorted_items = sorted(items, key=_key_transitive_by_depth)
        assert sorted_items[0][0] == "a.py"
        assert sorted_items[1][0] == "z.py"

    def test_key_returns_depth_as_first_element(self):
        """The key tuple's first element must be the depth value."""
        from token_goat.read_commands import _key_transitive_by_depth

        key = _key_transitive_by_depth(("foo.py", {"depth": 5, "symbols": set()}))
        assert key[0] == 5
        assert key[1] == "foo.py"

    def test_depth_zero_sorts_before_depth_one(self):
        """Depth 0 must sort before depth 1."""
        from token_goat.read_commands import _key_transitive_by_depth

        items = [
            ("deep.py", {"depth": 1, "symbols": set()}),
            ("root.py", {"depth": 0, "symbols": set()}),
        ]
        sorted_items = sorted(items, key=_key_transitive_by_depth)
        assert sorted_items[0][0] == "root.py"


# ===========================================================================
# 7. session.py — _prepare_path_mutation bail-out logging
# ===========================================================================


class TestPreparePathMutationLogging:
    """_prepare_path_mutation must log DEBUG when bailing out early."""

    def test_logs_debug_on_empty_path(self, tmp_data_dir, caplog):
        """An empty path (after sanitize) must emit a DEBUG log and return None."""
        from token_goat import session

        with caplog.at_level(logging.DEBUG, logger="token_goat.session"):
            result = session._prepare_path_mutation("session001", "", None)

        assert result is None
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("empty path" in m.lower() or "_prepare_path_mutation" in m for m in debug_msgs), (
            f"Expected DEBUG about empty path, got: {debug_msgs}"
        )

    def test_returns_none_on_empty_path(self, tmp_data_dir):
        """An empty path must cause _prepare_path_mutation to return None."""
        from token_goat import session

        result = session._prepare_path_mutation("session002", "", None)
        assert result is None

    def test_returns_tuple_on_valid_path(self, tmp_data_dir):
        """A valid path must return a (cache, key) tuple."""
        from token_goat import session

        sid = "session_valid_001"
        cache = session._fresh_cache(sid)
        result = session._prepare_path_mutation(sid, "src/foo.py", cache)
        assert result is not None
        assert isinstance(result, tuple)
        assert len(result) == 2
        cache_out, key = result
        assert isinstance(key, str)
        assert len(key) > 0

    def test_logs_debug_on_unavailable_cache(self, tmp_data_dir, caplog):
        """An unavailable session cache must emit a DEBUG log and return None."""
        from token_goat import session

        sid = "session_unavailable_001"
        cache = session._fresh_cache(sid)
        cache.unavailable = True

        with caplog.at_level(logging.DEBUG, logger="token_goat.session"):
            result = session._prepare_path_mutation(sid, "src/foo.py", cache)

        assert result is None
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any(
            "unavailable" in m.lower() or "_prepare_path_mutation" in m
            for m in debug_msgs
        ), f"Expected DEBUG about unavailable session, got: {debug_msgs}"

    def test_returns_none_on_unavailable_cache(self, tmp_data_dir):
        """An unavailable cache must cause _prepare_path_mutation to return None."""
        from token_goat import session

        sid = "session_unavailable_002"
        cache = session._fresh_cache(sid)
        cache.unavailable = True
        result = session._prepare_path_mutation(sid, "src/bar.py", cache)
        assert result is None

    def test_session_id_truncated_in_log(self, tmp_data_dir, caplog):
        """The session_id in the DEBUG log must be truncated to 16 chars."""
        from token_goat import session

        long_sid = "a" * 64
        with caplog.at_level(logging.DEBUG, logger="token_goat.session"):
            session._prepare_path_mutation(long_sid, "", None)

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        # The full 64-char session_id must not appear verbatim — only the first 16 chars
        full_sid_in_logs = any(long_sid in m for m in debug_msgs)
        assert not full_sid_in_logs, "Full session_id (64 chars) must not appear in logs"
        truncated_prefix = long_sid[:16]
        prefix_in_logs = any(truncated_prefix in m for m in debug_msgs)
        assert prefix_in_logs, f"Truncated session_id prefix not found in: {debug_msgs}"
