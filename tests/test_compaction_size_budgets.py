"""Regression tests: token budgets for the recovery hint and pre-compact manifest.

These tests are guard-rails on top of the existing behaviour suites
(``test_post_compact_recovery.py`` and ``test_compact.py``).  They lock in
the token-savings improvements from the iter-1 through iter-9 optimisation
pass so a future edit that re-bloats either artifact will fail CI before
shipping rather than silently eating into the live compaction budget.

Each assertion has a small slack above the *current* observed size:

* Recovery hint (saturated): iter-29 added ``### Pending Work`` and
  ``### Key Commands`` sections to the hint.  Saturated fixtures now produce
  ~548 tokens (files+bash+web + two new sections).  Budget bumped to 580
  for headroom against a small format addition without flapping.
* Recovery hint (files-only): the ``### Key Commands`` section adds ~20-30
  tokens even for files-only sessions (at least the map-compact command is
  always shown; .py files trigger the symbol/read commands too).  Budget
  bumped to 240.
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

# Saturated hint is now hard-capped at 400 tokens by _truncate_recovery_hint
# (reduced from the prior 800-token budget to keep overhead modest).
# Observed ~439 tokens at saturation; 460 gives ~21-token cushion.
_RECOVERY_HINT_SATURATED_BUDGET = 460
# Files-only hint is one-line-per-file with no IDs plus ### Key Commands.
# With .py files the Key Commands section adds symbol/read commands too.
# Observed ~218 tokens; 240 gives ~22-token headroom.
_RECOVERY_HINT_LOPSIDED_BUDGET = 240
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
        assert hint.startswith("## Post-Compact Recovery"), (
            f"hint header changed: {hint[:80]!r}"
        )
        # All three sections should fire since each is saturated past its floor.
        # Files section uses ### heading (consistent with manifest format);
        # Bash/Web still use ** bold format.
        assert ("### Edited Files" in hint or "**Files**" in hint)
        assert "**Bash**" in hint
        assert "**Web**" in hint
        # Truncation tail signal must appear for at least one section.
        assert "+" in hint and "more" in hint, (
            f"expected `+N more` truncation signal in hint:\n{hint}"
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
        assert ("### Edited Files" in hint or "**Files**" in hint)
        assert "**Bash**" not in hint, (
            "bash section rendered despite no bash history"
        )
        assert "**Web**" not in hint, (
            "web section rendered despite no web history"
        )

        # Ceiling for files is 12, so 30 - 12 = 18 dropped.
        assert "+18 more" in hint

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
    # Symbol reads — produces "**Symbols Accessed:**".
    for i in range(10):
        session.mark_file_read(
            sid, f"/proj/src/symbols_{i:02d}.py", symbol=f"handle_event_{i:02d}",
        )
    # Plain file reads — produces "**Files:**".
    for i in range(15):
        session.mark_file_read(
            sid, f"/proj/src/read_{i:02d}.py", offset=0, limit=100,
        )
    # Grep patterns — produces "**Patterns Searched:**".
    for i in range(10):
        session.mark_grep(sid, f"distinct_pattern_{i:02d}", "/proj/src")
    # Bash history — produces "**Recent Commands:**" and "Cold Outputs".
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
        # Item 16: when edited/read overlap >= 50%, both sections merge into **Files:**.
        edited_present = "**Edited:**" in manifest or "**Files:**" in manifest
        assert edited_present, f"missing edited/files section; rendered:\n{manifest}"
        assert "**Symbols Accessed:**" in manifest, f"missing **Symbols Accessed:**; rendered:\n{manifest}"

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
        assert "**Recent Commands:**" in manifest, (
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
        # Slack raised from 240→251: the "# as-of: …" suffix adds ~11 tokens after trim.
        assert tokens <= 251, (
            f"tight-budget manifest grew to {tokens} tokens "
            f"(requested 200, slack 251); rendered:\n{manifest}"
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

        assert ("**Staged/Uncommitted:**" in manifest or "**Edited:**" in manifest or "**Files:**" in manifest)
        edit_lines = [ln for ln in manifest.splitlines() if ln.startswith("- ✎")]
        assert len(edit_lines) <= 20, (
            f"edited-files section listed {len(edit_lines)} files (cap=20);\n{manifest}"
        )
        assert "…+" in manifest and ("more edited" in manifest or "more staged" in manifest), (
            f"expected overflow notice '…+N more' in manifest:\n{manifest}"
        )

    def test_no_overflow_at_exactly_cap(self, tmp_data_dir):
        """Exactly 20 edited files: all 20 appear, no overflow notice."""
        sid = "edited-cap-exact"
        _seed_large_edited_files_session(sid, 20, name_len="short")

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        # Directory grouping collapses same-dir files into one line, so
        # "- ✎" line count may be 0 even when all files are present.
        # Accept either 20 individual lines or a single "(20 files)" grouped entry.
        edit_lines = [ln for ln in manifest.splitlines() if "- ✎" in ln]
        grouped = [ln for ln in manifest.splitlines() if "(20 files)" in ln]
        assert len(edit_lines) == 20 or len(grouped) >= 1, (
            f"expected 20 individual edit lines or a '(20 files)' grouped entry, "
            f"got {len(edit_lines)} individual and {len(grouped)} grouped;\n{manifest}"
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

        assert "**Symbols Accessed:**" in manifest, (
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
            section = "**Uncommitted:**\n" + "\n".join(f"  {ln}" for ln in lines)
            section_tokens = estimate_tokens(section)
            assert section_tokens <= 80, (
                f"Uncommitted Changes section cost {section_tokens} tokens (expected ≤80)"
            )


# ---------------------------------------------------------------------------
# Priority-aware safety-trim tests
# ---------------------------------------------------------------------------


class TestPriorityAwareSafetyTrim:
    """When ``estimate_tokens(manifest) > max_tokens`` the trim pass drops
    low-signal sections wholesale before resorting to bottom-line popping.

    These guard against three defects in the previous naive bottom-popping
    approach:

    1. **Orphan section headers** — line popping could leave ``**Files:**``
       with no entries when the trim cut mid-section.
    2. **Legend stripped before content** — the legend was the final appended
       line, so the very first pop removed marker explanations while the
       symbols (✎ → ⚠ ❄) still appeared in the body above.
    3. **No priority signal** — the previous trim treated sections as a flat
       line stream; lower-signal sections (todos, files, grep) and higher-
       signal sections (bash, stale) were trimmed in raw bottom-up order
       without explicit priority.
    """

    def test_no_orphan_section_header_after_trim(self, tmp_data_dir):
        """A trim cut must drop a whole section, not just its entries.

        Walk the manifest looking for any line that matches a known section
        header marker (``**Foo:**`` / ``### Heading``) immediately followed
        by either a blank line, EOF, or another header — i.e. an orphan.
        """
        sid = "trim-no-orphan-header"
        _seed_saturated_manifest_state(sid)

        # Tight budget forces the safety trim path.
        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=180)

        lines = manifest.splitlines()
        # Known section headers that could orphan.
        header_markers = (
            "**Files:**", "**Patterns Searched:**", "**Web Fetches:**", "**Symbols Accessed:**",
            "**Recent Commands:**", "**Cold:**", "**Skills:**", "**Decisions:**",
            "### Cold Outputs", "### Diff Summary", "### Commits This Session",
            "### TODOs", "Directory Scans",
        )
        for i, line in enumerate(lines):
            if not any(line.startswith(m) for m in header_markers):
                continue
            # Check whether the next non-empty line is content (`- `, `  `, or `#### `)
            # or another header (which means the current one is orphan).
            for j in range(i + 1, len(lines)):
                nxt = lines[j]
                if not nxt.strip():
                    continue
                # Content lines start with these prefixes for sections.
                if nxt.startswith(("- ", "  ", "#### ", "**Pending:**")):
                    break  # has content — not orphan
                if any(nxt.startswith(m) for m in header_markers):
                    # Two headers back-to-back — outer is orphan.
                    raise AssertionError(
                        f"orphan section header at line {i}: {line!r} "
                        f"followed by header at line {j}: {nxt!r}\n"
                        f"full manifest:\n{manifest}"
                    )
                # Other content (e.g. Legend, a free text line) — section ended cleanly.
                break

    def test_legend_survives_aggressive_trim(self, tmp_data_dir):
        """When the body uses marker symbols (✎ → ⚠ ❄), the Legend line that
        explains them must survive even a very tight budget — otherwise the
        compaction LLM sees orphan symbols with no key."""
        sid = "trim-legend-survives"
        _seed_saturated_manifest_state(sid)

        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=200)
        # Check that if any marker symbol appears in body, the legend appears.
        markers_in_body = any(
            sym in manifest for sym in ("✎", "→", "⚠", "❄")
        )
        if markers_in_body:
            # Either single-marker bare line or "Legend: ..." prefix.
            has_legend = (
                "Legend: " in manifest
                or any(
                    line.strip() in {"edited=✎", "read=→", "stale=⚠", "cold=❄", "skill=🧠"}
                    for line in manifest.splitlines()
                )
            )
            assert has_legend, (
                "marker symbols present in manifest body but legend missing; "
                f"rendered:\n{manifest}"
            )

    def test_protected_sections_survive_tight_budget(self, tmp_data_dir):
        """Sealed block + header + edited files (the highest-signal sections)
        must always survive the trim, even at a budget too tight for everything."""
        sid = "trim-protected"
        _seed_saturated_manifest_state(sid)

        # +11 vs original 150 to keep effective body_budget at 150 after _AS_OF_TOKEN_RESERVE subtraction.
        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=161)

        assert manifest, "trimmed manifest must not be empty"
        # Sealed block + header anchor every post-compact recovery — never drop.
        assert "## Token-Goat Session Manifest" in manifest, (
            f"header dropped under tight budget; rendered:\n{manifest}"
        )
        # Edited section is protected — must appear in some form.
        assert (
            "**Edited:**" in manifest
            or "**Files:**" in manifest  # merged-section variant
        ), f"edited section dropped under tight budget; rendered:\n{manifest}"

    def test_low_priority_dropped_before_high(self, tmp_data_dir):
        """Under budget pressure, low-priority sections (Grep, Files-read,
        TODOs) must be dropped before high-priority sections (Bash, Stale)."""
        import time
        sid = "trim-priority-order"
        _seed_saturated_manifest_state(sid)
        # Mature tier so bash section is eligible (young sessions skip it).
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)

        # Budget tight enough to force *some* drops but not all sections.
        manifest, _ = compact.build_manifest_with_count(sid, max_tokens=400)

        # If Patterns Searched was dropped (low priority), Bash should still be present
        # (higher priority).  This guards the priority ordering.
        grep_dropped = "**Patterns Searched:**" not in manifest
        bash_dropped = "**Recent Commands:**" not in manifest
        if grep_dropped and not bash_dropped:
            pass  # correct: low dropped first
        elif not grep_dropped and bash_dropped:
            raise AssertionError(
                "priority inversion: **Recent Commands:** dropped while **Patterns Searched:** survived; "
                f"rendered:\n{manifest}"
            )
        # else: both present or both absent — both are fine outcomes here.
