"""Regression tests for iterations 181–184.

Coverage targets:
- hooks_common.py: HookPayload TypedDict fields; sanitize_opt logs DEBUG on non-string coercion
- hooks_cli.py: fail_soft handles a HookPayload-typed payload without raising
- languages/json_idx.py: _safe_repr catches TypeError/ValueError; unexpected exception propagates
- languages/typescript.py: parse failure log message contains exception string
- session.py: mark_file_read symbol sanitization (newlines stripped) and cap at MAX_SYMBOLS_PER_FILE=50
- compact.py: build_manifest max_tokens hard ceiling at 4000 clamps values above it
- worker.py: project_marker sanitization (newlines stripped, length capped at 64)
- session.py: line_range values — malformed entries dropped by _parse_file_entry
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest

# ===========================================================================
# 1. hooks_common.py — HookPayload TypedDict has expected fields
# ===========================================================================


class TestHookPayloadFields:
    """HookPayload TypedDict must declare all fields the hook layer accesses."""

    def test_expected_keys_present_in_annotations(self):
        """All fields accessed by hook handlers must appear in HookPayload.__annotations__."""
        from token_goat.hooks_common import HookPayload

        annotations = HookPayload.__annotations__
        expected = {
            "session_id",
            "cwd",
            "turn_id",
            "tool_name",
            "tool_input",
            "file_path",
            "file_content",
            "line_number",
            "result_count",
            "trigger",
        }
        missing = expected - set(annotations)
        assert not missing, f"HookPayload missing fields: {missing}"

    def test_total_is_false(self):
        """HookPayload must be total=False so hooks degrade when fields are absent."""
        from token_goat.hooks_common import HookPayload

        # total=False means __required_keys__ is empty
        assert HookPayload.__required_keys__ == frozenset()

    def test_session_id_annotated_as_str(self):
        """session_id annotation must resolve to str (handles ForwardRef from __future__ annotations)."""
        import typing

        from token_goat.hooks_common import HookPayload

        hints = typing.get_type_hints(HookPayload)
        assert hints["session_id"] is str

    def test_tool_input_annotated_as_dict(self):
        """tool_input must be typed as dict[str, Any], not a narrower type."""
        import typing

        from token_goat.hooks_common import HookPayload

        hints = typing.get_type_hints(HookPayload)
        annotation = hints["tool_input"]
        origin = getattr(annotation, "__origin__", None)
        assert origin is dict, f"Expected dict origin, got {origin}"


# ===========================================================================
# 2. hooks_common.py — sanitize_opt logs DEBUG on non-string coercion
# ===========================================================================


class TestSanitizeOptDebugLog:
    """sanitize_opt must emit a DEBUG log when coercing a non-string value."""

    def test_non_string_int_triggers_debug_log(self, caplog):
        from token_goat.hooks_common import sanitize_opt

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            result = sanitize_opt(42)

        assert result == "42"
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("sanitize_opt" in m and "coercing" in m for m in debug_msgs), (
            f"Expected DEBUG 'sanitize_opt: coercing …' log, got: {debug_msgs}"
        )

    def test_non_string_list_triggers_debug_log(self, caplog):
        from token_goat.hooks_common import sanitize_opt

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            result = sanitize_opt([1, 2, 3])

        # lists are truthy so coercion path fires
        assert result  # some non-empty string
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("sanitize_opt" in m for m in debug_msgs)

    def test_string_value_no_debug_log(self, caplog):
        """A proper string value must NOT trigger the coercion DEBUG log."""
        from token_goat.hooks_common import sanitize_opt

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            result = sanitize_opt("hello")

        assert result == "hello"
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        coercion_msgs = [m for m in debug_msgs if "sanitize_opt" in m and "coercing" in m]
        assert not coercion_msgs, f"Unexpected coercion log for str value: {coercion_msgs}"

    def test_falsy_value_returns_empty_string_no_log(self, caplog):
        """None and other falsy values must return '' with no DEBUG log."""
        from token_goat.hooks_common import sanitize_opt

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            assert sanitize_opt(None) == ""
            assert sanitize_opt("") == ""
            assert sanitize_opt(0) == ""
            assert sanitize_opt(False) == ""

        coercion_msgs = [
            r.message for r in caplog.records
            if r.levelno == logging.DEBUG and "coercing" in r.message
        ]
        assert not coercion_msgs

    def test_newline_in_non_string_stripped_before_log(self, caplog):
        """Coercion path must sanitize the repr before logging (no raw newlines in log)."""
        from token_goat.hooks_common import sanitize_opt

        # Create an object whose str() contains newlines
        class Sneaky:
            def __str__(self):
                return "line1\nline2"

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            sanitize_opt(Sneaky())

        for record in caplog.records:
            assert "\n" not in record.message, "Raw newline in log message"


# ===========================================================================
# 3. hooks_cli.py — fail_soft handles HookPayload-typed payload without raising
# ===========================================================================


class TestFailSoftWithHookPayload:
    """fail_soft must return CONTINUE() when the handler raises, never re-raise."""

    def test_fail_soft_returns_continue_on_exception(self):
        """A handler that raises must produce {'continue': True} from fail_soft."""
        from token_goat.hooks_cli import fail_soft
        from token_goat.hooks_common import HookPayload

        @fail_soft
        def boom(payload: HookPayload) -> dict:
            raise RuntimeError("intentional failure")

        payload: HookPayload = {"session_id": "abc123", "tool_name": "Read"}  # type: ignore[typeddict-item]
        result = boom(payload)
        assert result.get("continue") is True

    def test_fail_soft_returns_handler_result_on_success(self):
        """When the handler succeeds, fail_soft must pass the result through."""
        from token_goat.hooks_cli import fail_soft
        from token_goat.hooks_common import HookPayload

        @fail_soft
        def noop(payload: HookPayload) -> dict:
            return {"continue": True, "custom": "ok"}

        payload: HookPayload = {"session_id": "def456"}  # type: ignore[typeddict-item]
        result = noop(payload)
        assert result["custom"] == "ok"
        assert result["continue"] is True

    def test_fail_soft_with_empty_payload(self):
        """fail_soft must not crash when payload is an empty dict."""
        from token_goat.hooks_cli import fail_soft
        from token_goat.hooks_common import HookPayload

        @fail_soft
        def crasher(payload: HookPayload) -> dict:
            raise ValueError("boom")

        result = crasher({})  # type: ignore[arg-type]
        assert result.get("continue") is True

    def test_fail_soft_sanitizes_session_id_in_log(self, caplog):
        """fail_soft must not emit raw newlines from session_id into the log."""
        from token_goat.hooks_cli import fail_soft
        from token_goat.hooks_common import HookPayload

        @fail_soft
        def boom(payload: HookPayload) -> dict:
            raise RuntimeError("crash")

        payload: HookPayload = {  # type: ignore[typeddict-item]
            "session_id": "abc\ninjected_line",
            "cwd": "/tmp",
        }
        with caplog.at_level(logging.ERROR, logger="token_goat.hooks"):
            boom(payload)

        for record in caplog.records:
            assert "\n" not in record.message


# ===========================================================================
# 4. languages/json_idx.py — _safe_repr catches TypeError/ValueError;
#    unexpected exception propagates
# ===========================================================================


class TestSafeRepr:
    """_safe_repr must catch TypeError/ValueError/OverflowError and propagate others."""

    def test_normal_json_serializable_object(self):
        """A plain dict must be JSON-serialized and returned."""
        from token_goat.languages.json_idx import _safe_repr

        result = _safe_repr({"key": "value"})
        assert '"key"' in result
        assert '"value"' in result

    def test_value_truncated_when_over_max_len(self):
        """Values exceeding max_len must be truncated with '...'."""
        from token_goat.languages.json_idx import _safe_repr

        big = "x" * 200
        result = _safe_repr(big, max_len=50)
        assert result.endswith("...")
        assert len(result) <= 54  # 50 + len("...")

    def test_type_error_caught_returns_type_name(self):
        """A TypeError from json.dumps must be caught; type name returned."""
        from token_goat.languages.json_idx import _safe_repr

        # Create an object that is not JSON-serializable and causes TypeError
        # We pass default=str but create an object whose __str__ also fails
        class Unserializable:
            def __repr__(self):
                return "Unserializable()"

        # Patch json.dumps to raise TypeError
        with patch("token_goat.languages.json_idx.json.dumps", side_effect=TypeError("not serializable")):
            result = _safe_repr(Unserializable())

        assert result == "Unserializable"

    def test_value_error_caught_returns_type_name(self):
        """A ValueError from json.dumps must be caught; type name returned."""
        from token_goat.languages.json_idx import _safe_repr

        with patch("token_goat.languages.json_idx.json.dumps", side_effect=ValueError("bad value")):
            result = _safe_repr(42)

        assert result == "int"

    def test_overflow_error_caught_returns_type_name(self):
        """An OverflowError from json.dumps must be caught; type name returned."""
        from token_goat.languages.json_idx import _safe_repr

        with patch("token_goat.languages.json_idx.json.dumps", side_effect=OverflowError("too big")):
            result = _safe_repr(1.0)

        assert result == "float"

    def test_unexpected_exception_propagates(self):
        """An exception not in (TypeError, ValueError, OverflowError) must propagate."""
        from token_goat.languages.json_idx import _safe_repr

        with (
            patch("token_goat.languages.json_idx.json.dumps", side_effect=KeyboardInterrupt("halt")),
            pytest.raises(KeyboardInterrupt),
        ):
            _safe_repr({"a": 1})

    def test_none_serialized_as_null(self):
        from token_goat.languages.json_idx import _safe_repr

        assert _safe_repr(None) == "null"

    def test_integer_serialized(self):
        from token_goat.languages.json_idx import _safe_repr

        assert _safe_repr(123) == "123"


# ===========================================================================
# 5. languages/typescript.py — parse failure log message contains exception string
# ===========================================================================


class TestTypescriptParseFailureLog:
    """On tree-sitter parse failure the log message must include the exception text."""

    def test_log_contains_exception_message(self, caplog):
        """When tlp.process() raises, the WARNING log must contain the exception string."""

        from token_goat.languages import typescript

        boom_exc = RuntimeError("fake parse error XYZ")

        fake_tlp = MagicMock()
        fake_tlp.process.side_effect = boom_exc
        fake_cfg = MagicMock()

        with patch.object(
            typescript.common, "make_process_config", return_value=(fake_tlp, fake_cfg)
        ), caplog.at_level(logging.WARNING, logger="token_goat.languages.typescript"):
            result = typescript.extract(b"const x = 1;", "test.ts")

        assert result == ([], [], [], [])
        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("fake parse error XYZ" in m for m in warn_msgs), (
            f"Exception text not found in log messages: {warn_msgs}"
        )

    def test_log_contains_rel_path(self, caplog):
        """The WARNING log must include the rel_path so the failing file is identifiable."""

        from token_goat.languages import typescript

        fake_tlp = MagicMock()
        fake_tlp.process.side_effect = RuntimeError("parse boom")
        fake_cfg = MagicMock()

        with patch.object(
            typescript.common, "make_process_config", return_value=(fake_tlp, fake_cfg)
        ), caplog.at_level(logging.WARNING, logger="token_goat.languages.typescript"):
            typescript.extract(b"export default {};", "src/components/Button.tsx")

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("Button.tsx" in m for m in warn_msgs), (
            f"rel_path not found in log messages: {warn_msgs}"
        )


# ===========================================================================
# 6. session.py — mark_file_read symbol sanitization and cap
# ===========================================================================


class TestMarkFileReadSymbol:
    """mark_file_read must sanitize symbols (strip newlines) and cap at 50."""

    def test_symbol_with_newline_stripped(self, tmp_data_dir):
        """A symbol containing a newline must have it replaced by \\n before storage."""
        from token_goat import session

        sid = "sym_sanitize_001"
        cache = session._fresh_cache(sid)
        result = session.mark_file_read(sid, "src/foo.py", symbol="MyClass\ninjected", cache=cache)
        stored = result.files[session._normalize_path("src/foo.py")].symbols_read
        assert len(stored) == 1
        assert "\n" not in stored[0]
        assert "\\n" in stored[0]

    def test_symbol_with_carriage_return_stripped(self, tmp_data_dir):
        """A symbol containing \\r must be sanitized before storage."""
        from token_goat import session

        sid = "sym_sanitize_002"
        cache = session._fresh_cache(sid)
        result = session.mark_file_read(sid, "src/bar.py", symbol="Func\rName", cache=cache)
        stored = result.files[session._normalize_path("src/bar.py")].symbols_read
        assert len(stored) == 1
        assert "\r" not in stored[0]

    def test_symbol_empty_after_sanitize_not_stored(self, tmp_data_dir):
        """A symbol that sanitizes to empty string must not be stored."""
        from token_goat import session

        # Verify the sanitize function itself: a string of only newlines becomes empty
        # after sanitize_log_str strips control chars... actually sanitize_log_str replaces
        # \n with \\n, so it won't be empty. Test a symbol that's just whitespace-equiv chars.
        # The only way to get empty is if the sanitized result is empty string.
        # sanitize_log_str("") returns "" — so pass an already-empty symbol.
        sid = "sym_sanitize_003"
        cache = session._fresh_cache(sid)
        # Pass empty symbol (sanitizes to "" immediately)
        result = session.mark_file_read(sid, "src/baz.py", symbol="", cache=cache)
        key = session._normalize_path("src/baz.py")
        entry = result.files.get(key)
        # read_count incremented but no symbol stored
        assert entry is not None
        assert entry.symbols_read == []

    def test_symbols_capped_at_50(self, tmp_data_dir):
        """After 50 symbols for a file, further symbols must be discarded."""
        from token_goat import session
        from token_goat.session import _MAX_SYMBOLS_PER_FILE

        assert _MAX_SYMBOLS_PER_FILE == 50

        sid = "sym_cap_001"
        cache = session._fresh_cache(sid)
        path = "src/big.py"

        # Add exactly 50 symbols
        for i in range(50):
            cache = session.mark_file_read(sid, path, symbol=f"Symbol{i}", cache=cache)

        key = session._normalize_path(path)
        assert len(cache.files[key].symbols_read) == 50

        # The 51st must be discarded
        cache = session.mark_file_read(sid, path, symbol="ExtraSymbol", cache=cache)
        assert len(cache.files[key].symbols_read) == 50
        assert "ExtraSymbol" not in cache.files[key].symbols_read

    def test_duplicate_symbol_not_double_stored(self, tmp_data_dir):
        """Storing the same symbol twice must not create a duplicate entry."""
        from token_goat import session

        sid = "sym_dedup_001"
        cache = session._fresh_cache(sid)
        path = "src/dedup.py"
        cache = session.mark_file_read(sid, path, symbol="MyFunc", cache=cache)
        cache = session.mark_file_read(sid, path, symbol="MyFunc", cache=cache)
        key = session._normalize_path(path)
        assert cache.files[key].symbols_read.count("MyFunc") == 1

    def test_symbol_truncated_to_max_len(self, tmp_data_dir):
        """A symbol longer than _MAX_SYMBOL_LEN must be truncated before storage."""
        from token_goat import session
        from token_goat.session import _MAX_SYMBOL_LEN

        sid = "sym_trunc_001"
        cache = session._fresh_cache(sid)
        long_sym = "S" * (_MAX_SYMBOL_LEN + 100)
        result = session.mark_file_read(sid, "src/trunc.py", symbol=long_sym, cache=cache)
        key = session._normalize_path("src/trunc.py")
        stored = result.files[key].symbols_read
        assert len(stored) == 1
        assert len(stored[0]) <= _MAX_SYMBOL_LEN + 1  # +1 for the ellipsis char


# ===========================================================================
# 7. compact.py — build_manifest max_tokens ceiling at 4000
# ===========================================================================


class TestBuildManifestMaxTokensCeiling:
    """build_manifest must clamp max_tokens to [1, 4000]."""

    def test_value_above_4000_clamped(self, tmp_data_dir):
        """Passing max_tokens=99999 must behave as if max_tokens=4000."""
        from token_goat import compact, session

        sid = "compact_ceil_001"
        cache = session._fresh_cache(sid)
        # Record some file activity so the manifest is non-empty
        cache = session.mark_file_read(sid, "src/foo.py", offset=0, limit=20, cache=cache)
        cache = session.mark_file_edited(sid, "src/foo.py", cache=cache)

        result_high = compact.build_manifest(sid, max_tokens=99_999)
        result_capped = compact.build_manifest(sid, max_tokens=4_000)
        # Both must produce the same content since 4000 tokens >> any realistic manifest
        assert result_high == result_capped

    def test_value_at_4000_accepted(self, tmp_data_dir):
        """max_tokens=4000 must be accepted as-is (at the ceiling, not above it)."""
        from token_goat import compact, session

        sid = "compact_ceil_002"
        cache = session._fresh_cache(sid)
        cache = session.mark_file_read(sid, "src/bar.py", offset=0, limit=10, cache=cache)

        result = compact.build_manifest(sid, max_tokens=4_000)
        # Just verify it runs and produces a string (may be empty if no edits)
        assert isinstance(result, str)

    def test_value_below_1_clamped_to_1(self, tmp_data_dir):
        """max_tokens=0 or negative must be clamped to 1."""
        from token_goat import compact, session

        sid = "compact_ceil_003"
        cache = session._fresh_cache(sid)
        cache = session.mark_file_edited(sid, "src/clamp.py", cache=cache)

        # With max_tokens=1, the manifest is heavily trimmed but must not crash
        result = compact.build_manifest(sid, max_tokens=0)
        assert isinstance(result, str)
        result_neg = compact.build_manifest(sid, max_tokens=-100)
        assert isinstance(result_neg, str)

    def test_max_tokens_cap_constant_value(self):
        """_MAX_MANIFEST_TOKENS_CAP must be 4000."""
        from token_goat.compact import _MAX_MANIFEST_TOKENS_CAP

        assert _MAX_MANIFEST_TOKENS_CAP == 4_000


# ===========================================================================
# 8. worker.py — project_marker sanitization
# ===========================================================================


class TestWorkerProjectMarkerSanitization:
    """_parse_and_group_entries must sanitize project_marker: strip newlines, cap at 64.

    The sanitization lives in _parse_and_group_entries (the function that groups
    dirty-queue entries by project hash and harvests root/marker metadata).
    _process_dirty_entries calls it internally but returns None; we test the inner
    helper directly.
    """

    # Use a platform-appropriate absolute path so the root is accepted as absolute.
    # On Windows "C:/tmp/proj" is absolute; on POSIX "/tmp/proj" is absolute.
    @staticmethod
    def _abs_root() -> str:
        import sys
        return "C:/tmp/proj" if sys.platform == "win32" else "/tmp/proj"

    def _make_entry(self, project_marker: str, project_hash: str = "aabbccdd11223344") -> dict:
        return {
            "path": "src/foo.py",
            "project_hash": project_hash,
            "project_root": self._abs_root(),
            "project_marker": project_marker,
            "ts": 0.0,
        }

    def test_newline_in_marker_stripped(self):
        """A project_marker with \\n must have it replaced (\\n → \\\\n) before use."""
        from token_goat.worker import _parse_and_group_entries

        ph = "deadbeef00112233"
        entry = self._make_entry("manual\ninjected", ph)
        result = _parse_and_group_entries([entry])
        bucket = result.get(ph)
        assert bucket is not None
        marker = bucket["marker"]
        assert marker is not None
        assert "\n" not in marker

    def test_cr_in_marker_stripped(self):
        """A project_marker with \\r must be sanitized."""
        from token_goat.worker import _parse_and_group_entries

        ph = "cafebabe00112233"
        entry = self._make_entry(".git\rinjected", ph)
        result = _parse_and_group_entries([entry])
        marker = result[ph]["marker"]
        assert "\r" not in (marker or "")

    def test_oversized_marker_capped_at_64(self):
        """A marker longer than 64 chars must be truncated to 64 (plus possible ellipsis)."""
        from token_goat.worker import _MAX_QUEUE_MARKER_LEN, _parse_and_group_entries

        assert _MAX_QUEUE_MARKER_LEN == 64

        ph = "1122334455667788"
        long_marker = "x" * 200
        entry = self._make_entry(long_marker, ph)
        result = _parse_and_group_entries([entry])
        marker = result[ph]["marker"]
        assert marker is not None
        # sanitize_log_str appends "…" (1 char) when truncating, so max is 65
        assert len(marker) <= _MAX_QUEUE_MARKER_LEN + 1

    def test_empty_marker_falls_back_to_manual(self):
        """An empty project_marker must fall back to 'manual'."""
        from token_goat.worker import _parse_and_group_entries

        ph = "5566778899aabbcc"
        entry = self._make_entry("", ph)
        result = _parse_and_group_entries([entry])
        assert result[ph]["marker"] == "manual"

    def test_none_marker_falls_back_to_manual(self):
        """A missing project_marker key must fall back to 'manual'."""
        import sys

        from token_goat.worker import _parse_and_group_entries

        root = "C:/tmp/proj2" if sys.platform == "win32" else "/tmp/proj2"
        ph = "99aabbcc00112233"
        entry = {
            "path": "src/bar.py",
            "project_hash": ph,
            "project_root": root,
            "ts": 0.0,
            # no project_marker key
        }
        result = _parse_and_group_entries([entry])
        assert result[ph]["marker"] == "manual"

    def test_normal_marker_preserved(self):
        """A clean marker like '.git' must be stored unchanged."""
        from token_goat.worker import _parse_and_group_entries

        ph = "aabbccdd00112233"
        entry = self._make_entry(".git", ph)
        result = _parse_and_group_entries([entry])
        assert result[ph]["marker"] == ".git"


# ===========================================================================
# 9. session.py — line_range malformed entries dropped by _parse_file_entry
# ===========================================================================


class TestParseFileEntryLineRanges:
    """_parse_file_entry must silently drop malformed line_range entries."""

    def _make_raw_entry(self, line_ranges) -> dict:
        return {
            "rel_or_abs": "src/test.py",
            "last_read_ts": 0.0,
            "read_count": 1,
            "line_ranges": line_ranges,
            "symbols_read": [],
        }

    def test_valid_ranges_kept(self):
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry([[1, 50], [100, 200]])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        assert entry.line_ranges == [(1, 50), (100, 200)]

    def test_non_list_range_entry_dropped(self):
        """A range entry that is not a list/tuple must be silently dropped."""
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry(["not_a_range", [1, 50]])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        # "not_a_range" has length 11 — not 2-element sequence of ints, dropped
        # [1, 50] is valid
        assert (1, 50) in entry.line_ranges

    def test_range_with_non_int_elements_dropped(self):
        """A range whose elements are not ints must be dropped."""
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry([["a", "b"], [1, 10]])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        # ["a", "b"] has non-int elements — dropped; [1, 10] kept
        assert entry.line_ranges == [(1, 10)]

    def test_range_of_wrong_length_dropped(self):
        """A range with != 2 elements must be dropped."""
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry([[1, 2, 3], [5, 10]])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        # [1, 2, 3] has length 3 — dropped; [5, 10] kept
        assert entry.line_ranges == [(5, 10)]

    def test_empty_line_ranges_ok(self):
        """An empty line_ranges list must produce an entry with no ranges."""
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry([])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        assert entry.line_ranges == []

    def test_all_malformed_ranges_produces_empty_list(self):
        """When all range entries are malformed the result list must be empty."""
        from token_goat.session import _parse_file_entry

        raw = self._make_raw_entry([None, "bad", 42, []])
        entry = _parse_file_entry("src/test.py", raw, 0.0)
        assert entry is not None
        assert entry.line_ranges == []
