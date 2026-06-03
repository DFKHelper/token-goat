"""Tests for the post-compaction recovery hint path in session_start."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_session, paths, session, skill_cache
from token_goat.hooks_session import _allocate_recovery_slots


def _read_sidecar(sid: str) -> str:
    """Return sidecar content for *sid*, asserting it exists."""
    sidecar = paths.recovery_pending_path(sid)
    assert sidecar.exists(), f"recovery sidecar not found for session {sid!r}"
    return sidecar.read_text(encoding="utf-8")


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
        """Compact SessionStart writes hint to sidecar; sidecar contains expected content."""
        sid = "rec-4"
        _seed_state(sid)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        # Item 2: hint is now deferred — no additionalContext at SessionStart.
        assert "hookSpecificOutput" not in result, (
            "compact SessionStart must not inject hint inline (deferred sidecar model)"
        )
        # The sidecar must exist with the expected content.
        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "recovery sidecar must be written on compact SessionStart"
        ctx = sidecar.read_text(encoding="utf-8")
        assert "Post-Compact Recovery" in ctx
        assert "/proj/src/auth.py" in ctx
        # CS20 collapses green pytest entries to "✓ pytest passed @ HH:MM"
        # when the session has edits; fall back to the raw command otherwise.
        assert "pytest" in ctx
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
        ctx = _read_sidecar(sid)
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
        ctx = _read_sidecar(sid)
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
        ctx = _read_sidecar(sid)
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
        # No file activity, only one tiny bash entry → no hint emitted; no sidecar.
        assert "hookSpecificOutput" not in result
        assert not paths.recovery_pending_path(sid).exists(), (
            "sidecar must not be created when hint is suppressed"
        )


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
    """Recovery hint surfaces skill names with a recall-command pointer.

    NOTE: commit 6fc1c46 (refactor: collapse skill list to single-line format)
    intentionally dropped the inlined-checklist feature and the per-skill
    bullet structure. The new format is a one-line summary:
    ``### Active Skills: name1, name2 (recall via `token-goat skill-body <name>`)``.
    Inlined DoD/Checklist sections, sha8 dedup, and ×N count badges are
    no longer emitted — the agent is pointed at `token-goat skill-body
    <name> --section DoD` to retrieve a section on demand. These tests
    now verify the simplified contract: the skill name appears once and
    the recall pointer is present.
    """

    def test_checklist_inlined_not_recall_command(self, tmp_data_dir):
        """Skill name and recall pointer present even when body has a ## DoD section."""
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
        ctx = _read_sidecar(sid)
        assert "ralph" in ctx, f"skill name missing from hint:\n{ctx}"
        # Single-line format points at the recall command rather than inlining.
        assert "token-goat skill-body <name>" in ctx
        # The --section pointer tells the agent how to fetch DoD on demand.
        assert "--section DoD" in ctx

    def test_fallback_when_body_has_no_checklist(self, tmp_data_dir):
        """Skill without a checklist heading still appears with the recall pointer."""
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
        ctx = _read_sidecar(sid)
        assert "ralph" in ctx
        assert "token-goat skill-body <name>" in ctx, (
            f"recall command missing for skill without checklist:\n{ctx}"
        )

    def test_fallback_when_no_body_stored(self, tmp_data_dir):
        """skill_history entry without a cached body still surfaces name + recall."""
        sid = "rec-checklist-3"
        # Mark skill loaded with a bogus output_id (body never written to disk).
        session.mark_skill_loaded(sid, "ralph", "nonexistent-id", "sha", 25_000, False)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        ctx = _read_sidecar(sid)
        assert "ralph" in ctx
        assert "token-goat skill-body <name>" in ctx

    def test_checklist_capped_at_400_chars(self, tmp_data_dir):
        """Long bodies cannot inflate the hint — single-line summary is bounded.

        Old contract inlined a capped DoD section. New contract emits a
        single-line summary regardless of body length, so the bound is
        even tighter — verify the skill-name line is short and the body
        text itself does not leak in.
        """
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
        # Body content must NOT inline into the single-line summary.
        assert "criterion item" not in hint, (
            "DoD body text leaked into single-line skill summary"
        )
        assert "ralph" in hint
        # The single-line skill summary stays short.
        skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
        assert skill_lines, f"Skill summary line missing:\n{hint}"
        assert len(skill_lines[0]) < 400, (
            f"Skill summary line should be tight, got {len(skill_lines[0])} chars"
        )


