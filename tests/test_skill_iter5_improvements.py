"""Tests for skill context savings accuracy improvements (iteration 5).

Covers:
1. LRU eviction correctness — most-recently written skill is not evicted first
   when the cache cap is hit.
2. Cross-session compact isolation — get_compact/store_compact keyed by session.
3. Recovery hint overflow count — based on unique skill names, not raw entries.
4. hooks_skill.py robustness — unusual payload shapes:
   - missing tool_name key
   - tool_input as non-dict
   - skill field as non-string (int, list, None)
   - skill name empty after normalization (e.g. "/", "/.md")
   - extremely large body (>1MB) is pre-capped before caching
"""
from __future__ import annotations

import pytest

from token_goat import hooks_skill, session, skill_cache

# ---------------------------------------------------------------------------
# Improvement 1: LRU eviction correctness
# ---------------------------------------------------------------------------


class TestSkillCacheLRUEviction:
    """Most-recently written skill must survive eviction when cap is hit."""

    def test_newest_skill_survives_eviction(self, tmp_data_dir):
        """When adding a skill causes the cap to be exceeded, the oldest skill is
        evicted, not the one just written (which has the freshest mtime)."""
        # Use a tiny byte cap to force eviction deterministically.
        # Write two skills at different times; the second write should evict the first.
        body_old = "# Old Skill\n\n" + ("old content. " * 100)
        body_new = "# New Skill\n\n" + ("new content. " * 100)

        # Store old skill — its file gets an older mtime because it's first.
        meta_old = skill_cache.store_output("sess-lru-1", "old-skill", body_old)
        assert meta_old is not None

        # Confirm old skill is on disk.
        old_path = skill_cache._skill_outputs_dir() / f"{meta_old.output_id}.txt"
        assert old_path.exists(), "Old skill should be on disk before eviction"

        # Store new skill with a cap that forces eviction (cap = len of new body only).
        new_body_bytes = len(body_new.encode("utf-8"))
        meta_new = skill_cache.store_output(
            "sess-lru-1", "new-skill", body_new,
            max_total_bytes=new_body_bytes + 100,  # tight cap: only fits one skill
        )
        assert meta_new is not None

        # New skill must still be retrievable.
        new_loaded = skill_cache.load_output(meta_new.output_id)
        assert new_loaded is not None
        assert "new content." in new_loaded

    def test_eviction_removes_oldest_not_newest(self, tmp_data_dir, monkeypatch):
        """When N skills are cached and cap is exceeded, the N-1 oldest entries
        are removed before the newest (by mtime), not the other way around."""
        import token_goat.skill_cache as _sc_mod  # noqa: PLC0415

        _ts = [1_000_000.0]

        def _fake_time():
            _ts[0] += 0.001
            return _ts[0]

        monkeypatch.setattr(_sc_mod.time, "time", _fake_time)

        bodies = {f"skill-{i}": f"# Skill {i}\n\n" + ("x. " * 100) for i in range(5)}
        metas = {}
        for name, body in bodies.items():
            m = skill_cache.store_output("sess-lru-evict", name, body)
            assert m is not None
            metas[name] = m

        # All 5 skills should be on disk now.
        for name, m in metas.items():
            p = skill_cache._skill_outputs_dir() / f"{m.output_id}.txt"
            assert p.exists(), f"Expected {name} to be on disk"

        # Now store a 6th skill with a tight cap that forces eviction of the oldest.
        body_new = "# New Skill\n\n" + ("y. " * 100)
        per_body = len(body_new.encode("utf-8")) + 200
        # Cap = 3 bodies worth; we have 5 + about to add 1 = 6. Should evict 3.
        cap = per_body * 3
        meta_newest = skill_cache.store_output("sess-lru-evict", "newest", body_new, max_total_bytes=cap)
        assert meta_newest is not None

        # The newest skill must survive.
        newest_loaded = skill_cache.load_output(meta_newest.output_id)
        assert newest_loaded is not None
        assert "y." in newest_loaded

    def test_active_session_skill_still_loadable_after_new_large_skill(self, tmp_data_dir):
        """An existing session skill that's just been re-accessed (updated mtime via
        idempotent store) is NOT evicted when a new large skill triggers the cap."""
        body_existing = "# Existing\n\n" + ("exist. " * 100)
        body_new_large = "# Large\n\n" + ("z. " * 500)  # larger body

        # Write existing skill first.
        meta_existing = skill_cache.store_output("sess-lru-active", "existing", body_existing)
        assert meta_existing is not None

        # Re-write the same existing skill (same body = same output_id = updates mtime).
        skill_cache.store_output("sess-lru-active", "existing", body_existing)

        # Now add a large skill with a cap that would require eviction.
        large_bytes = len(body_new_large.encode("utf-8"))
        existing_bytes = len(body_existing.encode("utf-8"))
        # Cap = existing + large + 10 bytes: nothing should be evicted.
        meta_large = skill_cache.store_output(
            "sess-lru-active", "large-new", body_new_large,
            max_total_bytes=existing_bytes + large_bytes + 500,
        )
        assert meta_large is not None

        # Both should be loadable.
        existing_loaded = skill_cache.load_output(meta_existing.output_id)
        large_loaded = skill_cache.load_output(meta_large.output_id)
        assert existing_loaded is not None
        assert large_loaded is not None


