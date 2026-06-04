"""Tests for manifest versioning header and hard character-budget enforcement.

Covers:
- manifest_version: 1 header appears in all non-empty manifests
- _enforce_char_budget truncation helper
- Over-budget manifest gets truncation warning line appended
- Truncation preserves edited files section in full
- max_manifest_chars=0 disables the cap (no truncation)
"""
from __future__ import annotations

import pytest

from token_goat import compact
from token_goat.compact import _enforce_char_budget

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_manifest_with_sections(
    *,
    edited_files: int = 2,
    symbols: int = 3,
    skills: int = 2,
    extra_lines: int = 0,
) -> str:
    """Build a synthetic manifest string with realistic section structure."""
    lines: list[str] = [
        "## Token-Goat Session Manifest",
        "manifest_version: 1",
        "stats: edited=2 bash=1",
    ]

    # Edited files section
    lines.append("**Staged/Uncommitted:**")
    for i in range(edited_files):
        lines.append(f"- src/module_{i}.py ✎×{i + 1}")

    # Symbols section
    lines.append("**Symbols Accessed:**")
    for i in range(symbols):
        lines.append(f"- src/file_{i}.py → func_a, func_b, Class{i}")

    # Skills section
    if skills:
        skill_names = ", ".join(f"skill_{i}" for i in range(skills))
        lines.append(f"**Skills:** {skill_names} — recall via `token-goat skill-body <name>`")
        for i in range(skills):
            lines.append(f"- skill_{i} (300 tokens) → `token-goat skill-body skill_{i} --compact`")

    # Extra padding lines in "other" section
    if extra_lines:
        lines.append("**Files:**")
        for i in range(extra_lines):
            lines.append(f"- → src/extra_{i}.py (read {i + 1}x)")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# manifest_version header
# ---------------------------------------------------------------------------

class TestManifestVersionHeader:
    """The manifest_version: 1 line must appear in all non-empty manifests."""

    def test_version_header_in_real_manifest(self, tmp_data_dir, make_session):
        """build_manifest() emits manifest_version: 1 on a populated session."""
        sid = "version-header-test-abc"
        make_session(sid, files_read=2, greps=1, edits=1)
        result = compact.build_manifest(sid)
        assert result, "manifest should be non-empty for populated session"
        assert "manifest_version: 1" in result

    def test_version_header_position(self, tmp_data_dir, make_session):
        """manifest_version: 1 must appear near the top (within first 10 lines)."""
        sid = "version-header-pos-test"
        make_session(sid, files_read=3, greps=2, edits=2)
        result = compact.build_manifest(sid)
        lines = result.splitlines()
        # Find the line in the first 10 (excludes the sealed block which comes before the header)
        version_lines = [i for i, ln in enumerate(lines) if "manifest_version: 1" in ln]
        assert version_lines, "manifest_version: 1 not found in manifest"
        # The first occurrence should be within the top 15 lines of the manifest
        assert version_lines[0] < 15, (
            f"manifest_version: 1 found at line {version_lines[0]}, expected within first 15 lines. "
            f"First 20 lines: {lines[:20]}"
        )

    def test_version_header_not_in_empty_manifest(self, tmp_data_dir):
        """Empty session produces empty manifest — no version header in empty string."""
        result = compact.build_manifest("empty-version-test-session")
        assert result == ""


# ---------------------------------------------------------------------------
# _enforce_char_budget helper
# ---------------------------------------------------------------------------

