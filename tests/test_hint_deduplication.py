"""Tests for hint-seen deduplication in session cache."""
from __future__ import annotations

from token_goat import session
from token_goat.hints import ReadHint, _hint_fingerprint


class TestHintFingerprint:
    """Tests for _hint_fingerprint function."""

    def test_fingerprint_is_deterministic(self) -> None:
        """Same hint text produces same fingerprint."""
        hint_text = "This is a test hint about file.py"
        fp1 = _hint_fingerprint(hint_text)
        fp2 = _hint_fingerprint(hint_text)
        assert fp1 == fp2

    def test_fingerprint_length(self) -> None:
        """Fingerprint is 12 hex characters."""
        hint_text = "Some hint"
        fp = _hint_fingerprint(hint_text)
        assert len(fp) == 12
        assert all(c in "0123456789abcdef" for c in fp)

    def test_different_text_different_fingerprint(self) -> None:
        """Different hint text produces different fingerprints."""
        fp1 = _hint_fingerprint("Hint one")
        fp2 = _hint_fingerprint("Hint two")
        assert fp1 != fp2

    def test_fingerprint_handles_unicode(self) -> None:
        """Fingerprint works with unicode text."""
        hint_text = "File 📁 cached 🚀"
        fp = _hint_fingerprint(hint_text)
        assert len(fp) == 12


class TestSessionCacheHintMethods:
    """Tests for SessionCache hint tracking methods."""

    def test_has_hint_fingerprint_empty_by_default(self) -> None:
        """New cache has no hints seen."""
        cache = session.SessionCache("test_session", 0, 0)
        assert not cache.has_hint_fingerprint("abc123def456")

    def test_mark_hint_seen_records_fingerprint(self, tmp_data_dir) -> None:
        """mark_hint_seen adds fingerprint to hints_seen set."""
        cache = session.SessionCache("test_session", 0, 0)
        fp = "abc123def456"

        # Initially not seen
        assert not cache.has_hint_fingerprint(fp)

        # Mark as seen
        cache.mark_hint_seen(fp)

        # Now it's seen
        assert cache.has_hint_fingerprint(fp)

    def test_mark_hint_seen_idempotent(self, tmp_data_dir) -> None:
        """Calling mark_hint_seen twice with same fingerprint increments count."""
        cache = session.SessionCache("test_session", 0, 0)
        fp = "abc123def456"

        # Mark twice
        cache.mark_hint_seen(fp)
        cache.mark_hint_seen(fp)

        # Still in the dict, count incremented to 2
        assert cache.has_hint_fingerprint(fp)
        assert cache.hints_seen[fp] == 2

    def test_mark_hint_seen_persists_to_disk(self, tmp_data_dir) -> None:
        """mark_hint_seen updates in-memory state; save() flushes to disk."""
        session_id = "test_session_persist"

        # Create and mark hint — sets _pending_hint_save but does NOT write yet
        cache1 = session.SessionCache(session_id, 0, 0)
        fp = "abc123def456"
        cache1.mark_hint_seen(fp)
        assert cache1._pending_hint_save, "Flag must be set after mark_hint_seen"

        # Explicitly flush (simulates what pre_read or mark_file_read does)
        cache1._pending_hint_save = False
        session.save(cache1)

        # Reload from disk
        cache2 = session.load(session_id)

        # Fingerprint should be present
        assert cache2.has_hint_fingerprint(fp)

    def test_hints_seen_serialization_round_trip(self) -> None:
        """hints_seen serializes to JSON and deserializes correctly."""
        cache = session.SessionCache("test_session", 0, 0)
        cache.hints_seen["abc123def456"] = 1
        cache.hints_seen["xyz789uvw012"] = 2

        # Serialize
        d = cache.to_dict()
        assert "hints_seen" in d
        assert isinstance(d["hints_seen"], dict)
        assert len(d["hints_seen"]) == 2

        # Deserialize
        cache2 = session.SessionCache.from_dict(d)
        assert cache2.has_hint_fingerprint("abc123def456")
        assert cache2.has_hint_fingerprint("xyz789uvw012")
        assert cache2.hints_seen["abc123def456"] == 1
        assert cache2.hints_seen["xyz789uvw012"] == 2

    def test_hints_seen_empty_dict_on_new_cache(self) -> None:
        """New cache serializes with empty hints_seen dict."""
        cache = session.SessionCache("test", 0, 0)
        d = cache.to_dict()
        assert d.get("hints_seen") == {}

    def test_hints_seen_missing_field_backward_compat(self) -> None:
        """from_dict handles missing hints_seen field gracefully."""
        d = {
            "schema_version": session.SESSION_SCHEMA_VERSION,
            "created_by": "token-goat",
            "session_id": "test",
            "started_ts": 0,
            "last_activity_ts": 0,
            "files": {},
            "greps": [],
            "edited_files": {},
        }
        cache = session.SessionCache.from_dict(d)
        assert isinstance(cache.hints_seen, dict)
        assert len(cache.hints_seen) == 0

    def test_hints_seen_corrupt_entry_skipped(self) -> None:
        """from_dict (legacy format) converts list[str] to dict[str, int]."""
        d = {
            "schema_version": session.SESSION_SCHEMA_VERSION,
            "created_by": "token-goat",
            "session_id": "test",
            "started_ts": 0,
            "last_activity_ts": 0,
            "files": {},
            "greps": [],
            "edited_files": {},
            "hints_seen": ["abc123def456", 123, None, "xyz789uvw012", ""],
        }
        cache = session.SessionCache.from_dict(d)
        assert cache.has_hint_fingerprint("abc123def456")
        assert cache.has_hint_fingerprint("xyz789uvw012")
        assert len(cache.hints_seen) == 2
        # Legacy list format is converted to count=1 for each entry
        assert cache.hints_seen["abc123def456"] == 1
        assert cache.hints_seen["xyz789uvw012"] == 1