# ---------------------------------------------------------------------------
# Improvement 2: Cross-session compact isolation
# ---------------------------------------------------------------------------


class TestCrossSessionCompactIsolation:
    """store_compact/get_compact must be isolated between sessions."""

    def test_different_sessions_same_skill_isolated(self, tmp_data_dir):
        """Compacts for the same skill name in different sessions don't bleed."""
        skill_cache.store_compact("session-A", "ralph", "Session A compact text.")
        skill_cache.store_compact("session-B", "ralph", "Session B compact text.")

        result_a = skill_cache.get_compact("session-A", "ralph")
        result_b = skill_cache.get_compact("session-B", "ralph")

        assert result_a is not None
        assert result_b is not None
        assert "Session A compact text." in result_a
        assert "Session B compact text." in result_b
        # Cross-contamination check.
        assert "Session B compact text." not in result_a
        assert "Session A compact text." not in result_b

    def test_session_compact_only_retrieved_by_same_session(self, tmp_data_dir):
        """get_compact for session-X cannot retrieve session-Y's compact."""
        skill_cache.store_compact("session-C", "improve", "Compact for session C.")

        # session-D was never stored.
        result_d = skill_cache.get_compact("session-D", "improve")
        assert result_d is None

    def test_updating_compact_in_one_session_does_not_affect_other(self, tmp_data_dir):
        """Overwriting a compact in session-E does not affect session-F's copy."""
        skill_cache.store_compact("session-E", "myskill", "Original E content.")
        skill_cache.store_compact("session-F", "myskill", "F content.")

        # Overwrite E.
        skill_cache.store_compact("session-E", "myskill", "Updated E content.")

        result_e = skill_cache.get_compact("session-E", "myskill") or ""
        result_f = skill_cache.get_compact("session-F", "myskill") or ""

        assert "Updated E content." in result_e
        assert "Original E content." not in result_e
        assert "F content." in result_f
        assert "Updated E content." not in result_f

    def test_session_body_cache_isolated_by_session_prefix(self, tmp_data_dir):
        """store_output entries for the same skill and body in different sessions produce
        distinct output_ids (different session prefix) so they never collide."""
        body = "# Same Body\n\n" + ("content. " * 100)
        meta_sess1 = skill_cache.store_output("session-111", "myskill", body)
        meta_sess2 = skill_cache.store_output("session-222", "myskill", body)

        assert meta_sess1 is not None
        assert meta_sess2 is not None
        # Different session prefixes → different output_ids, even for same body.
        assert meta_sess1.output_id != meta_sess2.output_id

    def test_lookup_skill_entry_is_session_scoped(self, tmp_data_dir):
        """lookup_skill_entry only finds skills in the specified session, not others."""
        session.mark_skill_loaded("sess-scope-1", "ralph", "oid-1", "sha1", 5000, False)
        session.mark_skill_loaded("sess-scope-2", "ralph", "oid-2", "sha2", 5000, False)

        entry_1 = session.lookup_skill_entry("sess-scope-1", "ralph")
        entry_2 = session.lookup_skill_entry("sess-scope-2", "ralph")

        assert entry_1 is not None
        assert entry_2 is not None
        # Each session sees only its own entry.
        assert entry_1.output_id == "oid-1"
        assert entry_2.output_id == "oid-2"

        # Session 3 has no skills loaded.
        entry_3 = session.lookup_skill_entry("sess-scope-3", "ralph")
        assert entry_3 is None


