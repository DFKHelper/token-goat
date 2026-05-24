"""Tests for the post-compaction recovery hint path in session_start."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_session, session, skill_cache
from token_goat.hooks_session import _allocate_recovery_slots


def _seed_state(sid: str) -> None:
    """Populate a session with a mix of files, bash, and web history."""
    session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=200)
    session.mark_file_edited(sid, "/proj/src/auth.py")
    session.mark_bash_run(
        session_id=sid,
        cmd_sha="abc123def4567890",
        cmd_preview="pytest -v tests/",
        output_id=f"{sid[:16]}-0000000000001-abc123def4567890",
        stdout_bytes=8000,
        stderr_bytes=0,
        exit_code=0,
        truncated=False,
    )
    session.mark_web_fetch(
        session_id=sid,
        url_sha="dead00beefca0fe1",
        url_preview="https://docs.example/api",
        output_id=f"{sid[:16]}-0000000000002-dead00beefca0fe1",
        body_bytes=12000,
        status_code=200,
        truncated=False,
    )


class TestSourceDetection:
    def test_compact_source_preserves_cache(self, tmp_data_dir):
        sid = "rec-1"
        _seed_state(sid)
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        }))
        # Cache survives the compact-source SessionStart.
        cache = session.load(sid)
        assert cache.files, "files were wiped despite source=compact"
        assert cache.bash_history, "bash_history was wiped despite source=compact"

    def test_clear_source_resets_cache(self, tmp_data_dir):
        sid = "rec-2"
        _seed_state(sid)
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "source": "clear",
            "cwd": "/proj",
        }))
        cache = session.load(sid)
        assert not cache.files
        assert not cache.bash_history

    def test_missing_source_treated_as_startup(self, tmp_data_dir):
        sid = "rec-3"
        _seed_state(sid)
        # No source field — should reset (default behaviour).
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "cwd": "/proj",
        }))
        cache = session.load(sid)
        assert not cache.files


class TestRecoveryHintContent:
    def test_emits_files_bash_web_sections(self, tmp_data_dir):
        sid = "rec-4"
        _seed_state(sid)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "Post-Compact Recovery" in ctx
        assert "/proj/src/auth.py" in ctx
        assert "pytest -v tests/" in ctx
        assert "https://docs.example/api" in ctx
        # The hint references the retrieval commands so the agent has
        # something actionable, not just an inventory.
        assert "token-goat bash-output" in ctx
        assert "token-goat web-output" in ctx
        # Output IDs must appear in short form (…<last8>) — not the full 40+ char id.
        bash_full_id = f"{sid[:16]}-0000000000001-abc123def4567890"
        web_full_id  = f"{sid[:16]}-0000000000002-dead00beefca0fe1"
        assert bash_full_id not in ctx, "full bash output_id leaked into recovery hint"
        assert web_full_id  not in ctx, "full web output_id leaked into recovery hint"
        assert "…f4567890" in ctx, "bash short id (…f4567890) missing from recovery hint"
        assert "…efca0fe1" in ctx, "web short id (…efca0fe1) missing from recovery hint"

    def test_empty_session_no_hint(self, tmp_data_dir):
        """A compact on a session with no recorded state emits no hint."""
        result = hooks_session.session_start({
            "session_id": "rec-5",
            "source": "compact",
        })
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_truncated_files_section_shows_more_count(self, tmp_data_dir):
        """When more files exist than the allocator surfaces, a `+N more files`
        signal must appear so the agent knows data was dropped instead of
        silently truncated."""
        sid = "rec-more-files"
        # Seed 30 files; allocator ceiling for files is 12 → 18 should be dropped.
        for i in range(30):
            session.mark_file_read(sid, f"/proj/src/mod_{i:02d}.py", offset=0, limit=50)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "+18 more" in ctx, (
            f"expected dropped-files signal in hint, got:\n{ctx}"
        )

    def test_symbol_preview_overflow_shows_plus_count(self, tmp_data_dir):
        """When a file has more than 3 tracked symbols, the preview must surface
        the remainder count (`+N`) instead of silently dropping symbols."""
        sid = "rec-syms-overflow"
        path = "/proj/src/overflow.py"
        for sym in ("sym1", "sym2", "sym3", "sym4", "sym5", "sym6", "sym7"):
            session.mark_file_read(sid, path, symbol=sym)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "syms=sym1,sym2,sym3+4" in ctx, (
            f"expected truncated symbol preview with +4 suffix, got:\n{ctx}"
        )

    def test_symbol_preview_exact_three_no_plus_artifact(self, tmp_data_dir):
        """A file with exactly 3 symbols must NOT render a stray `+0` suffix."""
        sid = "rec-syms-exact"
        path = "/proj/src/exact.py"
        for sym in ("alpha", "beta", "gamma"):
            session.mark_file_read(sid, path, symbol=sym)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "syms=alpha,beta,gamma" in ctx
        assert "+0" not in ctx, f"unexpected +0 artifact in hint:\n{ctx}"

    def test_tiny_outputs_filtered(self, tmp_data_dir):
        """Bash / web entries below the recovery min-bytes floor are skipped."""
        sid = "rec-6"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="111",
            cmd_preview="ls",
            output_id="rec-6-x-111",
            stdout_bytes=50,  # tiny
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
        })
        _assert_continue(result)
        # No file activity, only one tiny bash entry → no hint emitted.
        assert "hookSpecificOutput" not in result


class TestRecoverySlotAllocator:
    """Direct tests of the floor/ceiling/total slot allocator.

    The helper preserves current behaviour when every section is saturated
    (sums to 14, evenly distributed at floors) AND reclaims unused budget
    from empty/short sections in lopsided sessions.
    """

    def test_saturated_matches_floors(self):
        # Plenty of items in files/bash/web, no skills → each section gets its
        # floor; skills contributes 0; the unused 4 skill-floor slots flow to
        # files (priority order) which expands to its ceiling.
        # Floors (6,4,4,0) sum to 14; budget is 18 so 4 slack slots remain.
        # Greedy expansion: skill_n=0 so skills stay 0; files gets +4 → 10.
        files, bash, web, skill = _allocate_recovery_slots(50, 50, 50)
        assert (files, bash, web, skill) == (10, 4, 4, 0)

    def test_web_empty_expands_files_and_bash(self):
        # 30 files, 30 bash, 0 web, 0 skills: floors (6,4,0,0)=10, budget 18
        # leaves 8 slack. files (ceil 12) absorbs 6 to reach ceiling; bash
        # absorbs the remaining 2 (ceil 10 still has 6 headroom but is satisfied).
        assert _allocate_recovery_slots(30, 30, 0) == (12, 6, 0, 0)

    def test_all_files_fills_to_ceiling(self):
        # 30 files only: floors (6,0,0,0)=6, budget 18 leaves 12 slack.
        # files ceiling is 12, so 6 of the slack flows to files reaching its
        # ceiling; the remaining 6 has nowhere to go (no bash/web/skill items).
        assert _allocate_recovery_slots(30, 0, 0) == (12, 0, 0, 0)

    def test_files_empty_redistributes_to_bash_and_web(self):
        # 0 files, 20 bash, 20 web, 0 skills: floors (0,4,4,0)=8, leaves 10.
        # Priority: skills (0 candidates → skip), files (0 candidates → skip),
        # bash absorbs +6 to its ceiling (10), web absorbs remaining +4 to its
        # ceiling (8).  Final: (0, 10, 8, 0).
        assert _allocate_recovery_slots(0, 20, 20) == (0, 10, 8, 0)

    def test_under_floor_only_takes_what_exists(self):
        # 2 files, 1 bash, 1 web, 0 skills: each section caps at its true item
        # count, so the sum is 4 rather than 18.
        assert _allocate_recovery_slots(2, 1, 1) == (2, 1, 1, 0)

    def test_zero_input_returns_zeros(self):
        assert _allocate_recovery_slots(0, 0, 0) == (0, 0, 0, 0)

    def test_total_never_exceeds_budget(self):
        # Stress: every section has unlimited items.  Sum must equal the total
        # budget regardless of how greedy the expansion gets.
        files, bash, web, skill = _allocate_recovery_slots(100, 100, 100, 100)
        assert files + bash + web + skill == hooks_session._RECOVERY_TOTAL_ITEMS
        assert files <= hooks_session._RECOVERY_FILES_CEILING
        assert bash <= hooks_session._RECOVERY_BASH_CEILING
        assert web <= hooks_session._RECOVERY_WEB_CEILING
        assert skill <= hooks_session._RECOVERY_SKILL_CEILING

    def test_skills_get_priority_when_present(self):
        # With items in every section, skills (highest priority) claim their
        # floor first and then get expanded from slack.  Files still gets
        # ceiling-pinned because its ceiling is highest.
        files, bash, web, skill = _allocate_recovery_slots(50, 50, 50, 50)
        # Total still bounded:
        assert files + bash + web + skill == hooks_session._RECOVERY_TOTAL_ITEMS
        assert skill >= hooks_session._RECOVERY_MAX_SKILL


class TestRecoverySkillChecklist:
    """Recovery hint inlines checklist sections instead of recall commands."""

    def test_checklist_inlined_not_recall_command(self, tmp_data_dir):
        """Store a skill body with ## DoD; recovery hint must contain DoD text, not just recall."""
        sid = "rec-checklist-1"
        dod_lines = "- All tests pass\n- Lint clean\n- Mypy clean"
        body = f"# ralph\n\nIntro text here.\n\n## DoD\n\n{dod_lines}\n\n## Other\n\nnot this\n"
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Checklist content must be inlined.
        assert "All tests pass" in ctx, f"DoD text missing from hint:\n{ctx}"
        assert "Lint clean" in ctx
        # Should NOT fall back to recall command for this entry.
        assert "token-goat skill-body ralph" not in ctx, (
            f"recall command leaked into hint that should have inline checklist:\n{ctx}"
        )

    def test_fallback_when_body_has_no_checklist(self, tmp_data_dir):
        """Body stored with no ## DoD / ## Checklist — falls back to recall command."""
        sid = "rec-checklist-2"
        body = "# ralph\n\n## Overview\n\nJust an overview.\n\n## Usage\n\nUsage text.\n" + ("x" * 300)
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "ralph" in ctx
        assert "token-goat skill-body ralph" in ctx, (
            f"fallback recall command missing for skill without checklist:\n{ctx}"
        )

    def test_fallback_when_no_body_stored(self, tmp_data_dir):
        """Session has skill_history entry but no body in cache — falls back to recall."""
        sid = "rec-checklist-3"
        # Mark skill loaded with a bogus output_id (body never written to disk).
        session.mark_skill_loaded(sid, "ralph", "nonexistent-id", "sha", 25_000, False)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "ralph" in ctx
        assert "token-goat skill-body ralph" in ctx

    def test_checklist_capped_at_400_chars(self, tmp_data_dir):
        """Long DoD sections are capped so the hint doesn't balloon."""
        sid = "rec-checklist-4"
        long_dod = "- criterion item\n" * 100  # >> 400 chars
        body = f"# ralph\n\n## DoD\n\n{long_dod}\n## End\n"
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # Skill block should contain inlined content — count chars of that block.
        assert "criterion item" in hint
        # Full 100-item list (~1700 chars) must not be present.
        assert hint.count("criterion item") < 50, "DoD section not capped in recovery hint"


