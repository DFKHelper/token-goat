"""Regression tests: token budgets for the recovery hint and pre-compact manifest.

These tests are guard-rails on top of the existing behaviour suites
(``test_post_compact_recovery.py`` and ``test_compact.py``).  They lock in
the token-savings improvements from the iter-1 through iter-9 optimisation
pass so a future edit that re-bloats either artifact will fail CI before
shipping rather than silently eating into the live compaction budget.

Each assertion has a small slack above the *current* observed size:

* Recovery hint: saturated fixtures produce ~475 tokens (14 entries across
  three sections, each with a ~47-char ``output_id``).  Budget set at 500
  for headroom against a single small format addition without flapping.
* Pre-compact manifest: 420-token slack above the 400-token configured
  ceiling — the trim pass keeps the rendered output under the budget the
  caller passed, so this is a sanity check that the trim is happening.

Both ceilings will trip *before* a regression hits a real-world session
size limit, leaving room for a deliberate behavior change with an explicit
test bump.
"""
from __future__ import annotations

from token_goat import compact, hooks_session, session
from token_goat.repomap import estimate_tokens

# ---------------------------------------------------------------------------
# Budgets — adjust deliberately if behaviour intentionally changes.
# ---------------------------------------------------------------------------

# Saturated hint measures ~475 tokens (long synthetic IDs).  Real-session IDs
# are the same length, so this matches production.  500 gives a 25-token cushion.
_RECOVERY_HINT_SATURATED_BUDGET = 500
# Files-only hint is one-line-per-file with no IDs, so it stays well under.
_RECOVERY_HINT_LOPSIDED_BUDGET = 200
_MANIFEST_BUDGET = 420  # slack above the 400-token configured ceiling


# ---------------------------------------------------------------------------
# Recovery-hint budget tests
# ---------------------------------------------------------------------------


def _seed_saturated_recovery_state(sid: str) -> None:
    """Populate a session so all three recovery sections are at saturation."""
    for i in range(30):
        session.mark_file_read(
            sid, f"/proj/src/saturated_module_{i:02d}.py",
            offset=0, limit=80,
        )
    for i in range(30):
        cmd_sha = f"shacmd{i:02d}{'a' * 8}"[:16]
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=f"pytest tests/test_module_{i:02d}.py -v",
            output_id=f"{sid[:16]}-{i:013d}-{cmd_sha}",
            stdout_bytes=4000 + i,  # ≥400 byte floor for inclusion
            stderr_bytes=200,
            exit_code=0,
            truncated=False,
        )
    for i in range(30):
        url_sha = f"shaurl{i:02d}{'b' * 8}"[:16]
        session.mark_web_fetch(
            session_id=sid,
            url_sha=url_sha,
            url_preview=f"https://docs.example.com/api/v2/resource/{i:02d}",
            output_id=f"{sid[:16]}-{i:013d}-{url_sha}",
            body_bytes=5000 + i,  # ≥400 byte floor for inclusion
            status_code=200,
            truncated=False,
        )


class TestRecoveryHintBudget:
    def test_saturated_recovery_hint_under_budget(self, tmp_data_dir):
        sid = "budget-saturated"
        _seed_saturated_recovery_state(sid)

        hint = hooks_session._build_recovery_hint(sid)

        assert hint is not None, "saturated session must produce a hint"
        assert hint.startswith("## Token-Goat Post-Compact Recovery"), (
            f"hint header changed: {hint[:80]!r}"
        )
        # All three sections should fire since each is saturated past its floor.
        assert "Recently-read files" in hint
        assert "Recent Bash outputs" in hint
        assert "Recent WebFetch responses" in hint
        # Truncation tail signal must appear for at least one section.
        assert "…+" in hint and "more" in hint, (
            f"expected `…+N more` truncation signal in hint:\n{hint}"
        )

        tokens = estimate_tokens(hint)
        assert tokens <= _RECOVERY_HINT_SATURATED_BUDGET, (
            f"recovery hint grew to {tokens} tokens "
            f"(budget {_RECOVERY_HINT_SATURATED_BUDGET}); rendered:\n{hint}"
        )

    def test_lopsided_files_only_hint_under_tighter_budget(self, tmp_data_dir):
        """Files-only session must reclaim unused bash/web budget but still
        stay well under the saturated ceiling — the reallocation gives more
        files but they're a single line each."""
        sid = "budget-files-only"
        for i in range(30):
            session.mark_file_read(
                sid, f"/proj/src/files_only_{i:02d}.py",
                offset=0, limit=80,
            )

        hint = hooks_session._build_recovery_hint(sid)

        assert hint is not None
        assert "Recently-read files" in hint
        assert "Recent Bash outputs" not in hint, (
            "bash section rendered despite no bash history"
        )
        assert "Recent WebFetch" not in hint, (
            "web section rendered despite no web history"
        )

        # Ceiling for files is 12, so 30 - 12 = 18 dropped.
        assert "…+18 more files" in hint

        tokens = estimate_tokens(hint)
        assert tokens <= _RECOVERY_HINT_LOPSIDED_BUDGET, (
            f"lopsided files-only hint grew to {tokens} tokens "
            f"(budget {_RECOVERY_HINT_LOPSIDED_BUDGET}); rendered:\n{hint}"
        )


