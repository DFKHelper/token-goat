"""Tests for cache_common — shared OUTPUT_FILENAME_RE, safe_session_fragment, and load_sidecar_json."""
from __future__ import annotations

import json

import pytest

from token_goat.cache_common import OUTPUT_FILENAME_RE, load_sidecar_json, safe_session_fragment


class TestOutputFilenameRE:
    """OUTPUT_FILENAME_RE must accept valid cache filenames and reject traversal attempts."""

    @pytest.mark.parametrize("name", [
        "anon-0000000000000-deadbeefcafe0000.txt",
        "abc-def_012-3456789012345-abcdef0123456789.txt",
        "a.txt",
        "A" * 80 + ".txt",                   # exactly 80 chars before .txt
        "abc-123_XYZ.txt",
    ])
    def test_valid_names_match(self, name: str) -> None:
        assert OUTPUT_FILENAME_RE.match(name) is not None, f"should match: {name!r}"

    @pytest.mark.parametrize("name", [
        "",                                   # empty
        ".txt",                               # no stem
        "A" * 81 + ".txt",                   # 81 chars before .txt — over the limit
        "../etc/passwd.txt",                  # traversal attempt
        "foo/bar.txt",                        # path separator
        "has space.txt",                      # space
        "no_extension",                       # missing .txt
        "has.dot.in.middle.txt",              # internal dot
        "nul\x00byte.txt",                    # null byte
    ])
    def test_invalid_names_do_not_match(self, name: str) -> None:
        assert OUTPUT_FILENAME_RE.match(name) is None, f"should NOT match: {name!r}"

    def test_both_cache_modules_import_the_same_object(self) -> None:
        """bash_cache and web_cache must re-export the identical compiled object."""
        from token_goat import bash_cache, web_cache

        assert bash_cache.OUTPUT_FILENAME_RE is OUTPUT_FILENAME_RE
        assert web_cache.OUTPUT_FILENAME_RE is OUTPUT_FILENAME_RE


class TestSafeSessionFragment:
    """safe_session_fragment must produce filesystem-safe 16-char prefixes."""

    def test_clean_ascii_passthrough(self) -> None:
        assert safe_session_fragment("abc-123_XYZ") == "abc-123_XYZ"

    def test_truncated_to_16_chars(self) -> None:
        result = safe_session_fragment("a" * 64)
        assert result == "a" * 16

    def test_exactly_16_chars_unchanged(self) -> None:
        s = "abcdef01234-_xyz"
        assert len(s) == 16
        assert safe_session_fragment(s) == s

    def test_invalid_chars_replaced_with_underscore(self) -> None:
        result = safe_session_fragment("hello world!")
        assert result == "hello_world_"

    def test_empty_string_falls_back_to_anon(self) -> None:
        assert safe_session_fragment("") == "anon"

    def test_all_invalid_chars_short_string_falls_back_to_anon(self) -> None:
        # Four punctuation chars → "____" which is non-empty, not "anon".
        # This documents the actual contract: only the truly empty result triggers anon.
        result = safe_session_fragment("!@#$")
        assert result == "____"

    def test_long_all_invalid_chars_truncated(self) -> None:
        result = safe_session_fragment("!" * 100)
        assert result == "_" * 16

    def test_unicode_chars_replaced(self) -> None:
        result = safe_session_fragment("héllo-world")
        assert result == "h_llo-world"

    def test_output_only_contains_safe_chars(self) -> None:
        import string
        allowed = set(string.ascii_letters + string.digits + "_-")
        for session_id in [
            "normal-session-id-123",
            "spaces and\ttabs",
            "slashes/in\\path",
            "unicode: 中文",
            "",
            "!" * 200,
        ]:
            result = safe_session_fragment(session_id)
            bad = set(result) - allowed
            assert not bad, f"unsafe chars {bad!r} in fragment for {session_id!r}"

    def test_result_never_exceeds_16_chars(self) -> None:
        for s in ["", "a", "a" * 16, "a" * 17, "a" * 1000, "!" * 1000]:
            assert len(safe_session_fragment(s)) <= 16

    def test_matches_bash_cache_output_id_for_prefix(self, tmp_path, monkeypatch) -> None:
        """The fragment in a bash_cache output ID must equal safe_session_fragment output."""
        import token_goat.paths as _paths

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat.bash_cache import output_id_for

        session_id = "my-test-session-id-extra-long"
        out_id = output_id_for(session_id, "echo hello", ts=0.0)
        expected_prefix = safe_session_fragment(session_id)
        assert out_id.startswith(expected_prefix + "-"), (
            f"output_id {out_id!r} should start with {expected_prefix!r}-"
        )

    def test_matches_web_cache_output_id_for_prefix(self, tmp_path, monkeypatch) -> None:
        """Same contract for web_cache.output_id_for."""
        import token_goat.paths as _paths

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat.web_cache import output_id_for

        session_id = "my-web-session-id-extra-long"
        out_id = output_id_for(session_id, "https://example.com/page", ts=0.0)
        expected_prefix = safe_session_fragment(session_id)
        assert out_id.startswith(expected_prefix + "-"), (
            f"output_id {out_id!r} should start with {expected_prefix!r}-"
        )


class TestLoadSidecarJson:
    """load_sidecar_json: load + validate a JSON sidecar, returning dict or None."""

    def test_returns_dict_for_valid_file(self, tmp_path) -> None:
        p = tmp_path / "sidecar.json"
        p.write_text(json.dumps({"output_id": "abc", "ts": 1.0}), encoding="utf-8")
        result = load_sidecar_json(p)
        assert isinstance(result, dict)
        assert result["output_id"] == "abc"

    def test_missing_file_returns_none(self, tmp_path) -> None:
        p = tmp_path / "nonexistent.json"
        assert load_sidecar_json(p) is None

    def test_malformed_json_returns_none(self, tmp_path) -> None:
        p = tmp_path / "bad.json"
        p.write_text("not valid json {{{", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_array_returns_none(self, tmp_path) -> None:
        p = tmp_path / "array.json"
        p.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_string_returns_none(self, tmp_path) -> None:
        p = tmp_path / "string.json"
        p.write_text(json.dumps("just a string"), encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_null_returns_none(self, tmp_path) -> None:
        p = tmp_path / "null.json"
        p.write_text("null", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_number_returns_none(self, tmp_path) -> None:
        p = tmp_path / "number.json"
        p.write_text("42", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_empty_dict_is_valid(self, tmp_path) -> None:
        p = tmp_path / "empty.json"
        p.write_text("{}", encoding="utf-8")
        result = load_sidecar_json(p)
        assert result == {}

    def test_returns_same_dict_on_repeated_call(self, tmp_path) -> None:
        """Two calls on the same file return equal (not necessarily identical) dicts."""
        p = tmp_path / "repeat.json"
        payload = {"output_id": "xyz", "ts": 9.9, "truncated": False}
        p.write_text(json.dumps(payload), encoding="utf-8")
        r1 = load_sidecar_json(p)
        r2 = load_sidecar_json(p)
        assert r1 == r2 == payload

    def test_io_error_returns_none(self, tmp_path, monkeypatch) -> None:
        """An OSError during read_text (e.g. permission denied) returns None."""
        from pathlib import Path

        p = tmp_path / "locked.json"
        p.write_text("{}", encoding="utf-8")

        original_read_text = Path.read_text

        def _raise(self, *args, **kwargs):  # type: ignore[override]
            if self == p:
                raise OSError("permission denied")
            return original_read_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", _raise)
        assert load_sidecar_json(p) is None
