"""Tests for hints.dedup_hints() — content-hash deduplication of hints."""
from __future__ import annotations

from token_goat import session
from token_goat.hints import (
    HINT_PRIORITY_HIGH,
    HINT_PRIORITY_LOW,
    HINT_PRIORITY_MEDIUM,
    HintItem,
    dedup_hints,
)


class TestDedupHints:
    """Test hint content deduplication by SHA256 hash."""

    def test_no_session_cache_returns_unchanged(self):
        """When session_cache is None, hints are returned unchanged."""
        hints = [
            HintItem("First hint", HINT_PRIORITY_HIGH),
            HintItem("Second hint", HINT_PRIORITY_MEDIUM),
        ]
        result = dedup_hints(hints, None)
        assert result == hints

    def test_first_occurrence_recorded(self):
        """First occurrence of a hint records its content hash in the session."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint_text = "This is a unique hint text"
        hints = [HintItem(hint_text, HINT_PRIORITY_HIGH)]

        result = dedup_hints(hints, cache)

        # Hint should be unchanged (first occurrence).
        assert len(result) == 1
        assert result[0].text == hint_text
        # Content hash should be recorded in the cache.
        assert len(cache.hints_content_dedup) == 1

    def test_duplicate_content_compressed(self):
        """Identical hint content on second call is compressed to a short stub."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint_text = "Repeated hint text"
        hints1 = [HintItem(hint_text, HINT_PRIORITY_HIGH)]

        # First call: hint recorded.
        result1 = dedup_hints(hints1, cache)
        assert result1[0].text == hint_text

        # Second call with same text: should be compressed.
        hints2 = [HintItem(hint_text, HINT_PRIORITY_HIGH)]
        result2 = dedup_hints(hints2, cache)

        assert len(result2) == 1
        # Text should be compressed to short stub.
        assert "[tg: dup]" in result2[0].text
        assert hint_text.replace("\n", " ")[:35] in result2[0].text

    def test_different_content_not_deduped(self):
        """Different hint texts are not confused with each other."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint1 = HintItem("First unique hint", HINT_PRIORITY_HIGH)
        hint2 = HintItem("Second unique hint", HINT_PRIORITY_MEDIUM)

        result = dedup_hints([hint1, hint2], cache)

        # Both should be unchanged.
        assert len(result) == 2
        assert result[0].text == "First unique hint"
        assert result[1].text == "Second unique hint"
        # Both content hashes should be recorded.
        assert len(cache.hints_content_dedup) == 2

    def test_normalization_handles_whitespace(self):
        """Hints differing only in whitespace are treated as duplicates."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        # Same content, different formatting.
        hint_text_1 = "The hint text"
        hint_text_2 = "  The hint text  "  # Extra whitespace

        result1 = dedup_hints([HintItem(hint_text_1, HINT_PRIORITY_HIGH)], cache)
        assert result1[0].text == hint_text_1

        result2 = dedup_hints([HintItem(hint_text_2, HINT_PRIORITY_MEDIUM)], cache)
        # Whitespace-normalized match should trigger dedup.
        assert "[tg: dup]" in result2[0].text

    def test_case_insensitive_dedup(self):
        """Hints differing only in case are treated as duplicates."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint_lower = "read lines 1–50 from file.py"
        hint_upper = "READ LINES 1–50 FROM FILE.PY"

        result1 = dedup_hints([HintItem(hint_lower, HINT_PRIORITY_HIGH)], cache)
        assert result1[0].text == hint_lower

        result2 = dedup_hints([HintItem(hint_upper, HINT_PRIORITY_MEDIUM)], cache)
        # Case-normalized match should trigger dedup.
        assert "[tg: dup]" in result2[0].text

    def test_priority_preserved_after_dedup(self):
        """Deduped hints retain their original priority."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint_text = "Same hint with different priority"

        result1 = dedup_hints([HintItem(hint_text, HINT_PRIORITY_HIGH)], cache)
        assert result1[0].hint_priority == HINT_PRIORITY_HIGH

        result2 = dedup_hints([HintItem(hint_text, HINT_PRIORITY_LOW)], cache)
        # Second occurrence with LOW priority should preserve the LOW priority.
        assert result2[0].hint_priority == HINT_PRIORITY_LOW

    def test_empty_hints_list(self):
        """Empty hint list returns empty list."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        result = dedup_hints([], cache)
        assert result == []

    def test_summary_text_generation(self):
        """Summary text is first ~50 chars of the original hint."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        long_hint = "This is a very long hint text that exceeds fifty characters and should be truncated"

        dedup_hints([HintItem(long_hint, HINT_PRIORITY_HIGH)], cache)

        # Extract the summary from the cached entry.
        assert len(cache.hints_content_dedup) == 1
        _, (summary, _) = list(cache.hints_content_dedup.items())[0]
        assert len(summary) <= 50
        assert summary.startswith("This is a very long hint text")

    def test_multiline_hint_handling(self):
        """Newlines in hint text are replaced with spaces in summary."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        multiline_hint = "First line\nSecond line\nThird line"

        dedup_hints([HintItem(multiline_hint, HINT_PRIORITY_HIGH)], cache)

        # Summary should have newlines replaced with spaces.
        _, (summary, _) = list(cache.hints_content_dedup.items())[0]
        assert "\n" not in summary
        assert "First line Second line" in summary

    def test_content_dedup_count_incremented(self):
        """Count for repeated content is incremented."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hint_text = "Repeated content"

        # First occurrence.
        dedup_hints([HintItem(hint_text, HINT_PRIORITY_HIGH)], cache)
        _, (_, count1) = list(cache.hints_content_dedup.items())[0]
        assert count1 == 1

        # Second occurrence.
        dedup_hints([HintItem(hint_text, HINT_PRIORITY_HIGH)], cache)
        _, (_, count2) = list(cache.hints_content_dedup.items())[0]
        assert count2 == 2

    def test_fifo_eviction_on_cap_exceeded(self):
        """When hints_content_dedup exceeds cap, oldest entries are evicted."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        # Add hints up to the cap + 1 to trigger eviction.
        cap = session.HINTS_CONTENT_DEDUP_MAX
        hints = [HintItem(f"Hint {i}", HINT_PRIORITY_HIGH) for i in range(cap + 1)]

        dedup_hints(hints, cache)

        # Cache should not exceed the cap.
        assert len(cache.hints_content_dedup) <= cap
        # The first hint should be evicted (FIFO).
        assert not any("Hint 0" in str(v) for v in cache.hints_content_dedup.values())

    def test_multiple_hints_deduped_independently(self):
        """Multiple hints in one call are deduped independently."""
        cache = session.SessionCache(
            session_id="test", started_ts=0.0, last_activity_ts=0.0
        )
        hints1 = [
            HintItem("Unique hint A", HINT_PRIORITY_HIGH),
            HintItem("Unique hint B", HINT_PRIORITY_MEDIUM),
        ]
        dedup_hints(hints1, cache)

        # Second call with one repeat and one new.
        hints2 = [
            HintItem("Unique hint A", HINT_PRIORITY_LOW),  # Repeat
            HintItem("Unique hint C", HINT_PRIORITY_HIGH),  # New
        ]
        result = dedup_hints(hints2, cache)

        assert len(result) == 2
        # First should be deduped (stub).
        assert "[tg: dup]" in result[0].text
        # Second should be original (new).
        assert result[1].text == "Unique hint C"
