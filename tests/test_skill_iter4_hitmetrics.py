"""Tests for iteration 4 skill improvements:

1. Per-session compact hit metrics (compact_served_count on SkillEntry).
2. Manifest skill ordering by recency + frequency composite score.
3. token-goat map Active skills footer.
"""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── 1. compact_served_count on SkillEntry ─────────────────────────────────────

class TestCompactServedCount:
    """SkillEntry gains a compact_served_count field; serialization round-trips it."""

    def test_skill_entry_has_compact_served_count(self) -> None:
        from token_goat.session import SkillEntry
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc123",
            content_sha="sha1",
            ts=time.time(),
            body_bytes=1000,
        )
        assert entry.compact_served_count == 0

    def test_compact_served_count_nonzero(self) -> None:
        from token_goat.session import SkillEntry
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc123",
            content_sha="sha1",
            ts=time.time(),
            body_bytes=1000,
            compact_served_count=3,
        )
        assert entry.compact_served_count == 3

    def test_serialize_omits_zero(self) -> None:
        """compact_served_count=0 is omitted from wire dict to keep JSON compact."""
        from token_goat.session import (  # type: ignore[attr-defined]
            SkillEntry,
            _serialize_skill_entry,
        )
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc123",
            content_sha="sha1",
            ts=time.time(),
            body_bytes=1000,
            compact_served_count=0,
        )
        d = _serialize_skill_entry(entry)
        assert "compact_served_count" not in d

    def test_serialize_includes_nonzero(self) -> None:
        """compact_served_count>0 is included in wire dict."""
        from token_goat.session import (  # type: ignore[attr-defined]
            SkillEntry,
            _serialize_skill_entry,
        )
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc123",
            content_sha="sha1",
            ts=time.time(),
            body_bytes=1000,
            compact_served_count=5,
        )
        d = _serialize_skill_entry(entry)
        assert d["compact_served_count"] == 5

    def test_parse_roundtrip(self) -> None:
        """Parsing a wire dict preserves compact_served_count."""
        from token_goat.session import (  # type: ignore[attr-defined]
            SkillEntry,
            _parse_skill_entry,
            _serialize_skill_entry,
        )
        original = SkillEntry(
            skill_name="improve",
            output_id="xyz789",
            content_sha="deadbeef",
            ts=1700000000.0,
            body_bytes=2048,
            compact_served_count=7,
        )
        wire = _serialize_skill_entry(original)
        parsed = _parse_skill_entry(wire)
        assert parsed is not None
        assert parsed.compact_served_count == 7

    def test_parse_missing_field_defaults_to_zero(self) -> None:
        """Old session JSON without compact_served_count field defaults to 0."""
        from token_goat.session import _parse_skill_entry  # type: ignore[attr-defined]
        wire = {
            "skill_name": "ralph",
            "output_id": "abc123",
            "content_sha": "sha1",
            "ts": 1700000000.0,
            "body_bytes": 1000,
            "truncated": False,
            "run_count": 1,
        }
        parsed = _parse_skill_entry(wire)
        assert parsed is not None
        assert parsed.compact_served_count == 0


class TestRecordSkillCompactHit:
    """record_skill_compact_hit increments compact_served_count in session."""

    def test_increments_count(self, tmp_path: Path) -> None:
        from token_goat import session
        from token_goat.session import SkillEntry

        sid = "test_compact_hit_0001"
        # Seed the session with a skill entry.
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc123",
            content_sha="sha1",
            ts=time.time(),
            body_bytes=1000,
            compact_served_count=0,
        )
        cache = session._fresh_cache(sid)  # type: ignore[attr-defined]
        cache.skill_history["ralph"] = entry

        with (
            patch.object(session, "_resolve_cache", return_value=cache),
            patch.object(session, "_commit_mutation", return_value=cache),
        ):
            result = session.record_skill_compact_hit(sid, "ralph", cache=cache)
            updated_entry = result.skill_history.get("ralph")
            assert updated_entry is not None
            assert updated_entry.compact_served_count == 1

    def test_increments_again(self, tmp_path: Path) -> None:
        from token_goat import session
        from token_goat.session import SkillEntry

        sid = "test_compact_hit_0002"
        entry = SkillEntry(
            skill_name="improve",
            output_id="def456",
            content_sha="sha2",
            ts=time.time(),
            body_bytes=500,
            compact_served_count=4,
        )
        cache = session._fresh_cache(sid)  # type: ignore[attr-defined]
        cache.skill_history["improve"] = entry

        with (
            patch.object(session, "_resolve_cache", return_value=cache),
            patch.object(session, "_commit_mutation", return_value=cache),
        ):
            result = session.record_skill_compact_hit(sid, "improve", cache=cache)
            updated = result.skill_history.get("improve")
            assert updated is not None
            assert updated.compact_served_count == 5

    def test_missing_entry_is_noop(self) -> None:
        """No entry for the skill name → returns cache unchanged, no error."""
        from token_goat import session

        sid = "test_compact_hit_0003"
        cache = session._fresh_cache(sid)  # type: ignore[attr-defined]
        # skill_history is empty — calling record_skill_compact_hit must not raise.
        with patch.object(session, "_resolve_cache", return_value=cache):
            result = session.record_skill_compact_hit(sid, "nonexistent", cache=cache)
        assert result is cache  # returns unchanged cache


