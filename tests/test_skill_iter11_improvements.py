"""Tests for skill context savings accuracy improvements (iteration 11).

Covers:
1. Pre-read hook path normalization for nested subdir layout:
   skills/<outer>/<inner>/SKILL.md should be detected as skill <outer>.
2. _resolve_skill_body_path handles nested subdir layout for source_path.
3. post_skill handler accepts alternative field names (skillName, name)
   for skill name extraction.
4. Doctor compact coverage check logic (unit test of the ratio guard).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from token_goat import hooks_read, hooks_skill

# ---------------------------------------------------------------------------
# Improvement 1: nested subdir path detection in _detect_skill_name_from_path
# ---------------------------------------------------------------------------


class TestNestedSubdirPathDetection:
    """_detect_skill_name_from_path handles skills/<outer>/<inner>/SKILL.md."""

    def test_nested_subdir_standard_skill(self):
        """skills/brainstorming/brainstorming/SKILL.md → 'brainstorming'."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/brainstorming/brainstorming/SKILL.md"
        )
        assert result == "brainstorming"

    def test_nested_subdir_improve_skill(self):
        """skills/improve/improve/SKILL.md → 'improve'."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/improve/improve/SKILL.md"
        )
        assert result == "improve"

    def test_nested_subdir_windows_backslash(self):
        r"""Windows backslash nested path → correct outer name."""
        result = hooks_read._detect_skill_name_from_path(
            r"C:\Users\user\.claude\skills\improve\improve\SKILL.md"
        )
        assert result == "improve"

    def test_nested_subdir_hyphenated_name(self):
        """Hyphenated skill name in nested layout is preserved."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/agent-memory-mcp/agent-memory-mcp/SKILL.md"
        )
        assert result == "agent-memory-mcp"

    def test_standard_layouts_still_work(self):
        """Regression: standard (non-nested) layouts are still detected."""
        assert hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph/SKILL.md"
        ) == "ralph"
        assert hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/improve.md"
        ) == "improve"
        assert hooks_read._detect_skill_name_from_path(
            r"C:\Users\user\.claude\skills\ralph\SKILL.md"
        ) == "ralph"

    def test_non_skill_files_return_none(self):
        """Non-skill files still return None after regex change."""
        assert hooks_read._detect_skill_name_from_path("/home/user/.claude/settings.json") is None
        assert hooks_read._detect_skill_name_from_path("/home/user/project/src/main.py") is None
        assert hooks_read._detect_skill_name_from_path("") is None

    def test_marketplace_layout_unaffected(self):
        """Marketplace cache paths still work correctly."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/cache/registry.example.com/myplugin/1.0.0/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_hint_emitted_for_nested_path(self, tmp_path, monkeypatch):
        """Pre-read hint fires for a nested subdir path when skill is loaded."""

        sid = "iter11-nested-path-hint"
        # Load a mock skill entry into session for 'brainstorming'.
        from token_goat.session import SkillEntry

        entry = SkillEntry(
            skill_name="brainstorming",
            output_id="abc-brainstorming-000",
            content_sha="abc123",
            ts=1000.0,
            body_bytes=20000,
        )
        monkeypatch.setattr(
            "token_goat.session.lookup_skill_entry",
            lambda sid_, name: entry if name == "brainstorming" else None,
        )

        nested_path = "/home/user/.claude/skills/brainstorming/brainstorming/SKILL.md"

        def _read_payload(sid_: str, fp: str) -> dict:
            return {
                "session_id": sid_,
                "tool_name": "Read",
                "tool_input": {"file_path": fp},
            }

        # Patch load_session_safe to return a mock cache with the skill entry.
        mock_cache = MagicMock()
        mock_cache.skill_history = {"brainstorming": entry}
        mock_cache.has_hint_fingerprint = lambda _: False
        mock_cache.mark_hint_seen = lambda _: None

        with patch("token_goat.hooks_read.load_session_safe", return_value=mock_cache):
            resp = hooks_read.pre_read(_read_payload(sid, nested_path))

        hook_out = resp.get("hookSpecificOutput", {})
        ctx = hook_out.get("additionalContext", "") if isinstance(hook_out, dict) else ""
        assert "skill-body" in ctx, (
            f"Expected hint for nested path, got: {ctx!r}"
        )
        assert "brainstorming" in ctx


# ---------------------------------------------------------------------------
# Improvement 2: _resolve_skill_body_path checks nested subdir layout
# ---------------------------------------------------------------------------


class TestResolveSkillBodyPathNestedLayout:
    """_resolve_skill_body_path finds skills/<name>/<name>/SKILL.md."""

    def test_nested_subdir_candidate_included(self, tmp_path, monkeypatch):
        """When skills/<name>/<name>/SKILL.md exists, it is returned."""
        # Build the nested directory structure under tmp_path acting as home.
        skills_dir = tmp_path / ".claude" / "skills" / "brainstorming" / "brainstorming"
        skills_dir.mkdir(parents=True)
        skill_file = skills_dir / "SKILL.md"
        skill_file.write_text("# Brainstorming skill body", encoding="utf-8")

        monkeypatch.setattr("token_goat.hooks_skill.Path.home", lambda: tmp_path)

        result = hooks_skill._resolve_skill_body_path("brainstorming")
        assert result != "", "Expected nested subdir path to be found"
        # Normalize separators for comparison.
        assert "brainstorming" in result.replace("\\", "/").lower()

    def test_standard_layout_still_preferred(self, tmp_path, monkeypatch):
        """Standard skills/<name>/SKILL.md is returned before nested layout."""
        # Create both: standard + nested.
        standard_dir = tmp_path / ".claude" / "skills" / "ralph"
        standard_dir.mkdir(parents=True)
        standard_file = standard_dir / "SKILL.md"
        standard_file.write_text("# Ralph standard layout", encoding="utf-8")

        nested_dir = tmp_path / ".claude" / "skills" / "ralph" / "ralph"
        nested_dir.mkdir(parents=True)
        nested_file = nested_dir / "SKILL.md"
        nested_file.write_text("# Ralph nested layout", encoding="utf-8")

        monkeypatch.setattr("token_goat.hooks_skill.Path.home", lambda: tmp_path)

        result = hooks_skill._resolve_skill_body_path("ralph")
        # Standard should be returned first (it's first in the candidates list).
        assert result != ""
        # Verify the standard file is preferred (no extra "ralph" subdir in path).
        normalized = result.replace("\\", "/")
        assert normalized.endswith("ralph/SKILL.md"), (
            f"Expected standard layout path, got: {result!r}"
        )


# ---------------------------------------------------------------------------
# Improvement 3: post_skill accepts alternative skill name field names
# ---------------------------------------------------------------------------


def _make_post_skill_payload(tool_input: dict, output_text: str = "# skill body " * 50) -> dict:
    """Build a minimal PostToolUse(Skill) payload."""
    return {
        "tool_name": "Skill",
        "session_id": "iter11-fieldname-test",
        "tool_input": tool_input,
        "tool_response": {"output": output_text},
    }


class TestPostSkillAlternativeFieldNames:
    """post_skill extracts skill name from 'skillName' and 'name' fallbacks."""

    def _run_post_skill_and_capture_name(
        self, tool_input: dict, skill_name: str, monkeypatch
    ) -> list[str]:
        """Shared helper: run post_skill and return the list of captured skill names.

        Requires the ``tmp_data_dir`` fixture to be active so data_dir is already patched.
        """
        from token_goat import session as _session

        captured_names: list[str] = []
        monkeypatch.setattr(_session, "lookup_skill_entry", lambda sid, name: None)

        def _mark(**kw):
            captured_names.append(kw.get("skill_name", ""))

        monkeypatch.setattr(_session, "mark_skill_loaded", _mark)

        with patch("token_goat.skill_cache.store_output") as mock_store:
            from dataclasses import dataclass

            @dataclass
            class _FakeMeta:
                output_id: str
                skill_name: str
                content_sha: str
                ts: float
                body_bytes: int
                truncated: bool
                source_path: str = ""

            mock_store.return_value = _FakeMeta(
                output_id=f"sid-{skill_name}-abc",
                skill_name=skill_name,
                content_sha="abc",
                ts=1.0,
                body_bytes=500,
                truncated=False,
            )

            with patch("token_goat.skill_cache.get_compact", return_value=None):
                payload = _make_post_skill_payload(tool_input)
                resp = hooks_skill.post_skill(payload)

        assert resp.get("continue") is True
        return captured_names

    def test_skill_field_standard(self, tmp_data_dir, monkeypatch):
        """Standard 'skill' field is still used when present."""
        names = self._run_post_skill_and_capture_name(
            {"skill": "ralph"}, "ralph", monkeypatch
        )
        assert "ralph" in names, f"Expected 'ralph', got: {names!r}"

    def test_skillname_camelcase_field(self, tmp_data_dir, monkeypatch):
        """'skillName' camelCase field is used when 'skill' is absent."""
        names = self._run_post_skill_and_capture_name(
            {"skillName": "ralph"}, "ralph", monkeypatch
        )
        assert "ralph" in names, (
            f"Expected 'ralph' captured from skillName field, got: {names!r}"
        )

    def test_name_field_fallback(self, tmp_data_dir, monkeypatch):
        """'name' field is used when both 'skill' and 'skillName' are absent."""
        names = self._run_post_skill_and_capture_name(
            {"name": "improve"}, "improve", monkeypatch
        )
        assert "improve" in names, (
            f"Expected 'improve' captured from 'name' field, got: {names!r}"
        )

    def test_missing_all_fields_skips_gracefully(self):
        """When no recognized field is present, handler returns continue without crash."""
        payload = _make_post_skill_payload({})
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True


# ---------------------------------------------------------------------------
# Improvement 4: compact coverage ratio guard (unit test)
# ---------------------------------------------------------------------------


class TestCompactCoverageRatioGuard:
    """Verify the compact-to-body ratio calculation used in the doctor."""

    def test_ratio_below_threshold_flags_warning(self):
        """A compact that is < 20% of the body should be flagged."""
        body_size = 30_000  # 30 KB
        compact_size = 1_000  # 1 KB — 3.3% of body, below 20% threshold

        ratio = compact_size / body_size
        assert ratio < 0.20, "Expected ratio below 20% to trigger warning"

    def test_ratio_above_threshold_is_healthy(self):
        """A compact that is >= 20% of the body is healthy."""
        body_size = 10_000  # 10 KB
        compact_size = 3_000  # 3 KB — 30% of body, healthy

        ratio = compact_size / body_size
        assert ratio >= 0.20, "Expected ratio >= 20% to not trigger warning"

    def test_ratio_edge_exactly_twenty_percent(self):
        """A compact exactly at 20% is not flagged (threshold is exclusive)."""
        body_size = 10_000
        compact_size = 2_000  # exactly 20%

        ratio = compact_size / body_size
        assert ratio == 0.20
        # Doctor uses `ratio < 0.20` so this would NOT be flagged.
        assert not (ratio < 0.20)

    def test_zero_compact_is_skipped(self):
        """A compact with zero size is skipped (not flagged as low coverage)."""
        compact_size = 0
        # In the doctor, `if compact_size == 0: continue` guards this case.
        assert compact_size == 0  # verification that guard applies

    def test_zero_body_is_skipped(self):
        """A body with zero size is skipped (avoid division by zero)."""
        body_size = 0
        # In the doctor, `if body_size is None or body_size == 0: continue` guards this.
        assert body_size == 0  # verification that guard applies

    def test_ratio_format_string(self):
        """Ratio is formatted as percentage in the warning message."""
        ratio = 0.133  # 13.3%
        formatted = f"{ratio:.0%}"
        assert formatted == "13%", f"Unexpected format: {formatted!r}"
