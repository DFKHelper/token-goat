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

    def test_lookup_by_name_returns_latest(self, tmp_data_dir, monkeypatch):
        import token_goat.skill_cache as _sc_mod  # noqa: PLC0415

        # Use monotonically increasing fake timestamps to guarantee ordering
        # without sleeping.  Each store_output call gets a distinct ts.
        _ts = [1000.0]

        def _fake_time():
            _ts[0] += 1.0
            return _ts[0]

        monkeypatch.setattr(_sc_mod.time, "time", _fake_time)

        meta_old = skill_cache.store_output("sess8", "ralph", "old body " * 100)
        assert meta_old is not None
        skill_cache.write_sidecar(meta_old)
        meta_new = skill_cache.store_output("sess8", "ralph", "new body " * 100)
        assert meta_new is not None
        skill_cache.write_sidecar(meta_new)
        found = skill_cache.lookup_by_name("ralph")
        assert found is not None
        assert found.output_id == meta_new.output_id

    def test_lookup_all_by_name_returns_newest_first(self, tmp_data_dir, monkeypatch):
        """Every cached entry for the same skill is returned, newest first."""
        import token_goat.skill_cache as _sc_mod  # noqa: PLC0415

        # Use monotonically increasing fake timestamps to guarantee ordering
        # without sleeping. Each store_output call gets a distinct ts.
        _ts = [1000.0]

        def _fake_time():
            val = _ts[0]
            _ts[0] += 1.0
            return val

        monkeypatch.setattr(_sc_mod.time, "time", _fake_time)
        meta_a = skill_cache.store_output("sess-all", "ralph", "v1 body " * 100)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)
        meta_b = skill_cache.store_output("sess-all", "ralph", "v2 body " * 100)
        assert meta_b is not None
        skill_cache.write_sidecar(meta_b)
        meta_c = skill_cache.store_output("sess-all2", "ralph", "v3 body " * 100)
        assert meta_c is not None
        skill_cache.write_sidecar(meta_c)
        result = skill_cache.lookup_all_by_name("ralph")
        assert len(result) == 3
        assert result[0].output_id == meta_c.output_id  # newest first
        assert result[2].output_id == meta_a.output_id

    def test_lookup_all_by_name_filters_other_skills(self, tmp_data_dir):
        meta_ralph = skill_cache.store_output("s1", "ralph", "ralph body " * 100)
        meta_improve = skill_cache.store_output("s1", "improve", "improve body " * 100)
        assert meta_ralph is not None and meta_improve is not None
        skill_cache.write_sidecar(meta_ralph)
        skill_cache.write_sidecar(meta_improve)
        result = skill_cache.lookup_all_by_name("ralph")
        assert len(result) == 1
        assert result[0].skill_name == "ralph"

    def test_lookup_all_by_name_invalid_returns_empty(self, tmp_data_dir):
        assert skill_cache.lookup_all_by_name("") == []
        assert skill_cache.lookup_all_by_name("../etc/passwd") == []


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
# hooks_skill._resolve_skill_body_path
# ---------------------------------------------------------------------------

