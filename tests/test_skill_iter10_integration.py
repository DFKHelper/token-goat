"""End-to-end integration tests for skill context savings (iteration 10 of 10).

Covers three gaps identified in the final audit:

1. **Full round-trip integration**: PostToolUse(Skill) hook → compact stored →
   session_start(source="compact") writes sidecar → pre_read hook injects sidecar.
   The only existing tests in test_post_compact_recovery.py call
   ``_build_recovery_hint`` directly (unit) or use ``store_output`` + ``mark_skill_loaded``
   by hand (semi-integration).  No test fires the hook, then fires session_start,
   then fires pre_read and asserts the hint surfaces in ``additionalContext``.

2. **install.py CLAUDE.md / SKILL.md skill commands**: ``CLAUDE_MD_CONTENT`` and
   ``SKILL_MD_CONTENT`` must document the five skill CLI commands added in
   iterations 1-9 (skill-body, skill-compact, skill-list, skill-size, skill-section).

3. **mypy** — already clean; no annotation gaps found.
"""
from __future__ import annotations

import json

from conftest import fire_skill_hook
from hook_helpers import assert_continue as _assert_continue
from typer.testing import CliRunner

from token_goat import cli, hooks_read, hooks_session, paths, skill_cache

runner = CliRunner()

# ---------------------------------------------------------------------------
# Realistic large skill fixture (>4000 bytes so the hook triggers compact storage)
# ---------------------------------------------------------------------------

_SKILL_COMPACT_SECTION = """\
# test-skill

Skill for integration testing.

## Key Rules

- CRITICAL: Always run tests before claiming done.
- MUST: Commit after each validated step.
- NEVER: Claim success without evidence.
- RULE: Zero lint warnings before shipping.

## DoD

1. All tests pass.
2. Lint clean.
3. Types pass.
"""

_SKILL_DETAIL_SECTION = (
    "\n## Extended Reference\n\n"
    "This section provides deep background on how the skill phases work.\n\n"
    "### Phase 1\n\nExplore the codebase without writing files.\n\n"
    "### Phase 2\n\nDraft a multi-step plan with atomic, verifiable steps.\n\n"
    "### Phase 3\n\nImplement one step at a time. Validate after each.\n\n"
    + ("Extended detail content for padding. " * 150)
)

_LARGE_SKILL_BODY_WITH_MARKER = (
    _SKILL_COMPACT_SECTION
    + "\n<!-- COMPACT_END -->\n"
    + _SKILL_DETAIL_SECTION
)

_LARGE_SKILL_BODY_NO_MARKER = (
    "# no-marker-skill\n\n## DoD\n\n- CRITICAL: All tests pass.\n- MUST: Lint clean.\n\n"
    "## Background\n\nThis skill has no COMPACT_END marker.\n\n"
    + ("Background content for padding. " * 200)
)


# ---------------------------------------------------------------------------
# 1. Full round-trip: hook → session → session_start(compact) → pre_read inject
# ---------------------------------------------------------------------------


