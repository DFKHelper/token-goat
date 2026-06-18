"""Tests for harness-parameterized compaction manifests.

Covers:
- detect_harness() env-var detection logic
- Config override for harness type
- Manifest content varies by harness: codex skips skills, generic minimal output
- opencode harness tag injection
- "auto" fallback to generic when no env var matches
"""
from __future__ import annotations

import hashlib

import pytest

from token_goat import compact, session
from token_goat.compact import detect_harness
from token_goat.config import CompactAssistConfig, Config

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cfg(harness: str = "auto", **kwargs: object) -> Config:
    """Build a Config with the given harness and optional other CA overrides."""
    ca = CompactAssistConfig(harness=harness, **kwargs)  # type: ignore[arg-type]
    cfg = Config()
    cfg.compact_assist = ca
    return cfg


def _populate(sid: str, *, files: int = 2, greps: int = 1, edits: int = 1) -> None:
    """Add enough activity to exceed the min_events gate."""
    for i in range(files):
        session.mark_file_read(sid, f"/proj/src/file{i}.py", offset=0, limit=50)
    for i in range(greps):
        session.mark_grep(sid, f"pattern{i}", "/proj/src")
    for i in range(edits):
        session.mark_file_edited(sid, f"/proj/src/edited{i}.py")


def _add_bash_run(sid: str, cmd: str, exit_code: int = 0) -> None:
    """Record a bash command in the session using the proper API."""
    from token_goat import bash_cache
    cmd_sha = bash_cache.command_hash(cmd)
    session.mark_bash_run(
        session_id=sid,
        cmd_sha=cmd_sha,
        cmd_preview=cmd,
        output_id=f"out-{cmd_sha}",
        stdout_bytes=1000,
        stderr_bytes=0,
        exit_code=exit_code,
        truncated=False,
    )


def _add_web_fetch(sid: str, url: str, status: int = 200) -> None:
    """Record a web fetch in the session using the proper API."""
    url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
    session.mark_web_fetch(
        session_id=sid,
        url_sha=url_sha,
        url_preview=url[:200],
        output_id=f"web-{url_sha}",
        body_bytes=5000,
        status_code=status,
        truncated=False,
    )


def _add_skill(sid: str, skill_name: str) -> None:
    """Record a skill load in the session using the proper API."""
    from token_goat import skill_cache
    body = f"{skill_name} skill body content " * 10
    body_bytes = len(body.encode())
    content_sha = hashlib.sha256(body.encode()).hexdigest()[:16]
    output_id = f"skill-{skill_name}-{content_sha[:8]}"
    # Store in skill_cache so compact.py's skill injection can find it
    skill_cache.store_output(sid, skill_name, body)
    # Record in session history
    session.mark_skill_loaded(
        session_id=sid,
        skill_name=skill_name,
        output_id=output_id,
        content_sha=content_sha,
        body_bytes=body_bytes,
        truncated=False,
    )


# ---------------------------------------------------------------------------
# detect_harness() — env-var detection
# ---------------------------------------------------------------------------