class TestSkillDedup:
    """Recovery hint emits each loaded skill name exactly once.

    NOTE: The skill section uses a ``### Active Skills: name1, name2`` format
    (### heading for consistency with the pre-compact manifest) with skill names
    inline on the header line. These tests verify each skill name appears exactly
    once on the summary line regardless of how many times it was loaded.
    """

    def test_same_sha_three_loads_shows_count_badge(self, tmp_data_dir):
        """3 loads of same skill → name appears exactly once on the summary line."""
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
        # Single-line summary: ralph appears exactly once.
        skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
        assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
        assert skill_lines[0].count("ralph") == 1, (
            f"Expected ralph to appear once in summary:\n{skill_lines[0]}"
        )

    def test_different_sha_shows_both_with_sha8_suffix(self, tmp_data_dir):
        """2 loads of same skill name → name listed once (latest body wins)."""
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
        # Single-line summary: ralph appears once. The latest body is
        # what `token-goat skill-body ralph` resolves to.
        skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
        assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
        assert skill_lines[0].count("ralph") == 1, (
            f"Expected ralph to appear once in summary:\n{skill_lines[0]}"
        )

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
        """ralph loaded 2× + improve loaded 1× → summary line names both once."""
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
        # Single-line summary contains both names exactly once.
        skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
        assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
        summary = skill_lines[0]
        assert summary.count("ralph") == 1, f"Expected ralph once:\n{summary}"
        assert summary.count("improve") == 1, f"Expected improve once:\n{summary}"

    def test_recent_skill_no_stale_flag_in_hint(self, tmp_data_dir):
        """Recently-loaded skills (< 6 hours) don't get a stale flag in the hint."""
        from unittest.mock import patch

        sid = "dedup-recent-1"
        body = "# improve\n\n## Overview\n\nImprove body.\n" + ("i" * 300)
        meta = skill_cache.store_output(sid, "improve", body)
        assert meta is not None

        # Load skill at time T
        base_time = 1000.0
        with patch("time.time", return_value=base_time):
            session.mark_skill_loaded(sid, "improve", meta.output_id, meta.content_sha, meta.body_bytes, meta.truncated)

        # Now check the hint at time T+1h (skill is 1 hour old, below 6h threshold)
        with patch("time.time", return_value=base_time + 3600):
            hint = hooks_session._build_recovery_hint(sid)
            assert hint is not None
            # Skill summary should NOT flag staleness (1 hour old < 6 hour threshold)
            skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
            assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
            assert "(stale:" not in skill_lines[0], (
                f"Recent skill should not be flagged as stale:\n{skill_lines[0]}"
            )
            assert "improve" in skill_lines[0]

    def test_stale_skill_flagged_in_recovery_hint(self, tmp_data_dir):
        """Skills loaded >6 hours ago are flagged with (stale: Xh) in recovery hint."""
        from unittest.mock import patch

        sid = "dedup-stale-1"
        body = "# ralph\n\n## Overview\n\nRalph body.\n" + ("r" * 300)
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None

        # Load skill at time T
        base_time = 1000.0
        with patch("time.time", return_value=base_time):
            session.mark_skill_loaded(sid, "ralph", meta.output_id, meta.content_sha, meta.body_bytes, meta.truncated)

        # Now check the hint at time T+7h (skill is 7 hours old, above 6h threshold)
        with patch("time.time", return_value=base_time + (7 * 3600)):
            hint = hooks_session._build_recovery_hint(sid)
            assert hint is not None
            # Skill summary should flag staleness
            skill_lines = [ln for ln in hint.splitlines() if "### Active Skills" in ln]
            assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
            assert "(stale: 7h)" in skill_lines[0], (
                f"Expected staleness flag (stale: 7h) in:\n{skill_lines[0]}"
            )
            assert "ralph" in skill_lines[0]


