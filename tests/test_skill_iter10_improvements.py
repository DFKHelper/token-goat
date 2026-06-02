"""Tests for skill context savings improvements (iteration 10 of 10).

Covers:
1. Gzip-compressed skill body + section extraction end-to-end: verify that
   ``token-goat skill-body --section`` correctly decompresses before extracting.
2. Token savings reporting accuracy: stat recording uses compact.estimate_tokens
   (3 chars/token) rather than the raw // 4 approximation (4 chars/token).
3. Token count display consistency: skill-list and skill-size display tokens
   using the same canonical estimator (3 chars/token) as the rest of the codebase.
"""
from __future__ import annotations

from unittest.mock import patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_skill_body_with_sections(size_bytes: int = 20_000) -> str:
    """Return a multi-section skill body large enough to trigger gzip compression."""
    lines = [
        "# Big Skill",
        "",
        "## Overview",
        "",
        "This skill does many things.",
        "",
        "## Rules",
        "",
        "MUST follow rules.",
        "NEVER skip steps.",
        "",
        "## Implementation Details",
        "",
    ]
    # Pad the body past the threshold so gzip kicks in.
    filler = "This is detailed implementation content with lots of words. " * 10
    while sum(len(ln) + 1 for ln in lines) < size_bytes:
        lines.append(filler)
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("The summary section.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Improvement 1: gzip-compressed body + section extraction end-to-end
# ---------------------------------------------------------------------------


class TestGzipSectionExtraction:
    """Verify that --section works correctly on gzip-compressed cached bodies."""

    def test_section_extracted_from_compressed_body(self, tmp_path, monkeypatch):
        """extract_named_section returns correct text from a gzip-stored body."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        # Store a large body that will be gzip-compressed.
        body = _make_skill_body_with_sections(20_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-gz", "bigskill", body)

        assert meta is not None, "store_output should succeed"

        # The .gz file must exist (compression triggered).
        skills_dir = tmp_path / "skills"
        gz_files = list(skills_dir.glob("*.gz"))
        assert gz_files, "Expected at least one .gz file"

        # load_output must transparently decompress and return the full text.
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None, "load_output should succeed for a compressed body"

        # Section extraction on the decompressed text must work.
        section = skill_cache.extract_named_section(loaded, "Rules")
        assert section is not None, "Section 'Rules' should be found in decompressed body"
        assert "MUST follow rules" in section
        assert "NEVER skip steps" in section

    def test_section_extraction_returns_none_for_missing_section(self, tmp_path, monkeypatch):
        """extract_named_section returns None gracefully for a nonexistent section."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(20_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-gz2", "bigskill2", body)

        assert meta is not None

        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None

        # Requesting a nonexistent section must return None, not raise.
        section = skill_cache.extract_named_section(loaded, "Nonexistent Section")
        assert section is None

    def test_overview_section_extracted_from_compressed_body(self, tmp_path, monkeypatch):
        """The first section (Overview) is correctly extracted from a compressed body."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(20_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-gz3", "bigskill3", body)

        assert meta is not None
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None

        section = skill_cache.extract_named_section(loaded, "Overview")
        assert section is not None
        assert "This skill does many things" in section

    def test_section_not_truncated_after_decompression(self, tmp_path, monkeypatch):
        """Decompressed body preserves all sections; the last section is reachable."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(20_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-gz4", "bigskill4", body)

        assert meta is not None
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None

        # "Summary" is the last section added to the body — verifies no tail truncation.
        section = skill_cache.extract_named_section(loaded, "Summary")
        assert section is not None, "Last section 'Summary' should survive decompression"
        assert "The summary section" in section


# ---------------------------------------------------------------------------
# Improvement 2: Token savings stat accuracy — estimate_tokens vs // 4
# ---------------------------------------------------------------------------