class TestGetSkillHistory:
    """get_skill_history returns the skill_history dict or None on failure."""

    def test_returns_dict(self) -> None:
        from token_goat import session
        from token_goat.session import SkillEntry

        sid = "test_get_history_0001"
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abc",
            content_sha="sha",
            ts=time.time(),
            body_bytes=100,
        )
        cache = session._fresh_cache(sid)  # type: ignore[attr-defined]
        cache.skill_history["ralph"] = entry

        with patch.object(session, "_resolve_cache", return_value=cache):
            result = session.get_skill_history(sid, cache=cache)
        assert result is not None
        assert "ralph" in result

    def test_empty_history_returns_none(self) -> None:
        from token_goat import session

        sid = "test_get_history_0002"
        cache = session._fresh_cache(sid)  # type: ignore[attr-defined]
        # skill_history is empty dict → should return None (falsy)
        with patch.object(session, "_resolve_cache", return_value=cache):
            result = session.get_skill_history(sid, cache=cache)
        assert result is None


# ── 2. Manifest ordering: recency + frequency composite score ─────────────────

class TestSkillManifestOrdering:
    """_select_top_skill_entries orders by ts + run_count boost."""

    def _make_entry(self, name: str, ts: float, run_count: int = 1) -> object:
        from token_goat.session import SkillEntry
        return SkillEntry(
            skill_name=name,
            output_id=f"oid_{name}",
            content_sha=f"sha_{name}",
            ts=ts,
            body_bytes=500,
            run_count=run_count,
        )

    def test_more_recent_wins_over_older_with_equal_run_count(self) -> None:
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "old": self._make_entry("old", now - 120, run_count=1),
            "new": self._make_entry("new", now - 10, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 3600)
        names = [getattr(e, "skill_name", "") for e in result]
        assert names.index("new") < names.index("old"), "newer skill should rank first"

    def test_high_run_count_can_promote_slightly_older(self) -> None:
        """A skill with run_count=4 loaded 3 min ago should outrank run_count=1 loaded 2 min ago.

        Each extra load is worth +60 s of recency.
        - heavily_used: ts = now-180, run_count=4 → score = now-180 + 3*60 = now
        - barely_used:  ts = now-120, run_count=1 → score = now-120
        So heavily_used.score > barely_used.score.
        """
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "heavily_used": self._make_entry("heavily_used", now - 180, run_count=4),
            "barely_used": self._make_entry("barely_used", now - 120, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 3600)
        names = [getattr(e, "skill_name", "") for e in result]
        assert names.index("heavily_used") < names.index("barely_used"), (
            "high run_count should promote a slightly older skill"
        )

    def test_much_more_recent_still_wins_despite_lower_run_count(self) -> None:
        """A skill loaded 10 s ago with run_count=1 must beat one from 10 min ago with run_count=6.

        - old_frequent: ts = now-600, run_count=6 → score = now-600 + 5*60 = now-300
        - new_once:     ts = now-10,  run_count=1 → score = now-10
        new_once.score > old_frequent.score.
        """
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "old_frequent": self._make_entry("old_frequent", now - 600, run_count=6),
            "new_once": self._make_entry("new_once", now - 10, run_count=1),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 3600)
        names = [getattr(e, "skill_name", "") for e in result]
        assert names.index("new_once") < names.index("old_frequent"), (
            "very recent skill should still outrank old high-run_count skill"
        )

    def test_stable_order_with_equal_score(self) -> None:
        """Two entries with identical ts and run_count should both appear in results."""
        from token_goat.compact import _select_top_skill_entries
        now = time.time()
        history = {
            "a": self._make_entry("a", now - 60, run_count=2),
            "b": self._make_entry("b", now - 60, run_count=2),
        }
        result = _select_top_skill_entries(history, session_started_ts=now - 3600)
        names = {getattr(e, "skill_name", "") for e in result}
        assert "a" in names
        assert "b" in names