class TestRecoveryStatAccounting:
    """compact_recovery and compact_recovery_overhead rows are written when the hint fires.

    The savings row (compact_recovery) records the estimated bytes/tokens of
    bash and web content the model would otherwise need to re-run or re-fetch.
    The overhead row (compact_recovery_overhead) records the negative cost of
    injecting the hint text.  Both rows are absent when no hint is emitted
    (empty session → hint suppressed).
    """

    def test_stat_rows_written_when_hint_fires(self, tmp_data_dir):
        """compact_recovery and compact_recovery_overhead rows appear after hint injection."""
        from token_goat import db, hooks_read

        sid = "rec-overhead-1"
        _seed_state(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        # After session_start the sidecar is written but stats are not yet recorded
        # (stats are recorded when the sidecar is consumed on the first pre-read).
        with db.open_global() as conn:
            after_start = {r["kind"] for r in conn.execute(
                "SELECT kind FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()}
        assert "compact_recovery" not in after_start, (
            "recovery row must not appear at session_start (deferred to first pre-read)"
        )

        # Trigger pre_read — the sidecar is consumed and both stat rows are written.
        hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py"},
        })

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, bytes_saved, tokens_saved FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()

        kinds = {r["kind"] for r in rows}
        assert "compact_recovery" in kinds, (
            "compact_recovery savings row must be written when hint fires"
        )
        assert "compact_recovery_overhead" in kinds, (
            "compact_recovery_overhead cost row must be written when hint fires"
        )

        # Savings row: bytes_saved and tokens_saved must be positive (bash + web bytes).
        savings_rows = [r for r in rows if r["kind"] == "compact_recovery"]
        assert savings_rows, "compact_recovery savings row missing"
        savings = savings_rows[0]
        assert savings["bytes_saved"] > 0, (
            f"compact_recovery bytes_saved must be positive, got {savings['bytes_saved']}"
        )
        assert savings["tokens_saved"] > 0, (
            f"compact_recovery tokens_saved must be positive, got {savings['tokens_saved']}"
        )

        # Overhead row: bytes_saved and tokens_saved must be negative (injection cost).
        overhead_rows = [r for r in rows if r["kind"] == "compact_recovery_overhead"]
        assert overhead_rows, "compact_recovery_overhead row missing"
        overhead = overhead_rows[0]
        assert overhead["bytes_saved"] < 0, (
            f"compact_recovery_overhead bytes_saved must be negative, got {overhead['bytes_saved']}"
        )
        assert overhead["tokens_saved"] < 0, (
            f"compact_recovery_overhead tokens_saved must be negative, got {overhead['tokens_saved']}"
        )

    def test_no_stat_rows_when_hint_not_fired(self, tmp_data_dir):
        """When no hint is emitted (empty session) neither stat row should appear."""
        from token_goat import db

        sid = "rec-overhead-2"
        # No state seeded — empty session → hint suppressed → no sidecar written.
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

    def test_savings_reflect_bash_and_web_bytes(self, tmp_data_dir):
        """compact_recovery bytes_saved equals sum of bash + web bytes in session cache."""
        from token_goat import db, hooks_read

        sid = "rec-overhead-3"
        # Seed known byte counts so we can verify the savings estimate.
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=100)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="aabbccdd11223344",
            cmd_preview="uv run pytest",
            output_id=f"{sid[:16]}-0000000000001-aabbccdd11223344",
            stdout_bytes=5000,
            stderr_bytes=500,
            exit_code=0,
            truncated=False,
        )
        session.mark_web_fetch(
            session_id=sid,
            url_sha="deadbeef00112233",
            url_preview="https://example.com/api",
            output_id=f"{sid[:16]}-0000000000002-deadbeef00112233",
            body_bytes=3000,
            status_code=200,
            truncated=False,
        )

        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py"},
        })

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT bytes_saved, tokens_saved FROM stats WHERE kind = 'compact_recovery'"
            ).fetchone()

        assert row is not None, "compact_recovery savings row must be written"
        # Expected: 5000 + 500 (bash) + 3000 (web) = 8500 bytes
        expected_bytes = 8500
        assert row["bytes_saved"] == expected_bytes, (
            f"bytes_saved={row['bytes_saved']} expected {expected_bytes} "
            f"(bash 5500 + web 3000)"
        )


