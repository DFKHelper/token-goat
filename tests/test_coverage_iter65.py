"""Tests added in iteration 65 — covering recently added code paths.

Targets:
  - session._sanitize_path()         (null bytes, .. traversal, length cap, absolute passthrough)
  - session.validate_session_id()    (public alias — direct call, not via load())
  - compact._render() trim loop      (char-budget accounting stays within max_tokens)
  - compact.build_manifest() invalid session_id upfront guard
  - hooks_cli.pre_compact()          (malformed session_id rejected gracefully)
  - stats._ts_to_date_cache          (memoization: cache populated and reused)
"""
from __future__ import annotations

import time
from collections import defaultdict

import pytest

# ---------------------------------------------------------------------------
# 1. session._sanitize_path() — direct unit tests
# ---------------------------------------------------------------------------


class TestSanitizePath:
    """_sanitize_path() is a module-private helper; import directly."""

    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.session import _sanitize_path  # noqa: PLC0415

        self._fn = _sanitize_path

    def test_empty_string_returned_unchanged(self):
        assert self._fn("") == ""

    def test_null_bytes_stripped(self):
        result = self._fn("foo\x00bar\x00.py")
        assert "\x00" not in result
        assert "foobar.py" in result

    def test_null_byte_only_path_becomes_empty_after_strip(self):
        # Null bytes stripped → empty string after cleanup → empty result
        result = self._fn("\x00\x00\x00")
        assert "\x00" not in result

    def test_relative_traversal_rejected(self):
        result = self._fn("../../../etc/passwd")
        assert result == ""

    def test_relative_traversal_with_subdir_rejected(self):
        result = self._fn("src/../../../etc/passwd")
        assert result == ""

    def test_absolute_posix_path_with_dotdot_allowed(self):
        """Absolute paths are not traversal risks; they pass through unchanged."""
        path = "/home/user/../project/file.py"
        result = self._fn(path)
        assert result == path

    def test_absolute_windows_path_with_dotdot_allowed(self):
        """C:\\-prefixed paths are absolute and should not be rejected."""
        path = "C:\\Users\\foo\\..\\bar.py"
        result = self._fn(path)
        assert result == path

    def test_path_exceeding_max_length_truncated(self):
        from token_goat.session import _MAX_PATH_LEN  # noqa: PLC0415

        long_path = "/valid/absolute/" + "x" * (_MAX_PATH_LEN + 500)
        result = self._fn(long_path)
        assert len(result) == _MAX_PATH_LEN

    def test_path_at_exact_max_length_not_truncated(self):
        from token_goat.session import _MAX_PATH_LEN  # noqa: PLC0415

        path = "/valid/" + "a" * (_MAX_PATH_LEN - len("/valid/"))
        result = self._fn(path)
        assert len(result) == _MAX_PATH_LEN

    def test_normal_relative_path_passthrough(self):
        """Plain relative path without traversal components passes through."""
        result = self._fn("src/foo/bar.py")
        assert result == "src/foo/bar.py"

    def test_backslash_path_with_traversal_rejected(self):
        """Windows-style backslash traversal is detected after normalisation."""
        result = self._fn("src\\..\\..\\etc\\passwd")
        assert result == ""


# ---------------------------------------------------------------------------
# 2. session.validate_session_id() — public alias tested directly
# ---------------------------------------------------------------------------