class TestSkillDedup:
    """Recovery hint deduplicates skill bodies by content_sha across loads."""

    def test_same_sha_three_loads_shows_count_badge(self, tmp_data_dir):
        """3 loads of same skill body → ONE entry with ×3 badge, not 3 lines."""
        sid = "dedup-same-sha-1"
        body = "# ralph\n\n## Overview\n\nJust an overview.\n" + ("x" * 300)
        # Store once — same sha means same output_id (idempotent).
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        # Simulate 3 loads: mark_skill_loaded increments run_count each time.
        for _ in range(3):
            session.mark_skill_loaded(
                sid, meta.skill_name, meta.output_id, meta.content_sha,
                meta.body_bytes, meta.truncated,
            )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # ×3 badge must appear exactly once.
        assert "×3" in hint, f"Expected ×3 count badge:\n{hint}"
        # Should not appear as three separate ralph lines.
        ralph_lines = [ln for ln in hint.splitlines() if "ralph" in ln and ln.strip().startswith("-")]
        assert len(ralph_lines) == 1, f"Expected 1 ralph line, got {len(ralph_lines)}:\n{hint}"

    def test_different_sha_shows_both_with_sha8_suffix(self, tmp_data_dir):
        """2 loads of same skill with different sha → BOTH listed with sha[:8] suffix."""
        sid = "dedup-diff-sha-1"
        body_v1 = "# ralph\n\n## Overview\n\nVersion 1 body.\n" + ("a" * 300)
        body_v2 = "# ralph\n\n## Overview\n\nVersion 2 body.\n" + ("b" * 300)
        meta1 = skill_cache.store_output(sid, "ralph", body_v1)
        meta2 = skill_cache.store_output(sid, "ralph", body_v2)
        assert meta1 is not None
        assert meta2 is not None
        assert meta1.content_sha != meta2.content_sha

        # Simulate v1 load then v2 load — session keeps latest (meta2).
        session.mark_skill_loaded(sid, "ralph", meta1.output_id, meta1.content_sha, meta1.body_bytes, meta1.truncated)
        session.mark_skill_loaded(sid, "ralph", meta2.output_id, meta2.content_sha, meta2.body_bytes, meta2.truncated)

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # Both sha8 prefixes must appear.
        assert meta1.content_sha[:8] in hint, f"sha8 of v1 missing:\n{hint}"
        assert meta2.content_sha[:8] in hint, f"sha8 of v2 missing:\n{hint}"
        # Both should be listed as ralph entries.
        ralph_lines = [ln for ln in hint.splitlines() if "ralph" in ln and ln.strip().startswith("-")]
        assert len(ralph_lines) == 2, f"Expected 2 ralph lines (one per sha), got {len(ralph_lines)}:\n{hint}"

    def test_single_load_no_count_badge(self, tmp_data_dir):
        """1 load → no ×N suffix in the hint."""
        sid = "dedup-single-1"
        body = "# improve\n\n## Overview\n\nContent.\n" + ("y" * 300)
        meta = skill_cache.store_output(sid, "improve", body)
        assert meta is not None
        session.mark_skill_loaded(sid, meta.skill_name, meta.output_id, meta.content_sha, meta.body_bytes, meta.truncated)
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "×" not in hint, f"Unexpected ×N badge for single load:\n{hint}"
        assert "improve" in hint

    def test_mixed_two_skills_one_dup_one_single(self, tmp_data_dir):
        """2 skills: ralph loaded 2× (same sha), improve loaded 1× → 2 entries total."""
        sid = "dedup-mixed-1"
        body_r = "# ralph\n\n## Overview\n\nRalph body.\n" + ("r" * 300)
        body_i = "# improve\n\n## Overview\n\nImprove body.\n" + ("i" * 300)
        meta_r = skill_cache.store_output(sid, "ralph", body_r)
        meta_i = skill_cache.store_output(sid, "improve", body_i)
        assert meta_r is not None and meta_i is not None

        # ralph loaded twice (same sha).
        session.mark_skill_loaded(sid, "ralph", meta_r.output_id, meta_r.content_sha, meta_r.body_bytes, meta_r.truncated)
        session.mark_skill_loaded(sid, "ralph", meta_r.output_id, meta_r.content_sha, meta_r.body_bytes, meta_r.truncated)
        # improve loaded once.
        session.mark_skill_loaded(sid, "improve", meta_i.output_id, meta_i.content_sha, meta_i.body_bytes, meta_i.truncated)

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # ralph must show ×2; improve must appear without badge.
        assert "ralph" in hint
        assert "improve" in hint
        ralph_lines = [ln for ln in hint.splitlines() if "ralph" in ln and ln.strip().startswith("-")]
        improve_lines = [ln for ln in hint.splitlines() if "improve" in ln and ln.strip().startswith("-")]
        assert len(ralph_lines) == 1, f"Expected 1 ralph line, got {len(ralph_lines)}:\n{hint}"
        assert len(improve_lines) == 1, f"Expected 1 improve line, got {len(improve_lines)}:\n{hint}"
        # ralph must have ×2 badge somewhere on its line or nearby.
        ralph_block = "\n".join(ralph_lines)
        assert "×2" in ralph_block, f"×2 badge missing from ralph block:\n{hint}"


