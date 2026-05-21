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