class TestDetectHarness:
    """Unit tests for the detect_harness() function."""

    def test_config_override_claudecode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A config_override value of 'claudecode' is returned directly."""
        assert detect_harness("claudecode") == "claudecode"

    def test_config_override_codex(self) -> None:
        """A config_override value of 'codex' is returned directly."""
        assert detect_harness("codex") == "codex"

    def test_config_override_generic(self) -> None:
        """A config_override value of 'generic' is returned directly."""
        assert detect_harness("generic") == "generic"

    def test_config_override_opencode(self) -> None:
        """A config_override value of 'opencode' is returned directly."""
        assert detect_harness("opencode") == "opencode"

    def test_unknown_override_falls_back_to_env_detection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An unknown override value is logged and env detection runs."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        result = detect_harness("not-a-real-harness")
        assert result == "generic"

    def test_auto_with_anthropic_key_returns_claudecode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: ANTHROPIC_API_KEY present → claudecode."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        assert detect_harness("auto") == "claudecode"

    def test_auto_with_claude_code_session_returns_claudecode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: CLAUDE_CODE_SESSION_ID present → claudecode."""
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "abc123")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        assert detect_harness("auto") == "claudecode"

    def test_auto_with_codex_session_returns_codex(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: CODEX_SESSION env var present → codex."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.setenv("CODEX_SESSION", "some-session-id")
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        assert detect_harness("auto") == "codex"

    def test_auto_with_openai_key_only_returns_codex(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: OPENAI_API_KEY without ANTHROPIC_API_KEY → codex."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")
        assert detect_harness("auto") == "codex"

    def test_auto_with_opencode_session_returns_opencode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: OPENCODE_SESSION env var present → opencode."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.setenv("OPENCODE_SESSION", "oc-session")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        assert detect_harness("auto") == "opencode"

    def test_auto_no_env_vars_returns_generic(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: no matching env vars → generic fallback."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        assert detect_harness("auto") == "generic"

    def test_harness_override_env_var_takes_precedence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """TOKEN_GOAT_HARNESS_OVERRIDE beats all other probes — used by CI."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_HARNESS_OVERRIDE", "claudecode")
        assert detect_harness("auto") == "claudecode"

    def test_harness_override_unknown_value_ignored(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """TOKEN_GOAT_HARNESS_OVERRIDE with an unknown value falls through to env detection."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_HARNESS_OVERRIDE", "not-a-real-harness")
        assert detect_harness("auto") == "generic"

    def test_anthropic_key_beats_openai_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When both ANTHROPIC_API_KEY and OPENAI_API_KEY are set, claudecode wins."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        assert detect_harness("auto") == "claudecode"


# ---------------------------------------------------------------------------
# Config: harness field
# ---------------------------------------------------------------------------

class TestHarnessConfig:
    """Config-level tests for the harness field."""

    def test_default_harness_is_auto(self) -> None:
        """CompactAssistConfig default harness is 'auto'."""
        cfg = CompactAssistConfig()
        assert cfg.harness == "auto"

    def test_harness_field_accepted_in_constructor(self) -> None:
        """All valid harness values are accepted by CompactAssistConfig."""
        for val in ("auto", "claudecode", "codex", "opencode", "gemini", "generic"):
            ca = CompactAssistConfig(harness=val)
            assert ca.harness == val, f"expected harness={val!r}, got {ca.harness!r}"

    def test_config_load_reads_harness_from_toml(
        self, tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Config loader reads compact_assist.harness from TOML correctly."""
        from token_goat import config as config_mod
        from token_goat import paths

        toml_content = '[compact_assist]\nharness = "codex"\n'
        config_file = tmp_path / "config.toml"  # type: ignore[operator]
        config_file.write_text(toml_content, encoding="utf-8")

        monkeypatch.setattr(paths, "config_path", lambda: config_file)
        config_mod._config_mtime_cache = None

        cfg = config_mod.load()
        assert cfg.compact_assist.harness == "codex"
        config_mod._config_mtime_cache = None

    def test_config_load_invalid_harness_falls_back_to_auto(
        self, tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Invalid harness value in TOML is rejected; 'auto' is used instead."""
        from token_goat import config as config_mod
        from token_goat import paths

        toml_content = '[compact_assist]\nharness = "unknown-harness"\n'
        config_file = tmp_path / "config.toml"  # type: ignore[operator]
        config_file.write_text(toml_content, encoding="utf-8")

        monkeypatch.setattr(paths, "config_path", lambda: config_file)
        config_mod._config_mtime_cache = None

        cfg = config_mod.load()
        assert cfg.compact_assist.harness == "auto"
        config_mod._config_mtime_cache = None


# ---------------------------------------------------------------------------
# Manifest content varies by harness
# ---------------------------------------------------------------------------

class TestManifestHarnessCodex:
    """Codex harness: skills section must be absent from the manifest."""

    def test_codex_skips_skills_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When harness='codex', the **Skills:** line is not in the manifest."""
        sid = "codex-no-skills-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_skill(sid, "ralph")

        codex_cfg = _make_cfg(harness="codex")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: codex_cfg)

        result = compact.build_manifest(sid)
        # Skills section header must be absent when harness is codex
        assert "**Skills:**" not in result, (
            f"Expected no Skills section for codex harness, but found it in:\n{result}"
        )

    def test_codex_still_has_edited_files_header(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Codex harness keeps the manifest header and edited files."""
        sid = "codex-keeps-edited-test"
        _populate(sid, files=2, greps=1, edits=1)

        codex_cfg = _make_cfg(harness="codex")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: codex_cfg)

        result = compact.build_manifest(sid)
        if result:
            assert "## Token-Goat Session Manifest" in result


class TestManifestHarnessGeneric:
    """Generic harness: minimal output — only sealed+header+edited+syms."""

    def test_generic_has_no_bash_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Generic harness strips the bash history section from the manifest.

        Note: the sealed block (MUST_PRESERVE) may still include a short bash
        command preview in its 🕐 slot — we assert the section *header* is absent,
        not every occurrence of command text.
        """
        sid = "generic-no-bash-test"
        _populate(sid, files=3, greps=2, edits=2)
        _add_bash_run(sid, "pytest tests/ -x", exit_code=0)

        generic_cfg = _make_cfg(harness="generic")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: generic_cfg)

        result = compact.build_manifest(sid)
        if result:
            # The bash section header must not appear — the section is stripped.
            assert "**Recent Commands:**" not in result

    def test_generic_has_no_web_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Generic harness omits web fetch history."""
        sid = "generic-no-web-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_web_fetch(sid, "https://docs.example.com/api")

        generic_cfg = _make_cfg(harness="generic")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: generic_cfg)

        result = compact.build_manifest(sid)
        if result:
            assert "**Web Fetches:**" not in result
            assert "docs.example.com" not in result

    def test_generic_still_has_manifest_header(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Generic harness keeps the manifest header — not completely empty."""
        sid = "generic-keeps-header-test"
        _populate(sid, files=2, greps=1, edits=1)

        generic_cfg = _make_cfg(harness="generic")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: generic_cfg)

        result = compact.build_manifest(sid)
        if result:
            assert "## Token-Goat Session Manifest" in result

    def test_generic_has_no_grep_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Generic harness strips grep history (investigation history)."""
        sid = "generic-no-grep-test"
        _populate(sid, files=2, greps=3, edits=1)

        generic_cfg = _make_cfg(harness="generic")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: generic_cfg)

        result = compact.build_manifest(sid)
        if result:
            # Grep section should not appear
            assert "**Searches:**" not in result
            assert "**Patterns:**" not in result


