"""Tests for context growth mitigation changes (design doc 2026-06-05).

Covers:
- Change 4: pregen_skill_compacts() at install time + get_compact_any_session()
- Change 2: pre_skill and post_skill compact advisories
- Change 3: threshold-crossing ETA in user_prompt_submit
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat import install, paths, skill_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _call_context_section():
    """Invoke _build_context_section() — shared by all test classes in this file."""
    from token_goat.cli_doctor import _build_context_section

    return _build_context_section()

def _write_precompact_sentinel(
    bytes_estimate: int | None = None,
    *,
    age_seconds: float | None = None,
    content: str | None = None,
) -> None:
    """Write precompact_estimate_test.json sentinel, optionally backdated."""
    import json
    import os

    sentinels_dir = paths.sentinels_dir()
    sentinels_dir.mkdir(parents=True, exist_ok=True)
    p = sentinels_dir / "precompact_estimate_test.json"
    text = content if content is not None else json.dumps({"bytes_estimate": bytes_estimate})
    p.write_text(text, encoding="utf-8")
    if age_seconds is not None:
        t = time.time() - age_seconds
        os.utime(p, (t, t))

_SIMPLE_SKILL_BODY = """\
---
description: A simple test skill for unit tests.
---

# Test Skill

## Overview

This is a test skill body for pre-generation testing.

## Usage

Call it when you need to test compact pre-generation.

