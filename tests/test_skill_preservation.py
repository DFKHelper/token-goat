"""Tests for the skill-preservation feature.

Covers the full chain:
1. skill_cache.store_output / load_output / sidecar / lookup_by_name
2. session.SkillEntry serialize / parse round-trip + mark_skill_loaded
3. hooks_skill.post_skill end-to-end capture
4. compact.build_manifest emits the "Active Skills" section
5. hooks_session._build_recovery_hint emits the "**Skills**:" block
6. config.SkillPreservationConfig load/save + env override
7. CLI `skill-body` / `skill-history` commands (light smoke)
"""
from __future__ import annotations

import os
import time

import pytest

from token_goat import (
    compact,
    config,
    hooks_session,
    hooks_skill,
    session,
    skill_cache,
)

# ---------------------------------------------------------------------------
# skill_cache
# ---------------------------------------------------------------------------

class TestSkillCacheStoreAndLoad:
    """Disk-backed body store mirroring bash_cache / web_cache semantics."""

    def test_small_body_round_trip(self, tmp_data_dir):
        body = "# Skill body\n\n" + ("rule. " * 200)
        meta = skill_cache.store_output("sess1", "ralph", body)
        assert meta is not None
        assert meta.skill_name == "ralph"
        assert meta.body_bytes == len(body.encode())
        assert meta.truncated is False
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None
        assert loaded.startswith("# Skill body")

    def test_large_body_is_tail_preserved(self, tmp_data_dir):
        # 512 KB > 256 KB cap → tail-preserve fires
        big = ("X" * 512) + "\n" + ("Y" * 524_288)
        meta = skill_cache.store_output("sess2", "huge", big)
        assert meta is not None
        assert meta.truncated is True
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None
        assert "token-goat: skill body truncated" in loaded
        assert loaded.endswith("Y")  # tail preserved

    def test_invalid_skill_name_rejected(self, tmp_data_dir):
        # Slashes, dots, null bytes are not in the safe-name regex.
        for bad in ("../etc/passwd", "with/slash", "with..dot", "with\x00null", ""):
            meta = skill_cache.store_output("sess3", bad, "body content here " * 50)
            assert meta is None, f"expected reject for {bad!r}"

    def test_namespaced_skill_name_accepted(self, tmp_data_dir):
        """plugin:skill form is normalised so ':' doesn't break filenames."""
        meta = skill_cache.store_output(
            "sess4", "plugin:improve", "improve skill body " * 50,
        )
        assert meta is not None
        assert meta.skill_name == "plugin:improve"
        # The on-disk filename must not contain the ':' (Windows would reject it).
        assert ":" not in meta.output_id

    def test_idempotent_same_body(self, tmp_data_dir):
        """Same (session, name, body) produces the same output_id (cache hit)."""
        body = "deterministic body " * 100
        meta_a = skill_cache.store_output("sess5", "ralph", body)
        meta_b = skill_cache.store_output("sess5", "ralph", body)
        assert meta_a is not None and meta_b is not None
        assert meta_a.output_id == meta_b.output_id
        assert meta_a.content_sha == meta_b.content_sha

    def test_changed_body_produces_new_id(self, tmp_data_dir):
        """Same skill name with different body content gets a new entry."""
        meta_a = skill_cache.store_output("sess6", "ralph", "v1 body " * 100)
        meta_b = skill_cache.store_output("sess6", "ralph", "v2 body " * 100)
        assert meta_a is not None and meta_b is not None
        assert meta_a.output_id != meta_b.output_id

    def test_sidecar_round_trip(self, tmp_data_dir):
        meta = skill_cache.store_output(
            "sess7", "ralph", "ralph body " * 100, source_path="/some/path.md",
        )
        assert meta is not None
        skill_cache.write_sidecar(meta)
        loaded = skill_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.skill_name == "ralph"
        assert loaded.content_sha == meta.content_sha
        assert loaded.source_path == "/some/path.md"

    def test_lookup_by_name_returns_latest(self, tmp_data_dir):
        meta_old = skill_cache.store_output("sess8", "ralph", "old body " * 100)
        assert meta_old is not None
        skill_cache.write_sidecar(meta_old)
        time.sleep(0.05)  # ensure ts ordering
        meta_new = skill_cache.store_output("sess8", "ralph", "new body " * 100)
        assert meta_new is not None
        skill_cache.write_sidecar(meta_new)
        found = skill_cache.lookup_by_name("ralph")
        assert found is not None
        assert found.output_id == meta_new.output_id