class TestFullSkillRoundTrip:
    """End-to-end: PostToolUse Skill → compact cached → session_start(compact) writes sidecar
    → pre_read injects the sidecar in additionalContext.

    This is the integration test that was missing: it wires every layer together
    rather than calling individual functions directly.
    """

    def test_hook_to_sidecar_with_marker_skill(self, tmp_data_dir):
        """Full chain: hook stores compact → session_start(compact) writes sidecar
        that mentions the skill name and recall command.
        """
        sid = "e2e-marker-sidecar"

        # Step 1: PostToolUse Skill fires — stores body + compact.
        resp = fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)
        assert resp.get("continue") is True

        # Verify compact was stored (precondition for the sidecar to mention compact).
        stored_compact = skill_cache.get_compact(sid, "test-skill")
        assert stored_compact is not None, "compact must be stored after hook fires"

        # Step 2: session_start with source="compact" writes the sidecar.
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)

        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "sidecar must be written on compact session start"

        content = sidecar.read_text(encoding="utf-8")
        assert "test-skill" in content, f"skill name missing from sidecar:\n{content}"
        assert "token-goat skill-body" in content, (
            f"recall command missing from sidecar:\n{content}"
        )

    def test_hook_to_pre_read_injection(self, tmp_data_dir):
        """Full chain: hook + session_start(compact) + pre_read → additionalContext
        contains the skill name.
        """
        sid = "e2e-pre-read-inject"

        # Step 1: fire hook.
        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)

        # Step 2: session_start(compact) writes sidecar.
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        assert paths.recovery_pending_path(sid).exists(), "sidecar must exist before pre_read"

        # Step 3: pre_read injects the hint.
        pre_read_resp = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/main.py"},
        })
        _assert_continue(pre_read_resp)

        hso = pre_read_resp.get("hookSpecificOutput")
        assert hso is not None, "pre_read must inject the hint on first call after compact"
        ctx = hso.get("additionalContext", "")
        assert "test-skill" in ctx, (
            f"skill name missing from injected additionalContext:\n{ctx}"
        )

        # Sidecar must be cleaned up.
        assert not paths.recovery_pending_path(sid).exists(), (
            "sidecar must be deleted after injection"
        )

    def test_hook_to_pre_read_no_double_injection(self, tmp_data_dir):
        """Second pre_read after recovery injection must NOT re-inject."""
        sid = "e2e-no-double-inject"

        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        # First call injects.
        r1 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/main.py"},
        })
        _assert_continue(r1)
        assert r1.get("hookSpecificOutput") is not None, "first call must inject"

        # Second call must NOT inject again.
        r2 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/other.py"},
        })
        _assert_continue(r2)
        hso2 = r2.get("hookSpecificOutput")
        # hookSpecificOutput may be present for other reasons (e.g. a read hint),
        # but it must NOT contain the Post-Compact Recovery header again.
        if hso2:
            ctx2 = hso2.get("additionalContext", "")
            assert "Post-Compact Recovery" not in ctx2, (
                "second pre_read must NOT re-inject the recovery hint"
            )

    def test_no_marker_skill_also_surfaces_in_sidecar(self, tmp_data_dir):
        """A skill with no COMPACT_END marker also appears in the recovery sidecar."""
        sid = "e2e-no-marker-sidecar"

        fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "sidecar must be written even for no-marker skill"
        content = sidecar.read_text(encoding="utf-8")
        assert "no-marker-skill" in content, (
            f"no-marker skill name missing from sidecar:\n{content}"
        )

    def test_two_skills_both_in_sidecar(self, tmp_data_dir):
        """Two loaded skills both appear in the recovery sidecar."""
        sid = "e2e-two-skills-sidecar"

        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)
        fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER)

        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })

        content = paths.recovery_pending_path(sid).read_text(encoding="utf-8")
        assert "test-skill" in content
        assert "no-marker-skill" in content

    def test_compact_stored_survives_round_trip(self, tmp_data_dir):
        """Compact extracted by the hook is readable after the full round-trip."""
        sid = "e2e-compact-survives"

        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)

        # Compact must be readable before and after the session_start + pre_read cycle.
        before = skill_cache.get_compact(sid, "test-skill")
        assert before is not None, "compact must be stored after hook"
        assert "CRITICAL" in before, "compact must contain key rules"

        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/main.py"},
        })

        after = skill_cache.get_compact(sid, "test-skill")
        assert after is not None, "compact must still be readable after full round-trip"
        assert after == before, "compact content must not change during round-trip"


# ---------------------------------------------------------------------------
# 2. install.py CLAUDE.md and SKILL.md must document skill commands
# ---------------------------------------------------------------------------


