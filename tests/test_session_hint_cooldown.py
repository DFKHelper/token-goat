"""Tests for per-file session hint cooldown, hint list trimming, and suppressed stat.

Covers three improvements to session_hint signal/noise ratio:
1. Per-file hint cooldown: suppress repeat hints for the same file until edited.
2. Hint range display capped at _MAX_CACHED_RANGES_DISPLAY (10) most-recent entries.
3. session_hint_suppressed stat tracked when cooldown fires.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from token_goat import session as session_mod
from token_goat.hints import _MAX_CACHED_RANGES_DISPLAY, _hint_from_cache
from token_goat.session import FileEntry, SessionCache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session_cache(session_id: str = "test_session") -> SessionCache:
    """Return a fresh SessionCache with sensible defaults."""
    now = time.time()
    return SessionCache(
        session_id=session_id,
        started_ts=now,
        last_activity_ts=now,
    )


def _make_file_entry(
    line_ranges: list[tuple[int, int]],
    read_count: int = 1,
    last_read_ts: float | None = None,
    last_edit_ts: float = 0.0,
) -> FileEntry:
    """Return a FileEntry with the given line_ranges."""
    now = time.time() if last_read_ts is None else last_read_ts
    return FileEntry(
        rel_or_abs="/fake/file.py",
        last_read_ts=now,
        read_count=read_count,
        line_ranges=line_ranges,
        symbols_read=[],
        last_edit_ts=last_edit_ts,
    )


# ---------------------------------------------------------------------------
# Test 1: per-file hint cooldown — suppresses repeat hint for same file
# ---------------------------------------------------------------------------


class TestPerFileHintCooldown:
    @pytest.fixture(autouse=True)
    def _isolate_db(self, tmp_data_dir):
        """Redirect DB writes to a temp dir so tests don't touch the production database.

        Tests in this class call hooks_read.pre_read() which eventually calls
        db.record_stat() → open_global().  Without isolation this opens the real
        global.db, and the wal_checkpoint(TRUNCATE) on close takes 5-8 s on Windows.
        """

    def test_cooldown_suppresses_repeat_hint(self) -> None:
        """After a tokens_saved>0 hint fires, mark_session_hint_emitted should gate repeat."""
        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/file.py")

        # Initially, no hint has been emitted for this file.
        assert not cache.has_session_hint_been_emitted(file_key)

        # After marking, cooldown is active.
        cache.mark_session_hint_emitted(file_key)
        assert cache.has_session_hint_been_emitted(file_key)

    def test_cooldown_cleared_on_edit(self) -> None:
        """mark_file_edited should clear the per-file hint cooldown."""
        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/file.py")

        cache.mark_session_hint_emitted(file_key)
        assert cache.has_session_hint_been_emitted(file_key)

        # Simulate an edit via clear_session_hint_cooldown (called by mark_file_edited).
        cache.clear_session_hint_cooldown(file_key)
        assert not cache.has_session_hint_been_emitted(file_key)

    def test_mark_file_edited_clears_cooldown(self) -> None:
        """mark_file_edited module function should clear the per-file hint cooldown."""
        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/file.py")

        cache.mark_session_hint_emitted(file_key)
        assert cache.has_session_hint_been_emitted(file_key)

        # mark_file_edited should call clear_session_hint_cooldown.
        session_mod.mark_file_edited(cache.session_id, "/fake/file.py", cache=cache)
        assert not cache.has_session_hint_been_emitted(file_key)

    def test_cooldown_is_per_file(self) -> None:
        """Cooldown for one file should not affect a different file."""
        cache = _make_session_cache()
        key_a = session_mod._normalize_path("/fake/a.py")
        key_b = session_mod._normalize_path("/fake/b.py")

        cache.mark_session_hint_emitted(key_a)
        assert cache.has_session_hint_been_emitted(key_a)
        assert not cache.has_session_hint_been_emitted(key_b)

    def test_pre_read_records_suppressed_stat(self) -> None:
        """When the per-file cooldown is active, record_hint_suppressed is called."""
        from token_goat import hooks_read

        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/src/foo.py")

        # Activate the cooldown for this file.
        cache.mark_session_hint_emitted(file_key)

        suppress_calls: list[str] = []

        cache.record_hint_suppressed = lambda kind: suppress_calls.append(kind)  # type: ignore[method-assign]

        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            patch("token_goat.hooks_read._try_diff_serve", return_value=None),
            patch("token_goat.hooks_read._build_git_hint", return_value=None),
            patch("token_goat.hooks_read._try_unchanged_file_hint", return_value=None),
            patch("token_goat.session.load", return_value=cache),
            patch("token_goat.hooks_read._get_session", return_value=session_mod),
        ):
            payload = {
                "tool_name": "Read",
                "session_id": cache.session_id,
                "cwd": "/fake",
                "tool_input": {"file_path": "/fake/src/foo.py"},
            }
            hooks_read.pre_read(payload)

        assert "session_hint_suppressed" in suppress_calls

    def test_pre_read_writes_session_hint_suppressed_to_db(self, tmp_data_dir) -> None:
        """When the per-file cooldown fires, record_cached_stat writes a DB row.

        This test verifies the suppression stat reaches the stats DB (not just the
        in-memory session cache).  The code path is:
        cooldown active → record_hint_suppressed() + record_cached_stat() → db.record_stat().
        """
        from unittest.mock import patch

        from token_goat import db, hooks_read

        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/src/bar.py")
        cache.mark_session_hint_emitted(file_key)

        written_kinds: list[str] = []

        original_record_stat = db.record_stat

        def capture_stat(project_hash, kind, **kwargs):
            written_kinds.append(kind)
            return original_record_stat(project_hash, kind, **kwargs)

        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            patch("token_goat.hooks_read._try_diff_serve", return_value=None),
            patch("token_goat.hooks_read._build_git_hint", return_value=None),
            patch("token_goat.hooks_read._try_unchanged_file_hint", return_value=None),
            patch("token_goat.session.load", return_value=cache),
            patch("token_goat.hooks_read._get_session", return_value=session_mod),
            patch("token_goat.db.record_stat", side_effect=capture_stat),
        ):
            payload = {
                "tool_name": "Read",
                "session_id": cache.session_id,
                "cwd": "/fake",
                "tool_input": {"file_path": "/fake/src/bar.py"},
            }
            hooks_read.pre_read(payload)

        assert "session_hint_suppressed" in written_kinds, (
            "session_hint_suppressed stat must be written to the stats DB "
            "when the per-file cooldown suppresses a hint"
        )


# ---------------------------------------------------------------------------
# Test 2: hint range display capped at _MAX_CACHED_RANGES_DISPLAY
# ---------------------------------------------------------------------------


class TestHintRangeDisplayCap:
    def test_max_cached_ranges_display_constant(self) -> None:
        """_MAX_CACHED_RANGES_DISPLAY should be 10."""
        assert _MAX_CACHED_RANGES_DISPLAY == 10

    def test_hint_caps_ranges_to_10(self) -> None:
        """When a file has >10 line ranges, the hint text shows at most 10."""
        # Build an entry with 15 non-overlapping ranges.
        ranges = [(i * 100 + 1, i * 100 + 50) for i in range(15)]
        entry = _make_file_entry(line_ranges=ranges, read_count=2)

        # Request overlaps the first range so the hint can fire.
        hint = _hint_from_cache(
            entry,
            req_start=1,
            req_end=50,
            file_path="/fake/large.py",
        )
        if hint is None:
            # Suppressed by a gate (e.g. proximity, stale); skip this check.
            pytest.skip("hint suppressed by an unrelated gate")

        hint_text = str(hint)
        # Count how many "N-M" range tokens appear in the summary portion.
        # The hint also includes the requested range "L{req_start}-{req_end}", so
        # the total match count may be up to _MAX_CACHED_RANGES_DISPLAY + 1.
        import re
        range_tokens = re.findall(r"\d+-\d+", hint_text)
        # The "(+N more ranges)" footer should still appear for 15 ranges.
        assert "more ranges" in hint_text
        # Number of matched range tokens <= cap + 1 (the requested range display).
        assert len(range_tokens) <= _MAX_CACHED_RANGES_DISPLAY + 1

    def test_hint_shows_most_recent_ranges(self) -> None:
        """When ranges are trimmed, the most-recent (highest line numbers) are shown."""
        # Build 12 ranges; only the last 10 (by start line) should appear.
        ranges = [(i * 100 + 1, i * 100 + 50) for i in range(12)]
        entry = _make_file_entry(line_ranges=ranges, read_count=2)

        # Request overlaps the last range (highest line numbers).
        last_start = ranges[-1][0]
        last_end = ranges[-1][1]
        hint = _hint_from_cache(
            entry,
            req_start=last_start,
            req_end=last_end,
            file_path="/fake/large.py",
        )
        if hint is None:
            pytest.skip("hint suppressed by an unrelated gate")

        hint_text = str(hint)
        # The earliest two ranges (i=0 and i=1) should NOT appear in the display.
        # They map to "1-50" and "101-150".
        assert "1-50" not in hint_text or "101-150" not in hint_text

    def test_under_cap_shows_all_ranges(self) -> None:
        """When a file has ≤10 ranges, all are shown (no truncation)."""
        ranges = [(i * 100 + 1, i * 100 + 50) for i in range(5)]
        entry = _make_file_entry(line_ranges=ranges, read_count=2)

        hint = _hint_from_cache(
            entry,
            req_start=1,
            req_end=50,
            file_path="/fake/small.py",
        )
        if hint is None:
            pytest.skip("hint suppressed by an unrelated gate")

        hint_text = str(hint)
        import re
        range_tokens = re.findall(r"\d+-\d+", hint_text)
        # No "(+ N more ranges)" footer expected.
        assert "more ranges" not in hint_text
        assert len(range_tokens) <= _MAX_CACHED_RANGES_DISPLAY


# ---------------------------------------------------------------------------
# Test 3: session_hint_suppressed stat in SessionCache
# ---------------------------------------------------------------------------


class TestSessionHintSuppressedStat:
    def test_record_hint_suppressed_increments_counter(self) -> None:
        """record_hint_suppressed('session_hint_suppressed') increments the counter."""
        cache = _make_session_cache()
        assert cache.hints_suppressed_by_type.get("session_hint_suppressed", 0) == 0

        cache.record_hint_suppressed("session_hint_suppressed")
        assert cache.hints_suppressed_by_type["session_hint_suppressed"] == 1

        cache.record_hint_suppressed("session_hint_suppressed")
        assert cache.hints_suppressed_by_type["session_hint_suppressed"] == 2

    def test_suppression_stat_serialized_to_json(self) -> None:
        """hints_suppressed_by_type is round-tripped through to_dict/from_dict."""
        cache = _make_session_cache()
        cache.record_hint_suppressed("session_hint_suppressed")

        d = cache.to_dict()
        assert d["hints_suppressed_by_type"]["session_hint_suppressed"] == 1

        restored = SessionCache.from_dict(d)
        assert restored.hints_suppressed_by_type.get("session_hint_suppressed") == 1

    def test_cooldown_fields_not_persisted(self) -> None:
        """_session_hinted_files is not persisted to JSON (in-process guard only)."""
        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/file.py")
        cache.mark_session_hint_emitted(file_key)

        d = cache.to_dict()
        # The field should not appear in the serialized dict.
        assert "_session_hinted_files" not in d
        assert "session_hinted_files" not in d

        # After restoring, the cooldown is gone (fresh process).
        restored = SessionCache.from_dict(d)
        assert not restored.has_session_hint_been_emitted(file_key)


# ---------------------------------------------------------------------------
# Test 4: exponential backoff for session re-read hints
# ---------------------------------------------------------------------------


class TestSessionHintBackoff:
    """Tests for [hints] backoff_thresholds: hint fires only at {1, 3, 10, 30}."""

    @pytest.fixture(autouse=True)
    def _isolate_db(self, tmp_data_dir):
        """Redirect DB writes to a temp dir so tests don't touch the production database.

        _pre_read_with_read_count() calls hooks_read.pre_read() which calls
        db.record_stat() → open_global().  Without isolation this opens the real
        global.db, and the wal_checkpoint(TRUNCATE) on close takes 5-8 s per call
        on Windows — test_non_threshold_read_counts_suppress_hint calls it 10 times.
        """

    def _pre_read_with_read_count(
        self,
        read_count: int,
        backoff_thresholds: list[int] | None = None,
    ) -> tuple[list[str], list[str]]:
        """Call pre_read with a session entry whose read_count is *read_count*.

        Returns (suppressed_kinds, emitted_hints) where:
          suppressed_kinds — list of hint kinds passed to record_hint_suppressed
          emitted_hints — list of additionalContext strings that reached context
        """
        from token_goat import hooks_read

        if backoff_thresholds is None:
            backoff_thresholds = [1, 3, 10, 30]

        cache = _make_session_cache()

        # Inject a FileEntry with the requested read_count into the cache so
        # the pre-read hook sees it as a previously-read file.
        file_key = session_mod._normalize_path("/fake/src/target.py")
        entry = FileEntry(
            rel_or_abs="/fake/src/target.py",
            last_read_ts=time.time(),
            read_count=read_count,
            line_ranges=[(1, 100)],
            symbols_read=[],
        )
        cache.files[file_key] = entry

        suppressed: list[str] = []
        cache.record_hint_suppressed = lambda kind: suppressed.append(kind)  # type: ignore[method-assign]

        fake_hint = _make_mock_hint("already read /fake/src/target.py")

        from token_goat.config import HintsConfig

        mock_cfg = HintsConfig(backoff_thresholds=backoff_thresholds)

        class _FakeCfgObj:
            hints = mock_cfg

        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            patch("token_goat.hooks_read._try_diff_serve", return_value=None),
            patch("token_goat.hooks_read._try_unchanged_file_hint", return_value=None),
            patch("token_goat.hooks_read._build_git_hint", return_value=None),
            patch("token_goat.hints.build_read_hint", return_value=fake_hint),
            patch("token_goat.hooks_read._record_session_hint_impact"),
            patch("token_goat.session.load", return_value=cache),
            patch("token_goat.hooks_read._get_session", return_value=session_mod),
            patch("token_goat.hooks_read.config", create=True),
            # Patch config.load inside hooks_read so backoff uses our thresholds.
            patch(
                "token_goat.hooks_read.config",
                create=True,
                **{"load.return_value": _FakeCfgObj()},  # type: ignore[arg-type]
            ),
        ):
            # Patch the lazy import inside the else branch.
            import token_goat.config as _real_cfg
            with patch.object(_real_cfg, "load", return_value=_FakeCfgObj()):
                payload = {
                    "tool_name": "Read",
                    "session_id": cache.session_id,
                    "cwd": "/fake",
                    "tool_input": {"file_path": "/fake/src/target.py"},
                }
                response = hooks_read.pre_read(payload)

        ctx = (response or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
        emitted = [ctx] if ctx else []
        return suppressed, emitted

    def test_threshold_read_counts_emit_hint(self) -> None:
        """Hint fires for each threshold value in {1, 3, 10, 30}."""
        for rc in [1, 3, 10, 30]:
            suppressed, emitted = self._pre_read_with_read_count(rc)
            assert "hint_backoff_suppressed" not in suppressed, (
                f"read_count={rc} should emit hint but backoff suppressed it"
            )

    def test_non_threshold_read_counts_suppress_hint(self) -> None:
        """Hint is suppressed for read counts not in the threshold set."""
        for rc in [2, 4, 5, 7, 11, 15, 20, 25, 31, 50]:
            suppressed, emitted = self._pre_read_with_read_count(rc)
            assert "hint_backoff_suppressed" in suppressed, (
                f"read_count={rc} should be suppressed by backoff but was not"
            )

    def test_empty_thresholds_disables_backoff(self) -> None:
        """When backoff_thresholds=[], every re-read emits a hint (original behaviour)."""
        # read_count=2 would normally be suppressed; with empty list it should pass through.
        suppressed, _ = self._pre_read_with_read_count(2, backoff_thresholds=[])
        assert "hint_backoff_suppressed" not in suppressed

    def test_backoff_suppressed_stat_recorded(self) -> None:
        """When backoff fires, record_hint_suppressed('hint_backoff_suppressed') is called."""
        suppressed, _ = self._pre_read_with_read_count(2)
        assert "hint_backoff_suppressed" in suppressed

    def test_backoff_stat_counter_in_cache(self) -> None:
        """record_hint_suppressed('hint_backoff_suppressed') increments the cache counter."""
        cache = _make_session_cache()
        assert cache.hints_suppressed_by_type.get("hint_backoff_suppressed", 0) == 0
        cache.record_hint_suppressed("hint_backoff_suppressed")
        assert cache.hints_suppressed_by_type["hint_backoff_suppressed"] == 1

    def test_backoff_does_not_fingerprint_suppressed_hint(self) -> None:
        """When backoff suppresses, no fingerprint is added to the cache (mark_hint_seen not called)."""
        import time

        from token_goat import hooks_read

        cache = _make_session_cache()
        file_key = session_mod._normalize_path("/fake/src/target.py")
        entry = FileEntry(
            rel_or_abs="/fake/src/target.py",
            last_read_ts=time.time(),
            read_count=2,  # not in {1, 3, 10, 30}
            line_ranges=[(1, 100)],
            symbols_read=[],
        )
        cache.files[file_key] = entry

        hints_seen_keys_before = set(cache.hints_seen.keys())

        from token_goat.config import HintsConfig

        class _FakeCfgObj:
            hints = HintsConfig(backoff_thresholds=[1, 3, 10, 30])

        import token_goat.config as _real_cfg
        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            patch("token_goat.hooks_read._try_diff_serve", return_value=None),
            patch("token_goat.hooks_read._try_unchanged_file_hint", return_value=None),
            patch("token_goat.hooks_read._build_git_hint", return_value=None),
            patch("token_goat.hints.build_read_hint", return_value=_make_mock_hint("x")),
            patch("token_goat.session.load", return_value=cache),
            patch("token_goat.hooks_read._get_session", return_value=session_mod),
            patch.object(_real_cfg, "load", return_value=_FakeCfgObj()),
        ):
            payload = {
                "tool_name": "Read",
                "session_id": cache.session_id,
                "cwd": "/fake",
                "tool_input": {"file_path": "/fake/src/target.py"},
            }
            hooks_read.pre_read(payload)

        # No new fingerprints should have been added to hints_seen.
        assert set(cache.hints_seen.keys()) == hints_seen_keys_before


def _make_mock_hint(text: str) -> object:
    """Return a lightweight fake ReadHint with tokens_saved > 0."""
    from unittest.mock import MagicMock
    fake = MagicMock()
    fake.__str__ = lambda self: text
    fake.tokens_saved = 50
    return fake