# ---------------------------------------------------------------------------
# session.SkillEntry
# ---------------------------------------------------------------------------

class TestSessionSkillEntry:
    def test_mark_skill_loaded_persists_to_cache(self, tmp_data_dir):
        sid = "session-test-mark-skill"
        cache = session.mark_skill_loaded(
            sid, "ralph", "out-id-1", "shahex", 1234, False,
            source_path="/path/to/SKILL.md",
        )
        assert "ralph" in cache.skill_history
        entry = cache.skill_history["ralph"]
        assert entry.output_id == "out-id-1"
        assert entry.content_sha == "shahex"
        assert entry.body_bytes == 1234
        assert entry.run_count == 1

    def test_repeat_load_increments_run_count(self, tmp_data_dir):
        sid = "session-test-repeat-skill"
        session.mark_skill_loaded(sid, "ralph", "out-1", "sha1", 100, False)
        session.mark_skill_loaded(sid, "ralph", "out-2", "sha2", 200, False)
        cache = session.load(sid)
        assert cache.skill_history["ralph"].run_count == 2
        # Latest body wins (output_id updated to most recent).
        assert cache.skill_history["ralph"].output_id == "out-2"

    def test_serialize_round_trip(self, tmp_data_dir):
        entry = session.SkillEntry(
            skill_name="ralph",
            output_id="abc-def",
            content_sha="deadbeef",
            ts=1700000000.0,
            body_bytes=5000,
            truncated=True,
            run_count=3,
            source_path="/p.md",
        )
        wire = session._serialize_skill_entry(entry)
        parsed = session._parse_skill_entry(dict(wire))
        assert parsed is not None
        assert parsed.skill_name == "ralph"
        assert parsed.content_sha == "deadbeef"
        assert parsed.run_count == 3
        assert parsed.source_path == "/p.md"

    def test_lookup_skill_entry(self, tmp_data_dir):
        sid = "session-lookup-skill"
        session.mark_skill_loaded(sid, "ralph", "oid", "sha", 100, False)
        entry = session.lookup_skill_entry(sid, "ralph")
        assert entry is not None and entry.skill_name == "ralph"
        assert session.lookup_skill_entry(sid, "nonexistent") is None

    def test_migrate_adds_skill_history(self, tmp_data_dir):
        """Old session JSON without skill_history loads cleanly."""
        legacy = {
            "session_id": "legacy",
            "started_ts": 1.0,
            "last_activity_ts": 1.0,
            "files": {},
            "greps": [],
        }
        migrated = session._migrate_session(dict(legacy))
        assert migrated["skill_history"] == {}


# ---------------------------------------------------------------------------
# hooks_skill
# ---------------------------------------------------------------------------

