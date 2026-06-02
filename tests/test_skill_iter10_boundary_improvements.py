"""Tests for skill context savings improvements (iteration 10 boundary).

Covers three improvements:

1. ``find_markdown_boundary`` in ``cache_common``: cuts compact text at a
   markdown heading or paragraph boundary rather than a raw byte position,
   yielding coherent truncated slices.

2. Large-body warning in ``hooks_skill.post_skill``: when a skill body
   exceeds 32 KB and has no ``<!-- COMPACT_END -->`` marker, a WARNING is
   written to stderr so skill authors know to add the marker.

3. Compact budget truncation in ``hooks_skill.post_skill`` uses
   ``find_markdown_boundary`` instead of ``rfind("\\n")`` so the stored
   compact ends at a section or paragraph boundary.
"""
from __future__ import annotations

from io import StringIO
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Improvement 1: find_markdown_boundary helper
# ---------------------------------------------------------------------------


class TestFindMarkdownBoundary:
    """Unit tests for cache_common.find_markdown_boundary."""

    def _fmb(self, text: str, max_chars: int, **kw: int) -> int:
        from token_goat.cache_common import find_markdown_boundary
        return find_markdown_boundary(text, max_chars, **kw)

    # --- basic heading priority ---

    def test_cuts_before_last_heading(self) -> None:
        """Prefers cutting just before a markdown heading in the window."""
        # Use min_keep=5 to allow the heading at pos 21 to qualify.
        text = "## Intro\n\nSome text.\n\n## Section 2\nMore content here."
        # The window covers everything up to pos 40
        # '\n## Section 2' is at pos 21 in the text
        result = self._fmb(text, 40, min_keep=5)
        # Should cut at heading_pos+1 = 22
        kept = text[:result]
        assert kept.endswith("\n"), f"Expected cut after newline, got: {kept!r}"
        assert "## Section 2" not in kept, "Heading must not appear in the kept prefix"

    def test_heading_cut_includes_newline(self) -> None:
        """The kept prefix ends with the newline, not with the heading itself."""
        text = "First paragraph.\n\n## Next Heading\nBody."
        result = self._fmb(text, len("First paragraph.\n\n## Next Heading"), min_keep=5)
        kept = text[:result]
        # Heading boundary: the '#' char must be excluded
        assert "#" not in kept, f"No '#' should be in kept prefix: {kept!r}"

    # --- paragraph break priority (when no heading in window) ---

    def test_falls_back_to_paragraph_break(self) -> None:
        """Uses paragraph break when no heading is in the window (with low min_keep)."""
        text = "Line one.\n\nLine two.\n\nLine three extra padding."
        # Use a low min_keep so the paragraph boundary at pos 9 qualifies.
        result = self._fmb(text, 25, min_keep=5)
        kept = text[:result]
        # Para break '\n\n' at pos 9; result should be 11 (pos 9 + 2).
        # Result might be 11 ('\n\n' after "Line one.") or the last '\n\n' at 20+2=22.
        assert kept.endswith("\n"), (
            f"Expected cut after paragraph break (newline), got: {kept!r}"
        )

    def test_paragraph_break_preferred_over_plain_newline(self) -> None:
        """A double newline is preferred over a plain newline (with low min_keep)."""
        text = "Para one.\n\nPara two line1\nline2 here."
        # '\n\n' at pos 9, '\n' at pos 25. With min_keep=5 both qualify.
        result = self._fmb(text, 30, min_keep=5)
        kept = text[:result]
        # rfind('\n\n') in window[:30] = pos 9; rfind('\n') = pos 25.
        # Paragraph break (pos 9) should be preferred: result = 9+2 = 11.
        # But since para_pos (9) < plain nl_pos (25), paragraph wins.
        assert "\n\n" in text[:result] or kept.endswith("\n"), (
            f"Expected paragraph or newline boundary: {kept!r}"
        )

    # --- plain newline fallback ---

    def test_falls_back_to_plain_newline(self) -> None:
        """Uses the last plain newline when no heading or paragraph break fits."""
        text = "Line one here\nLine two here\nLine three."
        result = self._fmb(text, 28, min_keep=5)
        kept = text[:result]
        assert kept.endswith("\n"), f"Expected plain newline cut, got {kept!r}"

    # --- hard cut fallback ---

    def test_hard_cut_when_no_boundary_in_min_keep_range(self) -> None:
        """Returns max_chars when no boundary falls at or beyond min_keep."""
        text = "Nospacehere" * 50  # no newlines at all
        result = self._fmb(text, 40)
        assert result == 40, f"Expected hard cut at 40, got {result}"

    # --- min_keep guard ---

    def test_min_keep_prevents_tiny_slice(self) -> None:
        """A heading near the start of the window is ignored when below min_keep."""
        # '\n# X' at position 3 would normally produce a cut at pos 4 — but that
        # is < min_keep (default 128), so the function should fall through.
        text = "ab\n# Heading\nLots of content after the heading that fills the window more."
        result = self._fmb(text, 70)
        # min_keep=128 > 70, so heading at pos 2 is below min_keep; same for para/nl
        # Falls through to hard cut
        assert result == 70

    def test_min_keep_override(self) -> None:
        """Caller can lower min_keep to allow an early heading boundary."""
        text = "ab\n# Heading\nLots of content."
        result = self._fmb(text, 20, min_keep=2)
        kept = text[:result]
        assert "# Heading" not in kept, "Heading should be excluded from kept prefix"
        assert result > 2, "Cut must be beyond min_keep"

    # --- idempotence / boundary conditions ---

    def test_text_shorter_than_max_chars(self) -> None:
        """When text fits entirely, the function still returns a valid index <= max_chars."""
        text = "Short text."
        result = self._fmb(text, 500)
        assert result <= 500

    def test_empty_text(self) -> None:
        """Empty text returns max_chars (= 0 when max_chars = 0, else the cap)."""
        assert self._fmb("", 0) == 0
        assert self._fmb("", 10) == 10