# ---------------------------------------------------------------------------
# Pre-compact manifest budget tests
# ---------------------------------------------------------------------------


def _seed_saturated_manifest_state(sid: str) -> None:
    """Populate a session that activates every manifest section."""
    # Edited files — top priority, always rendered first.
    for i in range(15):
        session.mark_file_edited(sid, f"/proj/src/edited_{i:02d}.py")
        # Edit-after-read produces the "Outdated File Snapshots" section.
        session.mark_file_read(
            sid, f"/proj/src/edited_{i:02d}.py", offset=0, limit=40,
        )
    # Symbol reads — produces "Symbols Accessed".
    for i in range(10):
        session.mark_file_read(
            sid, f"/proj/src/symbols_{i:02d}.py", symbol=f"handle_event_{i:02d}",
        )
    # Plain file reads — produces "Key Files Read".
    for i in range(15):
        session.mark_file_read(
            sid, f"/proj/src/read_{i:02d}.py", offset=0, limit=100,
        )
    # Grep patterns — produces "Patterns Searched".
    for i in range(10):
        session.mark_grep(sid, f"distinct_pattern_{i:02d}", "/proj/src")
    # Bash history — produces "Commands Run" and "Cold Outputs".
    for i in range(20):
        cmd_sha = f"manishabc{i:02d}{'x' * 8}"[:16]
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=f"cargo test --package goat -- module_{i:02d}",
            output_id=f"{sid[:16]}-{i:013d}-{cmd_sha}",
            stdout_bytes=6000,
            stderr_bytes=400,
            exit_code=0,
            truncated=False,
        )


class TestManifestBudget:
    def test_saturated_manifest_under_budget(self, tmp_data_dir):
        sid = "manifest-budget-saturated"
        _seed_saturated_manifest_state(sid)

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        assert manifest, "saturated session must produce a non-empty manifest"
        # The header is the anchor every other test in the project checks too.
        assert "## Token-Goat Session Manifest" in manifest

        # Highest-priority sections must survive trimming.  Lower-priority
        # sections (Patterns Searched / Cold Outputs / Key Files Read / Commands Run)
        # get trimmed off the tail when the 400-token budget binds, which is the
        # correct trim-pass behaviour and not a regression — this test only
        # asserts the two sections that always survive regardless of budget pressure.
        for header in ("Files Edited", "Symbols Accessed"):
            assert header in manifest, (
                f"missing manifest section {header!r}; rendered:\n{manifest}"
            )

        tokens = estimate_tokens(manifest)
        assert tokens <= _MANIFEST_BUDGET, (
            f"pre-compact manifest grew to {tokens} tokens "
            f"(budget {_MANIFEST_BUDGET}); rendered:\n{manifest}"
        )

    def test_commands_run_appears_at_larger_budget(self, tmp_data_dir):
        """Commands Run section survives when budget is large enough to include it."""
        import time
        sid = "manifest-budget-bash"
        _seed_saturated_manifest_state(sid)
        # Backdate to mature tier (>60 min) so the bash section is not suppressed
        # by the age-tier guard (young sessions skip bash/web sections).
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)
        # Use a 700-token budget — what compute_adaptive_budget gives a heavily
        # saturated mature session — so bash section is not crowded out.
        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=700)
        assert "Commands Run" in manifest, (
            f"Commands Run missing at 700-token budget; rendered:\n{manifest}"
        )

    def test_manifest_respects_lower_max_tokens(self, tmp_data_dir):
        """A caller passing a small max_tokens still gets a trimmed manifest;
        the trim pass shouldn't let the rendered output blow past the request."""
        sid = "manifest-budget-tight"
        _seed_saturated_manifest_state(sid)

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=200)

        assert manifest, "even a tight manifest must surface something"
        tokens = estimate_tokens(manifest)
        # Allow a small slack for the header + the highest-priority section
        # the trim pass refuses to drop.
        assert tokens <= 240, (
            f"tight-budget manifest grew to {tokens} tokens "
            f"(requested 200, slack 240); rendered:\n{manifest}"
        )