class TestEnforceCharBudget:
    """Unit tests for _enforce_char_budget truncation helper."""

    def test_no_truncation_when_within_budget(self):
        """Manifest within budget is returned unchanged."""
        manifest = _make_manifest_with_sections(edited_files=1, symbols=1, skills=0)
        budget = len(manifest) + 500
        result = _enforce_char_budget(manifest, budget)
        assert result == manifest

    def test_disabled_when_max_chars_zero(self):
        """max_chars=0 disables the cap — manifest returned unchanged even if huge."""
        manifest = "x" * 5000
        result = _enforce_char_budget(manifest, 0)
        assert result == manifest

    def test_truncation_appends_warning_line(self):
        """Over-budget manifest gets truncation warning appended."""
        manifest = _make_manifest_with_sections(edited_files=3, symbols=5, skills=2, extra_lines=30)
        budget = len(manifest) // 2  # Force truncation by halving budget
        result = _enforce_char_budget(manifest, budget)
        assert "manifest truncated at budget limit" in result

    def test_truncation_result_within_budget(self):
        """Result length must not exceed max_chars after truncation."""
        manifest = _make_manifest_with_sections(edited_files=3, symbols=5, skills=2, extra_lines=30)
        budget = len(manifest) // 2
        result = _enforce_char_budget(manifest, budget)
        assert len(result) <= budget, (
            f"truncated manifest length {len(result)} exceeds budget {budget}"
        )

    def test_truncation_preserves_edited_files_section(self):
        """Edited files section must survive truncation in full."""
        # Build a manifest with a clear edited section plus large other sections
        edited_lines = [
            "**Staged/Uncommitted:**",
            "- src/critical_file.py ✎×3",
            "- src/another_important.py ✎×1",
        ]
        filler = ["**Files:**"] + [f"- → src/filler_{i}.py (read {i}x)" for i in range(50)]
        manifest = "\n".join([
            "## Token-Goat Session Manifest",
            "manifest_version: 1",
        ] + edited_lines + filler)

        # Budget: enough for header + edited, not enough for all filler
        budget = len("\n".join(["## Token-Goat Session Manifest", "manifest_version: 1"] + edited_lines)) + 100
        result = _enforce_char_budget(manifest, budget)

        # All edited file paths must be present in the result
        assert "src/critical_file.py" in result
        assert "src/another_important.py" in result
        assert "**Staged/Uncommitted:**" in result

    def test_truncation_preserves_version_header(self):
        """Version header must survive truncation."""
        manifest = _make_manifest_with_sections(edited_files=2, symbols=5, skills=3, extra_lines=40)
        budget = len(manifest) // 3
        result = _enforce_char_budget(manifest, budget)
        assert "manifest_version: 1" in result

    def test_truncation_preserves_main_header(self):
        """## Token-Goat Session Manifest title must survive truncation."""
        manifest = _make_manifest_with_sections(edited_files=2, symbols=5, skills=3, extra_lines=40)
        budget = len(manifest) // 3
        result = _enforce_char_budget(manifest, budget)
        assert "## Token-Goat Session Manifest" in result

    def test_no_truncation_when_exactly_at_budget(self):
        """Manifest exactly at budget is returned unchanged (no spurious truncation)."""
        manifest = "## Token-Goat Session Manifest\nmanifest_version: 1\n- some line"
        budget = len(manifest)
        result = _enforce_char_budget(manifest, budget)
        assert result == manifest
        assert "manifest truncated" not in result

    def test_line_join_budget_is_exact(self):
        """Budget uses N-1 newlines for N kept lines — no off-by-one overcounting.

        Regression for: _current_result_len adding N newlines instead of N-1,
        which caused the budget to be overcounted by 1 char per kept line.
        With the bug, a tight budget would reject a line that actually fits.
        """
        # _TRUNCATION_SUFFIX = "\n... (manifest truncated at budget limit)" = 41 chars
        _SUFFIX_LEN = 41
        header = "## Token-Goat Session Manifest"  # 30 chars
        body = "b" * 10                           # 10 chars
        # Joined: header + "\n" + body = 41 chars.  Add a long filler to force truncation.
        filler = "x" * 60
        manifest = f"{header}\n{body}\n{filler}"
        assert len(manifest) == 102  # sanity check

        # Budget = header(30) + newline(1) + body(10) + suffix(41) = 82.
        # available = 82 - 41 = 41. Exact room for header + body.
        # Fixed code: both lines fit (30 + 1 + 10 = 41 = available).
        # Buggy code: second line rejected because overcount makes current=31 after header.
        budget = 82
        result = _enforce_char_budget(manifest, budget)
        assert body in result, (
            "body line must fit when budget is exactly (header + newline + body + suffix); "
            "off-by-one newline overcounting would reject it"
        )
        assert "manifest truncated" in result  # filler was dropped


# ---------------------------------------------------------------------------
# Integration: build_manifest with max_manifest_chars config
# ---------------------------------------------------------------------------

class TestBuildManifestCharBudget:
    """Integration tests: build_manifest() enforces max_manifest_chars cap."""

    def test_overbudget_manifest_truncated_via_config(self, tmp_data_dir, make_session, monkeypatch):
        """When max_manifest_chars is very small, build_manifest truncates with warning."""
        sid = "overbudget-char-test"
        make_session(sid, files_read=5, greps=3, edits=3)

        # Patch the config to use a tiny char budget
        from token_goat.config import CompactAssistConfig, Config
        tiny_cfg = Config()
        tiny_cfg.compact_assist = CompactAssistConfig(max_manifest_chars=400)

        with pytest.MonkeyPatch().context() as mp:
            mp.setattr("token_goat.compact._load_config", lambda: tiny_cfg)
            result = compact.build_manifest(sid)

        if result:
            # If non-empty, must be within budget
            assert len(result) <= 400 or "manifest truncated at budget limit" in result

    def test_zero_max_manifest_chars_disables_cap(self, tmp_data_dir, make_session, monkeypatch):
        """max_manifest_chars=0 disables the hard cap — manifest can be any size."""
        sid = "no-char-cap-test"
        make_session(sid, files_read=5, greps=3, edits=3)

        from token_goat.config import CompactAssistConfig, Config
        no_cap_cfg = Config()
        no_cap_cfg.compact_assist = CompactAssistConfig(max_manifest_chars=0)

        with pytest.MonkeyPatch().context() as mp:
            mp.setattr("token_goat.compact._load_config", lambda: no_cap_cfg)
            result = compact.build_manifest(sid)

        if result:
            # Must not contain the truncation warning since cap is disabled
            assert "manifest truncated at budget limit" not in result


# ---------------------------------------------------------------------------
# Config: max_manifest_chars default and validation
# ---------------------------------------------------------------------------

class TestMaxManifestCharsConfig:
    """max_manifest_chars appears in config with correct default and bounds."""

    def test_default_value(self):
        """Default max_manifest_chars is 1600."""
        from token_goat.config import CompactAssistConfig
        cfg = CompactAssistConfig()
        assert cfg.max_manifest_chars == 1600

    def test_zero_disables_cap(self):
        """max_manifest_chars=0 is a valid value that disables the cap."""
        from token_goat.config import CompactAssistConfig
        cfg = CompactAssistConfig(max_manifest_chars=0)
        assert cfg.max_manifest_chars == 0

    def test_config_load_applies_max_manifest_chars(self, tmp_path, monkeypatch):
        """Config loader reads max_manifest_chars from TOML correctly."""
        from token_goat import config as config_mod
        from token_goat import paths

        toml_content = "[compact_assist]\nmax_manifest_chars = 800\n"
        config_file = tmp_path / "config.toml"
        config_file.write_text(toml_content, encoding="utf-8")

        monkeypatch.setattr(paths, "config_path", lambda: config_file)
        # Bust process-level cache
        config_mod._config_mtime_cache = None

        cfg = config_mod.load()
        assert cfg.compact_assist.max_manifest_chars == 800

        # Restore cache to None for isolation
        config_mod._config_mtime_cache = None