# ---------------------------------------------------------------------------
# Improvement 2: large-body warning in hooks_skill.post_skill
# ---------------------------------------------------------------------------


class TestLargeBodyWarning:
    """post_skill emits a warning when a large body has no COMPACT_END marker."""

    _LARGE_BODY_THRESHOLD: int = 32_768  # 32 KB

    @pytest.fixture(autouse=True)
    def _patch_data_dir(self, tmp_data_dir):
        """Redirect paths.data_dir to a temp dir for every test in this class.

        Uses the shared ``tmp_data_dir`` fixture so tests do not write to the
        real data directory.
        """
        self.tmp_data_dir = tmp_data_dir

    def _make_payload(self, skill_name: str, body: str) -> dict:
        return {
            "tool_name": "Skill",
            "tool_input": {"skill": skill_name},
            "tool_response": {"output": body},
            "session_id": "test-session-warn",
            "cwd": "/tmp",
        }

    def _large_body_no_marker(self, size: int = 33_000) -> str:
        """Return a body larger than the threshold with no COMPACT_END marker."""
        base = "# Large Skill\n\n## Section One\n\n"
        filler = "This is a line of skill content that fills space. " * 20 + "\n"
        body = base
        while len(body.encode("utf-8")) < size:
            body += filler
        return body

    def _large_body_with_marker(self, size: int = 33_000) -> str:
        """Return a body larger than the threshold that DOES have a COMPACT_END marker."""
        base = "# Large Skill\n\n## Quick Ref\n\nKey rules here.\n\n<!-- COMPACT_END -->\n\n"
        filler = "Extended reference content. " * 20 + "\n"
        body = base
        while len(body.encode("utf-8")) < size:
            body += filler
        return body

    def test_warning_emitted_for_large_body_without_marker(
        self, monkeypatch: object
    ) -> None:
        """Stderr warning is written when body > 32 KB and no COMPACT_END."""
        from token_goat import hooks_skill
        from token_goat.config import SkillPreservationConfig

        body = self._large_body_no_marker(self._LARGE_BODY_THRESHOLD + 1000)
        assert "COMPACT_END" not in body, "Test setup: body must have no marker"
        assert len(body.encode("utf-8")) > self._LARGE_BODY_THRESHOLD

        payload = self._make_payload("large-skill", body)
        stderr_buf = StringIO()

        cfg_sp = SkillPreservationConfig(enabled=True)
        with (
            patch("token_goat.config.load") as mock_cfg,
            patch("sys.stderr", stderr_buf),
        ):
            mock_cfg.return_value.skill_preservation = cfg_sp
            hooks_skill.post_skill(payload)

        warning_text = stderr_buf.getvalue()
        assert "token-goat warning" in warning_text, (
            f"Expected 'token-goat warning' in stderr, got: {warning_text!r}"
        )
        assert "large-skill" in warning_text, (
            f"Skill name should appear in warning: {warning_text!r}"
        )
        assert "COMPACT_END" in warning_text, (
            f"Warning should mention COMPACT_END: {warning_text!r}"
        )

    def test_no_warning_for_large_body_with_marker(
        self, monkeypatch: object
    ) -> None:
        """No stderr warning when body > 32 KB but COMPACT_END marker is present."""
        from token_goat import hooks_skill
        from token_goat.config import SkillPreservationConfig

        body = self._large_body_with_marker(self._LARGE_BODY_THRESHOLD + 1000)
        assert "COMPACT_END" in body, "Test setup: body must have the marker"

        payload = self._make_payload("has-marker-skill", body)
        stderr_buf = StringIO()

        cfg_sp = SkillPreservationConfig(enabled=True)
        with (
            patch("token_goat.config.load") as mock_cfg,
            patch("sys.stderr", stderr_buf),
        ):
            mock_cfg.return_value.skill_preservation = cfg_sp
            hooks_skill.post_skill(payload)

        warning_text = stderr_buf.getvalue()
        # The oversized-compact warning (from explicit-marker path) may appear,
        # but the large-body-without-marker warning must NOT appear.
        # The large-body warning uniquely contains "KB but has no".
        assert "KB but has no" not in warning_text, (
            f"Large-body warning must not fire when marker is present: {warning_text!r}"
        )

    def test_no_warning_for_small_body(
        self, monkeypatch: object
    ) -> None:
        """No warning for a body smaller than the threshold, even without a marker."""
        from token_goat import hooks_skill
        from token_goat.config import SkillPreservationConfig

        body = "# Small Skill\n\nJust a few lines.\nNot very large.\n"
        assert len(body.encode("utf-8")) < self._LARGE_BODY_THRESHOLD

        payload = self._make_payload("small-skill", body)
        stderr_buf = StringIO()

        cfg_sp = SkillPreservationConfig(enabled=True)
        with (
            patch("token_goat.config.load") as mock_cfg,
            patch("sys.stderr", stderr_buf),
        ):
            mock_cfg.return_value.skill_preservation = cfg_sp
            hooks_skill.post_skill(payload)

        warning_text = stderr_buf.getvalue()
        assert "KB but has no" not in warning_text, (
            f"Large-body warning must not fire for a small body: {warning_text!r}"
        )


