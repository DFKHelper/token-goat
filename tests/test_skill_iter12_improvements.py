"""Tests for skill context savings accuracy improvements (iteration 12).

Covers:
1. skill_section cache fallback: when the disk file is not found but a cached
   body exists, extract_named_section is called on the cached body.
2. skill-compact --all: batch regeneration of stale/absent compacts, staleness
   check via source SHA, up-to-date skills are skipped.
3. Pre-compact token budget safety margin: _section_budgets receives a budget
   15% smaller than max_tokens so the assembled manifest stays under the limit
   when measured by estimate_tokens (len//3+1 vs len//4 discrepancy).
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Improvement 1: skill_section falls back to cached body when disk is absent
# ---------------------------------------------------------------------------


class TestSkillSectionCacheFallback:
    """skill_section uses the cached body when get_skill_file_path returns None."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Redirect skill_cache writes to a temp dir so tests don't pollute the real data dir."""
        self.tmp_data_dir = tmp_data_dir

    def _make_body(self) -> str:
        return (
            "# My Skill\n\n"
            "## Quick Start\n\n"
            "Run it like this.\n\n"
            "## Reference\n\n"
            "Details here.\n"
        )

    def test_falls_back_to_cache_when_disk_absent(self):
        """When get_skill_file_path returns None, skill_section uses cached body."""
        from token_goat import read_commands, skill_cache

        body = self._make_body()
        session_id = "test-session-fallback12"
        meta = skill_cache.store_output(session_id, "myskill12", body)
        assert meta is not None
        # Must write sidecar so lookup_all_by_name can find it.
        skill_cache.write_sidecar(meta)

        with (
            patch.object(skill_cache, "get_skill_file_path", return_value=None),
            patch("token_goat.read_commands._emit_text_result") as mock_emit,
            patch("token_goat.db.record_stat"),
        ):
            # Should succeed (not raise Exit) because the cache has the body.
            read_commands.skill_section(
                "myskill12",
                "Quick Start",
                json_output=False,
                no_header=True,
            )

        assert mock_emit.call_count == 1
        section_arg = mock_emit.call_args[0][0]
        assert "Run it like this" in section_arg

    def test_falls_back_to_cache_json_output(self):
        """Cache fallback with json_output=True includes source from cache."""
        from token_goat import read_commands, skill_cache

        body = self._make_body()
        session_id = "test-session-json-fb12"
        meta = skill_cache.store_output(session_id, "myskill12b", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        outputs: list[str] = []

        def fake_echo(text: str, *args, **kwargs):
            outputs.append(text)

        with (
            patch.object(skill_cache, "get_skill_file_path", return_value=None),
            patch("token_goat.db.record_stat"),
            patch("typer.echo", side_effect=fake_echo),
        ):
            read_commands.skill_section(
                "myskill12b",
                "Reference",
                json_output=True,
            )

        assert outputs, "Expected typer.echo to have been called"
        payload = json.loads(outputs[-1])
        assert payload.get("ok") is True
        assert payload.get("skill_name") == "myskill12b"
        assert payload.get("heading") == "Reference"
        # source should indicate this came from cache, not a disk path.
        assert "cache:" in payload.get("source", "")
        assert "Details here" in payload.get("text", "")

    def test_exits_when_neither_disk_nor_cache(self):
        """When both disk and cache are absent, raises SystemExit or click.Exit."""
        import click

        from token_goat import read_commands, skill_cache

        with (
            patch.object(skill_cache, "get_skill_file_path", return_value=None),
            patch.object(skill_cache, "lookup_all_by_name", return_value=[]),
            pytest.raises((click.exceptions.Exit, SystemExit)),
        ):
            read_commands.skill_section("nonexistent12", "Any Heading")

    def test_disk_path_still_preferred_when_available(self, tmp_path):
        """When disk file exists, it is used (cache is not consulted)."""
        from token_goat import read_commands, skill_cache

        skill_file = tmp_path / "SKILL.md"
        skill_file.write_text(
            "# On Disk Skill\n\n## On Disk Section\n\nThis is on disk.\n",
            encoding="utf-8",
        )

        with (
            patch.object(skill_cache, "get_skill_file_path", return_value=skill_file),
            patch("token_goat.db.record_stat"),
            patch("token_goat.read_commands._emit_text_result") as mock_emit,
        ):
            read_commands.skill_section(
                "diskskill12",
                "On Disk Section",
                json_output=False,
                no_header=True,
            )

        assert mock_emit.call_count == 1
        section_arg = mock_emit.call_args[0][0]
        assert "This is on disk." in section_arg

    def test_cache_fallback_section_not_found_lists_headings(self):
        """Cache fallback: when section is absent, lists available headings."""
        import click

        from token_goat import read_commands, skill_cache

        body = "# Skill\n\n## Alpha\n\nContent A.\n\n## Beta\n\nContent B.\n"
        session_id = "test-cache-section-miss12"
        meta = skill_cache.store_output(session_id, "section-miss12", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        error_outputs: list[str] = []

        def capture_stderr(text: str, *args, **kwargs):
            error_outputs.append(text)

        with (
            patch.object(skill_cache, "get_skill_file_path", return_value=None),
            patch("token_goat.db.record_stat"),
            patch("token_goat.read_commands._emit_read_error") as mock_err,
        ):
            with pytest.raises(click.exceptions.Exit):
                read_commands.skill_section(
                    "section-miss12",
                    "NonExistentSection",
                    json_output=False,
                )
            # The error should mention available headings.
            assert mock_err.call_count == 1
            err_kwargs = mock_err.call_args
            msg = (err_kwargs[1] if err_kwargs[1] else err_kwargs[0][1])
            if isinstance(msg, dict):
                msg = msg.get("message", "")
            assert "Alpha" in str(err_kwargs) or "Beta" in str(err_kwargs)


# ---------------------------------------------------------------------------
# Improvement 2: skill-compact --all batch regeneration
# ---------------------------------------------------------------------------


class TestSkillCompactAll:
    """skill_cache: batch compact regeneration staleness logic."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Redirect skill_cache writes to a temp dir so tests don't pollute the real data dir."""
        self.tmp_data_dir = tmp_data_dir

    def _store_skill_with_sidecar(
        self, name: str, body: str, session_id: str = "test-session-all12"
    ):  # returns SkillMeta
        from token_goat import skill_cache

        meta = skill_cache.store_output(session_id, name, body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        return meta

    def test_absent_compact_is_regenerated(self):
        """No compact yet → can store one and retrieve it.

        Uses a unique session per test run so this test does not collide with
        parallel workers operating on the same shared disk cache.
        """
        import uuid

        from token_goat import skill_cache

        session_id = f"test-sc-absent12-{uuid.uuid4().hex[:8]}"
        skill_name = f"skill-absent12-{uuid.uuid4().hex[:8]}"
        body = "# Skill\n\n## Quick Start\n\nStep 1.\n\n## Reference\n\nDetails.\n"
        meta = self._store_skill_with_sidecar(skill_name, body, session_id)

        # Verify no compact exists yet.
        existing = skill_cache.get_compact(session_id, skill_name)
        assert existing is None

        # Generate and store compact.
        compact_text = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact(session_id, skill_name, compact_text, source_sha=meta.content_sha)

        stored = skill_cache.get_compact(session_id, skill_name)
        assert stored is not None
        assert "Quick Start" in stored or "Reference" in stored

    def test_staleness_check_detects_sha_mismatch(self):
        """extract_compact_source_sha detects staleness after body update."""
        from token_goat import skill_cache

        session_id = "test-sc-stale12"

        # Store v1 body and its compact.
        body_v1 = "# Skill V1\n\n## Quick Start\n\nOld content.\n"
        meta_v1 = self._store_skill_with_sidecar("skill-stale12", body_v1, session_id)
        compact_text = skill_cache.generate_compact_summary(body_v1)
        skill_cache.store_compact(session_id, "skill-stale12", compact_text, source_sha=meta_v1.content_sha)

        # Simulate: skill body updated → new sha.
        body_v2 = "# Skill V2\n\n## Quick Start\n\nNew content.\n## Advanced\n\nExtra.\n"
        meta_v2 = self._store_skill_with_sidecar("skill-stale12", body_v2, session_id)

        stored_compact = skill_cache.get_compact(session_id, "skill-stale12")
        assert stored_compact is not None

        compact_sha = skill_cache.extract_compact_source_sha(stored_compact)
        assert compact_sha is not None, "compact should embed source sha"

        # v2 body sha should NOT start with the compact's sha.
        body_sha = meta_v2.content_sha
        is_stale = not body_sha.startswith(compact_sha)
        assert is_stale, "compact should be detected as stale after body update"

    def test_fresh_compact_is_not_stale(self):
        """Compact with matching source SHA is correctly identified as up-to-date."""
        from token_goat import skill_cache

        session_id = "test-sc-fresh12"
        body = "# Fresh Skill\n\n## Section\n\nContent.\n"
        meta = self._store_skill_with_sidecar("skill-fresh12", body, session_id)

        compact_text = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact(session_id, "skill-fresh12", compact_text, source_sha=meta.content_sha)

        stored_compact = skill_cache.get_compact(session_id, "skill-fresh12")
        assert stored_compact is not None
        compact_sha = skill_cache.extract_compact_source_sha(stored_compact)
        assert compact_sha is not None

        body_sha = meta.content_sha
        is_stale = not body_sha.startswith(compact_sha)
        assert not is_stale, "compact with matching sha should NOT be considered stale"

    def test_all_multiple_skill_states_classified_correctly(self):
        """Mix of stale/fresh/absent compacts is classified correctly."""
        from token_goat import skill_cache

        session_id = "test-sc-mix12"

        # Skill A: up-to-date compact.
        body_a = "# A\n\n## Step\n\nDo A.\n"
        meta_a = self._store_skill_with_sidecar("skill-a12", body_a, session_id)
        compact_a = skill_cache.generate_compact_summary(body_a)
        skill_cache.store_compact(session_id, "skill-a12", compact_a, source_sha=meta_a.content_sha)

        # Skill B: stale compact (stored with v1 sha, then body updated to v2).
        body_b_v1 = "# B v1\n\n## Step\n\nOld B.\n"
        meta_b_v1 = self._store_skill_with_sidecar("skill-b12", body_b_v1, session_id)
        compact_b_v1 = skill_cache.generate_compact_summary(body_b_v1)
        skill_cache.store_compact(session_id, "skill-b12", compact_b_v1, source_sha=meta_b_v1.content_sha)
        body_b_v2 = "# B v2\n\n## Step\n\nNew B.\n## Extra\n\nMore.\n"
        meta_b_v2 = self._store_skill_with_sidecar("skill-b12", body_b_v2, session_id)

        # Skill C: no compact at all.
        body_c = "# C\n\n## Only\n\nContent C.\n"
        self._store_skill_with_sidecar("skill-c12", body_c, session_id)

        # Verify Skill A is up-to-date.
        compact_a_stored = skill_cache.get_compact(session_id, "skill-a12")
        sha_a = skill_cache.extract_compact_source_sha(compact_a_stored or "")
        assert sha_a and meta_a.content_sha.startswith(sha_a), "skill-a12 should be up-to-date"

        # Verify Skill B is stale.
        compact_b_stored = skill_cache.get_compact(session_id, "skill-b12")
        sha_b = skill_cache.extract_compact_source_sha(compact_b_stored or "")
        assert sha_b and not meta_b_v2.content_sha.startswith(sha_b), "skill-b12 should be stale"

        # Verify Skill C has no compact.
        compact_c_stored = skill_cache.get_compact(session_id, "skill-c12")
        assert compact_c_stored is None, "skill-c12 should have no compact"

    def test_list_by_session_finds_stored_skills(self):
        """list_by_session returns entries for skills stored in the session."""
        from token_goat import skill_cache

        session_id = "test-list-by-session12"
        body1 = "# Skill One\n\n## A\n\nContent.\n"
        body2 = "# Skill Two\n\n## B\n\nContent.\n"
        self._store_skill_with_sidecar("skill-one12", body1, session_id)
        self._store_skill_with_sidecar("skill-two12", body2, session_id)

        entries = skill_cache.list_by_session(session_id)
        names = {e.skill_name for e in entries}
        assert "skill-one12" in names
        assert "skill-two12" in names


# ---------------------------------------------------------------------------
# Improvement 3: Pre-compact token budget safety margin in _section_budgets
# ---------------------------------------------------------------------------


class TestSectionBudgetSafetyMargin:
    """_render uses a 15% safety margin when calling _section_budgets."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Point data_dir at a fresh temp dir so bash_outputs/ is empty.

        Without this, _render → _render_active_errors_section globs the real
        bash_outputs/ dir (thousands of .json files) on every test.
        """

    def test_safety_factor_applied(self):
        """The sec_budget_max passed to _section_budgets is 85% of max_tokens."""
        from token_goat.compact import _section_budgets

        max_tokens = 400
        expected_budget = int(max_tokens * 0.85)  # = 340

        captured_budgets: list[int] = []
        original = _section_budgets

        def spy_section_budgets(total_budget: int, *args, **kwargs):
            captured_budgets.append(total_budget)
            return original(total_budget, *args, **kwargs)

        mock_cache = MagicMock()
        mock_cache.edited_files = {}
        mock_cache.files = {}
        mock_cache.symbols = {}
        mock_cache.symbol_access_counts = {}
        mock_cache.bash_history = {}
        mock_cache.web_history = {}
        mock_cache.glob_history = []
        mock_cache.grep_history = []
        mock_cache.hints_seen = set()
        mock_cache.has_hint_fingerprint = MagicMock(return_value=False)
        mock_cache.created_ts = 0.0
        mock_cache.skills = {}
        mock_cache.pinned_notes = []
        mock_cache.decisions = []
        mock_cache.blockers = []

        with patch("token_goat.compact._section_budgets", side_effect=spy_section_budgets):
            from token_goat.compact import _render

            _render(mock_cache, "test-session-margin12", max_tokens)

        assert captured_budgets, "Expected _section_budgets to have been called"
        for budget in captured_budgets:
            assert budget <= expected_budget, (
                f"Expected budget <= {expected_budget} (85% of {max_tokens}), got {budget}"
            )

    def test_safety_factor_reduces_section_allocations(self):
        """85%-scaled budget produces tighter per-section allocations than full budget."""
        from token_goat.compact import _section_budgets

        max_tokens = 400
        safe_budget = int(max_tokens * 0.85)  # = 340
        fixed_tokens = 50

        content_counts = {
            "symbols": 5, "files": 3, "greps": 2, "bash": 1, "web": 0, "glob": 0,
        }
        safe_sec = _section_budgets(safe_budget, fixed_tokens, content_counts)
        full_sec = _section_budgets(max_tokens, fixed_tokens, content_counts)

        # With safety margin, every active section has a tighter (or equal) budget.
        for key in safe_sec:
            assert safe_sec[key] <= full_sec[key], (
                f"Safety-margin budget for {key!r} ({safe_sec[key]}) "
                f"should be <= full budget ({full_sec[key]})"
            )

        # Total section allocation with safety margin is lower.
        safe_total = sum(safe_sec.values())
        full_total = sum(full_sec.values())
        assert safe_total <= full_total, (
            f"Safety-margin total ({safe_total}) should be <= full total ({full_total})"
        )

    def test_section_budget_difference_matches_safety_factor(self):
        """Per-section budgets with 85% safety are ~15% tighter than without."""
        from token_goat.compact import _section_budgets

        max_tokens = 400
        safe_budget = int(max_tokens * 0.85)
        fixed_tokens = 0  # zero fixed so the math is cleaner

        content_counts = {"symbols": 1, "files": 1, "greps": 1, "bash": 1, "web": 1, "glob": 1}
        safe_sec = _section_budgets(safe_budget, fixed_tokens, content_counts)
        full_sec = _section_budgets(max_tokens, fixed_tokens, content_counts)

        safe_total = sum(safe_sec.values())
        full_total = sum(full_sec.values())

        # The ratio of safe_total / full_total should be approximately 0.85.
        if full_total > 0:
            ratio = safe_total / full_total
            assert 0.80 <= ratio <= 0.90, (
                f"Expected ratio ~0.85, got {ratio:.3f} "
                f"(safe={safe_total}, full={full_total})"
            )

    def test_manifest_does_not_grossly_exceed_budget(self):
        """A manifest built with the safety margin does not exceed budget + small tolerance."""
        from token_goat.compact import _render, estimate_tokens

        mock_cache = MagicMock()
        mock_cache.edited_files = {"src/foo.py": True, "src/bar.py": True}
        mock_cache.files = {}
        mock_cache.symbols = {}
        mock_cache.symbol_access_counts = {}
        mock_cache.bash_history = {}
        mock_cache.web_history = {}
        mock_cache.glob_history = []
        mock_cache.grep_history = []
        mock_cache.hints_seen = set()
        mock_cache.has_hint_fingerprint = MagicMock(return_value=False)
        mock_cache.created_ts = 0.0
        mock_cache.skills = {}
        mock_cache.pinned_notes = []
        mock_cache.decisions = []
        mock_cache.blockers = []

        max_tokens = 400
        result, _ = _render(mock_cache, "test-safety-render12", max_tokens)

        if result:
            token_count = estimate_tokens(result)
            # The safety-trim pass handles any residual overflow; the combined
            # safety-margin + safety-trim should keep the manifest within budget + 20 tokens.
            assert token_count <= max_tokens + 20, (
                f"Manifest token count {token_count} exceeds budget {max_tokens} + 20 tolerance"
            )