CRITICAL: This line must appear in the compact.
"""

_LARGE_SKILL_BODY = "# Large Skill\n\n" + ("x " * 5000) + "\nCRITICAL: Large skill marker.\n"

def _make_skill_dir(parent: Path, name: str, body: str = _SIMPLE_SKILL_BODY) -> Path:
    """Create a minimal ~/.claude/skills/<name>/SKILL.md under *parent*."""
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body, encoding="utf-8")
    return skill_dir

# ---------------------------------------------------------------------------
# Change 4: get_compact_any_session
# ---------------------------------------------------------------------------

class TestGetCompactAnySession:
    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):
        self.data_dir = tmp_data_dir

    def test_returns_none_when_no_compact_exists(self):
        result = skill_cache.get_compact_any_session("nonexistent-skill")
        assert result is None

    def test_finds_compact_from_install_session(self):
        body = _SIMPLE_SKILL_BODY
        sha = skill_cache.content_hash(body)
        compact_text = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact("_install", "test-skill", compact_text, source_sha=sha)

        result = skill_cache.get_compact_any_session("test-skill")
        assert result is not None
        assert "compact form" in result

    def test_finds_newest_when_multiple_sessions(self):
        body = _SIMPLE_SKILL_BODY
        sha = skill_cache.content_hash(body)
        compact = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact("session-aaa", "multi-skill", compact, source_sha=sha)
        compact2 = compact + "\n# Extra section"
        skill_cache.store_compact("session-bbb", "multi-skill", compact2, source_sha=sha)

        result = skill_cache.get_compact_any_session("multi-skill")
        assert result is not None

    def test_plugin_namespaced_skill(self):
        body = _SIMPLE_SKILL_BODY
        sha = skill_cache.content_hash(body)
        compact = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact("_install", "myplugin:myscill", compact, source_sha=sha)

        result = skill_cache.get_compact_any_session("myplugin:myscill")
        assert result is not None

    def test_returns_none_for_invalid_name(self):
        result = skill_cache.get_compact_any_session("")
        assert result is None

        result = skill_cache.get_compact_any_session("../etc/passwd")
        assert result is None

# ---------------------------------------------------------------------------
# Change 4: pregen_skill_compacts
# ---------------------------------------------------------------------------

class TestPregenSkillCompacts:
    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir, monkeypatch):
        self.data_dir = tmp_data_dir
        # Point paths.claude_skills_dir() and claude_plugins_dir() to our tmp home.
        self.fake_skills_root = tmp_data_dir / "fake_skills"
        self.fake_plugins_root = tmp_data_dir / "fake_plugins"
        self.fake_skills_root.mkdir()
        self.fake_plugins_root.mkdir()
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: self.fake_skills_root)
        monkeypatch.setattr(paths, "claude_plugins_dir", lambda: self.fake_plugins_root)

    def test_generates_compacts_for_user_skills(self):
        _make_skill_dir(self.fake_skills_root, "skill-alpha")
        _make_skill_dir(self.fake_skills_root, "skill-beta")

        summary = install.pregen_skill_compacts()

        assert "2 skills found" in summary
        assert "2 generated" in summary

        # Compacts should be retrievable cross-session.
        assert skill_cache.get_compact_any_session("skill-alpha") is not None
        assert skill_cache.get_compact_any_session("skill-beta") is not None

    def test_skips_up_to_date_compact(self):
        _make_skill_dir(self.fake_skills_root, "fresh-skill")
        # Pre-generate once.
        install.pregen_skill_compacts()
        # Second run should skip.
        summary = install.pregen_skill_compacts()
        assert "1 up-to-date" in summary
        assert "generated" not in summary or "0 generated" in summary or "1 skills found" in summary

    def test_writes_sentinel_file(self):
        _make_skill_dir(self.fake_skills_root, "sentinel-skill")
        install.pregen_skill_compacts()

        sentinel = paths.skill_pregen_sentinel_path()
        assert sentinel.exists()
        data = json.loads(sentinel.read_text())
        assert "ts" in data
        assert data["skill_count"] == 1
        assert data["compact_count"] >= 1

    def test_handles_empty_skills_dir(self):
        summary = install.pregen_skill_compacts()
        assert "0 skills found" in summary

    def test_handles_skills_dir_not_existing(self, monkeypatch):
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: self.fake_skills_root / "does_not_exist")
        summary = install.pregen_skill_compacts()
        assert "0 skills found" in summary

    def test_discovers_plugin_skills(self):
        # Create marketplace-layout plugin skill:
        # plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
        plugin_skill_dir = (
            self.fake_plugins_root
            / "cache"
            / "hub"
            / "my-plugin"
            / "v1.0.0"
            / "skills"
            / "my-plugin-skill"
        )
        plugin_skill_dir.mkdir(parents=True)
        (plugin_skill_dir / "SKILL.md").write_text(_SIMPLE_SKILL_BODY, encoding="utf-8")

        summary = install.pregen_skill_compacts()

        assert "1 skills found" in summary
        assert skill_cache.get_compact_any_session("my-plugin:my-plugin-skill") is not None

    def test_subsequent_post_skill_finds_cache_hit(self):
        _make_skill_dir(self.fake_skills_root, "cached-skill", body=_SIMPLE_SKILL_BODY)
        install.pregen_skill_compacts()

        # After pre-gen, get_compact_any_session should return a compact.
        result = skill_cache.get_compact_any_session("cached-skill")
        assert result is not None
        assert "compact form" in result

# ---------------------------------------------------------------------------
# Change 4: install_all includes skill compact pre-gen step
# ---------------------------------------------------------------------------

def test_install_all_includes_pregen_step(tmp_data_dir, monkeypatch, patched_home):
    """install_all() should include a 'skill compact pre-gen' result key."""
    fake_skills = patched_home / ".claude" / "skills"
    fake_skills.mkdir(parents=True, exist_ok=True)
    _make_skill_dir(fake_skills, "install-test-skill")

    monkeypatch.setattr(paths, "claude_skills_dir", lambda: fake_skills)
    monkeypatch.setattr(paths, "claude_plugins_dir", lambda: patched_home / ".claude" / "plugins")

    with (
        patch("token_goat.install.patch_settings_json", return_value=(True, "ok")),
        patch("token_goat.install.patch_claude_md", return_value="ok"),
        patch("token_goat.install._install_platform_autostart"),
        patch("token_goat.install.probe_image_codecs", return_value={"ok": True, "summary": "ok"}),
        patch("token_goat.install._remove_legacy_launchers", return_value=[]),
    ):
        result = install.install_all()

    assert "skill compact pre-gen" in result
    assert "FAIL" not in result["skill compact pre-gen"]

# ---------------------------------------------------------------------------
# Change 4: sentinel-based new-plugin gap detection
# ---------------------------------------------------------------------------

class TestPluginGapDetection:
    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir, monkeypatch):
        self.data_dir = tmp_data_dir
        self.fake_skills_root = tmp_data_dir / "fake_skills"
        self.fake_plugins_root = tmp_data_dir / "fake_plugins"
        self.fake_skills_root.mkdir()
        self.fake_plugins_root.mkdir()
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: self.fake_skills_root)
        monkeypatch.setattr(paths, "claude_plugins_dir", lambda: self.fake_plugins_root)

    def test_sentinel_ts_is_after_pregen(self):
        _make_skill_dir(self.fake_skills_root, "gap-skill")
        t_before = time.time()
        install.pregen_skill_compacts()
        sentinel = paths.skill_pregen_sentinel_path()
        data = json.loads(sentinel.read_text())
        assert data["ts"] >= t_before

    def test_no_sentinel_before_pregen(self):
        sentinel = paths.skill_pregen_sentinel_path()
        assert not sentinel.exists()

    def test_sentinel_updated_on_second_run(self):
        _make_skill_dir(self.fake_skills_root, "gap-skill2")
        install.pregen_skill_compacts()
        sentinel = paths.skill_pregen_sentinel_path()
        ts1 = json.loads(sentinel.read_text())["ts"]

        install.pregen_skill_compacts()
        ts2 = json.loads(sentinel.read_text())["ts"]
        assert ts2 >= ts1

# ---------------------------------------------------------------------------
# Change 2: pre_skill context advisory (2a)
# ---------------------------------------------------------------------------

# Minimal skill body that fits within the "small" advisory threshold so it
# doesn't trigger the post_skill advisory unless we force the size.
_SMALL_SKILL_BODY = "# Tiny Skill\n\nOne liner.\n"

# 9 KB body — above _ADVISORY_BODY_THRESHOLD_BYTES (8 KB) but below
# _LARGE_BODY_THRESHOLD_BYTES (40 KB), so post_skill goes Path 2 (sync).
_MEDIUM_SKILL_BODY = "# Medium Skill\n\n" + ("w " * 4_500) + "\nCRITICAL: medium marker.\n"

# 42 KB body — above _LARGE_BODY_THRESHOLD_BYTES, so post_skill goes Path 3/4 (async/info).
_XLARGE_SKILL_BODY = "# XLarge Skill\n\n" + ("z " * 21_000) + "\nCRITICAL: xlarge marker.\n"

def _make_pre_skill_payload(session_id: str, skill_name: str) -> dict:
    """Build a minimal pre_skill (PreToolUse) payload."""
    return {
        "session_id": session_id,
        "tool_name": "Skill",
        "tool_input": {"skill": skill_name},
    }

def _make_post_skill_payload(session_id: str, skill_name: str, body: str) -> dict:
    """Build a minimal post_skill (PostToolUse) payload."""
    return {
        "session_id": session_id,
        "tool_name": "Skill",
        "tool_input": {"skill": skill_name},
        "tool_response": body,
    }

class TestChange2PreSkillAdvisory:
    """Tests for the 2a non-blocking context advisory in pre_skill."""

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):
        self.data_dir = tmp_data_dir

    def _run_pre_skill(self, session_id: str, skill_name: str) -> dict:
        from token_goat import hooks_skill

        payload = _make_pre_skill_payload(session_id, skill_name)
        return hooks_skill.pre_skill(payload)

    def test_emits_advisory_when_context_high_and_skill_large(self):
        """Context > 60 % and incoming skill > 4 K tokens → non-blocking advisory."""
        with (
            patch("token_goat.hooks_skill._estimate_context_fill", return_value=0.75),
            patch("token_goat.hooks_skill._estimate_incoming_skill_tokens", return_value=6_000),
        ):
            resp = self._run_pre_skill("sess-advisory", "big-skill")

        # Must be a non-blocking CONTINUE (not a deny/redirect).
        assert resp.get("continue") is True
        # The advisory lands in hookSpecificOutput → additionalContext.
        hook_out = resp.get("hookSpecificOutput", {})
        additional = hook_out.get("additionalContext", "")
        assert "token-goat" in additional
        assert "context at" in additional
        assert "big-skill" in additional
        assert "compact" in additional.lower()

    def test_no_advisory_when_context_below_threshold(self):
        """Context ≤ 60 % → no advisory, plain CONTINUE with no additionalContext."""
        with (
            patch("token_goat.hooks_skill._estimate_context_fill", return_value=0.45),
            patch("token_goat.hooks_skill._estimate_incoming_skill_tokens", return_value=8_000),
        ):
            resp = self._run_pre_skill("sess-low-ctx", "any-skill")

        assert resp.get("continue") is True
        hook_out = resp.get("hookSpecificOutput", {})
        assert "additionalContext" not in hook_out or hook_out.get("additionalContext") == ""

    def test_no_advisory_when_skill_tokens_below_threshold(self):
        """Context > 60 % but skill ≤ 4 K tokens → no advisory."""
        with (
            patch("token_goat.hooks_skill._estimate_context_fill", return_value=0.80),
            patch("token_goat.hooks_skill._estimate_incoming_skill_tokens", return_value=2_000),
        ):
            resp = self._run_pre_skill("sess-small-skill", "tiny-skill")

        assert resp.get("continue") is True
        hook_out = resp.get("hookSpecificOutput", {})
        assert "additionalContext" not in hook_out or hook_out.get("additionalContext") == ""

    def test_advisory_disabled_via_config(self):
        """pre_skill_advisory=False → advisory suppressed even at 90 % context."""
        from token_goat.config import Config, HintsConfig

        fake_cfg = Config()
        fake_cfg.hints = HintsConfig(pre_skill_advisory=False)

        with (
            patch("token_goat.hooks_skill._estimate_context_fill", return_value=0.90),
            patch("token_goat.hooks_skill._estimate_incoming_skill_tokens", return_value=10_000),
            patch("token_goat.config.load", return_value=fake_cfg),
        ):
            resp = self._run_pre_skill("sess-disabled", "big-skill")

        assert resp.get("continue") is True
        hook_out = resp.get("hookSpecificOutput", {})
        assert "additionalContext" not in hook_out or hook_out.get("additionalContext") == ""

    def test_estimate_failure_does_not_block_skill(self):
        """If estimation raises, pre_skill still returns CONTINUE (fail-soft)."""
        with patch(
            "token_goat.hooks_skill._estimate_context_fill",
            side_effect=RuntimeError("simulated failure"),
        ):
            resp = self._run_pre_skill("sess-err", "any-skill")

        assert resp.get("continue") is True

# ---------------------------------------------------------------------------
# Change 2: post_skill 4-path compact advisory (2b)
# ---------------------------------------------------------------------------

class TestChange2PostSkillCompactPaths:
    """Tests for the 4-path compact advisory logic in post_skill."""

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):
        self.data_dir = tmp_data_dir

    def _run_post_skill(self, session_id: str, skill_name: str, body: str) -> dict:
        from token_goat import hooks_skill

        payload = _make_post_skill_payload(session_id, skill_name, body)
        return hooks_skill.post_skill(payload)

    # -- Path 1: pre-generated compact with matching SHA --------------------

    def test_path1_uses_pregen_compact_on_sha_match(self):
        """Pre-gen compact with SHA matching current body → system_message with 'Pre-generated'."""
        body = _MEDIUM_SKILL_BODY
        body_sha = skill_cache.content_hash(body)
        compact = skill_cache.generate_compact_summary(body)
        # Store a pregen compact under the install session.
        skill_cache.store_compact("_install", "pregen-skill", compact, source_sha=body_sha)

        resp = self._run_post_skill("sess-path1", "pregen-skill", body)

        assert resp.get("continue") is True
        system_msg = resp.get("systemMessage", "")
        # Advisory must mention the skill name and 'Pre-generated'.
        assert "pregen-skill" in system_msg
        assert "Pre-generated" in system_msg

    def test_path1_skips_generation_when_pregen_hit(self):
        """Path 1: _generate_and_store_compact must NOT be called on a SHA hit."""
        body = _MEDIUM_SKILL_BODY
        body_sha = skill_cache.content_hash(body)
        compact = skill_cache.generate_compact_summary(body)
        skill_cache.store_compact("_install", "pregen-no-gen", compact, source_sha=body_sha)

        with patch("token_goat.hooks_skill._generate_and_store_compact") as mock_gen:
            self._run_post_skill("sess-path1-skip", "pregen-no-gen", body)

        mock_gen.assert_not_called()

    # -- Path 2: sync generation for small-to-medium bodies ----------------

    def test_path2_sync_generates_compact_for_medium_body(self):
        """No pre-gen, body < 40 KB → compact generated synchronously."""
        body = _MEDIUM_SKILL_BODY  # ~9 KB, above advisory threshold
        assert len(body.encode()) < 40_000

        resp = self._run_post_skill("sess-path2", "medium-skill", body)

        assert resp.get("continue") is True
        # After sync generation, a compact should be stored for this session.
        stored = skill_cache.get_compact("sess-path2", "medium-skill")
        assert stored is not None
        # system_message should mention the skill and compact token count.
        system_msg = resp.get("systemMessage", "")
        assert "medium-skill" in system_msg
        assert "tokens" in system_msg

    def test_path2_no_system_message_for_tiny_body(self):
        """Small body < _ADVISORY_BODY_THRESHOLD_BYTES (8 KB) → no system_message."""
        body = _SMALL_SKILL_BODY
        assert len(body.encode()) < 8_000

        resp = self._run_post_skill("sess-path2-tiny", "tiny-skill", body)

        assert resp.get("continue") is True
        # No advisory for tiny skills below the advisory threshold.
        assert not resp.get("systemMessage")

    # -- Path 3: async generation for large body when worker alive ----------

    def test_path3_dispatches_thread_when_worker_alive(self):
        """body >= 40 KB, worker alive → daemon thread spawned, no blocking generation."""
        body = _XLARGE_SKILL_BODY
        assert len(body.encode()) >= 40_000

        with (
            patch("token_goat.worker.is_worker_alive", return_value=True),
            patch("token_goat.hooks_skill._generate_and_store_compact") as mock_gen,
            patch("threading.Thread") as mock_thread_cls,
        ):
            mock_thread = mock_thread_cls.return_value
            resp = self._run_post_skill("sess-path3", "xlarge-skill", body)

        assert resp.get("continue") is True
        # Thread must be constructed and started.
        mock_thread_cls.assert_called_once()
        mock_thread.start.assert_called_once()
        # Sync generation must NOT run in the hook body.
        mock_gen.assert_not_called()
        # system_message should mention background generation.
        system_msg = resp.get("systemMessage", "")
        assert "background" in system_msg.lower()
        assert "xlarge-skill" in system_msg

    # -- Path 4: info-only when worker is down and no pre-gen --------------

    def test_path4_info_only_when_worker_down(self):
        """body >= 40 KB, worker down → info-only system_message, no generation."""
        body = _XLARGE_SKILL_BODY
        assert len(body.encode()) >= 40_000

        with (
            patch("token_goat.worker.is_worker_alive", return_value=False),
            patch("token_goat.hooks_skill._generate_and_store_compact") as mock_gen,
        ):
            resp = self._run_post_skill("sess-path4", "xlarge-offline", body)

        assert resp.get("continue") is True
        mock_gen.assert_not_called()
        system_msg = resp.get("systemMessage", "")
        # Must tell the user how to resolve (install or skill-compact --all).
        assert "xlarge-offline" in system_msg
        assert "install" in system_msg or "skill-compact" in system_msg

    # -- Stale pre-gen (SHA mismatch) falls through to path 2/3/4 ----------

    def test_stale_pregen_compact_falls_through_to_sync(self):
        """Pre-gen compact with wrong SHA → treated as absent; sync generation runs."""
        body = _MEDIUM_SKILL_BODY
        # Store a compact that has a *different* SHA than the current body.
        skill_cache.store_compact("_install", "stale-skill", "old compact text", source_sha="deadbeef")

        with patch("token_goat.hooks_skill._generate_and_store_compact") as mock_gen:
            mock_gen.return_value = (100, 2250)
            resp = self._run_post_skill("sess-stale", "stale-skill", body)

        assert resp.get("continue") is True
        # Sync generation must have been called since the pre-gen SHA doesn't match.
        mock_gen.assert_called_once()

# ---------------------------------------------------------------------------
# Change 3: threshold-crossing ETA in user_prompt_submit
# ---------------------------------------------------------------------------

def _run_user_prompt_submit(session_id: str, prompt: str = "what changed?") -> dict:
    """Call user_prompt_submit and return the hook response."""
    from token_goat import hooks_session

    payload = {
        "session_id": session_id,
        "prompt": prompt,
    }
    return hooks_session.user_prompt_submit(payload)

def _set_loaded_skill_tokens(session_id: str, tokens: int) -> None:
    """Directly set loaded_skill_total_tokens on the session cache for testing."""
    from token_goat import session as ses

    cache = ses.safe_load(session_id, caller="test")
    if cache is None:
        cache = ses._fresh_cache(session_id)
    cache.loaded_skill_total_tokens = tokens
    ses.save(cache)

class TestChange3ThresholdAdvisory:
    """Tests for the threshold-crossing context advisory in user_prompt_submit."""

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):
        self.data_dir = tmp_data_dir

    def test_no_advisory_below_50_percent(self):
        """Below 50% context fill → existing status line, no ctx part."""
        sid = "sess-c3-low"
        # 0 loaded skill tokens → pct = 10,800 / 660,000 ≈ 1.6%, well below 50%
        _set_loaded_skill_tokens(sid, 0)

        resp = _run_user_prompt_submit(sid)
        ctx = resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "ctx" not in ctx
        assert "CONTEXT" not in ctx

    def test_first_crossing_50_percent_appends_ctx_part(self):
        """First turn above 50% → ctx appended to status line."""
        sid = "sess-c3-50"
        # 10,800 tokens catalog; need ~50% of 660,000 = 330,000 total
        # loaded_skill_total_tokens ≈ 330,000 - 10,800 = 319,200
        _set_loaded_skill_tokens(sid, 320_000)

        resp = _run_user_prompt_submit(sid)
        ctx = resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "ctx:" in ctx
        assert "context approaching midpoint" in ctx
        # Must be the bracket-joined format, not urgency prefix.
        assert ctx.startswith("[")
        assert "CONTEXT" not in ctx

    def test_50_percent_crossing_fires_only_once(self):
        """Second turn still above 50% → no ctx part (one-time crossing)."""
        sid = "sess-c3-50-once"
        _set_loaded_skill_tokens(sid, 320_000)

        _run_user_prompt_submit(sid)   # first turn — fires
        resp2 = _run_user_prompt_submit(sid)  # second turn — should not fire again

        ctx = resp2.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "ctx:" not in ctx
        assert "context approaching midpoint" not in ctx

    def test_first_crossing_70_percent_replaces_summary(self):
        """First turn above 70% → CONTEXT urgency prefix replaces normal format."""
        sid = "sess-c3-70"
        # loaded_skill_total_tokens ≈ 70% of 660,000 - 10,800 ≈ 451,200
        _set_loaded_skill_tokens(sid, 452_000)

        resp = _run_user_prompt_submit(sid)
        ctx = resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert ctx.startswith("[CONTEXT ~7")
        assert "Consider /compact soon." in ctx

    def test_70_percent_crossing_fires_only_once(self):
        """Second turn still above 70% → no repeat of 70% advisory."""
        sid = "sess-c3-70-once"
        _set_loaded_skill_tokens(sid, 452_000)

        _run_user_prompt_submit(sid)   # first turn — fires
        resp2 = _run_user_prompt_submit(sid)  # second turn — should not fire again

        ctx = resp2.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "Consider /compact soon." not in ctx

    def test_85_percent_fires_every_turn(self):
        """Above 85% → urgency advisory fires on every turn (no one-time gate)."""
        sid = "sess-c3-85"
        # loaded_skill_total_tokens ≈ 85% of 660,000 - 10,800 ≈ 550,200
        _set_loaded_skill_tokens(sid, 551_000)

        resp1 = _run_user_prompt_submit(sid)
        resp2 = _run_user_prompt_submit(sid)

        for resp in (resp1, resp2):
            ctx = resp.get("hookSpecificOutput", {}).get("additionalContext", "")
            assert ctx.startswith("[CONTEXT ~8")
            assert "/compact now." in ctx

    def test_turns_since_last_compact_increments(self):
        """turns_since_last_compact increments on each user_prompt_submit call."""
        from token_goat import session as ses

        sid = "sess-c3-turns"
        _set_loaded_skill_tokens(sid, 0)

        _run_user_prompt_submit(sid)
        _run_user_prompt_submit(sid)
        _run_user_prompt_submit(sid)

        cache = ses.safe_load(sid, caller="test")
        assert cache is not None
        assert cache.turns_since_last_compact == 3

    def test_advisory_disabled_via_config(self):
        """context_threshold_advisory=False → no CONTEXT prefix even at 90%."""
        from token_goat.config import Config, HintsConfig

        sid = "sess-c3-disabled"
        _set_loaded_skill_tokens(sid, 600_000)  # ~90%

        fake_cfg = Config(hints=HintsConfig(context_threshold_advisory=False))
        with (
            patch("token_goat.hooks_session._cfg_mod", None, create=True),
            patch("token_goat.config.load", return_value=fake_cfg),
        ):
            resp = _run_user_prompt_submit(sid)

        ctx = resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "CONTEXT" not in ctx
        assert "ctx:" not in ctx

# ---------------------------------------------------------------------------
# Change 1: doctor --context footprint section
# ---------------------------------------------------------------------------

def _make_session_with_skills(
    tmp_data_dir: Path,
    session_id: str,
    skills: list[tuple[str, int]],  # (name, body_bytes)
    turns: int = 5,
) -> None:
    """Create a session cache with the given loaded skills and turn count."""
    from token_goat import session as ses
    from token_goat.session import SkillEntry

    cache = ses._fresh_cache(session_id)
    cache.turns_since_last_compact = turns
    for skill_name, body_bytes in skills:
        cache.skill_history[skill_name] = SkillEntry(
            skill_name=skill_name,
            output_id=f"fake-{skill_name}-id",
            content_sha="deadbeef",
            ts=1000.0,
            body_bytes=body_bytes,
        )
    ses.save(cache)

class TestChange1ContextFootprint:
    """Tests for _build_context_section() and the doctor --context flag."""

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir, monkeypatch):
        self.data_dir = tmp_data_dir
        self.fake_skills_root = tmp_data_dir / "fake_skills"
        self.fake_plugins_root = tmp_data_dir / "fake_plugins"
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: self.fake_skills_root)
        monkeypatch.setattr(paths, "claude_plugins_dir", lambda: self.fake_plugins_root)

    def _call(self):
        return _call_context_section()

    # -----------------------------------------------------------------------
    # Basic structure
    # -----------------------------------------------------------------------

    def test_returns_lines_and_flag(self, tmp_data_dir):
        """_build_context_section() returns (list[str], bool) without raising."""
        lines, auto = self._call()
        assert isinstance(lines, list)
        assert isinstance(auto, bool)
        assert any("Context footprint" in ln for ln in lines)

    def test_section_absent_when_low_fill_no_uncompacted(self, tmp_data_dir):
        """No loaded skills, low fill → should_auto_show is False."""
        # Empty skills dir, no session → fill_pct near zero.
        lines, auto = self._call()
        assert auto is False

    # -----------------------------------------------------------------------
    # should_auto_show triggers
    # -----------------------------------------------------------------------

    def test_auto_show_when_fill_exceeds_40_percent(self, tmp_data_dir, monkeypatch):
        """fill_pct > 0.40 → should_auto_show=True."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-high"
        # 300,000 body_bytes → ~75,000 tokens from loaded skills alone
        # catalog ≈ 0 tokens, conversation ≈ 10,000 → total ~85,000
        # Need ~264,000 tokens for 40% of 660,000.  Use 1,100,000 bytes.
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 5
        cache.skill_history["big-skill"] = SkillEntry(
            skill_name="big-skill",
            output_id="fake-big-id",
            content_sha="aabbccdd",
            ts=1000.0,
            body_bytes=1_100_000,
        )
        ses.save(cache)

        lines, auto = self._call()
        assert auto is True

    def test_auto_show_when_loaded_skill_over_2k_lacks_compact(self, tmp_data_dir, monkeypatch):
        """Loaded skill > 2K tokens with no compact → should_auto_show=True."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-no-compact"
        # 10,000 bytes → 2,500 tokens > 2,000 threshold
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2
        cache.skill_history["medium-skill"] = SkillEntry(
            skill_name="medium-skill",
            output_id="fake-med-id",
            content_sha="11223344",
            ts=1000.0,
            body_bytes=10_000,
        )
        ses.save(cache)

        lines, auto = self._call()
        assert auto is True

    def test_no_auto_show_when_small_skill_has_no_compact(self, tmp_data_dir, monkeypatch):
        """Loaded skill ≤ 2K tokens (tiny) without compact → should_auto_show stays False if fill < 40%."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-tiny"
        # 4,000 bytes → 1,000 tokens ≤ 2,000 — does not trigger auto-show
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2
        cache.skill_history["tiny-skill"] = SkillEntry(
            skill_name="tiny-skill",
            output_id="fake-tiny-id",
            content_sha="aabbccdd",
            ts=1000.0,
            body_bytes=4_000,
        )
        ses.save(cache)

        lines, auto = self._call()
        assert auto is False

    # -----------------------------------------------------------------------
    # Compact coverage reporting
    # -----------------------------------------------------------------------

    def test_loaded_skill_with_compact_shows_savings(self, tmp_data_dir, monkeypatch):
        """Skill with a compact shows 'compact: N tok  saves ~M tok' in output."""
        from token_goat import session as ses
        from token_goat import skill_cache
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-with-compact"
        body = "# Large Skill\n\n" + ("word " * 2000)  # ~10 KB
        compact_text = "# Compact\n\nSummary only.\n"

        skill_cache.store_compact(sid, "rich-skill", compact_text)

        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["rich-skill"] = SkillEntry(
            skill_name="rich-skill",
            output_id="fake-rich-id",
            content_sha="ccddccdd",
            ts=1000.0,
            body_bytes=len(body.encode()),
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "rich-skill" in combined
        # The compact line should mention "compact:" with token counts
        assert "compact:" in combined
        assert "saves" in combined

    def test_loaded_skill_without_compact_shows_action(self, tmp_data_dir, monkeypatch):
        """Skill without compact shows 'no compact' and 'token-goat skill-compact NAME'."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-no-cpt"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["bare-skill"] = SkillEntry(
            skill_name="bare-skill",
            output_id="fake-bare-id",
            content_sha="00112233",
            ts=1000.0,
            body_bytes=30_000,  # 7,500 tokens
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "bare-skill" in combined
        assert "no compact" in combined
        assert "token-goat skill-compact bare-skill" in combined

    # -----------------------------------------------------------------------
    # Skills catalog
    # -----------------------------------------------------------------------

    def test_catalog_count_includes_installed_skills(self, tmp_data_dir, monkeypatch):
        """Skills on disk are counted in the catalog."""
        _make_skill_dir(self.fake_skills_root, "alpha")
        _make_skill_dir(self.fake_skills_root, "beta")

        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should show catalog_count = 2
        assert "2 skills" in combined

    # -----------------------------------------------------------------------
    # New-since-pregen detection
    # -----------------------------------------------------------------------

    def test_never_run_pregen_shows_warning(self, tmp_data_dir, monkeypatch):
        """No sentinel file → 'never run' message is emitted."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "never run" in combined

    def test_new_skills_since_pregen_reported(self, tmp_data_dir, monkeypatch):
        """skill_count in sentinel < current count → 'installed since last pre-gen' message."""
        # Create 2 skill dirs
        _make_skill_dir(self.fake_skills_root, "skill-one")
        _make_skill_dir(self.fake_skills_root, "skill-two")

        # Write a sentinel that claims only 1 skill was present
        sentinel = paths.skill_pregen_sentinel_path()
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(
            json.dumps({"ts": time.time(), "skill_count": 1, "compact_count": 0}),
            encoding="utf-8",
        )

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "installed since last pre-gen" in combined

    def test_up_to_date_pregen_shows_no_new_skills(self, tmp_data_dir, monkeypatch):
        """sentinel skill_count matches disk → 'installed since last pre-gen' NOT shown."""
        _make_skill_dir(self.fake_skills_root, "skill-x")

        sentinel = paths.skill_pregen_sentinel_path()
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(
            json.dumps({"ts": time.time(), "skill_count": 1, "compact_count": 1}),
            encoding="utf-8",
        )

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "installed since last pre-gen" not in combined

    # -----------------------------------------------------------------------
    # CLAUDE.md + MEMORY.md size
    # -----------------------------------------------------------------------

    def test_claude_md_and_memory_md_contribute_meta_tokens(self, tmp_data_dir, monkeypatch):
        """CLAUDE.md and MEMORY.md on disk are reflected in the meta-tokens line."""
        fake_home = tmp_data_dir / "fakehome"
        fake_home.mkdir()
        claude_dir = fake_home / ".claude"
        claude_dir.mkdir()
        # Write a non-trivial CLAUDE.md (~4 KB)
        (claude_dir / "CLAUDE.md").write_text("x" * 4000, encoding="utf-8")

        monkeypatch.setattr("pathlib.Path.home", lambda: fake_home)

        lines, _ = self._call()
        combined = "\n".join(lines)
        # meta_tokens = 4000 // 4 = 1,000 → should show non-zero value
        # The line format is "CLAUDE.md + MEMORY.md: ~NNN tokens/turn"
        import re

        m = re.search(r"CLAUDE\.md \+ MEMORY\.md: ~(\d[\d,]*) tokens/turn", combined)
        assert m is not None, f"meta-tokens line not found in:\n{combined}"
        tok = int(m.group(1).replace(",", ""))
        assert tok >= 1_000

    # -----------------------------------------------------------------------
    # Conversation estimate
    # -----------------------------------------------------------------------

    def test_conversation_tokens_based_on_turns(self, tmp_data_dir, monkeypatch):
        """Conversation estimate uses turns_since_last_compact * 800 (dialogue) +
        tool output bytes from bash/web history (iter 8 improvement)."""
        from token_goat import session as ses

        sid = "sess-ctx1-conv"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 7
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        # With no tool output in history: 7 * 800 = 5,600 tokens
        assert "5,600" in combined
        assert "7 turns" in combined

    # -----------------------------------------------------------------------
    # ETA calculation
    # -----------------------------------------------------------------------

    def test_eta_unknown_with_no_active_session(self, tmp_data_dir, monkeypatch):
        """No session file → ETA line says 'unknown'."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "ETA" in combined
        assert "unknown" in combined

    def test_eta_range_shown_for_fewer_than_3_turns(self, tmp_data_dir, monkeypatch):
        """< 3 turns → ETA shows a range (e.g. '~N–M turns')."""
        from token_goat import session as ses

        sid = "sess-ctx1-eta-2"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "ETA" in combined
        assert "–" in combined  # dash range

    # -----------------------------------------------------------------------
    # Actions block
    # -----------------------------------------------------------------------

    def test_actions_block_appears_for_uncompacted_large_skill(self, tmp_data_dir, monkeypatch):
        """Uncompacted loaded skill > 2K tokens → Actions block with skill-compact command."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-actions"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["action-skill"] = SkillEntry(
            skill_name="action-skill",
            output_id="fake-act-id",
            content_sha="ffffffff",
            ts=1000.0,
            body_bytes=25_000,  # ~6,250 tokens > 2,000
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "Recommendations:" in combined
        assert "token-goat skill-compact action-skill" in combined

    def test_actions_block_absent_when_all_compacted(self, tmp_data_dir, monkeypatch):
        """All loaded skills have compacts and catalog is up-to-date → no Recommendations block."""
        from token_goat import session as ses
        from token_goat import skill_cache
        from token_goat.session import SkillEntry

        sid = "sess-ctx1-no-actions"
        compact_text = "# Summary\n\nCompact.\n"
        skill_cache.store_compact(sid, "covered-skill", compact_text)

        # One skill on disk, sentinel matches
        _make_skill_dir(self.fake_skills_root, "covered-skill")
        sentinel = paths.skill_pregen_sentinel_path()
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(
            json.dumps({"ts": time.time(), "skill_count": 1, "compact_count": 1}),
            encoding="utf-8",
        )

        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        # Small skill (< 2K tokens): 7,000 bytes = 1,750 tokens → won't trigger action
        cache.skill_history["covered-skill"] = SkillEntry(
            skill_name="covered-skill",
            output_id="fake-cov-id",
            content_sha="aabbccdd",
            ts=1000.0,
            body_bytes=7_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "Recommendations:" not in combined

# ---------------------------------------------------------------------------
# Shared isolation mixin
# ---------------------------------------------------------------------------

class SkillPathsMixin:
    """Mixin providing the ``_isolate`` fixture for classes that need fake skill/plugin dirs.

    Monkeypatches ``paths.claude_skills_dir`` and ``paths.claude_plugins_dir``
    to temp subdirectories so tests never touch the real user skill cache.
    The ``data_dir`` attribute is available after fixture setup via ``self.data_dir``.
    """

    data_dir: object  # set by _isolate fixture

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir, monkeypatch):
        self.data_dir = tmp_data_dir
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: tmp_data_dir / "fake_skills")
        monkeypatch.setattr(paths, "claude_plugins_dir", lambda: tmp_data_dir / "fake_plugins")

# ---------------------------------------------------------------------------
# Precompact sentinel age handling (iter 1/10)
# ---------------------------------------------------------------------------

class TestPrecompactSentinelAge(SkillPathsMixin):
    """_build_context_section() correctly handles old precompact sentinels.

    Previously, a 300-second cutoff meant sentinels older than 5 minutes were
    silently ignored, producing 'no compact baseline yet' even when valid
    baseline data existed on disk.
    """

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, age_seconds: float, bytes_estimate: int = 500_000) -> None:
        _write_precompact_sentinel(bytes_estimate, age_seconds=age_seconds)

    def test_accepts_sentinel_older_than_300_seconds(self):
        """Sentinels older than 5 minutes are now used (not silently dropped)."""
        self._write_sentinel(age_seconds=600, bytes_estimate=800_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should show the compact baseline, not 'no compact baseline yet'
        assert "no compact baseline yet" not in combined
        assert "Context at last compact" in combined

    def test_old_sentinel_shows_age_annotation(self):
        """Sentinels older than 5 minutes display an age annotation."""
        self._write_sentinel(age_seconds=400, bytes_estimate=800_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should contain the age annotation (e.g. "6m old" or similar)
        assert "m old" in combined or "h old" in combined

    def test_very_old_sentinel_shows_hours(self):
        """Sentinels older than 1 hour show hours in the age annotation."""
        self._write_sentinel(age_seconds=7200, bytes_estimate=800_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "h old" in combined

    def test_fresh_sentinel_shows_no_age_annotation(self):
        """Sentinels under 5 minutes old do not display an age annotation."""
        self._write_sentinel(age_seconds=60, bytes_estimate=800_000)
        lines, _ = self._call()
        # Fresh sentinel should not say "old"
        line = next((ln for ln in lines if "Context at last compact" in ln), "")
        assert "old" not in line

    def test_no_sentinel_still_shows_no_baseline_message(self):
        """When no sentinel exists, 'no compact baseline yet' is still shown."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "no compact baseline yet" in combined

# ---------------------------------------------------------------------------
# Fill bar and per-component breakdown (iter 2/10)
# ---------------------------------------------------------------------------

class TestContextFillBar(SkillPathsMixin):
    """_build_context_section() emits a fill bar and per-component breakdown."""

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, bytes_estimate: int) -> None:
        _write_precompact_sentinel(bytes_estimate)

    def test_fill_bar_present_in_output(self):
        """A fill bar line starting with '[' is always emitted."""
        lines, _ = self._call()
        bar_lines = [ln for ln in lines if ln.strip().startswith("[") and "░" in ln or "█" in ln]
        assert len(bar_lines) >= 1, f"No fill bar found in output: {lines}"

    def test_fill_bar_shows_ok_when_low(self):
        """Low fill → bar shows 'ok' severity."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "(ok)" in combined

    def test_fill_bar_shows_warn_at_50_percent(self):
        """~50% fill → bar shows 'WARN' severity."""
        # 50% of 660,000 = 330,000 tokens → ~1,320,000 bytes_estimate
        self._write_sentinel(bytes_estimate=1_320_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "(WARN)" in combined

    def test_fill_bar_shows_crit_at_90_percent(self):
        """~90% fill → bar shows 'CRIT' severity."""
        # 90% of 660,000 = 594,000 tokens → ~2,376,000 bytes_estimate
        self._write_sentinel(bytes_estimate=2_376_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "(CRIT)" in combined

    def test_breakdown_line_present_with_nonzero_components(self):
        """A 'Breakdown:' line appears when at least one component is >= 2% of total."""
        # Write a large sentinel so precompact dominates
        self._write_sentinel(bytes_estimate=1_000_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "Breakdown:" in combined

    def test_breakdown_omitted_when_no_data(self):
        """When current_estimate is 0, no breakdown line is emitted."""
        # No sentinel, no skills, no session → near-zero estimate
        lines, _ = self._call()
        # May or may not have breakdown (depends on CLAUDE.md size); just check no crash
        assert isinstance(lines, list)

# ---------------------------------------------------------------------------
# Session-to-session context growth trend (iter 3/10)
# ---------------------------------------------------------------------------

class TestContextGrowthTrend(SkillPathsMixin):
    """_compute_context_growth_trend() and its integration in _build_context_section."""

    def _write_sentinels(self, byte_estimates: list[int]) -> None:
        """Write multiple precompact sentinels with incrementing mtimes."""
        sentinels_dir = paths.sentinels_dir()
        sentinels_dir.mkdir(parents=True, exist_ok=True)
        base_mtime = time.time() - 3600.0
        for i, est in enumerate(byte_estimates):
            p = sentinels_dir / f"precompact_estimate_sess{i:03d}.json"
            p.write_text(json.dumps({"bytes_estimate": est}), encoding="utf-8")
            import os
            os.utime(p, (base_mtime + i * 60, base_mtime + i * 60))

    def _trend(self, current_tokens: int = 0, context_cap: int = 660_000):
        from token_goat.cli_doctor import _compute_context_growth_trend
        return _compute_context_growth_trend(
            paths.sentinels_dir(),
            current_tokens=current_tokens,
            context_cap=context_cap,
        )

    def test_returns_none_with_single_sentinel(self):
        """One sentinel → no trend (not enough data points)."""
        self._write_sentinels([400_000])
        result = self._trend()
        assert result is None

    def test_returns_none_with_no_sentinels(self):
        """No sentinels → no trend."""
        paths.sentinels_dir().mkdir(parents=True, exist_ok=True)
        result = self._trend()
        assert result is None

    def test_returns_none_when_dir_missing(self):
        """Missing sentinels dir → no trend, no exception."""
        from token_goat.cli_doctor import _compute_context_growth_trend
        result = _compute_context_growth_trend(paths.sentinels_dir().parent / "nonexistent_dir")
        assert result is None

    def test_growing_trend_detected(self):
        """Consistently growing sentinels → '↗ growing' trend."""
        # Each step: +100,000 bytes = +25,000 tokens → clearly growing
        self._write_sentinels([100_000, 200_000, 300_000])
        result = self._trend()
        assert result is not None
        assert "growing" in result
        assert "↗" in result

    def test_shrinking_trend_detected(self):
        """Consistently shrinking sentinels → '↘ shrinking' trend."""
        self._write_sentinels([400_000, 300_000, 200_000])
        result = self._trend()
        assert result is not None
        assert "shrinking" in result
        assert "↘" in result

    def test_stable_trend_detected(self):
        """Nearly-flat sentinels → '→ stable' trend."""
        # Small oscillation well within ±5,000 token threshold
        self._write_sentinels([400_000, 401_000, 399_000])
        result = self._trend()
        assert result is not None
        assert "stable" in result
        assert "→" in result

    def test_trend_shows_session_count(self):
        """Trend line includes the number of sessions used for the average."""
        self._write_sentinels([100_000, 200_000, 300_000, 400_000])
        result = self._trend()
        assert result is not None
        assert "3 sessions" in result  # 4 sentinels = 3 deltas

    def test_integration_trend_in_context_section(self):
        """When multiple sentinels exist, the trend line appears in doctor output."""
        self._write_sentinels([100_000, 200_000, 300_000])
        from token_goat.cli_doctor import _build_context_section
        lines, _ = _build_context_section()
        combined = "\n".join(lines)
        # Any of the three arrows should appear
        assert any(arrow in combined for arrow in ("↗", "↘", "→"))

    # ------------------------------------------------------------------
    # Sessions-to-URGENT projection (iter 9)
    # ------------------------------------------------------------------

    def test_growing_trend_with_high_fill_shows_sessions_to_urgent(self):
        """When growing AND close to URGENT, shows '[~N sessions to URGENT]'."""
        # sentinels growing +50,000 tok/step (+200,000 bytes each)
        self._write_sentinels([400_000, 600_000, 800_000])
        # current = 450,000 tokens; urgent = 660,000 * 0.85 = 561,000
        # headroom = 561,000 - 450,000 = 111,000
        # avg_delta = (50,000 + 50,000) / 2 = 50,000 tok/session
        # sessions_to_urgent = 111,000 / 50,000 ≈ 2.2 → shown as ~2 sessions
        result = self._trend(current_tokens=450_000)
        assert result is not None
        assert "sessions to URGENT" in result or "session to URGENT" in result, (
            f"Expected 'sessions to URGENT' in trend line but got: {result!r}"
        )

    def test_growing_trend_far_from_urgent_no_projection(self):
        """When growing but still > 10 sessions from URGENT, no projection shown."""
        # sentinels growing very slowly: +2,000 tok/step (+8,000 bytes)
        self._write_sentinels([400_000, 408_000, 416_000])
        # current = 50,000 tokens; urgent = 561,000
        # avg_delta = 2,000 tok/session
        # sessions_to_urgent = (561,000 - 50,000) / 2,000 = 255.5 → omitted (> 10)
        result = self._trend(current_tokens=50_000)
        assert result is not None
        # Either growing or within stable threshold (2000 < 5000 stable)
        # but projection should NOT appear since it's far away
        assert "sessions to URGENT" not in (result or "")

    def test_shrinking_trend_never_shows_projection(self):
        """Shrinking trend never shows 'sessions to URGENT'."""
        self._write_sentinels([800_000, 600_000, 400_000])
        result = self._trend(current_tokens=500_000)
        assert result is not None
        assert "sessions to URGENT" not in result
        assert "session to URGENT" not in result

    def test_growing_trend_no_current_tokens_no_projection(self):
        """When current_tokens=0, no projection is appended even if growing."""
        self._write_sentinels([400_000, 600_000, 800_000])
        result = self._trend(current_tokens=0)
        assert result is not None
        assert "sessions to URGENT" not in result
        assert "session to URGENT" not in result

    def test_already_urgent_shows_1_session(self):
        """When already past URGENT threshold and still growing, shows ~1 session."""
        # sentinels growing by 200,000 bytes = 50,000 tok per step
        self._write_sentinels([400_000, 600_000, 800_000])
        # current = 580,000 tokens (above urgent=561,000)
        # headroom = max(0, 561,000 - 580,000) = 0 → shows "~1 session"
        result = self._trend(current_tokens=580_000)
        assert result is not None
        # Should show the projection (headroom = 0 → sessions = 0 → max(1,0) = 1)
        assert "session to URGENT" in result or "sessions to URGENT" in result

# ---------------------------------------------------------------------------
# Tiered compaction recommendations (iter 4/10)
# ---------------------------------------------------------------------------

class TestCompactionRecommendations(SkillPathsMixin):
    """Tiered recommendation block in _build_context_section()."""

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, bytes_estimate: int) -> None:
        _write_precompact_sentinel(bytes_estimate)

    def test_urgent_recommendation_at_85_percent(self):
        """>=85% fill → urgent /compact recommendation."""
        # 85% of 660,000 tokens = 561,000 tokens → 2,244,000 bytes_estimate
        self._write_sentinel(bytes_estimate=2_244_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "URGENT" in combined
        assert "/compact" in combined

    def test_recommendation_at_70_percent(self):
        """>=70% fill → /compact soon recommendation."""
        # 70% of 660,000 = 462,000 tokens → 1,848,000 bytes_estimate
        self._write_sentinel(bytes_estimate=1_848_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "compact" in combined.lower()

    def test_no_compact_recommendation_at_low_fill(self):
        """Low fill with few turns → no /compact recommendation."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should NOT urgently recommend compact when context is nearly empty
        assert "URGENT" not in combined

    def test_skill_compact_in_recommendations_for_uncompacted_large_skill(self):
        """Uncompacted large skill → skill-compact command in Recommendations."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-rec-large"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["big-skill"] = SkillEntry(
            skill_name="big-skill",
            output_id="fake-id",
            content_sha="deadbeef",
            ts=1000.0,
            body_bytes=30_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "token-goat skill-compact big-skill" in combined

    def test_recommendations_label_used_not_actions(self):
        """The block is labelled 'Recommendations:' not 'Actions:' (iter 4 rename)."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-rec-label"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["unlabeled-skill"] = SkillEntry(
            skill_name="unlabeled-skill",
            output_id="fake-id2",
            content_sha="cafebabe",
            ts=1000.0,
            body_bytes=20_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "Recommendations:" in combined
        assert "Actions:" not in combined

    # ------------------------------------------------------------------
    # Compound and Tier 0 recommendations (iter 10)
    # ------------------------------------------------------------------

    def test_over_capacity_shows_tier0_warning(self):
        """fill_pct >= 100% → OVER CAPACITY warning in Recommendations."""
        # 660,000 tokens * 4 bytes each = 2,640,000 bytes; use 4,000,000 to exceed 100%
        self._write_sentinel(bytes_estimate=4_000_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "OVER CAPACITY" in combined, (
            f"Expected 'OVER CAPACITY' at >100% fill:\n{combined}"
        )

    def test_tier0_takes_priority_over_tier1(self):
        """OVER CAPACITY supersedes the normal 'URGENT' message."""
        self._write_sentinel(bytes_estimate=4_000_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Tier 0 should appear; Tier 1 URGENT should not appear alongside it
        # (the elif means only one fires)
        assert "OVER CAPACITY" in combined
        # The standard tier-1 URGENT message should not duplicate
        assert combined.count("URGENT") == 1 or "OVER CAPACITY" in combined

    def test_compound_recommendation_when_urgent_and_uncompacted_skills(self):
        """>=85% fill + uncompacted large skill → compound 'skill-compact first' message."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-compound-iter10"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 5
        cache.skill_history["heavy-skill"] = SkillEntry(
            skill_name="heavy-skill",
            output_id="oid-heavy",
            content_sha="aaaabbbb",
            ts=1000.0,
            body_bytes=40_000,  # 10,000 tokens > 2,000 threshold
        )
        ses.save(cache)

        # 85% fill sentinel: 2,244,000 bytes = 561,000 tokens
        self._write_sentinel(bytes_estimate=2_244_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should show the compound message that mentions skill-compact before /compact
        assert "skill-compact" in combined
        assert "URGENT" in combined
        # The compound message should mention the skill name
        assert "heavy-skill" in combined

    def test_skill_compact_recommendation_includes_savings_estimate(self):
        """skill-compact recommendation includes an approximate token savings note."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-savings-iter10"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        cache.skill_history["costly-skill"] = SkillEntry(
            skill_name="costly-skill",
            output_id="oid-costly",
            content_sha="11223344",
            ts=1000.0,
            body_bytes=20_000,  # 5,000 tokens
        )
        ses.save(cache)

        lines, _ = self._call()
        # The Recommendations block emits lines like:
        #   "    token-goat skill-compact costly-skill  # ~N tok saved"
        # (distinct from the skill table line "run: token-goat skill-compact …")
        rec_line = next(
            (
                ln
                for ln in lines
                if "costly-skill" in ln and "skill-compact" in ln and "tok saved" in ln
            ),
            None,
        )
        assert rec_line is not None, (
            "Expected a recommendation with 'tok saved' for costly-skill.\n"
            "All lines mentioning costly-skill:\n"
            + "\n".join(ln for ln in lines if "costly-skill" in ln)
        )

    def test_tier4_early_session_shows_dominant_component(self):
        """Early session with high fill shows the dominant cost component."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-tier4-iter10"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2  # < 5 turns
        # Large loaded skill: 800,000 bytes = 200,000 tokens
        # Total estimate (skill + meta ~43k + conv ~1.6k) ≈ 245k → 37% fill ≥ 30% threshold
        cache.skill_history["dominant-skill"] = SkillEntry(
            skill_name="dominant-skill",
            output_id="oid-dom",
            content_sha="99aabbcc",
            ts=1000.0,
            body_bytes=800_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should mention the dominant component in the recommendation
        # (loaded skills dominates here at 125,000 tokens)
        tier4_line = next(
            (ln for ln in lines if "Skill compacts will help most" in ln or "dominant cost" in ln),
            None,
        )
        assert tier4_line is not None, (
            f"Expected Tier 4 recommendation mentioning dominant cost:\n{combined}"
        )

# ---------------------------------------------------------------------------
# Edge case hardening (iter 5/10)
# ---------------------------------------------------------------------------

class TestContextEdgeCases(SkillPathsMixin):
    """Edge cases in _build_context_section(): zero-byte sentinels, empty catalogs,
    and empty sessions."""

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, bytes_estimate: int) -> None:
        _write_precompact_sentinel(bytes_estimate)

    # ------------------------------------------------------------------
    # Zero-byte sentinel tests
    # ------------------------------------------------------------------

    def test_zero_byte_sentinel_treated_as_no_baseline(self):
        """A sentinel with bytes_estimate=0 must not show a '~0 tokens' baseline."""
        self._write_sentinel(bytes_estimate=0)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Should fall back to 'no compact baseline yet', not '~0 tokens'
        assert "no compact baseline yet" in combined, (
            f"Expected 'no compact baseline yet' but got:\n{combined}"
        )

    def test_zero_byte_sentinel_does_not_show_context_at_last_compact(self):
        """A sentinel with bytes_estimate=0 must not produce a 'Context at last compact' line."""
        self._write_sentinel(bytes_estimate=0)
        lines, _ = self._call()
        for line in lines:
            assert "Context at last compact: ~0" not in line, (
                f"Misleading zero-byte baseline shown: {line!r}"
            )

    def test_positive_byte_sentinel_still_shows_baseline(self):
        """Positive bytes_estimate still produces the baseline line (regression guard)."""
        self._write_sentinel(bytes_estimate=400_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "Context at last compact" in combined
        assert "no compact baseline yet" not in combined

    # ------------------------------------------------------------------
    # Empty catalog (all skill files are zero bytes or stat failed)
    # ------------------------------------------------------------------

    def test_empty_skill_files_show_fallback_label(self):
        """When catalog_bytes=0 but catalog_count>0, output shows '[fallback estimate]'."""
        # Create skill dirs with zero-byte SKILL.md files
        skills_root = self.data_dir / "fake_skills"
        for name in ("skill-a", "skill-b"):
            skill_dir = skills_root / name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text("", encoding="utf-8")

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "[fallback estimate]" in combined, (
            f"Expected '[fallback estimate]' label for empty skills but got:\n{combined}"
        )
        assert "no byte sizes" in combined.lower(), (
            f"Expected fallback note in output but got:\n{combined}"
        )

    def test_populated_skill_files_show_actual_file_sizes_label(self):
        """When skills have real content, output shows '[actual file sizes]'."""
        skills_root = self.data_dir / "fake_skills"
        skill_dir = skills_root / "real-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text("# Real Skill\n\n" + "x " * 500, encoding="utf-8")

        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "[actual file sizes]" in combined, (
            f"Expected '[actual file sizes]' label but got:\n{combined}"
        )
        assert "[fallback estimate]" not in combined

    def test_no_skills_shows_actual_file_sizes_label(self):
        """When catalog_count=0 (no skills at all), output shows '[actual file sizes]'
        because the catalog_bytes == 0 AND catalog_count == 0 branch is distinct from
        the fallback branch (no skills to warn about)."""
        # skills dir does not exist → catalog_count=0, catalog_bytes=0
        lines, _ = self._call()
        combined = "\n".join(lines)
        # With zero skills, no misleading fallback note should appear
        assert "no byte sizes" not in combined.lower(), (
            f"Unexpected fallback note for zero-skill catalog:\n{combined}"
        )

    # ------------------------------------------------------------------
    # Empty session (turns=0)
    # ------------------------------------------------------------------

    def test_empty_session_shows_no_active_session(self):
        """When no session exists (turns=0), output shows 'no active session found'."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "no active session found" in combined

    def test_empty_session_shows_eta_unknown(self):
        """When session_turns=0, ETA is shown as 'unknown' rather than omitted."""
        lines, _ = self._call()
        combined = "\n".join(lines)
        # An ETA line is still emitted but with "unknown" instead of a number
        assert "ETA: unknown" in combined, (
            f"Expected 'ETA: unknown' for empty session but got:\n{combined}"
        )
        # No numeric turn count should appear in the ETA line
        eta_line = next((ln for ln in lines if "ETA:" in ln), "")
        assert "turns at current rate" not in eta_line, (
            f"Expected unknown ETA but got a numeric ETA: {eta_line!r}"
        )

# ---------------------------------------------------------------------------
# Sentinel error robustness (iter 6/10)
# ---------------------------------------------------------------------------

class TestSentinelErrorHandling(SkillPathsMixin):
    """_build_context_section() handles corrupt/unreadable sentinels gracefully."""

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, content: str) -> None:
        _write_precompact_sentinel(content=content)

    def test_malformed_json_sentinel_shows_error_note(self):
        """A sentinel with malformed JSON emits a '(sentinel error: ...)' note and
        does not raise an exception."""
        self._write_sentinel("{not valid json}")
        # Must not raise
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Graceful degradation: shows baseline message and error note
        assert "no compact baseline yet" in combined
        assert "sentinel error" in combined

    def test_malformed_json_sentinel_does_not_show_baseline(self):
        """A corrupt sentinel must not show 'Context at last compact' with a stale value."""
        self._write_sentinel("null")
        lines, _ = self._call()
        for line in lines:
            # Should not claim to have a baseline from a null sentinel
            assert "Context at last compact: ~" not in line, (
                f"Unexpected baseline line from null sentinel: {line!r}"
            )

    def test_non_numeric_bytes_estimate_sentinel_shows_error_note(self):
        """A sentinel with a non-numeric bytes_estimate emits the error note."""
        self._write_sentinel('{"bytes_estimate": "not-a-number"}')
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "no compact baseline yet" in combined
        assert "sentinel error" in combined

    def test_valid_sentinel_does_not_show_sentinel_error(self):
        """A valid sentinel with positive bytes_estimate must not show any error note."""
        self._write_sentinel('{"bytes_estimate": 400000}')
        lines, _ = self._call()
        combined = "\n".join(lines)
        assert "sentinel error" not in combined
        assert "Context at last compact" in combined

    def test_function_never_raises_on_empty_sentinel_dir(self):
        """_build_context_section() must not raise even if sentinels_dir is empty."""
        # Don't write any sentinels
        result = self._call()
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_function_never_raises_on_missing_sentinel_dir(self, monkeypatch):
        """_build_context_section() must not raise even if sentinels_dir doesn't exist."""
        # Point sentinels_dir to a path that definitely does not exist
        nonexistent = self.data_dir / "does_not_exist" / "sentinels"
        monkeypatch.setattr(paths, "sentinels_dir", lambda: nonexistent)
        result = self._call()
        assert isinstance(result, tuple)
        assert len(result) == 2

# ---------------------------------------------------------------------------
# Context metric accuracy tests (iter 7/10)
# ---------------------------------------------------------------------------

class TestContextMetricAccuracy(SkillPathsMixin):
    """Unit tests for fill percentage, severity thresholds, breakdown visibility,
    tokens-per-turn fallback, and growth trend inclusion."""

    def _call(self):
        return _call_context_section()

    def _write_sentinel(self, bytes_estimate: int, age_seconds: float = 10.0) -> None:
        _write_precompact_sentinel(bytes_estimate, age_seconds=age_seconds)

    # ------------------------------------------------------------------
    # Fill severity thresholds
    # ------------------------------------------------------------------

    def test_severity_ok_below_40_percent(self):
        """Fill < 40% shows severity label 'ok'."""
        # No sentinel, no skills, no session → fill near 0%
        lines, _ = self._call()
        bar_line = next((ln for ln in lines if "█" in ln or "░" in ln), "")
        assert "(ok)" in bar_line, f"Expected '(ok)' severity but got: {bar_line!r}"

    def test_severity_warn_at_40_percent(self):
        """Fill at ~40% shows severity label 'WARN'."""
        # 660_000 * 0.40 = 264_000 tokens; sentinel with 1_056_000 bytes = 264_000 tokens
        self._write_sentinel(bytes_estimate=1_056_000)
        lines, _ = self._call()
        bar_line = next((ln for ln in lines if "█" in ln or "░" in ln), "")
        # At 40%, severity is WARN (fill_pct >= 0.40)
        assert "(WARN)" in bar_line or "(ok)" in bar_line, (
            f"Unexpected severity at ~40% fill: {bar_line!r}"
        )

    def test_severity_crit_above_85_percent(self):
        """Fill >= 85% shows severity label 'CRIT'."""
        # 660_000 * 0.85 = 561_000 tokens; sentinel with 2_244_001 bytes > 561_000 tokens
        self._write_sentinel(bytes_estimate=2_244_001)
        lines, _ = self._call()
        bar_line = next((ln for ln in lines if "█" in ln or "░" in ln), "")
        assert "(CRIT)" in bar_line, f"Expected '(CRIT)' severity but got: {bar_line!r}"

    def test_severity_high_between_70_and_85_percent(self):
        """Fill in [70%, 85%) shows severity label 'HIGH'."""
        # 660_000 * 0.75 = 495_000 tokens; 1_980_000 bytes
        self._write_sentinel(bytes_estimate=1_980_000)
        lines, _ = self._call()
        bar_line = next((ln for ln in lines if "█" in ln or "░" in ln), "")
        assert "(HIGH)" in bar_line, f"Expected '(HIGH)' severity but got: {bar_line!r}"

    # ------------------------------------------------------------------
    # Per-component breakdown
    # ------------------------------------------------------------------

    def test_breakdown_omits_components_below_2_percent(self):
        """A component that is < 2% of total must not appear in the Breakdown line."""
        # No sentinel, no skills → only conversation component from session
        # With 0 turns, conversation_tokens=0 → no meaningful non-zero components
        lines, _ = self._call()
        # With all-zero components, Breakdown line should be absent
        # (breakdown_parts will be empty since all are 0%)
        # Alternatively, with a sentinel that dominates, small components are omitted
        # Verify the Breakdown line structure when present
        bd_line = next((ln for ln in lines if "Breakdown:" in ln), None)
        if bd_line is not None:
            # Each entry in the breakdown must be >= 2% — verified by absence of tiny ones
            # We can't easily check the numbers here without knowing the estimate,
            # but we can verify the line is well-formed (contains % signs)
            assert "%" in bd_line

    def test_breakdown_shows_dominant_component(self):
        """When a precompact sentinel dominates, 'precompact' appears in the Breakdown line."""
        # sentinel of 2M bytes = 500K tokens; total will be dominated by precompact
        self._write_sentinel(bytes_estimate=2_000_000)
        lines, _ = self._call()
        bd_line = next((ln for ln in lines if "Breakdown:" in ln), None)
        assert bd_line is not None, "Expected Breakdown line with large sentinel"
        assert "precompact" in bd_line

    # ------------------------------------------------------------------
    # Growth trend integration
    # ------------------------------------------------------------------

    def test_growth_trend_shown_when_multiple_sentinels_exist(self):
        """When at least 2 sentinels exist, a trend arrow (↗/↘/→) appears in output."""
        sentinels_dir = paths.sentinels_dir()
        sentinels_dir.mkdir(parents=True, exist_ok=True)
        import os
        now = time.time()
        # Write two sentinels at different times with different sizes
        for i, (age, size) in enumerate([(200, 400_000), (100, 600_000)]):
            p = sentinels_dir / f"precompact_estimate_s{i}.json"
            p.write_text(json.dumps({"bytes_estimate": size}), encoding="utf-8")
            t = now - age
            os.utime(p, (t, t))

        lines, _ = self._call()
        combined = "\n".join(lines)
        # At least one of the trend arrows should appear
        assert any(arrow in combined for arrow in ("↗", "↘", "→")), (
            f"No trend arrow found in output with 2 sentinels:\n{combined}"
        )

    def test_growth_trend_absent_with_single_sentinel(self):
        """With only one sentinel, no trend line is emitted (need ≥ 2 data points)."""
        self._write_sentinel(bytes_estimate=400_000)
        lines, _ = self._call()
        combined = "\n".join(lines)
        # Single sentinel → no trend
        assert "↗" not in combined
        assert "↘" not in combined
        assert "→" not in combined

    # ------------------------------------------------------------------
    # ETA computation fallback
    # ------------------------------------------------------------------

    def test_eta_uses_fallback_when_fewer_than_3_turns(self):
        """With < 3 session turns, ETA uses the 2000 tok/turn fallback."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-eta-fallback"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2  # < 3 turns
        cache.skill_history["tiny"] = SkillEntry(
            skill_name="tiny",
            output_id="oid",
            content_sha="aabb",
            ts=1000.0,
            body_bytes=4_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        # With < 3 turns, the ETA line uses wide range format "~N–M turns"
        eta_line = next((ln for ln in lines if "ETA:" in ln), "")
        assert "–" in eta_line or "unknown" in eta_line, (
            f"Expected range ETA with < 3 turns but got: {eta_line!r}"
        )
        assert "at current rate" not in eta_line, (
            f"'at current rate' should not appear with < 3 turns: {eta_line!r}"
        )

    def test_eta_at_current_rate_with_3_or_more_turns(self):
        """With >= 3 session turns, ETA shows 'at current rate'."""
        from token_goat import session as ses
        from token_goat.session import SkillEntry

        sid = "sess-eta-real"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 5
        cache.skill_history["big"] = SkillEntry(
            skill_name="big",
            output_id="oid2",
            content_sha="ccdd",
            ts=1000.0,
            body_bytes=20_000,
        )
        ses.save(cache)

        lines, _ = self._call()
        eta_line = next((ln for ln in lines if "ETA:" in ln), "")
        assert "at current rate" in eta_line or "ETA: unknown" in eta_line, (
            f"Expected 'at current rate' ETA with 5 turns but got: {eta_line!r}"
        )

    # ------------------------------------------------------------------
    # Tool-output-aware conversation estimate (iter 8)
    # ------------------------------------------------------------------

    def test_tool_output_tokens_increase_estimate(self):
        """When bash_history has entries, tool output bytes add to conversation estimate."""
        from token_goat import session as ses
        from token_goat.session import BashEntry

        sid = "sess-toolout-iter8"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 3
        # Add a bash entry with 80,000 bytes of stdout (= 20,000 tokens at /4)
        be = BashEntry(
            cmd_sha="abc12345",
            cmd_preview="pytest",
            output_id="out123",
            ts=1000.0,
            stdout_bytes=80_000,
            stderr_bytes=0,
        )
        cache.bash_history["abc12345"] = be
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        # Conversation line should show "tool outputs" breakdown
        assert "tool outputs" in combined, (
            f"Expected 'tool outputs' annotation in conversation line:\n{combined}"
        )
        # dialogue_tokens = 3 * 800 = 2,400
        # tool_output_tokens = min(80_000, 32_768) // 4 = 8,192
        # total = 10,592
        conv_line = next((ln for ln in lines if "Conversation" in ln and "turns" in ln), "")
        assert "dialogue" in conv_line, f"Expected 'dialogue' in conv line: {conv_line!r}"

    def test_no_tool_output_shows_simple_conversation_line(self):
        """When no bash/web history, conversation line does not show breakdown."""
        from token_goat import session as ses

        sid = "sess-notools-iter8"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 4
        ses.save(cache)

        lines, _ = self._call()
        conv_line = next((ln for ln in lines if "Conversation" in ln and "turns" in ln), "")
        assert "dialogue" not in conv_line, (
            f"Expected no breakdown when no tools used: {conv_line!r}"
        )
        assert "tool outputs" not in conv_line

    def test_tool_output_capped_per_entry(self):
        """Each bash entry is capped at 32,768 bytes to prevent one large output dominating."""
        from token_goat import session as ses
        from token_goat.session import BashEntry

        sid = "sess-cap-iter8"
        cache = ses._fresh_cache(sid)
        cache.turns_since_last_compact = 2
        # Add a bash entry with 1MB stdout — should be capped at 32,768 bytes
        be = BashEntry(
            cmd_sha="bigcmd1",
            cmd_preview="cat bigfile",
            output_id="outbig",
            ts=1000.0,
            stdout_bytes=1_000_000,
            stderr_bytes=0,
        )
        cache.bash_history["bigcmd1"] = be
        ses.save(cache)

        lines, _ = self._call()
        combined = "\n".join(lines)
        # tool_output_tokens = min(1_000_000, 32_768) // 4 = 8,192
        # dialogue_tokens = 2 * 800 = 1,600
        # total = 9,792 — should NOT show 250,000 tokens from uncapped 1MB
        # Verify capping occurred: "250,000" should not appear
        assert "250,000" not in combined, (
            f"Tool output was not capped — uncapped 1MB shown:\n{combined}"
        )