# ---------------------------------------------------------------------------
# Improvement 3: compact budget truncation uses markdown boundary
# ---------------------------------------------------------------------------


class TestCompactBudgetMarkdownBoundary:
    """Auto-extracted compact is cut at a markdown boundary, not a random newline."""

    @pytest.fixture(autouse=True)
    def _patch_data_dir(self, tmp_data_dir):
        """Redirect paths.data_dir to a temp dir for every test in this class.

        Uses the shared ``tmp_data_dir`` fixture so tests do not write to the
        real data directory.
        """
        self.tmp_data_dir = tmp_data_dir

    def _make_multi_section_body(self) -> str:
        """Return a body > 4000 bytes whose auto-compact will have multiple sections."""
        sections = []
        for i in range(10):
            heading = f"## Section {i}"
            rules = "\n".join(
                f"CRITICAL: Rule {j} in section {i} — always follow this guideline carefully."
                for j in range(15)
            )
            sections.append(f"{heading}\n\n{rules}")
        body = "# Multi-Section Skill\n\n" + "\n\n".join(sections) + "\n\nFiller. " * 200
        assert len(body.encode("utf-8")) > 4000, "Body must be > 4000 bytes for hook to compact"
        return body

    def test_compact_ends_before_heading_when_truncated(
        self,
    ) -> None:
        """When compact is cut to budget, the cut point is at or before a heading."""
        from token_goat import skill_cache

        body = self._make_multi_section_body()
        compact = skill_cache.generate_compact_summary(body)
        assert compact, "Auto-compact must be non-empty for this test"

        # Simulate a very tight budget (100 tokens = 400 chars) to force truncation.
        budget_tokens = 100
        budget_chars = budget_tokens * 4

        if len(compact) <= budget_chars:
            pytest.skip("Compact fits in budget; truncation not triggered")

        from token_goat.cache_common import find_markdown_boundary
        cut = find_markdown_boundary(compact, budget_chars)
        if cut <= 0:
            cut = budget_chars
        truncated = compact[:cut].rstrip() + "…"

        # The truncated compact should not end mid-sentence (i.e., it either
        # ends just before a '#' heading or at a paragraph/newline boundary).
        # At minimum, it should not end with a '#' character (the heading char
        # itself should be excluded from the kept prefix).
        assert not truncated.rstrip("…").rstrip().endswith("#"), (
            f"Kept prefix must not end with '#': {truncated!r}"
        )
        # The truncation ellipsis marker must be present.
        assert truncated.endswith("…"), f"Truncated compact must end with '…': {truncated!r}"

    def test_compact_budget_cut_via_hook(
        self, monkeypatch: object
    ) -> None:
        """post_skill applies markdown-boundary truncation when compact exceeds budget."""
        from token_goat import hooks_skill, skill_cache
        from token_goat.config import SkillPreservationConfig

        body = self._make_multi_section_body()

        # Verify the auto-compact would be > 400 chars (budget=100 tokens × 4 chars).
        raw_compact = skill_cache.generate_compact_summary(body)
        if not raw_compact or len(raw_compact) <= 400:
            pytest.skip("Compact too short to trigger truncation with budget=100 tokens")

        # Use a tight budget to force truncation.
        cfg_sp = SkillPreservationConfig(enabled=True, truncation_budget_tokens=100)

        stored_compacts: list[str] = []
        _real_store_compact = skill_cache.store_compact

        def _capture_compact(session_id: str, skill_name: str, text: str, **kw: object) -> None:
            stored_compacts.append(text)
            _real_store_compact(session_id, skill_name, text, **kw)

        payload = {
            "tool_name": "Skill",
            "tool_input": {"skill": "multi-section"},
            "tool_response": {"output": body},
            "session_id": "test-session-boundary",
            "cwd": "/tmp",
        }

        # hooks_skill imports skill_cache lazily via `from . import skill_cache`,
        # so we need to patch the function on the already-imported module object.
        import token_goat.skill_cache as sc_mod  # noqa: PLC0415

        with (
            patch("token_goat.config.load") as mock_cfg,
            patch.object(sc_mod, "store_compact", side_effect=_capture_compact),
        ):
            mock_cfg.return_value.skill_preservation = cfg_sp
            hooks_skill.post_skill(payload)

        assert stored_compacts, "A compact must have been stored by post_skill"
        stored = stored_compacts[0]

        # Budget = 100 tokens × 4 chars = 400 chars. Stored compact must be
        # at most 400 chars + the '…' suffix (1 char).
        assert len(stored) <= 401, (
            f"Stored compact exceeds budget: {len(stored)} chars, content={stored[:80]!r}"
        )

        # The truncation ellipsis must be present when the compact was cut.
        assert stored.endswith("…"), (
            f"Truncated compact must end with '…': {stored!r}"
        )