class TestReadHintIntegration:
    """Integration tests for hint objects with fingerprinting."""

    def test_read_hint_fingerprint_stability(self) -> None:
        """ReadHint text produces stable fingerprints."""
        hint1 = ReadHint("`auth.py` lines 10-20 cached. ~50 tokens wasted.", 50)
        hint2 = ReadHint("`auth.py` lines 10-20 cached. ~50 tokens wasted.", 50)

        fp1 = _hint_fingerprint(str(hint1))
        fp2 = _hint_fingerprint(str(hint2))

        assert fp1 == fp2

    def test_different_hints_different_fingerprints(self) -> None:
        """Different ReadHints produce different fingerprints."""
        hint1 = ReadHint("`auth.py` lines 10-20 cached.", 50)
        hint2 = ReadHint("`config.py` lines 1-10 cached.", 30)

        fp1 = _hint_fingerprint(str(hint1))
        fp2 = _hint_fingerprint(str(hint2))

        assert fp1 != fp2


class TestHintsSeenLifecycle:
    """Tests for the complete hints_seen lifecycle."""

    def test_session_tracks_multiple_fingerprints(self, tmp_data_dir) -> None:
        """Session can track multiple unique hint fingerprints."""
        cache = session.SessionCache("test_session", 0, 0)

        hints = [
            "First hint about auth.py",
            "Second hint about config.py",
            "Third hint about utils.py",
        ]

        for hint_text in hints:
            fp = _hint_fingerprint(hint_text)
            cache.mark_hint_seen(fp)

        for hint_text in hints:
            fp = _hint_fingerprint(hint_text)
            assert cache.has_hint_fingerprint(fp)

        assert len(cache.hints_seen) == 3

    def test_hint_dedup_scenario(self, tmp_data_dir) -> None:
        """Simulate reading same file multiple times — hint should be suppressed on second read."""
        session_id = "test_scenario"
        cache = session.SessionCache(session_id, 0, 0)

        hint_text = "`auth.py` lines 1-100 cached. ~200 tokens wasted."
        hint = ReadHint(hint_text, 200)
        fp = _hint_fingerprint(str(hint))

        assert not cache.has_hint_fingerprint(fp)
        cache.mark_hint_seen(fp)
        # mark_hint_seen now defers the save; flush explicitly for persistence test
        cache._pending_hint_save = False
        session.save(cache)

        cache = session.load(session_id)

        assert cache.has_hint_fingerprint(fp)


class TestVerboseHintSuppression:
    """Tests for verbose-until-seen-count feature (short stub on repeated hints)."""

    def test_first_emit_is_verbose(self) -> None:
        """First emit of a hint is always verbose (full text)."""

        # Stub should only be used for counts > 1
        cache = session.SessionCache("test", 0, 0)
        fp = "abc123def456"

        # First emit: count goes from 0 → 1
        cache.mark_hint_seen(fp)
        assert cache.hints_seen[fp] == 1

    def test_second_emit_is_verbose_by_default(self) -> None:
        """Second emit is still verbose with default config (verbose_until_seen_count=2)."""
        cache = session.SessionCache("test", 0, 0)
        fp = "abc123def456"

        # First emit: count 1
        cache.mark_hint_seen(fp)
        # Second emit: count 2 (still <= verbose_until=2)
        cache.mark_hint_seen(fp)
        assert cache.hints_seen[fp] == 2

    def test_third_emit_triggers_short_stub(self) -> None:
        """Third emit uses short stub when verbose_until_seen_count=2."""
        from token_goat.hints import _make_short_stub_hint

        stub = _make_short_stub_hint(3)
        assert "same hint seen 3×" in str(stub)
        assert stub.tokens_saved == 0

    def test_short_stub_format(self) -> None:
        """Short stub has correct format for any count."""
        from token_goat.hints import _make_short_stub_hint

        for count in [3, 4, 5, 10]:
            stub = _make_short_stub_hint(count)
            assert f"seen {count}×" in str(stub)
            assert "↳" in str(stub)

    def test_hint_count_increments_on_mark(self) -> None:
        """mark_hint_seen increments count each time."""
        cache = session.SessionCache("test", 0, 0)
        fp = "abc123def456"

        # Mark 5 times
        for i in range(1, 6):
            cache.mark_hint_seen(fp)
            assert cache.hints_seen[fp] == i

    def test_count_survives_serialization(self) -> None:
        """Hint counts survive round-trip to disk."""
        session_id = "test_count_persist"
        cache1 = session.SessionCache(session_id, 0, 0)
        fp = "abc123def456"

        # Mark 3 times
        for _ in range(3):
            cache1.mark_hint_seen(fp)
        cache1._pending_hint_save = False
        session.save(cache1)

        # Reload
        cache2 = session.load(session_id)
        assert cache2.hints_seen[fp] == 3