# ── 3. token-goat map Active skills footer ────────────────────────────────────

class TestBuildMapSkillsFooter:
    """_build_map_skills_footer returns a non-empty string when skills are cached."""

    def test_returns_empty_when_no_outputs(self) -> None:
        from token_goat.cli import _build_map_skills_footer
        with patch("token_goat.skill_cache.list_outputs", return_value=[]):
            result = _build_map_skills_footer()
        assert result == ""

    def test_returns_empty_when_skill_history_empty(self) -> None:
        from token_goat.cli import _build_map_skills_footer
        mock_output = [{"output_id": "abcdef0123456789", "mtime": time.time()}]
        with (
            patch("token_goat.skill_cache.list_outputs", return_value=mock_output),
            patch("token_goat.session.get_skill_history", return_value=None),
        ):
            result = _build_map_skills_footer()
        assert result == ""

    def test_returns_footer_with_skill_names(self) -> None:
        from token_goat.cli import _build_map_skills_footer
        from token_goat.session import SkillEntry

        now = time.time()
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abcdef0123456789",
            content_sha="sha1",
            ts=now,
            body_bytes=30000,
            run_count=2,
        )
        mock_output = [{"output_id": "abcdef0123456789", "mtime": now}]

        mock_cache = MagicMock()
        mock_cache.started_ts = now - 3600
        with (
            patch("token_goat.skill_cache.list_outputs", return_value=mock_output),
            patch("token_goat.session.get_skill_history", return_value={"ralph": entry}),
            patch("token_goat.session.safe_load", return_value=mock_cache),
            patch("token_goat.skill_cache.get_compact", return_value=None),
        ):
            result = _build_map_skills_footer()

        assert "Active skills" in result
        assert "ralph" in result
        assert "skill-body ralph" in result

    def test_footer_shows_run_count_multiplier(self) -> None:
        from token_goat.cli import _build_map_skills_footer
        from token_goat.session import SkillEntry

        now = time.time()
        entry = SkillEntry(
            skill_name="improve",
            output_id="abcdef0123456789",
            content_sha="sha1",
            ts=now,
            body_bytes=10000,
            run_count=3,
        )
        mock_output = [{"output_id": "abcdef0123456789", "mtime": now}]

        mock_cache = MagicMock()
        mock_cache.started_ts = now - 3600
        with (
            patch("token_goat.skill_cache.list_outputs", return_value=mock_output),
            patch("token_goat.session.get_skill_history", return_value={"improve": entry}),
            patch("token_goat.session.safe_load", return_value=mock_cache),
            patch("token_goat.skill_cache.get_compact", return_value=None),
        ):
            result = _build_map_skills_footer()

        assert "×3" in result

    def test_footer_shows_compact_token_count(self) -> None:
        from token_goat.cli import _build_map_skills_footer
        from token_goat.session import SkillEntry

        now = time.time()
        entry = SkillEntry(
            skill_name="ralph",
            output_id="abcdef0123456789",
            content_sha="sha1",
            ts=now,
            body_bytes=30000,
            run_count=1,
        )
        mock_output = [{"output_id": "abcdef0123456789", "mtime": now}]
        compact_text = "# ralph compact\n- MUST do X\n- NEVER do Y\n" * 10

        mock_cache = MagicMock()
        mock_cache.started_ts = now - 3600
        with (
            patch("token_goat.skill_cache.list_outputs", return_value=mock_output),
            patch("token_goat.session.get_skill_history", return_value={"ralph": entry}),
            patch("token_goat.session.safe_load", return_value=mock_cache),
            patch("token_goat.skill_cache.get_compact", return_value=compact_text),
        ):
            result = _build_map_skills_footer()

        assert "compact:" in result
        assert "tok" in result

    def test_footer_suppressed_when_exception_in_list_outputs(self) -> None:
        """Any exception inside _build_map_skills_footer returns empty string."""
        from token_goat.cli import _build_map_skills_footer
        with patch("token_goat.skill_cache.list_outputs", side_effect=OSError("disk full")):
            result = _build_map_skills_footer()
        assert result == ""