class TestEstimateRecoveryContextBytes:
    """Unit tests for _estimate_recovery_context_bytes (hooks_read module)."""

    def test_returns_zero_for_empty_cache(self):
        """No bash/web history → 0 bytes estimated."""
        from unittest.mock import MagicMock

        from token_goat.hooks_read import _estimate_recovery_context_bytes

        cache = MagicMock()
        cache.bash_history = {}
        cache.web_history = {}
        assert _estimate_recovery_context_bytes(cache) == 0

    def test_sums_bash_stdout_stderr(self):
        """Bash stdout + stderr bytes are both included in the total."""
        from unittest.mock import MagicMock

        from token_goat.hooks_read import _estimate_recovery_context_bytes
        from token_goat.session import BashEntry

        be = BashEntry(
            cmd_sha="abc",
            cmd_preview="pytest",
            output_id="oid1",
            ts=1.0,
            stdout_bytes=2000,
            stderr_bytes=300,
            exit_code=0,
            truncated=False,
        )
        cache = MagicMock()
        cache.bash_history = {"abc": be}
        cache.web_history = {}
        assert _estimate_recovery_context_bytes(cache) == 2300

    def test_sums_web_body_bytes(self):
        """Web body bytes are included in the total."""
        from unittest.mock import MagicMock

        from token_goat.hooks_read import _estimate_recovery_context_bytes
        from token_goat.session import WebEntry

        we = WebEntry(
            url_sha="xyz",
            url_preview="https://example.com",
            output_id="oid2",
            ts=2.0,
            body_bytes=4000,
            status_code=200,
            truncated=False,
        )
        cache = MagicMock()
        cache.bash_history = {}
        cache.web_history = {"xyz": we}
        assert _estimate_recovery_context_bytes(cache) == 4000

    def test_sums_bash_and_web_combined(self):
        """Combined bash + web bytes are summed correctly."""
        from unittest.mock import MagicMock

        from token_goat.hooks_read import _estimate_recovery_context_bytes
        from token_goat.session import BashEntry, WebEntry

        be = BashEntry(
            cmd_sha="b1",
            cmd_preview="cmd",
            output_id="o1",
            ts=1.0,
            stdout_bytes=1000,
            stderr_bytes=200,
            exit_code=0,
            truncated=False,
        )
        we = WebEntry(
            url_sha="w1",
            url_preview="https://x.com",
            output_id="o2",
            ts=2.0,
            body_bytes=3000,
            status_code=200,
            truncated=False,
        )
        cache = MagicMock()
        cache.bash_history = {"b1": be}
        cache.web_history = {"w1": we}
        # 1000 + 200 + 3000 = 4200
        assert _estimate_recovery_context_bytes(cache) == 4200

    def test_fail_soft_on_missing_attributes(self):
        """Broken cache object returns 0 (fail-soft)."""
        from token_goat.hooks_read import _estimate_recovery_context_bytes

        class BrokenCache:
            @property
            def bash_history(self):
                raise RuntimeError("no attribute")

        assert _estimate_recovery_context_bytes(BrokenCache()) == 0


class TestRecoveryHintTokenBudget:
    """Recovery hint respects the 400-token default budget."""

    def test_default_budget_is_400_tokens(self, tmp_data_dir):
        """Built hint is within the 400-token default budget (1600 chars)."""
        from token_goat.hooks_session import _build_recovery_hint

        sid = "budget-1"
        _seed_state(sid)
        hint = _build_recovery_hint(sid)
        assert hint is not None
        # 400 tokens × 4 chars/token = 1600 chars maximum
        assert len(hint) <= 1600, (
            f"hint length {len(hint)} exceeds 1600-char budget (400 tokens × 4 chars/token)"
        )