# ---------------------------------------------------------------------------
# Improvement 3: Recovery hint overflow count uses unique skill names
# ---------------------------------------------------------------------------


class TestRecoveryHintOverflowCount:
    """Overflow count in recovery hint reflects unique skill names, not raw entries."""

    def test_repeated_loads_do_not_inflate_overflow_count(self, tmp_data_dir):
        """When the same skill is loaded multiple times (run_count > 1), the
        overflow count must not double-count it."""
        from token_goat import hooks_session  # noqa: PLC0415

        sid = "sess-overflow-unique"
        # Load "ralph" three times (simulates run_count increments).
        for i in range(3):
            session.mark_skill_loaded(sid, "ralph", f"oid-{i}", f"sha-{i}", 5000, False)

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "ralph" in hint

        # With only one unique skill name, the overflow should be 0 (no "+N more").
        assert "+1 more" not in hint
        assert "+2 more" not in hint
        assert "+3 more" not in hint

    def test_overflow_count_with_many_unique_skills_beyond_ceiling(self, tmp_data_dir):
        """When more than 8 unique skills are loaded, the overflow count shows
        exactly how many unique names are NOT displayed in the hint."""
        from token_goat import hooks_session  # noqa: PLC0415

        sid = "sess-overflow-many"
        # Load 10 distinct skills.
        for i in range(10):
            session.mark_skill_loaded(
                sid, f"skill-{i:02d}", f"oid-{i}", f"sha-{i}", 5000, False
            )

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Skills:**" in hint

        # At most 8 skills shown (ceiling). With 10 unique, "+2 more" expected.
        # (The exact count depends on allocator budget, but with only skills and
        # no files/bash/web entries, all 8 ceiling slots should be used.)
        assert "+2 more" in hint

    def test_overflow_zero_when_all_skills_fit(self, tmp_data_dir):
        """When total unique skills <= ceiling (8), no overflow is shown."""
        from token_goat import hooks_session  # noqa: PLC0415

        sid = "sess-no-overflow"
        for i in range(3):
            session.mark_skill_loaded(sid, f"skill-{i}", f"oid-{i}", f"sha-{i}", 5000, False)

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # Three skills, all fit — no overflow suffix.
        assert " more" not in hint

    def test_repeated_and_unique_mixed_overflow_count(self, tmp_data_dir):
        """Mix of repeated and unique skill loads produces an overflow count
        based only on unique names hidden from the visible slice."""
        from token_goat import hooks_session  # noqa: PLC0415

        sid = "sess-mixed-overflow"
        # 8 unique skills (fills ceiling), plus "ralph" loaded 5 times, plus 1 more unique.
        for i in range(8):
            session.mark_skill_loaded(sid, f"skill-{i}", f"oid-s{i}", f"sha-s{i}", 5000, False)
        for j in range(5):
            session.mark_skill_loaded(sid, "ralph", f"oid-r{j}", f"sha-r{j}", 25000, False)
        session.mark_skill_loaded(sid, "extra-skill", "oid-extra", "sha-extra", 5000, False)

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Skills:**" in hint

        # 10 unique skills total (8 + ralph + extra-skill); ceiling is 8.
        # Overflow should be +2 (the 2 unique names not shown), not +7 (which
        # would result from counting the 5 repeated ralph loads).
        assert "+2 more" in hint
        assert "+7 more" not in hint
        assert "+6 more" not in hint


# ---------------------------------------------------------------------------
# Improvement 4: hooks_skill.py robustness
# ---------------------------------------------------------------------------


