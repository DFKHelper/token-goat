"""Tests for hooks_skill.pre_skill — PreToolUse(Skill) hook.

Covers:
1. Pass-through cases: no session, unknown tool, disabled config, first load with
   first_load_compact=False (default).
2. Repeat-load dedup: deny with compact; deny with recall-pointer when no compact;
   allow reload when compaction occurred after the skill load.
3. First-load compact (opt-in): deny with compact when COMPACT_END marker present;
   allow when marker absent; allow when file not found.
4. _normalize_skill_name: path stripping, .md stripping, empty-after-normalization.
5. _compaction_occurred_after: sentinel absent, sentinel older, sentinel newer.
"""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from token_goat import session, skill_cache
from token_goat.hooks_skill import (
    _compaction_occurred_after,
    _normalize_skill_name,
    pre_skill,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SESSION = "test-session-pre-skill"

_COMPACT_BODY = "# Compact\n\n- CRITICAL: do the thing.\n- MUST: always test.\n"
_FULL_BODY = _COMPACT_BODY + "\n<!-- COMPACT_END -->\n\n## Detail\n\n" + ("detail. " * 500)


def _payload(skill: str, session_id: str = _SESSION, tool_name: str = "Skill") -> dict:
    return {
        "tool_name": tool_name,
        "tool_input": {"skill": skill},
        "session_id": session_id,
    }


def _make_skill_entry(
    skill_name: str = "ralph",
    run_count: int = 1,
    ts: float | None = None,
    body_bytes: int = 40_000,
    content_sha: str = "abc123",
) -> session.SkillEntry:
    return session.SkillEntry(
        skill_name=skill_name,
        output_id="out-id",
        content_sha=content_sha,
        ts=ts if ts is not None else time.time() - 60,
        body_bytes=body_bytes,
        run_count=run_count,
    )


# ---------------------------------------------------------------------------
# Helper: config factory so tests can override specific fields
# ---------------------------------------------------------------------------

def _make_cfg(**overrides):
    """Return a SkillPreservationConfig with sensible defaults and optional overrides."""
    from token_goat.config import SkillPreservationConfig

    defaults = dict(
        enabled=True,
        max_cache_bytes=5 * 1024 * 1024,
        orphan_sweep_enabled=False,
        orphan_age_secs=604800,
        truncation_budget_tokens=800,
        compress_bodies=False,
        compress_min_bytes=16 * 1024,
        inline_snippets=True,
        pre_skill_enabled=True,
        first_load_compact=False,
        post_compact_full_loads=False,
    )
    defaults.update(overrides)
    return SkillPreservationConfig(**defaults)


def _patch_cfg(monkeypatch, **overrides):
    """Patch config.load() so it returns a config with the given skill_preservation settings."""
    from token_goat import config as config_mod

    cfg_obj = _make_cfg(**overrides)
    fake_config = MagicMock()
    fake_config.skill_preservation = cfg_obj
    monkeypatch.setattr(config_mod, "load", lambda: fake_config)


# ---------------------------------------------------------------------------
# 1. Pass-through cases
# ---------------------------------------------------------------------------

class TestPreSkillPassThrough:
    def test_non_skill_tool_name_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch)
        resp = pre_skill(_payload("ralph", tool_name="Bash"))
        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_no_session_id_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch)
        payload = {"tool_name": "Skill", "tool_input": {"skill": "ralph"}}
        resp = pre_skill(payload)
        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_disabled_pre_skill_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch, pre_skill_enabled=False)
        resp = pre_skill(_payload("ralph"))
        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_disabled_overall_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch, enabled=False)
        resp = pre_skill(_payload("ralph"))
        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_missing_skill_name_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch)
        payload = {"tool_name": "Skill", "tool_input": {}, "session_id": _SESSION}
        resp = pre_skill(payload)
        assert resp.get("continue") is True

    def test_empty_skill_name_after_normalization_passes_through(self, tmp_data_dir, monkeypatch):
        _patch_cfg(monkeypatch)
        resp = pre_skill(_payload("/", session_id=_SESSION))
        assert resp.get("continue") is True

    def test_first_load_no_prior_entry_first_load_compact_false(self, tmp_data_dir, monkeypatch):
        """With default config (first_load_compact=False), first load always passes through."""
        _patch_cfg(monkeypatch, first_load_compact=False)
        with patch.object(session, "lookup_skill_entry", return_value=None):
            resp = pre_skill(_payload("ralph"))
        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_non_dict_payload_passes_through(self, tmp_data_dir, monkeypatch):
        resp = pre_skill("not a dict")  # type: ignore[arg-type]
        assert resp.get("continue") is True