class TestEmitDedupBudgetedHintVerboseWindow:
    """Regression tests for _emit_dedup_budgeted_hint verbose window behaviour.

    Before the fix, seen_count values within [1, verbose_until] (i.e. the 2nd and
    3rd reads with verbose_until=2) hit an ``else: return None`` branch and were
    suppressed entirely.  The correct behaviour is to fall through to the full emit
    path so those reads still see the hint.
    """

    def _call(
        self,
        cache: session.SessionCache,
        seen_count: int,
        *,
        verbose_until: int = 2,
        monkeypatch: object | None = None,
    ) -> object:
        from unittest import mock

        from token_goat.config import Config, HintsConfig
        from token_goat.hints import ReadHint, _hint_fingerprint
        from token_goat.hooks_read import _emit_dedup_budgeted_hint

        hint = ReadHint("Note: already read src/x.py", tokens_saved=100)
        fp = _hint_fingerprint(str(hint), path="src/x.py")
        # Pre-seed seen count.
        for _ in range(seen_count):
            cache.mark_hint_seen(fp)

        # Use a real Config so regex code paths (quiet_hours etc.) don't see MagicMock.
        cfg = Config(hints=HintsConfig(verbose_until_seen_count=verbose_until))

        with mock.patch("token_goat.config.load", return_value=cfg):
            return _emit_dedup_budgeted_hint(
                hint=hint,
                file_path="src/x.py",
                cache=cache,
                budget_kind="index_only",
                record_emitted_fn=lambda _c: None,
                stat_kind="index_only",
                display_name="index-only",
            )

    def test_first_read_emits_full_hint(self, tmp_data_dir) -> None:
        """seen_count=0 (first read): always emits full hint."""
        cache = session.SessionCache("vw-test-0", 0, 0)
        result = self._call(cache, seen_count=0)
        assert result is not None

    def test_second_read_emits_full_hint_within_verbose_window(self, tmp_data_dir) -> None:
        """seen_count=1 (second read) with verbose_until=2: must emit full hint, not None."""
        cache = session.SessionCache("vw-test-1", 0, 0)
        result = self._call(cache, seen_count=1)
        assert result is not None, "second read within verbose window must not be suppressed"
        # Full hint contains the hint text, not a stub marker.
        assert "already read" in str(result)

    def test_third_read_emits_full_hint_within_verbose_window(self, tmp_data_dir) -> None:
        """seen_count=2 (third read) with verbose_until=2: must emit full hint, not None."""
        cache = session.SessionCache("vw-test-2", 0, 0)
        result = self._call(cache, seen_count=2)
        assert result is not None, "third read within verbose window must not be suppressed"
        assert "already read" in str(result)

    def test_fourth_read_emits_stub_past_verbose_window(self, tmp_data_dir) -> None:
        """seen_count=3 with verbose_until=2: must emit short stub, not full hint."""
        cache = session.SessionCache("vw-test-3", 0, 0)
        result = self._call(cache, seen_count=3)
        assert result is not None, "past verbose window should emit a stub, not None"
        assert "seen 3×" in str(result)

    def test_verbose_until_zero_suppresses_all_repeats(self, tmp_data_dir) -> None:
        """verbose_until=0 (feature disabled): second read returns None."""
        cache = session.SessionCache("vw-test-4", 0, 0)
        result = self._call(cache, seen_count=1, verbose_until=0)
        assert result is None, "verbose_until=0 must suppress all duplicate hints"

    def test_verbose_until_one_stubs_at_third_read(self, tmp_data_dir) -> None:
        """verbose_until=1: second read emits full hint; third read emits stub."""
        cache_full = session.SessionCache("vw-test-5a", 0, 0)
        result_full = self._call(cache_full, seen_count=1, verbose_until=1)
        assert result_full is not None
        assert "already read" in str(result_full)

        cache_stub = session.SessionCache("vw-test-5b", 0, 0)
        result_stub = self._call(cache_stub, seen_count=2, verbose_until=1)
        assert result_stub is not None
        assert "seen 2×" in str(result_stub)