class TestManifestHarnessOpencode:
    """opencode harness: manifest must include the harness tag."""

    def test_opencode_injects_harness_tag(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """opencode harness injects '### harness: opencode' into the header."""
        sid = "opencode-tag-test"
        _populate(sid, files=2, greps=1, edits=1)

        opencode_cfg = _make_cfg(harness="opencode")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: opencode_cfg)

        result = compact.build_manifest(sid)
        assert result, "Expected non-empty manifest for populated session"
        assert "### harness: opencode" in result, (
            f"Expected '### harness: opencode' in manifest but not found:\n{result}"
        )

    def test_opencode_keeps_skills_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """opencode harness does not suppress the skills section."""
        sid = "opencode-keeps-skills-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_skill(sid, "ralph")

        opencode_cfg = _make_cfg(harness="opencode")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: opencode_cfg)

        result = compact.build_manifest(sid)
        assert result, "Expected non-empty manifest for populated session"
        # Skills section must be present for opencode (unlike codex)
        assert "**Skills:**" in result, f"Expected '**Skills:**' in opencode manifest:\n{result}"

    def test_opencode_tag_is_near_top(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The harness tag appears in the header area (within first 15 lines)."""
        sid = "opencode-tag-position-test"
        _populate(sid, files=2, greps=1, edits=1)

        opencode_cfg = _make_cfg(harness="opencode")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: opencode_cfg)

        result = compact.build_manifest(sid)
        assert result
        lines = result.splitlines()
        tag_lines = [i for i, ln in enumerate(lines) if "### harness: opencode" in ln]
        assert tag_lines, "### harness: opencode not found in manifest"
        assert tag_lines[0] < 20, (
            f"harness tag found at line {tag_lines[0]}, expected within first 20 lines"
        )


class TestHarnessConfigOverride:
    """Config override for harness type works end-to-end."""

    def test_config_override_codex_skips_skills(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Config harness='codex' removes skills regardless of env vars."""
        sid = "config-override-codex-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_skill(sid, "improve")

        codex_cfg = _make_cfg(harness="codex")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: codex_cfg)

        result = compact.build_manifest(sid)
        assert "**Skills:**" not in result or result == ""

    def test_config_override_generic_minimal_output(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Config harness='generic' produces minimal output regardless of env."""
        sid = "config-override-generic-test"
        _populate(sid, files=3, greps=2, edits=2)
        _add_bash_run(sid, "npm test", exit_code=0)

        generic_cfg = _make_cfg(harness="generic")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: generic_cfg)

        result = compact.build_manifest(sid)
        if result:
            assert "**Recent Commands:**" not in result
            assert "## Token-Goat Session Manifest" in result

    def test_config_override_opencode_has_tag(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Config harness='opencode' injects the opencode harness tag."""
        sid = "config-override-opencode-test"
        _populate(sid, files=2, greps=1, edits=1)

        opencode_cfg = _make_cfg(harness="opencode")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: opencode_cfg)

        result = compact.build_manifest(sid)
        if result:
            assert "### harness: opencode" in result