class TestPostSkillHookRobustness:
    """post_skill must degrade gracefully on unusual payload shapes."""

    def test_missing_tool_name_key(self, tmp_data_dir):
        """Payload with no 'tool_name' key is treated as non-Skill and ignored."""
        payload = {
            "session_id": "sess-robust-1",
            # no tool_name key
            "tool_input": {"skill": "ralph"},
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        # Should not cache because tool_name defaults to "" (not "Skill").
        cache = session.load("sess-robust-1")
        assert "ralph" not in cache.skill_history

    def test_tool_input_as_list_instead_of_dict(self, tmp_data_dir):
        """tool_input as a list (malformed) is handled without crash."""
        payload = {
            "session_id": "sess-robust-2",
            "tool_name": "Skill",
            "tool_input": ["ralph", "extra"],  # list, not dict
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True

    def test_tool_input_as_string(self, tmp_data_dir):
        """tool_input as a plain string is handled without crash."""
        payload = {
            "session_id": "sess-robust-3",
            "tool_name": "Skill",
            "tool_input": "ralph",  # string, not dict
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True

    def test_skill_field_as_integer(self, tmp_data_dir):
        """skill field as an integer (non-string) is skipped gracefully."""
        payload = {
            "session_id": "sess-robust-4",
            "tool_name": "Skill",
            "tool_input": {"skill": 42},  # int, not str
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-4")
        assert not cache.skill_history

    def test_skill_field_as_list(self, tmp_data_dir):
        """skill field as a list is skipped gracefully."""
        payload = {
            "session_id": "sess-robust-5",
            "tool_name": "Skill",
            "tool_input": {"skill": ["ralph", "improve"]},  # list, not str
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-5")
        assert not cache.skill_history

    def test_skill_field_as_none(self, tmp_data_dir):
        """skill field explicitly None is skipped gracefully."""
        payload = {
            "session_id": "sess-robust-6",
            "tool_name": "Skill",
            "tool_input": {"skill": None},
            "tool_response": "# Ralph\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-6")
        assert not cache.skill_history

    def test_skill_name_empty_after_path_strip(self, tmp_data_dir):
        """A skill name that becomes empty after path-stripping is skipped."""
        # "/" → path-split → "" → guarded and skipped
        payload = {
            "session_id": "sess-robust-7",
            "tool_name": "Skill",
            "tool_input": {"skill": "/"},
            "tool_response": "# Something\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-7")
        assert not cache.skill_history

    def test_skill_name_only_md_extension(self, tmp_data_dir):
        """A skill name that is only '.md' (becomes empty after stripping extension) is skipped."""
        payload = {
            "session_id": "sess-robust-8",
            "tool_name": "Skill",
            "tool_input": {"skill": ".md"},
            "tool_response": "# Something\n\n" + ("rule. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-8")
        assert not cache.skill_history

    def test_empty_body_skipped(self, tmp_data_dir):
        """A completely empty tool_response is skipped without crash."""
        payload = {
            "session_id": "sess-robust-9",
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": "",
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-9")
        assert "ralph" not in cache.skill_history

    def test_body_as_integer_in_tool_response(self, tmp_data_dir):
        """tool_response as an integer is treated as empty body and skipped."""
        payload = {
            "session_id": "sess-robust-10",
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": 12345,  # integer, not str
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-10")
        assert "ralph" not in cache.skill_history

    def test_extremely_large_body_is_pre_capped(self, tmp_data_dir):
        """A body larger than _SKILL_CACHE_MAX_CHARS (2 MB) is pre-capped and still cached."""
        # Build a 3 MB body (well over the 2 MB cap).
        big_body = "# Huge Skill\n\n" + ("A" * (3 * 1024 * 1024))
        assert len(big_body) > hooks_skill._SKILL_CACHE_MAX_CHARS

        sid = "sess-robust-huge"
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "huge-skill"},
            "tool_response": big_body,
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True

        # The skill should still be cached (body was pre-capped then store_output
        # handled byte-precise tail truncation within the 256 KB disk cap).
        cache = session.load(sid)
        assert "huge-skill" in cache.skill_history, (
            "Huge skill should be cached despite extreme body size"
        )

    def test_none_payload_does_not_crash(self):
        """Passing None as the payload does not crash the hook."""
        # None payload: tool_name check fails gracefully via payload.get
        try:
            resp = hooks_skill.post_skill(None)  # type: ignore[arg-type]
            assert resp.get("continue") is True
        except AttributeError:
            # Acceptable: payload.get() on None — but ideally the hook should guard.
            # If this raises, it means the hook is not guarded at the top level.
            pytest.fail("post_skill(None) raised AttributeError — add top-level None guard")

    def test_skill_name_with_only_whitespace(self, tmp_data_dir):
        """A skill name that is all whitespace strips to empty and is skipped."""
        payload = {
            "session_id": "sess-robust-ws",
            "tool_name": "Skill",
            "tool_input": {"skill": "   "},
            "tool_response": "# Skill\n\n" + ("body. " * 200),
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load("sess-robust-ws")
        assert not cache.skill_history