class TestInstallSkillCommandDocumentation:
    """CLAUDE_MD_CONTENT and SKILL_MD_CONTENT must document the skill CLI commands."""

    def test_claude_md_content_has_skill_body(self):
        """CLAUDE_MD_CONTENT includes skill-body command documentation."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "skill-body" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention skill-body command"
        )

    def test_claude_md_content_has_skill_compact(self):
        """CLAUDE_MD_CONTENT includes skill-compact command documentation."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "skill-compact" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention skill-compact command"
        )

    def test_claude_md_content_has_skill_list(self):
        """CLAUDE_MD_CONTENT includes skill-list command documentation."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "skill-list" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention skill-list command"
        )

    def test_claude_md_content_has_skill_size(self):
        """CLAUDE_MD_CONTENT includes skill-size command documentation."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "skill-size" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention skill-size command"
        )

    def test_claude_md_content_has_skill_section(self):
        """CLAUDE_MD_CONTENT includes skill-section command documentation."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "skill-section" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention skill-section command"
        )

    def test_claude_md_content_mentions_get_content(self):
        """CLAUDE_MD_CONTENT mentions PowerShell Get-Content as a read equivalent."""
        from token_goat.install import CLAUDE_MD_CONTENT

        assert "Get-Content" in CLAUDE_MD_CONTENT, (
            "CLAUDE_MD_CONTENT must mention PowerShell Get-Content"
        )

    def test_skill_md_content_has_skill_body(self):
        """SKILL_MD_CONTENT includes skill-body command documentation."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "skill-body" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention skill-body command"
        )

    def test_skill_md_content_has_skill_compact(self):
        """SKILL_MD_CONTENT includes skill-compact command documentation."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "skill-compact" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention skill-compact command"
        )

    def test_skill_md_content_has_skill_list(self):
        """SKILL_MD_CONTENT includes skill-list command documentation."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "skill-list" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention skill-list command"
        )

    def test_skill_md_content_has_skill_size(self):
        """SKILL_MD_CONTENT includes skill-size command documentation."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "skill-size" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention skill-size command"
        )

    def test_skill_md_content_has_skill_section(self):
        """SKILL_MD_CONTENT includes skill-section command documentation."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "skill-section" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention skill-section command"
        )

    def test_skill_md_content_mentions_get_content(self):
        """SKILL_MD_CONTENT mentions PowerShell Get-Content as a read equivalent."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "Get-Content" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must mention PowerShell Get-Content"
        )

    def test_routing_table_includes_powershell_row(self):
        """_ROUTING_ROWS base list must include a PowerShell Get-Content row."""
        from token_goat.install import _ROUTING_ROWS

        has_ps_row = any("PowerShell" in str(row) or "Get-Content" in str(row) for row in _ROUTING_ROWS)
        assert has_ps_row, (
            "_ROUTING_ROWS must include a PowerShell Get-Content routing row; "
            "all three install content strings derive from this table"
        )

    def test_all_three_routing_tables_have_get_content(self):
        """CLAUDE_MD, SKILL_MD, and CODEX_AGENTS_MD must all include Get-Content."""
        from token_goat.install import CLAUDE_MD_CONTENT, CODEX_AGENTS_MD_CONTENT, SKILL_MD_CONTENT

        for name, content in (
            ("CLAUDE_MD_CONTENT", CLAUDE_MD_CONTENT),
            ("SKILL_MD_CONTENT", SKILL_MD_CONTENT),
            ("CODEX_AGENTS_MD_CONTENT", CODEX_AGENTS_MD_CONTENT),
        ):
            assert "Get-Content" in content, f"{name} is missing the PowerShell Get-Content row"

    def test_claude_md_skill_commands_have_one_line_descriptions(self):
        """Each skill command in CLAUDE_MD_CONTENT is followed by a brief description."""
        from token_goat.install import CLAUDE_MD_CONTENT

        for cmd in ("skill-body", "skill-compact", "skill-list", "skill-size", "skill-section"):
            # Each command should appear with some descriptive context on the same line.
            lines_with_cmd = [
                ln for ln in CLAUDE_MD_CONTENT.splitlines() if cmd in ln
            ]
            assert lines_with_cmd, f"No line containing {cmd!r} found in CLAUDE_MD_CONTENT"
            # At least one line must have more content than just the command name.
            has_description = any(
                len(ln.strip()) > len(f"`token-goat {cmd}`") + 5
                for ln in lines_with_cmd
            )
            assert has_description, (
                f"Command {cmd!r} in CLAUDE_MD_CONTENT has no description on the same line"
            )

    def test_skill_md_skill_commands_section_present(self):
        """SKILL_MD_CONTENT has a dedicated ## Skill commands section."""
        from token_goat.install import SKILL_MD_CONTENT

        assert "## Skill commands" in SKILL_MD_CONTENT, (
            "SKILL_MD_CONTENT must have a '## Skill commands' heading"
        )


# ---------------------------------------------------------------------------
# 3. skill-list CLI reflects skills registered via the hook
# ---------------------------------------------------------------------------


class TestSkillListCLIAfterHook:
    """token-goat skill-list correctly reflects what the hook has stored."""

    def test_skill_list_shows_hook_loaded_skill(self, tmp_data_dir, monkeypatch):
        """skill-list includes a skill that was loaded via the PostToolUse hook."""
        sid = "skill-list-hook-1"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)

        result = runner.invoke(cli.app, ["skill-list", "--session-id", sid])
        assert result.exit_code == 0, f"skill-list failed: {result.stdout}"
        assert "test-skill" in result.stdout, (
            f"test-skill not in skill-list output:\n{result.stdout}"
        )

    def test_skill_list_shows_compact_yes_for_marker_skill(self, tmp_data_dir, monkeypatch):
        """skill-list shows compact=yes for a skill with COMPACT_END marker."""
        sid = "skill-list-hook-compact"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)

        result = runner.invoke(cli.app, ["skill-list", "--session-id", sid, "--json"])
        assert result.exit_code == 0, f"skill-list --json failed: {result.stdout}"
        data = json.loads(result.stdout)
        skills = data.get("skills", [])
        entry = next((s for s in skills if s.get("name") == "test-skill"), None)
        assert entry is not None, f"test-skill not in JSON output: {skills}"
        # skill-list --json uses "has_compact" as the key name.
        assert entry.get("has_compact") is True, (
            f"has_compact should be True for marker skill, got: {entry}"
        )

    def test_skill_list_two_skills_after_two_hooks(self, tmp_data_dir, monkeypatch):
        """skill-list shows both skills after two hook invocations."""
        sid = "skill-list-hook-two"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER)
        fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER)

        result = runner.invoke(cli.app, ["skill-list", "--session-id", sid])
        assert result.exit_code == 0, f"skill-list failed: {result.stdout}"
        assert "test-skill" in result.stdout
        assert "no-marker-skill" in result.stdout
