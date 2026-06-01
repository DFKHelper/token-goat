"""Tests for hooks_common, config, compact, session._merge_ranges, and paths.is_safe_rel_path."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat import compact as compact_mod
from token_goat import config as config_mod
from token_goat.hooks_common import get_session_context, sanitize_log_str, sanitize_opt
from token_goat.paths import is_safe_rel_path
from token_goat.session import FileEntry, SessionCache, _merge_ranges

# ---------------------------------------------------------------------------
# hooks_common.sanitize_log_str
# ---------------------------------------------------------------------------


class TestSanitizeLogStr:
    def test_normal_string_passes_through(self):
        assert sanitize_log_str("hello world") == "hello world"

    def test_embedded_newline_replaced(self):
        result = sanitize_log_str("line1\nline2")
        assert "\n" not in result
        assert "\\n" in result

    def test_embedded_carriage_return_replaced(self):
        result = sanitize_log_str("line1\rline2")
        assert "\r" not in result
        assert "\\r" in result

    def test_newline_and_cr_both_replaced(self):
        result = sanitize_log_str("a\r\nb")
        assert "\r" not in result
        assert "\n" not in result
        assert "\\r" in result
        assert "\\n" in result

    def test_unicode_directional_lrm_stripped(self):
        # U+200E LEFT-TO-RIGHT MARK
        result = sanitize_log_str("hello‎world")
        assert "‎" not in result
        assert result == "helloworld"

    def test_unicode_directional_rlm_stripped(self):
        # U+200F RIGHT-TO-LEFT MARK
        result = sanitize_log_str("hello‏world")
        assert "‏" not in result
        assert result == "helloworld"

    def test_unicode_lre_stripped(self):
        # U+202A LEFT-TO-RIGHT EMBEDDING
        result = sanitize_log_str("a‪b")
        assert "‪" not in result
        assert result == "ab"

    def test_unicode_rle_stripped(self):
        # U+202B RIGHT-TO-LEFT EMBEDDING
        result = sanitize_log_str("a‫b")
        assert "‫" not in result
        assert result == "ab"

    def test_unicode_rlo_stripped(self):
        # U+202E RIGHT-TO-LEFT OVERRIDE
        result = sanitize_log_str("a‮b")
        assert "‮" not in result

    def test_max_len_truncation_adds_ellipsis(self):
        s = "x" * 300
        result = sanitize_log_str(s, max_len=200)
        assert len(result) == 201  # 200 chars + ellipsis char
        assert result.endswith("…")

    def test_max_len_exact_not_truncated(self):
        s = "x" * 200
        result = sanitize_log_str(s, max_len=200)
        assert result == s  # exactly at limit, not truncated

    def test_max_len_one_over_truncated(self):
        s = "x" * 201
        result = sanitize_log_str(s, max_len=200)
        assert result.endswith("…")

    def test_empty_string_returns_empty(self):
        assert sanitize_log_str("") == ""

    def test_custom_max_len(self):
        result = sanitize_log_str("abcdef", max_len=3)
        assert result == "abc…"

    def test_multiple_bidi_chars_all_stripped(self):
        # Mix several bidi controls into one string
        s = "‎‏‪‫‮"
        result = sanitize_log_str(s)
        assert result == ""

    def test_newline_in_long_string_truncated_correctly(self):
        s = "a\n" + "b" * 300
        result = sanitize_log_str(s, max_len=200)
        assert "\\n" in result
        assert "\n" not in result
        assert result.endswith("…")


# ---------------------------------------------------------------------------
# hooks_common.sanitize_opt
# ---------------------------------------------------------------------------


class TestSanitizeOpt:
    def test_none_returns_empty(self):
        assert sanitize_opt(None) == ""

    def test_empty_string_returns_empty(self):
        assert sanitize_opt("") == ""

    def test_zero_returns_empty(self):
        assert sanitize_opt(0) == ""

    def test_false_returns_empty(self):
        assert sanitize_opt(False) == ""

    def test_normal_string_passes_through(self):
        assert sanitize_opt("my-session-id") == "my-session-id"

    def test_integer_coerced_to_str(self):
        # Non-zero int is truthy — coerced to string representation
        result = sanitize_opt(42)
        assert result == "42"

    def test_dict_coerced_to_str(self):
        result = sanitize_opt({"key": "val"})
        assert isinstance(result, str)
        assert "key" in result
        assert "val" in result

    def test_list_coerced_to_str(self):
        result = sanitize_opt(["a", "b"])
        assert isinstance(result, str)

    def test_length_cap_applied(self):
        # sanitize_opt calls sanitize_log_str with default max_len=200
        long_val = "x" * 300
        result = sanitize_opt(long_val)
        assert result.endswith("…")
        assert len(result) == 201

    def test_newline_in_value_escaped(self):
        result = sanitize_opt("hello\nworld")
        assert "\n" not in result
        assert "\\n" in result

    def test_non_string_truthy_logs_debug(self):
        # Just verifies it returns a string without raising
        result = sanitize_opt(3.14)
        assert result == "3.14"


# ---------------------------------------------------------------------------
# hooks_common.get_session_context
# ---------------------------------------------------------------------------


class TestGetSessionContext:
    def test_both_fields_present(self):
        payload = {"session_id": "abc123", "cwd": "/home/user/project"}
        sid, cwd = get_session_context(payload)
        assert sid == "abc123"
        assert cwd == "/home/user/project"

    def test_missing_session_id_returns_none(self):
        payload = {"cwd": "/home/user/project"}
        sid, cwd = get_session_context(payload)
        assert sid is None
        assert cwd == "/home/user/project"

    def test_missing_cwd_returns_none(self):
        payload = {"session_id": "abc123"}
        sid, cwd = get_session_context(payload)
        assert sid == "abc123"
        assert cwd is None

    def test_empty_dict_returns_none_none(self):
        sid, cwd = get_session_context({})
        assert sid is None
        assert cwd is None

    def test_both_fields_none_values(self):
        payload = {"session_id": None, "cwd": None}
        sid, cwd = get_session_context(payload)
        assert sid is None
        assert cwd is None

    def test_extra_fields_ignored(self):
        payload = {"session_id": "s1", "cwd": "/tmp", "tool_name": "Read", "turn_id": "t1"}
        sid, cwd = get_session_context(payload)
        assert sid == "s1"
        assert cwd == "/tmp"


# ---------------------------------------------------------------------------
# config.load
# ---------------------------------------------------------------------------


class TestConfigLoad:
    def test_returns_default_when_file_missing(self, tmp_path):
        fake_path = tmp_path / "nonexistent.toml"
        with patch.object(config_mod.paths, "config_path", return_value=fake_path):
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True
        assert cfg.compact_assist.min_events == 3
        assert cfg.compact_assist.max_manifest_tokens == 400

    def test_returns_default_on_oserror(self, tmp_path):
        p = tmp_path / "config.toml"
        p.write_text("[compact_assist]\nenabled = true\n", encoding="utf-8")
        with (
            patch.object(config_mod.paths, "config_path", return_value=p),
            patch.object(Path, "read_text", side_effect=OSError("disk error")),
        ):
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True
        assert cfg.compact_assist.min_events == 3

    def test_returns_default_on_malformed_toml(self, tmp_path):
        p = tmp_path / "config.toml"
        p.write_text("this is not valid toml ===\n[[[", encoding="utf-8")
        with patch.object(config_mod.paths, "config_path", return_value=p):
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is True

    def test_valid_toml_parsed(self, tmp_path):
        toml_content = (
            "schema_version = 1\n"
            "[compact_assist]\n"
            "enabled = false\n"
            "min_events = 10\n"
            "max_manifest_tokens = 600\n"
        )
        p = tmp_path / "config.toml"
        p.write_text(toml_content, encoding="utf-8")
        with patch.object(config_mod.paths, "config_path", return_value=p):
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False
        assert cfg.compact_assist.min_events == 10
        assert cfg.compact_assist.max_manifest_tokens == 600

    def test_compact_assist_section_loaded(self, tmp_path):
        toml_content = (
            "[compact_assist]\n"
            "enabled = true\n"
            'triggers = ["manual"]\n'
            "min_events = 3\n"
        )
        p = tmp_path / "config.toml"
        p.write_text(toml_content, encoding="utf-8")
        with patch.object(config_mod.paths, "config_path", return_value=p):
            cfg = config_mod.load()
        assert cfg.compact_assist.triggers == ["manual"]
        assert cfg.compact_assist.min_events == 3

    def test_env_var_disables_compact_assist(self, tmp_path):
        fake_path = tmp_path / "nonexistent.toml"
        with (
            patch.object(config_mod.paths, "config_path", return_value=fake_path),
            patch.dict("os.environ", {"TOKEN_GOAT_COMPACT_ASSIST": "0"}),
        ):
            cfg = config_mod.load()
        assert cfg.compact_assist.enabled is False

    def test_returns_config_object(self, tmp_path):
        fake_path = tmp_path / "nonexistent.toml"
        with patch.object(config_mod.paths, "config_path", return_value=fake_path):
            cfg = config_mod.load()
        assert isinstance(cfg, config_mod.Config)
        assert isinstance(cfg.compact_assist, config_mod.CompactAssistConfig)


# ---------------------------------------------------------------------------
# compact.build_manifest
# ---------------------------------------------------------------------------


def _make_session(session_id: str = "testsession123") -> SessionCache:
    now = time.time()
    return SessionCache(
        session_id=session_id,
        started_ts=now,
        last_activity_ts=now,
    )


class TestBuildManifest:
    @pytest.fixture(autouse=True)
    def _clear_manifest_sentinel(self, tmp_data_dir):
        """Item 26 introduced a Manifest Delta sidecar that persists between
        build_manifest calls. Tests in this class share a fixed session_id, so
        without isolation the second call sees a matching fingerprint and
        renders the "unchanged" stub instead of a fresh manifest. The
        tmp_data_dir fixture already scopes paths to a per-test temp dir; this
        autouse just guarantees the sentinel slate is clean at entry.
        """
        from token_goat import paths as _p  # noqa: PLC0415

        sentinels = _p.data_dir() / "sentinels"
        if sentinels.exists():
            for sidecar in sentinels.glob("manifest_sha_*"):
                sidecar.unlink(missing_ok=True)
        yield

    def test_invalid_session_returns_empty(self):
        result = compact_mod.build_manifest("../traversal")
        assert result == ""

    def test_empty_session_returns_empty(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            result = compact_mod.build_manifest(session_id, max_tokens=400)
        # Nothing edited, nothing read — manifest suppressed
        assert result == ""

    def test_manifest_has_header(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        now = time.time()
        cache.files["src/foo.py"] = FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=now,
            read_count=2,
            line_ranges=[(1, 50)],
            symbols_read=[],
        )
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            result = compact_mod.build_manifest(session_id, max_tokens=400)
        assert "Token-Goat Session Manifest" in result or "token-goat" in result.lower()

    def test_edited_files_appear_before_symbols(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        now = time.time()
        cache.edited_files["src/edited.py"] = 1
        cache.files["src/symbol_file.py"] = FileEntry(
            rel_or_abs="src/symbol_file.py",
            last_read_ts=now,
            read_count=1,
            line_ranges=[],
            symbols_read=["MyClass"],
        )
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            result = compact_mod.build_manifest(session_id, max_tokens=400)
        edited_pos = result.find("edited.py")
        symbol_pos = result.find("symbol_file.py")
        assert edited_pos != -1
        assert symbol_pos != -1
        assert edited_pos < symbol_pos

    def test_max_tokens_zero_clamped_to_one(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        cache.edited_files["src/foo.py"] = 1
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            # max_tokens=0 gets clamped to 1; result may be very short but not crash
            result = compact_mod.build_manifest(session_id, max_tokens=0)
        assert isinstance(result, str)

    def test_char_limit_enforced(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        now = time.time()
        for i in range(20):
            key = f"src/file_{i:02d}.py"
            cache.files[key] = FileEntry(
                rel_or_abs=key,
                last_read_ts=now,
                read_count=i + 1,
                line_ranges=[(1, 100)],
                symbols_read=[],
            )
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            result = compact_mod.build_manifest(session_id, max_tokens=50)
        assert isinstance(result, str)
        # 50 tokens * ~4 chars/token is a generous upper bound after trimming
        assert len(result) < 50 * 4

    def test_edited_files_section_label(self):
        session_id = "testsession123"
        cache = _make_session(session_id)
        cache.edited_files["src/thing.py"] = 2
        with patch.object(compact_mod.session_mod, "load", return_value=cache):
            result = compact_mod.build_manifest(session_id, max_tokens=400)
        # Uncommitted edits show as Staged/Uncommitted; committed show as Edited
        assert "Staged/Uncommitted:" in result or "Edited:" in result


# ---------------------------------------------------------------------------
# session._merge_ranges
# ---------------------------------------------------------------------------


class TestMergeRanges:
    def test_empty_returns_empty(self):
        assert _merge_ranges([]) == []

    def test_single_element_fast_path(self):
        result = _merge_ranges([(5, 10)])
        assert result == [(5, 10)]

    def test_single_element_returns_copy(self):
        original = [(5, 10)]
        result = _merge_ranges(original)
        assert result == original
        assert result is not original

    def test_overlapping_ranges_merged(self):
        result = _merge_ranges([(1, 10), (5, 15)])
        assert result == [(1, 15)]

    def test_adjacent_ranges_merged(self):
        # (1, 10) and (11, 20) are adjacent
        result = _merge_ranges([(1, 10), (11, 20)])
        assert result == [(1, 20)]

    def test_non_overlapping_stay_separate(self):
        result = _merge_ranges([(1, 5), (10, 20)])
        assert result == [(1, 5), (10, 20)]

    def test_unsorted_input_sorted_in_output(self):
        result = _merge_ranges([(10, 20), (1, 5)])
        assert result == [(1, 5), (10, 20)]

    def test_multiple_overlapping_merged_to_one(self):
        result = _merge_ranges([(1, 5), (3, 8), (6, 12)])
        assert result == [(1, 12)]

    def test_three_groups_stay_separate(self):
        result = _merge_ranges([(1, 5), (10, 15), (20, 25)])
        assert result == [(1, 5), (10, 15), (20, 25)]

    def test_identical_ranges_merged(self):
        result = _merge_ranges([(5, 10), (5, 10)])
        assert result == [(5, 10)]

    def test_contained_range_merged(self):
        # (3, 8) is fully contained within (1, 10)
        result = _merge_ranges([(1, 10), (3, 8)])
        assert result == [(1, 10)]

    def test_output_sorted_ascending(self):
        result = _merge_ranges([(100, 200), (1, 50), (60, 90)])
        assert result == [(1, 50), (60, 90), (100, 200)]

    def test_large_gap_stays_separate(self):
        result = _merge_ranges([(1, 10), (99_999, 100_000)])
        assert result == [(1, 10), (99_999, 100_000)]


# ---------------------------------------------------------------------------
# paths.is_safe_rel_path
# ---------------------------------------------------------------------------


class TestIsSafeRelPath:
    def test_simple_filename_safe(self):
        assert is_safe_rel_path("foo.py") is True

    def test_nested_path_safe(self):
        assert is_safe_rel_path("foo/bar/baz.py") is True

    def test_parent_traversal_rejected(self):
        assert is_safe_rel_path("../foo") is False

    def test_double_parent_traversal_rejected(self):
        assert is_safe_rel_path("../../etc/passwd") is False

    def test_traversal_in_middle_rejected(self):
        assert is_safe_rel_path("foo/../bar") is False

    def test_dot_slash_is_safe(self):
        # "./foo" contains only a "." component, not ".."; only ".." is forbidden
        assert is_safe_rel_path("./foo") is True

    def test_absolute_posix_path_rejected(self):
        assert is_safe_rel_path("/etc/passwd") is False

    def test_absolute_windows_drive_path_rejected(self):
        assert is_safe_rel_path("C:/Users/foo") is False

    def test_empty_string_rejected(self):
        assert is_safe_rel_path("") is False

    def test_whitespace_only_rejected(self):
        assert is_safe_rel_path("   ") is False

    def test_null_byte_rejected(self):
        assert is_safe_rel_path("foo\x00bar") is False

    def test_unc_path_rejected(self):
        assert is_safe_rel_path("//server/share") is False

    def test_windows_backslash_traversal_rejected(self):
        # Backslashes are normalised to forward slashes before checking
        assert is_safe_rel_path("..\\foo") is False

    def test_deep_nested_path_safe(self):
        assert is_safe_rel_path("a/b/c/d/e/f.py") is True

    def test_filename_with_dots_safe(self):
        assert is_safe_rel_path("my.module.test.py") is True
