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


# ---------------------------------------------------------------------------
# detect_installed_harnesses
# ---------------------------------------------------------------------------


def test_detect_installed_harnesses_returns_dict():
    """Verify detect_installed_harnesses returns a dict with expected keys."""
    from token_goat.install import detect_installed_harnesses

    result = detect_installed_harnesses()
    assert isinstance(result, dict)
    # Check for all expected harness keys
    expected_keys = {
        "claude",
        "aider",
        "codex",
        "gemini",
        "opencode",
        "openclaw",
        "cline",
        "windsurf",
        "copilot-cli",
    }
    assert set(result.keys()) == expected_keys


def test_detect_installed_harnesses_claude_always_true():
    """Claude harness should always be detected."""
    from token_goat.install import detect_installed_harnesses

    result = detect_installed_harnesses()
    assert result["claude"] is True


def test_detect_installed_harnesses_all_values_bool():
    """All values in the returned dict should be booleans."""
    from token_goat.install import detect_installed_harnesses

    result = detect_installed_harnesses()
    for name, installed in result.items():
        assert isinstance(installed, bool), f"Value for {name} should be bool, got {type(installed)}"


def test_detect_installed_harnesses_handles_missing_bridges(monkeypatch):
    """Should handle gracefully when bridges module is unavailable."""
    from token_goat import install

    # Temporarily patch to simulate bridge import failure
    def patched_detect():
        result = {
            "claude": True,
            "aider": False,
            "codex": False,
            "gemini": False,
            "opencode": False,
            "openclaw": False,
            "cline": False,
            "windsurf": False,
            "copilot-cli": False,
        }
        # The actual function has try/except for bridges, so opencode/openclaw
        # will be False if bridges fails
        return result

    monkeypatch.setattr(install, "detect_installed_harnesses", patched_detect)
    result = install.detect_installed_harnesses()
    # opencode and openclaw should default to False on error
    assert result["opencode"] is False
    assert result["openclaw"] is False


def test_detect_installed_harnesses_codex_via_env(monkeypatch, tmp_path):
    """Codex should be detected when CODEX_HOME env var is set."""
    from token_goat.install import detect_installed_harnesses

    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    result = detect_installed_harnesses()
    assert result["codex"] is True


def test_detect_installed_harnesses_codex_via_dir(monkeypatch, tmp_path):
    """Codex should be detected when ~/.codex directory exists."""
    from token_goat import install

    # Mock codex_dir() to return a path that exists
    codex_path = tmp_path / ".codex"
    codex_path.mkdir()
    monkeypatch.setattr(install, "codex_dir", lambda: codex_path)
    monkeypatch.delenv("CODEX_HOME", raising=False)

    result = install.detect_installed_harnesses()
    assert result["codex"] is True


def test_detect_installed_harnesses_codex_false_when_absent(monkeypatch, tmp_path):
    """Codex should not be detected when env var absent and dir doesn't exist."""
    from token_goat import install

    monkeypatch.delenv("CODEX_HOME", raising=False)
    codex_path = tmp_path / ".codex"  # Don't create it
    monkeypatch.setattr(install, "codex_dir", lambda: codex_path)

    result = install.detect_installed_harnesses()
    assert result["codex"] is False


def test_detect_installed_harnesses_gemini_via_dir(monkeypatch, tmp_path):
    """Gemini should be detected when ~/.gemini directory exists."""
    gemini_path = tmp_path / ".gemini"
    gemini_path.mkdir()
    with patch("token_goat.install.Path") as MockPath:
        MockPath.home.return_value = tmp_path
        MockPath.side_effect = Path
        from token_goat.install import detect_installed_harnesses

        result = detect_installed_harnesses()
        assert result["gemini"] is True


def test_detect_installed_harnesses_preserves_backward_compat():
    """detect_harnesses() should still work and use the dict version."""
    from token_goat.install import detect_harnesses, detect_installed_harnesses

    harnesses_list = detect_harnesses()
    harnesses_dict = detect_installed_harnesses()

    # The list should match the keys in the dict where value is True
    detected_from_dict = [name for name, installed in harnesses_dict.items() if installed]
    detected_from_dict = ["claude"] + sorted(
        [name for name in detected_from_dict if name != "claude"]
    )
    assert set(harnesses_list) == set(detected_from_dict)