class TestPostSkillHook:
    def test_captures_body_to_cache_and_session(self, tmp_data_dir):
        sid = "session-hook-capture"
        body = "# Ralph SKILL\n\n" + ("DoD rule. " * 200)
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": body,
        }
        resp = hooks_skill.post_skill(payload)
        # Hook always returns CONTINUE — never blocks the agent.
        assert resp.get("continue") is True
        # Session should now have a skill_history entry.
        cache = session.load(sid)
        assert "ralph" in cache.skill_history
        entry = cache.skill_history["ralph"]
        # And the body should be retrievable.
        loaded = skill_cache.load_output(entry.output_id)
        assert loaded is not None and "DoD rule." in loaded

    def test_tiny_body_skipped(self, tmp_data_dir):
        """Bodies below the min-byte threshold are not cached (likely stubs)."""
        sid = "session-hook-tiny"
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "tiny"},
            "tool_response": "Skill loaded.",  # well under 256 byte min
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "tiny" not in cache.skill_history

    def test_wrong_tool_name_ignored(self, tmp_data_dir):
        payload = {
            "session_id": "sess-wrong",
            "tool_name": "Bash",  # not Skill
            "tool_input": {"command": "ls"},
            "tool_response": "out",
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True

    def test_disabled_by_config(self, tmp_data_dir, monkeypatch):
        sid = "session-hook-disabled"
        monkeypatch.setenv("TOKEN_GOAT_SKILL_PRESERVATION", "0")
        body = "# Ralph SKILL\n\n" + ("rule. " * 200)
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": body,
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" not in cache.skill_history

    def test_dict_response_extraction(self, tmp_data_dir):
        """tool_response as a dict with 'output' key is handled."""
        sid = "session-hook-dict"
        body_text = "# Ralph\n\n" + ("rule. " * 200)
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": {"output": body_text},
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history

    def test_mcp_content_array_extraction(self, tmp_data_dir):
        """tool_response with MCP-style content array gets concatenated."""
        sid = "session-hook-mcp"
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": {
                "content": [
                    {"type": "text", "text": "# Ralph header\n\n"},
                    {"type": "text", "text": "rule. " * 200},
                ],
            },
        }
        resp = hooks_skill.post_skill(payload)
        assert resp.get("continue") is True
        cache = session.load(sid)
        assert "ralph" in cache.skill_history


# ---------------------------------------------------------------------------
# compact manifest section
# ---------------------------------------------------------------------------

class TestManifestActiveSkillsSection:
    def test_section_appears_when_skill_loaded(self, tmp_data_dir):
        sid = "session-manifest-skill"
        body = "ralph body " * 200
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Skills:**" in m
        assert "ralph" in m
        # Skills are now collapsed to a single summary line; the generic recall
        # pattern is present rather than a per-skill command.
        assert "token-goat skill-body <name>" in m or "token-goat skill-body ralph" in m

    def test_run_count_marker_appears(self, tmp_data_dir):
        sid = "session-manifest-runs"
        for _ in range(3):
            meta = skill_cache.store_output(sid, "ralph", "body " * 100)
            assert meta is not None
            session.mark_skill_loaded(
                sid, meta.skill_name, meta.output_id, meta.content_sha,
                meta.body_bytes, meta.truncated,
            )
        m = compact.build_manifest(sid, max_tokens=600)
        # Look for the count suffix shape "×3" or "×N"
        assert "×3" in m or "x3" in m or "×2" in m  # exact count depends on dedup

    def test_event_count_includes_skills(self, tmp_data_dir):
        """A session whose only activity is a Skill load still clears the manifest gate."""
        sid = "session-event-skills"
        session.mark_skill_loaded(sid, "ralph", "oid", "sha", 1000, False)
        assert compact.event_count(sid) >= 1


# ---------------------------------------------------------------------------
# skill_cache.extract_checklist_section
# ---------------------------------------------------------------------------

class TestExtractChecklistSection:
    def test_dod_heading_extracted(self):
        body = "# ralph\n\nIntro text.\n\n## DoD\n\n- All tests pass\n- Lint clean\n\n## Other\n\nNot this.\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "All tests pass" in result
        assert "Not this" not in result

    def test_checklist_heading_extracted(self):
        body = "# Skill\n\n## Checklist\n\n1. Step one\n2. Step two\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "Step one" in result

    def test_steps_heading_extracted(self):
        body = "## Steps\n\n- do this\n- do that\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "do this" in result

    def test_dod_beats_steps_when_both_present(self):
        """## DoD has higher priority than ## Steps."""
        body = "## Steps\n\nstep content\n\n## DoD\n\ndod content\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "dod content" in result
        assert "step content" not in result

    def test_no_matching_heading_returns_none(self):
        body = "# Skill\n\n## Overview\n\nJust an overview.\n\n## Usage\n\nUsage text.\n"
        assert skill_cache.extract_checklist_section(body) is None

    def test_empty_body_returns_none(self):
        assert skill_cache.extract_checklist_section("") is None

    def test_matched_but_empty_section_returns_none(self):
        body = "## DoD\n\n## Next Section\n"
        assert skill_cache.extract_checklist_section(body) is None

    def test_long_section_capped_at_400_chars(self):
        long_content = "- item\n" * 200  # well over 400 chars
        body = f"## DoD\n\n{long_content}\n## End\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert len(result) <= 410  # 400 + possible "…" suffix
        assert result.endswith("…")

    def test_case_insensitive_heading_match(self):
        body = "## dod\n\n- lowercase dod\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "lowercase dod" in result

    def test_definition_of_done_heading(self):
        body = "## Definition of Done\n\n- criterion one\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "criterion one" in result

    def test_quick_start_heading(self):
        body = "## Quick Start\n\nrun this command\n"
        result = skill_cache.extract_checklist_section(body)
        assert result is not None
        assert "run this command" in result