class TestResumeAnchor:
    """Recovery hint surfaces a 🎯 RESUME line matching the sealed-block format."""

    def test_resume_anchor_picks_top_edited_basename(self, tmp_data_dir):
        """When a file was edited, RESUME points at its basename."""
        sid = "anchor-1"
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=200)
        # Three edits to auth.py, one to other.py — auth.py wins.
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/other.py")
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # Resume line surfaces the basename, not the full path.
        resume_lines = [ln for ln in hint.splitlines() if "RESUME" in ln]
        assert len(resume_lines) == 1, f"Expected one RESUME line:\n{hint}"
        assert "auth.py" in resume_lines[0]
        # Bare basename — not the full /proj/src/ prefix.
        assert "/proj/src/auth.py" not in resume_lines[0]

    def test_resume_anchor_falls_back_to_blocker_cmd(self, tmp_data_dir):
        """No edits but a recent failing command → RESUME points at the cmd word."""
        sid = "anchor-2"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="fail0001",
            cmd_preview="pytest tests/",
            output_id=f"{sid[:16]}-0000000000099-fail0001",
            stdout_bytes=4000,
            stderr_bytes=1500,
            exit_code=1,
            truncated=False,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        resume_lines = [ln for ln in hint.splitlines() if "RESUME" in ln]
        assert len(resume_lines) == 1, f"Expected one RESUME line:\n{hint}"
        # Strip env/flag prefixes — should land on the binary "pytest".
        assert "pytest" in resume_lines[0]
        assert "re-run" in resume_lines[0]

    def test_resume_anchor_omitted_when_nothing_to_point_at(self, tmp_data_dir):
        """Reads-only session with no edits and no failures → no RESUME line."""
        sid = "anchor-3"
        # Reads only: no edits, no failing bash, but a green pytest (high signal).
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=100)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="ok0001",
            cmd_preview="pytest -q",
            output_id=f"{sid[:16]}-0000000000010-ok0001",
            stdout_bytes=8000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "RESUME" not in hint, (
            f"RESUME line should not appear when no edits and no failures:\n{hint}"
        )


class TestBlockersSection:
    """Active failing bash commands surface in a **Blockers** section with previews."""

    def test_blocker_section_renders_failed_pytest(self, tmp_data_dir):
        """A failed pytest run appears in the blockers section with exit code."""
        sid = "blk-1"
        # Seed cached output containing an AssertionError so the preview helper
        # has something to scan.  The output_id is computed by bash_cache from
        # (session_id, command) so we use the same command in mark_bash_run.
        from token_goat import bash_cache

        meta = bash_cache.store_output(
            sid,
            "pytest tests/test_x.py",
            "running tests...\n"
            "FAILED tests/test_x.py::test_foo - AssertionError: expected 5 got 4\n"
            "1 failed, 3 passed\n",
            "",
            1,
        )
        assert meta is not None
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=meta.cmd_sha,
            cmd_preview="pytest tests/test_x.py",
            output_id=meta.output_id,
            stdout_bytes=meta.stdout_bytes,
            stderr_bytes=meta.stderr_bytes,
            exit_code=1,
            truncated=False,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Blockers**" in hint, (
            f"Blockers section missing from hint:\n{hint}"
        )
        assert "pytest tests/test_x.py" in hint
        # Exit code is surfaced verbatim.
        assert "(exit 1)" in hint
        # Preview pulls a discriminating line (AssertionError) from the cache.
        assert "AssertionError" in hint, (
            f"Blocker error preview missing AssertionError:\n{hint}"
        )

    def test_blocker_section_skipped_when_all_green(self, tmp_data_dir):
        """No failing commands → no Blockers section."""
        sid = "blk-2"
        # All exit_code=0 — nothing to surface.
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="green01",
            cmd_preview="pytest -q",
            output_id=f"{sid[:16]}-0000000000200-green01",
            stdout_bytes=4000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        session.mark_file_read(sid, "/proj/foo.py", offset=0, limit=50)
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Blockers**" not in hint, (
            f"Blockers section should be omitted when all commands pass:\n{hint}"
        )

    def test_blocker_section_lists_recall_command(self, tmp_data_dir):
        """The Blockers section names the bash-output recall command."""
        sid = "blk-3"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="failcmd1",
            cmd_preview="make build",
            output_id=f"{sid[:16]}-0000000000300-failcmd1",
            stdout_bytes=1000,
            stderr_bytes=2000,
            exit_code=2,
            truncated=False,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Blockers**" in hint
        # The recall pointer tells the agent where the full output lives.
        assert "token-goat bash-output" in hint