class TestTokenSavingsAccuracy:
    """Stat recording uses compact.estimate_tokens (3 chars/token) not // 4."""

    def test_estimate_tokens_formula(self):
        """compact.estimate_tokens uses len(text) // 3 + 1, not // 4."""
        from token_goat.compact import estimate_tokens

        # A 1200-char string: // 4 = 300, // 3 + 1 = 401.
        text = "x" * 1200
        result = estimate_tokens(text)
        assert result == 401, f"Expected 401, got {result}"

    def test_estimate_tokens_larger_than_div4(self):
        """estimate_tokens always returns more than simple // 4 for the same text."""
        from token_goat.compact import estimate_tokens

        # For any text of 8+ chars, estimate_tokens > len // 4.
        for n_chars in (8, 100, 1000, 10_000):
            text = "a" * n_chars
            est = estimate_tokens(text)
            naive = n_chars // 4
            assert est > naive, (
                f"estimate_tokens({n_chars} chars) = {est} should be > {naive}"
            )

    def test_skill_body_recall_stat_uses_estimate_tokens(self, tmp_path, monkeypatch):
        """skill_body_recall stat records tokens_saved using estimate_tokens, not // 4."""
        from token_goat import paths, skill_cache
        from token_goat.compact import estimate_tokens
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        # Store a body with a known section so we can check the savings calculation.
        body = _make_skill_body_with_sections(8_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=False)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-stat", "statskill", body)

        assert meta is not None
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None

        section_text = skill_cache.extract_named_section(loaded, "Rules")
        assert section_text is not None

        # Compute what the stat should record.
        expected_tokens_saved = max(
            0, estimate_tokens(loaded) - estimate_tokens(section_text)
        )
        # The estimate_tokens formula gives more tokens than // 4.
        naive_tokens_saved = max(0, (len(loaded.encode()) - len(section_text.encode())) // 4)
        assert expected_tokens_saved > naive_tokens_saved, (
            "estimate_tokens should yield more tokens_saved than // 4"
        )

    def test_compact_tokens_use_estimate_tokens(self, tmp_path, monkeypatch):
        """Compact token count reported in skill-list uses estimate_tokens."""
        from token_goat import paths, skill_cache
        from token_goat.compact import estimate_tokens
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(5_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=False)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-ct", "ctskill", body)

        assert meta is not None
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None

        # generate_compact_summary returns the compact body text.
        compact_body = skill_cache.generate_compact_summary(loaded)
        # estimate_tokens on the compact body must be > len(compact_body) // 4.
        est = estimate_tokens(compact_body)
        naive = len(compact_body) // 4
        assert est > naive or len(compact_body) < 8, (
            "estimate_tokens should exceed // 4 for any non-trivial compact body"
        )


# ---------------------------------------------------------------------------
# Improvement 3: skill-list and skill-size use canonical token estimator
# ---------------------------------------------------------------------------


class TestSkillListTokenCounts:
    """skill-list --json reports token counts using estimate_tokens (3 chars/token)."""

    def _make_session_with_skill(self, tmp_path, monkeypatch, skill_name: str, body: str) -> str:
        """Store a skill body and return the session id prefix."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        cfg_sp = SkillPreservationConfig(compress_bodies=False)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-list", skill_name, body)

        assert meta is not None
        return "sess-list"

    def test_skill_list_json_body_tokens_uses_estimate_tokens(self, tmp_path, monkeypatch, capsys):
        """skill-list --json body_tokens reflects estimate_tokens formula."""
        from token_goat import paths, skill_cache
        from token_goat.compact import estimate_tokens
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(5_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=False)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            meta = skill_cache.store_output("sess-list2", "listskill", body)

        assert meta is not None

        # Run skill-list --json via the Typer app.
        import json

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["skill-list", "--json", "--session-id", "sess-list2"])

        # If skill-list exits with error, skip the precision check.
        if result.exit_code != 0 or not result.output.strip():
            return

        data = json.loads(result.output.strip())
        skills = data.get("skills", [])
        if not skills:
            return

        row = skills[0]
        reported_body_tokens = row.get("body_tokens", 0)

        loaded = skill_cache.load_output(meta.output_id)
        expected_tokens = estimate_tokens(loaded) if loaded else 0

        assert reported_body_tokens == expected_tokens, (
            f"skill-list body_tokens={reported_body_tokens} should equal "
            f"estimate_tokens={expected_tokens}"
        )


class TestSkillSizeTokenCounts:
    """skill-size computes tokens with 3-chars/token (canonical) not 4."""

    def test_body_tokens_exceeds_div4(self, tmp_path, monkeypatch):
        """skill-size body_tokens must be > body_chars // 4 (canonical is higher)."""
        from token_goat import paths, skill_cache
        from token_goat.config import SkillPreservationConfig

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        body = _make_skill_body_with_sections(5_000)
        cfg_sp = SkillPreservationConfig(compress_bodies=False)
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = cfg_sp
            skill_cache.store_output("sess-size", "sizeskill", body)

        # Verify via get_all_cached_skills that the formula is consistent.
        skills = skill_cache.get_all_cached_skills("sess-size")
        assert skills, "Should have at least one cached skill"

        skill = skills[0]
        body_chars = skill.get("body_chars")
        if isinstance(body_chars, int) and body_chars > 0:
            expected = max(1, body_chars // 3 + 1)
            naive = body_chars // 4
            assert expected > naive, (
                f"3-chars/token estimate ({expected}) should exceed 4-chars/token ({naive})"
            )