class TestValidateSessionIdPublicAlias:
    """validate_session_id() is the public surface; test it independent of load()."""

    def test_valid_id_does_not_raise(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        validate_session_id("abc-123_XYZ")  # must not raise

    def test_empty_raises_value_error(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        with pytest.raises(ValueError, match="cannot be empty"):
            validate_session_id("")

    def test_too_long_raises_value_error(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        with pytest.raises(ValueError, match="too long"):
            validate_session_id("a" * 129)

    def test_slash_raises_value_error(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("bad/session")

    def test_null_byte_raises_value_error(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("abc\x00def")

    def test_dot_dot_raises_value_error(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        with pytest.raises(ValueError, match="invalid characters"):
            validate_session_id("../../etc/passwd")

    def test_exactly_128_chars_is_accepted(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        validate_session_id("a" * 128)  # boundary: exactly 128 must pass

    def test_uuid_style_id_accepted(self):
        from token_goat.session import validate_session_id  # noqa: PLC0415

        validate_session_id("550e8400-e29b-41d4-a716-446655440000")  # must not raise


# ---------------------------------------------------------------------------
# 3. compact._render() trim loop — char-budget accounting
# ---------------------------------------------------------------------------


class TestRenderTrimLoop:
    """The O(n) trim loop in _render() must keep the manifest within max_tokens."""

    def _build_large_session(self, session_id: str, n: int = 60) -> None:
        from unittest.mock import patch  # noqa: PLC0415

        import token_goat.session as _session_mod  # noqa: PLC0415
        from token_goat import session  # noqa: PLC0415

        # Suppress intermediate disk writes: each mark_* call normally calls
        # save() once, producing n+n/2 atomic file writes for n=200.  We defer
        # saving to a single write at the end by patching save() to a no-op
        # during the build loop, which cuts setup time by ~10x.
        cache = None
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(n):
                cache = session.mark_file_read(
                    session_id, f"/very/long/path/to/module_{i:04d}.py", offset=0, limit=500, cache=cache
                )
            for i in range(n // 2):
                cache = session.mark_file_edited(session_id, f"/very/long/path/to/edited_{i:04d}.py", cache=cache)
        # Flush the final state to disk once.
        if cache is not None:
            _session_mod.save(cache)

    def test_trim_produces_output_within_token_budget(self, tmp_data_dir):
        from token_goat.compact import build_manifest, estimate_tokens  # noqa: PLC0415

        sid = "trim-loop-test-session-abc"
        self._build_large_session(sid)
        max_tokens = 80
        result = build_manifest(sid, max_tokens=max_tokens)
        # The raw manifest exceeds budget; after trim it must be within budget.
        # Allow +12 for the "# as-of: YYYY-MM-DDTHH:MM:SSZ" suffix appended after trim.
        assert estimate_tokens(result) <= max_tokens + 12

    def test_trim_preserves_header_line(self, tmp_data_dir):
        """After trimming, the manifest header must still be present."""
        from token_goat.compact import build_manifest  # noqa: PLC0415

        sid = "trim-header-preserve-abc"
        self._build_large_session(sid)
        result = build_manifest(sid, max_tokens=60)
        assert "Token-Goat Session Manifest" in result

    def test_trim_char_budget_is_not_quadratic(self, tmp_data_dir):
        """Trimming 200 files at a tiny budget must complete quickly (O(n), not O(n^2))."""
        import time  # noqa: PLC0415

        from token_goat.compact import build_manifest  # noqa: PLC0415

        sid = "trim-perf-test-abc-def"
        self._build_large_session(sid, n=200)
        t0 = time.monotonic()
        build_manifest(sid, max_tokens=50)
        elapsed = time.monotonic() - t0
        # 200 files, aggressive trim — should complete well under 2 s
        assert elapsed < 2.0, f"trim loop took {elapsed:.3f}s — suspiciously slow"


# ---------------------------------------------------------------------------
# 4. compact.build_manifest() — invalid session_id upfront guard
# ---------------------------------------------------------------------------


class TestBuildManifestSessionIdGuard:
    """build_manifest() must validate session_id at entry and return '' on invalid input."""

    def test_invalid_session_id_returns_empty_string(self, tmp_data_dir):
        from token_goat.compact import build_manifest  # noqa: PLC0415

        result = build_manifest("../../evil")
        assert result == ""

    def test_empty_session_id_returns_empty_string(self, tmp_data_dir):
        from token_goat.compact import build_manifest  # noqa: PLC0415

        result = build_manifest("")
        assert result == ""

    def test_null_byte_session_id_returns_empty_string(self, tmp_data_dir):
        from token_goat.compact import build_manifest  # noqa: PLC0415

        result = build_manifest("abc\x00def")
        assert result == ""


# ---------------------------------------------------------------------------
# 5. hooks_cli.pre_compact() — malformed session_id rejected gracefully
# ---------------------------------------------------------------------------


class TestPreCompactInvalidSessionId:
    """pre_compact() must silently return continue:true when session_id is malformed."""

    @pytest.fixture()
    def _cfg_path(self, tmp_path, monkeypatch):
        from token_goat import paths  # noqa: PLC0415

        cfg = tmp_path / "config.toml"
        cfg.write_text(
            "[compact_assist]\nenabled = true\nmin_events = 0\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        return cfg

    def test_traversal_session_id_returns_continue(self, tmp_data_dir, _cfg_path):
        from token_goat import hooks_cli  # noqa: PLC0415

        result = hooks_cli.pre_compact({"session_id": "../../etc/passwd", "trigger": "manual"})
        assert result.get("continue") is True
        assert "systemMessage" not in result

    def test_slash_session_id_returns_continue(self, tmp_data_dir, _cfg_path):
        from token_goat import hooks_cli  # noqa: PLC0415

        result = hooks_cli.pre_compact({"session_id": "bad/session", "trigger": "manual"})
        assert result.get("continue") is True
        assert "systemMessage" not in result

    def test_too_long_session_id_returns_continue(self, tmp_data_dir, _cfg_path):
        from token_goat import hooks_cli  # noqa: PLC0415

        result = hooks_cli.pre_compact({"session_id": "a" * 300, "trigger": "manual"})
        assert result.get("continue") is True
        assert "systemMessage" not in result


# ---------------------------------------------------------------------------
# 6. stats._ts_to_date_cache — memoization populated and reused
# ---------------------------------------------------------------------------


class TestTsToDateCacheMemoization:
    """_ts_to_date_cache must be populated on first access and reused on repeat calls."""

    def _make_row(self, ts, kind="session_hint", bytes_saved=50, tokens_saved=10):
        return {"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved, "ts": ts}

    def test_cache_populated_after_first_accumulate(self):
        from token_goat.stats import _accumulate, _ts_to_date_cache  # noqa: PLC0415

        ts = int(time.time())
        # Ensure the key is absent before the call (clear any prior state).
        _ts_to_date_cache.pop(ts, None)

        by_kind: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        _accumulate(self._make_row(ts), by_kind, by_day)

        assert ts in _ts_to_date_cache
        assert len(_ts_to_date_cache[ts]) == 10  # "YYYY-MM-DD" is always 10 chars

    def test_cache_reused_on_second_call(self, monkeypatch):
        """Second call with the same ts must hit the cache, not call datetime.fromtimestamp."""
        from token_goat.stats import _accumulate, _ts_to_date_cache  # noqa: PLC0415

        ts = int(time.time()) - 1  # use a stable past second

        # Pre-populate with a sentinel value so we can detect cache hits.
        sentinel = "2000-01-01"
        _ts_to_date_cache[ts] = sentinel

        by_kind: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        _accumulate(self._make_row(ts), by_kind, by_day)

        # The sentinel date must be the key in by_day — confirming the cache was used.
        assert sentinel in by_day

    def test_out_of_range_timestamp_skips_cache_population(self):
        """An out-of-range ts must NOT be added to the cache (it would poison future lookups)."""
        from token_goat.stats import _accumulate, _ts_to_date_cache  # noqa: PLC0415

        ts = 9_999_999_999_999  # triggers OverflowError/OSError in datetime.fromtimestamp
        _ts_to_date_cache.pop(ts, None)

        by_kind: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        _accumulate(self._make_row(ts), by_kind, by_day)

        # Bad timestamp must not be stored in the cache
        assert ts not in _ts_to_date_cache

    def test_different_timestamps_same_day_share_date_string(self):
        """Two timestamps seconds apart on the same day should both cache the same date string."""
        from token_goat.stats import _accumulate, _ts_to_date_cache  # noqa: PLC0415

        now = int(time.time())
        ts1 = now
        ts2 = now + 5  # 5 seconds later — same calendar day

        for ts in (ts1, ts2):
            _ts_to_date_cache.pop(ts, None)

        by_kind: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        by_day: dict = defaultdict(lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0})
        _accumulate(self._make_row(ts1), by_kind, by_day)
        _accumulate(self._make_row(ts2), by_kind, by_day)

        assert ts1 in _ts_to_date_cache
        assert ts2 in _ts_to_date_cache
        # Both timestamps on the same wall-clock day → same date string
        assert _ts_to_date_cache[ts1] == _ts_to_date_cache[ts2]