class TestAutoFallbackToGeneric:
    """auto detection falls back to generic when no env var matches."""

    def test_auto_no_env_manifest_strips_bash(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When no AI harness env var is set, auto falls back to generic (no bash section)."""
        sid = "auto-fallback-generic-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_bash_run(sid, "pytest tests/", exit_code=0)

        # Clear all harness-detection env vars so auto → generic.
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

        auto_cfg = _make_cfg(harness="auto")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: auto_cfg)

        result = compact.build_manifest(sid)
        if result:
            # generic harness: no bash section
            assert "**Recent Commands:**" not in result


class TestAutoTriggerMultiplierPerHarness:
    """Test per-harness default multipliers for auto_trigger_multiplier."""

    def test_claudecode_default_multiplier(self) -> None:
        """Claude Code harness gets 2.0x default multiplier."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=2.0,
            harness="claudecode",
        )
        assert multiplier == 2.0

    def test_codex_default_multiplier(self) -> None:
        """Codex harness gets 1.5x default multiplier."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=2.0,
            harness="codex",
        )
        assert multiplier == 1.5

    def test_opencode_default_multiplier(self) -> None:
        """opencode harness gets 2.5x default multiplier."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=2.0,
            harness="opencode",
        )
        assert multiplier == 2.5

    def test_generic_default_multiplier(self) -> None:
        """Generic harness gets 1.0x default multiplier."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=2.0,
            harness="generic",
        )
        assert multiplier == 1.0

    def test_explicit_config_override_takes_precedence(self) -> None:
        """User-set config value overrides harness default."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=3.5,
            harness="codex",
        )
        assert multiplier == 3.5

    def test_multiplier_clamped_to_max(self) -> None:
        """Multiplier is clamped to [1.0, 10.0]."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=25.0,
            harness="claudecode",
        )
        assert multiplier == 10.0

    def test_gemini_default_multiplier(self) -> None:
        """Gemini harness gets 3.0x default multiplier."""
        multiplier = compact.get_auto_trigger_multiplier(
            config_explicit_multiplier=2.0,
            harness="gemini",
        )
        assert multiplier == 3.0


class TestManifestHarnessGemini:
    """Gemini CLI harness: manifest includes harness tag and full sections."""

    def test_gemini_injects_harness_tag(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """gemini harness injects '### harness: gemini' into the header."""
        sid = "gemini-tag-test"
        _populate(sid, files=2, greps=1, edits=1)

        gemini_cfg = _make_cfg(harness="gemini")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: gemini_cfg)

        result = compact.build_manifest(sid)
        assert result, "Expected non-empty manifest for populated session"
        assert "### harness: gemini" in result, (
            f"Expected '### harness: gemini' in manifest but not found:\n{result}"
        )

    def test_gemini_keeps_skills_section(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """gemini harness does not suppress the skills section."""
        sid = "gemini-keeps-skills-test"
        _populate(sid, files=2, greps=1, edits=1)
        _add_skill(sid, "ralph")

        gemini_cfg = _make_cfg(harness="gemini")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: gemini_cfg)

        result = compact.build_manifest(sid)
        assert result, "Expected non-empty manifest for populated session"
        # Skills section must be present for gemini (unlike codex)
        assert "**Skills:**" in result, f"Expected '**Skills:**' in gemini manifest:\n{result}"

    def test_gemini_tag_is_near_top(
        self, tmp_data_dir: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The harness tag appears in the header area (within first 20 lines)."""
        sid = "gemini-tag-position-test"
        _populate(sid, files=2, greps=1, edits=1)

        gemini_cfg = _make_cfg(harness="gemini")
        monkeypatch.setattr("token_goat.compact._load_config", lambda: gemini_cfg)

        result = compact.build_manifest(sid)
        assert result
        lines = result.splitlines()
        tag_lines = [i for i, ln in enumerate(lines) if "### harness: gemini" in ln]
        assert tag_lines, "### harness: gemini not found in manifest"
        assert tag_lines[0] < 20, (
            f"harness tag found at line {tag_lines[0]}, expected within first 20 lines"
        )


