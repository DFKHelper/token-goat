"""Tests for skill context savings accuracy improvements (iteration 3).

Covers:
1. Session-level duplicate skill load hint (post_skill emits systemMessage on re-load)
2. Compact slice header ('--- compact form (N tokens) ---')
3. Skill name normalization (path prefix, .md suffix, casing)
4. Pre-read hook intercepts direct reads of skill body files
"""
from __future__ import annotations

import os

from token_goat import hooks_read, hooks_skill, session, skill_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LARGE_BODY = (
    "# Ralph\n\n"
    "## Key Rules\n\n"
    "CRITICAL: Never skip a DoD gate.\n"
    "MUST: Always check.\n\n"
    + ("padding " * 600)
)

_SMALL_BODY = "# Skill\n\n" + ("content " * 200)


def _skill_payload(sid: str, skill_name: str, body: str = _LARGE_BODY) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Skill",
        "tool_input": {"skill": skill_name},
        "tool_response": body,
    }


def _read_payload(sid: str, file_path: str) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Read",
        "tool_input": {"file_path": file_path},
    }


# ---------------------------------------------------------------------------
# Improvement 1: Session-level duplicate skill load hint
# ---------------------------------------------------------------------------

class TestDuplicateSkillLoadHint:
    """post_skill emits a systemMessage when the same large skill is re-loaded."""

    def test_first_load_no_reload_hint(self, tmp_data_dir):
        """First load of a skill does not emit a duplicate-load hint."""
        sid = "iter3-first-load"
        resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        assert resp.get("continue") is True
        sys_msg = resp.get("systemMessage", "")
        assert "already loaded" not in sys_msg

    def test_second_load_emits_reload_hint(self, tmp_data_dir):
        """Second load of the same skill emits a systemMessage recall hint."""
        sid = "iter3-second-load"
        hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        assert resp.get("continue") is True
        sys_msg = resp.get("systemMessage", "")
        assert "already loaded" in sys_msg
        assert "token-goat skill-body ralph" in sys_msg

    def test_reload_hint_includes_token_count(self, tmp_data_dir):
        """Reload hint mentions token estimate so the model can decide whether to recall."""
        sid = "iter3-reload-tokens"
        hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        sys_msg = resp.get("systemMessage", "")
        assert "token" in sys_msg

    def test_different_skills_no_cross_hint(self, tmp_data_dir):
        """Loading a different skill does not trigger the reload hint for the first skill."""
        sid = "iter3-different-skills"
        hooks_skill.post_skill(_skill_payload(sid, "ralph"))
        resp = hooks_skill.post_skill(_skill_payload(sid, "brainstorming"))
        sys_msg = resp.get("systemMessage", "")
        # Brainstorming is a first load — no reload hint.
        assert "already loaded" not in sys_msg


# ---------------------------------------------------------------------------
# Improvement 2: Compact slice header
# ---------------------------------------------------------------------------

class TestCompactSliceHeader:
    """store_compact prepends '--- compact form (N tokens) ---' header."""

    def test_header_present_in_stored_compact(self, tmp_data_dir):
        skill_cache.store_compact("iter3-hdr", "ralph", "Some compact content here.")
        result = skill_cache.get_compact("iter3-hdr", "ralph")
        assert result is not None
        assert result.startswith("--- compact form (")
        assert "tokens) ---" in result

    def test_header_token_count_positive(self, tmp_data_dir):
        text = "CRITICAL: Always do this.\nMUST: Never skip that."
        skill_cache.store_compact("iter3-hdr2", "testskill", text)
        result = skill_cache.get_compact("iter3-hdr2", "testskill") or ""
        import re
        m = re.search(r"compact form \((\d+) tokens\)", result)
        assert m is not None, f"header not found in: {result!r}"
        assert int(m.group(1)) >= 1

    def test_compact_body_follows_header(self, tmp_data_dir):
        text = "CRITICAL: Rule A.\nMUST: Rule B."
        skill_cache.store_compact("iter3-hdr3", "myskill", text)
        result = skill_cache.get_compact("iter3-hdr3", "myskill") or ""
        lines = result.splitlines()
        assert lines[0].startswith("--- compact form (")
        body_part = "\n".join(lines[1:])
        assert "CRITICAL: Rule A." in body_part

    def test_empty_compact_has_header(self, tmp_data_dir):
        """Even a trivially short compact gets the header."""
        skill_cache.store_compact("iter3-hdr4", "tiny", "x")
        result = skill_cache.get_compact("iter3-hdr4", "tiny") or ""
        assert "compact form" in result
        assert "x" in result


# ---------------------------------------------------------------------------
# Improvement 3: Skill name normalization in hooks_skill
# ---------------------------------------------------------------------------

