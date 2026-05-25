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
    ``**Skills:** name1, name2 (recall via `token-goat skill-body <name>`)``.
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
        skill_lines = [ln for ln in hint.splitlines() if "**Skills:**" in ln]
        assert skill_lines, f"Skill summary line missing:\n{hint}"
        assert len(skill_lines[0]) < 400, (
            f"Skill summary line should be tight, got {len(skill_lines[0])} chars"
        )


class TestSkillDedup:
    """Recovery hint emits each loaded skill name exactly once.

    NOTE: commit 6fc1c46 collapsed the per-skill bullet list into a single
    ``**Skills:** name1, name2`` line and dropped sha8 differentiation and
    ×N count badges in the process. These tests now verify the simplified
    contract: each skill name appears exactly once on the summary line
    regardless of how many times it was loaded.
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
        skill_lines = [ln for ln in hint.splitlines() if "**Skills:**" in ln]
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
        skill_lines = [ln for ln in hint.splitlines() if "**Skills:**" in ln]
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
        skill_lines = [ln for ln in hint.splitlines() if "**Skills:**" in ln]
        assert len(skill_lines) == 1, f"Expected 1 skill summary line:\n{hint}"
        summary = skill_lines[0]
        assert summary.count("ralph") == 1, f"Expected ralph once:\n{summary}"
        assert summary.count("improve") == 1, f"Expected improve once:\n{summary}"


class TestRecoveryStatAccounting:
    """Neither compact_recovery nor compact_recovery_overhead rows are written.

    Both stat rows were dropped (Option A):
    - The zero-byte base ``compact_recovery`` row was noise (294 writes/month,
      0 bytes/tokens saved).
    - The ``compact_recovery_overhead`` row recorded only the cost side with
      no matching positive counterpart, making the compact bucket appear as a
      pure -N kt/month loss in ``token-goat stats``.
    The injection is still logged at INFO level for auditability.
    """

    def test_no_stat_rows_written_when_hint_fires(self, tmp_data_dir):
        """Neither base nor overhead row is written even when the hint fires;
        the injection is auditable via the INFO log."""
        from token_goat import db, hooks_read

        sid = "rec-overhead-1"
        _seed_state(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        # After session_start no stat rows should be present.
        with db.open_global() as conn:
            after_start = {r["kind"] for r in conn.execute(
                "SELECT kind FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()}
        assert "compact_recovery" not in after_start, (
            "zero-byte base row must NOT be written at session_start"
        )
        assert "compact_recovery_overhead" not in after_start, (
            "overhead row must NOT appear at session_start"
        )

        # Trigger pre_read on any file — the sidecar is consumed but no stat row
        # is written (Option A: both rows dropped).
        hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py"},
        })

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind FROM stats"
                " WHERE kind IN ('compact_recovery', 'compact_recovery_overhead')"
            ).fetchall()

        kinds = {r["kind"] for r in rows}
        assert "compact_recovery" not in kinds, (
            "zero-byte base row must never be written"
        )
        assert "compact_recovery_overhead" not in kinds, (
            "overhead row must NOT be written — dropped in Option A"
        )

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

    def test_no_base_row_written(self, tmp_data_dir):
        """The zero-byte compact_recovery base row must never be written — it
        was a pure noise bucket (294 writes/month, 0 bytes/tokens saved)."""
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

        assert row is None, "compact_recovery base row must not be written"