class TestDetectHarnessGemini:
    """detect_harness() correctly identifies the Gemini CLI harness."""

    def test_config_override_gemini(self) -> None:
        """A config_override value of 'gemini' is returned directly."""
        assert detect_harness("gemini") == "gemini"

    def test_gemini_api_key_without_anthropic_returns_gemini(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: GEMINI_API_KEY without ANTHROPIC_API_KEY → gemini."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.setenv("GEMINI_API_KEY", "fake-gemini-key")
        assert detect_harness("auto") == "gemini"

    def test_google_api_key_without_anthropic_returns_gemini(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """auto detection: GOOGLE_API_KEY without ANTHROPIC_API_KEY → gemini."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("CODEX_SESSION", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("OPENCODE_SESSION", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setenv("GOOGLE_API_KEY", "fake-google-key")
        assert detect_harness("auto") == "gemini"

    def test_gemini_api_key_with_anthropic_returns_claudecode(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GEMINI_API_KEY + ANTHROPIC_API_KEY → Claude Code wins (higher precedence)."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-anthropic-key")
        monkeypatch.setenv("GEMINI_API_KEY", "fake-gemini-key")
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        assert detect_harness("auto") == "claudecode"

    def test_known_harnesses_includes_gemini(self) -> None:
        """_KNOWN_HARNESSES must include 'gemini' so override and config validation work."""
        from token_goat.compact import _KNOWN_HARNESSES
        assert "gemini" in _KNOWN_HARNESSES

    def test_valid_harness_config_includes_gemini(self) -> None:
        """config._VALID_HARNESS_VALUES must include 'gemini' for TOML validation."""
        from token_goat.config import _VALID_HARNESS_VALUES
        assert "gemini" in _VALID_HARNESS_VALUES

    def test_token_goat_harness_override_gemini(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """TOKEN_GOAT_HARNESS_OVERRIDE=gemini is accepted and returned."""
        monkeypatch.setenv("TOKEN_GOAT_HARNESS_OVERRIDE", "gemini")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
        assert detect_harness("auto") == "gemini"