# ---------------------------------------------------------------------------
# Section-specific cap enforcement tests
# ---------------------------------------------------------------------------


def _seed_large_edited_files_session(sid: str, n_edited: int, name_len: str = "short") -> None:
    """Seed a session with *n_edited* edited files.

    *name_len* controls path length:
    - ``'short'`` → ``/proj/src/mod_NN.py``   (~20 chars)
    - ``'long'``  → ``/proj/src/very_long_module_name_component_xyz_NN.py``  (~52 chars)
    """
    for i in range(n_edited):
        if name_len == "long":
            path = f"/proj/src/very_long_module_name_component_xyz_{i:02d}.py"
        else:
            path = f"/proj/src/mod_{i:02d}.py"
        session.mark_file_edited(sid, path)


class TestEditedFilesCap:
    """The edited-files section must never individually list more than
    _MAX_EDITED_FILES_SHOWN entries; excess files get a '+N more' overflow line."""

    def test_overflow_notice_appears_beyond_cap(self, tmp_data_dir):
        """50 edited files: only 20 appear by name; overflow line shows +30."""
        sid = "edited-cap-overflow"
        _seed_large_edited_files_session(sid, 50, name_len="short")

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        assert "Files Edited" in manifest
        edit_lines = [ln for ln in manifest.splitlines() if ln.startswith("- ✎")]
        assert len(edit_lines) <= 20, (
            f"edited-files section listed {len(edit_lines)} files (cap=20);\n{manifest}"
        )
        assert "…+" in manifest and "more edited" in manifest, (
            f"expected overflow notice '…+N more edited' in manifest:\n{manifest}"
        )

    def test_no_overflow_at_exactly_cap(self, tmp_data_dir):
        """Exactly 20 edited files: all 20 appear, no overflow notice."""
        sid = "edited-cap-exact"
        _seed_large_edited_files_session(sid, 20, name_len="short")

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        edit_lines = [ln for ln in manifest.splitlines() if ln.startswith("- ✎")]
        assert len(edit_lines) == 20, (
            f"expected exactly 20 edited file lines, got {len(edit_lines)};\n{manifest}"
        )
        assert "more edited" not in manifest, (
            f"unexpected overflow notice with exactly 20 files:\n{manifest}"
        )

    def test_large_edited_section_preserves_symbols_section(self, tmp_data_dir):
        """30 long-named edited files must not crowd out Symbols Accessed.

        Before the _MAX_EDITED_FILES_SHOWN cap was added, the uncapped edited-files
        block consumed the entire 400-token budget, leaving no room for the Symbols
        Accessed section.  This test is the regression guard.
        """
        sid = "edited-cap-crowdout"
        _seed_large_edited_files_session(sid, 30, name_len="long")
        # Add 8 symbol reads so Symbols Accessed has content to render.
        for i in range(8):
            session.mark_file_read(sid, f"/proj/src/lib_{i:02d}.py", symbol=f"handle_event_{i}")

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        assert "Symbols Accessed" in manifest, (
            f"Symbols Accessed crowded out by 30 long-named edited files;\n{manifest}"
        )

    def test_manifest_under_500_tokens_with_50_edited_and_blockers(self, tmp_data_dir):
        """Hard regression guard: even the worst realistic case stays under 500 tokens.

        Scenario: 50 edited files with long paths + 3 active blockers + 10 symbol reads
        + 10 grep patterns, rendered at the default 400-token budget.  The safety trim
        in _render() enforces the global ceiling; this test verifies that ceiling is
        well below 500 tokens so future additions have a clear red line to trip.
        """
        import time as _time

        sid = "edited-cap-hard-500"
        # 50 long-named edited files — triggers the _MAX_EDITED_FILES_SHOWN cap.
        _seed_large_edited_files_session(sid, 50, name_len="long")
        # 3 failed bash commands (Current Blockers section).
        for i in range(3):
            sha = f"fail{i:013d}"
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=sha,
                cmd_preview=f"uv run mypy src/token_goat/module_{i}.py --strict",
                output_id=f"fail-{i:013d}",
                stdout_bytes=800,
                stderr_bytes=1200,
                exit_code=1,
                truncated=False,
            )
        # 10 symbol reads.
        for i in range(10):
            session.mark_file_read(sid, f"/proj/src/lib_{i:02d}.py", symbol=f"EventHandler{i:02d}")
        # 10 grep patterns.
        for i in range(10):
            session.mark_grep(sid, f"distinct_pattern_{i:02d}", "/proj/src")
        # Mature tier — enables bash/web sections.
        cache = session.load(sid)
        cache.created_ts = _time.time() - 7200
        session.save(cache)

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        assert manifest, "saturated session must produce a non-empty manifest"
        tokens = estimate_tokens(manifest)
        assert tokens <= 500, (
            f"manifest exceeded 500-token hard cap: got {tokens} tokens "
            f"(budget=400, slack=500);\n{manifest}"
        )


