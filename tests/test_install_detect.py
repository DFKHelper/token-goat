"""Tests for detect_cline(), detect_windsurf(), detect_copilot_cli() in install.py."""

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat.install import detect_cline, detect_copilot_cli, detect_windsurf

# ---------------------------------------------------------------------------
# detect_cline
# ---------------------------------------------------------------------------


def test_detect_cline_via_binary(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/cline" if name == "cline" else None)
    assert detect_cline() is True


def test_detect_cline_via_alias_binary(monkeypatch):
    monkeypatch.setattr(
        "shutil.which",
        lambda name: "/usr/bin/claude-dev" if name == "claude-dev" else None,
    )
    assert detect_cline() is True


def test_detect_cline_not_present(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    with patch("importlib.util.find_spec", return_value=None):
        assert detect_cline() is False


def test_detect_cline_via_package(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    with patch("importlib.util.find_spec", return_value=object()):
        assert detect_cline() is True


# ---------------------------------------------------------------------------
# detect_windsurf
# ---------------------------------------------------------------------------


def test_detect_windsurf_via_binary(monkeypatch):
    monkeypatch.setattr(
        "shutil.which",
        lambda name: "/usr/bin/windsurf" if name == "windsurf" else None,
    )
    assert detect_windsurf() is True


def test_detect_windsurf_via_home_dir(monkeypatch, tmp_path):
    """Returns True when ~/.windsurf directory exists under the mocked home."""
    monkeypatch.setattr("shutil.which", lambda name: None)
    windsurf_dir = tmp_path / ".windsurf"
    windsurf_dir.mkdir()
    with patch("token_goat.install.Path") as MockPath:
        MockPath.home.return_value = tmp_path
        # Path(some_string) must still work for the APPDATA branch on Windows.
        MockPath.side_effect = Path
        # (tmp_path / ".windsurf").exists() is True — detect_windsurf should return True.
        result = detect_windsurf()
    assert result is True


def test_detect_windsurf_not_present(monkeypatch, tmp_path):
    """Returns False when binary absent and no windsurf config dirs exist."""
    monkeypatch.setattr("shutil.which", lambda name: None)
    # tmp_path has no .windsurf child and APPDATA points to tmp_path (no Windsurf subdir).
    with patch("token_goat.install.Path") as MockPath:
        MockPath.home.return_value = tmp_path
        MockPath.side_effect = Path
        with patch.dict(os.environ, {"APPDATA": str(tmp_path)}, clear=False):
            result = detect_windsurf()
    assert result is False


@pytest.mark.skipif(sys.platform != "win32", reason="Windows APPDATA branch only")
def test_detect_windsurf_via_appdata_dir(monkeypatch, tmp_path):
    """Returns True when %APPDATA%\\Windsurf exists on Windows."""
    monkeypatch.setattr("shutil.which", lambda name: None)
    appdata_windsurf = tmp_path / "Windsurf"
    appdata_windsurf.mkdir()
    with patch("token_goat.install.Path") as MockPath:
        MockPath.home.return_value = tmp_path  # no .windsurf in home
        MockPath.side_effect = Path
        with patch.dict(os.environ, {"APPDATA": str(tmp_path)}, clear=False):
            result = detect_windsurf()
    assert result is True


# ---------------------------------------------------------------------------
# detect_copilot_cli
# ---------------------------------------------------------------------------


def test_detect_copilot_cli_via_binary(monkeypatch):
    monkeypatch.setattr(
        "shutil.which",
        lambda name: "/usr/local/bin/copilot" if name == "copilot" else None,
    )
    assert detect_copilot_cli() is True


def test_detect_copilot_cli_not_present(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert detect_copilot_cli() is False


def test_detect_copilot_via_alias(monkeypatch):
    def mock_which(name):
        return "/usr/local/bin/github-copilot-cli" if name == "github-copilot-cli" else None

    monkeypatch.setattr("shutil.which", mock_which)
    assert detect_copilot_cli() is True