class TestEditCountBadges:
    """File entries surface ✎×N badges when the file was edited in-session."""

    def test_edit_count_appears_for_edited_file(self, tmp_data_dir):
        """A file edited 3× shows ✎×3 next to its path in the Files section."""
        sid = "ec-1"
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=200)
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_edited(sid, "/proj/src/auth.py")
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        # Locate the auth.py line in the Files section.
        auth_lines = [ln for ln in hint.splitlines() if "auth.py" in ln and ln.startswith("- ")]
        assert auth_lines, f"auth.py file entry missing:\n{hint}"
        assert "✎×3" in auth_lines[0], (
            f"edit-count badge ✎×3 missing from auth.py entry: {auth_lines[0]!r}"
        )

    def test_no_badge_for_unedited_file(self, tmp_data_dir):
        """A read-only file gets no ✎ badge."""
        sid = "ec-2"
        session.mark_file_read(sid, "/proj/src/readonly.py", offset=0, limit=100)
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        readonly_lines = [ln for ln in hint.splitlines() if "readonly.py" in ln]
        assert readonly_lines
        assert "✎" not in readonly_lines[0], (
            f"unedited file should not have ✎ badge: {readonly_lines[0]!r}"
        )


class TestRecoveryCli:
    """``token-goat recovery <session_id>`` surfaces the same hint shape."""

    def test_recovery_cli_renders_hint(self, tmp_data_dir):
        """CLI prints the recovery hint for a seeded session."""
        import uuid

        from typer.testing import CliRunner

        from token_goat.cli import app

        sid = str(uuid.uuid4())
        _seed_state(sid)
        runner = CliRunner()
        result = runner.invoke(app, ["recovery", sid[:8]])
        assert result.exit_code == 0, result.output
        assert "Post-Compact Recovery" in result.output
        assert "auth.py" in result.output

    def test_recovery_cli_pending_reads_sidecar(self, tmp_data_dir):
        """``--pending`` reads the deferred sidecar instead of rebuilding."""
        import uuid

        from typer.testing import CliRunner

        from token_goat.cli import app

        sid = str(uuid.uuid4())
        _seed_state(sid)
        # Trigger SessionStart with source=compact → writes sidecar.
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        runner = CliRunner()
        result = runner.invoke(app, ["recovery", sid[:8], "--pending"])
        assert result.exit_code == 0, result.output
        assert "Post-Compact Recovery" in result.output

    def test_recovery_cli_pending_warns_when_no_sidecar(self, tmp_data_dir):
        """``--pending`` exits 0 with a warning when no sidecar exists."""
        import uuid

        from typer.testing import CliRunner

        from token_goat.cli import app

        sid = str(uuid.uuid4())
        _seed_state(sid)
        # No SessionStart fired → no sidecar.
        runner = CliRunner()
        result = runner.invoke(app, ["recovery", sid[:8], "--pending"])
        # Exit code 0: this is informational, not an error.
        assert result.exit_code == 0, result.output

    def test_recovery_cli_unknown_short_id_exits_nonzero(self, tmp_data_dir):
        """Unknown short id → exit 1 with an error."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["recovery", "00000000"])
        assert result.exit_code == 1


class TestRecoveryPendingAtomicWrite:
    """The recovery_pending sentinel must be written via paths.atomic_write_text.

    A non-atomic write can leave a partially-written hint file if the process is
    killed mid-write (common on Windows where large write_text calls may not be
    atomic at the OS level).  The pre-read hook reads this file on the next tool
    call; a torn read would surface a garbled recovery hint to the model.
    """

    def test_recovery_pending_uses_atomic_write_text(self, tmp_data_dir, monkeypatch):
        """_try_recovery_response must write the sidecar via paths.atomic_write_text.

        The recovery_pending sidecar carries the full recovery hint JSON; a torn
        partial write would surface garbled content to the model on the next tool call.
        The sidecar format is JSON: {"hint": "<hint text>", "bytes_estimate": N}.
        """
        import json as _json

        from token_goat import hooks_session, paths

        HINT_TEXT = "## Compact Recovery\n- file1.py edited\n"
        monkeypatch.setattr(hooks_session, "_build_recovery_hint", lambda _sid: HINT_TEXT)

        atomic_calls: list[tuple[object, str]] = []
        original_atomic = paths.atomic_write_text

        def _spy(path, content):
            if "recovery_pending" in str(path):
                atomic_calls.append((path, content))
            original_atomic(path, content)

        monkeypatch.setattr(paths, "atomic_write_text", _spy)

        sid = "recovery-atomic-test-001"
        result = hooks_session._try_recovery_response(sid, "compact")

        assert result is None, "_try_recovery_response must return None"
        assert atomic_calls, "atomic_write_text was not called for recovery_pending sidecar"
        sidecar_path, content = atomic_calls[0]
        assert "recovery_pending" in str(sidecar_path)
        # Sidecar is now JSON with hint text embedded.
        data = _json.loads(content)
        assert data["hint"] == HINT_TEXT, (
            f"sidecar JSON hint field must equal the hint text; got: {data!r}"
        )
        assert "bytes_estimate" in data, "sidecar JSON must contain bytes_estimate field"


class TestPrecompactEstimateSentinel:
    """Tests for the precompact estimate sentinel written by the PreCompact hook.

    The PreCompact hook writes ``sentinels/precompact_estimate_{session_id}.json``
    while the session cache still has bash/web history.  The SessionStart handler
    reads this sentinel to embed a non-zero bytes_estimate in the recovery_pending
    sidecar, fixing the bug where compact_recovery stats always showed 0 bytes_saved.
    """

    def test_precompact_writes_estimate_sentinel(self, tmp_data_dir):
        """pre_compact writes a precompact_estimate sentinel with bash/web byte counts."""
        import json as _json

        from token_goat import hooks_cli, session

        sid = "precompact-est-1"
        # Seed known byte counts.
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="aaaa1111bbbb2222",
            cmd_preview="pytest tests/",
            output_id=f"{sid[:16]}-0000000000001-aaaa1111bbbb2222",
            stdout_bytes=7000,
            stderr_bytes=200,
            exit_code=0,
            truncated=False,
        )
        session.mark_web_fetch(
            session_id=sid,
            url_sha="cccc3333dddd4444",
            url_preview="https://docs.example.com",
            output_id=f"{sid[:16]}-0000000000002-cccc3333dddd4444",
            body_bytes=4500,
            status_code=200,
            truncated=False,
        )

        # Run pre_compact to trigger sentinel write.
        hooks_cli.pre_compact({"session_id": sid, "trigger": "manual"})

        sentinel = paths.precompact_estimate_path(sid)
        assert sentinel.exists(), "precompact_estimate sentinel must be written by pre_compact"
        data = _json.loads(sentinel.read_text(encoding="utf-8"))
        assert data["bash_count"] == 1, f"bash_count mismatch: {data}"
        assert data["web_count"] == 1, f"web_count mismatch: {data}"
        # bytes_estimate = 7000 + 200 (bash) + 4500 (web) = 11700
        assert data["bytes_estimate"] == 11700, (
            f"bytes_estimate={data['bytes_estimate']} expected 11700 (bash 7200 + web 4500)"
        )
        assert data["session_id"] == sid

    def test_recovery_sidecar_contains_estimate_from_sentinel(self, tmp_data_dir):
        """_try_recovery_response embeds bytes_estimate from precompact sentinel in the sidecar JSON."""
        import json as _json

        from token_goat import hooks_session, paths, session

        sid = "precompact-est-2"
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="bbbb2222cccc3333",
            cmd_preview="uv run pytest",
            output_id=f"{sid[:16]}-0000000000001-bbbb2222cccc3333",
            stdout_bytes=6000,
            stderr_bytes=300,
            exit_code=0,
            truncated=False,
        )

        # Simulate PreCompact writing the estimate sentinel.
        sentinel = paths.precompact_estimate_path(sid)
        paths.ensure_dir(sentinel.parent)
        sentinel.write_text(
            _json.dumps(
                {"bytes_estimate": 6300, "bash_count": 1, "web_count": 0, "session_id": sid, "ts": 1.0},
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

        # SessionStart reads sentinel and embeds it in sidecar.
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "recovery sidecar must be written by compact SessionStart"
        data = _json.loads(sidecar.read_text(encoding="utf-8"))
        assert "hint" in data, "sidecar must have 'hint' field"
        assert "bytes_estimate" in data, "sidecar must have 'bytes_estimate' field"
        assert data["bytes_estimate"] == 6300, (
            f"bytes_estimate={data['bytes_estimate']} expected 6300 from sentinel"
        )
        # Sentinel must be consumed (deleted) after being read.
        assert not sentinel.exists(), "precompact_estimate sentinel must be deleted after being read"

    def test_full_roundtrip_compact_recovery_stat_nonzero(self, tmp_data_dir):
        """Full round-trip: pre_compact → session_start(compact) → pre_read → stat has nonzero bytes_saved.

        This is the core regression test for the compact_recovery estimation bug.
        In the bug: _estimate_recovery_context_bytes read from the empty new session cache
        and always returned 0.  With the fix, the estimate is stored in the precompact
        sentinel during PreCompact (when the session has data) and surfaced via the sidecar.
        """
        import json as _json

        from token_goat import db, hooks_cli, hooks_read, hooks_session, session

        sid = "precompact-est-roundtrip"
        # Seed bash and web history with known sizes.
        session.mark_file_read(sid, "/proj/src/main.py", offset=0, limit=200)
        session.mark_file_edited(sid, "/proj/src/main.py")
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="ffff0000aaaa1111",
            cmd_preview="uv run pytest tests/ -x",
            output_id=f"{sid[:16]}-0000000000001-ffff0000aaaa1111",
            stdout_bytes=9000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        session.mark_web_fetch(
            session_id=sid,
            url_sha="eeee9999cccc8888",
            url_preview="https://api.example.com/docs",
            output_id=f"{sid[:16]}-0000000000002-eeee9999cccc8888",
            body_bytes=5000,
            status_code=200,
            truncated=False,
        )
        # Expected total: 9000 (bash stdout) + 5000 (web body) = 14000 bytes.

        # Phase 1: PreCompact writes the estimate sentinel while cache has data.
        hooks_cli.pre_compact({"session_id": sid, "trigger": "manual"})

        sentinel = paths.precompact_estimate_path(sid)
        assert sentinel.exists(), "precompact_estimate sentinel must exist after pre_compact"
        est_data = _json.loads(sentinel.read_text(encoding="utf-8"))
        assert est_data["bytes_estimate"] == 14000, (
            f"PreCompact estimate={est_data['bytes_estimate']} expected 14000"
        )

        # Phase 2: SessionStart (source=compact) reads sentinel and embeds in sidecar.
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        # Sentinel must be consumed.
        assert not sentinel.exists(), "precompact_estimate sentinel must be consumed by session_start"

        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "recovery sidecar must exist after compact session_start"
        sidecar_data = _json.loads(sidecar.read_text(encoding="utf-8"))
        assert sidecar_data["bytes_estimate"] == 14000, (
            f"sidecar bytes_estimate={sidecar_data['bytes_estimate']} expected 14000"
        )

        # Phase 3: pre_read injects hint and records stats.
        hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/main.py"},
        })

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT bytes_saved, tokens_saved FROM stats WHERE kind = 'compact_recovery'"
            ).fetchone()

        assert row is not None, "compact_recovery stat row must be written after pre_read"
        assert row["bytes_saved"] == 14000, (
            f"compact_recovery bytes_saved={row['bytes_saved']} expected 14000 (bash 9000 + web 5000)"
        )
        assert row["tokens_saved"] > 0, (
            f"compact_recovery tokens_saved must be positive, got {row['tokens_saved']}"
        )