class TestSkillNameNormalization:
    """hooks_skill normalizes skill names before caching."""

    def test_path_prefix_stripped(self, tmp_data_dir):
        """Skill name with path prefix is reduced to the basename."""
        sid = "iter3-norm-path"
        resp = hooks_skill.post_skill(_skill_payload(sid, "~/.claude/skills/ralph", _SMALL_BODY))
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history
        # No entry with slashes or tilde.
        assert all("/" not in k and "~" not in k for k in cache.skill_history)

    def test_md_suffix_stripped(self, tmp_data_dir):
        """Skill name ending in .md is stripped to the bare name."""
        sid = "iter3-norm-md"
        resp = hooks_skill.post_skill(_skill_payload(sid, "ralph.md", _SMALL_BODY))
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history
        assert "ralph.md" not in cache.skill_history

    def test_uppercase_normalized_to_lower(self, tmp_data_dir):
        """Mixed-case skill names are lowercased so cache lookups are consistent."""
        sid = "iter3-norm-case"
        resp = hooks_skill.post_skill(_skill_payload(sid, "Ralph", _SMALL_BODY))
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history
        assert "Ralph" not in cache.skill_history

    def test_windows_path_stripped(self, tmp_data_dir):
        r"""Backslash Windows path prefix is stripped."""
        sid = "iter3-norm-win"
        resp = hooks_skill.post_skill(
            _skill_payload(sid, r"C:\Users\user\.claude\skills\ralph", _SMALL_BODY)
        )
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history


# ---------------------------------------------------------------------------
# Improvement 4: Pre-read hook intercepts direct reads of skill body files
# ---------------------------------------------------------------------------

class TestSkillFileReadHint:
    """pre_read emits a hint when the agent tries to Read a skill body file."""

    def _load_skill(self, sid: str, skill_name: str = "ralph") -> None:
        hooks_skill.post_skill(_skill_payload(sid, skill_name, _SMALL_BODY))

    def test_skill_file_read_emits_hint_when_loaded(self, tmp_data_dir):
        """Reading a skill SKILL.md for an already-loaded skill emits a dedup hint."""
        sid = "iter3-skill-read-hint"
        self._load_skill(sid, "ralph")
        home = os.path.expanduser("~")
        skill_md = f"{home}/.claude/skills/ralph/SKILL.md"
        resp = hooks_read.pre_read(_read_payload(sid, skill_md))
        assert resp.get("continue") is True
        hook_out = resp.get("hookSpecificOutput", {})
        ctx = hook_out.get("additionalContext", "") if isinstance(hook_out, dict) else ""
        assert "token-goat skill-body ralph" in ctx
        assert "in context" in ctx

    def test_skill_file_read_no_hint_when_not_loaded(self, tmp_data_dir):
        """Reading a skill file for a NOT-yet-loaded skill passes through without hint."""
        sid = "iter3-skill-read-no-hint"
        home = os.path.expanduser("~")
        skill_md = f"{home}/.claude/skills/brainstorming/SKILL.md"
        resp = hooks_read.pre_read(_read_payload(sid, skill_md))
        assert resp.get("continue") is True
        hook_out = resp.get("hookSpecificOutput", {})
        ctx = hook_out.get("additionalContext", "") if isinstance(hook_out, dict) else ""
        assert "skill-body" not in ctx

    def test_detect_skill_name_from_path_bare(self):
        """_detect_skill_name_from_path extracts name from standard skills/ path."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_detect_skill_name_from_path_flat(self):
        """_detect_skill_name_from_path handles flat <name>.md layout."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/improve.md"
        )
        assert result == "improve"

    def test_detect_skill_name_windows_separators(self):
        r"""_detect_skill_name_from_path handles Windows backslash separators."""
        result = hooks_read._detect_skill_name_from_path(
            r"C:\Users\user\.claude\skills\ralph\SKILL.md"
        )
        assert result == "ralph"

    def test_detect_skill_name_non_skill_file_returns_none(self):
        """Non-skill files return None."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/settings.json"
        )
        assert result is None

    def test_detect_skill_name_plugin_layout(self):
        """Plugin-namespaced skill path is handled correctly."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/myplugin/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_hint_deduped_on_repeat_read(self, tmp_data_dir):
        """Hint is not re-emitted on a second read of the same skill file."""
        sid = "iter3-skill-read-dedup"
        self._load_skill(sid, "ralph")
        home = os.path.expanduser("~")
        skill_md = f"{home}/.claude/skills/ralph/SKILL.md"
        # First read: hint fires.
        resp1 = hooks_read.pre_read(_read_payload(sid, skill_md))
        hook_out1 = resp1.get("hookSpecificOutput", {})
        ctx1 = hook_out1.get("additionalContext", "") if isinstance(hook_out1, dict) else ""
        assert "skill-body" in ctx1

        # Second read: hint should be suppressed (fingerprint dedup).
        resp2 = hooks_read.pre_read(_read_payload(sid, skill_md))
        hook_out2 = resp2.get("hookSpecificOutput", {})
        ctx2 = hook_out2.get("additionalContext", "") if isinstance(hook_out2, dict) else ""
        assert "skill-body" not in ctx2