class TestRecoveryStatAccounting:
    """compact_recovery must record its injection overhead like sibling hint kinds.

    Before this fix the stat block only wrote the base ``compact_recovery`` row
    (0 savings, 0 bytes) and omitted the ``compact_recovery_overhead`` negative
    row, leaving an honest-accounting gap vs. session_hint / diff_hint /
    bash_dedup_hint.
    """

    def test_overhead_row_recorded_when_hint_fires(self, tmp_data_dir):
        """When _try_recovery_response emits a hint it must write a negative
        compact_recovery_overhead row whose bytes_saved and tokens_saved are
        both negative and non-zero."""
        from token_goat import db

        sid = "rec-overhead-1"
        _seed_state(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, bytes_saved, tokens_saved FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()

        by_kind = {r["kind"]: r for r in rows}
        assert "compact_recovery" in by_kind, "base row must be present"
        assert "compact_recovery_overhead" in by_kind, (
            "overhead row must be present — compact_recovery injects real tokens"
        )
        overhead = by_kind["compact_recovery_overhead"]
        assert overhead["bytes_saved"] < 0, "overhead bytes_saved must be negative"
        assert overhead["tokens_saved"] < 0, "overhead tokens_saved must be negative"

    def test_no_overhead_row_when_hint_not_fired(self, tmp_data_dir):
        """When no hint is emitted (empty session) no overhead row should appear."""
        from token_goat import db

        sid = "rec-overhead-2"
        # No state seeded — empty session → hint suppressed.
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
        })

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()

        kinds = {r["kind"] for r in rows}
        assert "compact_recovery" not in kinds, "base row must not appear when hint suppressed"
        assert "compact_recovery_overhead" not in kinds, "overhead row must not appear when hint suppressed"

    def test_base_row_has_zero_savings(self, tmp_data_dir):
        """The base compact_recovery row must claim 0 savings — savings are
        realised downstream under bash_dedup_hint / web_dedup_hint."""
        from token_goat import db

        sid = "rec-overhead-3"
        _seed_state(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT bytes_saved, tokens_saved FROM stats WHERE kind = 'compact_recovery'"
            ).fetchone()

        assert row is not None
        assert row["bytes_saved"] == 0
        assert row["tokens_saved"] == 0