class TestResolveSkillBodyPath:
    """Plugin-installed skills live under the marketplace cache, not a flat dir."""

    def test_user_skill_resolves(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        skill_dir = tmp_path / ".claude" / "skills" / "ralph"
        skill_dir.mkdir(parents=True)
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text("# ralph", encoding="utf-8")
        resolved = hooks_skill._resolve_skill_body_path("ralph")
        assert resolved == str(skill_md)

    def test_plugin_marketplace_layout_resolves(self, tmp_path, monkeypatch):
        """Marketplace plugins under cache/<marketplace>/<plugin>/<version>/skills/..."""
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        # ~/.claude/plugins/cache/claude-plugins-official/commit-commands/1.0.0/skills/commit/SKILL.md
        skill_md = (
            tmp_path / ".claude" / "plugins" / "cache" / "claude-plugins-official"
            / "commit-commands" / "1.0.0" / "skills" / "commit" / "SKILL.md"
        )
        skill_md.parent.mkdir(parents=True)
        skill_md.write_text("# commit", encoding="utf-8")
        resolved = hooks_skill._resolve_skill_body_path("commit-commands:commit")
        assert resolved == str(skill_md)

    def test_plugin_legacy_flat_layout_resolves(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        skill_md = (
            tmp_path / ".claude" / "plugins" / "myplug" / "skills"
            / "doit" / "SKILL.md"
        )
        skill_md.parent.mkdir(parents=True)
        skill_md.write_text("# doit", encoding="utf-8")
        resolved = hooks_skill._resolve_skill_body_path("myplug:doit")
        assert resolved == str(skill_md)

    def test_plugin_skill_falls_back_to_user_skills_dir(self, tmp_path, monkeypatch):
        """A plugin-prefixed skill that the user mirrored to ~/.claude/skills/<name>/."""
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        skill_md = tmp_path / ".claude" / "skills" / "improve" / "SKILL.md"
        skill_md.parent.mkdir(parents=True)
        skill_md.write_text("# improve", encoding="utf-8")
        resolved = hooks_skill._resolve_skill_body_path("plugin:improve")
        assert resolved == str(skill_md)

    def test_unknown_skill_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        assert hooks_skill._resolve_skill_body_path("does-not-exist") == ""
        assert hooks_skill._resolve_skill_body_path("plugin:also-gone") == ""

    def test_empty_name_returns_empty(self):
        assert hooks_skill._resolve_skill_body_path("") == ""

    def test_marketplace_picks_newest_version(self, tmp_path, monkeypatch):
        """When a plugin has multiple cached versions, prefer the newest."""
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        base = (
            tmp_path / ".claude" / "plugins" / "cache" / "mkt" / "plug"
        )
        old = base / "1.0.0" / "skills" / "x" / "SKILL.md"
        new = base / "2.0.0" / "skills" / "x" / "SKILL.md"
        old.parent.mkdir(parents=True)
        new.parent.mkdir(parents=True)
        old.write_text("# v1", encoding="utf-8")
        new.write_text("# v2", encoding="utf-8")
        resolved = hooks_skill._resolve_skill_body_path("plug:x")
        # Reverse-sorted version order = newest first.
        assert resolved == str(new)


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
    # Recovery hint format was simplified in commit 6fc1c46 (refactor:
    # collapse skill list to single-line format) to match compact.py's
    # manifest convention: `**Skills:** name1, name2, ... (recall via
    # \`token-goat skill-body <name>\`)`. Per-skill bullets, inlined DoD
    # checklists, sha8 dedup, and ×N count badges are no longer emitted —
    # the agent calls `token-goat skill-body <name>` (or `--section DoD`)
    # to retrieve the body on demand. These tests verify the new
    # single-line contract.
    def test_skills_block_appears(self, tmp_data_dir):
        sid = "session-recovery-skill"
        session.mark_skill_loaded(sid, "ralph", "oid1", "sha1", 25_000, False)
        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "**Skills:**" in hint
        assert "ralph" in hint
        # The single-line summary points the agent at the recall command.
        assert "token-goat skill-body <name>" in hint

    def test_checklist_inlined_when_body_stored(self, tmp_data_dir):
        """Body with a ## DoD heading is reachable via the recall hint.

        Inlining checklists was removed in commit 6fc1c46 — the new format
        names the skill and points at `token-goat skill-body <name>
        --section DoD`. The body is still cached; verify the skill name is
        in the hint and the section-retrieval tip is present.
        """
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
        assert "**Skills:**" in hint
        assert "ralph" in hint
        # The --section tip points the agent at how to fetch the DoD body.
        assert "--section DoD" in hint

    def test_fallback_when_no_checklist_in_body(self, tmp_data_dir):
        """Skill name appears in the single-line hint with recall pointer."""
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
        assert "token-goat skill-body <name>" in hint

    def test_no_skills_no_block(self, tmp_data_dir):
        sid = "session-recovery-no-skill"
        # Only mark a file read — should produce a hint with no Skills block.
        session.mark_file_read(sid, "/tmp/foo.py", 0, 20)
        hint = hooks_session._build_recovery_hint(sid)
        if hint is not None:
            assert "**Skills:**" not in hint


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


# ---------------------------------------------------------------------------
# Orphan sweep
# ---------------------------------------------------------------------------

class TestSkillCacheOrphanSweep:
    """One-shot orphan blob sweep for the skill body cache."""

    def _reset_sweep(self, monkeypatch):
        """Reset the module-level _sweep_done flag so each test starts fresh."""
        monkeypatch.setattr(skill_cache, "_sweep_done", False)
        monkeypatch.delenv("TOKEN_GOAT_ORPHAN_SWEEP", raising=False)

    def _force_sweep_enabled(self, monkeypatch):
        """Patch config.load to always return orphan_sweep_enabled=True.

        The process-level config cache can carry stale config from earlier tests
        in the same worker (e.g. a test that set orphan_sweep_enabled=False).
        Patching load() guarantees the sweep actually runs, making tests that
        assert file removal deterministic.
        """
        from token_goat import config as cfg_module
        orig_load = cfg_module.load
        def _enabled_load():
            c = orig_load()
            c.skill_preservation.orphan_sweep_enabled = True
            return c
        monkeypatch.setattr(cfg_module, "load", _enabled_load)

    def _make_blob(self, cache_dir, name: str, age_secs: float):
        blob = cache_dir / name
        blob.write_text("dummy skill body", encoding="utf-8")
        old = time.time() - age_secs
        os.utime(blob, (old, old))
        return blob

    def test_sweep_function_exists(self):
        assert hasattr(skill_cache, "_sweep_skill_orphans")
        assert callable(skill_cache._sweep_skill_orphans)

    def test_sweep_runs_once_per_process(self, tmp_data_dir, monkeypatch):
        """_sweep_done gate: second call is a no-op."""
        self._reset_sweep(monkeypatch)
        self._force_sweep_enabled(monkeypatch)
        calls = []
        orig = skill_cache._skill_outputs_dir
        def mock_dir():
            calls.append(1)
            return orig()
        monkeypatch.setattr(skill_cache, "_skill_outputs_dir", mock_dir)
        skill_cache._sweep_skill_orphans()
        skill_cache._sweep_skill_orphans()
        assert len(calls) == 1

    def test_removes_old_blobs(self, tmp_data_dir, monkeypatch):
        """Blobs older than orphan_age_secs are deleted."""
        self._reset_sweep(monkeypatch)
        self._force_sweep_enabled(monkeypatch)
        cache_dir = skill_cache._skill_outputs_dir()
        # Name must match OUTPUT_FILENAME_RE: {chars}.txt
        old_name = "a" * 16 + "-ralph-" + "b" * 16 + ".txt"
        old_blob = self._make_blob(cache_dir, old_name, age_secs=8 * 86400)
        skill_cache._sweep_skill_orphans()
        assert not old_blob.exists(), "old blob should have been swept"

    def test_leaves_recent_blobs(self, tmp_data_dir, monkeypatch):
        """Blobs newer than orphan_age_secs are untouched."""
        self._reset_sweep(monkeypatch)
        self._force_sweep_enabled(monkeypatch)
        cache_dir = skill_cache._skill_outputs_dir()
        recent_name = "c" * 16 + "-improve-" + "d" * 16 + ".txt"
        recent_blob = self._make_blob(cache_dir, recent_name, age_secs=3600)
        skill_cache._sweep_skill_orphans()
        assert recent_blob.exists(), "recent blob must not be swept"

    def test_skips_json_sidecars(self, tmp_data_dir, monkeypatch):
        """Sidecar .json files are not deleted directly by the sweep."""
        self._reset_sweep(monkeypatch)
        self._force_sweep_enabled(monkeypatch)
        cache_dir = skill_cache._skill_outputs_dir()
        # A stale .json with no matching .txt blob — must not be deleted
        sidecar_name = "e" * 16 + "-skill-" + "f" * 16 + ".json"
        sidecar = cache_dir / sidecar_name
        sidecar.write_text("{}", encoding="utf-8")
        old = time.time() - 8 * 86400
        os.utime(sidecar, (old, old))
        skill_cache._sweep_skill_orphans()
        assert sidecar.exists(), "orphaned sidecar without blob must survive"

    def test_also_removes_sidecar_when_blob_removed(self, tmp_data_dir, monkeypatch):
        """When an old blob is removed, its sidecar is removed too."""
        self._reset_sweep(monkeypatch)
        self._force_sweep_enabled(monkeypatch)
        cache_dir = skill_cache._skill_outputs_dir()
        blob_name = "1" * 16 + "-myskill-" + "2" * 16 + ".txt"
        blob = self._make_blob(cache_dir, blob_name, age_secs=8 * 86400)
        sidecar = blob.with_suffix(".json")
        sidecar.write_text('{"skill_name": "myskill"}', encoding="utf-8")
        skill_cache._sweep_skill_orphans()
        assert not blob.exists()
        assert not sidecar.exists(), "sidecar should be removed alongside blob"

    def test_disabled_by_config(self, tmp_data_dir, monkeypatch):
        """orphan_sweep_enabled=False disables the sweep."""
        self._reset_sweep(monkeypatch)
        from token_goat import config as cfg_module
        cache_dir = skill_cache._skill_outputs_dir()
        old_name = "3" * 16 + "-oldskill-" + "4" * 16 + ".txt"
        old_blob = self._make_blob(cache_dir, old_name, age_secs=8 * 86400)
        orig_load = cfg_module.load
        def mock_load():
            c = orig_load()
            c.skill_preservation.orphan_sweep_enabled = False
            return c
        monkeypatch.setattr(cfg_module, "load", mock_load)
        skill_cache._sweep_skill_orphans()
        assert old_blob.exists(), "blob should survive when sweep is disabled"

    def test_handles_missing_cache_dir(self, tmp_path, monkeypatch):
        """Sweep handles a non-existent cache directory gracefully."""
        self._reset_sweep(monkeypatch)
        monkeypatch.setattr(skill_cache, "_skill_outputs_dir", lambda: tmp_path / "nonexistent")
        skill_cache._sweep_skill_orphans()  # must not raise

    def test_handles_io_error_on_unlink(self, tmp_data_dir, monkeypatch):
        """File-removal errors are swallowed; sweep continues."""
        from pathlib import Path
        self._reset_sweep(monkeypatch)
        cache_dir = skill_cache._skill_outputs_dir()
        old_name = "5" * 16 + "-errskill-" + "6" * 16 + ".txt"
        self._make_blob(cache_dir, old_name, age_secs=8 * 86400)
        orig_unlink = Path.unlink
        calls = [0]
        def fail_unlink(self, missing_ok=False):
            calls[0] += 1
            if calls[0] == 1:
                raise OSError("disk full")
            return orig_unlink(self, missing_ok=missing_ok)
        monkeypatch.setattr(Path, "unlink", fail_unlink)
        try:
            skill_cache._sweep_skill_orphans()
        except OSError:
            pytest.fail("_sweep_skill_orphans() raised OSError")

    def test_env_override_disables(self, tmp_data_dir, monkeypatch):
        """TOKEN_GOAT_ORPHAN_SWEEP=0 disables the skill orphan sweep."""
        self._reset_sweep(monkeypatch)
        monkeypatch.setenv("TOKEN_GOAT_ORPHAN_SWEEP", "0")
        monkeypatch.delenv("TOKEN_GOAT_SKILL_PRESERVATION", raising=False)
        cfg = config.load()
        assert cfg.skill_preservation.orphan_sweep_enabled is False

    def test_config_orphan_age_secs_default(self, monkeypatch):
        """Default orphan_age_secs is 7 days."""
        monkeypatch.delenv("TOKEN_GOAT_ORPHAN_SWEEP", raising=False)
        cfg = config.load()
        assert cfg.skill_preservation.orphan_age_secs == 604800