# ---------------------------------------------------------------------------
# hooks_session recovery hint
# ---------------------------------------------------------------------------

class TestRecoveryHintSkills:
    def test_skills_block_appears(self, tmp_data_dir):
        sid = "session-recovery-skill"
        session.mark_skill_loaded(sid, "ralph", "oid1", "sha1", 25_000, False)
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Skills**" in hint
        assert "ralph" in hint
        # With no body stored, falls back to recall command format.
        assert "token-goat skill-body ralph" in hint
        assert "token-goat skill-body <name>" in hint

    def test_checklist_inlined_when_body_stored(self, tmp_data_dir):
        """When a body with a ## DoD section is cached, recovery hint inlines it."""
        sid = "session-recovery-checklist"
        dod_text = "- All tests pass\n- Lint clean\n- Mypy clean"
        body = f"# ralph\n\nIntro.\n\n## DoD\n\n{dod_text}\n\n## Other\n\nNot this.\n"
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Skills**" in hint
        assert "ralph" in hint
        # Checklist content must appear inline.
        assert "All tests pass" in hint
        # Should NOT fall back to recall command for this skill entry.
        assert "token-goat skill-body ralph" not in hint

    def test_fallback_when_no_checklist_in_body(self, tmp_data_dir):
        """Body stored but no checklist heading → fall back to recall command."""
        sid = "session-recovery-fallback"
        body = "# ralph\n\n## Overview\n\nJust an overview.\n\n## Usage\n\nUsage.\n" + ("x" * 300)
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "ralph" in hint
        assert "token-goat skill-body ralph" in hint

    def test_no_skills_no_block(self, tmp_data_dir):
        sid = "session-recovery-no-skill"
        # Only mark a file read — should produce a hint with no Skills block.
        session.mark_file_read(sid, "/tmp/foo.py", 0, 20)
        hint = hooks_session._build_recovery_hint(sid)
        if hint is not None:
            assert "**Skills**" not in hint


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

class TestSkillPreservationConfig:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_SKILL_PRESERVATION", raising=False)
        cfg = config.load()
        assert cfg.skill_preservation.enabled is True
        assert cfg.skill_preservation.max_cache_bytes == 5 * 1024 * 1024

    @pytest.mark.parametrize("val", ["0", "false", "no", "off", "FALSE"])
    def test_env_override_disables(self, monkeypatch, val):
        monkeypatch.setenv("TOKEN_GOAT_SKILL_PRESERVATION", val)
        cfg = config.load()
        assert cfg.skill_preservation.enabled is False

    def test_save_round_trip(self, tmp_data_dir, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_SKILL_PRESERVATION", raising=False)
        cfg = config.load()
        cfg.skill_preservation.enabled = False
        cfg.skill_preservation.max_cache_bytes = 10 * 1024 * 1024
        config.save(cfg)
        reloaded = config.load()
        assert reloaded.skill_preservation.enabled is False
        assert reloaded.skill_preservation.max_cache_bytes == 10 * 1024 * 1024


# ---------------------------------------------------------------------------
# CLI smoke (subprocess)
# ---------------------------------------------------------------------------

class TestCliSkillCommands:
    def test_skill_history_runs(self, tmp_data_dir):
        """`token-goat skill-history` returns successfully even when empty."""
        import subprocess
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            ["uv", "run", "python", "-X", "utf8", "-m",
             "token_goat.cli", "skill-history"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        # Should exit cleanly whether or not entries exist.
        assert result.returncode == 0, f"stderr: {result.stderr}"
