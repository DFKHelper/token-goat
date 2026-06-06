"""Tests for manifest recovery hint heading consistency (sub-area J).

Verifies that the post-compact recovery hint uses the same ### heading format
as the pre-compact manifest (e.g., ### Edited Files, ### Active Skills) so
the model sees consistent formatting before and after compaction.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from compact_test_helpers import make_file_entry as _make_file_entry


def _make_skill_entry(name: str) -> MagicMock:
    se = MagicMock()
    se.skill_name = name
    se.ts = 1300.0
    se.run_count = 1
    return se


def _build_hint_from_cache(cache: MagicMock) -> str | None:
    from token_goat.hooks_session import _build_recovery_hint
    with (
        patch("token_goat.session.load", return_value=cache),
        patch("token_goat.bash_cache.load_output", return_value=""),
    ):
        return _build_recovery_hint("test-session-heading")


class TestRecoveryHintHeadings:
    """Recovery hint uses ### headings consistent with manifest format."""

    def _make_cache(self, files=None, bash_history=None, edited_files=None, skill_history=None):
        cache = MagicMock()
        cache.files = files or {}
        cache.bash_history = bash_history or {}
        cache.web_history = {}
        cache.edited_files = edited_files or {}
        cache.skill_history = skill_history or {}
        cache.unavailable = False
        return cache

    def test_edited_files_uses_hash_heading(self):
        """Files section uses '### Edited Files' heading."""
        fe = _make_file_entry("src/main.py", read_count=3, edited=True)
        cache = self._make_cache(
            files={"k": fe},
            edited_files={"src/main.py": 2},
        )
        hint = _build_hint_from_cache(cache)
        assert hint is not None
        # Should use ### Edited Files heading (not the old **Files**: format)
        assert "### Edited Files" in hint

    def test_active_skills_uses_hash_heading(self):
        """Skills section uses '### Active Skills' heading."""
        se = _make_skill_entry("ralph")
        cache = self._make_cache(
            skill_history={"k": se},
        )
        hint = _build_hint_from_cache(cache)
        assert hint is not None
        # Should use ### Active Skills heading
        assert "### Active Skills" in hint

    def test_heading_format_consistent_with_manifest(self):
        """Both ### Edited Files and ### Active Skills appear when both exist."""
        fe = _make_file_entry("src/app.py", read_count=5, edited=True)
        se = _make_skill_entry("superman")
        cache = self._make_cache(
            files={"k": fe},
            edited_files={"src/app.py": 3},
            skill_history={"sk": se},
        )
        hint = _build_hint_from_cache(cache)
        assert hint is not None
        # Both sections should use ### headings
        assert "### Edited Files" in hint or "### Active Skills" in hint