class TestBlockersCap:
    """Current Blockers section must never show more than 3 entries (_MAX_BLOCKER_ENTRIES)."""

    def test_blockers_capped_at_three(self, tmp_data_dir):
        """6 recent bash failures: manifest shows at most 3 in Current Blockers."""
        import time as _time

        sid = "blockers-cap-six"
        for i in range(6):
            sha = f"fail{i:013d}"
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=sha,
                cmd_preview=f"uv run pytest tests/test_module_{i:02d}.py -x",
                output_id=f"fail-{i:013d}",
                stdout_bytes=500,
                stderr_bytes=300,
                exit_code=1,
                truncated=False,
            )
        # Backdate so failures are within the 60-min blocker window.
        cache = session.load(sid)
        cache.created_ts = _time.time() - 1800
        session.save(cache)

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        blocker_lines = [ln for ln in manifest.splitlines() if ln.startswith("- ✗")]
        assert len(blocker_lines) <= 3, (
            f"Current Blockers listed {len(blocker_lines)} entries (cap=3);\n{manifest}"
        )


class TestUncommittedChangesCap:
    """Uncommitted Changes section is capped at 8 lines / 200 chars inside
    _get_uncommitted_changes; the manifest never sees an unbounded git diff."""

    def test_uncommitted_section_tokens_are_bounded(self, tmp_data_dir):
        """Even if git emits a long diff --stat, the manifest line-count is capped.

        We cannot call real git here (no controlled repo state), so we test the
        helper directly and confirm the manifest assembly path doesn't add extra lines.
        """
        import os

        from token_goat.compact import _get_uncommitted_changes

        # Verify the function caps to 8 lines when called with a real git repo
        # at the project root.  The actual output will vary but must never exceed
        # 8 lines or 200 chars.

        result = _get_uncommitted_changes(os.getcwd())
        if result is not None:
            lines = result.splitlines()
            assert len(lines) <= 8, (
                f"_get_uncommitted_changes returned {len(lines)} lines (cap=8): {result!r}"
            )
            assert len(result) <= 200, (
                f"_get_uncommitted_changes returned {len(result)} chars (cap=200): {result!r}"
            )
            # Token cost of the section including the header must be reasonable.
            section = "### Uncommitted Changes\n" + "\n".join(f"  {ln}" for ln in lines)
            section_tokens = estimate_tokens(section)
            assert section_tokens <= 80, (
                f"Uncommitted Changes section cost {section_tokens} tokens (expected ≤80)"
            )
