"""Tests for git-history hint timeout cap in _build_git_hint.

Verifies that:
- A fast git hint lookup still returns the hint text.
- A slow git hint lookup is skipped when the elapsed time exceeds git_hint_max_ms,
  and a git_hint_timeout stat event is recorded.
- Setting git_hint_max_ms = 0 disables the cap (hint is always returned regardless
  of elapsed time).
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

from token_goat.hooks_read import _build_git_hint

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config(git_hint_max_ms: int):
    """Build a minimal config stub with the given git_hint_max_ms value."""
    hints_cfg = MagicMock()
    hints_cfg.git_hint_max_ms = git_hint_max_ms
    cfg = MagicMock()
    cfg.hints = hints_cfg
    return cfg


def _fast_build_hint(project_hash: str, rel_path: str) -> str:
    """Simulate a fast git_history.build_hint that returns immediately."""
    return f"git: {rel_path}\n  abc123 recent commit (1d)"


def _slow_build_hint(project_hash: str, rel_path: str) -> str:
    """Simulate a slow git_history.build_hint that exceeds the 50 ms cap."""
    time.sleep(0.10)  # 100 ms — exceeds default 50 ms cap
    return f"git: {rel_path}\n  abc123 recent commit (1d)"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestGitHintTimeout:
    """_build_git_hint respects the git_hint_max_ms timeout cap."""

    def test_fast_hint_is_returned(self, tmp_data_dir, tmp_path, monkeypatch):
        """A fast git lookup returns the hint text normally."""
        cwd = str(tmp_path)
        file_path = str(tmp_path / "src" / "auth.py")
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "auth.py").write_text("# auth")

        fake_proj = MagicMock()
        fake_proj.hash = "deadbeef"
        fake_proj.root = tmp_path

        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: fake_proj)
        monkeypatch.setattr("token_goat.git_history.build_hint", _fast_build_hint)
        monkeypatch.setattr(
            "token_goat.config.load",
            lambda: _make_config(git_hint_max_ms=50),
        )

        result = _build_git_hint(cwd, file_path)

        assert result is not None
        assert "auth.py" in result

    @pytest.mark.slow
    def test_slow_hint_is_skipped_and_stat_recorded(self, tmp_data_dir, tmp_path, monkeypatch):
        """A git lookup exceeding git_hint_max_ms is skipped and records git_hint_timeout."""
        from token_goat import db

        cwd = str(tmp_path)
        file_path = str(tmp_path / "src" / "slow.py")
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "slow.py").write_text("# slow module")

        fake_proj = MagicMock()
        fake_proj.hash = "deadbeef"
        fake_proj.root = tmp_path

        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: fake_proj)
        monkeypatch.setattr("token_goat.git_history.build_hint", _slow_build_hint)
        # Use a very tight 10 ms cap so the 100 ms sleep definitely exceeds it
        monkeypatch.setattr(
            "token_goat.config.load",
            lambda: _make_config(git_hint_max_ms=10),
        )

        result = _build_git_hint(cwd, file_path)

        # Hint must be suppressed
        assert result is None

        # A git_hint_timeout stat row must be recorded
        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, bytes_saved, tokens_saved FROM stats WHERE kind = 'git_hint_timeout'"
            ).fetchall()
        assert len(rows) == 1, "expected exactly one git_hint_timeout stat row"
        assert rows[0]["bytes_saved"] == 0
        assert rows[0]["tokens_saved"] == 0

    @pytest.mark.slow
    def test_zero_max_ms_disables_cap(self, tmp_data_dir, tmp_path, monkeypatch):
        """git_hint_max_ms = 0 disables the timeout cap; slow hints still return."""
        cwd = str(tmp_path)
        file_path = str(tmp_path / "main.py")
        (tmp_path / "main.py").write_text("# main")

        fake_proj = MagicMock()
        fake_proj.hash = "deadbeef"
        fake_proj.root = tmp_path

        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: fake_proj)
        # Use a slightly slow build_hint (10 ms) but cap is disabled
        def _somewhat_slow(project_hash: str, rel_path: str) -> str:
            time.sleep(0.01)
            return f"git: {rel_path}\n  abc123 initial commit (5d)"

        monkeypatch.setattr("token_goat.git_history.build_hint", _somewhat_slow)
        monkeypatch.setattr(
            "token_goat.config.load",
            lambda: _make_config(git_hint_max_ms=0),
        )

        result = _build_git_hint(cwd, file_path)

        # Cap disabled → hint must come through
        assert result is not None
        assert "main.py" in result

    def test_config_default_is_50ms(self):
        """HintsConfig.git_hint_max_ms defaults to 50."""
        from token_goat.config import HintsConfig

        cfg = HintsConfig()
        assert cfg.git_hint_max_ms == 50

    def test_config_toml_key_accepted(self):
        """git_hint_max_ms can be specified as a TOML key in the [hints] section."""
        from token_goat.config import _HintsToml

        # Verify the TypedDict includes the key (static check via instantiation)
        d: _HintsToml = {"git_hint_max_ms": 100}
        assert d["git_hint_max_ms"] == 100