# ---------------------------------------------------------------------------
# 2. Repeat-load dedup
# ---------------------------------------------------------------------------

class TestPreSkillRepeatLoadDedup:
    def test_repeat_load_with_compact_denies(self, tmp_data_dir, monkeypatch):
        """When skill was loaded before and compact is available, deny with compact."""
        _patch_cfg(monkeypatch)
        entry = _make_skill_entry("ralph", run_count=2)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch.object(skill_cache, "get_compact", return_value=_COMPACT_BODY),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=False),
        ):
            resp = pre_skill(_payload("ralph"))

        assert resp.get("continue") is True
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        ctx = hso.get("additionalContext", "")
        assert "ralph" in ctx
        assert "already in context" in ctx
        assert _COMPACT_BODY.strip()[:30] in ctx

    def test_repeat_load_without_compact_denies_with_recall_pointer(self, tmp_data_dir, monkeypatch):
        """When skill was loaded before but no compact is cached, deny with recall pointer."""
        _patch_cfg(monkeypatch)
        entry = _make_skill_entry("brainstorming", run_count=1)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch.object(skill_cache, "get_compact", return_value=None),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=False),
        ):
            resp = pre_skill(_payload("brainstorming"))

        assert resp.get("continue") is True
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        ctx = hso.get("additionalContext", "")
        assert "brainstorming" in ctx
        assert "skill-body" in ctx

    def test_repeat_load_after_compaction_serves_compact_by_default(self, tmp_data_dir, monkeypatch):
        """Default (post_compact_full_loads=False) + compact available: deny with compact."""
        _patch_cfg(monkeypatch)  # post_compact_full_loads=False is the default
        entry = _make_skill_entry("ralph", run_count=1, ts=time.time() - 120)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch.object(skill_cache, "get_compact", return_value=_COMPACT_BODY),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=True),
        ):
            resp = pre_skill(_payload("ralph"))

        assert resp.get("continue") is True
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        assert _COMPACT_BODY.strip()[:30] in hso.get("additionalContext", "")

    def test_repeat_load_after_compaction_no_compact_allows_reload(self, tmp_data_dir, monkeypatch):
        """Default (post_compact_full_loads=False) + NO compact: allow full reload.

        Without a compact, a deny response would be pointer-only, leaving the model
        without operative rules.  pre_skill must fall back to a full reload.
        """
        _patch_cfg(monkeypatch)  # post_compact_full_loads=False
        entry = _make_skill_entry("ralph", run_count=1, ts=time.time() - 120)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch.object(skill_cache, "get_compact", return_value=None),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=True),
        ):
            resp = pre_skill(_payload("ralph"))

        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_repeat_load_after_compaction_allows_reload_opt_in(self, tmp_data_dir, monkeypatch):
        """post_compact_full_loads=True: full body reload allowed after compaction (opt-in)."""
        _patch_cfg(monkeypatch, post_compact_full_loads=True)
        entry = _make_skill_entry("ralph", run_count=1, ts=time.time() - 120)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=True),
        ):
            resp = pre_skill(_payload("ralph"))

        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_deny_reason_includes_run_count(self, tmp_data_dir, monkeypatch):
        """The deny reason string includes how many times the skill was loaded."""
        _patch_cfg(monkeypatch)
        entry = _make_skill_entry("superman", run_count=3)
        with (
            patch.object(session, "lookup_skill_entry", return_value=entry),
            patch.object(skill_cache, "get_compact", return_value=None),
            patch("token_goat.hooks_skill._compaction_occurred_after", return_value=False),
        ):
            resp = pre_skill(_payload("superman"))

        reason = resp["hookSpecificOutput"]["permissionDecisionReason"]
        assert "3" in reason or "3×" in reason


# ---------------------------------------------------------------------------
# 3. First-load compact (opt-in)
# ---------------------------------------------------------------------------

class TestPreSkillFirstLoadCompact:
    def _write_skill_file(self, tmp_path: Path, skill_name: str, body: str) -> Path:
        skill_dir = tmp_path / ".claude" / "skills" / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(body, encoding="utf-8")
        return skill_file

    def test_first_load_compact_enabled_with_marker_denies(self, tmp_data_dir, tmp_path, monkeypatch):
        """first_load_compact=True + COMPACT_END marker in file → deny + compact served."""
        _patch_cfg(monkeypatch, first_load_compact=True)
        skill_file = self._write_skill_file(tmp_path, "ralph", _FULL_BODY)

        with (
            patch.object(session, "lookup_skill_entry", return_value=None),
            patch("token_goat.hooks_skill._resolve_skill_body_path", return_value=str(skill_file)),
        ):
            resp = pre_skill(_payload("ralph"))

        assert resp.get("continue") is True
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        ctx = hso.get("additionalContext", "")
        assert "Compact operative summary" in ctx
        assert "CRITICAL: do the thing" in ctx
        # Detail section must not appear (it's after the marker)
        assert "detail." not in ctx

    def test_first_load_compact_enabled_no_marker_passes_through(self, tmp_data_dir, tmp_path, monkeypatch):
        """first_load_compact=True but skill file has no COMPACT_END marker → allow full load."""
        _patch_cfg(monkeypatch, first_load_compact=True)
        body_no_marker = "# Skill\n\n" + ("content. " * 200)
        skill_file = self._write_skill_file(tmp_path, "no-marker-skill", body_no_marker)

        with (
            patch.object(session, "lookup_skill_entry", return_value=None),
            patch("token_goat.hooks_skill._resolve_skill_body_path", return_value=str(skill_file)),
        ):
            resp = pre_skill(_payload("no-marker-skill"))

        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp

    def test_first_load_compact_enabled_file_not_found_passes_through(self, tmp_data_dir, monkeypatch):
        """first_load_compact=True but skill file not found → allow full load."""
        _patch_cfg(monkeypatch, first_load_compact=True)
        with (
            patch.object(session, "lookup_skill_entry", return_value=None),
            patch("token_goat.hooks_skill._resolve_skill_body_path", return_value=""),
        ):
            resp = pre_skill(_payload("unknown-skill"))

        assert resp.get("continue") is True
        assert "hookSpecificOutput" not in resp


# ---------------------------------------------------------------------------
# 4. _normalize_skill_name
# ---------------------------------------------------------------------------

class TestNormalizeSkillName:
    @pytest.mark.parametrize("raw,expected", [
        ("ralph", "ralph"),
        ("  ralph  ", "ralph"),
        ("RALPH", "ralph"),
        ("ralph.md", "ralph"),
        ("RALPH.MD", "ralph"),
        ("/home/user/.claude/skills/ralph/SKILL.md", "skill"),
        ("~/.claude/skills/ralph", "ralph"),
        ("ralph/SKILL.md", "skill"),
        ("/", ""),
        ("/.md", ""),
        ("brainstorming", "brainstorming"),
    ])
    def test_normalization(self, raw: str, expected: str):
        assert _normalize_skill_name(raw) == expected


# ---------------------------------------------------------------------------
# 5. _compaction_occurred_after
# ---------------------------------------------------------------------------

class TestCompactionOccurredAfter:
    def test_no_sentinel_returns_false(self, tmp_data_dir):
        assert _compaction_occurred_after("no-such-session", time.time() - 60) is False

    def test_sentinel_older_than_skill_returns_false(self, tmp_data_dir, monkeypatch):
        from token_goat import paths

        sidecar = paths.manifest_sha_sidecar_path("sess-compaction")
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text("sha|fp|0", encoding="utf-8")
        # Set sentinel mtime to 2 minutes ago
        old_time = time.time() - 120
        import os
        os.utime(sidecar, (old_time, old_time))
        # Skill loaded 1 minute ago (more recent than sentinel)
        skill_ts = time.time() - 60
        assert _compaction_occurred_after("sess-compaction", skill_ts) is False

    def test_sentinel_newer_than_skill_returns_true(self, tmp_data_dir):
        from token_goat import paths

        sidecar = paths.manifest_sha_sidecar_path("sess-compaction-new")
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text("sha|fp|0", encoding="utf-8")
        # Skill loaded 5 minutes ago, sentinel just written (now)
        skill_ts = time.time() - 300
        assert _compaction_occurred_after("sess-compaction-new", skill_ts) is True
